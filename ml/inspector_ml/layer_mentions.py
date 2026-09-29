"""Состав конструкции по паспорту (OS-INSP-2.2.76–2.2.79, T-176; CMP-21 LAYER-SEQ — М-044 пирог кровли, М-032 дорожная
одежда, М-125 утеплитель наружных стен, М-128 утеплитель чердачного перекрытия и кровли; ENT-17).

Состав — упорядоченные слои (материал по канону справочника data/seed/analogs.json, толщина в мм). Источник — выноска
узла («1. …», «2) …», «- …»), перечень в строку после заголовка («Состав покрытия: …; …; …»), таблица состава
(«№ | Слой | Толщина, мм»). Порядок — канонический: сверху вниз (кровля, покрытие, дорожная одежда), снаружи внутрь
(стена); перечень с явным «снизу вверх» / «изнутри наружу» разворачивается. Слой вне справочника сохраняется с
материалом None и написанием — сравнение не угадывает его замену. Каждый состав — одно упоминание со слоями в meta.
Работает поверх контракта ParsedDoc (строки, слова, рамки).
"""

from __future__ import annotations

import re

from .category_mentions import Seg, _bbox, alias_hits, segments, to_number
from .model import Extraction, Page, ParamSpec, ParsedDoc

KIND = "layer_mentions"
OPS = ["ENT-17", "NRM-06"]
QUOTE_MAX = 400
# толщина: число и единица, диапазон «50–200 мм», обозначения «h=», «δ=», «t=», «толщиной»
NUM = r"\d{1,4}(?:[.,]\d{1,2})?"
THICK = re.compile(
    rf"(?:(?:[hδtН]|толщ(?:иной|ина)?\.?)\s*[=:–-]?\s*)?(?<![\w.,])({NUM})(?:\s*(?:[-–—…÷]|до)\s*({NUM}))?\s*(мм|см|м)(?![\wА-Яа-я²³/])"
    rf"|(?:[hδt]|толщ(?:иной|ина)?\.?)\s*[=:]?\s*({NUM})(?:\s*(?:[-–—…÷]|до)\s*({NUM}))?(?![\d.,])",
    flags=re.I,
)
NOT_THICK = re.compile(r"(?:фракц\w*|фр\.|[ØøⲪ]|Ду|шаг\w*|размер\w*|ячейк\w*|шириной)\s*[\d\s.,×xх-]*$", flags=re.I)
UNIT = {"мм": 1.0, "см": 10.0, "м": 1000.0}
# начало пункта: «1.», «2)», «1 » (строка таблицы), «-», «•»
ITEM_START = re.compile(r"^\s*(?:(\d{1,2})\s*[.)]?\s+|[-–—•·*]\s*)")
TABLE_HEAD_MM = re.compile(r"толщин\w*[^|]{0,12}мм", flags=re.I)
LONE_NUM = re.compile(rf"(?:^|\|)\s*({NUM})\s*(?:\||$)")


def is_layer_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def thickness(text: str, head_mm: bool = False) -> tuple[float | None, float | None]:
    """Толщина слоя, мм: (минимальная, максимальная). «1,5 мм» → 1,5; «5 см» → 50; «50–200 мм» → 50…200; «δ=150» — мм;
    в таблице с шапкой «Толщина, мм» — число-ячейка без единицы."""
    cands = []
    for m in THICK.finditer(text):
        if NOT_THICK.search(text[max(0, m.start() - 16) : m.start()]):
            continue  # «фракции 40–70 мм», «Ø20 мм», «шаг 600 мм» — не толщина слоя
        cands.append(m)
    # явная толщина («δ=», «h=», «толщиной») важнее; иначе — последнее число с единицей в пункте
    marked = [m for m in cands if re.match(r"\s*(?:[hδtН]|толщ)", m.group(0), flags=re.I)]
    for m in (marked or cands[::-1]):
        if m.group(1):
            k = UNIT[m.group(3).lower()]
            a = to_number(m.group(1))
            b = to_number(m.group(2)) if m.group(2) else None
        else:
            k = 1.0
            a = to_number(m.group(4))
            b = to_number(m.group(5)) if m.group(5) else None
        if a is None:
            continue
        lo = a * k
        hi = (b * k) if b is not None else lo
        return round(min(lo, hi), 3), round(max(lo, hi), 3)
    if head_mm:
        cells = [c.strip() for c in text.split("|")]
        for c in reversed(cells[1:]):
            m = re.fullmatch(rf"({NUM})(?:\s*[-–—…÷]\s*({NUM}))?", c)
            a = to_number(m.group(1)) if m else None
            if a is not None:
                b = to_number(m.group(2)) if m.group(2) else a
                b = a if b is None else b
                return min(a, b), max(a, b)
    return None, None


def _layer(cfg: dict, text: str, head_mm: bool, listed: bool = False) -> dict | None:
    """Слой из текста пункта: материал (первое в тексте написание канона) и толщина. Нет ни материала, ни толщины —
    слой, только если это пункт перечня или строка таблицы с текстом («3. Пароизоляция» — материал вне справочника)."""
    body = ITEM_START.sub("", text, count=1).strip(" |")
    if not body:
        return None
    hits = alias_hits(cfg.get("aliases") or [], body, cfg.get("remap"))
    t, tmax = thickness(body, head_mm)
    letters = len(re.findall(r"[А-Яа-яЁёA-Za-z]", body))
    if not hits and t is None and not (listed and letters >= 3):
        return None
    m = hits[0][2] if hits else None
    raw = body[:120].strip(" ;,.")
    return {"m": m, "raw": raw, "t": t, "t_max": tmax if tmax != t else None}


def _split_inline(text: str) -> list[str]:
    """Перечень в строку: «Состав: мембрана 1,5 мм; XPS 100 мм; …» → пункты по «;» (или по «,» перед числом-номером)."""
    parts = re.split(r";\s*|\s(?=\d{1,2}[.)]\s)", text)
    return [p for p in (x.strip() for x in parts) if p]


def _stack(cfg: dict, segs: list[Seg], i: int, rev: bool) -> tuple[list[dict], int]:
    """Слои после заголовка состава (сегмент i): хвост заголовка после «:» и следующие пункты, пока они — слои."""
    head = segs[i].text
    layers: list[dict] = []
    max_layers = int(cfg.get("max_layers", 15))
    head_mm = bool(TABLE_HEAD_MM.search(head))
    anchor = re.search(cfg["anchor"], head, flags=re.I)
    tail = head[anchor.end() :] if anchor else ""
    colon = tail.find(":")
    if colon >= 0:
        for p in _split_inline(tail[colon + 1 :]):
            ly = _layer(cfg, p, False)
            if ly:
                layers.append(ly)
    j = i + 1
    misses = 0
    while j < len(segs) and len(layers) < max_layers:
        t = segs[j].text
        if re.search(cfg["anchor"], t, flags=re.I):
            break  # следующий состав
        if TABLE_HEAD_MM.search(t) and not alias_hits(cfg.get("aliases") or [], t):
            head_mm = True  # шапка таблицы состава
            j += 1
            continue
        listed = bool(ITEM_START.match(t)) or segs[j].table
        items = _split_inline(t) if ";" in t and not listed else [t]
        got = [ly for ly in (_layer(cfg, p, head_mm, listed) for p in items) if ly]
        if not got:
            misses += 1
            if layers or misses > 1:
                break
            j += 1
            continue
        layers += got
        j += 1
    if rev:
        layers.reverse()
    return layers[:max_layers], j


def _page_mentions(page: Page, spec: ParamSpec, cfg: dict) -> list[Extraction]:
    segs = segments(page)
    base_conf = 1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
    reverse = [re.compile(p, flags=re.I) for p in cfg.get("reverse") or []]
    out: list[Extraction] = []
    i = 0
    while i < len(segs):
        seg = segs[i]
        a = re.search(cfg["anchor"], seg.text, flags=re.I)
        if not a:
            i += 1
            continue
        ctx = seg.text + (" " + segs[i - 1].text if i else "")
        item = None
        if cfg.get("item_pattern"):
            m = re.search(cfg["item_pattern"], seg.text) or (
                re.search(cfg["item_pattern"], segs[i - 1].text) if i else None
            )
            if m:
                item = re.sub(
                    r"\s+", " ", (m.group(1) if m.groups() else m.group(0))
                ).strip()
        rev = any(p.search(ctx) for p in reverse)
        layers, j = _stack(cfg, segs, i, rev)
        if layers:
            rule = next(
                (
                    r
                    for r in cfg.get("exclude") or []
                    if re.search(r["pattern"], seg.text, flags=re.I)
                ),
                None,
            )
            used = segs[i:j]
            quote = " ⏎ ".join(s.text for s in used)[:QUOTE_MAX]
            boxes = [b for b in (_bbox(s.spans, 0, len(s.text)) for s in used) if b]
            bbox = (
                (
                    min(b[0] for b in boxes),
                    min(b[1] for b in boxes),
                    max(b[2] for b in boxes),
                    max(b[3] for b in boxes),
                )
                if boxes
                else None
            )
            out.append(
                Extraction(
                    code=spec.code,
                    raw=seg.text[a.start() : a.end()],
                    value_text=" / ".join(f"{ly['raw']}" for ly in layers)[:500],
                    page=page.page,
                    bbox=bbox,
                    anchor_bbox=_bbox(seg.spans, a.start(), a.end()),
                    line_text=quote,
                    confidence=round(base_conf, 3),
                    meta={
                        "quote": quote,
                        "item": item,
                        "layers": layers,
                        "reversed": rev,
                        "excluded": rule["code"] if rule else None,
                        "excluded_why": rule.get("why") if rule else None,
                        "ops": list(OPS),
                    },
                )
            )
        i = max(j, i + 1)
    return out


def extract_layer_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все составы конструкций в документе по порядку страниц, включая отсеянные (meta.excluded)."""
    cfg = spec.extractor or {}
    out: list[Extraction] = []
    for page in doc.pages:
        out += _page_mentions(page, spec, cfg)
    return out
