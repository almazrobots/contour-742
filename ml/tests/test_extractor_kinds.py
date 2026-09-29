"""Реестр извлекателей по виду паспорта (T-186, OS-INSP-7.1.21): extractor.kind → функция(doc, spec).

Эшелоны: L1 (встроенные class/quantity в реестре, свой путь тестового вида), L2 (тот же результат, что прямой вызов
извлекателя), L3 (нет извлекателя, незнакомый kind — прежний лексический путь), L6 (повтор и пустой kind — отказ).
Тестовый вид t_presence_mentions — ML-половина вида t_presence из apps/api/tests/kinds/t-presence.ts.
"""

from __future__ import annotations

import pytest

from inspector_ml import extractor_kinds as K
from inspector_ml.class_mentions import extract_class_mentions
from inspector_ml.extract import extract
from inspector_ml.model import Extraction, Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.quantity_mentions import extract_quantity_mentions


def mk_doc(lines: list[str]) -> ParsedDoc:
    out = []
    for li, text in enumerate(lines):
        y = 0.05 + 0.03 * li
        out.append(
            Line(text=text, words=[Word(text=text, bbox=(0.02, y, 0.5, y + 0.02))])
        )
    page = Page(
        page=1, width=595, height=842, source="text", ocr_confidence=None, lines=out
    )
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=[page])


def t_presence(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все строки с якорем: значение — первое слово шкалы из спецификации, найденное в строке."""
    ex = spec.extractor or {}
    got = []
    for p in doc.pages:
        for ln in p.lines:
            if ex["anchor"] in ln.text:
                word = next((w for w in ex["words"] if w in ln.text.split()), None)
                if word:
                    got.append(
                        Extraction(
                            code=spec.code,
                            raw=word,
                            value_text=word,
                            page=p.page,
                            bbox=ln.words[0].bbox,
                            line_text=ln.text,
                            confidence=0.8,
                            meta={"quote": ln.text},
                        )
                    )
    return got


SPEC = ParamSpec(
    code="M-010",
    anchors=["Количество квартир"],
    extractor={
        "kind": "t_presence_mentions",
        "anchor": "Количество квартир",
        "words": ["есть", "нет"],
    },
)
DOC = mk_doc(
    [
        "Количество квартир есть",
        "Этажность 5",
        "Количество квартир нет",
        "Количество квартир 120",
    ]
)


@pytest.fixture
def registered(monkeypatch):
    monkeypatch.setattr(K, "REGISTRY", dict(K.REGISTRY))
    K.register("t_presence_mentions", t_presence)


@pytest.mark.l1_functional
def test_встроенные_виды_в_реестре():
    assert K.REGISTRY["class_mentions"] is extract_class_mentions
    assert K.REGISTRY["quantity_mentions"] is extract_quantity_mentions
    assert (
        K.way_of(
            ParamSpec(code="M-023", anchors=["x"], extractor={"kind": "class_mentions"})
        )
        is extract_class_mentions
    )
    assert (
        K.way_of(
            ParamSpec(
                code="M-001", anchors=["x"], extractor={"kind": "quantity_mentions"}
            )
        )
        is extract_quantity_mentions
    )


@pytest.mark.l1_functional
def test_зарегистрированный_вид_идёт_своим_путём(registered):
    got = extract(DOC, [SPEC])
    assert [(e.code, e.value_text, e.meta["quote"]) for e in got] == [
        ("M-010", "есть", "Количество квартир есть"),
        ("M-010", "нет", "Количество квартир нет"),
    ]
    assert K.has_way(SPEC)


@pytest.mark.l2_differential
def test_свой_путь_вида_не_мешает_лексическому(registered):
    plain = ParamSpec(code="M-011", anchors=["Этажность"], data_type="number")
    got = extract(DOC, [SPEC, plain])
    assert [e.code for e in got] == [
        "M-011",
        "M-010",
        "M-010",
    ]  # лексические записи — первыми, упоминания — после


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "ex", [None, {}, {"kind": "t_presence_mentions_unknown"}, {"anchor": "x"}]
)
def test_без_извлекателя_или_незнакомый_kind_лексический_путь(ex):
    sp = ParamSpec(
        code="M-010", anchors=["Количество квартир"], data_type="number", extractor=ex
    )
    assert K.way_of(sp) is None and not K.has_way(sp)
    (e,) = extract(DOC, [sp])
    assert e.meta is None and e.value_num == 120


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("kind", ["class_mentions", "quantity_mentions", ""])
def test_повтор_или_пустой_kind_отказ(kind):
    before = dict(K.REGISTRY)
    with pytest.raises(ValueError, match="реестр извлекателей"):
        K.register(kind, t_presence)
    assert before == K.REGISTRY


@pytest.mark.l1_functional
def test_register_возвращает_функцию(monkeypatch):
    monkeypatch.setattr(K, "REGISTRY", {})
    assert K.register("z", t_presence) is t_presence
    assert K.REGISTRY == {"z": t_presence}


@pytest.mark.l1_functional
def test_вид_по_kind_без_корня_паспорта(registered):
    """Часть паспорта (T-174) берёт извлекатель по своему kind — та же функция реестра."""
    assert K.way_by_kind("t_presence_mentions") is t_presence
    assert K.way_by_kind("class_mentions") is extract_class_mentions
    assert K.way_by_kind("нет_такого") is None
    assert K.way_by_kind(None) is None and K.way_by_kind(5) is None


# ─────────────────────────────── T-233: сбой извлекателя одного параметра не роняет файл


def test_one_extractor_failure_does_not_fail_document(monkeypatch):
    """Паспорт с неподдерживаемой связкой (GeomSpecError М-060) ронял /analyze на весь файл — теперь пропускается один
    параметр, остальные извлекаются."""
    from inspector_ml import extract as ex
    from inspector_ml.model import ParsedDoc

    ok = object()

    def way_of(sp):
        return (
            (lambda doc, s: (_ for _ in ()).throw(ValueError("не умеет")))
            if sp.code == "BAD"
            else (lambda doc, s: [ok])
        )

    monkeypatch.setattr(ex, "way_of", way_of)
    specs = [type("S", (), {"code": c})() for c in ("BAD", "GOOD")]
    doc = ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=[])
    got = ex.extract(doc, specs)
    assert ok in got


def test_skip_kinds_turns_off_kind_not_to_lexical(monkeypatch):
    """T-233: выключенный вид — пустой список упоминаний (а не лексический путь); без переменной — как было."""
    from inspector_ml import extractor_kinds as ek

    spec = type(
        "S", (), {"code": "M-041", "extractor": {"kind": "geometry_mentions"}}
    )()
    monkeypatch.setenv("INSPECTOR_SKIP_KINDS", "geometry_mentions, other")
    assert ek.skipped_kinds() == frozenset({"geometry_mentions", "other"})
    way = ek.way_of(spec)
    assert way is not None and way(None, spec) == []
    monkeypatch.delenv("INSPECTOR_SKIP_KINDS")
    assert ek.way_of(spec) is ek.way_by_kind("geometry_mentions")
