# Drop · 文件传输

基于 Flask + SocketIO 的轻量文件传输应用，支持局域网与公网（ngrok）传输。

## 功能

- 拖拽 / 多选文件上传
- 分片 + 并发 + 二进制传输，支持大文件与断点重试
- 实时上传 / 下载进度，任务可取消 / 重试
- 文件清单持久化，服务重启不丢失
- 可选访问口令鉴权
- 一键 ngrok 公网穿透

## 快速开始

```bash
pip install -r requirements.txt
python app.py
```

默认监听 `http://0.0.0.0:5001`，启动时自动拉起 ngrok 公网地址（需配置 token）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DROP_SECRET_KEY` | 随机 | Flask 会话密钥 |
| `DROP_HOST` / `DROP_PORT` | `0.0.0.0` / `5001` | 监听地址 |
| `DROP_UPLOAD_FOLDER` / `DROP_CHUNKS_FOLDER` | `./uploads` / `./chunks` | 存储目录 |
| `DROP_MAX_FILE_SIZE` | `10737418240` | 单文件大小上限（字节） |
| `DROP_MAX_HTTP_BUFFER` | `67108864` | SocketIO 通知通道消息上限（与传输无关） |
| `DROP_REQUIRE_AUTH` | `false` | 是否启用口令鉴权 |
| `DROP_ACCESS_TOKEN` | 空 | 访问口令（启用鉴权时必填） |
| `DROP_ALLOWED_ORIGINS` | `*` | CORS，逗号分隔 |
| `DROP_ENABLE_NGROK` | `true` | 是否启动 ngrok |
| `NGROK_AUTHTOKEN` | 空 | ngrok 认证 token |

启用鉴权示例：

```bash
export DROP_REQUIRE_AUTH=true
export DROP_ACCESS_TOKEN="your-password"
python app.py
```

## Docker

```bash
docker build -t drop .
docker run -p 5001:5001 -v "$PWD/uploads:/app/uploads" drop
```

## 技术栈

- 后端：Flask 3 + Flask-SocketIO（eventlet）
- 前端：原生 ES Modules + Socket.IO 客户端
- 数据传输：HTTP 流式分片（`fetch` + `file.slice` 零拷贝 Blob，6 并发）
- 实时通知：SocketIO（文件列表 / 上传完成 / 删除广播）
