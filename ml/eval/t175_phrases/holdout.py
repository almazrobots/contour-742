"""T-175: отложенный (holdout) набор проверочных страниц для M-007 / M-010 / M-011.

Написан независимо от кода извлечения (без чтения регулярных выражений системы):
строки имитируют текстовый слой реальных листов ПЗ, АР, ТЭП, экспликаций и техпланов.
Все объекты, шифры и адреса вымышленные.

API:
    PARAMS = ["M-007", "M-010", "M-011"]
    samples(seed, n) -> list[dict]  # n страниц на каждый параметр, итого 3n

Элемент: {"code", "lines", "value", "composition", "trap"}.
"""

from __future__ import annotations

import random

PARAMS = ["M-007", "M-010", "M-011"]
TYPES = ["студия", "1к", "2к", "3к", "4к+"]

# ---------------------------------------------------------------- общий шум листа

_STREETS = [
    "Сиреневая",
    "Заречная",
    "Луговая",
    "Кленовая",
    "Строителей",
    "Озёрная",
    "Рябиновая",
    "Полевая",
    "Вишнёвая",
    "Солнечная",
]
_TOWNS = [
    "г. Новоозёрск",
    "г. Верхнеречинск",
    "пос. Сосновый Бор-2",
    "г. Краснолесье",
    "г. Малоярово-Северный",
    "г. Приречный",
]
_SECTIONS = [
    ("ПЗ", "Раздел 1. Пояснительная записка"),
    ("АР", "Раздел 3. Объемно-планировочные и архитектурные решения"),
    ("АР", "Раздел 3. Архитектурные решения"),
    ("ПЗУ", "Раздел 2. Схема планировочной организации земельного участка"),
    ("ТЭП", "Технико-экономические показатели"),
]


def _cipher(r: random.Random, part: str) -> str:
    return f"{r.randint(10, 99)}{r.choice(['', '/', '-'])}{r.randint(1, 30):02d}-{r.choice(['ЖД', 'ЖК', 'МКД', 'П'])}-{part}"


def _object_name(r: random.Random) -> str:
    kind = r.choice(
        [
            "Многоквартирный жилой дом",
            "Многоэтажный жилой дом со встроенными нежилыми помещениями",
            "Жилой дом поз. {p}",
            "Многоквартирный жилой дом с подземной автостоянкой",
            "Жилой комплекс. Корпус {p}",
        ]
    ).format(p=r.randint(1, 12))
    return f"{kind} по ул. {r.choice(_STREETS)}, {r.choice(_TOWNS)}"


def _num(r: random.Random, v: int) -> str:
    """Целое так, как оно встречается в текстовом слое (разряды пробелом/nbsp)."""
    if v >= 1000:
        sep = r.choice([" ", " ", "", " "])
        return f"{v // 1000}{sep}{v % 1000:03d}"
    return str(v)


def _dec(r: random.Random, lo: float, hi: float, nd: int = 1) -> str:
    x = round(r.uniform(lo, hi), nd)
    s = f"{x:.{nd}f}"
    ip, fp = s.split(".")
    if len(ip) > 3 and r.random() < 0.7:
        ip = f"{ip[:-3]} {ip[-3:]}"
    return f"{ip},{fp}" if r.random() < 0.9 else f"{ip}.{fp}"


def _m2(r: random.Random) -> str:
    return r.choice(["м2", "м²", "кв.м", "м 2", "кв. м"])


def _mess(r: random.Random, line: str) -> str:
    """Типичный мусор текстового слоя: двойные пробелы, хвостовые пробелы."""
    if r.random() < 0.25:
        line = line.replace(" ", "  ", 1)
    if r.random() < 0.15:
        line = line + " "
    if r.random() < 0.1:
        line = "  " + line
    return line


def _header(r: random.Random) -> list[str]:
    part, title = r.choice(_SECTIONS)
    out = []
    if r.random() < 0.6:
        out.append(_cipher(r, part))
    out.append(title)
    if r.random() < 0.5:
        out.append(_object_name(r))
    return out


def _stamp(r: random.Random) -> list[str]:
    pool = [
        "Изм. Кол.уч. Лист №док. Подп. Дата",
        "Изм.  Кол.уч  Лист  № док.  Подпись  Дата",
        f"Лист\n{r.randint(2, 60)}".split("\n")[0],
        str(r.randint(2, 80)),
        "Инв. № подл.   Подп. и дата   Взам. инв. №",
        "Разраб.  ГИП  Н. контр.",
        "Стадия  Лист  Листов",
        f"П  {r.randint(1, 40)}  {r.randint(40, 90)}",
        "Формат А4",
        "Согласовано:",
        _cipher(r, r.choice(["ПЗ", "АР", "ТЭП"])),
    ]
    return r.sample(pool, r.randint(1, 3))


def _generic_tep(r: random.Random) -> list[str]:
    m2 = _m2(r)
    pool = [
        f"Площадь земельного участка — {_dec(r, 3000, 25000)} {m2}",
        f"Площадь застройки: {_dec(r, 600, 3500)} {m2}",
        f"Строительный объем — {_num(r, r.randint(18000, 120000))} м3",
        f"в т.ч. ниже отм. 0,000 — {_num(r, r.randint(2000, 15000))} м3",
        f"Общая площадь здания  {_dec(r, 6000, 40000)}  {m2}",
        f"Площадь квартир (без учета летних помещений) — {_dec(r, 4000, 25000)} {m2}",
        f"Высота здания — {_dec(r, 20, 90, 2)} м",
        "Уровень ответственности — нормальный",
        "Степень огнестойкости — II",
        "Класс конструктивной пожарной опасности — С0",
        "Класс функциональной пожарной опасности — Ф1.3",
        f"Класс энергетической эффективности — {r.choice(['A', 'A+', 'B', 'B+', 'C'])}",
        f"Площадь встроенных нежилых помещений — {_dec(r, 100, 900)} {m2}",
        f"Коэффициент застройки — 0,{r.randint(12, 45)}",
        "Сейсмичность площадки — 6 баллов",
        "Снеговой район — III, ветровой район — II",
        "Температура наружного воздуха наиболее холодной пятидневки минус 31 °С",
    ]
    return r.sample(pool, r.randint(1, 4))


def _tep_row(r: random.Random, no: int, name: str, unit: str, value: str) -> list[str]:
    """Строка ТЭП «№ | наименование | ед.изм. | значение» в разных видах текстового слоя."""
    style = r.randint(0, 4)
    if style == 0:
        return [f"{no} {name} {unit} {value}"]
    if style == 1:
        return [f"{no}.  {name}  {unit}  {value}"]
    if style == 2:
        return [f"{no} | {name} | {unit} | {value}"]
    if style == 3:  # табличный разрыв: ячейки отдельными строками
        return [f"{no}", name, unit, value]
    return [f"{no} {name},", f"{unit}  {value}"]


def _assemble(r: random.Random, core: list[str], extra: list[str] | None = None) -> list[str]:
    """Собирает страницу 5–15 строк: шапка, окружение, ядро, штамп (ядро не трогается)."""
    head = [(ln, False) for ln in _header(r)]
    ctx = [(ln, False) for ln in _generic_tep(r) + list(extra or [])]
    r.shuffle(ctx)
    k = r.randint(0, len(ctx))
    body = ctx[:k] + [(ln, True) for ln in core] + ctx[k:]
    lines = head + body + [(ln, False) for ln in _stamp(r)]
    while len(lines) < 5:
        lines.insert(len(head), (r.choice(_generic_tep(r)), False))
    while len(lines) > 15:
        idx = [i for i, (_, is_core) in enumerate(lines) if not is_core]
        if not idx:
            break
        del lines[r.choice(idx)]
    return [ln if is_core else _mess(r, ln) for ln, is_core in lines]


def _mk(
    code: str, lines: list[str], value=None, composition=None, trap: str = ""
) -> dict:
    return {
        "code": code,
        "lines": lines,
        "value": value,
        "composition": composition,
        "trap": trap,
    }


# ---------------------------------------------------------------- M-007 этажность


def _floors_word(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return "этаж"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "этажа"
    return "этажей"


def _cross_m007(r: random.Random) -> list[str]:
    q = r.randint(40, 520)
    return r.sample(
        [
            f"Количество квартир — {q} шт.",
            f"Общее количество квартир: {q}",
            f"Количество секций — {r.randint(1, 5)}",
        ],
        r.randint(0, 1),
    )


def _m007_pos(r: random.Random) -> dict:
    v = r.randint(3, 32)
    kind = r.randint(0, 11)
    if kind == 0:
        core = [f"Этажность — {v} {_floors_word(v)}"]
    elif kind == 1:
        core = [f"Этажность здания: {v} эт."]
    elif kind == 2:
        core = _tep_row(
            r, r.randint(3, 9), "Этажность", r.choice(["эт.", "этаж", "эт"]), str(v)
        )
    elif kind == 3:
        core = [f"Количество надземных этажей — {v}"]
    elif kind == 4:
        core = [
            f"Проектируемое здание {v}-этажное, {r.choice(['односекционное', 'двухсекционное', 'трехсекционное'])},",
            "с подвалом и техническим чердаком.",
        ]
        return _mk(
            "M-007", _assemble(r, core, _cross_m007(r)), v, None, "incl_basement_text"
        )
    elif kind == 5:
        core = [
            f"Жилой дом {v}-ти этажный, прямоугольной в плане формы,",
            f"размерами в осях {_dec(r, 14, 18, 2)} х {_dec(r, 30, 80, 2)} м.",
        ]
    elif kind == 6:
        core = [f"Этажность  {v}"]
    elif kind == 7:
        core = [f"Число этажей надземной части — {v}"]
    elif kind == 8:
        core = ["Этажность (надземная)", f"{v} эт."]
    elif kind == 9:
        core = [
            f"Здание запроектировано этажностью {v} {_floors_word(v)} с техническим этажом".replace(
                " с техническим этажом", r.choice(["", " с техническим этажом"])
            )
        ]
    elif kind == 10:
        core = _tep_row(
            r, r.randint(2, 6), "Количество этажей надземных", "шт.", str(v)
        )
    else:
        core = [f"Этажность здания - {v} надземных {_floors_word(v)}"]
    return _mk("M-007", _assemble(r, core, _cross_m007(r)), v, None, "")


def _m007_trap(r: random.Random) -> dict:
    v = r.randint(4, 30)
    u = r.randint(1, 3)
    kind = r.randint(0, 11)
    if kind == 0:  # количество этажей с подземными + надземная отдельно
        core = [
            f"Количество этажей — {v + u}, в том числе:",
            f"надземных — {v}",
            f"подземных — {u}",
        ]
        if r.random() < 0.5:
            core[1], core[2] = core[2], core[1]
        return _mk("M-007", _assemble(r, core), v, None, "underground_floors")
    if kind == 1:  # только подземные
        core = [f"Количество подземных этажей — {u}"]
        return _mk(
            "M-007",
            _assemble(r, core, _cross_m007(r)),
            None,
            None,
            "underground_floors",
        )
    if kind == 2:  # количество этажей с подвалом, надземных в тексте нет
        core = [f"Количество этажей (в т.ч. подвал) — {v + 1}", f"Этажность — {v}"]
        r.shuffle(core)
        return _mk("M-007", _assemble(r, core), v, None, "underground_floors")
    if kind == 3:  # предельная этажность по ГПЗУ, без фактической
        lim = r.choice([9, 12, 16, 17, 20, 25])
        core = [
            r.choice(
                [
                    f"Предельное количество этажей — не более {lim}",
                    f"Максимальная этажность согласно ГПЗУ № RU{r.randint(10000, 99999)}-{r.randint(100, 999)}: {lim} эт.",
                    f"Предельная этажность застройки — {lim} {_floors_word(lim)} (Правила землепользования и застройки)",
                ]
            )
        ]
        return _mk("M-007", _assemble(r, core), None, None, "norm_limit")
    if kind == 4:  # предельная + фактическая
        lim = v + r.randint(1, 8)
        core = [
            f"Предельное количество этажей по ГПЗУ — {lim}",
            f"Этажность проектируемого здания — {v}",
        ]
        return _mk("M-007", _assemble(r, core), v, None, "norm_limit")
    if kind == 5:  # существующее/соседнее здание
        e = r.randint(2, 16)
        core = [
            r.choice(
                [
                    f"На участке расположено существующее {e}-этажное здание, подлежащее сносу.",
                    f"С севера участок граничит с {e}-этажным жилым домом по ул. {r.choice(_STREETS)}.",
                    f"Соседняя застройка — жилые дома этажностью {e}–{e + 4} этажей.",
                ]
            )
        ]
        return _mk("M-007", _assemble(r, core), None, None, "existing_building")
    if kind == 6:  # соседнее + проектируемое
        e = r.randint(2, 9)
        core = [
            f"Существующая застройка — {e}-этажные жилые дома.",
            f"Этажность проектируемого жилого дома — {v} эт.",
        ]
        return _mk("M-007", _assemble(r, core), v, None, "existing_building")
    if kind == 7:  # номер этажа
        f = r.randint(1, 5)
        core = [
            f"На 1 этаже размещены входные группы, помещение консьержа и колясочная.",
            f"На {f}-м этаже расположены офисные помещения.",
            "Выше расположены жилые квартиры.",
        ]
        val = None
        return _mk("M-007", _assemble(r, core), val, None, "floor_number")
    if kind == 8:  # высота этажа
        core = [
            f"Высота этажа — {_dec(r, 2.8, 3.3, 2)} м",
            f"Высота первого этажа — {_dec(r, 3.3, 4.5, 2)} м",
        ]
        return _mk(
            "M-007", _assemble(r, core, _cross_m007(r)), None, None, "floor_height"
        )
    if kind == 9:  # секции разной этажности без общего значения
        a, b = sorted(r.sample(range(5, 26), 2))
        core = [f"Секция 1 — {a} эт.", f"Секция 2 — {b} эт."]
        if r.random() < 0.5:
            core.append(f"Секция 3 — {r.randint(a, b)} эт.")
        return _mk("M-007", _assemble(r, core), None, None, "sections")
    if kind == 10:  # секции + явное значение для здания
        a = r.randint(5, v - 1) if v > 5 else 3
        core = [
            f"Этажность — {a}–{v} эт.",
            f"Секции 1, 2 — {a} этажей, секция 3 — {v} этажей",
            f"Этажность здания (по наиболее высокой секции) — {v}",
        ]
        return _mk("M-007", _assemble(r, core), v, None, "sections")
    # техподполье/чердак рядом
    core = [f"Этажность — {v} эт. + техподполье + теплый чердак"]
    return _mk("M-007", _assemble(r, core), v, None, "underground_floors")


# ---------------------------------------------------------------- M-010 количество квартир


def _cross_m010(r: random.Random) -> list[str]:
    f = r.randint(5, 25)
    return r.sample(
        [f"Этажность — {f} эт.", f"Количество секций — {r.randint(1, 4)}"],
        r.randint(0, 1),
    )


def _m010_pos(r: random.Random) -> dict:
    v = r.choice([r.randint(12, 120), r.randint(120, 480), r.randint(480, 1200)])
    kind = r.randint(0, 10)
    if kind == 0:
        core = [f"Количество квартир — {_num(r, v)} шт."]
    elif kind == 1:
        core = [f"Общее количество квартир: {_num(r, v)}"]
    elif kind == 2:
        core = _tep_row(
            r,
            r.randint(5, 12),
            "Количество квартир",
            r.choice(["шт.", "шт", "кв."]),
            _num(r, v),
        )
    elif kind == 3:
        core = [
            f"В жилом доме запроектировано {_num(r, v)} {'квартира' if v % 10 == 1 and v % 100 != 11 else 'квартир' if not 2 <= v % 10 <= 4 or 12 <= v % 100 <= 14 else 'квартиры'}."
        ]
    elif kind == 4:  # итог с разбивкой
        parts = _split(r, v)
        core = [f"Всего квартир – {_num(r, v)}, в т.ч.:"] + [
            f"{lab} – {c} шт."
            for lab, c in zip(
                ["студии", "однокомнатные", "двухкомнатные", "трехкомнатные"], parts
            )
            if c
        ]
    elif kind == 5:
        core = ["Кол-во квартир, шт", _num(r, v)]
    elif kind == 6:
        core = [f"Квартир всего: {_num(r, v)} кв."]
    elif kind == 7:
        core = [
            f"Количество квартир / общая площадь квартир — {_num(r, v)} шт. / {_dec(r, 3000, 30000)} {_m2(r)}"
        ]
    elif kind == 8:
        core = [f"Итого квартир {_num(r, v)}"]
    elif kind == 9:
        core = ["Количество квартир", "шт.", _num(r, v)]
    else:
        core = [
            f"Жилая часть здания включает {_num(r, v)} квартир различной планировки."
        ]
    return _mk("M-010", _assemble(r, core, _cross_m010(r)), v, None, "")


def _split(r: random.Random, total: int) -> list[int]:
    cuts = sorted(r.sample(range(1, total), 3)) if total > 4 else [1, 2, 3]
    return [cuts[0], cuts[1] - cuts[0], cuts[2] - cuts[1], total - cuts[2]]


def _m010_trap(r: random.Random) -> dict:
    v = r.randint(40, 400)
    kind = r.randint(0, 9)
    if kind == 0:  # по типам без итога
        a, b, c = r.randint(10, 90), r.randint(10, 90), r.randint(5, 40)
        core = [
            f"Количество однокомнатных квартир — {a} шт.",
            f"Количество 2-комн. квартир — {b} шт.",
            f"Количество трехкомнатных квартир — {c} шт.",
        ]
        if r.random() < 0.5:
            core.insert(0, f"Количество квартир-студий — {r.randint(5, 60)} шт.")
        return _mk("M-010", _assemble(r, core), None, None, "by_room_type")
    if kind == 1:  # жилые комнаты
        core = [f"Количество жилых комнат — {r.randint(100, 900)}"]
        return _mk(
            "M-010", _assemble(r, core, _cross_m010(r)), None, None, "room_count"
        )
    if kind == 2:  # сносимый дом
        e = r.randint(8, 60)
        core = [
            f"Существующий жилой дом ({e} квартир) подлежит сносу, жильцы переселяются."
        ]
        return _mk("M-010", _assemble(r, core), None, None, "existing_building")
    if kind == 3:  # сносимый + проектируемый
        e = r.randint(8, 60)
        core = [
            f"В сносимом доме — {e} кв.",
            f"Количество квартир в проектируемом доме — {v} шт.",
        ]
        return _mk("M-010", _assemble(r, core), v, None, "existing_building")
    if kind == 4:  # машино-места / кладовые / нежилые
        core = r.sample(
            [
                f"Количество машино-мест — {r.randint(20, 300)}",
                f"Количество кладовых — {r.randint(20, 200)} шт.",
                f"Количество встроенных нежилых помещений — {r.randint(2, 12)}",
                f"Количество мест хранения велосипедов — {r.randint(10, 80)}",
            ],
            2,
        )
        return _mk(
            "M-010", _assemble(r, core, _cross_m010(r)), None, None, "other_indicator"
        )
    if kind == 5:  # то же, но с итогом квартир
        core = [
            f"Количество машино-мест — {r.randint(20, 300)}",
            f"Количество квартир — {v}",
            f"Количество кладовых — {r.randint(20, 200)} шт.",
        ]
        r.shuffle(core)
        return _mk("M-010", _assemble(r, core), v, None, "other_indicator")
    if kind == 6:  # площадь квартир
        core = [
            f"Площадь квартир — {_dec(r, 3000, 25000)} {_m2(r)}",
            f"Общая площадь квартир (с учетом летних помещений) — {_dec(r, 3200, 26000)} {_m2(r)}",
        ]
        return _mk("M-010", _assemble(r, core), None, None, "area_not_count")
    if kind == 7:  # площадь + количество
        core = [
            f"Площадь квартир — {_dec(r, 3000, 25000)} {_m2(r)}",
            f"Количество квартир — {v} шт.",
        ]
        return _mk("M-010", _assemble(r, core), v, None, "area_not_count")
    if kind == 8:  # на этаже / в секции
        core = [
            f"На типовом этаже расположено {r.randint(4, 12)} квартир.",
            f"В секции 1 — {r.randint(30, 120)} квартир.",
        ]
        return _mk("M-010", _assemble(r, core), None, None, "per_floor")
    # строка таблицы по типу, без итога
    core = _tep_row(
        r, r.randint(1, 5), "Однокомнатные квартиры", "шт.", str(r.randint(10, 90))
    )
    return _mk("M-010", _assemble(r, core), None, None, "table_row")


# ---------------------------------------------------------------- M-011 квартирография

_LABELS = {
    "студия": [
        ("студии", "студий"),
        ("квартиры-студии", "квартир-студий"),
        ("студия", "студий"),
        ("Ст", "Ст"),
    ],
    "1к": [
        ("однокомнатные", "однокомнатных"),
        ("1-комн.", "1-комн."),
        ("1к", "1к"),
        ("1-комнатные", "1-комнатных"),
    ],
    "2к": [
        ("двухкомнатные", "двухкомнатных"),
        ("2-комн.", "2-комн."),
        ("2к", "2к"),
        ("2-комнатные", "2-комнатных"),
    ],
    "3к": [
        ("трехкомнатные", "трехкомнатных"),
        ("3-комн.", "3-комн."),
        ("3к", "3к"),
        ("3-комнатные", "3-комнатных"),
    ],
    "4к+": [
        ("четырехкомнатные", "четырехкомнатных"),
        ("4-комн.", "4-комн."),
        ("4к", "4к"),
        ("4-комнатные", "4-комнатных"),
    ],
}


def _composition(r: random.Random) -> dict:
    comp = {t: 0 for t in TYPES}
    present = [
        t
        for t in TYPES
        if r.random()
        < {"студия": 0.6, "1к": 0.95, "2к": 0.95, "3к": 0.8, "4к+": 0.35}[t]
    ]
    if not present:
        present = ["1к", "2к"]
    for t in present:
        comp[t] = r.randint(2, 160) if t != "4к+" else r.randint(1, 24)
    return comp


def _m011_pos(r: random.Random) -> dict:
    comp = _composition(r)
    style = r.randint(0, 3)  # 0 полные слова, 1 «1-комн.», 2 «1к», 3 «1-комнатные»
    labs = {t: _LABELS[t][style] for t in TYPES}
    items = [(t, comp[t]) for t in TYPES if comp[t]]
    total = sum(comp.values())
    kind = r.randint(0, 7)
    trap = ""
    if kind == 0:  # текстом в одну-две строки
        s = ", ".join(f"{labs[t][0]} — {c} шт." for t, c in items)
        core = (
            ["Квартирография:", s[0].upper() + s[1:]]
            if len(s) < 90
            else ["Состав квартир:"] + [f"{labs[t][0]} — {c} шт.;" for t, c in items]
        )
    elif kind == 1:  # таблица
        core = (
            ["Тип квартиры  Кол-во, шт."]
            + [f"{labs[t][0].capitalize()}  {c}" for t, c in items]
            + [f"Итого  {total}"]
        )
    elif kind == 2:  # «40 однокомнатных квартир»
        core = ["В доме запроектированы:"] + [
            (
                f"{c} {r.choice(['студий', 'квартир-студий'])}"
                if t == "студия"
                else f"{c} {labs[t][1]} квартир"
            )
            for t, c in items
        ]
    elif kind == 3:  # таблица с площадями и количеством
        core = ["Тип | Площадь, м2 | Кол-во"] + [
            f"{labs[t][0]} | {_dec(r, 24, 30) if t == 'студия' else _dec(r, 30 + 15 * TYPES.index(t), 40 + 18 * TYPES.index(t))} | {c}"
            for t, c in items
        ]
        trap = "area_and_count"
    elif kind == 4:  # ТЭП, строки «в т.ч.»
        core = [f"Количество квартир — {total} шт., в том числе:"] + [
            f"- {labs[t][0]} — {c} шт." for t, c in items
        ]
    elif kind == 5:  # 4к и 5к раздельно → 4к+
        if comp["4к+"] < 2:
            comp["4к+"] = r.randint(2, 20)
            items = [(t, comp[t]) for t in TYPES if comp[t]]
        c4 = r.randint(1, comp["4к+"] - 1)
        core = [f"{labs[t][0]}: {c} кв." for t, c in items if t != "4к+"] + [
            f"четырехкомнатные: {c4} кв.",
            f"пятикомнатные: {comp['4к+'] - c4} кв.",
        ]
        trap = "4plus_merge"
    elif kind == 6:  # табличный разрыв: тип и число на разных строках
        core = ["Квартирография"]
        for t, c in items:
            core += [labs[t][0], str(c)]
        core = core[:15]
        if len(core) - 1 < 2 * len(items):  # не влезло — переходим на компактную запись
            core = ["Квартирография"] + [f"{labs[t][0]} {c}" for t, c in items]
    else:  # «Ст/1к/2к…» слэшем
        core = [
            "Квартирография (" + "/".join(labs[t][0] for t, _ in items) + "):",
            " / ".join(str(c) for _, c in items) + " шт.",
        ]
        trap = "slash_row"
    return _mk("M-011", _assemble(r, core), None, comp, trap)


def _m011_trap(r: random.Random) -> dict:
    kind = r.randint(0, 5)
    if kind == 0:  # площади типов
        core = [
            f"Площадь однокомнатных квартир — {_dec(r, 33, 38)}–{_dec(r, 39, 45)} {_m2(r)}",
            f"Площадь двухкомнатных квартир — {_dec(r, 52, 58)}–{_dec(r, 59, 68)} {_m2(r)}",
            f"Площадь трехкомнатных квартир — {_dec(r, 72, 80)}–{_dec(r, 81, 95)} {_m2(r)}",
        ]
        return _mk("M-011", _assemble(r, core), None, None, "area_not_count")
    if kind == 1:  # средняя площадь
        core = [
            f"Средняя площадь квартиры — {_dec(r, 38, 62)} {_m2(r)}",
            f"Средняя площадь 1-комн. кв. — {_dec(r, 34, 42)} {_m2(r)}",
            f"Средняя площадь 2-комн. кв. — {_dec(r, 52, 64)} {_m2(r)}",
        ]
        return _mk("M-011", _assemble(r, core), None, None, "average_area")
    if kind == 2:  # доли в процентах
        p = _split(r, 100)
        core = [
            "Структура квартирного фонда, %:",
            f"студии — {p[0]} %",
            f"1-комн. — {p[1]} %",
            f"2-комн. — {p[2]} %",
            f"3-комн. — {p[3]} %",
        ]
        return _mk("M-011", _assemble(r, core), None, None, "percent_share")
    if kind == 3:  # только общий итог
        core = [f"Количество квартир — {r.randint(40, 500)} шт."]
        return _mk("M-011", _assemble(r, core), None, None, "total_only")
    if kind == 4:  # таблица площадей типовых планировок (дроби)
        core = ["Тип  Общая  Жилая  Кухня"] + [
            f"{lab}  {_dec(r, lo, lo + 10)}  {_dec(r, lo * 0.45, lo * 0.55)}  {_dec(r, 8, 14)}"
            for lab, lo in [("1-комн.", 35), ("2-комн.", 54), ("3-комн.", 76)]
        ]
        return _mk("M-011", _assemble(r, core), None, None, "area_not_count")
    # существующий дом
    core = [
        f"В сносимом доме: однокомнатных — {r.randint(4, 20)}, двухкомнатных — {r.randint(4, 20)} кв."
    ]
    return _mk("M-011", _assemble(r, core), None, None, "existing_building")


# ---------------------------------------------------------------- API

_GEN = {
    "M-007": (_m007_pos, _m007_trap),
    "M-010": (_m010_pos, _m010_trap),
    "M-011": (_m011_pos, _m011_trap),
}


def samples(seed: int, n: int) -> list[dict]:
    """n страниц на КАЖДЫЙ параметр (итого 3n), детерминированно по seed (random.Random(seed))."""
    r = random.Random(seed)
    out: list[dict] = []
    for code in PARAMS:
        pos, trap = _GEN[code]
        n_pos = round(n * 0.55)
        kinds = [True] * n_pos + [False] * (n - n_pos)
        r.shuffle(kinds)
        for is_pos in kinds:
            out.append(pos(r) if is_pos else trap(r))
    return out
