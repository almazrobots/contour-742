"""Упоминания количественного показателя (OS-INSP-2.2.22–2.2.24, T-132; первый параметр — М-001, площадь
застройки, м²).

Как у упоминаний класса (class_mentions.py), сохраняется КАЖДОЕ упоминание: API выбирает источник по приоритету
разделов и комплекту, инспектор видит все, в том числе отсеянные — с причиной. Конфигурация (оборот, окно,
единицы, отсев) приходит из паспорта параметра в `ParamSpec.extractor`, код от параметра не зависит.

Значение — первое число после оборота. Две ловушки текстового слоя ТЭП (пакет «Алтуфьево»):
- верхний индекс единицы («м²») pdfium отдаёт отдельной цифрой: «Площадь застройки объекта 2 3009.4 м» и
  «3009,4 2 м» — одиночная цифра индекса не значение (NRM-02);
- номер следующей строки таблицы стоит сразу за значением: «2909,5 4 Процент застройки» — не второе значение.
Второе значение с дробной частью подряд («2362,5 3009.4») — колонки таблицы; какое из них проектное, по тексту
не определить: упоминание отсеивается с причиной, а не угадывается.
"""

from __future__ import annotations

import math
import re

from .class_mentions import _bbox, _words_in, page_text
from .model import Extraction, Page, ParamSpec, ParsedDoc
from .parse import union

KIND = "quantity_mentions"
OPS = ["ENT-15", "NRM-01", "NRM-02", "NRM-06"]
DISPUTED_PENALTY = (
    0.6  # как в extract.py: значение из слова, где движки OCR разошлись (OS-INSP-2.1.6)
)
QUOTE_TAIL = 30  # знаков после значения в цитате упоминания
MAX_STRANGERS = 3  # слов-уточнений между оборотом и значением («Жилого корпуса»); больше — уже другой показатель
EXCLUDE_BEFORE = 60  # контекст отсева до оборота («Площадь застройки существующего здания…» — и до, и после)
MULTI = {
    "code": "MULTI_VALUE",
    "why": "в строке несколько значений подряд (колонки таблицы) — какое из них проектное, по тексту не определить",
}
# T-211 (OS-INSP-2.2.131–2.2.133): отсевы уклона и счёта — единица не указана, дробный счёт, разные значения на листе
NO_UNIT = {
    "code": "NO_UNIT",
    "why": "единица значения не указана, а по числу её не определить (‰ или %) — значение не берётся",
}
NOT_INTEGER = {
    "code": "NOT_INTEGER",
    "why": "количество дробное — это не счёт (размер, отметка или соседняя колонка), значение не берётся",
}
IMPLAUSIBLE = {
    "code": "IMPLAUSIBLE",
    "why": "значение вне правдоподобного диапазона паспорта (VER-13) — другая единица («проступь 30» — сантиметры) или чужое число",
}
PAGE_MULTI = {
    "code": "MULTI_VALUE",
    "why": "на листе несколько разных значений показателя (разные участки, марши, продольный и поперечный) — какое из них сравнивать, по тексту не определить",
}
NUM = r"\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?"


# токен хвоста: единица, число, слово в скобках, соринка разметки — всё, что может стоять между оборотом и значением.
# Единица идёт первой: «м2» — одна единица, а не слово «м» и число 2.
PCT_AFTER = re.compile(r"\s?%")
ORDINAL = re.compile(r"-[А-Яа-яЁё]")
YEAR = re.compile(r"\s?г(?:\.|ода?\b|\b)")  # «на I квартал 2024 г.» — год, не значение
TWO_COLUMNS = re.compile(r"изм\.\s{0,3}(?:№\s{0,3})?\d|(?<![А-Яа-яЁё])было|(?<![А-Яа-яЁё])стало|существующ|реконструкц|по\s{1,3}проекту|ГПЗУ", re.I)
TWO_COLUMNS_WINDOW = 300  # признак таблицы изменений ищется рядом со строкой (шапка таблицы), а не по всему листу (T173-L1)
HEADER_LINES = 8  # единица из шапки (NRM-02) — только в первых строках листа, а не в сноске (T173-M3)
ROW_NO_DOTTED = re.compile(r"^\d{1,2}\.\d{1,2}\.?$")  # «4.1 в т.ч. выше отм. 0,000» — номер подпункта таблицы
ZERO_MARK = re.compile(r"[±+]?0[.,]0{2,3}(?!\d)")
VALUE_IN_PAREN = re.compile(r"(?<![\w.,])\d[\d  ]{0,20}[.,]\d")  # число с дробной частью внутри скобки — значение
# T-233 (точность, проверка глазами на Полярной 17): число — часть обозначения, а не значение объекта
# «СП 7.13130.2013» (М-041 «ширина двери 7,13 м»), «ГОСТ 21.101-2020», «ТУ 5745-001-…» (голое «ТУ 500 кВт» — лимит по техусловиям, значение)
CODE_BEFORE = re.compile(r"(?<![А-Яа-яЁёA-Za-z])(?:СП|ГОСТ(?:\s?Р)?|СНиП|СанПиН|ТР|ВСН|МДС|РД|ФЗ|ISO|EN|DIN)\s{0,2}№?\s{0,2}$")
CODE_TAIL = re.compile(r"[.\-]\d{2,}")  # «7.13130» + «.2013», «21.101» + «-2020»: ещё сегмент кода сразу за числом
# «Усилитель ЮРМ 2000», «ТМН-210»: марка оборудования — заглавное слово вплотную перед целым числом (М-040 «коридор 2000»)
MODEL_BEFORE = re.compile(r"(?<![А-Яа-яЁёA-Za-z])(?!ТУ[\s-]?$)[А-ЯЁA-Z]{2,6}[\s-]?$")  # «ТУ 500 кВт» — лимит по техусловиям, не марка
MODEL_MIN = 100  # малые целые после заглавного слова — номера (секция 2, П-1 ловит MARK), не модели
# «подкосы шагом 2,5…6,0 м» (М-058): диапазон — не одно значение, упоминание не берётся
RANGE_TAIL = re.compile(r"\s{0,2}(?:…|\.\.\.|–|—)\s{0,2}\d")
RANGE_FULL = re.compile(rf"\s{{0,2}}(?:…|\.\.\.|–|—)\s{{0,2}}(?:{NUM})")  # вся вторая половина диапазона — тоже не значение


def _designation(text: str, start: int, end: int, raw: str, *, context_start: int = 0) -> bool:
    """Число — часть шифра нормы, марки оборудования или диапазона: не значение объекта (T-233)."""
    before = text[max(context_start, start - 14) : start]
    tail = text[end : end + 12]
    if CODE_BEFORE.search(before) or CODE_TAIL.match(tail) or RANGE_TAIL.match(tail):
        return True
    integer = not re.search(r"[.,]", raw)
    # марка — слово ПОСЛЕ оборота: заглавная аббревиатура самого оборота («КИТ 240 %», «Итого по ССР 1 300 000») — не марка
    own = text[max(context_start, start - 14) : start]
    return integer and to_number(raw) >= MODEL_MIN and MODEL_BEFORE.search(own) is not None


SIGN = "+-−–±"  # знак отметки (OS-INSP-2.2.52): только приклеенный к числу — «Высота – 68,41» с пробелом не минус


def unit_texts(cfg: dict) -> list[str]:
    """Все единицы паспорта: строки `units` (множитель 1) и `units_table` (OS-INSP-2.2.51, NRM-02)."""
    return [*(cfg.get("units") or []), *(u["text"] for u in cfg.get("units_table") or [])]


def unit_factor(cfg: dict, unit: str | None) -> float:
    """Множитель найденной единицы к единице паспорта; единица не из таблицы — 1."""
    if unit is None:
        return 1.0
    key = re.sub(r"\s+", " ", unit.lower())
    for u in cfg.get("units_table") or []:
        if re.sub(r"\s+", " ", u["text"].lower()) == key:
            return float(u["factor"])
    return 1.0


def _token_re(cfg: dict) -> re.Pattern[str]:
    units = sorted((re.escape(u) for u in unit_texts(cfg)), key=len, reverse=True)
    unit = rf"(?P<unit>(?:{'|'.join(units)})(?![\w]))|" if units else ""
    sign = rf"(?:[{re.escape(SIGN)}](?=\d))?" if cfg.get("signed") else ""
    # T-211 (OS-INSP-2.2.133): марка объекта «П-1», «ЛМ-2» — не значение, пропускается; «150х300» — второе число пары
    mark = rf"(?P<mark>(?<![\w-]){MARK}(?![\w]))|" if cfg.get("objects") else ""
    after_x = r"(?<=[xXхХ])|" if cfg.get("x_pairs") else ""
    return re.compile(
        # число может быть приклеено к единице («943,0м2»): после него запрещены только цифра и «,5»/«.5»
        rf"\s*(?:{unit}{mark}(?P<num>(?:{after_x}(?<![\w.,]))(?<!\w[-–]){sign}(?:{NUM})(?![\d])(?![.,]\d))|(?P<paren>\([^)]{{0,60}}\))|(?P<word>[^\s\d()]+))",
        flags=re.I,
    )


MARK = r"[А-ЯЁA-Z]{1,4}-\d{1,3}[а-яa-z]?"  # марка объекта: П-1, ЛМ-2, Л-1, ДП-3 (T-211)
_LAT = str.maketrans("ABCEHKMOPTXaceopxy", "АВСЕНКМОРТХасеорху")  # латиница, похожая на кириллицу


def _object_key(label: str | None) -> str | None:
    """Ключ объекта (T-211, OS-INSP-2.2.133): марка или подпись строки таблицы без регистра, лишних пробелов и латиницы."""
    if not label:
        return None
    k = re.sub(r"\s+", " ", label.translate(_LAT)).strip(" .,:;—–-").lower()
    return k or None


_NUM_WORDS = {
    "один": 1, "одна": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8,
    "девять": 9, "десять": 10, "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
    "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18, "девятнадцать": 19, "двадцать": 20,
}


def _normalize(text: str, cfg: dict) -> str:
    """Шум текстового слоя (T-211, OS-INSP-2.2.132) без сдвига позиций — рамки слов остаются верными:
    буква «О» вместо нуля рядом с цифрой («1О», «15Ox3OO») → 0; число словом («десять») → цифры с пробелами до той же длины."""
    if cfg.get("ocr_digits"):
        # один проход, серия букв целиком (OWASP W3-01: повторные проходы квадратичны на «1» + «о» × 50 000)
        text = re.sub(r"(?<=\d)[OoОо]+|[OoОо]+(?=\d)", lambda m: "0" * len(m.group(0)), text)
        # разрыв числа перед единицей («4 5 ‰» — 45 ‰): две одиночные цифры через пробел вплотную к ‰ или %
        text = re.sub(r"(?<![\d.,])(\d) (\d)(?=\s?[‰%])", r"\1\2 ", text)
    if cfg.get("number_words"):
        rx = re.compile(r"(?<![А-Яа-яЁё])(" + "|".join(sorted(_NUM_WORDS, key=len, reverse=True)) + r")(?![А-Яа-яЁё])", flags=re.I)
        text = rx.sub(lambda m: str(_NUM_WORDS[m.group(1).lower()]).ljust(len(m.group(1))), text)
    return text


def is_quantity_mentions(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def to_number(raw: str) -> float:
    """«3 009,40» → 3009.4 (NRM-01): пробелы разрядов убираются, запятая — десятичная; «−4,200» → −4.2, «±0,000» → 0
    (OS-INSP-2.2.52)."""
    neg = raw[:1] in "-−–"
    v = float(re.sub(r"[   ]", "", raw.lstrip(SIGN)).replace(",", "."))
    return -v if neg else v


def _is_superscript(tok: str, cfg: dict) -> bool:
    return tok in (cfg.get("superscripts") or [])


def _is_row_number(tok: str) -> bool:
    """Номер строки таблицы: целое без дробной части, меньше 100, или номер подпункта через точку («4.1»)."""
    return (tok.isdigit() and int(tok) < 100) or ROW_NO_DOTTED.match(tok) is not None


def _unit_end(text: str, e: int, cfg: dict) -> int:
    """Конец рамки значения (T-233): единица, стоящая сразу за числом («20 ‰», «300 мм»), — часть значения, инспектор
    видит его вместе с ней. Нет единицы сразу за числом — конец числа."""
    m = _token_re(cfg).match(text, e)
    return m.end() if m is not None and m.groupdict().get("unit") else e


def _read_value(
    text: str, start: int, limit: int, cfg: dict
) -> tuple[list[tuple[str, int, int]], int, str | None] | None:
    """Числа после оборота: [(сырое, начало, конец)] значимых чисел, позиция конца разбора и единица значения (или None).
    Пропускаются слова-связки
    и единицы из паспорта, слово в скобках, верхний индекс единицы. Разбор останавливается на первом чужом слове."""
    fillers = [f.lower() for f in cfg.get("fillers") or []]
    stop = {s.lower() for s in cfg.get("stop") or []}
    token = _token_re(cfg)
    pos = start
    strangers = 0
    nums: list[tuple[str, int, int]] = []
    units: list[tuple[str, int]] = []  # (единица, сколько чисел было перед ней)
    while pos < limit:
        m = token.match(text, pos)
        if m is None or m.end() > limit or m.end() == pos:
            break
        if m.group("num") is not None:
            raw = m.group("num")
            tail = text[m.end("num") : m.end("num") + 12]
            pct = PCT_AFTER.match(tail) if "%" not in unit_texts(cfg) else None
            # Распознанный оборот («КИТ», «Итого по ССР») не является маркой
            # оборудования. Защита от обозначений действует в хвосте после него.
            excluded_limit = any(
                r.get("code") == "LIMIT" and r.get("scope") == "between"
                and re.search(r["pattern"], text[start:m.start("num")], re.I)
                for r in cfg.get("exclude") or []
            ) and _unit_end(text, m.end("num"), cfg) > m.end("num")
            designation = _designation(text, m.start("num"), m.end("num"), raw, context_start=start)
            # «разрешённая ТУ 500 кВт» сохраняется как отсев LIMIT, не факт.
            # Сегменты нормативного кода и диапазоны по-прежнему запрещены.
            if designation and not (excluded_limit and not CODE_TAIL.match(tail) and not RANGE_TAIL.match(tail)):
                # шифр нормы, марка оборудования, диапазон (T-233): не значение; разбор идёт дальше за код
                code = CODE_TAIL.match(tail)
                span = RANGE_FULL.match(text, m.end("num"))
                if span:  # «2,5…6,0»: диапазон пропускается целиком — его половины не значения
                    pos = span.end()
                    nums.clear()
                    break
                pos = m.end("num") + (code.end() if code else 0)
                continue
            if pct or ORDINAL.match(tail) or YEAR.match(tail):
                # «НДС 20 %» у показателя не в процентах, «1-го этажа», «9-этажное» — не значение (T-173)
                pos = m.end("num") + (pct.end() if pct else 0)
                continue
            nums.append((raw, m.start("num"), m.end("num")))
        elif m.groupdict().get("unit"):
            units.append((m.group("unit"), len(nums)))  # единица — не значение (NRM-02), но её множитель — да
        elif m.groupdict().get("mark"):
            if nums:
                break  # марка после значения — уже другой объект
            # марка объекта до значения («проезда П-1 — 30 ‰») — не значение и не чужое слово
        elif m.group("paren") is not None:
            if nums:
                break
            # «(от куб.м 29977.1 отм. 0,000 …)» — перенос ячейки со значением внутри скобки: скобка не пропускается целиком
            inner = ZERO_MARK.sub(lambda z: " " * len(z.group(0)), m.group("paren"))
            dec = VALUE_IN_PAREN.search(inner)
            if dec:
                pos = m.start("paren") + dec.start()  # сразу к числу: «от», «до» внутри скобки — не стоп-слова значения
                continue
        else:
            word = m.group("word")
            w = word.lower().strip(".,:;–—-|")
            # «;» — конец фразы: «вынос из пятна застройки; 3. Заключить…» — дальше номер пункта, а не значение
            # слово-ссылка на норму или способ расчёта («определяется по СП 54.13330») — дальше не значение объекта
            if ";" in word or w in stop:
                break
            # T-211 (OS-INSP-2.2.132): «, » и «. » после значения — конец записи («подступенок 150 мм, 12 ступеней», «2 %. 3. …»)
            if nums and not w and any(c in word for c in cfg.get("stop_after") or []):
                break
            if w and w not in fillers:
                # до значения допускается короткое уточнение («кв.м. Жилого корпуса 943.0»); после — чужая строка
                strangers += 1
                if nums or strangers > int(cfg.get("max_strangers", MAX_STRANGERS)):
                    break
        pos = m.end()
    if not nums:
        return None
    # индекс единицы перед значением («объекта 2 3009.4»): одиночная цифра, за которой идёт ещё число
    dropped = 0
    while len(nums) > 1 and _is_superscript(nums[0][0], cfg):
        nums.pop(0)
        dropped += 1
    head, rest = nums[0], nums[1:]
    # единица значения (OS-INSP-2.2.51): сразу после числа («68410 мм»), иначе — последняя перед ним («Высота, м 68,41»)
    after = [u for u, k in units if k == dropped + 1]
    before = [u for u, k in units if k <= dropped]
    unit = after[0] if after else before[-1] if before else None
    # после значения: индекс единицы («3009,4 2 м») и номер следующей строки таблицы («2909,5 4 Процент») — не значения
    # номер строки — только последнее число перед подписью следующей строки: «180 52 4 Минимальные» — 52 не номер строки;
    # T-211: у уклона и ступеней малое целое — значение, а не номер строки (row_numbers: false) — две колонки отсеиваются
    rows = cfg.get("row_numbers", True)
    rest = [n for i, n in enumerate(rest) if not (_is_superscript(n[0], cfg) or (rows and i == len(rest) - 1 and _is_row_number(n[0])))]
    # то же значение в соседней колонке («5825.8 м 2 5825,8» — «всего» и «наземная часть») — не второе значение
    rest = [n for n in rest if to_number(n[0]) != to_number(head[0])]
    return [head, *rest], pos, unit


def _excluded(cfg: dict, context: str, between: str | None = None, mention: str | None = None) -> dict | None:
    """Первое сработавшее правило отсева. Правило со scope="between" смотрит только текст от оборота до значения:
    «наземная часть» в следующей колонке таблицы не делает общий объём надземным; scope="mention" — от оборота до конца
    разбора с единицей («Расчетная мощность 450 кВт»), без соседней строки выше (T-173)."""
    for rule in cfg.get("exclude") or []:
        scope = rule.get("scope")
        ctx = between if scope == "between" and between is not None else mention if scope == "mention" and mention is not None else context
        if re.search(rule["pattern"], ctx, flags=re.I):
            return rule
    return None


LIMIT_MARK = r"не\s+(?:более|выше|превыша\w*|менее|ниже)|≤|≥|max\b|min\b|макс\w*|предельн\w*"
LIMIT = {"code": "LIMIT", "why": "предельное значение нормы («не более», «максимальный») — не значение объекта, эталон CMP-06"}
VARIANT_TAIL = 25  # знаков после значения, где ещё ищется вариант («1 234,5 тыс. руб. с НДС»)


def _limit_cfg(cfg: dict) -> dict:
    """Конфигурация чтения предела: «не более», «до» — не стоп-слова, а связки (OS-INSP-2.2.53)."""
    marks = {"не", "более", "выше", "менее", "ниже", "до", "свыше", "превышает", "превышать", "max", "min", "≤", "≥"}
    return {**cfg, "stop": [w for w in cfg.get("stop") or [] if w.lower() not in marks], "fillers": [*(cfg.get("fillers") or []), *marks, "%"], "max_strangers": 4}


def _page_unit(text: str, cfg: dict) -> str | None:
    """Единица из шапки таблицы (NRM-02, T-173): у значения единицы нет, а на странице все единицы паспорта — одного масштаба
    («Сводный сметный расчёт … в тыс. руб.»). Разные масштабы на странице — единица не определена."""
    units = sorted((re.escape(u["text"]) for u in cfg.get("units_table") or []), key=len, reverse=True)
    if not units:
        return None
    found = [m.group(0) for m in re.finditer(rf"(?<![\w])(?:{'|'.join(units)})(?![\w])", text, flags=re.I)]
    if not found or len({unit_factor(cfg, u) for u in found}) != 1:
        return None
    return found[0]


def _variant(cfg: dict, text: str, anchor: str = "", page: str = "", hits: dict[str, bool] | None = None) -> str | None:
    """Вариант показателя (OS-INSP-2.2.53): первое правило паспорта по порядку. Правило с on="anchor" смотрит только сам
    оборот, с page — срабатывает, лишь если на странице есть page («ВСЕГО по ССР» при строке НДС — итог с НДС по форме ССР)."""
    for v in cfg.get("variants") or []:
        where = anchor if v.get("on") == "anchor" else text
        if not re.search(v["pattern"], where, flags=re.I):
            continue
        cond = v.get("page")
        if cond and hits is not None and cond not in hits:
            hits[cond] = re.search(cond, page, flags=re.I) is not None
        if not cond or (hits[cond] if hits is not None else re.search(cond, page, flags=re.I) is not None):
            return v["code"]
    return None


def _page_mentions(page: Page, spec: ParamSpec, cfg: dict, aspect: str | None = None) -> list[Extraction]:
    text, spans = page_text(page)
    text = _normalize(text, cfg)
    heads = [h for h, _ in _table_heads(page, cfg)] if cfg.get("table") else []
    # оборот в шапке таблицы читается колонкой (_table_mentions), а не как «подпись значение»
    anchors = [a for a in re.finditer(cfg["anchor"], text, flags=re.I) if not any(h0 <= a.start() < h1 for h0, h1 in heads)]
    # OS-INSP-2.2.53: обороты предела нормы («Максимальный процент застройки») — упоминания-пределы, а не значения
    limit_spans = [(m.start(), m.end()) for m in re.finditer(cfg["limit_anchor"], text, flags=re.I)] if cfg.get("limit_anchor") and aspect is None else []
    marks: list[tuple[re.Match[str], bool]] = sorted([(a, False) for a in anchors] + [(m, True) for m in re.finditer(cfg["limit_anchor"], text, flags=re.I)] if limit_spans else [(a, False) for a in anchors], key=lambda x: x[0].start())
    window = int(cfg.get("window", 80))
    base_conf = 1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
    source = (
        "pdf-text"
        if page.source == "text"
        else "scan-ocr"
        if page.source == "ocr"
        else "structured"
    )
    out: list[Extraction] = []
    line_ends, pos = [], 0  # конец каждой строки в тексте страницы (строки склеены пробелом)
    for ln in page.lines:
        pos += len(ln.text)
        line_ends.append(pos)
        pos += 1
    line_ends.append(len(text))
    prev_end = 0  # конец разбора предыдущего упоминания: его «до реконструкции» — не контекст этого
    prev_start = 0  # то же для поиска марки объекта (T-211)
    page_unit: object = ...  # единица шапки листа — считается лениво и один раз (T173-M1)
    page_hits: dict[str, bool] = {}  # правила вариантов с условием на лист — один поиск на лист (T173-M1)
    # оборот значения внутри оборота предела («Максимальный процент застройки») — тот же предел, не второе упоминание
    marks = [(a, by) for a, by in marks if by or not any(ls <= a.start() < le for ls, le in limit_spans)]
    # «Проектная мощность (вместимость) мест 200» — оборот в скобке сразу за оборотом — уточнение того же упоминания
    marks = [x for i, x in enumerate(marks) if i == 0 or not re.fullmatch(r"\s*\(\s*", text[marks[i - 1][0].end() : x[0].start()])]
    for i, (a, by_limit) in enumerate(marks):
        limit = min(len(text), a.end() + window)
        if cfg.get("same_line"):
            # T-187: значение счёта — в строке оборота; «198 — количество квартир (жилая часть),» и «9 — количество
            # нежилых» на следующей строке — чужое число, а не значение
            limit = min(limit, next(e for e in line_ends if e >= a.end()))
        if i + 1 < len(marks):
            limit = min(limit, marks[i + 1][0].start())  # значение следующего оборота — не наше
        marked = bool(limit_spans or cfg.get("limit_anchor")) and aspect is None and re.match(rf"[\s:—–\-|,]*(?:{LIMIT_MARK})", text[a.end() : limit], flags=re.I) is not None
        is_limit = by_limit or marked
        read = _read_value(text, a.end(), limit, _limit_cfg(cfg) if is_limit else cfg)
        if read is None:
            continue  # значения нет — заголовок, упоминание в тексте без числа (OS-INSP-2.2.3)
        nums, end, unit = read
        raw, s, e = nums[0]
        if not all(math.isfinite(to_number(n[0])) for n in nums):
            continue  # OWASP W3-05: сотни цифр подряд — не значение; float inf уронил бы int() и весь разбор файла
        rule = _excluded(cfg, text[max(prev_end, a.start() - EXCLUDE_BEFORE) : end], text[a.start() : s], text[a.start() : end])
        prev_end = end
        column = None
        near = text[max(0, a.start() - TWO_COLUMNS_WINDOW) : end]
        if (rule is None or rule["code"] == "CHANGE_NOTE") and len(nums) == 2 and not is_limit and TWO_COLUMNS.search(near):
            rule = None  # запись «было … стало …» текстом даёт одно число; два подряд — колонки таблицы изменений
            # таблица «было | стало», «существующее | проектное», «по ГПЗУ | по проекту»: значение объекта — правая колонка
            raw, s, e = nums[-1]
            column = "last"
        elif rule is None and len(nums) > 1 and not is_limit:
            rule = MULTI
            e = nums[-1][2]
        unit_from = "value" if unit is not None else None
        if unit is None and cfg.get("page_unit"):
            if page_unit is ...:
                page_unit = _page_unit(" ".join(ln.text for ln in page.lines[:HEADER_LINES]), cfg)  # один раз на лист
            unit = page_unit
            unit_from = "page" if unit is not None else None
        value = to_number(raw) * unit_factor(cfg, unit)
        # «Глубина заложения 4,2 м» — отметка −4,2 (OS-INSP-2.2.52): оборот паспорта задаёт знак числа без знака
        if cfg.get("negate_if") and raw[:1] not in SIGN and re.search(cfg["negate_if"], a.group(0), flags=re.I):
            value = -value
        free = cfg.get("unitless")
        scaled = unit is None and bool(free) and abs(value) <= float(free["max"])
        if scaled:
            value *= float(free["factor"])  # «Коэффициент застройки 0,42» — 42 % (OS-INSP-2.2.51)
        # T-211 (OS-INSP-2.2.131, 2.2.132): «уклон 5» без единицы — ‰ или %? не угадывается; счёт ступеней — только целое
        if rule is None and unit is None and not scaled and cfg.get("unit_required"):
            rule = NO_UNIT
        if rule is None and cfg.get("integer") and math.isfinite(to_number(raw)) and to_number(raw) != int(to_number(raw)):
            rule = NOT_INTEGER
        if not math.isfinite(value):
            value, rule = 0.0, rule or IMPLAUSIBLE  # число из сотен цифр — не значение (T173-L2)
        box = cfg.get("plausible")
        if rule is None and box and not (float(box[0]) <= value <= float(box[1])):
            rule = IMPLAUSIBLE  # VER-13 (OS-INSP-2.2.132): «проступь 30» без единицы — не 30 мм; «350 154 %» — слитые колонки (T-173)
        conf = base_conf
        if any(w.disputed for w in _words_in(spans, s, e)):
            conf *= DISPUTED_PENALTY
        # цитата — от оборота до значения с коротким хвостом: инспектор читает именно эту запись, а не абзац вокруг
        quote = text[a.start() : min(len(text), e + QUOTE_TAIL)].strip()
        nxt = marks[i + 1][0].start() if i + 1 < len(marks) else len(text)
        variant = _variant(cfg, text[a.start() : min(nxt, end + VARIANT_TAIL)], a.group(0), text, page_hits)
        obj = None
        if cfg.get("objects"):
            # марка объекта рядом с оборотом в той же фразе («Проезд П-1: прод. уклон 30 ‰», «уклон проезда П-1 — 30 ‰»)
            lo = max(prev_start, a.start() - OBJECT_BEFORE)
            cut = max(text.rfind(". ", lo, a.start()), text.rfind("; ", lo, a.start()))
            ctx = text[(cut + 1 if cut >= 0 else lo) : end]  # только своя фраза: марка прошлого предложения — не наша
            found = re.findall(rf"(?<![\w-])({cfg['objects']})(?![\w])", ctx, flags=re.I)
            obj = _object_key(found[-1]) if found else None
        prev_start = end
        out.append(
            Extraction(
                code=spec.code,
                raw=text[s:e],
                value_num=round(value, 9),
                value_text=None,
                page=page.page,
                bbox=_bbox(spans, s, _unit_end(text, e, cfg) if unit_from == "value" else e),
                anchor_bbox=_bbox(spans, a.start(), a.end()),
                line_text=quote,
                confidence=round(conf, 3),
                meta={
                    "quote": quote,
                    "qualifier": None,
                    "values": [to_number(n[0]) for n in nums],
                    "excluded": rule["code"] if rule else None,
                    "excluded_why": rule.get("why") if rule else None,
                    "text_source": source,
                    "ops": list(OPS),
                    "unit": unit,
                    "unit_from": unit_from,
                    "column": column,
                    "variant": variant,
                    "limit": is_limit,
                    "aspect": aspect,
                    **({"object": obj} if cfg.get("objects") else {}),
                },
            )
        )
    return out


OBJECT_BEFORE = 40  # знаков до оборота, где ищется марка объекта (T-211)


def _cells(line: str, base: int) -> list[tuple[str, int, int]]:
    """Ячейки строки таблицы через «|»: (текст, начало, конец) в координатах текста страницы."""
    out, pos = [], 0
    for part in line.split("|"):
        out.append((part, base + pos, base + pos + len(part)))
        pos += len(part) + 1
    return out


def _table_heads(page: Page, cfg: dict) -> list[tuple[tuple[int, int], tuple[int, int, int]]]:
    """Шапки колонок показателя (T-211, OS-INSP-2.2.133): ячейка строки через «|» с оборотом паспорта и без цифр.
    Возвращает [(диапазон ячейки шапки, (номер строки, номер колонки, число колонок))]."""
    out, base = [], 0
    for li, line in enumerate(page.lines):
        text = _normalize(line.text, cfg)
        cells = _cells(text, base)
        # шапка — строка без ячейки-числа: «Число ступеней в марше | шт. | 10» — строка со значением, а не шапка
        if len(cells) >= 2 and not any(re.fullmatch(rf"\s*(?:{NUM})\s*\S{{0,8}}\s*", c) for c, _, _ in cells):
            for j, (c, c0, c1) in enumerate(cells):
                if not re.search(r"\d", c) and re.search(cfg["anchor"], c, flags=re.I):
                    out.append(((c0, c1), (li, j, len(cells))))
        base += len(line.text) + 1
    return out


def _table_mentions(page: Page, spec: ParamSpec, cfg: dict, aspect: str | None = None) -> list[Extraction]:
    """OS-INSP-2.2.133 (T-211): таблица строками через «|» — оборот в шапке колонки, значения в той же колонке строк ниже
    (единица — в ячейке или в шапке), объект — подпись строки. Строка с другим числом ячеек заканчивает таблицу;
    ячейка не из одного числа (с единицей) — не значение."""
    if not cfg.get("table"):
        return []
    text, spans = page_text(page)
    text = _normalize(text, cfg)
    starts, base = [], 0
    for line in page.lines:
        starts.append(base)
        base += len(line.text) + 1
    units = sorted((re.escape(u) for u in unit_texts(cfg)), key=len, reverse=True)
    unit_rx = rf"(?P<unit>{'|'.join(units)})" if units else r"(?P<unit>(?!))"
    # число ячейки не длиннее 15 знаков (OWASP W3-05: 400 цифр → float inf → int() роняет разбор файла)
    cell_rx = re.compile(rf"\s*(?P<num>\d{{1,3}}(?:[   ]\d{{3}}){{1,4}}(?:[.,]\d{{1,6}})?|\d{{1,12}}(?:[.,]\d{{1,6}})?)\s*(?:{unit_rx}(?![\w]))?\s*", flags=re.I)
    out: list[Extraction] = []
    for (h0, h1), (li, j, n) in _table_heads(page, cfg):
        head = text[h0:h1]
        hu = re.search(rf"(?<![\w]){unit_rx}(?![\w])", head, flags=re.I)
        for k in range(li + 1, len(page.lines)):
            row = _cells(text[starts[k] : starts[k] + len(page.lines[k].text)], starts[k])
            if len(row) != n:
                break
            cell, s0, _ = row[j]
            m = cell_rx.fullmatch(cell)
            if not m:
                continue
            raw = m.group("num")
            if not math.isfinite(to_number(raw)):
                continue
            unit = m.group("unit") or (hu.group("unit") if hu else None)
            s, e = s0 + m.start("num"), s0 + m.end("num")
            label = next((c.strip() for i, (c, _, _) in enumerate(row) if i != j and re.search(r"[А-Яа-яЁёA-Za-z]{2}", c)), None)
            rule = _excluded(cfg, f"{head} {label or ''}", f"{head} {label or ''}", f"{head} {label or ''}")
            value = to_number(raw) * unit_factor(cfg, unit)
            free = cfg.get("unitless")
            scaled = unit is None and bool(free) and abs(value) <= float(free["max"])
            if scaled:
                value *= float(free["factor"])
            if rule is None and unit is None and not scaled and cfg.get("unit_required"):
                rule = NO_UNIT
            if rule is None and cfg.get("integer") and to_number(raw) != int(to_number(raw)):
                rule = NOT_INTEGER
            box = cfg.get("plausible")
            if rule is None and box and not (float(box[0]) <= value <= float(box[1])):
                rule = IMPLAUSIBLE
            quote = f"{head.strip()}: {cell.strip()}" + (f" — строка «{label}»" if label else "")
            out.append(
                Extraction(
                    code=spec.code,
                    raw=text[s:e],
                    value_num=round(value, 9),
                    value_text=None,
                    page=page.page,
                    bbox=_bbox(spans, s, e),
                    anchor_bbox=_bbox(spans, h0, h1),
                    line_text=quote,
                    confidence=1.0 if page.source != "ocr" else round((page.ocr_confidence or 50) / 100, 3),
                    meta={
                        "quote": quote,
                        "qualifier": None,
                        "values": [to_number(raw)],
                        "excluded": rule["code"] if rule else None,
                        "excluded_why": rule.get("why") if rule else None,
                        "text_source": "pdf-text" if page.source == "text" else "scan-ocr" if page.source == "ocr" else "structured",
                        "ops": list(OPS),
                        "unit": unit,
                        "unit_from": "value" if m.group("unit") else "head" if unit else None,
                        "table": "pipe",
                        "variant": _variant(cfg, head),
                        "limit": False,
                        "aspect": aspect,
                        **({"object": _object_key(label)} if cfg.get("objects") else {}),
                    },
                )
            )
    return out


COL_DX = 0.03  # колонка таблицы: центр значения не дальше 3 % ширины листа от центра заголовка
COL_DY = 0.12  # и не ниже 12 % высоты листа под ним: ведомость — сразу под шапкой
HEAD_DY = 0.04  # «Площадь, м²» над «застройки» — одна шапка, если между ними не больше 4 % высоты
ROW_DY = 0.012  # подпись строки — на уровне значения или чуть выше (перенос ячейки)


def _cx(b: tuple[float, float, float, float]) -> float:
    return (b[0] + b[2]) / 2


def _column_mentions(
    page: Page, spec: ParamSpec, cfg: dict, taken: set[tuple[float, float]]
) -> list[Extraction]:
    """OS-INSP-2.2.25: показатель в шапке таблицы, разбитой по ячейкам (ведомость зданий генплана: «Площадь, м²» над
    «застройки»), — значение берётся ближайшим числом под заголовком в той же колонке, подпись — из той же строки."""
    col = cfg.get("column")
    if not col:
        return []
    words = [w for line in page.lines for w in line.words if w.bbox]
    num_rx = re.compile(rf"^(?:{NUM})$")
    base_conf = (
        1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100
    ) * float(col.get("confidence", 0.9))
    source = (
        "pdf-text"
        if page.source == "text"
        else "scan-ocr"
        if page.source == "ocr"
        else "structured"
    )
    out: list[Extraction] = []
    for h in words:
        if not re.search(col["head"], h.text, flags=re.I):
            continue
        over = [
            u
            for u in words
            if re.search(col["over"], u.text, flags=re.I)
            and u.bbox[3] <= h.bbox[1] + 0.002
            and h.bbox[1] - u.bbox[1] <= HEAD_DY
            and abs(_cx(u.bbox) - _cx(h.bbox)) <= COL_DX + 0.02
        ]
        if not over:
            continue  # «застройки» без «Площадь» над ним — не шапка площади
        below = [
            v
            for v in words
            if num_rx.match(v.text)
            and v.bbox[1] > h.bbox[3]
            and v.bbox[1] - h.bbox[3] <= COL_DY
            and abs(_cx(v.bbox) - _cx(h.bbox)) <= COL_DX
        ]
        if not below:
            continue
        v = min(
            below, key=lambda w: (round(w.bbox[1], 3), abs(_cx(w.bbox) - _cx(h.bbox)))
        )
        if not math.isfinite(to_number(v.text)):
            continue  # слово из сотен цифр под шапкой — не значение (T173-L2)
        if (round(v.bbox[0], 4), round(v.bbox[1], 4)) in taken:
            continue  # то же значение уже найдено оборотом в строке
        # подписи строк на высоте значения: значение в объединённой ячейке стоит между строками («Жилое здание» и
        # «Пандус въезда-выезда» — одна ячейка площади, ГП1 «Полярная 17»); каждая строка — до первого дробного числа,
        # дальше значения соседних колонок (этажность, отметки)
        near = sorted(
            (w for w in words if abs(w.bbox[1] - v.bbox[1]) <= ROW_DY + 0.003 and w.bbox[2] < h.bbox[0] - 0.02),
            key=lambda w: (w.bbox[1], w.bbox[0]),
        )
        rows: list[list] = []
        for w in near:
            if rows and abs(rows[-1][0].bbox[1] - w.bbox[1]) <= 0.004:
                rows[-1].append(w)
            else:
                rows.append([w])
        # колонка подписей кончается левее первого дробного числа этих строк (этажность «13,20»): счётчики правее — не подпись
        dec = [w.bbox[0] for w in near if re.fullmatch(r"\d+[.,]\d+", w.text)]
        edge = min(dec) if dec else h.bbox[0] - 0.02
        labels: list[str] = []
        for r in rows:
            toks = [w.text for w in sorted(r, key=lambda w: w.bbox[0]) if w.bbox[0] < edge]
            # перенос подписи на вторую строку: «2 подземную автостоянку» — номер позиции и слово со строчной буквы
            cont = labels and len(toks) > 0 and (toks[0][:1].islower() or (toks[0].isdigit() and len(toks) > 1 and toks[1][:1].islower()))
            if cont:
                labels[-1] += " " + " ".join(t for t in toks if not (t is toks[0] and t.isdigit()))
            elif re.search(r"[А-Яа-яЁё]{3}", " ".join(toks)):
                labels.append(" ".join(toks))
        row = "; ".join(labels)
        head = f"{over[0].text} {h.text}"
        if len(labels) > 1:
            quote = f"{head}: {v.text} — объединённая ячейка строк «" + "» и «".join(labels) + "»"
        else:
            quote = f"{head}: {v.text}" + (f" — строка «{row}»" if row else "")
        rule = _excluded(cfg, row)
        conf = base_conf * (DISPUTED_PENALTY if v.disputed else 1.0)
        out.append(
            Extraction(
                code=spec.code,
                raw=v.text,
                value_num=to_number(v.text),
                page=page.page,
                bbox=v.bbox,
                anchor_bbox=union([over[0].bbox, h.bbox]),
                line_text=quote,
                confidence=round(conf, 3),
                meta={
                    "quote": quote,
                    "qualifier": None,
                    "values": [to_number(v.text)],
                    "excluded": rule["code"] if rule else None,
                    "excluded_why": rule.get("why") if rule else None,
                    "text_source": source,
                    "table": "column",
                    "rows": labels,
                    "ops": list(OPS),
                },
            )
        )
    return out


def _aspect_cfg(cfg: dict, asp: dict) -> dict:
    """Конфигурация аспекта (OS-INSP-2.2.53): свой оборот и единицы, связки и стоп-слова — общие; без колонки и предела.
    Счёт и обязательная единица (T-211) у аспекта свои: высота подступенка не целое, как число ступеней."""
    own = ("column", "limit_anchor", "variants", "unitless", "units_table", "page_unit", "integer", "unit_required", "plausible")
    return {**{k: v for k, v in cfg.items() if k not in own}, **{k: v for k, v in asp.items() if k != "key"}, "exclude": asp.get("exclude") or []}


def _one_per_page(ms: list[Extraction]) -> list[Extraction]:
    """OS-INSP-2.2.133 (T-211): на листе разные значения одного показателя (аспекта, варианта) — отсеиваются все, с причиной.
    Уклоны на плане организации рельефа и марши лестниц — у каждого участка свои; пару ПД–РД по тексту не собрать."""
    groups: dict[tuple, list[Extraction]] = {}
    for e in ms:
        if e.meta.get("excluded") is None and not e.meta.get("limit"):
            groups.setdefault((e.page, e.meta.get("aspect"), e.meta.get("variant"), e.meta.get("object")), []).append(e)
    for g in groups.values():
        if len({round(e.value_num, 6) for e in g}) > 1:
            for e in g:
                e.meta["excluded"], e.meta["excluded_why"] = PAGE_MULTI["code"], PAGE_MULTI["why"]
    return ms


def extract_quantity_mentions(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    """Все упоминания показателя по порядку страниц, включая отсеянные (meta.excluded): оборотом в строке и в колонке
    таблицы; пределы нормы (meta.limit) и аспекты паспорта (meta.aspect) — отдельными упоминаниями."""
    cfg = spec.extractor or {}
    out: list[Extraction] = []
    for page in doc.pages:
        inline = _page_mentions(page, spec, cfg)
        taken = {(round(e.bbox[0], 4), round(e.bbox[1], 4)) for e in inline if e.bbox}
        out += inline + _column_mentions(page, spec, cfg, taken) + _table_mentions(page, spec, cfg)
        for asp in cfg.get("aspects") or []:
            acfg = _aspect_cfg(cfg, asp)
            out += _page_mentions(page, spec, acfg, aspect=asp["key"]) + _table_mentions(page, spec, acfg, aspect=asp["key"])
    return _one_per_page(out) if cfg.get("one_per_page") else out
