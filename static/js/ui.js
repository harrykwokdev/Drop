// 工具函数：格式化、DOM、通知。
// 全部纯函数或对传入节点的副作用，不持有全局状态。

export function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const ICON_MAP = {
    pdf: 'fas fa-file-pdf', doc: 'fas fa-file-word', docx: 'fas fa-file-word',
    xls: 'fas fa-file-excel', xlsx: 'fas fa-file-excel',
    ppt: 'fas fa-file-powerpoint', pptx: 'fas fa-file-powerpoint',
    jpg: 'fas fa-file-image', jpeg: 'fas fa-file-image', png: 'fas fa-file-image',
    gif: 'fas fa-file-image', webp: 'fas fa-file-image',
    zip: 'fas fa-file-archive', rar: 'fas fa-file-archive', '7z': 'fas fa-file-archive',
    txt: 'fas fa-file-alt', md: 'fas fa-file-alt',
    mp3: 'fas fa-file-audio', wav: 'fas fa-file-audio',
    mp4: 'fas fa-file-video', mov: 'fas fa-file-video', mkv: 'fas fa-file-video',
    csv: 'fas fa-file-csv', json: 'fas fa-file-code',
};

export function getFileIcon(fileName) {
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    return ICON_MAP[ext] || 'fas fa-file';
}

export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

const ICON_BY_TYPE = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };

export class Notifier {
    constructor(stack) {
        this.stack = stack;
    }
    show(message, type = 'info', timeout = 3000) {
        const node = el('div', { class: `notification ${type}` }, [
            el('i', { class: `fas ${ICON_BY_TYPE[type] || ICON_BY_TYPE.info}` }),
            el('span', {}, [message]),
        ]);
        this.stack.appendChild(node);
        requestAnimationFrame(() => node.classList.add('show'));
        setTimeout(() => {
            node.classList.add('fade');
            setTimeout(() => node.remove(), 600);
        }, timeout);
    }
}
