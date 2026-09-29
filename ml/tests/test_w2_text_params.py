"""OS-INSP-2.2.100–2.2.103 (T-191, W2 текстовый путь): упоминания показателей по паспортам количества М-024, 045, 086,
088, 093, 094, 126, 127 — извлечение, обозначения перед значением, отсев с причиной, другая единица.

Только синтетические строки (ADR-0002): формы записей ПОС, ПОД, СПЗУ, АР и энергоэффективности — «Р = 385 кВт»,
«R0пр = 0,64 м²·°С/Вт», «λБ = 0,041», ведомости по типам и классам. Строки ТЭП синтетического объекта «132 параметра»
собираются генераторами фабрики (synth.factory, synth.factory_v3, synth.usability_132). Конфигурация — из паспортов.
"""

from __future__ import annotations

import json
import random
import re
import time
from pathlib import Path

import pytest

from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.quantity_mentions import (
    extract_quantity_mentions,
    is_quantity_mentions,
)

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
KINDS = json.loads((ROOT / "data/seed/w2-text-kinds.json").read_text("utf-8"))
CODES = [r["param"] for r in KINDS["params"] if r["passport"] == "draft"]


def passport(code: str) -> dict:
    # T-211 promoted these passports; preserve the same behavioral expectations.
    active = ROOT / f"data/seed/passports/{code}.json"
    path = active if active.exists() else ROOT / f"data/seed/passports/draft/{code}.json"
    return json.loads(path.read_text("utf-8"))


def spec(code: str) -> ParamSpec:
    pp = passport(code)
    return ParamSpec(
        code=code, anchors=[pp["title"]], data_type="number", extractor=pp["extractor"]
    )


def mk_page(lines: list[str], n: int = 1) -> Page:
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
        page=n, width=595, height=842, source="text", ocr_confidence=None, lines=out
    )


def mk_doc(*lines: str) -> ParsedDoc:
    return ParsedDoc(
        sha256="0" * 64, kind="pdf", engine="pdfium", pages=[mk_page(list(lines))]
    )


def found(code: str, *lines: str) -> list[tuple[float | None, str | None]]:
    return [
        (e.value_num, e.meta["excluded"])
        for e in extract_quantity_mentions(mk_doc(*lines), spec(code))
    ]


# (параметр, строка документа, значение) — записи, как их пишут ПОС, ПОД, СПЗУ, АР и раздел энергоэффективности
POSITIVE = [
    ("M-024", "Объём выемки грунта 12 450 м³", 12450.0),
    ("M-024", "Объем грунта в выемке — 8 300,5 куб. м", 8300.5),
    ("M-024", "Выемка грунта: 15 120 м3", 15120.0),
    ("M-045", "Уклон кровли — 2 %", 2.0),
    ("M-045", "Уклон плоской кровли к воронкам 1,5 %", 1.5),
    ("M-086", "Максимальная численность работающих 250 чел.", 250.0),
    ("M-086", "Потребность в кадрах (максимальная численность) — 184 человек", 184.0),
    ("M-088", "Мощность временного электроснабжения 412 кВт", 412.0),
    (
        "M-088",
        "Потребность в электроэнергии на период строительства: Р = 385,5 кВт",
        385.5,
    ),
    ("M-093", "Общий объём демонтируемых конструкций — 2 350 м³", 2350.0),
    ("M-093", "Объем демонтажа 1 870,5 м3", 1870.5),
    ("M-094", "Масса образующихся отходов 1 250,4 т", 1250.4),
    ("M-094", "Общая масса строительных отходов — 312 тонн", 312.0),
    ("M-126", "Коэффициент теплопроводности утеплителя λБ = 0,041 Вт/(м·°С)", 0.041),
    (
        "M-126",
        "Утеплитель — плиты из каменной ваты толщиной 150 мм, λ = 0,037 Вт/(м·°С)",
        0.037,
    ),
    (
        "M-127",
        "Приведённое сопротивление теплопередаче окон R0пр = 0,64 м²·°С/Вт",
        0.64,
    ),
    ("M-127", "Сопротивление теплопередаче оконных блоков Ro = 0,54 м2·°С/Вт", 0.54),
]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "code,line,value", POSITIVE, ids=[f"{c}:{v}" for c, _, v in POSITIVE]
)
def test_w2_mention_value_with_page_quote_and_bbox(code, line, value):
    # OS-INSP-2.2.100 и 2.2.101: оборот паспорта → число; обозначение (Р, λБ, R0пр) и единица значением не считаются
    got = extract_quantity_mentions(mk_doc("Прочий текст раздела.", line), spec(code))
    assert [(e.value_num, e.meta["excluded"]) for e in got] == [(value, None)]
    e = got[0]
    assert (
        e.page == 1
        and e.bbox is not None
        and e.anchor_bbox is not None
        and e.meta["quote"] in line
    )


# (параметр, строка, код отсева) — значение сохраняется, но отсеяно с причиной (OS-INSP-2.2.102, 2.2.103)
TRAPS = [
    ("M-024", "Объём выемки и насыпи грунта 12 450 м³", "FILL"),
    ("M-024", "Объём выемки грунта, в т.ч. растительного слоя 1 200 м³", "TOPSOIL"),
    ("M-045", "Минимальный уклон кровли 1,5 %", "NORM"),
    ("M-045", "Уклон кровли 25°", "OTHER_UNIT"),
    ("M-045", "Уклон кровли i = 0,015", "FRACTION"),
    (
        "M-086",
        "Максимальная численность работающих в наиболее многочисленную смену 180 чел.",
        "SHIFT",
    ),
    ("M-086", "Максимальная численность работающих, в т.ч. рабочих 212 чел.", "SUBSET"),
    ("M-088", "Мощность временного электроснабжения 450 кВА", "OTHER_UNIT"),
    (
        "M-088",
        "Мощность временного электроснабжения — разрешённая ТУ 500 кВт",
        "LIMIT",
    ),
    ("M-093", "Объём демонтируемых конструкций: железобетон 820 м³", "BY_TYPE"),
    ("M-094", "Масса отходов IV класса опасности 820 т", "BY_CLASS"),
    ("M-094", "Масса образующихся отходов 540 м³", "OTHER_UNIT"),
    (
        "M-126",
        "Теплопроводность утеплителя в сухом состоянии 0,034 Вт/(м·°С)",
        "DRY_STATE",
    ),
    (
        "M-126",
        "Коэффициент теплопроводности утеплителя не более 0,045 Вт/(м·°С)",
        "NORM",
    ),
    ("M-127", "Требуемое сопротивление теплопередаче окон Rтр = 0,49 м²·°С/Вт", "NORM"),
]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("code,line,why", TRAPS, ids=[f"{c}:{w}" for c, _, w in TRAPS])
def test_w2_trap_kept_excluded_with_reason(code, line, why):
    got = extract_quantity_mentions(mk_doc(line), spec(code))
    assert [e.meta["excluded"] for e in got] == [why]
    assert got[0].meta["excluded_why"]  # причина словами — для карточки инспектора


# однокоренные обороты другого смысла — не упоминание показателя (OS-INSP-2.2.100)
NOT_MENTIONS = [
    ("M-024", "Объём насыпи грунта 8 300 м³"),
    ("M-024", "Обратная засыпка пазух 5 000 м³"),
    ("M-045", "Уклон лотка 5 ‰"),
    ("M-086", "Численность рабочих 212 чел."),
    ("M-088", "Расчетная электрическая мощность 850 кВт"),
    ("M-093", "Объём строительного мусора 540 м³"),
    ("M-126", "Кирпичная кладка, коэффициент теплопроводности λ = 0,81 Вт/(м·°С)"),
    (
        "M-127",
        "Приведённое сопротивление теплопередаче наружных стен R0 = 3,15 м²·°С/Вт",
    ),
    ("M-127", "Сопротивление теплопередаче стен 3,15. Окна — ПВХ"),
]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "code,line", NOT_MENTIONS, ids=[f"{c}:{i}" for i, (c, _) in enumerate(NOT_MENTIONS)]
)
def test_w2_other_meaning_is_not_a_mention(code, line):
    assert found(code, line) == []


@pytest.mark.l3_boundary
def test_w2_norm_limit_before_value_is_not_a_value():
    # OS-INSP-2.2.26 на паспортах W2: «не менее» перед числом уклона — ограничение, значение не выдаётся
    assert found("M-045", "Уклон кровли не менее 1,5 %") == []
    # «не более» у численности — тоже
    assert found("M-086", "Максимальная численность работающих не более 250 чел.") == []


@pytest.mark.l6_adversarial
def test_w2_neighbour_row_is_not_our_value():
    # Ro стен в соседней строке таблицы не становится Ro окон: оборот «сопротивление теплопередаче» не тянется через число
    got = found("M-127", "Сопротивление теплопередаче наружных стен 3,15 окон 0,64")
    assert got == []
    # λ кладки после λ утеплителя — не второе упоминание утеплителя
    assert found("M-126", "Утеплитель λ = 0,037. Кладка λ = 0,81") == [(0.037, None)]


@pytest.mark.l1_functional
def test_w2_extract_routes_passports_as_quantity_mentions():
    specs = [spec(c) for c in CODES]
    assert all(is_quantity_mentions(s) for s in specs)
    out = extract(
        mk_doc("Максимальная численность работающих 250 чел.", "Уклон кровли — 2 %"),
        specs,
    )
    got = {
        (e.code, e.value_num) for e in out if e.meta and e.meta.get("excluded") is None
    }
    assert {("M-086", 250.0), ("M-045", 2.0)} <= got


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_w2_anchors_linear_on_pathological_text():
    # оборот паспорта на патологической строке в 10 000 знаков — не дольше 50 мс (как OS-INSP-2.2.54 у T-173)
    bad = [
        "а" * 10_000,
        "масса строительных " * 530,
        "теплоизоляции утеплителя " * 400,
        "сопротивление теплопередаче " * 360,
        "объём выемки грунта " * 500,
    ]
    for c in CODES:
        rx = re.compile(passport(c)["extractor"]["anchor"], re.I)
        for s in bad:
            t0 = time.perf_counter()
            list(rx.finditer(s))
            assert (time.perf_counter() - t0) * 1000 < 50, (c, s[:30])


@pytest.mark.l6_adversarial
def test_w2_anchor_does_not_claim_other_matrix_labels():
    # подпись любого другого параметра Матрицы в строке ТЭП не становится упоминанием паспорта W2
    matrix = json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
    for c in CODES:
        sp = spec(c)
        for p in matrix:
            if p["code"] == c:
                continue
            got = extract_quantity_mentions(
                mk_doc(f"{p['parameter_name']} {p['unit']} 123"), sp
            )
            assert got == [], (c, p["code"], p["parameter_name"])


@pytest.mark.l2_differential
def test_w2_usability_rows_read_by_passport():
    # строки ТЭП объекта «132 параметра» (генераторы фабрики): подпись из LABELS находится оборотом паспорта, а число
    # строки — тем же значением, что пишет генератор (истинное значение фабрики — независимый пересчёт)
    from synth import factory as F
    from synth import factory_v3 as V3
    from synth import usability_132 as U
    from synth import w2_text as W2

    V3.install()
    r = random.Random("t191")
    for c in CODES:
        assert re.search(passport(c)["extractor"]["anchor"], W2.LABELS[c], re.I), c
        e = W2.entry(c, W2.LABELS[c])
        v = e["base"](r)
        row = f"{e['label']} {e['unit']} {e['fmt'](v)}".replace("  ", " ")
        got = found(c, row)
        assert len(got) == 1 and got[0][1] is None, (c, row, got)
        num, _ = F.as_stage_value(c, v) if c not in W2.NUMERIC else (float(v), None)
        assert got[0][0] == pytest.approx(num), (c, row)
    # пул фабрики после W2.entry не меняется: объекты v2/v3 те же
    assert F.POOL["M-127"]["label"] != W2.LABELS["M-127"] and set(W2.LABELS) == set(CODES)
    # Promoted passports now deliberately use the accepted W2 labels.
    active = {c for c in CODES if (ROOT / f"data/seed/passports/{c}.json").exists()}
    assert set(W2.active()) & set(CODES) == active
    assert set(U.LABELS) & set(CODES) == active


@pytest.mark.l6_adversarial
def test_w2_between_rule_does_not_look_before_anchor():
    # правило со scope="between" смотрит только от оборота до значения: «насыпь» в предыдущей фразе не отсеивает выемку
    assert found("M-024", "Объём насыпи 8 000 м³. Объём выемки грунта 12 450 м³") == [(12450.0, None)]


@pytest.mark.l3_boundary
def test_w2_value_beyond_window_is_not_taken():
    # число дальше окна паспорта (80 знаков) — не значение оборота, даже если между ними только связки
    far = "Уклон кровли " + "— " * 45 + "2 %"
    assert found("M-045", far) == []
    assert found("M-045", "Уклон кровли " + "— " * 20 + "2 %") == [(2.0, None)]


@pytest.mark.l6_adversarial
def test_w2_value_kept_when_tail_is_unparsable_or_ends_phrase():
    # после значения — незакрытая скобка или «;»: разбор останавливается, значение остаётся
    assert found("M-045", "Уклон кровли 2 % (см. прим") == [(2.0, None)]
    assert found("M-045", "Уклон кровли — 2 %; водосток внутренний") == [(2.0, None)]


@pytest.mark.l6_adversarial
def test_w2_unit_case_insensitive_for_other_unit():
    # «КВА» заглавными — та же полная мощность: единица распознаётся без учёта регистра и отсеивается
    assert found("M-088", "Мощность временного электроснабжения 450 КВА") == [(450.0, "OTHER_UNIT")]
