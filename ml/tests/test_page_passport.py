"""T-216: паспорт страницы до распознавания (OS-INSP-2.1.70–2.1.77).

Все листы — синтетика reportlab прямо в тесте (ADR-0002: корпус — никогда): известные формат, текст, пути, картинки,
поля формы и цвет."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest
from PIL import Image
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml import page_passport as pp
from inspector_ml.parse import PDFIUM_LOCK, CorruptedFile
from inspector_ml.paths import repo_root

FONT = repo_root() / "assets/fonts/NotoSans.ttf"
if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(TTFont("Noto", str(FONT)))

TEXT_LINES = [
    "Акт освидетельствования скрытых работ № 17",
    "Воздуховод прямоугольный 500x300 мм, сталь оцинкованная",
    "Монтаж выполнен в соответствии с проектной документацией",
]


def _pdf(tmp_path: Path, draw, size=A4, name="p.pdf", rotate: int = 0) -> Path:
    p = tmp_path / name
    c = canvas.Canvas(str(p), pagesize=size)
    if rotate:
        c.setPageRotation(rotate)
    draw(c)
    c.showPage()
    c.save()
    return p


def _one(path: Path) -> dict:
    [p] = pp.passport_file(path)
    return p


def _text_page(c):
    c.setFont("Noto", 11)
    for i, line in enumerate(TEXT_LINES):
        c.drawString(60, 760 - i * 16, line)


def _scan_image(w: int, h: int) -> ImageReader:
    img = Image.new("L", (w, h), 245)
    for x in range(10, w - 10, 9):
        for y in range(h // 3, h // 3 + 3):
            img.putpixel((x, y), 0)
    return ImageReader(img)


def _lines(c, n: int, w: float, h: float):
    for i in range(n):  # n отдельных путей: одна линия — один объект PATH
        x = 20 + (i * 7.0) % (w - 40)
        c.line(x, 20 + (i % 13), x + 3, h - 20 - (i % 11))


def _frame(c, w: float, h: float):  # рамка и штамп без текста — четыре пути
    c.rect(20 * mm, 5 * mm, w - 25 * mm, h - 10 * mm)
    c.rect(w - 190 * mm, 5 * mm, 185 * mm, 55 * mm)
    c.line(w - 190 * mm, 20 * mm, w - 5 * mm, 20 * mm)
    c.line(w - 120 * mm, 5 * mm, w - 120 * mm, 60 * mm)


# ─────────────────────────────────────────────── классы и маршруты на синтетике


@pytest.mark.l1_functional
def test_text_page_a4_is_text_via_text_layer(tmp_path):
    p = _one(_pdf(tmp_path, _text_page))
    assert (p["page"], p["page_class"], p["route"]) == (1, "TEXT", "TEXT_LAYER")
    assert (p["format"], p["orientation"], p["rotation"]) == ("A4", "portrait", 0)
    assert p["width_mm"] == pytest.approx(210, abs=0.5) and p[
        "height_mm"
    ] == pytest.approx(297, abs=0.5)
    assert p["has_text_layer"] and p["lines"] == 3
    assert p["non_space_chars"] == sum(len(s.replace(" ", "")) for s in TEXT_LINES)
    assert p["chars"] >= p["non_space_chars"]
    assert p["cyr_share"] > 0.6 and p["garbage_share"] == 0.0
    assert p["n_text_objs"] >= 1 and p["n_paths"] == 0 and p["n_images"] == 0
    assert p["ink_share"] > 0 and p["color_share"] == 0.0
    assert p["n_widgets"] == 0 and p["n_annots"] == 0
    assert not p["hints"]["expect_table"] and not p["hints"]["text_layer_broken"]


@pytest.mark.l1_functional
def test_full_page_image_without_text_is_scan_via_ocr(tmp_path):
    w, h = A4
    p = _one(_pdf(tmp_path, lambda c: c.drawImage(_scan_image(620, 877), 0, 0, w, h)))
    assert (p["page_class"], p["route"]) == ("SCAN", "OCR")
    assert p["n_images"] == 1 and p["is_full_page_image"]
    assert p["image_area_share"] == pytest.approx(1.0, abs=1e-3)
    assert p["max_image_dpi"] == pytest.approx(75, abs=1)  # 620 px на 210 мм
    assert p["hints"]["ocr_dpi_suggest"] == pp.OCR_DPI_MIN  # слабый скан — не ниже 200
    assert not p["has_text_layer"] and p["chars"] == 0


@pytest.mark.l1_functional
def test_scan_with_text_layer_is_mixed_via_text_layer(tmp_path):
    w, h = A4

    def draw(c):
        c.drawImage(_scan_image(300, 420), 0, 0, w, h)
        _text_page(c)

    p = _one(_pdf(tmp_path, draw))
    assert (p["page_class"], p["route"]) == ("MIXED", "TEXT_LAYER")


@pytest.mark.l1_functional
def test_vector_drawing_a3_without_text_is_vector_via_cv(tmp_path):
    w, h = landscape(A3)
    p = _one(_pdf(tmp_path, lambda c: _lines(c, 400, w, h), size=(w, h)))
    assert (p["page_class"], p["route"]) == ("VECTOR", "CV")
    assert (p["format"], p["orientation"]) == ("A3", "landscape")
    assert p["n_paths"] == 400 and p["chars"] == 0 and p["ink_share"] > 0


@pytest.mark.l1_functional
def test_signature_sheet_with_widget_top_left_is_skipped(tmp_path):
    w, h = A4

    def draw(c):
        _frame(c, w, h)
        c.acroForm.textfield(
            name="sign",
            x=30 * mm,
            y=h - 40 * mm,
            width=60 * mm,
            height=10 * mm,
            value="",
        )

    p = _one(_pdf(tmp_path, draw))
    assert (p["page_class"], p["route"]) == ("SIGNATURE_SHEET", "SKIP")
    assert (p["n_widgets"], p["n_annots"], p["widgets_top_left_share"]) == (1, 1, 1.0)
    assert p["n_paths"] == 4 and p["chars"] == 0


@pytest.mark.l1_functional
def test_widget_bottom_right_is_not_top_left(tmp_path):
    w, h = A4
    p = _one(
        _pdf(
            tmp_path,
            lambda c: c.acroForm.textfield(
                name="s", x=w - 80 * mm, y=20 * mm, width=50 * mm, height=10 * mm
            ),
        )
    )
    assert p["page_class"] == "SIGNATURE_SHEET" and p["widgets_top_left_share"] == 0.0


@pytest.mark.l1_functional
def test_frame_without_widgets_and_empty_page_are_blank(tmp_path):
    w, h = A4
    framed = _one(_pdf(tmp_path, lambda c: _frame(c, w, h), name="f.pdf"))
    empty = _one(_pdf(tmp_path, lambda c: None, name="e.pdf"))
    assert (framed["page_class"], framed["route"]) == ("BLANK", "SKIP")
    assert (empty["page_class"], empty["route"]) == ("BLANK", "SKIP")
    assert empty["ink_share"] == empty["dark_share"] == empty["color_share"] == 0.0
    assert (
        empty["n_paths"],
        empty["n_images"],
        empty["chars"],
        empty["has_text_layer"],
    ) == (0, 0, 0, False)
    assert framed["ink_share"] > 0


@pytest.mark.l1_functional
def test_a1_and_wider_than_a0_formats(tmp_path):
    a1 = _one(_pdf(tmp_path, lambda c: None, size=(841 * mm, 594 * mm), name="a1.pdf"))
    big = _one(
        _pdf(tmp_path, lambda c: None, size=(1300 * mm, 900 * mm), name="big.pdf")
    )
    assert (a1["format"], a1["orientation"]) == ("A1", "landscape")
    assert big["format"] == "LARGER"
    assert (
        big["hints"]["ocr_dpi_suggest"] < pp.OCR_DPI
    )  # потолок мегапикселей на огромном листе


@pytest.mark.l1_functional
def test_rotated_page_reports_rotation_and_visible_orientation(tmp_path):
    # ReportLab при setPageRotation(90) пишет альбомный MediaBox 842×595; с поворотом лист виден книжным 595×842 —
    # паспорт отдаёт видимую ориентацию (pdfium учитывает /Rotate в get_size), а поворот — отдельным полем
    p = _one(_pdf(tmp_path, _text_page, rotate=90))
    assert (
        p["rotation"] == 90 and p["orientation"] == "portrait" and p["format"] == "A4"
    )


@pytest.mark.l1_functional
def test_blue_stamp_gives_color_share(tmp_path):
    def draw(c):
        _text_page(c)
        c.setFillColorRGB(0.1, 0.2, 0.8)
        c.circle(400, 200, 60, stroke=0, fill=1)

    p = _one(_pdf(tmp_path, draw))
    assert p["color_share"] > 0.01 and p["ink_share"] >= p["color_share"]


@pytest.mark.l1_functional
def test_broken_encoding_gives_garbage_share(tmp_path):
    def draw(
        c,
    ):  # «Проектная документация раздел» в cp1251, прочитанная как Latin-1 — типичная битая кодировка
        c.setFont("Helvetica", 12)
        c.drawString(60, 700, "Ïðîåêòíàÿ äîêóìåíòàöèÿ ðàçäåë ÀÐ")

    p = _one(_pdf(tmp_path, draw))
    assert (
        p["page_class"] == "TEXT" and p["garbage_share"] > 0.8 and p["cyr_share"] == 0.0
    )
    assert p["hints"]["text_layer_broken"]


@pytest.mark.l1_functional
def test_many_short_lines_expect_table(tmp_path):
    def draw(c):
        c.setFont("Noto", 10)
        for i in range(12):
            c.drawString(60, 780 - i * 14, f"{i + 1}")
        c.drawString(60, 500, "Ведомость рабочих чертежей основного комплекта")

    p = _one(_pdf(tmp_path, draw))
    assert p["hints"]["expect_table"]


@pytest.mark.l1_functional
def test_multi_page_file_numbers_pages(tmp_path):
    p = tmp_path / "m.pdf"
    c = canvas.Canvas(str(p), pagesize=A4)
    _text_page(c)
    c.showPage()
    c.showPage()
    c.save()
    got = pp.passport_file(p)
    assert [(x["page"], x["page_class"]) for x in got] == [(1, "TEXT"), (2, "BLANK")]
    assert all(x["hints"]["ms"] >= 0 for x in got)


# ─────────────────────────────────────────────── границы порогов


@pytest.mark.l3_boundary
@pytest.mark.parametrize(("n", "cls"), [(29, "BLANK"), (30, "TEXT")])
def test_text_threshold_exactly_30_chars(tmp_path, n, cls):
    def draw(c):
        c.setFont("Helvetica", 10)
        c.drawString(40, 700, "x" * n)

    assert _one(_pdf(tmp_path, draw))["page_class"] == cls


@pytest.mark.l3_boundary
@pytest.mark.parametrize(("iw", "cls"), [(300, "BLANK"), (301, "SCAN")])
def test_scan_threshold_exactly_half_area(tmp_path, iw, cls):
    p = _one(
        _pdf(
            tmp_path,
            lambda c: c.drawImage(_scan_image(100, 100), 0, 0, iw, 400),
            size=(600, 400),
        )
    )
    assert p["page_class"] == cls
    assert p["image_area_share"] == pytest.approx(iw / 600, abs=1e-4)
    assert not p["is_full_page_image"]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(("n", "cls"), [(300, "BLANK"), (301, "VECTOR")])
def test_vector_threshold_exactly_300_paths(tmp_path, n, cls):
    w, h = A3
    p = _one(_pdf(tmp_path, lambda c: _lines(c, n, w, h), size=A3))
    assert (p["n_paths"], p["page_class"]) == (n, cls)


@pytest.mark.l3_boundary
def test_image_outside_page_counts_only_visible_part(tmp_path):
    p = _one(
        _pdf(
            tmp_path,
            lambda c: c.drawImage(_scan_image(100, 100), -600, 0, 900, 400),
            size=(600, 400),
        )
    )
    assert (
        p["image_area_share"] == pytest.approx(0.5, abs=1e-4)
        and p["page_class"] == "BLANK"
    )


@pytest.mark.l3_boundary
def test_full_page_image_threshold():
    assert pp.FULL_PAGE_IMAGE == 0.85


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    ("w", "h", "fmt"),
    [
        (210, 297, "A4"), (297, 210, "A4"), (210 * 1.08, 297 * 1.08, "A4"), (210 * 1.08 + 0.1, 297, "A3"),
        (210, 297 * 1.08 + 0.1, "A3"), (297 * 1.08, 420 * 1.08, "A3"), (420, 594, "A2"), (594, 841, "A1"),
        (841, 1189, "A0"), (841 * 1.08, 1189 * 1.08, "A0"), (841 * 1.08 + 0.1, 1189, "LARGER"),
        (841, 1189 * 1.08 + 0.1, "LARGER"), (148, 210, "SMALLER"), (148 * 1.08, 210 * 1.08, "SMALLER"),
        (148 * 1.08 + 0.1, 210, "A4"), (148, 210 * 1.08 + 0.1, "A4"), (90, 50, "SMALLER"),
    ],
)  # fmt: skip
def test_format_tolerance_plus_8_percent(w, h, fmt):
    assert pp.paper_format(w, h) == fmt


@pytest.mark.l3_boundary
def test_classify_boundaries_and_order():
    c = pp.classify
    assert c(30, 0.0, 0, 0) == "TEXT" and c(29, 0.0, 0, 0) == "BLANK"
    assert c(30, 0.51, 0, 0) == "MIXED" and c(30, 0.5, 0, 0) == "TEXT"
    assert c(0, 0.51, 999, 3) == "SCAN" and c(0, 0.5, 0, 0) == "BLANK"
    assert c(0, 0.0, 301, 3) == "VECTOR" and c(0, 0.0, 300, 0) == "BLANK"
    assert (
        c(0, 0.0, 300, 1) == "SIGNATURE_SHEET"
        and c(29, 0.5, 300, 1) == "SIGNATURE_SHEET"
    )
    assert c(0, 0.0, 0, 0) == "BLANK"
    assert {pp.ROUTES[k] for k in pp.CLASSES} == {"SKIP", "TEXT_LAYER", "OCR", "CV"}
    assert [pp.ROUTES[k] for k in ("TEXT", "MIXED", "SCAN", "VECTOR", "SIGNATURE_SHEET", "BLANK")] == [
        "TEXT_LAYER", "TEXT_LAYER", "OCR", "CV", "SKIP", "SKIP"]  # fmt: skip


@pytest.mark.l3_boundary
def test_thresholds_are_t165_defaults():
    assert (pp.TEXT_MIN_CHARS, pp.SCAN_IMAGE_SHARE, pp.VECTOR_MIN_PATHS, pp.FORMAT_TOLERANCE, pp.MAX_OBJ_DEPTH) == (
        30, 0.5, 300, 0.08, 3)  # fmt: skip


@pytest.mark.l3_boundary
def test_orientation_boundaries():
    assert pp.orientation(100, 100) == "square" and pp.orientation(100, 98) == "square"
    assert (
        pp.orientation(100, 97.9) == "landscape"
        and pp.orientation(97.9, 100) == "portrait"
    )


@pytest.mark.l3_boundary
def test_ink_stats_levels():
    px = np.array(
        [[[255, 255, 255], [235, 235, 235]], [[234, 234, 234], [95, 95, 95]]],
        dtype=np.uint8,
    )
    assert pp.ink_stats(px) == {
        "ink_share": 0.5,
        "dark_share": 0.25,
        "color_share": 0.0,
    }
    col = np.array(
        [[[0, 0, 255], [200, 139, 200], [200, 140, 200], [96, 96, 96]]], dtype=np.uint8
    )
    assert pp.ink_stats(col) == {
        "ink_share": 1.0,
        "dark_share": 0.25,
        "color_share": 0.5,
    }  # разброс 61 — цвет, 60 — нет
    assert pp.ink_stats(np.zeros((0, 0, 3), dtype=np.uint8)) == {
        "ink_share": 0.0,
        "dark_share": 0.0,
        "color_share": 0.0,
    }


@pytest.mark.l3_boundary
def test_text_stats_and_char_kinds():
    assert [pp.char_kind(ch) for ch in "Яa1.№ Ïё\x7f"] == [
        "cyr", "lat", "digit", "punct", "punct", "space", "garbage", "cyr", "garbage"]  # fmt: skip
    s = pp.text_stats("АБВ 12\r\n\r\n  xyz  \n№ 1234567890123")
    assert s == {
        "non_space_chars": 22,
        "lines": 3,
        "short_lines": 2,
        "cyr_share": round(3 / 22, 4),
        "garbage_share": 0.0,
    }
    assert pp.text_stats("") == {
        "non_space_chars": 0,
        "lines": 0,
        "short_lines": 0,
        "cyr_share": 0.0,
        "garbage_share": 0.0,
    }
    assert pp.text_stats("ÏÏxx")["garbage_share"] == 0.5


@pytest.mark.l3_boundary
def test_expect_table_and_ocr_dpi_boundaries():
    assert (
        pp.expect_table(16, 8)
        and not pp.expect_table(17, 8)
        and not pp.expect_table(7, 7)
    )
    w, h = A4
    assert pp.ocr_dpi_suggest(w, h, 0) == 300 and pp.ocr_dpi_suggest(w, h, 600) == 300
    assert pp.ocr_dpi_suggest(w, h, 250) == 250 and pp.ocr_dpi_suggest(w, h, 199) == 200
    assert (
        pp.ocr_dpi_suggest(1189 / 25.4 * 72 * 3, 841 / 25.4 * 72 * 3, 0) < 300
    )  # потолок мегапикселей


# ─────────────────────────────────────────────── отказы, замок, CLI


@pytest.mark.l4_fault
def test_corrupted_pdf_raises_corrupted_file(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes("%PDF-1.7\nне pdf".encode())
    with pytest.raises(CorruptedFile):
        pp.passport_file(bad)


@pytest.mark.l4_fault
def test_passport_file_waits_for_shared_pdfium_lock(tmp_path):
    path = _pdf(tmp_path, _text_page)
    done = threading.Event()
    with PDFIUM_LOCK:
        t = threading.Thread(target=lambda: (pp.passport_file(path), done.set()))
        t.start()
        assert not done.wait(0.3)  # пока замок у другого — паспорт не считается
    t.join(10)
    assert done.is_set() and not PDFIUM_LOCK.locked()


@pytest.mark.l1_functional
def test_cli_json_and_summary(tmp_path, capsys):
    a = _pdf(tmp_path, _text_page, name="a.pdf")
    b = _pdf(tmp_path, lambda c: None, name="b.pdf")
    assert pp.main([str(a), str(b), "--json"]) == 0
    rows = [json.loads(x) for x in capsys.readouterr().out.splitlines()]
    assert [
        (Path(r["file"]).name, [p["page_class"] for p in r["pages"]]) for r in rows
    ] == [("a.pdf", ["TEXT"]), ("b.pdf", ["BLANK"])]
    assert pp.main([str(a), str(b)]) == 0
    s = json.loads(capsys.readouterr().out)
    assert (s["pages"], s["classes"], s["routes"], s["formats"]) == (
        2, {"TEXT": 1, "BLANK": 1}, {"TEXT_LAYER": 1, "SKIP": 1}, {"A4": 2})  # fmt: skip
    assert s["ms_max"] >= s["ms_p50"] >= 0


@pytest.mark.l4_fault
def test_cli_reports_corrupted_file_and_continues(tmp_path, capsys):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"garbage")
    good = _pdf(tmp_path, _text_page, name="g.pdf")
    assert pp.main([str(bad), str(good)]) == 1
    out = capsys.readouterr()
    assert json.loads(out.out)["pages"] == 1 and "bad.pdf" in out.err


# ─────────────────────────────────────────────── ADR-0002: в паспорте нет текста документа


@pytest.mark.l7_discipline
def test_passport_contains_no_document_text(tmp_path):
    def draw(c):
        _text_page(c)
        c.setFont("Helvetica", 12)
        c.drawString(60, 500, "Ïðîåêòíàÿ äîêóìåíòàöèÿ")

    p = _one(_pdf(tmp_path, draw))
    dump = json.dumps(p, ensure_ascii=False).lower()
    words = {
        w.strip(",.№").lower()
        for line in TEXT_LINES + ["Ïðîåêòíàÿ äîêóìåíòàöèÿ"]
        for w in line.split()
    }
    leaked = {w for w in words if len(w) >= 3 and w in dump}
    assert not leaked, leaked
    for v in p.values():  # только числа, флаги и коды
        assert isinstance(v, (int, float, bool, str, dict))
        if isinstance(v, str):
            assert v.isupper() or v in {"portrait", "landscape", "square"}


# ─────────────────────────────────────────────── время паспорта


def _timed(path: Path) -> float:
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        try:
            page = doc[0]
            try:
                pp.passport(page)  # прогрев: первая страница платит за загрузку шрифтов
                t = time.perf_counter()
                p = pp.passport(page)
                ms = (time.perf_counter() - t) * 1000
            finally:
                page.close()
        finally:
            doc.close()
    assert p["hints"]["ms"] > 0
    return ms


@pytest.mark.l3_boundary
@pytest.mark.performance
def test_performance_a4_text_passport_under_200_ms(tmp_path):
    ms = _timed(_pdf(tmp_path, _text_page))
    print(f"паспорт A4 текст: {ms:.1f} мс")
    assert ms < 200


@pytest.mark.l3_boundary
@pytest.mark.performance
def test_performance_a0_vector_20000_paths_under_1500_ms(tmp_path):
    w, h = 1189 * mm, 841 * mm
    ms = _timed(_pdf(tmp_path, lambda c: _lines(c, 20_000, w, h), size=(w, h)))
    print(f"паспорт A0 вектор 20 000 путей: {ms:.1f} мс")
    assert ms < 1500


# ──────────────────────────────── точные значения признаков (добивка мутантов T-216)


@pytest.mark.l1_functional
def test_widgets_counted_each_quadrant_share_and_other_annots_skipped(tmp_path):
    """Ссылка (не Widget) первой, затем четыре поля: левый верх, правый верх, левый низ, правый низ; центр поля решает
    квадрант, даже когда левый край поля слева от середины."""
    w, h = A4

    def draw(c):
        c.linkURL("https://example.invalid", (10 * mm, 10 * mm, 30 * mm, 20 * mm))
        for i, (x, y) in enumerate([(20 * mm, h - 30 * mm), (w / 2 - 5 * mm, h - 30 * mm), (20 * mm, 30 * mm), (w - 70 * mm, 30 * mm)]):
            c.acroForm.textfield(name=f"f{i}", x=x, y=y, width=60 * mm, height=10 * mm, value="")

    p = _one(_pdf(tmp_path, draw))
    assert (p["n_annots"], p["n_widgets"]) == (5, 4)
    assert p["widgets_top_left_share"] == 0.25


@pytest.mark.l1_functional
def test_widget_top_left_share_rounded_to_four_digits(tmp_path):
    w, h = A4

    def draw(c):
        for i, (x, y) in enumerate([(20 * mm, h - 30 * mm), (w - 70 * mm, 30 * mm), (w - 70 * mm, 60 * mm)]):
            c.acroForm.textfield(name=f"g{i}", x=x, y=y, width=40 * mm, height=10 * mm, value="")

    p = _one(_pdf(tmp_path, draw))
    assert p["n_widgets"] == 3 and p["widgets_top_left_share"] == 0.3333


@pytest.mark.l1_functional
def test_image_dpi_is_min_over_axes_and_area_share_exact(tmp_path):
    """300×300 px на 100×50 мм: 76,2 dpi по ширине, 152,4 по высоте — берётся меньшее, с одним знаком."""
    w, h = A4

    def draw(c):
        c.drawImage(_scan_image(300, 300), 20 * mm, 20 * mm, 100 * mm, 50 * mm)

    p = _one(_pdf(tmp_path, draw))
    assert p["n_images"] == 1 and p["max_image_dpi"] == 76.2
    assert p["image_area_share"] == round((100 * 50) / (210.0 * 297.0), 4)
    assert not p["is_full_page_image"]


@pytest.mark.l1_functional
def test_counts_are_exact_for_text_paths_and_forms(tmp_path):
    """Форма XObject с 5 линиями и 1 строкой текста: форма считается одна, её содержимое — в счётчиках (обход вглубь)."""

    def draw(c):
        c.beginForm("stamp")
        for i in range(5):
            c.line(10, 10 + i * 5, 100, 10 + i * 5)
        c.setFont("Noto", 9)
        c.drawString(10, 60, "Штамп")
        c.endForm()
        c.doForm("stamp")

    p = _one(_pdf(tmp_path, draw))
    assert (p["n_forms"], p["n_paths"], p["n_text_objs"], p["n_images"]) == (1, 5, 1, 0)


@pytest.mark.l1_functional
def test_empty_page_counts_are_zero(tmp_path):
    p = _one(_pdf(tmp_path, lambda c: None))
    assert (p["n_forms"], p["n_paths"], p["n_text_objs"], p["n_images"], p["n_widgets"], p["n_annots"]) == (0, 0, 0, 0, 0, 0)
    assert p["image_area_share"] == 0.0 and p["max_image_dpi"] == 0.0 and p["widgets_top_left_share"] == 0.0


@pytest.mark.l1_functional
def test_cli_json_lines_per_file_and_summary(tmp_path, capsys):
    a = _pdf(tmp_path, _text_page, name="a.pdf")
    b = _pdf(tmp_path, lambda c: None, name="b.pdf")
    assert pp.main([str(a), str(b), "--json"]) == 0
    out = [json.loads(x) for x in capsys.readouterr().out.strip().splitlines()]
    assert [o["file"] for o in out] == [str(a), str(b)]
    assert [len(o["pages"]) for o in out] == [1, 1] and out[0]["pages"][0]["page_class"] == "TEXT"
    assert pp.main([str(a), str(b)]) == 0
    s = json.loads(capsys.readouterr().out.strip())
    assert s["pages"] == 2 and s["classes"] == {"TEXT": 1, "BLANK": 1} and s["routes"] == {"TEXT_LAYER": 1, "SKIP": 1}
    assert s["formats"] == {"A4": 2} and s["ms_max"] >= s["ms_p50"] >= 0 and s["ms_total"] >= s["ms_max"]


@pytest.mark.l1_functional
def test_cli_corrupted_file_is_error_line_and_code_1(tmp_path, capsys):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a pdf at all")
    good = _pdf(tmp_path, _text_page, name="g.pdf")
    assert pp.main([str(bad), str(good), "--json"]) == 1
    cap = capsys.readouterr()
    err = json.loads(cap.err.strip())
    assert err["file"] == str(bad) and err["error"]
    assert json.loads(cap.out.strip())["file"] == str(good)


@pytest.mark.l1_functional
def test_summary_of_nothing_is_zero():
    assert pp.summary([]) == {"pages": 0, "classes": {}, "routes": {}, "formats": {}, "ms_total": 0, "ms_p50": 0.0, "ms_max": 0.0}


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "ch,kind",
    [("a", "lat"), ("z", "lat"), ("A", "lat"), ("Z", "lat"), ("`", "punct"), ("{", "punct"), ("@", "punct"), ("[", "punct"),
     ("0", "digit"), ("9", "digit"), ("/", "punct"), (":", "punct"), ("Ѐ", "cyr"), ("ӿ", "cyr"), ("Ԁ", "garbage"), ("Ͽ", "garbage"),
     ("!", "punct"), ("~", "punct"), ("\x7f", "garbage"), ("№", "punct"), ("\t", "space"), ("�", "garbage")],
)
def test_char_kind_boundaries(ch, kind):
    assert pp.char_kind(ch) == kind


@pytest.mark.l3_boundary
def test_ink_skipped_for_page_with_huge_image(tmp_path, monkeypatch):
    """Картинка крупнее порога — «чернила» не рендерятся (память), класс и маршрут считаются как обычно."""
    w, h = A4
    monkeypatch.setattr(pp, "INK_MAX_IMAGE_MPX", 0.4)  # 620×877 ≈ 0,54 Мп (округлено 0,5) > 0,4
    p = _one(_pdf(tmp_path, lambda c: c.drawImage(_scan_image(620, 877), 0, 0, w, h)))
    assert p["max_image_mpx"] == 0.5 or p["max_image_mpx"] == pytest.approx(0.54, abs=0.01)
    assert p["hints"]["ink_skipped"] and p["ink_share"] is None and p["color_share"] is None
    assert (p["page_class"], p["route"]) == ("SCAN", "OCR")
    monkeypatch.setattr(pp, "INK_MAX_IMAGE_MPX", 1.0)
    q = _one(_pdf(tmp_path, lambda c: c.drawImage(_scan_image(620, 877), 0, 0, w, h), name="q.pdf"))
    assert not q["hints"]["ink_skipped"] and q["ink_share"] > 0
