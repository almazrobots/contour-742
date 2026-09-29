"""Фабрика синтетики v2 (OS-INSP-6.4.1) и сквозной прогон стенда на ней (OS-INSP-6.5).

Имя теста — то, на что ссылается трасса (docs/gera/inspector/model.yaml → impl).
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

import pytest

from eval.metrics import exact_match, iou, norm_text
from inspector_ml.parse import parse_file
from synth import factory


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("synth-v2")
    return out, factory.build(1, 7, out)[0]


@pytest.mark.l5_property
def test_factory_deterministic_by_seed(tmp_path, built):
    out, gold = built
    again = factory.build(1, 7, tmp_path)[0]
    assert again == gold
    oid = gold["object_id"]
    for f in gold[
        "files"
    ]:  # байты PDF (и сканов) совпадают: reportlab invariant, шум из seed
        assert _sha(tmp_path / oid / f["file_name"]) == _sha(out / oid / f["file_name"])
    other = factory.make_object(8, 1)
    assert (
        other[0]["scenarios"] != factory.make_object(7, 1)[0]["scenarios"]
        or other[2] != factory.make_object(7, 1)[2]
    )


@pytest.mark.l1_functional
def test_factory_gold_matches_rendered_text_layer(built):
    """Значение из эталона реально стоит на странице: текстовый слой, та же страница, IoU ≥ 0,5."""
    out, gold = built
    oid = gold["object_id"]
    checked = 0
    for f in gold["files"]:
        if f["kind"] != "pdf":
            continue
        doc = parse_file(out / oid / f["file_name"], f["sha256"])
        for kind, items in (
            ("values", gold["values"]),
            ("key_fields", gold["key_fields"]),
        ):
            for v in (x for x in items if x["file_id"] == f["file_id"]):
                page = doc.pages[v["page"] - 1]
                want = norm_text(v.get("raw") or v["value"])
                words = [w for ln in page.lines for w in ln.words]
                hit = [
                    w
                    for w in words
                    if iou(w.bbox, v["bbox"]) > 0 and w.text in want.split(" ")
                ]
                assert hit, (kind, v)
                box = (
                    min(w.bbox[0] for w in hit),
                    min(w.bbox[1] for w in hit),
                    max(w.bbox[2] for w in hit),
                    max(w.bbox[3] for w in hit),
                )
                assert iou(box, v["bbox"]) >= 0.5, (kind, v, box)
                assert " ".join(w.text for w in hit) == want or exact_match(
                    v.get("field", "code"), want, " ".join(w.text for w in hit)
                )
                checked += 1
        # эталонный текст страницы = текстовый слой (с точностью до пробелов)
        for gp in (p for p in gold["pages"] if p["file_id"] == f["file_id"]):
            got = " ".join(ln.text for ln in doc.pages[gp["page"] - 1].lines)
            assert sorted(norm_text(got).split(" ")) == sorted(
                norm_text(gp["text"]).split(" ")
            ), gp["page"]
    assert checked > 10


@pytest.mark.l1_functional
def test_factory_gold_has_requisites_changes_and_scans(built):
    _, gold = built
    kinds = Counter(r["kind"] for r in gold["requisites"])
    assert kinds["seal"] and kinds["signature"] and kinds["stamp_production"]
    assert all(0 <= v <= 1 for r in gold["requisites"] for v in r["bbox"])
    assert gold["changes"] and all(
        c["file_old"].endswith("-A") and c["file_new"].endswith("-B")
        for c in gold["changes"]
    )
    assert any(f["kind"] == "scan" and 150 <= f["dpi"] <= 300 for f in gold["files"])
    assert {g["label"] for g in gold["evidence_groups"]} <= {
        "CANDIDATE",
        "NEGATIVE_VERIFIED",
        "MISSING_EVIDENCE",
        "CLARIFICATION_REQUIRED",
    }


@pytest.mark.l5_property
def test_factory_scenarios_yield_expected_statuses():
    """Сценарий параметра → ожидаемый статус эталона на 25 объектах (без отрисовки — только план)."""
    seen = Counter()
    for i in range(1, 26):
        obj, docs, base = factory.make_object(3, i)
        seen["conflict"] += obj["conflict_kr"]
        for code, sc in obj["scenarios"].items():
            seen[sc] += 1
            rd_b = next(
                (dict(d.rows).get(code) for d in docs if d.file_id.endswith("RD-AR-B")),
                None,
            )
            if (
                sc == "trap"
            ):  # нарушение только в устаревшей ред. A, в актуальной B — как в ПД или в допуске
                rd_a = next(
                    dict(d.rows).get(code)
                    for d in docs
                    if d.file_id.endswith("RD-AR-A")
                )
                assert rd_a != base[code] and rd_b is not None
            if sc == "missing":
                assert all(code not in dict(d.rows) for d in docs if d.stage != "PD")
    assert min(seen[k] for k in ("pos", "neg", "trap", "missing", "conflict")) > 0


@pytest.mark.l1_functional
def test_factory_labels_follow_scenarios(built):
    _, gold = built
    by = {g["param"]: g for g in gold["evidence_groups"]}
    for code, sc in gold["scenarios"].items():
        g = by[code]
        if g["label"] == "CLARIFICATION_REQUIRED":
            continue  # конфликт редакций КЖ перекрывает сценарий
        want = {
            "pos": "CANDIDATE",
            "neg": "NEGATIVE_VERIFIED",
            "trap": "NEGATIVE_VERIFIED",
            "missing": "MISSING_EVIDENCE",
        }[sc]
        assert g["label"] == want, (code, sc)
        if sc == "trap":
            assert g["superseded_trap"]


@pytest.mark.l1_functional
def test_eval_run_end_to_end_report(built, tmp_path):
    """Стенд: конвейер parse+extract по эталону → JSON и markdown, все пороговые метрики с n и ДИ."""
    from eval.run import run
    from eval.thresholds import THRESHOLDS

    out, _ = built
    rep = run(out, tmp_path / "eval", b=50)
    assert (tmp_path / "eval/report.json").exists() and "Вердикт" in (
        tmp_path / "eval/report.md"
    ).read_text("utf-8")
    has300 = any(f["kind"] == "scan" and f["dpi"] >= 300 for f in built[1]["files"])
    for m in THRESHOLDS:
        o = rep["overall"][m]
        if m == "character_accuracy" and not has300:
            # CA по ТЗ — только сканы ≥ 300 dpi; нет их — нет выборки, и порог не засчитан
            assert o["n"] == 0 and m in rep["verdict"]["failed"]
            continue
        assert (
            o["n"] > 0
            and o["value"] is not None
            and o["ci"][0] <= o["value"] <= o["ci"][1]
        ), m
    assert rep["verdict"]["verdict"] in ("принято", "не принято")
    assert (
        rep["slices"]["object"] and rep["slices"]["section"] and rep["slices"]["type"]
    )
    assert json.loads((tmp_path / "eval/report.json").read_text("utf-8"))[
        "disclaimer"
    ].startswith("Синтетический")
