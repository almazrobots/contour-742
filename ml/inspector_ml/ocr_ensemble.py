"""Ансамбль OCR с голосованием по словам (OS-INSP-2.1.5, 2.1.6, 2.1.7).

Страница без текстового слоя читается несколькими движками — «независимыми взглядами».
Слова движков выравниваются по пересечению рамок (IoU), сравниваются после нормализации
(NFC, ё→е, кириллица/латиница-двойники), текст выбирается большинством, ничья — по уверенности.
Слово, в котором движки разошлись, помечается сомнительным (`Word.disputed`) и теряет
уверенность пропорционально доле несогласных движков. По странице сохраняются участвовавшие
движки, число сомнительных слов и доля согласия (`Page.engines`, `disputed_words`, `agreement`).

Профиль dev (ADR-0001): три прохода Tesseract — исходное изображение (--psm 4), предобработанное
(шумоподавление + устранение наклона + бинаризация Оцу, --psm 4) и другой режим сегментации
(--psm 6). Профиль gpu (T-184): PP-OCRv5 на видеокарте — слова с рамками — и PaddleOCR-VL через vLLM как второй
голос по строкам PP-OCR; Tesseract там не используется. Набор движков — INSPECTOR_OCR_ENGINES (ocr_gpu.py);
ядро голосования общее.
"""

from __future__ import annotations

import logging
import os
import shutil
import string
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np
from PIL import Image

from .model import BBox, Line, Word
from .normalize import _CYR2LAT, nfc

log = logging.getLogger(__name__)

TESS_LANG = "rus+eng"
TESS_TIMEOUT = 120  # секунд на один проход движка
IOU_MATCH = 0.3  # ниже — слова разных движков считаются разными словами
LONE_WORD_MIN_CONF = (
    80.0  # слово, которое видит меньшинство движков, оставляем только уверенным
)
_EDGE_PUNCT = string.punctuation + "«»—–…"


# ─────────────────────────────────────────────── движки


class OcrEngine(Protocol):
    name: str

    def available(self) -> bool: ...

    def read(self, image: Image.Image) -> list[Word]:
        """Слова страницы: текст, bbox в долях [0;1] исходного изображения, уверенность 0–100."""
        ...


def _tsv_words(
    tsv: str, iw: int, ih: int, to_src: Callable[[BBox], BBox] | None = None
) -> list[Word]:
    out = []
    for r in (row.split("\t") for row in tsv.splitlines()[1:]):
        if len(r) < 12 or r[0] != "5" or not r[11].strip():
            continue
        left, top, width, height = int(r[6]), int(r[7]), int(r[8]), int(r[9])
        box: BBox = (left, top, left + width, top + height)
        if to_src:
            box = to_src(box)
        out.append(
            Word(
                text=nfc(r[11]),
                bbox=(
                    round(min(max(box[0] / iw, 0.0), 1.0), 5),
                    round(min(max(box[1] / ih, 0.0), 1.0), 5),
                    round(min(max(box[2] / iw, 0.0), 1.0), 5),
                    round(min(max(box[3] / ih, 0.0), 1.0), 5),
                ),
                conf=max(float(r[10]), 0.0),
            )
        )
    return out


def _run_tesseract(img: Image.Image, psm: str) -> str:
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "p.png"
        img.save(p)
        return subprocess.run(
            ["tesseract", str(p), "-", "-l", TESS_LANG, "--psm", psm, "tsv"],
            capture_output=True,
            text=True,
            timeout=TESS_TIMEOUT,
            check=True,
            env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        ).stdout


def estimate_skew(gray: np.ndarray, max_deg: float = 3.0, step: float = 0.2) -> float:
    """Угол (градусы, против часовой — как в OpenCV), выпрямляющий строки. Ищется по профилю
    проекций: у выровненного текста строки дают
    самые резкие пики суммы по рядам. Считается на уменьшенной копии — дёшево."""
    import cv2

    h, w = gray.shape
    k = 800 / max(w, 1)
    small = (
        cv2.resize(
            gray, (max(int(w * k), 1), max(int(h * k), 1)), interpolation=cv2.INTER_AREA
        )
        if k < 1
        else gray
    )
    ink = (small < 128).astype(np.float32)
    if ink.sum() < 50:
        return 0.0
    cy, cx = ink.shape[0] / 2, ink.shape[1] / 2
    best, best_score = 0.0, -1.0
    for a in np.arange(-max_deg, max_deg + 1e-9, step):
        m = cv2.getRotationMatrix2D((cx, cy), float(a), 1.0)
        rot = cv2.warpAffine(
            ink, m, (ink.shape[1], ink.shape[0]), flags=cv2.INTER_NEAREST
        )
        score = float(np.var(rot.sum(axis=1)))
        if score > best_score + 1e-6:
            best, best_score = float(a), score
    return best


def preprocess(image: Image.Image) -> tuple[Image.Image, Callable[[BBox], BBox]]:
    """Шумоподавление (медиана) → устранение наклона → бинаризация Оцу.

    Возвращает бинарное изображение и функцию, переводящую рамку из его координат
    в координаты исходного изображения (обратный поворот)."""
    import cv2

    gray = np.asarray(image.convert("L"))
    den = cv2.medianBlur(gray, 3)
    angle = estimate_skew(den)
    h, w = den.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    if abs(angle) > 1e-6:
        den = cv2.warpAffine(den, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)
    _, binar = cv2.threshold(den, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    inv = cv2.invertAffineTransform(m)

    def to_src(box: BBox) -> BBox:
        pts = np.array(
            [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]],
            dtype=np.float64,
        )
        src = pts @ inv[:, :2].T + inv[:, 2]
        return (src[:, 0].min(), src[:, 1].min(), src[:, 0].max(), src[:, 1].max())

    return Image.fromarray(binar), to_src


@dataclass
class TesseractEngine:
    """Tesseract с заданным режимом сегментации, при необходимости — по предобработанному растру."""

    name: str
    psm: str = "4"
    preprocessed: bool = False

    def available(self) -> bool:
        return shutil.which("tesseract") is not None

    def read(self, image: Image.Image) -> list[Word]:
        iw, ih = image.size
        if self.preprocessed:
            img, to_src = preprocess(image)
            return _tsv_words(_run_tesseract(img, self.psm), iw, ih, to_src)
        return _tsv_words(_run_tesseract(image, self.psm), iw, ih)


def default_engines() -> list[OcrEngine]:
    """Движки по конфигурации (INSPECTOR_OCR_ENGINES, умолчание профиля): dev — Tesseract ×3, gpu — PP-OCR на
    видеокарте + читатель VL (T-184, OS-INSP-2.1.17)."""
    from .ocr_gpu import configured_engines

    return configured_engines()  # type: ignore[return-value]


# ─────────────────────────────────────────────── голосование


def vote_key(text: str) -> str:
    """Ключ сравнения слов разных движков: NFC, регистр, ё→е, двойники, без краевой пунктуации."""
    s = nfc(text).upper().replace("Ё", "Е").translate(_CYR2LAT)
    return s.strip(_EDGE_PUNCT) or s


def iou(a: BBox, b: BBox) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


@dataclass
class _Cluster:
    box: BBox
    members: dict[str, Word] = field(default_factory=dict)  # движок → слово


@dataclass
class VoteResult:
    engines: list[str]
    words: list[Word]
    disputed_words: int
    agreement: (
        float | None
    )  # доля слов, где все движки согласны; None — голосовать было некому
    mean_conf: float
    turns: int = 0  # страница повёрнута: четвертей оборота против часовой до прямого текста (T-184)
    lines: list[Line] | None = None  # строки, собранные в кадре прямого текста; None — собирать group_lines
    execution_failures: list[str] = field(default_factory=list)
    anchor_words: list[Word] = field(default_factory=list)


def _align(readings: dict[str, list[Word]]) -> list[_Cluster]:
    """Жадное выравнивание: слово присоединяется к кластеру с наибольшим IoU, где ещё нет слова
    этого движка. Порядок движков фиксирован — результат детерминирован."""
    clusters: list[_Cluster] = []
    for eng, words in readings.items():
        for w in words:
            if not w.bbox:
                continue
            best, best_iou = None, IOU_MATCH
            for c in clusters:
                if eng in c.members:
                    continue
                v = iou(w.bbox, c.box)
                if v >= best_iou:
                    best, best_iou = c, v
            if best is None:
                clusters.append(_Cluster(box=w.bbox, members={eng: w}))
            else:
                best.members[eng] = w
    return clusters


def vote(readings: dict[str, list[Word]]) -> VoteResult:
    """Голосование по словам движков (OS-INSP-2.1.5, 2.1.6)."""
    engines = list(readings)
    n = len(engines)
    out: list[Word] = []
    disputed = 0
    for c in _align(readings):
        groups: dict[str, list[Word]] = {}
        for w in c.members.values():
            groups.setdefault(vote_key(w.text), []).append(w)
        # большинство; ничья — по суммарной, затем максимальной уверенности
        key, ws = max(
            groups.items(),
            key=lambda kv: (
                len(kv[1]),
                sum(x.conf or 0 for x in kv[1]),
                max(x.conf or 0 for x in kv[1]),
            ),
        )
        support = len(ws)
        conf = sum(x.conf or 0 for x in ws) / support
        if 2 * len(c.members) <= n and n > 1 and conf < LONE_WORD_MIN_CONF:
            continue  # слово видит меньшинство движков и неуверенно — шум, а не текст
        is_disputed = n > 1 and support < n
        if is_disputed:
            disputed += 1
        best = max(ws, key=lambda x: x.conf or 0)
        boxes = [x.bbox for x in ws if x.bbox]
        out.append(
            Word(
                text=best.text,
                bbox=tuple(
                    round(sum(b[i] for b in boxes) / len(boxes), 5) for i in range(4)
                ),  # type: ignore[arg-type]
                conf=round(conf * support / n, 1),
                disputed=is_disputed,
            )
        )
    agreement = round(1 - disputed / len(out), 4) if out and n > 1 else None
    mean = sum(w.conf or 0 for w in out) / len(out) if out else 0.0
    return VoteResult(
        engines=engines,
        words=out,
        disputed_words=disputed,
        agreement=agreement,
        mean_conf=mean,
    )


# OS-INSP-2.1.8: наклон скана — перебор в пределах ±SKEW_MAX (dy/dx в долях листа), шаг SKEW_STEP
SKEW_MAX = 0.06
SKEW_STEP = 0.002
SKEW_GAIN = 1.1  # наклон принимается, только если профиль строк заметно резче, чем без поправки


def words_skew(words: list[Word]) -> float:
    """Наклон строк страницы по проекционному профилю: при верном наклоне центры слов одной строки ложатся
    в одну узкую полосу, и сумма квадратов заполнения полос максимальна. 0 — наклона нет или слов мало."""
    ws = [w for w in words if w.bbox]
    if len(ws) < 8:
        return 0.0
    hs = sorted(w.bbox[3] - w.bbox[1] for w in ws)
    bin_h = max(hs[len(hs) // 2] / 2, 1e-4)
    pts = [((w.bbox[0] + w.bbox[2]) / 2, (w.bbox[1] + w.bbox[3]) / 2, w.bbox[2] - w.bbox[0]) for w in ws]

    def sharpness(k: float) -> float:
        acc: dict[int, float] = {}
        for cx, cy, wd in pts:
            b = int((cy - k * cx) / bin_h)
            acc[b] = acc.get(b, 0.0) + wd
        return sum(v * v for v in acc.values())

    base = sharpness(0.0)
    n = int(SKEW_MAX / SKEW_STEP)
    best_k, best = 0.0, base
    for i in range(-n, n + 1):
        k = i * SKEW_STEP
        v = sharpness(k)
        if v > best:
            best_k, best = k, v
    return best_k if best > base * SKEW_GAIN else 0.0


def group_lines(words: list[Word]) -> list[Line]:
    """Строки геометрически: слово с центром в вертикальных пределах строки — в эту строку.
    OS-INSP-2.1.8: на наклонном скане строка таблицы (подпись — единица — значение) идёт по наклону;
    группировка — по высоте с поправкой на наклон, координаты слов не меняются."""
    k = words_skew(words)

    def y(w: Word, i: int) -> float:
        return w.bbox[i] - k * (w.bbox[0] + w.bbox[2]) / 2

    rows: list[list[Word]] = []
    for w in sorted(
        (w for w in words if w.bbox),
        key=lambda w: ((y(w, 1) + y(w, 3)) / 2, w.bbox[0]),
    ):
        mid = (y(w, 1) + y(w, 3)) / 2
        for row in rows:
            top, bottom = min(y(x, 1) for x in row), max(y(x, 3) for x in row)
            if top <= mid <= bottom:
                row.append(w)
                break
        else:
            rows.append([w])
    lines = []
    for row in rows:
        row.sort(key=lambda x: x.bbox[0])
        lines.append(Line(text=" ".join(x.text for x in row), words=row))
    return lines


def _reading(e, image: Image.Image):
    """(слова, поворот): движок-якорь (PP-OCR) отдаёт и поворот текста страницы, остальные — только слова."""
    rp = getattr(e, "read_page", None)
    if rp is not None:
        r = rp(image)
        return r.words, r.turns
    return e.read(image), 0


def run_ensemble(
    image: Image.Image, engines: list[OcrEngine] | None = None
) -> VoteResult:
    """Прогон доступных движков параллельно и голосование.

    Независимые движки (Tesseract, PP-OCR) читают страницу параллельно. Движки, которым нужен якорь (читатель VL,
    `needs_anchor`), читают после них — строки первого движка-якоря, и голосуют за текст в его рамках (T-184).
    Недоступный движок пропускается; упавший — тоже, с записью в журнал. Если не отработал ни один — пустой
    результат с engines=[], страница уйдёт в ABSTAIN. Профиль gpu не доходит сюда с недоступным движком:
    ocr_gpu.check_ready роняет старт (OS-INSP-2.1.18)."""
    from .ocr_gpu import group_lines_turned

    engines = [
        e
        for e in (engines if engines is not None else default_engines())
        if e.available()
    ]
    if not engines:
        return VoteResult(
            engines=[], words=[], disputed_words=0, agreement=None, mean_conf=0.0
        )
    indep = [e for e in engines if not getattr(e, "needs_anchor", False)]
    dep = [e for e in engines if getattr(e, "needs_anchor", False)]
    got: dict[str, tuple[list[Word], int]] = {}
    with ThreadPoolExecutor(max_workers=max(1, len(indep))) as ex:
        from .execution_scope import scoped_submit
        futures = [(e, scoped_submit(ex, _reading, e, image)) for e in indep]
        for e, f in futures:
            try:
                got[e.name] = f.result()
            except Exception as err:  # движок сторонний: любой его сбой — выбывание, не падение разбора
                if getattr(e, "fail_loud", False):
                    # сбой PP-OCR — сбой инфраструктуры (память видеокарты, CUDA), а не свойство страницы: ошибка
                    # разбора файла и повтор (2.1.4), а не страница ABSTAIN в кэше навсегда (замер T-184: два
                    # прогона рядом переполнили видеокарту, и 68 страниц легли в кэш пустыми)
                    raise
                log.warning("OCR-движок %s выбыл: %s", e.name, err)
    anchor = next((got[e.name] for e in indep if e.name in got and got[e.name][0]), None)
    turns = anchor[1] if anchor else 0
    if anchor:
        for e in dep:
            try:
                got[e.name] = (e.read_with(image, anchor[0], turns, vote_key, group_lines), turns)
            except Exception as err:
                log.warning("OCR-движок %s выбыл: %s", e.name, err)
    order = [e.name for e in engines if e.name in got]
    if not order:
        return VoteResult(
            engines=[], words=[], disputed_words=0, agreement=None, mean_conf=0.0
        )
    res = vote({n: got[n][0] for n in order})
    res.anchor_words = [word.model_copy(deep=True) for word in anchor[0]] if anchor else []
    res.execution_failures = [f"{n}:{reason}" for n in order
                              for reason in getattr(got[n][0], "execution_failures", [])]
    if turns:
        res.turns = turns
        res.lines = group_lines_turned(res.words, turns, group_lines)
    return res
