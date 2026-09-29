"""Упоминания класса по порядковой шкале (OS-INSP-2.2.13–2.2.16, T-129; первый параметр — М-023,
класс конструктивной пожарной опасности С0–С3).

В отличие от лексического пути (extract.py: одна лучшая строка на параметр) здесь сохраняется КАЖДОЕ
упоминание: API выбирает источник по приоритету разделов и показывает инспектору все найденные, в том числе
отсеянные — с причиной. Конфигурация (якорь, шаблон значения, окно, отсев) приходит из паспорта параметра
в `ParamSpec.extractor`, код от конкретного параметра не зависит.

Ищем по тексту страницы, а не строки: оборот часто разорван переносом («класса конструктивной» / «пожарной
опасности – С1»). Строки склеиваются через пробел, у каждого слова — его диапазон в склеенном тексте.
"""

from __future__ import annotations

import re
import unicodedata

from . import fire_degree, fire_distance_table
from .model import BBox, Extraction, Page, ParamSpec, ParsedDoc, Word
from .parse import union

KIND = "class_mentions"
QUALIFIER_BEFORE = (
    40  # маркер «не ниже» ищется от (начало якоря − 40) до значения (OS-INSP-2.2.16)
)
EXCLUDE_BEFORE = 120  # контекст отсева: 120 знаков до якоря…
EXCLUDE_AFTER = 40  # …и 40 после значения (OS-INSP-2.2.15)
VALUE_NEAR = 24  # окрестность значения для правил отсева со scope = value (T-172)
# отсев, который смотрит только ПОСЛЕ якоря: ряд классов «С0 С1 С2» до оборота — чужая таблица, не наша
AFTER_ANCHOR_ONLY = frozenset({"NORM_TABLE"})
QUOTE_MAX = 240  # цитата для карточки
DISPUTED_PENALTY = (
    0.6  # как в extract.py: значение из слова, где движки OCR разошлись (OS-INSP-2.1.6)
)
OPS = ["ENT-16", "NRM-03", "NRM-04"]
_ZERO = str.maketrans(
    {"О": "0", "O": "0", "о": "0", "o": "0"}
)  # буква О в номере класса → ноль (NRM-04)


def is_class_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def normalize_class(raw: str) -> str:
    """«C 0», «со», «С0» → «С0»: буква — кириллическая С (NRM-03), номер — цифра (NRM-04), без пробела."""
    s = re.sub(r"\s", "", raw)
    return "С" + s[1:].translate(_ZERO)


# OS-INSP-2.2.40 (T-172): свёртка написания — та же, что apps/api/src/domain/class-param.ts::foldClass
_HOMOGLYPH = str.maketrans(
    {"А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T", "Х": "X", "У": "Y", "І": "I"}
)
_DASHES = re.compile(r"[‐‑‒–—−]")


def fold_class(raw: str) -> str:
    """Ключ сравнения написаний (NRM-03): NFKC, верхний регистр, без пробелов, тире — «-», запятая — точка,
    кириллические гомоглифы — латиница; буква O — ноль только рядом с цифрой или в конце короткого
    префикса класса («КМО», «СО»). Канон хранится отдельно."""
    s = unicodedata.normalize("NFKC", raw).upper()
    s = _DASHES.sub("-", re.sub(r"\s+", "", s)).replace(",", ".")
    s = re.sub(r"([^\W\d_])-(?=\d)", r"\1", s)  # «EI-60», «А-400»: тире между буквой и числом не значимо
    s = re.sub(r"(?<=\d)O|O(?=\d)", "0", s.translate(_HOMOGLYPH))
    s = re.sub(r"(?<=\d)З|З(?=\d)", "3", s)
    s = re.sub(r"^([^\W\d_]{1,3})O$", r"\g<1>0", s)
    return re.sub(r"^([^\W\d_]{1,3})З$", r"\g<1>3", s)


def canon_table(scale: list[str], aliases: dict[str, str] | None) -> dict[str, str]:
    """Свёрнутое написание → канон шкалы: сами значения шкалы и написания из паспорта (NRM-04, OS-INSP-2.2.40)."""
    table = {fold_class(v): v for v in scale}
    for raw, canon in (aliases or {}).items():
        if canon in scale:
            table.setdefault(fold_class(raw), canon)
    return table


def canon_class(raw: str, table: dict[str, str]) -> str | None:
    """Канон значения по таблице паспорта; написание вне шкалы — None (упоминание не выдаётся)."""
    return table.get(fold_class(raw))


def page_text(page: Page) -> tuple[str, list[tuple[int, int, Word]]]:
    """Текст страницы (строки через пробел) и диапазоны слов в нём. Внутри строки слова идут через один
    пробел — то же допущение, что у extract._span_bbox."""
    spans: list[tuple[int, int, Word]] = []
    base = 0
    for line in page.lines:
        pos = base
        for w in line.words:
            spans.append((pos, pos + len(w.text), w))
            pos += len(w.text) + 1
        base += len(line.text) + 1
    return " ".join(line.text for line in page.lines), spans


def _words_in(spans: list[tuple[int, int, Word]], start: int, end: int) -> list[Word]:
    """Слова, пересекающие диапазон символов [start, end)."""
    return [w for ws, we, w in spans if we > start and ws < end]


def _bbox(spans: list[tuple[int, int, Word]], start: int, end: int) -> BBox | None:
    return union([w.bbox for w in _words_in(spans, start, end)])


def _marker_re(marker: str) -> str:
    # «не  ниже» и «не\nниже» (после склейки строк) — тот же маркер
    return r"\s+".join(re.escape(p) for p in marker.split())


def _quote(text: str, start: int, end: int) -> str:
    """Цитата вокруг [start, end): поровну контекста с обеих сторон, всего не больше QUOTE_MAX."""
    pad = max(0, (QUOTE_MAX - (end - start)) // 2)
    return text[max(0, start - pad) : end + pad].strip()


_SENTENCE_END = re.compile(r"[.!?]\s+(?=[А-ЯЁA-Z«\"(])")  # «;» — не граница: перечни и строки таблиц норм
_ABBR = re.compile(r"(?:^|[\s(])[а-яёa-z]{1,4}$")  # «г.», «ул.», «табл.», «см.» — не конец предложения


def _sentence_bounds(text: str, start: int, end: int, joins: frozenset[int] = frozenset()) -> tuple[int, int]:
    """Границы предложения вокруг [start, end) (OS-INSP-2.2.45): точка, «!», «?» перед заглавной;
    сокращение из 1–4 строчных букв («г.», «ул.») предложение не завершает. Перенос строки перед строкой с заглавной
    буквы — тоже граница (строка таблицы, спецификации), если строка выше не кончается запятой, двоеточием, тире."""
    cuts: list[tuple[int, int]] = []
    for m in _SENTENCE_END.finditer(text):
        if not _ABBR.search(text[max(0, m.start() - 6) : m.start()]):
            cuts.append((m.start() + 1, m.end()))
    for j in joins:
        # перенос после строки, закончившейся точкой, «!», «?», — граница при любой букве дальше (строки таблицы)
        if j + 1 < len(text) and ((text[j + 1].isupper() and text[j - 1] not in ",:-–—(") or text[j - 1] in ".!?"):
            cuts.append((j, j + 1))
    lo, hi = 0, len(text)
    for c_start, c_end in sorted(cuts):
        if c_end <= start:
            lo = c_end
        elif c_start >= end:
            hi = c_start
            break
    return lo, hi


def _line_joins(page: Page) -> frozenset[int]:
    """Позиции пробелов, которыми page_text склеил строки страницы."""
    out, base = set(), 0
    for line in page.lines[:-1]:
        base += len(line.text)
        out.add(base)
        base += 1
    return frozenset(out)


CELL_REST = 40  # оборот и до 40 знаков без значения до конца строки — наименование ячейки таблицы
_CELL_TAIL_STOP = re.compile(r"[.!?]")
_CELL_SEP = re.compile(r"[\s|:–—\-]*")
_BRAND = re.compile(r"(?:[А-ЯЁA-Z]{2,6}[а-яa-z]{0,2}(?=нг))?")
_TOKEN_GOES_ON = re.compile(r"-?[0-9A-Za-zА-Яа-яЁё]")
_WRAP_NEXT = re.compile(r"[0-9A-Za-zА-Яа-яЁё()+\-]")


_OCR_DIGIT = re.compile(r"(?<=\d)[ОOо]|[ОOо](?=\d)|(?<=\d)З|З(?=\d)|(?<=\d)l|l(?=\d)")
_OCR_DIGIT_MAP = {"О": "0", "O": "0", "о": "0", "З": "3", "l": "1"}


def ocr_digits(text: str) -> str:
    """Буква вместо цифры рядом с цифрой (OCR, OS-INSP-2.2.46): О/O → 0, З → 3, l → 1. Замена символ в символ —
    позиции слов и рамки не сдвигаются; I не трогается (EI 60)."""
    return _OCR_DIGIT.sub(lambda m: _OCR_DIGIT_MAP[m.group(0)], text)


def _glued_search(rx: re.Pattern, text: str, start: int, end: int, joins: frozenset[int]) -> tuple[str, int, int] | None:
    """Значение в [start, end), если его разорвал перенос строки («А24» / «0», «КСРВн» / «г(А)-FRLS»): переносы
    между буквами и цифрами убираются, поиск повторяется, позиции возвращаются в исходный текст."""
    keep = [i for i in range(start, end) if not (i in joins and 0 < i < len(text) - 1 and _WRAP_NEXT.match(text[i - 1]) and _WRAP_NEXT.match(text[i + 1]))]
    if len(keep) == end - start:
        return None
    glued = "".join(text[i] for i in keep)
    m = rx.search(glued)
    if not m:
        return None
    return m.group(0), keep[m.start()], keep[m.end() - 1] + 1


def _repair_wrap(rx: re.Pattern, text: str, m: re.Match, joins: frozenset[int]) -> tuple[str, int, int] | None:
    """Значение, разорванное переносом строки (OS-INSP-2.2.46): «B5» / «5» → B55, «нг(А)-LSL» / «Tx» → нг(А)-LSLTx,
    «I» / «II» → III. Слово значения, упёршееся в перенос, склеивается со следующей строкой и сопоставляется заново.
    Возвращает (сырое значение, начало, конец в исходном тексте) или None, если переноса у значения нет."""
    t_end = m.end()
    while t_end < len(text) and not text[t_end].isspace():
        t_end += 1
    rest = text[m.end() : t_end]
    if t_end in joins and t_end + 1 < len(text) and _WRAP_NEXT.match(text[t_end + 1]) and all(_WRAP_NEXT.match(c) for c in rest):
        glued = text[:t_end] + text[t_end + 1 :]
        m2 = rx.match(glued, m.start())
        if m2 and m2.end() > t_end:  # склейка пересекла перенос — значение было разорвано
            return m2.group(0), m.start(), m2.end() + 1
        if rest:
            return "", m.start(), t_end  # хвост слова значения не сопоставился ни до, ни после склейки — не угадываем
        return None
    t_start = m.start()
    while t_start > 0 and not text[t_start - 1].isspace():
        t_start -= 1
    j = t_start - 1
    if j in joins and j > 0 and _WRAP_NEXT.match(text[j - 1]) and t_start == m.start():
        p_start = j
        while p_start > 0 and not text[p_start - 1].isspace():
            p_start -= 1
        glued = text[:j] + text[j + 1 :]
        m2 = rx.match(glued, p_start)
        if m2 and m2.end() >= m.end() - 1:
            return m2.group(0), p_start, m2.end() + 1
    return None


def _excluded(
    cfg: dict, text: str, a_start: int, a_end: int, v_end: int, v_start: int | None = None, joins: frozenset[int] = frozenset()
) -> dict | None:
    """Первое сработавшее правило отсева (OS-INSP-2.2.15) или None. У паспорта с exclude_scope = sentence контекст
    отсева не выходит за предложение упоминания: соседняя фраза про существующее здание не гасит класс объекта
    (OS-INSP-2.2.45, T-172)."""
    lo, hi = max(0, a_start - EXCLUDE_BEFORE), v_end + EXCLUDE_AFTER
    if cfg.get("exclude_scope") == "sentence":
        s_lo, s_hi = _sentence_bounds(text, min(a_start, v_start if v_start is not None else a_start), max(v_end, a_end), joins)
        lo, hi = max(lo, s_lo), min(hi, s_hi)
    wide = text[lo:hi]
    tail = text[a_end:hi] if a_end < v_end else text[v_start if v_start is not None else a_end : a_start]
    near = text[max(lo, (v_start if v_start is not None else v_end) - VALUE_NEAR) : min(hi, v_end + VALUE_NEAR)]
    for rule in cfg.get("exclude") or []:
        # scope = value: правило смотрит только окрестность значения (диапазон «B25–B30», ряд значений таблицы норм),
        # чтобы соседняя строка-перечень не гасила класс объекта (OS-INSP-2.2.44, T-172)
        ctx = near if rule.get("scope") == "value" else tail if rule["code"] in AFTER_ANCHOR_ONLY else wide
        if rule.get("scope") == "sentence":
            start, end = _sentence_bounds(text, min(a_start, v_start if v_start is not None else a_start), max(v_end, a_end), joins)
            ctx = text[start:end]
        if re.search(rule["pattern"], ctx, flags=re.I):
            return rule
    return None


FOREIGN = "\x00foreign"  # ключ-метка элемента вне паспорта (в ответ не уходит)
ELEMENT_BEFORE = 100  # класс конструкции ищется не дальше 100 знаков до оборота или значения (OS-INSP-2.2.43)


def _value_before(rx: re.Pattern, text: str, start: int, end: int) -> re.Match | None:
    """Последнее значение в [start, end) — «здание II степени огнестойкости», «ко II категории» (OS-INSP-2.2.41)."""
    last = None
    for m in rx.finditer(text, start, end):
        last = m
    return last


def _element(
    elements: list[tuple[str, re.Pattern]], text: str, start: int, end: int
) -> str | None:
    """Класс конструкции — ближайший к значению оборот из паспорта в [start, end) (OS-INSP-2.2.43)."""
    best: tuple[int, str] | None = None
    for key, rx in elements:
        for m in rx.finditer(text, start, end):
            if best is None or m.start() > best[0]:
                best = (m.start(), key)
    return best[1] if best else None


def _element_after(elements: list[tuple[str, re.Pattern]], text: str, start: int, end: int) -> str | None:
    """Первый оборот элемента в [start, end) — для значения, стоящего перед оборотом (OS-INSP-2.2.43)."""
    best: tuple[int, str] | None = None
    for key, rx in elements:
        m = rx.search(text, start, end)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), key)
    return best[1] if best else None


def _alt_system(cfg: dict, text: str, start: int, end: int) -> tuple[dict, re.Match] | None:
    """Первая иная система классификации паспорта (value.alt_systems) в окне значения (OS-INSP-2.2.49)."""
    for alt in cfg.get("alt_systems") or []:
        m = re.search(alt["pattern"], text[start:end])
        if m:
            return alt, m
    return None


def _alt_mention(spec: ParamSpec, page: Page, spans, text: str, a: re.Match, alt: tuple[dict, re.Match], conf: float) -> Extraction:
    """Упоминание, где вместо шкалы паспорта — иная система: отсеяно с кодом ALT_SYSTEM, сравнение по нему невозможно."""
    rule, m = alt
    s0, s1 = a.end() + m.start(), a.end() + m.end()
    quote = _quote(text, a.start(), s1)
    return Extraction(
        code=spec.code, raw=m.group(0), value_text=m.group(0), page=page.page, bbox=_bbox(spans, s0, s1),
        anchor_bbox=_bbox(spans, a.start(), a.end()), line_text=quote, confidence=round(conf, 3),
        meta={"quote": quote, "qualifier": None, "excluded": "ALT_SYSTEM", "excluded_why": rule["why"], "alt_system": rule["code"], "ops": list(OPS)},
    )


def _page_mentions(page: Page, spec: ParamSpec, cfg: dict) -> list[Extraction]:
    text, spans = page_text(page)
    sentence = cfg.get("exclude_scope") == "sentence"
    if sentence:
        text = ocr_digits(text)
    anchors = list(re.finditer(cfg["anchor"], text, flags=re.I))
    value_rx = re.compile(cfg["value"])
    window = int(cfg.get("window", 160))
    before_win = int(cfg.get("before") or 0)
    scale = cfg.get("scale")
    # T-172: с написаниями из паспорта канон берётся по таблице свёрток; без них — прежний путь М-023
    table = canon_table(scale, cfg.get("aliases")) if scale is not None and cfg.get("aliases") is not None else None
    elements = [(e["key"], re.compile(e["pattern"], flags=re.I)) for e in cfg.get("elements") or []]
    # OS-INSP-2.2.47: конструкции, которых нет в паспорте («сборные изделия», «благоустройство»), — отсев, а не общее значение
    foreign = [(FOREIGN, re.compile(p, flags=re.I)) for p in cfg.get("foreign_elements") or []]
    # T-172: паспорта W1 — контекст отсева и маркера в пределах предложения, ремонт переноса строки в значении
    joins = _line_joins(page) if sentence else frozenset()
    prev_end = 0
    markers = [_marker_re(m) for m in cfg.get("constraint_markers") or []]
    base_conf = 1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
    out: list[Extraction] = []
    for i, a in enumerate(anchors):
        # окно после якоря обрывается на следующем обороте: его значение — не наше
        limit = a.end() + window
        if i + 1 < len(anchors):
            limit = min(limit, anchors[i + 1].start())
        b_lo = max(prev_end, a.start() - before_win)
        if sentence:  # значение — в предложении оборота: класс соседней строки не подставляется вместо неразборчивого
            s_lo, s_hi = _sentence_bounds(text, a.start(), a.end(), joins)
            rest = text[a.end() : s_hi]
            nxt = _CELL_SEP.match(text, s_hi).end() if s_hi < len(text) else s_hi
            nxt = _BRAND.match(text, nxt).end()  # марка перед исполнением: «КСРВ» в «КСРВнг(А)-FRLS»
            if len(rest) <= CELL_REST and value_rx.search(rest) is None and _CELL_TAIL_STOP.search(rest) is None and value_rx.match(text, nxt):
                # оборот закончил ячейку или строку таблицы («Класс бетона» / «B30»): значение — первым в следующей строке
                s_hi = _sentence_bounds(text, s_hi + 1, s_hi + 1, joins)[1]
            limit, b_lo = min(limit, s_hi), max(b_lo, s_lo)
        m = value_rx.search(text, a.end())
        if m is not None and m.end() > limit:
            m = None  # значение дальше окна или за границей предложения — не наше (у М-023 — прежняя семантика окна)
        if m is not None and spec.code == "M-023" and ";" in text[a.end():m.start()]:
            m = None  # a following list item has its own subject and class anchor
        if m is None and before_win:
            m = _value_before(value_rx, text, b_lo, a.start())
            if m is not None and spec.code == "M-023" and not re.fullmatch(
                r"\s*(?:[—–:-]\s*)?(?:класс\w*\s+)?", text[m.end():a.start()], re.I
            ):
                m = None  # only an adjacent reversed label, never a preceding sentence
        if spec.code == "M-023" and before_win:
            adjacent = _value_before(value_rx, text, b_lo, a.start())
            if adjacent is not None and re.fullmatch(
                r"\s*(?:[—–:-]\s*)?(?:класс\w*\s+)?", text[adjacent.end():a.start()], re.I
            ):
                m = adjacent  # direct reversed label outranks a later paragraph's class
        glued = _glued_search(value_rx, text, a.end(), limit, joins) if sentence else None
        if sentence and m is None and glued is None and limit < len(text):
            # значение началось в предложении оборота, а перенос с заглавной («К» / «М4») отрезал хвост: одна строка сверх
            ext = min(a.end() + window, _sentence_bounds(text, limit + 1, limit + 1, joins)[1])
            g = _glued_search(value_rx, text, a.end(), ext, joins)
            glued = g if g is not None and g[1] < limit else None
        if m is not None and glued is not None and not (glued[1] <= m.start() and glued[2] >= m.end() and glued[2] - glued[1] > m.end() - m.start()):
            glued = None  # склейка берётся, только если она накрывает найденное значение и длиннее его («особой гр» / «уппы I»)
        if m is None and glued is None:
            alt = _alt_system(cfg, text, a.end(), limit)
            if alt is not None:  # OS-INSP-2.2.49: другая система классификации (Г, В, Д, Т, РП вместо КМ)
                out.append(_alt_mention(spec, page, spans, text, a, alt, base_conf))
            continue  # значения нет — упоминание не выдаётся (заголовок, общее положение)
        raw, v_start, v_end = glued if glued else (m.group(0), m.start(), m.end())
        # Римскую степень нельзя склеивать с номером следующей строки/очереди.
        # Перенос подписи допускается; перенос самой цифры требует чтения изображения.
        if spec.code == "M-022":
            glued = None
            if m is None:
                continue
            raw, v_start, v_end = m.group(0), m.start(), m.end()
        wrapped = _repair_wrap(value_rx, text, m, joins) if sentence and m is not None and spec.code != "M-022" else None
        if wrapped is not None:
            raw, v_start, v_end = wrapped
            if not raw:
                continue  # слово значения разорвано переносом и не склеивается в значение шкалы — не угадываем
        if sentence and v_end < len(text) and _TOKEN_GOES_ON.match(text, v_end):
            continue  # значение оборвалось посреди слова («нг(В)» от «нг(В)-НF»): разобрано не целиком — не угадываем
        value = canon_class(raw, table) if table is not None else normalize_class(raw)
        if value is None or (scale is not None and value not in scale):
            continue  # вне шкалы — не класс этого параметра (NRM-04)
        lo = min(a.start(), v_start)
        element = _element(elements + foreign, text, max(prev_end, lo - ELEMENT_BEFORE), v_start) if elements else None
        if element is None and elements and sentence:
            # значение перед оборотом («II — категория … противопожарных систем»): элемент — после значения, в том же предложении
            e_hi = min(limit, _sentence_bounds(text, lo, max(v_end, a.end()), joins)[1])
            element = _element_after(elements + foreign, text, v_end, e_hi)
        prev_end = max(v_end, a.end())
        q_lo = max(0, lo - QUALIFIER_BEFORE)
        if sentence:  # «не ниже» из предыдущего предложения — не ограничение этого значения
            q_lo = max(q_lo, _sentence_bounds(text, lo, v_end, joins)[0])
        before = text[q_lo:v_start]
        qualifier = (
            "min" if any(re.search(p, before, flags=re.I) for p in markers) else None
        )
        rule = _excluded(cfg, text, a.start(), a.end(), v_end, v_start, joins)
        if rule is None and element == FOREIGN:
            rule = {"code": "FOREIGN_ELEMENT", "why": "элемент не в паспорте параметра: класс другой конструкции"}
            element = None
        subject_meta = {}
        if spec.code in {"M-021", "M-124"} and value == "C":
            # The archive explicitly labels C as normal under SP50, whereas the
            # passport uses 399/pr. A shared letter is not a scale conversion.
            normal = re.match(r"\s*\(\s*нормальн\w*\s*\)", text[v_end:], re.I)
            if normal and re.search(r"СП\s*50\s*\.\s*13330", text, re.I):
                rule = rule or {"code": "ALT_SYSTEM", "why": "C обозначен как нормальный класс при ссылке на СП 50; соответствие шкале 399/пр не установлено"}
                subject_meta = {"alt_system": "ENERGY_SP50_C_NORMAL",
                    "classification_basis_status": "incompatible_with_passport"}
        if spec.code == "M-023":
            # A margin stamp may be interleaved into the PDF reading order.
            # Mask only its exact abbreviation, retaining all source offsets.
            subject_text = re.sub(r"\bВзам\.", lambda m: " " * len(m.group()), text)
            start, _ = _sentence_bounds(subject_text, min(a.start(), v_start), max(a.end(), v_end), joins)
            subjects = list(re.finditer(r"рамп\w*|здани\w*|жил\w*\s+дом\w*", subject_text[start:min(a.start(), v_start)], re.I))
            if subjects and subjects[-1].group().lower().startswith("рамп"):
                subject = subjects[-1]
                joint = re.search(
                    r"проектируем\w*\s+(?:жил\w*\s+)?(?:здани\w*|дом\w*)\s+и\s+"
                    r"(?:надземн\w*\s+част\w*\s+)?(?:изолированн\w*\s+)?рамп\w*\s*$",
                    subject_text[start:start + subject.end()], re.I)
                subject_meta = {"subject_key": "subobject:ramp",
                    "subject_quote": subject.group(),
                    "subject_bbox": _bbox(spans, start + subject.start(), start + subject.end())}
                if joint:
                    subject_meta = {"subject_key": "object_and_ramp",
                        "subject_quote": joint.group(),
                        "subject_bbox": _bbox(spans, start + joint.start(), start + joint.end())}
                else:
                    rule = rule or {"code": "SUBOBJECT", "why": "класс рампы не устанавливает класс всего проверяемого здания"}
            external = re.search(
                r"\bдо\s+(?:площадк\w*\s+под\s+размещени\w*\s+)?"
                r"трансформаторн\w*\s+подстанци\w*"
                r"(?:\s+[IVІХХV]+\s+степени\s+огнестойкости\s*,?)?\s*$",
                subject_text[start:min(a.start(), v_start)], re.I)
            if external:
                subject_meta = {"subject_key": "external:transformer",
                    "subject_quote": external.group(),
                    "subject_bbox": _bbox(spans, start + external.start(), start + external.end())}
                rule = rule or {"code": "NEIGHBOR", "why": "класс подстанции, до которой измеряется расстояние от объекта"}
        if spec.code == "M-022":
            s_lo, s_hi = _sentence_bounds(text, lo, max(v_end, a.end()), joins)
            line_start = max((j + 1 for j in joins if j < a.start()), default=0)
            if re.match(r"\s*[-–—]\s*степень\s+огнестойкости\s+здания\b", text[line_start:], re.I):
                s_lo = max(s_lo, line_start)
            s_lo = fire_degree.heading_start(text, s_lo, joins)
            degree_rule, subject, subject_span = fire_degree.assess(text, s_lo, s_hi, v_start, v_end)
            # Реконструируемое здание является объектом проверки; само слово
            # «существующее» не делает его соседним. Явный сосед по-прежнему отсеивается.
            scope = text[s_lo:s_hi]
            # A immediately preceding location sentence can identify the same
            # neighbor; an explicit switch to the project object breaks inheritance.
            if rule is None and s_lo > 0 and not re.search(r"проектируем\w*|реконструируем\w*", scope, re.I):
                previous = text[max(0, s_lo - 240):s_lo].rstrip()
                if re.search(r"(?:находится|расположен\w*)\s+(?:с|к|в)\s+(?:север\w*|юг\w*|запад\w*|восток\w*)\s+от\s+реконструируем\w*\s+здани\w*\s*[.!?]?\s*$", previous, re.I):
                    rule = {"code": "NEIGHBOR", "why": "степень относится к зданию, непосредственно описанному как сосед реконструируемого объекта"}
            if rule and rule["code"] == "NEIGHBOR" and re.search(r"реконструируем\w*", scope, re.I) and not re.search(r"соседн\w*|расстояни\w*|кадастров\w*|адрес\w*|(?:с|к|в)\s+(?:север\w*|юг\w*|запад\w*|восток\w*)", scope, re.I):
                rule = None
            rule = rule or degree_rule
            subject_meta = {
                "subject_key": subject,
                "subject_quote": text[subject_span[0]:subject_span[1]] if subject_span else None,
                "subject_bbox": _bbox(spans, *subject_span) if subject_span else None,
            }
        conf = base_conf
        if any(w.disputed for w in _words_in(spans, v_start, v_end)):
            conf *= DISPUTED_PENALTY
        quote = _quote(text, min(a.start(), v_start), max(v_end, a.end()))
        out.append(
            Extraction(
                code=spec.code,
                raw=raw,
                value_text=value,
                page=page.page,
                bbox=_bbox(spans, v_start, v_end),
                anchor_bbox=_bbox(spans, a.start(), a.end()),
                line_text=quote,
                confidence=round(conf, 3),
                meta={
                    "quote": quote,
                    **subject_meta,
                    "qualifier": qualifier,
                    "excluded": rule["code"] if rule else None,
                    "excluded_why": rule.get("why") if rule else None,
                    **({"element": element} if elements else {}),
                    "ops": list(OPS),
                },
            )
        )
    return out


def extract_class_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все упоминания класса в документе по порядку страниц, включая отсеянные (meta.excluded)."""
    cfg = spec.extractor or {}
    out: list[Extraction] = []
    for page in doc.pages:
        columns = fire_distance_table.columns(page) if spec.code == "M-022" else None
        if columns is not None:
            for role, column_page in columns:
                for mention in _page_mentions(column_page, spec, cfg):
                    if role != "before":
                        mention.meta["table_subject_role"] = role
                    if role in {"destination", "required_distance", "actual_distance"}:
                        mention.meta["excluded"] = "NEIGHBOR" if role == "destination" else "TABLE_REFERENCE"
                        mention.meta["excluded_why"] = "степень в колонке другого объекта или справочного расстояния, не исходного объекта"
                    out.append(mention)
            continue
        out += _page_mentions(page, spec, cfg)
    return out
