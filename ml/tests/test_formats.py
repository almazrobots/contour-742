"""T-036, T-038: XLSX и изображения (OS-INSP-1.2.9), перечень скрытых работ (OS-INSP-1.4.4).
Имя теста — то, на что ссылается трасса (docs/gera/inspector/model.yaml → impl)."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont

from inspector_ml.extract import extract
from inspector_ml.hidden_works import doc_title, hidden_works
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.parse import CorruptedFile, detect_kind, parse_file

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
SYNTH = ROOT / "data/synth"
FONT = ROOT / "assets/fonts/NotoSans.ttf"
AREA = ParamSpec(
    code="M-002", anchors=["Общая площадь здания", "Общая площадь"], data_type="number"
)
FLOORS = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
TESSERACT = pytest.mark.skipif(not shutil.which("tesseract"), reason="нет tesseract")


def _xlsx(path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "ТЭП"
    ws.append(["Показатель", "Ед. изм.", "Значение"])
    ws.append(["Общая площадь здания", "м²", 12450.0])
    ws.append([None, None, None])  # пустая строка не даёт строки
    ws.append(["Высота здания", "м", 39.6])
    other = wb.create_sheet("Сведения")
    other.append(["Этажность", "эт.", 12])
    wb.save(str(path))
    return path


def _scan(text_lines: list[str]) -> Image.Image:
    img = Image.new("L", (1654, 900), 255)
    dr = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT), 40)
    for i, t in enumerate(text_lines):
        dr.text((80, 80 + i * 90), t, font=font, fill=0)
    return img


@pytest.mark.l1_functional
def test_parse_xlsx_sheets_are_pages_and_cells_are_words(tmp_path):
    p = _xlsx(tmp_path / "blob")  # блоб без расширения, как в хранилище API
    assert detect_kind(p) == "xlsx"
    doc = parse_file(p, "x")
    assert (doc.kind, doc.engine, len(doc.pages)) == ("xlsx", "openpyxl", 2)
    first = doc.pages[0]
    assert first.source == "structured"
    assert [ln.text for ln in first.lines] == [
        "Показатель Ед. изм. Значение",
        "Общая площадь здания м² 12450",
        "Высота здания м 39,6",
    ]
    assert [w.text for w in first.lines[1].words] == [
        "Общая площадь здания",
        "м²",
        "12450",
    ]
    ex = {e.code: e for e in extract(doc, [AREA, FLOORS])}
    assert (ex["M-002"].value_num, ex["M-002"].page) == (12450.0, 1)
    assert (ex["M-007"].value_num, ex["M-007"].page) == (
        12.0,
        2,
    )  # страница = лист книги


@pytest.mark.l4_fault
def test_parse_xlsx_corrupted_and_docx_not_confused(tmp_path):
    bad = tmp_path / "bad"
    bad.write_bytes(b"PK\x03\x04xl/workbook.xml broken")
    assert (
        detect_kind(bad) == "docx"
    )  # битый ZIP не признан книгой — python-docx откажет как CORRUPTED
    with pytest.raises(CorruptedFile):
        parse_file(bad, "x")
    assert detect_kind(SYNTH / "OBJ-SEV-2/SEV-ID-AOSR-7.docx") == "docx"
    assert detect_kind(SYNTH / "OBJ-SKL-5/SKL-RD-AR-1.xlsx") == "xlsx"


@TESSERACT
@pytest.mark.l1_functional
@pytest.mark.parametrize("fmt,sig", [("PNG", b"\x89PNG"), ("JPEG", b"\xff\xd8\xff")])
def test_parse_image_png_jpg_via_ocr(tmp_path, fmt, sig):
    p = tmp_path / "blob"
    _scan(["Паспорт изделия", "Общая площадь здания 5 410,0"]).save(
        str(p), format=fmt, dpi=(200, 200)
    )
    assert p.read_bytes().startswith(sig)
    doc = parse_file(p, "x")
    assert (doc.kind, len(doc.pages), doc.pages[0].source) == ("image", 1, "ocr")
    assert "tesseract" in doc.engine
    assert doc.pages[0].quality == "OK"
    e = extract(doc, [AREA])[0]
    assert e.value_num == 5410.0
    assert all(0 <= v <= 1 for v in e.bbox)


@TESSERACT
@pytest.mark.l1_functional
def test_parse_image_multipage_tiff_each_frame_is_page(tmp_path):
    p = tmp_path / "blob"
    a = _scan(["Сертификат соответствия", "Этажность 12"])
    b = _scan(["Приложение к сертификату", "Общая площадь здания 900"])
    a.save(str(p), format="TIFF", save_all=True, append_images=[b], dpi=(300, 300))
    doc = parse_file(p, "x")
    assert [pg.page for pg in doc.pages] == [1, 2]
    ex = {e.code: e for e in extract(doc, [AREA, FLOORS])}
    assert (ex["M-007"].page, ex["M-002"].page) == (1, 2)


@pytest.mark.l4_fault
def test_parse_image_corrupted(tmp_path):
    p = tmp_path / "blob"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    with pytest.raises(CorruptedFile):
        parse_file(p, "x")


@TESSERACT
@pytest.mark.l1_functional
def test_parse_image_synthetic_tech_plan():
    doc = parse_file(SYNTH / "OBJ-SKL-5/SKL-ID-TP-1.png", "x")
    assert doc_title(doc) == "Технический план здания (скан)"
    assert extract(doc, [AREA])[0].value_num == 5410.0


# ─────────────────────────────── OS-INSP-1.4.4


def _doc(lines: list[str]) -> ParsedDoc:
    ls = [
        Line(
            text=t,
            words=[
                Word(text=w, bbox=(0.1, 0.1 + i / 100, 0.2, 0.11 + i / 100))
                for w in t.split(" ")
            ],
        )
        for i, t in enumerate(lines)
    ]
    return ParsedDoc(
        sha256="x",
        kind="pdf",
        engine="t",
        pages=[Page(page=4, width=1, height=1, source="text", lines=ls)],
    )


@pytest.mark.l1_functional
def test_hidden_works_from_synthetic_rd_kzh_sheet():
    doc = parse_file(SYNTH / "OBJ-SEV-2/SEV-RD-KZH-1.pdf", "x")
    hw = hidden_works(doc)
    assert [(h.n, h.text, h.page) for h in hw] == [
        (1, "Армирование фундаментной плиты", 3),
        (2, "Гидроизоляция фундаментной плиты", 3),
        (3, "Устройство закладных деталей", 3),
    ]
    assert all(h.bbox and 0 <= h.bbox[0] < h.bbox[2] <= 1 for h in hw)
    # в документе без перечня — ничего не выдумываем
    assert hidden_works(parse_file(SYNTH / "OBJ-SEV-2/SEV-RD-AR-B.pdf", "x")) == []


@pytest.mark.l3_boundary
def test_hidden_works_long_heading_wrapped_and_table_header():
    doc = _doc(
        [
            "Общие данные",
            "Перечень видов работ, для которых необходимо составление актов",
            "освидетельствования скрытых работ",
            "№ п/п Наименование работ",
            "1) Устройство бетонной подготовки",
            "2 Армирование стен подвала;",
            "Ведомость ссылочных документов",
            "3. Это уже не перечень",
        ]
    )
    assert [(h.n, h.text, h.page) for h in hidden_works(doc)] == [
        (1, "Устройство бетонной подготовки", 4),
        (2, "Армирование стен подвала", 4),
    ]


@pytest.mark.l3_boundary
def test_hidden_works_heading_without_items_or_too_far():
    assert hidden_works(_doc(["Перечень скрытых работ", "см. том 3"])) == []
    assert (
        hidden_works(_doc(["Перечень скрытых работ", "а", "б", "в", "г", "1. Поздно"]))
        == []
    )
    assert (
        hidden_works(_doc(["Перечень чертежей", "1. Общие данные"])) == []
    )  # не тот перечень
    assert (
        hidden_works(_doc(["Перечень скрытых работ", "1. 12"])) == []
    )  # позиция без слов


@pytest.mark.l1_functional
def test_doc_title_first_meaningful_line():
    assert (
        doc_title(parse_file(SYNTH / "OBJ-SEV-2/SEV-ID-AOSR-7.docx", "x"))
        == "АОСР № 7. Армирование фундаментной плиты"
    )
    assert doc_title(_doc(["12", "Журнал работ"])) == "Журнал работ"
    assert doc_title(_doc([])) is None
