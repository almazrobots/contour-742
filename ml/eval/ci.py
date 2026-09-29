"""95 % доверительный интервал бутстрапом с ресэмплингом по object_id (OS-INSP-6.5.2).

Единица ресэмплинга — объект целиком, а не страница или группа: единицы одного объекта
коррелированы (один проектировщик, один сканер, одни штампы). Ресэмплинг единиц дал бы
ложно узкий интервал — то же правило изоляции, что и в разбиении train/test (ТЗ 14.2).
Интервал — перцентильный, метрика в каждой реплике — отношение сумм счётчиков реплики.

Для среза из одного объекта бутстрэп по объектам вырожден (все реплики — один и тот же объект, интервал
схлопывается в точку). Там доля k/n получает интервал Уилсона по группам (`wilson`, OS-INSP-6.5.10):
он честнее нормального приближения при малых n и долях у 0 или 1 и не выходит за [0; 1].
"""

from __future__ import annotations

import math
import random
from collections import Counter
from collections.abc import Callable
from statistics import NormalDist

DEFAULT_B = 1000
DEFAULT_SEED = 20260924


def resample_objects(object_ids: list[str], rng: random.Random) -> list[str]:
    """Одна бутстрап-реплика: объекты с возвращением, столько же, сколько в выборке."""
    return [rng.choice(object_ids) for _ in object_ids]


def bootstrap_replicates(
    per_object: dict[str, Counter],
    value: Callable[[Counter], float],
    b: int = DEFAULT_B,
    seed: int = DEFAULT_SEED,
) -> list[float]:
    ids = sorted(per_object)
    if not ids:
        return []
    rng = random.Random(seed)
    out = []
    for _ in range(b):
        s: Counter = Counter()
        for oid in resample_objects(ids, rng):
            s.update(per_object[oid])
        v = value(s)
        if not math.isnan(v):
            out.append(v)
    return out


def _pct(sorted_vals: list[float], q: float) -> float:
    """Перцентиль с линейной интерполяцией (как numpy.percentile по умолчанию)."""
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def bootstrap_ci(
    per_object: dict[str, Counter],
    value: Callable[[Counter], float],
    b: int = DEFAULT_B,
    seed: int = DEFAULT_SEED,
    level: float = 0.95,
) -> tuple[float, float]:
    reps = sorted(bootstrap_replicates(per_object, value, b, seed))
    a = (1 - level) / 2
    return _pct(reps, a), _pct(reps, 1 - a)


def wilson(k: int, n: int, level: float = 0.95) -> tuple[float, float]:
    """Интервал Уилсона для доли k/n (score interval без поправки на непрерывность).

    n = 0 — выборки нет, интервал не определён: (nan, nan), а не выдуманный [0; 1].
    """
    if n <= 0:
        return float("nan"), float("nan")
    z = NormalDist().inv_cdf(1 - (1 - level) / 2)
    p = k / n
    z2n = z * z / n
    center = (p + z2n / 2) / (1 + z2n)
    half = z * math.sqrt(p * (1 - p) / n + z2n / (4 * n)) / (1 + z2n)
    return max(0.0, center - half), min(1.0, center + half)
