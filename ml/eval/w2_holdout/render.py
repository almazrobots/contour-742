"""Отрисовка отложенного набора W2 (T-195): перо листа, фрагменты в своём масштабе, размеры, текст кривыми.

Координаты: здание — мм в системе осей (ось 1 × ось А = 0, y вверх, как в САПР); лист — мм от левого нижнего угла
MediaBox (как PDF). Фрагмент переводит мм здания в мм листа: поворот плана θ, масштаб 1:n, центр на листе. Рамки
сущностей (`Pen.tags`) — доли ВИДИМОЙ страницы от левого верхнего угла, с учётом /Rotate — как bbox в ParsedDoc.
Условные знаки и надписи — фиксированного размера на листе (мм листа), геометрия — в масштабе.

Кривые (дуги дверей, окружности марок, облака) — кубические Безье, построенные в мм здания и перенесённые аффинно:
поворот листа и плана их не искажает. «Текст кривыми» — штрихи собственного шрифта (`GLYPHS`), без текстового слоя.
Перо без холста (`canvas=None`) ничего не рисует и только считает рамки — для истины без PDF.
"""

from __future__ import annotations

import hashlib
import math
from contextlib import contextmanager
from dataclasses import dataclass

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from inspector_ml.paths import repo_root

PT = 72 / 25.4  # пунктов в мм
FONT = "NotoW2H"
pdfmetrics.registerFont(TTFont(FONT, str(repo_root() / "assets/fonts/NotoSans.ttf")))
SHEETS = (
    ("A3", 420.0, 297.0),
    ("A2", 594.0, 420.0),
    ("A1", 841.0, 594.0),
    ("A0", 1189.0, 841.0),
)
STAMP_W, STAMP_H = 185.0, 55.0
TABLE_W = 190.0  # колонка таблиц справа над штампом
K_ARC = 0.5522847498  # 4/3·tg(π/8): четверть окружности кубической Безье

# Штриховой шрифт «под SHX»: клетка 4 × 6, полилинии; символа нет — надпись целиком идёт текстом.
GLYPHS: dict[str, list[list[tuple[float, float]]]] = {
    "0": [[(0, 0), (4, 0), (4, 6), (0, 6), (0, 0)], [(0, 0), (4, 6)]],
    "1": [[(1, 5), (2, 6), (2, 0)], [(1, 0), (3, 0)]],
    "2": [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (0, 0), (4, 0)]],
    "3": [[(0, 6), (4, 6), (4, 0), (0, 0)], [(1, 3), (4, 3)]],
    "4": [[(3, 0), (3, 6), (0, 2), (4, 2)]],
    "5": [[(4, 6), (0, 6), (0, 3), (4, 3), (4, 0), (0, 0)]],
    "6": [[(4, 6), (0, 6), (0, 0), (4, 0), (4, 3), (0, 3)]],
    "7": [[(0, 6), (4, 6), (1, 0)]],
    "8": [[(0, 0), (4, 0), (4, 6), (0, 6), (0, 0)], [(0, 3), (4, 3)]],
    "9": [[(4, 3), (0, 3), (0, 6), (4, 6), (4, 0), (0, 0)]],
    ",": [[(1.5, 0.8), (1.5, 0), (1, -1)]],
    ".": [[(1.6, 0), (2.4, 0), (2.4, 0.8), (1.6, 0.8), (1.6, 0)]],
    "-": [[(0.5, 3), (3.5, 3)]],
    "×": [[(0.5, 1), (3.5, 4)], [(0.5, 4), (3.5, 1)]],
    "А": [[(0, 0), (2, 6), (4, 0)], [(1, 3), (3, 3)]],
    "Б": [[(4, 6), (0, 6), (0, 0), (3, 0), (4, 1), (4, 2), (3, 3), (0, 3)]],
    "В": [
        [(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)],
        [(3, 3), (4, 2), (4, 1), (3, 0)],
    ],
    "Г": [[(0, 0), (0, 6), (4, 6)]],
    "Д": [[(0, -1), (0, 0), (4, 0), (4, -1)], [(0.5, 0), (1.5, 6), (3, 6), (3.5, 0)]],
    "Е": [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    "К": [[(0, 0), (0, 6)], [(4, 6), (0, 3), (4, 0)]],
    "П": [[(0, 0), (0, 6), (4, 6), (4, 0)]],
    "Р": [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]],
}


def shx_ok(s: str) -> bool:
    return bool(s) and all(ch in GLYPHS or ch == " " for ch in s)


def decide(salt: int, key: str, share: float) -> bool:
    """Детерминированный выбор по ключу надписи: один и тот же ключ в ПД и РД рисуется одинаково."""
    h = int(hashlib.sha256(f"{salt}:{key}".encode()).hexdigest()[:8], 16)
    return h % 1000 < share * 1000


def rot(p: tuple[float, float], deg: float) -> tuple[float, float]:
    a = math.radians(deg)
    return (
        p[0] * math.cos(a) - p[1] * math.sin(a),
        p[0] * math.sin(a) + p[1] * math.cos(a),
    )


@dataclass
class Frag:
    """Фрагмент плана на листе: мм здания → мм листа. pivot — точка здания, которая попадает в center листа."""

    name: str
    n: float
    theta: float
    pivot: tuple[float, float]
    center: tuple[float, float]

    def m(self, p) -> tuple[float, float]:
        x, y = rot((p[0] - self.pivot[0], p[1] - self.pivot[1]), self.theta)
        return (self.center[0] + x / self.n, self.center[1] + y / self.n)

    def d(self, v) -> tuple[float, float]:
        """Направление здания → направление листа (без масштаба)."""
        return rot(v, self.theta)


class Pen:
    """Перо листа: рисует на холсте reportlab (или всухую) и копит рамки по тегам."""

    def __init__(self, canvas, w_mm: float, h_mm: float, rotate: int = 0):
        self.c = canvas
        self.w, self.h, self.rotate = w_mm, h_mm, rotate
        self.tags: dict[str, list[float]] = {}
        self._ghost = 0
        self.dims: list[dict] = []

    # ── рамки
    def norm(self, x: float, y: float) -> tuple[float, float]:
        """мм MediaBox → доли видимой страницы (левый верхний угол). /Rotate 90 — поворот по часовой."""
        if self.rotate == 90:
            return (y / self.h, x / self.w)
        return (x / self.w, 1 - y / self.h)

    def mark(self, tag, pts) -> None:
        if not tag:
            return
        for t in tag if isinstance(tag, (list, tuple)) else (tag,):
            for x, y in pts:
                u, v = self.norm(x, y)
                b = self.tags.get(t)
                if b is None:
                    self.tags[t] = [u, v, u, v]
                else:
                    b[0], b[1], b[2], b[3] = (
                        min(b[0], u),
                        min(b[1], v),
                        max(b[2], u),
                        max(b[3], v),
                    )

    def bbox(self, tag: str) -> list[float] | None:
        b = self.tags.get(tag)
        return [round(max(0.0, min(1.0, x)), 6) for x in b] if b else None

    @contextmanager
    def ghost(self):
        """Внутри блока ничего не рисуется, только считаются рамки (зона удалённого элемента)."""
        self._ghost += 1
        try:
            yield
        finally:
            self._ghost -= 1

    @property
    def off(self) -> bool:
        return self.c is None or self._ghost > 0

    # ── примитивы (мм листа)
    def path(
        self,
        cmds,
        width=0.25,
        fill: float | None = None,
        gray=0.0,
        dash=None,
        stroke=True,
        tag=None,
    ):
        """cmds: ("M", p) ("L", p) ("C", c1, c2, p) ("Z",). fill — серый заливки или None."""
        pts = [q for c in cmds for q in c[1:]]
        self.mark(tag, pts)
        if self.off:
            return
        c = self.c
        p = c.beginPath()
        for cmd in cmds:
            if cmd[0] == "M":
                p.moveTo(cmd[1][0] * PT, cmd[1][1] * PT)
            elif cmd[0] == "L":
                p.lineTo(cmd[1][0] * PT, cmd[1][1] * PT)
            elif cmd[0] == "C":
                (a, b), (e, f), (g, h) = cmd[1], cmd[2], cmd[3]
                p.curveTo(a * PT, b * PT, e * PT, f * PT, g * PT, h * PT)
            else:
                p.close()
        c.setLineWidth(width * PT)
        c.setStrokeGray(gray)
        c.setDash(*([[x * PT for x in dash], 0] if dash else [[], 0]))
        if fill is not None:
            c.setFillGray(fill)
        c.drawPath(p, stroke=1 if stroke else 0, fill=1 if fill is not None else 0)

    def poly(self, pts, close=False, **kw):
        cmds = [("M", pts[0])] + [("L", q) for q in pts[1:]]
        if close:
            cmds.append(("Z",))
        self.path(cmds, **kw)

    def line(self, a, b, **kw):
        self.poly([a, b], **kw)

    def text(
        self, s: str, at, size=2.5, angle=0.0, anchor="c", tag=None, shx=False, gray=0.0
    ):
        """Надпись высотой size мм листа; at — точка базовой линии (anchor c — середина, l — левый край)."""
        if shx and shx_ok(s):
            self._shx(s, at, size, angle, anchor, tag, gray)
            return
        w = pdfmetrics.stringWidth(s, FONT, size * PT) / PT
        x0 = -w / 2 if anchor == "c" else 0.0
        corners = [
            rot(q, angle)
            for q in (
                (x0, -0.2 * size),
                (x0 + w, -0.2 * size),
                (x0 + w, size),
                (x0, size),
            )
        ]
        self.mark(tag, [(at[0] + q[0], at[1] + q[1]) for q in corners])
        if self.off:
            return
        c = self.c
        c.saveState()
        c.translate(at[0] * PT, at[1] * PT)
        c.rotate(angle)
        c.setFillGray(gray)
        c.setFont(FONT, size * PT)
        (c.drawCentredString if anchor == "c" else c.drawString)(0, 0, s)
        c.restoreState()

    def _shx(self, s, at, size, angle, anchor, tag, gray):
        k = size / 6.0
        adv = 5.0 * k
        w = adv * len(s) - k
        x = -w / 2 if anchor == "c" else 0.0
        for ch in s:
            for stroke in GLYPHS.get(ch, []):
                pts = [rot((x + gx * k, gy * k), angle) for gx, gy in stroke]
                self.poly(
                    [(at[0] + q[0], at[1] + q[1]) for q in pts],
                    width=0.18,
                    gray=gray,
                    tag=tag,
                )
            x += adv

    def circle(self, c, r, **kw):
        self.path(arc_cmds(c, r, 0, 360), **kw)


def arc_cmds(c, r, a0: float, a1: float, move=True):
    """Дуга окружности (мм листа) от угла a0 до a1 градусов кусками ≤ 90° — кубические Безье."""
    n = max(1, math.ceil(abs(a1 - a0) / 90 - 1e-9))
    da = (a1 - a0) / n
    out = []
    for i in range(n):
        s, e = math.radians(a0 + i * da), math.radians(a0 + (i + 1) * da)
        k = 4 / 3 * math.tan((e - s) / 4)
        p0 = (c[0] + r * math.cos(s), c[1] + r * math.sin(s))
        p3 = (c[0] + r * math.cos(e), c[1] + r * math.sin(e))
        c1 = (p0[0] - k * r * math.sin(s), p0[1] + k * r * math.cos(s))
        c2 = (p3[0] + k * r * math.sin(e), p3[1] - k * r * math.cos(e))
        if i == 0 and move:
            out.append(("M", p0))
        out.append(("C", c1, c2, p3))
    return out


# ─────────────────────────────────────────────── размеры


def dim(
    pen: Pen,
    fr: Frag,
    p0,
    p1,
    off_mm: float,
    text: str,
    style: dict,
    tag=None,
    key="",
    size=None,
):
    """Линейный размер между точками здания p0, p1: выносные, размерная линия на off_mm листа, ограничители по стилю
    (стрелки, засечки, точки), надпись над или под линией (style.text_side), часть надписей — кривыми."""
    a, b = fr.m(p0), fr.m(p1)
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    if L < 1e-6:
        return
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    nx, ny = -uy, ux
    s = 1 if off_mm >= 0 else -1
    A = (a[0] + nx * off_mm, a[1] + ny * off_mm)
    B = (b[0] + nx * off_mm, b[1] + ny * off_mm)
    ext = ((a, A), (b, B)) if abs(off_mm) >= 0.5 else ()  # выносные: отступ 1 мм, на 1,5 мм за размерную
    for q, Q in ext:
        pen.line(
            (q[0] + nx * s * 1.0, q[1] + ny * s * 1.0),
            (Q[0] + nx * s * 1.5, Q[1] + ny * s * 1.5),
            width=0.13,
            tag=tag,
        )
    pen.line(A, B, width=0.18, tag=tag)
    end = style["dim_end"]
    for P, d in ((A, 1), (B, -1)):  # d — внутрь размера
        if end == "arrow":
            tip, back = P, (P[0] + ux * d * 2.5, P[1] + uy * d * 2.5)
            pen.poly(
                [
                    tip,
                    (back[0] + nx * 0.45, back[1] + ny * 0.45),
                    (back[0] - nx * 0.45, back[1] - ny * 0.45),
                ],
                close=True,
                width=0.1,
                fill=0.0,
                tag=tag,
            )
        elif end == "tick":
            t = ((ux + nx) / math.sqrt(2), (uy + ny) / math.sqrt(2))
            pen.line(
                (P[0] - t[0] * 1.2, P[1] - t[1] * 1.2),
                (P[0] + t[0] * 1.2, P[1] + t[1] * 1.2),
                width=0.35,
                tag=tag,
            )
        else:
            pen.circle(P, 0.45, width=0.1, fill=0.0, tag=tag)
    ang = math.degrees(math.atan2(uy, ux))
    flip = ang > 90.0001 or ang <= -90
    if flip:
        ang += 180 if ang <= -90 else -180
    size = size or style["text_mm"]
    up = (nx, ny) if not flip else (-nx, -ny)  # «верх» надписи на листе
    mid = ((A[0] + B[0]) / 2, (A[1] + B[1]) / 2)
    gap = 0.8 if style["text_side"] == "above" else -(0.8 + size)
    at = (mid[0] + up[0] * gap, mid[1] + up[1] * gap)
    shx = decide(style["salt"], "dim:" + key, style["shx"])
    pen.text(text, at, size, ang, tag=tag, shx=shx)
    pen.dims.append(
        {
            "key": key,
            "text": text,
            "p0": list(p0),
            "p1": list(p1),
            "shx": shx and shx_ok(text),
            "tag": tag,
        }
    )


# ─────────────────────────────────────────────── раскладка листа


def layout(
    frags: list[tuple[str, tuple[float, float, float, float], float, float, float]],
    shift=(0.0, 0.0),
):
    """frags: (имя, рамка здания x0 y0 x1 y1, n, θ, поле мм листа). Ряд слева направо над штампом, колонка таблиц
    справа. Лист — наименьший из A3…A0, куда всё влезает. → (формат, w, h, {имя: Frag})."""
    sizes = []
    for name, (x0, y0, x1, y1), n, th, margin in frags:
        pts = [
            rot((x - (x0 + x1) / 2, y - (y0 + y1) / 2), th)
            for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        ]
        w = (max(p[0] for p in pts) - min(p[0] for p in pts)) / n + 2 * margin
        h = (max(p[1] for p in pts) - min(p[1] for p in pts)) / n + 2 * margin
        sizes.append((name, ((x0 + x1) / 2, (y0 + y1) / 2), n, th, w, h))
    need_w = 25 + sum(s[4] for s in sizes) + 8 * (len(sizes) - 1) + TABLE_W + 10
    need_h = max(max(s[5] for s in sizes) + 20, STAMP_H + 150) + 5 + 10
    for fmt, W, H in SHEETS:
        if need_w <= W and need_h <= H:
            break
    else:
        raise ValueError(
            f"фрагменты не помещаются даже на A0: {need_w:.0f}×{need_h:.0f} мм"
        )
    out, x = {}, 25.0
    for name, pivot, n, th, w, h in sizes:
        cy = 10 + (H - 20) / 2
        out[name] = Frag(name, n, th, pivot, (x + w / 2 + shift[0], cy + shift[1]))
        x += w + 8
    return fmt, W, H, out


def frame_and_stamp(
    pen: Pen, W: float, H: float, stamp: dict, scale_text: str | None, title: str
):
    """Рамка листа, штамп своей формы с таблицей изменений. scale_text None — масштаб не указан (ловушка NO_SCALE)."""
    pen.poly(
        [(20, 5), (W - 5, 5), (W - 5, H - 5), (20, H - 5)],
        close=True,
        width=0.7,
        tag="frame",
    )
    x0, y0 = W - 5 - STAMP_W, 5.0
    pen.poly(
        [
            (x0, y0),
            (x0 + STAMP_W, y0),
            (x0 + STAMP_W, y0 + STAMP_H),
            (x0, y0 + STAMP_H),
        ],
        close=True,
        width=0.5,
        tag="stamp",
    )
    for dy in (8, 16, 24, 32, 40):
        pen.line((x0, y0 + dy), (x0 + 65, y0 + dy), width=0.18, tag="stamp")
    for dx in (7, 17, 30, 45, 55, 65):
        pen.line((x0 + dx, y0), (x0 + dx, y0 + 40), width=0.18, tag="stamp")
    pen.line((x0 + 65, y0 + 20), (x0 + STAMP_W, y0 + 20), width=0.3, tag="stamp")
    pen.line((x0 + 65, y0 + 38), (x0 + STAMP_W, y0 + 38), width=0.3, tag="stamp")
    pen.line((x0 + 140, y0), (x0 + 140, y0 + 38), width=0.3, tag="stamp")
    for i, h in enumerate(("Изм.", "Кол.", "Лист", "№док", "Подп.", "Дата")):
        pen.text(
            h,
            (x0 + (0, 7, 17, 30, 45, 55)[i] + 1, y0 + 41.5),
            1.8,
            anchor="l",
            tag="stamp",
        )
    for j, row in enumerate(stamp.get("changes", [])[:5]):
        for i, v in enumerate(row):
            pen.text(
                str(v),
                (x0 + (0, 7, 17, 30, 45, 55)[i] + 1, y0 + 33.5 - 8 * j),
                1.8,
                anchor="l",
                tag="stamp:change",
            )
    pen.text(stamp["code"], (x0 + 125, y0 + 45), 3.5, tag="stamp")
    pen.text(title, (x0 + 102, y0 + 28), 2.5, tag="stamp")
    pen.text(f"Стадия {stamp['stage']}", (x0 + 162, y0 + 28), 2.5, tag="stamp")
    pen.text(
        f"Лист {stamp['sheet']}   Изм. {stamp['revision']}",
        (x0 + 162, y0 + 12),
        2.5,
        tag="stamp",
    )
    pen.text(f"Дата {stamp['date']}", (x0 + 102, y0 + 12), 2.5, tag="stamp")
    if scale_text:
        pen.text(f"Масштаб {scale_text}", (x0 + 102, y0 + 4), 2.5, tag="stamp:scale")
    pen.text("Отложенный набор W2 — синтетика", (x0 + 162, y0 + 4), 1.8, tag="stamp")


def table(
    pen: Pen,
    x: float,
    y_top: float,
    head: tuple[str, ...],
    widths: tuple[float, ...],
    rows,
    tag: str,
    row_tags=None,
):
    """Таблица сверху вниз от y_top (мм листа). row_tags[i] — тег строки (спецификация: строка позиции)."""
    h = 6.0
    W = sum(widths)
    all_rows = [head, *rows]
    for i, row in enumerate(all_rows):
        yt = y_top - i * h
        rt = [tag] + (
            [row_tags[i - 1]] if row_tags and i > 0 and row_tags[i - 1] else []
        )
        pen.poly(
            [(x, yt), (x + W, yt), (x + W, yt - h), (x, yt - h)],
            close=True,
            width=0.25,
            tag=rt,
        )
        cx = x
        for w, v in zip(widths, row, strict=True):
            pen.text(str(v), (cx + 1.2, yt - h + 1.8), 2.2, anchor="l", tag=rt)
            cx += w
    return y_top - len(all_rows) * h
