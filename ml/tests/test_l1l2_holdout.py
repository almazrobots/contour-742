"""HOLDOUT-генератор T-178: детерминизм по seed, согласованность gold, текстовый слой PDF."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pypdfium2 as pdfium
import pytest

from synth import l1l2_holdout as h


def _text(pdf: Path) -> str:
    doc = pdfium.PdfDocument(str(pdf))
    try:
        page = doc[0]
        tp = page.get_textpage()
        return tp.get_text_range()
    finally:
        doc.close()


def _squash(s: str) -> str:
    return re.sub(r"\s+", "", s)


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("h1")
    gold = h.generate(out, seed=11, sheets=12, tables=8)
    return out, gold


def test_deterministic_by_seed(run, tmp_path):
    out, gold = run
    again = h.generate(tmp_path / "b", seed=11, sheets=12, tables=8)
    assert again == gold
    for f in sorted(out.glob("*.pdf")):
        assert (tmp_path / "b" / f.name).read_bytes() == f.read_bytes(), f.name
    other = h.generate(tmp_path / "c", seed=12, sheets=12, tables=8)
    assert other != gold


def test_gold_file_matches_return(run):
    out, gold = run
    assert json.loads((out / "gold.json").read_text(encoding="utf-8")) == gold
    assert gold["generator"] == "holdout-v1" and gold["seed"] == 11


def test_stamp_gold_consistent(run):
    _, gold = run
    cap = {3: 3, 5: 1, 6: 2}
    for s in gold["stamps"]:
        assert s["form"] in cap
        assert len(s["changes"]) <= cap[s["form"]]
        izm = [int(c["izm"]) for c in s["changes"]]
        assert izm == sorted(
            izm, reverse=True
        )  # сверху вниз — убывание (заполнение снизу вверх)
        assert s["revision"] == (max(izm) if izm else None)
        if s["form"] == 6:
            assert s["stage"] is None and s["sheets"] is None
        else:
            assert s["stage"] in ("П", "Р")
        assert "Заказчик" not in s["code"]
        for c in s["changes"]:
            assert set(c) == {"izm", "kol_uch", "sheet", "doc_no", "date"}


def test_table_gold_consistent(run):
    _, gold = run
    for t in gold["tables"]:
        assert t["kind"] in ("tep", "explication") and t["rows"]
        for r in t["rows"]:
            assert len(r["values"]) == len(t["value_columns"])
            assert r["unit"] in (None, *h.UNIT_PRINT)
            assert not r["name"].endswith("-") and "\n" not in r["name"]
        if t["kind"] == "explication":
            data = [r for r in t["rows"] if not r["total"]]
            assert all("category" in r for r in t["rows"])
            for tot in (
                r for r in t["rows"] if r["total"] and r["name"].startswith("Итого")
            ):
                # итог по разделу или общий итог в конце («Итого» бывает и тем, и другим)
                part = round(
                    sum(r["values"][0] for r in data if r["section"] == tot["section"]),
                    1,
                )
                whole = round(sum(r["values"][0] for r in data), 1)
                assert (
                    min(abs(tot["values"][0] - part), abs(tot["values"][0] - whole))
                    < 0.051
                )


def test_text_layer_has_gold(run):
    out, gold = run
    for s in gold["stamps"]:
        txt = _squash(_text(out / s["file"]))
        assert _squash(s["code"]) in txt, s["file"]
        for c in s["changes"]:
            assert _squash(c["doc_no"]) in txt
    for t in gold["tables"]:
        txt = _text(out / t["file"])
        first = t["rows"][0]["name"].split()[0]
        assert first.rstrip(",")[:4] in txt, t["file"]


def test_fonts_have_needed_glyphs():
    assert h.has_glyphs("Noto", "м²м³№«»ёЁ—")


def test_wrap_hyphen_keeps_parts():
    lines = h.wrap(
        "Площадь застройки многоквартирного дома", "Noto", 3.0, 22, hyphen=True
    )
    joined = " ".join(lines)
    assert len(lines) >= 2
    assert (
        re.sub(r"-\s", "", joined).replace(" ", "")
        == "Площадьзастройкимногоквартирногодома"
    )
