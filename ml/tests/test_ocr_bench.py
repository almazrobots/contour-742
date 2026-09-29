"""OS-INSP-6.5.18 (ТЗ 9.1.1, 14.3): стенд качества OCR — обвязка метрик без настоящего OCR.

Разбор подменяется «идеальным OCR» (текст эталона) и «сломанным OCR»: так проверяется, что CA, EM по видам полей,
coverage, доля нечитаемых зон и вердикт считаются из того, что вернул разбор, а не из эталона.
"""

from __future__ import annotations

import pytest

from eval import ocr_bench as B
from inspector_ml.model import Line, Page, ParsedDoc, Word


def _doc_from(item, mutate=lambda t: t, quality="OK", broken_quality="ABSTAIN"):
    pages = []
    for g in item["pages"]:
        lines = (
            []
            if g["broken"] and broken_quality == "ABSTAIN"
            else [
                Line(
                    text=mutate(t),
                    words=[
                        Word(text=w, bbox=(0.1, 0.02 * i, 0.2, 0.02 * i + 0.01))
                        for w in mutate(t).split()
                    ],
                )
                for i, t in enumerate(g["text"].split("\n"))
            ]
        )
        pages.append(
            Page(
                page=g["page"],
                width=595,
                height=842,
                source="ocr",
                quality=broken_quality if g["broken"] else quality,
                ocr_confidence=90,
                lines=lines,
            )
        )
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="fake", pages=pages)


@pytest.fixture(scope="module")
def items(tmp_path_factory):
    return B.build(tmp_path_factory.mktemp("ocr"), docs=4, pages=2, seed=3)  # сканы рендерятся один раз на модуль


@pytest.mark.l1_functional
def test_build_writes_scans_and_gold_with_one_broken_page_every_fourth_doc(items):
    assert len(items) == 4 and all(len(it["pages"]) == 2 for it in items)
    assert [g["broken"] for it in items for g in it["pages"]] == [False] * 7 + [True]
    assert {g["dpi"] for it in items for g in it["pages"]} == {
        300,
        400,
    }  # ТЗ 9.1.1: печатный текст ≥ 300 dpi
    for it in items:
        g = it["pages"][0]
        assert (
            g["text"].startswith(f"Шифр: {g['fields']['code']}")
            and f"Помещение {g['fields']['room']} " in g["text"]
        )


@pytest.mark.l2_differential
def test_perfect_ocr_gives_full_accuracy_and_acceptance(items, monkeypatch):
    by_path = {it["path"]: it for it in items}
    monkeypatch.setattr(
        "inspector_ml.parse.parse_file", lambda p, sha: _doc_from(by_path[str(p)])
    )
    r = B.evaluate(items)
    m = r["metrics"]
    assert m["character_accuracy"]["value"] == 1.0 and m["cer"]["value"] == 0.0
    assert {k: m[f"exact_match_{k}"]["value"] for k in B.FIELDS} == dict.fromkeys(
        B.FIELDS, 1.0
    )
    assert m["exact_match"]["n"] == 7 * len(
        B.FIELDS
    )  # нечитаемая страница в CA/EM не входит
    assert r["illegible_detection"] == {"broken_pages": 1, "flagged": 1}
    assert m["illegible_share"]["value"] == pytest.approx(1 / 8, abs=1e-4)
    assert m["page_coverage"]["value"] == pytest.approx(7 / 8, abs=1e-4)
    assert (
        r["verdict"] == "принято"
        and m["character_accuracy"]["passed"]
        and m["exact_match"]["ci_passed"]
    )


@pytest.mark.l6_adversarial
def test_ocr_that_breaks_codes_fails_exact_match_and_verdict(items, monkeypatch):
    """Гомоглиф и потерянный дефис в шифре — EM шифра падает, вердикт «не принято» по порогу 0,90."""
    by_path = {it["path"]: it for it in items}
    ruin = lambda t: t.replace("-", " ").replace("Р", "P", 1)  # noqa: E731
    monkeypatch.setattr(
        "inspector_ml.parse.parse_file", lambda p, sha: _doc_from(by_path[str(p)], ruin)
    )
    r = B.evaluate(items)
    assert r["metrics"]["exact_match_code"]["value"] < 0.9
    assert r["verdict"] == "не принято"


@pytest.mark.l4_fault
def test_unflagged_broken_page_fails_verdict(items, monkeypatch):
    """Нечитаемая страница, выданная за «OK», — вердикт «не принято»: мусор не должен выдаваться за текст."""
    by_path = {it["path"]: it for it in items}
    monkeypatch.setattr(
        "inspector_ml.parse.parse_file",
        lambda p, sha: _doc_from(by_path[str(p)], broken_quality="OK"),
    )
    r = B.evaluate(items)
    assert r["illegible_detection"] == {"broken_pages": 1, "flagged": 0}
    assert r["verdict"] == "не принято"


@pytest.mark.l1_functional
def test_markdown_report_names_thresholds_and_tz_points(items, monkeypatch):
    by_path = {it["path"]: it for it in items}
    monkeypatch.setattr(
        "inspector_ml.parse.parse_file", lambda p, sha: _doc_from(by_path[str(p)])
    )
    res = {
        "at": "2026-09-27T00:00:00Z",
        "host": "test",
        "config": {"docs": 4, "pages": 2, "seed": 3},
        **B.evaluate(items),
    }
    md = B.to_markdown(res)
    assert (
        "## Вердикт: **ПРИНЯТО**" in md
        and "| Character Accuracy = 1 − CER | >= 0.95 |" in md
    )
    assert (
        "Exact Match — номер помещения" in md
        and "Нечитаемые страницы помечены LOW_QUALITY/ABSTAIN: **1 из 1**" in md
    )
    assert (
        "не скрытая выборка организатора" in md.lower()
        or "Синтетика, не скрытая выборка организатора" in md
    )


@pytest.mark.l8_regression
def test_key_field_code_is_not_taken_from_a_fuzzy_anchor_line():
    """Регрессия (T-138, стенд OCR 9.1.1): на OCR-странице якорь «Шифр» нечётко совпал со строкой «Ширина
    эвакуационного выхода…», и шифром стало слово «эвакуационного» (EM шифра 0,61). Шифр всегда содержит цифру."""
    from eval.run import key_fields

    lines = ["Ширина эвакуационного выхода не менее 1,2 м согласно СП 1.13130.2020.", "Шифр: ALT-77.1-ПЗ3   Стадия: П   Ред. 2   Лист 1"]
    page = Page(page=1, width=595, height=842, source="ocr", ocr_confidence=90, lines=[Line(text=t, words=[Word(text=w) for w in t.split()]) for t in lines])
    got = key_fields(ParsedDoc(sha256="0" * 64, kind="pdf", engine="t", pages=[page]))
    assert got[(1, "code")] == "ALT-77.1-ПЗ3"
    # строка штампа не прочиталась — шифра нет, а не слово из чужой строки
    alone = Page(page=1, width=595, height=842, source="ocr", ocr_confidence=90, lines=[page.lines[0]])
    assert (1, "code") not in key_fields(ParsedDoc(sha256="0" * 64, kind="pdf", engine="t", pages=[alone]))
