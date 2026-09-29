"""OS-INSP-2.2.40–2.2.44 (T-172): упоминания класса для 12 параметров-шкал W1 по паспортам и справочнику шкал.

Только синтетические строки. Конфигурация — как её передаёт API (passport.ts::extractorSpec): extractor паспорта,
шкала и написания из data/seed/scales.json (value.scale_ref), маркеры ограничения.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.class_mentions import canon_table, extract_class_mentions, fold_class
from inspector_ml.model import ParamSpec

from test_class_mentions import mk_doc

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
SCALES = json.loads((ROOT / "data/seed/scales.json").read_text("utf-8"))["scales"]
W1 = [
    "M-015",
    "M-021",
    "M-022",
    "M-050",
    "M-055",
    "M-056",
    "M-057",
    "M-069",
    "M-103",
    "M-107",
    "M-109",
    "M-124",
]


def passport(code: str) -> dict:
    return json.loads((ROOT / f"data/seed/passports/{code}.json").read_text("utf-8"))


def spec(code: str) -> ParamSpec:
    """Спецификация экстрактора, как её собирает API: шкала и написания — из справочника по scale_ref."""
    pp = passport(code)
    sc = SCALES[pp["value"]["scale_ref"]] if "scale_ref" in pp["value"] else {"values": pp["value"]["scale"]}
    aliases = {**sc.get("aliases", {}), **pp["value"].get("aliases", {})}
    ext = pp["extractor"] | {
        "scale": sc["values"],
        "constraint_markers": pp["value"]["constraint_markers"],
        "aliases": aliases,
        **(  # как API (passport.ts::extractorSpec): иные системы классификации
            {"alt_systems": pp["value"]["alt_systems"]}
            if pp["value"].get("alt_systems")
            else {}
        ),
    }
    return ParamSpec(
        code=code, anchors=[pp["title"]], data_type="string", extractor=ext
    )


def got(code: str, *lines: str) -> list[tuple]:
    return [
        (e.value_text, e.meta["qualifier"], e.meta["excluded"], e.meta.get("element"))
        for e in extract_class_mentions(mk_doc(list(lines)), spec(code))
    ]


def vals(code: str, *lines: str) -> list[str]:
    return [v for v, _, x, _ in got(code, *lines) if x is None]


# ─────────────────────────────── L1: свёртка и канон (2.2.40)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "a, b",
    [
        ("В 22,5", "B22.5"),
        ("А500С", "A500C"),
        ("ЕІ – 60", "EI 60"),
        ("КМО", "KM0"),
        ("нг(А)-FRLS", "НГ (A) — FRLS"),
        (" с0 ", "C0"),
    ],
)
def test_fold_class_same_key_as_api(a, b):
    """Те же пары, что в apps/api/tests/domain-class-scales.test.ts: свёртка ML и API совпадает."""
    assert fold_class(a) == fold_class(b)


@pytest.mark.l1_functional
def test_fold_class_vectors_match_api():
    assert fold_class("А500С") == "A500C"
    assert fold_class("ЕІ – 60") == "EI60"
    assert fold_class("С355-1") == "C355-1"
    assert fold_class("нг(А)-LS") == "HГ(A)-LS"
    assert fold_class(" с0 ") == "C0"


@pytest.mark.l1_functional
def test_fold_vectors_shared_with_api():
    """data/seed/class-fold-vectors.json — одни и те же пары проверяет apps/api/tests/domain-class-scales.test.ts."""
    vec = json.loads((ROOT / "data/seed/class-fold-vectors.json").read_text("utf-8"))["cases"]
    assert len(vec) >= 15
    for raw, want in vec:
        assert fold_class(raw) == want, raw


@pytest.mark.l1_functional
def test_fold_letter_o_stays_letter_outside_class_number():
    assert fold_class("ОСОБАЯ") == "OCOБAЯ"
    assert fold_class("FRLSO") == "FRLSO"
    assert fold_class("КМО") == "KM0"


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_passport_regexes_linear_on_pathological_text():
    """ReDoS: каждый шаблон паспортов W1 (оборот, значение, отсев, элементы) на патологической строке 10 000 знаков
    укладывается в 250 мс (лучшее из трёх) — текст PDF недоверенный (OWASP-аудит T-172)."""
    import re
    import time

    evil = ["а" * 10000, " " * 10000, "нг(" * 3334, "категории " * 1000, "особой группы " * 715, "EI" * 5000 + "!",
            "А-" * 5000, "КМ" * 5000, "В" * 10000 + "x", "бетон " * 1667, "СПЗ " * 2500, "не ниже " * 1250, "B25, " * 2000]
    for code in W1:
        e = passport(code)["extractor"]
        pats = [e["anchor"], e["value"]] + [x["pattern"] for x in e["exclude"]] + [x["pattern"] for x in e.get("elements", [])]
        for p in pats:
            rx = re.compile(p, re.I)
            for s in evil:
                # лучшее из трёх: на нагруженном раннере разовый замер шумит; катастрофический откат — секунды, не доли
                best = 1e9
                for _ in range(3):
                    t = time.perf_counter()
                    list(rx.finditer(s))
                    best = min(best, time.perf_counter() - t)
                assert best < 0.25, (code, p[:40], s[:10])


@pytest.mark.l1_functional
def test_canon_table_aliases_only_into_scale():
    t = canon_table(["А400", "А500С"], {"А-III": "А400", "junk": "А999"})
    assert t[fold_class("A-III")] == "А400"
    assert fold_class("junk") not in t
    # написание не перебивает значение шкалы с той же свёрткой
    assert canon_table(["C0"], {"С0": "C0"})[fold_class("С0")] == "C0"


# ─────────────────────────────── L1: основной путь по каждому параметру (2.2.40)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "code, line, want",
    [
        (
            "M-015",
            "Электроприемники здания относятся ко II категории надежности электроснабжения.",
            "II",
        ),
        ("M-015", "Категория надежности электроснабжения – I.", "I"),
        (
            "M-015",
            "Электроприемники СПЗ относятся к I категории особой группы надежности электроснабжения.",
            "I",
        ),
        (
            "M-015",
            "По надежности электроснабжения: 1-й категории надежности электроснабжения.",
            "I",
        ),
        ("M-021", "Класс энергетической эффективности здания – В (высокий).", "B"),
        ("M-021", "Класс энергоэффективности: А+", "A+"),
        ("M-021", "Класс энергетической эффективности – A++ (высочайший)", "A++"),
        ("M-022", "Степень огнестойкости здания – II.", "II"),
        (
            "M-022",
            "Здание II степени огнестойкости, класс конструктивной пожарной опасности С0.",
            "II",
        ),
        ("M-050", "Отделка стен лестничных клеток – КМ0.", "КМ0"),
        ("M-055", "Фундаментная плита – бетон класса В30 W8 F150.", "B30"),
        ("M-055", "Бетон класса B22,5 для подготовки.", "B22,5"),
        ("M-056", "Колонны из стали С345 по ГОСТ 27772-2015.", "С345"),
        ("M-056", "Балки – прокат из стали C 255.", "С255"),
        ("M-057", "Рабочая арматура класса А500С по ГОСТ 34028-2016.", "А500С"),
        ("M-057", "Арматура класса А-III.", "А400"),
        ("M-069", "Кабель ВВГнг(А)-LS 5х10 до ЩР-1.", "нг(А)-LS"),
        ("M-069", "Кабели марки ППГнг(А)-HF 3х2,5.", "нг(А)-HF"),
        ("M-103", "Дверь противопожарная ДПМ-01 EI 60.", "EI 60"),
        ("M-103", "Двери 1-го типа – EIS60.", "EIS 60"),
        (
            "M-107",
            "Класс пожарной опасности отделочных материалов стен коридоров – КМ2.",
            "КМ2",
        ),
        (
            "M-109",
            "Кабельные линии СОУЭ выполняются кабелем КПСнг(А)-FRLS 1х2х0,75.",
            "нг(А)-FRLS",
        ),
        ("M-124", "Класс энергетической эффективности здания – С (повышенный).", "C"),
    ],
)
def test_main_path_value_by_passport(code, line, want):
    assert want in vals(code, line)


@pytest.mark.l1_functional
def test_every_w1_passport_has_scale_ref_and_extractor():
    for code in W1:
        pp = passport(code)
        assert pp["value"]["scale_ref"] in SCALES
        assert pp["extractor"]["kind"] == "class_mentions"


# ─────────────────────────────── L1: значение перед оборотом (2.2.41)


@pytest.mark.l1_functional
def test_value_before_anchor_only_when_after_missing():
    assert vals("M-022", "Здание III степени огнестойкости.") == ["III"]
    # значение после оборота важнее значения перед ним
    assert vals("M-022", "I этап. Степень огнестойкости здания – II.") == ["II"]
    # значение перед оборотом — у всех паспортов W1 («B — класс энергетической эффективности»)
    assert vals("M-021", "B класс энергетической эффективности") == ["B"]
    # без «before» в спецификации значение перед оборотом не ищется
    sp = spec("M-021")
    sp.extractor = sp.extractor | {"before": 0}
    assert [e.value_text for e in extract_class_mentions(mk_doc(["B класс энергетической эффективности"]), sp)] == []


@pytest.mark.l1_functional
def test_value_before_does_not_cross_previous_mention():
    """Значение, уже отданное первому обороту, не становится значением второго."""
    got_ = vals(
        "M-015",
        "Категория надежности электроснабжения – II, насосные категории надежности электроснабжения",
    )
    assert got_ == ["II"]


# ─────────────────────────────── L1: ограничение (2.2.42)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "code, line",
    [
        ("M-055", "Бетон класса не ниже B25."),
        ("M-107", "Класс пожарной опасности отделочных материалов не более КМ1."),
        ("M-103", "Предел огнестойкости дверей не менее EI 30."),
        ("M-022", "Степень огнестойкости не ниже II."),
    ],
)
def test_constraint_marker_per_scale(code, line):
    ((v, q, x, _),) = got(code, line)
    assert q == "min" and x is None


# ─────────────────────────────── L1: класс конструкции (2.2.43)


@pytest.mark.l1_functional
def test_element_key_is_nearest_before_value():
    rows = got(
        "M-055",
        "Фундаментная плита – бетон класса В30; колонны – бетон класса В40; плиты перекрытия – бетон класса В25.",
    )
    assert [(v, el) for v, _, _, el in rows] == [
        ("B30", "фундаменты"),
        ("B40", "колонны"),
        ("B25", "перекрытия"),
    ]


@pytest.mark.l1_functional
def test_element_absent_is_none_and_non_element_param_has_no_key():
    assert got("M-055", "Бетон класса В30.")[0][3] is None
    assert (
        "element"
        not in extract_class_mentions(
            mk_doc(["Степень огнестойкости здания – II."]), spec("M-022")
        )[0].meta
    )


@pytest.mark.l1_functional
def test_element_rebar_and_doors_and_spz():
    assert got("M-057", "Колонны: рабочая арматура класса А500С.")[0][3] == "колонны"
    assert got("M-103", "Двери 2-го типа – EI 30.")[0][3] == "2-й тип"
    assert got("M-109", "Кабели АПС – КПСнг(А)-FRLS.")[0][3] == "АПС"


# ─────────────────────────────── L6: ловушки и отсев (2.2.44)


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "code, line",
    [
        (
            "M-022",
            "Соседнее здание, расположенное с северной стороны, II степени огнестойкости.",
        ),
        ("M-055", "Существующее здание: бетон класса В15."),
        ("M-055", "Классы бетона: B15, B20, B25, B30 допускаются."),
        ("M-021", "Класс энергетической эффективности светильников – A+."),
        ("M-107", "Класс пожарной опасности материалов отделки: КМ0, КМ1, КМ2, КМ3."),
    ],
)
def test_traps_are_excluded_with_reason(code, line):
    rows = got(code, line)
    assert rows and all(x is not None for _, _, x, _ in rows)


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "code, line",
    [
        (
            "M-021",
            "Класс энергетической эффективности С учетом требований СП 50.13330.",
        ),
        ("M-021", "Класс энергетической эффективности определяется по СП 50.13330."),
        ("M-055", "Бетон в 2023 году поставлялся."),
        ("M-057", "Арматура А 7 шт."),
        ("M-103", "Двери по ГОСТ 31173 E 1."),
        ("M-069", "Кабель ВВГ 3х2,5 (без индекса пожарной безопасности)."),
    ],
)
def test_not_a_class_gives_no_mention(code, line):
    assert vals(code, line) == []


@pytest.mark.l6_adversarial
def test_m023_passport_unchanged_path():
    """М-023 без aliases в паспорте идёт прежним путём normalize_class — регресс T-129 защищён test_class_mentions.py."""
    assert "aliases" not in passport("M-023")["value"]


# ─────────────────────────────── L6: предложение, перенос строки, OCR-цифры (2.2.45, 2.2.46)


@pytest.mark.l6_adversarial
def test_neighbor_sentence_does_not_exclude_own_class():
    """Фраза про существующее здание в соседнем предложении не гасит класс объекта (exclude_scope = sentence)."""
    rows = got("M-022", "Степень огнестойкости здания – II.", "Существующее здание IV степени огнестойкости.")
    assert [(v, x) for v, _, x, _ in rows] == [("II", None), ("IV", "NEIGHBOR")]


@pytest.mark.l6_adversarial
def test_constraint_marker_from_previous_sentence_is_not_ours():
    rows = got("M-055", "Колонны – бетон класса не ниже B45;", "Подготовка – бетон класса B7,5.")
    assert [(v, q) for v, q, _, _ in rows] == [("B45", "min"), ("B7,5", None)]


@pytest.mark.l6_adversarial
def test_value_is_taken_only_from_anchor_sentence():
    """Неразборчивое значение не подменяется классом соседней строки."""
    assert vals("M-057", "Балки: арматура класса А4Х0.", "Хомуты – арматура класса А240.") == ["А240"]
    assert [e for _, _, _, e in got("M-057", "Балки: арматура класса А4Х0.", "Хомуты – арматура класса А240.")] == ["хомуты"]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "code, lines, want",
    [
        ("M-055", ["Стены – бетон класса B5", "5 W8."], "B55"),
        ("M-069", ["Сети освещения: кабель ВВГнг(А)-LSL", "Tx 3х1,5."], "нг(А)-LSLTx"),
        ("M-057", ["Балки: арм. – А24", "0;"], "А240"),
        ("M-109", ["Кабельные линии АПС – КСРВн", "г(А)-FRLS."], "нг(А)-FRLS"),
        ("M-015", ["Категория надежности электроснабжения СПЗ – особой гр", "уппы I."], "I (особая группа)"),
    ],
)
def test_value_broken_by_line_wrap_is_glued(code, lines, want):
    assert vals(code, *lines) == [want]


@pytest.mark.l6_adversarial
def test_ocr_letters_between_digits_are_digits():
    from inspector_ml.class_mentions import ocr_digits

    assert ocr_digits("B3О А4O0 Аl000 С2З5 EI 60 I категории") == "B30 А400 А1000 С235 EI 60 I категории"
    assert vals("M-057", "Колонны: арматура класса Аl000.") == ["А1000"]


@pytest.mark.l6_adversarial
def test_range_and_preparation_are_not_structure_class():
    rows = got("M-055", "Допускается бетон классов B25–B30 по согласованию.", "Подготовка – бетон класса B7,5.")
    assert ("B25", "RANGE") in [(v, x) for v, _, x, _ in rows]
    assert ("B7,5", "подготовка") in [(v, e) for v, _, _, e in rows]


# ─────────────────────────────── L6: таблица, значение до оборота, чужой элемент, общее положение (2.2.44, 2.2.47)


@pytest.mark.l6_adversarial
def test_table_cell_value_on_next_line_only_when_line_starts_with_value():
    assert vals("M-055", "Колонны | класс бетона по прочности", "B30") == ["B30"]
    assert vals("M-109", "СОУЭ | кабельные линии", "КСРВнг(А)-FRLS") == ["нг(А)-FRLS"]
    # следующая строка — своя строка таблицы со своим наименованием: её значение не наше
    assert vals("M-109", "КПСнг(А)-HF — кабели систем противопожарной защиты подпора воздуха", "Для освещения — кабель ВВГнг(А)-LS 3х1,5.") == ["нг(А)-HF"]


@pytest.mark.l6_adversarial
def test_element_after_value_when_value_precedes_anchor():
    rows = got("M-015", "II — Категория надёжности электроснабжения противопожарных систем")
    assert [(v, e) for v, _, _, e in rows] == [("II", "СПЗ")]


@pytest.mark.l6_adversarial
def test_foreign_element_is_excluded_not_general():
    ((v, _, x, e),) = got("M-055", "Сборные железобетонные изделия – бетон класса B25.")
    assert (v, x, e) == ("B25", "FOREIGN_ELEMENT", None)


@pytest.mark.l6_adversarial
def test_norm_statement_is_not_object_value():
    rows = got("M-015", "Для электроприемников III категории перерыв электроснабжения допускается до 1 суток.")
    assert rows and all(x == "NORM_STATEMENT" for _, _, x, _ in rows)


@pytest.mark.l6_adversarial
def test_value_cut_mid_token_is_not_guessed():
    """«нг(В)-НF» с кириллической Н читается целиком; «нг(В)-QX» — разобран не целиком, упоминания нет."""
    assert vals("M-109", "Кабели АПС – КПСнг(В)-НF.") == ["нг(В)-HF"]
    assert vals("M-109", "Кабели АПС – КПСнг(В)-QX.") == []


@pytest.mark.l6_adversarial
def test_range_rule_looks_only_near_value():
    rows = got("M-055", "Допускается бетон классов B25–B30; колонны – бетон класса B40.")
    assert ("B40", None) in [(v, x) for v, _, x, _ in rows]


@pytest.mark.l6_adversarial
def test_line_ending_with_period_ends_sentence_even_before_lowercase():
    rows = got("M-107", "для полов: КМ5 – Класс пожарной опасности отделочных материалов.", "в вестибюлях: КМ4 – Пожарная опасность материалов отделки.")
    assert [(v, e) for v, _, _, e in rows] == [("КМ5", "полы"), ("КМ4", "вестибюли")]


@pytest.mark.l6_adversarial
def test_value_wrapped_before_capital_letter_is_glued():
    assert vals("M-107", "в лестничных клетках | Класс пожарной опасности отделочных материалов", "К", "М4") == ["КМ4"]


@pytest.mark.l6_adversarial
def test_ocr_ze_as_three_in_class():
    assert vals("M-107", "в залах: КМЗ – Класс пожарной опасности отделочных материалов.") == ["КМ3"]
    assert fold_class("КМЗ") == "KM3" and fold_class("ЗАЛ") == "ЗAЛ"


@pytest.mark.l1_functional
def test_alt_classification_system_instead_of_km():
    """КМ отменены с 14.07.2022: «Г1, В1, Д2, Т2» вместо КМ — упоминание отсеяно ALT_SYSTEM (OS-INSP-2.2.49)."""
    ((v, _, x, _),) = got("M-107", "Класс пожарной опасности отделочных материалов в коридорах – Г1, В1, Д2, Т2.")
    assert (v, x) == ("Г1, В1, Д2, Т2", "ALT_SYSTEM")
    assert vals("M-107", "Класс пожарной опасности отделочных материалов в коридорах – КМ1.") == ["КМ1"]
