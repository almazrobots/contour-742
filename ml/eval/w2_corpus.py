"""Замер волны W2 на корпусе раннера (T-190, ADR-0010, docs/ops/WAVES.md «Корпус на раннере») — один файл за раз.

Правовой режим (ADR-0002, условия T-165 от 28.09): корпус `/opt/corpus` — только чтение, без копий и жёстких ссылок;
наружу (stdout, git, Telegram) — только агрегаты по коду архива-объекта: счётчики, доли, время. Имя файла, путь,
sha, текст, номер страницы наружу не выходят никогда. Подробный разбор по файлу — только в каталоге `--out`
(на раннере `/opt/w1-gate/eval/w2`, права 700).

Что меряется:
1. применимость W2 — виды страниц PDF (vector / scan / hybrid / empty) по `pagekind.detect_pages`;
2. извлечение геометрии — если в ветке есть `inspector_ml.plan_geom.plan_geometry(path, page)` (T-192): доля листов
   с `quality.status = OK`, причины отказа, способ масштаба, число сущностей по видам, время на лист (предел 30 с).

Использование на раннере (правило №0: сначала 10 файлов, замер, потом остальное):
  scripts/remote-run.sh --light "cd ml && nice -n 19 .venv/bin/python -m eval.w2_corpus --limit 10"
"""

from __future__ import annotations

import argparse
import dataclasses
import gc
import json
import os
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

CORPUS = Path("/opt/corpus")
OUT = Path("/opt/w1-gate/eval/w2")
GEOM_KINDS = (
    "axes",
    "dims",
    "levels",
    "walls",
    "openings",
    "stairs",
    "routes",
    "symbols",
    "rooms",
    "site",
)
MAX_GEOM_PAGES = (
    5  # векторных листов на файл для извлечения геометрии: замер, а не полный разбор
)

GeomFn = Callable[[Path, int], Any]

# OWASP-0188 (ADR-0002): в агрегат попадают только значения перечислений контракта ADR-0010; свободный текст модуля
# геометрии (подпись листа в причине, сообщение исключения) наружу не выходит — вместо него OTHER
GEOM_WHY = {"NO_VECTOR_LAYER", "NO_SCALE", "SCALE_SPREAD", "TIMEOUT"}
SCALE_METHODS = {"stamp", "dimensions", "both"}


def enum_or_other(value: Any, allowed: set[str]) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) and value in allowed else "OTHER"


def object_code(archive: str) -> str:
    """Код объекта для агрегатов — номер архива («10_…» → «10») или обезличенная метка; адрес наружу не выходит."""
    m = re.match(r"^(\d+)_", archive)
    if m:
        return m.group(1)
    if "TRAIN" in archive:
        return "ORG-TRAIN"
    if "TEST" in archive:
        return "ORG-TEST"
    return "OTHER"


def load_catalog(catalog: Path) -> list[dict]:
    """PDF каталога корпуса, от маленьких к большим (первые файлы — дешёвый замер), без повторов по sha."""
    rows: dict[str, dict] = {}
    for f in sorted(catalog.glob("*.jsonl")):
        for line in f.open(encoding="utf-8"):
            d = json.loads(line)
            if d.get("ext", "").lower() != ".pdf" or d["sha256"] in rows:
                continue
            rows[d["sha256"]] = {
                "sha256": d["sha256"],
                "bytes": d["bytes"],
                "object": object_code(d["archive"]),
            }
    return sorted(rows.values(), key=lambda r: (r["bytes"], r["sha256"]))


def as_dict(obj: Any) -> dict:
    if isinstance(obj, dict):
        return obj
    if dataclasses.is_dataclass(obj):
        return dataclasses.asdict(obj)
    for name in ("to_dict", "model_dump"):
        if hasattr(obj, name):
            return getattr(obj, name)()
    raise TypeError(
        f"plan_geometry вернула {type(obj).__name__}: ожидается PlanGeometry по контракту ADR-0010"
    )


def default_geom() -> GeomFn | None:
    try:
        from inspector_ml.plan_geom import (
            plan_geometry,
        )  # T-192; до его влития замер идёт без геометрии
    except ImportError:
        return None
    return plan_geometry


def measure_file(
    path: Path, geom: GeomFn | None, max_geom_pages: int = MAX_GEOM_PAGES
) -> dict:
    """Запись разбора одного файла — только для каталога --out: виды страниц и итоги геометрии по листам."""
    from inspector_ml.pagekind import detect_pages

    rec: dict = {"kinds": {}, "geom": []}
    t0 = time.perf_counter()
    try:
        kinds = detect_pages(path)
    except Exception as e:  # повреждённый PDF — счётчик, а не падение прогона
        rec["error"] = type(e).__name__
        return rec
    rec["kinds"] = dict(Counter(k.kind for k in kinds))
    rec["kind_s"] = round(time.perf_counter() - t0, 3)
    if geom is None:
        return rec
    for k in [k for k in kinds if k.kind in ("vector", "hybrid")][:max_geom_pages]:
        g: dict = {"page": k.page}
        t = time.perf_counter()
        try:
            pg = as_dict(geom(path, k.page))
            q = pg.get("quality") or {}
            g["status"] = q.get("status")
            g["why"] = enum_or_other(q.get("why"), GEOM_WHY)
            g["scale_method"] = enum_or_other(
                (pg.get("scale") or {}).get("method"), SCALE_METHODS
            )
            g["scale_found"] = (pg.get("scale") or {}).get("n") is not None
            g["registered"] = (pg.get("frame") or {}).get("to_bld") is not None
            g["counts"] = {kind: len(pg.get(kind) or []) for kind in GEOM_KINDS}
        except Exception as e:
            g["status"] = "ERROR"
            g["why"] = type(e).__name__
        g["s"] = round(time.perf_counter() - t, 3)
        rec["geom"].append(g)
    return rec


def pct(n: int, d: int) -> float | None:
    return round(100.0 * n / d, 1) if d else None


def aggregate(records: list[dict]) -> dict:
    """Агрегаты по коду объекта и итого: только числа (без путей, sha, страниц, текста)."""
    by: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by[r["object"]].append(r)
        by["ALL"].append(r)
    out: dict = {}
    for obj, rs in sorted(by.items()):
        kinds: Counter = Counter()
        for r in rs:
            kinds.update(r.get("kinds") or {})
        pages = sum(kinds.values())
        geo = [g for r in rs for g in r.get("geom") or []]
        ok = [g for g in geo if g.get("status") == "OK"]
        times = [g["s"] for g in geo if "s" in g]
        counts: Counter = Counter()
        for g in ok:
            counts.update(g.get("counts") or {})
        out[obj] = {
            "files": len(rs),
            "file_errors": dict(Counter(r["error"] for r in rs if r.get("error"))),
            "pages": pages,
            "pages_by_kind": dict(kinds),
            "vector_share_pct": pct(kinds["vector"] + kinds["hybrid"], pages),
            "geom_sheets": len(geo),
            "geom_ok_pct": pct(len(ok), len(geo)),
            "geom_fail_why": dict(
                Counter(str(g.get("why")) for g in geo if g.get("status") != "OK")
            ),
            "scale_found_pct": pct(
                sum(1 for g in geo if g.get("scale_found")), len(geo)
            ),
            "scale_method": dict(Counter(str(g.get("scale_method")) for g in ok)),
            "registered_pct": pct(sum(1 for g in ok if g.get("registered")), len(ok)),
            "entities_per_ok_sheet": {
                k: round(v / len(ok), 1) for k, v in counts.items()
            }
            if ok
            else {},
            "sheet_s_p50": round(statistics.median(times), 2) if times else None,
            "sheet_s_p95": round(sorted(times)[max(0, int(0.95 * len(times)) - 1)], 2)
            if times
            else None,
            "sheet_over_30s": sum(1 for t in times if t > 30),
        }
    return out


def run(
    catalog: Path,
    blobs: Path,
    out: Path,
    limit: int | None,
    objects: set[str] | None,
    geom: GeomFn | None,
) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    detail = out / "detail.jsonl"
    done: dict[str, dict] = {}
    if detail.exists():
        for line in detail.open(encoding="utf-8"):
            r = json.loads(line)
            done[r["sha256"]] = r
    todo = [
        r for r in load_catalog(catalog) if objects is None or r["object"] in objects
    ]
    if limit is not None:
        todo = todo[:limit]
    with detail.open("a", encoding="utf-8") as fh:
        for row in todo:
            if row["sha256"] in done:
                continue
            path = blobs / row["sha256"]
            if not path.is_file():
                rec = {"error": "NoBlob"}
            else:
                rec = measure_file(path, geom)
            rec.update(row)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            done[row["sha256"]] = rec
            gc.collect()  # один файл за раз: память волны 6 ГБ, задача — 3 ГБ, без свопа
    selected = {r["sha256"] for r in todo}
    agg = aggregate([r for s, r in done.items() if s in selected])
    (out / "aggregate.json").write_text(
        json.dumps(agg, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return agg


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--corpus", type=Path, default=CORPUS)
    p.add_argument("--out", type=Path, default=OUT)
    p.add_argument("--limit", type=int, default=None)
    p.add_argument(
        "--objects", default=None, help="коды объектов через запятую: 10,11,ORG-TRAIN"
    )
    p.add_argument("--no-geom", action="store_true", help="только виды страниц")
    a = p.parse_args(argv)
    geom = None if a.no_geom else default_geom()
    objects = set(a.objects.split(",")) if a.objects else None
    agg = run(a.corpus / "catalog", a.corpus / "blobs", a.out, a.limit, objects, geom)
    json.dump(
        {"geom_module": geom is not None, "aggregate": agg},
        sys.stdout,
        ensure_ascii=False,
        indent=1,
    )
    print()


if __name__ == "__main__":
    main()
