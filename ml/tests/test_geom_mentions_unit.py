"""T-192: упоминания по геометрии на PlanGeometry, собранной вручную (без генератора и pdfium) — точные значения,
единицы, ключи, система координат, фильтры, уверенность. Независимый от генератора пересчёт (L2) и границы (L3)."""

from __future__ import annotations

import math

import pytest

from inspector_ml import geom_mentions as GM
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

# лист 1:100; ось 1 — x = 10 мм листа, ось 2 — x = 40, ось А — y = 100, ось Б — y = 60 (y листа вниз)
TO_BLD = [
    100.0,
    0.0,
    0.0,
    -100.0,
    -1000.0,
    10000.0,
]  # x' = 100·x − 1000, y' = −100·y + 10000


def geo(**over) -> dict:
    g = {
        "page": 3, "rev": 1, "quality": {"status": "OK", "why": None},
        "scale": {"n": 100.0, "method": "both", "spread_pct": 0.4, "n_dims": 3},
        "frame": {"to_bld": TO_BLD, "residual_mm": 2.0, "anchors": 4},
        "axes": [
            {"mark": "1", "p0": [10, 20], "p1": [10, 110], "bbox": [0.1, 0.1, 0.11, 0.5]},
            {"mark": "2", "p0": [40, 20], "p1": [40, 110], "bbox": [0.2, 0.1, 0.21, 0.5]},
            {"mark": "А", "p0": [0, 100], "p1": [50, 100], "bbox": [0.0, 0.4, 0.3, 0.41]},
            {"mark": "Б", "p0": [0, 60], "p1": [50, 60], "bbox": [0.0, 0.3, 0.3, 0.31]},
        ],
        "dims": [
            {"value_mm": 3000.0, "measured_mm": 3000.0, "p0": [10, 115], "p1": [40, 115], "bbox": [0.1, 0.5, 0.2, 0.52], "conditional": False},
            {"value_mm": 4200.0, "measured_mm": 4000.0, "p0": [5, 60], "p1": [5, 100], "bbox": [0.0, 0.3, 0.02, 0.4], "conditional": True},
            {"value_mm": 1500.0, "measured_mm": 1500.0, "p0": [12, 118], "p1": [27, 118], "bbox": [0.1, 0.5, 0.15, 0.52], "conditional": False},
        ],
        "levels": [
            {"value_m": 3.3, "kind": "floor", "absolute": False, "bbox": [0.3, 0.3, 0.31, 0.31]},
            {"value_m": 152.4, "kind": "other", "absolute": True, "bbox": [0.3, 0.2, 0.31, 0.21]},
        ],
        "walls": [
            {"a": [10, 60], "b": [10, 100], "thickness_mm": 250.0, "fire": True, "hatch": "diag", "bbox": [0.1, 0.3, 0.11, 0.4]},
            {"a": [20, 80], "b": [30, 80], "thickness_mm": 120.0, "fire": False, "hatch": None, "bbox": [0.12, 0.35, 0.15, 0.36]},
        ],
        "openings": [
            {"mark": "Д1", "kind": "door", "width_mm": 1000.0, "clear_mm": 900.0, "swing": "a+", "wall": 0, "bbox": [0.1, 0.33, 0.11, 0.35], "label_mm": 1000.0},
            {"mark": None, "kind": "window", "width_mm": 1500.0, "clear_mm": 1500.0, "swing": None, "wall": 1, "bbox": [0.13, 0.35, 0.14, 0.36], "label_mm": None},
        ],
        "stairs": [
            {"kind": "stair", "steps": 12, "riser_mm": 150.0, "tread_mm": 300.0, "slope_pct": None, "shaft_mm": None, "bbox": [0.2, 0.2, 0.3, 0.3]},
            {"kind": "lift", "steps": None, "riser_mm": None, "tread_mm": None, "slope_pct": None, "shaft_mm": [1800.0, 2100.0], "bbox": [0.4, 0.2, 0.5, 0.3]},
        ],
        "routes": [
            {"system": "П1", "section": "400×200", "points": [[10, 70], [40, 70], [25, 70], [25, 80]],
             "nodes": [{"id": 0, "kind": "end", "mark": None, "at": [10, 70]}, {"id": 1, "kind": "tee", "mark": None, "at": [25, 70]},
                       {"id": 2, "kind": "end", "mark": None, "at": [40, 70]}, {"id": 3, "kind": "end", "mark": None, "at": [25, 80]}],
             "edges": [[0, 1], [1, 2], [1, 3]], "bbox": [0.1, 0.3, 0.2, 0.4]},
            {"system": "В1", "section": "ø50", "points": [[12, 90], [30, 90]], "nodes": [], "edges": [[0, 1]], "bbox": [0.1, 0.4, 0.2, 0.41]},
        ],
        "symbols": [
            {"kind": "smoke_detector", "mark": None, "at": [15, 65], "bbox": [0.1, 0.3, 0.11, 0.31]},
            {"kind": "smoke_detector", "mark": None, "at": [35, 65], "bbox": [0.2, 0.3, 0.21, 0.31]},
            {"kind": "other", "mark": "Светильник", "at": [20, 90], "bbox": [0.15, 0.4, 0.16, 0.41]},
        ],
        "rooms": [
            {"number": "1.01", "polygon": [[11, 61], [39, 61], [39, 99], [11, 99]], "area_m2": 10.64, "area_label_m2": 10.6, "bbox": [0.1, 0.3, 0.2, 0.4]},
            {"number": "1.02", "polygon": [[41, 61], [49, 61], [49, 99], [41, 99]], "area_m2": 3.04, "area_label_m2": None, "bbox": [0.2, 0.3, 0.25, 0.4]},
        ],
        "site": [
            {"kind": "road", "polygon": [[0, 0], [40, 0], [40, 6], [0, 6]], "width_mm": 600.0, "area_m2": 2.4, "count": None, "bbox": [0, 0, 0.2, 0.03]},
            {"kind": "parking", "polygon": [[0, 10], [2.5, 10], [2.5, 15], [0, 15]], "width_mm": None, "area_m2": 0.125, "count": 1, "bbox": [0, 0.05, 0.01, 0.07]},
            {"kind": "parking", "polygon": [[2.5, 10], [5, 10], [5, 15], [2.5, 15]], "width_mm": None, "area_m2": 0.125, "count": 1, "bbox": [0.01, 0.05, 0.02, 0.07]},
            {"kind": "parking_mgn", "polygon": [[5, 10], [8.6, 10], [8.6, 15], [5, 15]], "width_mm": None, "area_m2": 0.18, "count": 1, "bbox": [0.02, 0.05, 0.03, 0.07]},
        ],
    }  # fmt: skip
    g.update(over)
    return g


def pm(entity, measure, g=None, **flt):
    return GM.page_mentions(g or geo(), entity, measure, flt)


# ─────────────────────────────────────────────── оси, размеры, координаты (L2)


@pytest.mark.l2_differential
def test_axis_steps_label_wins_unless_conditional():
    num = pm("ENT-03", "length", family="num")
    assert len(num) == 1
    m = num[0]
    assert (m["key"], m["value"], m["by"], m["label_value"], m["measured_value"]) == (
        "1-2",
        3000.0,
        "both",
        3000.0,
        3000.0,
    )
    assert (
        m["at"] == [1500.0, 3500.0]
        and m["frame"] == "bld"
        and m["unit"] == "мм"
        and m["page"] == 3
    )
    let = pm("ENT-03", "length", family="let")[
        0
    ]  # размер А–Б «не в масштабе» — значение по геометрии
    assert (let["key"], let["value"], let["label_value"], let["measured_value"]) == (
        "А-Б",
        4000.0,
        4200.0,
        4000.0,
    )
    assert {m["key"] for m in pm("ENT-03", "length")} == {"1-2", "А-Б"}


@pytest.mark.l2_differential
def test_axis_positions_and_count():
    pos = pm("ENT-03", "position")
    got = {m["key"]: (m["value"], m["at"]) for m in pos}
    assert (
        got["1"][0] == 0.0
        and got["2"][0] == 3000.0
        and got["А"][0] == 0.0
        and got["Б"][0] == 4000.0
    )
    assert got["2"][1] == [3000.0, 3500.0]
    cnt = pm("ENT-03", "count")[0]
    assert (cnt["value"], cnt["unit"], cnt["key"]) == (4, "шт", "axes") and cnt[
        "bbox"
    ] == [0.0, 0.1, 0.3, 0.5]
    assert pm("ENT-03", "count", family="let")[0]["value"] == 2


@pytest.mark.l2_differential
def test_axis_position_without_frame_is_null_in_sheet():
    g = geo(frame={"to_bld": None, "residual_mm": None, "anchors": 0})
    pos = pm("ENT-03", "position", g)
    assert all(m["value"] is None and m["frame"] == "sheet" for m in pos)
    assert pos[0]["at"] == [10.0, 65.0]


@pytest.mark.l3_boundary
def test_frame_residual_boundary_50mm():
    ok = pm(
        "ENT-11",
        "length",
        geo(frame={"to_bld": TO_BLD, "residual_mm": 50.0, "anchors": 4}),
    )
    assert ok[0]["frame"] == "bld" and ok[0]["polygon"] == [[0.0, 4000.0], [0.0, 0.0]]
    off = pm(
        "ENT-11",
        "length",
        geo(frame={"to_bld": TO_BLD, "residual_mm": 50.01, "anchors": 4}),
    )
    assert off[0]["frame"] == "sheet" and off[0]["polygon"] == [
        [10.0, 60.0],
        [10.0, 100.0],
    ]
    assert off[0]["residual_mm"] == 50.01


@pytest.mark.l2_differential
def test_dimensions_keys_and_conditional_filter():
    d = pm("ENT-04", "length")
    assert [m["key"] for m in d] == ["1-2", "А-Б", "dim:2"]
    assert [m["value"] for m in d] == [3000.0, 4200.0, 1500.0] and all(
        m["by"] == "both" for m in d
    )
    assert (
        d[1]["measured_value"] == 4000.0
        and "не в масштабе" in d[1]["quote"]
        and "не в масштабе" not in d[0]["quote"]
    )
    assert [m["key"] for m in pm("ENT-04", "length", conditional=False)] == [
        "1-2",
        "dim:2",
    ]
    assert [m["key"] for m in pm("ENT-04", "length", conditional=True)] == ["А-Б"]


@pytest.mark.l2_differential
def test_levels_units_and_filters():
    lv = pm("ENT-05", "length")
    assert [(m["value"], m["unit"], m["key"], m["by"]) for m in lv] == [
        (3.3, "м", "floor", "dimension"),
        (152.4, "м", "other", "dimension"),
    ]
    assert [m["value"] for m in pm("ENT-05", "length", absolute=True)] == [152.4]
    assert [m["value"] for m in pm("ENT-05", "length", kind="floor")] == [3.3]


# ─────────────────────────────────────────────── стены, проёмы, лестницы, помещения (L2)


@pytest.mark.l2_differential
def test_walls_keys_by_axis_and_fire_filter():
    w = pm("ENT-11", "length")
    assert [(m["key"], m["value"], m["measured_value"]) for m in w] == [
        ("ось 1", 250.0, 250.0),
        ("wall:1", 120.0, 120.0),
    ]
    assert "противопожарная" in w[0]["quote"] and "противопожарная" not in w[1]["quote"]
    assert [m["key"] for m in pm("ENT-11", "length", fire=True)] == ["ось 1"]
    assert [m["key"] for m in pm("ENT-11", "length", fire=False)] == ["wall:1"]
    c = pm("ENT-11", "count", fire=True)[0]
    assert (c["value"], c["unit"]) == (1, "шт")


@pytest.mark.l2_differential
def test_openings_width_clear_label_and_count():
    ow = pm("ENT-10", "length")
    assert [(m["key"], m["value"], m["by"], m["label_value"]) for m in ow] == [
        ("Д1", 1000.0, "both", 1000.0),
        ("window:1", 1500.0, "geometry", None),
    ]
    cl = pm("ENT-10", "length", field="clear", kind="door")
    assert [(m["value"], m["label_value"], m["by"]) for m in cl] == [
        (900.0, None, "geometry")
    ] and "в свету" in cl[0]["quote"]
    assert [m["key"] for m in pm("ENT-10", "length", mark="Д\\d+")] == ["Д1"]
    assert (
        pm("ENT-10", "count")[0]["value"] == 2
        and pm("ENT-10", "count", kind="window")[0]["value"] == 1
    )


@pytest.mark.l2_differential
def test_stairs_fields():
    assert [(m["key"], m["value"]) for m in pm("ENT-12", "count")] == [("stair:0", 12)]
    assert [m["value"] for m in pm("ENT-12", "length", kind="stair")] == [300.0]
    riser = pm("ENT-12", "length", kind="stair", field="riser")[0]
    assert (riser["value"], riser["by"]) == (150.0, "dimension")
    assert pm("ENT-12", "length", kind="stair", field="tread")[0]["by"] == "geometry"
    assert [m["value"] for m in pm("ENT-12", "length", kind="lift")] == [1800.0]
    assert [
        m["value"] for m in pm("ENT-12", "length", kind="lift", field="shaft_d")
    ] == [2100.0]
    assert (
        pm("ENT-12", "length", kind="stair", field="shaft_w") == []
    )  # у марша нет шахты
    assert (
        pm("ENT-12", "length", kind="lift", field="riser") == []
    )  # у лифта нет подступенка


@pytest.mark.l2_differential
def test_rooms_area_label_and_width():
    a = pm("ENT-01", "area")
    assert [(m["key"], m["value"], m["label_value"], m["by"], m["unit"]) for m in a] == [
        ("1.01", 10.64, 10.6, "both", "м²"), ("1.02", 3.04, None, "geometry", "м²")]  # fmt: skip
    assert a[0]["polygon"][0] == [100.0, 3900.0]
    assert [(m["key"], m["value"]) for m in pm("ENT-01", "length")] == [
        ("1.01", 2800.0),
        ("1.02", 800.0),
    ]
    assert pm("ENT-01", "shape", number="1.02")[0]["measure"] == "shape"


# ─────────────────────────────────────────────── трассы, знаки, генплан (L2)


@pytest.mark.l2_differential
def test_routes_size_area_topology_count():
    ln = pm("ENT-09", "length")
    assert [(m["key"], m["value"], m["unit"]) for m in ln] == [
        ("П1", 400.0, "мм"),
        ("В1", 50.0, "мм"),
    ]
    ar = pm("ENT-09", "area", system="П1")[0]
    assert (ar["value"], ar["unit"], ar["label_value"]) == (0.08, "м²", 0.08)
    assert pm("ENT-09", "area", system="В1")[0]["value"] == pytest.approx(
        math.pi * 50 * 50 / 4 / 1e6, abs=1e-6
    )
    tp = pm("ENT-09", "topology", system="П1")[0]
    assert (
        tp["value"] == 3
        and len(tp["graph"]["nodes"]) == 4
        and tp["graph"]["edges"] == [[0, 1], [1, 2], [1, 3]]
    )
    assert tp["graph"]["nodes"][1]["at"] == [1500.0, 3000.0]
    assert (
        pm("ENT-09", "count")[0]["value"] == 2
        and pm("ENT-09", "count", system="В\\d")[0]["value"] == 1
    )
    assert pm("ENT-09", "length", section="ø50")[0]["key"] == "В1"


@pytest.mark.l2_differential
def test_symbols_count_and_positions():
    c = pm("ENT-08", "count", kind="smoke_detector")[0]
    assert (c["value"], c["key"], c["bbox"]) == (
        2,
        "smoke_detector",
        [0.1, 0.3, 0.21, 0.31],
    )
    assert pm("ENT-08", "count")[0]["value"] == 3
    pos = pm("ENT-08", "position", kind="other")
    assert [(m["key"], m["at"]) for m in pos] == [("Светильник", [1000.0, 1000.0])]
    assert pm("ENT-08", "position", kind="smoke_detector")[0]["key"] == "smoke_detector"


@pytest.mark.l2_differential
def test_site_area_width_count_position():
    g = geo(frame={"to_bld": None, "residual_mm": None, "anchors": 0})
    road = pm("ENT-21", "length", g, kind="road")[0]
    assert (road["value"], road["frame"], road["key"]) == (600.0, "sheet", "road:0")
    assert (
        pm("ENT-21", "length", g, kind="parking") == []
    )  # у машино-места нет ширины проезда
    assert [m["value"] for m in pm("ENT-21", "area", g, kind="parking")] == [
        0.125,
        0.125,
    ]
    assert pm("ENT-21", "count", g, kind="parking")[0]["value"] == 2
    assert pm("ENT-21", "count", g, kind="parking_mgn")[0]["value"] == 1
    assert (
        pm("ENT-21", "count", g, kind="road")[0]["value"] == 0
    )  # count у полигона без счёта — 0, не None
    p = pm("ENT-21", "position", g, kind="road")[0]
    assert p["at"] == [20.0, 3.0] and p["value"] is None
    assert pm("ENT-21", "shape", g, kind="road")[0]["value"] == 2.4


# ─────────────────────────────────────────────── отказ, уверенность, паспорт, листы (L3, L6)


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "why", ["NO_VECTOR_LAYER", "NO_SCALE", "SCALE_SPREAD", "TIMEOUT"]
)
def test_not_comparable_page_gives_one_refusal(why):
    g = geo(quality={"status": "NOT_COMPARABLE", "why": why})
    out = pm("ENT-21", "area", g)
    assert len(out) == 1
    m = out[0]
    assert (
        m["value"] is None
        and m["frame"] == "sheet"
        and m["key"] == ""
        and why in m["quote"]
        and m["unit"] == "м²"
    )
    assert m["by"] == "geometry" and m["page"] == 3


def spec(entity, measure, **flt) -> ParamSpec:
    ex = {"kind": "geometry_mentions", "entity": entity, "measure": measure}
    if flt:
        ex["filters"] = flt
    return ParamSpec(code="M-X", anchors=["x"], extractor=ex)


@pytest.mark.l3_boundary
def test_confidence_by_frame_measure_and_scale_agreement():
    g = geo()
    q = g["quality"]
    wall = GM.page_mentions(g, "ENT-11", "length", {})[0]
    assert GM.to_extraction(spec("ENT-11", "length"), wall, q).confidence == GM.CONF_OK
    sheet = GM.page_mentions(
        geo(frame={"to_bld": None, "residual_mm": None, "anchors": 0}),
        "ENT-11",
        "length",
        {},
    )[0]
    assert (
        GM.to_extraction(spec("ENT-11", "length"), sheet, q).confidence == GM.CONF_SHEET
    )
    cnt = GM.page_mentions(
        geo(frame={"to_bld": None, "residual_mm": None, "anchors": 0}),
        "ENT-11",
        "count",
        {},
    )[0]
    assert (
        GM.to_extraction(spec("ENT-11", "count"), cnt, q).confidence == GM.CONF_OK
    )  # счёт не зависит от осей
    d = GM.page_mentions(g, "ENT-04", "length", {})
    confs = [GM.to_extraction(spec("ENT-04", "length"), m, q).confidence for m in d]
    assert confs == [GM.CONF_OK, GM.CONF_COND, GM.CONF_OK]
    # ровно 2 % — ещё согласие, выше — пониженная уверенность
    edge = {**d[0], "label_value": 1000.0, "measured_value": 1020.0}
    assert GM.to_extraction(spec("ENT-04", "length"), edge, q).confidence == GM.CONF_OK
    over = {**d[0], "label_value": 1000.0, "measured_value": 1020.5}
    assert (
        GM.to_extraction(spec("ENT-04", "length"), over, q).confidence == GM.CONF_COND
    )


@pytest.mark.l1_functional
def test_extraction_fields():
    g = geo()
    m = GM.page_mentions(g, "ENT-10", "length", {})[0]
    e = GM.to_extraction(spec("ENT-10", "length"), m, g["quality"])
    assert (e.code, e.raw, e.value_num, e.value_text, e.page, e.bbox) == (
        "M-X",
        "1000",
        1000.0,
        "Д1",
        3,
        (0.1, 0.33, 0.11, 0.35),
    )
    assert (
        e.meta["ops"] == ["ENT-10", "ENT-11"]
        and e.meta["quality"] == g["quality"]
        and e.meta["geom"] is m
    )
    refusal = GM.page_mentions(
        geo(quality={"status": "NOT_COMPARABLE", "why": "NO_SCALE"}),
        "ENT-10",
        "length",
        {},
    )[0]
    r = GM.to_extraction(
        spec("ENT-10", "length"),
        refusal,
        {"status": "NOT_COMPARABLE", "why": "NO_SCALE"},
    )
    assert (r.raw, r.value_num, r.value_text, r.confidence, r.bbox) == (
        "",
        None,
        None,
        0.0,
        None,
    )


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "entity,measure",
    [
        ("ENT-01", "count"),
        ("ENT-04", "area"),
        ("ENT-21", "topology"),
        (None, "length"),
        ("ENT-11", None),
    ],
)
def test_check_spec_rejects(entity, measure):
    with pytest.raises(GM.GeomSpecError):
        GM.check_spec(spec(entity, measure))


@pytest.mark.l1_functional
def test_check_spec_returns_copy_of_filters():
    sp = spec("ENT-11", "length", fire=True, sheet="план")
    e, m, f = GM.check_spec(sp)
    f.pop("sheet")
    assert (e, m) == ("ENT-11", "length") and sp.extractor["filters"] == {
        "fire": True,
        "sheet": "план",
    }
    assert GM.is_geom_mentions(sp) and not GM.is_geom_mentions(
        ParamSpec(code="x", anchors=["x"])
    )


def _page(n: int, words: list[str], text_extra: str = "") -> Page:
    ws = [Word(text=w, bbox=(0.1, 0.1, 0.2, 0.2)) for w in words]
    lines = [Line(text=" ".join(words), words=ws)]
    if text_extra:
        lines.append(
            Line(
                text=text_extra,
                words=[Word(text=text_extra, bbox=(0.3, 0.3, 0.4, 0.4))],
            )
        )
    return Page(page=n, width=842, height=595, source="text", lines=lines)


@pytest.mark.l3_boundary
def test_candidate_pages_thresholds_and_sheet_filter(monkeypatch):
    pages = [
        _page(1, ["3000", "3300", "3600", "4200"]),  # 4 числа размера — мало
        _page(2, ["3000", "3300", "3600", "4200", "4800"]),  # ровно 5 — чертёж
        _page(3, ["Масштаб", "1:100"], "Генплан"),
        _page(4, ["Пояснительная", "записка"]),
    ]
    doc = ParsedDoc(sha256="0" * 64, kind="pdf", pages=pages, engine="pdfium")
    assert GM.candidate_pages(doc) == [2, 3]
    assert GM.candidate_pages(doc, "генплан") == [3]
    assert GM.candidate_pages(doc.model_copy(update={"kind": "docx"})) == []
    monkeypatch.setattr(GM, "MAX_GEOM_PAGES", 1)
    assert GM.candidate_pages(doc) == [2]


@pytest.mark.l2_differential
def test_section_and_unit_tables():
    assert GM._section("500×300") == (500.0, 0.15)
    assert GM._section("ø100") == (100.0, round(math.pi * 100 * 100 / 4 / 1e6, 6))
    assert GM._section("150") == (150.0, None)
    assert [GM._unit(e, m) for e, m in [("ENT-05", "length"), ("ENT-04", "length"), ("ENT-21", "area"), ("ENT-01", "shape"),
            ("ENT-09", "topology"), ("ENT-08", "count")]] == ["м", "мм", "м²", "м²", "шт", "шт"]  # fmt: skip


@pytest.mark.l3_boundary
def test_match_semantics():
    assert (
        GM._match("x", None)
        and GM._match(True, True)
        and not GM._match(False, True)
        and GM._match(None, False)
    )
    assert (
        GM._match("П1", "П\\d")
        and not GM._match("П12", "П\\d")
        and not GM._match(None, "П1")
    )
    assert (
        GM._match("a", ["a", "b"])
        and not GM._match("c", ["a", "b"])
        and GM._match("п1", "П1")
    )
