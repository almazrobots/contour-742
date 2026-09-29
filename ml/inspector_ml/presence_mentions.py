"""Упоминания мероприятия и метода по паспорту (OS-INSP-2.2.135–2.2.144, T-212; первые параметры — М-053, 063, 070,
092, 095, 122 — мероприятие есть/исключено, CMP-09; М-091 — метод демонтажа, CMP-23).

Как у упоминаний класса и количества (class_mentions.py, quantity_mentions.py), сохраняется КАЖДОЕ упоминание:
API выбирает источник по приоритету разделов и решает по стадиям. Конфигурация — из паспорта (`ParamSpec.extractor`):
аспекты с шаблонами элемента, отрицания и утверждения, счётные шаблоны и марки, отсев чужого контекста, ссылки без
содержания, похожие элементы, узлы, где элемент обязан быть; у метода — словарь `terms` и оборот «метод демонтажа».

Текст страницы нормализуется до поиска: латинская буква-двойник в кириллическом слове → кириллица («дeмпфeр»),
перенос в конце строки склеивается («раз-/борки»), строка таблицы и пункт примечаний — отдельное предложение.

Отрицание решается внутри предложения: сказуемое перед оборотом (в пределах своей части, до запятой) или первое
сказуемое после него. Отрицание, за которым в той же части стоит другой элемент, относится к нему («разборка,
исключающая обрушение»); «без» после оборота — не сказуемое оборота. Двойное отрицание («отсутствие … не
допускается») — «есть». Упоминание без сказуемого (спецификация, легенда) — «есть». В таблице с шапкой отдельной
строкой значение столбца под оборотом шапки («Звукоиз. слой» → «нет») решает состояние.

Подсказки (meta.hint) — не «есть» и не «нет»: reference — ссылка без содержания («по альбому», «согласно ПОД»,
нечитаемое число «?»), other — похожий, но другой элемент («шов бетонирования»), implied — узел, где элемент
обязан быть, показан без него («Примыкание перегородки к перекрытию на растворе»).

Время линейно по странице (OWASP W3-03): границы предложений, обороты, слова и строки таблиц ищутся один раз и дальше —
двоичным поиском; предложение ограничено окном ±WINDOW знаков вокруг оборота (страница без точек — не одно предложение
на всё); упоминаний на параметр в документе — не больше MAX_PER_DOC, сверх — отметка truncated.
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from itertools import accumulate

from .class_mentions import page_text
from .model import Extraction, Page, ParamSpec, ParsedDoc
from .parse import union

KIND = "presence_mentions"
METHOD_KIND = "method_mentions"  # вид method: тот же извлекатель, value_kind и словарь — из спецификации
OPS_PRESENCE = ["ENT-19", "CMP-09"]
OPS_METHOD = ["ENT-19", "NRM-06", "CMP-23"]
BEFORE = 80  # сказуемое перед оборотом ищется не дальше 80 знаков…
AFTER = 120  # …и после — не дальше 120, в пределах предложения
EXCLUDE_BEFORE = 120  # контекст отсева чужого объекта: 120 знаков до оборота и 80 после
EXCLUDE_AFTER = 80
QUOTE_MAX = 240
WINDOW = 200  # окно предложения вокруг оборота: сказуемые, число, контекст, ссылка, отсев — не дальше
MAX_PER_DOC = 200  # упоминаний параметра в документе; сверх — отметка truncated у выданных
DISPUTED_PENALTY = (
    0.6  # как в extract.py: оборот из слова, где движки OCR разошлись (OS-INSP-2.1.6)
)
# конец предложения: «;», «!», перевод строки таблицы или пункта, точка или «?» перед словом с заглавной буквы или в
# конце («толщ. 8 мм», «шт. по углам», «бл. А и Б», «верт. L=3м», «? шт.» — не конец)
SENT_END = re.compile(r"[;!\n]|[.?](?=\s+(?:[А-ЯЁA-Z][а-яёa-z]|[«\"(])|\s*$)")
# граница части предложения до оборота: сказуемое другой части («Исключить обрушение, демонтаж вести…») — не наше
PART_BEFORE = re.compile(r"[,:|]")
# противопоставление после оборота: «…предусмотрены, а гидроизоляция не требуется» — дальше чужая часть
CONTRAST = re.compile(r",\s*(?:а|но|однако|при\s+этом)(?![А-Яа-яЁё])|\|", flags=re.I)
# граница своей части после оборота метода
PART_AFTER = re.compile(r"[,;:|]")
# «без» — предлог: отрицает только то, что стоит после него
BEFORE_ONLY = re.compile(r"без", flags=re.I)
# значение ячейки таблицы, которое говорит «нет»
CELL_NO = re.compile(r"\s*(?:нет|не\s+\w+|отсутств\w*|исключ\w*)\s*\.?\s*", flags=re.I)
CELL_EMPTY = re.compile(r"\s*[—–-]?\s*")
LAT2CYR = str.maketrans("aeopcxykmthbAEOPCXYKMTHB", "аеорсхукмтнвАЕОРСХУКМТНВ")
CYR = re.compile(r"[А-Яа-яЁё]")
LIST_ITEM = re.compile(r"\s*\d{1,2}[.)]\s")
# запись изменения (OS-INSP-2.2.139): «было — X, стало — Y», «X заменить на Y», «заменить X на Y» — X отменён
CHANGE_OLD = {"code": "CHANGE_OLD", "why": "отменённое значение записи изменения («было …», «… заменить на …») — действует новое"}
OLD_SPANS = [
    re.compile(r"(?<![А-Яа-яЁё])было\s*[:—–-]?\s*(?P<old>[^;]+?)(?=,?\s*стало)", flags=re.I),
    re.compile(r"(?<![А-Яа-яЁё])замен\w*\s+(?P<old>(?!на\s)[^,;:]+?)\s+на(?![А-Яа-яЁё])", flags=re.I),
    re.compile(r"(?:^|[,;:—\n])(?P<old>[^,;:—\n]+?)\s+замен\w*\s+на(?![А-Яа-яЁё])", flags=re.I),
]
# запрет работы — само мероприятие (OS-INSP-2.2.138): «не допускается производство работ в охранной зоне»; и запрет «…
# без X» — X обязателен. Только у мероприятия: у метода «обрушение … запрещается» — запрет метода.
PROHIBIT = re.compile(r"не\s+допуска\w*|запрещ\w*|не\s+разреша\w*", flags=re.I)
WORK_BAN = re.compile(
    r"(?:не\s+допуска\w*|запрещ\w*)[^.;\n]{0,40}?(?:производств\w*\s+работ|работ[аыу]?(?![А-Яа-яЁё])|проезд\w*|движени\w*|складировани\w*)"
    r"|(?:производств\w*\s+работ|работ[аы]?\s+(?:техники|механизмов|машин)|проезд\w*|движени\w*)[^.;\n]{0,40}?(?:не\s+допуска\w*|запрещ\w*)",
    flags=re.I,
)


def is_presence_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") in (KIND, METHOD_KIND)


def normalize(page: Page) -> tuple[str, list[int], list[tuple[int, int]]]:
    """Текст страницы для поиска (OS-INSP-2.2.136), индекс исходного символа для каждого символа и диапазоны строк
    таблиц. Длина меняется только при склейке переноса, поэтому рамки считаются по индексу, а не по позиции."""
    chars: list[str] = []
    idx: list[int] = []
    tables: list[tuple[int, int]] = []
    pos = 0
    lines = page.lines
    for li, line in enumerate(lines):
        t = line.text
        fixed = "".join(
            w.translate(LAT2CYR) if CYR.search(w) else w for w in re.split(r"(\s+)", t)
        )
        start = len(chars)
        chars += list(fixed)
        idx += range(pos, pos + len(fixed))
        table = "|" in t
        if table:
            tables.append((start, len(chars)))
        pos += len(t)
        if li + 1 < len(lines):
            nxt = lines[li + 1].text
            if not table and re.search(r"[А-Яа-яЁё]-$", t) and re.match(r"[а-яё]", nxt):
                chars.pop()  # перенос: дефис уходит, слово склеивается
                idx.pop()
            else:
                hard = (
                    table
                    or "|" in nxt
                    or LIST_ITEM.match(nxt)
                    or t.rstrip().endswith(":")
                )
                chars.append("\n" if hard else " ")
                idx.append(pos)
            pos += 1
    return "".join(chars), idx, tables


def _mask(cfg: dict, text: str) -> str:
    """Ссылки без содержания закрываются пробелами: «(в комплекте нет)» — не отрицание элемента."""
    for p in cfg.get("reference") or []:
        text = re.sub(p, lambda m: " " * len(m.group(0)), text, flags=re.I)
    return text


def _predicates(
    cfg: dict, text: str, after: bool = False
) -> list[tuple[int, int, bool]]:
    """Сказуемые по порядку: (начало, конец, отрицание?). Утверждение внутри отрицания («не предусмотрено») — не
    отдельное сказуемое; «без» после оборота — не сказуемое оборота."""
    text = _mask(cfg, text)
    neg = [
        (m.start(), m.end(), True)
        for p in cfg.get("negation") or []
        for m in re.finditer(p, text, flags=re.I)
        if not (after and BEFORE_ONLY.fullmatch(m.group(0)))
    ]
    aff = [
        (m.start(), m.end(), False)
        for p in cfg.get("affirm") or []
        for m in re.finditer(p, text, flags=re.I)
        if not any(a <= m.start() < b for a, b, _ in neg)
    ]
    return sorted(neg + aff)


def _state_at(
    cfg: dict,
    text: str,
    a0: int,
    a1: int,
    s0: int,
    s1: int,
    others: list[tuple[int, int]],
    method: bool = False,
) -> tuple[str, str | None, tuple[int, int] | None]:
    """«present» или «absent», сказуемое, которое решило, и его место в тексте страницы (T-233: рамка упоминания — слова,
    решившие состояние, а не подпись). У метода сказуемое после оборота — только в своей части («обрушение стен
    экскаватором, без применения взрывчатки» — отрицание не про обрушение)."""
    before = text[max(s0, a0 - BEFORE) : a0]
    b0 = max(s0, a0 - BEFORE)
    cut = [m.end() for m in PART_BEFORE.finditer(before)]
    if cut:
        b0 += cut[-1]
    before = before[cut[-1] :] if cut else before
    after = text[a1 : min(s1, a1 + AFTER)]
    c = (PART_AFTER if method else CONTRAST).search(after)
    after = after[: c.start()] if c else after
    pb = _predicates(cfg, before)
    pa = _predicates(cfg, after, after=True)
    first_after = None
    if pa:
        st, en, is_neg = pa[0]
        # отрицание, за которым в той же части (без запятой между) стоит другой элемент, управляет им
        # («разборка, исключающая обрушение»); «орошение не предусматривается, фасад — сеткой» — не блокирует
        blocked = is_neg and any(
            a1 + en <= o0 < a1 + len(after)
            and not PART_BEFORE.search(text, a1 + en, o0)
            for o0, _ in others
        )
        first_after = None if blocked else (is_neg, after[st:en], (a1 + st, a1 + en))
    if pb:
        st, en, is_neg = pb[-1]
        word = before[st:en]
        at = (b0 + st, b0 + en)
        if is_neg and first_after is not None and first_after[0]:
            return (
                "present",
                f"{word} … {first_after[1]}",
                at,
            )  # двойное отрицание: «отсутствие … не допускается»
        return ("absent" if is_neg else "present"), word, at
    if first_after is not None:
        return ("absent" if first_after[0] else "present"), first_after[1], first_after[2]
    return "present", None, None


def _excluded(cfg: dict, text: str, a0: int, a1: int, s0: int, s1: int) -> dict | None:
    """Первое сработавшее правило отсева (чужой объект — «в соседнем здании») в пределах предложения. Правило
    со scope «anchor» срабатывает, только если его совпадение накрывает сам оборот: «опасная зона обрушения»
    отсеивает «обрушение», но не «поэлементную разборку» в том же предложении."""
    c0 = max(s0, a0 - EXCLUDE_BEFORE)
    ctx = text[c0 : min(s1, a1 + EXCLUDE_AFTER)]
    for rule in cfg.get("exclude") or []:
        for m in re.finditer(rule["pattern"], ctx, flags=re.I):
            if rule.get("scope") != "anchor" or (
                c0 + m.start() < a1 and c0 + m.end() > a0
            ):
                return rule
    return None


def _count(
    cfg: dict, aspect: str, text: str, a0: int, s0: int, s1: int
) -> float | str | None:
    """Число аспекта в предложении (OS-INSP-2.2.140): ближайшее к обороту; «?» — нечитаемо."""
    best: tuple[int, float | str] | None = None
    for c in cfg.get("count") or []:
        p = c if isinstance(c, str) else c["pattern"]
        if not isinstance(c, str) and c["aspect"] != aspect:
            continue
        for m in re.finditer(p, text[s0:s1], flags=re.I):
            g = next((x for x in m.groups() if x), None)
            if g is None:
                continue
            d = abs(s0 + m.start() - a0)
            if best is None or d < best[0]:
                best = (d, "?" if g == "?" else float(g.replace(",", ".")))
    return best[1] if best else None


Match = tuple[
    int, int, str, str | None, str
]  # начало, конец, аспект, метод, вид: anchor | generic | phrase | other


class _Spans:
    """Отрезки, отсортированные по началу, с накопленным максимумом концов: пересечение с [a, b) — за O(log n)."""

    def __init__(self, spans: list):
        self.spans = sorted(spans, key=lambda x: x[0])
        self.starts = [x[0] for x in self.spans]
        self.maxend = list(accumulate((x[1] for x in self.spans), max))

    def overlaps(self, a: int, b: int) -> bool:
        i = bisect_left(self.starts, b)  # отрезки, начатые до b
        return i > 0 and self.maxend[i - 1] > a


def _overlaps(spans: list, a: int, b: int) -> bool:
    return _Spans(spans).overlaps(a, b) if spans else False


def _matches(cfg: dict, text: str) -> list[Match]:
    """Обороты страницы. Пересечения снимаются отдельно у элементов (первый и длинный) и у оборотов «метод
    демонтажа»; элемент, накрытый похожим другим элементом («козырёк-экран»), уступает ему."""
    anchors = cfg.get("anchors") or []
    main = next((a["aspect"] for a in anchors if a["aspect"] != "*"), "main")
    found: list[Match] = []
    if cfg.get("value_kind") == "method":
        for t in cfg.get("terms") or []:
            for p in t["patterns"]:
                found += [
                    (m.start(), m.end(), main, t["key"], "anchor")
                    for m in re.finditer(p, text, flags=re.I)
                ]
    for a in anchors:
        kind = (
            "generic"
            if a.get("only_absent")
            else ("phrase" if cfg.get("value_kind") == "method" else "anchor")
        )
        found += [
            (m.start(), m.end(), a["aspect"], None, kind)
            for m in re.finditer(a["pattern"], text, flags=re.I)
        ]
    others = [
        (m.start(), m.end(), o["aspect"], None, "other")
        for o in cfg.get("lookalike") or []
        for m in re.finditer(o["pattern"], text, flags=re.I)
    ]
    look = _Spans(others)
    found = [f for f in found if not (others and look.overlaps(f[0], f[1]))]
    # общий оборот уступает элементу, который он накрывает: «Действующие коммуникации отключить и защитить» — элемент
    specific = _Spans([f for f in found if f[4] == "anchor"])
    found = [f for f in found if f[4] != "generic" or not specific.overlaps(f[0], f[1])]
    out: list[Match] = []
    for group in (("anchor", "generic", "other"), ("phrase",)):
        kept: list[Match] = []
        for f in sorted(
            (x for x in found + others if x[4] in group),
            key=lambda x: (x[0], -(x[1] - x[0])),
        ):
            if kept and f[0] < kept[-1][1]:
                continue
            kept.append(f)
        out += kept
    return sorted(out, key=lambda x: (x[0], x[4] == "phrase"))


def _aspects(cfg: dict, aspect: str) -> list[str]:
    """Аспект «*» общего оборота — все аспекты паспорта."""
    if aspect != "*":
        return [aspect]
    return list(
        dict.fromkeys(
            a["aspect"] for a in cfg.get("anchors") or [] if a["aspect"] != "*"
        )
    ) or ["main"]


class _Page:
    """Страница для извлечения: нормализованный текст, рамки слов, накопленные упоминания."""

    def __init__(self, page: Page, spec: ParamSpec, cfg: dict, budget: list[int] | None = None):
        self.page, self.spec, self.cfg = page, spec, cfg
        _, self.spans = page_text(page)
        self.text, self.idx, self.tables = normalize(page)
        self.method = cfg.get("value_kind") == "method"
        self.base_conf = (
            1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
        )
        self.out: list[Extraction] = []
        self.seen: set[tuple] = set()
        self.old = _Spans([(m.start("old"), m.end("old")) for rx in OLD_SPANS for m in rx.finditer(self.text)])
        bounds = [(m.start(), m.end()) for m in SENT_END.finditer(self.text)]
        self.b_starts = [b[0] for b in bounds]
        self.b_ends = [b[1] for b in bounds]
        self.w_starts = [w[0] for w in self.spans]
        self.w_ends = [w[1] for w in self.spans]
        self.t_starts = [t[0] for t in self.tables]
        self.budget = budget if budget is not None else [MAX_PER_DOC]
        self.truncated = False

    def sent(self, a0: int, a1: int) -> tuple[int, int]:
        """Границы предложения вокруг [a0, a1) — не шире окна ±WINDOW (OWASP W3-03)."""
        i = bisect_left(self.b_starts, a0)
        s0 = self.b_ends[i - 1] if i else 0
        j = bisect_left(self.b_starts, a1)
        s1 = self.b_starts[j] if j < len(self.b_starts) else len(self.text)
        return max(s0, a0 - WINDOW), min(s1, a1 + WINDOW)

    def words(self, a0: int, a1: int):
        """Слова исходного текста под [a0, a1) нормализованного — двоичным поиском по диапазонам слов."""
        o0, o1 = self.idx[a0], self.idx[max(a0, a1 - 1)] + 1
        i = bisect_right(self.w_ends, o0)
        j = bisect_left(self.w_starts, o1)
        return [w for _, _, w in self.spans[i:j]]

    def in_table(self, p: int) -> bool:
        i = bisect_right(self.t_starts, p)
        return i > 0 and p < self.tables[i - 1][1]

    def box(self, a0: int, a1: int):
        return union([w.bbox for w in self.words(a0, a1)])

    def emit(
        self,
        a0: int,
        a1: int,
        aspect: str,
        term: str | None,
        state: str,
        why: str | None,
        hint: str | None,
        s0: int,
        s1: int,
        count=None,
        vspan: tuple[int, int] | None = None,
    ) -> None:
        old = bool(self.old.spans) and self.old.overlaps(a0, a0 + 1)
        key = (s0, aspect, term, state, hint, old)
        if key in self.seen:
            return  # один элемент дважды в одном предложении — одно упоминание
        if self.budget[0] <= 0:
            self.truncated = True  # предел упоминаний в документе (OWASP W3-03)
            return
        self.budget[0] -= 1
        self.seen.add(key)
        text = self.text
        # похожий другой элемент — не довод «есть»: его место («у соседнего здания») подсказку не отсеивает
        rule = CHANGE_OLD if old else None if hint == "other" else _excluded(self.cfg, text, a0, a1, s0, s1)
        if count is None and not self.method:
            count = _count(self.cfg, aspect, text, a0, s0, s1)
        if count == "?":
            count, hint = (
                None,
                hint or "reference",
            )  # число нечитаемо — утверждать нельзя
        conf = self.base_conf
        if any(w.disputed for w in self.words(a0, a1)):
            conf *= DISPUTED_PENALTY
        quote = text[s0:s1].strip()
        if len(quote) > QUOTE_MAX:
            pad = max(0, (QUOTE_MAX - (a1 - a0)) // 2)
            quote = text[max(s0, a0 - pad) : min(s1, a1 + pad)].strip()
        box = self.box(a0, a1)
        # T-233: рамка упоминания мероприятия — слова, решившие состояние («предусмотрены», «не предусмотрено (исключено)»);
        # подпись пункта — anchor_bbox. У метода значение — сам оборот (название метода), его рамка не меняется.
        vbox = self.box(*vspan) if vspan and not self.method else None
        self.out.append(
            Extraction(
                code=self.spec.code,
                raw=text[a0:a1][:QUOTE_MAX],  # OWASP W3-06: сырой оборот — не длиннее цитаты
                value_text=state,
                value_num=count,
                page=self.page.page,
                bbox=vbox or box,
                anchor_bbox=box,
                line_text=quote,
                confidence=round(conf, 3),
                meta={
                    "quote": quote,
                    "state": state,
                    "aspect": aspect,
                    "term": term,
                    "count": count,
                    "hint": hint,
                    "predicate": why,
                    "excluded": rule["code"] if rule else None,
                    "excluded_why": rule.get("why") if rule else None,
                    "ops": list(OPS_METHOD if self.method else OPS_PRESENCE),
                },
            )
        )

    def part(self, a0: int, a1: int, s0: int, s1: int, aspect: str) -> str:
        """Часть здания при обороте в том же предложении — аспект упоминания: ближайшая перед оборотом («надземная часть —
        …; фундаменты — …»), а без неё — названная после оборота в его части («ручная разборка временных зданий»)."""
        parts = self.cfg.get("parts") or []
        best = None
        for pr in parts:
            for m in re.finditer(pr["pattern"], self.text[s0:a0], flags=re.I):
                if best is None or m.start() > best[0]:
                    best = (m.start(), pr["aspect"])
        if best:
            return best[1]
        tail = self.text[a1:s1]
        c = PART_AFTER.search(tail)
        tail = tail[: c.start()] if c else tail
        after = [(m.start(), pr["aspect"]) for pr in parts for m in [re.search(pr["pattern"], tail, flags=re.I)] if m]
        return min(after)[1] if after else aspect

    def referenced(self, s0: int, s1: int) -> bool:
        return any(
            re.search(p, self.text[s0:s1], flags=re.I)
            for p in self.cfg.get("reference") or []
        )

    def one(
        self,
        f: Match,
        ms: list[Match],
        s0: int,
        s1: int,
        state: str | None = None,
        why: str | None = None,
        span: tuple[int, int] | None = None,
    ) -> None:
        """Одно упоминание: состояние по сказуемому (или заданное ячейкой таблицы), подсказка, общий оборот."""
        a0, a1, aspect, term, kind = f
        if kind == "other":
            self.emit(a0, a1, aspect, term, "present", None, "other", s0, s1)
            return
        if state is None:
            others = [(b0, b1) for b0, b1, *_ in self.within(ms, s0, s1) if (b0, b1) != (a0, a1)]
            state, why, span = _state_at(self.cfg, self.text, a0, a1, s0, s1, others, self.method)
            sent = self.text[s0:s1]
            if not self.method and state == "absent" and WORK_BAN.search(sent):
                state, why = "present", "запрет работ — мероприятие обязательно"
            elif not self.method and state == "absent" and why and why.lower() == "без" and PROHIBIT.search(self.text[s0:a0]):
                state, why = "present", "запрет «без …» — мероприятие обязательно"
        if aspect != "*":
            aspect = self.part(a0, a1, s0, s1, aspect)
        hint = "reference" if state == "present" and self.referenced(s0, s1) else None
        if kind == "generic" and state == "present" and hint is None:
            return  # общий оборот без отрицания и ссылки («Мероприятия по защите от шума: …») — не упоминание
        for asp in _aspects(self.cfg, aspect):
            self.emit(a0, a1, asp, term, state, why, hint, s0, s1, vspan=span)

    def within(self, ms: list[Match], s0: int, s1: int) -> list[Match]:
        """Обороты, начатые в [s0, s1) — срез по отсортированным началам."""
        return ms[bisect_left(self.m_starts, s0) : bisect_left(self.m_starts, s1)]

    def sentences(self, ms: list[Match]) -> None:
        context = self.cfg.get("context")
        for f in ms:
            if self.budget[0] <= 0:
                self.truncated = True
                return
            a0, a1, _, term, kind = f
            if self.in_table(a0):
                continue
            s0, s1 = self.sent(a0, a1)
            if (
                self.method
                and context
                and not re.search(context, self.text[s0:s1], flags=re.I)
            ):
                continue  # метод вне разговора о работе («обрушение снега») — не метод
            if kind == "phrase" and any(t is not None for _, _, _, t, _ in self.within(ms, s0, s1)):
                continue  # оборот «метод демонтажа» с названным методом — метод уже взят
            self.one(f, ms, s0, s1)

    def table_rows(self, ms: list[Match]) -> None:
        """Строки таблиц (OS-INSP-2.2.137): оборот в шапке — значения столбца под ним; оборот в строке — сказуемое
        своей ячейки или «нет» в соседней ячейке строки. Блок — подряд идущие строки таблицы."""
        blocks: list[list[tuple[int, int]]] = []
        for t0, t1 in self.tables:
            if blocks and t0 - blocks[-1][-1][1] <= 1:
                blocks[-1].append((t0, t1))
            else:
                blocks.append([(t0, t1)])
        context = self.cfg.get("context")
        for rows in blocks:
            cells = [self._cells(r0, r1) for r0, r1 in rows]
            for ri, (r0, r1) in enumerate(rows):
                row = self.text[r0:r1]
                if self.method and context and not re.search(context, row, flags=re.I):
                    continue
                for f in (x for x in self.within(ms, r0, r1) if x[4] != "phrase"):
                    col = next(
                        (
                            ci
                            for ci, (c0, c1) in enumerate(cells[ri])
                            if c0 <= f[0] < c1
                        ),
                        0,
                    )
                    c0, c1 = cells[ri][col]
                    if ri == 0 and len(rows) > 1:
                        # шапка: значения столбца в строках ниже
                        vals = [
                            self.text[b[col][0] : b[col][1]]
                            for b in cells[1:]
                            if col < len(b)
                        ]
                        states = {
                            "absent" if CELL_NO.fullmatch(v) else "present"
                            for v in vals
                            if not CELL_EMPTY.fullmatch(v)
                        }
                        for st in sorted(states) or ["present"]:
                            self.one(
                                f,
                                ms,
                                r0,
                                r1,
                                st,
                                "значение столбца" if states else None,
                            )
                        continue
                    others = [(b0, b1) for b0, b1, *_ in self.within(ms, c0, c1) if (b0, b1) != (f[0], f[1])]
                    st, why, span = _state_at(self.cfg, self.text, f[0], f[1], c0, c1, others, self.method)
                    if st == "present" and any(
                        CELL_NO.fullmatch(self.text[x0:x1])
                        for ci, (x0, x1) in enumerate(cells[ri])
                        if ci != col
                    ):
                        st, why, span = "absent", "нет в ячейке строки", None
                    self.one(f, ms, r0, r1, st, why, span)

    def _cells(self, r0: int, r1: int) -> list[tuple[int, int]]:
        out, s = [], r0
        for m in re.finditer(r"\|", self.text[r0:r1]):
            out.append((s, r0 + m.start()))
            s = r0 + m.end()
        out.append((s, r1))
        return out

    def run(self) -> list[Extraction]:
        ms = sorted(_matches(self.cfg, self.text), key=lambda x: (x[0], x[4] == "phrase"))
        self.m_starts = [x[0] for x in ms]
        self.sentences(ms)
        self.table_rows(ms)
        return self.out


def _implied(
    doc: ParsedDoc, spec: ParamSpec, cfg: dict, found: list[Extraction]
) -> list[Extraction]:
    """Узел, где элемент обязан быть, показан без него (OS-INSP-2.2.137): в документе нет ни одного упоминания аспекта,
    а узел есть — упоминание «исключено» с подсказкой implied; узел со ссылкой («по альбому») — подсказка reference."""
    out: list[Extraction] = []
    for rule in cfg.get("implied") or []:
        if any(e.meta["aspect"] == rule["aspect"] for e in found):
            continue
        for page in doc.pages:
            pg = _Page(page, spec, cfg)
            m = re.search(rule["pattern"], pg.text, flags=re.I)
            if m is None:
                continue
            s0, s1 = pg.sent(m.start(), m.end())
            ref = pg.referenced(s0, s1)
            pg.emit(
                m.start(),
                m.end(),
                rule["aspect"],
                None,
                "present" if ref else "absent",
                "узел без элемента",
                "reference" if ref else "implied",
                s0,
                s1,
            )
            out += pg.out
            break
    return out


def _marks(doc: ParsedDoc, cfg: dict, found: list[Extraction]) -> None:
    """Число разных марок аспекта в документе («ДШ-1», «ДШ-2» → 2) — показатель упоминаний аспекта без своего числа."""
    for rule in cfg.get("marks") or []:
        text = " ".join(normalize(p)[0] for p in doc.pages)
        n = len(
            {
                re.sub(r"\W", "", m.group(0)).upper()
                for m in re.finditer(rule["pattern"], text, flags=re.I)
            }
        )
        if not n:
            continue
        for e in found:
            if (
                e.meta["aspect"] == rule["aspect"]
                and e.meta["state"] == "present"
                and e.meta["count"] is None
                and not e.meta["hint"]
            ):
                e.meta["count"] = n
                e.value_num = n


def extract_presence_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все упоминания мероприятия (метода) в документе по порядку страниц, включая отсеянные (meta.excluded)."""
    cfg = spec.extractor or {}
    out: list[Extraction] = []
    budget = [MAX_PER_DOC]
    truncated = False
    for page in doc.pages:
        pg = _Page(page, spec, cfg, budget)
        out += pg.run()
        truncated = truncated or pg.truncated
    out += _implied(doc, spec, cfg, out)
    _marks(doc, cfg, out)
    if truncated:
        for e in out:
            e.meta["truncated"] = True  # в документе упоминаний больше предела — выданы первые MAX_PER_DOC
    return out
