"""L2 — общий читатель таблиц ТЭП и экспликаций (T-178; каталог TO-BE §6 PRM-19, §7 ENT-02, ENT-15).

Поверх модуля таблиц `tables` (T-127/T-135: сетка ячеек pdfplumber, слитые ячейки, нормализация текста ячейки,
единицы и числа). Там связка строки заточена под одно значение одного параметра Матрицы; здесь таблица читается
целиком — для операторов T-173…T-175 (CMP-01/02/03/10/07/11), которым нужны все колонки и итоги:

    read_table(t: tables.Table) -> TableRead          # строки: наименование, единица, значения по колонкам, итог
    read_doc_tables(path, doc, pages=None) -> list[TableRead]
    labeled_cells(read) / find_cells(reads, column=…, row=…) -> list[LabeledCell]   # ячейка + подпись колонки + строки
    check_totals(read) -> list[TotalCheck]            # сумма строк против «Итого»/«Всего» (сигнал CMP-30)
    explication_rows(read) -> list[RoomRow]           # экспликация: номер, наименование, площадь, категория, раздел

Строка → `TableRow`: name (перенос строки — пробел, дефис переноса снят), unit (колонка «Ед. изм.» → хвост
наименования → единица шапки колонки → хвост числа), values (по одной `ValueCell` на колонку значений: заголовок
колонки, число или диапазон, исходный текст, рамка), total («Итого», «Всего»), section (строка-раздел выше: «1 этаж»),
parent (строка «в т.ч. …» — индекс строки, к которой она относится). Число не выдумывается: ячейка «—» или текст —
`num=None`, текст сохраняется.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

import pdfplumber
from pdfplumber.utils import extract_words
from pydantic import BaseModel

from .model import BBox, ParsedDoc
from .normalize import fold as _fold
from .parse import CorruptedFile, union
from .tables import (
    TABLE_PAGE_CAP,
    TEXT_X_TOL,
    normalize_cell,
    page_tables,
    visible_box,
    Cell,
    Table,
    canon_unit,
    column_unit,
    header_role,
    parse_value,
    split_name_unit,
)

def fold(s: str) -> str:
    """normalize.fold с одной серией пробелов (SEC-T178-02: заполнитель «......» не даёт перебора в регулярках)."""
    return re.sub(r"\s+", " ", _fold(s))


MAX_HEADER_ROWS = 4
TOTAL_RE = re.compile(r"^(итого|всего|итог)\b")
SUB_RE = re.compile(r"^(в т ч|в том числе|из них|включая)\b")
STRONG_SECTION_RE = re.compile(
    r"^(?:\d{1,3}\s*(?:й|ый|ой|ий)?\s*)?(?:этаж|подвал|цоколь|техническ|чердак|кровл|мансард|секци|корпус|блок|раздел|пристро|встроен)"
    r"|этаж\w{0,20}$|^(?:жилая|нежилая|подземная|надземная|общественная)\s+част"
)
SECTION_MAX = 80  # строка-раздел таблицы по сетке не длиннее: длинная строка без чисел — примечание, а не раздел
NUMBER_COL_RE = re.compile(r"^(n|nn|номер|поз|позиция|п п)\b")
ROOM_NO_RE = re.compile(r"^\d{1,4}(?:[.\-]\d{1,3})?[а-яa-z]?$")
_NUMTOK = re.compile(r"^[-+−]?\d+(?:[.,]\d+)?$|^[—–-]$")
DASHES = {"—", "–", "-", "−"}  # пустая ячейка таблицы
MAX_SPLIT_WORDS = 20_000  # слов в слипшемся теле таблицы (SEC-T178-07)
TOTAL_TOL = 0.05  # допуск суммы: округление площадей до 0,1 м² в строках экспликации
Role = Literal["number", "name", "unit", "value", "text"]


class ValueCell(BaseModel):
    column: str  # заголовок колонки (склейка строк шапки через « · »), без шапки — «колонка N»
    col: int
    raw: str
    num: float | None = None
    range: tuple[float, float] | None = None
    unit: str | None = None  # единица значения: шапка колонки, иначе единица строки
    bbox: BBox | None = None


class TableRow(BaseModel):
    index: int  # номер строки тела по порядку (0…)
    number: str | None = None  # «№ п/п», номер помещения
    name: str
    unit: str | None = None
    values: list[ValueCell] = []
    texts: dict[str, str] = {}  # текстовые колонки: «Категория», «Примечание»
    text_cells: list[ValueCell] = []  # те же ячейки текстовых колонок с рамками (класс «A500C» в колонке «Класс арматуры»)
    total: bool = False
    section: str | None = None
    parent: int | None = None  # строка «в т.ч.» — индекс строки, к которой относится
    bbox_row: BBox | None = None
    bbox_name: BBox | None = None


class ColumnHead(BaseModel):
    col: int
    title: str
    role: Role
    unit: str | None = None


class TableRead(BaseModel):
    page: int
    kind: Literal["tep", "explication", "other"]
    bbox: BBox
    strategy: str
    header_rows: int
    columns: list[ColumnHead]
    rows: list[TableRow]
    sections: list[str] = []

    @property
    def value_columns(self) -> list[ColumnHead]:
        return [c for c in self.columns if c.role == "value"]


# ─────────────────────────────────────────────── шапка


def _uniq(row: list[Cell | None]) -> list[Cell]:
    seen: set[int] = set()
    out = []
    for c in row:
        if c is not None and id(c) not in seen and c.text:
            seen.add(id(c))
            out.append(c)
    return out


def _is_numbering(row: list[Cell | None]) -> bool:
    vals = [c.text for c in _uniq(row)]
    if len(vals) < 2 or not all(re.fullmatch(r"\d{1,3}", v) for v in vals):  # «²».isdigit() — но не число (SEC-T178-03)
        return False
    return vals == [str(int(vals[0]) + i) for i in range(len(vals))]


def _is_header(row: list[Cell | None]) -> bool:
    cells = _uniq(row)
    if len(cells) < 2:
        return False
    return (
        not any(parse_value(c.text) or _numbers(c.text) >= 2 for c in cells)
        and any(sum(ch.isalpha() for ch in c.text) >= 2 for c in cells)
    )


def _numbers(text: str) -> int:
    """Сколько отдельных чисел и прочерков в ячейке: у слипшейся строки тела их несколько."""
    return sum(bool(_NUMTOK.match(x)) for x in text.split())


def _is_header_tail(row: list[Cell | None]) -> bool:
    cells = _uniq(row)
    return bool(cells) and all(c.text[:1].islower() and not _numbers(c.text) and not parse_value(c.text) for c in cells)


def header_rows(t: Table) -> int:
    """Строки шапки сверху (до MAX_HEADER_ROWS) и строка нумерации колонок «1 2 3 4» под ней."""
    n = 0
    while n < min(MAX_HEADER_ROWS, len(t.grid)) and _is_header(t.grid[n]):
        n += 1
    while 0 < n < len(t.grid) and _is_header_tail(t.grid[n]):
        n += 1  # вторая строка подписи колонки в таблице без рамок: «Наименование» / «показателя»
    while n < len(t.grid) and _is_numbering(t.grid[n]):
        n += 1
    return n


def _col_title(t: Table, k: int, h: int) -> str:
    parts: list[str] = []
    seen: set[int] = set()
    for r in range(h):
        c = t.grid[r][k]
        if c is None or id(c) in seen or not c.text or _is_numbering(t.grid[r]):
            continue
        seen.add(id(c))
        parts.append(c.text)
    return " · ".join(parts)


def _title_unit(title: str) -> str | None:
    for part in reversed(title.split(" · ")):
        _, u = split_name_unit(part)
        if u:
            return u
        m = re.search(r"\b(?:в|,)\s*([^\s,()]+)\s*$", part)
        if m and canon_unit(m.group(1)):
            return canon_unit(m.group(1))
    return None


def _role(title: str) -> Role | None:
    if title.lstrip().startswith("№"):
        return "number"
    f = fold(title)
    if NUMBER_COL_RE.search(f) and "наимен" not in f:
        return "number"
    r = header_role(title)
    if r in ("unit", "value"):
        return r
    if r == "name" or re.search(r"наименовани|показател|параметр", f):
        return "name"
    return None


def _body_stats(t: Table, h: int, k: int) -> tuple[int, int, int, int, int]:
    num = unit = text = filled = small = 0
    for r in range(h, len(t.grid)):
        c = t.grid[r][k]
        if c is None or not c.text or c.row != r or c.col != k or c.text.strip() in DASHES:
            continue
        filled += 1
        v = parse_value(c.text)
        if v:
            num += 1
            small += bool(ROOM_NO_RE.match(c.text.strip()) and v.unit is None)
        elif column_unit(c.text):
            unit += 1
        elif sum(ch.isalpha() for ch in c.text) >= 3:
            text += 1
        if ROOM_NO_RE.match(c.text.strip()) and not v:
            small += 1
    return num, unit, text, filled, small


def columns(t: Table, h: int) -> list[ColumnHead]:
    """Роли колонок: по шапке (№, наименование, ед. изм.), остальные — по содержимому: числа → значение."""
    n = t.n_cols
    titles = [_col_title(t, k, h) for k in range(n)]
    # колонка, слитая со своей соседкой по всей высоте, — одна колонка: берётся левая
    roles: list[Role | None] = [_role(x) if x else None for x in titles]
    first = roles.index("name") if "name" in roles else None
    roles = [None if x == "name" and k != first else x for k, x in enumerate(roles)]  # «Показатель» правее наименования — по содержимому
    stats = [_body_stats(t, h, k) for k in range(n)]
    if "name" not in roles:
        cands = [k for k in range(n) if roles[k] is None and stats[k][2]]
        if cands:
            roles[max(cands, key=lambda k: (stats[k][2], -k))] = "name"
    name = roles.index("name") if "name" in roles else None
    for k in range(n):
        if roles[k] is not None:
            continue
        num, unit, text, filled, small = stats[k]
        if not filled:
            roles[k] = (
                "value"
                if header_role(titles[k]) == "value" or _title_unit(titles[k])
                else "text"
            )
        elif unit * 2 >= filled and "unit" not in roles:
            roles[k] = "unit"
        elif name is not None and k < name and small * 2 >= filled:
            roles[k] = "number"
        elif num * 2 >= filled:
            roles[k] = "value"
        else:
            roles[k] = "text"
    return [
        ColumnHead(
            col=k,
            title=titles[k] or f"колонка {k + 1}",
            role=roles[k] or "text",
            unit=_title_unit(titles[k]) if roles[k] == "value" else None,
        )
        for k in range(n)
    ]


def _kind(cols: list[ColumnHead], rows: list[TableRow]) -> str:
    head = fold(" ".join(c.title for c in cols))
    if re.search(r"помещени|экспликац|категори|квартир|\bкв\b", head) or any(
        c.role == "number" and re.search(r"помещ", fold(c.title)) for c in cols
    ):
        return "explication"
    if re.search(r"показател|ед изм|технико", head):
        return "tep"
    return "other"


# ─────────────────────────────────────────────── тело


def _cell(t: Table, r: int, k: int | None) -> Cell | None:
    if k is None:
        return None
    c = t.grid[r][k]
    return c if c is not None and c.text else None


def _own(t: Table, r: int, k: int, cols: list[ColumnHead]) -> Cell | None:
    """Ячейка значения, которой владеет строка r колонки k: слитая по вертикали — только первой строке,
    слитая по горизонтали — только первой колонке значений."""
    c = _cell(t, r, k)
    if c is None or c.row != r or c.col != k:
        return None  # слитая ячейка принадлежит своей первой строке и первой колонке
    return c


def skip_caption(t: Table) -> Table:
    """Строки с одной ячейкой над шапкой — заголовок таблицы («Технико-экономические показатели»), а не раздел:
    отбрасываются, если под ними шапка."""
    lead = 0
    while lead < len(t.grid) - 1 and len(_uniq(t.grid[lead])) <= 1:
        lead += 1
    if not lead:
        return t
    rest = Table(page=t.page, strategy=t.strategy, bbox=t.bbox, grid=shift_rows(t.grid[lead:], lead))
    return rest if header_rows(rest) else t


def shift_rows(grid: list[list[Cell | None]], by: int) -> list[list[Cell | None]]:
    """Сетка без первых строк: номера строк ячеек сдвигаются, слитая ячейка остаётся одним объектом."""
    new: dict[int, Cell] = {}
    out = []
    for row in grid:
        line: list[Cell | None] = []
        for c in row:
            if c is not None and id(c) not in new:
                new[id(c)] = Cell(c.text, c.alt, c.bbox, max(0, c.row - by), c.col, c.rowspan, c.colspan)
            line.append(new[id(c)] if c is not None else None)
        out.append(line)
    return out


def merge_split_columns(t: Table, h: int) -> Table:
    """Таблица без рамок: заголовок по центру колонки и значения от её левого края дают по выравниванию текста две
    колонки — одну только с шапкой, другую только с телом. Такие соседние колонки сливаются в одну."""
    grid = [list(row) for row in t.grid]

    def texts(k: int, rows: range) -> bool:
        return any(grid[r][k] is not None and grid[r][k].text for r in rows)

    head, body = range(h), range(h, len(grid))
    k = 0
    while k + 1 < len(grid[0]):
        a_head, a_body, b_head, b_body = texts(k, head), texts(k, body), texts(k + 1, head), texts(k + 1, body)
        if (a_head and not a_body and b_body and not b_head) or (a_body and not a_head and b_head and not b_body):
            for row in grid:
                x, y = row[k], row[k + 1]
                keep = x if x is not None and x.text else y
                if keep is not None:
                    boxes = [c.bbox for c in (x, y) if c is not None]
                    keep = Cell(keep.text, keep.alt, union(boxes), keep.row, k, keep.rowspan, 1)
                row[k : k + 2] = [keep]
            continue
        k += 1
    return Table(page=t.page, strategy=t.strategy, bbox=t.bbox, grid=grid)


def read_table(t: Table) -> TableRead | None:
    """Прочитать таблицу целиком. Нет колонки наименования — None (это не таблица показателей)."""
    if not t.grid or t.n_cols < 2:
        return None
    t = skip_caption(t)
    h = header_rows(t)
    if t.strategy == "text" and h:
        t = merge_split_columns(t, h)
    cols = columns(t, h)
    role = {c.col: c.role for c in cols}
    name_k = next((c.col for c in cols if c.role == "name"), None)
    if name_k is None:
        return None
    unit_k = next((c.col for c in cols if c.role == "unit"), None)
    num_k = next((c.col for c in cols if c.role == "number"), None)
    value_ks = [c.col for c in cols if c.role == "value"]
    text_ks = [c.col for c in cols if c.role == "text"]
    raw: list[dict] = []
    for r in range(h, len(t.grid)):
        row = t.grid[r]
        if not _uniq(row) or _is_numbering(row):
            continue
        uniq = _uniq(row)
        if len(uniq) == 1 and sum(ch.isalpha() for ch in uniq[0].text) >= 3:
            # одна ячейка на всю строку (раздел «1 этаж», слитый по ширине) или перенос наименования
            raw.append(
                {
                    "r": r,
                    "name": uniq[0],
                    "number": None,
                    "unit": None,
                    "values": {k: None for k in value_ks},
                    "texts": {},
                    "cells": uniq,
                }
            )
            continue
        name_c = _cell(t, r, name_k)
        if name_c is not None and name_c.row != r:
            name_c = None  # наименование, слитое по вертикали, уже отдано первой строке
        vals = {k: _own(t, r, k, cols) for k in value_ks}
        raw.append(
            {
                "r": r,
                "name": name_c,
                "number": _cell(t, r, num_k),
                "unit": _cell(t, r, unit_k),
                "values": vals,
                "texts": {
                    cols[k].title: c
                    for k in text_ks
                    if (c := _cell(t, r, k)) is not None and c.row == r and c.col == k
                },
                "cells": _uniq(row),
            }
        )
    rows, sections = _assemble(raw, cols, t.strategy)
    return TableRead(
        page=t.page,
        kind=_kind(cols, rows),
        bbox=t.bbox,
        strategy=t.strategy,
        header_rows=h,
        columns=cols,
        rows=rows,
        sections=sections,
    )


def _has_values(x: dict) -> bool:
    return any(c is not None for c in x["values"].values())


def _is_orphan(x: dict) -> bool:
    """Строка с одним наименованием: раздел или перенос. Итог без чисел («Итого» с пустыми ячейками) — строка данных."""
    return (
        x["name"] is not None
        and not TOTAL_RE.match(fold(x["name"].text))
        and not _has_values(x)
        and x["unit"] is None
        and x["number"] is None
        and not x["texts"]
    )


def _is_section(text: str, strategy: str) -> bool:
    """Строка-раздел: явный оборот («1 этаж», «Секция 2», «Жилая часть») или двоеточие в конце; в таблице по сетке
    линий — любая строка с одним наименованием (перенос наименования там остаётся внутри ячейки)."""
    f = fold(text)
    if STRONG_SECTION_RE.search(f) or text.rstrip().endswith(":"):
        return True
    return strategy == "lines" and len(text) <= SECTION_MAX


def join_parts(texts: list[str]) -> str:
    """Склейка строк наименования: перенос с дефисом перед строчной буквой — слово целиком («застрой-» + «ки»)."""
    out = ""
    for t in (x.strip() for x in texts):
        if not t:
            continue
        if out.endswith("-") and t[:1].islower() and len(out) > 1 and out[-2].isalpha():
            out = out[:-1] + t
        else:
            out = f"{out} {t}" if out else t
    return out


_JOINERS = {"и", "в", "на", "по", "с", "для", "из", "от", "к", "без", "до"}


def _continues(prev: dict, text: str) -> bool:
    """Строка без значений продолжает наименование предыдущей строки: начинается строчной буквой или скобкой,
    либо предыдущее наименование оборвано дефисом или предлогом."""
    if text[:1].islower() or text[:1] in '(«"':
        return True
    last = ([c.text for c in [prev["name"], *prev["extra"]] if c] or [""])[-1].rstrip()
    return last.endswith(("-", ",")) or (last.split() or [""])[-1].lower() in _JOINERS


def _assemble(
    raw: list[dict], cols: list[ColumnHead], strategy: str = "lines"
) -> tuple[list[TableRow], list[str]]:
    """Строки-продолжения наименования (перенос без рамки) склеиваются с соседней строкой, строки-разделы
    («1 этаж», «Секция 2») задают раздел последующих строк."""
    merged: list[dict] = []
    pending: list[Cell] = []
    for i, x in enumerate(raw):
        if _is_orphan(x):
            text = x["name"].text
            f = fold(text)
            nxt = raw[i + 1] if i + 1 < len(raw) else None
            if (
                merged
                and merged[-1]["kind"] == "data"
                and _continues(merged[-1], text)
                and not pending
            ):
                merged[-1]["extra"].append(
                    x["name"]
                )  # хвост наименования предыдущей строки
                merged[-1]["cells"] += x["cells"]
            elif _is_section(text, strategy) and not pending:
                merged.append({"kind": "section", "text": text.rstrip(" :")})
            elif nxt is not None and not _is_orphan(nxt):
                pending.append(x["name"])  # начало наименования следующей строки
            else:
                merged.append(
                    {
                        "kind": "section",
                        "text": join_parts([c.text for c in pending] + [text]).rstrip(
                            " :"
                        ),
                    }
                )
                pending = []
            continue
        if x["name"] is None and not _has_values(x):
            continue
        merged.append({"kind": "data", **x, "prefix": pending, "extra": []})
        pending = []
    rows: list[TableRow] = []
    sections: list[str] = []
    section: str | None = None
    head: int | None = None
    for m in merged:
        if m["kind"] == "section":
            section = m["text"]
            sections.append(section)
            continue
        parts = [*m["prefix"], *([m["name"]] if m["name"] else []), *m["extra"]]
        full = join_parts([c.text for c in parts])
        bare, name_unit = split_name_unit(full)
        unit_c = m["unit"]
        row_unit = (column_unit(unit_c.text) if unit_c else None) or name_unit
        values: list[ValueCell] = []
        for k, c in m["values"].items():
            head_col = cols[k]
            if c is None:
                values.append(
                    ValueCell(
                        column=head_col.title,
                        col=k,
                        raw="",
                        unit=head_col.unit or row_unit,
                    )
                )
                continue
            v = parse_value(c.text)
            values.append(
                ValueCell(
                    column=head_col.title,
                    col=k,
                    raw=c.text,
                    num=v.num if v else None,
                    range=v.range if v else None,
                    unit=head_col.unit or row_unit or (v.unit if v else None),
                    bbox=c.bbox,
                )
            )
        if row_unit is None:
            tails = {v.unit for v in values if v.raw and v.unit}  # единица шапки или хвоста заполненных ячеек
            row_unit = tails.pop() if len(tails) == 1 else None
        f = fold(bare)
        is_total = bool(TOTAL_RE.match(f)) or bool(
            m["number"] and TOTAL_RE.match(fold(m["number"].text))
        )
        sub = bool(SUB_RE.match(f))
        idx = len(rows)
        rows.append(
            TableRow(
                index=idx,
                number=m["number"].text if m["number"] else None,
                name=bare,
                unit=row_unit,
                values=values,
                texts={k: c.text for k, c in m["texts"].items()},
                text_cells=[ValueCell(column=k, col=c.col, raw=c.text, unit=None, bbox=c.bbox) for k, c in m["texts"].items()],
                total=is_total,
                section=section,
                parent=head if sub else None,
                bbox_row=union([c.bbox for c in m["cells"]]),
                bbox_name=union([c.bbox for c in parts]) if parts else None,
            )
        )
        if not sub and not is_total:
            head = idx
    return rows, sections


# ─────────────────────────────────────────────── итоги и экспликация


class TotalCheck(BaseModel):
    row: int
    column: str
    stated: float
    summed: float
    rows: list[int]
    ok: bool


def check_totals(read: TableRead) -> list[TotalCheck]:
    """«Итого…» — сумма строк своего раздела после предыдущего итога; «Всего» — сумма всех строк-данных таблицы.
    Строки «в т.ч.» в сумму не входят."""
    out: list[TotalCheck] = []
    start = 0
    for row in read.rows:
        if not row.total:
            continue
        whole = fold(row.name).startswith("всего")
        pool = [
            r
            for r in read.rows[: row.index]
            if not r.total
            and r.parent is None
            and (whole or (r.index >= start and r.section == row.section))
        ]
        for i, v in enumerate(row.values):
            if v.num is None:
                continue
            nums = [
                r.values[i].num
                for r in pool
                if i < len(r.values) and r.values[i].num is not None
            ]
            if not nums:
                continue
            s = round(sum(nums), 6)
            out.append(
                TotalCheck(
                    row=row.index,
                    column=v.column,
                    stated=v.num,
                    summed=s,
                    rows=[r.index for r in pool],
                    ok=abs(s - v.num) <= TOTAL_TOL + 1e-3 * abs(v.num),
                )
            )
        start = row.index + 1
    return out


class LabeledCell(BaseModel):
    """Значение ячейки с подписью колонки из шапки и подписью строки — общий вход экстракторов (T-172 шкалы в колонке,
    T-173 количество, T-175 агрегаты): оборот параметра может стоять только в шапке («Класс арматуры»), а значение —
    в ячейке («A500C»)."""

    page: int
    column: str  # подпись колонки: строки шапки сверху вниз через « · »
    column_parts: list[str]  # те же строки шапки по отдельности
    column_role: Literal["value", "text"]
    row: int  # TableRow.index
    row_name: str
    row_number: str | None
    section: str | None
    total: bool
    unit: str | None  # единица ячейки: шапка колонки, иначе строки, иначе хвост числа
    raw: str
    num: float | None
    range: tuple[float, float] | None
    bbox: BBox | None
    bbox_row: BBox | None
    bbox_name: BBox | None
    table_bbox: BBox
    kind: str  # вид таблицы: tep | explication | other


def labeled_cells(read: TableRead, *, empty: bool = False) -> list[LabeledCell]:
    """Все непустые ячейки колонок значений и текстовых колонок таблицы с подписями колонки и строки.
    empty=True — и пустые ячейки колонок значений (для счёта «нет значения»)."""
    out: list[LabeledCell] = []
    for row in read.rows:
        for role, cells in (("value", row.values), ("text", row.text_cells)):
            for v in cells:
                if not v.raw and not empty:
                    continue
                out.append(LabeledCell(
                    page=read.page, column=v.column, column_parts=v.column.split(" · "), column_role=role,
                    row=row.index, row_name=row.name, row_number=row.number, section=row.section, total=row.total,
                    unit=v.unit if role == "value" else None, raw=v.raw, num=v.num, range=v.range, bbox=v.bbox,
                    bbox_row=row.bbox_row, bbox_name=row.bbox_name, table_bbox=read.bbox, kind=read.kind,
                ))
    return out


def find_cells(reads: list[TableRead], *, column: str | None = None, row: str | None = None) -> list[LabeledCell]:
    """Ячейки, у которых подпись колонки и/или строки содержит регулярное выражение (после fold, без регистра).
    Шаблоны — константы вызывающего кода, не данные пользователя (OWASP-0190)."""
    cr = re.compile(column, re.I) if column else None
    rr = re.compile(row, re.I) if row else None
    return [c for rd in reads for c in labeled_cells(rd)
            if (cr is None or cr.search(fold(c.column))) and (rr is None or rr.search(fold(c.row_name)))]


class RoomRow(BaseModel):
    number: str | None
    name: str
    area: float | None
    category: str | None
    section: str | None
    page: int
    bbox_row: BBox | None
    bbox_area: BBox | None


def explication_rows(read: TableRead) -> list[RoomRow]:
    """Строки экспликации помещений без итогов: площадь — первая колонка значений в м² (иначе первая числовая)."""
    area_i = next((i for i, c in enumerate(read.value_columns) if c.unit == "м²"), 0)
    out = []
    for r in read.rows:
        if r.total or not r.values:
            continue
        v = r.values[area_i] if area_i < len(r.values) else None
        cat = next((t for k, t in r.texts.items() if re.match(r"кат", fold(k))), None)
        out.append(
            RoomRow(
                number=r.number,
                name=r.name,
                area=v.num if v else None,
                category=cat,
                section=r.section,
                page=read.page,
                bbox_row=r.bbox_row,
                bbox_area=v.bbox if v else None,
            )
        )
    return out


# ─────────────────────────────────────────────── документ


def table_pages(doc: ParsedDoc, cap: int = TABLE_PAGE_CAP) -> list[int]:
    """Листы с текстовым слоем, где есть шапка ТЭП или экспликации: «Ед. изм.», «Наименование показателя»,
    «Экспликация», «Номер помещения». Не больше cap — pdfplumber не должен читать весь пакет."""
    out = []
    for p in doc.pages:
        if p.source != "text":
            continue
        head = fold(" ".join(ln.text for ln in p.lines))
        if re.search(
            r"ед изм|наименование показател|экспликаци|номер помещ|технико экономическ",
            head,
        ):
            out.append(p.page)
        if len(out) >= cap:
            break
    return out


def collapsed(t: Table, read: TableRead | None) -> bool:
    """Таблица по сетке линий без внутренних горизонталей: строки тела слиплись в одну ячейку — в ячейке колонки
    значений несколько чисел подряд, и целиком она не число («30 23 2391,5»)."""
    if t.strategy != "lines" or read is None:
        return False
    ks = [c.col for c in read.columns if c.role in ("value", "text", "unit")]
    for row in skip_caption(t).grid[read.header_rows :]:
        for k in ks:
            c = row[k]
            if c is None or not c.text or parse_value(c.text):
                continue
            if _numbers(c.text) >= 2:
                return True
    return False


def split_rows(page, t: Table, h: int, number: int) -> Table:
    """Слипшееся тело таблицы по сетке линий — строками текста: колонки остаются от вертикальных линий, строка
    тела — строка текста (слова с перекрытием по высоте). Шапка — как была. Перенос наименования становится
    строкой без значений, её склеивает _assemble."""
    vis = visible_box(page)
    w, hh = vis[2] - vis[0], vis[3] - vis[1]
    body = [c for row in t.grid[h:] for c in row if c is not None]
    top = min(c.bbox[1] for c in body)
    cols = [(t.grid[h][k].bbox[0], t.grid[h][k].bbox[2]) if t.grid[h][k] else (0.0, 0.0) for k in range(t.n_cols)]
    box = (vis[0] + t.bbox[0] * w, vis[1] + top * hh, vis[0] + t.bbox[2] * w, vis[1] + t.bbox[3] * hh)
    chars = [ch for ch in page.chars if box[0] <= (ch["x0"] + ch["x1"]) / 2 <= box[2] and box[1] <= (ch["top"] + ch["bottom"]) / 2 <= box[3]]
    words = sorted(extract_words(chars, x_tolerance=TEXT_X_TOL), key=lambda x: (x["top"], x["x0"]))
    lines: list[list[dict]] = []
    bottom = 0.0  # нижний край текущей строки — без пересчёта по всем её словам (SEC-T178-07)
    for wd in words[:MAX_SPLIT_WORDS]:
        mid = (wd["top"] + wd["bottom"]) / 2
        if lines and mid <= bottom:
            lines[-1].append(wd)
            bottom = max(bottom, wd["bottom"])
        else:
            lines.append([wd])
            bottom = wd["bottom"]
    grid = [list(row) for row in t.grid[:h]]
    for i, ln in enumerate(lines):
        ln.sort(key=lambda x: x["x0"])
        r = h + i
        y0 = (min(x["top"] for x in ln) - vis[1]) / hh
        y1 = (max(x["bottom"] for x in ln) - vis[1]) / hh
        row: list[Cell | None] = []
        for k, (x0, x1) in enumerate(cols):
            ws = [x for x in ln if x0 <= ((x["x0"] + x["x1"]) / 2 - vis[0]) / w <= x1]
            text, alt = normalize_cell(" ".join(x["text"] for x in ws))
            row.append(Cell(text, alt, (x0, round(y0, 5), x1, round(y1, 5)), r, k))
        grid.append(row)
    return Table(page=number, strategy="text", bbox=t.bbox, grid=grid)


def read_pdf_tables(path: Path, pages: Iterable[int]) -> list[TableRead]:
    """Таблицы листов PDF (номера с 1) через L2. Слипшееся тело таблицы без внутренних горизонталей делится
    на строки текста (split_rows)."""
    try:
        pdf = pdfplumber.open(str(path))
    except Exception as e:  # pdfminer бросает разнородные исключения на битом файле
        raise CorruptedFile(f"повреждённый PDF: {path.name}") from e
    out: list[TableRead] = []
    with pdf:
        for n in pages:
            if not 1 <= n <= len(pdf.pages):
                continue
            page = pdf.pages[n - 1]
            try:
                for t in page_tables(page, n):
                    try:
                        rd = read_table(t)
                        if collapsed(t, rd):
                            rd = read_table(split_rows(page, skip_caption(t), rd.header_rows, n)) or rd
                    except (ValueError, IndexError, ZeroDivisionError):
                        rd = None  # сбой одной таблицы не роняет остальные таблицы документа (SEC-T178-03)
                    if rd is not None:
                        out.append(rd)
            finally:
                page.close()
    return out


def read_doc_tables(
    path: Path, doc: ParsedDoc, pages: Iterable[int] | None = None
) -> list[TableRead]:
    """Все таблицы показателей и экспликаций PDF-документа. Не PDF — пусто (таблиц DOCX читатель пока не знает)."""
    if doc.kind != "pdf":
        return []
    wanted = list(pages) if pages is not None else table_pages(doc)
    if not wanted:
        return []
    return read_pdf_tables(path, wanted)
