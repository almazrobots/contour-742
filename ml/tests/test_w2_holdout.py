"""T-195: отложенный состязательный набор W2 — генератор, истина, счёт (OS-INSP-6.5.60–6.5.69).

Набор генерируется в тесте (tmp), PDF в репозиторий не попадают. Малый поднабор — несколько примеров нужных видов
с теми же номерами, что в полном плане; полный план проверяется без отрисовки (истина и баланс)."""

from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path

import pytest

from eval.w2_holdout import generate as gen
from eval.w2_holdout import pages
from eval.w2_holdout import scene as sc
from eval.w2_holdout import score as ws
from eval.w2_holdout.render import PT, Frag, Pen
from inspector_ml import pagekind as pk

SEED = 100000
SMALL = [
    "NEG-01",
    "NEG-02",
    "MUT-09/door",
    "MUT-10/corridor_below",
    "MUT-10/wall_only",
    "MUT-13/crossing",
    "MUT-04/remove",
    "TRAP-ROTATE",
    "TRAP-LEAF",
    "MUT-13/crossing+MUT-17",
]


@pytest.fixture(scope="module")
def small(tmp_path_factory):
    out = tmp_path_factory.mktemp("w2h")
    return out, gen.build(out, SEED, only=SMALL, per=1)


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ─────────────────────────────────────────────── генератор


@pytest.mark.l6_adversarial
def test_seed_below_holdout_range_is_refused():
    with pytest.raises(ValueError, match="от 100000"):
        gen.build(None, 9999, only=["NEG-01"], per=1, render=False)


@pytest.mark.l5_property
def test_same_seed_same_bytes_and_truth(tmp_path):
    a = gen.build(tmp_path / "a", SEED, only=["MUT-09/partition", "TRAP-SHIFT"], per=1)
    b = gen.build(tmp_path / "b", SEED, only=["MUT-09/partition", "TRAP-SHIFT"], per=1)
    assert a["truth"] == b["truth"] and a["cases"] == b["cases"]
    files = sorted(
        p.relative_to(tmp_path / "a") for p in (tmp_path / "a").rglob("*.pdf")
    )
    assert len(files) == 16
    assert all(_sha(tmp_path / "a" / f) == _sha(tmp_path / "b" / f) for f in files)


@pytest.mark.l5_property
def test_other_seed_gives_other_objects():
    a = gen.build(None, SEED, only=["MUT-09/door"], per=3, render=False)
    b = gen.build(None, SEED + 1, only=["MUT-09/door"], per=3, render=False)
    assert [t["pd_value"] for t in a["truth"] if t["target"]] != [
        t["pd_value"] for t in b["truth"] if t["target"]
    ]


@pytest.mark.l1_functional
def test_every_file_is_a_vector_page(small):
    out, ds = small
    for case in ds["cases"]:
        for f in case["files"]:
            p = out / case["case_id"] / f["file_name"]
            kinds = pk.detect_pages(p)
            assert [k.kind for k in kinds] == ["vector"], (p, kinds)
            assert f["sha256"] == _sha(p)


@pytest.mark.l1_functional
def test_full_plan_balance_per_w2_operator_without_rendering():
    ds = gen.build(None, SEED, render=False)
    need = ds["balance"]
    assert set(need) == {
        "CMP-06",
        "CMP-07",
        "CMP-09",
        "CMP-12",
        "CMP-13",
        "CMP-14",
        "CMP-15",
        "CMP-16",
        "CMP-19",
        "CMP-30",
        "CMP-31",
    }
    assert all(b["pos"] >= 100 and b["neg"] >= 100 for b in need.values()), need
    assert len(ds["cases"]) >= 1000
    muts = {c["mutation"] for c in ds["cases"]}
    assert {
        "MUT-04",
        "MUT-09",
        "MUT-10",
        "MUT-13",
        "MUT-14",
        "NEG-01",
        "NEG-02",
        "NEG-03",
    } <= muts
    assert any(c["modifier"] == "MUT-17" for c in ds["cases"])


@pytest.mark.l6_adversarial
def test_rule_and_registry_declaration_must_agree():
    reg = gen.load_registry()
    bad = copy.deepcopy(reg)
    bad["mutations"]["MUT-09"]["variants"]["door"]["effects"] = {}
    with pytest.raises(
        AssertionError,
        match="правило даёт CANDIDATE, реестр объявляет NEGATIVE_VERIFIED",
    ):
        gen.build(None, SEED, only=["MUT-09/door"], per=1, reg=bad, render=False)


@pytest.mark.l6_adversarial
def test_registry_effect_on_unknown_pair_is_refused(tmp_path):
    reg = gen.load_registry()
    reg["controls"]["NEG-01"]["effects"] = {"M-999×CMP-12": "CANDIDATE"}
    p = tmp_path / "w2.json"
    p.write_text(json.dumps(reg, ensure_ascii=False), "utf-8")
    with pytest.raises(ValueError, match="неизвестные пары"):
        gen.load_registry(p)


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "rule,pd,rd,want",
    [
        ({"type": "min", "min": 900}, 1000, 900, False),  # ровно норма — не нарушение
        ({"type": "min", "min": 900}, 1000, 899.9, True),
        ({"type": "abs", "tol": 20}, 1500, 1480, False),
        ({"type": "abs", "tol": 20}, 1500, 1479, True),
        ({"type": "pct", "pct": 5.0}, 200.0, 210.0, False),
        ({"type": "pct", "pct": 5.0}, 200.0, 210.1, True),
        ({"type": "pos", "tol": 100}, [0, 0], [60, 80], False),
        ({"type": "pos", "tol": 100}, [0, 0], [60, 80.1], True),
        (
            {"type": "shape", "iou": 0.95, "haus": 1000},
            [0, 0, 2000, 1000],
            [0, 0, 1900, 1000],
            False,
        ),  # IoU ровно 0,95
        (
            {"type": "shape", "iou": 0.95, "haus": 1000},
            [0, 0, 2000, 1000],
            [0, 0, 1899, 1000],
            True,
        ),
        (
            {"type": "shape", "iou": 0.95, "haus": 50},
            [0, 0, 2000, 1000],
            [0, 0, 1950, 1000],
            False,
        ),  # Хаусдорф ровно 50
        (
            {"type": "shape", "iou": 0.95, "haus": 50},
            [0, 0, 2000, 1000],
            [0, 0, 1949, 1000],
            True,
        ),
        (
            {"type": "cover", "d": 500},
            None,
            {"crossings": [[0, 0]], "valves": [[0, 500]]},
            False,
        ),
        (
            {"type": "cover", "d": 500},
            None,
            {"crossings": [[0, 0]], "valves": [[0, 501]]},
            True,
        ),
        ({"type": "internal"}, None, [None, 3], True),
        ({"type": "internal"}, None, [3, 3], False),
    ],
)
def test_rule_boundaries(rule, pd, rd, want):
    assert gen.breaks(rule, pd, rd) is want


@pytest.mark.l1_functional
def test_neg01_pdfs_are_identical(small):
    out, ds = small
    neg = [c for c in ds["cases"] if c["mutation"] == "NEG-01"]
    assert neg
    for c in neg:
        for disc in gen.DISCS:
            assert _sha(out / c["case_id"] / f"PD-{disc}.pdf") == _sha(
                out / c["case_id"] / f"RD-{disc}.pdf"
            )
    rows = [t for t in ds["truth"] if t["mutation"] == "NEG-01"]
    assert rows and all(
        t["polarity"] == "neg" and t["expected"] == ["NEGATIVE_VERIFIED"] for t in rows
    )
    geom = json.loads((out / neg[0]["case_id"] / "RD-PB.geom.json").read_text("utf-8"))
    kinds = {x["kind"] for x in geom["symbols"]}
    assert kinds == {
        "smoke_detector",
        "sounder",
        "fire_hydrant_valve",
    }  # словарь ADR-0010


@pytest.mark.l1_functional
def test_neg02_only_stamp_text_changes(small):
    out, ds = small
    for c in [c for c in ds["cases"] if c["mutation"] == "NEG-02"]:
        for disc in gen.DISCS:
            a, b = (
                out / c["case_id"] / f"PD-{disc}.pdf",
                out / c["case_id"] / f"RD-{disc}.pdf",
            )
            assert _sha(a) != _sha(b)
            assert (
                pk.extract_vectors(a, 1).segments == pk.extract_vectors(b, 1).segments
            )


def _find(segs, p, q, tol):
    for s in segs:
        if s.curve:
            continue
        a, b = (s.x0, s.y0), (s.x1, s.y1)
        if (math.dist(a, p) <= tol and math.dist(b, q) <= tol) or (
            math.dist(a, q) <= tol and math.dist(b, p) <= tol
        ):
            return s
    return None


def _drawn_length_mm(pdf: Path, geom: dict, frag: str, p0, p1) -> float:
    """Отрезок p0–p1 (мм здания) ищется среди путей листа по предсказанному положению; длина — в мм здания."""
    f = geom["frags"][frag]
    fr = Frag(frag, f["n"], f["theta"], tuple(f["pivot"]), tuple(f["center_mm"]))
    pen = Pen(None, geom["sheet"]["w"], geom["sheet"]["h"], geom["rotate"])
    v = pk.extract_vectors(pdf, 1)
    a, b = pen.norm(*fr.m(p0)), pen.norm(*fr.m(p1))
    s = _find(v.segments, a, b, 0.3 / max(geom["sheet"]["w"], geom["sheet"]["h"]))
    assert s is not None, (
        f"{pdf.name}: отрезок {p0}–{p1} ({frag}) не найден среди путей"
    )
    return (
        math.hypot((s.x1 - s.x0) * v.width_pt, (s.y1 - s.y0) * v.height_pt)
        / PT
        * f["n"]
    )


def _check_ar(pdf: Path, geom: dict):
    doors = {o["id"]: o for o in geom["openings"]}
    # frame.to_bld (порядок матрицы PDF) возвращает видимую точку петли Д1 в мм здания
    f = geom["frags"]["main"]
    fr = Frag("main", f["n"], f["theta"], tuple(f["pivot"]), tuple(f["center_mm"]))
    pen = Pen(None, geom["sheet"]["w"], geom["sheet"]["h"], geom["rotate"])
    wv, hv = (pen.h, pen.w) if pen.rotate == 90 else (pen.w, pen.h)
    u, v = pen.norm(*fr.m(doors["D1"]["hinge"]))
    a, b, c, d, e, g = geom["frame"]["to_bld"]
    x, y = u * wv, v * hv
    assert [a * x + c * y + e, b * x + d * y + g] == pytest.approx(
        doors["D1"]["hinge"], abs=1e-3
    )
    for did, frag in (("D1", "main"), ("WC", "main"), ("WC", "frag")):
        o = doors[did]
        assert _drawn_length_mm(pdf, geom, frag, o["hinge"], o["tip"]) == pytest.approx(
            o["width_mm"], abs=1.0
        )
    for d in geom["dims"]:
        if d["key"] in ("corridor", "wcclear", "cabw"):
            got = _drawn_length_mm(pdf, geom, d["frag"], *_dim_line(d, geom))
            assert got == pytest.approx(d["measured_mm"], abs=1.0), d["key"]


def _dim_line(d, geom):
    """Размерная линия коридора лежит на измеряемых точках (вынос 0); у фрагмента — вынос 7–8 мм листа."""
    if d["key"] == "corridor":
        return d["p0"], d["p1"]
    f = geom["frags"]["frag"]
    off = {"wcclear": -7.0, "cabw": 8.0}[d["key"]] * f["n"]
    (x0, y0), (x1, y1) = d["p0"], d["p1"]
    L = math.dist(d["p0"], d["p1"])
    nx, ny = -(y1 - y0) / L, (x1 - x0) / L
    return [x0 + nx * off, y0 + ny * off], [x1 + nx * off, y1 + ny * off]


@pytest.mark.l2_differential
def test_drawn_geometry_matches_truth_in_small_set(small):
    """Независимый пересчёт: длина полотна двери и размерных линий, измеренная по путям листа × масштаб, равна
    истине ± 1 мм — на листах с поворотом /Rotate 90, поворотом плана и в двух масштабах одного листа."""
    out, ds = small
    n = 0
    for c in ds["cases"]:
        for stage in ("PD", "RD"):
            geom = json.loads(
                (out / c["case_id"] / f"{stage}-AR.geom.json").read_text("utf-8")
            )
            _check_ar(out / c["case_id"] / f"{stage}-AR.pdf", geom)
            n += 1
    assert n == 2 * len(ds["cases"])


@pytest.mark.l2_differential
@pytest.mark.parametrize(
    "rotate,theta,small_bld", [(90, 30, False), (0, 15, True), (90, 0, True)]
)
def test_drawn_geometry_matches_truth_rotated_sheets(
    tmp_path, rotate, theta, small_bld
):
    import random

    rng = random.Random(f"test:{rotate}:{theta}")
    s = sc.make_scene(rng, small_bld)
    st = gen.make_style(rng, small_bld) | {"rotate": rotate, "theta": theta, "shx": 0.7}
    doc = {
        "code": "W2H-T",
        "stamp": {"stage": "Р", "revision": "0", "date": "01.01.26", "changes": []},
    }
    pdf = tmp_path / "ar.pdf"
    pen, meta = pages.page_ar(pdf, s, st, doc)
    geom = gen.geometry("AR", s, st, pen, meta)
    assert pk.extract_vectors(pdf, 1).width_pt == pytest.approx(
        (meta["h"] if rotate == 90 else meta["w"]) * PT, abs=0.5
    )
    _check_ar(pdf, geom)


@pytest.mark.l1_functional
def test_targets_have_true_bbox_on_rd_page(small):
    _, ds = small
    tgt = [t for t in ds["truth"] if t["target"] and t["polarity"] in ("pos", "other")]
    assert tgt
    for t in tgt:
        assert t["evidence"], (t["case_id"], t["pair"])
        for e in t["evidence"]:
            x0, y0, x1, y1 = e["bbox"]
            assert (
                0 <= x0 <= x1 <= 1
                and 0 <= y0 <= y1 <= 1
                and e["stage"] == "RD"
                and e["page"] == 1
            )


@pytest.mark.l1_functional
def test_expected_status_by_catalog_exceptions(small):
    _, ds = small
    by = {(t["case_id"], t["pair"]): t for t in ds["truth"]}
    for c in ds["cases"]:
        if c["label"] == "MUT-10/wall_only":
            t = by[(c["case_id"], "M-040×CMP-12")]
            assert t["polarity"] == "other" and t["expected"] == [
                "SUSPICION",
                "NOT_COMPARABLE",
            ]
            assert (
                t["rd_value"] < 1200 and t["pd_value"] >= 1400
            )  # стена сдвинута, размер — прежний
        if c["label"] == "TRAP-LEAF":
            t = by[(c["case_id"], "M-119×CMP-06")]
            assert t["polarity"] == "neg" and t["pd_value"] == t["rd_value"]
        if c["label"] == "MUT-13/crossing+MUT-17":
            t = by[(c["case_id"], "M-111×CMP-16")]
            assert (
                t["polarity"] == "other" and "CMP-29" in t["requires"] and t["pending"]
            )


@pytest.mark.l1_functional
def test_mut17_leaves_pending_when_cmp29_is_implemented():
    reg = gen.load_registry()
    reg["implemented"] = ["CMP-29"]
    ds = gen.build(
        None, SEED, only=["MUT-13/crossing+MUT-17"], per=1, reg=reg, render=False
    )
    t = [t for t in ds["truth"] if t["target"]]
    assert t and all(
        not x["pending"]
        and x["expected"] == ["NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED"]
        for x in t
    )


# ─────────────────────────────────────────────── счёт


def _toy(only=("MUT-09/door", "NEG-01", "TRAP-NOSCALE"), per=5):
    return gen.build(None, SEED, only=list(only), per=per, render=False)


def _perfect(ds, flip=None):
    """Идеальный ответ (статус = первый ожидаемый); flip(t) → свой статус для отдельных групп."""
    res = {}
    for t in ds["truth"]:
        st = (flip(t) if flip else None) or t["expected"][0]
        res.setdefault(t["case_id"], []).append(
            {"code": t["code"], "operator": t["operator"], "status": st}
        )
    return {"results": [{"case_id": k, "rows": v} for k, v in res.items()]}


def _wilson(k, n, z=1.959963984540054):
    """Независимая формула Уилсона (центр ± полуширина), без eval.ci."""
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z / d * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, c - h), min(1.0, c + h)


@pytest.mark.l1_functional
def test_perfect_system_scores_one_and_zero_fpr():
    ds = _toy()
    rep = ws.score(ds, _perfect(ds), b=50)
    s = rep["slices"]["op:CMP-14"]
    assert (
        s["n_pos"] == 5
        and s["recall"] == 1.0
        and s["precision"] == 1.0
        and s["fpr"] == 0.0
    )
    assert rep["slices"]["all"]["status_accuracy"] == 1.0 and not rep["defects"]
    assert (
        rep["slices"]["ctl:NEG-01"]["fpr"] == 0.0
        and rep["slices"]["ctl:NEG-01"]["n_pos"] == 0
    )
    nc = rep["slices"]["ctl:TRAP-NOSCALE"]
    assert (
        nc["abstention"] > 0 and nc["fp"] == 0
    )  # NOT_COMPARABLE на отрицательных — воздержание, не ложное


@pytest.mark.l2_differential
def test_wilson_intervals_recomputed_independently():
    ds = _toy(per=9)
    miss = {
        t["case_id"]
        for t in ds["truth"]
        if t["pair"] == "M-104×CMP-14" and t["polarity"] == "pos"
    }
    miss = set(sorted(miss)[:3])
    fp_case = next(t["case_id"] for t in ds["truth"] if t["mutation"] == "NEG-01")

    def flip(t):
        if t["pair"] == "M-104×CMP-14" and t["case_id"] in miss:
            return "NOT_COMPARABLE"  # воздержание на положительном — промах
        if t["pair"] == "M-104×CMP-14" and t["case_id"] == fp_case:
            return "CANDIDATE"
        return None

    rep = ws.score(ds, _perfect(ds, flip), b=50)
    s = rep["slices"]["pair:M-104×CMP-14"]
    assert (s["tp"], s["fn"], s["fp"]) == (6, 3, 1)
    assert s["recall"] == pytest.approx(6 / 9, abs=1e-4)
    assert s["recall_ci"] == pytest.approx(_wilson(6, 9), abs=1e-4)
    assert s["precision_ci"] == pytest.approx(_wilson(6, 7), abs=1e-4)
    assert s["fpr_ci"] == pytest.approx(_wilson(1, s["n_neg"]), abs=1e-4)
    nc = sum(
        1
        for t in ds["truth"]
        if t["pair"] == "M-104×CMP-14" and t["expected"] == ["NOT_COMPARABLE"]
    )
    assert nc == 9  # TRAP-NOSCALE: честное воздержание на отрицательных
    assert s["abstention"] == pytest.approx(
        (3 + nc) / (s["n_pos"] + s["n_neg"]), abs=1e-4
    )
    assert rep["slices"]["ctl:NEG-01"]["fp"] == 1


@pytest.mark.l1_functional
def test_regress_gate_empty_baseline_fails_then_passes_and_catches_drop():
    ds = _toy()
    rep = ws.score(ds, _perfect(ds), b=50)
    base = json.loads(
        Path(gen.ML / "eval/baselines/w2-holdout.json").read_text("utf-8")
    )
    assert base["schema"] == ws.BASELINE_SCHEMA and base["profiles"] == {}
    assert ws.gate(
        rep, base["profiles"].get("full")
    )  # пустая заготовка — гейт не проходит молча
    bl = ws.baseline_of(rep)
    assert (
        ws.gate(rep, bl) == []
        and "op:CMP-14" in bl["categories"]
        and "ctl:NEG-01" in bl["categories"]
    )
    worse = ws.score(
        ds,
        _perfect(ds, lambda t: "NEGATIVE_VERIFIED" if t["polarity"] == "pos" else None),
        b=50,
    )
    why = ws.gate(worse, bl)
    assert any(w.startswith("op:CMP-14: Recall") for w in why)


@pytest.mark.l6_adversarial
def test_score_refuses_foreign_cases_and_wrong_schema():
    ds = _toy(per=1)
    with pytest.raises(ValueError, match="не из набора"):
        ws.score(ds, {"results": [{"case_id": "X-1", "rows": []}]})
    with pytest.raises(ValueError, match="схемой"):
        ws.score({**ds, "schema": "inspector-mutations/1"}, _perfect(ds))
    rep = ws.score(ds, {"results": []}, b=10)
    assert (
        rep["missing_cases"] and rep["slices"]["all"]["tp"] == 0
    )  # нет ответа — промах, а не пропуск
