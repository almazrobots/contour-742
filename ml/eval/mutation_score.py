"""Оценка стенда мутаций L11 (T-179, каталог TO-BE §15.3; OS-INSP-6.5.45–6.5.49).

QA-05 — Precision, Recall, F1 и доля воздержаний по паре «параметр × оператор», по оператору и по типу мутации;
QA-06 — FPR на отрицательных примерах и отдельно на ловушках устаревшей редакции (VER-03); QA-07 — регресс-гейт
против базовой линии в репозитории. Интервалы: доли — Уилсон 95 % (примеры — независимые синтетические объекты),
F1 — бутстрэп по примерам (`eval.ci`, объект = пример).

Единица оценки — группа доказательств «пример × параметр × оператор». Предсказание «нарушение» — статус CANDIDATE.
Воздержание — MISSING_EVIDENCE, NOT_COMPARABLE или CLARIFICATION_REQUIRED там, где истинная метка известна (pos/neg);
для Recall воздержание на положительном — промах. Пары, чей оператор ещё не подключён (wired=false или не хватает
операций из `requires`), в метрики не входят — отдельный раздел «ожидает оператора» с наблюдаемым статусом.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from eval import ci as ci_mod
from eval.metrics import iou

ABSTAIN = ("MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED")
IOU_MIN = 0.5
LABELER = "генератор мутаций T-179"


def outcome(t: dict, status: str | None) -> Counter:
    """Счётчики одной группы: tp/fn/fp/tn, воздержание, ловушка устаревшей редакции, совпадение статуса."""
    c: Counter = Counter()
    st = status or "ABSENT"
    c["n"] += 1
    c["status_ok"] += st in t["expected"]
    if t["polarity"] == "other":
        c["other"] += 1
        return c
    flagged = st == "CANDIDATE"
    abst = st in ABSTAIN or st == "ABSENT"
    if t["polarity"] == "pos":
        c["pos"] += 1
        c["tp" if flagged else "fn"] += 1
    else:
        c["neg"] += 1
        c["fp" if flagged else "tn"] += 1
        if "superseded" in t["tags"]:
            c["neg_stale"] += 1
            c["fp_stale"] += flagged
    c["abst"] += abst
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


def summarize(per_case: dict[str, Counter], b: int = 400, seed: int = 20260928) -> dict:
    """Метрики среза: доли с интервалом Уилсона, F1 — бутстрэп по примерам."""
    c: Counter = Counter()
    for x in per_case.values():
        c.update(x)
    p = _ratio(c["tp"], c["tp"] + c["fp"])
    r = _ratio(c["tp"], c["pos"])
    f1 = _f1(c)
    f1_ci = None
    if c["pos"] and len(per_case) > 1:
        lo, hi = ci_mod.bootstrap_ci(per_case, _f1, b=b, seed=seed)
        if not (math.isnan(lo) or math.isnan(hi)):
            f1_ci = [round(lo, 4), round(hi, 4)]
    rnd = lambda x: (
        None if x is None or (isinstance(x, float) and math.isnan(x)) else round(x, 4)
    )  # noqa: E731
    return {
        "n": c["n"],
        "n_pos": c["pos"],
        "n_neg": c["neg"],
        "n_other": c["other"],
        "tp": c["tp"],
        "fp": c["fp"],
        "fn": c["fn"],
        "tn": c["tn"],
        "precision": rnd(p),
        "precision_ci": _wilson(c["tp"], c["tp"] + c["fp"]),
        "recall": rnd(r),
        "recall_ci": _wilson(c["tp"], c["pos"]),
        "f1": rnd(f1),
        "f1_ci": f1_ci,
        "fpr": rnd(_ratio(c["fp"], c["neg"])),
        "fpr_ci": _wilson(c["fp"], c["neg"]),
        "fpr_superseded": rnd(_ratio(c["fp_stale"], c["neg_stale"])),
        "n_superseded": c["neg_stale"],
        "fpr_superseded_ci": _wilson(c["fp_stale"], c["neg_stale"]),
        "abstention": rnd(_ratio(c["abst"], c["pos"] + c["neg"])),
        "abstention_ci": _wilson(c["abst"], c["pos"] + c["neg"]),
        "status_accuracy": rnd(_ratio(c["status_ok"], c["n"])),
        "status_accuracy_ci": _wilson(c["status_ok"], c["n"]),
    }


def localized(t: dict, row: dict | None) -> bool:
    """Доказательство найдено там, где мутация: фрагмент РД на той же странице того же файла с IoU ≥ 0,5."""
    if not row:
        return False
    for f in row.get("fragments") or []:
        if f["stage"] != "RD" or not f.get("bbox"):
            continue
        for e in t["evidence"]:
            if (
                e["file_id"] == f["file_id"]
                and e["page"] == f["page"]
                and iou(e["bbox"], f["bbox"]) >= IOU_MIN
            ):
                return True
    return False


def index_results(api: dict) -> tuple[dict[tuple[str, str], dict], dict[str, dict]]:
    rows, cases = {}, {}
    for r in api["results"]:
        cases[r["case_id"]] = r
        for row in r["rows"]:
            rows[(r["case_id"], row["code"])] = row
    return rows, cases


def facets(t: dict, case: dict | None) -> list[str]:
    """Признаки формулировки группы (профиль adversarial): раскладка, формат, подпись, шум ПД и текущей РД —
    для разбора, на каких формулировках ошибается конвейер. У structural признаков нет."""
    if not case:
        return []
    out = []
    for f in case.get("files", []):
        st = f.get("style")
        if not st or (f["doc_stage"] == "RD" and f["file_id"] not in case.get("rd_current", [f["file_id"]])):
            continue
        stage = "ПД" if f["doc_stage"] == "PD" else "РД"
        q = st["q"].get(t["code"])
        cl = st["cls"].get(t["code"])
        if q:
            out += [f"{t['code']} · {stage} раскладка {q['layout']}", f"{t['code']} · {stage} формат {q['fmt']}",
                    f"{t['code']} · {stage} подпись «{q['label']}»", f"{t['code']} · {stage} ед. {q['unit']}"]
            if q["ocr2"]:
                out.append(f"{t['code']} · {stage} шум {q['ocr2']}")
        if cl:
            out.append(f"{t['code']} · {stage} фраза «{cl['phrase'][:48]}»")
            if cl["noise"]:
                out.append(f"{t['code']} · {stage} значение {cl['noise']}")
            if cl["ocr2"]:
                out.append(f"{t['code']} · {stage} шум {cl['ocr2']}")
            if st.get("distractor"):
                out.append(f"{t['code']} · {stage} дистрактор")
    return out


def mutation_label(t: dict, modifier: str | None) -> str:
    """Тип мутации для среза: модификатор (MUT-17, MUT-18/stale|conflict|swap) важнее базовой замены значения."""
    return modifier or t["mutation"]


def score(dataset: dict, api: dict, b: int = 400) -> dict:
    """Отчёт QA-05/QA-06 по набору и ответу API."""
    rows, cases = index_results(api)
    slices: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    pending: dict[str, Counter] = defaultdict(Counter)
    loc = Counter()
    defects: list[dict] = []
    mods = {c["case_id"]: c.get("modifier") for c in dataset["cases"]}
    cases_by_id = {c["case_id"]: c for c in dataset["cases"]}
    facet_stats: dict[str, Counter] = defaultdict(Counter)
    for t in dataset["truth"]:
        row = rows.get((t["case_id"], t["code"]))
        status = row["status"] if row else None
        mut = mutation_label(t, mods.get(t["case_id"]))
        if t["pending"]:
            key = f"{t['code']}×{t['operator']} · {mut}{' · ' + '+'.join(t['requires']) if t['requires'] else ''}"
            pending[key]["n"] += 1
            pending[key][f"наблюдено {status or 'нет проверки'}"] += 1
            pending[key]["ожидается " + " или ".join(t["expected"])] += 0
            continue
        c = outcome(t, status)
        if t["polarity"] in ("pos", "neg"):
            for f in facets(t, cases_by_id.get(t["case_id"])):
                facet_stats[f]["n"] += 1
                facet_stats[f]["err"] += status not in t["expected"]
        pair = f"{t['code']}×{t['operator']}"
        for key in (
            "all",
            f"op:{t['operator']}",
            f"pair:{pair}",
            f"mut:{mut}",
        ):
            slices[key][t["case_id"]].update(c)
        if t["target"]:
            slices[f"target:{mut}"][t["case_id"]].update(c)
        if t["polarity"] == "pos" and status == "CANDIDATE":
            loc["tp"] += 1
            loc["hit"] += localized(t, row)
        if status not in t["expected"]:
            defects.append(
                {
                    "case_id": t["case_id"],
                    "code": t["code"],
                    "operator": t["operator"],
                    "mutation": t["mutation"],
                    "variant": t["variant"],
                    "target": t["target"],
                    "tags": t["tags"],
                    "expected": t["expected"],
                    "status": status,
                    "pd": t["pd_value"],
                    "rd": t["rd_value"],
                    "system": {k: row.get(k) for k in ("expected", "actual", "reason")}
                    if row
                    else None,
                }
            )
    failed = [
        r
        for r in api["results"]
        if r.get("error") or any(f["parse_status"] != "DONE" for f in r["files"])
    ]
    return {
        "schema": "inspector-mutation-report/1",
        "dataset_version": dataset["dataset_version"],
        "registry_sha256": dataset.get("registry_sha256"),
        "cases": len(dataset["cases"]),
        "groups": len(dataset["truth"]),
        "failed_cases": [
            {
                "case_id": r["case_id"],
                "error": r.get("error"),
                "files": [f for f in r["files"] if f["parse_status"] != "DONE"],
            }
            for r in failed
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
        "facets": {k: {"n": v["n"], "err": v["err"], "err_rate": round(v["err"] / v["n"], 4)} for k, v in sorted(facet_stats.items()) if v["n"]},
        "external_phrasers": dataset.get("external_phrasers", {}),
        "timing": {
            "api_ms": api.get("ms"),
            "api_rss_mb": api.get("rss_mb"),
            "case_ms_p50": _pct([r["ms"] for r in api["results"]], 0.5),
            "case_ms_max": max((r["ms"] for r in api["results"]), default=None),
        },
    }


def _pct(xs: list[int], q: float) -> int | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(q * len(s)))]


# ─────────────────────────────────────────────── QA-07: регресс-гейт


def mandatory(report: dict) -> list[str]:
    """Обязательные категории: оператор, пара «параметр × оператор», тип мутации по целевым примерам — где есть положительные."""
    return sorted(
        k
        for k, s in report["slices"].items()
        if k.split(":")[0] in ("op", "pair", "target") and s["n_pos"]
    )


def baseline_of(report: dict) -> dict:
    """Базовая линия из отчёта: Recall и FPR каждой обязательной категории и общий FPR, FPR по устаревшим."""
    keep = mandatory(report) + ["all"]
    cats = {
        k: {
            m: report["slices"][k][m]
            for m in ("n_pos", "n_neg", "recall", "fpr", "fpr_superseded", "precision")
        }
        for k in keep
    }
    return {
        "dataset_version": report["dataset_version"],
        "registry_sha256": report["registry_sha256"],
        "parser_rev": report.get("parser_rev"),
        "extract_rev": report.get("extract_rev"),
        "categories": cats,
    }


def gate(
    report: dict, base: dict, recall_drop_pp: float = 0.0, fpr_rise_pp: float = 2.0, same_dataset: bool = True
) -> list[str]:
    """Причины провала QA-07: Recall обязательной категории упал, FPR (общий, по категории, по устаревшим) вырос больше
    чем на fpr_rise_pp п.п., категория пропала, набор не тот. Пустой список — гейт пройден."""
    out = []
    # same_dataset=False — сверка с базовой линией main: ветка могла законно добавить параметры (другой набор), но
    # категории, которые main уже меряет, не должны стать хуже
    if same_dataset and report["dataset_version"] != base["dataset_version"]:
        out.append(
            f"набор {report['dataset_version']} не совпадает с базовой линией {base['dataset_version']} — пересоберите базовую линию явно"
        )
    if report.get("failed_cases"):
        out.append(
            f"примеров с отказом разбора или приёма: {len(report['failed_cases'])} ({', '.join(x['case_id'] for x in report['failed_cases'][:5])})"
        )
    for k, b in base["categories"].items():
        s = report["slices"].get(k)
        if s is None:
            out.append(f"{k}: категории нет в прогоне")
            continue
        if b["recall"] is not None and (
            s["recall"] is None
            or s["recall"] < b["recall"] - recall_drop_pp / 100 - 1e-9
        ):
            out.append(f"{k}: Recall {s['recall']} < базовой {b['recall']}")
        for m in ("fpr", "fpr_superseded"):
            if (
                b[m] is not None
                and s[m] is not None
                and s[m] > b[m] + fpr_rise_pp / 100 + 1e-9
            ):
                out.append(
                    f"{k}: {m.upper()} {s[m]} > базовой {b[m]} + {fpr_rise_pp} п.п."
                )
    return out


# ─────────────────────────────────────────────── отчёт md


def _f(x) -> str:
    return "—" if x is None else f"{x:.3f}".replace(".", ",")


def _ci(c) -> str:
    return "" if not c else f" [{_f(c[0])}; {_f(c[1])}]"


def markdown(report: dict, title: str = "Стенд мутаций L11 — QA-05/QA-06") -> str:
    L = [
        f"# {title}",
        "",
        f"Набор `{report['dataset_version']}`, реестр `{report['registry_sha256']}`: примеров {report['cases']}, групп {report['groups']}.",
        "",
    ]
    L += [
        "Интервалы — 95 %: Уилсон для долей, бутстрэп по примерам для F1. Воздержание — MISSING_EVIDENCE, NOT_COMPARABLE, CLARIFICATION_REQUIRED при известной метке.",
        "",
    ]
    head = "| Срез | n+ | n− | P | R | F1 | FPR | FPR устар. (n) | Воздерж. | Точн. статуса |"
    for title_, pref in (
        ("По оператору", "op:"),
        ("По паре «параметр × оператор»", "pair:"),
        ("По типу мутации — все группы примеров", "mut:"),
        ("По типу мутации — целевой параметр", "target:"),
    ):
        L += [f"## {title_}", "", head, "|---|---|---|---|---|---|---|---|---|---|"]
        for k, s in report["slices"].items():
            if not k.startswith(pref):
                continue
            L.append(
                f"| {k[len(pref) :]} | {s['n_pos']} | {s['n_neg']} | {_f(s['precision'])}{_ci(s['precision_ci'])} | {_f(s['recall'])}{_ci(s['recall_ci'])} | {_f(s['f1'])}{_ci(s['f1_ci'])} | "
                f"{_f(s['fpr'])}{_ci(s['fpr_ci'])} | {_f(s['fpr_superseded'])} ({s['n_superseded']}) | {_f(s['abstention'])} | {_f(s['status_accuracy'])} |"
            )
        L.append("")
    a = report["slices"].get("all")
    if a:
        L += [
            "## Итог",
            "",
            head,
            "|---|---|---|---|---|---|---|---|---|---|",
            f"| все подключённые | {a['n_pos']} | {a['n_neg']} | {_f(a['precision'])}{_ci(a['precision_ci'])} | {_f(a['recall'])}{_ci(a['recall_ci'])} | {_f(a['f1'])}{_ci(a['f1_ci'])} | {_f(a['fpr'])}{_ci(a['fpr_ci'])} | {_f(a['fpr_superseded'])} ({a['n_superseded']}) | {_f(a['abstention'])} | {_f(a['status_accuracy'])} |",
            "",
        ]
    lc = report["localization"]
    L += [
        f"Локализация кандидатов (файл РД + страница + IoU ≥ 0,5): {lc['localized']} из {lc['tp']} — {_f(lc['rate'])}{_ci(lc['ci'])}.",
        "",
    ]
    L += [
        "## Ожидает оператора (в метрики не входит)",
        "",
        "| Пара · мутация · нужно | Примеров | Наблюдено |",
        "|---|---|---|",
    ]
    for k, v in report["pending"].items():
        seen = ", ".join(
            f"{x.removeprefix('наблюдено ')} — {n}"
            for x, n in v.items()
            if x.startswith("наблюдено")
        )
        exp = next(
            (x.removeprefix("ожидается ") for x in v if x.startswith("ожидается")), ""
        )
        L.append(f"| {k} (ожидается {exp}) | {v['n']} | {seen} |")
    L += ["", f"## Расхождения со статусом истины: {len(report['defects'])}", ""]
    by = Counter(
        (
            d["code"],
            d["operator"],
            d["mutation"],
            d["variant"].split(" ")[0],
            d["status"],
            "/".join(d["expected"]),
        )
        for d in report["defects"]
    )
    if by:
        L += [
            "| Пара | Мутация · вариант | Статус системы | Ожидалось | Групп |",
            "|---|---|---|---|---|",
        ]
        for (code, op, mut, var, st, exp), n in by.most_common():
            L.append(f"| {code}×{op} | {mut} · {var} | {st} | {exp} | {n} |")
    fx = [(k, v) for k, v in (report.get("facets") or {}).items() if v["err"]]
    if report.get("facets"):
        L += ["", "## Разбор по формулировкам (профиль adversarial)", "",
              f"Признаков формулировки: {len(report['facets'])}, с ошибками: {len(fx)}. Ошибка — статус группы не совпал с истиной.", ""]
        if fx:
            L += ["| Параметр · признак документа | Групп | Ошибок | Доля |", "|---|---|---|---|"]
            for k, v in sorted(fx, key=lambda kv: (-kv[1]["err_rate"], -kv[1]["n"])):
                L.append(f"| {k} | {v['n']} | {v['err']} | {_f(v['err_rate'])} |")
    if report.get("external_phrasers"):
        L += ["", "Внешние отложенные наборы: " + "; ".join(f"{k} — {v}" for k, v in report["external_phrasers"].items()) + "."]
    if report["failed_cases"]:
        L += ["", f"Примеры с отказом: {len(report['failed_cases'])}."]
    return "\n".join(L) + "\n"


def side_by_side(reports: dict[str, dict]) -> str:
    """Сводка QA-05/06 по оператору и паре: строка на профиль (structural — механика, adversarial — отложенные
    формулировки). Разрыв между строками — мера самосогласованности шаблонов, а не качества."""
    L = ["# Стенд мутаций L11 — structural и adversarial рядом", ""]
    for name, rep in reports.items():
        L.append(f"- {name}: набор `{rep['dataset_version']}`, примеров {rep['cases']}, групп {rep['groups']}, отказов {len(rep['failed_cases'])}")
    L += ["", "| Срез | Профиль | n+ | n− | P | R | F1 | FPR | FPR устар. | Воздерж. |", "|---|---|---|---|---|---|---|---|---|---|"]
    keys = sorted({k for r in reports.values() for k in r["slices"] if k.split(":")[0] in ("op", "pair")} | {"all"})
    for k in keys:
        for name, rep in reports.items():
            x = rep["slices"].get(k)
            if not x:
                continue
            L.append(f"| {k.split(':', 1)[-1]} | {name} | {x['n_pos']} | {x['n_neg']} | {_f(x['precision'])}{_ci(x['precision_ci'])} | {_f(x['recall'])}{_ci(x['recall_ci'])} | "
                     f"{_f(x['f1'])} | {_f(x['fpr'])}{_ci(x['fpr_ci'])} | {_f(x['fpr_superseded'])} | {_f(x['abstention'])} |")
    return "\n".join(L) + "\n"


# ─────────────────────────────────────────────── метки в эталон судьи (T-156)


def judge_items(
    dataset: dict, api: dict, params: dict[str, dict]
) -> tuple[list[dict], list[dict]]:
    """Очередь и метки учителя (формат teacher/labels.py) по упоминаниям, которые извлёк конвейер: значение совпало
    с истинным значением листа — ACCEPT, нет — REJECT WRONG_VALUE. Синтетика — только train (OS-INSP-6.4.16)."""
    files = {f["file_id"]: (c, f) for c in dataset["cases"] for f in c.get("files", [])}
    queue, labels = [], []
    for r in api["results"]:
        for e in r.get("extractions") or []:
            c, f = files.get(e["file_id"], (None, None))
            if f is None or e["code"] not in f.get("truth_values", {}):
                continue
            truth = f["truth_values"][e["code"]]
            got = e["value_num"] if isinstance(truth, float | int) else e["value_text"]
            ok = got is not None and (
                abs(got - truth) < 1e-6
                if isinstance(truth, float | int)
                else str(got).replace("C", "С") == truth
            )
            p = params.get(e["code"], {})
            key = "|".join(
                str(x)
                for x in (f["sha256"], e["code"], e["page"], e["raw"], e["line_text"])
            )
            iid = hashlib.sha256(key.encode()).hexdigest()[:16]
            line_sha = hashlib.sha256(e["line_text"].encode()).hexdigest()
            queue.append(
                {
                    "item_id": iid,
                    "object": c["case_id"],
                    "stage": f["doc_stage"],
                    "path": f["file_name"],
                    "file_sha256": f["sha256"],
                    "page": e["page"],
                    "page_source": "text",
                    "code": e["code"],
                    "parameter_name": p.get("parameter_name"),
                    "section": p.get("section"),
                    "unit": p.get("unit"),
                    "data_type": p.get("data_type"),
                    "raw": e["raw"],
                    "value_num": e["value_num"],
                    "value_text": e["value_text"],
                    "line_text": e["line_text"],
                    "confidence": e["confidence"],
                    "match": "lexical",
                    "similarity": None,
                    "bbox": e["bbox"],
                    "anchor_bbox": e.get("anchor_bbox"),
                    "line_sha256": line_sha,
                    "synthetic": True,
                    "split": "train",
                }
            )
            labels.append(
                {
                    "item_id": iid,
                    "label": "ACCEPT" if ok else "REJECT",
                    "reason": None if ok else "WRONG_VALUE",
                    "correct_value": None if ok else str(truth),
                    "rationale": f"мутация {c['case_id']}: истинное значение листа — {truth}",
                    "labeler": LABELER,
                    "line_sha256": line_sha,
                }
            )
    return queue, labels


def decisions(dataset: dict, api: dict) -> list[dict]:
    """Решения инспектора по группам мутаций: положительная — подтверждено, отрицательная — отклонено, прочее — уточнение."""
    rows, _ = index_results(api)
    out = []
    for t in dataset["truth"]:
        if t["polarity"] == "other" and t["pending"]:
            continue
        row = rows.get((t["case_id"], t["code"]))
        out.append(
            {
                "evidence_group_id": f"{t['case_id']}:{t['code']}:{t['operator']}",
                "object": t["case_id"],
                "code": t["code"],
                "operator": t["operator"],
                "mutation": t["mutation"],
                "variant": t["variant"],
                "system_status": row["status"] if row else None,
                "decision": {
                    "pos": "CONFIRMED_VIOLATION",
                    "neg": "NEGATIVE_VERIFIED",
                }.get(t["polarity"], t["expected"][0]),
                "expected_value": row.get("expected") if row else None,
                "actual_value": row.get("actual") if row else None,
                "evidence": t["evidence"],
                "labeler": LABELER,
                "synthetic": True,
                "split": "train",
            }
        )
    return out


def write_json(p: Path, x) -> None:
    p.write_text(json.dumps(x, ensure_ascii=False, indent=1), "utf-8")
