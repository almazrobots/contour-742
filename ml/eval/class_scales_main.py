"""Путь main для набора CMP-04 (T-172, правило включения паспорта координатора): что извлёк бы main без паспортов W1.

Для каждого документа пары — общий лексический `extract()` по всей Матрице, как её отдаёт API main: паспорта есть у
параметров, у которых они были до W1 (М-001…М-005, М-023), у 12 параметров T-172 паспорта нет. Значение стадии —
первое извлечение параметра со значением (как `t175_eval --path main`). Результат дописывается в документ полем
`main: {value_text, value_num, raw, page, bbox} | null`; сравнение — `apps/api/scripts/class-scales-eval.ts --path main`
(лексический `evaluate` из compare.ts с параметром из базы main).

    cd ml && .venv/bin/python -m eval.class_scales_main ../var/class-scales/adv-holdout2.jsonl ../var/class-scales/adv-holdout2-main.jsonl
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from inspector_ml.extract import extract
from inspector_ml.model import ParamSpec

from .class_scales_bench import ROOT, W1, mk_doc

MAIN_PASSPORTS = {"M-001", "M-002", "M-003", "M-004", "M-005", "M-023"}  # паспорта, которые были в main до W1


def main_specs() -> list[ParamSpec]:
    out = []
    for p in json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8")):
        if not p.get("is_active", True):
            continue
        ext = None
        f = ROOT / f"data/seed/passports/{p['code']}.json"
        if p["code"] in MAIN_PASSPORTS and f.exists():
            pp = json.loads(f.read_text("utf-8"))
            val = pp.get("value") or {}
            ext = {**pp["extractor"], "scale": val.get("scale"), "constraint_markers": val.get("constraint_markers")}
        out.append(
            ParamSpec(
                code=p["code"], anchors=p.get("anchors") or [p["parameter_name"]], data_type=p["data_type"],
                regex_pattern=p.get("regex_pattern"), compare_kind=(p.get("compare") or {}).get("kind"),
                unit=p.get("unit") or None, extractor=ext,
            )
        )
    return out


def first_value(code: str, lines: list[str], specs: list[ParamSpec], seed: int) -> dict | None:
    for e in extract(mk_doc(lines, seed), specs):
        if e.code == code and (e.value_num is not None or e.value_text):
            return {"value_text": e.value_text, "value_num": e.value_num, "raw": e.raw, "page": e.page, "bbox": list(e.bbox) if e.bbox else None}
    return None


def run(src: Path, dst: Path) -> int:
    specs = main_specs()
    assert not ({s.code for s in specs if s.extractor} & set(W1)), "у параметров W1 в main паспортов нет"
    n = 0
    with src.open(encoding="utf-8") as fi, dst.open("w", encoding="utf-8") as fo:
        for line in fi:
            c = json.loads(line)
            for i, d in enumerate(c["docs"]):
                d["main"] = first_value(c["param"], d["lines"], specs, n * 10 + i)
            fo.write(json.dumps(c, ensure_ascii=False) + "\n")
            n += 1
    print(f"путь main: {n} пар → {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
