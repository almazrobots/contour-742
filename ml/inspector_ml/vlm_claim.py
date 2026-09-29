"""VER-09 каталога TO-BE (T-196): закрытый вопрос локальной VLM по двум кропам — ожидаемому и фактическому.

Клиент — API `services/vlm-claim.ts` (T-194): `POST /vlm/claim {question, crops: [expected, actual]}` →
строго `{claim_supported: yes|no|unreadable, quote}`. Вердикт применяет API и только понижает статус кандидата.

Инварианты:
- модель — та же, что у судьи класса (`vlm.JUDGE`, канал `INSPECTOR_VLM_BACKEND`); VLM выключена → 503, статус
  кандидата не меняется;
- ответ модели не доверенный (OWASP LLM05): всё, что не строгий JSON с `claim_supported ∈ {yes, no, unreadable}`,
  становится `unreadable` — понижение до NOT_COMPARABLE, никогда не «yes» по догадке;
- вопрос закрытый и короткий (OWASP LLM10): не длиннее MAX_QUESTION, ровно два кропа разных ролей, рамки внутри листа.
"""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from pathlib import Path
from typing import Callable, Literal

from PIL import Image, ImageDraw
from pydantic import BaseModel, Field, field_validator, model_validator

MAX_QUESTION = 300  # как в API (vlm-claim.ts)
MAX_QUOTE = 500  # как VlmVerdictSchema в API
GAP_PX = 24  # поле между кропами на общем изображении
PAD = 0.02  # запас вокруг рамки кропа в долях листа — контекст подписи, не весь лист
VERDICTS = ("yes", "no", "unreadable")
# OWASP-0180 (LLM10): кроп перед моделью — не больше этой стороны; рамка на весь лист при потолке рендера 150 Мп
# (SEC-01) иначе давала изображение в сотни мегапикселей в памяти ML и в запросе к серверу VLM
MAX_CROP_SIDE = 2048
# OWASP-0181 (LLM10): не больше MAX_CONCURRENT вопросов к модели одновременно — лишний получает 429 сразу, а не встаёт в
# общий пул; тайм-аут модели короче тайм-аута API к ML (INSPECTOR_ML_TIMEOUT_MS, 120 с): API не бросает запрос, который
# ML ещё крутит
MAX_CONCURRENT = 2
CLAIM_TIMEOUT_S = 100
SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT)
# OWASP-0182: сбой чтения листа (не PDF, битый файл, ошибка ввода-вывода) — unreadable, а не 500
RENDER_ERRORS = (RuntimeError, OSError, ValueError)  # PdfiumError — наследник RuntimeError

CLAIM_PROMPT = (
    "Слева — фрагмент листа проектной документации с ожидаемым состоянием (подпись «ОЖИДАЕМОЕ»), справа — фрагмент "
    "с фактическим состоянием (подпись «ФАКТИЧЕСКОЕ»). Ответь на закрытый вопрос только по тому, что видно на "
    "фрагментах. Вопрос: {question}\nОтветь строго одним JSON без пояснений: "
    '{{"claim_supported": "yes|no|unreadable", "quote": "дословная надпись с фрагмента, на которую опирается ответ"}}. '
    "unreadable — если фрагменты нельзя прочитать или вопрос по ним не решается."
)


class ClaimCrop(BaseModel):
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    page: int = Field(ge=1)
    bbox: tuple[float, float, float, float]
    role: Literal["expected", "actual"]

    @field_validator("bbox")
    @classmethod
    def _inside(
        cls, b: tuple[float, float, float, float]
    ) -> tuple[float, float, float, float]:
        x0, y0, x1, y1 = b
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            raise ValueError(f"рамка кропа вне листа: {b}")
        return b


def _unprintable(ch: str) -> bool:
    """Управляющие (Cc) и форматные (Cf: bidi-переопределения, нулевой ширины) символы — кроме обычного пробела."""
    return unicodedata.category(ch) in ("Cc", "Cf")


class ClaimRequest(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION)
    crops: list[ClaimCrop] = Field(min_length=2, max_length=2)

    @field_validator("question")
    @classmethod
    def _one_line(cls, q: str) -> str:
        # OWASP-0184 (LLM01): закрытый вопрос — одна строка печатных символов; перевод строки и bidi в вопросе —
        # способ дописать модели свою инструкцию после вопроса или спрятать её от инспектора
        if any(_unprintable(ch) for ch in q):
            raise ValueError("в вопросе управляющие или невидимые символы")
        return q

    @model_validator(mode="after")
    def _roles(self) -> "ClaimRequest":
        if not self.question.strip():
            raise ValueError("вопрос пуст")
        if {c.role for c in self.crops} != {"expected", "actual"}:
            raise ValueError("нужны ровно два кропа — ожидаемое и фактическое")
        return self


def parse_claim(text: str) -> dict:
    """Строгий разбор ответа модели: первый JSON-объект; всё непонятное — unreadable без цитаты (не догадка)."""
    m = re.search(r"\{.*?\}", text, flags=re.S)
    try:
        d = json.loads(m.group(0)) if m else None
    except json.JSONDecodeError:
        d = None
    if not isinstance(d, dict):
        return {"claim_supported": "unreadable", "quote": ""}
    v = str(d.get("claim_supported", "")).strip().lower()
    if v not in VERDICTS:
        return {"claim_supported": "unreadable", "quote": ""}
    return {"claim_supported": v, "quote": clean_quote(str(d.get("quote", "")))}


def clean_quote(q: str) -> str:
    """OWASP-0183 (LLM05): цитата модели уходит в пояснение инспектору и в протокол — без управляющих и невидимых
    символов (bidi-переопределение переворачивает текст), пробелы схлопнуты; длина — в единицах UTF-16, как считает
    VlmVerdictSchema в API (zod .max(500)): символ вне BMP — две единицы."""
    q = " ".join("".join(" " if ch in "\t\n\r" else ch for ch in q if ch in "\t\n\r" or not _unprintable(ch)).split())
    out, units = [], 0
    for ch in q:
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > MAX_QUOTE:
            break
        out.append(ch)
    return "".join(out)


def side_by_side(expected: Image.Image, actual: Image.Image) -> Image.Image:
    """Одно изображение для модели: ожидаемое слева, фактическое справа, с подписями ролей."""
    label_h = 28
    w = expected.width + GAP_PX + actual.width
    h = max(expected.height, actual.height) + label_h
    out = Image.new("RGB", (w, h), "white")
    out.paste(expected.convert("RGB"), (0, label_h))
    out.paste(actual.convert("RGB"), (expected.width + GAP_PX, label_h))
    draw = ImageDraw.Draw(out)
    draw.text((4, 4), "ОЖИДАЕМОЕ", fill="black")
    draw.text((expected.width + GAP_PX + 4, 4), "ФАКТИЧЕСКОЕ", fill="black")
    return out


def capped(img: Image.Image) -> Image.Image:
    """Кроп не больше MAX_CROP_SIDE по большей стороне, пропорции сохраняются; маленький — как есть."""
    if max(img.size) <= MAX_CROP_SIDE:
        return img
    out = img.copy()
    out.thumbnail((MAX_CROP_SIDE, MAX_CROP_SIDE), Image.Resampling.LANCZOS)
    return out


def crop_of(img: Image.Image, bbox: tuple[float, float, float, float]) -> Image.Image:
    w, h = img.size
    x0, y0, x1, y1 = bbox
    return img.crop(
        (
            max(0, round((x0 - PAD) * w)),
            max(0, round((y0 - PAD) * h)),
            min(w, round((x1 + PAD) * w)),
            min(h, round((y1 + PAD) * h)),
        )
    )


def claim(
    req: ClaimRequest,
    locate: Callable[[str], Path],
    render: Callable[[Path, int], Image.Image | None],
    generate: Callable[[Image.Image, str], str],
) -> dict:
    """Кропы двух листов → одно изображение → закрытый вопрос модели → строгий вердикт.
    Лист не отрисовался (нет страницы) — unreadable: модель без изображения не спрашивается."""
    by_role = {c.role: c for c in req.crops}
    crops: dict[str, Image.Image] = {}
    for role in ("expected", "actual"):
        c = by_role[role]
        path = locate(c.sha256)  # 404/409 хранилища — наружу как есть
        try:
            img = render(path, c.page)
        except RENDER_ERRORS:
            img = None
        if img is None:
            return {"claim_supported": "unreadable", "quote": ""}
        crops[role] = capped(crop_of(img, c.bbox))
    image = side_by_side(crops["expected"], crops["actual"])
    return parse_claim(
        generate(image, CLAIM_PROMPT.format(question=req.question.strip()))
    )
