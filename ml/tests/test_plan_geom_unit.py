"""T-192: чистые функции plan_geom без pdfium — масштаб, числа размеров, отметки, геометрия, RANSAC, слияние точек,
регистрация по якорям. Точные значения и пороги (L1–L3, L5, L6)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from inspector_ml import plan_geom as G
from inspector_ml.pagekind import PageVectors, VectorSegment


@pytest.mark.l3_boundary
def test_consensus_scale_values():
    r = G.consensus_scale([], [100.0, 101.0, 99.0])
    assert (r["n"], r["method"], r["status"], r["why"], r["n_dims"]) == (
        100.0,
        "dimensions",
        "OK",
        None,
        3,
    )
    assert r["spread_pct"] == 1.0 and r["inliers"] == [True, True, True]
    both = G.consensus_scale([100], [100.5, 100.5])
    assert both["n"] == 100.5 and both["spread_pct"] == 0.5 and both["method"] == "both"
    far = G.consensus_scale([200], [100.0, 100.0])
    assert far["spread_pct"] == 50.0 and far["n"] is None and far["method"] is None
    maj = G.consensus_scale([], [100.0, 150.0, 200.0])
    assert maj["why"] == "SCALE_SPREAD" and maj["spread_pct"] == 100.0  # три группы по одному: оценка — первая, 200 от неё на 100 %
    one = G.consensus_scale([], [250.0])
    assert one["n"] == 250.0 and one["spread_pct"] == 0.0
    st = G.consensus_scale([0, 100], [])
    assert st["n"] == 100 and st["n_dims"] == 0 and st["spread_pct"] == 0.0


@pytest.mark.l3_boundary
def test_consensus_scale_rival_group_needs_4pct_gap():
    close = G.consensus_scale(
        [], [100.0, 100.0, 103.0, 103.0]
    )  # группы в 3 % — одна оценка, не соперники
    assert close["status"] == "OK"
    rival = G.consensus_scale([], [100.0, 100.0, 104.5, 104.5])
    assert rival["why"] == "SCALE_SPREAD"


@pytest.mark.l1_functional
def test_numbers_of_dimensions():
    assert G._number("3000", False) == 3000.0 and G._number("45", False) == 45.0
    assert (
        G._number("5", False) is None
        and G._number("1234567", False) is None
        and G._number("3,00", False) is None
    )
    assert (
        G._number("6,00", True) == 6000.0
        and G._number("12,5", True) is None
        and G._number("3 000", False) == 3000.0  # неразрывный пробел между разрядами
    )
    assert G._number("4 200", False) == 4200.0 and G._number("4200 ", False) == 4200.0


@pytest.mark.l1_functional
def test_axis_order_and_letters():
    assert G._axis_order("2") < G._axis_order("10") < G._axis_order("А")
    assert G._axis_order("Б") < G._axis_order("В") and G._axis_order(
        "И"
    ) < G._axis_order("К")
    assert G._axis_order("Q") == (1, 100 + ord("Q"))


@pytest.mark.l1_functional
def test_geometry_helpers():
    assert G._intersect((0, 0), (10, 0), (5, -5), (5, 5)) == (5.0, 0.0)
    assert G._intersect((0, 0), (10, 0), (0, 1), (10, 1)) is None
    assert (
        G._line_dist((3, 4), (0, 0), (10, 0)) == 4.0
        and G._line_dist((3, 4), (0, 0), (0, 0)) == 5.0
    )
    assert G._unit((0, 0), (3, 4)) == (0.6, 0.8) and G._unit((1, 1), (1, 1)) == (
        0.0,
        0.0,
    )
    assert G._off((0, 0), (1, 0), 2.0) == (0.0, 2.0)
    assert (
        G._box_gap((0, 0, 1, 1), (3, 0, 4, 1)) == 2.0
        and G._box_gap((0, 0, 1, 1), (0.5, 0.5, 2, 2)) == 0.0
    )
    assert G._box_gap((0, 0, 1, 1), (0, 4, 1, 5)) == 3.0
    assert G._union([(0, 1, 2, 3), (-1, 2, 1, 5)]) == (-1, 1, 2, 5)
    assert G._pts_box([(1, 5), (3, 2)]) == (1, 2, 3, 5)
    assert (
        G._inside((1, 1), None)
        and G._inside((1, 1), (0, 0, 1, 1))
        and not G._inside((1.1, 1), (0, 0, 1, 1))
    )
    assert G._same_ends((0, 0), (1, 1), (1.2, 1), (0, 0.1)) and not G._same_ends(
        (0, 0), (1, 1), (1.4, 1), (0, 0)
    )


@pytest.mark.l1_functional
def test_polygon_measures():
    L = [(0, 0), (6, 0), (6, 2), (2, 2), (2, 6), (0, 6)]  # L-образный проезд шириной 2
    assert G.shoelace(L) == 20.0 and G.perimeter(L) == 24.0
    assert G.strip_width(20.0, 24.0) == pytest.approx(2.0, abs=0.3)
    assert G.strip_width(100.0, 10.0) == pytest.approx(
        2.5
    )  # вырожденный вход: дискриминант < 0 — не NaN
    assert G.strip_width(16.0, 16.0) == 4.0  # квадрат 4×4


@pytest.mark.l2_differential
def test_affine_fit_apply_roundtrip():
    m = [2.0, 0.5, -0.5, 2.0, 10.0, -3.0]
    src = np.array([[0, 0], [1, 0], [0, 1], [5, 7]], float)
    dst = G.apply_affine(m, src)
    assert np.allclose(dst[1], [12.0, -2.5]) and np.allclose(dst[2], [9.5, -1.0])
    assert np.allclose(G.fit_affine(src, dst), m)


@pytest.mark.l6_adversarial
def test_ransac_degenerate_and_exact_three():
    col = np.array([[0, 0], [1, 1], [2, 2], [3, 3]], float)
    m, inl = G.ransac_affine(col, col, 0.1)
    assert m is None and inl.sum() == 0  # все тройки вырождены — перехода нет
    tri = np.array([[0, 0], [1, 0], [0, 1]], float)
    m3, inl3 = G.ransac_affine(tri, tri * 2, 0.1)
    assert np.allclose(m3, [2, 0, 0, 2, 0, 0]) and inl3.all()


@pytest.mark.l5_property
@pytest.mark.parametrize("seed", range(5))
def test_ransac_is_deterministic_and_rigid_invariant(seed):
    rng = np.random.default_rng(seed)
    src = rng.uniform(0, 500, (12, 2))
    ang = rng.uniform(-math.pi, math.pi)
    m = [
        math.cos(ang),
        math.sin(ang),
        -math.sin(ang),
        math.cos(ang),
        *rng.uniform(-100, 100, 2),
    ]
    dst = G.apply_affine(m, src)
    a, ia = G.ransac_affine(src, dst, 0.01)
    b, ib = G.ransac_affine(src, dst, 0.01)
    assert np.allclose(a, m, atol=1e-6) and np.array_equal(ia, ib) and np.allclose(a, b)


@pytest.mark.l1_functional
def test_snap_merges_across_cell_border():
    s = G._Snap(0.25)
    a = s((0.249, 1.0))
    assert (
        s((0.251, 1.0)) is a and s((0.2, 1.1)) is a
    )  # по разные стороны границы ячейки — одна точка
    b = s((0.6, 1.0))
    assert b is not a and s((0.6, 1.24)) is b and s((0.6, 1.26)) is not b


@pytest.mark.l1_functional
def test_level_values():
    assert (
        G.parse_level("+12.450") == 12.45
        and G.parse_level("0,000") == 0.0
        and G.parse_level("-0.050") == -0.05
    )
    assert (
        G.parse_level("+1.20") is None
        and G.parse_level("±0.000") == 0.0
        and G.parse_level("1234.000") is None
    )


def _vseg(x0, y0, x1, y1, path=0, w=1.0, **kw):
    return VectorSegment(
        x0, y0, x1, y1, path=path, width_pt=w, stroke=True, fill_mode=0, **kw
    )


@pytest.mark.l1_functional
def test_sheet_from_converts_fractions_to_mm():
    vec = PageVectors(1, 72.0, 36.0, (_vseg(0.5, 0.5, 1.0, 0.0, w=2.0),))
    sh = G.sheet_from(vec, None)
    s = sh.segs[0]
    assert (round(sh.w, 4), round(sh.h, 4)) == (25.4, 12.7)
    assert (round(s.x0, 4), round(s.y0, 4), round(s.x1, 4), round(s.y1, 4)) == (
        12.7,
        6.35,
        25.4,
        0.0,
    )
    assert (
        round(s.width, 4) == round(2 * 25.4 / 72, 4)
        and sh.paths == {0: [s]}
        and sh.frac((12.7, 0, 25.4, 12.7)) == [0.5, 0.0, 1.0, 1.0]
    )


@pytest.mark.l6_adversarial
def test_too_few_strokes_is_no_vector_layer():
    segs = tuple(
        _vseg(0.1, 0.01 * i, 0.9, 0.01 * i, path=i)
        for i in range(G.VECTOR_MIN_SEGMENTS - 1)
    )
    geo = G.analyze_sheet(PageVectors(1, 842, 595, segs), None)
    assert geo["quality"]["why"] == "NO_VECTOR_LAYER"
    enough = segs + (_vseg(0.1, 0.9, 0.9, 0.9, path=999),)
    assert (
        G.analyze_sheet(PageVectors(1, 842, 595, enough), None)["quality"]["why"]
        == "NO_SCALE"
    )


def _axes_geo(dx=0.0, dy=0.0, rot=0.0, n=100.0, rooms=True):
    """Минимальная PlanGeometry для LNK-03: оси 1–3 × А–В на сетке 30 мм, помещения в ячейках."""
    c, s = math.cos(rot), math.sin(rot)

    def t(p):
        return [c * p[0] - s * p[1] + dx, s * p[0] + c * p[1] + dy]

    axes = [
        {"mark": str(i + 1), "p0": t((10 + 30 * i, 0)), "p1": t((10 + 30 * i, 100))}
        for i in range(3)
    ]
    axes += [
        {"mark": "АБВ"[j], "p0": t((0, 90 - 30 * j)), "p1": t((100, 90 - 30 * j))}
        for j in range(3)
    ]
    rm = [
        {
            "number": f"1.0{k}",
            "polygon": [
                t((12 + 30 * k, 62)),
                t((38 + 30 * k, 62)),
                t((38 + 30 * k, 88)),
                t((12 + 30 * k, 88)),
            ],
        }
        for k in range(2)
    ]
    return {
        "quality": {"status": "OK", "why": None},
        "scale": {"n": n},
        "axes": axes,
        "rooms": rm if rooms else [],
    }


@pytest.mark.l2_differential
def test_register_sheets_recovers_shift_and_residual():
    a = _axes_geo()
    b = _axes_geo(dx=7.0, dy=-3.0, rot=0.02)
    r = G.register_sheets(a, b)
    assert (
        r["ok"]
        and r["anchors"] == 11
        and r["residual_mm"] < 0.01
        and r["method"] == "affine"
    )
    back = G.apply_affine(r["matrix"], [b["axes"][0]["p0"]])[0]
    assert np.allclose(back, a["axes"][0]["p0"], atol=1e-6)


@pytest.mark.l3_boundary
def test_register_sheets_tolerance_and_anchor_share():
    a = _axes_geo()
    b = _axes_geo(rooms=False)
    mid = b["axes"][1]  # средняя ось сдвинута на 3 мм листа = 300 мм натуры: аффинное не поглощает, три якоря выпадают
    b["axes"][1] = {**mid, "p0": [mid["p0"][0] + 3.0, 0], "p1": [mid["p1"][0] + 3.0, 100]}
    r = G.register_sheets(a, b)
    assert r["anchors"] == 6 and not r["ok"]  # 6 из 9 общих < 70 %
    few = G.register_sheets(
        {**a, "axes": a["axes"][:2], "rooms": []}, {**b, "axes": b["axes"][:2]}
    )
    assert few == {
        "ok": False,
        "method": "affine",
        "matrix": None,
        "residual_mm": None,
        "anchors": 0,
    }


@pytest.mark.l6_adversarial
def test_register_sheets_refuses_without_scale_or_quality():
    a = _axes_geo()
    assert not G.register_sheets({**a, "scale": {"n": None}}, a)["ok"]
    assert not G.register_sheets(
        a, {**a, "quality": {"status": "NOT_COMPARABLE", "why": "NO_SCALE"}}
    )["ok"]


@pytest.mark.l1_functional
def test_anchor_keys():
    k = G._anchors(_axes_geo())
    assert set(k) == {f"ax:{i}/{j}" for i in "123" for j in "АБВ"} | {
        "room:1.00",
        "room:1.01",
    }
    assert np.allclose(k["ax:1/А"], (10, 90)) and np.allclose(k["room:1.00"], (25, 75))
