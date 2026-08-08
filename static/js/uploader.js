// 分片上传核心：HTTP 流式传输。
// 每个分片 = 一个独立 POST，body 直接用 file.slice() 的 Blob（零拷贝流式，
// 无 FileReader、无 base64）。多分片并发，每个走独立 HTTP 连接，
// 服务端 eventlet 用独立协程处理，打破单 websocket 的串行瓶颈。

const CONCURRENCY = 6;        // 同时在途的分片数（浏览器 HTTP 连接池上限约 6）
const RETRY_LIMIT = 3;

function getChunkSize(fileSize) {
    if (fileSize < 100 * 1024 * 1024) return 4 * 1024 * 1024;   // 4MB
    if (fileSize < 500 * 1024 * 1024) return 20 * 1024 * 1024;  // 20MB
    if (fileSize < 2 * 1024 * 1024 * 1024) return 50 * 1024 * 1024; // 50MB
    return 100 * 1024 * 1024; // 100MB
}

export class Uploader {
    /**
     * @param {object} opts
     * @param {(state) => void} opts.onUpdate  状态变化回调
     */
    constructor({ onUpdate }) {
        this.onUpdate = onUpdate || (() => {});
        this._tasks = new Map();
    }

    upload(file) {
        const chunkSize = getChunkSize(file.size);
        const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
        const fileId = `${file.name}_${file.size}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const task = {
            id: fileId, name: file.name, progress: 0, status: 'uploading',
            type: 'upload', speed: 0, eta: 0,
            _file: file, _bytes: 0, _startTs: 0, _acked: 0,
            _aborted: false, _controllers: new Map(),
            cancel: () => this.cancel(fileId),
            retry: () => this.retry(fileId),
        };
        this._tasks.set(fileId, task);
        this._run(task, chunkSize, totalChunks);
        this.onUpdate({ ...task });
        return task;
    }

    _emit(task, patch) {
        Object.assign(task, patch);
        this.onUpdate({ ...task });
    }

    async _run(task, chunkSize, totalChunks) {
        const file = task._file;
        let cursor = 0;
        const inflight = new Set();
        let failed = false;

        const sendChunk = async (idx) => {
            if (task._aborted) return;
            const start = idx * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const blob = file.slice(start, end); // Blob，fetch 直接流式发送
            let attempt = 0;
            while (attempt <= RETRY_LIMIT) {
                if (task._aborted) return;
                const ctrl = new AbortController();
                task._controllers.set(idx, ctrl);
                try {
                    const res = await fetch('/api/upload/chunk', {
                        method: 'POST',
                        headers: {
                            'X-File-Id': task.id,
                            'X-Chunk-Index': idx,
                            'Content-Type': 'application/octet-stream',
                        },
                        body: blob,
                        signal: ctrl.signal,
                    });
                    task._controllers.delete(idx);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    break;
                } catch (err) {
                    task._controllers.delete(idx);
                    if (task._aborted || err.name === 'AbortError') return;
                    attempt++;
                    if (attempt > RETRY_LIMIT) throw err;
                }
            }
            task._bytes += (end - start);
            if (!task._startTs) task._startTs = Date.now();
            const elapsed = (Date.now() - task._startTs) / 1000;
            if (elapsed > 0.2) {
                task.speed = task._bytes / elapsed;
                const remaining = file.size - task._bytes;
                task.eta = task.speed > 0 ? remaining / task.speed : 0;
            }
            task._acked++;
            this._emit(task, { progress: Math.floor(task._acked / totalChunks * 95) });
        };

        try {
            while (cursor < totalChunks && !task._aborted && !failed) {
                while (inflight.size < CONCURRENCY && cursor < totalChunks) {
                    const idx = cursor++;
                    const p = sendChunk(idx).then(() => inflight.delete(p));
                    inflight.add(p);
                }
                if (inflight.size >= CONCURRENCY) {
                    await Promise.race(inflight);
                }
            }
            await Promise.all(inflight);
            if (task._aborted) return;

            this._emit(task, { status: 'merging', progress: 98 });
            const res = await fetch('/api/upload/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: task.id, file_name: file.name,
                    file_size: file.size, total_chunks: totalChunks,
                }),
            });
            if (!res.ok) throw new Error(`合并请求失败 HTTP ${res.status}`);
            // 成功结束的最终状态由 socket 'new_file' 广播触发（见 app.js）
        } catch (err) {
            if (!task._aborted) {
                failed = true;
                this._abortAll(task);
                this._emit(task, { status: 'error', message: String(err.message || err) });
            }
        }
    }

    _abortAll(task) {
        task._aborted = true;
        for (const ctrl of task._controllers.values()) {
            try { ctrl.abort(); } catch {}
        }
        task._controllers.clear();
    }

    cancel(fileId) {
        const task = this._tasks.get(fileId);
        if (!task) return;
        this._abortAll(task);
        this._emit(task, { status: 'canceled' });
    }

    retry(fileId) {
        const task = this._tasks.get(fileId);
        if (!task || task.status === 'uploading' || task.status === 'merging') return;
        const file = task._file;
        this._tasks.delete(fileId);
        if (file) this.upload(file);
    }
}
