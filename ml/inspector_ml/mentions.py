"""L3 — общий интерфейс упоминания: ENT-15 (показатель ТЭП) и ENT-16 (характеристика из текста) (T-178, TO-BE §7).

Одно упоминание — одно значение в одном месте документа с цитатой и рамкой. Все пути извлечения сводятся к `Mention`:

    tep_mentions(read: TableRead, lexicon=TEP_LEXICON) -> list[Mention]   # ENT-15 из строк ТЭП (L2)
    text_mentions(doc: ParsedDoc, patterns=TEXT_PATTERNS) -> list[Mention] # ENT-16 из текста общих данных
    from_extraction(e: Extraction, entity) -> Mention                    # class_mentions, quantity_mentions (T-129, T-132)
    to_extraction(m: Mention, code) -> Extraction                        # обратно в формат /analyze для API

Каноническое имя показателя (`key`) — по словарю синонимов (NRM-06: «Пятно застройки» → building_area). Строка ТЭП,
не совпавшая со словарём, даёт упоминание с key=None: оператор решает сам, а упоминание не теряется. Отсеянное
упоминание не удаляется — у него `excluded` (код) и `excluded_why` (причина), как у class_mentions.
Значение без цитаты-источника не выдаётся (ENT-16 каталога).
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel

from .class_mentions import _bbox, page_text
from .model import BBox, Extraction, ParsedDoc
from .normalize import fold, latinize_code
from .table_reader import TableRead, TableRow
from .tables import to_float

Entity = Literal["ENT-15", "ENT-16"]
QUOTE_MAX = 160
MAX_MENTIONS = 50  # на шаблон и страницу


class Mention(BaseModel):
    entity: Entity
    key: (
        str | None
    )  # канонический показатель или характеристика; None — не опознан словарём
    name: str  # как в документе: наименование строки ТЭП или оборот текста
    value_num: float | None = None
    value_range: tuple[float, float] | None = None
    value_text: str | None = None  # класс, марка, категория: «B25», «A500C», «II»
    unit: str | None = None
    column: str | None = None  # колонка ТЭП («Всего», «В т.ч. надземная часть»)
    section: str | None = None
    qualifier: str | None = None  # «min» — «не ниже», «max» — «не более»
    page: int
    bbox: BBox | None  # рамка значения
    anchor_bbox: BBox | None = None  # рамка наименования или оборота
    quote: str
    source: Literal["table", "text"]
    method: str  # table_reader | regex | class_mentions | quantity_mentions
    confidence: float
    excluded: str | None = None
    excluded_why: str | None = None
    param_code: str | None = (
        None  # код параметра Матрицы, если упоминание пришло по паспорту
    )


# ─────────────────────────────────────────────── ENT-15 показатели ТЭП

# ключ → (синонимы наименования, допустимые единицы). Синоним совпал, если каждое его слово — начало слова
# наименования (по первым STEM знакам): падежи и «объём/объем» не мешают.
TEP_LEXICON: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "building_area": (("площадь застройки", "пятно застройки"), ("м²", "га")),
    "total_area": (
        ("общая площадь здания", "общая площадь объекта", "общая площадь"),
        ("м²",),
    ),
    "useful_area": (("полезная площадь", "расчетная площадь"), ("м²",)),
    "apartments_area": (
        ("площадь квартир", "общая площадь квартир", "жилая площадь"),
        ("м²",),
    ),
    "site_area": (
        ("площадь участка", "площадь земельного участка", "площадь территории"),
        ("м²", "га"),
    ),
    "construction_volume": (("строительный объем",), ("м³",)),
    "floors": (("этажность", "количество этажей", "число этажей"), ("эт", "шт", "ед")),
    "height": (("высота здания", "высота"), ("м",)),
    "apartments": (("количество квартир", "число квартир"), ("шт", "ед", "кв")),
    "parking": (
        ("количество машино мест", "машино мест", "машиномест"),
        ("шт", "м/м", "ед"),
    ),
    "kz": (("коэффициент застройки", "процент застройки"), ("%", "ед")),
    "kit": (
        ("коэффициент использования территории", "коэффициент плотности застройки"),
        ("%", "ед"),
    ),
    "capacity": (("вместимость", "мощность", "количество мест"), ()),
    "power": (
        (
            "расчетная электрическая мощность",
            "электрическая мощность",
            "электрические нагрузки",
        ),
        ("квт", "мвт"),
    ),
    "water": (("водопотребление", "расход воды"), ("м³/сут", "м³/ч")),
    "heat": (("тепловая нагрузка", "расход тепла"), ("гкал/ч", "мвт", "квт")),
    "gas": (("расход газа",), ("м³/ч",)),
    "cost": (("сметная стоимость", "стоимость строительства"), ("тысруб", "руб")),
}
QUALIFIERS = (("above", r"надземн"), ("below", r"подземн"))
STEM = 5


def _stems(text: str) -> list[str]:
    return [w[:STEM] for w in fold(text).replace("ё", "е").split()]


def match_key(name: str, lexicon=TEP_LEXICON) -> tuple[str | None, int]:
    """Канонический ключ наименования: синоним, все слова которого есть в наименовании; при нескольких — самый
    длинный (конкретный): «Общая площадь квартир» → apartments_area, а не total_area. (ключ, число слов)."""
    words = set(_stems(name))
    best: tuple[int, str] | None = None
    for key, (syns, _) in lexicon.items():
        for s in syns:
            st = _stems(s)
            if (
                st
                and all(x in words for x in st)
                and (best is None or len(st) > best[0])
            ):
                best = (len(st), key)
    return (best[1], best[0]) if best else (None, 0)


def _qualified(key: str | None, name: str) -> str | None:
    if key is None:
        return None
    f = fold(name)
    for suffix, rx in QUALIFIERS:
        if re.search(rx, f):
            return f"{key}_{suffix}"
    return key


def tep_mentions(read: TableRead, lexicon=TEP_LEXICON) -> list[Mention]:
    """ENT-15: каждая строка ТЭП × каждая колонка значений с числом. Строка «в т.ч. надземной части» без своего
    показателя наследует показатель строки, к которой относится (строительный объём → construction_volume_above)."""
    out: list[Mention] = []
    by_index = {r.index: r for r in read.rows}
    for row in read.rows:
        key, _ = match_key(row.name, lexicon)
        if key is None and row.parent is not None:
            key, _ = match_key(by_index[row.parent].name, lexicon)
        key = _qualified(key, row.name)
        for v in row.values:
            if v.num is None and v.range is None:
                continue
            out.append(
                Mention(
                    entity="ENT-15",
                    key=key,
                    name=row.name,
                    value_num=v.num,
                    value_range=v.range,
                    unit=v.unit or row.unit,
                    column=v.column,
                    section=row.section,
                    page=read.page,
                    bbox=v.bbox,
                    anchor_bbox=row.bbox_name,
                    quote=_row_quote(row, v.raw),
                    source="table",
                    method="table_reader",
                    confidence=_conf(read, key, v.unit or row.unit, lexicon),
                    excluded="unit_mismatch"
                    if _unit_mismatch(key, v.unit or row.unit, lexicon)
                    else None,
                    excluded_why="единица строки не единица показателя"
                    if _unit_mismatch(key, v.unit or row.unit, lexicon)
                    else None,
                )
            )
    return out


def _base(key: str | None) -> str | None:
    return re.sub(r"_(above|below)$", "", key) if key else None


def _unit_mismatch(key: str | None, unit: str | None, lexicon) -> bool:
    base = _base(key)
    if base is None or unit is None or base not in lexicon:
        return False
    allowed = lexicon[base][1]
    return bool(allowed) and unit not in allowed


def _conf(read: TableRead, key: str | None, unit: str | None, lexicon) -> float:
    c = 1.0 if read.strategy == "lines" else 0.7
    if key is None:
        c *= 0.5
    if unit is None:
        c *= 0.8
    return round(c, 3)


def _row_quote(row: TableRow, raw: str) -> str:
    return " | ".join(x for x in (row.number, row.name, row.unit, raw) if x)[:QUOTE_MAX]


# ─────────────────────────────────────────────── ENT-16 характеристики из текста

_ROMAN = r"(?:IV|V|I{1,3}|І{1,3})"
# ключ → (оборот-якорь, значение); значение ищется от конца якоря в пределах WINDOW знаков
TEXT_PATTERNS: dict[str, tuple[str, str]] = {
    "concrete_class": (
        r"бетон\w{0,20}(?:\s+\w{1,30}){0,4}?\s+класс\w{0,20}|класс\w{0,20}\s+(?:тяж\w{1,30}\s+)?бетон\w{0,20}(?:\s+по\s+прочности(?:\s+на\s+сжатие)?)?",
        r"\b[BВ]\s?\d{1,3}(?:[.,]5)?\b",
    ),
    "rebar_class": (
        r"арматур\w{0,20}(?:\s+\w{1,30}){0,3}?\s+класс\w{0,20}|класс\w{0,20}\s+(?:\w{1,30}\s+)?арматур\w{0,20}",
        r"\b[AА]\s?-?\s?(?:\d{3}|I{1,3})\s?[CСН]?\b",
    ),
    "steel_grade": (
        r"стал\w{0,20}(?:\s+\w{1,30}){0,3}?\s+(?:марк\w{0,20}|класс\w{0,20})|марк\w{0,20}\s+стал\w{0,20}",
        r"\b[CС]\s?\d{3}(?:-\d)?\b",
    ),
    "fire_resistance": (
        r"степен\w{0,20}\s+огнестойкост\w{0,20}(?:\s+здания)?",
        r"\b" + _ROMAN + r"\b",
    ),
    "kpo_class": (
        r"класс\w{0,20}\s+конструктивной\s+пожарной\s+опасност\w{0,20}",
        r"\b[CС]\s?[0-3OО]\b",
    ),
    "energy_class": (
        r"класс\w{0,20}\s+энергетической\s+эффективност\w{0,20}(?:\s+здания)?",
        r"(?<![\w])[A-GА-Г]\+{0,3}(?![\w])",
    ),
    "reliability_category": (
        r"категори\w{0,20}\s+(?:по\s+)?(?:степени\s+)?надежност\w{0,20}(?:\s+электроснабжения)?",
        r"\b" + _ROMAN + r"\b|(?<![\d.,])[123](?![\d.,])",
    ),
    "zero_mark": (
        r"(?:отметк\w{0,20}|уровн\w{0,20})\s*[±]?\s*0[.,]000\s*(?:соответствует|принят\w{0,20}|равн\w{0,20}|=)?\s*(?:абсолютн\w{0,20}\s+отметк\w{0,20})?",
        r"[+-]?\d{2,3}[.,]\d{1,3}",
    ),
    "design_power": (
        r"расч[её]тн\w{0,20}\s+(?:электрическ\w{0,20}\s+)?(?:мощност\w{0,20}|нагрузк\w{0,20})",
        r"\d[\d\s]{0,6}(?:[.,]\d+)?\s*(?:кВт|МВт)",
    ),
}
WINDOW = 60
BEFORE_KEYS = {"fire_resistance", "reliability_category"}  # «II степени огнестойкости», «по II категории надёжности»


def _value_before(vrx: re.Pattern[str], text: str, start: int):
    """Значение прямо перед оборотом: последнее совпадение в 12 знаках до него, за которым только окончание («-й»)."""
    lo = max(0, start - 12)
    last = None
    for m in vrx.finditer(text, lo, start):
        if re.fullmatch(r"\s*(?:-?(?:й|ой|ей|я))?\s*", text[m.end() : start]):
            last = m
    return last
_MIN = re.compile(r"не\s+(?:ниже|менее)\s*$", re.I)
_MAX = re.compile(r"не\s+(?:выше|более)\s*$", re.I)
_EXCLUDE = (
    (
        "existing",
        r"существующ\w{0,20}|до\s+реконструкции",
        "относится к существующему положению",
    ),
    (
        "norm",
        r"по\s+(?:СП|ГОСТ|СНиП)\b|требуем\w{0,20}|допускается|нормативн\w{0,20}",
        "нормативное требование, а не значение объекта",
    ),
)
_CYR_ENERGY = str.maketrans(
    {"А": "A", "В": "B", "С": "C", "Д": "D", "Е": "E", "Г": "G"}
)


def _norm_value(key: str, raw: str) -> tuple[str | None, float | None, str | None]:
    """(текст, число, единица) значения характеристики."""
    s = re.sub(r"\s", "", raw)
    if key in ("concrete_class", "rebar_class", "steel_grade"):
        return latinize_code(s).replace("-", "").replace(",", "."), None, None
    if key == "kpo_class":
        return "С" + s[1:].replace("О", "0").replace("O", "0"), None, None
    if key in ("fire_resistance", "reliability_category"):
        t = s.replace("І", "I")
        t = {"1": "I", "2": "II", "3": "III"}.get(t, t)
        return t, None, None
    if key == "energy_class":
        return s.upper().translate(_CYR_ENERGY), None, None
    if key == "zero_mark":
        return None, to_float(s), "м"
    m = re.match(r"([\d.,]+)(кВт|МВт)", s)
    if m:
        return None, to_float(m.group(1)), m.group(2).lower()
    return s, None, None  # pragma: no cover — значения всех ключей разобраны выше


def text_mentions(
    doc: ParsedDoc, patterns: dict[str, tuple[str, str]] | None = None
) -> list[Mention]:
    """ENT-16: характеристики по шаблонам фраз «оборот → значение» во всём тексте документа; каждое упоминание —
    с цитатой, рамками значения и оборота; ограничение «не ниже» — qualifier, существующее и нормативное — отсев."""
    patterns = patterns or TEXT_PATTERNS
    out: list[Mention] = []
    for page in doc.pages:
        text, spans = page_text(page)
        conf = 1.0 if page.source != "ocr" else 0.8
        for key, (anchor, value) in patterns.items():
            vrx = re.compile(value)
            for i, a in enumerate(re.finditer(anchor, text, flags=re.I)):
                if i >= MAX_MENTIONS:
                    break  # упоминаний одной характеристики на странице — не больше MAX_MENTIONS (SEC-T178-05)
                m = _value_before(vrx, text, a.start()) if key in BEFORE_KEYS else None
                if m is None:
                    m = vrx.search(text, a.end(), min(len(text), a.end() + WINDOW))
                if m is None:
                    continue
                gap = text[a.end() : m.start()] if m.start() >= a.end() else ""
                if re.search(r"[.;]\s", gap):
                    continue  # значение в следующем предложении — не этого оборота
                dot = max(text.rfind(". ", 0, a.start()), text.rfind("; ", 0, a.start()))
                sent = dot + 2 if dot >= 0 else 0  # начало предложения оборота
                vt, vn, unit = _norm_value(key, m.group(0))
                before = text[max(0, a.start() - 40) : a.start()] + " " + gap
                qualifier = (
                    "min"
                    if _MIN.search(before.rstrip())
                    or re.search(r"не\s+(?:ниже|менее)", gap)
                    else (
                        "max"
                        if _MAX.search(before.rstrip())
                        or re.search(r"не\s+(?:выше|более)", gap)
                        else None
                    )
                )
                ctx = text[max(sent, a.start() - 80) : min(a.start(), m.start())]  # до оборота: «по ГОСТ» после значения — ссылка на изделие, а не норма
                ex = next(
                    (
                        (c, why)
                        for c, rx, why in _EXCLUDE
                        if re.search(rx, ctx, flags=re.I)
                    ),
                    None,
                )
                out.append(
                    Mention(
                        entity="ENT-16",
                        key=key,
                        name=a.group(0)[:QUOTE_MAX],
                        value_text=vt,
                        value_num=vn,
                        unit=unit,
                        qualifier=qualifier,
                        page=page.page,
                        bbox=_bbox(spans, m.start(), m.end()),
                        anchor_bbox=_bbox(spans, a.start(), a.end()),
                        quote=text[min(a.start(), m.start()) : max(m.end(), a.end())][:QUOTE_MAX],
                        source="text",
                        method="regex",
                        confidence=conf,
                        excluded=ex[0] if ex else None,
                        excluded_why=ex[1] if ex else None,
                    )
                )
    return out


# ─────────────────────────────────────────────── адаптеры


def from_extraction(e: Extraction, entity: Entity, key: str | None = None) -> Mention:
    """Упоминание class_mentions (ENT-16) или quantity_mentions (ENT-15) в общем виде; отсев и цитата сохраняются."""
    meta = e.meta or {}
    return Mention(
        entity=entity,
        key=key,
        name=e.line_text,
        value_num=e.value_num,
        value_text=e.value_text,
        qualifier=meta.get("qualifier"),
        page=e.page,
        bbox=e.bbox,
        anchor_bbox=e.anchor_bbox,
        quote=meta.get("quote") or e.line_text,
        source="table" if e.match == "table" else "text",
        method="class_mentions" if entity == "ENT-16" else "quantity_mentions",
        confidence=e.confidence,
        excluded=meta.get("excluded"),
        excluded_why=meta.get("excluded_why"),
        param_code=e.code,
    )


def to_extraction(m: Mention, code: str) -> Extraction:
    """Упоминание в формате извлечения /analyze: значение, рамки, цитата и отсев — в meta, как у class_mentions."""
    return Extraction(
        code=code,
        raw=m.value_text
        if m.value_text is not None
        else ("" if m.value_num is None else f"{m.value_num:g}"),
        value_num=m.value_num,
        value_text=m.value_text,
        page=m.page,
        bbox=m.bbox,
        anchor_bbox=m.anchor_bbox,
        line_text=m.quote,
        confidence=m.confidence,
        match="table" if m.source == "table" else "lexical",
        meta={
            "quote": m.quote,
            "qualifier": m.qualifier,
            "excluded": m.excluded,
            "excluded_why": m.excluded_why,
            "entity": m.entity,
            "key": m.key,
            "unit": m.unit,
            "column": m.column,
            "section": m.section,
            "ops": [m.entity, "NRM-06"] if m.entity == "ENT-15" else [m.entity],
        },
    )
