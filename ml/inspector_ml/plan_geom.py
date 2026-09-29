"""Геометрия векторного плана — слой PlanGeometry рядом с ParsedDoc (T-192, ADR-0010, каталог TO-BE §4–6).

Вход — векторные пути листа (`pagekind.extract_vectors`, свой проход pdfium под PDFIUM_LOCK) и слова страницы ParsedDoc
(подписи, марки, числа размеров). ParsedDoc не меняется. Выход — `PlanGeometry` по контракту ADR-0010:

  * ENT-06 масштаб — «Масштаб 1:N» штампа (`measure.stamp_scales`) и робастная регрессия «длина на листе ↔ число
    размера» (медиана отношений); размеры, отошедшие от согласованного масштаба больше чем на 2 %, — «условные»
    (ENT-04, «не в масштабе»); нет согласия большинства размеров или штамп расходится с размерами > 2 % —
    NOT_COMPARABLE / SCALE_SPREAD; нет ни штампа, ни размеров — NO_SCALE;
  * ENT-04 размеры (PRM-08) — линия + засечки 45° в узлах + число над звеном; каждое звено цепочки — отдельный размер;
  * ENT-03 оси — длинная линия, выходящая из кружка с маркой (цифра или буква);
  * NRM-09 — аффинное «лист → система осей здания» по пересечениям осей (RANSAC), шаг осей — по числам размеров;
  * ENT-11 стены — взаимно ближайшие пары параллельных линий одного пера внутри осей, толщина — по масштабу;
    штриховка между гранями — противопожарная;
  * ENT-10 проёмы — разрыв между соосными кусками стены: дуга с центром у откоса — дверь (ширина в свету — радиус
    дуги), тонкие линии в разрыве — окно;
  * ENT-12 лестницы — ≥ 3 равных параллельных отрезка с равным шагом (проступь); лифт — прямоугольник с диагоналями;
  * ENT-05 отметки — число «±0.000 / +3.300» рядом с треугольником;
  * ENT-09 трассы — связные компоненты линий одного стиля с подписью «система сечение», узлы и рёбра графа;
  * знаки по легенде (ENT-08, ENT-18) — образец из строки легенды, поиск тех же путей на поле листа;
  * помещения (ENT-01) — номер и прямоугольник внутренних граней стен вокруг него;
  * ENT-21 генплан — залитые полигоны по цвету образца легенды, ширина проезда, машино-места (обычные и МГН).

Лист без векторного слоя (скан) — NOT_COMPARABLE / NO_VECTOR_LAYER; анализ дольше 30 с (OS-INSP-2.4.7) —
NOT_COMPARABLE / TIMEOUT без частичного результата. При NOT_COMPARABLE списки сущностей пусты: геометрия без
масштаба в мм не выдаётся.

Координаты PlanGeometry — мм листа от левого верхнего угла видимой области (`sheet`); `frame.to_bld` переводит их
в мм системы осей здания. `bbox` — доли видимой страницы, как в ParsedDoc. Только numpy (ADR-0010 п. 2).
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .measure import (
    CV_SHEET_LIMIT_S,
    MAX_SCALE_SPREAD,
    CvTimeout,
    Deadline,
    stamp_scales,
)
from .model import Page
from .pagekind import VECTOR_MIN_SEGMENTS, PageVectors, extract_vectors

GEOM_REV = (
    1  # ревизия извлечения геометрии: в ключе кэша geom-{sha}-p{page}-g{GEOM_REV}
)
MM_PER_PT = 25.4 / 72
EPS = 1e-9  # порог «ровно 2 %» не должен зависеть от округления двоичной дроби

# размеры (PRM-08)
TICK_MIN, TICK_MAX = 0.8, 6.0  # засечка, мм листа
TICK_ON_LINE = 0.35  # середина засечки не дальше 0,35 мм от линии
TICK_COS = (0.45, 0.9)  # угол засечки к линии 25…63°
NODE_MERGE = 0.3  # узлы ближе 0,3 мм — один узел
DIM_LINE_MIN = 3.0  # размерная линия не короче 3 мм листа
LABEL_GAP = 4.0  # число размера — не дальше 4 мм от линии
EXT_REACH = 2.5  # выносная кончается не дальше 2,5 мм от размерной линии
DIM_RE = re.compile(r"^\d{2,6}$")
DIM_M_RE = re.compile(
    r"^\d{1,3},\d{2}$"
)  # на генплане размеры в метрах (ГОСТ 21.508) — только при 1:N ≥ 200
DIM_M_MIN_SCALE = 200
# оси (ENT-03)
BUBBLE_D = (5.0, 16.0)  # диаметр кружка марки оси, мм листа
AXIS_MIN = 20.0  # линия оси не короче 20 мм листа
AXIS_MARK_RE = re.compile(r"^(\d{1,2}|[А-ЯA-Z]{1,2})$")
AXIS_LETTERS = "АБВГДЕЖИКЛМНПРСТУФШЭЮЯ"
# NRM-09
FRAME_TOL_MM = 50.0  # остаток регистрации в мм натуры: больше — точка не якорь
RANSAC_ITERS = 200
REG_MIN_SHARE = 0.7  # LNK-03: согласных якорей не меньше 70 % общих — иначе это разные листы
# стены (ENT-11)
WALL_T = (60.0, 900.0)  # толщина стены в мм натуры
WALL_MIN_LEN = 400.0  # грань стены не короче 400 мм натуры
PARALLEL_SIN = math.sin(math.radians(1.0))
SAME_WIDTH = 0.05  # перья граней одной стены равны до 5 %
COLLINEAR = 0.3  # куски одной стены: оси не дальше 0,3 мм листа
# проёмы (ENT-10)
GAP_MM = (400.0, 4000.0)
GATE_MM = 2500.0
MARK_RE = re.compile(
    r"^(Д|ДВ|ДН|ОК|О|Вр|ВР)[-–]?\d{1,3}[а-я]?$"
)  # «В1» — система водопровода, не проём
# лестницы (ENT-12)
STEP_LEN = (600.0, 3000.0)
TREAD = (200.0, 450.0)
STAIR_MIN = 3
SHAFT_MM = (1000.0, 3500.0)
STAIR_TEXT = re.compile(r"(\d{1,2})\s*ст")
RISER_TEXT = re.compile(r"(\d{3})\s*[×xх]\s*(\d{3})")
# отметки (ENT-05)
LEVEL_RE = re.compile(r"^([+\-−±]?)(\d{1,3})[.,](\d{3})$")
LEVEL_NEAR = 12.0
# трассы (ENT-09)
SNAP = 0.25
ROUTE_LABEL = re.compile(
    r"(?P<sys>\b[А-ЯA-Z]{1,2}\d{1,2}(?:\.\d+)?)\s*[-–]?\s*(?P<sec>[øØ⌀]\s*\d{2,4}(?:\s*[×xх]\s*\d{1,3}(?:[.,]\d)?)?|\d{2,4}\s*[×xх]\s*\d{2,4})"
)
ROUTE_NEAR = 8.0
ROUTE_MIN = 5.0  # трасса — не короче 5 мм листа по сумме звеньев
ROUTE_SYS = re.compile(r"[А-ЯA-Z]{1,2}\d{1,2}(?:\.\d+)?")
ROUTE_SEC = re.compile(
    r"[øØ⌀]\s*\d{2,4}(?:[×xх]\d{1,3}(?:[.,]\d)?)?|\d{2,4}[×xх]\d{2,4}"
)
ROUTE_PAIR = 3.0  # система и сечение одной подписи — зазор не больше 3 мм листа
BEND_DEG = 20.0
# знаки по легенде (ENT-08, ENT-18)
# закрытый словарь ADR-0010 (уточнение T-190): порядок важен — «ручной» и «тепловой» раньше общего «извещатель»
SYMBOL_KINDS = (
    ("manual_call_point", re.compile(r"ручн\w*\s+(пожарн\w*\s+)?извещат|извещат\w*\s+(пожарн\w*\s+)?ручн|\bипр\b", re.I)),
    ("heat_detector", re.compile(r"извещат.*тепл|тепл\w*\s+извещат", re.I)),
    ("smoke_detector", re.compile(r"извещат", re.I)),
    ("sounder", re.compile(r"оповещат|сирен", re.I)),
    ("exit_sign", re.compile(r"табло|\bвыход\b|указател\w*\s+выход", re.I)),
    ("fire_damper", re.compile(r"клапан|озк", re.I)),
    ("fire_hydrant_valve", re.compile(r"пожарн\w*\s+кран|кран\s+впв|впв", re.I)),
    ("call_button", re.compile(r"кнопк\w*\s+(вызова|пуска)|кнопк", re.I)),
    ("meter", re.compile(r"сч[её]тчик|узел\s+учета", re.I)),
    ("lift_platform", re.compile(r"подъ[её]мн\w*\s+платформ|платформ", re.I)),
    ("handrail", re.compile(r"поручн", re.I)),
)
LEGEND_BLOCK = 100.0  # строки легенды — не дальше 100 мм под заголовком «Условные обозначения»
LEGEND_REACH = 20.0
PHRASE_GAP = 3.0  # слова одного оборота легенды — зазор не больше 3 мм
SYMBOL_MAX = 12.0
SIG_Q = 0.25
SYMBOL_TOL = 0.4
# помещения (ENT-01)
ROOM_RE = re.compile(r"^(\d{1,2}\.\d{2}|\d{3})[а-я]?$")
AREA_RE = re.compile(r"^\d{1,4},\d{1,2}$")
# генплан (ENT-21)
SITE_KINDS = (
    ("building", re.compile(r"здани", re.I)),
    ("playground", re.compile(r"площадк", re.I)),
    ("lawn", re.compile(r"газон|озелен", re.I)),
    ("paving", re.compile(r"плитк|тротуар|мощен", re.I)),
    ("road", re.compile(r"проезд|дорог", re.I)),
    ("asphalt", re.compile(r"асфальт", re.I)),
    ("fence", re.compile(r"огражд", re.I)),
)
STALL_SHORT, STALL_LONG = (2000.0, 4500.0), (4500.0, 7000.0)

Pt = tuple[float, float]


class GeomError(ValueError):
    """Испорченный вход геометрии — громкий отказ, а не пустой результат."""


# ─────────────────────────────────────────────── примитивы листа


@dataclass
class Seg:
    """Отрезок пути в мм листа (начало — левый верхний угол видимой области)."""

    x0: float
    y0: float
    x1: float
    y1: float
    path: int
    width: float  # мм
    rgba: tuple | None
    fill: tuple | None
    fill_mode: int
    stroke: bool
    dash: tuple
    curve: bool
    closing: bool
    i: int = 0

    @property
    def length(self) -> float:
        return math.hypot(self.x1 - self.x0, self.y1 - self.y0)

    @property
    def u(self) -> Pt:
        n = self.length or 1.0
        return ((self.x1 - self.x0) / n, (self.y1 - self.y0) / n)

    @property
    def mid(self) -> Pt:
        return ((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2)


@dataclass
class W:
    text: str
    box: tuple[float, float, float, float]  # мм листа
    frac: tuple[float, float, float, float]
    line: str

    @property
    def c(self) -> Pt:
        return ((self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2)


@dataclass
class Sheet:
    w: float
    h: float
    segs: list[Seg]
    words: list[W]
    lines: list  # строки ParsedDoc: штамп, подписи трасс
    paths: dict[int, list[Seg]] = field(default_factory=dict)
    used: set[int] = field(default_factory=set)  # отрезки, уже отнесённые к сущности
    used_words: set[int] = field(default_factory=set)
    chars: list = field(default_factory=list)  # (символ, рамка в мм) — свой проход pdfium; запасной путь для марок осей

    def frac(self, box) -> list[float]:
        return [
            round(box[0] / self.w, 5),
            round(box[1] / self.h, 5),
            round(box[2] / self.w, 5),
            round(box[3] / self.h, 5),
        ]


def sheet_from(vec: PageVectors, page: Page | None) -> Sheet:
    """Пути (доли видимой страницы) и слова ParsedDoc → мм листа."""
    if vec.width_pt <= 0 or vec.height_pt <= 0:
        raise GeomError("размер страницы не положителен")
    w, h = vec.width_pt * MM_PER_PT, vec.height_pt * MM_PER_PT
    segs = []
    for k, s in enumerate(vec.segments):
        vals = (s.x0, s.y0, s.x1, s.y1)
        if not all(math.isfinite(v) for v in vals):
            raise GeomError(f"отрезок {k}: координаты не конечны")
        segs.append(Seg(s.x0 * w, s.y0 * h, s.x1 * w, s.y1 * h, s.path, s.width_pt * MM_PER_PT, s.stroke_rgba, s.fill_rgba,
                        s.fill_mode, s.stroke, s.dash, s.curve, s.closing, k))  # fmt: skip
    words = []
    lines = list(page.lines) if page is not None else []
    for ln in lines:
        for wd in ln.words:
            if not wd.bbox:
                continue
            b = wd.bbox
            words.append(
                W(wd.text, (b[0] * w, b[1] * h, b[2] * w, b[3] * h), tuple(b), ln.text)
            )
    sh = Sheet(w, h, segs, words, lines)
    for s in segs:
        sh.paths.setdefault(s.path, []).append(s)
    return sh


def _dist_pt_seg(p: Pt, s: Seg) -> float:
    ux, uy = s.u
    t = max(0.0, min(s.length, (p[0] - s.x0) * ux + (p[1] - s.y0) * uy))
    return math.hypot(p[0] - s.x0 - ux * t, p[1] - s.y0 - uy * t)


def _union(boxes) -> tuple[float, float, float, float]:
    boxes = list(boxes)
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _seg_box(s: Seg) -> tuple[float, float, float, float]:
    return (min(s.x0, s.x1), min(s.y0, s.y1), max(s.x0, s.x1), max(s.y0, s.y1))


def _pts_box(pts) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _r(p: Pt, nd: int = 3) -> list[float]:
    return [round(float(p[0]), nd), round(float(p[1]), nd)]


def _straight(sh: Sheet, free: bool = True) -> list[Seg]:
    return [
        s
        for s in sh.segs
        if not s.curve
        and s.stroke
        and s.length > 1e-6
        and (not free or s.i not in sh.used)
    ]


def _closed_polys(sh: Sheet) -> dict[int, list[Pt]]:
    """Замкнутые пути из прямых звеньев: вершины по порядку (без повтора первой)."""
    out = {}
    for pid, ss in sh.paths.items():
        if any(s.curve for s in ss) or len(ss) < 3:
            continue
        pts = [(ss[0].x0, ss[0].y0)] + [(s.x1, s.y1) for s in ss]
        if math.dist(pts[0], pts[-1]) > 0.05:
            continue
        pts = pts[:-1]
        clean = [p for k, p in enumerate(pts) if math.dist(p, pts[k - 1]) > 1e-4]
        if len(clean) >= 3:
            out[pid] = clean
    return out


def shoelace(pts) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def perimeter(pts) -> float:
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:] + pts[:1]))


def strip_width(area: float, per: float) -> float:
    """Ширина полосы по площади и периметру (точно для прямоугольника: короткая сторона)."""
    d = per * per - 16 * area
    return (per - math.sqrt(max(d, 0.0))) / 4


# ─────────────────────────────────────────────── ENT-06 масштаб (чистая функция)


def consensus_scale(stamps: list[float], ratios: list[float]) -> dict:
    """ENT-06: масштаб из штампа и отношений «число размера / длина на листе».

    Размеры: оценка — медиана самой большой группы размеров, согласных между собой в пределах 2 % (консенсус,
    как RANSAC в одном параметре); размеры в пределах 2 % от оценки — согласованные, остальные — условные (ENT-04).
    Согласованных меньше половины или две разные группы одного размера — масштаба нет (SCALE_SPREAD). Со штампом: хотя бы один масштаб штампа
    в пределах 2 % от размеров — берётся измеренный, иначе SCALE_SPREAD. Нет ни того ни другого — NO_SCALE.
    spread_pct — наибольшее отклонение согласованного размера или штампа от оценки, %."""
    ratios = [float(r) for r in ratios if r and math.isfinite(r) and r > 0]
    stamps = [float(s) for s in stamps if s and s > 0]
    out = {"n": None, "method": None, "spread_pct": 0.0, "n_dims": len(ratios), "status": "OK", "why": None,
           "inliers": [False] * len(ratios)}  # fmt: skip
    if not ratios:
        if not stamps:
            return {**out, "status": "NOT_COMPARABLE", "why": "NO_SCALE"}
        return {**out, "n": stamps[0], "method": "stamp"}
    groups = [[q for q in ratios if abs(q - r) / r <= MAX_SCALE_SPREAD + EPS] for r in ratios]
    size = max(len(g) for g in groups)
    n = float(np.median(max((g for g in groups if len(g) == size), key=lambda g: -np.std(g))))
    dev = [abs(r - n) / n for r in ratios]
    inl = [d <= MAX_SCALE_SPREAD + EPS for d in dev]
    spread = max((d for d, ok in zip(dev, inl) if ok), default=0.0)
    out["inliers"] = inl
    rival = any(len(g) == size and abs(float(np.median(g)) - n) / n > 2 * MAX_SCALE_SPREAD for g in groups)
    if 2 * sum(inl) < len(ratios) or rival:
        return {
            **out,
            "spread_pct": round(100 * max(dev), 3),
            "status": "NOT_COMPARABLE",
            "why": "SCALE_SPREAD",
        }
    if not stamps:
        return {
            **out,
            "n": n,
            "method": "dimensions",
            "spread_pct": round(100 * spread, 3),
        }
    agree = [abs(n - s) / s for s in stamps]
    best = min(agree)
    spread = max(spread, best)
    if best > MAX_SCALE_SPREAD + EPS:
        return {
            **out,
            "spread_pct": round(100 * best, 3),
            "status": "NOT_COMPARABLE",
            "why": "SCALE_SPREAD",
        }
    return {**out, "n": n, "method": "both", "spread_pct": round(100 * spread, 3)}


# ─────────────────────────────────────────────── PRM-08 / ENT-04 размеры


def _number(text: str, meters: bool) -> float | None:
    t = text.replace(" ", "")
    if DIM_RE.match(t):
        return float(t)
    if meters and DIM_M_RE.match(t):
        return float(t.replace(",", ".")) * 1000
    return None


def find_dims(sh: Sheet, meters: bool) -> list[dict]:
    """Размерные звенья: {value_mm, len (мм листа), p0, p1, word, line}. Засечки и выносные отмечаются занятыми."""
    straight = _straight(sh)
    ticks = [s for s in straight if TICK_MIN <= s.length <= TICK_MAX]
    lines = [s for s in straight if s.length >= DIM_LINE_MIN and not s.dash]
    if not ticks or not lines:
        return []
    tick_of: dict[int, list[int]] = {}  # засечки линии — занимаются, только если у линии нашлось число
    tm = np.array([s.mid for s in ticks])
    tu = np.array([s.u for s in ticks])
    links = []
    for L in lines:
        ux, uy = L.u
        rel = tm - (L.x0, L.y0)
        t = rel @ (ux, uy)
        d = np.abs(rel @ (-uy, ux))
        cos = np.abs(tu @ (ux, uy))
        ok = (
            (d <= TICK_ON_LINE)
            & (t >= -0.5)
            & (t <= L.length + 0.5)
            & (cos >= TICK_COS[0])
            & (cos <= TICK_COS[1])
        )
        idx = np.nonzero(ok)[0]
        if len(idx) < 2:
            continue
        nodes: list[float] = []
        for k in sorted(idx, key=lambda k: t[k]):
            if not nodes or t[k] - nodes[-1] > NODE_MERGE:
                nodes.append(float(t[k]))
        if len(nodes) < 2:
            continue
        tick_of[L.i] = [ticks[k].i for k in idx]
        for a, b in zip(nodes, nodes[1:]):
            links.append((L, a, b))
    if not links:
        return []
    # подписи: каждое число — ближайшему звену, звено — ближайшему к середине числу
    cand = [
        (k, w, _number(w.text, meters))
        for k, w in enumerate(sh.words)
        if k not in sh.used_words
    ]
    cand = [(k, w, v) for k, w, v in cand if v is not None]
    best: dict[int, tuple[float, int, float]] = {}
    for k, w, v in cand:
        cx, cy = w.c
        half = min(w.box[2] - w.box[0], w.box[3] - w.box[1]) / 2
        pick = None
        for li, (L, a, b) in enumerate(links):
            ux, uy = L.u
            t = (cx - L.x0) * ux + (cy - L.y0) * uy
            if not a - 0.5 <= t <= b + 0.5:
                continue
            d = abs((cx - L.x0) * -uy + (cy - L.y0) * ux)
            if d > LABEL_GAP + half:
                continue
            score = d + 0.1 * abs(t - (a + b) / 2)
            if pick is None or score < pick[0]:
                pick = (score, li)
        if pick is None:
            continue
        score, li = pick
        if li not in best or score < best[li][0]:
            best[li] = (score, k, v)
    out = []
    for li, (_, k, v) in sorted(best.items()):
        L, a, b = links[li]
        ux, uy = L.u
        p0 = (L.x0 + ux * a, L.y0 + uy * a)
        p1 = (L.x0 + ux * b, L.y0 + uy * b)
        sh.used_words.add(k)
        sh.used.add(L.i)
        sh.used.update(tick_of.get(L.i, ()))
        out.append(
            {
                "value_mm": v,
                "len": b - a,
                "p0": p0,
                "p1": p1,
                "word": sh.words[k],
                "line": L,
            }
        )
    # выносные: перпендикуляры, кончающиеся у размерной линии
    dl = [d["line"] for d in out]
    for s in _straight(sh):
        for L in dl:
            if abs(s.u[0] * L.u[0] + s.u[1] * L.u[1]) > 0.1:
                continue
            for p in ((s.x0, s.y0), (s.x1, s.y1)):
                if _dist_pt_seg(p, L) <= EXT_REACH:
                    sh.used.add(s.i)
                    break
    return out


# ─────────────────────────────────────────────── ENT-03 оси


def _circles(sh: Sheet) -> list[tuple[Pt, float, int]]:
    out = []
    for pid, ss in sh.paths.items():
        if len(ss) < 8 or sum(s.curve for s in ss) < 0.75 * len(ss):
            continue
        if math.dist((ss[0].x0, ss[0].y0), (ss[-1].x1, ss[-1].y1)) > 0.05:
            continue
        b = _union(_seg_box(s) for s in ss)
        w, h = b[2] - b[0], b[3] - b[1]
        if w <= 0 or not 0.85 <= h / w <= 1.15:
            continue
        out.append((((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), (w + h) / 4, pid))
    return out


def _axis_order(mark: str) -> tuple[int, int]:
    if mark.isdigit():
        return (0, int(mark))
    return (1, AXIS_LETTERS.index(mark) if mark in AXIS_LETTERS else 100 + ord(mark[0]))


def find_axes(sh: Sheet) -> list[dict]:
    """Оси: {mark, family, p0, p1, bubbles}. Линия — самая длинная, выходящая из кружка радиально."""
    straight = [s for s in _straight(sh) if s.length >= AXIS_MIN]
    found: dict[str, dict] = {}
    for c, r, pid in _circles(sh):
        if not BUBBLE_D[0] <= 2 * r <= BUBBLE_D[1]:
            continue
        mark = None
        for k, w in enumerate(sh.words):
            if math.dist(w.c, c) <= r and AXIS_MARK_RE.match(w.text):
                mark = (k, w.text)
                break
        if mark is None:
            # ParsedDoc на листе с /Rotate склеивает одиночную цифру марки с соседним словом — берём символы внутри кружка
            inside = "".join(ch for ch, b in sh.chars if math.dist(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), c) <= r)
            if AXIS_MARK_RE.match(inside):
                mark = (-1, inside)
        if mark is None:
            continue
        best = None
        for s in straight:
            for p, q in (((s.x0, s.y0), (s.x1, s.y1)), ((s.x1, s.y1), (s.x0, s.y0))):
                d = math.dist(p, c)
                if not 0.6 * r <= d <= 1.6 * r:
                    continue
                v = ((p[0] - c[0]) / d, (p[1] - c[1]) / d)
                ux, uy = (q[0] - p[0]) / s.length, (q[1] - p[1]) / s.length
                if v[0] * ux + v[1] * uy < 0.95:
                    continue
                if best is None or s.length > best.length:
                    best = s
        if best is None:
            continue
        sh.used_words.add(mark[0])
        sh.used.add(best.i)
        for s in sh.paths[pid]:
            sh.used.add(s.i)
        a = found.setdefault(mark[1], {"mark": mark[1], "family": "num" if mark[1].isdigit() else "let", "segs": [],
                                       "bubbles": []})  # fmt: skip
        a["segs"].append(best)
        a["bubbles"].append((c, r))
    out = []
    for a in found.values():
        s0 = max(a["segs"], key=lambda s: s.length)
        ux, uy = s0.u
        pts = [p for s in a["segs"] for p in ((s.x0, s.y0), (s.x1, s.y1))]
        ts = [(p[0] - s0.x0) * ux + (p[1] - s0.y0) * uy for p in pts]
        p0 = (s0.x0 + ux * min(ts), s0.y0 + uy * min(ts))
        p1 = (s0.x0 + ux * max(ts), s0.y0 + uy * max(ts))
        out.append(
            {
                "mark": a["mark"],
                "family": a["family"],
                "p0": p0,
                "p1": p1,
                "bubbles": a["bubbles"],
            }
        )
    return sorted(out, key=lambda a: _axis_order(a["mark"]))


def _intersect(a0: Pt, a1: Pt, b0: Pt, b1: Pt) -> Pt | None:
    d1 = (a1[0] - a0[0], a1[1] - a0[1])
    d2 = (b1[0] - b0[0], b1[1] - b0[1])
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return None
    t = ((b0[0] - a0[0]) * d2[1] - (b0[1] - a0[1]) * d2[0]) / den
    return (a0[0] + d1[0] * t, a0[1] + d1[1] * t)


def _line_dist(p: Pt, a0: Pt, a1: Pt) -> float:
    dx, dy = a1[0] - a0[0], a1[1] - a0[1]
    n = math.hypot(dx, dy)
    if n == 0:
        return math.dist(p, a0)  # вырожденная линия — расстояние до точки, а не ноль
    return abs((p[0] - a0[0]) * dy - (p[1] - a0[1]) * dx) / n

def _on_axes(dim: dict, axes: list[dict], tol: float = 0.5) -> tuple[str, str] | None:
    """Марки осей, на которых лежат концы размера (для ключа и шага осей)."""
    ends = []
    for p in (dim["p0"], dim["p1"]):
        hit = [a["mark"] for a in axes if _line_dist(p, a["p0"], a["p1"]) <= tol]
        if len(hit) != 1:
            return None
        ends.append(hit[0])
    return (ends[0], ends[1]) if ends[0] != ends[1] else None


# ─────────────────────────────────────────────── NRM-09 лист → оси здания


def fit_affine(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Аффинное src → dst наименьшими квадратами: [a, b, c, d, e, f], x' = a·x + c·y + e, y' = b·x + d·y + f."""
    A = np.hstack([src, np.ones((len(src), 1))])
    sol, *_ = np.linalg.lstsq(A, dst, rcond=None)
    return np.array([sol[0, 0], sol[0, 1], sol[1, 0], sol[1, 1], sol[2, 0], sol[2, 1]])


def apply_affine(m, pts) -> np.ndarray:
    pts = np.asarray(pts, dtype=float).reshape(-1, 2)
    a, b, c, d, e, f = m
    return np.stack(
        [a * pts[:, 0] + c * pts[:, 1] + e, b * pts[:, 0] + d * pts[:, 1] + f], axis=1
    )


def ransac_affine(
    src, dst, tol: float, iters: int = RANSAC_ITERS, seed: int = 0
) -> tuple[np.ndarray | None, np.ndarray]:
    """RANSAC по тройкам точек, затем наименьшие квадраты по согласным. Меньше трёх — (None, пусто)."""
    src, dst = np.asarray(src, float), np.asarray(dst, float)
    n = len(src)
    if n < 3:
        return None, np.zeros(n, bool)
    rng = np.random.default_rng(seed)
    best = np.zeros(n, bool)
    for _ in range(iters if n > 3 else 1):
        idx = rng.choice(n, 3, replace=False)
        if abs(np.linalg.det(np.hstack([src[idx], np.ones((3, 1))]))) < 1e-9:
            continue
        m = fit_affine(src[idx], dst[idx])
        err = np.linalg.norm(apply_affine(m, src) - dst, axis=1)
        inl = err <= tol
        if inl.sum() > best.sum():
            best = inl
            if best.all():
                break
    if best.sum() < 3:
        return None, best
    return fit_affine(src[best], dst[best]), best


def building_frame(axes: list[dict], dims: list[dict], n: float) -> dict:
    """NRM-09: пересечения цифровых и буквенных осей → координаты здания (x — по цифровым, y — по буквенным;
    шаг — число размера между осями, без размера — измеренный по масштабу) → аффинное лист → здание."""
    none = {"to_bld": None, "residual_mm": None, "anchors": 0}
    fam = {f: [a for a in axes if a["family"] == f] for f in ("num", "let")}
    if len(fam["num"]) < 2 or len(fam["let"]) < 2:
        return none
    steps: dict[tuple[str, str], float] = {}
    for d in dims:
        key = _on_axes(d, axes)
        if key and not d.get("conditional"):
            steps[tuple(sorted(key, key=_axis_order))] = d["value_mm"]
    coord: dict[str, float] = {}
    for f, lst in fam.items():
        lst = sorted(lst, key=lambda a: _axis_order(a["mark"]))
        v = 0.0
        coord[lst[0]["mark"]] = v
        for a, b in zip(lst, lst[1:]):
            step = steps.get((a["mark"], b["mark"]))
            if step is None:
                mid = ((b["p0"][0] + b["p1"][0]) / 2, (b["p0"][1] + b["p1"][1]) / 2)
                step = _line_dist(mid, a["p0"], a["p1"]) * n
            v += step
            coord[b["mark"]] = v
    src, dst = [], []
    for a in fam["num"]:
        for b in fam["let"]:
            p = _intersect(a["p0"], a["p1"], b["p0"], b["p1"])
            if p is not None:
                src.append(p)
                dst.append((coord[a["mark"]], coord[b["mark"]]))
    m, inl = ransac_affine(src, dst, FRAME_TOL_MM)
    if m is None:
        return {**none, "anchors": int(inl.sum())}
    err = np.linalg.norm(
        apply_affine(m, np.asarray(src)[inl]) - np.asarray(dst)[inl], axis=1
    )
    return {"to_bld": [round(float(v), 9) for v in m], "residual_mm": round(float(np.sqrt(np.mean(err**2))), 3),
            "anchors": int(inl.sum())}  # fmt: skip


# ─────────────────────────────────────────────── ENT-12 лестницы и шахты


def find_stairs(sh: Sheet, n: float, region) -> list[dict]:
    out = []
    cand = [
        s
        for s in _straight(sh)
        if STEP_LEN[0] <= s.length * n <= STEP_LEN[1] and _inside(s.mid, region)
    ]
    groups: dict[tuple[int, int], list[Seg]] = {}
    for s in cand:
        ang = math.degrees(math.atan2(s.u[1], s.u[0])) % 180
        groups.setdefault((round(ang) % 180, round(s.length * 2)), []).append(s)
    for g in groups.values():
        if len(g) < STAIR_MIN:
            continue
        ux, uy = g[0].u
        nx, ny = -uy, ux
        g = sorted(g, key=lambda s: s.mid[0] * nx + s.mid[1] * ny)
        runs, cur = [], [g[0]]
        for a, b in zip(g, g[1:]):
            gap = (b.mid[0] - a.mid[0]) * nx + (b.mid[1] - a.mid[1]) * ny
            along = abs((b.mid[0] - a.mid[0]) * ux + (b.mid[1] - a.mid[1]) * uy)
            step0 = (
                (
                    (cur[1].mid[0] - cur[0].mid[0]) * nx
                    + (cur[1].mid[1] - cur[0].mid[1]) * ny
                )
                if len(cur) > 1
                else gap
            )
            if (
                TREAD[0] <= gap * n <= TREAD[1]
                and along < 0.5
                and abs(gap - step0) <= 0.05 * step0
            ):
                cur.append(b)
            else:
                runs.append(cur)
                cur = [b]
        runs.append(cur)
        for run in runs:
            if len(run) < STAIR_MIN:
                continue
            p = [
                (run[k + 1].mid[0] - run[k].mid[0]) * nx
                + (run[k + 1].mid[1] - run[k].mid[1]) * ny
                for k in range(len(run) - 1)
            ]
            tread = float(np.mean(p)) * n
            box = _union(_seg_box(s) for s in run)
            riser = None
            steps_txt = None
            for w in sh.words:
                if math.dist(w.c, ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)) > 25:
                    continue
                m = RISER_TEXT.search(w.line)
                if m:
                    riser = float(m.group(1))
                m2 = STAIR_TEXT.search(w.line)
                if m2:
                    steps_txt = int(m2.group(1))
            for s in run:
                sh.used.add(s.i)
            # тетивы: поперёк ступеней, от первой ступени до последней — часть лестницы, не грань стены
            first, last = run[0], run[-1]
            for s in _straight(sh):
                if abs(s.u[0] * ux + s.u[1] * uy) > 0.1:
                    continue
                ends = ((s.x0, s.y0), (s.x1, s.y1))
                if all(min(_line_dist(p, (first.x0, first.y0), (first.x1, first.y1)), _line_dist(p, (last.x0, last.y0), (last.x1, last.y1))) <= 0.5
                       for p in ends):  # fmt: skip
                    sh.used.add(s.i)
            out.append({"kind": "stair", "steps": len(run), "riser_mm": riser, "tread_mm": round(tread, 1), "slope_pct": None,
                        "shaft_mm": None, "bbox": sh.frac(box), "_box": box, "_steps_label": steps_txt})  # fmt: skip
    # лифтовая шахта: прямоугольник с обеими диагоналями
    corners = {pid: pts for pid, pts in _closed_polys(sh).items() if len(pts) == 4}
    straight = _straight(sh)
    for pid, pts in corners.items():
        sides = [math.dist(pts[k], pts[(k + 1) % 4]) * n for k in range(4)]
        if not all(SHAFT_MM[0] <= v <= SHAFT_MM[1] for v in sides):
            continue
        if not _inside(np.mean(pts, axis=0), region):
            continue
        diag = []
        for a, b in ((pts[0], pts[2]), (pts[1], pts[3])):
            hit = next(
                (
                    s
                    for s in straight
                    if _same_ends(a, b, (s.x0, s.y0), (s.x1, s.y1))
                ),
                None,
            )
            if hit is not None:
                diag.append(hit)
        if len(diag) != 2:
            continue
        for s in diag + sh.paths[pid]:
            sh.used.add(s.i)
        box = _pts_box(pts)
        out.append({"kind": "lift", "steps": None, "riser_mm": None, "tread_mm": None, "slope_pct": None,
                    "shaft_mm": sorted([round((sides[0] + sides[2]) / 2, 1), round((sides[1] + sides[3]) / 2, 1)]),
                    "bbox": sh.frac(box), "_box": box})  # fmt: skip
    return out


def _same_ends(a: Pt, b: Pt, p: Pt, q: Pt, tol: float = 0.3) -> bool:
    return (math.dist(a, p) <= tol and math.dist(b, q) <= tol) or (math.dist(a, q) <= tol and math.dist(b, p) <= tol)


class _Snap:
    """Слияние точек в пределах tol: ключ — первая точка кластера. Сетка с поиском по соседним ячейкам — округление
    к сетке развело бы две совпадающие точки по разные стороны границы ячейки."""

    def __init__(self, tol: float):
        self.tol, self.cells = tol, {}

    def __call__(self, p: Pt) -> tuple[float, float]:
        cx, cy = int(math.floor(p[0] / self.tol)), int(math.floor(p[1] / self.tol))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in self.cells.get((cx + dx, cy + dy), ()):
                    if math.dist(p, q) <= self.tol:
                        return q
        key = (float(p[0]), float(p[1]))
        self.cells.setdefault((cx, cy), []).append(key)
        return key


def _inside(p, region) -> bool:
    if region is None:
        return True
    return region[0] <= p[0] <= region[2] and region[1] <= p[1] <= region[3]


# ─────────────────────────────────────────────── ENT-11 стены, ENT-10 проёмы


def find_walls(sh: Sheet, n: float, region) -> list[dict]:
    """Стены — взаимно ближайшие пары параллельных граней одного пера: {a, b (ось), t (мм листа), segs, fire}."""
    cand = [
        s
        for s in _straight(sh)
        if not s.dash and s.length * n >= WALL_MIN_LEN and _inside(s.mid, region)
    ]
    tmin, tmax = WALL_T[0] / n, WALL_T[1] / n
    near: dict[
        tuple[int, int], tuple[float, int]
    ] = {}  # (отрезок, сторона) → (расстояние, партнёр)
    for i, a in enumerate(cand):
        ux, uy = a.u
        for j, b in enumerate(cand):
            if i == j or abs(ux * b.u[1] - uy * b.u[0]) > PARALLEL_SIN:
                continue
            if a.rgba != b.rgba or abs(a.width - b.width) > SAME_WIDTH * max(
                a.width, b.width, 1e-6
            ):
                continue
            off = (b.mid[0] - a.x0) * -uy + (b.mid[1] - a.y0) * ux
            d = abs(off)
            if not tmin <= d <= tmax:
                continue
            tb = sorted(
                (
                    (b.x0 - a.x0) * ux + (b.y0 - a.y0) * uy,
                    (b.x1 - a.x0) * ux + (b.y1 - a.y0) * uy,
                )
            )
            lo, hi = max(0.0, tb[0]), min(a.length, tb[1])
            if hi - lo < max(2 * d, WALL_MIN_LEN / n) or hi - lo < 0.5 * min(
                a.length, b.length
            ):
                continue
            side = 1 if off > 0 else -1
            if (i, side) not in near or d < near[(i, side)][0]:
                near[(i, side)] = (d, j)
    walls, seen = [], set()
    for (i, side), (d, j) in near.items():
        if near.get((j, -side), (0, -1))[1] != i or (j, i) in seen:
            continue
        seen.add((i, j))
        a, b = cand[i], cand[j]
        ux, uy = a.u
        tb = sorted(
            (
                (b.x0 - a.x0) * ux + (b.y0 - a.y0) * uy,
                (b.x1 - a.x0) * ux + (b.y1 - a.y0) * uy,
            )
        )
        lo, hi = max(0.0, tb[0]), min(a.length, tb[1])
        nx, ny = -uy * side * d / 2, ux * side * d / 2
        p0 = (a.x0 + ux * lo + nx, a.y0 + uy * lo + ny)
        p1 = (a.x0 + ux * hi + nx, a.y0 + uy * hi + ny)
        if p1[0] - p0[0] < -1e-6 or (abs(p1[0] - p0[0]) <= 1e-6 and p1[1] < p0[1]):
            p0, p1 = p1, p0  # направление канонично: слева направо, сверху вниз
        walls.append(
            {"a": p0, "b": p1, "t": d, "segs": (a, b), "fire": False, "hatch": None}
        )
    for w in walls:
        for s in w["segs"]:
            sh.used.add(s.i)
    # штриховка противопожарной стены: тонкие наклонные внутри полосы
    for s in _straight(sh):
        if s.length * n > 2 * WALL_T[1]:
            continue
        for w in walls:
            wu = _unit(w["a"], w["b"])
            c = abs(s.u[0] * wu[0] + s.u[1] * wu[1])
            if not 0.3 <= c <= 0.95:
                continue
            m = s.mid
            t = (m[0] - w["a"][0]) * wu[0] + (m[1] - w["a"][1]) * wu[1]
            off = abs((m[0] - w["a"][0]) * -wu[1] + (m[1] - w["a"][1]) * wu[0])
            if off < w["t"] / 2 and 0 <= t <= math.dist(w["a"], w["b"]):
                w.setdefault("_hatch", []).append(s)
                break
    for w in walls:
        if len(w.get("_hatch", [])) >= 2:
            w["fire"], w["hatch"] = True, "diag"
            for s in w["_hatch"]:
                sh.used.add(s.i)
    return walls


def _unit(a: Pt, b: Pt) -> Pt:
    d = math.dist(a, b) or 1.0
    return ((b[0] - a[0]) / d, (b[1] - a[1]) / d)


def _arcs(sh: Sheet) -> list[dict]:
    """Незамкнутые пути из кривых: окружность наименьшими квадратами (Каса) — центр, радиус, концы."""
    out = []
    for pid, ss in sh.paths.items():
        if len(ss) < 4 or not all(s.curve for s in ss):
            continue
        p0, p1 = (ss[0].x0, ss[0].y0), (ss[-1].x1, ss[-1].y1)
        if math.dist(p0, p1) < 0.05:
            continue
        pts = np.array([p0] + [(s.x1, s.y1) for s in ss])
        A = np.column_stack([pts[:, 0], pts[:, 1], np.ones(len(pts))])
        b = (pts**2).sum(axis=1)
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        cx, cy = sol[0] / 2, sol[1] / 2
        r2 = sol[2] + cx * cx + cy * cy
        if r2 <= 0:
            continue
        out.append(
            {
                "c": (cx, cy),
                "r": math.sqrt(r2),
                "p0": p0,
                "p1": p1,
                "pid": pid,
                "mid": tuple(pts[len(pts) // 2]),
            }
        )
    return out


def find_openings(
    sh: Sheet, walls: list[dict], dims: list[dict], n: float
) -> tuple[list[dict], list[dict]]:
    """Проёмы между соосными кусками стен. Возвращает (проёмы, стены без «стекла» окон)."""
    lines: list[list[int]] = []
    for k, w in enumerate(walls):
        u = _unit(w["a"], w["b"])
        for grp in lines:
            g = walls[grp[0]]
            gu = _unit(g["a"], g["b"])
            if abs(u[0] * gu[1] - u[1] * gu[0]) <= PARALLEL_SIN and _line_dist(w["a"], g["a"], g["b"]) <= COLLINEAR \
                    and abs(w["t"] - g["t"]) <= 0.1 * g["t"]:  # fmt: skip
                grp.append(k)
                break
        else:
            lines.append([k])
    arcs = _arcs(sh)
    glass: set[int] = set()
    out = []
    for grp in lines:
        if len(grp) < 2:
            continue
        g0 = walls[grp[0]]
        u = _unit(g0["a"], g0["b"])
        o = g0["a"]

        def t(p):
            return (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1]

        pieces = sorted(
            (
                (
                    min(t(walls[k]["a"]), t(walls[k]["b"])),
                    max(t(walls[k]["a"]), t(walls[k]["b"])),
                    k,
                )
                for k in grp
            )
        )
        for (a0, a1, ka), (b0, b1, kb) in zip(pieces, pieces[1:]):
            gap = b0 - a1
            if not GAP_MM[0] <= gap * n <= GAP_MM[1]:
                continue
            ga, gb = (
                (o[0] + u[0] * a1, o[1] + u[1] * a1),
                (o[0] + u[0] * b0, o[1] + u[1] * b0),
            )
            center = ((ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2)
            th = g0["t"]
            kind = clear = swing = None
            # окно: тонкая «стена» — стекло — внутри разрыва на той же оси
            for k, w in enumerate(walls):
                if k in grp or k in glass or w["t"] >= th:
                    continue
                if (
                    _line_dist(w["a"], g0["a"], g0["b"]) <= th / 2
                    and a1 - 0.3 <= t(w["a"]) <= b0 + 0.3
                    and a1 - 0.3 <= t(w["b"]) <= b0 + 0.3
                ):
                    glass.add(k)
                    kind, clear = "window", gap * n
            if kind is None:
                for arc in arcs:
                    tc = t(arc["c"])
                    off = (arc["c"][0] - o[0]) * -u[1] + (arc["c"][1] - o[1]) * u[0]
                    if (
                        abs(off) > th / 2 + 1.0
                        or not a1 - 0.2 * gap <= tc <= b0 + 0.2 * gap
                    ):
                        continue
                    if not 0.5 * gap <= arc["r"] <= 1.05 * gap:
                        continue
                    kind = "gate" if gap * n >= GATE_MM else "door"
                    clear = arc["r"] * n
                    moff = (arc["mid"][0] - o[0]) * -u[1] + (arc["mid"][1] - o[1]) * u[
                        0
                    ]
                    swing = ("a" if tc - a1 < b0 - tc else "b") + (
                        "+" if moff > 0 else "-"
                    )
                    for s in sh.paths[arc["pid"]]:
                        sh.used.add(s.i)
                    # полотно — прямой отрезок от центра дуги длиной радиуса
                    for s in _straight(sh):
                        if (
                            min(
                                math.dist((s.x0, s.y0), arc["c"]),
                                math.dist((s.x1, s.y1), arc["c"]),
                            )
                            < 0.3
                            and abs(s.length - arc["r"]) < 0.1 * arc["r"]
                        ):
                            sh.used.add(s.i)
                    break
            if kind is None:
                continue
            mark = None
            reach = max(gap * 1.2, 8.0)
            best = None
            for k, w in enumerate(sh.words):
                if k in sh.used_words or not MARK_RE.match(w.text):
                    continue
                d = math.dist(w.c, center)
                if d <= reach and (best is None or d < best[0]):
                    best = (d, k)
            if best is not None:
                mark = sh.words[best[1]].text
                sh.used_words.add(best[1])
            label = None
            for d in dims:
                ends = sorted((t(d["p0"]), t(d["p1"])))
                if abs(ends[0] - a1) <= 0.5 and abs(ends[1] - b0) <= 0.5:
                    label = d["value_mm"]
            box = _pts_box(
                [
                    _off(ga, u, th / 2),
                    _off(ga, u, -th / 2),
                    _off(gb, u, th / 2),
                    _off(gb, u, -th / 2),
                ]
            )
            out.append({"mark": mark, "kind": kind, "width_mm": round(gap * n, 1), "clear_mm": round(clear, 1), "swing": swing,
                        "wall": ka, "bbox": sh.frac(box), "_center": center, "label_mm": label, "_box": box})  # fmt: skip
    kept = [w for k, w in enumerate(walls) if k not in glass]
    remap = {id(w): i for i, w in enumerate(kept)}
    for op in out:
        op["wall"] = remap.get(id(walls[op["wall"]]))
    return out, kept


def _off(p: Pt, u: Pt, d: float) -> Pt:
    return (p[0] - u[1] * d, p[1] + u[0] * d)


# ─────────────────────────────────────────────── ENT-05 отметки


def parse_level(text: str) -> float | None:
    m = LEVEL_RE.match(text.replace(" ", ""))
    if not m:
        return None
    v = int(m.group(2)) + int(m.group(3)) / 1000
    return -v if m.group(1) in ("-", "−") else v


def find_levels(sh: Sheet) -> list[dict]:
    tris = []
    for pid, pts in _closed_polys(sh).items():
        if len(pts) == 3:
            b = _pts_box(pts)
            if max(b[2] - b[0], b[3] - b[1]) <= 5.0:
                tris.append((pid, b))
    out = []
    for k, w in enumerate(sh.words):
        v = parse_level(w.text)
        if v is None or k in sh.used_words:
            continue
        near = [
            t
            for t in tris
            if math.dist(w.c, ((t[1][0] + t[1][2]) / 2, (t[1][1] + t[1][3]) / 2))
            <= LEVEL_NEAR
        ]
        if not near:
            continue
        ctx = " ".join(x.text.lower() for x in sh.words if math.dist(x.c, w.c) <= 15)
        kind = (
            "slab_top"
            if re.search(r"в\.\s*п|плит", ctx)
            else "bottom"
            if "низ" in ctx
            else "floor"
        )
        sh.used_words.add(k)
        for s in sh.paths[near[0][0]]:
            sh.used.add(s.i)
        box = _union([w.box, near[0][1]])
        out.append(
            {
                "value_m": v,
                "kind": kind,
                "absolute": abs(v) >= 50 or "абс" in ctx,
                "bbox": sh.frac(box),
                "_box": box,
            }
        )
    return out


# ─────────────────────────────────────────────── ENT-01 помещения


def _ray(p: Pt, d: Pt, faces: list[tuple[Pt, Pt]]) -> float | None:
    best = None
    for a, b in faces:
        ex, ey = b[0] - a[0], b[1] - a[1]
        den = d[0] * ey - d[1] * ex
        if abs(den) < 1e-12:
            continue
        t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den
        s = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den
        if t > 1e-6 and -1e-6 <= s <= 1 + 1e-6 and (best is None or t < best):
            best = t
    return best


def find_rooms(
    sh: Sheet, walls: list[dict], openings: list[dict], n: float, region
) -> list[dict]:
    faces = []
    for w in walls:
        u = _unit(w["a"], w["b"])
        for s in (1, -1):
            faces.append(
                (_off(w["a"], u, s * w["t"] / 2), _off(w["b"], u, s * w["t"] / 2))
            )
    for op in openings:  # проём закрывается — луч не уходит в соседнее помещение
        w = walls[op["wall"]] if op["wall"] is not None else None
        if w is None:
            continue
        u = _unit(w["a"], w["b"])
        c = op["_center"]
        half = op["width_mm"] / n / 2 + 0.5
        for s in (1, -1):
            faces.append((_off((c[0] - u[0] * half, c[1] - u[1] * half), u, s * w["t"] / 2),
                          _off((c[0] + u[0] * half, c[1] + u[1] * half), u, s * w["t"] / 2)))  # fmt: skip
    if not walls:
        return []
    u = _unit(walls[0]["a"], walls[0]["b"])
    dirs = [u, (-u[1], u[0]), (-u[0], -u[1]), (u[1], -u[0])]
    out = []
    for k, w in enumerate(sh.words):
        if k in sh.used_words or not ROOM_RE.match(w.text) or not _inside(w.c, region):
            continue
        hits = [_ray(w.c, d, faces) for d in dirs]
        if any(h is None for h in hits):
            continue
        pts = [(w.c[0] + dirs[0][0] * hits[0] + dirs[1][0] * hits[1], w.c[1] + dirs[0][1] * hits[0] + dirs[1][1] * hits[1]),
               (w.c[0] + dirs[1][0] * hits[1] + dirs[2][0] * hits[2], w.c[1] + dirs[1][1] * hits[1] + dirs[2][1] * hits[2]),
               (w.c[0] + dirs[2][0] * hits[2] + dirs[3][0] * hits[3], w.c[1] + dirs[2][1] * hits[2] + dirs[3][1] * hits[3]),
               (w.c[0] + dirs[3][0] * hits[3] + dirs[0][0] * hits[0], w.c[1] + dirs[3][1] * hits[3] + dirs[0][1] * hits[0])]  # fmt: skip
        area = (hits[0] + hits[2]) * (hits[1] + hits[3]) * n * n / 1e6
        label = None
        for j, x in enumerate(sh.words):
            if (
                j != k
                and j not in sh.used_words
                and AREA_RE.match(x.text)
                and math.dist(x.c, w.c) <= 8.0
            ):
                label = float(x.text.replace(",", "."))
                sh.used_words.add(j)
                break
        sh.used_words.add(k)
        box = _pts_box(pts)
        out.append({"number": w.text, "polygon": [_r(p) for p in pts], "area_m2": round(area, 3), "area_label_m2": label,
                    "bbox": sh.frac(box), "_short_mm": min(hits[0] + hits[2], hits[1] + hits[3]) * n})  # fmt: skip
    return out


# ─────────────────────────────────────────────── ENT-09 трассы


def _style(s: Seg) -> tuple:
    return (round(s.width, 2), s.rgba, s.dash)


def _section(t: str) -> str:
    return (
        re.sub(r"\s+", "", t)
        .replace("Ø", "ø")
        .replace("⌀", "ø")
        .replace("x", "×")
        .replace("х", "×")
    )


def route_labels(sh: Sheet) -> list[dict]:
    """Подписи трасс «система сечение»: одним словом («П1-ø250») или парой слов — система и ближайшее к ней
    сечение не дальше ROUTE_PAIR мм (строки ParsedDoc на повёрнутом листе рвут подпись)."""
    out = []
    sys_w, sec_w = [], []
    for k, w in enumerate(sh.words):
        if k in sh.used_words:
            continue
        m = ROUTE_LABEL.fullmatch(w.text)
        if m:
            out.append(
                {
                    "system": m.group("sys"),
                    "section": _section(m.group("sec")),
                    "box": w.box,
                    "c": w.c,
                }
            )
            continue
        if ROUTE_SYS.fullmatch(w.text):
            sys_w.append(w)
        elif ROUTE_SEC.fullmatch(w.text):
            sec_w.append(w)
    free = list(sec_w)
    for w in sys_w:
        near = [(_box_gap(w.box, x.box), i) for i, x in enumerate(free)]
        near = [z for z in near if z[0] <= ROUTE_PAIR]
        if not near:
            continue
        _, i = min(near)
        x = free.pop(i)
        box = _union([w.box, x.box])
        out.append(
            {
                "system": w.text,
                "section": _section(x.text),
                "box": box,
                "c": ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
            }
        )
    return out


def find_routes(sh: Sheet) -> list[dict]:
    labels = route_labels(sh)
    if not labels:
        return []
    snap = _Snap(SNAP)
    by_style: dict[tuple, list[Seg]] = {}
    for s in _straight(sh):
        by_style.setdefault(_style(s), []).append(s)
    comps = []
    for segs in by_style.values():
        # Т-образные примыкания: конец отрезка на середине другого — узел, отрезок делится
        pieces: list[tuple[Pt, Pt, Seg]] = []
        ends = [p for s in segs for p in ((s.x0, s.y0), (s.x1, s.y1))]
        for s in segs:
            ts = [0.0, s.length]
            ux, uy = s.u
            for p in ends:
                t = (p[0] - s.x0) * ux + (p[1] - s.y0) * uy
                if SNAP < t < s.length - SNAP and _dist_pt_seg(p, s) <= SNAP:
                    ts.append(t)
            ts = sorted(set(ts))
            for a, b in zip(ts, ts[1:]):
                pieces.append(
                    ((s.x0 + ux * a, s.y0 + uy * a), (s.x0 + ux * b, s.y0 + uy * b), s)
                )
        parent: dict = {}

        def find(k):
            while parent.setdefault(k, k) != k:
                parent[k] = parent[parent[k]]
                k = parent[k]
            return k

        for a, b, _ in pieces:
            ka, kb = snap(a), snap(b)
            parent[find(ka)] = find(kb)
        groups: dict = {}
        for a, b, s in pieces:
            groups.setdefault(find(snap(a)), []).append((a, b, s))
        comps.extend(groups.values())
    # подпись — ближайшей компоненте
    taken: dict[int, dict] = {}
    for lab in labels:
        best = None
        for ci, comp in enumerate(comps):
            if sum(math.dist(a, b) for a, b, _ in comp) < ROUTE_MIN:
                continue  # засечка, полка, штрих знака — не трасса
            d = min(_dist_pt_seg(lab["c"], s) for _, _, s in comp)
            if d <= ROUTE_NEAR and (best is None or d < best[0]):
                best = (d, ci)
        if best is not None and best[1] not in taken:
            taken[best[1]] = lab
    out = []
    for ci, lab in taken.items():
        comp = comps[ci]
        adj: dict = {}
        pos: dict = {}
        for a, b, _ in comp:
            ka, kb = snap(a), snap(b)
            pos.setdefault(ka, a)
            pos.setdefault(kb, b)
            if ka != kb:
                adj.setdefault(ka, set()).add(kb)
                adj.setdefault(kb, set()).add(ka)

        def kind(k):
            deg = len(adj.get(k, ()))
            if deg == 1:
                return "end"
            if deg == 3:
                return "tee"
            if deg >= 4:
                return "cross"
            a, b = list(adj[k])
            u1, u2 = _unit(pos[k], pos[a]), _unit(pos[k], pos[b])
            ang = math.degrees(
                math.acos(max(-1.0, min(1.0, -(u1[0] * u2[0] + u1[1] * u2[1]))))
            )
            return "bend" if ang > BEND_DEG else None

        kinds = {k: kind(k) for k in adj}
        nodes = {k: v for k, v in kinds.items() if v}
        ids = {k: i for i, k in enumerate(sorted(nodes, key=lambda k: pos[k]))}
        edges = set()
        for k in nodes:
            for nb in adj[k]:
                prev, cur = k, nb
                while cur not in nodes:
                    nxt = [x for x in adj[cur] if x != prev]
                    if not nxt:
                        break
                    prev, cur = cur, nxt[0]
                if cur in nodes and cur != k:
                    edges.add(tuple(sorted((ids[k], ids[cur]))))
        for _, _, s in comp:
            sh.used.add(s.i)
        pts = [pos[k] for k in adj]
        box = _union([_pts_box(pts), lab["box"]])
        out.append({"system": lab["system"], "section": lab["section"], "points": [_r(p) for p in pts],
                    "nodes": [{"id": ids[k], "kind": nodes[k], "mark": None, "at": _r(pos[k])} for k in sorted(nodes, key=lambda k: ids[k])],
                    "edges": [list(e) for e in sorted(edges)], "bbox": sh.frac(box),
                    "_length": sum(math.dist(a, b) for a, b, _ in comp)})  # fmt: skip
    return out


# ─────────────────────────────────────────────── знаки по легенде


def _sig(ss: list[Seg]) -> tuple:
    b = _union(_seg_box(s) for s in ss)
    return (sum(not s.curve for s in ss), sum(s.curve for s in ss), max(s.fill_mode for s in ss) > 0,
            round((b[2] - b[0]) / SIG_Q), round((b[3] - b[1]) / SIG_Q), ss[0].rgba)  # fmt: skip


def _pcenter(ss: list[Seg]) -> Pt:
    b = _union(_seg_box(s) for s in ss)
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _box_gap(a, b) -> float:
    return max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0.0)


def _phrase(sh: Sheet, ln, start: int) -> tuple[float, float, float, float] | None:
    """Рамка оборота в мм листа: слово с символом start и соседние слова строки без разрыва (≤ PHRASE_GAP).
    Строка ParsedDoc может захватить число размера на той же базовой линии — оно дальше разрыва и не входит."""
    boxes, pos, k = [], 0, None
    for i, wd in enumerate(ln.words):
        b = wd.bbox
        boxes.append(
            (b[0] * sh.w, b[1] * sh.h, b[2] * sh.w, b[3] * sh.h) if b else None
        )
        if k is None and pos + len(wd.text) > start:
            k = i
        pos += len(wd.text) + 1
    if k is None or boxes[k] is None:
        return None
    lo = hi = k
    while (
        lo > 0
        and boxes[lo - 1] is not None
        and _box_gap(boxes[lo - 1], boxes[lo]) <= PHRASE_GAP
    ):
        lo -= 1
    while (
        hi + 1 < len(boxes)
        and boxes[hi + 1] is not None
        and _box_gap(boxes[hi], boxes[hi + 1]) <= PHRASE_GAP
    ):
        hi += 1
    return _union(boxes[lo : hi + 1]), " ".join(w.text for w in ln.words[lo : hi + 1])


def _row_symbol(sh: Sheet, ph, boxes) -> list[int] | None:
    """Пути образца перед оборотом легенды вдоль строки (с любой стороны: лист бывает повёрнут)."""
    horiz = ph[2] - ph[0] >= ph[3] - ph[1]
    c = ((ph[0] + ph[2]) / 2, (ph[1] + ph[3]) / 2)
    best = None
    for side in (-1, 1):
        pids, dmin = [], None
        for pid, pb in boxes.items():
            if max(pb[2] - pb[0], pb[3] - pb[1]) > SYMBOL_MAX:
                continue
            if horiz:
                gap = ph[0] - pb[2] if side < 0 else pb[0] - ph[2]
                perp = abs((pb[1] + pb[3]) / 2 - c[1])
            else:
                gap = ph[1] - pb[3] if side < 0 else pb[1] - ph[3]
                perp = abs((pb[0] + pb[2]) / 2 - c[0])
            if 0 <= gap <= LEGEND_REACH and perp <= 4.0:
                pids.append(pid)
                dmin = gap if dmin is None else min(dmin, gap)
        if pids and (best is None or dmin < best[0]):
            best = (dmin, pids)
    return best[1] if best else None


def _path_boxes(sh: Sheet) -> dict:
    return {pid: _union(_seg_box(s) for s in ss) for pid, ss in sh.paths.items()}


def _legend_rows(sh: Sheet, kinds, lines=None) -> list[tuple[str, list[int], tuple, str]]:
    """Строки легенды: (вид, пути образца перед текстом, рамка оборота, текст оборота)."""
    rows = []
    boxes = _path_boxes(sh)
    for ln in sh.lines if lines is None else lines:
        hit = next(((k, m) for k, rx in kinds if (m := rx.search(ln.text))), None)
        if hit is None or not ln.words:
            continue
        kind, m = hit
        found = _phrase(sh, ln, m.start())
        if found is None:
            continue
        ph, text = found
        pids = _row_symbol(sh, ph, boxes)
        if pids:
            rows.append((kind, pids, ph, text))
    return rows


def _other_rows(sh: Sheet, taken: set[int]) -> list[tuple[str, list[int], tuple, str]]:
    """Строки легенды без вида из словаря — «other» с текстом строки как mark (ADR-0010: неизвестный знак не новый вид).
    Легенда — обороты, начинающиеся у начала заголовка «Условные обозначения» (−5…+25 мм вдоль строки) и не дальше
    LEGEND_BLOCK поперёк неё: ниже заголовка на обычном листе, по любую сторону — на повёрнутом. Оборот берётся от
    слова, а не от начала строки ParsedDoc: строка может захватить число размера на той же базовой линии."""
    # заголовок — пара слов «условные» + «обозначения» рядом: на повёрнутом листе строки ParsedDoc их разрывают
    heads = []
    for a in sh.words:
        if not re.match(r"условн", a.text, re.I):
            continue
        b = next((x for x in sh.words if re.match(r"обознач", x.text, re.I) and _box_gap(a.box, x.box) <= PHRASE_GAP), None)
        if b is not None:
            heads.append(_union([a.box, b.box]))
    if not heads:
        return []
    boxes = _path_boxes(sh)
    rows, seen = [], set()
    for ln in sh.lines:
        pos = 0
        for wd in ln.words:
            start, pos = pos, pos + len(wd.text) + 1
            if not wd.bbox:
                continue
            b = (wd.bbox[0] * sh.w, wd.bbox[1] * sh.h, wd.bbox[2] * sh.w, wd.bbox[3] * sh.h)
            if not any(_in_legend(h, b) for h in heads):
                continue
            found = _phrase(sh, ln, start)
            if found is None or found[0] in seen:
                continue
            ph, text = found
            seen.add(ph)
            if re.search(r"условн|обознач", text, re.I) or any(rx.search(text) for _, rx in SYMBOL_KINDS + SITE_KINDS):
                continue
            pids = _row_symbol(sh, ph, boxes)
            if pids and not set(pids) & taken:
                rows.append(("other", pids, ph, text))
    return rows


def _in_legend(head, b) -> bool:
    """Слово b — в блоке легенды под заголовком head (мм листа)."""
    if head[2] - head[0] >= head[3] - head[1]:
        return -5 <= b[0] - head[0] <= 25 and head[3] < b[1] <= head[3] + LEGEND_BLOCK
    along = -5 <= b[1] - head[1] <= 25 or -5 <= head[3] - b[3] <= 25
    across = 0 < b[0] - head[2] <= LEGEND_BLOCK or 0 < head[0] - b[2] <= LEGEND_BLOCK
    return along and across


def find_symbols(sh: Sheet) -> list[dict]:
    rows = _legend_rows(sh, SYMBOL_KINDS)
    rows += _other_rows(sh, {pid for _, pids, _, _ in rows for pid in pids})
    legend = {pid for _, pids, _, _ in rows for pid in pids}
    sigs: dict[tuple, list[int]] = {}
    for pid, ss in sh.paths.items():
        if pid not in legend and all(s.i not in sh.used for s in ss):
            sigs.setdefault(_sig(ss), []).append(pid)
    out = []
    for kind, pids, _, text in rows:
        tpl = sorted(
            ((_sig(sh.paths[p]), _pcenter(sh.paths[p])) for p in pids),
            key=lambda x: str(x[0]),
        )
        s0, c0 = tpl[0]
        for cand in sigs.get(s0, []):
            cc = _pcenter(sh.paths[cand])
            shift = (cc[0] - c0[0], cc[1] - c0[1])
            group = [cand]
            for sg, c in tpl[1:]:
                want = (c[0] + shift[0], c[1] + shift[1])
                hit = next(
                    (
                        p
                        for p in sigs.get(sg, [])
                        if math.dist(_pcenter(sh.paths[p]), want) <= SYMBOL_TOL
                    ),
                    None,
                )
                if hit is None:
                    break
                group.append(hit)
            else:
                ss = [s for p in group for s in sh.paths[p]]
                if any(s.i in sh.used for s in ss):
                    continue
                for s in ss:
                    sh.used.add(s.i)
                box = _union(_seg_box(s) for s in ss)
                out.append(
                    {
                        "kind": kind,
                        "mark": text if kind == "other" else None,
                        "at": _r(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)),
                        "bbox": sh.frac(box),
                    }
                )
    for pid in legend:
        for s in sh.paths[pid]:
            sh.used.add(s.i)
    return out


# ─────────────────────────────────────────────── ENT-21 генплан


def find_site(sh: Sheet, n: float) -> list[dict]:
    rows = _legend_rows(sh, SITE_KINDS)
    fills: dict[tuple, str] = {}
    legend = set()
    for kind, pids, _, _ in rows:
        for p in pids:
            ss = sh.paths[p]
            if ss[0].fill_mode and ss[0].fill is not None:
                fills.setdefault(ss[0].fill, kind)
                legend.add(p)
    if not rows:
        return []
    out = []
    polys = _closed_polys(sh)
    k2 = n * n / 1e6
    for pid, pts in polys.items():
        if pid in legend:
            continue
        ss = sh.paths[pid]
        box = _pts_box(pts)
        if ss[0].fill_mode and ss[0].fill in fills:
            kind = fills[ss[0].fill]
            area = shoelace(pts)
            item = {"kind": kind, "polygon": [_r(p) for p in pts], "width_mm": None, "area_m2": round(area * k2, 3),
                    "count": None, "bbox": sh.frac(box)}  # fmt: skip
            if kind in ("road", "asphalt"):
                item["width_mm"] = round(strip_width(area, perimeter(pts)) * n, 1)
            out.append(item)
            continue
        if ss[0].fill_mode or len(pts) != 4:
            continue
        sides = sorted([math.dist(pts[0], pts[1]) * n, math.dist(pts[1], pts[2]) * n])
        if (
            STALL_SHORT[0] <= sides[0] <= STALL_SHORT[1]
            and STALL_LONG[0] <= sides[1] <= STALL_LONG[1]
        ):
            mgn = any(
                "МГН" in w.text.upper()
                and box[0] <= w.c[0] <= box[2]
                and box[1] <= w.c[1] <= box[3]
                for w in sh.words
            )
            out.append({"kind": "parking_mgn" if mgn else "parking", "polygon": [_r(p) for p in pts], "width_mm": None,
                        "area_m2": round(shoelace(pts) * k2, 3), "count": 1, "bbox": sh.frac(box)})  # fmt: skip
    return out


# ─────────────────────────────────────────────── лист целиком


def _empty(page: int, why: str | None, scale: dict | None = None) -> dict:
    return {"page": page, "rev": GEOM_REV, "quality": {"status": "NOT_COMPARABLE" if why else "OK", "why": why},
            "scale": scale or {"n": None, "method": None, "spread_pct": 0.0, "n_dims": 0},
            "frame": {"to_bld": None, "residual_mm": None, "anchors": 0},
            "axes": [], "dims": [], "levels": [], "walls": [], "openings": [], "stairs": [], "routes": [], "symbols": [],
            "rooms": [], "site": []}  # fmt: skip


def _public(items: list[dict]) -> list[dict]:
    """Служебные поля «_…» — внутренние, в контракт не идут."""
    return [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]


def analyze_sheet(vec: PageVectors, page: Page | None, deadline: Deadline | None = None, chars: list | None = None) -> dict:
    """PlanGeometry одной страницы по готовым путям и словам (чистая функция без pdfium)."""
    number = vec.page
    if vec.truncated:
        raise GeomError(
            f"страница {number}: путей больше предела — лист не разбирается частично"
        )
    sh = sheet_from(vec, page)
    if chars:
        sh.chars = [(ch, (b[0] * sh.w, b[1] * sh.h, b[2] * sh.w, b[3] * sh.h)) for ch, b in chars]
    strokes = sum(1 for s in sh.segs if s.stroke and not s.curve)
    if strokes < VECTOR_MIN_SEGMENTS or (page is not None and page.source == "ocr"):
        return _empty(number, "NO_VECTOR_LAYER")
    tick = deadline.check if deadline is not None else (lambda: None)
    stamps = [float(s) for s in stamp_scales(page.lines)] if page is not None else []
    dims = find_dims(sh, meters=any(s >= DIM_M_MIN_SCALE for s in stamps))
    tick()
    sc = consensus_scale(
        stamps, [d["value_mm"] / d["len"] for d in dims if d["len"] > 0]
    )
    scale = {
        "n": round(sc["n"], 4) if sc["n"] else None,
        "method": sc["method"],
        "spread_pct": sc["spread_pct"],
        "n_dims": sc["n_dims"],
    }
    if sc["status"] != "OK":
        return _empty(number, sc["why"], scale)
    n = sc["n"]
    for d, ok in zip(dims, sc["inliers"]):
        d["measured_mm"] = d["len"] * n
        d["conditional"] = not ok
    axes = find_axes(sh)
    symbols = find_symbols(
        sh
    )  # до стен: знак на стене (ОЗК) не должен уйти в штриховку
    tick()
    frame = building_frame(axes, dims, n)
    region = None
    if len(axes) >= 2:
        pts = [p for a in axes for p in (a["p0"], a["p1"])]
        region = _pts_box(pts)
    stairs = find_stairs(sh, n, region) if region else []
    tick()
    walls = find_walls(sh, n, region) if region else []
    tick()
    openings, walls = find_openings(sh, walls, dims, n) if walls else ([], walls)
    tick()
    levels = find_levels(sh)
    rooms = find_rooms(sh, walls, openings, n, region) if region else []
    tick()
    tick()
    routes = find_routes(sh)
    tick()
    site = find_site(sh, n)
    tick()
    geo = _empty(number, None, scale)
    geo["frame"] = frame
    geo["axes"] = [
        {
            "mark": a["mark"],
            "p0": _r(a["p0"]),
            "p1": _r(a["p1"]),
            "bbox": sh.frac(_pts_box([a["p0"], a["p1"]])),
        }
        for a in axes
    ]
    geo["dims"] = [{"value_mm": d["value_mm"], "measured_mm": round(d["measured_mm"], 1), "p0": _r(d["p0"]), "p1": _r(d["p1"]),
                    "bbox": sh.frac(_union([_pts_box([d["p0"], d["p1"]]), d["word"].box])), "conditional": d["conditional"]}
                   for d in dims]  # fmt: skip
    geo["walls"] = [{"a": _r(w["a"]), "b": _r(w["b"]), "thickness_mm": round(w["t"] * n, 1), "fire": w["fire"], "hatch": w["hatch"],
                     "bbox": sh.frac(_pts_box([_off(w["a"], _unit(w["a"], w["b"]), s * w["t"] / 2) for s in (1, -1)]
                                              + [_off(w["b"], _unit(w["a"], w["b"]), s * w["t"] / 2) for s in (1, -1)]))}
                    for w in walls]  # fmt: skip
    geo["openings"] = _public(openings)
    geo["stairs"] = _public(stairs)
    geo["levels"] = _public(levels)
    geo["rooms"] = _public(rooms)
    geo["routes"] = _public(routes)
    geo["symbols"] = symbols
    geo["site"] = site
    return geo


def page_words(path: Path, number: int) -> Page:
    """Слова страницы тем же разбором, что ParsedDoc (parse._text_lines), без разбора всего документа и без OCR:
    для замера и вызова plan_geometry без готового ParsedDoc. Под PDFIUM_LOCK."""
    from .parse import MIN_TEXT_CHARS, PDFIUM_LOCK, _text_lines
    from .pagekind import _open

    with PDFIUM_LOCK:
        doc = _open(path)
        try:
            if not 1 <= number <= len(doc):
                raise IndexError(f"нет страницы {number}: в документе {len(doc)}")
            pg = doc[number - 1]
            try:
                lines = _text_lines(pg)
                w, h = pg.get_size()
                rot = pg.get_rotation()
            finally:
                pg.close()
        finally:
            doc.close()
    text = sum(len(ln.text) for ln in lines) >= MIN_TEXT_CHARS
    return Page(page=number, width=w, height=h, rotation=rot, source="text" if text else "ocr", lines=lines if text else [])


def page_chars(path: Path, number: int, limit: int = 200_000) -> list[tuple[str, tuple]]:
    """Символы текстового слоя с рамкой в долях видимой страницы — свой проход pdfium под PDFIUM_LOCK (ParsedDoc не
    меняется). Нужны только как запасной путь для марок осей: на листе с /Rotate разбор склеивает одиночные цифры."""
    from .pagekind import _open
    from .parse import PDFIUM_LOCK, norm_box

    out = []
    with PDFIUM_LOCK:
        doc = _open(path)
        try:
            pg = doc[number - 1]
            tp = pg.get_textpage()
            try:
                for i in range(min(tp.count_chars(), limit)):
                    ch = tp.get_text_range(i, 1)
                    if ch.isspace():
                        continue
                    l, b, r, t = tp.get_charbox(i)
                    if r > l and t > b:
                        out.append((ch, norm_box(pg, l, b, r, t)))
            finally:
                tp.close()
                pg.close()
        finally:
            doc.close()
    return out


def plan_geometry(path: Path, page: int, parsed: Page | None = None, limit_s: float = CV_SHEET_LIMIT_S, clock=time.monotonic) -> dict:
    """PlanGeometry страницы page (с 1) файла path по контракту ADR-0010. parsed — страница ParsedDoc (слова); без неё
    слова читаются тем же разбором текстового слоя (page_words). Дольше limit_s — NOT_COMPARABLE / TIMEOUT без
    частичного результата. Повреждённый файл — CorruptedFile, нет страницы — IndexError, испорченные пути — GeomError."""
    deadline = Deadline(limit_s, clock)
    try:
        if parsed is None:
            parsed = page_words(path, page)
        vec = extract_vectors(path, page)  # сам берёт PDFIUM_LOCK
        chars = page_chars(path, page)
        deadline.check()
        return analyze_sheet(vec, parsed, deadline, chars)
    except CvTimeout:
        return _empty(page, "TIMEOUT")


# ─────────────────────────────────────────────── LNK-03 регистрация двух листов


def register_sheets(a: dict, b: dict, tol_mm: float = FRAME_TOL_MM) -> dict:
    """LNK-03: преобразование листа B в лист A по общим якорям — пересечениям осей с одинаковыми марками и номерам
    помещений (центр контура). Остаток — RMS по согласным якорям в мм натуры (масштаб листа A). Остаток больше
    допуска, меньше трёх якорей или согласных меньше 70 % общих (другой лист с теми же марками) — ok = False: по паре остаются только текстовые и топологические операторы."""
    res = {
        "ok": False,
        "method": "affine",
        "matrix": None,
        "residual_mm": None,
        "anchors": 0,
    }
    na = a.get("scale", {}).get("n")
    if not na or a["quality"]["status"] != "OK" or b["quality"]["status"] != "OK":
        return res
    pa, pb = _anchors(a), _anchors(b)
    common = sorted(set(pa) & set(pb))
    if len(common) < 3:
        return {**res, "anchors": len(common)}
    src = np.array([pb[k] for k in common])
    dst = np.array([pa[k] for k in common])
    m, inl = ransac_affine(src, dst, tol_mm / na)
    if m is None:
        return {**res, "anchors": int(inl.sum())}
    err = np.linalg.norm(apply_affine(m, src[inl]) - dst[inl], axis=1) * na
    rms = float(np.sqrt(np.mean(err**2)))
    share = float(inl.sum()) / len(common)
    return {"ok": rms <= tol_mm and share >= REG_MIN_SHARE, "method": "affine", "matrix": [round(float(v), 9) for v in m], "residual_mm": round(rms, 3),
            "anchors": int(inl.sum())}  # fmt: skip


def _anchors(g: dict) -> dict[str, Pt]:
    out: dict[str, Pt] = {}
    axes = g.get("axes", [])
    for x in axes:
        for y in axes:
            if x["mark"].isdigit() and not y["mark"].isdigit():
                p = _intersect(
                    tuple(x["p0"]), tuple(x["p1"]), tuple(y["p0"]), tuple(y["p1"])
                )
                if p is not None:
                    out[f"ax:{x['mark']}/{y['mark']}"] = p
    for r in g.get("rooms", []):
        pts = r["polygon"]
        out[f"room:{r['number']}"] = (
            sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts),
        )
    return out
