"""SHA-256 и голова файла хранилища без чтения его целиком (T-169, OS-INSP-1.2.40).

Тома ИД доходят до гигабайта: ``hashlib.sha256(path.read_bytes())`` держал бы весь файл в памяти процесса разбора
ради одной сверки хеша — на каждый вызов /analyze, /measure и этапа конвейера. Здесь файл читается кусками.
PDF дальше открывает pdfium по пути (FPDF_LoadDocument): страницы читаются с диска по требованию, по одной.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

CHUNK = 1 << 20  # 1 МиБ: крупнее — больше памяти на кусок, мельче — больше системных вызовов


def sha256_file(path: Path, chunk: int = CHUNK) -> str:
    """SHA-256 содержимого файла, читаемого кусками по ``chunk`` байт."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def read_head(path: Path, n: int) -> bytes:
    """Первые ``n`` байт файла (меньше — если файл короче) — для определения формата по сигнатуре."""
    with open(path, "rb") as f:
        return f.read(n)
