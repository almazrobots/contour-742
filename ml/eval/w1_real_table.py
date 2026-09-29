"""Таблица качества W1 (T-180, OS-INSP-6.5.52): мутации T-179 и реальные объекты в одной строке «параметр × оператор».

Вход — только агрегаты: отчёт стенда мутаций (`ml/var/mutations/full/report.json`, синтетика) и агрегаты объектов
(`ml/var/w1-real/<объект>.json`, прошли `assert_aggregate`). Где эталона нет — так и пишется, а не цифры.
"""

from __future__ import annotations

from eval import w1_real_score as S


def num(x: float | None) -> str:
    return "—" if x is None else f"{x:.2f}".replace(".", ",")


def with_ci(c: dict, k: str) -> str:
    v, ci = c.get(k), c.get(k + "_ci")
    if v is None:
        return "—"
    return f"{num(v)} [{num(ci[0])}; {num(ci[1])}]" if ci else num(v)


def mut_cells(mut: dict | None, key: str, pending: set[str]) -> list[str]:
    s = (mut or {}).get("slices", {}).get(key)
    if s is None:
        state = "ждёт оператора" if key in pending else "нет пары"
        return [state, "", "", "", "", ""]
    return [
        f"{s['n_pos']} / {s['n_neg']}",
        with_ci(s, "precision"),
        with_ci(s, "recall"),
        with_ci(s, "f1"),
        with_ci(s, "fpr"),
        with_ci(s, "abstention"),
    ]


def source_note(sources: dict, param: str) -> str:
    rows = sources.get("params", {}).get(param, [])
    if not rows:
        return "нет — ручная разметка"
    q = {
        "final": "окончат.",
        "second_review": "ждёт 2-й проверки",
        "candidate": "кандидаты",
    }
    return "; ".join(
        f"{r['source']}: {', '.join(r['objects'])} ({q[r['quality']]}"
        + (f", +{r['pos']}/−{r['neg']}" if r.get("pos") or r.get("neg") else "")
        + (f", канд. {r['candidates']}" if r.get("candidates") else "")
        + ")"
        for r in rows
    )


def real_cells(c: dict | None, attributed: bool) -> list[str]:
    if c is None:
        return [
            "не прогонялся" if attributed else "статус у другого оператора",
            "",
            "",
            "",
            "",
        ]
    labeled = c["n_pos"] + c["n_neg"] + c["n_other"]
    if not labeled:
        seen = ", ".join(f"{k} {n}" for k, n in c["pred_unlabeled"].items())
        return [f"нет эталона (групп {c['n_unlabeled']}: {seen})", "", "", "", ""]
    return [
        f"{labeled} (+{c['n_pos']}/−{c['n_neg']}), объектов {len(c['objects_labeled'])}",
        with_ci(c, "precision"),
        with_ci(c, "recall"),
        with_ci(c, "fpr"),
        with_ci(c, "abstention"),
    ]


def render(
    aggs: list[dict],
    mut: dict | None,
    wave: dict,
    sources: dict,
    attr: dict[str, str],
    b: int = 1000,
) -> str:
    real = (
        S.merge_aggregates(aggs, b)
        if aggs
        else {"pairs": {}, "operators": {}, "all": None}
    )
    pending = (
        {f"pair:{k}" for k in (mut or {}).get("pending", {})}
        if isinstance((mut or {}).get("pending"), dict)
        else set()
    )
    head = [
        "---",
        "id: QA-W1-QUALITY",
        'title: "Таблица качества W1: мутации (T-179) и реальные объекты (T-180)"',
        "owner: CTO (сессия T-171)",
        "task: T-180",
        "traces: [OS-INSP-6.5.10, OS-INSP-6.5.50, OS-INSP-6.5.51, OS-INSP-6.5.52, OS-INSP-6.5.53, OS-INSP-6.5.54]",
        "generated: ml/eval/w1_real.py table",
        "---",
        "",
        "# Таблица качества W1",
        "",
        "Строка — пара «параметр × оператор» реестра W1 (`data/seed/w1-wave.json`). Мутации — стенд T-179 (синтетика,",
        "интервалы Уилсона, F1 — бутстрэп по примерам). Реальные объекты — стенд T-180 на корпусе «Хакатон» (раннер,",
        "разбор из кэша r4, путь прода: серверный импорт → ML /analyze → паспортные операторы API, без судьи VLM).",
        "Интервал реальных — Уилсон на одном объекте с метками, бутстрэп по объектам на нескольких (OS-INSP-6.5.10);",
        "F1 на одном объекте интервала не получает. Воздержание — MISSING_EVIDENCE, NOT_COMPARABLE, CLARIFICATION_REQUIRED",
        "(и нет строки проверки) на группе с известной меткой. «Нет эталона» — группа посчитана, метки нет: в P/R/FPR не",
        "входит. Источник эталона — `ml/eval/w1_real_sources.json`, метки — только на раннере (ADR-0002).",
        "",
    ]
    if mut:
        head += [
            f"Мутации: `{mut.get('dataset_version')}`, разбор r{mut.get('parser_rev')}, извлечение r{mut.get('extract_rev')}.",
            "",
        ]
    else:
        head += ["Мутации: отчёт стенда T-179 не подан — колонки мутаций пусты.", ""]
    if aggs:
        head += [
            "## Прогоны на объектах",
            "",
            "| Объект | Утверждение | Файлов (с r4 / всего) | Не прогнан (память) | Принято | Отказов | Время, с | Пик памяти, МБ | Разбор / извлечение | Коммит |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for a in aggs:
            c, t = a["counts"], a["timing"]
            head.append(
                f"| {a['object_id']} | {'оператор' if a['approval'] else 'нет'} | {c['cached_r4']} / {c['cached_r4'] + c['without_r4']} | {c.get('skipped_memory', 0)} | {c['accepted']} | {c['rejected']} "
                f"| {t['total_s']} | {t['peak_rss_mb']} | r{a['parser_rev']} / r{a['extract_rev']} | {a['git_sha']} |"
            )
        head.append("")
    L = head + [
        "## Пары «параметр × оператор»",
        "",
        "| Код | Оператор | Мут.: n+ / n− | P | R | F1 | FPR | Возд. | Реальные: n | P | R | FPR | Возд. | Эталон на объектах |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for param, op in S.w1_pairs(wave):
        key = f"{param}×{op}"
        L.append(
            "| "
            + " | ".join(
                [
                    param,
                    op,
                    *mut_cells(mut, f"pair:{key}", pending),
                    *real_cells(real["pairs"].get(key), attr.get(param) == op),
                    source_note(sources, param),
                ]
            )
            + " |"
        )
    ops = sorted({op for _, op in S.w1_pairs(wave)})
    L += [
        "",
        "## Сводка по оператору",
        "",
        "| Оператор | Мут.: n+ / n− | P | R | F1 | FPR | Возд. | Реальные: n | P | R | FPR | Возд. |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for op in ops:
        L.append(
            "| "
            + " | ".join(
                [
                    op,
                    *mut_cells(mut, f"op:{op}", set()),
                    *real_cells(real["operators"].get(op), True),
                ]
            )
            + " |"
        )
    if real.get("all"):
        L += [
            "",
            "Всего на объектах: "
            + " · ".join(real_cells(real["all"], True)).strip(" ·"),
            "",
        ]
    counts = {"final": 0, "open": 0, "none": 0}
    for p in wave["params"]:
        rows = sources.get("params", {}).get(p["code"], [])
        counts[
            "final"
            if any(r["quality"] == "final" for r in rows)
            else ("open" if rows else "none")
        ] += 1
    L += [
        "",
        "## Эталон по 47 параметрам",
        "",
        f"Окончательная метка хотя бы на одном объекте — {counts['final']}; метки есть, но не окончательные — {counts['open']};",
        f"источника нет, нужна ручная разметка (OS-INSP-6.5.54) — {counts['none']}.",
        "",
    ]
    return "\n".join(L) + "\n"
