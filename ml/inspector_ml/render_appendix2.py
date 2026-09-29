"""Протокол по образцу Приложения № 2 в PDF и DOCX (OS-INSP-5.1.6, T-121).

Модель документа (разделы, строки, ширины) собирает API — ``domain/appendix2.ts``; здесь только оформление.
Оформление — дизайн-система интерфейса (apps/web/src/styles.css): шрифты Geologica (заголовки), Onest (текст),
JetBrains Mono (коды); цвета — токены ink, mute, line, surface, кобальт акцента и семантика статусов.
Таблицы — волосяные разделители строк без сетки, как списки интерфейса.

OWASP H6 (T-121): reportlab разбирает разметку в Paragraph — весь текст из данных экранируется, иначе «<» в
описании гипотезы ломает рендер, а «<link>» вставил бы в протокол чужую ссылку.
"""

from __future__ import annotations

import io
import re
from xml.sax.saxutils import escape

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .paths import repo_root

FONTS = repo_root() / "assets/fonts"
for name, file in (
    ("Onest", "Onest-Regular.ttf"),
    ("Onest-SemiBold", "Onest-SemiBold.ttf"),
    ("Geologica", "Geologica-SemiBold.ttf"),
    ("Mono", "JetBrainsMono-Regular.ttf"),
):
    if name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(name, str(FONTS / file)))

# токены дизайн-системы (apps/web/src/styles.css :root)
INK = "#11151d"
INK2 = "#3f4656"
MUTE = "#6b7384"
LINE = "#d5d9e0"
SURFACE = "#f8f9fb"
SURFACE2 = "#eef0f4"
ACCENT = "#1f49f0"
TONE = {
    "red": "#d0241c",
    "amber": "#8a6d00",
    "green": "#137a55",
    "blue": "#2f5bd8",
    "gray": "#8a92a3",
}
# слово в ячейке → смысловой цвет (решение инспектора, статус загрузки)
WORD_TONE = {
    "Подтверждено": "red",
    "Ожидает": "amber",
    "Уточнение": "blue",
    "Отклонено": "gray",
    "Полностью": "green",
    "Частично": "amber",
    "Не загружено": "red",
    "Не требуется": "gray",
}
MONO_COLUMNS = {"Код"}


def _t(s: object) -> str:
    """Текст данных для Paragraph: экранирование разметки и переносы строк (OWASP H6)."""
    return escape(str(s if s is not None else "—")).replace("\n", "<br/>")


def _styles() -> dict[str, ParagraphStyle]:
    return {
        "kicker": ParagraphStyle(
            "kicker",
            fontName="Onest-SemiBold",
            fontSize=7.5,
            leading=10,
            textColor=colors.HexColor(MUTE),
        ),
        "title": ParagraphStyle(
            "title",
            fontName="Geologica",
            fontSize=19,
            leading=23,
            textColor=colors.HexColor(INK),
            spaceBefore=2,
            spaceAfter=8,
        ),
        "h2": ParagraphStyle(
            "h2",
            fontName="Geologica",
            fontSize=12,
            leading=15,
            textColor=colors.HexColor(INK),
            spaceBefore=12,
            spaceAfter=5,
        ),
        "h3": ParagraphStyle(
            "h3",
            fontName="Onest-SemiBold",
            fontSize=9.5,
            leading=12,
            textColor=colors.HexColor(INK2),
            spaceBefore=6,
            spaceAfter=3,
        ),
        "th": ParagraphStyle(
            "th",
            fontName="Onest-SemiBold",
            fontSize=7,
            leading=9,
            textColor=colors.HexColor(MUTE),
        ),
        "td": ParagraphStyle(
            "td",
            fontName="Onest",
            fontSize=8,
            leading=10.5,
            textColor=colors.HexColor(INK),
        ),
        "mono": ParagraphStyle(
            "mono",
            fontName="Mono",
            fontSize=7.5,
            leading=10,
            textColor=colors.HexColor(INK),
        ),
        "key": ParagraphStyle(
            "key",
            fontName="Onest",
            fontSize=7.5,
            leading=10,
            textColor=colors.HexColor(MUTE),
        ),
        "val": ParagraphStyle(
            "val",
            fontName="Onest-SemiBold",
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor(INK),
        ),
        "empty": ParagraphStyle(
            "empty",
            fontName="Onest",
            fontSize=8,
            leading=10,
            textColor=colors.HexColor(MUTE),
        ),
        "note": ParagraphStyle(
            "note",
            fontName="Onest",
            fontSize=7.5,
            leading=10,
            textColor=colors.HexColor(INK2),
        ),
    }


def _cell(value: str, column: str, st: dict[str, ParagraphStyle]) -> Paragraph:
    if column in MONO_COLUMNS:
        return Paragraph(_t(value), st["mono"])
    tone = WORD_TONE.get(str(value))
    if tone:
        return Paragraph(
            f'<font name="Onest-SemiBold" color="{TONE[tone]}">{_t(value)}</font>',
            st["td"],
        )
    if column.startswith("Раздел") or column == "№":
        return Paragraph(
            _t(value),
            ParagraphStyle("c", parent=st["td"], textColor=colors.HexColor(INK2)),
        )
    return Paragraph(_t(value), st["td"])


def _table(
    columns: list[str],
    rows: list[list[str]],
    widths: list[float],
    total: float,
    st: dict[str, ParagraphStyle],
) -> Table:
    scale = total / (sum(widths) or 1)
    data = [[Paragraph(_t(c), st["th"]) for c in columns]] + [
        [_cell(v, columns[i], st) for i, v in enumerate(r)] for r in rows
    ]
    t = Table(data, colWidths=[w * scale for w in widths], repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(SURFACE2)),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor(LINE)),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor(LINE)),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return t


def _section_title(title: str, st: dict[str, ParagraphStyle]) -> Paragraph:
    # «Раздел 4.» — кобальтом, как номер шага в интерфейсе; остальное — чернилами
    head, _, rest = title.partition(". ")
    if rest:
        return Paragraph(
            f'<font color="{ACCENT}">{_t(head)}.</font> {_t(rest)}', st["h2"]
        )
    return Paragraph(_t(title), st["h2"])


def render_pdf(p: dict) -> bytes:
    a = p["appendix2"]
    st = _styles()
    page = landscape(A4)
    margin = 14 * mm
    width = page[0] - 2 * margin
    title = a["title"]

    def footer(canvas, doc) -> None:
        canvas.saveState()
        canvas.setFont("Onest", 7)
        canvas.setFillColor(colors.HexColor(MUTE))
        canvas.drawString(
            margin, 8 * mm, f"{title} · версия {p.get('protocol_version', '')}"
        )
        canvas.drawRightString(page[0] - margin, 8 * mm, f"стр. {doc.page}")
        canvas.setStrokeColor(colors.HexColor(LINE))
        canvas.setLineWidth(0.3)
        canvas.line(margin, 11 * mm, page[0] - margin, 11 * mm)
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=page,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=13 * mm,
        bottomMargin=16 * mm,
        title=title,
        author="Инспектор ИИ",
    )
    story: list = [
        Paragraph("ИНСПЕКТОР ИИ · КАМЕРАЛЬНАЯ ПРОВЕРКА ПД / РД / ИД", st["kicker"]),
        Paragraph(_t(title), st["title"]),
    ]

    # шапка — пары «ключ · значение» в две колонки на подложке, как карточка объекта в интерфейсе
    pairs = a["header"]
    half = (len(pairs) + 1) // 2
    rows = []
    for i in range(half):
        row = []
        for k, v in (pairs[i], pairs[i + half] if i + half < len(pairs) else ("", "")):
            row += [
                Paragraph(_t(k) if k else "", st["key"]),
                Paragraph(_t(v) if k else "", st["val"]),
            ]
        rows.append(row)
    head = Table(rows, colWidths=[width * x for x in (0.13, 0.37, 0.13, 0.37)])
    head.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(SURFACE)),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor(LINE)),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    story.append(head)

    for s in a["sections"]:
        if not s["columns"]:  # раздел 7 — подразделы ниже
            story.append(_section_title(s["title"], st))
            continue
        block = [_section_title(s["title"], st)]
        block.append(
            _table(s["columns"], s["rows"], s["widths"], width, st)
            if s["rows"]
            else Paragraph("Нет записей", st["empty"])
        )
        story.append(KeepTogether(block) if len(s["rows"]) <= 6 else block[0])
        if len(s["rows"]) > 6:
            story.append(block[1])
    for r in a["resolution"]:
        story.append(Paragraph(_t(r["title"]), st["h3"]))
        story.append(
            _table(a["resolution_columns"], r["rows"], [5, 30, 35, 30], width, st)
            if r["rows"]
            else Paragraph("Нет записей", st["empty"])
        )
    story += [Spacer(1, 6 * mm), Paragraph(_t(a["note"]), st["note"])]
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()


# ─────────────────────────────── DOCX: те же разделы; шрифты по именам (Word подставит близкие, если их нет)


def _shade(cell, hex_color: str) -> None:
    tc = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color.lstrip("#"))
    tc.append(shd)


_XML_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def _run(
    par,
    text: str,
    *,
    font: str = "Onest",
    size: float = 8.5,
    bold: bool = False,
    color: str = INK,
) -> None:
    # OWASP H6: символы, недопустимые в XML 1.0, из текста документов вычищаются — иначе DOCX не сохраняется
    r = par.add_run(_XML_BAD.sub("", text))
    r.font.name = font
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.color.rgb = RGBColor.from_string(color.lstrip("#"))


def _docx_table(d, columns: list[str], rows: list[list[str]]) -> None:
    t = d.add_table(rows=1, cols=len(columns))
    t.style = "Table Grid"
    for i, c in enumerate(columns):
        cell = t.rows[0].cells[i]
        cell.text = ""
        _run(cell.paragraphs[0], c, size=7.5, bold=True, color=MUTE)
        _shade(cell, SURFACE2)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            tone = WORD_TONE.get(str(v))
            _run(
                cells[i].paragraphs[0],
                str(v),
                font="JetBrains Mono" if columns[i] in MONO_COLUMNS else "Onest",
                size=8,
                bold=bool(tone),
                color=TONE[tone] if tone else INK,
            )


def render_docx(p: dict) -> bytes:
    a = p["appendix2"]
    d = Document()
    sec = d.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = Mm(297), Mm(210)
    for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(sec, side, Mm(14))
    normal = d.styles["Normal"]
    normal.font.name = "Onest"
    normal.font.size = Pt(8.5)
    _run(
        d.add_paragraph(),
        "ИНСПЕКТОР ИИ · КАМЕРАЛЬНАЯ ПРОВЕРКА ПД / РД / ИД",
        size=7.5,
        bold=True,
        color=MUTE,
    )
    _run(d.add_paragraph(), a["title"], font="Geologica", size=18, bold=True)
    head = d.add_table(rows=0, cols=2)
    head.style = "Table Grid"
    for k, v in a["header"]:
        cells = head.add_row().cells
        cells[0].text = cells[1].text = ""
        _run(cells[0].paragraphs[0], k, size=8, color=MUTE)
        _run(cells[1].paragraphs[0], v, size=8.5, bold=True)
        _shade(cells[0], SURFACE)
    for s in a["sections"]:
        par = d.add_paragraph()
        head_, _, rest = s["title"].partition(". ")
        _run(par, head_ + ". ", font="Geologica", size=12, bold=True, color=ACCENT)
        _run(par, rest, font="Geologica", size=12, bold=True)
        if not s["columns"]:
            continue
        if s["rows"]:
            _docx_table(d, s["columns"], s["rows"])
        else:
            _run(d.add_paragraph(), "Нет записей", color=MUTE)
    for r in a["resolution"]:
        _run(d.add_paragraph(), r["title"], size=9.5, bold=True, color=INK2)
        if r["rows"]:
            _docx_table(d, a["resolution_columns"], r["rows"])
        else:
            _run(d.add_paragraph(), "Нет записей", color=MUTE)
    _run(d.add_paragraph(), a["note"], size=7.5, color=INK2)
    out = io.BytesIO()
    d.save(out)
    return out.getvalue()
