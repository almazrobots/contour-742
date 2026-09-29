"""Замер T-178: QA-02 Exact Match полей штампа (шифр, стадия, редакция, лист) и точность читателя таблиц ТЭП и
экспликаций на синтетике с gold.json (synth/l1l2_dev.py — DEV, synth/l1l2_holdout.py — HOLDOUT).

    python -m eval.l1l2_bench DIR [--json out.json]

Штамп: текстовый слой PDF (pdfium) → identity.read_identity. Шифр сравнивается по ключу похожих знаков (titleblock.code_key —
латиница-двойник не ошибка чтения), строго — отдельной строкой; редакция — наибольший «Изм.» (None = нет строк);
лист — строка как напечатана. ДИ — Уилсон 95 % по листам.
Таблица: PDF → table_reader.read_pdf_tables; строка эталона совпала, если у одной строки чтения то же
наименование (fold, без пробелов), та же единица, те же значения по колонкам по порядку и тот же признак итога.
Recall — доля строк эталона, Precision — доля прочитанных строк, совпавших с эталоном. ДИ — бутстрап по таблицам.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from eval.ci import bootstrap_ci, wilson
from inspector_ml.identity import read_identity
from inspector_ml.normalize import fold
import pypdfium2 as pdfium

from inspector_ml.model import Page
from inspector_ml.parse import PDFIUM_LOCK, _text_lines
from inspector_ml.table_reader import TableRead, read_pdf_tables
from inspector_ml.titleblock import code_key

FIELDS = ("code", "stage", "revision", "sheet")


def text_page(path: Path, number: int = 1) -> Page:
    """Страница из текстового слоя PDF (векторная ветка L1). parse_pdf отправил бы в OCR лист, где кроме штампа
    почти нет текста (порог MIN_TEXT_CHARS), — а замер L1 идёт по текстовому слою, без артефактов OCR."""
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(path))
        try:
            pg = doc[number - 1]
            w, h = pg.get_size()
            page = Page(page=number, width=w, height=h, rotation=pg.get_rotation(), source="text", lines=_text_lines(pg))
            pg.close()
        finally:
            doc.close()
    return page


def _sheet(s) -> str | None:
    return None if s is None else str(s).strip() or None


def stamp_hits(gold: dict, pred) -> dict[str, bool]:
    g_code = gold.get("code")
    return {
        "code": pred.code is not None
        and g_code is not None
        and code_key(pred.code) == code_key(g_code),
        "code_strict": pred.code == g_code,
        "stage": pred.stage == gold.get("stage"),
        "revision": pred.revision == gold.get("revision"),
        "sheet": _sheet(pred.sheet) == _sheet(gold.get("sheet")),
    }


def name_key(s: str) -> str:
    return fold(s).replace(" ", "")


def _eq(a, b) -> bool:
    if a is None or b is None:
        return a is b
    return abs(float(a) - float(b)) <= 1e-6 * max(1.0, abs(float(b)))


def row_parts(g: dict, p) -> dict[str, bool]:
    pv = [v.num for v in p.values]
    gv = g.get("values") or []
    return {
        "name": name_key(p.name) == name_key(g["name"]),
        "unit": p.unit == g.get("unit"),
        "values": len(pv) == len(gv) and all(_eq(a, b) for a, b in zip(pv, gv)),
        "total": p.total == bool(g.get("total")),
    }


def match_table(gold: dict, read: TableRead | None) -> Counter:
    """Счётчики одной таблицы: gold, pred, hit (строка целиком) и по частям для совпавших по наименованию строк."""
    c: Counter = Counter()
    rows = list(read.rows) if read else []
    c["gold"] += len(gold["rows"])
    c["pred"] += len(rows)
    c["tables"] += 1
    c["kind_ok"] += bool(read and read.kind == gold.get("kind"))
    used: set[int] = set()
    for g in gold["rows"]:
        cand = [
            i
            for i, p in enumerate(rows)
            if i not in used and name_key(p.name) == name_key(g["name"])
        ]
        full = [i for i in cand if all(row_parts(g, rows[i]).values())]
        if full:
            used.add(full[0])
            c["hit"] += 1
            for k in ("name", "unit", "values", "total"):
                c[f"part_{k}"] += 1
            continue
        if cand:
            parts = row_parts(g, rows[cand[0]])
            used.add(cand[0])
            for k, ok in parts.items():
                c[f"part_{k}"] += ok
    return c


def best_read(reads: list[TableRead], gold: dict) -> TableRead | None:
    if not reads:
        return None
    return max(reads, key=lambda r: (match_table(gold, r)["hit"], len(r.rows)))


def _ratio(c: Counter, k: str, n: str) -> float:
    return c[k] / c[n] if c[n] else float("nan")


def run(root: Path) -> dict:
    gold = json.loads((root / "gold.json").read_text(encoding="utf-8"))
    st: Counter = Counter()
    misses: list[dict] = []
    for g in gold.get("stamps", []):
        page = text_page(root / g["file"], g.get("page", 1))
        pred = read_identity(page)
        hits = stamp_hits(g, pred)
        st["n"] += 1
        st["read"] += pred.ok
        for k, ok in hits.items():
            st[k] += ok
        st["all"] += all(hits[k] for k in FIELDS)
        if not all(hits[k] for k in FIELDS) and len(misses) < 40:
            misses.append(
                {
                    "file": g["file"],
                    "form": g.get("form"),
                    "want": {k: g.get(k) for k in FIELDS},
                    "got": {k: getattr(pred, k) for k in FIELDS},
                    "reason": pred.reason,
                }
            )
    per_table: dict[str, Counter] = {}
    tmiss: list[dict] = []
    for g in gold.get("tables", []):
        read = best_read(read_pdf_tables(root / g["file"], [g.get("page", 1)]), g)
        c = match_table(g, read)
        per_table[g["file"]] = c
        if c["hit"] < c["gold"] and len(tmiss) < 40:
            tmiss.append(
                {
                    "file": g["file"],
                    "kind": g["kind"],
                    "hit": c["hit"],
                    "gold": c["gold"],
                    "pred": c["pred"],
                    "names": [r.name for r in read.rows][:12] if read else None,
                    "want": [r["name"] for r in g["rows"]][:12],
                    "cols": [c.title + ":" + c.role for c in read.columns] if read else None,
                    "vals": [([v.num for v in r.values], r.unit, r.total) for r in read.rows][:6] if read else None,
                    "want_vals": [(r["values"], r.get("unit"), r.get("total")) for r in g["rows"]][:6],
                }
            )
    tot: Counter = sum(per_table.values(), Counter())
    out = {
        "generator": gold.get("generator"),
        "seed": gold.get("seed"),
        "stamps": {"n": st["n"], "read": st["read"]},
    }
    for k in (*FIELDS, "code_strict", "all"):
        out["stamps"][k] = {
            "k": st[k],
            "em": _ratio(st, k, "n"),
            "ci95": wilson(st[k], st["n"]),
        }
    out["tables"] = {
        "n": len(per_table),
        "gold_rows": tot["gold"],
        "pred_rows": tot["pred"],
        "hit": tot["hit"],
        "recall": _ratio(tot, "hit", "gold"),
        "recall_ci95": bootstrap_ci(per_table, lambda c: _ratio(c, "hit", "gold")),
        "precision": _ratio(tot, "hit", "pred"),
        "precision_ci95": bootstrap_ci(per_table, lambda c: _ratio(c, "hit", "pred")),
        "kind_acc": _ratio(tot, "kind_ok", "tables"),
        "parts": {
            k: _ratio(tot, f"part_{k}", "gold")
            for k in ("name", "unit", "values", "total")
        },
    }
    out["stamp_misses"] = misses
    out["table_misses"] = tmiss
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=Path)
    ap.add_argument("--json", type=Path)
    ap.add_argument(
        "--misses",
        action="store_true",
        help="печатать промахи (только DEV: на HOLDOUT не смотреть)",
    )
    a = ap.parse_args(argv)
    res = run(a.root)
    if a.json:
        a.json.write_text(
            json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    short = {k: v for k, v in res.items() if k not in ("stamp_misses", "table_misses")}
    print(json.dumps(short, ensure_ascii=False, indent=1))
    if a.misses:
        print(
            json.dumps(
                {
                    "stamp_misses": res["stamp_misses"],
                    "table_misses": res["table_misses"],
                },
                ensure_ascii=False,
                indent=1,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
