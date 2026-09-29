"""Точность извлечения геометрии на генераторе РАЗРАБОТКИ (T-192): PlanGeometry против истины `synth.plans`.

Набор разработки — не для приёмки (ADR-0010 п. 6): цифры отсюда показывают, что извлечение работает на соглашении
генератора, и не идут в таблицу качества. Приёмка — на отложенном наборе T-195.

Сравнение — в мм системы осей здания: геометрия листа переводится `frame.to_bld` (NRM-09), а где рамки нет
(генплан) — обратным к `sheet_from_bld` истины (только лист без поворота).

    uv run python -m eval.plan_geom_dev [seed0] [seeds] [kinds] ['{"rot_deg": 3}']   # сводка по видам листа
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

import numpy as np

from inspector_ml.plan_geom import apply_affine, plan_geometry

TOL_MM = 60.0  # совпадение точки с истиной в мм натуры


def _inv(m):
    a, b, c, d, e, f = m
    A = np.array([[a, c], [b, d]])
    Ai = np.linalg.inv(A)
    t = -Ai @ np.array([e, f])
    return [Ai[0, 0], Ai[1, 0], Ai[0, 1], Ai[1, 1], t[0], t[1]]


def to_bld(geo: dict, truth: dict):
    """Функция «мм листа → мм здания» для сравнения."""
    m = geo["frame"]["to_bld"] or _inv(truth["sheet_from_bld"])

    def f(p):
        return apply_affine(m, [p])[0]

    return f


def _near(p, q, tol=TOL_MM) -> bool:
    return math.dist(p, q) <= tol


def score(truth: dict, geo: dict) -> dict:
    """Метрики одного листа: доли найденного, ошибки в мм/м², ложные находки."""
    f = to_bld(geo, truth)
    out: dict = {"quality": geo["quality"]["status"], "scale_err_pct": None}
    if geo["scale"]["n"]:
        out["scale_err_pct"] = (
            abs(geo["scale"]["n"] - truth["scale"]) / truth["scale"] * 100
        )
    # оси: марка и положение
    if truth["axes"]:
        found = {a["mark"]: a for a in geo["axes"]}
        errs = []
        for t in truth["axes"]:
            a = found.get(t["mark"])
            if a is None:
                continue
            mid = f(((a["p0"][0] + a["p1"][0]) / 2, (a["p0"][1] + a["p1"][1]) / 2))
            errs.append(abs(mid[0 if t["family"] == "num" else 1] - t["pos"]))
        out["axes_recall"] = len(errs) / len(truth["axes"])
        out["axes_pos_err_mm"] = max(errs) if errs else None
    # размеры
    if truth["dims"]:
        gd = [(f(d["p0"]), f(d["p1"]), d) for d in geo["dims"]]
        hit, val_ok = 0, 0
        for t in truth["dims"]:
            m = next(
                (
                    d
                    for a, b, d in gd
                    if (_near(a, t["p0"]) and _near(b, t["p1"]))
                    or (_near(a, t["p1"]) and _near(b, t["p0"]))
                ),
                None,
            )
            if m is not None:
                hit += 1
                val_ok += m["value_mm"] == t["value_mm"]
        out["dims_recall"] = hit / len(truth["dims"])
        out["dims_value_ok"] = val_ok / max(hit, 1)
        out["dims_found"] = len(geo["dims"])
    # стены
    if truth["walls"]:
        gw = [(f(w["a"]), f(w["b"]), w) for w in geo["walls"]]
        used, terr = set(), []
        for t in truth["walls"]:
            for k, (a, b, w) in enumerate(gw):
                if k in used:
                    continue
                if (_near(a, t["a"]) and _near(b, t["b"])) or (
                    _near(a, t["b"]) and _near(b, t["a"])
                ):
                    used.add(k)
                    terr.append(abs(w["thickness_mm"] - t["thickness_mm"]))
                    break
        out["walls_recall"] = len(terr) / len(truth["walls"])
        out["walls_precision"] = len(used) / max(len(gw), 1)
        out["walls_t_err_mm"] = max(terr) if terr else None
        fire_t = sum(t["fire"] for t in truth["walls"])
        out["fire_walls"] = (sum(w["fire"] for _, _, w in gw), fire_t)
    # проёмы
    if truth["openings"]:
        go = [
            (
                f(
                    (
                        (o["bbox"][0] + o["bbox"][2]) / 2 * geo["_w"],
                        (o["bbox"][1] + o["bbox"][3]) / 2 * geo["_h"],
                    )
                ),
                o,
            )
            for o in geo["openings"]
        ]
        used, werr, cerr, kind_ok, mark_ok = set(), [], [], 0, 0
        for t in truth["openings"]:
            for k, (c, o) in enumerate(go):
                if k not in used and _near(c, t["at"], 150):
                    used.add(k)
                    werr.append(abs(o["width_mm"] - t["width_mm"]))
                    cerr.append(abs(o["clear_mm"] - t["clear_mm"]))
                    kind_ok += o["kind"] == t["kind"]
                    mark_ok += o["mark"] == t["mark"]
                    break
        n = len(truth["openings"])
        out["openings_recall"] = len(werr) / n
        out["openings_precision"] = len(used) / max(len(go), 1)
        out["openings_width_err_mm"] = max(werr) if werr else None
        out["openings_clear_err_mm"] = max(cerr) if cerr else None
        out["openings_kind_ok"] = kind_ok / max(len(werr), 1)
        out["openings_mark_ok"] = mark_ok / max(len(werr), 1)
    # лестницы и шахты
    for kind in ("stair", "lift"):
        ts = [s for s in truth["stairs"] if s["kind"] == kind]
        if not ts:
            continue
        gs = [s for s in geo["stairs"] if s["kind"] == kind]
        if kind == "stair":
            out["stair_steps_ok"] = bool(gs) and gs[0]["steps"] == ts[0]["steps"]
            out["stair_tread_err_mm"] = (
                abs(gs[0]["tread_mm"] - ts[0]["tread_mm"]) if gs else None
            )
            out["stair_riser_ok"] = bool(gs) and gs[0]["riser_mm"] == ts[0]["riser_mm"]
        else:
            out["lift_err_mm"] = (
                max(abs(a - b) for a, b in zip(gs[0]["shaft_mm"], ts[0]["shaft_mm"]))
                if gs
                else None
            )
    if truth["levels"]:
        vals = Counter(round(v["value_m"], 3) for v in geo["levels"])
        want = Counter(round(v["value_m"], 3) for v in truth["levels"])
        out["levels_recall"] = sum((vals & want).values()) / sum(want.values())
    if truth["rooms"]:
        gr = {r["number"]: r for r in geo["rooms"]}
        errs = [
            abs(gr[t["number"]]["area_m2"] - t["area_m2"])
            for t in truth["rooms"]
            if t["number"] in gr
        ]
        out["rooms_recall"] = len(errs) / len(truth["rooms"])
        out["rooms_area_err_m2"] = max(errs) if errs else None
    if truth["routes"]:
        ok = 0
        for t in truth["routes"]:
            g = next((r for r in geo["routes"] if r["system"] == t["system"]), None)
            if g is None or g["section"] != t["section"]:
                continue
            kinds_t = Counter(k for k, _ in t["nodes"])
            kinds_g = Counter(nd["kind"] for nd in g["nodes"])
            ok += kinds_t == kinds_g and len(g["edges"]) == len(t["edges"])
        out["routes_ok"] = ok / len(truth["routes"])
        out["routes_found"] = len(geo["routes"])
    if truth["symbols"]:
        want = Counter(s["kind"] for s in truth["symbols"])
        got = Counter(s["kind"] for s in geo["symbols"])
        out["symbols_recall"] = sum((got & want).values()) / sum(want.values())
        out["symbols_extra"] = sum((got - want).values())
    if truth["site"]:
        errs, width_err, park = [], None, (0, 0)
        for t in truth["site"]:
            if t["kind"] in ("parking", "parking_mgn"):
                continue
            kind = t["kind"]
            g = [s for s in geo["site"] if s["kind"] == kind]
            if g:
                errs.append(
                    abs(sum(s["area_m2"] for s in g) - t["area_m2"]) / t["area_m2"]
                )
                if kind == "road":
                    width_err = abs(g[0]["width_mm"] - t["width_mm"])
            else:
                errs.append(1.0)
        want = Counter(
            t["kind"] for t in truth["site"] if t["kind"].startswith("parking")
        )
        got = Counter(s["kind"] for s in geo["site"] if s["kind"].startswith("parking"))
        out["site_area_err_rel"] = max(errs) if errs else None
        out["site_road_width_err_mm"] = width_err
        out["parking"] = (dict(got), dict(want))
    return out


def run(seed: int, kind: str, workdir: Path, **kw) -> tuple[dict, dict, float]:
    """Лист генератора → разбор → PlanGeometry. Возвращает (истина, геометрия, секунды)."""
    from inspector_ml.parse import parse_file
    from synth.plans import plan

    pdf = workdir / f"{kind}-{seed}.pdf"
    truth = plan(seed, kind, pdf, **kw)
    doc = parse_file(pdf, "0" * 64)
    t0 = time.perf_counter()
    geo = plan_geometry(pdf, 1, doc.pages[0])
    sec = time.perf_counter() - t0
    geo["_w"], geo["_h"] = (
        doc.pages[0].width * 25.4 / 72,
        doc.pages[0].height * 25.4 / 72,
    )
    pdf.unlink()
    return truth, geo, sec


def main(argv: list[str]) -> None:
    seed0 = int(argv[0]) if argv else 0
    count = int(argv[1]) if len(argv) > 1 else 10
    kinds = argv[2].split(",") if len(argv) > 2 else ["ar", "eng", "gp"]
    kw = json.loads(argv[3]) if len(argv) > 3 else {}
    with tempfile.TemporaryDirectory() as d:
        for kind in kinds:
            rows, secs = [], []
            for seed in range(seed0, seed0 + count):
                truth, geo, sec = run(seed, kind, Path(d), **kw)
                rows.append(score(truth, geo))
                secs.append(sec)
            keys = sorted({k for r in rows for k in r})
            summary = {"kind": kind, "transform": kw, "sheets": count, "max_s": round(max(secs), 2)}
            for k in keys:
                vals = [r[k] for r in rows if r.get(k) is not None]
                if vals and all(
                    isinstance(v, (int, float)) and not isinstance(v, bool)
                    for v in vals
                ):
                    summary[k] = {
                        "mean": round(float(np.mean(vals)), 4),
                        "worst": round(
                            float(
                                max(vals) if "err" in k or "extra" in k else min(vals)
                            ),
                            4,
                        ),
                    }
                elif vals and all(isinstance(v, bool) for v in vals):
                    summary[k] = f"{sum(vals)}/{len(vals)}"
                elif vals:
                    summary[k] = vals[:3]
            print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
