"""OS-INSP-6.4.3: фабрика v3 — 132 параметра, пять исходов, метки ставит зеркало домена."""

from __future__ import annotations

import json

import pytest

from synth import factory as F
from synth import factory_v3 as V3


@pytest.mark.l1_functional
def test_every_matrix_param_has_generator_and_groups_cover_132():
    V3.install()
    assert set(F.MATRIX) <= set(F.POOL)
    codes = [c for g in V3.groups() for c in g]
    assert sorted(codes) == sorted(F.MATRIX) and len(codes) == 132


@pytest.mark.l1_functional
def test_normal_na_and_conflict_objects_labels(tmp_path):
    # объекты 1 (обычный), 4 (неприменимость), 5 (конфликт редакций) первой группы
    g1, g4, g5 = (F.build_object(1, i, tmp_path, make=V3.make_object, tag=V3.TAG) for i in (1, 4, 5))
    labels = lambda g: {e["param"]: e["label"] for e in g["evidence_groups"]}  # noqa: E731
    assert {"CANDIDATE", "NEGATIVE_VERIFIED", "MISSING_EVIDENCE"} <= set(labels(g1).values())
    appl = [c for c in V3.groups()[0] if F.MATRIX[c].get("applicability")]
    assert appl and all(labels(g4)[c] == "NOT_APPLICABLE" for c in appl if c in labels(g4))
    assert set(labels(g5).values()) == {"CLARIFICATION_REQUIRED"}


@pytest.mark.l3_boundary
def test_deterministic_by_seed(tmp_path):
    a = V3.make_object(7, 2)
    b = V3.make_object(7, 2)
    assert json.dumps(a[0], ensure_ascii=False) == json.dumps(b[0], ensure_ascii=False)
    assert [(d.file_id, d.rows) for d in a[1]] == [(d.file_id, d.rows) for d in b[1]]


@pytest.mark.l6_adversarial
def test_pos_value_really_violates_and_min_threshold_below():
    V3.install()
    import random

    r = random.Random(1)
    for c, p in F.MATRIX.items():
        k = p["compare"]["kind"]
        if k == "min" and p["data_type"] == "number":
            v = F.POOL[c]["base"](r)
            assert v >= p["compare"]["min"] > F.worse(c, v, r)
        if k == "decrease" and p["data_type"] == "number" and not p.get("regex_pattern"):
            v = F.POOL[c]["base"](r)
            assert F.worse(c, v, r) < v


@pytest.mark.l8_regression
def test_v3_install_does_not_change_v2_objects():
    # регрессия: install() дописывал 132 параметра в общий POOL, и v2 после v3 строила другие объекты
    before = F.make_object(1, 1)
    V3.install()
    after = F.make_object(1, 1)
    assert [(d.file_id, d.rows) for d in before[1]] == [(d.file_id, d.rows) for d in after[1]]
    assert set(after[0]["scenarios"]) <= set(F.V2_CODES)


@pytest.mark.l1_functional
def test_stand_publishes_quality_per_matrix_param(tmp_path):
    # OS-INSP-6.5.4: каждый параметр объекта — отдельная строка отчёта с размером выборки
    from eval.run import run, to_markdown

    gold_dir = tmp_path / "gold"
    g = F.build_object(1, 2, gold_dir, make=V3.make_object, tag=V3.TAG)
    r = run(gold_dir, tmp_path / "out", b=20)
    params = {e["param"] for e in g["evidence_groups"] if e["label"] != "NOT_APPLICABLE"}
    assert params <= set(r["slices"]["param"])
    one = r["slices"]["param"][sorted(params)[0]]
    assert one["linkage"]["n"] >= 1 and one["linkage"]["value"] is not None
    assert "## По параметрам Матрицы (OS-INSP-6.5.4)" in to_markdown(r)
