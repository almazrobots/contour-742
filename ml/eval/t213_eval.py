"""Виды T-213 для прогона W3 (eval/w3_eval.py → EXTRACTORS): извлечение по паспорту со словарями из value (как
passport.ts: extractorSpec) и поля упоминания, которые читают оценщики domain/stage-schedule.ts и doc-requirements.ts."""

from __future__ import annotations

import json
from pathlib import Path

from inspector_ml.doc_requirements import extract_doc_requirements
from inspector_ml.model import ParamSpec
from inspector_ml.schedule_rows import extract_schedule_rows

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "data/seed/matrix.json").exists())


def _full(spec: ParamSpec) -> ParamSpec:
    """Спецификация со словарями паспорта: технологии (график) и документы ИД (перечень) едут вместе с экстрактором."""
    v = json.loads((ROOT / f"data/seed/passports/{spec.code}.json").read_text("utf-8"))["value"]
    add = {"technologies": [{k: t[k] for k in ("id", "pattern", "sentence") if k in t} for t in v.get("technologies", [])]} if v["kind"] == "schedule" else {"docs": [{"id": d["id"], "pattern": d["pattern"]} for d in v.get("docs", [])]}
    return spec.model_copy(update={"extractor": {**(spec.extractor or {}), **add}})


def schedule_extract(doc, spec: ParamSpec):
    return extract_schedule_rows(doc, _full(spec))


def docreq_extract(doc, spec: ParamSpec):
    return extract_doc_requirements(doc, _full(spec))


def schedule_fields(e) -> dict:
    m = e.meta or {}
    keys = ("table", "order", "start", "end", "calendar", "critical", "total", "tech", "group", "seq")
    return {"name": e.value_text or "", "days": e.value_num, **{k: m.get(k) for k in keys}}


def docreq_fields(e) -> dict:
    m = dict(e.meta or {})
    m.pop("quote", None)
    m.pop("ops", None)
    return {**m, "label": e.value_text or m.get("profile") or ""}
