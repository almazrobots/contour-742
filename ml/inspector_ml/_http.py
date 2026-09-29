"""Мини-клиент JSON по HTTP на stdlib (без новых зависимостей) — для локального Ollama.

Ошибки сети и HTTP — OSError (URLError, HTTPError, TimeoutError), разбора — ValueError.
"""

from __future__ import annotations

import json
import urllib.request


def get_json(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 — только локальный Ollama из конфигурации
        return json.loads(r.read().decode("utf-8"))


def post_json(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        return json.loads(r.read().decode("utf-8"))
