"""Структуры обмена ML-модуля с API (JSON). Координаты bbox — [x0, y0, x1, y1] в долях [0;1]
видимой области страницы (после CropBox и Rotate), начало — левый верхний угол (OS-INSP-2.2.2)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

BBox = tuple[float, float, float, float]


class Word(BaseModel):
    text: str
    bbox: BBox | None = None
    conf: float | None = None
    disputed: bool = False  # движки OCR разошлись в этом слове (OS-INSP-2.1.6)


RequisiteKind = Literal[
    "seal", "signature", "stamp_production", "stamp_asbuilt", "date", "reg_number"
]


class Requisite(BaseModel):
    """Реквизит документа на странице (OS-INSP-2.3.1): печать, подпись, штамп, дата."""

    kind: RequisiteKind
    bbox: BBox | None  # None — у структурированного документа (DOCX, XML) нет геометрии
    confidence: float
    value: str | None = None  # дата — ISO yyyy-mm-dd; штамп — найденная фраза


class PageRequisites(BaseModel):
    page: int
    items: list[Requisite]


class Line(BaseModel):
    text: str
    words: list[Word]


class Page(BaseModel):
    page: int
    width: float
    height: float
    rotation: int = 0
    source: Literal["text", "ocr", "structured", "skipped"]  # skipped — пустой лист или лист подписи, отсеянный паспортом (T-216)
    quality: Literal["OK", "LOW_QUALITY", "ABSTAIN"] = "OK"
    ocr_confidence: float | None = None
    lines: list[Line]
    # ансамбль OCR (OS-INSP-2.1.7): участвовавшие движки и как они разошлись
    engines: list[str] = []
    disputed_words: int = 0
    agreement: float | None = None  # доля слов, где все движки согласны; None — голосования не было
    # T-237: завершение Reader отдельно от голосования; пусто не означает высокий recall.
    execution_failures: list[str] = []
    # Diagnostic pre-vote anchor, never consumed as a second set of facts.
    anchor_words: list[Word] = []
    requisites: list[Requisite] = []  # реквизиты страницы (OS-INSP-2.3.1)


class ParsedDoc(BaseModel):
    sha256: str
    kind: Literal["pdf", "docx", "xml", "xlsx", "image"]  # xlsx, image — GAP-INSP-04 (OS-INSP-1.2.9)
    pages: list[Page]
    engine: str


class ParamSpec(BaseModel):
    code: str
    anchors: list[str]
    data_type: str = "string"
    regex_pattern: str | None = None
    # OS-INSP-2.2.9: вид правила сравнения Матрицы — у строкового параметра с числовым правилом берётся и число
    compare_kind: str | None = None
    # OS-INSP-2.2.13: особый извлекатель из паспорта параметра (kind, anchor, value, window, exclude) + scale и
    # constraint_markers; kind "class_mentions" — все упоминания класса по шкале (class_mentions.py)
    extractor: dict | None = None
    # единица параметра по Матрице — модулю таблиц (OS-INSP-2.2.5): строка таблицы даёт значение, только если её единица
    # совпала с единицей параметра (или той же величины: мм ↔ м) — T-135
    unit: str | None = None


class Extraction(BaseModel):
    code: str
    raw: str
    value_num: float | None = None
    value_text: str | None = None
    page: int
    bbox: BBox | None
    anchor_bbox: BBox | None = None
    line_text: str
    confidence: float
    match: str = "lexical"  # OS-INSP-2.2.8: lexical | semantic
    similarity: float | None = None  # косинус подписи и якоря для семантического совпадения
    # упоминание класса (OS-INSP-2.2.13–2.2.16): quote, qualifier ("min" — «не ниже»), excluded/excluded_why, ops
    meta: dict | None = None


class RoomFact(BaseModel):
    number: str
    name: str
    page: int
    bbox: BBox | None


class HiddenWork(BaseModel):
    """Позиция перечня скрытых работ из Общих данных (OS-INSP-1.4.4)."""

    n: int
    text: str
    page: int
    bbox: BBox | None


class ChangeMark(BaseModel):
    """Отметка изменения на листе (T-177, CMP-29): облако ревизии и выноска «Изм. N» (IDN-04), строка таблицы
    изменений основной надписи (IDN-03). bbox — доли листа; у строки штампа рамки нет."""

    page: int
    kind: Literal["cloud", "callout", "stamp_row"]
    number: str | None = None
    bbox: BBox | None = None
    text: str = ""


class AnalyzeRequest(BaseModel):
    # Путь не принимается: файл ищется только в хранилище блобов по своему хешу (защита от path traversal).
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    params: list[ParamSpec]
    facts: list[
        ParamSpec
    ] = []  # доп. факты для логических правил (не параметры Матрицы)


class AnalyzeResponse(BaseModel):
    sha256: str
    kind: str
    engine: str
    pages: list[
        dict
    ]  # сводка страниц: page, width, height, rotation, source, quality, ocr_confidence,
    # engines, disputed_words, agreement
    extractions: list[Extraction]
    facts: list[Extraction]
    rooms: list[RoomFact]
    requisites: list[PageRequisites] = []  # по страницам (OS-INSP-2.3.1)
    hidden_works: list[HiddenWork] = []  # OS-INSP-1.4.4
    title: str | None = None  # заголовок документа: по нему API узнаёт АОСР
    doc_type: dict | None = None  # OS-INSP-2.2.7: вид документа внутри марки (doctype.DocType)
    # OS-INSP-2.1.12: версия разбора и извлечения, давшая ответ — API повторно разбирает файлы прежней версии
    ml_revision: str | None = None
    cached: bool = False
    # OS-INSP-2.2.34 (ТЗ §11, TZA-11-07): время ML-анализа каждого параметра в документе, мс; из кэша — прежнего анализа
    param_ms: dict[str, int] = {}
    change_marks: list[ChangeMark] = []  # T-177: отметки изменений для CMP-29 (облака, выноски, таблица изменений штампа)


# ─────────────────────────────── T-034/T-035: советник и поиск по нормативам


class AdviseRequest(BaseModel):
    # Как и в /analyze: только хеши, файлы берутся из хранилища блобов.
    sha256: list[str] = Field(min_length=1, max_length=200)
    params: list[ParamSpec] = []


class NormSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=5, ge=1, le=50)
    rerank: bool = True
    extra: list[dict] = []  # записи normative_base из API


# ─────────────────────────────── OS-INSP-3.4 дифф листа между редакциями


class DiffRequest(BaseModel):
    # Как в /analyze: путь не принимается, файлы — только из хранилища блобов по хешу.
    sha_a: str = Field(pattern=r"^[0-9a-f]{64}$")
    page_a: int = Field(ge=1, le=10_000)
    sha_b: str = Field(pattern=r"^[0-9a-f]{64}$")
    page_b: int = Field(ge=1, le=10_000)


class DiffRegion(BaseModel):
    bbox_a: BBox  # доли листа A (левый верхний угол — начало), видимая ориентация
    bbox_b: BBox  # та же область на листе B — обратной гомографией
    score: float  # значимость 0..1
    area: float  # доля площади листа A


class DiffResponse(BaseModel):
    status: Literal["ok", "not_comparable"]
    reason: str | None = None
    inliers: int
    matches: int = 0
    method: str = ""
    regions: list[DiffRegion] = []
    ms: int = 0
    cached: bool = False


class MeasureRequest(BaseModel):
    """Измерение на чертеже (OS-INSP-2.4): файл и страница."""

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")  # R2 T-138, E1-L5: как у AnalyzeRequest
    page: int = 1
