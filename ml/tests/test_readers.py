"""Читатели сканов (PRM-14; OS-INSP-2.1.13, 2.2.18–2.2.20; T-130): сведение прочтений VLM с ансамблем OCR.
Модели здесь не запускаются — прочтения задаются текстом; живой прогон — этапами scripts/ml-host.sh (правило №0).

Эшелоны qa-standard: L1 правила сведения · L2 независимый пересчёт (читатель прочитал то же — результат как без него) ·
L3 границы полос и сходства · L4 отказы (битый кэш, нет прочтения) · L5 инварианты перебором всех сочетаний прочтений ·
L6 враждебный вход (путь вместо хеша, мусор вместо текста) · L7 дисциплина (след в meta, источник текста) ·
L8 регрессия реального листа «Алтуфьево» (ОПЗ 2024, стр. 23: Tesseract «Со» → С0, обезличено)."""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import pytest

from inspector_ml import readers
from inspector_ml.class_mentions import extract_class_mentions
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.readers import (
    CONFIRMED_CONF,
    DISPUTED_FACTOR,
    UNCONFIRMED,
    Band,
    Models,
    ReaderCache,
    band_ranges,
    merge_doc,
    merge_page,
    reader_pages,
    second_value,
    trace_phrase,
)

# корень репо — вверх по дереву: в песочнице мутаций (ml/mutants) parents[2] указывает не туда, и тесты молча выпадают
ROOT = next(p for p in Path(__file__).resolve().parents if (p / "data/seed/matrix.json").exists())
PASSPORT = json.loads((ROOT / "data/seed/passports/M-023.json").read_text("utf-8"))
CFG = PASSPORT["extractor"] | {
    "scale": PASSPORT["value"]["scale"],
    "constraint_markers": PASSPORT["value"]["constraint_markers"],
}
SPEC = ParamSpec(
    code="M-023", anchors=["Класс конструктивной пожарной опасности"], extractor=CFG
)
M = Models(
    ensemble="ансамбль",
    reader="mlx-community/PaddleOCR-VL-1.5-bf16",
    reader2="mlx-community/GLM-OCR-bf16",
)
SHA = "a" * 64
SCALE = ["С3", "С2", "С1", "С0"]


def line_at(text: str, y: float, x0: float = 0.1) -> Line:
    ws, x = [], x0
    for t in text.split():
        w = 0.01 * len(t)
        ws.append(Word(text=t, bbox=(round(x, 4), y, round(x + w, 4), y + 0.012)))
        x += w + 0.005
    return Line(text=text, words=ws)


def scan(
    lines: list[tuple[str, float]], n: int = 1, quality: str = "OK", conf: float = 80.0
) -> Page:
    return Page(
        page=n,
        width=595,
        height=842,
        source="ocr",
        quality=quality,
        ocr_confidence=conf,
        lines=[line_at(t, y) for t, y in lines],
    )


def text_page(lines: list[tuple[str, float]], n: int = 1) -> Page:
    return Page(
        page=n,
        width=595,
        height=842,
        source="text",
        lines=[line_at(t, y) for t, y in lines],
    )


def doc(*pages: Page) -> ParsedDoc:
    return ParsedDoc(
        sha256=SHA, kind="pdf", engine="pdfium+tesseract", pages=list(pages)
    )


def bands(*texts: str) -> list[Band]:
    """Прочтение читателя: текст по полосам сверху вниз (пустые полосы — пустой текст)."""
    rng = band_ranges()
    return [
        Band(y0, y1, texts[i] if i < len(texts) else "")
        for i, (y0, y1) in enumerate(rng)
    ]


def ens(page: Page) -> list:
    return extract_class_mentions(doc(page), SPEC)


def merge(
    page: Page,
    reader_bands: list[Band],
    reader2: str | None = None,
    asked: list | None = None,
):
    def crop(box):
        if asked is not None:
            asked.append(box)
        return reader2

    return merge_page(
        page,
        ens(page),
        readers.band_mentions(reader_bands, page.page, SPEC),
        SPEC,
        crop,
        M,
    )


LINE_C0 = "1.4. Класс конструктивной пожарной опасности - С0"
LINE_CO = "1.4. Класс конструктивной пожарной опасности - Со"  # Tesseract читает ноль как «о» — normalize даёт С0
LINE_C1 = "Класс конструктивной пожарной опасности – С1."


# ─────────────────────────────────────────────── L1 правила


@pytest.mark.l1_functional
def test_bands_cover_the_sheet_with_overlap():
    rng = band_ranges()
    assert len(rng) == readers.BANDS
    assert rng[0][0] == 0.0 and rng[-1][1] == 1.0
    for (a0, a1), (b0, b1) in zip(rng, rng[1:]):
        assert b0 < a1, "соседние полосы перекрываются — строка на границе не теряется"
        assert a0 < b0


@pytest.mark.l1_functional
def test_trace_phrase_is_anchor_stems():
    assert trace_phrase(CFG) == "конструктивн пожарн опасност"
    assert trace_phrase({}) == ""


@pytest.mark.l1_functional
def test_reader_pages_scans_with_low_quality_or_trace_only():
    d = doc(
        text_page([(LINE_C0, 0.1)], 1),  # текстовый слой — читатель не нужен
        scan(
            [("Пояснительная записка", 0.1)], 2, quality="LOW_QUALITY"
        ),  # ансамбль не уверен
        scan(
            [("Клас констуктивной пожарнай опасноcти Со", 0.5)], 3
        ),  # след оборота, буквы искажены
        scan([("Ведомость рабочих чертежей", 0.1)], 4),  # скан без следа и уверенный
        scan([], 5, quality="ABSTAIN"),
    )
    assert reader_pages(d, [CFG]) == [2, 3, 5]
    assert reader_pages(d, []) == [2, 5], (
        "без параметров-классов — только неуверенные страницы"
    )


@pytest.mark.l1_functional
def test_agree_marks_both_readings_and_keeps_value():
    page = scan([(LINE_C0, 0.6)], conf=84.0)
    out = merge(page, bands("", "", LINE_C0))
    assert [e.value_text for e in out] == ["С0"]
    m = out[0].meta
    assert m["reader_outcome"] == "agree"
    assert m["readings"] == [
        {"by": "ансамбль", "value": "С0"},
        {"by": M.reader, "value": "С0"},
    ]
    assert m["text_source"] == "scan-ocr"
    assert out[0].confidence == ens(page)[0].confidence, (
        "согласие уверенность не меняет"
    )
    assert "PRM-14" in m["ops"]


@pytest.mark.l1_functional
def test_dispute_two_of_three_for_reader_takes_reader_value():
    page = scan([(LINE_C1, 0.6)])
    asked = []
    out = merge(
        page,
        bands("", "", LINE_C0),
        reader2="класс конструктивной пожарной опасности С0",
        asked=asked,
    )
    e = out[0]
    assert e.value_text == "С0" and e.meta["reader_outcome"] == "majority-reader"
    assert e.confidence == CONFIRMED_CONF
    assert [r["value"] for r in e.meta["readings"]] == ["С1", "С0", "С0"]
    assert len(asked) == 1, "второй читатель спрошен ровно по спорному упоминанию"


@pytest.mark.l1_functional
def test_dispute_two_of_three_for_ensemble_keeps_ensemble():
    page = scan([(LINE_C1, 0.6)])
    base = ens(page)[0]
    e = merge(page, bands("", "", LINE_C0), reader2="С1")[0]
    assert (e.value_text, e.meta["reader_outcome"], e.confidence) == (
        "С1",
        "majority-ensemble",
        base.confidence,
    )


@pytest.mark.l1_functional
def test_dispute_without_majority_keeps_ensemble_and_lowers_confidence():
    page = scan([(LINE_C1, 0.6)])
    base = ens(page)[0]
    for r2 in (None, "С2", "С0 и С1 и С2"):
        e = merge(page, bands("", "", LINE_C0), reader2=r2)[0]
        assert e.value_text == "С1" and e.meta["reader_outcome"] == "no-majority"
        assert e.confidence == round(base.confidence * DISPUTED_FACTOR, 3)


@pytest.mark.l1_functional
def test_reader_only_confirmed_gets_place_from_ensemble_line_in_same_band():
    # ансамбль строку распознал, но оборот искажён настолько, что правила его не нашли
    page = scan([("Клас констуктивной пожарнай опасноcти -", 0.62)])
    assert ens(page) == []
    out = merge(page, bands("", "", LINE_C0), reader2="С0")
    assert len(out) == 1
    e = out[0]
    assert e.value_text == "С0" and e.meta["reader_outcome"] == "reader-only-confirmed"
    assert e.meta.get("excluded") is None
    assert e.meta["text_source"] == "scan-reader" and e.meta["located"] == "line"
    assert e.bbox is not None and 0.6 <= e.bbox[1] <= 0.64, (
        "место — строка ансамбля в той же полосе"
    )
    assert e.confidence == CONFIRMED_CONF


@pytest.mark.l1_functional
def test_reader_only_unconfirmed_is_kept_but_excluded_with_reason():
    page = scan([("Ведомость", 0.1)])
    e = merge(page, bands("", "", LINE_C1), reader2=None)[0]
    assert (
        e.meta["excluded"] == UNCONFIRMED
        and "второе прочтение" in e.meta["excluded_why"]
    )
    assert e.meta["located"] == "band", "строки ансамбля нет — рамка полосы"
    y0, y1 = band_ranges()[2]
    assert e.bbox == (0.0, y0, 1.0, y1)


@pytest.mark.l1_functional
def test_reader_only_rule_excluded_neighbor_stays_excluded_and_reader2_not_asked():
    neighbor = "вл 79Бс2. Находится с юга от реконструируемого здания, степень огнестойкости – II, класс конструктивной пожарной опасности - С1"
    asked = []
    e = merge(
        scan([("Ведомость", 0.1)]), bands("", neighbor), reader2="С1", asked=asked
    )[0]
    assert e.meta["excluded"] == "NEIGHBOR"
    assert asked == [], "отсеянное правилами второму читателю не показываем"


@pytest.mark.l1_functional
def test_ensemble_only_when_reader_did_not_see_it():
    e = merge(scan([(LINE_C0, 0.6)]), bands("", "", "Ведомость"))[0]
    assert e.meta["reader_outcome"] == "ensemble-only"
    assert e.meta["readings"][1] == {"by": M.reader, "value": None}


@pytest.mark.l1_functional
def test_second_value_rules():
    assert second_value("Класс конструктивной пожарной опасности – С1", SPEC) == "С1"
    assert second_value("С0", SPEC) == "С0", (
        "кроп — только значение: единственный класс шкалы"
    )
    assert second_value("C 0", SPEC) == "С0", "латиница и пробел — нормализация NRM-03"
    assert second_value("С0 С1", SPEC) is None, "два разных класса — не ответ"
    assert second_value("С5", SPEC) is None, "вне шкалы"
    assert second_value("", SPEC) is None and second_value(None, SPEC) is None


# ─────────────────────────────────────────────── L1/L7 сведение документа и источник текста


@pytest.mark.l7_discipline
def test_merge_doc_without_cache_only_tags_text_source():
    d = doc(text_page([(LINE_C0, 0.1)], 1), scan([(LINE_C1, 0.6)], 2))
    found = extract_class_mentions(d, SPEC)
    out = merge_doc(SHA, d, found, [SPEC], None, M)
    assert [(e.page, e.value_text, e.meta["text_source"]) for e in out] == [
        (1, "С0", "pdf-text"),
        (2, "С1", "scan-ocr"),
    ]
    assert all("readings" not in e.meta for e in out)


@pytest.mark.l1_functional
def test_merge_doc_uses_cache_page_without_reading_untouched_and_adds_reader_only_page(
    tmp_path,
):
    rc = ReaderCache(tmp_path)
    d = doc(
        scan([(LINE_C1, 0.6)], 1),
        scan([("Клас констуктивной пожарнай -", 0.62)], 2),
        scan([(LINE_C1, 0.6)], 3),
    )
    rc.put_page(SHA, 1, M.reader, bands("", "", LINE_C1), 10)
    rc.put_page(
        SHA, 2, M.reader, bands("", "", LINE_C0), 10
    )  # ансамбль на стр. 2 ничего не нашёл
    box = readers.locate(d.pages[1], bands("", "", LINE_C0)[2], trace_phrase(CFG))
    rc.put_crop(SHA, 2, box, M.reader2, "С0", 10)
    out = merge_doc(SHA, d, extract_class_mentions(d, SPEC), [SPEC], rc, M)
    by_page = {e.page: e for e in out}
    assert by_page[1].meta["reader_outcome"] == "agree"
    assert (
        by_page[2].meta["reader_outcome"] == "reader-only-confirmed"
        and by_page[2].value_text == "С0"
    )
    assert "reader_outcome" not in by_page[3].meta, "страница без прочтения — как было"
    assert by_page[3].meta["text_source"] == "scan-ocr"


@pytest.mark.l7_discipline
def test_non_class_extractions_pass_through_unchanged(tmp_path):
    from inspector_ml.model import Extraction

    other = Extraction(
        code="M-059",
        raw="200",
        value_num=200,
        page=1,
        bbox=None,
        line_text="плита 200 мм",
        confidence=0.8,
    )
    d = doc(scan([(LINE_C1, 0.6)], 1))
    out = merge_doc(
        SHA,
        d,
        [other, *extract_class_mentions(d, SPEC)],
        [SPEC],
        ReaderCache(tmp_path),
        M,
    )
    assert out[0] == other, "чужой параметр не трогаем и источник текста ему не пишем"


# ─────────────────────────────────────────────── L2 независимый пересчёт


@pytest.mark.l2_differential
def test_reader_reading_the_same_text_changes_no_value_or_confidence():
    lines = [
        (LINE_C0, 0.3),
        ("не ниже С1 по классу конструктивной пожарной опасности", 0.45),
        (LINE_C1, 0.8),
    ]
    page = scan(lines)
    base = ens(page)
    rng = band_ranges()
    per_band = [
        "\n".join(t for t, y in lines if y0 <= y + 0.006 <= y1) for y0, y1 in rng
    ]
    out = merge(page, bands(*per_band))
    assert [(e.value_text, e.confidence, e.page) for e in out] == [
        (e.value_text, e.confidence, e.page) for e in base
    ]
    assert {e.meta["reader_outcome"] for e in out} == {"agree"}


# ─────────────────────────────────────────────── L3 границы


@pytest.mark.l3_boundary
def test_reader_mention_in_other_band_is_not_matched():
    page = scan([(LINE_C1, 0.1)])  # ансамбль — верх листа
    out = merge(page, bands("", "", "", LINE_C0), reader2=None)  # читатель — низ листа
    outcomes = sorted(e.meta["reader_outcome"] for e in out)
    assert outcomes == ["ensemble-only", "reader-only-unconfirmed"]


@pytest.mark.l3_boundary
def test_overlap_duplicate_is_one_mention():
    y0, y1 = band_ranges()[1]
    both = [Band(y0, y1, LINE_C0), Band(y0 + 0.01, y1, LINE_C0)]
    (b, _), = readers.band_mentions(both, 1, SPEC)
    assert (b.y0, b.y1) == (y0, y1), "полоса склеенного упоминания — объединение обеих"
    lo = band_ranges()[0]
    (b2, _), = readers.band_mentions([Band(*lo, LINE_C0), Band(y0, y1, LINE_C0)], 1, SPEC)
    assert (b2.y0, b2.y1) == (lo[0], y1)


# ─────────────────────────────────────────────── L4 отказы


@pytest.mark.l4_fault
def test_broken_cache_file_is_missing_not_crash(tmp_path):
    rc = ReaderCache(tmp_path)
    rc.put_page(SHA, 1, M.reader, bands("x"), 5)
    f = next((tmp_path / SHA).glob("p1-*.json"))
    f.write_text("{оборвано")
    assert rc.get_page(SHA, 1, M.reader) is None
    assert rc.get_crop(SHA, 1, (0, 0, 1, 1), M.reader2) is None


@pytest.mark.l4_fault
def test_signature_changes_when_reading_added(tmp_path):
    rc = ReaderCache(tmp_path)
    assert rc.signature(SHA) == ""
    rc.put_page(SHA, 1, M.reader, bands(LINE_C0), 5)
    s1 = rc.signature(SHA)
    rc.put_crop(SHA, 1, (0.1, 0.2, 0.3, 0.4), M.reader2, "С0", 5)
    assert s1 and rc.signature(SHA) != s1
    assert rc.get_page(SHA, 1, M.reader) == bands(LINE_C0)


# ─────────────────────────────────────────────── L5 инварианты перебором


@pytest.mark.l5_property
def test_value_changes_only_with_two_of_three_whole_space():
    for tv, rv, r2 in itertools.product(SCALE, SCALE, [*SCALE, None]):
        page = scan([(f"Класс конструктивной пожарной опасности - {tv}", 0.6)])
        out = merge(
            page,
            bands("", "", f"Класс конструктивной пожарной опасности - {rv}"),
            reader2=r2,
        )
        assert len(out) == 1
        e = out[0]
        want = rv if (rv != tv and r2 == rv) else tv
        assert e.value_text == want, (tv, rv, r2)
        assert e.value_text in (tv, rv), "читатели не выдумывают третьего значения"
        if e.meta.get("excluded") is None and e.value_text != tv:
            assert e.confidence == CONFIRMED_CONF


@pytest.mark.l5_property
def test_reader_only_is_usable_only_when_second_reader_agrees_whole_space():
    for rv, r2 in itertools.product(SCALE, [*SCALE, None, "мусор"]):
        e = merge(
            scan([("Ведомость", 0.1)]),
            bands("", "", f"Класс конструктивной пожарной опасности - {rv}"),
            reader2=r2,
        )[0]
        usable = e.meta.get("excluded") is None
        assert usable == (r2 == rv), (rv, r2)


# ─────────────────────────────────────────────── L6 враждебный вход


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "bad", ["../" * 3 + "etc", "A" * 64, "a" * 63, "", "a" * 64 + "/x"]
)
def test_cache_rejects_non_hash_paths(tmp_path, bad):
    with pytest.raises(ValueError):
        ReaderCache(tmp_path).get_page(bad, 1, M.reader)


@pytest.mark.l6_adversarial
def test_hostile_reader_text_never_crashes():
    junk = [
        "",
        "\x00" * 50,
        "С" * 5000,
        "{" * 300,
        "класс конструктивной пожарной опасности " * 200,
        "С0 С1 С2 С3 " * 100,
    ]
    for t in junk:
        out = merge(scan([(LINE_C0, 0.6)]), bands(t, t, t, t), reader2=t)
        for e in out:
            assert e.value_text in SCALE


# ─────────────────────────────────────────────── L8 регрессия реального листа


@pytest.mark.l8_regression
def test_altufyevo_opz_2024_page_23_tesseract_so_is_c0_and_reader_agrees():
    """ОПЗ 2024, стр. 23 (скан): Tesseract дал «CO»/«Со», читатель PaddleOCR-VL — «С0» кириллицей (замер T-129)."""
    page = scan(
        [
            ("1.3. Степень огнестойкости здания- II", 0.5),
            ("1.4. Класс конструктивной пожарной опасности- CO", 0.525),
        ],
        n=23,
        conf=82.2,
    )
    out = merge(
        page,
        bands(
            "",
            "",
            "1.3. Степень огнестойкости здания- II\n1.4. Класс конструктивной пожарной опасности- С0",
        ),
    )
    assert [(e.value_text, e.meta["reader_outcome"]) for e in out] == [("С0", "agree")]


# ─────────────────────────────────────────────── L7 след сведения для карточки инспектора (добивание мутантов mutmut)


@pytest.mark.l7_discipline
def test_trace_of_every_outcome_is_complete_for_inspector_card():
    """Каждый исход сведения оставляет полный след: кто что прочитал (имена моделей), операцию PRM-14, источник текста;
    значение из прочтения читателя приходит вместе с его сырым текстом и ограничением «не ниже»."""
    # спор, 2 из 3 за читателя: значение, сырой текст и «не ниже» — из прочтения читателя
    page = scan([("Класс конструктивной пожарной опасности – С1", 0.6)])
    e = merge(page, bands("", "", "класс конструктивной пожарной опасности не ниже С0"), reader2="С0")[0]
    assert (e.value_text, e.raw, e.meta["qualifier"]) == ("С0", "С0", "min")
    assert e.meta["readings"] == [{"by": "ансамбль", "value": "С1"}, {"by": M.reader, "value": "С0"}, {"by": M.reader2, "value": "С0"}]
    assert e.meta["ops"][-1] == "PRM-14" and "ENT-16" in e.meta["ops"]
    # 2 из 3 за ансамбль и без большинства — тоже с PRM-14 и тремя прочтениями
    for r2, outcome in (("С1", "majority-ensemble"), (None, "no-majority")):
        e = merge(page, bands("", "", LINE_C0), reader2=r2)[0]
        assert e.meta["reader_outcome"] == outcome and e.meta["ops"].count("PRM-14") == 1
        assert [r["by"] for r in e.meta["readings"]] == ["ансамбль", M.reader, M.reader2]
    # только ансамбль: два прочтения, читатель — пусто; только читатель: ансамбль — пусто, PRM-14, источник
    e = merge(scan([(LINE_C0, 0.6)]), bands("", "", "Ведомость"))[0]
    assert e.meta["readings"] == [{"by": "ансамбль", "value": "С0"}, {"by": M.reader, "value": None}]
    assert "PRM-14" not in e.meta["ops"], "читатель не участвовал — операции чтения нет"
    e = merge(scan([("Ведомость", 0.1)]), bands("", "", LINE_C1), reader2="С1")[0]
    assert e.meta["readings"] == [{"by": "ансамбль", "value": None}, {"by": M.reader, "value": "С1"}, {"by": M.reader2, "value": "С1"}]
    assert e.meta["ops"].count("PRM-14") == 1 and e.meta["text_source"] == "scan-reader" and e.anchor_bbox is None


@pytest.mark.l3_boundary
def test_band_edges_are_inclusive_and_match_threshold():
    """Упоминание ровно на границе полосы — в полосе; сходство цитат ровно на пороге — одно упоминание."""
    y0, y1 = band_ranges()[2]
    for y in (y0 - 0.006, y1 - 0.006):  # центр рамки строки = y + 0.006 → ровно y0 и ровно y1
        page = scan([(LINE_C0, y)])
        out = merge(page, bands("", "", LINE_C0))
        assert [x.meta["reader_outcome"] for x in out] == ["agree"], y
    assert readers.MATCH_MIN == 50 and readers.LOCATE_MIN == 60 and readers.TRACE_MIN == 75


@pytest.mark.l1_functional
def test_slug_box_key_and_cache_file_names_are_stable(tmp_path):
    """Имена файлов кэша — контракт между этапом и сервисом: разойдутся — сервис не найдёт прочтения."""
    assert readers._slug("mlx-community/PaddleOCR-VL-1.5-bf16") == "PaddleOCR_VL_1.5_bf16", "дефис тоже заменяется — так названы файлы кэша на диске"
    assert readers._slug("a/b c+d") == "b_c_d"
    assert readers.box_key((0.1, 0.25, 0.5, 1.0)) == "0.100_0.250_0.500_1.000"
    rc = ReaderCache(tmp_path)
    rc.put_page(SHA, 3, M.reader, bands("x"), 12)
    rc.put_crop(SHA, 3, (0.1, 0.2, 0.3, 0.4), M.reader2, "С0", 7)
    names = sorted(p.name for p in (tmp_path / SHA).iterdir())
    assert names == ["c3-0.100_0.200_0.300_0.400-GLM_OCR_bf16.json", "p3-PaddleOCR_VL_1.5_bf16.json"]
    page = json.loads((tmp_path / SHA / names[1]).read_text())
    assert (page["model"], page["ms"], page["bands"][0]["text"]) == (M.reader, 12, "x")
    crop = json.loads((tmp_path / SHA / names[0]).read_text())
    assert (crop["model"], crop["ms"], crop["text"]) == (M.reader2, 7, "С0")
    assert not list((tmp_path / SHA).glob("*.tmp")), "запись атомарная: временных файлов не остаётся"


@pytest.mark.l1_functional
def test_trace_phrase_and_page_text_details():
    assert trace_phrase({"anchor": r"класс\w*\s+ПОЖАРН\w*"}) == "класс пожарн", "основы в нижнем регистре, \\w и \\s — не буквы"
    assert trace_phrase({"anchor": r"С0\s+ab"}) == "", "короче трёх букв — не основа"
    assert readers.has_trace(scan([("КЛАСС конструктивной ПОЖАРНОЙ опасности", 0.5)]), trace_phrase(CFG)), "регистр не важен"
    assert not readers.has_trace(scan([("Ведомость", 0.5)]), "")


@pytest.mark.l1_functional
def test_second_value_prefers_rule_mention_over_bare_classes():
    assert second_value("норма С1 С2; класс конструктивной пожарной опасности С0", SPEC) == "С0", "упоминание по правилам важнее голых классов"
    assert second_value("C1", ParamSpec(code="X", anchors=[], extractor={k: v for k, v in CFG.items() if k != "scale"})) == "С1", "без шкалы — любой класс"


@pytest.mark.l7_discipline
def test_text_source_for_structured_and_existing_tag_kept():
    from inspector_ml.model import Extraction

    d = ParsedDoc(sha256=SHA, kind="docx", engine="python-docx", pages=[Page(page=1, width=0, height=0, source="structured", lines=[line_at(LINE_C0, 0.1)])])
    (e,) = readers.tag_text_source(d, extract_class_mentions(d, SPEC), {"M-023"})
    assert e.meta["text_source"] == "structured"
    pre = Extraction(code="M-023", raw="С0", value_text="С0", page=9, bbox=None, line_text="", confidence=1, meta={"text_source": "scan-reader"})
    (k,) = readers.tag_text_source(d, [pre], {"M-023"})
    assert k.meta["text_source"] == "scan-reader", "уже помеченное сведением не перезаписывается"
    (u,) = readers.tag_text_source(d, [pre.model_copy(update={"meta": None, "page": 99})], {"M-023"})
    assert u.meta["text_source"] == "structured", "страница вне документа — structured, а не падение"
