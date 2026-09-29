"""Метки учителя и выпуск набора (T-076, OS-INSP-6.4.10–6.4.11).

Метка учителя — строка `var/teacher/labels.jsonl`:
    {item_id, label: ACCEPT|REJECT, reason: код из verifier.REASONS (только у REJECT), correct_value, rationale,
     labeler, line_sha256}
Метка учителя — не экспертное GOLD: в набор её переводит только выпуск куратора (`release`, released_by).
Разбиение — по объектам: объект целиком в одной выборке; test — отложенные объекты, названные явно.
"""

from __future__ import annotations

import hashlib
import json

from inspector_ml.verifier import REASONS

LABELS = ("ACCEPT", "REJECT")


class LabelError(ValueError):
    pass


def validate(label: dict, item: dict | None) -> None:
    """Метка годна, если относится к строке очереди, код причины — из справочника и есть обоснование."""
    if item is None:
        raise LabelError(f"{label.get('item_id')}: нет такой строки очереди")
    if label.get("label") not in LABELS:
        raise LabelError(
            f"{label['item_id']}: метка {label.get('label')!r} не из {LABELS}"
        )
    reason = label.get("reason")
    if label["label"] == "REJECT" and reason not in REASONS:
        raise LabelError(
            f"{label['item_id']}: у REJECT причина из справочника, а не {reason!r}"
        )
    if label["label"] == "ACCEPT" and reason is not None:
        raise LabelError(f"{label['item_id']}: у ACCEPT причины нет")
    if not (label.get("rationale") or "").strip():
        raise LabelError(f"{label['item_id']}: нет обоснования")
    if not (label.get("labeler") or "").strip():
        raise LabelError(f"{label['item_id']}: не указан разметчик")
    if label.get("line_sha256") != item["line_sha256"]:
        raise LabelError(
            f"{label['item_id']}: метка к другой строке источника (хеш строки не совпал)"
        )


def split_of(obj: str, holdout: set[str], validation_share: float = 0.2) -> str:
    """test — отложенные объекты; прочие — validation или train по хешу имени объекта (без случайности)."""
    if obj in holdout:
        return "test"
    h = int(hashlib.sha256(obj.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "validation" if h < validation_share else "train"


def _hash_ids(ids: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest()


def release(
    queue: list[dict],
    labels: list[dict],
    holdout: set[str],
    released_by: str,
    validation: set[str] | None = None, sealed: frozenset[str] = frozenset()) -> dict:
    """Выпуск набора куратором: только проверенные метки; объект — целиком в одной выборке; хеши выборок и версия."""
    if not released_by.strip():
        raise LabelError("набор выпускает куратор: released_by обязателен")
    leaked = sorted({q["file_sha256"][:12] for q in queue if q["file_sha256"] in sealed})
    if leaked:  # OS-INSP-6.1.8: файл скрытого теста в наборе — отказ, а не молчаливый отсев
        raise LabelError(f"в очереди файлы из печати скрытого теста: {', '.join(leaked)}")
    by_id = {q["item_id"]: q for q in queue}
    latest: dict[str, dict] = {}
    for lab in (
        labels
    ):  # повторная метка той же строки заменяет прежнюю (учитель исправил себя)
        validate(lab, by_id.get(lab["item_id"]))
        latest[lab["item_id"]] = lab
    # OS-INSP-6.4.16 (OWASP T179-4): синтетика (метки стенда мутаций T-179) — только train; в test и validation её не
    # выпускают: метрики модели считаются на реальных документах
    synth_named = sorted({q["object"] for q in queue if q.get("synthetic") and (q["object"] in holdout or (validation and q["object"] in validation))})
    if synth_named:
        raise LabelError(f"синтетический объект в отложенной выборке: {', '.join(synth_named[:5])}")
    items = []
    for iid in sorted(latest):
        q, lab = by_id[iid], latest[iid]
        split = (
            "train"
            if q.get("synthetic")
            else "validation"
            if validation and q["object"] in validation
            else split_of(q["object"], holdout)
        )
        items.append(
            q
            | {
                "label": lab["label"],
                "reason": lab.get("reason"),
                "correct_value": lab.get("correct_value"),
                "labeler": lab["labeler"],
                "split": split,
                "section": q.get("section") or q.get("code"),
            }
        )
    objs = {
        s: sorted({it["object"] for it in items if it["split"] == s})
        for s in ("train", "validation", "test")
    }
    for s, o in objs.items():
        for t, p in objs.items():
            if s < t and set(o) & set(p):
                raise LabelError(f"объект в двух выборках: {set(o) & set(p)}")
    split_hashes = {
        s: _hash_ids([it["item_id"] for it in items if it["split"] == s]) for s in objs
    }
    content = _hash_ids(
        [f"{it['item_id']}:{it['label']}:{it['split']}" for it in items]
    )
    return {
        "dataset_version": f"teacher-{content[:12]}",
        "released_by": released_by,
        "split_hashes": split_hashes,
        "objects": objs,
        "labelers": sorted({it["labeler"] for it in items}),
        "items": items,
    }


SFT_SYSTEM = (
    "Ты проверяешь значение, извлечённое из проектной документации для параметра Матрицы контроля. "
    'Ответь JSON: {"verdict": "ACCEPT"|"REJECT", "reason": код или null, "value": верное значение или null}.'
)


def sft_record(item: dict) -> dict:
    """Строка SFT-корпуса для LoRA судьи на GPU-стенде: вопрос — строка и значение, ответ — вердикт учителя."""
    user = (
        f"Параметр {item['code']} «{item.get('parameter_name')}», ед. {item.get('unit')}.\n"
        f"Строка источника (стр. {item['page']}): {item['line_text']}\n"
        f"Извлечено: {item['raw']}"
    )
    answer = {
        "verdict": item["label"],
        "reason": item.get("reason"),
        "value": item.get("correct_value"),
    }
    return {
        "messages": [
            {"role": "system", "content": SFT_SYSTEM},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False)},
        ],
        "meta": {
            "item_id": item["item_id"],
            "split": item["split"],
            "labeler": item["labeler"],
        },
    }
