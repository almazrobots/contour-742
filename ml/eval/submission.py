"""Табло балла организатора (OS-INSP-6.5.6, 6.5.7): схема ответа и 100-балльная шкала.

Официальный рейтинг — 40 баллов экспертов и питча (Q&A 16.09, вопрос 13), F1 — только тай-брейк. Шкала ниже —
архивная, из пакета 02: табло даёт метрики для питча и тай-брейка и проверяет выгрузку, а не считает место в рейтинге.

Что известно из пакета участника (`organizer_spec/`, папка УЧАСТНИКАМ_БЕЗ_ОТВЕТОВ):
веса компонентов 60/15/15/10, потолок 59 при пропуске критической контрольной точки, форма ответа
`submission_schema.json` — доказательство указывает файл и номер страницы PDF, рамок в нём нет.

Правила сопоставления — из `scoring_config.json` организатора (закрытая часть пакета 02, статус
PILOT_SCORING_PROPOSAL; владелец разрешил открывать: организатор назвал её архивной):

- атомарный ключ находки — `object_id + parameter_code + location` (ответ по одному объекту, поэтому пара);
- групповой ответ засчитывается, если покрывает **все** атомарные locations одного `finding_group_id`;
- отрицательные проверки входят в precision, а UNREVIEWED отрицательным классом не считается: ответ
  «нарушение» там, где эталона нет, — не ложное срабатывание, а непроверенная находка (`unreviewed`);
- в счёт идут только записи `score_eligible`.

Остальное организатор не расписал — это **допущения**, каждое закреплено тестом:

- локализация — доля эталонных листов (стадия, файл, страница), названных в ответе, по каждой
  положительной эталонной находке; ненайденная находка даёт 0;
- значения и статусы — по каждой эталонной проверке с `score_eligible` среднее из совпадений метки,
  статуса протокола и тех значений ПД/РД/ИД, что заданы в эталоне; ненайденная проверка даёт 0;
- критическая точка — эталонная проверка с `score_eligible` и статусом `CRITICAL`; пропущена, если
  в ответе нет той же находки с `VIOLATION_PRESENT`;
- целостность документов считается вне табло (манифест, части тома) и передаётся долей; не передана —
  компонент не измерен и в итог не входит (`max_measured` < 100), а не додумывается.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

WEIGHTS = {
    "finding_detection_f1": 60,
    "source_localization_exact_file_page": 15,
    "normalized_value_and_status_accuracy": 15,
    "document_integrity_and_split_handling": 10,
}
CRITICAL_CAP = 59
VIOLATION_LABELS = {
    "VIOLATION_PRESENT",
    "NO_VIOLATION",
    "MISSING_DOCUMENT",
    "COMPARISON_IMPOSSIBLE",
}
PROTOCOL_STATUSES = {
    "OK",
    "WARNING",
    "CRITICAL",
    "ID_MISSING",
    "RD_MISSING",
    "PD_MISSING",
    "COMPARISON_IMPOSSIBLE",
}
STAGES = {"PD", "RD", "ID"}
POSITIVE = "VIOLATION_PRESENT"


class SubmissionError(ValueError):
    pass


# ─────────────────────────────────────────────── схема


def validate(sub: object) -> list[str]:
    """Ошибки по `submission_schema.json`; пустой список — ответ годен."""
    if not isinstance(sub, dict):
        return ["ответ: не объект"]
    errors = []
    if not isinstance(sub.get("object_id"), str):
        errors.append("object_id: обязательная строка")
    checks = sub.get("checks")
    if not isinstance(checks, list):
        return errors + ["checks: обязательный массив"]
    for i, c in enumerate(checks):
        at = f"checks[{i}]"
        if not isinstance(c, dict):
            errors.append(f"{at}: не объект")
            continue
        for key in ("parameter_code", "location"):
            if not isinstance(c.get(key), str):
                errors.append(f"{at}.{key}: обязательная строка")
        if c.get("violation_label") not in VIOLATION_LABELS:
            errors.append(f"{at}.violation_label: не из перечня")
        if "protocol_status" in c and c["protocol_status"] not in PROTOCOL_STATUSES:
            errors.append(f"{at}.protocol_status: не из перечня")
        if (
            "criticality" in c
            and c["criticality"] is not None
            and not isinstance(c["criticality"], str)
        ):
            errors.append(f"{at}.criticality: строка или null")
        ev = c.get("evidence")
        if not isinstance(ev, list):
            errors.append(f"{at}.evidence: обязательный массив")
            continue
        for j, e in enumerate(ev):
            eat = f"{at}.evidence[{j}]"
            if not isinstance(e, dict):
                errors.append(f"{eat}: не объект")
                continue
            if e.get("stage") not in STAGES:
                errors.append(f"{eat}.stage: не из перечня")
            if not isinstance(e.get("file_id"), str):
                errors.append(f"{eat}.file_id: обязательная строка")
            page = e.get("pdf_page_number")
            if isinstance(page, bool) or not isinstance(page, int) or page < 1:
                errors.append(f"{eat}.pdf_page_number: целое ≥ 1")
    return errors


# ─────────────────────────────────────────────── нормализация

_LOC_PREFIX = re.compile(r"^(?:помещение|пом\.?|№)\s*", re.IGNORECASE)
# латиница, похожая на кириллицу, — к кириллице (В40 и B40 — один класс бетона)
_HOMOGLYPHS = str.maketrans("ABCEHKMOPTXYabcehkmopxy", "АВСЕНКМОРТХУавсенкморху")


def norm_location(s: str) -> str:
    t = re.sub(r"\s+", " ", unicodedata.normalize("NFC", s or "")).strip().casefold()
    while True:
        u = _LOC_PREFIX.sub("", t).strip()
        if u == t:
            break
        t = u
    return t.lstrip("0") or t if t.isdigit() else t


def norm_value(v: object) -> str:
    t = unicodedata.normalize("NFC", str(v)).translate(_HOMOGLYPHS).casefold()
    return re.sub(r"\s+", "", t).replace(",", ".")


def finding_key(c: dict) -> tuple[str, str]:
    return (
        str(c.get("parameter_code", "")).strip().upper(),
        norm_location(str(c.get("location", ""))),
    )


def _sheets(c: dict) -> set[tuple[str, str, int]]:
    return {
        (e.get("stage"), e.get("file_id"), e.get("pdf_page_number"))
        for e in c.get("evidence") or []
    }


# ─────────────────────────────────────────────── балл

_LOC_SPLIT = re.compile(r"\s*[,;]\s*")


def expand_groups(checks: list[dict], gold: list[dict]) -> list[dict]:
    """Групповой ответ («140, 142») → атомарные, если он покрывает все locations эталонной группы.

    Места из перечня, не закрывающие ни одну группу целиком, не засчитываются: частичный групповой ответ
    организатор не принимает.
    """
    groups: dict[tuple[str, str], set[str]] = {}
    for g in gold:
        if g.get("finding_group_id"):
            code = finding_key(g)[0]
            groups.setdefault((g["finding_group_id"], code), set()).add(finding_key(g)[1])
    out = []
    for c in checks:
        parts = [p for p in _LOC_SPLIT.split(str(c.get("location", ""))) if p.strip()]
        if len(parts) < 2:
            out.append(c)
            continue
        code = finding_key(c)[0]
        have = {norm_location(p) for p in parts}
        covered = set().union(*(locs for (gid, gc), locs in groups.items() if gc == code and locs <= have)) if groups else set()
        out.extend({**c, "location": loc} for loc in sorted(covered))
    return out



def _value_status(pred: dict | None, g: dict) -> float:
    if pred is None:
        return 0.0
    parts = [pred.get("violation_label") == g.get("violation_label")]
    if g.get("protocol_status") is not None:
        parts.append(pred.get("protocol_status") == g["protocol_status"])
    for key in ("pd_value", "rd_value", "id_value"):
        if g.get(key) is not None:
            parts.append(
                pred.get(key) is not None
                and norm_value(pred[key]) == norm_value(g[key])
            )
    return sum(parts) / len(parts)


def score(sub: dict, gold: list[dict], integrity: float | None = None) -> dict:
    """Балл ответа по одному объекту против эталонных проверок этого объекта."""
    errors = validate(sub)
    if errors:
        raise SubmissionError("; ".join(errors[:5]))
    eligible = [g for g in gold if g.get("score_eligible")]
    gold_pos = {finding_key(g): g for g in eligible if g.get("violation_label") == POSITIVE}
    gold_neg = {finding_key(g) for g in eligible if g.get("violation_label") != POSITIVE}

    first: dict[tuple[str, str], dict] = {}
    pos_seen: Counter = Counter()
    for c in expand_groups(sub["checks"], gold):
        k = finding_key(c)
        first.setdefault(k, c)
        if c.get("violation_label") == POSITIVE:
            pos_seen[k] += 1
    tp = sum(1 for k in gold_pos if pos_seen[k])
    fp = sum(1 for k in gold_neg if pos_seen[k])
    fn = len(gold_pos) - tp
    unreviewed = sum(1 for k in pos_seen if k not in gold_pos and k not in gold_neg)
    f1 = 2 * tp / (2 * tp + fp + fn) if tp + fp + fn else 1.0

    loc = []
    for k, g in gold_pos.items():
        want = _sheets(g)
        got = _sheets(first[k]) if pos_seen[k] else set()
        loc.append(len(want & got) / len(want) if want else float(bool(pos_seen[k])))
    localization = sum(loc) / len(loc) if loc else 1.0

    vs = [_value_status(first.get(finding_key(g)), g) for g in eligible]
    value_status = sum(vs) / len(vs) if vs else 1.0

    components = {
        "finding_detection_f1": f1,
        "source_localization_exact_file_page": localization,
        "normalized_value_and_status_accuracy": value_status,
        "document_integrity_and_split_handling": integrity,
    }
    uncapped = round(
        sum(WEIGHTS[k] * v for k, v in components.items() if v is not None), 2
    )
    critical_missed = sorted(
        g.get("check_id", "?")
        for k, g in gold_pos.items()
        if g.get("protocol_status") == "CRITICAL" and not pos_seen[k]
    )
    capped = bool(critical_missed) and uncapped > CRITICAL_CAP
    return {
        "object_id": sub["object_id"],
        "components": components,
        "counts": {"tp": tp, "fp": fp, "fn": fn},
        "unreviewed": unreviewed,
        "critical_missed": critical_missed,
        "uncapped": uncapped,
        "total": float(CRITICAL_CAP) if capped else uncapped,
        "capped": capped,
        "max_measured": sum(w for k, w in WEIGHTS.items() if components[k] is not None),
    }
