"""Генератор отложенного состязательного набора W2 (T-195, каталог TO-BE §15.1–15.2, ADR-0010 п. 6;
OS-INSP-6.5.60–6.5.66).

Пример — пара «ПД → РД» одного вымышленного объекта: по четыре однолистовых векторных PDF на стадию (АР, ОВ, ПБ,
ГП). В РД внесена одна мутация каталога (MUT-04, 09, 10, 13, 14; MUT-17 — модификатор) или это отрицательный
контроль (NEG-01…03) либо ловушка (сдвиг, поворот и масштаб листа, полотно двери без изменения в свету, ОЗК в
окрестности пересечения, изменения в допуске, лист без масштаба, другие соглашения оформления).

Истина — по правилу пары из реестра `eval/mutations/w2.json`, посчитанному на сцене ПД и РД, и сверена с
декларацией эффектов мутации в том же реестре: расхождение — отказ, а не тихая метка. Каждый пример пишется на
диск и отпускается (память прогона не растёт с числом примеров). Детерминированно по seed; seed < 100000 — отказ:
0–9999 отданы генератору разработки T-192.

    uv run python -m eval.w2_holdout.generate --seed 100000 --out ../var/w2-holdout          # из каталога ml/
    uv run python -m eval.w2_holdout.generate --seed 100000 --out ../var/w2h --only NEG-01 MUT-09/door --per 2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sys
from collections import Counter
from pathlib import Path

ML = Path(__file__).resolve().parents[2]
if str(ML) not in sys.path:  # запуск файлом
    sys.path.insert(0, str(ML))

from eval.w2_holdout import scene as sc  # noqa: E402

REGISTRY = ML / "eval/mutations/w2.json"
SCHEMA = "inspector-w2-holdout/1"
SEED_MIN = 100000
DISCS = ("AR", "OV", "PB", "GP")
DISC_RU = {"AR": "АР", "OV": "ОВ", "PB": "ПБ", "GP": "ГП"}
STATUS = {"PD": "APPROVED", "RD": "FOR_CONSTRUCTION"}


def load_registry(path: Path = REGISTRY) -> dict:
    reg = json.loads(path.read_text("utf-8"))
    if reg.get("schema") != "inspector-w2-holdout-params/1":
        raise ValueError(
            f"реестр {path.name}: схема {reg.get('schema')!r}, ожидалась inspector-w2-holdout-params/1"
        )
    pairs = [pair_key(p) for p in reg["params"]]
    dup = [k for k, n in Counter(pairs).items() if n > 1]
    if dup:
        raise ValueError(f"реестр {path.name}: пары повторяются: {dup}")
    for m, spec in [*reg["mutations"].items(), *reg["controls"].items()]:
        for v in spec.get("variants", {"": spec}).values():
            unknown = set(v.get("effects", {})) - set(pairs)
            if unknown:
                raise ValueError(
                    f"реестр {path.name}: {m} объявляет эффект на неизвестные пары {sorted(unknown)}"
                )
    return reg


def pair_key(p: dict) -> str:
    return f"{p['code']}×{p['operator']}"


def registry_sha(reg: dict) -> str:
    return hashlib.sha256(
        json.dumps(reg, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:16]


# ─────────────────────────────────────────────── план примеров


def plan(reg: dict, scale: float = 1.0) -> list[tuple[str, str, str | None]]:
    """(мутация или контроль, вариант, модификатор) в постоянном порядке: номер примера = место в полном плане."""

    def n(x: int) -> int:
        return max(1, round(x * scale))

    out: list[tuple[str, str, str | None]] = []
    for m, spec in reg["mutations"].items():
        for v, vs in spec["variants"].items():
            out += [(m, v, None)] * n(vs["n"])
    for m, spec in reg["controls"].items():
        out += [(m, "", None)] * n(spec["n"])
    for mod, spec in reg["modifiers"].items():
        over = spec["over"]
        for j in range(n(spec["n"])):
            m, v = over[j % len(over)].split("/")
            out.append((m, v, mod))
    return out


def label(m: str, v: str) -> str:
    return f"{m}/{v}" if v else m


# ─────────────────────────────────────────────── стиль листа


def make_style(rng: random.Random, small: bool) -> dict:
    return {
        "n_main": 50 if small else 200,
        "n_frag": 25 if small else 50,
        "n_site": 500,
        "rotate": 90 if rng.random() < 0.25 else 0,
        "theta": rng.choice([0, 0, 15, 30]),
        "theta_site": rng.choice([0, 0, 12, 20]),
        "dim_end": rng.choices(["arrow", "tick", "dot"], [6, 2, 2])[0],
        "text_side": rng.choice(["above", "below"]),
        "bubble_mm": rng.choice([6, 8, 10, 12]),
        "shx": rng.choice([0.0, 0.3, 0.7]),
        "noise": rng.choice([1, 2]),
        "text_mm": rng.choice([2.5, 3.0, 3.5]),
        "shift": [0.0, 0.0],
        "no_scale": False,
        "salt": rng.randrange(1 << 30),
    }


# ─────────────────────────────────────────────── мутации и контроли (меняют РД; возвращают фокус доказательства)


def _d1_range(s: sc.Scene) -> tuple[float, float]:
    d = s.doors["D1"]
    return s.te / 2 + 150 + d.opening / 2, s.yb - s.t / 2 - 150 - d.opening / 2


def _sign_room(rng, c, lo, hi, dmin, dmax) -> float:
    """Сдвиг c на ±[dmin, dmax] в пределах [lo, hi]; направление — где хватает места."""
    up, down = hi - c, c - lo
    room, sgn = (up, 1) if up >= down else (down, -1)
    if room < dmin:
        raise ValueError(f"нет места для сдвига ≥ {dmin}: {room:.0f}")
    return sgn * round(rng.uniform(dmin, min(dmax, room)), 0)


def _border_delta(s: sc.Scene, small: bool) -> float:
    """Сдвиг границы плитка | газон: обе площади меняются ≥ 8 %, контур газона — IoU < 0,95. small — ловушка
    допуска: обе площади < 1,5 %, IoU > 0,98, Хаусдорф < 800 мм."""
    g = s.site
    lawn = sc.site_area(s, "lawn") * 1e6 / g["Pv"]
    lb = g["Sx"] - g["Xb"]
    if small:
        return math.floor(min(0.012 * lawn, 0.012 * g["Xb"], 0.015 * lb, 800) / 10) * 10
    return math.ceil(max(0.08 * lawn, 0.08 * g["Xb"], 0.06 * lb) * 1.15 / 100) * 100


def apply(
    rng: random.Random, m: str, v: str, pd: sc.Scene, rd: sc.Scene, st: dict
) -> dict:
    """Вносит мутацию или контроль в РД. → фокус доказательства: вид меры → [(лист, тег)]."""
    if m == "MUT-04":
        if v == "remove":
            u = rng.choice(rd.units)
            rd.units.remove(u)
            rd.ghosts.append({"kind": "unit", "unit": u})
        else:
            slot = max(u["slot"] for u in rd.units) + 1
            mark = f"П{max(int(u['mark'][1:]) for u in rd.units) + 1}"
            u = {"mark": mark, "slot": slot}
            if sc.unit_rect(rd, slot)[2] > rd.x_down - 300:
                raise ValueError("установка не помещается в венткамеру")
            rd.units.append(u)
        return {"vent_graph": [("OV", f"unit:{u['mark']}")]}
    if m == "MUT-09" and v == "door":
        d = rd.doors["D1"]
        d.c += _sign_room(rng, d.c, *_d1_range(rd), 300, 900)
        return {"door_pos": [("AR", "door:D1")]}
    if m == "MUT-09" and v == "partition":
        wl = rd.doors["WC"]
        lo = (
            wl.c - wl.clear / 2 + wl.leaf + 200 + rd.tp / 2
        )  # дуга полотна (петли слева) не упирается в перегородку
        hi = rd.xs[1] - rd.tp - 1500
        rd.xp += _sign_room(rng, rd.xp, lo, hi, 150, 400)
        return {
            k: [("AR", "cabin@f")]
            for k in ("cabin_width", "cabin_area", "cabin_contour")
        }
    if m == "MUT-09" and v == "border":
        g = rd.site
        dlt = _border_delta(rd, small=False)
        g["Xb"] += dlt if g["Sx"] - g["Xb"] - dlt >= 5000 else -dlt
        return {
            "area:lawn": [("GP", "site:lawn:B")],
            "area:paving": [("GP", "site:paving")],
            "lawn_contour": [("GP", "site:lawn:B")],
        }
    if m == "MUT-10" and v in ("corridor_below", "wall_only", "corridor_above"):
        if v == "corridor_above":
            wc = float(rng.choice([x for x in range(1200, int(pd.wc) - 99, 50)]))
        else:
            wc = float(rng.choice([900, 1000, 1050, 1100, 1150]))
        rd.yb = rd.ytw - rd.t - wc
        rd.label_wc = pd.wc if v == "wall_only" else None
        return {"corridor_clear": [("AR", "corridor")]}
    if m == "MUT-10" and v == "door_below":
        d = rd.doors["WC"]
        d.leaf, d.clear = 900.0, float(rng.choice([800, 820, 850, 870]))
        return {"door_clear": [("AR", "door:WC@f")]}
    if m == "MUT-13":
        vv = rng.choice(rd.valves)
        rd.valves.remove(vv)
        rd.ghosts.append({"kind": "valve", "valve": vv})
        z = [("OV", f"valve:{vv['id']}")]
        return {
            "ozk_cover": z,
            "ozk_presence": z,
            "count:ozk": z,
            "vent_graph": z,
            "ozk_cover_ar": [("AR", "fire"), *z],
        }
    if m == "MUT-14":
        rd.spec_removed.append(v)
        disc, table = ("OV", "table:ov") if v == "ozk" else ("PB", "table:pb")
        return {
            f"spec:{v}": [(disc, table), (disc, f"sym:{v}")],
            f"count:{v}": [(disc, f"sym:{v}")],
        }
    if m in ("NEG-01", "NEG-02"):
        return {}
    if m == "NEG-03":
        rd.detail = True
        g = rd.site
        y = g["Wr"] + g["band"] + g["Pv"] / 2
        g["trees"] = [
            [round(g["Xb"] + (g["Sx"] - g["Xb"]) * (j + 0.5) / 5, 0), y]
            for j in range(5)
        ]
        return {}
    if m == "TRAP-SHIFT":
        st["shift"] = [
            rng.choice([-1, 1]) * round(rng.uniform(8, 25), 1),
            rng.choice([-1, 1]) * round(rng.uniform(8, 25), 1),
        ]
        return {}
    if m == "TRAP-ROTATE":
        if rng.random() < 0.5:
            st["rotate"] = 90 - st["rotate"]
        else:
            st["theta"] = (st["theta"] + 90) % 360
        return {}
    if m == "TRAP-SCALE":
        st["n_main"] = 100
        return {}
    if m == "TRAP-LEAF":
        rd.doors["WC"].leaf += 100
        return {"door_clear": [("AR", "door:WC@f")]}
    if m == "TRAP-OZK-NEAR":
        vv = rng.choice(rd.valves)
        _nudge(rd, vv, rng.choice([-1, 1]) * round(rng.uniform(200, 300), 0))
        return {"ozk_cover": [("OV", f"valve:{vv['id']}")]}
    if m == "TRAP-TOL":
        rd.doors["D1"].c += rng.choice([-30, 30])
        rd.yb += 10
        rd.site["Xb"] += _border_delta(rd, small=True)
        _nudge(rd, rng.choice(rd.valves), rng.choice([-50, 50]))
        return {}
    if m == "TRAP-NOSCALE":
        st["no_scale"] = True
        return {}
    if m == "TRAP-STYLE":
        st["dim_end"] = {"arrow": "tick", "tick": "dot", "dot": "arrow"}[st["dim_end"]]
        st["text_side"] = "below" if st["text_side"] == "above" else "above"
        st["bubble_mm"] = {6: 10, 8: 12, 10: 6, 12: 8}[st["bubble_mm"]]
        st["shx"] = {0.0: 0.7, 0.3: 0.0, 0.7: 0.3}[st["shx"]]
        return {}
    raise ValueError(f"неизвестная мутация или контроль: {label(m, v)}")


def _nudge(s: sc.Scene, v: dict, d: float) -> None:
    """Сдвиг клапана вдоль воздуховода: на стояке — по y, на магистрали — по x."""
    if abs(v["at"][0] - s.x_down) < 1e-6:
        v["at"] = [v["at"][0], v["at"][1] + d]
    else:
        v["at"] = [v["at"][0] + d, v["at"][1]]


# ─────────────────────────────────────────────── меры и правила истины


def door_point(s: sc.Scene, door_id: str) -> list[float]:
    d = s.doors[door_id]
    w = sc.wall_by_id(s)[d.wall]
    return [d.c, w.a[1]] if w.horizontal else [w.a[0], d.c]


def measure(kind: str, s: sc.Scene):
    """Истинное значение меры пары на сцене (мм здания, м² — площади)."""
    if kind == "corridor_clear":
        return s.wc
    x0, y0, x1, y1 = s.cabin
    if kind == "cabin_width":
        return x1 - x0
    if kind == "cabin_area":
        return round((x1 - x0) * (y1 - y0) / 1e6, 4)
    if kind == "cabin_contour":
        return [x0, y0, x1, y1]
    if kind == "door_clear":
        return s.doors["WC"].clear
    if kind == "door_pos":
        return door_point(s, "D1")
    if kind == "axis_steps":
        ys = list(s.y_axes.values())
        return [b - a for a, b in zip(s.xs, s.xs[1:], strict=False)] + [
            b - a for a, b in zip(ys, ys[1:], strict=False)
        ]
    if kind == "axis_pos":
        return {**dict(zip(s.x_marks, s.xs, strict=True)), **s.y_axes}
    if kind == "road_width":
        return s.site["Wr"]
    if kind.startswith("area:"):
        return sc.site_area(s, kind.split(":")[1])
    if kind == "lawn_contour":
        return list(
            next(it["rect"] for it in sc.site_items(s) if it["key"] == "lawn:B")
        )
    if kind == "vent_graph":
        return sc.vent_graph(s)
    if kind in ("ozk_cover", "ozk_cover_ar"):
        return {
            "crossings": sc.crossings(s),
            "valves": [list(v["at"]) for v in s.valves],
        }
    if kind == "ozk_presence":
        return [list(v["at"]) for v in s.valves]
    if kind.startswith("count:"):
        return sc.drawing_counts(s)[kind.split(":")[1]]
    if kind.startswith("spec:"):
        k = kind.split(":")[1]
        return [sc.spec_counts(s)[k], sc.drawing_counts(s)[k]]
    raise ValueError(f"неизвестная мера {kind}")


def rect_iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def rect_hausdorff(a, b) -> float:
    """Хаусдорф границ двух прямоугольников, параллельных осям, с общими сторонами по направлению: наибольший сдвиг
    стороны (для вложенных и сдвинутых прямоугольников сцены это точное значение)."""
    return max(abs(a[i] - b[i]) for i in range(4))


def breaks(rule: dict, pd, rd) -> bool:
    """Нарушено ли правило пары (каталог §11.2): True — оператор должен дать DIFF/WORSE."""
    t = rule["type"]
    if t == "abs":
        return abs(rd - pd) > rule["tol"]
    if t == "pct":
        return abs(rd - pd) > abs(pd) * rule["pct"] / 100
    if t == "min":
        return rd < rule["min"]
    if t == "pos":
        return math.dist(pd, rd) > rule["tol"]
    if t == "steps":
        return len(pd) != len(rd) or any(
            abs(a - b) > rule["tol"] for a, b in zip(pd, rd, strict=True)
        )
    if t == "axes":
        return set(pd) != set(rd) or any(abs(pd[k] - rd[k]) > rule["tol"] for k in pd)
    if t == "shape":
        return rect_iou(pd, rd) < rule["iou"] or rect_hausdorff(pd, rd) > rule["haus"]
    if t in ("graph", "count"):
        return pd != rd
    if t == "presence":
        return any(
            min((math.dist(p, q) for q in rd), default=math.inf) > rule["d"] for p in pd
        )
    if t == "cover":
        return any(
            min((math.dist(c, q) for q in rd["valves"]), default=math.inf) > rule["d"]
            for c in rd["crossings"]
        )
    if t == "internal":
        return rd[0] != rd[1]
    raise ValueError(f"неизвестное правило {t}")


def computed_status(
    p: dict, pd: sc.Scene, rd: sc.Scene, st_rd: dict
) -> tuple[str, object, object]:
    """Статус пары по правилу на сцене с явными исключениями каталога: лист без масштаба → NOT_COMPARABLE (VER-04),
    надпись размера против геометрии > 2 % → вне P/R (CMP-12, VER-06), счёт по чертежу при расхождении спецификации
    со знаками внутри РД → вне P/R (CMP-07, двойной подсчёт)."""
    kind = p["kind"]
    a, b = measure(kind, pd), measure(kind, rd)
    status = "CANDIDATE" if breaks(p["rule"], a, b) else "NEGATIVE_VERIFIED"
    if p["disc"] == "AR" and p.get("frag") == "main" and st_rd.get("no_scale"):
        status = "NEG:NOT_COMPARABLE"
    if (
        kind == "corridor_clear"
        and rd.label_wc is not None
        and abs(rd.label_wc - rd.wc) > 0.02 * rd.wc
    ):
        status = "OTHER:label_conflict"
    if p["operator"] == "CMP-07" and kind.split(":")[1] in sc.KINDS:
        k = kind.split(":")[1]
        if sc.spec_counts(rd)[k] != sc.drawing_counts(rd)[k]:
            status = "OTHER:dual_count"
    return status, a, b


def declared(reg: dict, m: str, v: str) -> dict:
    if m in reg["mutations"]:
        return reg["mutations"][m]["variants"][v].get("effects", {})
    return reg["controls"][m].get("effects", {})


def default_focus(kind: str, disc: str) -> list[tuple[str, str]]:
    if kind == "corridor_clear":
        return [("AR", "corridor")]
    if kind.startswith("cabin_"):
        return [("AR", "cabin@f")]
    if kind == "door_clear":
        return [("AR", "door:WC@f")]
    if kind == "door_pos":
        return [("AR", "door:D1")]
    if kind.startswith("axis_"):
        return [("AR", "axes")]
    if kind == "road_width":
        return [("GP", "site:road")]
    if kind.startswith("area:"):
        return [("GP", f"site:{kind.split(':')[1]}")]
    if kind == "lawn_contour":
        return [("GP", "site:lawn:B")]
    if kind == "vent_graph":
        return [("OV", "vent")]
    if kind == "ozk_cover_ar":
        return [("AR", "fire"), ("OV", "valves")]
    if kind in ("ozk_cover", "ozk_presence"):
        return [("OV", "valves")]
    if kind == "count:mgn":
        return [("GP", "site:mgn")]
    if kind.startswith("count:") or kind.startswith("spec:"):
        k = kind.split(":")[1]
        return [(disc, f"sym:{k}")] + (
            [(disc, f"spec:{k}")] if kind.startswith("spec:") else []
        )
    return []


def truth_for(
    case: dict,
    reg: dict,
    pd: sc.Scene,
    rd: sc.Scene,
    st_rd: dict,
    focus: dict,
    rd_tags: dict | None,
) -> list[dict]:
    """Истина по каждой паре реестра; расхождение правила с декларацией эффектов мутации — отказ."""
    m, v, mod = case["mutation"], case["variant"], case["modifier"]
    decl = declared(reg, m, v)
    impl = set(reg.get("implemented") or [])
    out = []
    for p in reg["params"]:
        key = pair_key(p)
        status, a, b = computed_status(p, pd, rd, st_rd)
        want = decl.get(key, "NEGATIVE_VERIFIED")
        if status != want:
            raise AssertionError(
                f"{case['case_id']} {label(m, v)} {key}: правило даёт {status}, реестр объявляет {want} "
                f"(ПД {a!r}, РД {b!r})"
            )
        target = key in decl
        requires = list(p.get("requires") or [])
        if status == "CANDIDATE":
            pol, exp = "pos", ["CANDIDATE"]
        elif status == "NEGATIVE_VERIFIED":
            pol, exp = "neg", ["NEGATIVE_VERIFIED"]
        elif status == "NEG:NOT_COMPARABLE":
            pol, exp = "neg", ["NOT_COMPARABLE"]
        else:
            pol, exp = "other", list(reg["expect"][status.split(":", 1)[1]])
        if mod and target and status == "CANDIDATE":
            spec = reg["modifiers"][mod]
            pol, exp = "other", list(spec["expect"])
            requires += spec["requires"]
        ev = []
        if rd_tags is not None:
            for disc, tag in focus.get(p["kind"]) or default_focus(
                p["kind"], p["disc"]
            ):
                bb = rd_tags.get(disc, {}).get(tag)
                if bb:
                    ev.append(
                        {
                            "stage": "RD",
                            "file_id": f"{case['case_id']}-RD-{disc}",
                            "page": 1,
                            "tag": tag,
                            "bbox": bb,
                        }
                    )
        out.append(
            {
                "case_id": case["case_id"],
                "code": p["code"],
                "operator": p["operator"],
                "pair": key,
                "kind": p["kind"],
                "target": target,
                "mutation": m,
                "variant": v,
                "modifier": mod,
                "wired": p["wired"],
                "requires": requires,
                "pending": (not p["wired"]) or any(r not in impl for r in requires),
                "tags": list(case["tags"]),
                "pd_value": a,
                "rd_value": b,
                "evidence": ev,
                "polarity": pol,
                "expected": exp,
            }
        )
    return out


def balance(truth: list[dict], reg: dict) -> dict:
    """Положительные и отрицательные группы по оператору W2 (без «ожидает оператора» и групп вне P/R)."""
    c: dict[str, Counter] = {op: Counter() for op in reg["operators"]}
    for t in truth:
        if t["pending"] or t["polarity"] == "other" or t["operator"] not in c:
            continue
        c[t["operator"]][t["polarity"]] += 1
    return {op: {"pos": x["pos"], "neg": x["neg"]} for op, x in c.items()}


def short(reg: dict, bal: dict) -> list[str]:
    need = reg["min_per_operator"]
    return [
        f"{op}: pos {b['pos']} < {need['pos']}"
        for op, b in bal.items()
        if b["pos"] < need["pos"]
    ] + [
        f"{op}: neg {b['neg']} < {need['neg']}"
        for op, b in bal.items()
        if b["neg"] < need["neg"]
    ]


# ─────────────────────────────────────────────── пример


def make_case(reg: dict, seed: int, i: int, m: str, v: str, mod: str | None):
    """Пример i полного плана: сцена и стиль ПД, копия в РД с мутацией. → (case, pd, rd, st_pd, st_rd, focus)."""
    rng = random.Random(f"w2h:{seed}:{i}")
    small = rng.random() < 0.35
    pd = sc.make_scene(rng, small)
    st_pd = make_style(rng, small)
    rd, st_rd = sc.clone(pd), dict(st_pd)
    st_rd["shift"] = list(st_pd["shift"])
    focus = apply(rng, m, v, pd, rd, st_rd)
    cid = f"W2H-{seed}-{i:04d}"
    tags = []
    stamp_pd = {"stage": "П", "revision": "0", "date": "02.03.26", "changes": []}
    stamp_rd = {"stage": "Р", "revision": "0", "date": "15.07.26", "changes": []}
    if m == "NEG-01":
        stamp_rd = dict(stamp_pd)
        tags.append("self")
    if m == "NEG-02":
        stamp_rd = {
            **stamp_rd,
            "revision": "1",
            "date": "21.09.26",
            "changes": [["1", "-", "1", "12-26", "", "21.09.26"]],
        }
    if mod == "MUT-17":
        first = next(iter(focus.values()), [])
        rd.cloud = [list(x) for x in first]
        stamp_rd = {
            **stamp_rd,
            "revision": "1",
            "changes": [["1", "Зам.", "1", "17-26", "", "20.09.26"]],
        }
        tags.append("cloud")
    case = {
        "case_id": cid,
        "index": i,
        "mutation": m,
        "variant": v,
        "modifier": mod,
        "tags": tags,
        "label": label(m, v) + (f"+{mod}" if mod else ""),
        "small": small,
        "style_pd": st_pd,
        "style_rd": st_rd,
        "stamps": {"PD": stamp_pd, "RD": stamp_rd},
    }
    return case, pd, rd, st_pd, st_rd, focus


def _doc(case: dict, stage: str) -> dict:
    return {"code": f"W2H-{case['index']:04d}", "stamp": case["stamps"][stage]}


# словарь symbols[].kind контракта ADR-0010 (уточнение тимлида, feat/w2-plan 2551236)
SYMBOL_KIND = {"ip": "smoke_detector", "op": "sounder", "pk": "fire_hydrant_valve", "ozk": "fire_damper"}


def frame_truth(pen, f: dict) -> dict:
    """Истинная регистрация листа: мм видимой страницы (от левого верхнего угла) → мм здания, матрица в порядке PDF
    (x' = a·x + c·y + e, y' = b·x + d·y + f). Считается по трём точкам здания через тот же перенос, что рисовал."""
    from eval.w2_holdout.render import Frag

    fr = Frag("main", f["n"], f["theta"], tuple(f["pivot"]), tuple(f["center_mm"]))
    wv, hv = (pen.h, pen.w) if pen.rotate == 90 else (pen.w, pen.h)

    def vis(p):
        u, v = pen.norm(*fr.m(p))
        return (u * wv, v * hv)

    s0, s1, s2 = vis((0.0, 0.0)), vis((1000.0, 0.0)), vis((0.0, 1000.0))
    # bld = M·(s − s0), M = 1000 · S⁻¹, S = [s1 − s0 | s2 − s0]
    p, q = (s1[0] - s0[0], s1[1] - s0[1]), (s2[0] - s0[0], s2[1] - s0[1])
    det = p[0] * q[1] - q[0] * p[1]
    a, c = 1000 * q[1] / det, -1000 * q[0] / det
    b, d = -1000 * p[1] / det, 1000 * p[0] / det
    e, f_ = -(a * s0[0] + c * s0[1]), -(b * s0[0] + d * s0[1])
    return {"to_bld": [round(x, 9) for x in (a, b, c, d, e, f_)], "residual_mm": 0.0, "anchors": None}


def geometry(disc: str, s: sc.Scene, st: dict, pen, meta: dict) -> dict:
    """Истина листа по сущностям контракта PlanGeometry (ADR-0010): мм здания (ГП — мм участка), рамки — доли
    видимой страницы. Меры в мм, площади в м²."""
    bb = pen.bbox
    no_scale = disc == "AR" and st.get("no_scale")
    n = st["n_site"] if disc == "GP" else st["n_main"]
    out = {
        "page": 1,
        "rotate": st.get("rotate", 0),
        "sheet": {k: meta[k] for k in ("format", "w", "h")},
        "frags": meta["frags"],
        "frame": frame_truth(pen, meta["frags"]["site" if disc == "GP" else "main"]),
        "quality": {"status": "NOT_COMPARABLE", "why": "NO_SCALE"}
        if no_scale
        else {"status": "OK", "why": None},
        "scale": {
            "n": None if no_scale else n,
            "method": None if no_scale else "both",
            "spread_pct": 0.0,
            "n_dims": sum(
                1
                for d in pen.dims
                if not d["key"].startswith("wc") and not d["key"].startswith("cab")
            ),
        },
        "axes": [],
        "dims": [],
        "levels": [],
        "walls": [],
        "openings": [],
        "stairs": [],
        "routes": [],
        "symbols": [],
        "rooms": [],
        "site": [],
        "spec": [],
    }
    for d in pen.dims:
        meas = math.dist(d["p0"], d["p1"])
        val = float(d["text"].replace(",", ".")) * (1000 if disc == "GP" else 1)
        out["dims"].append(
            {
                "key": d["key"],
                "value_mm": val,
                "measured_mm": round(meas, 3),
                "p0": d["p0"],
                "p1": d["p1"],
                "conditional": False,
                "as_curves": d["shx"],
                "frag": "frag" if d["key"] in ("cabw", "cabd", "wcclear") else "main",
                "bbox": bb(d["tag"][0] if isinstance(d["tag"], list) else d["tag"]),
            }
        )
    if disc == "GP":
        for it in sc.site_items(s):
            out["site"].append(
                {
                    "kind": it["kind"],
                    "key": it["key"],
                    "polygon": it["polygon"],
                    "width_mm": it.get("width_mm"),
                    "area_m2": it["area_m2"],
                    "count": None,
                    "bbox": bb(f"site:{it['key']}"),
                }
            )
        out["site"].append(
            {
                "kind": "parking_mgn",
                "key": "mgn",
                "polygon": None,
                "width_mm": 3600.0,
                "area_m2": None,
                "count": s.site["n_mgn"],
                "bbox": bb("site:mgn"),
            }
        )
        return out
    for mark, x in zip(s.x_marks, s.xs, strict=True):
        out["axes"].append(
            {"mark": mark, "p0": [x, 0.0], "p1": [x, s.yV], "bbox": bb(f"axis:{mark}")}
        )
    for mark, y in s.y_axes.items():
        out["axes"].append(
            {"mark": mark, "p0": [0.0, y], "p1": [s.X, y], "bbox": bb(f"axis:{mark}")}
        )
    for w in sc.walls(s):
        out["walls"].append(
            {
                "id": w.id,
                "a": list(w.a),
                "b": list(w.b),
                "thickness_mm": w.t,
                "fire": w.fire,
                "hatch": "cross"
                if w.fire and disc == "AR"
                else ("single" if w.fire else None),
                "bbox": bb(f"wall:{w.id}"),
            }
        )
    if disc == "AR":
        walls = sc.wall_by_id(s)
        for d in s.doors.values():
            w = walls[d.wall]
            if w.horizontal:
                yf = w.a[1] + d.side * w.t / 2
                hinge = [d.c + d.hinge * d.clear / 2, yf]
                tip = [hinge[0], yf + d.side * d.leaf]
            else:
                xf = w.a[0] + d.side * w.t / 2
                hinge = [xf, d.c + d.hinge * d.clear / 2]
                tip = [xf + d.side * d.leaf, hinge[1]]
            out["openings"].append(
                {
                    "id": d.id,
                    "mark": d.mark,
                    "kind": "door",
                    "width_mm": d.leaf,
                    "clear_mm": d.clear,
                    "opening_mm": d.opening,
                    "swing": "left" if d.hinge < 0 else "right",
                    "wall": d.wall,
                    "at": door_point(s, d.id),
                    "hinge": hinge,
                    "tip": tip,
                    "bbox": bb(f"door:{d.id}"),
                    "bbox_frag": bb(f"door:{d.id}@f"),
                }
            )
        for r in sc.rooms(s):
            x0, y0, x1, y1 = r["rect"]
            out["rooms"].append(
                {
                    "number": r["number"],
                    "name": r["name"],
                    "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                    "area_m2": r["area_m2"],
                    "bbox": bb(f"room:{r['number']}"),
                }
            )
    if disc == "OV":
        g = sc.vent_graph(s)
        out["routes"].append(
            {
                "system": "П",
                "section": "500×300",
                "points": [list(p) for p in sc.trunk(s)],
                "nodes": g["nodes"],
                "edges": g["edges"],
                "bbox": bb("vent"),
            }
        )
        for v in s.valves:
            out["symbols"].append(
                {
                    "kind": SYMBOL_KIND["ozk"],
                    "mark": v["mark"],
                    "at": list(v["at"]),
                    "bbox": bb(f"valve:{v['id']}"),
                }
            )
        for u in s.units:
            r = sc.unit_rect(s, u["slot"])
            out["symbols"].append(
                {
                    "kind": "other",  # установка — узел трассы (routes), в словаре знаков её нет
                    "mark": u["mark"],
                    "at": [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2],
                    "bbox": bb(f"unit:{u['mark']}"),
                }
            )
        out["crossings"] = sc.crossings(s)
        out["spec"] = [{"kind": SYMBOL_KIND["ozk"], "count": sc.spec_counts(s)["ozk"]}] + [
            {"kind": "unit", "mark": u["mark"], "count": 1} for u in s.units
        ]
    if disc == "PB":
        for kind, pts in (("ip", s.detectors), ("op", s.sounders), ("pk", s.hydrants)):
            for i, q in enumerate(pts):
                out["symbols"].append(
                    {
                        "kind": SYMBOL_KIND[kind],
                        "mark": None,
                        "at": list(q),
                        "bbox": bb(f"sym:{kind}:{i}"),
                    }
                )
        sp = sc.spec_counts(s)
        out["spec"] = [{"kind": SYMBOL_KIND[k], "count": sp[k]} for k in ("ip", "op", "pk")]
    return out


# ─────────────────────────────────────────────── набор


def select(
    items: list, only: list[str] | None, per: int | None
) -> list[tuple[int, tuple]]:
    """Подмножество полного плана с сохранением номеров примеров: only — «MUT-09/door», «MUT-09», «NEG-01»,
    «MUT-13+MUT-17»; per — не больше N примеров на каждый ключ."""
    out, seen = [], Counter()
    for i, (m, v, mod) in enumerate(items):
        keys = {mod, f"{m}+{mod}", f"{label(m, v)}+{mod}"} if mod else {m, label(m, v)}
        hit = [k for k in only if k in keys] if only else ["*"]
        if not hit:
            continue
        k = hit[0]
        if per is not None and seen[k] >= per:
            continue
        seen[k] += 1
        out.append((i, (m, v, mod)))
    return out


def build(
    out: Path | None,
    seed: int,
    scale: float = 1.0,
    only: list[str] | None = None,
    per: int | None = None,
    reg: dict | None = None,
    render: bool = True,
) -> dict:
    """Набор: по каталогу на пример (8 PDF, manifest.json, истина листов *.geom.json), общий dataset.json.
    render=False — только истина по правилам, без PDF и рамок (проверка баланса и деклараций)."""
    if seed < SEED_MIN:
        raise ValueError(
            f"seed отложенного набора — от {SEED_MIN}: 0–9999 отданы генератору разработки T-192 "
            "(ADR-0010 п. 6)"
        )
    reg = reg or load_registry()
    if render:
        from eval.w2_holdout.pages import PAGES  # reportlab — только когда рисуем

    items = plan(reg, scale)
    chosen = select(items, only, per)
    cases, truth = [], []
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
    for i, (m, v, mod) in chosen:
        case, pd, rd, st_pd, st_rd, focus = make_case(reg, seed, i, m, v, mod)
        rd_tags = None
        if render:
            rd_tags = {}
            cdir = out / case["case_id"] if out is not None else None
            if cdir is not None:
                cdir.mkdir(exist_ok=True)
            files = []
            for stage, s, st in (("PD", pd, st_pd), ("RD", rd, st_rd)):
                doc = _doc(case, stage)
                for disc in DISCS:
                    fid = f"{case['case_id']}-{stage}-{disc}"
                    name = f"{stage}-{disc}.pdf"
                    path = cdir / name if cdir is not None else None
                    pen, meta = PAGES[disc](path, s, st, doc)
                    if stage == "RD":
                        rd_tags[disc] = {k: pen.bbox(k) for k in pen.tags}
                    geom = geometry(disc, s, st, pen, meta)
                    rec = {
                        "file_id": fid,
                        "file_name": name,
                        "doc_stage": stage,
                        "discipline": DISC_RU[disc],
                        "document_code": f"{doc['code']}-{DISC_RU[disc]}",
                        "revision": case["stamps"][stage]["revision"],
                        "approval_status": STATUS[stage],
                        "approval_date": case["stamps"][stage]["date"],
                        "predecessor_id": f"{case['case_id']}-PD-{disc}"
                        if stage == "RD"
                        else None,
                    }
                    if cdir is not None:
                        rec["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                        (cdir / f"{stage}-{disc}.geom.json").write_text(
                            json.dumps(geom, ensure_ascii=False), "utf-8"
                        )
                    files.append(rec)
                    del pen, geom
            case["files"] = files
            if cdir is not None:
                (cdir / "manifest.json").write_text(
                    json.dumps({"files": files}, ensure_ascii=False, indent=1), "utf-8"
                )
        truth += truth_for(case, reg, pd, rd, st_rd, focus, rd_tags)
        cases.append(case)
    bal = balance(truth, reg)
    full = scale >= 1.0 and only is None and per is None
    if full and short(reg, bal):
        raise ValueError(
            "недобор примеров на оператор W2: " + "; ".join(short(reg, bal))
        )
    ds = {
        "schema": SCHEMA,
        "dataset_version": f"w2-holdout:seed={seed}:scale={scale}:n={len(cases)}",
        "seed": seed,
        "scale": scale,
        "registry_sha256": registry_sha(reg),
        "cases": cases,
        "truth": truth,
        "balance": bal,
    }
    if out is not None:
        (out / "dataset.json").write_text(json.dumps(ds, ensure_ascii=False), "utf-8")
    return ds


def main(argv: list[str] | None = None) -> None:  # pragma: no cover — CLI
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=SEED_MIN)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--per", type=int, default=None)
    ap.add_argument(
        "--truth-only", action="store_true", help="только истина и баланс, без PDF"
    )
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    ds = build(a.out, a.seed, a.scale, a.only, a.per, render=not a.truth_only)
    print(
        json.dumps(
            {
                "cases": len(ds["cases"]),
                "truth": len(ds["truth"]),
                "balance": ds["balance"],
                "out": str(a.out),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":  # pragma: no cover
    main()
