"""Растеризация страниц PDF в пуле процессов (T-233).

pdfium не потокобезопасен, поэтому внутри процесса ML страницы рисуются под одним замком (parse.PDFIUM_LOCK) — одна
за раз, и тяжёлый лист (сотни тысяч векторных объектов — до 100 с) держит весь процесс: GPU и ядра ждут. Здесь каждая
страница рисуется в отдельном процессе со своим pdfium — без общего замка, параллельно на свободных ядрах. OCR
остаётся в процессе ML (модель на GPU одна на процесс).

INSPECTOR_RENDER_PROCS — процессов пула на процесс ML (0 — выкл., рендер под замком, как раньше; предел 16).
INSPECTOR_RENDER_POOL_MAX_MPX — лист крупнее рисуется по-старому в процессе ML: передавать сотни мегабайт растра
между процессами дороже, чем рисовать на месте."""

from __future__ import annotations

import logging
import multiprocessing
import os
import threading
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

from PIL import Image

log = logging.getLogger(__name__)

_POOL: ProcessPoolExecutor | None = None
_POOL_LOCK = threading.Lock()
_BROKEN = False


def procs(env: dict | None = None) -> int:
    raw = (os.environ if env is None else env).get("INSPECTOR_RENDER_PROCS", "0")
    try:
        return min(max(int(raw), 0), 16)
    except ValueError:
        raise ValueError(f"INSPECTOR_RENDER_PROCS={raw!r}: ждём целое 0…16")


def max_mpx(env: dict | None = None) -> float:
    raw = (os.environ if env is None else env).get(
        "INSPECTOR_RENDER_POOL_MAX_MPX", "40"
    )
    try:
        return max(float(raw), 1.0)
    except ValueError:
        raise ValueError(f"INSPECTOR_RENDER_POOL_MAX_MPX={raw!r}: ждём число")


# ─────────────────────────────── в процессе пула

_DOCS: "OrderedDict[str, object]" = (
    OrderedDict()
)  # открытые документы процесса пула: путь → PdfDocument
_DOCS_MAX = 2


def _doc(path: str):
    import pypdfium2 as pdfium

    st = os.stat(path)
    key = f"{path}|{st.st_size}|{st.st_mtime_ns}"  # временный файл под тем же именем — другой документ, не кэш
    d = _DOCS.pop(key, None)
    if d is None:
        d = pdfium.PdfDocument(path)
    _DOCS[key] = d
    while len(_DOCS) > _DOCS_MAX:
        _DOCS.popitem(last=False)[1].close()
    return d


def render_in_worker(
    path: str, index: int, scale: float
) -> tuple[str, tuple[int, int], bytes]:
    """Рисует страницу index (с нуля) в масштабе scale; отдаёт (режим, размер, байты) — PIL-растр через границу процесса."""
    page = _doc(path)[index]
    try:
        img = page.render(scale=scale).to_pil()
    finally:
        page.close()
    return img.mode, img.size, img.tobytes()


# ─────────────────────────────── в процессе ML


def _pool() -> ProcessPoolExecutor | None:
    global _POOL
    n = procs()
    if n == 0 or _BROKEN:
        return None
    with _POOL_LOCK:
        if _POOL is None:
            # spawn: дочерний процесс не наследует модели OCR и потоки ONNX Runtime процесса ML
            _POOL = ProcessPoolExecutor(
                max_workers=n, mp_context=multiprocessing.get_context("spawn")
            )
        return _POOL


def render(path: str, index: int, scale: float, mpx: float) -> Image.Image | None:
    """Растр страницы из пула или None — тогда рисует вызывающий, под замком, как раньше (пул выключен, лист крупнее
    INSPECTOR_RENDER_POOL_MAX_MPX, пул сломан). Сломанный пул — предупреждение и старый путь, а не ошибка разбора."""
    global _BROKEN
    pool = _pool()
    if pool is None or mpx > max_mpx():
        return None
    try:
        mode, size, data = pool.submit(render_in_worker, path, index, scale).result()
    except BrokenProcessPool as e:
        _BROKEN = True
        log.warning(
            "пул растеризации сломан (%s) — дальше рендер под замком процесса", e
        )
        return None
    return Image.frombytes(mode, size, data)
