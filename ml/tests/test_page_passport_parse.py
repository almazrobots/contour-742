"""T-216 × T-233: паспорт страницы в разборе — INSPECTOR_PAGE_PASSPORT=off|skip (OS-INSP-2.1.70–2.1.77).

Синтетика reportlab (ADR-0002). skip не меняет текстовые страницы и сканы с содержимым (сверка с off), пустой лист и
лист подписи с полями Widget уходят в skipped без сдвига номеров; режим и пороги — в ключе кэша разбора (ocr_tag)."""

from __future__ import annotations

import json

import pytest
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from inspector_ml import docstore
from inspector_ml import page_passport as pp
from inspector_ml.cache import FileCache
from inspector_ml.ocr_gpu import ocr_tag
from inspector_ml.parse import parse_pdf, take_passports

SHA = "e" * 64


def _doc(path):
    """Четыре листа: текст, скан с содержимым, пустой, лист подписи (рамка + поле Widget слева вверху)."""
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(
        60,
        760,
        "Akt osvidetelstvovaniya skrytyh rabot nomer semnadcat, stroka dlinnee tridcati",
    )
    c.showPage()
    img = Image.new("L", (620, 877), 245)
    for x in range(40, 580, 3):
        for y in range(300, 330):
            img.putpixel((x, y), 0)
    c.drawImage(ImageReader(img), 0, 0, w, h)
    c.showPage()
    c.showPage()  # пустой лист
    c.rect(20 * mm, 5 * mm, w - 25 * mm, h - 10 * mm)
    c.acroForm.textfield(
        name="sign", x=30 * mm, y=h - 40 * mm, width=60 * mm, height=10 * mm, value=""
    )
    c.showPage()
    c.save()
    return path


@pytest.fixture
def pdf(tmp_path):
    return _doc(tmp_path / "d.pdf")


def _parse(pdf, monkeypatch, mode):
    monkeypatch.setenv("INSPECTOR_PAGE_PASSPORT", mode)
    take_passports(SHA)
    return parse_pdf(pdf, SHA)


@pytest.mark.l1_functional
def test_skip_drops_blank_and_signature_sheet_keeps_numbering(pdf, monkeypatch):
    doc = _parse(pdf, monkeypatch, "skip")
    assert [p.page for p in doc.pages] == [1, 2, 3, 4]
    assert [p.source for p in doc.pages] == ["text", "ocr", "skipped", "skipped"]
    for p in doc.pages[2:]:
        assert p.lines == [] and p.quality == "OK" and p.width > 0 and p.height > 0


@pytest.mark.l1_functional
def test_skip_does_not_change_text_and_scan_pages_against_off(pdf, monkeypatch):
    off = _parse(pdf, monkeypatch, "off")
    skip = _parse(pdf, monkeypatch, "skip")
    assert [p.source for p in off.pages] == ["text", "ocr", "ocr", "ocr"]
    for i in (0, 1):  # текст и скан с содержимым — одно и то же прочтение
        assert skip.pages[i].model_dump() == off.pages[i].model_dump()


@pytest.mark.l1_functional
@pytest.mark.parametrize("value", ["off", "", "OFF", "weird"])
def test_off_or_unknown_mode_parses_as_before(pdf, monkeypatch, value):
    doc = _parse(pdf, monkeypatch, value)
    assert "skipped" not in [p.source for p in doc.pages]
    assert take_passports(SHA) is None  # без режима паспорт не считается


@pytest.mark.l1_functional
def test_skip_passports_only_for_pages_without_text_layer(pdf, monkeypatch):
    _parse(pdf, monkeypatch, "skip")
    got = take_passports(SHA)
    assert [(g["page"], g["page_class"]) for g in got] == [
        (2, "SCAN"),
        (3, "BLANK"),
        (4, "SIGNATURE_SHEET"),
    ]
    assert take_passports(SHA) is None  # забираются один раз


@pytest.mark.l1_functional
def test_mode_and_thresholds_in_parse_cache_key(monkeypatch):
    base = {"INSPECTOR_PROFILE": "dev"}
    assert (
        ocr_tag(base) == ocr_tag({**base, "INSPECTOR_PAGE_PASSPORT": "off"}) == ""
    )  # off — ключ прежний
    on = ocr_tag({**base, "INSPECTOR_PAGE_PASSPORT": "skip"})
    assert on.startswith("-o") and len(on) == 10
    monkeypatch.setattr(
        pp, "TEXT_MIN_CHARS", 31
    )  # другие пороги — другое прочтение, другой ключ
    assert ocr_tag({**base, "INSPECTOR_PAGE_PASSPORT": "skip"}) != on
    gpu = {"INSPECTOR_PROFILE": "gpu"}
    assert ocr_tag({**gpu, "INSPECTOR_PAGE_PASSPORT": "skip"}) != ocr_tag(gpu)


@pytest.mark.l1_functional
def test_load_parsed_writes_passport_cache_file_only_in_skip(
    pdf, tmp_path, monkeypatch
):
    cache = FileCache(tmp_path / "cache")
    monkeypatch.setenv("INSPECTOR_PAGE_PASSPORT", "off")
    monkeypatch.setattr(docstore, "parse_file", lambda path, sha: parse_pdf(path, sha))
    docstore.load_parsed(cache, pdf, SHA)
    assert cache.get(docstore.passport_key(SHA)) is None
    monkeypatch.setenv("INSPECTOR_PAGE_PASSPORT", "skip")
    doc, hit = docstore.load_parsed(
        cache, pdf, SHA
    )  # другой ключ разбора — разбор заново
    assert not hit and [p.source for p in doc.pages][2:] == ["skipped", "skipped"]
    rec = json.loads(cache.get(docstore.passport_key(SHA)))
    assert rec["sha256"] == SHA and [g["page"] for g in rec["pages"]] == [2, 3, 4]
    assert "Akt" not in json.dumps(rec)  # только числа и коды
