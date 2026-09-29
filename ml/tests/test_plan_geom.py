"""T-192: PlanGeometry векторного плана (ADR-0010) — ENT-03/04/05/06/09/10/11/12/21, знаки, помещения, NRM-09, LNK-03.

Листы — генератор разработки `synth.plans` (истина известна), по одному листу на фикстуру. Цифры точности отсюда —
набор разработки, не приёмка (ADR-0010 п. 6): приёмка — отложенный набор T-195."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from eval.plan_geom_dev import score, to_bld
from inspector_ml import plan_geom as G
from inspector_ml.pagekind import PageVectors, VectorSegment
from inspector_ml.parse import CorruptedFile, parse_file
from synth.plans import plan


def _sheet(tmp: Path, seed: int, kind: str, **kw):
    pdf = tmp / f"{kind}-{seed}-{abs(hash(repr(sorted(kw.items()))))}.pdf"
    truth = plan(seed, kind, pdf, **kw)
    page = parse_file(pdf, "0" * 64).pages[0]
    geo = G.plan_geometry(pdf, 1, page)
    geo["_w"], geo["_h"] = page.width * 25.4 / 72, page.height * 25.4 / 72
    return truth, geo, pdf, page


@pytest.fixture(scope="module")
def ar(tmp_path_factory):
    return _sheet(tmp_path_factory.mktemp("ar"), 1, "ar")


@pytest.fixture(scope="module")
def eng(tmp_path_factory):
    return _sheet(tmp_path_factory.mktemp("eng"), 2, "eng")


@pytest.fixture(scope="module")
def gp(tmp_path_factory):
    return _sheet(tmp_path_factory.mktemp("gp"), 3, "gp")


# ─────────────────────────────────────────────── точность против истины генератора (L1, L2)


@pytest.mark.l2_differential
def test_floor_plan_scale_axes_dims_walls_openings_against_truth(ar):
    truth, geo, _, _ = ar
    s = score(truth, geo)
    assert geo["quality"] == {"status": "OK", "why": None}
    assert (
        geo["scale"]["method"] == "both"
        and s["scale_err_pct"] < 0.05
        and geo["scale"]["spread_pct"] <= 2
    )
    assert s["axes_recall"] == 1 and s["axes_pos_err_mm"] < 1.0
    assert s["dims_recall"] == 1 and s["dims_value_ok"] == 1
    assert (
        s["walls_recall"] >= 0.95
        and s["walls_precision"] >= 0.95
        and s["walls_t_err_mm"] <= 5
    )
    assert s["fire_walls"][0] == s["fire_walls"][1] > 0
    assert (
        s["openings_recall"] == 1
        and s["openings_kind_ok"] == 1
        and s["openings_mark_ok"] == 1
    )
    assert s["openings_width_err_mm"] <= 10 and s["openings_clear_err_mm"] <= 10


@pytest.mark.l2_differential
def test_floor_plan_stairs_lift_levels_rooms_against_truth(ar):
    truth, geo, _, _ = ar
    s = score(truth, geo)
    assert s["stair_steps_ok"] and s["stair_riser_ok"] and s["stair_tread_err_mm"] <= 5
    assert s["lift_err_mm"] <= 5
    assert s["levels_recall"] == 1
    assert s["rooms_recall"] == 1 and s["rooms_area_err_m2"] <= 0.05
    # подпись площади в помещении — второй источник для VER-06
    assert all(
        r["area_label_m2"] is not None
        and abs(r["area_label_m2"] - r["area_m2"]) <= 0.01
        for r in geo["rooms"]
    )


@pytest.mark.l1_functional
def test_building_frame_nrm09_maps_axis_intersections_to_steps(ar):
    truth, geo, _, _ = ar
    fr = geo["frame"]
    n_num = sum(a["family"] == "num" for a in truth["axes"])
    n_let = len(truth["axes"]) - n_num
    assert (
        fr["to_bld"] is not None
        and fr["anchors"] == n_num * n_let
        and fr["residual_mm"] < 1.0
    )
    # пересечение первой цифровой и первой буквенной осей — начало системы здания
    ax = {a["mark"]: a for a in geo["axes"]}
    p = G._intersect(
        tuple(ax["1"]["p0"]),
        tuple(ax["1"]["p1"]),
        tuple(ax["А"]["p0"]),
        tuple(ax["А"]["p1"]),
    )
    assert np.allclose(G.apply_affine(fr["to_bld"], [p])[0], [0, 0], atol=1.0)


@pytest.mark.l2_differential
def test_engineering_plan_routes_symbols_against_truth(eng):
    truth, geo, _, _ = eng
    s = score(truth, geo)
    assert s["routes_ok"] == 1 and s["routes_found"] == len(truth["routes"])
    assert s["symbols_recall"] == 1 and s["symbols_extra"] == 0
    vocab = {"smoke_detector", "heat_detector", "manual_call_point", "sounder", "exit_sign", "fire_damper",
             "fire_hydrant_valve", "call_button", "meter", "lift_platform", "handrail", "other"}  # fmt: skip
    assert {x["kind"] for x in geo["symbols"]} <= vocab  # закрытый словарь ADR-0010
    other = [x for x in geo["symbols"] if x["kind"] == "other"]
    assert other and all(x["mark"] == "Светильник аварийного освещения" for x in other)
    assert all(x["mark"] is None for x in geo["symbols"] if x["kind"] != "other")
    duct = next(r for r in geo["routes"] if r["system"] == "П1")
    kinds = {nd["kind"] for nd in duct["nodes"]}
    assert "end" in kinds and all(
        0 <= a < len(duct["nodes"]) and 0 <= b < len(duct["nodes"])
        for a, b in duct["edges"]
    )


@pytest.mark.l2_differential
def test_site_plan_polygons_road_width_parking_against_truth(gp):
    truth, geo, _, _ = gp
    s = score(truth, geo)
    assert (
        geo["scale"]["n"] == pytest.approx(500, rel=0.001)
        and geo["frame"]["to_bld"] is None
    )
    assert s["site_area_err_rel"] <= 0.001 and s["site_road_width_err_mm"] <= 10
    got, want = s["parking"]
    assert got == want


# ─────────────────────────────────────────────── масштаб ENT-06: пороги (L3)


@pytest.mark.l3_boundary
def test_scale_spread_exactly_2pct_is_ok_above_is_not_comparable():
    ok = G.consensus_scale([100], [102.0, 102.0, 102.0])
    assert (
        ok["status"] == "OK"
        and ok["method"] == "both"
        and ok["spread_pct"] == pytest.approx(2.0)
    )
    bad = G.consensus_scale([100], [102.01, 102.01])
    assert (bad["status"], bad["why"]) == ("NOT_COMPARABLE", "SCALE_SPREAD") and bad[
        "n"
    ] is None


@pytest.mark.l3_boundary
def test_scale_minority_off_dims_are_conditional_majority_off_is_spread():
    r = G.consensus_scale([], [100.0, 100.2, 99.9, 110.0])
    assert (
        r["status"] == "OK"
        and r["method"] == "dimensions"
        and r["inliers"] == [True, True, True, False]
    )
    assert r["spread_pct"] <= 2
    half = G.consensus_scale([], [100.0, 100.0, 110.0, 120.0])
    assert half["status"] == "OK"  # ровно половина согласна — ещё масштаб
    tie = G.consensus_scale([], [100.0, 100.0, 120.0, 120.0])
    assert (tie["status"], tie["why"]) == ("NOT_COMPARABLE", "SCALE_SPREAD")  # две равные группы — масштаба нет
    minority = G.consensus_scale([], [100.0, 110.0, 121.0])
    assert (minority["status"], minority["why"]) == ("NOT_COMPARABLE", "SCALE_SPREAD")


@pytest.mark.l3_boundary
def test_scale_sources_stamp_only_none_and_several_stamps():
    assert G.consensus_scale([100], [])["method"] == "stamp"
    assert G.consensus_scale([], [])["why"] == "NO_SCALE"
    assert (
        G.consensus_scale([50, 100], [100.5])["status"] == "OK"
    )  # «М 1:50» фрагмента не отменяет согласие с 1:100
    assert G.consensus_scale([], [0.0, float("nan"), -1])["why"] == "NO_SCALE"


@pytest.mark.l3_boundary
def test_dimension_off_scale_is_conditional_on_sheet(tmp_path):
    """ENT-04: подпись звена на 5 % больше геометрии — размер «условный», масштаб листа остаётся."""
    base = plan(4, "ar", tmp_path / "base.pdf")["dims"][0]["measured_mm"]
    t2, g2, _, _ = _sheet(tmp_path, 4, "ar", label_error={0: round(base * 1.05)})
    cond = [d for d in g2["dims"] if d["conditional"]]
    assert g2["quality"]["status"] == "OK" and len(cond) == 1
    assert cond[0]["value_mm"] == round(t2["dims"][0]["measured_mm"] * 1.05)
    assert abs(cond[0]["measured_mm"] - t2["dims"][0]["measured_mm"]) < 5


# ─────────────────────────────────────────────── отказы (L4, L6)


@pytest.mark.l6_adversarial
def test_stamp_disagrees_with_dimensions_not_comparable_empty(tmp_path):
    _, geo, _, _ = _sheet(tmp_path, 6, "ar", stamp=200)
    assert geo["quality"] == {"status": "NOT_COMPARABLE", "why": "SCALE_SPREAD"}
    assert geo["scale"]["spread_pct"] > 2 and geo["scale"]["n"] is None
    assert all(
        geo[k] == []
        for k in ("axes", "dims", "walls", "openings", "rooms", "routes", "site")
    )


def _pdf(tmp: Path, draw, name="x.pdf") -> Path:
    p = tmp / name
    c = canvas.Canvas(str(p), pagesize=(842, 595))
    draw(c)
    c.showPage()
    c.save()
    return p


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("what", ["text_only", "empty", "scan"])
def test_page_without_vectors_is_no_vector_layer(tmp_path, what):
    from PIL import Image

    def draw(c):
        if what == "text_only":
            c.drawString(
                50,
                500,
                "Пояснительная записка. Масштаб 1:100. Текст без графики листа.",
            )
        elif what == "scan":
            img = Image.new("L", (800, 560), 245)
            c.drawImage(ImageReader(img), 0, 0, 842, 595)

    p = _pdf(tmp_path, draw)
    page = parse_file(p, "0" * 64).pages[0] if what == "text_only" else None
    geo = G.plan_geometry(p, 1, page)
    assert geo["quality"] == {"status": "NOT_COMPARABLE", "why": "NO_VECTOR_LAYER"}
    assert geo["rev"] == G.GEOM_REV and geo["walls"] == [] and geo["scale"]["n"] is None


@pytest.mark.l6_adversarial
def test_broken_file_and_bad_page_fail_loudly(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage")
    with pytest.raises(CorruptedFile):
        G.plan_geometry(bad, 1)
    ok = _pdf(tmp_path, lambda c: c.line(0, 0, 10, 10))
    with pytest.raises(IndexError):
        G.plan_geometry(ok, 3)


@pytest.mark.l6_adversarial
def test_broken_paths_are_rejected_not_silently_dropped():
    seg = VectorSegment(
        0.1, 0.1, float("nan"), 0.2, path=0, width_pt=1.0, stroke=True, fill_mode=0
    )
    with pytest.raises(G.GeomError, match="не конечны"):
        G.analyze_sheet(PageVectors(1, 842, 595, (seg,) * 60), None)
    with pytest.raises(G.GeomError, match="предела"):
        G.analyze_sheet(PageVectors(1, 842, 595, (), truncated=True), None)
    with pytest.raises(G.GeomError, match="размер"):
        G.analyze_sheet(PageVectors(1, 0, 595, ()), None)


@pytest.mark.l4_fault
def test_timeout_gives_not_comparable_without_partial_result(ar):
    _, _, pdf, page = ar
    ticks = iter(range(0, 10_000, 40))  # каждый вызов часов — плюс 40 с

    geo = G.plan_geometry(pdf, 1, page, limit_s=30, clock=lambda: next(ticks))
    assert geo["quality"] == {"status": "NOT_COMPARABLE", "why": "TIMEOUT"}
    assert all(
        geo[k] == []
        for k in (
            "axes",
            "dims",
            "walls",
            "openings",
            "stairs",
            "levels",
            "routes",
            "symbols",
            "rooms",
            "site",
        )
    )
    assert geo["scale"]["n"] is None and geo["frame"]["to_bld"] is None


@pytest.mark.l3_boundary
@pytest.mark.performance
def test_sheet_under_30s(ar, eng):
    import time

    for _, _, pdf, page in (ar, eng):
        t0 = time.perf_counter()
        G.plan_geometry(pdf, 1, page)
        assert time.perf_counter() - t0 < G.CV_SHEET_LIMIT_S


# ─────────────────────────────────────────────── property: поворот и сдвиг листа (L5)


def _bld_measures(truth, geo) -> dict:
    f = to_bld(geo, truth)
    return {
        "axes": sorted(
            (
                a["mark"],
                tuple(
                    np.round(
                        f(
                            (
                                (a["p0"][0] + a["p1"][0]) / 2,
                                (a["p0"][1] + a["p1"][1]) / 2,
                            )
                        ),
                        -1,
                    )
                ),
            )
            for a in geo["axes"]
        ),
        "walls_t": sorted(w["thickness_mm"] for w in geo["walls"]),
        "openings": sorted(
            (o["kind"], round(o["width_mm"]), round(o["clear_mm"]))
            for o in geo["openings"]
        ),
        "rooms": sorted((r["number"], round(r["area_m2"], 1)) for r in geo["rooms"]),
        "dims": sorted(d["value_mm"] for d in geo["dims"]),
    }


@pytest.mark.l5_property
@pytest.mark.parametrize(
    "kw",
    [{"rot_deg": 3.0, "dx_mm": 7, "dy_mm": -5}, {"rot_deg": -6.0}, {"page_rotate": 90}],
)
def test_rotation_and_shift_do_not_change_building_measures(tmp_path, ar, kw):
    truth, geo, _, _ = ar
    t2, g2, _, _ = _sheet(tmp_path, 1, "ar", **kw)
    a, b = _bld_measures(truth, geo), _bld_measures(t2, g2)
    for k in ("walls_t", "openings", "rooms", "dims"):
        assert a[k] == b[k], k
    for (ma, pa), (mb, pb) in zip(a["axes"], b["axes"]):
        # положение оси в системе здания не зависит от листа (округление до 10 мм)
        assert ma == mb and max(abs(x - y) for x, y in zip(pa, pb)) <= 10


# ─────────────────────────────────────────────── NRM-09 RANSAC, LNK-03 (L1, L2, L6)


@pytest.mark.l2_differential
def test_ransac_affine_recovers_transform_despite_outliers():
    rng = np.random.default_rng(3)
    src = rng.uniform(0, 300, (20, 2))
    m = [
        0.9 * math.cos(0.3),
        0.9 * math.sin(0.3),
        -0.9 * math.sin(0.3),
        0.9 * math.cos(0.3),
        12.0,
        -4.0,
    ]
    dst = G.apply_affine(m, src)
    dst[:4] += 50  # четыре выброса
    got, inl = G.ransac_affine(src, dst, tol=0.5)
    assert np.allclose(got, m, atol=1e-6) and inl.sum() == 16 and not inl[:4].any()
    assert G.ransac_affine(src[:2], dst[:2], 0.5)[0] is None


@pytest.mark.l1_functional
def test_register_same_plan_shifted_and_rotated_lnk03(tmp_path, ar):
    _, geo, _, _ = ar
    _, moved, _, _ = _sheet(tmp_path, 1, "ar", rot_deg=2.0, dx_mm=10, dy_mm=4)
    r = G.register_sheets(geo, moved)
    assert r["ok"] and r["residual_mm"] < 5 and r["anchors"] >= 8


@pytest.mark.l6_adversarial
def test_register_different_plans_is_refused(tmp_path, ar):
    _, geo, _, _ = ar
    _, other, _, _ = _sheet(tmp_path, 8, "ar", n_num=6, n_let=4)
    r = G.register_sheets(geo, other)
    assert not r["ok"]
    no_scale = {**geo, "quality": {"status": "NOT_COMPARABLE", "why": "SCALE_SPREAD"}}
    assert G.register_sheets(no_scale, geo)["ok"] is False


@pytest.mark.l1_functional
def test_strip_width_and_shoelace():
    rect = [(0, 0), (40, 0), (40, 6), (0, 6)]
    assert G.shoelace(rect) == 240 and G.perimeter(rect) == 92
    assert G.strip_width(240, 92) == pytest.approx(6.0)


@pytest.mark.l1_functional
def test_level_parsing():
    assert G.parse_level("±0.000") == 0 and G.parse_level("+3.300") == 3.3
    assert G.parse_level("−0.450") == -0.45 and G.parse_level("-1.200") == -1.2
    assert G.parse_level("3300") is None and G.parse_level("26,39") is None


@pytest.mark.l1_functional
def test_plan_geometry_without_parsed_doc_reads_words_itself(ar):
    """Сигнатура для замера на корпусе: plan_geometry(path, page) — слова тем же разбором текстового слоя."""
    _, geo, pdf, _ = ar
    alone = G.plan_geometry(pdf, 1)
    for k in ("quality", "scale", "frame", "axes", "dims", "walls", "openings", "rooms"):
        assert alone[k] == {kk: v for kk, v in geo.items() if not kk.startswith("_")}[k], k


# ─────────────────────────────────────────────── регресс: дефекты, найденные замером на 150 листах (L8)


@pytest.mark.l8_regression
@pytest.mark.parametrize(
    "seed,kind,kw,check",
    [
        # /Rotate 90: ParsedDoc склеивал одиночную цифру марки оси с соседним словом — цифровые оси терялись
        (204, "ar", {"page_rotate": 90}, "axes"),
        # сторона квадрата ОЗК на штриховке противопожарной стены уходила в «засечку» размера — ОЗК терялся
        (12, "eng", {}, "symbols"),
        # подпись «П1 500×300» доставалась 2-мм штриху рядом, а не воздуховоду; узлы — округлением к сетке
        (104, "eng", {}, "routes"),
        # поворот 4°: заголовок «Условные обозначения» рвался на две строки — знак «other» терялся
        (1, "eng", {"rot_deg": 4.0, "dx_mm": 6, "dy_mm": -3}, "symbols"),
    ],
)
def test_defects_found_by_dev_measurement(tmp_path, seed, kind, kw, check):
    truth, geo, _, _ = _sheet(tmp_path, seed, kind, **kw)
    s = score(truth, geo)
    if check == "axes":
        assert s["axes_recall"] == 1 and s["walls_recall"] == 1
    elif check == "symbols":
        assert s["symbols_recall"] == 1 and s["symbols_extra"] == 0
    else:
        assert s["routes_ok"] == 1
