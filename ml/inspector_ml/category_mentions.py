"""Упоминания марки, материала, типа по паспорту (OS-INSP-2.2.70–2.2.75, T-176; CMP-05 SUBST — М-072 трубы В1/Т3,
М-075 канализация, М-079 модель вентилятора, М-130 тип источника света, М-050 материал отделки).

Как у классов и количества (class_mentions.py, quantity_mentions.py), сохраняется КАЖДОЕ упоминание: API выбирает
источник по приоритету разделов и сравнивает стадии по таблице аналогов. Конфигурация — из паспорта
(`ParamSpec.extractor`): предмет (anchor), позиции и элементы, написания канона (aliases — из справочника
data/seed/analogs.json), «или аналог», характеристики, отсев. Код от параметра не зависит.

Текст страницы режется на сегменты — предложения прозы и строки таблиц и перечней (`segments`): значение, позиция и
элемент берутся в своём сегменте, позиция без своей — из заголовка перечня или строки-заголовка таблицы выше
(«Система В1:», «В1 Водопровод хозяйственно-питьевой»). Работает поверх контракта ParsedDoc (текст, строки, слова,
рамки) и не опирается на особенности движка OCR.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .model import BBox, Extraction, Page, ParamSpec, ParsedDoc, Word
from .parse import union

KIND = "category_mentions"
OPS = ["ENT-13", "NRM-06", "NRM-11"]
QUOTE_MAX = 240
ANALOG_AFTER = 120  # «или аналог» — не дальше 120 знаков после значения и до следующего значения (OS-INSP-2.2.73)
ALT_GAP = re.compile(
    r"^\s*(?:,?\s*(?:или|либо)\s+(?:из\s+)?|/\s*)$", flags=re.I
)  # «A или B», «A / B» — варианты
DISPUTED_PENALTY = (
    0.6  # как в extract.py: значение из слова, где движки OCR разошлись (OS-INSP-2.1.6)
)
# строка перечня или позиции: «1.», «2)», «-», «•», «поз. 3»
LIST_START = re.compile(
    r"^\s*(?:\d{1,2}(?:\.\d{1,2})?[.)]\s|[-–—•·*]\s|\d{1,3}\s+(?=[А-ЯЁA-Z]))"
)
# конец предложения: «;», «!», «?» или точка перед пробелом и заглавной буквой / концом текста
SENT_END = re.compile(r"[;!?]|\.(?=\s+[«(\"А-ЯЁA-Z]|\s*$)")
CELL_GAP = 0.025  # разрыв между словами строки шире 2,5 % ширины листа — граница ячейки таблицы


def is_category_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


# ------------------------------------------------------------------ сегменты страницы


@dataclass
class Seg:
    text: str
    spans: list[tuple[int, int, Word]] = field(default_factory=list)
    table: bool = (
        False  # строка таблицы или перечня: позиция может прийти из заголовка выше
    )
    header: bool = False  # предложение кончается «:» — заголовок перечня


def _cells(line) -> int:
    """Число ячеек строки: «|» или широкие разрывы между словами (геометрия слов ParsedDoc)."""
    if "|" in line.text:
        return line.text.count("|") + 1
    n = 1
    ws = [w for w in line.words if w.bbox]
    for a, b in zip(ws, ws[1:]):
        if b.bbox[0] - a.bbox[2] > CELL_GAP:
            n += 1
    return n


def _blocks(page: Page) -> list[Seg]:
    """Блоки: строка таблицы (3+ ячейки) и пункт перечня — отдельно; строки прозы склеиваются до конца предложения.
    Перенос со знаком «-» в конце строки перед строчной буквой склеивается без пробела."""
    out: list[Seg] = []
    cur: Seg | None = None
    for line in page.lines:
        text = line.text.replace(" ", " ").replace("￾", "-")
        if not text.strip():
            cur = None
            continue
        table = _cells(line) >= 3
        starts = bool(LIST_START.match(text))
        prev_end = cur.text.rstrip()[-1:] if cur else ""
        new = (
            cur is None
            or table
            or starts
            or cur.table
            or (prev_end in ".;:!?" and text.lstrip()[:1].isupper())
        )
        if new:
            cur = Seg(text="", table=table or starts)
            out.append(cur)
            sep = ""
        else:
            glue = cur.text.endswith("-") and text[:1].islower()
            if glue:
                cur.text = cur.text[:-1]
            sep = "" if glue else " "
        base = len(cur.text) + len(sep)
        cur.text += sep + text
        pos = base
        for w in line.words:
            i = cur.text.find(w.text, pos) if w.text else -1
            if i < 0:
                continue
            cur.spans.append((i, i + len(w.text), w))
            pos = i + len(w.text)
    return out


def segments(page: Page) -> list[Seg]:
    """Сегменты страницы: строки таблиц и перечней как есть, проза — по предложениям."""
    out: list[Seg] = []
    for b in _blocks(page):
        if b.table:
            b.header = b.text.rstrip().endswith(":")
            out.append(b)
            continue
        s0 = 0
        cuts = [m.end() for m in SENT_END.finditer(b.text)] + [len(b.text)]
        for c in cuts:
            if c <= s0:
                continue
            piece = b.text[s0:c]
            if piece.strip():
                lo = s0 + len(piece) - len(piece.lstrip())
                sg = Seg(
                    text=b.text[lo:c],
                    spans=[
                        (a - lo, e - lo, w) for a, e, w in b.spans if a >= lo and e <= c
                    ],
                    header=b.text[lo:c].rstrip().endswith(":"),
                )
                out.append(sg)
            s0 = c
    return out


def _words_in(spans, start: int, end: int) -> list[Word]:
    return [w for ws, we, w in spans if we > start and ws < end]


def _bbox(spans, start: int, end: int) -> BBox | None:
    return union([w.bbox for w in _words_in(spans, start, end)])


# ------------------------------------------------------------------ канон и характеристики


def alias_hits(
    aliases: list[dict], text: str, remap: dict | None = None
) -> list[tuple[int, int, str]]:
    """Значения канона в тексте: (начало, конец, ключ); пересечения — выигрывает более длинное совпадение, при равной
    длине — раньше объявленный ключ («PP-R, армированный стекловолокном» — не «PP-R»). NRM-06, NRM-11. remap —
    уточнение канона паспортом (у стены «железобетон» — WALL_RC, а не SLAB_RC; OS-INSP-2.2.71)."""
    hits: list[tuple[int, int, int, str]] = []
    for order, a in enumerate(aliases or []):
        for p in a.get("patterns") or []:
            for m in re.finditer(p, text, flags=re.I):
                if m.end() > m.start():
                    hits.append((m.start(), m.end(), order, a["key"]))
    hits.sort(key=lambda h: (-(h[1] - h[0]), h[2], h[0]))
    taken: list[tuple[int, int, str]] = []
    for s, e, _, k in hits:
        if all(e <= a or s >= b for a, b, _ in taken):
            taken.append((s, e, k))
    remap = remap or {}
    return sorted((s, e, remap.get(k, k)) for s, e, k in taken)


def to_number(raw: str) -> float | None:
    s = re.sub(r"[\s ]", "", raw).replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def chars_near(cfg: dict, text: str, start: int, end: int) -> dict:
    """Характеристики из текста упоминания (OS-INSP-2.2.74): первая группа шаблона — число (× factor), ближайшее к
    значению в пределах сегмента."""
    out: dict = {}
    for c in cfg.get("chars") or []:
        best = None
        for m in re.finditer(c["pattern"], text, flags=re.I):
            g = next((x for x in m.groups() if x), None)
            v = to_number(g) if g else None
            if v is None:
                continue
            d = abs(m.start() - end) if m.start() >= end else abs(start - m.end())
            if best is None or d < best[0]:
                best = (d, v * float(c.get("factor", 1)))
        if best is not None:
            out[c["key"]] = round(best[1], 6)
    return out


def _find_keyed(rules: list[dict], text: str) -> list[tuple[int, int, str]]:
    out = []
    for r in rules or []:
        for m in re.finditer(r["pattern"], text, flags=re.I):
            out.append((m.start(), m.end(), r["key"]))
    return sorted(out)


def _items(cfg: dict, text: str) -> list[tuple[int, int, str]]:
    """Позиции сегмента: объявленные паспортом (В1, Т3) или открытые — шаблон item_pattern, группа 1 (П1, ВЕ4)."""
    out = _find_keyed(cfg.get("items") or [], text)
    ip = cfg.get("item_pattern")
    if ip:
        for m in re.finditer(ip, text):
            g = m.group(1) if m.groups() else m.group(0)
            out.append((m.start(), m.end(), re.sub(r"\s+", "", g)))
    return sorted(out)


BEFORE_VALUE = 40  # scope «before_value»: признак отсева — не дальше 40 знаков перед значением в его ячейке


def _excluded(cfg: dict, text: str, has_item: bool, start: int | None = None) -> dict | None:
    """Первое сработавшее правило отсева (OS-INSP-2.2.75). scope «no_item» — только если у сегмента нет своей позиции
    паспорта (система отопления Т1 в строке без В1/Т3); scope «before_value» — только перед самим значением в той же
    ячейке («Клапан воздушный КВК 315» — не вентилятор); иначе — весь сегмент."""
    for rule in cfg.get("exclude") or []:
        scope = rule.get("scope")
        if scope == "no_item" and has_item:
            continue
        if scope == "before_value":
            if start is None:
                continue
            ctx = text[max(0, start - BEFORE_VALUE) : start]
            ctx = ctx[ctx.rfind("|") + 1 :]
        else:
            ctx = text
        if re.search(rule["pattern"], ctx, flags=re.I):
            return rule
    return None


def column_elements(cfg: dict, text: str) -> dict[int, str] | None:
    """Шапка таблицы с элементами по колонкам («Помещение | Потолок | Площадь | Стены | … | Пол»): номер ячейки → элемент.
    OS-INSP-2.2.74."""
    if "|" not in text:
        return None
    out: dict[int, str] = {}
    for i, c in enumerate(text.split("|")):
        hit = _find_keyed(cfg.get("elements") or [], c)
        if hit and len(c.strip()) <= 40:
            out[i] = hit[0][2]
    return out if len(out) >= 2 else None


def _quote(text: str, start: int, end: int) -> str:
    pad = max(0, (QUOTE_MAX - (end - start)) // 2)
    return text[max(0, start - pad) : end + pad].strip()


# ------------------------------------------------------------------ значения сегмента


def _values(cfg: dict, text: str) -> list[tuple[int, int, str, str]]:
    """Значения сегмента: (начало, конец, ключ, как написано). Открытая марка — шаблон value (группа 1), иначе канон."""
    if cfg.get("value"):
        out = []
        for m in re.finditer(cfg["value"], text):
            g = 1 if m.groups() and m.group(1) else 0
            raw = m.group(g).strip(" ,;:.")
            if raw:
                out.append((m.start(g), m.start(g) + len(raw), raw, raw))
        return out
    return [
        (s, e, k, text[s:e])
        for s, e, k in alias_hits(cfg.get("aliases") or [], text, cfg.get("remap"))
    ]


def _group_alts(vals, text: str, order: dict | None = None):
    """«A или B» — одно упоминание с вариантом B (OS-INSP-2.2.72)."""
    groups: list[list[tuple[int, int, str, str]]] = []
    for v in vals:
        gap = text[groups[-1][-1][1] : v[0]] if groups else ""
        if groups and groups[-1][-1][2] != v[2] and order and re.fullmatch(r"\s{1,2}", gap):
            # два написания канона вплотную («малошумные полипропиленовые трубы»): одно значение — более частный ключ,
            # объявленный в справочнике раньше общего (PP_NOISE раньше PP, CAST_IRON_SML раньше CAST_IRON)
            last = groups[-1][-1]
            keep = last if order.get(last[2], 99) <= order.get(v[2], 99) else v
            groups[-1][-1] = (last[0], v[1], keep[2], text[last[0] : v[1]])
            continue
        if groups and groups[-1][-1][2] == v[2] and re.fullmatch(r"[\s,\-–—(]{0,4}", gap):
            # то же значение вплотную другим написанием («полипропилена PP-R»): одно значение
            last = groups[-1][-1]
            groups[-1][-1] = (last[0], v[1], last[2], text[last[0] : v[1]])
            continue
        if groups and ALT_GAP.match(gap):
            groups[-1].append(v)
        else:
            groups.append([v])
    return groups


def _anchor_ok(cfg: dict, text: str, s: int, e: int) -> bool:
    window = int(cfg.get("window", 160))
    for m in re.finditer(cfg["anchor"], text, flags=re.I):
        if m.start() - window <= e and s <= m.end() + window:
            return True
    return False


def _page_mentions(page: Page, spec: ParamSpec, cfg: dict) -> list[Extraction]:
    base_conf = 1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
    or_analog = [re.compile(p, flags=re.I) for p in cfg.get("or_analog") or []]
    out: list[Extraction] = []
    cols: dict[int, str] | None = None  # элементы по колонкам шапки таблицы
    order = {a["key"]: i for i, a in enumerate(cfg.get("aliases") or [])}  # порядок канона: частное раньше общего
    ctx_items: list[
        str
    ] = []  # позиции заголовка перечня или строки-заголовка таблицы выше
    ctx_anchor = False
    for seg in segments(page):
        text = seg.text
        items = _items(cfg, text)
        vals = _values(cfg, text)
        anchor_here = re.search(cfg["anchor"], text, flags=re.I) is not None
        # позиция внутри значения («КВАРК-П 50-25») — не позиция: марка системы стоит вне модели
        items = [x for x in items if all(x[1] <= v[0] or x[0] >= v[1] for v in vals)]
        if items and not vals:
            ctx_items = list(
                dict.fromkeys(k for _, _, k in items)
            )  # заголовок: «Система В1», «В1 и Т3:»
            ctx_anchor = True  # заголовок позиции паспорта задаёт предмет строк ниже (трубы системы В1)
            continue
        if not seg.table:
            if seg.header:
                ctx_items = list(dict.fromkeys(k for _, _, k in items))
                ctx_anchor = anchor_here
            elif not vals:
                ctx_anchor = False
        own = list(dict.fromkeys(k for _, _, k in items))
        its = own or (ctx_items if (seg.table or seg.header) else [])
        elements = _find_keyed(cfg.get("elements") or [], text)
        if seg.table and not vals and column_elements(cfg, text):
            cols = column_elements(cfg, text)  # шапка ведомости: элемент значения — по его колонке
            ctx_anchor = True  # шапка с элементами паспорта (потолок, стены, пол) задаёт предмет строк ниже
            continue
        if not seg.table:
            cols = None
        rule = _excluded(cfg, text, bool(its))
        seen: dict = {}
        groups = _group_alts(vals, text, order)
        for grp in groups:
            s, e = grp[0][0], grp[-1][1]
            if not (_anchor_ok(cfg, text, s, e) or (seg.table and ctx_anchor)):
                continue  # значение не у предмета паспорта: «полипропиленовая плёнка», «сталь» каркаса
            # «или аналог» — после значения до следующего значения сегмента (характеристики между ними допустимы)
            nxt = min([g[0][0] for g in groups if g[0][0] >= e] + [len(text)])
            tail = text[e : min(nxt, e + ANALOG_AFTER)]
            analog = any(p.search(tail) for p in or_analog)
            before = [x for x in elements if x[1] <= s]
            after = [x for x in elements if x[0] >= e]
            el = before[-1][2] if before else (after[0][2] if after else None)
            if cols and "|" in text:
                el = cols.get(text.count("|", 0, s), el)
            own_rule = rule or _excluded(cfg, text, bool(its), s)
            key = (grp[0][2], tuple(v[2] for v in grp[1:]), el)
            if key in seen:
                # то же значение того же элемента ещё раз в сегменте («полиэтиленовые трубы ПЭ100»): одно упоминание,
                # «или аналог» второго написания переходит к первому
                if analog:
                    for x in seen[key]:
                        x.meta["or_analog"] = True
                continue
            seen[key] = []
            conf = base_conf
            if any(w.disputed for w in _words_in(seg.spans, s, e)):
                conf *= DISPUTED_PENALTY
            chars = chars_near(cfg, text, s, e)
            quote = _quote(text, s, e)
            for it in its or [None]:
                seen[key].append(
                    Extraction(
                        code=spec.code,
                        raw=grp[0][3],
                        value_text=grp[0][2],
                        page=page.page,
                        bbox=_bbox(seg.spans, s, e),
                        line_text=quote,
                        confidence=round(conf, 3),
                        meta={
                            "quote": quote,
                            "item": it,
                            "element": el,
                            "alts": [v[2] for v in grp[1:]],
                            "or_analog": analog,
                            "chars": chars,
                            "excluded": own_rule["code"] if own_rule else None,
                            "excluded_why": own_rule.get("why") if own_rule else None,
                            "ops": list(OPS),
                        },
                    )
                )
        for xs in seen.values():
            out += xs
    return out


def extract_category_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все упоминания значения в документе по порядку страниц, включая отсеянные (meta.excluded)."""
    cfg = spec.extractor or {}
    out: list[Extraction] = []
    for page in doc.pages:
        out += _page_mentions(page, spec, cfg)
    return out
