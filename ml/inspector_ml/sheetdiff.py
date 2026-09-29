"""Дифф листа между редакциями (OS-INSP-3.4): совмещение растров и карта изменений.

Конвейер:
  1. рендер обеих страниц pdfium (под PDFIUM_LOCK) в оттенки серого ~150 dpi — в видимой ориентации,
     то есть с учётом /Rotate и CropBox (как norm_box в parse.py);
  2. ключевые точки SIFT (ORB — если SIFT нет в сборке OpenCV) + ratio-test Лоу;
  3. гомография лист B → лист A методом RANSAC (OS-INSP-3.4.1); мало инлайеров или вырожденная
     матрица — «листы не совмещаются», статус not_comparable с причиной (OS-INSP-3.4.4);
  4. варп листа B на лист A; карта SSIM (skimage.metrics.structural_similarity) и «терпимая» карта
     чернил: пиксель считается изменённым, только если рядом (±2 px) на другом листе нет линии —
     так гасится остаток совмещения и сглаживание при варпе;
  5. порог + морфология + контуры → области; близкие области сливаются, мелочь отбрасывается
     (OS-INSP-3.4.2); bbox — в долях [0;1] листа A и обратной гомографией — листа B.

Никаких моделей и torch: только OpenCV + scikit-image, всё на CPU.
Память: лист A1 при 150 dpi ≈ 5000×3500 px; длинная сторона ограничена MAX_SIDE, чтобы SSIM
(несколько float64-массивов размером с лист) не выходил за ~0,5 ГБ.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium
from skimage.metrics import structural_similarity

from .parse import PDFIUM_LOCK, CorruptedFile

ALGO_VERSION = "sd-1"  # ключ кэша: меняется при смене порогов/алгоритма
DPI = 150
MAX_SIDE = 3000  # px по длинной стороне после рендера
MIN_GOOD_MATCHES = 12  # после ratio-test
MIN_INLIERS = 25  # OS-INSP-3.4.4: меньше — совмещение ненадёжно
MIN_INLIER_RATIO = 0.25
RATIO = 0.75  # ratio-test Лоу
RANSAC_PX = 3.0
# Допуски вырожденности гомографии (лист B → лист A)
SCALE_RANGE = (0.5, 2.0)
MAX_PERSPECTIVE = 1e-3  # |h20|, |h21| — листы не снимаются под углом
MAX_ANISOTROPY = 1.5  # отношение сингулярных чисел аффинной части

INK = 128  # «линия на этом листе»: пиксель темнее
INK_NEAR = 200  # «линия рядом на другом листе»: мягче — варп размывает тонкие линии
TOLERANCE_PX = 2  # остаток совмещения, который не считается изменением
SSIM_WIN = 7
SSIM_CHANGED = 0.75  # локальная SSIM ниже — структура изменилась
CLOSE_PX = 9  # морфологическое закрытие: штрихи одного элемента → одна область
MERGE_GAP = 0.012  # слияние областей ближе этой доли диагонали листа
MIN_INK_PX = 25  # меньше изменённых пикселей — шум
MIN_SIDE_PX = 4
EDGE_PX = 6  # полоса у края зоны перекрытия листов не анализируется
MIN_INK_AGREEMENT = (
    0.5  # после совмещения меньше этой доли линий A находит пару на B — листы разные
)


@dataclass
class Region:
    bbox_a: tuple[float, float, float, float]
    bbox_b: tuple[float, float, float, float]
    score: float  # значимость 0..1
    area: float  # доля площади листа A


@dataclass
class DiffResult:
    status: str  # ok | not_comparable
    reason: str | None = None
    inliers: int = 0
    matches: int = 0
    method: str = ""
    size_a: tuple[int, int] = (0, 0)
    size_b: tuple[int, int] = (0, 0)
    regions: list[Region] = field(default_factory=list)
    ms: int = 0


# ─────────────────────────────────────────────── рендер


def render_gray(path: Path, page: int, dpi: float = DPI, max_side: int = MAX_SIDE) -> np.ndarray:
    """Страница (с 1) → серый uint8 в видимой ориентации. pdfium — только под блокировкой."""
    with PDFIUM_LOCK:
        try:
            doc = pdfium.PdfDocument(str(path))
        except pdfium.PdfiumError as e:
            raise CorruptedFile(f"повреждённый PDF: {path.name}") from e
        try:
            if not 1 <= page <= len(doc):
                raise IndexError(f"в документе {len(doc)} стр., запрошена {page}")
            pg = doc[page - 1]
            w, h = pg.get_size()
            from .resource_scope import require_render_pixels, render_guarded
            require_render_pixels(w, h, dpi / 72)
            scale = min(dpi / 72, max_side / max(w, h))
            # render() учитывает /Rotate: получаем лист так, как его видит человек
            def raster():
                img = pg.render(scale=scale, grayscale=True).to_numpy()
                if img.ndim == 3:
                    img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.shape[2] >= 3 else img[..., 0]
                return np.ascontiguousarray(img, dtype=np.uint8)

            try:
                return render_guarded(raster, w, h, scale, bytes_per_pixel=64)
            finally:
                pg.close()
        finally:
            doc.close()


# ─────────────────────────────────────────────── OS-INSP-3.4.1 совмещение


def _detector() -> tuple[str, cv2.Feature2D, int]:
    if hasattr(cv2, "SIFT_create"):
        return "sift", cv2.SIFT_create(nfeatures=6000), cv2.NORM_L2
    return "orb", cv2.ORB_create(nfeatures=8000), cv2.NORM_HAMMING


def register(
    a: np.ndarray, b: np.ndarray
) -> tuple[np.ndarray | None, int, int, str, str | None]:
    """Гомография B → A. Возвращает (H, инлайеры, хорошие совпадения, метод, причина отказа)."""
    method, det, norm = _detector()
    ka, da = det.detectAndCompute(a, None)
    kb, db = det.detectAndCompute(b, None)
    if (
        da is None
        or db is None
        or len(ka) < MIN_GOOD_MATCHES
        or len(kb) < MIN_GOOD_MATCHES
    ):
        return None, 0, 0, method, "на листе слишком мало графики для совмещения"
    pairs = cv2.BFMatcher(norm).knnMatch(db, da, k=2)
    good = [m for m, *rest in pairs if rest and m.distance < RATIO * rest[0].distance]
    if len(good) < MIN_GOOD_MATCHES:
        return (
            None,
            0,
            len(good),
            method,
            f"мало общих ключевых точек ({len(good)} < {MIN_GOOD_MATCHES}) — листы разные",
        )
    src = np.float32([kb[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([ka[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(
        src, dst, cv2.RANSAC, RANSAC_PX, maxIters=5000, confidence=0.999
    )
    inliers = int(mask.sum()) if mask is not None else 0
    if H is None or inliers < MIN_INLIERS or inliers < MIN_INLIER_RATIO * len(good):
        return (
            None,
            inliers,
            len(good),
            method,
            (f"гомография ненадёжна: инлайеров {inliers} из {len(good)} "
            f"(нужно ≥ {MIN_INLIERS} и ≥ {MIN_INLIER_RATIO:.0%} совпадений)"),
        )
    bad = degenerate(H, b.shape, a.shape)
    if bad:
        return None, inliers, len(good), method, bad
    return H, inliers, len(good), method, None


def degenerate(
    H: np.ndarray, shape_b: tuple[int, ...], shape_a: tuple[int, ...]
) -> str | None:
    """Проверка, что гомография — «тот же лист, сдвинутый/повёрнутый/отмасштабированный»."""
    H = H / H[2, 2]
    if abs(H[2, 0]) > MAX_PERSPECTIVE or abs(H[2, 1]) > MAX_PERSPECTIVE:
        return "гомография вырождена: сильная перспектива"
    sv = np.linalg.svd(H[:2, :2], compute_uv=False)
    if sv[1] <= 1e-9 or not (
        SCALE_RANGE[0] <= float(np.sqrt(sv[0] * sv[1])) <= SCALE_RANGE[1]
    ):
        return "гомография вырождена: недопустимый масштаб"
    if sv[0] / sv[1] > MAX_ANISOTROPY:
        return "гомография вырождена: лист растянут по одной оси"
    if np.linalg.det(H[:2, :2]) < 0:
        return "гомография вырождена: зеркальное отражение"
    hb, wb = shape_b[:2]
    quad = cv2.perspectiveTransform(
        np.float32([[0, 0], [wb, 0], [wb, hb], [0, hb]]).reshape(-1, 1, 2), H
    ).reshape(-1, 2)
    if not cv2.isContourConvex(quad.astype(np.float32)):
        return "гомография вырождена: контур листа самопересекается"
    ha, wa = shape_a[:2]
    overlap = cv2.contourArea(quad) / float(wa * ha)
    if overlap < 0.3:
        return f"листы перекрываются лишь на {overlap:.0%}"
    return None


# ─────────────────────────────────────────────── OS-INSP-3.4.2 карта изменений


def change_map(
    a: np.ndarray, bw: np.ndarray, valid: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Бинарная карта изменений и карта SSIM (обе размером листа A)."""
    _, ssim = structural_similarity(a, bw, win_size=SSIM_WIN, data_range=255, full=True)
    k = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * TOLERANCE_PX + 1, 2 * TOLERANCE_PX + 1)
    )
    near_a = cv2.dilate((a < INK_NEAR).astype(np.uint8), k)
    near_b = cv2.dilate((bw < INK_NEAR).astype(np.uint8), k)
    only_a = (a < INK) & (near_b == 0)  # было на A, пропало на B
    only_b = (bw < INK) & (near_a == 0)  # появилось на B
    changed = (only_a | only_b) & (ssim < SSIM_CHANGED) & valid
    return changed.astype(np.uint8), ssim


def ink_agreement(a: np.ndarray, bw: np.ndarray, valid: np.ndarray) -> float:
    """Доля линий листа A (в зоне перекрытия), у которых на совмещённом листе B есть линия рядом."""
    k = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * TOLERANCE_PX + 1, 2 * TOLERANCE_PX + 1)
    )
    ink_a = (a < INK) & valid
    total = int(ink_a.sum())
    if total == 0:
        return 0.0
    near_b = cv2.dilate((bw < INK_NEAR).astype(np.uint8), k) > 0
    return float((ink_a & near_b).sum()) / total


def _merge(boxes: list[list[int]], gap: int) -> list[list[int]]:
    """Слить прямоугольники [x0, y0, x1, y1], если зазор между ними ≤ gap (до неподвижной точки)."""
    boxes = [b[:] for b in boxes]
    merged = True
    while merged:
        merged = False
        out: list[list[int]] = []
        for b in boxes:
            for o in out:
                if (
                    b[0] <= o[2] + gap
                    and o[0] <= b[2] + gap
                    and b[1] <= o[3] + gap
                    and o[1] <= b[3] + gap
                ):
                    o[0], o[1], o[2], o[3] = (
                        min(o[0], b[0]),
                        min(o[1], b[1]),
                        max(o[2], b[2]),
                        max(o[3], b[3]),
                    )
                    merged = True
                    break
            else:
                out.append(b)
        boxes = out
    return boxes


def regions(
    changed: np.ndarray, ssim: np.ndarray, H: np.ndarray, size_b: tuple[int, int]
) -> list[Region]:
    ha, wa = changed.shape
    closed = cv2.morphologyEx(
        changed,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_PX, CLOSE_PX)),
    )
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        boxes.append([x, y, x + w, y + h])
    gap = int(MERGE_GAP * float(np.hypot(wa, ha)))
    Hinv = np.linalg.inv(H)
    wb, hb = size_b
    out: list[Region] = []
    for x0, y0, x1, y1 in _merge(boxes, gap):
        ink = int(changed[y0:y1, x0:x1].sum())
        if (
            ink < MIN_INK_PX
            or min(x1 - x0, y1 - y0) < MIN_SIDE_PX
            and ink < 4 * MIN_INK_PX
        ):
            continue  # отсечение шума
        dis = 1.0 - ssim[y0:y1, x0:x1][changed[y0:y1, x0:x1] > 0]
        area = (x1 - x0) * (y1 - y0) / float(wa * ha)
        # значимость: сила структурного расхождения × насыщенность области изменениями (log-шкала размера)
        strength = float(np.clip(dis.mean(), 0, 1)) if dis.size else 0.0
        size = float(np.clip(np.log10(1 + ink) / 4, 0, 1))
        score = round(float(np.clip(0.6 * strength + 0.4 * size, 0, 1)), 3)
        corners = np.float32([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]).reshape(-1, 1, 2)
        pb = cv2.perspectiveTransform(corners, Hinv).reshape(-1, 2)
        out.append(
            Region(
                bbox_a=_norm(x0, y0, x1, y1, wa, ha),
                bbox_b=_norm(
                    pb[:, 0].min(),
                    pb[:, 1].min(),
                    pb[:, 0].max(),
                    pb[:, 1].max(),
                    wb,
                    hb,
                ),
                score=score,
                area=round(area, 6),
            )
        )
    out.sort(key=lambda r: -r.score)
    return out


def _norm(
    x0: float, y0: float, x1: float, y1: float, w: int, h: int
) -> tuple[float, float, float, float]:
    c = lambda v: round(float(min(max(v, 0.0), 1.0)), 5)
    return (c(x0 / w), c(y0 / h), c(x1 / w), c(y1 / h))


# ─────────────────────────────────────────────── вход


def diff_images(a: np.ndarray, b: np.ndarray) -> DiffResult:
    t0 = time.monotonic()
    H, inl, good, method, why = register(a, b)
    res = DiffResult(
        status="ok",
        inliers=inl,
        matches=good,
        method=method,
        size_a=(a.shape[1], a.shape[0]),
        size_b=(b.shape[1], b.shape[0]),
    )
    if H is None:
        res.status, res.reason = "not_comparable", why  # OS-INSP-3.4.4
        res.ms = int((time.monotonic() - t0) * 1000)
        return res
    ha, wa = a.shape
    bw = cv2.warpPerspective(b, H, (wa, ha), flags=cv2.INTER_LINEAR, borderValue=255)
    valid = cv2.warpPerspective(
        np.full(b.shape, 255, np.uint8),
        H,
        (wa, ha),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    )
    valid = cv2.erode(valid, np.ones((2 * EDGE_PX + 1, 2 * EDGE_PX + 1), np.uint8)) > 0
    agree = ink_agreement(a, bw, valid)
    if agree < MIN_INK_AGREEMENT:
        # гомография нашлась, но после совмещения линии не совпадают: чужой лист (OS-INSP-3.4.4)
        res.status, res.reason = (
            "not_comparable",
            f"после совмещения совпадает лишь {agree:.0%} линий листа — листы разные",
        )
        res.ms = int((time.monotonic() - t0) * 1000)
        return res
    changed, ssim = change_map(a, bw, valid)
    res.regions = regions(changed, ssim, H, res.size_b)
    res.ms = int((time.monotonic() - t0) * 1000)
    return res


def diff_pages(path_a: Path, page_a: int, path_b: Path, page_b: int) -> DiffResult:
    t0 = time.monotonic()
    a = render_gray(path_a, page_a)
    b = render_gray(path_b, page_b)
    res = diff_images(a, b)
    res.ms = int((time.monotonic() - t0) * 1000)
    return res
