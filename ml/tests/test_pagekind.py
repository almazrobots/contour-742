"""T-127: вид страницы «вектор / скан / гибрид» и векторные пути листа (исследование, шаги 1 и 4a).

Все листы — синтетика reportlab прямо в тесте: известная геометрия, цвет, толщина, штрих."""

from __future__ import annotations

import ctypes
import threading
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import pytest
from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from inspector_ml import pagekind as pk
from inspector_ml.measure import MIN_DIM_PX, Segment, orientation, segments
from inspector_ml.parse import MIN_TEXT_CHARS, PDFIUM_LOCK, CorruptedFile, _to_norm

W, H = 600.0, 400.0  # pt
TOL = 1e-4


def _pdf(tmp_path: Path, draw, size=(W, H), name="s.pdf") -> Path:
    p = tmp_path / name
    c = canvas.Canvas(str(p), pagesize=size)
    draw(c)
    c.save()
    return p


def _vector_sheet(c):
    c.setStrokeColorRGB(1, 0, 0)
    c.setLineWidth(2)
    c.line(60, 300, 540, 300)  # горизонталь: y = 1 − 300/400 = 0,25
    c.setDash(6, 3)
    c.setStrokeColorRGB(0, 0, 1)
    c.setLineWidth(0.5)
    c.line(100, 50, 100, 350)  # вертикаль штрихом
    c.setDash()
    c.setStrokeColorRGB(0, 0.5, 0)
    c.setLineWidth(1)
    c.line(300, 100, 400, 200)  # наклон 45°
    c.setFillColorRGB(1, 1, 0)
    c.rect(200, 100, 100, 50, stroke=1, fill=1)
    for i in range(40):  # штриховка — чтобы путей было как на листе
        c.line(420 + i * 3, 60, 420 + i * 3, 90)
    c.setFillColorRGB(0, 0, 0)
    c.drawString(50, 20, "План этажа: воздуховод 500x300, отм. +3.200")


def _scan_image(w=300, h=200) -> ImageReader:
    img = Image.new("L", (w, h), 250)
    for x in range(20, 280, 7):
        img.putpixel((x, 100), 0)
    return ImageReader(img)


def _by_path(segs):
    out: dict[int, list[pk.VectorSegment]] = {}
    for s in segs:
        out.setdefault(s.path, []).append(s)
    return out


# ─────────────────────────────────────────────── вид страницы на синтетике


@pytest.mark.l1_functional
def test_vector_sheet_is_vector_with_text_and_paths(tmp_path):
    [r] = pk.detect_pages(_pdf(tmp_path, _vector_sheet))
    assert (r.page, r.kind, r.reasons) == (1, "vector", ("text_layer", "paths"))
    f = r.features
    assert f.text_chars == len(
        "План этажа: воздуховод 500x300, отм. +3.200".replace(" ", "")
    )
    assert f.path_objects == 44 and f.path_segments >= 4 + 43 * 2
    assert f.image_objects == 0 and f.image_share == 0.0 and not f.full_page_image
    assert r.seconds >= 0


@pytest.mark.l1_functional
def test_scan_page_full_image_without_text(tmp_path):
    [r] = pk.detect_pages(
        _pdf(tmp_path, lambda c: c.drawImage(_scan_image(), 0, 0, W, H))
    )
    assert (r.kind, r.reasons) == ("scan", ("full_page_image",))
    assert r.features.image_objects == 1
    assert r.features.max_image_share == pytest.approx(1.0, abs=1e-3)
    assert r.features.text_chars == 0


@pytest.mark.l1_functional
def test_scan_with_invisible_ocr_layer_is_hybrid(tmp_path):
    def draw(c):
        c.drawImage(_scan_image(), 0, 0, W, H)
        t = c.beginText(40, 200)
        t.setTextRenderMode(3)  # невидимый слой OCR
        t.textLine("Воздуховод прямоугольный 500x300 мм, сталь 0,7")
        c.drawText(t)

    [r] = pk.detect_pages(_pdf(tmp_path, draw))
    assert (r.kind, r.reasons) == ("hybrid", ("full_page_image", "ocr_text_layer"))
    assert r.features.invisible_text == r.features.text_objects > 0


@pytest.mark.l1_functional
def test_scan_with_visible_text_and_vector_markup_is_hybrid(tmp_path):
    def draw(c):
        c.drawImage(_scan_image(), 0, 0, W, H)
        c.drawString(40, 200, "Замечание инспектора: отметка не совпадает")
        for i in range(30):
            c.line(10 + i * 5, 10, 10 + i * 5, 60)

    [r] = pk.detect_pages(_pdf(tmp_path, draw))
    assert (r.kind, r.reasons) == (
        "hybrid",
        ("full_page_image", "text_over_image", "vector_over_image"),
    )
    from inspector_ml.pipeline_geometry import pdf_regions
    profiles = []
    regions = pdf_regions(_pdf(tmp_path, draw), 'a' * 64, profiles=profiles)
    assert profiles[0]['page_id'] == regions[0].page_id
    assert profiles[0]['kind'] == 'hybrid'
    assert 'text_over_image' in profiles[0]['reasons']


@pytest.mark.l1_functional
def test_strips_of_scan_cover_page_without_single_full_image(tmp_path):
    def draw(
        c,
    ):  # скан нарезан на 4 полосы — ни одна не «полностраничная», вместе — вся страница
        for i in range(4):
            c.drawImage(_scan_image(), 0, i * H / 4, W, H / 4)

    [r] = pk.detect_pages(_pdf(tmp_path, draw))
    assert (r.kind, r.reasons) == ("scan", ("images_cover_page",))
    assert r.features.max_image_share == pytest.approx(0.25, abs=1e-3)
    assert r.features.image_share == pytest.approx(1.0, abs=1e-3)


@pytest.mark.l1_functional
def test_vector_with_raster_inset_is_hybrid(tmp_path):
    def draw(c):
        _vector_sheet(c)
        c.drawImage(
            _scan_image(), 300, 200, 180, 120
        )  # 180·120 / 600·400 = 9 % … плюс ещё одна
        c.drawImage(_scan_image(), 10, 330, 60, 60)  # 1,5 % → вместе 10,5 %

    [r] = pk.detect_pages(_pdf(tmp_path, draw))
    assert (r.kind, r.reasons) == ("hybrid", ("raster_insets",))
    assert r.features.image_share == pytest.approx(0.105, abs=1e-3)


@pytest.mark.l6_adversarial
def test_text_as_curves_shx_is_hybrid_not_vector(tmp_path):
    def draw(c):  # «SHX-текст»: 300 букв-ломаных по 4 звена, текстового слоя почти нет
        c.setLineWidth(0.3)
        for i in range(300):
            x, y = 20 + (i % 50) * 11, 40 + (i // 50) * 40
            p = c.beginPath()
            p.moveTo(x, y)
            p.lineTo(x + 3, y + 7)
            p.lineTo(x + 6, y)
            p.moveTo(x + 1.5, y + 3.5)
            p.lineTo(x + 4.5, y + 3.5)
            c.drawPath(p, stroke=1, fill=0)
        c.rect(10, 10, 580, 380)
        c.drawString(20, 370, "Лист 3")

    [r] = pk.detect_pages(_pdf(tmp_path, draw))
    assert (r.kind, r.reasons) == ("hybrid", ("text_as_curves",))
    assert r.features.small_paths == 300 and r.features.text_chars < MIN_TEXT_CHARS


@pytest.mark.l1_functional
def test_empty_page_and_sparse_page(tmp_path):
    [e] = pk.detect_pages(_pdf(tmp_path, lambda c: c.showPage()))
    assert (e.kind, e.reasons) == ("empty", ())
    [s] = pk.detect_pages(
        _pdf(tmp_path, lambda c: c.line(10, 10, 100, 10), name="s2.pdf")
    )
    assert (s.kind, s.reasons) == ("vector", ("sparse",))


@pytest.mark.l1_functional
def test_detect_pages_selects_numbers_and_skips_missing(tmp_path):
    p = tmp_path / "m.pdf"
    c = canvas.Canvas(str(p), pagesize=(W, H))
    c.drawImage(_scan_image(), 0, 0, W, H)
    c.showPage()
    _vector_sheet(c)
    c.showPage()
    c.save()
    assert [(r.page, r.kind) for r in pk.detect_pages(p)] == [
        (1, "scan"),
        (2, "vector"),
    ]
    assert [(r.page, r.kind) for r in pk.detect_pages(p, [2, 0, 3])] == [(2, "vector")]


@pytest.mark.l6_adversarial
def test_corrupted_pdf_raises_corrupted_file(tmp_path):
    p = tmp_path / "bad.pdf"
    p.write_bytes(b"%PDF-1.7\n this is not a pdf")
    with pytest.raises(CorruptedFile):
        pk.detect_pages(p)
    with pytest.raises(CorruptedFile):
        pk.extract_vectors(p, 1)


@pytest.mark.l6_adversarial
def test_extract_vectors_missing_page_raises(tmp_path):
    p = _pdf(tmp_path, _vector_sheet)
    for n in (0, 2):
        with pytest.raises(IndexError):
            pk.extract_vectors(p, n)


# ─────────────────────────────────────────────── векторные пути: геометрия и атрибуты


@pytest.mark.l1_functional
def test_vector_segments_geometry_color_width_dash(tmp_path):
    v = pk.extract_vectors(_pdf(tmp_path, _vector_sheet), 1)
    assert (v.page, v.width_pt, v.height_pt, v.truncated) == (1, W, H, False)
    paths = _by_path(v.segments)
    [h] = paths[0]
    assert (h.x0, h.y0, h.x1, h.y1) == pytest.approx((0.1, 0.25, 0.9, 0.25), abs=TOL)
    assert (h.stroke_rgba, h.width_pt, h.dash, h.stroke, h.fill_mode) == (
        (255, 0, 0, 255),
        2.0,
        (),
        True,
        0,
    )
    assert h.fill_rgba is None and not h.curve and not h.closing
    assert h.length == pytest.approx(0.8, abs=TOL)
    [vv] = paths[1]
    assert (vv.x0, vv.y0, vv.x1, vv.y1) == pytest.approx(
        (1 / 6, 0.875, 1 / 6, 0.125), abs=TOL
    )
    assert (vv.stroke_rgba, vv.width_pt, vv.dash) == ((0, 0, 255, 255), 0.5, (6.0, 3.0))
    [d] = paths[2]
    assert (d.x0, d.y0, d.x1, d.y1) == pytest.approx((0.5, 0.75, 2 / 3, 0.5), abs=TOL)
    assert d.stroke_rgba == (0, 128, 0, 255)
    rect = paths[3]
    assert len(rect) == 4 and rect[-1].closing and not rect[0].closing
    assert all(
        s.fill_mode > 0 and s.fill_rgba == (255, 255, 0, 255) and s.stroke for s in rect
    )
    xs = sorted({round(c, 4) for s in rect for c in (s.x0, s.x1)})
    ys = sorted({round(c, 4) for s in rect for c in (s.y0, s.y1)})
    assert xs == pytest.approx([1 / 3, 0.5], abs=TOL) and ys == pytest.approx(
        [0.625, 0.75], abs=TOL
    )


@pytest.mark.l1_functional
def test_bezier_is_approximated_by_polyline_through_endpoints(tmp_path):
    def draw(c):
        c.bezier(100, 100, 100, 300, 500, 300, 500, 100)

    v = pk.extract_vectors(_pdf(tmp_path, draw), 1)
    assert len(v.segments) == pk.BEZIER_STEPS and all(s.curve for s in v.segments)
    first, last = v.segments[0], v.segments[-1]
    assert (first.x0, first.y0) == pytest.approx((100 / W, 0.75), abs=TOL)
    assert (last.x1, last.y1) == pytest.approx((500 / W, 0.75), abs=TOL)
    mid = v.segments[
        pk.BEZIER_STEPS // 2 - 1
    ]  # t = ½: y = 100 + ¾·200 = 250 pt → 1 − 250/400
    assert (mid.x1, mid.y1) == pytest.approx((0.5, 0.375), abs=TOL)
    for a, b in zip(v.segments, v.segments[1:]):
        assert (a.x1, a.y1) == (b.x0, b.y0)


@pytest.mark.l1_functional
def test_form_xobject_paths_use_form_and_object_matrices(tmp_path):
    def draw(c):
        c.beginForm("blk")
        c.line(0, 0, 100, 0)
        c.drawImage(_scan_image(), 0, 10, 50, 50)
        c.endForm()
        c.saveState()
        c.translate(100, 200)
        c.scale(2, 2)
        c.doForm("blk")  # блок CAD: отрезок 0…100 → 100…300 pt по x на высоте 200
        c.restoreState()

    p = _pdf(tmp_path, draw)
    [r] = pk.detect_pages(p)
    assert (
        r.features.form_objects == 1
        and r.features.path_objects == 1
        and r.features.image_objects == 1
    )
    assert r.features.image_share == pytest.approx(100 * 100 / (W * H), abs=1e-3)
    [s] = pk.extract_vectors(p, 1).segments
    assert (s.x0, s.y0, s.x1, s.y1) == pytest.approx(
        (100 / W, 0.5, 300 / W, 0.5), abs=TOL
    )
    assert s.width_pt == pytest.approx(2.0)  # толщина 1 × масштаб 2


def _rotated_cropped(tmp_path: Path) -> Path:
    src = _pdf(tmp_path, _vector_sheet, name="src.pdf")
    doc = pdfium.PdfDocument(str(src))
    page = doc[0]
    page.set_cropbox(40, 30, 560, 380)
    page.set_rotation(90)
    out = tmp_path / "rot.pdf"
    doc.save(str(out))
    page.close()
    doc.close()
    return out


@pytest.mark.l1_functional
def test_rotated_page_with_offset_cropbox_matches_parse_norm(tmp_path):
    p = _rotated_cropped(tmp_path)
    v = pk.extract_vectors(p, 1)
    assert (v.width_pt, v.height_pt) == (
        350.0,
        520.0,
    )  # CropBox 520×350, повёрнут на 90°
    doc = pdfium.PdfDocument(str(p))
    page = doc[0]
    paths = _by_path(v.segments)
    [d] = paths[2]  # наклонная 300,100 → 400,200 целиком внутри CropBox
    assert (d.x0, d.y0) == pytest.approx(_to_norm(page, 300, 100), abs=TOL)
    assert (d.x1, d.y1) == pytest.approx(_to_norm(page, 400, 200), abs=TOL)
    [h] = paths[0]  # горизонталь 60…540 при y = 300 внутри CropBox по x (40…560)
    assert (h.x0, h.y0) == pytest.approx(_to_norm(page, 60, 300), abs=TOL)
    assert (h.x1, h.y1) == pytest.approx(_to_norm(page, 540, 300), abs=TOL)
    assert h.x0 == pytest.approx(
        h.x1, abs=TOL
    )  # на повёрнутом листе горизонталь PDF — вертикаль
    [vv] = paths[1]  # вертикаль 50…350 при x = 100 — y ≥ 30, внутри
    assert (vv.x0, vv.y0) == pytest.approx(_to_norm(page, 100, 50), abs=TOL)
    page.close()
    doc.close()


@pytest.mark.l6_adversarial
def test_segment_crossing_cropbox_is_clipped_not_clamped(tmp_path):
    def draw(c):
        c.line(10, 10, 20, 10)  # целиком вне CropBox ниже — и первым: обход идёт дальше
        c.line(-100, 200, 300, 200)  # левый конец за MediaBox
        p = c.beginPath()  # ломаная: первое звено вне CropBox, второе входит в него
        p.moveTo(400, 10)
        p.lineTo(450, 10)
        p.lineTo(450, 250)
        c.drawPath(p, stroke=1, fill=0)

    src = _pdf(tmp_path, draw)
    doc = pdfium.PdfDocument(str(src))
    doc[0].set_cropbox(0, 100, 600, 400)
    out = tmp_path / "crop.pdf"
    doc.save(str(out))
    doc.close()
    s, poly = pk.extract_vectors(out, 1).segments
    assert (s.x0, s.y0, s.x1, s.y1) == pytest.approx((0.0, 2 / 3, 0.5, 2 / 3), abs=TOL)
    assert (poly.x0, poly.y0, poly.x1, poly.y1) == pytest.approx((0.75, 1.0, 0.75, 0.5), abs=TOL)


@pytest.mark.l6_adversarial
def test_invisible_paths_are_skipped_and_segments_capped(tmp_path):
    def draw(c):
        for i in range(10):
            c.line(10, 20 + i * 10, 300, 20 + i * 10)

    p = _pdf(tmp_path, draw)
    capped = pk.extract_vectors(p, 1, max_segments=4)
    assert capped.truncated and len(capped.segments) == 4
    doc = pdfium.PdfDocument(str(p))
    page = doc[0]
    ghost = pdfium_c.FPDFPageObj_CreateNewPath(5, 5)  # путь без обводки и заливки (оператор n)
    pdfium_c.FPDFPath_LineTo(ghost, 200, 5)
    pdfium_c.FPDFPath_SetDrawMode(ghost, pdfium_c.FPDF_FILLMODE_NONE, False)
    pdfium_c.FPDFPage_InsertObject(page.raw, ghost)
    with PDFIUM_LOCK:
        f = pk.page_features(page)
        v = pk.page_vectors(page, 1)
    assert f.path_objects == 11  # в счёт признаков идёт, в отрезки — нет
    assert len(v.segments) == 10 and not v.truncated and {s.path for s in v.segments} == set(range(10))
    page.close()
    doc.close()


# ─────────────────────────────────────────────── мост в measure


@pytest.mark.l1_functional
def test_segments_from_vector_pixels_orientation_and_thickness(tmp_path):
    v = pk.extract_vectors(_pdf(tmp_path, _vector_sheet), 1)
    segs = pk.segments_from_vector(v, (1200, 800))
    h = segs[0]
    assert (h.x0, h.y0, h.x1, h.y1) == pytest.approx((120.5, 200.0, 1079.5, 200.0))
    assert h.length == pytest.approx(960.0) and h.thick == pytest.approx(
        4.0
    )  # 2 pt × 2 px/pt
    kinds = {orientation(s.angle) for s in segs}
    assert kinds == {"horizontal", "vertical", "oblique"}
    assert all(s.length >= MIN_DIM_PX for s in segs)
    thin = [s for s in segs if s.thick == 1.0]
    assert thin  # 0,5 pt × 2 = 1 px, волосяная — тоже 1


@pytest.mark.l1_functional
def test_segments_from_vector_filters_and_dedupes():
    def vs(x0, y0, x1, y1, **kw):
        base = {"path": 0, "width_pt": 0.0, "stroke": True, "fill_mode": 0}
        base.update(kw)
        return pk.VectorSegment(x0, y0, x1, y1, **base)

    vec = pk.PageVectors(
        page=1,
        width_pt=100.0,
        height_pt=100.0,
        segments=(
            vs(0.1, 0.5, 0.9, 0.5),
            vs(0.9, 0.5, 0.1, 0.5),  # тот же отрезок в обратную сторону — дубль
            vs(0.1, 0.1, 0.9, 0.1, stroke=False, fill_mode=1),  # только заливка
            vs(0.1, 0.2, 0.9, 0.2, curve=True),
            vs(0.1, 0.3, 0.12, 0.3),  # 20 px < MIN_DIM_PX
        ),
    )
    assert [(s.y0, s.thick) for s in pk.segments_from_vector(vec, (1000, 1000))] == [
        (500.0, 1.0)
    ]
    all_ = pk.segments_from_vector(
        vec, (1000, 1000), min_len_px=10, stroked_only=False, with_curves=True
    )
    assert sorted(s.y0 for s in all_) == [100.0, 200.0, 300.0, 500.0]
    assert pk.segments_from_vector(
        pk.PageVectors(1, 0.0, 0.0, vec.segments), (1000, 1000)
    ) == [Segment(100.5, 500.0, 899.5, 500.0, thick=1.0)]


@pytest.mark.l2_differential
def test_vector_segments_agree_with_raster_hough(tmp_path):
    """Те же линии, что находит растровая ветка (Хаф по рендеру), — с точностью до пикселя."""

    def draw(c):
        c.setLineWidth(2)
        c.line(60, 300, 540, 300)
        c.line(100, 50, 100, 350)
        c.line(300, 100, 400, 200)

    p = _pdf(tmp_path, draw)
    v = pk.extract_vectors(p, 1)
    doc = pdfium.PdfDocument(str(p))
    img = doc[0].render(scale=2).to_pil().convert("L")
    doc.close()
    raster = segments(img)
    vector = pk.segments_from_vector(v, img.size)
    assert len(raster) == len(vector) == 3
    for s in vector:
        r = min(
            raster,
            key=lambda r: abs(r.angle - s.angle) + abs(r.x0 - s.x0) + abs(r.y0 - s.y0),
        )
        assert abs(r.length - s.length) <= 2.0
        assert orientation(r.angle) == orientation(s.angle)
        mid_r, mid_s = r.at(r.span / 2), s.at(s.span / 2)
        assert abs(mid_r[0] - mid_s[0]) <= 1.5 and abs(mid_r[1] - mid_s[1]) <= 1.5


@pytest.mark.l7_discipline
def test_file_level_calls_wait_for_pdfium_lock(tmp_path):
    p = _pdf(tmp_path, _vector_sheet)
    done = threading.Event()
    with PDFIUM_LOCK:
        t = threading.Thread(
            target=lambda: (pk.detect_pages(p), pk.extract_vectors(p, 1), done.set())
        )
        t.start()
        assert not done.wait(0.3)
    t.join(5)
    assert done.is_set()


# ─────────────────────────────────────────────── правило вида (чистая функция) и геометрия


F = pk.PageFeatures


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "f, expected",
    [
        (F(), ("empty", ())),
        (F(text_chars=MIN_TEXT_CHARS), ("vector", ("text_layer",))),
        (F(text_chars=MIN_TEXT_CHARS - 1), ("vector", ("sparse",))),
        (F(path_segments=pk.VECTOR_MIN_SEGMENTS), ("vector", ("paths",))),
        (F(path_segments=pk.VECTOR_MIN_SEGMENTS - 1), ("vector", ("sparse",))),
        (F(image_objects=1, image_share=0.01), ("vector", ("sparse",))),
        (F(shading_objects=1), ("vector", ("sparse",))),
        (
            F(image_objects=1, image_share=pk.RASTER_INSET_SHARE),
            ("scan", ("image_without_text",)),
        ),
        (F(image_objects=1, image_share=0.09), ("vector", ("sparse",))),
        (
            F(
                image_objects=1,
                max_image_share=pk.FULL_PAGE_IMAGE,
                image_share=pk.FULL_PAGE_IMAGE,
            ),
            ("scan", ("full_page_image",)),
        ),
        (
            F(image_objects=9, max_image_share=0.2, image_share=pk.SCAN_IMAGE_SHARE),
            ("scan", ("images_cover_page",)),
        ),
        (
            F(image_objects=9, max_image_share=0.2, image_share=0.84),
            ("scan", ("image_without_text",)),
        ),
        (
            F(max_image_share=0.84, image_share=0.84, text_chars=MIN_TEXT_CHARS),
            ("hybrid", ("raster_insets",)),
        ),
        (
            F(
                max_image_share=1.0,
                image_share=1.0,
                text_chars=MIN_TEXT_CHARS,
                invisible_text=1,
            ),
            ("hybrid", ("full_page_image", "ocr_text_layer")),
        ),
        (
            F(max_image_share=1.0, image_share=1.0, text_chars=MIN_TEXT_CHARS - 1),
            ("scan", ("full_page_image",)),
        ),
        (
            F(
                max_image_share=1.0,
                image_share=1.0,
                path_segments=pk.VECTOR_MIN_SEGMENTS,
            ),
            ("hybrid", ("full_page_image", "vector_over_image")),
        ),
        (
            F(
                max_image_share=1.0,
                image_share=1.0,
                path_segments=pk.VECTOR_MIN_SEGMENTS - 1,
            ),
            ("scan", ("full_page_image",)),
        ),
        (
            F(text_chars=MIN_TEXT_CHARS, path_segments=99, image_share=0.099),
            ("vector", ("text_layer", "paths")),
        ),
    ],
)
def test_classify_thresholds(f, expected):
    assert pk.classify(f) == expected


@pytest.mark.l3_boundary
def test_text_as_curves_thresholds():
    n = pk.SHX_MIN_SMALL_PATHS
    base = {
        "path_segments": n * 4,
        "small_paths": n,
        "path_objects": n * 2,
        "text_chars": n // pk.SHX_PATHS_PER_CHAR - 1,
    }
    assert pk.text_as_curves(F(**base))
    assert pk.classify(F(**base)) == ("hybrid", ("text_as_curves",))
    assert not pk.text_as_curves(F(**{**base, "small_paths": n - 1}))
    assert not pk.text_as_curves(
        F(**{**base, "path_objects": n * 2 + 1})
    )  # мелких меньше половины
    assert not pk.text_as_curves(
        F(**{**base, "text_chars": n // pk.SHX_PATHS_PER_CHAR})
    )  # ровно в 5 раз — уже нет
    both = F(**{**base, "image_share": pk.RASTER_INSET_SHARE})
    assert pk.classify(both) == ("hybrid", ("text_as_curves", "raster_insets"))


@pytest.mark.l3_boundary
def test_full_page_image_boundary():
    assert F(max_image_share=pk.FULL_PAGE_IMAGE).full_page_image
    assert not F(max_image_share=pk.FULL_PAGE_IMAGE - 0.001).full_page_image


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "seg, expected",
    [
        ((0.2, 0.2, 0.8, 0.8), (0.2, 0.2, 0.8, 0.8)),
        ((-0.5, 0.5, 1.5, 0.5), (0.0, 0.5, 1.0, 0.5)),
        ((0.5, -1.0, 0.5, 2.0), (0.5, 0.0, 0.5, 1.0)),
        ((1.5, 0.5, -0.5, 0.5), (1.0, 0.5, 0.0, 0.5)),
        ((0.5, 2.0, 0.5, -1.0), (0.5, 1.0, 0.5, 0.0)),
        ((-1.0, -1.0, 2.0, 2.0), (0.0, 0.0, 1.0, 1.0)),
        ((0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 1.0, 0.0)),
        ((1.0, 1.0, 1.0, 1.0), (1.0, 1.0, 1.0, 1.0)),
        ((-0.5, 0.5, -0.1, 0.5), None),
        ((0.5, 1.2, 0.9, 1.5), None),
        ((1.1, 0.2, 1.1, 0.8), None),
        ((0.2, -0.1, 0.8, -0.1), None),
        ((-0.5, 0.2, 0.2, -0.5), None),  # по диагонали мимо угла
    ],
)
def test_clip_liang_barsky(seg, expected):
    got = pk._clip(*seg)
    assert got == (None if expected is None else pytest.approx(expected))


@pytest.mark.l1_functional
def test_matrix_helpers_compose_in_pdf_order():
    t = (1.0, 0.0, 0.0, 1.0, 10.0, 20.0)
    s = (2.0, 0.0, 0.0, 3.0, 0.0, 0.0)
    r = (0.0, 1.0, -1.0, 0.0, 0.0, 0.0)  # поворот на 90°
    assert pk._apply(pk._mul(t, s), 1, 1) == (
        22.0,
        63.0,
    )  # сначала сдвиг, потом масштаб
    assert pk._apply(pk._mul(s, t), 1, 1) == (12.0, 23.0)
    assert pk._apply(pk._mul(r, t), 1, 2) == (8.0, 21.0)
    assert pk._apply(pk._mul(t, r), 1, 2) == (-22.0, 11.0)
    assert pk._box_share(pk._IDENTITY, 0.5, 0.5, 1.5, 1.5) == 0.25
    assert pk._box_share(pk._IDENTITY, 1.5, 0.0, 2.0, 1.0) == 0.0
    assert pk._box_share(pk._IDENTITY, 0.0, 1.5, 1.0, 2.0) == 0.0
    assert pk._box_share((0.5, 0.0, 0.0, 0.5, 0.25, 0.25), 0, 0, 1, 1) == 0.25


@pytest.mark.l1_functional
def test_polyline_moves_lines_curves_and_close():
    pts = [
        ("M", (0, 0), False),
        ("L", (10, 0), False),
        ("L", (10, 10), True),  # закрыть к (0,0)
        ("M", (20, 0), False),
        ("C", (20, 10), False),
        ("C", (30, 10), False),
        ("C", (30, 0), True),  # кривая, затем замыкание к (20,0)
        ("L", (40, 0), False),  # после замыкания текущая точка — начало подпути
        ("C", (1, 1), False),  # оборванная кривая в конце — отбрасывается
    ]
    edges = pk._polyline(pts)
    assert edges[:3] == [
        ((0, 0), (10, 0), False, False),
        ((10, 0), (10, 10), False, False),
        ((10, 10), (0, 0), False, True),
    ]
    curve = edges[3 : 3 + pk.BEZIER_STEPS]
    assert (
        all(e[2] for e in curve)
        and curve[0][0] == (20, 0)
        and curve[-1][1] == pytest.approx((30, 0))
    )
    assert edges[3 + pk.BEZIER_STEPS] == ((30.0, 0.0), (20, 0), False, True)
    assert edges[-1] == ((20, 0), (40, 0), False, False)
    assert len(edges) == 3 + pk.BEZIER_STEPS + 2
    assert pk._polyline([("L", (5, 5), False), ("L", (6, 5), False)]) == [
        ((5, 5), (6, 5), False, False)
    ]
    assert pk._polyline([("M", (0, 0), False), ("L", (0, 0), True)]) == [
        ((0, 0), (0, 0), False, True)
    ]


@pytest.mark.l1_functional
def test_bezier_points():
    pts = pk._bezier((0, 0), (0, 1), (1, 1), (1, 0), steps=2)
    assert pts == [pytest.approx((0.5, 0.75)), pytest.approx((1.0, 0.0))]
    assert len(pk._bezier((0, 0), (0, 0), (0, 0), (0, 0))) == pk.BEZIER_STEPS


# ─────────────────────────────────────────────── добор по выжившим мутантам


@pytest.mark.l1_functional
def test_nested_forms_shading_dash_variants_and_fill_only(tmp_path):
    from reportlab.lib.colors import blue, red

    def draw(c):
        c.linearGradient(0, 0, 100, 100, (red, blue), extend=False)
        c.linearGradient(200, 0, 300, 100, (blue, red), extend=False)
        c.beginForm("B")
        c.line(0, 0, 50, 0)
        c.endForm()
        c.beginForm("A")
        c.doForm("B")
        c.endForm()
        c.doForm("A")
        c.setDash([4])  # штрих из одного числа
        c.line(0, 300, 300, 300)
        c.setDash([1.5, 0.5], 0.25)  # дробный штрих и фаза
        c.line(0, 310, 300, 310)
        c.setDash()
        c.rect(100, 100, 20, 20, stroke=0, fill=1)  # только заливка
        c.drawImage(_scan_image(), 0, 0, W, H)
        c.drawImage(_scan_image(), 0, 0, W, H)  # два полностраничных — сумма не больше 1

    p = _pdf(tmp_path, draw)
    [r] = pk.detect_pages(p)
    f = r.features
    assert (f.shading_objects, f.form_objects, f.path_objects, f.image_objects) == (2, 2, 4, 2)
    assert f.image_share == 1.0
    paths = _by_path(pk.extract_vectors(p, 1).segments)
    [solid], [one], [phased] = paths[0], paths[1], paths[2]
    assert (solid.dash, solid.dash_phase) == ((), 0.0)
    assert (one.dash, one.dash_phase) == ((4.0,), 0.0)
    assert (phased.dash, phased.dash_phase) == ((1.5, 0.5), 0.25)
    fill_only = paths[3]
    assert all(s.stroke_rgba is None and not s.stroke and s.fill_rgba == (0, 0, 0, 255) for s in fill_only)


@pytest.mark.l3_boundary
@pytest.mark.parametrize("depth, expect_path", [(1, False), (2, True)])
def test_form_depth_limit(tmp_path, monkeypatch, depth, expect_path):
    def draw(c):
        c.beginForm("B")
        c.line(0, 0, 50, 0)
        c.endForm()
        c.beginForm("A")
        c.doForm("B")
        c.endForm()
        c.doForm("A")

    p = _pdf(tmp_path, draw)
    monkeypatch.setattr(pk, "MAX_FORM_DEPTH", depth)
    [r] = pk.detect_pages(p)
    assert (r.features.form_objects, r.features.path_objects) == (2, int(expect_path))


@pytest.mark.l3_boundary
def test_small_path_boundary_and_single_char_text(tmp_path):
    def draw(c):
        c.rect(10, 10, 20, 20, stroke=0, fill=1)  # ровно 20×20 — мелкий
        c.rect(100, 10, 20, 21, stroke=0, fill=1)
        c.rect(200, 10, 21, 20, stroke=0, fill=1)
        c.rect(300, 10, 5, 40, stroke=0, fill=1)
        c.rect(400, 10, 40, 5, stroke=0, fill=1)
        c.drawString(500, 300, "X")

    [r] = pk.detect_pages(_pdf(tmp_path, draw))
    assert (r.features.small_paths, r.features.path_objects, r.features.text_chars) == (1, 5, 1)


@pytest.mark.l1_functional
def test_image_share_is_rounded_to_4_digits(tmp_path):
    [r] = pk.detect_pages(_pdf(tmp_path, lambda c: c.drawImage(_scan_image(), 0, 0, 100, 100)))
    assert (r.features.image_share, r.features.max_image_share) == (0.0417, 0.0417)


@pytest.mark.l1_functional
def test_transformed_path_matrix_width_and_subpaths(tmp_path):
    p = _pdf(tmp_path, lambda c: c.showPage())
    doc = pdfium.PdfDocument(str(p))
    page = doc[0]
    ghost = pdfium_c.FPDFPageObj_CreateNewPath(5, 5)  # невидимый — первым: обход не должен на нём остановиться
    pdfium_c.FPDFPath_LineTo(ghost, 200, 5)
    pdfium_c.FPDFPath_SetDrawMode(ghost, pdfium_c.FPDF_FILLMODE_NONE, False)
    pdfium_c.FPDFPage_InsertObject(page.raw, ghost)
    obj = pdfium_c.FPDFPageObj_CreateNewPath(0, 0)
    pdfium_c.FPDFPath_LineTo(obj, 10, 0)
    pdfium_c.FPDFPath_MoveTo(obj, 0, 10)  # второй подпуть — не соединяется с первым
    pdfium_c.FPDFPath_LineTo(obj, 10, 10)
    pdfium_c.FPDFPath_SetDrawMode(obj, pdfium_c.FPDF_FILLMODE_NONE, True)
    pdfium_c.FPDFPageObj_SetStrokeWidth(obj, ctypes.c_float(1.0))
    pdfium_c.FPDFPageObj_Transform(obj, 2, 1, 2, 3, 100, 50)  # |det| = 4 → толщина × 2
    pdfium_c.FPDFPage_InsertObject(page.raw, obj)
    with PDFIUM_LOCK:
        v = pk.page_vectors(page)
    page.close()
    doc.close()
    assert v.page == 1 and len(v.segments) == 2 and {s.path for s in v.segments} == {1}
    a, b = v.segments
    # (x, y) → (2x + 2y + 100, x + 3y + 50) в pt; доли: x / 600, 1 − y / 400
    assert (a.x0, a.y0, a.x1, a.y1) == pytest.approx((100 / W, 1 - 50 / H, 120 / W, 1 - 60 / H), abs=TOL)
    assert (b.x0, b.y0, b.x1, b.y1) == pytest.approx((120 / W, 1 - 80 / H, 140 / W, 1 - 90 / H), abs=TOL)
    assert a.width_pt == pytest.approx(2.0)


@pytest.mark.l6_adversarial
def test_detect_pages_skips_invalid_numbers_anywhere_and_times_pages(tmp_path):
    p = tmp_path / "m.pdf"
    c = canvas.Canvas(str(p), pagesize=(W, H))
    _vector_sheet(c)
    c.showPage()
    c.drawImage(_scan_image(), 0, 0, W, H)
    c.showPage()
    c.save()
    res = pk.detect_pages(p, [0, 2, 5, 1])
    assert [(r.page, r.kind) for r in res] == [(2, "scan"), (1, "vector")]
    assert all(0 < r.seconds < 1 for r in res)
    with pytest.raises(IndexError, match="нет страницы 3: в документе 2"):
        pk.extract_vectors(p, 3)
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.7\n")
    with pytest.raises(CorruptedFile, match="bad.pdf"):
        pk.detect_pages(bad)


@pytest.mark.l3_boundary
def test_segments_from_vector_edges_order_and_rounding():
    def vs(x0, y0, x1, y1, **kw):
        base = {"path": 0, "width_pt": 0.0, "stroke": True, "fill_mode": 0}
        base.update(kw)
        return pk.VectorSegment(x0, y0, x1, y1, **base)

    segs = (
        vs(0.1, 0.1, 0.9, 0.1, stroke=False, fill_mode=1),  # отброшенные — первыми: обход идёт дальше
        vs(0.1, 0.2, 0.9, 0.2, curve=True),
        vs(0.1, 0.3, 0.1001, 0.3),  # 0,1 px
        vs(0.0, 0.0, 0.4, 0.7, width_pt=3.0),  # наклон: полпикселя внутрь по оси
        vs(0.5, 0.9, 0.5, 0.9 - MIN_DIM_PX / 1000),  # ровно MIN_DIM_PX — берётся
    )
    vec = pk.PageVectors(1, 0.0, 0.0, segs)  # размер страницы неизвестен — толщина 1 px
    got = pk.segments_from_vector(vec, (1000, 1000))
    assert got == [
        Segment(0.25, 0.43, 399.75, 699.57, thick=1.0),
        Segment(500.0, 899.5, 500.0, 860.5, thick=1.0),
    ]
    tiny = pk.PageVectors(1, 100.0, 100.0, (vs(0.0, 0.5, 0.001, 0.5), vs(0.0, 0.6, 0.0015, 0.6)))
    assert [s.y0 for s in pk.segments_from_vector(tiny, (1000, 1000), min_len_px=0)] == [600.0]


@pytest.mark.l1_functional
def test_geometry_helpers_extra_cases():
    r = (0.0, 1.0, -1.0, 0.0, 0.0, 0.0)
    assert pk._mul(r, r) == (-1.0, 0.0, 0.0, -1.0, 0.0, 0.0)  # два поворота на 90° — на 180°
    pts = pk._bezier((10, 20), (10, 20), (10, 20), (10, 20), steps=2)
    assert pts == [pytest.approx((10, 20)), pytest.approx((10, 20))]
    assert pk._clip(-0.5, 0.5, 0.5, -0.5) == pytest.approx((0.0, 0.0, 0.0, 0.0))  # касание угла — точка
    edges = pk._polyline([("M", (0, 0), False), ("C", (0, 1), False), ("C", (1, 1), False)])
    assert edges == []  # кривая без конечной точки
    assert not any(e[3] for e in pk._polyline([("M", (0, 0), False), ("C", (0, 1), False), ("C", (1, 1), False), ("C", (1, 0), False)]))
