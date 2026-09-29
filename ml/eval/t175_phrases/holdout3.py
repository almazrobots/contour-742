"""Третий отложенный набор синтетических страниц ПД/РД для оценки извлечения
M-007 (этажность надземная), M-010 (количество квартир), M-011 (квартирография).

Составлен независимо: формулировки, шум и ловушки придуманы заново, ни на какие
другие наборы и код репозитория не опирается. Все объекты, адреса, шифры, фамилии
и числа вымышлены.

Контракт: samples(seed, n) -> list[dict] длины 3*n; порядок — n страниц M-007,
затем n страниц M-010, затем n страниц M-011. Элемент:
    {"code", "lines", "value", "composition", "trap"}
value — целое для M-007/M-010 (None, если значения проектируемого дома на странице нет),
composition — словарь для M-011 (None, если состава нет), trap — "" или имя класса ловушки.
Детерминизм: только random.Random(seed).
"""

from __future__ import annotations

import random

TRAP_SHARE = 0.45  # доля ловушек на параметр
OCR_SHARE = 0.15  # доля строк с латинскими двойниками букв

# ---------------------------------------------------------------- утилиты текста

_LAT = {
    "о": "o",
    "с": "c",
    "а": "a",
    "е": "e",
    "р": "p",
    "х": "x",
    "О": "O",
    "С": "C",
    "А": "A",
    "Е": "E",
    "Р": "P",
    "Х": "X",
    "К": "K",
    "М": "M",
    "Т": "T",
    "Н": "H",
    "В": "B",
}


def _ocr(rnd: random.Random, line: str) -> str:
    """Подменяет 1–3 кириллические буквы латинскими двойниками (ошибка OCR)."""
    idx = [i for i, ch in enumerate(line) if ch in _LAT]
    if not idx:
        return line
    chars = list(line)
    for i in rnd.sample(idx, min(len(idx), rnd.randint(1, 3))):
        chars[i] = _LAT[chars[i]]
    return "".join(chars)


def _pl(n: int, one: str, few: str, many: str) -> str:
    """Согласование существительного с числом: 1 этаж, 2 этажа, 5 этажей."""
    if 11 <= n % 100 <= 14:
        return many
    if n % 10 == 1:
        return one
    if 2 <= n % 10 <= 4:
        return few
    return many


_ONES = [
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


def _words(n: int, fem: bool = False) -> str:
    """Число 1..999 словами в именительном падеже (fem — «одна/две»)."""
    if not 1 <= n <= 999:
        return str(n)
    parts = []
    h, rest = divmod(n, 100)
    if h:
        parts.append(_HUND[h])
    if 10 <= rest <= 19:
        parts.append(_TEENS[rest - 10])
    else:
        t, o = divmod(rest, 10)
        if t:
            parts.append(_TENS[t])
        if o:
            if fem and o == 1:
                parts.append("одна")
            elif fem and o == 2:
                parts.append("две")
            else:
                parts.append(_ONES[o])
    return " ".join(parts)


def _sep(rnd: random.Random) -> str:
    return rnd.choice([" — ", ": ", " – ", " - ", "\t", "    ", " | "])


# ---------------------------------------------------------------- шум страницы

_TOWNS = [
    "г. Условнинск",
    "г. Примерово",
    "пос. Образцовый",
    "г. Новый Макетск",
    "г. Черновецк-Условный",
    "с. Тестовое",
]
_STREETS = [
    "ул. Чертёжная",
    "пр-т Планировщиков",
    "ул. Кальковая",
    "ул. Масштабная",
    "пер. Штампованный",
    "ул. Эскизная",
]
_SURNAMES = ["Образцов", "Примеров", "Чертёжников", "Макетова", "Эскизов", "Листова"]
_HEADERS = [
    "Раздел 1. Пояснительная записка",
    "Раздел 3. Объёмно-планировочные и архитектурные решения",
    "Технико-экономические показатели",
    "ТЭП объекта капитального строительства",
    "Раздел 2. Схема планировочной организации земельного участка",
    "Том 1. Общая пояснительная записка",
    "1.4. Характеристика проектируемого объекта",
    "3.2. Описание объёмно-пространственного решения",
    "Приложение Б. Сводная таблица показателей",
    "РД. Архитектурные решения. Общие данные",
]


def _noise(rnd: random.Random) -> str:
    k = rnd.randrange(16)
    if k == 0:
        return (
            f"Кадастровый номер ЗУ: {rnd.randint(10, 89)}:{rnd.randint(1, 30):02d}:"
            f"{rnd.randint(1000000, 9999999)}:{rnd.randint(1, 999)}"
        )
    if k == 1:
        return (
            f"Шифр {rnd.randint(100, 999)}-{rnd.randint(10, 99)}-"
            f"{rnd.choice(['ПЗ', 'АР', 'КР', 'ТЭП', 'ПЗУ', 'ИОС1', 'ОДИ'])}"
        )
    if k == 2:
        return f"Лист {rnd.randint(1, 60)}    Листов {rnd.randint(61, 140)}"
    if k == 3:
        return "Изм.  Кол.уч.  Лист  № док.  Подп.  Дата"
    if k == 4:
        return f"Дата выпуска: {rnd.randint(1, 28):02d}.{rnd.randint(1, 12):02d}.20{rnd.randint(22, 26)}"
    if k == 5:
        return f"Площадь земельного участка — {rnd.randint(3000, 45000)} м²"
    if k == 6:
        return (
            f"Площадь застройки: {rnd.randint(600, 4800)},{rnd.randint(0, 99):02d} м²"
        )
    if k == 7:
        return f"ГИП {rnd.choice(_SURNAMES)} {rnd.choice('АБВГДЕК')}.{rnd.choice('АБВГДЕК')}."
    if k == 8:
        return f"Инв. № подл. {rnd.randint(1000, 9999)}   Взам. инв. №"
    if k == 9:
        return (
            f"Объект: многоквартирный жилой дом, {rnd.choice(_TOWNS)}, "
            f"{rnd.choice(_STREETS)}, з/у {rnd.randint(1, 120)}, поз. {rnd.randint(1, 12)}"
        )
    if k == 10:
        return f"Стадия {rnd.choice(['П', 'Р'])}"
    if k == 11:
        return (
            f"Класс энергетической эффективности — {rnd.choice(['A', 'B', 'B+', 'C'])}"
        )
    if k == 12:
        return (
            f"Отметка 0,000 соответствует абсолютной отметке "
            f"{rnd.randint(90, 260)},{rnd.randint(0, 99):02d} м"
        )
    if k == 13:
        return f"Строительный объём — {rnd.randint(20000, 160000)} м³"
    if k == 14:
        return f"Уровень ответственности — {rnd.choice(['нормальный', 'повышенный'])}"
    return f"Договор № {rnd.randint(10, 999)}/{rnd.randint(22, 26)}-П от {rnd.randint(1, 28)}.{rnd.randint(1, 12):02d}.20{rnd.randint(22, 26)}"


def _page(rnd: random.Random, content: list[str]) -> list[str]:
    """Собирает страницу: шапка + шум вокруг содержательного блока, 5–15 строк."""
    assert 1 <= len(content) <= 14, content
    header = rnd.sample(_HEADERS, rnd.randint(1, 2))
    if len(header) + len(content) > 15:
        header = header[:1]
    target = rnd.randint(max(5, len(header) + len(content)), 15)
    noise = [_noise(rnd) for _ in range(target - len(header) - len(content))]
    pos = rnd.randint(0, len(noise))
    lines = header + noise[:pos] + content + noise[pos:]
    lines = [_ocr(rnd, s) if rnd.random() < OCR_SHARE else s for s in lines]
    assert 5 <= len(lines) <= 15
    return lines


# ---------------------------------------------------------------- M-007 этажность


def _floors_adj(v: int) -> str:
    """«17 надземных этажей», «21 надземный этаж», «3 надземных этажа»."""
    return _pl(v, "надземный этаж", "надземных этажа", "надземных этажей")


def _m007_normal(rnd: random.Random, v: int, compact: bool = False) -> list[str]:
    et = _pl(v, "этаж", "этажа", "этажей")
    forms = [
        lambda: [f"| Этажность | эт. | {v} |"],
        lambda: [f"Этажность здания{_sep(rnd)}{v} {et}"],
        lambda: [
            f"Проектируемый жилой дом — {v}-этажный, "
            f"{rnd.choice(['односекционный', 'двухсекционный', 'трёхсекционный'])}, "
            f"с {rnd.choice(['техническим подпольем', 'подвалом', 'техническим чердаком'])}."
        ],
        lambda: [f"Количество надземных этажей — {_words(v)} ({v})."],
        lambda: [f"Кол-во надз. эт.: {v}"],
        lambda: [f"Этажность\t\t{v} эт."],
        lambda: [f"Число этажей надземной части – {v}"],
        lambda: [f"Высотность (этажность): {v} эт."],
        lambda: [f"Дом {v}-ти этажный, каркасно-монолитный."],
        lambda: [f"Этажность: {v} (без учёта подвала)"],
        lambda: [f"Надземная часть здания — {v} {et}, подземная — техподполье."],
        lambda: [f"Этажей надземных:    {v} ({_words(v)})"],
    ]
    multiline = [
        lambda: [
            rnd.choice(
                [
                    "Этажность (надземная)",
                    "Этажность, эт.",
                    "Количество этажей надземных",
                ]
            ),
            f"{v}",
        ],
        lambda: [
            f"Здание имеет {v} {_floors_adj(v).split()[0]}",
            f"{_floors_adj(v).split()[1]} и {rnd.choice(['один подземный', 'техническое подполье', 'подвал'])}.",
        ],
        lambda: [
            "| Наименование | Ед. изм. | Показатель |",
            f"| Площадь застройки | м² | {rnd.randint(600, 4000)},{rnd.randint(0, 9)} |",
            f"| {rnd.choice(['Этажность', 'Количество этажей надземных', 'Этажность здания'])} | "
            f"{rnd.choice(['этаж', 'эт.', 'шт.'])} | {v} |",
            f"| Строительный объём | м³ | {rnd.randint(20000, 150000)} |",
        ],
        lambda: [
            "Объёмно-планировочное решение:",
            f"{v} {et} над отметкой 0,000, кровля плоская.",
        ],
    ]
    pool = forms if compact else forms + multiline * 1
    return rnd.choice(pool)()


def _m007_trap(rnd: random.Random, v: int) -> tuple[str, list[str], int | None]:
    cls = rnd.choice(
        [
            "neighbor_building",
            "gpzu_limit",
            "total_with_underground",
            "underground_only",
            "floor_as_ordinal",
            "height_meters",
            "demolished_building",
            "elevator_stops",
            "mansard_plus",
            "cokol_rule",
            "sections_max",
            "revision_old_new",
        ]
    )
    with_true = rnd.random() < 0.5
    true = _m007_normal(rnd, v, compact=True)
    if cls == "neighbor_building":
        n = rnd.choice([x for x in range(2, 26) if x != v])
        c = [
            f"{rnd.choice(['Смежная застройка', 'С севера участок граничит с'])}: "
            f"существующий жилой дом, {n} эт."
        ]
    elif cls == "gpzu_limit":
        lim = rnd.choice([x for x in range(v + 1, v + 12)])
        c = [f"Предельное количество надземных этажей по ГПЗУ — не более {lim}"]
    elif cls == "total_with_underground":
        u = rnd.randint(1, 3)
        c = [f"Количество этажей — {v + u}, в том числе подземных — {u}"]
        return cls, c, v
    elif cls == "underground_only":
        u = rnd.randint(1, 3)
        c = [
            f"Подземная часть: {u} {_pl(u, 'этаж', 'этажа', 'этажей')} (автостоянка, техпомещения)"
        ]
    elif cls == "floor_as_ordinal":
        k = rnd.randint(2, 30)
        c = [
            f"Помещение {rnd.choice(['консьержа', 'ТСЖ', 'колясочной', 'офиса'])} "
            f"расположено на {k}-м этаже"
        ]
    elif cls == "height_meters":
        h = v * 3 + rnd.randint(2, 9)
        c = [
            f"Высота здания — {h},{rnd.randint(0, 99):02d} м",
            f"Отметка верха парапета +{h + 1},{rnd.randint(100, 999)}",
        ]
    elif cls == "demolished_building":
        n = rnd.randint(1, 5)
        c = [f"Сносимое строение: {n}-этажное нежилое здание (склад)"]
    elif cls == "elevator_stops":
        s = v + rnd.randint(1, 2)
        c = [
            f"Лифт грузоподъёмностью {rnd.choice([400, 630, 1000])} кг, {s} "
            f"{_pl(s, 'остановка', 'остановки', 'остановок')}"
        ]
    elif cls == "mansard_plus":
        c = [
            rnd.choice(
                [
                    f"Этажность: {v - 1} + мансардный этаж",
                    f"Надземных этажей — {v - 1}, кроме того мансардный этаж",
                ]
            )
        ]
        return cls, c, v
    elif cls == "cokol_rule":
        if rnd.random() < 0.5:
            c = [
                "Цокольный этаж заглублён более чем на половину высоты и относится к подземным.",
                f"Надземных этажей — {v}.",
            ]
        else:
            c = [
                f"Этажность: {v - 1} этажей + цокольный",
                "(цокольный этаж надземный, заглубление менее половины высоты помещений)",
            ]
        return cls, c, v
    elif cls == "sections_max":
        others = [rnd.randint(max(2, v - 8), v) for _ in range(rnd.randint(1, 3))]
        secs = others + [v]
        rnd.shuffle(secs)
        c = [
            "Здание переменной этажности:",
            "; ".join(f"секция {i + 1} — {s} эт." for i, s in enumerate(secs)),
        ]
        return cls, c, v
    else:  # revision_old_new
        old = rnd.choice([x for x in range(max(3, v - 5), v + 5) if x != v])
        c = [
            f"Изм. {rnd.randint(1, 4)}: этажность откорректирована по замечанию экспертизы",
            f"было — {old} эт.",
            f"стало — {v} эт.",
        ]
        return cls, c, v
    if with_true:
        c = c + true if rnd.random() < 0.5 else true + c
        return cls, c, v
    return cls, c, None


# ---------------------------------------------------------------- M-010 квартиры


def _kv_gen(n: int) -> str:  # родительный: «размещение 21 квартиры / 25 квартир»
    return "квартиры" if n % 10 == 1 and n % 100 != 11 else "квартир"


def _kv_acc(n: int) -> str:  # винительный: «на 21 квартиру / 22 квартиры / 25 квартир»
    return _pl(n, "квартиру", "квартиры", "квартир")


def _m010_normal(rnd: random.Random, v: int, compact: bool = False) -> list[str]:
    forms = [
        lambda: [f"| Количество квартир | шт. | {v} |"],
        lambda: [f"Общее количество квартир{_sep(rnd)}{v} шт."],
        lambda: [f"Проектом предусмотрено размещение {v} {_kv_gen(v)}."],
        lambda: [f"Количество квартир — {_words(v, fem=True)} ({v})"],
        lambda: [f"Кол-во кв.: {v}"],
        lambda: [f"Квартир всего{_sep(rnd)}{v} ед."],
        lambda: [f"Число квартир\t\t{v}"],
        lambda: [f"Итого квартир по дому – {v}"],
        lambda: [f"Многоквартирный жилой дом на {v} {_kv_acc(v)}"],
        lambda: [f"Квартиры (всего): {v} кв."],
        lambda: [
            f"Всего квартир в {rnd.choice(['доме', 'здании', 'жилом доме'])} — {v} шт., "
            f"распределение по секциям см. табл. {rnd.randint(1, 5)}.{rnd.randint(1, 9)}"
        ],
        lambda: [f"Количество квартир (общее)    {v}"],
    ]
    multiline = [
        lambda: [
            rnd.choice(
                ["Количество квартир, шт.", "Количество квартир всего", "Квартир, ед."]
            ),
            f"{v}",
        ],
        lambda: [
            f"Жилой дом рассчитан на {v}",
            f"{_kv_acc(v)} различной площади и планировки.",
        ],
        lambda: [
            "| Показатель | Ед. | Значение |",
            f"| Общая площадь здания | м² | {rnd.randint(8000, 60000)},{rnd.randint(0, 9)} |",
            f"| {rnd.choice(['Количество квартир', 'Кол-во квартир', 'Квартиры'])} | "
            f"{rnd.choice(['шт.', 'ед.', 'кв.'])} | {v} |",
            f"| Площадь квартир | м² | {rnd.randint(5000, 40000)},{rnd.randint(0, 9)} |",
        ],
    ]
    pool = forms if compact else forms + multiline
    return rnd.choice(pool)()


def _m010_trap(rnd: random.Random, v: int) -> tuple[str, list[str], int | None]:
    cls = rnd.choice(
        [
            "per_floor",
            "per_section_no_total",
            "sections_with_total",
            "residents",
            "parking_spaces",
            "nonresidential",
            "neighbor_building",
            "revision_old_new",
            "percent_share",
            "apartments_area",
            "storage_rooms",
            "design_limit",
        ]
    )
    with_true = rnd.random() < 0.5
    true = _m010_normal(rnd, v, compact=True)
    if cls == "per_floor":
        k = rnd.randint(4, 14)
        c = [
            f"На типовом этаже размещается {k} {_pl(k, 'квартира', 'квартиры', 'квартир')}"
        ]
    elif cls == "per_section_no_total":
        a, b = rnd.randint(30, 150), rnd.randint(30, 150)
        c = [
            "Здание состоит из трёх секций.",
            f"Секция 1 — {a} кв.; секция 2 — {b} кв.",
        ]
        return cls, c, None  # итога нет, секция 3 не указана — истины нет
    elif cls == "sections_with_total":
        k = rnd.randint(2, 4)
        cuts = sorted(rnd.sample(range(1, v), k - 1)) if v > k else list(range(1, k))
        parts = [b - a for a, b in zip([0] + cuts, cuts + [v])]
        c = [f"Секция {i + 1}{_sep(rnd)}{p} кв." for i, p in enumerate(parts)] + [
            f"Итого: {v}"
        ]
        return cls, c, v
    elif cls == "residents":
        p = v * rnd.randint(2, 3) + rnd.randint(0, 20)
        c = [f"Расчётная численность жителей — {p} чел."]
    elif cls == "parking_spaces":
        m = rnd.randint(40, 400)
        c = [f"Количество машино-мест в подземной автостоянке — {m}"]
    elif cls == "nonresidential":
        k = rnd.randint(2, 20)
        c = [f"Встроенные нежилые помещения (коммерческие) — {k} шт."]
    elif cls == "neighbor_building":
        k = rnd.choice([x for x in range(20, 400) if x != v])
        c = [
            f"Существующий жилой дом (поз. {rnd.randint(1, 9)} по ГП, сохраняемый) — {k} квартир"
        ]
    elif cls == "revision_old_new":
        old = rnd.choice([x for x in range(max(10, v - 30), v + 30) if x != v])
        c = ["Корректировка проекта: количество квартир", f"было {old}", f"стало {v}"]
        return cls, c, v
    elif cls == "percent_share":
        c = [
            f"Доля квартир-студий — {rnd.randint(10, 45)} %",
            f"Доля однокомнатных — {rnd.randint(15, 45)} %",
        ]
    elif cls == "apartments_area":
        c = [
            f"Общая площадь квартир — {rnd.randint(3000, 40000)},{rnd.randint(0, 99):02d} м²"
        ]
    elif cls == "storage_rooms":
        k = rnd.randint(20, 300)
        c = [f"Внеквартирные кладовые — {k} шт."]
    else:  # design_limit
        lim = v + rnd.randint(10, 100)
        c = [f"Количество квартир — не более {lim} (задание на проектирование)"]
    if with_true:
        c = c + true if rnd.random() < 0.5 else true + c
        return cls, c, v
    return cls, c, None


# ---------------------------------------------------------------- M-011 квартирография

_KEYS = ["студия", "1к", "E2", "2к", "3к", "4к+"]
_NAMES = {
    "студия": ["Студии", "Квартиры-студии", "Студия", "Ст.", "студии"],
    "1к": ["1-комнатные", "Однокомнатные", "1-комн.", "1К", "1-к"],
    "E2": ["Евродвушки", "2Е", "Евро-2", "2-комн. евро (2Е)", "евродвушка"],
    "2к": ["2-комнатные", "Двухкомнатные", "2-комн.", "2К"],
    "3к": ["3-комнатные", "Трёхкомнатные", "3-комн.", "3К"],
    "4к+": ["4-комнатные и более", "Четырёхкомнатные", "4-комн.", "4К+", "4+ комн."],
}
_SHORT = {
    "студия": ["Ст", "С"],
    "1к": ["1к", "1К"],
    "E2": ["2Е", "Е2"],
    "2к": ["2к", "2К"],
    "3к": ["3к", "3К"],
    "4к+": ["4к", "4+"],
}
# «число + тип» с согласованием: (одна, две-четыре, пять)
_AGREE = {
    "студия": ("студия", "студии", "студий"),
    "1к": ("однокомнатная квартира", "однокомнатные квартиры", "однокомнатных квартир"),
    "E2": ("евродвушка", "евродвушки", "евродвушек"),
    "2к": ("двухкомнатная квартира", "двухкомнатные квартиры", "двухкомнатных квартир"),
    "3к": ("трёхкомнатная квартира", "трёхкомнатные квартиры", "трёхкомнатных квартир"),
    "4к+": (
        "четырёхкомнатная квартира",
        "четырёхкомнатные квартиры",
        "четырёхкомнатных квартир",
    ),
}


def _comp(rnd: random.Random, max_types: int = 6) -> dict[str, int]:
    k = rnd.randint(2, max_types)
    chosen = set(rnd.sample(_KEYS, k))  # выборка один раз, порядок — канонический
    keys = [x for x in _KEYS if x in chosen]
    return {x: rnd.randint(2, 140) for x in keys}


def _total(c: dict[str, int]) -> int:
    return sum(c.values())


def _m011_lines(
    rnd: random.Random, c: dict[str, int], compact: bool = False
) -> list[str]:
    """Состав в одной из форм; compact — не более двух строк."""
    items = list(c.items())
    one_line = [
        lambda: [
            "Квартирография: "
            + ", ".join(
                f"{rnd.choice(_NAMES[k])}{rnd.choice([' – ', ' — ', ': ', ' '])}{n}"
                for k, n in items
            )
            + "."
        ],
        lambda: [
            "/".join(rnd.choice(_SHORT[k]) for k, _ in items),
            "/".join(str(n) for _, n in items),
        ],
        lambda: [
            "В составе дома "
            + ", ".join(f"{n} {_pl(n, *_AGREE[k])}" for k, n in items)
            + "."
        ],
        lambda: [
            "Состав квартир: "
            + "; ".join(f"{n} × {rnd.choice(_SHORT[k])}" for k, n in items)
        ],
    ]
    if compact:
        return rnd.choice(one_line)()
    unit = rnd.choice(["", " шт.", " кв.", " ед."])
    multi = [
        lambda: [f"{rnd.choice(_NAMES[k])}{_sep(rnd)}{n}{unit}" for k, n in items],
        lambda: (
            ["| Тип квартиры | Площадь, м² | Кол-во, шт. |"]
            + [
                f"| {rnd.choice(_NAMES[k])} | {rnd.randint(22, 130)},{rnd.randint(0, 9)} | {n} |"
                for k, n in items
            ]
        ),
        lambda: (
            ["Тип квартиры"]
            + [rnd.choice(_NAMES[k]) for k, _ in items]
            + ["Количество"]
            + [str(n) for _, n in items]
        ),
        lambda: (
            ["| в т.ч. по типам | | |"]
            + [
                f"| {rnd.choice(_NAMES[k])} | {rnd.choice(['шт.', 'кв.'])} | {n} |"
                for k, n in items
            ]
        ),
        lambda: (
            ["Тип\t\tКол-во"] + [f"{rnd.choice(_SHORT[k])}\t\t{n}" for k, n in items]
        ),
    ]
    lines = rnd.choice(one_line + multi)()
    if len(lines) <= 11 and rnd.random() < 0.4:
        lines = lines + [
            rnd.choice(
                [
                    f"Всего квартир {_total(c)}",
                    f"Итого квартир: {_total(c)}",
                    f"Всего — {_total(c)} кв.",
                ]
            )
        ]
    return lines


def _m011_trap(rnd: random.Random) -> tuple[str, list[str], dict | None]:
    cls = rnd.choice(
        [
            "per_floor",
            "percent_share",
            "areas_by_type",
            "neighbor_building",
            "revision_old_new",
            "section_only",
            "nonresidential_mixed",
            "design_norm",
            "four_plus_split",
            "living_rooms",
        ]
    )
    comp = _comp(rnd, max_types=4)
    with_true = rnd.random() < 0.5
    true = _m011_lines(rnd, comp, compact=True)
    if cls == "per_floor":
        fl = _comp(rnd, max_types=3)
        fl = {k: rnd.randint(1, 5) for k in fl}
        c = [
            "Квартирография типового этажа: "
            + ", ".join(f"{rnd.choice(_SHORT[k])} — {n}" for k, n in fl.items())
        ]
    elif cls == "percent_share":
        c = [
            "Структура квартирного фонда, %: "
            + ", ".join(
                f"{rnd.choice(_NAMES[k])} — {rnd.randint(5, 45)} %" for k in comp
            )
        ]
    elif cls == "areas_by_type":
        c = [
            f"{rnd.choice(_NAMES[k])} — от {rnd.randint(22, 60)},{rnd.randint(0, 9)} "
            f"до {rnd.randint(61, 130)},{rnd.randint(0, 9)} м²"
            for k in comp
        ]
    elif cls == "neighbor_building":
        other = _comp(rnd, max_types=3)
        c = [
            f"Существующий жилой дом (сохраняемый, поз. {rnd.randint(1, 9)}):",
            ", ".join(f"{rnd.choice(_NAMES[k])} — {n}" for k, n in other.items()),
        ]
    elif cls == "revision_old_new":
        old = {k: max(1, n + rnd.choice([-12, -6, -3, 4, 8])) for k, n in comp.items()}
        new_lines = _m011_lines(rnd, comp, compact=True)
        c = [
            "Было: "
            + ", ".join(f"{rnd.choice(_SHORT[k])} — {n}" for k, n in old.items())
        ]
        c += ["Стало (изм. " + str(rnd.randint(1, 3)) + "):"] + new_lines
        return cls, c, comp
    elif cls == "section_only":
        c = [
            "Жилой дом из трёх секций. Квартирография секции 2:",
            ", ".join(
                f"{rnd.choice(_NAMES[k])} — {n}" for k, n in _comp(rnd, 3).items()
            ),
        ]
        return cls, c, None
    elif cls == "nonresidential_mixed":
        c = [
            f"Нежилые помещения — {rnd.randint(2, 15)}",
            f"Кладовые — {rnd.randint(20, 200)}",
            f"Машино-места — {rnd.randint(30, 300)}",
        ]
    elif cls == "design_norm":
        c = [
            f"Доля однокомнатных квартир и студий — не менее {rnd.randint(20, 50)} % "
            "(задание на проектирование)"
        ]
    elif cls == "four_plus_split":
        a, b = rnd.randint(2, 20), rnd.randint(1, 8)
        base = {k: n for k, n in comp.items() if k != "4к+"}
        c = [f"{rnd.choice(_NAMES[k])} — {n}" for k, n in base.items()]
        c += [f"4-комнатные — {a}", f"5-комнатные — {b}"]
        full = dict(base)
        full["4к+"] = a + b
        return cls, c, {k: full[k] for k in _KEYS if k in full}
    else:  # living_rooms
        rooms = sum(
            n * {"студия": 1, "1к": 1, "E2": 2, "2к": 2, "3к": 3, "4к+": 4}[k]
            for k, n in comp.items()
        )
        c = [f"Количество жилых комнат — {rooms}"]
    if with_true:
        c = c + true if rnd.random() < 0.5 else true + c
        return cls, c, comp
    return cls, c, None


# ---------------------------------------------------------------- сборка


def samples(seed: int, n: int) -> list[dict]:
    rnd = random.Random(seed)
    out: list[dict] = []
    for _ in range(n):
        v = rnd.randint(3, 30)
        if rnd.random() < TRAP_SHARE:
            trap, content, value = _m007_trap(rnd, v)
        else:
            trap, content, value = "", _m007_normal(rnd, v), v
        out.append(
            {
                "code": "M-007",
                "lines": _page(rnd, content),
                "value": value,
                "composition": None,
                "trap": trap,
            }
        )
    for _ in range(n):
        v = rnd.randint(20, 900)
        if rnd.random() < TRAP_SHARE:
            trap, content, value = _m010_trap(rnd, v)
        else:
            trap, content, value = "", _m010_normal(rnd, v), v
        out.append(
            {
                "code": "M-010",
                "lines": _page(rnd, content),
                "value": value,
                "composition": None,
                "trap": trap,
            }
        )
    for _ in range(n):
        if rnd.random() < TRAP_SHARE:
            trap, content, comp = _m011_trap(rnd)
        else:
            comp = _comp(rnd)
            trap, content = "", _m011_lines(rnd, comp)
        out.append(
            {
                "code": "M-011",
                "lines": _page(rnd, content),
                "value": None,
                "composition": comp,
                "trap": trap,
            }
        )
    return out
