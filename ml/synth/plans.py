"""Векторные планы РАЗРАБОТКИ для извлечения геометрии (T-192, ADR-0010 п. 6). Только синтетика (ADR-0002).

Набор разработки, не для приёмки: по нему пишется и отлаживается `plan_geom`, цифры качества для QA-отчёта берутся
только с отложенного состязательного набора T-195 (другой автор, свои seed ≥ 100000, другие соглашения). Здесь —
одно соглашение оформления: засечки на размерных линиях, размеры в мм натуры (на генплане — в метрах), масштаб в
штампе «Масштаб 1:N», оси штрихпунктиром с марками в кружках, стены двойной линией.

Три вида листа (`kind`):
  * ar  — план этажа АР 1:100: оси, стены с толщиной (одна противопожарная — со штриховкой), двери (разрыв стены,
          полотно и дуга), окна в наружных стенах, цепочки размеров, отметки уровня, лестница, лифтовая шахта, помещения;
  * eng — план инженерных систем 1:100 на той же подоснове: трассы воздуховода и трубопровода с подписями сечений,
          узлами (тройники, повороты), условные знаки по легенде (извещатель, оповещатель, ОЗК, кран ВПВ);
  * gp  — генплан 1:500: контур здания, проезд с шириной, машино-места обычные и МГН, газон, площадка, покрытия, легенда.

Истина (`truth`) — в миллиметрах системы осей здания (x — от оси 1 к последней цифровой, y — от оси А к последней
буквенной); на генплане — в миллиметрах участка. `sheet_from_bld` — аффинное «здание → лист, мм от левого верхнего
угла» для листа без поворота. Поворот и сдвиг листа (`rot_deg`, `dx_mm`, `dy_mm`) и /Rotate страницы (`page_rotate`)
не меняют истину в осях здания — на этом стоит property-тест.

    uv run python -m synth.plans <seed> <kind> out.pdf
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from synth.bench_drawings import FORMATS

SEEDS = range(0, 10_000)  # набор разработки; отложенный набор T-195 — seed ≥ 100000
KINDS = ("ar", "eng", "gp")
NUM_STEPS = (3000, 3300, 3600, 4200, 4800, 6000)
LET_STEPS = (4800, 5400, 6000, 6600)
AXIS_LETTERS = "АБВГДЕЖИКЛМНПРСТУФШЭЮЯ"  # ГОСТ 21.101: без Ё З Й О Х Ц Ч Щ Ъ Ы Ь
BUBBLE_R = 4.0  # радиус кружка марки оси, мм листа
TICK = 1.2  # полудлина засечки, мм листа
DIM_TEXT = 7.0  # кегль размерного числа, pt
WALL_W = 1.4  # толщина обводки стен, pt
THIN_W = 0.5  # тонкие линии, pt
FRAME = 0.05  # доля каркаса двери на сторону: полотно = проём − 2·FRAME·проём (ширина в свету)
DUCT_RGB = (0.0, 0.2, 0.8)
PIPE_RGB = (0.0, 0.55, 0.0)
SYMBOL_KINDS = {  # вид — закрытый словарь ADR-0010; «other» — знак легенды вне словаря (mark — текст строки)
    "smoke_detector": "Извещатель пожарный дымовой",
    "sounder": "Оповещатель пожарный звуковой",
    "fire_damper": "Клапан противопожарный (ОЗК)",
    "fire_hydrant_valve": "Пожарный кран ВПВ",
    "other": "Светильник аварийного освещения",
}
SITE_FILL = {
    "asphalt": ((0.72, 0.72, 0.72), "Асфальтобетонное покрытие проездов"),
    "paving": ((0.95, 0.78, 0.66), "Покрытие из тротуарной плитки"),
    "lawn": ((0.66, 0.88, 0.56), "Газон"),
    "playground": ((1.0, 0.93, 0.55), "Детская игровая площадка"),
    "building": ((0.84, 0.84, 0.95), "Проектируемое здание"),
}


def _font() -> None:
    from inspector_ml.render import FONT

    if "Noto" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("Noto", str(FONT)))


class Sheet:
    """Лист в мм. Рисование — в координатах здания (мм натуры, y вверх) через масштаб и начало листа;
    служебное (штамп, легенда) — в мм листа от левого нижнего угла. Поворот и сдвиг — у всего листа сразу."""

    def __init__(
        self,
        path: Path,
        fmt: str,
        n: float,
        origin: tuple[float, float],
        rot_deg=0.0,
        dx_mm=0.0,
        dy_mm=0.0,
    ):
        _font()
        self.w, self.h = FORMATS[fmt]
        self.n, (self.ox, self.oy) = n, origin
        self.c = canvas.Canvas(
            str(path), pagesize=(self.w * mm, self.h * mm), invariant=1
        )
        self.c.saveState()
        self.c.translate((self.w / 2 + dx_mm) * mm, (self.h / 2 - dy_mm) * mm)
        self.c.rotate(rot_deg)
        self.c.translate(-self.w / 2 * mm, -self.h / 2 * mm)

    # здание → лист (мм от левого нижнего угла) → pt
    def p(self, x: float, y: float) -> tuple[float, float]:
        return ((self.ox + x / self.n) * mm, (self.oy + y / self.n) * mm)

    def sheet_from_bld(self) -> list[float]:
        """Аффинное «здание → лист, мм от левого верхнего угла» (x' = a·x + c·y + e, y' = b·x + d·y + f), без поворота."""
        return [1 / self.n, 0.0, 0.0, -1 / self.n, self.ox, self.h - self.oy]

    def _pen(self, w: float, rgb=(0, 0, 0), dash=None) -> None:
        self.c.setLineWidth(w)
        self.c.setStrokeColorRGB(*rgb)
        if dash:
            self.c.setDash(*dash)
        else:
            self.c.setDash()

    def line(self, a, b, w=THIN_W, rgb=(0, 0, 0), dash=None, sheet=False) -> None:
        self._pen(w, rgb, dash)
        pa, pb = (self.q(*a), self.q(*b)) if sheet else (self.p(*a), self.p(*b))
        self.c.line(*pa, *pb)

    def q(self, x: float, y: float) -> tuple[float, float]:
        """Мм листа от левого нижнего угла → pt."""
        return (x * mm, y * mm)

    def poly(
        self,
        pts,
        w=THIN_W,
        rgb=(0, 0, 0),
        fill=None,
        closed=True,
        sheet=False,
        stroke=True,
    ) -> None:
        self._pen(w, rgb)
        path = self.c.beginPath()
        conv = self.q if sheet else self.p
        path.moveTo(*conv(*pts[0]))
        for x, y in pts[1:]:
            path.lineTo(*conv(x, y))
        if closed:
            path.close()
        if fill is not None:
            self.c.setFillColorRGB(*fill)
        self.c.drawPath(
            path, stroke=1 if stroke else 0, fill=1 if fill is not None else 0
        )
        self.c.setFillColorRGB(0, 0, 0)

    def circle_sheet(self, x: float, y: float, r: float, w=THIN_W) -> None:
        self._pen(w)
        self.c.circle(x * mm, y * mm, r * mm, stroke=1, fill=0)

    def arc(
        self, center, r: float, start_deg: float, extent_deg: float, w=THIN_W
    ) -> None:
        self._pen(w)
        cx, cy = self.p(*center)
        rr = r / self.n * mm
        self.c.arc(
            cx - rr, cy - rr, cx + rr, cy + rr, startAng=start_deg, extent=extent_deg
        )

    def text_sheet(
        self,
        x: float,
        y: float,
        s: str,
        size: float = DIM_TEXT,
        angle: float = 0.0,
        align: str = "c",
    ) -> None:
        """Текст: (x, y) — середина (или левый край) базовой линии в мм листа от левого нижнего угла."""
        self.c.setFillColorRGB(0, 0, 0)
        self.c.setFont("Noto", size)
        self.c.saveState()
        self.c.translate(x * mm, y * mm)
        self.c.rotate(angle)
        (self.c.drawCentredString if align == "c" else self.c.drawString)(0, 0, s)
        self.c.restoreState()

    def text(
        self, at, s: str, size: float = DIM_TEXT, angle: float = 0.0, align: str = "c"
    ) -> None:
        x, y = self.p(*at)
        self.text_sheet(x / mm, y / mm, s, size, angle, align)

    def stamp(self, title: str, n: float) -> None:
        sx, sy = self.w - 10 - 185, 10
        self.poly(
            [(sx, sy), (sx + 185, sy), (sx + 185, sy + 40), (sx, sy + 40)],
            w=1.0,
            sheet=True,
        )
        self.line((sx, sy + 20), (sx + 185, sy + 20), w=0.5, sheet=True)
        self.line((sx + 130, sy), (sx + 130, sy + 40), w=0.5, sheet=True)
        self.text_sheet(sx + 4, sy + 27, title, 9, align="l")
        self.text_sheet(
            sx + 4, sy + 7, "Объект: жилой дом, синтетика разработки", 8, align="l"
        )
        self.text_sheet(sx + 134, sy + 27, f"Масштаб 1:{n:g}", 9, align="l")
        self.text_sheet(sx + 134, sy + 7, "Лист 1", 8, align="l")
        # рамка листа
        self.poly(
            [(20, 5), (self.w - 5, 5), (self.w - 5, self.h - 5), (20, self.h - 5)],
            w=1.0,
            sheet=True,
        )

    def save(self, page_rotate: int = 0, path: Path | None = None) -> None:
        self.c.restoreState()
        self.c.showPage()
        self.c.save()
        if page_rotate and path is not None:
            import pypdfium2 as pdfium

            from inspector_ml.parse import PDFIUM_LOCK

            with PDFIUM_LOCK:
                pdf = pdfium.PdfDocument(str(path))
                pdf[0].set_rotation(page_rotate)
                tmp = path.with_suffix(".tmp")
                pdf.save(str(tmp))
                pdf.close()
            tmp.replace(path)


# ─────────────────────────────────────────────── геометрия здания


def _layout(
    r: random.Random, n_num: int | None = None, n_let: int | None = None
) -> tuple[list[int], list[int]]:
    nx = n_num or r.randint(4, 6)
    ny = n_let or r.randint(3, 4)
    xs, ys = [0], [0]
    for _ in range(nx - 1):
        xs.append(xs[-1] + r.choice(NUM_STEPS))
    for _ in range(ny - 1):
        ys.append(ys[-1] + r.choice(LET_STEPS))
    return xs, ys


def _walls(r: random.Random, xs: list[int], ys: list[int]) -> list[dict]:
    """Стены по осям: наружные — по крайним осям, внутренние — по остальным. Одна внутренняя — противопожарная."""
    t_out = r.choice((300, 380, 400))
    t_in = r.choice((200, 250))
    walls = []
    inner = [("x", i) for i in range(1, len(xs) - 1)] + [
        ("y", j) for j in range(1, len(ys) - 1)
    ]
    fire = r.choice([a for a in inner if a[0] == "x"] or inner) if inner else None  # поперёк магистрали П1 — место ОЗК
    for i, x in enumerate(xs):
        outer = i in (0, len(xs) - 1)
        t = t_out if outer else t_in
        ext = t_out / 2 if outer else 0
        walls.append({"axis": ("x", i), "a": (x, ys[0] - ext), "b": (x, ys[-1] + ext), "t": t, "outer": outer,
                      "fire": fire == ("x", i)})  # fmt: skip
    for j, y in enumerate(ys):
        outer = j in (0, len(ys) - 1)
        t = t_out if outer else t_in
        ext = t_out / 2 if outer else 0
        walls.append({"axis": ("y", j), "a": (xs[0] - ext, y), "b": (xs[-1] + ext, y), "t": t, "outer": outer,
                      "fire": fire == ("y", j)})  # fmt: skip
    return walls


def _openings(
    r: random.Random, walls: list[dict], xs: list[int], ys: list[int]
) -> None:
    """Проёмы: двери во внутренних стенах (по одной на пролёт между осями, не всегда), окна — в наружных (кроме нижней,
    где вход — дверь). Проём не ближе 600 мм к пересечению осей — у каждого куска стены есть длина."""
    for w in walls:
        w["open"] = []
        kind, idx = w["axis"]
        cross = ys if kind == "x" else xs
        along = 1 if kind == "x" else 0
        for k in range(len(cross) - 1):
            lo, hi = cross[k], cross[k + 1]
            if w["outer"]:
                if kind == "y" and idx == 0 and k == 0:
                    width = r.choice((1200, 1500))
                    typ = "door"
                elif r.random() < 0.8:
                    width = r.choice((1200, 1500, 1800))
                    typ = "window"
                else:
                    continue
            else:
                if r.random() < 0.3:
                    continue
                width = r.choice((900, 1000, 1200))
                typ = "door"
            if hi - lo < width + 2 * (900 + 200) + 100:
                continue
            c = lo + r.uniform(900 + width / 2 + 200, hi - lo - 900 - width / 2 - 200)
            w["open"].append({"kind": typ, "s": c, "width": width, "along": along})


def _pieces(w: dict) -> list[tuple[float, float]]:
    along = 1 if w["axis"][0] == "x" else 0
    s0, s1 = w["a"][along], w["b"][along]
    cuts = sorted((o["s"] - o["width"] / 2, o["s"] + o["width"] / 2) for o in w["open"])
    out, cur = [], s0
    for lo, hi in cuts:
        out.append((cur, lo))
        cur = hi
    out.append((cur, s1))
    return out


def _pt(w: dict, s: float, off: float) -> tuple[float, float]:
    """Точка стены: s — вдоль оси стены, off — поперёк (+ вправо/вверх)."""
    if w["axis"][0] == "x":
        return (w["a"][0] + off, s)
    return (s, w["a"][1] + off)


def _draw_walls(
    sh: Sheet, walls: list[dict], truth: dict, rgb=(0, 0, 0), wall_w=WALL_W
) -> None:
    for w in walls:
        t = w["t"]
        for s0, s1 in _pieces(w):
            for off in (-t / 2, t / 2):
                sh.line(_pt(w, s0, off), _pt(w, s1, off), w=wall_w, rgb=rgb)
            if w["fire"]:
                s = s0 + 150
                while s + t <= s1:
                    sh.line(_pt(w, s, -t / 2), _pt(w, s + t, t / 2), w=0.3)
                    s += 300
            truth["walls"].append(
                {
                    "a": _pt(w, s0, 0),
                    "b": _pt(w, s1, 0),
                    "thickness_mm": t,
                    "fire": w["fire"],
                }
            )
        for o in w["open"]:  # торцы кусков у проёма
            for s in (o["s"] - o["width"] / 2, o["s"] + o["width"] / 2):
                sh.line(_pt(w, s, -t / 2), _pt(w, s, t / 2), w=wall_w, rgb=rgb)


def _draw_openings(
    sh: Sheet, r: random.Random, walls: list[dict], truth: dict, marks: bool = True
) -> None:
    nd = nw = 0
    for w in walls:
        t = w["t"]
        for o in w["open"]:
            lo, hi = o["s"] - o["width"] / 2, o["s"] + o["width"] / 2
            if o["kind"] == "window":
                nw += 1
                for off in (-t / 6, t / 6):
                    sh.line(_pt(w, lo, off), _pt(w, hi, off), w=0.3)
                mark = f"ОК-{nw}" if marks else None
                side = 1 if w["axis"][1] != 0 else -1  # снаружи здания
                at = _pt(w, o["s"], side * (t / 2 + 700))
                if marks:
                    sh.text(at, mark, 6)
                truth["openings"].append({"kind": "window", "mark": mark, "width_mm": o["width"], "clear_mm": o["width"],
                                          "at": _pt(w, o["s"], 0), "swing": None})  # fmt: skip
                continue
            nd += 1
            frame = FRAME * o["width"]
            leaf = o["width"] - 2 * frame
            hinge_lo = r.random() < 0.5
            side = r.choice((-1, 1))
            if w["outer"]:  # входная дверь открывается внутрь: полотно не ложится на цепочку размеров
                side = 1 if w["axis"][1] == 0 else -1
            h_s = lo + frame if hinge_lo else hi - frame
            u = 1 if hinge_lo else -1  # от петли к дальнему краю проёма вдоль стены
            hinge = _pt(w, h_s, side * t / 2)
            tip = _pt(w, h_s, side * (t / 2 + leaf))
            far = _pt(w, h_s + u * leaf, side * t / 2)
            sh.line(hinge, tip, w=0.5)
            a_u = math.degrees(math.atan2(far[1] - hinge[1], far[0] - hinge[0]))
            a_n = math.degrees(math.atan2(tip[1] - hinge[1], tip[0] - hinge[0]))
            ext = ((a_n - a_u + 180) % 360) - 180
            sh.arc(hinge, leaf, a_u, ext, w=0.3)
            mark = f"Д{nd}" if marks else None
            at = _pt(w, o["s"], side * (t / 2 + leaf * 0.55))
            if marks:
                sh.text(at, mark, 6)
            truth["openings"].append({"kind": "door", "mark": mark, "width_mm": o["width"], "clear_mm": round(leaf, 3),
                                      "at": _pt(w, o["s"], 0), "swing": ("a" if hinge_lo else "b") + ("+" if side > 0 else "-")})  # fmt: skip


def _axes(sh: Sheet, xs, ys, walls, r: random.Random, truth: dict) -> None:
    """Оси штрихпунктиром, марки в кружках снизу и слева (и иногда сверху/справа)."""
    t_out = max(w["t"] for w in walls)
    off = sh.n  # 1 мм листа в мм натуры
    y_lo, y_hi = ys[0] - t_out / 2 - 34 * off, ys[-1] + t_out / 2 + 8 * off
    x_lo, x_hi = xs[0] - t_out / 2 - 34 * off, xs[-1] + t_out / 2 + 8 * off
    both = r.random() < 0.5
    dash = ([12, 2, 2, 2], 0)
    for i, x in enumerate(xs):
        mark = str(i + 1)
        top = y_hi + (8 * off if both else 0)
        sh.line((x, y_lo), (x, top), w=0.3, dash=dash)
        bx, by = sh.p(x, y_lo - BUBBLE_R * off)
        sh.circle_sheet(bx / mm, by / mm, BUBBLE_R)
        sh.text_sheet(bx / mm, by / mm - 1.2, mark, 10)
        if both:
            tx, ty = sh.p(x, top + BUBBLE_R * off)
            sh.circle_sheet(tx / mm, ty / mm, BUBBLE_R)
            sh.text_sheet(tx / mm, ty / mm - 1.2, mark, 10)
        truth["axes"].append({"mark": mark, "family": "num", "pos": x})
    for j, y in enumerate(ys):
        mark = AXIS_LETTERS[j]
        right = x_hi + (8 * off if both else 0)
        sh.line((x_lo, y), (right, y), w=0.3, dash=dash)
        bx, by = sh.p(x_lo - BUBBLE_R * off, y)
        sh.circle_sheet(bx / mm, by / mm, BUBBLE_R)
        sh.text_sheet(bx / mm, by / mm - 1.2, mark, 10)
        if both:
            tx, ty = sh.p(right + BUBBLE_R * off, y)
            sh.circle_sheet(tx / mm, ty / mm, BUBBLE_R)
            sh.text_sheet(tx / mm, ty / mm - 1.2, mark, 10)
        truth["axes"].append({"mark": mark, "family": "let", "pos": y})


def _chain(sh: Sheet, nodes: list[float], level: float, horizontal: bool, ext_from: float, truth: dict,
           labels: list[str] | None = None) -> None:  # fmt: skip
    """Цепочка размеров: линия, засечки 45° в узлах, выносные линии, число над серединой звена (мм натуры)."""
    off = sh.n
    if horizontal:
        sh.line((nodes[0] - 2 * off, level), (nodes[-1] + 2 * off, level), w=0.3)
    else:
        sh.line((level, nodes[0] - 2 * off), (level, nodes[-1] + 2 * off), w=0.3)
    sign = (
        1 if level < ext_from else -1
    )  # выносная — от здания к цепочке и на 2 мм за неё
    for v in nodes:
        if horizontal:
            sh.line((v, ext_from), (v, level - sign * 2 * off), w=0.25)
            sh.line(
                (v - TICK * off, level - TICK * off),
                (v + TICK * off, level + TICK * off),
                w=0.5,
            )
        else:
            sh.line((ext_from, v), (level - sign * 2 * off, v), w=0.25)
            sh.line(
                (level - TICK * off, v - TICK * off),
                (level + TICK * off, v + TICK * off),
                w=0.5,
            )
    for k, (a, b) in enumerate(zip(nodes, nodes[1:])):
        value = round(b - a)
        label = labels[k] if labels else str(value)
        mid = (a + b) / 2
        if horizontal:
            sh.text((mid, level + 1.0 * off), label, DIM_TEXT)
            p0, p1 = (a, level), (b, level)
        else:
            sh.text((level - 1.0 * off, mid), label, DIM_TEXT, angle=90)
            p0, p1 = (level, a), (level, b)
        truth["dims"].append({"value_mm": float(label) if labels else float(value), "measured_mm": float(value),
                              "p0": p0, "p1": p1})  # fmt: skip


def _dims(sh: Sheet, xs, ys, walls, truth: dict, label_error: dict | None) -> None:
    off = sh.n
    t_out = max(w["t"] for w in walls)
    y_ext, x_ext = ys[0] - t_out / 2 - 2 * off, xs[0] - t_out / 2 - 2 * off
    labels = None
    if (
        label_error
    ):  # «не в масштабе»: подпись звена k нижней цепочки отличается от геометрии
        labels = [str(round(b - a)) for a, b in zip(xs, xs[1:])]
        for k, v in label_error.items():
            labels[k] = str(v)
    _chain(sh, xs, ys[0] - t_out / 2 - 12 * off, True, y_ext, truth, labels)
    _chain(sh, [xs[0], xs[-1]], ys[0] - t_out / 2 - 20 * off, True, y_ext, truth)
    _chain(sh, ys, xs[0] - t_out / 2 - 12 * off, False, x_ext, truth)
    _chain(sh, [ys[0], ys[-1]], xs[0] - t_out / 2 - 20 * off, False, x_ext, truth)
    # верхний фасад: оси и откосы окон верхней стены
    top = next(w for w in walls if w["axis"] == ("y", len(ys) - 1))
    nodes = sorted(
        set(xs) | {o["s"] + d * o["width"] / 2 for o in top["open"] for d in (-1, 1)}
    )
    _chain(
        sh,
        nodes,
        ys[-1] + top["t"] / 2 + 12 * off,
        True,
        ys[-1] + top["t"] / 2 + 2 * off,
        truth,
    )


def _cells(xs, ys) -> list[tuple[int, int]]:
    return [(i, j) for i in range(len(xs) - 1) for j in range(len(ys) - 1)]


def _inner(walls, xs, ys, i, j) -> tuple[float, float, float, float]:
    """Помещение ячейки (i, j) по внутренним граням стен."""
    tx = {w["axis"][1]: w["t"] for w in walls if w["axis"][0] == "x"}
    ty = {w["axis"][1]: w["t"] for w in walls if w["axis"][0] == "y"}
    return (
        xs[i] + tx[i] / 2,
        ys[j] + ty[j] / 2,
        xs[i + 1] - tx[i + 1] / 2,
        ys[j + 1] - ty[j + 1] / 2,
    )


def _stair_lift(
    sh: Sheet, r: random.Random, xs, ys, walls, truth: dict
) -> set[tuple[int, int]]:
    cells = _cells(xs, ys)
    r.shuffle(cells)
    tread, riser, width = 300, r.choice((150, 160, 165)), 1200
    n = r.randint(8, 14)
    # марш целиком в ячейке: 600 мм от грани до первой ступени и 400 мм за последней
    fit = [c for c in cells if int((_inner(walls, xs, ys, *c)[2] - _inner(walls, xs, ys, *c)[0] - 1000) // tread) + 1 >= 6]
    si, sj = (fit or cells)[0]
    cells.remove((si, sj))
    cells.insert(0, (si, sj))
    x0, y0, x1, y1 = _inner(walls, xs, ys, si, sj)
    n = max(2, min(n, int((x1 - x0 - 1000) // tread) + 1))
    sx, sy = x0 + 600, y0 + 500  # марш вдоль x, ступени — отрезки поперёк
    for k in range(n):
        sh.line((sx + k * tread, sy), (sx + k * tread, sy + width), w=0.3)
    sh.line((sx, sy), (sx + (n - 1) * tread, sy), w=0.3)
    sh.line((sx, sy + width), (sx + (n - 1) * tread, sy + width), w=0.3)
    sh.text((sx + (n - 1) * tread / 2, sy + width + 350), f"{n} ст. {riser}×{tread}", 6)
    truth["stairs"].append({"kind": "stair", "steps": n, "riser_mm": riser, "tread_mm": tread, "slope_pct": None,
                            "shaft_mm": None, "at": (sx + (n - 1) * tread / 2, sy + width / 2)})  # fmt: skip
    li, lj = cells[1]
    x0, y0, x1, y1 = _inner(walls, xs, ys, li, lj)
    lw, ld = r.choice(((1800, 2100), (2000, 2400), (1600, 1900)))
    lx, ly = x1 - lw - 400, y1 - ld - 400
    pts = [(lx, ly), (lx + lw, ly), (lx + lw, ly + ld), (lx, ly + ld)]
    sh.poly(pts, w=0.5)
    sh.line(pts[0], pts[2], w=0.3)
    sh.line(pts[1], pts[3], w=0.3)
    truth["stairs"].append({"kind": "lift", "steps": None, "riser_mm": None, "tread_mm": None, "slope_pct": None,
                            "shaft_mm": sorted((lw, ld)), "at": (lx + lw / 2, ly + ld / 2)})  # fmt: skip
    return {(si, sj), (li, lj)}


def _rooms_levels(
    sh: Sheet, r: random.Random, xs, ys, walls, busy, truth: dict, levels: bool
) -> None:
    k = 0
    for i, j in _cells(xs, ys):
        x0, y0, x1, y1 = _inner(walls, xs, ys, i, j)
        k += 1
        number = f"1.{k:02d}"
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if (i, j) in busy:  # подпись — в свободный угол, не на ступени и не в шахту
            cx, cy = x0 + 1200, y1 - 900
        area = (x1 - x0) * (y1 - y0) / 1e6
        sh.text((cx, cy + 150), number, 9)
        sh.text((cx, cy - 400), f"{area:.2f}".replace(".", ","), 6)
        truth["rooms"].append({"number": number, "polygon": [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                               "area_m2": round(area, 4), "at": (cx, cy)})  # fmt: skip
        if levels and (i, j) not in busy and r.random() < 0.5:
            v = r.choice((0.0, 0.0, -0.02, 3.3, -0.45))
            lx, ly = x0 + 500, y0 + 700
            tri = [(lx, ly), (lx - 150, ly + 250), (lx + 150, ly + 250)]
            sh.poly(tri, w=0.3)
            sh.line((lx, ly + 250), (lx + 1100, ly + 250), w=0.3)
            s = "±0.000" if v == 0 else f"{v:+.3f}"
            sh.text((lx + 550, ly + 320), s, 6)
            truth["levels"].append(
                {"value_m": v, "kind": "floor", "absolute": False, "at": (lx, ly)}
            )


# ─────────────────────────────────────────────── инженерные системы и знаки


def _symbol(sh: Sheet, kind: str, x: float, y: float) -> None:
    """Условный знак вокруг точки (x, y) в мм листа от левого нижнего угла — одним путём (кроме крана)."""
    s = 1.6
    if kind == "smoke_detector":
        sh.circle_sheet(x, y, s, w=0.5)
        sh.line((x - s, y), (x + s, y), w=0.5, sheet=True)
    elif kind == "sounder":
        sh.poly([(x - s, y - s), (x + s, y), (x - s, y + s)], w=0.5, sheet=True)
    elif kind == "fire_damper":
        sh.poly(
            [(x - s, y - s), (x + s, y - s), (x + s, y + s), (x - s, y + s)],
            w=0.5,
            sheet=True,
        )
        sh.line((x - s, y - s), (x + s, y + s), w=0.5, sheet=True)
    elif kind == "other":  # светильник: косой крест
        sh.line((x - s, y - s), (x + s, y + s), w=0.5, sheet=True)
        sh.line((x - s, y + s), (x + s, y - s), w=0.5, sheet=True)
    else:  # кран ВПВ: квадрат и залитая половина
        sh.poly(
            [(x - s, y - s), (x + s, y - s), (x + s, y + s), (x - s, y + s)],
            w=0.5,
            sheet=True,
        )
        sh.poly(
            [(x - s, y - s), (x + s, y - s), (x + s, y + s)],
            w=0.2,
            fill=(0, 0, 0),
            sheet=True,
        )


def _legend(sh: Sheet, x: float, y: float, truth: dict) -> None:
    sh.text_sheet(x, y + 8, "Условные обозначения", 9, align="l")
    for k, (kind, text) in enumerate(SYMBOL_KINDS.items()):
        yy = y - k * 9
        _symbol(sh, kind, x + 3, yy + 1)
        sh.text_sheet(x + 10, yy, text, 8, align="l")


def _routes(sh: Sheet, r: random.Random, xs, ys, walls, truth: dict) -> None:
    """Воздуховод П1: магистраль вдоль ряда ячеек с ответвлениями (тройники), трубопровод В1 — ломаная с поворотом."""
    j = r.randrange(len(ys) - 1)
    ym = (ys[j] + ys[j + 1]) / 2
    xa, xb = xs[0] + 800, xs[-1] - 800
    size = r.choice(("ø250", "ø315", "400×400", "500×300", "ø200"))
    sh.line((xa, ym), (xb, ym), w=1.7, rgb=DUCT_RGB)
    nodes = [("end", (xa, ym)), ("end", (xb, ym))]
    edges_x = [xa, xb]
    branches = []
    for i in range(1, len(xs) - 1):
        if r.random() < 0.7:
            bx = (xs[i] + xs[i + 1]) / 2 if i + 1 < len(xs) else xs[i] - 1000
            if not xa < bx < xb:
                continue
            by = ym + r.choice((-1, 1)) * 1500
            sh.line((bx, ym), (bx, by), w=1.7, rgb=DUCT_RGB)
            nodes += [("tee", (bx, ym)), ("end", (bx, by))]
            edges_x.append(bx)
            branches.append(((bx, ym), (bx, by)))
    xs_sorted = sorted(set(edges_x))
    edges = [((a, ym), (b, ym)) for a, b in zip(xs_sorted, xs_sorted[1:])] + branches
    sh.text((xa + 1200, ym + 250), f"П1 {size}", 7, align="l")
    truth["routes"].append(
        {"system": "П1", "section": size, "nodes": nodes, "edges": edges}
    )
    # ОЗК там, где магистраль пересекает противопожарную стену
    fire = next((w for w in walls if w["fire"] and w["axis"][0] == "x"), None)
    if fire is not None and xa < fire["a"][0] < xb:
        x, y = sh.p(fire["a"][0], ym)
        _symbol(sh, "fire_damper", x / mm, y / mm + 3)
        truth["symbols"].append(
            {"kind": "fire_damper", "at": (fire["a"][0], ym + 3 * sh.n)}
        )
    # трубопровод ВПВ с поворотом и краном на конце
    jj = (j + 1) % (len(ys) - 1)
    yp = ys[jj] + 900
    xp0, xp1 = xs[0] + 600, xs[r.randrange(1, len(xs))] - 600
    yp1 = yp + r.choice((1500, 2000))
    dn = r.choice(("ø32", "ø50", "ø65"))
    sh.poly([(xp0, yp), (xp1, yp), (xp1, yp1)], w=1.0, rgb=PIPE_RGB, closed=False)
    sh.text((xp0 + 1000, yp + 250), f"В1 {dn}", 7, align="l")
    truth["routes"].append({"system": "В1", "section": dn, "nodes": [("end", (xp0, yp)), ("bend", (xp1, yp)), ("end", (xp1, yp1))],
                            "edges": [((xp0, yp), (xp1, yp)), ((xp1, yp), (xp1, yp1))]})  # fmt: skip
    x, y = sh.p(xp1, yp1)
    _symbol(sh, "fire_hydrant_valve", x / mm + 3, y / mm)
    truth["symbols"].append({"kind": "fire_hydrant_valve", "mark": None, "at": (xp1 + 3 * sh.n, yp1)})


def _detectors(sh: Sheet, r: random.Random, xs, ys, walls, truth: dict) -> None:
    for i, j in _cells(xs, ys):
        x0, y0, x1, y1 = _inner(walls, xs, ys, i, j)
        for k in range(r.randint(1, 2)):
            px = x0 + (x1 - x0) * (0.3 + 0.4 * k)
            py = y0 + (y1 - y0) * 0.7
            x, y = sh.p(px, py)
            _symbol(sh, "smoke_detector", x / mm, y / mm)
            truth["symbols"].append({"kind": "smoke_detector", "mark": None, "at": (px, py)})
        if r.random() < 0.4:
            px, py = x0 + 400, y0 + 400
            x, y = sh.p(px, py)
            _symbol(sh, "sounder", x / mm, y / mm)
            truth["symbols"].append({"kind": "sounder", "mark": None, "at": (px, py)})
        if (i + j) % 2 == 0:
            px, py = x1 - 500, y0 + 500
            x, y = sh.p(px, py)
            _symbol(sh, "other", x / mm, y / mm)
            truth["symbols"].append({"kind": "other", "mark": SYMBOL_KINDS["other"], "at": (px, py)})


# ─────────────────────────────────────────────── генплан


def _rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _site(sh: Sheet, r: random.Random, truth: dict) -> None:
    L, B = r.choice((30000, 36000, 42000, 48000)), r.choice((12000, 15000, 18000))
    W = r.choice((3500, 4200, 5500, 6000))
    pav = 2000
    k, m = r.randint(6, 14), r.randint(1, 3)
    sw, sd, mw = 2500, 5300, 3600
    # газон и площадка — фон; затем покрытия, проезд, здание
    lawn = _rect(-8000, B + 3000, L + 8000, B + 14000)
    play = _rect(
        4000,
        B + 5000,
        4000 + r.choice((12000, 15000, 18000)),
        B + 5000 + r.choice((8000, 10000)),
    )
    paving = _rect(-pav, -pav, L + pav, 0)
    road = _rect(-6000, -pav - W, L + 6000, -pav)
    park_y0 = -pav - W - sd
    for kind, poly in (
        ("lawn", lawn),
        ("playground", play),
        ("paving", paving),
        ("asphalt", road),
    ):
        sh.poly(poly, w=0.3, fill=SITE_FILL[kind][0])
        truth["site"].append({"kind": "road" if kind == "asphalt" else kind, "fill": kind, "polygon": poly,
                              "area_m2": _area(poly), "width_mm": W if kind == "asphalt" else None, "count": None})  # fmt: skip
    sh.poly(_rect(0, 0, L, B), w=1.4, fill=SITE_FILL["building"][0])
    truth["site"].append({"kind": "building", "fill": "building", "polygon": _rect(0, 0, L, B), "area_m2": _area(_rect(0, 0, L, B)),
                          "width_mm": None, "count": None})  # fmt: skip
    x = 0.0
    for i in range(k + m):
        mgn = i < m
        w = mw if mgn else sw
        poly = _rect(x, park_y0, x + w, park_y0 + sd)
        sh.poly(poly, w=0.3)
        if mgn:
            sh.text(((x + x + w) / 2, park_y0 + sd / 2 - 400), "МГН", 5)
        truth["site"].append({"kind": "parking_mgn" if mgn else "parking", "fill": None, "polygon": poly,
                              "area_m2": _area(poly), "width_mm": None, "count": 1})  # fmt: skip
        x += w
    # размер ширины проезда — в метрах (ГОСТ 21.508), поперёк проезда
    dx = L + 3000
    off = sh.n
    sh.line((dx, -pav - W - 2 * off), (dx, -pav + 2 * off), w=0.3)
    for v in (-pav - W, -pav):
        sh.line(
            (dx - TICK * off, v - TICK * off), (dx + TICK * off, v + TICK * off), w=0.5
        )
    sh.text(
        (dx - 1.0 * off, -pav - W / 2),
        f"{W / 1000:.2f}".replace(".", ","),
        DIM_TEXT,
        angle=90,
    )
    truth["dims"].append(
        {
            "value_mm": float(W),
            "measured_mm": float(W),
            "p0": (dx, -pav - W),
            "p1": (dx, -pav),
        }
    )
    # легенда
    lx, ly = sh.w - 150, sh.h - 40
    sh.text_sheet(lx, ly + 8, "Условные обозначения", 9, align="l")
    for n, (kind, (rgb, text)) in enumerate(SITE_FILL.items()):
        yy = ly - n * 9
        sh.poly(_rect(lx, yy - 1, lx + 10, yy + 4), w=0.3, fill=rgb, sheet=True)
        sh.text_sheet(lx + 14, yy, text, 8, align="l")


def _area(poly) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        s += x0 * y1 - x1 * y0
    return round(abs(s) / 2 / 1e6, 4)


# ─────────────────────────────────────────────── лист целиком


def plan(seed: int, kind: str, out: Path, *, rot_deg: float = 0.0, dx_mm: float = 0.0, dy_mm: float = 0.0,
         page_rotate: int = 0, stamp: float | None = None, label_error: dict | None = None,
         n_num: int | None = None, n_let: int | None = None) -> dict:  # fmt: skip
    """Пишет PDF листа вида kind и возвращает истину. stamp — масштаб в штампе, если он должен расходиться с
    геометрией (проверка SCALE_SPREAD); label_error — {звено нижней цепочки: подпись} для «не в масштабе»."""
    if kind not in KINDS:
        raise ValueError(f"вид листа {kind!r}: ждём {KINDS}")
    r = random.Random(seed * 7919 + KINDS.index(kind))
    truth: dict = {"seed": seed, "kind": kind, "axes": [], "dims": [], "walls": [], "openings": [], "stairs": [],
                   "rooms": [], "levels": [], "routes": [], "symbols": [], "site": []}  # fmt: skip
    if kind == "gp":
        n = 500
        sh = Sheet(out, "A2", n, (140, 190), rot_deg, dx_mm, dy_mm)
        _site(sh, r, truth)
        sh.stamp("Схема планировочной организации земельного участка", stamp or n)
    else:
        n = 100
        xs, ys = _layout(r, n_num, n_let)
        sh = Sheet(out, "A2", n, (80, 120), rot_deg, dx_mm, dy_mm)
        walls = _walls(r, xs, ys)
        _openings(r, walls, xs, ys)
        _axes(sh, xs, ys, walls, r, truth)
        eng = kind == "eng"
        _draw_walls(
            sh,
            walls,
            truth,
            rgb=(0.3, 0.3, 0.3) if eng else (0, 0, 0),
            wall_w=0.8 if eng else WALL_W,
        )
        _draw_openings(sh, r, walls, truth, marks=not eng)
        _dims(sh, xs, ys, walls, truth, label_error)
        if eng:
            _routes(sh, r, xs, ys, walls, truth)
            _detectors(sh, r, xs, ys, walls, truth)
            bx, by = sh.p(xs[-1], ys[-1])
            _legend(sh, bx / mm + 45, by / mm, truth)
            title = "План расположения оборудования ОВ и ПС на отм. 0.000"
        else:
            busy = _stair_lift(sh, r, xs, ys, walls, truth)
            _rooms_levels(sh, r, xs, ys, walls, busy, truth, levels=True)
            title = "План 1 этажа на отм. 0.000"
        truth["steps"] = {
            "num": [b - a for a, b in zip(xs, xs[1:])],
            "let": [b - a for a, b in zip(ys, ys[1:])],
        }
        sh.stamp(title, stamp or n)
    truth["scale"] = n
    truth["stamp"] = stamp or n
    truth["sheet_from_bld"] = sh.sheet_from_bld()
    truth["transform"] = {
        "rot_deg": rot_deg,
        "dx_mm": dx_mm,
        "dy_mm": dy_mm,
        "page_rotate": page_rotate,
    }
    sh.save(page_rotate, out)
    return json.loads(
        json.dumps(truth)
    )  # кортежи → списки: истина сравнивается с JSON-ответом


def main(argv: list[str]) -> None:
    seed, kind, out = int(argv[0]), argv[1], Path(argv[2])
    t = plan(seed, kind, out)
    print(
        json.dumps(
            {k: (len(v) if isinstance(v, list) else v) for k, v in t.items()},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main(sys.argv[1:])
