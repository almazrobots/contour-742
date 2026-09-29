"""OS-INSP-2.2.34 (ТЗ §11, TZA-11-07): ML-анализ одного параметра (NLP) — не более 500 мс на документ.

Время каждого параметра возвращается в ответе /analyze и попадает в журнал ML, если превысило 500 мс.
Предфильтр строк по порогу якоря (score_cutoff) и кэш нормализации строки ускоряют лексический путь и обязаны
не менять результат: сравнение с путём без предфильтра — L2.
"""

from __future__ import annotations

import json
import random
import time

import pytest

pytestmark = pytest.mark.performance

from inspector_ml import extract as ex
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

SPECS = [
    ParamSpec(code="M-002", anchors=["Площадь застройки"], data_type="number"),
    ParamSpec(
        code="M-005", anchors=["Строительный объем (Надземный)"], data_type="number"
    ),
    ParamSpec(
        code="M-006", anchors=["Строительный объем (Подземный)"], data_type="number"
    ),
    ParamSpec(
        code="M-010",
        anchors=["Класс бетона"],
        data_type="string",
        regex_pattern=r"B\s?\d+(?:[.,]\d+)?",
    ),
    ParamSpec(
        code="M-020", anchors=["Этажность", "Количество этажей"], data_type="number"
    ),
]


def _line(t: str) -> Line:
    return Line(text=t, words=[Word(text=w) for w in t.split()])


def _doc(
    n_pages: int, seed: int = 1, lines_per_page: int = 40, source: str = "text"
) -> ParsedDoc:
    r = random.Random(seed)
    anchors = [a for s in SPECS for a in s.anchors] + [
        "Площадь застройкии",
        "Строит. объем надземн.",
        "Клас бетона",
    ]
    filler = [
        "Проектной документацией предусмотрено",
        "в соответствии с СП 54.13330.2022",
        "Лестничная клетка типа Л1",
        "Кровля плоская",
    ]
    pages = []
    for i in range(n_pages):
        lines = []
        for _ in range(lines_per_page):
            if r.random() < 0.3:
                lines.append(
                    _line(
                        f"{r.choice(anchors)} {r.choice(['B25', '12 450,0', '9', 'В 30'])}"
                    )
                )
            else:
                lines.append(_line(" ".join(r.choice(filler) for _ in range(2))))
        pages.append(
            Page(
                page=i + 1,
                width=595,
                height=842,
                source=source,
                ocr_confidence=90 if source == "ocr" else None,
                lines=lines,
            )
        )
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="t", pages=pages)


@pytest.mark.l1_functional
def test_every_parameter_gets_its_analysis_time():
    timings: dict[str, float] = {}
    ex.extract(_doc(3), SPECS, timings=timings)
    assert set(timings) == {s.code for s in SPECS}
    assert all(v >= 0 for v in timings.values())


@pytest.mark.l1_functional
def test_timings_are_optional_and_do_not_change_result():
    doc = _doc(5)
    assert ex.extract(doc, SPECS) == ex.extract(doc, SPECS, timings={})


@pytest.mark.l1_functional
def test_semantic_time_is_shared_among_parameters_sent_to_semantics():
    class SlowEmbedder:
        def embed(self, texts):
            import numpy as np

            time.sleep(0.05)
            return np.zeros((len(texts), 4), dtype="float32")

    spec = ParamSpec(
        code="M-099", anchors=["Площадь квартир жилого дома"], data_type="number"
    )
    doc = ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="t",
        pages=[
            Page(
                page=1,
                width=1,
                height=1,
                source="text",
                lines=[_line("Суммарная площадь квартир 1200")],
            )
        ],
    )
    timings: dict[str, float] = {}
    ex.extract(doc, [spec], SlowEmbedder(), timings=timings)
    assert (
        timings["M-099"] >= 90
    )  # два вызова embed по 50 мс ушли на единственный параметр семантики


@pytest.mark.l2_differential
@pytest.mark.parametrize("source", ["text", "ocr"])
def test_line_prefilter_gives_same_extractions_as_full_scan(monkeypatch, source):
    doc = _doc(12, seed=7, source=source)
    fast = ex.extract(doc, SPECS)
    monkeypatch.setattr(ex, "PREFILTER", False)
    assert ex.extract(doc, SPECS) == fast


@pytest.mark.l3_boundary
def test_prefilter_keeps_line_exactly_at_threshold(monkeypatch):
    """Порог включительно: строка с совпадением ровно ANCHOR_MIN проходит предфильтр, как и без него."""
    monkeypatch.setattr(ex, "anchor_score", lambda a, s: float(ex.ANCHOR_MIN))
    doc = ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="t",
        pages=[
            Page(
                page=1,
                width=1,
                height=1,
                source="text",
                lines=[_line("Площадь застройки 100")],
            )
        ],
    )
    assert ex.line_passes(
        ex.folded_anchors(SPECS[0]), "Площадь застройки 100", ex.ANCHOR_MIN
    )
    assert [e.code for e in ex.extract(doc, [SPECS[0]])] == ["M-002"]


@pytest.mark.l3_boundary
def test_prefilter_short_line_uses_full_ratio_like_anchor_score():
    """Строка короче якоря сравнивается полным сходством (соринка OCR не совпадает частично) — как в anchor_score."""
    a = ex.folded_anchors(ParamSpec(code="X", anchors=["Площадь застройки"]))
    assert not ex.line_passes(a, "о", 82)
    assert ex.line_passes(a, "Площадь застрой", 82) == (
        ex.anchor_score("Площадь застройки", "Площадь застрой") >= 82
    )


@pytest.mark.l3_boundary
def test_performance_500_pages_every_parameter_within_500_ms():
    """TZA-11-07 на железе гейта: документ 500 стр. × 40 строк, каждый параметр ≤ 500 мс."""
    timings: dict[str, float] = {}
    ex.extract(_doc(500), SPECS, timings=timings)
    assert max(timings.values()) <= 500, timings


# ─────────────────────────────── /analyze: время в ответе и журнал превышений


@pytest.mark.l1_functional
def test_analyze_returns_param_ms_and_logs_slow_params(tmp_path, monkeypatch, capsys):
    from test_parse_extract import SPECS as PE_SPECS, ml_client, sha

    from inspector_ml import app as app_mod

    client, f = ml_client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        app_mod, "PARAM_SLOW_MS", -1
    )  # любое время — превышение: журнал обязан назвать параметр
    body = {"sha256": sha(f), "params": [s.model_dump() for s in PE_SPECS[:2]]}
    res = client.post("/analyze", json=body).json()
    assert set(res["param_ms"]) == {s.code for s in PE_SPECS[:2]}
    assert all(isinstance(v, int) and v >= 0 for v in res["param_ms"].values())
    logs = [
        json.loads(x) for x in capsys.readouterr().out.splitlines() if x.startswith("{")
    ]
    slow = [x for x in logs if x.get("message") == "param_slow"]
    assert {x["param"] for x in slow} == {s.code for s in PE_SPECS[:2]}
    assert all(
        x["level"] == "WARNING" and x["limit_ms"] == -1 and "ms" in x for x in slow
    )


@pytest.mark.l1_functional
def test_analyze_param_ms_from_cache_is_marked_cached(tmp_path, monkeypatch):
    """Из кэша время — прежнего анализа; ответ помечен cached, и API не учитывает его повторно."""
    from test_parse_extract import SPECS as PE_SPECS, ml_client, sha

    client, f = ml_client(tmp_path, monkeypatch)
    body = {"sha256": sha(f), "params": [PE_SPECS[1].model_dump()]}
    first = client.post("/analyze", json=body).json()
    second = client.post("/analyze", json=body).json()
    assert second["cached"] is True and second["param_ms"] == first["param_ms"]


# ─────────────────────────────── номер помещения с литерой (ТЗ 9.1.1: Exact Match номера помещения/элемента)


@pytest.mark.l8_regression
@pytest.mark.parametrize(
    "text, number, name",
    [
        ("Помещение 1.18а Кухня-ниша", "1.18а", "Кухня-ниша"),
        ("Помещение 3.5Б Техническое помещение", "3.5Б", "Техническое помещение"),
        ("Помещение 12 Вестибюль", "12", "Вестибюль"),
        ("Помещение 2.7 б Кладовая", "2.7", "б Кладовая"),  # литера через пробел — уже название, номер не додумываем
    ],
)
def test_room_number_with_letter_suffix(text, number, name):
    """Регрессия (T-138, стенд OCR 9.1.1): «Помещение 1.18а …» не распознавалось вовсе — номер с литерой обычен
    в экспликации, а Exact Match номера помещения — ключевое поле ТЗ 9.1.1."""
    doc = ParsedDoc(sha256="0" * 64, kind="pdf", engine="t", pages=[Page(page=1, width=1, height=1, source="text", lines=[_line(text)])])
    (r,) = ex.rooms(doc)
    assert (r.number, r.name) == (number, name)
