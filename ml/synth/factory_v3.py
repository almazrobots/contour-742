"""Фабрика синтетики v3 (OS-INSP-6.4.3): все 132 параметра Матрицы и пять исходов.

v2 покрывала 13 параметров ручным пулом. v3 выводит генератор значения из самой Матрицы — тип данных, правило
сравнения, шкала, порог, единица — и раскладывает исходы так, чтобы каждый параметр встретился в каждом
достижимом исходе:

- параметры делятся на группы по GROUP штук; на группу — пять объектов:
  0–2 «обычные»: у параметра j исход ("pos", "neg", "missing")[(j + k) % 3] — нарушение, совпадение, нет источника;
  3 «неприменимость»: профиль объекта отключает снос, подземную часть, газ и жильё — параметры с условием
    применимости становятся NOT_APPLICABLE, остальные совпадают;
  4 «конфликт редакций»: у каждого документа вторая утверждённая редакция без связи замены — CLARIFICATION_REQUIRED.
- Метку эталона ставит не генератор, а зеркало домена (eval/decide.py) по истинным значениям — как в v2.
  Поэтому недостижимый исход (параметр с одной стадией-источником не может дать «нарушение» сравнением)
  честно получает ту метку, которую дал бы домен; сводка coverage() показывает, что покрыто.

Отрисовка, растр сканов, эталон страниц и групп — общие с v2 (synth/factory.py).
"""

from __future__ import annotations

import argparse
import json
import random
import time
from collections import Counter
from pathlib import Path

from synth import factory as F
from synth import forms_w3 as W3

GROUP = 22  # параметров на объект: таблица ТЭП на одном листе (≤ 29 строк)
OUTCOMES = ("pos", "neg", "missing")
TAG = "synth-v3"
TEXT_PAIRS = [
    ("предусмотрено", "не предусмотрено"),
    ("исполнение 1", "исполнение 2"),
    ("по типовому решению", "по индивидуальному решению"),
    ("вариант А", "вариант Б"),
    ("тип 1", "тип 3"),
]
# единица → (от, до, знаков после запятой)
RANGES: dict[str, tuple[float, float, int]] = {
    "м²": (100, 20000, 1),
    "м³": (500, 90000, 0),
    "м": (0.5, 60, 2),
    "мм": (50, 1200, 0),
    "мм²": (1.5, 240, 1),
    "%": (1, 95, 1),
    "‰": (1, 30, 0),
    "шт.": (1, 400, 0),
    "чел.": (5, 900, 0),
    "дни": (5, 700, 0),
    "мин": (15, 180, 0),
    "кВт": (5, 3000, 0),
    "тыс. руб.": (100, 900000, 1),
}
DEFAULT_RANGE = (10, 900, 0)


def _num_fmt(v: float, dec: int) -> str:
    if dec == 0:
        return f"{int(round(v)):,}".replace(",", " ")
    return f"{v:,.{dec}f}".replace(",", " ").replace(".", ",")


def _step(v: float, dec: int) -> float:
    return max(10 ** (-dec), round(abs(v) * 0.15, dec))


def number_entry(p: dict) -> dict:
    lo, hi, dec = RANGES.get(p["unit"], DEFAULT_RANGE)
    rule = p["compare"]
    kind = rule["kind"]

    def rnd(x: float) -> float:
        return round(x, dec) if dec else float(round(x))

    if kind == "min":
        m = rule["min"]
        dec = max(dec, 2 if m < 10 else 0)
        base = lambda r: rnd(m * r.uniform(1.15, 1.6))  # noqa: E731
        bad = lambda v, r: rnd(m * r.uniform(0.6, 0.9))  # noqa: E731
        ok = lambda v, r: v  # noqa: E731
    else:
        base = lambda r: rnd(r.uniform(lo, hi))  # noqa: E731
        if kind == "decrease":
            bad = lambda v, r: rnd(v - _step(v, dec))  # noqa: E731
        elif kind == "increase":
            bad = lambda v, r: rnd(v + _step(v, dec))  # noqa: E731
        elif kind == "delta_pct":
            tol = rule["tolerance"]
            bad = lambda v, r: rnd(
                v * (1 + r.choice([-1, 1]) * r.uniform(tol + 2, tol + 6) / 100)
            )  # noqa: E731
        else:  # equal
            bad = lambda v, r: rnd(v + r.choice([-1, 1]) * _step(v, dec))  # noqa: E731
        ok = (
            (
                lambda v, r: rnd(
                    v
                    * (1 + r.uniform(-rule["tolerance"], rule["tolerance"]) * 0.4 / 100)
                )
            )
            if kind == "delta_pct" and rule["tolerance"] > 0
            else (lambda v, r: v)
        )
    return {
        "base": base,
        "worse": bad,
        "same": ok,
        "fmt": lambda v: _num_fmt(v, dec),
        "unit": p["unit"],
    }


def text_entry(p: dict) -> dict:
    """Строка с правилом «равно» или перечисление без шкалы: пара заведомо разных формулировок."""
    return {
        "base": lambda r: r.randrange(len(TEXT_PAIRS)),
        "worse": lambda v, r: (
            -1 - v
        ),  # отрицательный индекс — вторая формулировка той же пары
        "same": lambda v, r: v,
        "fmt": lambda v: TEXT_PAIRS[v][0] if v >= 0 else TEXT_PAIRS[-1 - v][1],
        "unit": "",
    }


def string_numeric_entry(p: dict) -> dict:
    """OS-INSP-2.2.9: строка с числовым правилом — «<главное число> <пояснение>»."""
    e = number_entry({**p, "unit": ""})
    fmt = e["fmt"]
    return {**e, "fmt": lambda v: f"{fmt(v)} по проекту", "unit": ""}


def scale_entry(p: dict) -> dict:
    scale = p["value_scale"]
    kind = p["compare"]["kind"]
    return {
        "base": lambda r: r.randrange(1, len(scale) - 1),
        "worse": (lambda v, r: v - 1)
        if kind == "decrease"
        else (lambda v, r: v + 1 if v + 1 < len(scale) else v - 1),
        "same": lambda v, r: v,
        "fmt": lambda v: scale[v],
        "unit": "",
    }


def entry(p: dict) -> dict:
    if p["code"] in F.POOL:  # ручные генераторы v2 — без изменений
        return F.POOL[p["code"]]
    if (w3 := W3.form(p)) is not None:  # паспортные формы W3 (T-210): как в реальных документах
        return w3
    if isinstance(p.get("value_scale"), list):
        e = scale_entry(p)
    elif p["data_type"] == "number" and not p.get("regex_pattern"):
        e = number_entry(p)
    elif p["data_type"] == "string" and p["compare"]["kind"] in (
        "decrease",
        "increase",
        "delta_pct",
        "min",
    ):
        e = string_numeric_entry(p)
    else:
        e = text_entry(p)
    # подпись — самый короткий якорь: длинная не помещается до колонки единиц (130 мм)
    return {
        **e,
        "label": min(p["anchors"], key=len),
        "grp": "V3",
        "needs": p.get("applicability"),
    }


def install() -> None:
    """Дополнить пул v2 генераторами для всех 132 параметров."""
    for code, p in F.MATRIX.items():
        F.POOL.setdefault(code, entry(p))


def stages_of(p: dict) -> list[str]:
    from eval.decide import stage_required

    return [s for s in ("PD", "RD", "ID") if stage_required(p, s)]


def groups() -> list[list[str]]:
    codes = sorted(F.MATRIX)
    return [codes[i : i + GROUP] for i in range(0, len(codes), GROUP)]


def make_object(seed: int, i: int):
    """Объект i (с 1): группа (i-1)//5, тип объекта (i-1)%5."""
    install()
    gs = groups()
    g, k = divmod(i - 1, 5)
    codes = gs[g % len(gs)]
    r = random.Random(f"{TAG}:{seed}:{i}")
    oid = f"V3-{seed}-{i:03d}"
    pfx = "".join(r.choice(F.PREFIX) for _ in range(2)) + str(r.randint(1, 99))
    na = k == 3
    conflict = k == 4
    profile = {
        "residential": not na,
        "underground": not na,
        "gas": not na,
        "demolition": not na,
    }
    scen: dict[str, str] = {}
    base = {c: F.POOL[c]["base"](r) for c in codes}
    rows: dict[str, list] = {"PD": [], "RD": [], "ID": []}
    for j, c in enumerate(codes):
        p = F.MATRIX[c]
        st = stages_of(p)
        if na and p.get("applicability"):
            scen[c] = "na"
        elif conflict:
            scen[c] = "conflict"
        elif na:
            scen[c] = "neg"
        else:
            scen[c] = OUTCOMES[(j + k) % 3]
        if not st:
            continue
        o = scen[c]
        if o == "missing":
            use = [] if p["compare"]["kind"] in ("min", "max") else st[:1]
        else:
            use = st
        for n, s in enumerate(use):
            v = base[c]
            if o == "pos" and n == len(use) - 1:
                v = F.worse(c, base[c], r)
            elif n > 0 or p["compare"]["kind"] in ("min", "max"):
                v = F.same(c, base[c], r)
            rows[s].append((c, v))
    titles = {
        "PD": ("ПЗ", "П-ПЗ", "Пояснительная записка. ТЭП"),
        "RD": ("АР", "Р-ОД", "Рабочая документация. Общие данные"),
        "ID": ("ИД", "ИД-СВ", "Исполнительная документация. Сводные показатели"),
    }
    docs = []
    for s, lst in rows.items():
        if not lst:
            continue
        disc, code, title = titles[s]
        # сканы — в первом объекте группы (ИД) и во втором (РД): OCR-нагрузка стенда как у v2
        scan = (k == 0 and s == "ID") or (k == 1 and s == "RD")
        kind = (
            {
                "kind": "scan",
                "dpi": r.choice([200, 240, 300]),
                "skew": round(r.uniform(-1.2, 1.2), 2),
                "blur": round(r.uniform(0, 0.7), 2),
                "noise": r.randint(1500, 5000),
            }
            if scan
            else {}
        )
        status = {"PD": "APPROVED", "RD": "FOR_CONSTRUCTION", "ID": "APPROVED"}[s]
        docs.append(
            F.Doc(
                f"{oid}-{s}",
                s,
                disc,
                f"{pfx}-{code}",
                "1",
                status,
                F._date(r, 2025, 1),
                title,
                lst,
                **kind,
            )
        )
        if conflict:  # вторая утверждённая редакция без связи замены (OS-INSP-1.3)
            docs.append(
                F.Doc(
                    f"{oid}-{s}-2",
                    s,
                    disc,
                    f"{pfx}-{code}",
                    "2",
                    status,
                    F._date(r, 2025, 6),
                    title,
                    lst,
                )
            )
    obj = {
        "object_id": oid,
        "name": f"Вымышленный объект {pfx}",
        "profile": profile,
        "scenarios": scen,
        "conflict_kr": conflict,
    }
    return obj, docs, base


def build(seed: int, out: Path, n: int | None = None) -> list[dict]:
    install()
    total = len(groups()) * 5
    n = total if n is None else min(n, total)
    out.mkdir(parents=True, exist_ok=True)
    golds = [
        F.build_object(seed, i, out, make=make_object, tag=TAG) for i in range(1, n + 1)
    ]
    (out / "dataset.json").write_text(
        json.dumps(
            {
                "schema": F.SCHEMA,
                "dataset_version": f"{TAG}:seed={seed}",
                "n_objects": n,
                "objects": [g["object_id"] for g in golds],
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    return golds


def coverage(golds: list[dict]) -> dict[str, dict[str, int]]:
    """Параметр → сколько групп эталона с каждой меткой. Показывает, какие исходы достижимы."""
    cov: dict[str, Counter] = {c: Counter() for c in F.MATRIX}
    for g in golds:
        for eg in g["evidence_groups"]:
            cov[eg["param"]][eg["label"]] += 1
    return {c: dict(v) for c, v in cov.items()}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        description="Фабрика синтетики v3: 132 параметра × 5 исходов (OS-INSP-6.4.3)"
    )
    ap.add_argument(
        "--n",
        type=int,
        default=None,
        help="число объектов (по умолчанию — все: группы × 5)",
    )
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=F.ROOT / "var/synth-v3")
    a = ap.parse_args(argv)
    t = time.perf_counter()
    golds = build(a.seed, a.out, a.n)
    cov = coverage(golds)
    covered = sum(1 for v in cov.values() if v)
    labels = Counter(
        lbl for v in cov.values() for lbl, n in v.items() for _ in range(n)
    )
    (a.out / "coverage.json").write_text(
        json.dumps(cov, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(
        f"{len(golds)} объектов → {a.out} за {time.perf_counter() - t:.1f} с; параметров с группами {covered}/132; метки {dict(labels)}"
    )


if __name__ == "__main__":
    main()
