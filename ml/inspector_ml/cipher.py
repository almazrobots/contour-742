"""Шифр документа: исправление гомоглифов по реестру файлов (OS-INSP-2.2.6).

OCR путает визуально близкие знаки: цифру «3» и букву «З», «0» и «О», «6» и «Б», латиницу и кириллицу.
Шифр в реестре набран человеком и является эталоном. Если прочитанный шифр совпадает с записью реестра
после приведения всех близких знаков к одному представителю — берём запись реестра и помечаем исправление.
Совпало с двумя и более записями — не исправляем: выбрать нельзя, ошибка выбора хуже ошибки чтения.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Класс неразличимых на листе знаков → представитель. Регистр приводится к верхнему заранее.
_CLASSES = {
    "3": "3З",
    "0": "0OО",
    "6": "6Б",
    "1": "1IІ|",  # «l» → «1» до upper(), см. canon()
    "А": "AА",
    "В": "BВ",
    "С": "CС",
    "Е": "EЕ",
    "Н": "HН",
    "К": "KК",
    "М": "MМ",
    "Р": "PР",
    "Т": "TТ",
    "Х": "XХ",
    "У": "YУ",
}
_CANON = str.maketrans({ch: rep for rep, chars in _CLASSES.items() for ch in chars})
# Путаница OCR, где одна буква читается несколькими знаками: «Ж» → «)K», «}K», «>K<».
_MULTI = [(">K<", "Ж"), (")K", "Ж"), ("}K", "Ж"), (")К", "Ж"), ("}К", "Ж")]
# Нераспознанный знак OCR: соответствует ровно одному любому знаку записи реестра.
UNKNOWN = "?"


def canon(code: str) -> str:
    """Ключ сравнения: верхний регистр, близкие знаки — к представителю, без пробелов вокруг «-», «.», «/»."""
    # строчная «l» похожа на «1», а после upper() стала бы буквой «L» — меняем до смены регистра
    s = re.sub(r"\s*([-./])\s*", r"\1", code.strip().replace("l", "1").upper())
    for seq, letter in _MULTI:
        s = s.replace(seq, letter)
    return re.sub(r"\s+", " ", s).translate(_CANON)


@dataclass(frozen=True)
class CipherFix:
    value: str  # шифр после исправления (или прочитанный как есть)
    corrected: bool  # значение взято из реестра вместо прочитанного
    read: str  # что прочитал OCR — для карточки доказательства


def _same(read_key: str, reg_key: str) -> bool:
    """Ключи совпадают знак в знак; «?» в прочитанном — любой один знак."""
    if UNKNOWN not in read_key:
        return read_key == reg_key
    return len(read_key) == len(reg_key) and all(a == UNKNOWN or a == b for a, b in zip(read_key, reg_key))


def fix_code(read: str, registry: list[str]) -> CipherFix:
    if not read or read in registry:
        return CipherFix(read, False, read)
    key = canon(read)
    hits = sorted({r for r in registry if _same(key, canon(r))})
    if len(hits) == 1:
        return CipherFix(hits[0], True, read)
    return CipherFix(read, False, read)
