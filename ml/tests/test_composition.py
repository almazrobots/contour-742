"""Состав тестовой выборки по классам ТЗ §14.2 (OS-INSP-6.5.13–6.5.15, TZA-14.2-03).

Имя теста — то, на что ссылается трасса (docs/gera/inspector/model.yaml → impl).
"""

from __future__ import annotations

import pytest

from eval import composition as C
from eval import thresholds
from eval.run import to_markdown


def _gold(oid: str, *labels: str) -> dict:
    """Эталон объекта в форме gold.json: по группе на метку."""
    return {
        "object_id": oid,
        "evidence_groups": [
            {"evidence_group_id": f"{oid}:M-{i:03d}", "object_id": oid, "label": lb}
            for i, lb in enumerate(labels, 1)
        ],
    }


FULL = [
    _gold("A", "CANDIDATE", "CANDIDATE", "NEGATIVE_VERIFIED", "MISSING_EVIDENCE"),
    _gold("B", "CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "NOT_APPLICABLE"),
    _gold("C", "CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED"),
]


def _all_pass() -> dict:
    v = {
        "character_accuracy": 0.99,
        "exact_match": 0.95,
        "linkage": 0.99,
        "localization": 0.99,
        "precision": 0.95,
        "recall": 0.9,
        "f1": 0.92,
        "fpr": 0.02,
    }
    return {k: {"value": x, "n": 100, "ci": [x - 0.01, x + 0.01]} for k, x in v.items()}


# ─────────────────────────────────────────────── OS-INSP-6.5.13: состав по пяти классам


@pytest.mark.l1_functional
def test_composition_counts_groups_and_objects_per_class():
    comp = C.composition(FULL)
    assert list(comp["classes"]) == list(C.CLASSES)
    got = {k: (v["groups"], v["objects"]) for k, v in comp["classes"].items()}
    assert got == {
        "VIOLATION": (3, 2),  # CANDIDATE ×2 у A + CONFIRMED_VIOLATION у B
        "NEGATIVE_VERIFIED": (2, 2),
        "MISSING_EVIDENCE": (1, 1),
        "NOT_APPLICABLE": (1, 1),
        "CLARIFICATION_REQUIRED": (2, 1),
    }
    assert comp["n_groups"] == 9 and comp["n_objects"] == 3
    assert comp["unknown"] == {}
    assert C.missing_classes(comp) == []


@pytest.mark.l3_boundary
def test_composition_empty_sample_misses_all_five_classes():
    comp = C.composition([])
    assert comp["n_groups"] == 0 and comp["n_objects"] == 0
    assert all(v == {"groups": 0, "objects": 0} for v in comp["classes"].values())
    assert C.missing_classes(comp) == list(C.CLASSES)


@pytest.mark.l3_boundary
def test_missing_classes_min_groups_threshold():
    comp = C.composition(FULL)  # MISSING_EVIDENCE и NOT_APPLICABLE — по одной группе
    assert C.missing_classes(comp, min_groups=1) == []
    assert C.missing_classes(comp, min_groups=2) == [
        "MISSING_EVIDENCE",
        "NOT_APPLICABLE",
    ]
    assert C.missing_classes(comp, min_groups=3) == [
        "NEGATIVE_VERIFIED",
        "MISSING_EVIDENCE",
        "NOT_APPLICABLE",
        "CLARIFICATION_REQUIRED",
    ]


@pytest.mark.l6_adversarial
def test_composition_unknown_label_is_listed_not_silently_dropped():
    comp = C.composition(FULL + [_gold("D", "CANDIDATE", "WHATEVER", "WHATEVER", None)])
    assert comp["unknown"] == {"WHATEVER": 2, "None": 1}
    # неизвестная метка не попала ни в один класс: у D засчитан только CANDIDATE
    assert comp["classes"]["VIOLATION"] == {"groups": 4, "objects": 3}
    assert comp["n_groups"] == 13 and comp["n_objects"] == 4
    with pytest.raises(C.UnknownLabelError, match="WHATEVER"):
        C.class_of("WHATEVER")


@pytest.mark.l1_functional
def test_organizer_labels_map_to_same_classes():
    checks = [
        {
            "check_id": "c1",
            "finding_group_id": "g1",
            "object_id": "X",
            "violation_label": "VIOLATION_PRESENT",
        },
        {
            "check_id": "c2",
            "finding_group_id": "g1",
            "object_id": "X",
            "violation_label": "VIOLATION_PRESENT",
        },
        {
            "check_id": "c3",
            "finding_group_id": None,
            "object_id": "X",
            "violation_label": "NO_VIOLATION",
        },
        {
            "check_id": "c4",
            "finding_group_id": None,
            "object_id": "Y",
            "violation_label": "NO_VIOLATION",
        },
        {"check_id": "c5", "object_id": "Y", "violation_label": "MISSING_DOCUMENT"},
        {
            "check_id": "c6",
            "object_id": "Y",
            "violation_label": "COMPARISON_IMPOSSIBLE",
        },
    ]
    groups = C.organizer_groups(checks)
    assert [g["evidence_group_id"] for g in groups] == [
        "g1",
        "g1",
        "c3",
        "c4",
        "c5",
        "c6",
    ]
    comp = C.composition_of_groups(groups)
    got = {k: (v["groups"], v["objects"]) for k, v in comp["classes"].items()}
    assert got == {
        "VIOLATION": (1, 1),  # две проверки одной группы находок — одна группа
        "NEGATIVE_VERIFIED": (2, 2),
        "MISSING_EVIDENCE": (1, 1),
        "NOT_APPLICABLE": (0, 0),  # в метках организатора неприменимости нет
        "CLARIFICATION_REQUIRED": (1, 1),
    }
    assert C.missing_classes(comp) == ["NOT_APPLICABLE"]
    assert all(C.class_of(lb) == C.LABEL_CLASS[lb] for lb in C.LABEL_CLASS)


@pytest.mark.l1_functional
def test_label_dictionary_covers_domain_and_organizer_vocabularies():
    from eval.submission import VIOLATION_LABELS

    domain = {
        "CANDIDATE",
        "CONFIRMED_VIOLATION",
        "NEGATIVE_VERIFIED",
        "MISSING_EVIDENCE",
        "NOT_APPLICABLE",
        "CLARIFICATION_REQUIRED",
    }
    assert set(C.LABEL_CLASS) == domain | VIOLATION_LABELS
    assert set(C.LABEL_CLASS.values()) == set(C.CLASSES)


# ─────────────────────────────────────────────── OS-INSP-6.5.14: недостающий класс — «не принято»


@pytest.mark.l1_functional
def test_verdict_rejected_without_clarification_class_despite_passing_metrics():
    vd = thresholds.verdict(_all_pass())
    assert vd["verdict"] == thresholds.ACCEPTED  # метрики сами по себе проходят
    comp = C.composition([g for g in FULL if g["object_id"] != "C"])
    out = C.apply_composition(vd, comp)
    assert out["verdict"] == thresholds.REJECTED
    assert out["missing_classes"] == ["CLARIFICATION_REQUIRED"]
    assert "конфликт редакций" in out["composition_reason"]
    assert out["metrics"] == vd["metrics"] and out["failed"] == []  # метрики не тронуты
    assert vd["verdict"] == thresholds.ACCEPTED  # исходный вердикт не изменён на месте


@pytest.mark.l1_functional
def test_verdict_kept_when_all_classes_present():
    vd = thresholds.verdict(_all_pass())
    out = C.apply_composition(vd, C.composition(FULL))
    assert out["verdict"] == thresholds.ACCEPTED
    assert out["missing_classes"] == [] and out["composition_reason"] is None
    bad = _all_pass()
    bad["fpr"]["value"] = 0.2
    out = C.apply_composition(thresholds.verdict(bad), C.composition(FULL))
    assert out["verdict"] == thresholds.REJECTED and out["failed"] == ["fpr"]


@pytest.mark.l3_boundary
def test_verdict_empty_sample_names_all_five_classes():
    out = C.apply_composition(thresholds.verdict(_all_pass()), C.composition([]))
    assert out["verdict"] == thresholds.REJECTED
    assert out["missing_classes"] == list(C.CLASSES)
    for cls in C.CLASSES:
        assert C.TITLES[cls] in out["composition_reason"]


@pytest.mark.l6_adversarial
def test_verdict_rejected_on_unknown_label():
    comp = C.composition(FULL + [_gold("D", "FOO")])
    out = C.apply_composition(thresholds.verdict(_all_pass()), comp)
    assert out["verdict"] == thresholds.REJECTED and out["missing_classes"] == []
    assert "FOO" in out["composition_reason"]


# ─────────────────────────────────────────────── OS-INSP-6.5.15: состав рядом с метриками в отчёте


@pytest.mark.l1_functional
def test_composition_markdown_table_rows():
    comp = C.composition(FULL + [_gold("D", "FOO")])
    md = "\n".join(C.markdown(comp, ["CLARIFICATION_REQUIRED"]))
    assert "## Состав выборки" in md and "| Класс | Групп | Объектов |" in md
    assert "| Подтверждённые нарушения | 3 | 2 |" in md
    assert "| Неизвестная метка `FOO` | 1 | — |" in md
    assert "Нет класса: конфликт редакций" in md
    assert "Нет класса" not in "\n".join(C.markdown(C.composition(FULL), []))


@pytest.mark.l1_functional
def test_acceptance_markdown_publishes_composition_next_to_metrics():
    vd = C.apply_composition(thresholds.verdict(_all_pass()), C.composition(FULL[:2]))
    o = {
        "value": 0.9,
        "ci": [0.8, 0.95],
        "n": 10,
        "unit": "групп",
        "objects": 3,
        "coverage": 1.0,
    }
    report = {
        "generated": "2026-09-27",
        "disclaimer": "тест",
        "dataset_version": ["t"],
        "n_objects": 2,
        "matrix_version": "m",
        "input_manifest_hash": "0" * 32,
        "model_version": "v",
        "bootstrap": {"B": 10, "seed": 1},
        "resources": {
            k: 0
            for k in (
                "pipeline_wall_s",
                "total_wall_s",
                "pages",
                "ocr_pages",
                "peak_rss_mb_python",
                "peak_rss_mb_children",
            )
        },
        "overall": {
            m: o
            for m in list(thresholds.THRESHOLDS)
            + [
                "cer",
                "wer",
                "character_accuracy_scans_all_dpi",
                "cer_scans_all_dpi",
                "character_accuracy_all_pages",
                "cer_all_pages",
                "fpr_superseded",
                "other_status_accuracy",
                "low_quality_share",
            ]
        },
        "verdict": vd,
        "slices": {"object": {}, "section": {}, "type": {}, "param": {}},
        "composition": C.composition(FULL[:2]),
    }
    md = to_markdown(report)
    assert "## Вердикт: **НЕ ПРИНЯТО**" in md
    assert "## Состав выборки" in md and "Нет класса: конфликт редакций" in md
    assert md.index("## Состав выборки") < md.index("## Справочные метрики")


# ─────────────────────────────────────────────── реальная выборка: фабрика v3


@pytest.fixture(scope="session")
def v3_golds(tmp_path_factory):
    from synth import factory_v3

    # пять объектов первой группы: обычные ×3, неприменимость, конфликт редакций (~5 с на объект)
    return factory_v3.build(seed=1, out=tmp_path_factory.mktemp("v3"), n=5)


@pytest.mark.l2_differential
def test_factory_v3_five_objects_cover_all_classes(v3_golds):
    comp = C.composition(v3_golds)
    assert comp["unknown"] == {} and C.missing_classes(comp) == []
    got = {k: v["objects"] for k, v in comp["classes"].items()}
    assert got == {
        "VIOLATION": 3,
        "NEGATIVE_VERIFIED": 4,
        "MISSING_EVIDENCE": 3,
        "NOT_APPLICABLE": 1,
        "CLARIFICATION_REQUIRED": 1,
    }
    assert comp["n_objects"] == 5
    assert comp["n_groups"] == sum(len(g["evidence_groups"]) for g in v3_golds)
    assert comp["classes"]["CLARIFICATION_REQUIRED"]["groups"] == len(
        v3_golds[4]["evidence_groups"]
    )
