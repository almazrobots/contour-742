"""Кэш результатов разбора по SHA-256 (OS-INSP-2.1.3, ТЗ 9.1.5): файловый в профиле dev, Redis в профиле gpu.

Один интерфейс — get/set строк по ключу; контрактный тест гоняет обе реализации. Redis-клиент подаётся снаружи
(redis.Redis.from_url в профиле gpu), чтобы тест работал без сервера на поддельном клиенте.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol


class Cache(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str) -> None: ...


class FileCache:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        if not key or "/" in key or key.startswith("."):
            raise ValueError(f"недопустимый ключ кэша: {key!r}")
        return self.root / f"{key}.json"

    def get(self, key: str) -> str | None:
        p = self._path(key)
        return p.read_text("utf-8") if p.exists() else None

    def set(self, key: str, value: str) -> None:
        p = self._path(key)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(value, "utf-8")
        tmp.replace(p)  # атомарно: параллельный читатель не увидит половину файла


class RedisCache:
    PREFIX = "inspector:ml:"

    def __init__(self, client, ttl_s: int = 30 * 86400) -> None:
        self.client = client
        self.ttl = ttl_s

    def get(self, key: str) -> str | None:
        v = self.client.get(self.PREFIX + key)
        return v.decode("utf-8") if isinstance(v, bytes) else v

    def set(self, key: str, value: str) -> None:
        self.client.set(self.PREFIX + key, value.encode("utf-8"), ex=self.ttl)


def make_cache(profile: str, default_dir: Path) -> Cache:
    """dev — файлы; gpu — Redis (обязателен, иначе падение при старте: тихий откат на диск скрыл бы отказ)."""
    mode = os.environ.get("INSPECTOR_CACHE", "redis" if profile == "gpu" else "file")
    if mode not in ("file", "redis"):
        raise SystemExit(f"INSPECTOR_CACHE={mode!r}: ждём file или redis")
    if profile == "gpu" and mode != "redis":
        raise SystemExit("INSPECTOR_CACHE=file недопустим в профиле gpu: кэш — Redis (ТЗ 9.1.5)")
    if mode == "file":
        return FileCache(Path(os.environ.get("INSPECTOR_ML_CACHE", default_dir)))
    url = os.environ.get("INSPECTOR_REDIS_URL")
    if not url:
        raise SystemExit("INSPECTOR_CACHE=redis требует INSPECTOR_REDIS_URL (redis://…)")
    import redis  # только профиль gpu

    return RedisCache(redis.Redis.from_url(url))
