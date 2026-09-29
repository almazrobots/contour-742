"""Переходный список синтетики OBJ-USB-132 (T-210): явный, только сокращается, каждая запись — с задачей-владельцем.

Правило для всех волн (28.09): параметр, чью форму генератор ещё не рисует, ожидает MISSING_EVIDENCE и нарушением не
выбирается; seed 1 и ровно 14 нарушений от списка не меняются.
"""

from __future__ import annotations

import json
import re

import pytest

from synth import factory as F
from synth import usability_132 as U

# Храповик: список только сокращается. Добавить код — значит расширить этот набор в том же коммите, что и запись
# в задаче-владельце; ревьюер видит оба изменения.
ALLOWED: frozenset[str] = frozenset(
    {
        "M-096",
        "M-015",
        "M-050",
        "M-056",
        "M-069",
        "M-107",
        "M-109",
        "M-032",
        "M-044",
        "M-130",
    }
)  # T-213: перечень ИД; T-172: классы; T-176: слои и марка (28.09, T-233: паспорта активны в integ)


def _entries() -> list[dict]:
    return json.loads(U.PENDING_FILE.read_text("utf-8"))["pending"]


@pytest.mark.l1_functional
def test_pending_only_shrinks():
    assert {e["code"] for e in _entries()} <= ALLOWED


@pytest.mark.l3_boundary
def test_pending_entry_has_passport_of_its_kind_and_owner_task_naming_the_code():
    tasks = F.ROOT / "tasks"
    for e in _entries():
        assert (
            re.fullmatch(r"M-\d{3}", e["code"])
            and e["reason"].strip()
            and re.fullmatch(r"T-\d{3}", e["task"])
        ), e
        path = F.ROOT / "data/seed/passports" / f"{e['code']}.json"
        if not path.exists():  # паспорт в draft/ до цифр замера
            path = F.ROOT / "data/seed/passports/draft" / f"{e['code']}.json"
        pp = json.loads(path.read_text("utf-8"))
        assert pp["value"]["kind"] == e["kind"], e
        files = list(tasks.glob(f"*/{e['task']}-*.md"))
        assert files and any(e["code"] in f.read_text("utf-8") for f in files), e


@pytest.mark.l1_functional
def test_seed_1_picks_do_not_change_with_pending(monkeypatch):
    now = U.pick_violations(1)
    monkeypatch.setattr(U, "pending", lambda: {})
    assert now == U.pick_violations(1)


@pytest.mark.l1_functional
def test_pending_code_never_picked_and_still_14(monkeypatch):
    base = U.pick_violations(1)
    code = base[0]  # худший случай: переходный параметр был в прежнем выборе
    monkeypatch.setattr(U, "pending", lambda: {code: {"code": code}})
    for seed in (1, 2, 3):
        got = U.pick_violations(seed)
        assert code not in got and len(got) == U.N_VIOLATIONS == 14
        assert set(got) <= set(U.reachable())


@pytest.mark.l1_functional
def test_answer_key_pending_param_expects_missing_evidence(monkeypatch):
    gold = {
        "evidence_groups": [
            {"param": "M-900", "label": "NEGATIVE_VERIFIED", "evidence": []},
            {"param": "M-901", "label": "NOT_APPLICABLE", "evidence": []},
            {"param": "M-902", "label": "NEGATIVE_VERIFIED", "evidence": []},
        ],
        "files": [{"doc_stage": s} for s in ("PD", "RD", "ID")],
    }
    monkeypatch.setattr(U, "pending", lambda: {"M-900": {}, "M-901": {}})
    monkeypatch.setattr(U, "system_label", lambda e, g: e["label"])
    key = U.answer_key(gold)
    assert key == {
        "M-900": "MISSING_EVIDENCE",
        "M-901": "NOT_APPLICABLE",
        "M-902": "NEGATIVE_VERIFIED",
        "scenario": "FULL",
    }
