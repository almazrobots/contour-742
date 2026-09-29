"""Поиск по нормативной базе (OS-INSP-3.2.6, T-035).

Индекс = сидовый справочник `data/seed/norms.json` + записи normative_base, которые API передаёт
в запросе (`extra`). Ранжирование — BM25 (rank-bm25) по нормализованным токенам русского текста:
нижний регистр, ё→е, числа «0,85» → «0.85», грубое отсечение окончаний. Необязательный реранк —
косинус эмбеддингов Ollama (`/api/embed`), если сервер отвечает и модель есть; иначе только BM25.
Поиск ничего не утверждает о соответствии норме — он подбирает кандидатов в поле «Норматив».
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rank_bm25 import BM25Okapi

from ._http import get_json, post_json

# ─────────────────────────────── нормализация текста

_STOP = frozenset(
    "и в во на по с со к ко о об от до из за для при не но или а у же ли то это как что его её их".split()
)
# Окончания русских словоформ — от длинных к коротким; основа не короче 4 букв.
_ENDINGS = sorted(
    """ами ями ого его ему ому ыми ими ией иям иях ов ев ей ой ий ый ая яя ое ее ые ие ых их ым им ую юю ом ем ам ям ах ях
    ую ию ия ья ье ьи ию ы и а я о е у ю ь""".split(),
    key=len,
    reverse=True,
)
_NUM = re.compile(r"\d+(?:[.,]\d+)?")
_WORD = re.compile(r"[a-zа-я0-9]+(?:[.,]\d+)?")


def stem(w: str) -> str:
    if w[0].isdigit() or len(w) <= 4:
        return w
    for e in _ENDINGS:
        if w.endswith(e) and len(w) - len(e) >= 4:
            return w[: -len(e)]
    return w


def tokens(text: str) -> list[str]:
    """Токены для BM25: «Ширина эвакуационного выхода 0,85 м» → [ширин, эвакуационн, выход, 0.85, м]."""
    s = unicodedata.normalize("NFC", text or "").lower().replace("ё", "е")
    out = []
    for m in _WORD.finditer(s):
        w = m.group(0)
        if _NUM.fullmatch(w):
            out.append(w.replace(",", "."))
            continue
        if w in _STOP:
            continue
        out.append(stem(w))
    return out


# ─────────────────────────────── записи справочника


@dataclass
class NormDoc:
    id: str
    document_number: str
    document_name: str
    section: str | None
    summary: str
    source: str
    summary_is_paraphrase: bool = True
    param_codes: list[str] = field(default_factory=list)
    subject: str = ""
    numeric: dict | None = None

    def text(self) -> str:
        return " ".join(
            x
            for x in (
                self.document_number,
                self.document_name,
                self.section or "",
                self.subject,
                self.summary,
                " ".join(self.param_codes),
            )
            if x
        )

    def public(self) -> dict:
        return {
            "id": self.id,
            "document_number": self.document_number,
            "document_name": self.document_name,
            "section": self.section,
            "summary": self.summary,
            "summary_is_paraphrase": self.summary_is_paraphrase,
            "param_codes": self.param_codes,
            "numeric": self.numeric,
            "source": self.source,
        }


def _seed_path() -> Path:
    env = os.environ.get("INSPECTOR_NORMS_SEED")
    if env:
        return Path(env)
    for p in Path(__file__).resolve().parents:
        if (p / "data/seed/norms.json").exists():
            return p / "data/seed/norms.json"
    raise FileNotFoundError("data/seed/norms.json не найден")


def load_seed(path: Path | None = None) -> list[NormDoc]:
    data = json.loads((path or _seed_path()).read_text("utf-8"))
    keys = NormDoc.__dataclass_fields__.keys()
    return [
        NormDoc(**{k: v for k, v in it.items() if k in keys}) for it in data["items"]
    ]


def from_api_rows(rows: list[dict]) -> list[NormDoc]:
    """Записи таблицы normative_base API → документы индекса. Неактивные не индексируются."""
    out = []
    for r in rows:
        if r.get("is_active", 1) in (0, False):
            continue
        num = {k: r[k] for k in ("min_value", "max_value") if r.get(k) is not None}
        out.append(
            NormDoc(
                id=f"db:{r.get('id')}",
                document_number=str(r.get("document_number") or ""),
                document_name=str(r.get("document_name") or ""),
                section=r.get("section") or None,
                subject=str(r.get("parameter_name") or ""),
                summary=str(r.get("parameter_name") or r.get("document_name") or ""),
                summary_is_paraphrase=False,  # это запись администратора нормативной базы, не пересказ
                param_codes=[r["param_code"]] if r.get("param_code") else [],
                numeric=num or None,
                source="normative_base API",
            )
        )
    return out


# ─────────────────────────────── эмбеддинги Ollama (необязательно)


class OllamaEmbedder:
    """Эмбеддинги через локальный Ollama. Недоступен — `available()` = False, поиск идёт по BM25."""

    def __init__(
        self, url: str | None = None, model: str | None = None, timeout: float = 20.0
    ):
        self.url = (
            url or os.environ.get("INSPECTOR_OLLAMA_URL", "http://127.0.0.1:11434")
        ).rstrip("/")
        self.model = model or os.environ.get(
            "INSPECTOR_EMBED_MODEL", "qwen3-embedding:0.6b"
        )
        self.timeout = timeout
        self._ok: bool | None = None
        self._cache: dict[str, list[float]] = {}

    def available(self) -> bool:
        if self._ok is None:
            try:
                tags = get_json(f"{self.url}/api/tags", timeout=0.5)
                names = {m.get("name") for m in tags.get("models", [])}
                self._ok = self.model in names or f"{self.model}:latest" in names
            except (OSError, ValueError):
                self._ok = False
        return self._ok

    def embed(self, texts: list[str]) -> list[list[float]]:
        missing = [t for t in texts if t not in self._cache]
        if missing:
            r = post_json(
                f"{self.url}/api/embed",
                {"model": self.model, "input": missing},
                timeout=self.timeout,
            )
            for t, v in zip(missing, r["embeddings"]):
                self._cache[t] = v
        return [self._cache[t] for t in texts]


def _cos(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


# ─────────────────────────────── индекс


class NormIndex:
    def __init__(self, docs: list[NormDoc], embedder: OllamaEmbedder | None = None):
        self.docs = docs
        self.bm25 = (
            BM25Okapi([tokens(d.text()) or ["∅"] for d in docs]) if docs else None
        )
        self.embedder = embedder

    def search(
        self, query: str, top_k: int = 5, rerank: bool = True, pool: int = 10
    ) -> dict[str, Any]:
        q = tokens(query)
        if not self.bm25 or not q:
            return {"query": query, "method": "bm25", "results": []}
        scores = self.bm25.get_scores(q)
        order = sorted(range(len(self.docs)), key=lambda i: -scores[i])
        hits = [i for i in order if scores[i] > 0][: max(pool, top_k)]
        top = max((scores[i] for i in hits), default=0.0) or 1.0
        ranked = [(i, scores[i] / top, None) for i in hits]
        method = "bm25"
        if rerank and hits and self.embedder is not None:
            try:
                if self.embedder.available():
                    vecs = self.embedder.embed(
                        [query] + [self.docs[i].text() for i in hits]
                    )
                    qv = vecs[0]
                    # смесь: BM25 держит точные термины и числа, эмбеддинги — перефразировки
                    ranked = [
                        (i, 0.5 * b + 0.5 * _cos(qv, v), _cos(qv, v))
                        for (i, b, _), v in zip(ranked, vecs[1:])
                    ]
                    ranked.sort(key=lambda t: -t[1])
                    method = "bm25+embed"
            except (OSError, KeyError, ValueError):
                method = "bm25"  # эмбеддинги отвалились — остаёмся на BM25, не падаем
        return {
            "query": query,
            "method": method,
            "results": [
                {
                    **self.docs[i].public(),
                    "score": round(float(s), 4),
                    "bm25": round(float(scores[i]), 4),
                    "cosine": None if c is None else round(c, 4),
                }
                for i, s, c in ranked[:top_k]
            ],
        }


_INDEX_CACHE: dict[str, NormIndex] = {}
_EMBEDDER: OllamaEmbedder | None = None


def embedder() -> OllamaEmbedder | None:
    global _EMBEDDER
    if os.environ.get("INSPECTOR_EMBED", "1") == "0":
        return None
    # T-086: провайдер none — Ollama нет, не стучимся на 127.0.0.1 при каждом поиске, сразу BM25
    from .advisor import llm_mode

    if llm_mode(os.environ.get("INSPECTOR_PROFILE", "dev")) == "none":
        return None
    if _EMBEDDER is None:
        _EMBEDDER = OllamaEmbedder()
    return _EMBEDDER


def index_for(extra_rows: list[dict] | None = None) -> NormIndex:
    """Индекс кэшируется по содержимому записей API: при правке нормативной базы — пересборка."""
    key = hashlib.sha256(
        json.dumps(
            extra_rows or [], sort_keys=True, ensure_ascii=False, default=str
        ).encode()
    ).hexdigest()
    if key not in _INDEX_CACHE:
        _INDEX_CACHE.clear()
        _INDEX_CACHE[key] = NormIndex(
            load_seed() + from_api_rows(extra_rows or []), embedder()
        )
    return _INDEX_CACHE[key]
