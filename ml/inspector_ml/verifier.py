"""Верификатор извлечения — ученик учителя разметки (T-076, OS-INSP-6.4.12–6.4.15).

Задача: по извлечённому значению (строка источника, место значения в строке, параметр Матрицы, уверенность)
оценить вероятность, что значение взято верно. Учитель (Claude вне контура, OS-INSP-6.4.10) размечает очередь
ACCEPT/REJECT; модель — L2-логистическая регрессия (метод Ньютона, без случайности) на разреженных признаках,
словарь признаков — только из train, калибровка Платта и порог — на validation, метрики — только на test.

Порог выбирается так, чтобы верификатор сохранял не меньше `min_keep` верных извлечений validation: базовая
модель «принимать всё» сохраняет 100 %, ворота ТЗ §9.4 не дают уронить Recall больше чем на 2 п.п.

Чистые функции; реестр и файлы артефакта — `inspector_ml/verifier_registry.py`.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field

import numpy as np

from .normalize import fold

ALGORITHM = "extract-verifier/logreg-l2-newton+platt/1"
FEATURE_REV = 2  # 2: слова и триграммы строки — хешами, текст документов в артефакт не попадает
REASONS = (
    "WRONG_PARAM",  # строка о другом показателе
    "WRONG_VALUE",  # в строке нужный показатель, но взято не то число: номер пункта, «в том числе», год, соседняя колонка
    "NOT_A_VALUE",  # норматив, требование, заголовок, ссылка — не значение объекта
    "PARTIAL_VALUE",  # значение обрезано или склеено
    "UNIT_MISMATCH",  # число верное, единица другая (тыс. м², %, мм вместо м)
    "OCR_ERROR",  # искажено распознаванием
)
_WORD = re.compile(r"[a-zа-я]+|\d+", re.I)
_YEAR = re.compile(r"^(19|20)\d\d$")


def _words(s: str) -> list[str]:
    return _WORD.findall(fold(s))


def _value_span(item: dict) -> tuple[int, int]:
    line, raw = item.get("line_text") or "", item.get("raw") or ""
    i = line.rfind(raw) if raw else -1
    return (i, i + len(raw)) if i >= 0 else (len(line), len(line))


def _tok(kind: str, text: str) -> str:
    """Текстовый признак — хешем: веса лежат в git, а слова документов туда попадать не должны (ADR-0002)."""
    return f"{kind}#{hashlib.sha256(text.encode()).hexdigest()[:10]}"


def features(item: dict) -> dict[str, float]:
    """Признаки извлечения. Метка, объект и путь файла в признаки не входят."""
    f: dict[str, float] = {}
    code, dt = item.get("code") or "?", item.get("data_type") or "?"
    f[f"code={code}"] = 1.0
    f[f"dt={dt}"] = 1.0
    f[f"src={item.get('page_source') or 'text'}"] = 1.0
    f[f"match={item.get('match') or 'lexical'}"] = 1.0
    f["confidence"] = float(item.get("confidence") or 0.0)
    f["similarity"] = float(item.get("similarity") or 0.0)
    raw = (item.get("raw") or "").strip()
    v = item.get("value_num")
    if v is not None:
        f["log_abs_value"] = math.log1p(abs(float(v)))
        f["value_zero"] = 1.0 if float(v) == 0 else 0.0
        f["value_year"] = 1.0 if _YEAR.match(raw) else 0.0
        f["value_int"] = 1.0 if float(v).is_integer() else 0.0
    f["raw_digits"] = 1.0 if any(ch.isdigit() for ch in raw) else 0.0
    f["raw_len_log"] = math.log1p(len(raw))
    line = item.get("line_text") or ""
    s, e = _value_span(item)
    left, right = line[:s], line[e:]
    f["line_len_log"] = math.log1p(len(line))
    f["value_at_end"] = 1.0 if not right.strip(" .;,)") else 0.0
    f["numbers_left"] = float(len(re.findall(r"\d+(?:[.,]\d+)?", left)))
    f["numbers_right"] = float(len(re.findall(r"\d+(?:[.,]\d+)?", right)))
    # защита от «Площадь 2 3009.4»: «2» остался от «м²», значение правее (в проде M-001…M-005 закрыто OS-INSP-2.2.23;
    # признак ловит тот же след у параметров без паспорта)
    if raw in ("2", "3") and f["numbers_right"] > 0 and any(u in (item.get("unit") or "") for u in ("²", "³", "2", "3")):
        f["unit_exponent"] = 1.0
    for w in _words(left)[-4:]:
        f[_tok("L", w)] = 1.0
    for w in _words(right)[:3]:
        f[_tok("R", w)] = 1.0
    tail = fold(left)[-10:]
    for i in range(len(tail) - 2):
        f[_tok("l3", tail[i : i + 3])] = 1.0
    unit = fold(item.get("unit") or "")
    if unit:
        f["unit_right"] = 1.0 if unit in fold(right[:24]) else 0.0
    for mark, name in (
        ("%", "pct"),
        ("№", "num_sign"),
        ("(", "paren"),
        ("п.", "clause"),
    ):
        if mark in left[-6:]:
            f[f"mark_{name}"] = 1.0
    if re.search(r"в том числе|в т\.\s?ч", line, re.I):
        f["incl"] = 1.0
    for tok in (
        "не менее",
        "не более",
        "не ниже",
        "допуска",
        "норматив",
        "требован",
        "сп ",
        "гост",
    ):
        if tok in line.lower():
            f[f"norm:{tok.strip()}"] = 1.0
    return f


@dataclass
class Vocab:
    names: list[str]
    index: dict[str, int] = field(init=False)

    def __post_init__(self) -> None:
        self.index = {n: i + 1 for i, n in enumerate(self.names)}  # 0 — свободный член

    def vector(self, f: dict[str, float]) -> np.ndarray:
        x = np.zeros(len(self.names) + 1)
        x[0] = 1.0
        for k, val in f.items():
            j = self.index.get(k)
            if j is not None:
                x[j] = val
        return x


def build_vocab(train_feats: list[dict[str, float]], min_count: int = 2) -> Vocab:
    """Словарь — только из train; редкий признак (реже min_count) не получает веса."""
    counts: dict[str, int] = {}
    for f in train_feats:
        for k in f:
            counts[k] = counts.get(k, 0) + 1
    return Vocab(sorted(k for k, c in counts.items() if c >= min_count))


def sigmoid(z: np.ndarray) -> np.ndarray:
    return np.where(
        z >= 0,
        1 / (1 + np.exp(-np.abs(z))),
        np.exp(-np.abs(z)) / (1 + np.exp(-np.abs(z))),
    )


def fit_logistic(
    X: np.ndarray, y: np.ndarray, l2: float, max_iter: int = 50
) -> np.ndarray:
    """Ньютон с L2 (свободный член не штрафуется). Выпуклая задача: без случайности, повтор даёт те же веса."""
    n, d = X.shape
    w = np.zeros(d)
    reg = np.full(d, l2)
    reg[0] = 1e-9
    for _ in range(max_iter):
        p = sigmoid(X @ w)
        g = X.T @ (p - y) + reg * w
        H = (X * (p * (1 - p))[:, None]).T @ X + np.diag(reg)
        step = np.linalg.solve(H, g)
        w = w - step
        if float(np.max(np.abs(step))) < 1e-10:
            break
    return w


def fit_platt(scores: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Калибровка Платта p = σ(a·s + b) — одномерная логистическая регрессия на validation."""
    X = np.column_stack([np.ones_like(scores), scores])
    w = fit_logistic(X, y, l2=1e-6)
    return float(w[1]), float(w[0])


def choose_threshold(probs: np.ndarray, y: np.ndarray, min_keep: float) -> float:
    """Порог, при котором сохраняется не меньше min_keep верных (y=1) извлечений validation, с запасом: посередине
    между последним сохраняемым верным и ближайшей оценкой ниже него (точно на верном — ноль запаса на test)."""
    pos = np.sort(probs[y == 1])
    if len(pos) == 0:
        return 0.5
    k = int(math.floor((1 - min_keep) * len(pos) + 1e-9))  # столько верных можно потерять
    below = probs[probs < pos[k]]
    lower = float(below.max()) if len(below) else 0.0
    return (float(pos[k]) + lower) / 2


def wilson(k: int, n: int, z: float = 1.96) -> list[float]:
    if n == 0:
        return [0.0, 1.0]
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)]


def rates(accepted: np.ndarray, y: np.ndarray) -> dict:
    """keep_recall — доля верных, которые приняты; fpr — доля ошибочных, которые приняты (ошибка прошла в протокол)."""
    tp = int(np.sum(accepted & (y == 1)))
    npos = int(np.sum(y == 1))
    fp = int(np.sum(accepted & (y == 0)))
    nneg = int(np.sum(y == 0))
    return {
        "keep_recall": round(tp / npos, 4) if npos else None,
        "keep_recall_ci95": wilson(tp, npos),
        "fpr": round(fp / nneg, 4) if nneg else None,
        "fpr_ci95": wilson(fp, nneg),
        "precision": round(tp / (tp + fp), 4) if tp + fp else None,
        "n_correct": npos,
        "n_wrong": nneg,
    }


def roc_auc(scores: np.ndarray, y: np.ndarray) -> float | None:
    pos, neg = scores[y == 1], scores[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return None
    wins = sum(float(np.sum(p > neg)) + 0.5 * float(np.sum(p == neg)) for p in pos)
    return round(wins / (len(pos) * len(neg)), 4)


@dataclass
class TrainParams:
    l2: float = 1.0
    min_count: int = 2
    min_keep: float = 0.98
    max_iter: int = 50


def refusal(items: list[dict]) -> list[str]:
    """OS-INSP-6.4.8 для верификатора: без обоих классов в train или без validation/test не обучаем."""
    reasons = []
    by = {
        s: [it["label"] for it in items if it["split"] == s]
        for s in ("train", "validation", "test")
    }
    if "ACCEPT" not in by["train"] or "REJECT" not in by["train"]:
        reasons.append(
            "в train нужны и верные (ACCEPT), и ошибочные (REJECT) извлечения"
        )
    for s in ("validation", "test"):
        if not by[s]:
            reasons.append(f"выборка {s} пуста")
    return reasons


def _canon(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def weights_hash(model: dict) -> str:
    """Хеш весов — по канонической записи модели без метаданных итерации."""
    core = {
        k: model[k]
        for k in ("algorithm", "feature_rev", "vocab", "weights", "platt", "threshold")
    }
    return hashlib.sha256(_canon(core).encode()).hexdigest()


def train(items: list[dict], params: TrainParams | None = None) -> dict:
    """items: {item_id, split, label: ACCEPT|REJECT, section, …признаки извлечения}. Возвращает модель и метрики test."""
    params = params or TrainParams()
    reasons = refusal(items)
    if reasons:
        return {"ok": False, "reasons": reasons}
    ordered = sorted(
        items, key=lambda it: it["item_id"]
    )  # порядок строк не влияет на результат
    parts = {
        s: [it for it in ordered if it["split"] == s]
        for s in ("train", "validation", "test")
    }
    feats = {s: [features(it) for it in parts[s]] for s in parts}
    vocab = build_vocab(feats["train"], params.min_count)
    X = {s: np.array([vocab.vector(f) for f in feats[s]]) for s in parts}
    y = {
        s: np.array([1.0 if it["label"] == "ACCEPT" else 0.0 for it in parts[s]])
        for s in parts
    }
    w = fit_logistic(X["train"], y["train"], params.l2, params.max_iter)
    raw = {s: X[s] @ w for s in parts}
    a, b = fit_platt(raw["validation"], y["validation"])
    prob = {s: sigmoid(a * raw[s] + b) for s in parts}
    thr = choose_threshold(prob["validation"], y["validation"], params.min_keep)
    model = {
        "algorithm": ALGORITHM,
        "feature_rev": FEATURE_REV,
        "vocab": vocab.names,
        "weights": [round(float(v), 10) for v in w],
        "platt": [round(a, 10), round(b, 10)],
        "threshold": round(thr, 10),
    }
    yt, pt = y["test"].astype(int), prob["test"]
    acc = pt >= thr
    by_section: dict[str, dict] = {}
    for sec in sorted({it.get("section") or "?" for it in parts["test"]}):
        m = np.array([(it.get("section") or "?") == sec for it in parts["test"]])
        by_section[sec] = rates(acc[m], yt[m])
    metrics = {
        "test": rates(acc, yt) | {"roc_auc": roc_auc(pt, yt)},
        "baseline_accept_all": rates(np.ones_like(acc, dtype=bool), yt),
        "validation": rates(prob["validation"] >= thr, y["validation"].astype(int)),
        "by_section": by_section,
        "sizes": {
            s: {
                "n": len(parts[s]),
                "accept": int(y[s].sum()),
                "reject": int(len(parts[s]) - y[s].sum()),
            }
            for s in parts
        },
    }
    return {
        "ok": True,
        "model": model,
        "weights_hash": weights_hash(model),
        "metrics": metrics,
    }


def gate(prev: dict | None, nxt: dict, tol: float = 0.02) -> dict:
    """Ворота ТЗ §9.4 (OS-INSP-6.4.14): Recall верных не ниже предыдущей модели больше чем на tol, FPR не выше больше
    чем на tol. Предыдущей нет — сравнение с базовой «принимать всё» на том же test."""
    base = prev or nxt["baseline_accept_all"]
    cur = nxt["test"]
    reasons = []
    if cur["keep_recall"] is None or base["keep_recall"] is None:
        reasons.append("в test нет верных извлечений — Recall не измерен")
    elif cur["keep_recall"] < base["keep_recall"] - tol - 1e-12:
        reasons.append(
            f"Recall верных {cur['keep_recall']:.4f} < {base['keep_recall']:.4f} − {tol:.2f}"
        )
    if (
        cur["fpr"] is not None
        and base["fpr"] is not None
        and cur["fpr"] > base["fpr"] + tol + 1e-12
    ):
        reasons.append(f"FPR {cur['fpr']:.4f} > {base['fpr']:.4f} + {tol:.2f}")
    return {
        "ok": not reasons,
        "reasons": reasons,
        "compared_to": "previous" if prev else "baseline_accept_all",
    }


def score(model: dict, item: dict) -> float:
    vocab = Vocab(model["vocab"])
    z = float(vocab.vector(features(item)) @ np.array(model["weights"]))
    a, b = model["platt"]
    return float(sigmoid(np.array([a * z + b]))[0])


def apply(model: dict | None, items: list[dict]) -> list[dict]:
    """OS-INSP-6.4.15: опубликованный верификатор отбрасывает извлечение ниже порога и пишет оценку; без модели —
    извлечения без изменений."""
    if model is None:
        return items
    out = []
    for it in items:
        p = score(model, it)
        if p >= model["threshold"]:
            out.append(it | {"verifier_score": round(p, 4)})
    return out
