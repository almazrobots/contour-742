"""T-127: основная надпись по ГОСТ Р 21.101-2020 (формы 3 и 5) — поиск, чтение граф, связка с реестром.

Листы — синтетика reportlab в tmp (ADR-0002). Положения текста заданы центрами ячеек по чертежам форм
приложения Ж, независимо от прямоугольников модуля: тест ловит ошибку сетки, а не повторяет её.
"""

from __future__ import annotations

from pathlib import Path

import pypdfium2 as pdfium
import pytest
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml import titleblock as tb
from inspector_ml.model import Line, Page, Word
from inspector_ml.parse import PDFIUM_LOCK, parse_pdf
from inspector_ml.paths import repo_root

if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(
        TTFont("Noto", str(repo_root() / "assets/fonts/NotoSans.ttf"))
    )

A3L = (420.0, 297.0)
A4P = (210.0, 297.0)
MM_PT = 72 / 25.4

# Центры ячеек в мм от левого верхнего угла надписи (чертежи форм 3 и 5).
LABELS3 = [
    ("Изм.", 5, 17.5),
    ("Кол.уч", 15, 17.5),
    ("Лист", 25, 17.5),
    ("№док.", 35, 17.5),
    ("Подп.", 47.5, 17.5),
    ("Дата", 60, 17.5),
    ("Разраб.", 7, 22.5),
    ("Н.контр.", 8, 52.5),
    ("Стадия", 142.5, 27.5),
    ("Лист", 157.5, 27.5),
    ("Листов", 175, 27.5),
]
LABELS5 = [
    ("Изм.", 5, 7.5),
    ("Кол.уч", 15, 7.5),
    ("Лист", 25, 7.5),
    ("№док.", 35, 7.5),
    ("Подп.", 47.5, 7.5),
    ("Дата", 60, 7.5),
    ("Разраб.", 7, 12.5),
    ("Н.контр.", 8, 37.5),
    ("Стадия", 142.5, 17.5),
    ("Лист", 157.5, 17.5),
    ("Листов", 175, 17.5),
]
POS3 = {
    "code": (125, 5),
    "enterprise": (125, 17.5),
    "building": (100, 32.5),
    "stage": (142.5, 35),
    "sheet": (157.5, 35),
    "sheets": (175, 35),
    "sheet_title": (100, 47.5),
    "org": (160, 47.5),
}
POS5 = {
    "code": (125, 7.5),
    "doc_title": (100, 27.5),
    "stage": (142.5, 22.5),
    "sheet": (157.5, 22.5),
    "sheets": (175, 22.5),
    "org": (160, 32.5),
}
LABELS6 = [("Изм.", 5, 12.5), ("Кол.уч", 15, 12.5), ("Лист", 25, 12.5), ("№док.", 35, 12.5), ("Подп.", 47.5, 12.5),
           ("Дата", 60, 12.5), ("Лист", 180, 3.5)]
POS6 = {"code": (120, 7.5), "sheet": (180, 11)}
CHANGE3_Y, CHANGE5_Y = 12.5, 2.5
CHANGE_X = {"izm": 5, "kol_uch": 15, "sheet": 25, "doc_no": 35, "date": 60}
HEIGHT = {3: 55.0, 5: 40.0, 6: 15.0}

VALUES3 = {
    "code": "СК2-Р-АР",
    "enterprise": "Жилой комплекс «Север»",
    "building": "Корпус 2",
    "stage": "Р",
    "sheet": "3",
    "sheets": "12",
    "sheet_title": "План 1-го этажа",
    "org": "ООО «Проект»",
}
VALUES5 = {
    "code": "СК5-П-ПЗ",
    "doc_title": "Пояснительная записка",
    "stage": "П",
    "sheet": "1",
    "sheets": "40",
    "org": "ООО «Проект»",
}
CHANGE = {"izm": "2", "kol_uch": "1", "sheet": "3", "doc_no": "15-25", "date": "03.25"}


def spec(
    form: int, values: dict, *, labels: bool = True, change: dict | None = None
) -> list[tuple[str, float, float]]:
    """Текст надписи: (строка, x, y) в мм от левого верхнего угла надписи."""
    pos = {3: POS3, 5: POS5, 6: POS6}[form]
    out = [(v, *pos[k]) for k, v in values.items()]
    if labels:
        out += {3: LABELS3, 5: LABELS5, 6: LABELS6}[form]
    if change:
        y = {3: CHANGE3_Y, 5: CHANGE5_Y, 6: 7.5}[form]
        out += [(v, CHANGE_X[k], y) for k, v in change.items()]
    return out


def page_of(
    size,
    items,
    form: int,
    *,
    margin=(5.0, 5.0),
    rotation: int = 0,
    conf: float | None = None,
) -> Page:
    """Страница model.Page со словами по спецификации — без PDF, для быстрых проверок и мутантов."""
    wmm, hmm = size
    ox, oy = wmm - margin[0] - 185, hmm - margin[1] - HEIGHT[form]
    lines = []
    for text, x, y in items:
        ws = []
        cx = ox + x - 0.8 * len(text) * (len(text.split()) - 1) / 2
        for part in text.split():
            half = 0.8 * len(part) / 2
            ws.append(
                Word(
                    text=part,
                    bbox=(
                        (cx - half) / wmm,
                        (oy + y - 1.2) / hmm,
                        (cx + half) / wmm,
                        (oy + y + 1.2) / hmm,
                    ),
                    conf=conf,
                )
            )
            cx += 0.8 * len(part) + 0.8
        lines.append(Line(text=text, words=ws))
    w, h = wmm * MM_PT, hmm * MM_PT  # как у pdfium: размер после /Rotate
    return Page(
        page=1, width=w, height=h, rotation=rotation, source="text", lines=lines
    )


def draw_sheet(
    path: Path, size, items, form: int | None, *, rotate: int = 0, margin=(5.0, 5.0)
) -> Path:
    """Лист с рамкой (поле слева 20 мм, остальные — margin) и надписью по сетке формы. form=None — без штампа."""
    wmm, hmm = size
    W, H = wmm * mm, hmm * mm
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1)
    if rotate:  # /Rotate 90: reportlab сам меняет стороны MediaBox (хранится «стоя»); рисуем в видимых координатах
        c.setPageRotation(90)
        c.transform(0, 1, -1, 0, H, 0)
    c.setLineWidth(0.8)
    c.rect(20 * mm, margin[1] * mm, W - (20 + margin[0]) * mm, H - (margin[1] + 5) * mm)
    c.setFont("Noto", 9)
    c.drawString(40 * mm, H - 40 * mm, "Экспликация помещений и примечания к плану")
    if form:
        sh = HEIGHT[form]
        sx, top = W - (margin[0] + 185) * mm, margin[1] * mm + sh * mm
        c.rect(sx, margin[1] * mm, 185 * mm, sh * mm)
        for dy in range(5, int(sh), 5):
            c.line(sx, top - dy * mm, sx + 65 * mm, top - dy * mm)
        for dx in (10, 20, 30, 40, 55, 65):
            c.line(sx + dx * mm, margin[1] * mm, sx + dx * mm, top)
        c.setFont("Noto", 7)
        for text, x, y in items:
            c.drawCentredString(sx + x * mm, top - y * mm - 2.5, text)
    c.showPage()
    c.save()
    return path


def parsed(path: Path) -> Page:
    return parse_pdf(path, "0" * 64).pages[0]


# ─────────────────────────────── геометрия и формы


@pytest.mark.l1_functional
def test_a3_landscape_form3_read_from_pdf(tmp_path):
    p = parsed(draw_sheet(tmp_path / "a3.pdf", A3L, spec(3, VALUES3, change=CHANGE), 3))
    block = tb.read_title_block(p)
    assert block is not None and block.form == 3
    for k, v in VALUES3.items():
        assert block.value(k) == v, k
    assert block.sheet_format == "A3"
    assert (
        block.corner_source == "default"
    )  # поля 5 мм — угол по ГОСТ, подписи его подтвердили
    assert block.changes == [
        {"izm": "2", "kol_uch": "1", "sheet": "3", "doc_no": "15-25", "date": "03.25"}
    ]
    assert block.title == "Жилой комплекс «Север». Корпус 2. План 1-го этажа"
    assert block.warnings == []
    # рамка кончается в 5 мм от правого и нижнего края
    assert block.frame_bbox[2] == pytest.approx(1 - 5 / 420, abs=1e-4)
    assert block.frame_bbox[3] == pytest.approx(1 - 5 / 297, abs=1e-4)
    # рамка значения — справа внизу листа, там, где её видит человек
    code = block.fields["code"]
    assert code.graph == 1 and code.confidence == pytest.approx(0.9)
    assert code.bbox[0] > (420 - 5 - 120) / 420 and code.bbox[1] > (297 - 5 - 55) / 297


@pytest.mark.l1_functional
def test_a4_portrait_form5_read_from_pdf(tmp_path):
    p = parsed(draw_sheet(tmp_path / "a4.pdf", A4P, spec(5, VALUES5, change=CHANGE), 5))
    block = tb.read_title_block(p)
    assert block is not None and block.form == 5
    for k, v in VALUES5.items():
        assert block.value(k) == v, k
    assert block.sheet_format == "A4"
    assert block.title == "Пояснительная записка"
    assert block.changes[0]["izm"] == "2"


@pytest.mark.l1_functional
def test_rotated_page_read_as_human_sees(tmp_path):
    path = draw_sheet(tmp_path / "rot.pdf", A3L, spec(3, VALUES3), 3, rotate=90)
    p = parsed(path)
    assert p.rotation == 90
    block = tb.read_title_block(p)
    assert block is not None and block.form == 3
    assert block.value("code") == "СК2-Р-АР" and block.value("sheet") == "3"
    assert block.sheet_format == "A3"


@pytest.mark.l1_functional
def test_sheet_without_title_block_abstains(tmp_path):
    p = parsed(draw_sheet(tmp_path / "none.pdf", A3L, [], None))
    d = tb.detect(p)
    assert d.block is None and d.reason == tb.NOT_FOUND
    assert tb.read_title_block(p) is None


@pytest.mark.l1_functional
def test_vector_frame_found_and_used(tmp_path):
    path = draw_sheet(
        tmp_path / "m10.pdf", A3L, spec(3, VALUES3), 3, margin=(10.0, 10.0)
    )
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        frame = tb.frame_from_pdf(doc[0])
        doc.close()
    assert frame is not None
    assert frame[2] == pytest.approx(1 - 10 / 420, abs=2e-3) and frame[
        3
    ] == pytest.approx(1 - 10 / 297, abs=2e-3)
    # рамка целиком: поле подшивки 20 мм слева, сверху 5 мм
    assert frame[0] == pytest.approx(20 / 420, abs=2e-3) and frame[1] == pytest.approx(5 / 297, abs=2e-3)
    block = tb.read_title_block(parsed(path), frame=frame)
    assert block.corner_source == "vector" and block.value("code") == "СК2-Р-АР"
    assert block.frame_bbox == frame


@pytest.mark.l1_functional
def test_vector_frame_on_rotated_page(tmp_path):
    path = draw_sheet(
        tmp_path / "rot.pdf", A3L, spec(3, VALUES3), 3, rotate=90, margin=(8.0, 8.0)
    )
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        frame = tb.frame_from_pdf(doc[0])
        doc.close()
    assert frame[2] == pytest.approx(1 - 8 / 420, abs=2e-3) and frame[
        3
    ] == pytest.approx(1 - 8 / 297, abs=2e-3)


@pytest.mark.l3_boundary
def test_no_vector_frame_on_empty_page(tmp_path):
    path = tmp_path / "empty.pdf"
    c = canvas.Canvas(str(path), pagesize=(420 * mm, 297 * mm))
    c.line(0, 0, 420 * mm, 0)  # линия обрезки по самому краю — не рамка
    c.showPage()
    c.save()
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        assert tb.frame_from_pdf(doc[0]) is None
        doc.close()


@pytest.mark.l1_functional
def test_nonstandard_margins_found_by_labels():
    p = page_of(A3L, spec(3, VALUES3), 3, margin=(12.0, 9.0))
    block = tb.read_title_block(p)
    assert block.corner_source == "labels"
    assert block.value("code") == "СК2-Р-АР" and block.value("org") == "ООО «Проект»"
    assert block.frame_bbox[2] == pytest.approx(1 - 12 / 420, abs=3e-3)
    assert block.frame_bbox[3] == pytest.approx(1 - 9 / 297, abs=3e-3)


@pytest.mark.l1_functional
def test_form5_distinguished_from_form3_by_labels():
    block = tb.read_title_block(page_of(A4P, spec(5, VALUES5), 5, margin=(7.0, 11.0)))
    assert block.form == 5 and block.value("sheets") == "40"


@pytest.mark.l3_boundary
def test_without_labels_values_on_gost_grid_accepted():
    block = tb.read_title_block(page_of(A3L, spec(3, VALUES3, labels=False), 3))
    assert block.form == 3 and block.corner_source == "default"
    assert block.value("stage") == "Р"
    assert block.warnings == ["подписи граф не найдены — угол рамки взят по полю листа ГОСТ"]
    assert block.fields["code"].confidence == pytest.approx(0.6)


@pytest.mark.l3_boundary
def test_without_labels_and_with_vector_frame():
    block = tb.read_title_block(
        page_of(A3L, spec(3, VALUES3, labels=False), 3, margin=(10.0, 10.0)),
        frame=(0.0, 0.0, 1 - 10 / 420, 1 - 10 / 297),
    )
    assert block.corner_source == "vector"
    assert block.warnings == ["подписи граф не найдены — угол рамки взят по векторной рамке"]


@pytest.mark.l6_adversarial
def test_without_labels_implausible_values_abstain():
    vals = {"code": "план", "stage": "", "sheet": "x"}
    d = tb.detect(
        page_of(A3L, spec(3, {k: v for k, v in vals.items() if v}, labels=False), 3)
    )
    assert d.block is None and d.reason == tb.NOT_FOUND


@pytest.mark.l6_adversarial
def test_single_label_not_enough():
    items = [("Стадия", 142.5, 27.5), ("случайный", 100, 32.5)]
    d = tb.detect(page_of(A3L, items, 3, margin=(30.0, 30.0)))
    assert d.block is None


@pytest.mark.l6_adversarial
def test_ambiguous_labels_abstain():
    # «Стадия» и «Листов» в одной строке, угол не совпадает с полем ГОСТ: подходят обе формы
    items = [("Стадия", 142.5, 27.5), ("Листов", 175, 27.5)]
    d = tb.detect(page_of(A3L, items, 3, margin=(20.0, 20.0)))
    assert d.block is None and d.reason == tb.LABELS_AMBIGUOUS


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "page,reason",
    [
        (
            Page(page=1, width=0, height=0, source="structured", lines=[]),
            tb.NO_GEOMETRY,
        ),
        (
            Page(
                page=1, width=100 * MM_PT, height=100 * MM_PT, source="text", lines=[]
            ),
            tb.TOO_SMALL,
        ),
        (
            Page(
                page=1, width=420 * MM_PT, height=297 * MM_PT, source="text", lines=[]
            ),
            tb.NO_WORDS,
        ),
    ],
)
def test_abstain_reasons(page, reason):
    d = tb.detect(page)
    assert d.block is None and d.reason == reason


@pytest.mark.l3_boundary
def test_size_threshold_exact():
    # 190 × 45 мм — ровно впритык: надпись 185 × 40 плюс 5 мм поля
    p = Page(
        page=1,
        width=190 * MM_PT,
        height=45 * MM_PT,
        source="text",
        lines=[Line(text="x", words=[Word(text="x", bbox=(0.1, 0.1, 0.2, 0.2))])],
    )
    assert tb.detect(p).reason != tb.TOO_SMALL
    p2 = p.model_copy(update={"width": 189.9 * MM_PT})
    assert tb.detect(p2).reason == tb.TOO_SMALL
    p3 = p.model_copy(update={"height": 44.9 * MM_PT})
    assert tb.detect(p3).reason == tb.TOO_SMALL


# ─────────────────────────────── проверки значений


@pytest.mark.l6_adversarial
def test_homoglyph_code_fixed_by_registry():
    vals = dict(VALUES3, code="CK2-P-AP")  # латиница вместо кириллицы
    block = tb.read_title_block(
        page_of(A3L, spec(3, vals), 3), registry=["СК2-Р-АР", "СК2-Р-КЖ"]
    )
    assert block.value("code") == "СК2-Р-АР"
    assert block.warnings == ["графа 1: шифр «CK2-P-AP» исправлен по реестру на «СК2-Р-АР»"]
    raw = tb.read_title_block(page_of(A3L, spec(3, vals), 3))
    assert raw.value("code") == "CK2-P-AP"
    ms = tb.compare_registry(raw, document_code="СК2-Р-АР", doc_stage="RD")
    assert [m.kind for m in ms] == ["code_homoglyph"]


@pytest.mark.l1_functional
def test_registry_code_already_exact_not_marked_corrected():
    block = tb.read_title_block(
        page_of(A3L, spec(3, VALUES3), 3), registry=["СК2-Р-АР"]
    )
    assert block.warnings == []


@pytest.mark.l1_functional
def test_stage_R_vs_registry_PD_warns():
    block = tb.read_title_block(page_of(A3L, spec(3, VALUES3), 3))
    ms = tb.compare_registry(
        block, document_code="СК2-Р-АР", doc_stage="PD", revision="1"
    )
    assert ms == [tb.Mismatch("stage", "Р", "П", "стадия штампа «Р» ≠ реестр «П» (PD)")]
    assert tb.compare_registry(block, document_code="СК2-Р-АР", doc_stage="RD") == []
    assert tb.compare_registry(block, document_code="СК2-Р-АР", doc_stage="ID") == []


@pytest.mark.l1_functional
def test_latin_stage_letter_normalized():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, stage="P")), 3))
    assert block.value("stage") == "Р" and block.warnings == []


@pytest.mark.l6_adversarial
def test_stage_outside_gost_list_warns():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, stage="ЭП")), 3))
    assert block.value("stage") == "ЭП"
    assert block.warnings == ["графа 6: стадия «ЭП» вне перечня ГОСТ (П, Р, И)"]
    assert block.fields["stage"].confidence == pytest.approx(0.45)


@pytest.mark.l6_adversarial
def test_sheet_over_count_warns():
    block = tb.read_title_block(
        page_of(A3L, spec(3, dict(VALUES3, sheet="15", sheets="12")), 3)
    )
    assert block.warnings == ["лист 15 больше числа листов 12"]
    assert block.fields["sheet"].confidence == pytest.approx(0.45)
    ms = tb.compare_registry(block, document_code="СК2-Р-АР", doc_stage="RD")
    assert ms == [tb.Mismatch("sheet_count", "15/12", None, "лист 15 больше числа листов 12")]


@pytest.mark.l3_boundary
def test_sheet_equal_count_ok():
    block = tb.read_title_block(
        page_of(A3L, spec(3, dict(VALUES3, sheet="12", sheets="12")), 3)
    )
    assert block.warnings == []


@pytest.mark.l6_adversarial
def test_non_numeric_sheet_and_bad_code_warn():
    block = tb.read_title_block(
        page_of(A3L, spec(3, dict(VALUES3, sheet="III", code="План этажа")), 3)
    )
    assert "графа 7: «III» — не номер листа" in block.warnings
    assert "графа 1: «План этажа» не похоже на обозначение документа" in block.warnings
    assert block.fields["code"].confidence == pytest.approx(0.45)


@pytest.mark.l3_boundary
def test_empty_cells_keep_cell_bbox_and_none():
    vals = {k: v for k, v in VALUES3.items() if k not in ("sheets", "org")}
    block = tb.read_title_block(page_of(A3L, spec(3, vals), 3))
    f = block.fields["sheets"]
    assert f.value is None and f.graph == 8
    # пустая графа — её ячейка: 165…185 мм по ширине надписи, 30…40 мм по высоте
    ox, oy = 420 - 5 - 185, 297 - 5 - 55
    assert f.bbox == pytest.approx(
        ((ox + 165) / 420, (oy + 30) / 297, (ox + 185) / 420, (oy + 40) / 297), abs=1e-4
    )


@pytest.mark.l1_functional
def test_ocr_confidence_scales_field_confidence():
    block = tb.read_title_block(page_of(A3L, spec(3, VALUES3), 3, conf=80.0))
    assert block.fields["code"].confidence == pytest.approx(0.72)


@pytest.mark.l6_adversarial
def test_code_token_extracted_from_noisy_graph1():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code="Заказчик: ООО С-22-2025 «Бюро»")), 3))
    assert block.value("code") == "С-22-2025"
    assert block.warnings == ["графа 1: шифр «С-22-2025» выделен из строки «Заказчик: ООО С-22-2025 «Бюро»»"]
    assert block.fields["code"].confidence == pytest.approx(0.45)


@pytest.mark.l1_functional
def test_code_with_underscore_and_slash_accepted():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code="17_ПД/25-СГ")), 3))
    assert block.value("code") == "17_ПД/25-СГ" and block.warnings == []


@pytest.mark.l6_adversarial
def test_drawing_text_above_stamp_not_read():
    # над надписью — примечания чертежа; графа 27 не читается, в графу 1 текст не попадает
    items = spec(3, VALUES3) + [("ГОСТ 14098-2014.", 125, -5)]
    block = tb.read_title_block(page_of(A3L, items, 3))
    assert block.value("code") == "СК2-Р-АР" and "customer" not in block.fields


@pytest.mark.l1_functional
def test_split_n_kontr_label_counts():
    items = [
        x for x in spec(3, VALUES3) if x[0] not in ("Н.контр.", "Разраб.", "Изм.")
    ] + [("Н. контр.", 8, 52.5)]
    items = [x for x in items if x[0] not in ("Листов",)]
    # остались «Стадия» и «Н. контр.» (двумя словами); поле 20 мм — только подписи дают угол
    block = tb.read_title_block(page_of(A3L, items, 3, margin=(20.0, 20.0)))
    assert (
        block is not None
        and block.corner_source == "labels"
        and block.value("code") == "СК2-Р-АР"
    )


@pytest.mark.l1_functional
def test_change_rows_without_izm_skipped():
    block = tb.read_title_block(
        page_of(A3L, spec(3, VALUES3, change={"kol_uch": "1", "date": "03.25"}), 3)
    )
    assert block.changes == []


# ─────────────────────────────── связка с реестром


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "stamp,registry,kinds",
    [
        ("СК2-Р-АР", "СК2-Р-АР", []),
        ("СК2-Р-АР.3", "СК2-Р-АР", []),  # суффикс листа
        ("СК2-Р-АРХ", "СК2-Р-АР", ["code"]),  # не суффикс — другой шифр
        ("СК2-Р-КЖ", "СК2-Р-АР", ["code"]),
        ("ск2-р-ар", "СК2-Р-АР", ["code_homoglyph"]),
    ],
)
def test_compare_code(stamp, registry, kinds):
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code=stamp)), 3))
    assert [m.kind for m in tb.compare_registry(block, document_code=registry)] == kinds


@pytest.mark.l3_boundary
def test_compare_empty_code():
    vals = {k: v for k, v in VALUES3.items() if k != "code"}
    block = tb.read_title_block(page_of(A3L, spec(3, vals), 3))
    ms = tb.compare_registry(block, document_code="СК2-Р-АР")
    assert ms == [tb.Mismatch("code", None, "СК2-Р-АР", "графа 1 пуста — шифр со штампа не прочитан")]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "revision,warn",
    [("1", True), ("2", False), ("3", False), ("C", False), (None, False)],
)
def test_compare_revision(revision, warn):
    block = tb.read_title_block(
        page_of(A3L, spec(3, VALUES3, change=CHANGE), 3)
    )  # в штампе изменение 2
    ms = tb.compare_registry(
        block, document_code="СК2-Р-АР", doc_stage="RD", revision=revision
    )
    assert ([m.kind for m in ms] == ["revision"]) is warn
    if warn:
        assert ms[0].stamp == "2" and ms[0].registry == "1"


# ─────────────────────────────── чистые функции


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "w,h,name",
    [
        (420, 297, "A3"),
        (297, 420, "A3"),
        (210, 297, "A4"),
        (841, 1189, "A0"),
        (594, 841, "A1"),
        (420, 594, "A2"),
        (297, 630, "A4x3"),
        (420, 891, "A3x3"),
        (212.9, 297, "A4"),
        (213.1, 297, None),
        (500, 500, None),
    ],
)
def test_sheet_format(w, h, name):
    assert tb.sheet_format(w, h) == name


@pytest.mark.l3_boundary
def test_page_mm_is_visible_size_regardless_of_rotation():
    # pdfium отдаёт размер после /Rotate: Page.width/height — уже видимые стороны
    p = Page(page=1, width=200 * MM_PT, height=100 * MM_PT, rotation=90, source="text", lines=[])
    assert tb.page_mm(p) == pytest.approx((200, 100))


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "raw,want",
    [
        ("Р", "Р"),
        ("p", "Р"),
        (" П ", "П"),
        ("i", "И"),
        ("", None),
        (None, None),
        ("  ", None),
    ],
)
def test_norm_stage(raw, want):
    assert tb.norm_stage(raw) == want


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "text,key",
    [
        ("Изм.", "изм"),
        ("Стадия", "стадия"),
        ("Листов", "листов"),
        ("Разраб.", "разраб"),
        ("Разработал", "разраб"),
        ("Н.контр.", "н контр"),
        ("Нормоконтроль", "н контр"),
        ("Лист", "лист"),
        ("Дата", "дата"),
        ("Норм.контр.", "н контр"),
        ("Нормоконтр.", "н контр"),
        ("N док.", "док"),
        ("№До", "док"),
        ("N До", "док"),
        ("Кол.уч", "кол"),
        ("№док.", "док"),
        ("№ докум.", "док"),
        ("Подпись", "подп"),
        ("План", None),
        ("Р", None),
    ],
)
def test_label_key(text, key):
    assert tb._label_key(text) == key


@pytest.mark.l6_adversarial
def test_values_plausible_in_both_forms_abstain():
    # без подписей и шифра: стадия и лист на 17,5 мм от низа попадают в графы 6–7 обеих форм
    d = tb.detect(page_of(A3L, [("Р", 142.5, 37.5), ("3", 157.5, 37.5)], 3))
    assert d.block is None and d.reason == tb.VALUES_AMBIGUOUS


def _lines_pdf(path: Path, *, frame_as_lines: bool) -> Path:
    W, H = 420 * mm, 297 * mm
    c = canvas.Canvas(str(path), pagesize=(W, H))
    x1, y0 = W - 6 * mm, 6 * mm
    if frame_as_lines:  # рамка четырьмя отрезками, как в выгрузке CAD
        c.line(20 * mm, y0, x1, y0)
        c.line(x1, y0, x1, H - 5 * mm)
        c.line(20 * mm, H - 5 * mm, x1, H - 5 * mm)
        c.line(20 * mm, y0, 20 * mm, H - 5 * mm)
    c.line(W - 40 * mm, 50 * mm, W - 40 * mm, 60 * mm)  # короткая вертикаль — не рамка
    c.line(100 * mm, 40 * mm, 110 * mm, 40 * mm)  # короткая горизонталь — не рамка
    c.showPage()
    c.save()
    return path


@pytest.mark.l1_functional
def test_vector_frame_from_separate_lines(tmp_path):
    path = _lines_pdf(tmp_path / "lines.pdf", frame_as_lines=True)
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        frame = tb.frame_from_pdf(doc[0])
        capped = tb.frame_from_pdf(doc[0], max_objects=1)  # первый путь — нижняя сторона, правой нет
        two = tb.frame_from_pdf(doc[0], max_objects=2)  # нижняя и правая — угол есть
        doc.close()
    assert frame[2] == pytest.approx(1 - 6 / 420, abs=2e-3) and frame[3] == pytest.approx(1 - 6 / 297, abs=2e-3)
    assert capped is None  # предел числа объектов — дальше пути не читаются
    assert two is not None and two[2] == pytest.approx(frame[2]) and two[0] == 0.0


@pytest.mark.l3_boundary
def test_vector_frame_short_lines_ignored(tmp_path):
    path = _lines_pdf(tmp_path / "short.pdf", frame_as_lines=False)
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        assert tb.frame_from_pdf(doc[0]) is None
        doc.close()


@pytest.mark.l1_functional
def test_form6_subsequent_sheet_from_pdf(tmp_path):
    # последующий лист текстового документа: надпись 185 × 15, шифр и номер листа
    items = spec(6, {"code": "СК5-П-ПЗ", "sheet": "7"}, change={"izm": "1", "doc_no": "3-25"})
    block = tb.read_title_block(parsed(draw_sheet(tmp_path / "f6.pdf", A4P, items, 6)))
    assert block.form == 6
    assert block.value("code") == "СК5-П-ПЗ" and block.value("sheet") == "7"
    assert set(block.fields) == {"code", "sheet"}
    assert block.changes == [{"izm": "1", "doc_no": "3-25"}]
    assert block.title is None


@pytest.mark.l1_functional
def test_frame_confirmed_by_right_labels_beats_shifted_left_rows():
    # у организации строки левой части сдвинуты на 5 мм вниз: шапка «Изм.» ложится в сетку формы 5,
    # но «Стадия/Лист/Листов» при угле рамки — на месте формы 3; рамка важнее
    shifted = [(t, x, y + 5 if x < 65 else y) for t, x, y in spec(3, VALUES3)]
    block = tb.read_title_block(page_of(A3L, shifted, 3), frame=(0.0, 0.0, 1 - 5 / 420, 1 - 5 / 297))
    assert block.form == 3 and block.corner_source == "vector" and block.value("stage") == "Р"


@pytest.mark.l6_adversarial
def test_table_labels_mid_sheet_not_a_stamp():
    # шапка «Изм. Лист № док.» в таблице посреди листа: угол по ней — далеко от края, это не штамп
    items = [(t, x - 150, y - 150) for t, x, y in spec(3, VALUES3)]
    d = tb.detect(page_of(A3L, items, 3))
    assert d.block is None and d.reason == tb.NOT_FOUND


@pytest.mark.l3_boundary
@pytest.mark.parametrize("dx,dy,ok", [(0, 0, True), (30, 30, True), (30.5, 0, False), (0, 30.5, False), (-0.5, 0, False), (0, -0.5, False)])
def test_near_corner(dx, dy, ok):
    assert tb._near_corner((420 - dx, 297 - dy), (420, 297)) is ok


@pytest.mark.l1_functional
def test_compare_mismatch_messages():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code="СК2-Р-КЖ"), change=CHANGE), 3))
    ms = tb.compare_registry(block, document_code="СК2-Р-АР", revision="1")
    assert ms == [
        tb.Mismatch("code", "СК2-Р-КЖ", "СК2-Р-АР", "шифр штампа «СК2-Р-КЖ» ≠ реестр «СК2-Р-АР»"),
        tb.Mismatch("revision", "2", "1", "в штампе изменение 2, в реестре редакция 1"),
    ]
    homo = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code="CK2-P-AP")), 3))
    assert tb.compare_registry(homo, document_code="СК2-Р-АР") == [
        tb.Mismatch("code_homoglyph", "CK2-P-AP", "СК2-Р-АР", "шифр совпал после приведения похожих знаков")]


@pytest.mark.l1_functional
@pytest.mark.parametrize("stamp,registry,kinds", [
    ("АНО/150321/1-РД-ОВ2.1", "АНО-150321-1-РД-ОВ2.1", ["code_homoglyph"]),  # «/» в имени файла невозможен
    ("СК2-Р-АР-3", "СК2-Р-АР", []),
    ("СК2-Р-АР/3", "СК2-Р-АР", []),
    ("СК2-Р-АР3", "СК2-Р-АР", ["code"]),
])
def test_compare_code_separators(stamp, registry, kinds):
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code=stamp)), 3))
    assert [m.kind for m in tb.compare_registry(block, document_code=registry)] == kinds


@pytest.mark.l3_boundary
def test_compare_sheet_equal_count_no_mismatch():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, sheet="12", sheets="12")), 3))
    assert tb.compare_registry(block, document_code="СК2-Р-АР") == []


@pytest.mark.l3_boundary
def test_width_without_height_has_no_geometry():
    p = Page(page=1, width=420 * MM_PT, height=0, source="text", lines=[])
    assert tb.detect(p).reason == tb.NO_GEOMETRY


@pytest.mark.l1_functional
def test_vector_frame_x_used_for_narrow_cells():
    # рамка в 20 мм от правого края: по полю ГОСТ ячейка «Листов» (20 мм) промахнулась бы
    frame = (20 / 420, 5 / 297, 1 - 25 / 420, 1 - 5 / 297)
    block = tb.read_title_block(page_of(A3L, spec(3, VALUES3, labels=False), 3, margin=(25.0, 5.0)), frame=frame)
    assert block.value("sheets") == "12" and block.value("stage") == "Р"
    assert block.frame_bbox == frame


@pytest.mark.l6_adversarial
def test_misplaced_vector_frame_overruled_by_labels():
    # векторная «рамка» — не та линия (в 25 мм от края): подписи находят настоящий угол, рамка в ответ не идёт
    frame = (0.0, 0.0, 1 - 25 / 420, 1 - 25 / 297)
    block = tb.read_title_block(page_of(A3L, spec(3, VALUES3), 3, margin=(12.0, 9.0)), frame=frame)
    assert block.corner_source == "labels" and block.value("sheets") == "12"
    assert block.frame_bbox[2] == pytest.approx(1 - 12 / 420, abs=1e-4)


@pytest.mark.l1_functional
def test_form6_without_labels_by_values():
    # последующий лист без подписей: шифр и номер листа правдоподобны только в форме 6
    block = tb.read_title_block(page_of(A4P, spec(6, {"code": "СК5-П-ПЗ", "sheet": "7"}, labels=False), 6))
    assert block.form == 6 and block.value("sheet") == "7"


@pytest.mark.l1_functional
def test_all_change_rows_read_in_order():
    # значения у верхних границ строк (0, 5, 10 мм): сетка строк 5 мм, без сдвига
    items = spec(3, VALUES3) + [("1", 5, 0.5), ("Зам.", 15, 0.5), ("2", 5, 5.5), ("Нов.", 15, 5.5), ("3", 5, 10.5)]
    block = tb.read_title_block(page_of(A3L, items, 3))
    assert block.changes == [{"izm": "1", "kol_uch": "Зам."}, {"izm": "2", "kol_uch": "Нов."}, {"izm": "3"}]


@pytest.mark.l1_functional
def test_labels_median_refines_corner():
    # подписи набраны неровно (±1 мм от центров ячеек): угол — медиана, а не первая попавшаяся подпись
    jitter = [1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.5, -0.5]
    items = [(t, x + jitter[i], y) for i, (t, x, y) in enumerate(LABELS3)]
    items += [(v, *POS3[k]) for k, v in VALUES3.items()]
    block = tb.read_title_block(page_of(A3L, items, 3, margin=(12.0, 9.0)))
    assert block.corner_source == "labels"
    assert block.frame_bbox[2] * 420 == pytest.approx(420 - 12, abs=0.3)


@pytest.mark.l6_adversarial
def test_table_labels_before_stamp_do_not_stop_search():
    # таблица с «Изм. Лист» посреди листа идёт в тексте раньше штампа — её гипотезы отбрасываются, не обрывая поиск
    table = [(t, x - 150, y - 150) for t, x, y in LABELS3]
    block = tb.read_title_block(page_of(A3L, table + spec(3, VALUES3), 3, margin=(12.0, 9.0)))
    assert block.corner_source == "labels" and block.value("code") == "СК2-Р-АР"


# ─────────────────────────────── выбор гипотезы и чистые функции


def cand(score, n, src, form=tb.FORM3):
    return tb._Cand(score, n, tb.RANK[src], form, (0.0, 0.0), src)


@pytest.mark.l3_boundary
def test_pick_vector_kept_at_share_boundary():
    v = cand(6, 2, "vector")
    lab = cand(8, 4, "labels", tb.FORM5)
    assert tb._pick([v, lab])[0] is v  # 6 ≥ 0,75 × 8
    lab9 = cand(9, 4, "labels", tb.FORM5)
    assert tb._pick([v, lab9])[0] is lab9  # 6 < 0,75 × 9


@pytest.mark.l3_boundary
def test_pick_vector_needs_right_label_and_two_labels():
    only_left = cand(3, 3, "vector")  # три подписи левой части: score == n
    lab = cand(4, 4, "labels", tb.FORM5)
    assert tb._pick([only_left, lab])[0] is lab
    one = cand(3, 1, "vector")  # одна подпись, пусть и правой части
    lab3 = cand(4, 2, "labels", tb.FORM5)
    assert tb._pick([one, lab3])[0] is lab3
    two = cand(4, 2, "vector")
    assert tb._pick([two, lab3])[0] is two


@pytest.mark.l3_boundary
def test_pick_default_not_protected_like_vector():
    d = cand(6, 2, "default")
    lab = cand(7, 3, "labels", tb.FORM5)
    assert tb._pick([d, lab])[0] is lab


@pytest.mark.l3_boundary
def test_pick_rank_breaks_ties_and_rival_detected():
    d = cand(6, 2, "default")
    lab = cand(6, 2, "labels", tb.FORM5)
    best, rival = tb._pick([lab, d])
    assert best is d and rival is False
    other = cand(6, 2, "default", tb.FORM5)
    assert tb._pick([d, other])[1] is True
    same_form = cand(6, 2, "default")
    assert tb._pick([d, same_form])[1] is False


@pytest.mark.l3_boundary
def test_weight_split_at_left_part():
    p = (0.0, 0.0)
    assert tb._weight([(p, (55, 15, 65, 20))]) == 1
    assert tb._weight([(p, (135, 25, 150, 30))]) == 3
    assert tb._weight([]) == 0


@pytest.mark.l3_boundary
@pytest.mark.parametrize("p,slack,ok", [
    ((10, 20), 0.0, True), ((30, 40), 0.0, True), ((9.9, 25), 0.0, False), ((30.1, 25), 0.0, False),
    ((20, 19.9), 0.0, False), ((20, 40.1), 0.0, False), ((8.5, 18.5), 1.5, True), ((31.5, 41.5), 1.5, True),
    ((8.4, 25), 1.5, False), ((20, 41.6), 1.5, False),
])
def test_inside(p, slack, ok):
    assert tb._inside(p, (10, 20, 30, 40), slack) is ok


def _w(text, x_mm, y_mm, size=A3L):
    return Word(text=text, bbox=((x_mm - 2) / size[0], (y_mm - 1) / size[1], (x_mm + 2) / size[0], (y_mm + 1) / size[1]))


@pytest.mark.l3_boundary
@pytest.mark.parametrize("dx,dy,found", [(8, 0, True), (14.9, 1.9, True), (15, 0, False), (0, 0, False),
                                         (-3, 0, False), (8, 2, False), (8, -1.9, True)])
def test_split_n_kontr_geometry(dx, dy, found):
    words = [_w("Н.", 100, 100), _w("контр.", 100 + dx, 100 + dy)]
    got = [k for k, _ in tb._labels(words, *A3L)]
    assert ("н контр" in got) is found


@pytest.mark.l3_boundary
def test_split_n_kontr_center_between_words():
    words = [_w("Н.", 100, 100), _w("контр.", 108, 100)]
    assert tb._labels(words, *A3L) == [("н контр", pytest.approx((104, 100)))]


@pytest.mark.l1_functional
def test_join_reading_order():
    # вторая строка ниже на 3 мм; в первой строке центры гуляют на 1 мм
    ws = [_w("строка", 120, 103), _w("Вторая", 100, 103.2), _w("первой", 120, 100.8), _w("Конец", 100, 100)]
    assert tb._join(ws, *A3L) == "Конец первой Вторая строка"


@pytest.mark.l3_boundary
def test_words_skip_missing_bbox_and_blank():
    page = Page(page=1, width=1, height=1, source="text", lines=[Line(text="a b", words=[
        Word(text="a", bbox=None), Word(text=" ", bbox=(0, 0, 1, 1)), Word(text="c", bbox=(0, 0, 1, 1))])])
    assert [w.text for w in tb._words(page)] == ["c"]


@pytest.mark.l3_boundary
@pytest.mark.parametrize("text,label", [("Изм.", True), ("пров", True), ("Формат", True), ("План", False), ("2", False)])
def test_is_label(text, label):
    assert tb._is_label(text) is label


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("code,want", [
    ("Б-1 А-22-33 шифр", "А-22-33"),  # самое длинное похожее слово, а не последнее по алфавиту
    ("«СК2-Р-АР»,", "СК2-Р-АР"),  # кавычки и запятая не часть шифра
    ("(ПК1.2-КЖ)", "ПК1.2-КЖ"),
])
def test_code_token_choice(code, want):
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, code=code)), 3))
    assert block.value("code") == want


@pytest.mark.l3_boundary
@pytest.mark.parametrize("w,h,name", [
    (213, 297, "A4"), (210, 300, "A4"), (213.01, 297, None), (300, 630, "A4x3"), (297, 639, "A4x3"),
    (297, 639.1, None), (1189, 1682, "A0x2"), (297, 1890, "A4x9"), (297, 2100, None), (297, 420.5, "A3"),
])
def test_sheet_format_tolerances(w, h, name):
    assert tb.sheet_format(w, h) == name


# ─────────────────────────────── векторная рамка: чистая функция


def box(x0, y0, x1, y1, size=A3L):
    """Прямоугольник в мм → доли листа."""
    return (x0 / size[0], y0 / size[1], x1 / size[0], y1 / size[1])


@pytest.mark.l1_functional
def test_frame_from_boxes_lines_and_rect():
    lines = [box(20, 5, 20.5, 292), box(414, 5, 414.5, 292), box(20, 5, 415, 5.5), box(20, 291.5, 415, 292)]
    f = tb.frame_from_boxes(lines, *A3L)
    assert f == pytest.approx((20.25 / 420, 5.25 / 297, 414.25 / 420, 291.75 / 297))
    rect = [box(20, 5, 415, 292)]
    assert tb.frame_from_boxes(rect, *A3L) == pytest.approx((20 / 420, 5 / 297, 415 / 420, 292 / 297))


@pytest.mark.l3_boundary
@pytest.mark.parametrize("thick,ok", [(1.9, True), (2.01, False)])
def test_frame_line_thickness(thick, ok):
    lines = [box(414, 100, 414 + thick, 200), box(100, 290, 300, 290 + thick)]
    assert (tb.frame_from_boxes(lines, *A3L) is not None) is ok


@pytest.mark.l3_boundary
@pytest.mark.parametrize("share,ok", [(0.3, True), (0.29, False)])
def test_frame_line_length(share, ok):
    lines = [box(414, 10, 414.2, 10 + share * 297 + 0.01), box(10, 290, 10 + share * 420 + 0.01, 290.2)]
    assert (tb.frame_from_boxes(lines, *A3L) is not None) is ok


@pytest.mark.l3_boundary
@pytest.mark.parametrize("share,ok", [(0.5, True), (0.49, False)])
def test_frame_rect_size(share, ok):
    # замкнутый контур: и по ширине, и по высоте ≥ половины листа
    r = [box(415 - share * 420 - 0.01, 292 - share * 297 - 0.01, 415, 292)]
    assert (tb.frame_from_boxes(r, *A3L) is not None) is ok
    wide = [box(10, 250, 415, 292)]  # широкий, но низкий — штамп или таблица, не рамка
    assert tb.frame_from_boxes(wide, *A3L) is None


@pytest.mark.l3_boundary
@pytest.mark.parametrize("gap,ok", [(2.01, True), (1.9, False), (29.99, True), (30.1, False)])
def test_frame_distance_from_edge(gap, ok):
    lines = [box(420 - gap, 10, 420 - gap, 200), box(10, 287, 300, 287)]
    got = tb.frame_from_boxes(lines, *A3L)
    assert (got is not None) is ok
    lines = [box(410, 10, 410, 200), box(10, 297 - gap, 300, 297 - gap)]
    assert (tb.frame_from_boxes(lines, *A3L) is not None) is ok


@pytest.mark.l3_boundary
def test_frame_rightmost_and_bottom_most_taken():
    lines = [box(400, 10, 400, 200), box(410, 10, 410, 200), box(10, 280, 300, 280), box(10, 287, 300, 287),
             box(25, 10, 25, 200), box(20, 10, 20, 200), box(10, 12, 300, 12), box(10, 8, 300, 8)]
    assert tb.frame_from_boxes(lines, *A3L) == pytest.approx((20 / 420, 8 / 297, 410 / 420, 287 / 297))


@pytest.mark.l3_boundary
def test_frame_without_left_top_goes_to_page_edge():
    lines = [box(410, 10, 410, 200), box(10, 287, 300, 287)]
    assert tb.frame_from_boxes(lines, *A3L) == pytest.approx((0.0, 0.0, 410 / 420, 287 / 297))
    assert tb.frame_from_boxes([box(410, 10, 410, 200)], *A3L) is None
    assert tb.frame_from_boxes([box(10, 287, 300, 287)], *A3L) is None


@pytest.mark.l3_boundary
def test_inside_default_is_strict():
    assert tb._inside((9.5, 25), (10, 20, 30, 40)) is False


@pytest.mark.l3_boundary
def test_inliers_use_slack():
    # «Стадия» на 1 мм левее своей ячейки — в допуске SLACK
    corner = (415.0, 292.0)
    ox, oy = corner[0] - 185, corner[1] - 55
    got = tb._inliers([("стадия", (ox + 134.0, oy + 27.5))], corner, tb.FORM3)
    assert got == [((ox + 134.0, oy + 27.5), (135, 25, 150, 30))]
    assert tb._inliers([("стадия", (ox + 133.0, oy + 27.5))], corner, tb.FORM3) == []


@pytest.mark.l3_boundary
def test_split_n_kontr_small_gap():
    words = [_w("Н.", 100, 100), _w("контр.", 100.5, 100)]
    assert [k for k, _ in tb._labels(words, *A3L)] == ["н контр"]


@pytest.mark.l1_functional
def test_rank_resolves_same_score_between_forms():
    # только «Стадия» и «Листов» при поле ГОСТ: форма 3 по полю и форма 5 по подписям набирают поровну,
    # решает способ: угол по полю ГОСТ надёжнее угла, подогнанного под подписи
    items = [x for x in spec(3, VALUES3) if x[0] in ("Стадия", "Листов") or x[1] > 60]
    block = tb.read_title_block(page_of(A3L, [x for x in items if x[0] != "Лист"], 3))
    assert block.form == 3 and block.corner_source == "default"


@pytest.mark.l1_functional
def test_value_bbox_is_union_of_words():
    page = page_of(A3L, spec(3, VALUES3), 3)
    block = tb.read_title_block(page)
    ws = [w for ln in page.lines if ln.text == VALUES3["enterprise"] for w in ln.words]  # три слова
    want = (min(w.bbox[0] for w in ws), min(w.bbox[1] for w in ws), max(w.bbox[2] for w in ws), max(w.bbox[3] for w in ws))
    assert block.fields["enterprise"].bbox == want
    assert tb._union([(0.1, 0.5, 0.2, 0.6), (0.3, 0.4, 0.35, 0.45)]) == (0.1, 0.4, 0.35, 0.6)
    assert block.frame_bbox[:2] == (0.0, 0.0)


@pytest.mark.l6_adversarial
def test_non_numeric_sheets_count_warns():
    block = tb.read_title_block(page_of(A3L, spec(3, dict(VALUES3, sheets="XII")), 3))
    assert block.warnings == ["графа 8: «XII» — не номер листа"]


@pytest.mark.l3_boundary
@pytest.mark.parametrize("vert,horiz,ok", [(True, True, True), (False, True, False), (True, False, False)])
def test_frame_needs_long_right_and_bottom(vert, horiz, ok):
    v = box(414, 10, 414.2, 10 + (0.3 if vert else 0.29) * 297 + 0.01)
    h = box(10, 290, 10 + (0.3 if horiz else 0.29) * 420 + 0.01, 290.2)
    assert (tb.frame_from_boxes([v, h], *A3L) is not None) is ok


@pytest.mark.l3_boundary
@pytest.mark.parametrize("axis", ["v", "h"])
def test_frame_thick_line_rejected_per_axis(axis):
    v = box(414, 100, 414 + (2.01 if axis == "v" else 0.2), 200)
    h = box(100, 290, 300, 290 + (2.01 if axis == "h" else 0.2))
    assert tb.frame_from_boxes([v, h], *A3L) is None


@pytest.mark.l3_boundary
@pytest.mark.parametrize("w,h,ok", [(0.5, 0.5, True), (0.49, 0.6, False), (0.6, 0.49, False)])
def test_frame_rect_both_sides(w, h, ok):
    r = [box(415 - w * 420 - 0.01, 292 - h * 297 - 0.01, 415, 292)]
    assert (tb.frame_from_boxes(r, *A3L) is not None) is ok


@pytest.mark.l1_functional
def test_frame_rect_after_lines_keeps_lines():
    lines = [box(414, 10, 414, 200), box(10, 290, 300, 290), box(25, 20, 413, 280)]  # линии, затем контур
    assert tb.frame_from_boxes(lines, *A3L) == pytest.approx((25 / 420, 20 / 297, 414 / 420, 290 / 297))


@pytest.mark.l3_boundary
@pytest.mark.parametrize("pos,ok", [(2.5, True), (1.9, False), (29.9, True), (30.1, False)])
def test_frame_left_and_top_limits(pos, ok):
    lines = [box(410, 10, 410, 200), box(10, 287, 300, 287), box(pos, 10, pos, 200), box(10, pos, 300, pos)]
    f = tb.frame_from_boxes(lines, *A3L)
    assert (f[0] == pytest.approx(pos / 420)) is ok and (f[1] == pytest.approx(pos / 297)) is ok


@pytest.mark.l6_adversarial
def test_frame_ignores_text_objects(tmp_path):
    # мелкая длинная строка под рамкой (как «Формат А3» и копирайт) — текст, а не линия рамки
    path = tmp_path / "txt.pdf"
    W, H = 420 * mm, 297 * mm
    c = canvas.Canvas(str(path), pagesize=(W, H))
    c.rect(20 * mm, 8 * mm, W - 28 * mm, H - 13 * mm)
    c.setFont("Noto", 4)
    c.drawString(60 * mm, 3.5 * mm, "Копировал " * 40)
    c.showPage()
    c.save()
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        frame = tb.frame_from_pdf(doc[0])
        doc.close()
    assert frame[3] == pytest.approx(1 - 8 / 297, abs=2e-3)  # толщина линии даёт до 0,4 мм
