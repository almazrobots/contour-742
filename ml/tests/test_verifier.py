"""Верификатор извлечения (T-076, OS-INSP-6.4.12–6.4.15). Только синтетика: строки ТЭП с верными значениями
и типовыми ошибками извлечения, которые учитель отмечает REJECT."""

from __future__ import annotations

import hashlib
import math
import random

import numpy as np
import pytest

from inspector_ml import verifier as V

GOOD = [
    ("M-001", "Площадь застройки", "м²", "Площадь застройки {v} м²"),
    ("M-003", "Общая площадь здания", "м²", "Общая площадь здания — {v} м²"),
    ("M-005", "Строительный объем", "м³", "Строительный объем {v} м³"),
]
BAD = [  # (шаблон, как значение попадает в извлечение)
    "Количество этажей 17, в том числе подземных {v}",
    "Площадь по п. {v} СП 54.13330",
    "Разработано в {v} году, площадь застройки уточняется",
    "Площадь не менее {v} м² согласно требованиям норматива",
]


def item(i: int, obj: str, good: bool, split: str) -> dict:
    rnd = random.Random(i)
    code, name, unit, tpl = rnd.choice(GOOD)
    if good:
        v = str(rnd.randint(150, 90000))
        line = tpl.format(v=v)
    else:
        v = str(rnd.choice([0, 1, 2, 3, 4, 2019, 2024, 5, 7]))
        line = rnd.choice(BAD).format(v=v)
    return {
        "item_id": hashlib.sha256(f"{i}".encode()).hexdigest()[:16],
        "object": obj,
        "split": split,
        "label": "ACCEPT" if good else "REJECT",
        "section": "ПЗ",
        "code": code,
        "parameter_name": name,
        "unit": unit,
        "data_type": "number",
        "raw": v,
        "value_num": float(v),
        "line_text": line,
        "confidence": round(0.9 + rnd.random() * 0.1, 3),
        "match": "lexical",
        "page_source": "text",
    }


def dataset(n: int = 240) -> list[dict]:
    splits = ["train"] * 4 + ["validation", "test"]
    return [item(i, f"OBJ-{i % 6}", random.Random(-i).random() < 0.65, splits[i % 6]) for i in range(n)]


def test_признаки_видят_место_значения_в_строке_и_оборот_в_том_числе() -> None:
    f = V.features(
        item(1, "O", False, "train")
        | {
            "line_text": "Этажей 17, в том числе подземных 0",
            "raw": "0",
            "value_num": 0.0,
        }
    )
    assert f["incl"] == 1.0 and f["value_zero"] == 1.0 and f["value_at_end"] == 1.0
    assert f[V._tok("L", "подземных")] == 1.0 and f["numbers_left"] == 1.0
    g = V.features(
        item(2, "O", True, "train")
        | {"line_text": "Площадь застройки 1234 м²",
                "unit": "м²", "raw": "1234", "value_num": 1234.0}
    )
    assert g["unit_right"] == 1.0 and g["value_at_end"] == 0.0 and "incl" not in g
    assert g[V._tok("R", "м")] == 1.0 and "value_year" in g and g["value_year"] == 0.0


def test_год_и_значение_не_найденное_в_строке() -> None:
    f = V.features(
        item(3, "O", False, "train")
        | {"line_text": "Разработано в 2024 году", "raw": "2024", "value_num": 2024.0}
    )
    assert f["value_year"] == 1.0
    lost = V.features(
        item(4, "O", True, "train")
        | {"line_text": "Площадь", "raw": "99", "value_num": 99.0}
    )
    assert (
        lost["value_at_end"] == 1.0 and lost["numbers_left"] == 0.0
    )  # значения нет в строке — справа пусто


def test_словарь_только_из_train_и_редкие_признаки_без_веса() -> None:
    v = V.build_vocab([{"a": 1.0, "b": 1.0}, {"a": 1.0}], min_count=2)
    assert v.names == ["a"]
    x = v.vector({"a": 2.0, "zzz": 5.0})
    assert list(x) == [1.0, 2.0]  # свободный член, признак; незнакомый признак не попал


def test_на_разделимых_данных_верификатор_отбрасывает_ошибки_и_сохраняет_верные() -> (
    None
):
    r = V.train(dataset())
    assert r["ok"]
    t = r["metrics"]["test"]
    assert t["keep_recall"] >= 0.98 and t["fpr"] == 0.0 and t["roc_auc"] == 1.0
    assert r["metrics"]["baseline_accept_all"]["fpr"] == 1.0
    assert r["metrics"]["sizes"]["test"]["n"] == 40
    assert set(r["metrics"]["by_section"]) == {"ПЗ"}
    assert V.gate(None, r["metrics"])["ok"]


def test_повтор_даёт_тот_же_хеш_весов_и_порядок_строк_не_важен() -> None:
    d = dataset()
    a = V.train(d)
    b = V.train(list(reversed(d)))
    assert a["weights_hash"] == b["weights_hash"]
    assert a["weights_hash"] == V.weights_hash(a["model"])
    c = V.train(d, V.TrainParams(l2=3.0))
    assert c["weights_hash"] != a["weights_hash"]


def test_метки_test_не_меняют_модель_и_порог() -> None:
    d = dataset()
    flipped = [
        it | {"label": "REJECT" if it["label"] == "ACCEPT" else "ACCEPT"}
        if it["split"] == "test"
        else it
        for it in d
    ]
    assert V.train(d)["weights_hash"] == V.train(flipped)["weights_hash"]


def test_порог_сохраняет_не_меньше_заданной_доли_верных_validation() -> None:
    probs = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.05])
    y = np.array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0])
    assert V.choose_threshold(probs, y, 1.0) == pytest.approx(0.075)  # между 0.1 и ошибочным 0.05
    assert V.choose_threshold(probs, y, 0.9) == pytest.approx(0.15)  # 10 верных, потерять можно одного
    assert V.choose_threshold(probs, y, 0.85) == pytest.approx(0.15)
    assert V.choose_threshold(np.array([0.3, 0.6]), np.array([1, 1]), 1.0) == pytest.approx(0.15)  # ниже нет — до нуля
    assert (
        V.choose_threshold(probs, np.zeros(11), 0.98) == 0.5
    )  # верных нет — нейтральный порог


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (
            lambda d: [
                it
                for it in d
                if not (it["split"] == "train" and it["label"] == "REJECT")
            ],
            "ACCEPT",
        ),
        (
            lambda d: [
                it
                for it in d
                if not (it["split"] == "train" and it["label"] == "ACCEPT")
            ],
            "ACCEPT",
        ),
        (lambda d: [it for it in d if it["split"] != "validation"], "validation"),
        (lambda d: [it for it in d if it["split"] != "test"], "test"),
    ],
)
def test_отказ_в_обучении_называет_причину(mutate, expected: str) -> None:
    r = V.train(mutate(dataset()))
    assert not r["ok"] and any(expected in x for x in r["reasons"])


def _m(keep: float | None, fpr: float | None) -> dict:
    return {"keep_recall": keep, "fpr": fpr}


def test_ворота_recall_и_fpr_с_допуском_два_пункта() -> None:
    base = {"test": _m(0.97, 0.30), "baseline_accept_all": _m(1.0, 1.0)}
    assert V.gate(None, base)["compared_to"] == "baseline_accept_all"
    assert not V.gate(None, base)["ok"]  # 0.97 < 1.0 − 0.02
    assert V.gate(None, {"test": _m(0.98, 0.3), "baseline_accept_all": _m(1.0, 1.0)})[
        "ok"
    ]  # ровно допуск
    prev = _m(0.99, 0.20)
    assert V.gate(prev, {"test": _m(0.97, 0.22), "baseline_accept_all": _m(1, 1)})["ok"]
    worse_fpr = V.gate(
        prev, {"test": _m(0.99, 0.2201), "baseline_accept_all": _m(1, 1)}
    )
    assert not worse_fpr["ok"] and "FPR" in worse_fpr["reasons"][0]
    worse_rec = V.gate(prev, {"test": _m(0.9699, 0.2), "baseline_accept_all": _m(1, 1)})
    assert not worse_rec["ok"] and "Recall" in worse_rec["reasons"][0]
    none = V.gate(prev, {"test": _m(None, 0.1), "baseline_accept_all": _m(None, 1)})
    assert not none["ok"] and "не измерен" in none["reasons"][0]


def test_без_опубликованной_модели_извлечения_не_меняются() -> None:
    d = dataset(12)
    assert V.apply(None, d) is d


def test_опубликованная_модель_отбрасывает_ниже_порога_и_пишет_оценку() -> None:
    r = V.train(dataset())
    test = [it for it in dataset() if it["split"] == "test"]
    kept = V.apply(r["model"], test)
    assert kept and all(it["label"] == "ACCEPT" for it in kept)
    assert all(
        0 < it["verifier_score"] <= 1
        and it["verifier_score"] >= r["model"]["threshold"] - 1e-4
        for it in kept
    )
    assert len(kept) < len(test)


def test_оценка_калибрована_в_интервале_и_верное_выше_ошибочного() -> None:
    r = V.train(dataset())
    good = V.score(r["model"], item(1000, "X", True, "test"))
    bad = V.score(r["model"], item(1001, "X", False, "test"))
    assert 0 < bad < good < 1


def test_уилсон_и_auc_на_краях() -> None:
    assert V.wilson(0, 0) == [0.0, 1.0]
    lo, hi = V.wilson(8, 10)
    assert lo < 0.8 < hi and 0 < lo and hi < 1
    assert V.wilson(10, 10)[1] == 1.0
    assert V.roc_auc(np.array([0.9, 0.1]), np.array([1, 0])) == 1.0
    assert V.roc_auc(np.array([0.5, 0.5]), np.array([1, 0])) == 0.5
    assert V.roc_auc(np.array([0.5]), np.array([1])) is None


def test_устойчивая_сигмоида_без_переполнения() -> None:
    s = V.sigmoid(np.array([-1000.0, 0.0, 1000.0]))
    assert s[0] == pytest.approx(0.0) and s[1] == 0.5 and s[2] == pytest.approx(1.0)
    assert np.all(np.isfinite(s))


def test_урок_учителя_показатель_степени_единицы_вместо_значения() -> None:
    f = V.features(item(7, "O", False, "train") | {"line_text": "Площадь застройки объекта 2 3009.4", "raw": "2",
                                                  "value_num": 2.0, "unit": "м²"})
    assert f["unit_exponent"] == 1.0 and f["numbers_right"] == 1.0
    ok = V.features(item(8, "O", True, "train") | {"line_text": "Этажность шт 2", "raw": "2", "value_num": 2.0,
                                                  "unit": "ед."})
    assert "unit_exponent" not in ok and ok["numbers_right"] == 0.0
    tail = V.features(item(9, "O", True, "train") | {"line_text": "Объём 3", "raw": "3", "value_num": 3.0, "unit": "м³"})
    assert "unit_exponent" not in tail  # правее чисел нет — это и есть значение


def test_текст_документа_не_попадает_в_признаки_и_артефакт() -> None:
    f = V.features(item(11, "O", True, "train") | {"line_text": "Площадь застройки уникальноеслово 1234 м²", "raw": "1234",
                                                  "value_num": 1234.0})
    assert not any("уникальноеслово" in k or "застройки" in k for k in f)
    r = V.train(dataset())
    assert not any(any(ch.isalpha() and ch.lower() in "абвгдежзийклмнопрстуфхцчшщъыьэюя" for ch in k.split("#")[0][2:])
                   for k in r["model"]["vocab"] if "#" in k)
    assert all(k.split("#")[0] in ("L", "R", "l3") for k in r["model"]["vocab"] if "#" in k)


def _golden(f: dict) -> dict:
    return {k: pytest.approx(v) if isinstance(v, float) else v for k, v in f.items()}


def test_эталон_признаков_строки_с_оборотами_и_показателем_степени() -> None:
    it = {"code": "M-001", "data_type": "number", "page_source": "text", "match": "lexical", "confidence": 0.9,
          "similarity": None, "raw": "2", "value_num": 2.0, "unit": "м²", "line_text": "Площадь в т.ч. (п. 2 3009 не менее"}
    words = {V._tok("L", w) for w in ("в", "т", "ч", "п")} | {V._tok("R", w) for w in ("3009", "не", "менее")}
    got = V.features(it)
    assert {k for k in got if "#" in k and not k.startswith("l3")} == words
    assert sum(k.startswith("l3#") for k in got) == 8  # хвост fold(left)[-10:] даёт 8 разных триграмм
    plain = {k: v for k, v in got.items() if "#" not in k}
    assert plain == _golden({
        "code=M-001": 1.0, "dt=number": 1.0, "src=text": 1.0, "match=lexical": 1.0, "confidence": 0.9, "similarity": 0.0,
        "log_abs_value": math.log1p(2), "value_zero": 0.0, "value_year": 0.0, "value_int": 1.0, "raw_digits": 1.0,
        "raw_len_log": math.log1p(1), "line_len_log": math.log1p(len(it["line_text"])), "value_at_end": 0.0,
        "numbers_left": 0.0, "numbers_right": 1.0, "unit_exponent": 1.0, "unit_right": 0.0, "mark_paren": 1.0,
        "mark_clause": 1.0, "incl": 1.0, "norm:не менее": 1.0})


def test_эталон_признаков_год_без_единицы_и_уверенности() -> None:
    it = {"code": "M-007", "data_type": "number", "raw": "2019", "value_num": 2019.0, "line_text": "Этажность 2019",
          "confidence": None, "unit": None}
    got = {k: v for k, v in V.features(it).items() if "#" not in k}
    assert got == _golden({
        "code=M-007": 1.0, "dt=number": 1.0, "src=text": 1.0, "match=lexical": 1.0, "confidence": 0.0, "similarity": 0.0,
        "log_abs_value": math.log1p(2019), "value_zero": 0.0, "value_year": 1.0, "value_int": 1.0, "raw_digits": 1.0,
        "raw_len_log": math.log1p(4), "line_len_log": math.log1p(14), "value_at_end": 1.0, "numbers_left": 0.0,
        "numbers_right": 0.0})
    assert V._tok("L", "этажность") in V.features(it)
    assert V._tok("L", "x") != V._tok("R", "x") and len(V._tok("L", "x")) == 12
    s = V.features({"raw": "abc", "line_text": "Тип abc", "code": None, "data_type": None, "value_num": None,
                    "match": "semantic", "page_source": "ocr", "similarity": 0.7, "unit": "мм"})
    assert s["code=?"] == 1.0 and s["dt=?"] == 1.0 and s["src=ocr"] == 1.0 and s["match=semantic"] == 1.0
    assert s["similarity"] == 0.7 and "log_abs_value" not in s and s["raw_digits"] == 0.0 and s["unit_right"] == 0.0


def test_rates_и_метрики_train_точно() -> None:
    acc = np.array([True, True, False, True, False])
    y = np.array([1, 1, 1, 0, 0])
    assert V.rates(acc, y) == {"keep_recall": 0.6667, "keep_recall_ci95": V.wilson(2, 3), "fpr": 0.5,
                               "fpr_ci95": V.wilson(1, 2), "precision": 0.6667, "n_correct": 3, "n_wrong": 2}
    assert V.rates(np.array([False]), np.array([0]))["precision"] is None
    assert V.rates(np.array([], dtype=bool), np.array([], dtype=int))["keep_recall"] is None
    r = V.train(dataset())
    m = r["metrics"]
    assert set(m) == {"test", "baseline_accept_all", "validation", "by_section", "sizes"}
    for s in ("train", "validation", "test"):
        n = sum(1 for it in dataset() if it["split"] == s)
        acc_n = sum(1 for it in dataset() if it["split"] == s and it["label"] == "ACCEPT")
        assert m["sizes"][s] == {"n": n, "accept": acc_n, "reject": n - acc_n}
    assert r["model"]["algorithm"] == V.ALGORITHM and r["model"]["feature_rev"] == V.FEATURE_REV
    assert r["model"]["weights"][0] == round(r["model"]["weights"][0], 10) and len(r["model"]["platt"]) == 2
    assert len(r["model"]["weights"]) == len(r["model"]["vocab"]) + 1


def test_хеш_весов_по_канонической_записи() -> None:
    import hashlib
    import json as _json

    m = {"algorithm": "a", "feature_rev": 1, "vocab": ["б", "a"], "weights": [0.5], "platt": [1, 0], "threshold": 0.3,
         "model_version": "не входит"}
    canon = _json.dumps({k: m[k] for k in ("algorithm", "feature_rev", "vocab", "weights", "platt", "threshold")},
                        ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert V.weights_hash(m) == hashlib.sha256(canon.encode()).hexdigest()
    assert V._canon({"b": 1, "a": "ж"}) == '{"a":"ж","b":1}'
