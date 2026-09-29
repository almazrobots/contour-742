"""T-177: отметки изменений для CMP-29 — облако ревизии и номер рядом (IDN-04), выноска «Изм. N», таблица изменений
основной надписи (IDN-03). Листы — синтетика reportlab в tmp (ADR-0002). Строка качества IDN-04 — ≥ 100 листов
с облаком и ≥ 100 листов с похожими, но не облачными фигурами (окружность из гладких дуг, эллипс, скруглённый
прямоугольник, открытая волна, крошечное облако, рамка листа).
"""

from __future__ import annotations

import math
import random
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml import change_marks as cm
from inspector_ml.model import Line, Page, Word
from inspector_ml.parse import parse_pdf
from inspector_ml.paths import repo_root

if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(
        TTFont("Noto", str(repo_root() / "assets/fonts/NotoSans.ttf"))
    )

W, H = landscape(A3)


def cloud(
    c, x0, y0, x1, y1, step=18.0, bump=6.0, poly=False, jitter=0.0, rnd=None, close=True
):
    """Облако по прямоугольнику (pt, начало снизу): дуги наружу, на стыках — острия."""
    pts = []
    for (ax, ay), (bx, by) in (
        ((x0, y0), (x1, y0)),
        ((x1, y0), (x1, y1)),
        ((x1, y1), (x0, y1)),
        ((x0, y1), (x0, y0)),
    ):
        n = max(2, int(math.dist((ax, ay), (bx, by)) // step))
        pts += [(ax + (bx - ax) * i / n, ay + (by - ay) * i / n) for i in range(n)]
    p = c.beginPath()
    p.moveTo(*pts[0])
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for i in range(len(pts) if close else len(pts) - 1):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        nx, ny = mx - cx, my - cy
        k = math.hypot(nx, ny) or 1.0
        h = bump * (1 + (rnd.uniform(-jitter, jitter) if rnd else 0))
        nx, ny = nx / k * h, ny / k * h
        if poly:  # дуга ломаной из 6 звеньев
            for t in range(1, 7):
                s = t / 6
                bx_ = a[0] + (b[0] - a[0]) * s + nx * 1.6 * math.sin(math.pi * s)
                by_ = a[1] + (b[1] - a[1]) * s + ny * 1.6 * math.sin(math.pi * s)
                p.lineTo(bx_, by_)
        else:
            p.curveTo(a[0] + nx, a[1] + ny, b[0] + nx, b[1] + ny, b[0], b[1])
    if close:
        p.close()
    c.drawPath(p, stroke=1, fill=0)


def zigzag_cloud(c, x0, y0, x1, y1, r=4.5, exploded=True):
    """Облако как у стенда мутаций T-179: гребешки из двух отрезков, каждый отрезок — отдельная линия PDF."""
    pts = []
    for ax, ay, bx, by in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
        k = max(2, int(math.hypot(bx - ax, by - ay) / (2 * r)))
        for i in range(k):
            sx, sy = ax + (bx - ax) * i / k, ay + (by - ay) * i / k
            ex, ey = ax + (bx - ax) * (i + 1) / k, ay + (by - ay) * (i + 1) / k
            nx, ny = -(ey - sy), (ex - sx)  # гребешок наружу, как у стенда T-179
            ln = math.hypot(nx, ny) or 1
            px, py = (sx + ex) / 2 - nx / ln * r, (sy + ey) / 2 - ny / ln * r
            pts += [(sx, sy), (px, py)]
    pts.append(pts[0])
    if exploded:
        for a, b in zip(pts, pts[1:]):
            c.line(*a, *b)
    else:
        p = c.beginPath()
        p.moveTo(*pts[0])
        for q in pts[1:]:
            p.lineTo(*q)
        p.close()
        c.drawPath(p, stroke=1, fill=0)


def exploded_cloud(c, x0, y0, x1, y1, step=18.0, bump=6.0):
    """Облако из дуг, каждая дуга — отдельный путь PDF («взорванный» блок CAD)."""
    pts = []
    for (ax, ay), (bx, by) in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        n = max(2, int(math.dist((ax, ay), (bx, by)) // step))
        pts += [(ax + (bx - ax) * i / n, ay + (by - ay) * i / n) for i in range(n)]
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        mx, my = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy
        k = math.hypot(mx, my) or 1
        nx, ny = mx / k * bump, my / k * bump
        p = c.beginPath()
        p.moveTo(*a)
        p.curveTo(a[0] + nx, a[1] + ny, b[0] + nx, b[1] + ny, b[0], b[1])
        c.drawPath(p, stroke=1, fill=0)


def stairs(c, x, y, n=8, t=12.0, h=9.0):
    """Ступенчатый замкнутый контур из отдельных осевых отрезков — не облако."""
    pts = [(x, y)]
    for i in range(n):
        pts += [(x + i * t, y + (i + 1) * h), (x + (i + 1) * t, y + (i + 1) * h)]
    pts += [(x + n * t, y), (x, y)]
    for a, b in zip(pts, pts[1:]):
        c.line(*a, *b)


def exploded_circle(c, cx, cy, r, n=36):
    """Окружность из отдельных коротких отрезков — поворот мал, не облако."""
    pts = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]
    for a, b in zip(pts, pts[1:]):
        c.line(*a, *b)


def smooth_circle(c, cx, cy, r, n=12):
    """Окружность из n гладких кривых Безье — как её выгружают CAD: стыки без излома."""
    k = 4 / 3 * math.tan(math.pi / (2 * n))
    p = c.beginPath()
    p.moveTo(cx + r, cy)
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
        p3 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
        c1 = (p0[0] - k * r * math.sin(a0), p0[1] + k * r * math.cos(a0))
        c2 = (p3[0] + k * r * math.sin(a1), p3[1] - k * r * math.cos(a1))
        p.curveTo(*c1, *c2, *p3)
    p.close()
    c.drawPath(p, stroke=1, fill=0)


def smooth_polygon(c, cx, cy, r, n=48):
    """Окружность ломаной из n звеньев: поворот на каждом звене мал, острых изломов нет."""
    p = c.beginPath()
    p.moveTo(cx + r, cy)
    for i in range(1, n + 1):
        a = 2 * math.pi * i / n
        p.lineTo(cx + r * math.cos(a), cy + r * math.sin(a))
    p.close()
    c.drawPath(p, stroke=1, fill=0)


def triangle(c, x, y, s=14.0, num="3", exploded=False):
    if exploded:  # три отдельные линии, как у стенда T-179
        c.line(x, y, x + s, y)
        c.line(x + s, y, x + s / 2, y + s * 0.87)
        c.line(x + s / 2, y + s * 0.87, x, y)
    else:
        p = c.beginPath()
        p.moveTo(x, y)
        p.lineTo(x + s, y)
        p.lineTo(x + s / 2, y + s * 0.87)
        p.close()
        c.drawPath(p, stroke=1, fill=0)
    c.setFont("Noto", 7)
    c.drawCentredString(x + s / 2, y + 2.5, num)


def sheet(path: Path, draw) -> Path:
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1)
    c.setFont("Noto", 9)
    c.drawString(60, H - 60, "План 3 этажа. Экспликация помещений")
    draw(c)
    c.showPage()
    c.save()
    return path


def marks(path: Path):
    return cm.change_marks(path, parse_pdf(path, "0" * 64))


# ─────────────────────────────── IDN-04: облако и номер рядом


@pytest.mark.l1_functional
def test_cloud_with_number_in_triangle_found(tmp_path):
    def d(c):
        c.drawString(300, 300, "В25")
        cloud(c, 280, 280, 380, 340)
        triangle(c, 385, 342, num="3")

    ms = [m for m in marks(sheet(tmp_path / "a.pdf", d)) if m.kind == "cloud"]
    assert len(ms) == 1
    m = ms[0]
    assert m.number == "3" and m.page == 1
    # рамка облака в долях листа, начало — левый верхний угол
    assert m.bbox[0] == pytest.approx((280 - 6) / W, abs=0.01) and m.bbox[
        3
    ] == pytest.approx(1 - (280 - 6) / H, abs=0.01)


@pytest.mark.l1_functional
def test_cloud_number_from_callout_when_no_triangle(tmp_path):
    def d(c):
        cloud(c, 280, 280, 380, 340)
        c.drawString(390, 345, "Изм. №4")

    ms = marks(sheet(tmp_path / "b.pdf", d))
    assert [m.number for m in ms if m.kind == "cloud"] == ["4"]
    assert [(m.kind, m.number) for m in ms if m.kind == "callout"] == [("callout", "4")]


@pytest.mark.l1_functional
def test_cloud_without_number_and_polyline_cloud(tmp_path):
    def d(c):
        cloud(c, 100, 100, 220, 180, poly=True)
        cloud(c, 500, 400, 640, 480)
        c.drawString(700, 700, "12")  # далёкое число — не номер изменения

    ms = [m for m in marks(sheet(tmp_path / "c.pdf", d)) if m.kind == "cloud"]
    assert len(ms) == 2 and all(m.number is None for m in ms)


@pytest.mark.l1_functional
def test_cloud_from_separate_lines_and_arcs_with_exploded_triangle(tmp_path):
    def d(c):
        zigzag_cloud(c, 280, 280, 380, 340)
        triangle(c, 390, 342, num="1", exploded=True)
        exploded_cloud(c, 600, 500, 720, 580)
        zigzag_cloud(c, 100, 600, 200, 660, exploded=False)

    ms = sorted((m.bbox[0], m.number) for m in marks(sheet(tmp_path / "z.pdf", d)) if m.kind == "cloud")
    assert [n for _, n in ms] == [None, "1", None]


@pytest.mark.l6_adversarial
def test_not_clouds_stairs_and_exploded_circle(tmp_path):
    def d(c):
        stairs(c, 100, 100)
        exploded_circle(c, 500, 300, 60)
        for i in range(40):  # штриховка: отдельные параллельные отрезки, контура не образуют
            c.line(700 + i * 4, 400, 720 + i * 4, 430)

    assert [m for m in marks(sheet(tmp_path / "st.pdf", d)) if m.kind == "cloud"] == []


@pytest.mark.l3_boundary
def test_triangle_far_from_cloud_gives_no_number(tmp_path):
    def d(c):
        cloud(c, 280, 280, 380, 340)
        triangle(c, 380 + 0.08 * W, 342, num="5")

    ms = [m for m in marks(sheet(tmp_path / "d.pdf", d)) if m.kind == "cloud"]
    assert ms[0].number is None


@pytest.mark.l6_adversarial
def test_not_clouds_circle_rect_open_wave_tiny_frame(tmp_path):
    def d(c):
        c.circle(200, 200, 40)  # 4 гладкие дуги
        smooth_circle(c, 400, 200, 50)  # 12 гладких дуг
        smooth_polygon(c, 600, 200, 50)  # 48 звеньев без изломов
        c.ellipse(700, 400, 850, 480)
        c.roundRect(100, 400, 150, 80, 12)
        c.rect(300, 400, 150, 80)
        cloud(c, 500, 600, 640, 700, close=False)  # открытая волна
        cloud(c, 900, 700, 905, 704, step=1.5, bump=0.6)  # меньше 1 % листа
        c.rect(20, 20, W - 40, H - 40)  # рамка листа

    assert [m for m in marks(sheet(tmp_path / "e.pdf", d)) if m.kind == "cloud"] == []


@pytest.mark.l1_functional
def test_callouts_from_text_and_header_without_number_skipped():
    def w(t, x):
        return Word(text=t, bbox=(x, 0.5, x + 0.02, 0.51))

    p = Page(page=2, width=1190, height=842, source="text", lines=[
        Line(text="см. Изм. №3", words=[w("см.", 0.1), w("Изм.", 0.13), w("№3", 0.16)]),
        Line(text="изм.12 лист", words=[w("изм.12", 0.3), w("лист", 0.33)]),
        Line(text="Изм. Кол.уч Лист", words=[w("Изм.", 0.5), w("Кол.уч", 0.53), w("Лист", 0.56)]),
        Line(text="Изменения 3", words=[w("Изменения", 0.7), w("3", 0.73)]),
    ])  # fmt: skip
    got = [(m.number, m.text, m.bbox[0]) for m in cm.callouts(p)]
    assert got == [("3", "Изм. №3", 0.13), ("12", "изм.12", 0.3)]


# ─────────────────────────────── IDN-03: таблица изменений штампа


@pytest.mark.l1_functional
def test_stamp_change_rows_read(tmp_path):
    from test_titleblock import A3L, CHANGE, VALUES3, draw_sheet, spec

    page = parse_pdf(
        draw_sheet(tmp_path / "s.pdf", A3L, spec(3, VALUES3, change=CHANGE), 3),
        "0" * 64,
    ).pages[0]
    rows = cm.stamp_rows(page)
    assert [(r.kind, r.number, r.bbox) for r in rows] == [("stamp_row", "2", None)]
    assert rows[0].text.startswith("2 1 3 15-25")
    # без штампа и у структурированного документа строк нет
    assert (
        cm.stamp_rows(Page(page=1, width=1, height=1, source="structured", lines=[]))
        == []
    )
    empty = parse_pdf(sheet(tmp_path / "n.pdf", lambda c: None), "0" * 64).pages[0]
    assert cm.stamp_rows(empty) == []


@pytest.mark.l4_fault
def test_docx_and_broken_pdf_do_not_break_analysis(tmp_path):
    from inspector_ml.model import ParsedDoc

    doc = ParsedDoc(sha256="0" * 64, kind="docx", engine="t", pages=[Page(page=1, width=1, height=1, source="structured", lines=[
        Line(text="Изм. 2", words=[Word(text="Изм.", bbox=None), Word(text="2", bbox=None)])])])  # fmt: skip
    assert cm.change_marks(None, doc) == []
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4 broken")
    pdf_doc = ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="t",
        pages=[Page(page=1, width=1, height=1, source="text", lines=[])],
    )
    assert cm.change_marks(bad, pdf_doc) == []


@pytest.mark.l1_functional
def test_geometry_helpers():
    assert cm.gap((0, 0, 0.1, 0.1), (0.05, 0.05, 0.2, 0.2)) == 0
    assert cm.gap((0, 0, 0.1, 0.1), (0.4, 0.1, 0.5, 0.2)) == pytest.approx(0.3)
    assert cm._angle((1, 0), (0, 1)) == pytest.approx(90)
    assert cm._angle((0, 0), (1, 0)) is None
    tri = [
        ("L", [(0, 0), (0.02, 0)]),
        ("L", [(0.02, 0), (0.01, 0.02)]),
        ("L", [(0.01, 0.02), (0, 0)]),
    ]
    assert cm.is_triangle(tri, True) and not cm.is_triangle(tri, False)
    big = [
        ("L", [(0, 0), (0.2, 0)]),
        ("L", [(0.2, 0), (0.1, 0.2)]),
        ("L", [(0.1, 0.2), (0, 0)]),
    ]
    assert not cm.is_triangle(big, True)


# ─────────────────────────────── строка качества IDN-04: ≥ 100 положительных, ≥ 100 отрицательных


def _positive(c, rnd):
    x0 = rnd.uniform(80, W - 400)
    y0 = rnd.uniform(80, H - 300)
    w, h = rnd.uniform(60, 300), rnd.uniform(40, 200)
    v = rnd.random()
    if v < 0.2:
        zigzag_cloud(c, x0, y0, x0 + w, y0 + h, r=rnd.uniform(3, 7))
    elif v < 0.35:
        exploded_cloud(c, x0, y0, x0 + w, y0 + h, step=rnd.uniform(10, 30), bump=rnd.uniform(3, 9))
    else:
        cloud(c, x0, y0, x0 + w, y0 + h, step=rnd.uniform(10, 30), bump=rnd.uniform(3, 9), poly=rnd.random() < 0.3, jitter=0.3, rnd=rnd)


def _negative(c, rnd):
    x, y = rnd.uniform(150, W - 300), rnd.uniform(150, H - 250)
    r = rnd.uniform(20, 90)
    kind = rnd.randrange(9)
    if kind == 0:
        c.circle(x, y, r)
    elif kind == 1:
        smooth_circle(c, x, y, r, n=rnd.choice([8, 12, 16, 24]))
    elif kind == 2:
        smooth_polygon(c, x, y, r, n=rnd.choice([24, 36, 64]))
    elif kind == 3:
        c.ellipse(x - r, y - r / 2, x + r, y + r / 2)
    elif kind == 4:
        c.roundRect(x, y, 2 * r, r, rnd.uniform(3, 15))
    elif kind == 5:
        cloud(c, x, y, x + 2 * r, y + r, close=False)
    elif kind == 6:
        cloud(c, x, y, x + 5, y + 4, step=1.5, bump=0.6)
    elif kind == 7:
        stairs(c, x, y, n=rnd.randrange(4, 12), t=rnd.uniform(6, 20), h=rnd.uniform(5, 15))
    else:
        exploded_circle(c, x, y, r, n=rnd.choice([24, 36, 72]))


@pytest.mark.l6_adversarial
def test_quality_idn04_cloud_detector_on_200_synthetic_sheets(tmp_path, capsys):
    rnd = random.Random(177)
    path = tmp_path / "q.pdf"
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1)
    truth = []
    for i in range(240):
        pos = i % 2 == 0
        c.setFont("Noto", 9)
        c.drawString(60, H - 60, f"Лист {i + 1}. План этажа. Экспликация помещений, примечания и ведомость отделки")  # текстовый слой: без него страница уходит в OCR
        (_positive if pos else _negative)(c, rnd)
        truth.append(pos)
        c.showPage()
    c.save()
    found = {
        m.page
        for m in cm.change_marks(path, parse_pdf(path, "0" * 64))
        if m.kind == "cloud"
    }
    tp = sum(1 for i, t in enumerate(truth) if t and i + 1 in found)
    fp = sum(1 for i, t in enumerate(truth) if not t and i + 1 in found)
    npos, nneg = sum(truth), len(truth) - sum(truth)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / npos
    with capsys.disabled():
        print(
            f"\nIDN-04 облака: n+={npos} n-={nneg} TP={tp} FP={fp} P={precision:.3f} R={recall:.3f} FPR={fp / nneg:.3f}"
        )
    assert npos >= 100 and nneg >= 100
    assert precision >= 0.95 and recall >= 0.95


# ─────────────────────────────── OWASP T-177: враждебный PDF не держит ML-сервис


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_star_of_loose_segments_is_linear():
    """SEC-01: N звеньев в одном узле («звезда») — не контур и не квадратичный обход."""
    import time as _t

    n = 20_000
    star = [("L", [(0.5, 0.5), (0.5 + 0.01 * math.cos(i), 0.5 + 0.01 * math.sin(i))]) for i in range(n)]
    t0 = _t.monotonic()
    assert cm.loose_cycles(star) == []
    assert _t.monotonic() - t0 < 2.0


@pytest.mark.l6_adversarial
def test_star_pdf_and_budgets(tmp_path, monkeypatch):
    """SEC-02: звезда из одного пути в PDF; бюджеты объектов, облаков и времени документа."""

    def d(c):
        p = c.beginPath()
        for i in range(3000):
            p.moveTo(400, 400)
            p.lineTo(400 + 8 * math.cos(i), 400 + 8 * math.sin(i))
        c.drawPath(p, stroke=1, fill=0)
        for i in range(5):
            cloud(c, 60 + 150 * i, 100, 180 + 150 * i, 160)
        c.drawString(700, 700, "Изм. 4")

    path = sheet(tmp_path / "star.pdf", d)
    doc = parse_pdf(path, "0" * 64)
    assert len([m for m in cm.change_marks(path, doc) if m.kind == "cloud"]) == 5
    monkeypatch.setattr(cm, "MAX_CLOUDS", 2)
    assert len([m for m in cm.change_marks(path, doc) if m.kind == "cloud"]) == 2
    monkeypatch.setattr(cm, "MAX_MARKS", 1)
    assert len(cm.change_marks(path, doc)) == 1
    monkeypatch.setattr(cm, "MAX_MARKS", 2000)
    monkeypatch.setattr(cm, "MAX_PAGE_OBJECTS", 1)
    assert [m for m in cm.change_marks(path, doc) if m.kind == "cloud"] == []
    monkeypatch.setattr(cm, "MAX_PAGE_OBJECTS", 200_000)
    monkeypatch.setattr(cm, "DOC_BUDGET_S", -1.0)
    ms = cm.change_marks(path, doc)
    assert [m.kind for m in ms] == ["callout"]  # облака не искались, выноска из текста осталась


@pytest.mark.l4_fault
def test_any_pdfium_failure_keeps_text_marks(tmp_path, monkeypatch):
    """SEC-07: любой сбой прохода по путям — только отметки из текста, анализ не падает."""
    path = sheet(tmp_path / "f.pdf", lambda c: c.drawString(300, 300, "Изм. 2"))
    doc = parse_pdf(path, "0" * 64)

    def boom(_):
        raise RuntimeError("pdfium")

    monkeypatch.setattr(cm, "page_shapes", boom)
    assert [(m.kind, m.number) for m in cm.change_marks(path, doc)] == [("callout", "2")]


@pytest.mark.l6_adversarial
def test_stamp_row_long_number_is_not_change_number(monkeypatch):
    """SEC-07: в графе «Изм.» тысячи цифр — не номер изменения, int() не падает."""

    class TB:
        changes = [{"izm": "9" * 5000}, {"izm": "12"}]

    monkeypatch.setattr(cm, "read_title_block", lambda page: TB())
    page = Page(page=1, width=1, height=1, source="text", lines=[Line(text="x", words=[Word(text="x", bbox=(0, 0, 0.1, 0.1))])])
    assert [r.number for r in cm.stamp_rows(page)] == ["12"]


@pytest.mark.l6_adversarial
def test_subpaths_bounded_by_points_and_segment_cap(monkeypatch):
    """SEC-11: subpaths делает не больше итераций, чем точек, и не больше MAX_SUBPATH_SEGS звеньев."""
    pts = [("M", (0.0, 0.0), False)] + [("L", (0.001 * i, 0.0), False) for i in range(1, 50)]
    segs, closed = cm.subpaths(pts)[0]
    assert len(segs) == 49 and not closed
    monkeypatch.setattr(cm, "MAX_SUBPATH_SEGS", 10)
    assert len(cm.subpaths(pts)[0][0]) == 10
    # замыкание добавляет звено к началу; незаконченная кривая в конце — отбрасывается
    tri = [("M", (0.0, 0.0), False), ("L", (0.1, 0.0), False), ("L", (0.05, 0.1), True)]
    segs, closed = cm.subpaths(tri)[0]
    assert closed and len(segs) == 3 and segs[-1] == ("L", [(0.05, 0.1), (0.0, 0.0)])
    cut = [("M", (0.0, 0.0), False), ("C", (0.1, 0.1), False)]
    assert cm.subpaths(cut) == []
    two = [("M", (0.0, 0.0), False), ("L", (0.1, 0.0), False), ("M", (0.5, 0.5), False), ("C", (0.6, 0.6), False), ("C", (0.7, 0.6), False), ("C", (0.8, 0.5), False)]
    got = cm.subpaths(two)
    assert [len(s) for s, _ in got] == [1, 1] and got[1][0][0][0] == "C"
