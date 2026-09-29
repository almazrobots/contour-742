"""Ансамбль OCR с голосованием (OS-INSP-2.1.5, 2.1.6, 2.1.7). Движки-подделки — детерминированные."""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from inspector_ml import ocr_ensemble as oe
from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.parse import parse_file

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
DOOR = ROOT / "data/synth/OBJ-SEV-2/SEV-ID-DOOR-1.pdf"
FONT = next(p / "assets/fonts/NotoSans.ttf" for p in Path(__file__).resolve().parents if (p / "assets/fonts/NotoSans.ttf").exists())
M103 = next(
    ParamSpec(
        code=p["code"],
        anchors=p["anchors"],
        data_type=p["data_type"],
        regex_pattern=p.get("regex_pattern"),
    )
    for p in json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
    if p["code"] == "M-103"
)
needs_tesseract = pytest.mark.skipif(
    not shutil.which("tesseract"), reason="нет tesseract"
)


@dataclass
class FakeEngine:
    name: str
    words: list[Word] = field(default_factory=list)
    up: bool = True
    boom: bool = False

    def available(self) -> bool:
        return self.up

    def read(self, image):
        if self.boom:
            raise RuntimeError("движок упал")
        return self.words


def w(text, x, conf=90.0, dx=0.0):
    """Слово в строке y=0.1; dx — сдвиг рамки, как у разных движков на одном слове."""
    return Word(text=text, bbox=(x + dx, 0.1, x + 0.08 + dx, 0.12), conf=conf)


BLANK = Image.new("RGB", (100, 100), "white")


# ─────────────────────────────── голосование


@pytest.mark.l1_functional
def test_vote_majority_picks_text_and_marks_disputed():
    """OS-INSP-2.1.5 + 2.1.6: большинство выбирает текст; где движки разошлись — слово сомнительное."""
    engines = [
        FakeEngine("a", [w("Предел", 0.1, 90), w("EI", 0.3, 80), w("30", 0.5, 85)]),
        FakeEngine(
            "b",
            [w("Предел", 0.1, 85, 0.003), w("El", 0.3, 60, 0.002), w("30", 0.5, 90)],
        ),
        # латинская «e» внутри кириллицы и кириллические «ЕІ» — двойники, голос тот же
        FakeEngine(
            "c", [w("Прeдел", 0.1, 80), w("ЕІ", 0.3, 70, -0.002), w("30", 0.5, 88)]
        ),
    ]
    res = oe.run_ensemble(BLANK, engines)
    assert [x.text for x in res.words] == ["Предел", "EI", "30"]
    ei = res.words[1]
    assert ei.disputed and not res.words[0].disputed and not res.words[2].disputed
    assert ei.conf == pytest.approx(
        (80 + 70) / 2 * 2 / 3, abs=0.1
    )  # уверенность снижена долей согласных
    assert res.words[0].conf == pytest.approx(85.0, abs=0.1)
    assert res.disputed_words == 1 and res.agreement == pytest.approx(2 / 3, abs=1e-3)
    assert res.engines == ["a", "b", "c"]


@pytest.mark.l3_boundary
def test_vote_tie_resolved_by_confidence_and_yo_folded():
    """Ничья 1:1 — побеждает уверенный движок; «ё» и «е» — один голос."""
    res = oe.vote(
        {
            "a": [w("B30", 0.1, 70), w("Щётка", 0.4, 60)],
            "b": [w("В3О", 0.1, 95), w("Щетка", 0.4, 90)],
        }
    )
    assert res.words[0].text == "В3О" and res.words[0].disputed
    assert not res.words[1].disputed
    assert res.agreement == 0.5


@pytest.mark.l3_boundary
def test_vote_minority_noise_dropped_but_confident_lone_word_kept():
    """Слово, которое видит один движок из трёх, — шум, если неуверенно; уверенное остаётся сомнительным."""
    res = oe.vote(
        {
            "a": [w("стена", 0.1), w("~", 0.7, 20)],
            "b": [w("стена", 0.1)],
            "c": [w("стена", 0.1), w("М.П.", 0.4, 92)],
        }
    )
    assert [x.text for x in res.words] == ["стена", "М.П."]
    assert res.words[1].disputed and res.words[1].conf == pytest.approx(92 / 3, abs=0.1)


@pytest.mark.l3_boundary
def test_single_engine_has_no_agreement():
    res = oe.vote({"a": [w("стена", 0.1)]})
    assert (
        res.agreement is None and res.disputed_words == 0 and not res.words[0].disputed
    )


@pytest.mark.l1_functional
def test_group_lines_orders_words_geometrically():
    words = [
        Word(text="мин:", bbox=(0.5, 0.2, 0.6, 0.22)),
        Word(text="Предел", bbox=(0.1, 0.201, 0.3, 0.221)),
        Word(text="Паспорт", bbox=(0.1, 0.1, 0.3, 0.12)),
    ]
    assert [ln.text for ln in oe.group_lines(words)] == ["Паспорт", "Предел мин:"]


# ─────────────────────────────── отказ движков (L4)


@pytest.mark.l4_fault
def test_unavailable_and_failing_engines_skipped():
    """Недоступный движок не участвует; упавший выбывает, разбор продолжается на остальных."""
    engines = [
        FakeEngine("a", [w("стена", 0.1)]),
        FakeEngine("gpu", [w("мусор", 0.1)], up=False),
        FakeEngine("crash", boom=True),
        FakeEngine("b", [w("стена", 0.1)]),
    ]
    res = oe.run_ensemble(BLANK, engines)
    assert res.engines == ["a", "b"] and [x.text for x in res.words] == ["стена"]
    assert res.agreement == 1.0


@pytest.mark.l4_fault
def test_no_available_engine_abstains(monkeypatch):
    """0 доступных движков — страница ABSTAIN, а не пустой «OK»."""
    monkeypatch.setattr(oe, "default_engines", lambda: [FakeEngine("x", up=False)])
    doc = parse_file(DOOR, "0" * 64)
    assert (
        doc.pages[0].quality == "ABSTAIN"
        and doc.pages[0].engines == []
        and doc.pages[0].lines == []
    )


@pytest.mark.l4_fault
def test_dev_profile_default_is_tesseract_only(monkeypatch):
    """Профиль dev (мак): три прохода Tesseract; движки профиля gpu сами не включаются (T-184, ML-CONCEPT §3.1 п. 4)."""
    from inspector_ml import ocr_gpu

    monkeypatch.delenv("INSPECTOR_OCR_ENGINES", raising=False)
    monkeypatch.setenv("INSPECTOR_PROFILE", "dev")
    assert [e.name for e in oe.default_engines()] == ["tesseract-psm4", "tesseract-prep", "tesseract-psm6"]
    assert all(isinstance(e, oe.TesseractEngine) for e in ocr_gpu.configured_engines("dev", {}))


# ─────────────────────────────── предобработка


@pytest.mark.l3_boundary
def test_preprocess_deskews_and_maps_boxes_back():
    """Второй «взгляд» — выпрямленный бинарный растр; рамки его слов возвращаются в исходные координаты."""
    img = Image.new("L", (1400, 600), 245)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(str(FONT), 40)
    for i in range(6):
        d.text((80, 60 + i * 80), "Предел огнестойкости дверей EI 30", font=f, fill=20)
    tilted = img.rotate(-2.0, fillcolor=245, resample=Image.Resampling.BICUBIC)
    import numpy as np

    # наклон −2° (по часовой) выпрямляется поворотом на +2° (против часовой, как в OpenCV)
    assert abs(oe.estimate_skew(np.asarray(tilted)) - 2.0) <= 0.3
    out, to_src = oe.preprocess(tilted)
    assert out.mode == "L" and set(np.unique(np.asarray(out))) <= {0, 255}
    # центр — неподвижная точка поворота
    x0, y0, x1, y1 = to_src((690, 290, 710, 310))
    assert abs((x0 + x1) / 2 - 700) < 1 and abs((y0 + y1) / 2 - 300) < 1


# ─────────────────────────────── снижение уверенности значения (OS-INSP-2.1.6)


def _ocr_doc(disputed: bool) -> ParsedDoc:
    texts = [
        "Предел",
        "огнестойкости",
        "противопожарных",
        "дверей,",
        "мин:",
        "EI",
        "30",
    ]
    words = [
        Word(
            text=t,
            bbox=(0.05 + i * 0.1, 0.3, 0.14 + i * 0.1, 0.32),
            conf=90,
            disputed=disputed and t == "EI",
        )
        for i, t in enumerate(texts)
    ]
    page = Page(
        page=1,
        width=595,
        height=842,
        source="ocr",
        ocr_confidence=90,
        lines=[Line(text=" ".join(texts), words=words)],
    )
    return ParsedDoc(sha256="0" * 64, kind="pdf", pages=[page], engine="t")


@pytest.mark.l1_functional
def test_disputed_word_lowers_value_confidence():
    clean = extract(_ocr_doc(False), [M103])[0]
    doubt = extract(_ocr_doc(True), [M103])[0]
    assert clean.value_text == doubt.value_text == "EI30"
    assert doubt.confidence < clean.confidence


# ─────────────────────────────── интеграция: синтетический скан


@needs_tesseract
@pytest.mark.l1_functional
def test_scan_parsed_by_ensemble_keeps_extraction():
    """OS-INSP-2.1.7: скан разбирается ансамблем, значение EI 30 извлекается, у страницы — движки и согласие."""
    doc = parse_file(DOOR, hashlib.sha256(DOOR.read_bytes()).hexdigest())
    p = doc.pages[0]
    assert p.source == "ocr" and p.quality == "OK"
    assert {"tesseract-psm4", "tesseract-prep", "tesseract-psm6"} <= set(p.engines)
    assert p.agreement is not None and 0.0 <= p.agreement <= 1.0
    assert p.disputed_words == sum(w.disputed for ln in p.lines for w in ln.words)
    assert all(e in doc.engine for e in p.engines)
    assert extract(doc, [M103])[0].value_text == "EI30"
