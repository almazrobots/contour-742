"""Оценка извлечения T-175 на наборах фраз: М-007 этажность, М-010 количество квартир (quantity_mentions + правило
целого из API), М-011 квартирография (composition_mentions). Наборы — `eval/t175_phrases/dev.py` (на нём настраиваются
паспорта) и `holdout.py` (отложенный, написан отдельно, без знания паспортов и экстракторов).

    .venv/bin/python -m eval.t175_eval --set holdout --seed 7 --n 60 [--out ../var/t175/holdout.json]
    .venv/bin/python -m eval.t175_eval --set holdout2 --seed 11 --path main   # лексический путь main без паспортов

--path main — как main до T-175: у М-007/М-010/М-011 паспорта нет, значение даёт общий лексический извлекатель
(`extract`, якоря Матрицы) по всем параметрам Матрицы сразу (соперники якорей как в проде), стадия берёт первое
извлечение со значением (score в inspections.ts равный внутри одного файла). Семантический доизвлекатель (эмбеддер)
не участвует — только лексический путь.

Исход страницы: верно (значение или состав совпали), неверно (извлечено другое), пропуск (истина есть — ничего не
извлечено), лишнее (истины нет — извлечено). P = верно / (верно + неверно + лишнее), R = верно / (верно + неверно +
пропуск), интервал Уилсона 95 %. Только синтетика (ADR-0002).
"""

from __future__ import annotations

import argparse
import importlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from inspector_ml.composition_mentions import extract_composition_mentions
from inspector_ml.count_mentions import extract_count_mentions
from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

from .ci import wilson

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)


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
            ws.append(Word(text=t, bbox=(round(x, 5), y, round(min(x + w, 1.0), 5), y + 0.015)))
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=" ".join(w.text for w in ws), words=ws))
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=[Page(page=1, width=595, height=842, source="text", lines=out)])


def spec(code: str) -> ParamSpec:
    d = ROOT / "data/seed/passports"
    f = d / f"{code}.json" if (d / f"{code}.json").exists() else d / "draft" / f"{code}.json"  # М-010 — черновик
    pp = json.loads(f.read_text("utf-8"))
    return ParamSpec(
        code=code, anchors=[pp["title"]], data_type="number", extractor=pp["extractor"]
    )


T175 = ("M-007", "M-010", "M-011")


def main_specs() -> list[ParamSpec]:
    """Параметры, как их отдаёт API main: вся Матрица; паспорта — у всех, кроме трёх параметров T-175."""
    matrix = json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
    out = []
    for p in matrix:
        if not p.get("is_active", True):
            continue
        ext = None
        f = ROOT / f"data/seed/passports/{p['code']}.json"
        if p["code"] not in T175 and f.exists():
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


def predict_main(code: str, lines: list[str], specs: list[ParamSpec]):
    """Путь main: первое извлечение параметра со значением. Число — если целое; иначе то, что извлечено (неверно)."""
    for e in extract(mk_doc(lines), specs):
        if e.code != code or (e.value_num is None and not e.value_text):
            continue
        if e.value_num is not None:
            return int(e.value_num) if float(e.value_num).is_integer() else e.value_num
        return e.value_text
    return None


def predict(code: str, lines: list[str]):
    """Что увидел бы API: для счёта — первое неотсеянное целое (OS-INSP-2.2.60), для состава — первое по типу."""
    doc = mk_doc(lines)
    if code == "M-011":
        # как API (stageComposition): первое упоминание подтипа, разные подтипы типа складываются
        comp: dict[str, int] = {}
        seen: set[tuple[str, str]] = set()
        for e in extract_composition_mentions(doc, spec(code)):
            k = (e.value_text, e.meta.get("sub", ""))
            if not e.meta["excluded"] and e.value_num is not None and k not in seen:
                seen.add(k)
                comp[e.value_text] = comp.get(e.value_text, 0) + int(e.value_num)
        return comp or None
    # как API (count-param.ts): разные целые в стадии — двойной подсчёт, вывод воздерживается (CLARIFICATION_REQUIRED)
    vals = {
        int(e.value_num)
        for e in extract_count_mentions(doc, spec(code))
        if not e.meta["excluded"] and e.value_num is not None and float(e.value_num).is_integer() and e.value_num >= 0
    }
    return vals.pop() if len(vals) == 1 else None


def outcome(truth, pred) -> str:
    # состав: тип с нулём и отсутствующий тип — одно и то же (HOLDOUT пишет все пять типов, отсутствующие — нулём)
    if isinstance(truth, dict):
        truth = {k: v for k, v in truth.items() if v} or None
    if truth is None:
        return "tn" if pred is None else "spurious"
    if pred is None:
        return "missed"
    return "correct" if truth == pred else "wrong"


def evaluate(samples: list[dict], path: str = "branch") -> dict:
    by = defaultdict(Counter)
    traps = defaultdict(Counter)
    errors = []
    specs = main_specs() if path == "main" else None
    for s in samples:
        truth = s["composition"] if s["code"] == "M-011" else s["value"]
        pred = predict_main(s["code"], s["lines"], specs) if specs else predict(s["code"], s["lines"])
        o = outcome(truth, pred)
        by[s["code"]][o] += 1
        traps[f"{s['code']}:{s.get('trap') or 'обычная'}"][o] += 1
        if o in ("wrong", "missed", "spurious") and len(errors) < 400:
            errors.append(
                {
                    "code": s["code"],
                    "trap": s.get("trap", ""),
                    "outcome": o,
                    "truth": truth,
                    "pred": pred,
                    "lines": [
                        ln for ln in s["lines"] if any(ch.isdigit() for ch in ln)
                    ][:4],
                }
            )
    table = {}
    for code, c in sorted(by.items()):
        tp, bad_p, bad_r = (
            c["correct"],
            c["correct"] + c["wrong"] + c["spurious"],
            c["correct"] + c["wrong"] + c["missed"],
        )
        table[code] = {
            **dict(c),
            "precision": round(tp / bad_p, 3) if bad_p else None,
            "precision_ci": [round(x, 3) for x in wilson(tp, bad_p)],
            "recall": round(tp / bad_r, 3) if bad_r else None,
            "recall_ci": [round(x, 3) for x in wilson(tp, bad_r)],
        }
    return {
        "params": table,
        "traps": {k: dict(v) for k, v in sorted(traps.items())},
        "errors": errors,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=["dev", "holdout", "holdout2", "holdout3"], default="dev")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--path", choices=["branch", "main"], default="branch")
    ap.add_argument("--out")
    a = ap.parse_args()
    mod = importlib.import_module(f"eval.t175_phrases.{a.set}")
    res = {"set": a.set, "seed": a.seed, "n": a.n, "path": a.path, **evaluate(mod.samples(a.seed, a.n), a.path)}
    text = json.dumps(res, ensure_ascii=False, indent=1)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text, "utf-8")
    for code, r in res["params"].items():
        print(
            f"{code}: P={r['precision']} {r['precision_ci']} R={r['recall']} {r['recall_ci']} · {dict((k, v) for k, v in r.items() if k in ('correct', 'wrong', 'missed', 'spurious', 'tn'))}"
        )


if __name__ == "__main__":
    main()
