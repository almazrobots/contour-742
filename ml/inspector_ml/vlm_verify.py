"""Проверка упоминаний класса локальной VLM по кропу листа (VER-09 каталога TO-BE, T-129).

Главный инвариант — VLM **только понижает** (исследование «мировые подходы», А:12, А:14): без детерминированного
каркаса локальная VLM давала 47 замечаний, из них одно верное. Поэтому судья не создаёт упоминаний, не меняет
прочитанный класс, не повышает уверенность и не снимает отсев правил. Он может:
- отсеять упоминание как соседнее здание или норму (VLM_NEIGHBOR, VLM_NORM) — сравнение его не увидит;
- снизить уверенность, если прочитал другой класс (спор) или ничего не разобрал;
- подтвердить — уверенность при этом не растёт, в метаданных остаётся след «подтверждено».

Сбой модели (тайм-аут, исключение) не ломает разбор: упоминание остаётся как было, в meta — «ошибка судьи».
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from PIL import Image

from .model import Extraction
from .vlm import Judgement

CONFLICT_FACTOR = 0.5  # судья прочитал другой класс: уверенность вдвое ниже, значение — прежнее (решает инспектор)
UNREADABLE_FACTOR = 0.8  # судья ничего не разобрал: слабый сигнал против, не довод
# SEC-03 (OWASP LLM10): документ с тысячами «С0» не должен превращаться в тысячи генераций VLM
MAX_JUDGE_CALLS = 30
WHY = {
    "VLM_NEIGHBOR": "локальная VLM по кропу: класс относится к соседнему зданию, а не к объекту проверки",
    "VLM_NORM": "локальная VLM по кропу: нормативное условие или таблица норм, а не класс объекта",
}


@dataclass(frozen=True)
class Verdict:
    """След судьи в meta упоминания: итог, что прочитано и какой субъект увиден."""

    outcome: str  # confirmed | conflict | unreadable | excluded | error | skipped
    value: str | None
    subject: str | None
    note: str


def apply_judgement(ex: Extraction, j: Judgement) -> Extraction:
    """Новое упоминание по вердикту судьи. Чистая функция: вход не меняется."""
    meta = dict(ex.meta or {})
    # уверенность правил до судьи: API выбирает значение стадии по ней, а не по сниженной судьёй (OWASP LLM01)
    meta.setdefault("confidence_rules", ex.confidence)
    if meta.get("excluded"):
        # отсев правил VLM не снимает — даже если она уверена, что это объект
        meta["vlm"] = Verdict(
            "skipped", j.value, j.subject, "уже отсеяно правилами"
        ).__dict__
        return ex.model_copy(update={"meta": meta})
    conf = ex.confidence
    if j.subject in ("neighbor", "norm"):
        code = "VLM_NEIGHBOR" if j.subject == "neighbor" else "VLM_NORM"
        meta.update(excluded=code, excluded_why=WHY[code])
        v = Verdict("excluded", j.value, j.subject, WHY[code])
    elif j.value is None or j.subject == "unclear":
        conf = round(conf * UNREADABLE_FACTOR, 3)
        v = Verdict(
            "unreadable",
            j.value,
            j.subject,
            "судья не разобрал класс или субъект на кропе",
        )
    elif j.value != ex.value_text:
        conf = round(conf * CONFLICT_FACTOR, 3)
        v = Verdict(
            "conflict",
            j.value,
            j.subject,
            f"судья прочитал {j.value}, извлечено {ex.value_text}",
        )
    else:
        v = Verdict(
            "confirmed",
            j.value,
            j.subject,
            "судья подтвердил класс и то, что он относится к объекту",
        )
    meta["vlm"] = v.__dict__
    meta["ops"] = list(dict.fromkeys([*(meta.get("ops") or []), "VER-09"]))
    return ex.model_copy(update={"meta": meta, "confidence": min(conf, ex.confidence)})


def verify_mentions(
    mentions: list[Extraction],
    crop_of: Callable[[Extraction], Image.Image | None],
    judge: Callable[[Image.Image], Judgement],
    max_calls: int = MAX_JUDGE_CALLS,
    judge_for: Callable[[Extraction, Image.Image], Judgement] | None = None,
) -> list[Extraction]:
    """Прогнать упоминания через судью. Нет кропа или сбой модели — упоминание без изменений и со следом ошибки.
    Сверх max_calls на документ судья не зовётся: упоминание остаётся как есть с пометкой «пропущено» (SEC-03)."""
    out: list[Extraction] = []
    calls = 0
    for ex in mentions:
        if (ex.meta or {}).get("excluded"):
            out.append(
                ex
            )  # отсеянное правилами судье не показываем: экономия и тот же инвариант
            continue
        if calls >= max_calls:
            meta = dict(ex.meta or {})
            meta["vlm"] = Verdict(
                "skipped", None, None, f"предел вызовов судьи на документ ({max_calls})"
            ).__dict__
            out.append(ex.model_copy(update={"meta": meta}))
            continue
        calls += 1
        try:
            crop = crop_of(ex)
            if crop is None:
                raise ValueError("нет растра страницы")
            out.append(apply_judgement(ex, judge_for(ex, crop) if judge_for else judge(crop)))
        except Exception as e:  # noqa: BLE001 — любая ошибка модели не должна ронять разбор
            meta = dict(ex.meta or {})
            meta["vlm"] = Verdict(
                "error", None, None, f"{type(e).__name__}: {str(e)[:160]}"
            ).__dict__
            out.append(ex.model_copy(update={"meta": meta}))
    return out


def mention_box(ex: Extraction) -> tuple[float, float, float, float] | None:
    """Охват якоря и значения — область, которую видит судья."""
    boxes = [b for b in (ex.anchor_bbox, ex.bbox) if b]
    subject = (ex.meta or {}).get("subject_bbox")
    if ex.code == "M-022" and isinstance(subject, (list, tuple)) and len(subject) == 4 and all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in subject) and subject[0] < subject[2] and subject[1] < subject[3]:
        boxes.append(subject)
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )
