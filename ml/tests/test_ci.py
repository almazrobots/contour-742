"""Граничные случаи доверительных интервалов (OS-INSP-6.5.2, 6.5.10): перцентиль, бутстрап по объектам, Уилсон.

Дополняет test_eval.py: там — свойства интервалов на выборках, здесь — точные значения на крайних входах.
"""

from __future__ import annotations

import math
from collections import Counter

import pytest

from eval import ci, metrics

EM = metrics.METRICS["exact_match"]["value"]


def _objects() -> dict[str, Counter]:
    """Пять объектов с разной долей точных совпадений — реплики бутстрапа различаются."""
    return {f"O{i}": Counter(em_n=10 + i, em_ok=2 * i + i * i % 3) for i in range(5)}


@pytest.mark.l3_boundary
def test_pct_empty_is_nan():
    assert math.isnan(ci._pct([], 0.5))


@pytest.mark.l3_boundary
def test_pct_linear_interpolation_like_numpy():
    assert ci._pct([0.0, 1.0, 2.0], 0.5) == 1.0
    assert ci._pct([0.0, 10.0], 0.25) == pytest.approx(2.5)
    assert ci._pct([0.0, 10.0, 20.0, 30.0], 0.9) == pytest.approx(27.0)
    assert ci._pct([5.0], 0.975) == 5.0


@pytest.mark.l1_functional
def test_bootstrap_replicates_reproducible_by_seed():
    a = ci.bootstrap_replicates(_objects(), EM, b=50, seed=7)
    assert a == ci.bootstrap_replicates(_objects(), EM, b=50, seed=7)
    assert a != ci.bootstrap_replicates(_objects(), EM, b=50, seed=8)


@pytest.mark.l1_functional
def test_bootstrap_ci_is_percentile_of_replicates_with_given_seed():
    po = _objects()
    for seed in (3, 11):
        reps = sorted(ci.bootstrap_replicates(po, EM, b=40, seed=seed))
        assert ci.bootstrap_ci(po, EM, b=40, seed=seed) == pytest.approx(
            (ci._pct(reps, 0.025), ci._pct(reps, 0.975))
        )
    # сид доходит до ресэмплинга: другой сид (в т. ч. сид по умолчанию) — другой интервал
    assert ci.bootstrap_ci(po, EM, b=40, seed=3) != ci.bootstrap_ci(po, EM, b=40)


@pytest.mark.l1_functional
def test_bootstrap_ci_level_sets_tails():
    po = _objects()
    reps = sorted(ci.bootstrap_replicates(po, EM, b=400, seed=5))
    assert ci.bootstrap_ci(po, EM, b=400, seed=5, level=0.8) == pytest.approx(
        (ci._pct(reps, 0.1), ci._pct(reps, 0.9))
    )


@pytest.mark.l3_boundary
def test_wilson_single_observation_defined():
    lo, hi = ci.wilson(1, 1)
    assert lo == pytest.approx(0.2065, abs=1e-4) and hi == 1.0
    lo, hi = ci.wilson(0, 1)
    assert lo == 0.0 and hi == pytest.approx(0.7935, abs=1e-4)


@pytest.mark.l5_property
def test_wilson_bounds_stay_in_unit_interval_despite_float_error():
    # без обрезки верхняя граница при k = n выходит за 1 на ulp (n = 18, 19, 26 …), нижняя при k = 0 — ниже 0
    for n in range(1, 120):
        for k in (0, n):
            lo, hi = ci.wilson(k, n)
            assert 0.0 <= lo <= hi <= 1.0, (k, n, lo, hi)
