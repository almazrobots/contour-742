"""Упоминания счётного параметра (T-175, T-187; OS-INSP-2.2.60, 2.2.61): этажность М-007, количество квартир М-010.

Основа — разбор чисел `quantity_mentions` (оборот паспорта → первое число). Счёт добавляет то, чего в ПД много, а у
площадей нет:
- латинские двойники внутри русского слова («Этажнocть», «количecтво квартиp») — приводятся к кириллице буква в букву,
  длина строки и рамки слов не меняются (NRM-06);
- формы «число перед словом»: «12 надземных этажей», «запроектировано 386 (триста…) квартир», «20-этажное»,
  «четырнадцатиэтажный» (число словом), «стало 11» — паспорт задаёт их списком `extra` (регулярное выражение
  с группой `num` или `word`);
- отсев формы `extra` по предложению (`sentence_exclude`): сносимый склад, соседний дом, предел ГПЗУ, «было», МГН —
  в том же предложении, что и число, а не только между оборотом и числом.

Значение не угадывается: разные числа в одной стадии API считает двойным подсчётом и воздерживается от вывода
(CLARIFICATION_REQUIRED, count-param.ts). Целое и неотрицательное проверяет API.
"""

from __future__ import annotations

import re

from .class_mentions import _bbox, page_text
from .model import Extraction, Line, Page, ParamSpec, ParsedDoc, Word
from .quantity_mentions import extract_quantity_mentions

KIND = "count_mentions"
OPS = ["ENT-15", "NRM-01", "NRM-06"]
LAT2CYR = str.maketrans("aAcCeEoOpPxXyBHKMTk", "аАсСеЕоОрРхХуВНКМТк")
CYR = re.compile(r"[А-Яа-яЁё]")
TOKEN = re.compile(r"\S+")
SENTENCE_END = re.compile(r"[.;!?](?=\s|$)")
QUOTE_MAX = 120

UNITS = {
    "одно": 1,
    "двух": 2,
    "трех": 3,
    "трёх": 3,
    "четырех": 4,
    "четырёх": 4,
    "пяти": 5,
    "шести": 6,
    "семи": 7,
    "восьми": 8,
    "девяти": 9,
    "десяти": 10,
    "одиннадцати": 11,
    "двенадцати": 12,
    "тринадцати": 13,
    "четырнадцати": 14,
    "пятнадцати": 15,
    "шестнадцати": 16,
    "семнадцати": 17,
    "восемнадцати": 18,
    "девятнадцати": 19,
}
TENS = {"двадцати": 20, "тридцати": 30, "сорока": 40, "пятидесяти": 50}


def is_count_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def fold(text: str) -> str:
    """Латинские двойники → кириллица только в словах, где уже есть кириллица («Этажнocть»); «B25», «A500C» не трогаются.
    Длина строки сохраняется: рамки слов и позиции чисел остаются верными."""
    return TOKEN.sub(
        lambda m: (
            m.group(0).translate(LAT2CYR) if CYR.search(m.group(0)) else m.group(0)
        ),
        text,
    )


def _fold_doc(doc: ParsedDoc) -> ParsedDoc:
    pages = [
        page.model_copy(
            update={
                "lines": [
                    Line(
                        text=fold(ln.text),
                        words=[
                            Word(**{**w.model_dump(), "text": fold(w.text)})
                            for w in ln.words
                        ],
                    )
                    for ln in page.lines
                ]
            }
        )
        for page in doc.pages
    ]
    return doc.model_copy(update={"pages": pages})


def word_number(stem: str) -> int | None:
    """Числительное-основа сложного слова: «четырнадцати» → 14, «двадцатидвух» → 22, «одно» → 1; иначе None."""
    s = stem.lower().replace("ё", "е")
    if s in UNITS:
        return UNITS[s]
    for w, n in TENS.items():
        if s == w:
            return n
        if s.startswith(w) and s[len(w) :] in UNITS and UNITS[s[len(w) :]] < 10:
            return n + UNITS[s[len(w) :]]
    return None


def _sentence(text: str, start: int, end: int) -> str:
    """Предложение вокруг числа: от предыдущего конца предложения до следующего (строки страницы склеены пробелом)."""
    left = max((m.end() for m in SENTENCE_END.finditer(text, 0, start)), default=0)
    right = SENTENCE_END.search(text, end)
    return text[left : right.end() if right else len(text)]


def _before(text: str, end: int) -> str:
    """Начало предложения до конца совпадения: «Для инвалидов… предусмотрено 5 квартир» — уточнение стоит перед числом."""
    left = max((m.end() for m in SENTENCE_END.finditer(text, 0, end)), default=0)
    return text[left:end]


def _extra_mentions(page: Page, spec: ParamSpec, cfg: dict) -> list[Extraction]:
    text, spans = page_text(page)
    out: list[Extraction] = []
    for rule in cfg.get("extra") or []:
        for m in re.finditer(rule["pattern"], text, flags=re.I):
            gd = m.groupdict()
            if gd.get("num") is not None:
                s, e, val = m.start("num"), m.end("num"), float(int(gd["num"]))
            elif gd.get("word") is not None:
                n = word_number(gd["word"])
                if n is None:
                    continue
                s, e, val = m.start("word"), m.end("word"), float(n)
            else:
                continue
            sent = _sentence(text, m.start(), m.end())
            if rule.get("need") and not re.search(rule["need"], sent, flags=re.I):
                continue
            before = _before(text, m.end())
            ex = next(
                (
                    x
                    for x in cfg.get("sentence_exclude") or []
                    if x["code"] not in (rule.get("ignore") or [])
                    and re.search(
                        x["pattern"],
                        before if x.get("scope") == "before" else sent,
                        flags=re.I,
                    )
                ),
                None,
            )
            if spec.code == "M-007" and ex is None:
                # A demolition list can introduce a table whose individual rows
                # no longer repeat the subject. Stop at an explicit new project
                # subject; never infer this from a demolition word elsewhere.
                prefix = text[:m.start()]
                leads = list(re.finditer(
                    r"(?:предусмотрен\w*\s+)?(?:демонтаж|снос)\s+следующ\w*\s+объект\w*\s*:",
                    prefix, re.I))
                if leads:
                    tail = prefix[leads[-1].end():]
                    if len(tail) <= 1000 and not re.search(
                        r"проектируем\w*|вновь\s+возводим\w*|нов\w*\s+(?:жил\w*\s+)?(?:дом|здани)\w*",
                        tail, re.I):
                        ex = {"code": "DEMOLITION_LIST",
                              "why": "значение в перечне объектов, подлежащих сносу или демонтажу"}
            quote = sent.strip()[:QUOTE_MAX]
            out.append(
                Extraction(
                    code=spec.code,
                    raw=text[s:e],
                    value_num=val,
                    value_text=None,
                    page=page.page,
                    bbox=_bbox(spans, s, e),
                    anchor_bbox=_bbox(spans, m.start(), m.end()),
                    line_text=quote,
                    confidence=0.8,
                    meta={
                        "quote": quote,
                        "qualifier": None,
                        "values": [val],
                        "form": rule.get("form", "extra"),
                        "excluded": ex["code"] if ex else None,
                        "excluded_why": ex.get("why") if ex else None,
                        "ops": list(OPS),
                    },
                )
            )
    return out


def extract_count_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    cfg = spec.extractor or {}
    folded = _fold_doc(doc)
    base = extract_quantity_mentions(folded, spec)
    seen = {(e.page, e.value_num, e.bbox) for e in base}
    extra = [
        e
        for page in folded.pages
        for e in _extra_mentions(page, spec, cfg)
        if (e.page, e.value_num, e.bbox) not in seen
    ]
    out = base + extra
    if spec.code == "M-007":
        for entry in out:
            if entry.meta.get("excluded") or not entry.bbox:
                continue
            page = next(p for p in folded.pages if p.page == entry.page)
            cx = (entry.bbox[0] + entry.bbox[2]) / 2
            headers = []
            for line in page.lines:
                if not re.search(r"экспликаци\w*|условные\s+обозначения|технико[\s-]*экономические\s+показатели", line.text, re.I):
                    continue
                if not line.words or any(w.bbox is None for w in line.words):
                    continue
                box = (min(w.bbox[0] for w in line.words), min(w.bbox[1] for w in line.words),
                       max(w.bbox[2] for w in line.words), max(w.bbox[3] for w in line.words))
                if box[0] <= cx <= box[2] and box[3] < entry.bbox[1]:
                    headers.append((box, line.text))
            if headers:
                box, label = max(headers, key=lambda item: item[0][3])
                if re.search(r"экспликаци\w*.*прилегающ\w*\s+территори", label, re.I):
                    entry.meta.update(excluded="NEIGHBOR_HEADER",
                        excluded_why="этажность в экспликации прилегающей территории, не проектного объекта",
                        subject_header_bbox=list(box))
        for entry in out:
            if entry.meta.get("excluded") or not entry.bbox or not entry.anchor_bbox:
                continue
            # A separated right-hand value cell may inherit the subject of its
            # column header. Do not spread this subject across the whole page.
            bx, by, br, _ = entry.bbox
            ax, ay, ar, _ = entry.anchor_bbox
            if bx - ar < 0.15 or abs(by - ay) > 0.03:
                continue
            page = next(p for p in folded.pages if p.page == entry.page)
            for line in page.lines:
                if not re.search(r"существующ\w*\s+(?:жил\w*\s+)?(?:дом|здани)\w*", line.text, re.I):
                    continue
                if not line.words or any(w.bbox is None for w in line.words):
                    continue
                left = min(w.bbox[0] for w in line.words)
                right = max(w.bbox[2] for w in line.words)
                bottom = max(w.bbox[3] for w in line.words)
                if left <= (bx + br) / 2 <= right and 0 < by - bottom < 0.2:
                    if any(re.search(r"проектируем|реконструируем|после реконструкц", other.text, re.I)
                           and any(w.bbox and bottom < w.bbox[1] <= by for w in other.words)
                           for other in page.lines):
                        continue
                    entry.meta.update(excluded="EXISTING_HEADER",
                        excluded_why="колонка таблицы относится к существующему зданию",
                        subject_header_bbox=[left, min(w.bbox[1] for w in line.words), right, bottom])
                    break
    # на одной странице «Этажность — 17» и «Количество этажей — 19»: второе — другой показатель (всего этажей, с
    # подземными); паспорт называет, какой оборот уступает (`page_prefer`), — допущение T-187, а не норма
    pref = cfg.get("page_prefer")
    if pref:
        live = [e for e in out if not e.meta["excluded"]]
        for page in {e.page for e in live}:
            own = [e for e in live if e.page == page]
            if any(re.match(pref["prefer"], e.meta["quote"], flags=re.I) for e in own):
                for e in own:
                    if re.match(pref["demote"], e.meta["quote"], flags=re.I):
                        e.meta["excluded"], e.meta["excluded_why"] = pref["code"], pref["why"]
    return out
