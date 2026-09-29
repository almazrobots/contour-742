"""T-173: отложенный (holdout) генератор синтетических страниц ПД/РД.

Моделирует текстовый слой PDF: страница = список строк в порядке чтения.
Все объекты, шифры, фамилии и числа вымышлены (ADR-0002: корпус не используется).
Генератор написан независимо от экстрактора — по тому, как оформляют
ТЭП в ПЗ (Постановление № 87), «Общие данные» АР/ГП (ГОСТ Р 21.101),
Сводный сметный расчёт и ГПЗУ.

Только стандартная библиотека, детерминизм по seed.
"""

from __future__ import annotations

import copy
import random
import re
from collections import Counter

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
THIN = " "
MINUS = "−"

# ---------------------------------------------------------------------------
# Форматирование чисел
# ---------------------------------------------------------------------------


def _min_dp(x: float, cap: int = 3) -> int:
    """Минимальное число знаков после запятой, при котором x записан точно."""
    for d in range(cap + 1):
        if abs(round(x, d) - x) < 1e-9:
            return d
    return cap


def _num(
    x: float, fs: dict, dp: int | None = None, sign: bool = False, cap: int = 3
) -> str:
    """Число в «проектной» записи: разряды пробелом/NBSP/без, запятая или точка."""
    if dp is None:
        dp = min(_min_dp(x, cap) + fs["pad"], max(cap, _min_dp(x, cap)))
    s = f"{abs(x):,.{dp}f}"
    ip, _, fp = s.partition(".")
    groups = ip.split(",")
    if len(groups) == 2 and len(ip) == 5 and not fs["g4"]:
        ip = "".join(groups)  # «2345,6» — четырёхзначные часто без разделителя
    else:
        ip = fs["gs"].join(groups)
    out = ip + (fs["ds"] + fp if dp else "")
    if x < 0:
        out = fs["minus"] + out
    elif sign:
        out = "+" + out
    return out


def _fs(rng: random.Random) -> dict:
    """Стиль оформления одного документа."""
    return {
        "gs": rng.choice([" ", " ", " ", NBSP, "", THIN]),
        "ds": rng.choice([",", ",", ",", "."]),
        "pad": rng.choice([0, 0, 0, 1]),
        "unit": rng.randrange(1000),
        "g4": rng.random() < 0.5,
        "minus": rng.choice(["-", "-", MINUS]),
        "sep": rng.choice([" ", " ", "  ", "   ", " | "]),
        "cost_unit": rng.choice(["тыс", "тыс", "тыс", "руб"]),
    }


def _fs_flip(rng: random.Random, fs: dict) -> dict:
    """Тот же документ, другая форма записи чисел и единиц."""
    f = dict(fs)
    f["ds"] = "." if fs["ds"] == "," else ","
    f["gs"] = rng.choice([g for g in [" ", NBSP, ""] if g != fs["gs"]])
    f["unit"] = fs["unit"] + 1
    f["pad"] = 1 - fs["pad"] if fs["pad"] in (0, 1) else 0
    f["g4"] = not fs["g4"]
    f["sep"] = rng.choice([s for s in [" ", "  ", " | "] if s != fs["sep"]])
    f["cost_unit"] = "руб" if fs["cost_unit"] == "тыс" else "тыс"
    return f


AREA_U = ["м2", "м²", "кв.м", "кв. м", "м2", "м²"]
VOL_U = ["м3", "м³", "куб.м", "куб. м", "м3"]

# ---------------------------------------------------------------------------
# Вымышленный объект
# ---------------------------------------------------------------------------

OBJ_TYPES = [
    (
        "Общеобразовательная школа",
        [
            ("Вместимость", "учащихся"),
            ("Проектная вместимость", "мест"),
            ("Количество учащихся", "уч."),
        ],
        (550, 1650),
        (3, 5),
    ),
    (
        "Детский сад",
        [
            ("Вместимость", "мест"),
            ("Количество детей", "детей"),
            ("Проектная мощность (вместимость)", "мест"),
        ],
        (110, 350),
        (2, 3),
    ),
    (
        "Поликлиника",
        [
            ("Мощность", "посещений в смену"),
            ("Пропускная способность", "пос./смену"),
            ("Мощность поликлиники", "посещ. в смену"),
        ],
        (250, 1200),
        (3, 7),
    ),
    (
        "Больничный корпус",
        [
            ("Коечный фонд", "коек"),
            ("Количество коек", "коек"),
            ("Мощность стационара", "коек"),
        ],
        (90, 480),
        (4, 9),
    ),
    (
        "Физкультурно-оздоровительный комплекс",
        [
            ("Единовременная пропускная способность", "чел./смену"),
            ("Пропускная способность", "посещений в смену"),
            ("Вместимость", "чел."),
        ],
        (120, 600),
        (2, 3),
    ),
    (
        "Производственный корпус",
        [
            ("Производственная мощность", "т/год"),
            ("Мощность по выпуску продукции", "тонн в год"),
            ("Проектная мощность", "т/год"),
        ],
        (4000, 65000),
        (1, 2),
    ),
]

CODE_PREFIX = ["ПРК", "СТР", "ГПИ", "АПМ", "НИП", "ЦПР", "ПСК", "ВМП"]
SURNAMES = [
    "Кожемякин",
    "Ларионова",
    "Тихомиров",
    "Бушуева",
    "Сафонов",
    "Климова",
    "Рябинин",
    "Гончаренко",
    "Мельников",
    "Федосеева",
    "Черкасов",
    "Абрамова",
]
TOWNS = [
    "г. Северогорск",
    "г. Приозёрск-Южный",
    "пос. Каменный Лог",
    "г. Новолесье",
    "г. Березняки-2",
]


def _obj(rng: random.Random) -> dict:
    t = rng.choice(OBJ_TYPES)
    floors = rng.randint(*t[3])
    A = round(rng.uniform(900, 6200), 1)
    if rng.random() < 0.3:
        A = float(round(A))
    site = round(A / rng.uniform(0.18, 0.52), 1)
    kz = round(A / site * 100, 1)
    gfa = round(A * floors * rng.uniform(0.84, 0.96), 1)
    kit = float(round(gfa / site * 100))
    fh = rng.choice([3.3, 3.6, 3.9, 4.2])
    H = round(floors * fh + rng.uniform(1.0, 2.6), 2)
    depth = -round(
        rng.choice([3.3, 3.6, 4.2, 4.5, 5.1, 6.3, 7.8])
        + rng.choice([0.0, 0.15, 0.3, 0.45, 0.6]),
        3,
    )
    Vu = float(round(A * H * rng.uniform(0.8, 0.95)))
    Vd = float(round(A * abs(depth) * rng.uniform(0.55, 0.9)))
    if rng.random() < 0.3:
        Vu = round(Vu + rng.randint(1, 9) / 10, 1)
    abs0 = round(rng.uniform(98, 245), rng.choice([2, 2, 3]))
    cap = rng.randint(*t[2])
    if rng.random() < 0.6:
        cap = int(round(cap, -1 if cap < 2000 else -2))
    E = round(rng.uniform(450_000, 6_800_000), 2)  # тыс. руб. без НДС
    lim_kz = float(rng.choice([40, 50, 60, 65, 70, 75, 80]))
    while lim_kz < kz + 6:
        lim_kz += 10
    lim_kit = float(max(kit + 40, rng.choice([150, 180, 200, 240, 300, 350, 400])))
    lim_kit = float(round(lim_kit, -1))
    o = {
        "type": t[0],
        "caps": t[1],
        "floors": floors,
        "A": A,
        "site": site,
        "kz": kz,
        "gfa": gfa,
        "kit": kit,
        "fh": fh,
        "H": H,
        "depth": depth,
        "Vu": Vu,
        "Vd": Vd,
        "abs": abs0,
        "cap": cap,
        "E": E,
        "lim_kz": lim_kz,
        "lim_kit": lim_kit,
        "power": round(rng.uniform(180, 2600), 1),
        "parking": rng.randint(8, 140),
        "staff": rng.randint(25, 220),
        "green": round(site * rng.uniform(0.2, 0.35), 1),
        "slab": rng.choice([400, 500, 600, 800, 1000]),
        "ground": round(-rng.choice([0.15, 0.3, 0.45, 0.6, 0.9]), 3),
        "code": f"{rng.choice(CODE_PREFIX)}-{rng.randint(3, 97)}/{rng.randint(21, 25)}",
        "town": rng.choice(TOWNS),
        "yy": rng.randint(23, 25),
        "base_div": round(rng.uniform(7.5, 11.9), 2),
    }
    _derive(o)
    return o


def _derive(o: dict) -> None:
    """Производные величины: общий объём, НДС, итог с НДС, покрытия."""
    o["V"] = round(o["Vu"] + o["Vd"], 2)
    o["vat"] = round(o["E"] * 0.2, 2)
    o["I"] = round(o["E"] + o["vat"], 2)
    o["paving"] = round(max(o["site"] - o["A"] - o["green"], 50.0), 1)


# ---------------------------------------------------------------------------
# Факты: (подпись, единица, число) + истина
# ---------------------------------------------------------------------------


def _F(label, unit, num, truth=None, variant=None, key=None, long=None):
    return {
        "label": label,
        "unit": unit,
        "num": num,
        "truth": truth,
        "variant": variant,
        "key": key,
        "long": long or label,
    }


def _fact(rng: random.Random, key: str, o: dict, fs: dict) -> dict:
    u = fs["unit"]

    def pick(lst):
        return lst[u % len(lst)]

    if key == "A":
        lab = rng.choice(
            [
                "Площадь застройки",
                "Площадь застройки здания",
                "Площадь застройки объекта",
            ]
        )
        return _F(
            lab,
            pick(AREA_U),
            _num(o["A"], fs),
            o["A"],
            key=key,
            long=lab
            + rng.choice(
                [
                    " (в габаритах наружных стен на уровне цоколя)",
                    " (по внешнему контуру наружных стен)",
                    ", включая выступающие части и навесы",
                ]
            ),
        )
    if key == "V":
        lab = rng.choice(
            [
                "Строительный объем",
                "Строительный объем здания",
                "Строительный объем, всего",
                "Общий строительный объем",
                "Строительный объём здания, всего",
            ]
        )
        return _F(
            lab,
            pick(VOL_U),
            _num(o["V"], fs),
            o["V"],
            key=key,
            long=lab + " (включая подземную часть)",
        )
    if key == "Vu":
        lab = rng.choice(
            [
                "Строительный объем надземной части",
                "Строительный объем выше отм. 0,000",
                "Строительный объём надземной части здания",
            ]
        )
        return _F(
            lab,
            pick(VOL_U),
            _num(o["Vu"], fs),
            o["Vu"],
            key=key,
            long=lab + " (от отм. 0,000 до верха покрытия)",
        )
    if key == "Vd":
        lab = rng.choice(
            [
                "Строительный объем подземной части",
                "Строительный объем ниже отм. 0,000",
                "Строительный объём подземной части здания",
            ]
        )
        return _F(
            lab,
            pick(VOL_U),
            _num(o["Vd"], fs),
            o["Vd"],
            key=key,
            long=lab + " (до низа пола подвала)",
        )
    if key == "depth":
        v = u % 5
        d = o["depth"]
        if v == 0:
            return _F(
                "Отметка низа фундаментной плиты", "м", _num(d, fs, dp=3), d, key=key
            )
        if v == 1:
            return _F("Отметка пола подвала", "", _num(d, fs, dp=3), d, key=key)
        if v == 2:
            return _F(
                "Глубина заложения фундамента (от отм. 0,000)",
                "м",
                _num(-d, fs),
                d,
                key=key,
            )
        if v == 3:
            return _F("Отметка дна котлована", "м", _num(d, fs, dp=3), d, key=key)
        return _F("Низ фундаментной плиты, отм.", "", _num(d, fs, dp=3), d, key=key)
    if key == "H":
        v = u % 4
        H = o["H"]
        if v == 0:
            return _F(
                rng.choice(["Высота здания", "Высота здания (архитектурная)"]),
                "м",
                _num(H, fs),
                H,
                key=key,
            )
        if v == 1:
            return _F(
                "Высота здания", "мм", _num(round(H * 1000), fs, dp=0), H, key=key
            )
        if v == 2:
            return _F(
                "Высота (от 0,000 до верха парапета)",
                "м",
                _num(H, fs),
                H,
                key=key,
                long="Высота здания (от отметки 0,000 до верха парапета кровли)",
            )
        return _F(
            "Отметка верха парапета", "", _num(H, fs, dp=3, sign=True), H, key=key
        )
    if key == "abs":
        v = u % 4
        a = o["abs"]
        labs = [
            (
                "Абсолютная отметка, соответствующая относительной отметке 0,000",
                "м",
                _num(a, fs),
            ),
            ("Отметка 0,000 соответствует абсолютной отметке", "", _num(a, fs)),
            ("Абс. отметка уровня ±0,000", "м", _num(a, fs, dp=3)),
            ("Абсолютная отметка чистого пола 1-го этажа (0,000)", "м", _num(a, fs)),
        ]
        lab, un, n = labs[v]
        return _F(lab, un, n, a, key=key)
    if key == "cap":
        lab, un = pick(o["caps"])
        return _F(lab, un, _num(o["cap"], fs, dp=0), float(o["cap"]), key=key)
    if key == "kz":
        v = u % 4
        kz = o["kz"]
        if v == 1:
            fr = round(kz / 100, 6)
            return _F(
                "Коэффициент застройки",
                "",
                _num(fr, fs, dp=max(2, _min_dp(fr, 5))),
                kz,
                key=key,
            )
        lab = [
            "Процент застройки",
            None,
            "Коэффициент застройки",
            "Процент застройки участка",
        ][v]
        return _F(lab, "%", _num(kz, fs, cap=2), kz, key=key)
    if key == "kit":
        v = u % 4
        kit = o["kit"]
        if v == 3:
            return _F(
                "Коэффициент использования территории",
                "%",
                _num(kit, fs, cap=2),
                kit,
                key=key,
            )
        fr = round(kit / 100, 6)
        lab = [
            "Коэффициент использования территории",
            "КИТ",
            "Коэффициент плотности застройки",
        ][v]
        return _F(lab, "", _num(fr, fs, dp=max(1, _min_dp(fr, 5))), kit, key=key)
    if key in ("cost_incl", "cost_excl", "cost_plain"):
        val = {"cost_incl": o["I"], "cost_excl": o["E"], "cost_plain": o["I"]}[key]
        var = {"cost_incl": "vat_incl", "cost_excl": "vat_excl", "cost_plain": None}[
            key
        ]
        suf = {
            "cost_incl": rng.choice(
                [" (с НДС)", " с учетом НДС 20 %", ", включая НДС"]
            ),
            "cost_excl": rng.choice([" (без НДС)", " без учета НДС", ", без НДС"]),
            "cost_plain": "",
        }[key]
        lab = (
            rng.choice(
                [
                    "Сметная стоимость строительства",
                    "Стоимость строительства в текущих ценах",
                    "Общая сметная стоимость",
                ]
            )
            + suf
        )
        if fs["cost_unit"] == "руб":
            return _F(
                lab,
                "руб.",
                _num(round(val * 1000), fs, dp=rng.choice([0, 2])),
                val,
                var,
                key=key,
            )
        return _F(
            lab,
            rng.choice(["тыс. руб.", "тыс.руб.", "тыс. руб"]),
            _num(val, fs, dp=2),
            val,
            var,
            key=key,
        )
    # --- дистракторы ---
    if key == "site":
        lab = rng.choice(
            [
                "Площадь земельного участка",
                "Площадь участка",
                "Площадь участка в границах ГПЗУ",
                "Площадь территории в границах отвода",
            ]
        )
        return _F(lab, pick(AREA_U), _num(o["site"], fs), key=key)
    if key == "gfa":
        lab = rng.choice(
            ["Общая площадь здания", "Общая площадь", "Суммарная поэтажная площадь"]
        )
        return _F(lab, pick(AREA_U), _num(o["gfa"], fs), key=key)
    if key == "useful":
        return _F(
            rng.choice(["Полезная площадь", "Расчетная площадь"]),
            pick(AREA_U),
            _num(round(o["gfa"] * 0.71, 1), fs),
            key=key,
        )
    if key == "green":
        return _F("Площадь озеленения", pick(AREA_U), _num(o["green"], fs), key=key)
    if key == "paving":
        return _F(
            "Площадь покрытий (проезды, тротуары, площадки)",
            pick(AREA_U),
            _num(o["paving"], fs),
            key=key,
        )
    if key == "floors":
        return _F(
            rng.choice(
                ["Этажность", "Количество надземных этажей", "Количество этажей"]
            ),
            rng.choice(["эт.", "этаж", "шт."]),
            str(o["floors"] + (0 if rng.random() < 0.7 else 1)),
            key=key,
        )
    if key == "fh":
        return _F("Высота этажа", "м", _num(o["fh"], fs), key=key)
    if key == "power":
        return _F(
            rng.choice(
                [
                    "Расчетная электрическая мощность",
                    "Максимальная мощность энергопринимающих устройств",
                    "Электрическая нагрузка (расчетная)",
                ]
            ),
            "кВт",
            _num(o["power"], fs),
            key=key,
        )
    if key == "parking":
        return _F(
            "Количество машино-мест",
            rng.choice(["м/м", "маш.-мест", "шт."]),
            str(o["parking"]),
            key=key,
        )
    if key == "staff":
        return _F("Численность персонала", "чел.", str(o["staff"]), key=key)
    if key == "rel0":
        return _F(
            "Относительная отметка чистого пола 1-го этажа",
            "",
            rng.choice(["0,000", "±0,000", "0.000"]),
            key=key,
        )
    if key == "ground":
        return _F(
            rng.choice(["Отметка планировки земли у здания", "Отметка отмостки"]),
            "",
            _num(o["ground"], fs, dp=3),
            key=key,
        )
    if key == "ground_abs":
        return _F(
            "Средняя планировочная отметка земли (абс.)",
            "м",
            _num(round(o["abs"] + o["ground"], 3), fs),
            key=key,
        )
    if key == "lim_kz":
        return _F(
            rng.choice(
                [
                    "Максимальный процент застройки (по ГПЗУ)",
                    "Процент застройки, не более",
                    "Предельный процент застройки",
                ]
            ),
            "%",
            _num(o["lim_kz"], fs, dp=0),
            o["lim_kz"],
            key=key,
        )
    if key == "lim_kit":
        fr = round(o["lim_kit"] / 100, 4)
        return _F(
            rng.choice(
                [
                    "Максимальный КИТ (по ГПЗУ)",
                    "Коэффициент использования территории, не более",
                    "Предельный коэффициент использования территории",
                ]
            ),
            "",
            _num(fr, fs, dp=max(1, _min_dp(fr))),
            o["lim_kit"],
            key=key,
        )
    if key == "green_pct":
        return _F(
            "Процент озеленения",
            "%",
            _num(round(o["green"] / o["site"] * 100, 1), fs),
            key=key,
        )
    if key == "vat":
        return _F("НДС 20 %", "тыс. руб.", _num(o["vat"], fs, dp=2), key=key)
    if key == "cost_base":
        return _F(
            "Сметная стоимость в базисном уровне цен 2001 г.",
            "тыс. руб.",
            _num(round(o["E"] / o["base_div"], 2), fs, dp=2),
            key=key,
        )
    if key == "Vd_dis":
        return _fact(rng, "Vd", o, fs) | {"truth": None, "key": key}
    if key == "slab":
        return _F("Толщина фундаментной плиты", "мм", str(o["slab"]), key=key)
    raise KeyError(key)


TARGET = {
    "M-001": "A",
    "M-004": "V",
    "M-005": "Vd",
    "M-006": "Vu",
    "M-008": "H",
    "M-009": "abs",
    "M-013": "cap",
    "M-019": "kz",
    "M-020": "kit",
    "M-132": "cost_incl",
}

DIS = {
    "M-001": ["site", "gfa", "green", "paving", "floors", "useful", "kz"],
    "M-004": ["Vu", "Vd", "gfa", "A", "floors", "useful"],
    "M-005": ["V", "Vu", "gfa", "A", "floors"],
    "M-006": ["V", "Vd", "gfa", "A", "floors"],
    "M-008": ["floors", "fh", "gfa", "ground", "A", "V"],
    "M-009": ["rel0", "ground", "ground_abs", "floors", "A"],
    "M-013": ["power", "parking", "staff", "floors", "gfa", "A"],
    "M-019": ["site", "A", "kit", "green", "green_pct", "gfa"],
    "M-020": ["kz", "site", "gfa", "A", "floors", "green"],
    "M-132": ["vat", "cost_base", "cost_excl"],
}

# ---------------------------------------------------------------------------
# Шум страницы: шапки, штамп, шифр, номер листа
# ---------------------------------------------------------------------------

MARKS = {"pz": "ПЗ", "ar": "АР", "gp": "ГП", "sm": "СМ", "pzu": "ПЗУ"}


def _cipher(o, stage, mark):
    return f"{o['code']}-{stage}-{mark}"


def _stamp(rng, o, stage, mark):
    lines = []
    c = _cipher(o, stage, mark)
    lines.append(
        rng.choice(
            [
                "Изм. Кол.уч. Лист №док. Подп. Дата",
                "Изм. Кол.уч Лист № док. Подпись Дата",
                "Изм. Кол. уч. Лист № док. Подп. Дата",
            ]
        )
    )
    if rng.random() < 0.5:
        lines.insert(
            0,
            f"{rng.randint(1, 3)} - Зам. {rng.randint(10, 99)}-{o['yy']} {rng.randint(1, 12):02d}.{o['yy']}",
        )
    if rng.random() < 0.5:
        s = rng.sample(SURNAMES, 3)
        lines += [f"Разраб. {s[0]}", f"Пров. {s[1]}", f"ГИП {s[2]}"]
    lines.append(c)
    r = rng.random()
    if r < 0.4:
        lines.append(str(rng.randint(2, 48)))
    elif r < 0.7:
        lines += [
            "Стадия Лист Листов",
            f"{stage} {rng.randint(2, 30)} {rng.randint(31, 60)}",
        ]
    else:
        lines.append(f"Лист {rng.randint(2, 48)}")
    if rng.random() < 0.4:
        lines.append(
            rng.choice(
                [
                    "Формат А4",
                    "Копировал Формат А3",
                    "Инв. № подл. Подп. и дата Взам. инв. №",
                ]
            )
        )
    return lines


def _top(rng, o, stage, mark):
    if rng.random() < 0.35:
        return [
            rng.choice(["Взам. инв. №", "Согласовано", "Инв. № подл."]),
            _cipher(o, stage, mark),
        ]
    return []


PZ_HEAD = [
    "Технико-экономические показатели",
    "Основные технико-экономические показатели",
    "1.4 Технико-экономические показатели проектируемого объекта",
    "Таблица 1 – Основные технико-экономические показатели",
    "Таблица 3.2 — Технико-экономические показатели объекта капитального строительства",
    "ТЕХНИКО-ЭКОНОМИЧЕСКИЕ ПОКАЗАТЕЛИ",
]

TABLE_HEAD = [
    ["№ п/п Наименование показателя Ед. изм. Значение"],
    ["№", "п/п", "Наименование показателя", "Единица", "измерения", "Количество"],
    ["Наименование Ед. изм. Кол-во"],
    ["Наименование показателя Ед.", "изм.", "Показатель"],
    ["№ Наименование Ед. изм. Всего Примечание"],
    ["Наименование показателей Единица измерения Проектные показатели"],
]


def _join(fs, cells):
    return fs["sep"].join(c for c in cells if c != "")


def _split_label(label):
    w = label.split(" ")
    if len(w) < 3:
        return label, ""
    k = max(1, len(w) // 2)
    return " ".join(w[:k]), " ".join(w[k:])


def _prot(s):
    return s.replace(" ", "\x00").replace(NBSP, "\x01")


def _wrap(text, width):
    words = text.split(" ")
    lines, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        lines.append(cur)
    return [ln.replace("\x00", " ").replace("\x01", NBSP) for ln in lines]


# ---------------------------------------------------------------------------
# Раскладки строк таблицы
# ---------------------------------------------------------------------------


def _rows_table(rng, facts, fs, wrap_keys=(), numbered=True, pipe=False):
    out = []
    head = rng.choice(TABLE_HEAD)
    if pipe:
        out.append("| № | Наименование | Ед. изм. | Значение |")
    else:
        out += head
    # в заголовке может стоять номер колонки «1 2 3 4»
    if rng.random() < 0.3 and not pipe:
        out.append("1 2 3 4")
    idx = 1
    for f in facts:
        n = f"{idx}" if rng.random() < 0.8 else f"{idx}."
        if not numbered:
            n = ""
        idx += 1
        if pipe:
            out.append(
                "| " + " | ".join([n, f["label"], f["unit"] or "-", f["num"]]) + " |"
            )
            continue
        if f["key"] in wrap_keys:
            p1, p2 = _split_label(f["long"])
            if p2 and rng.random() < 0.5:
                out.append(_join(fs, [n, p1]))
                out.append(_join(fs, [p2, f["unit"], f["num"]]))
            elif p2:
                out.append(_join(fs, [n, p1, f["unit"], f["num"]]))
                out.append(p2)
            else:
                out.append(_join(fs, [n, f["label"], f["unit"], f["num"]]))
            continue
        unit = f["unit"] if f["unit"] else rng.choice(["", "-", "—"])
        cells = [n, f["label"], unit, f["num"]]
        if rng.random() < 0.1:
            cells.append(rng.choice(["по проекту", "см. прим. 1", ""]))
        out.append(_join(fs, cells))
    return out


def _rows_next_line(rng, facts, fs):
    out = [rng.choice(PZ_HEAD)]
    for i, f in enumerate(facts, 1):
        r = rng.random()
        u = f["unit"]
        if r < 0.4:
            out.append(f"{i} {f['label']}" + (f", {u}" if u else ""))
            out.append(f["num"])
        elif r < 0.7:
            out.append(f"{i} {f['label']}")
            if u:
                out.append(u)
            out.append(f["num"])
        else:
            p1, p2 = _split_label(f["long"])
            out.append(f"{i} {p1}")
            if p2:
                out.append(p2)
            out.append(_join(fs, [u, f["num"]]))
    return out


def _rows_unit_in_label(rng, facts, fs):
    out = [
        rng.choice(
            [
                "Показатель Значение",
                "Наименование показателя Величина",
                "Показатели По проекту",
            ]
        )
    ]
    for f in facts:
        lab = f"{f['label']}, {f['unit']}" if f["unit"] else f["label"]
        out.append(_join(fs, [lab, f["num"]]))
    return out


def _sentence(rng, f, o):
    """Предложение ПЗ с одним фактом (числа защищены от переноса строки)."""
    n, u = _prot(f["num"]), f["unit"]
    k = f["key"]
    if k == "A":
        return rng.choice(
            [
                f"Площадь застройки здания составляет {n} {u}.",
                f"Здание прямоугольное в плане, площадь застройки — {n} {u}.",
                f"Проектируемое здание имеет площадь застройки {n} {u} при общей площади {_prot(_num(o['gfa'], _fs(rng)))} м2.",
            ]
        )
    if k == "H":
        if u == "":
            return f"Кровля плоская, верх парапета на отметке {n}, выход на кровлю через лестничную клетку."
        return rng.choice(
            [
                f"Высота здания от отметки 0,000 до верха парапета составляет {n} {u}.",
                f"Здание {o['floors']}-этажное, высотой {n} {u} (высота этажа {_prot(str(o['fh']).replace('.', ','))} м).",
            ]
        )
    if k == "abs":
        return rng.choice(
            [
                f"За относительную отметку 0,000 принята отметка чистого пола первого этажа, что соответствует абсолютной отметке {n} (Балтийская система высот).",
                f"Отметка 0,000 соответствует абс. отм. {n} в Балтийской системе высот.",
                f"Уровень чистого пола 1-го этажа ±0,000 = {n} абс.",
            ]
        )
    if k == "cap":
        return rng.choice(
            [
                f"{f['label']} объекта — {n} {u}.",
                f"Проектом предусмотрен {o['type'].lower()} на {n} {u}.",
                f"{o['type']} рассчитан на {n} {u}, численность персонала {o['staff']} чел.",
            ]
        )
    if k == "depth":
        if "Глубина" in f["label"]:
            return (
                f"Глубина заложения фундамента {n} м от уровня чистого пола 1-го этажа."
            )
        return rng.choice(
            [
                f"Фундамент — монолитная железобетонная плита толщиной {o['slab']} мм, низ плиты на отметке {n}.",
                f"Отметка низа фундаментной плиты принята {n}.",
                f"Пол подвала на отметке {n}, под плитой — бетонная подготовка 100 мм.",
            ]
        )
    if k in ("kz", "kit") and u == "":
        return f"{f['label']} составляет {n}."
    if k and k.startswith("cost"):
        return f"{f['label']} составляет {n} {u}"
    return rng.choice(
        [
            f"{f['label']} — {n} {u}.".replace(" .", "."),
            f"{f['label']} составляет {n} {u}.".replace(" .", "."),
            f"{f['label']}: {n} {u};".replace(" ;", ";"),
        ]
    )


# ---------------------------------------------------------------------------
# Специальные блоки
# ---------------------------------------------------------------------------


def _vol_block(rng, o, fs, include=("V", "Vu", "Vd"), with_depth=False):
    """Строительный объём: общий, надземная, подземная строками подряд."""
    u = VOL_U[fs["unit"] % len(VOL_U)]
    V, Vu, Vd = (_num(o[k], fs) for k in ("V", "Vu", "Vd"))
    present = {}
    style = rng.randrange(4)
    out = []
    n = rng.randint(3, 7)
    if style == 0:
        if "V" in include:
            out.append(_join(fs, [str(n), "Строительный объем здания", u, V]))
            present["V"] = o["V"]
        else:
            out.append(_join(fs, [str(n), "Строительный объем здания,"]))
        out.append("в том числе:")
        if "Vu" in include:
            out.append(_join(fs, ["- надземной части", u, Vu]))
            present["Vu"] = o["Vu"]
        if "Vd" in include:
            out.append(_join(fs, ["- подземной части", u, Vd]))
            present["Vd"] = o["Vd"]
    elif style == 1:
        if "V" in include:
            out.append(_join(fs, [str(n), "Строительный объем, всего", u, V]))
            present["V"] = o["V"]
        if "Vu" in include:
            out.append(_join(fs, [f"{n}.1", "в т.ч. выше отм. 0,000", u, Vu]))
            present["Vu"] = o["Vu"]
        if "Vd" in include:
            out.append(_join(fs, [f"{n}.2", "ниже отм. 0,000", u, Vd]))
            present["Vd"] = o["Vd"]
    elif style == 2:
        out.append(f"{n} Строительный объем здания, {u}")
        if "V" in include:
            out.append(_join(fs, ["- всего", V]))
            present["V"] = o["V"]
        if "Vu" in include:
            out.append(_join(fs, ["- надземной части", Vu]))
            present["Vu"] = o["Vu"]
        if "Vd" in include:
            out.append(_join(fs, ["- подземной части", Vd]))
            present["Vd"] = o["Vd"]
    else:
        lab = {
            "V": "Строительный объем общий",
            "Vu": "Строительный объем надземной части",
            "Vd": "Строительный объем подземной части",
        }
        for i, k in enumerate(("V", "Vu", "Vd")):
            if k in include:
                out.append(_join(fs, [f"{n + i}", lab[k], u, _num(o[k], fs)]))
                present[k] = o[k]
    if with_depth:
        f = _fact(rng, "depth", o, fs)
        out.append(_join(fs, [str(n + 3), f["label"], f["unit"], f["num"]]))
        present["depth"] = o["depth"]
    return out, present


def _ssr(rng, o, fs, mode, stage):
    """Сводный сметный расчёт. mode: full | excl | plain | chapters | base_current."""
    rub = fs["cost_unit"] == "руб"
    mult = 1000 if rub else 1
    dpc = 2

    def c(x):
        return _num(
            round(x * mult, 2),
            fs,
            dp=dpc if not rub else rng.choice([2, 0]) if False else 2,
        )

    E = o["E"]
    itogo = round(E / 1.02, 2)
    nepr = round(E - itogo, 2)
    chap_names = {
        1: "Подготовка территории строительства",
        2: "Основные объекты строительства",
        4: "Объекты энергетического хозяйства",
        6: "Наружные сети и сооружения водоснабжения, водоотведения, теплоснабжения и газоснабжения",
        7: "Благоустройство и озеленение территории",
        8: "Временные здания и сооружения",
        9: "Прочие работы и затраты",
        10: "Содержание службы заказчика. Строительный контроль",
        12: "Проектные и изыскательские работы",
    }
    weights = {
        1: 0.02,
        2: 0.68,
        4: 0.03,
        6: 0.06,
        7: 0.04,
        8: 0.025,
        9: 0.08,
        10: 0.025,
        12: 0.04,
    }
    weights = {k: v * rng.uniform(0.7, 1.3) for k, v in weights.items()}
    s = sum(weights.values())
    chap = {}
    acc = 0.0
    keys = list(weights)
    for k in keys[:-1]:
        chap[k] = round(itogo * weights[k] / s, 2)
        acc += chap[k]
    chap[keys[-1]] = round(itogo - acc, 2)
    lines = []
    lines += _top(rng, o, stage, "СМ")
    lines.append(
        rng.choice(
            [
                "СВОДНЫЙ СМЕТНЫЙ РАСЧЕТ СТОИМОСТИ СТРОИТЕЛЬСТВА",
                "Сводный сметный расчет стоимости строительства",
                "ССР № 1",
            ]
        )
    )
    lines.append(f"{o['type']} в {o['town']}")
    if rng.random() < 0.6 and mode in ("full", "base_current"):
        lines.append(f"Сметная стоимость {c(o['I'])} {'руб.' if rub else 'тыс. руб.'}")
    lines.append(
        f"Составлен в текущем уровне цен по состоянию на {rng.choice(['I', 'II', 'III', 'IV'])} квартал 20{o['yy']} г."
    )
    lines.append(
        "(руб.)" if rub else rng.choice(["(тыс. руб.)", "в тыс.руб.", "тыс. руб."])
    )
    lines += [
        "№ п/п Номера сметных расчетов и смет Наименование глав, объектов, работ и затрат Сметная стоимость Общая сметная стоимость",
        "строительных работ монтажных работ оборудования, мебели, инвентаря прочих затрат",
    ]
    if rng.random() < 0.4:
        lines.append("1 2 3 4 5 6 7 8")
    n = 1
    order = keys[:]
    if mode == "chapters":
        order = keys[: rng.randint(3, 5)]
    for k in order:
        tot = chap[k]
        smr = round(tot * rng.uniform(0.55, 0.8), 2) if k in (1, 2, 4, 6, 7, 8) else 0.0
        eq = round(tot - smr, 2) if k in (2, 4) else 0.0
        oth = round(tot - smr - eq, 2)
        cols = [
            c(smr) if smr else "",
            c(eq) if eq else "",
            c(oth) if oth else "",
            c(tot),
        ]
        name = f"Глава {k}. {chap_names[k]}"
        if len(name) > 60:
            p1, p2 = (
                name[:50].rsplit(" ", 1)[0],
                name[len(name[:50].rsplit(" ", 1)[0]) + 1 :],
            )
            lines.append(_join(fs, [str(n), f"ОСР-{k:02d}", p1] + cols))
            lines.append(p2)
        else:
            lines.append(
                _join(fs, [str(n), f"ОСР-{k:02d}" if k != 12 else "СР-12", name] + cols)
            )
        n += 1
    present = {}
    if mode == "chapters":
        lines.append(
            _join(
                fs,
                ["Итого по главам 1-" + str(order[-1]), c(sum(chap[k] for k in order))],
            )
        )
        lines += _stamp(rng, o, stage, "СМ")
        return lines, present
    lines.append(_join(fs, ["Итого по главам 1-12", c(itogo)]))
    lines.append(
        _join(
            fs,
            [
                "Непредвиденные затраты 2 %",
                rng.choice(
                    ["МДС 81-35.2004 п.4.96", "Приказ Минстроя № 421/пр п. 179"]
                ),
                c(nepr),
            ],
        )
    )
    if mode == "base_current":
        lines.append(
            _join(
                fs,
                ["Итого в базисном уровне цен 2001 г.", c(round(E / o["base_div"], 2))],
            )
        )
        lines.append(
            _join(
                fs,
                [
                    f"Индекс пересчета в текущий уровень цен {_num(o['base_div'], fs)}",
                    "",
                ],
            )
        )
    lab_ex = rng.choice(
        [
            "Итого с непредвиденными затратами",
            "Итого по сводному сметному расчету без НДС",
            "Итого (без НДС)",
        ]
    )
    if mode == "plain":
        lines.append(
            _join(
                fs,
                [
                    rng.choice(["Всего по сводному сметному расчету", "ВСЕГО по ССР"]),
                    c(E),
                ],
            )
        )
        present["cost_plain"] = (E, None)
    elif mode == "excl":
        lines.append(_join(fs, [lab_ex, c(E)]))
        present["cost_excl"] = (E, "vat_excl")
        if rng.random() < 0.5:
            lines.append("Продолжение см. лист 2")
    else:
        lines.append(_join(fs, [lab_ex, c(E)]))
        lines.append(
            _join(
                fs,
                [
                    rng.choice(
                        ["НДС 20 %", "Налог на добавленную стоимость 20%", "НДС 20%"]
                    ),
                    c(o["vat"]),
                ],
            )
        )
        lines.append(
            _join(
                fs,
                [
                    rng.choice(
                        [
                            "Всего по сводному сметному расчету",
                            "ВСЕГО с НДС",
                            "Всего по сводному сметному расчету с НДС",
                        ]
                    ),
                    c(o["I"]),
                ],
            )
        )
        present["cost_incl"] = (o["I"], "vat_incl")
        if rng.random() < 0.5:
            lines.append(
                _join(fs, ["В том числе возвратные суммы", c(round(o["E"] * 0.004, 2))])
            )
    if rng.random() < 0.6:
        s = rng.sample(SURNAMES, 2)
        lines += [f"Главный инженер проекта {s[0]}", f"Составил {s[1]}"]
    lines += _stamp(rng, o, stage, "СМ")
    return lines, present


def _general_data(rng, o, fs, facts, abs_note, depth_note=None, mark="АР"):
    """«Общие данные» рабочей документации: ведомость листов, ТЭП, указания."""
    lines = _top(rng, o, "Р", mark)
    lines.append(rng.choice(["Общие данные", "ОБЩИЕ ДАННЫЕ", "Общие данные (начало)"]))
    if rng.random() < 0.7:
        lines.append("Ведомость рабочих чертежей основного комплекта")
        lines.append("Лист Наименование Примечание")
        sheets = (
            [
                "Общие данные",
                "План на отм. 0,000",
                "План на отм. +3,600",
                "Фасад 1-12",
                "Разрез 1-1",
                "План кровли",
            ]
            if mark == "АР"
            else [
                "Общие данные",
                "Разбивочный план",
                "План организации рельефа",
                "План благоустройства",
                "Сводный план сетей",
            ]
        )
        for i, s in enumerate(sheets[: rng.randint(3, len(sheets))], 1):
            lines.append(f"{i} {s}")
    lines.append(
        rng.choice(
            [
                "Основные показатели по зданию",
                "Технико-экономические показатели",
                "Основные технико-экономические показатели",
                "Показатели по генплану" if mark == "ГП" else "Основные показатели",
            ]
        )
    )
    lines += _rows_table(rng, facts, fs, numbered=rng.random() < 0.5)
    lines.append(rng.choice(["Указания", "Общие указания", "Примечания"]))
    notes = [
        f"Рабочая документация разработана на основании проектной документации {_cipher(o, 'П', 'АР')} и задания на проектирование."
    ]
    if abs_note:
        notes.append(abs_note)
    if depth_note:
        notes.append(depth_note)
    notes.append(
        "Рабочая документация соответствует требованиям СП 118.13330.2022 и ГОСТ Р 21.101-2020."
    )
    if rng.random() < 0.5:
        rng.shuffle(notes)
    for i, t in enumerate(notes, 1):
        lines += _wrap(f"{i}. " + t, rng.choice([70, 90, 110]))
    lines += _stamp(rng, o, "Р", mark)
    return lines


def _abs_note(rng, o, fs):
    a = _prot(_num(o["abs"], fs, dp=rng.choice([None, 3]) and None))
    a3 = _prot(_num(o["abs"], fs, dp=3))
    return rng.choice(
        [
            f"За относительную отметку 0,000 принята отметка чистого пола 1-го этажа, что соответствует абсолютной отметке {a}.",
            f"За отметку 0,000 принят уровень чистого пола первого этажа, соответствующий абс. отм. {a3} (Балтийская система высот).",
            f"Отм. ±0.000 = абс. {a3}.",
            f"0,000 соответствует абс. отм. {a} (Балтийская система).",
            f"Абсолютная отметка, соответствующая относительной отметке 0,000, — {a} м.",
        ]
    )


# ---------------------------------------------------------------------------
# Страница
# ---------------------------------------------------------------------------


def _limit_key(param):
    return {"M-019": "lim_kz", "M-020": "lim_kit"}.get(param)


def _pick_dis(rng, param, k):
    pool = DIS[param]
    return rng.sample(pool, min(k, len(pool)))


def _page(
    rng,
    param,
    o,
    cls,
    fs,
    aspect=None,
    stage="П",
    targets=None,
    show_limit=None,
    shuffle_rows=False,
    allow_drop=True,
):
    """Возвращает (lines, present), present: ключ → (истина, вариант)."""
    if targets is None:
        targets = ["depth"] if aspect == "depth" else [TARGET[param]]
    lk = _limit_key(param)
    if show_limit is None:
        show_limit = lk is not None and rng.random() < 0.35
    present: dict = {}
    lines: list[str] = []

    def facts_for(keys):
        fl = []
        for k in keys:
            f = _fact(rng, k, o, fs)
            fl.append(f)
            if f["truth"] is not None and (k in targets or k == lk):
                present[k] = (f["truth"], f["variant"])
        return fl

    def mixed(include_targets=True, k=None):
        dis = _pick_dis(rng, param, k if k is not None else rng.randint(2, 4))
        keys = (list(targets) if include_targets else []) + dis
        if show_limit and lk:
            keys.append(lk)
        rng.shuffle(keys)
        if not shuffle_rows and rng.random() < 0.4:
            keys.sort(
                key=lambda z: (
                    [
                        "site",
                        "A",
                        "gfa",
                        "useful",
                        "V",
                        "Vu",
                        "Vd",
                        "floors",
                        "H",
                    ].index(z)
                    if z
                    in ["site", "A", "gfa", "useful", "V", "Vu", "Vd", "floors", "H"]
                    else 99
                )
            )
        return facts_for(keys)

    mark = "ПЗ"
    if cls in ("tep_table", "tep_pipe", "tep_wrapped", "stamp_heavy"):
        lines += _top(rng, o, stage, mark)
        if cls == "stamp_heavy":
            lines += _stamp(rng, o, stage, mark)
            lines.append(f"Продолжение таблицы {rng.randint(1, 5)}.{rng.randint(1, 4)}")
        else:
            lines.append(rng.choice(PZ_HEAD))
        lines += _rows_table(
            rng,
            mixed(),
            fs,
            wrap_keys=tuple(targets) if cls == "tep_wrapped" else (),
            pipe=cls == "tep_pipe",
        )
        if rng.random() < 0.3:
            lines.append(
                rng.choice(
                    [
                        "Примечание: площадь застройки определена согласно приложению А СП 54.13330.2022.",
                        "Примечание – строительный объем определен по СП 118.13330.2022, прил. Г.",
                        "* Показатели уточняются на стадии РД.",
                    ]
                )
            )
        lines += _stamp(rng, o, stage, mark)
    elif cls == "value_next_line":
        lines += (
            _top(rng, o, stage, mark)
            + _rows_next_line(rng, mixed(), fs)
            + _stamp(rng, o, stage, mark)
        )
    elif cls == "unit_in_label":
        lines.append(rng.choice(PZ_HEAD))
        lines += _rows_unit_in_label(rng, mixed(), fs) + _stamp(rng, o, stage, mark)
    elif cls == "text_sentence":
        fl = mixed(k=rng.randint(1, 2))
        para = " ".join(_sentence(rng, f, o) for f in fl)
        lines.append(
            rng.choice(
                [
                    "3 Архитектурные решения",
                    "Описание объемно-планировочного решения",
                    "б) Обоснование принятых объемно-пространственных решений",
                    "1.2 Сведения о проектируемом объекте",
                ]
            )
        )
        lines += _wrap(para, rng.choice([65, 80, 95, 120]))
        lines += _stamp(rng, o, stage, mark)
    elif cls == "distractor_only":
        lines.append(rng.choice(PZ_HEAD))
        lines += _rows_table(rng, mixed(include_targets=False, k=rng.randint(3, 5)), fs)
        lines += _stamp(rng, o, stage, mark)
    elif cls in ("change_note", "change_table"):
        f_new = _fact(rng, targets[0], o, fs)
        o_old = copy.deepcopy(o)
        _shift(rng, param, o_old, targets[0])
        f_old = _fact(rng, targets[0], o_old, fs)
        present[targets[0]] = (f_new["truth"], f_new["variant"])
        lines.append(
            rng.choice(
                [
                    "Таблица регистрации изменений",
                    "Сведения об изменениях",
                    f"Изм. {rng.randint(1, 4)}. Внесены изменения по замечаниям экспертизы",
                ]
            )
        )
        u = f_new["unit"]
        if cls == "change_table":
            lines += [
                "Наименование показателя Было Стало",
                _join(
                    fs,
                    [
                        f"{f_new['label']}" + (f", {u}" if u else ""),
                        f_old["num"],
                        f_new["num"],
                    ],
                ),
            ]
        else:
            t = rng.choice(
                [
                    f"{f_new['label']}: было {_prot(f_old['num'])} {f_old['unit']}, стало {_prot(f_new['num'])} {u}.",
                    f"{f_new['label']} изменен(а) с {_prot(f_old['num'])} на {_prot(f_new['num'])} {u} (письмо заказчика № {rng.randint(10, 999)}/{o['yy']} от {rng.randint(1, 28):02d}.0{rng.randint(1, 9)}.20{o['yy']}).",
                    f"Было: {f_old['label']} {_prot(f_old['num'])} {f_old['unit']}. Стало: {_prot(f_new['num'])} {u}.",
                ]
            )
            lines += _wrap(t, rng.choice([70, 100]))
        lines += _stamp(rng, o, stage, mark)
    elif cls in ("recon_table", "existing_only"):
        o_old = copy.deepcopy(o)
        _shift(rng, param, o_old, targets[0], big=True)
        f_new = _fact(rng, targets[0], o, fs)
        f_old = _fact(rng, targets[0], o_old, fs)
        dis = [_fact(rng, k, o, fs) for k in _pick_dis(rng, param, 2)]
        if cls == "recon_table":
            present[targets[0]] = (f_new["truth"], f_new["variant"])
            lines += [
                "Технико-экономические показатели",
                "Наименование Ед. изм. Существующее После",
                "положение реконструкции",
            ]
            lines.append(
                _join(
                    fs, ["1", f_new["label"], f_new["unit"], f_old["num"], f_new["num"]]
                )
            )
            for i, d in enumerate(dis, 2):
                lines.append(_join(fs, [str(i), d["label"], d["unit"], "—", d["num"]]))
        else:
            lines += [
                "Характеристика существующего здания (до реконструкции)",
                "Наименование Ед. изм. Показатель",
            ]
            lines.append(_join(fs, ["1", f_old["label"], f_old["unit"], f_old["num"]]))
            lines.append(
                _join(fs, ["2", "Год постройки", "", str(rng.randint(1958, 1989))])
            )
            lines += _wrap(
                "Проектные показатели после реконструкции приведены в разделе 3 настоящей записки.",
                80,
            )
        lines += _stamp(rng, o, stage, mark)
    elif cls == "general_data_ar":
        abs_note = (
            _abs_note(rng, o, fs) if (param == "M-009" or rng.random() < 0.5) else None
        )
        if param == "M-009" and "abs" in targets:
            present["abs"] = (o["abs"], None)
            fl = [_fact(rng, k, o, fs) for k in _pick_dis(rng, param, 3)]
        else:
            fl = mixed()
        lines += _general_data(rng, o, fs, fl, abs_note)
    elif cls == "gp_table":
        keys = (
            ["site", "A", "paving", "green"]
            + list(targets)
            + (["green_pct"] if rng.random() < 0.5 else [])
        )
        if param == "M-019":
            keys += ["kit"] if rng.random() < 0.5 else []
        if param == "M-020":
            keys += ["kz"] if rng.random() < 0.5 else []
        if show_limit and lk:
            keys.append(lk)
        keys = list(dict.fromkeys(keys))
        if shuffle_rows:
            rng.shuffle(keys)
        fl = facts_for(keys)
        lines += (
            _general_data(rng, o, fs, fl, None, mark="ГП")
            if stage == "Р"
            else (
                [
                    rng.choice(
                        [
                            "Технико-экономические показатели земельного участка",
                            "ТЭП по генплану",
                        ]
                    )
                ]
                + _rows_table(rng, fl, fs)
                + _stamp(rng, o, stage, "ПЗУ")
            )
        )
    elif cls == "balance_table":
        pct = lambda x: _num(round(x / o["site"] * 100, 1), fs, dp=1)  # noqa: E731
        lines += ["Баланс территории", "Наименование Площадь, м2 %"]
        lines.append(
            _join(
                fs,
                ["1", "Площадь застройки", _num(o["A"], fs), _num(o["kz"], fs, dp=1)],
            )
        )
        lines.append(
            _join(
                fs, ["2", "Площадь покрытий", _num(o["paving"], fs), pct(o["paving"])]
            )
        )
        lines.append(
            _join(
                fs, ["3", "Площадь озеленения", _num(o["green"], fs), pct(o["green"])]
            )
        )
        lines.append(
            _join(fs, ["", "Итого в границах участка", _num(o["site"], fs), "100"])
        )
        present["A"] = (o["A"], None)
        present["kz"] = (o["kz"], None)
        lines += _stamp(rng, o, stage, "ПЗУ")
    elif cls == "gpzu_vs_project":
        tk = targets[0]
        f = _fact(rng, tk, o, fs)
        present[tk] = (f["truth"], None)
        lim = o[lk]
        present[lk] = (lim, None)
        limtxt = (
            _num(lim, fs, dp=0)
            if tk == "kz"
            else _num(round(lim / 100, 4), fs, dp=max(1, _min_dp(lim / 100)))
        )
        if f["unit"] == "%" and tk == "kit":
            limtxt = _num(lim, fs, dp=0)
        lines += [
            "Соответствие проектных решений градостроительному плану земельного участка",
            "Наименование показателя Ед. изм. По ГПЗУ По проекту",
            "(предельное)",
        ]
        lines.append(
            _join(
                fs,
                [
                    "1",
                    "Площадь земельного участка",
                    AREA_U[fs["unit"] % 6],
                    _num(o["site"], fs),
                    _num(o["site"], fs),
                ],
            )
        )
        lines.append(
            _join(
                fs,
                [
                    "2",
                    "Предельное количество этажей",
                    "эт.",
                    str(o["floors"] + rng.randint(1, 6)),
                    str(o["floors"]),
                ],
            )
        )
        lines.append(
            _join(
                fs,
                [
                    "3",
                    f["label"],
                    f["unit"] or "-",
                    rng.choice(["не более ", "max ", ""]) + limtxt,
                    f["num"],
                ],
            )
        )
        if rng.random() < 0.5:
            lines.append(
                _join(
                    fs,
                    [
                        "4",
                        "Минимальные отступы от границ участка",
                        "м",
                        "3",
                        "3,0–12,5",
                    ],
                )
            )
        lines += _stamp(rng, o, stage, "ПЗ")
    elif cls == "limit_only":
        lim = o[lk]
        present[lk] = (lim, None)
        lines += [
            f"Градостроительный план земельного участка № РФ-{rng.randint(10, 89)}-{rng.randint(1, 9)}-{rng.randint(10, 99)}-0-00-20{o['yy']}-{rng.randint(1000, 9999)}",
            "2.2. Предельные (минимальные и (или) максимальные) размеры земельных участков и предельные параметры разрешенного строительства",
        ]
        if lk == "lim_kz":
            t = rng.choice(
                [
                    f"Максимальный процент застройки в границах земельного участка, определяемый как отношение суммарной площади земельного участка, которая может быть застроена, ко всей площади земельного участка — {_prot(_num(lim, fs, dp=0))} %.",
                    f"Процент застройки — не более {_prot(_num(lim, fs, dp=0))} %.",
                ]
            )
        else:
            t = rng.choice(
                [
                    f"Максимальный коэффициент использования территории — {_prot(_num(round(lim / 100, 4), fs))}.",
                    f"Коэффициент плотности застройки — не более {_prot(_num(round(lim / 100, 4), fs))}.",
                ]
            )
        lines += _wrap(t, 90)
        lines.append(
            f"Предельное количество этажей — {o['floors'] + rng.randint(1, 5)}."
        )
        lines.append("Минимальные отступы от границ земельного участка — 3 м.")
    elif cls == "vol_block":
        lines += _top(rng, o, stage, mark) + [rng.choice(PZ_HEAD)]
        pre = [_fact(rng, k, o, fs) for k in ["A", "gfa"][: rng.randint(0, 2)]]
        lines += _rows_table(rng, pre, fs) if pre else []
        inc = ("V", "Vu", "Vd")
        if allow_drop and rng.random() < 0.25:
            # страница без целевой строки (остальные объёмы — дистракторы)
            inc = tuple(k for k in inc if k != TARGET[param])
        blk, pres = _vol_block(
            rng,
            o,
            fs,
            include=inc,
            with_depth="depth" in targets or (param == "M-005" and rng.random() < 0.4),
        )
        lines += blk
        for k, v in pres.items():
            if k in targets:
                present[k] = (v, None)
        lines += _stamp(rng, o, stage, mark)
    elif cls == "section_marks":
        lines += [rng.choice(["Разрез 1-1", "Разрез А-А", "Фасад в осях 1-8"])]
        marks = [
            ("Верх парапета", o["H"]),
            ("Отм. чистого пола 2 этажа", o["fh"]),
            ("±0,000", 0.0),
            ("Планировочная отметка земли", o["ground"]),
        ]
        if rng.random() < 0.5:
            marks.append(
                ("Верх покрытия", round(o["H"] - rng.choice([0.6, 0.9, 1.2]), 3))
            )
        rng.shuffle(marks)
        for lab, v in marks:
            if lab == "±0,000":
                lines.append(rng.choice(["±0,000", "0,000"]))
                continue
            if rng.random() < 0.5:
                lines += [lab, _num(v, fs, dp=3, sign=True)]
            else:
                lines.append(f"{_num(v, fs, dp=3, sign=True)} {lab.lower()}")
        present["H"] = (o["H"], None)
        lines += _stamp(rng, o, stage, "АР")
    elif cls in ("abs_note", "abs_equation", "abs_gp_note"):
        lines += _top(rng, o, stage, mark)
        if cls == "abs_gp_note":
            lines += [
                "План организации рельефа",
                "Условные обозначения",
                "Проектная отметка",
                _num(round(o["abs"] + o["ground"], 2), fs, dp=2),
                "Отметка существующей поверхности",
                _num(
                    round(o["abs"] + o["ground"] - rng.uniform(0.1, 0.8), 2), fs, dp=2
                ),
            ]
            lines += _wrap(
                f"1. Отметка 0,000 соответствует абсолютной отметке {_prot(_num(o['abs'], fs))}.",
                80,
            )
        elif cls == "abs_equation":
            lines.append(rng.choice(["Привязка здания по высоте", "Высотная привязка"]))
            a3 = _num(o["abs"], fs, dp=3)
            lines.append(
                rng.choice(
                    [f"отм. ±0.000 = абс. {a3}", f"0,000 = {a3}", f"±0,000 ={a3} (БСВ)"]
                )
            )
        else:
            lines.append(
                rng.choice(
                    [
                        "Архитектурные решения",
                        "Конструктивные решения",
                        "3.1 Общие сведения",
                    ]
                )
            )
            lines += _wrap(
                _abs_note(rng, o, fs) + " " + _sentence(rng, _fact(rng, "H", o, fs), o),
                rng.choice([70, 95]),
            )
        present["abs"] = (o["abs"], None)
        lines += _stamp(rng, o, stage, "АР")
    elif cls == "object_title":
        lines.append(
            f"«{o['type']} на {o['cap']} {_fact(rng, 'cap', o, fs)['unit']} по адресу: {o['town']}, ул. Лесная, з/у {rng.randint(1, 60)}»"
        )
        lines.append("Раздел 1. Пояснительная записка")
        lines.append(_cipher(o, stage, "ПЗ"))
        lines.append(f"Том 1")
        if rng.random() < 0.5:
            lines.append(f"Электрическая нагрузка {_num(o['power'], fs)} кВт")
        present["cap"] = (float(o["cap"]), None)
    elif cls in (
        "ssr_full",
        "ssr_excl",
        "ssr_total_plain",
        "ssr_chapters_only",
        "ssr_base_current",
        "ssr_rd",
    ):
        mode = {
            "ssr_full": "full",
            "ssr_excl": "excl",
            "ssr_total_plain": "plain",
            "ssr_chapters_only": "chapters",
            "ssr_base_current": "base_current",
            "ssr_rd": "full",
        }[cls]
        if targets and targets[0] == "cost_excl" and cls in ("ssr_rd", "ssr_excl"):
            mode = "excl"
        lines, pr = _ssr(rng, o, fs, mode, stage)
        present.update(pr)
    elif cls == "pz_cost_text":
        f = _fact(rng, "cost_incl", o, fs)
        u = f["unit"]
        smr = round(o["E"] * rng.uniform(0.6, 0.75), 2)
        t = (
            f"Сметная стоимость строительства объекта в текущих ценах по состоянию на {rng.choice(['I', 'II', 'III', 'IV'])} квартал 20{o['yy']} г. "
            f"составляет {_prot(f['num'])} {u}, в том числе: строительно-монтажные работы — {_prot(_num(smr if u.startswith('тыс') else smr * 1000, fs, dp=2))} {u}; "
            f"НДС 20 % — {_prot(_num(o['vat'] if u.startswith('тыс') else o['vat'] * 1000, fs, dp=2))} {u}."
        )
        lines += [
            "Раздел 12. Смета на строительство",
            "Пояснительная записка к сметной документации",
        ] + _wrap(t, rng.choice([80, 100]))
        lines += _stamp(rng, o, stage, "СМ")
        present["cost_incl"] = (o["I"], "vat_incl")
    elif cls == "cost_mln_text":
        mln = round(o["I"] / 1000, 2)
        t = rng.choice(
            [
                f"Общая стоимость строительства — {_prot(_num(mln, fs, dp=2))} млн руб. с НДС.",
                f"Стоимость строительства с учетом НДС составляет {_prot(_num(mln, fs, dp=2))} млн руб.",
            ]
        )
        lines += (
            ["Основные технико-экономические показатели"]
            + _wrap(t, 90)
            + _stamp(rng, o, stage, "ПЗ")
        )
        present["cost_incl"] = (round(mln * 1000, 2), "vat_incl")
    else:
        raise KeyError(cls)
    if shuffle_rows:
        pass
    lines = [re.sub(r"(?<=[а-яa-z])\.\.(?=\s|$)", ".", ln) for ln in lines]
    return lines, present


def _shift(rng, param, o, key, big=False):
    """Значение «до изменения / существующее» для записей было/стало."""
    f = (
        rng.choice([0.7, 0.8, 0.9, 1.15])
        if big
        else rng.choice([0.97, 0.98, 1.02, 1.04])
    )
    if key in ("A", "V", "Vu", "Vd"):
        o[key] = round(o[key] * f, 1)
    elif key == "H":
        o["H"] = round(o["H"] * f, 2)
    elif key == "depth":
        o["depth"] = round(o["depth"] - rng.choice([0.3, 0.45, 0.6]), 3)
    elif key == "abs":
        o["abs"] = round(o["abs"] + rng.choice([-0.3, -0.15, 0.2, 0.45]), 2)
    elif key == "cap":
        o["cap"] = int(round(o["cap"] * f))
    elif key == "kz":
        o["kz"] = round(o["kz"] * f, 1)
    elif key == "kit":
        o["kit"] = float(round(o["kit"] * f))
    elif key.startswith("cost"):
        o["E"] = round(o["E"] * f, 2)
        _derive(o)


# ---------------------------------------------------------------------------
# Классы фраз по параметрам
# ---------------------------------------------------------------------------

GEN = [
    "tep_table",
    "tep_pipe",
    "tep_wrapped",
    "value_next_line",
    "unit_in_label",
    "text_sentence",
    "distractor_only",
    "change_note",
    "change_table",
    "general_data_ar",
    "stamp_heavy",
]

CLASSES = {
    "M-001": GEN + ["recon_table", "existing_only", "gp_table", "balance_table"],
    "M-004": GEN + ["vol_block", "recon_table"],
    "M-005": GEN + ["vol_block"],
    "M-006": GEN + ["vol_block"],
    "M-008": GEN + ["section_marks", "recon_table"],
    "M-009": [
        "abs_note",
        "abs_equation",
        "abs_gp_note",
        "tep_table",
        "value_next_line",
        "text_sentence",
        "distractor_only",
        "change_note",
        "general_data_ar",
        "stamp_heavy",
    ],
    "M-013": GEN + ["object_title", "recon_table", "existing_only"],
    "M-019": GEN + ["gp_table", "gpzu_vs_project", "limit_only", "balance_table"],
    "M-020": GEN + ["gp_table", "gpzu_vs_project", "limit_only"],
    "M-132": [
        "ssr_full",
        "ssr_excl",
        "ssr_total_plain",
        "ssr_chapters_only",
        "ssr_base_current",
        "pz_cost_text",
        "tep_table",
        "value_next_line",
        "cost_mln_text",
        "change_note",
        "text_sentence",
    ],
}


# ---------------------------------------------------------------------------
# Шум «другого» OCR (не Tesseract): слитные слова, число без пробела перед
# единицей, лишние переносы строк, неравномерная разбивка разрядов.
# Истина не меняется: цифры и их порядок сохраняются.
# ---------------------------------------------------------------------------

OCR_SHARE = 0.22
_UNIT_RE = re.compile(r"(\d)[ \u00a0]+(м2|м²|м3|м³|мм|м|%|кв\. ?м|куб\. ?м|кВт|мест)(?=[\s.,;)]|$)")
_WORDS_RE = re.compile(r"([А-Яа-яЁё]{3,}) ([а-яё]{3,})")
_GROUP_RE = re.compile(r"(?<![\d,.])(\d{1,3})[ \u00a0\u202f](\d{3})(?![\d])")


def _ocr(rng: random.Random, lines: list[str]) -> list[str]:
    out = []
    for ln in lines:
        r = rng.random()
        if r < 0.35:
            ln = _UNIT_RE.sub(lambda m: m.group(1) + m.group(2).replace(" ", ""), ln)
        if rng.random() < 0.25:
            ln = _WORDS_RE.sub(lambda m: m.group(1) + m.group(2), ln, count=1)
        ln = ln.replace("в т.ч.", "вт.ч.") if rng.random() < 0.5 else ln
        ln = ln.replace("в том числе", "втом числе") if rng.random() < 0.3 else ln
        if rng.random() < 0.15:
            # неравномерная разбивка разрядов: «12 345» → «123 45» / «1 2345»
            def regroup(m):
                d = m.group(1) + m.group(2)
                k = rng.randint(1, len(d) - 1)
                return d[:k] + " " + d[k:]
            ln = _GROUP_RE.sub(regroup, ln, count=1)
        if rng.random() < 0.12 and " " in ln.strip():
            # лишний перенос строки внутри подписи или между подписью и числом
            parts = ln.split(" ")
            k = rng.randint(1, len(parts) - 1)
            out.append(" ".join(parts[:k]))
            ln = " ".join(parts[k:])
        out.append(ln)
    return out


def samples(seed: int, n_per_param: int) -> list[dict]:
    """Страницы для оценки извлечения (см. описание формата в задаче T-173)."""
    rng = random.Random(seed)
    out = []
    for param in PARAMS:
        cl = CLASSES[param][:]
        rng.shuffle(cl)
        for i in range(n_per_param):
            cls = cl[i % len(cl)]
            aspect = None
            if param == "M-005" and i % 2 == 1 and cls not in ("vol_block",):
                aspect = "depth"
            o = _obj(rng)
            fs = _fs(rng)
            targets = None
            if param == "M-132" and cls in (
                "tep_table",
                "value_next_line",
                "change_note",
                "text_sentence",
            ):
                targets = [
                    rng.choice(["cost_incl", "cost_incl", "cost_excl", "cost_plain"])
                ]
            if (
                param == "M-005"
                and cls == "vol_block"
                and aspect is None
                and i % 3 == 0
            ):
                aspect = "depth"
            if aspect == "depth" and cls == "vol_block":
                targets = ["depth"]
            lines, present = _page(
                rng, param, o, cls, fs, aspect=aspect, targets=targets
            )
            tk = (targets or (["depth"] if aspect == "depth" else [TARGET[param]]))[0]
            truth, variant = None, None
            if param == "M-132":
                for k in ("cost_incl", "cost_excl", "cost_plain"):
                    if k in present:
                        truth, variant = present[k]
                        break
            elif tk in present:
                truth, _ = present[tk]
            lk = _limit_key(param)
            limit = present[lk][0] if lk and lk in present else None
            if rng.random() < OCR_SHARE:
                lines = _ocr(rng, lines)
                cls = cls + "+ocr"
            out.append(
                {
                    "id": f"H-{param}-{i:04d}",
                    "param": param,
                    "aspect": aspect,
                    "lines": lines,
                    "truth": None if truth is None else float(truth),
                    "variant": variant if param == "M-132" else None,
                    "limit": limit,
                    "cls": cls,
                }
            )
    return out


# ---------------------------------------------------------------------------
# Пары ПД → РД
# ---------------------------------------------------------------------------

TOL = {
    "M-001": 0.05,
    "M-004": 0.05,
    "M-006": 0.05,
    "M-009": 0.005,
    "M-008": 0.005,
    "M-013": 0.5,
}
EPS = 1e-9


def _rule(param, pd, rd):
    """Правило Матрицы: CANDIDATE / NEGATIVE_VERIFIED."""
    if param in ("M-001", "M-004", "M-006", "M-009"):
        return abs(rd["value"] - pd["value"]) > TOL[param] + EPS
    if param == "M-005":
        return (
            abs(rd["value"] - pd["value"]) > 0.05 + EPS
            or abs(rd["depth"] - pd["depth"]) > 0.005 + EPS
        )
    if param == "M-008":
        return rd["value"] - pd["value"] > 0.005 + EPS
    if param == "M-013":
        return pd["value"] - rd["value"] > 0.5 + EPS
    if param in ("M-019", "M-020"):
        L = pd["limit"] if pd["limit"] is not None else rd["limit"]
        if rd["value"] - pd["value"] > 0.05 + EPS:
            return True
        return L is not None and max(pd["value"], rd["value"]) > L + 0.05 + EPS
    if param == "M-132":
        if pd["variant"] == rd["variant"]:
            return (rd["value"] - pd["value"]) / pd["value"] > 0.05 + EPS
        if (
            pd["variant"] == "vat_incl"
            and rd["variant"] == "vat_excl"
            and abs(rd["value"] * 1.2 - pd["value"]) <= 0.02
        ):
            return False
        pe = pd["value"] / 1.2 if pd["variant"] == "vat_incl" else pd["value"]
        re = rd["value"] / 1.2 if rd["variant"] == "vat_incl" else rd["value"]
        return (re - pe) / pe > 0.05 + EPS
    raise KeyError(param)


# мутация → ожидаемая метка (C — CANDIDATE, N — NEGATIVE_VERIFIED)
MUT = {
    "M-001": {
        "C": [
            "increase_small",
            "increase_large",
            "decrease_small",
            "decrease_large",
            "change_other_format",
        ],
        "N": [
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-004": {
        "C": [
            "increase_small",
            "increase_large",
            "decrease_small",
            "decrease_large",
            "change_other_format",
        ],
        "N": [
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-006": {
        "C": [
            "increase_small",
            "increase_large",
            "decrease_small",
            "decrease_large",
            "change_other_format",
        ],
        "N": [
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-005": {
        "C": [
            "increase_small",
            "decrease_large",
            "depth_change",
            "depth_change_small",
            "change_other_format",
        ],
        "N": [
            "same_other_format",
            "within_tol",
            "depth_within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-008": {
        "C": ["increase_small", "increase_large", "increase_other_format"],
        "N": [
            "better",
            "better_large",
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-009": {
        "C": ["change_small", "change_large", "change_other_format", "decrease_small"],
        "N": [
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-013": {
        "C": ["decrease_small", "decrease_large", "decrease_other_format"],
        "N": [
            "better",
            "same_other_format",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-019": {
        "C": [
            "increase_small",
            "increase_large",
            "limit_breach",
            "limit_breach_pd_only",
            "increase_other_format",
        ],
        "N": [
            "better",
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-020": {
        "C": [
            "increase_small",
            "increase_large",
            "limit_breach",
            "limit_breach_pd_only",
            "increase_other_format",
        ],
        "N": [
            "better",
            "same_other_format",
            "within_tol",
            "row_permutation",
            "same_value_other_section",
        ],
    },
    "M-132": {
        "C": [
            "increase_small",
            "increase_large",
            "increase_excl",
            "increase_other_format",
        ],
        "N": [
            "within_5pct",
            "decrease",
            "vat_mismatch_same_total",
            "same_other_format",
            "same_total_other_breakdown",
        ],
    },
}

KEYVAL = {
    "M-001": "A",
    "M-004": "V",
    "M-005": "Vd",
    "M-006": "Vu",
    "M-008": "H",
    "M-009": "abs",
    "M-013": "cap",
    "M-019": "kz",
    "M-020": "kit",
}


def _apply(param, o, delta=None, factor=None, depth_delta=None):
    """Изменить значение показателя в объекте с сохранением согласованности."""
    if param in ("M-001",):
        o["A"] = round(o["A"] * factor, 1) if factor else round(o["A"] + delta, 2)
    elif param == "M-004":
        # общий объём меняется через надземную часть
        nv = round(o["V"] * factor) if factor else round(o["V"] + delta, 2)
        o["Vu"] = round(nv - o["Vd"], 2)
    elif param == "M-006":
        o["Vu"] = (
            float(round(o["Vu"] * factor)) if factor else round(o["Vu"] + delta, 2)
        )
    elif param == "M-005":
        if factor or delta:
            o["Vd"] = (
                float(round(o["Vd"] * factor)) if factor else round(o["Vd"] + delta, 2)
            )
        if depth_delta:
            o["depth"] = round(o["depth"] + depth_delta, 3)
    elif param == "M-008":
        o["H"] = round(o["H"] * factor, 2) if factor else round(o["H"] + delta, 3)
    elif param == "M-009":
        o["abs"] = round(o["abs"] + delta, 3)
    elif param == "M-013":
        o["cap"] = int(round(o["cap"] * factor)) if factor else int(o["cap"] + delta)
    elif param == "M-019":
        o["kz"] = round(o["kz"] * factor, 1) if factor else round(o["kz"] + delta, 2)
    elif param == "M-020":
        o["kit"] = (
            float(round(o["kit"] * factor)) if factor else round(o["kit"] + delta, 2)
        )
    elif param == "M-132":
        o["E"] = round(o["E"] * factor, 2)
    _derive(o)


def _mutate(rng, param, o, mut):
    """Возвращает (o_pd, o_rd, flags)."""
    pd, rd = copy.deepcopy(o), copy.deepcopy(o)
    fl = {
        "flip": False,
        "shuffle": False,
        "pct_only": False,
        "rd_excl": False,
        "both_excl": False,
        "show_limit": None,
        "rd_rub": False,
    }
    tol = TOL.get(param, 0.05)
    if mut in ("same_other_format",):
        fl["flip"] = True
        if param == "M-132":
            fl["rd_rub"] = True
    elif mut in ("row_permutation", "same_total_other_breakdown"):
        fl["shuffle"] = True
    elif mut == "same_value_other_section":
        pass
    elif mut == "within_tol":
        fl["pct_only"] = True
        if param in ("M-001", "M-004", "M-006"):
            _apply(param, pd, delta=rng.choice([0.01, 0.02, 0.03, 0.04]))
        elif param == "M-005":
            _apply(param, pd, delta=rng.choice([0.02, 0.03, 0.04]))
        elif param in ("M-008", "M-009"):
            _apply(param, rd, delta=rng.choice([0.001, 0.002, 0.003, 0.004]))
        elif param in ("M-019", "M-020"):
            _apply(param, rd, delta=rng.choice([0.01, 0.02, 0.03, 0.04]))
    elif mut == "depth_within_tol":
        rd["depth"] = round(rd["depth"] - rng.choice([0.001, 0.002, 0.003]), 3)
    elif mut in ("increase_small", "change_small"):
        if param in ("M-001",):
            _apply(param, rd, delta=rng.choice([0.1, 0.2, 0.5, 0.8, 1.5]))
        elif param in ("M-004", "M-006", "M-005"):
            _apply(param, rd, delta=float(rng.choice([1, 2, 5, 12, 30])))
        elif param in ("M-008", "M-009"):
            _apply(param, rd, delta=rng.choice([0.01, 0.02, 0.03, 0.05, 0.15]))
        elif param in ("M-019",):
            _apply(param, rd, delta=rng.choice([0.1, 0.2, 0.4, 0.8]))
        elif param in ("M-020",):
            _apply(param, rd, delta=float(rng.choice([1, 2, 3, 5])))
        elif param == "M-132":
            _apply(param, rd, factor=1 + rng.uniform(0.056, 0.075))
    elif mut in ("increase_large", "change_large"):
        if param == "M-009":
            _apply(param, rd, delta=rng.choice([-1.2, -0.5, 0.6, 1.35, 2.1]))
        elif param == "M-008":
            _apply(param, rd, delta=pd["fh"])  # добавили этаж
        elif param == "M-132":
            _apply(param, rd, factor=1 + rng.uniform(0.1, 0.35))
        elif param == "M-020":
            _apply(param, rd, delta=float(rng.randint(15, 40)))
        elif param == "M-019":
            _apply(param, rd, delta=rng.choice([2.0, 3.5, 4.4]))
        else:
            _apply(param, rd, factor=1 + rng.uniform(0.04, 0.2))
    elif mut in ("decrease_small",):
        if param == "M-001":
            _apply(param, rd, delta=-rng.choice([0.1, 0.3, 0.6, 1.2]))
        elif param in ("M-004", "M-006"):
            _apply(param, rd, delta=-float(rng.choice([1, 3, 8, 20])))
        elif param == "M-009":
            _apply(param, rd, delta=-rng.choice([0.01, 0.02, 0.05]))
        elif param == "M-013":
            _apply(param, rd, delta=-rng.choice([1, 2, 5, 10]))
    elif mut in ("decrease_large",):
        _apply(param, rd, factor=1 - rng.uniform(0.05, 0.3))
    elif mut in (
        "change_other_format",
        "increase_other_format",
        "decrease_other_format",
    ):
        fl["flip"] = True
        if param == "M-132":
            fl["rd_rub"] = True
            _apply(param, rd, factor=1 + rng.uniform(0.08, 0.2))
        elif param == "M-013":
            _apply(param, rd, delta=-rng.choice([10, 20, 50]))
        elif param == "M-008":
            _apply(param, rd, delta=rng.choice([0.02, 0.3, 0.6]))
        elif param == "M-009":
            _apply(param, rd, delta=rng.choice([0.05, -0.1, 0.25]))
        elif param in ("M-019",):
            _apply(param, rd, delta=rng.choice([0.5, 1.0, 2.0]))
        elif param in ("M-020",):
            _apply(param, rd, delta=float(rng.choice([5, 10, 20])))
        elif param == "M-005":
            _apply(param, rd, delta=float(rng.choice([15, 40, 120])))
        else:
            _apply(param, rd, factor=1 + rng.choice([-1, 1]) * rng.uniform(0.01, 0.1))
    elif mut == "depth_change":
        _apply(param, rd, depth_delta=-rng.choice([0.3, 0.45, 0.6, 1.2]))
    elif mut == "depth_change_small":
        _apply(param, rd, depth_delta=rng.choice([-0.01, -0.02, 0.05]))
    elif mut in ("better", "better_large"):
        if param == "M-008":
            _apply(
                param,
                rd,
                delta=-(rng.choice([0.01, 0.05, 0.3]) if mut == "better" else pd["fh"]),
            )
        elif param == "M-013":
            _apply(param, rd, delta=rng.choice([1, 5, 20, 60]))
        elif param in ("M-019", "M-020"):
            _apply(
                param,
                rd,
                delta=-rng.choice([0.2, 1.0, 3.0])
                if param == "M-019"
                else -float(rng.choice([2, 10, 25])),
            )
    elif mut in ("limit_breach", "limit_breach_pd_only"):
        fl["show_limit"] = True
        k = KEYVAL[param]
        L = o["lim_kz" if param == "M-019" else "lim_kit"]
        if mut == "limit_breach":
            rd[k] = round(
                L + rng.choice([0.5, 2.0, 5.0]) * (1 if param == "M-019" else 4), 1
            )
        else:
            pd[k] = round(
                L + rng.choice([2.0, 4.0, 6.0]) * (1 if param == "M-019" else 4), 1
            )
            rd[k] = round(
                pd[k] - rng.choice([0.5, 1.0]) * (1 if param == "M-019" else 2), 1
            )
    elif mut == "within_5pct":
        _apply(param, rd, factor=1 + rng.uniform(0.005, 0.044))
    elif mut == "decrease":
        _apply(param, rd, factor=1 - rng.uniform(0.02, 0.15))
    elif mut == "vat_mismatch_same_total":
        fl["rd_excl"] = True
    elif mut == "increase_excl":
        fl["both_excl"] = True
        _apply(param, rd, factor=1 + rng.uniform(0.08, 0.2))
    else:
        raise KeyError(mut)
    del tol
    return pd, rd, fl


PD_CLS = {
    "M-001": [
        "tep_table",
        "tep_wrapped",
        "value_next_line",
        "tep_pipe",
        "stamp_heavy",
        "text_sentence",
    ],
    "M-004": [
        "tep_table",
        "tep_wrapped",
        "value_next_line",
        "vol_block",
        "stamp_heavy",
    ],
    "M-005": ["tep_table", "vol_block", "value_next_line", "stamp_heavy"],
    "M-006": ["tep_table", "tep_wrapped", "vol_block", "stamp_heavy"],
    "M-008": [
        "tep_table",
        "tep_wrapped",
        "value_next_line",
        "text_sentence",
        "stamp_heavy",
    ],
    "M-009": ["abs_note", "tep_table", "text_sentence", "abs_equation"],
    "M-013": ["tep_table", "value_next_line", "text_sentence", "tep_wrapped"],
    "M-019": ["tep_table", "gpzu_vs_project", "gp_table"],
    "M-020": ["tep_table", "gpzu_vs_project", "gp_table"],
    "M-132": ["ssr_full"],
}


def _truth(param, present, targets):
    t = {"value": None, "depth": None, "variant": None, "limit": None}
    if param == "M-132":
        for k in ("cost_incl", "cost_excl", "cost_plain"):
            if k in present:
                t["value"], t["variant"] = float(present[k][0]), present[k][1]
                break
        return t
    k = KEYVAL[param]
    if k in present:
        t["value"] = float(present[k][0])
    if param == "M-005" and "depth" in present:
        t["depth"] = float(present["depth"][0])
    lk = _limit_key(param)
    if lk and lk in present:
        t["limit"] = float(present[lk][0])
    return t


def pairs(seed: int, n_per_param: int) -> list[dict]:
    """Пары «ПД → РД» (см. описание формата в задаче T-173)."""
    rng = random.Random(seed * 7919 + 13)
    out = []
    for param in PARAMS:
        pos, neg = MUT[param]["C"][:], MUT[param]["N"][:]
        rng.shuffle(pos)
        rng.shuffle(neg)
        for i in range(n_per_param):
            expect_c = i % 2 == 0
            mut = (pos if expect_c else neg)[(i // 2) % len(pos if expect_c else neg)]
            o = _obj(rng)
            pd_o, rd_o, fl = _mutate(rng, param, o, mut)
            fs_pd = _fs(rng)
            fs_rd = (
                _fs_flip(rng, fs_pd)
                if fl["flip"]
                else dict(
                    fs_pd,
                    sep=rng.choice([" ", "  ", " | "]),
                    unit=fs_pd["unit"] + rng.choice([0, 0, 2]),
                )
            )
            if param in ("M-019", "M-020") and (fl["pct_only"] or mut == "within_tol"):
                # в пределах допуска пишут процентами с двумя знаками
                fs_pd["unit"] = 0 if param == "M-019" else 3
                fs_rd["unit"] = 2 if param == "M-019" else 3
            if param == "M-132":
                fs_rd["cost_unit"] = "руб" if fl["rd_rub"] else fs_pd["cost_unit"]
            targets = [KEYVAL[param]] if param != "M-132" else ["cost_incl"]
            if param == "M-005":
                targets = ["Vd", "depth"]
            pd_cls = rng.choice(PD_CLS[param])
            rd_cls = {"M-019": "gp_table", "M-020": "gp_table", "M-132": "ssr_rd"}.get(
                param, "general_data_ar"
            )
            if mut == "same_value_other_section" and param not in ("M-132",):
                pd_cls = rng.choice(PD_CLS[param])
            show_lim = None
            if param in ("M-019", "M-020"):
                show_lim = bool(fl["show_limit"]) or rng.random() < 0.3
                if fl["show_limit"]:
                    pd_cls = "gpzu_vs_project"
            pd_t = list(targets)
            rd_t = list(targets)
            if param == "M-132":
                if fl["both_excl"]:
                    pd_cls = "ssr_excl"
                    pd_t = rd_t = ["cost_excl"]
                if fl["rd_excl"]:
                    rd_t = ["cost_excl"]
            if param == "M-005" and pd_cls == "vol_block":
                pass
            pd_lines, pd_pr = _page(
                rng,
                param,
                pd_o,
                pd_cls,
                fs_pd,
                stage="П",
                targets=pd_t,
                show_limit=show_lim if param in ("M-019", "M-020") else None,
                allow_drop=False,
            )
            if param == "M-005":
                # в «Общих данных» РД отметка низа — строкой указаний
                rd_lines, rd_pr = _rd_m005(rng, rd_o, fs_rd, fl["shuffle"])
            else:
                rd_lines, rd_pr = _page(
                    rng,
                    param,
                    rd_o,
                    rd_cls,
                    fs_rd,
                    stage="Р",
                    targets=rd_t,
                    show_limit=(rng.random() < 0.5)
                    if param in ("M-019", "M-020")
                    else None,
                    shuffle_rows=fl["shuffle"],
                )
            if fl["shuffle"] and param not in ("M-132",):
                rd_lines = _permute_table(rng, rd_lines)
            pd_truth = _truth(param, pd_pr, pd_t)
            rd_truth = _truth(param, rd_pr, rd_t)
            if param == "M-009" and pd_truth["value"] is None:
                raise AssertionError((param, pd_cls))
            is_c = _rule(param, pd_truth, rd_truth)
            if is_c != expect_c:
                raise AssertionError(
                    f"{param} {mut}: правило={is_c}, ожидалось={expect_c}; {pd_truth} → {rd_truth}"
                )
            pair_cls = f"{pd_cls}->{rd_cls}"
            if rng.random() < OCR_SHARE:
                side = rng.choice(["pd", "rd", "both"])
                if side in ("pd", "both"):
                    pd_lines = _ocr(rng, pd_lines)
                if side in ("rd", "both"):
                    rd_lines = _ocr(rng, rd_lines)
                pair_cls += "+ocr"
            out.append(
                {
                    "id": f"HP-{param}-{i:04d}",
                    "param": param,
                    "pd_lines": pd_lines,
                    "rd_lines": rd_lines,
                    "pd_truth": pd_truth,
                    "rd_truth": rd_truth,
                    "label": "CANDIDATE" if is_c else "NEGATIVE_VERIFIED",
                    "mutation": mut,
                    "cls": pair_cls,
                }
            )
    return out


def _rd_m005(rng, o, fs, shuffle):
    """РД для M-005: объёмы в таблице «Общих данных», отметка низа — в указаниях или строкой таблицы."""
    keys = ["A", "V", "Vu", "Vd", "floors"]
    if shuffle:
        rng.shuffle(keys)
    fl = [_fact(rng, k, o, fs) for k in keys]
    df = _fact(rng, "depth", o, fs)
    if rng.random() < 0.5:
        fl.append(df)
        note = None
    else:
        note = f"Низ фундаментной плиты на отм. {_prot(_num(o['depth'], fs, dp=3))} (абс. {_prot(_num(round(o['abs'] + o['depth'], 3), fs, dp=3))})."
    lines = _general_data(
        rng,
        o,
        fs,
        fl,
        _abs_note(rng, o, fs) if rng.random() < 0.5 else None,
        depth_note=note,
    )
    return lines, {"Vd": (o["Vd"], None), "depth": (o["depth"], None)}


def _permute_table(rng, lines):
    """Перестановка соседних строк таблицы, начинающихся с номера."""
    idx = [
        i
        for i, ln in enumerate(lines)
        if ln[:1].isdigit() and not ln.startswith("1 2 3")
    ]
    if len(idx) >= 2:
        a, b = rng.sample(idx, 2)
        lines = lines[:]
        lines[a], lines[b] = lines[b], lines[a]
    return lines


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    S = samples(7, 40)
    P = pairs(7, 40)
    print(f"samples: {len(S)}, pairs: {len(P)}")
    for param in PARAMS:
        c = Counter(s["cls"] for s in S if s["param"] == param)
        none = sum(1 for s in S if s["param"] == param and s["truth"] is None)
        print(f"{param}: классов {len(c)}, truth=None {none}: {dict(c)}")
    lab = Counter((p["param"], p["label"]) for p in P)
    for param in PARAMS:
        print(
            f"{param}: CANDIDATE {lab[(param, 'CANDIDATE')]}, NEGATIVE {lab[(param, 'NEGATIVE_VERIFIED')]}; "
            f"мутации {sorted(Counter(p['mutation'] for p in P if p['param'] == param))}"
        )
    for param in PARAMS:
        print("=" * 30, param)
        for s in [s for s in S if s["param"] == param][:3]:
            print(
                f"--- {s['id']} {s['cls']} aspect={s['aspect']} truth={s['truth']} variant={s['variant']} limit={s['limit']}"
            )
            print("\n".join(s["lines"]))
