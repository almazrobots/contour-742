"""Реквизиты документа на странице (OS-INSP-2.3.1, ML-часть).

Профиль dev — классическое компьютерное зрение без моделей:
- печать — синие/фиолетовые чернила (HSV) + круглая или овальная форма с чернилами по контуру;
- подпись — кластер тонких штрихов чернил вне распознанного текста и вне прямых линий,
  синий цвет или соседство со словами «Подпись», «М.П.»;
- штампы «В производство работ» и «Выполнено согласно проекту» — нечёткий поиск фразы в словах
  страницы + рамка вокруг неё на растре;
- даты — dd.mm.yyyy и yyyy-mm-dd по тексту строк.

Координаты — [x0, y0, x1, y1] в долях страницы. Решение «реквизита не хватает» (MISSING_EVIDENCE,
OS-INSP-2.3.2) принимает API по совокупности страниц документа, здесь только находки.
"""

from __future__ import annotations

import re
from datetime import date

import numpy as np
from PIL import Image
from rapidfuzz import fuzz

from .model import BBox, Line, Requisite
from .normalize import fold

WORK_SIDE = 1600  # растр приводится к этой длинной стороне — пороги в пикселях от неё
# HSV (OpenCV: H 0–180): синие и фиолетовые чернила печатей и подписей
INK_H = (95, 165)
INK_S_MIN = 60
INK_V_MIN = 40
DARK_MAX = 110  # серый ниже — тёмные чернила/тонер
SEAL_DIAM = (0.07, 0.40)  # диаметр печати в долях ширины страницы
SEAL_RING_MIN = 0.7  # доля направлений, где на контуре эллипса есть чернила
SEAL_CORE_MAX = 0.5  # доля чернил в сердцевине выше — сплошное пятно, не печать
STAMP_PHRASES = {
    "stamp_production": ["в производство работ"],
    "stamp_asbuilt": ["выполнено согласно проекту"],
}
STAMP_MIN_SCORE = 85
HANDWRITTEN_INK = 0.5  # доля цветных чернил в рамке «слова» OCR, выше — рукописный реквизит, не текст
SIGN_WORDS = ("подпись", "подп", "мп", "м п")
DATE_RE = re.compile(
    r"(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)|(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)"
)


# ─────────────────────────────────────────────── текст: штампы и даты


def _span_bbox(line: Line, start: int, end: int) -> BBox | None:
    pos, boxes = 0, []
    for w in line.words:
        ws, we = pos, pos + len(w.text)
        if we > start and ws < end and w.bbox:
            boxes.append(w.bbox)
        pos = we + 1
    return _union(boxes)


def _union(boxes: list) -> BBox | None:
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def find_dates(lines: list[Line]) -> list[Requisite]:
    out = []
    for ln in lines:
        for m in DATE_RE.finditer(ln.text):
            if m.group(1):
                d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            else:
                y, mo, d = int(m.group(4)), int(m.group(5)), int(m.group(6))
            try:
                iso = date(y, mo, d).isoformat()
            except ValueError:
                continue  # 31.02.2025 — не дата
            confs = [w.conf for w in ln.words if w.conf is not None]
            conf = (sum(confs) / len(confs) / 100) if confs else 0.95
            out.append(
                Requisite(
                    kind="date",
                    bbox=_span_bbox(ln, m.start(), m.end()),
                    confidence=round(min(conf, 0.99), 3),
                    value=iso,
                )
            )
    return out


# OS-INSP-2.3.4: регистрационный номер — только после явной метки («Рег. №», «Регистрационный номер»,
# «Вх. №», «Исх. №»). Голый «№» не берём: «Лист № 3», «№ п/п» — не регистрационные номера.
# OCR читает «№» как «N», «No», «N°», «Ne» — принимаем эти формы.
_NUM = r"(?:№|N[o°eе]?\.?)"
REG_RE = re.compile(
    r"(?<![\w])(?:рег(?:\.|истрационный)?\s*(?:" + _NUM + r"|номер)|(?:вх|исх)(?:одящий)?\.?\s*" + _NUM + r")"
    r"\s*[:.]?\s*([0-9A-Za-zА-Яа-яЁё][0-9A-Za-zА-Яа-яЁё./\-]{0,39})",
    re.IGNORECASE,
)


def find_reg_numbers(lines: list[Line]) -> list[Requisite]:
    out = []
    for ln in lines:
        for m in REG_RE.finditer(ln.text):
            value = m.group(1).rstrip(".-/")
            if not re.search(r"\d", value):
                continue  # «Рег. № не присвоен» — номера нет
            confs = [w.conf for w in ln.words if w.conf is not None]
            conf = (sum(confs) / len(confs) / 100) if confs else 0.95
            out.append(
                Requisite(
                    kind="reg_number",
                    bbox=_span_bbox(ln, m.start(1), m.start(1) + len(value)),
                    confidence=round(min(conf, 0.99), 3),
                    value=value,
                )
            )
    return out


def _flat_words(lines: list[Line]):
    return [w for ln in lines for w in ln.words]


def find_stamp_phrases(lines: list[Line]) -> list[Requisite]:
    """Фраза штампа — окно подряд идущих слов страницы (в том числе через перенос строки),
    нечётко совпавшее с эталонной фразой. Окно должно быть компактным: не выше ~8 % страницы."""
    words = _flat_words(lines)
    keys = [fold(w.text) for w in words]
    out: list[Requisite] = []
    for kind, phrases in STAMP_PHRASES.items():
        best: tuple[float, int, int] | None = None
        for phrase in phrases:
            n = len(phrase.split())
            for size in (n - 1, n, n + 1):
                if size < 1:
                    continue
                for i in range(0, max(len(words) - size + 1, 0)):
                    text = " ".join(k for k in keys[i : i + size] if k)
                    if not text:
                        continue
                    score = fuzz.ratio(text, phrase)
                    if score < STAMP_MIN_SCORE or (best and score <= best[0]):
                        continue
                    box = _union([w.bbox for w in words[i : i + size]])
                    if box and box[3] - box[1] > 0.08:
                        continue
                    best = (score, i, i + size)
        if best:
            score, i, j = best
            out.append(
                Requisite(
                    kind=kind,  # type: ignore[arg-type]
                    bbox=_union([w.bbox for w in words[i:j]]),
                    confidence=round(score / 100 * 0.8, 3),
                    value=" ".join(w.text for w in words[i:j]),
                )
            )
    return out


# ─────────────────────────────────────────────── растр


def _work(image: Image.Image) -> tuple[np.ndarray, float]:
    k = WORK_SIDE / max(image.size)
    img = image.convert("RGB")
    if k < 1:
        img = img.resize(
            (max(int(image.width * k), 1), max(int(image.height * k), 1)),
            Image.Resampling.BILINEAR,
        )
    return np.asarray(img), k


def ink_mask(rgb: np.ndarray) -> np.ndarray:
    """Синие/фиолетовые чернила: оттенок в диапазоне, насыщенность и яркость выше порога."""
    import cv2

    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    return cv2.inRange(hsv, (INK_H[0], INK_S_MIN, INK_V_MIN), (INK_H[1], 255, 255))


def _norm(x0, y0, x1, y1, w, h) -> BBox:
    return (
        round(max(x0 / w, 0.0), 5),
        round(max(y0 / h, 0.0), 5),
        round(min(x1 / w, 1.0), 5),
        round(min(y1 / h, 1.0), 5),
    )


def _ring_coverage(mask: np.ndarray, ellipse) -> float:
    """Доля направлений (из 72), по которым у контура эллипса есть чернила — «кольцо» печати."""
    (cx, cy), (ma, mb), ang = ellipse
    a, b = ma / 2, mb / 2
    t = np.deg2rad(ang)
    hit = 0
    for phi in np.linspace(0, 2 * np.pi, 72, endpoint=False):
        found = False
        for s in (0.86, 0.9, 0.94, 0.98, 1.02):
            ex, ey = a * s * np.cos(phi), b * s * np.sin(phi)
            x = int(round(cx + ex * np.cos(t) - ey * np.sin(t)))
            y = int(round(cy + ex * np.sin(t) + ey * np.cos(t)))
            if 0 <= y < mask.shape[0] and 0 <= x < mask.shape[1] and mask[y, x]:
                found = True
                break
        hit += found
    return hit / 72


def _core_density(mask: np.ndarray, ellipse) -> float:
    """Доля чернил во внутренней части эллипса (60 % осей): у печати там редкий текст."""
    import cv2

    (cx, cy), (ma, mb), ang = ellipse
    core = np.zeros(mask.shape, np.uint8)
    cv2.ellipse(core, ((cx, cy), (ma * 0.6, mb * 0.6), ang), 255, -1)
    area = int((core > 0).sum())
    return float(((mask > 0) & (core > 0)).sum()) / area if area else 1.0


def find_seals(
    rgb: np.ndarray, mask: np.ndarray
) -> list[tuple[Requisite, tuple[int, int, int, int]]]:
    import cv2

    h, w = mask.shape
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        diam = max(cw, ch)
        if not (SEAL_DIAM[0] * w <= diam <= SEAL_DIAM[1] * w) or len(c) < 5:
            continue
        if max(cw, ch) / max(min(cw, ch), 1) > 2.2:
            continue  # овальная печать — не длиннее 2:1
        hull = cv2.convexHull(c)
        if len(hull) < 5:
            continue  # вытянутый или почти прямой контур: оболочка меньше 5 точек — не печать (fitEllipse падал на реальном листе, T-129)
        ell = cv2.fitEllipse(hull)
        ell_area = np.pi * ell[1][0] * ell[1][1] / 4
        fill = cv2.contourArea(hull) / ell_area if ell_area else 0
        ring = _ring_coverage(closed, ell)
        if fill < 0.85 or ring < SEAL_RING_MIN:
            continue
        if _core_density(mask, ell) > SEAL_CORE_MAX:
            continue  # сплошное пятно (логотип, клякса), а не кольцо с текстом
        conf = min(0.99, 0.5 + 0.3 * ring + 0.2 * min(fill, 1.0))
        out.append(
            (
                Requisite(
                    kind="seal",
                    bbox=_norm(x, y, x + cw, y + ch, w, h),
                    confidence=round(conf, 3),
                ),
                (x, y, x + cw, y + ch),
            )
        )
    return out


def _straight_lines(ink: np.ndarray) -> np.ndarray:
    """Длинные горизонтали и вертикали (линейки, рамки, подчёркивания) — не подписи."""
    import cv2

    k = max(ink.shape[1] // 40, 15)
    hor = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1))
    )
    ver = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k))
    )
    return cv2.dilate(hor | ver, np.ones((3, 3), np.uint8))


def find_signatures(
    rgb: np.ndarray,
    colored: np.ndarray,
    words: list,
    exclude: list[tuple[int, int, int, int]],
) -> list[Requisite]:
    import cv2

    h, w = colored.shape
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    dark = (gray < DARK_MAX).astype(np.uint8) * 255
    ink = dark | colored
    ink &= ~_straight_lines(ink)
    # стираем распознанный текст и найденные печати
    for wd in words:
        # «____» и прочая пунктуация — линия под подпись: подпись лежит поверх неё, стирать нельзя
        if not wd.bbox or not any(ch.isalnum() for ch in wd.text):
            continue
        x0, y0, x1, y1 = wd.bbox
        box = (slice(max(int(y0 * h) - 2, 0), int(y1 * h) + 3), slice(max(int(x0 * w) - 2, 0), int(x1 * w) + 3))
        # OCR читает росчерк как «слово»; печатный текст чёрный, а слово из синих чернил — рукопись
        if colored[box].sum() > HANDWRITTEN_INK * max(int(ink[box].astype(bool).sum()), 1) * 255:
            continue
        ink[box] = 0
    for x0, y0, x1, y1 in exclude:
        ink[y0 : y1 + 1, x0 : x1 + 1] = 0
    ink = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)
    )  # точечный шум скана
    grown = cv2.dilate(ink, np.ones((15, 15), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(grown)
    anchors = [
        wd.bbox
        for wd in words
        if wd.bbox and any(fold(wd.text).startswith(k) for k in SIGN_WORDS)
    ]
    out = []
    for i in range(1, n):
        x, y, cw, ch, _ = stats[i]
        if not (0.04 * w <= cw <= 0.35 * w and 0.012 * h <= ch <= 0.12 * h):
            continue
        aspect = cw / max(ch, 1)
        if not 1.0 <= aspect <= 10:
            continue
        region = ink[y : y + ch, x : x + cw] > 0
        area = int(region.sum())
        density = area / (cw * ch)
        if not 0.01 <= density <= 0.30:
            continue
        # толщина штриха ≈ площадь / половина периметра; подпись — тонкая линия
        cnts, _ = cv2.findContours(
            region.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE
        )
        perim = sum(cv2.arcLength(c, True) for c in cnts)
        stroke = area / max(perim / 2, 1)
        if stroke > 6 or perim < 0.15 * w:
            continue
        blue = colored[y : y + ch, x : x + cw].sum() / 255 / max(area, 1) > 0.5
        box = _norm(x, y, x + cw, y + ch, w, h)
        near = any(_near(box, a) for a in anchors)
        if not (blue or near):
            continue  # чёрный росчерк без слова «Подпись» рядом — скорее элемент чертежа
        conf = 0.55 + (0.2 if blue else 0) + (0.2 if near else 0)
        out.append(
            Requisite(kind="signature", bbox=box, confidence=round(min(conf, 0.95), 3))
        )
    return out


def _near(box: BBox, anchor: BBox) -> bool:
    """Подпись справа от «Подпись» в той же полосе или под/над ней не дальше 6 % высоты."""
    same_row = (
        box[1] < anchor[3] + 0.03
        and box[3] > anchor[1] - 0.03
        and box[0] >= anchor[0] - 0.02
        and box[0] - anchor[2] < 0.35
    )
    stacked = abs(box[1] - anchor[3]) < 0.06 or abs(anchor[1] - box[3]) < 0.06
    return same_row or (
        stacked and box[0] < anchor[2] + 0.2 and box[2] > anchor[0] - 0.2
    )


def find_frame(rgb: np.ndarray, colored: np.ndarray, target: BBox) -> BBox | None:
    """Прямоугольная рамка штампа вокруг фразы: наименьший четырёхугольный контур, содержащий её."""
    import cv2

    h, w = colored.shape
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ink = ((gray < DARK_MAX).astype(np.uint8) * 255) | colored
    lines = _straight_lines(ink)
    contours, _ = cv2.findContours(lines, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    tx0, ty0, tx1, ty1 = target[0] * w, target[1] * h, target[2] * w, target[3] * h
    best = None
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if not (x <= tx0 and y <= ty0 and x + cw >= tx1 and y + ch >= ty1):
            continue
        if cw * ch > 0.25 * w * h or cw > 3 * (tx1 - tx0) + 0.1 * w:
            continue  # рамка листа или таблицы, а не штамп
        approx = cv2.approxPolyDP(c, 0.03 * cv2.arcLength(c, True), True)
        if len(approx) != 4:
            continue
        if best is None or cw * ch < best[2] * best[3]:
            best = (x, y, cw, ch)
    if best is None:
        return None
    x, y, cw, ch = best
    return _norm(x, y, x + cw, y + ch, w, h)


# ─────────────────────────────────────────────── вход


def detect(image: Image.Image | None, lines: list[Line]) -> list[Requisite]:
    """Реквизиты страницы. image=None — у документа нет растра (DOCX, XML): только текст."""
    stamps = find_stamp_phrases(lines)
    found: list[Requisite] = []
    if image is not None:
        rgb, _ = _work(image)
        colored = ink_mask(rgb)
        seals = find_seals(rgb, colored)
        found += [s for s, _ in seals]
        found += find_signatures(
            rgb, colored, _flat_words(lines), [px for _, px in seals]
        )
        for st in stamps:
            frame = find_frame(rgb, colored, st.bbox) if st.bbox else None
            if frame:
                st.bbox = frame
                st.confidence = round(min(st.confidence + 0.15, 0.99), 3)
    return found + stamps + find_dates(lines) + find_reg_numbers(lines)
