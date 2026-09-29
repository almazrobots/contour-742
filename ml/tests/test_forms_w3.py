"""T-210: паспортные формы синтетики W3 (synth/forms_w3.py) — генератор пишет параметр так, как пишут реальные документы.

Проверяется: выбор 14 нарушений OBJ-USB-132 по seed 1 не меняется ни сейчас, ни после влития паспортов T-212 (формы
включаются по файлу паспорта); зеркало домена (eval/decide.py) видит нарушение каждой формы; настоящий PDF объекта,
разобранный как в системе (parse_file), читается экстрактором паспорта с тем значением, которое записал генератор.
Экстрактор под генератор не подгоняется: формы — те, что в тестах экстракторов как реальные документы.
"""

from __future__ import annotations

import hashlib
import json
import random

import pytest

from inspector_ml.extract import extract
from inspector_ml.model import ParamSpec
from inspector_ml.parse import parse_file
from synth import factory as F
from synth import forms_w3 as W3
from synth import usability_132 as U

# Выбор нарушений по seed 1 на коммите 7da912b (до форм W3) — заморожен: формы значения не меняют, выбор — тоже.
SEED_1 = [
    "M-008", "M-019", "M-025", "M-027", "M-034", "M-043", "M-062",
    "M-075", "M-079", "M-089", "M-094", "M-104", "M-114", "M-115",
]  # fmt: skip
REAL_KIND = W3.passport_kind
READ_HERE = ("M-033", "M-043", "M-048")  # М-106 читает строку М-043 (потому и в draft/); остальные формы — vision/category
REACHABLE_N = 130  # все, кроме М-023 (класс: шкала Матрицы кириллицей) и М-072 (перечисление без порядка)


def _fresh_pool(monkeypatch, kinds=None):
    """Пул фабрики без генераторов v3 (install() их кеширует) и, по желанию, с подменой видов паспортов."""
    monkeypatch.setattr(F, "POOL", {c: F.POOL[c] for c in F.V2_CODES})
    if kinds is not None:
        monkeypatch.setattr(W3, "passport_kind", kinds)


@pytest.mark.l8_regression
def test_seed_1_picks_frozen_exactly_14():
    assert U.pick_violations(1) == SEED_1 and len(SEED_1) == U.N_VIOLATIONS == 14
    assert len(U.reachable()) == REACHABLE_N


@pytest.mark.l8_regression
def test_picks_same_when_t212_passports_arrive(monkeypatch):
    # влитие паспортов T-212 включит их формы: достижимость и выбор по seed 1–3 не меняются
    before = {s: U.pick_violations(s) for s in (1, 2, 3)}
    _fresh_pool(
        monkeypatch, lambda code: W3.FORMS[code]["kind"] if code in W3.FORMS else None
    )
    assert all(W3.form(F.MATRIX[c]) is not None for c in W3.FORMS)
    assert len(U.reachable()) == REACHABLE_N
    assert {s: U.pick_violations(s) for s in (1, 2, 3)} == before


@pytest.mark.l3_boundary
def test_form_only_with_passport_of_its_kind(monkeypatch):
    _fresh_pool(monkeypatch, lambda code: None)
    assert all(W3.form(F.MATRIX[c]) is None for c in W3.FORMS)
    _fresh_pool(
        monkeypatch, lambda code: "ordinal"
    )  # паспорт другого вида — форма не включается
    assert W3.form(F.MATRIX["M-043"]) is None
    assert REAL_KIND("M-043") == "direction" and REAL_KIND("M-900") is None


@pytest.mark.l1_functional
@pytest.mark.parametrize("code", sorted(W3.FORMS))
def test_mirror_sees_violation_of_every_form(monkeypatch, code):
    # зеркало домена по Матрице: «хуже» на последней стадии — CANDIDATE, «как было» — NEGATIVE_VERIFIED
    from eval.decide import StageValue, evaluate

    _fresh_pool(monkeypatch, lambda c: W3.FORMS[c]["kind"] if c in W3.FORMS else None)
    p = F.MATRIX[code]
    e = W3.form(p)
    r = random.Random(f"forms-w3:{code}")
    for _ in range(20):
        v = e["base"](r)
        w = e["worse"](v, r)
        assert e["fmt"](w) != e["fmt"](v)
        F.POOL[code] = e
        for vals, want in (([v, v, w], "CANDIDATE"), ([v, v, v], "NEGATIVE_VERIFIED")):
            used = [
                StageValue(s, *F.as_stage_value(code, x), "", s, 1, None, "CURRENT")
                for s, x in zip(("PD", "RD", "ID"), vals)
            ]
            assert (
                evaluate(p, {"demolition": True}, used, {"PD", "RD", "ID"}).status
                == want
            ), (code, e["fmt"](v), e["fmt"](w))


@pytest.mark.l1_functional
def test_stairs_base_meets_recommendation_worse_breaks_norm():
    # М-048: база — проступь ≥ 300 (рекомендация Матрицы) и подступенок ≤ 150; хуже — проступь < 250 (норма СП, CANDIDATE)
    e = W3.FORMS["M-048"]
    r = random.Random(1)
    for _ in range(50):
        v = e["base"](r)
        w = e["worse"](v, r)
        assert v[0] >= 300 and v[1] <= 150 and w[0] < 250 and w[1:] == v[1:]
    s = W3.FORMS["M-033"]
    for _ in range(50):
        v = s["base"](r)
        assert (
            4 <= v <= 80
            and 4 <= s["worse"](v, r) <= 80
            and abs(s["worse"](v, r) - v) >= 5
        )


def _read(code: str, doc) -> list:
    """Извлечение по паспорту, как его передаёт API (passport.ts: extractor как есть)."""
    p = F.MATRIX[code]
    f = F.ROOT / "data/seed/passports" / f"{code}.json"
    if not f.exists():  # паспорт без цифр замера — в draft/ (T-233)
        f = F.ROOT / "data/seed/passports/draft" / f"{code}.json"
    pp = json.loads(f.read_text("utf-8"))
    ext = dict(pp["extractor"])
    if pp["value"]["kind"] in ("presence", "method"):
        ext["value_kind"] = pp["value"]["kind"]
    if pp["value"]["kind"] == "method":
        ext["terms"] = [{"key": k, "patterns": t["patterns"]} for k, t in pp["value"]["terms"].items()]
    spec = ParamSpec(
        code=code,
        anchors=p["anchors"],
        data_type=p["data_type"],
        compare_kind=p["compare"]["kind"],
        extractor=ext,
    )
    return [
        e for e in extract(doc, [spec]) if e.code == code and not e.meta.get("excluded")
    ]


def _meaning(code: str, ms: list):
    """Что прочитала система: направление, уклон ‰ или (проступь, подступенок, число ступеней)."""
    if code in ("M-043", "M-106"):
        return sorted({e.value_text for e in ms})
    if code == "M-033":
        return sorted({e.value_num for e in ms})
    if code == "M-070":
        return sorted({e.value_num for e in ms})
    if W3.FORMS[code]["kind"] == "presence":
        return sorted({e.value_text for e in ms})
    if W3.FORMS[code]["kind"] == "method":
        return sorted({e.meta["term"] for e in ms})
    got = {e.meta.get("aspect"): e.value_num for e in ms}
    return (got.get("tread"), got.get("riser"), got.get(None))


def _want(code: str, v):
    if code in ("M-043", "M-106"):
        return ["outward" if v[0] == 0 else "inward"]
    if code == "M-033":
        return [float(v)]
    if code == "M-070":
        return [float(v)]
    if W3.FORMS[code]["kind"] == "presence":
        return ["present" if v == 0 else "absent"]
    if W3.FORMS[code]["kind"] == "method":
        return [(('element', 'manual', 'crane'), ('hammer', 'explosion'))[v[0]][v[1]]]
    return tuple(float(x) for x in v)


@pytest.mark.l2_differential
def test_real_pdf_of_usb132_is_read_by_passport_extractor(tmp_path):
    # настоящая отрисовка документа объекта и разбор parse_file: строка ТЭП читается экстрактором паспорта как в системе;
    # у нарушения М-043 (seed 1) ИД — «внутрь», ПД и РД — «наружу»
    _, docs, _ = U.make_object(1)
    # читаются экстрактором паспорта числа и направления; паспорта (в т.ч. из passports/draft/, T-233) берутся общим помощником
    active = [c for c in W3.FORMS if c in READ_HERE and W3.form(F.MATRIX[c]) is not None]
    assert set(READ_HERE) <= set(active)
    seen = {}
    for d in docs:
        mine = [(c, v) for c, v in d.rows if c in active]
        if not mine:
            continue
        path = tmp_path / f"{d.file_id}.pdf"
        F.render_pdf(d, F.layout(d, random.Random(0)), path)
        parsed = parse_file(path, hashlib.sha256(path.read_bytes()).hexdigest())
        for c, v in mine:
            assert _meaning(c, _read(c, parsed)) == _want(c, v), (
                d.file_id,
                c,
                W3.FORMS[c]["fmt"](v),
            )
            seen[(d.stage, c)] = _want(c, v)
    assert seen[("PD", "M-043")] == seen[("RD", "M-043")] == ["outward"] and seen[
        ("ID", "M-043")
    ] == ["inward"]
    assert len(seen) == 3 * len(active)
