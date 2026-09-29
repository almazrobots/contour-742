"""Измерение на чертеже (OS-INSP-2.4, ТЗ §9.1.3 «CV-модуль»): масштаб по размерным линиям и расстояния между линиями.

Размерная линия — отрезок любой ориентации (горизонтальный, вертикальный, наклонный), рядом с серединой которого
стоит число размера в миллиметрах (ГОСТ 2.307: размер на чертеже — в натуральных мм, независимо от масштаба листа).
Цепочка размеров — одна линия с засечками или выносными линиями в узлах: каждое звено между узлами — отдельная
размерная линия со своей подписью и своей длиной (OS-INSP-2.4.4). Масштаб = мм на пиксель растра.
Две размерные линии (или звена), давшие разный масштаб (> MAX_SCALE_SPREAD), — признак того, что одна из них
прочитана или найдена неверно: тогда система не измеряет ничего (NOT_COMPARABLE), а не выбирает «правдоподобную».

Расстояния (OS-INSP-2.4.5) — между соседними параллельными (угол ≤ PARALLEL_DEG) длинными линиями, стоящими
напротив друг друга, по перпендикуляру, в мм и м. Численный масштаб 1:N (OS-INSP-2.4.6) — из мм на пиксель и
разрешения рендера; масштаб в штампе, расходящийся с измеренным больше чем на 2 %, — NOT_COMPARABLE.

Отрезки: вероятностное преобразование Хафа по чернилам → слияние коллинеарных фрагментов → уточнение оси по
центроидам поперечных сечений и концов — по сплошному следу чернил. Профиль dev: только CPU и OpenCV.
Ограничения: стрелки вместо засечек в узлах цепочки не различаются (узел — чернила по обе стороны линии),
дуговые и угловые размеры, выноски на полке — итерация профиля gpu.
"""

from __future__ import annotations

import math
import time
import re
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .model import Line

MAX_SCALE_SPREAD = 0.02  # 2 %: разброс масштаба между размерными линиями (и со штампом), выше — масштаб не определён
LABEL_GAP = 0.03  # подпись размера — не дальше 3 % меньшей стороны листа от линии (плюс полвысоты подписи)
MIN_DIM_PX = 40  # короче — не размерная линия, а засечка или шум
LONG_LINE = 0.2  # линия чертежа для измерения — не короче 20 % меньшей стороны листа
OVERLAP = 0.5  # параллельные линии «напротив друг друга», если перекрываются хотя бы на половину
PARALLEL_DEG = 1.0  # параллельны (и «осевые» — горизонталь/вертикаль), если углы расходятся не больше чем на 1°
MERGE_OFF = 3.0  # фрагменты Хафа одной линии: концы не дальше 3 px от оси
MERGE_GAP = 4.0  # и разрыв вдоль линии не больше 4 px
MAX_GAP = 2  # след чернил вдоль линии: разрыв до 2 px — ещё та же линия (сглаживание, пересечения)
BAND = 6  # полоса поиска оси вокруг линии Хафа, px в каждую сторону
TICK_REACH = 6  # узел цепочки: чернила по обе стороны линии в пределах 6 px от её края (засечка, выносная)
END_ZONE = (
    MIN_DIM_PX // 2
)  # узел ближе 20 px к концу линии — это край размера (линия выступает за засечку)
EXCLUDE_SHARE = 0.9  # линия — размерная и не измеряется, если 90 % её оси внутри bbox размерных звеньев
EXCLUDE_TOL = 2  # допуск попадания в bbox, px

# ГОСТ 2.302-68: масштабы уменьшения и натуральная величина (генпланы — до 1:50000). Только для отображения:
# сверка со штампом идёт с измеренным N, а не с округлённым.
GOST_2302 = (
    1,
    2,
    2.5,
    4,
    5,
    10,
    15,
    20,
    25,
    40,
    50,
    75,
    100,
    200,
    400,
    500,
    800,
    1000,
    2000,
    5000,
    10000,
    20000,
    25000,
    50000,
)
_STAMP = re.compile(
    r"(?<![а-яёa-z])(?:масштаб|[мm])\s*:?\s*1\s*:\s*(\d+(?:[.,]\d+)?)", re.IGNORECASE
)


# Растр листа для CV: 150 dpi, но не больше 12 Мпикс и не меньше 100 dpi. Прежний потолок 3000 px по стороне давал
# A0 ≈ 64 dpi — засечки цепочки размеров (≈ 3 px) терялись, подпись звена привязывалась ко всей цепочке, масштаб
# «расходился» (NOT_COMPARABLE на любом A0). Замер T-138 (A3–A0, план 1:100): при 88 dpi на A0 измерено 46 стен из 82,
# при 100 dpi — все 82 за 2,3 с; A1 при 144 dpi — 15 с под нагрузкой, при 124 dpi — 3 с. Отсюда 12 Мпикс и пол 100 dpi.
CV_DPI = 150
CV_MIN_DPI = 100
CV_MAX_SIDE = 8000
CV_MAX_PIXELS = 12_000_000


def cv_dpi(width_pt: float, height_pt: float) -> float:
    """Разрешение рендера листа для CV (OS-INSP-2.4.7): CV_DPI, пока растр не больше CV_MAX_PIXELS, но не ниже CV_MIN_DPI."""
    area_in2 = max(width_pt, 1.0) / 72 * max(height_pt, 1.0) / 72
    return max(CV_MIN_DPI, min(CV_DPI, (CV_MAX_PIXELS / area_in2) ** 0.5))


CV_SHEET_LIMIT_S = 30.0  # ТЗ §11, TZA-11-08: CV-анализ одного листа чертежа — не более 30 с (OS-INSP-2.4.7)


class CvTimeout(Exception):
    """Анализ листа не уложился в срок (OS-INSP-2.4.7): частичных измерений нет."""


class Deadline:
    """Срок CV-анализа листа. Проверяется между шагами: после поиска отрезков, на каждой подписи размера,
    на каждой группе и паре параллельных линий. Один шаг OpenCV не прерывается — он ограничен размером растра."""

    def __init__(self, seconds: float, clock=time.monotonic):
        self.seconds, self.clock = seconds, clock
        self.end = clock() + seconds

    def check(self) -> None:
        if self.clock() >= self.end:
            raise CvTimeout(f"анализ листа дольше {self.seconds:g} с")


def _tick(deadline: Deadline | None) -> None:
    if deadline is not None:
        deadline.check()


@dataclass(frozen=True)
class Segment:
    """Отрезок любой ориентации: концы — центры крайних пикселей оси (px растра), thick — толщина штриха."""

    x0: float
    y0: float
    x1: float
    y1: float
    thick: float = 1.0

    @property
    def span(self) -> float:
        return math.hypot(self.x1 - self.x0, self.y1 - self.y0)

    @property
    def length(self) -> float:
        return (
            self.span + 1
        )  # по крайним пикселям: линия PDF от a до b закрашивает пиксели с центрами a+½…b−½

    @property
    def u(self) -> tuple[float, float]:
        s = self.span
        return ((self.x1 - self.x0) / s, (self.y1 - self.y0) / s)

    @property
    def n(self) -> tuple[float, float]:
        ux, uy = self.u
        return (-uy, ux)

    @property
    def angle(self) -> float:
        """Угол к горизонтали в градусах, [0; 180), против часовой стрелки — как видит человек (ось y листа вниз)."""
        return round(math.degrees(math.atan2(self.y0 - self.y1, self.x1 - self.x0)), 1) % 180

    @property
    def horizontal(self) -> bool:
        return abs(self.x1 - self.x0) >= abs(self.y1 - self.y0)

    def at(self, t: float) -> tuple[float, float]:
        ux, uy = self.u
        return (self.x0 + ux * t, self.y0 + uy * t)

    def bbox(
        self, t0: float = 0.0, t1: float | None = None
    ) -> tuple[int, int, int, int]:
        """Осевой bbox участка [t0; t1] оси с учётом толщины, пиксели включительно."""
        t1 = self.span if t1 is None else t1
        r = (self.thick - 1) / 2
        nx, ny = self.n
        pts = [self.at(t) for t in (t0, t1)]
        xs = [p[0] + s * nx * r for p in pts for s in (-1, 1)]
        ys = [p[1] + s * ny * r for p in pts for s in (-1, 1)]
        return (round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys)))


def orientation(angle: float) -> str:
    a = angle % 180
    if min(a, 180 - a) <= PARALLEL_DEG:
        return "horizontal"
    if abs(a - 90) <= PARALLEL_DEG:
        return "vertical"
    return "oblique"


@dataclass(frozen=True)
class ScaleResult:
    mm_per_px: float | None  # None — масштаб не определён
    method: str  # "dimension_line" | "none" | "inconsistent" | "stamp_mismatch"
    evidence: list[
        dict
    ]  # по каждой размерной линии (звену): подпись, мм, длина в px, угол, bbox линии и подписи
    status: str  # "OK" | "NOT_COMPARABLE"
    sheet_scale: float | None = (
        None  # N из 1:N, измеренный (OS-INSP-2.4.6); None — разрешение рендера не задано
    )
    sheet_scale_gost: float | None = (
        None  # N, округлённый к ряду ГОСТ 2.302, — для отображения
    )
    stamp_scale: float | None = (
        None  # N из штампа/надписи листа; None — на листе не указан
    )


@dataclass(frozen=True)
class Distance:
    mm: float
    axis: str  # "x" — между вертикальными линиями, "y" — между горизонтальными, "n" — между наклонными (по нормали)
    a_bbox: tuple[float, float, float, float]
    b_bbox: tuple[float, float, float, float]
    angle: float = 0.0  # угол линий к горизонтали, градусы
    a_pt: tuple[float, float] = (
        0.0,
        0.0,
    )  # концы перпендикуляра на линиях a и b, доли листа
    b_pt: tuple[float, float] = (0.0, 0.0)

    @property
    def m(self) -> float:
        return round(self.mm / 1000, 3)

    @property
    def orientation(self) -> str:
        return {"x": "vertical", "y": "horizontal"}.get(self.axis, "oblique")


def _ink(image: Image.Image) -> np.ndarray:
    g = np.asarray(image.convert("L"))
    return (g < 128).astype(np.uint8) * 255


def _grid(p0, u, n, ts: np.ndarray, offs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Пиксели в системе координат линии: строки — смещения по нормали, столбцы — позиции вдоль оси."""
    xi = np.rint(p0[0] + u[0] * ts[None, :] + n[0] * offs[:, None]).astype(int)
    yi = np.rint(p0[1] + u[1] * ts[None, :] + n[1] * offs[:, None]).astype(int)
    return xi, yi


def _strip(ink: np.ndarray, p0, u, n, ts: np.ndarray, offs: np.ndarray) -> np.ndarray:
    """Выборка чернил по сетке _grid: True — чернила, за пределами листа — фон."""
    h, w = ink.shape
    xi, yi = _grid(p0, u, n, ts, offs)
    ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
    out = np.zeros(xi.shape, dtype=bool)
    out[ok] = ink[yi[ok], xi[ok]] > 0
    return out


def _runs(mask: np.ndarray, gap: int) -> list[tuple[int, int]]:
    """Непрерывные участки True (разрывы до gap включительно не рвут участок): [(начало, конец)] по индексам."""
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    cut = np.flatnonzero(np.diff(idx) > gap + 1)
    starts = np.concatenate(([idx[0]], idx[cut + 1]))
    ends = np.concatenate((idx[cut], [idx[-1]]))
    return list(zip(starts.tolist(), ends.tolist()))


def _merge(frags: list[tuple[float, float, float, float]]) -> list[Segment]:
    """Фрагменты Хафа одной линии (разрывы, параллельные дубли толстого штриха) → один отрезок на линию."""
    # группа: [опорный отрезок, t0, t1]; опора — самый длинный фрагмент группы
    groups: list[list] = []
    for f in sorted(frags, key=lambda f: -math.hypot(f[2] - f[0], f[3] - f[1])):
        s = Segment(*f)
        for g in groups:
            ref = g[0]
            if _angle_diff(ref.angle, s.angle) > PARALLEL_DEG:
                continue
            (ux, uy), (nx, ny) = ref.u, ref.n
            ends = [(f[0], f[1]), (f[2], f[3])]
            if any(
                abs((x - ref.x0) * nx + (y - ref.y0) * ny) > MERGE_OFF for x, y in ends
            ):
                continue
            ts = sorted((x - ref.x0) * ux + (y - ref.y0) * uy for x, y in ends)
            if ts[0] > g[2] + MERGE_GAP or ts[1] < g[1] - MERGE_GAP:
                continue
            g[1], g[2] = min(g[1], ts[0]), max(g[2], ts[1])
            break
        else:
            groups.append([s, 0.0, s.span])
    return [Segment(*g[0].at(g[1]), *g[0].at(g[2])) for g in groups]


def _refine(ink: np.ndarray, s: Segment) -> Segment | None:
    """Ось по центроидам поперечных сечений (МНК), толщина — медиана сечений, концы — по сплошному следу чернил."""
    L = s.span
    if L < 1:
        return None  # отрезок в точку: направления нет, делить на длину нельзя (регрессия T-138, лист A0)
    u, n = s.u, s.n
    ts = np.arange(0, int(L) + 1, dtype=float)
    offs = np.arange(-BAND, BAND + 1, dtype=float)
    # начало сетки — в центре пикселя: с осью на x,5 округление дублировало бы столбцы и смещало центроид
    g0 = (round(s.x0), round(s.y0))
    m = _strip(ink, g0, u, n, ts, offs)
    cnt = m.sum(0)
    # столбцы, где линию пересекает другая (или текст), в подгонку не идут
    good = (cnt > 0) & (cnt <= BAND)
    if good.sum() < MIN_DIM_PX // 2:
        return None
    # центроид — по фактическим центрам пикселей, а не по номерам строк выборки: иначе ось «залипает» до ±½ px
    xi, yi = _grid(g0, u, n, ts, offs)
    real = (xi - s.x0) * n[0] + (yi - s.y0) * n[1]
    cen = (real * m).sum(0)[good] / cnt[good]
    tg = ts[good]
    keep = np.abs(cen - np.median(cen)) <= 1.5
    b, a = np.polyfit(tg[keep], cen[keep], 1)
    thick = float(np.median(cnt[good][keep]))
    p0 = (s.x0 + n[0] * a, s.y0 + n[1] * a)
    p1 = (s.x0 + u[0] * L + n[0] * (a + b * L), s.y0 + u[1] * L + n[1] * (a + b * L))
    ax = Segment(*p0, *p1)
    u, n = ax.u, ax.n
    ext = max(ink.shape)  # Хаф на тонких линиях отдаёт лишь часть длины: след чернил ищется до края листа
    ts = np.arange(-ext, int(ax.span) + ext + 1, dtype=float)
    r = math.ceil(thick / 2)
    trace = _strip(ink, p0, u, n, ts, np.arange(-r, r + 1, dtype=float)).any(0)
    mid = int(np.argmin(np.abs(ts - ax.span / 2)))
    runs = _runs(trace, MAX_GAP)
    if not runs:
        return None
    lo, hi = min(
        runs,
        key=lambda q: (
            0 if q[0] <= mid <= q[1] else min(abs(q[0] - mid), abs(q[1] - mid))
        ),
    )
    out = Segment(*ax.at(ts[lo]), *ax.at(ts[hi]), thick=thick)
    return out if out.span >= 1 else None  # след чернил в один пиксель — не отрезок


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 180
    return min(d, 180 - d)


def segments(image: Image.Image, deadline: Deadline | None = None) -> list[Segment]:
    """Прямые отрезки любой ориентации не короче MIN_DIM_PX: Хаф → слияние фрагментов → уточнение → без дублей."""
    import cv2

    ink = _ink(image)
    raw = cv2.HoughLinesP(
        ink,
        1,
        np.pi / 720,
        MIN_DIM_PX // 2,
        minLineLength=MIN_DIM_PX,
        maxLineGap=MAX_GAP,
    )
    _tick(deadline)
    if raw is None:
        return []
    refined = []
    for s in _merge([tuple(map(float, r)) for r in raw.reshape(-1, 4)]):
        _tick(deadline)
        r = _refine(ink, s)  # второй проход уточняет ось по всей длине, найденной первым
        refined.append(r and _refine(ink, r))
    out: list[Segment] = []
    for s in sorted((s for s in refined if s is not None), key=lambda s: -s.span):
        if s.length >= MIN_DIM_PX and not any(_same_line(k, s) for k in out):
            out.append(s)
    return out


def _same_line(k: Segment, s: Segment) -> bool:
    """s — дубль уже найденной k: параллелен, на её оси (в пределах толщины) и целиком внутри её длины."""
    if _angle_diff(k.angle, s.angle) > PARALLEL_DEG:
        return False
    (ux, uy), (nx, ny) = k.u, k.n
    tol = max(k.thick, s.thick) / 2 + 1
    for x, y in ((s.x0, s.y0), (s.x1, s.y1)):
        if abs((x - k.x0) * nx + (y - k.y0) * ny) > tol:
            return False
        t = (x - k.x0) * ux + (y - k.y0) * uy
        if not -MERGE_GAP <= t <= k.span + MERGE_GAP:
            return False
    return True


def _junctions(ink: np.ndarray, s: Segment) -> list[float]:
    """Узлы цепочки вдоль оси (px от начала): засечка 45° или выносная линия дают чернила по обе стороны линии.
    Засечка на смещении o лежит на o в стороне от своей точки — поэтому стороны сглаживаются окном ±k вдоль оси."""
    a = math.ceil(s.thick / 2) + 2
    k = a + TICK_REACH
    ts = np.arange(-k, int(s.span) + k + 1, dtype=float)
    offs = np.arange(a, a + TICK_REACH + 1, dtype=float)
    win = np.ones(2 * k + 1)
    sides = [
        np.convolve(
            _strip(ink, (s.x0, s.y0), s.u, s.n, ts, sg * offs).any(0), win, "same"
        )
        > 0
        for sg in (1, -1)
    ]
    return [float((ts[lo] + ts[hi]) / 2) for lo, hi in _runs(sides[0] & sides[1], 0)]


def _links(ink: np.ndarray, s: Segment) -> list[tuple[float, float]]:
    """Звенья размерной линии: между соседними узлами; край без узла рядом — край следа чернил."""
    js = _junctions(ink, s)
    bounds = list(js)
    if not js or js[0] > END_ZONE:
        bounds.insert(0, -0.5)
    if not js or js[-1] < s.span - END_ZONE:
        bounds.append(s.span + 0.5)
    return list(zip(bounds, bounds[1:]))


def _norm(b, w: int, h: int) -> tuple[float, float, float, float]:
    return (
        round(b[0] / w, 5),
        round(b[1] / h, 5),
        round((b[2] + 1) / w, 5),
        round((b[3] + 1) / h, 5),
    )


def _pt(p, w: int, h: int) -> tuple[float, float]:
    return (round(float(p[0]) / w, 5), round(float(p[1]) / h, 5))


def _number(text: str) -> float | None:
    t = text.replace(" ", "").replace("\u00a0", "")
    return float(t) if re.fullmatch(r"\d{2,6}", t) else None


def sheet_scale(mm_per_px: float, dpi: float) -> float:
    """OS-INSP-2.4.6: N из 1:N = мм натуры на пиксель / мм листа на пиксель (25,4 / dpi)."""
    return mm_per_px * dpi / 25.4


def render_dpi(image_size: tuple[int, int], page_size_pt: tuple[float, float]) -> float:
    """Фактическое разрешение рендера: пиксели по длинной стороне на дюйм (72 pt) — не зависит от поворота листа
    и от ограничения MAX_SIDE, которым рендер уменьшает большие листы."""
    return 72 * max(image_size) / max(page_size_pt)


def gost_scale(n: float) -> float | None:
    """Ближайший масштаб ряда ГОСТ 2.302 (в логарифмах: 1:130 ближе к 1:100, чем к 1:200)."""
    if n <= 0:
        return None
    return min(GOST_2302, key=lambda g: abs(math.log(n / g)))


def stamp_scales(lines: list[Line]) -> list[float]:
    """Масштабы, указанные на листе: «М 1:100», «Масштаб 1:50», «M1:200» — без повторов, в порядке появления."""
    out: list[float] = []
    for ln in lines:
        for m in _STAMP.finditer(ln.text):
            v = float(m.group(1).replace(",", "."))
            if v > 0 and v not in out:
                out.append(int(v) if v.is_integer() else v)
    return out


def scale_conflict(measured: float, stamp: float) -> bool:
    return abs(measured - stamp) / stamp > MAX_SCALE_SPREAD


def determine_scale(
    image: Image.Image, lines: list[Line], dpi: float | None = None, deadline: Deadline | None = None
) -> ScaleResult:
    """OS-INSP-2.4.1, 2.4.3, 2.4.4, 2.4.6: масштаб по размерным линиям любой ориентации и звеньям цепочек.
    Слова — с bbox в долях листа. dpi — разрешение рендера: с ним выводится 1:N и сверяется со штампом."""
    w, h = image.size
    ink = _ink(image)
    segs = segments(image, deadline)
    links: dict[int, list[tuple[float, float]]] = {}
    ev: list[dict] = []
    for ln in lines:
        for wd in ln.words:
            _tick(deadline)
            mm = _number(wd.text)
            if mm is None or not wd.bbox:
                continue
            lx0, ly0, lx1, ly1 = (
                wd.bbox[0] * w,
                wd.bbox[1] * h,
                wd.bbox[2] * w,
                wd.bbox[3] * h,
            )
            cx, cy = (lx0 + lx1) / 2, (ly0 + ly1) / 2
            reach = LABEL_GAP * min(w, h) + min(lx1 - lx0, ly1 - ly0) / 2
            best = None
            for i, s in enumerate(segs):
                (ux, uy), (nx, ny) = s.u, s.n
                t = (cx - s.x0) * ux + (cy - s.y0) * uy
                dist = abs((cx - s.x0) * nx + (cy - s.y0) * ny)
                if not (
                    -0.5 <= t <= s.span + 0.5
                    and s.thick / 2 + 1 < dist <= reach + s.thick / 2
                ):
                    continue
                if i not in links:
                    links[i] = _links(ink, s)
                for lo, hi in links[i]:
                    if (
                        lo <= t <= hi
                        and hi - lo >= MIN_DIM_PX
                        and (best is None or dist < best[0])
                    ):
                        best = (
                            dist,
                            s,
                            lo,
                            hi,
                            links[i].index((lo, hi)) + 1,
                            len(links[i]),
                        )
            if best is None:
                continue
            _, s, lo, hi, k, nk = best  # ближайшая к подписи размерная линия (звено)
            px = hi - lo
            a, b = s.at(max(lo, 0.0)), s.at(min(hi, s.span))
            ev.append(
                {
                    "label": wd.text,
                    "mm": mm,
                    "px": round(px, 1),
                    "mm_per_px": mm / px,
                    "angle": s.angle,
                    "orientation": orientation(s.angle),
                    "link": k,
                    "links": nk,
                    "line": _pt(a, w, h) + _pt(b, w, h),
                    "line_bbox": _norm(s.bbox(max(lo, 0.0), min(hi, s.span)), w, h),
                    "label_bbox": wd.bbox,
                }
            )
    if not ev:
        return ScaleResult(None, "none", [], "NOT_COMPARABLE")
    ks = [e["mm_per_px"] for e in ev]
    if (max(ks) - min(ks)) / min(ks) > MAX_SCALE_SPREAD:
        return ScaleResult(None, "inconsistent", ev, "NOT_COMPARABLE")
    k = sum(ks) / len(ks)
    if dpi is None:
        return ScaleResult(k, "dimension_line", ev, "OK")
    n = sheet_scale(k, dpi)
    stamps = stamp_scales(lines)
    agree = [st for st in stamps if not scale_conflict(n, st)]
    shown = round(n, 1), gost_scale(n)
    if stamps and not agree:
        return ScaleResult(
            None, "stamp_mismatch", ev, "NOT_COMPARABLE", *shown, stamps[0]
        )
    return ScaleResult(
        k, "dimension_line", ev, "OK", *shown, agree[0] if agree else None
    )


def distances(
    image: Image.Image,
    scale: ScaleResult,
    exclude: list[tuple[float, float, float, float]] | None = None,
    deadline: Deadline | None = None,
) -> list[Distance]:
    """OS-INSP-2.4.2, 2.4.5: расстояния по перпендикуляру между соседними параллельными длинными линиями любой
    ориентации, стоящими напротив друг друга, в мм, с bbox обеих линий и концами перпендикуляра.
    Масштаб не определён — измерений нет (OS-INSP-2.4.3). Размерные линии из exclude не измеряются."""
    if scale.mm_per_px is None:
        return []
    w, h = image.size
    min_len = LONG_LINE * min(w, h)
    ex = np.array(
        [(b[0] * w, b[1] * h, b[2] * w, b[3] * h) for b in (exclude or [])], dtype=float
    ).reshape(-1, 4)

    def excluded(s: Segment) -> bool:
        if not len(ex):
            return False
        pts = np.array([s.at(t) for t in np.linspace(0, s.span, int(s.span // 4) + 2)])
        inside = (
            (ex[None, :, 0] - EXCLUDE_TOL <= pts[:, None, 0])
            & (pts[:, None, 0] <= ex[None, :, 2] + EXCLUDE_TOL)
            & (ex[None, :, 1] - EXCLUDE_TOL <= pts[:, None, 1])
            & (pts[:, None, 1] <= ex[None, :, 3] + EXCLUDE_TOL)
        ).any(1)
        return inside.mean() >= EXCLUDE_SHARE

    segs = [s for s in segments(image, deadline) if s.length >= min_len and not excluded(s)]
    # группы параллельных: угол с переходом через 180° (179,6° и 0,3° — одна горизонталь)
    ang = {
        id(s): (s.angle - 180 if s.angle > 180 - PARALLEL_DEG else s.angle)
        for s in segs
    }
    groups: list[list[Segment]] = []
    for s in sorted(segs, key=lambda s: ang[id(s)]):
        if groups and ang[id(s)] - ang[id(groups[-1][0])] <= PARALLEL_DEG:
            groups[-1].append(s)
        else:
            groups.append([s])
    out: list[Distance] = []
    for g in groups:
        _tick(deadline)
        theta = sum(ang[id(s)] for s in g) / len(g)
        r = math.radians(theta)
        u, n = (
            (math.cos(r), -math.sin(r)),
            (math.sin(r), math.cos(r)),
        )  # n: вниз для горизонтали, вправо для вертикали
        axis = {"horizontal": "y", "vertical": "x"}.get(orientation(theta), "n")

        def pos(s: Segment) -> float:
            return ((s.x0 + s.x1) / 2) * n[0] + ((s.y0 + s.y1) / 2) * n[1]

        def span(s: Segment) -> tuple[float, float]:
            a, b = s.x0 * u[0] + s.y0 * u[1], s.x1 * u[0] + s.y1 * u[1]
            return (min(a, b), max(a, b))

        ordered = sorted(g, key=pos)
        for a, b in zip(ordered, ordered[1:]):
            _tick(deadline)
            (a0, a1), (b0, b1) = span(a), span(b)
            ov = min(a1, b1) - max(a0, b0)
            if ov < OVERLAP * min(a1 - a0, b1 - b0):
                continue  # не напротив друг друга
            tm = (
                max(a0, b0) + min(a1, b1)
            ) / 2  # перпендикуляр — посередине общего участка
            pa, pb = _foot(a, u, tm), _foot(b, u, tm)
            sep = (pb[0] - pa[0]) * n[0] + (pb[1] - pa[1]) * n[1]
            if sep <= max(a.thick, b.thick):
                continue  # две оси одного толстого штриха, а не пара линий
            out.append(
                Distance(
                    round(sep * scale.mm_per_px, 1),
                    axis,
                    _norm(a.bbox(), w, h),
                    _norm(b.bbox(), w, h),
                    round(theta % 180, 2),
                    _pt(pa, w, h),
                    _pt(pb, w, h),
                )
            )
    return out


def _foot(s: Segment, u: tuple[float, float], t: float) -> tuple[float, float]:
    """Точка оси s, проекция которой на направление группы u равна t."""
    su = s.u[0] * u[0] + s.u[1] * u[1]
    return s.at((t - (s.x0 * u[0] + s.y0 * u[1])) / su)
