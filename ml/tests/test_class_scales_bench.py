"""Стенд качества CMP-04 (T-172): генератор пар ПД → РД с меткой по построению (ml/eval/class_scales_bench.py)."""

from __future__ import annotations

import json
import random

import pytest

from eval.class_scales_bench import SCHEMA, W1, _lost_flag, cases, main, moves

from test_class_scales import SCALES


@pytest.mark.l2_differential
@pytest.mark.parametrize("code", W1)
def test_bench_balanced_and_extracts_every_positive(code):
    cs = cases(code, 12, random.Random(7), SCALES)
    assert sum(c["label"] for c in cs) == 12 and len(cs) == 24
    assert {c["schema"] for c in cs} == {SCHEMA}
    for c in cs:
        if c["label"] == 1:
            # у понижения обе стороны пары извлечены настоящим экстрактором
            assert all(d["mentions"] for d in c["docs"]), c["id"]


@pytest.mark.l2_differential
def test_moves_are_by_construction_not_by_api_rule():
    rng = random.Random(1)
    down, up, pool = moves("M-056", SCALES["steel_c"]["values"])
    assert down(rng, "С235") is None  # ниже нет — пара не строится
    assert all(int(up(rng, "С355П")[1:4]) >= 355 for _ in range(20))
    d, _, _ = moves("M-109", [])
    assert _lost_flag("M-109", "нг(А)-FRLS", "нг(А)-LS")
    assert not _lost_flag("M-057", "А500", "А400")
    assert d(random.Random(3), "нг(А)-FRLS") != "нг(А)-FRLS"


@pytest.mark.l2_differential
def test_cli_writes_jsonl(tmp_path):
    out = tmp_path / "c.jsonl"
    assert main(["--n", "3", "--params", "M-022,M-055", "--out", str(out)]) == 0
    rows = [json.loads(x) for x in out.read_text("utf-8").splitlines()]
    assert len(rows) == 12 and {r["param"] for r in rows} == {"M-022", "M-055"}
