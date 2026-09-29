"""Оценка стенда мутаций (T-179, OS-INSP-6.5.45–6.5.49): QA-05 P/R/F1 с ДИ и воздержаниями, QA-06 FPR на отрицательных
и на устаревших редакциях, QA-07 регресс-гейт, метки в формате эталона судьи T-156."""

from __future__ import annotations

import copy
import sys

import pytest

from eval import mutation_score as S
from teacher.labels import sft_record, validate


def T(
    case,
    code="M-023",
    op="CMP-04",
    pol="pos",
    mut="MUT-06",
    target=True,
    tags=(),
    pending=False,
    expected=None,
    evidence=None,
):
    return {
        "case_id": case,
        "code": code,
        "operator": op,
        "polarity": pol,
        "mutation": mut,
        "variant": "v",
        "target": target,
        "tags": list(tags),
        "pending": pending,
        "requires": [],
        "expected": expected
        or {"pos": ["CANDIDATE"], "neg": ["NEGATIVE_VERIFIED"]}.get(
            pol, ["CLARIFICATION_REQUIRED"]
        ),
        "pd_value": "С0",
        "rd_value": "С1",
        "evidence": evidence or [],
        "wired": True,
    }


def R(case, code, status, frags=()):
    return {
        "case_id": case,
        "ms": 10,
        "files": [{"file_id": f"{case}-pd1", "parse_status": "DONE"}],
        "rows": [
            {
                "code": code,
                "status": status,
                "expected": "С0",
                "actual": "С1",
                "reason": "r",
                "fragments": list(frags),
            }
        ],
    }


def DS(truth):
    return {
        "dataset_version": "mutations-w1:seed=1",
        "registry_sha256": "abc",
        "cases": [{"case_id": c} for c in sorted({t["case_id"] for t in truth})],
        "truth": truth,
    }


@pytest.mark.l1_functional
def test_outcome_counts_tp_fn_fp_tn_abstention_and_superseded_trap():
    assert S.outcome(T("a"), "CANDIDATE")["tp"] == 1
    c = S.outcome(T("a"), "MISSING_EVIDENCE")
    assert (
        c["fn"] == 1 and c["abst"] == 1
    )  # воздержание на положительном — промах Recall
    assert S.outcome(T("a", pol="neg"), "CANDIDATE")["fp"] == 1
    c = S.outcome(T("a", pol="neg", tags=["superseded"]), "CANDIDATE")
    assert (c["fp"], c["fp_stale"], c["neg_stale"]) == (1, 1, 1)
    c = S.outcome(T("a", pol="neg", tags=["superseded"]), "NEGATIVE_VERIFIED")
    assert (c["tn"], c["fp_stale"], c["neg_stale"], c["status_ok"]) == (1, 0, 1, 1)
    c = S.outcome(T("a", pol="other"), "CLARIFICATION_REQUIRED")
    assert (c["other"], c["status_ok"], c["pos"], c["neg"]) == (1, 1, 0, 0)
    c = S.outcome(T("a"), None)
    assert (
        c["fn"] == 1 and c["abst"] == 1 and c["status_ok"] == 0
    )  # проверки нет вовсе — промах, а не пропуск


@pytest.mark.l1_functional
def test_summarize_precision_recall_fpr_with_wilson_and_bootstrap_f1():
    truth = [T(f"p{i}") for i in range(8)] + [T(f"n{i}", pol="neg") for i in range(10)]
    api = {
        "results": [
            R(f"p{i}", "M-023", "CANDIDATE" if i < 6 else "NOT_COMPARABLE")
            for i in range(8)
        ]
        + [
            R(f"n{i}", "M-023", "CANDIDATE" if i < 1 else "NEGATIVE_VERIFIED")
            for i in range(10)
        ]
    }
    rep = S.score(DS(truth), api, b=200)
    s = rep["slices"]["op:CMP-04"]
    assert (s["tp"], s["fn"], s["fp"], s["tn"]) == (6, 2, 1, 9)
    assert (
        s["precision"] == round(6 / 7, 4)
        and s["recall"] == 0.75
        and s["fpr"] == 0.1
        and s["abstention"] == round(2 / 18, 4)
    )
    lo, hi = s["recall_ci"]
    assert lo < 0.75 < hi and 0 <= lo and hi <= 1
    assert s["f1_ci"][0] <= s["f1"] <= s["f1_ci"][1]
    assert set(rep["slices"]) >= {
        "all",
        "op:CMP-04",
        "pair:M-023×CMP-04",
        "mut:MUT-06",
        "target:MUT-06",
    }
    assert len(rep["defects"]) == 3  # два промаха и одна ложная тревога — с примерами
    assert S.summarize({})["precision"] is None and S.summarize({})["recall_ci"] is None


@pytest.mark.l1_functional
def test_pending_pairs_are_reported_but_not_in_metrics():
    truth = [T("a"), T("a", code="M-109", op="CMP-04x", pending=True, pol="pos")]
    rep = S.score(
        DS(truth),
        {
            "results": [
                {
                    **R("a", "M-023", "CANDIDATE"),
                    "rows": [
                        {"code": "M-023", "status": "CANDIDATE", "fragments": []},
                        {
                            "code": "M-109",
                            "status": "NEGATIVE_VERIFIED",
                            "fragments": [],
                        },
                    ],
                }
            ]
        },
    )
    assert rep["slices"]["all"]["n"] == 1
    ((k, v),) = rep["pending"].items()
    assert "M-109" in k and v["n"] == 1 and v["наблюдено NEGATIVE_VERIFIED"] == 1


@pytest.mark.l3_boundary
def test_localization_needs_rd_fragment_same_file_page_and_iou():
    ev = [
        {
            "stage": "RD",
            "file_id": "a-rd1",
            "page": 2,
            "bbox": [0.5, 0.5, 0.6, 0.52],
            "raw": "1",
        }
    ]
    t = T("a", evidence=ev)
    good = {
        "fragments": [
            {
                "stage": "RD",
                "file_id": "a-rd1",
                "page": 2,
                "bbox": [0.5, 0.5, 0.6, 0.52],
            }
        ]
    }
    assert S.localized(t, good)
    for bad in (
        {"stage": "RD", "file_id": "a-rd1", "page": 1, "bbox": [0.5, 0.5, 0.6, 0.52]},
        {"stage": "RD", "file_id": "a-rd2", "page": 2, "bbox": [0.5, 0.5, 0.6, 0.52]},
        {"stage": "RD", "file_id": "a-rd1", "page": 2, "bbox": [0.1, 0.1, 0.2, 0.12]},
        {"stage": "PD", "file_id": "a-rd1", "page": 2, "bbox": [0.5, 0.5, 0.6, 0.52]},
        {"stage": "RD", "file_id": "a-rd1", "page": 2, "bbox": None},
    ):
        assert not S.localized(t, {"fragments": [bad]})
    assert not S.localized(t, None)


def _report(recall=1.0, fpr=0.0, fpr_sup=0.0, ds="mutations-w1:seed=1", failed=()):
    s = {
        "n_pos": 10,
        "n_neg": 50,
        "recall": recall,
        "fpr": fpr,
        "fpr_superseded": fpr_sup,
        "precision": 1.0,
    }
    return {
        "dataset_version": ds,
        "registry_sha256": "abc",
        "parser_rev": 4,
        "extract_rev": 13,
        "failed_cases": list(failed),
        "slices": {
            "all": dict(s),
            "op:CMP-04": dict(s),
            "pair:M-023×CMP-04": dict(s),
            "target:MUT-06": dict(s),
            "mut:MUT-06": dict(s),
        },
    }


@pytest.mark.l3_boundary
def test_gate_fails_on_recall_drop_or_fpr_rise_over_2pp():
    base = S.baseline_of(_report(recall=0.9, fpr=0.05, fpr_sup=0.0))
    assert sorted(base["categories"]) == [
        "all",
        "op:CMP-04",
        "pair:M-023×CMP-04",
        "target:MUT-06",
    ]  # «mut:» — не обязательная
    assert S.gate(_report(recall=0.9, fpr=0.05), base) == []
    assert (
        S.gate(_report(recall=0.95, fpr=0.069), base) == []
    )  # рост FPR 1,9 п.п. — в допуске
    fails = S.gate(_report(recall=0.89, fpr=0.05), base)
    assert fails and all("Recall" in f for f in fails)
    assert any("FPR" in f for f in S.gate(_report(recall=0.9, fpr=0.071), base))
    assert any(
        "FPR_SUPERSEDED" in f
        for f in S.gate(_report(recall=0.9, fpr=0.05, fpr_sup=0.03), base)
    )
    assert any(
        "не совпадает с базовой" in f
        for f in S.gate(_report(recall=0.9, fpr=0.05, ds="other"), base)
    )
    assert any(
        "отказом" in f
        for f in S.gate(_report(recall=0.9, fpr=0.05, failed=[{"case_id": "x"}]), base)
    )
    gone = _report(recall=0.9, fpr=0.05)
    del gone["slices"]["op:CMP-04"]
    assert any("категории нет" in f for f in S.gate(gone, base))
    none = _report(recall=0.9, fpr=0.05)
    none["slices"]["op:CMP-04"]["recall"] = None
    assert any("Recall None" in f for f in S.gate(none, base))


@pytest.mark.l1_functional
def test_judge_export_is_teacher_format_accept_reject_and_train_only():
    ds = {
        "cases": [
            {
                "case_id": "c1",
                "files": [
                    {
                        "file_id": "c1-rd1",
                        "file_name": "Р.pdf",
                        "sha256": "s" * 64,
                        "doc_stage": "RD",
                        "truth_values": {"M-023": "С1", "M-001": 1234.5},
                    }
                ],
            }
        ],
        "truth": [],
    }
    ex = [
        {
            "file_id": "c1-rd1",
            "code": "M-023",
            "raw": "C1",
            "value_num": None,
            "value_text": "C1",
            "page": 1,
            "bbox": [0, 0, 1, 1],
            "line_text": "класс — C1",
            "confidence": 1.0,
        },
        {
            "file_id": "c1-rd1",
            "code": "M-001",
            "raw": "1234,6",
            "value_num": 1234.6,
            "value_text": None,
            "page": 2,
            "bbox": None,
            "line_text": "Площадь застройки 1234,6",
            "confidence": 1.0,
        },
        {
            "file_id": "c1-rd1",
            "code": "M-999",
            "raw": "1",
            "value_num": 1,
            "value_text": None,
            "page": 2,
            "bbox": None,
            "line_text": "x",
            "confidence": 1.0,
        },
    ]
    queue, labels = S.judge_items(
        ds,
        {"results": [{"case_id": "c1", "extractions": ex}]},
        {"M-023": {"parameter_name": "Класс", "unit": "", "section": "Р1"}},
    )
    assert [x["label"] for x in labels] == ["ACCEPT", "REJECT"]
    assert (
        labels[1]["reason"] == "WRONG_VALUE" and labels[1]["correct_value"] == "1234.5"
    )
    by = {q["item_id"]: q for q in queue}
    for lab in labels:
        validate(
            lab, by[lab["item_id"]]
        )  # формат учителя T-076/T-156 — та же проверка, что при выпуске набора
        rec = sft_record(by[lab["item_id"]] | lab)
        assert (
            rec["messages"][-1]["role"] == "assistant"
            and rec["meta"]["split"] == "train"
        )
    assert all(
        q["synthetic"] and q["split"] == "train" for q in queue
    )  # OS-INSP-6.4.16: синтетика не идёт в test


@pytest.mark.l1_functional
def test_decisions_and_markdown_sections():
    truth = [T("a"), T("b", pol="neg"), T("c", pol="other", pending=True)]
    api = {
        "results": [
            R("a", "M-023", "CANDIDATE"),
            R("b", "M-023", "NEGATIVE_VERIFIED"),
            R("c", "M-023", "CANDIDATE"),
        ]
    }
    dec = S.decisions(DS(truth), api)
    assert [(d["object"], d["decision"], d["system_status"]) for d in dec] == [
        ("a", "CONFIRMED_VIOLATION", "CANDIDATE"),
        ("b", "NEGATIVE_VERIFIED", "NEGATIVE_VERIFIED"),
    ]
    md = S.markdown(S.score(DS(truth), api))
    for h in (
        "## По оператору",
        "## По паре",
        "## По типу мутации",
        "## Итог",
        "## Ожидает оператора",
        "Локализация",
    ):
        assert h in md
    assert "| CMP-04 | 1 | 1 |" in md


@pytest.mark.l4_fault
def test_failed_parse_or_error_case_is_listed():
    api = {
        "results": [
            {"case_id": "a", "ms": 0, "files": [], "rows": [], "error": "boom"},
            {
                "case_id": "b",
                "ms": 5,
                "files": [{"file_id": "b-pd1", "parse_status": "FAILED"}],
                "rows": [],
            },
        ]
    }
    rep = S.score(DS([T("a"), T("b")]), api)
    assert [x["case_id"] for x in rep["failed_cases"]] == ["a", "b"]
    assert rep["slices"]["all"]["fn"] == 2
    rep2 = copy.deepcopy(rep)
    assert S.gate(rep2, S.baseline_of(rep))[0].startswith("примеров с отказом")


@pytest.mark.l1_functional
def test_baseline_file_roundtrip_and_gate_command(tmp_path):
    from eval import mutation_run as M

    path = tmp_path / "w1-mutations.json"
    rev = M.revisions()  # текущие PARSER_REV/EXTRACT_REV, а не зашитые числа
    rep = _report(recall=0.9, fpr=0.05) | rev
    key = f"light@parser{rev['parser_rev']}"
    nomain = {}  # изолируем от настоящей базовой линии main: проверяется файл ветки
    assert M.cmd_gate("light", rep, path, nomain) == 2  # базовой линии нет — гейт не молчит
    M.cmd_baseline("light", rep, path)
    assert (
        M.load_baseline(path)["profiles"][key]["dataset_version"]
        == rep["dataset_version"]
    )
    assert M.load_baseline(path)["profiles"][key]["parser_rev"] == rev["parser_rev"]
    assert M.cmd_gate("light", rep, path, nomain) == 0
    assert M.cmd_gate("light", _report(recall=0.8, fpr=0.05) | rev, path, nomain) == 1
    assert M.cmd_gate("full", rep, path, nomain) == 2


@pytest.mark.l3_boundary
def test_ml_port_is_random_above_40000():
    import random

    from eval import mutation_run as M

    assert all(40000 < M.free_port(random.Random(i)) <= 60000 for i in range(5))


@pytest.mark.l1_functional
def test_api_reads_checks_of_every_registry_param():
    from eval import mutation_run as M
    from synth import mutations as G

    reg = G.load_registry()
    assert M.registry_codes(reg) == [
        "M-001",
        "M-002",
        "M-003",
        "M-004",
        "M-005",
        "M-007",
        "M-010",
        "M-023",
        "M-077",
        "M-109",
        "M-125",
    ]
    reg["params"].append(
        {**reg["params"][0], "code": "M-021"}
    )  # новый параметр в реестре — прогон читает и его проверку
    assert "M-021" in M.registry_codes(reg)


@pytest.mark.l2_differential
@pytest.mark.skipif(
    bool(__import__("os").environ.get("MUTANT_UNDER_TEST")),
    reason="процессы ML и API — не под mutmut",
)
def test_bench_end_to_end_through_ml_service_and_api(tmp_path):
    """Сквозной прогон стенда: генератор → ML-сервис (uvicorn, HTTP /analyze) → API (ingest, разбор, пересчёт) → отчёт.
    Четыре примера лёгкого профиля: положительный MUT-05 по М-001 находится и локализуется, соседние параметры — нет."""
    from eval import mutation_run as M

    if not M.TSX.exists():
        pytest.skip("нет apps/api/node_modules — pnpm install")
    rep = M.run("light", tmp_path / "run", parallel=2, limit=4, bootstrap=50)
    assert rep["cases"] == 4 and rep["failed_cases"] == []
    s = rep["slices"]["pair:M-001×CMP-01"]
    assert s["tp"] >= 1 and s["fn"] == 0 and rep["slices"]["all"]["fp"] == 0
    assert rep["localization"]["localized"] == rep["localization"]["tp"] >= 1
    assert (
        (tmp_path / "run/report.md")
        .read_text("utf-8")
        .startswith("# Стенд мутаций L11")
    )
    assert (
        rep["judge_export"]["items"] > 0 and (tmp_path / "run/judge/sft.jsonl").exists()
    )
    assert rep["timing"]["pipeline_s"] > 0 and rep["timing"]["children_peak_rss_mb"] > 0


@pytest.mark.l6_adversarial
def test_teacher_release_keeps_synthetic_in_train_and_refuses_it_in_holdout():
    """OWASP T179-4, OS-INSP-6.4.16: выпуск набора сам ставит синтетике train, а синтетический объект в test — отказ."""
    from teacher.labels import LabelError, release, split_of

    obj = next(
        f"MUT-7-{i:04d}"
        for i in range(1000)
        if split_of(f"MUT-7-{i:04d}", set()) == "validation"
    )  # по хешу ушёл бы в validation
    q = {
        "item_id": "i1",
        "object": obj,
        "file_sha256": "a" * 64,
        "line_sha256": "l",
        "synthetic": True,
        "code": "M-001",
    }
    lab = {
        "item_id": "i1",
        "label": "ACCEPT",
        "reason": None,
        "rationale": "мутация",
        "labeler": "генератор",
        "line_sha256": "l",
    }
    ds = release([q], [lab], {"Реальный объект"}, "куратор")
    assert ds["items"][0]["split"] == "train" and obj in ds["objects"]["train"]
    with pytest.raises(LabelError, match="синтетический объект"):
        release([q], [lab], {obj}, "куратор")
    with pytest.raises(LabelError, match="синтетический объект"):
        release([q], [lab], set(), "куратор", validation={obj})


@pytest.mark.l6_adversarial
def test_run_dir_foreign_nonempty_is_refused_not_deleted(tmp_path):
    """OWASP T179-1: опечатка в --out не удаляет чужой каталог; прежний прогон стенда — очищается."""
    from eval import mutation_run as M

    foreign = tmp_path / "src"
    foreign.mkdir()
    (foreign / "main.py").write_text("x")
    with pytest.raises(RuntimeError, match="не удаляю"):
        M.prepare_run_dir(foreign)
    assert (foreign / "main.py").exists()
    (foreign / "dataset.json").write_text('{"schema": "other/1"}')
    with pytest.raises(RuntimeError):
        M.prepare_run_dir(foreign)
    ours = tmp_path / "run"
    ours.mkdir()
    (ours / "dataset.json").write_text('{"schema": "inspector-mutations/1"}')
    assert not M.prepare_run_dir(ours).exists()
    assert M.prepare_run_dir(tmp_path / "new") == (tmp_path / "new").resolve()


@pytest.mark.l4_fault
def test_ml_service_start_failure_stops_process_group(tmp_path, monkeypatch):
    """OWASP T179-2: сервис не ответил за отведённое время — группа процессов погашена, порт не держится."""
    import subprocess

    from eval import mutation_run as M

    started = []
    real = subprocess.Popen

    def spy(*a, **k):
        p = real(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            start_new_session=k.get("start_new_session", False),
        )
        started.append(p)
        return p

    monkeypatch.setattr(M.subprocess, "Popen", spy)
    with pytest.raises(RuntimeError, match="не ответил"):
        M.start_ml(tmp_path, M.free_port(), wait_s=0.5)
    assert started and started[0].poll() is not None
    M.stop(started[0])  # повторная остановка — без ошибки


@pytest.mark.l6_adversarial
def test_child_env_drops_inspector_settings_from_shell(monkeypatch):
    """OWASP T179-5: S3-бакет и профиль gpu из shell не доходят до ML и API стенда."""
    from eval import mutation_run as M

    monkeypatch.setenv("INSPECTOR_BLOB_STORE", "s3")
    monkeypatch.setenv("INSPECTOR_S3_BUCKET", "nadzorium")
    env = M.clean_env({"INSPECTOR_PROFILE": "dev"})
    assert env["INSPECTOR_PROFILE"] == "dev" and not [
        k for k in env if "S3" in k or k == "INSPECTOR_BLOB_STORE"
    ]
    assert "PATH" in env


@pytest.mark.l6_adversarial
def test_gate_also_checks_main_baseline_so_branch_cannot_loosen_it(tmp_path):
    """OWASP T179-3: ветка переписала базовую линию под худший Recall — сверка с main всё равно роняет гейт."""
    from eval import mutation_run as M

    path = tmp_path / "b.json"
    worse = _report(recall=0.7, fpr=0.05)
    M.cmd_baseline("full", worse, path)  # «храповик назад» в ветке
    main = {
        "profiles": {
            "full@parser4": S.baseline_of(
                _report(recall=0.9, fpr=0.05, ds="mutations-w1:seed=7:n=700")
            )
        }
    }
    assert M.cmd_gate("full", worse, path, main=main) == 1
    assert (
        M.cmd_gate("full", _report(recall=0.9, fpr=0.05), path, main=main) == 0
    )  # другой набор ветки — не причина
    assert M.cmd_gate("full", worse, path, main=None) == 0


@pytest.mark.l1_functional
def test_modifier_is_its_own_mutation_slice_and_rescore_rebuilds_report(tmp_path):
    from eval import mutation_run as M

    truth = [T("a", mut="MUT-06", pol="neg", tags=["superseded"]), T("b")]
    ds = DS(truth)
    ds["cases"] = [
        {"case_id": "a", "modifier": "MUT-18/stale"},
        {"case_id": "b", "modifier": None},
    ]
    api = {
        "results": [R("a", "M-023", "NEGATIVE_VERIFIED"), R("b", "M-023", "CANDIDATE")]
    }
    rep = S.score(ds, api)
    assert "mut:MUT-18/stale" in rep["slices"] and rep["slices"]["mut:MUT-06"]["n"] == 1
    assert S.mutation_label({"mutation": "MUT-05"}, None) == "MUT-05"
    for name, x in (("dataset.json", ds), ("api.json", api)):
        (tmp_path / name).write_text(__import__("json").dumps(x), "utf-8")
    again = M.rescore(tmp_path, "light")
    assert again["slices"] == rep["slices"] and (tmp_path / "report.md").exists()


@pytest.mark.l3_boundary
def test_parser_revision_change_is_new_baseline_row_not_false_failure(tmp_path, capsys):
    """Координатор T-171: смена PARSER_REV (T-184) — отдельная строка базовой линии; без неё гейт не падает, а сравнивает
    с прежней ревизией справочно."""
    from eval import mutation_run as M

    path = tmp_path / "b.json"
    M.cmd_baseline("full", _report(recall=0.9, fpr=0.05), path)
    new = _report(recall=0.7, fpr=0.05) | {"parser_rev": 5}
    assert M.cmd_gate("full", new, path, main=None) == 0
    err = capsys.readouterr().err
    assert "full@parser5 нет" in err and "Recall 0.7" in err
    M.cmd_baseline("full", new, path)
    assert sorted(M.load_baseline(path)["profiles"]) == ["full@parser4", "full@parser5"]
    assert (
        M.cmd_gate(
            "full", new | {"slices": _report(recall=0.6)["slices"]}, path, main=None
        )
        == 1
    )
    assert M.baseline_key("light", {"parser_rev": 4}) == "light@parser4"
    assert set(M.revisions()) == {"parser_rev", "extract_rev"}


@pytest.mark.l1_functional
def test_facets_explain_errors_by_wording_and_side_by_side_table():
    """Разбор adversarial: ошибка привязана к признакам формулировки документа; сводка — строки двух профилей рядом."""
    st = {"q": {"M-001": {"layout": "inline", "fmt": "nbsp", "label": "Пятно застройки", "unit": "кв.м", "ocr2": "glue_words"}}, "cls": {}, "distractor": False}
    case = {"case_id": "a", "rd_current": ["a-rd1"], "files": [{"file_id": "a-pd1", "doc_stage": "PD", "style": st}, {"file_id": "a-rd1", "doc_stage": "RD", "style": st}, {"file_id": "a-rd0", "doc_stage": "RD", "style": st}]}
    t = T("a", code="M-001", op="CMP-01", pol="pos", mut="MUT-05")
    fs = S.facets(t, case)
    assert "M-001 · ПД раскладка inline" in fs and "M-001 · РД шум glue_words" in fs and len([f for f in fs if f.startswith("M-001 · РД")]) == 5
    assert S.facets(t, None) == [] and S.facets(t, {"files": [{"file_id": "x", "doc_stage": "PD", "style": None}]}) == []
    ds = DS([t])
    ds["cases"] = [case]
    rep = S.score(ds, {"results": [R("a", "M-001", "MISSING_EVIDENCE")]})
    assert rep["facets"]["M-001 · РД раскладка inline"] == {"n": 1, "err": 1, "err_rate": 1.0}
    md = S.markdown(rep)
    assert "## Разбор по формулировкам" in md and "| M-001 · ПД раскладка inline | 1 | 1 |" in md
    other = S.score(DS([T("b", code="M-001", op="CMP-01")]), {"results": [R("b", "M-001", "CANDIDATE")]})
    side = S.side_by_side({"structural": other, "adversarial": rep})
    assert "| CMP-01 | structural |" in side and "| CMP-01 | adversarial |" in side


@pytest.mark.l3_boundary
def test_f1_edges_and_decision_rows_exact():
    from collections import Counter as C

    assert S._f1(C({"tp": 2, "fp": 2, "pos": 4})) == 0.5
    assert S._f1(C({"tp": 0, "fp": 1, "pos": 0})) == 0.0 and S._f1(C({"tp": 0, "pos": 3})) == 0.0
    import math

    assert math.isnan(S._f1(C()))
    truth = [T("a", pol="other", expected=["CLARIFICATION_REQUIRED"]), T("b", pol="neg")]
    dec = S.decisions(DS(truth), {"results": [R("a", "M-023", "CLARIFICATION_REQUIRED")]})
    assert dec[0] | {"evidence": None} == {
        "evidence_group_id": "a:M-023:CMP-04", "object": "a", "code": "M-023", "operator": "CMP-04", "mutation": "MUT-06", "variant": "v",
        "system_status": "CLARIFICATION_REQUIRED", "decision": "CLARIFICATION_REQUIRED", "expected_value": "С0", "actual_value": "С1",
        "evidence": None, "labeler": S.LABELER, "synthetic": True, "split": "train"}
    assert dec[1]["system_status"] is None and dec[1]["expected_value"] is None and dec[1]["decision"] == "NEGATIVE_VERIFIED"


@pytest.mark.l1_functional
def test_score_defect_record_and_report_header_fields():
    truth = [T("a", pol="neg")]
    rep = S.score(DS(truth), {"results": [R("a", "M-023", "CANDIDATE")], "ms": 5, "rss_mb": 7}, b=10)
    assert rep["defects"] == [{"case_id": "a", "code": "M-023", "operator": "CMP-04", "mutation": "MUT-06", "variant": "v", "target": True, "tags": [],
                               "expected": ["NEGATIVE_VERIFIED"], "status": "CANDIDATE", "pd": "С0", "rd": "С1", "system": {"expected": "С0", "actual": "С1", "reason": "r"}}]
    assert (rep["schema"], rep["cases"], rep["groups"], rep["registry_sha256"]) == ("inspector-mutation-report/1", 1, 1, "abc")
    assert rep["timing"] == {"api_ms": 5, "api_rss_mb": 7, "case_ms_p50": 10, "case_ms_max": 10}
    assert rep["localization"] == {"tp": 0, "localized": 0, "rate": None, "ci": None}
    s = rep["slices"]["all"]
    assert (s["fp"], s["tn"], s["n_neg"], s["fpr"], s["precision"]) == (1, 0, 1, 1.0, 0.0)
    assert S._pct([], 0.5) is None and S._pct([3, 1, 2], 0.5) == 2 and S._pct([3, 1, 2], 0.99) == 3
    assert S._f(None) == "—" and S._f(0.5) == "0,500" and S._ci(None) == "" and S._ci([0.1, 0.2]) == " [0,100; 0,200]"
