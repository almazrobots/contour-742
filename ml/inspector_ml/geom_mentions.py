"""Упоминания параметра по геометрии плана — извлекатель вида `geometry_mentions` (T-192, ADR-0010, OS-INSP-2.2.110–2.2.124).

Паспорт параметра задаёт `extractor: {kind: "geometry_mentions", entity, measure, filters}`; модуль берёт PlanGeometry
страниц (`plan_geom`, кэш `geom-{sha}-p{page}-g{GEOM_REV}`) и выдаёт по каждому измерению отдельное упоминание
`Extraction` с `meta.geom` строго по контракту GeomMention ADR-0010. Как у упоминаний класса и количества,
параметр идёт своим путём: в лексический путь и в перечитывание не попадает.

Какие листы: только PDF и только страницы, похожие на чертёж — есть масштаб в штампе или не меньше
MIN_DIM_WORDS чисел размеров; фильтр паспорта `sheet` (регулярное выражение по тексту листа) сужает выбор.
Лист с отказом геометрии (NOT_COMPARABLE: нет векторного слоя, нет масштаба, разброс масштаба, дольше 30 с) даёт
одно упоминание-отказ без значения — API видит, что лист не измерен, и не берёт значение ниоткуда.

Сочетания entity × measure (остальные — ошибка паспорта, громкий отказ):
  ENT-01 помещение    area (м², подпись площади — второй источник), length (ширина — короткая сторона), shape
  ENT-03 оси          length (шаг между соседними осями), position (координата оси в системе здания), count
  ENT-04 размер       length (число размера; измерение — второй источник)
  ENT-05 отметка      length (м)
  ENT-08 знак         count (по виду из легенды), position
  ENT-09 трасса       length (диаметр / ширина сечения, мм), area (площадь сечения, м²), topology (граф), count
  ENT-10 проём        length (ширина проёма; filters.field = "clear" — в свету), count
  ENT-11 стена        length (толщина), count
  ENT-12 лестница     count (ступени), length (filters.field: tread | riser | shaft_w | shaft_d)
  ENT-21 генплан      area, length (ширина проезда), count (машино-места), shape, position
"""

from __future__ import annotations

import logging
import math
import re
from pathlib import Path

from .measure import stamp_scales
from .model import Extraction, ParamSpec, ParsedDoc
from .plan_geom import (
    DIM_RE,
    FRAME_TOL_MM,
    GEOM_REV,
    _axis_order,
    _line_dist,
    apply_affine,
    plan_geometry,
)

log = logging.getLogger(__name__)

KIND = "geometry_mentions"  # ADR-0010 (уточнение T-190): соглашение <вид>_mentions
MIN_DIM_WORDS = 5  # чисел размеров на странице без штампа масштаба — не меньше
MAX_GEOM_PAGES = 60  # листов на документ (правило №0: том ИД — не повод разбирать геометрию сотен страниц)
CONF_OK, CONF_SHEET, CONF_COND = (
    0.9,
    0.75,
    0.5,
)  # в осях здания; только в мм листа; размер «не в масштабе»
AXIS_TOL = 0.5  # стена на оси: осевая линия стены не дальше 0,5 мм листа от оси
OPS = {"ENT-01": ["ENT-01", "NRM-09"], "ENT-03": ["ENT-03", "NRM-09"], "ENT-04": ["ENT-04", "PRM-08", "ENT-06"],
       "ENT-05": ["ENT-05"], "ENT-08": ["ENT-08", "ENT-18"], "ENT-09": ["ENT-09", "ENT-07"], "ENT-10": ["ENT-10", "ENT-11"],
       "ENT-11": ["ENT-11", "NRM-09"], "ENT-12": ["ENT-12"], "ENT-21": ["ENT-21", "ENT-18"]}  # fmt: skip
MEASURES = {
    "ENT-01": {"area", "length", "shape"},
    "ENT-03": {"length", "position", "count"},
    "ENT-04": {"length"},
    "ENT-05": {"length"},
    "ENT-08": {"count", "position"},
    "ENT-09": {"length", "area", "topology", "count"},
    "ENT-10": {"length", "count"},
    "ENT-11": {"length", "count"},
    "ENT-12": {"count", "length"},
    "ENT-21": {"area", "length", "count", "shape", "position"},
}
_NUM = re.compile(r"\d+(?:[.,]\d+)?")


class GeomSpecError(ValueError):
    """Паспорт параметра просит сочетание сущности и измерения, которого экстрактор не умеет."""


def is_geom_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def check_spec(spec: ParamSpec) -> tuple[str, str, dict]:
    ex = spec.extractor or {}
    entity, measure = ex.get("entity"), ex.get("measure")
    if entity not in MEASURES or measure not in MEASURES[entity]:
        raise GeomSpecError(f"{spec.code}: geometry_mentions не умеет {entity} × {measure}")
    return entity, measure, dict(ex.get("filters") or {})


# ─────────────────────────────────────────────── листы и кэш


def geom_key(sha: str, page: int) -> str:
    return f"geom-{sha}-p{page}-g{GEOM_REV}"


def candidate_pages(doc: ParsedDoc, sheet: str | None = None) -> list[int]:
    """Страницы-чертежи: масштаб в штампе или не меньше MIN_DIM_WORDS чисел размеров; sheet — фильтр по тексту листа."""
    if doc.kind != "pdf":
        return []
    rx = re.compile(sheet, re.IGNORECASE) if sheet else None
    out = []
    for p in doc.pages:
        words = [w.text for ln in p.lines for w in ln.words]
        if not (
            stamp_scales(p.lines)
            or sum(bool(DIM_RE.match(w)) for w in words) >= MIN_DIM_WORDS
        ):
            continue
        if rx and not rx.search(" ".join(ln.text for ln in p.lines)):
            continue
        out.append(p.page)
    if len(out) > MAX_GEOM_PAGES:
        log.warning(
            "геометрия: %d листов-чертежей, разбираются первые %d",
            len(out),
            MAX_GEOM_PAGES,
        )
    return out[:MAX_GEOM_PAGES]


def page_geometry(path: Path, doc: ParsedDoc, number: int, cache=None) -> dict:
    """PlanGeometry страницы из кэша или свежая. TIMEOUT не кэшируется: он зависит от нагрузки, а не от файла."""
    import json

    key = geom_key(doc.sha256, number)
    if cache is not None:
        hit = cache.get(key)
        if hit is not None:
            return json.loads(hit)
    page = next(p for p in doc.pages if p.page == number)
    geo = plan_geometry(path, number, page)
    if cache is not None and geo["quality"]["why"] != "TIMEOUT":
        cache.set(key, json.dumps(geo, ensure_ascii=False))
    return geo


# ─────────────────────────────────────────────── измерения листа (чистые функции над PlanGeometry)


def _frame(geo: dict):
    fr = geo["frame"]
    if (
        fr["to_bld"] is not None
        and fr["residual_mm"] is not None
        and fr["residual_mm"] <= FRAME_TOL_MM
    ):
        m = fr["to_bld"]
        return "bld", lambda p: [round(float(v), 1) for v in apply_affine(m, [p])[0]]
    return "sheet", lambda p: [round(float(p[0]), 3), round(float(p[1]), 3)]


def _center(pts) -> tuple[float, float]:
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def _union(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def _section(sec: str) -> tuple[float | None, float | None]:
    """Сечение «ø250», «400×400», «ø32×2,5» → (характерный размер, мм; площадь, м²)."""
    nums = [float(x.replace(",", ".")) for x in _NUM.findall(sec)]
    if not nums:
        return None, None
    if sec.startswith("ø"):
        d = nums[0]
        return d, round(math.pi * d * d / 4 / 1e6, 6)
    if len(nums) >= 2:
        return nums[0], round(nums[0] * nums[1] / 1e6, 6)
    return nums[0], None


def _axis_of(geo: dict, a, b) -> str | None:
    """Марка оси, на которой лежит отрезок a–b (стена по оси) — ключ сопоставления LNK-06."""
    for ax in geo["axes"]:
        if (
            _line_dist(tuple(a), tuple(ax["p0"]), tuple(ax["p1"])) <= AXIS_TOL
            and _line_dist(tuple(b), tuple(ax["p0"]), tuple(ax["p1"])) <= AXIS_TOL
        ):
            return ax["mark"]
    return None


def _dim_axes(geo: dict, d: dict) -> str | None:
    ends = []
    for p in (d["p0"], d["p1"]):
        hit = [
            ax["mark"]
            for ax in geo["axes"]
            if _line_dist(tuple(p), tuple(ax["p0"]), tuple(ax["p1"])) <= AXIS_TOL
        ]
        if len(hit) != 1:
            return None
        ends.append(hit[0])
    if ends[0] == ends[1]:
        return None
    a, b = sorted(ends, key=_axis_order)  # ключ не зависит от направления размерной линии: «А-Б», а не «Б-А»
    return f"{a}-{b}"


def _match(value, want) -> bool:
    if want is None:
        return True
    if isinstance(want, bool) or isinstance(value, bool):
        return bool(value) == bool(want)
    if isinstance(want, (list, tuple, set)):
        return value in want
    return (
        value is not None
        and re.fullmatch(str(want), str(value), re.IGNORECASE) is not None
    )


def _gm(entity, measure, value, unit, by, key, geo, frame, *, label=None, measured=None, at=None, polygon=None, graph=None,
        bbox=None, quote="") -> dict:  # fmt: skip
    return {"entity": entity, "measure": measure, "value": None if value is None else float(f"{float(value):.6g}"), "unit": unit,
            "by": by, "label_value": label, "measured_value": measured, "key": key, "at": at, "polygon": polygon,
            "graph": graph, "frame": frame, "scale_n": geo["scale"]["n"], "scale_spread_pct": geo["scale"]["spread_pct"],
            "residual_mm": geo["frame"]["residual_mm"], "page": geo["page"], "bbox": bbox, "quote": quote}  # fmt: skip


def page_mentions(
    geo: dict, entity: str, measure: str, filters: dict | None = None
) -> list[dict]:
    """GeomMention листа по сущности и измерению. Лист NOT_COMPARABLE — одно упоминание-отказ без значения."""
    filters = filters or {}
    q = geo["quality"]
    if q["status"] != "OK":
        return [_gm(entity, measure, None, _unit(entity, measure), "geometry", "", geo, "sheet",
                    quote=f"лист {geo['page']}: геометрия не измерена ({q['why']})")]  # fmt: skip
    frame, f = _frame(geo)
    return _BY_ENTITY[entity](geo, measure, filters, frame, f)


def _unit(entity: str, measure: str) -> str:
    if measure in ("count", "topology"):
        return "шт"
    if measure in ("area", "shape"):
        return "м²"
    return "м" if entity == "ENT-05" else "мм"


def _axes(geo, measure, flt, frame, f):
    fam = {"num": [], "let": []}
    for ax in geo["axes"]:
        fam["num" if ax["mark"].isdigit() else "let"].append(ax)
    want = flt.get("family")
    out = []
    if measure == "count":
        axes = [a for k, lst in fam.items() if _match(k, want) for a in lst]
        return [_gm("ENT-03", "count", len(axes), "шт", "geometry", "axes", geo, frame, bbox=_union(a["bbox"] for a in axes),
                    quote=f"оси: {', '.join(a['mark'] for a in axes)}")]  # fmt: skip
    for k, lst in fam.items():
        if not _match(k, want):
            continue
        if measure == "position":
            for a in lst:
                at = f(_center([a["p0"], a["p1"]]))
                coord = at[0 if k == "num" else 1] if frame == "bld" else None
                out.append(_gm("ENT-03", "position", coord, "мм", "geometry", a["mark"], geo, frame, at=at, bbox=a["bbox"],
                               quote=f"ось {a['mark']}"))  # fmt: skip
            continue
        for a, b in zip(lst, lst[1:]):
            key = f"{a['mark']}-{b['mark']}"
            mid = _center([b["p0"], b["p1"]])
            measured = round(
                _line_dist(mid, tuple(a["p0"]), tuple(a["p1"])) * geo["scale"]["n"], 1
            )
            dim = next(
                (
                    d
                    for d in geo["dims"]
                    if _dim_axes(geo, d) in (key, f"{b['mark']}-{a['mark']}")
                ),
                None,
            )
            label = dim["value_mm"] if dim else None
            value = label if label is not None and not dim["conditional"] else measured
            out.append(_gm("ENT-03", "length", value, "мм", "both" if dim else "geometry", key, geo, frame, label=label,
                           measured=measured, at=f(_center([a["p0"], a["p1"], b["p0"], b["p1"]])),
                           bbox=_union([a["bbox"], b["bbox"]]), quote=f"шаг осей {a['mark']}–{b['mark']}: {value:g} мм"))  # fmt: skip
    return out


def _dims(geo, measure, flt, frame, f):
    out = []
    for i, d in enumerate(geo["dims"]):
        if not _match(d["conditional"], flt.get("conditional")):
            continue
        key = _dim_axes(geo, d) or f"dim:{i}"
        out.append(_gm("ENT-04", "length", d["value_mm"], "мм", "both", key, geo, frame, label=d["value_mm"],
                       measured=d["measured_mm"], at=f(_center([d["p0"], d["p1"]])), bbox=d["bbox"],
                       quote=f"размер {d['value_mm']:g} мм (по геометрии {d['measured_mm']:g} мм)"
                       + (" — не в масштабе" if d["conditional"] else "")))  # fmt: skip
    return out


def _levels(geo, measure, flt, frame, f):
    return [_gm("ENT-05", "length", v["value_m"], "м", "dimension", v["kind"], geo, frame, label=v["value_m"], bbox=v["bbox"],
                quote=f"отметка {v['value_m']:+.3f}") for v in geo["levels"]
            if _match(v["kind"], flt.get("kind")) and _match(v["absolute"], flt.get("absolute"))]  # fmt: skip


def _symbols(geo, measure, flt, frame, f):
    sel = [s for s in geo["symbols"] if _match(s["kind"], flt.get("kind"))]
    if measure == "count":
        return [_gm("ENT-08", "count", len(sel), "шт", "geometry", flt.get("kind") or "symbols", geo, frame,
                    bbox=_union(s["bbox"] for s in sel), quote=f"знаков по легенде: {len(sel)}")]  # fmt: skip
    return [_gm("ENT-08", "position", None, "мм", "geometry", s["mark"] or s["kind"], geo, frame, at=f(s["at"]), bbox=s["bbox"],
                quote=f"знак {s['kind']}") for s in sel]  # fmt: skip


def _routes(geo, measure, flt, frame, f):
    sel = [
        r
        for r in geo["routes"]
        if _match(r["system"], flt.get("system"))
        and _match(r["section"], flt.get("section"))
    ]
    if measure == "count":
        return [_gm("ENT-09", "count", len(sel), "шт", "geometry", flt.get("system") or "routes", geo, frame,
                    bbox=_union(r["bbox"] for r in sel), quote=f"трасс: {len(sel)}")]  # fmt: skip
    out = []
    for r in sel:
        size, area = _section(r["section"])
        quote = f"{r['system']} {r['section']}"
        if measure == "topology":
            graph = {
                "nodes": [{**nd, "at": f(nd["at"])} for nd in r["nodes"]],
                "edges": r["edges"],
            }
            out.append(_gm("ENT-09", "topology", len(r["edges"]), "шт", "geometry", r["system"], geo, frame, graph=graph,
                           bbox=r["bbox"], quote=quote))  # fmt: skip
        else:
            v = size if measure == "length" else area
            out.append(_gm("ENT-09", measure, v, _unit("ENT-09", measure), "dimension", r["system"], geo, frame, label=v,
                           at=f(r["points"][0]), bbox=r["bbox"], quote=quote))  # fmt: skip
    return out


def _openings(geo, measure, flt, frame, f):
    sel = [
        (i, o)
        for i, o in enumerate(geo["openings"])
        if _match(o["kind"], flt.get("kind")) and _match(o["mark"], flt.get("mark"))
    ]
    if measure == "count":
        return [_gm("ENT-10", "count", len(sel), "шт", "geometry", flt.get("kind") or "openings", geo, frame,
                    bbox=_union(o["bbox"] for _, o in sel), quote=f"проёмов: {len(sel)}")]  # fmt: skip
    clear = flt.get("field") == "clear"
    out = []
    for i, o in sel:
        v = o["clear_mm"] if clear else o["width_mm"]
        label = None if clear else o.get("label_mm")
        out.append(_gm("ENT-10", "length", v, "мм", "both" if label is not None else "geometry", o["mark"] or f"{o['kind']}:{i}",
                       geo, frame, label=label, measured=v, bbox=o["bbox"],
                       quote=f"{o['mark'] or o['kind']}: {'в свету ' if clear else ''}{v:g} мм"))  # fmt: skip
    return out


def _walls(geo, measure, flt, frame, f):
    sel = [
        (i, w) for i, w in enumerate(geo["walls"]) if _match(w["fire"], flt.get("fire"))
    ]
    if measure == "count":
        return [_gm("ENT-11", "count", len(sel), "шт", "geometry", "walls", geo, frame, bbox=_union(w["bbox"] for _, w in sel),
                    quote=f"стен: {len(sel)}")]  # fmt: skip
    out = []
    for i, w in sel:
        axis = _axis_of(geo, w["a"], w["b"])
        out.append(_gm("ENT-11", "length", w["thickness_mm"], "мм", "geometry", f"ось {axis}" if axis else f"wall:{i}", geo, frame,
                       measured=w["thickness_mm"], polygon=[f(w["a"]), f(w["b"])], bbox=w["bbox"],
                       quote=f"стена {w['thickness_mm']:g} мм" + (" (противопожарная)" if w["fire"] else "")
                       + (f", ось {axis}" if axis else "")))  # fmt: skip
    return out


_STAIR_FIELD = {"tread": "tread_mm", "riser": "riser_mm"}


def _stairs(geo, measure, flt, frame, f):
    out = []
    for i, s in enumerate(geo["stairs"]):
        if not _match(s["kind"], flt.get("kind")):
            continue
        key = f"{s['kind']}:{i}"
        if measure == "count":
            if s["steps"] is not None:
                out.append(
                    _gm(
                        "ENT-12",
                        "count",
                        s["steps"],
                        "шт",
                        "geometry",
                        key,
                        geo,
                        frame,
                        bbox=s["bbox"],
                        quote=f"ступеней: {s['steps']}",
                    )
                )
            continue
        field = flt.get("field") or ("shaft_w" if s["kind"] == "lift" else "tread")
        if field in _STAIR_FIELD:
            v = s[_STAIR_FIELD[field]]
            by = "dimension" if field == "riser" else "geometry"
        elif s["shaft_mm"] and field in ("shaft_w", "shaft_d"):
            v, by = s["shaft_mm"][0 if field == "shaft_w" else 1], "geometry"
        else:
            continue
        if v is not None:
            out.append(
                _gm(
                    "ENT-12",
                    "length",
                    v,
                    "мм",
                    by,
                    key,
                    geo,
                    frame,
                    bbox=s["bbox"],
                    quote=f"{s['kind']} {field}: {v:g} мм",
                )
            )
    return out


def _rooms(geo, measure, flt, frame, f):
    out = []
    for r in geo["rooms"]:
        if not _match(r["number"], flt.get("number")):
            continue
        poly = [f(p) for p in r["polygon"]]
        if measure == "area" or measure == "shape":
            lab = r.get("area_label_m2")
            out.append(_gm("ENT-01", measure, r["area_m2"], "м²", "both" if lab is not None else "geometry", r["number"], geo, frame,
                           label=lab, measured=r["area_m2"], polygon=poly, bbox=r["bbox"], quote=f"помещение {r['number']}: {r['area_m2']:g} м²"))  # fmt: skip
        else:
            pts = r["polygon"]
            sides = [
                math.dist(pts[k], pts[(k + 1) % len(pts)]) * geo["scale"]["n"]
                for k in range(len(pts))
            ]
            v = round(min(sides), 1)
            out.append(_gm("ENT-01", "length", v, "мм", "geometry", r["number"], geo, frame, measured=v, polygon=poly, bbox=r["bbox"],
                           quote=f"помещение {r['number']}: ширина {v:g} мм"))  # fmt: skip
    return out


def _site(geo, measure, flt, frame, f):
    sel = [s for s in geo["site"] if _match(s["kind"], flt.get("kind"))]
    if measure == "count":
        n = sum(s["count"] or 0 for s in sel)
        return [_gm("ENT-21", "count", n, "шт", "geometry", flt.get("kind") or "site", geo, frame, bbox=_union(s["bbox"] for s in sel),
                    quote=f"{flt.get('kind') or 'объектов'}: {n}")]  # fmt: skip
    out = []
    for i, s in enumerate(sel):
        poly = [f(p) for p in s["polygon"]]
        key = f"{s['kind']}:{i}"
        if measure == "length":
            if s["width_mm"] is None:
                continue
            out.append(_gm("ENT-21", "length", s["width_mm"], "мм", "geometry", key, geo, frame, measured=s["width_mm"], polygon=poly,
                           bbox=s["bbox"], quote=f"{s['kind']}: ширина {s['width_mm']:g} мм"))  # fmt: skip
        elif measure == "position":
            out.append(_gm("ENT-21", "position", None, "мм", "geometry", key, geo, frame, at=f(_center(s["polygon"])), polygon=poly,
                           bbox=s["bbox"], quote=s["kind"]))  # fmt: skip
        else:
            out.append(_gm("ENT-21", measure, s["area_m2"], "м²", "geometry", key, geo, frame, measured=s["area_m2"], polygon=poly,
                           bbox=s["bbox"], quote=f"{s['kind']}: {s['area_m2']:g} м²"))  # fmt: skip
    return out


_BY_ENTITY = {"ENT-01": _rooms, "ENT-03": _axes, "ENT-04": _dims, "ENT-05": _levels, "ENT-08": _symbols, "ENT-09": _routes,
              "ENT-10": _openings, "ENT-11": _walls, "ENT-12": _stairs, "ENT-21": _site}  # fmt: skip


# ─────────────────────────────────────────────── Extraction и вход из extract.py


def to_extraction(spec: ParamSpec, gm: dict, quality: dict) -> Extraction:
    ok = gm["value"] is not None
    conf = (
        0.0
        if not ok
        else CONF_OK
        if gm["frame"] == "bld" or gm["measure"] in ("count", "area")
        else CONF_SHEET
    )
    if (
        gm["entity"] == "ENT-04"
        and gm["label_value"] is not None
        and gm["measured_value"] is not None
    ):
        if abs(gm["measured_value"] - gm["label_value"]) > 0.02 * gm["label_value"]:
            conf = CONF_COND
    return Extraction(
        code=spec.code,
        raw="" if not ok else f"{gm['value']:g}",
        value_num=gm["value"],
        value_text=gm["key"] or None,
        page=gm["page"],
        bbox=tuple(gm["bbox"]) if gm["bbox"] else None,
        line_text=gm["quote"],
        confidence=conf,
        meta={"geom": gm, "quality": quality, "ops": OPS[gm["entity"]]},
    )


def extract_geom_mentions(
    doc: ParsedDoc,
    spec: ParamSpec,
    path: Path | None,
    cache=None,
    memo: dict | None = None,
) -> list[Extraction]:
    """Все упоминания параметра по геометрии листов документа. Без файла (path None) — ничего: геометрия
    берётся только из PDF, текст ParsedDoc её не заменяет."""
    entity, measure, flt = check_spec(spec)
    if path is None:
        return []
    memo = {} if memo is None else memo
    out = []
    for number in candidate_pages(doc, flt.pop("sheet", None)):
        if number not in memo:
            memo[number] = page_geometry(path, doc, number, cache)
        geo = memo[number]
        out += [
            to_extraction(spec, gm, geo["quality"])
            for gm in page_mentions(geo, entity, measure, flt)
        ]
    return out


# ─────────────────────────────────────────────── вход из реестра extractor_kinds.py (doc, spec)

_SOURCE: dict = {"blobs": None, "cache": None, "configured": False}
_MEMO: dict[str, dict] = {}  # геометрия листа на время процесса: несколько параметров — один разбор листа
_MEMO_MAX = 32
_VERIFIED: set[str] = set()


def configure(blobs: Path | None = None, cache=None) -> None:
    """Хранилище блобов и кэш для извлекателя из реестра (тесты, прогоны); по умолчанию — как у сервиса ML:
    INSPECTOR_BLOB_DIR и кэш профиля INSPECTOR_PROFILE."""
    _SOURCE.update(blobs=blobs, cache=cache, configured=True)
    _MEMO.clear()
    _VERIFIED.clear()


def _blobs() -> Path:
    import os

    from .paths import repo_root

    return _SOURCE["blobs"] or Path(os.environ.get("INSPECTOR_BLOB_DIR", repo_root() / "var/blobs")).resolve()


def _cache():
    if not _SOURCE["configured"]:
        import os

        from .cache import make_cache
        from .paths import repo_root

        _SOURCE.update(cache=make_cache(os.environ.get("INSPECTOR_PROFILE", "dev"), repo_root() / "var/ml-cache"), configured=True)
    return _SOURCE["cache"]


def source_pdf(doc: ParsedDoc) -> Path | None:
    """PDF документа в хранилище по SHA-256 (путь снаружи не принимается). Нет файла — None и запись в журнал."""
    from .docstore import BlobMismatch, BlobMissing, blob_path

    if doc.kind != "pdf":
        return None
    blobs = _blobs()
    if doc.sha256 in _VERIFIED:
        return blobs / doc.sha256
    try:
        path = blob_path(blobs, doc.sha256)
    except (BlobMissing, BlobMismatch) as e:
        log.warning("геометрия: файл %s… недоступен (%s) — упоминаний по геометрии нет", doc.sha256[:12], e)
        return None
    _VERIFIED.add(doc.sha256)
    return path


def extract_geometry_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Извлекатель вида geometry_mentions для реестра (doc, spec) -> list[Extraction]."""
    check_spec(spec)
    path = source_pdf(doc)
    if path is None:
        return []
    memo = {n: g for n in range(1, len(doc.pages) + 1) if (g := _MEMO.get(geom_key(doc.sha256, n))) is not None}
    out = extract_geom_mentions(doc, spec, path, _cache(), memo)
    for n, g in memo.items():
        if len(_MEMO) >= _MEMO_MAX:
            _MEMO.pop(next(iter(_MEMO)))
        _MEMO[geom_key(doc.sha256, n)] = g
    return out
