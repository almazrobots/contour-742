"""OS-INSP-2.2.50–2.2.54 (T-173): расширения экстрактора количества W1 — таблица единиц, знак отметки, предел нормы,
варианты показателя, аспекты; паспорта М-006…М-132; ReDoS-страж оборотов паспортов.

Движок проверяется на конфигурации в тесте (общий механизм, не параметр), паспорта — на своих формах записи.
Только синтетические строки (ADR-0002).
"""

from __future__ import annotations

import json
import re
import signal
import time
from pathlib import Path

import pytest

from inspector_ml.extract import EXTRACT_REV
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.quantity_mentions import (
    extract_quantity_mentions,
    to_number,
    unit_factor,
)

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
PASSPORTS = ROOT / "data/seed/passports"
BASE = {
    "kind": "quantity_mentions",
    "window": 80,
    "superscripts": [],
    "fillers": ["—", "-", ":", "=", "|", ".", ","],
    "stop": ["по", "согласно", "не", "более", "менее", "до"],
    "exclude": [],
}


def mk_doc(lines: list[str]) -> ParsedDoc:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t,
                    bbox=(
                        round(x, 5),
                        0.05 + 0.03 * li,
                        round(min(x + w, 1.0), 5),
                        0.07 + 0.03 * li,
                    ),
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=1, width=595, height=842, source="text", lines=out)],
    )


def run(cfg: dict, *lines: str, code: str = "M-000") -> list:
    return extract_quantity_mentions(
        mk_doc(list(lines)),
        ParamSpec(
            code=code, anchors=["x"], data_type="number", extractor={**BASE, **cfg}
        ),
    )


def vals(ms: list, **flt) -> list:
    return [
        (e.value_num, e.meta["excluded"])
        for e in ms
        if all(e.meta.get(k) == v for k, v in flt.items())
    ]


# ------------------------------------------------------------------ движок


@pytest.mark.l1_functional
def test_units_table_converts_to_passport_unit_and_keeps_found_unit():
    cfg = {
        "anchor": "высота\\s+здания",
        "units": ["м"],
        "units_table": [{"text": "мм", "factor": 0.001}],
    }
    (a,) = run(cfg, "Высота здания 68410 мм")
    (b,) = run(cfg, "Высота здания, м 68,41")
    (c,) = run(cfg, "Высота здания 68,41")
    assert (a.value_num, a.meta["unit"]) == (68.41, "мм")
    assert (b.value_num, b.meta["unit"]) == (68.41, "м")
    assert (c.value_num, c.meta["unit"]) == (68.41, None)


@pytest.mark.l1_functional
def test_rub_to_thousands_and_millions():
    cfg = {
        "anchor": "итого\\s+по\\s+сводному\\s+сметному\\s+расч[её]ту",
        "units_table": [
            {"text": "тыс. руб.", "factor": 1},
            {"text": "руб.", "factor": 0.001},
            {"text": "млн руб.", "factor": 1000},
        ],
    }
    assert vals(
        run(cfg, "Итого по сводному сметному расчету 1 234 567 890,00 руб.")
    ) == [(1234567.89, None)]
    assert vals(run(cfg, "Итого по сводному сметному расчету 1 234,5 млн руб.")) == [
        (1234500.0, None)
    ]
    assert vals(
        run(cfg, "Итого по сводному сметному расчету тыс. руб. 987 654,32")
    ) == [(987654.32, None)]


@pytest.mark.l3_boundary
def test_unit_factor_case_and_spaces():
    cfg = {
        "units_table": [
            {"text": "тыс. руб.", "factor": 1},
            {"text": "руб.", "factor": 0.001},
        ]
    }
    assert (
        unit_factor(cfg, "ТЫС.  РУБ.") == 1
        and unit_factor(cfg, "руб.") == 0.001
        and unit_factor(cfg, None) == 1
        and unit_factor(cfg, "м") == 1
    )


@pytest.mark.l1_functional
def test_unitless_coefficient_becomes_percent_only_without_unit_and_below_max():
    cfg = {
        "anchor": "коэффициент\\s+застройки",
        "units": ["%"],
        "unitless": {"max": 1, "factor": 100},
    }
    assert vals(run(cfg, "Коэффициент застройки 0,42")) == [(42.0, None)]
    assert vals(run(cfg, "Коэффициент застройки 42 %")) == [(42.0, None)]
    assert vals(run(cfg, "Коэффициент застройки 42")) == [(42.0, None)]
    assert vals(run(cfg, "Коэффициент застройки 42%")) == [(42.0, None)]


@pytest.mark.l1_functional
def test_signed_elevations_and_zero_mark():
    cfg = {"anchor": "отметка\\s+низа\\s+плиты", "units": ["м"], "signed": True}
    assert vals(run(cfg, "Отметка низа плиты -4,200")) == [(-4.2, None)]
    assert vals(run(cfg, "Отметка низа плиты −4.200 м")) == [(-4.2, None)]
    assert vals(run(cfg, "Отметка низа плиты +3,300")) == [(3.3, None)]
    assert vals(run(cfg, "Отметка низа плиты ±0,000")) == [(0.0, None)]
    # тире с пробелом — связка, а не минус
    assert vals(run(cfg, "Отметка низа плиты – 4,200")) == [(4.2, None)]
    assert (
        to_number("−4,200") == -4.2
        and to_number("+68,410") == 68.41
        and to_number("±0.000") == 0
    )


@pytest.mark.l3_boundary
def test_without_signed_minus_is_not_read():
    cfg = {"anchor": "отметка\\s+низа\\s+плиты", "units": ["м"]}
    assert vals(run(cfg, "Отметка низа плиты -4,200")) == [(4.2, None)]


@pytest.mark.l1_functional
def test_limit_mentions_marked_and_not_values():
    cfg = {
        "anchor": "(?:процент|коэффициент)\\s+застройки",
        "limit_anchor": "(?:максимальн\\w*|предельн\\w*)\\s+процент\\w*\\s+застройки",
        "units": ["%"],
        "unitless": {"max": 1, "factor": 100},
    }
    ms = run(
        cfg,
        "Максимальный процент застройки — 60 %",
        "Процент застройки 42,5 %",
        "Коэффициент застройки не более 0,65",
    )
    assert [(e.value_num, e.meta["limit"]) for e in ms] == [
        (60.0, True),
        (42.5, False),
        (65.0, True),
    ]


@pytest.mark.l3_boundary
def test_limit_marker_ignored_without_limit_anchor_in_passport():
    cfg = {"anchor": "процент\\s+застройки", "units": ["%"]}
    assert run(cfg, "Процент застройки не более 60 %") == []


@pytest.mark.l1_functional
def test_variants_tagged_from_anchor_to_tail_not_next_row():
    cfg = {
        "anchor": "(?:итого|всего)\\s+по\\s+сводному\\s+сметному\\s+расч[её]ту",
        "units_table": [{"text": "тыс. руб.", "factor": 1}],
        "variants": [
            {"code": "vat_excl", "pattern": "без\\s+НДС"},
            {"code": "vat_incl", "pattern": "(?<![А-Яа-яЁё])с\\s+НДС|включая\\s+НДС"},
        ],
    }
    ms = run(
        cfg,
        "Итого по сводному сметному расчету без НДС 1 000,00 тыс. руб.",
        "НДС 20 % 200,00",
        "Всего по сводному сметному расчету 1 200,00 тыс. руб. с НДС",
    )
    assert [(e.value_num, e.meta["variant"]) for e in ms] == [
        (1000.0, "vat_excl"),
        (1200.0, "vat_incl"),
    ]
    (x,) = run(cfg, "Итого по сводному сметному расчету 1 000,00 в т.ч. НДС 166,67")
    assert x.meta["variant"] is None


@pytest.mark.l1_functional
def test_aspect_mentions_have_own_anchor_units_and_key():
    cfg = {
        "anchor": "объ[её]м\\w*\\s+подземной\\s+части",
        "units": ["м3"],
        "aspects": [
            {
                "key": "depth",
                "anchor": "отметка\\s+низа\\s+\\w+\\s+плиты",
                "units": ["м"],
                "signed": True,
            }
        ],
    }
    ms = run(
        cfg,
        "Объем подземной части 5 000,0 м3",
        "Отметка низа фундаментной плиты -4,200",
    )
    assert [(e.value_num, e.meta["aspect"]) for e in ms] == [
        (5000.0, None),
        (-4.2, "depth"),
    ]


@pytest.mark.l8_regression
def test_extract_revision_bumped_for_w1_meta():
    # EXTRACT_REV поднимает вливающий в main (правило интеграции); в ветке — значение main, не ниже 13
    assert EXTRACT_REV >= 13


# ------------------------------------------------------------------ ReDoS-страж паспортов (OS-INSP-2.2.54)


def _patterns(pp: dict) -> list[tuple[str, str]]:
    """Все строковые шаблоны паспорта (OWASP W3-12): рекурсивно по extractor и value — обороты, отсевы, варианты, аспекты,
    anchors[], negation, affirm, count, context, terms[].patterns, docs[].pattern, section_anchor и любые будущие поля.
    Строка, которая не компилируется как регулярное выражение, — не шаблон (подпись, единица)."""
    out: dict[str, str] = {}

    def walk(x, path: str) -> None:
        if isinstance(x, str):
            try:
                re.compile(x, flags=re.I)
            except re.error:
                return
            out.setdefault(x, path)
        elif isinstance(x, dict):
            for k, v in x.items():
                walk(v, f"{path}.{k}")
        elif isinstance(x, list):
            for n, v in enumerate(x):
                walk(v, f"{path}[{n}]")

    walk(pp.get("extractor") or {}, "extractor")
    walk(pp.get("value") or {}, "value")
    return [(k, v) for v, k in out.items()]


EVIL = [
    "а" * 10_000,
    " " * 10_000,
    "\t" * 10_000,
    "строительный " * 770,
    "строительный объем " * 520 + "!",
    "процент застройки " * 550,
    "0.000 " * 1600,
    "отметка " * 1200,
    "итого по сводному " * 550,
    "1 " * 5000,
    ("вместимость " + "а" * 40 + " ") * 190,
    "1" * 10_000,
    "1" + "о" * 10_000,
    "продолжительн " * 700,
]
STEM = re.compile(r"[А-Яа-яЁё]{3,}")
SHORT_CONTEXT = {"exclude", "variant", "aspect-exclude"}
CONTEXT_MAX = (
    60 + 300 + 80 + 25
)  # EXCLUDE_BEFORE + максимум window паспорта + оборот + хвост варианта


def _evil_for(pattern: str) -> list[str]:
    """Злые строки из самого паспорта (T173-M2): склейка «основа + следующая основа × N» (слово без пробелов в текстовом
    слое PDF) и основа + серия пробелов или табуляций (DOCX хранит их как есть)."""
    stems = list(dict.fromkeys(STEM.findall(pattern)))[:12]
    out = []
    for i, w in enumerate(stems):
        nxt = stems[i + 1] if i + 1 < len(stems) else "а"
        out += [
            w + nxt * (10_000 // len(nxt)) + "!",
            w + " " * 10_000 + "x",
            w + "\t" * 10_000 + "x",
            ("изм. " + w + " ") * 600,
        ]
    return out


def _slow(rx: re.Pattern[str], strings: list[str], *, watchdog_s: float = 2.0) -> list[tuple[str, int]]:
    out = []
    for st in strings:
        t0 = time.perf_counter()
        # A broken regex must fail the gate, not occupy a worker indefinitely.
        # SIGALRM interrupts CPython's regex engine as well as Python bytecode.
        if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
            raise RuntimeError("regex watchdog refuses to replace an active timer")

        def expired(_signum, _frame):
            pytest.fail(f"regex watchdog exceeded {watchdog_s}s: pattern={rx.pattern!r}, input={st[:80]!r}")

        previous = signal.signal(signal.SIGALRM, expired)
        try:
            signal.setitimer(signal.ITIMER_REAL, watchdog_s)
            for _ in rx.finditer(st):
                pass
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        ms = (time.perf_counter() - t0) * 1000
        # порог — замер на стене часов: 100 мс (было 50; решение владельца 29.09 — шум загрузки сервера давал 51–66 мс у
        # заведомо ограниченных шаблонов; катастрофический откат — секунды и минуты, порог его по-прежнему ловит)
        if ms > 100:
            out.append((st[:24], round(ms)))
    return out


def test_regex_watchdog_interrupts_backtracking_and_restores_signal():
    previous = signal.getsignal(signal.SIGALRM)
    with pytest.raises(pytest.fail.Exception, match="regex watchdog exceeded"):
        _slow(re.compile(r"(a+)+$"), ["a" * 100 + "!"], watchdog_s=0.05)
    assert signal.getsignal(signal.SIGALRM) == previous
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
    assert _slow(re.compile("a"), ["abc"]) == []


@pytest.mark.l4_fault
@pytest.mark.parametrize(
    "path", sorted(PASSPORTS.glob("M-*.json")), ids=lambda p: p.stem
)
@pytest.mark.performance
def test_passport_regexes_have_no_catastrophic_backtracking(path: Path):
    pp = json.loads(path.read_text("utf-8"))
    slow = []
    for name, pat in _patterns(pp):
        rx = re.compile(pat, flags=re.I)
        strings = EVIL + _evil_for(pat)
        if name.split(":")[0] in SHORT_CONTEXT:
            # правило отсева и вариант смотрят только короткий контекст упоминания (≤ 60 знаков до оборота + окно + хвост),
            # а не лист: злая строка — той же длины, что контекст (аудит T173, «контексты исключений короткие»)
            strings = [x[:CONTEXT_MAX] for x in strings]
        slow += [(name, *x) for x in _slow(rx, strings)]
    assert slow == []


@pytest.mark.l4_fault
@pytest.mark.performance
def test_module_regexes_have_no_catastrophic_backtracking():
    from inspector_ml import quantity_mentions as q

    rxs = {
        "TWO_COLUMNS": q.TWO_COLUMNS,
        "VALUE_IN_PAREN": q.VALUE_IN_PAREN,
        "LIMIT_MARK": re.compile(q.LIMIT_MARK, re.I),
        "ZERO_MARK": q.ZERO_MARK,
    }
    strings = EVIL + [
        "изм." + " " * 20_000,
        "изм." + "\t" * 20_000,
        "(" + "1 " * 5000,
        "0" * 10_000,
    ]
    assert {k: _slow(rx, strings) for k, rx in rxs.items()} == {k: [] for k in rxs}


@pytest.mark.l4_fault
@pytest.mark.parametrize(
    "path", sorted(PASSPORTS.glob("M-*.json")), ids=lambda p: p.stem
)
def test_extract_on_pathological_page_is_bounded(path: Path):
    """Весь экстрактор на листе в 20 000 знаков патологического текста — не дольше секунды (T173-H1, M1)."""
    pp = json.loads(path.read_text("utf-8"))
    if (pp.get("extractor") or {}).get("kind") != "quantity_mentions":
        pytest.skip("не количественный паспорт")
    sp = ParamSpec(
        code=pp["code"],
        anchors=[pp["title"]],
        data_type="number",
        extractor=pp["extractor"],
    )
    stems = STEM.findall(pp["extractor"]["anchor"])[:4] or ["а"]
    lines = [
        stems[0] + (stems[1] if len(stems) > 1 else "а") * 2000,
        stems[0] + " " * 5000 + "1",
        "Итого 1 " * 500,
    ]
    t0 = time.perf_counter()
    extract_quantity_mentions(mk_doc(lines), sp)
    assert time.perf_counter() - t0 < 1.0


@pytest.mark.l4_fault
def test_huge_numbers_do_not_crash_or_become_inf():
    cfg = {"anchor": "количество\\s+ступеней", "integer": True, "window": 300}
    ms = run(cfg, "количество ступеней " + "9" * 400)
    assert all(
        e.value_num is not None
        and e.value_num == e.value_num
        and abs(e.value_num) < float("inf")
        for e in ms
    )


@pytest.mark.l3_boundary
def test_change_marker_counts_only_near_the_row():
    cfg = {"anchor": "итого\\s+по\\s+ССР", "units": []}
    far = (
        "Реконструкция здания выполняется по проекту. "
        + "Прочий текст пояснительной записки. " * 12
    )
    assert vals(run(cfg, far, "Итого по ССР 100,5 200,5")) == [(100.5, "MULTI_VALUE")]
    assert vals(run(cfg, "Изм. 2", "Итого по ССР 100,5 200,5")) == [(200.5, None)]


@pytest.mark.l3_boundary
def test_page_unit_only_from_sheet_header_not_footnote():
    cfg = {
        "anchor": "итого\\s+по\\s+ССР",
        "page_unit": True,
        "units_table": [
            {"text": "тыс. руб.", "factor": 1},
            {"text": "руб.", "factor": 0.001},
        ],
    }
    lines = (
        ["Сводный сметный расчет"]
        + ["строка"] * 9
        + ["Итого по ССР 1 300 000", "Стоимость 1 м² — 95 000 руб."]
    )
    (e,) = run(cfg, *lines)
    assert (e.value_num, e.meta["unit"], e.meta["unit_from"]) == (1300000.0, None, None)


# ------------------------------------------------------------------ шум таблиц и текста (итерация 2, T-173)


@pytest.mark.l6_adversarial
def test_percent_ordinal_and_year_numbers_are_not_values():
    cfg = {
        "anchor": "сметн\\w*\\s*стоимост\\w*",
        "units_table": [{"text": "тыс. руб.", "factor": 1}],
        "fillers": [*BASE["fillers"], "с", "учетом", "ндс", "на", "квартал", "iv", "г"],
        "max_strangers": 4,
    }
    assert vals(
        run(cfg, "Сметная стоимость с учетом НДС 20 % тыс. руб. 6 573 092,54")
    ) == [(6573092.54, None)]
    assert vals(run(cfg, "Сметная стоимость на IV квартал 2024 г. 1 234,5")) == [
        (1234.5, None)
    ]
    h = {"anchor": "отметк\\w*\\s*пола", "units": ["м"], "max_strangers": 3}
    assert run(h, "отметка пола 1-го этажа") == []
    assert vals(run(h, "отметка пола 2-этажного блока 3,300")) == [(3.3, None)]


@pytest.mark.l6_adversarial
def test_value_inside_wrapped_parenthesis_and_zero_mark_paren_skipped():
    cfg = {
        "anchor": "объ[её]м\\w*\\s*надземной\\s*части",
        "units": ["куб.м", "м3"],
        "stop": ["от", "до"],
    }
    assert vals(
        run(
            cfg,
            "Объем надземной части (от куб.м 29977.1",
            "отм. 0,000 до верха покрытия) 4 Количество этажей",
        )
    ) == [(29977.1, None)]
    h = {"anchor": "высота\\s*здания", "units": ["м"]}
    assert vals(run(h, "Высота здания (от отм. 0,000 до верха парапета) 68,41 м")) == [
        (68.41, None)
    ]


@pytest.mark.l6_adversarial
def test_hyphenated_place_name_digit_is_not_value():
    cfg = {"anchor": "стоимост\\w*\\s*строительства", "max_strangers": 4}
    assert (
        run(
            cfg,
            "Сводный сметный расчет стоимости строительства Детский сад в г. Березняки-2 Составлен",
        )
        == []
    )


@pytest.mark.l3_boundary
def test_two_columns_take_project_column_only_on_change_or_reconstruction_page():
    cfg = {
        "anchor": "площад\\w*\\s*застройки",
        "units": ["м2"],
        "exclude": [
            {"code": "CHANGE_NOTE", "pattern": "(было|стало|изменен\\w*)", "why": "x"}
        ],
    }
    ms = run(
        cfg,
        "Изм. 3. Внесены изменения по замечаниям экспертизы",
        "Площадь застройки, м2 3 734,70 3 810,90",
    )
    assert [(e.value_num, e.meta["excluded"], e.meta["column"]) for e in ms] == [
        (3810.9, None, "last")
    ]
    # штамп «Изм. Кол.уч.» — не таблица изменений: два числа подряд остаются несколькими значениями
    assert vals(
        run(cfg, "Изм. Кол.уч. Лист №док.", "Площадь застройки, м2 3 734,70 3 810,90")
    ) == [(3734.7, "MULTI_VALUE")]
    # текстовая запись «было … стало» — одно число и отсев
    assert vals(run(cfg, "Площадь застройки: было 1770,20 м2, стало 1825,0 м2")) == [
        (1770.2, "CHANGE_NOTE")
    ]


@pytest.mark.l3_boundary
def test_row_numbers_only_last_before_next_row_label():
    cfg = {"anchor": "коэффициент\\s*использования\\s*территории", "units": ["%"]}
    assert vals(
        run(cfg, "Коэффициент использования территории % 180 52 4 Минимальные отступы")
    ) == [(180.0, "MULTI_VALUE")]
    v = {"anchor": "строительный\\s*объем,\\s*всего", "units": ["куб. м"]}
    assert vals(
        run(v, "Строительный объем, всего куб. м 71890,0 4.1 в т.ч. выше отм. 0,000")
    ) == [(71890.0, None)]


@pytest.mark.l3_boundary
def test_out_of_passport_range_is_excluded_not_guessed():
    cfg = {
        "anchor": "коэффициент\\s*использования\\s*территории",
        "units": ["%"],
        "plausible": [1, 5000],
    }
    assert vals(run(cfg, "Коэффициент использования территории % 350 154")) == [
        (350154.0, "IMPLAUSIBLE")
    ]
    assert vals(run(cfg, "Коэффициент использования территории % 350")) == [
        (350.0, None)
    ]


@pytest.mark.l1_functional
def test_page_unit_only_when_single_scale_on_page():
    cfg = {
        "anchor": "всего\\s+по\\s+ССР",
        "page_unit": True,
        "units_table": [
            {"text": "тыс. руб.", "factor": 1},
            {"text": "руб.", "factor": 0.001},
        ],
    }
    (a,) = run(cfg, "Сводный сметный расчет (руб.)", "ВСЕГО по ССР 5 831 359 650,00")
    assert (a.value_num, a.meta["unit"], a.meta["unit_from"]) == (
        5831359.65,
        "руб.",
        "page",
    )
    (b,) = run(cfg, "в тыс. руб. и руб.", "ВСЕГО по ССР 5 831 359,65")
    assert (b.value_num, b.meta["unit"], b.meta["unit_from"]) == (
        5831359.65,
        None,
        None,
    )


@pytest.mark.l1_functional
def test_variant_rules_by_anchor_and_page():
    cfg = {
        "anchor": "(?:итого|всего)\\s+по\\s+ССР",
        "variants": [
            {"code": "vat_excl", "pattern": "без\\s*НДС"},
            {"code": "vat_incl", "pattern": "^всего", "on": "anchor", "page": "НДС"},
            {"code": "vat_excl", "pattern": "^итого", "on": "anchor", "page": "НДС"},
        ],
    }
    ms = run(cfg, "Итого по ССР 1 000,00", "НДС 20% 200,00", "Всего по ССР 1 200,00")
    assert [(e.value_num, e.meta["variant"]) for e in ms] == [
        (1000.0, "vat_excl"),
        (1200.0, "vat_incl"),
    ]
    assert [
        e.meta["variant"]
        for e in run(cfg, "Итого по ССР 1 000,00", "Всего по ССР 1 000,00")
    ] == [None, None]


@pytest.mark.l6_adversarial
def test_anchor_in_parenthesis_right_after_anchor_is_same_mention():
    cfg = {"anchor": "проектн\\w*\\s*мощност\\w*|вместимост\\w*", "units": ["мест"]}
    assert vals(
        run(cfg, "Проектная мощность (вместимость) мест 200 3 Электрическая нагрузка")
    ) == [(200.0, None)]


@pytest.mark.l1_functional
def test_negate_if_and_mention_scope_exclusion():
    cfg = {
        "anchor": "глубин\\w*\\s*заложени\\w*|отметка\\s*низа",
        "units": ["м"],
        "signed": True,
        "negate_if": "глубин",
    }
    assert vals(run(cfg, "Глубина заложения 4,2 м")) == [(-4.2, None)]
    assert vals(run(cfg, "Отметка низа -4,200")) == [(-4.2, None)]
    m = {
        "anchor": "вместимост\\w*|расч[её]тн\\w*\\s*мощност\\w*",
        "units": ["мест", "кВт"],
        "exclude": [
            {"code": "ENERGY", "pattern": "кВт", "why": "x", "scope": "mention"}
        ],
    }
    assert vals(run(m, "Расчетная мощность 450 кВт", "Вместимость 300 мест")) == [
        (450.0, "ENERGY"),
        (300.0, None),
    ]


# ------------------------------------------------------------------ паспорта T-173 на своих формах записи


def pspec(code: str) -> ParamSpec:
    pp = json.loads((PASSPORTS / f"{code}.json").read_text("utf-8"))
    return ParamSpec(
        code=code,
        anchors=[pp["title"]],
        data_type="number",
        extractor={k: v for k, v in pp["extractor"].items() if k != "column"},
    )


def pvals(code: str, *lines: str, **flt) -> list:
    return vals(extract_quantity_mentions(mk_doc(list(lines)), pspec(code)), **flt)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "code,lines,want",
    [
        (
            "M-006",
            [
                "Строительный объем, м3 37 076,0",
                "в т.ч. надземной части 30 000,0",
                "подземной части 7 076,0",
            ],
            30000.0,
        ),
        ("M-006", ["Строительный объем выше отм. 0.000 30 239,0 куб.м"], 30239.0),
        (
            "M-005",
            [
                "Строительный объем, м3 37 076,0",
                "в т.ч. надземной части 30 000,0",
                "подземной части 7 076,0",
            ],
            7076.0,
        ),
        (
            "M-004",
            ["Строительный объем, м3 37 076,0", "в т.ч. надземной части 30 000,0"],
            37076.0,
        ),
        ("M-008", ["Высота здания, м 68,41"], 68.41),
        ("M-008", ["Высота здания 68410 мм"], 68.41),
        ("M-008", ["Отметка верха парапета +68,410"], 68.41),
        ("M-008", ["Высота (от 0,000 до верха парапета), м 25,27"], 25.27),
        (
            "M-009",
            ["За относительную отметку 0,000 принята абсолютная отметка 146,35 м."],
            146.35,
        ),
        ("M-009", ["отм. ±0.000 = абс. 146,350"], 146.35),
        ("M-009", ["Абсолютная отметка 0.000 — 146,35"], 146.35),
        ("M-013", ["Вместимость, мест 300"], 300.0),
        ("M-013", ["Проектом предусмотрен больничный корпус на 110 коек."], 110.0),
        ("M-019", ["Коэффициент застройки 0,42"], 42.0),
        ("M-019", ["Процент застройки 42,5 %"], 42.5),
        ("M-020", ["Коэффициент использования территории 2,4"], 240.0),
        ("M-020", ["КИТ 240 %"], 240.0),
        (
            "M-132",
            ["Итого по сводному сметному расчету 1 234 567 890,00 руб."],
            1234567.89,
        ),
        (
            "M-132",
            ["Сметная стоимость строительства составляет 1 234,5 млн руб."],
            1234500.0,
        ),
    ],
)
def test_passport_reads_its_forms(code, lines, want):
    got = [v for v, ex in pvals(code, *lines, aspect=None, limit=False) if ex is None]
    assert got[:1] == [want]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "code,lines",
    [
        ("M-008", ["Пожарно-техническая высота здания 65,2 м"]),
        ("M-008", ["Высота этажа 3,3 м"]),
        ("M-008", ["Максимальная высота зданий по ГПЗУ 75 м"]),
        ("M-009", ["Абсолютная отметка верха парапета 214,76"]),
        ("M-009", ["Относительная отметка чистого пола 1 этажа 0,000"]),
        ("M-013", ["Расчетная электрическая мощность 450 кВт"]),
        ("M-013", ["Вместимость автостоянки 120 машино-мест"]),
        ("M-132", ["НДС 20 % 200 000,00", "Итого по главе 2 1 000 000,00"]),
        (
            "M-132",
            ["Сметная стоимость в базисном уровне цен 2001 г. 366 636,83 тыс. руб."],
        ),
        ("M-019", ["Коэффициент использования территории 2,4"]),
        ("M-020", ["Коэффициент застройки 0,42"]),
    ],
)
def test_passport_distractors_are_not_values(code, lines):
    assert [
        v for v, ex in pvals(code, *lines, aspect=None, limit=False) if ex is None
    ] == []


@pytest.mark.l1_functional
def test_passport_limits_variants_and_depth_aspect():
    assert pvals(
        "M-019",
        "Максимальный процент застройки в границах земельного участка — 60 %",
        limit=True,
    ) == [(60.0, None)]
    ms = extract_quantity_mentions(
        mk_doc(
            [
                "Итого по сводному сметному расчету 1 000 000,00 тыс. руб.",
                "НДС 20 % 200 000,00",
                "Всего по сводному сметному расчету 1 200 000,00 тыс. руб.",
            ]
        ),
        pspec("M-132"),
    )
    assert [
        (e.value_num, e.meta["variant"]) for e in ms if e.meta["excluded"] is None
    ] == [(1000000.0, "vat_excl"), (1200000.0, "vat_incl")]
    assert pvals("M-005", "Отметка низа фундаментной плиты -4,200", aspect="depth") == [
        (-4.2, None)
    ]
    assert pvals("M-005", "Глубина заложения фундамента, м 4,2", aspect="depth") == [
        (-4.2, None)
    ]
