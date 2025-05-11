# 文件传输应用

一个基于 Web 的文件传输应用，支持局域网和公网文件传输。

## 功能特点

- 支持拖放文件上传
- 实时显示在线用户
- 支持大文件传输
- 简洁美观的用户界面
- 支持局域网和公网传输

## 安装说明

1. 克隆项目到本地
2. 安装依赖：
   ```bash
   pip install -r requirements.txt
   ```
3. 运行应用：
   ```bash
   python app.py
   ```
## 技术栈

- 后端：Flask + Flask-SocketIO
- 前端：HTML5 + JavaScript
- 通信：WebSocket 