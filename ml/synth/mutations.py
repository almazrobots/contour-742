"""Генератор синтетических мутаций L11 (T-179, каталог TO-BE §15.1–15.2, OS-INSP-6.5.40–6.5.43).

Пара «ПД → РД» векторных PDF одного вымышленного объекта, в РД внесена одна мутация, истина известна заранее:
тип мутации, параметр и оператор, ожидаемый статус, страница и рамка значения. Детерминированно по seed.
ADR-0002: только синтетика, корпус не читается.

Какие параметры и мутации — данные (`eval/mutations/w1.json`): новый параметр известного вида — строка JSON,
а не код. Вид параметра (kind) — это как он пишется в документе: quantity (строка ТЭП «подпись — ед. — число»),
class (фраза «… — С0.»), mark (марка кабеля), layers (состав стены), room_purpose/rooms_total (экспликация),
branches (подписи ветвей схемы). Новый вид — функция отрисовки здесь и мутация в `_mutate`.

Истина — по правилу Матрицы из файла мутаций (abs, pct, decrease, rank_decrease), а не по паспорту системы.

    uv run python -m synth.mutations --seed 1 --limit 10 --out var/mutations/s1   # из каталога ml/
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

ML = Path(__file__).resolve().parents[1]
if str(ML) not in sys.path:  # запуск файлом
    sys.path.insert(0, str(ML))

from synth.factory import (
    PAGE_H,
    PAGE_W,
    Doc as FDoc,
    LineOp,
    PageSpec,
    TextOp,
    _stamp,
    ink_box,
    norm,
    render_pdf,
)  # noqa: E402

REGISTRY = ML / "eval/mutations/w1.json"
SCHEMA = "inspector-mutations/1"
STATUS = {"PD": "APPROVED", "RD": "FOR_CONSTRUCTION"}
ROOM_NAMES = [
    "Вестибюль",
    "Кабинет",
    "Коридор",
    "Санузел",
    "Кладовая",
    "Помещение охраны",
    "Комната персонала",
    "Электрощитовая",
]
PURPOSE_SWAP = {
    "Кабинет": "Техническое помещение",
    "Комната персонала": "Венткамера",
    "Вестибюль": "Склад",
    "Помещение охраны": "Серверная",
}
ABSTAIN = ("MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED")


def load_registry(path: Path = REGISTRY) -> dict:
    reg = json.loads(path.read_text("utf-8"))
    if reg.get("schema") != "inspector-mutation-params/1":
        raise ValueError(
            f"{path}: схема {reg.get('schema')!r}, ждём inspector-mutation-params/1"
        )
    keys = [(p["code"], p["operator"]) for p in reg["params"]]
    if len(keys) != len(set(keys)):
        raise ValueError(f"{path}: пара «параметр × оператор» повторяется")
    for p in reg["params"]:
        if p["kind"] not in KINDS:
            raise ValueError(
                f"{p['code']} × {p['operator']}: вид {p['kind']!r} не известен генератору ({', '.join(sorted(KINDS))})"
            )
    return reg


# ─────────────────────────────────────────────── форматы чисел и классов


def fmt_num(v: float, style: str = "space") -> str:
    """Число ТЭП с одним знаком: «3 009,4» (space), «3009,4» (tight), «3009.4» (dot), «3 009,40» (zeros)."""
    s = f"{v:.1f}"
    whole, frac = s.split(".")
    if style == "dot":
        return f"{whole}.{frac}"
    if style == "tight":
        return f"{whole},{frac}"
    grouped = f"{int(whole):,}".replace(",", "\u00a0" if style == "nbsp" else " ")
    return f"{grouped},{frac}0" if style == "zeros" else f"{grouped},{frac}"


def fmt_count(n: int, style: str = "plain") -> str:
    """Целое ТЭП: «16», «16 шт.», «16 ед.» — только цифры (прописью в ТЭП не пишут)."""
    return {"plain": str(n), "sht": f"{n} шт.", "ed": f"{n} ед."}[style]


def fmt_class(v: str, style: str = "plain") -> str:
    """Класс «С0»; latin — латинская C (NRM-03), space — «С 0» (NRM-04)."""
    if style == "latin":
        return "C" + v[1:]
    if style == "space":
        return v[0] + " " + v[1:]
    return v


# ─────────────────────────────────────────────── модель объекта и документа


@dataclass
class Values:
    """Значения объекта в одном документе: то, что рисуется, и как (формат)."""

    q: dict[str, float]
    qfmt: dict[str, str]
    cls: dict[str, str]
    cfmt: dict[str, str]
    rooms: list[list]  # [номер, наименование, площадь]
    mark: str
    layers: list[list]  # [наименование, мм]
    branches: list[str]
    detail: bool = (
        False  # NEG-03: РД детализирует (подстроки ТЭП, уточнения), значения те же
    )
    cloud: str | None = (
        None  # MUT-17: код параметра, у значения которого облако изменения
    )
    n: dict[str, int] = field(default_factory=dict)  # вид count: целые (этажность, квартиры, окна)
    nfmt: dict[str, str] = field(default_factory=dict)  # plain «16», sht «16 шт.», ed «16 ед.»
    breakdown: dict[str, list[list]] = field(default_factory=dict)  # разбивка итога count: [[подпись, число]]
    row_order: list[str] | None = None  # порядок строк ТЭП (коды) — перестановка строк, NEG для count
    adv: dict | None = None  # профиль adversarial: формулировка, раскладка и шум этого документа (pick_style)


@dataclass
class DocPlan:
    file_id: str
    stage: str
    discipline: str
    code: str
    revision: str
    status: str | None
    date: str
    predecessor: str | None
    values: Values
    file_name: str = ""
    marks: dict = field(
        default_factory=dict
    )  # код параметра → [{page, bbox, raw}] (заполняется отрисовкой)


def _q_params(reg: dict) -> list[dict]:
    return [p for p in reg["params"] if p["kind"] == "quantity"]


def _n_params(reg: dict) -> list[dict]:
    return [p for p in reg["params"] if p["kind"] == "count"]


def base_values(reg: dict, rng: random.Random, crng: random.Random | None = None) -> Values:
    """Значения объекта. Целые (count) — из своего генератора crng: добавление целых в реестр не сдвигает значения
    прочих параметров того же seed."""
    q = {}
    for p in _q_params(
        reg
    ):  # доля другого показателя (полезная < общей) — после него: порядок строк реестра
        if "range_of" in p:
            of, lo, hi = p["range_of"]
            q[p["code"]] = round(q[of] * rng.uniform(lo, hi), 1)
        else:
            lo, hi = p["range"]
            q[p["code"]] = round(rng.uniform(lo, hi), 1)
    cls = {
        p["code"]: rng.choice(p["scale"][1:])
        for p in reg["params"]
        if p["kind"] == "class"
    }  # не худший: есть куда понижать
    names = rng.sample(ROOM_NAMES, 5)
    rooms = [
        [f"1.{i + 1:02d}", n, round(rng.uniform(6, 60), 1)] for i, n in enumerate(names)
    ]
    mark = next(
        (p["value"] for p in reg["params"] if p["kind"] == "mark"), "ВВГнг(А)-FRLS"
    )
    layers = next(
        (copy.deepcopy(p["layers"]) for p in reg["params"] if p["kind"] == "layers"), []
    )
    branches = [f"В2.{i}" for i in range(1, 11)]
    crng = crng or random.Random(0)
    n, breakdown = {}, {}
    for p in _n_params(reg):
        lo, hi = p["range"]
        n[p["code"]] = crng.randint(lo, hi)
        if p.get("breakdown"):  # разбивка итога по строкам (квартирография): сумма строк = итог
            k = len(p["breakdown"])
            cuts = sorted(crng.sample(range(1, n[p["code"]]), k - 1)) if n[p["code"]] > k else list(range(1, k))
            parts = [b - a for a, b in zip([0, *cuts], [*cuts, n[p["code"]]])]
            breakdown[p["code"]] = [[lab, x] for lab, x in zip(p["breakdown"], parts)]
    return Values(
        q,
        {c: "space" for c in q},
        cls,
        {c: "plain" for c in cls},
        rooms,
        mark,
        layers,
        branches,
        n=n,
        nfmt={c: "plain" for c in n},
        breakdown=breakdown,
    )


# ─────────────────────────────────────────────── отрисовка листов


def _mark_value(
    d: DocPlan, code: str, page: int, op: TextOp, start: int, end: int
) -> None:
    d.marks.setdefault(code, []).append(
        {"page": page, "bbox": norm(ink_box(op, start, end)), "raw": op.text[start:end]}
    )


def _cloud(spec: PageSpec, box: tuple[float, float, float, float], n: str) -> None:
    """Облако изменения — векторные дуги-гребешки вокруг рамки (мм) и треугольник с номером изменения."""
    x0, y0, x1, y1 = box[0] - 3, box[1] - 2.5, box[2] + 3, box[3] + 2.5
    r = 1.6
    for ax, ay, bx, by in (
        (x0, y0, x1, y0),
        (x1, y0, x1, y1),
        (x1, y1, x0, y1),
        (x0, y1, x0, y0),
    ):
        k = max(2, int(math.hypot(bx - ax, by - ay) / (2 * r)))
        for i in range(k):
            sx, sy = ax + (bx - ax) * i / k, ay + (by - ay) * i / k
            ex, ey = ax + (bx - ax) * (i + 1) / k, ay + (by - ay) * (i + 1) / k
            mx, my = (sx + ex) / 2, (sy + ey) / 2
            nx, ny = -(ey - sy), (ex - sx)
            ln = math.hypot(nx, ny) or 1
            px, py = mx - nx / ln * r, my - ny / ln * r  # гребешок наружу
            spec.ops += [LineOp(sx, sy, px, py, 0.35), LineOp(px, py, ex, ey, 0.35)]
    tx, ty = x1 + 3, y0
    spec.ops += [
        LineOp(tx, ty + 5, tx + 3, ty, 0.35),
        LineOp(tx + 3, ty, tx + 6, ty + 5, 0.35),
        LineOp(tx + 6, ty + 5, tx, ty + 5, 0.35),
    ]
    spec.ops.append(TextOp(tx + 2.1, ty + 4.3, n, 6))


def _page_general(d: DocPlan, reg: dict, spec: PageSpec) -> None:
    """Лист 1: общие указания и пожарно-технические характеристики, марка кабеля, состав стены."""
    v = d.values
    spec.ops.append(
        TextOp(
            20, 25, "Пояснительная записка" if d.stage == "PD" else "Общие данные", 14
        )
    )
    spec.ops.append(
        TextOp(
            20,
            38,
            "Документация разработана в соответствии с заданием на проектирование.",
            10,
        )
    )
    spec.ops.append(
        TextOp(20, 44, "Все размеры указаны в миллиметрах, если не оговорено иное.", 10)
    )
    spec.ops.append(TextOp(20, 58, "Пожарно-технические характеристики", 12))
    y = 66.0
    for p in reg["params"]:
        if p["kind"] != "class":
            continue
        if v.adv:
            y = _adv_class(d, p, spec, y)
            continue
        raw = fmt_class(v.cls[p["code"]], v.cfmt[p["code"]])
        op = TextOp(20, y, f"{p['label']} — {raw}.", 10)
        spec.ops.append(op)
        s = op.text.index(" — ") + 3
        _mark_value(d, p["code"], 1, op, s, s + len(raw))
        if v.cloud == p["code"]:
            _cloud(spec, ink_box(op, s, s + len(raw)), "1")
        y += 6
    if v.adv and v.adv.get("distractor"):  # дистрактор: класс соседнего здания или норма — не значение объекта
        spec.ops.append(TextOp(20, y, v.adv["distractor"], 9))
        y += 6
    spec.ops.append(TextOp(20, y, "Степень огнестойкости здания — II.", 10))
    y += 6
    if v.detail:  # NEG-03: детализация — уточнения, не меняющие значений параметров
        for t in (
            "Класс пожарной опасности строительных конструкций — К0.",
            "Предел огнестойкости несущих стен — R 90.",
        ):
            spec.ops.append(TextOp(20, y, t, 10))
            y += 6
    mk = next((p for p in reg["params"] if p["kind"] == "mark"), None)
    if mk:
        op = TextOp(20, y, f"{mk['label']} {v.mark}.", 10)
        spec.ops.append(op)
        s = len(mk["label"]) + 1
        _mark_value(d, mk["code"], 1, op, s, s + len(v.mark))
        y += 6
    ly = next((p for p in reg["params"] if p["kind"] == "layers"), None)
    if ly:
        spec.ops.append(TextOp(20, y, f"{ly['label']}:", 10))
        y += 6
        for name, mm_ in v.layers:
            op = TextOp(26, y, f"— {name}, {mm_} мм;", 10)
            spec.ops.append(op)
            s = op.text.index(", ") + 2
            _mark_value(d, ly["code"], 1, op, s, s + len(str(mm_)))
            y += 6
    if v.cloud:
        spec.ops.append(
            TextOp(
                20,
                215,
                "Изм. 1 — Зам. — лист 2 — изменение согласовано с заказчиком, письмо № 45 от 12.03.2026.",
                8,
            )
        )


def _page_tep(d: DocPlan, reg: dict, spec: PageSpec) -> None:
    """Лист 2: ТЭП «подпись — ед. — значение», экспликация помещений, фрагмент схемы В2 с выносками."""
    v = d.values
    spec.ops.append(TextOp(20, 30, "Технико-экономические показатели", 12))
    y = 40.0
    rows = [(p["code"], p["label"], p["unit"]) for p in _q_params(reg) + _n_params(reg)]
    if v.row_order:  # перестановка строк ТЭП: значения те же, порядок другой
        rows = sorted(rows, key=lambda r: v.row_order.index(r[0]))
    if v.detail:  # NEG-03: подстроки ТЭП без якорей параметров
        rows.insert(2, (None, "Площадь квартир", "м²"))
        rows.append((None, "Количество этажей", "эт."))
    for code, label, unit in rows:
        if v.adv and code in v.adv["q"]:
            y = _adv_q_row(d, next(x for x in _q_params(reg) if x["code"] == code), spec, y)
            continue
        raw = (
            fmt_count(v.n[code], v.nfmt[code])
            if code in v.n
            else fmt_num(v.q[code], v.qfmt[code])
            if code
            else (
                "16"
                if unit == "эт."
                else fmt_num(v.q["M-002"] * 0.71 if "M-002" in v.q else 100.0)
            )
        )
        lab = TextOp(20, y, label, 10)
        val = TextOp(190, y, raw, 10, "r")
        spec.ops += [
            lab,
            TextOp(130, y, unit, 10),
            val,
            LineOp(20, y + 2.2, 192, y + 2.2, 0.3),
        ]
        if code:
            _mark_value(d, code, 2, val, 0, len(raw))
            if v.cloud == code:
                _cloud(spec, ink_box(val), "1")
        y += 7.5
    for p in _n_params(reg):  # разбивка итога count (квартирография): строки и «Итого»
        if p["code"] not in v.breakdown:
            continue
        y += 4
        spec.ops.append(TextOp(20, y, p["breakdown_title"], 11))
        y += 7
        for lab, x in v.breakdown[p["code"]]:
            op = TextOp(190, y, str(x), 10, "r")
            spec.ops += [TextOp(26, y, lab, 10), op]
            d.marks.setdefault(f"{p['code']}:rows", []).append({"page": 2, "bbox": norm(ink_box(op)), "raw": f"{lab} {x}"})
            y += 6
        tot = TextOp(190, y, str(sum(x for _, x in v.breakdown[p["code"]])), 10, "r")
        spec.ops += [TextOp(26, y, "Итого", 10), tot]
        d.marks.setdefault(f"{p['code']}:rows", []).append({"page": 2, "bbox": norm(ink_box(tot)), "raw": f"Итого {tot.text}"})
        y += 6
    y += 6
    spec.ops.append(TextOp(20, y, "Экспликация помещений (этаж 1)", 12))
    y += 9
    for num, name, area in v.rooms:
        op = TextOp(20, y, f"{num}", 10)
        nm = TextOp(40, y, name, 10)
        ar = TextOp(190, y, fmt_num(area, "tight"), 10, "r")
        spec.ops += [op, nm, ar, LineOp(20, y + 2.2, 192, y + 2.2, 0.3)]
        d.marks.setdefault("rooms", []).append(
            {"page": 2, "bbox": norm(ink_box(nm)), "raw": f"{num} {name}"}
        )
        y += 7
    tot = round(sum(r[2] for r in v.rooms), 1)
    top = TextOp(190, y, fmt_num(tot, "tight"), 10, "r")
    spec.ops += [TextOp(40, y, "Итого по экспликации, м²", 10), top]
    d.marks.setdefault("rooms_total", []).append(
        {"page": 2, "bbox": norm(ink_box(top)), "raw": top.text}
    )
    y += 14
    spec.ops.append(TextOp(20, y, "Схема системы В2 (фрагмент)", 12))
    y += 8
    spec.ops.append(LineOp(25, y + 10, 185, y + 10, 0.5))  # магистраль
    for i, b in enumerate(v.branches):
        x = 30 + i * 15.5
        spec.ops.append(LineOp(x, y + 10, x + 3, y + 3, 0.25))  # выноска
        op = TextOp(x + 3.5, y + 2.5, b, 7)
        spec.ops.append(op)
        d.marks.setdefault("branches", []).append(
            {"page": 2, "bbox": norm(ink_box(op)), "raw": b}
        )


# ─────────────────────────────────────────────── профиль adversarial (отложенный набор формулировок)

ADVERSARIAL = ML / "eval/mutations/adversarial-w1.json"
HOMOGLYPH = {"о": "o", "а": "a", "е": "e", "р": "p", "с": "c"}


def load_adversarial(path: Path = ADVERSARIAL) -> dict:
    """Отложенный набор формулировок. Внешние шаблонизаторы веток («модуль:функция») подключаются, если модуль влит;
    не влитый — пропуск с причиной в external_status, а не падение прогона."""
    import importlib

    adv = json.loads(path.read_text("utf-8"))
    if adv.get("schema") != "inspector-mutation-adversarial/1":
        raise ValueError(f"{path}: схема {adv.get('schema')!r}, ждём inspector-mutation-adversarial/1")
    adv["external_fns"], adv["external_status"] = [], {}
    for ref in adv.get("external", {}).get("phrasers", []):
        mod, _, fn = ref.partition(":")
        try:
            adv["external_fns"].append(getattr(importlib.import_module(mod), fn))
            adv["external_status"][ref] = "подключён"
        except (ImportError, AttributeError) as e:
            adv["external_status"][ref] = f"не подключён: {e}"
    return adv


def pick_style(adv: dict, reg: dict, rng: random.Random) -> dict:
    """Формулировка документа: у ПД и РД одного примера — своя (разные авторы разделов)."""
    rates = adv["rates"]
    qa = adv["quantity"]
    st: dict = {"q": {}, "cls": {}, "distractor": None}
    for p in _q_params(reg):
        st["q"][p["code"]] = {
            "label": rng.choice(qa["labels"].get(p["code"], [p["label"]])),
            "unit": rng.choice(qa["units"].get(p["unit"], [p["unit"]])),
            "layout": rng.choice(qa["layouts"]),
            "fmt": rng.choice(qa["number_formats"]),
            "ocr2": rng.choice(adv["ocr2"]) if rng.random() < rates["ocr2"] else None,
        }
    for p in reg["params"]:
        if p["kind"] != "class":
            continue
        phrases = list(adv["class"]["phrases"].get(p["code"], [p["label"] + " — {V}."]))
        for fn in adv.get("external_fns", []):
            extra = fn(p["code"], rng)
            if extra:
                phrases.append(extra)
        st["cls"][p["code"]] = {
            "phrase": rng.choice(phrases),
            "noise": rng.choice(sorted(adv["class"]["value_noise"])) if rng.random() < rates["value_noise"] else None,
            "ocr2": rng.choice(adv["ocr2"]) if rng.random() < rates["ocr2"] else None,
        }
        if rng.random() < rates["distractor"]:
            st["distractor"] = rng.choice(adv["class"]["distractors"]).replace("{D}", rng.choice(p["scale"]))
    return st


def _ocr2(text: str, how: str | None, rng_key: str) -> str:
    """Шум второго распознавателя: слитные слова, гомоглиф в подписи. Число не трогается (его искажение — value_noise)."""
    if how == "glue_words" and " " in text:
        i = text.index(" ")
        return text[:i] + text[i + 1 :]
    if how == "homoglyph_label":
        for j, ch in enumerate(text):
            if ch in HOMOGLYPH:
                return text[:j] + HOMOGLYPH[ch] + text[j + 1 :]
    return text


def _class_value(v: str, noise: str | None, adv: dict) -> str:
    """Значение класса с шумом распознавания: латинская C, пробел, О вместо 0, l вместо 1 — истина остаётся v."""
    n = v[1:]
    tpl = adv["class"]["value_noise"].get(noise or "", "С{N}")
    if noise == "o_for_zero" and n != "0" or noise == "l_for_one" and n != "1":
        tpl = "С{N}"
    return tpl.replace("{N}", n).replace("{O}", "О").replace("{L}", "l")


def _adv_class(d: DocPlan, p: dict, spec: PageSpec, y: float) -> float:
    st = d.values.adv["cls"][p["code"]]
    raw = _class_value(d.values.cls[p["code"]], st["noise"], d.values.adv["_src"])
    head, tail = st["phrase"].split("{V}")
    head = _ocr2(head, st["ocr2"], p["code"])
    if "|" in head:  # ячейка таблицы «наименование | значение»
        spec.ops.append(TextOp(20, y, head.split("|")[0].strip(), 10))
        op, s0 = TextOp(130, y, raw + tail, 10), 0
    else:
        lines = head.split("\n")
        for ln in lines[:-1]:
            spec.ops.append(TextOp(20, y, ln, 10))
            y += 5
        op, s0 = TextOp(20, y, lines[-1] + raw + tail, 10), len(lines[-1])
    _mark_value(d, p["code"], 1, op, s0, s0 + len(raw))
    spec.ops.append(op)
    if d.values.cloud == p["code"]:
        _cloud(spec, ink_box(op, s0, s0 + len(raw)), "1")
    return y + 6


def _adv_q_row(d: DocPlan, p: dict, spec: PageSpec, y: float) -> float:
    """Строка ТЭП в отложенной раскладке: строка таблицы, единица в подписи, значение строкой ниже, фраза, перенос подписи."""
    v, code = d.values, p["code"]
    st = v.adv["q"][code]
    label, unit = _ocr2(st["label"], st["ocr2"], code), st["unit"]
    raw = fmt_num(v.q[code], st["fmt"])
    glue = st["ocr2"] == "no_space_before_number"
    lay = st["layout"]
    if lay == "inline":
        sep = "" if glue else " "
        pre = f"{label} составляет{sep}"
        op = TextOp(20, y, f"{pre}{raw} {unit}.", 9)
        spec.ops.append(op)
        _mark_value(d, code, 2, op, len(pre), len(pre) + len(raw))
        return y + 7.5
    if lay == "wrap_label" and " " in label:
        words = label.split(" ")
        k = max(1, len(words) // 2)
        spec.ops.append(TextOp(20, y, " ".join(words[:k]), 10))
        y += 4.6
        label = " ".join(words[k:])
    head = f"{label}, {unit}" if lay in ("unit_in_label", "value_next_line") else label
    spec.ops.append(TextOp(20, y, head, 10))
    if lay == "row" or lay == "wrap_label":
        spec.ops.append(TextOp(130, y, unit, 10))
    if lay == "value_next_line":
        y += 5.2
    cell = raw + (unit if glue else "")
    val = TextOp(190, y, cell, 10, "r")
    spec.ops += [val, LineOp(20, y + 2.2, 192, y + 2.2, 0.3)]
    _mark_value(d, code, 2, val, 0, len(raw))
    if v.cloud == code:
        _cloud(spec, ink_box(val, 0, len(raw)), "1")
    return y + 7.5


def style_summary(adv: dict | None) -> dict | None:
    """Формулировка документа для отчёта (разбор расхождений по формулировкам), без служебных полей."""
    if not adv:
        return None
    return {"q": adv["q"], "cls": adv["cls"], "distractor": bool(adv.get("distractor"))}


def render(d: DocPlan, reg: dict, path: Path) -> None:
    fd = FDoc(
        d.file_id,
        d.stage,
        d.discipline,
        d.code,
        d.revision,
        d.status or "DRAFT",
        d.date,
        "Пояснительная записка" if d.stage == "PD" else "Архитектурные решения",
        [],
    )
    pages = [PageSpec(), PageSpec()]
    d.marks = {}
    for i, sp in enumerate(pages):
        _stamp(sp, fd, i + 1, len(pages))
    _page_general(d, reg, pages[0])
    _page_tep(d, reg, pages[1])
    render_pdf(fd, pages, path)


# ─────────────────────────────────────────────── истина


def rule_breaks(p: dict, ref, val) -> bool:
    """Нарушение по правилу Матрицы (истина стенда, независимо от паспорта системы)."""
    r = p["rule"]
    if r["type"] == "rank_decrease":
        return p["scale"].index(val) < p["scale"].index(ref)
    d = val - ref
    if r["type"] == "abs":
        return abs(d) > r["tol"] + 1e-9
    if r["type"] == "pct":
        return abs(d) > max(r["tol"], r["pct"] * abs(ref) / 100) + 1e-9
    if r["type"] == "decrease":
        return -d > r["tol"] + 1e-9
    raise ValueError(f"правило {r['type']!r} не известно")


def _value(p: dict, v: Values):
    return {"quantity": v.q, "count": v.n}.get(p["kind"], v.cls)[p["code"]]


def truth_for(case: dict, docs: list[DocPlan], reg: dict) -> list[dict]:
    """Истина по каждой паре «параметр × оператор» реестра: полярность, ожидаемый статус, где значение в РД."""
    impl = set(reg.get("implemented") or [])
    pd = next(d for d in docs if d.stage == "PD")
    rd_current = [
        d for d in docs if d.stage == "RD" and d.file_id in case["rd_current"]
    ]
    out = []
    for p in reg["params"]:
        target = (
            (p["code"], p["operator"]) == tuple(case["target"])
            if case["target"]
            else False
        )
        requires = list(p.get("requires") or [])
        mod = case.get("modifier")
        if mod == "MUT-17" and target:
            requires += reg["modifiers"]["MUT-17"]["requires"]
        if mod == "MUT-18/swap":
            requires += reg["modifiers"]["MUT-18"]["swap_requires"]
        pending = not p["wired"] or any(r not in impl for r in requires)
        row = {
            "case_id": case["case_id"],
            "code": p["code"],
            "operator": p["operator"],
            "target": target,
            "mutation": case["mutation"],
            "variant": case["variant"],
            "wired": p["wired"],
            "requires": requires,
            "pending": pending,
            "tags": list(case.get("tags") or []),
            "pd_value": None,
            "rd_value": None,
            "evidence": [],
        }
        if p["kind"] in ("quantity", "class", "count"):
            ref = _value(p, pd.values)
            vals = [_value(p, d.values) for d in rd_current]
            row["pd_value"], row["rd_value"] = (
                ref,
                (vals[0] if len(vals) == 1 else vals),
            )
            if mod == "MUT-18/conflict":
                row["polarity"], row["expected"] = "other", ["CLARIFICATION_REQUIRED"]
            elif mod == "MUT-17" and target:
                row["polarity"], row["expected"] = (
                    "other",
                    list(reg["modifiers"]["MUT-17"]["expect"]),
                )
            elif mod == "MUT-18/swap":
                row["polarity"], row["expected"] = "other", ["CLARIFICATION_REQUIRED"]
            else:
                bad = any(rule_breaks(p, ref, x) for x in vals)
                row["polarity"], row["expected"] = (
                    ("pos", ["CANDIDATE"]) if bad else ("neg", ["NEGATIVE_VERIFIED"])
                )
            for d in rd_current:
                for m in d.marks.get(p["code"], []):
                    row["evidence"].append(
                        {
                            "stage": "RD",
                            "file_id": d.file_id,
                            "document_code": d.code,
                            **m,
                        }
                    )
        else:
            # MUT-12 меняет итог экспликации — это нарушение и для CMP-10, хотя цель примера — общая площадь CMP-02
            changed = bool(target and case["mutation"].startswith("MUT")) or (
                p["kind"] == "rooms_total" and case["mutation"] == "MUT-12"
            )
            row["polarity"], row["expected"] = (
                ("pos", ["CANDIDATE"]) if changed else ("neg", ["NEGATIVE_VERIFIED"])
            )
            key = {
                "rooms_total": "rooms_total",
                "room_purpose": "rooms",
                "branches": "branches",
                "mark": p["code"],
                "layers": p["code"],
            }[p["kind"]]
            for d in rd_current:
                for m in (
                    d.marks.get(key, [])[:1]
                    if not case.get("focus")
                    else [x for x in d.marks.get(key, []) if x["raw"] in case["focus"]]
                ):
                    row["evidence"].append(
                        {
                            "stage": "RD",
                            "file_id": d.file_id,
                            "document_code": d.code,
                            **m,
                        }
                    )
        out.append(row)
    return out


# ─────────────────────────────────────────────── мутации


def _q_mutation(p: dict, v: Values, rng: random.Random, pos: bool) -> str:
    """MUT-05: число в ТЭП. pos — нарушение по правилу; neg — формат, отклонение в допуске или улучшение."""
    c, ref = p["code"], v.q[p["code"]]
    t = p["rule"]["type"]
    if pos:
        rel = (
            rng.uniform(0.012, 0.15)
            if t == "pct"
            else rng.choice([0.0, rng.uniform(0.001, 0.12)])
        )
        step = max(0.1, round(ref * rel, 1)) if t != "pct" else round(ref * rel, 1)
        sign = -1 if t == "decrease" else rng.choice([-1, 1])
        v.q[c] = round(ref + sign * step, 1)
        return "above_tolerance" if step > 0.1 else "one_digit"
    kinds = (
        ["format"]
        + (["within"] if t == "pct" else [])
        + (["improve"] if t == "decrease" else [])
    )
    k = rng.choice(kinds)
    if k == "format":
        v.qfmt[c] = rng.choice(["tight", "dot", "zeros"])
    elif k == "within":
        v.q[c] = round(ref * (1 + rng.choice([-1, 1]) * rng.uniform(0.001, 0.008)), 1)
    else:
        v.q[c] = round(ref * (1 + rng.uniform(0.005, 0.1)), 1)
    return k


def _n_mutation(p: dict, v: Values, rng: random.Random, pos: bool, reg: dict) -> str:
    """MUT-05 для целых: ±1 или ±k (pos, по правилу — decrease только вниз); neg — «шт.»/«ед.» при том же числе,
    перестановка строк ТЭП или строк разбивки при той же сумме."""
    c, ref = p["code"], v.n[p["code"]]
    if pos:
        k = rng.choice([1, 1, rng.randint(2, 5)])
        sign = -1 if p["rule"]["type"] == "decrease" else rng.choice([-1, 1])
        k = min(k, ref - 1) if sign < 0 else k  # не до нуля
        v.n[c] = ref + sign * max(1, k)
        if c in v.breakdown:  # итог меняется вместе со строкой разбивки: документ внутренне согласован
            v.breakdown[c][-1][1] = max(0, v.breakdown[c][-1][1] + (v.n[c] - ref))
        return "plus_minus_1" if abs(v.n[c] - ref) == 1 else "plus_minus_k"
    kinds = ["format", "permute_rows"] + (["permute_breakdown"] if c in v.breakdown else [])
    k = rng.choice(kinds)
    if k == "format":
        v.nfmt[c] = rng.choice(["sht", "ed"])
    elif k == "permute_rows":
        codes = [x["code"] for x in _q_params(reg) + _n_params(reg)]
        while (order := rng.sample(codes, len(codes))) == codes:
            pass
        v.row_order = order
    else:
        rows = v.breakdown[c]
        while (perm := rng.sample(rows, len(rows))) == rows:
            pass
        v.breakdown[c] = perm
    return k


def _c_mutation(p: dict, v: Values, rng: random.Random, pos: bool) -> str:
    """MUT-06: понижение класса по шкале (pos); повышение или другое написание того же класса (neg)."""
    c, sc = p["code"], p["scale"]
    i = sc.index(v.cls[c])
    if pos:
        v.cls[c] = sc[rng.randint(0, i - 1)]
        return f"down_{i - sc.index(v.cls[c])}"
    if i + 1 < len(sc) and rng.random() < 0.5:
        v.cls[c] = sc[rng.randint(i + 1, len(sc) - 1)]
        return "upgrade"
    v.cfmt[c] = rng.choice(["latin", "space"])
    return "format"


def _mutate(
    kind: str,
    p: dict,
    v: Values,
    rng: random.Random,
    pos: bool,
    variant: str | None = None,
    reg: dict | None = None,
) -> tuple[str, list[str] | None]:
    """Мутация значения вида kind в документе РД. Возвращает (вариант, подписи в фокусе для рамки истины)."""
    if kind == "quantity":
        return _q_mutation(p, v, rng, pos), None
    if kind == "count":
        return _n_mutation(p, v, rng, pos, reg or {"params": [p]}), None
    if kind == "class":
        return _c_mutation(p, v, rng, pos), None
    if kind == "mark":  # MUT-07: марка кабеля без индекса огнестойкости
        v.mark = rng.choice(p["downgrade"])
        return "downgrade", None
    if kind == "layers":  # MUT-08: тоньше утеплитель или слой удалён
        if variant == "drop":
            i = rng.randrange(1, len(v.layers))
            name = v.layers.pop(i)[0]
            return "drop", [name]
        i = next(k for k, lay in enumerate(v.layers) if "утеплитель" in lay[0])
        v.layers[i][1] = v.layers[i][1] - rng.choice([30, 50, 70])
        return "thin", [str(v.layers[i][1])]
    if kind == "room_purpose":  # MUT-11: назначение помещения в экспликации
        cand = [r for r in v.rooms if r[1] in PURPOSE_SWAP]
        r = rng.choice(cand) if cand else v.rooms[0]
        r[1] = PURPOSE_SWAP.get(r[1], "Техническое помещение")
        return "purpose", [f"{r[0]} {r[1]}"]
    if kind == "branches":
        i = rng.randrange(len(v.branches))
        if variant == "MUT-01":  # подпись ветви удалена вместе с выноской
            v.branches.pop(i)
            return "removed", None
        old = v.branches[i]
        v.branches[i] = (
            f"В2.{11 + i}"  # MUT-02: переименование, не удаление (ожидается RENAMED)
        )
        return f"renamed {old}", [v.branches[i]]
    raise ValueError(kind)


def _doc(
    case_id: str,
    base: str,
    stage: str,
    rev: str,
    status: str | None,
    date: str,
    pred: str | None,
    v: Values,
    n: int,
) -> DocPlan:
    disc = "ПЗ" if stage == "PD" else "АР"
    code = f"{'П' if stage == 'PD' else 'Р'}-{base}-{disc}"
    fid = f"{case_id}-{stage.lower()}{n}"
    d = DocPlan(fid, stage, disc, code, rev, status, date, pred, v)
    d.file_name = f"{code} изм{rev}.pdf"
    return d


def make_case(
    reg: dict,
    seed: int,
    idx: int,
    mutation: str,
    target: tuple[str, str] | None,
    pos: bool,
    variant: str | None = None,
    modifier: str | None = None,
    adversarial: dict | None = None,
) -> tuple[dict, list[DocPlan]]:
    """Один пример: объект, документы ПД и РД (одна или две редакции РД), мутация в текущей или в устаревшей РД."""
    rng = random.Random(f"mut:{seed}:{idx}")
    case_id = f"MUT-{seed}-{idx:04d}"
    base = f"{seed}-{idx:04d}"
    pdv = base_values(reg, rng, random.Random(f"count:{seed}:{idx}"))
    rdv = copy.deepcopy(pdv)
    p = (
        next((x for x in reg["params"] if (x["code"], x["operator"]) == target), None)
        if target
        else None
    )
    tags: list[str] = []
    focus = None
    var = variant or ""
    if mutation.startswith("MUT") and p is not None and mutation != "MUT-12":
        var, focus = _mutate(p["kind"], p, rdv, rng, pos, variant, reg)
    elif mutation == "MUT-12" and p is not None and p["kind"] == "count":
        # строка разбивки добавлена, итог и значение ТЭП выросли (pos); neg — строки переставлены, сумма та же
        c = p["code"]
        if pos:
            k = rng.randint(1, 6)
            rdv.breakdown[c].append([p["extra_row"], k])
            rdv.n[c] += k
            var, focus = "row_added", [f"{p['extra_row']} {k}"]
        else:
            rows = rdv.breakdown[c]
            while (perm := rng.sample(rows, len(rows))) == rows:
                pass
            rdv.breakdown[c] = perm
            var = "rows_permuted"
    elif (
        mutation == "MUT-12"
    ):  # помещение добавлено, итог экспликации и общая площадь выросли
        total = rdv.q["M-002"]
        share = rng.uniform(0.012, 0.06) if pos else rng.uniform(0.0005, 0.008)
        area = max(0.1, round(total * share, 1))
        num = f"1.{len(rdv.rooms) + 1:02d}"
        rdv.rooms.append([num, "Кладовая уборочного инвентаря", area])
        rdv.q["M-002"] = round(total + area, 1)
        var, focus = (
            ("room_above_1pct" if pos else "room_within_1pct"),
            [f"{num} Кладовая уборочного инвентаря"],
        )
    elif mutation == "NEG-03":
        rdv.detail = True
        var = "detail"
    elif mutation == "NEG-01":
        var = "self"
    if modifier == "MUT-17":
        rdv.cloud = target[0]
    d_pd = _doc(
        case_id,
        base,
        "PD",
        "1",
        STATUS["PD"],
        f"{10 + idx % 18:02d}.02.2026",
        None,
        pdv,
        1,
    )
    docs = [d_pd]
    rd_current: list[str]
    if (
        mutation == "NEG-02"
    ):  # две редакции РД: отличаются только штампом (редакция, дата)
        a = _doc(
            case_id,
            base,
            "RD",
            "1",
            STATUS["RD"],
            "03.04.2026",
            None,
            copy.deepcopy(pdv),
            1,
        )
        b = _doc(
            case_id,
            base,
            "RD",
            "2",
            STATUS["RD"],
            "17.05.2026",
            a.file_id,
            copy.deepcopy(pdv),
            2,
        )
        docs += [a, b]
        rd_current, var = [b.file_id], "stamp_only"
    elif modifier and modifier.startswith("MUT-18"):
        old = _doc(
            case_id, base, "RD", "1", STATUS["RD"], "03.04.2026", None, rdv, 1
        )  # с нарушением
        new = _doc(
            case_id,
            base,
            "RD",
            "2",
            STATUS["RD"],
            "17.05.2026",
            None,
            copy.deepcopy(pdv),
            2,
        )  # как ПД
        kind = modifier.split("/")[1]
        if (
            kind == "stale"
        ):  # нарушение только в устаревшей редакции: реестр верен, новая заменяет старую
            new.predecessor = old.file_id
            rd_current, tags = [new.file_id], ["superseded"]
        elif kind == "conflict":  # обе утверждены, связи замены нет — конфликт редакций
            rd_current, tags = [old.file_id, new.file_id], ["conflict"]
        else:  # swap: реестр выдаёт старую редакцию за актуальную (штамп старше, но «заменяет» новую)
            old.predecessor = new.file_id
            rd_current, tags = [new.file_id], ["swap"]
        docs += [old, new]
    else:
        rd = _doc(case_id, base, "RD", "1", STATUS["RD"], "03.04.2026", None, rdv, 1)
        docs.append(rd)
        rd_current = [rd.file_id]
    if adversarial:  # своя формулировка у каждого документа; значения (истина) те же
        for d in docs:
            d.values = copy.deepcopy(d.values)
            d.values.adv = pick_style(adversarial, reg, random.Random(f"adv:{seed}:{idx}:{d.file_id}")) | {"_src": adversarial}
    case = {
        "case_id": case_id,
        "seed": seed,
        "index": idx,
        "mutation": mutation,
        "variant": var,
        "modifier": modifier,
        "target": list(target) if target else None,
        "base_cipher": base,
        "tags": tags,
        "rd_current": rd_current,
        "focus": focus,
        "profile": {"residential": True, "underground": True},
    }
    return case, docs


def plan(reg: dict, seed: int, scale: float = 1.0) -> list[tuple]:
    """Список примеров (мутация, цель, pos, вариант, модификатор) по счётчикам реестра; scale < 1 — лёгкий набор."""
    out: list[tuple] = []

    def n(x: int) -> int:
        return max(1, round(x * scale)) if x else 0

    for p in reg["params"]:
        t = (p["code"], p["operator"])
        for mut, cnt in (p.get("counts") or {}).items():
            if mut in ("MUT-05", "MUT-06", "MUT-12"):
                out += [(mut, t, True, None, None)] * n(cnt.get("pos", 0)) + [
                    (mut, t, False, None, None)
                ] * n(cnt.get("neg", 0))
            elif mut == "MUT-18":
                for k in ("stale", "conflict", "swap"):
                    out += [
                        (
                            "MUT-06" if p["kind"] == "class" else "MUT-05",
                            t,
                            True,
                            None,
                            f"MUT-18/{k}",
                        )
                    ] * n(cnt.get(k, 0))
            elif mut == "MUT-17":
                out += [
                    (
                        "MUT-06" if p["kind"] == "class" else "MUT-05",
                        t,
                        True,
                        None,
                        "MUT-17",
                    )
                ] * n(cnt)
            elif mut == "MUT-08":
                for k in ("thin", "drop"):
                    out += [(mut, t, True, k, None)] * n(cnt.get(k, 0))
            elif mut in ("MUT-01", "MUT-02"):
                out += [(mut, t, True, mut, None)] * n(cnt)
            else:
                out += [(mut, t, True, None, None)] * n(cnt)
    for neg, cnt in reg["negatives"].items():
        out += [(neg, None, False, None, None)] * n(cnt)
    return out


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def build(
    out: Path,
    seed: int,
    scale: float = 1.0,
    limit: int | None = None,
    reg: dict | None = None,
    adversarial: dict | None = None,
) -> dict:
    """Набор: по каталогу на пример (PDF + manifest.json), общий truth.json и cases.json для прогона API.
    adversarial — отложенный набор формулировок (профиль adversarial); None — шаблоны structural."""
    reg = reg or load_registry()
    out.mkdir(parents=True, exist_ok=True)
    items = plan(reg, seed, scale)[: limit or None]
    cases, truth = [], []
    for i, (mut, target, pos, variant, modifier) in enumerate(items):
        case, docs = make_case(reg, seed, i, mut, target, pos, variant, modifier, adversarial)
        cdir = out / case["case_id"]
        cdir.mkdir(exist_ok=True)
        for d in docs:
            render(d, reg, cdir / d.file_name)
        case["files"] = [
            {
                "file_id": d.file_id,
                "file_name": d.file_name,
                "sha256": sha256(cdir / d.file_name),
                "doc_stage": d.stage,
                "discipline": d.discipline,
                "document_code": d.code,
                "revision": d.revision,
                "approval_status": d.status,
                "approval_date": d.date,
                "predecessor_id": d.predecessor,
                "truth_values": {
                    **d.values.q,
                    **d.values.cls,
                    **d.values.n,
                },  # истинные значения листа — метки судьи (T-156)
                "style": style_summary(d.values.adv),
            }
            for d in docs
        ]
        (cdir / "manifest.json").write_text(
            json.dumps({"files": case["files"]}, ensure_ascii=False, indent=1), "utf-8"
        )
        truth += truth_for(case, docs, reg)
        cases.append(case)
    ds = {
        "schema": SCHEMA,
        "dataset_version": f"mutations-w1{':adv' if adversarial else ''}:seed={seed}:scale={scale}:n={len(cases)}",
        "external_phrasers": (adversarial or {}).get("external_status", {}),
        "seed": seed,
        "scale": scale,
        "registry_sha256": hashlib.sha256(
            json.dumps(reg, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()[:16],
        "cases": cases,
        "truth": truth,
    }
    (out / "dataset.json").write_text(json.dumps(ds, ensure_ascii=False), "utf-8")
    return ds


def main(argv: list[str] | None = None) -> None:  # pragma: no cover — CLI
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    ds = build(a.out, a.seed, a.scale, a.limit)
    print(
        json.dumps(
            {"cases": len(ds["cases"]), "truth": len(ds["truth"]), "out": str(a.out)},
            ensure_ascii=False,
        )
    )


KINDS = {
    "count",
    "quantity",
    "class",
    "mark",
    "layers",
    "room_purpose",
    "rooms_total",
    "branches",
}

if __name__ == "__main__":  # pragma: no cover
    main()
