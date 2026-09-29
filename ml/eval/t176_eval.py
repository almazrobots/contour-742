"""Оценка T-176 на наборах фраз: извлечение (страница → упоминания) и сравнение (пара «ПД → РД» → статус).

Наборы — `eval/t176_phrases/dev.py` (на нём настраиваются паспорта и написания) и `holdout.py` (отложенный, написан
отдельно, без знания экстракторов). Извлечение — настоящие `extract_category_mentions` / `extract_layer_mentions` с
паспортом или частью паспорта и написаниями справочника; сравнение — настоящие виды category и layers из реестра API
через мост `apps/api/scripts/subst-layers-eval.ts` (одним вызовом на набор).

    python -m eval.t176_eval --set holdout --seed 7 --n 60 --out ../var/t176/holdout.json [--md ../var/t176/holdout.md]

Метрики сравнения: предсказание «нарушение» — CANDIDATE. P, R, F1, FPR и доля воздержаний (MISSING_EVIDENCE,
NOT_COMPARABLE, CLARIFICATION_REQUIRED) — с интервалом Уилсона 95 %. Воздержание на положительной паре — промах Recall,
на отрицательной — не ложное срабатывание. Извлечение: верно / лишнее / пропуск по упоминаниям страницы. Только синтетика.
"""

from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

from inspector_ml.category_mentions import extract_category_mentions
from inspector_ml.layer_mentions import extract_layer_mentions
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

from .ci import wilson

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
ABSTAIN = {"MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"}
PARTS = {
    "M-050": "subst",
    "M-072": "subst",
    "M-079": "subst",
    "M-125": "layers",
    "M-128": "layers",
}
FAMILIES = json.loads((ROOT / "data/seed/analogs.json").read_text("utf-8"))["families"]
TWIN = str.maketrans("АВЕКМНОРСТУХ", "ABEKMHOPCTYX")


def passport(code: str) -> dict:
    part = PARTS.get(code)
    p = ROOT / (
        f"data/seed/passports/parts/{code}.{part}.json"
        if part
        else f"data/seed/passports/{code}.json"
    )
    return json.loads(p.read_text("utf-8"))


def spec(code: str) -> ParamSpec:
    """Спецификация как её собирает API (вид из реестра, spec): extractor паспорта + написания канона семейства."""
    pp = passport(code)
    fam = FAMILIES[pp["value"]["family"]]
    aliases = [
        {"key": k, "patterns": c["aliases"]}
        for k, c in fam["canon"].items()
        if c.get("aliases")
    ]
    return ParamSpec(
        code=code,
        anchors=[pp["title"]],
        data_type="string",
        extractor={**pp["extractor"], "aliases": aliases},
    )


def mk_doc(lines: list[str]) -> ParsedDoc:
    """Страница текстового слоя: слова слева направо (ячейки «|» — с разрывом), строки сверху вниз."""
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        y = min(0.03 + 0.018 * li, 0.97)
        for t in text.split(" "):
            if not t:
                x = min(x + 0.004, 0.99)
                continue
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t, bbox=(round(x, 5), y, round(min(x + w, 1.0), 5), y + 0.015)
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=1, width=595, height=842, source="text", lines=out)],
    )


def extract(code: str, lines: list[str]) -> list:
    sp = spec(code)
    way = (
        extract_layer_mentions
        if sp.extractor["kind"] == "layer_mentions"
        else extract_category_mentions
    )
    return way(mk_doc(lines), sp)


def fold(s: str | None) -> str:
    return re.sub(r"[\s\-‐‑‒–—−.,()/\\«»\"'_]+", "", (s or "").upper().translate(TWIN))


# ------------------------------------------------------------------ извлечение


def _cat_key(code: str, item, value) -> tuple:
    return (fold(item) if item else None, fold(value) if code == "M-079" else value)


def score_samples(items: list[dict]) -> dict:
    by: dict[str, Counter] = defaultdict(Counter)
    errors: list[dict] = []
    for s in items:
        code = s["param"]
        ms = [
            e for e in extract(code, s["lines"]) if not (e.meta or {}).get("excluded")
        ]
        if s["kind"] == "category":
            truth = Counter(_cat_key(code, t["item"], t["value"]) for t in s["truth"])
            pred = Counter(_cat_key(code, e.meta.get("item"), e.value_text) for e in ms)
        else:
            truth = Counter(
                (
                    fold(t["item"]) if t["item"] else None,
                    tuple((x["m"], x["t"]) for x in t["layers"]),
                )
                for t in s["truth"]
            )
            pred = Counter(
                (
                    fold(e.meta.get("item")) if e.meta.get("item") else None,
                    tuple((x["m"], x["t"]) for x in e.meta["layers"]),
                )
                for e in ms
            )
            if (
                len(truth) == 1
                and len(pred) == 1
                and next(iter(truth))[0] is None
                or (len(truth) == 1 and len(pred) == 1 and next(iter(pred))[0] is None)
            ):
                truth = Counter(k[1] for k in truth.elements())
                pred = Counter(k[1] for k in pred.elements())
        tp = sum((truth & pred).values())
        fn = sum((truth - pred).values())
        fp = sum((pred - truth).values())
        by[code].update(tp=tp, fn=fn, fp=fp, pages=1, clean=int(fn == 0 and fp == 0))
        if fn or fp:
            errors.append(
                {
                    "id": s["id"],
                    "param": code,
                    "missed": [str(k) for k in (truth - pred)],
                    "extra": [str(k) for k in (pred - truth)],
                    "lines": s["lines"][2:14],
                }
            )
    return {"by_param": {k: dict(v) for k, v in sorted(by.items())}, "errors": errors}


def extraction_metrics(c: dict) -> dict:
    tp, fn, fp = c.get("tp", 0), c.get("fn", 0), c.get("fp", 0)
    return {
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "pages": c.get("pages", 0),
        "clean_pages": c.get("clean", 0),
    }


# ------------------------------------------------------------------ сравнение


def _rows(code: str, stage: str, es: list, k0: int) -> list[dict]:
    pp = passport(code)
    disc = pp["sources"][stage][0]["discipline"]
    disc = disc if disc != "*" else "АР"
    return [
        {
            "file_id": f"{stage}-{k0}-{i}",
            "sha256": "0" * 64,
            "doc_stage": stage,
            "document_code": f"{'П' if stage == 'PD' else 'Р'}-100-{disc}",
            "revision": "1",
            "approval_status": "APPROVED" if stage == "PD" else "FOR_CONSTRUCTION",
            "revision_role": "CURRENT",
            "discipline": disc,
            "value_num": None,
            "value_text": e.value_text,
            "page": e.page,
            "bbox_json": json.dumps(list(e.bbox)) if e.bbox else None,
            "meta_json": json.dumps(e.meta, ensure_ascii=False),
            "line_text": e.line_text,
            "confidence": e.confidence,
        }
        for i, e in enumerate(es)
    ]


def run_pairs(items: list[dict]) -> dict[str, dict]:
    rows = []
    for k, p in enumerate(items):
        rs = _rows(p["param"], "PD", extract(p["param"], p["pd_lines"]), k) + _rows(
            p["param"], "RD", extract(p["param"], p["rd_lines"]), k
        )
        rows.append(
            {
                "id": p["id"],
                "code": p["param"],
                "part": PARTS.get(p["param"]),
                "rows": rs,
            }
        )
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.jsonl", Path(tmp) / "out.jsonl"
        src.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", "utf-8"
        )
        subprocess.run(
            ["npx", "tsx", "scripts/subst-layers-eval.ts", str(src), str(dst)],
            cwd=ROOT / "apps/api",
            check=True,
        )
        return {
            r["id"]: r
            for r in (json.loads(x) for x in dst.read_text("utf-8").splitlines() if x)
        }


def pair_metrics(c: Counter) -> dict:
    tp, fp, fn, tn, ap, an = (
        c["tp"],
        c["fp"],
        c["fn"],
        c["tn"],
        c["abstain_pos"],
        c["abstain_neg"],
    )
    pos, neg = tp + fn + ap, fp + tn + an
    p = tp / (tp + fp) if tp + fp else None
    r = tp / pos if pos else None
    f1 = (
        2 * p * r / (p + r)
        if p and r
        else (0.0 if p is not None and r is not None else None)
    )
    ci = lambda k, n: [round(x, 3) for x in wilson(k, n)] if n else None  # noqa: E731
    return {
        "n_pos": pos,
        "n_neg": neg,
        "precision": p,
        "precision_ci": ci(tp, tp + fp),
        "recall": r,
        "recall_ci": ci(tp, pos),
        "f1": f1,
        "fpr": fp / neg if neg else None,
        "fpr_ci": ci(fp, neg),
        "abstain": (ap + an) / (pos + neg) if pos + neg else None,
        "abstain_ci": ci(ap + an, pos + neg),
    }


def score_pairs(items: list[dict]) -> dict:
    res = run_pairs(items)
    by: dict[str, Counter] = defaultdict(Counter)
    errors: list[dict] = []
    for p in items:
        st = res[p["id"]]["status"]
        pos = p["label"] == "CANDIDATE"
        out = (
            ("abstain_pos" if pos else "abstain_neg")
            if st in ABSTAIN
            else ("tp" if pos else "fp")
            if st == "CANDIDATE"
            else ("fn" if pos else "tn")
        )
        op = "CMP-21" if p["kind"] == "layers" else "CMP-05"
        for key in (p["param"], op, "ALL"):
            by[key][out] += 1
        by[f"{op}/{p.get('mutation')}"][out] += 1
        if out in ("fp", "fn", "abstain_pos", "abstain_neg"):
            errors.append(
                {
                    "id": p["id"],
                    "param": p["param"],
                    "label": p["label"],
                    "status": st,
                    "mutation": p.get("mutation"),
                    "cls": p.get("cls"),
                    "reason": res[p["id"]].get("reason"),
                    "pd": p["pd_lines"][:14],
                    "rd": p["rd_lines"][:14],
                }
            )
    return {
        "counts": {k: dict(v) for k, v in by.items()},
        "metrics": {k: pair_metrics(v) for k, v in sorted(by.items())},
        "errors": errors,
    }


def _f(x) -> str:
    return "—" if x is None else f"{x:.2f}".replace(".", ",")


def _ci(x) -> str:
    return "" if not x else f" [{_f(x[0])}; {_f(x[1])}]"


def to_md(name: str, rep: dict) -> str:
    out = [
        f"## Набор {name}",
        "",
        "### Сравнение пар «ПД → РД»",
        "",
        "| Срез | n+ | n− | P | R | F1 | FPR | Воздержания |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for k, m in rep["pairs"]["metrics"].items():
        out.append(
            f"| {k} | {m['n_pos']} | {m['n_neg']} | {_f(m['precision'])}{_ci(m['precision_ci'])} | {_f(m['recall'])}{_ci(m['recall_ci'])} | {_f(m['f1'])} | {_f(m['fpr'])}{_ci(m['fpr_ci'])} | {_f(m['abstain'])}{_ci(m['abstain_ci'])} |"
        )
    out += [
        "",
        "### Извлечение (страница → упоминания)",
        "",
        "| Параметр | страниц | чистых | P | R |",
        "|---|---|---|---|---|",
    ]
    for k, c in rep["samples"]["by_param"].items():
        m = extraction_metrics(c)
        out.append(
            f"| {k} | {m['pages']} | {m['clean_pages']} | {_f(m['precision'])} | {_f(m['recall'])} |"
        )
    groups: dict[str, list] = defaultdict(list)
    for e in rep["pairs"]["errors"]:
        groups[f"{e['param']} · {e['label']} · {e['status']} · {e['mutation']}"].append(
            e
        )
    out += ["", "### Классы ошибок сравнения", ""]
    for k, v in sorted(groups.items(), key=lambda x: -len(x[1]))[:15]:
        out.append(
            f"- **{k}** — {len(v)}; пример `{v[0]['id']}`: {(v[0]['reason'] or '')[:200]}"
        )
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=["dev", "holdout"], required=True)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--out", required=True)
    ap.add_argument("--md")
    ap.add_argument(
        "--errors",
        type=int,
        default=0,
        help="вывести N ошибок извлечения и сравнения (только dev)",
    )
    a = ap.parse_args()
    mod = importlib.import_module(f"eval.t176_phrases.{a.set}")
    rep = {
        "set": a.set,
        "seed": a.seed,
        "n": a.n,
        "samples": score_samples(mod.samples(a.seed, a.n)),
        "pairs": score_pairs(mod.pairs(a.seed, a.n)),
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=1), "utf-8")
    md = to_md(a.set.upper(), rep)
    if a.md:
        Path(a.md).write_text(md, "utf-8")
    print(md)
    if a.errors and a.set == "dev":
        for e in rep["samples"]["errors"][: a.errors]:
            print(json.dumps(e, ensure_ascii=False))
        for e in rep["pairs"]["errors"][: a.errors]:
            print(json.dumps(e, ensure_ascii=False))


if __name__ == "__main__":
    main()
