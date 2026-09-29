"""Модуль локальных VLM (T-129): разбор ответа судьи, кроп, выбор бэкенда. Сами модели здесь не запускаются —
живой замер идёт отдельно (eval, правило №0); тут — контракт, который защищает конвейер от болтливой модели."""

import pytest
from PIL import Image

from inspector_ml import vlm


@pytest.mark.parametrize('value', ['I', 'II', 'III', 'IV', 'V'])
def test_fire_judge_accepts_only_degree_scale(value):
    import json
    raw = json.dumps({'value': value, 'subject': 'object'})
    assert vlm.parse_judgement(raw, fire_degree=True).value == value
    assert vlm.parse_judgement(raw).value is None


@pytest.mark.parametrize('value', ['С0', 'C1', 'REI 60', 'II–III', 'не II', 'не ниже II', 'VI', '2'])
def test_fire_judge_refuses_other_scales_and_ambiguous_values(value):
    import json
    assert vlm.parse_judgement(json.dumps({'value': value}), fire_degree=True).value is None


def test_fire_judge_uses_degree_prompt(monkeypatch):
    def generate(repo, crop, prompt, max_tokens):
        assert prompt == vlm.FIRE_DEGREE_PROMPT
        assert max_tokens == 160
        return '{"value":"IV","subject":"neighbor"}'
    monkeypatch.setattr(vlm, 'generate', generate)
    result = vlm.judge_fire_degree(Image.new('RGB', (8, 8)))
    assert (result.value, result.subject) == ('IV', 'neighbor')


@pytest.mark.parametrize('quote', ['степень огнестойкости II–IV', 'Здания II, III и IV степеней', 'Секция I, секция II'])
def test_fire_judge_cannot_promote_one_endpoint_of_ambiguous_evidence(quote):
    import json
    result = vlm.parse_judgement(json.dumps({'value': 'II', 'subject': 'object', 'quote': quote}), fire_degree=True)
    assert (result.value, result.subject) == (None, 'unclear')


def test_fire_judge_preserves_explicit_norm_but_not_absent_object_fact():
    assert vlm.parse_judgement('{"value":"нет","subject":"object"}', fire_degree=True).subject == 'unclear'
    result = vlm.parse_judgement('{"value":"II","subject":"norm","quote":"II-IV"}', fire_degree=True)
    assert (result.value, result.subject) == (None, 'norm')


@pytest.mark.l1_functional
def test_judgement_strict_json():
    j = vlm.parse_judgement('{"value": "С1", "subject": "object", "quote": "класс конструктивной пожарной опасности – С1"}')
    assert (j.value, j.subject) == ("С1", "object") and "С1" in j.quote


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    ("text", "value", "subject"),
    [
        ('Вот ответ: {"value": "C0", "subject": "neighbor", "quote": "…"} Надеюсь, помог!', "С0", "neighbor"),  # болтовня вокруг, латинская C
        ('{"value": "СО", "subject": "OBJECT"}', "С0", "object"),  # буква О вместо нуля, регистр
        ('{"value": "С4", "subject": "object"}', None, "object"),  # вне шкалы — значения нет
        ('{"value": "нет", "subject": "unclear"}', None, "unclear"),
        ('{"value": "С1", "subject": "maybe-object"}', "С1", "unclear"),  # неизвестный субъект — unclear, не догадка
        ("совсем не JSON", None, "unclear"),
        ('{"value": ', None, "unclear"),  # обрыв генерации
    ],
)
def test_judgement_never_guesses(text, value, subject):
    j = vlm.parse_judgement(text)
    assert (j.value, j.subject) == (value, subject)


@pytest.mark.l3_boundary
def test_crop_box_padded_and_clamped():
    img = Image.new("RGB", (1000, 2000), "white")
    assert vlm.crop_box(img, (0.4, 0.5, 0.6, 0.52)).size == (560, 160)
    assert vlm.crop_box(img, (0.0, 0.0, 0.05, 0.01)).size == (230, 80)  # у края — обрезается по листу


@pytest.mark.l7_discipline
def test_backend_is_explicit(monkeypatch):
    monkeypatch.delenv("INSPECTOR_VLM_BACKEND", raising=False)
    assert vlm.backend() == "none" and not vlm.enabled()
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "cloud")
    with pytest.raises(ValueError, match="ждём none"):
        vlm.backend()
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "openai")
    monkeypatch.delenv("INSPECTOR_VLM_URL", raising=False)
    with pytest.raises(ValueError, match="INSPECTOR_VLM_URL"):
        vlm.generate("m", Image.new("RGB", (8, 8)), "?")


@pytest.mark.l4_fault
def test_disabled_backend_refuses(monkeypatch):
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "none")
    with pytest.raises(RuntimeError, match="выключена"):
        vlm.judge_mention(Image.new("RGB", (8, 8)))


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "raw,ok",
    [
        ("https://vllm:8000/v1/", "https://vllm:8000/v1"),
        ("http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"),
        ("http://localhost:8000/v1", "http://localhost:8000/v1"),
        ("http://vllm:8000/v1", None),
        ("ftp://127.0.0.1/v1", None),
        ("", None),
    ],
)
def test_vlm_url_https_or_loopback_only(raw, ok):
    """SEC-09: кропы листов к серверу VLM — только по https; открытый http — лишь на петле."""
    if ok:
        assert vlm.check_vlm_url(raw) == ok
    else:
        with pytest.raises(ValueError):
            vlm.check_vlm_url(raw)


@pytest.mark.l4_fault
def test_line_stop_is_in_scoped_request_before_dispatch(monkeypatch):
    from inspector_ml import execution_scope
    requests = []
    monkeypatch.setenv("INSPECTOR_VLM_URL", "http://127.0.0.1:8000/v1")
    monkeypatch.setattr(execution_scope, "current_scope", lambda: object())
    monkeypatch.setattr(execution_scope, "generate_scoped", lambda body, timeout: requests.append(body) or "Этажность")
    result = vlm._openai_generate(vlm.READER, Image.new("RGB", (120, 20)), "OCR:", 256, stop=["\n"])
    assert result == "Этажность"
    assert len(requests) == 1 and requests[0]["stop"] == ["\n"]


def test_degree_prompt_changes_effective_judge_fingerprint(monkeypatch):
    before = vlm.judge_fingerprint()
    monkeypatch.setattr(vlm, "FIRE_DEGREE_PROMPT", vlm.FIRE_DEGREE_PROMPT + " Clarification")
    assert vlm.judge_fingerprint() != before
