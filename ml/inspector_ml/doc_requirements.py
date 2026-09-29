"""Узлы временного расчленения: сечения элементов, акт монтажа и его реквизиты (OS-INSP-2.2.150–2.2.151, T-213; М-096).

Каждая находка — упоминание с `meta.kind`:
- `doc` — документ ИД из перечня паспорта (`docs`: id и оборот), первое упоминание в файле; отрицание сразу после
  («Акты на временные конструкции — отсутствуют») документом не считается. Отсутствие ML не записывает: вывод
  «документа нет» делает API по всей стадии ИД (MISSING_EVIDENCE, не нарушение);
- `requisite_gap` — в документе с актом поле реквизита пустое («проектировщик — ___», «Ссылка на проект: —»);
- `act_date` / `work_date` — дата акта и дата работ из журнала по одному узлу («Р-3»): акт раньше работ — нарушение
  порядка дат ИД (CMP-22);
- `section` — обозначение профиля элемента расчленения: двутавр «20Б1», «дв. 25Б1», «I20»; швеллер «[16П»; уголок
  «L100x8»; труба «труба 159×6», «тр.159x6». Берётся, только если во фразе есть элемент временного крепления
  (подкос, стойка, рама, распорка, подпорка, раскрепление, узел «Р-1», марка «ПК-1») или временный узел назван
  раньше в документе; `excluded` — элемент котлована или шпунта (другой элемент, не сохраняемая конструкция);
- `section_unreadable` — профиль с нечитаемой цифрой OCR («тр. 1?9х6»): сравнить нельзя;
- `not_applicable` — сохраняемых конструкций нет («сносится полностью», «сохраняемых конструкций нет»).

Конфигурация — паспорт параметра (`ParamSpec.extractor`, docs — из value), код от параметра не зависит.
"""

from __future__ import annotations

import re

from .class_mentions import _bbox, page_text
from .model import Extraction, ParamSpec, ParsedDoc

KIND = "doc_requirements"
OPS_DOC = ["ENT-22"]
OPS_SECTION = ["ENT-17", "NRM-01"]
QUOTE = 160  # знаков цитаты документа

X = r"\s*[xхХ×*]\s*"
N = r"(\d{1,3}(?:[.,]\d)?)"
# вид профиля → шаблон; группы — размеры по порядку. Порядок важен: «уголок» раньше голой «L».
PROFILES: list[tuple[str, str, re.Pattern[str]]] = [
    (
        "angle",
        "уголок",
        re.compile(rf"(?:уголк\w{{0,20}}|уголок|(?<![А-Яа-яA-Za-z])[L∟])\s*{N}{X}{N}", re.I),
    ),
    (
        "pipe",
        "труба",
        re.compile(
            rf"(?:труб\w{{0,20}}|(?<![А-Яа-я])тр\.?)\s*(?:[ØøФф]|d|D)?\s*{N}{X}{N}", re.I
        ),
    ),
    (
        "ibeam",
        "двутавр",
        re.compile(
            r"(?:двутавр\w{0,20}\s*(?:№\s*)?|(?<![А-Яа-я])дв\.\s*|(?<![А-Яа-яA-Za-z0-9])I\s*)(\d{1,3})\s*([БКШ]\d?)?(?!\d)(?![.,]\d)",
            re.I,
        ),
    ),
    (
        "channel",
        "швеллер",
        re.compile(
            r"(?:швеллер\w{0,20}\s*(?:№\s*)?|\[\s*)(\d{1,2})\s*([ПУ])?(?!\d)(?![.,]\d)", re.I
        ),
    ),
]
UNREADABLE = re.compile(
    rf"(?:труб\w{{0,20}}|(?<![А-Яа-я])тр\.?|двутавр\w{{0,20}}|(?<![А-Яа-я])дв\.|уголк\w{{0,20}}|швеллер\w{{0,20}})\s*[\dO?]*\?[\dO?]*(?:{X}[\d?]+)?",
    re.I,
)
ELEMENT = re.compile(
    r"подкос|стойк|стоек|рам[аыуе]?(?![а-яё])|распорк|подпор|раскреплен|расчленен|временн\w{0,20}\s+(?:креплен|конструкц|опор)|(?<![А-Яа-я])(?:ПК|Р)-\d",
    re.I,
)
OTHER = re.compile(r"котлован|шпунт|ограждени\w{0,20}\s+котлован", re.I)
NOT_APPLICABLE = re.compile(
    r"сохраняем\w{0,20}\s+конструкц\w{0,20}\s+нет|нет\s+сохраняем\w{0,20}|снос\w{0,20}\s+полностью|полн\w{0,20}\s+снос|без\s+сохранени",
    re.I,
)
MAX_TEXT = 20000  # знаков страницы: длиннее — обрезается до разбора (W3-02)
MAX_OUT = 2000  # находок на документ (W3-06)
# ссылка или требование вместо документа: «см. акт …», «акт … оформляется по форме» (W3-11)
REFERENCE_BEFORE = re.compile(r"(?:см\.?|согласно|в\s+соответствии\s+с|по\s+форме|форма)\s*$", re.I)
REFERENCE_AFTER = re.compile(r"^[^.]{0,40}?(?:оформля|составля|следует|должн|предусматрива|приложени|прилагает)", re.I)
NEGATION = re.compile(
    r"^[^.]{0,40}?(?:отсутств|не\s+(?:представл|оформл|предъявл|составл|проводил|выполнял|передан|предоставл)|нет(?![а-яё]))",
    re.I,
)
GAP = re.compile(
    r"(проектировщик\w{0,20}|авторск\w{0,20}\s+надзор\w{0,20}|застройщик\w{0,20}|подрядчик\w{0,20}|технадзор\w{0,20}|ссылк\w{0,20}\s+на\s+проект\w{0,20}|документ\w{0,20}\s+качеств\w{0,20})\s*[:—–-]\s*(?:_+|[—–-])?\s*(?=[.;,]|$)",
    re.I,
)
DATE = r"(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?"
NODE = re.compile(r"(?<![А-Яа-яA-Za-z])[РP]-(\d+)")


def is_doc_requirements(spec: ParamSpec) -> bool:
    return bool(spec.extractor) and spec.extractor.get("kind") == KIND


def _num(s: str) -> float:
    return float(s.replace(",", "."))


def sections_in(text: str) -> list[tuple[str, list[float], str, int, int]]:
    """Профили в тексте: (вид, размеры, подпись, начало, конец). Совпадения видов не перекрываются."""
    out: list[tuple[str, list[float], str, int, int]] = []
    taken: list[tuple[int, int]] = []
    for kind, ru, rx in PROFILES:
        for m in rx.finditer(text):
            if any(s < m.end() and m.start() < e for s, e in taken):
                continue
            if kind in ("angle", "pipe"):
                dims = [_num(m.group(1)), _num(m.group(2))]
                label = f"{ru} {m.group(1)}×{m.group(2)}"
            else:
                dims = [_num(m.group(1))]
                label = f"{ru} {m.group(1)}{(m.group(2) or '').upper()}"
            taken.append((m.start(), m.end()))
            out.append((kind, dims, label, m.start(), m.end()))
    return sorted(out, key=lambda x: x[3])


def _sentences(text: str) -> list[tuple[int, int]]:
    """Границы фраз: точка перед заглавной или строка таблицы. Даты «12.03.» фразу не рвут."""
    out, start = [], 0
    for m in re.finditer(r"(?<=[.!?])\s+(?=[А-ЯЁA-Z])", text):
        out.append((start, m.start()))
        start = m.end()
    out.append((start, len(text)))
    return out


def _mmdd(m: re.Match[str]) -> str:
    y = m.group(3)
    year = "" if not y else str(int(y) + (2000 if len(y) == 2 else 0))
    return f"{year}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"


def extract_doc_requirements(doc: ParsedDoc, spec: ParamSpec) -> list[Extraction]:
    cfg = spec.extractor or {}
    docs = [(d["id"], re.compile(d["pattern"], re.I)) for d in cfg.get("docs") or []]
    out: list[Extraction] = []
    seen_docs: set[str] = set()
    element_seen = False  # временный узел уже назван в документе: строки спецификации ниже — его элементы

    def add(
        page, spans, s, e, conf, value_text, meta, value_num=None, raw=None, quote=None
    ):
        if len(out) >= MAX_OUT:
            return
        q = (quote if quote is not None else raw or "")[:QUOTE]
        raw = (raw or "")[:QUOTE]
        value_text = value_text[:200] if isinstance(value_text, str) else value_text
        out.append(
            Extraction(
                code=spec.code,
                raw=raw or "",
                value_num=value_num,
                value_text=value_text,
                page=page.page,
                bbox=_bbox(spans, s, e),
                line_text=q or "",
                confidence=conf,
                meta={**meta, "quote": q or ""},
            )
        )

    for page in doc.pages:
        text, spans = page_text(page)
        text = text[:MAX_TEXT]
        conf = (
            1.0 if page.source != "ocr" else round((page.ocr_confidence or 50) / 100, 3)
        )
        act_page = False
        for did, rx in docs:
            if did in seen_docs:
                continue
            for m in rx.finditer(text):
                before, after = text[max(0, m.start() - 30) : m.start()], text[m.end() : m.end() + 60]
                if NEGATION.search(after) or re.search(r"(?:нет|без|отсутству\w{0,5})\s*$", before, re.I):
                    continue  # «Акты на временные конструкции — отсутствуют», «нет акта …»
                if REFERENCE_BEFORE.search(before) or REFERENCE_AFTER.search(after):
                    continue  # ссылка или требование («см. акт …», «акт … оформляется»), а не сам документ
                seen_docs.add(did)
                act_page = True
                quote = text[
                    m.start() : min(len(text), max(m.end(), m.start() + QUOTE))
                ].strip()
                add(
                    page,
                    spans,
                    m.start(),
                    m.end(),
                    conf,
                    did,
                    {"kind": "doc", "doc": did, "ops": list(OPS_DOC)},
                    raw=m.group(0),
                    quote=quote,
                )
                break
        if act_page:
            for m in GAP.finditer(text):
                label = re.sub(r"\s+", " ", m.group(1).lower())
                add(
                    page,
                    spans,
                    m.start(),
                    m.end(),
                    conf,
                    label,
                    {"kind": "requisite_gap", "label": label, "ops": list(OPS_DOC)},
                    raw=m.group(0),
                )
        for s0, e0 in _sentences(text):
            sent = text[s0:e0]
            low = sent.lower()
            if NOT_APPLICABLE.search(sent):
                add(
                    page,
                    spans,
                    s0,
                    e0,
                    conf,
                    "не применимо",
                    {"kind": "not_applicable", "ops": list(OPS_DOC)},
                    raw=sent.strip(),
                )
            node = NODE.search(sent)
            dm = re.search(DATE, sent)
            if node and dm and "акт" in low:
                d = re.search(rf"(?:от|дата)\s*{DATE}", sent, re.I) or dm
                add(
                    page,
                    spans,
                    s0,
                    e0,
                    conf,
                    node.group(0),
                    {
                        "kind": "act_date",
                        "node": f"Р-{node.group(1)}",
                        "date": _mmdd(d),
                        "ops": ["CMP-22"],
                    },
                    raw=sent.strip(),
                )
            elif node and dm and ("журнал" in low or "монтаж" in low):
                add(
                    page,
                    spans,
                    s0,
                    e0,
                    conf,
                    node.group(0),
                    {
                        "kind": "work_date",
                        "node": f"Р-{node.group(1)}",
                        "date": _mmdd(dm),
                        "ops": ["CMP-22"],
                    },
                    raw=sent.strip(),
                )
            element = bool(ELEMENT.search(sent))
            other = bool(OTHER.search(sent))
            for um in UNREADABLE.finditer(sent):
                add(
                    page,
                    spans,
                    s0 + um.start(),
                    s0 + um.end(),
                    conf,
                    um.group(0),
                    {"kind": "section_unreadable", "ops": list(OPS_SECTION)},
                    raw=um.group(0),
                    quote=sent.strip(),
                )
            found = [
                x
                for x in sections_in(sent)
                if not any(
                    u.start() <= x[3] < u.end() for u in UNREADABLE.finditer(sent)
                )
            ]
            if found and (element or element_seen or other):
                for kind, dims, label, s, e in found:
                    meta = {
                        "kind": "section",
                        "profile": kind,
                        "dims": dims,
                        "ops": list(OPS_SECTION),
                    }
                    if other:
                        meta |= {
                            "excluded": "OTHER_ELEMENT",
                            "excluded_why": "элемент котлована или шпунтового ограждения, а не сохраняемой конструкции",
                        }
                    add(
                        page,
                        spans,
                        s0 + s,
                        s0 + e,
                        conf,
                        label,
                        meta,
                        value_num=dims[0],
                        raw=sent[s:e],
                        quote=sent.strip(),
                    )
            element_seen = element_seen or (element and not other)
    return out
