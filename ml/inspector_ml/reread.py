"""Точечное перечитывание значения параметра (OS-INSP-2.2.12, TZA-7.1-02).

Ансамбль OCR читает страницу целиком и не знает, что ищет. Ошибка в одном слове значения стоит
параметра: «V» читается как «\\», «5 257,7» — как «5257 5» (и берётся неверное 5257), «171» — как «WAL».
Подпись при этом распознана верно, а Матрица знает тип значения. Поэтому, когда подпись на OCR-странице
найдена, а значения нет или оно сомнительно (движки разошлись, уверенность ниже REREAD_CONF), вырезается
только область значения — справа от подписи, без единицы измерения — и читается заново:
однострочный режим Tesseract, белый список символов по типу (цифры и разделители для чисел, буквы
литералов для перечислений), увеличение строки и три варианта предобработки. Ответ принимается, только
если его подтвердили не меньше двух вариантов и он проходит валидатор типа.

Не подтвердилось — результат ансамбля не трогается: перечитывание только добавляет уверенность,
а не угадывает (ложная находка для надзора хуже пропуска).
"""

from __future__ import annotations

import os
import re
import shutil
import time
import subprocess
import tempfile
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from .extractor_kinds import has_way
from .extract import ANCHOR_MIN_OCR, _anchor_end, _claim, _rivals, anchor_score
from .model import BBox, Extraction, Line, Page, ParamSpec, ParsedDoc
from .normalize import NUMBER_RE, nfc, parse_number

REREAD_CONF = 70.0  # уверенность слова значения ниже — перечитывать
MIN_AGREE = 2  # вариантов предобработки, давших одинаковый ответ
TARGET_H = (
    96  # высота строки после увеличения, px: Tesseract LSTM надёжнее на крупном кегле
)
PAD_X, PAD_Y = 0.006, 0.35  # поля области: доля ширины страницы; доля высоты строки
CONF_BY_AGREE = {3: 0.9, 2: 0.75}  # уверенность ответа по числу согласных вариантов
TESS_TIMEOUT = 30
BORDER = 24  # белое поле вокруг варианта, px: Tesseract плохо читает текст у самого края
NUM_WHITELIST = "0123456789,. "
UNIT_RE = re.compile(
    r"^(м[²³23?]?|мм|см|шт\.?|эт\.?|ед\.?|кВт|МВт|%|т|кг|°C|м2|м3|м/с|л/с|куб\.м)$",
    re.I,
)


@dataclass(frozen=True)
class Reading:
    text: str
    conf: float
    bbox: BBox | None  # доли изображения, которое читалось


LineOcr = Callable[[Image.Image, str], list[Reading]]


# ─────────────────────────────────────────────── тип значения → белый список и валидатор


def _literals(pattern: str) -> list[str] | None:
    """Литералы шаблона-перечисления вида \\b(V|IV|III|II|I)\\b; для шаблона сложнее — None."""
    core = re.sub(r"\\b", "", pattern).strip().removeprefix("(").removesuffix(")").removeprefix("?:")
    alts = core.split("|")
    return (
        alts
        if alts and all(re.fullmatch(r"[\w.\-]+", a) for a in alts)  # \w в Python — и кириллица
        else None
    )


# кириллические и типографские двойники латиницы в римских числах и кодах перечислений
_LATIN = str.maketrans(
    {
        "І": "I",
        "Ӏ": "I",
        "l": "I",
        "|": "I",
        "Х": "X",
        "С": "C",
        "М": "M",
        "Т": "T",
        "В": "B",
    }
)


def _is_number(spec: ParamSpec) -> bool:
    """Числовой параметр без шаблона: значение — число (все остальные числовые пути опираются на это)."""
    return spec.data_type == "number" and not spec.regex_pattern


def whitelist(spec: ParamSpec) -> str | None:
    """Символы, из которых может состоять значение; "" — перечитывать без ограничения набора (валидатор
    примет только литералы Матрицы); None — параметр перечитыванием не покрыт.
    Перечислению список не задаётся: с моделью rus+eng белый список «IV» подавляет ответ целиком,
    а без него одиночную «V» читают все три варианта."""
    if spec.regex_pattern:
        return "" if _literals(spec.regex_pattern) else None
    return NUM_WHITELIST if _is_number(spec) else None


def validate(spec: ParamSpec, text: str) -> str | None:
    """Каноническое значение, если текст целиком — значение этого типа; иначе None."""
    t = nfc(text).strip(" .,;:")
    if not t:
        return None
    if spec.regex_pattern:
        lits = _literals(spec.regex_pattern)
        if lits is not None:
            if t in lits:
                return t
            lat = t.translate(_LATIN)
            return lat if lat in lits else None
        m = re.fullmatch(spec.regex_pattern, t)
        return t if m else None
    return t if _is_number(spec) and NUMBER_RE.fullmatch(t) else None


# ─────────────────────────────────────────────── где лежит значение


def _word_spans(line: Line) -> list[tuple[int, int]]:
    """Символьные границы слов в line.text: строка — слова через пробел (как считает extract._span_bbox)."""
    spans, pos = [], 0
    for w in line.words:
        spans.append((pos, pos + len(w.text)))
        pos += len(w.text) + 1
    return spans


def anchor_line(page: Page, spec: ParamSpec) -> tuple[Line, int] | None:
    """Лучшая строка страницы с подписью параметра и позиция конца подписи в ней."""
    best: tuple[float, Line, str] | None = None
    for line in page.lines:
        for a in spec.anchors:
            s = anchor_score(a, line.text)
            if s >= ANCHOR_MIN_OCR and (best is None or s > best[0]):
                best = (s, line, a)
    if best is None:
        return None
    _, line, a = best
    return line, _anchor_end(a, line.text)


def value_words(line: Line, after: int) -> list[int]:
    """Индексы слов значения: после подписи, единицы измерения пропускаются."""
    out = []
    for i, (s, _) in enumerate(_word_spans(line)):
        if s < after:
            continue
        if not out and UNIT_RE.match(line.words[i].text.strip(":;")):
            continue
        out.append(i)
    return out


def value_zone(line: Line, idx: list[int]) -> BBox | None:
    """Область значения в долях страницы: слова значения с полями; высота — по всей строке."""
    boxes = [line.words[i].bbox for i in idx if line.words[i].bbox]
    row = [w.bbox for w in line.words if w.bbox]
    if not boxes or not row:
        return None
    y0, y1 = min(b[1] for b in row), max(b[3] for b in row)
    dy = (y1 - y0) * PAD_Y
    return (
        max(0.0, min(b[0] for b in boxes) - PAD_X),
        max(0.0, y0 - dy),
        min(1.0, max(b[2] for b in boxes) + PAD_X * 3),
        min(1.0, y1 + dy),
    )


def zone_after_anchor(line: Line) -> BBox | None:
    """Значения в строке нет вовсе: область справа от последнего слова строки (подписи) на четверть листа."""
    row = [w.bbox for w in line.words if w.bbox]
    if not row:
        return None
    ax = max(b[2] for b in row)
    y0, y1 = min(b[1] for b in row), max(b[3] for b in row)
    dy = (y1 - y0) * PAD_Y
    return (ax + PAD_X, max(0.0, y0 - dy), min(1.0, ax + 0.25), min(1.0, y1 + dy))


def doubtful(line: Line, idx: list[int]) -> bool:
    """Значение прочитано ненадёжно: движки разошлись или уверенность ниже порога."""
    return any(
        line.words[i].disputed or (line.words[i].conf or 0) < REREAD_CONF for i in idx
    )


# ─────────────────────────────────────────────── перечитывание


def _otsu(gray: np.ndarray) -> np.ndarray:
    """Бинаризация Оцу (OpenCV): текст 0, фон 255."""
    import cv2

    return cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]


RULE_LEN = 0.6  # прямая длиннее этой доли стороны области — линия таблицы: у текста штрих прерывается
RULE_SLACK = 7  # px после увеличения: наклон скана (±1°) превращает линию в «лесенку» — склеиваем поперёк


def strip_rules(gray: np.ndarray, binary: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Линии таблицы в области значения (сверху, снизу, по бокам) путают однострочный OCR. Стандартная
    морфология: тёмная маска чуть расширяется поперёк линии (наклонная линия становится сплошной полосой),
    открытие длинным ядром оставляет только длинные прямые, и фоном закрашиваются лишь исходные тёмные
    пиксели внутри этих полос. Доля тёмного в строке не годится: в узкой области штрихи цифр занимают
    больше половины ширины, а наклонная линия ни в одной строке не сплошная."""
    import cv2

    def rect(kw: int, kh: int) -> np.ndarray:
        return cv2.getStructuringElement(cv2.MORPH_RECT, (kw, kh))

    def long_lines(band: np.ndarray, kernel: np.ndarray) -> np.ndarray:
        return cv2.morphologyEx(band, cv2.MORPH_OPEN, kernel)

    dark = np.where(binary < 128, 255, 0).astype(np.uint8)
    h, w = dark.shape
    hor = long_lines(cv2.dilate(dark, rect(1, RULE_SLACK)), rect(max(8, int(RULE_LEN * w)), 1))
    ver = long_lines(cv2.dilate(dark, rect(RULE_SLACK, 1)), rect(1, max(8, int(RULE_LEN * h))))
    rules = cv2.dilate(cv2.bitwise_or(hor, ver), rect(3, 3)) > 0
    g, bb = gray.copy(), binary.copy()
    g[rules & (dark > 0)] = 255
    bb[rules] = 255
    return g, bb


def variants(crop: Image.Image) -> list[Image.Image]:
    """Три прочтения одной области: серое, бинаризованное (Оцу), бинаризованное с утолщением штриха;
    линии таблицы убраны заранее."""
    g = ImageOps.grayscale(crop)
    k = max(2.0, TARGET_H / max(1, g.height))
    g = g.resize(
        (max(1, round(g.width * k)), max(1, round(g.height * k))), Image.LANCZOS
    )
    ga = np.asarray(g)
    ga, ba = strip_rules(ga, _otsu(ga))
    b = Image.fromarray(ba)
    thick = b.filter(
        ImageFilter.MinFilter(3)
    )  # тёмный текст на светлом: минимум утолщает штрих
    return [
        ImageOps.expand(v, border=BORDER, fill=255) for v in (Image.fromarray(ga), b, thick)
    ]


def tesseract_args(image: str, allowed: str) -> list[str]:
    """Команда однострочного Tesseract. Числа — строка (--psm 7: «5 257,7» — два слова) с белым списком;
    перечисление — одно слово (--psm 8) без списка: одиночную «V» режим строки не находит, а с моделью
    rus+eng белый список «IV» подавляет ответ целиком. Язык rus+eng, как у ансамбля: модель eng читает «5»
    этого кегля как «3», модель, обученная на кириллических документах, — верно."""
    psm = "7" if allowed else "8"
    limit = ["-c", f"tessedit_char_whitelist={allowed}"] if allowed else []
    return ["tesseract", image, "-", "-l", "rus+eng", "--psm", psm, "--dpi", "300", *limit, "tsv"]


def parse_tsv(tsv: str, width: int, height: int) -> list[Reading]:
    """Слова TSV Tesseract (уровень 5) с рамками в долях изображения; пустые слова пропускаются."""
    words = []
    for r in (row.split("\t") for row in tsv.splitlines()[1:]):
        if len(r) < 12 or r[0] != "5" or not r[11].strip():
            continue
        x, y, w, h = int(r[6]), int(r[7]), int(r[8]), int(r[9])
        words.append(Reading(r[11], max(float(r[10]), 0.0), (x / width, y / height, (x + w) / width, (y + h) / height)))
    return words


def tesseract_line(img: Image.Image, allowed: str) -> list[Reading]:
    """Прочтение одного варианта области однострочным Tesseract."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "v.png"
        img.save(p)
        out = subprocess.run(
            tesseract_args(str(p), allowed),
            capture_output=True,
            text=True,
            timeout=TESS_TIMEOUT,
            check=True,
            env={**os.environ, "OMP_THREAD_LIMIT": "1"},  # правило №0: один поток на процесс
        ).stdout
    return parse_tsv(out, img.width, img.height)


def gpu_line(img: Image.Image, allowed: str) -> list[Reading]:
    """Reread uses the configured GPU ensemble, including its second voice."""
    from .ocr_ensemble import run_ensemble
    from .ocr_gpu import engine_names
    result = run_ensemble(img)
    if set(engine_names('gpu')) - set(result.engines) or result.execution_failures:
        raise RuntimeError('mandatory GPU reread engines did not complete')
    return [Reading(w.text, w.conf or 0, w.bbox) for w in result.words]


def _to_page(bs: list[BBox], vsize: tuple[int, int], csize: tuple[int, int], box: tuple[int, int, int, int], page: tuple[int, int]) -> BBox:
    """Рамка слов варианта (доли изображения с полем BORDER и увеличением) → доли листа."""
    (bw, bh), (cw, ch), (W, H) = vsize, csize, page
    sx, sy = cw / (bw - 2 * BORDER), ch / (bh - 2 * BORDER)
    x0 = box[0] + (min(b[0] for b in bs) * bw - BORDER) * sx
    y0 = box[1] + (min(b[1] for b in bs) * bh - BORDER) * sy
    x1 = box[0] + (max(b[2] for b in bs) * bw - BORDER) * sx
    y1 = box[1] + (max(b[3] for b in bs) * bh - BORDER) * sy
    return tuple(round(min(max(c, 0.0), 1.0), 5) for c in (x0 / W, y0 / H, x1 / W, y1 / H))  # type: ignore[return-value]


def vote_key(spec: ParamSpec, val: str) -> str:
    """Голосуют значения, а не тексты: «5 257,7» и «5 257.7» — одно число; «5 2577» — другое."""
    return f"{parse_number(val):.6g}" if _is_number(spec) else val


def _digits(s: str) -> str:
    return "".join(c for c in s if c.isdigit())


def consistent(prior: str | None, val: str) -> bool:
    """Ответ перечитывания не спорит с тем, что ансамбль уже увидел: если в прочтении были цифры,
    цифры ответа отличаются не больше чем на четверть их длины. «257,7» при прочтении «5257 5»
    (потеряна первая цифра) — отказ, даже если его подтвердили два варианта."""
    from rapidfuzz.distance import Levenshtein

    d0 = _digits(prior or "")
    if not d0:
        return True
    return Levenshtein.distance(d0, _digits(val)) <= max(1, len(d0) // 4)


def reread_zone(
    image: Image.Image,
    zone: BBox,
    spec: ParamSpec,
    ocr: LineOcr,
    prior: str | None = None,
) -> tuple[str, int, BBox] | None:
    """Значение области по голосованию вариантов: (значение, число согласных, рамка значения на странице)."""
    allowed = whitelist(spec)
    if allowed is None:
        return None
    W, H = image.size
    box = (
        round(zone[0] * W),
        round(zone[1] * H),
        round(zone[2] * W),
        round(zone[3] * H),
    )
    if box[2] - box[0] < 4 or box[3] - box[1] < 4:
        return None
    crop = image.crop(box)
    votes: Counter[str] = Counter()
    text_of: dict[str, str] = {}
    where: dict[str, BBox] = {}
    for v in variants(crop):
        try:
            words = ocr(v, allowed)
        except (subprocess.SubprocessError, OSError):
            continue
        text = " ".join(w.text for w in words)
        val = validate(spec, text)
        if val is None or not consistent(prior, val):
            continue
        key = vote_key(spec, val)
        votes[key] += 1
        text_of.setdefault(key, val)
        bs = [w.bbox for w in words if w.bbox]
        if bs and key not in where:
            where[key] = _to_page(bs, v.size, crop.size, box, image.size)
    if not votes:
        return None
    (key, n), *_ = votes.most_common()
    if n < MIN_AGREE:  # из трёх вариантов большинство ≥ 2 единственно — ничьей не бывает
        return None
    return text_of[key], n, where.get(key, zone)


# ─────────────────────────────────────────────── уточнение извлечения документа


def _extraction(
    spec: ParamSpec, val: str, n: int, bbox: BBox, page: int, line: Line, idx: list[int]
) -> Extraction:
    anchor_boxes = [
        w.bbox
        for j, w in enumerate(line.words)
        if w.bbox and j < (idx[0] if idx else len(line.words))
    ]
    anchor_bbox = (
        (
            min(b[0] for b in anchor_boxes),
            min(b[1] for b in anchor_boxes),
            max(b[2] for b in anchor_boxes),
            max(b[3] for b in anchor_boxes),
        )
        if anchor_boxes
        else None
    )
    num = _is_number(spec)
    return Extraction(
        code=spec.code,
        raw=val,
        value_num=parse_number(val) if num else None,
        value_text=None if num else val,
        page=page,
        bbox=bbox,
        anchor_bbox=anchor_bbox,
        line_text=line.text,
        confidence=CONF_BY_AGREE[n],
        match="reread",
    )


def refine(
    doc: ParsedDoc,
    specs: list[ParamSpec],
    found: list[Extraction],
    image_of: Callable[[int], Image.Image | None],
    ocr: LineOcr | None = None,
    timings: dict[str, float] | None = None,
    zone_image_of: Callable | None = None,
) -> list[Extraction]:
    """Извлечение, уточнённое перечитыванием значений на OCR-страницах. Порядок и прочие записи — прежние.
    timings — к времени параметра прибавляется время его перечитывания, мс (OS-INSP-2.2.34)."""
    if ocr is None:
        if os.environ.get('INSPECTOR_PROFILE', 'dev') == 'gpu':
            ocr = gpu_line
        elif not shutil.which("tesseract"):
            return found
        else:
            ocr = tesseract_line
    # упоминания класса (OS-INSP-2.2.13) не перечитываются и строк не занимают: их несколько, «лучшего» нет
    specs = [s for s in specs if not has_way(s)]  # свой путь вида (T-186, extractor_kinds.py) — не перечитывается
    by_code = {e.code: e for e in found if e.meta is None}
    # OS-INSP-2.2.10 и здесь: строка, отданная другому параметру, и строка, чья подпись ближе к сопернику,
    # не перечитываются для этого параметра («…выхода 0,85» не становится шириной коридора)
    taken = {(e.page, nfc(e.line_text)) for e in found if e.meta is None}
    rivals = _rivals(specs)
    pages = {p.page: p for p in doc.pages}
    images: dict[int, Image.Image | None] = {}
    out = list(found)
    for spec in specs:
        t0 = time.perf_counter()
        try:
            if whitelist(spec) is None:
                continue
            cur = by_code.get(spec.code)
            if cur is not None and cur.match == "semantic":
                continue  # подпись найдена по смыслу — строки лексической подписи нет
            cands = (
                [pages[cur.page]]
                if cur is not None
                else [p for p in doc.pages if p.source == "ocr"]
            )
            for page in cands:
                if page.source != "ocr" or not page.lines:
                    continue
                hit = anchor_line(page, spec)
                if hit is None:
                    continue
                line, after = hit
                if cur is not None and nfc(line.text) != nfc(cur.line_text):
                    continue
                if cur is None and (
                    (page.page, nfc(line.text)) in taken
                    or any(_claim(r, line.text) >= _claim(spec, line.text) for r in rivals[spec.code])  # ничья — тоже отказ
                ):
                    continue
                idx = value_words(line, after)
                if cur is not None and not doubtful(line, idx):
                    break  # значение прочитано надёжно — перечитывать нечего
                zone = value_zone(line, idx)  # пустой idx → None
                if zone is None:
                    zone = zone_after_anchor(line)
                    if zone is None:
                        continue
                prior = " ".join(line.words[i].text for i in idx)
                if zone_image_of is not None:
                    from .pipeline_region_ocr import map_box
                    img, transform = zone_image_of(page.page, zone)
                    try:
                        got = reread_zone(img, (0,0,1,1), spec, ocr, prior)
                        if got is not None:
                            got = (got[0], got[1], map_box(got[2], transform))
                    finally:
                        img.close()
                        del img
                else:
                    if page.page not in images:
                        images[page.page] = image_of(page.page)
                    img = images[page.page]
                    if img is None:
                        break
                    got = reread_zone(img, zone, spec, ocr, prior)
                if got is None:
                    break
                val, n, bbox = got
                conf = CONF_BY_AGREE[n]
                if cur is not None and vote_key(spec, val) == vote_key(spec, cur.raw):
                    # перечитывание подтвердило ансамбль: его запись и рамка точнее — поднимаем только уверенность
                    out[out.index(cur)] = cur.model_copy(update={"confidence": max(cur.confidence, conf)})
                    break
                # по вертикали — рамка слов строки: однострочный Tesseract захватывает остатки линий и шум
                ys = [line.words[i].bbox for i in idx if line.words[i].bbox] or [w.bbox for w in line.words if w.bbox]
                bbox = (bbox[0], min(b[1] for b in ys), bbox[2], max(b[3] for b in ys))
                new = _extraction(spec, val, n, bbox, page.page, line, idx)
                if cur is not None:
                    out[out.index(cur)] = new
                else:
                    out.append(new)
                break
        finally:
            if timings is not None:
                timings[spec.code] = timings.get(spec.code, 0.0) + (time.perf_counter() - t0) * 1000
    return out


def extract_refined(
    path: Path, doc: ParsedDoc, specs: list[ParamSpec], embedder=None, timings: dict[str, float] | None = None
) -> list[Extraction]:
    """Извлечение параметров документа с перечитыванием сомнительных значений — единый путь для сервиса,
    стенда §14 и прогона корпуса."""
    from .extract import extract
    from .parse import page_raster

    from .tables import merge_tables

    zone_image_of = None
    if doc.kind == 'pdf' and os.environ.get('INSPECTOR_PROFILE', 'dev') == 'gpu':
        from .pipeline_region_render import render_pdf_zone
        zone_image_of = lambda n, box: render_pdf_zone(path, doc.sha256, n, box)
    refined = refine(doc, specs, extract(doc, specs, embedder, timings=timings), lambda n: page_raster(path, doc, n),
                     timings=timings, zone_image_of=zone_image_of)
    # OS-INSP-2.2.5, 2.2.30 (T-135): значения из строк таблиц PDF с наименованием и единицей той же строки
    t0 = time.perf_counter()
    merged = merge_tables(path, doc, specs, refined)
    if timings is not None and specs:  # OS-INSP-2.2.34: таблицы разбираются на все параметры сразу — поровну
        share = (time.perf_counter() - t0) * 1000 / len(specs)
        for sp in specs:
            timings[sp.code] = timings.get(sp.code, 0.0) + share
    return merged
