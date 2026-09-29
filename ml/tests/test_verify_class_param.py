"""Оракул автоматической верификации М-023 (OS-INSP-6.5.8, 6.5.9; T-129) — на синтетике, без реального пакета (ADR-0002).

L1 — выбор источника и сравнение по шкале; L3 — формат протокола («нет расхождения» без статуса и источников);
L8 — регрессия прогона «Алтуфьевское 79Б»: оракул читал статус только из записи и давал ложное MISMATCH."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from eval import verify_class_param as V

# корень репозитория ищется вверх по дереву: из песочницы mutmut (ml/mutants/tests) путь на уровень длиннее
ROOT = next(p for p in Path(__file__).resolve().parents if (p / "data/seed/passports/M-023.json").is_file())
PP = json.loads((ROOT / "data/seed/passports/M-023.json").read_text())


def M(stage, disc, value, page=3, minimum=False, base="2099-01", sha="a" * 64, neighbor=False, file=None):
    return V.Mention(file or f"{stage}-{disc}.pdf", sha, stage, disc, base, page, value, minimum, neighbor)


@pytest.mark.l1_functional
def test_oracle_priority_constraint_and_decrease():
    ms = [M("PD", "ПБ", "С0", 7, minimum=True), M("PD", "АР", "С0", 9), M("PD", "КР", "С1", 6), M("RD", "АР", "С0", 3)]
    o = V.oracle(ms, PP)
    assert (o["status"], o["PD"], o["RD"], o["pd_conflict"]) == ("NEGATIVE_VERIFIED", "не ниже С0", "С0", True)
    o2 = V.oracle([M("PD", "ПЗ", "С0"), M("RD", "АР", "С1")], PP)
    assert (o2["status"], o2["pd_conflict"]) == ("CANDIDATE", False)


@pytest.mark.l1_functional
def test_neighbor_and_other_kit_do_not_count():
    ms = [M("PD", "ПЗ", "С0"), M("PD", "ПЗ", "С2", neighbor=True), M("PD", "ПЗ", "С3", base="2024-77"), M("RD", "АР", "С0")]
    o = V.oracle(ms, PP)
    assert (o["PD"], o["pd_conflict"]) == ("С0", False)


PROTOCOL = {"sections": {"completeness": [{"param_code": "M-023"}], "negative_verified": [{"param_code": "M-023", "expected": "не ниже С0", "actual": "С0"}]}}
INSP = {
    "checks": [{"param_code": "M-023", "fragments": [
        {"role_expected_actual": "expected", "sha256": "d" * 64, "sheet_page": 7},
        {"role_expected_actual": "actual", "sha256": "c" * 64, "sheet_page": 3},
    ]}],
    "suspicions": [{"description": "M-023: Внутреннее противоречие ПД: класс указан по-разному — …"}],
}


@pytest.mark.l3_boundary
def test_status_from_section_and_evidence_from_inspection_fragments():
    s = V.system_check(PROTOCOL, "M-023", INSP)
    assert s["status"] == "NEGATIVE_VERIFIED"  # в записи раздела статуса нет — берётся из раздела, не из «комплектности»
    assert s["sources"] == [{"role": "expected", "sha256": "d" * 64, "page": 7}, {"role": "actual", "sha256": "c" * 64, "page": 3}]
    assert s["pd_conflict"] is True
    bare = V.system_check(PROTOCOL, "M-023")  # без выгрузки проверки: доказательств нет — поля evidence не совпадут
    assert "sources" not in bare and "pd_conflict" not in bare
    with pytest.raises(SystemExit):
        V.system_check(PROTOCOL, "M-999", INSP)


@pytest.mark.l8_regression
def test_altufyevo_shape_matches_and_equivalent_evidence_is_marked():
    """Регрессия: форма реального прогона (значения синтетические). РД: система взяла АР2, оракул — АР1 той же страницы
    и того же класса — «равноценно», поле помечено equivalent (сервер принимает это только для *.evidence)."""
    ms = [M("PD", "ПБ", "С0", 7, minimum=True, sha="d" * 64), M("PD", "КР", "С1", 6), M("RD", "АР", "С0", 3, sha="b" * 64, file="АР1.pdf"), M("RD", "АР", "С0", 3, sha="c" * 64, file="АР2.pdf")]
    fields = V.compare(V.system_check(PROTOCOL, "M-023", INSP), V.oracle(ms, PP), ms)
    by = {f["field"]: f for f in fields}
    assert all(f["ok"] for f in fields), fields
    assert by["PD.internal_conflict"]["system"] == by["PD.internal_conflict"]["oracle"] == "есть"
    assert by["RD.evidence"].get("equivalent") is True and by["RD.evidence"]["system"] != by["RD.evidence"]["oracle"]
    assert "equivalent" not in by["PD"] and "equivalent" not in by["PD.evidence"]


@pytest.mark.l1_functional
def test_value_mismatch_is_never_equivalent():
    ms = [M("PD", "ПБ", "С0", 7, minimum=True, sha="d" * 64), M("RD", "АР", "С1", 3, sha="c" * 64)]
    fields = V.compare(V.system_check(PROTOCOL, "M-023", {**INSP, "suspicions": []}), V.oracle(ms, PP), ms)
    by = {f["field"]: f for f in fields}
    assert not by["RD"]["ok"] and not by["status"]["ok"]
    assert "equivalent" not in by["RD"]


@pytest.mark.l6_adversarial
def test_oracle_stays_in_the_sentence_and_skips_norm_table_cells():
    """Ложные срабатывания оракула на листе ПБ 2024 (T-129): значение из следующей фразы и ячейка таблицы СП 118."""
    no_value = "с учетом класса их конструктивной пожарной опасности. Кадастровый номер 77:02:0003002:136 С0"
    table = "Класс конструктивной пожарной опасности зданий до 5000 Торговые – 25 и более 25 и менее площадью 742 кв.м. 70/1,5 С0"
    real = "Степень огнестойкости – II. Класс конструктивной пожарной опасности – С0. Класс функциональной"
    assert V.mentions_in(no_value, []) == []
    assert V.mentions_in(table, []) == []
    assert V.mentions_in(real, []) == [("С0", False, False)]
