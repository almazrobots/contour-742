"""Реквизиты документа (OS-INSP-2.3.1): печати, подписи, штампы, даты — на синтетических растрах."""

from __future__ import annotations

import hashlib
import math
import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from inspector_ml import requisites
from inspector_ml.model import Line, Word
from inspector_ml.ocr_ensemble import group_lines, run_ensemble
from inspector_ml.parse import parse_file

FONT = next(
    p / "assets/fonts/NotoSans.ttf"
    for p in Path(__file__).resolve().parents
    if (p / "assets/fonts/NotoSans.ttf").exists()
)
ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
W, H = 1240, 1754  # A4 при 150 dpi
BLUE = (30, 50, 170)
VIOLET = (90, 40, 160)


def page():
    img = Image.new("RGB", (W, H), (250, 250, 248))
    return img, ImageDraw.Draw(img)


def text(d: ImageDraw.ImageDraw, xy, s: str, size=30, fill=(20, 20, 20)) -> list[Word]:
    """Рисует строку и возвращает её слова с рамками — «идеальный OCR» для модульного теста."""
    f = ImageFont.truetype(str(FONT), size)
    x, y = xy
    out = []
    for token in s.split(" "):
        box = d.textbbox((x, y), token, font=f)
        d.text((x, y), token, font=f, fill=fill)
        out.append(
            Word(
                text=token,
                bbox=(box[0] / W, box[1] / H, box[2] / W, box[3] / H),
                conf=95,
            )
        )
        x = box[2] + d.textlength(" ", font=f)
    return out


def line(words: list[Word]) -> Line:
    return Line(text=" ".join(w.text for w in words), words=words)


def body(d) -> list[Line]:
    """Обычный печатный текст документа и таблица — фон, на котором не должно быть находок."""
    lines = [line(text(d, (100, 100), "Паспорт противопожарной двери", 40))]
    for i, s in enumerate(
        [
            "Предел огнестойкости противопожарных дверей, мин: EI 30",
            "Изготовитель: ООО Двери и ворота, партия 17",
            "Размер проёма 1000 x 2100 мм, открывание правое",
        ]
    ):
        lines.append(line(text(d, (100, 220 + i * 60), s)))
    for r in range(5):  # таблица с рамками
        d.line((100, 500 + r * 50, 1140, 500 + r * 50), fill=(30, 30, 30), width=2)
    for c in (100, 500, 1140):
        d.line((c, 500, c, 700), fill=(30, 30, 30), width=2)
    return lines


def seal(d, cx, cy, r, color=BLUE):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=5)
    d.ellipse(
        (cx - r + 22, cy - r + 22, cx + r - 22, cy + r - 22), outline=color, width=3
    )
    f = ImageFont.truetype(str(FONT), 22)
    label = "ООО СТРОЙМОНТАЖ * ИНН 7701234567 * "
    for i, ch in enumerate(label):  # текст по кругу между кольцами
        a = 2 * math.pi * i / len(label)
        d.text(
            (cx + (r - 13) * math.cos(a) - 6, cy + (r - 13) * math.sin(a) - 11),
            ch,
            font=f,
            fill=color,
        )
    d.text((cx - 45, cy - 14), "ПЕЧАТЬ", font=f, fill=color)


def bezier(p0, p1, p2, p3, n=60):
    return [
        (
            (1 - t) ** 3 * p0[0]
            + 3 * (1 - t) ** 2 * t * p1[0]
            + 3 * (1 - t) * t**2 * p2[0]
            + t**3 * p3[0],
            (1 - t) ** 3 * p0[1]
            + 3 * (1 - t) ** 2 * t * p1[1]
            + 3 * (1 - t) * t**2 * p2[1]
            + t**3 * p3[1],
        )
        for t in (i / n for i in range(n + 1))
    ]


def signature(d, x, y, color=BLUE):
    """Росчерк из нескольких кривых Безье — петли и хвост, как у рукописной подписи."""
    segs = [
        ((x, y + 40), (x + 30, y - 30), (x + 60, y + 80), (x + 90, y + 10)),
        ((x + 90, y + 10), (x + 120, y - 40), (x + 140, y + 70), (x + 170, y + 20)),
        ((x + 170, y + 20), (x + 200, y - 20), (x + 215, y + 60), (x + 250, y + 30)),
        ((x + 40, y + 55), (x + 110, y + 75), (x + 180, y + 45), (x + 270, y + 55)),
    ]
    for s in segs:
        d.line(bezier(*s), fill=color, width=3, joint="curve")


def kinds(found):
    return sorted(r.kind for r in found)


def inside(inner, outer, tol=0.01):
    return (
        inner[0] >= outer[0] - tol
        and inner[1] >= outer[1] - tol
        and inner[2] <= outer[2] + tol
        and inner[3] <= outer[3] + tol
    )


# ─────────────────────────────── печать


@pytest.mark.l1_functional
@pytest.mark.parametrize("color", [BLUE, VIOLET])
def test_seal_found_with_bbox(color):
    img, d = page()
    lines = body(d)
    seal(d, 900, 1350, 120, color)
    found = [r for r in requisites.detect(img, lines) if r.kind == "seal"]
    assert len(found) == 1
    x0, y0, x1, y1 = found[0].bbox
    assert abs(x0 - 780 / W) < 0.02 and abs(x1 - 1020 / W) < 0.02
    assert abs(y0 - 1230 / H) < 0.02 and abs(y1 - 1470 / H) < 0.02
    assert found[0].confidence >= 0.8


@pytest.mark.l3_boundary
def test_blue_filled_blob_and_small_ring_are_not_seals():
    """Сплошная синяя клякса и синее колечко-маркер (меньше печати) — не печати."""
    img, d = page()
    d.ellipse((200, 1200, 440, 1440), fill=BLUE)
    d.ellipse((700, 1300, 740, 1340), outline=BLUE, width=3)
    assert [r for r in requisites.detect(img, []) if r.kind == "seal"] == []


# ─────────────────────────────── подпись


@pytest.mark.l1_functional
def test_blue_signature_found():
    img, d = page()
    lines = body(d)
    signature(d, 700, 1500)
    found = [r for r in requisites.detect(img, lines) if r.kind == "signature"]
    assert len(found) == 1
    x0, y0, x1, y1 = found[0].bbox
    # рамка — внутри охвата управляющих точек кривых и покрывает росчерк по ширине
    assert inside(found[0].bbox, (700 / W, 1450 / H, 970 / W, 1580 / H), tol=0.01)
    assert (x1 - x0) * W > 0.85 * 270


@pytest.mark.l1_functional
def test_black_signature_next_to_label_found_and_far_scribble_ignored():
    """Чёрный росчерк засчитывается подписью только рядом со словом «Подпись»."""
    img, d = page()
    lines = body(d) + [line(text(d, (100, 1500), "Подпись"))]
    signature(d, 260, 1480, color=(25, 25, 25))
    signature(
        d, 800, 900, color=(25, 25, 25)
    )  # чёрная кривая посреди листа — как элемент чертежа
    found = [r for r in requisites.detect(img, lines) if r.kind == "signature"]
    assert len(found) == 1 and found[0].bbox[0] < 0.3 and found[0].bbox[1] > 0.8


@pytest.mark.l6_adversarial
def test_signature_read_by_ocr_as_word_still_found_black_text_erased():
    """OCR читает синий росчерк как «слово» («NM») — подпись всё равно находится; чёрный текст стирается."""
    img, d = page()
    lines = body(d)
    signature(d, 700, 1500)
    ocr_ghost = Word(text="NM", conf=40.0, bbox=(700 / W, 1450 / H, 970 / W, 1580 / H))
    found = [r for r in requisites.detect(img, lines + [line([ocr_ghost])]) if r.kind == "signature"]
    assert len(found) == 1
    # чёрный росчерк под «словом» OCR без слова «Подпись» рядом — стёрт как текст
    img2, d2 = page()
    signature(d2, 700, 1500, color=(25, 25, 25))
    assert [r for r in requisites.detect(img2, body(d2) + [line([ocr_ghost])]) if r.kind == "signature"] == []


@pytest.mark.l6_adversarial
def test_underline_and_scan_noise_are_not_signature():
    """«М.П. Подпись ______» без росчерка и точечный шум скана — подписи нет."""
    import random

    img, d = page()
    lines = body(d) + [line(text(d, (100, 1500), "М.П. Подпись"))]
    d.line((330, 1530, 700, 1530), fill=(30, 30, 30), width=2)
    rnd = random.Random(7)
    for _ in range(4000):
        v = rnd.randrange(120, 220)
        d.point((rnd.randrange(W), rnd.randrange(H)), fill=(v, v, v))
    assert requisites.detect(img, lines) == []


# ─────────────────────────────── штампы


@pytest.mark.l1_functional
def test_production_stamp_with_frame():
    img, d = page()
    lines = body(d)
    d.rectangle((600, 1300, 1100, 1420), outline=BLUE, width=4)
    ws = text(d, (630, 1325), "В ПРОИЗВОДСТВО РАБОТ", 34, fill=BLUE)
    lines.append(line(ws))
    found = [r for r in requisites.detect(img, lines) if r.kind.startswith("stamp")]
    assert kinds(found) == ["stamp_production"]
    # bbox — рамка штампа, а не только слова
    assert inside((600 / W, 1300 / H, 1100 / W, 1420 / H), found[0].bbox, tol=0.006)
    assert found[0].bbox[0] < ws[0].bbox[0] and found[0].confidence >= 0.9


@pytest.mark.l3_boundary
def test_asbuilt_stamp_split_over_lines_and_ocr_typo():
    """«Выполнено согласно / проекту» в две строки и с опечаткой OCR — штамп найден (без рамки)."""
    img, d = page()
    lines = [
        line(text(d, (600, 1300), "Выполнеио согласно")),
        line(text(d, (600, 1345), "проекту")),
    ]
    found = requisites.detect(img, lines)
    assert kinds(found) == ["stamp_asbuilt"]
    assert found[0].bbox[1] < 1300 / H + 0.01 and found[0].bbox[3] > 1345 / H


@pytest.mark.l6_adversarial
def test_phrase_words_far_apart_are_not_stamp():
    """Слова фразы, разбросанные по листу, — не штамп: окно должно быть компактным."""
    lines = [
        line(
            [
                Word(text="В", bbox=(0.1, 0.1, 0.12, 0.12)),
                Word(text="производство", bbox=(0.13, 0.1, 0.3, 0.12)),
            ]
        ),
        line([Word(text="работ", bbox=(0.1, 0.8, 0.2, 0.82))]),
    ]
    assert requisites.detect(None, lines) == []


# ─────────────────────────────── даты


@pytest.mark.l1_functional
def test_dates_found_with_bbox():
    img, d = page()
    lines = [
        line(text(d, (100, 1600), "Дата 12.03.2025 г.")),
        line(text(d, (700, 1600), "от 2025-04-01")),
    ]
    found = [r for r in requisites.detect(img, lines) if r.kind == "date"]
    assert [r.value for r in found] == ["2025-03-12", "2025-04-01"]
    assert found[0].bbox == lines[0].words[1].bbox


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "s", ["31.02.2025", "12.13.2025", "112.03.2025", "2025-13-01", "12.03.25"]
)
def test_invalid_dates_rejected(s):
    assert requisites.find_dates([line([Word(text=s, bbox=(0, 0, 0.1, 0.1))])]) == []


# ─────────────────────────────── чистая страница и сквозной путь


@pytest.mark.l6_adversarial
def test_clean_page_has_no_requisites():
    """Нет ложных срабатываний: печатный текст, таблица и пустое поле — ни одного реквизита."""
    img, d = page()
    lines = body(d)
    assert requisites.detect(img, lines) == []
    assert requisites.detect(Image.new("RGB", (W, H), "white"), []) == []


@pytest.mark.skipif(not shutil.which("tesseract"), reason="нет tesseract")
@pytest.mark.l1_functional
def test_full_page_all_kinds_via_ocr_ensemble():
    """Сквозной путь: слова даёт ансамбль OCR, реквизиты находятся все пять видов."""
    img, d = page()
    body(d)
    text(d, (100, 1150), "Дата 12.03.2025")
    d.rectangle((600, 1100, 1120, 1210), outline=(20, 20, 20), width=3)
    text(d, (630, 1130), "В производство работ", 34)
    text(d, (100, 1260), "Выполнено согласно проекту", 34)
    seal(d, 900, 1450, 120)
    text(d, (100, 1600), "Подпись", 30)
    signature(d, 300, 1570)
    res = run_ensemble(img)
    found = requisites.detect(img, group_lines(res.words))
    assert kinds(found) == [
        "date",
        "seal",
        "signature",
        "stamp_asbuilt",
        "stamp_production",
    ]
    assert all(
        r.bbox and 0 <= r.bbox[0] < r.bbox[2] <= 1 and 0 <= r.bbox[1] < r.bbox[3] <= 1
        for r in found
    )


@pytest.mark.l6_adversarial
def test_synthetic_scan_without_seal_or_signature_has_none():
    """Скан паспорта двери: «М.П. Подпись ____» без печати и росчерка — ни печати, ни подписи."""
    f = ROOT / "data/synth/OBJ-SEV-2/SEV-ID-DOOR-1.pdf"
    doc = parse_file(f, hashlib.sha256(f.read_bytes()).hexdigest())
    assert not [r for r in doc.pages[0].requisites if r.kind in ("seal", "signature")]


@pytest.mark.l1_functional
def test_analyze_returns_requisites_and_ocr_engines(tmp_path, monkeypatch):
    """Ответ /analyze: реквизиты по страницам и сводка ансамбля OCR у страницы скана."""
    import importlib

    from fastapi.testclient import TestClient

    import inspector_ml.app as app_mod

    blobs = tmp_path / "blobs"
    blobs.mkdir()
    shas = []
    for name in ("SEV-PD-PZ-1.pdf", "SEV-ID-DOOR-1.pdf"):
        f = ROOT / "data/synth/OBJ-SEV-2" / name
        shas.append(hashlib.sha256(f.read_bytes()).hexdigest())
        (blobs / shas[-1]).write_bytes(f.read_bytes())
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("INSPECTOR_BLOB_DIR", str(blobs))
    importlib.reload(app_mod)
    client = TestClient(app_mod.app)
    text = client.post("/analyze", json={"sha256": shas[0], "params": []}).json()
    assert [r["page"] for r in text["requisites"]] == [1, 2, 3]
    assert {i["kind"] for r in text["requisites"] for i in r["items"]} == {"date"}
    assert "requisites" not in text["pages"][0] and text["pages"][0]["engines"] == []
    if shutil.which("tesseract"):
        scan = client.post("/analyze", json={"sha256": shas[1], "params": []}).json()
        assert len(scan["pages"][0]["engines"]) == 3
        assert scan["pages"][0]["agreement"] is not None


# ─────────────────────────────── регистрационный номер (OS-INSP-2.3.4)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "s,value",
    [
        ("Рег. № ПД-2025/0415 от 12.03.2025", "ПД-2025/0415"),
        ("Регистрационный номер: 77-123-4567", "77-123-4567"),
        ("Вх. № 1543", "1543"),
        ("исх. N 12/7-с", "12/7-с"),  # OCR прочитал «№» как «N»
        ("Рег No.АБ-19", "АБ-19"),
    ],
)
def test_reg_number_found_after_label_with_bbox(s, value):
    img, d = page()
    found = [r for r in requisites.detect(None, [line(text(d, (100, 1600), s))]) if r.kind == "reg_number"]
    assert [r.value for r in found] == [value]
    x0, y0, x1, y1 = found[0].bbox
    assert 0 < x0 < x1 <= 1 and 0 < y0 < y1 <= 1


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "s",
    ["Лист № 3", "№ п/п Наименование работ", "Рег. № не присвоен", "Протокол регистрации участников", "Шифр СК2-Р-АР"],
)
def test_no_reg_number_without_label_or_digits(s):
    img, d = page()
    assert [r for r in requisites.detect(None, [line(text(d, (100, 1600), s))]) if r.kind == "reg_number"] == []
