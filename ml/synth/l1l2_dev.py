"""DEV-набор T-178: листы со штампами ГОСТ Р 21.101 (формы 3, 5, 6) и таблицы ТЭП и экспликаций — векторные PDF
(reportlab) и gold.json. На нём доводится L1/L2; итоговая цифра — на HOLDOUT (synth/l1l2_holdout.py, другой автор).
Только синтетика (ADR-0002).

    python -m synth.l1l2_dev OUT_DIR --seed 1 --sheets 60 --tables 40

Схема gold.json общая с HOLDOUT: stamps[{file, page, form, code, stage, sheet, sheets, revision, changes[]}],
tables[{file, page, kind, value_columns, rows[{name, unit, values, total, section}]}].
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml.paths import repo_root

FONT = "Noto"
if FONT not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(
        TTFont(FONT, str(repo_root() / "assets/fonts/NotoSans.ttf"))
    )

SIZES = {"A4": (210, 297), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594)}
HEIGHT = {3: 55, 5: 40, 6: 15}
CHANGE_ROWS = {3: 3, 5: 1, 6: 2}
HEADER_Y = {3: 15, 5: 5, 6: 10}  # верх шапки «Изм. …» от верха надписи, мм
COLS = [
    ("izm", 0, 10),
    ("kol_uch", 10, 20),
    ("sheet", 20, 30),
    ("doc_no", 30, 40),
    ("sign", 40, 55),
    ("date", 55, 65),
]
HEAD = ["Изм.", "Кол.уч", "Лист", "№док.", "Подп.", "Дата"]
# ячейки значений: (x0, y0, x1, y1) мм от левого верхнего угла надписи
CELLS = {
    3: {
        "code": (65, 0, 185, 10),
        "building": (65, 25, 135, 40),
        "stage": (135, 30, 150, 40),
        "sheet": (150, 30, 165, 40),
        "sheets": (165, 30, 185, 40),
        "title": (65, 40, 135, 55),
        "org": (135, 40, 185, 55),
    },
    5: {
        "code": (65, 0, 185, 15),
        "title": (65, 15, 135, 40),
        "stage": (135, 20, 150, 25),
        "sheet": (150, 20, 165, 25),
        "sheets": (165, 20, 185, 25),
        "org": (135, 25, 185, 40),
    },
    6: {"code": (65, 0, 175, 15), "sheet": (175, 7, 185, 15)},
}
LABELS = {
    3: [
        ("Стадия", (135, 25, 150, 30)),
        ("Лист", (150, 25, 165, 30)),
        ("Листов", (165, 25, 185, 30)),
        ("Разраб.", (0, 20, 20, 25)),
        ("Пров.", (0, 25, 20, 30)),
        ("Н.контр.", (0, 50, 20, 55)),
    ],
    5: [
        ("Стадия", (135, 15, 150, 20)),
        ("Лист", (150, 15, 165, 20)),
        ("Листов", (165, 15, 185, 20)),
        ("Разраб.", (0, 10, 20, 15)),
        ("Н.контр.", (0, 35, 20, 40)),
    ],
    6: [("Лист", (175, 0, 185, 7))],
}
CODES = [
    "{n}-{y}-{m}",
    "ПД-{n}/{yy}-{m}",
    "РД.{n}-{m}",
    "{n}/{yy}-П-{m}",
    "{n}.{yy}-{m}",
]
MARKS = ["АР", "КР", "КЖ", "ОВ1", "ВК", "ЭОМ", "ИОС5.4.2", "ПЗ", "ГП"]
LAT = {"А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X"}
TITLES = [
    "План 1 этажа",
    "План типового этажа",
    "Разрез 1-1",
    "Фасад в осях 1-8",
    "Общие данные",
    "Схема системы П1",
]


def _code(r: random.Random) -> str:
    return r.choice(CODES).format(
        n=r.randint(10, 9999),
        y=r.randint(2019, 2026),
        yy=r.randint(19, 26),
        m=r.choice(MARKS),
    )


def _center(
    c: canvas.Canvas, text: str, box, ox: float, top: float, size: float
) -> None:
    x0, y0, x1, y1 = box
    c.setFont(FONT, size)
    w = pdfmetrics.stringWidth(text, FONT, size)
    if w > (x1 - x0) * mm * 0.95:
        size *= (x1 - x0) * mm * 0.95 / w
        c.setFont(FONT, size)
    c.drawCentredString(
        ox + (x0 + x1) / 2 * mm, top - (y0 + y1) / 2 * mm - size * 0.35, text
    )


def stamp_sheet(path: Path, r: random.Random) -> dict:
    form = r.choice([3, 3, 5, 6])
    fmt = (
        r.choice(["A4", "A3", "A3", "A2", "A1"])
        if form != 5
        else r.choice(["A4", "A3"])
    )
    wmm, hmm = SIZES[fmt]
    if fmt == "A4" and form == 3 and r.random() < 0.5:
        wmm, hmm = hmm, wmm
    c = canvas.Canvas(str(path), pagesize=(wmm * mm, hmm * mm), invariant=1)
    c.setLineWidth(0.7)
    c.rect(20 * mm, 5 * mm, (wmm - 25) * mm, (hmm - 10) * mm)
    h = HEIGHT[form]
    ox, top = (wmm - 5 - 185) * mm, (5 + h) * mm
    c.rect(ox, 5 * mm, 185 * mm, h * mm)
    for y in range(5, h, 5):
        c.line(ox, top - y * mm, ox + 65 * mm, top - y * mm)
    for _, x0, _ in COLS[1:] + [("", 65, 0)]:
        c.line(ox + x0 * mm, 5 * mm, ox + x0 * mm, top)
    size = r.uniform(5.5, 8.5)
    code = _code(r)
    if r.random() < 0.2:  # латиница-двойник в шифре (набор в САПР)
        code = "".join(LAT.get(ch, ch) if r.random() < 0.5 else ch for ch in code)
    stage = r.choice(["П", "Р"]) if form != 6 else None
    sheets = r.randint(2, 60)
    sheet = (
        str(r.randint(1, sheets))
        if r.random() < 0.85
        else f"{r.randint(1, 9)}{r.choice(['а', '.1'])}"
    )
    values = {"code": code, "sheet": sheet}
    if form != 6:
        values |= {
            "stage": stage,
            "sheets": str(sheets) if r.random() < 0.9 else "",
            "org": "ООО «Проект»",
            "title": r.choice(TITLES),
        }
        if form == 3:
            values["building"] = "Жилой дом"
    customer = form != 6 and r.random() < 0.15
    for k, v in values.items():
        box = CELLS[form][k]
        if k == "code" and customer:  # «Заказчик: …» второй строкой графы 1 — в шифр не входит
            box = (box[0], box[1], box[2], box[1] + (box[3] - box[1]) * 0.55)
            _center(c, "Заказчик: АО «Девелопмент»", (box[0], box[3], box[2], CELLS[form][k][3]), ox, top, size * 0.7)
        if v:
            _center(c, v, box, ox, top, size * (1.3 if k == "code" else 1))
    labels = r.random() < 0.7
    if labels:
        for text, box in LABELS[form]:
            _center(c, text, box, ox, top, size * 0.85)
        for text, (_, x0, x1) in zip(HEAD, COLS):
            _center(
                c,
                text,
                (x0, HEADER_Y[form], x1, HEADER_Y[form] + 5),
                ox,
                top,
                size * 0.8,
            )
    n = r.randint(0, CHANGE_ROWS[form])
    changes = []
    for i in range(n):  # по ГОСТ снизу вверх: изменение 1 — над шапкой
        izm = n - i
        row = {
            "izm": str(izm),
            "kol_uch": r.choice(["1", "2", "-", "Зам.", "Нов."]),
            "sheet": str(r.randint(1, sheets)),
            "doc_no": f"{r.randint(1, 99)}-{r.randint(20, 26)}",
            "date": r.choice(
                [
                    f"{r.randint(1, 12):02d}.{r.randint(20, 26)}",
                    f"{r.randint(1, 12):02d}.20{r.randint(20, 26)}",
                ]
            ),
        }
        y = HEADER_Y[form] - (n - i) * 5
        for key, x0, x1 in COLS:
            if key in row:
                _center(c, row[key], (x0, y, x1, y + 5), ox, top, size * 0.8)
        changes.append(row)
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "page": 1,
        "form": form,
        "code": code,
        "stage": stage,
        "sheet": sheet,
        "sheets": sheets if form != 6 and values.get("sheets") else None,
        "revision": n or None,
        "changes": changes,
    }


# ─────────────────────────────────────────────── таблицы

TEP_ROWS = [
    ("Площадь участка", "м²"),
    ("Площадь застройки", "м²"),
    ("Общая площадь здания", "м²"),
    ("Площадь квартир", "м²"),
    ("Строительный объем", "м³"),
    ("Этажность", "эт"),
    ("Количество квартир", "шт"),
    ("Высота здания", "м"),
    ("Коэффициент застройки", "%"),
    ("Количество машино-мест", "шт"),
]
ROOMS = [
    "Тамбур",
    "Коридор",
    "Лестничная клетка",
    "Помещение уборочного инвентаря",
    "Кладовая",
    "Электрощитовая",
    "Помещение охраны",
    "Санузел",
    "Техническое помещение",
]
UNIT_TEXT = {
    "м²": ["м²", "м2", "кв.м"],
    "м³": ["м³", "м3"],
    "м": ["м"],
    "эт": ["эт."],
    "шт": ["шт.", "шт"],
    "%": ["%"],
}


def _fmt(v: float, r: random.Random, dec: int = 1) -> str:
    s = f"{v:,.{dec}f}".replace(",", " ").replace(".", ",")
    if dec == 0:
        s = s.split(",")[0]
    return s if r.random() < 0.7 else s.replace(" ", "")


def _wrap(text: str, width: float, size: float) -> list[str]:
    """Перенос по словам; слово шире колонки рвётся с дефисом переноса («застрой-» / «ки»)."""
    out, cur = [], ""
    words = []
    for w in text.split():
        while pdfmetrics.stringWidth(w, FONT, size) > width and len(w) > 6:
            cut = max(3, int(len(w) * width / pdfmetrics.stringWidth(w, FONT, size)) - 1)
            words.append(w[:cut] + "-")
            w = w[cut:]
        words.append(w)
    for w in words:
        t = f"{cur} {w}".strip()
        if cur and pdfmetrics.stringWidth(t, FONT, size) > width:
            out.append(cur)
            cur = w
        else:
            cur = t
    return out + [cur]


def draw_table(c: canvas.Canvas, x0: float, y0: float, widths: list[float], header: list[list], body: list[list[str]], size: float,
               inner: bool = True, merges: list = (), lines: bool = True) -> None:
    """Таблица с сеткой линий. header — строки шапки: None — ячейка слита с соседней слева (в первой строке шапки или
    под None) или с ячейкой сверху. body — строки тела; merges — (строка тела, c0, c1): ячейка слита по ширине.
    Тексты переносятся по ширине колонки. inner=False — у тела нет внутренних горизонталей."""
    xs = [x0]
    for w in widths:
        xs.append(xs[-1] + w)
    lh = size * 1.25
    spans = {(ri, c0): c1 for ri, c0, c1 in merges}
    rows = header + body
    c.setFont(FONT, size)
    c.setLineWidth(0.6)
    y = y0
    for ri, row in enumerate(rows):
        is_head = ri < len(header)
        cells = []  # (k0, k1, text)
        k = 0
        while k < len(row):
            k1 = k + 1
            if is_head:
                while k1 < len(row) and _hmerged(header, ri, k1):
                    k1 += 1
            else:
                k1 = spans.get((ri - len(header), k), k1)
            cells.append((k, k1, row[k]))
            k = k1
        n = max((len(_wrap(t, xs[k1] - xs[k0] - 6, size)) for k0, k1, t in cells if t), default=1)
        h = n * lh + 6
        # верхняя линия строки: в шапке — кроме колонок, слитых с ячейкой сверху; в теле — если есть внутренние линии
        for k0, k1, t in cells:
            vmerged = is_head and ri > 0 and t is None and not _hmerged(header, ri, k0)
            if ri == 0 or (is_head and not vmerged) or (not is_head and (inner or ri == len(header))):
                lines and c.line(xs[k0], y, xs[k1], y)
            if k0 > 0:
                lines and c.line(xs[k0], y, xs[k0], y - h)
            if t:
                ty = y - 3 - size
                for ln in _wrap(t, xs[k1] - xs[k0] - 6, size):
                    if is_head:
                        c.drawCentredString((xs[k0] + xs[k1]) / 2, ty, ln)
                    else:
                        c.drawString(xs[k0] + 3, ty, ln)
                    ty -= lh
        y -= h
    if lines:
        c.line(xs[0], y, xs[-1], y)
        c.line(xs[0], y0, xs[0], y)
        c.line(xs[-1], y0, xs[-1], y)


def _hmerged(header: list[list], ri: int, k: int) -> bool:
    """None в шапке слито с соседней слева, если над ним нет подписи (первая строка или сверху тоже None)."""
    return k > 0 and header[ri][k] is None and (ri == 0 or header[ri - 1][k] is None)


def tep_table(path: Path, r: random.Random) -> dict:
    c = canvas.Canvas(str(path), pagesize=(210 * mm, 297 * mm), invariant=1)
    size = r.uniform(7, 9.5)
    c.setFont(FONT, size + 2)
    c.drawString(25 * mm, 280 * mm, "Технико-экономические показатели")
    parts = r.random() < 0.4
    unit_mode = r.choice(["column", "column", "name"])
    picks = r.sample(TEP_ROWS, r.randint(5, 9))
    body, gold = [], []
    for i, (name, unit) in enumerate(picks, 1):
        total = (
            round(r.uniform(50, 60000), 1)
            if unit in ("м²", "м³")
            else float(r.randint(1, 30))
            if unit != "%"
            else round(r.uniform(10, 60), 1)
        )
        dec = 1 if unit in ("м²", "м³", "%", "м") else 0
        shown = (
            name if unit_mode == "column" else f"{name}, {r.choice(UNIT_TEXT[unit])}"
        )
        if parts:
            above = round(total * r.uniform(0.6, 0.9), dec)
            below = round(total - above, dec)
            vals = (
                [total, above, below] if unit in ("м²", "м³") else [total, None, None]
            )
            cells = [
                _fmt(v, r, dec) if v is not None else r.choice(["—", ""]) for v in vals
            ]
        else:
            vals = [total]
            cells = [_fmt(total, r, dec)]
        row = (
            [str(i), shown]
            + ([r.choice(UNIT_TEXT[unit])] if unit_mode == "column" else [])
            + cells
        )
        body.append(row)
        gold.append(
            {
                "name": name,
                "unit": unit,
                "values": vals,
                "total": False,
                "section": None,
            }
        )
        if name == "Строительный объем" and not parts and r.random() < 0.7:
            for j, part in enumerate(("надземной", "подземной"), 1):
                v = round(total * (0.8 if j == 1 else 0.2), 1)
                body.append(
                    [f"{i}.{j}", f"в т.ч. {part} части"]
                    + (["м³"] if unit_mode == "column" else [])
                    + [_fmt(v, r)]
                )
                gold.append(
                    {
                        "name": f"в т.ч. {part} части",
                        "unit": "м³" if unit_mode == "column" else None,
                        "values": [v],
                        "total": False,
                        "section": None,
                    }
                )
    head = ["№ п/п", "Наименование показателя"] + (
        ["Ед. изм."] if unit_mode == "column" else []
    )
    vcols = (
        ["Всего", "Надземная часть", "Подземная часть"]
        if parts
        else [r.choice(["Значение", "По проекту", "Показатель"])]
    )
    if parts and r.random() < 0.6:
        header = [head + ["Значение", None, None], [None] * len(head) + vcols]
    else:
        header = [head + vcols]
    if r.random() < 0.4:
        header.append([str(k + 1) for k in range(len(header[0]))])
    name_w = r.choice([70, 70, 32])  # узкая колонка — наименования в две-три строки, длинные слова с дефисом
    uw = 18 if unit_mode == "column" else 0
    widths = [12 * mm, name_w * mm] + ([uw * mm] if uw else []) + [((180 - 12 - name_w - uw) / len(vcols)) * mm] * len(vcols)
    draw_table(c, 15 * mm, 270 * mm, widths, header, body, size, inner=r.random() < 0.85, lines=r.random() < 0.9)
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "page": 1,
        "kind": "tep",
        "value_columns": vcols,
        "rows": gold,
    }


def explication_table(path: Path, r: random.Random) -> dict:
    c = canvas.Canvas(str(path), pagesize=(297 * mm, 210 * mm), invariant=1)
    size = r.uniform(7, 9.5)
    c.setFont(FONT, size + 2)
    c.drawString(25 * mm, 195 * mm, "Экспликация помещений")
    cat = r.random() < 0.5
    header = [
        ["Номер помещения", "Наименование", "Площадь, м²"]
        + (["Кат. помещения"] if cat else [])
    ]
    body, gold, merges = [], [], []
    grand = 0.0
    for fl in range(1, r.randint(2, 3) + 1):
        sec = f"{fl} этаж"
        body.append([sec] + [""] * (len(header[0]) - 1))
        merges.append((len(body) - 1, 0, len(header[0])))
        s = 0.0
        for j in range(1, r.randint(2, 5) + 1):
            a = round(r.uniform(2, 60), 1)
            s += a
            name = r.choice(ROOMS)
            body.append(
                [f"{fl}.{j}", name, _fmt(a, r)]
                + ([r.choice(["Д", "В4", "—"])] if cat else [])
            )
            gold.append(
                {
                    "name": name,
                    "unit": "м²",
                    "values": [a],
                    "total": False,
                    "section": sec,
                }
            )
        s = round(s, 1)
        grand += s
        body.append(["", "Итого по этажу", _fmt(s, r)] + ([""] if cat else []))
        gold.append(
            {
                "name": "Итого по этажу",
                "unit": "м²",
                "values": [s],
                "total": True,
                "section": sec,
            }
        )
    grand = round(grand, 1)
    body.append(["", "Всего", _fmt(grand, r)] + ([""] if cat else []))
    gold.append(
        {
            "name": "Всего",
            "unit": "м²",
            "values": [grand],
            "total": True,
            "section": gold[-1]["section"],
        }
    )
    widths = [28 * mm, 90 * mm, 30 * mm] + ([28 * mm] if cat else [])
    draw_table(c, 20 * mm, 185 * mm, widths, header, body, size, merges=merges)
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "page": 1,
        "kind": "explication",
        "value_columns": ["Площадь, м²"],
        "rows": gold,
    }


def apartments_table(path: Path, r: random.Random) -> dict:
    """Экспликация квартир: шапка в две строки («Площадь, м²» над «общая | жилая»), строка нумерации, секции, итоги."""
    c = canvas.Canvas(str(path), pagesize=(297 * mm, 210 * mm), invariant=1)
    size = r.uniform(7, 9.5)
    header = [["№ кв.", "Наименование", "Площадь, м²", None], [None, None, "общая", "жилая"]]
    if r.random() < 0.5:
        header.append(["1", "2", "3", "4"])
    body, gold, merges = [], [], []
    for sec in range(1, r.randint(1, 2) + 1):
        name = f"Секция {sec}"
        body.append([name, "", "", ""])
        merges.append((len(body) - 1, 0, 4))
        tot, liv = 0.0, 0.0
        for q in range(1, r.randint(2, 5) + 1):
            a = round(r.uniform(30, 110), 1)
            b = round(a * r.uniform(0.45, 0.65), 1)
            tot, liv = tot + a, liv + b
            rooms = r.randint(1, 4)
            body.append([f"{sec}{q:02d}", f"{rooms}-комнатная квартира", _fmt(a, r), _fmt(b, r)])
            gold.append({"name": f"{rooms}-комнатная квартира", "unit": "м²", "values": [a, b], "total": False, "section": name})
        tot, liv = round(tot, 1), round(liv, 1)
        body.append(["", "Итого по секции", _fmt(tot, r), _fmt(liv, r)])
        gold.append({"name": "Итого по секции", "unit": "м²", "values": [tot, liv], "total": True, "section": name})
    draw_table(c, 20 * mm, 185 * mm, [20 * mm, 80 * mm, 30 * mm, 30 * mm], header, body, size, merges=merges)
    c.showPage()
    c.save()
    return {"file": path.name, "page": 1, "kind": "explication", "value_columns": ["общая", "жилая"], "rows": gold}


def build(out: Path, seed: int, sheets: int, tables: int) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    gold = {"generator": "dev-v2", "seed": seed, "stamps": [], "tables": []}
    for i in range(1, sheets + 1):
        gold["stamps"].append(
            stamp_sheet(out / f"s{i:04d}.pdf", random.Random(f"{seed}-s-{i}"))
        )
    for i in range(1, tables + 1):
        r = random.Random(f"{seed}-t-{i}")
        x = r.random()
        make = tep_table if x < 0.5 else explication_table if x < 0.8 else apartments_table
        gold["tables"].append(make(out / f"t{i:04d}.pdf", r))
    (out / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return gold


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--sheets", type=int, default=60)
    ap.add_argument("--tables", type=int, default=40)
    a = ap.parse_args(argv)
    g = build(a.out, a.seed, a.sheets, a.tables)
    print(
        f"dev-v2 seed={a.seed}: листов {len(g['stamps'])}, таблиц {len(g['tables'])} → {a.out}"
    )


if __name__ == "__main__":
    main()
