"""Счёт отложенного набора W2 (T-195, каталог TO-BE §15.3; OS-INSP-6.5.67–6.5.69): QA-05, QA-06, QA-07.

Формат отчёта совместим со стендом мутаций T-179 (`eval/mutation_score.py`, схема inspector-mutation-report/1):
те же срезы (all, op:, pair:, mut:, target:) и поля (n_pos, n_neg, tp/fp/fn/tn, precision, recall, f1, fpr,
abstention, status_accuracy — с 95 % ДИ). Файл T-179 не копируется: до его влития здесь минимальная
совместимая реализация, общий код — `eval/ci.py` (Уилсон, бутстрэп по примерам) и `eval/metrics.iou` из main.
После влития T-179 общий счёт можно свести к одному модулю — формат уже общий.

Отличия W2: пара — «параметр × оператор» (у параметра несколько операторов), строка результата ищется по
(case_id, code, operator); срез ctl: — FPR по виду отрицательного контроля и ловушки (NEG-01…03, TRAP-*).

Единица — группа «пример × пара». Нарушение предсказано — статус CANDIDATE. Воздержание — MISSING_EVIDENCE,
NOT_COMPARABLE, CLARIFICATION_REQUIRED или нет строки; на положительной группе воздержание — промах (FN).
Группы вне P/R (polarity other) идут только в точность статуса; «ожидает оператора» — отдельным разделом.

Вход — ответ прогона конвейера (собирает тимлид при интеграции, реальные ML и API):
    {"results": [{"case_id", "rows": [{"code", "operator", "status", "fragments"?}], "files"?, "error"?, "ms"?}]}

    uv run python -m eval.w2_holdout.score --dataset ../var/w2-holdout/dataset.json --results run.json \
        --out ../var/w2-holdout/report.json [--md report.md] [--baseline eval/baselines/w2-holdout.json --profile full]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

ML = Path(__file__).resolve().parents[2]
if str(ML) not in sys.path:  # запуск файлом
    sys.path.insert(0, str(ML))

from eval import ci as ci_mod  # noqa: E402
from eval.metrics import iou  # noqa: E402

REPORT_SCHEMA = "inspector-mutation-report/1"
BASELINE_SCHEMA = "inspector-mutation-baseline/1"
DATASET_SCHEMA = "inspector-w2-holdout/1"
ABSTAIN = ("MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED")
IOU_MIN = 0.5


def outcome(t: dict, status: str | None) -> Counter:
    """Счётчики одной группы: tp/fn/fp/tn, воздержание, совпадение статуса с ожидаемым."""
    c: Counter = Counter()
    st = status or "ABSENT"
    c["n"] += 1
    c["status_ok"] += st in t["expected"]
    if t["polarity"] == "other":
        c["other"] += 1
        return c
    flagged = st == "CANDIDATE"
    if t["polarity"] == "pos":
        c["pos"] += 1
        c["tp" if flagged else "fn"] += 1
    else:
        c["neg"] += 1
        c["fp" if flagged else "tn"] += 1
    c["abst"] += st in ABSTAIN or st == "ABSENT"
    return c


def _ratio(k: float, n: float) -> float | None:
    return k / n if n else None


def _f1(c: Counter) -> float:
    p, r = _ratio(c["tp"], c["tp"] + c["fp"]), _ratio(c["tp"], c["pos"])
    if not p or not r:
        return 0.0 if (c["pos"] or c["fp"]) else float("nan")
    return 2 * p * r / (p + r)


def _wilson(k: int, n: int) -> list[float] | None:
    return [round(x, 4) for x in ci_mod.wilson(k, n)] if n else None


def _rnd(x):
    return (
        None if x is None or (isinstance(x, float) and math.isnan(x)) else round(x, 4)
    )


def summarize(per_case: dict[str, Counter], b: int = 400, seed: int = 20260928) -> dict:
    """Метрики среза: доли — Уилсон 95 %, F1 — бутстрэп по примерам (пример — неделимая единица)."""
    c: Counter = Counter()
    for x in per_case.values():
        c.update(x)
    f1_ci = None
    if c["pos"] and len(per_case) > 1:
        lo, hi = ci_mod.bootstrap_ci(per_case, _f1, b=b, seed=seed)
        if not (math.isnan(lo) or math.isnan(hi)):
            f1_ci = [round(lo, 4), round(hi, 4)]
    return {
        "n": c["n"],
        "n_pos": c["pos"],
        "n_neg": c["neg"],
        "n_other": c["other"],
        "tp": c["tp"],
        "fp": c["fp"],
        "fn": c["fn"],
        "tn": c["tn"],
        "precision": _rnd(_ratio(c["tp"], c["tp"] + c["fp"])),
        "precision_ci": _wilson(c["tp"], c["tp"] + c["fp"]),
        "recall": _rnd(_ratio(c["tp"], c["pos"])),
        "recall_ci": _wilson(c["tp"], c["pos"]),
        "f1": _rnd(_f1(c)),
        "f1_ci": f1_ci,
        "fpr": _rnd(_ratio(c["fp"], c["neg"])),
        "fpr_ci": _wilson(c["fp"], c["neg"]),
        "fpr_superseded": None,
        "n_superseded": 0,
        "fpr_superseded_ci": None,  # устаревших редакций в W2-наборе нет
        "abstention": _rnd(_ratio(c["abst"], c["pos"] + c["neg"])),
        "abstention_ci": _wilson(c["abst"], c["pos"] + c["neg"]),
        "status_accuracy": _rnd(_ratio(c["status_ok"], c["n"])),
        "status_accuracy_ci": _wilson(c["status_ok"], c["n"]),
    }


def index_results(api: dict) -> tuple[dict, dict]:
    """Строки по (case_id, code, operator); строка без operator отвечает за все операторы параметра."""
    rows, cases = {}, {}
    for r in api["results"]:
        cases[r["case_id"]] = r
        for row in r.get("rows") or []:
            rows[(r["case_id"], row["code"], row.get("operator"))] = row
    return rows, cases


def _row(rows: dict, t: dict) -> dict | None:
    return rows.get((t["case_id"], t["code"], t["operator"])) or rows.get(
        (t["case_id"], t["code"], None)
    )


def localized(t: dict, row: dict | None) -> bool:
    """Доказательство там, где мутация: фрагмент РД того же файла и страницы с IoU ≥ 0,5 против истинной рамки."""
    for f in (row or {}).get("fragments") or []:
        if f.get("stage") != "RD" or not f.get("bbox"):
            continue
        for e in t["evidence"]:
            if (
                e["file_id"] == f.get("file_id")
                and e["page"] == f.get("page")
                and iou(e["bbox"], f["bbox"]) >= IOU_MIN
            ):
                return True
    return False


def control_of(t: dict) -> str | None:
    m = t["mutation"]
    return m if m.startswith(("NEG-", "TRAP-")) else None


def score(dataset: dict, api: dict, b: int = 400) -> dict:
    """Отчёт QA-05/QA-06 по набору и ответу прогона."""
    if dataset.get("schema") != DATASET_SCHEMA:
        raise ValueError(
            f"набор со схемой {dataset.get('schema')!r}, ожидалась {DATASET_SCHEMA}"
        )
    if "results" not in api or not isinstance(api["results"], list):
        raise ValueError("ответ прогона без списка results")
    rows, cases = index_results(api)
    known = {c["case_id"] for c in dataset["cases"]}
    alien = sorted(set(cases) - known)
    if alien:
        raise ValueError(f"в ответе прогона примеры не из набора: {alien[:5]}")
    slices: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    pending: dict[str, Counter] = defaultdict(Counter)
    loc: Counter = Counter()
    defects = []
    for t in dataset["truth"]:
        row = _row(rows, t)
        status = row["status"] if row else None
        mut = t["modifier"] or t["mutation"]
        pair = f"{t['code']}×{t['operator']}"
        if t["pending"]:
            key = f"{pair} · {mut}{' · ' + '+'.join(t['requires']) if t['requires'] else ''}"
            pending[key]["n"] += 1
            pending[key][f"наблюдено {status or 'нет проверки'}"] += 1
            pending[key]["ожидается " + " или ".join(t["expected"])] += 0
            continue
        c = outcome(t, status)
        keys = ["all", f"op:{t['operator']}", f"pair:{pair}", f"mut:{mut}"]
        if t["target"]:
            keys.append(f"target:{mut}")
        if control_of(t):
            keys.append(f"ctl:{control_of(t)}")
        for k in keys:
            slices[k][t["case_id"]].update(c)
        if t["polarity"] == "pos" and status == "CANDIDATE":
            loc["tp"] += 1
            loc["hit"] += localized(t, row)
        if (status or "ABSENT") not in t["expected"]:
            defects.append(
                {
                    "case_id": t["case_id"],
                    "code": t["code"],
                    "operator": t["operator"],
                    "mutation": t["mutation"],
                    "variant": t["variant"],
                    "target": t["target"],
                    "expected": t["expected"],
                    "status": status,
                    "pd": t["pd_value"],
                    "rd": t["rd_value"],
                }
            )
    failed = [
        r
        for r in api["results"]
        if r.get("error")
        or any(
            f.get("parse_status") not in (None, "DONE") for f in r.get("files") or []
        )
    ]
    missing = sorted(known - set(cases))
    return {
        "schema": REPORT_SCHEMA,
        "holdout": "w2",
        "dataset_version": dataset["dataset_version"],
        "registry_sha256": dataset.get("registry_sha256"),
        "cases": len(dataset["cases"]),
        "groups": len(dataset["truth"]),
        "missing_cases": missing,
        "failed_cases": [
            {"case_id": r["case_id"], "error": r.get("error")} for r in failed
        ],
        "slices": {k: summarize(v, b) for k, v in sorted(slices.items())},
        "localization": {
            "tp": loc["tp"],
            "localized": loc["hit"],
            "rate": round(loc["hit"] / loc["tp"], 4) if loc["tp"] else None,
            "ci": _wilson(loc["hit"], loc["tp"]),
        },
        "pending": {k: dict(v) for k, v in sorted(pending.items())},
        "defects": defects,
    }


# ─────────────────────────────────────────────── QA-07: регресс-гейт


def mandatory(report: dict) -> list[str]:
    """Обязательные категории: оператор, пара, тип мутации по целевым группам — где есть положительные; контроль —
    где есть отрицательные (его FPR не должен расти)."""
    return sorted(
        k
        for k, s in report["slices"].items()
        if (k.split(":")[0] in ("op", "pair", "target") and s["n_pos"])
        or (k.startswith("ctl:") and s["n_neg"])
    )


def baseline_of(report: dict) -> dict:
    keep = mandatory(report) + ["all"]
    return {
        "dataset_version": report["dataset_version"],
        "registry_sha256": report["registry_sha256"],
        "categories": {
            k: {
                m: report["slices"][k][m]
                for m in ("n_pos", "n_neg", "recall", "fpr", "precision")
            }
            for k in keep
        },
    }


def gate(
    report: dict,
    base: dict | None,
    recall_drop_pp: float = 0.0,
    fpr_rise_pp: float = 2.0,
) -> list[str]:
    """Причины провала QA-07. Пустой список — пройден. Нет базовой линии профиля — провал, а не молчаливый пропуск."""
    if not base or not base.get("categories"):
        return [
            "базовой линии отложенного набора W2 нет — соберите её явно (--write-baseline) после первого прогона"
        ]
    out = []
    if report["dataset_version"] != base["dataset_version"]:
        out.append(
            f"набор {report['dataset_version']} не совпадает с базовой линией {base['dataset_version']}"
        )
    if report.get("failed_cases") or report.get("missing_cases"):
        out.append(
            f"примеров с отказом: {len(report.get('failed_cases') or [])}, без ответа: {len(report.get('missing_cases') or [])}"
        )
    for k, bl in base["categories"].items():
        s = report["slices"].get(k)
        if s is None:
            out.append(f"{k}: категории нет в прогоне")
            continue
        if bl["recall"] is not None and (
            s["recall"] is None
            or s["recall"] < bl["recall"] - recall_drop_pp / 100 - 1e-9
        ):
            out.append(f"{k}: Recall {s['recall']} < базовой {bl['recall']}")
        if (
            bl["fpr"] is not None
            and s["fpr"] is not None
            and s["fpr"] > bl["fpr"] + fpr_rise_pp / 100 + 1e-9
        ):
            out.append(
                f"{k}: FPR {s['fpr']} > базовой {bl['fpr']} + {fpr_rise_pp} п.п."
            )
    return out


# ─────────────────────────────────────────────── отчёт md


def _f(x) -> str:
    return "—" if x is None else f"{x:.3f}".replace(".", ",")


def _ci(c) -> str:
    return "" if not c else f" [{_f(c[0])}; {_f(c[1])}]"


def markdown(report: dict, title: str = "Отложенный набор W2 — QA-05/QA-06") -> str:
    L = [
        f"# {title}",
        "",
        f"Набор `{report['dataset_version']}`, реестр `{report['registry_sha256']}`: примеров {report['cases']}, групп "
        f"{report['groups']}.",
        "",
        "Интервалы 95 %: Уилсон для долей, бутстрэп по примерам для F1. Воздержание — MISSING_EVIDENCE, NOT_COMPARABLE, "
        "CLARIFICATION_REQUIRED или нет строки при известной метке.",
        "",
    ]
    head = "| Срез | n+ | n− | P | R | F1 | FPR | Воздерж. | Точн. статуса |"
    for name, pref in (
        ("По оператору", "op:"),
        ("По паре «параметр × оператор»", "pair:"),
        ("По мутации", "mut:"),
        ("По мутации — целевые пары", "target:"),
        ("Отрицательные контроли и ловушки", "ctl:"),
    ):
        L += [f"## {name}", "", head, "|---|---|---|---|---|---|---|---|---|"]
        for k, s in report["slices"].items():
            if k.startswith(pref):
                L.append(
                    f"| {k[len(pref) :]} | {s['n_pos']} | {s['n_neg']} | {_f(s['precision'])}{_ci(s['precision_ci'])} | "
                    f"{_f(s['recall'])}{_ci(s['recall_ci'])} | {_f(s['f1'])}{_ci(s['f1_ci'])} | "
                    f"{_f(s['fpr'])}{_ci(s['fpr_ci'])} | {_f(s['abstention'])} | {_f(s['status_accuracy'])} |"
                )
        L.append("")
    lc = report["localization"]
    L += [
        f"Локализация кандидатов (файл РД + страница + IoU ≥ 0,5): {lc['localized']} из {lc['tp']} — "
        f"{_f(lc['rate'])}{_ci(lc['ci'])}.",
        "",
        f"Ожидает оператора: {len(report['pending'])} пар; "
        f"расхождений со статусом истины: {len(report['defects'])}.",
        "",
    ]
    return "\n".join(L)


def main(argv: list[str] | None = None) -> None:  # pragma: no cover — CLI
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dataset", type=Path, required=True)
    ap.add_argument("--results", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--md", type=Path)
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--profile", default="full")
    ap.add_argument("--write-baseline", action="store_true")
    a = ap.parse_args(argv)
    rep = score(
        json.loads(a.dataset.read_text("utf-8")),
        json.loads(a.results.read_text("utf-8")),
    )
    a.out.write_text(json.dumps(rep, ensure_ascii=False, indent=1), "utf-8")
    if a.md:
        a.md.write_text(markdown(rep), "utf-8")
    if a.baseline:
        bl = json.loads(a.baseline.read_text("utf-8"))
        if a.write_baseline:
            bl.setdefault("profiles", {})[a.profile] = baseline_of(rep)
            a.baseline.write_text(
                json.dumps(bl, ensure_ascii=False, indent=1) + "\n", "utf-8"
            )
        else:
            why = gate(rep, (bl.get("profiles") or {}).get(a.profile))
            print("\n".join(why) or "QA-07: пройден")
            sys.exit(1 if why else 0)


if __name__ == "__main__":  # pragma: no cover
    main()
