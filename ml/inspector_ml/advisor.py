"""LLM-советник с проверкой ссылки (OS-INSP-3.2.4, 3.2.5; T-034).

Решения по параметрам Матрицы принимает детерминированный движок правил (API). Советник только
предлагает гипотезы вне Матрицы, и каждая гипотеза проходит `validate`: файл — из переданных,
страница — существует, дословная цитата нечётко (≥ 95) находится в тексте ЭТОЙ страницы, bbox
пересекается с bbox слов цитаты. Не прошла — отказ с кодом причины, в протокол не попадает.

Провайдер чат-LLM подключаемый (Ollama chat / MLX) и проверяется `available()`; недоступен —
советник молчит (`available: false`), а не падает. Модель не скачивается автоматически.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from rapidfuzz import fuzz

from ._http import get_json, post_json
from .model import BBox, ParamSpec, ParsedDoc
from .parse import union

QUOTE_MIN_SCORE = (
    95  # OS-INSP-3.2.4: цитата «дословная» с допуском на шум распознавания
)
QUOTE_MIN_CHARS = 8  # короче — не цитата, а слово, которое найдётся где угодно
MAX_CONTEXT_CHARS = 24_000  # потолок контекста для локальной модели

# Коды отказа (OS-INSP-3.2.5)
NO_QUOTE = "NO_QUOTE"
QUOTE_NOT_FOUND = "QUOTE_NOT_FOUND"
BBOX_MISMATCH = "BBOX_MISMATCH"
UNKNOWN_FILE = "UNKNOWN_FILE"
BAD_PAGE = "BAD_PAGE"
REASONS = (NO_QUOTE, QUOTE_NOT_FOUND, BBOX_MISMATCH, UNKNOWN_FILE, BAD_PAGE)


# ─────────────────────────────── контекст и промпт


@dataclass
class AdvisorContext:
    docs: dict[str, ParsedDoc]
    extracted: list[dict] = field(
        default_factory=list
    )  # извлечённые значения параметров Матрицы

    def text(self, limit: int = MAX_CONTEXT_CHARS) -> str:
        out: list[str] = []
        if self.extracted:
            out.append("ИЗВЛЕЧЁННЫЕ ЗНАЧЕНИЯ (код; значение; файл; стр.):")
            for e in self.extracted:
                out.append(
                    f"- {e['code']}; {e['raw']}; {e['sha256']}; стр. {e['page']}"
                )
        for sha, doc in self.docs.items():
            out.append(f"\nФАЙЛ sha256={sha} ({doc.kind})")
            for p in doc.pages:
                out.append(f"  СТРАНИЦА {p.page}")
                for ln in p.lines:
                    box = union([w.bbox for w in ln.words if w.bbox])
                    b = "[" + ", ".join(f"{x:.4f}" for x in box) + "]" if box else "нет"
                    out.append(f"    bbox={b} | {ln.text}")
        s = "\n".join(out)
        return s if len(s) <= limit else s[:limit] + "\n…(контекст обрезан)"


SYSTEM_PROMPT = """Ты — советник инспектора строительного надзора. Ты сравниваешь проектную (ПД), рабочую (РД) \
и исполнительную (ИД) документацию одного объекта и предлагаешь ГИПОТЕЗЫ о возможных расхождениях вне \
Матрицы параметров. Ты не принимаешь решений и не называешь нарушения установленными.

Правила:
1. Каждая гипотеза обязана ссылаться на один файл (sha256 из контекста), номер страницы, bbox строки \
из контекста и ДОСЛОВНУЮ цитату — фрагмент текста этой страницы, скопированный без изменений.
2. Не придумывай фактов, чисел, файлов и страниц. Если опоры в тексте нет — не предлагай гипотезу.
3. Не цитируй нормативные документы и не указывай пункты норм.
4. Ответ — строго JSON без пояснений:
{"hypotheses": [{"description": "...", "sha256": "...", "page": 1, "bbox": [x0, y0, x1, y1], "quote": "..."}]}
Если гипотез нет — {"hypotheses": []}."""


def build_messages(ctx: AdvisorContext) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": "КОНТЕКСТ ДОКУМЕНТОВ:\n"
            + ctx.text()
            + "\n\nПредложи гипотезы в формате JSON.",
        },
    ]


def parse_hypotheses(text: str) -> list[dict]:
    """Ответ модели → список сырых гипотез. Мусор вокруг JSON отбрасывается; неразборчивый ответ — []."""
    text = (text or "").strip()
    pairs = sorted((("{", "}"), ("[", "]")), key=lambda p: text.find(p[0]) if p[0] in text else len(text))
    for start, end in pairs:
        i, j = text.find(start), text.rfind(end)
        if i < 0 or j <= i:
            continue
        try:
            data = json.loads(text[i : j + 1])
        except ValueError:
            continue
        items = data.get("hypotheses", []) if isinstance(data, dict) else data
        return (
            [h for h in items if isinstance(h, dict)] if isinstance(items, list) else []
        )
    return []


# ─────────────────────────────── провайдеры


class Provider(Protocol):
    name: str

    def available(self) -> bool: ...

    def propose(self, context: AdvisorContext) -> list[dict]: ...


class NoProvider:
    name = "none"

    def available(self) -> bool:
        return False

    def propose(self, context: AdvisorContext) -> list[dict]:
        return []


class OllamaChatProvider:
    """Чат-модель в локальном Ollama. Модель задаётся INSPECTOR_LLM_MODEL; не задана или не скачана — недоступен."""

    name = "ollama"

    def __init__(
        self, url: str | None = None, model: str | None = None, timeout: float = 180.0
    ):
        self.url = (
            url or os.environ.get("INSPECTOR_OLLAMA_URL", "http://127.0.0.1:11434")
        ).rstrip("/")
        self.model = (
            model if model is not None else os.environ.get("INSPECTOR_LLM_MODEL", "")
        )
        self.timeout = timeout

    def available(self) -> bool:
        if not self.model:
            return False
        try:
            names = {
                m.get("name")
                for m in get_json(f"{self.url}/api/tags", timeout=0.5).get("models", [])
            }
        except (OSError, ValueError):
            return False
        return self.model in names or f"{self.model}:latest" in names

    def propose(self, context: AdvisorContext) -> list[dict]:
        r = post_json(
            f"{self.url}/api/chat",
            {
                "model": self.model,
                "messages": build_messages(context),
                "stream": False,
                "format": "json",
                "options": {"temperature": 0},
            },
            timeout=self.timeout,
        )
        return parse_hypotheses(r.get("message", {}).get("content", ""))


class MlxProvider:
    """Чат-модель через mlx-lm (Apple Silicon). Только локальный путь к модели: без скачивания."""

    name = "mlx"

    def __init__(self, model_path: str | None = None, max_tokens: int = 1024):
        self.model_path = (
            model_path
            if model_path is not None
            else os.environ.get("INSPECTOR_MLX_MODEL", "")
        )
        self.max_tokens = max_tokens
        self._loaded: tuple[Any, Any] | None = None

    def available(self) -> bool:
        return (
            bool(self.model_path)
            and Path(self.model_path).is_dir()
            and importlib.util.find_spec("mlx_lm") is not None
        )

    def propose(
        self, context: AdvisorContext
    ) -> list[dict]:  # pragma: no cover — нужна локальная модель
        from mlx_lm import generate, load

        if self._loaded is None:
            self._loaded = load(self.model_path)
        model, tok = self._loaded
        prompt = tok.apply_chat_template(
            build_messages(context), add_generation_prompt=True, tokenize=False
        )
        return parse_hypotheses(
            generate(model, tok, prompt=prompt, max_tokens=self.max_tokens)
        )


_override: Provider | None = None


def set_provider(p: Provider | None) -> None:
    """Подмена провайдера (тесты, демо)."""
    global _override
    _override = p


LLM_MODES = ("ollama", "mlx", "none")


def llm_mode(profile: str) -> str:
    """Провайдер LLM (T-086). dev — ollama по умолчанию; gpu — только явно, иначе падение при старте:
    тихий откат на несуществующий Ollama отключал советника и эмбеддинги поиска без единой ошибки (ADR-0001)."""
    mode = os.environ.get("INSPECTOR_LLM_PROVIDER")
    if mode is None:
        if profile == "gpu":
            raise SystemExit(
                "INSPECTOR_LLM_PROVIDER не задан: в профиле gpu провайдер LLM задаётся явно (ollama, mlx или none)"
            )
        mode = "ollama"
    if mode not in LLM_MODES:
        raise SystemExit(f"INSPECTOR_LLM_PROVIDER={mode!r}: ждём ollama, mlx или none")
    return mode


def get_provider() -> Provider:
    if _override is not None:
        return _override
    kind = llm_mode(os.environ.get("INSPECTOR_PROFILE", "dev"))
    if kind == "ollama":
        return OllamaChatProvider()
    if kind == "mlx":
        return MlxProvider()
    return NoProvider()


# ─────────────────────────────── валидатор ссылки


def _norm_word(w: str) -> str:
    return re.sub(r"[^\w]", "", w.lower().replace("ё", "е"))


def _page_index(
    doc: ParsedDoc, page: int
) -> tuple[str, list[tuple[int, int, BBox | None]]]:
    """Текст страницы из нормализованных слов через пробел + символьные границы каждого слова и его bbox."""
    parts, spans, pos = [], [], 0
    p = next(x for x in doc.pages if x.page == page)
    for ln in p.lines:
        for w in ln.words:
            n = _norm_word(w.text)
            if not n:
                continue
            spans.append((pos, pos + len(n), w.bbox))
            parts.append(n)
            pos += len(n) + 1
    return " ".join(parts), spans


def _valid_bbox(b: Any) -> BBox | None:
    try:
        x0, y0, x1, y1 = (float(v) for v in b)
    except (TypeError, ValueError):
        return None
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        return None
    return (x0, y0, x1, y1)


def _intersects(a: BBox, b: BBox) -> bool:
    return max(a[0], b[0]) < min(a[2], b[2]) and max(a[1], b[1]) < min(a[3], b[3])


def validate(raw: dict, docs: dict[str, ParsedDoc]) -> tuple[dict | None, dict | None]:
    """OS-INSP-3.2.4/3.2.5: (принятая, None) или (None, отказ с кодом причины)."""
    sha = str(raw.get("sha256") or "")
    quote = str(raw.get("quote") or "").strip()
    desc = str(raw.get("description") or "").strip()
    base = {
        "description": desc,
        "sha256": sha,
        "page": raw.get("page"),
        "bbox": raw.get("bbox"),
        "quote": quote,
    }

    def reject(reason: str, detail: str) -> tuple[None, dict]:
        return None, {"reason": reason, "detail": detail, **base}

    doc = docs.get(sha)
    if doc is None:
        return reject(UNKNOWN_FILE, "sha256 не из переданных файлов")
    page = raw.get("page")
    if (
        not isinstance(page, int)
        or isinstance(page, bool)
        or page not in {p.page for p in doc.pages}
    ):
        return reject(BAD_PAGE, f"страницы {page!r} нет в файле")
    qn = " ".join(n for n in (_norm_word(w) for w in quote.split()) if n)
    if len(qn) < QUOTE_MIN_CHARS:
        return reject(NO_QUOTE, "нет дословной цитаты")
    text, spans = _page_index(doc, page)
    if qn in text:
        score, start, end = 100.0, text.index(qn), text.index(qn) + len(qn)
    elif len(qn) > len(text):
        return reject(QUOTE_NOT_FOUND, "цитата длиннее текста страницы")
    else:
        al = fuzz.partial_ratio_alignment(qn, text)
        score, start, end = al.score, al.dest_start, al.dest_end
    if score < QUOTE_MIN_SCORE:
        return reject(
            QUOTE_NOT_FOUND,
            f"цитата не найдена на стр. {page} (сходство {score:.0f} < {QUOTE_MIN_SCORE})",
        )
    claimed = _valid_bbox(raw.get("bbox"))
    evidence = union([b for s, e, b in spans if e > start and s < end and b])
    if claimed is None:
        return reject(BBOX_MISMATCH, "bbox отсутствует или некорректен")
    if evidence is None:
        return reject(
            BBOX_MISMATCH, "у слов цитаты нет координат — ссылку нельзя проверить"
        )
    if not _intersects(claimed, evidence):
        return reject(BBOX_MISMATCH, "bbox не пересекается со словами цитаты")
    return {
        **base,
        "description": desc or quote,
        "bbox": list(claimed),
        "evidence_bbox": list(evidence),
        "match_score": round(float(score), 1),
    }, None


def advise(
    provider: Provider,
    docs: dict[str, ParsedDoc],
    params: list[ParamSpec] | None = None,
) -> dict:
    """Полный проход: контекст → предложения провайдера → проверка каждой ссылки."""
    if not provider.available():
        return {
            "provider": provider.name,
            "available": False,
            "accepted": [],
            "rejected": [],
        }
    extracted: list[dict] = []
    if params:
        from .extract import extract

        for sha, doc in docs.items():
            extracted += [
                {"code": e.code, "raw": e.raw, "sha256": sha, "page": e.page}
                for e in extract(doc, params)
            ]
    raw = provider.propose(AdvisorContext(docs=docs, extracted=extracted))
    accepted, rejected = [], []
    for h in raw:
        ok, bad = validate(h, docs)
        (accepted if ok else rejected).append(ok or bad)
    return {
        "provider": provider.name,
        "available": True,
        "accepted": accepted,
        "rejected": rejected,
    }
