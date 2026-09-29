"""Отметки изменений на листе — вход пост-оператора CMP-29 «легитимность изменения» (T-177, каталог TO-BE §5).

  * IDN-04 облако ревизии — замкнутый путь из дуг с изломами на стыках («волнистая» линия), номер изменения —
    цифра в треугольнике рядом с облаком или выноска «Изм. N» рядом;
  * IDN-04 выноска «Изм. №N», «изм.3» на поле листа — из текстового слоя ParsedDoc;
  * IDN-03 строка таблицы изменений основной надписи (графы 14–19) — через titleblock.read_title_block.

Работает поверх текущего ParsedDoc: формат разбора не меняется (ADR-0008 п. 5). Облака и треугольники берутся
из путей PDF отдельным проходом pdfium под PDFIUM_LOCK (pdfium не потокобезопасен). Координаты — доли видимой
страницы, начало — левый верхний угол, как в parse.py.

Облако отличается от окружности и эллипса, собранных из кривых Безье, тем, что касательная на стыках дуг рвётся
(остриё между «пузырями»); у окружности стыки гладкие. Полилиния-облако (CAD, дуги разбиты на короткие отрезки) —
много звеньев с малым поворотом и периодические острые изломы; у прямоугольника изломов 4 и мелких звеньев нет.
"""

from __future__ import annotations

import logging
import math
import re
import time
from pathlib import Path

import pypdfium2.raw as pdfium_c

from .model import BBox, ChangeMark, Page, ParsedDoc, Word
from .pagekind import (
    _T_PATH,
    _apply,
    _mul,
    _obj_matrix,
    _open,
    _page_to_norm,
    _path_points,
    _walk,
)
from .parse import PDFIUM_LOCK
from .titleblock import read_title_block

log = logging.getLogger(__name__)

CUSP_DEG = 25.0  # излом касательной на стыке дуг облака, градусов
SHARP_DEG = 40.0  # острый излом полилинии-облака
SMOOTH_DEG = 25.0  # «гладкий» поворот звена дуги полилинии
MIN_ARCS = 6  # меньше дуг — не облако (окружность — 4 кривые)
CUSP_SHARE = 0.6  # доля стыков с изломом среди стыков дуг
MIN_POLY_EDGES = 24  # полилиния-облако — не меньше звеньев
MIN_SIZE = 0.01  # облако не меньше 1 % листа по обеим сторонам
MAX_SIZE = 0.9  # и не больше 90 % (рамка листа — не облако)
TRI_MAX = 0.04  # треугольник номера изменения — не больше 4 % листа
NEAR = 0.05  # номер (треугольник, выноска) рядом с облаком — зазор не больше 5 % листа
MAX_PATH_SEGMENTS = (
    5_000  # путь длиннее — не облако, а «взорванный» блок CAD (правило №0)
)
MAX_PAGE_PATHS = 50_000  # потолок путей на страницу
MAX_SUBPATH_SEGS = 10_000  # потолок звеньев, которые subpaths соберёт из одного пути
MAX_PAGE_OBJECTS = 200_000  # потолок объектов обхода страницы (формы раскрываются по каждой ссылке)
MAX_PAGE_SEGMENTS = 500_000  # потолок сегментов путей на страницу — как pagekind.MAX_SEGMENTS
MAX_CLOUDS = 500  # облаков на страницу
MAX_TRIS = 2_000  # треугольников на страницу
MAX_MARKS = 2_000  # отметок на документ — столько же берёт API
DOC_BUDGET_S = 20.0  # время прохода по путям документа, с
ZIGZAG_SHARP = 0.8  # зубчатое облако из отрезков: доля острых изломов…
AXIS_SHARE = 0.3  # …и не больше 30 % отрезков вдоль осей листа (ступенчатый контур лестницы — осевой)
LOOSE_MAX = 0.05  # отдельный отрезок или дуга длиннее 5 % листа — не звено облака
MAX_LOOSE = 20_000  # потолок отдельных звеньев на страницу (правило №0)
SNAP = 3e-5  # концы звеньев ближе 3e-5 листа — один узел

CALLOUT = re.compile(r"изм\.?\s*(?:№\s*)?(\d{1,3})\b", re.IGNORECASE)
NUMBER = re.compile(r"^\d{1,3}$")

Pt = tuple[float, float]


def _angle(u: Pt, v: Pt) -> float | None:
    nu, nv = math.hypot(*u), math.hypot(*v)
    if nu < 1e-12 or nv < 1e-12:
        return None
    c = max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / (nu * nv)))
    return math.degrees(math.acos(c))


def _sub(a: Pt, b: Pt) -> Pt:
    return (a[0] - b[0], a[1] - b[1])


def subpaths(
    points: list[tuple[str, Pt, bool]],
) -> list[tuple[list[tuple[str, list[Pt]]], bool]]:
    """Сегменты пути → подпути: [(вид «L»|«C», [начало, (c1, c2,) конец])], замкнут ли подпуть."""
    out: list[tuple[list[tuple[str, list[Pt]]], bool]] = []
    segs: list[tuple[str, list[Pt]]] = []
    start = cur = None
    closed = False
    i = 0

    def flush():
        nonlocal segs, closed
        if segs:
            end = segs[-1][1][-1]
            out.append(
                (segs, closed or (start is not None and math.dist(end, start) < 1e-6))
            )
        segs, closed = [], False

    total = 0
    # предел итераций и звеньев: цикл по индексу не может разрастись ни на враждебном пути, ни при ошибке в шаге
    # индекса (OWASP T-177 SEC-11; мутанты шага съедали память общего раннера)
    for _ in range(len(points)):
        if i >= len(points) or total >= MAX_SUBPATH_SEGS:
            break
        kind, p, close = points[i]
        if kind == "M" or cur is None:
            flush()
            start = cur = p
        elif kind == "L":
            segs.append(("L", [cur, p]))
            total += 1
            cur = p
        else:
            if i + 2 >= len(points):
                break
            c1, c2, (_, end, close) = p, points[i + 1][1], points[i + 2]
            segs.append(("C", [cur, c1, c2, end]))
            total += 1
            cur = end
            i += 2
        if close:
            closed = True
            if start is not None and cur is not None and math.dist(cur, start) > 1e-6:
                segs.append(("L", [cur, start]))
                total += 1
                cur = start
        i += 1
    flush()
    return out


def _tangents(seg: tuple[str, list[Pt]]) -> tuple[Pt, Pt]:
    """Касательная в начале и в конце сегмента; у вырожденной контрольной точки — следующая."""
    kind, p = seg
    if kind == "L":
        d = _sub(p[1], p[0])
        return d, d
    p0, c1, c2, p3 = p
    t0 = _sub(c1, p0) if math.dist(c1, p0) > 1e-9 else _sub(c2, p0)
    t1 = _sub(p3, c2) if math.dist(p3, c2) > 1e-9 else _sub(p3, c1)
    return t0, t1


def _bbox(pts: list[Pt]) -> BBox:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def is_cloud(segs: list[tuple[str, list[Pt]]], closed: bool) -> bool:
    """Замкнутый подпуть — облако ревизии (координаты уже в долях листа)."""
    if not closed or len(segs) < MIN_ARCS:
        return False
    box = _bbox([q for _, p in segs for q in p])
    w, h = box[2] - box[0], box[3] - box[1]
    if not (MIN_SIZE <= w <= MAX_SIZE and MIN_SIZE <= h <= MAX_SIZE):
        return False
    arcs = [s for s in segs if s[0] == "C"]
    joins = [
        _angle(_tangents(segs[k])[1], _tangents(segs[(k + 1) % len(segs)])[0])
        for k in range(len(segs))
    ]
    turns = [a for a in joins if a is not None]
    if len(arcs) >= MIN_ARCS and len(arcs) >= 0.7 * len(segs):
        cusps = [
            a
            for k, a in enumerate(joins)
            if a is not None
            and segs[k][0] == "C"
            and segs[(k + 1) % len(segs)][0] == "C"
            and a > CUSP_DEG
        ]
        arc_joins = sum(
            1
            for k in range(len(segs))
            if segs[k][0] == "C" and segs[(k + 1) % len(segs)][0] == "C"
        )
        return (
            arc_joins > 0
            and len(cusps) >= CUSP_SHARE * arc_joins
            and len(cusps) >= MIN_ARCS
        )
    if len(segs) >= MIN_POLY_EDGES and not arcs:
        sharp = sum(1 for a in turns if a > SHARP_DEG)
        smooth = sum(1 for a in turns if a < SMOOTH_DEG)
        return (
            sharp >= MIN_ARCS
            and sharp <= 0.5 * len(turns)
            and smooth >= 0.4 * len(turns)
        )
    return False


def is_zigzag(segs: list[tuple[str, list[Pt]]], closed: bool) -> bool:
    """Зубчатое облако из прямых (гребешки «вверх-вниз»): почти все изломы острые, звенья не вдоль осей листа."""
    if not closed or len(segs) < 2 * MIN_ARCS or any(k != "L" for k, _ in segs):
        return False
    box = _bbox([q for _, p in segs for q in p])
    w, h = box[2] - box[0], box[3] - box[1]
    if not (MIN_SIZE <= w <= MAX_SIZE and MIN_SIZE <= h <= MAX_SIZE):
        return False
    dirs = [_sub(p[1], p[0]) for _, p in segs]
    turns = [_angle(dirs[k], dirs[(k + 1) % len(dirs)]) for k in range(len(dirs))]
    sharp = sum(1 for a in turns if a is not None and a > SHARP_DEG)
    axis = sum(1 for d in dirs if min(abs(d[0]), abs(d[1])) < 0.1 * math.hypot(*d))
    return sharp >= ZIGZAG_SHARP * len(turns) and axis <= AXIS_SHARE * len(segs)


class _Snap:
    """Склейка концов звеньев: точки ближе SNAP листа — один узел (соседние ячейки сетки тоже смотрятся,
    иначе округление разрывает совпадающие концы на границе ячейки)."""

    def __init__(self) -> None:
        self.cells: dict[tuple[int, int], list[tuple[Pt, int]]] = {}
        self.n = 0

    def id(self, p: Pt) -> int:
        cx, cy = int(p[0] // SNAP), int(p[1] // SNAP)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q, k in self.cells.get((cx + dx, cy + dy), []):
                    if math.dist(p, q) <= SNAP:
                        return k
        self.cells.setdefault((cx, cy), []).append((p, self.n))
        self.n += 1
        return self.n - 1


def _rev(seg: tuple[str, list[Pt]]) -> tuple[str, list[Pt]]:
    return (seg[0], list(reversed(seg[1])))


def loose_cycles(
    segs: list[tuple[str, list[Pt]]],
) -> list[list[tuple[str, list[Pt]]]]:
    """Замкнутые контуры из отдельных звеньев (каждое — свой путь PDF): облако, выгруженное «взорванным» блоком CAD,
    треугольник из трёх линий. Контур — компонента, где в каждом узле сходятся ровно два звена."""
    snap = _Snap()
    ends = [(snap.id(p[0]), snap.id(p[-1])) for _, p in segs]
    at: dict[int, list[int]] = {}
    for i, (a, b) in enumerate(ends):
        at.setdefault(a, []).append(i)
        at.setdefault(b, []).append(i)
    seen: set[int] = set()
    out = []
    # компонента не расширяется через узел, где сходятся не два звена: такой узел — не контур, а «звезда» враждебного
    # PDF дала бы квадратичный обход (OWASP T-177 SEC-01); итог — O(звеньев)
    for i in range(len(segs)):
        if i in seen:
            continue
        comp, stack, ok = [], [i], True
        seen.add(i)
        while stack:
            j = stack.pop()
            comp.append(j)
            for e in ends[j]:
                if len(at[e]) != 2:
                    ok = False
                    continue
                for k in at[e]:
                    if k not in seen:
                        seen.add(k)
                        stack.append(k)
        if not ok or len(comp) < 3:
            continue
        order = [segs[comp[0]]]
        used = {comp[0]}
        start, cur = ends[comp[0]]
        for _ in range(len(comp) - 1):  # не больше шагов, чем звеньев компоненты
            nxt = next((k for k in at[cur] if k not in used), None)
            if nxt is None:
                break
            used.add(nxt)
            fwd = ends[nxt][0] == cur
            order.append(segs[nxt] if fwd else _rev(segs[nxt]))
            cur = ends[nxt][1] if fwd else ends[nxt][0]
        if len(order) == len(comp) and cur == start:
            out.append(order)
    return out


def is_triangle(segs: list[tuple[str, list[Pt]]], closed: bool) -> bool:
    if not closed or len(segs) != 3 or any(k != "L" for k, _ in segs):
        return False
    box = _bbox([q for _, p in segs for q in p])
    return 0 < box[2] - box[0] <= TRI_MAX and 0 < box[3] - box[1] <= TRI_MAX


def gap(a: BBox, b: BBox) -> float:
    dx = max(0.0, a[0] - b[2], b[0] - a[2])
    dy = max(0.0, a[1] - b[3], b[1] - a[3])
    return math.hypot(dx, dy)


def page_shapes(page) -> tuple[list[BBox], list[BBox], list[tuple[str, list[Pt]]]]:
    """Облака, треугольники и отдельные короткие звенья страницы pdfium (доли листа). Вызывать под PDFIUM_LOCK.
    Контуры из отдельных звеньев собирает `shapes_of_loose` уже после замка. Бюджет: объекты, отрезки, фигуры."""
    to_norm = _page_to_norm(page)
    clouds: list[BBox] = []
    tris: list[BBox] = []
    loose: list[tuple[str, list[Pt]]] = []  # отдельные короткие звенья — из них собираются контуры
    objects = paths = segments = 0
    for obj, kind, parent in _walk(page):
        objects += 1
        if objects > MAX_PAGE_OBJECTS or segments > MAX_PAGE_SEGMENTS:
            break
        if kind != _T_PATH:
            continue
        paths += 1
        if paths > MAX_PAGE_PATHS:
            break
        count = pdfium_c.FPDFPath_CountSegments(obj)
        if count > MAX_PATH_SEGMENTS:
            continue
        segments += max(count, 0)
        m = _mul(_mul(_obj_matrix(obj), parent), to_norm)
        pts = [(k, _apply(m, *p), c) for k, p, c in _path_points(obj)]
        for segs, closed in subpaths(pts):
            if is_cloud(segs, closed) or is_zigzag(segs, closed):
                if len(clouds) < MAX_CLOUDS:
                    clouds.append(_bbox([q for _, p in segs for q in p]))
            elif is_triangle(segs, closed):
                if len(tris) < MAX_TRIS:
                    tris.append(_bbox([q for _, p in segs for q in p]))
            elif not closed and len(loose) < MAX_LOOSE:
                short = [g for g in segs if math.dist(g[1][0], g[1][-1]) <= LOOSE_MAX]
                loose.extend(short[: MAX_LOOSE - len(loose)])
    return clouds, tris, loose


def shapes_of_loose(loose: list[tuple[str, list[Pt]]], clouds: list[BBox], tris: list[BBox]) -> None:
    """Облака и треугольники из отдельных звеньев — дописываются к фигурам страницы (вне замка pdfium)."""
    for cyc in loose_cycles(loose):
        if is_cloud(cyc, True) or is_zigzag(cyc, True):
            if len(clouds) < MAX_CLOUDS:
                clouds.append(_bbox([q for _, p in cyc for q in p]))
        elif is_triangle(cyc, True):
            if len(tris) < MAX_TRIS:
                tris.append(_bbox([q for _, p in cyc for q in p]))


def _words(page: Page) -> list[Word]:
    return [w for ln in page.lines for w in ln.words if w.bbox is not None]


def _union(bs: list[BBox]) -> BBox:
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


def callouts(page: Page) -> list[ChangeMark]:
    """Выноски «Изм. №N» на поле листа (не шапка таблицы изменений: там за «Изм.» нет номера)."""
    out = []
    for ln in page.lines:
        words = [w for w in ln.words if w.bbox is not None]
        for i, w in enumerate(words):
            if not re.match(r"^изм\.?", w.text, re.IGNORECASE):
                continue
            span = words[i : i + 3]
            m = CALLOUT.match(" ".join(x.text for x in span))
            if not m:
                continue
            used = []
            text = ""
            for x in span:
                used.append(x)
                text = (text + " " + x.text).strip()
                if CALLOUT.match(text):
                    break
            out.append(
                ChangeMark(
                    page=page.page,
                    kind="callout",
                    number=str(int(m.group(1))),
                    bbox=_union([x.bbox for x in used]),
                    text=text,
                )
            )
    return out


def stamp_rows(page: Page) -> list[ChangeMark]:
    """Строки таблицы изменений основной надписи (IDN-03): графа «Изм.» с номером."""
    if page.source == "structured" or not page.lines:
        return []
    tb = read_title_block(page)
    if tb is None:
        return []
    out = []
    for row in tb.changes:
        m = re.search(r"(?<!\d)\d{1,4}(?!\d)", row.get("izm", ""))  # как titleblock._int: длинное число — не номер (SEC-07)
        if not m:
            continue
        text = " ".join(
            row.get(k, "")
            for k in ("izm", "kol_uch", "sheet", "doc_no", "sign", "date")
        ).strip()
        out.append(
            ChangeMark(
                page=page.page,
                kind="stamp_row",
                number=str(int(m.group(0))),
                bbox=None,
                text=text,
            )
        )
    return out


def number_for(
    cloud: BBox, tris: list[BBox], words: list[Word], calls: list[ChangeMark]
) -> str | None:
    """Номер изменения облака: цифра в треугольнике рядом, иначе ближайшая выноска «Изм. N» рядом."""
    best: tuple[float, str] | None = None
    nums = [w for w in words if NUMBER.match(w.text.strip())]
    for t in tris:
        d = gap(t, cloud)
        if d > NEAR:
            continue
        for w in nums:
            cx, cy = (w.bbox[0] + w.bbox[2]) / 2, (w.bbox[1] + w.bbox[3]) / 2
            if (
                t[0] - 0.005 <= cx <= t[2] + 0.005
                and t[1] - 0.005 <= cy <= t[3] + 0.005
            ):
                if best is None or d < best[0]:
                    best = (d, str(int(w.text.strip())))
    if best:
        return best[1]
    near = sorted(
        (gap(c.bbox, cloud), c.number)
        for c in calls
        if c.bbox is not None and gap(c.bbox, cloud) <= NEAR
    )
    return near[0][1] if near else None


def change_marks(path: Path | None, doc: ParsedDoc) -> list[ChangeMark]:
    """Все отметки изменений документа. Облака — только у PDF с путями; сбой pdfium разбор не ломает.
    Бюджет документа — DOC_BUDGET_S секунд прохода по путям и MAX_MARKS отметок (OWASP T-177 SEC-02, SEC-03)."""
    raw: dict[int, tuple[list[BBox], list[BBox], list]] = {}
    if path is not None and doc.kind == "pdf":
        t0 = time.monotonic()
        try:
            with PDFIUM_LOCK:
                pdf = _open(path)
                try:
                    for p in doc.pages:
                        if time.monotonic() - t0 > DOC_BUDGET_S:
                            log.warning("change_marks: бюджет %s с исчерпан на стр. %s — облака дальше не ищутся", DOC_BUDGET_S, p.page)
                            break
                        if 1 <= p.page <= len(pdf):
                            pg = pdf[p.page - 1]
                            try:
                                raw[p.page] = page_shapes(pg)
                            finally:
                                pg.close()
                finally:
                    pdf.close()
        except Exception as e:  # noqa: BLE001 — сбой разбора путей не ломает анализ документа (OS-INSP-1.5.8)
            log.warning("change_marks: пути PDF не разобраны: %s", type(e).__name__)
            raw = {}
    out: list[ChangeMark] = []
    for p in doc.pages:
        calls = callouts(p)
        out.extend(calls)
        out.extend(stamp_rows(p))
        clouds, tris, loose = raw.get(p.page, ([], [], []))
        shapes_of_loose(loose, clouds, tris)
        words = _words(p)
        for c in clouds:
            out.append(
                ChangeMark(
                    page=p.page,
                    kind="cloud",
                    number=number_for(c, tris, words, calls),
                    bbox=tuple(round(v, 6) for v in c),
                    text="",
                )
            )
        if len(out) >= MAX_MARKS:
            break
    return out[:MAX_MARKS]
