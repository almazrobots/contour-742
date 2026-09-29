"""OS-INSP-2.2.13–2.2.16 (T-129): упоминания класса конструктивной пожарной опасности (М-023) по шкале С3 < С2 < С1 < С0.

Только синтетические строки. Конфигурация извлекателя — из паспорта data/seed/passports/M-023.json, как её передаёт API:
объект extractor, дополненный scale и constraint_markers.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from pathlib import Path

import pytest

from inspector_ml import reread as R
from inspector_ml.class_mentions import (
    extract_class_mentions,
    normalize_class,
    page_text,
)
from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
PASSPORT = json.loads((ROOT / "data/seed/passports/M-023.json").read_text("utf-8"))
CFG = PASSPORT["extractor"] | {
    "scale": PASSPORT["value"]["scale"],
    "constraint_markers": PASSPORT["value"]["constraint_markers"],
}
ANCHOR = "класс конструктивной пожарной опасности"


def spec(**over) -> ParamSpec:
    return ParamSpec(
        code="M-023",
        anchors=["Класс конструктивной пожарной опасности"],
        data_type="string",
        extractor=CFG | over,
    )


def mk_page(
    lines: list[str],
    n: int = 1,
    source: str = "text",
    conf: float | None = None,
    disputed: set[str] = frozenset(),
) -> Page:
    """Строки → слова с рамками: каждое слово — своя клетка, строка — своя полоса по вертикали."""
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        y = 0.05 + 0.03 * li
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t,
                    bbox=(round(x, 5), y, round(min(x + w, 1.0), 5), y + 0.02),
                    disputed=t in disputed,
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return Page(
        page=n, width=595, height=842, source=source, ocr_confidence=conf, lines=out
    )


def mk_doc(*pages: list[str] | Page) -> ParsedDoc:
    ps = [p if isinstance(p, Page) else mk_page(p, i + 1) for i, p in enumerate(pages)]
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=ps)


def values(doc: ParsedDoc, sp: ParamSpec | None = None) -> list[str | None]:
    return [e.value_text for e in extract_class_mentions(doc, sp or spec())]


def summary(doc: ParsedDoc) -> list[tuple]:
    return [
        (e.page, e.value_text, e.meta["qualifier"], e.meta["excluded"])
        for e in extract_class_mentions(doc, spec())
    ]


# ─────────────────────────────── L1: основной путь (2.2.13)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "text, want",
    [
        ("Класс конструктивной пожарной опасности – С1", "С1"),
        ("По конструктивной пожарной опасности здание относится к классу С0", "С0"),
        ("Класс конструктивной пожарной опасности здания: С2.", "С2"),
        ("класс конструктивной пожарной опасности С3", "С3"),
    ],
)
def test_class_mention_found(text, want):
    (e,) = extract_class_mentions(mk_doc([text]), spec())
    assert e.value_text == want and e.code == "M-023" and e.page == 1
    assert e.value_num is None and e.confidence == 1.0
    assert e.meta == {
        "quote": e.line_text,
        "qualifier": None,
        "excluded": None,
        "excluded_why": None,
        "ops": ["ENT-16", "NRM-03", "NRM-04"],
    }
    assert want in e.line_text and "конструктивной" in e.line_text


@pytest.mark.l1_functional
def test_anchor_split_across_lines():
    """Оборот разорван переносом строки — склейка страницы его собирает; рамка якоря — на обеих строках."""
    doc = mk_doc(
        [
            "Здание относится к классу конструктивной",
            "пожарной опасности С0 и II степени огнестойкости",
        ]
    )
    (e,) = extract_class_mentions(doc, spec())
    assert e.value_text == "С0" and e.raw == "С0"
    line0, line1 = doc.pages[0].lines
    assert (
        e.anchor_bbox[1] == line0.words[0].bbox[1]
        and e.anchor_bbox[3] == line1.words[0].bbox[3]
    )
    assert e.bbox == line1.words[2].bbox  # рамка значения — ровно слово «С0»
    assert (
        e.anchor_bbox[0] == line1.words[0].bbox[0]
    )  # «пожарной» — левее всех слов якоря
    assert e.anchor_bbox[2] == line0.words[-1].bbox[2]  # «конструктивной» — правее всех


@pytest.mark.l1_functional
def test_all_mentions_on_page_and_pages_in_order():
    doc = mk_doc(
        [
            "Класс конструктивной пожарной опасности здания С0.",
            "Класс конструктивной пожарной опасности пристройки С1.",
        ],
        ["Итого: класс конструктивной пожарной опасности С2"],
    )
    got = extract_class_mentions(doc, spec())
    assert [(e.page, e.value_text) for e in got] == [(1, "С0"), (1, "С1"), (2, "С2")]
    assert got[0].bbox != got[1].bbox


@pytest.mark.l1_functional
def test_bbox_present_and_normalized():
    doc = mk_doc(
        [
            "Проектом принято:",
            "класс конструктивной пожарной опасности здания – С1;",
            "степень огнестойкости – II",
        ]
    )
    (e,) = extract_class_mentions(doc, spec())
    for b in (e.bbox, e.anchor_bbox):
        assert (
            b is not None
            and all(0.0 <= v <= 1.0 for v in b)
            and b[0] < b[2]
            and b[1] < b[3]
        )
    assert e.bbox == doc.pages[0].lines[1].words[6].bbox


@pytest.mark.l1_functional
def test_page_text_offsets_match_words():
    page = mk_page(["аа бб", "в гггг"])
    text, spans = page_text(page)
    assert text == "аа бб в гггг"
    assert [(s, e, text[s:e]) for s, e, _ in spans] == [
        (0, 2, "аа"),
        (3, 5, "бб"),
        (6, 7, "в"),
        (8, 12, "гггг"),
    ]


@pytest.mark.l1_functional
def test_confidence_text_and_ocr():
    line = ["Класс конструктивной пожарной опасности С1"]
    assert (
        extract_class_mentions(mk_doc(mk_page(line, source="structured")), spec())[
            0
        ].confidence
        == 1.0
    )
    assert (
        extract_class_mentions(mk_doc(mk_page(line, source="ocr", conf=80.0)), spec())[
            0
        ].confidence
        == 0.8
    )
    assert (
        extract_class_mentions(mk_doc(mk_page(line, source="ocr", conf=None)), spec())[
            0
        ].confidence
        == 0.5
    )
    # слово значения спорное — ×0,6; спорное слово якоря уверенность значения не снижает
    assert (
        extract_class_mentions(
            mk_doc(mk_page(line, source="ocr", conf=80.0, disputed={"С1"})), spec()
        )[0].confidence
        == 0.48
    )
    assert (
        extract_class_mentions(
            mk_doc(mk_page(line, source="ocr", conf=80.0, disputed={"пожарной"})),
            spec(),
        )[0].confidence
        == 0.8
    )
    assert (
        extract_class_mentions(
            mk_doc(mk_page(line, source="text", disputed={"С1"})), spec()
        )[0].confidence
        == 0.6
    )


@pytest.mark.l1_functional
def test_quote_is_bounded_and_centered():
    pre, post = "Раздел 9. " + "бетон " * 60, " Далее " + "плита " * 60
    (e,) = extract_class_mentions(
        mk_doc([pre + "класс конструктивной пожарной опасности С1" + post]), spec()
    )
    assert (
        len(e.meta["quote"]) <= 240
        and "класс конструктивной пожарной опасности С1" in e.meta["quote"]
    )
    q = e.meta["quote"]
    assert (
        abs(q.index("конструктивной") - (len(q) - q.index("С1") - 2)) <= 1
    )  # поровну по обе стороны
    assert len(q) >= 238  # контекст добран до предела
    # оборот со значением длиннее предела — цитата ровно от якоря до значения, без контекста
    wide = ANCHOR + " " + "." * 250 + "С1."
    (w,) = extract_class_mentions(mk_doc([wide]), spec(window=300))
    assert w.meta["quote"] == wide[6:-1]
    (short,) = extract_class_mentions(
        mk_doc(["Класс конструктивной пожарной опасности С1"]), spec()
    )
    assert short.meta["quote"] == "Класс конструктивной пожарной опасности С1"


@pytest.mark.l1_functional
def test_extract_routes_class_spec_to_mentions_only():
    """extract(): параметр с извлекателем — все упоминания с meta; лексический путь его не видит;
    соседний обычный параметр извлекается как прежде."""
    doc = mk_doc(
        [
            "Класс конструктивной пожарной опасности С0",
            "Степень огнестойкости II",
            "Класс конструктивной пожарной опасности пристройки С1",
        ]
    )
    roman = ParamSpec(
        code="M-022",
        anchors=["Степень огнестойкости"],
        data_type="enum",
        regex_pattern=r"\b(V|IV|III|II|I)\b",
    )
    got = extract(doc, [spec(), roman])
    assert [(e.code, e.value_text) for e in got] == [
        ("M-022", "II"),
        ("M-023", "С0"),
        ("M-023", "С1"),
    ]
    assert got[0].meta is None and all(e.meta for e in got[1:])
    # без извлекателя (или с другим kind) — прежний лексический путь: одна запись, meta нет
    for plain in (
        ParamSpec(
            code="M-023",
            anchors=["Класс конструктивной пожарной опасности"],
            data_type="string",
        ),
        ParamSpec(
            code="M-023",
            anchors=["Класс конструктивной пожарной опасности"],
            data_type="string",
            extractor={"kind": "other"},
        ),
    ):
        (e,) = extract(doc, [plain])
        assert e.meta is None


@pytest.mark.l1_functional
def test_reread_skips_class_mentions():
    """Перечитывание OCR (2.2.12) параметр с упоминаниями не трогает, даже если у него есть шаблон значения."""
    page = mk_page(
        ["Класс конструктивной пожарной опасности С1"],
        source="ocr",
        conf=70.0,
        disputed={"С1"},
    )
    doc = mk_doc(page)
    sp = spec().model_copy(update={"regex_pattern": r"C[0-3]"})
    found = extract(doc, [sp])
    calls = []
    out = R.refine(
        doc,
        [sp],
        found,
        lambda n: calls.append(n),
        ocr=lambda img, allowed: calls.append(img) or [],
    )
    assert out == found and calls == []


@pytest.mark.l1_functional
def test_analyze_passes_extractor_and_returns_meta(tmp_path, monkeypatch):
    """/analyze: extractor доходит до извлечения, meta — до ответа; ключ кэша зависит от extractor."""
    import importlib

    from fastapi.testclient import TestClient

    import inspector_ml.app as app_mod

    blob = b"%PDF-1.4 synthetic"
    sha = hashlib.sha256(blob).hexdigest()
    (tmp_path / "blobs").mkdir()
    (tmp_path / "blobs" / sha).write_bytes(blob)
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("INSPECTOR_BLOB_DIR", str(tmp_path / "blobs"))
    importlib.reload(app_mod)
    doc = mk_doc(["Класс конструктивной пожарной опасности – не ниже С1"])
    import inspector_ml.docstore as docstore  # разбор идёт через общий кэш разобранных документов (T-130)

    monkeypatch.setattr(
        docstore, "parse_file", lambda path, s: doc.model_copy(update={"sha256": s})
    )
    body = {"sha256": sha, "params": [spec().model_dump()]}
    (e,) = TestClient(app_mod.app).post("/analyze", json=body).json()["extractions"]
    assert (
        e["value_text"] == "С1"
        and e["meta"]["qualifier"] == "min"
        and e["meta"]["ops"] == ["ENT-16", "NRM-03", "NRM-04"]
    )
    k = app_mod._cache_key(app_mod.AnalyzeRequest(**body))
    k2 = app_mod._cache_key(
        app_mod.AnalyzeRequest(sha256=sha, params=[spec(window=100)])
    )
    assert k != k2 and f"-x{app_mod.EXTRACT_REV}" in k and app_mod.EXTRACT_REV >= 6


# ─────────────────────────────── L3: граничные случаи нормализации и окна (2.2.14)


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "value, want",
    [
        ("C0", "С0"),  # латинская C (NRM-03)
        ("c1", None),  # строчная буква — не обозначение класса («опасности со 2…», решение T-129 на реальном пакете)
        ("с2", None),
        ("С 0", "С0"),  # пробел внутри обозначения
        ("СО", "С0"),  # кириллическая О вместо нуля (NRM-04)
        ("CO", "С0"),  # латинские C и O
        ("Со", "С0"),
        ("Сo", "С0"),
        ("С3", "С3"),
        ("С4", None),  # вне шкалы — упоминания нет
        ("С10", None),  # «С1» внутри числа — не класс
        ("АС1", None),  # буква перед «С» — часть другого слова
        ("С1а", None),
    ],
)
def test_value_normalization(value, want):
    got = values(mk_doc([f"Класс конструктивной пожарной опасности {value}."]))
    assert got == ([want] if want else [])


@pytest.mark.l3_boundary
def test_confidence_rounded_to_3_digits():
    page = mk_page(["Класс конструктивной пожарной опасности С1"], source="ocr", conf=77.77)
    assert extract_class_mentions(mk_doc(page), spec())[0].confidence == 0.778


@pytest.mark.l3_boundary
def test_normalize_class_direct():
    assert normalize_class("C 0") == "С0"
    assert normalize_class("cO") == "С0"
    assert normalize_class("С2") == "С2"


@pytest.mark.l3_boundary
def test_scale_filters_values():
    doc = mk_doc(["Класс конструктивной пожарной опасности С2"])
    assert values(doc, spec(scale=["С1", "С0"])) == []
    assert values(doc, spec(scale=["С2"])) == ["С2"]
    no_scale = CFG.copy()
    del no_scale["scale"]
    assert values(doc, ParamSpec(code="M-023", anchors=["x"], extractor=no_scale)) == [
        "С2"
    ]  # без шкалы — не отбрасываем
    # упоминание вне шкалы не обрывает поиск по странице: следующее на шкале — выдаётся
    two = mk_doc(["Класс конструктивной пожарной опасности С2; класс конструктивной пожарной опасности пристройки С1"])
    assert values(two, spec(scale=["С1", "С0"])) == ["С1"]


@pytest.mark.l3_boundary
def test_anchor_case_insensitive():
    assert values(mk_doc(["КЛАСС КОНСТРУКТИВНОЙ ПОЖАРНОЙ ОПАСНОСТИ – С1"])) == ["С1"]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "gap, found", [(0, False), (1, True), (17, True), (18, True), (19, False), (40, False)]
)
def test_window_boundary(gap, found):
    """Значение должно ЦЕЛИКОМ лечь в окно: конец значения ≤ конец якоря + window (здесь window = 20).
    gap = 0 — «опасностиС1»: значение слеплено с якорем и съедено им, это не класс."""
    text = ANCHOR + "." * gap + "С1"
    assert values(mk_doc([text]), spec(window=20)) == (["С1"] if found else [])


@pytest.mark.l3_boundary
def test_default_window_is_passport_160():
    ex = {k: v for k, v in CFG.items() if k != "window"}
    sp = ParamSpec(code="M-023", anchors=["x"], extractor=ex)
    assert values(mk_doc([ANCHOR + "." * 158 + "С1"]), sp) == ["С1"]
    assert values(mk_doc([ANCHOR + "." * 159 + "С1"]), sp) == []


@pytest.mark.l3_boundary
def test_window_cut_at_next_anchor():
    """Значение следующего оборота не приписывается предыдущему, у которого своего значения нет."""
    doc = mk_doc(
        [
            "Класс конструктивной пожарной опасности не указан; класс конструктивной пожарной опасности пристройки С1"
        ]
    )
    (e,) = extract_class_mentions(doc, spec())
    assert e.value_text == "С1"
    words = doc.pages[0].lines[0].words
    assert e.anchor_bbox[0] == words[7].bbox[0]  # якорь — второй оборот (с «конструктивной», после «класс»)
    # одно значение между двумя оборотами — первому; у второго значения нет
    assert values(mk_doc([ANCHOR + " С1 " + ANCHOR]), spec()) == ["С1"]


@pytest.mark.l1_functional
@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "text, qualifier",
    [
        (
            "Степень огнестойкости и класс конструктивной пожарной опасности не ниже II, С0",
            "min",
        ),
        ("Класс конструктивной пожарной опасности должен быть не хуже С1", "min"),
        ("Класс конструктивной пожарной опасности — не менее С1", "min"),
        ("Обеспечить не ниже класса конструктивной пожарной опасности С1", "min"),
        ("Класс конструктивной пожарной опасности НЕ  НИЖЕ С1", "min"),
        ("Класс конструктивной пожарной опасности С1", None),
        (
            "Класс конструктивной пожарной опасности С1 не ниже нормы",
            None,
        ),  # маркер после значения
        (
            "не ниже" + "." * 28 + "класс конструктивной пожарной опасности С1",
            None,
        ),  # якорь — с «конструктивной»: маркер начинается за 41 знак до него, «е ниже» — обрезан
        (
            "не ниже" + "." * 27 + "класс конструктивной пожарной опасности С1",
            "min",
        ),  # ровно 40
    ],
)
def test_constraint_qualifier(text, qualifier):
    (e,) = extract_class_mentions(mk_doc([text]), spec())
    assert e.meta["qualifier"] == qualifier


@pytest.mark.l3_boundary
def test_constraint_marker_split_by_line_break():
    (e,) = extract_class_mentions(
        mk_doc(["Класс конструктивной пожарной опасности не", "ниже С0"]), spec()
    )
    assert e.meta["qualifier"] == "min"


# ─────────────────────────────── L6: ловушки отсева (2.2.15) и враждебный ввод


@pytest.mark.l6_adversarial
def test_neighbor_building_excluded_with_reason():
    doc = mk_doc(
        [
            "Находится с юга от участка здание склада, класс конструктивной пожарной опасности зданий - С1.",
            "Расстояние – 8 м.",
        ]
    )
    (e,) = extract_class_mentions(doc, spec())
    assert e.value_text == "С1" and e.meta["excluded"] == "NEIGHBOR"
    assert (
        e.meta["excluded_why"] == next(rule["why"] for rule in PASSPORT["extractor"]["exclude"] if rule["code"] == "NEIGHBOR")
    )


@pytest.mark.l6_adversarial
def test_neighbor_context_bounds():
    """Слово-признак дальше 120 знаков до якоря или дальше 40 после значения отсев не включает."""
    # якорь начинается с «конструктивной», перед ним «класс » (6 знаков)
    # признак соседа — «находится с юга» (сторона света) и «расстояние 8» (число после), паспорт T-129
    far = "находится с юга" + "." * 100 + ANCHOR + " С1"  # «аходится с юга» — признак обрезан
    near = "находится с юга" + "." * 99 + ANCHOR + " С1"  # признак ровно в 120 знаках
    after_far = ANCHOR + " С1" + "." * 29 + "расстояние 8"  # «расстояние 8» кончается на 41-м знаке
    after_near = ANCHOR + " С1" + "." * 28 + "расстояние 8"  # ровно на 40-м
    got = {t: summary(mk_doc([t]))[0][3] for t in (far, near, after_far, after_near)}
    assert got == {far: None, near: "NEIGHBOR", after_far: None, after_near: "NEIGHBOR"}


@pytest.mark.l6_adversarial
def test_norm_table_excluded():
    (e,) = extract_class_mentions(
        mk_doc(["Класс конструктивной пожарной опасности здания: С0 С1 С2, С3"]), spec()
    )
    assert e.value_text == "С0" and e.meta["excluded"] == "NORM_TABLE"
    assert e.meta["excluded_why"].startswith("таблица нормативных значений")


@pytest.mark.l6_adversarial
def test_norm_table_before_anchor_does_not_exclude():
    """Ряд классов ДО оборота — чужая таблица; NORM_TABLE смотрит только после якоря."""
    assert summary(
        mk_doc(
            ["Таблица 22: С0 С1 С2. Класс конструктивной пожарной опасности здания С1"]
        )
    ) == [(1, "С1", None, None)]
    # ряд, кончающийся в 40 знаках за значением, — ещё таблица; дальше — нет
    assert summary(mk_doc([ANCHOR + " С1" + "." * 32 + "С1 С2 С3"]))[0][3] == "NORM_TABLE"  # ряд кончается на 40-м
    assert summary(mk_doc([ANCHOR + " С1" + "." * 33 + "С1 С2 С3"]))[0][3] is None


@pytest.mark.l6_adversarial
def test_heading_without_value_gives_no_mention():
    doc = mk_doc(
        [
            "Описание и обоснование принятых решений, определяющих степень огнестойкости и класса конструктивной",
            "пожарной опасности строительных конструкций",
        ]
    )
    assert extract_class_mentions(doc, spec()) == []


@pytest.mark.l6_adversarial
def test_heading_with_value_excluded():
    (e,) = extract_class_mentions(
        mk_doc(
            [
                "Предел огнестойкости в зависимости от класса конструктивной пожарной опасности С0"
            ]
        ),
        spec(),
    )
    assert e.meta["excluded"] == "HEADING"


@pytest.mark.l6_adversarial
def test_first_matching_rule_wins():
    (e,) = extract_class_mentions(
        mk_doc(
            ["Существующее здание: класс конструктивной пожарной опасности С0 С1 С2"]
        ),
        spec(),
    )
    assert e.meta["excluded"] == "NEIGHBOR"


@pytest.mark.l6_adversarial
def test_hostile_input_does_not_crash():
    long_run = "а" * 100_000
    pages = [
        Page(page=1, width=1, height=1, source="text", lines=[]),
        mk_page([""], 2),
        mk_page([long_run], 3),
        mk_page(["С0" * 20_000], 4),
        mk_page([ANCHOR * 500], 5),
        mk_page([long_run + ANCHOR + "С1" + long_run], 6),
    ]
    doc = ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=pages)
    got = extract_class_mentions(doc, spec())
    assert [
        (e.page, e.value_text) for e in got
    ] == []  # «опасностиС1» — значение слеплено с якорем, не класс
    assert (
        extract_class_mentions(doc, spec(exclude=None, constraint_markers=None)) == []
    )
    assert (
        extract_class_mentions(
            mk_doc([ANCHOR + " С1"]),
            ParamSpec(
                code="M-023",
                anchors=["x"],
                extractor={
                    "kind": "class_mentions",
                    "anchor": CFG["anchor"],
                    "value": CFG["value"],
                },
            ),
        )[0].meta["excluded"]
        is None
    )


@pytest.mark.l6_adversarial
def test_words_without_bbox():
    """Структурированный документ (DOCX) — слов без геометрии: упоминание есть, рамок нет."""
    page = mk_page(["Класс конструктивной пожарной опасности С1"], source="structured")
    page.lines[0].words = [
        w.model_copy(update={"bbox": None}) for w in page.lines[0].words
    ]
    (e,) = extract_class_mentions(mk_doc(page), spec())
    assert e.value_text == "С1" and e.bbox is None and e.anchor_bbox is None


# ─────────────────────────────── L5: свойства (детерминированный перебор, hypothesis в проекте нет)

TEMPLATES = [
    "Класс конструктивной пожарной опасности здания – {v}.",
    "По конструктивной пожарной опасности здание относится к классу {v}",
    "Здание склада, класс конструктивной пожарной опасности зданий - {v}. Расстояние – 8 м",
    "Класс конструктивной пожарной опасности не ниже {v}",
    "Класс конструктивной пожарной опасности здания: {v} {w}",
    "в зависимости от класса конструктивной пожарной опасности {v}",
]
FORMS = ["С0", "С1", "С 2", "СО", "С3"]
NOISE = [
    "бетон",
    "плита",
    "перекрытия",
    "этаж",
    "фасад",
    "кровля",
    "лестница",
    "3,5",
    "м",
    "мм",
    "IV",
    "проект",
    "лист",
    "узел",
    ";",
    "—",
    "отм.",
    "+12,600",
]


def _corpus() -> list[list[str]]:
    out = []
    for i, t in enumerate(TEMPLATES):
        for j, v in enumerate(FORMS):
            w = FORMS[(j + 1) % len(FORMS)]
            out.append([t.format(v=v, w=w)])
            out.append(
                [
                    t.format(v=v, w=w),
                    TEMPLATES[(i + 1) % len(TEMPLATES)].format(v=w, w=v),
                ]
            )
    return out


def _noise(rnd: random.Random) -> str:
    return " ".join(rnd.choice(NOISE) for _ in range(rnd.randint(1, 60)))


@pytest.mark.l5_property
@pytest.mark.parametrize("lines", _corpus())
def test_property_latin_c_does_not_change_result(lines):
    """Замена кириллической «С» латинской (двойник из OCR) не меняет ни значений, ни пометок, ни рамок."""
    swapped = [s.replace("С", "C") for s in lines]
    a = extract_class_mentions(mk_doc(lines), spec())
    b = extract_class_mentions(mk_doc(swapped), spec())
    assert a  # корпус составлен так, что в каждой странице есть упоминание
    assert [
        (e.value_text, e.meta["qualifier"], e.meta["excluded"], e.bbox, e.anchor_bbox)
        for e in a
    ] == [
        (e.value_text, e.meta["qualifier"], e.meta["excluded"], e.bbox, e.anchor_bbox)
        for e in b
    ]


@pytest.mark.l5_property
@pytest.mark.parametrize("seed", range(40))
def test_property_noise_without_anchor_keeps_values(seed):
    """Вставка текста без оборота (строками в начало и конец страницы, отдельными страницами) не меняет найденного."""
    rnd = random.Random(seed)
    corpus = _corpus()
    pages = [rnd.choice(corpus) for _ in range(rnd.randint(1, 4))]
    base = [t[1:] for t in summary(mk_doc(*pages))]
    noisy = []
    for p in pages:
        if rnd.random() < 0.3:
            noisy.append([_noise(rnd)])  # страница шума
        noisy.append(
            [_noise(rnd) for _ in range(rnd.randint(0, 3))]
            + p
            + [_noise(rnd) for _ in range(rnd.randint(0, 3))]
        )
    assert [t[1:] for t in summary(mk_doc(*noisy))] == base


@pytest.mark.l5_property
@pytest.mark.parametrize("seed", range(10))
def test_property_page_order_permutes_result(seed):
    rnd = random.Random(1000 + seed)
    pages = [rnd.choice(_corpus()) for _ in range(4)]
    order = list(range(4))
    rnd.shuffle(order)
    by_page = {i: [t[1:] for t in summary(mk_doc(p))] for i, p in enumerate(pages)}
    got = [t[1:] for t in summary(mk_doc(*[pages[i] for i in order]))]
    assert got == [x for i in order for x in by_page[i]]


# ─────────────────────────────── L2: дифференциальная сверка с независимым простым пересчётом

_NAIVE_VALUE = r"(?<![А-Яа-яA-Za-z0-9])[СC]\s?[0-3ОOоo](?![0-9А-Яа-яA-Za-z])"
_NAIVE_NORM = {
    "C": "С",
    "c": "С",
    "с": "С",
    "С": "С",
    "О": "0",
    "O": "0",
    "о": "0",
    "o": "0",
}


def _naive(lines: list[str], window: int = 160, before: int = 40) -> list[str]:
    text = " ".join(lines)
    starts = [
        (m.start(), m.end())
        for m in re.finditer(r"конструктивн\w*\s+пожарн\w*\s+опасност\w*", text, re.I)
    ]
    out = []
    consumed = 0
    for k, (start, end) in enumerate(starts):
        stop = min(end + window, starts[k + 1][0] if k + 1 < len(starts) else len(text))
        separator = text.find(";", end, stop)
        if separator >= 0:
            stop = separator  # forward values belong to this list item only
        found = re.findall(_NAIVE_VALUE, text[end:stop])
        prefix = text[max(consumed, start - before):start]
        reverse = re.search("(" + _NAIVE_VALUE + r")\s*(?:[—–:-]\s*)?(?:(?i:класс\w*)\s+)?$", prefix)
        if reverse:
            found = [reverse.group(1)]
        if found:
            out.append(
                "".join(_NAIVE_NORM.get(ch, ch) for ch in found[0] if not ch.isspace())
            )
            tail = re.search(_NAIVE_VALUE, text[end:stop])
            consumed = end + tail.end() if tail and not reverse else end
    return out


@pytest.mark.l2_differential
@pytest.mark.parametrize("seed", range(60))
def test_differential_against_naive_recount(seed):
    rnd = random.Random(seed)
    lines = []
    for _ in range(rnd.randint(1, 5)):
        parts = [
            _noise(rnd) if rnd.random() < 0.5 else "",
            rnd.choice(
                [
                    "класс конструктивной пожарной опасности",
                    "Класс конструктивной\nпожарной опасности",
                    "по конструктивной пожарной опасности здание относится к классу",
                    "степень огнестойкости",
                ]
            ),
            " ".join(rnd.choice(NOISE) for _ in range(rnd.randint(0, 8))),
            rnd.choice(FORMS + ["C1", "с0", "С4", ""]),
            _noise(rnd) if rnd.random() < 0.5 else "",
        ]
        lines += " ".join(p for p in parts if p).split("\n")
    # The naive oracle models the original window grammar, not T-172's later
    # sentence boundaries/value-before-anchor repair. Compare like contracts.
    got = [e.value_text for e in extract_class_mentions(mk_doc(lines), spec(exclude_scope='window', before=0))]
    assert got == _naive(lines, before=0)
