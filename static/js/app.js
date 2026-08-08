// 应用入口：连接 socket、绑定 UI 事件、协调上传/下载/列表。
import { Uploader } from './uploader.js';
import { Notifier, el, escapeHtml, formatFileSize, getFileIcon } from './ui.js';

function formatEta(sec) {
    if (!sec || !isFinite(sec)) return '—';
    if (sec < 60) return `${Math.ceil(sec)}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.ceil(sec % 60).toString().padStart(2, '0')}s`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60).toString().padStart(2, '0')}m`;
}

const EMPTY_TASKS = '<div class="task-status-empty"><i class="fas fa-inbox"></i>暂无任务</div>';

const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
});

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const selectFilesBtn = document.getElementById('select-files');
const filesGrid = document.getElementById('files-grid');
const noFiles = document.getElementById('no-files');
const taskStatus = document.getElementById('task-status');
const uploadCardContent = document.querySelector('.card-upload-content');
const notificationStack = document.getElementById('notification-stack');

const notifier = new Notifier(notificationStack);
const uploader = new Uploader({ onUpdate: renderTasks });

let uploadTasks = {};
let downloadTasks = {};
let lastFileList = [];
let pendingFiles = [];
let selectedPending = [];

// ---------- 待上传列表 UI ----------
const pendingContainer = el('div', { class: 'pending-container' });
const pendingToolbar = el('div', { class: 'pending-toolbar' });
const selectAllCheckbox = el('input', { type: 'checkbox', id: 'pending-select-all' });
const deleteSelectedBtn = el('button', { class: 'main-btn pending-delete-btn', type: 'button' }, '删除');
const uploadAllBtn = el('button', { class: 'main-btn upload-all-btn', type: 'button' }, '上传');
uploadAllBtn.style.marginLeft = '1rem';
pendingToolbar.append(selectAllCheckbox, el('label', { for: 'pending-select-all' }, '全选'), deleteSelectedBtn, uploadAllBtn);
const pendingList = el('div', { class: 'pending-list' });
pendingContainer.append(pendingToolbar, pendingList);
uploadCardContent.insertBefore(pendingContainer, dropZone.nextSibling);

function renderPendingList() {
    if (pendingFiles.length === 0) {
        pendingList.classList.remove('has-files');
        pendingList.innerHTML = '<div class="pending-empty">暂无待上传文件</div>';
        uploadAllBtn.disabled = true;
        deleteSelectedBtn.disabled = true;
        selectAllCheckbox.checked = false;
        selectAllCheckbox.disabled = true;
        return;
    }
    pendingList.classList.add('has-files');
    uploadAllBtn.disabled = false;
    selectAllCheckbox.disabled = false;
    pendingList.innerHTML = pendingFiles.map((file, idx) => `
        <div class="pending-item${selectedPending.includes(idx) ? ' selected' : ''}">
            <input type="checkbox" class="pending-select" data-idx="${idx}" ${selectedPending.includes(idx) ? 'checked' : ''}>
            <span class="pending-name">${escapeHtml(file.name)}</span>
            <span class="pending-size">${formatFileSize(file.size)}</span>
            <button class="pending-remove" data-idx="${idx}" title="移除"><i class="fas fa-times"></i></button>
        </div>
    `).join('');
    deleteSelectedBtn.disabled = selectedPending.length === 0;
    selectAllCheckbox.checked = selectedPending.length === pendingFiles.length;
}

pendingList.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.pending-remove');
    if (removeBtn) {
        const idx = parseInt(removeBtn.dataset.idx, 10);
        pendingFiles.splice(idx, 1);
        selectedPending = selectedPending.filter(i => i !== idx).map(i => i > idx ? i - 1 : i);
        renderPendingList();
        return;
    }
});
pendingList.addEventListener('change', (e) => {
    const box = e.target.closest('.pending-select');
    if (!box) return;
    const idx = parseInt(box.dataset.idx, 10);
    if (box.checked) {
        if (!selectedPending.includes(idx)) selectedPending.push(idx);
    } else {
        selectedPending = selectedPending.filter(i => i !== idx);
    }
    renderPendingList();
});
selectAllCheckbox.addEventListener('change', () => {
    selectedPending = selectAllCheckbox.checked ? pendingFiles.map((_, i) => i) : [];
    renderPendingList();
});
deleteSelectedBtn.addEventListener('click', () => {
    pendingFiles = pendingFiles.filter((_, idx) => !selectedPending.includes(idx));
    selectedPending = [];
    renderPendingList();
});
uploadAllBtn.addEventListener('click', () => {
    if (pendingFiles.length === 0 || selectedPending.length === 0) return;
    const targets = selectedPending.map(i => pendingFiles[i]);
    selectedPending.sort((a, b) => b - a);
    selectedPending.forEach(idx => pendingFiles.splice(idx, 1));
    selectedPending = [];
    renderPendingList();
    targets.forEach(file => {
        const task = uploader.upload(file);
        uploadTasks[task.id] = task;
        renderTasks();
    });
});

function handleFiles(files) {
    Array.from(files).forEach(file => {
        if (!pendingFiles.some(f => f.name === file.name && f.size === file.size)) {
            pendingFiles.push(file);
        }
    });
    renderPendingList();
}

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});
dropZone.addEventListener('click', (e) => {
    if (e.target.closest('#select-files')) return;
    fileInput.click();
});
dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
selectFilesBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
renderPendingList();

// ---------- 任务渲染 ----------
function renderTasks() {
    const all = { ...uploadTasks, ...downloadTasks };
    if (Object.keys(all).length === 0) {
        taskStatus.innerHTML = EMPTY_TASKS;
        return;
    }
    taskStatus.innerHTML = '';
    Object.values(all).forEach(task => {
        const typeLabel = task.type === 'download'
            ? '<span class="task-type download">下载</span>'
            : '<span class="task-type upload">上传</span>';
        let statusText, metaText = '';
        if (task.status === 'done') statusText = '已完成';
        else if (task.status === 'merging') statusText = '合并中';
        else if (task.status === 'canceled') statusText = '已取消';
        else if (task.status === 'error') statusText = '失败';
        else {
            statusText = task.progress + '%';
            if (task.speed > 0) {
                metaText = `${formatFileSize(task.speed)}/s · 剩余 ${formatEta(task.eta)}`;
            }
        }

        const canCancel = task.status === 'uploading' || task.status === 'merging';
        const canRetry = task.status === 'error' || task.status === 'canceled';
        const actions = `
            ${canCancel ? `<button class="task-cancel" data-id="${task.id}" title="取消"><i class="fas fa-stop"></i></button>` : ''}
            ${canRetry ? `<button class="task-retry" data-id="${task.id}" title="重试"><i class="fas fa-rotate-right"></i></button>` : ''}
        `;
        const node = document.createElement('div');
        node.className = `upload-task ${task.status}`;
        node.innerHTML = `
            <div class="task-info">
                ${typeLabel}
                <span class="task-filename">${escapeHtml(task.name)}</span>
                <span class="task-meta">${metaText}</span>
                <span class="task-progress">${statusText}</span>
                <span class="task-actions">${actions}</span>
            </div>
            <div class="task-bar-wrap">
                <div class="task-bar-bg"><div class="task-bar" style="width:${task.progress}%;"></div></div>
            </div>
        `;
        taskStatus.appendChild(node);
    });
}
taskStatus.addEventListener('click', (e) => {
    const cancelBtn = e.target.closest('.task-cancel');
    const retryBtn = e.target.closest('.task-retry');
    if (cancelBtn) {
        const t = uploadTasks[cancelBtn.dataset.id];
        if (t && t.cancel) t.cancel();
    } else if (retryBtn) {
        const t = uploadTasks[retryBtn.dataset.id];
        if (t && t.retry) {
            delete uploadTasks[t.id];
            t.retry();
        }
    }
});

// ---------- socket 事件 ----------
const connPill = document.getElementById('conn-pill');
const connText = document.getElementById('conn-text');
function setConn(online) {
    connPill.classList.toggle('offline', !online);
    connText.textContent = online ? '已连接' : '已断开';
}

socket.on('connect', () => { console.log('已连接服务器'); setConn(true); });
socket.on('connect_error', (err) => { console.error('连接失败', err); setConn(false); });
socket.on('disconnect', () => { console.log('已断开'); setConn(false); });

socket.on('file_list', (files) => {
    lastFileList = files || [];
    updateFilesGrid(lastFileList);
});
socket.on('new_file', (fileInfo) => {
    if (uploadTasks[fileInfo.id]) {
        uploadTasks[fileInfo.id].status = 'done';
        uploadTasks[fileInfo.id].progress = 100;
        renderTasks();
        notifier.show(`「${fileInfo.name}」上传成功`, 'success');
    }
    if (!lastFileList.some(f => f.id === fileInfo.id)) lastFileList.push(fileInfo);
    updateFilesGrid(lastFileList);
});
socket.on('file_deleted', (fileId) => {
    lastFileList = lastFileList.filter(f => f.id !== fileId);
    updateFilesGrid(lastFileList);
});
socket.on('merge_failed', ({ file_id, reason }) => {
    if (uploadTasks[file_id]) {
        uploadTasks[file_id].status = 'error';
        renderTasks();
        notifier.show(`合并失败：${reason}`, 'error');
    }
});

// ---------- 文件列表 UI ----------
function updateFilesGrid(files) {
    filesGrid.innerHTML = '';
    const count = (files && files.length) || 0;
    document.getElementById('file-count').textContent = count;
    if (count === 0) {
        noFiles.style.display = '';
        return;
    }
    noFiles.style.display = 'none';
    files.forEach(createFileCard);
}

function createFileCard(file) {
    const card = el('div', { class: 'file-card', dataset: { fileId: file.id } });
    card.innerHTML = `
        <div class="file-icon"><i class="${getFileIcon(file.name)}"></i></div>
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-info">${escapeHtml(file.size)} | ${escapeHtml(file.timestamp)}</div>
        <div class="file-actions">
            <button class="download-btn" data-id="${file.id}" title="下载"><i class="fas fa-download"></i></button>
            <button class="delete-btn" data-id="${file.id}" title="删除"><i class="fas fa-trash"></i></button>
        </div>
    `;
    filesGrid.appendChild(card);
}

filesGrid.addEventListener('click', (e) => {
    const dlBtn = e.target.closest('.download-btn');
    const delBtn = e.target.closest('.delete-btn');
    if (dlBtn) {
        const file = lastFileList.find(f => f.id === dlBtn.dataset.id);
        if (file) downloadFileWithProgress(file);
        else notifier.show('该文件已被删除或不可用', 'warning');
    } else if (delBtn) {
        const fileId = delBtn.dataset.id;
        if (confirm('确定要删除这个文件吗？')) {
            socket.emit('delete_file', { file_id: fileId });
        }
    }
});

function downloadFileWithProgress(file) {
    const fileId = file.id;
    if (downloadTasks[fileId]) return;
    downloadTasks[fileId] = { id: fileId, name: file.name, progress: 0, status: 'downloading', type: 'download' };
    renderTasks();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/download/${fileId}`);
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => {
        if (e.lengthComputable) {
            downloadTasks[fileId].progress = Math.floor(e.loaded / e.total * 100);
            renderTasks();
        }
    };
    xhr.onload = () => {
        if (xhr.status === 200) {
            const url = URL.createObjectURL(xhr.response);
            const a = el('a', { href: url, download: file.name });
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
            downloadTasks[fileId].progress = 100;
            downloadTasks[fileId].status = 'done';
            notifier.show(`「${file.name}」下载完成`, 'success');
        } else {
            downloadTasks[fileId].status = 'error';
            notifier.show('下载失败', 'error');
        }
        renderTasks();
    };
    xhr.onerror = () => {
        downloadTasks[fileId].status = 'error';
        notifier.show('下载失败', 'error');
        renderTasks();
    };
    xhr.send();
}

// ---------- 连接信息 ----------
fetch('/api/connection_info').then(r => r.json()).then(data => {
    document.getElementById('local-url').textContent = data.local_url || '未获取到';
    document.getElementById('ngrok-url').textContent = data.ngrok_url || '未获取到';
    const current = window.location.origin;
    const localBadge = document.getElementById('local-badge');
    const ngrokBadge = document.getElementById('ngrok-badge');
    localBadge.classList.toggle('active', current === data.local_url);
    ngrokBadge.classList.toggle('active', current === data.ngrok_url);
}).catch(() => {});
