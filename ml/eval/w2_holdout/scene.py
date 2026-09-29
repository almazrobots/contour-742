"""Сцена отложенного набора W2 (T-195): вымышленный объект в мм здания, мутации и меры истины.

Сцена — это то, что «на самом деле» спроектировано: оси, стены, двери, коридор, санузел МГН, венткамера с
установками и трассой, клапаны ОЗК, знаки АПС/СОУЭ/ВПВ, спецификации, генплан. Листы рисуются из сцены
(`pages.py`), истина считается из сцены (`measure`), а не из того, что нарисовано, — поэтому мутация, внесённая
в сцену, одинаково отражается на всех листах, где элемент виден (план и фрагмент 1:50, план АР и план ОВ).

Все стены сцены параллельны осям здания; «стены не по сетке» — поворот плана θ на листе (15°, 30°), истина от
поворота не зависит. Положения, которые мутации не должны двигать (трасса, знаки), заданы абсолютно.
"""

from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass, field

JAMB = 60.0  # коробка двери вдоль стены, мм: проём = в свету + 2 коробки


@dataclass
class Wall:
    id: str
    a: tuple[float, float]
    b: tuple[float, float]
    t: float
    fire: bool = False
    kind: str = "int"  # ext | int | part

    @property
    def horizontal(self) -> bool:
        return abs(self.a[1] - self.b[1]) < 1e-9

    def rect(self) -> tuple[float, float, float, float]:
        if self.horizontal:
            return (
                min(self.a[0], self.b[0]),
                self.a[1] - self.t / 2,
                max(self.a[0], self.b[0]),
                self.a[1] + self.t / 2,
            )
        return (
            self.a[0] - self.t / 2,
            min(self.a[1], self.b[1]),
            self.a[0] + self.t / 2,
            max(self.a[1], self.b[1]),
        )


@dataclass
class Door:
    id: str
    mark: str
    wall: str
    c: float  # центр вдоль стены: x — у горизонтальной, y — у вертикальной
    leaf: float  # ширина полотна
    clear: float  # ширина в свету
    side: int = (
        1  # открывание в сторону +нормали (+y у горизонтальной, +x у вертикальной)
    )
    hinge: int = -1  # петли со стороны −(вдоль стены)

    @property
    def opening(self) -> float:
        return self.clear + 2 * JAMB


@dataclass
class Scene:
    small: bool
    xs: list[float]
    x_marks: list[str]
    y_axes: dict[str, float]
    te: float
    t: float
    tp: float
    yb: float  # ось нижней стены коридора
    ytw: float  # ось верхней стены коридора
    yV: float  # ось наружной стены сверху (ось В)
    xp: float  # ось перегородки санузла МГН
    f: int  # индекс оси противопожарной стены поперёк коридора
    doors: dict[str, Door]
    label_wc: float | None  # надпись размера ширины коридора; None — по геометрии
    y_duct: float
    x_down: float
    x_end: float
    y_col: float
    unit_w: float
    unit_h: float
    pitch: float
    units: list[dict]  # {mark, slot}
    terminals: list[dict]  # {mark, x}
    valves: list[dict]  # {id, mark, at}
    detectors: list[tuple[float, float]]
    sounders: list[tuple[float, float]]
    hydrants: list[tuple[float, float]]
    spec_removed: list[str] = field(default_factory=list)
    site: dict = field(default_factory=dict)
    detail: bool = False  # NEG-03: чистая детализация (отводы, мебель, размеры) без изменения предмета
    ghosts: list[dict] = field(
        default_factory=list
    )  # удалённые элементы: зона в РД, где их нет
    cloud: list[str] = field(
        default_factory=list
    )  # MUT-17: теги, вокруг которых облако изменения
    trunk_jog: bool = False

    # ── производные
    @property
    def X(self) -> float:
        return self.xs[-1]

    @property
    def wc(self) -> float:
        """Ширина коридора в свету: между внутренними гранями стен."""
        return (self.ytw - self.t / 2) - (self.yb + self.t / 2)

    @property
    def cabin(self) -> tuple[float, float, float, float]:
        return (
            self.te / 2,
            self.ytw + self.t / 2,
            self.xp - self.tp / 2,
            self.yV - self.te / 2,
        )

    @property
    def xl_vk(self) -> float:
        return self.xs[-2] + self.t / 2


def walls(s: Scene) -> list[Wall]:
    X, te, t, tp = s.X, s.te, s.t, s.tp
    out = [
        Wall("ext_s", (0, 0), (X, 0), te, kind="ext"),
        Wall("ext_n", (0, s.yV), (X, s.yV), te, kind="ext"),
        Wall("ext_w", (0, 0), (0, s.yV), te, kind="ext"),
        Wall("ext_e", (X, 0), (X, s.yV), te, kind="ext"),
        Wall("cor_bot", (te / 2, s.yb), (X - te / 2, s.yb), t),
        Wall("cor_top", (te / 2, s.ytw), (s.xs[-2], s.ytw), t),
        Wall("cor_top_vk", (s.xs[-2], s.ytw), (X - te / 2, s.ytw), t, fire=True),
        Wall("fw", (s.xs[s.f], s.yb + t / 2), (s.xs[s.f], s.ytw - t / 2), t, fire=True),
        Wall("pc", (s.xp, s.ytw + t / 2), (s.xp, s.yV - te / 2), tp, kind="part"),
    ]
    for i in range(1, len(s.xs) - 1):
        out.append(
            Wall(f"pb{i}", (s.xs[i], te / 2), (s.xs[i], s.yb - t / 2), tp, kind="part")
        )
        vk = i == len(s.xs) - 2
        out.append(
            Wall(
                f"pt{i}",
                (s.xs[i], s.ytw + t / 2),
                (s.xs[i], s.yV - te / 2),
                t if vk else tp,
                fire=vk,
                kind="int" if vk else "part",
            )
        )
    return out


def wall_by_id(s: Scene) -> dict[str, Wall]:
    return {w.id: w for w in walls(s)}


def rooms(s: Scene) -> list[dict]:
    """Помещения — прямоугольники между гранями стен (экспликация и знаки АПС)."""
    te, t, tp, xs = s.te, s.t, s.tp, s.xs
    th = {i: (t if i == len(xs) - 2 else tp) for i in range(1, len(xs) - 1)}

    def lf(i, top):  # левая грань комнаты между осями i и i+1
        return te / 2 if i == 0 else xs[i] + (th[i] if top else tp) / 2

    def rf(i, top):
        return (
            s.X - te / 2
            if i == len(xs) - 2
            else xs[i + 1] - (th[i + 1] if top else tp) / 2
        )

    out = []
    nb = len(xs) - 1
    for i in range(nb):
        out.append(
            {
                "number": f"1{i + 1:02d}",
                "name": "Кабинет",
                "rect": (lf(i, False), te / 2, rf(i, False), s.yb - t / 2),
            }
        )
    out.append(
        {
            "number": "1{:02d}".format(nb + 1),
            "name": "Коридор",
            "rect": (te / 2, s.yb + t / 2, s.X - te / 2, s.ytw - t / 2),
        }
    )
    top = s.ytw + t / 2, s.yV - te / 2
    out.append({"number": f"1{nb + 2:02d}", "name": "С/у МГН", "rect": s.cabin})
    for i in range(nb):
        x0 = s.xp + tp / 2 if i == 0 else lf(i, True)
        name = "Венткамера" if i == nb - 1 else "Кабинет"
        out.append(
            {
                "number": f"1{nb + 3 + i:02d}",
                "name": name,
                "rect": (x0, top[0], rf(i, True), top[1]),
            }
        )
    for r in out:
        x0, y0, x1, y1 = r["rect"]
        r["area_m2"] = round((x1 - x0) * (y1 - y0) / 1e6, 2)
    return out


# ─────────────────────────────────────────────── вентиляция


def unit_rect(s: Scene, slot: int) -> tuple[float, float, float, float]:
    x0 = s.xl_vk + 300 + slot * s.pitch
    yc = s.yV - s.te / 2 - 250 - s.unit_h / 2
    return (x0, yc - s.unit_h / 2, x0 + s.unit_w, yc + s.unit_h / 2)


def trunk(s: Scene) -> list[tuple[float, float]]:
    return [(s.x_down, s.y_col), (s.x_down, s.y_duct), (s.x_end, s.y_duct)]


def vent_graph(s: Scene) -> dict:
    """Граф системы на уровне ПД: установки, тройник сборного воздуховода, клапаны, воздухораспределители с марками.
    Отводы, переходы и распределители без марок (детализация РД) в граф не входят (каталог CMP-19, NRM-15)."""
    nodes = {("J", "tee")}
    edges = set()
    for u in s.units:
        nodes.add((u["mark"], "unit"))
        edges.add(tuple(sorted((u["mark"], "J"))))
    along = []  # точки на стояке и магистрали: расстояние вдоль трассы от тройника
    for v in s.valves:
        along.append((_along(s, v["at"]), v["mark"], "valve"))
    for tm in s.terminals:
        along.append((_along(s, (tm["x"], s.y_duct)), tm["mark"], "terminal"))
    prev = "J"
    for _, mark, kind in sorted(along):
        nodes.add((mark, kind))
        edges.add(tuple(sorted((prev, mark))))
        prev = mark
    return {
        "nodes": sorted(list(n) for n in nodes),
        "edges": sorted(list(e) for e in edges),
    }


def _along(s: Scene, p) -> float:
    if abs(p[0] - s.x_down) < 1e-6 and p[1] >= s.y_duct - 1e-6:
        return s.y_col - p[1]
    return (s.y_col - s.y_duct) + (s.x_down - p[0])


def crossings(s: Scene) -> list[list[float]]:
    """Пересечения трассы с противопожарными стенами (по осям стен)."""
    out = []
    pts = trunk(s)
    for w in walls(s):
        if not w.fire:
            continue
        for a, b in zip(pts, pts[1:], strict=False):
            p = _seg_x(a, b, w.a, w.b)
            if p:
                out.append([round(p[0], 3), round(p[1], 3)])
    return sorted(out)


def _seg_x(a, b, c, d):
    """Пересечение отрезков, параллельных осям (или общее), иначе None."""
    r = (b[0] - a[0], b[1] - a[1])
    q = (d[0] - c[0], d[1] - c[1])
    den = r[0] * q[1] - r[1] * q[0]
    if abs(den) < 1e-12:
        return None
    tt = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den
    uu = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den
    if -1e-9 <= tt <= 1 + 1e-9 and -1e-9 <= uu <= 1 + 1e-9:
        return (a[0] + tt * r[0], a[1] + tt * r[1])
    return None


# ─────────────────────────────────────────────── знаки и спецификации

KINDS = ("ip", "op", "pk", "ozk")
KIND_RU = {
    "ip": ("ИП", "Извещатель пожарный дымовой оптико-электронный"),
    "op": ("ОП", "Оповещатель пожарный звуковой"),
    "pk": ("ПК", "Шкаф пожарный с краном ВПВ DN50"),
    "ozk": ("КП", "Клапан противопожарный нормально открытый EI 60"),
}


def drawing_counts(s: Scene) -> dict[str, int]:
    return {
        "ip": len(s.detectors),
        "op": len(s.sounders),
        "pk": len(s.hydrants),
        "ozk": len(s.valves),
        "mgn": s.site["n_mgn"],
    }


def spec_counts(s: Scene) -> dict[str, int | None]:
    d = drawing_counts(s)
    return {k: (None if k in s.spec_removed else d[k]) for k in KINDS}


# ─────────────────────────────────────────────── генплан


def site_items(s: Scene) -> list[dict]:
    g = s.site
    Wr, band, Px, Pv, Sx = g["Wr"], g["band"], g["Px"], g["Pv"], g["Sx"]
    y1, y2 = Wr + band, Wr + band + g["Pv"]
    out = [
        {"kind": "road", "key": "road", "rect": (0, 0, Sx, Wr), "width_mm": Wr},
        {
            "kind": "asphalt",
            "key": "asphalt",
            "polygon": [(0, 0), (Sx, 0), (Sx, Wr), (Px, Wr), (Px, y1), (0, y1)],
        },
        {"kind": "parking", "key": "parking", "rect": (0, Wr, Px, y1)},
        {"kind": "lawn", "key": "lawn:A1", "rect": (Px, Wr, g["Xg"], y1)},
        {
            "kind": "playground",
            "key": "playground",
            "rect": (g["Xg"], Wr, g["Xg"] + g["Pw"], y1),
        },
        {"kind": "lawn", "key": "lawn:A2", "rect": (g["Xg"] + g["Pw"], Wr, Sx, y1)},
        {"kind": "paving", "key": "paving", "rect": (0, y1, g["Xb"], y2)},
        {"kind": "lawn", "key": "lawn:B", "rect": (g["Xb"], y1, Sx, y2)},
        {
            "kind": "building",
            "key": "building",
            "rect": (g["bx"], y2, g["bx"] + s.X + s.te, y2 + s.yV + s.te),
        },
    ]
    del Pv
    for it in out:
        poly = it.get("polygon") or _rect_poly(it["rect"])
        it["polygon"] = [list(map(float, p)) for p in poly]
        it["area_m2"] = round(abs(_shoelace(poly)) / 1e6, 2)
    return out


def stalls(s: Scene) -> list[dict]:
    g = s.site
    x = 1000.0
    out = []
    for i in range(g["n_mgn"] + g["n_st"]):
        w = 3600.0 if i < g["n_mgn"] else 2500.0
        out.append(
            {"mgn": i < g["n_mgn"], "rect": (x, g["Wr"], x + w, g["Wr"] + g["band"])}
        )
        x += w
    return out


def site_area(s: Scene, kind: str) -> float:
    return round(sum(it["area_m2"] for it in site_items(s) if it["kind"] == kind), 2)


def _rect_poly(r):
    x0, y0, x1, y1 = r
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _shoelace(p) -> float:
    return (
        sum(
            p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1]
            for i in range(len(p))
        )
        / 2
    )


# ─────────────────────────────────────────────── построение сцены


def make_scene(rng: random.Random, small: bool) -> Scene:
    te, t, tp = (300.0, 200.0, 120.0) if small else (400.0, 200.0, 120.0)
    if small:  # фрагмент здания в трёх осях — чертится 1:50
        steps = [rng.choice([5100, 5400, 5700]), rng.choice([4200, 4500, 4800])]
        B = rng.choice([3000, 3300, 3600])
    else:
        nx = rng.choice([4, 5, 6])
        steps = [rng.choice([6000, 6300, 6600, 7200]) for _ in range(nx - 1)]
        B = rng.choice([4800, 5400, 6000])
    xs = [0.0]
    for st in steps:
        xs.append(xs[-1] + st)
    wc = float(rng.choice([1400, 1500, 1600, 1800]))
    D = float(rng.choice([2250, 2400, 2550, 2700]))
    yb = float(B)
    ytw = yb + t / 2 + wc + t / 2
    yV = ytw + t / 2 + D + te / 2
    wcab = float(rng.choice([2200, 2300, 2400, 2500]))
    xp = te / 2 + wcab + tp / 2
    f = 1 if small else rng.randint(2, len(xs) - 2)
    marks = [str(i + 1) for i in range(len(xs))]

    doors: dict[str, Door] = {}
    # Д1 — дверь между кабинетами в перегородке по оси 2 (вертикальная стена): цель MUT-09 и ловушки допуска
    leaf1 = float(rng.choice([800, 900, 1000]))
    d1 = Door("D1", "1", "pb1", 0.0, leaf1, leaf1 - 100, side=1, hinge=-1)
    lo = te / 2 + 150 + d1.opening / 2
    hi = yb - t / 2 - 150 - d1.opening / 2
    d1.c = round(lo + rng.uniform(0.3, 0.7) * (hi - lo), 0)
    doors["D1"] = d1
    # Д2 — дверь санузла МГН: полотно и в свету (норма в свету ≥ 900)
    leaf2 = float(rng.choice([1000, 1100]))
    clear2 = leaf2 - rng.choice([80, 100])
    d2 = Door("WC", "2", "cor_top", 0.0, leaf2, clear2, side=1, hinge=-1)
    d2.c = te / 2 + 200 + d2.opening / 2
    doors["WC"] = d2
    k = 3
    for i in range(len(xs) - 1):  # двери кабинетов в коридор — шум, в пары не входят
        x0, x1 = xs[i], xs[i + 1]
        doors[f"B{i}"] = Door(
            f"B{i}",
            str(k),
            "cor_bot",
            round((x0 + x1) / 2 + rng.uniform(-600, 600), 0),
            900,
            800,
            side=-1,
            hinge=1,
        )
        k += 1
    doors["R0"] = Door(
        "R0", str(k), "cor_top", round((xp + xs[1]) / 2, 0), 900, 800, side=1, hinge=-1
    )
    k += 1
    for i in range(1, len(xs) - 2):
        doors[f"T{i}"] = Door(
            f"T{i}",
            str(k),
            "cor_top",
            round((xs[i] + xs[i + 1]) / 2, 0),
            900,
            800,
            side=1,
        )
        k += 1
    doors["VK"] = Door(
        "VK",
        str(k),
        "cor_top_vk",
        xs[-2] + t / 2 + 250 + 520,
        1000,
        900,
        side=1,
        hinge=-1,
    )

    # вентиляция: установки в венткамере, сборный воздуховод, стояк через стену венткамеры, магистраль по коридору
    uw, uh, pitch = (700.0, 600.0, 1000.0) if small else (900.0, 700.0, 1200.0)
    X = xs[-1]
    x_down = X - te / 2 - 450
    xl = xs[-2] + t / 2
    kmax = int((x_down - 300 - xl - 300 - uw) // pitch) + 1
    nu = rng.randint(2, max(2, kmax - 1))
    units = [{"mark": f"П{i + 1}", "slot": i} for i in range(nu)]
    y_duct = ytw - t / 2 - 400
    x_end = te / 2 + 600
    xf = xs[f]
    left = [x_end] + (
        [round((x_end + xf) / 2, 0)] if xf - x_end > 3000 and rng.random() < 0.5 else []
    )
    nr = rng.randint(1, 2)
    right = [
        round(xf + 900 + (x_down - 900 - xf - 900) * (j + 0.5) / nr, 0)
        for j in range(nr)
    ]
    terminals = [
        {"mark": f"Р{j + 1}", "x": x} for j, x in enumerate(sorted(left + right))
    ]
    valves = [
        {"id": "V1", "mark": "КП-1", "at": [x_down, ytw]},
        {"id": "V2", "mark": "КП-2", "at": [xf, y_duct]},
    ]
    s = Scene(
        small,
        xs,
        marks,
        {"А": 0.0, "Б": yb, "В": yV},
        te,
        t,
        tp,
        yb,
        ytw,
        yV,
        xp,
        f,
        doors,
        None,
        y_duct,
        x_down,
        x_end,
        ytw + t / 2 + 400,
        uw,
        uh,
        pitch,
        units,
        terminals,
        valves,
        [],
        [],
        [],
    )
    # знаки: извещатели сеткой ≤ 4,5 м в каждом помещении (кроме коридора), оповещатели и краны у верхней грани коридора
    for r in rooms(s):
        if r["name"] == "Коридор":
            continue
        x0, y0, x1, y1 = r["rect"]
        nxd, nyd = (
            max(1, math.ceil((x1 - x0) / 4500)),
            max(1, math.ceil((y1 - y0) / 4500)),
        )
        for i in range(nxd):
            for j in range(nyd):
                s.detectors.append(
                    (
                        round(x0 + (x1 - x0) * (i + 0.5) / nxd, 0),
                        round(y0 + (y1 - y0) * (j + 0.5) / nyd, 0),
                    )
                )
    nop = max(2, math.ceil(X / 7000))
    top_face = ytw - t / 2
    s.sounders = [(round(X * (j + 0.5) / nop, 0), top_face - 120) for j in range(nop)]
    s.hydrants = [
        (round(xs[i] + 700, 0), top_face - 350) for i in range(1, min(3, len(xs) - 1))
    ]
    s.site = make_site(rng, s)
    return s


def make_site(rng: random.Random, s: Scene) -> dict:
    Wr = float(rng.choice([4200, 5500, 6000]))
    band = 5300.0
    n_st, n_mgn = rng.randint(6, 12), rng.randint(1, 3)
    Px = 1000 + n_mgn * 3600 + n_st * 2500 + 1000.0
    Pv = float(rng.choice([6000, 7000, 8000]))
    Pw = float(rng.choice([8000, 10000, 12000]))
    bw = s.X + s.te
    Sx = float(math.ceil(max(Px + Pw + 25000, bw + 30000, 70000) / 1000) * 1000)
    Xg = Px + 5000
    Lb = float(rng.choice([30000, 35000, 40000]))
    Xb = max(Sx - Lb, 20000.0)
    return {
        "Wr": Wr,
        "band": band,
        "n_st": n_st,
        "n_mgn": n_mgn,
        "Px": Px,
        "Pv": Pv,
        "Pw": Pw,
        "Sx": Sx,
        "Xg": Xg,
        "Xb": Xb,
        "bx": 5000.0,
        "trees": [],
    }


def clone(s: Scene) -> Scene:
    return copy.deepcopy(s)
