"""Основная надпись (штамп) листа по ГОСТ Р 21.101-2020, приложение Ж (T-127, шаг 3 RESEARCH-ALIGNMENT).

Форма 3 — графические документы ПД и РД, 185 × 55 мм (11 строк по 5 мм).
Форма 5 — первый лист текстового документа, 185 × 40 мм (8 строк по 5 мм).
Форма 6 — последующие листы текстового документа, 185 × 15 мм (3 строки по 5 мм): шифр и номер листа.
Все привязаны к правому нижнему углу внутренней рамки листа. Графы заданы прямоугольниками в мм от левого
верхнего угла надписи — так они проставлены на чертежах форм; в доли страницы переводятся по размеру листа.

Угол рамки ищется тремя путями, по убыванию доверия:
  * векторная рамка — самые правая и нижняя длинные линии страницы PDF (`frame_from_pdf`, по желанию);
  * подписи граф — «Стадия», «Лист», «Листов», шапка «Изм. Кол.уч Лист № док. Подп. Дата», «Разраб.», «Н. контр.» —
    каждая даёт свою оценку угла;
  * поле листа по ГОСТ Р 21.101 (правое и нижнее — 5 мм).
Форма выбирается по тому, при каком угле больше подписей попадает в свои ячейки; подписи правой части весят больше:
строки левой части (изменения, подписи) организации двигают, правая часть держится ГОСТ. Подписей нет, а значения
по сетке ГОСТ не проходят проверку — штамп нестандартный: система воздерживается и называет причину.

Координаты — как в parse.py: доли видимой области страницы (после CropBox и /Rotate), начало — левый верхний угол.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from .cipher import canon, fix_code
from .model import BBox, Page, Word
from .normalize import fold

PT_MM = 25.4 / 72
WIDTH = 185.0  # ширина основной надписи всех форм
LEFT = (
    65.0  # левая часть (изменения, подписи) — 0…65 мм, правая (графы 1–9) — 65…185 мм
)
MARGIN = 5.0  # правое и нижнее поле листа, мм (ГОСТ Р 21.101-2020, 5.2)
MAX_MARGIN = 30.0  # угол рамки дальше от края листа — не рамка по ГОСТ (поле 20/5 мм плюс запас на печать)
SLACK = 1.5  # допуск попадания подписи в свою ячейку, мм
MIN_LABELS = 2  # столько подписей граф в своих ячейках — надпись найдена
RIGHT_WEIGHT = 3  # вес подписи правой части: «Стадия», «Лист», «Листов» различают формы
FIXED_SHARE = (
    0.75  # векторная рамка держится, пока объясняет ≥ 3/4 лучшего по подписям счёта
)
LINE_MM = 1.5  # слова значения с центрами ближе по высоте — одна строка
STAGES = {"П", "Р", "И"}  # графа 6: проектная, рабочая, изыскания
REGISTRY_STAGE = {"PD": "П", "RD": "Р"}  # ИД стадии в штампе не имеет

# Основные форматы ГОСТ 2.301, мм (короткая, длинная сторона); кратные — длинная сторона = k × короткая базового.
FORMATS = {
    "A0": (841, 1189),
    "A1": (594, 841),
    "A2": (420, 594),
    "A3": (297, 420),
    "A4": (210, 297),
}

Rect = tuple[
    float, float, float, float
]  # x0, y0, x1, y1 в мм от левого верхнего угла надписи

# Причины воздержания — постоянные: по ним API и отчёт замера группируют отказы.
NO_GEOMETRY = "у документа нет геометрии страницы"
TOO_SMALL = "лист меньше основной надписи"
NO_WORDS = "на листе нет слов"
NOT_FOUND = "основная надпись по ГОСТ Р 21.101 не найдена: нет подписей граф и правдоподобных значений"
LABELS_AMBIGUOUS = (
    "подписи граф одинаково подходят к разным формам — форма не определена"
)
VALUES_AMBIGUOUS = "значения правдоподобны в нескольких формах — форма не определена"


@dataclass(frozen=True)
class Form:
    number: int
    height: float
    fields: dict[str, tuple[int, Rect]]  # имя → (номер графы, ячейка значения)
    labels: dict[
        str, tuple[Rect, ...]
    ]  # ключ подписи → её ячейки («Лист» — и в шапке изменений, и над графой 7)
    change_rows: int  # строк таблицы изменений (графы 14–19) над шапкой «Изм.»


# Колонки левой части (графы 14–19 и 10–13): 10, 10, 10, 10, 15, 10 мм.
CHANGE_COLS = [
    ("izm", 0, 10),
    ("kol_uch", 10, 20),
    ("sheet", 20, 30),
    ("doc_no", 30, 40),
    ("sign", 40, 55),
    ("date", 55, 65),
]
HEADER_KEYS = ("изм", "кол", "лист", "док", "подп", "дата")
# Шапка «Изм. Кол.уч Лист № док. Подп. Дата» — строка 5 мм под строками изменений: y — верх шапки.
HEADER3 = {
    k: ((x0, 15.0, x1, 20.0),) for k, (_, x0, x1) in zip(HEADER_KEYS, CHANGE_COLS)
}
HEADER5 = {
    k: ((x0, 5.0, x1, 10.0),) for k, (_, x0, x1) in zip(HEADER_KEYS, CHANGE_COLS)
}
HEADER6 = {
    k: ((x0, 10.0, x1, 15.0),) for k, (_, x0, x1) in zip(HEADER_KEYS, CHANGE_COLS)
}

FORM3 = Form(
    number=3,
    height=55.0,
    fields={
        "code": (1, (65, 0, 185, 10)),
        "enterprise": (2, (65, 10, 185, 25)),
        "building": (3, (65, 25, 135, 40)),
        "stage": (6, (135, 30, 150, 40)),
        "sheet": (7, (150, 30, 165, 40)),
        "sheets": (8, (165, 30, 185, 40)),
        "sheet_title": (4, (65, 40, 135, 55)),
        "org": (9, (135, 40, 185, 55)),
    },
    labels={
        **HEADER3,
        "лист": ((20, 15, 30, 20), (150, 25, 165, 30)),
        "стадия": ((135, 25, 150, 30),),
        "листов": ((165, 25, 185, 30),),
        "разраб": ((0, 20, 20, 25),),
        "н контр": ((0, 50, 20, 55),),
    },
    change_rows=3,
)
FORM5 = Form(
    number=5,
    height=40.0,
    fields={
        "code": (1, (65, 0, 185, 15)),
        "doc_title": (5, (65, 15, 135, 40)),
        "stage": (6, (135, 20, 150, 25)),
        "sheet": (7, (150, 20, 165, 25)),
        "sheets": (8, (165, 20, 185, 25)),
        "org": (9, (135, 25, 185, 40)),
    },
    labels={
        **HEADER5,
        "лист": ((20, 5, 30, 10), (150, 15, 165, 20)),
        "стадия": ((135, 15, 150, 20),),
        "листов": ((165, 15, 185, 20),),
        "разраб": ((0, 10, 20, 15),),
        "н контр": ((0, 35, 20, 40),),
    },
    change_rows=1,
)
FORM6 = Form(
    number=6,
    height=15.0,
    fields={
        "code": (1, (65, 0, 175, 15)),
        "sheet": (7, (175, 7, 185, 15)),
    },
    labels={
        **HEADER6,
        "лист": ((20, 10, 30, 15), (175, 0, 185, 7)),
    },
    change_rows=2,
)
FORMS = (FORM3, FORM5, FORM6)
# Прочие подписи граф (должности в графе 10, «Формат»): в значения не попадают.
LABEL_WORDS = {
    "уч",
    "н",
    "контр",
    "формат",
    "пров",
    "гип",
    "утв",
    "нач",
    "отд",
    "т",
    "согласовано",
}
CONF = {"vector": 0.9, "labels": 0.9, "default": 0.6}
RANK = {"vector": 2, "default": 1, "labels": 0}
CODE_RE = re.compile(r"^[0-9A-Za-zА-Яа-яЁё_]+(?:[-./][0-9A-Za-zА-Яа-яЁё_]+)+$")


@dataclass
class Field:
    graph: int
    value: str | None
    bbox: BBox  # рамка слов значения, пустая графа — её ячейка
    confidence: float


@dataclass
class TitleBlock:
    form: int
    fields: dict[str, Field]
    frame_bbox: BBox  # внутренняя рамка листа; по подписям и полю ГОСТ известен только угол — рамка от края листа
    corner_source: str  # vector | labels | default
    sheet_format: str | None  # A3, A4x3… по размеру листа
    changes: list[dict[str, str]] = field(
        default_factory=list
    )  # строки таблицы изменений, графы 14–19
    warnings: list[str] = field(default_factory=list)

    def value(self, name: str) -> str | None:
        f = self.fields.get(name)
        return f.value if f else None

    @property
    def title(self) -> str | None:
        """Наименование: графы 2–4 (форма 3) или 5 (форма 5); у формы 6 наименования нет."""
        parts = [
            self.value(n)
            for n in ("enterprise", "building", "sheet_title", "doc_title")
        ]
        return ". ".join(p for p in parts if p) or None


@dataclass(frozen=True)
class Detection:
    block: TitleBlock | None
    reason: str | None  # почему воздержались; None — надпись прочитана


# ─────────────────────────────────────────────── геометрия листа


def page_mm(page: Page) -> tuple[float, float]:
    """Видимый размер листа в мм. pdfium (FPDF_GetPageWidthF) отдаёт размер уже после /Rotate —
    стороны не меняем; у растра формата image — размер картинки."""
    return page.width * PT_MM, page.height * PT_MM


def sheet_format(w_mm: float, h_mm: float, tol: float = 3.0) -> str | None:
    """Обозначение формата по ГОСТ 2.301: A0…A4 и кратные (A4x3 = 297 × 630)."""
    s, l = sorted((w_mm, h_mm))
    for name, (a, b) in FORMATS.items():
        if abs(s - a) <= tol and abs(l - b) <= tol:
            return name
    for name, (a, b) in FORMATS.items():
        for k in range(2, 10):
            if abs(s - b) <= tol and abs(l - k * a) <= tol * k:
                return f"{name}x{k}"
    return None


def _center(b: BBox, wmm: float, hmm: float) -> tuple[float, float]:
    return (b[0] + b[2]) / 2 * wmm, (b[1] + b[3]) / 2 * hmm


def _inside(p: tuple[float, float], r: Rect, slack: float = 0.0) -> bool:
    return r[0] - slack <= p[0] <= r[2] + slack and r[1] - slack <= p[1] <= r[3] + slack


def _near_corner(corner: tuple[float, float], size: tuple[float, float]) -> bool:
    """Угол рамки — у правого нижнего края листа: не дальше MAX_MARGIN и не за краем."""
    return (
        0 <= size[0] - corner[0] <= MAX_MARGIN
        and 0 <= size[1] - corner[1] <= MAX_MARGIN
    )


# ─────────────────────────────────────────────── подписи граф и выбор формы


def _label_key(text: str) -> str | None:
    """Подпись графы-якорь: «Н.контр.» → «н контр», «№ док.» → «док», «Подпись» → «подп»."""
    k = fold(text).replace(" ", "")
    if k in ("изм", "стадия", "листов", "лист", "дата"):
        return k
    if k.startswith("разраб"):
        return "разраб"
    if k in ("нконтр", "нормконтр", "нормоконтр", "нормоконтроль"):
        return "н контр"
    if k.startswith("кол"):
        return "кол"
    if k in ("док", "nдок", "до", "nдо") or k.startswith("докум"):
        return "док"
    if k.startswith("подп"):
        return "подп"
    return None


def _is_label(text: str) -> bool:
    return _label_key(text) is not None or fold(text) in LABEL_WORDS


def _words(page: Page) -> list[Word]:
    return [w for ln in page.lines for w in ln.words if w.bbox and w.text.strip()]


def _labels(
    words: list[Word], wmm: float, hmm: float
) -> list[tuple[str, tuple[float, float]]]:
    """Подписи граф на листе: (ключ, центр в мм от левого верхнего угла листа)."""
    out = []
    for w in words:
        key = _label_key(w.text)
        if key:
            out.append((key, _center(w.bbox, wmm, hmm)))
    # «Н. контр.» часто разбит на два слова: «Н.» и следом в той же строке «контр.»
    for n in (w for w in words if fold(w.text) == "н"):
        cx, cy = _center(n.bbox, wmm, hmm)
        for w in words:
            x, y = _center(w.bbox, wmm, hmm)
            if fold(w.text).startswith("контр") and abs(y - cy) < 2 and 0 < x - cx < 15:
                out.append(("н контр", ((cx + x) / 2, cy)))
                break
    return out


def _origin(corner: tuple[float, float], form: Form) -> tuple[float, float]:
    return corner[0] - WIDTH, corner[1] - form.height


def _inliers(labels, corner, form: Form) -> list[tuple[tuple[float, float], Rect]]:
    """Подписи, попавшие в свои ячейки формы при данном угле: (центр слова, ячейка)."""
    ox, oy = _origin(corner, form)
    out = []
    for k, p in labels:
        for r in form.labels.get(k, ()):
            if _inside((p[0] - ox, p[1] - oy), r, SLACK):
                out.append((p, r))
                break
    return out


def _estimate(p: tuple[float, float], r: Rect, form: Form) -> tuple[float, float]:
    """Угол рамки, при котором слово стоит в центре ячейки r."""
    return p[0] + WIDTH - (r[0] + r[2]) / 2, p[1] + form.height - (r[1] + r[3]) / 2


def _weight(inl) -> int:
    """Вес совпадений: ячейка правой части (правее LEFT) — RIGHT_WEIGHT, левой — 1."""
    return sum(RIGHT_WEIGHT if r[2] > LEFT else 1 for _, r in inl)


@dataclass(frozen=True)
class _Cand:
    score: int  # взвешенное число подписей в своих ячейках
    n: int  # подписей в своих ячейках
    rank: int  # вектор 2, поле ГОСТ 1, подписи 0
    form: Form
    corner: tuple[float, float]
    src: str


def _candidates(labels, hint, default, size) -> list[_Cand]:
    """Гипотезы (форма, угол): угол векторной рамки, поле ГОСТ и углы, выведенные из каждой подписи."""
    fixed = ([(hint, "vector")] if hint else []) + [(default, "default")]
    out = []
    for form in FORMS:
        own = list(fixed)
        for k, p in labels:
            own += [(_estimate(p, r, form), "labels") for r in form.labels.get(k, ())]
        for corner, src in own:
            if src == "labels" and not _near_corner(corner, size):
                continue  # подписи таблицы посреди листа — не штамп
            inl = _inliers(labels, corner, form)
            if (
                src == "labels"
            ):  # уточнение: медиана оценок по всем подписям, попавшим в ячейки
                ests = [_estimate(p, r, form) for p, r in inl]
                corner = (
                    statistics.median(e[0] for e in ests),
                    statistics.median(e[1] for e in ests),
                )
                inl = _inliers(labels, corner, form)
            out.append(_Cand(_weight(inl), len(inl), RANK[src], form, corner, src))
    return out


def _pick(cands: list[_Cand]) -> tuple[_Cand, bool]:
    """Лучшая гипотеза и признак ничьей (другая форма объясняет подписи так же хорошо и тем же способом).

    Векторная рамка, подтверждённая подписью правой части, важнее подписей: сдвинутый по подписям угол подгоняет
    под сетку чужой формы строки левой части, которые у организаций гуляют. Подписи перевешивают рамку, только если
    объясняют заметно больше (FIXED_SHARE). Поле ГОСТ так не держится: это догадка, а не найденная линия.
    """
    top = max(c.score for c in cands)
    vector = [
        c for c in cands if c.src == "vector" and c.n >= MIN_LABELS and c.score > c.n
    ]
    if vector and max(c.score for c in vector) >= FIXED_SHARE * top:
        cands = vector
    best = max(cands, key=lambda c: (c.score, c.rank))
    rival = any(
        c.form is not best.form and c.score == best.score and c.rank == best.rank
        for c in cands
    )
    return best, rival


# ─────────────────────────────────────────────── чтение граф


def _join(ws: list[Word], wmm: float, hmm: float) -> str:
    """Слова ячейки в порядке чтения: строки сверху вниз (центры ближе LINE_MM — одна строка), в строке слева направо."""
    rows: list[list[Word]] = []
    for w in sorted(ws, key=lambda w: _center(w.bbox, wmm, hmm)[1]):
        y = _center(w.bbox, wmm, hmm)[1]
        if rows and y - _center(rows[-1][0].bbox, wmm, hmm)[1] < LINE_MM:
            rows[-1].append(w)
        else:
            rows.append([w])
    return " ".join(
        w.text for row in rows for w in sorted(row, key=lambda w: w.bbox[0])
    )


def _union(bs: list[BBox]) -> BBox:
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


def _to_frac(r: Rect, origin: tuple[float, float], wmm: float, hmm: float) -> BBox:
    ox, oy = origin
    return ((ox + r[0]) / wmm, (oy + r[1]) / hmm, (ox + r[2]) / wmm, (oy + r[3]) / hmm)


def _cell_words(words, r: Rect, origin, wmm, hmm) -> list[Word]:
    ox, oy = origin
    out = []
    for w in words:
        cx, cy = _center(w.bbox, wmm, hmm)
        if _inside((cx - ox, cy - oy), r) and not _is_label(w.text):
            out.append(w)
    return out


def norm_stage(s: str | None) -> str | None:
    """Графа 6: латинская «P» и кириллическая «Р» неразличимы на листе — приводим к кириллице."""
    t = (s or "").strip().upper().translate(str.maketrans({"P": "Р", "I": "И"}))
    return t or None


SHEET_RE = re.compile(r"\s*\d{1,4}(?:\.\d{1,2}|[а-яa-z])?\s*")  # номер листа: «3», «1.1», «2а» (T-178, IDN-06)


def is_sheet_no(s: str | None) -> bool:
    return bool(SHEET_RE.fullmatch(s or ""))


def _int(s: str | None) -> int | None:
    m = re.fullmatch(r"\s*(\d{1,4})\s*", s or "")
    return int(m.group(1)) if m else None


def _read(
    form: Form,
    corner,
    src: str,
    words,
    wmm,
    hmm,
    *,
    confirmed: bool = False,
    frame: BBox | None = None,
) -> TitleBlock:
    """confirmed — угол подтверждён подписями граф: уверенность как у векторной рамки."""
    origin = _origin(corner, form)
    base = CONF["labels"] if confirmed else CONF[src]
    fields: dict[str, Field] = {}
    for name, (graph, rect) in form.fields.items():
        ws = _cell_words(words, rect, origin, wmm, hmm)
        confs = [w.conf / 100 for w in ws if w.conf is not None]
        fields[name] = Field(
            graph=graph,
            value=_join(ws, wmm, hmm) if ws else None,
            bbox=_union([w.bbox for w in ws])
            if ws
            else _to_frac(rect, origin, wmm, hmm),
            confidence=base * (statistics.fmean(confs) if confs else 1.0),
        )
    changes = []
    for i in range(form.change_rows):
        row = {}
        for key, x0, x1 in CHANGE_COLS:
            ws = _cell_words(words, (x0, 5 * i, x1, 5 * i + 5), origin, wmm, hmm)
            if ws:
                row[key] = _join(ws, wmm, hmm)
        if row.get("izm"):
            changes.append(row)
    tb = TitleBlock(
        form=form.number,
        fields=fields,
        frame_bbox=frame or (0.0, 0.0, corner[0] / wmm, corner[1] / hmm),
        corner_source=src,
        sheet_format=sheet_format(wmm, hmm),
        changes=changes,
    )
    _validate(tb)
    return tb


def _downgrade(f: Field) -> None:
    f.confidence *= 0.5


def _validate(tb: TitleBlock) -> None:
    code = tb.fields["code"]
    if code.value and not CODE_RE.match(code.value):
        # в графу 1 организации дописывают «Заказчик: …» — шифр берём самым длинным похожим словом
        tokens = [t.strip("«»\"',;:()") for t in code.value.split()]
        tokens = [t for t in tokens if CODE_RE.match(t)]
        if tokens:
            best = max(tokens, key=len)
            tb.warnings.append(
                f"графа 1: шифр «{best}» выделен из строки «{code.value}»"
            )
            code.value = best
        else:
            tb.warnings.append(
                f"графа 1: «{code.value}» не похоже на обозначение документа"
            )
        _downgrade(code)
    stage = tb.fields.get("stage")
    if stage and stage.value:
        st = norm_stage(stage.value)
        if st in STAGES:
            stage.value = st
        else:
            tb.warnings.append(
                f"графа 6: стадия «{stage.value}» вне перечня ГОСТ (П, Р, И)"
            )
            _downgrade(stage)
    for f, ok in ((tb.fields.get("sheet"), is_sheet_no), (tb.fields.get("sheets"), lambda v: _int(v) is not None)):
        if f and f.value and not ok(f.value):
            tb.warnings.append(f"графа {f.graph}: «{f.value}» — не номер листа")
            _downgrade(f)
    n, total = _int(tb.value("sheet")), _int(tb.value("sheets"))
    if n is not None and total is not None and n > total:
        tb.warnings.append(f"лист {n} больше числа листов {total}")
        _downgrade(tb.fields["sheet"])


def _plausible(tb: TitleBlock) -> int:
    """Сколько значений по сетке ГОСТ прошло проверку: шифр, стадия, лист."""
    code = tb.value("code")
    return sum(
        [
            bool(code and CODE_RE.match(code)),
            tb.value("stage") in STAGES,
            is_sheet_no(tb.value("sheet")),
        ]
    )


def detect(
    page: Page, *, frame: BBox | None = None, registry: list[str] | None = None
) -> Detection:
    """Найти и прочитать основную надпись. frame — рамка листа в долях (из векторов), если известна.
    registry — шифры реестра файлов: гомоглифы в графе 1 исправляются по нему (cipher.fix_code)."""
    if not page.width or not page.height:
        return Detection(None, NO_GEOMETRY)
    wmm, hmm = page_mm(page)
    if wmm < WIDTH + MARGIN or hmm < FORM5.height + MARGIN:
        return Detection(None, TOO_SMALL)
    words = _words(page)
    if not words:
        return Detection(None, NO_WORDS)
    labels = _labels(words, wmm, hmm)
    hint = (frame[2] * wmm, frame[3] * hmm) if frame else None
    default = (wmm - MARGIN, hmm - MARGIN)
    best, rival = _pick(_candidates(labels, hint, default, (wmm, hmm)))
    if best.n >= MIN_LABELS:
        if rival:
            return Detection(None, LABELS_AMBIGUOUS)
        tb = _read(
            best.form,
            best.corner,
            best.src,
            words,
            wmm,
            hmm,
            confirmed=True,
            frame=frame if best.src == "vector" else None,
        )
    else:
        # подписей нет (или одна): надпись принимается, только если значения по сетке ГОСТ правдоподобны
        corner, src = (hint, "vector") if hint else (default, "default")
        reads = sorted(
            (
                (_plausible(t), t)
                for t in (
                    _read(f, corner, src, words, wmm, hmm, frame=frame) for f in FORMS
                )
            ),
            key=lambda x: -x[0],
        )
        if reads[0][0] < 2:
            return Detection(None, NOT_FOUND)
        if reads[0][0] == reads[1][0]:
            return Detection(None, VALUES_AMBIGUOUS)
        tb = reads[0][1]
        tb.warnings.append(
            "подписи граф не найдены — угол рамки взят "
            + ("по векторной рамке" if hint else "по полю листа ГОСТ")
        )
    code = tb.fields["code"]
    if registry and code.value:
        fix = fix_code(code.value, registry)
        if fix.corrected:
            tb.warnings.append(
                f"графа 1: шифр «{fix.read}» исправлен по реестру на «{fix.value}»"
            )
            code.value = fix.value
    return Detection(tb, None)


def read_title_block(
    page: Page, *, frame: BBox | None = None, registry: list[str] | None = None
) -> TitleBlock | None:
    """Основная надпись листа или None — надпись нестандартная или её нет (причина — detect())."""
    return detect(page, frame=frame, registry=registry).block


# ─────────────────────────────────────────────── связка с реестром


@dataclass(frozen=True)
class Mismatch:
    kind: str  # code | code_homoglyph | stage | revision | sheet_count
    stamp: str | None
    registry: str | None
    message: str


def code_key(code: str) -> str:
    """Ключ шифра для связки: похожие знаки (cipher.canon) и «/» → «-»: в имени файла «/» быть не может."""
    return canon(code).replace("/", "-")


def _max_change(tb: TitleBlock) -> int | None:
    nums = [n for n in (_int(c.get("izm")) for c in tb.changes) if n is not None]
    return max(nums) if nums else None


def compare_registry(
    tb: TitleBlock,
    *,
    document_code: str,
    doc_stage: str | None = None,
    revision: str | None = None,
) -> list[Mismatch]:
    """Штамп против метаданных файла из реестра (document_code, doc_stage PD|RD|ID, revision).

    Шифры сравниваются по code_key — похожие знаки и «/» вместо «-» не расхождение, а отметка. Шифр штампа длиннее
    реестрового на суффикс листа («СК2-Р-АР.3») — совпадение. Редакция: расхождение, только если в таблице
    изменений штампа номер изменения больше номера редакции реестра — нумерация «с 0» или «с 1» у разных
    организаций разная, и меньший номер в штампе ничего не доказывает.
    """
    out: list[Mismatch] = []
    read = tb.value("code")
    if not read:
        out.append(
            Mismatch(
                "code",
                None,
                document_code,
                "графа 1 пуста — шифр со штампа не прочитан",
            )
        )
    else:
        a, b = code_key(read), code_key(document_code)
        if a == b:
            if read != document_code:
                out.append(
                    Mismatch(
                        "code_homoglyph",
                        read,
                        document_code,
                        "шифр совпал после приведения похожих знаков",
                    )
                )
        elif not re.match(re.escape(b) + r"[-.]", a):
            out.append(
                Mismatch(
                    "code",
                    read,
                    document_code,
                    f"шифр штампа «{read}» ≠ реестр «{document_code}»",
                )
            )
    want = REGISTRY_STAGE.get(doc_stage)
    got = norm_stage(tb.value("stage"))
    if want and got and got != want:
        out.append(
            Mismatch(
                "stage",
                got,
                want,
                f"стадия штампа «{got}» ≠ реестр «{want}» ({doc_stage})",
            )
        )
    rev, izm = _int(revision), _max_change(tb)
    if rev is not None and izm is not None and izm > rev:
        out.append(
            Mismatch(
                "revision",
                str(izm),
                revision,
                f"в штампе изменение {izm}, в реестре редакция {revision}",
            )
        )
    n, total = _int(tb.value("sheet")), _int(tb.value("sheets"))
    if n is not None and total is not None and n > total:
        out.append(
            Mismatch(
                "sheet_count",
                f"{n}/{total}",
                None,
                f"лист {n} больше числа листов {total}",
            )
        )
    return out


# ─────────────────────────────────────────────── векторная рамка (необязательно)


def frame_from_boxes(boxes: list[BBox], wmm: float, hmm: float) -> BBox | None:
    """Внутренняя рамка по рамкам векторных путей (доли страницы).

    Линия — путь толщиной < 2 мм и длиной ≥ 30 % стороны листа; замкнутый контур больше половины листа по обеим
    сторонам даёт все четыре стороны. Сторона рамки — ближайшая к краю линия не ближе 2 мм (обрезка листа) и не
    дальше MAX_MARGIN. Правой или нижней стороны нет — рамки нет; левой или верхней нет — рамка до края листа.
    """
    xs: list[float] = []
    ys: list[float] = []
    for b in boxes:
        bw, bh = (b[2] - b[0]) * wmm, (b[3] - b[1]) * hmm
        if bh >= 0.3 * hmm and bw < 2:
            xs.append((b[0] + b[2]) / 2)
        elif bw >= 0.3 * wmm and bh < 2:
            ys.append((b[1] + b[3]) / 2)
        elif bw >= 0.5 * wmm and bh >= 0.5 * hmm:
            xs += [b[0], b[2]]
            ys += [b[1], b[3]]
    right = [x for x in xs if 2 <= (1 - x) * wmm <= MAX_MARGIN]
    bottom = [y for y in ys if 2 <= (1 - y) * hmm <= MAX_MARGIN]
    if not right or not bottom:
        return None
    left = [x for x in xs if 2 <= x * wmm <= MAX_MARGIN]
    top = [y for y in ys if 2 <= y * hmm <= MAX_MARGIN]
    return (min(left, default=0.0), min(top, default=0.0), max(right), max(bottom))


def frame_from_pdf(pdf_page, max_objects: int = 50_000) -> BBox | None:
    """Внутренняя рамка по векторным путям страницы pypdfium2 (вызывать под parse.PDFIUM_LOCK).
    Страница тяжелее max_objects путей — берутся первые max_objects (рамку CAD рисует в начале)."""
    import pypdfium2.raw as pdfium_c

    from .parse import norm_box

    boxes = []
    for obj in pdf_page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_PATH], max_depth=2):
        if len(boxes) >= max_objects:
            break
        boxes.append(norm_box(pdf_page, *obj.get_bounds()))
    return frame_from_boxes(
        boxes, pdf_page.get_width() * PT_MM, pdf_page.get_height() * PT_MM
    )
