document.addEventListener('DOMContentLoaded', () => {
    const socket = io({
        transports: ['websocket'],
        upgrade: false,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });
    
    // 选择上传区，兼容新结构
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const selectFilesBtn = document.getElementById('select-files');
    const filesGrid = document.getElementById('files-grid');
    const taskStatus = document.getElementById('task-status');

    // 任务列表
    let uploadTasks = {};
    let downloadTasks = {};

    // 当前文件列表缓存
    let lastFileList = [];

    // 待上传文件列表
    let pendingFiles = [];

    // 适配新版布局：插入到.card-upload .card-content内，紧跟.drop-zone后
    const uploadCardContent = document.querySelector('.card-upload-content');

    // 待上传文件列表容器和工具栏
    const pendingContainer = document.createElement('div');
    pendingContainer.className = 'pending-container';
    uploadCardContent.insertBefore(pendingContainer, dropZone.nextSibling);

    // 工具栏
    const pendingToolbar = document.createElement('div');
    pendingToolbar.className = 'pending-toolbar';
    let selectAllCheckbox = document.createElement('input');
    selectAllCheckbox.type = 'checkbox';
    selectAllCheckbox.id = 'pending-select-all';
    let selectAllLabel = document.createElement('label');
    selectAllLabel.htmlFor = 'pending-select-all';
    selectAllLabel.textContent = '全选';
    let deleteSelectedBtn = document.createElement('button');
    deleteSelectedBtn.className = 'main-btn pending-delete-btn';
    deleteSelectedBtn.textContent = '删除';
    let uploadAllBtn = document.createElement('button');
    uploadAllBtn.className = 'main-btn upload-all-btn';
    uploadAllBtn.textContent = '上传';
    uploadAllBtn.style.marginLeft = '1rem';
    pendingToolbar.appendChild(selectAllCheckbox);
    pendingToolbar.appendChild(selectAllLabel);
    pendingToolbar.appendChild(deleteSelectedBtn);
    pendingToolbar.appendChild(uploadAllBtn);
    pendingContainer.appendChild(pendingToolbar);

    // 列表区域
    const pendingList = document.createElement('div');
    pendingList.className = 'pending-list';
    pendingContainer.appendChild(pendingList);

    // 选择状态
    let selectedPending = [];

    function renderTasks() {
        const allTasks = { ...uploadTasks, ...downloadTasks };
        if (Object.keys(allTasks).length === 0) {
            taskStatus.innerHTML = '<div class="task-status-empty">暂无任务</div>';
            return;
        }
        taskStatus.innerHTML = '';
        Object.values(allTasks).forEach(task => {
            const typeLabel = task.type === 'download' ? '<span class="task-type download">下载</span>' : '<span class="task-type upload">上传</span>';
            let statusText = '';
            if (task.status === 'done') {
                statusText = '已完成';
            } else if (task.status === 'merging') {
                statusText = '正在合并...';
            } else if (task.status === 'canceled') {
                statusText = '已取消';
            } else if (task.status === 'error') {
                statusText = '失败';
            } else {
                statusText = task.progress + '%';
            }
            const taskDiv = document.createElement('div');
            taskDiv.className = 'upload-task';
            taskDiv.innerHTML = `
                <div class="task-info">
                    ${typeLabel}
                    <span class="task-filename">${task.name}</span>
                    <span class="task-progress">${statusText}</span>
                </div>
                <div class="task-bar-wrap">
                    <div class="task-bar-bg"><div class="task-bar" style="width:${task.progress}%;"></div></div>
                </div>
            `;
            taskStatus.appendChild(taskDiv);
        });
    }

    // 分片策略
    function getChunkSize(fileSize) {
        if (fileSize < 100 * 1024 * 1024) return 2 * 1024 * 1024; // 2MB
        if (fileSize < 500 * 1024 * 1024) return 5 * 1024 * 1024; // 5MB
        if (fileSize < 2 * 1024 * 1024 * 1024) return 10 * 1024 * 1024; // 10MB
        return 20 * 1024 * 1024; // 20MB
    }

    // 连接事件
    socket.on('connect', () => {
        console.log('Connected to server');
    });

    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
    });

    // 文件列表更新
    socket.on('file_list', (files) => {
        console.log('Received file list:', files);
        lastFileList = files;
        updateFilesGrid(files);
    });

    socket.on('new_file', (fileInfo) => {
        console.log('New file uploaded:', fileInfo);
        // 更新上传任务状态
        if (uploadTasks[fileInfo.id]) {
            uploadTasks[fileInfo.id].status = 'done';
            uploadTasks[fileInfo.id].progress = 100;
            renderTasks();
        }
        updateFilesGrid([...filesGrid.children].map(card => ({
            id: card.dataset.fileId,
            name: card.querySelector('.file-name').textContent,
            size: card.querySelector('.file-info').textContent.split(' | ')[0],
            timestamp: card.querySelector('.file-info').textContent.split(' | ')[1]
        })).concat(fileInfo));
    });

    socket.on('file_deleted', (fileId) => {
        console.log('File deleted:', fileId);
        const fileCard = filesGrid.querySelector(`[data-file-id="${fileId}"]`);
        if (fileCard) {
            fileCard.remove();
        }
    });

    // 文件拖放处理
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });

    // 文件选择按钮
    selectFilesBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    // 渲染待上传文件列表
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
                <span class="pending-name">${file.name}</span>
                <span class="pending-size">${formatFileSize(file.size)}</span>
                <button class="pending-remove" data-idx="${idx}" title="移除"><i class="fas fa-times"></i></button>
            </div>
        `).join('');
        // 绑定移除事件
        pendingList.querySelectorAll('.pending-remove').forEach(btn => {
            btn.onclick = function() {
                const idx = parseInt(btn.getAttribute('data-idx'));
                pendingFiles.splice(idx, 1);
                selectedPending = selectedPending.filter(i => i !== idx).map(i => i > idx ? i - 1 : i);
                renderPendingList();
            };
        });
        // 绑定选择事件
        pendingList.querySelectorAll('.pending-select').forEach(box => {
            box.onchange = function() {
                const idx = parseInt(box.getAttribute('data-idx'));
                if (box.checked) {
                    if (!selectedPending.includes(idx)) selectedPending.push(idx);
                } else {
                    selectedPending = selectedPending.filter(i => i !== idx);
                }
                renderPendingList();
            };
        });
        // 工具栏按钮状态
        deleteSelectedBtn.disabled = selectedPending.length === 0;
        selectAllCheckbox.checked = selectedPending.length === pendingFiles.length && pendingFiles.length > 0;
    }

    // 全选/取消全选
    selectAllCheckbox.onchange = function() {
        if (selectAllCheckbox.checked) {
            selectedPending = pendingFiles.map((_, idx) => idx);
        } else {
            selectedPending = [];
        }
        renderPendingList();
    };

    // 删除所选
    deleteSelectedBtn.onclick = function() {
        pendingFiles = pendingFiles.filter((_, idx) => !selectedPending.includes(idx));
        selectedPending = [];
        renderPendingList();
    };

    // 上传全部
    uploadAllBtn.onclick = function() {
        if (pendingFiles.length === 0 || selectedPending.length === 0) return;
        // 只上传已选中的文件，按索引从大到小删除
        selectedPending.sort((a, b) => b - a);
        selectedPending.forEach(idx => {
            uploadFileInChunks(pendingFiles[idx]);
            pendingFiles.splice(idx, 1);
        });
        selectedPending = [];
        renderPendingList();
    };

    // 选择文件后加入待上传列表
    function handleFiles(files) {
        Array.from(files).forEach(file => {
            if (!pendingFiles.some(f => f.name === file.name && f.size === file.size)) {
                pendingFiles.push(file);
            }
        });
        renderPendingList();
    }

    // 初始化时渲染一次
    renderPendingList();

    // 分片上传主逻辑，带进度和取消
    function uploadFileInChunks(file) {
        const chunkSize = getChunkSize(file.size);
        const totalChunks = Math.ceil(file.size / chunkSize);
        const fileId = generateFileId(file);
        let currentChunk = 0;
        let canceled = false;
        uploadTasks[fileId] = {
            id: fileId,
            name: file.name,
            progress: 0,
            status: 'uploading',
            type: 'upload',
            cancel: () => {
                canceled = true;
                uploadTasks[fileId].status = 'canceled';
                renderTasks();
            }
        };
        renderTasks();

        function sendNextChunk() {
            if (canceled) return;
            const start = currentChunk * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const chunk = file.slice(start, end);
            const reader = new FileReader();
            reader.onload = (e) => {
                if (canceled) return;
                socket.emit('upload_chunk', {
                    file_id: fileId,
                    file_name: file.name,
                    file_size: file.size,
                    chunk_index: currentChunk,
                    total_chunks: totalChunks,
                    chunk_data: e.target.result
                });
                currentChunk++;
                uploadTasks[fileId].progress = Math.floor(currentChunk / totalChunks * 100);
                renderTasks();
                if (currentChunk < totalChunks) {
                    sendNextChunk();
                } else {
                    // 通知后端合并
                    uploadTasks[fileId].progress = 100;
                    uploadTasks[fileId].status = 'merging';
                    renderTasks();
                    socket.emit('merge_chunks', {
                        file_id: fileId,
                        file_name: file.name,
                        file_size: file.size,
                        total_chunks: totalChunks
                    });
                }
            };
            reader.onerror = () => {
                uploadTasks[fileId].status = 'error';
                renderTasks();
            };
            reader.readAsDataURL(chunk);
        }
        sendNextChunk();
    }

    // 生成文件唯一ID（可用文件名+大小+时间戳hash）
    function generateFileId(file) {
        return (
            file.name + '_' + file.size + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8)
        );
    }

    // 更新文件网格
    function updateFilesGrid(files) {
        try {
            filesGrid.innerHTML = '';
            if (files.length === 0) {
                document.getElementById('no-files').style.display = '';
            } else {
                document.getElementById('no-files').style.display = 'none';
                files.forEach(file => {
                    const card = createFileCard(file);
                    filesGrid.appendChild(card);
                });
            }
        } catch (error) {
            console.error('Error updating files grid:', error);
            // ...其他错误处理...
        }
    }

    // 创建文件卡片
    function createFileCard(file) {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.dataset.fileId = file.id;
        const fileIcon = getFileIcon(file.name);
        card.innerHTML = `
            <div class="file-icon">
                <i class="${fileIcon}"></i>
            </div>
            <div class="file-name">${file.name}</div>
            <div class="file-info">
                ${file.size} | ${file.timestamp}
            </div>
            <div class="file-actions">
                <button class="download-btn" data-id="${file.id}" title="下载">
                    <i class="fas fa-download"></i>
                </button>
                <button onclick="deleteFile('${file.id}')" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        return card;
    }

    // 获取文件图标
    function getFileIcon(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        const iconMap = {
            pdf: 'fas fa-file-pdf',
            doc: 'fas fa-file-word',
            docx: 'fas fa-file-word',
            xls: 'fas fa-file-excel',
            xlsx: 'fas fa-file-excel',
            ppt: 'fas fa-file-powerpoint',
            pptx: 'fas fa-file-powerpoint',
            jpg: 'fas fa-file-image',
            jpeg: 'fas fa-file-image',
            png: 'fas fa-file-image',
            gif: 'fas fa-file-image',
            zip: 'fas fa-file-archive',
            rar: 'fas fa-file-archive',
            txt: 'fas fa-file-alt',
            mp3: 'fas fa-file-audio',
            mp4: 'fas fa-file-video'
        };
        return iconMap[ext] || 'fas fa-file';
    }

    // 格式化文件大小
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // 删除文件
    window.deleteFile = function(fileId) {
        if (confirm('确定要删除这个文件吗？')) {
            try {
                socket.emit('delete_file', { file_id: fileId });
            } catch (error) {
                console.error('Error deleting file:', error);
            }
        }
    };

    // 下载文件并显示进度
    function downloadFileWithProgress(file) {
        const fileId = file.id;
        if (downloadTasks[fileId]) return; // 防止重复下载
        downloadTasks[fileId] = {
            id: fileId,
            name: file.name,
            progress: 0,
            status: 'downloading',
            type: 'download'
        };
        renderTasks();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `/download/${fileId}`);
        xhr.responseType = 'blob';
        xhr.onprogress = function(e) {
            if (e.lengthComputable) {
                downloadTasks[fileId].progress = Math.floor(e.loaded / e.total * 100);
                renderTasks();
            }
        };
        xhr.onload = function() {
            if (xhr.status === 200) {
                const url = window.URL.createObjectURL(xhr.response);
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    window.URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                }, 100);
                downloadTasks[fileId].progress = 100;
                downloadTasks[fileId].status = 'done';
                renderTasks();
            } else {
                downloadTasks[fileId].status = 'error';
                renderTasks();
                // 禁用下载按钮
                const btn = document.querySelector(`.download-btn[data-id='${fileId}']`);
                if (btn) {
                    btn.classList.add('download-disabled');
                    btn.title = '无法下载';
                }
            }
        };
        xhr.onerror = function() {
            downloadTasks[fileId].status = 'error';
            renderTasks();
            // 禁用下载按钮
            const btn = document.querySelector(`.download-btn[data-id='${fileId}']`);
            if (btn) {
                btn.classList.add('download-disabled');
                btn.title = '无法下载';
            }
        };
        xhr.send();
    }

    // 自定义浮层提示
    function showCustomTip(msg) {
        let tip = document.createElement('div');
        tip.className = 'custom-tip';
        tip.textContent = msg;
        document.body.appendChild(tip);
        setTimeout(() => {
            tip.classList.add('show');
        }, 10);
        setTimeout(() => {
            tip.classList.remove('show');
            setTimeout(() => tip.remove(), 500);
        }, 2000);
    }

    // 修改点击事件，禁用按钮时弹出自定义提示
    filesGrid.addEventListener('click', function(e) {
        const btn = e.target.closest('.download-btn');
        if (!btn) return;
        if (btn.classList.contains('download-disabled')) {
            confirm('该文件已被下载并自动从服务器删除，无法再次下载。');
            return;
        }
        const fileId = btn.getAttribute('data-id');
        const file = lastFileList.find(f => f.id === fileId);
        if (!file) {
            confirm('该文件已被删除或不可用。');
            return;
        }
        downloadFileWithProgress(file);
    });

    // 填充连接信息卡片
    function fillConnectionInfo() {
        fetch('/api/connection_info').then(r => r.json()).then(data => {
            document.getElementById('local-url').textContent = data.local_url || '未获取到';
            document.getElementById('ngrok-url').textContent = data.ngrok_url || '未获取到';
            // 判断当前访问方式
            const current = window.location.origin;
            if (current === data.local_url) {
                document.getElementById('local-badge').classList.add('active');
                document.getElementById('ngrok-badge').classList.remove('active');
            } else if (current === data.ngrok_url) {
                document.getElementById('ngrok-badge').classList.add('active');
                document.getElementById('local-badge').classList.remove('active');
            } else {
                document.getElementById('local-badge').classList.remove('active');
                document.getElementById('ngrok-badge').classList.remove('active');
            }
        }).catch(() => {
            document.getElementById('local-url').textContent = '未获取到';
            document.getElementById('ngrok-url').textContent = '未获取到';
            document.getElementById('local-badge').classList.remove('active');
            document.getElementById('ngrok-badge').classList.remove('active');
        });
    }
    fillConnectionInfo();
}); 
