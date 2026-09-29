"""T-192: извлекатель geometry_mentions (реестр extractor_kinds) → Extraction.meta.geom по контракту GeomMention (ADR-0010), кэш, отказы, диспетчер.

Листы — генератор разработки synth.plans; цифры — не приёмка (ADR-0010 п. 6)."""

from __future__ import annotations

from collections import Counter

import pytest
from reportlab.pdfgen import canvas

from inspector_ml import geom_mentions as GM
from inspector_ml import plan_geom as G
from inspector_ml.cache import FileCache
from inspector_ml.extract import extract
from inspector_ml.extractor_kinds import way_by_kind
from inspector_ml.filehash import sha256_file
from inspector_ml.model import ParamSpec
from inspector_ml.parse import parse_file
from synth.plans import plan

CONTRACT = {"entity", "measure", "value", "unit", "by", "label_value", "measured_value", "key", "at", "polygon", "graph", "frame",
            "scale_n", "scale_spread_pct", "residual_mm", "page", "bbox", "quote"}  # fmt: skip


def _doc(tmp, seed, kind, **kw):
    """Лист генератора в хранилище блобов (имя — SHA-256, как у сервиса) и его ParsedDoc."""
    pdf = tmp / f"{kind}-{seed}-{abs(hash(repr(sorted(kw.items()))))}.pdf"
    truth = plan(seed, kind, pdf, **kw)
    sha = sha256_file(pdf)
    blob = BLOBS / sha
    blob.write_bytes(pdf.read_bytes())
    return truth, blob, parse_file(blob, sha)


def spec(code, entity, measure, **filters) -> ParamSpec:
    ex = {"kind": "geometry_mentions", "entity": entity, "measure": measure}
    if filters:
        ex["filters"] = filters
    return ParamSpec(code=code, anchors=[code], extractor=ex)


BLOBS = None


@pytest.fixture(scope="module", autouse=True)
def blobs(tmp_path_factory):
    global BLOBS
    BLOBS = tmp_path_factory.mktemp("blobs")
    GM.configure(blobs=BLOBS, cache=None)
    yield BLOBS
    GM.configure()


@pytest.fixture(autouse=True)
def fresh():
    GM.configure(blobs=BLOBS, cache=None)  # память листов процесса — заново в каждом тесте


@pytest.fixture(scope="module")
def ar(tmp_path_factory, blobs):
    return _doc(tmp_path_factory.mktemp("ar"), 1, "ar")


@pytest.fixture(scope="module")
def eng(tmp_path_factory, blobs):
    return _doc(tmp_path_factory.mktemp("eng"), 2, "eng")


@pytest.fixture(scope="module")
def gp(tmp_path_factory, blobs):
    return _doc(tmp_path_factory.mktemp("gp"), 3, "gp")


# ─────────────────────────────────────────────── контракт и значения (L1, L2)


@pytest.mark.l1_functional
def test_meta_geom_is_exactly_the_contract(ar):
    _, pdf, doc = ar
    found = extract(doc, [spec("M-061", "ENT-11", "length")])
    assert found and all(set(e.meta["geom"]) == CONTRACT for e in found)
    g = found[0].meta["geom"]
    assert (
        g["entity"] == "ENT-11"
        and g["measure"] == "length"
        and g["unit"] == "мм"
        and g["frame"] == "bld"
    )
    assert (
        g["scale_n"] == pytest.approx(100, rel=1e-3)
        and g["scale_spread_pct"] <= 2
        and g["residual_mm"] < 1
    )
    assert (
        found[0].meta["quality"] == {"status": "OK", "why": None}
        and found[0].meta["ops"][0] == "ENT-11"
    )
    assert all(e.page == 1 and e.bbox and e.line_text for e in found)


@pytest.mark.l2_differential
def test_wall_thickness_and_axis_keys_match_truth(ar):
    truth, pdf, doc = ar
    found = extract(doc, [spec("M-061", "ENT-11", "length")])
    assert Counter(e.value_num for e in found) == Counter(
        float(w["thickness_mm"]) for w in truth["walls"]
    )
    keys = {e.value_text for e in found}
    assert {
        f"ось {a['mark']}" for a in truth["axes"]
    } <= keys  # каждая стена лежит на оси — ключ LNK-06
    fire = extract(doc, [spec("M-111", "ENT-11", "length", fire=True)])
    assert len(fire) == sum(w["fire"] for w in truth["walls"]) and all(
        "противопожарная" in e.line_text for e in fire
    )


@pytest.mark.l2_differential
def test_axis_steps_by_dimension_and_geometry(ar):
    truth, pdf, doc = ar
    found = extract(doc, [spec("M-054", "ENT-03", "length", family="num")])
    assert [e.value_num for e in found] == [float(v) for v in truth["steps"]["num"]]
    g = found[0].meta["geom"]
    assert (g["by"], g["key"]) == ("both", "1-2") and g["label_value"] == g["value"]
    assert abs(g["measured_value"] - g["label_value"]) < 1
    pos = extract(doc, [spec("M-054", "ENT-03", "position", family="let")])
    lets = [a["pos"] for a in truth["axes"] if a["family"] == "let"]
    assert [round(e.value_num) for e in pos] == lets and all(
        e.meta["geom"]["at"] for e in pos
    )


@pytest.mark.l2_differential
def test_door_clear_width_and_count(ar):
    truth, pdf, doc = ar
    doors = [o for o in truth["openings"] if o["kind"] == "door"]
    clear = extract(
        doc, [spec("M-041", "ENT-10", "length", kind="door", field="clear")]
    )
    assert sorted(round(e.value_num) for e in clear) == sorted(
        round(o["clear_mm"]) for o in doors
    )
    assert {e.value_text for e in clear} == {o["mark"] for o in doors}
    cnt = extract(doc, [spec("M-046", "ENT-10", "count", kind="window")])
    assert [e.value_num for e in cnt] == [
        sum(o["kind"] == "window" for o in truth["openings"])
    ]
    # ширина окна в верхней стене — ещё и числом цепочки размеров (второй источник VER-06)
    wins = extract(doc, [spec("M-046", "ENT-10", "length", kind="window")])
    assert any(
        e.meta["geom"]["by"] == "both" and e.meta["geom"]["label_value"] == e.value_num
        for e in wins
    )


@pytest.mark.l2_differential
def test_rooms_stairs_levels(ar):
    truth, pdf, doc = ar
    rooms = extract(doc, [spec("M-102", "ENT-01", "area")])
    got = {e.value_text: e.value_num for e in rooms}
    assert all(abs(got[r["number"]] - r["area_m2"]) < 0.05 for r in truth["rooms"])
    assert all(
        e.meta["geom"]["by"] == "both" and len(e.meta["geom"]["polygon"]) == 4
        for e in rooms
    )
    steps = extract(doc, [spec("M-048", "ENT-12", "count", kind="stair")])
    assert [e.value_num for e in steps] == [
        next(s["steps"] for s in truth["stairs"] if s["kind"] == "stair")
    ]
    shaft = extract(
        doc, [spec("M-064", "ENT-12", "length", kind="lift", field="shaft_d")]
    )
    assert [e.value_num for e in shaft] == [
        float(next(s for s in truth["stairs"] if s["kind"] == "lift")["shaft_mm"][1])
    ]
    lv = extract(doc, [spec("M-009", "ENT-05", "length")])
    assert (
        sorted(e.value_num for e in lv) == sorted(v["value_m"] for v in truth["levels"])
        and lv[0].meta["geom"]["unit"] == "м"
    )


@pytest.mark.l2_differential
def test_routes_symbols_on_engineering_sheet(eng):
    truth, pdf, doc = eng
    topo = extract(doc, [spec("M-078", "ENT-09", "topology", system="П1")])
    duct = next(r for r in truth["routes"] if r["system"] == "П1")
    g = topo[0].meta["geom"]
    assert (
        len(topo) == 1
        and g["value"] == len(duct["edges"])
        and len(g["graph"]["nodes"]) == len(duct["nodes"])
    )
    area = extract(doc, [spec("M-078", "ENT-09", "area", system="П1")])
    assert (
        area[0].value_num == pytest.approx(GM._section(duct["section"])[1])
        and area[0].meta["geom"]["unit"] == "м²"
    )
    dn = extract(doc, [spec("M-113", "ENT-09", "length", system="В1")])
    pipe = next(r for r in truth["routes"] if r["system"] == "В1")
    assert dn[0].value_num == float(pipe["section"][1:])
    det = extract(doc, [spec("M-080", "ENT-08", "count", kind="smoke_detector")])
    assert det[0].value_num == sum(s["kind"] == "smoke_detector" for s in truth["symbols"])


@pytest.mark.l2_differential
def test_site_areas_width_parking(gp):
    truth, pdf, doc = gp
    lawn = extract(doc, [spec("M-027", "ENT-21", "area", kind="lawn")])
    want = next(s["area_m2"] for s in truth["site"] if s["kind"] == "lawn")
    assert (
        sum(e.value_num for e in lawn) == pytest.approx(want, rel=1e-3)
        and lawn[0].meta["geom"]["frame"] == "sheet"
    )
    road = extract(doc, [spec("M-030", "ENT-21", "length", kind="road")])
    assert road[0].value_num == pytest.approx(
        next(s["width_mm"] for s in truth["site"] if s["kind"] == "road"), abs=10
    )
    mgn = extract(doc, [spec("M-038", "ENT-21", "count", kind="parking_mgn")])
    assert mgn[0].value_num == sum(s["kind"] == "parking_mgn" for s in truth["site"])


@pytest.mark.l2_differential
def test_section_parsing():
    assert GM._section("400×400") == (400, 0.16)
    d, a = GM._section("ø250")
    assert d == 250 and a == pytest.approx(0.049087, abs=1e-6)
    assert GM._section("ø32×2,5")[0] == 32 and GM._section("—") == (None, None)


# ─────────────────────────────────────────────── границы, отказы (L3, L6)


@pytest.mark.l3_boundary
def test_conditional_dimension_gets_low_confidence(tmp_path):
    base = plan(4, "ar", tmp_path / "b.pdf")["dims"][0]["measured_mm"]
    _, pdf, doc = _doc(tmp_path, 4, "ar", label_error={0: round(base * 1.05)})
    found = extract(doc, [spec("M-054", "ENT-04", "length")])
    low = [e for e in found if e.confidence == GM.CONF_COND]
    assert len(low) == 1 and "не в масштабе" in low[0].line_text
    only_ok = extract(
        doc, [spec("M-054", "ENT-04", "length", conditional=False)]
    )
    assert len(only_ok) == len(found) - 1


@pytest.mark.l6_adversarial
def test_not_comparable_sheet_gives_one_refusal_without_value(tmp_path):
    _, pdf, doc = _doc(tmp_path, 6, "ar", stamp=200)
    found = extract(doc, [spec("M-061", "ENT-11", "length")])
    assert len(found) == 1
    e = found[0]
    assert (
        e.value_num is None
        and e.raw == ""
        and e.confidence == 0
        and set(e.meta["geom"]) == CONTRACT
    )
    assert (
        e.meta["quality"] == {"status": "NOT_COMPARABLE", "why": "SCALE_SPREAD"}
        and "SCALE_SPREAD" in e.line_text
    )


@pytest.mark.l6_adversarial
def test_unknown_entity_measure_is_loud(ar):
    _, pdf, doc = ar
    for bad in (
        spec("X", "ENT-11", "area"),
        spec("X", "ENT-99", "length"),
        spec("X", "ENT-06", "length"),
    ):
        with pytest.raises(GM.GeomSpecError):
            GM.extract_geometry_mentions(doc, bad)
        # Main rejects invalid passport specifications explicitly; ordinary
        # extractor failures remain isolated (test_extractor_kinds.py).
        with pytest.raises(GM.GeomSpecError):
            extract(doc, [bad])


@pytest.mark.l6_adversarial
def test_no_file_text_page_or_filtered_sheet_gives_nothing(tmp_path, ar):
    _, pdf, doc = ar
    GM.configure(blobs=tmp_path / "пусто", cache=None)
    assert extract(doc, [spec("M-061", "ENT-11", "length")]) == []  # файла нет в хранилище — геометрии нет
    GM.configure(blobs=BLOBS, cache=None)
    assert extract(doc, [spec("M-061", "ENT-11", "length", sheet="генплан")]) == []
    p = tmp_path / "text.pdf"
    c = canvas.Canvas(str(p))
    c.drawString(50, 700, "Пояснительная записка: общие данные без чертежа, только текст страницы.")
    c.showPage()
    c.save()
    sha = sha256_file(p)
    (BLOBS / sha).write_bytes(p.read_bytes())
    assert extract(parse_file(BLOBS / sha, sha), [spec("M-061", "ENT-11", "length")]) == []
    docx = doc.model_copy(update={"kind": "docx"})
    assert extract(docx, [spec("M-061", "ENT-11", "length")]) == []


# ─────────────────────────────────────────────── кэш, реестр и диспетчер (L1, L4)


@pytest.mark.l1_functional
def test_registered_as_geometry_mentions():
    assert way_by_kind("geometry_mentions") is GM.extract_geometry_mentions and GM.KIND == "geometry_mentions"


@pytest.mark.l1_functional
def test_cache_key_and_hit_without_pdfium(tmp_path, ar, monkeypatch):
    _, pdf, doc = ar
    cache = FileCache(tmp_path / "c")
    GM.configure(blobs=BLOBS, cache=cache)
    first = extract(doc, [spec("M-061", "ENT-11", "length")])
    assert GM.geom_key(doc.sha256, 1) == f"geom-{doc.sha256}-p1-g{G.GEOM_REV}"
    assert cache.get(GM.geom_key(doc.sha256, 1)) is not None

    def boom(*a, **k):
        raise AssertionError("кэш не сработал: геометрия считается заново")

    GM.configure(blobs=BLOBS, cache=cache)  # память процесса очищена — остаётся только общий кэш
    monkeypatch.setattr(GM, "plan_geometry", boom)
    again = extract(doc, [spec("M-061", "ENT-11", "length")])
    assert [e.model_dump() for e in again] == [e.model_dump() for e in first]


@pytest.mark.l4_fault
def test_timeout_is_not_cached(tmp_path, ar, monkeypatch):
    _, pdf, doc = ar
    cache = FileCache(tmp_path / "c")
    GM.configure(blobs=BLOBS, cache=cache)
    monkeypatch.setattr(GM, "plan_geometry", lambda path, n, page: G._empty(n, "TIMEOUT"))
    found = extract(doc, [spec("M-061", "ENT-11", "length")])
    assert found[0].meta["quality"]["why"] == "TIMEOUT" and cache.get(GM.geom_key(doc.sha256, 1)) is None


@pytest.mark.l1_functional
def test_dispatcher_keeps_geometry_out_of_lexical_path(ar, monkeypatch):
    _, pdf, doc = ar
    timings: dict = {}
    lex = ParamSpec(code="M-900", anchors=["Масштаб"], data_type="string")
    geo = spec("M-061", "ENT-11", "length")
    found = extract(doc, [lex, geo], timings=timings)
    assert {e.code for e in found} == {"M-900", "M-061"}
    assert all(e.meta is not None for e in found if e.code == "M-061")
    assert all(e.meta is None for e in found if e.code == "M-900") and "M-061" in timings
    # два параметра геометрии в одном вызове и повторный вызов — лист разбирается один раз
    GM.configure(blobs=BLOBS, cache=None)
    calls = []
    real = GM.plan_geometry
    monkeypatch.setattr(GM, "plan_geometry", lambda *a, **k: calls.append(1) or real(*a, **k))
    extract(doc, [geo, spec("M-054", "ENT-03", "count")])
    extract(doc, [geo])
    assert len(calls) == 1
