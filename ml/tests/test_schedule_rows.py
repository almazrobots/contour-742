"""OS-INSP-2.1.50–2.1.52, 2.2.145–2.2.149 (T-213): строки календарного графика ПОС/ППР по паспорту — М-082 и М-087.

Только синтетические строки (ADR-0002). Формы строк — таблица с ячейками через «|» (OCR, таблица без рамок) и через
пробелы, даты вместо длительности, единица в шапке колонки, рабочие дни, итоговая строка, ссылка на график в тексте ПЗ.
Конфигурация — из паспортов M-082.json и M-087.json так же, как её собирает API (passport.ts: extractorSpec).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.extract import EXTRACT_REV, extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.schedule_rows import (
    extract_schedule_rows,
    is_schedule_rows,
    parse_row,
    to_days,
)

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)


def spec(code: str = "M-082") -> ParamSpec:
    f = ROOT / f"data/seed/passports/{code}.json"
    f = f if f.exists() else ROOT / f"data/seed/passports/draft/{code}.json"  # T-233: график — в draft/ до цифр замера
    pp = json.loads(f.read_text("utf-8"))
    ext = {
        **pp["extractor"],
        "technologies": [{k: t[k] for k in ("id", "pattern", "sentence") if k in t} for t in pp["value"]["technologies"]],
    }
    return ParamSpec(code=code, anchors=[pp["title"]], extractor=ext)


def mk_page(lines: list[str], n: int = 1, source: str = "text") -> Page:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        y = 0.05 + 0.03 * li
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(text=t, bbox=(round(x, 5), y, round(min(x + w, 1.0), 5), y + 0.02))
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return Page(
        page=n,
        width=842,
        height=595,
        source=source,
        ocr_confidence=70 if source == "ocr" else None,
        lines=out,
    )


def mk_doc(*pages: list[str] | Page) -> ParsedDoc:
    ps = [p if isinstance(p, Page) else mk_page(p, i + 1) for i, p in enumerate(pages)]
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=ps)


def rows(
    *pages: list[str], code: str = "M-082"
) -> list[tuple[str | None, float | None]]:
    return [
        (e.value_text, e.value_num)
        for e in extract_schedule_rows(mk_doc(*pages), spec(code))
    ]


@pytest.mark.l1_functional
def test_schedule_table_rows_after_heading_with_cells():
    got = extract_schedule_rows(
        mk_doc(
            [
                "6.3 Календарный план строительства",
                "№ | Наименование этапа | Продолжительность",
                "1 | Подготовительный период | 1 мес",
                "2 | Устройство подземной части | 3 мес.",
                "3 | Возведение каркаса надземной части | 120 дней",
                "4 | Благоустройство | 2 нед",
            ]
        ),
        spec(),
    )
    assert [
        (e.value_text, e.value_num, e.meta["order"], e.meta["table"]) for e in got
    ] == [
        ("Подготовительный период", 30.0, 1, 0),
        ("Устройство подземной части", 90.0, 2, 0),
        ("Возведение каркаса надземной части", 120.0, 3, 0),
        ("Благоустройство", 14.0, 4, 0),
    ]
    e = got[2]
    assert (
        e.page == 1
        and e.bbox is not None
        and e.meta["quote"].startswith("3 | Возведение")
        and e.meta["kind"] == "schedule_row"
    )
    assert (
        e.meta["calendar"] is True and "ENT-24" in e.meta["ops"] and e.confidence == 1.0
    )


@pytest.mark.l1_functional
def test_dates_give_duration_inclusive_and_are_kept():
    got = extract_schedule_rows(
        mk_doc(
            [
                "График производства работ",
                "Фундаменты 01.03.2025 30.04.2025",
                "Каркас 01.05.25 – 31.08.25 | 123 дн.",
            ]
        ),
        spec(),
    )
    assert [
        (e.value_text, e.value_num, e.meta["start"], e.meta["end"]) for e in got
    ] == [
        ("Фундаменты", 61.0, "2025-03-01", "2025-04-30"),
        ("Каркас", 123.0, "2025-05-01", "2025-08-31"),
    ]


@pytest.mark.l1_functional
def test_units_to_days_and_header_unit_for_bare_numbers():
    assert (
        to_days(2, "month") == 60
        and to_days(3, "week") == 21
        and to_days(1, "year") == 365
        and to_days(5, "day") == 5
    )
    assert rows(
        [
            "Календарный план",
            "Наименование | Продолжительность, мес",
            "Подземная часть | 4",
            "Надземная часть | 6,5",
        ]
    ) == [
        ("Подземная часть", 120.0),
        ("Надземная часть", 195.0),
    ]


@pytest.mark.l3_boundary
def test_working_days_marked_not_calendar():
    (e,) = extract_schedule_rows(
        mk_doc(["Календарный график", "Каркас 90 раб. дн."]), spec()
    )
    assert e.value_num == 90.0 and e.meta["calendar"] is False
    assert parse_row("Каркас 90 рабочих дней")["calendar"] is False
    assert parse_row("Каркас 90 кал. дн.")["calendar"] is True


@pytest.mark.l1_functional
def test_critical_marker_and_total_row():
    got = extract_schedule_rows(
        mk_doc(
            [
                "Календарный план",
                "Отделка (К) 60 дн.",
                "Кровля* 20 дн.",
                "Сети 30 дн.",
                "Итого продолжительность строительства 24 мес",
            ]
        ),
        spec(),
    )
    assert [(e.value_text, e.meta["critical"], e.meta["total"]) for e in got] == [
        ("Отделка (К)", True, False),
        ("Кровля*", True, False),
        ("Сети", False, False),
        ("Итого продолжительность строительства", False, True),
    ]
    assert got[3].value_num == 720.0


@pytest.mark.l1_functional
def test_technology_of_stage_by_passport_dictionary():
    got = extract_schedule_rows(
        mk_doc(
            [
                "Технологическая последовательность возведения",
                "1. Каркас из монолитного железобетона 120 дн.",
                "2. Каркас из сборного ж/б 100 дн.",
                "3. Перекрытия сборно-монолитные 40 дн.",
                "4. Стены из кирпичной кладки 60 дн.",
                "5. Кровля 20 дн.",
            ]
        ),
        spec("M-087"),
    )
    assert [e.meta["tech"] for e in got] == [
        "monolithic",
        "precast",
        "precast_monolithic",
        "masonry",
        None,
    ]


@pytest.mark.l6_adversarial
def test_not_a_schedule_row_heading_text_and_no_duration():
    # шапка, строка без длительности и дат, короткое имя, неверная дата — не строки графика: не выдумываем
    assert parse_row("Наименование этапа | Начало | Окончание | Продолжительность") is None
    assert parse_row("Работы выполняются в соответствии с ППР") is None
    assert parse_row("1 | 2 | 30 дн.") is None
    assert parse_row("Каркас 31.02.2025 30.04.2025") is None
    assert parse_row("Каркас 30.04.2025 01.03.2025") is None
    # аббревиатура этапа из заглавных букв — этап («ИС»), строчный обрывок — нет
    assert parse_row("ИС — 100 дн.")["name"] == "ИС" and parse_row("тр — 5 дн.") is None


@pytest.mark.l1_functional
def test_label_value_form_without_heading_several_stages_in_one_phrase():
    # «Подпись — значение» законна в тексте ПОС и без заголовка графика; в одной фразе — несколько этапов
    got = rows(["Общая продолжительность строительства 20 мес., в том числе нулевой цикл — 3 мес.; каркас: 150 дн."])
    assert got == [("Общая продолжительность строительства", 600.0), ("нулевой цикл", 90.0), ("каркас", 150.0)]
    (e,) = extract_schedule_rows(mk_doc(["Благоустройство: с 01.06.2028 по 30.06.2028."]), spec())
    assert (e.value_text, e.value_num, e.meta["start"], e.meta["end"]) == ("Благоустройство", 30.0, "2028-06-01", "2028-06-30")


@pytest.mark.l6_adversarial
def test_norm_prohibition_and_guarantee_are_not_stages():
    assert rows(["Нормативная продолжительность по СНиП — 24 мес. Принято: монтаж каркаса 7 мес."]) == [("монтаж каркаса", 210.0)]
    assert rows(["Гарантийный срок на кровлю — 5 лет."]) == []
    assert rows(["Продолжительность работ не более 10 мес."]) == []


@pytest.mark.l6_adversarial
def test_ocr_noise_latin_letters_split_digits_and_label_on_previous_line():
    # «Кaркас» с латинской a, «1 5 0 дн.», подпись и значение на двух строках, перенос слова
    assert rows(["Кaркас — 1 5 0 дн."]) == [("Каркас", 150.0)]
    assert rows(["Подземная ч. —", "95 дн."]) == [("Подземная ч", 95.0)]
    assert rows(["Благоустрой-", "ство — 20 дн."]) == [("Благоустройство", 20.0)]


@pytest.mark.l1_functional
def test_sequence_by_arrows_then_numbered_and_after():
    def seq(text: str) -> list[tuple[str, int, bool]]:
        return [(e.value_text, e.meta["order"], e.meta["seq"]) for e in extract_schedule_rows(mk_doc([text]), spec("M-087"))]

    assert seq("Очерёдность: сваи → ростверк → стены") == [("сваи", 1, True), ("ростверк", 2, True), ("стены", 3, True)]
    assert seq("Кладка, затем штукатурка, затем окраска.") == [("Кладка", 1, True), ("штукатурка", 2, True), ("окраска", 3, True)]
    # нумерация — вёрстка перечня, не очерёдность; очерёдность ей даёт заголовок «Порядок»
    assert seq("1. Демонтаж. 2. Усиление. 3. Надстройка.") == [("Демонтаж", 1, False), ("Усиление", 2, False), ("Надстройка", 3, False)]
    assert [x[2] for x in seq("Порядок: 1. Демонтаж. 2. Усиление.")] == [True, True]
    # «А до начала Б» — сначала А, порядок явный
    assert seq("Гидроизоляция до начала засыпки.") == [("Гидроизоляция", 1, True), ("засыпки", 2, True)]
    # «Б после А» — сначала А; «После А — Б, затем В» — А, Б, В
    assert seq("Окраска после штукатурки.") == [("штукатурки", 1, True), ("Окраска", 2, True)]
    assert seq("После монтажа окон — штукатурка, затем окраска.") == [("монтажа окон", 1, True), ("штукатурка", 2, True), ("окраска", 3, True)]
    # перечень через «;» или из трёх пунктов — порядок строк, не явный
    assert seq("Сваи; ростверк.") == [("Сваи", 1, False), ("ростверк", 2, False)]
    # параллельно — один номер: порядка нет
    assert [o for _, o, _ in seq("Кровля параллельно с фасадами.")] == [1, 1]


@pytest.mark.l6_adversarial
def test_prose_with_commas_and_negation_is_not_a_list():
    assert rows(["Снос выполнен до начала работ, в график не включён."], code="M-087") == []
    assert rows(["Работы ведутся в две смены, с перерывом."], code="M-087") == []


@pytest.mark.l3_boundary
def test_table_order_heading_marks_sequence_and_new_table_restarts_order():
    got = extract_schedule_rows(
        mk_doc(["Порядок", "№ | Работа", "1 | Сваи", "2 | Ростверк", "Этап | Продолжительность, нед.", "Каркас | 10"]),
        spec("M-087"),
    )
    assert [(e.value_text, e.value_num, e.meta["group"], e.meta["order"], e.meta["seq"]) for e in got] == [
        ("Сваи", None, 0, 1, True),
        ("Ростверк", None, 0, 2, True),
        ("Каркас", 70.0, 1, 1, False),
    ]


@pytest.mark.l3_boundary
def test_table_continues_on_next_page_and_ocr_confidence():
    got = extract_schedule_rows(
        mk_doc(["Этап | Продолжительность, дн.", "Фундаменты | 60"], mk_page(["Каркас | 120"], 2, source="ocr")),
        spec(),
    )
    assert [(e.value_text, e.meta["order"], e.page, e.confidence) for e in got] == [("Фундаменты", 1, 1, 1.0), ("Каркас", 2, 2, 0.7)]


@pytest.mark.l1_functional
def test_stage_description_with_technology_without_duration():
    got = extract_schedule_rows(mk_doc(["Каркас — сборный ж/б: колонны, ригели; монтаж краном.", "Перекрытия монолитные."]), spec("M-087"))
    assert [(e.value_text, e.meta["tech"]) for e in got] == [("Каркас", "precast"), ("Перекрытия монолитные", "monolithic")]
    # схема возведения — свойство всей фразы последовательности
    got = extract_schedule_rows(mk_doc(["Сначала каркас на всю высоту, затем стены."]), spec("M-087"))
    assert [e.meta["tech"] for e in got] == ["full_height", "full_height"]


@pytest.mark.l6_adversarial
def test_gantt_without_table_gives_no_rows():
    # Гант: полосы на шкале времени, в текстовом слое только подписи этапов и месяцев — длительностей нет
    assert (
        rows(["Календарный график", "Каркас", "Кровля", "янв фев мар апр май июн"])
        == []
    )


@pytest.mark.l8_regression
def test_extract_routes_schedule_param_and_bumps_revision():
    sp = spec()
    assert is_schedule_rows(sp) and EXTRACT_REV >= 13  # версию поднимает вливающий (правило интеграции W3)
    other = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    out = extract(
        mk_doc(["Календарный план", "Каркас 3 мес", "Этажность 5"]), [sp, other]
    )
    assert [
        (e.value_text, e.value_num, e.meta is not None)
        for e in out
        if e.code == "M-082"
    ] == [("Каркас", 90.0, True)]
    assert [e.value_num for e in out if e.code == "M-007"] == [5.0]


@pytest.mark.l4_fault
@pytest.mark.performance
def test_long_digit_series_and_huge_lines_parse_fast_and_stay_finite():
    # W3-02, W3-05: серия цифр и длинная строка — не O(n²) и не бесконечная длительность; вход обрезается
    import time

    t0 = time.perf_counter()
    got = rows(["Каркас — " + "9" * 50000 + " дн.", "Продолжительность " + "а " * 20000 + "мес", "Кровля " + "1" * 400 + " мес"])
    assert time.perf_counter() - t0 < 2.0
    assert all(d is None or d < 1e9 for _, d in got)
    assert to_days(1e308, "year") == 0.0
    (e,) = extract_schedule_rows(mk_doc(["Благоустройство — 20 дн. " + "примечание " * 400]), spec())
    assert len(e.meta["quote"]) <= 240 and len(e.value_text or "") <= 200


@pytest.mark.l4_fault
def test_row_count_limit_per_table():
    lines = ["Этап | Продолжительность, дн."] + [f"Этап номер {i} | {i % 90 + 1}" for i in range(700)]
    got = extract_schedule_rows(mk_doc(lines), spec())
    assert len(got) == 500
