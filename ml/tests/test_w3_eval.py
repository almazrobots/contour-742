"""OS-INSP-6.5.70 (T-210): прогон отложенного набора W3 — случай → документы стадий → извлечение ML по паспорту → сравнение
API через мост `apps/api/scripts/w3-eval.ts` → метрики с главной «FP-нарушения».

Фикстуры — свои случаи на М-001 (существующий количественный паспорт), не отложенный набор: набор пишет автор T-210
отдельно, и прогон не должен его видеть. Вид без извлекателя (М-023, class_mentions) и вид без оценщика в мосте — SKIPPED,
а не падение. Только синтетические строки (ADR-0002).
"""

from __future__ import annotations

import json
from collections import Counter

import pytest

from eval import w3_eval
from eval.w3_eval import SKIPPED, metrics, outcome, run_cases, score

PD = "Таблица ТЭП\nПлощадь застройки 3009,4 м2\nСтроительный объем 37076,0 м3"


def case(cid, pd, rd, status, accept=(), adversarial=False, param="M-001"):
    stages = {"PD": [{"discipline": "ПЗУ", "text": pd}] if pd else []}
    stages["RD"] = [{"discipline": "ГП", "text": rd}] if rd is not None else []
    return {
        "id": cid,
        "param": param,
        "stages": stages,
        "expected": {"status": status, "accept": list(accept)},
        "adversarial": adversarial,
        "why": "фикстура теста",
    }


CASES = [
    # таблица «Общих данных» РД ячейками через «|» — то же значение
    case(
        "same",
        PD,
        "Общие данные\n№ | Наименование | Ед. изм. | Кол-во\n1 | Площадь застройки | м2 | 3009,4",
        "NEGATIVE_VERIFIED",
    ),
    case("grew", PD, "Площадь застройки 3120,0 м2", "CANDIDATE"),
    # состязательный: в РД рядом значение до реконструкции — отсеивается, а не сравнивается
    case(
        "existing",
        PD,
        "Площадь застройки (до реконструкции) 1562,6 м2\nПлощадь застройки (после реконструкции) 3009,4 м2",
        "NEGATIVE_VERIFIED",
        adversarial=True,
    ),
    # показателя в РД нет — сравнивать не с чем: воздержание, не нарушение
    case(
        "absent",
        PD,
        "Общие данные\nЭтажность 12",
        "MISSING_EVIDENCE",
        accept=["NOT_COMPARABLE"],
    ),
    # вид извлечения class_mentions в реестр прогона не входит — случай пропускается
    case(
        "no-kind",
        "Класс опасности С0",
        "Класс опасности С1",
        "CANDIDATE",
        param="M-023",
    ),
    # паспорта параметра в ветке ещё нет (ветка W3 не влита) — тоже пропуск, а не падение
    case("no-passport", PD, PD, "NEGATIVE_VERIFIED", param="M-999"),
]


@pytest.fixture(scope="module")
def results():
    return {r["id"]: r for r in run_cases(CASES)}


@pytest.mark.l1_functional
def test_real_extract_and_bridge_statuses(results):
    got = {k: r["status"] for k, r in results.items()}
    assert got["same"] == "NEGATIVE_VERIFIED"
    assert got["grew"] == "CANDIDATE"
    assert got["existing"] == "NEGATIVE_VERIFIED"
    assert got["absent"] in ("MISSING_EVIDENCE", "NOT_COMPARABLE")
    assert got["no-kind"] == got["no-passport"] == SKIPPED


@pytest.mark.l1_functional
def test_score_on_fixtures(results):
    s = score(list(results.values()))
    m = s["metrics"]["ALL"]
    assert m["fp_violations"] == 0 and s["fp_cases"] == []
    assert (m["n"], m["n_pos"], m["n_neg"], m["skipped"]) == (4, 1, 3, 2)
    assert m["recall"] == 1.0 and m["precision"] == 1.0 and m["accuracy"] == 1.0
    assert m["abstain"] == 0.25 and m["abstain_expected"] == 0.25
    assert s["skipped"] == ["no-kind", "no-passport"]
    # срезы: состязательный случай один, базовых три; параметры идут раньше сводных строк
    assert s["metrics"]["состязательные"]["n"] == 1
    assert s["metrics"]["базовые"]["n"] == 3
    assert list(s["metrics"])[:3] == ["M-001", "M-023", "M-999"]
    # пропущенный вид считается в своём параметре, но в метрики не входит
    assert s["metrics"]["M-023"]["n"] == 0 and s["metrics"]["M-023"]["skipped"] == 1


@pytest.mark.l4_fault
def test_unregistered_extractor_does_not_reach_bridge():
    seen = []

    def fake(rows):
        seen.extend(r["id"] for r in rows)
        return {r["id"]: {"status": "NEGATIVE_VERIFIED", "reason": ""} for r in rows}

    out = run_cases([CASES[0], CASES[-1]], evaluate=fake)
    assert seen == ["same"]
    assert [r["status"] for r in out] == ["NEGATIVE_VERIFIED", SKIPPED]


@pytest.mark.l4_fault
def test_bridge_skips_unregistered_value_kind():
    # М-023 — value.kind ordinal: в мосте W3 оценщика этого вида нет
    res = w3_eval.evaluate_rows(
        [{"id": "x", "code": "M-023", "mentions": [], "loadedStages": ["PD", "RD"]}]
    )
    assert res["x"]["status"] == SKIPPED


@pytest.mark.l3_boundary
def test_stage_without_documents_is_not_loaded():
    row = w3_eval.case_row(case("r", PD, None, "MISSING_EVIDENCE"))
    assert row["loadedStages"] == ["PD"]
    assert {m["stage"] for m in row["mentions"]} == {"PD"}
    (m,) = row["mentions"]
    assert (m["num"], m["discipline"], m["document_code"]) == (
        3009.4,
        "ПЗУ",
        "П-100-ПЗУ",
    )


def r(status, expected, accept=()):
    return {
        "id": "i",
        "param": "M-X",
        "status": status,
        "expected": expected,
        "accept": list(accept),
    }


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("row", "want"),
    [
        (r("CANDIDATE", "CANDIDATE"), "tp"),
        (r("CANDIDATE", "NEGATIVE_VERIFIED"), "fp"),
        (r("CANDIDATE", "NEGATIVE_VERIFIED", ["CANDIDATE"]), "accepted_cand"),
        (r("NEGATIVE_VERIFIED", "CANDIDATE"), "fn"),
        (r("NEGATIVE_VERIFIED", "NEGATIVE_VERIFIED"), "tn"),
        (r("MISSING_EVIDENCE", "CANDIDATE"), "abstain_pos"),
        (r("CLARIFICATION_REQUIRED", "NOT_APPLICABLE"), "abstain_neg"),
        (r("NOT_COMPARABLE", "NEGATIVE_VERIFIED"), "abstain_neg"),
        (r("SUSPICION", "CANDIDATE", ["SUSPICION"]), "abstain_pos"),
        (r("NOT_APPLICABLE", "NEGATIVE_VERIFIED"), "abstain_neg"),
        (r(SKIPPED, "CANDIDATE"), "skipped"),
    ],
)
def test_outcome(row, want):
    assert outcome(row) == want


@pytest.mark.l1_functional
def test_metrics_counts_fp_and_wilson():
    rows = [r("CANDIDATE", "CANDIDATE")] * 3 + [
        r("CANDIDATE", "NEGATIVE_VERIFIED"),
        r("NEGATIVE_VERIFIED", "CANDIDATE"),
        r("MISSING_EVIDENCE", "NEGATIVE_VERIFIED", ["MISSING_EVIDENCE"]),
        r("NEGATIVE_VERIFIED", "NEGATIVE_VERIFIED"),
        r(SKIPPED, "CANDIDATE"),
    ]
    m = score(rows)["metrics"]["ALL"]
    assert (m["n"], m["n_pos"], m["n_neg"], m["skipped"], m["fp_violations"]) == (
        7,
        4,
        3,
        1,
        1,
    )
    assert m["precision"] == 0.75 and m["recall"] == 0.75 and m["f1"] == 0.75
    assert m["fpr"] == pytest.approx(1 / 3) and m["abstain"] == pytest.approx(1 / 7)
    assert m["correct"] == 5 and m["accuracy"] == pytest.approx(5 / 7)
    lo, hi = m["fpr_ci"]
    assert 0 < lo < 1 / 3 < hi < 1


@pytest.mark.l3_boundary
def test_metrics_empty_and_no_positive():
    m = metrics(Counter())
    assert m["n"] == 0 and m["precision"] is None and m["recall"] is None
    assert m["f1"] is None and m["fpr_ci"] is None
    m = metrics(Counter(tn=2))
    assert m["recall"] is None and m["fpr"] == 0.0 and m["fp_violations"] == 0
    # есть предсказания и положительные, но ни одного tp — F1 ноль, а не «нет»
    m = metrics(Counter(fp=1, fn=1))
    assert m["precision"] == 0.0 and m["recall"] == 0.0 and m["f1"] == 0.0


@pytest.mark.l1_functional
def test_main_writes_json_and_md(tmp_path, monkeypatch):
    src = tmp_path / "cases.jsonl"
    src.write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in CASES[:2]) + "\n", "utf-8"
    )
    fake = lambda rows: {
        x["id"]: {"status": "CANDIDATE", "reason": "рост"} for x in rows
    }  # noqa: E731
    monkeypatch.setattr(w3_eval, "evaluate_rows", fake)
    out, md = tmp_path / "o/rep.json", tmp_path / "o/rep.md"
    w3_eval.main(["--cases", str(src), "--out", str(out), "--md", str(md)])
    rep = json.loads(out.read_text("utf-8"))
    assert rep["score"]["metrics"]["ALL"]["fp_violations"] == 1
    text = md.read_text("utf-8")
    assert (
        "| ALL | 2 | 1 | 1 | **1** |" in text
        and "`same` M-001: ожидался NEGATIVE_VERIFIED" in text
    )
