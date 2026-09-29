"""T-192: генератор векторных планов разработки (synth.plans) — детерминизм, истина, границы seed.

Генератор — набор РАЗРАБОТКИ (ADR-0010 п. 6): на нём пишется извлечение, приёмка — на отложенном наборе T-195."""

from __future__ import annotations

import hashlib

import pytest

from synth.plans import KINDS, SEEDS, plan


def _sha(p) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.mark.l1_functional
@pytest.mark.parametrize("kind", KINDS)
def test_same_seed_same_bytes_and_truth(tmp_path, kind):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    ta, tb = plan(7, kind, a), plan(7, kind, b)
    assert _sha(a) == _sha(b) and ta == tb


@pytest.mark.l1_functional
def test_floor_plan_truth_is_consistent(tmp_path):
    t = plan(11, "ar", tmp_path / "p.pdf")
    num = [a for a in t["axes"] if a["family"] == "num"]
    let = [a for a in t["axes"] if a["family"] == "let"]
    assert [a["mark"] for a in num] == [str(i + 1) for i in range(len(num))]
    assert [a["mark"] for a in let] == list("АБВГ"[: len(let)])
    # шаг осей в истине — разности положений осей
    assert t["steps"]["num"] == [b["pos"] - a["pos"] for a, b in zip(num, num[1:])]
    # у двери ширина в свету меньше проёма (каркас), у окна — равна
    for o in t["openings"]:
        assert (
            o["clear_mm"] < o["width_mm"]
            if o["kind"] == "door"
            else o["clear_mm"] == o["width_mm"]
        )
    assert (
        any(w["fire"] for w in t["walls"]) and t["scale"] == 100 and t["stamp"] == 100
    )
    assert {s["kind"] for s in t["stairs"]} == {"stair", "lift"}
    assert len(t["rooms"]) == (len(num) - 1) * (len(let) - 1)


@pytest.mark.l1_functional
def test_engineering_and_site_truth(tmp_path):
    e = plan(2, "eng", tmp_path / "e.pdf")
    assert {r["system"] for r in e["routes"]} == {"П1", "В1"}
    assert {s["kind"] for s in e["symbols"]} >= {"smoke_detector", "fire_hydrant_valve", "other"}
    g = plan(2, "gp", tmp_path / "g.pdf")
    kinds = {s["kind"] for s in g["site"]}
    assert {
        "building",
        "road",
        "lawn",
        "playground",
        "paving",
        "parking",
        "parking_mgn",
    } <= kinds
    road = next(s for s in g["site"] if s["kind"] == "road")
    assert road["width_mm"] in (3500, 4200, 5500, 6000) and g["scale"] == 500


@pytest.mark.l5_property
@pytest.mark.parametrize(
    "kw", [{"rot_deg": 4.0, "dx_mm": 6, "dy_mm": -3}, {"page_rotate": 90}]
)
def test_sheet_transform_does_not_change_building_truth(tmp_path, kw):
    """Поворот и сдвиг листа — только оформление: истина в осях здания та же (на этом стоит property-тест plan_geom)."""
    base = plan(5, "ar", tmp_path / "a.pdf")
    moved = plan(5, "ar", tmp_path / "b.pdf", **kw)
    for k in ("axes", "dims", "walls", "openings", "stairs", "rooms", "levels"):
        assert base[k] == moved[k]
    assert _sha(tmp_path / "a.pdf") != _sha(tmp_path / "b.pdf")


@pytest.mark.l3_boundary
def test_dev_seed_range_and_unknown_kind(tmp_path):
    assert (
        SEEDS.start == 0 and SEEDS.stop == 10_000
    )  # отложенный набор T-195 — seed ≥ 100000
    plan(SEEDS.stop - 1, "ar", tmp_path / "last.pdf")
    with pytest.raises(ValueError, match="вид листа"):
        plan(1, "sections", tmp_path / "x.pdf")


@pytest.mark.l3_boundary
def test_label_error_and_stamp_override_only_touch_labels(tmp_path):
    t = plan(4, "ar", tmp_path / "p.pdf", label_error={0: 9999}, stamp=200)
    first = t["dims"][0]
    assert first["value_mm"] == 9999 and first["measured_mm"] != 9999
    assert t["stamp"] == 200 and t["scale"] == 100
