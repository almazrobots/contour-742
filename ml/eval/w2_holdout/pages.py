"""Листы отложенного набора W2 (T-195): АР (план + фрагмент санузла МГН в другом масштабе), ОВ (венткамера, трасса,
клапаны ОЗК, спецификация), ПБ (извещатели, оповещатели, пожарные краны, легенда, спецификация), ГП (покрытия,
проезд, машино-места МГН, ведомость покрытий). Каждый лист — отдельный однолистовой PDF.

Соглашения стиля (`style`): масштабы 1:50 / 1:200 / 1:500 (и 1:25 / 1:100 у фрагментов и ловушки масштаба), размеры
со стрелками, засечками или точками, надпись над или под размерной линией, поворот листа /Rotate 90, поворот плана θ,
часть надписей кривыми, шум путей (штриховки, мебель, штамп, рамка, таблицы).
"""

from __future__ import annotations

import math
from pathlib import Path

from reportlab.pdfgen import canvas as rl_canvas

from . import scene as sc
from .render import (
    PT,
    Frag,
    Pen,
    arc_cmds,
    decide,
    dim,
    frame_and_stamp,
    layout,
    rot,
    table,
)

DISC_TITLE = {
    "AR": "План 1 этажа",
    "OV": "План систем вентиляции",
    "PB": "План АПС, СОУЭ, ВПВ",
    "GP": "Генплан",
}


# ─────────────────────────────────────────────── геометрия здания на листе


def _rect_pts(fr: Frag, r):
    x0, y0, x1, y1 = r
    return [fr.m(p) for p in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


def _clip(r, win):
    if win is None:
        return r
    x0, y0 = max(r[0], win[0]), max(r[1], win[1])
    x1, y1 = min(r[2], win[2]), min(r[3], win[3])
    return (x0, y0, x1, y1) if x1 - x0 > 1e-6 and y1 - y0 > 1e-6 else None


def _hatch(pen: Pen, fr: Frag, r, sp: float, tag=None, gray=0.0, cross=False):
    """Штриховка 45° (и 135° при cross) прямоугольника здания r с шагом sp мм здания."""
    x0, y0, x1, y1 = r
    for sgn in (1, -1) if cross else (1,):
        # линии y = sgn·x + k
        ks = [y0 - sgn * x for x in (x0, x1)] + [y1 - sgn * x for x in (x0, x1)]
        k = math.floor(min(ks) / sp) * sp
        while k <= max(ks):
            pts = []
            for x in (x0, x1):
                y = sgn * x + k
                if y0 - 1e-9 <= y <= y1 + 1e-9:
                    pts.append((x, y))
            for y in (y0, y1):
                x = (y - k) / sgn
                if x0 - 1e-9 <= x <= x1 + 1e-9:
                    pts.append((x, y))
            pts = sorted(set((round(a, 6), round(b, 6)) for a, b in pts))
            if len(pts) >= 2 and math.dist(pts[0], pts[-1]) > 1e-6:
                pen.line(fr.m(pts[0]), fr.m(pts[-1]), width=0.1, gray=gray, tag=tag)
            k += sp


def _gaps(s: sc.Scene, w: sc.Wall):
    out = []
    for d in s.doors.values():
        if d.wall == w.id:
            out.append((d.c - d.opening / 2, d.c + d.opening / 2))
    return sorted(out)


def draw_walls(pen: Pen, fr: Frag, s: sc.Scene, mode: str, win=None):
    """mode: ar — полный план (толстые грани, штриховка стен ППЗ, противопожарные стены двойной штриховкой);
    bg — подложка смежного раздела (серые тонкие грани, ППЗ — штриховкой)."""
    gray = 0.0 if mode == "ar" else 0.55
    width = (
        {"ext": 0.6, "int": 0.45, "part": 0.3}
        if mode == "ar"
        else {"ext": 0.25, "int": 0.2, "part": 0.15}
    )
    for w in sc.walls(s):
        x0, y0, x1, y1 = w.rect()
        lo, hi = (x0, x1) if w.horizontal else (y0, y1)
        pieces, cur = [], lo
        for g0, g1 in _gaps(s, w):
            if g0 > cur:
                pieces.append((cur, g0))
            cur = max(cur, g1)
        if cur < hi:
            pieces.append((cur, hi))
        for a, b in pieces:
            r = (a, y0, b, y1) if w.horizontal else (x0, a, x1, b)
            rc = _clip(r, win)
            if rc is None:
                continue
            tag = ["walls", f"wall:{w.id}"] + (["fire"] if w.fire else [])
            pen.poly(
                _rect_pts(fr, rc),
                close=True,
                width=width[w.kind] * (1.3 if w.fire else 1),
                gray=gray,
                tag=tag,
            )
            if w.fire:
                _hatch(pen, fr, rc, 1.2 * fr.n, tag=tag, gray=gray, cross=mode == "ar")
            elif mode == "ar" and w.kind == "ext":
                _hatch(pen, fr, rc, 2.5 * fr.n, tag=tag, gray=0.3)


def draw_door(
    pen: Pen, fr: Frag, s: sc.Scene, d: sc.Door, suffix="", leaf=True, mark=True
):
    w = sc.wall_by_id(s)[d.wall]
    tag = [f"door:{d.id}{suffix}", "doors"]
    if w.horizontal:
        yf = w.a[1] + d.side * w.t / 2
        H = (d.c + d.hinge * d.clear / 2, yf)
        T = (H[0], yf + d.side * d.leaf)
        E = (H[0] - d.hinge * d.leaf, yf)
        frames = [
            (
                d.c - d.opening / 2,
                w.a[1] - w.t / 2,
                d.c - d.clear / 2,
                w.a[1] + w.t / 2,
            ),
            (
                d.c + d.clear / 2,
                w.a[1] - w.t / 2,
                d.c + d.opening / 2,
                w.a[1] + w.t / 2,
            ),
        ]
    else:
        xf = w.a[0] + d.side * w.t / 2
        H = (xf, d.c + d.hinge * d.clear / 2)
        T = (xf + d.side * d.leaf, H[1])
        E = (xf, H[1] - d.hinge * d.leaf)
        frames = [
            (
                w.a[0] - w.t / 2,
                d.c - d.opening / 2,
                w.a[0] + w.t / 2,
                d.c - d.clear / 2,
            ),
            (
                w.a[0] - w.t / 2,
                d.c + d.clear / 2,
                w.a[0] + w.t / 2,
                d.c + d.opening / 2,
            ),
        ]
    for r in frames:
        pen.poly(_rect_pts(fr, r), close=True, width=0.18, tag=tag)
    if not leaf:
        return
    pen.line(fr.m(H), fr.m(T), width=0.35, tag=tag + [f"leaf:{d.id}{suffix}"])
    a0 = math.degrees(math.atan2(T[1] - H[1], T[0] - H[0])) + fr.theta
    a1 = math.degrees(math.atan2(E[1] - H[1], E[0] - H[0])) + fr.theta
    da = (a1 - a0 + 180) % 360 - 180
    pen.path(arc_cmds(fr.m(H), d.leaf / fr.n, a0, a0 + da), width=0.13, tag=tag)
    if mark:
        c = ((H[0] + T[0] + E[0]) / 3, (H[1] + T[1] + E[1]) / 3)
        pen.circle(fr.m(c), 1.6, width=0.13, tag=tag)
        pen.text(d.mark, (fr.m(c)[0], fr.m(c)[1] - 0.8), 2.0, tag=tag)


def draw_axes(pen: Pen, fr: Frag, s: sc.Scene, st: dict, win=None, tag="axes"):
    """Координационные оси: штрихпунктир, марка в кружке заданного диаметра (у разных листов — разный)."""
    r = st["bubble_mm"] / 2
    ext = 9.0 * fr.n
    bx0, by0, bx1, by1 = win or (-s.te, -s.te, s.X + s.te, s.yV + s.te)
    for mark, x in zip(s.x_marks, s.xs, strict=True):
        if not bx0 <= x <= bx1:
            continue
        a, b = (x, by0), (x, by1 + (ext if win is None else 0))
        _axis(pen, fr, mark, a, b, r, st, [tag, f"axis:{mark}"])
    for mark, y in s.y_axes.items():
        if not by0 <= y <= by1:
            continue
        a, b = (bx0, y), (bx1 + (ext if win is None else 0), y)
        _axis(pen, fr, mark, a, b, r, st, [tag, f"axis:{mark}"])


def _axis(pen, fr, mark, a, b, r, st, tag):
    A, B = fr.m(a), fr.m(b)
    pen.line(A, B, width=0.13, dash=[6, 1.5, 0.6, 1.5], tag=tag)
    L = math.dist(A, B)
    u = ((B[0] - A[0]) / L, (B[1] - A[1]) / L)
    c = (B[0] + u[0] * r, B[1] + u[1] * r)
    pen.circle(c, r, width=0.25, tag=tag)
    pen.text(
        mark,
        (c[0], c[1] - r * 0.4),
        r * 0.9,
        tag=tag,
        shx=decide(st["salt"], "axis:" + mark, st["shx"]),
    )


def draw_rooms(pen: Pen, fr: Frag, s: sc.Scene, st: dict):
    for rm in sc.rooms(s):
        x0, y0, x1, y1 = rm["rect"]
        c = fr.m(((x0 + x1) / 2, (y0 + y1) / 2))
        tag = f"room:{rm['number']}"
        sz = st["text_mm"]
        pen.text(
            rm["number"],
            (c[0], c[1] + 0.5),
            sz,
            tag=tag,
            shx=decide(st["salt"], tag, st["shx"]),
        )
        pen.text(
            f"{rm['area_m2']:.2f}".replace(".", ","),
            (c[0], c[1] - sz - 0.5),
            sz * 0.8,
            tag=tag,
            shx=decide(st["salt"], tag + ":a", st["shx"]),
        )


def draw_furniture(pen: Pen, fr: Frag, s: sc.Scene, st: dict, win=None):
    """Шум: столы и стулья в кабинетах, приборы санузла. Детализация (NEG-03) добавляет шкафы."""
    for rm in sc.rooms(s):
        x0, y0, x1, y1 = rm["rect"]
        if rm["name"] == "Кабинет" and win is None:
            n = st["noise"]
            for j in range(n):
                cx = x0 + (x1 - x0) * (j + 1) / (n + 1)
                cy = y0 + (y1 - y0) * 0.45
                pen.poly(
                    _rect_pts(fr, (cx - 600, cy - 300, cx + 600, cy + 300)),
                    close=True,
                    width=0.13,
                    gray=0.35,
                    tag="furniture",
                )
                for dx in (-350, 350):
                    pen.circle(
                        fr.m((cx + dx, cy - 550)),
                        220 / fr.n,
                        width=0.1,
                        gray=0.35,
                        tag="furniture",
                    )
            if s.detail:
                pen.poly(
                    _rect_pts(fr, (x1 - 700, y1 - 1800, x1 - 100, y1 - 200)),
                    close=True,
                    width=0.13,
                    gray=0.35,
                    tag="furniture",
                )
                pen.line(
                    fr.m((x1 - 700, y1 - 1800)),
                    fr.m((x1 - 100, y1 - 200)),
                    width=0.1,
                    gray=0.35,
                    tag="furniture",
                )
        if rm["name"] == "С/у МГН":
            wc = (x0 + 500, y1 - 750, x0 + 900, y1 - 50)
            pen.poly(_rect_pts(fr, wc), close=True, width=0.15, tag="fixtures")
            pen.path(
                arc_cmds(fr.m((x0 + 700, y1 - 900)), 200 / fr.n, 0, 360),
                width=0.13,
                tag="fixtures",
            )
            pen.poly(
                _rect_pts(fr, (x1 - 650, y1 - 500, x1 - 100, y1 - 50)),
                close=True,
                width=0.15,
                tag="fixtures",
            )
            for yy in (y1 - 300, y1 - 1000):  # поручни
                pen.line(
                    fr.m((x0 + 50, yy)),
                    fr.m((x0 + 450, yy)),
                    width=0.25,
                    tag="fixtures",
                )
            if win is not None:  # плитка на фрагменте — сетка 300 мм
                g = 300.0
                x = x0 + g
                while x < x1 - 1:
                    pen.line(
                        fr.m((x, y0)),
                        fr.m((x, y0 + 250)),
                        width=0.08,
                        gray=0.5,
                        tag="tile",
                    )
                    x += g


# ─────────────────────────────────────────────── листы


def _stamp(doc: dict, disc: str) -> dict:
    return {
        **doc["stamp"],
        "code": f"{doc['code']}-{disc}",
        "sheet": {"AR": 1, "OV": 2, "PB": 3, "GP": 4}[disc],
    }


def _fin(pen: Pen, c, st: dict):
    if c is not None:
        if st.get("rotate") == 90:
            c.setPageRotation(90)
        c.showPage()
        c.save()


def _cloud(pen: Pen, s: sc.Scene, disc: str):
    """MUT-17: облако изменения вокруг зоны мутации и номер изменения в треугольнике."""
    for d, tag in s.cloud:
        if d != disc or tag not in pen.tags:
            continue
        u0, v0, u1, v1 = pen.tags[tag]
        pts = [_denorm(pen, u, v) for u, v in ((u0, v0), (u1, v1))]
        x0, x1 = min(p[0] for p in pts) - 4, max(p[0] for p in pts) + 4
        y0, y1 = min(p[1] for p in pts) - 4, max(p[1] for p in pts) + 4
        cmds = []
        for a, b in (
            ((x0, y0), (x1, y0)),
            ((x1, y0), (x1, y1)),
            ((x1, y1), (x0, y1)),
            ((x0, y1), (x0, y0)),
        ):
            L = math.dist(a, b)
            k = max(1, int(L // 4))
            for i in range(k):
                p = (
                    a[0] + (b[0] - a[0]) * (i + 0.5) / k,
                    a[1] + (b[1] - a[1]) * (i + 0.5) / k,
                )
                ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
                cmds += arc_cmds(p, L / k / 2, ang + 180, ang, move=not cmds)
        pen.path(cmds, width=0.35, tag="cloud")
        tri = [(x1 + 1, y1 + 1), (x1 + 7, y1 + 1), (x1 + 4, y1 + 6)]
        pen.poly(tri, close=True, width=0.3, tag="cloud")
        pen.text("1", (x1 + 4, y1 + 2), 2.5, tag="cloud")


def _denorm(pen: Pen, u, v):
    if pen.rotate == 90:
        return (v * pen.w, u * pen.h)
    return (u * pen.w, (1 - v) * pen.h)


def _building_box(s: sc.Scene):
    return (-s.te, -s.te, s.X + s.te, s.yV + s.te)


def _new(path: Path | None, W, H, st, title_code):
    c = None
    if path is not None:
        # reportlab при /Rotate 90 меняет стороны MediaBox местами (pagesize — «как видно»): чтобы MediaBox остался
        # W × H, а повёрнут был лист, размер отдаётся уже повёрнутым
        size = (H * PT, W * PT) if st.get("rotate") == 90 else (W * PT, H * PT)
        c = rl_canvas.Canvas(str(path), pagesize=size, invariant=1)
        c.setTitle(title_code)
    return c, Pen(c, W, H, st.get("rotate", 0))


def page_ar(path, s: sc.Scene, st: dict, doc: dict) -> tuple[Pen, dict]:
    cx0, cy0, cx1, cy1 = s.cabin
    win = (cx0 - 700, cy0 - 900, cx1 + 700, cy1 + 700)
    n, nf = st["n_main"], st["n_frag"]
    fmt, W, H, frs = layout(
        [
            ("main", _building_box(s), n, st["theta"], 28.0),
            ("frag", win, nf, st["theta"], 22.0),
        ],
        tuple(st["shift"]),
    )
    c, pen = _new(path, W, H, st, f"{doc['code']}-AR")
    fr, ff = frs["main"], frs["frag"]
    no_scale = st.get("no_scale", False)
    frame_and_stamp(
        pen, W, H, _stamp(doc, "AR"), None if no_scale else f"1:{n:g}", DISC_TITLE["AR"]
    )
    draw_walls(pen, fr, s, "ar")
    for d in s.doors.values():
        draw_door(pen, fr, s, d)
    draw_axes(pen, fr, s, st)
    draw_rooms(pen, fr, s, st)
    draw_furniture(pen, fr, s, st)
    lbl = s.label_wc if s.label_wc is not None else s.wc
    xd = s.xs[s.f] + 1500
    if not no_scale:
        for i in range(len(s.xs) - 1):
            dim(
                pen,
                fr,
                (s.xs[i], 0),
                (s.xs[i + 1], 0),
                -16,
                f"{s.xs[i + 1] - s.xs[i]:.0f}",
                st,
                tag="dims:axes",
                key=f"ax{i}",
            )
        dim(
            pen,
            fr,
            (0, 0),
            (s.X, 0),
            -24,
            f"{s.X:.0f}",
            st,
            tag="dims:axes",
            key="axall",
        )
        ys = [0.0, s.y_axes["Б"], s.yV]
        for i in range(2):
            dim(
                pen,
                fr,
                (0, ys[i]),
                (0, ys[i + 1]),
                16,
                f"{ys[i + 1] - ys[i]:.0f}",
                st,
                tag="dims:axes",
                key=f"ay{i}",
            )
        dim(
            pen,
            fr,
            (xd, s.yb + s.t / 2),
            (xd, s.ytw - s.t / 2),
            0,
            f"{lbl:.0f}",
            st,
            tag=["corridor", "dim:corridor"],
            key="corridor",
        )
        if s.detail:  # NEG-03: привязка двери Д1 и внутренние размеры кабинетов — новые размеры, предмет тот же
            d1 = s.doors["D1"]
            dim(
                pen,
                fr,
                (s.xs[1], s.te / 2),
                (s.xs[1], d1.c - d1.opening / 2),
                -8,
                f"{d1.c - d1.opening / 2 - s.te / 2:.0f}",
                st,
                tag="dims:detail",
                key="d1ref",
            )
            for rm in sc.rooms(s)[: len(s.xs) - 1]:
                x0, y0, x1, y1 = rm["rect"]
                dim(
                    pen,
                    fr,
                    (x0, y1 - 300),
                    (x1, y1 - 300),
                    0,
                    f"{x1 - x0:.0f}",
                    st,
                    tag="dims:detail",
                    key=f"in{rm['number']}",
                )
    # коридор без размера тоже помечается зоной (ловушка NO_SCALE: доказательство — сам коридор)
    pen.mark(
        "corridor",
        [fr.m((xd - 300, s.yb + s.t / 2)), fr.m((xd + 300, s.ytw - s.t / 2))],
    )
    t = fr.m((s.X / 2, -s.te))
    pen.text(
        f"{DISC_TITLE['AR']}" + ("" if no_scale else f"   М1:{n:g}"),
        (t[0], t[1] - 34),
        4.0,
        tag="title",
    )
    # фрагмент санузла МГН в своём масштабе
    draw_walls(pen, ff, s, "ar", win=win)
    draw_door(pen, ff, s, s.doors["WC"], suffix="@f")
    draw_axes(pen, ff, s, st, win=win, tag="axes@f")
    draw_furniture(pen, ff, s, st, win=win)
    pen.mark("cabin@f", _rect_pts(ff, s.cabin))
    pen.mark("cabin", _rect_pts(fr, s.cabin))
    wc = s.doors["WC"]
    yf = s.ytw - s.t / 2
    dim(
        pen,
        ff,
        (cx0, cy1),
        (cx1, cy1),
        8,
        f"{cx1 - cx0:.0f}",
        st,
        tag=["cabin@f", "dim:cabin@f"],
        key="cabw",
    )
    dim(
        pen,
        ff,
        (cx1, cy0),
        (cx1, cy1),
        -8,
        f"{cy1 - cy0:.0f}",
        st,
        tag=["cabin@f", "dim:cabin@f"],
        key="cabd",
    )
    dim(
        pen,
        ff,
        (wc.c - wc.clear / 2, yf),
        (wc.c + wc.clear / 2, yf),
        -7,
        f"{wc.clear:.0f}",
        st,
        tag=["door:WC@f", "dim:wc@f"],
        key="wcclear",
    )
    t = ff.m(((win[0] + win[2]) / 2, win[1]))
    pen.text(f"Фрагмент 1. С/у МГН   М1:{nf:g}", (t[0], t[1] - 20), 3.5, tag="title@f")
    rows = [
        (r["number"], r["name"], f"{r['area_m2']:.2f}".replace(".", ","))
        for r in sc.rooms(s)
    ]
    table(
        pen,
        W - 5 - sc_w(),
        H - 12,
        ("Номер", "Наименование", "Площадь, м²"),
        (22, 60, 30),
        rows,
        "table:rooms",
    )
    _cloud(pen, s, "AR")
    _fin(pen, c, st)
    return pen, {
        "format": fmt,
        "w": W,
        "h": H,
        "frags": {k: _frag_meta(v) for k, v in frs.items()},
    }


def sc_w() -> float:
    return 112.0


def _frag_meta(f: Frag) -> dict:
    return {
        "n": f.n,
        "theta": f.theta,
        "pivot": list(f.pivot),
        "center_mm": [round(x, 4) for x in f.center],
    }


def _duct(pen: Pen, fr: Frag, pts, w: float, tag, detail_jog=False):
    """Воздуховод двумя линиями шириной w мм здания по ломаной pts (участки параллельны осям)."""
    for a, b in zip(pts, pts[1:], strict=False):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < 1e-6:
            continue
        nx, ny = -dy / L * w / 2, dx / L * w / 2
        for sgn in (1, -1):
            pen.line(
                fr.m((a[0] + sgn * nx, a[1] + sgn * ny)),
                fr.m((b[0] + sgn * nx, b[1] + sgn * ny)),
                width=0.25,
                tag=tag,
            )


def _valve(pen: Pen, fr: Frag, v: dict, vertical: bool, st: dict):
    at = fr.m(v["at"])
    ang = fr.theta + (90 if vertical else 0)
    tag = [f"valve:{v['id']}", "valves", "sym:ozk"]
    hw, hh = 1.8, 2.6
    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    pts = [(at[0] + q[0], at[1] + q[1]) for q in (rot(p, ang) for p in corners)]
    pen.poly(pts, close=True, width=0.3, fill=1.0, tag=tag)
    pen.line(pts[0], pts[2], width=0.3, tag=tag)
    off = rot((0, hh + 2.5), ang)
    pen.text(
        v["mark"],
        (at[0] + off[0], at[1] + off[1]),
        2.2,
        tag=tag,
        shx=decide(st["salt"], "v:" + v["id"], st["shx"]),
    )


def page_ov(path, s: sc.Scene, st: dict, doc: dict) -> tuple[Pen, dict]:
    n = st["n_main"]
    fmt, W, H, frs = layout(
        [("main", _building_box(s), n, st["theta"], 28.0)], tuple(st["shift"])
    )
    c, pen = _new(path, W, H, st, f"{doc['code']}-OV")
    fr = frs["main"]
    frame_and_stamp(pen, W, H, _stamp(doc, "OV"), f"1:{n:g}", DISC_TITLE["OV"])
    draw_walls(pen, fr, s, "bg")
    draw_axes(pen, fr, s, st)
    xf = s.xs[s.f]
    # установки и ответвления к сборному воздуховоду
    xs_branch = []
    for u in s.units:
        _unit(pen, fr, s, u, st)
        x0, y0, x1, _ = sc.unit_rect(s, u["slot"])
        xb = (x0 + x1) / 2
        xs_branch.append(xb)
        br = [(xb, y0), (xb, s.y_col)]
        if s.detail:  # отвод «уткой»: две точки излома, узлы графа те же
            br = [
                (xb, y0),
                (xb, (y0 + s.y_col) / 2),
                (xb + 150, (y0 + s.y_col) / 2 - 150),
                (xb + 150, s.y_col),
            ]
        _duct(pen, fr, br, 300, ["ducts", f"unit:{u['mark']}"])
    with pen.ghost():
        for g in s.ghosts:
            if g["kind"] == "unit":
                _unit(pen, fr, s, g["unit"], st)
            if g["kind"] == "valve":
                _valve(
                    pen, fr, g["valve"], abs(g["valve"]["at"][0] - s.x_down) < 1e-6, st
                )
    col0 = min(xs_branch + [s.x_down]) - 150
    _duct(pen, fr, [(col0, s.y_col), (s.x_down, s.y_col)], 400, ["ducts", "vent"])
    _duct(pen, fr, [(s.x_down, s.y_col), (s.x_down, s.y_duct)], 500, ["ducts", "vent"])
    _duct(pen, fr, [(s.x_down, s.y_duct), (xf, s.y_duct)], 500, ["ducts", "vent"])
    _duct(pen, fr, [(xf, s.y_duct), (s.x_end, s.y_duct)], 400, ["ducts", "vent"])
    for x, txt in (((s.x_down + xf) / 2, "500×300"), ((xf + s.x_end) / 2, "400×250")):
        p = fr.m((x, s.y_duct + 350))
        pen.text(
            txt,
            p,
            2.2,
            fr.theta,
            tag="sections",
            shx=decide(st["salt"], f"sec{x:.0f}", st["shx"]),
        )
    for v in s.valves:
        _valve(pen, fr, v, abs(v["at"][0] - s.x_down) < 1e-6, st)
    for tm in s.terminals:
        p = fr.m((tm["x"], s.y_duct))
        tag = [f"term:{tm['mark']}", "vent"]
        pen.poly(
            [
                (p[0] - 1.6, p[1] - 1.6),
                (p[0] + 1.6, p[1] - 1.6),
                (p[0] + 1.6, p[1] + 1.6),
                (p[0] - 1.6, p[1] + 1.6),
            ],
            close=True,
            width=0.25,
            fill=1.0,
            tag=tag,
        )
        pen.line((p[0] - 1.6, p[1] - 1.6), (p[0] + 1.6, p[1] + 1.6), width=0.2, tag=tag)
        pen.line((p[0] - 1.6, p[1] + 1.6), (p[0] + 1.6, p[1] - 1.6), width=0.2, tag=tag)
        q = fr.m((tm["x"], s.y_duct - 450))
        pen.text(
            tm["mark"],
            q,
            2.2,
            fr.theta,
            tag=tag,
            shx=decide(st["salt"], "t:" + tm["mark"], st["shx"]),
        )
    if s.detail:  # воздухораспределители без марок и переход — детализация РД
        for j in range(3):
            x = s.x_end + (xf - s.x_end) * (j + 1) / 4
            p = fr.m((x, s.y_duct - 700))
            pen.circle(p, 1.0, width=0.2, tag="detail")
            pen.line(fr.m((x, s.y_duct - 200)), p, width=0.15, tag="detail")
        a = fr.m((xf - 400, s.y_duct))
        pen.circle(a, 0.6, width=0.15, tag="detail")
    rows, rtags = [], []
    for u in sorted(s.units, key=lambda u: u["mark"]):
        rows.append((u["mark"], "Установка приточная", "1"))
        rtags.append(f"spec:{u['mark']}")
    sp = sc.spec_counts(s)
    if sp["ozk"] is not None:
        rows.append(("КП", sc.KIND_RU["ozk"][1][:32], str(sp["ozk"])))
        rtags.append("spec:ozk")
    table(
        pen,
        W - 5 - 140,
        H - 12,
        ("Поз.", "Наименование", "Кол."),
        (18, 104, 18),
        rows,
        "table:ov",
        rtags,
    )
    _cloud(pen, s, "OV")
    _fin(pen, c, st)
    return pen, {
        "format": fmt,
        "w": W,
        "h": H,
        "frags": {k: _frag_meta(v) for k, v in frs.items()},
    }


def _unit(pen: Pen, fr: Frag, s: sc.Scene, u: dict, st: dict):
    r = sc.unit_rect(s, u["slot"])
    tag = [f"unit:{u['mark']}", "vent", "units"]
    pen.poly(_rect_pts(fr, r), close=True, width=0.35, tag=tag)
    pen.line(fr.m((r[0], r[1])), fr.m((r[2], r[3])), width=0.15, tag=tag)
    p = fr.m(((r[0] + r[2]) / 2, r[3] + 200))
    pen.text(
        u["mark"],
        p,
        2.5,
        fr.theta,
        tag=tag,
        shx=decide(st["salt"], "u:" + u["mark"], st["shx"]),
    )


def _sym(pen: Pen, kind: str, p, tag, theta=0.0):
    if kind == "ip":
        pen.circle(p, 1.5, width=0.25, fill=1.0, tag=tag)
        pen.line((p[0] - 1.0, p[1] - 1.0), (p[0] + 1.0, p[1] + 1.0), width=0.2, tag=tag)
        pen.line((p[0] - 1.0, p[1] + 1.0), (p[0] + 1.0, p[1] - 1.0), width=0.2, tag=tag)
    elif kind == "op":
        pen.poly(
            [(p[0] - 1.6, p[1] - 1.3), (p[0] + 1.6, p[1] - 1.3), (p[0], p[1] + 1.5)],
            close=True,
            width=0.25,
            fill=1.0,
            tag=tag,
        )
        pen.circle(p, 0.4, width=0.1, fill=0.0, tag=tag)
    else:
        pen.poly(
            [
                (p[0] - 1.5, p[1] - 2.4),
                (p[0] + 1.5, p[1] - 2.4),
                (p[0] + 1.5, p[1] + 2.4),
                (p[0] - 1.5, p[1] + 2.4),
            ],
            close=True,
            width=0.25,
            fill=1.0,
            tag=tag,
        )
        pen.poly(
            [(p[0] - 1.5, p[1] - 2.4), (p[0] + 1.5, p[1] - 2.4), (p[0] + 1.5, p[1])],
            close=True,
            width=0.1,
            fill=0.0,
            tag=tag,
        )


def page_pb(path, s: sc.Scene, st: dict, doc: dict) -> tuple[Pen, dict]:
    n = st["n_main"]
    fmt, W, H, frs = layout(
        [("main", _building_box(s), n, st["theta"], 28.0)], tuple(st["shift"])
    )
    c, pen = _new(path, W, H, st, f"{doc['code']}-PB")
    fr = frs["main"]
    frame_and_stamp(pen, W, H, _stamp(doc, "PB"), f"1:{n:g}", DISC_TITLE["PB"])
    draw_walls(pen, fr, s, "bg")
    draw_axes(pen, fr, s, st)
    for kind, pts in (("ip", s.detectors), ("op", s.sounders), ("pk", s.hydrants)):
        for i, q in enumerate(pts):
            _sym(pen, kind, fr.m(q), [f"sym:{kind}", f"sym:{kind}:{i}"], fr.theta)
    y = H - 12
    x0 = W - 5 - 140
    pen.text("Условные обозначения", (x0, y), 3.0, anchor="l", tag="legend")
    for j, kind in enumerate(("ip", "op", "pk")):
        yy = y - 8 - 7 * j
        _sym(pen, kind, (x0 + 4, yy + 1), "legend")
        pen.text(sc.KIND_RU[kind][1], (x0 + 10, yy), 2.2, anchor="l", tag="legend")
    sp = sc.spec_counts(s)
    rows, rtags = [], []
    for kind in ("ip", "op", "pk"):
        if sp[kind] is not None:
            rows.append((sc.KIND_RU[kind][0], sc.KIND_RU[kind][1][:40], str(sp[kind])))
            rtags.append(f"spec:{kind}")
    table(
        pen,
        x0,
        y - 36,
        ("Поз.", "Наименование", "Кол."),
        (14, 108, 18),
        rows,
        "table:pb",
        rtags,
    )
    _cloud(pen, s, "PB")
    _fin(pen, c, st)
    return pen, {
        "format": fmt,
        "w": W,
        "h": H,
        "frags": {k: _frag_meta(v) for k, v in frs.items()},
    }


def page_gp(path, s: sc.Scene, st: dict, doc: dict) -> tuple[Pen, dict]:
    g = s.site
    items = sc.site_items(s)
    y_top = max(it["polygon"][2][1] for it in items if it["kind"] == "building") + 8000
    box = (-3000, -3000, g["Sx"] + 3000, y_top)
    n = st["n_site"]
    fmt, W, H, frs = layout(
        [("site", box, n, st["theta_site"], 24.0)], tuple(st["shift"])
    )
    c, pen = _new(path, W, H, st, f"{doc['code']}-GP")
    fr = frs["site"]
    frame_and_stamp(pen, W, H, _stamp(doc, "GP"), f"1:{n:g}", DISC_TITLE["GP"])
    pen.poly(
        [
            fr.m(p)
            for p in ((0, 0), (g["Sx"], 0), (g["Sx"], y_top - 2000), (0, y_top - 2000))
        ],
        close=True,
        width=0.3,
        dash=[8, 1.5, 0.6, 1.5],
        tag="site:boundary",
    )
    for it in items:
        k = it["kind"]
        tag = [f"site:{k}", f"site:{it['key']}"]
        if k in ("asphalt", "building", "paving", "lawn", "playground"):
            pen.poly(
                [fr.m(p) for p in it["polygon"]],
                close=True,
                width=0.45 if k != "building" else 0.6,
                tag=tag,
            )
        r = it.get("rect")
        if k == "paving" and r:
            _grid(pen, fr, r, 3.0 * n, tag)
        elif k == "lawn" and r:
            _grass(pen, fr, r, 4.0 * n, tag)
        elif k == "playground" and r:
            _hatch(pen, fr, r, 2.0 * n, tag=tag, cross=True)
        elif k == "building":
            _hatch(pen, fr, r, 1.5 * n, tag=tag)
        elif k == "road":
            y = (r[1] + r[3]) / 2
            pen.line(fr.m((r[0], y)), fr.m((r[2], y)), width=0.2, dash=[4, 2], tag=tag)
            dim(
                pen,
                fr,
                (g["Sx"] * 0.62, r[1]),
                (g["Sx"] * 0.62, r[3]),
                0,
                f"{it['width_mm'] / 1000:.2f}".replace(".", ","),
                st,
                tag=tag + ["dim:road"],
                key="road",
            )
    for i, stl in enumerate(sc.stalls(s)):
        x0, y0, x1, y1 = stl["rect"]
        tag = ["site:parking", f"stall:{i}"] + (["site:mgn"] if stl["mgn"] else [])
        pen.line(fr.m((x0, y0)), fr.m((x0, y1)), width=0.25, tag=tag)
        pen.line(fr.m((x1, y0)), fr.m((x1, y1)), width=0.25, tag=tag)
        if stl["mgn"]:
            p = fr.m(((x0 + x1) / 2, (y0 + y1) / 2))
            pen.circle((p[0], p[1] + 2.2), 0.6, width=0.2, fill=0.0, tag=tag)
            pen.poly(
                [
                    (p[0], p[1] + 1.4),
                    (p[0], p[1]),
                    (p[0] + 1.4, p[1]),
                    (p[0] + 1.8, p[1] - 1.4),
                ],
                width=0.3,
                tag=tag,
            )
            pen.path(
                arc_cmds((p[0] - 0.2, p[1] - 0.6), 1.3, 100, 300), width=0.3, tag=tag
            )
    if s.detail or st["noise"] > 1:
        for j, (tx, ty) in enumerate(g.get("trees") or []):
            pen.circle(fr.m((tx, ty)), 1800 / n, width=0.15, gray=0.3, tag="trees")
            del j
    rows = []
    for kind, ru in (
        ("asphalt", "Асфальтобетон"),
        ("paving", "Плитка тротуарная"),
        ("lawn", "Газон"),
        ("playground", "Площадка детская"),
    ):
        rows.append((ru, f"{sc.site_area(s, kind):.1f}".replace(".", ",")))
    table(
        pen,
        W - 5 - 100,
        H - 12,
        ("Покрытие", "Площадь, м²"),
        (65, 35),
        rows,
        "table:gp",
    )
    t = fr.m((g["Sx"] / 2, -3000))
    pen.text(
        f"Схема планировочной организации   М1:{n:g}",
        (t[0], t[1] - 10),
        4.0,
        tag="title",
    )
    _cloud(pen, s, "GP")
    _fin(pen, c, st)
    return pen, {
        "format": fmt,
        "w": W,
        "h": H,
        "frags": {k: _frag_meta(v) for k, v in frs.items()},
    }


def _grid(pen, fr, r, sp, tag):
    x0, y0, x1, y1 = r
    x = x0 + sp
    while x < x1 - 1e-6:
        pen.line(fr.m((x, y0)), fr.m((x, y1)), width=0.08, gray=0.45, tag=tag)
        x += sp
    y = y0 + sp
    while y < y1 - 1e-6:
        pen.line(fr.m((x0, y)), fr.m((x1, y)), width=0.08, gray=0.45, tag=tag)
        y += sp


def _grass(pen, fr, r, sp, tag):
    x0, y0, x1, y1 = r
    y = y0 + sp / 2
    while y < y1:
        x = x0 + sp / 2
        while x < x1:
            p = fr.m((x, y))
            pen.poly(
                [(p[0] - 0.6, p[1]), (p[0], p[1] + 0.9), (p[0] + 0.6, p[1])],
                width=0.1,
                gray=0.4,
                tag=tag,
            )
            x += sp
        y += sp


PAGES = {"AR": page_ar, "OV": page_ov, "PB": page_pb, "GP": page_gp}
