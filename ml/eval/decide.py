"""Решающий слой для стенда: зеркало apps/api/src/domain/{revisions,compare}.ts и выбора источника
из services/inspections.ts (score). Стенд гоняет parse+extract напрямую, без HTTP и БД, поэтому
правила сравнения повторены здесь один в один; расхождение с TS ловит тест
test_decide_mirror_matches_answer_key_v1 на эталоне генератора v1.

Этот же модуль строит эталонные статусы фабрики v2 из истинных значений — так эталон по построению
равен тому, что выдала бы система при идеальном распознавании.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

STAGES = ("PD", "RD", "ID")
EFFECTIVE = ("APPROVED", "FOR_CONSTRUCTION")


@dataclass
class StageValue:
    stage: str
    num: float | None
    text: str | None
    raw: str
    file_id: str
    page: int
    bbox: list[float] | None
    role: str
    document_code: str = ""
    revision: str = ""
    confidence: float = 1.0
    discipline: str = ""


@dataclass
class Evaluation:
    status: str
    fragments: list[StageValue] = field(default_factory=list)
    expected: str | None = None
    actual: str | None = None


# ─────────────────────────────────────────────── OS-INSP-1.3: актуальные редакции


def select_revisions(files: list[dict]) -> dict[str, str]:
    """file_id → CURRENT | SUPERSEDED | CONFLICT | UNRESOLVED (как revisions.ts при наличии реестра)."""
    out: dict[str, str] = {}
    groups: dict[tuple[str, str], list[dict]] = {}
    for f in files:
        groups.setdefault((f["doc_stage"], f["document_code"]), []).append(f)
    for group in groups.values():
        replaced = {f.get("predecessor_id") for f in group if f.get("predecessor_id")}
        cands = []
        for f in group:
            st = f.get("approval_status")
            if st in ("SUPERSEDED", "CANCELLED") or f["file_id"] in replaced:
                out[f["file_id"]] = "SUPERSEDED"
            elif st not in EFFECTIVE:
                out[f["file_id"]] = "UNRESOLVED"
            else:
                cands.append(f)
        if len(cands) == 1:
            out[cands[0]["file_id"]] = "CURRENT"
        else:
            for c in cands:
                out[c["file_id"]] = "CONFLICT"
    return out


# ─────────────────────────────────────────────── OS-INSP-3.1: сравнение


def stage_required(param: dict, stage: str) -> bool:
    src = {
        "PD": param.get("source_pd"),
        "RD": param.get("source_rd"),
        "ID": param.get("source_id"),
    }[stage]
    return bool(src and src.strip() and src.strip() not in ("—", "-"))


def rank(param: dict, text: str) -> float | None:
    scale = param.get("value_scale")
    if isinstance(scale, list):
        return scale.index(text) if text in scale else None
    if scale == "numeric_suffix":
        m = re.search(r"(\d+(?:[.,]\d+)?)", text)
        return float(m.group(1).replace(",", ".")) if m else None
    return None


def violates(param: dict, e: StageValue, a: StageValue) -> bool | None:
    rule = param["compare"]
    numeric = e.num is not None and a.num is not None
    kind = rule["kind"]
    if kind == "delta_pct":
        if not numeric or e.num == 0:
            return None
        return abs((a.num - e.num) / e.num * 100) > rule["tolerance"]
    if kind == "equal":
        if numeric:
            return a.num != e.num
        if e.text is None or a.text is None:
            return None
        return e.text != a.text
    if kind in ("decrease", "increase"):
        if numeric:
            ev, av = e.num, a.num
        elif e.text is not None and a.text is not None:
            ev, av = rank(param, e.text), rank(param, a.text)
        else:
            return None
        if ev is None or av is None:
            return None
        return av < ev if kind == "decrease" else av > ev
    return None


def _show(v: StageValue) -> str:
    return str(v.num) if v.num is not None else (v.text or v.raw)


def evaluate(
    param: dict, profile: dict, values: list[StageValue], loaded: set[str]
) -> Evaluation:
    if param.get("applicability") and profile.get(param["applicability"]) is False:
        return Evaluation("NOT_APPLICABLE")
    disputed = [v for v in values if v.role in ("CONFLICT", "UNRESOLVED")]
    if disputed:
        return Evaluation("CLARIFICATION_REQUIRED", disputed)
    used = [
        next(v for v in values if v.stage == s)
        for s in STAGES
        if any(v.stage == s for v in values)
    ]
    rule = param["compare"]
    if rule["kind"] in ("min", "max"):
        if not used:
            return Evaluation("MISSING_EVIDENCE")
        if any(v.num is None for v in used):
            return Evaluation("NOT_COMPARABLE")
        bad = [
            v
            for v in used
            if (v.num < rule["min"] if rule["kind"] == "min" else v.num > rule["max"])
        ]
        if bad:
            return Evaluation(
                "CANDIDATE", used, str(rule.get("min", rule.get("max"))), _show(bad[-1])
            )
        return Evaluation("NEGATIVE_VERIFIED", used)
    if len(used) < 2:
        return Evaluation("MISSING_EVIDENCE", used)
    exp, *later = used
    worst = None
    for v in later:
        r = violates(param, exp, v)
        if r is None:
            return Evaluation("NOT_COMPARABLE", used)
        if r:
            worst = v
    if worst:
        return Evaluation("CANDIDATE", used, _show(exp), _show(worst))
    return Evaluation("NEGATIVE_VERIFIED", used, _show(exp), _show(later[-1]))


def _score(v: StageValue, param: dict) -> int:
    s = 10 if v.role == "CURRENT" else 0
    sec = param.get("section", "")
    if v.discipline and (sec.startswith(v.discipline) or v.discipline == sec):
        s += 2
    return s + (1 if v.num is not None or v.text else 0)


def choose(candidates: list[StageValue], param: dict) -> list[StageValue]:
    """Один источник на стадию, как inspections.ts: спорные редакции — все; иначе лучший по score."""
    out: list[StageValue] = []
    for s in STAGES:
        cands = [c for c in candidates if c.stage == s and c.role != "SUPERSEDED"]
        disputed = [c for c in cands if c.role in ("CONFLICT", "UNRESOLVED")]
        if disputed:
            out.extend(disputed)
        elif cands:
            # как стабильный sort в JS: при равном score — первый по порядку вставки (max так и делает)
            out.append(max(cands, key=lambda c: _score(c, param)))
    return out
