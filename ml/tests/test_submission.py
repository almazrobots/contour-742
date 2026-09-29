"""Табло балла организатора (OS-INSP-6.5.6, 6.5.7): схема ответа, 4 компонента, потолок 59.

Эталон здесь синтетический, по форме `public_train_checks.jsonl`: реальные строки организатора в репозиторий
не попадают.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from eval import submission as sb

SPEC = Path(sb.__file__).parent / "organizer_spec"


def gold(
    cid,
    code,
    loc,
    label="VIOLATION_PRESENT",
    status="CRITICAL",
    eligible=True,
    ev=None,
    pd=None,
    rd=None,
):
    return {
        "check_id": cid,
        "object_id": "OBJ-SYNTH",
        "parameter_code": code,
        "location": loc,
        "violation_label": label,
        "protocol_status": status,
        "criticality": "Критическое (приостановка работ)"
        if status == "CRITICAL"
        else None,
        "score_eligible": eligible,
        "pd_value": pd,
        "rd_value": rd,
        "evidence": ev
        or [
            {"stage": "PD", "file_id": "F1", "pdf_page_number": 3},
            {"stage": "RD", "file_id": "F2", "pdf_page_number": 7},
        ],
    }


GOLD = [
    gold("G1", "IOS4-078", "140"),
    gold("G2", "IOS4-078", "142"),
    gold("G3", "FREE-HEATING-001", "267", status="WARNING"),
    gold(
        "G4",
        "KR-055",
        "Фундаментная плита",
        label="NO_VIOLATION",
        status="OK",
        eligible=False,
        pd="B40",
        rd="B40",
    ),
]


def perfect() -> dict:
    return copy.deepcopy({
        "object_id": "OBJ-SYNTH",
        "checks": [
            {
                k: g[k]
                for k in (
                    "parameter_code",
                    "location",
                    "violation_label",
                    "protocol_status",
                    "criticality",
                    "evidence",
                    "pd_value",
                    "rd_value",
                )
            }
            for g in GOLD
        ],
    })


# ─────────────────────────────── схема


@pytest.mark.l1_functional
def test_perfect_submission_is_valid():
    assert sb.validate(perfect()) == []


@pytest.mark.l7_discipline
def test_enums_match_vendored_schema():
    """Перечисления в коде — ровно те, что в `submission_schema.json` организатора."""
    schema = json.loads((SPEC / "submission_schema.json").read_text())
    item = schema["properties"]["checks"]["items"]["properties"]
    assert set(item["violation_label"]["enum"]) == sb.VIOLATION_LABELS
    assert set(item["protocol_status"]["enum"]) == sb.PROTOCOL_STATUSES
    assert set(item["evidence"]["items"]["properties"]["stage"]["enum"]) == sb.STAGES
    summary = json.loads((SPEC / "scoring_summary_without_answers.json").read_text())
    assert summary["weights_points"] == sb.WEIGHTS


@pytest.mark.l4_fault
@pytest.mark.parametrize(
    "mutate, fragment",
    [
        (lambda s: s.pop("object_id"), "object_id"),
        (lambda s: s.__setitem__("checks", {}), "checks"),
        (lambda s: s["checks"][0].pop("evidence"), "evidence"),
        (
            lambda s: s["checks"][0].__setitem__("violation_label", "MAYBE"),
            "violation_label",
        ),
        (
            lambda s: s["checks"][0].__setitem__("protocol_status", "BAD"),
            "protocol_status",
        ),
        (lambda s: s["checks"][0]["evidence"][0].__setitem__("stage", "XX"), "stage"),
        (
            lambda s: s["checks"][0]["evidence"][0].__setitem__("pdf_page_number", 0),
            "pdf_page_number",
        ),
        (
            lambda s: s["checks"][0]["evidence"][0].__setitem__(
                "pdf_page_number", True
            ),
            "pdf_page_number",
        ),
        (lambda s: s["checks"][0]["evidence"][0].__setitem__("file_id", 5), "file_id"),
        (lambda s: s["checks"][0].__setitem__("criticality", 3), "criticality"),
        (lambda s: s["checks"][0].__setitem__("location", None), "location"),
    ],
)
def test_schema_violations_are_reported(mutate, fragment):
    s = perfect()
    mutate(s)
    errors = sb.validate(s)
    assert errors and any(fragment in e for e in errors)


# ─────────────────────────────── балл


@pytest.mark.l1_functional
def test_perfect_scores_100():
    r = sb.score(perfect(), GOLD, integrity=1.0)
    assert r["components"] == {k: 1.0 for k in sb.WEIGHTS}
    assert r["total"] == 100.0
    assert r["capped"] is False


@pytest.mark.l1_functional
def test_empty_submission_scores_zero_and_is_capped():
    r = sb.score({"object_id": "OBJ-SYNTH", "checks": []}, GOLD, integrity=0.0)
    assert r["total"] == 0.0
    assert r["critical_missed"] == ["G1", "G2"]


@pytest.mark.l1_functional
def test_missing_critical_caps_at_59():
    s = perfect()
    s["checks"] = [c for c in s["checks"] if c["location"] != "142"]
    r = sb.score(s, GOLD, integrity=1.0)
    assert r["critical_missed"] == ["G2"]
    assert r["uncapped"] > sb.CRITICAL_CAP
    assert r["total"] == sb.CRITICAL_CAP
    assert r["capped"] is True


@pytest.mark.l3_boundary
def test_critical_found_but_not_violation_counts_as_missed():
    s = perfect()
    s["checks"][0]["violation_label"] = "NO_VIOLATION"
    assert sb.score(s, GOLD, integrity=1.0)["critical_missed"] == ["G1"]


@pytest.mark.l1_functional
def test_unreviewed_finding_is_not_false_positive():
    """scoring_config: UNREVIEWED не отрицательный класс — лишняя находка вне эталона F1 не снижает."""
    s = perfect()
    extra = copy.deepcopy(s["checks"][0])
    extra["location"] = "999"
    s["checks"].append(extra)
    r = sb.score(s, GOLD, integrity=1.0)
    assert r["counts"] == {"tp": 3, "fp": 0, "fn": 0}
    assert r["unreviewed"] == 1
    assert r["components"]["finding_detection_f1"] == 1.0


@pytest.mark.l1_functional
def test_violation_on_verified_negative_is_false_positive():
    g = GOLD[:3] + [dict(GOLD[3], score_eligible=True)]
    s = perfect()
    s["checks"][3]["violation_label"] = "VIOLATION_PRESENT"
    r = sb.score(s, g, integrity=1.0)
    assert r["counts"] == {"tp": 3, "fp": 1, "fn": 0}
    assert r["unreviewed"] == 0
    assert r["components"]["finding_detection_f1"] == pytest.approx(6 / 7)


def _grouped():
    return [dict(GOLD[0], finding_group_id="GR-1"), dict(GOLD[1], finding_group_id="GR-1"), GOLD[2]]


@pytest.mark.l1_functional
def test_group_answer_covering_all_locations_counts_for_each():
    s = perfect()
    s["checks"] = [dict(s["checks"][0], location="140, 142"), s["checks"][2]]
    r = sb.score(s, _grouped(), integrity=1.0)
    assert r["counts"] == {"tp": 3, "fp": 0, "fn": 0}


@pytest.mark.l3_boundary
def test_partial_group_answer_is_not_credited():
    s = perfect()
    s["checks"] = [dict(s["checks"][0], location="140; 999"), s["checks"][2]]
    r = sb.score(s, _grouped(), integrity=1.0)
    assert r["counts"] == {"tp": 1, "fp": 0, "fn": 2}
    assert r["critical_missed"] == ["G1", "G2"]


@pytest.mark.l3_boundary
def test_group_answer_without_gold_groups_is_dropped():
    s = perfect()
    s["checks"] = [dict(s["checks"][0], location="140, 142")]
    assert sb.score(s, GOLD, integrity=1.0)["counts"]["tp"] == 0


@pytest.mark.l1_functional
def test_no_violation_prediction_is_not_a_finding():
    """Ответ «нарушения нет» на объекте без эталонного нарушения не ложноположителен."""
    s = perfect()
    s["checks"].append(
        {
            "parameter_code": "PZ-009",
            "location": "Отметка 0.000",
            "violation_label": "NO_VIOLATION",
            "evidence": [],
        }
    )
    assert sb.score(s, GOLD, integrity=1.0)["counts"]["fp"] == 0


@pytest.mark.l2_differential
@pytest.mark.parametrize(
    "pred, ref",
    [
        ("012", "12"),
        ("пом. 140", "140"),
        ("Помещение №142", "142"),
        ("  Фундаментная   плита ", "фундаментная плита"),
    ],
)
def test_location_normalization(pred, ref):
    assert sb.norm_location(pred) == sb.norm_location(ref)


@pytest.mark.l3_boundary
def test_location_distinct_rooms_stay_distinct():
    assert sb.norm_location("140") != sb.norm_location("1400")
    assert sb.norm_location("1-109") != sb.norm_location("1109")


@pytest.mark.l1_functional
def test_localization_is_file_and_page_not_bbox():
    s = perfect()
    s["checks"][0]["evidence"] = [
        {"stage": "PD", "file_id": "F1", "pdf_page_number": 3, "bbox": [0, 0, 1, 1]}
    ]
    r = sb.score(s, GOLD, integrity=1.0)
    # у G1 два эталонных листа, найден один: 0,5 на этой находке, 1 на двух других
    assert r["components"]["source_localization_exact_file_page"] == pytest.approx(
        (0.5 + 1 + 1) / 3
    )


@pytest.mark.l3_boundary
def test_wrong_page_gets_no_localization_credit():
    s = perfect()
    for e in s["checks"][0]["evidence"]:
        e["pdf_page_number"] += 1
    r = sb.score(s, GOLD, integrity=1.0)
    assert r["components"]["source_localization_exact_file_page"] == pytest.approx(
        2 / 3
    )


@pytest.mark.l1_functional
def test_value_and_status_accuracy():
    s = perfect()
    s["checks"][2]["protocol_status"] = "CRITICAL"  # эталон WARNING
    r = sb.score(s, GOLD, integrity=1.0)
    # у G3 из двух частей (метка, статус) верна одна: 0,5; у G1 и G2 — 1
    assert r["components"]["normalized_value_and_status_accuracy"] == pytest.approx(
        (1 + 1 + 0.5) / 3
    )


@pytest.mark.l3_boundary
def test_value_compared_after_normalization():
    g = [gold("G1", "KR-055", "плита", pd="B40", rd="B45")]
    s = {
        "object_id": "OBJ-SYNTH",
        "checks": [dict(g[0], pd_value=" в40 ", rd_value="B 45")],
    }
    s["checks"][0].pop("check_id")
    assert (
        sb.score(s, g, integrity=1.0)["components"][
            "normalized_value_and_status_accuracy"
        ]
        == 1.0
    )


@pytest.mark.l1_functional
def test_integrity_unmeasured_is_reported_not_invented():
    r = sb.score(perfect(), GOLD)
    assert r["components"]["document_integrity_and_split_handling"] is None
    assert r["total"] == 90.0
    assert r["max_measured"] == 90


@pytest.mark.l4_fault
def test_invalid_submission_is_refused():
    with pytest.raises(sb.SubmissionError):
        sb.score({"checks": []}, GOLD)


@pytest.mark.l4_fault
def test_duplicate_prediction_counts_once():
    s = perfect()
    s["checks"].append(copy.deepcopy(s["checks"][0]))
    r = sb.score(s, GOLD, integrity=1.0)
    assert r["counts"] == {"tp": 3, "fp": 0, "fn": 0}
    assert r["unreviewed"] == 0
