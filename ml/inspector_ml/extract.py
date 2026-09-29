"""Извлечение значений параметров Матрицы с координатами (OS-INSP-2.2).

Профиль dev (ADR-0001): семантический якорь = нечёткое совпадение названия параметра со строкой
(rapidfuzz). Профиль gpu заменяет `anchor_score` эмбеддингами sentence-transformers, остальное
не меняется. Значение ищется в той же строке правее якоря: по regex_pattern параметра, иначе —
первое число. Не нашли значение — не выдумываем (OS-INSP-2.2.3).
"""

from __future__ import annotations

import functools
import logging
import re
import time

import numpy as np
from rapidfuzz import fuzz, process

from .extractor_kinds import way_of
from .geom_mentions import GeomSpecError
from .model import BBox, Extraction, Line, ParamSpec, ParsedDoc, RoomFact
from .normalize import NUMBER_RE, fold, latinize_code, parse_number
from .parse import union

log = logging.getLogger(__name__)

ANCHOR_MIN = 90  # порог совпадения якоря для текстового слоя
ANCHOR_MIN_OCR = 82  # для OCR — ниже: распознавание шумнее
DISPUTED_PENALTY = (
    0.6  # значение из слова, где движки OCR разошлись, — менее уверенно (OS-INSP-2.1.6)
)
# Версия логики извлечения: входит в ключ кэша /analyze — меняется при любом изменении правил извлечения
EXTRACT_REV = 24  # 24: combined T-241 subject safeguards and T-242 quantity boundaries (T-244); 23: floor-count legend subject geometry (T-241); 22: fire-distance table columns and building bullet scope (T-241); 21: joint subjects and incompatible energy scale (T-241); 20: субъект рампы M-023 и перечня сноса M-007 (T-241); 19: обратные названия классов и полный sentence-контекст M-023 (T-241); 18: субъект колонки этажности M-007 (T-241); 17: контекст отдельного правила отсева M-023 (T-241); 16: M-022 — нормативные условия, общие количества отсеков, соседи при реконструкции (T-241); 15: M-022 — явные субъекты и отказ от неоднозначных степеней (T-241); 14: отметки изменений для CMP-29 в ответе анализа (change_marks, T-177); 13: предфильтр строк и время по параметрам (OS-INSP-2.2.34), номер помещения с литерой «1.18а» (T-138); 12: показатель степени «м²/м³», отвалившийся в одиночную «2»/«3», не значение (OS-INSP-2.2.31, T-135); 10: значения из строк таблиц PDF в конвейере (OS-INSP-2.2.5, 2.2.30, T-135); 9: цитата упоминания количества — от оборота до значения, строки объединённой ячейки ведомости (T-132); 8: упоминания количественного показателя по паспорту (quantity_mentions, М-001, OS-INSP-2.2.22–2.2.25, T-132); 7: у упоминания класса источник текста и прочтения читателей сканов (OS-INSP-2.2.18–2.2.20, T-130); 6: упоминания класса по шкале из паспорта параметра (class_mentions, М-023, OS-INSP-2.2.13–2.2.16); 5: перечитывание сомнительных значений OCR (reread, OS-INSP-2.2.12); 4: семантика — порог 0,84, только многословные тексты, кодирование без пакета, отрыв между параметрами; 3: короткая строка не совпадает с длинным якорем частично (корпус); 2: строки/перечисления целиком, соперники, конец якоря по выравниванию, семантика (итерация 3)
NUMERIC_RULES = (
    "decrease",
    "increase",
    "delta_pct",
    "min",
    "max",
)  # правила Матрицы, сравнивающие числа
STRIP = " \t:;—–-=.,|_'`\\"  # разделители и соринки скана между якорем и строковым значением
ROOM_RE = re.compile(
    r"^Помещение\s+(\d+(?:\.\d+)?[а-яёa-z]?)\s+(.+)$", re.IGNORECASE
)  # литера номера — «1.18а» (T-138)


_fold_line = functools.lru_cache(maxsize=1 << 17)(
    fold
)  # нормализация строки и якоря — один раз (OS-INSP-2.2.34)


def anchor_score(anchor: str, line: str) -> float:
    a, s = _fold_line(anchor), _fold_line(line)
    if not a or not s:
        return 0.0
    if a in s:
        return 100.0
    if len(s) < len(a):
        # partial_ratio ищет КОРОТКУЮ строку внутри длинной: соринка OCR («о», «2», «Т1 2») целиком входит
        # в любой якорь и получала 100. Строка короче якоря — только полное сходство.
        return fuzz.ratio(a, s)
    return fuzz.partial_ratio(a, s)


# OS-INSP-2.2.34 (ТЗ §11, TZA-11-07): ML-анализ параметра ≤ 500 мс на документ. Лексический путь перебирает
# «параметр × строка × якорь»; дорого было не сравнение, а нормализация строки заново для каждой пары. Предфильтр:
# строка нормализуется один раз (кэш), сравнение идёт с отсечкой по порогу (score_cutoff) — строка, не дотянувшая
# до порога ни одним якорем, отбрасывается до полного расчёта. Результат не меняется: дальше — прежний расчёт.
PREFILTER = True


@functools.lru_cache(maxsize=4096)
def _fold_anchors(anchors: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(a for a in (fold(x) for x in anchors) if a)


def folded_anchors(spec: ParamSpec) -> tuple[str, ...]:
    return _fold_anchors(tuple(spec.anchors))


def line_passes(anchors: tuple[str, ...], text: str, threshold: float) -> bool:
    """Дотягивает ли строка до порога хотя бы одним якорем — те же правила, что anchor_score, с отсечкой."""
    s = _fold_line(text)
    if not s:
        return False
    for a in anchors:
        if a in s:
            return True
        cmp = fuzz.ratio if len(s) < len(a) else fuzz.partial_ratio
        if cmp(a, s, score_cutoff=threshold):
            return True
    return False


class _LineIndex:
    """Строки документа, нормализованные один раз, — для предфильтра всех параметров разом (OS-INSP-2.2.34)."""

    def __init__(self, doc: ParsedDoc):
        self.refs = [
            (page, li, line) for page in doc.pages for li, line in enumerate(page.lines)
        ]
        self.texts = [_fold_line(line.text) for _, _, line in self.refs]
        self.lens = np.array([len(t) for t in self.texts])
        self.thr = np.array(
            [
                ANCHOR_MIN_OCR if page.source == "ocr" else ANCHOR_MIN
                for page, _, _ in self.refs
            ]
        )
        # мешок символов строки: общих с якорем символов ov не больше пересечения мешков, а сходство любого окна
        # строки с якорем (Indel: 2·LCS / (|a| + |t|)) не больше 2·ov / (|a| + ov). Не дотягивает граница —
        # не дотянет и точный расчёт: строка отсеивается без сравнения (результат тот же, сравнений меньше)
        self.alphabet = {
            c: i for i, c in enumerate(sorted({c for t in self.texts for c in t}))
        }
        self.bags = np.zeros((len(self.texts), len(self.alphabet)), dtype=np.int32)
        for row, t in enumerate(self.texts):
            for c in t:
                self.bags[row, self.alphabet[c]] += 1

    def _bound_ok(self, a: str) -> np.ndarray:
        bag = np.zeros(len(self.alphabet), dtype=np.int32)
        for c in a:
            i = self.alphabet.get(c)
            if i is not None:
                bag[i] += 1
        ov = np.minimum(self.bags, bag).sum(axis=1)
        return 200 * ov >= self.thr * (len(a) + ov)

    def passing(self, anchors: tuple[str, ...]) -> list[int]:
        """Номера строк, где хотя бы один якорь дотягивает до порога страницы — как line_passes, одной матрицей
        rapidfuzz: строка короче якоря — полное сходство, иначе частичное."""
        ok = np.zeros(len(self.texts), dtype=bool)
        if not self.texts:
            return []
        cut = int(min(ANCHOR_MIN, ANCHOR_MIN_OCR))
        for a in anchors:
            short = self.lens < len(a)
            alive = ~ok & (self.lens > 0) & self._bound_ok(a)
            for mask, scorer in ((short, fuzz.ratio), (~short, fuzz.partial_ratio)):
                idx = np.flatnonzero(mask & alive)
                if idx.size:
                    sc = process.cdist(
                        [a],
                        [self.texts[i] for i in idx],
                        scorer=scorer,
                        score_cutoff=cut,
                        workers=1,
                    )[0]
                    ok[idx[sc >= self.thr[idx]]] = True
        return np.flatnonzero(ok).tolist()


def _keep(s: str) -> str:
    """Нормализация без изменения длины: позиции совпадают с исходной строкой (в отличие от fold)."""
    return re.sub(r"[^\w\s]", " ", s.lower().replace("ё", "е"))


def _anchor_end(anchor: str, text: str) -> int:
    """Позиция в строке сразу после якоря. Нечёткое совпадение (скан, опечатка) — по выравниванию rapidfuzz,
    дотянутому до конца слова: иначе хвост «значения» захватывал остаток подписи («Т1, Т2» → число 1)."""
    t, a = _keep(text), _keep(anchor)
    i = t.find(a)
    if i >= 0:
        return i + len(anchor)
    if len(t) != len(
        text
    ):  # lower() сменил длину (редкие символы) — позиции не сопоставимы
        return min(len(anchor), len(text))
    end = fuzz.partial_ratio_alignment(a, t).dest_end
    while end < len(text) and (text[end].isalnum() or text[end] in ')»"'):
        end += 1
    return end


def _span_bbox(line: Line, start: int, end: int) -> BBox | None:
    """bbox слов строки, пересекающихся с диапазоном символов [start, end)."""
    pos, boxes = 0, []
    for w in line.words:
        ws, we = pos, pos + len(w.text)
        if we > start and ws < end and w.bbox:
            boxes.append(w.bbox)
        pos = we + 1
    return union(boxes)


def _span_disputed(line: Line, start: int, end: int) -> bool:
    """Есть ли в диапазоне символов [start, end) слово, помеченное ансамблем OCR сомнительным."""
    pos = 0
    for w in line.words:
        ws, we = pos, pos + len(w.text)
        if we > start and ws < end and w.disputed:
            return True
        pos = we + 1
    return False


def _find_value(spec: ParamSpec, line: Line, after: int) -> tuple[str, int, int] | None:
    tail = line.text[after:]
    if spec.regex_pattern:
        # классы и марки: ищем по латинизированному хвосту, позиции совпадают посимвольно
        m = re.search(spec.regex_pattern, latinize_code_keep_len(tail), flags=re.I)
        if m:
            return tail[m.start() : m.end()], after + m.start(), after + m.end()
        return None
    if spec.data_type in ("string", "enum"):
        # строковое (и перечислимое без шаблона) значение — весь хвост после якоря («по типовому решению», «3 марша»)
        lead = len(tail) - len(tail.lstrip(STRIP))
        val = tail.strip(STRIP)
        return (val, after + lead, after + lead + len(val)) if val else None
    m = NUMBER_RE.search(tail)
    if m and _power_mark(spec, m.group(0)):
        # OS-INSP-2.2.31: «м²» в текстовом слое распался на «м» и одиночное «2» (ТЭП «Алтуфьево», ПЗ стр. 10) — это
        # показатель степени единицы, значение — следующее число; нет следующего — «2» и остаётся (не выдумываем)
        m = NUMBER_RE.search(tail, m.end()) or m
    if m:
        return m.group(0), after + m.start(), after + m.end()
    return None


_POWER = {"2": ("м²", "м2", "кв.м", "м.кв"), "3": ("м³", "м3", "куб.м", "м.куб")}


def _power_mark(spec: ParamSpec, num: str) -> bool:
    """Одиночная «2» у параметра в м² или «3» у параметра в м³ — кандидат в отвалившийся показатель степени."""
    unit = re.sub(r"\s+", "", (spec.unit or "").lower())
    return num in _POWER and unit in _POWER[num]


def latinize_code_keep_len(s: str) -> str:
    """Латинизация без удаления пробелов — чтобы позиции совпадений совпадали с исходной строкой."""
    from .normalize import _CYR2LAT

    return s.translate(_CYR2LAT)


def _claim(spec: ParamSpec, text: str) -> tuple[float, int]:
    """Ключ притязания параметра на строку: сходство лучшего якоря, затем его длина (конкретнее — сильнее)."""
    return max(
        ((anchor_score(a, text), len(a)) for a in spec.anchors), default=(0.0, 0)
    )


def _rivals(specs: list[ParamSpec]) -> dict[str, list[ParamSpec]]:
    """Соперники — параметры с похожими якорями: один нечётко входит в другой («Строительный объем» и
    «Строительный объем (Подземный)»). Разные поля одной строки («Шифр», «Стадия», «Ред.») не соперничают."""
    out: dict[str, list[ParamSpec]] = {sp.code: [] for sp in specs}
    for i, a in enumerate(specs):
        for b in specs[i + 1 :]:
            # порог соперничества — нижний из порогов (OCR-страница принимает якорь уже с ANCHOR_MIN_OCR): иначе
            # на скане «Ширина эвакуационного коридора» забирал строку «…выхода», не считаясь её соперником
            if any(
                fuzz.partial_ratio(fold(x), fold(y)) >= min(ANCHOR_MIN, ANCHOR_MIN_OCR)
                for x in a.anchors
                for y in b.anchors
            ):
                out[a.code].append(b)
                out[b.code].append(a)
    return out


def extract(
    doc: ParsedDoc,
    specs: list[ParamSpec],
    embedder=None,
    timings: dict[str, float] | None = None,
) -> list[Extraction]:
    """Лексическое извлечение; с embedder — дополнение по смыслу для параметров без совпадения (OS-INSP-2.2.8).
    timings — время анализа каждого параметра, мс (OS-INSP-2.2.34): свой путь параметра плюс доля общего
    семантического шага, поровну между параметрами, ушедшими в семантику."""
    out: list[Extraction] = []
    spent: dict[str, float] = {}

    def clock(code: str, t0: float) -> None:
        spent[code] = spent.get(code, 0.0) + (time.perf_counter() - t0) * 1000

    # OS-INSP-2.2.13: параметр с извлекателем упоминаний класса идёт своим путём — все упоминания, а не лучшая
    # строка; в лексический и семантический путь не попадает и соперником другим параметрам не становится.
    # OS-INSP-2.2.22: количественный параметр с паспортом — так же все упоминания, своим путём (T-132, М-001)
    mentions: list[Extraction] = []
    for sp in specs:
        way = way_of(
            sp
        )  # T-186: извлекатель по виду паспорта — из реестра extractor_kinds.py
        if way is not None:
            t0 = time.perf_counter()
            try:
                mentions += way(doc, sp)
            except GeomSpecError:
                raise  # ошибка спецификации паспорта — ошибка данных, громкая (тест «unknown entity/measure is loud»)
            except Exception:  # noqa: BLE001 — T-233: сбой извлекателя одного параметра не роняет анализ файла (/analyze → 500)
                # паспорт с неподдерживаемой связкой (GeomSpecError М-060) держал весь разбор стенда: файл уходил на повтор
                # по кругу. Параметр пропускается — у него «нет доказательства», причина — в журнале ML с кодом параметра
                log.exception(
                    "извлекатель параметра %s упал — параметр пропущен, файл разбирается дальше",
                    sp.code,
                )
            clock(sp.code, t0)
    specs = [sp for sp in specs if way_of(sp) is None]
    # OS-INSP-2.2.10: строка таблицы — одному из параметров-соперников, чей якорь совпал лучше и конкретнее.
    # «Строительный объем (Надземный)» не забирает строку «Строительный объем (Подземный)» — у M-005 совпадение лучше.
    t0 = time.perf_counter()
    rivals = _rivals(specs)
    index = _LineIndex(doc) if PREFILTER else None
    shared = (
        (time.perf_counter() - t0) * 1000 / max(1, len(specs))
    )  # соперники и индекс строк — на всех сразу
    for spec in specs:
        t0 = time.perf_counter()
        best: tuple[float, Extraction] | None = None
        # предфильтр: только строки, где якорь дотягивает до порога; без него — все строки документа по порядку
        lines = (
            [index.refs[i] for i in index.passing(folded_anchors(spec))]
            if index is not None
            else [(p, li, ln) for p in doc.pages for li, ln in enumerate(p.lines)]
        )
        for page, li, line in lines:
            threshold = ANCHOR_MIN_OCR if page.source == "ocr" else ANCHOR_MIN
            claim = _claim(spec, line.text)
            score = claim[0]
            if score < threshold or any(
                _claim(rv, line.text) > claim for rv in rivals[spec.code]
            ):
                continue  # строка принадлежит сопернику с лучшим якорем
            anchor = max(spec.anchors, key=lambda a: anchor_score(a, line.text))
            after = _anchor_end(anchor, line.text)
            found = _find_value(spec, line, after)
            if not found:
                continue
            raw, s, e = found
            is_num = spec.data_type == "number" and not spec.regex_pattern
            # OS-INSP-2.2.9: строка с числовым/порядковым правилом («3 марша», «150 мм») — текст и главное число
            num_rule = (
                spec.data_type == "string"
                and not spec.regex_pattern
                and spec.compare_kind in NUMERIC_RULES
            )
            conf = (
                score
                / 100
                * (1.0 if page.source != "ocr" else (page.ocr_confidence or 50) / 100)
            )
            if _span_disputed(line, s, e):
                conf *= DISPUTED_PENALTY
            ex = Extraction(
                code=spec.code,
                raw=raw,
                value_num=parse_number(raw) if (is_num or num_rule) else None,
                value_text=None if is_num else latinize_code(raw),
                page=page.page,
                bbox=_span_bbox(line, s, e),
                anchor_bbox=_span_bbox(line, 0, after),
                line_text=line.text,
                confidence=round(conf, 3),
            )
            if best is None or conf > best[0]:
                best = (conf, ex)
        if best:
            out.append(best[1])
        clock(spec.code, t0)
        spent[spec.code] += shared
    if embedder is not None:
        from .semantic import semantic_extract

        found = {e.code for e in out}
        taken = {(e.page, e.line_text) for e in out}
        rest = [s for s in specs if s.code not in found]
        t0 = time.perf_counter()
        out += semantic_extract(doc, rest, taken, embedder)
        share = (time.perf_counter() - t0) * 1000 / max(1, len(rest))
        for s in rest:
            spent[s.code] += share
    if timings is not None:
        for code, ms in spent.items():
            timings[code] = timings.get(code, 0.0) + ms
    return out + mentions


def rooms(doc: ParsedDoc) -> list[RoomFact]:
    """Экспликация помещений: номер → назначение (для семантического диссонанса ПД↔РД, ТЗ 9.5)."""
    out = []
    for page in doc.pages:
        for line in page.lines:
            m = ROOM_RE.match(line.text)
            if m:
                out.append(
                    RoomFact(
                        number=m.group(1),
                        name=m.group(2).strip(),
                        page=page.page,
                        bbox=_span_bbox(line, 0, len(line.text)),
                    )
                )
    return out
