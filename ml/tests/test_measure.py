"""OS-INSP-2.4: масштаб по размерной линии, расстояния между линиями, отказ при противоречии."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from inspector_ml.measure import determine_scale, distances
from inspector_ml.model import Line, Word

W, H = 2000, 1400


def sheet():
    img = Image.new("L", (W, H), 255)
    return img, ImageDraw.Draw(img)


def dim(d, x0, x1, y, label: str) -> Line:
    """Размерная линия с засечками и подписью над серединой (подпись — «слово» OCR с bbox)."""
    d.line((x0, y, x1, y), fill=0, width=2)
    for x in (x0, x1):
        d.line((x - 8, y + 8, x + 8, y - 8), fill=0, width=2)  # засечка 45°
    cx, tw = (x0 + x1) / 2, 18 * len(label)
    box = ((cx - tw / 2) / W, (y - 40) / H, (cx + tw / 2) / W, (y - 12) / H)
    return Line(text=label, words=[Word(text=label, bbox=box)])


def walls(d, xs, y0=300, y1=1100):
    for x in xs:
        d.line((x, y0, x, y1), fill=0, width=4)


@pytest.mark.l1_functional
def test_scale_from_two_consistent_dimension_lines_within_1pct():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000"), dim(d, 1100, 1500, 1250, "3000")]  # 7,5 мм/px
    r = determine_scale(img, lines)
    assert (r.status, r.method) == ("OK", "dimension_line")
    assert r.mm_per_px == pytest.approx(7.5, rel=0.01)
    assert [e["mm"] for e in r.evidence] == [6000, 3000]
    assert all(len(e["line_bbox"]) == 4 for e in r.evidence)


@pytest.mark.l1_functional
def test_distance_between_walls_in_mm_within_2pct_with_bboxes():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000")]  # 7,5 мм/px
    walls(d, [300, 700, 1300])  # 400 px = 3000 мм, 600 px = 4500 мм
    r = determine_scale(img, lines)
    xs = [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "x"]
    assert [x.mm for x in xs] == [pytest.approx(3000, rel=0.02), pytest.approx(4500, rel=0.02)]
    a, b = xs[0].a_bbox, xs[0].b_bbox
    assert a[0] < b[0] and len(a) == len(b) == 4


@pytest.mark.l6_adversarial
def test_contradicting_dimension_lines_give_not_comparable_and_no_measurements():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000"), dim(d, 1100, 1500, 1250, "3600")]  # 7,5 vs 9,0 мм/px
    walls(d, [300, 700])
    r = determine_scale(img, lines)
    assert (r.status, r.method, r.mm_per_px) == ("NOT_COMPARABLE", "inconsistent", None)
    assert len(r.evidence) == 2  # видно, какие линии поспорили
    assert distances(img, r) == []


@pytest.mark.l3_boundary
def test_no_dimension_line_or_number_far_from_line_gives_not_comparable():
    img, d = sheet()
    walls(d, [300, 700])
    far = Line(text="6000", words=[Word(text="6000", bbox=(0.3, 0.1, 0.35, 0.12))])  # число без линии под ним
    r = determine_scale(img, [far])
    assert (r.status, r.method) == ("NOT_COMPARABLE", "none")


@pytest.mark.l6_adversarial
def test_non_numeric_label_and_short_lines_ignored():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "Ось А")]
    d.line((1200, 1250, 1230, 1250), fill=0, width=2)  # 30 px — засечка, не линия
    tiny = Line(text="12", words=[Word(text="12", bbox=(1205 / W, (1250 - 40) / H, 1225 / W, (1250 - 12) / H))])
    assert determine_scale(img, lines + [tiny]).status == "NOT_COMPARABLE"


@pytest.mark.l6_adversarial
def test_walls_not_facing_each_other_are_not_measured():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]
    walls(d, [300], 100, 500)
    walls(d, [700], 800, 1200)  # по высоте не перекрываются
    r = determine_scale(img, lines)
    assert [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "x"] == []


# ─────────────────────────────── эндпоинт /measure на PDF с текстовым слоем


def _drawing_pdf(path, labels=("6000",), title="План 1 этажа, М 1:100"):
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    from inspector_ml.render import FONT

    pdfmetrics.registerFont(TTFont("Noto", str(FONT)))
    w, h = landscape(A4)
    c = canvas.Canvas(str(path), pagesize=(w, h))
    c.setFont("Noto", 9)
    c.drawString(20 * mm, h - 15 * mm, title)
    # размерная линия 60 мм на листе = 6000 мм в натуре (М 1:100); вторая — 30 мм = 3000 или противоречивая
    for (x0, x1), label in zip([(40, 100), (120, 150)], labels):
        c.setLineWidth(0.6)
        c.line(x0 * mm, 30 * mm, x1 * mm, 30 * mm)
        c.drawCentredString((x0 + x1) / 2 * mm, 32 * mm, label)
    c.setLineWidth(1.2)
    for x in (50, 80, 125):  # стены: 30 мм и 45 мм на листе = 3000 и 4500 мм
        c.line(x * mm, 50 * mm, x * mm, 150 * mm)
    c.showPage()
    c.save()


@pytest.mark.l1_functional
def test_measure_endpoint_scale_and_distances_on_pdf(tmp_path, monkeypatch):
    from test_sheetdiff import diff_client

    p = tmp_path / "plan.pdf"
    _drawing_pdf(p, ("6000", "3000"))
    client, (sha,) = diff_client(tmp_path, monkeypatch, [p])
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert (r["status"], r["method"], len(r["dimension_lines"])) == ("OK", "dimension_line", 2)
    xs = [d["mm"] for d in r["distances"] if d["axis"] == "x"]
    assert xs == [pytest.approx(3000, rel=0.02), pytest.approx(4500, rel=0.02)]


@pytest.mark.l6_adversarial
def test_measure_endpoint_contradiction_and_errors(tmp_path, monkeypatch):
    from test_sheetdiff import diff_client

    p = tmp_path / "plan.pdf"
    _drawing_pdf(p, ("6000", "3600"))  # вторая линия врёт на 20 %
    client, (sha,) = diff_client(tmp_path, monkeypatch, [p])
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert (r["status"], r["mm_per_px"], r["distances"]) == ("NOT_COMPARABLE", None, [])
    assert client.post("/measure", json={"sha256": sha, "page": 5}).status_code == 422


@pytest.mark.l6_adversarial
def test_short_segments_are_not_measured():
    # отрезки короче 20 % меньшей стороны листа (засечки, короткие выноски) — не линии чертежа
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000")]
    for x in (300, 400):
        d.line((x, 300, x, 500), fill=0, width=4)  # 200 px < 0,2 × 1400 = 280 px
    r = determine_scale(img, lines)
    assert distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) == []


@pytest.mark.l6_adversarial
def test_excluded_dimension_lines_do_not_become_measurements():
    # две перекрывающиеся по x размерные линии на разной высоте: без исключения дали бы расстояние по y
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000"), dim(d, 300, 700, 1330, "3000")]
    r = determine_scale(img, lines)
    boxes = [e["line_bbox"] for e in r.evidence]
    assert len(boxes) == 2
    assert [x for x in distances(img, r, exclude=boxes) if x.axis == "y"] == []
    ys = [x for x in distances(img, r) if x.axis == "y"]  # без исключения — есть, значит тест различает
    assert len(ys) == 1 and ys[0].mm == pytest.approx(80 * 7.5, rel=0.03)


@pytest.mark.l3_boundary
def test_exclusion_covers_only_dimension_line_not_wall_on_same_height():
    # стена на той же высоте, что размерная линия, но левее неё — измеряется, а не исключается вместе с размером
    img, d = sheet()
    lines = [dim(d, 1100, 1500, 1250, "3000")]  # 7,5 мм/px
    d.line((100, 1250, 900, 1250), fill=0, width=4)  # стена на высоте размерной линии
    d.line((100, 900, 900, 900), fill=0, width=4)  # параллельная стена выше на 350 px
    r = determine_scale(img, lines)
    ys = [x.mm for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "y"]
    assert ys == [pytest.approx(350 * 7.5, rel=0.03)]


@pytest.mark.l6_adversarial
def test_nonfacing_pair_does_not_stop_scan_of_next_pairs():
    # стены по x: A (y 100–500), B и C (y 800–1200); пара A–B не напротив, пара B–C — напротив и измеряется
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]
    walls(d, [300], 100, 500)
    walls(d, [700, 1100], 800, 1200)
    r = determine_scale(img, lines)
    xs = [x.mm for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "x"]
    assert xs == [pytest.approx(400 * 7.5, rel=0.02)]


@pytest.mark.l1_functional
def test_dimension_label_not_first_word_and_nbsp_thousands():
    # «Размер 6 000» — число не первым словом и с неразрывным пробелом внутри одного «слова» OCR
    img, d = sheet()
    base = dim(d, 200, 1000, 1250, "6000")
    lbl = base.words[0]
    words = [Word(text="Размер", bbox=(0.02, lbl.bbox[1], 0.06, lbl.bbox[3])), Word(text="6 000", bbox=lbl.bbox)]
    r = determine_scale(img, [Line(text="Размер 6 000", words=words)])
    assert r.status == "OK" and r.evidence[0]["mm"] == 6000 and r.mm_per_px == pytest.approx(7.5, rel=0.01)


@pytest.mark.l3_boundary
def test_norm_exact_and_ink_threshold():
    from inspector_ml.measure import _ink, _norm, _number, _pt, gost_scale, stamp_scales

    assert _norm((1, 1, 1, 1), 3, 3) == (0.33333, 0.33333, 0.66667, 0.66667)
    assert _pt((1, 2), 3, 3) == (0.33333, 0.66667)
    assert (_number("6 000"), _number("6\u00a0000"), _number("6000 мм")) == (6000, 6000, None)
    assert gost_scale(0.5) == 1
    st = stamp_scales([Line(text="М 1:1", words=[]), Line(text="М 1:100", words=[])])
    assert st == [1, 100] and all(isinstance(v, int) for v in st)

    assert _norm((10, 20, 29, 39), 100, 200) == (0.1, 0.1, 0.3, 0.2)
    img = Image.new("L", (4, 1), 255)
    img.putpixel((0, 0), 127)
    img.putpixel((1, 0), 128)
    assert _ink(img)[0].tolist() == [255, 0, 0, 0]  # 127 — чернила, 128 — уже фон


# ─────────────────────── T-098: размеры любой ориентации, цепочки, расстояния по нормали, масштаб 1:N


def _geom(p0, p1):
    import math

    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    ln = math.hypot(dx, dy)
    u = (dx / ln, dy / ln)
    return u, (u[1], -u[0])  # нормаль «над» линией (для горизонтальной — вверх, для снизу-вверх — влево)


def label_at(p0, p1, label: str, off: float = 26) -> Word:
    """Подпись, повёрнутая вдоль линии, над серединой; bbox — осевой прямоугольник повёрнутого текста."""
    u, n = _geom(p0, p1)
    cx, cy = (p0[0] + p1[0]) / 2 + n[0] * off, (p0[1] + p1[1]) / 2 + n[1] * off
    tw, th = 18 * len(label), 28
    hx, hy = (tw * abs(u[0]) + th * abs(u[1])) / 2, (tw * abs(u[1]) + th * abs(u[0])) / 2
    return Word(text=label, bbox=((cx - hx) / W, (cy - hy) / H, (cx + hx) / W, (cy + hy) / H))


def chain(d, pts, labels, over: float = 0) -> Line:
    """Цепочка размеров любой ориентации: одна линия через точки pts, засечки 45° в каждой, подпись над каждым звеном.
    over — выступ линии за крайние засечки (ГОСТ 2.307: до 3 мм)."""
    u, n = _geom(pts[0], pts[-1])
    a = (pts[0][0] - u[0] * over, pts[0][1] - u[1] * over)
    b = (pts[-1][0] + u[0] * over, pts[-1][1] + u[1] * over)
    d.line((*a, *b), fill=0, width=2)
    for x, y in pts:
        t = (8 * (u[0] + n[0]), 8 * (u[1] + n[1]))
        d.line((x - t[0], y - t[1], x + t[0], y + t[1]), fill=0, width=2)
    words = [label_at(p, q, lb) for p, q, lb in zip(pts, pts[1:], labels)]
    return Line(text=" ".join(labels), words=words)


def slanted(d, p0, length, deg, width=4):
    import math

    r = math.radians(deg)
    p1 = (p0[0] + length * math.cos(r), p0[1] - length * math.sin(r))
    d.line((*p0, *p1), fill=0, width=width)
    return p1


def ray(p, deg, dist):
    import math

    r = math.radians(deg)
    return (p[0] + dist * math.cos(r), p[1] - dist * math.sin(r))


@pytest.mark.l1_functional
def test_vertical_dimension_line_with_vertical_label_gives_scale():
    # вертикальный размер снизу вверх, подпись слева (bbox высокий и узкий) + горизонтальный — масштаб один
    img, d = sheet()
    lines = [chain(d, [(1700, 1100), (1700, 300)], ["6000"]), dim(d, 200, 600, 1250, "3000")]
    lb = lines[0].words[0].bbox
    assert (lb[3] - lb[1]) * H > (lb[2] - lb[0]) * W  # подпись вертикальная
    r = determine_scale(img, lines)
    assert (r.status, r.method) == ("OK", "dimension_line")
    assert r.mm_per_px == pytest.approx(7.5, rel=0.01)
    v, hz = r.evidence
    assert (v["orientation"], hz["orientation"]) == ("vertical", "horizontal")
    assert v["angle"] == pytest.approx(90, abs=0.5) and hz["angle"] == pytest.approx(0, abs=0.5)
    assert v["px"] == pytest.approx(800, rel=0.01)


@pytest.mark.l1_functional
def test_oblique_dimension_line_30deg_gives_scale_and_angle():
    img, d = sheet()
    p0 = (400, 1100)
    lines = [chain(d, [p0, ray(p0, 30, 800)], ["6000"])]
    r = determine_scale(img, lines)
    assert r.status == "OK" and r.mm_per_px == pytest.approx(7.5, rel=0.01)
    e = r.evidence[0]
    assert (e["orientation"], e["link"], e["links"]) == ("oblique", 1, 1)
    assert (e["label"], e["label_bbox"], e["px"]) == ("6000", lines[0].words[0].bbox, round(e["px"], 1))
    assert e["px"] == pytest.approx(800, abs=2) and e["px"] != round(e["px"])
    assert e["angle"] == pytest.approx(30, abs=0.5)
    x0, y0, x1, y1 = e["line"]  # концы звена в долях листа — для отрисовки наклонной линии
    assert (x0 * W, y0 * H) == (pytest.approx(400, abs=3), pytest.approx(1100, abs=3))
    assert (x1 * W, y1 * H) == (pytest.approx(ray(p0, 30, 800)[0], abs=3), pytest.approx(ray(p0, 30, 800)[1], abs=3))


@pytest.mark.l1_functional
def test_chain_of_three_links_each_link_gives_own_length():
    # цепочка 400 + 300 + 500 px = 3000 + 2250 + 3750 мм; по всей линии (1200 px) масштаб вышел бы разный
    img, d = sheet()
    lines = [chain(d, [(200, 1250), (600, 1250), (900, 1250), (1400, 1250)], ["3000", "2250", "3750"], over=12)]
    r = determine_scale(img, lines)
    assert (r.status, r.method) == ("OK", "dimension_line")
    assert [e["px"] for e in r.evidence] == [pytest.approx(p, abs=3) for p in (400, 300, 500)]
    assert [(e["link"], e["links"]) for e in r.evidence] == [(1, 3), (2, 3), (3, 3)]
    assert r.mm_per_px == pytest.approx(7.5, rel=0.01)
    # звено — своя размерная линия: bbox звена, а не всей цепочки
    assert [round(e["line_bbox"][0] * W / 10) for e in r.evidence] == [20, 60, 90]
    assert [round(e["line_bbox"][2] * W / 10) for e in r.evidence] == [60, 90, 140]


@pytest.mark.l1_functional
def test_oblique_chain_of_two_links():
    img, d = sheet()
    pts = [(1500, 1200), ray((1500, 1200), 135, 400), ray((1500, 1200), 135, 1000)]
    r = determine_scale(img, [chain(d, pts, ["3000", "4500"])])
    assert r.status == "OK" and r.mm_per_px == pytest.approx(7.5, rel=0.01)
    assert [e["px"] for e in r.evidence] == [pytest.approx(400, abs=3), pytest.approx(600, abs=3)]
    assert r.evidence[0]["angle"] == pytest.approx(135, abs=0.5)


@pytest.mark.l6_adversarial
def test_chain_link_with_wrong_label_gives_not_comparable():
    img, d = sheet()
    lines = [chain(d, [(200, 1250), (600, 1250), (900, 1250), (1400, 1250)], ["3000", "3000", "3750"])]
    r = determine_scale(img, lines)
    assert (r.status, r.method, r.mm_per_px) == ("NOT_COMPARABLE", "inconsistent", None)
    assert len(r.evidence) == 3


@pytest.mark.l6_adversarial
def test_vertical_contradicts_horizontal_gives_not_comparable():
    img, d = sheet()
    lines = [chain(d, [(1700, 1100), (1700, 300)], ["7200"]), dim(d, 200, 600, 1250, "3000")]  # 9,0 vs 7,5
    r = determine_scale(img, lines)
    assert (r.status, r.method) == ("NOT_COMPARABLE", "inconsistent")


@pytest.mark.l6_adversarial
def test_label_beyond_segment_end_or_on_line_is_not_a_dimension():
    img, d = sheet()
    p0, p1 = (400, 1100), ray((400, 1100), 30, 800)
    d.line((*p0, *p1), fill=0, width=2)
    u, n = _geom(p0, p1)
    beyond = (p1[0] + u[0] * 60 + n[0] * 26, p1[1] + u[1] * 60 + n[1] * 26)  # за концом линии
    mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)  # прямо на линии — не подпись размера, а текст поверх
    words = [Word(text="6000", bbox=((c[0] - 30) / W, (c[1] - 14) / H, (c[0] + 30) / W, (c[1] + 14) / H)) for c in (beyond, mid)]
    r = determine_scale(img, [Line(text="6000 6000", words=words)])
    assert (r.method, r.evidence) == ("none", [])


@pytest.mark.l3_boundary
def test_label_gap_limit_scales_with_sheet_side():
    # подпись над линией: центр в 26 px — связана; поднята на 3 % меньшей стороны + полвысоты + 10 px — уже нет
    img, d = sheet()
    near = dim(d, 200, 1000, 1250, "6000")
    assert determine_scale(img, [near]).status == "OK"
    b = near.words[0].bbox
    reach = 0.03 * H + 14 + 1  # 3 % стороны + полвысоты подписи + полтолщины линии: 57 px от оси до центра

    def lifted(to):
        dy = (to - 26) / H
        return Line(text="6000", words=[Word(text="6000", bbox=(b[0], b[1] - dy, b[2], b[3] - dy))])

    assert determine_scale(img, [lifted(reach - 2)]).status == "OK"
    assert determine_scale(img, [lifted(reach + 2)]).method == "none"


@pytest.mark.l1_functional
def test_distance_between_oblique_parallel_walls_by_normal_in_mm_and_m():
    import math

    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]  # 7,5 мм/px
    a0 = (500, 1150)
    b0 = ray((a0[0] - 400 * math.sin(math.radians(30)), a0[1] - 400 * math.cos(math.radians(30))), 30, 100)
    slanted(d, a0, 700, 30)
    slanted(d, b0, 700, 30)  # на 400 px выше по нормали, сдвинута вдоль на 100 px — перекрытие 600 px
    r = determine_scale(img, lines)
    ds = [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.orientation == "oblique"]
    assert len(ds) == 1
    x = ds[0]
    assert x.mm == pytest.approx(3000, rel=0.02) and x.m == pytest.approx(3.0, rel=0.02)
    assert (x.axis, x.angle) == ("n", pytest.approx(30, abs=0.5))
    # точки перпендикуляра — на обеих линиях, отстоят на 400 px
    (ax, ay), (bx, by) = x.a_pt, x.b_pt
    assert math.hypot((bx - ax) * W, (by - ay) * H) == pytest.approx(400, rel=0.02)
    # перпендикуляр — посередине общего участка (t 100…700 → 400); a — верхняя линия (меньше по нормали)
    up = ray((a0[0] - 400 * math.sin(math.radians(30)), a0[1] - 400 * math.cos(math.radians(30))), 30, 400)
    lo = ray(a0, 30, 400)
    assert (ax * W, ay * H) == (pytest.approx(up[0], abs=3), pytest.approx(up[1], abs=3))
    assert (bx * W, by * H) == (pytest.approx(lo[0], abs=3), pytest.approx(lo[1], abs=3))


@pytest.mark.l1_functional
def test_axis_distances_keep_axis_and_add_meters_and_orientation():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000")]
    walls(d, [300, 700])
    r = determine_scale(img, lines)
    (x,) = [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "x"]
    assert (x.orientation, x.angle, x.m) == ("vertical", pytest.approx(90, abs=0.5), pytest.approx(3.0, rel=0.02))
    assert (x.a_pt[0] * W, x.a_pt[1] * H) == (pytest.approx(300.5, abs=0.3), pytest.approx(700, abs=2))  # ось штриха 299…302
    assert (x.b_pt[0] * W, x.b_pt[1] * H) == (pytest.approx(700.5, abs=0.3), pytest.approx(700, abs=2))


@pytest.mark.l6_adversarial
def test_non_parallel_long_lines_are_not_measured():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]
    slanted(d, (500, 1000), 700, 30)
    slanted(d, (500, 1150), 700, 33)  # 3° — не параллельны
    r = determine_scale(img, lines)
    assert [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "n"] == []


@pytest.mark.l6_adversarial
def test_chain_with_overhang_is_excluded_from_distances():
    # цепочка выступает за крайние засечки: по звеньям она покрыта исключением и стеной не считается
    img, d = sheet()
    lines = [chain(d, [(200, 1250), (600, 1250), (1000, 1250)], ["3000", "3000"], over=15)]
    d.line((150, 900, 1100, 900), fill=0, width=4)  # стена выше на 350 px
    r = determine_scale(img, lines)
    assert r.status == "OK" and len(r.evidence) == 2
    assert [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "y"] == []
    assert len([x for x in distances(img, r) if x.axis == "y"]) == 1  # без исключения — есть


@pytest.mark.l6_adversarial
def test_thick_wall_is_one_line_not_a_pair():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]
    d.line((300, 200, 300, 1100), fill=0, width=7)
    slanted(d, (500, 1000), 700, 30, width=7)
    r = determine_scale(img, lines)
    assert distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) == []


# ───── OS-INSP-2.4.6 масштаб листа 1:N


@pytest.mark.l1_functional
def test_sheet_scale_render_dpi_and_gost_rounding():
    from inspector_ml.measure import gost_scale, render_dpi, sheet_scale

    assert sheet_scale(25.4 / 150 * 100, 150) == pytest.approx(100)
    assert sheet_scale(7.5, 25.4) == pytest.approx(7.5)
    assert render_dpi((1754, 1240), (841.89, 595.28)) == pytest.approx(150, rel=0.001)
    assert render_dpi((1240, 1754), (595.28, 841.89)) == pytest.approx(150, rel=0.001)
    assert [gost_scale(n) for n in (98.7, 47, 2.4, 1.1, 180, 130, 700, 0)] == [100, 50, 2.5, 1, 200, 100, 800, None]


@pytest.mark.l1_functional
def test_stamp_scales_parsed_from_page_text():
    from inspector_ml.measure import stamp_scales

    def ln(t):
        return Line(text=t, words=[Word(text=t)])

    assert stamp_scales([ln("План 1 этажа, М 1:100")]) == [100]
    assert stamp_scales([ln("Масштаб: 1 : 50"), ln("M1:200"), ln("М 1:100"), ln("м1:2,5")]) == [50, 200, 100, 2.5]
    assert stamp_scales([ln("Масштаб 1:50"), ln("М 1:50")]) == [50]  # без повторов
    assert stamp_scales([ln("уклон 1:10"), ln("ИМ 1:100"), ln("раздел 1:5"), ln("М 1:0")]) == []


@pytest.mark.l3_boundary
def test_scale_conflict_threshold_is_2pct():
    from inspector_ml.measure import scale_conflict

    assert scale_conflict(100, 98) and scale_conflict(96, 100)
    assert not scale_conflict(100, 99) and not scale_conflict(102, 100) and not scale_conflict(100, 100)


def _sheet_1_100(stamp: str | None):
    # 25,4/150 мм листа на пиксель: линия 354,3 px = 60 мм листа = 6000 мм при 1:100
    img, d = sheet()
    lines = [dim(d, 300, 654, 1250, "6000")]
    if stamp:
        lines.append(Line(text=stamp, words=[Word(text=stamp, bbox=(0.05, 0.02, 0.2, 0.04))]))
    walls(d, [300, 700])
    return img, lines


@pytest.mark.l1_functional
def test_determine_scale_reports_sheet_scale_matching_stamp():
    img, lines = _sheet_1_100("План 1 этажа, М 1:100")
    r = determine_scale(img, lines, dpi=150)
    assert (r.status, r.method) == ("OK", "dimension_line")
    assert r.sheet_scale == pytest.approx(100, rel=0.01) and r.sheet_scale == round(r.sheet_scale, 1)
    assert r.sheet_scale != round(r.sheet_scale)  # измеренный N не подменён округлённым
    assert (r.sheet_scale_gost, r.stamp_scale) == (100, 100)
    r2 = determine_scale(img, lines[:1], dpi=150)  # штампа нет — масштаб 1:N всё равно выведен
    assert (r2.status, r2.stamp_scale, r2.sheet_scale_gost) == ("OK", None, 100)
    r3 = determine_scale(img, lines)  # без dpi — прежнее поведение, 1:N не выводится
    assert (r3.status, r3.sheet_scale, r3.stamp_scale) == ("OK", None, None)


@pytest.mark.l6_adversarial
def test_stamp_contradicting_measured_scale_gives_not_comparable():
    img, lines = _sheet_1_100("План 1 этажа, М 1:50")
    r = determine_scale(img, lines, dpi=150)
    assert (r.status, r.method, r.mm_per_px) == ("NOT_COMPARABLE", "stamp_mismatch", None)
    assert (r.stamp_scale, r.sheet_scale_gost) == (50, 100)  # видно, что с чем разошлось
    assert r.evidence and distances(img, r) == []


@pytest.mark.l3_boundary
def test_stamp_matching_one_of_several_scales_on_sheet_is_ok():
    img, lines = _sheet_1_100(None)
    lines.append(Line(text="Узел 1 М 1:20", words=[Word(text="Узел 1 М 1:20")]))
    lines.append(Line(text="План М 1:100", words=[Word(text="План М 1:100")]))
    r = determine_scale(img, lines, dpi=150)
    assert (r.status, r.stamp_scale) == ("OK", 100)


@pytest.mark.l1_functional
def test_measure_endpoint_reports_sheet_scale_and_meters(tmp_path, monkeypatch):
    from test_sheetdiff import diff_client

    p = tmp_path / "plan.pdf"
    _drawing_pdf(p, ("6000", "3000"))
    client, (sha,) = diff_client(tmp_path, monkeypatch, [p])
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert r["status"] == "OK"
    assert r["sheet_scale"] == pytest.approx(100, rel=0.015)
    assert (r["sheet_scale_gost"], r["stamp_scale"]) == (100, 100)
    assert r["render_dpi"] == pytest.approx(150, rel=0.01)
    xs = [x for x in r["distances"] if x["axis"] == "x"]
    assert [x["m"] for x in xs] == [pytest.approx(3.0, rel=0.02), pytest.approx(4.5, rel=0.02)]
    assert {x["orientation"] for x in xs} == {"vertical"} and all(len(x["a_pt"]) == 2 for x in xs)
    assert {e["orientation"] for e in r["dimension_lines"]} == {"horizontal"}


@pytest.mark.l6_adversarial
def test_measure_endpoint_stamp_mismatch(tmp_path, monkeypatch):
    from test_sheetdiff import diff_client

    p = tmp_path / "plan.pdf"
    _drawing_pdf(p, ("6000", "3000"), title="План 1 этажа, М 1:200")
    client, (sha,) = diff_client(tmp_path, monkeypatch, [p])
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert (r["status"], r["method"], r["mm_per_px"], r["distances"]) == ("NOT_COMPARABLE", "stamp_mismatch", None, [])
    assert (r["stamp_scale"], r["sheet_scale_gost"]) == (200, 100)


@pytest.mark.l3_boundary
def test_gost_2302_series_and_orientation_boundaries():
    from inspector_ml.measure import GOST_2302, orientation

    assert GOST_2302 == (1, 2, 2.5, 4, 5, 10, 15, 20, 25, 40, 50, 75, 100, 200, 400, 500, 800, 1000,
                         2000, 5000, 10000, 20000, 25000, 50000)
    assert [orientation(a) for a in (0, 1.0, 179.0, 180.5)] == ["horizontal"] * 4
    assert [orientation(a) for a in (89.0, 91.0, 90)] == ["vertical"] * 3
    assert [orientation(a) for a in (1.1, 178.9, 88.9, 91.1, 30)] == ["oblique"] * 5


@pytest.mark.l3_boundary
def test_segment_geometry_runs_and_angle_diff():
    from inspector_ml.measure import Distance, Segment, _angle_diff, _runs

    s = Segment(0, 0, 3, 4)
    assert (s.span, s.length, s.u, s.n) == (5, 6, (0.6, 0.8), (-0.8, 0.6))
    assert (s.angle, s.horizontal, s.at(5)) == (126.9, False, (3, 4))
    assert Segment(10, 5, 0, 5).angle == 180 % 180 == 0 and Segment(0, 5, 10, 5).horizontal
    assert Segment(0, 5, 10, 5, thick=3).bbox() == (0, 4, 10, 6)
    assert Segment(0, 5, 10, 5, thick=3).bbox(2, 6) == (2, 4, 6, 6)
    assert Segment(5, 10, 5, 0, thick=1).bbox() == (5, 0, 5, 10)
    m = np.array([1, 1, 0, 0, 1, 0, 0, 0, 1], dtype=bool)
    assert _runs(m, 2) == [(0, 4), (8, 8)] and _runs(m, 3) == [(0, 8)] and _runs(m, 0) == [(0, 1), (4, 4), (8, 8)]
    assert _runs(np.zeros(3, dtype=bool), 2) == []
    assert (_angle_diff(179.5, 0.3), _angle_diff(10, 50), _angle_diff(0, 170)) == (pytest.approx(0.8), 40, 10)
    d = Distance(1234.0, "n", (0, 0, 1, 1), (0, 0, 1, 1))
    assert (d.m, d.orientation, Distance(1, "x", d.a_bbox, d.b_bbox).orientation, Distance(1, "y", d.a_bbox, d.b_bbox).orientation) == (
        1.234, "oblique", "vertical", "horizontal")


# ───── слои детектора отрезков по отдельности: конвейер самокорректируется, поэтому каждый слой — своим тестом


@pytest.mark.l3_boundary
def test_merge_joins_collinear_fragments_only_within_gap_offset_and_angle():
    from inspector_ml.measure import _merge

    def ends(ss):
        return sorted((round(s.x0, 1), round(s.y0, 1), round(s.x1, 1), round(s.y1, 1)) for s in ss)

    # разрыв 4 px — одна линия (опора — длинный фрагмент), 6 px — две
    assert ends(_merge([(0, 10, 50, 10), (54, 10, 200, 10)])) == [(0, 10, 200, 10)]
    assert len(_merge([(0, 10, 50, 10), (56, 10, 200, 10)])) == 2
    # перекрытие и дубль толстого штриха на 3 px — одна; на 4 px — две
    assert ends(_merge([(0, 10, 150, 10), (100, 13, 180, 13)])) == [(0, 10, 180, 10)]
    assert len(_merge([(0, 10, 150, 10), (100, 14, 180, 14)])) == 2
    # короткий фрагмент впереди списка не становится опорой; фрагмент, лежащий до опоры, расширяет её назад
    assert ends(_merge([(120, 10, 180, 10), (0, 10, 118, 10)])) == [(0, 10, 180, 10)]
    # наклонная: фрагменты вдоль 30° сливаются, угол 2° — уже нет
    a, b = ray((100, 500), 30, 0), ray((100, 500), 30, 100)
    c = ray((100, 500), 30, 103)
    assert len(_merge([(*a, *b), (*c, *ray((100, 500), 30, 300))])) == 1
    assert len(_merge([(*a, *b), (*c, *ray(c, 32, 200))])) == 2
    # опора — самый длинный фрагмент: от короткого под углом 0,9° дальний конец длинного ушёл бы на 4,8 px
    assert len(_merge([(350, 10.8, 400, 10), (400, 10, 700, 10)])) == 1
    # вертикаль снизу вверх и сверху вниз — одна линия
    assert len(_merge([(40, 300, 40, 100), (40, 98, 40, 20)])) == 1


@pytest.mark.l3_boundary
def test_same_line_duplicate_within_thickness_and_length():
    from inspector_ml.measure import Segment, _same_line

    o = (10, 20)  # не в начале координат: иначе x − x0 и x + x0 неразличимы
    k = Segment(o[0], o[1], o[0] + 60, o[1] + 80, thick=3)  # u = (0,6; 0,8), n = (−0,8; 0,6), длина 100; допуск 2,5 px
    n = (-0.8, 0.6)

    def sh(t0, t1, off):
        return Segment(o[0] + 0.6 * t0 + n[0] * off, o[1] + 0.8 * t0 + n[1] * off,
                       o[0] + 0.6 * t1 + n[0] * off, o[1] + 0.8 * t1 + n[1] * off)

    assert _same_line(k, sh(10, 90, 2)) and _same_line(k, sh(-3, 103, -2))
    assert not _same_line(k, sh(10, 90, 3)) and not _same_line(k, sh(10, 90, -3))
    assert not _same_line(k, sh(-6, 50, 0)) and not _same_line(k, sh(50, 106, 0))
    assert not _same_line(k, Segment(o[0], o[1], o[0] + 80, o[1] + 60))  # другой угол


@pytest.mark.l1_functional
def test_refine_centers_axis_measures_thickness_and_full_extent():
    from inspector_ml.measure import Segment, _ink, _refine

    img = Image.new("L", (400, 300), 255)
    d = ImageDraw.Draw(img)
    d.rectangle((50, 100, 250, 104), fill=0)  # толщина 5, ось y = 102, x 50…250
    r = _refine(_ink(img), Segment(120, 101, 200, 103))  # затравка Хафа: короткая, смещённая и с наклоном
    assert (r.x0, r.x1, r.thick) == (pytest.approx(50, abs=0.6), pytest.approx(250, abs=0.6), 5)
    assert (r.y0, r.y1) == (pytest.approx(102, abs=0.5), pytest.approx(102, abs=0.5))
    r = _refine(_ink(img), r)  # второй проход — по всей длине: ось точно по центру
    assert (r.y0, r.y1) == (pytest.approx(102, abs=0.05), pytest.approx(102, abs=0.05))
    img2 = Image.new("L", (400, 400), 255)
    p0, p1 = (60, 340), ray((60, 340), 30, 300)
    ImageDraw.Draw(img2).line((*p0, *p1), fill=0, width=3)
    q0, q1 = ray(p0, 30, 100), ray(p0, 30, 200)
    r2 = _refine(_ink(img2), Segment(q0[0], q0[1] + 1.5, q1[0], q1[1] - 1))
    assert r2.angle == pytest.approx(30, abs=0.3) and r2.span == pytest.approx(300, abs=2)
    assert (r2.x0, r2.y0) == (pytest.approx(60, abs=1.5), pytest.approx(340, abs=1.5))
    assert _refine(_ink(Image.new("L", (400, 300), 255)), Segment(120, 101, 200, 103)) is None  # пусто — нет линии


@pytest.mark.l1_functional
def test_junctions_ticks_and_extension_lines_but_not_one_sided_text():
    from inspector_ml.measure import Segment, _ink, _junctions

    img = Image.new("L", (800, 300), 255)
    d = ImageDraw.Draw(img)
    d.line((100, 150, 700, 150), fill=0, width=2)
    d.line((292, 158, 308, 142), fill=0, width=2)  # засечка в x = 300
    d.line((500, 130, 500, 170), fill=0, width=1)  # выносная в x = 500
    d.rectangle((580, 138, 640, 145), fill=0)  # «текст» только с одной стороны
    js = _junctions(_ink(img), Segment(100, 150, 700, 150, thick=2))
    assert js == [pytest.approx(200, abs=1.5), pytest.approx(400, abs=1.5)]
    img2 = Image.new("L", (400, 400), 255)
    p0, p1 = (60, 340), ray((60, 340), 60, 300)
    d2 = ImageDraw.Draw(img2)
    d2.line((*p0, *p1), fill=0, width=2)
    c = ray(p0, 60, 120)
    d2.line((*ray(c, 150, 12), *ray(c, -30, 12)), fill=0, width=1)  # выносная поперёк наклонной
    assert _junctions(_ink(img2), Segment(*p0, *p1, thick=2)) == [pytest.approx(120, abs=1.5)]


@pytest.mark.l6_adversarial
def test_chain_link_shorter_than_min_dim_is_not_a_dimension():
    img, d = sheet()
    r = determine_scale(img, [chain(d, [(200, 1250), (230, 1250), (700, 1250)], ["225", "3525"])])  # 30 px и 470 px
    assert [e["label"] for e in r.evidence] == ["3525"] and r.mm_per_px == pytest.approx(7.5, rel=0.01)


@pytest.mark.l6_adversarial
def test_parallel_lines_overlapping_less_than_half_are_not_facing():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]
    d.line((200, 500, 1000, 500), fill=0, width=4)
    d.line((760, 800, 1560, 800), fill=0, width=4)  # перекрытие 240 px < половины 800
    r = determine_scale(img, lines)
    assert distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) == []


@pytest.mark.l6_adversarial
def test_vertical_dimension_line_is_excluded_from_x_distances():
    img, d = sheet()
    lines = [chain(d, [(1700, 1100), (1700, 300)], ["6000"])]
    walls(d, [1300])
    r = determine_scale(img, lines)
    assert [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "x"] == []
    assert [x.mm for x in distances(img, r) if x.axis == "x"] == [pytest.approx(3000, rel=0.02)]


@pytest.mark.l3_boundary
def test_ink_of_rgb_bbox_of_thick_lines_and_angle_wrap():
    from inspector_ml.measure import Segment, _angle_diff, _ink, orientation

    assert _ink(Image.new("RGB", (2, 1), (0, 0, 0))).tolist() == [[255, 255]]
    assert Segment(0, 5, 10, 5, thick=5).bbox() == (0, 3, 10, 7)
    assert Segment(5, 10, 5, 0, thick=5).bbox() == (3, 0, 7, 10)
    assert orientation(359.5) == "horizontal" and _angle_diff(0, 359.5) == pytest.approx(0.5)


@pytest.mark.l3_boundary
def test_untagged_line_end_counts_full_pixel_extent():
    # линия без засечек: длина — по крайним пикселям (801 px для x 200…1000), концы звена — концы линии
    img, d = sheet()
    d.line((200, 1250, 1000, 1250), fill=0, width=2)
    word = dim(ImageDraw.Draw(Image.new("L", (W, H), 255)), 200, 1000, 1250, "6000").words[0]
    r = determine_scale(img, [Line(text="6000", words=[word])])
    e = r.evidence[0]
    assert (e["px"], e["link"], e["links"]) == (801, 1, 1)
    assert (e["line"][0] * W, e["line"][2] * W) == (pytest.approx(200, abs=0.01), pytest.approx(1000, abs=0.01))
    assert round(e["line_bbox"][0] * W) == 200


@pytest.mark.l1_functional
def test_near_horizontal_lines_across_180_wrap_are_parallel():
    img, d = sheet()
    lines = [dim(d, 200, 1000, 1300, "6000")]
    d.line((200, 500, 1000, 505), fill=0, width=3)  # −0,36° → 179,6°
    d.line((200, 802, 1000, 797), fill=0, width=3)  # +0,36°
    r = determine_scale(img, lines)
    ys = [x for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "y"]
    assert [x.mm for x in ys] == [pytest.approx(297 * 7.5, rel=0.02)]


@pytest.mark.l6_adversarial
def test_wall_crossing_dimension_line_is_still_measured():
    # стены пересекают размерную линию: они же — узлы цепочки (звено 300…700 = 400 px = 3000 мм),
    # в bbox звена — лишь малая часть оси стены, стены не исключаются
    img, d = sheet()
    dim(d, 200, 1000, 1250, "6000")
    lines = [Line(text="3000", words=[label_at((300, 1250), (700, 1250), "3000")])]
    walls(d, [300, 700], 300, 1300)
    r = determine_scale(img, lines)
    assert (r.status, r.evidence[0]["links"], r.evidence[0]["px"]) == ("OK", 3, pytest.approx(400, abs=2))
    xs = [x.mm for x in distances(img, r, exclude=[e["line_bbox"] for e in r.evidence]) if x.axis == "x"]
    assert xs == [pytest.approx(3000, rel=0.02)]
