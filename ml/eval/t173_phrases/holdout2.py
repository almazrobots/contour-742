"""HOLDOUT-2: независимый отложенный генератор синтетических страниц для оценки
извлечения числовых показателей здания (T-173).

Написан без знания устройства экстрактора и прежних наборов. Страница — это
текстовый слой PDF: список строк в порядке чтения (строка таблицы — одна строка,
ячейки через пробелы, шапки отдельными строками, переносы ячеек, значение под
подписью, штамп и шифр). Все объекты, шифры, организации, фамилии и числа
вымышлены; реальных документов и корпуса здесь нет.

Около четверти страниц проходят через «шум распознавания» другого OCR
(слитные слова, число прилипло к единице, лишние переносы, неравномерные
пробелы в разрядах, латиница вместо кириллицы) — суффикс «+ocr» в cls.
Шум никогда не трогает цифры и знак числа, только пробелы, буквы и индексы.

Только стандартная библиотека, детерминизм по seed.
"""

from __future__ import annotations

import copy
import random
import re

PARAMS = [
    "M-001",
    "M-004",
    "M-005",
    "M-006",
    "M-008",
    "M-009",
    "M-013",
    "M-019",
    "M-020",
    "M-132",
]

NBSP = " "
THIN = " "
SEPS = (" ", " ", NBSP, "", THIN)
DPS = (",", ",", ",", ".")
MINUSES = ("-", "-", "−", "–")
U_AREA = ("м²", "м²", "м2", "кв. м", "кв.м")
U_VOL = ("м³", "м³", "м3", "куб. м", "куб.м")

SURN = [
    "Ветлугин",
    "Самохвалова",
    "Кречетов",
    "Озерская",
    "Туманов",
    "Липатникова",
    "Ярцев",
    "Бельская",
    "Гордеев",
    "Мирошина",
    "Кустов",
    "Лаптева",
]
ORGS = [
    "ООО «Проектная мастерская Ортогон»",
    "ООО «ПБ Лиственница»",
    "АО «Заречгражданпроект»",
    "ООО «Архитектурное бюро Северный склон»",
    "ООО «Инженерный центр Контур-7»",
]
PLACES = [
    "г. Заречинск, ул. Луговая, д. 14",
    "г. Светлоярск, мкр. Солнечный-4",
    "пос. Тихие Ключи, ул. Школьная",
    "г. Кедровогорск, квартал 12",
    "с. Каменка Ольховского района",
    "г. Новоборск, пр. Строителей, уч. 7",
]
# вид объекта, названия показателя мощности, единица, диапазон, шаг
KINDS = [
    (
        "Общеобразовательная школа",
        ("Вместимость", "Проектная вместимость", "Мощность"),
        "учащихся",
        (400, 1600),
        25,
    ),
    (
        "Дошкольная образовательная организация",
        ("Вместимость", "Количество мест"),
        "мест",
        (100, 350),
        5,
    ),
    (
        "Корпус стационара",
        ("Коечный фонд", "Мощность стационара"),
        "коек",
        (60, 420),
        1,
    ),
    (
        "Поликлиника",
        ("Мощность", "Пропускная способность"),
        "посещений в смену",
        (200, 1200),
        10,
    ),
    (
        "Физкультурно-оздоровительный комплекс",
        ("Единовременная пропускная способность", "Вместимость"),
        "чел. в смену",
        (60, 400),
        1,
    ),
    (
        "Производственный корпус",
        ("Производственная мощность", "Мощность предприятия"),
        "т/год",
        (4000, 60000),
        100,
    ),
    ("Многоквартирный жилой дом", None, None, None, None),
    ("Административно-бытовой корпус", None, None, None, None),
]
TEP_TITLES = [
    "Технико-экономические показатели",
    "ТЕХНИКО-ЭКОНОМИЧЕСКИЕ ПОКАЗАТЕЛИ",
    "Основные технико-экономические показатели",
    "Таблица 1 — Технико-экономические показатели объекта",
]
NOTES = [
    "Площадь застройки определена по внешнему контуру наружных стен на уровне цоколя.",
    "Строительный объём определён согласно приложению Г СП 118.13330.2022.",
    "Общая площадь здания подсчитана в пределах внутренних поверхностей наружных стен.",
    "Показатели уточняются на стадии рабочей документации.",
    "Этажность принята без учёта подземного этажа.",
]
CHAPTERS = [
    (1, "Подготовка территории строительства", "s"),
    (2, "Основные объекты строительства", "smo"),
    (4, "Объекты энергетического хозяйства", "smo"),
    (
        6,
        "Наружные сети и сооружения водоснабжения, водоотведения, теплоснабжения и газоснабжения",
        "sm",
    ),
    (7, "Благоустройство и озеленение территории", "s"),
    (8, "Временные здания и сооружения", "s"),
    (9, "Прочие работы и затраты", "p"),
    (10, "Содержание службы заказчика. Строительный контроль", "p"),
    (12, "Проектные и изыскательские работы", "p"),
]


# ---------------------------------------------------------------- утилиты


def T(value=None, depth=None, variant=None, limit=None):
    """Истина страницы в канонических единицах."""

    def f(x):
        return None if x is None else round(float(x), 6)

    return {"value": f(value), "depth": f(depth), "variant": variant, "limit": f(limit)}


def _fnum(x, dec, sep, dp, sign=False, minus="-"):
    s = f"{abs(x):.{dec}f}"
    ip, _, fp = s.partition(".")
    if sep and len(ip) > 3:
        g = []
        while len(ip) > 3:
            g.append(ip[-3:])
            ip = ip[:-3]
        g.append(ip)
        ip = sep.join(reversed(g))
    out = ip + (dp + fp if fp else "")
    if float(s) == 0:
        return out
    if x < 0:
        return minus + out
    return "+" + out if sign else out


def _j(*xs):
    return " ".join(str(x) for x in xs if x not in (None, ""))


def _split(total, w):
    """Целое total на части пропорционально весам, сумма точная."""
    s = sum(w)
    parts = [int(total * x / s) for x in w[:-1]]
    parts.append(total - sum(parts))
    return parts


def _wrap(r, text, lo=50, hi=88):
    """Перенос абзаца по строкам текстового слоя; число с пробелами в разрядах не рвём."""
    chunks = []
    for t in text.split(" "):
        if chunks and chunks[-1] and t and chunks[-1][-1].isdigit() and t[0].isdigit():
            chunks[-1] += " " + t
        else:
            chunks.append(t)
    lines, cur, width = [], "", r.randint(lo, hi)
    for ch in chunks:
        if cur and len(cur) + 1 + len(ch) > width:
            lines.append(cur)
            cur, width = ch, r.randint(lo, hi)
        else:
            cur = ch if not cur else cur + " " + ch
    if cur:
        lines.append(cur)
    return lines


class Pg:
    """Страница: свой генератор и свой стиль чисел (разделитель разрядов, дробная часть, минус)."""

    def __init__(self, seed, stage):
        r = random.Random(seed)
        self.r = r
        self.sr = random.Random(seed * 7 + 3)  # отдельный поток для перестановки строк
        self.stage = stage
        self.shuffle = False
        self.alt = r.random() < 0.35  # альтернативная единица (мм, коэффициент, ...)
        self.sep = r.choice(SEPS)
        self.dp = r.choice(DPS)
        self.minus = r.choice(MINUSES)
        self.ua = r.choice(U_AREA)
        self.uv = r.choice(U_VOL)

    def n(self, x, dec, sign=False, trim=False):
        s = _fnum(x, dec, self.sep, self.dp, sign, self.minus)
        if trim and dec > 0:
            s = s.rstrip("0").rstrip(self.dp)
        return s

    def nm(self, x, dec, sign=False):
        """Число для строки с несколькими числами: целые с обычным пробелом неразличимы — берём NBSP."""
        s = self.n(x, dec, sign)
        if dec == 0 and self.sep == " ":
            s = s.replace(" ", NBSP)
        return s

    def z0(self):
        return "0" + self.dp + "000"

    def zero(self):
        return self.r.choice([self.z0(), "±" + self.z0()])

    def rows(self, rows):
        rows = list(rows)
        if self.shuffle and len(rows) > 1:
            orig = list(rows)
            for _ in range(10):
                self.sr.shuffle(rows)
                if rows != orig:
                    break
        return rows


def _restyle(c, r):
    combos = [
        (s, d)
        for s in (" ", NBSP, "", THIN)
        for d in (",", ".")
        if (s, d) != (c.sep, c.dp)
    ]
    c.sep, c.dp = r.choice(combos)
    c.ua = r.choice([u for u in U_AREA if u != c.ua])
    c.uv = r.choice([u for u in U_VOL if u != c.uv])


def _stamp(c, b, part, title):
    r = c.r
    y = b["year"]
    L = [
        "Изм. Кол.уч. Лист № док. Подп. Дата",
        f"Разраб. {r.choice(SURN)} {r.randint(1, 28):02d}.{r.randint(1, 12):02d}.{y % 100:02d}",
        f"ГИП {r.choice(SURN)}",
        f"Н. контр. {r.choice(SURN)}",
        f"{b['code']}-{part}",
        f"{title} Стадия Лист Листов",
        f"{c.stage} {r.randint(1, 9)} {r.randint(10, 48)}",
        b["org"],
    ]
    if r.random() < 0.3:
        L.append("Формат А3")
    return L


def _page(c, b, part, title, body, name=None):
    r = c.r
    kind = name or b["kind"][0]
    top = [r.choice([kind, f"Объект: {kind}", f"{kind} по адресу: {b['place']}"])]
    if not top[0].endswith(b["place"]) and r.random() < 0.5:
        top.append(b["place"])
    st = _stamp(c, b, part, title)
    if r.random() < 0.2:
        return st + top + body
    return top + body + st


# ---------------------------------------------------------------- модель здания


def _building(r, need_cap=False):
    kinds = [k for k in KINDS if k[1]] if need_cap else KINDS
    k = r.choice(kinds)
    b = {"kind": k, "place": r.choice(PLACES), "org": r.choice(ORGS)}
    b["year"] = r.choice([2024, 2025, 2025, 2026])
    b["code"] = f"{r.randint(11, 97)}-{r.randint(100, 989)}/{b['year'] % 100}"
    fl = r.randint(2, 24)
    b["floors"] = fl
    b["dA"] = r.choice([0, 1, 1, 2])
    b["A"] = round(r.uniform(320, 5400), b["dA"])
    b["dV"] = r.choice([0, 1, 1, 2])
    b["Va"] = round(b["A"] * fl * r.uniform(2.9, 3.5), b["dV"])
    b["Vb"] = round(b["A"] * r.uniform(2.8, 4.6), b["dV"])
    b["G"] = round(b["A"] * fl * r.uniform(0.72, 0.9), 1)
    b["dH"] = r.choice([2, 2, 3])
    b["H"] = round(fl * r.uniform(3.0, 3.5) + r.uniform(1.2, 3.6), b["dH"])
    b["hfl"] = round(round((b["H"] - r.uniform(1.0, 2.0)) / fl * 20) / 20, 2)
    b["Hf"] = round(b["H"] - r.uniform(2.6, 6.0), 2)  # пожарно-техническая высота
    b["dZ"] = r.choice([2, 3, 3])
    b["Z"] = round(r.uniform(96, 264), b["dZ"])
    b["dD"] = r.choice([2, 3, 3])
    d = r.uniform(3.1, 8.4)
    if r.random() < 0.6:
        d = round(d * 20) / 20
    b["D"] = -round(d, b["dD"])
    if k[1]:
        lo, hi = k[3]
        b["cap"] = r.randrange(lo, hi + 1, k[4])
    else:
        b["cap"] = None
    b["dkz"] = r.choice([0, 1, 1])
    b["kz"] = round(r.uniform(18, 58), b["dkz"])
    b["kzlim"] = float(
        r.choice([x for x in (40, 50, 60, 65, 70, 80) if x >= b["kz"] + 3])
    )
    b["P"] = round(b["A"] * 100 / b["kz"])
    b["dkit"] = 0
    b["kit"] = float(r.randint(60, 420))
    b["kitlim"] = float(
        r.choice(
            [x for x in (150, 200, 240, 300, 350, 400, 450, 500) if x >= b["kit"] + 10]
        )
    )
    b["sub_c"] = r.randint(4_000_000, 380_000_000)  # сотые доли тыс. руб.
    b["cpct"] = r.choice([2, 2, 3])
    b["vatr"] = 22 if b["year"] >= 2026 else 20
    b["idx"] = round(r.uniform(7.2, 11.8), 2)
    b["q"] = r.choice(["I", "II", "III", "IV"])
    b["variant"] = None
    return b


def _vt(b):
    return round(b["Va"] + b["Vb"], b["dV"])


def _cost(b):
    """Итоги ССР в сотых долях тыс. руб. (целые): главы, непредвиденные, без НДС, НДС, с НДС, базис 2001."""
    sub = b["sub_c"]
    cont = round(sub * b["cpct"] / 100)
    base = sub + cont
    vat = round(base * b["vatr"] / 100)
    incl = base + vat
    basis = round(base / b["idx"])
    return sub, cont, base, vat, incl, basis


def _hlim(b):
    return float((int(b["H"] // 5) + 2) * 5)


def _truth_std(p, b):
    return {
        "M-001": lambda: T(b["A"]),
        "M-004": lambda: T(_vt(b)),
        "M-005": lambda: T(b["Vb"]),
        "M-006": lambda: T(b["Va"]),
        "M-008": lambda: T(b["H"]),
        "M-009": lambda: T(b["Z"]),
        "M-013": lambda: T(b["cap"]),
        "M-019": lambda: T(b["kz"]),
        "M-020": lambda: T(b["kit"]),
    }[p]()


# ---------------------------------------------------------------- строки ТЭП


def _r_plot(c, b):
    if c.r.random() < 0.5:
        return ("Площадь земельного участка", c.ua, c.n(b["P"], 0))
    return (
        c.r.choice(["Площадь участка в границах ГПЗУ", "Площадь земельного участка"]),
        "га",
        c.n(b["P"] / 10000, 4),
    )


def _r_area(c, b):
    return (
        c.r.choice(
            [
                "Площадь застройки",
                "Площадь застройки здания",
                "Площадь застройки (по наружному контуру)",
            ]
        ),
        c.ua,
        c.n(b["A"], b["dA"]),
    )


def _r_gross(c, b):
    return (
        c.r.choice(["Общая площадь здания", "Общая площадь", "Площадь здания"]),
        c.ua,
        c.n(b["G"], 1),
    )


def _r_vol(c, b):
    r = c.r
    top = r.choice(
        ["Строительный объём", "Строительный объём, всего", "Строительный объём здания"]
    )
    if r.random() < 0.5:
        a, u = "надземной части", "подземной части"
    else:
        a, u = "выше отметки " + c.z0(), "ниже отметки " + c.z0()
    g = [
        (top, c.uv, c.n(_vt(b), b["dV"])),
        ("в том числе:", "", ""),
        (a, c.uv, c.n(b["Va"], b["dV"])),
        (u, c.uv, c.n(b["Vb"], b["dV"])),
    ]
    if r.random() < 0.3:
        del g[1]
    return g


def _r_floors(c, b):
    return c.r.choice(
        [
            ("Этажность", "эт.", str(b["floors"])),
            ("Количество этажей", "шт.", str(b["floors"] + 1)),
            ("Количество надземных этажей", "эт.", str(b["floors"])),
        ]
    )


def _r_height(c, b):
    if c.alt:
        return ("Высота здания", "мм", c.n(b["H"] * 1000, 0))
    return (
        c.r.choice(["Высота здания", "Высота здания (до верха парапета)"]),
        "м",
        c.n(b["H"], b["dH"]),
    )


def _r_cap(c, b):
    k = b["kind"]
    return (c.r.choice(k[1]), k[2], c.n(b["cap"], 0))


def _kz_s(c, b, x=None):
    x = b["kz"] if x is None else x
    return c.n(x / 100, b["dkz"] + 2) if c.alt else c.n(x, b["dkz"])


def _kit_s(c, b, x=None):
    x = b["kit"] if x is None else x
    return c.n(x / 100, b["dkit"] + 2) if c.alt else c.n(x, b["dkit"])


def _r_kz(c, b):
    if c.alt:
        return ("Коэффициент застройки", "", _kz_s(c, b))
    return (
        c.r.choice(["Процент застройки", "Коэффициент застройки"]),
        "%",
        _kz_s(c, b),
    )


def _r_kit(c, b):
    if c.alt:
        return (
            c.r.choice(
                [
                    "Коэффициент плотности застройки",
                    "Коэффициент использования территории",
                    "КИТ",
                ]
            ),
            "",
            _kit_s(c, b),
        )
    return (
        c.r.choice(["Коэффициент использования территории", "Плотность застройки"]),
        "%",
        _kit_s(c, b),
    )


def _std_rows(c, b, p):
    r = c.r
    rows = []
    if p in ("M-001", "M-019", "M-020") or r.random() < 0.6:
        rows.append(_r_plot(c, b))
    if p == "M-013":
        rows.append(_r_cap(c, b))
    rows.append(_r_area(c, b))
    if p == "M-019":
        rows.append(_r_kz(c, b))
        if r.random() < 0.6:
            rows.append(_r_kit(c, b))
    if p == "M-020":
        rows.append(_r_kit(c, b))
        if r.random() < 0.6:
            rows.append(_r_kz(c, b))
    rows.append(_r_gross(c, b))
    if p in ("M-004", "M-005", "M-006") or r.random() < 0.6:
        rows.append(_r_vol(c, b))
    rows.append(_r_floors(c, b))
    if p == "M-008":
        rows.append(_r_height(c, b))
        rows.append(("Высота этажа", "м", c.n(b["hfl"], 2)))
        if r.random() < 0.6:
            rows.append(("Пожарно-техническая высота", "м", c.n(b["Hf"], 2)))
    elif r.random() < 0.25:
        rows.append(_r_height(c, b))
    if p == "M-009":
        rows.append(
            (
                "Абсолютная отметка, соответствующая относительной " + c.z0(),
                "м",
                c.n(b["Z"], b["dZ"]),
            )
        )
        rows.append(
            ("Средняя отметка планировки", "м", c.n(b["Z"] - r.uniform(0.2, 0.8), 2))
        )
    if p == "M-013":
        rows.append(("Количество работающих", "чел.", str(r.randint(12, 180))))
        rows.append(
            ("Расчётная электрическая мощность", "кВт", c.n(r.uniform(90, 900), 1))
        )
    return rows


def _tep(c, rows, style, title=None):
    """Таблица показателей в текстовом слое. style: unitcol | unitname | valnext | wrap."""
    r = c.r
    L = [title or r.choice(TEP_TITLES)]
    if style == "unitcol":
        if r.random() < 0.3:
            L += ["№", "п/п Наименование показателя Ед.", "изм. Значение"]
        else:
            L.append(
                r.choice(
                    [
                        "№ п/п Наименование показателя Ед. изм. Значение",
                        "№ Наименование Ед. изм. Количество",
                        "Поз. Показатель Единица измерения Величина",
                    ]
                )
            )
    elif style == "unitname":
        L.append(r.choice(["Наименование показателя Значение", "Показатель Величина"]))
    elif style == "valnext":
        L.append(
            r.choice(
                ["Наименование Ед. изм. Показатель", "Наименование показателя Значение"]
            )
        )
    else:
        L.append(
            r.choice(
                [
                    "№ п/п Наименование показателя Ед. изм. Значение",
                    "№ Показатель Ед. изм. Кол-во",
                ]
            )
        )
    k = 0
    for el in c.rows(rows):
        grp = el if isinstance(el, list) else [el]
        k += 1
        sub = r.choice(["", "-", "–", "•"])
        for j, (nm, u, v) in enumerate(grp):
            if j == 0:
                pre = f"{k}." if style == "unitname" else str(k)
            else:
                pre = sub if v else ""
            if style == "unitcol":
                L.append(_j(pre, nm, u, v))
            elif style == "unitname":
                L.append(_j(pre, f"{nm}, {u}" if u else nm, v))
            elif style == "valnext":
                L.append(_j(pre, f"{nm}, {u}" if u else nm))
                if v:
                    L.append(v)
            else:
                ws = nm.split(" ")
                if len(ws) >= 2 and v:
                    cut = r.randint(1, len(ws) - 1)
                    a, z = " ".join(ws[:cut]), " ".join(ws[cut:])
                    if r.random() < 0.5:
                        L += [_j(pre, a, u, v), z]
                    else:
                        L += [_j(pre, a), _j(z, u, v)]
                else:
                    L.append(_j(pre, nm, u, v))
    return L


def _notes(c):
    r = c.r
    L = [r.choice(["Примечания:", "Примечание."])]
    for i, t in enumerate(r.sample(NOTES, r.randint(1, 3)), 1):
        L += _wrap(r, f"{i}. {t}")
    return L


def _tep_fn(c, b, p, style):
    r = c.r
    body = _tep(c, _std_rows(c, b, p), style)
    if r.random() < 0.5:
        body += _notes(c)
    part = r.choice(["ПЗ", "ОПЗ", "АР", "ГП"])
    return _page(
        c, b, part, r.choice(["Технико-экономические показатели", "Общие данные"]), body
    ), _truth_std(p, b)


# ---------------------------------------------------------------- общие формы


def _pv(c, b, p, s):
    """Подпись и значение показателя p (масштаб s — для «было»/«существующее»)."""
    k = b["kind"]
    if p == "M-001":
        return "площадь застройки", f"{c.n(b['A'] * s, b['dA'])} {c.ua}"
    if p == "M-004":
        return "строительный объём", f"{c.n(_vt(b) * s, b['dV'])} {c.uv}"
    if p == "M-005":
        return "отметка низа фундаментной плиты", c.n(b["D"] * s, 3)
    if p == "M-006":
        return (
            "строительный объём надземной части",
            f"{c.n(b['Va'] * s, b['dV'])} {c.uv}",
        )
    if p == "M-008":
        return "высота здания", f"{c.n(b['H'] * s, b['dH'])} м"
    if p == "M-009":
        return "абсолютная отметка, соответствующая относительной " + c.z0(), c.n(
            b["Z"] * s, 3
        )
    if p == "M-013":
        return k[1][0].lower(), f"{c.n(round(b['cap'] * s), 0)} {k[2]}"
    if p == "M-019":
        return "процент застройки", f"{c.n(b['kz'] * s, 1)} %"
    if p == "M-020":
        return "коэффициент использования территории", f"{c.n(b['kit'] * s, 0)} %"
    return (
        "итог по сводному сметному расчёту",
        f"{c.n(_cost(b)[4] * s / 100, 2)} тыс. руб.",
    )


def _chg(c, b, p):
    """Лист регистрации изменений: значение есть только в записи об изменении — истина None."""
    r = c.r
    if p == "M-009":
        s = r.choice([0.995, 1.004])
    else:
        s = r.choice([r.uniform(0.85, 0.97), r.uniform(1.03, 1.12)])
    what, new = _pv(c, b, p, 1.0)
    _, old = _pv(c, b, p, s)
    k = r.randint(1, 4)
    body = [
        r.choice(["ТАБЛИЦА РЕГИСТРАЦИИ ИЗМЕНЕНИЙ", "Таблица регистрации изменений"]),
        "Изм. Номера листов (страниц) Всего листов (страниц) в док. Номер док. Подп. Дата",
        "изменённых заменённых новых аннулированных",
    ]
    for j in range(1, k + 1):
        body.append(
            _j(
                str(j),
                "-",
                str(r.randint(2, 30)),
                "-",
                "-",
                str(r.randint(20, 90)),
                f"{r.randint(10, 99)}-{b['year'] % 100}",
                f"{r.randint(1, 28):02d}.{r.randint(1, 12):02d}.{b['year']}",
            )
        )
    what_c = what[0].upper() + what[1:]
    body += _wrap(
        r,
        r.choice(
            [
                f"Изм. {k}. {what_c} — {new} (было {old}). Основание: замечание экспертизы.",
                f"Изм. {k} (зам.): уточнено значение «{what}»: {old} заменено на {new}.",
                f"Изм. {k}, лист {r.randint(2, 30)}: в строке «{what_c}» вместо {old} читать {new}.",
            ]
        ),
    )
    part = r.choice(["ПЗ", "АР", "ГП", "СМ", "КЖ"])
    return _page(c, b, part, "Таблица регистрации изменений", body), T()


def _exist(c, b, p):
    """Только существующее положение при реконструкции — показателя проекта нет, истина None."""
    r = c.r
    s = r.uniform(0.985, 0.997) if p == "M-009" else r.uniform(0.55, 0.9)
    what, val = _pv(c, b, p, s)
    yr = r.choice([1958, 1964, 1971, 1979, 1986])
    body = [
        r.choice(
            [
                "Описание существующего положения",
                "Результаты обследования существующего здания",
                "Существующее положение",
            ]
        )
    ]
    body += _wrap(
        r,
        f"Существующее здание {yr} года постройки подлежит реконструкции с надстройкой и пристройкой. "
        f"По данным обмерных чертежей {what} существующего здания — {val}.",
    )
    body += _wrap(
        r,
        r.choice(
            [
                "Техническое состояние несущих конструкций оценивается как ограниченно работоспособное.",
                "Физический износ здания по результатам обследования составляет 48 %.",
            ]
        ),
    )
    return _page(c, b, r.choice(["ПЗ", "ОИ", "АР"]), "Обследование", body), T()


def _recon(c, b, p):
    """Таблица «существующее / проектное» — истина проектная колонка."""
    r = c.r
    rows = [
        (
            "Площадь застройки",
            c.ua,
            c.nm(b["A"] * r.uniform(0.6, 0.9), b["dA"]),
            c.nm(b["A"], b["dA"]),
        ),
        (
            "Общая площадь",
            c.ua,
            c.nm(b["G"] * r.uniform(0.5, 0.85), 1),
            c.nm(b["G"], 1),
        ),
    ]
    vt = _vt(b)
    fv = r.uniform(
        0.5, 0.85
    )  # один множитель: «было» для части не больше «было» для целого
    rows.append(
        (
            "Строительный объём",
            c.uv,
            c.nm(vt * fv, b["dV"]),
            c.nm(vt, b["dV"]),
        )
    )
    if p == "M-006" or r.random() < 0.4:
        rows.append(
            (
                "в т. ч. надземной части",
                c.uv,
                c.nm(b["Va"] * fv, b["dV"]),
                c.nm(b["Va"], b["dV"]),
            )
        )
    rows.append(
        (
            "Этажность",
            "эт.",
            str(max(1, b["floors"] - r.randint(1, 3))),
            str(b["floors"]),
        )
    )
    if p == "M-008" or r.random() < 0.3:
        u = r.uniform(0.5, 0.85)
        if c.alt:
            rows.append(
                (
                    "Высота здания",
                    "мм",
                    c.nm(b["H"] * u * 1000, 0),
                    c.nm(b["H"] * 1000, 0),
                )
            )
        else:
            rows.append(
                ("Высота здания", "м", c.nm(b["H"] * u, b["dH"]), c.nm(b["H"], b["dH"]))
            )
    if p == "M-013":
        k = b["kind"]
        rows.append(
            (
                r.choice(k[1]),
                k[2],
                c.nm(round(b["cap"] * r.uniform(0.5, 0.85)), 0),
                c.nm(b["cap"], 0),
            )
        )
    if p == "M-019":
        old = round(b["kz"] * r.uniform(0.5, 0.85), b["dkz"])
        rows.append(
            (
                "Коэффициент застройки" if c.alt else "Процент застройки",
                "" if c.alt else "%",
                _kz_s(c, b, old),
                _kz_s(c, b),
            )
        )
    if p == "M-020":
        old = round(b["kit"] * r.uniform(0.5, 0.85), b["dkit"])
        rows.append(
            (
                "Коэффициент плотности застройки"
                if c.alt
                else "Коэффициент использования территории",
                "" if c.alt else "%",
                _kit_s(c, b, old),
                _kit_s(c, b),
            )
        )
    body = [
        r.choice(
            [
                "Технико-экономические показатели (реконструкция)",
                "Сравнительные показатели до и после реконструкции",
            ]
        )
    ]
    if r.random() < 0.5:
        body.append(
            r.choice(
                [
                    "Наименование показателя Ед. изм. Существующее положение Проектное решение",
                    "Показатель Ед. изм. До реконструкции После реконструкции",
                ]
            )
        )
    else:
        body += [
            "Наименование Ед. Существующее Проектное",
            "показателя изм. положение решение",
        ]
    for i, (nm, u, a, v) in enumerate(c.rows(rows), 1):
        body.append(_j(str(i), nm, u, a, v))
    return _page(c, b, "ПЗ", "Технико-экономические показатели", body), _truth_std(p, b)


def _kz_pair(c, b):
    if c.alt:
        return (
            "Коэффициент застройки",
            "",
            c.n(b["kzlim"] / 100, 2, trim=True),
            _kz_s(c, b),
        )
    return ("Процент застройки", "%", c.n(b["kzlim"], 0), _kz_s(c, b))


def _kit_pair(c, b):
    if c.alt:
        return (
            "Коэффициент плотности застройки",
            "",
            c.n(b["kitlim"] / 100, 2, trim=True),
            _kit_s(c, b),
        )
    return (
        "Коэффициент использования территории",
        "%",
        c.n(b["kitlim"], 0),
        _kit_s(c, b),
    )


def _gpzu_tab(c, b, p):
    """Таблица «по ГПЗУ / по проекту» — истина проектная колонка, предел — колонка ГПЗУ."""
    r = c.r
    hl = _hlim(b)
    rows = [
        (
            "Площадь застройки",
            c.ua,
            r.choice(["—", "не устанавл."]),
            c.nm(b["A"], b["dA"]),
        ),
        _kz_pair(c, b),
        _kit_pair(c, b),
        (
            "Количество этажей",
            "эт.",
            str(b["floors"] + r.randint(1, 4)),
            str(b["floors"]),
        ),
    ]
    if c.alt:
        rows.append(
            (
                "Высота здания",
                "мм",
                "не более " + c.nm(hl * 1000, 0),
                c.nm(b["H"] * 1000, 0),
            )
        )
    else:
        rows.append(
            ("Высота здания", "м", "не более " + c.n(hl, 0), c.nm(b["H"], b["dH"]))
        )
    body = [
        r.choice(
            [
                "Соответствие предельным параметрам разрешённого строительства",
                "Сведения о соответствии ГПЗУ",
            ]
        )
    ]
    if r.random() < 0.5:
        body.append(
            r.choice(
                [
                    "Наименование показателя Ед. изм. По ГПЗУ По проекту",
                    "Показатель Ед. изм. Допустимое значение (ГПЗУ) Проектное значение",
                ]
            )
        )
    else:
        body += [
            "Наименование Ед. По ГПЗУ По проекту",
            "показателя изм. (допустимое) (проектное)",
        ]
    for i, (nm, u, a, v) in enumerate(c.rows(rows), 1):
        body.append(_j(str(i), nm, u, a, v))
    tr = {
        "M-001": T(b["A"]),
        "M-008": T(b["H"]),
        "M-019": T(b["kz"], limit=b["kzlim"]),
        "M-020": T(b["kit"], limit=b["kitlim"]),
    }[p]
    return _page(
        c, b, r.choice(["ПЗ", "ПЗУ"]), "Технико-экономические показатели", body
    ), tr


def _gpzu_no(c, b):
    r = c.r
    return f"№ РФ-{r.randint(10, 89)}-{r.randint(1, 9)}-{r.randint(10, 99)}-0-00-{b['year']}-{r.randint(1000, 9999)}"


def _gpzu_only(c, b, p):
    """Выписка ГПЗУ: только нормативные ограничения, проектного значения нет."""
    r = c.r
    kz_l = c.n(b["kzlim"] / 100, 2, trim=True) if c.alt else c.n(b["kzlim"], 0) + " %"
    kit_l = c.n(b["kitlim"] / 100, 2, trim=True)
    body = [f"ГРАДОСТРОИТЕЛЬНЫЙ ПЛАН ЗЕМЕЛЬНОГО УЧАСТКА {_gpzu_no(c, b)}"]
    body += _wrap(
        r,
        "2.2. Предельные (минимальные и (или) максимальные) размеры земельных участков "
        "и предельные параметры разрешённого строительства, реконструкции объекта",
    )
    items = [
        f"Площадь земельного участка — {c.n(b['P'], 0)} {c.ua}",
        f"Предельное количество этажей — {b['floors'] + r.randint(1, 5)}",
        f"Предельная высота зданий, строений, сооружений — {c.n(_hlim(b), 0)} м",
        f"Максимальный процент застройки в границах земельного участка — {kz_l}",
        f"Максимальный коэффициент плотности застройки — {kit_l}",
        f"Максимальная площадь застройки — не более {c.n(round(b['A'] * r.uniform(1.1, 1.4)), 0)} {c.ua}",
        "Минимальные отступы от границ земельного участка — 3 м",
    ]
    first = items[:1]
    rest = items[1:]
    r.shuffle(rest)
    for it in first + rest:
        body += _wrap(r, it + ";")
    tr = {"M-019": T(limit=b["kzlim"]), "M-020": T(limit=b["kitlim"])}.get(p, T())
    return _page(c, b, "ИРД", "Исходно-разрешительная документация", body), tr


# ---------------------------------------------------------------- M-001


def m001_balance(c, b):
    r = c.r
    d = b["dA"]
    A = b["A"]
    P = float(b["P"])
    hard = round((P - A) * r.uniform(0.3, 0.6), d)
    green = round(P - A - hard, d)
    tot = round(A + hard + green, d)
    rows = [
        ("Площадь застройки", A),
        ("Площадь твёрдых покрытий", hard),
        ("Площадь озеленения", green),
    ]
    body = [
        "Баланс территории",
        r.choice(
            [
                f"№ Наименование Площадь, {c.ua} %",
                f"Наименование Площадь, {c.ua} Процент",
            ]
        ),
    ]
    for i, (nm, v) in enumerate(c.rows(rows), 1):
        body.append(_j(str(i), nm, c.nm(v, d), c.n(v / tot * 100, 1)))
    body.append(_j("Итого в границах участка", c.nm(tot, d), "100"))
    return _page(c, b, "ГП", "Общие данные", body), T(A)


def m001_prose(c, b):
    r = c.r
    a = f"{c.n(b['A'], b['dA'])} {c.ua}"
    s = [
        f"Площадь застройки проектируемого здания составляет {a}.",
        f"Общая площадь здания — {c.n(b['G'], 1)} {c.ua}.",
        f"Площадь земельного участка в границах ГПЗУ — {c.n(b['P'] / 10000, 4)} га.",
    ]
    r.shuffle(s)
    body = [
        r.choice(
            ["1.3. Описание решений по объекту", "Сведения о проектируемом объекте"]
        )
    ] + _wrap(r, " ".join(s))
    return _page(c, b, "ПЗ", "Пояснительная записка", body), T(b["A"])


# ---------------------------------------------------------------- M-004 / M-005 / M-006 (объёмы)


def _vol_truth(p, b):
    return {"M-004": T(_vt(b)), "M-005": T(b["Vb"]), "M-006": T(b["Va"])}[p]


def _hdr_vol(c, b, p):
    """Единица в шапке, три числа в одной строке."""
    r = c.r
    d = b["dV"]
    body = [
        r.choice(["Показатели строительного объёма", "Строительный объём здания"]),
        r.choice([f"Всего, {c.uv} В том числе", f"Строительный объём, {c.uv}"]),
        r.choice(
            [
                "всего надземная часть подземная часть",
                f"общий выше отм. {c.z0()} ниже отм. {c.z0()}",
            ]
        ),
        _j(c.nm(_vt(b), d), c.nm(b["Va"], d), c.nm(b["Vb"], d)),
    ]
    return _page(c, b, r.choice(["АР", "ПЗ"]), "Общие данные", body), _vol_truth(p, b)


def _sections(c, b, p):
    """Показатели по секциям с итогом — истина итог."""
    r = c.r
    d = b["dV"]
    val = _vt(b) if p == "M-004" else b["Va"]
    lab = "Строительный объём" if p == "M-004" else "Строительный объём надземной части"
    k = r.randint(2, 3)
    sc = 10**d
    parts = _split(round(val * sc), [r.uniform(0.6, 1.4) for _ in range(k)])
    ad = b["dA"]
    aparts = _split(round(b["A"] * 10**ad), [r.uniform(0.6, 1.4) for _ in range(k)])
    rows = [
        (lab, c.uv, [c.nm(x / sc, d) for x in parts], c.nm(val, d)),
        (
            "Площадь застройки",
            c.ua,
            [c.nm(x / 10**ad, ad) for x in aparts],
            c.nm(b["A"], ad),
        ),
        (
            "Этажность",
            "эт.",
            [str(max(2, b["floors"] - r.randint(0, 3))) for _ in range(k)],
            "—",
        ),
    ]
    body = [
        r.choice(
            ["Показатели по секциям", "Технико-экономические показатели по секциям"]
        ),
        _j(
            "Наименование показателя",
            "Ед. изм.",
            *[f"Секция {i}" for i in range(1, k + 1)],
            "Итого",
        ),
    ]
    for nm, u, ps, tot in c.rows(rows):
        body.append(_j(nm, u, *ps, tot))
    return _page(c, b, "АР", "Общие данные", body), _vol_truth(p, b)


def _prose_vol(c, b, p):
    r = c.r
    d = b["dV"]
    s = (
        f"Строительный объём здания — {c.n(_vt(b), d)} {c.uv}, в том числе надземной части — "
        f"{c.n(b['Va'], d)} {c.uv}, подземной части — {c.n(b['Vb'], d)} {c.uv}."
    )
    s2 = f"Общая площадь здания — {c.n(b['G'], 1)} {c.ua}, площадь застройки — {c.n(b['A'], b['dA'])} {c.ua}."
    body = [
        r.choice(["Объёмно-планировочные решения", "3. Архитектурные решения"])
    ] + _wrap(r, _j(*r.sample([s, s2], 2)))
    return _page(c, b, "ПЗ", "Пояснительная записка", body), _vol_truth(p, b)


def _dmark(c, b):
    return c.n(b["D"], b["dD"])


def _ddepth(c, b):
    return c.n(-b["D"], b["dD"], trim=True)


def m005_kzh(c, b):
    r = c.r
    t = r.choice([600, 700, 800, 900, 1000, 1200])
    conc = b["A"] * t / 1000 * r.uniform(1.0, 1.1)
    bot = r.choice(
        [
            f"Отметка низа фундаментной плиты — {_dmark(c, b)}.",
            f"Низ плиты — на отм. {_dmark(c, b)} (абс. {c.n(b['Z'] + b['D'], 3)}).",
        ]
    )
    items = [
        f"За относительную отметку {c.z0()} принята отметка чистого пола 1-го этажа, соответствующая "
        f"абсолютной отметке {c.n(b['Z'], b['dZ'])}.",
        f"Фундамент — монолитная железобетонная плита толщиной {t} мм из бетона класса B30 W8 F150.",
        bot,
        "Под плитой выполнить подготовку из бетона класса B7,5 толщиной 100 мм.",
        f"Объём бетона фундаментной плиты — {c.n(conc, 1)} {c.uv}.",
    ]
    body = ["Общие указания"]
    for i, it in enumerate(items, 1):
        body += _wrap(r, f"{i}. {it}")
    return _page(c, b, "КЖ", "Фундаментная плита", body), T(None, depth=b["D"])


def _marks(c, b, deep_label=None, abs_zero=False):
    """Отметки разреза/фасада сверху вниз."""
    r = c.r
    H, h, fl = b["H"], b["hfl"], b["floors"]
    marks = [(H, r.choice(["Верх парапета", "Отм. верха парапета", "Парапет"]))]
    for k in sorted(r.sample(range(2, fl + 1), min(3, fl - 1)), reverse=True):
        marks.append(((k - 1) * h, f"Пол {k}-го этажа"))
    zl = "Чистый пол 1-го этажа"
    if abs_zero:
        zl += r.choice(
            [f" (абс. {c.n(b['Z'], b['dZ'])})", f" = {c.n(b['Z'], b['dZ'])}"]
        )
    marks.append((0.0, zl))
    marks.append((-round(r.uniform(0.3, 0.9), 2), "Планировочная отметка земли"))
    if deep_label:
        marks.append((b["D"], deep_label))
    style = r.choice(["mark_first", "label_first", "mark_line"])
    L = []
    for x, lbl in marks:
        if x == 0.0:
            ms = c.zero()
        elif deep_label and x == b["D"]:
            ms = _dmark(c, b)
        else:
            ms = c.n(x, 3, sign=True)
        if style == "mark_first":
            L.append(f"{ms} {lbl}")
        elif style == "label_first":
            L.append(f"{lbl} {ms}")
        else:
            L += [ms, lbl]
    return L


def m005_section(c, b):
    r = c.r
    lbl = r.choice(["Низ фундаментной плиты", "Пол подвала", "Отм. пола техподполья"])
    body = [r.choice(["Разрез 1–1", "Разрез А–А"])] + _marks(c, b, deep_label=lbl)
    body.append(f"Высота этажа — {c.n(b['hfl'], 3)}")
    return _page(c, b, "АР", "Разрезы", body), T(None, depth=b["D"])


def m005_zalozh(c, b):
    r = c.r
    s = [
        f"Глубина заложения фундаментов — {_ddepth(c, b)} м от уровня чистого пола первого этажа.",
        f"Уровень подземных вод зафиксирован на глубине {c.n(r.uniform(1.6, 3.4), 1)} м от поверхности земли.",
        "Основанием фундаментов служат суглинки тугопластичные (ИГЭ-3).",
    ]
    body = [
        r.choice(["4.2. Фундаменты", "Конструктивные решения. Фундаменты"])
    ] + _wrap(r, " ".join(s))
    return _page(c, b, "КР", "Пояснительная записка", body), T(None, depth=b["D"])


def m005_kotlovan(c, b):
    r = c.r
    s = [
        f"Котлован разрабатывается экскаватором с ковшом 0,65 м³ до отметки дна {_dmark(c, b)} "
        f"(абс. {c.n(b['Z'] + b['D'], 3)}) с недобором грунта 0,1–0,2 м.",
        f"Крепление стен котлована — шпунт длиной {r.choice([9, 10, 12, 14])} м.",
    ]
    body = [r.choice(["Земляные работы", "6.3. Организация земляных работ"])] + _wrap(
        r, " ".join(s)
    )
    return _page(c, b, "ПОС", "Проект организации строительства", body), T(
        None, depth=b["D"]
    )


def m005_pz_prose(c, b):
    r = c.r
    dep = (
        f"Глубина заложения — {_ddepth(c, b)} м."
        if c.alt
        else f"Отметка низа фундаментной плиты — {_dmark(c, b)}."
    )
    s = (
        f"Здание имеет подземный этаж (подвал) с техническими помещениями. Строительный объём подземной части "
        f"составляет {c.n(b['Vb'], b['dV'])} {c.uv}. {dep} Высота подвала — {c.n(r.choice([2.7, 3.0, 3.3]), 1)} м."
    )
    body = [
        r.choice(
            ["Подземная часть", "3.2. Объёмно-планировочные решения подземной части"]
        )
    ] + _wrap(r, s)
    return _page(c, b, "ПЗ", "Пояснительная записка", body), T(b["Vb"], depth=b["D"])


def m005_tep_depth(c, b):
    rows = _std_rows(c, b, "M-005")
    if c.alt:
        rows.append(("Глубина заложения фундаментов", "м", _ddepth(c, b)))
    else:
        rows.append(("Отметка низа фундаментной плиты", "м", _dmark(c, b)))
    body = _tep(c, rows, "unitcol")
    return _page(c, b, "ПЗ", "Технико-экономические показатели", body), T(
        b["Vb"], depth=b["D"]
    )


def m005_ar_od(c, b):
    r = c.r
    rows = [_r_area(c, b), _r_vol(c, b), _r_floors(c, b)]
    body = _tep(
        c,
        rows,
        "unitcol",
        r.choice(["Ведомость основных показателей", "Основные показатели по зданию"]),
    )
    body.append("Указания:")
    body += _wrap(
        r,
        f"1. Относительная отметка {c.z0()} соответствует абсолютной {c.n(b['Z'], b['dZ'])}.",
    )
    body += _wrap(r, f"2. Отметка пола подвала — {_dmark(c, b)}.")
    return _page(c, b, "АР", "Общие данные", body), T(b["Vb"], depth=b["D"])


def m005_kr_pz(c, b):
    r = c.r
    t = r.choice([600, 800, 1000])
    s = (
        f"Здание {b['floors']}-этажное с подвалом. Фундамент — монолитная плита толщиной {t} мм, низ плиты на "
        f"отметке {_dmark(c, b)}. Строительный объём подземной части — {c.n(b['Vb'], b['dV'])} {c.uv}, "
        f"надземной — {c.n(b['Va'], b['dV'])} {c.uv}."
    )
    body = [
        r.choice(
            [
                "4. Конструктивные и объёмно-планировочные решения",
                "Раздел 4. Конструктивные решения",
            ]
        )
    ]
    body += _wrap(r, s)
    return _page(c, b, "КР", "Пояснительная записка", body), T(b["Vb"], depth=b["D"])


def m005_exist(c, b):
    r = c.r
    dold = -round(-b["D"] * r.uniform(0.4, 0.75), 3)
    vold = b["Vb"] * r.uniform(0.3, 0.7)
    body = [r.choice(["Существующее положение", "Результаты обследования"])]
    body += _wrap(
        r,
        f"Существующий подвал здания 1971 года постройки: отметка пола {c.n(dold, 3)}, строительный "
        f"объём подземной части — {c.n(vold, b['dV'])} {c.uv}. Подвал подлежит засыпке.",
    )
    return _page(c, b, "ОИ", "Обследование", body), T()


# ---------------------------------------------------------------- M-008


def m008_facade(c, b):
    r = c.r
    body = [r.choice(["Фасад 1–12", "Фасад в осях А–Ж", "Разрез 1–1"])] + _marks(c, b)
    body.append(f"Высота этажа — {c.n(b['hfl'], 3)}")
    return _page(c, b, "АР", "Фасады", body), T(b["H"])


def m008_prose(c, b):
    r = c.r
    hs = f"{c.nm(b['H'] * 1000, 0)} мм" if c.alt else f"{c.n(b['H'], b['dH'])} м"
    s = [
        f"Высота здания от уровня планировочной отметки земли до верха парапета — {hs}."
    ]
    rest = [
        f"Пожарно-техническая высота — {c.n(b['Hf'], 2)} м.",
        f"Высота этажа — {c.n(b['hfl'], 2)} м.",
        f"Количество этажей — {b['floors']}.",
    ]
    r.shuffle(rest)
    body = [
        r.choice(["Объёмно-планировочные решения", "Характеристика здания"])
    ] + _wrap(r, " ".join(s + rest))
    return _page(c, b, "ПЗ", "Пояснительная записка", body), T(b["H"])


def m008_ar_od(c, b):
    r = c.r
    items = [
        "Уровень ответственности — нормальный.",
        "Степень огнестойкости — II.",
        "Класс конструктивной пожарной опасности — С0.",
        "Класс функциональной пожарной опасности — Ф1.3.",
        f"Высота здания — {c.nm(b['H'] * 1000, 0)} мм (от {c.z0()} до верха парапета).",
        f"Высота этажа — {c.nm(b['hfl'] * 1000, 0)} мм.",
    ]
    body = ["Общие данные", "Характеристика здания:"]
    for i, it in enumerate(items, 1):
        body += _wrap(r, f"{i}. {it}")
    return _page(c, b, "АР", "Общие данные", body), T(b["H"])


# ---------------------------------------------------------------- M-009


def m009_ar_note(c, b):
    r = c.r
    items = [
        "Проект разработан на основании задания на проектирование и ГПЗУ "
        + _gpzu_no(c, b)
        + ".",
        f"За относительную отметку {c.z0()} принята отметка чистого пола первого этажа, что соответствует "
        f"абсолютной отметке {c.n(b['Z'], b['dZ'])} в Балтийской системе высот 1977 г.",
        f"Высота этажа — {c.n(b['hfl'], 3)} м.",
        "Наружные стены — газобетонные блоки D500 с навесным фасадом.",
    ]
    body = [r.choice(["Общие указания", "Указания к чертежам"])]
    for i, it in enumerate(items, 1):
        body += _wrap(r, f"{i}. {it}")
    return _page(c, b, "АР", "Общие данные", body), T(b["Z"])


def m009_gp_legend(c, b):
    r = c.r
    Zs = c.n(b["Z"], b["dZ"])
    z = c.z0()
    marks = " ".join(
        c.n(b["Z"] + r.uniform(-0.6, 0.3), 2) for _ in range(r.randint(3, 5))
    )
    body = [
        "Условные обозначения:",
        "— проектируемое здание",
        "— граница земельного участка",
        "Отметки проектного рельефа:",
        marks,
        r.choice(
            [
                f"{z} = {Zs}",
                f"{z}={Zs}",
                f"Отм. {z} здания соответствует абс. отм. {Zs}",
                f"{z} = абс. {Zs}",
            ]
        ),
        "Система высот — Балтийская.",
    ]
    return _page(c, b, "ГП", "План организации рельефа", body), T(b["Z"])


def m009_kzh(c, b):
    r = c.r
    items = [
        f"Отметка {c.z0()} соответствует абсолютной отметке {c.n(b['Z'], b['dZ'])}.",
        f"Низ фундаментной плиты — на отм. {c.n(b['D'], 3)} (абс. {c.n(b['Z'] + b['D'], 3)}).",
        "Бетон плиты — класса B30 W8 F150.",
    ]
    body = ["Общие указания"]
    for i, it in enumerate(items, 1):
        body += _wrap(r, f"{i}. {it}")
    return _page(c, b, "КЖ", "Общие данные", body), T(b["Z"])


def m009_igi(c, b):
    r = c.r
    Z = b["Z"]
    s = (
        f"Абсолютные отметки устьев скважин — {c.n(Z - r.uniform(0.3, 0.9), 2)}…{c.n(Z + r.uniform(0.1, 0.5), 2)} м. "
        f"Уровень подземных вод вскрыт на абс. отм. {c.n(Z - r.uniform(2.0, 4.0), 2)}. "
        f"За отметку {c.z0()} принята абс. отм. {c.n(Z, b['dZ'])}."
    )
    body = [
        r.choice(
            [
                "Инженерно-геологические условия",
                "1.4. Сведения об инженерных изысканиях",
            ]
        )
    ] + _wrap(r, s)
    return _page(c, b, "ПЗ", "Пояснительная записка", body), T(Z)


def m009_valnext(c, b):
    r = c.r
    body = [
        r.choice(["Исходные данные", "Привязка здания"]),
        "Абсолютная отметка, соответствующая",
        f"относительной отметке {c.z0()}, м",
        c.n(b["Z"], b["dZ"]),
        "Система высот",
        "Балтийская 1977 г.",
    ]
    return _page(c, b, "ГП", "Общие данные", body), T(b["Z"])


def m009_section_abs(c, b):
    r = c.r
    body = [r.choice(["Разрез 1–1", "Разрез 2–2"])] + _marks(c, b, abs_zero=True)
    return _page(c, b, "АР", "Разрезы", body), T(b["Z"])


def m009_relative_only(c, b):
    r = c.r
    body = [r.choice(["Разрез 1–1", "Фасад 1–12"])] + _marks(c, b)
    body.append(
        r.choice(
            [
                "Отметки даны относительно чистого пола 1-го этажа.",
                "Размеры даны в мм, отметки — в м.",
            ]
        )
    )
    return _page(c, b, "АР", "Разрезы", body), T()


# ---------------------------------------------------------------- M-013


def m013_prose(c, b):
    r = c.r
    k = b["kind"]
    cap = b["cap"]
    a = int(round(cap * r.uniform(0.3, 0.7)))
    s = (
        f"Проектная мощность объекта ({k[1][0].lower()}) — {c.n(cap, 0)} {k[2]}, в том числе: 1 этап строительства — "
        f"{c.n(a, 0)} {k[2]}, 2 этап — {c.n(cap - a, 0)} {k[2]}."
    )
    body = [
        r.choice(["Сведения о проектной мощности", "1.2. Характеристика объекта"])
    ] + _wrap(r, s)
    return _page(c, b, "ПЗ", "Пояснительная записка", body), T(cap)


def m013_tx(c, b):
    r = c.r
    k = b["kind"]
    w = r.randint(15, 220)
    s1 = f"{k[1][0]} объекта — {c.n(b['cap'], 0)} {k[2]}."
    rest = [
        f"Списочная численность работающих — {w} чел., в наиболее многочисленную смену — {int(w * 0.6)} чел.",
        f"Установленная электрическая мощность технологического оборудования — {c.n(r.uniform(80, 950), 1)} кВт.",
        f"Режим работы — {r.choice(['односменный', 'двухсменный', 'круглосуточный'])}, "
        f"{r.choice([247, 250, 305, 365])} дней в году.",
    ]
    r.shuffle(rest)
    seq = rest[:]
    seq.insert(r.randint(0, len(seq)), s1)
    body = [
        r.choice(
            [
                "Технологические решения",
                "Раздел 5. Подраздел 7. Технологические решения",
            ]
        )
    ]
    for s in seq:
        body += _wrap(r, s)
    return _page(c, b, "ИОС7", "Технологические решения", body), T(b["cap"])


def m013_name(c, b):
    k = b["kind"]
    cap = c.n(b["cap"], 0)
    name = (
        f"{k[0]} мощностью {cap} т/год"
        if k[2] == "т/год"
        else f"{k[0]} на {cap} {k[2]}"
    )
    body = _tep(c, _std_rows(c, b, "M-013"), "unitcol")
    return _page(c, b, "ПЗ", "Технико-экономические показатели", body, name=name), T(
        b["cap"]
    )


def m013_power_only(c, b):
    r = c.r
    items = [
        f"Расчётная электрическая мощность объекта — {c.n(r.uniform(90, 900), 1)} кВт.",
        "Категория надёжности электроснабжения — II.",
        f"Тепловая нагрузка — {c.n(r.uniform(0.2, 2.5), 3)} Гкал/ч.",
        f"Мощность трансформаторной подстанции — 2×{r.choice([400, 630, 1000])} кВА.",
        f"Количество работающих — {r.randint(12, 180)} чел.",
    ]
    r.shuffle(items)
    body = [r.choice(["Электроснабжение", "Сведения об инженерном оборудовании"])]
    for it in items:
        body += _wrap(r, it)
    return _page(c, b, "ИОС1", "Система электроснабжения", body), T()


# ---------------------------------------------------------------- M-019 / M-020


def _gp_coef(c, b, p):
    r = c.r
    rows = [
        _r_plot(c, b),
        _r_area(c, b),
        ("Коэффициент застройки", "", c.n(b["kz"] / 100, b["dkz"] + 2)),
        (
            r.choice(
                [
                    "Коэффициент плотности застройки",
                    "Коэффициент использования территории",
                ]
            ),
            "",
            c.n(b["kit"] / 100, b["dkit"] + 2),
        ),
        ("Площадь озеленения", c.ua, c.n(b["P"] * r.uniform(0.15, 0.3), 0)),
    ]
    body = _tep(
        c,
        rows,
        "unitcol",
        r.choice(
            ["Показатели по генеральному плану", "Основные показатели по генплану"]
        ),
    )
    return _page(c, b, "ГП", "Общие данные", body), _truth_std(p, b)


def _lim_rows(c, b, p):
    """Блок предельных параметров ГПЗУ и отдельно — проектные показатели."""
    r = c.r
    body = [
        f"Градостроительный план земельного участка {_gpzu_no(c, b)}",
        "Предельные параметры разрешённого строительства:",
    ]
    if p == "M-019":
        lim = (
            c.n(b["kzlim"] / 100, 2, trim=True) if c.alt else c.n(b["kzlim"], 0) + " %"
        )
        body += _wrap(
            r,
            f"– максимальный процент застройки в границах земельного участка — {lim};",
        )
        lab, val = (
            ("Коэффициент застройки", _kz_s(c, b))
            if c.alt
            else ("Процент застройки, %", _kz_s(c, b))
        )
        tr = T(b["kz"], limit=b["kzlim"])
    else:
        lim = (
            c.n(b["kitlim"] / 100, 2, trim=True)
            if c.alt
            else c.n(b["kitlim"], 0) + " %"
        )
        body += _wrap(r, f"– максимальный коэффициент плотности застройки — {lim};")
        lab, val = (
            ("Коэффициент плотности застройки", _kit_s(c, b))
            if c.alt
            else ("Коэффициент использования территории, %", _kit_s(c, b))
        )
        tr = T(b["kit"], limit=b["kitlim"])
    body += [
        f"– предельное количество этажей — {b['floors'] + r.randint(1, 5)};",
        "– минимальные отступы от границ участка — 3 м.",
        r.choice(["Проектные показатели:", "Показатели по проекту:"]),
        f"Площадь застройки, {c.ua} {c.n(b['A'], b['dA'])}",
    ]
    if r.random() < 0.5:
        body += [lab, val]
    else:
        body.append(_j(lab, val))
    return _page(c, b, "ПЗУ", "Схема планировочной организации", body), tr


def _prose_lim(c, b, p):
    r = c.r
    if p == "M-019":
        if c.alt:
            s = (
                f"Коэффициент застройки участка составляет {_kz_s(c, b)} при допустимом по ГПЗУ не более "
                f"{c.n(b['kzlim'] / 100, 2, trim=True)}."
            )
        else:
            s = f"Процент застройки — {_kz_s(c, b)} % (не более {c.n(b['kzlim'], 0)} % по ГПЗУ)."
        tr = T(b["kz"], limit=b["kzlim"])
    else:
        if c.alt:
            s = (
                f"Коэффициент плотности застройки — {_kit_s(c, b)} (максимальный по ГПЗУ — "
                f"{c.n(b['kitlim'] / 100, 2, trim=True)})."
            )
        else:
            s = f"Коэффициент использования территории — {_kit_s(c, b)} % при предельном {c.n(b['kitlim'], 0)} %."
        tr = T(b["kit"], limit=b["kitlim"])
    s2 = f"Площадь земельного участка — {c.n(b['P'], 0)} {c.ua}."
    body = [
        r.choice(
            [
                "Обоснование планировочной организации",
                "Схема планировочной организации участка",
            ]
        )
    ]
    body += _wrap(r, _j(*r.sample([s, s2], 2)))
    return _page(c, b, "ПЗУ", "Пояснительная записка", body), tr


def m020_density(c, b):
    r = c.r
    rows = [
        _r_plot(c, b),
        _r_area(c, b),
        _r_gross(c, b),
        ("Плотность застройки", "тыс. м²/га", c.n(b["kit"] / 10, b["dkit"] + 1)),
    ]
    body = _tep(c, rows, "unitcol", "Показатели по генеральному плану")
    return _page(c, b, "ГП", "Общие данные", body), T(b["kit"])


# ---------------------------------------------------------------- M-132


def _chapters(r, sub):
    others = [x for x in CHAPTERS if x[0] != 2]
    ch = sorted([CHAPTERS[1]] + r.sample(others, r.randint(3, 6)))
    w = [r.uniform(6, 10) if n == 2 else r.uniform(0.2, 1.2) for n, _, _ in ch]
    out = []
    for (n, name, cols), t in zip(ch, _split(sub, w)):
        vals = [0, 0, 0, 0]
        ks = ["smop".index(x) for x in cols]
        for kk, v in zip(ks, _split(t, [r.uniform(0.3, 1.0) for _ in ks])):
            vals[kk] = v
        out.append((n, name, vals, t))
    return out


def _ssr(c, b, mode):
    """ССР. mode: full (с НДС и без), itog (итог без упоминания НДС), rub (в рублях), split (числа строкой ниже)."""
    r = c.r
    sub, cont, base, vat, incl, _ = _cost(b)
    rub = mode == "rub"
    unit = "руб." if rub else "тыс. руб."

    def m(v):
        return c.n(v * 10, 2) if rub else c.n(v / 100, 2)

    body = [
        r.choice(
            [
                "СВОДНЫЙ СМЕТНЫЙ РАСЧЁТ СТОИМОСТИ СТРОИТЕЛЬСТВА",
                "Сводный сметный расчёт стоимости строительства",
            ]
        ),
        f"Составлен в текущем уровне цен по состоянию на {b['q']} квартал {b['year']} г.",
    ]
    if r.random() < 0.5:
        body.append(f"({unit})")
        hu = ""
    else:
        hu = f", {unit}"
    body += [
        f"№ Номера сметных Наименование глав, объектов, работ и затрат Сметная стоимость{hu} Общая сметная",
        f"п/п расчётов и смет строительных монтажных оборудования, прочих затрат стоимость{hu}",
        "работ работ мебели и инвентаря",
        "1 2 3 4 5 6 7 8",
    ]
    chs = _chapters(r, sub)
    colsum = [sum(x[2][i] for x in chs) for i in range(4)]
    for i, (n, name, vals, t) in enumerate(c.rows(chs), 1):
        cells = [m(v) if v else "-" for v in vals] + [m(t)]
        lab = f"Глава {n}. {name}"
        code = r.choice([f"ОСР-{n:02d}", f"{n:02d}-01", ""])
        if mode == "split":
            body += [_j(str(i), code, lab), " ".join(cells)]
        elif len(lab) > 44 and r.random() < 0.7:
            k = lab.rfind(" ", 0, 36)
            body += [_j(str(i), code, lab[:k], *cells), lab[k + 1 :]]
        else:
            body.append(_j(str(i), code, lab, *cells))

    def line(lbl, v, cols=None):
        cells = [m(x) if x else "-" for x in cols] if cols else []
        if mode == "split":
            body.extend([lbl, " ".join(cells + [m(v)])])
        else:
            body.append(_j(lbl, *cells, m(v)))

    line("Итого по главам 1–12", sub, colsum)
    line(
        r.choice(
            [
                f"Резерв средств на непредвиденные работы и затраты {b['cpct']} %",
                f"Непредвиденные затраты {b['cpct']}%",
            ]
        ),
        cont,
    )
    if mode == "itog":
        line(r.choice(["Итого по сводному сметному расчёту", "Итого по ССР"]), base)
        tr = T(base / 100)
    else:
        line(
            r.choice(
                [
                    "Итого без НДС",
                    "Итого по сводному сметному расчёту без учёта НДС",
                    "Итого (без НДС)",
                ]
            ),
            base,
        )
        line(f"НДС {b['vatr']} %", vat)
        line(
            r.choice(
                [
                    "Всего по сводному сметному расчёту с учётом НДС",
                    "Всего с НДС",
                    "ВСЕГО по ССР с НДС",
                ]
            ),
            incl,
        )
        v = b["variant"]
        tr = T(incl / 100 if v == "vat_incl" else base / 100, variant=v)
    body += [
        f"Главный инженер проекта {r.choice(SURN)}",
        f"Начальник сметного отдела {r.choice(SURN)}",
    ]
    return _page(c, b, "СМ", "Сводный сметный расчёт", body), tr


def m132_prose(c, b):
    r = c.r
    _, _, base, vat, incl, basis = _cost(b)
    if b["variant"] == "vat_incl":
        s = (
            f"Сметная стоимость строительства в текущих ценах {b['q']} квартала {b['year']} г. составляет "
            f"{c.n(incl / 100, 2)} тыс. руб. с учётом НДС {b['vatr']} % (НДС — {c.n(vat / 100, 2)} тыс. руб.)."
        )
        tr = T(incl / 100, variant="vat_incl")
    else:
        s = (
            f"Сметная стоимость строительства в текущем уровне цен ({b['q']} кв. {b['year']} г.) — "
            f"{c.n(base / 100, 2)} тыс. руб. без учёта НДС; НДС {b['vatr']} % — {c.n(vat / 100, 2)} тыс. руб."
        )
        tr = T(base / 100, variant="vat_excl")
    s2 = f"Стоимость строительства в базисном уровне цен 2001 г. — {c.n(basis / 100, 2)} тыс. руб."
    body = [
        r.choice(["Сведения о сметной стоимости", "12. Смета на строительство"])
    ] + _wrap(r, _j(*r.sample([s, s2], 2)))
    return _page(c, b, "ПЗ", "Пояснительная записка", body), tr


def m132_basis_current(c, b):
    r = c.r
    _, _, base, vat, incl, basis = _cost(b)
    bvat = round(basis * b["vatr"] / 100)
    swap = r.random() < 0.4
    h1, h2 = (
        "в базисном уровне цен 2001 г.",
        f"в текущем уровне цен {b['q']} кв. {b['year']} г.",
    )
    hs = (h2, h1) if swap else (h1, h2)
    body = ["Сводка затрат", r.choice(["(тыс. руб.)", "тыс. руб."])]
    if r.random() < 0.5:
        body.append(f"Наименование Стоимость {hs[0]} Стоимость {hs[1]}")
    else:
        body += ["Наименование Стоимость Стоимость", f"{hs[0]} {hs[1]}"]
    rows = [
        ("Итого по сводному сметному расчёту без НДС", basis, base),
        (f"НДС {b['vatr']} %", bvat, vat),
        ("Всего с учётом НДС", basis + bvat, incl),
    ]
    for lbl, x, y in c.rows(rows):
        a, z = (y, x) if swap else (x, y)
        body.append(_j(lbl, c.n(a / 100, 2), c.n(z / 100, 2)))
    v = b["variant"]
    tr = T(incl / 100 if v == "vat_incl" else base / 100, variant=v)
    return _page(c, b, "СМ", "Сводка затрат", body), tr


def m132_valnext(c, b):
    r = c.r
    sub, _, base, _, incl, _ = _cost(b)
    body = ["Пояснительная записка к сметной документации"]
    body += _wrap(
        r,
        f"Сметная документация составлена ресурсно-индексным методом в уровне цен {b['q']} квартала "
        f"{b['year']} г. Норматив непредвиденных затрат — {b['cpct']} %.",
    )
    if b["variant"] == "vat_incl":
        body += [
            "Всего по сводному сметному расчёту",
            f"с учётом НДС {b['vatr']} %, тыс. руб.",
            c.n(incl / 100, 2),
        ]
        tr = T(incl / 100, variant="vat_incl")
    else:
        body += ["Итого по сводному сметному", "расчёту, тыс. руб.", c.n(base / 100, 2)]
        tr = T(base / 100)
    body += _wrap(
        r,
        f"В том числе стоимость оборудования — {c.n(sub * r.uniform(0.1, 0.3) / 100, 2)} тыс. руб.",
    )
    return _page(c, b, "СМ", "Пояснительная записка", body), tr


def m132_basis_only(c, b):
    r = c.r
    _, _, _, _, _, basis = _cost(b)
    body = [
        "СВОДНЫЙ СМЕТНЫЙ РАСЧЁТ СТОИМОСТИ СТРОИТЕЛЬСТВА",
        "Составлен в базисном уровне цен по состоянию на 01.01.2001",
        "(тыс. руб.)",
    ]
    for i, (n, name, _, t) in enumerate(_chapters(r, basis), 1):
        body.append(_j(str(i), f"Глава {n}. {name}", c.n(t / 100, 2)))
    body.append(
        _j("Итого по сводному сметному расчёту в базисных ценах", c.n(basis / 100, 2))
    )
    return _page(c, b, "СМ", "Сводный сметный расчёт", body), T()


def m132_local(c, b):
    r = c.r
    direct = r.randint(50_000, 9_000_000)  # сотые тыс. руб.
    nr = round(direct * r.uniform(0.08, 0.14))
    sp = round(direct * r.uniform(0.05, 0.09))
    tot = direct + nr + sp
    vat = round(tot * b["vatr"] / 100)
    body = [
        f"ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЁТ (СМЕТА) № 02-01-{r.randint(1, 9):02d}",
        r.choice(
            [
                "на общестроительные работы",
                "на внутренние системы отопления и вентиляции",
            ]
        ),
        f"Составлен в текущем уровне цен {b['q']} квартала {b['year']} г.",
        "(тыс. руб.)",
        _j("Итого прямые затраты", c.n(direct / 100, 2)),
        _j("Накладные расходы", c.n(nr / 100, 2)),
        _j("Сметная прибыль", c.n(sp / 100, 2)),
        _j("Итого по смете", c.n(tot / 100, 2)),
        _j(f"НДС {b['vatr']} %", c.n(vat / 100, 2)),
        _j("Всего по смете с НДС", c.n((tot + vat) / 100, 2)),
    ]
    return _page(c, b, "СМ", "Локальный сметный расчёт", body), T()


# ---------------------------------------------------------------- реестр форм


def _reg():
    R = {p: [] for p in PARAMS}

    def add(p, cls, fn, kind="pos", rows=False, lim=False, variants=(None,)):
        R[p].append(
            {
                "cls": cls,
                "fn": fn,
                "kind": kind,
                "rows": rows,
                "lim": lim,
                "variants": variants,
            }
        )

    def tep(p, style, kind="pos"):
        add(
            p,
            "tep_" + style,
            lambda c, b: _tep_fn(c, b, p, style),
            kind=kind,
            rows=True,
        )

    def nulls(p, *extra):
        add(p, "change_record_only", lambda c, b: _chg(c, b, p), kind="null")
        if "noexist" not in extra:
            add(p, "existing_only", lambda c, b: _exist(c, b, p), kind="null")

    # M-001
    for s in ("unitcol", "unitname", "valnext", "wrap"):
        tep("M-001", s)
    add("M-001", "gp_balance_unit_in_header", m001_balance, rows=True)
    add("M-001", "prose_pz", m001_prose)
    add(
        "M-001",
        "recon_existing_vs_design",
        lambda c, b: _recon(c, b, "M-001"),
        rows=True,
    )
    add("M-001", "gpzu_vs_project", lambda c, b: _gpzu_tab(c, b, "M-001"), rows=True)
    nulls("M-001")
    add(
        "M-001", "gpzu_limits_only", lambda c, b: _gpzu_only(c, b, "M-001"), kind="null"
    )
    # M-004, M-006
    for p in ("M-004", "M-006"):
        for s in ("unitcol", "unitname", "valnext", "wrap"):
            tep(p, s)
        add(p, "unit_in_header_three_numbers", lambda c, b, p=p: _hdr_vol(c, b, p))
        add(p, "sections_total", lambda c, b, p=p: _sections(c, b, p), rows=True)
        add(p, "prose_pz", lambda c, b, p=p: _prose_vol(c, b, p))
        add(p, "recon_existing_vs_design", lambda c, b, p=p: _recon(c, b, p), rows=True)
        nulls(p)
    # M-005
    tep("M-005", "unitcol", kind="vol")
    tep("M-005", "valnext", kind="vol")
    add(
        "M-005",
        "unit_in_header_three_numbers",
        lambda c, b: _hdr_vol(c, b, "M-005"),
        kind="vol",
    )
    add("M-005", "kzh_notes_bottom_mark", m005_kzh, kind="depth")
    add("M-005", "section_marks", m005_section, kind="depth")
    add("M-005", "depth_of_foundation", m005_zalozh, kind="depth")
    add("M-005", "pit_bottom_pos", m005_kotlovan, kind="depth")
    add("M-005", "prose_underground", m005_pz_prose, kind="both")
    add("M-005", "tep_with_depth_row", m005_tep_depth, kind="both", rows=True)
    add("M-005", "ar_general_data", m005_ar_od, kind="both", rows=True)
    add("M-005", "kr_foundation_prose", m005_kr_pz, kind="both")
    add("M-005", "change_record_only", lambda c, b: _chg(c, b, "M-005"), kind="null")
    add("M-005", "existing_only", m005_exist, kind="null")
    # M-008
    for s in ("unitcol", "unitname", "valnext"):
        tep("M-008", s)
    add("M-008", "facade_marks", m008_facade)
    add("M-008", "prose_with_fire_height", m008_prose)
    add("M-008", "gpzu_vs_project", lambda c, b: _gpzu_tab(c, b, "M-008"), rows=True)
    add(
        "M-008",
        "recon_existing_vs_design",
        lambda c, b: _recon(c, b, "M-008"),
        rows=True,
    )
    add("M-008", "ar_general_data_mm", m008_ar_od)
    nulls("M-008")
    add(
        "M-008", "gpzu_limits_only", lambda c, b: _gpzu_only(c, b, "M-008"), kind="null"
    )
    # M-009
    tep("M-009", "unitcol")
    tep("M-009", "valnext")
    add("M-009", "ar_general_note", m009_ar_note)
    add("M-009", "gp_legend", m009_gp_legend)
    add("M-009", "kzh_with_bottom_abs", m009_kzh)
    add("M-009", "survey_wells", m009_igi)
    add("M-009", "label_value_below", m009_valnext)
    add("M-009", "section_zero_abs", m009_section_abs)
    nulls("M-009")
    add("M-009", "relative_marks_only", m009_relative_only, kind="null")
    # M-013
    for s in ("unitcol", "unitname", "valnext"):
        tep("M-013", s)
    add("M-013", "prose_phases", m013_prose)
    add("M-013", "tx_section", m013_tx)
    add("M-013", "capacity_in_object_name", m013_name, rows=True)
    add(
        "M-013",
        "recon_existing_vs_design",
        lambda c, b: _recon(c, b, "M-013"),
        rows=True,
    )
    nulls("M-013")
    add("M-013", "power_only", m013_power_only, kind="null")
    # M-019, M-020
    for p in ("M-019", "M-020"):
        tep(p, "unitcol")
        tep(p, "valnext")
        add(
            p,
            "kz_next_to_kit" if p == "M-019" else "kit_next_to_kz",
            lambda c, b, p=p: _gp_coef(c, b, p),
            rows=True,
        )
        add(
            p,
            "gpzu_vs_project",
            lambda c, b, p=p: _gpzu_tab(c, b, p),
            rows=True,
            lim=True,
        )
        add(p, "gpzu_block_and_project", lambda c, b, p=p: _lim_rows(c, b, p), lim=True)
        add(p, "prose_with_limit", lambda c, b, p=p: _prose_lim(c, b, p), lim=True)
        add(p, "recon_existing_vs_design", lambda c, b, p=p: _recon(c, b, p), rows=True)
        if p == "M-020":
            add(p, "density_thousand_m2_per_ha", m020_density, rows=True)
        add(p, "gpzu_limits_only", lambda c, b, p=p: _gpzu_only(c, b, p), kind="null")
        nulls(p)
    # M-132
    both = ("vat_incl", "vat_excl")
    add("M-132", "ssr_full", lambda c, b: _ssr(c, b, "full"), rows=True, variants=both)
    add("M-132", "ssr_itog_no_vat_mention", lambda c, b: _ssr(c, b, "itog"), rows=True)
    add("M-132", "ssr_rub", lambda c, b: _ssr(c, b, "rub"), rows=True, variants=both)
    add(
        "M-132",
        "ssr_numbers_below_labels",
        lambda c, b: _ssr(c, b, "split"),
        rows=True,
        variants=both,
    )
    add("M-132", "prose_with_basis_2001", m132_prose, variants=both)
    add(
        "M-132",
        "basis_and_current_columns",
        m132_basis_current,
        rows=True,
        variants=both,
    )
    add("M-132", "label_value_below", m132_valnext, variants=("vat_incl", None))
    add("M-132", "basis_2001_only", m132_basis_only, kind="null")
    add("M-132", "local_estimate_only", m132_local, kind="null")
    add("M-132", "change_record_only", lambda c, b: _chg(c, b, "M-132"), kind="null")
    return R


REND = _reg()


# ---------------------------------------------------------------- шум OCR

_LAT = str.maketrans(
    {
        "о": "o",
        "е": "e",
        "с": "c",
        "а": "a",
        "р": "p",
        "х": "x",
        "О": "O",
        "С": "C",
        "Е": "E",
        "А": "A",
        "Р": "P",
        "Н": "H",
        "К": "K",
        "М": "M",
        "Т": "T",
    }
)
_UNIT_AFTER = r"(?=(?:м²|м³|м2|м3|мм|м|кв\.|куб\.|%|тыс\.|руб\.|мест|коек|т/год|га)(?![А-Яа-яЁё]))"


def _ocr(r, lines):
    """Шум другого OCR: пробелы, буквы, индексы, переносы. Цифры и знаки чисел не меняются."""
    L = list(lines)
    ops = r.sample(
        ["glue", "numunit", "split", "digits", "sup", "spaces", "hyph", "latin"],
        r.randint(2, 4),
    )
    for op in ops:
        if op == "glue":
            for _ in range(r.randint(1, 3)):
                i = r.randrange(len(L))
                ms = [
                    m.start()
                    for m in re.finditer(r"(?<=[А-Яа-яЁё]) (?=[А-Яа-яЁё\d])", L[i])
                ]
                if ms:
                    k = r.choice(ms)
                    L[i] = L[i][:k] + L[i][k + 1 :]
        elif op == "numunit":
            L = [re.sub(r"(\d)[  ]" + _UNIT_AFTER, r"\1", s) for s in L]
        elif op == "split":
            for _ in range(r.randint(1, 2)):
                i = r.randrange(len(L))
                s = L[i]
                ks = [
                    m.start()
                    for m in re.finditer(" ", s)
                    if not (
                        0 < m.start() < len(s) - 1
                        and s[m.start() - 1].isdigit()
                        and s[m.start() + 1].isdigit()
                    )
                ]
                if len(ks) >= 2:
                    k = r.choice(ks)
                    L[i : i + 1] = [s[:k], s[k + 1 :]]
        elif op == "digits":
            L = [
                re.sub(
                    r"(?<=\d)[   ](?=\d{3}(?!\d))",
                    lambda m: r.choice(["  ", "  ", "  ", "   "]),
                    s,
                )
                for s in L
            ]
        elif op == "sup":
            a2, a3 = r.choice([("2", "3"), ("^2", "^3"), ("'", "'")])
            L = [s.replace("²", a2).replace("³", a3) for s in L]
        elif op == "spaces":
            for i in r.sample(range(len(L)), min(len(L), r.randint(2, 6))):
                L[i] = re.sub(
                    r"(?<!\d) | (?!\d)", lambda m: " " * r.choice([1, 1, 2, 3, 4]), L[i]
                )
        elif op == "hyph":
            i = r.randrange(len(L))
            ws = list(re.finditer(r"[А-Яа-яЁё]{8,}", L[i]))
            if ws:
                m = r.choice(ws)
                k = m.start() + r.randint(3, len(m.group()) - 3)
                s = L[i]
                L[i : i + 1] = [s[:k] + "-", s[k:]]
        elif op == "latin":
            for i in r.sample(range(len(L)), min(len(L), r.randint(1, 4))):
                ws = list(re.finditer(r"[А-Яа-яЁё]{5,}", L[i]))
                if ws:
                    m = r.choice(ws)
                    L[i] = (
                        L[i][: m.start()] + m.group().translate(_LAT) + L[i][m.end() :]
                    )
    return [s for s in L if s.strip()]


# ---------------------------------------------------------------- выборка страниц


def samples(seed: int, n_per_param: int) -> list[dict]:
    r = random.Random(f"holdout2-samples:{seed}")
    out = []
    for p in PARAMS:
        rends = REND[p]
        order = []
        while len(order) < n_per_param:
            idx = list(range(len(rends)))
            r.shuffle(idx)
            order += idx
        for i in range(n_per_param):
            rd = rends[order[i]]
            b = _building(r, need_cap=(p == "M-013"))
            b["variant"] = r.choice(rd["variants"])
            c = Pg(r.getrandbits(40), r.choice("ПР"))
            lines, t = rd["fn"](c, b)
            aspect = None
            if p == "M-005":
                if t["depth"] is not None and (t["value"] is None or r.random() < 0.5):
                    aspect = "depth"
                elif t["value"] is None and t["depth"] is None and r.random() < 0.5:
                    aspect = "depth"
            truth = t["depth"] if aspect == "depth" else t["value"]
            cls = rd["cls"]
            if r.random() < 0.25:
                lines = _ocr(r, lines)
                cls += "+ocr"
            out.append(
                {
                    "id": f"h2-{p}-{i:03d}",
                    "param": p,
                    "aspect": aspect,
                    "lines": lines,
                    "truth": truth,
                    "variant": t["variant"] if truth is not None else None,
                    "limit": t["limit"],
                    "cls": cls,
                }
            )
    return out


# ---------------------------------------------------------------- пары ПД → РД

NEG = {
    "M-001": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
    ],
    "M-004": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
    ],
    "M-005": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
    ],
    "M-006": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
    ],
    "M-008": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
        "better",
    ],
    "M-009": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
    ],
    "M-013": ["same_other_format", "rows_reordered", "other_document_form", "better"],
    "M-019": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
        "better",
    ],
    "M-020": [
        "same_other_format",
        "rows_reordered",
        "other_document_form",
        "within_tolerance",
        "better",
    ],
    "M-132": [
        "rub_vs_tys",
        "rows_reordered",
        "other_document_form",
        "growth_within_5pct",
        "decrease",
        "vat_incl_vs_excl",
    ],
}
POS = {
    "M-001": ["small_change", "large_change", "change_other_format"],
    "M-004": ["small_change", "large_change", "change_other_format"],
    "M-005": [
        "depth_small",
        "depth_large",
        "volume_small",
        "volume_large",
        "change_other_format",
    ],
    "M-006": ["small_change", "large_change", "change_other_format"],
    "M-008": ["small_increase", "large_increase", "change_other_format"],
    "M-009": ["small_change", "large_change", "change_other_format"],
    "M-013": ["small_decrease", "large_decrease", "change_other_format"],
    "M-019": [
        "small_increase",
        "large_increase",
        "change_other_format",
        "limit_breach",
    ],
    "M-020": [
        "small_increase",
        "large_increase",
        "change_other_format",
        "limit_breach",
    ],
    "M-132": ["growth_above_5pct", "large_growth", "growth_in_rub"],
}
ALT_PARAMS = ("M-005", "M-008", "M-019", "M-020")


def _label(p, a, b):
    """Правило Матрицы: True — CANDIDATE."""
    if p in ("M-001", "M-004", "M-006"):
        return abs(b["value"] - a["value"]) > 0.05
    if p == "M-009":
        return abs(b["value"] - a["value"]) > 0.005
    if p == "M-005":
        return (
            abs(b["value"] - a["value"]) > 0.05 or abs(b["depth"] - a["depth"]) > 0.005
        )
    if p == "M-008":
        return b["value"] - a["value"] > 0.005
    if p == "M-013":
        return a["value"] - b["value"] > 0.5
    if p in ("M-019", "M-020"):
        lim = a["limit"] if a["limit"] is not None else b["limit"]
        if b["value"] - a["value"] > 0.05:
            return True
        return lim is not None and max(a["value"], b["value"]) > lim + 0.05
    if a["variant"] != b["variant"]:
        return False
    return (b["value"] - a["value"]) / a["value"] > 0.05


_DEC = {
    "M-001": ("dA",),
    "M-004": ("dV",),
    "M-006": ("dV",),
    "M-005": ("dV", "dD"),
    "M-008": ("dH",),
    "M-009": ("dZ",),
    "M-013": (),
    "M-019": ("dkz",),
    "M-020": ("dkit",),
}
_FINE = {"dA": 2, "dV": 2, "dD": 3, "dH": 3, "dZ": 3, "dkz": 2, "dkit": 2}
_VAL = {"dA": "A", "dD": "D", "dH": "H", "dZ": "Z", "dkz": "kz", "dkit": "kit"}


def _set_dec(b, dk, d):
    """Смена числа знаков: значение уже представимо, число не меняется."""
    b[dk] = d
    if dk == "dV":
        b["Va"] = round(b["Va"], d)
        b["Vb"] = round(b["Vb"], d)
    else:
        b[_VAL[dk]] = round(b[_VAL[dk]], d)


def _shift(b, p, delta, aspect=None):
    if p == "M-004" or (p == "M-005" and aspect != "depth") or p == "M-006":
        key = {"M-004": "Va", "M-005": "Vb", "M-006": "Va"}[p]
        b[key] = round(b[key] + delta, b["dV"])
    elif p == "M-005":
        b["D"] = round(b["D"] + delta, b["dD"])
    elif p == "M-013":
        b["cap"] = int(round(b["cap"] + delta))
    else:
        dk = _DEC[p][0]
        b[_VAL[dk]] = round(b[_VAL[dk]] + delta, b[dk])


def _value(b, p):
    return {
        "M-001": lambda: b["A"],
        "M-004": lambda: _vt(b),
        "M-006": lambda: b["Va"],
        "M-008": lambda: b["H"],
        "M-009": lambda: b["Z"],
        "M-013": lambda: b["cap"],
        "M-019": lambda: b["kz"],
        "M-020": lambda: b["kit"],
        "M-005": lambda: b["Vb"],
    }[p]()


def _deltas(r, b, p, kind):
    """kind: small | large | within | better. Возвращает список (aspect, delta)."""
    sg = r.choice((-1, 1))
    v = _value(b, p)
    if kind == "within":
        if p == "M-005":
            return [
                (None, sg * round(r.uniform(0.01, 0.04), 2)),
                ("depth", r.choice((-1, 1)) * round(r.uniform(0.001, 0.004), 3)),
            ]
        if p == "M-008":
            return [(None, round(r.uniform(0.001, 0.004), 3))]
        if p == "M-009":
            return [(None, sg * round(r.uniform(0.001, 0.004), 3))]
        if p in ("M-019", "M-020"):
            return [(None, round(r.uniform(0.01, 0.04), 2))]
        return [(None, sg * round(r.uniform(0.01, 0.04), 2))]
    if kind == "better":
        if p == "M-008":
            return [(None, -round(r.uniform(0.1, 2.5), 2))]
        if p == "M-013":
            return [(None, max(1, round(v * r.uniform(0.02, 0.15))))]
        if p == "M-019":
            return [(None, -max(0.5, round(r.uniform(0.5, 5), b["dkz"])))]
        return [(None, -float(r.randint(5, 40)))]
    if kind == "small":
        return [
            (
                None,
                {
                    "M-008": lambda: round(r.uniform(0.01, 0.05), 2),
                    "M-009": lambda: sg * round(r.uniform(0.01, 0.03), 2),
                    "M-013": lambda: -r.randint(1, 3),
                    "M-019": lambda: round(r.uniform(0.1, 0.5), 1),
                    "M-020": lambda: float(r.randint(1, 5)),
                }.get(p, lambda: sg * round(r.uniform(0.1, 0.4), 1))(),
            )
        ]
    return [
        (
            None,
            {
                "M-008": lambda: r.uniform(1.5, 9),
                "M-009": lambda: sg * r.uniform(0.3, 2.5),
                "M-013": lambda: -max(2, round(v * r.uniform(0.1, 0.35))),
                "M-019": lambda: min(r.uniform(3, 10), 95 - v),
                "M-020": lambda: float(r.randint(20, 90)),
            }.get(p, lambda: sg * v * r.uniform(0.05, 0.25))(),
        )
    ]


def _pair_num(r, p, mut, b, c1, c2):
    kind = "both" if p == "M-005" else "pos"
    el = [x for x in REND[p] if x["kind"] == kind]
    rd1 = r.choice(el)
    rd2 = rd1

    def other(x):
        return r.choice([y for y in el if y is not x])

    ds = []
    if mut == "rows_reordered":
        rd1 = rd2 = r.choice([x for x in el if x["rows"]])
        c2.shuffle = True
    elif mut == "other_document_form":
        rd2 = other(rd1)
    elif mut == "limit_breach":
        rd1 = r.choice([x for x in el if x["lim"]])
        rd2 = r.choice(el)
        if p == "M-019":
            lim = float(r.choice([30, 35, 40, 45, 50]))
            b["kzlim"] = lim
            b["kz"] = round(lim + r.uniform(1.5, 8), b["dkz"])
        else:
            lim = float(r.choice([150, 200, 240, 300]))
            b["kitlim"] = lim
            b["kit"] = float(lim + r.randint(10, 60))
    elif mut == "within_tolerance":
        for dk in _DEC[p]:
            _set_dec(b, dk, max(b[dk], _FINE[dk]))
        if p in ("M-019", "M-020"):
            c1.alt = c2.alt = False
        ds = _deltas(r, b, p, "within")
    elif mut == "better":
        ds = _deltas(r, b, p, "better")
    elif mut != "same_other_format":
        # small_*, large_*, depth_*, volume_*, change_other_format
        if mut == "change_other_format":
            size = r.choice(["small", "large"])
        else:
            size = "small" if "small" in mut else "large"
        if size == "small":
            for dk in _DEC[p]:
                if dk in ("dA", "dV", "dkz"):
                    _set_dec(b, dk, max(b[dk], 1))
        if p == "M-005":
            aspect = (
                "depth"
                if (
                    mut.startswith("depth")
                    or (mut == "change_other_format" and r.random() < 0.5)
                )
                else None
            )
            if aspect == "depth":
                d = (
                    r.choice((-1, 1)) * round(r.uniform(0.01, 0.05), 2)
                    if size == "small"
                    else -round(r.uniform(0.3, 1.5), 2)
                )
            else:
                d = (
                    r.choice((-1, 1)) * round(r.uniform(0.1, 0.4), 1)
                    if size == "small"
                    else r.choice((-1, 1)) * b["Vb"] * r.uniform(0.05, 0.25)
                )
            ds = [(aspect, d)]
        else:
            ds = _deltas(r, b, p, size)
        if mut == "change_other_format":
            rd2 = other(rd1)
    b2 = copy.deepcopy(b)
    if mut in ("same_other_format", "change_other_format"):
        _restyle(c2, r)
        if p in ALT_PARAMS:
            c2.alt = not c1.alt
    if mut == "same_other_format":
        for dk in _DEC[p]:
            b2[dk] = min(b2[dk] + 1, 3)
        if p == "M-013":
            rd2 = other(rd1)
    for aspect, d in ds:
        _shift(b2, p, d, aspect)
    l1, t1 = rd1["fn"](c1, b)
    l2, t2 = rd2["fn"](c2, b2)
    return l1, l2, t1, t2, rd1["cls"], rd2["cls"]


def _pair_cost(r, p, mut, b, c1, c2):
    el = [x for x in REND[p] if x["kind"] == "pos"]
    rub = next(x for x in el if x["cls"] == "ssr_rub")
    v = r.choice(["vat_incl", "vat_excl", None])
    if mut in ("rub_vs_tys", "growth_in_rub") and v is None:
        v = r.choice(["vat_incl", "vat_excl"])
    b["variant"] = v
    ok = [x for x in el if v in x["variants"]]
    rd1 = r.choice(ok)
    rd2 = rd1
    b2 = copy.deepcopy(b)
    sub = b["sub_c"]
    if mut in ("rub_vs_tys", "growth_in_rub"):
        rd1 = r.choice([x for x in ok if x is not rub])
        rd2 = rub
        _restyle(c2, r)
        if mut == "growth_in_rub":
            b2["sub_c"] = int(round(sub * (1 + r.uniform(0.06, 0.3))))
    elif mut == "rows_reordered":
        rd1 = rd2 = r.choice([x for x in ok if x["rows"]])
        c2.shuffle = True
    elif mut == "other_document_form":
        rd2 = r.choice([x for x in ok if x is not rd1])
    elif mut == "growth_within_5pct":
        b2["sub_c"] = int(round(sub * (1 + r.uniform(0.005, 0.04))))
    elif mut == "decrease":
        b2["sub_c"] = int(round(sub * (1 - r.uniform(0.02, 0.25))))
    elif mut == "vat_incl_vs_excl":
        b["variant"] = "vat_incl"
        b2["variant"] = "vat_excl"
        rd1 = r.choice([x for x in el if "vat_incl" in x["variants"]])
        rd2 = r.choice([x for x in el if "vat_excl" in x["variants"]])
    elif mut == "growth_above_5pct":
        b2["sub_c"] = int(round(sub * (1 + r.uniform(0.056, 0.075))))
    elif mut == "large_growth":
        b2["sub_c"] = int(round(sub * (1 + r.uniform(0.15, 0.6))))
        if r.random() < 0.5:
            rd2 = r.choice(ok)
    l1, t1 = rd1["fn"](c1, b)
    l2, t2 = rd2["fn"](c2, b2)
    return l1, l2, t1, t2, rd1["cls"], rd2["cls"]


def pairs(seed: int, n_per_param: int) -> list[dict]:
    r = random.Random(f"holdout2-pairs:{seed}")
    out = []
    for p in PARAMS:
        neg, pos = list(NEG[p]), list(POS[p])
        r.shuffle(neg)
        r.shuffle(pos)
        for i in range(n_per_param):
            is_pos = i % 2 == 1
            lst = pos if is_pos else neg
            mut = lst[(i // 2) % len(lst)]
            b = _building(r, need_cap=(p == "M-013"))
            seed_pg = r.getrandbits(40)
            c1, c2 = Pg(seed_pg, "П"), Pg(seed_pg, "Р")
            if p == "M-132":
                l1, l2, t1, t2, k1, k2 = _pair_cost(r, p, mut, b, c1, c2)
            else:
                l1, l2, t1, t2, k1, k2 = _pair_num(r, p, mut, b, c1, c2)
            cand = _label(p, t1, t2)
            if cand != is_pos:
                raise AssertionError(
                    f"holdout2: {p} {mut}: правило дало {cand}, ожидалось {is_pos}: {t1} {t2}"
                )
            cls = f"{k1}|{k2}"
            if r.random() < 0.25:
                which = r.choice(["pd", "rd", "both"])
                if which in ("pd", "both"):
                    l1 = _ocr(r, l1)
                if which in ("rd", "both"):
                    l2 = _ocr(r, l2)
                cls += "+ocr"
            out.append(
                {
                    "id": f"h2p-{p}-{i:03d}",
                    "param": p,
                    "pd_lines": l1,
                    "rd_lines": l2,
                    "pd_truth": t1,
                    "rd_truth": t2,
                    "label": "CANDIDATE" if cand else "NEGATIVE_VERIFIED",
                    "mutation": mut,
                    "cls": cls,
                }
            )
    return out
