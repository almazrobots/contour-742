"""Таблицы векторного PDF: ячейки с координатами и связка строки «наименование — единица — значение» (OS-INSP-2.2.5).

Прототип T-127 (исследование мировых практик, RESEARCH-ALIGNMENT, ветка 4a): таблица ищется по сетке линий
(pdfplumber, lines-стратегия); таблица без рамок — по выравниванию текста (text-стратегия) с пониженной
уверенностью. Строка таблицы даёт кандидата, только если в ней есть все три части:
  • наименование — совпадает с якорем параметра Матрицы тем же механизмом, что в extract.py (normalize.fold);
  • единица — колонка «Ед. изм.», хвост наименования («Площадь (м²)», «…, м²») или хвост значения («12 м²»);
    она обязана быть единицей параметра по Матрице (или той же величины: мм ↔ м — с пересчётом);
  • значение — ячейка целиком число (десятичная запятая, пробелы-разделители тысяч) или диапазон.
Нет единицы или значение не число — кандидата нет: не выдумываем (OS-INSP-2.2.3).

Координаты — [x0, y0, x1, y1] в долях видимой страницы (после CropBox и /Rotate), начало — левый верхний угол,
как у parse.norm_box (OS-INSP-2.2.2): pdfminer отдаёт геометрию уже в повёрнутом пространстве, а
pdfplumber.Page.cropbox — видимую область в нём же.

pdfplumber работает на pdfminer (чистый Python) и pdfium не трогает — PDFIUM_LOCK здесь не нужен.
Подключение в extract.py — T-119: адаптер table_candidates + to_extraction.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import pdfplumber
from pdfplumber.utils import extract_text, extract_words
from pydantic import BaseModel

from .extract import ANCHOR_MIN, anchor_score
from .model import BBox, Extraction, ParamSpec, ParsedDoc
from .normalize import fold, nfc
from .parse import CorruptedFile, union

Strategy = Literal["lines", "text"]

# Сетка по линиям. Допуски 3 pt — стык линий, нарисованных отрезками (САПР рвёт рамку на куски).
LINES_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "intersection_tolerance": 3,
    "edge_min_length": 3,
}
# Без рамок: колонки — по выравниванию слов, строки — по строкам текста. Любой абзац тоже «таблица»,
# поэтому уверенность ниже, а связку всё равно проходят лишь строки с якорем, единицей и числом.
TEXT_SETTINGS = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text",
    "min_words_vertical": 2,
    "min_words_horizontal": 1,
    "text_x_tolerance": 1.5,
    "text_y_tolerance": 3,
}
STRATEGY_CONF = {"lines": 1.0, "text": 0.7}
ROLE_GUESS = 0.9  # колонки определены по типам ячеек, а не по шапке
CONVERTED = (
    0.95  # единица документа другая (мм при м по Матрице) — значение пересчитано
)
RANGE = 0.8  # значение — диапазон, а не одно число
MAX_EDGES = 20_000  # чертёж с сотнями тысяч отрезков: поиск сетки не запускается (правило №0 — время и RAM)
TEXT_X_TOL = 1.5  # просвет между глифами, дающий пробел: САПР ставит слова глифами без символа пробела

# ─────────────────────────────────────────────── нормализация ячеек

_SPACES = re.compile(r"[    \t]")
_WRAP_HYPHEN = re.compile(r"(\w)[-­]\n(\w)")


def normalize_cell(text: str | None) -> tuple[str, str]:
    """Текст ячейки → (основной, запасной). Перенос строки — пробел; дефис переноса в основном варианте
    снимается («застрой-\\nки» → «застройки»), в запасном остаётся («машино-\\nмест» → «машино-мест»):
    по тексту не различить перенос и дефис слова, якорь сверяется с обоими."""
    t = _SPACES.sub(" ", (text or "").replace("\r\n", "\n").replace("\r", "\n"))
    joined = _WRAP_HYPHEN.sub(r"\1\2", t)
    kept = _WRAP_HYPHEN.sub(r"\1-\2", t)
    return nfc(joined), nfc(kept)


# ─────────────────────────────────────────────── единицы измерения

# Синонимы после NFKC (м² → м2), нижнего регистра, без пробелов и точек
_ALIAS = {
    "м2": "м²",
    "m2": "м²",
    "квм": "м²",
    "мкв": "м²",
    "м3": "м³",
    "m3": "м³",
    "кубм": "м³",
    "мкуб": "м³",
    "мм2": "мм²",
    "mm2": "мм²",
    "см2": "см²",
    "m": "м",
    "пм": "м",
    "mm": "мм",
    "штук": "шт",
    "штуки": "шт",
    "шт": "шт",
    "компл": "компл",
    "этаж": "эт",
    "этажа": "эт",
    "этажей": "эт",
    "час": "ч",
    "дни": "дн",
    "дней": "дн",
    "дня": "дн",
    "человек": "чел",
    "квтч": "квт·ч",
    "тысруб": "тысруб",
}
_KNOWN = {
    "м²",
    "м³",
    "мм²",
    "см²",
    "га",
    "м",
    "мм",
    "см",
    "км",
    "шт",
    "ед",
    "эт",
    "компл",
    "%",
    "‰",
    "квт",
    "вт",
    "мвт",
    "гкал",
    "квт·ч",
    "ч",
    "сут",
    "л",
    "с",
    "чел",
    "мин",
    "дн",
    "т",
    "кг",
    "а",
    "ом",
    "па",
    "тысруб",
    "руб",
}
# Величина → (базовая единица, множитель): пересчёт только внутри одной величины
_FACTOR = {
    "м": ("м", 1.0),
    "мм": ("м", 1e-3),
    "см": ("м", 1e-2),
    "км": ("м", 1e3),
    "м²": ("м²", 1.0),
    "мм²": ("м²", 1e-6),
    "см²": ("м²", 1e-4),
    "га": ("м²", 1e4),
}
DIMENSIONLESS = (
    "ед"  # «ед.» Матрицы: счёт этажей — единица в таблице может отсутствовать
)
_COUNT_UNITS = {"ед", "эт", "шт"}


def canon_unit(s: str | None) -> str | None:
    """Единица измерения в канонической записи («м2», «кв. м» → «м²»; «м3/час» → «м³/ч») или None, если это не единица."""
    if not s:
        return None
    t = unicodedata.normalize("NFKC", s).lower()
    t = re.sub(r"\s+", "", t).strip("()[],;:").replace(".", "").replace("^", "")
    if not t:
        return None
    parts = [_ALIAS.get(p, p) for p in t.split("/")]
    return "/".join(parts) if all(p in _KNOWN for p in parts) else None


def column_unit(text: str | None) -> str | None:
    """Единица из колонки «Ед. изм.»: одиночная «2»/«3» — это «м²»/«м³», у которых буква «м» не попала в текстовый слой
    (ТЭП «Алтуфьево», ПЗ стр. 10: «Площадь застройки объекта | 2 | 3009.4»; OS-INSP-2.2.31, T-135)."""
    t = (text or "").strip()
    if t in ("2", "3"):
        return canon_unit("м" + t)
    return canon_unit(t)


def unit_options(matrix_unit: str | None) -> set[str]:
    """Допустимые единицы параметра по записи Матрицы: «шт. / м» → {шт, м}; «мм (слои)» → {мм}; «—» → пусто."""
    if not matrix_unit:
        return set()
    u = re.sub(r"\([^)]*\)", "", matrix_unit)
    return {c for c in (canon_unit(p) for p in re.split(r"\s+/\s+", u)) if c}


def match_unit(doc_unit: str | None, options: set[str]) -> tuple[str, float] | None:
    """Единица документа против единиц Матрицы → (единица Матрицы, множитель пересчёта) или None — отказ."""
    if doc_unit in options:
        return doc_unit, 1.0
    if DIMENSIONLESS in options and (doc_unit is None or doc_unit in _COUNT_UNITS):
        return DIMENSIONLESS, 1.0
    if doc_unit in _FACTOR:
        base, f = _FACTOR[doc_unit]
        for o in sorted(options):
            if o in _FACTOR and _FACTOR[o][0] == base:
                return o, f / _FACTOR[o][1]
    return None


# ─────────────────────────────────────────────── значения

_NUM = r"[-+−]?\d{1,3}(?: \d{3})+(?:[.,]\d+)?|[-+−]?\d+(?:[.,]\d+)?"
_SINGLE = re.compile(rf"^±?\s*({_NUM})\s*(.*)$")
_RANGE = re.compile(
    rf"^(?:от\s+)?({_NUM})\s*(?:\.\.\.?|…|÷|–|—|-|до)\s*({_NUM})\s*(.*)$", re.IGNORECASE
)


def to_float(raw: str) -> float:
    return float(raw.replace(" ", "").replace("−", "-").replace(",", "."))


@dataclass(frozen=True)
class Value:
    num: float | None  # одно число; у диапазона — None
    range: tuple[float, float] | None
    unit: str | None  # единица, приписанная к числу в той же ячейке


def parse_value(text: str) -> Value | None:
    """Ячейка целиком — число или диапазон, возможно с единицей в хвосте. Иначе (текст, ссылка, «—») — None."""
    t = nfc(text)
    for rx, is_range in ((_RANGE, True), (_SINGLE, False)):
        m = rx.match(t)
        if not m:
            continue
        tail = m.group(m.lastindex).strip()
        unit = canon_unit(tail)
        if tail and unit is None:
            continue  # хвост — не единица: «5 этаж секции 2», «12 (см. лист 3)»
        if is_range:
            lo, hi = to_float(m.group(1)), to_float(m.group(2))
            return Value(None, (min(lo, hi), max(lo, hi)), unit)
        return Value(to_float(m.group(1)), None, unit)
    return None


def split_name_unit(name: str) -> tuple[str, str | None]:
    """Единица в наименовании: «Площадь застройки, м²», «Площадь (м²)», «Объём (подземный), м³»."""
    m = re.match(r"^(.*?)\s*,\s*([^,]+)$", name)
    if m and canon_unit(m.group(2)):
        return m.group(1), canon_unit(m.group(2))
    m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", name)
    if m and canon_unit(m.group(2)):
        return m.group(1), canon_unit(m.group(2))
    return name, None


# ─────────────────────────────────────────────── таблицы страницы


@dataclass
class Cell:
    text: str
    alt: str  # запасной вариант текста: дефис переноса сохранён
    bbox: BBox  # доли видимой страницы
    row: int
    col: int
    rowspan: int = 1
    colspan: int = 1


@dataclass
class Table:
    page: int
    strategy: Strategy
    bbox: BBox
    grid: list[list[Cell | None]] = field(
        default_factory=list
    )  # объединённая ячейка — во всех своих позициях

    @property
    def n_cols(self) -> int:
        return len(self.grid[0]) if self.grid else 0


def _norm(
    box: tuple[float, float, float, float], vis: tuple[float, float, float, float]
) -> BBox:
    """(x0, top, x1, bottom) pdfplumber → доли видимой области (cropbox в повёрнутом пространстве)."""
    w, h = vis[2] - vis[0], vis[3] - vis[1]
    clip = lambda v: round(min(max(v, 0.0), 1.0), 5)
    return (
        clip((box[0] - vis[0]) / w),
        clip((box[1] - vis[1]) / h),
        clip((box[2] - vis[0]) / w),
        clip((box[3] - vis[1]) / h),
    )


def _edges(values: Iterable[float], tol: float = 1.0) -> list[float]:
    out: list[float] = []
    for v in sorted(values):
        if not out or v - out[-1] > tol:
            out.append(v)
    return out


def _index(edges: list[float], v: float) -> int:
    return min(range(len(edges)), key=lambda i: abs(edges[i] - v))


def _center_in(o: dict, box) -> bool:
    return box[0] <= (o["x0"] + o["x1"]) / 2 <= box[2] and box[1] <= (o["top"] + o["bottom"]) / 2 <= box[3]


def _build_lines(pl_table, page_chars: list[dict], vis, number: int) -> Table | None:
    """Таблица по сетке линий: ячейки pdfplumber, объединённая ячейка занимает все свои позиции сетки."""
    # ячейка вне видимой области (под CropBox) — не на листе
    cells = [c for c in pl_table.cells if _center_in(dict(zip(("x0", "top", "x1", "bottom"), c)), vis)]
    if not cells:
        return None
    xs = _edges([c[0] for c in cells] + [c[2] for c in cells])
    ys = _edges([c[1] for c in cells] + [c[3] for c in cells])
    if len(ys) < 3 or len(xs) < 3:
        return None
    tb = (min(c[0] for c in cells), min(c[1] for c in cells), max(c[2] for c in cells), max(c[3] for c in cells))
    inside = [ch for ch in page_chars if _center_in(ch, tb)]
    grid: list[list[Cell | None]] = [[None] * (len(xs) - 1) for _ in range(len(ys) - 1)]
    for c in cells:
        r0, r1 = _index(ys, c[1]), _index(ys, c[3])
        c0, c1 = _index(xs, c[0]), _index(xs, c[2])
        chars = [ch for ch in inside if _center_in(ch, c)]
        text, alt = normalize_cell(extract_text(chars, x_tolerance=TEXT_X_TOL))
        cell = Cell(text, alt, _norm(c, vis), r0, c0, r1 - r0, c1 - c0)
        # объединённая ячейка: значение растягивается на всю её область
        for r in range(r0, r1):
            for k in range(c0, c1):
                grid[r][k] = cell
    return Table(page=number, strategy="lines", bbox=_norm(tb, vis), grid=grid)


def _build_text(pl_table, page_chars: list[dict], vis, number: int) -> Table | None:
    """Таблица без рамок: строки — строки текста, колонки — полосы, которые не пересекает ни одно слово
    (просвет шире высоты строки). Ячейки text-стратегии pdfplumber режут слова по выравниванию соседних строк
    («Наименование показа|теля»), поэтому от неё берётся только область таблицы."""
    tb = pl_table.bbox
    words = [w for w in extract_words([ch for ch in page_chars if _center_in(ch, tb)], x_tolerance=TEXT_X_TOL) if _center_in(w, vis)]
    if not words:
        return None
    rows: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        mid = (w["top"] + w["bottom"]) / 2
        if rows and mid <= max(x["bottom"] for x in rows[-1]):
            rows[-1].append(w)
        else:
            rows.append([w])
    gap = sorted(w["bottom"] - w["top"] for w in words)[len(words) // 2]
    cols: list[list[float]] = []
    for w in sorted(words, key=lambda w: w["x0"]):
        if cols and w["x0"] - cols[-1][1] < gap:
            cols[-1][1] = max(cols[-1][1], w["x1"])
        else:
            cols.append([w["x0"], w["x1"]])
    if len(rows) < 2 or len(cols) < 2:
        return None
    grid: list[list[Cell | None]] = []
    for r, row in enumerate(rows):
        top, bottom = min(w["top"] for w in row), max(w["bottom"] for w in row)
        line: list[Cell | None] = []
        for k, (x0, x1) in enumerate(cols):
            text, alt = normalize_cell(" ".join(w["text"] for w in sorted(row, key=lambda w: w["x0"]) if x0 <= w["x0"] and w["x1"] <= x1))
            line.append(Cell(text, alt, _norm((x0, top, x1, bottom), vis), r, k))
        grid.append(line)
    box = (cols[0][0], rows[0][0]["top"], cols[-1][1], max(w["bottom"] for w in rows[-1]))
    return Table(page=number, strategy="text", bbox=_norm(box, vis), grid=grid)


# pdfminer поворачивает страницу этой матрицей (PDFPageInterpreter.process_page) — в её пространстве и
# координаты символов pdfplumber. Page.cropbox pdfplumber при /Rotate 90/270 лишь меняет x и y местами и при
# несимметричном CropBox сдвигает область на разницу полей — видимую область считаем сами.
def visible_box(page) -> tuple[float, float, float, float]:
    """Видимая область (CropBox после /Rotate) в координатах pdfplumber: (x0, top, x1, bottom)."""
    po = page.page_obj
    x0, y0, x1, y1 = po.mediabox
    a, b, c, d, e, f = {
        90: (0, -1, 1, 0, -y0, x1),
        180: (-1, 0, 0, -1, x1, y1),
        270: (0, 1, -1, 0, y1, -x0),
    }.get(po.rotate, (1, 0, 0, 1, -x0, -y0))  # pdfminer уже привёл /Rotate к 0…270
    cx0, cy0, cx1, cy1 = po.cropbox
    pts = [(a * x + c * y + e, b * x + d * y + f) for x in (cx0, cx1) for y in (cy0, cy1)]
    # pdfplumber сдвигает объекты на начало MediaBox (Page.process_object, pdfplumber #1181) — так же и область
    mx, mt = page.mediabox[:2]
    h = page.height
    return (min(p[0] for p in pts) + mx, h - max(p[1] for p in pts) + mt, max(p[0] for p in pts) + mx, h - min(p[1] for p in pts) + mt)


def page_tables(page, number: int) -> list[Table]:
    """Таблицы одной страницы pdfplumber: сначала по сетке линий; нет ни одной — по выравниванию текста."""
    if len(page.edges) > MAX_EDGES:
        return []
    vis = visible_box(page)
    chars = page.chars
    out = [t for t in (_build_lines(pt, chars, vis, number) for pt in page.find_tables(LINES_SETTINGS)) if t]
    if not out and chars:
        out = [t for t in (_build_text(pt, chars, vis, number) for pt in page.find_tables(TEXT_SETTINGS)) if t]
    return out


def read_tables(path: Path, pages: Iterable[int] | None = None) -> list[Table]:
    """Таблицы PDF по страницам (номера с 1). Кэш страницы сбрасывается сразу — память не копится по тому."""
    try:
        pdf = pdfplumber.open(str(path))
    except Exception as e:  # pdfminer бросает разнородные исключения на битом файле
        raise CorruptedFile(f"повреждённый PDF: {path.name}") from e
    out: list[Table] = []
    with pdf:
        wanted = (
            range(1, len(pdf.pages) + 1)
            if pages is None
            else [p for p in pages if 1 <= p <= len(pdf.pages)]
        )
        for n in wanted:
            page = pdf.pages[n - 1]
            out += page_tables(page, n)
            page.close()
    return out


# ─────────────────────────────────────────────── роли колонок

_ROLE_RX = (
    ("skip", re.compile(r"^(n|nn|номер)( п п)?$|^п п$")),
    ("unit", re.compile(r"ед\w* изм|единиц\w* измер|^ед$|^единица$")),
    ("value", re.compile(r"значени|величин|колич|кол во|^всего|^итого|по проекту")),
    ("name", re.compile(r"наименовани|показател|параметр")),
)


def header_role(text: str) -> str | None:
    if text.lstrip().startswith("№"):  # «№» — не буква: fold его стирает
        return "skip"
    f = fold(text)
    return next((role for role, rx in _ROLE_RX if rx.search(f)), None)


@dataclass(frozen=True)
class Roles:
    name: int
    value: int
    unit: int | None
    header_rows: (
        int  # сколько строк сверху — шапка (включая строку номеров колонок «1 2 3 4»)
    )
    from_header: bool


def _texts(row: list[Cell | None]) -> list[str]:
    return [c.text if c else "" for c in row]


def _is_numbering(row: list[Cell | None]) -> bool:
    """Строка номеров колонок под шапкой ГОСТ-таблицы: «1 | 2 | 3 | 4»."""
    vals = [t for t in _texts(row) if t]
    if len(vals) < 2 or not all(v.isdigit() for v in vals):
        return False
    first = int(vals[0])
    return vals == [str(first + i) for i in range(len(vals))]


def column_roles(t: Table) -> Roles | None:
    """Колонки наименования, единицы и значения: по шапке, если она есть; иначе — по типам ячеек."""
    roles: dict[int, str] = {}
    header_rows = 0
    for r, row in enumerate(t.grid[:3]):
        texts = _texts(row)
        found = {k: header_role(x) for k, x in enumerate(texts) if x}
        found = {k: v for k, v in found.items() if v}
        if len(set(found.values())) >= 2 and not any(
            parse_value(x) for x in texts if x
        ):
            for k, v in found.items():
                roles.setdefault(k, v)
            header_rows = r + 1
    while header_rows < len(t.grid) and _is_numbering(t.grid[header_rows]):
        header_rows += 1
    body = t.grid[header_rows:]
    n = t.n_cols
    num = [0] * n
    unit = [0] * n
    text = [0] * n
    filled = [0] * n
    for row in body:
        for k, c in enumerate(row):
            if not c or not c.text:
                continue
            filled[k] += 1
            if parse_value(c.text):
                num[k] += 1
            elif canon_unit(c.text):
                unit[k] += 1
            elif sum(ch.isalpha() for ch in c.text) >= 3:
                text[k] += 1
    by_role = {
        v: k for k, v in sorted(roles.items(), reverse=True)
    }  # при повторе роли — самая левая колонка
    name = by_role.get("name")
    if name is None:
        if not any(text):
            return None
        name = max(range(n), key=lambda k: (text[k], -k))
    u = by_role.get("unit")
    if u is None:
        cands = [
            k for k in range(n) if k != name and unit[k] and unit[k] * 2 >= filled[k]
        ]
        u = max(cands, key=lambda k: (unit[k], -k)) if cands else None
    value = by_role.get("value")
    if value is None:
        cands = [k for k in range(n) if k not in (name, u) and num[k]]
        right = [k for k in cands if k > name]
        pool = right or cands
        if not pool:
            return None
        value = max(pool, key=lambda k: (num[k] / filled[k], -k))
    if value == name:
        return None
    return Roles(
        name=name, value=value, unit=u, header_rows=header_rows, from_header=bool(roles)
    )


# ─────────────────────────────────────────────── связка строки (OS-INSP-2.2.5)


class TableCandidate(BaseModel):
    """Значение параметра из строки таблицы вместе с наименованием и единицей той же строки."""

    param_code: str
    value_raw: str
    value_num: (
        float | None
    )  # в единице Матрицы (пересчитано, если в документе мм, а в Матрице м)
    value_range: tuple[float, float] | None = None
    unit: str  # единица Матрицы, к которой приведено значение
    unit_doc: (
        str | None
    )  # единица, как она стоит в документе (канонически); None — у безразмерного «ед.»
    page: int
    bbox_cell: BBox
    bbox_row: BBox
    bbox_name: BBox
    name_text: str
    strategy: Strategy
    confidence: float


def _units_of(
    specs: list[ParamSpec], units: Mapping[str, str] | None
) -> dict[str, set[str]]:
    units = units or {}
    return {
        s.code: unit_options(units.get(s.code) or getattr(s, "unit", None))
        for s in specs
    }


def _eligible(spec: ParamSpec, opts: set[str]) -> bool:
    """Прототип связывает числовые параметры с единицей по Матрице; строковые и перечислимые — дело extract.py."""
    return spec.data_type == "number" and not spec.regex_pattern and bool(opts)


def _row_unit(
    row: list[Cell | None], roles: Roles, name: str, value: Value
) -> tuple[str, str | None]:
    """Единица строки: колонка «Ед. изм.» → хвост наименования → хвост значения. Возвращает и наименование без единицы."""
    bare, in_name = split_name_unit(name)
    col = row[roles.unit] if roles.unit is not None else None
    in_col = column_unit(col.text) if col and col.text else None
    return bare, in_col or in_name or value.unit


def _name_variants(
    t: Table, r: int, roles: Roles, orphans: set[int]
) -> list[tuple[str, list[Cell]]]:
    """Наименование строки и его склейки с соседними строками-продолжениями (перенос без рамок: вторая строка
    наименования — отдельная строка таблицы без значения)."""
    cell = t.grid[r][roles.name]
    if not cell or not cell.text:
        return []
    out = [(cell.text, [cell]), (cell.alt, [cell])]
    prev = t.grid[r - 1][roles.name] if r - 1 in orphans else None
    nxt = t.grid[r + 1][roles.name] if r + 1 in orphans else None
    if prev:
        out.append((f"{prev.text} {cell.text}", [prev, cell]))
    if nxt:
        out.append((f"{cell.text} {nxt.text}", [cell, nxt]))
    return out


def link_table(
    t: Table, specs: list[ParamSpec], units: Mapping[str, str] | None = None
) -> list[TableCandidate]:
    """Кандидаты из одной таблицы. Строка отдаёт значение одному параметру — тому, чей якорь совпал лучше и
    конкретнее (OS-INSP-2.2.10), среди параметров, чья единица сошлась с единицей строки."""
    roles = column_roles(t)
    if roles is None:
        return []
    opts = _units_of(specs, units)
    pool = [s for s in specs if _eligible(s, opts[s.code])]
    body = range(roles.header_rows, len(t.grid))

    def empty(r: int, k: int | None) -> bool:
        c = t.grid[r][k] if k is not None else None
        return not c or not c.text

    orphans = {
        r
        for r in body
        if not empty(r, roles.name) and empty(r, roles.value) and empty(r, roles.unit)
    }
    out: dict[tuple[str, int], TableCandidate] = {}
    for r in body:
        row = t.grid[r]
        vcell = row[roles.value]
        value = parse_value(vcell.text) if vcell and vcell.text else None
        if value is None or vcell is row[roles.name]:
            continue
        best: (
            tuple[tuple[float, int], ParamSpec, list[Cell], str, tuple[str, float]]
            | None
        ) = None
        for text, cells in _name_variants(t, r, roles, orphans):
            bare, doc_unit = _row_unit(row, roles, text, value)
            for spec in pool:
                target = match_unit(doc_unit, opts[spec.code])
                if target is None:
                    continue  # единица строки — не единица параметра (или её нет): отказ
                claim = max((anchor_score(a, bare), len(a)) for a in spec.anchors)
                if claim[0] >= ANCHOR_MIN and (best is None or claim > best[0]):
                    best = (claim, spec, cells, doc_unit, target)
        if best is None:
            continue
        (score, _), spec, cells, doc_unit, (unit, factor) = best
        conf = score / 100 * STRATEGY_CONF[t.strategy]
        conf *= 1.0 if roles.from_header else ROLE_GUESS
        conf *= 1.0 if factor == 1.0 else CONVERTED
        conf *= RANGE if value.range else 1.0
        cand = TableCandidate(
            param_code=spec.code,
            value_raw=vcell.text,
            value_num=None if value.num is None else round(value.num * factor, 9),
            value_range=None
            if value.range is None
            else (round(value.range[0] * factor, 9), round(value.range[1] * factor, 9)),
            unit=unit,
            unit_doc=doc_unit,
            page=t.page,
            bbox_cell=vcell.bbox,
            bbox_row=union([c.bbox for c in row if c]),
            bbox_name=union([c.bbox for c in cells]),
            name_text=" ".join(c.text for c in cells),
            strategy=t.strategy,
            confidence=round(conf, 3),
        )
        key = (
            spec.code,
            id(vcell),
        )  # объединённая ячейка значения в нескольких строках — один кандидат
        if key not in out or cand.confidence > out[key].confidence:
            out[key] = cand
    return list(out.values())


def table_candidates(
    path: Path,
    specs: list[ParamSpec],
    units: Mapping[str, str] | None = None,
    pages: Iterable[int] | None = None,
) -> list[TableCandidate]:
    """Адаптер для extract.py (T-119): все кандидаты «параметр — значение — единица» из таблиц PDF.
    units — единицы Матрицы по коду параметра (ParamSpec пока без поля unit)."""
    return [c for t in read_tables(path, pages) for c in link_table(t, specs, units)]


def best_by_param(cands: list[TableCandidate]) -> dict[str, TableCandidate]:
    """Лучший кандидат на параметр; при равной уверенности — более ранняя страница."""
    out: dict[str, TableCandidate] = {}
    for c in sorted(cands, key=lambda c: (-c.confidence, c.page)):
        out.setdefault(c.param_code, c)
    return out


def to_extraction(c: TableCandidate) -> Extraction:
    """Кандидат таблицы в формате извлечения extract.py: bbox — ячейка значения, anchor_bbox — ячейка наименования."""
    return Extraction(
        code=c.param_code,
        raw=c.value_raw,
        value_num=c.value_num,
        page=c.page,
        bbox=c.bbox_cell,
        anchor_bbox=c.bbox_name,
        line_text=f"{c.name_text} | {c.unit_doc or ''} | {c.value_raw}",
        confidence=c.confidence,
        match="table",
    )


# ─────────────────────────────────────────────── таблицы в конвейере (T-135: OS-INSP-2.2.5, 2.2.30)

TABLE_PAGE_CAP = 40  # листов с шапкой таблицы на документ: pdfplumber (чистый Python) не должен читать весь пакет


def table_pages(doc: ParsedDoc) -> list[int]:
    """Листы с текстовым слоем, где у таблицы есть колонка единицы измерения («Ед. изм.»): самые полные шапки — первыми,
    не больше TABLE_PAGE_CAP. Без колонки единицы строку всё равно нельзя связать с Матрицей, а «наименование» и
    «количество» без неё — это штампы и спецификации («Алтуфьево»: 1 331 лист против 150 с колонкой единицы, T-135).
    Скан пропускается: у pdfplumber нет текста без текстового слоя."""
    scored = []
    for p in doc.pages:
        if p.source != "text":
            continue
        roles = {header_role(ln.text) for ln in p.lines} - {None, "skip"}
        if "unit" in roles:
            scored.append((-len(roles), p.page))
    return [n for _, n in sorted(scored)[:TABLE_PAGE_CAP]]


def choose(line: Extraction | None, cand: TableCandidate) -> Extraction:
    """OS-INSP-2.2.30: значение строки текста или строки таблицы — более уверенное, при равной уверенности — табличное
    (у таблицы наименование и единица той же строки проверены по Матрице)."""
    if line is not None and line.confidence > cand.confidence:
        return line
    return to_extraction(cand)


def _table_eligible(spec: ParamSpec) -> bool:
    # параметр с паспортом (класс, количество) — у своего извлекателя; строковые и перечислимые — у extract.py
    return not spec.extractor and spec.data_type == "number" and not spec.regex_pattern and bool(spec.unit)


def merge_tables(path: Path | None, doc: ParsedDoc, specs: list[ParamSpec], extractions: list[Extraction]) -> list[Extraction]:
    """Свести извлечения строк текста с кандидатами из таблиц PDF (OS-INSP-2.2.5, 2.2.30). Не PDF, нет файла, нет листов
    с шапкой или нет числовых параметров с единицей — извлечения как были."""
    pool = [s for s in specs if _table_eligible(s)]
    if doc.kind != "pdf" or path is None or not pool:
        return extractions
    pages = table_pages(doc)
    if not pages:
        return extractions
    best = best_by_param(table_candidates(path, pool, {s.code: s.unit for s in pool}, pages=pages))
    if not best:
        return extractions
    out: list[Extraction] = []
    done: set[str] = set()
    for e in extractions:
        if e.code in best and e.code not in done:
            out.append(choose(e, best[e.code]))
            done.add(e.code)
        elif e.code not in best:
            out.append(e)
    out += [to_extraction(c) for code, c in best.items() if code not in done]
    return out
