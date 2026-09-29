"""HOLDOUT-2: независимый отложенный набор пар ПД/РД(/ИД) для 12 классовых параметров.

Набор написан без знания экстрактора: формулировки взяты из того, как пишут
проектировщики (ПЗ, «Общие данные», спецификации, ведомости, штампы, паспорта,
сертификаты), а не из того, что ищут регулярки. Метка задаётся построением:
мутация значения выбирается явно по собственной логике «хуже» (ниже) и никогда
не вычисляется функциями сравнения проекта.

Логика «хуже» (своя, не импортируется):
* порядковые шкалы (fire_degree, energy, power_category, finish_km, concrete_b) —
  индекс в ``values`` scales.json (от худшего к лучшему);
* rebar_a — меньше число или потеря индекса «С»;
* steel_c — меньше предел текучести (число), буквы К/П/-1 не влияют;
* fire_limit_door — меньше минут или потеря буквы (I покрывает W);
* cable_fire — ниже категория нг(D)<нг(С)<нг(В)<нг(А)<нг(А F/R) или потеря
  индекса FR/LS/HF/LTx.
Пары, где одно измерение лучше, а другое хуже, не генерируются.

Метка: 1 — хотя бы у одного элемента значение в РД хуже, чем в ПД (или ниже
ограничения ПД «не ниже/не менее/не более КМ…»); при наличии ИД метка —
сравнение ИД с РД (ПД и РД в таких парах совпадают).

Нормы-источники оборотов: СП 63.13330.2018, ГОСТ 26633-2015, ГОСТ 34028-2016,
ГОСТ 27772-2015, ГОСТ 31565-2012, 123-ФЗ ст. 87–88 (табл. 21, 22, 24),
ПУЭ 1.2.17–1.2.19, приказ Минстроя № 399/пр, ГОСТ Р 21.101-2020,
ГОСТ 21.501-2018 (ведомость отделки), СП 1.13130.2020 (табл. 28).

Запуск (из ``ml/``)::

    .venv/bin/python -m eval.class_scales_holdout2 --n 100 --seed 47 \
        --out ../var/class-scales/adv-holdout2.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

from .class_scales_bench import ROOT, SCHEMA, W1, doc, spec

VL, VR = "\x02", "\x03"  # маркеры значения внутри строки (снимаются перед doc())


def V(s: str) -> str:
    return f"{VL}{s}{VR}"


# ---------------------------------------------------------------------------
# Своя логика сравнения (только для построения меток)
# ---------------------------------------------------------------------------

ORD = {
    "fire_degree": ["V", "IV", "III", "II", "I"],
    "energy": ["G", "F", "E", "D", "C", "B", "A", "A+", "A++"],
    "power_category": ["III", "II", "I", "I (особая группа)"],
    "finish_km": ["КМ5", "КМ4", "КМ3", "КМ2", "КМ1", "КМ0"],
    "concrete_b": [
        "B3,5",
        "B5",
        "B7,5",
        "B10",
        "B12,5",
        "B15",
        "B20",
        "B22,5",
        "B25",
        "B27,5",
        "B30",
        "B35",
        "B40",
        "B45",
        "B50",
        "B55",
        "B60",
    ],
}

CABLE_LADDER = ["нг(D)", "нг(С)", "нг(В)", "нг(А)", "нг(А F/R)"]


def _num(s: str) -> int:
    return int(re.search(r"\d+", s).group())


def _dimcmp(a, b) -> int | None:
    """Сравнение по измерениям: a — список пар (kind, value) эталона, b — сравниваемого."""
    signs = set()
    for (kind, x), (_, y) in zip(a, b):
        if kind == "num":
            signs.add((y > x) - (y < x))
        else:  # set
            if x == y:
                signs.add(0)
            elif y > x:
                signs.add(1)
            elif y < x:
                signs.add(-1)
            else:
                return None
    signs.discard(0)
    if not signs:
        return 0
    if len(signs) > 1:
        return None
    return signs.pop()


def _dims(scale: str, v: str):
    if scale == "rebar_a":
        return [
            ("num", _num(v)),
            ("set", frozenset({"С"}) if v.endswith("С") else frozenset()),
        ]
    if scale == "steel_c":
        return [("num", _num(v))]
    if scale == "fire_limit_door":
        letters, minutes = v.split()
        fl = set(letters)
        if "I" in fl:
            fl.add("W")
        return [("num", int(minutes)), ("set", frozenset(fl))]
    if scale == "cable_fire":
        base, _, idx = v.partition("-")
        flags = set()
        for t in ("FR", "LS", "HF", "LTx"):
            if t in idx:
                flags.add(t)
        return [("num", CABLE_LADDER.index(base)), ("set", frozenset(flags))]
    raise KeyError(scale)


def cmp(scale: str, ref: str, other: str) -> int | None:
    """-1 — other хуже ref, 0 — равно, 1 — лучше, None — неоднозначно."""
    if scale in ORD:
        o = ORD[scale]
        i, j = o.index(ref), o.index(other)
        return (j > i) - (j < i)
    return _dimcmp(_dims(scale, ref), _dims(scale, other))


# ---------------------------------------------------------------------------
# Шум: OCR, гомоглифы, переносы строк
# ---------------------------------------------------------------------------

HOMO = {
    "а": "a",
    "е": "e",
    "о": "o",
    "р": "p",
    "с": "c",
    "х": "x",
    "у": "y",
    "А": "A",
    "В": "B",
    "Е": "E",
    "К": "K",
    "М": "M",
    "Н": "H",
    "О": "O",
    "Р": "P",
    "С": "C",
    "Т": "T",
    "Х": "X",
}
HOMO_BACK = {v: k for k, v in HOMO.items()}
OCR_SUB = {"О": "0", "З": "3", "l": "1", "б": "6", "I": "l"}


def _noise_text(s: str, rng: random.Random, p: float) -> str:
    out = []
    for ch in s:
        r = rng.random()
        if r < p and ch in HOMO:
            out.append(HOMO[ch])
        elif r < p * 0.25 and ch in OCR_SUB:
            out.append(OCR_SUB[ch])
        else:
            out.append(ch)
    return "".join(out)


def _noise_value(s: str, rng: random.Random, p: float) -> str:
    # в значении — только визуально тождественные замены кириллица/латиница
    out = []
    for ch in s:
        if rng.random() < p:
            if ch in HOMO:
                out.append(HOMO[ch])
                continue
            if ch in HOMO_BACK and ch not in "I":
                out.append(HOMO_BACK[ch])
                continue
        out.append(ch)
    return "".join(out)


def _segments(line: str):
    segs, i = [], 0
    for m in re.finditer(re.escape(VL) + "(.*?)" + re.escape(VR), line):
        if m.start() > i:
            segs.append((line[i : m.start()], False))
        segs.append((m.group(1), True))
        i = m.end()
    if i < len(line):
        segs.append((line[i:], False))
    return segs


def _alt_text(text: str, arng: random.Random, after_value: bool) -> str:
    """Шум второго распознавателя в тексте вне значений: слитные слова, тире/двоеточия без пробелов."""
    if arng.random() < 0.6:
        text = re.sub(r" ?— ?", "—", text) if arng.random() < 0.5 else text.replace(" — ", "— ")
    if arng.random() < 0.6:
        text = re.sub(r" ?: ?", ":", text)
    out = []
    for k, ch in enumerate(text):
        if ch == " ":
            nxt = text[k + 1] if k + 1 < len(text) else ""
            # пробел сразу после значения перед числом не трогаем («LS 3х2,5»): иначе значение сольётся с числом
            if after_value and k == 0 and nxt[:1].isdigit():
                out.append(ch)
                continue
            if arng.random() < 0.15:
                continue
        out.append(ch)
    return "".join(out)


def _alt_breaks(s: str, arng: random.Random) -> str:
    """Лишние переносы строки посреди фразы — в случайном месте между словами."""
    for _ in range(arng.choice([0, 1, 1, 2])):
        spaces = [m.start() for m in re.finditer(" ", s)]
        if not spaces:
            break
        c = arng.choice(spaces)
        s = s[:c] + "\n" + s[c + 1 :]
    return s


def finish(lines: list[str], rng: random.Random, noisy: bool, arng: random.Random | None = None) -> list[str]:
    """Шум + переносы (в т.ч. внутри значения) + снятие маркеров.

    ``arng`` — отдельный генератор шума второго распознавателя (слитные слова, пропавшие
    пробелы у тире/двоеточий, лишние разрывы строк); None — шум выключен.
    """
    p_txt = rng.choice([0.0, 0.0, 0.02, 0.05]) if noisy else 0.0
    p_val = rng.choice([0.0, 0.15, 0.4]) if noisy else 0.0
    width = rng.choice([58, 66, 74, 90, 200])
    out: list[str] = []
    for line in lines:
        segs = _segments(line)
        parts = []
        split_val = rng.random() < (0.25 if noisy else 0.08)
        for text, is_val in segs:
            if is_val:
                t = _noise_value(text, rng, p_val)
                if split_val and re.search(r"[ \-]", t) and len(t) > 4:
                    cut = [m.start() for m in re.finditer(r"[ \-]", t)]
                    c = rng.choice(cut)
                    keep = t[: c + 1] if t[c] == "-" else t[:c]
                    t = keep + "\n" + t[c + 1 :]
                    split_val = False
                parts.append(t)
            else:
                t = _noise_text(text, rng, p_txt)
                if arng is not None:
                    t = _alt_text(t, arng, after_value=bool(parts))
                parts.append(t)
        s = "".join(parts)
        if arng is not None:
            s = _alt_breaks(s, arng)
        for sub in s.split("\n"):
            while len(sub) > width:
                cut = sub.rfind(" ", 0, width)
                if cut <= 10:
                    break
                out.append(sub[:cut])
                sub = sub[cut + 1 :]
            out.append(sub)
    return [x for x in out if x.strip()] or [" "]


# ---------------------------------------------------------------------------
# Рендер значений (поверхностные формы одного канонического значения)
# ---------------------------------------------------------------------------


def r_concrete(v, rng):
    n = v[1:]
    f = rng.choice(["B{}", "В{}", "B{}", "В{}", "B {}"]).format(n)
    return f


def r_rebar(v, rng):
    old = {"А240": ["А-I", "АI"], "А300": ["А-II"], "А400": ["А-III", "АIII"]}
    if v in old and rng.random() < 0.3:
        o = rng.choice(old[v])
        return rng.choice([o, f"{o} ({v})", f"{v} ({o})"])
    return v


def r_steel(v, rng):
    return v


def r_degree(v, rng, word=False):
    words = {
        "I": "первой",
        "II": "второй",
        "III": "третьей",
        "IV": "четвёртой",
        "V": "пятой",
    }
    if word and rng.random() < 0.25:
        return words[v]
    return v


def r_energy(v, rng):
    names = {
        "A++": "очень высокий",
        "A+": "очень высокий",
        "A": "очень высокий",
        "B": "высокий",
        "C": "нормальный",
        "D": "пониженный",
        "E": "низкий",
        "F": "низкий",
        "G": "очень низкий",
    }
    base = v
    if rng.random() < 0.3:
        base = (
            base.replace("A", "А").replace("B", "В").replace("C", "С").replace("E", "Е")
        )
    style = rng.randrange(4)
    if style == 0:
        return base
    if style == 1:
        return f"«{base}»"
    if style == 2:
        return f"{base} ({names[v]})"
    return f"«{base}» – {names[v].capitalize()}"


def r_power(v, rng, ctx="gen"):
    if v == "I (особая группа)":
        return rng.choice(["I (особая группа)", "особой группы I", "I особой группы"])
    if ctx == "gen":
        m = {
            "I": ["I", "первой", "1"],
            "II": ["II", "второй", "2"],
            "III": ["III", "третьей", "3"],
        }
    else:
        m = {"I": ["I", "1", "I"], "II": ["II", "2", "II"], "III": ["III", "3", "III"]}
    return rng.choice(m[v])


KM_GROUPS = {
    "КМ0": "НГ",
    "КМ1": "Г1, В1, Д1, Т1",
    "КМ2": "Г1, В1, Д2, Т2",
    "КМ3": "Г2, В2, Д2, Т2",
    "КМ4": "Г3, В2, Д2, Т2",
    "КМ5": "Г4, В3, Д3, Т3",
}


def r_km(v, rng):
    s = rng.choice([v, v, v.replace("КМ", "КМ "), v.replace("КМ", "KM")])
    return s


def r_door(v, rng):
    letters, mins = v.split()
    return rng.choice(
        [
            f"{letters} {mins}",
            f"{letters}{mins}",
            f"{letters} {mins}",
            f"{letters.replace('E', 'Е')} {mins}",
        ]
    )


def r_cable(v, rng):
    base, _, idx = v.partition("-")
    b = base
    if rng.random() < 0.3:
        b = b.replace("А", "A")
    if rng.random() < 0.15:
        b = b.replace("нг(", "нг (")
    return b + ("-" + idx if idx else "")


# ---------------------------------------------------------------------------
# Реквизиты документов
# ---------------------------------------------------------------------------

OBJECTS = [
    "Многоквартирный жилой дом со встроенными помещениями и подземной автостоянкой",
    "Общеобразовательная школа на 825 мест",
    "Административно-бытовой корпус",
    "Поликлиника на 300 посещений в смену",
    "Жилой комплекс, корпус 2, секции 2.1–2.3",
    "Детский сад на 220 мест",
    "Складской комплекс с административными помещениями",
]


def shifr(rng, disc):
    return f"{rng.randint(10, 99)}{rng.choice(['-', '/'])}{rng.randint(20, 25)}-{disc}"


def stamp(rng, stage, disc, title):
    s = "П" if stage == "PD" else "Р"
    return [
        f"Изм. Кол.уч. Лист №док. Подп. Дата {shifr(rng, disc)}",
        f"{title}",
        f"ГИП {rng.choice(['Иванов', 'Сафин', 'Кузнецова', 'Гарипов'])} Стадия {s} "
        f"Лист {rng.randint(1, 9)} Листов {rng.randint(10, 40)}",
    ]


def ph(rng, *alts):
    return rng.choice(alts)


# ---------------------------------------------------------------------------
# Словари элементов
# ---------------------------------------------------------------------------

CONCRETE_EL = {
    "found": (
        ["фундаментная плита", "фундаменты", "плитный фундамент"],
        [
            "Фундаментная плита Фп-1",
            "Плита фундаментная ФПм1",
            "Монолитная фундаментная плита",
        ],
        ["B25", "B30"],
    ),
    "col": (
        ["колонны", "пилоны", "колонны и пилоны"],
        ["Колонны Км-1…Км-12", "Пилоны П-1, П-2", "Колонны монолитные К-1"],
        ["B30", "B35", "B40"],
    ),
    "wall": (
        ["стены", "монолитные стены", "стены подвала"],
        [
            "Стены См-1 (ниже отм. 0.000)",
            "Стены монолитные Ст-1",
            "Стены лестнично-лифтового узла",
        ],
        ["B25", "B30"],
    ),
    "slab": (
        ["плиты перекрытий", "перекрытия", "плиты перекрытия и покрытия"],
        [
            "Плита перекрытия Пм-2 на отм. +3.300",
            "Перекрытие типового этажа",
            "Плита покрытия Пп-1",
        ],
        ["B25", "B30"],
    ),
    "stair": (
        ["лестничные марши и площадки", "лестницы", "монолитные лестницы"],
        ["Лестничный марш ЛМ-1", "Площадки лестничные ЛП-1", "Лестница Л-1"],
        ["B20", "B25"],
    ),
    "beam": (
        ["балки", "ригели", "балки и ригели"],
        ["Балки Бм-1…Бм-4", "Ригели Рм-1", "Балка обвязочная Бо-1"],
        ["B25", "B30"],
    ),
}

REBAR_EL = {
    "found": (CONCRETE_EL["found"][0], CONCRETE_EL["found"][1], ["А500С", "А400"]),
    "col": (CONCRETE_EL["col"][0], CONCRETE_EL["col"][1], ["А500С", "А500"]),
    "wall": (CONCRETE_EL["wall"][0], CONCRETE_EL["wall"][1], ["А500С", "А400"]),
    "slab": (CONCRETE_EL["slab"][0], CONCRETE_EL["slab"][1], ["А500С", "А500"]),
    "stair": (
        CONCRETE_EL["stair"][0],
        CONCRETE_EL["stair"][1],
        ["А500С", "А400", "А240"],
    ),
    "beam": (CONCRETE_EL["beam"][0], CONCRETE_EL["beam"][1], ["А500С", "А400"]),
}
REBAR_POOL = ["А240", "А300", "А400", "А400С", "А500", "А500С", "А600С"]

STEEL_EL = {
    "col": (
        ["колонны", "стойки каркаса"],
        ["Колонна К-1 (20К1)", "Колонны К1…К6, сечение 25К2"],
        ["С345", "С255"],
    ),
    "beam": (
        ["балки", "балки перекрытия"],
        ["Балка Б-1 (30Б1)", "Балки Б1–Б3, двутавр 35Б2"],
        ["С255", "С345"],
    ),
    "brace": (
        ["связи", "вертикальные связи"],
        ["Связь ВС-1 (гн.□100х4)", "Связи ВС1, ВС2 из уголка 75х6"],
        ["С245", "С255"],
    ),
    "truss": (
        ["фермы", "стропильные фермы"],
        ["Ферма Ф-1, пояса гн.□160х6", "Фермы Ф1, Ф2"],
        ["С345", "С255"],
    ),
    "purlin": (
        ["прогоны", "прогоны покрытия"],
        ["Прогон Пр-1 ([16П)", "Прогоны Пр1–Пр3"],
        ["С245", "С255"],
    ),
    "embed": (
        ["закладные детали", "закладные изделия"],
        ["Закладная деталь МН-1 (-10х200)", "Закладные изделия МН1–МН5"],
        ["С255", "С245"],
    ),
}
STEEL_POOL = ["С235", "С245", "С255", "С345", "С345К", "С355", "С355-1", "С390"]

POWER_EL = {
    "spz": (
        [
            "электроприёмники систем противопожарной защиты (СПЗ)",
            "системы противопожарной защиты",
        ],
        ["ППУ — щит систем противопожарной защиты", "ЩС ППУ (СПЗ)"],
        ["I", "I (особая группа)"],
    ),
    "lift": (
        ["лифты", "лифтовое оборудование"],
        ["Лифты, щит ЩЛ-1", "Щит лифтов ЩЛ"],
        ["I", "II"],
    ),
    "itp": (
        ["ИТП", "индивидуальный тепловой пункт"],
        ["ИТП (щит ЩИТП)", "Щит ИТП"],
        ["II", "I"],
    ),
    "pump": (
        [
            "повысительные насосные установки ХВС",
            "насосная хоз.-питьевого водоснабжения",
        ],
        ["Насосная ХВС, щит ЩН-1", "ПНС хоз.-пит."],
        ["II", "I"],
    ),
    "emlight": (
        ["аварийное (эвакуационное) освещение", "аварийное освещение"],
        ["ЩАО — аварийное освещение", "Щит аварийного освещения ЩАО-1"],
        ["I", "I (особая группа)"],
    ),
    "flats": (
        ["квартиры", "прочие электроприёмники", "общедомовые нагрузки"],
        ["Квартиры (этажные щиты ЩЭ)", "Общедомовые нагрузки ЩР-1"],
        ["II", "III"],
    ),
}
POWER_POOL = ORD["power_category"]

FINISH_EL = {
    "stair": (
        ["лестничные клетки", "стены и потолки лестничных клеток"],
        ["ЛК-1 Лестничная клетка", "Лестничная клетка Л1"],
        ["КМ0", "КМ1"],
    ),
    "lobby": (
        ["вестибюли", "вестибюли и лифтовые холлы"],
        ["101 Вестибюль", "Холл лифтовой 102"],
        ["КМ1", "КМ2"],
    ),
    "corr": (
        ["общие коридоры", "коридоры"],
        ["103 Коридор", "Общий коридор 2-го этажа"],
        ["КМ2", "КМ1"],
    ),
    "hall": (
        ["залы", "зрительный и актовый залы"],
        ["Актовый зал 115", "Спортивный зал 120"],
        ["КМ2", "КМ3"],
    ),
    "floor": (
        ["покрытия полов на путях эвакуации", "полы в коридорах и холлах"],
        ["Покрытие пола в коридорах", "Пол ПЛ-2 (коридоры, холлы)"],
        ["КМ2", "КМ3"],
    ),
}
FINISH_POOL = ORD["finish_km"]

CABLE_DIST_EL = {
    "group": (
        ["групповые сети", "групповые линии освещения"],
        ["Гр.1 освещение, ЩО-1", "Группа 2 розеточная ЩР-2"],
        ["нг(А)-LS", "нг(А)-LSLTx"],
    ),
    "feed": (
        ["питающие сети", "питающие линии от ВРУ до этажных щитов"],
        ["ВРУ-1 — ЩЭ-1…ЩЭ-9, стояк", "Питающая линия ВРУ – ЩР-1"],
        ["нг(А)-LS", "нг(А)-HF"],
    ),
    "vent": (
        ["сети электроснабжения вентиляции", "силовые сети ОВ"],
        ["Щит ЩВ-1, П1, В1", "Вентустановки П1–П3"],
        ["нг(А)-LS", "нг(А)-HF"],
    ),
}
CABLE_SPZ_EL = {
    "aps": (
        ["АПС", "автоматическая пожарная сигнализация", "шлейфы АПС"],
        ["Шлейф АПС ШС1–ШС8", "АПС, линии связи с ППКП"],
        ["нг(А)-FRLS", "нг(А)-FRHF"],
    ),
    "soue": (
        ["СОУЭ", "система оповещения и управления эвакуацией"],
        ["СОУЭ, линии оповещения Л1–Л4", "Линии СОУЭ к речевым оповещателям"],
        ["нг(А)-FRLS", "нг(А)-FRLSLTx"],
    ),
    "pdz": (
        ["ПДЗ", "противодымная вентиляция"],
        ["Вентилятор ДУ-1 (ПДЗ)", "Клапаны КДУ, питание ПДЗ"],
        ["нг(А)-FRLS", "нг(А)-FRHF"],
    ),
    "ppa": (
        ["ППА", "противопожарная автоматика"],
        ["Цепи управления ППА", "ППА — шкафы управления ШУ"],
        ["нг(А)-FRLS", "нг(А)-FRHF"],
    ),
    "vpv": (
        ["ВПВ", "насосы внутреннего противопожарного водопровода"],
        ["Насосная ВПВ, ЩПН", "Задвижки с электроприводом ВПВ"],
        ["нг(А)-FRLS", "нг(А)-FRHF"],
    ),
}
CABLE_POOL = [
    "нг(D)",
    "нг(С)",
    "нг(С)-LS",
    "нг(В)",
    "нг(В)-LS",
    "нг(А)",
    "нг(А)-LS",
    "нг(А)-HF",
    "нг(А)-FRLS",
    "нг(А)-FRHF",
    "нг(А)-LSLTx",
    "нг(А)-FRLSLTx",
    "нг(А)-FRHFLTx",
]
CABLE_BRANDS = {
    "dist": ["ВВГ{}", "ВВГ{}", "ВВГЭ{}", "ППГ{}", "АВВГ{}", "ПвВГ{}"],
    "spz": ["КПС{}", "КПСЭ{}", "ВВГ{}", "КСРВ{}", "ППГ{}"],
}

DOOR_EL = {
    "d1": (
        ["противопожарные двери 1-го типа", "двери в противопожарных стенах 1-го типа"],
        [
            "Д1 Дверь противопожарная ДПМ-01/60",
            "ДП-1 дверь металлическая противопожарная",
        ],
        ["EI 60"],
    ),
    "d2": (
        ["двери 2-го типа", "противопожарные двери в перегородках 1-го типа"],
        ["Д3 Дверь противопожарная ДПМ-01/30", "ДП-2 дверь противопожарная"],
        ["EI 30"],
    ),
    "stair": (
        ["двери лестничных клеток", "двери выходов в лестничные клетки"],
        ["Д5 Дверь в ЛК, с доводчиком", "ДЛ-1 дверь лестничной клетки"],
        ["EI 30", "EIS 30"],
    ),
    "lift": (
        [
            "двери лифтовых холлов (тамбур-шлюзов)",
            "дымогазонепроницаемые двери лифтовых холлов",
        ],
        ["Д7 Дверь лифтового холла", "ДТШ-1 дверь тамбур-шлюза"],
        ["EIS 30", "EIS 60"],
    ),
    "gate": (
        ["противопожарные ворота 1-го типа", "ворота автостоянки"],
        [
            "В1 Ворота подъёмно-секционные противопожарные",
            "ВП-1 ворота противопожарные",
        ],
        ["EI 60"],
    ),
    "hatch": (
        ["люки 2-го типа", "люки выхода на кровлю"],
        ["Л1 Люк противопожарный 600х800", "ЛП-1 люк выхода на кровлю"],
        ["EI 30"],
    ),
    "glazed": (
        ["двери с остеклением более 25 %", "остеклённые противопожарные двери"],
        ["Д9 Дверь остеклённая противопожарная", "ДО-1 дверь с остеклением"],
        ["EIW 30", "EIW 60"],
    ),
}
DOOR_POOL = [
    "E 15",
    "E 30",
    "E 60",
    "EI 15",
    "EI 30",
    "EI 45",
    "EI 60",
    "EI 90",
    "EIW 30",
    "EIW 60",
    "EIS 15",
    "EIS 30",
    "EIS 60",
    "EIWS 30",
]


# ---------------------------------------------------------------------------
# Параметры: шкала, элементы, пул, ИД
# ---------------------------------------------------------------------------

PARAMS = {
    "M-015": dict(scale="power_category", el=POWER_EL, pool=POWER_POOL, id=False),
    "M-021": dict(
        scale="energy", el=None, pool=["D", "C", "B", "A", "A+", "A++"], id=False
    ),
    "M-124": dict(
        scale="energy", el=None, pool=["D", "C", "B", "A", "A+", "A++"], id=True
    ),
    "M-022": dict(
        scale="fire_degree", el=None, pool=["IV", "III", "II", "I"], id=False
    ),
    "M-050": dict(scale="finish_km", el=FINISH_EL, pool=FINISH_POOL, id=True),
    "M-107": dict(scale="finish_km", el=FINISH_EL, pool=FINISH_POOL, id=True),
    "M-055": dict(
        scale="concrete_b",
        el=CONCRETE_EL,
        pool=["B15", "B20", "B22,5", "B25", "B27,5", "B30", "B35", "B40", "B45"],
        id=True,
    ),
    "M-056": dict(scale="steel_c", el=STEEL_EL, pool=STEEL_POOL, id=True),
    "M-057": dict(scale="rebar_a", el=REBAR_EL, pool=REBAR_POOL, id=True),
    "M-069": dict(scale="cable_fire", el=CABLE_DIST_EL, pool=CABLE_POOL, id=True),
    "M-109": dict(scale="cable_fire", el=CABLE_SPZ_EL, pool=CABLE_POOL, id=True),
    "M-103": dict(scale="fire_limit_door", el=DOOR_EL, pool=DOOR_POOL, id=True),
}


# ---------------------------------------------------------------------------
# Рамки документов. items: list[dict(el, name, val, limit)]
# ---------------------------------------------------------------------------


def _limit_word(rng, scale):
    if scale == "finish_km":
        return ph(rng, "не более", "не выше", "не более", "класса не выше")
    return ph(rng, "не ниже", "не менее", "не ниже", "≥")


def _grouped(items):
    """Группирует элементы с одинаковым значением и признаком ограничения."""
    g: dict = {}
    for it in items:
        g.setdefault((it["val"], it["limit"]), []).append(it)
    return list(g.items())


# --- бетон -----------------------------------------------------------------


def concrete_pd(items, rng, stage):
    lines = [
        ph(
            rng,
            "4.2 Конструктивные решения",
            "Раздел 4. Конструктивные и объёмно-планировочные решения",
            "Текстовая часть",
        )
    ]
    f = rng.randrange(3)
    if f == 0:
        lines.append(
            ph(
                rng,
                "Несущие монолитные конструкции запроектированы из тяжёлого бетона по ГОСТ 26633-2015:",
                "Материалы конструкций. Бетон тяжёлый по ГОСТ 26633-2015 следующих классов по прочности на сжатие:",
            )
        )
        for (val, lim), grp in _grouped(items):
            names = ", ".join(it["name"] for it in grp)
            lw = f"{_limit_word(rng, 'concrete_b')} " if lim else ""
            lines.append(
                f"- {names} — {lw}{V(r_concrete(val, rng))} {ph(rng, 'W6 F150', 'W8 F200', 'F150 W6', '')};".rstrip()
            )
    elif f == 1:
        for it in items:
            lw = f"{_limit_word(rng, 'concrete_b')} " if it["limit"] else ""
            lines.append(
                ph(
                    rng,
                    f"{it['name'].capitalize()} выполняются из бетона класса {lw}{V(r_concrete(it['val'], rng))} "
                    f"по прочности на сжатие, марки по морозостойкости F150, по водонепроницаемости W6.",
                    f"Для {it['name']} принят бетон {lw}{V(r_concrete(it['val'], rng))}, армирование — "
                    f"отдельными стержнями.",
                )
            )
    else:
        lines.append("Таблица 4.1 — Характеристики материалов")
        lines.append("Конструкция | Класс бетона | Марка F | Марка W")
        for it in items:
            lw = f"{_limit_word(rng, 'concrete_b')} " if it["limit"] else ""
            lines.append(
                f"{it['name'].capitalize()} | {lw}{V(r_concrete(it['val'], rng))} | F{rng.choice([100, 150, 200])} | W{rng.choice([4, 6, 8])}"
            )
    lines += _concrete_distractors(rng)
    return lines + stamp(rng, stage, "КР", "Пояснительная записка")


def _concrete_distractors(rng):
    d = [
        "Бетонная подготовка толщиной 100 мм — из бетона B7,5.",
        "По данным обследования фундаменты существующего здания выполнены из бетона B15.",
        "Смесь бетонная БСТ B25 П4 F150 W6 — для справки, подбор состава по ГОСТ 27006.",
        "Расчётное сопротивление Rb по табл. 6.8 СП 63.13330.2018: B20 — 11,5 МПа; B25 — 14,5 МПа; B30 — 17,0 МПа.",
        "Защитный слой бетона для рабочей арматуры — 30 мм.",
        "Для замоноличивания стыков допускается применение бетона классов B15–B20.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def concrete_rd(items, rng, stage):
    f = rng.randrange(3)
    lines = [
        ph(
            rng,
            "Общие данные",
            "Ведомость рабочих чертежей основного комплекта",
            "Указания по производству работ",
        )
    ]
    if f == 0:
        lines.append("Спецификация материалов")
        lines.append("Поз. Наименование Ед. изм. Кол. Примечание")
        for k, it in enumerate(items, 1):
            lines.append(f"{k} {it['name']}")
            lines.append(
                f"Бетон {V(r_concrete(it['val'], rng))} {ph(rng, 'W6 F150', 'W8 F150', 'F200 W6')} м3 {rng.randint(8, 900)},{rng.randint(0, 9)}"
            )
    elif f == 1:
        for k, it in enumerate(items, 1):
            lines.append(
                ph(
                    rng,
                    f"{k}. {it['name']} выполнить из бетона класса {V(r_concrete(it['val'], rng))} по ГОСТ 26633-2015.",
                    f"{k}. Бетон {it['name'].lower()} — {V(r_concrete(it['val'], rng))}, марка по водонепроницаемости W6.",
                )
            )
    else:
        lines.append("Материал | Конструкция | Класс")
        for it in items:
            lines.append(f"Бетон тяжёлый ГОСТ 26633-2015 | {it['name']} |")
            lines.append(V(r_concrete(it["val"], rng)))
    lines += _concrete_distractors(rng)
    return lines + stamp(rng, stage, "КЖ", "Общие данные")


def concrete_id(it, rng):
    return [
        ph(
            rng,
            "ДОКУМЕНТ О КАЧЕСТВЕ БЕТОННОЙ СМЕСИ ЗАДАННОГО КАЧЕСТВА № 1482",
            "ПАСПОРТ НА БЕТОННУЮ СМЕСЬ № 311",
        ),
        f"Изготовитель: ООО «БСУ-{rng.randint(1, 9)}» Потребитель: АО «Стройинвест»",
        f"Объект: {rng.choice(OBJECTS)}; конструкция: {it['name']}",
        ph(
            rng,
            f"Наименование и условное обозначение смеси: БСТ {V(r_concrete(it['val'], rng))} П4 F150 W6 ГОСТ 7473-2010",
            f"Класс бетона по прочности на сжатие {V(r_concrete(it['val'], rng))}",
        ),
        f"Объём партии {rng.randint(5, 60)} м3 Удобоукладываемость П4, осадка конуса {rng.randint(16, 20)} см",
        "Наибольшая крупность заполнителя 20 мм. Коэффициент вариации 13,5 %.",
        f"Требуемая прочность {rng.randint(26, 40)},{rng.randint(0, 9)} МПа",
    ]


# --- арматура --------------------------------------------------------------


def rebar_pd(items, rng, stage):
    lines = [ph(rng, "Материалы конструкций", "4.3 Армирование монолитных конструкций")]
    if rng.random() < 0.5:
        lines.append("Арматура по ГОСТ 34028-2016:")
        for (val, lim), grp in _grouped(items):
            names = ", ".join(it["name"] for it in grp)
            lw = f"{_limit_word(rng, 'rebar_a')} " if lim else ""
            lines.append(
                ph(
                    rng,
                    f"- {names}: рабочая арматура класса {lw}{V(r_rebar(val, rng))};",
                    f"- рабочая арматура ({names}) — {lw}{V(r_rebar(val, rng))};",
                )
            )
        lines.append("- поперечная арматура и хомуты — класса А240.")
    else:
        for it in items:
            lw = f"{_limit_word(rng, 'rebar_a')} " if it["limit"] else ""
            lines.append(
                f"Армирование {it['name']} — отдельными стержнями из арматуры {lw}{V(r_rebar(it['val'], rng))} "
                f"диаметром {rng.choice([12, 16, 20, 25])} мм с шагом 200 мм."
            )
    lines += _rebar_distractors(rng)
    return lines + stamp(rng, stage, "КР", "Пояснительная записка")


def _rebar_distractors(rng):
    d = [
        "Кладочная сетка из проволоки Вр-I ⌀4 с ячейкой 50х50.",
        "Сварные сетки из проволоки В500С по ГОСТ Р 57997.",
        "Бетон конструкций — B25 W6 F150.",
        "Анкеровка и нахлёст стержней — по п. 10.3 СП 63.13330.2018.",
        "Хомуты и шпильки — А240 (А-I), ⌀8.",
        "Закладные детали — из стали С255 по ГОСТ 27772-2015.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def rebar_rd(items, rng, stage):
    lines = [ph(rng, "Общие указания", "Ведомость расхода стали, кг")]
    f = rng.randrange(3)
    if f == 0:
        for k, it in enumerate(items, 1):
            lines.append(
                f"{k}. {it['name']}: арматуру принять класса {V(r_rebar(it['val'], rng))} по ГОСТ 34028-2016."
            )
    elif f == 1:
        lines.append("Марка элемента | Изделия арматурные | Арматура класса | Всего")
        for it in items:
            lines.append(
                f"{it['name']} | ⌀{rng.choice([10, 12, 16, 20])} ГОСТ 34028-2016 |"
            )
            lines.append(
                f"{V(r_rebar(it['val'], rng))} | {rng.randint(100, 9000)},{rng.randint(0, 9)}"
            )
    else:
        lines.append("Спецификация арматуры")
        for it in items:
            d = rng.choice([12, 16, 20, 25])
            lines.append(f"{it['name']}")
            lines.append(
                f"⌀{d} {V(r_rebar(it['val'], rng))} ГОСТ 34028-2016 L={rng.randint(1200, 11700)} {rng.randint(4, 400)} шт."
            )
    lines += _rebar_distractors(rng)
    return lines + stamp(rng, stage, "КЖ", "Общие данные")


def rebar_id(it, rng):
    return [
        ph(rng, "СЕРТИФИКАТ КАЧЕСТВА № 20417", "ДОКУМЕНТ О КАЧЕСТВЕ № 5531/24"),
        f"Изготовитель: АО «{rng.choice(['ЗСМК', 'НЛМК-Сорт', 'Абинский ЭМЗ'])}»",
        f"Наименование продукции: {ph(rng, 'Прокат арматурный', 'Арматура периодического профиля')} класса "
        f"{V(r_rebar(it['val'], rng))} ⌀{rng.choice([12, 16, 20])} мм ГОСТ 34028-2016",
        f"Назначение (по заявке): {it['name']}",
        f"Плавка {rng.randint(10000, 99999)} Партия {rng.randint(100, 999)} Масса нетто {rng.randint(5, 30)},{rng.randint(100, 999)} т",
        f"σт = {rng.randint(520, 590)} Н/мм2  σв = {rng.randint(610, 690)} Н/мм2  δ5 = {rng.randint(16, 22)} %",
        "Изгиб на 180° — удовл.",
    ]


# --- сталь -----------------------------------------------------------------


def steel_pd(items, rng, stage):
    lines = [ph(rng, "Металлические конструкции", "4.5 Стальной каркас")]
    if rng.random() < 0.5:
        lines.append("Сталь строительного проката принята по ГОСТ 27772-2015:")
        for (val, lim), grp in _grouped(items):
            names = ", ".join(it["name"] for it in grp)
            lw = f"{_limit_word(rng, 'steel_c')} " if lim else ""
            lines.append(
                ph(
                    rng,
                    f"{names} — {lw}{V(val)};",
                    f"для {names} — сталь {lw}{V(val)};",
                )
            )
    else:
        lines.append("Элемент | Сталь | Группа конструкций по табл. В.1 СП 16.13330")
        for it in items:
            lw = f"{_limit_word(rng, 'steel_c')} " if it["limit"] else ""
            lines.append(
                f"{it['name'].capitalize()} | {lw}{V(val_steel(it['val'], rng))} | {rng.choice([1, 2, 3])}"
            )
    lines += _steel_distractors(rng)
    return lines + stamp(rng, stage, "КР", "Пояснительная записка")


def val_steel(v, rng):
    return v


def _steel_distractors(rng):
    d = [
        "Болты нормальной точности М20 класса прочности 8.8 по ГОСТ Р ИСО 4014.",
        "Сварка — электродами Э50А по ГОСТ 9467-75.",
        "Фундаменты под колонны — монолитные из бетона B25.",
        "Огнезащита колонн — до R 90, балок — до R 45.",
        "Существующий каркас (по обследованию) выполнен из стали Ст3пс.",
        "Двутавры по ГОСТ Р 57837-2017, швеллеры по ГОСТ 8240-97.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def steel_rd(items, rng, stage):
    lines = [ph(rng, "Общие данные", "Ведомость элементов")]
    f = rng.randrange(2)
    if f == 0:
        lines.append(
            "Марка | Сечение | Усилия для прикрепления | Наименование или марка металла | Примечание"
        )
        for it in items:
            lines.append(f"{it['name']} | N = {rng.randint(10, 400)} кН |")
            lines.append(f"{V(val_steel(it['val'], rng))} ГОСТ 27772-2015 |")
    else:
        lines.append("Технические требования")
        for k, it in enumerate(items, 1):
            lines.append(
                f"{k}. {it['name']} — {ph(rng, 'сталь', 'из стали')} {V(val_steel(it['val'], rng))} по ГОСТ 27772-2015."
            )
    lines += _steel_distractors(rng)
    return lines + stamp(rng, stage, "КМ", "Общие данные")


def steel_id(it, rng):
    return [
        "СЕРТИФИКАТ КАЧЕСТВА (ДОКУМЕНТ О КАЧЕСТВЕ) № 88213",
        f"Изготовитель: ПАО «{rng.choice(['ММК', 'Северсталь', 'НЛМК'])}»",
        f"Продукция: {ph(rng, 'Двутавр 30Б1 ГОСТ Р 57837-2017', 'Швеллер 16П ГОСТ 8240-97', 'Лист 10 ГОСТ 19903-2015')}",
        f"{ph(rng, 'Наименование стали', 'Марка стали')}: {V(val_steel(it['val'], rng))} ГОСТ 27772-2015",
        f"Потребитель/назначение: {it['name']}",
        f"Предел текучести σт {rng.randint(260, 420)} Н/мм2; KCU-40 {rng.randint(35, 70)} Дж/см2",
    ]


# --- категория электроснабжения -------------------------------------------


def power_pd(items, rng, stage):
    lines = [
        ph(rng, "Подраздел «Система электроснабжения»", "5.1 Система электроснабжения"),
        "Электроснабжение объекта предусматривается от ТП-10/0,4 кВ по двум взаимно резервируемым кабельным линиям.",
    ]
    f = rng.randrange(2)
    if f == 0:
        lines.append(
            "По степени обеспечения надёжности электроснабжения электроприёмники объекта относятся:"
        )
        for (val, lim), grp in _grouped(items):
            names = ", ".join(it["name"] for it in grp)
            lw = "не ниже " if lim else ""
            if val == "I (особая группа)":
                lines.append(f"- {names} — {lw}к {V(ph(rng, 'особой группе I', 'I (особая группа)'))} категории;")
            elif lim:
                lines.append(f"- {names} — категория надёжности не ниже {V(r_power(val, rng, 'cell'))};")
            else:
                lines.append(f"- {names} — к {V(r_power(val, rng))} категории;")
    else:
        lines.append("Таблица 5.2 — Категории электроприёмников")
        lines.append("Наименование электроприёмника | Руст, кВт | Категория надёжности")
        for it in items:
            lw = "не ниже " if it["limit"] else ""
            lines.append(
                f"{it['name'].capitalize()} | {rng.randint(3, 180)},{rng.randint(0, 9)} | {lw}{V(r_power(it['val'], rng, 'cell'))}"
            )
    lines += _power_distractors(rng)
    return lines + stamp(rng, stage, "ИОС1", "Пояснительная записка")


def _power_distractors(rng):
    d = [
        "Категория помещения электрощитовой по взрывопожарной и пожарной опасности — В4.",
        "Электрооборудование I класса защиты от поражения электрическим током.",
        "Степень защиты оболочек щитов — не ниже IP31, в насосной — IP54.",
        "Согласно ПУЭ п. 1.2.18 электроприёмники I категории обеспечиваются от двух независимых источников.",
        "Уровень ответственности здания — II (нормальный).",
        "Система заземления TN-C-S.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def power_rd(items, rng, stage):
    lines = [
        ph(rng, "Общие данные", "Принципиальная схема ВРУ. Расчётная таблица нагрузок")
    ]
    f = rng.randrange(2)
    if f == 0:
        lines.append("Наименование потребителя | Рр, кВт | cos φ | Iр, А | Кат.")
        for it in items:
            lines.append(
                f"{it['name']} | {rng.randint(3, 180)},{rng.randint(0, 9)} | 0,{rng.randint(85, 95)} | {rng.randint(5, 250)} | {V(r_power(it['val'], rng, 'cell'))}"
            )
    else:
        for k, it in enumerate(items, 1):
            pv = V("особой группы I") if it["val"] == "I (особая группа)" else V(r_power(it["val"], rng))
            lines.append(
                f"{k}. {it['name']} — электроприёмники {pv} категории надёжности, "
                f"{ph(rng, 'питание через АВР', 'питание от панели ВРУ-1', 'питание от ЩС-2')}."
            )
    lines += _power_distractors(rng)
    return lines + stamp(rng, stage, "ЭОМ", "Общие данные")


# --- степень огнестойкости ------------------------------------------------

DEGREE_EL = {
    "main": ["здание", "жилая часть здания", "здание школы"],
    "park": ["подземная автостоянка", "встроенно-пристроенная автостоянка"],
}


def degree_pd(items, rng, stage):
    lines = [
        ph(
            rng,
            "Раздел 9. Мероприятия по обеспечению пожарной безопасности",
            "Пояснительная записка. Пожарно-техническая характеристика",
        )
    ]
    for it in items:
        lw = "не ниже " if it["limit"] else ""
        f = rng.randrange(3)
        nm = it["name"]
        if f == 0:
            lines.append(
                f"{nm.capitalize()}: степень огнестойкости — {lw}{V(r_degree(it['val'], rng))}, класс конструктивной "
                f"пожарной опасности — С0, класс функциональной пожарной опасности — {rng.choice(['Ф1.3', 'Ф4.1', 'Ф5.2'])}."
            )
        elif f == 1:
            lines.append(
                f"Требуемая степень огнестойкости ({nm}) по табл. 6.8 СП 2.13130.2020 — {lw}{V(r_degree(it['val'], rng))}."
            )
        else:
            lines.append("Показатель | Значение")
            lines.append(
                f"Степень огнестойкости ({nm}) | {lw}{V(r_degree(it['val'], rng))}"
            )
            lines.append("Класс конструктивной пожарной опасности | С0")
    lines += _degree_distractors(rng)
    return lines + stamp(
        rng, stage, "ПБ", "Мероприятия по обеспечению пожарной безопасности"
    )


def _degree_distractors(rng):
    d = [
        "Соседнее существующее здание — IV степени огнестойкости, класса С1; противопожарный разрыв 12 м.",
        "Уровень ответственности — II (нормальный), КС-2.",
        "Предел огнестойкости несущих стен и колонн — R 90, перекрытий — REI 45.",
        "По табл. 21 123-ФЗ для зданий I–V степени огнестойкости пределы огнестойкости принимаются по ст. 87.",
        "Категория здания по взрывопожарной опасности не определяется.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def degree_rd(items, rng, stage):
    lines = [ph(rng, "Общие данные", "Общие указания")]
    for it in items:
        f = rng.randrange(3)
        if f == 0:
            lines.append(
                f"Степень огнестойкости ({it['name']}) — {V(r_degree(it['val'], rng))}."
            )
        elif f == 1:
            lines.append(
                f"{it['name'].capitalize()} {V(r_degree(it['val'], rng, word=True))} степени огнестойкости, класса С0."
            )
        else:
            lines.append(
                f"Пожарно-технические характеристики: {it['name']} — {V(r_degree(it['val'], rng))} ст. огнест., С0, Ф1.3"
            )
    lines += _degree_distractors(rng)
    return lines + stamp(rng, stage, "АР", "Общие данные")


# --- энергоэффективность --------------------------------------------------


def energy_pd(items, rng, stage, code):
    it = items[0]
    lw = ph(rng, "не ниже ", "не ниже ") if it["limit"] else ""
    if code == "M-021":
        lines = [
            "Пояснительная записка",
            f"Объект: {rng.choice(OBJECTS)}",
            "Технико-экономические показатели",
        ]
        f = rng.randrange(2)
        if f == 0:
            lines.append(
                f"Класс энергетической эффективности здания — {lw}{V(r_energy(it['val'], rng))}."
            )
        else:
            lines.append("Наименование показателя | Ед. изм. | Значение")
            lines.append(
                f"Класс энергосбережения (энергетической эффективности) | – | {lw}{V(r_energy(it['val'], rng))}"
            )
        disc = "ПЗ"
    else:
        lines = [
            "Раздел 10(1). Мероприятия по обеспечению соблюдения требований энергетической эффективности"
        ]
        f = rng.randrange(2)
        if f == 0:
            lines.append(
                f"Удельная характеристика расхода тепловой энергии на отопление и вентиляцию "
                f"{rng.randint(20, 40)} % ниже нормируемой; здание соответствует классу "
                f"{lw}{V(r_energy(it['val'], rng))} по табл. 2 приказа Минстроя России № 399/пр."
            )
        else:
            lines.append(
                "Энергетический паспорт проекта. Раздел «Комплексные показатели»"
            )
            lines.append(
                f"Класс энергосбережения здания | {lw}{V(r_energy(it['val'], rng))}"
            )
        disc = "ЭЭ"
    lines += _energy_distractors(rng)
    return lines + stamp(rng, stage, disc, "Текстовая часть")


def _energy_distractors(rng):
    d = [
        "Насосы ИТП — с электродвигателями класса энергоэффективности IE3.",
        "Светодиодные светильники класса энергетической эффективности A+ (по маркировке изготовителя).",
        "Существующее здание до реконструкции — класс энергетической эффективности E (по обследованию).",
        "Шкала классов по табл. 2 приказа № 399/пр: A++, A+, A, B, C, D, E, F, G.",
        "Лифты — класс энергоэффективности B по ГОСТ Р ИСО 25745-2.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def energy_rd(items, rng, stage, code):
    it = items[0]
    lines = [
        ph(
            rng,
            "Энергетический паспорт здания",
            "Общие данные. Теплотехнический расчёт",
        )
    ]
    f = rng.randrange(3)
    if f == 0:
        lines.append("5. Класс энергосбережения")
        lines.append(f"Класс энергосбережения здания {V(r_energy(it['val'], rng))}")
    elif f == 1:
        lines.append(
            f"Присвоенный класс энергетической эффективности: {V(r_energy(it['val'], rng))}"
        )
    else:
        lines.append("Показатель | Обозначение | Нормативное | Расчётное")
        lines.append(
            f"Удельная характеристика расхода тепловой энергии | q_от | 0,{rng.randint(300, 400)} | 0,{rng.randint(200, 299)}"
        )
        lines.append(
            f"Класс энергетической эффективности | — | — | {V(r_energy(it['val'], rng))}"
        )
    lines += _energy_distractors(rng)
    return lines + stamp(
        rng, stage, "ЭЭ" if code == "M-124" else "АР", "Энергетический паспорт"
    )


def energy_id(it, rng):
    return [
        "ЭНЕРГЕТИЧЕСКИЙ ПАСПОРТ МНОГОКВАРТИРНОГО ДОМА (по результатам ввода в эксплуатацию)",
        f"Адрес: г. Казань, ул. {rng.choice(['Новая', 'Садовая', 'Строителей'])}, д. {rng.randint(1, 90)}",
        f"Класс энергетической эффективности {V(r_energy(it['val'], rng))}",
        f"Фактический удельный годовой расход энергетических ресурсов {rng.randint(60, 140)} кВт·ч/м2",
    ]


# --- отделка (М-050 ведомость отделки, М-107 пути эвакуации) --------------


def finish_pd(items, rng, stage, code):
    if code == "M-050":
        lines = [
            ph(
                rng,
                "Раздел 3. Объёмно-планировочные и архитектурные решения",
                "3.4 Решения по отделке помещений",
            )
        ]
        lines.append(
            "Отделка помещений принята в соответствии с их назначением и требованиями СП 1.13130.2020."
        )
    else:
        lines = [
            "Раздел 9. Мероприятия по обеспечению пожарной безопасности",
            "9.6 Пути эвакуации",
            "Отделочные материалы на путях эвакуации приняты по табл. 28 СП 1.13130.2020 "
            f"для зданий класса {rng.choice(['Ф1.3', 'Ф4.1', 'Ф3.4'])} высотой более 28 м:",
        ]
    f = rng.randrange(2)
    for (val, lim), grp in _grouped(items):
        names = ", ".join(it["name"] for it in grp)
        lw = f"{_limit_word(rng, 'finish_km')} " if lim else ""
        if f == 0:
            lines.append(
                f"- {names} — материалы класса пожарной опасности {lw}{V(r_km(val, rng))}"
                + (f" ({KM_GROUPS[val]})" if rng.random() < 0.4 and not lim else "")
                + ";"
            )
        else:
            lines.append(
                f"Для отделки ({names}) применяются материалы {lw}{V(r_km(val, rng))}."
            )
    lines += _finish_distractors(rng)
    return lines + stamp(
        rng, stage, "ПБ" if code == "M-107" else "АР", "Пояснительная записка"
    )


def _finish_distractors(rng):
    d = [
        "Металлоконструкции — см. альбом 24-11-КМ1.",
        "Класс функциональной пожарной опасности здания — Ф1.3.",
        "В помещениях технического назначения (венткамеры, ИТП) допускается отделка материалами КМ4 при условии СП 1.13130 п. 4.3.2.",
        "Табл. 28 СП 1.13130.2020 (выдержка): вестибюли, лестничные клетки — КМ1/КМ0; общие коридоры — КМ2/КМ1.",
        "Ковровые покрытия в жилых комнатах не нормируются.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def finish_rd(items, rng, stage, code):
    if code == "M-050":
        lines = [
            "Ведомость отделки помещений",
            "Наименование или номер помещения | Потолок | Площадь | Стены или перегородки | Площадь | Низ стен | Примечание",
        ]
        for it in items:
            mat = rng.choice(
                [
                    "Штукатурка, окраска ВД-АК краской",
                    "ГКЛО, шпатлевка, окраска",
                    "Керамогранит",
                    "Панели ГВЛ, окраска",
                    "Реечный потолок",
                ]
            )
            lines.append(
                f"{it['name']} | {mat} | {rng.randint(8, 120)},{rng.randint(0, 9)} | {mat.lower()} |"
            )
            lines.append(
                f"{rng.randint(20, 300)},{rng.randint(0, 9)} | – | Материалы {V(r_km(it['val'], rng))}"
            )
    else:
        lines = [ph(rng, "Общие данные", "Общие указания"), "Отделка путей эвакуации:"]
        for k, it in enumerate(items, 1):
            lines.append(
                ph(
                    rng,
                    f"{k}. {it['name']} — класс пожарной опасности отделочных материалов {V(r_km(it['val'], rng))}.",
                    f"{k}. {it['name']}: отделку стен и потолков выполнить материалами {V(r_km(it['val'], rng))} "
                    f"(сертификат пожарной безопасности обязателен).",
                )
            )
    lines += _finish_distractors(rng)
    return lines + stamp(
        rng, stage, "АР", "Ведомость отделки" if code == "M-050" else "Общие данные"
    )


def finish_id(it, rng):
    val = it["val"]
    return [
        "СЕРТИФИКАТ СООТВЕТСТВИЯ требованиям Федерального закона № 123-ФЗ",
        f"№ ЕАЭС RU C-RU.ПБ{rng.randint(10, 99)}.В.{rng.randint(10000, 99999)}",
        f"Продукция: {rng.choice(['Краска водно-дисперсионная ВД-АК-111', 'Панели стеновые из ГВЛ', 'Покрытие напольное ПВХ гетерогенное', 'Плиты потолочные минераловатные'])}",
        f"Область применения: {it['name']}",
        f"Показатели пожарной опасности: {KM_GROUPS[val] if val != 'КМ0' else 'НГ'}; класс пожарной опасности {V(r_km(val, rng))}",
    ]


# --- кабели ----------------------------------------------------------------


def cable_mark(val, rng, kind):
    brand = rng.choice(CABLE_BRANDS[kind])
    sec = rng.choice(["3х1,5", "3х2,5", "5х4", "5х10", "1х2х0,75", "2х1,5", "4х16"])
    return brand.format(r_cable(val, rng)), sec


def cable_pd(items, rng, stage, code):
    kind = "dist" if code == "M-069" else "spz"
    lines = [
        ph(
            rng,
            "Подраздел «Система электроснабжения». Текстовая часть",
            "Раздел 9. Мероприятия по обеспечению пожарной безопасности",
        )
    ]
    f = rng.randrange(2)
    for it in items:
        m, sec = cable_mark(it["val"], rng, kind)
        lw = f"{_limit_word(rng, 'cable_fire')} " if it["limit"] else ""
        if it["limit"]:
            core = f"кабелями с исполнением {lw}{V(r_cable(it['val'], rng))} по ГОСТ 31565-2012"
        else:
            core = f"кабелем марки {V(m)}"
        if f == 0:
            lines.append(f"Кабельные линии ({it['name']}) выполняются {core}.")
        else:
            lines.append(
                f"{it['name'].capitalize()}: предусмотрена прокладка {core.replace('кабелями', 'кабелей').replace('кабелем', 'кабеля')}, "
                f"сечение по расчёту, {sec} мм2 и более."
            )
    lines += _cable_distractors(rng, kind)
    return lines + stamp(
        rng, stage, "ИОС1" if kind == "dist" else "ПБ", "Пояснительная записка"
    )


def _cable_distractors(rng, kind):
    d = [
        "По табл. 2 ГОСТ 31565-2012: нг(А)-FRLS — системы противопожарной защиты; нг(А)-LS — прочие сети в зданиях с массовым пребыванием людей.",
        "Кабельные лотки — металлические перфорированные, степень защиты IP44.",
        "Наружные сети 0,4 кВ — кабель АПвБбШп 4х120 в земле.",
        "Существующие сети (демонтируются): АВВГ 4х50.",
        "Огнестойкие кабельные линии (ОКЛ) — с пределом огнестойкости по ГОСТ Р 53316, не менее времени работы СПЗ.",
    ]
    if kind == "dist":
        d.append("Кабели СПЗ — КПСнг(А)-FRLS (см. раздел ПБ).")
    else:
        d.append("Групповые сети освещения — ВВГнг(А)-LS 3х1,5.")
    return rng.sample(d, rng.randint(0, 2))


def cable_rd(items, rng, stage, code):
    kind = "dist" if code == "M-069" else "spz"
    lines = [
        ph(
            rng,
            "Кабельный журнал",
            "Общие данные",
            "Спецификация оборудования, изделий и материалов",
        )
    ]
    f = rng.randrange(3)
    if f == 0:
        lines.append(
            "Обозначение | Трасса: начало – конец | Марка кабеля | Кол. и сечение жил | Длина, м"
        )
        for k, it in enumerate(items, 1):
            m, sec = cable_mark(it["val"], rng, kind)
            lines.append(
                f"{k}-{rng.randint(1, 20)} | {it['name']} | {V(m)} | {sec} | {rng.randint(5, 220)}"
            )
    elif f == 1:
        for k, it in enumerate(items, 1):
            m, sec = cable_mark(it["val"], rng, kind)
            lines.append(f"{k}. {it['name']} выполнить кабелем {V(m)} {sec}.")
    else:
        lines.append(
            "Поз. | Наименование и техническая характеристика | Тип, марка | Ед. | Кол."
        )
        for k, it in enumerate(items, 1):
            m, sec = cable_mark(it["val"], rng, kind)
            lines.append(f"{k} | Кабель ({it['name']}) |")
            lines.append(f"{V(m)} {sec} | м | {rng.randint(20, 3000)}")
    lines += _cable_distractors(rng, kind)
    return lines + stamp(
        rng,
        stage,
        "ЭОМ" if kind == "dist" else ph(rng, "АПС", "СОУЭ", "ПС"),
        "Кабельный журнал",
    )


def cable_id(it, rng, code):
    kind = "dist" if code == "M-069" else "spz"
    m, sec = cable_mark(it["val"], rng, kind)
    return [
        ph(rng, "ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ", "ПАСПОРТ НА КАБЕЛЬНУЮ ПРОДУКЦИЮ"),
        f"ЕАЭС N RU Д-RU.РА01.В.{rng.randint(10000, 99999)}/24",
        f"Продукция: кабель силовой {V(m)} {sec} ТУ 16.К71-{rng.randint(100, 400)}",
        f"Назначение на объекте: {it['name']}",
        "Соответствует требованиям ТР ЕАЭС 043/2017 и ГОСТ 31565-2012",
        f"Барабан № {rng.randint(100, 999)}, длина {rng.randint(100, 1000)} м",
    ]


# --- двери -----------------------------------------------------------------


def door_pd(items, rng, stage):
    lines = [
        ph(
            rng,
            "Раздел 9. Мероприятия по обеспечению пожарной безопасности",
            "9.4 Противопожарные преграды",
        ),
        "Заполнение проёмов в противопожарных преградах — по табл. 24 Федерального закона № 123-ФЗ:",
    ]
    f = rng.randrange(2)
    for it in items:
        lw = f"{_limit_word(rng, 'fire_limit_door')} " if it["limit"] else ""
        if f == 0:
            lines.append(
                f"- {it['name']} — с пределом огнестойкости {lw}{V(r_door(it['val'], rng))};"
            )
        else:
            lines.append(
                f"{it['name'].capitalize()} предусмотрены противопожарными, {lw}{V(r_door(it['val'], rng))}, "
                f"с самозакрывающимися устройствами и уплотнением в притворах."
            )
    lines += _door_distractors(rng)
    return lines + stamp(rng, stage, "ПБ", "Пояснительная записка")


def _door_distractors(rng):
    d = [
        "Противопожарные стены 1-го типа — REI 150, перегородки 1-го типа — EI 45.",
        "Окна 2-го типа — E 30 (для справки по табл. 24).",
        "Двери шахт лифтов — по ГОСТ Р 53296.",
        "Существующие двери в примыкающем корпусе (EI 15) заменяются по отдельному проекту.",
        "Тамбур-шлюзы 1-го типа с подпором воздуха при пожаре.",
    ]
    return rng.sample(d, rng.randint(0, 2))


def door_rd(items, rng, stage):
    lines = [
        ph(
            rng,
            "Спецификация элементов заполнения проёмов",
            "Ведомость заполнения дверных проёмов",
        )
    ]
    f = rng.randrange(2)
    if f == 0:
        lines.append(
            "Поз. | Обозначение | Наименование | Кол. | Масса ед., кг | Примечание"
        )
        for it in items:
            lines.append(f"{it['name']} | ГОСТ Р 57327-2016 |")
            lines.append(
                f"{rng.choice(['1000х2100', '900х2100', '1500х2100'])} | {rng.randint(1, 24)} | - | {V(r_door(it['val'], rng))}"
            )
    else:
        for k, it in enumerate(items, 1):
            lines.append(
                f"{k}. {it['name']}: предел огнестойкости {V(r_door(it['val'], rng))}, "
                f"{ph(rng, 'с доводчиком и координатором закрывания', 'с антипаникой', 'с порогом')}."
            )
    lines += _door_distractors(rng)
    return lines + stamp(rng, stage, "АР", "Спецификация")


DOOR_PRODUCT = {
    "hatch": "Люки противопожарные ЛПМ",
    "gate": "Ворота противопожарные подъёмно-секционные",
    "lift": "Двери дымогазонепроницаемые противопожарные ДПМ-Д",
    "glazed": "Двери противопожарные остеклённые ДПС-01",
}


def door_id(it, rng):
    return [
        "СЕРТИФИКАТ СООТВЕТСТВИЯ № ЕАЭС RU C-RU.ЧС13.В.0"
        + str(rng.randint(1000, 9999)),
        f"Продукция: {DOOR_PRODUCT.get(it['el'], 'Двери противопожарные металлические однопольные ДПМ-01')}",
        f"Предел огнестойкости {V(r_door(it['val'], rng))} по ГОСТ Р 53307-2009",
        f"Применение на объекте: {it['name']}",
        f"Протокол испытаний № {rng.randint(100, 999)}-ИЛ от {rng.randint(1, 28):02d}.0{rng.randint(1, 9)}.2025",
    ]


# ---------------------------------------------------------------------------
# Диспетчер рамок
# ---------------------------------------------------------------------------


def build_lines(code, stage, items, rng):
    s = PARAMS[code]["scale"]
    if code == "M-055":
        return (
            concrete_pd(items, rng, stage)
            if stage == "PD"
            else concrete_rd(items, rng, stage)
        )
    if code == "M-057":
        return (
            rebar_pd(items, rng, stage)
            if stage == "PD"
            else rebar_rd(items, rng, stage)
        )
    if code == "M-056":
        return (
            steel_pd(items, rng, stage)
            if stage == "PD"
            else steel_rd(items, rng, stage)
        )
    if code == "M-015":
        return (
            power_pd(items, rng, stage)
            if stage == "PD"
            else power_rd(items, rng, stage)
        )
    if code == "M-022":
        return (
            degree_pd(items, rng, stage)
            if stage == "PD"
            else degree_rd(items, rng, stage)
        )
    if s == "energy":
        return (
            energy_pd(items, rng, stage, code)
            if stage == "PD"
            else energy_rd(items, rng, stage, code)
        )
    if s == "finish_km":
        return (
            finish_pd(items, rng, stage, code)
            if stage == "PD"
            else finish_rd(items, rng, stage, code)
        )
    if s == "cable_fire":
        return (
            cable_pd(items, rng, stage, code)
            if stage == "PD"
            else cable_rd(items, rng, stage, code)
        )
    if code == "M-103":
        return (
            door_pd(items, rng, stage) if stage == "PD" else door_rd(items, rng, stage)
        )
    raise KeyError(code)


def build_id_lines(code, it, rng):
    s = PARAMS[code]["scale"]
    if code == "M-055":
        return concrete_id(it, rng)
    if code == "M-057":
        return rebar_id(it, rng)
    if code == "M-056":
        return steel_id(it, rng)
    if s == "energy":
        return energy_id(it, rng)
    if s == "finish_km":
        return finish_id(it, rng)
    if s == "cable_fire":
        return cable_id(it, rng, code)
    if code == "M-103":
        return door_id(it, rng)
    raise KeyError(code)


# ---------------------------------------------------------------------------
# Построение пар
# ---------------------------------------------------------------------------

POS_KINDS = ["worse", "limit_viol", "worse_mixed", "id_worse"]
NEG_KINDS = ["equal", "better", "limit_ok", "id_ok", "equal_form"]


def _elements(code, rng):
    cfg = PARAMS[code]
    if cfg["scale"] == "energy":
        return [
            dict(el="main", pd="здание", rd="здание", val=rng.choice(cfg["pool"][1:5]))
        ]
    if code == "M-022":
        els = [
            dict(
                el="main",
                pd=rng.choice(DEGREE_EL["main"]),
                rd=None,
                val=rng.choice(["III", "II", "II", "I"]),
            )
        ]
        if rng.random() < 0.4:
            els.append(
                dict(
                    el="park",
                    pd=rng.choice(DEGREE_EL["park"]),
                    rd=None,
                    val=rng.choice(["II", "I"]),
                )
            )
        for e in els:
            e["rd"] = e["pd"]
        return els
    keys = list(cfg["el"])
    k = rng.randint(1, min(4, len(keys)))
    chosen = rng.sample(keys, k)
    out = []
    for key in chosen:
        pdn, rdn, pool = cfg["el"][key]
        out.append(
            dict(el=key, pd=rng.choice(pdn), rd=rng.choice(rdn), val=rng.choice(pool))
        )
    return out


def _worse(scale, pool, v, rng):
    c = [x for x in pool if x != v and cmp(scale, v, x) == -1]
    return rng.choice(c) if c else None


def _better(scale, pool, v, rng):
    c = [x for x in pool if x != v and cmp(scale, v, x) == 1]
    return rng.choice(c) if c else None


def _equal_forms(scale, pool, v):
    # другое каноническое значение, равное по своей логике (С345 ~ С345К, EI 60 ~ EIW 60)
    return [x for x in pool if x != v and cmp(scale, v, x) == 0]


def make_pair(code, kind, i, seed, sp):
    rng = random.Random(f"h2|{seed}|{code}|{kind}|{i}")
    cfg = PARAMS[code]
    scale, pool = cfg["scale"], cfg["pool"]
    for _attempt in range(50):
        els = _elements(code, rng)
        pd_vals = [e["val"] for e in els]
        rd_vals = list(pd_vals)
        limits = [False] * len(els)
        id_idx, id_val = None, None
        t = rng.randrange(len(els))
        ok = True
        if kind in ("worse", "limit_viol"):
            w = _worse(scale, pool, pd_vals[t], rng)
            ok = w is not None
            rd_vals[t] = w
            if kind == "limit_viol":
                limits[t] = True
        elif kind == "worse_mixed":
            if len(els) < 2:
                ok = False
            else:
                w = _worse(scale, pool, pd_vals[t], rng)
                o = rng.choice([j for j in range(len(els)) if j != t])
                b = _better(scale, pool, pd_vals[o], rng)
                ok = w is not None and b is not None
                rd_vals[t], rd_vals[o] = w, b
        elif kind == "better":
            b = _better(scale, pool, pd_vals[t], rng)
            ok = b is not None
            rd_vals[t] = b
        elif kind == "limit_ok":
            limits[t] = True
            if rng.random() < 0.6:
                b = _better(scale, pool, pd_vals[t], rng)
                if b is not None:
                    rd_vals[t] = b
        elif kind == "equal_form":
            forms = _equal_forms(scale, pool, pd_vals[t])
            if forms:
                rd_vals[t] = rng.choice(forms)
        elif kind in ("id_worse", "id_ok"):
            if not cfg["id"]:
                ok = False
            else:
                id_idx = t
                if kind == "id_worse":
                    id_val = _worse(scale, pool, rd_vals[t], rng)
                else:
                    id_val = (
                        _better(scale, pool, rd_vals[t], rng)
                        if rng.random() < 0.5
                        else rd_vals[t]
                    )
                ok = id_val is not None
        if ok:
            break
    else:
        return None

    # метка по построению + самоконтроль однозначности
    if id_idx is not None:
        c = cmp(scale, rd_vals[id_idx], id_val)
        label = 1 if c == -1 else 0
    else:
        cs = [cmp(scale, a, b) for a, b in zip(pd_vals, rd_vals)]
        if None in cs:
            return None
        label = 1 if -1 in cs else 0
    assert label == (1 if kind in POS_KINDS else 0), (
        code,
        kind,
        pd_vals,
        rd_vals,
        id_val,
    )

    pd_items = [
        dict(el=e["el"], name=e["pd"], val=v, limit=l)
        for e, v, l in zip(els, pd_vals, limits)
    ]
    rd_items = [
        dict(el=e["el"], name=e["rd"], val=v, limit=False) for e, v in zip(els, rd_vals)
    ]
    rng.shuffle(rd_items)
    noisy = rng.random() < 0.6
    # шум второго распознавателя (~25 % пар, независимо от метки); свой генератор,
    # чтобы остальные пары набора остались побайтно прежними
    arng = random.Random(f"h2alt|{seed}|{code}|{kind}|{i}")
    alt = arng if arng.random() < 0.25 else None
    base = rng.randrange(10**6)
    docs = [
        doc(
            code,
            sp,
            "PD",
            finish(build_lines(code, "PD", pd_items, rng), rng, noisy, alt),
            base,
        ),
        doc(
            code,
            sp,
            "RD",
            finish(build_lines(code, "RD", rd_items, rng), rng, noisy, alt),
            base + 1,
        ),
    ]
    if id_idx is not None:
        it = dict(el=els[id_idx]["el"], name=els[id_idx]["rd"], val=id_val, limit=False)
        docs.append(
            doc(
                code,
                sp,
                "ID",
                finish(build_id_lines(code, it, rng), rng, noisy, alt),
                base + 2,
                suffix="ID",
            )
        )
    return {
        "schema": SCHEMA,
        "param": code,
        "id": f"h2:{code}:{kind}:{i}",
        "label": label,
        "kind": kind,
        "docs": docs,
    }


def generate(n: int, seed: int):
    scales = json.loads(
        (ROOT / "data" / "seed" / "scales.json").read_text(encoding="utf-8")
    )["scales"]
    rows = []
    for code in W1:
        if code not in PARAMS:
            continue
        sp = spec(code, scales)
        for label, kinds in ((1, POS_KINDS), (0, NEG_KINDS)):
            made, i, tries = 0, 0, 0
            while made < n and tries < n * 20:
                kind = kinds[i % len(kinds)]
                i += 1
                tries += 1
                row = make_pair(code, kind, i, seed, sp)
                if row is None:
                    continue
                rows.append(row)
                made += 1
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="HOLDOUT-2: отложенный набор пар ПД/РД/ИД по классовым шкалам"
    )
    ap.add_argument("--n", type=int, default=100, help="пар каждой метки на параметр")
    ap.add_argument("--seed", type=int, default=47)
    ap.add_argument(
        "--out", type=Path, default=ROOT / "var" / "class-scales" / "adv-holdout2.jsonl"
    )
    a = ap.parse_args(argv)
    rows = generate(a.n, a.seed)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    pos = sum(r["label"] for r in rows)
    print(
        f"holdout2: {len(rows)} пар ({pos} положительных, {len(rows) - pos} отрицательных) → {a.out}"
    )


if __name__ == "__main__":
    main()
