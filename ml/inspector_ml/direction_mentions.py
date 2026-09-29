"""Упоминания направления открывания эвакуационных дверей (OS-INSP-2.1.60–2.1.61, 2.2.152–2.2.157, T-214; параметры
М-043 «Направление открывания эвакуационных дверей» (Р3 АР) и М-106 «… на путях эвакуации» (Р9 ППМ)).

Два источника в тексте и таблицах ParsedDoc (растр не читается — дуга открывания на плане остаётся заделом GPU):
- строка ведомости / спецификации дверей: марка («Д1», «ДН-2»), признак эвакуационной, направление («по направлению
  выхода из здания», «наружу», «внутрь», «против хода эвакуации»), сторона навески Л/П;
- утверждение текста ПЗ / ППМ без марки: «двери эвакуационных выходов открываются по направлению выхода из здания».

Как у упоминаний класса и количества, сохраняется КАЖДОЕ упоминание, отсеянные — с причиной; сравнение и выбор
источника — в API (domain/direction-param.ts). Конфигурация (обороты, отсев) — из паспорта в `ParamSpec.extractor`.
Правила консервативны: двусмысленность, отрицание и отсутствие признака эвакуационной — отсев, а не догадка;
Л/П — не направление эвакуации (HAND_ONLY); оговорка нормы («не более 15 человек», «допускается внутрь») — EXEMPT.
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass

from .class_mentions import page_text
from .model import BBox, Extraction, Page, ParamSpec, ParsedDoc, Word
from .parse import union

KIND = "direction_mentions"
OPS = ["ENT-10", "NRM-06"]
QUOTE_MAX = 240
NEG_BEFORE = 40  # отрицание ищется не дальше 40 знаков перед оборотом направления
DISPUTED_PENALTY = (
    0.6  # как в class_mentions: слово, где движки OCR разошлись (OS-INSP-2.1.6)
)
HAND = {"code": "HAND_ONLY", "why": "указана только сторона навески (Л/П) — это не направление эвакуации"}
GRAPHIC = {"code": "GRAPHIC_ONLY", "why": "направление открывания показано только на чертеже («см. графику») — из текста не определить"}
NOT_EVAC = {"code": "NOT_EVAC", "why": "дверь помещения вне путей эвакуации (санузел, кладовая, венткамера, техническое помещение)"}
SMALL_ROOM = {"code": "SMALL_ROOM", "why": "дверь помещения с одновременным пребыванием не более 15 человек — открывание внутрь допускается (СП 1.13130.2020, п. 4.2.6)"}
NEGATION = {"code": "NEGATION", "why": "направление стоит под отрицанием («не открываются…») — по тексту не определить, куда открывается дверь"}
AMBIGUOUS = {"code": "AMBIGUOUS", "why": "названы оба направления без оговорки нормы — какое относится к двери, по тексту не определить"}
# границы утверждения: «;» всегда, «.» / «!» / «?» — перед заглавной (номер пункта «п. 4.2.6» предложение не рвёт)
SENTENCE_END = re.compile(r";|(?<=[.!?])\s+(?=[А-ЯЁA-Z«\"])")
# латиница, похожая на кириллицу, и OCR-подмены в слове с кириллицей (NRM-06): «ЭB-1» → «ЭВ-1», «нарvжу» → «наружу»;
# замена буква на букву — длина текста и диапазоны слов не меняются
HOMOGLYPH = str.maketrans("ABCEHKMOPTXYaceopxyv", "АВСЕНКМОРТХУасеорхуу")
CYR = re.compile(r"[А-Яа-яЁё]")
TOKEN = re.compile(r"\S+")
# число людей рядом с дверью: «кабинет, 4 чел.», «на 20 чел.»; «не более 15 чел.» — оговорка нормы, а не число помещения
PERSONS = re.compile(r"(?<![\d.,])(\d{1,4})\s*чел", re.I)
LIMIT_BEFORE = re.compile(r"(?:не\s+более|до|≤|менее|свыше|более|от)\s*$", re.I)
NUM = r"(\d+(?:[.,]\d+)?)\s*(мм|м)?(?![\w])"
SMALL_ROOM_MAX = 15


def is_direction_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def normalize_mark(raw: str) -> str:
    """«Д-1», «Д 1», «д1», «D-1» → «Д1» (NRM-06): без пробелов и дефисов, заглавными, латинская D — кириллическая Д."""
    return re.sub(r"[\s\-‐–—]", "", raw).upper().replace("D", "Д").translate(HOMOGLYPH)


def fold(text: str) -> str:
    """Латинские двойники в словах с кириллицей — кириллицей; длина строки сохраняется (диапазоны слов те же)."""
    return TOKEN.sub(lambda m: m.group(0).translate(HOMOGLYPH) if CYR.search(m.group(0)) else m.group(0), text)


def _mm(raw: str, unit: str | None) -> float:
    v = float(raw.replace(",", "."))
    return v * 1000 if unit == "м" or (unit is None and v < 10) else v


@dataclass(frozen=True)
class _Rx:
    mark: re.Pattern[str]
    statement: re.Pattern[str]
    evac: re.Pattern[str]
    non_evac: re.Pattern[str] | None
    outward: list[re.Pattern[str]]
    inward: list[re.Pattern[str]]
    sliding: re.Pattern[str] | None
    hand: re.Pattern[str]
    graphic: re.Pattern[str] | None
    negation: re.Pattern[str]
    building: re.Pattern[str] | None
    blocks: dict | None
    exclude: list[tuple[dict, re.Pattern[str]]]
    window: int


def _compile(cfg: dict) -> _Rx:
    i = re.I
    opt = lambda k: re.compile(cfg[k], i) if cfg.get(k) else None  # noqa: E731
    b = cfg.get("blocks")
    return _Rx(
        mark=re.compile(cfg["mark"]),  # марка — с учётом регистра: «до 2» не марка «ДО2»
        statement=re.compile(cfg["statement"], i),
        evac=re.compile(cfg["evac"], i),
        non_evac=opt("non_evac"),
        outward=[re.compile(p, i) for p in cfg["outward"]],
        inward=[re.compile(p, i) for p in cfg["inward"]],
        sliding=opt("sliding"),
        hand=re.compile(cfg["hand"]),  # «Л»/«П» — заглавные: строчная «п.» — пункт, а не правая
        graphic=opt("graphic"),
        negation=re.compile(cfg["negation"], i),
        building=re.compile(cfg["building"]) if cfg.get("building") else None,  # буква корпуса — заглавная: «корпус в осях» не корпус «В»
        blocks=(
            {"opening": re.compile(b["opening"], i), "leaf": re.compile(b["leaf"] + NUM, i), "path": re.compile(b["path"] + NUM, i), "min_mm": float(b["min_mm"])}
            if b
            else None
        ),
        exclude=[(r, re.compile(r["pattern"], i)) for r in cfg.get("exclude") or []],
        window=int(cfg.get("window", 300)),
    )


class Spans:
    """Диапазоны слов страницы в тексте (page_text) с поиском пересечения за O(log n) (W3-06): слова идут подряд и не
    перекрываются, поэтому и начала, и концы возрастают — хватает двух bisect вместо прохода по всем словам."""

    def __init__(self, spans: list[tuple[int, int, Word]]):
        self.spans = spans
        self.starts = [a for a, _, _ in spans]
        self.ends = [b for _, b, _ in spans]

    def words(self, start: int, end: int) -> list[Word]:
        """Слова, пересекающие [start, end) — то же, что class_mentions._words_in."""
        return [w for _, _, w in self.spans[bisect_right(self.ends, start) : bisect_left(self.starts, end)]]

    def bbox(self, start: int, end: int) -> BBox | None:
        return union([w.bbox for w in self.words(start, end)])


def _quote(text: str, start: int, end: int) -> str:
    return text[start : min(end, start + QUOTE_MAX)].strip(" |;,")


def _persons(text: str, start: int, end: int) -> int | None:
    """Число людей помещения у двери («4 чел.»); ограничение нормы («не более 15 чел.») не число помещения."""
    for m in PERSONS.finditer(text, start, end):
        if not LIMIT_BEFORE.search(text[max(start, m.start() - 12) : m.start()]):
            return int(m.group(1))
    return None


def _blocks(text: str, start: int, end: int, rx: _Rx) -> tuple[re.Match[str], float] | None:
    """Дверь открывается в коридор и сужает путь (OS-INSP-2.2.159): ширина пути за вычетом полотна меньше порога паспорта.
    Возвращает полотно и остаток ширины, м. Порог — гипотеза: пункт СП не подтверждён, API ставит только SUSPICION.
    Нет обоих чисел — None."""
    b = rx.blocks
    if b is None or b["opening"].search(text, start, end) is None:
        return None
    leaf, path = b["leaf"].search(text, start, end), b["path"].search(text, start, end)
    if leaf is None or path is None:
        return None
    rest = _mm(path.group(1), path.group(2)) - _mm(leaf.group(1), leaf.group(2))
    return (leaf, round(rest / 1000, 3)) if rest < b["min_mm"] else None


def _mention(
    text: str,
    spans,
    start: int,
    end: int,
    rx: _Rx,
    spec: ParamSpec,
    page: Page,
    mark: re.Match[str] | None,
    anchor: tuple[int, int],
    line_start: int | None = None,
) -> Extraction | None:
    """Упоминание в диапазоне [start, end): строка своей марки или контекст утверждения. None — направления нет.
    Значение: outward / inward / sliding (раздвижная, вращающаяся — не распашная по направлению выхода) / blocks (сужает
    путь в коридоре) / hand (только Л/П) / graphic (только «см. графику»)."""
    outs = [m for p in rx.outward for m in p.finditer(text, start, end)]
    ins = [m for p in rx.inward for m in p.finditer(text, start, end)]
    found = sorted(outs + ins, key=lambda m: m.start())
    persons = _persons(text, start, end)
    non_evac = rx.non_evac is not None and rx.non_evac.search(text, start, end) is not None
    # признак эвакуационной: да (явный признак, путь эвакуации, > 15 человек), нет (помещение вне путей эвакуации), не указан
    evac: bool | None = (
        False
        if non_evac
        else True
        if rx.evac.search(text, start, end) is not None or any(rx.evac.search(m.group(0)) for m in found) or (persons is not None and persons > SMALL_ROOM_MAX)
        else None
    )
    rule = next((r for r, p in rx.exclude if p.search(text, start, end)), None)
    exemption = None
    excl = None
    remaining: float | None = None
    blocked = _blocks(text, start, end, rx) if evac is not False else None
    sliding = rx.sliding.search(text, start, end) if rx.sliding is not None and not found else None
    if blocked is not None:
        (hit, remaining), value = blocked, "blocks"
    elif found:
        hit = found[0]
        value = "outward" if hit in outs else "inward"
    elif sliding is not None:
        value, hit = "sliding", sliding
    else:
        hand = rx.hand.search(text, start, end) if mark is not None else None
        graphic = rx.graphic.search(text, start, end) if rx.graphic is not None else None
        if evac is False or (hand is None and graphic is None):
            return None  # ни направления, ни стороны навески, ни ссылки на чертёж — упоминания нет
        value, hit, excl = ("hand", hand, HAND) if hand is not None else ("graphic", graphic, GRAPHIC)
    if value in ("outward", "inward", "sliding"):
        negated = any(rx.negation.search(text[max(start, m.start() - NEG_BEFORE) : m.start()]) for m in found or [hit])
        if outs and ins:
            # «открываются по направлению выхода, допускается внутрь для помещений ≤ 15 человек» — наружу с оговоркой
            if rule is not None and not negated:
                value, hit = "outward", outs[0]
            else:
                excl = AMBIGUOUS
        if excl is None and negated:
            excl = NEGATION
        elif excl is None and evac is False:
            excl = NOT_EVAC
        elif excl is None and value != "outward" and persons is not None and persons <= SMALL_ROOM_MAX:
            excl = SMALL_ROOM  # число людей помещения в пределах оговорки — внутрь по норме допустимо
        elif excl is None and rule is not None and value == "inward":
            # «допускается внутрь (≤ 15 человек)» — оговорка нормы, а не значение объекта; пометка только понижает вывод
            excl = rule
        elif excl is None and rule is not None:
            exemption = rule.get("why")
    # корпус — последний названный до конца своей части строки: «Корпус Б: ЭВ-1 внутрь» (подпись перед маркой)
    blds = list(rx.building.finditer(text, start if line_start is None else line_start, end)) if rx.building is not None else []
    building = blds[-1] if blds else None
    conf = 1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
    if any(w.disputed for w in spans.words(hit.start(), hit.end())):
        conf *= DISPUTED_PENALTY
    quote = _quote(text, start, end)
    return Extraction(
        code=spec.code,
        raw=hit.group(0),
        value_text=value,
        page=page.page,
        bbox=spans.bbox(hit.start(), hit.end()),
        anchor_bbox=spans.bbox(*anchor),
        line_text=quote,
        confidence=round(conf, 3),
        meta={
            "quote": quote,
            "mark": normalize_mark(mark.group(0)) if mark is not None else None,
            "scope": "door" if mark is not None else "general",
            "evac": evac,
            "building": normalize_mark(building.group(1)) if building is not None else None,
            "remaining_m": remaining,
            "exemption": exemption,
            "excluded": excl["code"] if excl else None,
            "excluded_why": excl.get("why") if excl else None,
            "ops": list(OPS),
        },
    )


def _page_mentions(page: Page, spec: ParamSpec, rx: _Rx) -> list[Extraction]:
    raw, words = page_text(page)
    spans = Spans(words)
    text = fold(raw)  # поиск — по сложенному тексту, цитата — по нему же (та же длина)
    out: list[Extraction] = []
    # 1. Строки ведомости: строка делится на части по маркам (OS-INSP-2.1.60) — признаки относятся к своей марке
    base = 0
    marked: list[tuple[int, int]] = []
    for line in page.lines:
        ls, le = base, base + len(line.text)
        base = le + 1
        marks = list(rx.mark.finditer(text, ls, le))
        if marks:
            marked.append((ls, le))
        for i, mk in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else le
            e = _mention(
                text, spans, mk.start(), end, rx, spec, page, mk, (mk.start(), mk.end()), ls
            )
            if e is not None:
                out.append(e)
    # 2. Утверждения текста без марки: предложение, где есть «двер…» и «открыв…»; строки с марками — уже выше
    pos = 0
    bounds = [m.start() for m in SENTENCE_END.finditer(text)] + [len(text)]
    for b in bounds:
        s, e = pos, b
        pos = b + 1
        if any(ms < e and s < me for ms, me in marked):
            continue
        # A table heading about fire-rated doors can precede the actual
        # opening statement by more than one window. A heading without a
        # reading must not suppress later anchors in the same paragraph.
        for st in rx.statement.finditer(text, s, e):
            cs, ce = max(s, st.start() - rx.window // 2), min(e, st.end() + rx.window // 2)
            m = _mention(text, spans, cs, ce, rx, spec, page, None, (st.start(), st.end()))
            if m is not None:
                out.append(m)
                break  # retain sentence-level ambiguity/exclusion semantics
    return out


def extract_direction_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все упоминания направления открывания в документе по порядку страниц (OS-INSP-2.2.152)."""
    rx = _compile(spec.extractor or {})
    return [e for p in doc.pages for e in _page_mentions(p, spec, rx)]
