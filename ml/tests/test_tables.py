"""Таблицы векторного PDF и связка строки (OS-INSP-2.2.5), прототип T-127. Только синтетика reportlab (ADR-0002)."""

from __future__ import annotations

import json
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml import tables as T
from inspector_ml.model import ParamSpec
from inspector_ml.parse import PDFIUM_LOCK, CorruptedFile, parse_file

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
MATRIX = json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
SPECS = [
    ParamSpec(
        code=p["code"],
        anchors=p["anchors"],
        data_type=p["data_type"],
        regex_pattern=p.get("regex_pattern"),
    )
    for p in MATRIX
]
UNITS = {p["code"]: p["unit"] for p in MATRIX}
FONT = ROOT / "assets/fonts/NotoSans.ttf"
if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(TTFont("Noto", str(FONT)))

PW, PH = 595.0, 842.0  # A4 книжный, pt
X0, YTOP, ROW_H = 60.0, 760.0, 24.0
COLS = [250.0, 70.0, 110.0]  # наименование | ед. изм. | значение
NBSP, NNBSP = " ", " "

TEP = [
    ("Наименование показателя", "Ед. изм.", "Значение"),
    ("Площадь застройки", "м²", "1234,5"),
    ("Общая площадь здания", "м2", f"12{NBSP}345,6"),
    ("Строительный объем (Подземный)", "м³", f"5{NNBSP}000"),
    ("Строительный объем (Надземный)", "м3", "40 000"),
    ("Этажность", "эт.", "9"),
    ("Количество квартир", "шт.", "120"),
    ("Высота здания", "мм", "45300"),
    ("Количество машино-мест", "шт.", "см. лист 5"),  # не число — отказ
    ("Коэффициент застройки (КЗ)", "", "35"),  # нет единицы — отказ
    ("Площадь озеленения и газонов", "м", "100"),  # единица не та величина — отказ
]


def _xs(cols=COLS):
    xs = [X0]
    for w in cols:
        xs.append(xs[-1] + w)
    return xs


def draw_table(
    c, rows, cols=COLS, border=True, merges=(), x0=X0, ytop=YTOP, row_h=ROW_H, size=10
):
    """Таблица в координатах reportlab. rows — тексты (строка «\\n» — перенос внутри ячейки);
    merges — (row, col, rowspan, colspan): объединённая ячейка, текст берётся из левой верхней."""
    xs = [x0]
    for w in cols:
        xs.append(xs[-1] + w)
    covered = {}
    for r, k, rs, cs in merges:
        for i in range(r, r + rs):
            for j in range(k, k + cs):
                covered[(i, j)] = (r, k, rs, cs)
    c.setFont("Noto", size)
    for r, row in enumerate(rows):
        for k, text in enumerate(row):
            m = covered.get((r, k), (r, k, 1, 1))
            if (m[0], m[1]) != (r, k):
                continue
            left, right = xs[k], xs[k + m[3]]
            top, bottom = ytop - r * row_h, ytop - (r + m[2]) * row_h
            if border:
                c.rect(left, bottom, right - left, top - bottom, stroke=1, fill=0)
            lines = text.split("\n") if text else []
            for i, ln in enumerate(lines):
                c.drawString(left + 4, top - 11 - i * (size + 1), ln)
    return xs


def make_pdf(path: Path, draw, size=(PW, PH), rotate=0, crop=None) -> Path:
    c = canvas.Canvas(str(path), pagesize=size)
    draw(c)
    c.showPage()
    c.save()
    if rotate or crop:
        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(str(path))
            if crop:
                pdf[0].set_cropbox(*crop)
            if rotate:
                pdf[0].set_rotation(rotate)
            tmp = path.with_suffix(".tmp")
            pdf.save(str(tmp))
            pdf.close()
        tmp.replace(path)
    return path


def cands(path: Path, units=UNITS):
    return {c.param_code: c for c in T.table_candidates(path, SPECS, units)}


def near(a, b, tol=0.004):
    return all(abs(x - y) <= tol for x, y in zip(a, b, strict=True))


@pytest.fixture(scope="module")
def tep_pdf(tmp_path_factory):
    return make_pdf(
        tmp_path_factory.mktemp("tep") / "tep.pdf", lambda c: draw_table(c, TEP)
    )


# ─────────────────────────────── OS-INSP-2.2.5: связка строки таблицы ТЭП


@pytest.mark.l1_functional
def test_tep_row_links_name_unit_value(tep_pdf):
    """OS-INSP-2.2.5: значение ячейки связано с наименованием и единицей той же строки таблицы ТЭП."""
    got = cands(tep_pdf)
    assert (
        got["M-001"].value_num == 1234.5
        and got["M-001"].unit == "м²"
        and got["M-001"].value_raw == "1234,5"
    )
    assert (
        got["M-002"].value_num == 12345.6 and got["M-002"].unit_doc == "м²"
    )  # «м2» — синоним
    assert (
        got["M-005"].value_num == 5000 and got["M-006"].value_num == 40000
    )  # узкий NBSP и пробел в тысячах
    assert (
        got["M-007"].value_num == 9 and got["M-007"].unit == "ед"
    )  # «эт.» — счётная единица «ед.» Матрицы
    assert got["M-010"].value_num == 120
    assert all(c.strategy == "lines" and c.page == 1 for c in got.values())
    assert got["M-001"].confidence == 1.0


@pytest.mark.l2_differential
def test_rival_params_row_goes_to_more_specific_anchor(tep_pdf):
    """OS-INSP-2.2.10: «Строительный объем (Подземный)» — M-005, не M-004; каждая строка — одному параметру."""
    got = T.table_candidates(tep_pdf, SPECS, UNITS)
    assert "M-004" not in {c.param_code for c in got}
    assert len({(c.page, c.bbox_row) for c in got}) == len(got)


@pytest.mark.l1_functional
def test_unit_converted_to_matrix_unit(tep_pdf):
    """Высота в мм при «м» Матрицы: значение приведено к единице Матрицы, уверенность чуть ниже."""
    h = cands(tep_pdf)["M-008"]
    assert h.value_num == pytest.approx(45.3) and h.unit == "м" and h.unit_doc == "мм"
    assert h.confidence == pytest.approx(T.CONVERTED)


@pytest.mark.l4_fault
def test_row_without_unit_or_number_is_not_candidate(tep_pdf):
    """Отказ: «см. лист 5» — не число, у КЗ нет единицы, у озеленения «м» вместо «м²» — кандидатов нет."""
    got = cands(tep_pdf)
    assert not {"M-012", "M-019", "M-027"} & set(got)


@pytest.mark.l1_functional
def test_cell_and_row_bbox_in_page_fractions(tep_pdf):
    """bbox ячейки значения и строки — доли видимой страницы, левый верхний угол — начало."""
    xs = _xs()
    c = cands(tep_pdf)["M-001"]  # строка 1
    top, bottom = PH - YTOP + ROW_H, PH - YTOP + 2 * ROW_H
    assert near(c.bbox_cell, (xs[2] / PW, top / PH, xs[3] / PW, bottom / PH))
    assert near(c.bbox_row, (xs[0] / PW, top / PH, xs[3] / PW, bottom / PH))
    assert near(c.bbox_name, (xs[0] / PW, top / PH, xs[1] / PW, bottom / PH))


@pytest.mark.l1_functional
def test_header_roles_and_numbering_row(tmp_path):
    """Шапка в другом порядке колонок и строка номеров «1 2 3 4» под ней: роли — по шапке."""
    rows = [
        ("№", "Показатель", "Значение", "Ед. изм."),
        ("1", "2", "3", "4"),
        ("1", "Площадь застройки", "800", "м²"),
        ("2", "Количество квартир", "64", "шт"),
    ]
    p = make_pdf(
        tmp_path / "h.pdf", lambda c: draw_table(c, rows, cols=[30, 220, 80, 70])
    )
    t = T.read_tables(p)[0]
    roles = T.column_roles(t)
    assert (
        roles.name,
        roles.value,
        roles.unit,
        roles.header_rows,
        roles.from_header,
    ) == (1, 2, 3, 2, True)
    got = cands(p)
    assert (
        got["M-001"].value_num == 800
        and got["M-010"].value_num == 64
        and got["M-001"].confidence == 1.0
    )


@pytest.mark.l1_functional
def test_roles_by_cell_types_without_header(tmp_path):
    """Шапки нет: наименование — текстовая колонка, единица — колонка единиц, значение — числовая правее."""
    rows = [
        ("1", "Площадь застройки", "м²", "700"),
        ("2", "Количество квартир", "шт.", "50"),
        ("3", "Этажность", "эт", "5"),
    ]
    p = make_pdf(
        tmp_path / "nh.pdf", lambda c: draw_table(c, rows, cols=[30, 220, 60, 80])
    )
    roles = T.column_roles(T.read_tables(p)[0])
    assert (
        roles.name,
        roles.unit,
        roles.value,
        roles.header_rows,
        roles.from_header,
    ) == (1, 2, 3, 0, False)
    got = cands(p)
    assert got["M-001"].value_num == 700 and got["M-001"].confidence == pytest.approx(
        T.ROLE_GUESS
    )


# ─────────────────────────────── варианты вёрстки


@pytest.mark.l3_boundary
def test_borderless_table_text_strategy_lower_confidence(tmp_path):
    """Таблица без рамок: находится по выравниванию текста, уверенность понижена."""
    p = make_pdf(tmp_path / "nb.pdf", lambda c: draw_table(c, TEP[:7], border=False))
    got = cands(p)
    assert got["M-001"].value_num == 1234.5 and got["M-001"].unit == "м²"
    assert got["M-001"].strategy == "text"
    assert got["M-001"].confidence == pytest.approx(T.STRATEGY_CONF["text"])
    assert got["M-005"].value_num == 5000


@pytest.mark.l3_boundary
def test_merged_cells_value_spans_area(tmp_path):
    """Объединённые ячейки: единица на две строки достаётся обеим; значение на две строки — один кандидат,
    bbox — вся объединённая область."""
    rows = [
        ("Наименование", "Ед. изм.", "Значение"),
        ("Площадь застройки", "м²", "1500"),
        ("Общая площадь здания", "", "9000"),
        ("Этажность", "эт.", "12"),
        ("Количество надземных этажей", "эт.", ""),
    ]
    merges = [(1, 1, 2, 1), (3, 2, 2, 1)]
    p = make_pdf(tmp_path / "m.pdf", lambda c: draw_table(c, rows, merges=merges))
    t = T.read_tables(p)[0]
    assert t.grid[1][1] is t.grid[2][1] and t.grid[1][1].rowspan == 2
    got = T.table_candidates(p, SPECS, UNITS)
    by = {c.param_code: c for c in got}
    assert (
        by["M-001"].value_num == 1500
        and by["M-002"].value_num == 9000
        and by["M-002"].unit == "м²"
    )
    assert [c.param_code for c in got].count("M-007") == 1
    xs = _xs()
    assert near(
        by["M-007"].bbox_cell,
        (
            xs[2] / PW,
            (PH - YTOP + 3 * ROW_H) / PH,
            xs[3] / PW,
            (PH - YTOP + 5 * ROW_H) / PH,
        ),
    )


@pytest.mark.l3_boundary
def test_wrapped_name_inside_cell_with_hyphen(tmp_path):
    """Перенос наименования внутри ячейки с дефисом переноса: «Площадь застрой-/ки» → M-001."""
    rows = [
        ("Наименование", "Ед. изм.", "Значение"),
        ("Площадь застрой-\nки", "м²", "321,5"),
        ("Количество маши-\nно-мест", "шт", "40"),
    ]
    p = make_pdf(tmp_path / "w.pdf", lambda c: draw_table(c, rows, row_h=30))
    got = cands(p)
    assert (
        got["M-001"].value_num == 321.5
        and got["M-001"].name_text == "Площадь застройки"
    )
    assert (
        got["M-012"].value_num == 40
    )  # «машино-мест»: дефис слова сохранён в запасном варианте


@pytest.mark.l3_boundary
def test_wrapped_name_on_two_rows_without_border(tmp_path):
    """Без рамок вторая строка наименования — отдельная строка таблицы; склейка даёт M-005, а не M-004."""
    rows = [
        ("Наименование", "Ед. изм.", "Значение"),
        ("Площадь застройки", "м²", "1234,5"),
        ("Строительный объем", "м³", "7000"),
        ("(Подземный)", "", ""),
        ("Количество квартир", "шт.", "10"),
    ]
    p = make_pdf(
        tmp_path / "w2.pdf", lambda c: draw_table(c, rows, border=False, row_h=16)
    )
    got = cands(p)
    assert (
        got["M-005"].value_num == 7000
        and got["M-005"].name_text == "Строительный объем (Подземный)"
    )
    assert "M-004" not in got


@pytest.mark.l3_boundary
def test_unit_in_name_parentheses_or_comma(tmp_path):
    """Единица в наименовании: «Площадь застройки (м²)», «Общая площадь здания, м2» — колонки единиц нет."""
    rows = [
        ("Показатель", "Значение"),
        ("Площадь застройки (м²)", "2 500,75"),
        ("Общая площадь здания, м2", "8000"),
        ("Количество квартир", "12 шт."),
    ]
    p = make_pdf(tmp_path / "u.pdf", lambda c: draw_table(c, rows, cols=[260, 110]))
    got = cands(p)
    assert got["M-001"].value_num == 2500.75 and got["M-001"].unit_doc == "м²"
    assert got["M-002"].value_num == 8000
    assert (
        got["M-010"].value_num == 12 and got["M-010"].unit_doc == "шт"
    )  # единица в ячейке значения


@pytest.mark.l3_boundary
def test_range_value_lower_confidence(tmp_path):
    rows = [
        ("Наименование", "Ед. изм.", "Значение"),
        ("Высота здания", "м", "45,0–47,5"),
    ]
    p = make_pdf(tmp_path / "r.pdf", lambda c: draw_table(c, rows))
    h = cands(p)["M-008"]
    assert (
        h.value_num is None
        and h.value_range == (45.0, 47.5)
        and h.confidence == pytest.approx(T.RANGE)
    )


# ─────────────────────────────── координаты: CropBox и /Rotate


def _upright(rotate: int, ytop: float = 500, rows=TEP[:4]):
    """Содержимое, повёрнутое против /Rotate страницы: на видимом листе таблица читается прямо
    (альбомный лист, сохранённый книжным с /Rotate 90 — обычное дело в выгрузке САПР)."""

    def draw(c):
        c.translate(*{0: (0, 0), 90: (PW, 0), 180: (PW, PH), 270: (0, PH)}[rotate])
        c.rotate(rotate)  # дальше рисуем в системе видимого листа, начало — его левый нижний угол
        draw_table(c, rows, ytop=ytop)

    return draw


@pytest.mark.l3_boundary
@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_rotated_page_candidates_and_bbox(tmp_path, rotate):
    """/Rotate: связка работает, bbox — в видимой ориентации (у листа «лёжа» ширина видимой страницы — PH)."""
    p = make_pdf(tmp_path / "rot.pdf", _upright(rotate), rotate=rotate)
    c = cands(p)["M-001"]
    assert c.value_num == 1234.5
    xs = _xs()
    vw, vh = (PW, PH) if rotate == 180 else (PH, PW)
    assert near(c.bbox_cell, (xs[2] / vw, (vh - 500 + ROW_H) / vh, xs[3] / vw, (vh - 500 + 2 * ROW_H) / vh))


@pytest.mark.l2_differential
@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_word_bbox_matches_parse(tmp_path, rotate):
    """Одно и то же слово: bbox из pdfplumber (tables._norm по visible_box) и из parse (pdfium, FPDF_PageToDevice)
    совпадают с допуском — при несимметричном CropBox и /Rotate."""
    import pdfplumber

    p = make_pdf(tmp_path / f"b{rotate}.pdf", _upright(rotate, ytop=450, rows=TEP[:3]), rotate=rotate, crop=(20, 30, 580, 800))
    doc = parse_file(p, "x")
    ref = {w.text: w.bbox for ln in doc.pages[0].lines for w in ln.words}
    with pdfplumber.open(str(p)) as pdf:
        page = pdf.pages[0]
        vis = T.visible_box(page)
        mine = {w["text"]: T._norm((w["x0"], w["top"], w["x1"], w["bottom"]), vis) for w in page.extract_words(x_tolerance=1.5)}
    for word in ("застройки", "1234,5", "Значение"):
        assert near(mine[word], ref[word], tol=0.006), (word, mine[word], ref[word])


@pytest.mark.l3_boundary
def test_table_outside_cropbox_is_ignored(tmp_path):
    """Таблица под CropBox не видна на листе — не читается."""
    p = make_pdf(
        tmp_path / "cb.pdf", lambda c: draw_table(c, TEP[:3]), crop=(0, 0, PW, 400)
    )
    assert T.read_tables(p) == []


# ─────────────────────────────── нормализация и разбор ячеек


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "src,unit",
    [
        ("м²", "м²"),
        ("м2", "м²"),
        ("кв. м", "м²"),
        ("м.кв.", "м²"),
        ("(м³)", "м³"),
        ("куб.м", "м³"),
        ("м3/час", "м³/ч"),
        ("шт.", "шт"),
        ("Этажей", "эт"),
        ("кВт", "квт"),
        ("%", "%"),
        ("мм2", "мм²"),
        ("тыс. руб.", "тысруб"),
        ("л/с", "л/с"),
        ("м", "м"),
        ("MM", "мм"),
        ("", None),
        ("—", None),
        ("Площадь", None),
        ("м/xyz", None),
        ("()", None),
        (None, None),
    ],
)
def test_canon_unit(src, unit):
    assert T.canon_unit(src) == unit


@pytest.mark.l1_functional
def test_unit_options_from_matrix():
    assert T.unit_options("шт. / м") == {"шт", "м"}
    assert T.unit_options("мм (слои)") == {"мм"}
    assert T.unit_options("м³/ч / Па / кВт") == {"м³/ч", "па", "квт"}
    assert T.unit_options("ед.") == {"ед"}
    assert (
        T.unit_options("—") == set()
        and T.unit_options(None) == set()
        and T.unit_options("Статус") == set()
    )


@pytest.mark.l3_boundary
def test_match_unit():
    assert T.match_unit("м²", {"м²"}) == ("м²", 1.0)
    assert T.match_unit("мм", {"м"}) == ("м", pytest.approx(1e-3))
    assert T.match_unit("м", {"мм"}) == ("мм", pytest.approx(1e3))
    assert T.match_unit("га", {"м²"}) == ("м²", pytest.approx(1e4))
    assert T.match_unit(None, {"ед"}) == ("ед", 1.0)
    assert T.match_unit("шт", {"ед"}) == ("ед", 1.0) and T.match_unit("эт", {"ед"}) == (
        "ед",
        1.0,
    )
    assert T.match_unit(None, {"м²"}) is None
    assert T.match_unit("м", {"м²"}) is None  # другая величина — не пересчитывается
    assert T.match_unit("м³", {"м²"}) is None
    assert T.match_unit("%", {"ед"}) is None
    assert T.match_unit("мм", {"шт", "м"}) == ("м", pytest.approx(1e-3))


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "src,num,rng,unit",
    [
        ("1234,5", 1234.5, None, None),
        (f"12{NBSP}345,67", 12345.67, None, None),
        (f"1{NNBSP}234{NNBSP}567", 1234567, None, None),
        ("12.5", 12.5, None, None),
        ("-3,200", -3.2, None, None),
        ("−0,15", -0.15, None, None),
        ("±0,000", 0.0, None, None),
        ("45 м²", 45, None, "м²"),
        ("45,0–47,5", None, (45.0, 47.5), None),
        ("от 10 до 12 м", None, (10.0, 12.0), "м"),
        ("12...10", None, (10.0, 12.0), None),
        ("3-5 шт.", None, (3.0, 5.0), "шт"),
    ],
)
def test_parse_value(src, num, rng, unit):
    v = T.parse_value(src)
    assert (
        v is not None
        and v.num == (pytest.approx(num) if num is not None else None)
        and v.range == rng
        and v.unit == unit
    )


@pytest.mark.l4_fault
@pytest.mark.parametrize(
    "src",
    [
        "см. лист 5",
        "—",
        "",
        "нет",
        "12 (см. лист 3)",
        "2 3",
        "5 этаж секции",
        "В30",
        "1,2,3",
    ],
)
def test_parse_value_rejects_non_numbers(src):
    assert T.parse_value(src) is None


@pytest.mark.l1_functional
def test_normalize_cell():
    assert T.normalize_cell("Площадь застрой-\nки") == (
        "Площадь застройки",
        "Площадь застрой-ки",
    )
    assert T.normalize_cell("машино-\nмест") == ("машиномест", "машино-мест")
    assert T.normalize_cell(f"Общая\nплощадь{NBSP}здания") == (
        "Общая площадь здания",
        "Общая площадь здания",
    )
    assert T.normalize_cell("мягкий­\nперенос") == ("мягкийперенос", "мягкий-перенос")
    assert T.normalize_cell("a\r\nb\tc") == ("a b c", "a b c")
    assert T.normalize_cell(None) == ("", "")
    assert T.normalize_cell("1 -\n2") == (
        "1 - 2",
        "1 - 2",
    )  # дефис после пробела — не перенос


@pytest.mark.l1_functional
def test_split_name_unit():
    assert T.split_name_unit("Площадь застройки, м²") == ("Площадь застройки", "м²")
    assert T.split_name_unit("Площадь (м2)") == ("Площадь", "м²")
    assert T.split_name_unit("Строительный объем (Подземный)") == (
        "Строительный объем (Подземный)",
        None,
    )
    assert T.split_name_unit("Строительный объем (Подземный), м3") == (
        "Строительный объем (Подземный)",
        "м³",
    )
    assert T.split_name_unit("Площадь, общая") == ("Площадь, общая", None)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "text,role",
    [
        ("№ п/п", "skip"),
        ("№", "skip"),
        ("Ед. изм.", "unit"),
        ("Единица измерения", "unit"),
        ("ед.", "unit"),
        ("Значение", "value"),
        ("Кол-во", "value"),
        ("Количество", "value"),
        ("Всего", "value"),
        ("По проекту", "value"),
        ("Наименование показателя", "name"),
        ("Показатель", "name"),
        ("Параметр", "name"),
        ("Примечание", None),
    ],
)
def test_header_role(text, role):
    assert T.header_role(text) == role


@pytest.mark.l3_boundary
def test_numbering_row_detection():
    def row(*texts):
        return [
            T.Cell(t, t, (0, 0, 1, 1), 0, k) if t else None for k, t in enumerate(texts)
        ]

    assert T._is_numbering(row("1", "2", "3", "4"))
    assert T._is_numbering(row("2", "3", "", "4"))
    assert not T._is_numbering(row("1", "3", "4"))
    assert not T._is_numbering(row("1", "Площадь", "2"))
    assert not T._is_numbering(row("1", "", ""))


# ─────────────────────────────── адаптер для extract.py, отказы и ограждения


@pytest.mark.l1_functional
def test_best_by_param_and_to_extraction(tep_pdf):
    all_c = T.table_candidates(tep_pdf, SPECS, UNITS)
    low = all_c[0].model_copy(update={"confidence": 0.1, "page": 2})
    best = T.best_by_param(all_c + [low])
    assert best[all_c[0].param_code] is all_c[0]
    ex = T.to_extraction(best["M-001"])
    assert (ex.code, ex.raw, ex.value_num, ex.page, ex.match) == (
        "M-001",
        "1234,5",
        1234.5,
        1,
        "table",
    )
    assert (
        ex.bbox == best["M-001"].bbox_cell and ex.anchor_bbox == best["M-001"].bbox_name
    )
    assert ex.line_text == "Площадь застройки | м² | 1234,5"


@pytest.mark.l1_functional
def test_units_from_spec_attribute_when_mapping_absent(tep_pdf):
    """Единицы можно передать и полем spec.unit (когда ParamSpec его получит, T-119)."""

    class Spec(ParamSpec):
        unit: str | None = None

    specs = [
        Spec(code="M-001", anchors=["Площадь застройки"], data_type="number", unit="м²")
    ]
    assert [c.param_code for c in T.table_candidates(tep_pdf, specs)] == ["M-001"]
    assert (
        T.table_candidates(
            tep_pdf,
            [
                ParamSpec(
                    code="M-001", anchors=["Площадь застройки"], data_type="number"
                )
            ],
        )
        == []
    )


@pytest.mark.l4_fault
def test_string_params_are_not_linked(tep_pdf):
    """Прототип связывает только числовые параметры; строковый с тем же якорем кандидата не получает."""
    specs = [ParamSpec(code="X", anchors=["Площадь застройки"], data_type="string")]
    assert T.table_candidates(tep_pdf, specs, {"X": "м²"}) == []


@pytest.mark.l4_fault
def test_corrupted_pdf(tmp_path):
    p = tmp_path / "bad.pdf"
    p.write_bytes(b"%PDF-1.4 garbage")
    with pytest.raises(CorruptedFile):
        T.read_tables(p)


@pytest.mark.l7_discipline
def test_heavy_page_skipped(tep_pdf, monkeypatch):
    """Лист-чертёж с числом отрезков больше MAX_EDGES — поиск сетки не запускается (время и RAM, правило №0)."""
    monkeypatch.setattr(T, "MAX_EDGES", 3)
    assert T.read_tables(tep_pdf) == []


@pytest.mark.l3_boundary
def test_pages_filter(tep_pdf):
    assert T.read_tables(tep_pdf, pages=[2, 0]) == []
    assert len(T.read_tables(tep_pdf, pages=[1])) == 1


@pytest.mark.l4_fault
def test_text_page_without_table(tmp_path):
    """Сплошной текст без чисел с единицами — кандидатов нет."""

    def draw(c):
        c.setFont("Noto", 10)
        for i in range(12):
            c.drawString(
                60,
                760 - i * 14,
                "Площадь застройки определена по проекту планировки территории",
            )

    p = make_pdf(tmp_path / "t.pdf", draw)
    assert T.read_tables(p) == []  # одна колонка текста — не таблица
    assert T.table_candidates(p, SPECS, UNITS) == []


# ─────────────────────────────── роли колонок и связка на готовой сетке (без PDF)


def mk(rows, strategy="lines", page=1):
    """Таблица из текстов: ячейка k-й колонки r-й строки — прямоугольник 0,1 × 0,05 со сдвигом."""
    grid = [
        [T.Cell(*T.normalize_cell(x), (k / 10, r / 20, (k + 1) / 10, (r + 1) / 20), r, k) if x is not None else None for k, x in enumerate(row)]
        for r, row in enumerate(rows)
    ]
    return T.Table(page=page, strategy=strategy, bbox=(0, 0, 1, 1), grid=grid)


@pytest.mark.l4_fault
def test_roles_none_without_text_or_number_columns():
    assert T.column_roles(mk([("1", "2,5"), ("3", "4")])) is None  # нет текстовой колонки
    assert T.column_roles(mk([("Площадь застройки", "м²"), ("Этажность", "—")])) is None  # нет числовой
    assert T.link_table(mk([("1", "2,5"), ("3", "4")]), SPECS, UNITS) == []


@pytest.mark.l3_boundary
def test_roles_value_left_of_name_when_nothing_right():
    r = T.column_roles(mk([("1234,5", "м²", "Площадь застройки"), ("9", "эт", "Этажность")]))
    assert (r.name, r.unit, r.value) == (2, 1, 0)
    got = {c.param_code: c for c in T.link_table(mk([("1234,5", "м²", "Площадь застройки"), ("9", "эт", "Этажность")]), SPECS, UNITS)}
    assert got["M-001"].value_num == 1234.5 and got["M-007"].value_num == 9


@pytest.mark.l3_boundary
def test_roles_prefers_densest_numeric_column_and_leftmost_on_tie():
    t = mk([("Площадь застройки", "м²", "1", "100", "200"), ("Этажность", "эт", "—", "5", "6")])
    assert T.column_roles(t).value == 3  # колонка 2 числовая лишь наполовину
    t = mk([("Площадь застройки", "м²", "100", "200"), ("Этажность", "эт", "5", "6")])
    assert T.column_roles(t).value == 2


@pytest.mark.l3_boundary
def test_roles_unit_column_needs_half_of_cells():
    t = mk([("Площадь застройки", "м²", "см", "100"), ("Этажность", "шт", "текст", "5"), ("Высота здания", "м", "слово", "7")])
    assert T.column_roles(t).unit == 1
    t2 = mk([("Площадь застройки", "м²", "100"), ("Этажность", "текст", "5"), ("Высота здания", "слово", "7")])
    assert T.column_roles(t2).unit is None


@pytest.mark.l3_boundary
def test_roles_header_value_column_equal_to_text_column_rejected():
    """Шапка назвала колонку значений, а колонку наименований пришлось угадывать — и угадалась та же: отказ."""
    t = mk([("Всего", "Прим."), ("Площадь застройки", "x"), ("Этажность", "y")])
    assert T.column_roles(t) is None


@pytest.mark.l3_boundary
def test_header_needs_two_roles_and_no_numbers():
    assert T.column_roles(mk([("Наименование", "Значение"), ("Площадь застройки, м²", "5")])).header_rows == 1
    assert T.column_roles(mk([("Наименование", "5"), ("Площадь застройки, м²", "5")])).header_rows == 0
    assert T.column_roles(mk([("Наименование", "Примечание"), ("Площадь застройки, м²", "5")])).header_rows == 0
    # шапка во второй строке (над ней — заголовок таблицы)
    t = mk([("Технико-экономические показатели", ""), ("Наименование", "Значение"), ("Площадь застройки, м²", "5")])
    assert T.column_roles(t).header_rows == 2


@pytest.mark.l4_fault
def test_row_without_name_or_with_merged_name_value_is_skipped():
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("", "м²", "5"), (None, "м²", "6")])
    assert T.link_table(t, SPECS, UNITS) == []
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("Площадь застройки", "м²", "5")])
    t.grid[1][2] = t.grid[1][0]  # наименование и значение — одна объединённая ячейка
    assert T.link_table(t, SPECS, UNITS) == []


@pytest.mark.l3_boundary
def test_orphan_prefix_row_joins_next_row():
    """Продолжение наименования сверху: «Строительный объем» / «(Подземный) | м³ | 5» → M-005."""
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("Строительный объем", "", ""), ("(Подземный)", "м³", "5")])
    got = T.link_table(t, SPECS, UNITS)
    assert [(c.param_code, c.name_text) for c in got] == [("M-005", "Строительный объем (Подземный)")]
    assert got[0].bbox_name == (0.0, 0.05, 0.1, 0.15)


@pytest.mark.l2_differential
def test_confidence_multipliers_combine():
    t = mk([("Высота здания", "мм", "45500–47250"), ("Этажность", "эт", "9")], strategy="text")
    h = {c.param_code: c for c in T.link_table(t, SPECS, UNITS)}["M-008"]
    assert h.confidence == pytest.approx(round(T.STRATEGY_CONF["text"] * T.ROLE_GUESS * T.CONVERTED * T.RANGE, 3))
    assert h.value_range == (45.5, 47.25) and h.value_num is None and h.unit == "м" and h.unit_doc == "мм"
    assert h.bbox_cell == (0.2, 0.0, 0.3, 0.05) and h.bbox_row == (0.0, 0.0, 0.3, 0.05) and h.page == 1


@pytest.mark.l3_boundary
def test_fuzzy_anchor_below_threshold_rejected():
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("Площ. застр.", "м²", "5"), ("Площадь застроики", "м²", "6")])
    got = T.link_table(t, SPECS, UNITS)
    assert [(c.param_code, c.value_num) for c in got] == [("M-001", 6.0)]
    assert 0.9 <= got[0].confidence < 1.0


@pytest.mark.l1_functional
def test_same_param_in_two_rows_both_kept_best_wins():
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("Площадь застройки", "м²", "5"), ("Площадь застроики", "м²", "6")])
    got = T.link_table(t, SPECS, UNITS)
    assert sorted(c.value_num for c in got) == [5.0, 6.0]
    assert T.best_by_param(got)["M-001"].value_num == 5.0
    tie = [got[0].model_copy(update={"page": 3, "confidence": 0.5}), got[0].model_copy(update={"page": 2, "confidence": 0.5})]
    assert T.best_by_param(tie)["M-001"].page == 2


# ─────────────────────────────── добор по выжившим мутантам (mutmut): шапка против типов, границы, геометрия


@pytest.mark.l2_differential
def test_header_roles_override_cell_types():
    """Шапка решает, даже когда типы ячеек подсказали бы другое: значение — «Значение», а не более «числовое»
    «Примечание»; единица — редко заполненная «Ед. изм.»; наименование — не самая «текстовая» колонка."""
    t = mk(
        [
            ("Наименование", "Ед. изм.", "Значение", "Примечание"),
            ("Площадь застройки", "м²", "—", "см. текст раздела"),
            ("Этажность", "см. ПЗ", "9", "по данным заказчика"),
            ("Количество квартир", "по ТУ", "12", "вкл. служебные квартиры"),
            ("", "", "", "примечание к таблице"),
        ]
    )
    r = T.column_roles(t)
    assert (r.name, r.unit, r.value, r.header_rows, r.from_header) == (0, 1, 2, 1, True)
    t2 = mk([("Наименование", "Ед. изм.", "Значение", "Прим."), ("Площадь застройки", "м²", "—", "5"), ("Этажность", "", "9", "7"), ("Количество квартир", "шт", "", "3")])
    assert T.column_roles(t2).value == 2


@pytest.mark.l3_boundary
def test_header_same_role_twice_takes_leftmost():
    t = mk([("Наименование", "По проекту", "Всего"), ("Площадь застройки, м²", "5", "6")])
    assert T.column_roles(t).value == 1


@pytest.mark.l3_boundary
def test_header_searched_in_first_three_rows_only():
    t = mk([("Таблица 1", ""), ("ТЭП", ""), ("объекта", ""), ("Наименование", "Значение"), ("Площадь застройки, м²", "5")])
    assert T.column_roles(t).header_rows == 0


@pytest.mark.l3_boundary
def test_header_with_only_numbering_rows_below():
    r = T.column_roles(mk([("Наименование", "Значение"), ("1", "2")]))
    assert (r.name, r.value, r.header_rows) == (0, 1, 2)
    assert T.link_table(mk([("Наименование", "Значение"), ("1", "2")]), SPECS, UNITS) == []


@pytest.mark.l3_boundary
def test_roles_by_types_edge_cases():
    # пустая ячейка в начале строки не обрывает подсчёт по остальным колонкам
    r = T.column_roles(mk([("", "Площадь застройки", "м²", "5"), ("", "Этажность", "эт", "9")]))
    assert (r.name, r.unit, r.value) == (1, 2, 3)
    # текстовая ячейка — от трёх букв
    assert T.column_roles(mk([("Шаг", "5"), ("Ось", "6")])).name == 0
    # наименование — колонка с большим числом текстовых ячеек, при равенстве — левая
    assert T.column_roles(mk([("abc x", "Площадь застройки", "5"), ("", "Этажность", "9")])).name == 1
    assert T.column_roles(mk([("Площадь застройки", "Этажность", "5")])).name == 0
    # колонка единиц — не меньше половины заполненных ячеек; при равенстве — левая
    assert T.column_roles(mk([("Площадь застройки", "м²", "5"), ("Этажность", "слово", "9")])).unit == 1
    assert T.column_roles(mk([("Площадь застройки", "м²", "м²", "5"), ("Этажность", "эт", "эт", "9")])).unit == 1
    # значения: доля чисел среди заполненных, при равенстве — левая
    assert T.column_roles(mk([("Площадь застройки", "м²", "5", "1"), ("Этажность", "эт", "", "2"), ("Высота здания", "м", "", "3")])).value == 2


@pytest.mark.l3_boundary
def test_orphan_rows_without_unit_column_and_empty_value_cell():
    """Колонки единиц нет: продолжение наименования ищется и так; строка без ячейки значения пропускается."""
    t = mk([("Строительный объем", ""), ("(Подземный), м³", "5"), ("Площадь застройки, м²", None)])
    got = T.link_table(t, SPECS, UNITS)
    assert [(c.param_code, c.value_num) for c in got] == [("M-005", 5.0)]


@pytest.mark.l1_functional
def test_dimensionless_without_unit_line_text():
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("Этажность", "", "9")])
    c = T.link_table(t, SPECS, UNITS)[0]
    assert (c.param_code, c.unit, c.unit_doc) == ("M-007", "ед", None)
    assert T.to_extraction(c).line_text == "Этажность |  | 9"


@pytest.mark.l1_functional
def test_grid_shape_spans_and_table_bbox(tep_pdf):
    t = T.read_tables(tep_pdf)[0]
    assert (len(t.grid), t.n_cols, t.strategy, t.page) == (len(TEP), 3, "lines", 1)
    xs = _xs()
    assert near(t.bbox, (xs[0] / PW, (PH - YTOP) / PH, xs[3] / PW, (PH - YTOP + len(TEP) * ROW_H) / PH))
    c = t.grid[2][1]
    assert (c.row, c.col, c.rowspan, c.colspan) == (2, 1, 1, 1)


@pytest.mark.l3_boundary
def test_merged_header_colspan(tmp_path):
    rows = [("Технико-экономические показатели", "", ""), ("Наименование", "Ед. изм.", "Значение"), ("Площадь застройки", "м²", "5")]
    p = make_pdf(tmp_path / "hs.pdf", lambda c: draw_table(c, rows, merges=[(0, 0, 1, 3)]))
    t = T.read_tables(p)[0]
    top = t.grid[0][0]
    assert t.grid[0][2] is top and (top.row, top.col, top.rowspan, top.colspan) == (0, 0, 1, 3)
    assert T.column_roles(t).header_rows == 2 and cands(p)["M-001"].value_num == 5


@pytest.mark.l3_boundary
def test_single_column_box_is_not_a_table(tmp_path):
    rows = [("Площадь застройки 5 м²",), ("Этажность 9",), ("Примечание",)]
    p = make_pdf(tmp_path / "one.pdf", lambda c: draw_table(c, rows, cols=[300]))
    assert [t.strategy for t in T.read_tables(p)] != ["lines"]


@pytest.mark.l3_boundary
def test_two_column_tables_both_strategies(tmp_path):
    rows = [("Площадь застройки, м²", "5"), ("Этажность", "9")]
    p = make_pdf(tmp_path / "two.pdf", lambda c: draw_table(c, rows, cols=[260, 110]))
    got = cands(p)
    assert got["M-001"].strategy == "lines" and got["M-007"].value_num == 9
    p2 = make_pdf(tmp_path / "two_nb.pdf", lambda c: draw_table(c, rows, cols=[260, 110], border=False))
    t = T.read_tables(p2)[0]
    assert (t.strategy, len(t.grid), t.n_cols) == ("text", 2, 2)
    assert (t.grid[1][1].row, t.grid[1][1].col) == (1, 1)
    assert near(t.bbox, (X0 / PW, (PH - YTOP + 1) / PH, (X0 + 260 + 12) / PW, (PH - YTOP + ROW_H + 13) / PH), tol=0.02)
    assert cands(p2)["M-001"].value_num == 5


def _glyph_words(c, x, y, words, gap):
    """Слова без символа пробела между ними — отдельными глифами с просветом gap pt (как в выгрузке САПР)."""
    for w in words:
        c.drawString(x, y, w)
        x += pdfmetrics.stringWidth(w, "Noto", 10) + gap


@pytest.mark.l3_boundary
@pytest.mark.parametrize("border", [True, False])
def test_space_restored_between_glyph_placed_words(tmp_path, border):
    def draw(c):
        xs = draw_table(c, [("Наименование", "Ед. изм.", "Значение"), ("", "м²", "1234,5"), ("", "шт.", "7")], border=border)
        c.setFont("Noto", 10)
        _glyph_words(c, xs[0] + 4, YTOP - ROW_H - 11, ["Площадь", "застройки"], 2.2)
        _glyph_words(c, xs[0] + 4, YTOP - 2 * ROW_H - 11, ["Количество", "квартир"], 2.2)

    got = cands(make_pdf(tmp_path / "g.pdf", draw))
    assert got["M-001"].name_text == "Площадь застройки" and got["M-010"].value_num == 7


@pytest.mark.l1_functional
def test_helpers_edges_norm_center():
    assert T._edges([0, 0.5, 1.0, 2.5, 4.0]) == [0, 2.5, 4.0]
    assert T._norm((-10, 0, 700, 400), (0, 0, 600, 800)) == (0.0, 0.0, 1.0, 0.5)
    assert T._norm((1, 0, 3, 3), (0, 0, 3, 3)) == (0.33333, 0.0, 1.0, 1.0)
    box = (0, 0, 10, 10)
    for o in [(-1, 1, 1, 2), (9, 1, 11, 2), (4, -1, 6, 1), (4, 9, 6, 11)]:  # центр ровно на границе — внутри
        assert T._center_in(dict(zip(("x0", "top", "x1", "bottom"), o)), box)
    assert not T._center_in({"x0": 10, "top": 1, "x1": 12, "bottom": 2}, box)


@pytest.mark.l2_differential
@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_visible_box_with_shifted_mediabox(tmp_path, rotate):
    """MediaBox не от нуля: видимая область и bbox слова по-прежнему совпадают с parse (pdfium)."""
    import pdfplumber

    p = make_pdf(tmp_path / f"mb{rotate}.pdf", _upright(rotate, ytop=450, rows=TEP[:3]))
    with PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(str(p))
        pdf[0].set_mediabox(-40, -25, PW - 10, PH - 5)
        pdf[0].set_cropbox(-30, -15, PW - 20, PH - 30)
        if rotate:
            pdf[0].set_rotation(rotate)
        pdf.save(str(p.with_suffix(".x")))
        pdf.close()
    q = p.with_suffix(".x")
    ref = {w.text: w.bbox for ln in parse_file(q, "x").pages[0].lines for w in ln.words}
    with pdfplumber.open(str(q)) as pl:
        page = pl.pages[0]
        vis = T.visible_box(page)
        mine = {w["text"]: T._norm((w["x0"], w["top"], w["x1"], w["bottom"]), vis) for w in page.extract_words(x_tolerance=1.5)}
    for word in ("застройки", "1234,5"):
        assert near(mine[word], ref[word], tol=0.006), (word, mine[word], ref[word])


@pytest.mark.l7_discipline
def test_heavy_page_threshold_is_inclusive(tep_pdf, monkeypatch):
    import pdfplumber

    with pdfplumber.open(str(tep_pdf)) as pdf:
        n = len(pdf.pages[0].edges)
    monkeypatch.setattr(T, "MAX_EDGES", n)
    assert len(T.read_tables(tep_pdf)) == 1


@pytest.mark.l1_functional
def test_multi_page_and_pages_filter(tmp_path):
    def draw(c):
        draw_table(c, TEP[:2])
        c.showPage()
        draw_table(c, [TEP[0], TEP[5]])

    p = make_pdf(tmp_path / "mp.pdf", draw)
    assert [t.page for t in T.read_tables(p)] == [1, 2]
    assert [t.page for t in T.read_tables(p, pages=[2])] == [2]
    assert [c.param_code for c in T.table_candidates(p, SPECS, UNITS, pages=[2])] == ["M-007"]
    assert {c.param_code: c.page for c in T.table_candidates(p, SPECS, UNITS)} == {"M-001": 1, "M-007": 2}


@pytest.mark.l4_fault
def test_corrupted_pdf_message_names_file(tmp_path):
    p = tmp_path / "broken.pdf"
    p.write_bytes(b"%PDF-1.4 garbage")
    with pytest.raises(CorruptedFile, match="broken.pdf"):
        T.read_tables(p)


@pytest.mark.l1_functional
def test_misc_normalization_edges():
    assert T.normalize_cell("Площадь застрой-\r\nки") == ("Площадь застройки", "Площадь застрой-ки")
    assert T.normalize_cell("a\rb") == ("a b", "a b")
    assert T.normalize_cell("застрой-\rки")[0] == "застройки"
    assert T.canon_unit("м^2") == "м²"
    assert T.header_role("  №") == "skip"
    assert T._is_numbering([T.Cell(x, x, (0, 0, 1, 1), 0, k) for k, x in enumerate(("1", "2"))])


@pytest.mark.l4_fault
def test_row_with_unit_but_no_value_is_not_name_continuation():
    """Строка с единицей, но без значения — отдельный показатель, а не продолжение наименования соседней."""
    t = mk([("Наименование", "Ед. изм.", "Значение"), ("Строительный объем", "м³", ""), ("(Подземный)", "м³", "5")])
    assert T.link_table(t, SPECS, UNITS) == []


@pytest.mark.l1_functional
def test_borderless_table_bbox_three_by_three(tmp_path):
    rows = [("Наименование", "Ед. изм.", "Значение"), ("Площадь застройки", "м²", "1234,5"), ("Количество квартир", "шт.", "120")]
    p = make_pdf(tmp_path / "b33.pdf", lambda c: draw_table(c, rows, border=False))
    t = T.read_tables(p)[0]
    assert (t.strategy, len(t.grid), t.n_cols) == ("text", 3, 3)
    xs = _xs()
    right = xs[2] + 4 + pdfmetrics.stringWidth("Значение", "Noto", 10)
    assert near(t.bbox, (X0 / PW, (PH - YTOP) / PH, right / PW, (PH - YTOP + 2 * ROW_H + 14) / PH), tol=0.01)
    assert t.bbox[2] == pytest.approx(right / PW, abs=0.003)
    assert t.bbox[3] > (PH - YTOP + 2 * ROW_H) / PH
