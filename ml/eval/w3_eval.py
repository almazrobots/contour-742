"""Прогон отложенного состязательного набора W3 (T-210, OS-INSP-6.5.70): случай → документы стадий → настоящее извлечение
ML по паспорту → настоящее сравнение API → статус против ожидаемого.

Вход — JSONL, строка — случай:
    {"id", "param", "stages": {"PD": [{"discipline", "text"}], "RD": [...], "ID": [...]},
     "expected": {"status", "accept": [...]}, "adversarial", "why"}
`text` — многострочный текст документа (строки таблиц — ячейки через «|»). Каждый документ — отдельный ParsedDoc, его
`discipline` — дисциплина упоминаний; стадия с хотя бы одним документом — загруженная (стадии без документов нет в
`loadedStages`: отсутствие документа должно давать MISSING_EVIDENCE, а не нарушение).

Извлечение — по `extractor.kind` паспорта через реестр `EXTRACTORS`; сравнение — по `value.kind` через мост
`apps/api/scripts/w3-eval.ts` (одним вызовом на набор). Вида, которого ещё нет в реестре (ветки W3 не влиты), случай
получает SKIPPED_NO_KIND и в метрики не входит — прогон не падает.

    uv run python -m eval.w3_eval --cases ../data/holdout/w3/cases.jsonl --out ../var/w3/holdout.json [--md ../var/w3/holdout.md]

Метрики (по параметру и ALL): главная — FP-нарушение (система CANDIDATE, а ожидался не CANDIDATE и CANDIDATE не в
`accept`), цель 0; Recall по CANDIDATE; P, F1, FPR и доля воздержаний (MISSING_EVIDENCE, NOT_COMPARABLE,
CLARIFICATION_REQUIRED, NOT_APPLICABLE, SUSPICION — `data/holdout/w3/README.md`, п. 3) — с интервалом Уилсона 95 %,
рядом доля воздержаний эталона; «верно» — статус равен ожидаемому или входит в `accept`.
CANDIDATE на отрицательном случае, где он допустим (`accept`), — ни tp, ни fp; ответ из `accept` на положительном
случае Recall не повышает. Срезы: по параметру, ALL, «состязательные» и «базовые» (`adversarial` = null). Нет паспорта
параметра в ветке — тоже SKIPPED_NO_KIND. Только синтетика (ADR-0002).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from inspector_ml.direction_mentions import extract_direction_mentions
from inspector_ml.model import ParamSpec
from inspector_ml.presence_mentions import extract_presence_mentions
from inspector_ml.quantity_mentions import extract_quantity_mentions

from .ci import wilson
from .t173_eval import mk_doc
from .t213_eval import docreq_extract, docreq_fields, schedule_extract, schedule_fields

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
ABSTAIN = {
    "MISSING_EVIDENCE",
    "NOT_COMPARABLE",
    "CLARIFICATION_REQUIRED",
    "NOT_APPLICABLE",
    "SUSPICION",
}
SKIPPED = "SKIPPED_NO_KIND"
STAGE_PREFIX = {"PD": "П", "RD": "Р", "ID": "И"}
APPROVAL = {"PD": "APPROVED", "RD": "FOR_CONSTRUCTION", "ID": "APPROVED"}


@dataclass(frozen=True)
class Extractor:
    """Вид извлечения: функция ML и поля упоминания, которые читает оценщик своего вида в API."""

    data_type: str
    extract: Callable
    fields: Callable[[object], dict]
    # спецификация экстрактора из паспорта — как extractorSpec в apps/api/src/domain/passport.ts (T-213: словари значения)
    spec: Callable[[dict], dict] = lambda pp: dict(pp["extractor"])


def _quantity_fields(e) -> dict:
    m = e.meta
    return {
        "num": e.value_num,
        "unit": m.get("unit", None),
        "variant": m.get("variant"),
        "limit": bool(m.get("limit")),
        "aspect": m.get("aspect"),
        "object": m.get("object"),  # T-211: объект значения (марка, подпись строки таблицы)
    }


def _direction_fields(e) -> dict:
    """T-214: направление («outward» / «inward» / «hand»), марка двери и оговорка нормы — поля DirectionMention."""
    m = e.meta
    return {"value": e.value_text, "mark": m.get("mark"), "exemption": m.get("exemption"), "evac": m.get("evac"), "building": m.get("building"), "remaining_m": m.get("remaining_m")}


def _presence_extract(doc, spec: ParamSpec):
    """T-212: спецификация как у API (presenceExtractorSpec) — вид значения и словарь методов из паспорта."""
    v = passport(spec.code)["value"]
    ext = dict(spec.extractor or {}, value_kind=v["kind"])
    if v["kind"] == "method":
        ext["terms"] = [{"key": k, "patterns": t["patterns"]} for k, t in v["terms"].items()]
    return extract_presence_mentions(doc, spec.model_copy(update={"extractor": ext}))


def _presence_fields(e) -> dict:
    m = e.meta
    return {"state": m["state"], "aspect": m["aspect"], "term": m.get("term"), "count": m.get("count"), "hint": m.get("hint")}


# Реестр видов извлечения: ветки W3 (presence, schedule, direction) добавляют сюда свою строку при интеграции.
EXTRACTORS: dict[str, Extractor] = {
    "quantity_mentions": Extractor(
        "number", extract_quantity_mentions, _quantity_fields
    ),
    "direction_mentions": Extractor("string", extract_direction_mentions, _direction_fields),  # T-214
    # T-213: календарный график (М-082, М-087) и перечень ИД с сечениями (М-096)
    "schedule_rows": Extractor("string", schedule_extract, schedule_fields),
    "doc_requirements": Extractor("string", docreq_extract, docreq_fields),
    # T-212 (feat/w3-presence): мероприятия и методы
    "presence_mentions": Extractor("string", _presence_extract, _presence_fields),  # T-212
    "method_mentions": Extractor("string", _presence_extract, _presence_fields),  # T-212
}


def passport(code: str) -> dict:
    return json.loads((ROOT / f"data/seed/passports/{code}.json").read_text("utf-8"))


def load_cases(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text("utf-8").splitlines() if x.strip()]


def mention(
    stage: str,
    file_id: str,
    disc: str | None,
    e,
    fields: Callable,
    sha: str = "0" * 64,
    doc: dict | None = None,
) -> dict:
    """Упоминание в формате оценщика API. doc — строка реестра пакета (шифр, редакция, утверждение, базовый шифр);
    нет — синтетика набора: один комплект с базовым шифром «100»."""
    m = e.meta
    doc = doc or {}
    return {
        "stage": stage,
        "file_id": file_id,
        "sha256": sha,
        "document_code": doc.get("document_code")
        or f"{STAGE_PREFIX[stage]}-100-{disc or '—'}",
        "revision": doc.get("revision") or "1",
        "approval_status": doc.get("approval_status") or APPROVAL[stage],
        "role": "CURRENT",
        "discipline": disc,
        "base": doc.get("base", "100"),
        "excluded": m.get("excluded"),
        "excluded_why": m.get("excluded_why"),
        "page": e.page,
        "bbox": list(e.bbox) if e.bbox else None,
        "quote": m.get("quote") or "",
        "confidence": e.confidence,
        "source": "pdf-text",
        **fields(e),
    }


def extractor_for(code: str) -> tuple[Extractor, ParamSpec] | None:
    """Извлекатель и спецификация параметра по паспорту; None — нет паспорта или вида извлечения в реестре."""
    if not (ROOT / f"data/seed/passports/{code}.json").exists():
        return None
    pp = passport(code)
    ex = EXTRACTORS.get(pp["extractor"]["kind"])
    if ex is None:
        return None
    return ex, ParamSpec(
        code=code, anchors=[pp["title"]], data_type=ex.data_type, extractor=ex.spec(pp)
    )


def case_row(case: dict) -> dict | None:
    """Строка моста: упоминания всех документов и загруженные стадии; None — нет паспорта или вида извлечения в реестре."""
    got_ex = extractor_for(case["param"])
    if got_ex is None:
        return None
    ex, spec = got_ex
    ms: list[dict] = []
    loaded: list[str] = []
    for stage, docs in case["stages"].items():
        if docs:
            loaded.append(stage)
        for di, doc in enumerate(docs):
            got = ex.extract(mk_doc(doc["text"].split("\n")), spec)
            ms += [
                mention(stage, f"{stage}-{di}", doc["discipline"], e, ex.fields)
                for e in got
            ]
    return {
        "id": case["id"],
        "code": case["param"],
        "mentions": ms,
        "loadedStages": loaded,
    }


def evaluate_rows(rows: list[dict], tmp_root: Path | None = None) -> dict[str, dict]:
    """Настоящее сравнение API одним вызовом моста на все строки. Временный каталог — 700 (mkdtemp), удаляется сразу."""
    if not rows:
        return {}
    with tempfile.TemporaryDirectory(dir=tmp_root) as tmp:
        src, dst = Path(tmp) / "in.jsonl", Path(tmp) / "out.jsonl"
        src.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", "utf-8"
        )
        subprocess.run(
            ["npx", "tsx", "scripts/w3-eval.ts", str(src), str(dst)],
            cwd=ROOT / "apps/api",
            check=True,
        )
        return {
            r["id"]: r
            for r in (json.loads(x) for x in dst.read_text("utf-8").splitlines() if x)
        }


def run_cases(cases: list[dict], evaluate: Callable | None = None) -> list[dict]:
    """Статус системы для каждого случая: SKIPPED_NO_KIND — вида извлечения или сравнения ещё нет."""
    rows = {c["id"]: case_row(c) for c in cases}
    res = (evaluate or evaluate_rows)([r for r in rows.values() if r is not None])
    out = []
    for c in cases:
        r = res.get(c["id"]) if rows[c["id"]] is not None else None
        out.append(
            {
                "id": c["id"],
                "param": c["param"],
                "expected": c["expected"]["status"],
                "accept": c["expected"].get("accept") or [],
                "adversarial": c.get("adversarial"),
                "why": c.get("why"),
                "status": r["status"] if r else SKIPPED,
                "reason": (r or {}).get("reason"),
            }
        )
    return out


def outcome(r: dict) -> str:
    """Исход случая для счётчиков: tp/fn/abstain_pos — положительный, fp/tn/abstain_neg/accepted_cand — отрицательный."""
    st, pos = r["status"], r["expected"] == "CANDIDATE"
    if st == SKIPPED:
        return "skipped"
    if st in ABSTAIN:
        return "abstain_pos" if pos else "abstain_neg"
    if st == "CANDIDATE":
        if pos:
            return "tp"
        return "accepted_cand" if "CANDIDATE" in r["accept"] else "fp"
    return "fn" if pos else "tn"


def correct(r: dict) -> bool:
    return r["status"] == r["expected"] or r["status"] in r["accept"]


def metrics(c: Counter) -> dict:
    tp, fp, fn, tn = c["tp"], c["fp"], c["fn"], c["tn"]
    ap, an, acc = c["abstain_pos"], c["abstain_neg"], c["accepted_cand"]
    pos, neg = tp + fn + ap, fp + tn + an + acc
    n = pos + neg
    p = tp / (tp + fp) if tp + fp else None
    r = tp / pos if pos else None
    f1 = (
        2 * p * r / (p + r)
        if p and r
        else (0.0 if p is not None and r is not None else None)
    )
    ci = lambda k, m: [round(x, 3) for x in wilson(k, m)] if m else None  # noqa: E731
    return {
        "n": n,
        "n_pos": pos,
        "n_neg": neg,
        "skipped": c["skipped"],
        "fp_violations": fp,
        "correct": c["correct"],
        "accuracy": c["correct"] / n if n else None,
        "accuracy_ci": ci(c["correct"], n),
        "precision": p,
        "precision_ci": ci(tp, tp + fp),
        "recall": r,
        "recall_ci": ci(tp, pos),
        "f1": f1,
        "fpr": fp / neg if neg else None,
        "fpr_ci": ci(fp, neg),
        "abstain": (ap + an) / n if n else None,
        "abstain_ci": ci(ap + an, n),
        "abstain_expected": c["exp_abstain"] / n if n else None,
    }


def score(results: list[dict]) -> dict:
    by: dict[str, Counter] = defaultdict(Counter)
    for r in results:
        o = outcome(r)
        side = "состязательные" if r.get("adversarial") else "базовые"
        for k in (r["param"], "ALL", side):
            by[k][o] += 1
            if o != "skipped":
                by[k]["correct"] += correct(r)
                by[k]["exp_abstain"] += r["expected"] in ABSTAIN
    by.setdefault("ALL", Counter())
    order = sorted(by, key=lambda k: (not k.startswith("M-"), k))
    return {
        "counts": {k: dict(by[k]) for k in order},
        "metrics": {k: metrics(by[k]) for k in order},
        "fp_cases": [r for r in results if outcome(r) == "fp"],
        "wrong": [r for r in results if outcome(r) != "skipped" and not correct(r)],
        "skipped": [r["id"] for r in results if r["status"] == SKIPPED],
    }


def _f(x: float | None) -> str:
    return "—" if x is None else f"{x:.2f}".replace(".", ",")


def _ci(x: list | None) -> str:
    return "" if not x else f" [{_f(x[0])}; {_f(x[1])}]"


def to_md(rep: dict) -> str:
    s = rep["score"]
    out = [
        f"## Отложенный набор W3 — {rep['cases']}",
        "",
        "| Параметр | n | n+ | n− | **FP-нарушения** | Верно | P | R | F1 | FPR | Воздержания | Эталон возд. | SKIPPED |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for k, m in s["metrics"].items():
        out.append(
            f"| {k} | {m['n']} | {m['n_pos']} | {m['n_neg']} | **{m['fp_violations']}** | {_f(m['accuracy'])}{_ci(m['accuracy_ci'])} | {_f(m['precision'])}{_ci(m['precision_ci'])} | {_f(m['recall'])}{_ci(m['recall_ci'])} | {_f(m['f1'])} | {_f(m['fpr'])}{_ci(m['fpr_ci'])} | {_f(m['abstain'])}{_ci(m['abstain_ci'])} | {_f(m['abstain_expected'])} | {m['skipped']} |"
        )
    out += ["", "### Ложные нарушения (цель — 0)", ""]
    out += [
        f"- `{r['id']}` {r['param']}: ожидался {r['expected']}, система CANDIDATE — {(r['reason'] or '')[:220]}"
        for r in s["fp_cases"]
    ] or ["- нет"]
    out += ["", "### Расхождения с ожидаемым", ""]
    out += [
        f"- `{r['id']}` {r['param']}: ожидался {r['expected']}"
        + (f" (или {', '.join(r['accept'])})" if r["accept"] else "")
        + f", система {r['status']} — {(r['reason'] or '')[:220]}"
        for r in s["wrong"]
    ] or ["- нет"]
    if s["skipped"]:
        out += ["", f"SKIPPED_NO_KIND (нет паспорта или вида в реестре): {', '.join(s['skipped'])}"]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default=str(ROOT / "data/holdout/w3/cases.jsonl"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--md")
    a = ap.parse_args(argv)
    results = run_cases(load_cases(Path(a.cases)))
    rep = {"cases": a.cases, "results": results, "score": score(results)}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=1), "utf-8")
    md = to_md(rep)
    if a.md:
        Path(a.md).parent.mkdir(parents=True, exist_ok=True)
        Path(a.md).write_text(md, "utf-8")
    print(md)


if __name__ == "__main__":
    main()
