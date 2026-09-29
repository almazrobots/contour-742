"""OCR сканов на GPU и выбор движков конфигурацией (T-184, OS-INSP-2.1.17, 2.1.18).

Движки — детерминированные подделки, изображения — синтетика (ADR-0002: реальных документов в тестах нет)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import itertools

import pytest
from PIL import Image, ImageDraw

from inspector_ml import ocr_ensemble as oe
from inspector_ml import ocr_gpu as og
from inspector_ml.model import Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
DOOR = ROOT / "data/synth/OBJ-SEV-2/SEV-ID-DOOR-1.pdf"
BLANK = Image.new("RGB", (1000, 800), "white")


def w(text, x0, y0, x1, y1, conf=95.0):
    return Word(text=text, bbox=(x0, y0, x1, y1), conf=conf)


@dataclass
class Anchor:
    """Подделка PP-OCR: слова с рамками и поворот страницы."""

    name: str = "ppocr-v5"
    words: list[Word] = field(default_factory=list)
    turns: int = 0
    up: bool = True
    reason: str = ""

    def available(self) -> bool:
        return self.up

    def read_page(self, image):
        return og.EngineReading(self.words, self.turns)

    def read(self, image):
        return self.words


def vl(
    answers: dict[str, str] | None = None,
    default: str | None = None,
    seen: list | None = None,
):
    """Читатель VL с подменой генерации: ответ по размеру кропа не угадать — отвечаем по порядку строк якоря."""
    calls: list = [] if seen is None else seen

    def gen(crop: Image.Image, max_tokens: int) -> str:
        calls.append(crop.size)
        key = f"{len(calls)}"
        return (answers or {}).get(key, default or "")

    return og.VlLineReader("vl-reader", generate=gen, concurrency=1)


# ─────────────────────────────── конфигурация (OS-INSP-2.1.17)


@pytest.mark.l1_functional
def test_default_engines_by_profile():
    """dev (мак) — Tesseract ×3, как было; gpu — PP-OCRv5 на видеокарте + читатель VL, без Tesseract."""
    assert og.engine_names("dev", {}) == og.TESSERACT
    assert og.engine_names("gpu", {}) == ("ppocr-v5", "vl-reader")
    assert not any(n.startswith("tesseract") for n in og.engine_names("gpu", {}))


@pytest.mark.l1_functional
def test_engines_set_by_config_deduplicated():
    env = {og.ENGINES_ENV: " ppocr-v5m , vl-reader,ppocr-v5m "}
    assert og.engine_names("gpu", env) == ("ppocr-v5m", "vl-reader")
    assert og.engine_names("dev", {og.ENGINES_ENV: "tesseract-psm6"}) == (
        "tesseract-psm6",
    )


@pytest.mark.l4_fault
def test_unknown_engine_is_config_error():
    with pytest.raises(og.OcrConfigError, match="неизвестные движки nope"):
        og.engine_names("dev", {og.ENGINES_ENV: "tesseract-psm4,nope"})


@pytest.mark.l4_fault
def test_tesseract_forbidden_in_gpu_profile():
    """Решение владельца 28.09: Tesseract на CPU в профиле gpu — ошибка конфигурации, а не «запасной движок»."""
    with pytest.raises(
        og.OcrConfigError,
        match="tesseract-psm4 — Tesseract на CPU в профиле gpu запрещён",
    ):
        og.engine_names("gpu", {og.ENGINES_ENV: "ppocr-v5,tesseract-psm4"})


# ─────────────────────────────── громкий старт (OS-INSP-2.1.18)


@pytest.fixture
def fake_factories(monkeypatch):
    made = {}

    def reg(name, engine):
        made[name] = engine
        monkeypatch.setitem(og.FACTORIES, name, lambda p, e=engine: e)

    monkeypatch.setattr(og, "_BUILT", {})
    return reg


@pytest.mark.l4_fault
def test_gpu_start_fails_loudly_when_engine_unavailable(fake_factories):
    """Нет CUDA или vLLM — ошибка старта с причиной, а не тихий откат на CPU."""
    fake_factories(
        "ppocr-v5",
        Anchor(up=False, reason="ONNX Runtime без CUDA: ['CPUExecutionProvider']"),
    )
    fake_factories("vl-reader", Anchor(name="vl-reader"))
    with pytest.raises(
        og.OcrConfigError,
        match=r"ppocr-v5 \(ONNX Runtime без CUDA.*откат на CPU запрещён",
    ):
        og.check_ready("gpu", {})


@pytest.mark.l1_functional
def test_gpu_start_ok_and_dev_tolerates_absent_engine(fake_factories):
    fake_factories("ppocr-v5", Anchor())
    fake_factories("vl-reader", Anchor(name="vl-reader"))
    assert og.check_ready("gpu", {}) == ["ppocr-v5", "vl-reader"]
    fake_factories("tesseract-psm4", Anchor(name="tesseract-psm4", up=False))
    assert og.check_ready("dev", {og.ENGINES_ENV: "tesseract-psm4"}) == [
        "tesseract-psm4"
    ]  # dev: выбывает сам


@pytest.mark.l4_fault
def test_stage_parse_fails_before_first_file_in_gpu(fake_factories, monkeypatch):
    from inspector_ml import stages

    fake_factories("ppocr-v5", Anchor(up=False, reason="нет пакета rapidocr"))
    fake_factories("vl-reader", Anchor(name="vl-reader"))
    monkeypatch.setenv("INSPECTOR_PROFILE", "gpu")
    monkeypatch.setattr(
        stages,
        "run_parse",
        lambda limit: pytest.fail("разбор начался с недоступным движком"),
    )
    with pytest.raises(og.OcrConfigError, match="нет пакета rapidocr"):
        stages.main(["parse"])


@pytest.mark.l4_fault
def test_ppocr_without_cuda_is_unavailable_with_reason(monkeypatch):
    """onnxruntime без библиотек CUDA молча уходит на CPU — движок это ловит и объявляет себя недоступным."""
    e = og.PpOcrEngine("ppocr-v5")

    def boom():
        raise RuntimeError("ONNX Runtime без CUDA: ['CPUExecutionProvider']")

    monkeypatch.setattr(e, "_new", boom)
    assert e.available() is False and "без CUDA" in e.reason
    with pytest.raises(RuntimeError, match="без CUDA"):
        e.read_page(BLANK)


@pytest.mark.l4_fault
def test_vl_reader_requires_openai_backend(monkeypatch):
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "none")
    r = og.VlLineReader("vl-reader")
    assert r.available() is False and "openai" in r.reason
    with pytest.raises(RuntimeError, match="только по строкам якоря"):
        r.read(BLANK)


@pytest.mark.l2_differential
def test_ocr_tag_separates_engine_sets():
    """Разбор другими движками — другой ключ кэша и ревизия ML; умолчание dev ключ не меняет."""
    assert og.ocr_tag({"INSPECTOR_PROFILE": "dev"}) == ""
    gpu = og.ocr_tag({"INSPECTOR_PROFILE": "gpu"})
    assert gpu.startswith("-o") and len(gpu) == 10
    assert (
        og.ocr_tag({"INSPECTOR_PROFILE": "gpu", "INSPECTOR_PPOCR_REC": "cyrillic"})
        != gpu
    )
    assert og.ocr_tag({"INSPECTOR_PROFILE": "dev", og.ENGINES_ENV: "ppocr-v5"}) != ""


# ─────────────────────────────── PP-OCR: слова с рамками


@pytest.mark.l1_functional
def test_quad_words_normalised_and_clamped():
    ws = og._quad_words(
        [
            ("Стена", 0.97, [[10, 20], [110, 20], [110, 60], [10, 60]]),
            (" ", 0.9, [[0, 0]] * 4),
            ("край", 0.5, [[-5, 0], [1100, 0], [1100, 900], [-5, 900]]),
        ],
        1000,
        800,
    )
    assert [x.text for x in ws] == ["Стена", "край"]
    assert ws[0].bbox == (0.01, 0.025, 0.11, 0.075) and ws[0].conf == 97.0
    assert ws[1].bbox == (0.0, 0.0, 1.0, 1.0)


@pytest.mark.l3_boundary
def test_split_line_proportional_horizontal_and_vertical():
    """Без рамок слов строка делится по числу символов вдоль длинной стороны."""
    h = og.split_line("ab cdef", [[0, 0], [70, 0], [70, 10], [0, 10]], 0.9, 100, 100)
    assert [t for t, _, _ in h] == ["ab", "cdef"]
    assert (
        h[0][2][0][0] == 0
        and h[0][2][1][0] == pytest.approx(20)
        and h[1][2][0][0] == pytest.approx(30)
    )
    v = og.split_line("ab cdef", [[0, 0], [10, 0], [10, 70], [0, 70]], 0.9, 100, 100)
    assert v[1][2][0][1] == pytest.approx(30) and v[1][2][2][1] == pytest.approx(70)
    assert og.split_line("   ", [[0, 0]] * 4, 0.9, 1, 1) == []


def test_vertical_fallback_preserves_bottom_to_top_word_locations():
    parts=og.split_line('Размер 4200',[[10,20],[20,20],[20,130],[10,130]],.9,200,200,reverse=True)
    label,number=parts
    assert label[0]=='Размер' and number[0]=='4200'
    assert min(p[1] for p in label[2])==pytest.approx(70)
    assert max(p[1] for p in number[2])==pytest.approx(60)
    assert min(p[1] for p in number[2])==20


@pytest.mark.l3_boundary
def test_merge_pieces_follows_line_text():
    """Разрядка: куски RapidOCR «ПРИ», «ЛО», «ЖЕНИЕ» — одно слово строки с общей рамкой и худшей уверенностью."""
    sq = lambda x0, x1: [[x0, 0], [x1, 0], [x1, 10], [x0, 10]]  # noqa: E731
    got = og.merge_pieces(
        "ПРИЛОЖЕНИЕ 1",
        [
            ("ПРИ", 0.9, sq(0, 30)),
            ("ЛО", 0.8, sq(35, 55)),
            ("ЖЕНИЕ", 0.95, sq(60, 110)),
            ("1", 0.99, sq(130, 140)),
        ],
    )
    assert [(t, s, b[0][0], b[1][0]) for t, s, b in got] == [
        ("ПРИЛОЖЕНИЕ", 0.8, 0, 110),
        ("1", 0.99, 130, 140),
    ]
    # кусок, разрезавший слово строки пополам, отдаёт рамку обоим словам; буквы не совпали — запасной путь
    assert [t for t, _, _ in og.merge_pieces("ab cd", [("abcd", 0.9, sq(0, 40))])] == [
        "ab",
        "cd",
    ]
    assert og.merge_pieces("abc", [("abd", 0.9, sq(0, 30))]) is None


# ─────────────────────────────── повёрнутый скан


@pytest.mark.l5_property
@pytest.mark.parametrize("k", [0, 1, 2, 3])
def test_turn_box_matches_pil_rotation_and_inverts(k):
    """Рамка, повёрнутая turn_box, указывает на тот же пиксель, что PIL rotate(90·k, expand=True)."""
    img = Image.new("L", (200, 100), 0)
    ImageDraw.Draw(img).rectangle((30, 10, 49, 29), fill=255)  # пятно 20×20
    box = (30 / 200, 10 / 100, 50 / 200, 30 / 100)
    rot = img.rotate(90 * k, expand=True)
    t = og.turn_box(box, k)
    rw, rh = rot.size
    cx, cy = int((t[0] + t[2]) / 2 * rw), int((t[1] + t[3]) / 2 * rh)
    assert rot.getpixel((cx, cy)) == 255
    back = og.turn_box(t, (4 - k) % 4)
    assert back == pytest.approx(box)


def vertical_line(x, top_down=True, n=3):
    ys = [(0.1 + i * 0.1, 0.18 + i * 0.1) for i in range(n)]
    if not top_down:
        ys = ys[::-1]
    return [w(f"с{i}", x, a, x + 0.03, b) for i, (a, b) in enumerate(ys)]


@pytest.mark.l1_functional
def test_infer_turns():
    horiz = [
        [w("а", 0.1, y, 0.2, y + 0.02), w("б", 0.25, y, 0.35, y + 0.02)]
        for y in (0.1, 0.2, 0.3, 0.4)
    ]
    assert og.infer_turns(horiz) == 0
    assert og.infer_turns([vertical_line(x) for x in (0.1, 0.2, 0.3, 0.4)]) == 1
    assert (
        og.infer_turns([vertical_line(x, top_down=False) for x in (0.1, 0.2, 0.3, 0.4)])
        == 3
    )
    assert (
        og.infer_turns([vertical_line(x) for x in (0.1, 0.2)]) == 1
    )  # небольшой регион сохраняет направление короткой надписи
    assert og.infer_turns([vertical_line(0.2, top_down=False)]) == 3
    assert og.infer_turns([vertical_line(0.2), vertical_line(0.4, top_down=False)]) == 0
    assert og.infer_turns([vertical_line(0.2), *horiz]) == 0
    assert og.infer_turns([]) == 0


@pytest.mark.l1_functional
def test_rotated_scan_lines_grouped_upright_boxes_kept():
    """Скан повёрнут на четверть: строки собираются в кадре прямого текста, рамки слов — в кадре листа."""
    lines = [
        vertical_line(x) for x in (0.6, 0.4, 0.2)
    ]  # сверху вниз: первая строка текста — правый столбец
    words = [x for ln in lines for x in ln]
    res = oe.run_ensemble(BLANK, [Anchor(words=words, turns=1)])
    assert res.turns == 1 and res.lines is not None
    assert [ln.text for ln in res.lines] == ["с0 с1 с2"] * 3
    xs = [ln.words[0].bbox[0] for ln in res.lines]
    assert xs == [0.6, 0.4, 0.2]  # порядок строк прямого текста, рамки исходные


# ─────────────────────────────── выравнивание прочтения VL со строкой якоря


def ws_line(*texts):
    return [w(t, 0.1 * i, 0.1, 0.1 * i + 0.08, 0.12) for i, t in enumerate(texts)]


@pytest.mark.l1_functional
def test_align_equal_and_substitution_get_anchor_boxes():
    a = ws_line("Предел", "EI", "30")
    out = og.align_tokens(a, ["Предел", "El", "30"], oe.vote_key)
    assert [x.text for x in out] == ["Предел", "El", "30"]
    assert [x.bbox for x in out] == [x.bbox for x in a] and all(
        x.conf == og.VL_CONF for x in out
    )


@pytest.mark.l3_boundary
def test_align_split_merge_insert_delete():
    a = ws_line("класс", "С0,", "здания")
    # краевая пунктуация — не расхождение (vote_key): «С0» совпало со словом якоря, отдельная «,» без рамки отброшена
    out = og.align_tokens(a, ["класс", "С0", ",", "здания"], oe.vote_key)
    assert [(x.text, x.bbox) for x in out] == [
        ("класс", a[0].bbox),
        ("С0", a[1].bbox),
        ("здания", a[2].bbox),
    ]
    # якорь «EI30» одним словом, читатель — «EI 30»: склеиваются в один голос за это слово
    c = ws_line("двери", "EI30")
    out = og.align_tokens(c, ["двери", "EI", "3O"], oe.vote_key)
    assert [(x.text, x.bbox) for x in out] == [
        ("двери", c[0].bbox),
        ("EI3O", c[1].bbox),
    ]
    # читатель слил два слова якоря в одно: голос достаётся одному слову, второе остаётся без голоса
    b = ws_line("EI", "30", "двери")
    out = og.align_tokens(b, ["EI30", "двери"], oe.vote_key)
    assert [x.text for x in out] == ["EI30", "двери"] and out[0].bbox in (
        b[0].bbox,
        b[1].bbox,
    )
    # лишний токен без слова якоря отбрасывается; пропущенное слово — без голоса
    out = og.align_tokens(
        ws_line("стена", "бетон"), ["стена", "лишнее", "слово", "бетон"], oe.vote_key
    )
    assert [x.text for x in out] == ["стена", "бетон"]
    out = og.align_tokens(
        ws_line("стена", "бетон", "В25"), ["стена", "В25"], oe.vote_key
    )
    assert [x.text for x in out] == ["стена", "В25"]


# ─────────────────────────────── ансамбль PP-OCR + VL


@pytest.mark.l1_functional
def test_vl_votes_in_anchor_boxes_and_marks_disputed():
    """VL подтверждает слово — согласие; расходится — слово сомнительное, при ничьей решает уверенность."""
    a = ws_line("Предел", "огнестойкости", "EI3O")
    anchor = Anchor(
        words=[x.model_copy(update={"conf": 99.0}) for x in a[:2]]
        + [a[2].model_copy(update={"conf": 60.0})]
    )
    res = oe.run_ensemble(BLANK, [anchor, vl(default="Предел огнестойкости EI30")])
    assert res.engines == ["ppocr-v5", "vl-reader"]
    assert [x.text for x in res.words] == [
        "Предел",
        "огнестойкости",
        "EI30",
    ]  # якорь неуверен (60 < 85) — голос VL
    assert [x.disputed for x in res.words] == [False, False, True]
    assert res.disputed_words == 1 and res.agreement == pytest.approx(2 / 3, abs=1e-3)


@pytest.mark.l6_adversarial
def test_vl_hallucination_abstains():
    """Прочтение втрое длиннее строки (повтор, чужой текст) — читатель воздерживается, текст якоря остаётся."""
    a = Anchor(words=ws_line("стена"))
    res = oe.run_ensemble(BLANK, [a, vl(default="стена " * 20)])
    assert [x.text for x in res.words] == ["стена"] and res.words[0].disputed


@pytest.mark.l1_functional
def test_vl_not_asked_on_sheet_sized_crop():
    """«Строка» якоря через весь лист — кроп больше VL_MAX_CROP_PX: читатель не спрашивается, слова — за якорем."""
    big = Image.new("RGB", (4000, 3000), "white")
    seen: list = []
    a = Anchor(words=[w("план", 0.01, 0.0, 0.05, 1.0), w("разрез", 0.9, 0.0, 0.99, 1.0)])
    res = oe.run_ensemble(big, [a, vl(default="план разрез", seen=seen)])
    assert seen == [] and [x.text for x in res.words] == ["план", "разрез"]
    ok: list = []
    oe.run_ensemble(BLANK, [Anchor(words=ws_line("стена")), vl(default="стена", seen=ok)])
    assert len(ok) == 1


@pytest.mark.l4_fault
def test_vl_failure_drops_vl_not_page():
    def gen(crop, n):
        raise ConnectionError("vLLM не отвечает")

    res = oe.run_ensemble(
        BLANK,
        [Anchor(words=ws_line("стена")), og.VlLineReader("vl-reader", generate=gen)],
    )
    assert res.engines == ["ppocr-v5"] and [x.text for x in res.words] == ["стена"]


@pytest.mark.l4_fault
def test_gpu_anchor_failure_fails_page_not_abstain():
    """Сбой PP-OCR (память видеокарты) — ошибка разбора и повтор, а не пустая страница в кэше навсегда."""

    @dataclass
    class Broken(Anchor):
        fail_loud: bool = True

        def read_page(self, image):
            raise RuntimeError("bfc_arena: Available memory of 0")

    with pytest.raises(RuntimeError, match="bfc_arena"):
        oe.run_ensemble(BLANK, [Broken(), vl(default="x")])
    res = oe.run_ensemble(
        BLANK, [Broken(fail_loud=False), Anchor(name="b", words=ws_line("стена"))]
    )
    assert res.engines == ["b"]  # движок без fail_loud (Tesseract) выбывает, как раньше


@pytest.mark.l3_boundary
def test_vl_without_anchor_words_not_asked():
    seen: list = []
    res = oe.run_ensemble(BLANK, [Anchor(words=[]), vl(default="текст", seen=seen)])
    assert seen == [] and res.words == []


@pytest.mark.l1_functional
def test_vl_line_crops_upright_on_rotated_scan():
    """На повёрнутом скане читатель получает кроп строки, поставленный прямо (шире, чем выше)."""
    seen: list = []
    img = Image.new("RGB", (1000, 1000), "white")
    words = [x for ln in (vertical_line(x) for x in (0.6, 0.4, 0.2)) for x in ln]
    oe.run_ensemble(
        img, [Anchor(words=words, turns=1), vl(default="с0 с1 с2", seen=seen)]
    )
    assert len(seen) == 3 and all(wd > ht for wd, ht in seen)


@pytest.mark.l1_functional
def test_vl_band_of_lines_one_request_aligned_across_lines():
    """Полоса из двух строк — один запрос; прочтение с другим переносом строк выравнивается со словами обеих строк."""
    seen: list = []
    two = [
        w("Предел", 0.1, 0.1, 0.2, 0.12),
        w("EI", 0.25, 0.1, 0.3, 0.12),
        w("30", 0.1, 0.2, 0.15, 0.22),
    ]
    r = og.VlLineReader(
        "vl-reader",
        band_lines=2,
        concurrency=1,
        generate=lambda c, n: seen.append(c.size) or "Предел\nEI 30",
    )
    res = oe.run_ensemble(BLANK, [Anchor(words=two), r])
    assert (
        len(seen) == 1 and seen[0][1] > 0.1 * BLANK.size[1]
    )  # кроп накрывает обе строки
    assert [x.text for x in res.words] == [
        "Предел",
        "EI",
        "30",
    ] and res.agreement == 1.0


@pytest.mark.l1_functional
def test_line_crop_padding_and_bounds():
    img = Image.new("RGB", (1000, 500), "white")
    crop = og.line_crop(img, [w("а", 0.1, 0.1, 0.3, 0.14)], 0)
    assert crop.size[0] > 200 and 20 < crop.size[1] < 40
    edge = og.line_crop(img, [w("а", 0.0, 0.0, 1.0, 1.0)], 0)
    assert edge.size == (1000, 500)


# ─────────────────────────────── разбор скана целиком


@pytest.mark.l4_fault
def test_partial_reader_failure_survives_voting_and_page_summary(monkeypatch):
    """T-237: participating Reader does not imply that every required band ran."""
    from inspector_ml import parse

    reader = vl(default="900")
    answers = iter([None, "900"])
    monkeypatch.setattr(reader, "_ask_line", lambda crop, tokens: next(answers))
    anchor = Anchor(words=[w("900", .1, .1, .3, .12), w("900", .1, .3, .3, .32)])
    result = oe.run_ensemble(BLANK, [anchor, reader])
    assert result.engines == ["ppocr-v5", "vl-reader"]
    assert result.execution_failures == ["vl-reader:band:0:reader_unavailable"]
    monkeypatch.setattr(parse, "run_ensemble", lambda image: result)
    page = parse._ocr_image(BLANK, 1, 1000, 800, 0)
    assert page.execution_failures == result.execution_failures


@pytest.mark.l1_functional
def test_reader_success_does_not_inherit_previous_call_failures(monkeypatch):
    reader = vl(default="900")
    answers = iter([None, "900", "900", "900"])
    monkeypatch.setattr(reader, "_ask_line", lambda crop, tokens: next(answers))
    anchor = Anchor(words=[w("900", .1, .1, .3, .12), w("900", .1, .3, .3, .32)])
    assert oe.run_ensemble(BLANK, [anchor, reader]).execution_failures
    assert oe.run_ensemble(BLANK, [anchor, reader]).execution_failures == []


@pytest.mark.l1_functional
def test_scan_parsed_by_gpu_engines(monkeypatch):
    """Разбор PDF-скана движками профиля gpu: страница OCR, движки записаны, текст — голосование PP-OCR + VL."""
    from inspector_ml.parse import parse_file

    anchor = Anchor(words=ws_line("Дверь", "EI", "30"))
    monkeypatch.setattr(
        oe, "default_engines", lambda: [anchor, vl(default="Дверь EI 30")]
    )
    doc = parse_file(DOOR, "0" * 64)
    p = doc.pages[0]
    assert p.source == "ocr" and p.engines == ["ppocr-v5", "vl-reader"]
    assert p.lines[0].text == "Дверь EI 30" and p.agreement == 1.0
    assert "ppocr-v5" in doc.engine and "vl-reader" in doc.engine


@pytest.mark.l4_fault
def test_stage_parse_engine_failure_skips_file_without_caching(monkeypatch, capsys):
    """Этап parse: сбой движка на файле — строка об ошибке и следующий файл; сбойный файл не в кэше (разберётся в повторе)."""
    from inspector_ml import stages
    from inspector_ml.model import Page, ParsedDoc

    monkeypatch.setattr(stages, "_cache", lambda: object())
    monkeypatch.setattr(stages, "cached_doc", lambda cache, sha: None)
    monkeypatch.setattr(
        stages,
        "pdf_blobs",
        lambda d: [("a" * 64, Path("a.pdf")), ("b" * 64, Path("b.pdf"))],
    )

    def load(cache, path, sha):
        if sha.startswith("a"):
            raise RuntimeError("bfc_arena: Available memory of 0")
        return ParsedDoc(
            sha256=sha,
            kind="pdf",
            engine="x",
            pages=[Page(page=1, width=1, height=1, source="ocr", lines=[])],
        ), False

    monkeypatch.setattr(stages, "load_parsed", load)
    res = stages.run_parse(None)
    out = capsys.readouterr().out
    assert (
        res["done"] == 1
        and '"retry": true' in out
        and "bfc_arena" in out
        and '"sha": "bbbbbbbbbbbb"' in out
    )


# ─────────────────────────────── веса PP-OCR — из образа, со сверкой SHA-256 (T-230, OWASP-0211)


def _fake_rapidocr(monkeypatch, built: list):
    """Подделки rapidocr и onnxruntime: RapidOCR запоминает параметры и отдаёт сессии «на CUDA»."""
    import sys
    import types

    class Sess:
        def get_providers(self):
            return ["CUDAExecutionProvider"]

        def run(self, names, feed, run_options=None):
            return []

    class Stage:
        def __init__(self):
            self.session = types.SimpleNamespace(session=Sess())
            self.mean, self.std = 0, 1

    class RapidOCR:
        def __init__(self, params):
            built.append(params)
            self.text_det, self.text_rec, self.text_cls = Stage(), Stage(), Stage()

    class Enum:
        def __getattr__(self, k):
            return k

    class RunOptions:
        def add_run_config_entry(self, k, v):
            pass

    rapid = types.ModuleType("rapidocr")
    rapid.RapidOCR = RapidOCR
    rapid.EngineType = rapid.LangDet = rapid.ModelType = rapid.OCRVersion = Enum()
    rapid.LangRec = lambda v: v
    det = types.ModuleType("rapidocr.ch_ppocr_det.utils")
    det.DetPreProcess = lambda *a: None
    ort = types.ModuleType("onnxruntime")
    ort.get_available_providers = lambda: ["CUDAExecutionProvider"]
    ort.preload_dlls = lambda: None
    ort.RunOptions = RunOptions
    for name, mod in {
        "rapidocr": rapid,
        "rapidocr.ch_ppocr_det": types.ModuleType("rapidocr.ch_ppocr_det"),
        "rapidocr.ch_ppocr_det.utils": det,
        "onnxruntime": ort,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)


def _weights(tmp_path, monkeypatch, tamper: str | None = None) -> Path:
    """Каталог весов (синтетические байты) и реестр с их SHA-256; tamper — файл, подменённый после записи хеша."""
    import hashlib

    import yaml

    d = tmp_path / "ppocr"
    d.mkdir()
    files = []
    for name in (og.DET_FILES["v6-medium"], og.CLS_FILE, og.rec_file("eslav")):
        data = f"weights {name}".encode()
        (d / name).write_bytes(data)
        files.append(
            {
                "file": name,
                "sha256": hashlib.sha256(data).hexdigest(),
                "url": f"https://example.test/{name}",
            }
        )
    if tamper:
        (d / tamper).write_bytes(b"podmena")
    reg = tmp_path / "models.yaml"
    reg.write_text(yaml.safe_dump({"roles": {"ocr_anchor": {"files": files}}}), "utf-8")
    monkeypatch.setenv(og.MODELS_YAML_ENV, str(reg))
    return d


@pytest.mark.l1_functional
def test_ppocr_uses_local_model_paths(tmp_path, monkeypatch):
    """Веса берутся из INSPECTOR_PPOCR_MODEL_DIR (образ, ADD --checksum): Det/Cls/Rec.model_path заданы — RapidOCR
    не идёт в сеть за моделями."""
    d = _weights(tmp_path, monkeypatch)
    built: list = []
    _fake_rapidocr(monkeypatch, built)
    e = og._ppocr("ppocr-v5", og.PPOCR_DET, "gpu", {og.MODEL_DIR_ENV: str(d)})
    assert e.available() is True, e.reason
    p = built[0]
    assert p["Det.model_path"] == str(d / "PP-OCRv6_det_medium.onnx")
    assert p["Cls.model_path"] == str(
        d / "ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"
    )
    assert p["Rec.model_path"] == str(d / "eslav_PP-OCRv5_rec_mobile.onnx")


@pytest.mark.l4_fault
def test_ppocr_model_hash_mismatch_is_unavailable(tmp_path, monkeypatch):
    """Файл весов не совпал с SHA-256 реестра — движок недоступен с причиной, модель не строится и не скачивается."""
    d = _weights(tmp_path, monkeypatch, tamper="eslav_PP-OCRv5_rec_mobile.onnx")
    built: list = []
    _fake_rapidocr(monkeypatch, built)
    e = og._ppocr("ppocr-v5", og.PPOCR_DET, "gpu", {og.MODEL_DIR_ENV: str(d)})
    assert e.available() is False
    assert "SHA-256" in e.reason and "eslav_PP-OCRv5_rec_mobile.onnx" in e.reason
    assert built == []


@pytest.mark.l4_fault
def test_ppocr_gpu_without_model_dir_or_pin_is_unavailable(tmp_path, monkeypatch):
    """Профиль gpu без каталога весов — отказ (загрузка в рантайме запрещена); файл без записи в реестре — отказ."""
    built: list = []
    _fake_rapidocr(monkeypatch, built)
    e = og._ppocr("ppocr-v5", og.PPOCR_DET, "gpu", {})
    assert e.available() is False and og.MODEL_DIR_ENV in e.reason
    d = _weights(tmp_path, monkeypatch)
    (d / og.DET_FILES["v5-server"]).write_bytes(b"x")
    e = og._ppocr("ppocr-v5", "v5-server", "gpu", {og.MODEL_DIR_ENV: str(d)})
    assert (
        e.available() is False
        and "ch_PP-OCRv5_det_server.onnx" in e.reason
        and "реестр" in e.reason
    )
    missing = og._ppocr(
        "ppocr-v5", og.PPOCR_DET, "gpu", {og.MODEL_DIR_ENV: str(tmp_path / "нет")}
    )
    assert missing.available() is False and "нет файла" in missing.reason
    assert built == []


@pytest.mark.l7_discipline
def test_image_weights_pinned_like_registry():
    """Веса в образе (ml/Dockerfile, ADD --checksum) — те же файлы, хеши и адреса, что ocr_anchor.files в реестре."""
    import re

    import yaml

    reg = yaml.safe_load((ROOT / "ml/models.yaml").read_text("utf-8"))["roles"][
        "ocr_anchor"
    ]["files"]
    df = (ROOT / "ml/Dockerfile").read_text("utf-8")
    added = {
        m.group(3).rsplit("/", 1)[-1]: (m.group(1), m.group(2))
        for m in re.finditer(
            r"ADD --checksum=sha256:([0-9a-f]{64}) (\S+) (/opt/ppocr/\S+)", df
        )
    }
    assert {f["file"] for f in reg} == set(added)
    assert {og.DET_FILES[og.PPOCR_DET], og.CLS_FILE, og.rec_file(og.PPOCR_REC)} == set(
        added
    )
    for f in reg:
        assert re.fullmatch(r"[0-9a-f]{64}", f["sha256"])
        assert added[f["file"]] == (f["sha256"], f["url"]), f["file"]


# ─────────────────────────────── вход детектора по размеру листа (T-232)


@pytest.mark.l1_functional
def test_det_side_keeps_scale_per_format():
    """А4 — вход 1600 (доля 0,46), А3 — 2232, А0 — потолок 4096 в арене 6 ГБ; мелкое изображение — не ниже пола."""
    assert og.det_side(2481, 3509, 4096, 6144) == 1600
    assert og.det_side(3508, 4961, 4096, 6144) == 2232  # А3
    assert og.det_side(14042, 9934, 4096, 6144) >= 4000
    assert og.det_side(14042, 9934, 4096, 4096) < 4096  # в 4 ГБ А0 целиком не помещается — вход меньше
    assert og.det_side(600, 800, 4096, 6144) == og.DET_FLOOR
    assert og.det_side(14042, 9934, 3072, 16384) == 3072


@pytest.mark.l1_functional
def test_det_side_fits_gpu_arena_by_area():
    """Арену детектор расходует по площади входа: 4096×2898 падало в 3 ГБ, 3200×2264 — в 2 ГБ (замер 28.09)."""
    for w, h, mb in ((14042, 9934, 3072), (14042, 9934, 2048), (9000, 9000, 4096)):
        s = og.det_side(w, h, 4096, mb)
        assert s * s * min(w, h) / max(w, h) <= og.det_budget(mb) * 1.001
    assert og.PpOcrEngine("x", det_limit=4096, gpu_mem_mb=3072).det_cap() == 3072
    assert og.PpOcrEngine("x", det_limit=4096, gpu_mem_mb=512).det_cap() == og.DET_FLOOR


@pytest.mark.l1_functional
def test_det_pieces_single_up_to_a0():
    assert og.det_pieces(14042, 9934, 4096, 6144) == [((0, 0, 14042, 9934), (0, 0, 14042, 9934))]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "w,h,cap,mb", [(21047, 9933, 4096, 6144), (17828, 8415, 4096, 6144), (40000, 17000, 4096, 4096), (16385, 300, 4096, 4096), (30000, 30000, 3072, 3072)]
)
def test_det_pieces_cover_without_gaps_and_bounded(w, h, cap, mb):
    """Ядра кусков покрывают лист ровно один раз; каждый кусок детектор видит с долей не меньше DET_MIN_SCALE
    и входом, помещающимся в арену."""
    ps = og.det_pieces(w, h, cap, mb)
    limit = int(cap / og.DET_MIN_SCALE)
    assert len(ps) > 1
    for (x0, y0, x1, y1), (cx0, cy0, cx1, cy1) in ps:
        assert 0 <= x0 <= cx0 < cx1 <= x1 <= w and 0 <= y0 <= cy0 < cy1 <= y1 <= h
        assert x1 - x0 <= limit and y1 - y0 <= limit
        pw, ph = x1 - x0, y1 - y0
        s = og.det_side(pw, ph, cap, mb)
        assert s / max(pw, ph) >= og.DET_MIN_SCALE * 0.99
        assert s * s * min(pw, ph) / max(pw, ph) <= og.det_budget(mb) * 1.001
    xs = sorted({(c[0], c[2]) for _, c in ps})
    ys = sorted({(c[1], c[3]) for _, c in ps})
    for axis, n in ((xs, w), (ys, h)):
        assert axis[0][0] == 0 and axis[-1][1] == n
        assert all(a[1] == b[0] for a, b in itertools.pairwise(axis))
    assert sum((c[2] - c[0]) * (c[3] - c[1]) for _, c in ps) == w * h


@pytest.mark.l1_functional
def test_oversize_sheet_read_by_pieces_without_seam_duplicates(monkeypatch):
    """Лист шире А0 читается кусками; слово на шве, найденное двумя кусками, остаётся одно, рамка — в долях листа."""
    e = og.PpOcrEngine("x", require_gpu=False)
    e._pool = object()
    img = Image.new("L", (21047, 9933), 255)
    seen = []

    def fake(crop, side):
        seen.append((crop.size, side))
        cw = crop.size[0]
        x = (10523 - offs[len(seen) - 1]) / cw  # одно и то же слово у центра листа в каждом куске
        ws = [Word(text="шов", bbox=(x - 0.001, 0.5, x + 0.001, 0.51))] if 0 < x < 1 else []
        return og.EngineReading(words=ws, lines=[ws] if ws else [])

    offs = [p[0][0] for p in og.det_pieces(21047, 9933, 4096, 4096)]
    monkeypatch.setattr(e, "_read_lines", fake)
    r = e.read_page(img)
    assert len(seen) == len(offs) > 1 and all(s >= 1600 for _, s in seen)
    assert [w.text for w in r.words] == ["шов"]
    assert abs((r.words[0].bbox[0] + r.words[0].bbox[2]) / 2 - 10523 / 21047) < 1e-4


@pytest.mark.l1_functional
def test_ocr_tag_changes_with_detector_cap():
    base = og.ocr_tag({"INSPECTOR_PROFILE": "gpu"})
    assert og.ocr_tag({"INSPECTOR_PROFILE": "gpu", "INSPECTOR_PPOCR_DET_LIMIT": "1600"}) != base
    assert og.ocr_tag({"INSPECTOR_PROFILE": "gpu", "INSPECTOR_PPOCR_GPU_MB": "2048"}) != base


# ─────────────────────────────── T-233: обрыв запроса к читателю — воздержание по строке, а не выбывание со страницы


def _line_reader(gen):
    return og.VlLineReader("vl-reader", generate=gen, concurrency=1)


@pytest.mark.l4_fault
def test_transient_drop_is_retried_then_answered(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    n = {"k": 0}

    def gen(crop, max_tokens):
        n["k"] += 1
        if n["k"] < 3:
            raise ConnectionResetError("Connection reset by peer")
        return "стена"

    assert _line_reader(gen)._ask_line(Image.new("RGB", (40, 10)), 32) == "стена"
    assert n["k"] == 3


@pytest.mark.l4_fault
def test_persistent_drop_abstains_without_raising(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)

    def gen(crop, max_tokens):
        raise ConnectionResetError("Remote end closed connection without response")

    assert _line_reader(gen)._ask_line(Image.new("RGB", (40, 10)), 32) is None


@pytest.mark.l3_boundary
def test_client_error_not_retried(monkeypatch):
    import urllib.error

    monkeypatch.setattr("time.sleep", lambda s: None)
    n = {"k": 0}

    def gen(crop, max_tokens):
        n["k"] += 1
        raise urllib.error.HTTPError("u", 400, "Bad Request", {}, None)

    assert _line_reader(gen)._ask_line(Image.new("RGB", (40, 10)), 32) is None
    assert n["k"] == 1  # 400 — запрос неверный, повтор бессмыслен


def test_rejected_low_confidence_anchor_is_retained_only_as_diagnostic():
    original = w('LOW', .1, .1, .2, .2, conf=40)
    result = oe.run_ensemble(BLANK, [Anchor(words=[original]), vl(default='')])
    assert result.words == []
    assert result.anchor_words == [original]
    assert result.anchor_words[0] is not original


def test_regional_detector_floor_is_frozen_and_does_not_change_source_pixels(monkeypatch):
    env = {'INSPECTOR_PROFILE':'gpu','INSPECTOR_PPOCR_DET_FLOOR':'960'}
    assert og.ocr_tag(env) != og.ocr_tag({'INSPECTOR_PROFILE':'gpu'})
    engine=og._ppocr('test',og.PPOCR_DET,'dev',env)
    engine._pool=object()
    seen=[]
    def read(image,side):
        seen.append((image.size,side))
        return og.EngineReading([])
    monkeypatch.setattr(engine,'_read_lines',read)
    with Image.new('L',(2500,768)) as image:
        engine.read_page(image)
    assert seen==[((2500,768),1125)]
    assert og._ppocr('old',og.PPOCR_DET,'dev',{}).det_floor==1600


def test_vertical_real_word_boxes_follow_classifier_direction_without_text_change():
    quad=[[10,20],[20,20],[20,130],[10,130]]
    original=og.split_line('Размер 4200',quad,.9,200,200)
    fixed=og.orient_vertical_words(original,quad,True)
    assert [w[0] for w in fixed]==['Размер','4200']
    assert min(p[1] for p in fixed[0][2]) > max(p[1] for p in fixed[1][2])
    assert og.orient_vertical_words(fixed,quad,True)==fixed
    assert og.orient_vertical_words(original,quad,False)==original


@pytest.mark.l4_fault
def test_short_anchor_does_not_truncate_reader_before_eos():
    budgets = []

    def generate(crop, max_tokens):
        budgets.append(max_tokens)
        if max_tokens < 128:
            raise RuntimeError("incomplete VLM generation")
        return "900"

    reader = og.VlLineReader("vl-reader", generate=generate, concurrency=1)
    result = oe.run_ensemble(BLANK, [Anchor(words=[w("900", .1, .1, .3, .12)]), reader])
    assert result.engines == ["ppocr-v5", "vl-reader"]
    assert result.execution_failures == []
    assert len(budgets) == 1 and 128 <= budgets[0] <= 2048


@pytest.mark.l4_fault
def test_larger_budget_still_rejects_unfinished_reader():
    def generate(crop, max_tokens):
        raise RuntimeError("incomplete VLM generation")

    reader = og.VlLineReader("vl-reader", generate=generate, concurrency=1)
    result = oe.run_ensemble(BLANK, [Anchor(words=[w("900", .1, .1, .3, .12)]), reader])
    assert "vl-reader" not in result.engines


@pytest.mark.l4_fault
def test_single_line_stop_does_not_cut_multiline_bands(monkeypatch):
    from inspector_ml import vlm
    calls = []
    def generate(repo, crop, prompt, **kwargs):
        calls.append(kwargs)
        return "Этажность"
    monkeypatch.setattr(vlm, "generate", generate)
    for count in [1, 2]:
        reader = og.VlLineReader("vl-reader", band_lines=count)
        assert reader._ask(Image.new("RGB", (120, 20)), 256) == "Этажность"
    assert calls[0]["stop"] == ["\n"]
    assert calls[1]["stop"] is None
