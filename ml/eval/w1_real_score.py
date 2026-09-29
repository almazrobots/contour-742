"""Оценка W1 на реальных объектах (T-180, OS-INSP-6.5.51–6.5.54) — чистая часть стенда `eval.w1_real`.

Единица — группа «объект × параметр × оператор». Предсказание — статус проверки параметра (запись checks API),
истина — метка эталона объекта. Метка берётся из источника по старшинству: проверенный результат проекта
(`verified`, напр. М-023 ALT-79B, OS-INSP-6.5.8) → разметка организатора (`organizer`) → пилотная разметка (`pilot`)
→ ручная разметка инспектора (`manual`, протокол OS-INSP-6.5.54). В метрики входит только окончательная метка
(`quality: final`); ждущая второй проверки и кандидаты — в счёт «эталон не окончательный». Группа без метки — «нет
эталона»: в P/R/FPR не входит, публикуется только число групп и распределение статусов системы.

Наружу (git, журнал раннера, отчёт) уходит только агрегат: коды объектов, параметров, операторов, статусов и числа —
`assert_aggregate` отбивает любую другую строку (ADR-0002, OS-INSP-6.5.53). Тексты, значения, страницы и файлы остаются
в каталоге прогона на сервере.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable

from eval.ci import bootstrap_ci, wilson

GOLD_SCHEMA = "inspector-w1-real-gold/1"
AGG_SCHEMA = "inspector-w1-real-aggregate/1"
TRUTH = (
    "CONFIRMED_VIOLATION",
    "NEGATIVE_VERIFIED",
    "MISSING_EVIDENCE",
    "NOT_APPLICABLE",
    "CLARIFICATION_REQUIRED",
)
SOURCES = ("verified", "organizer", "pilot", "manual")  # старшинство источников эталона
QUALITY = ("final", "second_review", "candidate")
STATUSES = (
    "CANDIDATE",
    "NEGATIVE_VERIFIED",
    "MISSING_EVIDENCE",
    "NOT_APPLICABLE",
    "NOT_COMPARABLE",
    "CLARIFICATION_REQUIRED",
    "NO_CHECK",
)
ABSTAIN = frozenset(
    {"MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "NO_CHECK"}
)

PARAM_RE = re.compile(r"^M-\d{3}$")
OP_RE = re.compile(r"^CMP-\d{2}$")
OBJ_RE = re.compile(r"^[A-Z]{2,6}(-[0-9A-Z]{1,4}){0,2}$")
REF_RE = re.compile(
    r"^(T-\d{3}|OS-INSP-[\d.]+|labeler:[a-z0-9_.-]{1,40}|organizer:[A-Za-z0-9_.-]{1,40})$"
)


class GoldError(ValueError):
    pass


# ─────────────────────────────── эталон (OS-INSP-6.5.51)


def validate_gold(g: dict) -> list[dict]:
    """Файл эталона объекта: схема, код объекта, метки из справочников. Возвращает метки."""
    if g.get("schema") != GOLD_SCHEMA:
        raise GoldError(f"схема эталона {g.get('schema')!r}, ждём {GOLD_SCHEMA}")
    obj = g.get("object_id") or ""
    if not OBJ_RE.match(obj):
        raise GoldError(f"код объекта {obj!r}: только код вида ALT-79B")
    out = []
    for i, lab in enumerate(g.get("labels") or []):
        where = f"{obj} #{i}"
        if not PARAM_RE.match(lab.get("param") or ""):
            raise GoldError(f"{where}: параметр {lab.get('param')!r} не M-NNN")
        op = lab.get("operator")
        if op is not None and not OP_RE.match(op):
            raise GoldError(f"{where}: оператор {op!r} не CMP-NN")
        if lab.get("label") not in TRUTH:
            raise GoldError(f"{where}: метка {lab.get('label')!r} не из {TRUTH}")
        if lab.get("source") not in SOURCES:
            raise GoldError(f"{where}: источник {lab.get('source')!r} не из {SOURCES}")
        if lab.get("quality") not in QUALITY:
            raise GoldError(
                f"{where}: качество метки {lab.get('quality')!r} не из {QUALITY}"
            )
        if not REF_RE.match(lab.get("ref") or ""):
            raise GoldError(
                f"{where}: ссылка на основание {lab.get('ref')!r} — код задачи, правила или разметчика"
            )
        out.append(lab)
    return out


def truth_for(labels: list[dict], param: str, operator: str) -> dict | None:
    """Метка группы: сначала метка ровно этого оператора, потом метка параметра без оператора; из нескольких —
    по старшинству источника (verified > organizer > pilot > manual), затем окончательная раньше прочих."""
    cand = [
        lab
        for lab in labels
        if lab["param"] == param and lab.get("operator") in (operator, None)
    ]
    if not cand:
        return None
    return min(
        cand,
        key=lambda lab: (
            lab.get("operator") is None,
            SOURCES.index(lab["source"]),
            QUALITY.index(lab["quality"]),
        ),
    )


# ─────────────────────────────── группы и исходы (OS-INSP-6.5.52)


def w1_pairs(wave: dict) -> list[tuple[str, str]]:
    """Пары «параметр × оператор» волны W1 из реестра data/seed/w1-wave.json (операторы W2 не входят)."""
    return [
        (p["code"], op)
        for p in wave["params"]
        for op, meta in p["ops"].items()
        if meta.get("wave") == "W1"
    ]


def attribution(wave: dict, mutation_registry: dict | None = None) -> dict[str, str]:
    """Какому оператору принадлежит статус проверки параметра: подключённая пара стенда мутаций T-179 (там, где она
    есть, — так цифры реальных объектов и мутаций стоят в одной строке), иначе первый оператор W1 параметра."""
    out: dict[str, str] = {}
    for p in (mutation_registry or {}).get("params", []):
        if p.get("wired") and p["code"] not in out:
            out[p["code"]] = p["operator"]
    for code, op in w1_pairs(wave):
        out.setdefault(code, op)
    return out


def outcome(truth: str | None, pred: str) -> str:
    """Исход группы. Положительная — подтверждённое нарушение, отрицательная — NEGATIVE_VERIFIED; прочие метки —
    точность статуса; CANDIDATE на них — ложная тревога (как в README стенда: в P входит, в FPR нет)."""
    violation = pred == "CANDIDATE"
    abstain = pred in ABSTAIN
    if truth is None:
        return "unlabeled"
    if truth == "CONFIRMED_VIOLATION":
        return "tp" if violation else ("abst_pos" if abstain else "fn")
    if truth == "NEGATIVE_VERIFIED":
        return "fp" if violation else ("abst_neg" if abstain else "tn")
    if violation:
        return "fp_other"
    return "other_ok" if pred == truth else "other_bad"


def groups(
    object_id: str,
    rows: list[dict],
    codes: Iterable[str],
    labels: list[dict],
    attr: dict[str, str],
) -> list[dict]:
    """Группы объекта по кодам прогона: статус проверки (нет строки — NO_CHECK) и метка эталона."""
    status = {r["code"]: r["status"] for r in rows}
    out = []
    for code in sorted(set(codes)):
        op = attr.get(code)
        if op is None:
            continue
        pred = status.get(code, "NO_CHECK")
        lab = truth_for(labels, code, op)
        final = lab is not None and lab["quality"] == "final"
        out.append(
            {
                "object": object_id,
                "param": code,
                "operator": op,
                "pred": pred,
                "truth": lab["label"] if final else None,
                "truth_source": lab["source"] if lab else None,
                "truth_quality": lab["quality"] if lab else None,
                "outcome": outcome(lab["label"] if final else None, pred),
            }
        )
    return out


# ─────────────────────────────── метрики и интервалы


def _ratio(k: float, n: float) -> float:
    return k / n if n else float("nan")


VALUE = {
    "precision": lambda c: _ratio(c["tp"], c["tp"] + c["fp"] + c["fp_other"]),
    "recall": lambda c: _ratio(c["tp"], c["tp"] + c["fn"] + c["abst_pos"]),
    "fpr": lambda c: _ratio(c["fp"], c["fp"] + c["tn"] + c["abst_neg"]),
    "abstention": lambda c: _ratio(
        c["abst_pos"] + c["abst_neg"],
        c["tp"] + c["fn"] + c["abst_pos"] + c["fp"] + c["tn"] + c["abst_neg"],
    ),
    "status_accuracy": lambda c: _ratio(
        c["other_ok"], c["other_ok"] + c["other_bad"] + c["fp_other"]
    ),
}
WILSON = {  # (успехи, испытания) для интервала Уилсона на одном объекте
    "precision": lambda c: (c["tp"], c["tp"] + c["fp"] + c["fp_other"]),
    "recall": lambda c: (c["tp"], c["tp"] + c["fn"] + c["abst_pos"]),
    "fpr": lambda c: (c["fp"], c["fp"] + c["tn"] + c["abst_neg"]),
    "abstention": lambda c: (
        c["abst_pos"] + c["abst_neg"],
        c["tp"] + c["fn"] + c["abst_pos"] + c["fp"] + c["tn"] + c["abst_neg"],
    ),
    "status_accuracy": lambda c: (
        c["other_ok"],
        c["other_ok"] + c["other_bad"] + c["fp_other"],
    ),
}


def f1_of(c: Counter) -> float:
    p, r = VALUE["precision"](c), VALUE["recall"](c)
    if math.isnan(p) or math.isnan(r):
        return float("nan")
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def _num(x: float) -> float | None:
    return None if x is None or math.isnan(x) else round(x, 4)


def cell(gs: list[dict], b: int = 1000) -> dict:
    """Метрики среза с 95 % ДИ (OS-INSP-6.5.10): один объект с метками — Уилсон по группам, больше — бутстрэп по
    объектам. F1 на одном объекте интервала не получает (Уилсона для него нет, бутстрэп вырожден)."""
    total: Counter = Counter(g["outcome"] for g in gs)
    per_obj: dict[str, Counter] = defaultdict(Counter)
    for g in gs:
        if g["outcome"] != "unlabeled":
            per_obj[g["object"]][g["outcome"]] += 1
    labeled_objects = sorted(per_obj)
    out: dict = {
        "n": len(gs),
        "n_pos": total["tp"] + total["fn"] + total["abst_pos"],
        "n_neg": total["fp"] + total["tn"] + total["abst_neg"],
        "n_other": total["other_ok"] + total["other_bad"] + total["fp_other"],
        "n_unlabeled": total["unlabeled"],
        "objects": sorted({g["object"] for g in gs}),
        "objects_labeled": labeled_objects,
        "ci_method": "wilson"
        if len(labeled_objects) == 1
        else ("bootstrap" if labeled_objects else None),
        "not_final": sum(
            1
            for g in gs
            if g["truth"] is None
            and g["truth_quality"] in ("second_review", "candidate")
        ),
        "pred_unlabeled": dict(
            sorted(
                Counter(g["pred"] for g in gs if g["outcome"] == "unlabeled").items()
            )
        ),
    }
    for k in (
        "tp",
        "fp",
        "fn",
        "tn",
        "abst_pos",
        "abst_neg",
        "fp_other",
        "other_ok",
        "other_bad",
    ):
        out[k] = total[k]
    for name, fn in VALUE.items():
        v = fn(total)
        out[name] = _num(v)
        if math.isnan(v):
            out[name + "_ci"] = None
        elif len(labeled_objects) == 1:
            lo, hi = wilson(*WILSON[name](total))
            out[name + "_ci"] = [_num(lo), _num(hi)]
        else:
            lo, hi = bootstrap_ci(per_obj, fn, b=b)
            out[name + "_ci"] = [_num(lo), _num(hi)]
    f1 = f1_of(total)
    out["f1"] = _num(f1)
    out["f1_ci"] = (
        [_num(x) for x in bootstrap_ci(per_obj, f1_of, b=b)]
        if len(labeled_objects) > 1 and not math.isnan(f1)
        else None
    )
    return out


def aggregate(gs: list[dict], meta: dict, b: int = 1000) -> dict:
    """Агрегат прогона: срез на пару, на оператор и общий. Только коды и числа."""
    by_pair: dict[str, list] = defaultdict(list)
    by_op: dict[str, list] = defaultdict(list)
    for g in gs:
        by_pair[f"{g['param']}×{g['operator']}"].append(g)
        by_op[g["operator"]].append(g)
    agg = {
        "schema": AGG_SCHEMA,
        **meta,
        "pairs": {k: cell(v, b) for k, v in sorted(by_pair.items())},
        "operators": {k: cell(v, b) for k, v in sorted(by_op.items())},
        "all": cell(gs, b),
    }
    assert_aggregate(agg)
    return agg


# ─────────────────────────────── только агрегаты наружу (OS-INSP-6.5.53)

SAFE_KEYS = frozenset(
    {
        "schema",
        "objects",
        "objects_labeled",
        "codes",
        "approval",
        "parser_rev",
        "extract_rev",
        "timing",
        "counts",
        "rejected_codes",
        "file_status",
        "pairs",
        "operators",
        "all",
        "ci_method",
        "not_final",
        "pred_unlabeled",
        "n",
        "n_pos",
        "n_neg",
        "n_other",
        "n_unlabeled",
        "tp",
        "fp",
        "fn",
        "tn",
        "abst_pos",
        "abst_neg",
        "fp_other",
        "other_ok",
        "other_bad",
        "precision",
        "recall",
        "fpr",
        "abstention",
        "status_accuracy",
        "f1",
        "precision_ci",
        "recall_ci",
        "fpr_ci",
        "abstention_ci",
        "status_accuracy_ci",
        "f1_ci",
        "object_id",
        "files",
        "importable",
        "junk",
        "duplicates",
        "accepted",
        "rejected",
        "cached_r4",
        "without_r4", "skipped_memory",
        "import_s",
        "pipeline_s",
        "total_s",
        "peak_rss_mb",
        "api_rss_mb",
        "host",
        "run_at",
        "git_sha",
        "gold",
        "labels",
        "final",
        "sources",
        "stages",
        "mutations",
        "dataset_version",
    }
)
SAFE_STR = [
    PARAM_RE,
    OP_RE,
    OBJ_RE,
    re.compile(r"^M-\d{3}×CMP-\d{2}$"),
    re.compile(r"^(" + "|".join(STATUSES + TRUTH + SOURCES + QUALITY) + r")$"),
    re.compile(r"^(wilson|bootstrap|ok|failed|PENDING|PARSED|ERROR|PD|RD|ID)$"),
    re.compile(r"^[A-Z_]{2,40}$"),  # коды отказов импорта и статусов разбора
    re.compile(r"^inspector-[a-z0-9-]+/\d+$"),
    re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"),
    re.compile(r"^[0-9a-f]{7,40}$"),
    re.compile(r"^Linux [a-z0-9_]+, ядер \d+$"),
    re.compile(r"^mutations-w1:seed=\d+:scale=[\d.]+:n=\d+$"),
]


def assert_aggregate(x, path: str = "$") -> None:
    """Отказ, если в агрегате есть что-то кроме кодов, статусов и чисел: имя файла, текст, значение параметра."""
    if isinstance(x, dict):
        for k, v in x.items():
            if not (k in SAFE_KEYS or any(r.match(k) for r in SAFE_STR)):
                raise GoldError(f"{path}: ключ {k!r} не из агрегата")
            assert_aggregate(v, f"{path}.{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            assert_aggregate(v, f"{path}[{i}]")
    elif isinstance(x, str):
        if not any(r.match(x) for r in SAFE_STR):
            raise GoldError(f"{path}: строка не код и не статус — наружу не выходит")
    elif not (x is None or isinstance(x, bool | int | float)):
        raise GoldError(f"{path}: тип {type(x).__name__} не из агрегата")


def merge_aggregates(aggs: list[dict], b: int = 1000) -> dict:
    """Сводный агрегат по объектам нужен с бутстрэпом по объектам — поэтому объединяются группы, а не цифры: каждый
    агрегат объекта хранит счётчики исходов пары, из них восстанавливаются группы-единицы (без кодов ничего нового)."""
    gs = []
    for a in aggs:
        obj = a["object_id"]
        for pair, c in a["pairs"].items():
            param, op = pair.split("×")
            for k in (
                "tp",
                "fp",
                "fn",
                "tn",
                "abst_pos",
                "abst_neg",
                "fp_other",
                "other_ok",
                "other_bad",
            ):
                gs += [
                    {
                        "object": obj,
                        "param": param,
                        "operator": op,
                        "outcome": k,
                        "truth": "x",
                        "truth_quality": "final",
                        "pred": "x",
                    }
                ] * c[k]
            for st, n in c["pred_unlabeled"].items():
                gs += [
                    {
                        "object": obj,
                        "param": param,
                        "operator": op,
                        "outcome": "unlabeled",
                        "truth": None,
                        "truth_quality": None,
                        "pred": st,
                    }
                ] * n
    return aggregate(gs, {"objects": sorted(a["object_id"] for a in aggs)}, b)


# ─────────────────────────────── протокол ручной разметки (OS-INSP-6.5.54)

FORM_FIELDS = (
    "kind",
    "item_id",
    "stage",
    "file_id",
    "page",
    "raw",
    "line_text",
    "label",
    "reason",
    "correct_value",
    "rationale",
    "labeler",
)


def mention_queue(
    api: dict, param: str, params: dict[str, dict], split: str
) -> list[dict]:
    """Упоминания параметра, найденные конвейером в ПД/РД/ИД объекта, — строки очереди учителя (формат T-156,
    teacher/labels.py): их инспектор принимает или отклоняет. Реальный документ — не синтетика, split по объекту."""
    p = params.get(param, {})
    out = []
    for e in api.get("extractions") or []:
        if e["code"] != param or not e.get("line_text"):
            continue
        key = "|".join(
            str(x)
            for x in (e["file_sha256"], e["code"], e["page"], e["raw"], e["line_text"])
        )
        out.append(
            {
                "item_id": hashlib.sha256(key.encode()).hexdigest()[:16],
                "object": api["object_id"],
                "stage": e["stage"],
                "path": e["file_id"],
                "file_sha256": e["file_sha256"],
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
                "anchor_bbox": None,
                "line_sha256": hashlib.sha256(e["line_text"].encode()).hexdigest(),
                "synthetic": False,
                "split": split,
            }
        )
    return sorted(
        out,
        key=lambda q: (
            {"PD": 0, "RD": 1, "ID": 2}.get(q["stage"], 3),
            q["path"],
            q["page"],
        ),
    )


def form_csv(queue: list[dict], param: str, operator: str, status: str) -> str:
    """Форма разметки: первая строка — истина группы (метка из TRUTH), дальше по строке на упоминание
    (ACCEPT или REJECT с причиной). Живёт только в каталоге разметки на сервере."""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=FORM_FIELDS)
    w.writeheader()
    w.writerow(
        {"kind": "group", "item_id": f"{param}×{operator}", "raw": f"система: {status}"}
    )
    for q in queue:
        w.writerow(
            {
                "kind": "mention",
                "item_id": q["item_id"],
                "stage": q["stage"],
                "file_id": q["path"],
                "page": q["page"],
                "raw": q["raw"],
                "line_text": q["line_text"],
            }
        )
    return buf.getvalue()


def import_form(
    text: str, queue: list[dict], object_id: str, param: str, operator: str
) -> tuple[dict | None, list[dict]]:
    """Заполненная форма → метка группы в эталон объекта (source manual) и метки упоминаний в формате учителя T-156.
    Строка без метки пропускается (разметка может идти частями); кривая метка — отказ с номером строки."""
    from teacher.labels import validate

    by_id = {q["item_id"]: q for q in queue}
    group, labels = None, []
    for i, row in enumerate(csv.DictReader(io.StringIO(text)), start=2):
        lab = (row.get("label") or "").strip()
        if not lab:
            continue
        labeler = (row.get("labeler") or "").strip()
        if row["kind"] == "group":
            if row["item_id"] != f"{param}×{operator}":
                raise GoldError(f"строка {i}: форма другой группы ({row['item_id']})")
            if lab not in TRUTH:
                raise GoldError(f"строка {i}: метка группы {lab!r} не из {TRUTH}")
            if not re.match(r"^[a-z0-9_.-]{1,40}$", labeler):
                raise GoldError(f"строка {i}: разметчик — логин латиницей")
            group = {
                "param": param,
                "operator": operator,
                "label": lab,
                "source": "manual",
                "quality": "final",
                "ref": f"labeler:{labeler}",
            }
            validate_gold(
                {"schema": GOLD_SCHEMA, "object_id": object_id, "labels": [group]}
            )
        else:
            label = {
                "item_id": row["item_id"],
                "label": lab,
                "reason": (row.get("reason") or "").strip() or None,
                "correct_value": (row.get("correct_value") or "").strip() or None,
                "rationale": (row.get("rationale") or "").strip(),
                "labeler": labeler,
                "line_sha256": by_id.get(row["item_id"], {}).get("line_sha256"),
            }
            try:
                validate(label, by_id.get(row["item_id"]))
            except ValueError as e:
                raise GoldError(f"строка {i}: {e}") from e
            labels.append(label)
    return group, labels


def upsert_label(gold: dict, lab: dict) -> dict:
    """Метка в эталон объекта: та же пара и тот же источник заменяется, прочие остаются (старшинство решает при чтении)."""
    keep = [
        x
        for x in gold.get("labels", [])
        if not (
            x["param"] == lab["param"]
            and x.get("operator") == lab.get("operator")
            and x["source"] == lab["source"]
        )
    ]
    out = gold | {"labels": keep + [lab]}
    validate_gold(out)
    return out


# ─────────────────────────────── разметка организатора → эталон

ORGANIZER_LABEL = {
    "VIOLATION_PRESENT": "CONFIRMED_VIOLATION",
    "NO_VIOLATION": "NEGATIVE_VERIFIED",
    "MISSING_DOCUMENT": "MISSING_EVIDENCE",
    "COMPARISON_IMPOSSIBLE": "CLARIFICATION_REQUIRED",
}
ORGANIZER_QUALITY = {
    "FINAL_GOLD_EXISTENCE": "final",
    "GOLD_READY_SECOND_REVIEW": "second_review",
}


def organizer_labels(
    checks: list[dict], objects: dict[str, str]
) -> dict[str, list[dict]]:
    """Проверки организатора (all_gold_checks.jsonl: parameter_id, object_id, violation_label, gold_status) → метки
    эталона по кодам объектов проекта. Параметр — M-NNN = parameter_id каталога организатора (T-134); объект вне
    справочника и метка вне словаря пропускаются (не угадываются)."""
    out: dict[str, list[dict]] = defaultdict(list)
    for c in checks:
        obj = objects.get(c.get("object_id") or "")
        label = ORGANIZER_LABEL.get(c.get("violation_label") or "")
        pid = c.get("parameter_id")
        if (
            obj is None
            or label is None
            or not isinstance(pid, int | str)
            or not str(pid).isdigit()
        ):
            continue
        out[obj].append(
            {
                "param": f"M-{int(pid):03d}",
                "operator": None,
                "label": label,
                "source": "organizer",
                "quality": ORGANIZER_QUALITY.get(
                    c.get("gold_status") or "", "candidate"
                ),
                "ref": "organizer:"
                + re.sub(r"[^A-Za-z0-9_.-]", "_", str(c.get("check_id") or "check"))[
                    :40
                ],
            }
        )
    return dict(out)
