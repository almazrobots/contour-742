"""OS-INSP-6.5.16 (ТЗ 9.3.6, T-081): синтетический объект «132 параметра, 14 нарушений» для замера полного цикла верификации.

Метку эталона ставит зеркало домена (eval/decide.py) по истинным значениям, не намерение генератора: «ровно 14» проверяется
по эталону.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from synth import factory as F
from synth import usability_132 as U


def _stub_render(d, pages, path) -> None:
    """Отрисовка-заглушка: байты из содержимого документа. Растр печатей — 2/3 времени сборки; метки эталона от него
    не зависят, а тесты гоняются и под mutmut на каждого мутанта. Настоящие байты — в test_real_render_*."""
    path.write_bytes(
        json.dumps(
            [
                d.file_id,
                d.code,
                d.stage,
                d.status,
                d.date,
                d.title,
                [(c, repr(v)) for c, v in d.rows],
                len(pages),
            ],
            ensure_ascii=False,
        ).encode()
    )


@pytest.fixture(scope="module")
def pkg(tmp_path_factory):
    out = tmp_path_factory.mktemp("usb")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(F, "render_pdf", _stub_render)
        gold = U.build(1, out)
    return gold, out / U.OBJECT_ID


def _labels(gold: dict) -> dict[str, str]:
    return {e["param"]: e["label"] for e in gold["evidence_groups"]}


def _hashes(d) -> dict[str, str]:
    return {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.iterdir())
    }


@pytest.mark.l1_functional
def test_object_has_all_132_params_and_exactly_14_violations_by_decide(pkg):
    gold, _ = pkg
    labels = _labels(gold)
    assert sorted(labels) == sorted(F.MATRIX) and len(labels) == 132
    assert sum(v == "CANDIDATE" for v in labels.values()) == U.N_VIOLATIONS == 14
    # эталонные нарушения — ровно выбранные по seed; остальное совпадает (все параметры применимы, три стадии)
    assert sorted(
        c for c, v in labels.items() if v == "CANDIDATE"
    ) == U.pick_violations(1)
    # остальное совпадает; параметры, которые домен не сравнивает (NOT_COMPARABLE), — не среди достижимых
    rest = {c: v for c, v in labels.items() if v != "CANDIDATE"}
    assert set(rest.values()) <= {"NEGATIVE_VERIFIED", "NOT_COMPARABLE"}
    assert not {c for c, v in rest.items() if v == "NOT_COMPARABLE"} & set(
        U.reachable()
    )


@pytest.mark.l1_functional
def test_answer_key_agrees_with_gold_and_manifest_lists_every_file(pkg):
    gold, d = pkg
    key = json.loads((d / "answer-key.json").read_text("utf-8"))
    assert key.pop("scenario") == "FULL"
    # ключ = эталон зеркала, кроме класса М-023: система сравнивает его по шкале паспорта (class-param.ts), зеркало — нет
    # и переходного списка (usability_132_pending.json): вид, чью форму генератор не рисует, — MISSING_EVIDENCE
    pend = {
        c: "MISSING_EVIDENCE"
        for c in (set(U.pending()) | U.draft_w3_codes())
        if _labels(gold)[c] != "MISSING_EVIDENCE"
    }
    assert {c: v for c, v in key.items() if v != _labels(gold)[c]} == {
        "M-023": "NEGATIVE_VERIFIED",
        **pend,
    }
    assert (
        _labels(gold)["M-023"] == "NOT_COMPARABLE"
        and sum(v == "CANDIDATE" for v in key.values()) == 14
    )
    man = json.loads((d / "manifest.json").read_text("utf-8"))
    assert man["object"]["object_id"] == U.OBJECT_ID
    files = {f["file_name"]: f["sha256"] for f in man["files"]}
    assert set(files) == {p.name for p in d.glob("*.pdf")}
    assert all(
        hashlib.sha256((d / n).read_bytes()).hexdigest() == h for n, h in files.items()
    )
    assert {f["doc_stage"] for f in man["files"]} == {"PD", "RD", "ID"}
    assert all(
        f["kind"] == "pdf" for f in gold["files"]
    )  # без сканов: объект для людей, OCR-шум замеру не нужен
    assert (
        gold["dataset_version"] == f"{U.TAG}:seed=1"
        and gold["generator"] == "ml/synth/usability_132.py"
    )


@pytest.mark.l1_functional
def test_every_doc_is_one_section_and_fits_a_sheet(pkg):
    # документ другой марки не источник значения (OS-INSP-2.2.21, discipline-fit.ts): раздел документа = раздел параметра
    obj, docs, _ = U.make_object(1)
    for d in docs:
        assert 1 <= len(d.rows) <= U.ROWS_MAX
        assert {F.MATRIX[c]["section"] for c, _ in d.rows} == {d.discipline}
    per_stage = {
        s: sorted(c for d in docs if d.stage == s for c, _ in d.rows)
        for s in ("PD", "RD", "ID")
    }
    assert all(
        v == sorted(F.MATRIX) for v in per_stage.values()
    )  # каждый параметр — ровно раз на стадию
    assert len({(d.stage, d.code) for d in docs}) == len(
        docs
    )  # шифр уникален: нет ложного конфликта редакций
    assert len({d.file_id for d in docs}) == len(docs) == 51
    assert [d.file_id for d in docs if d.stage == "RD"] == [
        f"USB-RD-{n:02d}" for n in range(1, 18)
    ]
    by = {(d.stage, d.discipline, d.code[-2:]): d for d in docs}
    pz = by[("PD", "ПЗ", ".1")]
    assert (
        pz.code.startswith("П-2099-01-") and pz.code.endswith("-ПЗ.1")
        and by[("PD", "ПЗ", ".2")].code.endswith("-ПЗ.2")
        and pz.title == "Раздел ПЗ.1. Основные показатели"
    )
    kr = by[("RD", "КР", "КР")]
    assert (
        kr.code.startswith("Р-2099-01-") and kr.code.endswith("-КР")
        and kr.status == "FOR_CONSTRUCTION"
        and kr.title == "Рабочая документация КР. Общие данные"
    )
    idd = by[("ID", "ИОС4", "С4")]
    assert (
        idd.code.startswith("2099-01-") and idd.code.endswith("-ИОС4")
        and idd.status == "APPROVED"
        and idd.title.startswith("Исполнительная документация ИОС4")
    )
    assert all(
        d.kind == "pdf" and d.revision == "1" and d.predecessor is None for d in docs
    )
    # даты по порядку стадий: ПД раньше РД, РД раньше ИД
    assert max(d.date for d in docs if d.stage == "PD") < min(
        d.date for d in docs if d.stage == "RD"
    )
    assert max(d.date for d in docs if d.stage == "RD") < min(
        d.date for d in docs if d.stage == "ID"
    )
    assert (
        obj["object_id"] == U.OBJECT_ID
        and all(obj["profile"].values())
        and len(obj["profile"]) == 4
    )
    assert obj["conflict_kr"] is False and "132 параметра" in obj["name"]
    assert sorted(
        c for c, o in obj["scenarios"].items() if o == "pos"
    ) == U.pick_violations(1)
    # нарушение — только на последней стадии, у совпадения значения стадий равны
    vals = {(d.stage, c): v for d in docs for c, v in d.rows}
    c = U.pick_violations(1)[0]
    assert vals[("PD", c)] == vals[("RD", c)] != vals[("ID", c)]


@pytest.mark.l1_functional
def test_answer_key_scenario_follows_loaded_stages():
    g = {
        "evidence_groups": [{"param": "M-001", "label": "MISSING_EVIDENCE"}],
        "files": [{"doc_stage": "PD"}, {"doc_stage": "RD"}],
    }
    assert U.answer_key(g) == {
        "M-001": "MISSING_EVIDENCE",
        "scenario": "PARTIALLY_LOADED",
    }


@pytest.mark.l3_boundary
def test_deterministic_by_seed_same_gold(pkg, tmp_path, monkeypatch):
    gold, d = pkg
    monkeypatch.setattr(F, "render_pdf", _stub_render)
    again = U.build(1, tmp_path)
    assert json.dumps(again, ensure_ascii=False) == json.dumps(gold, ensure_ascii=False)
    assert _hashes(tmp_path / U.OBJECT_ID) == _hashes(d)


@pytest.mark.l3_boundary
def test_real_render_same_bytes_by_seed(tmp_path):
    # настоящая отрисовка (reportlab invariant, растр печатей по seed): два прогона — те же SHA-256 всех файлов пакета
    a = U.build(1, tmp_path / "a")
    b = U.build(1, tmp_path / "b")
    assert (
        a == b and len(a["files"]) == 51 and sum(f["pages"] for f in a["files"]) == 153
    )
    assert _hashes(tmp_path / "a" / U.OBJECT_ID) == _hashes(
        tmp_path / "b" / U.OBJECT_ID
    )
    assert all(
        (tmp_path / "a" / U.OBJECT_ID / f["file_name"]).read_bytes()[:5] == b"%PDF-"
        for f in a["files"]
    )


@pytest.mark.l3_boundary
def test_other_seed_other_14_among_reachable():
    a, b = U.pick_violations(1), U.pick_violations(2)
    assert len(a) == len(b) == 14 and a != b
    assert set(a) | set(b) <= set(U.reachable())
    assert U.pick_violations(1) == a  # не зависит от состояния глобального random


@pytest.mark.l6_adversarial
def test_reachable_excludes_single_stage_compare_but_keeps_min_max():
    # нарушение сравнением требует двух стадий; правило min/max нарушается и одной
    one = {
        "compare": {"kind": "equal"},
        "source_pd": "ПЗ",
        "source_rd": "—",
        "source_id": "",
    }
    thr = {
        "compare": {"kind": "min", "min": 1},
        "source_pd": "ПЗ",
        "source_rd": "-",
        "source_id": None,
    }
    two = {
        "compare": {"kind": "decrease"},
        "source_pd": "ПЗ",
        "source_rd": "АР",
        "source_id": None,
    }
    none = {
        "compare": {"kind": "min", "min": 1},
        "source_pd": "—",
        "source_rd": None,
        "source_id": None,
    }
    assert [U.is_reachable(p) for p in (one, thr, two, none)] == [
        False,
        True,
        True,
        False,
    ]
    assert U.reachable() and set(U.reachable()) <= set(F.MATRIX)


@pytest.mark.l2_differential
def test_detectable_matches_decide_on_the_object(pkg):
    # детектор достижимости согласован с эталоном: всё, что он пропускает, эталон в объекте видит как нарушение
    gold, _ = pkg
    labels = _labels(gold)
    assert all(U.detectable(c) for c, v in labels.items() if v == "CANDIDATE")
    assert not any(U.detectable(c) for c, v in labels.items() if v == "NOT_COMPARABLE")


@pytest.mark.l3_boundary
def test_chunks_split_section_by_rows_max():
    ch = U.chunks([f"M-{i:03d}" for i in range(1, 133)])
    assert [c for _, part in ch for c in part] == sorted(
        F.MATRIX, key=lambda c: (F.MATRIX[c]["section"], c)
    )
    assert all(1 <= len(part) <= U.ROWS_MAX for _, part in ch)
    # ПЗ (23 параметра) — два документа поровну, 12 + 11, а не 22 + 1; остальные разделы — по одному
    assert [len(p) for s, p in ch if s == "ПЗ"] == [12, 11]
    assert len(ch) == len({F.MATRIX[c]["section"] for c in F.MATRIX}) + 1
    assert U.chunks(["M-001"]) == [("ПЗ", ["M-001"])] and U.chunks([]) == []


@pytest.mark.l1_functional
def test_cli_writes_package(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(F, "render_pdf", _stub_render)
    U.main(["--seed", "3", "--out", str(tmp_path)])
    d = tmp_path / U.OBJECT_ID
    assert {"gold.json", "answer-key.json", "manifest.json"} <= {
        p.name for p in d.iterdir()
    }
    key = json.loads((d / "answer-key.json").read_text("utf-8"))
    assert sorted(c for c, v in key.items() if v == "CANDIDATE") == U.pick_violations(3)
    assert "132 параметра, 14 нарушений" in capsys.readouterr().out


@pytest.mark.l1_functional
def test_passport_labels_are_readable_and_pool_restored(pkg):
    # М-005 читается по якорю паспорта «…подземной части»; общий пул фабрики после сборки прежний (v2/v3 не меняются)
    gold, _ = pkg
    import re

    anchor = json.loads((F.ROOT / "data/seed/passports/M-005.json").read_text("utf-8"))[
        "extractor"
    ]["anchor"]
    text = "\n".join(p["text"] for p in gold["pages"])
    assert (
        re.search(anchor, U.LABELS["M-005"], re.IGNORECASE)
        and U.LABELS["M-005"] in text
    )
    assert F.POOL["M-005"]["label"] == "Строительный объем (Подземный)"


@pytest.mark.l6_adversarial
def test_system_label_class_violation_and_non_class_untouched(pkg):
    gold, _ = pkg
    g = next(e for e in gold["evidence_groups"] if e["param"] == "M-023")
    assert U.system_label(g, gold) == "NEGATIVE_VERIFIED"
    # тот же класс хуже на ИД — кандидат по шкале паспорта (С3 хуже С2)
    last = g["evidence"][-1]
    worse = {
        **gold,
        "values": [
            {**v, "raw": "С3"}
            if (v["file_id"], v["param"]) == (last["file_id"], "M-023")
            else v
            for v in gold["values"]
        ],
    }
    assert U.system_label(g, worse) == "CANDIDATE"
    other = next(e for e in gold["evidence_groups"] if e["param"] == "M-072")
    assert (
        U.ordinal_scale("M-072") is None
        and U.system_label(other, gold) == "NOT_COMPARABLE"
    )
    assert U.ordinal_scale("M-001") is None  # паспорт количества, не шкала
