"""T-178, OWASP-аудит 2026-09-28 (SEC-T178-01…07): разбор недоверенного текста L1–L3 не зависает на строках-атаках
и не падает на «цифрах», которые не числа. Бюджет — 1 с на атаку (до исправления — минуты)."""

from __future__ import annotations

import time

import pytest

from inspector_ml import identity as I
from inspector_ml import mentions as M
from inspector_ml import table_reader as R
from test_identity import V, doc, stamp_page, text_page
from test_mentions import text_doc
from test_table_reader import mk

BUDGET_S = 1.0


def timed(fn):
    t0 = time.perf_counter()
    out = fn()
    assert time.perf_counter() - t0 < BUDGET_S
    return out


@pytest.mark.parametrize("word", ["класс", "бетон", "категори", "этажност", "отметк", "расчетн", "степен"])
@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_long_word_of_repeated_anchor_prefix_is_linear(word):
    d = text_doc((word * (100_000 // len(word))))
    assert timed(lambda: M.text_mentions(d)) == []
    assert timed(lambda: I.floor_mentions(d)) == []


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_punctuation_filler_does_not_explode_sheet_floor_and_sections():
    assert timed(lambda: I.sheet_floor("1" + "." * 4000 + "x")).kind is None
    assert timed(lambda: I.sheet_floor("отм" * 33_000)).elevation is None
    assert timed(lambda: R._is_section("1" + "." * 100_000 + "abc", "text")) is False
    timed(lambda: R._is_section("этаж" * 25_000 + " x", "text"))  # важна только скорость


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_many_mentions_capped_per_page():
    d = text_doc("бетон класса B25 " * 6000)
    ms = timed(lambda: M.text_mentions(d))
    assert len(ms) == M.MAX_MENTIONS
    fl = timed(lambda: I.floor_mentions(doc(text_page("9-этажный " * 3000))))
    assert len(fl) == I.MAX_FLOOR_MENTIONS


@pytest.mark.l4_fault
def test_superscript_digits_are_not_numbers():
    sid = I.read_identity(stamp_page({**V, "sheets": "²"}))
    assert sid.ok and sid.sheets is None
    rd = R.read_table(mk([["Наименование", "Значение"], ["²", "³"], ["Площадь", "5"]]))
    assert [r.name for r in rd.rows][-1] == "Площадь"
    assert not R._is_numbering(mk([["²", "³"]]).grid[0])


@pytest.mark.l4_fault
@pytest.mark.performance
def test_sheet_range_expansion_capped():
    out = timed(lambda: I._sheets("1-200 " * 16_000))
    assert len(out) < I.MAX_SHEETS_EXPANDED + 16_000


@pytest.mark.l4_fault
def test_registry_revision_garbage_and_dates_and_status_case():
    assert I.rev_no("9" * 5000) is None
    assert I.rev_no("ред. 2 от 15.03.2025") == 2
    v = I.revision_status([I.RevisionEvidence(file_id="a", doc_stage="RD", code="X-1", registry_revision="1", approval_status="superseded")])
    assert v["a"].status == "STALE"


@pytest.mark.l4_fault
def test_doc_identity_survives_page_failure(monkeypatch):
    def boom(page, **kw):
        raise ValueError("x")

    monkeypatch.setattr(I, "read_identity", boom)
    di = I.doc_identity(doc(stamp_page(V)))
    assert di.read == 0 and "ValueError" in di.pages[0].reason
