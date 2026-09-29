"""Вид страницы PDF «вектор / скан / гибрид» и векторные пути листа (T-127, исследование — шаги 1 и 4a).

Сейчас разбор (`parse.py`) решает только по порогу текста: есть слой — читаем, нет — OCR всей страницы.
Исследование мировых практик предлагает до чтения понять, что лежит на странице:

  - vector — CAD-выгрузка: текстовый слой и пути, изображений мало; геометрию можно брать из путей без растра;
  - scan   — почти одно полностраничное изображение, текста нет или мало: только растровая ветка (OCR, Хаф);
  - hybrid — скан с текстовым слоем OCR, вектор с крупными растровыми вставками или «текст кривыми»
             (SHX-шрифты AutoCAD и TrueType-как-геометрия: много мелких путей, мало символов) —
             текстовому слою такой страницы верить нельзя целиком;
  - empty  — на странице нет ни текста, ни путей, ни изображений.

Признаки считаются перебором объектов страницы через pdfium (Apache/BSD; PyMuPDF — AGPL-3.0, не берём):
TEXT, PATH, IMAGE, SHADING, FORM — формы (XObject) обходятся рекурсивно с накоплением матрицы.
Правило вида — чистая функция `classify` над признаками, пороги — константы модуля.

Векторные пути: точки сегментов → матрица объекта (и всех объемлющих форм) → координаты страницы PDF →
доли видимой страницы тем же аффинным преобразованием, что `parse._to_norm` (FPDF_PageToDevice: CropBox
и /Rotate учтены), но без обрезки в [0;1]: отрезок, выходящий за видимую область, обрезается геометрически
(Лианг — Барски), а не «прилипает» к краю. Кривые Безье — ломаной из BEZIER_STEPS звеньев.

Всё, что трогает pdfium, — под PDFIUM_LOCK (pdfium не потокобезопасен); функции над готовой страницей
(`page_features`, `page_vectors`) ждут, что замок уже взят вызывающим.
"""

from __future__ import annotations

import ctypes
import math
from dataclasses import dataclass
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .measure import MIN_DIM_PX, Segment
from .parse import _GRID, MIN_TEXT_CHARS, PDFIUM_LOCK, CorruptedFile

# ─────────────────────────────────────────────── пороги

FULL_PAGE_IMAGE = 0.85  # одно изображение закрывает ≥ 85 % видимой страницы — «полностраничное» (скан)
SCAN_IMAGE_SHARE = 0.85  # изображения вместе закрывают ≥ 85 % — страница растровая, даже если скан нарезан полосами
RASTER_INSET_SHARE = 0.10  # вставки ≥ 10 % площади на векторном листе — гибрид (фото, растровая подложка)
VECTOR_MIN_SEGMENTS = 50  # меньше сегментов — это рамка или обрезка скана, а не чертёж
SMALL_PATH_PT = 20.0  # путь, чья рамка по обеим сторонам ≤ 20 pt (≈ 7 мм), — размер буквы, кандидат в «текст кривыми»
SHX_MIN_SMALL_PATHS = 200  # «текст кривыми»: не меньше 200 мелких путей…
SHX_SMALL_SHARE = 0.5  # …они — не меньше половины всех путей…
SHX_PATHS_PER_CHAR = 5  # …и их в 5 раз больше, чем символов текстового слоя
BEZIER_STEPS = 8  # звеньев ломаной на одну кривую Безье
MAX_FORM_DEPTH = (
    16  # вложенность форм глубже — битый или враждебный файл, дальше не спускаемся
)
MAX_SEGMENTS = (
    500_000  # потолок отрезков на страницу (правило №0: «взорванные» блоки CAD)
)

_T_TEXT = pdfium_c.FPDF_PAGEOBJ_TEXT
_T_PATH = pdfium_c.FPDF_PAGEOBJ_PATH
_T_IMAGE = pdfium_c.FPDF_PAGEOBJ_IMAGE
_T_SHADING = pdfium_c.FPDF_PAGEOBJ_SHADING
_T_FORM = pdfium_c.FPDF_PAGEOBJ_FORM

Matrix = tuple[
    float, float, float, float, float, float
]  # a b c d e f: x' = a·x + c·y + e, y' = b·x + d·y + f
_IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


# ─────────────────────────────────────────────── структуры


@dataclass(frozen=True)
class PageFeatures:
    """Признаки страницы для правила вида. Площади — доли видимой страницы (после CropBox и /Rotate)."""

    text_chars: int = 0  # непробельные символы текстового слоя
    text_objects: int = 0
    invisible_text: int = (
        0  # текстовые объекты с режимом «невидимый» (типичный слой OCR поверх скана)
    )
    path_objects: int = 0
    path_segments: int = 0
    small_paths: int = 0  # пути размером с букву (SMALL_PATH_PT)
    image_objects: int = 0
    image_share: float = (
        0.0  # сумма площадей изображений в видимой области, не больше 1
    )
    max_image_share: float = 0.0  # самое крупное изображение
    shading_objects: int = 0
    form_objects: int = 0

    @property
    def full_page_image(self) -> bool:
        return self.max_image_share >= FULL_PAGE_IMAGE


@dataclass(frozen=True)
class PageKind:
    page: int  # с 1
    kind: str  # vector | scan | hybrid | empty
    reasons: tuple[str, ...]
    features: PageFeatures
    seconds: float = 0.0


@dataclass(frozen=True)
class VectorSegment:
    """Прямой отрезок векторного пути. Концы — доли видимой страницы, начало — левый верхний угол."""

    x0: float
    y0: float
    x1: float
    y1: float
    path: int  # номер пути на странице (порядок обхода), общий у всех отрезков одного пути
    width_pt: float  # толщина обводки в pt страницы (с учётом масштаба матрицы); 0 — «волосяная»
    stroke: bool  # путь обводится
    fill_mode: int  # 0 — без заливки, 1 — чёт-нечет, 2 — ненулевое число оборотов
    stroke_rgba: tuple[int, int, int, int] | None = None
    fill_rgba: tuple[int, int, int, int] | None = None
    dash: tuple[float, ...] = ()  # массив штриха; пусто — сплошная
    dash_phase: float = 0.0
    curve: bool = False  # звено ломаной, аппроксимирующей кривую Безье
    closing: bool = False  # замыкающее звено подпути (closepath)

    @property
    def length(self) -> float:
        return math.hypot(self.x1 - self.x0, self.y1 - self.y0)


@dataclass(frozen=True)
class PageVectors:
    page: int
    width_pt: (
        float  # видимая страница в pt — в той ориентации, в какой её видит человек
    )
    height_pt: float
    segments: tuple[VectorSegment, ...]
    truncated: bool = False  # упёрлись в MAX_SEGMENTS


# ─────────────────────────────────────────────── правило вида (чистая функция)


def text_as_curves(f: PageFeatures) -> bool:
    """SHX-случай: текст выведен геометрией — много мелких путей, их большинство, символов текстового слоя мало."""
    return (
        f.small_paths >= SHX_MIN_SMALL_PATHS
        and f.small_paths >= SHX_SMALL_SHARE * f.path_objects
        and f.small_paths > SHX_PATHS_PER_CHAR * f.text_chars
    )


def classify(f: PageFeatures) -> tuple[str, tuple[str, ...]]:
    """Вид страницы и причины. Порядок проверок: растровая основа → вектор → пусто."""
    has_text = f.text_chars >= MIN_TEXT_CHARS
    has_vector = f.path_segments >= VECTOR_MIN_SEGMENTS
    if f.full_page_image or f.image_share >= SCAN_IMAGE_SHARE:
        reasons = ["full_page_image" if f.full_page_image else "images_cover_page"]
        if has_text:
            reasons.append("ocr_text_layer" if f.invisible_text else "text_over_image")
        if has_vector:
            reasons.append("vector_over_image")
        return ("hybrid" if len(reasons) > 1 else "scan"), tuple(reasons)
    if not has_text and not has_vector:
        if f.image_share >= RASTER_INSET_SHARE:
            return "scan", ("image_without_text",)
        if f.text_chars or f.path_segments or f.image_objects or f.shading_objects:
            return "vector", ("sparse",)
        return "empty", ()
    reasons = []
    if text_as_curves(f):
        reasons.append("text_as_curves")
    if f.image_share >= RASTER_INSET_SHARE:
        reasons.append("raster_insets")
    if reasons:
        return "hybrid", tuple(reasons)
    return "vector", tuple(
        r for r, ok in (("text_layer", has_text), ("paths", has_vector)) if ok
    )


# ─────────────────────────────────────────────── геометрия


def _mul(m: Matrix, n: Matrix) -> Matrix:
    """Сначала m, затем n (вектор-строка PDF: p · m · n)."""
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (
        a * A + b * C,
        a * B + b * D,
        c * A + d * C,
        c * B + d * D,
        e * A + f * C + E,
        e * B + f * D + F,
    )


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _page_to_norm(page: pdfium.PdfPage) -> Matrix:
    """Аффинное «координаты PDF → доли видимой страницы» — то же, что parse._to_norm, но без обрезки в [0;1].

    FPDF_PageToDevice аффинен (CropBox, /Rotate, переворот оси y); три опорные точки на расстоянии SPAN pt
    дают матрицу с ошибкой округления сетки _GRID порядка 1e-5 / SPAN на pt."""
    span = 10_000.0
    pts = []
    for x, y in ((0.0, 0.0), (span, 0.0), (0.0, span)):
        dx, dy = ctypes.c_int(), ctypes.c_int()
        pdfium_c.FPDF_PageToDevice(page.raw, 0, 0, _GRID, _GRID, 0, x, y, dx, dy)
        pts.append((dx.value / _GRID, dy.value / _GRID))
    (ox, oy), (px, py), (qx, qy) = pts
    return (
        (px - ox) / span,
        (py - oy) / span,
        (qx - ox) / span,
        (qy - oy) / span,
        ox,
        oy,
    )


def _clip(
    x0: float, y0: float, x1: float, y1: float
) -> tuple[float, float, float, float] | None:
    """Отрезок, обрезанный квадратом [0;1]² (Лианг — Барски); целиком снаружи — None."""
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0), (dx, 1 - x0), (-dy, y0), (dy, 1 - y0)):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            t0 = max(t0, r)
        else:
            t1 = min(t1, r)
        if t0 > t1:
            return None
    return (x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy)


def _box_share(
    m: Matrix, left: float, bottom: float, right: float, top: float
) -> float:
    """Доля видимой страницы под рамкой объекта (углы — через матрицу, затем обрезка по [0;1])."""
    pts = [_apply(m, x, y) for x in (left, right) for y in (bottom, top)]
    x0 = max(min(p[0] for p in pts), 0.0)
    x1 = min(max(p[0] for p in pts), 1.0)
    y0 = max(min(p[1] for p in pts), 0.0)
    y1 = min(max(p[1] for p in pts), 1.0)
    return max(x1 - x0, 0.0) * max(y1 - y0, 0.0)


def _bezier(p0, p1, p2, p3, steps: int = BEZIER_STEPS) -> list[tuple[float, float]]:
    """Точки кубической кривой Безье без начальной: steps звеньев ломаной."""
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append(
            (
                u**3 * p0[0]
                + 3 * u * u * t * p1[0]
                + 3 * u * t * t * p2[0]
                + t**3 * p3[0],
                u**3 * p0[1]
                + 3 * u * u * t * p1[1]
                + 3 * u * t * t * p2[1]
                + t**3 * p3[1],
            )
        )
    return out


# ─────────────────────────────────────────────── обход объектов pdfium


def _obj_matrix(obj) -> Matrix:
    m = pdfium_c.FS_MATRIX()
    if not pdfium_c.FPDFPageObj_GetMatrix(obj, m):
        return _IDENTITY
    return (m.a, m.b, m.c, m.d, m.e, m.f)


def _bounds(obj) -> tuple[float, float, float, float] | None:
    l, b, r, t = (ctypes.c_float() for _ in range(4))
    if not pdfium_c.FPDFPageObj_GetBounds(obj, l, b, r, t):
        return None
    return (l.value, b.value, r.value, t.value)


def _walk(page: pdfium.PdfPage):
    """Объекты страницы с матрицей объемлющих форм (координаты объекта → координаты страницы PDF).

    Рамка (GetBounds) и матрица (GetMatrix) объекта внутри формы заданы в пространстве формы —
    их переводит на страницу накопленная матрица форм. Сама форма тоже отдаётся (для счёта)."""
    stack = [
        (pdfium_c.FPDFPage_GetObject(page.raw, i), _IDENTITY, 0)
        for i in range(pdfium_c.FPDFPage_CountObjects(page.raw))
    ]
    stack.reverse()
    while stack:
        obj, parent, depth = stack.pop()
        if not obj:
            continue
        kind = pdfium_c.FPDFPageObj_GetType(obj)
        yield obj, kind, parent
        if kind == _T_FORM and depth < MAX_FORM_DEPTH:
            inner = _mul(_obj_matrix(obj), parent)
            n = pdfium_c.FPDFFormObj_CountObjects(obj)
            stack.extend(
                (pdfium_c.FPDFFormObj_GetObject(obj, i), inner, depth + 1)
                for i in reversed(range(max(n, 0)))
            )


def _text_chars(page: pdfium.PdfPage) -> int:
    tp = page.get_textpage()
    try:
        n = tp.count_chars()
        return sum(
            1 for ch in (tp.get_text_range(0, n) if n > 0 else "") if not ch.isspace()
        )
    finally:
        tp.close()


def page_features(page: pdfium.PdfPage) -> PageFeatures:
    """Признаки страницы. Вызывать под PDFIUM_LOCK."""
    to_norm = _page_to_norm(page)
    c = {"text_objects": 0, "invisible_text": 0, "path_objects": 0, "path_segments": 0, "small_paths": 0,
             "image_objects": 0, "shading_objects": 0, "form_objects": 0}  # fmt: skip
    image_share = max_image = 0.0
    for obj, kind, parent in _walk(page):
        if kind == _T_TEXT:
            c["text_objects"] += 1
            if (
                pdfium_c.FPDFTextObj_GetTextRenderMode(obj)
                == pdfium_c.FPDF_TEXTRENDERMODE_INVISIBLE
            ):
                c["invisible_text"] += 1
        elif kind == _T_PATH:
            c["path_objects"] += 1
            c["path_segments"] += max(pdfium_c.FPDFPath_CountSegments(obj), 0)
            box = _bounds(obj)
            if box is not None:
                pts = [
                    _apply(parent, x, y)
                    for x in (box[0], box[2])
                    for y in (box[1], box[3])
                ]
                w = max(p[0] for p in pts) - min(p[0] for p in pts)
                h = max(p[1] for p in pts) - min(p[1] for p in pts)
                if w <= SMALL_PATH_PT and h <= SMALL_PATH_PT:
                    c["small_paths"] += 1
        elif kind == _T_IMAGE:
            c["image_objects"] += 1
            box = _bounds(obj)
            if box is not None:
                share = _box_share(_mul(parent, to_norm), *box)
                image_share += share
                max_image = max(max_image, share)
        elif kind == _T_SHADING:
            c["shading_objects"] += 1
        elif kind == _T_FORM:
            c["form_objects"] += 1
    return PageFeatures(
        text_chars=_text_chars(page),
        image_share=round(min(image_share, 1.0), 4),
        max_image_share=round(max_image, 4),
        **c,
    )


def _rgba(getter, obj) -> tuple[int, int, int, int] | None:
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not getter(obj, r, g, b, a):
        return None
    return (r.value, g.value, b.value, a.value)


def _dash(obj) -> tuple[tuple[float, ...], float]:
    n = pdfium_c.FPDFPageObj_GetDashCount(obj)
    if n <= 0:
        return (), 0.0
    arr = (ctypes.c_float * n)()
    phase = ctypes.c_float()
    if not pdfium_c.FPDFPageObj_GetDashArray(obj, arr, n):
        return (), 0.0
    pdfium_c.FPDFPageObj_GetDashPhase(obj, phase)
    return tuple(round(v, 4) for v in arr), round(phase.value, 4)


def _path_points(obj) -> list[tuple[str, tuple[float, float], bool]]:
    """Сегменты пути в его собственных координатах: (тип, точка, замыкает подпуть)."""
    out = []
    x, y = ctypes.c_float(), ctypes.c_float()
    for i in range(max(pdfium_c.FPDFPath_CountSegments(obj), 0)):
        seg = pdfium_c.FPDFPath_GetPathSegment(obj, i)
        if not seg or not pdfium_c.FPDFPathSegment_GetPoint(seg, x, y):
            continue
        t = pdfium_c.FPDFPathSegment_GetType(seg)
        kind = {pdfium_c.FPDF_SEGMENT_MOVETO: "M", pdfium_c.FPDF_SEGMENT_LINETO: "L",
                pdfium_c.FPDF_SEGMENT_BEZIERTO: "C"}.get(t)  # fmt: skip
        if kind:
            out.append(
                (kind, (x.value, y.value), bool(pdfium_c.FPDFPathSegment_GetClose(seg)))
            )
    return out


def _polyline(
    points,
) -> list[tuple[tuple[float, float], tuple[float, float], bool, bool]]:
    """Сегменты пути → прямые звенья (начало, конец, звено кривой, замыкающее). Безье — три точки подряд «C»."""
    edges = []
    start = cur = None
    i = 0
    while i < len(points):
        kind, p, close = points[i]
        if kind == "M" or cur is None:
            start = cur = p
        elif kind == "L":  # явное «назад к началу» с флагом замыкания — тоже замыкающее звено
            edges.append((cur, p, False, close and p == start))
            cur = p
        else:  # «C»: две контрольные и конец; флаг замыкания — у последней
            if i + 2 >= len(points):
                break
            c1, c2, (_, end, close) = p, points[i + 1][1], points[i + 2]
            prev = cur
            for q in _bezier(cur, c1, c2, end):
                edges.append((prev, q, True, False))
                prev = q
            cur = end
            i += 2
        if close and start is not None and cur != start:
            edges.append((cur, start, False, True))
            cur = start
        i += 1
    return edges


def page_vectors(
    page: pdfium.PdfPage, number: int = 1, max_segments: int = MAX_SEGMENTS
) -> PageVectors:
    """Прямые отрезки всех видимых путей страницы. Вызывать под PDFIUM_LOCK."""
    to_norm = _page_to_norm(page)
    out: list[VectorSegment] = []
    truncated = False
    path_no = -1
    fill = ctypes.c_int()
    stroke = ctypes.c_int()
    width = ctypes.c_float()
    for obj, kind, parent in _walk(page):
        if kind != _T_PATH:
            continue
        path_no += 1
        if not pdfium_c.FPDFPath_GetDrawMode(obj, fill, stroke):
            continue
        if fill.value == pdfium_c.FPDF_FILLMODE_NONE and not stroke.value:
            continue  # невидимый путь
        to_page = _mul(_obj_matrix(obj), parent)
        m = _mul(to_page, to_norm)
        scale = math.sqrt(abs(to_page[0] * to_page[3] - to_page[1] * to_page[2]))
        w = (
            round(width.value * scale, 4)
            if pdfium_c.FPDFPageObj_GetStrokeWidth(obj, width)
            else 0.0
        )
        dash, phase = _dash(obj)
        s_rgba = (
            _rgba(pdfium_c.FPDFPageObj_GetStrokeColor, obj) if stroke.value else None
        )
        f_rgba = _rgba(pdfium_c.FPDFPageObj_GetFillColor, obj) if fill.value else None
        for a, b, curve, closing in _polyline(_path_points(obj)):
            ax, ay = _apply(m, *a)
            bx, by = _apply(m, *b)
            clipped = _clip(ax, ay, bx, by)
            if clipped is None:
                continue
            if len(out) >= max_segments:
                truncated = True
                break
            out.append(
                VectorSegment(
                    *(round(v, 6) for v in clipped),
                    path=path_no,
                    width_pt=w,
                    stroke=bool(stroke.value),
                    fill_mode=fill.value,
                    stroke_rgba=s_rgba,
                    fill_rgba=f_rgba,
                    dash=dash,
                    dash_phase=phase,
                    curve=curve,
                    closing=closing,
                )
            )
        if truncated:
            break
    w_pt, h_pt = page.get_size()  # pdfium уже отдаёт видимые размеры: CropBox, повёрнутый по /Rotate
    return PageVectors(
        page=number,
        width_pt=w_pt,
        height_pt=h_pt,
        segments=tuple(out),
        truncated=truncated,
    )


# ─────────────────────────────────────────────── файл целиком (под замком)


def _open(path: Path) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as e:
        raise CorruptedFile(f"повреждённый PDF: {path.name}") from e


def detect_pages(path: Path, pages: list[int] | None = None) -> list[PageKind]:
    """Вид каждой страницы (номера с 1; None — все). Под PDFIUM_LOCK."""
    import time

    with PDFIUM_LOCK:
        doc = _open(path)
        try:
            numbers = pages if pages is not None else list(range(1, len(doc) + 1))
            out = []
            for n in numbers:
                if not 1 <= n <= len(doc):
                    continue
                t = time.perf_counter()
                page = doc[n - 1]
                try:
                    f = page_features(page)
                finally:
                    page.close()
                kind, reasons = classify(f)
                out.append(
                    PageKind(n, kind, reasons, f, round(time.perf_counter() - t, 4))
                )
            return out
        finally:
            doc.close()


def extract_vectors(
    path: Path, number: int, max_segments: int = MAX_SEGMENTS
) -> PageVectors:
    """Векторные отрезки страницы number (с 1). Под PDFIUM_LOCK."""
    with PDFIUM_LOCK:
        doc = _open(path)
        try:
            if not 1 <= number <= len(doc):
                raise IndexError(f"нет страницы {number}: в документе {len(doc)}")
            page = doc[number - 1]
            try:
                return page_vectors(page, number, max_segments)
            finally:
                page.close()
        finally:
            doc.close()


# ─────────────────────────────────────────────── мост в measure.py


def segments_from_vector(
    vectors: PageVectors,
    image_size: tuple[int, int],
    min_len_px: float = MIN_DIM_PX,
    stroked_only: bool = True,
    with_curves: bool = False,
) -> list[Segment]:
    """Векторные отрезки → `measure.Segment` в пикселях растра image_size (как у `measure.segments`).

    Соглашение measure: концы — центры крайних пикселей оси, length = span + 1. Отрезок PDF длиной L px
    закрашивает пиксели с центрами от a+½ до b−½, поэтому концы сдвигаются внутрь на ½ px — length совпадает
    с геометрической длиной. Толщина — толщина обводки в px (волосяная — 1 px). Ориентация (горизонт,
    вертикаль, наклон) — `measure.orientation(s.angle)`, как у растровых отрезков. Дубли (тот же отрезок
    дважды, в т. ч. в обратном направлении) отбрасываются; слияние коллинеарных кусков — не делается."""
    w_px, h_px = image_size
    px_per_pt = w_px / vectors.width_pt if vectors.width_pt else 0.0
    out: list[Segment] = []
    seen: set[tuple[float, float, float, float]] = set()
    for v in vectors.segments:
        if stroked_only and not v.stroke:
            continue
        if v.curve and not with_curves:
            continue
        x0, y0, x1, y1 = v.x0 * w_px, v.y0 * h_px, v.x1 * w_px, v.y1 * h_px
        span = math.hypot(x1 - x0, y1 - y0)
        if span < min_len_px or span <= 1:
            continue
        ux, uy = (x1 - x0) / span / 2, (y1 - y0) / span / 2
        a, b = (
            (round(x0 + ux, 2), round(y0 + uy, 2)),
            (round(x1 - ux, 2), round(y1 - uy, 2)),
        )
        key = (*min(a, b), *max(a, b))
        if key in seen:
            continue
        seen.add(key)
        out.append(
            Segment(a[0], a[1], b[0], b[1], thick=max(v.width_pt * px_per_pt, 1.0))
        )
    return out
