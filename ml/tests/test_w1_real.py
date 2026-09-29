"""T-180, OS-INSP-6.5.50–6.5.54: стенд W1 на реальных объектах — только синтетика (ни одного пути, хеша или текста
корпуса). Процессы (ML-сервис, API) не поднимаются: проверяется чистая часть — эталон, исходы, метрики с ДИ, барьер
агрегатов, протокол разметки, таблица и отбор файлов объекта из каталога."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from eval import w1_real as W
from eval import w1_real_score as S
from eval.w1_real_table import render

ROOT = Path(__file__).resolve().parents[2]
WAVE = json.loads((ROOT / "data/seed/w1-wave.json").read_text("utf-8"))


def lab(
    param="M-023",
    label="NEGATIVE_VERIFIED",
    source="verified",
    quality="final",
    operator=None,
    ref="T-129",
):
    return {
        "param": param,
        "operator": operator,
        "label": label,
        "source": source,
        "quality": quality,
        "ref": ref,
    }


def gold(obj="SYN-1", labels=None):
    return {
        "schema": S.GOLD_SCHEMA,
        "object_id": obj,
        "labels": labels if labels is not None else [lab()],
    }


# ─────────────────────────────── эталон (6.5.51)


def test_gold_valid_returns_labels():
    assert S.validate_gold(gold()) == [lab()]


@pytest.mark.parametrize(
    "bad",
    [
        {"schema": "x"},
        {"object_id": "Алтуфьевское 79Б"},
        {"labels": [lab(param="PZ-023")]},
        {"labels": [lab(operator="CMP-4")]},
        {"labels": [lab(label="CANDIDATE")]},
        {"labels": [lab(source="guess")]},
        {"labels": [lab(quality="maybe")]},
        {"labels": [lab(ref="Иванов И.И.")]},
    ],
)
def test_gold_rejects_non_codes_and_unknown_labels(bad):
    with pytest.raises(S.GoldError):
        S.validate_gold(gold() | bad)


def test_truth_priority_exact_operator_then_source_then_quality():
    labels = [
        lab(label="CONFIRMED_VIOLATION", source="manual"),
        lab(label="NEGATIVE_VERIFIED", source="organizer", quality="second_review"),
        lab(label="NEGATIVE_VERIFIED", source="organizer", quality="final"),
        lab(label="MISSING_EVIDENCE", source="manual", operator="CMP-04"),
    ]
    assert (
        S.truth_for(labels, "M-023", "CMP-04")["label"] == "MISSING_EVIDENCE"
    )  # метка оператора — первой
    got = S.truth_for(labels, "M-023", "CMP-26")
    assert (got["source"], got["quality"]) == ("organizer", "final")
    assert S.truth_for(labels, "M-001", "CMP-01") is None


def test_upsert_replaces_same_pair_and_source_only():
    g = gold(
        labels=[
            lab(),
            lab(source="manual", ref="labeler:ivan", label="CONFIRMED_VIOLATION"),
        ]
    )
    out = S.upsert_label(
        g, lab(source="manual", ref="labeler:petr", label="MISSING_EVIDENCE")
    )
    assert sorted((x["source"], x["label"]) for x in out["labels"]) == [
        ("manual", "MISSING_EVIDENCE"),
        ("verified", "NEGATIVE_VERIFIED"),
    ]
    with pytest.raises(S.GoldError):
        S.upsert_label(g, lab(label="WHATEVER"))


def test_organizer_checks_map_to_project_codes_and_quality():
    checks = [
        {
            "check_id": "C-1",
            "object_id": "OBJ-A",
            "parameter_id": 79,
            "violation_label": "VIOLATION_PRESENT",
            "gold_status": "FINAL_GOLD_EXISTENCE",
        },
        {
            "check_id": "C-2",
            "object_id": "OBJ-B",
            "parameter_id": "55",
            "violation_label": "NO_VIOLATION",
            "gold_status": "GOLD_READY_SECOND_REVIEW",
        },
        {
            "check_id": "C-3",
            "object_id": "OBJ-X",
            "parameter_id": 1,
            "violation_label": "NO_VIOLATION",
        },  # объект не наш
        {
            "check_id": "C-4",
            "object_id": "OBJ-A",
            "parameter_id": 2,
            "violation_label": "ODD",
        },  # метка вне словаря
        {
            "check_id": "C 5/..",
            "object_id": "OBJ-A",
            "parameter_id": 3,
            "violation_label": "MISSING_DOCUMENT",
        },
    ]
    out = S.organizer_labels(checks, {"OBJ-A": "SYN-1", "OBJ-B": "SYN-2"})
    assert [(x["param"], x["label"], x["quality"]) for x in out["SYN-1"]] == [
        ("M-079", "CONFIRMED_VIOLATION", "final"),
        ("M-003", "MISSING_EVIDENCE", "candidate"),
    ]
    assert out["SYN-2"][0]["quality"] == "second_review"
    for obj, labs in out.items():
        S.validate_gold(gold(obj, labs))  # ссылка на проверку организатора — годный код


# ─────────────────────────────── исходы и группы (6.5.52)


@pytest.mark.parametrize(
    "truth,pred,want",
    [
        ("CONFIRMED_VIOLATION", "CANDIDATE", "tp"),
        ("CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "fn"),
        ("CONFIRMED_VIOLATION", "NOT_COMPARABLE", "abst_pos"),
        ("CONFIRMED_VIOLATION", "NOT_APPLICABLE", "fn"),
        ("NEGATIVE_VERIFIED", "CANDIDATE", "fp"),
        ("NEGATIVE_VERIFIED", "NEGATIVE_VERIFIED", "tn"),
        ("NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED", "abst_neg"),
        ("NEGATIVE_VERIFIED", "NO_CHECK", "abst_neg"),
        ("MISSING_EVIDENCE", "MISSING_EVIDENCE", "other_ok"),
        ("MISSING_EVIDENCE", "NEGATIVE_VERIFIED", "other_bad"),
        ("NOT_APPLICABLE", "CANDIDATE", "fp_other"),
        (None, "CANDIDATE", "unlabeled"),
    ],
)
def test_outcome_matrix(truth, pred, want):
    assert S.outcome(truth, pred) == want


def test_w1_pairs_and_attribution():
    pairs = S.w1_pairs(WAVE)
    assert len({p for p, _ in pairs}) == 47
    assert ("M-001", "CMP-15") not in pairs  # оператор W2
    reg = {
        "params": [
            {"code": "M-004", "operator": "CMP-01", "wired": True},
            {"code": "M-002", "operator": "CMP-10", "wired": False},
        ]
    }
    attr = S.attribution(WAVE, reg)
    assert attr["M-004"] == "CMP-01"  # подключённая пара стенда мутаций
    assert attr["M-002"] == "CMP-02"  # не подключённая — первый оператор W1
    assert attr["M-023"] == "CMP-04"
    assert len(attr) == 47


def test_groups_no_check_and_non_final_label_is_unlabeled():
    labels = [
        lab(),
        lab(
            param="M-001",
            label="CONFIRMED_VIOLATION",
            quality="second_review",
            source="organizer",
            ref="organizer:C-1",
        ),
    ]
    gs = S.groups(
        "SYN-1",
        [{"code": "M-023", "status": "NEGATIVE_VERIFIED"}],
        ["M-023", "M-001", "M-999"],
        labels,
        {"M-023": "CMP-04", "M-001": "CMP-01"},
    )
    by = {g["param"]: g for g in gs}
    assert set(by) == {"M-023", "M-001"}  # параметр без оператора W1 не считается
    assert by["M-023"]["outcome"] == "tn"
    assert by["M-001"]["pred"] == "NO_CHECK"
    assert by["M-001"]["outcome"] == "unlabeled"
    assert by["M-001"]["truth_quality"] == "second_review"


def g(obj, outcome, param="M-023", op="CMP-04", pred="CANDIDATE"):
    return {
        "object": obj,
        "param": param,
        "operator": op,
        "pred": pred,
        "truth": None if outcome == "unlabeled" else "x",
        "truth_source": None,
        "truth_quality": None,
        "outcome": outcome,
    }


def test_cell_single_object_wilson():
    gs = (
        [g("A", "tp")] * 8
        + [g("A", "fn")] * 2
        + [g("A", "fp")]
        + [g("A", "tn")] * 9
        + [g("A", "abst_neg")]
    )
    c = S.cell(gs)
    assert c["ci_method"] == "wilson"
    assert (c["n_pos"], c["n_neg"]) == (10, 11)
    assert c["recall"] == 0.8
    assert c["precision"] == round(8 / 9, 4)
    assert c["fpr"] == round(1 / 11, 4)
    assert c["abstention"] == round(1 / 21, 4)
    assert c["recall_ci"] == [round(x, 4) for x in S.wilson(8, 10)]
    assert c["f1_ci"] is None  # на одном объекте интервала F1 нет


def test_cell_many_objects_bootstrap_and_no_labels():
    gs = [
        g("A", "tp"),
        g("A", "tn"),
        g("B", "fn"),
        g("B", "tn"),
        g("C", "tp"),
        g("C", "fp"),
    ]
    c = S.cell(gs, b=200)
    assert c["ci_method"] == "bootstrap"
    lo, hi = c["recall_ci"]
    assert 0 <= lo <= c["recall"] <= hi <= 1
    assert c["f1_ci"] is not None
    empty = S.cell(
        [
            g("A", "unlabeled", pred="MISSING_EVIDENCE"),
            g("A", "unlabeled", pred="CANDIDATE"),
        ]
    )
    assert empty["ci_method"] is None
    assert empty["recall"] is None and empty["recall_ci"] is None
    assert empty["pred_unlabeled"] == {"CANDIDATE": 1, "MISSING_EVIDENCE": 1}


def test_f1_edge_cases():
    from collections import Counter

    assert math.isnan(S.f1_of(Counter()))
    assert S.f1_of(Counter({"fp": 1, "fn": 1})) == 0.0


# ─────────────────────────────── барьер агрегатов (6.5.53)


def test_aggregate_passes_barrier_and_has_pair_operator_all():
    gs = [
        g("SYN-1", "tn"),
        g("SYN-1", "unlabeled", param="M-001", op="CMP-01", pred="MISSING_EVIDENCE"),
    ]
    a = S.aggregate(
        gs,
        {
            "object_id": "SYN-1",
            "codes": ["M-001", "M-023"],
            "timing": {"total_s": 1.5, "host": "Linux x86_64, ядер 32"},
        },
    )
    assert set(a["pairs"]) == {"M-023×CMP-04", "M-001×CMP-01"}
    assert set(a["operators"]) == {"CMP-04", "CMP-01"}
    assert a["all"]["n"] == 2
    json.dumps(a)


@pytest.mark.parametrize(
    "leak",
    [
        {"file_name": "ПЗ.pdf"},
        {"counts": {"files": "Раздел 1 ПЗ, лист 12"}},
        {"pairs": {"M-023×CMP-04": {"n": 1, "value": "С0"}}},
        {"pairs": {"M-023×CMP-04": {"n": 1, "precision": "не ниже С0"}}},
        {"objects": ["Алтуфьевское 79Б"]},
        {"timing": {"total_s": object()}},
    ],
)
def test_barrier_rejects_names_texts_and_values(leak):
    with pytest.raises(S.GoldError):
        S.assert_aggregate({"schema": S.AGG_SCHEMA} | leak)


def test_barrier_accepts_all_run_counts_and_timing_keys():
    """Все ключи, которые пишет прогон (w1_real.run), проходят барьер — иначе агрегат падает уже после прогона."""
    counts = {k: 1 for k in ("files", "importable", "junk", "duplicates", "accepted", "rejected", "cached_r4", "without_r4", "skipped_memory")}
    timing = {k: 1.0 for k in ("import_s", "pipeline_s", "total_s", "peak_rss_mb", "api_rss_mb")} | {"host": "Linux x86_64, ядер 32"}
    S.assert_aggregate({"counts": counts, "timing": timing, "rejected_codes": {"IMPORT_NOT_FOUND": 1}, "file_status": {"DONE": 3}, "stages": {"PD": 1, "RD": 2}})


def test_merge_aggregates_equals_counts_and_bootstraps_over_objects():
    a1 = S.aggregate([g("SYN-1", "tp"), g("SYN-1", "tn")], {"object_id": "SYN-1"})
    a2 = S.aggregate(
        [g("SYN-2", "fn"), g("SYN-2", "unlabeled", pred="MISSING_EVIDENCE")],
        {"object_id": "SYN-2"},
    )
    m = S.merge_aggregates([a1, a2], b=100)
    c = m["pairs"]["M-023×CMP-04"]
    assert (c["tp"], c["fn"], c["tn"], c["n_unlabeled"]) == (1, 1, 1, 1)
    assert c["ci_method"] == "bootstrap"
    assert m["objects"] == ["SYN-1", "SYN-2"]


# ─────────────────────────────── протокол разметки (6.5.54)


def api_result():
    ex = [
        {
            "file_id": "PD-aaaaaaaaaaaa",
            "file_sha256": "a" * 64,
            "stage": "PD",
            "code": "M-023",
            "raw": "С0",
            "value_num": None,
            "value_text": "С0",
            "page": 2,
            "bbox": [0, 0, 1, 1],
            "line_text": "класс конструктивной пожарной опасности С0",
            "confidence": 0.9,
            "excluded": None,
        },
        {
            "file_id": "RD-bbbbbbbbbbbb",
            "file_sha256": "b" * 64,
            "stage": "RD",
            "code": "M-023",
            "raw": "С1",
            "value_num": None,
            "value_text": "С1",
            "page": 1,
            "bbox": None,
            "line_text": "класс С1",
            "confidence": 0.8,
            "excluded": None,
        },
        {
            "file_id": "RD-bbbbbbbbbbbb",
            "file_sha256": "b" * 64,
            "stage": "RD",
            "code": "M-001",
            "raw": "100",
            "value_num": 100,
            "value_text": None,
            "page": 1,
            "bbox": None,
            "line_text": "площадь 100",
            "confidence": 0.8,
            "excluded": None,
        },
        {
            "file_id": "ID-cccccccccccc",
            "file_sha256": "c" * 64,
            "stage": "ID",
            "code": "M-023",
            "raw": "",
            "value_num": None,
            "value_text": None,
            "page": 1,
            "bbox": None,
            "line_text": None,
            "confidence": None,
            "excluded": None,
        },
    ]
    return {
        "object_id": "SYN-1",
        "extractions": ex,
        "rows": [{"code": "M-023", "status": "CANDIDATE"}],
    }


def test_mention_queue_teacher_format_real_split():
    q = S.mention_queue(
        api_result(),
        "M-023",
        {
            "M-023": {
                "parameter_name": "Класс",
                "section": "ПЗ",
                "unit": "",
                "data_type": "class",
            }
        },
        "train",
    )
    assert [x["stage"] for x in q] == [
        "PD",
        "RD",
    ]  # без строки — не упоминание; чужой параметр — мимо
    assert all(x["synthetic"] is False and x["split"] == "train" for x in q)
    assert len({x["item_id"] for x in q}) == 2
    assert q[0]["line_sha256"] != q[1]["line_sha256"]


def test_form_roundtrip_group_and_mentions():
    q = S.mention_queue(api_result(), "M-023", {}, "validation")
    text = S.form_csv(q, "M-023", "CMP-04", "CANDIDATE")
    rows = text.splitlines()
    assert rows[0].split(",")[0] == "kind" and len(rows) == 4
    import csv
    import io

    data = list(csv.DictReader(io.StringIO(text)))
    data[0] |= {"label": "CONFIRMED_VIOLATION", "labeler": "inspector1"}
    data[1] |= {
        "label": "ACCEPT",
        "rationale": "значение ПД на листе",
        "labeler": "inspector1",
    }
    data[2] |= {
        "label": "REJECT",
        "reason": "WRONG_VALUE",
        "correct_value": "С0",
        "rationale": "другой корпус",
        "labeler": "inspector1",
    }
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=S.FORM_FIELDS)
    w.writeheader()
    w.writerows(data)
    group, labels = S.import_form(buf.getvalue(), q, "SYN-1", "M-023", "CMP-04")
    assert group == {
        "param": "M-023",
        "operator": "CMP-04",
        "label": "CONFIRMED_VIOLATION",
        "source": "manual",
        "quality": "final",
        "ref": "labeler:inspector1",
    }
    assert [x["label"] for x in labels] == ["ACCEPT", "REJECT"]
    # пустые строки формы — разметка частями: пропускаются
    assert S.import_form(text, q, "SYN-1", "M-023", "CMP-04") == (None, [])


@pytest.mark.parametrize(
    "row,msg",
    [
        (
            {
                "kind": "group",
                "item_id": "M-023×CMP-04",
                "label": "MAYBE",
                "labeler": "a",
            },
            "метка группы",
        ),
        (
            {
                "kind": "group",
                "item_id": "M-001×CMP-01",
                "label": "NEGATIVE_VERIFIED",
                "labeler": "a",
            },
            "другой группы",
        ),
        (
            {
                "kind": "group",
                "item_id": "M-023×CMP-04",
                "label": "NEGATIVE_VERIFIED",
                "labeler": "Иванов",
            },
            "логин",
        ),
        (
            {
                "kind": "mention",
                "item_id": "nope",
                "label": "ACCEPT",
                "rationale": "x",
                "labeler": "a",
            },
            "строки очереди",
        ),
        (
            {
                "kind": "mention",
                "item_id": "@0",
                "label": "REJECT",
                "reason": "BAD",
                "rationale": "x",
                "labeler": "a",
            },
            "причина",
        ),
    ],
)
def test_form_rejects_bad_rows(row, msg):
    import csv
    import io

    q = S.mention_queue(api_result(), "M-023", {}, "train")
    if row["item_id"] == "@0":
        row["item_id"] = q[0]["item_id"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=S.FORM_FIELDS)
    w.writeheader()
    w.writerow(row)
    with pytest.raises(S.GoldError, match=msg):
        S.import_form(buf.getvalue(), q, "SYN-1", "M-023", "CMP-04")


# ─────────────────────────────── таблица и реестр источников


def test_sources_registry_codes_only_and_w1_params():
    src = json.loads((ROOT / "ml/eval/w1_real_sources.json").read_text("utf-8"))
    w1 = {p["code"] for p in WAVE["params"]}
    assert set(src["params"]) <= w1
    for code, rows in src["params"].items():
        for r in rows:
            assert r["source"] in S.SOURCES and r["quality"] in S.QUALITY
            assert all(S.OBJ_RE.match(o) for o in r["objects"]), (code, r["objects"])
    assert set(src["objects"]["organizer"].values()) <= set(src["objects"]["corpus"])


def test_table_marks_missing_gold_and_takes_mutation_columns():
    a = S.aggregate(
        [
            g("SYN-1", "tn"),
            g(
                "SYN-1",
                "unlabeled",
                param="M-001",
                op="CMP-01",
                pred="MISSING_EVIDENCE",
            ),
        ],
        {
            "object_id": "SYN-1",
            "approval": True,
            "parser_rev": 4,
            "extract_rev": 13,
            "git_sha": "abcdef1",
            "counts": {"cached_r4": 3, "without_r4": 1, "accepted": 3, "rejected": 0},
            "timing": {"total_s": 10.0, "peak_rss_mb": 900},
        },
    )
    mut = {
        "dataset_version": "mutations-w1:seed=7:scale=1.0:n=726",
        "parser_rev": 4,
        "extract_rev": 13,
        "slices": {
            "pair:M-023×CMP-04": {
                "n_pos": 100,
                "n_neg": 200,
                "precision": 1.0,
                "precision_ci": [0.96, 1.0],
                "recall": 0.9,
                "recall_ci": [0.83, 0.94],
                "f1": 0.95,
                "f1_ci": [0.9, 0.97],
                "fpr": 0.0,
                "fpr_ci": [0.0, 0.02],
                "abstention": 0.01,
                "abstention_ci": [0.0, 0.03],
            }
        },
    }
    src = {
        "params": {
            "M-023": [
                {
                    "source": "verified",
                    "objects": ["SYN-1"],
                    "pos": 0,
                    "neg": 1,
                    "quality": "final",
                }
            ]
        }
    }
    md = render([a], mut, WAVE, src, S.attribution(WAVE))
    row23 = next(x for x in md.splitlines() if x.startswith("| M-023 | CMP-04"))
    assert "100 / 200" in row23 and "0,90 [0,83; 0,94]" in row23
    assert "1 (+0/−1), объектов 1" in row23
    row01 = next(x for x in md.splitlines() if x.startswith("| M-001 | CMP-01"))
    assert (
        "нет эталона (групп 1: MISSING_EVIDENCE 1)" in row01
        and "нет — ручная разметка" in row01
    )
    assert "| SYN-1 | оператор | 3 / 4 | 0 |" in md
    assert "Окончательная метка хотя бы на одном объекте — 1" in md
    # без отчёта мутаций колонки пусты, строк столько же — по паре на оператор W1
    md2 = render([], None, WAVE, {"params": {}}, S.attribution(WAVE))
    assert sum(1 for x in md2.splitlines() if x.startswith("| M-")) == len(
        S.w1_pairs(WAVE)
    )
    assert "не прогонялся" in md2


# ─────────────────────────────── объект из каталога корпуса (6.5.50)


def test_catalog_files_formats_prefix_and_blob_presence(tmp_path, monkeypatch):
    (tmp_path / "catalog").mkdir()
    (tmp_path / "blobs").mkdir()
    rows = [
        {"path": "О/ПД/a.pdf", "sha256": "a" * 64, "bytes": 10},
        {
            "path": "О/ПД/a.dwg",
            "sha256": "b" * 64,
            "bytes": 10,
        },  # формат не разбирается
        {"path": "О/РД/c.PDF", "sha256": "c" * 64, "bytes": 10},
        {"path": "О/РД/d.pdf", "sha256": "d" * 64, "bytes": 10},  # блоба нет
        {"path": "Другой/ПД/e.pdf", "sha256": "e" * 64, "bytes": 10},
    ]
    (tmp_path / "catalog/99_синтетика.tar.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), "utf-8"
    )
    for s in "abce":
        (tmp_path / "blobs" / (s * 64)).write_bytes(b"x")
    monkeypatch.setattr(W, "CORPUS", tmp_path)
    monkeypatch.setattr(W, "EVAL", tmp_path / "eval")
    monkeypatch.setattr(
        W,
        "OBJECTS",
        {"SYN-1": {"archive": "99"}, "SYN-2": {"archive": "99", "prefix": "Другой/"}},
    )
    assert [f["sha256"][0] for f in W.catalog_files("SYN-1")] == ["a", "c", "e"]
    assert [f["sha256"][0] for f in W.catalog_files("SYN-2")] == ["e"]
    # справочник объектов на сервере дополняет встроенный
    (tmp_path / "eval").mkdir()
    (tmp_path / "eval/objects.json").write_text(
        json.dumps({"SYN-3": {"archive": "99", "prefix": "О/"}}), "utf-8"
    )
    assert [f["sha256"][0] for f in W.catalog_files("SYN-3")] == ["a", "c"]


def test_cached_r4_and_readonly_guard(tmp_path, monkeypatch):
    monkeypatch.setattr(W, "R4_CACHE", tmp_path)
    (tmp_path / f"parsed-{'a' * 64}-r4.json").write_text("{}")
    assert (
        W.cached_r4("a" * 64, 4)
        and not W.cached_r4("a" * 64, 5)
        and not W.cached_r4("b" * 64, 4)
    )
    monkeypatch.setattr(W, "CORPUS", tmp_path)
    (tmp_path / "blobs").mkdir()
    assert W.readonly(tmp_path) is False
    with pytest.raises(SystemExit, match="только на чтение"):
        W.require_readonly()


def test_ml_env_drops_shell_inspector_vars(monkeypatch, tmp_path):
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "vllm")
    monkeypatch.setenv("INSPECTOR_PROFILE", "gpu")
    env = W.ml_env("/cache", tmp_path)
    assert env["INSPECTOR_PROFILE"] == "dev" and "INSPECTOR_VLM_BACKEND" not in env
    assert (
        env["INSPECTOR_BLOB_DIR"].endswith("blobs")
        and env["INSPECTOR_ML_CACHE"] == "/cache"
    )


def test_free_port_above_40000():
    assert 40000 < W.free_port() <= 60000
