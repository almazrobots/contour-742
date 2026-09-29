"""Семантические якоря (OS-INSP-2.2.8, ТЗ §9.1.2): если подпись строки перефразирована и лексически якорь
не совпал, параметр ищется по смысловой близости подписи к якорю.

Модель — paraphrase-multilingual-MiniLM-L12-v2 (sentence-transformers, 384 измерения, 50+ языков) в ONNX,
квантованная под arm64 (model_qint8_arm64.onnx, 118 МБ): ТЗ называет all-MiniLM-L6-v2 «или совместимый
аналог», а all-MiniLM-L6-v2 обучена на английском — русские якоря она не различает. Без torch: onnxruntime +
tokenizers, mean pooling по маске внимания и L2-нормировка — как в sentence-transformers (в fastembed для этой
модели открыт баг расхождения эмбеддингов на русском тексте, поэтому он не используется).

Модели нет (не скачана, нет onnxruntime) — get_embedder() возвращает None, извлечение остаётся лексическим.
Семантика только дополняет: параметр, найденный лексически, не пересматривается; строка, занятая лексическим
совпадением, семантике не достаётся.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import numpy as np

from .model import Extraction, Line, ParamSpec, ParsedDoc
from .normalize import NUMBER_RE, parse_number
from .paths import repo_root

SEM_MIN = 0.84  # косинус подписи и якоря, ниже — не тот параметр; 0,80 пропускал «Количество лифтов» → «Привязки и габариты лифтовых шахт» (0,796)
SEM_MARGIN = (
    0.05  # отрыв от второй по близости строки: иначе выбор неоднозначен, не берём
)
SEM_CONF = 0.9  # множитель уверенности семантического совпадения против лексического
SEM_MIN_WORDS = 2  # однословные тексты модель не различает: «Этажность ↔ Отметка» 0,90, «Этажность ↔ Количество этажей» 0,44
EMBED_CACHE_MAX = 20_000  # ≈30 МБ: якоря Матрицы и подписи строк повторяются между документами
MODEL_DIR = "var/models/paraphrase-multilingual-MiniLM-L12-v2"
def model_file(machine: str | None = None) -> str:
    """Квантованная модель под процессор: arm64 — мак, x86 (сервер профиля gpu) — avx2, есть у любого x86-64 с 2013 г.
    Порог SEM_MIN откалиброван на arm64; на x86 бенчмарк eval/semantic_bench.py перегоняется при выкатке."""
    import platform

    m = (machine or platform.machine()).lower()
    return "onnx/model_qint8_arm64.onnx" if m in ("arm64", "aarch64") else "onnx/model_quint8_avx2.onnx"


MODEL_FILE = os.environ.get("INSPECTOR_EMBED_FILE") or model_file()


class Embedder(Protocol):
    def embed(
        self, texts: list[str]
    ) -> np.ndarray: ...  # (n, d), строки L2-нормированы


class OnnxEmbedder:
    def __init__(self, model_dir: Path) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tok.enable_padding()
        self.tok.enable_truncation(max_length=128)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2  # правило №0: не забирать все ядра
        self.sess = ort.InferenceSession(
            str(model_dir / MODEL_FILE), opts, providers=["CPUExecutionProvider"]
        )
        self.inputs = {i.name for i in self.sess.get_inputs()}
        self._cache: dict[str, np.ndarray] = {}  # ≈1,5 КБ на текст; потолок — EMBED_CACHE_MAX

    def embed(self, texts: list[str]) -> np.ndarray:
        """Каждый текст кодируется отдельно: квантованная модель считает масштаб активаций по всему тензору,
        включая паддинг, и в пакете близость плавает от соседей (0,798 одна → 0,793 с длинным соседом) —
        тогда находка зависела бы от того, что ещё есть в документе."""
        for t in dict.fromkeys(texts):
            if t not in self._cache:
                if len(self._cache) >= EMBED_CACHE_MAX:
                    self._cache.clear()
                self._cache[t] = self._embed_batch([t])[0]
        return np.stack([self._cache[t] for t in texts])

    def _embed_batch(self, texts: list[str]) -> np.ndarray:
        enc = self.tok.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = self.sess.run(None, feed)[0]  # (n, t, d)
        m = mask[..., None].astype(np.float32)
        pooled = (hidden * m).sum(1) / np.clip(
            m.sum(1), 1e-9, None
        )  # mean pooling по маске, как sentence-transformers
        return pooled / np.clip(
            np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9, None
        )


@lru_cache(maxsize=1)
def get_embedder() -> Embedder | None:
    d = Path(os.environ.get("INSPECTOR_EMBED_MODEL", repo_root() / MODEL_DIR))
    if not (d / MODEL_FILE).exists() or not (d / "tokenizer.json").exists():
        return None
    try:
        return OnnxEmbedder(d)
    except ImportError:
        return None


@dataclass(frozen=True)
class _Cand:
    page: int
    line: Line
    label: str
    value: str
    start: int
    end: int


def _label_and_value(line: Line) -> tuple[str, str, int, int] | None:
    """Подпись — текст до первого числа, значение — это число. Строка без числа семантике не подходит."""
    m = NUMBER_RE.search(line.text)
    if not m or m.start() < 3:
        return None
    label = re.sub(
        r"\s+(м²|м³|м|мм|шт\.?|эт\.?|%|кВт|м2|м3)\s*$",
        "",
        line.text[: m.start()].strip(),
    )
    return (label, m.group(0), m.start(), m.end()) if _words(label) >= SEM_MIN_WORDS else None


def _words(text: str) -> int:
    return len(re.findall(r"[^\W\d_]{2,}", text))


def semantic_extract(
    doc: ParsedDoc,
    specs: list[ParamSpec],
    taken: set[tuple[int, str]],
    embedder: Embedder,
) -> list[Extraction]:
    """Числовые параметры без лексического совпадения — по смыслу подписи. taken — (страница, текст строки),
    уже отданные лексическим совпадениям."""
    from .extract import _span_bbox  # поздний импорт: extract импортирует этот модуль

    want = [s for s in specs if s.data_type == "number" and not s.regex_pattern]
    cands: list[_Cand] = []
    for page in doc.pages:
        for line in page.lines:
            if (page.page, line.text) in taken:
                continue
            lv = _label_and_value(line)
            if lv:
                cands.append(_Cand(page.page, line, *lv))
    if not want or not cands:
        return []
    anchors = [(s, a) for s in want for a in s.anchors if _words(a) >= SEM_MIN_WORDS]
    want = [s for s in want if any(x is s for x, _ in anchors)]
    if not want:
        return []
    va = embedder.embed([a for _, a in anchors])
    vl = embedder.embed([c.label for c in cands])
    sim = va @ vl.T  # (якоря, строки)
    # близость параметра к строке — лучший из его якорей
    spec_idx: dict[str, list[int]] = {}
    for i, (s, _) in enumerate(anchors):
        spec_idx.setdefault(s.code, []).append(i)
    by_spec = {
        code: sim[idx].max(axis=0) for code, idx in spec_idx.items()
    }  # code → (строки,)
    out = []
    for s in want:
        row = by_spec[s.code]
        order = np.argsort(-row)
        j, best = int(order[0]), float(row[order[0]])
        second = float(row[order[1]]) if len(order) > 1 else -1.0
        if best < SEM_MIN or best - second < SEM_MARGIN:
            continue
        # строка должна быть ближе всего именно к этому параметру (взаимный выбор) — и с отрывом от второго
        # параметра: «парковочные места в автостоянке» почти одинаково близки к машино-местам и местам МГН —
        # такую строку не берём, ложная находка для надзора хуже пропуска
        at_line = sorted(((float(v[j]), code) for code, v in by_spec.items()), reverse=True)
        if at_line[0][1] != s.code or (len(at_line) > 1 and at_line[0][0] - at_line[1][0] < SEM_MARGIN):
            continue
        c = cands[j]
        out.append(
            Extraction(
                code=s.code,
                raw=c.value,
                value_num=parse_number(c.value),
                value_text=None,
                page=c.page,
                bbox=_span_bbox(c.line, c.start, c.end),
                anchor_bbox=_span_bbox(c.line, 0, c.start),
                line_text=c.line.text,
                confidence=round(best * SEM_CONF, 3),
                match="semantic",
                similarity=round(best, 3),
            )
        )
    return out
