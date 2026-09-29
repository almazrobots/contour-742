"""Стенд оценки §14 (OS-INSP-6.5.1–6.5.3): метрики, ДИ, вердикт, адаптер разметки, прогон.

Имя теста — то, на что ссылается трасса (docs/gera/inspector/model.yaml → impl).
"""

from __future__ import annotations

import json
import random
import unicodedata
from collections import Counter
from pathlib import Path

import pytest

from eval import ci, metrics, thresholds
from eval.decide import StageValue, choose, evaluate, select_revisions
from eval.organizer import SourceFormatError, find_xlsx, load_examples, parse_sources
from eval.run import load_matrix, page_reading, specs
from inspector_ml.model import Line, Page, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)

# ─────────────────────────────────────────────── OS-INSP-6.5.1: метрики


@pytest.mark.l1_functional
def test_cer_known_example():
    assert metrics.cer("кот", "кит") == pytest.approx(1 / 3)
    assert metrics.cer("кот", "кот") == 0
    assert metrics.wer("класс бетона B30", "класс бетона B25") == pytest.approx(1 / 3)
    assert metrics.character_accuracy(
        [("кот", "кит"), ("шифр", "шифр")]
    ) == pytest.approx(1 - 1 / 7)


@pytest.mark.l1_functional
def test_cer_normalization_nfc_and_spaces_but_not_signs_or_case():
    decomposed = unicodedata.normalize("NFD", "Толщина плиты, мм: 200 й")
    assert metrics.cer("Толщина плиты, мм: 200 й", decomposed) == 0
    assert metrics.cer("Шифр:  СК2-П-ПЗ", "Шифр: СК2-П-ПЗ\n") == 0
    assert metrics.cer("СК2-П-ПЗ", "СК2П-ПЗ") > 0  # знак в шифре не удаляется
    assert metrics.cer("B30", "b30") > 0  # регистр в CER значим


@pytest.mark.l1_functional
def test_exact_match_policy_by_field_type():
    em = metrics.exact_match
    assert em("code", "СК2-П-ПЗ", "СК2 - П - ПЗ")  # пробелы вокруг дефиса — оформление
    assert em("code", "СК2-П-ПЗ", "CK2-П-ПЗ")  # латинские двойники неразличимы на листе
    assert not em("code", "СК2-П-ПЗ", "СК2П-ПЗ")  # знак значим
    assert not em("code", "ВЕ33-Р-АР", "ВЕЗЗ-Р-АР")  # цифра 3 ≠ буква З
    assert em("stage", "П", "pd") and em("stage", "ИД", "ид")
    assert not em("revision", "B", "b") and em("revision", "B", "В")
    assert em("sheet", "2", "02") and not em("sheet", "2", "3")
    assert em("room", "1.18а", "1.18А") and not em("room", "1.18", "118")
    assert not em("code", "СК2-П-ПЗ", None)


@pytest.mark.l1_functional
def test_iou_rectangles():
    assert metrics.iou([0, 0, 2, 2], [1, 1, 3, 3]) == pytest.approx(1 / 7)
    assert metrics.iou([0, 0, 1, 1], [0, 0, 1, 1]) == 1
    assert metrics.iou([0, 0, 1, 1], [2, 2, 3, 3]) == 0
    assert metrics.iou(None, [0, 0, 1, 1]) == 0


@pytest.mark.l3_boundary
def test_localization_needs_file_page_and_iou_half():
    g = [{"file_id": "F", "page": 2, "bbox": [0, 0, 1, 1]}]
    half = [
        {"file_id": "F", "page": 2, "bbox": [0, 0, 1, 0.5]}
    ]  # IoU ровно 0,5 — засчитывается
    assert metrics.evidence_localized(g, half)
    assert not metrics.evidence_localized(
        g, [{"file_id": "F", "page": 2, "bbox": [0, 0, 1, 0.499]}]
    )
    assert not metrics.evidence_localized(
        g, [{"file_id": "F", "page": 3, "bbox": [0, 0, 1, 1]}]
    )
    assert not metrics.evidence_localized(
        g, [{"file_id": "G", "page": 2, "bbox": [0, 0, 1, 1]}]
    )
    # «без полного доказательства finding не засчитывается»: второй фрагмент не найден
    g2 = g + [{"file_id": "H", "page": 1, "bbox": [0, 0, 0.1, 0.1]}]
    assert not metrics.evidence_localized(g2, half)


def _grp(oid, param, label, fid="F", trap=False):
    return {
        "object_id": oid,
        "param": param,
        "label": label,
        "superseded_trap": trap,
        "evidence": [{"file_id": fid, "page": 1, "bbox": [0.1, 0.1, 0.2, 0.2]}],
    }


def _pred(oid, param, status, fid="F", bbox=(0.1, 0.1, 0.2, 0.2)):
    return {
        "object_id": oid,
        "param": param,
        "status": status,
        "evidence": [{"file_id": fid, "page": 1, "bbox": list(bbox)}],
    }


@pytest.mark.l1_functional
def test_prf_fpr_on_toy_set():
    gold = [
        _grp("O", "M-1", "CANDIDATE"),
        _grp("O", "M-2", "CANDIDATE"),
        _grp("O", "M-3", "CANDIDATE"),
        _grp("O", "M-4", "NEGATIVE_VERIFIED"),
        _grp("O", "M-5", "NEGATIVE_VERIFIED", trap=True),
    ]
    pred = [
        _pred("O", "M-1", "CANDIDATE"),
        _pred("O", "M-2", "CANDIDATE"),
        _pred(
            "O", "M-3", "CANDIDATE", bbox=(0.5, 0.5, 0.6, 0.6)
        ),  # верный параметр, неверное доказательство
        _pred("O", "M-4", "NEGATIVE_VERIFIED"),
        _pred("O", "M-5", "CANDIDATE"),
        _pred("O", "M-9", "CANDIDATE"),
    ]  # лишняя находка вне эталона
    c = metrics.match_findings(gold, pred)["O"]
    assert (c["tp"], c["fp"], c["fn"]) == (2, 3, 1)
    p, r, f = metrics.prf(c["tp"], c["fp"], c["fn"])
    assert (p, r, f) == pytest.approx((0.4, 2 / 3, 0.5))
    assert metrics.fpr(c["neg_fp"], c["neg_n"]) == 0.5
    assert metrics.fpr(c["trap_fp"], c["trap_n"]) == 1.0


@pytest.mark.l3_boundary
def test_metrics_undefined_without_sample():
    import math

    assert math.isnan(metrics.cer("", "abc"))
    assert math.isnan(metrics.prf(0, 0, 0)[0])
    assert metrics.prf(0, 0, 3) == (pytest.approx(float("nan"), nan_ok=True), 0.0, 0.0)


# ─────────────────────────────────────────────── OS-INSP-6.5.2: ДИ бутстрапом по объектам


def _bernoulli_objects(
    n_obj: int, units: int, p: float, seed: int
) -> dict[str, Counter]:
    r = random.Random(seed)
    return {
        f"O{i}": Counter(em_n=units, em_ok=sum(r.random() < p for _ in range(units)))
        for i in range(n_obj)
    }


EM = metrics.METRICS["exact_match"]["value"]


@pytest.mark.l5_property
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_ci_narrows_with_sample_and_contains_point(seed):
    small, big = (
        _bernoulli_objects(10, 8, 0.85, seed),
        _bernoulli_objects(200, 8, 0.85, seed),
    )
    w = {}
    for name, po in (("small", small), ("big", big)):
        lo, hi = ci.bootstrap_ci(po, EM, b=500, seed=seed)
        point = EM(metrics.total(po))
        assert lo <= point <= hi
        w[name] = hi - lo
    assert w["big"] < w["small"] / 2


@pytest.mark.l1_functional
def test_bootstrap_resamples_whole_objects():
    # объект A — 10 верных полей, B — 10 неверных: реплика по объектам даёт только 0, ½ или 1;
    # ресэмплинг по полям дал бы промежуточные доли и ложно узкий интервал
    po = {"A": Counter(em_n=10, em_ok=10), "B": Counter(em_n=10, em_ok=0)}
    reps = ci.bootstrap_replicates(po, EM, b=300, seed=5)
    assert set(round(x, 6) for x in reps) <= {0.0, 0.5, 1.0}
    assert ci.bootstrap_ci(po, EM, b=300, seed=5) == (0.0, 1.0)


@pytest.mark.l5_property
def test_bootstrap_deterministic_by_seed():
    po = _bernoulli_objects(15, 5, 0.7, 9)
    assert ci.bootstrap_ci(po, EM, b=200, seed=1) == ci.bootstrap_ci(
        po, EM, b=200, seed=1
    )


# ─────────────────────────────────────────────── OS-INSP-6.5.3: пороги и вердикт


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


@pytest.mark.l1_functional
def test_verdict_accepted_when_all_thresholds_met():
    vd = thresholds.verdict(_all_pass())
    assert vd["verdict"] == thresholds.ACCEPTED and vd["failed"] == []


@pytest.mark.l1_functional
def test_verdict_fails_on_single_threshold_despite_high_f1():
    res = _all_pass()
    res["f1"]["value"] = 0.99
    res["fpr"]["value"] = 0.11  # ТЗ 14.3-08: любой непройденный порог — «не принято»
    vd = thresholds.verdict(res)
    assert vd["verdict"] == thresholds.REJECTED and vd["failed"] == ["fpr"]


@pytest.mark.l3_boundary
def test_verdict_threshold_edges_and_empty_sample():
    res = _all_pass()
    res["character_accuracy"]["value"] = 0.95  # ровно порог — пройден (≥)
    res["fpr"]["value"] = 0.10  # ровно порог — пройден (≤)
    assert thresholds.verdict(res)["verdict"] == thresholds.ACCEPTED
    res["linkage"]["n"] = 0  # нечем доказать — не пройден
    assert thresholds.verdict(res)["failed"] == ["linkage"]
    res["linkage"]["n"] = 10
    res["recall"]["value"] = float("nan")
    assert thresholds.verdict(res)["failed"] == ["recall"]


@pytest.mark.l1_functional
def test_verdict_marks_robustness_by_ci_bound():
    res = _all_pass()
    res["precision"]["ci"] = [0.85, 0.97]  # точка проходит, нижняя граница ДИ — нет
    row = thresholds.verdict(res)["metrics"]["precision"]
    assert row["pass"] and not row["robust"]


# ─────────────────────────────────────────────── решающий слой = домен API


@pytest.mark.l2_differential
def test_decide_mirror_matches_answer_key_v1():
    """Зеркало compare.ts/revisions.ts на конвейере parse+extract даёт статусы answer-key v1."""
    from inspector_ml.extract import extract
    from inspector_ml.parse import parse_file

    matrix = load_matrix()
    all_specs = specs(matrix)
    checked = 0
    for obj in ("OBJ-SEV-2", "OBJ-SCH-8", "OBJ-POL-115"):
        d = ROOT / "data/synth" / obj
        man = json.loads((d / "manifest.json").read_text("utf-8"))
        key = json.loads((d / "answer-key.json").read_text("utf-8"))
        files = [f for f in man["files"] if f["sha256"]]
        roles = select_revisions(files)
        by = {}
        for f in files:
            for e in extract(parse_file(d / f["file_name"], f["sha256"]), all_specs):
                by.setdefault(e.code, []).append(
                    StageValue(
                        f["doc_stage"],
                        e.value_num,
                        e.value_text,
                        e.raw,
                        f["file_id"],
                        e.page,
                        e.bbox,
                        roles[f["file_id"]],
                        f["document_code"],
                        f["revision"],
                        e.confidence,
                        f["discipline"],
                    )
                )
        loaded = {f["doc_stage"] for f in files}
        for code, want in key.items():
            if code.startswith("M-"):
                got = evaluate(
                    matrix[code],
                    man["object"]["profile"],
                    choose(by.get(code, []), matrix[code]),
                    loaded,
                ).status
                assert got == want, (obj, code)
                checked += 1
    assert checked >= 20


# ─────────────────────────────────────────────── чтение страницы для CER


def _w(t, x0, y0, x1, y1):
    return Word(text=t, bbox=(x0, y0, x1, y1))


@pytest.mark.l1_functional
def test_page_reading_rows_skew_and_dont_care():
    # колонки одной строки таблицы на наклонном скане: значение справа выше подписи на 0,012
    lines = [
        Line(text="Этажность", words=[_w("Этажность", 0.10, 0.320, 0.20, 0.330)]),
        Line(text="16", words=[_w("16", 0.85, 0.296, 0.87, 0.306)]),
        Line(
            text="Толщина плиты",
            words=[
                _w("Толщина", 0.10, 0.350, 0.18, 0.360),
                _w("плиты", 0.19, 0.3473, 0.25, 0.3573),
            ],
        ),
        Line(text="200", words=[_w("200", 0.85, 0.326, 0.88, 0.336)]),
        Line(
            text="Главный инженер",
            words=[
                _w("Главный", 0.10, 0.100, 0.40, 0.110),
                _w("инженер", 0.42, 0.0895, 0.70, 0.0995),
            ],
        ),
        Line(text="ООО", words=[_w("ООО", 0.12, 0.80, 0.16, 0.81)]),
    ]
    page = Page(page=1, width=595, height=842, source="ocr", lines=lines)
    text = page_reading(page, dont_care=[[0.1, 0.78, 0.2, 0.9]])
    assert text.split("\n") == ["Главный инженер", "Этажность 16", "Толщина плиты 200"]


# ─────────────────────────────────────────────── адаптер разметки организаторов


@pytest.mark.l1_functional
def test_organizer_source_string_parsed():
    s = (
        "PD:ALT79B-000015:стр.19:bbox [0.7800,0.1000,0.9100,0.3500];[0.3600,0.1000,0.6400,0.2500] | "
        "RD:ALT79B-000077:стр.4:bbox [0.8000,0.0300,0.9300,0.2700] | RD:POL17-000096:стр.7:bbox —"
    )
    src = parse_sources(s)
    assert [(x["stage"], x["file_id"], x["page"], len(x["bboxes"])) for x in src] == [
        ("PD", "ALT79B-000015", 19, 2),
        ("RD", "ALT79B-000077", 4, 1),
        ("RD", "POL17-000096", 7, 0),
    ]
    assert src[0]["bboxes"][1] == [0.36, 0.10, 0.64, 0.25]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "bad",
    [
        "PD:X-1:стр.2:bbox [0.9,0.1,0.2,0.3]",
        "PD:X-1:стр.2:bbox [1.2,0,1,1]",
        "XX:X-1:стр.2:bbox —",
        "PD:X-1:bbox —",
    ],
)
def test_organizer_rejects_malformed_sources(bad):
    with pytest.raises(SourceFormatError):
        parse_sources(bad)


@pytest.mark.l1_functional
def test_organizer_examples_sheet_to_evidence_groups():
    x = find_xlsx()
    if x is None:
        pytest.skip("ТЗ/Матрица_параметров_редакция1.1.xlsx вне git и не найдена")
    groups = load_examples(x)
    labels = Counter(g["label"] for g in groups)
    assert labels["CONFIRMED_VIOLATION"] >= 1 and labels["NEGATIVE_VERIFIED"] >= 1
    for g in groups:
        assert g["evidence"] and all(
            e["file_id"].startswith(g["object_id"]) for e in g["evidence"]
        )
        assert all(
            e["bbox"] is None or all(0 <= v <= 1 for v in e["bbox"])
            for e in g["evidence"]
        )
    assert len({g["evidence_group_id"] for g in groups}) == len(groups)


# ─────────────────────────────────────────────── OS-INSP-6.5.10: срезы по объектам, разделам и типам с 95 % ДИ


@pytest.mark.l1_functional
def test_wilson_known_example():
    # k = 8 из n = 10: интервал Уилсона 95 % ≈ [0,490; 0,943] (Newcombe 1998, метод 3)
    lo, hi = ci.wilson(8, 10)
    assert lo == pytest.approx(0.4902, abs=5e-4)
    assert hi == pytest.approx(0.9433, abs=5e-4)
    # крайние доли не выходят за [0; 1], интервал не вырождается в точку
    lo0, hi0 = ci.wilson(0, 10)
    assert lo0 == pytest.approx(0.0, abs=1e-12) and 0.2 < hi0 < 0.35
    lo1, hi1 = ci.wilson(10, 10)
    assert hi1 == pytest.approx(1.0, abs=1e-12) and 0.65 < lo1 < 0.8


@pytest.mark.l1_functional
def test_wilson_empty_sample_not_measured():
    import math

    lo, hi = ci.wilson(0, 0)
    assert math.isnan(lo) and math.isnan(hi)


@pytest.mark.l5_property
def test_wilson_narrows_with_sample_and_contains_point():
    for k, n in ((3, 7), (30, 70), (300, 700)):
        lo, hi = ci.wilson(k, n)
        assert lo <= k / n <= hi
    assert (lambda a, b: b - a)(*ci.wilson(300, 700)) < (lambda a, b: b - a)(*ci.wilson(3, 7)) / 5
    lo90, hi90 = ci.wilson(8, 10, level=0.90)
    lo95, hi95 = ci.wilson(8, 10)
    assert lo95 < lo90 and hi90 < hi95


def _slice_obs() -> list:
    # объект A: 10 групп локализации (8 верно, 9 с ответом), 5 положительных находок; объект B — в другом разделе
    a = Counter(loc_n=10, loc_ok=8, loc_answered=9, link_n=10, link_ok=10, link_answered=10, tp=4, fp=1, fn=1)
    b = Counter(loc_n=6, loc_ok=3, loc_answered=6, tp=2, fp=2, fn=2, neg_n=4, neg_fp=1)
    return [
        ("OBJ-A", {"section": "АР", "type": "range"}, a),
        ("OBJ-B", {"section": "АР", "type": "range"}, b),
        ("OBJ-B", {"section": "КР", "type": "equality"}, Counter(loc_n=2, loc_ok=2, loc_answered=2)),
    ]


@pytest.mark.l1_functional
def test_object_slice_gets_wilson_ci_for_proportions():
    from eval.run import build_slices

    s = build_slices(_slice_obs(), b=200, seed=1)
    a = s["object"]["OBJ-A"]
    assert a["localization"]["ci"] == [pytest.approx(x, abs=1e-4) for x in ci.wilson(8, 10)]
    assert a["localization"]["ci_method"] == "wilson"
    assert a["localization"]["coverage"] == pytest.approx(0.9)
    assert a["precision"]["ci"] == [pytest.approx(x, abs=1e-4) for x in ci.wilson(4, 5)]
    assert a["recall"]["ci"] == [pytest.approx(x, abs=1e-4) for x in ci.wilson(4, 5)]
    # F1 — не доля k/n: на одном объекте ДИ нет, и это помечено, а не выдумано
    assert a["f1"]["ci"] == [None, None]
    assert a["f1"]["ci_method"] is None and a["f1"]["ci_note"]
    # FPR по объекту B — доля neg_fp / neg_n
    assert s["object"]["OBJ-B"]["fpr"]["ci"] == [pytest.approx(x, abs=1e-4) for x in ci.wilson(1, 4)]


@pytest.mark.l1_functional
def test_section_slice_bootstrap_over_objects_or_wilson_for_one():
    from eval.run import build_slices

    s = build_slices(_slice_obs(), b=200, seed=1)
    ar = s["section"]["АР"]["localization"]
    assert ar["ci_method"] == "bootstrap" and ar["objects"] == 2
    assert ar["ci"][0] <= ar["value"] <= ar["ci"][1]
    kr = s["section"]["КР"]["localization"]  # в срезе один объект — бутстрэп вырожден, берётся Уилсон
    assert kr["ci_method"] == "wilson"
    assert kr["ci"] == [pytest.approx(x, abs=1e-4) for x in ci.wilson(2, 2)]
    assert set(s["type"]) == {"range", "equality"}
    assert s["type"]["range"]["recall"]["ci_method"] == "bootstrap"


@pytest.mark.l1_functional
def test_markdown_slices_show_ci_n_and_coverage():
    from eval.run import build_slices, slice_cell

    s = build_slices(_slice_obs(), b=200, seed=1)
    cell = slice_cell("localization", s["object"]["OBJ-A"]["localization"])
    assert cell == "0,800 [0,490; 0,943]† n=10 cov 0,900"
    assert "ДИ —" in slice_cell("f1", s["object"]["OBJ-A"]["f1"])
    assert slice_cell("exact_match", s["object"]["OBJ-A"]["exact_match"]) == "—"


@pytest.mark.l1_functional
def test_markdown_report_prints_slice_ci_instead_of_json_reference():
    from eval.run import build_slices, per_object, summarize, to_markdown

    obs = _slice_obs()
    r = {
        "disclaimer": "Синтетический набор",
        "dataset_version": ["synth-test"],
        "n_objects": 2,
        "matrix_version": "0" * 12,
        "input_manifest_hash": "0" * 64,
        "model_version": "тест",
        "bootstrap": {"B": 50, "seed": 1},
        "resources": {k: 0 for k in ("pipeline_wall_s", "total_wall_s", "pages", "ocr_pages", "peak_rss_mb_python", "peak_rss_mb_children")},
        "overall": summarize(per_object(obs), 50, 1),
        "verdict": {"verdict": "не принято", "failed": [], "metrics": {}},
        "slices": build_slices(obs, 50, 1),
    }
    md = to_markdown(r)
    assert "| OBJ-A |" in md and "0,800 [0,490; 0,943]† n=10 cov 0,900" in md
    assert "ДИ по срезам — в `report.json`" not in md
    assert "Уилсон" in md and "OS-INSP-6.5.10" in md
