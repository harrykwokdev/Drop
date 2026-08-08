"""运行时配置：所有可调参数从环境变量读取，提供安全默认值。"""
from __future__ import annotations

import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


BASE_DIR = Path(__file__).resolve().parent

SECRET_KEY = os.environ.get("DROP_SECRET_KEY", os.urandom(32).hex())

UPLOAD_FOLDER = Path(os.environ.get("DROP_UPLOAD_FOLDER", BASE_DIR / "uploads"))
CHUNKS_FOLDER = Path(os.environ.get("DROP_CHUNKS_FOLDER", BASE_DIR / "chunks"))
REGISTRY_FILE = UPLOAD_FOLDER / ".registry.json"

HOST = os.environ.get("DROP_HOST", "0.0.0.0")
PORT = int(os.environ.get("DROP_PORT", "5001"))

MAX_FILE_SIZE = int(os.environ.get("DROP_MAX_FILE_SIZE", str(10 * 1024 * 1024 * 1024)))
CHUNK_BUFFER_SIZE = int(os.environ.get("DROP_MAX_HTTP_BUFFER", str(64 * 1024 * 1024)))

ACCESS_TOKEN = os.environ.get("DROP_ACCESS_TOKEN", "").strip()
REQUIRE_AUTH = _bool("DROP_REQUIRE_AUTH", False) and bool(ACCESS_TOKEN)

ENABLE_NGROK = _bool("DROP_ENABLE_NGROK", True)
NGROK_TOKEN = os.environ.get("NGROK_AUTHTOKEN", "").strip()

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("DROP_ALLOWED_ORIGINS", "*").split(",")
    if o.strip()
] or ["*"]


def ensure_dirs() -> None:
    for folder in (UPLOAD_FOLDER, CHUNKS_FOLDER):
        folder.mkdir(parents=True, exist_ok=True)
