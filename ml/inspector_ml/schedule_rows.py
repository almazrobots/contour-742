"""Этапы календарного графика и последовательности возведения (ENT-24, OS-INSP-2.1.50–2.1.52, 2.2.145–2.2.149, T-213;
параметры М-082 и М-087).

Формы записи этапа, законные в реальных ПОС и ППР, читаются все — заголовок графика не обязателен:
- таблица с ячейками через «|»: шапка отдельной строкой («Этап | Продолжительность, дн.», «Длит., дн.»), единица —
  в строке или в шапке; таблица без длительностей под заголовком «Порядок», «Последовательность» — порядок работ;
- «Подпись: значение» и «Подпись — значение» в тексте ПОС: «Монтаж каркаса — 100 дней», «Надземная часть: с 01.04.2027
  по 30.09.2027», несколько этапов в одной фразе («… 18 мес., в т.ч. подготовительный период — 2 мес.»,
  «Кровля — 30 дн.; фасады — 60 дн.»);
- последовательность словами: стрелки «→», «затем», «после», «вслед за», нумерованный перечень «1. … 2. …»,
  перечень через запятую или «;»; «параллельно с» — порядка нет;
- технология этапа («Каркас — монолитный железобетон») — по словарю паспорта (CMP-23 минимальным словарём).

Длительность приводится к дням (NRM-01): месяц — 30, неделя — 7, год — 365; две даты — окончание − начало + 1.
Рабочие дни помечаются (calendar=False). Не значение объекта: норма («нормативная продолжительность по СНиП»,
«не более»), запрет («засыпка до приёмки … запрещается»), гарантийный срок. OCR-шум: латинские буквы-двойники в
русском слове, перенос «фундамен-/ты», цифры через пробел перед единицей («2 7 0 дн.»), подпись и значение на двух
строках («Надземная ч. —» / «270 дн.»).

У каждого этапа: group — фраза или таблица, внутри которой задан порядок; order — место в ней; seq — порядок задан
явно (стрелки, «затем», нумерация, таблица «Порядок»), а не просто строками таблицы. API сравнивает порядок только
внутри одной фразы или таблицы. Гант-растр без таблицы и подписей с длительностью не читается — задел GPU-профиля.

Конфигурация — паспорт параметра (`ParamSpec.extractor`): critical_markers, total, technologies.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date

from .model import Extraction, Line, ParamSpec, ParsedDoc
from .parse import union

KIND = "schedule_rows"
OPS = ["ENT-24", "NRM-01", "NRM-06"]
PER_UNIT = {
    "day": 1.0,
    "week": 7.0,
    "month": 30.0,
    "year": 365.0,
}  # месяц ПОС — 30 дней
MAX_LINE = 2000  # знаков логической строки: длиннее — обрезается до разбора (W3-02)
MAX_ROWS = 500  # этапов на таблицу или фразу; на документ — MAX_DOC_ROWS (W3-06)
MAX_DOC_ROWS = 5000
MAX_QUOTE = 240
MAX_NAME = 200
MAX_LIST_WORDS = (
    6  # элемент перечня через запятую длиннее — это уже текст, а не перечень этапов
)

DATE = re.compile(r"(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d])")
NUM = r"(\d{1,6}(?:[.,]\d{1,3})?)"  # предел разрядов: серия цифр не даёт O(n²) и бесконечной длительности (W3-02, W3-05)
UNIT = (
    r"(?P<work>раб\w{0,20}\.?\s*(?:дн\w{0,20}|д\.?))"
    r"|(?P<day>(?:кал\w{0,20}\.?\s*)?(?:дн\w{0,20}|день|сут\w{0,20}|д\.)(?![а-я]))"
    r"|(?P<week>нед\w{0,20}\.?)"
    r"|(?P<month>мес\w{0,20}\.?)"
    r"|(?P<year>год\w{0,20}|лет(?![а-я]))"
)
DURATION = re.compile(rf"(?<![\d.,]){NUM}\s*(?:{UNIT})", re.I)
HEAD_UNIT = re.compile(rf"(?:продолжительн|длит)\w{{0,20}}\.?[^|\d]{{0,80}}?(?:{UNIT})", re.I)
HEAD_WORD = re.compile(r"(?:^|\|)\s*(?:№|наименовани|этап|работ|вид работ)", re.I)
SEQ_HEAD = re.compile(
    r"^\s*(?:порядок|последовательност\w{0,20}|очер[её]дност\w{0,20}|технологическ\w{0,20}\s+последовательност\w{0,20})\b",
    re.I,
)
NORM = re.compile(
    r"норматив|по\s+снип|по\s+сп\b|не\s+более|не\s+менее|запрещ|не\s+допуска|гаранти|срок\w{0,20}\s+служб",
    re.I,
)
ARROW = re.compile(r"\s*(?:→|->|⇒|—>|–>)\s*")
THEN = re.compile(
    r"\s*(?:,\s*)?(?:(?<![а-яё])затем|(?<![а-яё])потом|(?<![а-яё])далее)(?![а-яё])\s*",
    re.I,
)
NUMBERED = re.compile(r"(?:^|\s)(\d{1,2})[.)]\s+(?=[А-ЯЁA-Zа-яё])")
LEAD = re.compile(
    r"^[\s|.,;:—–\-]*(?:\d+(?:\.\d+)*[.)]?\s+)?(?:(?:в\s+т\.?\s*ч\.?|в\s+том\s+числе|из\s+них|принято|сначала|затем|потом|далее|и|а|"
    r"порядок|последовательность|очер[её]дность|технологическая\s+последовательность)(?![а-яёa-z])[\s:.,—–\-]*)*",
    re.I,
)
LAT2CYR = str.maketrans("aceopxyAEKMHOPCTX", "асеорхуАЕКМНОРСТХ")


def is_schedule_rows(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def to_days(value: float, unit: str) -> float:
    """Длительность в днях (NRM-01): месяц — 30, неделя — 7, год — 365."""
    days = round(value * PER_UNIT[unit], 3)
    return days if math.isfinite(days) else 0.0


def _unit_of(m: re.Match[str]) -> tuple[str, bool]:
    """Единица совпадения и календарность: ('day', False) — рабочие дни."""
    if m.group("work"):
        return "day", False
    for u in ("week", "month", "year"):
        if m.group(u):
            return u, True
    return "day", True


def _date(d: str, mth: str, y: str) -> date | None:
    try:
        return date(int(y) + (2000 if len(y) == 2 else 0), int(mth), int(d))
    except ValueError:
        return None


def fix_ocr(text: str) -> str:
    """Латинские буквы-двойники внутри русского слова → кириллица; цифры через пробел перед единицей склеиваются."""
    text = re.sub(
        r"\S+",
        lambda m: (
            m.group(0).translate(LAT2CYR)
            if re.search(r"[А-Яа-яЁё]", m.group(0))
            else m.group(0)
        ),
        text,
    )
    return re.sub(
        r"(?<![\d.,])(\d(?: \d){1,3})(?=\s*(?:дн|мес|нед|кал|раб|сут))",
        lambda m: m.group(1).replace(" ", ""),
        text,
    )


def clean_name(s: str) -> str:
    """Подпись этапа: без номера строки, служебных «в т.ч.», «затем», «Порядок:», разделителей по краям."""
    s = LEAD.sub("", s)
    s = re.sub(r"\s*\|\s*", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" |-–—:;,.")
    s = re.sub(r"^(?:с|со)\s+", "", s)
    s = re.sub(r"^(?:с|со)\s+|\s+(?:с|со|по|в|на)$", "", s)
    return s.strip(" |-–—:;,.")


def _letters(s: str) -> int:
    return len(re.findall(r"[А-Яа-яЁёA-Za-z]", s))


@dataclass
class Item:
    name: str
    days: float | None = None
    unit: str = "day"
    calendar: bool = True
    start: date | None = None
    end: date | None = None
    lines: list[Line] = field(default_factory=list)
    text: str = ""
    order: int = 0


def parse_row(text: str, head: tuple[str, bool] | None = None) -> dict | None:
    """Строка или ячейки одного этапа → наименование, даты, длительность; None — нет длительности и двух верных дат."""
    t = re.sub(r"\s+", " ", fix_ocr(text).replace("|", " | ")).strip()
    dates = [(m, d) for m in DATE.finditer(t) if (d := _date(*m.groups())) is not None]
    busy = [(m.start(), m.end()) for m, _ in dates]
    dur = next(
        (
            m
            for m in DURATION.finditer(t)
            if not any(s <= m.start() < e for s, e in busy)
        ),
        None,
    )
    days: float | None = None
    unit, calendar = "day", True
    cut = len(t)
    if dur:
        unit, calendar = _unit_of(dur)
        days = to_days(float(dur.group(1).replace(",", ".")), unit)
        cut = dur.start()
    elif head is not None:
        bare = re.search(rf"(?<![\d.,]){NUM}[\s|]*$", t)
        if bare and not any(s <= bare.start() < e for s, e in busy):
            unit, calendar = head
            days = to_days(float(bare.group(1).replace(",", ".")), unit)
            cut = bare.start()
    start = end = None
    if len(dates) >= 2 and dates[1][1] >= dates[0][1]:
        start, end = dates[0][1], dates[1][1]
        cut = min(cut, dates[0][0].start())
        if days is None:
            days, unit, calendar = float((end - start).days + 1), "day", True
    if days is None:
        return None
    if "|" in t[:cut]:
        cells = [c.strip() for c in t[:cut].split("|")]
        name = next((clean_name(c) for c in cells if _letters(clean_name(c)) >= 4), "")
    else:
        name = clean_name(t[:cut])
    if _letters(name) < 4 and not re.fullmatch(r"[А-ЯЁ]{2,4}", name):  # «ИС — 100 дн.»: аббревиатура этапа
        return None
    return {
        "name": name,
        "days": days,
        "unit": unit,
        "calendar": calendar,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
    }


def _head_unit(text: str) -> tuple[str, bool] | None:
    m = HEAD_UNIT.search(text)
    return _unit_of(m) if m else None


def _logical_lines(doc: ParsedDoc) -> list[tuple[int, str, list[Line], float]]:
    """Строки страницы, склеенные по переносу слова («фундамен-» + «ты») и по подписи без значения («Надземная ч. —» +
    «270 дн.»). Возвращает (страница, текст, строки-источники, уверенность страницы)."""
    out: list[tuple[int, str, list[Line], float]] = []
    for page in doc.pages:
        conf = 1.0 if page.source != "ocr" else round((page.ocr_confidence or 50) / 100, 3)
        buf: tuple[str, list[Line]] | None = None
        for line in page.lines:
            text = fix_ocr(line.text.strip()[:MAX_LINE])
            if buf is not None:
                prev, src = buf
                if re.search(r"[А-Яа-яЁё]-$", prev):
                    buf = ((prev[:-1] + text)[:MAX_LINE], src + [line])
                    continue
                if re.search(r"[—–:\-]$", prev) and re.match(r"\d", text) and "|" not in prev + text:
                    buf = ((prev + " " + text)[:MAX_LINE], src + [line])
                    continue
                out.append((page.page, prev, src, conf))
            buf = (text[:MAX_LINE], [line])
        if buf is not None:
            out.append((page.page, buf[0], buf[1], conf))
    return out


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+(?=[А-ЯЁA-Z])", text) if s.strip()]


def _duration_items(sentence: str) -> list[Item]:
    """Этапы с длительностью или датами в одной фразе: каждый этап — от конца предыдущего до своего значения."""
    out: list[Item] = []
    pos = 0
    spans: list[tuple[int, int]] = []
    rng = re.compile(rf"(?:с\s+)?{DATE.pattern}(?:\s*(?:по|[-–—])\s*|\s+){DATE.pattern}", re.I)
    for m in rng.finditer(sentence):
        spans.append((m.start(), m.end()))
    for m in DURATION.finditer(sentence):
        if not any(s <= m.start() < e for s, e in spans):
            spans.append((m.start(), m.end()))
    for s, e in sorted(spans):
        seg = sentence[pos:e]
        pos = e
        if NORM.search(seg):
            continue
        row = parse_row(seg)
        if row is None:
            continue
        out.append(
            Item(
                name=row["name"],
                days=row["days"],
                unit=row["unit"],
                calendar=row["calendar"],
                start=date.fromisoformat(row["start"]) if row["start"] else None,
                end=date.fromisoformat(row["end"]) if row["end"] else None,
                text=seg,
            )
        )
    return out


def _sequence_items(sentence: str) -> tuple[list[Item], bool] | None:
    """Последовательность без длительностей: (этапы по порядку, порядок задан явно) или None — фраза не перечень."""
    s = sentence.strip().rstrip(".")
    s = re.sub(r"\([^)]*\)", "", s)
    if re.search(r"(?<![а-яё])не\s+(?:включ[её]н|предусмотрен|входит)\w*", s, re.I):
        return None  # явное исключение из графика важнее слов «до начала»
    if re.search(r"(?<![а-яё])(?:параллельно|одновременно)\s+с", s, re.I):
        parts = re.split(
            r"(?<![а-яё])(?:параллельно|одновременно)\s+с\w{0,20}\s*", s, flags=re.I
        )
        return [
            Item(name=clean_name(p), order=1)
            for p in parts
            if _letters(clean_name(p)) >= 4
        ], False
    explicit = bool(
        ARROW.search(s)
        or THEN.search(s)
        or SEQ_HEAD.search(s)
        or re.search(r"(?<![а-яё])(?:после|вслед\s+за|сначала|до\s+начала)(?![а-яё])", s, re.I)
    )
    parts: list[str]
    m_after = re.match(r"^\s*после\s+(.+?)\s*[—–,]\s*(.+)$", s, re.I)
    m_mid = re.match(r"^(.+?)\s+(?:после|вслед\s+за)\s+(.+)$", s, re.I)
    m_before = re.match(r"^(.+?)\s+до\s+начала\s+(.+)$", s, re.I)  # «А до начала Б» — сначала А
    # «Снос выполнен до начала работ, в график не включён»: отрицание делает «до начала»/«после» обычной прозой, а не порядком
    negated = re.search(r"(?<![а-яё])(?:не|нет|без|отсутству\w{0,20})(?![а-яё])", s, re.I) is not None
    if ARROW.search(s):
        parts = ARROW.split(s)
    elif negated and (m_after or m_before or m_mid) and not THEN.search(s):
        return None
    elif m_after:
        parts = [m_after.group(1), *THEN.split(m_after.group(2))]
    elif m_before and not THEN.search(s):
        parts = [m_before.group(1), m_before.group(2)]
    elif m_mid and not THEN.search(s):
        parts = [m_mid.group(2), m_mid.group(1)]
    elif THEN.search(s):
        parts = THEN.split(s)
    elif explicit:
        parts = re.split(r"\s*[;,]\s*", s)
    else:
        if re.match(r"^[^,;]+?\s+[—–]\s+|^[^,;]+?:\s+", s):
            return None  # «Котлован — открытый, с откосами»: описание этапа, а не перечень
        parts = re.split(r"\s*[;,]\s*", s)
        # перечень без слов порядка: три пункта через запятую или пункты через «;», без отрицаний («… не включён»)
        if (len(parts) < 3 and ";" not in s) or any(len(p.split()) > MAX_LIST_WORDS or re.search(r"(?<![а-яё])не\s", p, re.I) for p in parts):
            return None
    parts = (
        [x for p in parts for x in re.split(r"\s*;\s*|,\s+(?=[а-яё]+\s*$)", p)]
        if not explicit
        else [x for p in parts for x in re.split(r"\s*;\s*", p)]
    )
    items = [
        Item(name=clean_name(re.split(r"\s+[—–]\s+|:\s+", clean_name(p), maxsplit=1)[0]), text=p)
        for p in parts
    ]
    items = [it for it in items if _letters(it.name) >= 4]
    if len(items) < 2:
        return None
    for i, it in enumerate(items, 1):
        it.order = i
    return items, explicit


def _numbered(text: str) -> list[str] | None:
    """Нумерованный перечень в строке «1. Подготовка. 2. Котлован.» — пункты по порядку; None — не перечень."""
    ms = list(NUMBERED.finditer(text))
    if len(ms) < 2 or [int(m.group(1)) for m in ms] != list(
        range(int(ms[0].group(1)), int(ms[0].group(1)) + len(ms))
    ):
        return None
    return [
        text[m.end() : (ms[i + 1].start() if i + 1 < len(ms) else len(text))]
        for i, m in enumerate(ms)
    ]


def extract_schedule_rows(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Этапы документа по порядку: у каждого — группа порядка (фраза или таблица), место в ней и явность порядка."""
    cfg = spec.extractor or {}
    critical = [re.compile(p, re.I) for p in cfg.get("critical_markers") or []]
    total = re.compile(cfg["total"], re.I) if cfg.get("total") else None
    techs = [
        (t["id"], re.compile(t["pattern"], re.I)) for t in cfg.get("technologies") or []
    ]
    # схема возведения («поэтажно», «на всю высоту») — свойство всей фразы последовательности, а не одного этапа
    schemes = [
        (t["id"], re.compile(t["pattern"], re.I))
        for t in cfg.get("technologies") or []
        if t.get("sentence")
    ]
    out: list[Extraction] = []
    group = -1
    table: dict | None = None  # {"group", "head", "seq", "order"} — открытая таблица
    seq_heading = False  # строка «Порядок» / «Последовательность» перед таблицей

    def emit(
        it: Item, page: int, src: list[Line], conf: float, grp: int, seq: bool, raw: str, ctx: str = ""
    ) -> None:
        if len(out) >= MAX_DOC_ROWS or (it.order or 0) > MAX_ROWS:
            return  # предел выхода: документ из тысяч строк не раздувает ответ ML (W3-06)
        raw = raw[:MAX_QUOTE]
        it.name = it.name[:MAX_NAME]
        low = raw.lower().replace("ё", "е")
        tech = next((tid for tid, rx in techs if rx.search(low)), None)
        if tech is None and ctx:
            tech = next((tid for tid, rx in schemes if rx.search(ctx.lower().replace("ё", "е"))), None)
        out.append(
            Extraction(
                code=spec.code,
                raw=raw,
                value_num=it.days,
                value_text=it.name,
                page=page,
                bbox=union([w.bbox for ln in src for w in ln.words if w.bbox]),
                line_text=raw,
                confidence=conf,
                meta={
                    "kind": "schedule_row",
                    "table": grp,
                    "group": grp,
                    "order": it.order,
                    "seq": seq,
                    "start": it.start.isoformat() if it.start else None,
                    "end": it.end.isoformat() if it.end else None,
                    "unit": it.unit,
                    "calendar": it.calendar,
                    "critical": any(rx.search(raw) for rx in critical),
                    "total": bool(total and total.search(it.name)),
                    "tech": tech,
                    "quote": raw.strip(),
                    "ops": list(OPS),
                },
            )
        )

    for page, text, src, source in _logical_lines(doc):
        if not text:
            continue
        if "|" in text:
            cells = [c.strip() for c in text.split("|")]
            is_head = bool(HEAD_WORD.search(text)) and not re.search(
                r"\d", re.sub(r"№", "", text)
            )
            if is_head:
                group += 1
                table = {
                    "group": group,
                    "head": _head_unit(text),
                    "seq": seq_heading,
                    "order": 0,
                }
                seq_heading = False
                continue
            row = parse_row(text, table["head"] if table else None)
            if row is None and table is not None:
                name = next(
                    (clean_name(c) for c in cells if _letters(clean_name(c)) >= 4), ""
                )
                if name:
                    row = {
                        "name": name,
                        "days": None,
                        "unit": "day",
                        "calendar": True,
                        "start": None,
                        "end": None,
                    }
            if row is None:
                continue
            if table is None:
                group += 1
                table = {"group": group, "head": None, "seq": False, "order": 0}
            table["order"] += 1
            it = Item(
                name=row["name"],
                days=row["days"],
                unit=row["unit"],
                calendar=row["calendar"],
                start=date.fromisoformat(row["start"]) if row["start"] else None,
                end=date.fromisoformat(row["end"]) if row["end"] else None,
                order=table["order"],
            )
            emit(it, page, src, source, table["group"], table["seq"], text)
            continue
        table = None
        if SEQ_HEAD.match(text) and _letters(re.sub(SEQ_HEAD, "", text)) < 4:
            seq_heading = True  # заголовок таблицы порядка работ отдельной строкой
            continue
        numbered = _numbered(text)
        if numbered:
            group += 1
            # нумерация сама по себе — вёрстка перечня, а не очерёдность: явной её делает только заголовок «Порядок»
            explicit_num = bool(SEQ_HEAD.match(text)) or seq_heading
            seq_heading = False
            for i, part in enumerate(numbered, 1):
                name = clean_name(re.split(r"\s*[—–:]\s*", part.strip().rstrip("."))[0])
                if _letters(name) >= 4:
                    emit(
                        Item(name=name, order=i),
                        page,
                        src,
                        source,
                        group,
                        explicit_num,
                        part.strip(),
                    )
            continue
        for sentence in _sentences(text):
            dur = _duration_items(sentence)
            if dur:
                group += 1
                for i, it in enumerate(dur, 1):
                    it.order = i
                    emit(
                        it,
                        page,
                        src,
                        source,
                        group,
                        False,
                        it.text.strip(" ,;.") or sentence,
                    )
                continue
            if NORM.search(sentence):
                continue
            seq = _sequence_items(sentence)
            if seq:
                items, explicit = seq
                group += 1
                for it in items:
                    emit(it, page, src, source, group, explicit, it.text or it.name, sentence)
                continue
            # «Каркас — монолитный железобетон, …»: этап с технологией, без длительности и порядка
            head = re.split(r"\s+[—–]\s+|:\s+", sentence, maxsplit=1)
            low = sentence.lower().replace("ё", "е")
            if any(rx.search(low) for _, rx in techs):
                name = (
                    clean_name(head[0])
                    if len(head) == 2
                    else clean_name(sentence.rstrip("."))
                )
                if _letters(name) >= 4:
                    group += 1
                    emit(
                        Item(name=name, order=1),
                        page,
                        src,
                        source,
                        group,
                        False,
                        sentence.split(";")[0],
                    )
    return out
