"""DEV-набор фраз T-173: на нём настраиваются паспорта и экстрактор количества (M-001, 004, 005, 006, 008, 009, 013,
019, 020, 132). Итоговое качество считается НЕ здесь, а на отложенном наборе `holdout.py`, который написан отдельно,
без знания экстрактора (урок T-172: набор, подогнанный под свои якоря, даёт 1,00, отложенный — Recall 0,30).

Только вымышленные объекты и числа (ADR-0002). API совпадает с holdout.py: samples(seed, n) и pairs(seed, n).
"""

from __future__ import annotations

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
STAMP = ["Изм. Кол.уч. Лист №док. Подп. Дата", "ГИП Петров", "Лист"]


def _fmt(v: float, dec: int, rnd: random.Random, sep: str | None = None) -> str:
    """Число как в документе: разряды пробелом (или без), запятая или точка."""
    s = f"{abs(v):,.{dec}f}"
    if sep is None:
        sep = rnd.choice([" ", "", " "])
    s = (
        s.replace(",", "\x00")
        .replace(".", rnd.choice([",", "."]) if dec else ".")
        .replace("\x00", sep)
    )
    return ("-" if v < 0 else "") + s


def _cipher(rnd: random.Random, stage: str, disc: str) -> str:
    return f"ДЕВ-{rnd.randint(10, 99)}/{rnd.randint(20, 26)}-{stage}-{disc}"


def _frame(
    rnd: random.Random, body: list[str], stage: str = "П", disc: str = "ПЗ"
) -> list[str]:
    head = [
        _cipher(rnd, stage, disc),
        rnd.choice(["Технико-экономические показатели", "Общие данные", "Таблица 1"]),
    ]
    return head + body + [*STAMP, str(rnd.randint(2, 40))]


# ---------------------------------------------------------------- значения по параметру


def _value(param: str, rnd: random.Random) -> float:
    return {
        "M-001": lambda: round(rnd.uniform(400, 5000), 1),
        "M-004": lambda: round(rnd.uniform(8000, 120000), 1),
        "M-005": lambda: round(rnd.uniform(1500, 20000), 1),
        "M-006": lambda: round(rnd.uniform(6000, 100000), 1),
        "M-008": lambda: round(rnd.uniform(9, 150), 2),
        "M-009": lambda: round(rnd.uniform(110, 190), 2),
        "M-013": lambda: float(
            rnd.choice([rnd.randint(50, 1500), rnd.randint(10, 300) * 10])
        ),
        "M-019": lambda: round(rnd.uniform(15, 65), 1),
        "M-020": lambda: round(rnd.uniform(60, 450), 0),
        "M-132": lambda: round(rnd.uniform(150000, 9000000), 2),
    }[param]()


def _depth(rnd: random.Random) -> float:
    return -round(rnd.uniform(2.5, 12.0), 3)


# ---------------------------------------------------------------- строки по параметру


def _lines(
    param: str,
    v: float,
    rnd: random.Random,
    fmt: str = "any",
    variant: str | None = None,
    limit: float | None = None,
    depth: float | None = None,
) -> tuple[list[str], str]:
    """Страница с показателем: (строки, класс фразы)."""
    r = rnd
    if param == "M-001":
        u = r.choice(["м2", "м²", "кв.м", "кв. м"])
        forms = [
            (
                "tep_table",
                [
                    f"1 Площадь участка {u} {_fmt(v * r.uniform(2, 4), 1, r)}",
                    f"2 Площадь застройки {u} {_fmt(v, 1, r)}",
                    f"3 Общая площадь здания {u} {_fmt(v * 5, 1, r)}",
                ],
            ),
            (
                "text_sentence",
                [f"Площадь застройки здания составляет {_fmt(v, 1, r)} {u}."],
            ),
            ("value_next_line", ["Площадь застройки,", f"{u} {_fmt(v, 1, r)}"]),
        ]
    elif param == "M-004":
        u = r.choice(["м3", "м³", "куб.м", "куб. м"])
        forms = [
            (
                "tep_table",
                [
                    f"4 Строительный объем, {u} {_fmt(v, 1, r)}",
                    f"в т.ч. надземной части {u} {_fmt(v * 0.8, 1, r)}",
                    f"подземной части {u} {_fmt(v * 0.2, 1, r)}",
                ],
            ),
            ("text_sentence", [f"Строительный объём здания — {_fmt(v, 1, r)} {u}."]),
            (
                "tep_table_total",
                [
                    f"Строительный объем всего {_fmt(v, 1, r)} {u}",
                    f"Строительный объем подземной части {_fmt(v * 0.2, 1, r)} {u}",
                ],
            ),
        ]
    elif param == "M-005":
        u = r.choice(["м3", "м³", "куб.м"])
        d = depth if depth is not None else _depth(r)
        dz = _fmt(d, 3, r, "").replace("-", r.choice(["-", "−", "–"]))
        forms = [
            (
                "tep_table",
                [
                    f"Строительный объем {u} {_fmt(v * 5, 1, r)}",
                    f"в т.ч. подземной части {u} {_fmt(v, 1, r)}",
                    f"Отметка низа фундаментной плиты {dz}",
                ],
            ),
            (
                "text_sentence",
                [
                    f"Строительный объём подземной части составляет {_fmt(v, 1, r)} {u}. Отметка пола подвала {dz}."
                ],
            ),
            (
                "tep_line",
                [
                    f"Строительный объем подземной части здания, {u} {_fmt(v, 1, r)}",
                    f"Глубина заложения фундамента, м {_fmt(abs(d), 3, r)}",
                ],
            ),
        ]
    elif param == "M-006":
        u = r.choice(["м3", "м³", "куб.м"])
        forms = [
            (
                "tep_table",
                [
                    f"Строительный объем, {u} {_fmt(v * 1.2, 1, r)}",
                    f"в т.ч. надземной части {_fmt(v, 1, r)}",
                    f"подземной части {_fmt(v * 0.2, 1, r)}",
                ],
            ),
            (
                "text_sentence",
                [f"Строительный объём надземной части здания — {_fmt(v, 1, r)} {u}."],
            ),
            ("above_mark", [f"Строительный объем выше отм. 0.000 {_fmt(v, 1, r)} {u}"]),
        ]
    elif param == "M-008":
        forms = [
            (
                "tep_table",
                [
                    f"Этажность, эт. {r.randint(3, 30)}",
                    f"Высота здания, м {_fmt(v, 2, r, '')}",
                ],
            ),
            ("mm", [f"Высота здания {_fmt(v * 1000, 0, r)} мм"]),
            ("elevation", [f"Отметка верха парапета +{_fmt(v, 3, r, '')}"]),
            (
                "paren",
                [
                    f"Высота здания (от отм. 0,000 до верха парапета) {_fmt(v, 2, r, '')} м"
                ],
            ),
        ]
    elif param == "M-009":
        forms = [
            (
                "text_sentence",
                [
                    f"За относительную отметку 0,000 принята абсолютная отметка {_fmt(v, 2, r, '')} м."
                ],
            ),
            (
                "general_data_ar",
                [
                    f"Отметка ±0.000 соответствует абсолютной отметке {_fmt(v, 3, r, '')} в Балтийской системе высот."
                ],
            ),
            ("short", [f"отм. 0.000 = абс. {_fmt(v, 2, r, '')}"]),
        ]
    elif param == "M-013":
        unit = r.choice(["мест", "учащихся", "детей", "посещений в смену"])
        forms = [
            (
                "tep_table",
                [
                    f"Расчетная электрическая мощность, кВт {r.randint(100, 900)}",
                    f"Вместимость, {unit} {int(v)}",
                ],
            ),
            ("text_sentence", [f"Проектная мощность объекта — {int(v)} {unit}."]),
            ("capacity_line", [f"Вместимость {int(v)} {unit}"]),
        ]
    elif param == "M-019":
        pct = r.random() < 0.5
        val = (
            f"{_fmt(v, 1, r, '')} %"
            if pct
            else _fmt(v / 100, 3 if round(v, 1) * 10 % 10 else 2, r, "")
        )
        lim = (
            [f"Максимальный процент застройки — {_fmt(limit, 0, r, '')} %"]
            if limit is not None
            else []
        )
        forms = [
            (
                "gp_table",
                [
                    f"Площадь участка, м2 {_fmt(r.uniform(5000, 20000), 1, r)}",
                    f"{'Процент' if pct else 'Коэффициент'} застройки {val}",
                    f"Коэффициент использования территории {_fmt(r.uniform(1, 4), 2, r, '')}",
                    *lim,
                ],
            ),
            (
                "text_sentence",
                [
                    *lim,
                    f"{'Процент' if pct else 'Коэффициент'} застройки составляет {val}.",
                ],
            ),
        ]
    elif param == "M-020":
        pct = r.random() < 0.5
        val = f"{_fmt(v, 0, r, '')} %" if pct else _fmt(v / 100, 2, r, "")
        lim = (
            [
                f"Предельный коэффициент использования территории — не более {_fmt(limit, 0, r, '')} %"
            ]
            if limit is not None
            else []
        )
        forms = [
            (
                "gp_table",
                [
                    f"Коэффициент застройки {_fmt(r.uniform(0.2, 0.6), 2, r, '')}",
                    f"Коэффициент использования территории {val}",
                    *lim,
                ],
            ),
            ("text_sentence", [*lim, f"КИТ {val}"]),
        ]
    else:  # M-132
        rub = r.random() < 0.3 and fmt != "tys"
        val = f"{_fmt(v * 1000, 2, r)} руб." if rub else f"{_fmt(v, 2, r)} тыс. руб."
        vat = round(v * 0.2 / 1.2, 2)
        tail = {"vat_incl": " с НДС", "vat_excl": " без НДС", None: ""}[variant]
        forms = [
            (
                "ssr_table",
                [
                    f"Итого по сводному сметному расчету{tail} {val}",
                    f"в т.ч. НДС 20 % {_fmt(vat, 2, r)}",
                ],
            ),
            ("ssr_total", [f"Всего по сводному сметному расчету{tail} {val}"]),
            (
                "text_sentence",
                [f"Сметная стоимость строительства{tail} составляет {val}"],
            ),
        ]
    cls, body = r.choice(forms)
    return body, cls


def _distractor(param: str, rnd: random.Random) -> tuple[list[str], str]:
    x = rnd.uniform(100, 9000)
    return {
        "M-001": [
            f"Площадь участка, м2 {_fmt(x, 1, rnd)}",
            f"Площадь озеленения, м2 {_fmt(x / 3, 1, rnd)}",
        ],
        "M-004": [f"Общая площадь здания, м2 {_fmt(x, 1, rnd)}"],
        "M-005": [f"Строительный объем надземной части, м3 {_fmt(x, 1, rnd)}"],
        "M-006": [f"Строительный объем подземной части, м3 {_fmt(x, 1, rnd)}"],
        "M-008": [
            f"Высота этажа, м {_fmt(3.3, 2, rnd, '')}",
            f"Высота помещений 2,7 м",
        ],
        "M-009": [
            "Относительная отметка чистого пола 1 этажа 0,000",
            f"Отметка низа плиты -{_fmt(4.2, 3, rnd, '')}",
        ],
        "M-013": [
            f"Расчетная электрическая мощность {int(x / 10)} кВт",
            f"Тепловая мощность {_fmt(x / 5000, 3, rnd, '')} Гкал/ч",
        ],
        "M-019": [
            f"Коэффициент использования территории {_fmt(2.4, 2, rnd, '')}",
            "Максимальный процент застройки — 60 %",
        ],
        "M-020": [f"Коэффициент застройки {_fmt(0.42, 2, rnd, '')}"],
        "M-132": [
            f"НДС 20 % {_fmt(x * 100, 2, rnd)}",
            f"Итого по главе 2 {_fmt(x * 300, 2, rnd)}",
        ],
    }[param], "distractor_only"


# ---------------------------------------------------------------- шум текстового слоя и формы таблиц (DEV, T-173)


def _noise(body: list[str], rnd: random.Random) -> list[str]:
    """Шум другого OCR и вёрстки: число приклеено к единице, слитные слова, перенос подписи, таблица через «|»."""
    out: list[str] = []
    for ln in body:
        k = rnd.random()
        if k < 0.25:
            ln = re.sub(r"(\d) (м2|м²|м3|м³|м|мм|%|кв\.м|куб\.м|тыс\. руб\.|руб\.)(?=\s|$|\.)", r"\1\2", ln)
        elif k < 0.4:
            ln = re.sub(r"(?<=[а-яё]) (?=[а-яё]{3,})", "", ln, count=1)
        elif k < 0.55 and " " in ln:
            words = ln.split(" ")
            cut = max(1, min(len(words) - 1, 2))
            out.append(" ".join(words[:cut]))
            ln = " ".join(words[cut:])
        elif k < 0.7:
            # ячейки таблицы: «подпись | значение» — черта только между подписью и числом, не внутри подписи
            ln = ln if re.search(r"0[.,]000", ln) else re.sub(r"\s+(?=[+\-−–±]?\d[\d  ]*(?:[.,]\d+)?(?:\s|$))", " | ", ln, count=1)
        out.append(ln)
    return out


def _change_note(param: str, v: float, rnd: random.Random) -> list[str]:
    """Запись в таблице изменений листа: «было … стало …» — не значение ТЭП."""
    name = {"M-001": "площадь застройки", "M-004": "строительный объем", "M-005": "строительный объем подземной части", "M-006": "строительный объем надземной части", "M-008": "высота здания",
            "M-009": "абсолютная отметка", "M-013": "вместимость", "M-019": "коэффициент застройки", "M-020": "коэффициент использования территории", "M-132": "сметная стоимость строительства"}[param]
    return [f"Изм. 1 — уточнена {name}: было {_fmt(v * 0.97, 1, rnd, '')}, стало {_fmt(v, 1, rnd, '')}"]


# ---------------------------------------------------------------- публичный API


def samples(seed: int, n_per_param: int) -> list[dict]:
    out: list[dict] = []
    for param in PARAMS:
        r = random.Random(f"{seed}:{param}:dev")
        for i in range(n_per_param):
            aspect = "depth" if param == "M-005" and i % 4 == 3 else None
            variant = (
                r.choice([None, "vat_incl", "vat_excl"]) if param == "M-132" else None
            )
            limit = (
                float(r.choice([40, 50, 60]))
                if param == "M-019" and r.random() < 0.4
                else float(r.choice([250, 300, 400]))
                if param == "M-020" and r.random() < 0.4
                else None
            )
            if i % 5 == 4:
                body, cls = _distractor(param, r)
                truth = None
                limit = 60.0 if param == "M-019" else None
            else:
                v = _value(param, r)
                d = _depth(r)
                body, cls = _lines(param, v, r, variant=variant, limit=limit, depth=d)
                truth = d if aspect == "depth" else v
                if aspect == "depth" and not any(
                    ("отметк" in x.lower() or "глубин" in x.lower()) for x in body
                ):
                    truth = None
            out.append(
                {
                    "id": f"dev-{param}-{i}",
                    "param": param,
                    "aspect": aspect,
                    "lines": _frame(r, _noise(body, r) if r.random() < 0.3 else body + (_change_note(param, truth, r) if truth and r.random() < 0.1 else [])),
                    "truth": truth,
                    "variant": variant,
                    "limit": limit,
                    "cls": cls,
                }
            )
    return out


RULE = {  # правило Матрицы: (направление, допуск абс., порог %)
    "M-001": ("both", 0.05, 0),
    "M-004": ("both", 0.05, 0),
    "M-005": ("both", 0.05, 0),
    "M-006": ("both", 0.05, 0),
    "M-008": ("increase", 0.005, 0),
    "M-009": ("both", 0.005, 0),
    "M-013": ("decrease", 0.5, 0),
    "M-019": ("increase", 0.05, 0),
    "M-020": ("increase", 0.05, 0),
    "M-132": ("increase", 0, 5),
}


def _label(param: str, a: float, b: float, limit: float | None) -> str:
    d, tol, pct = RULE[param]
    allow = max(tol, abs(a) * pct / 100)
    diff = b - a
    bad = (
        abs(diff) > allow + 1e-9
        if d == "both"
        else diff > allow + 1e-9
        if d == "increase"
        else -diff > allow + 1e-9
    )
    if limit is not None and max(a, b) > limit + 0.05:
        bad = True
    return "CANDIDATE" if bad else "NEGATIVE_VERIFIED"


def pairs(seed: int, n_per_param: int) -> list[dict]:
    out: list[dict] = []
    for param in PARAMS:
        r = random.Random(f"{seed}:{param}:dev-pairs")
        d_, tol, pct = RULE[param]
        for i in range(n_per_param):
            a = _value(param, r)
            kind = r.choice(
                ["increase", "decrease", "within_tol", "same_other_format", "big"]
            )
            step = max(
                tol * 4,
                abs(a) * pct / 100 * 1.6,
                0.1 if param not in ("M-008", "M-009") else 0.02,
            )
            if param == "M-013":
                step = max(1.0, round(a * 0.05))
            b = {
                "increase": a + step,
                "decrease": a - step,
                "within_tol": a + tol * 0.5 if tol else a * (1 + pct / 300),
                "same_other_format": a,
                "big": a * r.choice([1.3, 0.7]),
            }[kind]
            dec = {"M-008": 2, "M-009": 2, "M-013": 0, "M-020": 0, "M-132": 2}.get(
                param, 1
            )
            b = round(b, dec)
            variant = r.choice(["vat_incl", None]) if param == "M-132" else None
            limit = (
                float(r.choice([45, 60]))
                if param in ("M-019",) and r.random() < 0.3
                else None
            )
            da = _depth(r)
            db = da if r.random() < 0.7 or param != "M-005" else round(da - 0.3, 3)
            pd_body, _ = _lines(param, a, r, variant=variant, limit=limit, depth=da)
            rd_body, cls = _lines(param, b, r, variant=variant, limit=limit, depth=db)
            label = _label(param, a, b, limit)
            if param == "M-005" and da != db:
                label = "CANDIDATE"
                kind = "depth_change"
            out.append(
                {
                    "id": f"dev-pair-{param}-{i}",
                    "param": param,
                    "pd_lines": _frame(r, _noise(pd_body, r) if r.random() < 0.25 else pd_body),
                    "rd_lines": _frame(r, _noise(rd_body, r) if r.random() < 0.25 else rd_body, "РД", "АР"),
                    "pd_truth": {
                        "value": a,
                        "depth": da,
                        "variant": variant,
                        "limit": limit,
                    },
                    "rd_truth": {
                        "value": b,
                        "depth": db,
                        "variant": variant,
                        "limit": limit,
                    },
                    "label": label,
                    "mutation": kind,
                    "cls": cls,
                }
            )
    return out


if __name__ == "__main__":
    from collections import Counter

    s = samples(1, 40)
    p = pairs(1, 40)
    print(len(s), Counter((x["param"], x["cls"]) for x in s).most_common(8))
    print(len(p), Counter(x["label"] for x in p))
