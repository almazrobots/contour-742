"""HOLDOUT-генератор для T-178: штампы (основные надписи) и таблицы ТЭП/экспликаций.

Независимый от читателя генератор: написан по ГОСТ Р 21.101-2020 (прил. Ж, формы 3, 5, 6) и по
тому, как ТЭП и экспликации выглядят в проектной документации, без оглядки на код чтения.
Только синтетика (ADR-0002): все названия, шифры, фамилии и адреса выдуманы.

Выход: векторные PDF с текстовым слоем (reportlab, без растров) и gold.json.

    python -m synth.l1l2_holdout OUT_DIR --seed N --sheets K --tables M

Особенности gold (важно для сравнения):
- `code` — шифр ровно как напечатан, включая хвосты «-Изм.1» и суффикс листа «.3», и включая латинские
  двойники кириллицы, если они напечатаны (сравнивающему стоит нормализовать гомоглифы). Приписка
  «Заказчик: …» в шифр не входит.
- `changes` — сверху вниз, как напечатано. Таблица изменений заполняется по ГОСТ снизу вверх: первое
  изменение — в строке над шапкой «Изм. | Кол.уч. | …», поэтому сверху вниз номера УБЫВАЮТ.
- `revision` — наибольший номер изменения; null без строк изменений.
- у формы 6 `stage` и `sheets` всегда null; у форм 3/5 `sheets` null, если графа «Листов» пуста.
- в таблицах `value_columns` — нижний уровень шапки числовых колонок как напечатан (переносы → пробел);
  для экспликации `unit` строки — «м²» (единица из шапки колонки площади), поле `category` есть всегда.
- `section` у итоговой строки «Всего» в конце экспликации — ближайший раздел выше (последний раздел).
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass, field
from pathlib import Path

from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml.paths import repo_root

GENERATOR = "holdout-v1"
FONT_DIR = repo_root() / "assets" / "fonts"  # песочница mutmut глубже исходников (inspector_ml.paths)
FONTS = {"Noto": "NotoSans.ttf", "Onest": "Onest-Regular.ttf"}
CAP = 0.72  # высота прописной к кеглю: размер шрифта «в мм» по ГОСТ — высота прописной
THICK, THIN = 0.6, 0.2  # толщины линий, мм

for _name, _file in FONTS.items():
    pdfmetrics.registerFont(TTFont(_name, str(FONT_DIR / _file)))

# ---------------------------------------------------------------------------------------------------------------------
# Рисование
# ---------------------------------------------------------------------------------------------------------------------


def has_glyphs(font: str, s: str) -> bool:
    try:
        cmap = pdfmetrics.getFont(font).face.charToGlyph
    except AttributeError:  # pragma: no cover - другой бэкенд шрифта
        return True
    return all(ord(ch) in cmap for ch in s if ch != " ")


def sw(s: str, font: str, size: float) -> float:
    """Ширина строки в мм при высоте прописной size мм."""
    return pdfmetrics.stringWidth(s, font, size / CAP * mm) / mm


class Pen:
    """Обёртка над canvas в миллиметрах, с наклоном шрифта (ГОСТ тип Б) и подгонкой по ширине."""

    def __init__(self, c: canvas.Canvas, font: str, slant: float) -> None:
        self.c, self.font, self.slant = c, font, slant

    def line(self, x1: float, y1: float, x2: float, y2: float, w: float = THIN) -> None:
        self.c.setLineWidth(w * mm)
        self.c.line(x1 * mm, y1 * mm, x2 * mm, y2 * mm)

    def rect(self, x: float, y: float, w: float, h: float, lw: float = THICK) -> None:
        self.c.setLineWidth(lw * mm)
        self.c.rect(x * mm, y * mm, w * mm, h * mm, stroke=1, fill=0)

    def _font_for(self, s: str) -> str:
        return self.font if has_glyphs(self.font, s) else "Noto"

    def text(
        self,
        s: str,
        x: float,
        y: float,
        size: float,
        align: str = "l",
        maxw: float | None = None,
    ) -> None:
        if not s:
            return
        font = self._font_for(s)
        w = sw(s, font, size)
        scale = 1.0
        if maxw is not None and w > maxw:
            scale = max(maxw / w, 0.6)
            if w * scale > maxw:
                size *= maxw / (w * scale)
                w = sw(s, font, size)
        eff = w * scale
        xs = x if align == "l" else (x - eff / 2 if align == "c" else x - eff)
        t = self.c.beginText()
        t.setFont(font, size / CAP * mm)
        if scale < 1.0:
            t.setHorizScale(scale * 100)
        t.setTextTransform(1, 0, self.slant, 1, xs * mm, y * mm)
        t.textOut(s)
        self.c.drawText(t)

    def cell(
        self,
        s: str,
        x0: float,
        x1: float,
        yb: float,
        yt: float,
        size: float,
        align: str = "c",
    ) -> None:
        pad = 0.8
        size = min(size, (yt - yb) - 1.0)
        y = yb + (yt - yb - size) / 2
        x = {"l": x0 + pad, "c": (x0 + x1) / 2, "r": x1 - pad}[align]
        self.text(s, x, y, size, align, maxw=(x1 - x0) - 2 * pad)

    def lines(
        self,
        rows: list[str],
        x0: float,
        x1: float,
        yb: float,
        yt: float,
        size: float,
        align: str = "l",
        pitch: float = 1.5,
    ) -> None:
        """Несколько строк, отцентрованных по вертикали в ячейке."""
        n = len(rows)
        block = size + (n - 1) * size * pitch
        y = yt - (yt - yb - block) / 2 - size
        pad = 1.0
        x = {"l": x0 + pad, "c": (x0 + x1) / 2, "r": x1 - pad}[align]
        for r in rows:
            self.text(r, x, y, size, align, maxw=(x1 - x0) - 2 * pad)
            y -= size * pitch

    def rotated(self, s: str, x: float, y: float, size: float) -> None:
        font = self._font_for(s)
        self.c.saveState()
        self.c.translate(x * mm, y * mm)
        self.c.rotate(90)
        self.c.setFont(font, size / CAP * mm)
        self.c.drawCentredString(0, 0, s)
        self.c.restoreState()

    def signature(
        self, rng: random.Random, x0: float, x1: float, yb: float, yt: float
    ) -> None:
        """Росчерк подписи — кривые, без текста."""
        self.c.setLineWidth(0.15 * mm)
        p = self.c.beginPath()
        x, y = x0 + 1.5, yb + (yt - yb) * rng.uniform(0.3, 0.6)
        p.moveTo(x * mm, y * mm)
        for _ in range(rng.randint(2, 4)):
            nx = min(x + rng.uniform(2, 5), x1 - 1)
            ny = yb + (yt - yb) * rng.uniform(0.2, 0.85)
            p.curveTo(
                (x + 1) * mm,
                (yt - 0.5) * mm,
                (nx - 1) * mm,
                (yb + 0.5) * mm,
                nx * mm,
                ny * mm,
            )
            x, y = nx, ny
        self.c.drawPath(p, stroke=1, fill=0)


VOWELS = set("аеёиоуыэюяАЕЁИОУЫЭЮЯ")


def wrap(
    text: str, font: str, size: float, maxw: float, hyphen: bool = False
) -> list[str]:
    """Жадный перенос по словам; hyphen — ломать длинные слова по слогу с дефисом («застрой-ки»)."""
    words = text.split()
    out: list[str] = []
    cur = ""
    i = 0
    while i < len(words):
        w = words[i]
        cand = f"{cur} {w}" if cur else w
        if sw(cand, font, size) <= maxw:
            cur, i = cand, i + 1
            continue
        if hyphen and len(w) >= 7 and "-" not in w:
            for k in range(len(w) - 3, 2, -1):
                if w[k - 1] in VOWELS and w[k] not in "ьъйЬЪЙ" and w[k].isalpha():
                    piece = (f"{cur} " if cur else "") + w[:k] + "-"
                    if sw(piece, font, size) <= maxw:
                        out.append(piece)
                        words[i] = w[k:]
                        cur = ""
                        break
            else:
                k = 0
            if k:
                continue
        if cur:
            out.append(cur)
            cur = ""
            continue
        out.append(w)  # слово длиннее ячейки — печатаем как есть (Pen сожмёт)
        i += 1
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Штампы
# ---------------------------------------------------------------------------------------------------------------------

FORMATS = {  # имя: (ширина, высота) мм, как лист лежит
    "А4": (210, 297),
    "А3": (420, 297),
    "А2": (594, 420),
    "А1": (841, 594),
    "А4х3": (630, 297),
}
LBL = {
    "izm": ["Изм.", "Изм.", "Изм"],
    "kol": ["Кол.уч.", "Кол. уч", "Кол.уч", "Кол.уч."],
    "list": ["Лист", "Лист", "Лист."],
    "doc": ["№ док.", "№док", "№ док.", "№ докум."],
    "podp": ["Подп.", "Подп.", "Подп"],
    "date": ["Дата", "Дата"],
    "stage": ["Стадия", "Стадия", "Стад."],
    "sheet": ["Лист", "Лист"],
    "sheets": ["Листов", "Листов", "Листов."],
}
ROLES = [
    ["Разраб."],
    ["Пров.", "Проверил"],
    ["ГИП", "ГАП"],
    ["Н. контр.", "Н.контр.", "Н.контр"],
    ["Нач. отд.", "Нач.отд."],
    ["Утв."],
]
SURNAMES = [
    "Иванов",
    "Петрова",
    "Сидоров",
    "Гарипов",
    "Хабибуллина",
    "Смирнов",
    "Кузнецова",
    "Валиев",
    "Фёдоров",
    "Морозова",
    "Ахметов",
    "Лебедева",
    "Шарипов",
    "Орлова",
]
ORGS = [
    "ООО «Проект-Альфа»",
    "АО «ГорПроектБюро»",
    "ООО «Архитектурная мастерская Линия»",
    "ООО «ИнжПроектГрупп»",
    "ООО «Энскпроект»",
    "АО «НИИ Проектсинтез»",
]
CITIES = ["г. Энск", "г. Н-ск", "пгт Заречный", "г. Верхнеозёрск"]
STREETS = ["Садовая", "Лесная", "Заводская", "Молодёжная", "Речная", "Строителей"]
OBJECTS = [
    "Многоквартирный жилой дом со встроенными нежилыми помещениями по ул. {st}, {n} в {city}",
    "Жилой комплекс «Северный квартал». {k}-й этап строительства",
    "Общеобразовательная школа на {n0} мест в {city}",
    "Детский сад на {n1} мест по ул. {st} в {city}",
    "Многоэтажная жилая застройка микрорайона № {k} в {city}. Жилой дом поз. {k}",
    "Административное здание с подземной автостоянкой",
]
BUILDINGS = [
    "Жилой дом поз. {k}",
    "Секция {k}",
    "Здание школы",
    "Корпус {k}",
    "Подземная автостоянка",
    "",
]
DRAWINGS = [
    "План 1 этажа на отм. 0.000",
    "Фасад в осях 1-{k}",
    "Разрез 1-1",
    "План кровли",
    "Схема расположения элементов каркаса",
    "План типового этажа",
    "Узлы 1-{k}",
    "Общие данные",
]
MARKS = [
    "АР",
    "КР",
    "КЖ",
    "КМ",
    "ОВ",
    "ВК",
    "ЭОМ",
    "ГП",
    "ТХ",
    "ПЗ",
    "ПОС",
    "ООС",
    "ПБ",
    "АС",
    "ЭС",
    "СС",
]
LATIN_TWINS = {
    "А": "A",
    "В": "B",
    "Е": "E",
    "К": "K",
    "М": "M",
    "Н": "H",
    "О": "O",
    "Р": "P",
    "С": "C",
    "Т": "T",
    "Х": "X",
}


def _code(rng: random.Random, revision: int | None) -> str:
    mark = rng.choice(MARKS)
    yy = rng.randint(19, 26)
    pat = rng.randint(0, 6)
    if pat == 0:
        code = f"{rng.randint(100, 9999)}-20{yy}-{mark}"
    elif pat == 1:
        code = f"ПД-{rng.randint(1, 60)}/{yy}-{mark}{rng.randint(1, 3)}.{rng.randint(1, 4)}"
    elif pat == 2:
        code = f"РД.{rng.randint(1, 999):03d}-{mark}{rng.randint(1, 3)}.{rng.randint(1, 3)}"
    elif pat == 3:
        code = f"{rng.randint(1, 12):02d}/{yy}-П-ИОС{rng.randint(1, 5)}.{rng.randint(1, 7)}.{rng.randint(1, 3)}"
    elif pat == 4:
        code = f"{rng.randint(1, 450):03d}.{yy}-{rng.randint(1, 30):02d}-{mark}"
    elif pat == 5:
        code = f"{rng.choice(['СП', 'ГП', 'ПР', 'ТЗ'])}-{rng.randint(1, 9999):04d}-{yy}-{mark}"
    else:
        code = f"{rng.randint(10, 99)}.{rng.randint(1, 99):02d}-20{yy}-{mark}{rng.randint(1, 4)}"
    r = rng.random()
    if r < 0.15:
        code += f".{rng.randint(1, 9)}"  # суффикс листа/части
    elif r < 0.25 and revision:
        code += rng.choice(["-Изм.", ".Изм", "-Изм"]) + str(revision)
    if (
        rng.random() < 0.15
    ):  # латинские двойники вместо кириллицы (набрано в чужой раскладке)
        chars = list(code)
        idx = [i for i, ch in enumerate(chars) if ch in LATIN_TWINS]
        for i in rng.sample(idx, k=min(len(idx), rng.randint(1, 2))):
            chars[i] = LATIN_TWINS[chars[i]]
        code = "".join(chars)
    return code


def _date(rng: random.Random, yy: int, mo: int) -> str:
    return f"{mo:02d}.{yy:02d}" if rng.random() < 0.7 else f"{mo:02d}.20{yy:02d}"


def _changes(rng: random.Random, n: int, sheet: str) -> list[dict]:
    """Изменения по возрастанию номера (порядок заполнения снизу вверх)."""
    start = rng.choice([1, 1, 1, 2, 3])
    yy, mo = rng.randint(22, 25), rng.randint(1, 12)
    long_date = rng.random() < 0.3
    out = []
    for k in range(n):
        mo += rng.randint(1, 4)
        if mo > 12:
            yy, mo = yy + 1, mo - 12
        date = f"{mo:02d}.20{yy:02d}" if long_date else f"{mo:02d}.{yy:02d}"
        kol = rng.choice(["1", "2", "3", "-", "Зам.", "Нов.", "Аннул.", "1"])
        sh = rng.choice([sheet, sheet, "-", str(rng.randint(1, 20))])
        dn = rng.choice(
            [
                f"{rng.randint(1, 350)}-{yy:02d}",
                f"{rng.randint(1, 99)}/{yy:02d}",
                f"{rng.randint(1, 99):02d}-20{yy:02d}",
            ]
        )
        out.append(
            {
                "izm": str(start + k),
                "kol_uch": kol,
                "sheet": sh,
                "doc_no": dn,
                "date": date,
            }
        )
    return out


@dataclass
class Stamp:
    form: int
    code: str
    customer: str | None
    customer_inline: bool
    stage: str | None
    sheet: str
    sheets: int | None
    changes: list[dict]  # по возрастанию номера
    labels: dict[str, str] | None  # None — графы без подписей
    roles: list[tuple[str, str, str]]
    obj: str
    bld: str
    dwg: str
    org: str
    size_lbl: float
    size_val: float
    size_code: float
    sign_rng_seed: int = 0


def make_stamp(rng: random.Random, form: int) -> Stamp:
    cap = {3: 3, 5: 1, 6: 2}[form]
    n = rng.choice(list(range(cap + 1)) + [0])
    sheet = rng.choice(
        [str(rng.randint(1, 30))] * 4
        + [f"{rng.randint(1, 9)}а", f"{rng.randint(1, 5)}.{rng.randint(1, 5)}"]
    )
    if form == 5:
        sheet = rng.choice(["1", "2", "3"])
    changes = _changes(rng, n, sheet)
    revision = max(int(c["izm"]) for c in changes) if changes else None
    labels = None if rng.random() < 0.2 else {k: rng.choice(v) for k, v in LBL.items()}
    roles = []
    for opts in rng.sample(ROLES[:5], k=rng.randint(3, 5)) if form != 6 else []:
        yy = rng.randint(23, 25)
        roles.append(
            (
                rng.choice(opts),
                rng.choice(SURNAMES),
                _date(rng, yy, rng.randint(1, 12)) if rng.random() < 0.8 else "",
            )
        )
    k = rng.randint(2, 12)
    fmt = dict(
        st=rng.choice(STREETS),
        n=rng.randint(1, 120),
        city=rng.choice(CITIES),
        k=k,
        n0=rng.choice([550, 825, 1100]),
        n1=rng.choice([140, 220, 280]),
    )
    sheets = None
    if form != 6 and rng.random() < 0.8:
        base = int("".join(ch for ch in sheet.split(".")[0] if ch.isdigit()) or 1)
        sheets = base + rng.randint(0, 25)
    has_cust = rng.random() < 0.15
    return Stamp(
        form=form,
        code=_code(rng, revision),
        customer=f"Заказчик: {rng.choice(['ГКУ «Управление капстроительства»', 'ООО «СЗ Северный»', 'АО «Энскстрой»'])}"
        if has_cust
        else None,
        customer_inline=rng.random() < 0.5,
        stage=None if form == 6 else rng.choice(["П", "Р"]),
        sheet=sheet,
        sheets=sheets,
        changes=changes,
        labels=labels,
        roles=roles,
        obj=rng.choice(OBJECTS).format(**fmt),
        bld=rng.choice(BUILDINGS).format(**fmt),
        dwg=rng.choice(DRAWINGS).format(**fmt),
        org=rng.choice(ORGS),
        size_lbl=rng.uniform(1.8, 2.5),
        size_val=rng.uniform(1.8, 3.0),
        size_code=rng.uniform(2.8, 5.0),
        sign_rng_seed=rng.randint(0, 10**9),
    )


def _change_table(
    pen: Pen, s: Stamp, x0: float, top: float, slots: int, rng: random.Random
) -> None:
    """Столбцы 10/10/10/10/15/10 мм; строки изменений над шапкой, заполнение снизу вверх."""
    xs = [x0, x0 + 10, x0 + 20, x0 + 30, x0 + 40, x0 + 55, x0 + 65]
    hdr_top = top - 5 * slots
    for j in range(1, 6):
        pen.line(xs[j], top, xs[j], hdr_top - 5)
    for i in range(1, slots + 1):
        pen.line(x0, top - 5 * i, x0 + 65, top - 5 * i, THICK if i == slots else THIN)
    pen.line(x0, hdr_top - 5, x0 + 65, hdr_top - 5, THICK)
    if s.labels:
        for j, key in enumerate(["izm", "kol", "list", "doc", "podp", "date"]):
            pen.cell(s.labels[key], xs[j], xs[j + 1], hdr_top - 5, hdr_top, s.size_lbl)
    for k, ch in enumerate(s.changes):  # k=0 — первое изменение, строка над шапкой
        yt = hdr_top + 5 * k + 5
        yb = yt - 5
        for j, key in enumerate(["izm", "kol_uch", "sheet", "doc_no"]):
            pen.cell(ch[key], xs[j], xs[j + 1], yb, yt, s.size_val)
        pen.signature(rng, xs[4], xs[5], yb, yt)
        pen.cell(ch["date"], xs[5], xs[6], yb, yt, s.size_val)


def _roles(
    pen: Pen, s: Stamp, x0: float, top: float, rows: int, rng: random.Random
) -> None:
    for i in range(rows):
        yt = top - 5 * i
        yb = yt - 5
        if i:
            pen.line(x0, yt, x0 + 65, yt)
        if i < len(s.roles):
            role, name, date = s.roles[i]
            if s.labels:
                pen.cell(role, x0, x0 + 20, yb, yt, s.size_lbl, "l")
            pen.cell(name, x0 + 20, x0 + 40, yb, yt, s.size_val, "l")
            pen.signature(rng, x0 + 40, x0 + 55, yb, yt)
            pen.cell(date, x0 + 55, x0 + 65, yb, yt, s.size_val)
    for dx in (20, 40, 55):
        pen.line(x0 + dx, top, x0 + dx, top - 5 * rows)


def _code_cell(pen: Pen, s: Stamp, x0: float, x1: float, yb: float, yt: float) -> None:
    if s.customer and s.customer_inline:
        pen.cell(f"{s.code}    {s.customer}", x0, x1, yb, yt, min(s.size_code, 3.5))
    elif s.customer:
        mid = yb + (yt - yb) * 0.42
        pen.cell(s.code, x0, x1, mid, yt, s.size_code)
        pen.cell(s.customer, x0, x1, yb, mid, 1.8, "l")
    else:
        pen.cell(s.code, x0, x1, yb, yt, s.size_code)


def _stage_block(
    pen: Pen, s: Stamp, x0: float, yt: float, hdr_h: float, val_h: float
) -> None:
    """Стадия 15 | Лист 15 | Листов 20."""
    xs = [x0, x0 + 15, x0 + 30, x0 + 50]
    ym = yt - hdr_h
    yb = ym - val_h
    pen.line(x0, ym, x0 + 50, ym)
    for x in xs[1:3]:
        pen.line(x, yt, x, yb)
    if s.labels:
        for j, key in enumerate(["stage", "sheet", "sheets"]):
            pen.cell(s.labels[key], xs[j], xs[j + 1], ym, yt, s.size_lbl)
    size = min(s.size_val + 0.5, 3.5)
    pen.cell(s.stage or "", xs[0], xs[1], yb, ym, size)
    pen.cell(s.sheet, xs[1], xs[2], yb, ym, size)
    pen.cell("" if s.sheets is None else str(s.sheets), xs[2], xs[3], yb, ym, size)


def draw_stamp(pen: Pen, s: Stamp, x0: float, y0: float, rng: random.Random) -> None:
    h = {3: 55, 5: 40, 6: 15}[s.form]
    top = y0 + h
    xr = x0 + 65
    pen.rect(x0, y0, 185, h)
    pen.line(xr, y0, xr, top, THICK)
    wrapped_obj = wrap(s.obj, pen.font, s.size_val + 0.3, 116)[:3]
    if s.form == 3:
        _change_table(pen, s, x0, top, 5, rng)
        _roles(pen, s, x0, top - 30, 5, rng)
        for yy in (top - 10, top - 25, top - 40):
            pen.line(xr, yy, x0 + 185, yy, THICK)
        pen.line(x0 + 135, top - 25, x0 + 135, y0, THICK)
        _code_cell(pen, s, xr, x0 + 185, top - 10, top)
        pen.lines(wrapped_obj, xr, x0 + 185, top - 25, top - 10, s.size_val + 0.3, "c")
        pen.lines(
            wrap(s.bld, pen.font, s.size_val, 66)[:2],
            xr,
            x0 + 135,
            top - 40,
            top - 25,
            s.size_val,
            "c",
        )
        _stage_block(pen, s, x0 + 135, top - 25, 5, 10)
        pen.lines(
            wrap(s.dwg, pen.font, s.size_val, 66)[:3],
            xr,
            x0 + 135,
            y0,
            top - 40,
            s.size_val,
            "c",
        )
        pen.lines(
            wrap(s.org, pen.font, s.size_val, 46)[:3],
            x0 + 135,
            x0 + 185,
            y0,
            top - 40,
            s.size_val,
            "c",
        )
    elif s.form == 5:
        _change_table(pen, s, x0, top, 2, rng)
        _roles(pen, s, x0, top - 15, 5, rng)
        pen.line(xr, top - 15, x0 + 185, top - 15, THICK)
        pen.line(x0 + 135, top - 15, x0 + 135, y0, THICK)
        pen.line(x0 + 135, top - 25, x0 + 185, top - 25, THICK)
        _code_cell(pen, s, xr, x0 + 185, top - 15, top)
        name = f"{s.obj}. {s.dwg}" if s.bld == "" else f"{s.bld}. {s.dwg}"
        pen.lines(
            wrap(name, pen.font, s.size_val + 0.3, 66)[:4],
            xr,
            x0 + 135,
            y0,
            top - 15,
            s.size_val + 0.3,
            "c",
        )
        _stage_block(pen, s, x0 + 135, top - 15, 5, 5)
        pen.lines(
            wrap(s.org, pen.font, s.size_val, 46)[:3],
            x0 + 135,
            x0 + 185,
            y0,
            top - 25,
            s.size_val,
            "c",
        )
    else:
        _change_table(pen, s, x0, top, 2, rng)
        pen.line(x0 + 175, top, x0 + 175, y0, THICK)
        pen.line(x0 + 175, top - 7, x0 + 185, top - 7)
        _code_cell(pen, s, xr, x0 + 175, y0, top)
        if s.labels:
            pen.cell(s.labels["sheet"], x0 + 175, x0 + 185, top - 7, top, s.size_lbl)
        pen.cell(s.sheet, x0 + 175, x0 + 185, y0, top - 7, min(s.size_val + 0.5, 3.5))


def _frame(pen: Pen, W: float, H: float) -> None:
    pen.rect(20, 5, W - 25, H - 10)


def _left_strip(pen: Pen, rng: random.Random) -> None:
    """Дополнительные графы на поле подшивки: «Инв. № подл.», «Подп. и дата», «Взам. инв. №»."""
    y = 5.0
    for label, hgt in (
        ("Инв. № подл.", 25),
        ("Подп. и дата", 35),
        ("Взам. инв. №", 25),
    ):
        pen.rect(8, y, 12, hgt, THIN)
        pen.line(13, y, 13, y + hgt)
        pen.rotated(label, 11.6, y + hgt / 2, 1.8)
        if rng.random() < 0.6:
            pen.rotated(
                str(rng.randint(1000, 99999)) if "Инв" in label else "",
                17.5,
                y + hgt / 2,
                2.2,
            )
        y += hgt


def _drawing_noise(
    pen: Pen, rng: random.Random, x0: float, y0: float, x1: float, y1: float
) -> None:
    """Условный чертёж: оси с марками, размеры, отметки, марки помещений."""
    if x1 - x0 < 60 or y1 - y0 < 60:
        return
    nx, ny = rng.randint(3, 7), rng.randint(2, 5)
    step_x, step_y = (x1 - x0 - 30) / nx, (y1 - y0 - 30) / ny
    for i in range(nx + 1):
        x = x0 + 20 + i * step_x
        pen.line(x, y0 + 10, x, y1 - 12)
        pen.c.circle(x * mm, (y1 - 8) * mm, 4 * mm, stroke=1, fill=0)
        pen.text(str(i + 1), x, y1 - 9.2, 2.5, "c")
        if i < nx:
            pen.text(
                str(rng.choice([3000, 3300, 4200, 6000, 7200])),
                x + step_x / 2,
                y1 - 16,
                2.2,
                "c",
            )
    for j in range(ny + 1):
        y = y0 + 12 + j * step_y
        pen.line(x0 + 12, y, x1 - 5, y)
        pen.c.circle((x0 + 8) * mm, y * mm, 4 * mm, stroke=1, fill=0)
        pen.text("АБВГДЕЖИК"[j], x0 + 8, y - 1.2, 2.5, "c")
    for _ in range(rng.randint(2, 6)):
        x = rng.uniform(x0 + 25, x1 - 30)
        y = rng.uniform(y0 + 20, y1 - 25)
        pen.text(f"{rng.randint(1, 3)}{rng.randint(1, 20):02d}", x, y + 4, 2.5)
        pen.text(f"{rng.uniform(2, 40):.2f}".replace(".", ","), x, y, 2.2)
    pen.text(
        f"+{rng.choice(['3,000', '6,300', '0,000', '9,600'])}", x0 + 15, y0 + 4, 2.5
    )


def _text_noise(
    pen: Pen, rng: random.Random, x0: float, y0: float, x1: float, y1: float
) -> None:
    sents = [
        "Проектная документация разработана в соответствии с заданием на проектирование.",
        "Класс функциональной пожарной опасности здания — Ф1.3, степень огнестойкости — II.",
        "Уровень ответственности здания — нормальный, коэффициент надёжности 1,0.",
        "За относительную отметку 0,000 принят уровень чистого пола первого этажа.",
        "Расчётная снеговая нагрузка для III района составляет 1,5 кПа.",
        "Наружные стены — газобетонные блоки толщиной 300 мм с утеплением 150 мм.",
        "Высота помещений жилых этажей в чистоте — 2,70 м.",
    ]
    y = y1 - 10
    size = rng.uniform(2.2, 3.0)
    while y > y0 + 5:
        for ln in wrap(
            rng.choice(sents) + " " + rng.choice(sents), pen.font, size, x1 - x0 - 10
        ):
            if y <= y0 + 5:
                break
            pen.text(ln, x0 + 5, y, size)
            y -= size * 2
        y -= size


def render_sheet(path: Path, rng: random.Random) -> dict:
    form = rng.choice([3, 3, 3, 5, 5, 6, 6])
    if form == 3:
        fmt = rng.choice(["А4", "А3", "А3", "А2", "А1", "А4х3"])
    else:
        fmt = rng.choice(["А4", "А4", "А4", "А3"])
    W, H = FORMATS[fmt]
    s = make_stamp(rng, form)
    c = canvas.Canvas(str(path), pagesize=(W * mm, H * mm), invariant=1)
    font = rng.choice(["Noto", "Noto", "Onest"])
    pen = Pen(c, font, rng.choice([0.0, 0.0, 0.268]))
    _frame(pen, W, H)
    x0, y0 = W - 5 - 185, 5.0
    sh = {3: 55, 5: 40, 6: 15}[form]
    if rng.random() < 0.5:
        _left_strip(pen, rng)
    if form == 3:
        _drawing_noise(pen, rng, 22, y0 + sh + 5, W - 8, H - 8)
    else:
        _text_noise(pen, rng, 22, y0 + sh + 3, W - 8, H - 8)
    draw_stamp(pen, s, x0, y0, random.Random(s.sign_rng_seed))
    if rng.random() < 0.6:
        pen.text(f"Формат {fmt}", W - 5, 1.5, 2.0, "r")
        pen.text("Копировал", W - 60, 1.5, 2.0, "r")
    c.showPage()
    c.save()
    changes_top_down = list(reversed(s.changes))
    return {
        "file": path.name,
        "page": 1,
        "form": form,
        "code": s.code,
        "stage": s.stage,
        "sheet": s.sheet,
        "sheets": s.sheets,
        "revision": max(int(ch["izm"]) for ch in s.changes) if s.changes else None,
        "changes": [dict(ch) for ch in changes_top_down],
    }


# ---------------------------------------------------------------------------------------------------------------------
# Таблицы
# ---------------------------------------------------------------------------------------------------------------------

UNIT_PRINT = {
    "м²": [["м²"], ["м2"], ["кв.м"]],
    "м³": [["м³"], ["м3"], ["куб.м"]],
    "м": [["м"]],
    "шт": [["шт."], ["шт"]],
    "эт": [["эт."], ["этаж"]],
    "%": [["%"]],
    "чел": [["чел."], ["чел"]],
    "га": [["га"]],
    "кВт": [["кВт"]],
    "тысруб": [["тыс.руб."], ["тыс. руб."]],
}

# (наименование, единица, (мин, макс), знаков после запятой, делится на надземную/подземную, аддитивный, группа)
TEP_CATALOG = [
    ("Площадь участка", "га", (0.3, 4.5), 2, False, True, "land"),
    ("Площадь застройки", "м²", (400, 3500), 1, False, True, "land"),
    ("Коэффициент застройки", None, (0.15, 0.6), 2, False, False, "land"),
    (
        "Коэффициент интенсивности использования территории",
        None,
        (0.8, 3.5),
        2,
        False,
        False,
        "land",
    ),
    ("Процент озеленения", "%", (10, 40), 0, False, False, "land"),
    ("Общая площадь здания", "м²", (3000, 45000), 1, True, True, "bld"),
    (
        "Площадь квартир (без учёта летних помещений)",
        "м²",
        (2000, 30000),
        1,
        False,
        True,
        "bld",
    ),
    ("Общая площадь квартир", "м²", (2200, 32000), 1, False, True, "bld"),
    ("Жилая площадь квартир", "м²", (1000, 15000), 1, False, True, "bld"),
    ("Площадь встроенных нежилых помещений", "м²", (100, 1500), 1, False, True, "bld"),
    ("Строительный объём", "м³", (10000, 150000), 1, True, True, "bld"),
    ("Этажность", "эт", (3, 25), 0, False, False, "bld"),
    ("Количество этажей", "эт", (4, 27), 0, False, False, "bld"),
    ("Высота здания", "м", (10, 80), 1, False, False, "bld"),
    ("Количество квартир", "шт", (20, 400), 0, False, True, "bld"),
    ("Количество машино-мест", "шт", (10, 250), 0, False, True, "bld"),
    ("Количество жителей", "чел", (40, 900), 0, False, True, "bld"),
    ("Расчётная электрическая нагрузка", "кВт", (100, 900), 1, False, True, "bld"),
    (
        "Сметная стоимость строительства",
        "тысруб",
        (150000, 2500000),
        2,
        False,
        True,
        "bld",
    ),
]

EXPL_ROOMS = [
    "Тамбур",
    "Вестибюль",
    "Лестничная клетка",
    "Коридор",
    "Помещение уборочного инвентаря",
    "Электрощитовая",
    "Индивидуальный тепловой пункт",
    "Помещение охраны",
    "Санузел для маломобильных групп населения",
    "Офисное помещение",
    "Колясочная",
    "Мусорокамера",
    "Водомерный узел",
    "Насосная станция пожаротушения",
    "Техническое помещение",
    "Помещение для хранения велосипедов и детских колясок",
    "Лифтовой холл",
    "Кладовая",
    "Комната персонала",
    "Торговый зал",
    "Серверная",
]
FLAT_ROOMS = [
    ("Прихожая", False),
    ("Жилая комната", True),
    ("Кухня", False),
    ("Кухня-столовая", False),
    ("Санузел", False),
    ("Ванная", False),
    ("Гардеробная", False),
    ("Жилая комната", True),
    ("Кладовая", False),
]
CATEGORIES = ["В4", "Д", "В3", "В2", "—", "В4", "Д"]


def fmt_num(v: float, dec: int, thou: str) -> str:
    s = f"{v:,.{dec}f}"
    ip, _, frac = s.partition(".")
    ip = ip.replace(",", thou)
    return f"{ip},{frac}" if dec else ip


def num_value(v: float, dec: int) -> float | int:
    return int(round(v)) if dec == 0 else round(v, dec)


@dataclass
class HCell:
    c0: int
    c1: int  # не включительно
    r0: int
    r1: int
    text: str


@dataclass
class BRow:
    kind: str  # data | section | total
    cells: list[str]
    gold: dict | None = None


@dataclass
class TableSpec:
    title: str
    widths: list[float]
    aligns: list[str]
    name_col: int
    header: list[HCell]
    n_hdr: int
    numbering: bool
    rows: list[BRow]
    kind: str
    value_columns: list[str]
    note: str | None = None
    style: dict = field(default_factory=dict)


def _pick_unit_print(rng: random.Random, font: str) -> dict[str, str]:
    out = {}
    for canon, variants in UNIT_PRINT.items():
        opts = [v[0] for v in variants if has_glyphs(font, v[0])] or [variants[-1][0]]
        out[canon] = rng.choice(opts)
    return out


def make_tep(rng: random.Random, font: str, max_rows: int) -> TableSpec:
    up = _pick_unit_print(rng, font)
    thou = rng.choice([" ", " ", "", " "])
    null_mark = rng.choice(["—", "-", ""])
    vc_mode = rng.choice(["one", "one", "split3", "split2", "stages"])
    if vc_mode == "one":
        vcols = [rng.choice(["Значение", "По проекту", "Количество"])]
    elif vc_mode == "split3":
        vcols = rng.choice(
            [
                ["Всего", "В т.ч. надземная часть", "Подземная часть"],
                ["Всего", "Надземная часть", "Подземная часть"],
            ]
        )
    elif vc_mode == "split2":
        vcols = ["Всего", "В т.ч. надземная часть"]
    else:
        vcols = ["Этап 1", "Этап 2", "Всего"]
    unit_mode = rng.choice(["column", "column", "tail"])
    sections = rng.random() < 0.3
    sub_rows = vc_mode == "one" and rng.random() < 0.5
    catalog = [e for e in TEP_CATALOG if rng.random() < 0.65]
    rng.shuffle(catalog)
    catalog.sort(key=lambda e: e[6] != "land")  # участок — первым
    catalog = catalog[:max_rows]
    if vc_mode != "one" and not any(
        e[4] for e in catalog
    ):  # иначе колонки частей пусты целиком
        catalog = (
            catalog[: max(1, max_rows - 1)]
            + [e for e in TEP_CATALOG if e[4]][: 1 + (rng.random() < 0.5)]
        )

    rows: list[BRow] = []
    ncols_lead = 2 + (1 if unit_mode == "column" else 0)
    section = None
    num = 0
    for name, unit, (lo, hi), dec, splittable, additive, grp in catalog:
        if sections:
            want = (
                "Показатели земельного участка"
                if grp == "land"
                else "Показатели здания"
            )
            if want != section:
                section = want
                rows.append(BRow("section", [want]))
        if unit == "эт" and rng.random() < 0.4:
            unit = None
        num += 1
        v = rng.uniform(lo, hi)
        vals: list[float | None]
        if vc_mode in ("split3", "split2"):
            if splittable:
                below = v * rng.uniform(0.08, 0.3)
                vals = [v, v - below, below][: len(vcols)]
            else:
                vals = [v] + [None] * (len(vcols) - 1)
        elif vc_mode == "stages":
            if additive:
                a = v * rng.uniform(0.35, 0.65)
                vals = [a, v - a, v]
            else:
                vals = [v, rng.uniform(lo, hi), None]
        else:
            vals = [v]
        gvals = [None if x is None else num_value(x, dec) for x in vals]
        # сумма «всего» = сумма частей как напечатано
        if vc_mode in ("split3", "split2") and splittable and len(vcols) == 3:
            gvals[0] = num_value(gvals[1] + gvals[2], dec)
        if vc_mode == "stages" and additive:
            gvals[2] = num_value(gvals[0] + gvals[1], dec)
        printed_vals = [
            null_mark if g is None else fmt_num(g, dec, thou) for g in gvals
        ]
        uprint = up[unit] if unit else None
        pname = name + (f", {uprint}" if unit_mode == "tail" and uprint else "")
        cells = (
            [str(num), pname]
            + ([uprint or null_mark] if unit_mode == "column" else [])
            + printed_vals
        )
        rows.append(
            BRow(
                "data",
                cells,
                {
                    "name": name,
                    "unit": unit,
                    "values": gvals,
                    "total": False,
                    "section": section,
                },
            )
        )
        if sub_rows and splittable:
            below = rng.uniform(0.08, 0.3) * gvals[0]
            below_g = num_value(below, dec)
            above_g = num_value(gvals[0] - below_g, dec)
            for k, (sub, sv) in enumerate(
                (("в том числе надземной части", above_g), ("подземной части", below_g))
            ):
                pn = sub + (f", {uprint}" if unit_mode == "tail" and uprint else "")
                cells = (
                    [f"{num}.{k + 1}", pn]
                    + ([uprint] if unit_mode == "column" else [])
                    + [fmt_num(sv, dec, thou)]
                )
                rows.append(
                    BRow(
                        "data",
                        cells,
                        {
                            "name": sub,
                            "unit": unit,
                            "values": [sv],
                            "total": False,
                            "section": section,
                        },
                    )
                )

    w_num = rng.uniform(9, 13)
    w_name = rng.uniform(55, 85)
    w_unit = rng.uniform(13, 18)
    w_val = rng.uniform(18, 26)
    widths = (
        [w_num, w_name]
        + ([w_unit] if unit_mode == "column" else [])
        + [w_val] * len(vcols)
    )
    aligns = (
        ["c", "l"]
        + (["c"] if unit_mode == "column" else [])
        + [rng.choice(["c", "r"])] * len(vcols)
    )
    lead_titles = [
        rng.choice(["№ п/п", "№", "№ п.п."]),
        rng.choice(["Наименование показателя", "Наименование", "Показатель"]),
    ]
    if unit_mode == "column":
        lead_titles.append(rng.choice(["Ед. изм.", "Единица измерения", "Ед.изм."]))
    two_level = len(vcols) >= 2 and rng.random() < 0.6
    header: list[HCell] = []
    if two_level:
        for j, t in enumerate(lead_titles):
            header.append(HCell(j, j + 1, 0, 2, t))
        header.append(
            HCell(
                ncols_lead,
                ncols_lead + len(vcols),
                0,
                1,
                rng.choice(["Значение", "Показатели", "Величина"]),
            )
        )
        for k, t in enumerate(vcols):
            header.append(HCell(ncols_lead + k, ncols_lead + k + 1, 1, 2, t))
        n_hdr = 2
    else:
        for j, t in enumerate(lead_titles + vcols):
            header.append(HCell(j, j + 1, 0, 1, t))
        n_hdr = 1
    title = rng.choice(
        [
            "Технико-экономические показатели",
            "Основные технико-экономические показатели",
            "Таблица 1 – Технико-экономические показатели объекта",
            "ТЕХНИКО-ЭКОНОМИЧЕСКИЕ ПОКАЗАТЕЛИ",
        ]
    )
    return TableSpec(
        title=title,
        widths=widths,
        aligns=aligns,
        name_col=1,
        header=header,
        n_hdr=n_hdr,
        numbering=rng.random() < 0.35,
        rows=rows,
        kind="tep",
        value_columns=list(vcols),
        note="Примечание: площади приведены в соответствии с приказом Минстроя."
        if rng.random() < 0.3
        else None,
    )


def make_explication(rng: random.Random, font: str, max_rows: int) -> TableSpec:
    thou = rng.choice([" ", ""])
    area_hdr = rng.choice(
        [
            h
            for h in ["Площадь, м²", "Площадь, м2", "Площадь (м²)", "Площадь, кв.м"]
            if has_glyphs(font, h)
        ]
    )
    flats = rng.random() < 0.3
    with_cat = not flats and rng.random() < 0.5
    null_mark = rng.choice(["—", ""])
    num_style = rng.choice(["101", "1.01", "1-01", "seq"])
    if flats:
        sec_names = [f"Квартира {i}" for i in range(1, rng.randint(2, 4) + 1)]
        vcols = [rng.choice(["общая", "Общая"]), rng.choice(["жилая", "Жилая"])]
    else:
        pool = rng.choice(
            [
                ["Подвал", "1 этаж", "2 этаж", "3 этаж"],
                ["Секция 1", "Секция 2", "Секция 3"],
                ["Техническое подполье", "1 этаж", "Типовой этаж"],
                ["1 этаж", "2 этаж"],
            ]
        )
        sec_names = pool[: rng.randint(1, len(pool))]
        vcols = [area_hdr]
    floor_totals = rng.random() < 0.7
    grand_total = rng.random() < 0.7
    total_name = (
        rng.choice(["Итого по этажу", "Итого", "Итого по секции"])
        if not flats
        else "Итого по квартире"
    )
    rows: list[BRow] = []
    ncol = 2 + len(vcols) + (1 if with_cat else 0)
    budget = max_rows
    grand = [0.0] * len(vcols)
    seq = 0
    for si, sec in enumerate(sec_names):
        if budget < 3:
            break
        rows.append(BRow("section", [sec]))
        budget -= 1
        n = min(rng.randint(3, 8), budget - (1 if floor_totals else 0))
        sums = [0.0] * len(vcols)
        for k in range(n):
            seq += 1
            if flats:
                name, living = FLAT_ROOMS[k % len(FLAT_ROOMS)]
                lo, hi = (
                    (10.0, 22.0)
                    if living
                    else ((6.0, 16.0) if name.startswith("Кухня") else (2.5, 9.0))
                )
                area = round(rng.uniform(lo, hi), 1)
                vals = [area, area if living else None]
            else:
                name = rng.choice(EXPL_ROOMS)
                area = round(rng.uniform(1.5, 65.0), 1)
                vals = [area]
            for j, v in enumerate(vals):
                if v is not None:
                    sums[j] += v
            num = {
                "101": f"{si + 1}{k + 1:02d}",
                "1.01": f"{si + 1}.{k + 1:02d}",
                "1-01": f"{si + 1}-{k + 1:02d}",
                "seq": str(seq),
            }[num_style]
            cat = rng.choice(CATEGORIES) if with_cat else None
            cells = [num, name] + [
                null_mark if v is None else fmt_num(v, 1, thou) for v in vals
            ]
            if with_cat:
                cells.append(cat or "")
            rows.append(
                BRow(
                    "data",
                    cells,
                    {
                        "name": name,
                        "unit": "м²",
                        "values": vals,
                        "total": False,
                        "section": sec,
                        "category": None if cat in (None, "—") else cat,
                    },
                )
            )
        budget -= n
        sums = [round(x, 1) for x in sums]
        for j in range(len(vcols)):
            grand[j] += sums[j]
        if floor_totals and len(sec_names) > 1:
            vals = [x if x else None for x in sums]
            cells = ["", total_name] + [
                null_mark if v is None else fmt_num(v, 1, thou) for v in vals
            ]
            if with_cat:
                cells.append("")
            rows.append(
                BRow(
                    "total",
                    cells,
                    {
                        "name": total_name,
                        "unit": "м²",
                        "values": vals,
                        "total": True,
                        "section": sec,
                        "category": None,
                    },
                )
            )
            budget -= 1
    if grand_total and budget >= 1:
        vals = [round(x, 1) or None for x in grand]
        gname = rng.choice(["Всего", "Всего по зданию", "Итого"])
        cells = ["", gname] + [
            null_mark if v is None else fmt_num(v, 1, thou) for v in vals
        ]
        if with_cat:
            cells.append("")
        last_sec = next(r.cells[0] for r in reversed(rows) if r.kind == "section")
        rows.append(
            BRow(
                "total",
                cells,
                {
                    "name": gname,
                    "unit": "м²",
                    "values": vals,
                    "total": True,
                    "section": last_sec,
                    "category": None,
                },
            )
        )

    w_num = rng.uniform(14, 22)
    w_name = rng.uniform(50, 85)
    w_val = rng.uniform(18, 26)
    widths = (
        [w_num, w_name]
        + [w_val] * len(vcols)
        + ([rng.uniform(16, 24)] if with_cat else [])
    )
    aligns = (
        ["c", "l"] + [rng.choice(["c", "r"])] * len(vcols) + (["c"] if with_cat else [])
    )
    t_num = rng.choice(["Номер помещения", "№ пом.", "Поз.", "Номер"])
    t_name = rng.choice(["Наименование", "Наименование помещения"])
    t_cat = rng.choice(["Кат. помещения", "Категория помещения", "Кат."])
    header: list[HCell] = []
    if flats:
        header += [
            HCell(0, 1, 0, 2, t_num),
            HCell(1, 2, 0, 2, t_name),
            HCell(2, 4, 0, 1, area_hdr),
            HCell(2, 3, 1, 2, vcols[0]),
            HCell(3, 4, 1, 2, vcols[1]),
        ]
        n_hdr = 2
    else:
        header += [
            HCell(0, 1, 0, 1, t_num),
            HCell(1, 2, 0, 1, t_name),
            HCell(2, 3, 0, 1, area_hdr),
        ]
        if with_cat:
            header.append(HCell(3, 4, 0, 1, t_cat))
        n_hdr = 1
    assert ncol == len(widths)
    title = rng.choice(
        [
            "Экспликация помещений",
            "ЭКСПЛИКАЦИЯ ПОМЕЩЕНИЙ",
            "Экспликация помещений (начало)",
            "Экспликация квартир"
            if flats
            else "Экспликация помещений подвала и 1 этажа",
        ]
    )
    return TableSpec(
        title=title,
        widths=widths,
        aligns=aligns,
        name_col=1,
        header=header,
        n_hdr=n_hdr,
        numbering=rng.random() < 0.3,
        rows=rows,
        kind="explication",
        value_columns=list(vcols),
    )


def layout_table(
    spec: TableSpec, pen: Pen | None, x: float, top: float, font: str
) -> float:
    """Рисует (pen) или только меряет (pen=None) таблицу. Возвращает высоту в мм."""
    st = spec.style
    sh, sb, pad, pitch = st["size_hdr"], st["size_body"], 1.2, 1.45
    xs = [x]
    for w in spec.widths:
        xs.append(xs[-1] + w)
    ncol = len(spec.widths)

    def need(lines_n: int, size: float) -> float:
        return (
            2 * pad + size * 1.45 + (lines_n - 1) * size * pitch
        )  # 0,45 — место под выносные элементы букв

    # шапка
    hdr_h = [st["min_hdr"]] * spec.n_hdr
    wrapped_hdr = {}
    for hc in spec.header:
        lines = wrap(hc.text, font, sh, xs[hc.c1] - xs[hc.c0] - 2 * pad)
        wrapped_hdr[id(hc)] = lines
        if hc.r1 - hc.r0 == 1:
            hdr_h[hc.r0] = max(hdr_h[hc.r0], need(len(lines), sh))
    for hc in spec.header:
        if hc.r1 - hc.r0 > 1:
            n = need(len(wrapped_hdr[id(hc)]), sh)
            have = sum(hdr_h[hc.r0 : hc.r1])
            if n > have:
                hdr_h[hc.r1 - 1] += n - have
    hdr_tops = [top]
    for h in hdr_h:
        hdr_tops.append(hdr_tops[-1] - h)
    y = hdr_tops[-1]
    num_h = st["min_hdr"] * 0.8 if spec.numbering else 0.0
    # тело
    body = []
    for r in spec.rows:
        if r.kind == "section":
            lines = [[r.cells[0]]]
            h = max(st["min_row"], need(1, sb))
        else:
            lines = []
            for j, txt in enumerate(r.cells):
                if j == spec.name_col:
                    lines.append(
                        wrap(txt, font, sb, spec.widths[j] - 2 * pad, st["hyphen"])
                    )
                else:
                    lines.append([txt])
            h = max(st["min_row"], need(max(len(ln) for ln in lines), sb))
        body.append((r, lines, h))
    total_h = sum(hdr_h) + num_h + sum(b[2] for b in body)
    if pen is None:
        return total_h

    bottom = top - total_h
    pen.rect(xs[0], bottom, xs[-1] - xs[0], total_h)
    # шапка: текст и внутренние линии
    for hc in spec.header:
        yt, yb = hdr_tops[hc.r0], hdr_tops[hc.r1]
        pen.lines(wrapped_hdr[id(hc)], xs[hc.c0], xs[hc.c1], yb, yt, sh, "c", pitch)
        if hc.c0 > 0:
            pen.line(xs[hc.c0], yt, xs[hc.c0], yb)
        if hc.r1 < spec.n_hdr:
            pen.line(xs[hc.c0], yb, xs[hc.c1], yb)
    pen.line(xs[0], y, xs[-1], y, THICK)
    if spec.numbering:
        for j in range(ncol):
            pen.cell(str(j + 1), xs[j], xs[j + 1], y - num_h, y, sb * 0.9)
            if j:
                pen.line(xs[j], y, xs[j], y - num_h)
        y -= num_h
        pen.line(xs[0], y, xs[-1], y, THICK)
    for i, (r, lines, h) in enumerate(body):
        yt, yb = y, y - h
        if r.kind == "section":
            if st["section_align"] == "c":
                pen.cell(r.cells[0], xs[0], xs[-1], yb, yt, sb, "c")
            else:
                pen.cell(r.cells[0], xs[spec.name_col], xs[-1], yb, yt, sb, "l")
        else:
            for j in range(ncol):
                if j:
                    pen.line(xs[j], yt, xs[j], yb)
                ls = lines[j]
                base = yt - pad - sb
                xpos = {
                    "l": xs[j] + pad,
                    "c": (xs[j] + xs[j + 1]) / 2,
                    "r": xs[j + 1] - pad,
                }[spec.aligns[j]]
                for ln in ls:
                    pen.text(
                        ln,
                        xpos,
                        base,
                        sb,
                        spec.aligns[j],
                        maxw=spec.widths[j] - 2 * pad,
                    )
                    base -= sb * pitch
        if i < len(body) - 1 and (
            st["grid"] or r.kind == "section" or body[i + 1][0].kind != "data"
        ):
            pen.line(xs[0], yb, xs[-1], yb)
        y = yb
    return total_h


def render_table(path: Path, seed: int) -> dict:
    rng = random.Random(seed)
    kind = rng.choice(["tep", "tep", "explication", "explication"])
    fmt = rng.choice(["А4", "А4", "А3"])
    W, H = FORMATS[fmt]
    font = rng.choice(["Noto", "Noto", "Onest"])
    slant = rng.choice([0.0, 0.0, 0.0, 0.268])
    framed = rng.random() < 0.6
    stamp = framed and rng.random() < 0.5
    style = {
        "size_hdr": rng.uniform(1.8, 2.8),
        "size_body": rng.uniform(2.0, 3.5),
        "grid": rng.random() < 0.65,
        "hyphen": rng.random() < 0.5,
        "min_hdr": rng.uniform(8, 12),
        "min_row": rng.uniform(5.5, 8.0),
        "section_align": rng.choice(["c", "l"]),
    }
    x = rng.uniform(25, 35)
    top = H - rng.uniform(22, 30)
    floor = 10 + (20 if stamp else 0)
    max_rows = rng.randint(8, 22) if kind == "tep" else rng.randint(10, 30)
    for attempt in range(12):
        sub = random.Random(seed * 31 + attempt)
        spec = (
            make_tep(sub, font, max_rows)
            if kind == "tep"
            else make_explication(sub, font, max_rows)
        )
        spec.style = style
        if sum(spec.widths) > W - x - 10:
            k = (W - x - 10) / sum(spec.widths)
            spec.widths = [w * k for w in spec.widths]
        if layout_table(spec, None, x, top, font) <= top - floor:
            break
        max_rows = max(3, int(max_rows * 0.75))
    else:  # pragma: no cover - не влезло даже в минимуме
        raise RuntimeError(f"таблица {path.name} не помещается на лист")
    c = canvas.Canvas(str(path), pagesize=(W * mm, H * mm), invariant=1)
    pen = Pen(c, font, slant)
    if framed:
        _frame(pen, W, H)
    if stamp:
        srng = random.Random(seed * 7 + 1)
        draw_stamp(pen, make_stamp(srng, 6), W - 190, 5, srng)
    pen.text(
        spec.title,
        x + sum(spec.widths) / 2 if rng.random() < 0.6 else x,
        top + 5,
        style["size_body"] + 0.5,
        "c" if rng.random() < 0.6 else "l",
    )
    h = layout_table(spec, pen, x, top, font)
    if spec.note and top - h - 8 > floor:
        pen.text(spec.note, x, top - h - 6, style["size_body"] * 0.9, maxw=W - x - 10)
    c.showPage()
    c.save()
    rows = [r.gold for r in spec.rows if r.kind != "section"]
    return {
        "file": path.name,
        "page": 1,
        "kind": spec.kind,
        "value_columns": spec.value_columns,
        "rows": rows,
    }


# ---------------------------------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------------------------------


def generate(out: Path, seed: int, sheets: int, tables: int) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    gold: dict = {"generator": GENERATOR, "seed": seed, "stamps": [], "tables": []}
    for i in range(1, sheets + 1):
        gold["stamps"].append(
            render_sheet(out / f"s{i:04d}.pdf", random.Random(seed * 1_000_003 + 2 * i))
        )
    for i in range(1, tables + 1):
        gold["tables"].append(
            render_table(out / f"t{i:04d}.pdf", seed * 1_000_003 + 2 * i + 1)
        )
    (out / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return gold


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--sheets", type=int, default=10)
    ap.add_argument("--tables", type=int, default=5)
    a = ap.parse_args(argv)
    g = generate(a.out, a.seed, a.sheets, a.tables)
    forms = {f: sum(1 for s in g["stamps"] if s["form"] == f) for f in (3, 5, 6)}
    kinds = {
        k: sum(1 for t in g["tables"] if t["kind"] == k) for k in ("tep", "explication")
    }
    nrows = sum(len(t["rows"]) for t in g["tables"])
    print(
        f"{GENERATOR} seed={a.seed}: листов {len(g['stamps'])} (формы {forms}), таблиц {len(g['tables'])} "
        f"({kinds}, строк {nrows}) → {a.out}"
    )


if __name__ == "__main__":
    main()
