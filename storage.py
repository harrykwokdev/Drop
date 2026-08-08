"""文件清单持久化与磁盘同步。

将 files 元数据持久化到 JSON，服务重启后仍可恢复；
任何操作后都通过 sync 校验磁盘真实状态，剔除丢失文件。
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, Any

from flask_socketio import SocketIO

import config

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_files: Dict[str, Dict[str, Any]] = {}


def _safe_filename(file_id: str, original_name: str) -> str:
    """用 file_id 作为磁盘文件名，仅保留受信任的扩展名，杜绝路径穿越。"""
    ext = Path(original_name).suffix
    if len(ext) > 16 or not all(c.isalnum() or c in ".-" for c in ext):
        ext = ""
    return f"{file_id}{ext}"


def _persist() -> None:
    """把当前清单原子写入磁盘（先写临时文件再替换）。"""
    try:
        tmp = config.REGISTRY_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_files, ensure_ascii=False), encoding="utf-8")
        tmp.replace(config.REGISTRY_FILE)
    except Exception as exc:
        logger.warning(f"持久化文件清单失败: {exc}")


def load() -> None:
    """服务启动时从磁盘恢复清单，并立刻做一次磁盘同步。"""
    global _files
    if config.REGISTRY_FILE.exists():
        try:
            _files = json.loads(config.REGISTRY_FILE.read_text(encoding="utf-8"))
            logger.info(f"从磁盘恢复 {len(_files)} 个文件记录")
        except Exception as exc:
            logger.warning(f"读取文件清单失败，将使用空清单: {exc}")
            _files = {}
    sync(socketio=None)


def all_files() -> Dict[str, Dict[str, Any]]:
    return _files


def get(file_id: str) -> Dict[str, Any] | None:
    return _files.get(file_id)


def add(file_info: Dict[str, Any], socketio: SocketIO | None = None) -> None:
    with _lock:
        _files[file_info["id"]] = file_info
        _persist()
    if socketio is not None:
        socketio.emit("new_file", file_info)


def remove(file_id: str, socketio: SocketIO | None = None, delete_disk: bool = True) -> bool:
    with _lock:
        info = _files.pop(file_id, None)
        _persist()
    if info is None:
        return False
    if delete_disk:
        path = config.UPLOAD_FOLDER / info["filename"]
        try:
            path.unlink(missing_ok=True)
            logger.info(f"文件已删除: {path}")
        except Exception as exc:
            logger.warning(f"删除磁盘文件失败: {exc}")
    if socketio is not None:
        socketio.emit("file_deleted", file_id)
    return True


def disk_path(file_id: str) -> Path | None:
    info = _files.get(file_id)
    if info is None:
        return None
    return config.UPLOAD_FOLDER / info["filename"]


def sync(socketio: SocketIO | None = None) -> list:
    """剔除清单中磁盘上已不存在的文件，返回被剔除的 id 列表。"""
    removed = []
    with _lock:
        for fid in list(_files.keys()):
            path = config.UPLOAD_FOLDER / _files[fid]["filename"]
            if not path.exists():
                removed.append(fid)
                _files.pop(fid, None)
        if removed:
            _persist()
            logger.info(f"同步：移除丢失文件 {removed}")
    if socketio is not None:
        socketio.emit("file_list", list(_files.values()))
    return removed


def register_merged(file_id: str, file_name: str, file_size: int) -> Dict[str, Any]:
    safe_name = _safe_filename(file_id, file_name)
    file_info = {
        "id": file_id,
        "name": file_name,
        "size": format_file_size(file_size),
        "filename": safe_name,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    return file_info


def format_file_size(size) -> str:
    size = int(size)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size < 1024:
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} PB"
