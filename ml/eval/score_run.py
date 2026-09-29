"""Прогон табло балла по объектам (OS-INSP-6.5.6, 6.5.7): таблица балла, флаг потолка 59, пропущенные точки.

Для каждого object_id эталона ищет ответ `<object_id>.json` в каталоге ответов и считает `submission.score`.
Нет ответа — строка «ответа нет», балл 0, все критические точки объекта пропущены. Ответ не по схеме — так же,
с причиной. Компонент «целостность и части» берётся из `--integrity` (object_id → доля, OS-INSP-6.5.12);
не передан — не измерен и в балл не входит (`submission.score`).

Шкала 60/15/15/10 — архивная (пакет 02). Официальный рейтинг — 40 баллов экспертов и питча (Q&A 16.09):
табло нужно для тай-брейка и контроля выгрузки, а не для места в рейтинге.

    uv run python -m eval.score_run --gold checks.jsonl --submissions ../var/submissions \\
        [--integrity integrity.json] --md ../docs/qa/SCORE-ORGANIZER.md
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .submission import CRITICAL_CAP, POSITIVE, SubmissionError, score

NO_ANSWER = "ответа нет"
COMPONENTS = [
    ("finding_detection_f1", "F1"),
    ("source_localization_exact_file_page", "Локализация"),
    ("normalized_value_and_status_accuracy", "Значения/статусы"),
    ("document_integrity_and_split_handling", "Целостность"),
]


def critical_points(gold: list[dict]) -> list[str]:
    """Критические контрольные точки объекта — те же, что считает `submission.score`."""
    return sorted(
        g.get("check_id", "?")
        for g in gold
        if g.get("score_eligible")
        and g.get("violation_label") == POSITIVE
        and g.get("protocol_status") == "CRITICAL"
    )


def _zero(oid: str, gold: list[dict], note: str) -> dict:
    return {
        "object_id": oid,
        "note": note,
        "components": {k: None for k, _ in COMPONENTS},
        "uncapped": 0.0,
        "total": 0.0,
        "capped": False,
        "critical_missed": critical_points(gold),
    }


def build_rows(
    gold: list[dict],
    submissions: dict[str, dict],
    integrity: dict[str, float | None] | None = None,
) -> list[dict]:
    """Строка табло на каждый object_id эталона, в порядке первого появления объекта в эталоне."""
    by_obj: dict[str, list[dict]] = {}
    for x in gold:
        by_obj.setdefault(x["object_id"], []).append(x)
    rows = []
    for oid, checks in by_obj.items():
        sub = submissions.get(oid)
        if sub is None:
            rows.append(_zero(oid, checks, NO_ANSWER))
            continue
        try:
            s = score(sub, checks, (integrity or {}).get(oid))
        except SubmissionError as e:
            rows.append(_zero(oid, checks, f"ответ не по схеме: {e}"))
            continue
        rows.append(
            {
                "object_id": oid,
                "note": "",
                **{
                    k: s[k]
                    for k in (
                        "components",
                        "uncapped",
                        "total",
                        "capped",
                        "critical_missed",
                    )
                },
            }
        )
    return rows


def _f(x) -> str:
    return "—" if x is None else f"{x:.3f}".replace(".", ",")


def _p(x: float) -> str:
    return f"{x:.2f}".replace(".", ",")


def _mean(xs: list) -> float | None:
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def to_markdown(rows: list[dict], generated: str = "") -> str:
    heads = (
        ["Объект"]
        + [t for _, t in COMPONENTS]
        + ["Балл без потолка", "Балл", "Потолок 59", "Пропущенные критические точки"]
    )
    L = [
        "---",
        "id: QA-SCORE-ORGANIZER",
        'title: "Табло балла организатора по объектам"',
        "type: qa-report",
        "status: draft",
        'owner: "@almaz"',
        f"created: {generated}",
        "traces_to: [OS-INSP-6.5.6, OS-INSP-6.5.7, OS-INSP-6.5.12]",
        "tags: [qa, scoring, organizer]",
        "---",
        "",
        "# Табло балла организатора по объектам",
        "",
        "> **Шкала 60/15/15/10 — архивная** (пакет 02). Официальный рейтинг — 40 баллов экспертов и питча "
        "(Q&A организатора 16.09); F1 и табло — для тай-брейка и контроля выгрузки, а не место в рейтинге.",
        "",
        f"- Объектов: **{len(rows)}**, с ответом: {sum(1 for r in rows if not r['note'])}; "
        f"с потолком 59: {sum(1 for r in rows if r['capped'])}.",
        f"- Потолок {CRITICAL_CAP}: пропущена хотя бы одна критическая контрольная точка эталона (OS-INSP-6.5.7). "
        "Нет ответа по объекту — балл 0, все его критические точки пропущены.",
        "- Целостность «—» — компонент не измерен и в балл не входит (максимум тогда 90, OS-INSP-6.5.12).",
        "",
        "| " + " | ".join(heads) + " |",
        "|---" * len(heads) + "|",
    ]
    for r in rows:
        comps = [_f(r["components"][k]) for k, _ in COMPONENTS]
        if r["note"]:
            comps[0] = r["note"]
        L.append(
            f"| {r['object_id']} | "
            + " | ".join(comps)
            + f" | {_p(r['uncapped'])} | {_p(r['total'])} | {'да' if r['capped'] else 'нет'} | "
            + (", ".join(r["critical_missed"]) or "—")
            + " |"
        )
    if rows:
        means = [_f(_mean([r["components"][k] for r in rows])) for k, _ in COMPONENTS]
        L.append(
            "| Среднее | "
            + " | ".join(means)
            + f" | {_p(_mean([r['uncapped'] for r in rows]))} | {_p(_mean([r['total'] for r in rows]))} | "
            + f"{sum(1 for r in rows if r['capped'])} из {len(rows)} | {sum(len(r['critical_missed']) for r in rows)} |"
        )
    L += [
        "",
        "Средние компонентов — по объектам с ответом; средний балл — по всем объектам эталона, объект без ответа даёт 0.",
        "",
    ]
    return "\n".join(L)


def load_gold(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text("utf-8").splitlines() if ln.strip()]


def load_submissions(folder: Path, object_ids: set[str]) -> dict[str, dict]:
    out = {}
    for oid in object_ids:
        p = folder / f"{oid}.json"
        if p.exists():
            out[oid] = json.loads(p.read_text("utf-8"))
    return out


def main(argv: list[str] | None = None) -> list[dict]:
    ap = argparse.ArgumentParser(
        description="Табло балла организатора по объектам (OS-INSP-6.5.6, 6.5.7)"
    )
    ap.add_argument("--gold", type=Path, required=True, help="jsonl эталонных проверок")
    ap.add_argument(
        "--submissions",
        type=Path,
        required=True,
        help="каталог ответов <object_id>.json",
    )
    ap.add_argument(
        "--integrity",
        type=Path,
        default=None,
        help="json object_id → доля целостности (OS-INSP-6.5.12)",
    )
    ap.add_argument(
        "--md", type=Path, required=True, help="куда положить markdown-отчёт"
    )
    a = ap.parse_args(argv)
    gold = load_gold(a.gold)
    subs = load_submissions(a.submissions, {x["object_id"] for x in gold})
    integ = json.loads(a.integrity.read_text("utf-8")) if a.integrity else None
    rows = build_rows(gold, subs, integ)
    a.md.parent.mkdir(parents=True, exist_ok=True)
    a.md.write_text(to_markdown(rows, time.strftime("%Y-%m-%d")), encoding="utf-8")
    print(
        f"объектов {len(rows)}; с потолком {sum(r['capped'] for r in rows)}; → {a.md}"
    )
    return rows


if __name__ == "__main__":
    main()
