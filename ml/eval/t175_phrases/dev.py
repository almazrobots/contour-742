"""DEV-набор фраз T-175 (М-007 этажность, М-010 количество квартир, М-011 квартирография): на нём настраиваются
паспорта. Итоговое качество — НЕ здесь, а на отложенном `holdout.py`, написанном отдельным подагентом без знания
паспортов и экстракторов (урок T-172: подогнанный набор даёт 1,00, отложенный — Recall 0,30).

Только вымышленные объекты и числа (ADR-0002). API совпадает с holdout.py: samples(seed, n).
"""

from __future__ import annotations

import random

PARAMS = ["M-007", "M-010", "M-011"]
STAMP = ["Изм. Кол.уч. Лист №док. Подп. Дата", "ГИП Иванов", "Лист 3"]
NOISE = [
    "Площадь застройки — 1 250,4 м2",
    "Строительный объём — 48 300 м3",
    "Общая площадь квартир — 12 480,5 м2",
]


def _page(rnd: random.Random, body: list[str]) -> list[str]:
    lines = [
        "Технико-экономические показатели объекта",
        *rnd.sample(NOISE, 2),
        *body,
        *STAMP,
    ]
    return lines


def _m007(rnd: random.Random) -> dict:
    v = rnd.randint(5, 40)
    kind = rnd.random()
    if kind < 0.55:
        line = rnd.choice(
            [
                f"Этажность — {v} эт.",
                f"Количество надземных этажей: {v}",
                f"Количество этажей {v} этажей",
                f"3 Этажность здания эт. {v}",
            ]
        )
        return {
            "code": "M-007",
            "lines": _page(rnd, [line]),
            "value": v,
            "composition": None,
            "trap": "",
        }
    if kind < 0.8:
        line = rnd.choice(
            [
                f"Этажность с учетом подвала — {v + 1}",
                f"Количество подземных этажей — {rnd.randint(1, 3)}",
            ]
        )
        return {
            "code": "M-007",
            "lines": _page(rnd, [line]),
            "value": None,
            "composition": None,
            "trap": "underground_floors",
        }
    return {
        "code": "M-007",
        "lines": _page(rnd, [f"Этажность не более {v} этажей по ГПЗУ"]),
        "value": None,
        "composition": None,
        "trap": "norm_limit",
    }


def _m010(rnd: random.Random) -> dict:
    v = rnd.randint(20, 600)
    kind = rnd.random()
    if kind < 0.6:
        line = rnd.choice(
            [
                f"Количество квартир — {v} шт.",
                f"Общее количество квартир: {v}",
                f"Всего квартир {v}",
            ]
        )
        return {
            "code": "M-010",
            "lines": _page(rnd, [line]),
            "value": v,
            "composition": None,
            "trap": "",
        }
    k = rnd.randint(5, 80)
    line = rnd.choice(
        [
            f"Количество квартир однокомнатных — {k}",
            f"Количество квартир 2-комнатных — {k}",
            f"Количество квартир-студий — {k}",
        ]
    )
    return {
        "code": "M-010",
        "lines": _page(rnd, [line]),
        "value": None,
        "composition": None,
        "trap": "by_room_type",
    }


def _m011(rnd: random.Random) -> dict:
    comp = {
        "1к": rnd.randint(10, 90),
        "2к": rnd.randint(10, 90),
        "3к": rnd.randint(5, 40),
    }
    kind = rnd.random()
    if kind < 0.4:
        body = [
            f"Однокомнатные квартиры — {comp['1к']} шт.",
            f"Двухкомнатные квартиры — {comp['2к']} шт.",
            f"Трехкомнатные квартиры — {comp['3к']} шт.",
        ]
    elif kind < 0.7:
        body = [
            f"1-комнатные {comp['1к']} 2-комнатные {comp['2к']} 3-комнатные {comp['3к']}"
        ]
    elif kind < 0.85:
        body = [
            f"{comp['1к']} однокомнатных, {comp['2к']} двухкомнатных и {comp['3к']} трехкомнатных квартир"
        ]
    else:
        return {
            "code": "M-011",
            "lines": _page(
                rnd,
                [
                    "Площадь однокомнатной квартиры — 38,5 м2",
                    "Площадь двухкомнатной квартиры — 56,2 м2",
                ],
            ),
            "value": None,
            "composition": None,
            "trap": "area_not_count",
        }
    return {
        "code": "M-011",
        "lines": _page(rnd, body),
        "value": None,
        "composition": comp,
        "trap": "",
    }


def samples(seed: int, n: int) -> list[dict]:
    rnd = random.Random(seed)
    return [f(rnd) for f in (_m007, _m010, _m011) for _ in range(n)]
