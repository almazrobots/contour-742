"""OS-INSP-2.2.12, TZA-7.1-02: точечное перечитывание сомнительных значений на OCR-страницах.

Регрессия со стенда §14 (фабрика v3): «V» → «\\», «5 257,7» → «5257 5» (и бралось неверное 5257), «171» → «WAL».
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from inspector_ml import reread as R
from inspector_ml.model import Extraction, Line, Page, ParamSpec, ParsedDoc, Word

ROMAN = ParamSpec(
    code="M-022",
    anchors=["Степень огнестойкости"],
    data_type="enum",
    regex_pattern=r"\b(V|IV|III|II|I)\b",
)
AREA = ParamSpec(
    code="M-027", anchors=["Площадь озеленения и газонов"], data_type="number"
)
TEXT = ParamSpec(code="M-099", anchors=["Материал кровли"], data_type="string")
TESS = shutil.which("tesseract") is not None


def line(*words: tuple[str, float, bool], y: float = 0.40) -> Line:
    ws, x = [], 0.10
    for t, conf, disputed in words:
        w = 0.012 * max(2, len(t))
        ws.append(
            Word(text=t, bbox=(x, y, x + w, y + 0.012), conf=conf, disputed=disputed)
        )
        x += w + 0.01
    return Line(text=" ".join(t for t, _, _ in words), words=ws)


def doc(*lines: Line, source: str = "ocr") -> ParsedDoc:
    return ParsedDoc(
        sha256="x",
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=1, width=595, height=842, source=source, lines=list(lines))],
    )


class FakeOcr:
    """Ответы по вариантам предобработки: i-й вызов → i-й ответ; ведёт счёт вызовов."""

    def __init__(self, *answers: str) -> None:
        self.answers, self.calls, self.allowed = list(answers), 0, []

    def __call__(self, img: Image.Image, allowed: str) -> list[R.Reading]:
        self.allowed.append(allowed)
        text = self.answers[self.calls % len(self.answers)]
        self.calls += 1
        return (
            [R.Reading(t, 90.0, (0.1, 0.2, 0.9, 0.8)) for t in text.split()]
            if text
            else []
        )


def test_gpu_reread_never_uses_tesseract_and_requires_second_voice(monkeypatch):
    from inspector_ml import ocr_ensemble, ocr_gpu
    from types import SimpleNamespace
    monkeypatch.setenv('INSPECTOR_PROFILE','gpu')
    monkeypatch.setattr(R.shutil,'which',lambda _: pytest.fail('GPU must not discover Tesseract'))
    monkeypatch.setattr(ocr_gpu,'engine_names',lambda _: ['anchor','reader'])
    monkeypatch.setattr(ocr_ensemble,'run_ensemble',lambda _: SimpleNamespace(
        engines=['anchor'],execution_failures=[],words=[]))
    with pytest.raises(RuntimeError,match='mandatory GPU reread'):
        R.gpu_line(PAGE_IMG,'0123456789')
    monkeypatch.setattr(ocr_ensemble,'run_ensemble',lambda _: SimpleNamespace(
        engines=['anchor','reader'],execution_failures=[],words=[Word(text='12',conf=95)]))
    assert R.gpu_line(PAGE_IMG,'0123456789')[0].text=='12'


def test_zone_reread_does_not_request_whole_page_and_maps_coordinates():
    calls=[]
    def zone_image(number, box):
        calls.append((number,box))
        return Image.new('L',(500,100),255),(.2,0,0,.1,.3,.35)
    got=R.refine(doc(ROMAN_BAD),[ROMAN],[],lambda _: pytest.fail('whole page raster requested'),
                 FakeOcr('V','V','V'),zone_image_of=zone_image)
    assert calls and len(got)==1 and got[0].raw=='V'
    assert .3 <= got[0].bbox[0] <= got[0].bbox[2] <= .5


PAGE_IMG = Image.new("L", (600, 850), 255)
ROMAN_BAD = line(("Степень", 96, False), ("огнестойкости", 95, False), ("\\", 59, True))
AREA_BAD = line(
    ("Площадь", 96, False),
    ("озеленения", 95, False),
    ("и", 95, False),
    ("газонов", 95, False),
    ("м?", 61, True),
    ("5257", 0, True),
    ("5", 32, True),
)


# ─────────────────────────────── тип значения


@pytest.mark.l1_functional
def test_whitelist_and_validate_by_type():
    assert R.whitelist(AREA) == R.NUM_WHITELIST
    assert (
        R.whitelist(ROMAN) == ""
    )  # перечисление читается без ограничения набора, отбирает валидатор
    assert R.whitelist(TEXT) is None
    assert (
        R.whitelist(
            ParamSpec(
                code="X",
                anchors=["a"],
                data_type="string",
                regex_pattern=r"\d{2}-[A-Z]+",
            )
        )
        is None
    )
    assert (
        R.validate(AREA, "5 257,7") == "5 257,7" and R.validate(AREA, "171.") == "171"
    )
    assert (
        R.validate(AREA, "257,7 x") is None
        and R.validate(AREA, "WAL") is None
        and R.validate(AREA, "") is None
    )
    assert R.validate(ROMAN, "V") == "V" and R.validate(ROMAN, "VI") is None
    assert (
        R.validate(ROMAN, "І") == "I" and R.validate(ROMAN, "|V") == "IV"
    )  # кириллическая «І», черта вместо I
    assert R.validate(TEXT, "металл") is None


@pytest.mark.l3_boundary
def test_literals_only_for_plain_alternation():
    assert R._literals(r"\b(V|IV|III|II|I)\b") == ["V", "IV", "III", "II", "I"]
    assert R._literals(r"(?:A1|A2)") == ["A1", "A2"]
    assert R._literals(r"\b(\d+|X)\b") is None
    assert (
        R.validate(
            ParamSpec(
                code="X", anchors=["a"], data_type="string", regex_pattern=r"[A-Z]{2}\d"
            ),
            "AB1",
        )
        == "AB1"
    )


# ─────────────────────────────── где значение и когда перечитывать


@pytest.mark.l1_functional
def test_value_words_skip_leading_unit_and_zone_covers_value_with_margins():
    hit = R.anchor_line(doc(AREA_BAD).pages[0], AREA)
    assert hit is not None
    ln, after = hit
    idx = R.value_words(ln, after)
    assert [ln.words[i].text for i in idx] == [
        "5257",
        "5",
    ]  # «м?» — единица, не значение
    z = R.value_zone(ln, idx)
    v0, v1 = ln.words[idx[0]].bbox, ln.words[idx[-1]].bbox
    assert z[0] < v0[0] and z[2] > v1[2] and z[1] < v0[1] and z[3] > v0[3]
    assert R.value_zone(ln, []) is None


@pytest.mark.l3_boundary
def test_doubtful_on_disputed_or_low_confidence_only():
    ok = line(
        ("Площадь", 96, False),
        ("озеленения", 95, False),
        ("и", 95, False),
        ("газонов", 95, False),
        ("338", 96, False),
    )
    assert not R.doubtful(ok, [4])
    assert R.doubtful(line(("338", 96, True)), [0])
    assert R.doubtful(line(("338", R.REREAD_CONF - 0.1, False)), [0])
    assert not R.doubtful(line(("338", R.REREAD_CONF, False)), [0])


# ─────────────────────────────── голосование и страховка


@pytest.mark.l1_functional
def test_two_variants_agree_on_value_not_text():
    got = R.reread_zone(
        PAGE_IMG,
        (0.5, 0.3, 0.7, 0.35),
        AREA,
        FakeOcr("5 257,7", "5 2577", "5 257.7"),
        prior="5257 5",
    )
    assert got is not None and got[:2] == (
        "5 257,7",
        2,
    )  # «5 257,7» и «5 257.7» — одно число; текст первого


@pytest.mark.l6_adversarial
def test_agreement_on_value_that_loses_digits_is_refused():
    # два варианта потеряли первую «5»: 257,7 = 257.7, но ансамбль видел пять цифр — ложную находку не берём
    assert (
        R.reread_zone(
            PAGE_IMG,
            (0.5, 0.3, 0.7, 0.35),
            AREA,
            FakeOcr("257,7", "257.7", "3 257,7"),
            prior="5257 5",
        )
        is None
    )
    assert R.consistent("5257 5", "5 257,7") and not R.consistent("5257 5", "257,7")
    assert R.consistent("WAL", "171") and R.consistent(None, "171")


@pytest.mark.l3_boundary
def test_no_majority_or_tie_or_tiny_zone_gives_nothing():
    z = (0.5, 0.3, 0.7, 0.35)
    assert R.reread_zone(PAGE_IMG, z, AREA, FakeOcr("171", "172", "173")) is None
    assert R.reread_zone(PAGE_IMG, z, AREA, FakeOcr("171", "172", "")) is None
    assert (
        R.reread_zone(PAGE_IMG, (0.5, 0.3, 0.502, 0.35), AREA, FakeOcr("171")) is None
    )
    assert R.reread_zone(PAGE_IMG, z, TEXT, FakeOcr("металл")) is None  # тип не покрыт


@pytest.mark.l4_fault
def test_ocr_failure_in_one_variant_is_tolerated():
    calls = {"n": 0}

    def flaky(img, allowed):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("tesseract упал")
        return [R.Reading("171", 90.0, (0.1, 0.1, 0.9, 0.9))]

    got = R.reread_zone(PAGE_IMG, (0.5, 0.3, 0.7, 0.35), AREA, flaky)
    assert got is not None and got[:2] == ("171", 2)


@pytest.mark.l1_functional
def test_value_box_maps_back_inside_zone():
    z = (0.5, 0.3, 0.7, 0.36)
    _, _, box = R.reread_zone(PAGE_IMG, z, AREA, FakeOcr("171", "171", "171"))
    assert (
        z[0] - 0.01 <= box[0] < box[2] <= z[2] + 0.01
        and z[1] - 0.01 <= box[1] < box[3] <= z[3] + 0.01
    )


# ─────────────────────────────── уточнение документа


@pytest.mark.l1_functional
def test_missing_value_is_reread_with_page_bbox_and_reason():
    ocr = FakeOcr("V")
    (e,) = R.refine(doc(ROMAN_BAD), [ROMAN], [], lambda n: PAGE_IMG, ocr)
    assert (e.code, e.raw, e.value_text, e.match, e.page, e.confidence) == (
        "M-022",
        "V",
        "V",
        "reread",
        1,
        0.9,
    )
    assert (
        e.bbox is not None
        and e.anchor_bbox is not None
        and e.anchor_bbox[2] <= e.bbox[2]
    )
    assert ocr.allowed == ["", "", ""]  # перечисление — без белого списка


@pytest.mark.l1_functional
def test_doubtful_wrong_value_is_replaced_and_number_parsed():
    wrong = Extraction(
        code="M-027",
        raw="5257",
        value_num=5257.0,
        page=1,
        bbox=AREA_BAD.words[5].bbox,
        line_text=AREA_BAD.text,
        confidence=0.54,
    )
    ocr = FakeOcr("5 257,7", "5 257,7", "5 257.7")
    (e,) = R.refine(doc(AREA_BAD), [AREA], [wrong], lambda n: PAGE_IMG, ocr)
    assert (e.raw, e.value_num, e.match, e.confidence) == (
        "5 257,7",
        5257.7,
        "reread",
        0.9,
    )
    assert set(ocr.allowed) == {R.NUM_WHITELIST}


@pytest.mark.l6_adversarial
def test_reliable_semantic_text_page_and_unreadable_are_left_alone():
    good_line = line(
        ("Площадь", 96, False),
        ("озеленения", 95, False),
        ("и", 95, False),
        ("газонов", 95, False),
        ("338", 96, False),
    )
    good = Extraction(
        code="M-027",
        raw="338",
        value_num=338.0,
        page=1,
        bbox=good_line.words[4].bbox,
        line_text=good_line.text,
        confidence=0.93,
    )
    ocr = FakeOcr("999")
    assert (
        R.refine(doc(good_line), [AREA], [good], lambda n: PAGE_IMG, ocr) == [good]
        and ocr.calls == 0
    )
    sem = good.model_copy(update={"match": "semantic"})
    assert (
        R.refine(doc(AREA_BAD), [AREA], [sem], lambda n: PAGE_IMG, ocr) == [sem]
        and ocr.calls == 0
    )
    assert (
        R.refine(doc(ROMAN_BAD, source="text"), [ROMAN], [], lambda n: PAGE_IMG, ocr)
        == []
        and ocr.calls == 0
    )
    assert (
        R.refine(doc(ROMAN_BAD), [ROMAN], [], lambda n: None, ocr) == []
    )  # растра нет — не угадываем
    assert (
        R.refine(
            doc(ROMAN_BAD), [ROMAN], [], lambda n: PAGE_IMG, FakeOcr("VI", "VII", "X")
        )
        == []
    )  # не литерал Матрицы
    assert (
        R.refine(doc(ROMAN_BAD), [TEXT], [], lambda n: PAGE_IMG, ocr) == []
        and ocr.calls == 0
    )  # тип не покрыт


@pytest.mark.l3_boundary
def test_value_absent_from_line_reads_zone_right_of_anchor():
    only_anchor = line(("Степень", 96, False), ("огнестойкости", 95, False))
    ocr = FakeOcr("IV")
    (e,) = R.refine(doc(only_anchor), [ROMAN], [], lambda n: PAGE_IMG, ocr)
    assert e.raw == "IV" and e.bbox[0] >= only_anchor.words[-1].bbox[2] - 0.01


@pytest.mark.l7_discipline
def test_without_tesseract_extraction_is_unchanged(monkeypatch):
    monkeypatch.setattr(R.shutil, "which", lambda _: None)
    assert R.refine(doc(ROMAN_BAD), [ROMAN], [], lambda n: PAGE_IMG) == []


# ─────────────────────────────── линии таблицы


@pytest.mark.l2_differential
def test_tilted_table_rule_removed_digits_kept():
    img = Image.new("L", (400, 120), 255)
    d = ImageDraw.Draw(img)
    d.line((10, 20, 390, 25), fill=0, width=3)  # наклонная линия таблицы над значением
    d.line(
        (20, 5, 23, 115), fill=0, width=3
    )  # наклонные вертикальные границы ячейки слева и справа
    d.line((380, 5, 377, 115), fill=0, width=3)
    for x in range(
        60, 300, 40
    ):  # «цифры»: короткие вертикальные и горизонтальные штрихи с просветами
        d.rectangle((x, 50, x + 20, 90), outline=0, width=4)
    g = np.asarray(img)
    g2, b2 = R.strip_rules(g, R._otsu(g))
    assert (b2[15:32, :] < 128).sum() == 0  # линия ушла целиком, несмотря на наклон
    assert (b2[50:91, 55:305] < 128).sum() == (
        g[50:91, 55:305] < 128
    ).sum()  # штрихи «цифр» не тронуты
    assert (g2[15:32, :] < 128).sum() == 0
    assert (b2[:, 15:30] < 128).sum() == 0 and (
        b2[:, 370:386] < 128
    ).sum() == 0  # границы ячейки — тоже


# ─────────────────────────────── регрессия на сканах стенда §14 (реальный Tesseract)


@pytest.mark.l2_differential
@pytest.mark.skipif(not TESS, reason="нет tesseract")
def test_factory_v3_scans_lost_values_are_recovered(tmp_path):
    from inspector_ml.parse import parse_file
    from synth import factory as F
    from synth.factory_v3 import TAG, make_object

    cases = {
        1: ("ID", "M-022", "V"),
        # объект 6 (M-027) выбыл 27.09 (T-129): шкала М-023 в Матрице сдвинула генератор фабрики v3, и значение читается
        # сразу; поиск по объектам 2–29 нашёл потерю OCR только у объекта 27 — он и остаётся свидетелем перечитывания
        # объект 27 (M-120) 29.09 читается сразу (match=lexical): T-233 сдвинул генератор; поиск по объектам 2–44 (T-233)
        # нашёл потерю OCR, которую перечитывание возвращает, у объектов 32 и 41 — они и свидетели
        32: ("RD", "M-001", "2 031,3"),
        41: ("ID", "M-051", "101,8"),
    }
    from eval.run import load_matrix, specs

    S = {s.code: s for s in specs(load_matrix())}
    for i, (stage, code, want) in cases.items():
        gold = F.build_object(1, i, tmp_path, make=make_object, tag=TAG)
        f = tmp_path / gold["object_id"] / f"{gold['object_id']}-{stage}.pdf"
        d = parse_file(f, hashlib.sha256(f.read_bytes()).hexdigest())
        got = {e.code: e for e in R.extract_refined(f, d, [S[code]])}
        g = next(
            v
            for v in gold["values"]
            if v["param"] == code and v["file_id"].endswith(stage)
        )
        assert json.dumps(g["raw"], ensure_ascii=False) == json.dumps(
            want, ensure_ascii=False
        )
        e = got.get(code)
        assert e is not None and e.raw == want, (code, e)
        assert e.match in ({"reread"} if code == "M-022" else {"reread", "lexical"}), (code, e)
        gb = g["bbox"]
        ix = max(0, min(e.bbox[2], gb[2]) - max(e.bbox[0], gb[0])) * max(
            0, min(e.bbox[3], gb[3]) - max(e.bbox[1], gb[1])
        )
        area = lambda b: (b[2] - b[0]) * (b[3] - b[1])  # noqa: E731
        assert ix / (area(e.bbox) + area(gb) - ix) >= 0.5, (
            code,
            e.bbox,
            gb,
        )  # IoU ≥ 0,5 — порог локализации §14


@pytest.mark.l7_discipline
@pytest.mark.skipif(not TESS, reason="нет tesseract")
def test_page_raster_matches_ocr_render(tmp_path):
    from inspector_ml.parse import OCR_DPI, page_raster, parse_file

    img = Image.new("L", (850, 1100), 255)
    ImageDraw.Draw(img).text((100, 100), "Площадь 171", fill=0)
    f = tmp_path / "scan.png"
    img.save(f, dpi=(100, 100))
    d = parse_file(f, hashlib.sha256(f.read_bytes()).hexdigest())
    r = page_raster(f, d, 1)
    assert r is not None and r.size == (
        round(850 * OCR_DPI / 100),
        round(1100 * OCR_DPI / 100),
    )
    assert (
        page_raster(f, d, 2) is None and page_raster(tmp_path / "нет.png", d, 1) is None
    )


@pytest.mark.l6_adversarial
def test_line_of_other_param_or_closer_rival_is_not_reread():
    # стенд §14 v3: «Ширина эвакуационного выхода м 0,85» перечитывалась как ширина коридора (M-040) — ложная находка
    corridor = ParamSpec(
        code="M-040",
        anchors=["Ширина эвакуационного коридора", "Ширина коридора"],
        data_type="number",
    )
    exit_ = ParamSpec(
        code="M-041", anchors=["Ширина эвакуационного выхода"], data_type="number"
    )
    ln = line(
        ("Ширина", 96, False),
        ("эвакуационного", 95, False),
        ("выхода", 95, False),
        ("м", 90, False),
        ("0,85", 60, True),
    )
    ocr = FakeOcr("0,85")
    # строку лексически забрал соперник — для M-040 она не перечитывается
    got_exit = Extraction(
        code="M-041",
        raw="0,85",
        value_num=0.85,
        page=1,
        bbox=ln.words[4].bbox,
        line_text=ln.text,
        confidence=0.6,
    )
    out = R.refine(doc(ln), [corridor, exit_], [got_exit], lambda n: PAGE_IMG, ocr)
    assert [e.code for e in out] == ["M-041"] and all(e.code != "M-040" for e in out)
    # строка не досталась никому, но подпись ближе к сопернику — тоже нет
    out = R.refine(doc(ln), [corridor, exit_], [], lambda n: PAGE_IMG, FakeOcr("0,85"))
    assert [e.code for e in out] == ["M-041"]


@pytest.mark.l2_differential
def test_confirmed_value_keeps_ensemble_record_and_box():
    # стенд §14 v2: перечитывание подтвердило значение, но его рамка выше строки — IoU падал ниже 0,5
    ln = line(
        ("Площадь", 96, False),
        ("озеленения", 95, False),
        ("и", 95, False),
        ("газонов", 95, False),
        ("338", 60, True),
    )
    cur = Extraction(
        code="M-027",
        raw="338",
        value_num=338.0,
        page=1,
        bbox=ln.words[4].bbox,
        line_text=ln.text,
        confidence=0.5,
    )
    (e,) = R.refine(doc(ln), [AREA], [cur], lambda n: PAGE_IMG, FakeOcr("338"))
    assert e.bbox == cur.bbox and e.match == "lexical" and e.confidence == 0.9


@pytest.mark.l3_boundary
def test_new_value_box_takes_height_from_line_words():
    (e,) = R.refine(doc(ROMAN_BAD), [ROMAN], [], lambda n: PAGE_IMG, FakeOcr("V"))
    w = ROMAN_BAD.words[2].bbox
    assert (e.bbox[1], e.bbox[3]) == (w[1], w[3])


# ─────────────────────────────── контракты, найденные мутационным прогоном


@pytest.mark.l1_functional
def test_tesseract_command_by_type():
    assert R.tesseract_args("v.png", R.NUM_WHITELIST) == [
        "tesseract",
        "v.png",
        "-",
        "-l",
        "rus+eng",
        "--psm",
        "7",
        "--dpi",
        "300",
        "-c",
        f"tessedit_char_whitelist={R.NUM_WHITELIST}",
        "tsv",
    ]
    assert R.tesseract_args("v.png", "") == [
        "tesseract",
        "v.png",
        "-",
        "-l",
        "rus+eng",
        "--psm",
        "8",
        "--dpi",
        "300",
        "tsv",
    ]


@pytest.mark.l7_discipline
def test_tesseract_runs_bounded_single_thread_and_checked(monkeypatch):
    seen = {}

    class Done:
        stdout = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"

    def run(args, **kw):
        seen.update(kw, args=args)
        return Done()

    monkeypatch.setattr(R.subprocess, "run", run)
    assert R.tesseract_line(Image.new("L", (40, 20), 255), R.NUM_WHITELIST) == []
    assert (
        seen["check"] is True
        and seen["timeout"] == R.TESS_TIMEOUT
        and seen["env"]["OMP_THREAD_LIMIT"] == "1"
    )
    assert seen["args"][1].endswith(".png") and seen["text"] is True


@pytest.mark.l1_functional
def test_parse_tsv_words_boxes_and_filters():
    tsv = "\n".join(
        [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "4\t1\t1\t1\t1\t0\t0\t0\t200\t50\t-1\t",
            "5\t1\t1\t1\t1\t1\t10\t5\t30\t20\t91.5\t5",
            "5\t1\t1\t1\t1\t2\t50\t10\t60\t30\t-1\t257,7",
            "5\t1\t1\t1\t1\t3\t0\t0\t10\t10\t80\t ",
            "5\t1\t1",
        ]
    )
    a, b = R.parse_tsv(tsv, 200, 50)
    assert (a.text, a.conf, a.bbox) == ("5", 91.5, (0.05, 0.1, 0.2, 0.5))
    assert (b.text, b.conf, b.bbox) == ("257,7", 0.0, (0.25, 0.2, 0.55, 0.8))


@pytest.mark.l1_functional
def test_variants_scale_line_to_target_height_with_border():
    vs = R.variants(Image.new("L", (100, 20), 255))
    k = R.TARGET_H / 20
    assert len(vs) == 3 and all(
        v.size == (round(100 * k) + 48, round(20 * k) + 48) for v in vs
    )
    big = R.variants(Image.new("L", (100, 200), 255))[0]
    assert big.size == (200 + 48, 400 + 48)  # не меньше двукратного увеличения


@pytest.mark.l1_functional
def test_page_box_of_value_matches_drawn_value():
    # на листе 600×850 «значение» — чёрный прямоугольник; OCR-заглушка находит его в варианте по пикселям,
    # отображение рамки обратно на лист обязано вернуть его место (±1,5 px)
    img = Image.new("L", (600, 850), 255)
    ImageDraw.Draw(img).rectangle((330, 260, 369, 279), fill=0)

    def pixel_ocr(v, allowed):
        a = np.asarray(v) < 128
        ys, xs = np.nonzero(a)
        w, h = v.size
        return [
            R.Reading(
                "171",
                90.0,
                (xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h),
            )
        ]

    _, _, box = R.reread_zone(img, (0.5, 0.29, 0.7, 0.35), AREA, pixel_ocr)
    want = (330 / 600, 260 / 850, 370 / 600, 280 / 850)
    assert all(
        abs(b - w) * s <= 1.5 for b, w, s in zip(box, want, (600, 850, 600, 850))
    ), (box, want)


@pytest.mark.l4_fault
def test_words_without_boxes_fall_back_to_zone():
    z = (0.5, 0.3, 0.7, 0.35)

    def no_box(v, allowed):
        return [R.Reading("171", 90.0, None)]

    assert R.reread_zone(PAGE_IMG, z, AREA, no_box) == ("171", 3, z)


@pytest.mark.l3_boundary
def test_zone_size_boundary_four_pixels():
    ocr = FakeOcr("171")
    assert (
        R.reread_zone(PAGE_IMG, (0.5, 0.3, 0.5 + 4 / 600, 0.3 + 4 / 850), AREA, ocr)
        is not None
    )
    assert R.reread_zone(PAGE_IMG, (0.5, 0.3, 0.5 + 3 / 600, 0.35), AREA, ocr) is None
    assert R.reread_zone(PAGE_IMG, (0.5, 0.3, 0.7, 0.3 + 3 / 850), AREA, ocr) is None


@pytest.mark.l1_functional
def test_zone_after_anchor_and_value_zone_exact():
    ln = line(("Степень", 96, False), ("огнестойкости", 95, False))
    x2 = ln.words[-1].bbox[2]
    z = R.zone_after_anchor(ln)
    dy = 0.012 * R.PAD_Y
    assert z == pytest.approx((x2 + R.PAD_X, 0.40 - dy, x2 + 0.25, 0.412 + dy))
    edge = line(("Степень", 96, False), ("огнестойкости", 95, False), y=0.995)
    edge.words[-1].bbox = (0.9, 0.995, 0.99, 1.0)
    assert R.zone_after_anchor(edge)[2:] == (1.0, 1.0)  # не выходит за лист
    assert R.zone_after_anchor(Line(text="", words=[Word(text="x")])) is None
    v = line(("338", 96, False))
    b = v.words[0].bbox
    assert R.value_zone(v, [0]) == pytest.approx(
        (b[0] - R.PAD_X, 0.40 - dy, b[2] + 3 * R.PAD_X, 0.412 + dy)
    )
    v.words[0].bbox = (0.97, 0.99, 0.999, 1.0)
    assert R.value_zone(v, [0])[2:] == (1.0, 1.0)


@pytest.mark.l3_boundary
def test_word_spans_with_repeated_words_and_units_with_colon():
    ln = line(("1", 90, False), ("1", 90, False), ("10", 90, False))
    assert R._word_spans(ln) == [(0, 1), (2, 3), (4, 6)]
    assert R._word_spans(Line(text="", words=[])) == []
    u = line(("Площадь", 96, False), ("шт.:", 90, False), ("171", 90, False))
    assert R.value_words(u, len("Площадь")) == [
        2
    ]  # единица с двоеточием — тоже единица


@pytest.mark.l3_boundary
def test_consistency_tolerance_scales_with_digit_count():
    assert R._digits("5 257,7") == "52577"
    assert R.consistent("12 345 678", "12 345 699")  # 8 цифр — допускается 2 отличия
    assert not R.consistent("12 345 678", "12 399 999")
    assert not R.consistent("1234", "1299")  # 4 цифры — одно отличие
    assert R.consistent("1234", "1239")


@pytest.mark.l1_functional
def test_validate_literals_with_x_and_generic_regex_reject():
    spec = ParamSpec(
        code="X", anchors=["a"], data_type="enum", regex_pattern=r"\b(X|XI)\b"
    )
    assert (
        R.validate(spec, "X") == "X" and R.validate(spec, "Х") == "X"
    )  # кириллическая «Х»
    gen = ParamSpec(
        code="Y", anchors=["a"], data_type="string", regex_pattern=r"[A-Z]{2}\d"
    )
    assert R.validate(gen, "A11") is None
    assert R._literals(r"(A|B)C") is None and R._literals(r"\b(ф|Ж)\b") == ["ф", "Ж"]
    assert R._literals(r"\b(ф|Ж)\b") == ["ф", "Ж"]
    assert R.vote_key(ROMAN, "IV") == "IV" and R.vote_key(
        AREA, "5 257,7"
    ) == R.vote_key(AREA, "5257.7")


@pytest.mark.l1_functional
def test_new_record_fields_and_anchor_box():
    (e,) = R.refine(doc(ROMAN_BAD), [ROMAN], [], lambda n: PAGE_IMG, FakeOcr("V"))
    a, b = ROMAN_BAD.words[0].bbox, ROMAN_BAD.words[1].bbox
    assert (
        e.anchor_bbox == (a[0], a[1], b[2], b[3])
        and e.value_num is None
        and e.value_text == "V"
    )
    nobox = Line(
        text="Степень огнестойкости \\",
        words=[
            Word(text="Степень"),
            Word(text="огнестойкости", bbox=b),
            Word(text="\\", bbox=ROMAN_BAD.words[2].bbox, conf=10),
        ],
    )
    (e2,) = R.refine(doc(nobox), [ROMAN], [], lambda n: PAGE_IMG, FakeOcr("V"))
    assert e2.anchor_bbox == b
    (n,) = R.refine(doc(AREA_BAD), [AREA], [], lambda n: PAGE_IMG, FakeOcr("5 257,7"))
    assert n.value_num == 5257.7 and n.value_text is None and n.confidence == 0.9


@pytest.mark.l3_boundary
def test_refine_walks_all_specs_and_pages():
    empty_page = Page(
        page=1, width=595, height=842, source="ocr", lines=[line(("Прочее", 90, False))]
    )
    no_lines = Page(page=2, width=595, height=842, source="ocr", lines=[])
    target = Page(page=3, width=595, height=842, source="ocr", lines=[ROMAN_BAD])
    d = ParsedDoc(
        sha256="x", kind="pdf", engine="pdfium", pages=[empty_page, no_lines, target]
    )
    out = R.refine(
        d, [TEXT, ROMAN], [], lambda n: PAGE_IMG, FakeOcr("V")
    )  # непокрытый тип первым — поиск идёт дальше
    assert [(e.code, e.page) for e in out] == [("M-022", 3)]
    # первая подходящая строка занята соперником — берётся следующая страница
    other = Extraction(
        code="M-099",
        raw="?",
        page=1,
        bbox=None,
        line_text=ROMAN_BAD.text,
        confidence=0.5,
    )
    d2 = ParsedDoc(
        sha256="x",
        kind="pdf",
        engine="pdfium",
        pages=[
            Page(page=1, width=1, height=1, source="ocr", lines=[ROMAN_BAD]),
            target,
        ],
    )
    assert [
        (e.code, e.page)
        for e in R.refine(d2, [ROMAN], [other], lambda n: PAGE_IMG, FakeOcr("V"))
        if e.code == "M-022"
    ] == [("M-022", 3)]


@pytest.mark.l6_adversarial
def test_current_record_is_only_reread_on_its_own_line_and_semantic_is_skipped():
    other_line = line(
        ("Площадь", 96, False),
        ("озеленения", 95, False),
        ("и", 95, False),
        ("газонов", 95, False),
        ("338", 96, False),
        y=0.6,
    )
    cur = Extraction(
        code="M-027",
        raw="338",
        value_num=338.0,
        page=1,
        bbox=other_line.words[4].bbox,
        line_text=other_line.text,
        confidence=0.9,
    )
    ocr = FakeOcr("5 257,7")
    # якорная строка страницы — сомнительная AREA_BAD, но запись взята с другой строки: её не трогаем
    d = ParsedDoc(
        sha256="x",
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=1, width=1, height=1, source="ocr", lines=[AREA_BAD])],
    )
    assert (
        R.refine(d, [AREA], [cur], lambda n: PAGE_IMG, ocr) == [cur] and ocr.calls == 0
    )
    sem = Extraction(
        code="M-027",
        raw="5257",
        value_num=5257.0,
        page=1,
        bbox=None,
        line_text=AREA_BAD.text,
        confidence=0.7,
        match="semantic",
    )
    assert (
        R.refine(doc(AREA_BAD), [AREA], [sem], lambda n: PAGE_IMG, ocr) == [sem]
        and ocr.calls == 0
    )
    txt = Extraction(
        code="M-022",
        raw="\\",
        page=1,
        bbox=None,
        line_text=ROMAN_BAD.text,
        confidence=0.3,
    )
    assert (
        R.refine(doc(ROMAN_BAD, source="text"), [ROMAN], [txt], lambda n: PAGE_IMG, ocr)
        == [txt]
        and ocr.calls == 0
    )


@pytest.mark.l6_adversarial
def test_refine_refuses_reading_that_contradicts_ensemble_digits():
    wrong = Extraction(
        code="M-027",
        raw="5257",
        value_num=5257.0,
        page=1,
        bbox=AREA_BAD.words[5].bbox,
        line_text=AREA_BAD.text,
        confidence=0.54,
    )
    assert R.refine(
        doc(AREA_BAD), [AREA], [wrong], lambda n: PAGE_IMG, FakeOcr("257,7")
    ) == [wrong]


@pytest.mark.l7_discipline
def test_extract_refined_passes_embedder_and_page_raster(monkeypatch, tmp_path):
    import inspector_ml.extract as X
    import inspector_ml.parse as P

    seen = {}
    monkeypatch.setattr(
        X,
        "extract",
        lambda d, s, e=None, timings=None: seen.setdefault("emb", e) and [],
    )
    monkeypatch.setattr(
        P,
        "page_raster",
        lambda path, d, n: seen.setdefault("raster", (path, n)) and None,
    )
    emb = object()
    assert R.extract_refined(tmp_path / "f.pdf", doc(ROMAN_BAD), [ROMAN], emb) == []
    assert seen["emb"] is emb
    if TESS:
        assert seen["raster"] == (tmp_path / "f.pdf", 1)


@pytest.mark.l3_boundary
def test_equal_anchor_lines_first_wins_and_boxless_line_skipped():
    first = line(
        ("Степень", 96, False), ("огнестойкости", 95, False), ("\\", 50, True), y=0.3
    )
    second = line(
        ("Степень", 96, False), ("огнестойкости", 95, False), ("\\", 50, True), y=0.6
    )
    got = R.anchor_line(
        Page(page=1, width=1, height=1, source="ocr", lines=[first, second]), ROMAN
    )
    assert got is not None and got[0] is first
    # на первой странице у строки нет рамок — зону не построить; берётся следующая страница
    boxless = Line(
        text="Степень огнестойкости",
        words=[Word(text="Степень"), Word(text="огнестойкости")],
    )
    d = ParsedDoc(
        sha256="x",
        kind="pdf",
        engine="pdfium",
        pages=[
            Page(page=1, width=1, height=1, source="ocr", lines=[boxless]),
            Page(page=2, width=1, height=1, source="ocr", lines=[ROMAN_BAD]),
        ],
    )
    assert [
        (e.code, e.page)
        for e in R.refine(d, [ROMAN], [], lambda n: PAGE_IMG, FakeOcr("V"))
    ] == [("M-022", 2)]


@pytest.mark.l3_boundary
def test_semantic_record_of_one_param_does_not_stop_others_and_boxless_anchor():
    sem = Extraction(
        code="M-027",
        raw="1",
        value_num=1.0,
        page=1,
        bbox=None,
        line_text="x",
        confidence=0.7,
        match="semantic",
    )
    out = R.refine(
        doc(ROMAN_BAD), [AREA, ROMAN], [sem], lambda n: PAGE_IMG, FakeOcr("V")
    )
    assert [e.code for e in out] == ["M-027", "M-022"]
    bare = Line(
        text="Степень огнестойкости \\",
        words=[Word(text="Степень"), Word(text="огнестойкости"), ROMAN_BAD.words[2]],
    )
    (e,) = R.refine(doc(bare), [ROMAN], [], lambda n: PAGE_IMG, FakeOcr("V"))
    assert e.anchor_bbox is None and e.raw == "V"


@pytest.mark.l1_functional
def test_parse_tsv_first_data_row_is_a_word():
    tsv = "h\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t88\tIV"
    (w,) = R.parse_tsv(tsv, 10, 10)
    assert (w.text, w.conf, w.bbox) == ("IV", 88.0, (0.0, 0.0, 1.0, 1.0))


@pytest.mark.l6_adversarial
def test_tie_with_rival_is_refused():
    # подпись одинаково близка к двум параметрам — строка ничья, не перечитывается ни для кого
    a = ParamSpec(code="M-A", anchors=["Площадь покрытия"], data_type="number")
    b = ParamSpec(code="M-B", anchors=["Площадь покрытия"], data_type="number")
    ln = line(("Площадь", 96, False), ("покрытия", 95, False), ("12", 40, True))
    assert R.refine(doc(ln), [a, b], [], lambda n: PAGE_IMG, FakeOcr("12")) == []


@pytest.mark.l7_discipline
def test_page_raster_is_built_once_per_page():
    # рендер страницы — дорогой (pdfium под общим замком); два параметра на одной странице — один растр
    calls = []

    def image_of(n):
        calls.append(n)
        return PAGE_IMG

    out = R.refine(
        doc(ROMAN_BAD, AREA_BAD),
        [ROMAN, AREA],
        [],
        image_of,
        FakeOcr("V", "V", "V", "5 257,7", "5 257,7", "5 257,7"),
    )
    assert [e.code for e in out] == ["M-022", "M-027"] and calls == [1]
