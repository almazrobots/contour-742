"""Отчёт итерации дообучения из реестра и паспорта набора (T-076): цифры берутся только из артефактов.

python -m teacher.report --model-version ev-1 > ../docs/qa/RETRAIN-ITER-1.md
"""

from __future__ import annotations

import argparse
import json

from inspector_ml.verifier import weights_hash

from .iterate import ART


def pct(x: float | None) -> str:
    return "—" if x is None else f"{x * 100:.1f} %"


def ci(c: list[float]) -> str:
    return f"[{c[0] * 100:.1f}; {c[1] * 100:.1f}]"


def top_weights(
    art: dict, n: int = 8
) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
    pairs = list(zip(["bias", *art["vocab"]], art["weights"]))[1:]
    pairs.sort(key=lambda p: p[1])
    return pairs[:n], pairs[-n:][::-1]


def render(version: str) -> str:
    reg = json.loads((ART / "registry.json").read_text("utf-8"))
    it = next(i for i in reg["iterations"] if i["model_version"] == version)
    pp = json.loads(
        (ART / "datasets" / f"{it['dataset_version']}.json").read_text("utf-8")
    )
    art = json.loads((ART / f"{version}.json").read_text("utf-8"))
    if weights_hash(art) != it["weights_hash"]:  # отчёт не пишется по подменённому артефакту
        raise ValueError(f"артефакт {version}: хеш весов не совпал с реестром")
    m = it["metrics"]
    t, b = m["test"], m["baseline_accept_all"]
    neg, pos = top_weights(art)
    lines = [
        "---",
        f"id: RETRAIN-{version}",
        f'title: "Итерация дообучения {version}: верификатор извлечения"',
        "type: qa-report",
        "status: generated",
        'owner: "@almaz"',
        "traces_to: [OS-INSP-6.4.10, OS-INSP-6.4.11, OS-INSP-6.4.12, OS-INSP-6.4.13, OS-INSP-6.4.14, OS-INSP-6.4.15]",
        "tz: [TZA-7.4-04, TZA-9.4.2-04, TZA-9.4.2-05, TZA-9.4.2-06]",
        "---",
        "",
        f"# Итерация дообучения {version}",
        "",
        "> Сгенерировано `python -m teacher.report` из `ml/artifacts/extract-verifier/` — руками не править.",
        "",
        "## Что обучено",
        "",
        "Ученик — **верификатор извлечения**: по строке источника и извлечённому значению решает, принять значение или "
        "отбросить. Учитель разметки — Claude вне контура (в решении и закрытом контуре не участвует, Q&A #23): "
        "проверил извлечения локального конвейера на объектах пакета организатора. Метки учителя — не экспертное GOLD; "
        "набор выпущен куратором.",
        "",
        "| Поле | Значение |",
        "|---|---|",
        f"| model_version | `{version}` |",
        f"| Алгоритм | `{art['algorithm']}` |",
        f"| Хеш весов (sha256) | `{it['weights_hash']}` |",
        f"| dataset_version | `{it['dataset_version']}` (выпустил: {pp['released_by']}) |",
        f"| Разметчик | {', '.join(it['labeler'] or [])} |",
        f"| matrix_version | `{it['matrix_version']}` |",
        f"| Хеш кода обучения | `{it['training_code_hash'][:16]}…` |",
        f"| Параметры | `{json.dumps(it['params'], ensure_ascii=False)}` |",
        f"| Предыдущая модель | {it['previous_model'] or 'нет — сравнение с базовой «принимать всё»'} |",
        f"| Статус | **{it['status']}** |",
        "",
        "## Набор (разбиение по объектам)",
        "",
        "| Выборка | Объекты | Верных | Ошибочных | sha256 |",
        "|---|---|---|---|---|",
    ]
    for s in ("train", "validation", "test"):
        c = pp["counts"].get(s, {})
        lines.append(
            f"| {s} | {', '.join(pp['objects'][s])} | {c.get('ACCEPT', 0)} | {c.get('REJECT', 0)} | `{pp['split_hashes'][s][:12]}…` |"
        )
    lines += [
        "",
        "Причины ошибок конвейера по меткам учителя: "
        + ", ".join(
            f"{k} — {v}"
            for k, v in sorted(pp["reject_reasons"].items(), key=lambda kv: -kv[1])
        )
        + ".",
        "",
        "## Метрики на test (отложенные объекты) — 95 % ДИ Уилсона",
        "",
        "| Метрика | Базовая «принимать всё» | Верификатор |",
        "|---|---|---|",
        f"| Сохранено верных (Recall) | {pct(b['keep_recall'])} | {pct(t['keep_recall'])} {ci(t['keep_recall_ci95'])} |",
        f"| Пропущено ошибочных (FPR) | {pct(b['fpr'])} | {pct(t['fpr'])} {ci(t['fpr_ci95'])} |",
        f"| Точность принятых | {pct(b['precision'])} | {pct(t['precision'])} |",
        f"| ROC AUC | — | {t['roc_auc'] if t['roc_auc'] is not None else '—'} |",
        f"| n верных / ошибочных | {t['n_correct']} / {t['n_wrong']} | |",
        "",
        f"Порог {art['threshold']:.4f} выбран на validation: сохранить ≥ {it['params']['min_keep'] * 100:.0f} % верных.",
        "",
        "## Ворота ТЗ §9.4",
        "",
        f"Сравнение с: {it['gate']['compared_to']}. Итог: **{'пройдены' if it['gate']['ok'] else 'не пройдены'}**"
        + ("" if it["gate"]["ok"] else " — " + "; ".join(it["gate"]["reasons"]))
        + ".",
        "",
        "## Чему научилась модель (крупнейшие веса)",
        "",
        "Против значения: " + ", ".join(f"`{k}` {w:+.2f}" for k, w in neg) + ".",
        "",
        "За значение: " + ", ".join(f"`{k}` {w:+.2f}" for k, w in pos) + ".",
        "",
        "## Воспроизведение, публикация, откат",
        "",
        "```bash",
        f"scripts/retrain-iter.sh {version}          # тот же набор, те же хеши выборок и весов",
        f"cd ml && .venv/bin/python -m teacher.iterate publish --model-version {version} --approved-by <ответственный>",
        'cd ml && .venv/bin/python -m teacher.iterate rollback --by <ответственный> --reason "…"',
        "```",
        "",
    ]
    return "\n".join(lines)


def main() -> None:  # pragma: no cover
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-version", required=True)
    print(render(ap.parse_args().model_version))


if __name__ == "__main__":  # pragma: no cover
    main()
