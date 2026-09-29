"""Проверка упоминаний локальной VLM (VER-09, T-129) — самый критичный ML-модуль: он стоит между извлечением
и решением. Модель здесь подменяется детерминированным судьёй; живой замер — отдельно (правило №0).

Эшелоны qa-standard: L1 правила вердиктов · L2 независимый пересчёт итога · L3 границы уверенности и кропа ·
L4 отказы модели · L5 инварианты «только понижает» перебором всего пространства вердиктов · L6 враждебный ответ
модели · L7 дисциплина (конфигурация, след в meta) · L8 регрессии реальных листов «Алтуфьево» (обезличено)."""

from __future__ import annotations

import itertools
import json
import random

import pytest
from PIL import Image

from inspector_ml import vlm
from inspector_ml.model import Extraction
from inspector_ml.vlm import Judgement, parse_judgement
from inspector_ml.vlm_verify import (
    CONFLICT_FACTOR,
    UNREADABLE_FACTOR,
    WHY,
    apply_judgement,
    mention_box,
    verify_mentions,
)

VALUES = ["С0", "С1", "С2", "С3", None]
SUBJECTS = ["object", "neighbor", "norm", "unclear"]
EXCLUDED = [None, "NEIGHBOR", "NORM_TABLE", "HEADING"]
IMG = Image.new("RGB", (40, 20), "white")


def mention(
    value="С0",
    conf=1.0,
    excluded=None,
    qualifier=None,
    bbox=(0.4, 0.5, 0.45, 0.51),
    anchor=(0.1, 0.5, 0.39, 0.51),
):
    meta = {
        "quote": f"класс конструктивной пожарной опасности – {value}",
        "qualifier": qualifier,
        "excluded": excluded,
        "excluded_why": "правило" if excluded else None,
        "ops": ["ENT-16", "NRM-03", "NRM-04"],
    }
    return Extraction(
        code="M-023",
        raw=value,
        value_text=value,
        page=3,
        bbox=bbox,
        anchor_bbox=anchor,
        line_text=meta["quote"],
        confidence=conf,
        meta=meta,
    )


def J(value="С0", subject="object", quote="…"):
    return Judgement(value, subject, quote, "{}")


# ─────────────────────────────── L1 правила вердиктов


@pytest.mark.l1_functional
def test_confirmed_keeps_value_and_confidence_and_leaves_trace():
    out = apply_judgement(mention("С1", 0.9), J("С1", "object"))
    assert (out.value_text, out.confidence) == ("С1", 0.9)
    assert out.meta["vlm"]["outcome"] == "confirmed" and out.meta["excluded"] is None
    assert out.meta["ops"][-1] == "VER-09"


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("subject", "code"), [("neighbor", "VLM_NEIGHBOR"), ("norm", "VLM_NORM")]
)
def test_neighbor_or_norm_excludes_with_reason(subject, code):
    out = apply_judgement(mention("С1"), J("С1", subject))
    assert out.meta["excluded"] == code and out.meta["excluded_why"] == WHY[code]
    assert out.meta["vlm"]["outcome"] == "excluded" and out.value_text == "С1"


@pytest.mark.l1_functional
def test_conflict_lowers_confidence_but_keeps_extracted_value():
    out = apply_judgement(mention("С0", 1.0), J("С1", "object"))
    assert out.value_text == "С0" and out.confidence == CONFLICT_FACTOR
    assert out.meta["vlm"]["outcome"] == "conflict" and "С1" in out.meta["vlm"]["note"]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "j", [J(None, "object"), J("С0", "unclear"), J(None, "unclear")]
)
def test_unreadable_lowers_confidence_a_little(j):
    out = apply_judgement(mention("С0", 1.0), j)
    assert (
        out.confidence == UNREADABLE_FACTOR
        and out.meta["vlm"]["outcome"] == "unreadable"
    )


@pytest.mark.l1_functional
def test_rule_excluded_mention_is_never_unexcluded():
    out = apply_judgement(mention("С1", excluded="NEIGHBOR"), J("С1", "object"))
    assert (
        out.meta["excluded"] == "NEIGHBOR" and out.meta["vlm"]["outcome"] == "skipped"
    )


@pytest.mark.l1_functional
def test_verify_skips_rule_excluded_without_calling_judge():
    calls = []
    got = verify_mentions(
        [mention(excluded="HEADING"), mention("С2")],
        lambda ex: IMG,
        lambda img: calls.append(1) or J("С2"),
    )
    assert (
        len(calls) == 1
        and got[0].meta.get("vlm") is None
        and got[1].meta["vlm"]["outcome"] == "confirmed"
    )


@pytest.mark.l1_functional
def test_constraint_qualifier_survives_judgement():
    out = apply_judgement(mention("С0", qualifier="min"), J("С0"))
    assert out.meta["qualifier"] == "min"


@pytest.mark.l1_functional
def test_input_is_not_mutated():
    m = mention("С0", 1.0)
    before = m.model_dump()
    apply_judgement(m, J("С1", "neighbor"))
    assert m.model_dump() == before


@pytest.mark.l1_functional
def test_ops_do_not_duplicate_ver09():
    once = apply_judgement(mention(), J())
    twice = apply_judgement(once, J())
    assert twice.meta["ops"].count("VER-09") == 1


# ─────────────────────────────── L2 независимый пересчёт


def _oracle(value, conf, excluded, j):
    """Итог вердикта, пересчитанный отдельно от кода модуля (таблица решений VER-09)."""
    if excluded:
        return value, conf, excluded
    if j.subject == "neighbor":
        return value, conf, "VLM_NEIGHBOR"
    if j.subject == "norm":
        return value, conf, "VLM_NORM"
    if j.value is None or j.subject == "unclear":
        return value, round(conf * 0.8, 3), None
    if j.value != value:
        return value, round(conf * 0.5, 3), None
    return value, conf, None


@pytest.mark.l2_differential
@pytest.mark.parametrize("seed", range(40))
def test_differential_against_decision_table(seed):
    r = random.Random(seed)
    v, x, conf = r.choice(VALUES[:4]), r.choice(EXCLUDED), round(r.uniform(0.3, 1.0), 3)
    j = J(r.choice(VALUES), r.choice(SUBJECTS))
    out = apply_judgement(mention(v, conf, excluded=x), j)
    assert (out.value_text, out.confidence, out.meta["excluded"]) == _oracle(
        v, conf, x, j
    )


# ─────────────────────────────── L3 границы


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    ("conf", "factor", "j"),
    [
        (1.0, 0.5, J("С1")),
        (0.001, 0.5, J("С1")),
        (0.0, 0.8, J(None)),
        (0.333, 0.8, J(None)),
    ],
)
def test_confidence_rounding_and_floor(conf, factor, j):
    out = apply_judgement(mention("С0", conf), j)
    assert out.confidence == round(conf * factor, 3) and out.confidence >= 0


@pytest.mark.l3_boundary
def test_mention_box_is_union_of_anchor_and_value():
    assert mention_box(
        mention(bbox=(0.4, 0.5, 0.45, 0.52), anchor=(0.1, 0.49, 0.39, 0.51))
    ) == (0.1, 0.49, 0.45, 0.52)
    assert mention_box(mention(bbox=(0.4, 0.5, 0.45, 0.52), anchor=None)) == (
        0.4,
        0.5,
        0.45,
        0.52,
    )
    assert mention_box(mention(bbox=None, anchor=None)) is None


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    ("bbox", "size"),
    [
        ((0.0, 0.0, 1.0, 1.0), (1000, 2000)),
        ((0.5, 0.5, 0.5, 0.5), (360, 120)),
        ((0.99, 0.99, 1.0, 1.0), (190, 80)),
    ],
)
def test_crop_box_stays_inside_page(bbox, size):
    assert vlm.crop_box(Image.new("RGB", (1000, 2000)), bbox).size == size


@pytest.mark.l3_boundary
def test_empty_mentions():
    assert verify_mentions([], lambda ex: IMG, lambda img: J()) == []


# ─────────────────────────────── L4 отказы модели


@pytest.mark.l4_fault
@pytest.mark.parametrize(
    "exc",
    [
        TimeoutError("vlm 300 s"),
        RuntimeError("Metal: out of memory"),
        ValueError("bad image"),
    ],
)
def test_model_failure_leaves_mention_untouched_with_error_trace(exc):
    def boom(img):
        raise exc

    (out,) = verify_mentions([mention("С1", 0.9)], lambda ex: IMG, boom)
    assert (out.value_text, out.confidence, out.meta["excluded"]) == ("С1", 0.9, None)
    assert (
        out.meta["vlm"]["outcome"] == "error"
        and type(exc).__name__ in out.meta["vlm"]["note"]
    )


@pytest.mark.l4_fault
def test_missing_raster_is_error_not_crash():
    (out,) = verify_mentions([mention()], lambda ex: None, lambda img: J())
    assert out.meta["vlm"]["outcome"] == "error" and "растра" in out.meta["vlm"]["note"]


@pytest.mark.l4_fault
def test_one_failure_does_not_stop_the_rest():
    n = {"i": 0}

    def flaky(img):
        n["i"] += 1
        if n["i"] == 1:
            raise RuntimeError("сбой")
        return J("С1")

    a, b = verify_mentions([mention("С1"), mention("С1")], lambda ex: IMG, flaky)
    assert (
        a.meta["vlm"]["outcome"] == "error" and b.meta["vlm"]["outcome"] == "confirmed"
    )


@pytest.mark.l4_fault
def test_error_note_is_bounded():
    def long(img):
        raise RuntimeError("x" * 10_000)

    (out,) = verify_mentions([mention()], lambda ex: IMG, long)
    assert len(out.meta["vlm"]["note"]) < 200


# ─────────────────────────────── L5 инварианты: перебор всего пространства вердиктов


ALL = list(itertools.product(VALUES[:4], EXCLUDED, [None, "min"], VALUES, SUBJECTS))


@pytest.mark.l5_property
def test_vlm_only_downgrades_over_whole_space():
    """Для любых (класс, отсев правил, «не ниже», прочтение судьи, субъект): значение не меняется, уверенность не
    растёт, отсев не снимается, «не ниже» сохраняется. 4 × 4 × 2 × 5 × 4 = 640 случаев."""
    for v, x, q, jv, js in ALL:
        m = mention(v, 0.77, excluded=x, qualifier=q)
        out = apply_judgement(m, J(jv, js))
        assert out.value_text == m.value_text and out.raw == m.raw
        assert out.confidence <= m.confidence
        assert (x is None) or out.meta["excluded"] == x
        assert out.meta["qualifier"] == q
        assert (out.page, out.bbox, out.anchor_bbox, out.code) == (
            m.page,
            m.bbox,
            m.anchor_bbox,
            m.code,
        )


@pytest.mark.l5_property
def test_verify_never_changes_count_or_order():
    r = random.Random(7)
    ms = [mention(r.choice(VALUES[:4]), excluded=r.choice(EXCLUDED)) for _ in range(50)]
    got = verify_mentions(
        ms, lambda ex: IMG, lambda img: J(r.choice(VALUES), r.choice(SUBJECTS))
    )
    assert [g.value_text for g in got] == [m.value_text for m in ms]


@pytest.mark.l5_property
def test_judgement_is_idempotent_on_outcome():
    for v, x, q, jv, js in ALL[::7]:
        once = apply_judgement(mention(v, excluded=x, qualifier=q), J(jv, js))
        twice = apply_judgement(once, J(jv, js))
        assert (
            twice.meta["excluded"] == once.meta["excluded"]
            and twice.confidence <= once.confidence
        )


# ─────────────────────────────── L6 враждебный ответ модели


HOSTILE = [
    "",
    "{}",
    "null",
    "[]",
    '{"value": null, "subject": null}',
    '{"value": 1, "subject": 2}',
    '{"value": "С0", "subject": "object"}{"value": "С3", "subject": "neighbor"}',  # два объекта — берётся первый
    '```json\n{"value": "С2", "subject": "object"}\n```',
    '{"value": "С0",\n "subject": "object",\n "quote": "' + "я" * 5000 + '"}',
    '{"value": "\\u0421\\u0031", "subject": "object"}',  # «С1» экранированным юникодом
    "<think>думаю…</think>" + '{"value": "С1", "subject": "norm"}',
    '{"value": "С0 или С1", "subject": "object"}',
    '{"subject": "object", "value": "c0"}',  # строчная латинская — не обозначение класса по правилу извлечения, но судья нормализует регистр
    "\x00\x01{" * 100,
]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("text", HOSTILE)
def test_hostile_model_output_never_crashes_and_stays_in_domain(text):
    j = parse_judgement(text)
    assert j.value in {"С0", "С1", "С2", "С3", None}
    assert j.subject in {"object", "neighbor", "norm", "unclear"}
    assert len(j.quote) <= 300 and len(j.raw) <= 500


@pytest.mark.l6_adversarial
def test_two_objects_first_wins_and_fenced_json_parsed():
    assert (parse_judgement(HOSTILE[6]).value, parse_judgement(HOSTILE[6]).subject) == (
        "С0",
        "object",
    )
    assert parse_judgement(HOSTILE[7]).value == "С2"
    assert parse_judgement(HOSTILE[9]).value == "С1"
    assert parse_judgement(HOSTILE[10]).subject == "norm"
    assert (
        parse_judgement(HOSTILE[11]).value is None
    )  # два класса в ответе — это не прочтение


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("seed", range(30))
def test_random_garbage_is_unclear(seed):
    r = random.Random(seed)
    junk = "".join(chr(r.randrange(32, 0x500)) for _ in range(r.randrange(0, 400)))
    j = parse_judgement(junk)
    assert j.subject in {"object", "neighbor", "norm", "unclear"} and j.value in {
        "С0",
        "С1",
        "С2",
        "С3",
        None,
    }


# ─────────────────────────────── L7 дисциплина


@pytest.mark.l7_discipline
def test_trace_is_json_serializable_for_api_storage():
    out = apply_judgement(mention(), J("С1", "neighbor"))
    assert (
        json.loads(json.dumps(out.meta, ensure_ascii=False))["vlm"]["outcome"]
        == "excluded"
    )


@pytest.mark.l7_discipline
def test_factors_are_downgrades():
    assert 0 < CONFLICT_FACTOR < UNREADABLE_FACTOR < 1


@pytest.mark.l7_discipline
def test_default_models_are_local_open_weights():
    """Только локальные модели с открытыми весами (Q&A №23): имена — репозитории HF, не облачные API."""
    for repo in (vlm.READER, vlm.READER2, vlm.JUDGE):
        assert "/" in repo and not repo.startswith(("gpt", "claude", "gemini", "http"))


# ─────────────────────────────── L8 регрессии реальных листов (обезличено)


@pytest.mark.l8_regression
def test_regression_pb_page7_object_description_is_not_neighbor():
    """ПБ 2025, стр. 7: «…объём здания не более 35000 м3, степень и класс не ниже II, С0. Расположенный на первом
    этаже магазин…» — описание самого объекта. Правило ошибалось (слово «Расположенный»); судья «object» не мешает."""
    out = apply_judgement(mention("С0", 1.0, qualifier="min"), J("С0", "object"))
    assert out.meta["excluded"] is None and out.meta["vlm"]["outcome"] == "confirmed"


@pytest.mark.l8_regression
def test_regression_pb2024_neighbor_rule_holds_even_if_vlm_disagrees():
    """ПБ 2024, стр. 12: «Находится с юга… класс зданий — С1. Расстояние – 8 м» — сосед. Если VLM скажет object,
    отсев правила остаётся: VLM не снимает отсев."""
    out = apply_judgement(mention("С1", excluded="NEIGHBOR"), J("С1", "object"))
    assert out.meta["excluded"] == "NEIGHBOR"


@pytest.mark.l8_regression
def test_regression_vlm_catches_neighbor_the_rules_missed():
    """Сосед без признаков правила (нет стороны света, адреса, расстояния) — судья его отсеивает."""
    out = apply_judgement(mention("С2"), J("С2", "neighbor"))
    assert out.meta["excluded"] == "VLM_NEIGHBOR"


# ─────────────────────────────── L2 сквозь /analyze: судья встроен, выключен по умолчанию


@pytest.mark.l2_differential
def test_analyze_with_judge_marks_neighbor_and_keeps_other_params(monkeypatch):
    from inspector_ml import app as A

    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "mlx")
    monkeypatch.setattr(vlm, "render_page", lambda path, n, dpi=150: Image.new("RGB", (100, 100)))
    monkeypatch.setattr(vlm, "judge_mention", lambda img: J("С1", "neighbor"))
    other = Extraction(code="M-002", raw="100", value_num=100.0, page=1, bbox=None, line_text="Общая площадь 100", confidence=1.0)
    got = A._vlm_checked(A.Path("x.pdf"), [other, mention("С1")])
    assert got[0] is other and got[1].meta["excluded"] == "VLM_NEIGHBOR"


@pytest.mark.l7_discipline
def test_analyze_without_judge_is_identity(monkeypatch):
    from inspector_ml import app as A

    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "none")
    ms = [mention("С0")]
    assert A._vlm_checked(A.Path("x.pdf"), ms) is ms


def test_mixed_parameter_judge_routes_degree_and_class_separately(monkeypatch):
    from inspector_ml import app as A
    monkeypatch.setenv('INSPECTOR_VLM_BACKEND', 'mlx')
    monkeypatch.setattr(vlm, 'render_page', lambda *a: IMG)
    monkeypatch.setattr(vlm, 'judge_fire_degree', lambda img: J('II', 'object'))
    monkeypatch.setattr(vlm, 'judge_mention', lambda img: J('С1', 'neighbor'))
    degree = mention('II').model_copy(update={'code': 'M-022'})
    result = A._vlm_checked(A.Path('synthetic.pdf'), [degree, mention('С1')])
    assert result[0].meta['vlm']['outcome'] == 'confirmed'
    assert result[1].meta['excluded'] == 'VLM_NEIGHBOR'


@pytest.mark.l7_discipline
def test_cache_key_depends_on_judge(monkeypatch):
    from inspector_ml import app as A
    from inspector_ml.model import AnalyzeRequest

    req = AnalyzeRequest(sha256="a" * 64, params=[], facts=[])
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "none")
    off = A._cache_key(req)
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "mlx")
    assert A._cache_key(req) != off


@pytest.mark.l1_functional
@pytest.mark.parametrize("j", [J("С1"), J(None, "unclear"), J("С0", "neighbor"), J("С0")])
def test_rules_confidence_is_kept_for_ranking_whatever_the_judge_says(j):
    """SEC-02 (OWASP LLM01): API выбирает значение стадии по уверенности правил — судья её не трогает."""
    out = apply_judgement(mention(conf=0.9), j)
    assert out.meta["confidence_rules"] == 0.9
    assert out.confidence <= 0.9


@pytest.mark.l4_fault
def test_judge_calls_capped_per_document_rest_marked_skipped():
    """SEC-03 (OWASP LLM10): тысяча «С0» в документе — не тысяча генераций; сверх предела упоминание как есть."""
    calls = []

    def judge(img):
        calls.append(1)
        return J("С0")

    ms = [mention(conf=0.9) for _ in range(7)]
    out = verify_mentions(ms, lambda e: Image.new("RGB", (4, 4)), judge, max_calls=3)
    assert len(calls) == 3
    assert [m.meta["vlm"]["outcome"] for m in out] == ["confirmed"] * 3 + ["skipped"] * 4
    assert all("предел вызовов судьи" in m.meta["vlm"]["note"] for m in out[3:])
    assert [m.confidence for m in out[3:]] == [0.9] * 4 and not any(m.meta.get("excluded") for m in out)


@pytest.mark.l4_fault
def test_rule_excluded_do_not_count_against_the_cap():
    calls = []
    ms = [mention(excluded="NEIGHBOR") for _ in range(5)] + [mention()]
    out = verify_mentions(ms, lambda e: Image.new("RGB", (4, 4)), lambda i: calls.append(1) or J("С0"), max_calls=1)
    assert len(calls) == 1 and out[-1].meta["vlm"]["outcome"] == "confirmed"


# ─────────────── L8: дыры, найденные mutmut (T-129) — след судьи виден инспектору и хранится в протоколе


@pytest.mark.l8_regression
@pytest.mark.parametrize(
    "j,outcome",
    [(J("С0"), "confirmed"), (J("С1"), "conflict"), (J(None, "unclear"), "unreadable"), (J("С0", "neighbor"), "excluded"), (J("С0", "norm"), "excluded")],
)
def test_trace_keeps_what_the_judge_read_and_a_note(j, outcome):
    v = apply_judgement(mention(), j).meta["vlm"]
    assert (v["outcome"], v["value"], v["subject"]) == (outcome, j.value, j.subject)
    assert isinstance(v["note"], str) and v["note"].strip()


@pytest.mark.l8_regression
def test_skipped_trace_for_rule_excluded_keeps_judgement_and_note():
    v = apply_judgement(mention(excluded="NEIGHBOR"), J("С1", "object")).meta["vlm"]
    assert (v["outcome"], v["value"], v["subject"]) == ("skipped", "С1", "object")
    assert v["note"] == "уже отсеяно правилами"


@pytest.mark.l8_regression
def test_previous_catalog_ops_are_kept_in_order_and_ver09_appended():
    assert apply_judgement(mention(), J("С0")).meta["ops"] == ["ENT-16", "NRM-03", "NRM-04", "VER-09"]


@pytest.mark.l8_regression
def test_model_error_keeps_existing_meta_and_judge_gets_the_crop_itself():
    crop = Image.new("RGB", (8, 8))
    seen = []
    out = verify_mentions([mention()], lambda e: crop, lambda img: seen.append(img) or J("С0"))
    assert seen == [crop]
    assert out[0].meta["vlm"]["outcome"] == "confirmed"

    def boom(img):
        raise RuntimeError("x" * 500)

    err = verify_mentions([mention()], lambda e: crop, boom)[0].meta
    assert err["quote"].startswith("класс конструктивной пожарной опасности")  # прежняя meta не потеряна
    assert err["vlm"]["note"] == "RuntimeError: " + "x" * 160  # ровно 160 символов сообщения


@pytest.mark.l8_regression
def test_missing_crop_note_names_the_reason():
    out = verify_mentions([mention()], lambda e: None, lambda img: J("С0"))
    assert out[0].meta["vlm"]["note"] == "ValueError: нет растра страницы"
