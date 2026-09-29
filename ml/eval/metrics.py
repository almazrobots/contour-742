"""Приёмочные метрики ТЗ §14 и 9.1.1 (OS-INSP-6.5.1).

Все метрики — отношения сумм счётчиков, а не средние по объектам: так их можно складывать
по объектам и ресэмплировать объектами в бутстрапе (eval/ci.py). Счётчики одного объекта — Counter.

Нормализация текста (ТЗ 9.1.1): Unicode NFC и схлопывание повторных пробелов; знаки не удаляются,
регистр в CER/WER учитывается. Нормализация ключевых полей — по типу поля, см. FIELD_POLICY.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Sequence

from rapidfuzz.distance import Levenshtein

BBox = Sequence[float]

IOU_MIN = 0.50  # ТЗ §14: локализация засчитывается при IoU ≥ 0,50

# ─────────────────────────────────────────────── текст: CER, WER, Character Accuracy


def norm_text(s: str) -> str:
    """NFC + все пробельные последовательности → один пробел. Знаки и регистр не трогаются."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s or "")).strip()


def char_errors(ref: str, hyp: str) -> tuple[int, int]:
    """(расстояние Левенштейна, число символов эталона) после нормализации."""
    r, h = norm_text(ref), norm_text(hyp)
    return Levenshtein.distance(r, h), len(r)


def word_errors(ref: str, hyp: str) -> tuple[int, int]:
    r, h = norm_text(ref).split(" "), norm_text(hyp).split(" ")
    r = [w for w in r if w]
    h = [w for w in h if w]
    return Levenshtein.distance(r, h), len(r)


def cer(ref: str, hyp: str) -> float:
    d, n = char_errors(ref, hyp)
    return d / n if n else float("nan")


def wer(ref: str, hyp: str) -> float:
    d, n = word_errors(ref, hyp)
    return d / n if n else float("nan")


def character_accuracy(pairs: Iterable[tuple[str, str]]) -> float:
    """CA = 1 − ΣLevenshtein / Σсимволов эталона (ТЗ 9.1.1). Может быть < 0 при мусорном выходе."""
    dist = chars = 0
    for ref, hyp in pairs:
        d, n = char_errors(ref, hyp)
        dist, chars = dist + d, chars + n
    return 1 - dist / chars if chars else float("nan")


# ─────────────────────────────────────────────── ключевые поля: Exact Match

# Визуально неразличимые кириллица/латиница: на листе разницы нет, OCR её не видит.
_HOMO = str.maketrans("ABCEHKMOPTXaceopxy", "АВСЕНКМОРТХасеорху")


def _code(s: str) -> str:
    # шифр: знаки («-», «.», «/») сохраняются, пробелы вокруг дефиса и точки — нет; регистр значим
    s = norm_text(s).translate(_HOMO)
    return re.sub(r"\s*([-./])\s*", r"\1", s)


def _stage(s: str) -> str:
    # стадия: регистр не несёт смысла; латинские коды реестра (PD/RD/ID) = русские (П/Р/ИД)
    s = norm_text(s).upper()
    s = {"PD": "П", "RD": "Р", "ID": "ИД"}.get(s, s)
    return s.translate(_HOMO)


def _revision(s: str) -> str:
    # редакция: «B», «2», «1.1» — знаки и регистр значимы; «Ред. B» → «B» делает экстрактор
    return norm_text(s).translate(_HOMO)


def _int(s: str) -> str:
    m = re.search(r"\d+", s or "")
    return str(int(m.group(0))) if m else norm_text(s)


def _room(s: str) -> str:
    # номер помещения/элемента: точки значимы, регистр — нет («1.18а» = «1.18А»)
    return norm_text(s).upper().translate(_HOMO).replace(" ", "")


FIELD_POLICY: dict[str, Callable[[str], str]] = {
    "code": _code,
    "stage": _stage,
    "revision": _revision,
    "sheet": _int,
    "room": _room,
}


def norm_field(kind: str, value: str | None) -> str | None:
    if value is None:
        return None
    return FIELD_POLICY.get(kind, norm_text)(str(value))


def exact_match(kind: str, gold: str, pred: str | None) -> bool:
    return pred is not None and norm_field(kind, gold) == norm_field(kind, pred)


# ─────────────────────────────────────────────── геометрия


def iou(a: BBox | None, b: BBox | None) -> float:
    if not a or not b:
        return 0.0
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def evidence_localized(
    gold: list[dict], pred: list[dict], thr: float = IOU_MIN
) -> bool:
    """Каждый эталонный фрагмент найден: тот же file_id, та же страница, IoU ≥ thr.

    «Без полного доказательства finding не засчитывается» (§14) — нужно покрыть все фрагменты.
    """
    if not gold:
        return False
    for g in gold:
        if not any(
            p.get("file_id") == g["file_id"]
            and int(p.get("page") or -1) == int(g["page"])
            and iou(p.get("bbox"), g.get("bbox")) >= thr
            for p in pred
        ):
            return False
    return True


# ─────────────────────────────────────────────── находки: P/R/F1, FPR

POSITIVE = {"CANDIDATE", "CONFIRMED_VIOLATION"}
NEGATIVE = {"NEGATIVE_VERIFIED"}


def match_findings(
    gold_groups: list[dict], pred_groups: list[dict]
) -> dict[str, Counter]:
    """Сопоставляет находки с эталоном по evidence_group → счётчики по object_id.

    Ключ группы — (object_id, param). Истинно-положительная — система выдала CANDIDATE по
    положительной группе с правильным параметром и полным доказательством (evidence_localized).
    CANDIDATE с неверным доказательством — одновременно FP и FN. Лишний CANDIDATE по параметру
    вне эталона — FP. FP на отрицательной группе (NEGATIVE_VERIFIED, в т.ч. «ловушка» устаревшей
    редакции) идёт ещё и в FPR.
    """
    out: dict[str, Counter] = {}
    gold_by = {(g["object_id"], g["param"]): g for g in gold_groups}
    pred_by = {(p["object_id"], p["param"]): p for p in pred_groups}
    for key, g in gold_by.items():
        c = out.setdefault(key[0], Counter())
        p = pred_by.get(key)
        said_pos = p is not None and p.get("status") in POSITIVE
        if g["label"] in POSITIVE:
            ok = said_pos and evidence_localized(
                g.get("evidence", []), p.get("evidence", [])
            )
            c["tp"] += ok
            c["fn"] += not ok
            c["fp"] += said_pos and not ok
        elif g["label"] in NEGATIVE:
            c["neg_n"] += 1
            c["neg_fp"] += said_pos
            c["fp"] += said_pos
            if g.get("superseded_trap"):
                c["trap_n"] += 1
                c["trap_fp"] += said_pos
        else:
            # MISSING_EVIDENCE, CLARIFICATION_REQUIRED, NOT_APPLICABLE: вне P/R, но статус проверяем
            c["other_n"] += 1
            c["other_ok"] += p is not None and p.get("status") == g["label"]
            c["fp"] += said_pos
    for key, p in pred_by.items():
        if key not in gold_by and p.get("status") in POSITIVE:
            out.setdefault(key[0], Counter())["fp"] += 1
    return out


def ratio(num: float, den: float) -> float:
    return num / den if den else float("nan")


def prf(tp: float, fp: float, fn: float) -> tuple[float, float, float]:
    p, r = ratio(tp, tp + fp), ratio(tp, tp + fn)
    f = ratio(
        2 * tp, 2 * tp + fp + fn
    )  # = 2PR/(P+R), но определена и при P или R без знаменателя
    return p, r, f


def fpr(fp: float, n_neg: float) -> float:
    """FPR = FP / (FP + TN) на отрицательных группах; FP + TN = число отрицательных групп."""
    return ratio(fp, n_neg)


# ─────────────────────────────────────────────── реестр метрик: значение и размер выборки из счётчиков


def _f1(c: Counter) -> float:
    return prf(c["tp"], c["fp"], c["fn"])[2]


def _text_metrics(p: str, suffix: str) -> dict[str, dict]:
    """CA, CER, WER и coverage по пулу страниц с префиксом счётчиков p."""
    cov = lambda c: ratio(c[f"{p}_answered"], c[f"{p}_pages"])
    return {
        f"character_accuracy{suffix}": {"value": lambda c: 1 - ratio(c[f"{p}_err"], c[f"{p}_chars"]), "n": lambda c: c[f"{p}_chars"], "unit": "символ", "cov": cov},
        f"cer{suffix}": {"value": lambda c: ratio(c[f"{p}_err"], c[f"{p}_chars"]), "n": lambda c: c[f"{p}_chars"], "unit": "символ", "cov": cov},
        f"wer{suffix}": {"value": lambda c: ratio(c[f"{p}_werr"], c[f"{p}_words"]), "n": lambda c: c[f"{p}_words"], "unit": "слово", "cov": cov},
    }


METRICS: dict[str, dict] = {
    # имя: value(c), n(c) — размер выборки, cov(c) — coverage (доля эталонных единиц с ответом системы)
    # OCR по условию ТЗ 9.1.1: печатный текст, скан ≥ 300 dpi (счётчики ocr_*); справочно — все сканы
    # (scan_*) и все страницы вместе с текстовым слоем (all_*)
    **_text_metrics("ocr", ""),
    **_text_metrics("scan", "_scans_all_dpi"),
    **_text_metrics("all", "_all_pages"),
    "exact_match": {
        "value": lambda c: ratio(c["em_ok"], c["em_n"]),
        "n": lambda c: c["em_n"],
        "unit": "поле",
        "cov": lambda c: ratio(c["em_answered"], c["em_n"]),
    },
    "linkage": {
        "value": lambda c: ratio(c["link_ok"], c["link_n"]),
        "n": lambda c: c["link_n"],
        "unit": "группа",
        "cov": lambda c: ratio(c["link_answered"], c["link_n"]),
    },
    "localization": {
        "value": lambda c: ratio(c["loc_ok"], c["loc_n"]),
        "n": lambda c: c["loc_n"],
        "unit": "группа",
        "cov": lambda c: ratio(c["loc_answered"], c["loc_n"]),
    },
    "precision": {
        "value": lambda c: prf(c["tp"], c["fp"], c["fn"])[0],
        "n": lambda c: c["tp"] + c["fp"],
        "unit": "находка",
        "cov": lambda c: float("nan"),
    },
    "recall": {
        "value": lambda c: prf(c["tp"], c["fp"], c["fn"])[1],
        "n": lambda c: c["tp"] + c["fn"],
        "unit": "группа",
        "cov": lambda c: float("nan"),
    },
    "f1": {
        "value": _f1,
        "n": lambda c: c["tp"] + c["fp"] + c["fn"],
        "unit": "группа",
        "cov": lambda c: float("nan"),
    },
    "fpr": {
        "value": lambda c: fpr(c["neg_fp"], c["neg_n"]),
        "n": lambda c: c["neg_n"],
        "unit": "группа",
        "cov": lambda c: float("nan"),
    },
    "fpr_superseded": {
        "value": lambda c: fpr(c["trap_fp"], c["trap_n"]),
        "n": lambda c: c["trap_n"],
        "unit": "группа",
        "cov": lambda c: float("nan"),
    },
    "other_status_accuracy": {
        "value": lambda c: ratio(c["other_ok"], c["other_n"]),
        "n": lambda c: c["other_n"],
        "unit": "группа",
        "cov": lambda c: float("nan"),
    },
    "low_quality_share": {
        "value": lambda c: ratio(c["all_low"], c["all_pages"]),
        "n": lambda c: c["all_pages"],
        "unit": "страница",
        "cov": lambda c: float("nan"),
    },
}


def total(per_object: dict[str, Counter]) -> Counter:
    s: Counter = Counter()
    for c in per_object.values():
        s.update(c)
    return s


def metric_value(name: str, per_object: dict[str, Counter]) -> float:
    return METRICS[name]["value"](total(per_object))
