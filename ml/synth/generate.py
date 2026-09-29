"""Синтетический набор документов ПД/РД/ИД (ADR-0002: демо и тесты — только синтетика).

Три вымышленных объекта со своими шифрами, штампами и данными. В документы заложены
расхождения, конфликт редакций, пропуски комплекта, скан без текстового слоя и повёрнутый
лист. Ожидаемые статусы — в answer-key.json рядом с каждым пакетом.

    uv run python synth/generate.py [каталог]   # по умолчанию ../data/synth
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

from docx import Document
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from inspector_ml.paths import repo_root

ROOT = repo_root()
FONT = ROOT / "assets/fonts/NotoSans.ttf"
pdfmetrics.registerFont(TTFont("Noto", str(FONT)))

# ─────────────────────────────────────────────── модель пакета


@dataclass
class Row:
    label: str
    unit: str
    value: str


@dataclass
class Doc:
    file_id: str
    stage: str  # PD | RD | ID
    discipline: str
    code: str
    revision: str
    status: str  # DRAFT | APPROVED | FOR_CONSTRUCTION | SUPERSEDED | CANCELLED
    date: str
    title: str
    rows: list[Row]
    kind: str = "pdf"  # pdf | scan | docx | xml | xlsx | png
    predecessor: str | None = None
    rotate_second_page: bool = False
    extra: list[tuple[str, str]] = field(
        default_factory=list
    )  # экспликация: (номер, назначение)
    uploaded: bool = True
    # OS-INSP-1.4.4: лист «Перечень скрытых работ» (позиции по порядку)
    hidden_works: list[str] = field(default_factory=list)
    # OS-INSP-1.2.10: часть большого документа — file_id основного документа и номер части
    part_of: str | None = None
    part_index: int | None = None
    # OS-INSP-2.3.2: бумажный документ ИД несёт подпись; False — сценарий «подписи нет» (MISSING_EVIDENCE)
    signed: bool = True
    # OS-INSP-2.3.3: штампы рабочего чертежа ИД — "production" («В производство работ»), "asbuilt» («Выполнено согласно проекту»)
    stamps: tuple[str, ...] = ()
    # OS-INSP-2.4: на листе 1 — размерные линии 6000 и 3000 (М 1:100) и стены через 3000 и 4500 мм
    dims: bool = False

    @property
    def wants_signature(self) -> bool:
        return self.stage == "ID" and self.signed and self.kind in ("pdf", "scan", "png")

    @property
    def filename(self) -> str:
        ext = {"pdf": "pdf", "scan": "pdf", "docx": "docx", "xml": "xml", "xlsx": "xlsx", "png": "png"}[self.kind]
        return f"{self.file_id}.{ext}"


# ─────────────────────────────────────────────── рендер PDF


def _stamp(
    c: canvas.Canvas, d: Doc, sheet: int, sheets: int, w: float, h: float
) -> None:
    """Собственный штамп проекта: не повторяет форму ГОСТ Р 21.101, только его смысл."""
    c.setLineWidth(0.8)
    c.rect(10 * mm, 10 * mm, w - 20 * mm, h - 20 * mm)
    x0, y0, bw, bh = w - 10 * mm - 120 * mm, 10 * mm, 120 * mm, 28 * mm
    c.rect(x0, y0, bw, bh)
    c.line(x0, y0 + 14 * mm, x0 + bw, y0 + 14 * mm)
    c.line(x0 + 80 * mm, y0, x0 + 80 * mm, y0 + 14 * mm)
    c.setFont("Noto", 9)
    c.drawString(x0 + 3 * mm, y0 + 22 * mm, f"Шифр: {d.code}")
    c.drawString(
        x0 + 3 * mm,
        y0 + 17 * mm,
        f"Стадия: {d.stage}   Ред.: {d.revision}   Статус: {d.status}",
    )
    c.drawString(x0 + 3 * mm, y0 + 8 * mm, d.title[:48])
    c.drawString(x0 + 3 * mm, y0 + 3 * mm, f"Дата: {d.date}")
    c.drawString(x0 + 83 * mm, y0 + 8 * mm, f"Лист {sheet}")
    c.drawString(x0 + 83 * mm, y0 + 3 * mm, f"Листов {sheets}")


def _table(c: canvas.Canvas, rows: list[Row], x: float, y: float, title: str) -> float:
    c.setFont("Noto", 12)
    c.drawString(x, y, title)
    y -= 9 * mm
    c.setFont("Noto", 10)
    for r in rows:
        c.drawString(x, y, r.label)
        c.drawString(x + 110 * mm, y, r.unit)
        c.drawRightString(x + 170 * mm, y, r.value)
        c.setLineWidth(0.3)
        c.line(x, y - 2.2 * mm, x + 172 * mm, y - 2.2 * mm)
        y -= 7.5 * mm
    return y


def render_pdf(d: Doc, path: Path) -> None:
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle(f"{d.code} ред. {d.revision}")
    sheets = 4 if d.hidden_works else 3
    # лист 1 — общие указания (шум для поиска)
    _stamp(c, d, 1, sheets, w, h)
    c.setFont("Noto", 14)
    c.drawString(20 * mm, h - 25 * mm, d.title)
    for i, kind in enumerate(d.stamps):
        _work_stamp(c, kind, d.date, 20 * mm + i * 80 * mm, 60 * mm)
    if d.dims:
        c.setLineWidth(0.6)
        for (x0, x1), label in (((40, 100), "6000"), ((110, 140), "3000")):  # 60 и 30 мм на листе при М 1:100
            c.line(x0 * mm, 100 * mm, x1 * mm, 100 * mm)
            c.drawCentredString((x0 + x1) / 2 * mm, 102 * mm, label)
        c.setLineWidth(1.2)
        for x in (50, 80, 125):  # стены: 30 и 45 мм на листе = 3000 и 4500 мм
            c.line(x * mm, 115 * mm, x * mm, 200 * mm)
    c.setFont("Noto", 10)
    for i, line in enumerate(
        [
            "Общие указания.",
            "Документация разработана в соответствии с заданием на проектирование.",
            "Отметка 0.000 соответствует уровню чистого пола первого этажа.",
            "Все размеры указаны в миллиметрах, если не оговорено иное.",
        ]
    ):
        c.drawString(20 * mm, h - 40 * mm - i * 6 * mm, line)
    c.showPage()
    # лист 2 — показатели (может быть повёрнут — см. постобработку ниже)
    _stamp(c, d, 2, sheets, w, h)
    y = _table(c, d.rows, 20 * mm, h - 30 * mm, "Основные показатели")
    if d.extra:
        y -= 6 * mm
        _table(
            c,
            [Row(f"Помещение {n}", "", name) for n, name in d.extra],
            20 * mm,
            y,
            "Экспликация помещений",
        )
    c.showPage()
    if d.hidden_works:
        # лист 3 — перечень скрытых работ (OS-INSP-1.4.4)
        _stamp(c, d, 3, sheets, w, h)
        c.setFont("Noto", 12)
        c.drawString(20 * mm, h - 30 * mm, "Перечень скрытых работ")
        c.setFont("Noto", 10)
        c.drawString(20 * mm, h - 38 * mm, "№ п/п   Наименование работ, подлежащих освидетельствованию")
        for i, work in enumerate(d.hidden_works, start=1):
            c.drawString(20 * mm, h - 46 * mm - (i - 1) * 7 * mm, f"{i}. {work}")
        c.showPage()
    # последний лист — примечания
    _stamp(c, d, sheets, sheets, w, h)
    c.setFont("Noto", 10)
    c.drawString(
        20 * mm,
        h - 30 * mm,
        "Примечания: изменения вносятся только через согласованное изменение документации.",
    )
    if d.wants_signature:
        from reportlab.lib.utils import ImageReader

        c.drawString(20 * mm, 60 * mm, "Ответственный представитель    Подпись")
        buf = io.BytesIO()
        _signature(len(d.file_id), 520, 220).save(buf, format="PNG")
        buf.seek(0)
        c.drawImage(ImageReader(buf), 85 * mm, 52 * mm, width=45 * mm, height=19 * mm, mask="auto")
    c.showPage()
    c.save()
    if d.rotate_second_page:
        # Повёрнутый лист: содержимое как есть, /Rotate 90 ставится постобработкой (так выглядят
        # отсканированные альбомом листы). reportlab.setPageRotation обрезает содержимое по MediaBox.
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        pdf[1].set_rotation(90)
        tmp = path.with_suffix(".tmp")
        pdf.save(str(tmp))
        pdf.close()
        tmp.replace(path)


def render_scan(d: Doc, path: Path) -> None:
    """Скан без текстового слоя: картинка 200 dpi с шумом и лёгким поворотом."""
    img = _scan_image(d)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    from reportlab.lib.utils import ImageReader

    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(ImageReader(buf), 0, 0, width=w, height=h)
    c.showPage()
    c.save()


def render_png(d: Doc, path: Path) -> None:
    """Скан-изображение PNG (GAP-INSP-04: паспорта и сертификаты приходят картинками)."""
    _scan_image(d).save(str(path), format="PNG", dpi=(200, 200))


def render_xlsx(d: Doc, path: Path) -> None:
    """Ведомость XLSX (GAP-INSP-04): лист «Показатели» с числами в числовых ячейках, лист «Сведения»."""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Показатели"
    ws.append(["Показатель", "Ед. изм.", "Значение"])
    for r in d.rows:
        raw = r.value.replace(" ", "").replace(",", ".")
        try:
            value: object = float(raw)
        except ValueError:
            value = r.value
        ws.append([r.label, r.unit, value])
    info = wb.create_sheet("Сведения")
    info.append(["Шифр", d.code])
    info.append(["Редакция", d.revision])
    info.append(["Наименование", d.title])
    wb.save(str(path))


STAMP_TEXT = {"production": "В ПРОИЗВОДСТВО РАБОТ", "asbuilt": "ВЫПОЛНЕНО СОГЛАСНО ПРОЕКТУ"}


def _work_stamp(c: canvas.Canvas, kind: str, date: str, x: float, y: float) -> None:
    """Штамп рабочего чертежа в составе ИД: фиолетовая рамка, фраза и дата (ТЗ §5, примечание 3)."""
    c.saveState()
    c.setStrokeColorRGB(90 / 255, 50 / 255, 170 / 255)
    c.setFillColorRGB(90 / 255, 50 / 255, 170 / 255)
    c.setLineWidth(1.6)
    c.rect(x, y, 70 * mm, 16 * mm)
    c.setFont("Noto", 9)
    c.drawCentredString(x + 35 * mm, y + 9.5 * mm, STAMP_TEXT[kind])
    c.drawCentredString(x + 35 * mm, y + 3.5 * mm, date)
    c.restoreState()


def _signature(seed: int, w: int, h: int) -> Image.Image:
    """Росчерк синими чернилами на прозрачном фоне — то, что детектор реквизитов считает подписью."""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    r = random.Random(seed)
    pts, x = [], w * 0.05
    while x < w * 0.95:
        pts.append((x, h * (0.5 + 0.35 * math.sin(x / w * r.uniform(8, 16)) * r.uniform(0.5, 1))))
        x += w * r.uniform(0.02, 0.05)
    dr.line(pts, fill=(20, 30, 120, 235), width=max(4, w // 60), joint="curve")  # ≈0,5 мм пера при 200 dpi
    dr.line((w * 0.1, h * 0.8, w * 0.9, h * 0.72), fill=(20, 30, 120, 200), width=max(3, w // 90))
    return im


def _scan_image(d: Doc) -> Image.Image:
    dpi = 200
    wpx, hpx = int(210 / 25.4 * dpi), int(297 / 25.4 * dpi)
    img = Image.new("L", (wpx, hpx), 250)
    dr = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT), 34)
    small = ImageFont.truetype(str(FONT), 26)
    dr.text((140, 160), d.title, font=font, fill=20)
    dr.text((140, 230), f"Шифр: {d.code}   Ред.: {d.revision}", font=small, fill=30)
    if d.stage == "ID":  # OS-INSP-2.3.4: регистрационный номер документа ИД
        dr.text((140, 275), f"Рег. № {d.code}/{d.date[:4]} от {d.date[8:10]}.{d.date[5:7]}.{d.date[:4]}", font=small, fill=30)
    yy = 360
    for r in d.rows:
        dr.text((140, yy), f"{r.label}, {r.unit}: {r.value}", font=font, fill=25)
        yy += 70
    dr.text((140, hpx - 300), "М.П.     Подпись ____________", font=small, fill=40)
    rnd = random.Random(7)
    for _ in range(4000):
        x, y = rnd.randrange(wpx), rnd.randrange(hpx)
        dr.point((x, y), fill=rnd.randrange(120, 220))
    img = img.convert("RGB")
    if d.wants_signature:
        sig = _signature(len(d.file_id), 260, 110)
        img.paste(sig, (560, hpx - 360), sig)
    return img.rotate(0.6, fillcolor=(250, 250, 250)).filter(ImageFilter.GaussianBlur(0.6))


def render_docx(d: Doc, path: Path) -> None:
    doc = Document()
    doc.add_heading(d.title, level=1)
    doc.add_paragraph(f"Шифр: {d.code}. Редакция: {d.revision}. Дата: {d.date}.")
    t = doc.add_table(rows=1, cols=3)
    t.rows[0].cells[0].text, t.rows[0].cells[1].text, t.rows[0].cells[2].text = (
        "Показатель",
        "Ед. изм.",
        "Значение",
    )
    for r in d.rows:
        cells = t.add_row().cells
        cells[0].text, cells[1].text, cells[2].text = r.label, r.unit, r.value
    doc.add_paragraph(
        "Работы выполнены в соответствии с проектной и рабочей документацией."
    )
    doc.save(str(path))


def render_xml(d: Doc, path: Path) -> None:
    items = "\n".join(
        f'    <Показатель наименование="{r.label}" ед="{r.unit}">{r.value}</Показатель>'
        for r in d.rows
    )
    path.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<ИсполнительныйДокумент шифр="{d.code}" редакция="{d.revision}" дата="{d.date}">
  <Наименование>{d.title}</Наименование>
  <Показатели>
{items}
  </Показатели>
</ИсполнительныйДокумент>
""",
        encoding="utf-8",
    )


RENDER = {
    "pdf": render_pdf,
    "scan": render_scan,
    "docx": render_docx,
    "xml": render_xml,
    "xlsx": render_xlsx,
    "png": render_png,
}

# ─────────────────────────────────────────────── объекты


def sever() -> tuple[dict, list[Doc], dict]:
    obj = {
        "object_id": "OBJ-SEV-2",
        "name": "СИНТЕТИКА · ЖК «Северный квартал», корпус 2",
        "address": "ВЫМЫШЛЕННЫЙ АДРЕС · г. Москва, ул. Вымышленная Северная, вл. 14, корп. 2",
        "customer": "ООО «СЗ Северный квартал-Тест»",
        "contractor": "АО «Строймонолит-Тест»",
        "permit_number": "77-000-0001-2025",
        "profile": {
            "synthetic": True,  # OS-INSP-1.1.3 (T-148): выдуманный объект — не влияет на метрики
            "residential": True,
            "underground": True,
            "gas": False,
            "demolition": False,
        },
    }
    R = Row
    docs = [
        Doc(
            # OS-INSP-2.2.7: смета — не источник проектного значения; её «площадь» 99 999 не должна дать расхождение
            "SEV-PD-SM-1", "PD", "СМ", "СК2-П-СМ", "1", "APPROVED", "2025-03-12",
            "Локальный сметный расчёт № 02-01-01",
            # машино-места есть только в смете: без фильтра она стала бы источником ПД для M-012 (MISSING_EVIDENCE)
            [R("Общая площадь здания", "м²", "99 999,0"), R("Количество машино-мест", "шт.", "999")],
        ),
        Doc(
            # OS-INSP-2.2.7: опросный лист (состав РД, ТЗ §4) — не источник проектного значения. На стадии РД у M-103
            # другого источника нет: без фильтра EI 15 стал бы значением РД и попал в карточку кандидата
            "SEV-RD-OL-1", "RD", "ППМ", "СК2-Р-ОЛ", "1", "FOR_CONSTRUCTION", "2025-07-20",
            "Опросный лист на противопожарные двери",
            [R("Предел огнестойкости противопожарных дверей", "мин", "EI 15")],
        ),
        Doc(
            "SEV-PD-PZ-1",
            "PD",
            "ПЗ",
            "СК2-П-ПЗ",
            "1",
            "APPROVED",
            "2025-03-10",
            "Пояснительная записка. ТЭП",
            [
                R("Площадь застройки", "м²", "2 140,0"),
                R("Общая площадь здания", "м²", "12 450,0"),
                R("Строительный объем", "м³", "48 900"),
                R("Этажность", "эт.", "12"),
                R("Высота здания", "м", "39,6"),
                R("Количество квартир", "шт.", "164"),
                R("Количество машино-мест", "шт.", "96"),
                R("Расчетная электрическая мощность", "кВт", "620"),
                R("Класс энергетической эффективности", "", "A"),
                R("Степень огнестойкости", "", "II"),
            ],
        ),
        Doc(
            "SEV-PD-KR-1",
            "PD",
            "КР",
            "СК2-П-КР",
            "1",
            "APPROVED",
            "2025-03-10",
            "Конструктивные решения",
            [
                R("Класс бетона монолитных конструкций", "", "B30"),
                R("Класс арматуры", "", "A500С"),
                R("Толщина фундаментной плиты", "мм", "800"),
                R("Толщина плиты перекрытия", "мм", "220"),
            ],
            rotate_second_page=True,
        ),
        Doc(
            "SEV-PD-PB-1",
            "PD",
            "ППМ",
            "СК2-П-ПБ",
            "1",
            "APPROVED",
            "2025-03-10",
            "Мероприятия по пожарной безопасности",
            [
                R("Предел огнестойкости противопожарных дверей", "мин", "EI 60"),
                R("Ширина эвакуационного выхода", "м", "1,20"),
                R("Ширина эвакуационного коридора", "м", "1,50"),
            ],
        ),
        Doc(
            "SEV-RD-AR-A",
            "RD",
            "АР",
            "СК2-Р-АР",
            "A",
            "SUPERSEDED",
            "2025-06-01",
            "Архитектурные решения. Общие данные",
            [
                R("Общая площадь здания", "м²", "12 900,0"),
                R("Этажность", "эт.", "13"),
                R("Ширина эвакуационного выхода", "м", "1,20"),
            ],
        ),
        Doc(
            "SEV-RD-AR-B",
            "RD",
            "АР",
            "СК2-Р-АР",
            "B",
            "FOR_CONSTRUCTION",
            "2025-07-15",
            "Архитектурные решения. Общие данные",
            [
                R("Общая площадь здания", "м²", "12 710,0"),
                R("Этажность", "эт.", "12"),
                R("Количество квартир", "шт.", "164"),
                R("Ширина эвакуационного выхода", "м", "0,85"),
                R("Ширина эвакуационного коридора", "м", "1,50"),
            ],
            predecessor="SEV-RD-AR-A",
        ),
        Doc(
            "SEV-RD-KZH-1",
            "RD",
            "КЖ",
            "СК2-Р-КЖ",
            "1",
            "FOR_CONSTRUCTION",
            "2025-07-15",
            "Конструкции железобетонные",
            [
                R("Класс бетона", "", "B30"),
                R("Толщина фундаментной плиты", "мм", "800"),
                R("Толщина плиты перекрытия", "мм", "200"),
            ],
            hidden_works=[
                "Армирование фундаментной плиты",  # АОСР № 7 есть
                "Гидроизоляция фундаментной плиты",  # акта нет
                "Устройство закладных деталей",  # акта нет
            ],
        ),
        Doc(
            "SEV-ID-JBR-1",
            "ID",
            "КЖ",
            "СК2-ИД-ЖБР",
            "1",
            "APPROVED",
            "2025-11-20",
            "Журнал бетонных работ (выписка)",
            [
                R("Класс бетона", "", "B25"),
                R("Толщина фундаментной плиты", "мм", "800"),
            ],
        ),
        Doc(
            "SEV-ID-AOSR-7",
            "ID",
            "КЖ",
            "СК2-ИД-АОСР-07",
            "1",
            "APPROVED",
            "2025-10-02",
            "АОСР № 7. Армирование фундаментной плиты",
            [
                R("Толщина фундаментной плиты", "мм", "800"),
                R("Класс арматуры", "", "A500С"),
            ],
            kind="docx",
        ),
        Doc(
            "SEV-ID-TP-1",
            "ID",
            "ПЗ",
            "СК2-ИД-ТП",
            "1",
            "APPROVED",
            "2026-01-15",
            "Технический план здания",
            [
                R("Площадь застройки", "м²", "2 140,0"),
                R("Общая площадь здания", "м²", "12 705,0"),
                R("Этажность", "эт.", "12"),
            ],
            kind="xml",
        ),
        Doc(
            "SEV-ID-ICH-1", "ID", "КЖ", "СК2-ИД-ИЧ-КЖ", "1", "APPROVED", "2025-12-10",
            "Исполнительный чертёж фундаментной плиты", [],
            stamps=("production", "asbuilt"),  # оба штампа и подпись — находки нет
            dims=True,
        ),
        Doc(
            "SEV-ID-DOOR-1",
            "ID",
            "ППМ",
            "СК2-ИД-ПАСП-ДВ",
            "1",
            "APPROVED",
            "2025-12-01",
            "Паспорт противопожарной двери",
            [R("Предел огнестойкости противопожарных дверей", "мин", "EI 30")],
            kind="scan",
            signed=False,  # паспорт без подписи — MISSING_EVIDENCE по OS-INSP-2.3.2
        ),
    ]
    key = {
        "REQ-SEV-ID-DOOR-1": "MISSING_EVIDENCE",  # паспорт двери без подписи (OS-INSP-2.3.2)
        "M-001": "NEGATIVE_VERIFIED",
        "M-002": "CANDIDATE",
        "M-007": "NEGATIVE_VERIFIED",
        "M-041": "CANDIDATE",
        "M-040": "NEGATIVE_VERIFIED",
        "M-055": "CANDIDATE",
        "M-057": "NEGATIVE_VERIFIED",
        "M-058": "NEGATIVE_VERIFIED",
        "M-059": "CANDIDATE",
        "M-103": "CANDIDATE",
        "M-010": "NEGATIVE_VERIFIED",
        "M-093": "NOT_APPLICABLE",
        "M-018": "NOT_APPLICABLE",
        "M-012": "MISSING_EVIDENCE",
        # OS-INSP-1.4.4: перечень скрытых работ РД КЖ против АОСР
        "HW-1": "NEGATIVE_VERIFIED",
        "HW-2": "MISSING_EVIDENCE",
        "HW-3": "MISSING_EVIDENCE",
    }
    return obj, docs, key


def school() -> tuple[dict, list[Doc], dict]:
    obj = {
        "object_id": "OBJ-SCH-8",
        "name": "СИНТЕТИКА · Школа на 550 мест",
        "address": "ВЫМЫШЛЕННЫЙ АДРЕС · г. Москва, ул. Вымышленная Лесная, 8",
        "customer": "ГКУ «Заказчик-Тест»",
        "contractor": "ООО «ШколСтрой-Тест»",
        "permit_number": "77-000-0002-2025",
        "profile": {
            "synthetic": True,  # OS-INSP-1.1.3 (T-148): выдуманный объект — не влияет на метрики
            "residential": False,
            "underground": False,
            "gas": False,
            "demolition": False,
        },
    }
    R = Row
    docs = [
        Doc(
            "SCH-PD-PZ-1",
            "PD",
            "ПЗ",
            "ШК8-П-ПЗ",
            "1",
            "APPROVED",
            "2025-02-01",
            "Пояснительная записка. ТЭП",
            [
                R("Площадь застройки", "м²", "3 800,0"),
                R("Общая площадь здания", "м²", "9 200,0"),
                R("Этажность", "эт.", "3"),
                R("Класс энергетической эффективности", "", "A"),
                R("Степень огнестойкости", "", "II"),
            ],
        ),
        Doc(
            "SCH-RD-AR-1",
            "RD",
            "АР",
            "ШК8-Р-АР",
            "1",
            "APPROVED",
            "2025-05-12",
            "Архитектурные решения",
            [R("Общая площадь здания", "м²", "9 180,0"), R("Этажность", "эт.", "3")],
        ),
        Doc(
            "SCH-RD-AR-2",
            "RD",
            "АР",
            "ШК8-Р-АР",
            "2",
            "APPROVED",
            "2025-05-20",
            "Архитектурные решения",
            [R("Общая площадь здания", "м²", "9 350,0"), R("Этажность", "эт.", "3")],
        ),
        Doc(
            "SCH-RD-KZH-1",
            "RD",
            "КЖ",
            "ШК8-Р-КЖ",
            "1",
            "FOR_CONSTRUCTION",
            "2025-05-20",
            "Конструкции железобетонные",
            [R("Класс бетона", "", "B25")],
        ),
        Doc(
            "SCH-RD-EM-1",
            "RD",
            "ЭОМ",
            "ШК8-Р-ЭМ",
            "1",
            "FOR_CONSTRUCTION",
            "2025-05-20",
            "Электрооборудование",
            [R("Класс энергетической эффективности", "", "A")],
            kind="docx",
        ),
    ]
    key = {
        "M-002": "CLARIFICATION_REQUIRED",
        "M-055": "MISSING_EVIDENCE",
        "M-010": "NOT_APPLICABLE",
        "M-001": "MISSING_EVIDENCE",
        "M-021": "NEGATIVE_VERIFIED",
    }
    return obj, docs, key


def clinic() -> tuple[dict, list[Doc], dict]:
    obj = {
        "object_id": "OBJ-POL-115",
        "name": "СИНТЕТИКА · Поликлиника на 750 посещений",
        "address": "ВЫМЫШЛЕННЫЙ АДРЕС · г. Москва, пр. Вымышленный Мира, 115",
        "customer": "ГКУ «Заказчик-Тест»",
        "contractor": "ООО «МедСтрой-Тест»",
        "permit_number": "77-000-0003-2025",
        "profile": {
            "synthetic": True,  # OS-INSP-1.1.3 (T-148): выдуманный объект — не влияет на метрики
            "residential": False,
            "underground": False,
            "gas": False,
            "demolition": False,
        },
    }
    R = Row
    rooms_pd = [
        ("0.12", "Техническое помещение"),
        ("1.05", "Регистратура"),
        ("1.18", "Кабинет врача"),
    ]
    rooms_rd = [
        ("0.12", "Склад ГСМ"),
        ("1.05", "Регистратура"),
        ("1.18", "Кабинет врача"),
    ]
    docs = [
        Doc(
            "POL-PD-PZ-1",
            "PD",
            "ПЗ",
            "ПК115-П-ПЗ",
            "1",
            "APPROVED",
            "2025-04-01",
            "Пояснительная записка. ТЭП",
            [
                R("Общая площадь здания", "м²", "15 600,0"),
                R("Этажность", "эт.", "12"),
                R("Количество лифтов", "шт.", "0"),
                R("Класс энергетической эффективности", "", "B"),
            ],
            extra=rooms_pd,
        ),
        Doc(
            "POL-RD-AR-1",
            "RD",
            "АР",
            "ПК115-Р-АР",
            "1",
            "FOR_CONSTRUCTION",
            "2025-08-01",
            "Архитектурные решения",
            [
                R("Общая площадь здания", "м²", "15 650,0"),
                R("Этажность", "эт.", "12"),
                R("Класс энергетической эффективности", "", "C"),
                R("Ширина эвакуационного выхода", "м", "1,20"),
            ],
            extra=rooms_rd,
        ),
        Doc(
            "POL-ID-AOSR-1",
            "ID",
            "КЖ",
            "ПК115-ИД-АОСР-01",
            "1",
            "APPROVED",
            "2025-12-10",
            "АОСР № 1. Устройство фундамента",
            [R("Толщина фундаментной плиты", "мм", "700")],
            kind="docx",
        ),
        Doc(
            "POL-ID-JBR-1",
            "ID",
            "КЖ",
            "ПК115-ИД-ЖБР",
            "1",
            "APPROVED",
            "2025-12-12",
            "Журнал бетонных работ (выписка)",
            [R("Класс бетона", "", "B30")],
        ),
        Doc(
            "POL-ID-ICH-1", "ID", "КЖ", "ПК115-ИД-ИЧ-КЖ", "1", "APPROVED", "2025-12-15",
            "Исполнительный чертёж фундаментной плиты", [],
            stamps=("production",),  # нет «Выполнено согласно проекту» — MISSING_EVIDENCE (OS-INSP-2.3.3)
        ),
        Doc(
            "POL-ID-AOSR-2",
            "ID",
            "КЖ",
            "ПК115-ИД-АОСР-02",
            "1",
            "APPROVED",
            "2026-01-10",
            "АОСР № 2. Армирование перекрытия",
            [R("Толщина плиты перекрытия", "мм", "200")],
            kind="docx",
            uploaded=False,
        ),
        Doc(
            "POL-ID-TP-1",
            "ID",
            "ПЗ",
            "ПК115-ИД-ТП",
            "1",
            "APPROVED",
            "2026-02-01",
            "Технический план здания",
            [R("Общая площадь здания", "м²", "15 640,0")],
            kind="xml",
            uploaded=False,
        ),
    ]
    key = {
        "REQ-POL-ID-ICH-1": "MISSING_EVIDENCE",  # чертёж без штампа «Выполнено согласно проекту»
        "M-002": "NEGATIVE_VERIFIED",
        "M-021": "CANDIDATE",
        "M-007": "NEGATIVE_VERIFIED",
        "SUSPICION:LOGICAL_ANALYSIS": 1,
        "SUSPICION:SEMANTIC_DISSONANCE": 1,
        "scenario": "PARTIALLY_LOADED",
    }
    return obj, docs, key


def warehouse() -> tuple[dict, list[Doc], dict]:
    """Реальные форматы (OS-INSP-1.2.9) и документ частями (OS-INSP-1.2.10): ведомость XLSX,
    скан техплана PNG, общий журнал работ из двух частей с одним шифром."""
    obj = {
        "object_id": "OBJ-SKL-5",
        "name": "СИНТЕТИКА · Складской корпус № 5",
        "address": "ВЫМЫШЛЕННЫЙ АДРЕС · г. Москва, ул. Вымышленная Складская, 5",
        "customer": "ООО «Логистика-Тест»",
        "contractor": "ООО «СкладСтрой-Тест»",
        "permit_number": "77-000-0004-2025",
        "profile": {"synthetic": True, "residential": False, "underground": False, "gas": False, "demolition": False},  # OS-INSP-1.1.3 (T-148)
    }
    R = Row
    docs = [
        Doc(
            "SKL-PD-PZ-1", "PD", "ПЗ", "СК5-П-ПЗ", "1", "APPROVED", "2025-02-10", "Пояснительная записка. ТЭП",
            [R("Общая площадь здания", "м²", "5 400,0"), R("Этажность", "эт.", "2"), R("Класс бетона", "", "B25")],
        ),
        Doc(
            "SKL-RD-AR-1", "RD", "АР", "СК5-Р-АР", "1", "FOR_CONSTRUCTION", "2025-04-01", "Ведомость ТЭП",
            [R("Общая площадь здания", "м²", "5 400,0"), R("Этажность", "эт.", "2"), R("Класс бетона", "", "B25")],
            kind="xlsx",
        ),
        Doc(
            "SKL-ID-TP-1", "ID", "ПЗ", "СК5-ИД-ТП", "1", "APPROVED", "2026-01-20", "Технический план здания (скан)",
            [R("Общая площадь здания", "м²", "5 410,0")],
            kind="png",
        ),
        Doc(
            "SKL-ID-OZHR-1", "ID", "КЖ", "СК5-ИД-ОЖР", "1", "APPROVED", "2025-12-01", "Общий журнал работ. Часть 1",
            [R("Этажность", "эт.", "2")],
            part_index=1,
        ),
        Doc(
            "SKL-ID-OZHR-1-P2", "ID", "КЖ", "СК5-ИД-ОЖР", "1", "APPROVED", "2025-12-01", "Общий журнал работ. Часть 2",
            [R("Класс бетона", "", "B20")],
            part_of="SKL-ID-OZHR-1",
            part_index=2,
        ),
    ]
    key = {
        "M-002": "NEGATIVE_VERIFIED",  # ПД/РД 5 400 — ИД (PNG, OCR) 5 410: в пределах 1 %
        "M-007": "NEGATIVE_VERIFIED",  # РД — XLSX
        "M-055": "CANDIDATE",  # B25 → B20 во второй части журнала: стр. 5 сквозной нумерации
    }
    return obj, docs, key


# ─────────────────────────────────────────────── сборка


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def build(out: Path) -> None:
    for fn, scenario in (
        (sever, "FULL"),
        (school, "PD_RD_ONLY"),
        (clinic, "PARTIALLY_LOADED"),
        (warehouse, "FULL"),
    ):
        obj, docs, key = fn()
        d = out / obj["object_id"]
        d.mkdir(parents=True, exist_ok=True)
        files = []
        for doc in docs:
            p = d / doc.filename
            RENDER[doc.kind](doc, p)
            files.append(
                {
                    "file_id": doc.file_id,
                    "file_name": doc.filename,
                    "sha256": sha256(p) if doc.uploaded else None,
                    "doc_stage": doc.stage,
                    "discipline": doc.discipline,
                    "document_code": doc.code,
                    "revision": doc.revision,
                    "approval_status": doc.status,
                    "approval_date": doc.date,
                    "sheet_page_range": (f"1-{4 if doc.hidden_works else 3}" if doc.kind == "pdf" else "1"),
                    "predecessor_id": doc.predecessor,
                    "signature_status": "UKEP"
                    if doc.kind in ("xml", "docx")
                    else "SCAN_SIGNED",
                }
            )
            if doc.part_index is not None:
                files[-1] |= {"part_of": doc.part_of, "part_index": doc.part_index}
            if not doc.uploaded:
                # объявлен в реестре, но не пришёл в пакете — лежит отдельно для демонстрации дозагрузки
                late = d / "_late"
                late.mkdir(exist_ok=True)
                files[-1]["sha256"] = None
                p.replace(late / p.name)
        manifest = {"object": obj, "files": files}
        (d / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        key["scenario"] = key.get("scenario", scenario)
        (d / "answer-key.json").write_text(
            json.dumps(key, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(
            f"{obj['object_id']}: {sum(f['sha256'] is not None for f in files)} файлов, сценарий {key['scenario']}"
        )


if __name__ == "__main__":
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data/synth")
    # Пара редакций листа-чертежа АР для диффа (OS-INSP-3.4) — отдельным каталогом, чтобы не менять
    # пакет OBJ-SEV-2 и его answer-key; генерация детерминирована (reportlab invariant).
    import sheets

    sheets.build(ROOT / "data/fixtures/sheetdiff")
