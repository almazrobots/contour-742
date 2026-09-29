"""T-175 HOLDOUT-2: второй отложенный набор проверочных страниц.

Три параметра проектной документации жилого здания:
  M-007 — этажность (надземная), M-010 — количество квартир, M-011 — квартирография.

Написан независимо от кода извлечения и от первого отложенного набора: другие
синонимы, порядок слов, заголовки таблиц, сокращения, перенос строк посреди фразы,
латиница вместо кириллицы в текстовом слое. Все числа, объекты, адреса и шифры
вымышлены.

API:
    PARAMS = ["M-007", "M-010", "M-011"]
    samples(seed, n) -> list[dict]   # n страниц на каждый параметр, итого 3n

Элемент: {"code", "lines", "value", "composition", "trap"}.
"""

from __future__ import annotations

import random

PARAMS = ["M-007", "M-010", "M-011"]

POS_SHARE = 0.55
KEYS = ("студия", "1к", "2к", "3к", "4к+")

# ---------------------------------------------------------------- числа словами

_UNITS = [
    "",
    "один",
    "два",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
]
_TEENS = [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
]
_TENS = [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
]
_HUND = [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
]


def words(n: int) -> str:
    """Число 1..999 прописью (именительный падеж, мужской род)."""
    parts = []
    h, r = divmod(n, 100)
    if h:
        parts.append(_HUND[h])
    if 10 <= r < 20:
        parts.append(_TEENS[r - 10])
    else:
        t, u = divmod(r, 10)
        if t:
            parts.append(_TENS[t])
        if u:
            parts.append(_UNITS[u])
    return " ".join(parts)


# прилагательное «N-этажный»: основа в родительном падеже
_STEM = {
    3: "трёх",
    4: "четырёх",
    5: "пяти",
    6: "шести",
    7: "семи",
    8: "восьми",
    9: "девяти",
    10: "десяти",
    11: "одиннадцати",
    12: "двенадцати",
    13: "тринадцати",
    14: "четырнадцати",
    15: "пятнадцати",
    16: "шестнадцати",
    17: "семнадцати",
    18: "восемнадцати",
    19: "девятнадцати",
    20: "двадцати",
    22: "двадцатидвух",
    24: "двадцатичетырёх",
    25: "двадцатипяти",
}


def plural(n: int, one: str, few: str, many: str) -> str:
    if 11 <= n % 100 <= 14:
        return many
    if n % 10 == 1:
        return one
    if 2 <= n % 10 <= 4:
        return few
    return many


def fmt_int(n: int) -> str:
    """Разряды через пробел, как в сметах/ТЭП: 1 234."""
    return f"{n:,}".replace(",", " ")


def fmt_area(x: float) -> str:
    return fmt_int(int(x)) + "," + f"{x:.1f}".split(".")[1]


# ---------------------------------------------------------------- шум страницы

_STREETS = [
    "ул. Вересковая",
    "ул. Кедровая",
    "пр-кт Строителей-Северный",
    "ул. Лесопарковая",
    "ул. Заречная",
    "бул. Янтарный",
    "ул. Полевая Слобода",
    "пер. Ольховый",
]
_CITIES = [
    "г. Новоозёрск",
    "г. Красноборск",
    "г. Верхнекамск",
    "г. Солнечногорск-2",
    "г. Приреченск",
    "пгт Лесной Кордон",
]
_ORGS = [
    "ООО «ПроектСтрой-Альфа»",
    "АО «ГорПроектИнжиниринг»",
    "ООО «Архитектурное бюро Квадр»",
    "ООО «СеверПроект»",
    "ГАУ «Центр экспертизы проектов»",
]
_SECTIONS = ["ПЗ", "АР", "ТЭП", "ПЗУ", "КР", "ПБ", "ОДИ"]


def code(rng: random.Random) -> str:
    return (
        f"{rng.randint(100, 999)}-{rng.randint(1, 99):02d}/"
        f"{rng.randint(21, 26)}-{rng.choice(_SECTIONS)}"
    )


def address(rng: random.Random) -> str:
    return f"{rng.choice(_CITIES)}, {rng.choice(_STREETS)}, д. {rng.randint(1, 140)}"


def header(rng: random.Random) -> list[str]:
    pool = [
        f"Шифр {code(rng)}",
        f"Объект: «Многоквартирный жилой дом по адресу: {address(rng)}»",
        rng.choice(_ORGS),
        f"Том {rng.randint(1, 12)}.{rng.randint(1, 3)}",
        "Раздел 1. Пояснительная записка",
        "Раздел 3. Объёмно-планировочные и архитектурные решения",
        f"Жилой комплекс «{rng.choice(['Берёзовая роща', 'Северный квартал', 'Родники', 'Высота'])}»",
        f"Кадастровый номер земельного участка {rng.randint(10, 89)}:{rng.randint(10, 99)}:"
        f"{rng.randint(1000000, 9999999)}:{rng.randint(10, 9999)}",
    ]
    rng.shuffle(pool)
    return pool[: rng.randint(1, 3)]


def footer(rng: random.Random) -> list[str]:
    pool = [
        "Изм. Кол.уч. Лист №док. Подп. Дата",
        f"Лист {rng.randint(2, 180)}",
        "Инв. № подл.   Подп. и дата   Взам. инв. №",
        f"ГИП {rng.choice(['Орлов', 'Смирнова', 'Галиев', 'Кузьмин'])} А. {rng.choice('ВДКМНС')}.",
        f"{code(rng)}  Формат А4",
        "Копировал",
    ]
    rng.shuffle(pool)
    return pool[: rng.randint(1, 3)]


_LAT = {
    "о": "o",
    "а": "a",
    "е": "e",
    "р": "p",
    "с": "c",
    "х": "x",
    "О": "O",
    "А": "A",
    "Е": "E",
    "Р": "P",
    "С": "C",
    "К": "K",
    "М": "M",
    "Т": "T",
    "Н": "H",
}


def ocr_noise(rng: random.Random, line: str) -> str:
    """Латинские двойники кириллицы и выпавшие пробелы — как в плохом текстовом слое."""
    out = []
    for ch in line:
        if ch in _LAT and rng.random() < 0.18:
            out.append(_LAT[ch])
        else:
            out.append(ch)
    s = "".join(out)
    if rng.random() < 0.3:
        s = s.replace(" — ", "—", 1)
    return s


def page(rng: random.Random, core: list[str], noisy: bool | None = None) -> list[str]:
    """Обернуть смысловые строки шапкой/подвалом до 5–15 строк."""
    if noisy is None:
        noisy = rng.random() < 0.25
    if noisy:
        core = [ocr_noise(rng, ln) if rng.random() < 0.5 else ln for ln in core]
    lines = header(rng) + core + footer(rng)
    while len(lines) < 5:
        lines.insert(
            len(lines) - 1,
            rng.choice(
                [
                    "Проектная документация",
                    "—",
                    "Общие данные",
                    f"Стадия П, {rng.randint(2023, 2026)} г.",
                ]
            ),
        )
    if len(lines) > 15:
        # сначала режем шапку/подвал, смысловые строки сохраняем
        extra = len(lines) - 15
        lines = lines[extra:] if extra < len(lines) - len(core) else lines[:15]
    return lines


def mk(
    code_: str,
    core: list[str],
    rng: random.Random,
    value=None,
    composition=None,
    trap: str = "",
    noisy: bool | None = None,
) -> dict:
    return {
        "code": code_,
        "lines": page(rng, core, noisy),
        "value": value,
        "composition": composition,
        "trap": trap,
    }


# ================================================================ M-007 этажность


def f07_pos_otm(rng):
    n = rng.randint(5, 25)
    core = [
        "4. Объёмно-планировочное решение",
        f"Здание имеет {n} {plural(n, 'надземный этаж', 'надземных этажа', 'надземных этажей')} "
        f"и подвал для прокладки инженерных коммуникаций.",
        f"Высота типового этажа — {rng.choice(['3,0', '3,15', '3,3'])} м (от пола до пола).",
        f"Отметка чистого пола 1-го этажа 0,000 соответствует абс. {rng.randint(120, 260)},{rng.randint(10, 95)}.",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_adj(rng):
    n = rng.choice(list(_STEM))
    stem = _STEM[n]
    extra = rng.choice(
        [
            "с техническим подпольем",
            "с неэксплуатируемым чердаком",
            "с подвалом и тёплым чердаком",
            "со встроенными помещениями на 1-м этаже",
        ]
    )
    core = [
        "Архитектурные решения",
        f"Проектируемый жилой дом — {stem}этажный, односекционный, {extra}.",
        "Конструктивная схема — монолитный железобетонный каркас.",
        f"Размеры в осях {rng.randint(18, 60)},{rng.randint(0, 9)}0 × {rng.randint(12, 18)},{rng.randint(0, 9)}0 м.",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_tep_table(rng):
    n = rng.randint(4, 25)
    under = rng.randint(1, 2)
    core = [
        "Технико-экономические показатели",
        "№ п/п | Показатель | Ед. | Кол-во",
        f"1 | Площадь застройки | м² | {fmt_area(rng.uniform(600, 2400))}",
        f"2 | Этажность | эт. | {n}",
        f"3 | Количество этажей | эт. | {n + under}",
        f"4 | Строительный объём | м³ | {fmt_int(rng.randint(20000, 90000))}",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_expertise(rng):
    n = rng.randint(9, 25)
    under = rng.randint(1, 2)
    core = [
        "2.1.2. Сведения о функциональном назначении объекта",
        "Функциональное назначение: многоквартирный жилой дом (19.7.1.5).",
        f"Технико-экономические показатели: этажность – {n}; "
        f"количество этажей – {n + under + 1} (в т.ч. подземных – {under},",
        f"технический этаж – 1); высота здания – {n * 3 + rng.randint(3, 6)},{rng.randint(1, 9)} м;",
        f"площадь здания – {fmt_area(rng.uniform(8000, 30000))} м².",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_broken(rng):
    n = rng.randint(5, 24)
    core = rng.choice(
        [
            ["Количество надземных эта-", f"жей — {n}, подземных — 1."],
            ["Этажность здания (надземная", f"часть): {n} эт."],
            ["Число этажей над уровнем", "земли", f"{n}"],
        ]
    )
    core = (
        ["1.3 Характеристика здания"]
        + core
        + [
            "Уровень ответственности — нормальный (КС-2).",
        ]
    )
    return mk("M-007", core, rng, value=n)


def f07_pos_words(rng):
    n = rng.randint(5, 25)
    core = [
        "Общая характеристика объекта капитального строительства",
        f"Надземных этажей — {n} ({words(n)}), подземный — 1 (один).",
        "Кровля плоская, с внутренним организованным водостоком.",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_abbr(rng):
    n = rng.randint(5, 25)
    core = [
        "Характеристики корпуса",
        f"Корп. {rng.randint(1, 6)}: эт-ть надз. — {n}; подз. — 1; техн. чердак.",
        f"Класс функц. пож. опасности Ф1.3; степень огнестойкости {rng.choice(['I', 'II'])}.",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_bti(rng):
    n = rng.randint(3, 20)
    core = [
        "Технический паспорт на многоквартирный дом",
        "Раздел 2. Общие сведения",
        f"Год постройки {rng.randint(1958, 2022)}",
        "Материал стен: кирпич",
        f"Число этажей надземной части  {n}",
        "Наличие подвала  да",
        f"Число лестниц  {rng.randint(1, 4)}",
    ]
    return mk("M-007", core, rng, value=n)


def f07_pos_mix(rng):
    """Этажность одной строкой рядом с кучей других чисел."""
    n = rng.randint(6, 25)
    h = n * 3 + rng.randint(2, 5)
    core = [
        f"Здание {n}-этажное (+ подвал), высота до парапета {h},{rng.randint(1, 9)} м,",
        f"пожарно-техническая высота {h - 4},{rng.randint(1, 9)} м, {rng.choice(['1 подъезд', '2 подъезда', '3 подъезда'])},",
        f"{rng.randint(2, 4)} лифта грузоподъёмностью 1000 и 400 кг.",
    ]
    return mk("M-007", core, rng, value=n)


def f07_trap_underground_only(rng):
    k = rng.randint(1, 3)
    core = [
        "Подземная автостоянка",
        f"Подземная часть — {k} {plural(k, 'этаж', 'этажа', 'этажей')}, на отм. -3,600"
        + (" и -6,900" if k > 1 else "")
        + ".",
        f"Вместимость — {rng.randint(40, 300)} машино-мест.",
        "Надземная часть рассматривается в томе 3.2.",
    ]
    return mk("M-007", core, rng, value=None, trap="underground_only")


def f07_trap_limit(rng):
    lim = rng.randint(9, 30)
    core = [
        "Градостроительный план земельного участка",
        "2.2. Предельные параметры разрешённого строительства",
        f"Предельное количество надземных этажей — не более {lim}.",
        f"Предельная высота зданий, строений, сооружений — {lim * 3 + 5} м.",
        f"Максимальный процент застройки — {rng.randint(25, 60)} %.",
    ]
    return mk("M-007", core, rng, value=None, trap="gpzu_limit")


def f07_trap_neighbors(rng):
    a, b = rng.randint(2, 12), rng.randint(2, 5)
    core = [
        "Описание окружающей застройки",
        f"С севера участок граничит с существующим {a}-этажным жилым домом (д. {rng.randint(1, 90)}),",
        f"с востока — здание школы ({b} этажа), с юга — ТП {rng.randint(100, 999)}.",
        "Санитарные разрывы до проектируемого дома соблюдены.",
    ]
    return mk("M-007", core, rng, value=None, trap="neighbor_buildings")


def f07_trap_floor_ref(rng):
    n = rng.randint(10, 25)
    f = rng.randint(2, n - 1)
    core = [
        f"План {f}-го этажа на отм. +{(f - 1) * 3},000. М 1:100",
        f"Квартиры {f}01–{f}0{rng.randint(4, 8)}; лестнично-лифтовой узел.",
        f"Выход на кровлю — с лестничной клетки над {n}-м этажом.",
    ]
    # выход на кровлю над последним этажом — всё же косвенно даёт этажность; не требуем
    return mk("M-007", core, rng, value=None, trap="floor_reference")


def f07_trap_total_with_underground(rng):
    above = rng.randint(5, 20)
    under = rng.randint(1, 2)
    core = [
        "Технический план здания",
        "Характеристики объекта недвижимости",
        f"Количество этажей, в том числе подземных этажей  {above + under}, в том числе подземных {under}",
        "Материал наружных стен  Из прочих материалов",
        f"Год завершения строительства  {rng.randint(2019, 2026)}",
    ]
    return mk("M-007", core, rng, value=above, trap="total_incl_underground")


def f07_trap_sections(rng):
    a = rng.randint(5, 12)
    b = a + rng.randint(2, 6)
    c = b + rng.randint(1, 5)
    core = [
        "Жилой дом переменной этажности из трёх секций:",
        f"– секция 1 (в осях 1–6) — {a} эт.;",
        f"– секция 2 (в осях 6–12) — {b} эт.;",
        f"– секция 3 (в осях 12–18) — {c} эт.",
        f"Максимальная этажность — {c}.",
    ]
    return mk("M-007", core, rng, value=c, trap="variable_sections")


def f07_trap_lift(rng):
    n = rng.randint(9, 25)
    core = [
        "Лифтовое оборудование",
        f"Пассажирский лифт Q=1000 кг, скорость 1,6 м/с, {n + 1} остановок",
        "(включая остановку на отм. подвала).",
        f"Мусоропровод не предусмотрен. Лестничная клетка Н1 с 1 по {n} этаж.",
    ]
    # число остановок/лестница косвенные; явной этажности на странице нет
    return mk("M-007", core, rng, value=None, trap="lift_stops")


def f07_trap_demolish(rng):
    old = rng.randint(1, 5)
    new = rng.randint(9, 25)
    core = [
        "Сведения о сносимых объектах",
        f"На участке расположено {rng.choice(['двухэтажное', 'трёхэтажное', 'одноэтажное'])} "
        f"нежилое здание склада ({old} эт. по данным БТИ), подлежащее сносу.",
        f"На его месте размещается проектируемый {new}-этажный жилой дом.",
    ]
    return mk("M-007", core, rng, value=new, trap="demolished_building")


def f07_trap_height_only(rng):
    h = rng.randint(28, 75)
    core = [
        "Мероприятия по обеспечению пожарной безопасности",
        f"Пожарно-техническая высота здания — {h},{rng.randint(1, 9)} м (менее 75 м).",
        f"Степень огнестойкости — I, класс конструктивной пожарной опасности С0.",
        f"Площадь этажа в пределах пожарного отсека — {fmt_int(rng.randint(500, 2500))} м².",
    ]
    return mk("M-007", core, rng, value=None, trap="height_no_floors")


def f07_trap_revision(rng):
    old = rng.randint(9, 20)
    new = old + rng.choice([1, 2, -1])
    core = [
        "Изменения, внесённые в проектную документацию (корректировка)",
        f"Этажность здания изменена: было {old} надземных этажей, стало {new}.",
        "Количество подземных этажей не изменилось.",
    ]
    return mk("M-007", core, rng, value=new, trap="revision_old_new")


def f07_trap_mansard(rng):
    n = rng.randint(3, 8)
    core = [
        "Индивидуальный жилой дом",
        f"Количество надземных этажей: {n}, включая мансардный этаж; цокольный этаж — 1.",
        f"Цокольный этаж заглублён на {rng.choice(['0,9', '1,2', '1,5'])} м (менее половины высоты).",
    ]
    # цокольный с заглублением меньше половины высоты — надземный; явное значение в строке одно
    return mk("M-007", core, rng, value=n, trap="mansard_socle")


F07_POS = [
    f07_pos_otm,
    f07_pos_adj,
    f07_pos_tep_table,
    f07_pos_expertise,
    f07_pos_broken,
    f07_pos_words,
    f07_pos_abbr,
    f07_pos_bti,
    f07_pos_mix,
]
F07_TRAP = [
    f07_trap_underground_only,
    f07_trap_limit,
    f07_trap_neighbors,
    f07_trap_floor_ref,
    f07_trap_total_with_underground,
    f07_trap_sections,
    f07_trap_lift,
    f07_trap_demolish,
    f07_trap_height_only,
    f07_trap_revision,
    f07_trap_mansard,
]


# ================================================================ M-010 квартиры


def f10_pos_plain(rng):
    n = rng.randint(24, 480)
    core = [
        "Основные показатели жилого дома",
        f"Общее количество квартир — {n} шт.",
        f"Общая площадь квартир (без летних помещений) — {fmt_area(n * rng.uniform(38, 62))} м².",
        f"Жилая площадь квартир — {fmt_area(n * rng.uniform(17, 30))} м².",
    ]
    return mk("M-010", core, rng, value=n)


def f10_pos_words(rng):
    n = rng.randint(20, 400)
    core = [
        f"В жилом доме запроектировано {n} ({words(n)}) {plural(n, 'квартира', 'квартиры', 'квартир')}",
        "различной планировки, в том числе квартиры для семей с МГН на 1-м этаже.",
    ]
    return mk("M-010", core, rng, value=n)


def f10_pos_tep(rng):
    n = rng.randint(40, 600)
    core = [
        "ТЕХНИКО-ЭКОНОМИЧЕСКИЕ ПОКАЗАТЕЛИ",
        "Наименование | Ед. изм. | Показатель",
        f"Площадь жилого здания | м² | {fmt_area(n * rng.uniform(60, 80))}",
        f"Кол-во квартир, всего | шт. | {n}",
        f"Площадь квартир | м² | {fmt_area(n * rng.uniform(40, 58))}",
        f"Кол-во машино-мест | м/м | {rng.randint(20, 200)}",
    ]
    return mk("M-010", core, rng, value=n)


def f10_pos_expertise(rng):
    n = rng.randint(30, 500)
    core = [
        "Технико-экономические показатели объекта:",
        f"площадь застройки – {fmt_area(rng.uniform(700, 3000))} м²; этажность – {rng.randint(9, 25)};",
        f"количество квартир – {n} ед.; площадь квартир – {fmt_area(n * rng.uniform(40, 60))} м²;",
        f"количество нежилых помещений – {rng.randint(1, 12)} ед.",
    ]
    return mk("M-010", core, rng, value=n)


def f10_pos_sections_total(rng):
    parts = [rng.randint(30, 140) for _ in range(rng.randint(2, 4))]
    tot = sum(parts)
    core = ["Распределение квартир по секциям", "Секция | Этажей | Квартир"]
    for i, p in enumerate(parts, 1):
        core.append(f"{i} | {rng.randint(9, 17)} | {p}")
    core.append(f"Итого по жилому дому | — | {tot}")
    return mk("M-010", core, rng, value=tot, trap="")


def f10_pos_broken(rng):
    n = rng.randint(20, 400)
    core = rng.choice(
        [
            ["Количество квар-", f"тир в доме: {n}."],
            ["Всего квартир", "(шт.)", f"{n}"],
            [f"Квартир — {n}", "(в т.ч. 1-комн., 2-комн., 3-комн.)"],
        ]
    )
    core = (
        ["Сведения о жилом фонде"] + core + ["Кладовые на 1-м этаже не предусмотрены."]
    )
    return mk("M-010", core, rng, value=n)


def f10_pos_bti(rng):
    n = rng.randint(12, 200)
    core = [
        "Сведения о количестве помещений",
        f"Количество жилых помещений (квартир)  {n}",
        f"Количество нежилых помещений  {rng.randint(0, 6)}",
        f"Количество комнат в квартирах  {n * 2 + rng.randint(-10, 20)}",
    ]
    return mk("M-010", core, rng, value=n, trap="")


def f10_pos_reverse(rng):
    n = rng.randint(30, 450)
    core = [
        "Показатели объекта",
        f"{n} — количество квартир (жилая часть),",
        f"{rng.randint(1, 10)} — количество встроенных нежилых помещений общественного назначения.",
    ]
    return mk("M-010", core, rng, value=n)


def f10_trap_sections_no_total_part(rng):
    a = rng.randint(40, 140)
    core = [
        f"Секция {rng.randint(2, 4)} (настоящий раздел — только эта секция)",
        f"В секции размещается {a} квартир: с 2-го по {rng.randint(10, 20)}-й этаж.",
        "Остальные секции см. тома 3.1, 3.3.",
    ]
    return mk("M-010", core, rng, value=None, trap="one_section_only")


def f10_trap_sections_sum(rng):
    parts = [rng.randint(30, 120) for _ in range(rng.randint(2, 3))]
    core = [f"Жилой дом из {len(parts)} секций. Квартиры по секциям:"]
    for i, p in enumerate(parts, 1):
        core.append(f"секция {i} — {p} кв.;")
    return mk("M-010", core, rng, value=sum(parts), trap="sections_without_total")


def f10_trap_nonres(rng):
    core = [
        "Встроенно-пристроенные помещения",
        f"Нежилых помещений — {rng.randint(2, 15)}, в т.ч. офисы — {rng.randint(1, 6)}.",
        f"Машино-мест в подземной автостоянке — {rng.randint(40, 260)}.",
        f"Кладовых (келлеров) — {rng.randint(30, 150)}.",
    ]
    return mk("M-010", core, rng, value=None, trap="nonresidential_parking")


def f10_trap_per_floor(rng):
    k = rng.randint(4, 12)
    core = [
        "Типовой этаж",
        f"На типовом этаже размещено {k} квартир: {rng.randint(1, 3)} однокомнатных,",
        "остальные — двух- и трёхкомнатные. Выход на незадымляемую лестницу через лифтовой холл.",
    ]
    return mk("M-010", core, rng, value=None, trap="per_floor_only")


def f10_trap_area(rng):
    core = [
        "Площади",
        f"Площадь квартир — {fmt_area(rng.uniform(5000, 30000))} м²",
        f"Общая площадь квартир с учётом лоджий (k=0,5) — {fmt_area(rng.uniform(5200, 31000))} м²",
        f"Средняя площадь квартиры — {fmt_area(rng.uniform(38, 70))} м²",
    ]
    return mk("M-010", core, rng, value=None, trap="areas_not_count")


def f10_trap_resettle(rng):
    old = rng.randint(8, 60)
    core = [
        "Сведения о расселении",
        f"В сносимых домах № {rng.randint(1, 40)} и № {rng.randint(41, 90)} — {old} квартир,",
        "жители которых расселяются в рамках программы реновации.",
    ]
    return mk("M-010", core, rng, value=None, trap="existing_demolished_fund")


def f10_trap_mgn_subset(rng):
    n = rng.randint(60, 400)
    m = rng.randint(2, 8)
    core = [
        "Обеспечение доступа МГН",
        f"Для инвалидов-колясочников предусмотрено {m} квартир на 1-м этаже",
        f"из общего числа {n} квартир жилого дома.",
    ]
    return mk("M-010", core, rng, value=n, trap="mgn_subset")


def f10_trap_apartments(rng):
    core = [
        "Гостиничный комплекс с апартаментами",
        f"Количество апартаментов — {rng.randint(40, 300)}.",
        "Апартаменты являются нежилыми помещениями и квартирами не являются.",
    ]
    return mk("M-010", core, rng, value=None, trap="apartments_not_flats")


def f10_trap_ddu(rng):
    core = [
        "Отчёт застройщика за 2 квартал",
        f"Заключено договоров участия в долевом строительстве: {rng.randint(10, 150)} квартир.",
        f"Процент реализации — {rng.randint(10, 90)} %.",
    ]
    return mk("M-010", core, rng, value=None, trap="sold_not_designed")


def f10_trap_queue(rng):
    a, b = rng.randint(100, 400), rng.randint(100, 400)
    core = [
        "Жилой комплекс строится в две очереди:",
        f"1 очередь — корпуса 1, 2 ({a} квартир);",
        f"2 очередь — корпуса 3–5 ({b} квартир).",
        "Настоящий том — корпус 2.",
    ]
    return mk("M-010", core, rng, value=None, trap="complex_stages")


def f10_trap_residents(rng):
    n = rng.randint(40, 300)
    ppl = int(n * rng.uniform(1.8, 2.6))
    core = [
        "Расчёт численности жителей",
        f"Расчётная численность населения — {ppl} чел. (при норме 30 м²/чел.)",
        f"Количество квартир — {n}.",
        f"Мест в ДОУ требуется — {rng.randint(10, 60)}.",
    ]
    return mk("M-010", core, rng, value=n, trap="population_numbers")


F10_POS = [
    f10_pos_plain,
    f10_pos_words,
    f10_pos_tep,
    f10_pos_expertise,
    f10_pos_sections_total,
    f10_pos_broken,
    f10_pos_bti,
    f10_pos_reverse,
]
F10_TRAP = [
    f10_trap_sections_no_total_part,
    f10_trap_sections_sum,
    f10_trap_nonres,
    f10_trap_per_floor,
    f10_trap_area,
    f10_trap_resettle,
    f10_trap_mgn_subset,
    f10_trap_apartments,
    f10_trap_ddu,
    f10_trap_queue,
    f10_trap_residents,
]


# ================================================================ M-011 квартирография


def rand_comp(rng, big: bool = False) -> dict:
    comp = {
        "студия": rng.choice([0, 0, rng.randint(4, 60)]),
        "1к": rng.randint(10, 120),
        "2к": rng.randint(8, 90),
        "3к": rng.randint(2, 50),
        "4к+": rng.choice([0, rng.randint(1, 12)]) if not big else rng.randint(1, 10),
    }
    return comp


def clean(comp: dict) -> dict:
    return {k: comp.get(k, 0) for k in KEYS}


def f11_pos_table(rng):
    c = rand_comp(rng)
    names = {
        "студия": rng.choice(["Студия", "Квартира-студия", "Студии"]),
        "1к": rng.choice(["1-комнатная", "Однокомнатные", "1-комн."]),
        "2к": rng.choice(["2-комнатная", "Двухкомнатные", "2-комн."]),
        "3к": rng.choice(["3-комнатная", "Трёхкомнатные", "3-комн."]),
        "4к+": rng.choice(["4-комнатная", "Четырёхкомнатные", "4-комн."]),
    }
    core = [
        rng.choice(
            ["Квартирография", "Сводная ведомость квартир", "Ведомость типов квартир"]
        ),
        "Тип квартиры | Кол-во, шт. | Общая пл., м²",
    ]
    total_area = 0.0
    for k in KEYS:
        if c[k]:
            a = round(c[k] * rng.uniform(25, 110), 1)
            total_area += a
            core.append(f"{names[k]} | {c[k]} | {fmt_area(a)}")
    core.append(f"Итого | {sum(c.values())} | {fmt_area(round(total_area, 1))}")
    return mk("M-011", core, rng, composition=clean(c))


def f11_pos_inline(rng):
    c = rand_comp(rng)
    parts = []
    if c["студия"]:
        parts.append(f"студий — {c['студия']}")
    parts.append(f"однокомнатных — {c['1к']}")
    parts.append(f"двухкомнатных — {c['2к']}")
    parts.append(f"трёхкомнатных — {c['3к']}")
    if c["4к+"]:
        parts.append(f"четырёхкомнатных — {c['4к+']}")
    tot = sum(c.values())
    core = [
        "Жилая часть",
        f"Всего в доме {tot} квартир, из них: " + ", ".join(parts[:2]) + ",",
        ", ".join(parts[2:]) + ".",
    ]
    return mk("M-011", core, rng, composition=clean(c))


def f11_pos_expertise(rng):
    c = rand_comp(rng)
    core = [f"количество квартир – {sum(c.values())} шт., в том числе:"]
    if c["студия"]:
        core.append(f"квартир-студий – {c['студия']} шт.;")
    core += [
        f"1-комнатных – {c['1к']} шт.;",
        f"2-комнатных – {c['2к']} шт.;",
        f"3-комнатных – {c['3к']} шт." + (";" if c["4к+"] else "."),
    ]
    if c["4к+"]:
        core.append(f"4-комнатных – {c['4к+']} шт.")
    return mk("M-011", core, rng, composition=clean(c))


def f11_pos_abbr_k(rng):
    c = rand_comp(rng)
    bits = []
    if c["студия"]:
        bits.append(f"Ст — {c['студия']}")
    bits += [f"1К — {c['1к']}", f"2К — {c['2к']}", f"3К — {c['3к']}"]
    if c["4к+"]:
        bits.append(f"4К — {c['4к+']}")
    core = ["Квартирография дома (шт.):", "; ".join(bits), f"Всего: {sum(c.values())}"]
    return mk("M-011", core, rng, composition=clean(c))


def f11_pos_columns(rng):
    """Шапка таблицы — типы, строка ниже — количества (горизонтальная таблица)."""
    c = rand_comp(rng)
    c["студия"] = rng.randint(5, 40)
    c["4к+"] = rng.randint(1, 8)
    core = [
        "Состав квартир",
        "Показатель | Студ. | 1-к | 2-к | 3-к | 4-к | Всего",
        f"Количество, шт. | {c['студия']} | {c['1к']} | {c['2к']} | {c['3к']} | {c['4к+']} | {sum(c.values())}",
        f"Доля, % | "
        + " | ".join(str(round(100 * c[k] / sum(c.values()))) for k in KEYS)
        + " | 100",
    ]
    return mk("M-011", core, rng, composition=clean(c))


def f11_pos_broken(rng):
    c = rand_comp(rng)
    c["студия"] = 0
    core = [
        "Проектом предусмотрены квартиры: однокомнат-",
        f"ные — {c['1к']} шт., двухкомнатные — {c['2к']}",
        f"шт., трёхкомнатные — {c['3к']} шт."
        + (f", четырёхкомнатные — {c['4к+']} шт." if c["4к+"] else ""),
    ]
    return mk("M-011", core, rng, composition=clean(c))


def f11_pos_euro(rng):
    """Евроформат: «2Е» — двухкомнатная (кухня-гостиная + спальня)."""
    c = rand_comp(rng)
    c["4к+"] = 0
    core = [
        "Квартирография (евроформат)",
        f"С (студии) — {c['студия']} шт."
        if c["студия"]
        else "Студии не предусмотрены.",
        f"1С (однокомнатные) — {c['1к']} шт.",
        f"2Е (двухкомнатные евро) — {c['2к']} шт.",
        f"3Е (трёхкомнатные евро) — {c['3к']} шт.",
    ]
    return mk("M-011", core, rng, composition=clean(c), trap="")


def f11_trap_per_floor(rng):
    core = [
        f"Типовой этаж (2–{rng.randint(9, 20)}-й)",
        f"На этаже: 1-комн. — {rng.randint(1, 4)}, 2-комн. — {rng.randint(1, 3)}, 3-комн. — {rng.randint(0, 2)}.",
        "Квартиры имеют остеклённые лоджии.",
    ]
    return mk("M-011", core, rng, composition=None, trap="per_floor_only")


def f11_trap_areas(rng):
    core = [
        "Площади квартир по типам, м²",
        f"однокомнатные — {fmt_area(rng.uniform(900, 5000))}",
        f"двухкомнатные — {fmt_area(rng.uniform(1000, 6000))}",
        f"трёхкомнатные — {fmt_area(rng.uniform(600, 4000))}",
    ]
    return mk("M-011", core, rng, composition=None, trap="areas_by_type")


def f11_trap_percent(rng):
    a = rng.randint(10, 30)
    b = rng.randint(25, 40)
    c = rng.randint(15, 30)
    core = [
        "Задание на проектирование, п. 12 «Квартирография»",
        f"Рекомендуемое соотношение: студии — {a} %, 1-комн. — {b} %,",
        f"2-комн. — {c} %, 3-комн. — {100 - a - b - c} %.",
    ]
    return mk("M-011", core, rng, composition=None, trap="percent_share")


def f11_trap_total_only(rng):
    n = rng.randint(40, 400)
    core = [
        "Показатели жилой части",
        f"Количество квартир — {n}, в т.ч. одно-, двух- и трёхкомнатные.",
        f"Площадь квартир — {fmt_area(n * rng.uniform(40, 60))} м².",
    ]
    return mk("M-011", core, rng, composition=None, trap="total_without_breakdown")


def f11_trap_one_section(rng):
    core = [
        f"Секция {rng.randint(1, 4)}. Экспликация квартир (для данной секции)",
        f"1-комн. — {rng.randint(10, 40)}; 2-комн. — {rng.randint(10, 30)}; 3-комн. — {rng.randint(2, 15)}",
        "Сводная квартирография по дому — см. ПЗ, том 1.",
    ]
    return mk("M-011", core, rng, composition=None, trap="one_section_only")


def f11_trap_sections_total(rng):
    s1, s2 = rand_comp(rng), rand_comp(rng)
    s1["студия"] = s2["студия"] = 0
    s1["4к+"] = s2["4к+"] = 0
    tot = {k: s1[k] + s2[k] for k in KEYS}
    core = [
        "Квартирография по секциям",
        "Тип | Секция 1 | Секция 2 | Всего по дому",
    ]
    for k, nm in (("1к", "1-комн."), ("2к", "2-комн."), ("3к", "3-комн.")):
        core.append(f"{nm} | {s1[k]} | {s2[k]} | {tot[k]}")
    core.append(
        f"Итого | {sum(s1.values())} | {sum(s2.values())} | {sum(tot.values())}"
    )
    return mk(
        "M-011", core, rng, composition=clean(tot), trap="sections_with_total_column"
    )


def f11_trap_big_rooms(rng):
    c = rand_comp(rng)
    f4, f5, f6 = rng.randint(1, 8), rng.randint(1, 4), rng.randint(0, 2)
    c["4к+"] = f4 + f5 + f6
    core = [
        "Состав квартир",
        f"1-комн. — {c['1к']}; 2-комн. — {c['2к']}; 3-комн. — {c['3к']};",
        f"4-комн. — {f4}; 5-комн. — {f5}"
        + (f"; 6-комн. (пентхаус) — {f6}" if f6 else "")
        + ".",
    ]
    if c["студия"]:
        core.insert(1, f"Студии — {c['студия']};")
    return mk("M-011", core, rng, composition=clean(c), trap="rooms_5plus_to_4plus")


def f11_trap_nested_studio(rng):
    st = rng.randint(4, 30)
    one = rng.randint(20, 80)
    c = {
        "студия": st,
        "1к": one,
        "2к": rng.randint(10, 60),
        "3к": rng.randint(2, 30),
        "4к+": 0,
    }
    core = [
        "Квартиры по количеству комнат:",
        f"однокомнатные — {st + one} (в том числе студии — {st});",
        f"двухкомнатные — {c['2к']}; трёхкомнатные — {c['3к']}.",
    ]
    return mk("M-011", core, rng, composition=clean(c), trap="studios_inside_1k")


def f11_trap_resettle(rng):
    core = [
        "Расселяемый жилой фонд (дом под снос)",
        f"1-комн. — {rng.randint(2, 12)}, 2-комн. — {rng.randint(4, 16)}, 3-комн. — {rng.randint(1, 8)}.",
        "Жители переселяются в квартиры проектируемого дома равнозначной площади.",
    ]
    return mk("M-011", core, rng, composition=None, trap="existing_fund")


def f11_trap_rooms_count(rng):
    core = [
        "Показатели",
        f"Количество жилых комнат — {rng.randint(150, 700)}.",
        f"Количество квартир — {rng.randint(80, 350)}.",
        f"Санузлов — {rng.randint(80, 400)}.",
    ]
    return mk("M-011", core, rng, composition=None, trap="rooms_not_types")


def f11_trap_nonres(rng):
    core = [
        "Встроенные помещения 1-го этажа",
        f"Офис 1 — 2 комнаты, {fmt_area(rng.uniform(40, 90))} м²; офис 2 — 3 комнаты;",
        f"помещение ТСЖ — 1 комната. Колясочные — {rng.randint(1, 4)}.",
    ]
    return mk("M-011", core, rng, composition=None, trap="nonresidential_rooms")


F11_POS = [
    f11_pos_table,
    f11_pos_inline,
    f11_pos_expertise,
    f11_pos_abbr_k,
    f11_pos_columns,
    f11_pos_broken,
    f11_pos_euro,
]
F11_TRAP = [
    f11_trap_per_floor,
    f11_trap_areas,
    f11_trap_percent,
    f11_trap_total_only,
    f11_trap_one_section,
    f11_trap_sections_total,
    f11_trap_big_rooms,
    f11_trap_nested_studio,
    f11_trap_resettle,
    f11_trap_rooms_count,
    f11_trap_nonres,
]


# ================================================================ сборка

_GEN = {
    "M-007": (F07_POS, F07_TRAP),
    "M-010": (F10_POS, F10_TRAP),
    "M-011": (F11_POS, F11_TRAP),
}


def _draw(rng: random.Random, pool: list, i: int):
    # по кругу с перемешиванием: все шаблоны покрыты, порядок зависит от seed
    return pool[i % len(pool)]


def samples(seed: int, n: int) -> list[dict]:
    """n страниц на КАЖДЫЙ параметр (итого 3n), детерминированно по seed."""
    rng = random.Random(seed)
    out: list[dict] = []
    for code_ in PARAMS:
        pos, trap = _GEN[code_]
        pos = pos[:]
        trap = trap[:]
        rng.shuffle(pos)
        rng.shuffle(trap)
        n_pos = round(n * POS_SHARE)
        kinds = [True] * n_pos + [False] * (n - n_pos)
        rng.shuffle(kinds)
        ip = it = 0
        for is_pos in kinds:
            if is_pos:
                d = _draw(rng, pos, ip)(rng)
                ip += 1
            else:
                d = _draw(rng, trap, it)(rng)
                it += 1
            out.append(d)
    return out


if __name__ == "__main__":  # pragma: no cover
    import collections

    s = samples(11, 60)
    print(len(s), collections.Counter((d["code"], d["trap"] or "pos") for d in s))
