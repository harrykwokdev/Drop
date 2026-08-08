"""Drop —— 局域网/公网文件传输服务。

入口模块：创建 Flask 应用、注册路由与 SocketIO 事件、启动服务。
"""
from __future__ import annotations

import logging
import os
import secrets
import shutil
import socket
import threading

import eventlet
from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from flask_socketio import SocketIO, emit

import config
import storage

eventlet.monkey_patch()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("drop")


def create_app() -> tuple[Flask, SocketIO]:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = config.SECRET_KEY
    app.config["UPLOAD_FOLDER"] = str(config.UPLOAD_FOLDER)
    app.config["MAX_CONTENT_LENGTH"] = config.MAX_FILE_SIZE

    # python-socketio 仅对字符串 "*" 做通配特殊处理；
    # 传 ['*'] 会退化为精确匹配导致所有 Origin 被拒。
    cors = config.ALLOWED_ORIGINS
    if cors == ["*"]:
        cors = "*"

    socketio = SocketIO(
        app,
        cors_allowed_origins=cors,
        async_mode="eventlet",
        ping_timeout=120,
        ping_interval=25,
        max_http_buffer_size=config.CHUNK_BUFFER_SIZE,
    )

    config.ensure_dirs()
    storage.load()

    # ---------- 鉴权 ----------
    def _check_auth() -> bool:
        if not config.REQUIRE_AUTH:
            return True
        return session.get("drop_token") == config.ACCESS_TOKEN

    @app.before_request
    def _gate():
        if not config.REQUIRE_AUTH:
            return None
        if request.endpoint in {"login", "static", "favicon"}:
            return None
        if request.path.startswith("/static/"):
            return None
        if not _check_auth():
            if request.path.startswith("/api/") or request.path.startswith("/socket.io"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login"))

    if config.REQUIRE_AUTH:

        @app.route("/login", methods=["GET", "POST"])
        def login():
            if request.method == "POST":
                token = (request.form.get("token") or "").strip()
                if secrets.compare_digest(token, config.ACCESS_TOKEN):
                    session["drop_token"] = token
                    return redirect(url_for("index"))
                return render_template("login.html", error="口令错误"), 401
            return render_template("login.html", error=None)

        @app.route("/logout")
        def logout():
            session.pop("drop_token", None)
            return redirect(url_for("login"))

    # ---------- 页面与连接信息 ----------
    public_url = {"value": None}

    @app.route("/")
    def index():
        return render_template("index.html", require_auth=config.REQUIRE_AUTH)

    @app.route("/download/<file_id>")
    def download_file(file_id: str):
        info = storage.get(file_id)
        if info is None:
            logger.warning(f"下载文件不存在: {file_id}")
            return "文件不存在", 404
        path = config.UPLOAD_FOLDER / info["filename"]
        if not path.exists():
            logger.warning(f"磁盘文件缺失: {file_id}")
            storage.remove(file_id, socketio)
            return "文件不存在", 404
        logger.info(f"下载文件: {file_id} -> {info['filename']}")
        return send_from_directory(
            config.UPLOAD_FOLDER, info["filename"], as_attachment=True, download_name=info["name"]
        )

    @app.route("/api/connection_info")
    def get_connection_info():
        try:
            hostname = socket.gethostname()
            local_ip = socket.gethostbyname(hostname)
            local_url = f"http://{local_ip}:{config.PORT}"
        except Exception:
            local_url = f"http://127.0.0.1:{config.PORT}"
        return jsonify({"local_url": local_url, "ngrok_url": public_url["value"] or ""})

    # ---------- HTTP 分片上传接口（数据通道，每分片独立连接+协程）----------
    @app.route("/api/upload/chunk", methods=["POST"])
    def upload_chunk():
        file_id = request.headers.get("X-File-Id", "")
        try:
            chunk_index = int(request.headers.get("X-Chunk-Index", "-1"))
        except ValueError:
            return jsonify({"error": "bad chunk_index"}), 400
        if not file_id or chunk_index < 0:
            return jsonify({"error": "missing metadata"}), 400

        chunk_folder = config.CHUNKS_FOLDER / file_id
        chunk_folder.mkdir(parents=True, exist_ok=True)
        chunk_path = chunk_folder / f"chunk_{chunk_index:06d}"
        # 流式落盘：request.stream 直接复制到文件，避免整块进内存
        with open(chunk_path, "wb") as f:
            shutil.copyfileobj(request.stream, f, length=4 * 1024 * 1024)
        return jsonify({"ok": True, "chunk_index": chunk_index})

    @app.route("/api/upload/merge", methods=["POST"])
    def merge_chunks():
        data = request.get_json(force=True, silent=True) or {}
        try:
            file_id = str(data["file_id"])
            file_name = str(data["file_name"])
            file_size = int(data["file_size"])
            total_chunks = int(data["total_chunks"])
        except (KeyError, ValueError):
            return jsonify({"error": "invalid payload"}), 400
        # 合并放到后台协程；完成/失败通过 socket 广播（new_file / merge_failed）
        socketio.start_background_task(
            _merge_task, file_id, file_name, file_size, total_chunks
        )
        return jsonify({"ok": True}), 202

    # ---------- SocketIO 事件（仅实时通知）----------
    @socketio.on("connect")
    def handle_connect():
        logger.info(f"客户端连接: {request.sid}")
        emit("file_list", list(storage.all_files().values()))

    @socketio.on("disconnect")
    def handle_disconnect():
        logger.info(f"客户端断开: {request.sid}")

    @socketio.on("delete_file")
    def handle_delete(data):
        file_id = str(data.get("file_id", ""))
        if storage.remove(file_id, socketio):
            logger.info(f"客户端删除文件: {file_id}")

    def _merge_task(file_id, file_name, file_size, total_chunks):
        """后台合并分片；结果通过 socket 广播给所有客户端。"""
        try:
            chunk_folder = config.CHUNKS_FOLDER / file_id
            missing = [
                i for i in range(total_chunks)
                if not (chunk_folder / f"chunk_{i:06d}").exists()
            ]
            if missing:
                logger.error(f"分片缺失，无法合并: {missing[:10]}{'...' if len(missing) > 10 else ''}")
                socketio.emit(
                    "merge_failed",
                    {"file_id": file_id, "reason": "missing_chunks", "missing": missing[:20]},
                )
                return

            file_info = storage.register_merged(file_id, file_name, file_size)
            file_path = config.UPLOAD_FOLDER / file_info["filename"]
            logger.info(f"开始合并: {file_name} 共 {total_chunks} 片 -> {file_path}")

            with open(file_path, "wb") as outfile:
                for i in range(total_chunks):
                    chunk_path = chunk_folder / f"chunk_{i:06d}"
                    outfile.write(chunk_path.read_bytes())

            for i in range(total_chunks):
                (chunk_folder / f"chunk_{i:06d}").unlink(missing_ok=True)
            try:
                chunk_folder.rmdir()
            except OSError:
                pass

            storage.add(file_info, socketio)  # 内部广播 new_file
            logger.info(f"合并完成: {file_path}")
        except Exception as exc:
            logger.exception(f"合并分片失败: {exc}")
            socketio.emit("merge_failed", {"file_id": file_id, "reason": str(exc)})

    return app, socketio, public_url


def _kill_ngrok() -> None:
    try:
        if os.name == "nt":
            os.system("taskkill /f /im ngrok.exe")
        else:
            os.system("pkill ngrok")
    except Exception as exc:
        logger.warning(f"清理 ngrok 进程失败: {exc}")


def _start_ngrok(public_url_holder: dict) -> None:
    if not config.ENABLE_NGROK:
        return
    try:
        from pyngrok import ngrok

        if config.NGROK_TOKEN:
            ngrok.set_auth_token(config.NGROK_TOKEN)
        tunnel = ngrok.connect(config.PORT, "http")
        public_url_holder["value"] = tunnel.public_url
        logger.info(f" * ngrok 公网地址: {tunnel.public_url}")
    except Exception as exc:
        logger.error(f"ngrok 启动失败: {exc}")
        public_url_holder["value"] = None


def _local_url() -> str:
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        return f"http://{ip}:{config.PORT}"
    except Exception:
        return f"http://127.0.0.1:{config.PORT}"


app, socketio, _public_url = create_app()


if __name__ == "__main__":
    # 仅在主进程启动 ngrok，避免 debug/reload 多次拉起
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        _kill_ngrok()
        _start_ngrok(_public_url)

    local_url = _local_url()
    logger.info("启动服务器...")
    logger.info(f"本地（内网）访问地址: {local_url}")
    logger.info(f"外网（ngrok）访问地址: {_public_url['value'] or '未获取到'}")
    if config.REQUIRE_AUTH:
        logger.info("已启用访问口令鉴权")
    socketio.run(app, host=config.HOST, port=config.PORT)
