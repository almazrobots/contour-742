"""Паспорт страницы PDF до распознавания (T-216, OS-INSP-2.1.70–2.1.77).

Дешёвая предобработка каждой страницы: признаки, которые pdfium считает без OCR и без GPU, и по ним — маршрут
страницы в конвейере. На ИД одного объекта из 5 557 страниц OCR нужен только 1 343, а 1 038 пустых и подписных
листов можно не отправлять никуда — нагрузка на GPU падает примерно вчетверо (замер T-165).

Основа — правило T-165 (a3), взято один в один как пороги по умолчанию:
  - формат: короткая и длинная стороны в мм против А4…А0 с допуском +8 %; не влезло в А0 — LARGER, влезло в А5 — SMALLER;
  - класс: текст слоя (get_text_bounded().strip()) ≥ 30 символов → TEXT; иначе изображения закрывают > 0,5 листа → SCAN;
    иначе путей > 300 → VECTOR; иначе — пусто или подпись.
Новое против a3: поля подписи (аннотации Widget) разделяют «пусто или подпись» на SIGNATURE_SHEET и BLANK, а текстовый
слой поверх скана (> 0,5 площади) — отдельный класс MIXED.

Маршрут по классу: TEXT, MIXED → TEXT_LAYER; SCAN → OCR; VECTOR → CV (анализ чертежа); SIGNATURE_SHEET, BLANK → SKIP.

Паспорт — только числа и коды: ни одного слова документа (ADR-0002, корпус не выносится даже фрагментом текста).
Все пороги — константы ниже, в одном месте, для калибровки на сервере.

Объекты обходятся сырым pdfium (быстрее обёрток pypdfium2 на листах CAD с сотнями тысяч путей) с тем же пределом
вложенности форм, что `page.get_objects(max_depth=3)` в a3; рамки объектов — FPDFPageObj_GetBounds в координатах
своего уровня, как в a3 (матрицы форм не накапливаются — для паспорта довольно).

pdfium не потокобезопасен: `passport(page)` ждёт, что PDFIUM_LOCK уже взят вызывающим; `passport_file` берёт его сам.
PARSER_REV, ParsedDoc и parse_file модуль не трогает.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .resource_scope import render_guarded

from .parse import OCR_DPI, PDFIUM_LOCK, CorruptedFile, _to_norm, render_scale

# ─────────────────────────────────────────────── пороги (T-165 a3 — по умолчанию; калибруются здесь и только здесь)

MM_PER_PT = 25.4 / 72
FORMATS = (
    ("A4", 210, 297),
    ("A3", 297, 420),
    ("A2", 420, 594),
    ("A1", 594, 841),
    ("A0", 841, 1189),
)  # мм
SMALLER_MM = (148, 210)  # влезло в А5 с допуском — «меньше А4» (квитанции, бирки)
FORMAT_TOLERANCE = (
    0.08  # +8 % к сторонам формата: поля сканера и нестандартные выгрузки
)
TEXT_MIN_CHARS = 30  # текст слоя (strip) не короче — страница текстовая
SCAN_IMAGE_SHARE = 0.5  # изображения вместе закрывают больше половины листа — скан
VECTOR_MIN_PATHS = 300  # путей больше — векторный чертёж
MAX_OBJ_DEPTH = 3  # вложенность форм, как get_objects(max_depth=3) в a3
FULL_PAGE_IMAGE = 0.85  # одно изображение закрывает ≥ 85 % листа — полностраничное
SQUARE_TOLERANCE = 0.02  # стороны отличаются меньше чем на 2 % — ориентация square
# рендер для «чернил»: очень низкое разрешение и потолок пикселей — дёшево и на А0
INK_DPI = 15
# рендер «чернил» декодирует картинку целиком даже при 15 dpi: скан 600 dpi на А0 — гигабайты памяти (OOM на корпусе,
# 28.09). Лист с картинкой крупнее — «чернила» не считаются (None, hints.ink_skipped), класс и маршрут — как обычно.
INK_MAX_IMAGE_MPX = 40.0
INK_MAX_PX = 250_000
INK_WHITE = 235  # среднее по каналам ≥ 235 — почти белый пиксель (бумага)
INK_DARK = 96  # среднее < 96 — тёмный (текст, линии, штамп)
INK_COLOR = (
    60  # max − min каналов > 60 — насыщенный цвет (синие печати, красные штампы)
)
# подсказки
OCR_DPI_MIN = 200  # ниже не рендерим для OCR даже по слабому скану
GARBAGE_BROKEN = (
    0.3  # доля «мусорных» символов, с которой текстовый слой считается битым
)
TABLE_SHORT_CHARS = (
    12  # строка не длиннее (без пробелов) — «короткая», как ячейка таблицы
)
TABLE_MIN_SHORT_LINES = 8
TABLE_SHORT_SHARE = 0.5

CLASSES = ("TEXT", "SCAN", "VECTOR", "SIGNATURE_SHEET", "BLANK", "MIXED")
ROUTES = {"TEXT": "TEXT_LAYER", "MIXED": "TEXT_LAYER", "SCAN": "OCR", "VECTOR": "CV",
          "SIGNATURE_SHEET": "SKIP", "BLANK": "SKIP"}  # fmt: skip
# Встраивание в разбор (T-216, условия T-233): INSPECTOR_PAGE_PASSPORT=off|skip, по умолчанию off. skip — пустой лист
# и лист подписи не рисуются и не идут в OCR; прочие классы идут своим путём, как без паспорта.
SKIP_CLASSES = frozenset({"SIGNATURE_SHEET", "BLANK"})
MODES = ("off", "skip")


def mode(env: dict | None = None) -> str:
    """Режим паспорта в разборе; незнакомое значение — off (безопасно: разбор как раньше)."""
    e = os.environ if env is None else env
    m = (e.get("INSPECTOR_PAGE_PASSPORT") or "off").strip().lower()
    return m if m in MODES else "off"


def signature() -> str:
    """Пороги, от которых зависит пропуск страницы, — в ключ кэша разбора (ocr_tag): другие пороги — другое прочтение."""
    return f"{TEXT_MIN_CHARS},{SCAN_IMAGE_SHARE},{VECTOR_MIN_PATHS},{MAX_OBJ_DEPTH}"


# типографика, законная в русской технической документации; всё прочее вне кириллицы/латиницы/цифр — «мусор»
_TYPO = set("«»—–№°±×²³…‘’‚“”„•·≤≥≈≠∅Øø⌀µΩ§√∞‰€₽")
_T_TEXT = pdfium_c.FPDF_PAGEOBJ_TEXT
_T_PATH = pdfium_c.FPDF_PAGEOBJ_PATH
_T_IMAGE = pdfium_c.FPDF_PAGEOBJ_IMAGE
_T_FORM = pdfium_c.FPDF_PAGEOBJ_FORM


# ─────────────────────────────────────────────── чистые функции над числами


def paper_format(width_mm: float, height_mm: float) -> str:
    """Формат листа по сторонам в мм: наименьший из А4…А0, куда лист влезает с допуском; SMALLER — влез в А5."""
    short, long = sorted((width_mm, height_mm))
    k = 1 + FORMAT_TOLERANCE
    if short <= SMALLER_MM[0] * k and long <= SMALLER_MM[1] * k:
        return "SMALLER"
    for name, s, l in FORMATS:
        if short <= s * k and long <= l * k:
            return name
    return "LARGER"


def orientation(width: float, height: float) -> str:
    if abs(width - height) <= SQUARE_TOLERANCE * max(width, height, 1e-9):
        return "square"
    return "landscape" if width > height else "portrait"


def char_kind(ch: str) -> str:
    """cyr / lat / digit / punct / space / garbage — класс символа для долей текстового слоя."""
    if ch.isspace():
        return "space"
    o = ord(ch)
    if 0x0400 <= o <= 0x04FF:
        return "cyr"
    if ("a" <= ch <= "z") or ("A" <= ch <= "Z"):
        return "lat"
    if "0" <= ch <= "9":
        return "digit"
    if (0x21 <= o <= 0x7E) or ch in _TYPO:
        return "punct"
    return "garbage"


def text_stats(text: str) -> dict:
    """Счётчики текстового слоя без самого текста."""
    kinds = Counter(char_kind(ch) for ch in text)
    non_space = sum(n for k, n in kinds.items() if k != "space")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    short = sum(
        1
        for ln in lines
        if sum(1 for ch in ln if not ch.isspace()) <= TABLE_SHORT_CHARS
    )
    return {
        "non_space_chars": non_space,
        "lines": len(lines),
        "short_lines": short,
        "cyr_share": round(kinds["cyr"] / non_space, 4) if non_space else 0.0,
        "garbage_share": round(kinds["garbage"] / non_space, 4) if non_space else 0.0,
    }


def classify(
    text_len: int, image_area_share: float, n_paths: int, n_widgets: int
) -> str:
    """Класс страницы по правилу T-165 (a3) + MIXED и SIGNATURE_SHEET (T-216)."""
    has_text = text_len >= TEXT_MIN_CHARS
    scan = image_area_share > SCAN_IMAGE_SHARE
    if has_text:
        return "MIXED" if scan else "TEXT"
    if scan:
        return "SCAN"
    if n_paths > VECTOR_MIN_PATHS:
        return "VECTOR"
    return "SIGNATURE_SHEET" if n_widgets >= 1 else "BLANK"


def ocr_dpi_suggest(width_pt: float, height_pt: float, max_image_dpi: float) -> int:
    """Разрешение рендера для OCR: 300 dpi (ТЗ 9.1), но не выше родного dpi скана (не ниже 200) и не выше потолка
    мегапикселей листа (parse.render_scale)."""
    dpi = float(OCR_DPI)
    if max_image_dpi > 0:
        dpi = min(dpi, max(float(OCR_DPI_MIN), max_image_dpi))
    return int(min(dpi, render_scale(width_pt, height_pt) * 72))


def expect_table(lines: int, short_lines: int) -> bool:
    """Эвристика таблицы: много коротких строк, и они — не меньше половины строк слоя."""
    return (
        short_lines >= TABLE_MIN_SHORT_LINES
        and short_lines >= TABLE_SHORT_SHARE * lines
    )


def ink_stats(rgb: np.ndarray) -> dict:
    """Доли «чернил», тёмного и цвета по растру H×W×3 (порядок каналов не важен)."""
    if rgb.size == 0:
        return {"ink_share": 0.0, "dark_share": 0.0, "color_share": 0.0}
    a = rgb[..., :3].astype(np.int16)
    mean = a.mean(axis=2)
    spread = a.max(axis=2) - a.min(axis=2)
    total = mean.size
    return {
        "ink_share": round(float((mean < INK_WHITE).sum()) / total, 4),
        "dark_share": round(float((mean < INK_DARK).sum()) / total, 4),
        "color_share": round(float((spread > INK_COLOR).sum()) / total, 4),
    }


# ─────────────────────────────────────────────── pdfium (под PDFIUM_LOCK)


def _walk(raw_page):
    """(объект, тип) всех объектов страницы и форм до глубины MAX_OBJ_DEPTH — как get_objects(max_depth=3)."""
    stack = [
        (pdfium_c.FPDFPage_GetObject(raw_page, i), 0)
        for i in reversed(range(pdfium_c.FPDFPage_CountObjects(raw_page)))
    ]
    while stack:
        obj, depth = stack.pop()
        if not obj:
            continue
        kind = pdfium_c.FPDFPageObj_GetType(obj)
        yield obj, kind
        if kind == _T_FORM and depth < MAX_OBJ_DEPTH:
            n = pdfium_c.FPDFFormObj_CountObjects(obj)
            stack.extend(
                (pdfium_c.FPDFFormObj_GetObject(obj, i), depth + 1)
                for i in reversed(range(max(n, 0)))
            )


def _bounds(obj) -> tuple[float, float, float, float] | None:
    l, b, r, t = (ctypes.c_float() for _ in range(4))
    if not pdfium_c.FPDFPageObj_GetBounds(
        obj, ctypes.byref(l), ctypes.byref(b), ctypes.byref(r), ctypes.byref(t)
    ):
        return None
    return l.value, b.value, r.value, t.value


def _objects(page: pdfium.PdfPage) -> dict:
    """Счётчики объектов и растровые признаки."""
    left, bottom, right, top = page.get_cropbox()
    area = max((right - left) * (top - bottom), 1e-9)
    n = {"n_paths": 0, "n_text_objs": 0, "n_images": 0, "n_forms": 0}
    img_area = max_img = max_dpi = max_px = 0.0
    pw, ph = ctypes.c_uint(), ctypes.c_uint()
    for obj, kind in _walk(page.raw):
        if kind == _T_PATH:
            n["n_paths"] += 1
        elif kind == _T_TEXT:
            n["n_text_objs"] += 1
        elif kind == _T_FORM:
            n["n_forms"] += 1
        elif kind == _T_IMAGE:
            n["n_images"] += 1
            box = _bounds(obj)
            if box is None:
                continue
            w = max(
                0.0, min(box[2], right) - max(box[0], left)
            )  # доля — в пределах листа
            h = max(0.0, min(box[3], top) - max(box[1], bottom))
            img_area += w * h
            max_img = max(max_img, w * h)
            bw, bh = box[2] - box[0], box[3] - box[1]
            if (
                bw > 0
                and bh > 0
                and pdfium_c.FPDFImageObj_GetImagePixelSize(
                    obj, ctypes.byref(pw), ctypes.byref(ph)
                )
            ):
                max_dpi = max(max_dpi, min(pw.value / (bw / 72), ph.value / (bh / 72)))
                max_px = max(max_px, float(pw.value) * float(ph.value))
    n["image_area_share"] = round(min(img_area / area, 1.0), 4)
    n["is_full_page_image"] = max_img / area >= FULL_PAGE_IMAGE
    n["max_image_dpi"] = round(max_dpi, 1)
    n["max_image_mpx"] = round(max_px / 1e6, 1)
    return n


def _annots(page: pdfium.PdfPage) -> dict:
    """Аннотации страницы: всего, Widget (поля форм и подписи) и доля Widget в левом верхнем квадранте видимого листа."""
    raw = page.raw
    total = max(pdfium_c.FPDFPage_GetAnnotCount(raw), 0)
    widgets = top_left = 0
    rect = pdfium_c.FS_RECTF()
    for i in range(total):
        annot = pdfium_c.FPDFPage_GetAnnot(raw, i)
        if not annot:
            continue
        try:
            if pdfium_c.FPDFAnnot_GetSubtype(annot) != pdfium_c.FPDF_ANNOT_WIDGET:
                continue
            widgets += 1
            if pdfium_c.FPDFAnnot_GetRect(annot, ctypes.byref(rect)):
                x, y = _to_norm(
                    page, (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2
                )
                top_left += x < 0.5 and y < 0.5
        finally:
            pdfium_c.FPDFPage_CloseAnnot(annot)
    return {"n_annots": total, "n_widgets": widgets,
            "widgets_top_left_share": round(top_left / widgets, 4) if widgets else 0.0}  # fmt: skip


def _ink(page: pdfium.PdfPage, width_pt: float, height_pt: float) -> dict:
    scale = min(INK_DPI / 72, (INK_MAX_PX / max(width_pt * height_pt, 1e-9)) ** 0.5)
    bitmap = render_guarded(lambda: page.render(scale=scale), width_pt, height_pt, scale)
    try:
        return ink_stats(bitmap.to_numpy())
    finally:
        bitmap.close()


def passport(page: pdfium.PdfPage) -> dict:
    """Паспорт открытой страницы. Вызывать под PDFIUM_LOCK. Только числа и коды — без текста документа."""
    t0 = time.perf_counter()
    w, h = page.get_size()  # видимый лист: CropBox и /Rotate учтены pdfium
    tp = page.get_textpage()
    try:
        chars = max(tp.count_chars(), 0)
        text = tp.get_text_bounded()
    finally:
        tp.close()
    stripped = text.strip()
    ts = text_stats(text)
    obj = _objects(page)
    ann = _annots(page)
    ink_skipped = obj["max_image_mpx"] > INK_MAX_IMAGE_MPX
    ink = {"ink_share": None, "dark_share": None, "color_share": None} if ink_skipped else _ink(page, w, h)
    cls = classify(
        len(stripped), obj["image_area_share"], obj["n_paths"], ann["n_widgets"]
    )
    width_mm, height_mm = round(w * MM_PER_PT, 1), round(h * MM_PER_PT, 1)
    out = {
        "width_mm": width_mm, "height_mm": height_mm, "format": paper_format(w * MM_PER_PT, h * MM_PER_PT),
        "orientation": orientation(w, h), "rotation": page.get_rotation(),
        "chars": chars, "non_space_chars": ts["non_space_chars"], "lines": ts["lines"],
        "cyr_share": ts["cyr_share"], "garbage_share": ts["garbage_share"], "has_text_layer": len(stripped) > 0,
        **{k: obj[k] for k in ("n_paths", "n_text_objs", "n_images", "n_forms")},
        **{k: obj[k] for k in ("image_area_share", "max_image_dpi", "max_image_mpx", "is_full_page_image")},
        **ink, **ann,
        "page_class": cls, "route": ROUTES[cls],
    }  # fmt: skip
    out["hints"] = {
        "ocr_dpi_suggest": ocr_dpi_suggest(w, h, obj["max_image_dpi"]),
        "expect_table": expect_table(ts["lines"], ts["short_lines"]),
        "text_layer_broken": ts["garbage_share"] >= GARBAGE_BROKEN,
        "ink_skipped": ink_skipped,
        "ms": round((time.perf_counter() - t0) * 1000, 2),
    }
    return out


def passport_file(path: Path) -> list[dict]:
    """Паспорта всех страниц файла (номер страницы — с 1). Документ открывается под общим PDFIUM_LOCK."""
    with PDFIUM_LOCK:
        try:
            doc = pdfium.PdfDocument(str(path))
        except pdfium.PdfiumError as e:
            raise CorruptedFile(f"повреждённый PDF: {Path(path).name}") from e
        try:
            out = []
            for i in range(len(doc)):
                page = doc[i]
                try:
                    out.append({"page": i + 1, **passport(page)})
                finally:
                    page.close()
            return out
        finally:
            doc.close()


# ─────────────────────────────────────────────── CLI: замер на сервере агрегатами


def summary(passports: list[dict]) -> dict:
    """Агрегаты по страницам: классы, маршруты, форматы, время — без имён страниц и текста."""
    ms = sorted(p["hints"]["ms"] for p in passports)
    return {
        "pages": len(passports),
        "classes": dict(Counter(p["page_class"] for p in passports)),
        "routes": dict(Counter(p["route"] for p in passports)),
        "formats": dict(Counter(p["format"] for p in passports)),
        "ms_total": round(sum(ms), 1),
        "ms_p50": ms[len(ms) // 2] if ms else 0.0,
        "ms_max": ms[-1] if ms else 0.0,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m inspector_ml.page_passport",
        description="Паспорт страниц PDF (T-216)",
    )
    ap.add_argument("pdf", nargs="+", type=Path)
    ap.add_argument(
        "--json",
        action="store_true",
        help="паспорта постранично, JSON Lines: {file, pages}",
    )
    a = ap.parse_args(argv)
    every: list[dict] = []
    code = 0
    for p in a.pdf:
        try:
            pages = passport_file(p)
        except CorruptedFile as e:
            print(
                json.dumps({"file": str(p), "error": str(e)}, ensure_ascii=False),
                file=sys.stderr,
            )
            code = 1
            continue
        every.extend(pages)
        if a.json:
            print(json.dumps({"file": str(p), "pages": pages}, ensure_ascii=False))
    if not a.json:
        print(json.dumps(summary(every), ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
