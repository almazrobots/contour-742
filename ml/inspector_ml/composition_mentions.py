"""Состав по типам (T-175, OS-INSP-2.2.62, CMP-08, CMP-11): квартирография М-011 — сколько квартир каждого типа.

Тип ищется по образцам паспорта (студия, 1к…4к+), количество — целое число рядом. Формы записи:
- строкой, «тип → число» («Однокомнатные квартиры — 40 шт.», «студии: 148 кв.») или «число → тип» («40 однокомнатных»);
  в строке таблицы несколько типов подряд («1-комнатные 40 2-комнатные 80») — у каждого своё число до следующего типа;
- таблицей «Тип | Площадь | Кол-во»: дробная площадь пропускается, количество — следующее целое до следующего типа;
- через дробь: «Квартирография (Ст/1-комнатные/2-комнатные):» и числа «155 / 111 / 83 шт.» в той же или следующей строке;
- столбцом: тип одной строкой, число — следующей.
Не количество: дробное число без целого рядом (площадь типа), число с «%» (доля), строка про сносимый или существующий
дом. Подтип внутри одного типа паспорта («четырёхкомнатные» и «пятикомнатные» в «4к+») — meta.sub: API складывает разные
подтипы и не складывает повтор одного. Сравнение состава — API (domain/aggregate-param.ts); ParsedDoc не меняется.
"""

from __future__ import annotations

import re

from .class_mentions import _bbox, page_text
from .count_mentions import fold
from .model import Extraction, ParamSpec, ParsedDoc

KIND = "composition_mentions"
OPS = ["ENT-16", "NRM-01", "NRM-06"]
# число, приклеенное к букве («м2», «м²» → «2»), — часть единицы, а не количество
NUM = r"(?<![\d.,А-Яа-яЁёA-Za-z])(\d{1,4})(?:[.,](\d+))?(?![\d])"
PERCENT = re.compile(r"^\s*%")
QUOTE_MAX = 120
AREA = {
    "code": "AREA",
    "why": "дробное число рядом с типом — площадь типа, а не количество квартир",
}
EXISTING = {
    "code": "EXISTING",
    "why": "строка про сносимый или существующий дом — не проектный состав",
}
EXISTING_RE = re.compile(
    r"сносим\w*|существующ\w*|до\s+реконструкц\w*|расселяем\w*|под\s+снос", re.I
)
# T-187: заголовок над строками типов говорит, чей это состав — не всего дома (строка выше без типов, до двух строк)
CONTEXT = [
    (EXISTING_RE, EXISTING),
    (
        re.compile(r"на\s+(?:типовом\s+|каждом\s+)?этаже|типов\w*\s+этаж|для\s+данной\s+секции|секци\w*\s*\d+\.\s*экспликац", re.I),
        {"code": "PART", "why": "состав одного этажа или одной секции — часть дома, а не квартирография"},
    ),
    (
        re.compile(r"^\s*площад\w*(?!.*(?:кол-?во|количеств))", re.I),
        {"code": "AREA", "why": "под заголовком о площадях — числа площадей, а не количества квартир"},
    ),
    (
        re.compile(r"^\s*(?:встроен\w*(?:[-\s]+пристроен\w*)?\s+помещени\w*|нежил\w*\s+помещени\w*|офис\w*)", re.I),
        {"code": "NONRES", "why": "нежилые помещения — комнаты офисов, а не типы квартир"},
    ),
]
# число с разрядом через пробел («1 505,1») — площадь, а не количество
THOUSANDS = re.compile(r"^[\s\u00a0\u202f]\d{3}(?!\d)")
SUB_WORDS = [
    ("четыр", "4"),
    ("пят", "5"),
    ("шест", "6"),
    ("много", "6+"),
    ("одно", "1"),
    ("двух", "2"),
    ("тр", "3"),
]


def is_composition_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def _sub(text: str) -> str:
    """Подтип совпадения: цифра комнатности или её слово («четырёхкомнатные» → 4); без цифры и слова — пусто."""
    t = text.lower().replace("ё", "е")
    d = re.search(r"\d", t)
    if d:
        return d.group(0)
    for stem, sub in SUB_WORDS:
        if t.startswith(stem):
            return sub
    return ""


def _hits(
    line: str, types: list[tuple[str, re.Pattern[str]]]
) -> list[tuple[int, int, str, str]]:
    """Совпадения типов в строке по порядку; вложенное в предыдущее — пропускается (первое и самое длинное)."""
    hits = sorted(
        (
            (m.start(), m.end(), key, _sub(m.group(0)))
            for key, rx in types
            for m in rx.finditer(line)
        ),
        key=lambda h: (h[0], -h[1]),
    )
    kept: list[tuple[int, int, str, str]] = []
    for h in hits:
        if kept and h[0] < kept[-1][1]:
            continue
        # «2Е (двухкомнатные евро)» — в скобках пояснение предыдущего типа, а не второй тип
        if kept and re.fullmatch(r"\s*\(\s*", line[kept[-1][1] : h[0]]):
            continue
        kept.append(h)
    return kept


def _ints_after(
    line: str, start: int, stop: int
) -> tuple[tuple[int, int, str] | None, bool]:
    """Первое целое после start до stop: дробное (площадь) и с «%» (доля) пропускаются. Второе — была ли площадь."""
    area = False
    for m in re.finditer(NUM, line[start:stop]):
        s, e = start + m.start(), start + m.end()
        if PERCENT.match(line[e:]):
            continue
        if m.group(2) is not None or THOUSANDS.match(line[e:]):
            area = True
            continue
        return (s, e, m.group(1)), area
    return None, area


def extract_composition_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    cfg = spec.extractor or {}
    types = [
        (t["key"], re.compile(t["pattern"], flags=re.I)) for t in cfg.get("types") or []
    ]
    window = int(cfg.get("window", 40))
    out: list[Extraction] = []
    for page in doc.pages:
        _, spans = page_text(page)
        lines, base = [], 0
        for ln in page.lines:
            lines.append((base, fold(ln.text)))
            base += len(ln.text) + 1

        def emit(
            b: int,
            line: str,
            t: tuple[int, int, str, str],
            n: tuple[int, int, str] | None,
            excluded: dict | None,
            nb: int | None = None,
            nline: str | None = None,
        ) -> None:
            ts, te, key, sub = t
            nb = b if nb is None else nb
            nline = line if nline is None else nline
            quote = line.strip() if nline is line else f"{line.strip()} {nline.strip()}"
            out.append(
                Extraction(
                    code=spec.code,
                    raw=nline[n[0] : n[1]] if n else line[ts:te],
                    value_num=float(int(n[2])) if n else None,
                    value_text=key,
                    page=page.page,
                    bbox=_bbox(spans, nb + n[0], nb + n[1]) if n else None,
                    anchor_bbox=_bbox(spans, b + ts, b + te),
                    line_text=line,
                    confidence=0.85,
                    meta={
                        "quote": quote[:QUOTE_MAX],
                        "type": key,
                        "sub": sub,
                        "count_source": "table" if nline is not line else "text",
                        "excluded": excluded["code"] if excluded else None,
                        "excluded_why": excluded["why"] if excluded else None,
                        "ops": list(OPS),
                    },
                )
            )

        used_next = -1
        heads: list[str] = []  # до двух последних строк без типов — заголовок над составом
        total_col = False  # у таблицы по секциям последний столбец — «Всего по дому»
        for i, (b, line) in enumerate(lines):
            if i == used_next:
                continue
            kept = _hits(line, types)
            if not kept:
                # заголовок — строка без присвоения значения («Площади квартир по типам, м²», «Типовой этаж (2–19-й)»);
                # «Общая площадь квартир — 12 480,5 м2» — показатель, а не заголовок над составом
                if not re.search(r"[—:=–-]\s*\d|\d{3}|\d[.,]\d", line):
                    heads = [*heads, line][-2:]
                if "|" in line:
                    total_col = bool(re.search(r"(?:всего|итого)[^|]*$", line, re.I))
                continue
            ex = EXISTING if EXISTING_RE.search(line) else None
            for rx, rule in CONTEXT:
                if ex is None and (rx.search(line[: kept[0][0]]) or any(rx.search(h) for h in heads)):  # noqa: E501
                    ex = rule
            nxt = lines[i + 1] if i + 1 < len(lines) else None
            # строка таблицы по секциям с итоговым столбцом: «1-комн. | 93 | 50 | 143» — берётся итог дома
            if total_col and len(kept) == 1 and "|" in line:
                ints = [m for m in re.finditer(NUM, line[kept[0][1] :]) if m.group(2) is None]
                if ints:
                    m = ints[-1]
                    s0 = kept[0][1]
                    emit(b, line, kept[0], (s0 + m.start(), s0 + m.end(), m.group(1)), ex)
                    continue
            # через дробь или столбцы таблицы: «(Ст/1-комн./2-комн.):» + «155 / 111 / 83 шт.»; «Показатель | Студ. | 1-к |
            # … | Всего» + «Количество, шт. | 9 | 33 | … | 127» — в той же строке после «:» или в следующей
            sep = next(
                (
                    c
                    for c in "/|"
                    if len(kept) >= 2 and all(c in line[kept[j][1] : kept[j + 1][0]] for j in range(len(kept) - 1))
                ),
                None,
            )
            if sep:
                tail_b, tail = (
                    (b, line)
                    if re.search(r":\s*\d", line[kept[-1][1] :])
                    else (nxt if nxt else (b, ""))
                )
                start = kept[-1][1] if tail is line else 0
                nums = [m for m in re.finditer(NUM, tail[start:]) if m.group(2) is None]
                if sep == "|" and len(nums) == len(kept) + 1:
                    nums = nums[:-1]  # последний столбец — «Всего»
                if len(nums) == len(kept):
                    for t, m in zip(kept, nums):
                        emit(
                            b,
                            line,
                            t,
                            (start + m.start(), start + m.end(), m.group(1)),
                            ex,
                            tail_b,
                            tail,
                        )
                    if tail is not line:
                        used_next = i + 1
                    continue
            # столбцом: строка — только тип, следующая — только целое
            if (
                len(kept) == 1
                and not re.search(
                    r"\d", re.sub(re.escape(line[kept[0][0] : kept[0][1]]), "", line)
                )
                and nxt
                and re.fullmatch(r"\s*\d{1,4}\s*(?:шт\.?|кв\.?)?\s*", nxt[1])
            ):
                m = re.search(r"\d{1,4}", nxt[1])
                emit(
                    b,
                    line,
                    kept[0],
                    (m.start(), m.end(), m.group(0)),
                    ex,
                    nxt[0],
                    nxt[1],
                )
                used_next = i + 1
                continue
            # порядок в строке один: число перед первым типом («40 однокомнатных, 80 двухкомнатных») — «число → тип»
            before_style = (
                re.search(NUM + r"\s*$", line[max(0, kept[0][0] - 12) : kept[0][0]])
                is not None
            )
            for j, t in enumerate(kept):
                ts, te = t[0], t[1]
                if before_style:
                    off = max(kept[j - 1][1] if j else 0, ts - 12)
                    m = re.search(NUM + r"\s*$", line[off:ts])
                    if not m:
                        continue
                    if m.group(2) is not None:
                        emit(b, line, t, None, AREA)
                        continue
                    emit(
                        b,
                        line,
                        t,
                        (
                            off + m.start(),
                            off + m.start() + len(m.group(1)),
                            m.group(1),
                        ),
                        ex,
                    )
                else:
                    stop = kept[j + 1][0] if j + 1 < len(kept) else len(line)
                    n, area = _ints_after(line, te, min(stop, te + window))
                    if n:
                        emit(b, line, t, n, ex)
                        # «однокомнатные — 42 (в том числе студии — 5)»: студии входят в 42 — у 1к остаётся 37
                        parent = out[-2] if j and len(out) >= 2 else None
                        if (
                            parent is not None
                            and parent.value_text == kept[j - 1][2]
                            and parent.value_num is not None
                            and re.search(r"\(\s*в\s+т(?:ом|\.)\s*ч(?:исле|\.)?[\s:—–-]*$", line[kept[j - 1][1] : ts])
                        ):
                            parent.value_num -= out[-1].value_num or 0
                            parent.meta["nested"] = out[-1].value_text
                    elif area:
                        emit(b, line, t, None, AREA)
    return out
