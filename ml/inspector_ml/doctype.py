"""Вид документа внутри марки (OS-INSP-2.2.7, ТЗ §4): спецификация, ведомость, общие данные, смета,
опросный лист, расчёт, чертёж. Вид определяет, может ли документ быть источником проектного значения.

Признаки — только то, что видно на листе: слова заголовка в верхней части первой страницы и шапка таблицы.
Спецификация по ГОСТ 21.110 узнаётся по колонкам «Поз.», «Обозначение», «Наименование», «Кол.», «Масса»,
даже если слова «Спецификация» в заголовке нет.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from .model import BBox, ParsedDoc
from .normalize import fold

# Порядок важен: «Локальный сметный расчёт» — смета, а не расчёт; «Ведомость ТЭП» — ведомость.
TITLE_RULES: list[tuple[str, str]] = [
    ("estimate", r"\b(смет\w*|лср)\b"),
    ("questionnaire", r"\bопросн\w*\s+лист\w*"),
    ("specification", r"\bспецификац\w*"),
    ("statement", r"\bведомост\w*"),
    ("general_data", r"\bобщие\s+данные\b"),
    ("calculation", r"\bрасч[её]т\w*"),
    ("drawing", r"\b(чертеж\w*|схем\w*|план\s+\w+\s+этажа|разрез\w*|фасад\w*)"),
]
SPEC_HEADER = ["поз", "обозначение", "наименование", "кол", "масса", "примечание"]
SPEC_HEADER_MIN = 4  # колонок шапки ГОСТ 21.110 — достаточно для узнавания без заголовка
TITLE_ZONE = 0.35  # заголовок ищется в верхней трети первой страницы
LABEL = {
    "specification": "Спецификация",
    "statement": "Ведомость",
    "general_data": "Общие данные",
    "estimate": "Смета",
    "questionnaire": "Опросный лист",
    "calculation": "Расчёт",
    "drawing": "Чертёж",
    "other": "Прочий документ",
}


class DocType(BaseModel):
    kind: str
    label: str
    confidence: float
    page: int | None = None
    bbox: BBox | None = None
    evidence: str | None = None  # строка, по которой определён вид


def _line_bbox(line) -> BBox | None:
    bs = [w.bbox for w in line.words if w.bbox]
    if not bs:
        return None
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def classify(doc: ParsedDoc) -> DocType:
    # 1) шапка спецификации ГОСТ 21.110 — самый сильный признак, на любой странице
    for page in doc.pages:
        for line in page.lines:
            words = {re.sub(r"[^\w]", "", fold(w.text)) for w in line.words}
            hits = sum(any(w.startswith(h) for w in words if w) for h in SPEC_HEADER)
            if hits >= SPEC_HEADER_MIN:
                return DocType(kind="specification", label=LABEL["specification"], confidence=0.9, page=page.page, bbox=_line_bbox(line), evidence=line.text)
    # 2) слово вида в заголовке: верхняя треть первой непустой страницы
    first = next((p for p in doc.pages if p.lines), None)
    if first:
        for line in first.lines:
            b = _line_bbox(line)
            if b and b[1] > TITLE_ZONE:
                continue
            t = fold(line.text)
            for kind, rx in TITLE_RULES:
                if re.search(rx, t):
                    return DocType(kind=kind, label=LABEL[kind], confidence=0.8, page=first.page, bbox=b, evidence=line.text)
    return DocType(kind="other", label=LABEL["other"], confidence=0.5)
