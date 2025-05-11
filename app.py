import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, jsonify, send_from_directory, after_this_request
from flask_socketio import SocketIO, emit, disconnect
import os
import json
from datetime import datetime
import uuid
import base64
import logging
from pyngrok import ngrok
import signal

# 只输出INFO及以上，且只显示关键信息
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key'
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['CHUNKS_FOLDER'] = 'chunks'  # 临时分片目录

socketio = SocketIO(app, 
                   cors_allowed_origins="*",
                   async_mode='eventlet',
                   ping_timeout=120,
                   ping_interval=25,
                   max_http_buffer_size=2 * 1024 * 1024 * 1024  # 允许单条消息最大2GB
)

# 确保上传和分片目录存在
for folder in [app.config['UPLOAD_FOLDER'], app.config['CHUNKS_FOLDER']]:
    if not os.path.exists(folder):
        os.makedirs(folder)

# 存储文件信息
files = {}

public_url = None

def kill_ngrok():
    try:
        if os.name == 'nt':
            os.system('taskkill /f /im ngrok.exe')
        else:
            os.system('pkill ngrok')
    except Exception as e:
        logger.warning(f"清理ngrok进程失败: {e}")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/download/<file_id>')
def download_file(file_id):
    try:
        if file_id in files:
            logger.info(f"下载文件: {file_id} -> {files[file_id]['filename']}")
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], files[file_id]['filename'])
            if not os.path.exists(file_path):
                logger.warning(f"文件不存在: {file_id}")
                return "文件不存在", 404
            @after_this_request
            def remove_file(response):
                try:
                    if os.path.exists(file_path):
                        os.remove(file_path)
                    logger.info(f"文件已下载并删除: {file_id}")
                    if file_id in files:
                        del files[file_id]
                    sync_files()
                except Exception as e:
                    logger.error(f"下载后删除文件时出错: {str(e)}")
                return response
            return send_from_directory(app.config['UPLOAD_FOLDER'], files[file_id]['filename'], as_attachment=True)
        logger.warning(f"下载文件不存在: {file_id}")
        return "文件不存在", 404
    except Exception as e:
        logger.error(f"下载文件时出错: {str(e)}")
        return "下载文件时出错", 500

@socketio.on('connect')
def handle_connect():
    logger.info(f"新客户端连接: {request.sid}")
    emit('file_list', list(files.values()))

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"客户端断开: {request.sid}")

# 分片上传：接收单个分片
@socketio.on('upload_chunk')
def handle_upload_chunk(data):
    try:
        file_id = data['file_id']
        chunk_index = data['chunk_index']
        total_chunks = data['total_chunks']
        file_name = data['file_name']
        file_size = data['file_size']
        chunk_data = data['chunk_data']
        chunk_folder = os.path.join(app.config['CHUNKS_FOLDER'], file_id)
        if not os.path.exists(chunk_folder):
            os.makedirs(chunk_folder)
        chunk_path = os.path.join(chunk_folder, f"chunk_{chunk_index:06d}")
        # 解码 base64
        with open(chunk_path, 'wb') as f:
            f.write(base64.b64decode(chunk_data.split(',')[1]))
        logger.info(f"收到分片: {file_name} [{chunk_index+1}/{total_chunks}] -> {chunk_path}")
    except Exception as e:
        logger.error(f"接收分片时出错: {str(e)}")
        disconnect()

# 分片上传：合并分片
@socketio.on('merge_chunks')
def handle_merge_chunks(data):
    try:
        file_id = data['file_id']
        file_name = data['file_name']
        file_size = data['file_size']
        total_chunks = data['total_chunks']
        chunk_folder = os.path.join(app.config['CHUNKS_FOLDER'], file_id)
        file_ext = os.path.splitext(file_name)[1]
        safe_filename = f"{file_id}{file_ext}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_filename)
        logger.info(f"开始合并分片: {file_name} 共{total_chunks}片 -> {file_path}")
        # 合并前检查所有分片是否存在
        missing_chunks = []
        for i in range(total_chunks):
            chunk_path = os.path.join(chunk_folder, f"chunk_{i:06d}")
            if not os.path.exists(chunk_path):
                missing_chunks.append(i)
        if missing_chunks:
            logger.error(f"分片缺失，无法合并: {missing_chunks}")
            disconnect()
            return
        with open(file_path, 'wb') as outfile:
            for i in range(total_chunks):
                chunk_path = os.path.join(chunk_folder, f"chunk_{i:06d}")
                with open(chunk_path, 'rb') as infile:
                    outfile.write(infile.read())
        # 合并完成后删除分片
        for i in range(total_chunks):
            os.remove(os.path.join(chunk_folder, f"chunk_{i:06d}"))
        os.rmdir(chunk_folder)
        logger.info(f"合并完成并清理分片: {file_path}")
        # 存储文件信息
        file_info = {
            'id': file_id,
            'name': file_name,
            'size': format_file_size(file_size),
            'filename': safe_filename,
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }
        files[file_id] = file_info
        logger.info(f"文件上传成功: {file_name} (id: {file_id})")
        emit('new_file', file_info, broadcast=True)
        sync_files()
    except Exception as e:
        logger.error(f"合并分片时出错: {str(e)}")
        disconnect()

@socketio.on('delete_file')
def handle_delete(data):
    try:
        file_id = data.get('file_id')
        if file_id in files:
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], files[file_id]['filename'])
            if os.path.exists(file_path):
                os.remove(file_path)
                logger.info(f"文件已删除: {file_path}")
            del files[file_id]
            logger.info(f"文件信息已移除: {file_id}")
            emit('file_deleted', file_id, broadcast=True)
            sync_files()
    except Exception as e:
        logger.error(f"删除文件时出错: {str(e)}")

def format_file_size(size):
    size = int(size)
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} PB"

def sync_files():
    # 检查uploads目录和files字典，移除丢失文件
    removed = []
    for file_id, info in list(files.items()):
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], info['filename'])
        if not os.path.exists(file_path):
            removed.append(file_id)
            del files[file_id]
    if removed:
        logger.info(f"同步：移除丢失文件 {removed}")
    # 广播最新文件列表
    socketio.emit('file_list', list(files.values()))

@app.route('/api/ngrok_url')
def get_ngrok_url():
    return jsonify({'url': public_url or ''})

@app.route('/api/connection_info')
def get_connection_info():
    import socket
    try:
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        local_url = f"http://{local_ip}:5001"
    except Exception:
        local_url = "http://127.0.0.1:5001"
    return jsonify({
        "local_url": local_url,
        "ngrok_url": public_url or ""
    })

if __name__ == '__main__':
    # 只在主进程启动ngrok，避免Flask debug/reload多次启动
    if os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        kill_ngrok()
        try:
            tunnel = ngrok.connect(5001, "http")
            public_url = tunnel.public_url
            logger.info(f" * ngrok 公网地址: {public_url}")
        except Exception as e:
            logger.error(f"ngrok 启动失败: {e}")
            public_url = None

    # 日志输出
    import socket
    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
        local_url = f"http://{local_ip}:5001"
    except Exception:
        local_url = f"http://127.0.0.1:5001"
    logger.info("启动服务器...")
    logger.info(f"本地（内网）访问地址: {local_url}")
    logger.info(f"外网（ngrok）访问地址: {public_url if public_url else '未获取到'}")
    socketio.run(app, host='0.0.0.0', port=5001) 