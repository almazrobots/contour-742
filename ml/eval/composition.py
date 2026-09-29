"""Состав тестовой выборки по классам эталона (ТЗ §14.2, TZA-14.2-03; OS-INSP-6.5.13–6.5.15).

ТЗ: «В тесте — подтверждённые нарушения, отрицательные, MISSING_EVIDENCE, неприменимые, конфликт редакций».
Стенд до вердикта считает, сколько групп и объектов каждого из пяти классов в выборке (6.5.13); нет хотя бы
одного класса — «не принято» с названием класса, даже если все метрики выше порогов (6.5.14); состав
публикуется в отчёте рядом с метриками (6.5.15). Минимум — одна группа класса (допущение).

Метки приходят из двух словарей, оба сводятся к пяти классам явным словарём LABEL_CLASS:

- эталон стенда (gold.json фабрик v2/v3 — метку ставит зеркало домена eval/decide.py; лист «ПРИМЕРЫ
  РАЗМЕТКИ» — eval/organizer.py): CANDIDATE, CONFIRMED_VIOLATION, NEGATIVE_VERIFIED, MISSING_EVIDENCE,
  NOT_APPLICABLE, CLARIFICATION_REQUIRED;
- ответ и эталон организатора (`violation_label`, eval/submission.py): VIOLATION_PRESENT, NO_VIOLATION,
  MISSING_DOCUMENT, COMPARISON_IMPOSSIBLE. «Сравнение невозможно» — ближайший к конфликту редакций исход
  (сопоставить нельзя до уточнения), допущение; неприменимости в словаре организатора нет вовсе, поэтому
  выборка только в его разметке класс NOT_APPLICABLE не покрывает — и честно получает «не принято».

Неизвестная метка не уходит молча в «прочее»: состав выносит её отдельной строкой, вердикт — «не принято»
с её названием, class_of() бросает UnknownLabelError.
"""

from __future__ import annotations

from collections import Counter

from .thresholds import REJECTED

CLASSES = (
    "VIOLATION",
    "NEGATIVE_VERIFIED",
    "MISSING_EVIDENCE",
    "NOT_APPLICABLE",
    "CLARIFICATION_REQUIRED",
)
TITLES = {
    "VIOLATION": "подтверждённые нарушения",
    "NEGATIVE_VERIFIED": "отрицательные (NEGATIVE_VERIFIED)",
    "MISSING_EVIDENCE": "нет источника (MISSING_EVIDENCE)",
    "NOT_APPLICABLE": "неприменимые (NOT_APPLICABLE)",
    "CLARIFICATION_REQUIRED": "конфликт редакций (CLARIFICATION_REQUIRED)",
}
LABEL_CLASS = {
    # эталон стенда — статусы домена
    "CANDIDATE": "VIOLATION",
    "CONFIRMED_VIOLATION": "VIOLATION",
    "NEGATIVE_VERIFIED": "NEGATIVE_VERIFIED",
    "MISSING_EVIDENCE": "MISSING_EVIDENCE",
    "NOT_APPLICABLE": "NOT_APPLICABLE",
    "CLARIFICATION_REQUIRED": "CLARIFICATION_REQUIRED",
    # формат организатора — violation_label
    "VIOLATION_PRESENT": "VIOLATION",
    "NO_VIOLATION": "NEGATIVE_VERIFIED",
    "MISSING_DOCUMENT": "MISSING_EVIDENCE",
    "COMPARISON_IMPOSSIBLE": "CLARIFICATION_REQUIRED",
}


class UnknownLabelError(ValueError):
    pass


def class_of(label: str) -> str:
    try:
        return LABEL_CLASS[label]
    except KeyError:
        raise UnknownLabelError(
            f"метка эталона вне словаря классов: {label!r}"
        ) from None


def composition_of_groups(groups: list[dict]) -> dict:
    """Группы эталона [{evidence_group_id, object_id, label}] → число групп и объектов по классу."""
    seen: dict[str, set] = {c: set() for c in CLASSES}
    objs: dict[str, set] = {c: set() for c in CLASSES}
    unknown: Counter = Counter()
    for g in groups:
        cls = LABEL_CLASS.get(g.get("label"))
        if cls is None:
            unknown[str(g.get("label"))] += 1
            continue
        seen[cls].add((g.get("object_id"), g.get("evidence_group_id")))
        objs[cls].add(g.get("object_id"))
    return {
        "classes": {
            c: {"groups": len(seen[c]), "objects": len(objs[c])} for c in CLASSES
        },
        "unknown": dict(unknown),
        "n_groups": len(groups),
        "n_objects": len({g.get("object_id") for g in groups}),
    }


def composition(golds: list[dict]) -> dict:
    """Эталоны объектов (gold.json) → состав выборки по пяти классам."""
    return composition_of_groups(
        [
            {**eg, "object_id": eg.get("object_id", g.get("object_id"))}
            for g in golds
            for eg in g["evidence_groups"]
        ]
    )


def organizer_groups(checks: list[dict]) -> list[dict]:
    """Проверки организатора → группы: группа — finding_group_id, без него — сама проверка."""
    return [
        {
            "evidence_group_id": c.get("finding_group_id") or c["check_id"],
            "object_id": c.get("object_id"),
            "label": c.get("violation_label"),
        }
        for c in checks
    ]


def missing_classes(comp: dict, min_groups: int = 1) -> list[str]:
    return [c for c in CLASSES if comp["classes"][c]["groups"] < min_groups]


def apply_composition(vd: dict, comp: dict, min_groups: int = 1) -> dict:
    """Вердикт thresholds.verdict + состав → новый вердикт; метрики и failed не трогаются."""
    missing = missing_classes(comp, min_groups)
    reasons = []
    if missing:
        reasons.append("в выборке нет класса: " + ", ".join(TITLES[c] for c in missing))
    if comp["unknown"]:
        reasons.append(
            "метки эталона вне словаря классов: " + ", ".join(sorted(comp["unknown"]))
        )
    return {
        **vd,
        "verdict": REJECTED if reasons else vd["verdict"],
        "missing_classes": missing,
        "composition_reason": "; ".join(reasons) + " (OS-INSP-6.5.14)"
        if reasons
        else None,
    }


def markdown(comp: dict, missing: list[str]) -> list[str]:
    """Раздел отчёта приёмки «Состав выборки» (OS-INSP-6.5.15)."""
    L = [
        "",
        "## Состав выборки (ТЗ §14.2)",
        "",
        "| Класс | Групп | Объектов |",
        "|---|---|---|",
    ]
    for c in CLASSES:
        row = comp["classes"][c]
        t = TITLES[c]
        L.append(f"| {t[0].upper() + t[1:]} | {row['groups']} | {row['objects']} |")
    for lb, n in sorted(comp["unknown"].items()):
        L.append(f"| Неизвестная метка `{lb}` | {n} | — |")
    if missing:
        L += [
            "",
            "**Нет класса: "
            + ", ".join(TITLES[c] for c in missing)
            + "** — «не принято» (OS-INSP-6.5.14).",
        ]
    return L
