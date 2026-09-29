"""OS-INSP-2.1.60–2.1.61, 2.2.152–2.2.157 (T-214): упоминания направления открывания эвакуационных дверей (М-043, М-106).

Только синтетические строки. Конфигурация извлекателя — из паспортов data/seed/passports/M-043.json и M-106.json, как её
передаёт API (passport.ts: extractorSpec — объект extractor как есть). Проверяются и отказы: Л/П, отрицание, двусмысленность,
дверь без признака эвакуационной, оговорка нормы — отсев или пометка с причиной, а не догадка.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.direction_mentions import (
    extract_direction_mentions,
    is_direction_mentions,
    normalize_mark,
)
from inspector_ml.extract import extract
from inspector_ml.extractor_kinds import way_by_kind
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
PASSPORT = json.loads((ROOT / "data/seed/passports/M-043.json").read_text("utf-8"))
CFG = PASSPORT["extractor"]


def spec(code: str = "M-043") -> ParamSpec:
    return ParamSpec(
        code=code,
        anchors=["Направление открывания эвакуационных дверей"],
        data_type="string",
        extractor=CFG,
    )


def mk_page(
    lines: list[str],
    n: int = 1,
    source: str = "text",
    conf: float | None = None,
    disputed: frozenset[str] = frozenset(),
) -> Page:
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


def summary(*lines: str) -> list[tuple]:
    return [
        (e.meta["mark"], e.value_text, e.meta["excluded"])
        for e in extract_direction_mentions(mk_doc(list(lines)), spec())
    ]


# ─────────────────────────────── L1: основной путь (2.2.152, 2.2.153)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "row, want",
    [
        (
            "Д1 | ДПН 21-10 | 1 | эвакуационный выход | открывание по направлению выхода из здания",
            ("Д1", "outward"),
        ),
        ("Д-2 эвакуационная наружу Л", ("Д2", "outward")),
        ("ДН 3 | эвакуационный | внутрь", ("ДН3", "inward")),
        ("Д4 | дверь на путь эвакуации | против хода эвакуации", ("Д4", "inward")),
        ("Д5 | по ходу эвакуации", ("Д5", "outward")),
    ],
)
def test_door_row_direction_by_mark(row, want):
    (e,) = extract_direction_mentions(mk_doc([row]), spec())
    assert (e.meta["mark"], e.value_text) == want
    assert (
        e.meta["scope"] == "door"
        and e.meta["excluded"] is None
        and e.meta["evac"] is True
    )
    assert e.code == "M-043" and e.page == 1 and e.confidence == 1.0
    assert (
        e.bbox is not None
        and e.anchor_bbox is not None
        and e.meta["ops"] == ["ENT-10", "NRM-06"]
    )
    assert e.line_text == e.meta["quote"] and e.meta["quote"].startswith(
        row.split(" ")[0][:1]
    )


@pytest.mark.l1_functional
def test_general_statement_of_explanatory_note():
    doc = mk_doc(
        [
            "Мероприятия по эвакуации.",
            "Двери эвакуационных выходов открываются по направлению",
            "выхода из здания. Лестничные клетки типа Л1.",
        ]
    )
    (e,) = extract_direction_mentions(doc, spec())
    assert (e.meta["mark"], e.meta["scope"], e.value_text, e.meta["excluded"]) == (
        None,
        "general",
        "outward",
        None,
    )
    assert "по направлению выхода" in e.raw.replace("  ", " ")
    assert e.meta["quote"].startswith("Двери эвакуационных выходов")


@pytest.mark.l1_functional
def test_mark_normalization():
    assert [normalize_mark(x) for x in ["Д-1", "Д 1", "ДН-2", "Д-10.1", "Д1а"]] == [
        "Д1",
        "Д1",
        "ДН2",
        "Д10.1",
        "Д1А",
    ]


@pytest.mark.l1_functional
def test_several_marks_in_one_line_split_by_mark():
    """OS-INSP-2.1.60: признаки относятся к своей марке — «наружу» Д1 не становится направлением Д2."""
    assert summary("Д1 эвакуационная наружу Д2 эвакуационная внутрь Д3 кладовая") == [
        ("Д1", "outward", None),
        ("Д2", "inward", None),
    ]


@pytest.mark.l1_functional
def test_registered_in_extractor_kinds():
    """T-186: вид direction_mentions зарегистрирован в реестре извлекателей — extract.py ведёт его своим путём."""
    assert way_by_kind("direction_mentions") is extract_direction_mentions


@pytest.mark.l1_functional
def test_pipeline_extract_takes_own_path_all_mentions():
    doc = mk_doc(["Д1 эвакуационная наружу", "Д2 эвакуационная наружу"])
    got = [
        e for e in extract(doc, [spec(), spec("M-106")]) if e.code in {"M-043", "M-106"}
    ]
    assert sorted((e.code, e.meta["mark"]) for e in got) == [
        ("M-043", "Д1"),
        ("M-043", "Д2"),
        ("M-106", "Д1"),
        ("M-106", "Д2"),
    ]
    assert is_direction_mentions(spec()) and not is_direction_mentions(
        ParamSpec(code="M-001", anchors=[])
    )


@pytest.mark.l1_functional
def test_gost_door_type_is_not_a_mark():
    """OS-INSP-2.1.60: «ДПН 21-10», «ДГ 21-9» — тип двери по ГОСТ, а не марка: направление остаётся у марки строки."""
    assert summary("Д1 | ДПН 21-10 | эвакуационная | наружу", "Д2 | ДГ 21-9 | эвакуационная | внутрь") == [("Д1", "outward", None), ("Д2", "inward", None)]


# ─────────────────────────────── L3: границы и отказы (2.2.154–2.2.157, 2.1.61)


@pytest.mark.l3_boundary
def test_hand_only_is_not_direction():
    """OS-INSP-2.2.154: Л/П — сторона навески; у эвакуационной двери — пометка HAND_ONLY, а не направление."""
    assert summary("Д1 | эвакуационная | Л") == [("Д1", "hand", "HAND_ONLY")]
    assert (
        summary("Д7 | кладовая | П") == []
    )  # не эвакуационная и без направления — упоминания нет
    assert summary("Д1 правая эвакуационная") == [("Д1", "hand", "HAND_ONLY")]


@pytest.mark.l3_boundary
def test_door_without_evacuation_attribute_dropped_with_reason():
    """OS-INSP-2.2.155: «внутрь» у двери без признака эвакуационной — отсев NOT_EVAC с причиной."""
    (e,) = extract_direction_mentions(mk_doc(["Д3 | санузел | внутрь"]), spec())
    assert (e.value_text, e.meta["excluded"]) == ("inward", "NOT_EVAC")
    assert "вне путей эвакуации" in e.meta["excluded_why"] and e.meta["evac"] is False


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "text",
    [
        "Допускается открывание внутрь дверей эвакуационных выходов из помещений с одновременным пребыванием не более 15 человек.",
        "Двери эвакуационных выходов из помещений до 15 чел. открываются внутрь.",
    ],
)
def test_exemption_inward_marked_exempt(text):
    """OS-INSP-2.2.156: оговорка нормы — EXEMPT с причиной, не значение объекта."""
    (e,) = extract_direction_mentions(mk_doc([text]), spec())
    assert (e.value_text, e.meta["excluded"]) == ("inward", "EXEMPT")
    assert "15 человек" in e.meta["excluded_why"]


@pytest.mark.l3_boundary
def test_exemption_next_to_outward_keeps_value_with_note():
    text = "Двери эвакуационных выходов открываются по направлению выхода из здания, за исключением дверей помещений с одновременным пребыванием не более 15 человек."
    (e,) = extract_direction_mentions(mk_doc([text]), spec())
    assert (e.value_text, e.meta["excluded"]) == ("outward", None)
    assert e.meta["exemption"] and "15 человек" in e.meta["exemption"]
    both = "Двери эвакуационных выходов открываются наружу; допускается открывание внутрь дверей помещений с пребыванием не более 15 человек."
    assert [
        (x.value_text, x.meta["excluded"])
        for x in extract_direction_mentions(mk_doc([both]), spec())
    ] == [("outward", None), ("inward", "EXEMPT")]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "text, code",
    [
        ("Двери эвакуационных выходов не должны открываться внутрь.", "NEGATION"),
        ("Д1 эвакуационная не открывается наружу", "NEGATION"),
        ("Двери эвакуационных выходов открываются наружу и внутрь.", "AMBIGUOUS"),
    ],
)
def test_negation_and_both_directions_dropped(text, code):
    """OS-INSP-2.2.157: отрицание и оба направления без оговорки — отсев с причиной, а не догадка."""
    (e,) = extract_direction_mentions(mk_doc([text]), spec())
    assert e.meta["excluded"] == code and e.meta["excluded_why"]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "text",
    [
        "Направление открывания показано на планах этажей.",  # нет направления
        "Лестничная клетка типа Н1, выход наружу по наружной лестнице.",  # нет двери и открывания
        "Д1 эвакуационная",  # марка без направления и без Л/П
    ],
)
def test_no_value_no_mention(text):
    assert extract_direction_mentions(mk_doc([text]), spec()) == []


@pytest.mark.l3_boundary
def test_door_without_any_evacuation_sign_kept_with_unknown_evac():
    """OS-INSP-2.2.155: признака нет ни «за», ни «против» — упоминание сохраняется с evac = None; решает API (3.1.178)."""
    (e,) = extract_direction_mentions(mk_doc(["Двери открываются внутрь помещения."]), spec())
    assert (e.value_text, e.meta["excluded"], e.meta["evac"]) == ("inward", None, None)


@pytest.mark.l3_boundary
def test_raster_arc_not_read_scan_without_text_gives_nothing():
    """OS-INSP-2.1.61: направление только по тексту; лист-скан без распознанного текста (дуга на плане) — упоминаний нет."""
    assert (
        extract_direction_mentions(mk_doc(mk_page([], source="ocr", conf=90)), spec())
        == []
    )


@pytest.mark.l3_boundary
def test_ocr_confidence_and_disputed_word_lower_confidence():
    page = mk_page(
        ["Д1 эвакуационная внутрь"],
        source="ocr",
        conf=80,
        disputed=frozenset({"внутрь"}),
    )
    (e,) = extract_direction_mentions(mk_doc(page), spec())
    assert e.confidence == pytest.approx(0.8 * 0.6)


@pytest.mark.l3_boundary
def test_lowercase_do_is_not_a_mark_and_paragraph_letter_not_hand():
    assert summary(
        "до 2 этажей двери открываются по направлению эвакуации, см. п. 4"
    ) == [(None, "outward", None)]


# ─────────────────────────────── L3: формы записи и классы dev-настройки (2.1.62, 2.2.158, 2.2.159)


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "row, want",
    [
        ("Д-4 | нaружу | эвак.", ("Д4", "outward")),  # латинская «a» в слове
        ("ЭB-2 — внутрь", ("ЭВ2", "inward")),  # латинская «B» в марке эвакуационного выхода
        ("D-3 наружу (эвак.)", ("Д3", "outward")),  # марка латиницей
        ("Д-5 | нарvжу | эвак.", ("Д5", "outward")),  # OCR: «v» вместо «у»
        ("Д-6 — откр. нар. (эвак.)", ("Д6", "outward")),
        ("Д-7 | откр. по напр. эвакуации", ("Д7", "outward")),
        ("Д-8 | внутр. | эвак. выход", ("Д8", "inward")),
    ],
)
def test_homoglyphs_ocr_and_abbreviations(row, want):
    """OS-INSP-2.2.158: латиница, похожая на кириллицу, OCR-подмена «v» → «у» и сокращения «откр. нар.», «по напр.»."""
    (e,) = extract_direction_mentions(mk_doc([row]), spec())
    assert (e.meta["mark"], e.value_text, e.meta["excluded"]) == (*want, None)


@pytest.mark.l3_boundary
def test_latin_without_cyrillic_not_folded_and_mark_without_direction_ignored():
    assert summary("D-3 | see drawing") == [] and summary("Д-2 — см. лист 4") == [("Д2", "graphic", "GRAPHIC_ONLY")]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "text, want",
    [
        ("Двери эвакуационных выходов: открывание наружу", "outward"),
        ("Эвакуационные двери — наружу.", "outward"),
        ("Двери на путях эвакуации — по направлению выхода.", "outward"),
    ],
)
def test_label_colon_value_form(text, want):
    """OS-INSP-2.2.158: форма «Подпись: значение» и «подпись — значение» без глагола «открываются»."""
    (e,) = extract_direction_mentions(mk_doc([text]), spec())
    assert (e.meta["scope"], e.value_text, e.meta["excluded"]) == ("general", want, None)


@pytest.mark.l3_boundary
def test_reference_to_drawing_only_is_graphic():
    got = extract_direction_mentions(mk_doc(["План 2 этажа. Направление открывания дверей — см. графическую часть."]), spec())
    assert [(e.value_text, e.meta["excluded"]) for e in got] == [("graphic", "GRAPHIC_ONLY")]


@pytest.mark.l3_boundary
def test_table_header_separate_and_rooms_outside_path():
    """Шапка ведомости отдельной строкой, направление в соседней ячейке; санузел и кладовая — вне путей эвакуации."""
    got = summary("Ведомость заполнения проёмов", "Марка | Открывание | Помещение", "Д-7 | внутрь | санузел", "Д-8 | наружу | выход из ЛК", "Д-9 | внутрь | КУИ")
    assert got == [("Д7", "inward", "NOT_EVAC"), ("Д8", "outward", None), ("Д9", "inward", "NOT_EVAC")]


@pytest.mark.l3_boundary
def test_room_occupancy_small_room_and_large_room():
    """OS-INSP-2.2.159: «4 чел.» — помещение в пределах оговорки (SMALL_ROOM); «40 чел.» — эвакуационная; «не более 15 чел.» — не число помещения."""
    assert summary("Д-9 (кабинет, 6 чел.) — внутрь") == [("Д9", "inward", "SMALL_ROOM")]
    (e,) = extract_direction_mentions(mk_doc(["Д-9 (зал, 40 чел.) — внутрь"]), spec())
    assert (e.meta["excluded"], e.meta["evac"]) == (None, True)
    (x,) = extract_direction_mentions(mk_doc(["Двери помещений до 15 чел. открываются внутрь."]), spec())
    assert x.meta["excluded"] == "EXEMPT"


@pytest.mark.l3_boundary
def test_sliding_door_and_non_evac_sliding():
    """OS-INSP-2.2.159: раздвижная дверь эвакуационного выхода — sliding; раздвижная дверь кладовой — вне путей эвакуации."""
    (e,) = extract_direction_mentions(mk_doc(["ЭВ-2 — автоматическая раздвижная дверь"]), spec())
    assert (e.value_text, e.meta["excluded"], e.meta["evac"]) == ("sliding", None, True)
    assert summary("Д-5 раздвижная, кладовая") == [("Д5", "sliding", "NOT_EVAC")]
    assert summary("ЭВ-3 — распашная, наружу") == [("ЭВ3", "outward", None)]


@pytest.mark.l3_boundary
def test_door_into_corridor_blocks_path_only_by_numbers():
    """OS-INSP-2.2.159: полотно в коридор сужает путь ниже порога паспорта — blocks с остатком ширины (гипотеза для API);
    ширины хватает или чисел нет — не значение."""
    (e,) = extract_direction_mentions(mk_doc(["Д-6 (зал, 30 чел.) — открывание в коридор, полотно 1000 при ширине коридора 1600."]), spec())
    assert (e.value_text, e.meta["evac"], e.meta["excluded"]) == ("blocks", True, None)
    assert e.meta["remaining_m"] == 0.6  # 1,6 м коридора − 1,0 м полотна: в гипотезу «сужает путь до 0,6 м»
    assert summary("Д-6 (зал, 30 чел.) — открывание в коридор, полотно 1000 при ширине коридора 2400.") == []
    assert summary("Д-6 (зал, 30 чел.) — открывание в коридор, полотно 0,9 м при ширине коридора 1,6 м.") == [("Д6", "blocks", None)]
    assert summary("Д-6 — открывание в коридор.") == []


@pytest.mark.l3_boundary
def test_building_prefix_applies_to_marks_of_line():
    """OS-INSP-2.1.62: подпись корпуса в начале строки относится к маркам строки; строчная «в» — не корпус."""
    got = extract_direction_mentions(mk_doc(["Корпус Б: ЭВ-1 внутрь", "ЭВ-2 наружу", "Двери корпуса в осях 1-3: ЭВ-4 наружу"]), spec())
    assert [(e.meta["mark"], e.meta["building"]) for e in got] == [("ЭВ1", "Б"), ("ЭВ2", None), ("ЭВ4", None)]


@pytest.mark.l3_boundary
def test_stair_door_toward_corridor_is_inward_toward_stair_is_outward():
    got = summary("Двери выхода в лестничную клетку ЛК-2 открывать в сторону холла.", "Двери в лестничную клетку открываются в сторону лестницы.")
    assert got == [(None, "inward", None), (None, "outward", None)]


@pytest.mark.l3_boundary
def test_spans_bisect_equals_linear_scan():
    """W3-06: поиск слов диапазона двумя bisect даёт ровно то же, что проход по всем словам (class_mentions._words_in)."""
    import random

    from inspector_ml.class_mentions import _words_in, page_text
    from inspector_ml.direction_mentions import Spans

    page = mk_page(["Д1 | эвакуационная | наружу  двойной пробел", "", "Двери эвакуационных выходов открываются наружу."])
    text, raw = page_text(page)
    sp = Spans(raw)
    rnd = random.Random(7)
    for _ in range(500):
        a = rnd.randrange(-2, len(text) + 3)
        b = a + rnd.randrange(0, 40)
        assert sp.words(a, b) == _words_in(raw, a, b)


# ─────────────────────────────── L6: ловушки


@pytest.mark.l6_adversarial
def test_door_row_does_not_leak_into_general_statement_and_pages_in_order():
    doc = mk_doc(
        ["Д1 эвакуационная наружу"],
        ["Двери эвакуационных выходов открываются против направления эвакуации."],
    )
    got = [
        (e.page, e.meta["mark"], e.value_text)
        for e in extract_direction_mentions(doc, spec())
    ]
    assert got == [(1, "Д1", "outward"), (2, None, "inward")]


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_long_line_is_linear_time():
    import time

    s = "двер " + "а" * 10_000 + " открыв"
    t0 = time.perf_counter()
    extract_direction_mentions(mk_doc([s, "Д1 " + "эвакуац " * 2000]), spec())
    assert time.perf_counter() - t0 < 1.0


def test_unrelated_door_heading_does_not_hide_later_opening_statement():
    doc = mk_doc(["Предел огнестойкости дверей EI 60", "Общие показатели " + "раздел " * 30,
                  "Двери на путях эвакуации открываются по направлению выхода из здания"])
    (e,) = extract_direction_mentions(doc, spec("M-106"))
    assert e.value_text == "outward" and e.meta["excluded"] is None
