"""T-190: переходник замера отложенного набора W2 через стенд мутаций T-179 (eval/w2_holdout/run.py).

Конвертация набора W2 → MutationDataset стенда и ответа стенда → вход счёта W2; сквозной прогон на крошечном поднаборе
с подменой вызова API (без ML и node). Настоящий прогон — CLI на раннере."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter

import pytest

from eval.w2_holdout import generate as gen
from eval.w2_holdout import run as R

SEED = 100000
# схема BenchFile/BenchCase стенда (apps/api/src/domain/mutation-bench.ts) — независимый пересчёт в Python
ID = re.compile(r"^[A-Za-z0-9-]{1,80}$")
CASE = re.compile(r"^[A-Za-z0-9-]{1,40}$")
APPROVAL = {"DRAFT", "APPROVED", "FOR_CONSTRUCTION", "SUPERSEDED", "CANCELLED", None}


def _file(cid: str, stage: str, disc: str, date: str = "02.03.26") -> dict:
    return {
        "file_id": f"{cid}-{stage}-{disc}",
        "file_name": f"{stage}-{disc}.pdf",
        "doc_stage": stage,
        "discipline": {"AR": "АР", "OV": "ОВ"}[disc],
        "document_code": f"W2H-0000-{disc}",
        "revision": "0",
        "approval_status": gen.STATUS[stage],
        "approval_date": date,
        "predecessor_id": f"{cid}-PD-{disc}" if stage == "RD" else None,
        "sha256": hashlib.sha256(f"{cid}{stage}{disc}".encode()).hexdigest(),
    }


def _ds(n: int = 2) -> dict:
    cases = [
        {
            "case_id": f"W2H-{SEED}-{i:04d}",
            "mutation": "NEG-01",
            "files": [
                _file(f"W2H-{SEED}-{i:04d}", s, d)
                for s in ("PD", "RD")
                for d in ("AR", "OV")
            ],
        }
        for i in range(n)
    ]
    truth = [{"case_id": c["case_id"], "code": "M-023"} for c in cases]
    return {
        "schema": gen.SCHEMA,
        "dataset_version": f"w2-holdout:seed={SEED}:n={n}",
        "cases": cases,
        "truth": truth,
    }


def _check_bench(bench: dict) -> None:
    assert bench["schema"] == "inspector-mutations/1"
    for c in bench["cases"]:
        assert CASE.match(c["case_id"]) and 1 <= len(c["files"]) <= 8
        assert all(isinstance(v, bool) for v in c["profile"].values())
        for f in c["files"]:
            assert ID.match(f["file_id"]) and "/" not in f["file_name"]
            assert re.fullmatch(r"[0-9a-f]{64}", f["sha256"])
            assert (
                f["doc_stage"] in ("PD", "RD", "ID")
                and f["approval_status"] in APPROVAL
            )
            assert f["predecessor_id"] is None or ID.match(f["predecessor_id"])
            assert (
                len(f["discipline"]) <= 20
                and len(f["revision"]) <= 20
                and len(f["approval_date"] or "") <= 20
            )


# ─────────────────────────────────────────────── конвертация


@pytest.mark.l1_functional
def test_to_bench_keeps_manifest_fields_and_default_profile():
    ds = _ds()
    bench = R.to_bench(ds)
    _check_bench(bench)
    assert bench["dataset_version"] == ds["dataset_version"]
    assert [c["case_id"] for c in bench["cases"]] == [c["case_id"] for c in ds["cases"]]
    f0, src = bench["cases"][0]["files"][2], ds["cases"][0]["files"][2]
    assert f0 == {k: src[k] for k in f0 if k != "approval_date"} | {
        "approval_date": "02.03.2026"
    }
    assert set(f0) == {
        "file_id",
        "file_name",
        "sha256",
        "doc_stage",
        "discipline",
        "document_code",
        "revision",
        "approval_status",
        "approval_date",
        "predecessor_id",
    }
    assert bench["cases"][0]["profile"] == R.DEFAULT_PROFILE
    bench["cases"][0]["profile"]["residential"] = (
        False  # профиль — копия на пример, не общий объект
    )
    assert bench["cases"][1]["profile"] == R.DEFAULT_PROFILE
    assert R.to_bench(ds, {"demolition": True})["cases"][0]["profile"] == {
        "demolition": True
    }


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "src,dst",
    [
        ("02.03.26", "02.03.2026"),
        ("15.07.2026", "15.07.2026"),
        ("2026-07-15", "2026-07-15"),
        (None, None),
        ("", ""),
        ("2.3.26", "2.3.26"),
    ],
)
def test_long_date(src, dst):
    assert R.long_date(src) == dst


@pytest.mark.l6_adversarial
def test_to_bench_refuses_foreign_schema_and_unrendered_set():
    with pytest.raises(ValueError, match="схемой"):
        R.to_bench(_ds() | {"schema": "inspector-mutations/1"})
    ds = _ds()
    del ds["cases"][1]["files"][3]["sha256"]
    with pytest.raises(ValueError, match="sha256"):
        R.to_bench(ds)
    ds = _ds()
    ds["cases"][0]["files"] = []
    with pytest.raises(ValueError, match="нет файлов"):
        R.to_bench(ds)


@pytest.mark.l1_functional
def test_wave_codes_are_all_50_params():
    codes = R.wave_codes()
    assert len(codes) == 50 == len(set(codes))
    assert all(re.fullmatch(r"M-\d{3}", c) for c in codes) and codes == sorted(codes)
    wave = json.loads(R.WAVE.read_text("utf-8"))
    assert set(codes) == {p["id"] for p in wave["params"]}


@pytest.mark.l6_adversarial
def test_wave_codes_refuses_code_the_bench_would_drop(tmp_path):
    p = tmp_path / "w.json"
    p.write_text(json.dumps({"params": [{"id": "M-001"}, {"id": "M-12"}]}), "utf-8")
    with pytest.raises(ValueError, match="M-12"):
        R.wave_codes(p)


@pytest.mark.l1_functional
def test_to_score_input_rows_without_operator_and_errors_pass_through():
    api = {
        "schema": "inspector-mutation-results/1",
        "results": [
            {
                "case_id": "A",
                "ms": 5,
                "files": [{"file_id": "A-RD-AR", "parse_status": "DONE"}],
                "extractions": [{"x": 1}],
                "rows": [
                    {
                        "code": "M-023",
                        "status": "CANDIDATE",
                        "expected": "1",
                        "actual": "2",
                        "delta": None,
                        "reason": "r",
                        "fragments": [
                            {
                                "file_id": "A-RD-AR",
                                "stage": "RD",
                                "page": 1,
                                "bbox": [0, 0, 1, 1],
                            }
                        ],
                    },
                    {"code": "M-061", "status": "MISSING_EVIDENCE", "fragments": []},
                ],
            },
            {
                "case_id": "B",
                "ms": 0,
                "files": [],
                "rows": [],
                "extractions": [],
                "error": "разбор не закончился",
            },
        ],
    }
    inp = R.to_score_input(api)
    a, b = inp["results"]
    assert a["rows"][0] == {
        "code": "M-023",
        "status": "CANDIDATE",
        "fragments": api["results"][0]["rows"][0]["fragments"],
    }
    assert (
        all("operator" not in w for w in a["rows"])
        and "error" not in a
        and "extractions" not in a
    )
    assert b["error"] == "разбор не закончился" and b["rows"] == []


@pytest.mark.l1_functional
def test_head_keeps_truth_of_kept_cases():
    ds = _ds(3)
    h = R.head(ds, 2)
    assert [c["case_id"] for c in h["cases"]] == [c["case_id"] for c in ds["cases"][:2]]
    assert {t["case_id"] for t in h["truth"]} == {c["case_id"] for c in ds["cases"][:2]}
    assert R.head(ds, None) is ds


@pytest.mark.l6_adversarial
def test_prepare_refuses_foreign_dir_and_holdout_inside(tmp_path):
    foreign = tmp_path / "x"
    foreign.mkdir()
    (foreign / "keep.txt").write_text("мой файл", "utf-8")
    with pytest.raises(RuntimeError, match="не удаляю"):
        R.prepare(foreign, None)
    assert (foreign / "keep.txt").exists()
    with pytest.raises(RuntimeError, match="внутри каталога прогона"):
        R.prepare(tmp_path / "run", tmp_path / "run" / "set")
    ours = tmp_path / "ours"
    ours.mkdir()
    (ours / "run.json").write_text(json.dumps({"schema": R.RUN_SCHEMA}), "utf-8")
    (ours / "old.json").write_text("{}", "utf-8")
    assert not (R.prepare(ours, None) / "old.json").exists()


# ─────────────────────────────────────────────── сквозной прогон с подменой API


def _fake_api(status_of):
    """Подмена прогона конвейера: проверяет вход стенда так, как его прочтёт mutation-bench.ts (dataset.json и файлы
    по <dir>/<case_id>/<имя> с тем же SHA-256), отвечает строками по всем кодам."""
    seen = {}

    def api(run_dir, bench, codes, parallel, batch):
        disk = json.loads((run_dir / "dataset.json").read_text("utf-8"))
        assert disk == bench
        _check_bench(bench)
        for c in bench["cases"]:
            for f in c["files"]:
                assert (
                    hashlib.sha256(
                        (run_dir / c["case_id"] / f["file_name"]).read_bytes()
                    ).hexdigest()
                    == f["sha256"]
                )
        seen.update(codes=codes, parallel=parallel, batch=batch)
        return {
            "schema": "inspector-mutation-results/1",
            "ms": 1,
            "rss_mb": 1,
            "results": [
                {
                    "case_id": c["case_id"],
                    "ms": 1,
                    "files": [
                        {"file_id": f["file_id"], "parse_status": "DONE"}
                        for f in c["files"]
                    ],
                    "extractions": [],
                    "rows": [
                        {
                            "code": k,
                            "status": status_of(c["case_id"], k),
                            "expected": None,
                            "actual": None,
                            "delta": None,
                            "reason": None,
                            "fragments": [],
                        }
                        for k in codes
                    ],
                }
                for c in bench["cases"]
            ],
        }

    return api, seen


@pytest.fixture(scope="module")
def tiny(tmp_path_factory):
    """Крошечный поднабор: по примеру NEG-01 и MUT-09/door, отрисован настоящим генератором T-195."""
    out = tmp_path_factory.mktemp("w2set")
    return out, gen.build(out, SEED, only=["NEG-01", "MUT-09/door"], per=1)


@pytest.mark.l1_functional
def test_run_end_to_end_with_fake_api_builds_report(tiny, tmp_path):
    holdout, ds = tiny
    api, seen = _fake_api(lambda cid, code: "MISSING_EVIDENCE")
    rep = R.run(
        tmp_path / "subset",
        holdout=holdout,
        parallel=2,
        bootstrap=20,
        api=api,
        revs=lambda: {"parser_rev": 0, "extract_rev": 0},
    )
    d = tmp_path / "subset"
    assert seen["codes"] == R.wave_codes() and seen["parallel"] == 2
    assert rep["cases"] == len(ds["cases"]) == 2 and rep["groups"] == len(ds["truth"])
    assert (
        rep["failed_cases"] == [] and rep["missing_cases"] == [] and rep["codes"] == 50
    )
    assert (
        json.loads((d / "report.json").read_text("utf-8"))["dataset_version"]
        == ds["dataset_version"]
    )
    assert (d / "report.md").read_text("utf-8").strip()
    assert (
        json.loads((d / "results.json").read_text("utf-8"))["results"][0]["case_id"]
        == ds["cases"][0]["case_id"]
    )
    assert (d / ds["cases"][0]["case_id"]).is_symlink()
    a = rep["slices"]["all"]
    assert a["tp"] == a["fp"] == 0  # всё воздержание — ни одного «нарушения»
    assert {
        "generate_s",
        "pipeline_s",
        "self_peak_rss_mb",
        "children_peak_rss_mb",
    } <= set(rep["timing"])
    # повторный прогон в тот же каталог — свой прошлый прогон очищается, готовый набор снаружи не трогается
    R.run(d, holdout=holdout, bootstrap=20, api=api, revs=dict)
    assert (holdout / "dataset.json").exists()


@pytest.mark.l2_differential
def test_row_without_operator_counts_for_every_operator_of_code(tiny, tmp_path):
    """Независимый пересчёт: CANDIDATE по коду даёт «нарушение» каждой непроверочной (pending=False) группе этого кода
    во всех операторах — tp + fp по коду равно числу его групп в истине."""
    holdout, ds = tiny
    live = [
        t for t in ds["truth"] if not t["pending"] and t["polarity"] in ("pos", "neg")
    ]
    code = Counter(t["code"] for t in live).most_common(1)[0][0]
    api, _ = _fake_api(lambda cid, k: "CANDIDATE" if k == code else "MISSING_EVIDENCE")
    rep = R.run(tmp_path / "r", holdout=holdout, bootstrap=20, api=api, revs=dict)
    ops = {t["operator"] for t in live if t["code"] == code}
    flagged = sum(
        rep["slices"][f"pair:{code}×{op}"]["tp"]
        + rep["slices"][f"pair:{code}×{op}"]["fp"]
        for op in ops
    )
    assert flagged == sum(t["code"] == code for t in live)
    assert rep["slices"]["all"]["tp"] + rep["slices"]["all"]["fp"] == flagged


@pytest.mark.l1_functional
def test_run_generates_subset_with_limit(tmp_path):
    api, _ = _fake_api(lambda cid, k: "MISSING_EVIDENCE")
    rep = R.run(
        tmp_path / "g",
        seed=SEED,
        only=["NEG-01"],
        limit=1,
        bootstrap=20,
        api=api,
        revs=dict,
    )
    assert rep["cases"] == 1
    assert (tmp_path / "g/holdout/dataset.json").exists()
    assert gen.select is not None and gen.select.__name__ == "select"  # обёртка снята
