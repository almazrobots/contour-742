"""Нормализация распознанного текста: латиница/кириллица-двойники, числа в русской записи."""

from __future__ import annotations

import re
import unicodedata

# Кириллические двойники латиницы в обозначениях классов (В30 ↔ B30, А500С ↔ A500C, ЕI ↔ EI).
_CYR2LAT = str.maketrans(
    {
        "А": "A",
        "В": "B",
        "С": "C",
        "Е": "E",
        "І": "I",
        "Р": "P",
        "Н": "H",
        "К": "K",
        "М": "M",
        "Т": "T",
        "О": "O",
        "Х": "X",
    }
)

NUMBER_RE = re.compile(
    r"(?<![\w.,])[-+]?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?![\w])|(?<![\w.,])[-+]?\d+(?:[.,]\d+)?(?![\w])"
)


def nfc(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def fold(s: str) -> str:
    """Ключ для сопоставления якорей: NFC, нижний регистр, ё→е, без пунктуации."""
    s = nfc(s).lower().replace("ё", "е")
    return re.sub(r"[^\w\s]", " ", s).replace("  ", " ").strip()


def latinize_code(s: str) -> str:
    """Обозначение класса/марки к латинице и без пробелов: «В 30» → «B30», «ЕI 60» → «EI60»."""
    return re.sub(r"[\s\-]", "", nfc(s).upper().translate(_CYR2LAT))


def parse_number(s: str) -> float | None:
    m = NUMBER_RE.search(s)
    if not m:
        return None
    raw = re.sub(r"[   ]", "", m.group(0)).replace(",", ".")
    try:
        return float(raw)
    except ValueError:  # pragma: no cover — регулярка не пропускает нечисел
        return None
