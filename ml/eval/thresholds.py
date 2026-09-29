"""Пороги ТЗ §14 и вердикт приёмки (OS-INSP-6.5.3).

Правило 14.3-08: недостижение ЛЮБОГО обязательного порога — «не принято», даже если сводная F1
выше порога. Метрика без выборки (n = 0) порог не проходит: нечем доказать.
Вердикт выносится по точечной оценке, как в ТЗ; нижняя (для FPR — верхняя) граница 95 % ДИ
показывается рядом как «устойчивость»: проходит ли порог весь интервал.
"""

from __future__ import annotations

import math
import operator

# метрика: (оператор, порог, пункт ТЗ)
THRESHOLDS: dict[str, tuple[str, float, str]] = {
    "character_accuracy": (">=", 0.95, "14.3-01 / 9.1.1"),
    "exact_match": (">=", 0.90, "14.3-02"),
    "linkage": (">=", 0.95, "14.3-03"),
    "localization": (">=", 0.95, "14.3-04"),
    "precision": (">=", 0.90, "14.3-05"),
    "recall": (">=", 0.80, "14.3-05"),
    "f1": (">=", 0.85, "14.3-05"),
    "fpr": ("<=", 0.10, "14.3-06"),
}

_OPS = {">=": operator.ge, "<=": operator.le}

ACCEPTED, REJECTED = "принято", "не принято"


def passes(metric: str, value: float | None) -> bool:
    op, thr, _ = THRESHOLDS[metric]
    if value is None or math.isnan(value):
        return False
    return _OPS[op](round(value, 10), thr)


def verdict(results: dict[str, dict]) -> dict:
    """results: {метрика: {"value": float, "n": int, "ci": [lo, hi]}} → вердикт по каждой и итог."""
    rows = {}
    for m, (op, thr, clause) in THRESHOLDS.items():
        r = results.get(m) or {}
        v, n = r.get("value"), r.get("n", 0) or 0
        ok = bool(n) and passes(m, v)
        lo, hi = (r.get("ci") or [None, None])[:2]
        worst = hi if op == "<=" else lo
        rows[m] = {
            "threshold": f"{op} {thr:.2f}",
            "clause": clause,
            "value": v,
            "n": n,
            "pass": ok,
            "robust": ok and worst is not None and passes(m, worst),
            "reason": None
            if ok
            else ("нет выборки" if not n else f"{v:.4f} не {op} {thr:.2f}"),
        }
    failed = [m for m, r in rows.items() if not r["pass"]]
    return {
        "metrics": rows,
        "failed": failed,
        "verdict": ACCEPTED if not failed else REJECTED,
    }
