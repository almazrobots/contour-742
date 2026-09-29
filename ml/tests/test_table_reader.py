"""T-178 L2: общий читатель таблиц ТЭП и экспликаций поверх tables.Table. Сетки строятся прямо в тесте (слитые
ячейки — один объект Cell во всех позициях, как у tables._build_lines); сквозной путь через PDF — синтетика
reportlab (ADR-0002)."""

from __future__ import annotations

from pathlib import Path

import pytest
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml import table_reader as R
from inspector_ml.model import Line, Page, ParsedDoc, Word
from inspector_ml.paths import repo_root
from inspector_ml.tables import Cell, Table, normalize_cell

if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(
        TTFont("Noto", str(repo_root() / "assets/fonts/NotoSans.ttf"))
    )


def mk(
    rows: list[list[str | None]],
    merges: list[tuple[int, int, int, int]] = (),
    strategy="lines",
    page=1,
) -> Table:
    """rows — тексты; merges — (r0, c0, r1, c1) полуоткрытые: ячейка (r0, c0) растянута на область."""
    n, m = len(rows), max(len(r) for r in rows)
    grid: list[list[Cell | None]] = [[None] * m for _ in range(n)]
    covered = {
        (r, c): (r0, c0)
        for r0, c0, r1, c1 in merges
        for r in range(r0, r1)
        for c in range(c0, c1)
    }
    spans = {(r0, c0): (r1 - r0, c1 - c0) for r0, c0, r1, c1 in merges}
    for r in range(n):
        for c in range(m):
            if (r, c) in covered and covered[(r, c)] != (r, c):
                continue
            t = rows[r][c] if c < len(rows[r]) else None
            rs, cs = spans.get((r, c), (1, 1))
            text, alt = normalize_cell(t or "")
            cell = Cell(
                text, alt, (c / m, r / n, (c + cs) / m, (r + rs) / n), r, c, rs, cs
            )
            for rr in range(r, r + rs):
                for cc in range(c, c + cs):
                    grid[rr][cc] = cell
    return Table(page=page, strategy=strategy, bbox=(0, 0, 1, 1), grid=grid)


TEP = [
    ["№ п/п", "Наименование показателя", "Ед. изм.", "Значение"],
    ["1", "2", "3", "4"],
    ["1", "Площадь застройки", "м²", "1 234,5"],
    ["2", "Общая площадь здания", "м2", "12 345,6"],
    ["3", "Строительный объем", "м³", "45 000"],
    ["3.1", "в т.ч. надземной части", "м³", "40 000"],
    ["3.2", "в т.ч. подземной части", "м³", "5 000"],
    ["4", "Этажность", "эт.", "9"],
    ["5", "Класс энергоэффективности", "", "B+"],
]


@pytest.mark.l1_functional
def test_tep_rows_name_unit_value_and_parent():
    rd = R.read_table(mk(TEP))
    assert rd.kind == "tep" and rd.header_rows == 2
    assert [c.role for c in rd.columns] == ["number", "name", "unit", "value"]
    names = [r.name for r in rd.rows]
    assert names[:3] == [
        "Площадь застройки",
        "Общая площадь здания",
        "Строительный объем",
    ]
    r0 = rd.rows[0]
    assert (
        r0.number,
        r0.unit,
        r0.values[0].num,
        r0.values[0].column,
        r0.values[0].unit,
    ) == ("1", "м²", 1234.5, "Значение", "м²")
    assert rd.rows[1].values[0].num == 12345.6 and rd.rows[1].unit == "м²"
    assert [r.parent for r in rd.rows[3:5]] == [2, 2] and rd.rows[2].parent is None
    assert rd.rows[5].unit == "эт" and rd.rows[5].values[0].num == 9
    last = rd.rows[6]
    assert (
        last.values[0].num is None and last.values[0].raw == "B+" and last.unit is None
    )  # текст — не число
    assert r0.bbox_row == (0.0, 2 / 9, 1.0, 3 / 9) and r0.bbox_name == (
        0.25,
        2 / 9,
        0.5,
        3 / 9,
    )
    assert r0.values[0].bbox == (0.75, 2 / 9, 1.0, 3 / 9)


@pytest.mark.l1_functional
def test_two_row_header_with_merged_group_and_unit_in_header():
    t = mk(
        [
            ["№", "Наименование", "Площадь, м²", None, "Кат."],
            [None, None, "общая", "жилая", None],
            ["1", "Квартира 1", "54,2", "30,1", ""],
            ["2", "Квартира 2", "40", "", ""],
            ["", "Итого", "94,2", "30,1", ""],
        ],
        merges=[(0, 2, 1, 4), (0, 0, 2, 1), (0, 1, 2, 2), (0, 4, 2, 5)],
    )
    rd = R.read_table(t)
    assert rd.header_rows == 2
    vc = rd.value_columns
    assert [c.title for c in vc] == ["Площадь, м² · общая", "Площадь, м² · жилая"] and {
        c.unit for c in vc
    } == {"м²"}
    assert [c.role for c in rd.columns] == ["number", "name", "value", "value", "text"]
    q1 = rd.rows[0]
    assert [v.num for v in q1.values] == [54.2, 30.1] and all(
        v.unit == "м²" for v in q1.values
    )
    assert rd.rows[1].values[1].num is None and rd.rows[1].values[1].raw == ""
    tot = rd.rows[2]
    assert tot.total and [v.num for v in tot.values] == [94.2, 30.1]
    checks = R.check_totals(rd)
    assert [(c.column, c.summed, c.ok) for c in checks] == [
        ("Площадь, м² · общая", 94.2, True),
        ("Площадь, м² · жилая", 30.1, True),
    ]


@pytest.mark.l1_functional
def test_explication_sections_totals_and_room_rows():
    t = mk(
        [
            ["Номер помещения", "Наименование", "Площадь, м²", "Кат. помещения"],
            ["1 этаж", None, None, None],
            ["1.1", "Тамбур", "4,5", "Д"],
            ["1.2", "Коридор", "12,0", "Д"],
            ["", "Итого по этажу", "16,5", ""],
            ["2 этаж", None, None, None],
            ["2.1", "Склад", "30", "В4"],
            ["", "Итого по этажу", "31", ""],
            ["", "Всего", "46,5", ""],
        ],
        merges=[(1, 0, 2, 4), (5, 0, 6, 4)],
    )
    rd = R.read_table(t)
    assert rd.kind == "explication" and rd.sections == ["1 этаж", "2 этаж"]
    rooms = R.explication_rows(rd)
    assert [(x.number, x.name, x.area, x.category, x.section) for x in rooms] == [
        ("1.1", "Тамбур", 4.5, "Д", "1 этаж"),
        ("1.2", "Коридор", 12.0, "Д", "1 этаж"),
        ("2.1", "Склад", 30.0, "В4", "2 этаж"),
    ]
    assert rooms[0].bbox_area is not None and rooms[0].page == 1
    checks = R.check_totals(rd)
    assert [(c.stated, c.summed, c.ok) for c in checks] == [
        (16.5, 16.5, True),
        (31.0, 30.0, False),
        (46.5, 46.5, True),
    ]
    assert checks[1].rows == [3] and checks[2].rows == [0, 1, 3]


@pytest.mark.l1_functional
def test_wrapped_name_rows_without_border_and_hyphen():
    t = mk(
        [
            ["Наименование показателя", "Ед. изм.", "Значение"],
            ["Площадь застрой-", "", ""],
            ["ки", "м²", "500"],
            ["Количество машино-мест", "шт", "40"],
            ["(наземных и подземных)", "", ""],
            ["Высота здания от уровня", "", ""],
            ["Земли", "м", "30,5"],
        ],
        strategy="text",
    )
    rd = R.read_table(t)
    assert [r.name for r in rd.rows] == [
        "Площадь застройки",
        "Количество машино-мест (наземных и подземных)",
        "Высота здания от уровня Земли",
    ]
    assert [r.values[0].num for r in rd.rows] == [500, 40, 30.5]
    assert rd.strategy == "text"


@pytest.mark.l1_functional
def test_unit_priority_column_then_name_tail_then_header_then_value_tail():
    t = mk(
        [
            ["Наименование", "Ед. изм.", "Всего", "Надземная часть, м³"],
            ["Строительный объем", "м³", "100", "80"],
            ["Площадь застройки, м²", "", "50", ""],
            ["Высота", "", "12 м", ""],
            ["Прочее", "", "7", ""],
        ]
    )
    rd = R.read_table(t)
    a, b, c, d = rd.rows
    assert (a.unit, a.values[0].unit, a.values[1].unit) == ("м³", "м³", "м³")
    assert (b.name, b.unit, b.values[0].unit) == ("Площадь застройки", "м²", "м²")
    assert b.values[1].unit == "м³"  # у колонки своя единица в шапке
    assert (c.unit, c.values[0].num, c.values[0].unit) == ("м", 12.0, "м")
    assert d.unit is None and d.values[0].unit is None
    assert rd.kind == "tep"


@pytest.mark.l1_functional
def test_roles_without_header_by_cell_types():
    t = mk(
        [
            ["1", "Площадь застройки", "м²", "300"],
            ["2", "Общая площадь", "м²", "900"],
            ["3", "Этажность", "эт", "3"],
        ]
    )
    rd = R.read_table(t)
    assert rd.header_rows == 0 and [c.role for c in rd.columns] == [
        "number",
        "name",
        "unit",
        "value",
    ]
    assert rd.columns[3].title == "колонка 4" and rd.kind == "other"
    assert [r.values[0].num for r in rd.rows] == [300, 900, 3]


@pytest.mark.l3_boundary
def test_merged_value_cells_belong_to_first_row_and_column():
    t = mk(
        [
            ["Наименование", "Всего", "Надземная"],
            ["Объем", "100", None],
            ["Объем 2", "7", "8"],
            ["Объем 3", None, "9"],
        ],
        merges=[(1, 1, 2, 3), (2, 1, 4, 2)],
    )
    rd = R.read_table(t)
    assert [[v.num for v in r.values] for r in rd.rows] == [
        [100, None],
        [7, 8],
        [None, 9],
    ]


@pytest.mark.l3_boundary
def test_not_a_table_and_degenerate_inputs():
    assert (
        R.read_table(Table(page=1, strategy="lines", bbox=(0, 0, 1, 1), grid=[]))
        is None
    )
    assert R.read_table(mk([["1"], ["2"]])) is None
    assert (
        R.read_table(mk([["1", "2"], ["3", "4"]])) is None
    )  # нет колонки наименования
    rd = R.read_table(mk([["Наименование", "Значение"], ["", ""], ["Показатель", "5"]]))
    assert [r.name for r in rd.rows] == ["Показатель"]


@pytest.mark.l3_boundary
def test_header_and_numbering_detection():
    assert R.header_rows(mk([["1", "Площадь", "5"]])) == 0
    assert (
        R.header_rows(mk([["Показатель", "Значение"], ["1", "2"], ["Площадь", "5"]]))
        == 2
    )
    assert R.header_rows(mk([["Показатель", "5 шт"], ["Площадь", "5"]])) == 0
    assert (
        R.header_rows(
            mk(
                [
                    ["A", "B"],
                    ["C", "D"],
                    ["E", "F"],
                    ["G", "H"],
                    ["I", "J"],
                    ["Площадь", "5"],
                ]
            )
        )
        == 0
    )  # < 2 букв
    many = [["Шапка", "Ещё"]] * 6 + [["Площадь", "5"]]
    assert R.header_rows(mk(many)) == R.MAX_HEADER_ROWS
    assert not R._is_numbering(mk([["1", "3"]]).grid[0]) and not R._is_numbering(
        mk([["1", ""]]).grid[0]
    )


@pytest.mark.l3_boundary
def test_orphan_rows_trailing_section_and_title_unit_fallback():
    t = mk(
        [
            ["Наименование", "Объем в м3"],
            ["Жилая часть", ""],
            ["Корпус А", "10"],
            ["Нежилые помещения", ""],
        ]
    )
    rd = R.read_table(t)
    assert rd.value_columns[0].unit == "м³"
    assert rd.rows[0].section == "Жилая часть" and rd.sections == [
        "Жилая часть",
        "Нежилые помещения",
    ]
    assert (
        R.join_parts(["А-", "Б"]) == "А- Б"
        and R.join_parts(["", "x"]) == "x"
        and R.join_parts(["-", "а"]) == "- а"
    )


@pytest.mark.l3_boundary
def test_totals_skip_subrows_and_empty_and_tolerance():
    t = mk(
        [
            ["Наименование", "Площадь, м²"],
            ["Квартира", "10,04"],
            ["в т.ч. жилая", "6"],
            ["Кладовая", "—"],
            ["Итого", "10,0"],
            ["Итого", ""],
        ]
    )
    rd = R.read_table(t)
    checks = R.check_totals(rd)
    assert (
        len(checks) == 1
        and checks[0].summed == 10.04
        and checks[0].ok
        and checks[0].rows == [0, 2]
    )


# ─────────────────────────────── документ: страницы и PDF


def _page(n: int, text: str, source="text") -> Page:
    return Page(
        page=n,
        width=595,
        height=842,
        source=source,
        lines=[Line(text=text, words=[Word(text=w) for w in text.split()])],
    )


@pytest.mark.l1_functional
def test_table_pages_by_header_words_and_cap():
    d = ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="t",
        pages=[
            _page(1, "Общие данные"),
            _page(2, "Наименование показателя Ед. изм."),
            _page(3, "Экспликация помещений"),
            _page(4, "Номер помещения", source="ocr"),
        ],
    )
    assert R.table_pages(d) == [2, 3]
    assert R.table_pages(d, cap=1) == [2]
    assert (
        R.read_doc_tables(Path("/nonexistent"), d.model_copy(update={"kind": "docx"}))
        == []
    )
    assert R.read_doc_tables(Path("/nonexistent"), d, pages=[]) == []


@pytest.mark.l1_functional
def test_read_doc_tables_from_vector_pdf(tmp_path):
    path = tmp_path / "tep.pdf"
    c = canvas.Canvas(str(path), pagesize=(595, 842), invariant=1)
    c.setFont("Noto", 9)
    xs, y0, h = [40, 90, 330, 400, 540], 700, 20
    rows = TEP[:1] + TEP[2:5]
    c.drawString(40, 740, "Технико-экономические показатели")
    for i, row in enumerate(rows):
        y = y0 - i * h
        for k, text in enumerate(row):
            c.drawString(xs[k] + 3, y - 14, text)
    for i in range(len(rows) + 1):
        c.line(xs[0], y0 - i * h, xs[-1], y0 - i * h)
    for x in xs:
        c.line(x, y0, x, y0 - len(rows) * h)
    c.showPage()
    c.save()
    d = ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="t",
        pages=[_page(1, "Наименование показателя Ед. изм.")],
    )
    [rd] = R.read_doc_tables(path, d)
    assert rd.kind == "tep" and [r.name for r in rd.rows] == [
        "Площадь застройки",
        "Общая площадь здания",
        "Строительный объем",
    ]
    assert [r.values[0].num for r in rd.rows] == [1234.5, 12345.6, 45000] and rd.rows[
        0
    ].unit == "м²"


# ─────────────────────────────── таблицы без рамок и слипшиеся строки


@pytest.mark.l3_boundary
def test_caption_row_above_header_is_dropped_but_kept_without_header():
    t = mk([["Технико-экономические показатели", None, None], ["Наименование", "Ед. изм.", "Значение"], ["Площадь застройки", "м²", "5"]],
           merges=[(0, 0, 1, 3)])
    rd = R.read_table(t)
    assert rd.header_rows == 1 and rd.sections == [] and rd.rows[0].name == "Площадь застройки"
    plain = mk([["Итоги", None], ["Площадь застройки", "5"]], merges=[(0, 0, 1, 2)])
    assert R.skip_caption(plain) is plain


@pytest.mark.l3_boundary
def test_header_tail_row_and_split_columns_in_text_table():
    t = mk([
        ["Наименование", "Ед. изм.", "Значение", ""],
        ["показателя", "", "", ""],
        ["Площадь застройки", "м²", "", "120"],
        ["Этажность", "эт", "", "9"],
    ], strategy="text")
    assert R.header_rows(t) == 2
    rd = R.read_table(t)
    assert [c.title for c in rd.columns] == ["Наименование · показателя", "Ед. изм.", "Значение"]
    assert [r.values[0].num for r in rd.rows] == [120, 9]
    assert R._is_header_tail([None]) is False


@pytest.mark.l3_boundary
def test_collapsed_detection():
    t = mk([["Наименование", "Значение"], ["Площадь Этажность", "120 9"]])
    rd = R.read_table(t)
    assert R.collapsed(t, rd) is True
    assert R.collapsed(t, None) is False
    ok = mk([["Наименование", "Значение"], ["Площадь", "120"]])
    assert R.collapsed(ok, R.read_table(ok)) is False
    assert R.collapsed(mk([["Наименование", "Значение"], ["А Б", "1 2"]], strategy="text"), rd) is False
    assert R._numbers("12 — 5,5 м") == 3


@pytest.mark.l1_functional
def test_pdf_table_without_inner_lines_split_into_text_rows(tmp_path):
    path = tmp_path / "nolines.pdf"
    c = canvas.Canvas(str(path), pagesize=(595, 842), invariant=1)
    c.setFont("Noto", 9)
    xs, top = [40, 300, 380, 540], 700
    head = ["Наименование показателя", "Ед. изм.", "Значение"]
    rows = [["Площадь застройки", "м²", "1 234,5"], ["Общая площадь здания", "м²", "9 000"], ["Этажность", "эт.", "9"]]
    for k, t in enumerate(head):
        c.drawString(xs[k] + 3, top - 14, t)
    for i, row in enumerate(rows):
        for k, t in enumerate(row):
            c.drawString(xs[k] + 3, top - 40 - i * 14, t)
    bottom = top - 40 - len(rows) * 14
    c.line(xs[0], top, xs[-1], top)
    c.line(xs[0], top - 20, xs[-1], top - 20)
    c.line(xs[0], bottom, xs[-1], bottom)
    for x in xs:
        c.line(x, top, x, bottom)
    c.showPage()
    c.save()
    [rd] = R.read_pdf_tables(path, [1, 5])
    assert [(r.name, r.unit, r.values[0].num) for r in rd.rows] == [
        ("Площадь застройки", "м²", 1234.5), ("Общая площадь здания", "м²", 9000), ("Этажность", "эт", 9)]
    with pytest.raises(Exception):
        R.read_pdf_tables(tmp_path / "missing.pdf", [1])


# ─────────────────────────────── ячейка + подпись колонки + подпись строки (вход T-172, T-173, T-175)


@pytest.mark.l1_functional
def test_labeled_cells_class_in_column_named_only_in_header():
    t = mk([
        ["Поз.", "Наименование", "Класс арматуры", "Марка стали", "Масса, т"],
        ["1", "Колонна К-1", "A500C", "С245", "1,2"],
        ["2", "Плита П-1", "A240", "—", "3"],
        ["", "Итого", "", "", "4,2"],
    ])
    rd = R.read_table(t)
    cells = R.labeled_cells(rd)
    got = [(c.row_name, c.column, c.column_role, c.raw, c.num, c.unit) for c in cells]
    assert ("Колонна К-1", "Класс арматуры", "text", "A500C", None, None) in got
    assert ("Колонна К-1", "Масса, т", "value", "1,2", 1.2, "т") in got
    a500 = next(c for c in cells if c.raw == "A500C")
    assert a500.bbox == (0.4, 0.25, 0.6, 0.5) and a500.row_number == "1" and a500.page == 1 and a500.kind == "other"
    assert a500.bbox_name is not None and a500.table_bbox == (0, 0, 1, 1) and not a500.total
    assert [c.raw for c in R.find_cells([rd], column="класс арматур")] == ["A500C", "A240"]
    assert [c.raw for c in R.find_cells([rd], column="марка стали", row="плита")] == ["—"]
    assert [c.num for c in R.find_cells([rd], row="^итого")] == [4.2]
    assert len(R.find_cells([rd])) == len(cells)


@pytest.mark.l3_boundary
def test_labeled_cells_empty_and_column_parts():
    t = mk([
        ["Наименование", "Площадь, м²", None],
        [None, "общая", "жилая"],
        ["Квартира", "50", ""],
    ], merges=[(0, 1, 1, 3), (0, 0, 2, 1)])
    rd = R.read_table(t)
    assert [c.column_parts for c in R.labeled_cells(rd)] == [["Площадь, м²", "общая"]]
    full = R.labeled_cells(rd, empty=True)
    assert [(c.column, c.raw, c.unit) for c in full] == [("Площадь, м² · общая", "50", "м²"), ("Площадь, м² · жилая", "", "м²")]
