"""Оценка T-173 на наборах фраз: извлечение (страница → значение) и сравнение (пара «ПД → РД» → статус).

Наборы — `eval/t173_phrases/dev.py` (на нём настраиваются паспорта) и `holdout.py` (отложенный, написан отдельно, без
знания экстрактора). Извлечение — настоящий `extract_quantity_mentions` с паспортом параметра; сравнение — настоящий
`evaluateQuantityParam` API через мост `apps/api/scripts/quantity-eval.ts` (одним вызовом на весь набор).

    uv run python -m eval.t173_eval --set holdout --seed 7 --n 60 --out ../var/t173/holdout.json [--md ../var/t173/holdout.md]

Метрики сравнения: предсказание «нарушение» — CANDIDATE. P, R, F1, FPR и доля воздержаний (MISSING_EVIDENCE,
NOT_COMPARABLE, CLARIFICATION_REQUIRED) — с интервалом Уилсона 95 %. Воздержание на положительной паре — промах Recall,
на отрицательной — не ложное срабатывание. Метрики извлечения: верно / неверное значение / не найдено / лишнее.
Только синтетика (ADR-0002).
"""

from __future__ import annotations

import argparse
import importlib
import json
import subprocess
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.quantity_mentions import extract_quantity_mentions

from .ci import wilson

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
ABSTAIN = {"MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"}


def passport(code: str) -> dict:
    return json.loads((ROOT / f"data/seed/passports/{code}.json").read_text("utf-8"))


def spec(code: str) -> ParamSpec:
    """Паспорт как есть, кроме `column`: наборы фраз моделируют текстовый слой, а не геометрию листа — колонка шапки
    (OS-INSP-2.2.25) на выдуманных рамках срабатывала бы случайно."""
    pp = passport(code)
    ex = {k: v for k, v in pp["extractor"].items() if k != "column"}
    return ParamSpec(code=code, anchors=[pp["title"]], data_type="number", extractor=ex)


def mk_doc(lines: list[str]) -> ParsedDoc:
    """Страница текстового слоя из строк: слова слева направо, строки сверху вниз (как mk_page тестов)."""
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        y = min(0.05 + 0.02 * li, 0.97)
        for t in text.split(" "):
            if not t:
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


def mentions(code: str, lines: list[str]) -> list:
    return extract_quantity_mentions(mk_doc(lines), spec(code))


def _same(a: float | None, b: float | None) -> bool:
    return a is not None and b is not None and abs(a - b) <= 1e-6 * max(1.0, abs(b))


def _first(ms: list, aspect: str | None, limit: bool = False, variant: str | None = None):
    """Значение страницы: первое годное упоминание; у показателя с вариантами — сначала того же варианта, что истина
    (сравнение API идёт внутри варианта, OS-INSP-3.1.42)."""
    ok = [e for e in ms if e.meta.get("excluded") is None and bool(e.meta.get("limit")) == limit and (e.meta.get("aspect") or None) == aspect]
    same = [e for e in ok if variant is not None and e.meta.get("variant") == variant]
    return (same or ok or [None])[0]


# ------------------------------------------------------------------ извлечение


def score_samples(items: list[dict]) -> dict:
    by: dict[str, Counter] = defaultdict(Counter)
    errors: list[dict] = []
    for s in items:
        key = s["param"] + (f"/{s['aspect']}" if s.get("aspect") else "")
        ms = mentions(s["param"], s["lines"])
        e = _first(ms, s.get("aspect"), variant=s.get("variant"))
        pred = e.value_num if e else None
        truth = s["truth"]
        if truth is None:
            out = "fp" if pred is not None else "tn"
        elif pred is None:
            out = "fn"
        else:
            out = "tp" if _same(pred, truth) else "wrong"
        by[key][out] += 1
        if s.get("variant") is not None and e is not None and out == "tp":
            by[key][
                "variant_ok"
                if (e.meta.get("variant") or None) == s["variant"]
                else "variant_bad"
            ] += 1
        if s.get("limit") is not None or (s["param"] in ("M-019", "M-020")):
            le = _first(ms, None, limit=True)
            lp = le.value_num if le else None
            by[key][
                "limit_"
                + (
                    "ok"
                    if (lp is None and s.get("limit") is None)
                    or _same(lp, s.get("limit"))
                    else "bad"
                )
            ] += 1
        if out in ("fp", "fn", "wrong"):
            errors.append(
                {
                    "id": s["id"],
                    "param": key,
                    "cls": s.get("cls"),
                    "error": out,
                    "truth": truth,
                    "pred": pred,
                    "lines": [x for x in s["lines"] if any(ch.isdigit() for ch in x)][
                        :6
                    ],
                }
            )
    return {"by_param": {k: dict(v) for k, v in sorted(by.items())}, "errors": errors}


def extraction_metrics(c: Counter | dict) -> dict:
    c = Counter(c)
    tp, wrong, fn, fp = c["tp"], c["wrong"], c["fn"], c["fp"]
    pos = tp + wrong + fn
    said = tp + wrong + fp
    return {
        "n": pos + c["tn"] + fp,
        "precision": tp / said if said else None,
        "recall": tp / pos if pos else None,
        "abstain": fn / pos if pos else None,
    }


# ------------------------------------------------------------------ сравнение


def _mention_json(code: str, stage: str, e, i: int) -> dict:
    pp = passport(code)
    disc = pp["sources"][stage][0]["discipline"]
    disc = disc if disc != "*" else ("ПЗ" if stage == "PD" else "АР")
    m = e.meta
    return {
        "stage": stage,
        "file_id": f"{stage}-{i}",
        "sha256": "0" * 64,
        "document_code": f"{'П' if stage == 'PD' else 'Р'}-100-{disc}",
        "revision": "1",
        "approval_status": "APPROVED" if stage == "PD" else "FOR_CONSTRUCTION",
        "role": "CURRENT",
        "discipline": disc,
        "base": "100",
        "num": e.value_num,
        "excluded": m.get("excluded"),
        "excluded_why": m.get("excluded_why"),
        "page": e.page,
        "bbox": list(e.bbox) if e.bbox else None,
        "quote": m.get("quote") or "",
        "confidence": e.confidence,
        "source": "pdf-text",
        "unit": m.get("unit", None),
        "variant": m.get("variant"),
        "limit": bool(m.get("limit")),
        "aspect": m.get("aspect"),
    }


def run_pairs(items: list[dict]) -> dict[str, dict]:
    rows = []
    for p in items:
        ms = [
            _mention_json(p["param"], "PD", e, i)
            for i, e in enumerate(mentions(p["param"], p["pd_lines"]))
        ]
        ms += [
            _mention_json(p["param"], "RD", e, i)
            for i, e in enumerate(mentions(p["param"], p["rd_lines"]))
        ]
        rows.append({"id": p["id"], "code": p["param"], "mentions": ms})
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.jsonl", Path(tmp) / "out.jsonl"
        src.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", "utf-8"
        )
        subprocess.run(
            ["npx", "tsx", "scripts/quantity-eval.ts", str(src), str(dst)],
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
        by[p["param"]][out] += 1
        by["ALL"][out] += 1
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
                    "pd": p.get("pd_truth"),
                    "rd": p.get("rd_truth"),
                }
            )
    return {
        "counts": {k: dict(v) for k, v in by.items()},
        "metrics": {k: pair_metrics(v) for k, v in sorted(by.items())},
        "errors": errors,
    }


def error_classes(
    errs: list[dict], keys: tuple[str, ...]
) -> list[tuple[str, int, dict]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for e in errs:
        groups[" · ".join(str(e.get(k)) for k in keys)].append(e)
    return sorted(((k, len(v), v[0]) for k, v in groups.items()), key=lambda x: -x[1])


def _f(x: float | None) -> str:
    return "—" if x is None else f"{x:.2f}".replace(".", ",")


def _ci(x: list | None) -> str:
    return "" if not x else f" [{_f(x[0])}; {_f(x[1])}]"


def to_md(name: str, rep: dict) -> str:
    out = [
        f"## Набор {name}",
        "",
        "### Сравнение пар «ПД → РД»",
        "",
        "| Параметр | n+ | n− | P | R | F1 | FPR | Воздержания |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for k, m in rep["pairs"]["metrics"].items():
        out.append(
            f"| {k} | {m['n_pos']} | {m['n_neg']} | {_f(m['precision'])}{_ci(m['precision_ci'])} | {_f(m['recall'])}{_ci(m['recall_ci'])} | {_f(m['f1'])} | {_f(m['fpr'])}{_ci(m['fpr_ci'])} | {_f(m['abstain'])}{_ci(m['abstain_ci'])} |"
        )
    out += [
        "",
        "### Извлечение (страница → значение)",
        "",
        "| Параметр | n | P | R | воздержания | счётчики |",
        "|---|---|---|---|---|---|",
    ]
    for k, c in rep["samples"]["by_param"].items():
        m = extraction_metrics(c)
        out.append(
            f"| {k} | {m['n']} | {_f(m['precision'])} | {_f(m['recall'])} | {_f(m['abstain'])} | {json.dumps(c, ensure_ascii=False)} |"
        )
    out += ["", "### Топ классов ошибок сравнения", ""]
    for k, n, ex in error_classes(
        rep["pairs"]["errors"], ("param", "label", "status", "mutation")
    )[:12]:
        out.append(f"- **{k}** — {n}; пример `{ex['id']}`: {ex['reason'][:220]}")
    out += ["", "### Топ классов ошибок извлечения", ""]
    for k, n, ex in error_classes(rep["samples"]["errors"], ("param", "cls", "error"))[
        :12
    ]:
        out.append(
            f"- **{k}** — {n}; пример `{ex['id']}`: истина {ex['truth']}, система {ex['pred']}; строки: {' ⏎ '.join(ex['lines'])[:220]}"
        )
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=["dev", "holdout"], required=True)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--out", required=True)
    ap.add_argument("--md")
    a = ap.parse_args()
    mod = importlib.import_module(f"eval.t173_phrases.{a.set}")
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


if __name__ == "__main__":
    main()
