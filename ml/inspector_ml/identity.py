"""L1 — идентификация листа, документа и редакции (T-178; каталог TO-BE §5: IDN-02, IDN-03, IDN-10, IDN-12).

Поверх `titleblock` (T-127: поиск основной надписи ГОСТ Р 21.101 и чтение граф) и `ParsedDoc` — формат разбора
не меняется (ADR-0008 п. 5). Только текстовый слой и слова с рамками: артефакты конкретного OCR (уверенность слова
Tesseract, флаг `disputed`) здесь не используются. OCR полей штампа на сканах — T-151, здесь не дублируется.

Интерфейс для потребителей (T-177 CMP-29 и VER-03, T-175 M-007, T-179 MUT-18):

    read_identity(page, frame=None, registry=None) -> StampIdentity     # IDN-02 + IDN-03 одного листа
    doc_identity(doc, registry=None) -> DocIdentity                     # сводка штампов документа
    parse_change(row) -> ChangeRow | None                               # IDN-03 одна строка таблицы изменений
    revision_status(entries) -> dict[file_id, RevisionVerdict]          # VER-03 / MUT-18 по реестру и штампам
    floor_mentions(doc) / building_floors(doc) -> FloorCount            # IDN-10 этажность из заглавных листов
    sheet_floor(title) -> SheetFloor                                    # IDN-10 этаж листа по наименованию

`StampIdentity.revision` — наибольший номер «Изм.» таблицы изменений листа; это то же, что `stamp_change` в
verify-l8.ts (T-177). `DocIdentity.revision` — наибольший по листам документа.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Literal

from pydantic import BaseModel

from .class_mentions import _bbox, page_text
from .model import BBox, Page, ParsedDoc
from .normalize import fold as _fold
from .titleblock import code_key, detect

STAGE_DOC = {
    "П": "PD",
    "Р": "RD",
}  # графа 6 → стадия документа; «И» (изыскания) стадией ПД/РД не является
MAX_PAGES = 2000  # листов на документ для сводки штампов (правило №0: время растёт с числом листов)
MAX_SHEET_RANGE = (
    200  # «3-5» в графе «Лист» изменения раскрывается, пока диапазон не длиннее
)
TITLE_PAGES = 5  # заглавные листы: первые страницы документа…
TITLE_WORDS = (
    "общие данные",
    "пояснительная записка",
    "титульный лист",
    "технико экономические показатели",
)
EFFECTIVE = {"APPROVED", "FOR_CONSTRUCTION"}
STALE = {"SUPERSEDED", "CANCELLED"}

TITLE_MAX = 500  # наименование листа длиннее — хвост не читается (SEC-T178-02)
MAX_SHEETS_EXPANDED = 500  # листов из раскрытых диапазонов на строку изменений (SEC-T178-06)
MAX_FLOOR_MENTIONS = 50  # упоминаний этажности на шаблон и страницу (SEC-T178-05)
QUOTE_MAX = 160


def fold(s: str) -> str:
    """normalize.fold и одна серия пробелов вместо многих: пунктуация-заполнитель («......») не даёт регуляркам
    с соседними \\s* полиномиального перебора (SEC-T178-02)."""
    return re.sub(r"\s+", " ", _fold(s))


_INT = re.compile(r"(?<!\d)(\d{1,3})(?!\d)")


class StampField(BaseModel):
    graph: int
    value: str | None
    bbox: BBox
    confidence: float


class ChangeRow(BaseModel):
    """Строка таблицы изменений основной надписи (графы 14–19)."""

    izm: int
    kol_uch: int | None = None  # количество изменённых участков
    action: Literal["Зам.", "Нов.", "Аннул."] | None = (
        None  # вид изменения вместо числа участков
    )
    sheets: list[str] = []  # листы изменения; «Все» → ["*"]
    doc_no: str | None = None
    date: str | None = (
        None  # ISO: yyyy-mm или yyyy-mm-dd; нераспознанная — как написана
    )
    raw: dict[str, str] = {}


class StampIdentity(BaseModel):
    page: int
    form: int | None = None
    code: str | None = None
    stage: str | None = None  # П | Р | И
    doc_stage: str | None = None  # PD | RD
    sheet: str | None = None  # «3», «2а», «1.1»
    sheets: int | None = None
    sheet_title: str | None = None
    revision: int | None = (
        None  # наибольший номер изменения; None — строк изменений нет
    )
    changes: list[ChangeRow] = []
    fields: dict[str, StampField] = {}
    frame_bbox: BBox | None = None
    warnings: list[str] = []
    reason: str | None = None  # почему штамп не прочитан; None — прочитан

    @property
    def ok(self) -> bool:
        return self.reason is None


class Disagreement(BaseModel):
    field: str
    values: dict[str, list[int]]  # значение → листы


class DocIdentity(BaseModel):
    code: str | None = None
    stage: str | None = None
    doc_stage: str | None = None
    revision: int | None = None
    sheet_map: dict[
        int, str
    ] = {}  # страница PDF → номер листа по графе «Лист» (IDN-06)
    pages: list[StampIdentity] = []
    disagreements: list[Disagreement] = []
    read: int = 0  # листов с прочитанным штампом


# ─────────────────────────────────────────────── IDN-03 строка таблицы изменений

_ACTIONS = (("зам", "Зам."), ("нов", "Нов."), ("аннул", "Аннул."))


def _date(s: str) -> str:
    t = s.strip()
    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})", t)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if 1 <= d <= 31 and 1 <= mo <= 12:
            return f"{_year(y)}-{mo:02d}-{d:02d}"
    m = re.fullmatch(r"(\d{1,2})\.(\d{2}|\d{4})", t)
    if m and 1 <= int(m.group(1)) <= 12:
        return f"{_year(m.group(2))}-{int(m.group(1)):02d}"
    return t


def _year(y: str) -> str:
    return y if len(y) == 4 else f"20{y}"


def _sheets(s: str) -> list[str]:
    out: list[str] = []
    for part in re.split(r"[,;]\s*|\s+", s.strip()):
        if not part:
            continue
        if fold(part).startswith("все"):
            out.append("*")
            continue
        m = re.fullmatch(r"(\d{1,4})[-–—](\d{1,4})", part)
        if m and 0 <= int(m.group(2)) - int(m.group(1)) <= MAX_SHEET_RANGE and len(out) + int(m.group(2)) - int(m.group(1)) < MAX_SHEETS_EXPANDED:
            out += [str(i) for i in range(int(m.group(1)), int(m.group(2)) + 1)]
        else:
            out.append(part)
    return out


def parse_change(row: dict[str, str]) -> ChangeRow | None:
    """Строка изменений из titleblock.TitleBlock.changes → ChangeRow; без номера изменения — None."""
    m = _INT.search(row.get("izm", ""))
    if not m or int(m.group(1)) == 0 and not row.get("doc_no"):
        return None
    kol = (row.get("kol_uch") or "").strip()
    action = next((a for key, a in _ACTIONS if fold(kol).startswith(key)), None)
    km = re.fullmatch(r"\d{1,3}", kol)
    return ChangeRow(
        izm=int(m.group(1)),
        kol_uch=int(kol) if km else None,
        action=action,
        sheets=_sheets(row.get("sheet", "")),
        doc_no=(row.get("doc_no") or "").strip() or None,
        date=_date(row["date"]) if row.get("date") else None,
        raw=dict(row),
    )


# ─────────────────────────────────────────────── IDN-02 поля штампа листа


def read_identity(
    page: Page, *, frame: BBox | None = None, registry: list[str] | None = None
) -> StampIdentity:
    """Шифр, стадия, лист, листов, наименование листа и таблица изменений основной надписи одного листа."""
    if page.source == "structured":
        return StampIdentity(
            page=page.page, reason="у структурированного документа нет листа со штампом"
        )
    det = detect(page, frame=frame, registry=registry)
    tb = det.block
    if tb is None:
        return StampIdentity(page=page.page, reason=det.reason)
    changes = [c for c in (parse_change(r) for r in tb.changes) if c is not None]
    stage = tb.value("stage")
    sheets = tb.value("sheets")
    return StampIdentity(
        page=page.page,
        form=tb.form,
        code=tb.value("code"),
        stage=stage,
        doc_stage=STAGE_DOC.get(stage or ""),
        sheet=(tb.value("sheet") or "").strip() or None,
        sheets=int(sheets) if sheets and re.fullmatch(r"\s*\d{1,4}\s*", sheets) else None,
        sheet_title=tb.value("sheet_title") or tb.value("doc_title"),
        revision=max((c.izm for c in changes), default=None),
        changes=changes,
        fields={
            k: StampField(
                graph=f.graph,
                value=f.value,
                bbox=f.bbox,
                confidence=round(f.confidence, 3),
            )
            for k, f in tb.fields.items()
        },
        frame_bbox=tb.frame_bbox,
        warnings=list(tb.warnings),
    )


def _majority(values: dict[str, list[int]]) -> str | None:
    if not values:
        return None
    return max(values.items(), key=lambda kv: (len(kv[1]), -min(kv[1])))[0]


def _safe_identity(page: Page, frame: BBox | None, registry: list[str] | None) -> StampIdentity:
    """Сбой разбора одного листа не роняет сводку документа (SEC-T178-03): лист получает причину воздержания."""
    try:
        return read_identity(page, frame=frame, registry=registry)
    except (ValueError, IndexError) as e:
        return StampIdentity(page=page.page, reason=f"штамп не разобран: {type(e).__name__}")


def doc_identity(
    doc: ParsedDoc,
    *,
    registry: list[str] | None = None,
    frames: dict[int, BBox] | None = None,
) -> DocIdentity:
    """Сводка штампов документа: шифр и стадия большинства листов, наибольшая редакция, лист ↔ страница.
    Листы расходятся в шифре или стадии — расхождение сохраняется с номерами листов, значение — большинства."""
    frames = frames or {}
    ids = [_safe_identity(p, frames.get(p.page), registry) for p in doc.pages[:MAX_PAGES]]
    ok = [i for i in ids if i.ok]
    codes: dict[str, list[int]] = {}
    shown: dict[str, str] = {}
    stages: dict[str, list[int]] = {}
    for i in ok:
        if i.code:
            k = code_key(i.code)
            codes.setdefault(k, []).append(i.page)
            shown.setdefault(k, i.code)
        if i.stage:
            stages.setdefault(i.stage, []).append(i.page)
    dis = [
        Disagreement(
            field=f, values=v if f == "stage" else {shown[k]: p for k, p in v.items()}
        )
        for f, v in (("code", codes), ("stage", stages))
        if len(v) > 1
    ]
    key = _majority(codes)
    stage = _majority(stages)
    return DocIdentity(
        code=shown[key] if key else None,
        stage=stage,
        doc_stage=STAGE_DOC.get(stage or ""),
        revision=max((i.revision for i in ok if i.revision is not None), default=None),
        sheet_map={i.page: i.sheet for i in ok if i.sheet},
        pages=ids,
        disagreements=dis,
        read=len(ok),
    )


# ─────────────────────────────────────────────── VER-03 / MUT-18 статус редакции


class RevisionEvidence(BaseModel):
    file_id: str
    doc_stage: str | None
    code: str
    registry_revision: str | None = None
    approval_status: str | None = None
    stamp_revision: int | None = None  # DocIdentity.revision


class RevisionVerdict(BaseModel):
    status: Literal["CURRENT", "STALE", "REGISTRY_CONFLICT", "UNKNOWN"]
    reason: str
    newer: str | None = None  # file_id документа, который новее


def rev_no(s: str | None) -> int | None:
    """Номер редакции реестра: последнее число строки («2», «Изм.2», «ред. 3», «C02»)."""
    t = re.sub(r"\d{1,2}\.\d{1,2}\.\d{2,4}", " ", s or "")  # дата в поле редакции — не номер (SEC-T178-04)
    nums = re.findall(r"(?<!\d)\d{1,4}(?!\d)", t)
    return int(nums[-1]) if nums else None


def revision_status(entries: list[RevisionEvidence]) -> dict[str, RevisionVerdict]:
    """Статус редакции каждого документа среди документов того же шифра и стадии.

    STALE — статус SUPERSEDED/CANCELLED или в пакете есть более поздняя редакция по реестру или по штампу;
    REGISTRY_CONFLICT — реестр и штамп спорят: реестр не знает более поздней редакции, а штамп другого документа
    новее (подмена редакции, MUT-18), либо в штампе изменение с номером больше редакции реестра; такой документ не
    эталон; UNKNOWN — ни реестр, ни штамп номера не дали; CURRENT — иначе.
    """
    groups: dict[tuple[str | None, str], list[RevisionEvidence]] = {}
    for e in entries:
        groups.setdefault((e.doc_stage, code_key(e.code)), []).append(e)
    out: dict[str, RevisionVerdict] = {}
    for group in groups.values():
        for f in group:
            out[f.file_id] = _verdict(f, [g for g in group if g.file_id != f.file_id])
    return out


def _verdict(f: RevisionEvidence, others: list[RevisionEvidence]) -> RevisionVerdict:
    if (f.approval_status or "").strip().upper() in STALE:
        return RevisionVerdict(status="STALE", reason=f"статус {f.approval_status}")
    rf, sf = rev_no(f.registry_revision), f.stamp_revision
    for g in others:
        rg, sg = rev_no(g.registry_revision), g.stamp_revision
        reg_newer = rf is not None and rg is not None and rg > rf
        stamp_newer = sf is not None and sg is not None and sg > sf
        if reg_newer and sf is not None and sg is not None and sg < sf:
            return RevisionVerdict(
                status="REGISTRY_CONFLICT",
                newer=g.file_id,
                reason=f"по реестру новее ред. {g.registry_revision}, а по штампу новее этот документ (изм. {sf} против {sg})",
            )
        if stamp_newer and rf is not None and rg is not None and rg <= rf:
            return RevisionVerdict(
                status="REGISTRY_CONFLICT",
                newer=g.file_id,
                reason=f"реестр не знает более поздней редакции, а в штампе другого документа изм. {sg} при изм. {sf} у этого",
            )
        if reg_newer or stamp_newer:
            return RevisionVerdict(
                status="STALE",
                newer=g.file_id,
                reason=f"в пакете есть более поздняя ред. {g.registry_revision}",
            )
    if rf is not None and sf is not None and sf > rf:
        return RevisionVerdict(
            status="REGISTRY_CONFLICT",
            reason=f"в штампе изм. {sf}, в реестре ред. {f.registry_revision}",
        )
    if rf is None and sf is None:
        return RevisionVerdict(
            status="UNKNOWN", reason="нет номера редакции ни в реестре, ни в штампе"
        )
    return RevisionVerdict(
        status="CURRENT", reason="более поздней редакции в пакете нет"
    )


# ─────────────────────────────────────────────── IDN-10 этажность и этаж листа


class FloorMention(BaseModel):
    above: int | None  # надземных этажей (этажность, M-007)
    below: int | None = None  # подземных
    total: int | None = None  # количество этажей с подземными
    page: int
    bbox: BBox | None
    quote: str
    pattern: str
    excluded: str | None = None


class FloorCount(BaseModel):
    above: int | None
    below: int | None
    status: Literal["ok", "conflict", "none"]
    mentions: list[FloorMention]


_N = r"(\d{1,3})"
_BELOW = re.compile(
    r"(?:в\s+(?:том\s+числе|т\.\s?ч\.?)|включая)\s*[:,]?\s*"
    + _N
    + r"?\s*подземн\w{0,20}(?:\s+этаж\w{0,20})?\s*[:—–-]?\s*"
    + _N
    + r"?",
    re.I,
)
FLOOR_PATTERNS = (
    ("adjective", re.compile(r"(?<![\d.,])" + _N + r"\s*-?\s*(?:ти|х|и|ми)?\s*-?\s*этажн\w{0,20}", re.I)),
    (
        "etazhnost",
        re.compile(
            r"этажност\w{0,20}(?:\s+здания)?\s*[:—–-]?\s*" + _N + r"(?!\d|[.,]\d)", re.I
        ),
    ),
    (
        "count",
        re.compile(
            r"(?:количеств\w{0,20}|числ\w{0,20})\s+этажей\s*(?:\(\s*шт\.?\s*\)|,?\s*(?:шт|эт)\.?)?\s*[:—–-]?\s*"
            + _N
            + r"(?!\d|[.,]\d)",
            re.I,
        ),
    ),
)
_FLOOR_EXCLUDE = (
    ("constraint", re.compile(r"не\s+(?:более|выше|менее|ниже)\s*$|до\s*$", re.I)),
    ("existing", re.compile(r"существующ\w{0,20}|до\s+реконструкции", re.I)),
)


def _floor_excluded(text: str, start: int) -> str | None:
    before = text[max(0, start - 40) : start]
    for code, rx in _FLOOR_EXCLUDE:
        if rx.search(before):
            return code
    return None


def title_pages(doc: ParsedDoc) -> list[Page]:
    """Заглавные листы: первые TITLE_PAGES страниц и листы с «Общими данными», ПЗ, титулом, ТЭП в первых строках."""
    out = []
    for i, p in enumerate(doc.pages):
        head = fold(" ".join(ln.text for ln in p.lines[:8]))
        if i < TITLE_PAGES or any(w in head for w in TITLE_WORDS):
            out.append(p)
    return out


def floor_mentions(doc: ParsedDoc) -> list[FloorMention]:
    out: list[FloorMention] = []
    for p in title_pages(doc):
        text, spans = page_text(p)
        for name, rx in FLOOR_PATTERNS:
            for i, m in enumerate(rx.finditer(text)):
                if i >= MAX_FLOOR_MENTIONS:
                    break
                n = int(m.group(1))
                if not 1 <= n <= 150:
                    continue
                tail = text[m.end() : m.end() + 60]
                b = _BELOW.match(tail.lstrip(" ,(;"))
                below = next((int(x) for x in (b.groups() if b else ()) if x), None)
                total = n if name == "count" else None
                above = (
                    n - below
                    if name == "count" and below is not None and below < n
                    else n
                )
                end = m.end() + (
                    len(tail) - len(tail.lstrip(" ,(;")) + b.end() if b else 0
                )
                out.append(
                    FloorMention(
                        above=above,
                        below=below,
                        total=total,
                        page=p.page,
                        bbox=_bbox(spans, m.start(1), m.end(1)),
                        quote=text[max(0, m.start() - 30) : end + 10].strip()[:QUOTE_MAX],
                        pattern=name,
                        excluded=_floor_excluded(text, m.start()),
                    )
                )
    return out


def building_floors(doc: ParsedDoc) -> FloorCount:
    """Этажность здания по заглавным листам. Разные значения — расхождение: значение не выбирается."""
    ms = floor_mentions(doc)
    kept = [m for m in ms if m.excluded is None]
    above = {m.above for m in kept}
    below = {m.below for m in kept if m.below is not None}
    if not kept:
        return FloorCount(above=None, below=None, status="none", mentions=ms)
    if len(above) > 1 or len(below) > 1:
        return FloorCount(above=None, below=None, status="conflict", mentions=ms)
    return FloorCount(
        above=above.pop(),
        below=below.pop() if below else None,
        status="ok",
        mentions=ms,
    )


class SheetFloor(BaseModel):
    kind: Literal["floor", "typical", "basement", "technical", "roof"] | None = None
    floor: int | None = None
    floors: tuple[int, int] | None = None  # типовой этаж «2-9»
    elevation: float | None = None  # «на отм. +3.300»
    section: str | None = None


_ELEV = re.compile(r"отм\w{0,20}\.?\s*([+\-−±]?\s?\d{1,3}[.,]\d{3})")
_SECTION = re.compile(r"секци\w{0,20}\s*№?\s*(\d{1,2}[а-я]?)", re.I)


def sheet_floor(title: str | None) -> SheetFloor:
    """Этаж, отметка и секция листа по наименованию («План 3 этажа», «План типового этажа 2-9», «на отм. +3.300»)."""
    raw = (title or "")[:TITLE_MAX]
    t = fold(raw)
    out = SheetFloor()
    em = _ELEV.search(raw)
    if em:
        out.elevation = float(
            re.sub(r"\s", "", em.group(1))
            .replace("−", "-")
            .replace("±", "")
            .replace(",", ".")
        )
    sm = _SECTION.search(raw)
    if sm:
        out.section = sm.group(1)
    if m := re.search(r"типов\w{0,20} этаж\w{0,20}\s*(\d{1,3})\s*(\d{1,3})?", t):
        out.kind = "typical"
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        out.floors = (min(a, b), max(a, b))
    elif m := re.search(
        r"(\d{1,3})\s*(?:го|й|ого)?\s*(?:[-\s]\s*(\d{1,3})\s*(?:го|й)?\s*)?этаж", t
    ):
        a, b = int(m.group(1)), m.group(2)
        out.kind = "typical" if b else "floor"
        if b:
            out.floors = (min(a, int(b)), max(a, int(b)))
        else:
            out.floor = a
    elif re.search(r"подвал|подземн\w{0,20} (?:этаж|парк)|цокол", t):
        out.kind = "basement"
    elif re.search(r"техническ\w{0,20} (?:этаж|подполь)|чердак", t):
        out.kind = "technical"
    elif re.search(r"кровл|покрыти", t):
        out.kind = "roof"
    return out
