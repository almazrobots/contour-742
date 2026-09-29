"""Память процесса разбора возвращается системе после каждого документа (T-230).

Замер 28.09 (сервер 4090, 9 томов, PP-OCR на CUDA + VL): освобождённые растры страниц оставались в аренах glibc —
по одной на поток (пул страниц и сотня потоков ONNX Runtime), malloc_trim(0) после файла возвращал 0,8–2,8 ГБ, а RSS
пачки дорастал до 18–24 ГБ и ловил OOM. Лечение: меньше арен (M_ARENA_MAX до создания потоков) и malloc_trim после
документа. Вне glibc (мак, musl) — только сборка мусора.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import gc
import os
import sys

M_ARENA_MAX = -8  # mallopt, malloc.h

_LIBC = None
if sys.platform.startswith("linux"):
    try:
        _LIBC = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        _LIBC.malloc_trim  # noqa: B018 — есть только в glibc
    except (OSError, AttributeError):
        _LIBC = None


def limit_arenas(env: dict | None = None) -> int:
    """Потолок арен glibc (INSPECTOR_MALLOC_ARENAS, по умолчанию 4; MALLOC_ARENA_MAX в окружении главнее).
    Действует на арены, созданные после вызова, — вызывается при импорте разбора, до пулов потоков."""
    e = os.environ if env is None else env
    if _LIBC is None or e.get("MALLOC_ARENA_MAX"):
        return 0
    try:
        n = min(max(int(e.get("INSPECTOR_MALLOC_ARENAS", "4")), 1), 64)
    except ValueError:
        n = 4
    _LIBC.mallopt(M_ARENA_MAX, n)
    return n


def release() -> None:
    """После документа: сборка мусора и возврат свободных страниц всех арен системе."""
    gc.collect()
    if _LIBC is not None:
        _LIBC.malloc_trim(0)
