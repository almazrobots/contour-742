"""Генератор мутаций L11 (T-179, OS-INSP-6.5.40–6.5.43): детерминизм, истина по правилу Матрицы, семейства MUT/NEG,
рамка значения на листе, счёт примеров на оператор. Имя теста — то, на что ссылается трасса (model.yaml → impl)."""

from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter
from pathlib import Path

import pytest

from eval.metrics import iou
from inspector_ml.parse import parse_file
from synth import mutations as G

REG = G.load_registry()


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _truth(mut, target, pos, variant=None, modifier=None, idx=0, reg=REG):
    case, docs = G.make_case(reg, 3, idx, mut, target, pos, variant, modifier)
    return (
        case,
        docs,
        {(t["code"], t["operator"]): t for t in G.truth_for(case, docs, reg)},
    )


@pytest.mark.l1_functional
def test_registry_is_data_and_rejects_unknown_kind_and_duplicate_pair(tmp_path):
    assert {p["kind"] for p in REG["params"]} <= G.KINDS
    bad = copy.deepcopy(REG)
    bad["params"][0]["kind"] = "geometry"
    (tmp_path / "a.json").write_text(json.dumps(bad), "utf-8")
    with pytest.raises(ValueError, match="не известен генератору"):
        G.load_registry(tmp_path / "a.json")
    dup = copy.deepcopy(REG)
    dup["params"].append(copy.deepcopy(dup["params"][0]))
    (tmp_path / "b.json").write_text(json.dumps(dup), "utf-8")
    with pytest.raises(ValueError, match="повторяется"):
        G.load_registry(tmp_path / "b.json")
    other = copy.deepcopy(REG) | {"schema": "x/1"}
    (tmp_path / "c.json").write_text(json.dumps(other), "utf-8")
    with pytest.raises(ValueError, match="схема"):
        G.load_registry(tmp_path / "c.json")


@pytest.mark.l3_boundary
def test_number_and_class_formats():
    assert G.fmt_num(3009.4) == "3 009,4"
    assert G.fmt_num(3009.4, "tight") == "3009,4"
    assert G.fmt_num(3009.4, "dot") == "3009.4"
    assert G.fmt_num(3009.4, "zeros") == "3 009,40"
    assert G.fmt_num(12345678.0) == "12 345 678,0"
    assert G.fmt_class("С1") == "С1"
    assert G.fmt_class("С1", "latin") == "C1" and G.fmt_class("С1", "latin")[0] == "C"
    assert G.fmt_class("С1", "space") == "С 1"


@pytest.mark.l3_boundary
def test_truth_rule_abs_pct_decrease_rank_at_boundaries():
    p = {
        c: next(x for x in REG["params"] if x["code"] == c and x["wired"])
        for c in ("M-001", "M-002", "M-003", "M-023")
    }
    assert not G.rule_breaks(
        p["M-001"], 100.0, 100.05
    )  # половина разряда — не нарушение
    assert G.rule_breaks(p["M-001"], 100.0, 100.1) and G.rule_breaks(
        p["M-001"], 100.0, 99.9
    )
    assert not G.rule_breaks(p["M-002"], 1000.0, 1010.0)  # ровно 1 % — не больше 1 %
    assert G.rule_breaks(p["M-002"], 1000.0, 1010.1) and G.rule_breaks(
        p["M-002"], 1000.0, 989.9
    )
    assert G.rule_breaks(p["M-003"], 500.0, 499.9) and not G.rule_breaks(
        p["M-003"], 500.0, 600.0
    )  # только уменьшение
    assert (
        G.rule_breaks(p["M-023"], "С0", "С1")
        and not G.rule_breaks(p["M-023"], "С1", "С0")
        and not G.rule_breaks(p["M-023"], "С1", "С1")
    )
    with pytest.raises(ValueError):
        G.rule_breaks({"rule": {"type": "median"}}, 1, 2)


@pytest.mark.l5_property
def test_deterministic_by_seed_same_truth_and_pdf_bytes(tmp_path):
    a = G.build(tmp_path / "a", 5, 0.05, limit=6)
    b = G.build(tmp_path / "b", 5, 0.05, limit=6)
    assert a == b
    for c in a["cases"]:
        for f in c["files"]:
            assert (
                _sha(tmp_path / "a" / c["case_id"] / f["file_name"])
                == _sha(tmp_path / "b" / c["case_id"] / f["file_name"])
                == f["sha256"]
            )
    other = G.build(tmp_path / "c", 6, 0.05, limit=6)
    assert [t["pd_value"] for t in other["truth"]] != [
        t["pd_value"] for t in a["truth"]
    ]


@pytest.mark.l1_functional
def test_mut05_changes_only_target_in_rd_and_truth_follows_rule():
    for idx in range(12):
        case, docs, tr = _truth("MUT-05", ("M-002", "CMP-02"), True, idx=idx)
        pd, rd = docs[0].values, docs[1].values
        assert [c for c in pd.q if pd.q[c] != rd.q[c]] == ["M-002"] and pd.cls == rd.cls
        assert (
            tr[("M-002", "CMP-02")]["polarity"] == "pos"
            and tr[("M-002", "CMP-02")]["target"]
        )
        assert abs(rd.q["M-002"] - pd.q["M-002"]) / pd.q["M-002"] > 0.01
        assert all(
            t["polarity"] == "neg"
            for k, t in tr.items()
            if k != ("M-002", "CMP-02") and t["wired"]
        )
        _, docs, tr = _truth("MUT-05", ("M-003", "CMP-03"), False, idx=idx)
        assert (
            tr[("M-003", "CMP-03")]["polarity"] == "neg"
        )  # формат или рост полезной площади — не нарушение
        assert docs[1].values.q["M-003"] >= docs[0].values.q["M-003"]


@pytest.mark.l1_functional
def test_mut06_downgrade_positive_upgrade_or_format_negative():
    seen = Counter()
    for idx in range(20):
        _, docs, tr = _truth("MUT-06", ("M-023", "CMP-04"), True, idx=idx)
        sc = REG["params"][5]["scale"]
        assert (
            sc.index(docs[1].values.cls["M-023"])
            < sc.index(docs[0].values.cls["M-023"])
            and tr[("M-023", "CMP-04")]["polarity"] == "pos"
        )
        case, docs, tr = _truth("MUT-06", ("M-023", "CMP-04"), False, idx=idx)
        seen[case["variant"]] += 1
        assert tr[("M-023", "CMP-04")]["polarity"] == "neg"
    assert set(seen) == {"upgrade", "format"}


@pytest.mark.l6_adversarial
def test_mut18_stale_conflict_swap_registry_traps():
    case, docs, tr = _truth(
        "MUT-06", ("M-023", "CMP-04"), True, modifier="MUT-18/stale"
    )
    old, new = docs[1], docs[2]
    assert new.predecessor == old.file_id and case["rd_current"] == [new.file_id]
    assert (
        old.values.cls != new.values.cls == docs[0].values.cls
    )  # нарушение только в устаревшей
    t = tr[("M-023", "CMP-04")]
    assert t["polarity"] == "neg" and t["tags"] == ["superseded"] and not t["pending"]
    case, docs, tr = _truth(
        "MUT-05", ("M-001", "CMP-01"), True, modifier="MUT-18/conflict"
    )
    assert docs[1].predecessor is None and docs[2].predecessor is None
    assert all(
        t["expected"] == ["CLARIFICATION_REQUIRED"] for t in tr.values() if t["wired"]
    )
    _, docs, tr = _truth("MUT-05", ("M-001", "CMP-01"), True, modifier="MUT-18/swap")
    assert docs[1].predecessor == docs[2].file_id  # реестр: старая «заменяет» новую
    assert all(t["pending"] and "IDN-12" in t["requires"] for t in tr.values())


@pytest.mark.l1_functional
def test_mut17_cloud_waits_for_cmp29_other_params_stay_measured():
    _, docs, tr = _truth("MUT-05", ("M-004", "CMP-01"), True, modifier="MUT-17")
    t = tr[("M-004", "CMP-01")]
    assert (
        docs[1].values.cloud == "M-004" and t["pending"] and "CMP-29" in t["requires"]
    )
    assert t["expected"] == ["NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED"]
    assert (
        not tr[("M-001", "CMP-01")]["pending"]
        and tr[("M-001", "CMP-01")]["polarity"] == "neg"
    )
    reg = copy.deepcopy(REG) | {
        "implemented": ["CMP-29"]
    }  # T-177 влил CMP-29 — пример уходит в метрики
    _, _, tr = _truth("MUT-05", ("M-004", "CMP-01"), True, modifier="MUT-17", reg=reg)
    assert not tr[("M-004", "CMP-01")]["pending"]


@pytest.mark.l1_functional
def test_mut12_room_added_total_changed_positive_above_one_percent():
    for idx in range(10):
        case, docs, tr = _truth("MUT-12", ("M-002", "CMP-02"), True, idx=idx)
        pd, rd = docs[0].values, docs[1].values
        added = rd.rooms[-1][2]
        assert (
            len(rd.rooms) == len(pd.rooms) + 1
            and round(rd.q["M-002"] - pd.q["M-002"], 1) == added
        )
        assert (
            tr[("M-002", "CMP-02")]["polarity"] == "pos"
            and tr[("M-002", "CMP-10")]["polarity"] == "pos"
            and tr[("M-002", "CMP-10")]["pending"]
        )
        assert tr[("M-003", "CMP-03")]["polarity"] == "neg"
        _, docs, tr = _truth("MUT-12", ("M-002", "CMP-02"), False, idx=idx)
        assert tr[("M-002", "CMP-02")]["polarity"] == "neg"


@pytest.mark.l1_functional
def test_text_layer_mutations_07_08_11_01_02_are_pending_and_cross_negative():
    for mut, target, variant, check in (
        (
            "MUT-07",
            ("M-109", "CMP-04"),
            None,
            lambda pd, rd: "FRLS" not in rd.mark and "FRLS" in pd.mark,
        ),
        (
            "MUT-08",
            ("M-125", "CMP-21"),
            "thin",
            lambda pd, rd: rd.layers[1][1] < pd.layers[1][1],
        ),
        (
            "MUT-08",
            ("M-125", "CMP-21"),
            "drop",
            lambda pd, rd: len(rd.layers) == len(pd.layers) - 1,
        ),
        (
            "MUT-11",
            ("M-003", "CMP-23"),
            None,
            lambda pd, rd: (
                [r[1] for r in rd.rooms] != [r[1] for r in pd.rooms]
                and [r[2] for r in rd.rooms] == [r[2] for r in pd.rooms]
            ),
        ),
        (
            "MUT-01",
            ("M-077", "CMP-20"),
            "MUT-01",
            lambda pd, rd: len(rd.branches) == len(pd.branches) - 1,
        ),
        (
            "MUT-02",
            ("M-077", "CMP-20"),
            "MUT-02",
            lambda pd, rd: (
                len(rd.branches) == len(pd.branches) and rd.branches != pd.branches
            ),
        ),
    ):
        _, docs, tr = _truth(mut, target, True, variant)
        assert check(docs[0].values, docs[1].values), mut
        assert tr[target]["polarity"] == "pos" and tr[target]["pending"]
        assert all(
            t["polarity"] == "neg" and not t["pending"]
            for t in tr.values()
            if t["wired"]
        ), mut


@pytest.mark.l6_adversarial
def test_negative_controls_self_stamp_only_detail():
    _, docs, tr = _truth("NEG-01", None, False)
    assert docs[0].values == docs[1].values
    case, docs, tr = _truth("NEG-02", None, False)
    a, b = docs[1], docs[2]
    assert (
        a.values == b.values == docs[0].values
        and b.predecessor == a.file_id
        and (a.revision, a.date) != (b.revision, b.date)
    )
    _, docs, tr = _truth("NEG-03", None, False)
    assert docs[1].values.detail and docs[1].values.q == docs[0].values.q
    for mut in ("NEG-01", "NEG-02", "NEG-03"):
        _, _, tr = _truth(mut, None, False)
        assert all(t["polarity"] == "neg" for t in tr.values())


@pytest.mark.l1_functional
def test_full_plan_gives_100_pos_and_100_neg_per_wired_operator():
    cnt: Counter = Counter()
    for i, (mut, target, pos, variant, modifier) in enumerate(G.plan(REG, 7, 1.0)):
        case, docs = G.make_case(REG, 7, i, mut, target, pos, variant, modifier)
        for t in G.truth_for(case, docs, REG):
            if not t["pending"]:
                cnt[(t["operator"], t["polarity"])] += 1
    for op in ("CMP-01", "CMP-02", "CMP-03", "CMP-04"):
        assert cnt[(op, "pos")] >= 100 and cnt[(op, "neg")] >= 100, (op, cnt)


@pytest.mark.l2_differential
def test_rendered_value_is_in_text_layer_at_truth_bbox(tmp_path):
    ds = G.build(tmp_path, 4, 0.05, limit=3)
    for t in (
        x for x in ds["truth"] if x["code"] in ("M-002", "M-023") and x["evidence"]
    ):
        e = t["evidence"][0]
        case = next(c for c in ds["cases"] if c["case_id"] == t["case_id"])
        f = next(f for f in case["files"] if f["file_id"] == e["file_id"])
        doc = parse_file(tmp_path / case["case_id"] / f["file_name"], f["sha256"])
        words = [w for ln in doc.pages[e["page"] - 1].lines for w in ln.words]
        best = max(words, key=lambda w: iou(w.bbox, e["bbox"]))
        assert iou(best.bbox, e["bbox"]) >= 0.5, (t["case_id"], t["code"], best.text, e)
        assert best.text.replace("C", "С").rstrip(".") in e["raw"].replace(
            " ", ""
        ) or e["raw"].replace("C", "С").startswith(best.text.rstrip("."))


@pytest.mark.l1_functional
def test_dataset_files_carry_manifest_and_truth_values(tmp_path):
    ds = G.build(tmp_path, 2, 0.05, limit=2)
    c = ds["cases"][0]
    man = json.loads((tmp_path / c["case_id"] / "manifest.json").read_text("utf-8"))
    assert [f["file_id"] for f in man["files"]] == [f["file_id"] for f in c["files"]]
    assert {f["doc_stage"] for f in c["files"]} == {"PD", "RD"}
    assert set(c["files"][0]["truth_values"]) == {
        "M-001",
        "M-002",
        "M-003",
        "M-004",
        "M-005",
        "M-007",
        "M-010",
        "M-023",
    }
    assert ds["schema"] == G.SCHEMA and ds["dataset_version"].startswith(
        "mutations-w1:seed=2"
    )


@pytest.mark.l6_adversarial
def test_cloud_and_detail_render_keep_values_readable(tmp_path):
    """MUT-17 облако вокруг значения и NEG-03 подстроки ТЭП: текст листа несёт примечание и уточнения, а значения
    параметров читаются экстрактором паспорта так же, как без них."""
    from inspector_ml.extract import extract
    from inspector_ml.model import ParamSpec

    from inspector_ml.paths import repo_root

    root = (
        repo_root()
    )  # не parents[2]: песочница mutmut (ml/mutants/) на уровень глубже исходников
    specs = []
    for code in ("M-002", "M-004", "M-023"):
        pp = json.loads((root / f"data/seed/passports/{code}.json").read_text("utf-8"))
        ex = dict(pp["extractor"])
        if pp["value"]["kind"] == "ordinal":
            ex |= {
                "scale": pp["value"]["scale"],
                "constraint_markers": pp["value"]["constraint_markers"],
            }
        specs.append(ParamSpec(code=code, anchors=[pp["title"]], extractor=ex))
    for mut, target, modifier in (
        ("MUT-05", ("M-004", "CMP-01"), "MUT-17"),
        ("MUT-06", ("M-023", "CMP-04"), "MUT-17"),
        ("NEG-03", None, None),
    ):
        case, docs = G.make_case(REG, 9, 1, mut, target, True, None, modifier)
        rd = docs[-1]
        path = tmp_path / f"{mut}-{modifier}.pdf"
        G.render(rd, REG, path)
        doc = parse_file(path, _sha(path))
        text = " ".join(ln.text for p in doc.pages for ln in p.lines)
        if modifier:
            assert "Изм. 1" in text and rd.values.cloud == target[0]
        else:
            assert (
                "Площадь квартир" in text
                and "Класс пожарной опасности строительных конструкций" in text
            )
        got = {
            e.code: (e.value_num if e.value_num is not None else e.value_text)
            for e in extract(doc, specs)
            if not (e.meta or {}).get("excluded")
        }
        assert got == {
            "M-002": rd.values.q["M-002"],
            "M-004": rd.values.q["M-004"],
            "M-023": rd.values.cls["M-023"],
        }, (mut, got)


@pytest.mark.l1_functional
def test_count_kind_integers_mut05_mut12_and_negatives():
    """Вид count (T-175: этажность, квартиры, окна): MUT-05 ±1/±k, MUT-12 — строка разбивки и итог; отрицательные —
    «шт.»/«ед.» при том же числе, перестановка строк ТЭП или разбивки при той же сумме."""
    t10 = ("M-010", "CMP-07")
    seen = Counter()
    for idx in range(24):
        _, docs, tr = _truth("MUT-05", t10, True, idx=idx)
        pd, rd = docs[0].values, docs[1].values
        assert rd.n["M-010"] != pd.n["M-010"] and isinstance(rd.n["M-010"], int) and tr[t10]["polarity"] == "pos"
        assert sum(x for _, x in rd.breakdown["M-010"]) == rd.n["M-010"]  # документ согласован внутри
        assert [c for c in pd.q if pd.q[c] != rd.q[c]] == [] and pd.n["M-007"] == rd.n["M-007"]
        case, docs, tr = _truth("MUT-05", t10, False, idx=idx)
        pd, rd = docs[0].values, docs[1].values
        seen[case["variant"]] += 1
        assert rd.n == pd.n and tr[t10]["polarity"] == "neg"
        if case["variant"] == "format":
            assert rd.nfmt["M-010"] in ("sht", "ed")
        elif case["variant"] == "permute_rows":
            assert rd.row_order and sorted(rd.row_order) == sorted(c for c in {**pd.q, **pd.n})
        else:
            assert sorted(map(tuple, rd.breakdown["M-010"])) == sorted(map(tuple, pd.breakdown["M-010"])) != [tuple(r) for r in rd.breakdown["M-010"]]
        case, docs, tr = _truth("MUT-12", t10, True, idx=idx)
        pd, rd = docs[0].values, docs[1].values
        assert rd.breakdown["M-010"][-1][0] == "4-комнатные" and rd.n["M-010"] - pd.n["M-010"] == rd.breakdown["M-010"][-1][1] >= 1
        assert tr[t10]["polarity"] == "pos" and tr[t10]["pending"]  # оператор CMP-07 ещё не подключён (T-175)
        _, docs, tr = _truth("MUT-12", t10, False, idx=idx)
        assert docs[1].values.n == docs[0].values.n and tr[t10]["polarity"] == "neg"
    assert set(seen) == {"format", "permute_rows", "permute_breakdown"}
    assert G.fmt_count(16) == "16" and G.fmt_count(16, "sht") == "16 шт." and G.fmt_count(16, "ed") == "16 ед."
    _, docs, tr = _truth("MUT-05", ("M-007", "CMP-07"), True)
    assert abs(docs[1].values.n["M-007"] - docs[0].values.n["M-007"]) >= 1 and "M-007" not in docs[0].values.breakdown


@pytest.mark.l6_adversarial
def test_permuted_tep_rows_and_count_formats_keep_quantity_values_readable(tmp_path):
    """Перестановка строк ТЭП и «шт.» у целых не меняют того, что читают экстракторы М-001…М-005: иначе отрицательный
    пример стал бы ложной тревогой из-за разметки листа, а не оператора."""
    from inspector_ml.extract import extract
    from inspector_ml.model import ParamSpec
    from inspector_ml.paths import repo_root

    specs = []
    for code in ("M-001", "M-002", "M-003", "M-004", "M-005"):
        pp = json.loads((repo_root() / f"data/seed/passports/{code}.json").read_text("utf-8"))
        specs.append(ParamSpec(code=code, anchors=[pp["title"]], extractor=dict(pp["extractor"])))
    hit = 0
    for idx in range(12):
        case, docs = G.make_case(REG, 11, idx, "MUT-05", ("M-010", "CMP-07"), False)
        if case["variant"] != "permute_rows":
            continue
        hit += 1
        rd = docs[1]
        path = tmp_path / f"{idx}.pdf"
        G.render(rd, REG, path)
        doc = parse_file(path, _sha(path))
        got = {e.code: e.value_num for e in extract(doc, specs) if not (e.meta or {}).get("excluded")}
        assert got == {c: rd.values.q[c] for c in got} and set(got) == set(rd.values.q), (idx, rd.values.row_order, got)
    assert hit


ADV = G.load_adversarial()


@pytest.mark.l1_functional
def test_adversarial_holdout_is_data_independent_per_document_and_keeps_truth():
    """Профиль adversarial: формулировка у каждого документа своя (ПД и РД — разные авторы), истина — та же, что у
    structural для того же примера: меняется запись на листе, а не значения."""
    differ = 0
    for idx in range(20):
        c1, d1 = G.make_case(REG, 29, idx, "MUT-05", ("M-002", "CMP-02"), True)
        c2, d2 = G.make_case(REG, 29, idx, "MUT-05", ("M-002", "CMP-02"), True, adversarial=ADV)
        assert [d.values.q for d in d1] == [d.values.q for d in d2] and [d.values.cls for d in d1] == [d.values.cls for d in d2]
        assert d1[0].values.adv is None and d2[0].values.adv and d2[1].values.adv
        differ += d2[0].values.adv["q"]["M-002"] != d2[1].values.adv["q"]["M-002"]
        again = G.make_case(REG, 29, idx, "MUT-05", ("M-002", "CMP-02"), True, adversarial=ADV)[1]
        assert G.style_summary(again[1].values.adv) == G.style_summary(d2[1].values.adv)  # детерминизм по seed
    assert differ >= 15
    assert G.style_summary(None) is None
    with pytest.raises(ValueError, match="схема"):
        bad = Path(REG_TMP := __import__("tempfile").mkstemp(suffix=".json")[1])
        bad.write_text('{"schema": "x/1"}', "utf-8")
        G.load_adversarial(bad)


@pytest.mark.l6_adversarial
def test_adversarial_value_noise_and_ocr2_transformations():
    assert G._class_value("С1", "latin", ADV) == "C1" and G._class_value("С1", "space", ADV) == "С 1"
    assert G._class_value("С0", "o_for_zero", ADV) == "СО" and G._class_value("С1", "o_for_zero", ADV) == "С1"
    assert G._class_value("С1", "l_for_one", ADV) == "Сl" and G._class_value("С2", "l_for_one", ADV) == "С2"
    assert G._class_value("С2", None, ADV) == "С2"
    assert G._ocr2("Площадь застройки", "glue_words", "M-001") == "Площадьзастройки"
    assert G._ocr2("Площадь застройки", "homoglyph_label", "M-001") == "Плoщадь застройки"
    assert G._ocr2("Площадь", None, "M-001") == "Площадь" and G._ocr2("Площадь", "glue_words", "x") == "Площадь"
    assert G.fmt_num(3009.4, "nbsp") == "3 009,4"


@pytest.mark.l1_functional
def test_external_phraser_plugs_in_when_merged_and_is_reported_when_not(tmp_path, monkeypatch):
    """Отложенные наборы веток (T-172 и др.) подключаются «модуль:функция»; не влитый — пометка, а не падение."""
    import sys
    import types

    mod = types.ModuleType("t172_holdout_fake")
    mod.phrase = lambda code, rng: "Класс КПО здания принят {V}." if code == "M-023" else None
    monkeypatch.setitem(sys.modules, "t172_holdout_fake", mod)
    cfg = json.loads(G.ADVERSARIAL.read_text("utf-8"))
    cfg["external"]["phrasers"] = ["t172_holdout_fake:phrase", "eval.not_merged_yet:phrase"]
    path = tmp_path / "adv.json"
    path.write_text(json.dumps(cfg, ensure_ascii=False), "utf-8")
    adv = G.load_adversarial(path)
    assert adv["external_status"]["t172_holdout_fake:phrase"] == "подключён"
    assert adv["external_status"]["eval.not_merged_yet:phrase"].startswith("не подключён")
    seen = {G.pick_style(adv, REG, __import__("random").Random(i))["cls"]["M-023"]["phrase"] for i in range(60)}
    assert "Класс КПО здания принят {V}." in seen


@pytest.mark.l2_differential
def test_adversarial_render_marks_value_where_text_layer_has_it(tmp_path):
    """Рамка истины в отложенных раскладках (строкой ниже, фразой, ячейкой, с переносом) стоит на значении: слово
    текстового слоя в этой рамке содержит цифры значения."""
    checked = Counter()
    for idx in range(16):
        _, docs = G.make_case(REG, 31, idx, "MUT-06", ("M-023", "CMP-04"), True, adversarial=ADV)
        for d in docs:
            path = tmp_path / f"{idx}-{d.file_id}.pdf"
            G.render(d, REG, path)
            doc = parse_file(path, _sha(path))
            for code in ("M-001", "M-002", "M-004", "M-023"):
                m = d.marks[code][0]
                words = [w for ln in doc.pages[m["page"] - 1].lines for w in ln.words if iou(w.bbox, m["bbox"]) > 0]
                digit = [ch for ch in m["raw"] if ch.isdigit()][-1]
                assert any(digit in w.text for w in words), (idx, code, m, [w.text for w in words])
                if code != "M-023":
                    checked[d.values.adv["q"][code]["layout"]] += 1
    assert set(checked) == set(ADV["quantity"]["layouts"])


@pytest.mark.l1_functional
def test_plan_counts_follow_registry_exactly_and_light_keeps_one_of_each():
    """План — ровно счётчики реестра: MUT-05/06/12 pos и neg, MUT-18 по видам, MUT-17, MUT-08 по вариантам, MUT-01/02,
    контроли NEG; лёгкий профиль — по одному примеру на каждый ненулевой счётчик."""
    reg = {"params": [
        {"code": "M-001", "operator": "CMP-01", "kind": "quantity", "counts": {"MUT-05": {"pos": 3, "neg": 2}, "MUT-18": {"stale": 2, "conflict": 1, "swap": 0}, "MUT-17": 2}},
        {"code": "M-023", "operator": "CMP-04", "kind": "class", "counts": {"MUT-06": {"pos": 1, "neg": 0}, "MUT-18": {"stale": 1}, "MUT-17": 1}},
        {"code": "M-125", "operator": "CMP-21", "kind": "layers", "counts": {"MUT-08": {"thin": 2, "drop": 1}}},
        {"code": "M-077", "operator": "CMP-20", "kind": "branches", "counts": {"MUT-01": 1, "MUT-02": 2}},
        {"code": "M-109", "operator": "CMP-04", "kind": "mark", "counts": {"MUT-07": 2}},
    ], "negatives": {"NEG-01": 2, "NEG-03": 1}}
    q, c = ("M-001", "CMP-01"), ("M-023", "CMP-04")
    assert Counter(G.plan(reg, 1)) == Counter({
        ("MUT-05", q, True, None, None): 3, ("MUT-05", q, False, None, None): 2,
        ("MUT-05", q, True, None, "MUT-18/stale"): 2, ("MUT-05", q, True, None, "MUT-18/conflict"): 1, ("MUT-05", q, True, None, "MUT-17"): 2,
        ("MUT-06", c, True, None, None): 1, ("MUT-06", c, True, None, "MUT-18/stale"): 1, ("MUT-06", c, True, None, "MUT-17"): 1,
        ("MUT-08", ("M-125", "CMP-21"), True, "thin", None): 2, ("MUT-08", ("M-125", "CMP-21"), True, "drop", None): 1,
        ("MUT-01", ("M-077", "CMP-20"), True, "MUT-01", None): 1, ("MUT-02", ("M-077", "CMP-20"), True, "MUT-02", None): 2,
        ("MUT-07", ("M-109", "CMP-04"), True, None, None): 2, ("NEG-01", None, False, None, None): 2, ("NEG-03", None, False, None, None): 1,
    })
    light = Counter(G.plan(reg, 1, 0.01))
    assert set(light.values()) == {1} and len(light) == 15
    assert Counter(G.plan(reg, 1, 0.5))[("MUT-05", q, True, None, None)] == 2  # round(1,5) → 2, ноль остаётся нулём


@pytest.mark.l3_boundary
def test_quantity_mutation_magnitudes_by_rule():
    """MUT-05 для чисел: abs — хотя бы один разряд 0,1; pct — от 1,2 % (pos) и до 0,8 % (within); decrease — только вниз,
    улучшение — только вверх; форматы — без изменения числа."""
    p = {x["code"]: x for x in REG["params"] if x["wired"] and x["kind"] == "quantity"}
    seen = Counter()
    for i in range(80):
        rng = __import__("random").Random(i)
        for code in ("M-001", "M-002", "M-003"):
            v = G.base_values(REG, __import__("random").Random(i))
            ref = v.q[code]
            var = G._q_mutation(p[code], v, rng, True)
            d = round(v.q[code] - ref, 1)
            seen[(code, var)] += 1
            assert G.rule_breaks(p[code], ref, v.q[code]), (code, var, ref, v.q[code])
            if var == "one_digit":
                assert abs(d) == 0.1
            else:
                assert abs(d) > 0.1
            if code == "M-002":
                assert 0.012 * ref - 0.1 <= abs(d) <= 0.15 * ref + 0.1
            if code == "M-003":
                assert d < 0
            v = G.base_values(REG, __import__("random").Random(i))
            var = G._q_mutation(p[code], v, rng, False)
            seen[(code, var)] += 1
            assert not G.rule_breaks(p[code], ref, v.q[code])
            if var == "format":
                assert v.q[code] == ref and v.qfmt[code] in ("tight", "dot", "zeros")
            elif var == "within":
                assert 0 < abs(v.q[code] - ref) <= 0.008 * ref + 0.1 and code == "M-002"
            else:
                assert var == "improve" and v.q[code] > ref and code == "M-003"
    assert {k for k in seen} >= {("M-001", "one_digit"), ("M-001", "above_tolerance"), ("M-001", "format"), ("M-002", "within"), ("M-003", "improve")}
    assert ("M-001", "within") not in seen and ("M-001", "improve") not in seen and ("M-002", "improve") not in seen


@pytest.mark.l1_functional
def test_cloud_scallops_surround_value_and_number_triangle():
    """Облако MUT-17: гребешки лежат вокруг рамки значения (снаружи неё, в пределах 6 мм), треугольник и номер «1» справа."""
    spec = G.PageSpec()
    box = (100.0, 50.0, 120.0, 54.0)
    G._cloud(spec, box, "1")
    lines = [o for o in spec.ops if isinstance(o, G.LineOp)]
    texts = [o for o in spec.ops if isinstance(o, G.TextOp)]
    assert len(lines) >= 20 and [t.text for t in texts] == ["1"] and texts[0].x > box[2]
    pts = [(o.x0, o.y0) for o in lines[:-3]] + [(o.x1, o.y1) for o in lines[:-3]]
    for x, y in pts:
        assert box[0] - 6 <= x <= box[2] + 6 and box[1] - 6 <= y <= box[3] + 6
        assert not (box[0] < x < box[2] and box[1] < y < box[3])  # внутрь значения облако не заходит
    tri = lines[-3:]
    assert all(o.width == 0.35 for o in lines) and min(o.x0 for o in tri) >= box[2] + 3


@pytest.mark.l1_functional
def test_doc_codes_names_and_build_metadata(tmp_path):
    d = G._doc("MUT-5-0001", "5-0001", "PD", "1", "APPROVED", "10.02.2026", None, G.base_values(REG, __import__("random").Random(1)), 1)
    assert (d.file_id, d.code, d.discipline, d.file_name) == ("MUT-5-0001-pd1", "П-5-0001-ПЗ", "ПЗ", "П-5-0001-ПЗ изм1.pdf")
    r = G._doc("MUT-5-0001", "5-0001", "RD", "2", "FOR_CONSTRUCTION", "17.05.2026", "MUT-5-0001-rd1", d.values, 2)
    assert (r.file_id, r.code, r.discipline, r.predecessor, r.revision) == ("MUT-5-0001-rd2", "Р-5-0001-АР", "АР", "MUT-5-0001-rd1", "2")
    ds = G.build(tmp_path / "s", 5, 0.05, limit=2)
    assert ds["seed"] == 5 and ds["scale"] == 0.05 and len(ds["registry_sha256"]) == 16 and ds["external_phrasers"] == {}
    assert ds["dataset_version"] == "mutations-w1:seed=5:scale=0.05:n=2"
    assert all(f["style"] is None for c in ds["cases"] for f in c["files"])
    adv = G.build(tmp_path / "a", 5, 0.05, limit=1, adversarial=ADV)
    assert adv["dataset_version"].startswith("mutations-w1:adv:seed=5") and adv["cases"][0]["files"][0]["style"]["q"]
    assert json.loads((tmp_path / "s" / "dataset.json").read_text("utf-8")) == ds
