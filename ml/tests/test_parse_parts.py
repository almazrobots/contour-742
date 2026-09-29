"""T-233: том PDF частями — части разбирают разные процессы ML, /analyze берёт собранный разбор из кэша.
Проверяется: часть = срез целого разбора, сборка = целый разбор, дыры и недостающие части — отказ, а не неполный том."""

import hashlib

import pytest
from reportlab.pdfgen import canvas

from inspector_ml import parse as P
from inspector_ml.cache import FileCache
from inspector_ml.docstore import PartMissing, assemble_parts, parse_part, parsed_key


def text_pdf(path, n):
    c = canvas.Canvas(str(path), pagesize=(600, 300))
    for i in range(n):
        c.drawString(
            40,
            150,
            f"Sheet {i + 1}: fire resistance degree II, structural fire hazard class C0, text layer long enough",
        )
        c.showPage()
    c.save()
    return path


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def dump(pages):
    return [p.model_dump() for p in pages]


@pytest.mark.l2_differential
def test_part_equals_slice_of_whole(tmp_path):
    f = text_pdf(tmp_path / "t.pdf", 5)
    whole = P.parse_pdf(f, sha(f))
    part = P.parse_pdf_part(f, sha(f), 1, 4)
    assert [p.page for p in part.pages] == [2, 3, 4]  # номера — как в целом томе
    assert dump(part.pages) == dump(whole.pages[1:4])


@pytest.mark.l2_differential
def test_assembled_equals_whole_and_lands_in_parsed_cache(tmp_path):
    f = text_pdf(tmp_path / "t.pdf", 5)
    s = sha(f)
    cache = FileCache(tmp_path / "c")
    ranges = [(0, 2), (2, 4), (4, 5)]
    for first, last in reversed(ranges):  # части кончают в любом порядке
        parse_part(cache, f, s, first, last)
    doc = assemble_parts(cache, f, s, ranges)
    assert dump(doc.pages) == dump(P.parse_pdf(f, s).pages)
    assert (
        cache.get(parsed_key(s)) is not None
    )  # /analyze возьмёт собранное, не разберёт заново


@pytest.mark.l3_boundary
@pytest.mark.parametrize("ranges", [[(0, 2), (3, 5)], [(1, 5)], [(0, 3), (2, 5)], []])
def test_gaps_or_overlaps_refused(tmp_path, ranges):
    f = text_pdf(tmp_path / "t.pdf", 5)
    with pytest.raises(ValueError):
        assemble_parts(FileCache(tmp_path / "c"), f, sha(f), ranges)


@pytest.mark.l4_fault
def test_missing_part_refused_and_nothing_cached(tmp_path):
    f = text_pdf(tmp_path / "t.pdf", 4)
    s = sha(f)
    cache = FileCache(tmp_path / "c")
    parse_part(cache, f, s, 0, 2)
    with pytest.raises(PartMissing):
        assemble_parts(cache, f, s, [(0, 2), (2, 4)])
    assert cache.get(parsed_key(s)) is None


@pytest.mark.l3_boundary
def test_part_outside_document_refused(tmp_path):
    f = text_pdf(tmp_path / "t.pdf", 3)
    with pytest.raises(ValueError):
        P.parse_pdf_part(f, sha(f), 3, 6)


@pytest.mark.l2_differential
def test_part_taken_from_whole_parse_without_reparse(tmp_path, monkeypatch):
    f = text_pdf(tmp_path / "t.pdf", 4)
    s = sha(f)
    cache = FileCache(tmp_path / "c")
    cache.set(parsed_key(s), P.parse_pdf(f, s).model_dump_json())
    monkeypatch.setattr(
        "inspector_ml.docstore.parse_pdf_part",
        lambda *a: pytest.fail("разбор повторён"),
    )
    doc, cached = parse_part(cache, f, s, 2, 4)
    assert cached and [p.page for p in doc.pages] == [3, 4]


@pytest.mark.l4_fault
def test_incomplete_tail_cannot_publish_whole(tmp_path):
    f = text_pdf(tmp_path / "five.pdf", 5)
    s, cache = sha(f), FileCache(tmp_path / "cache")
    parse_part(cache, f, s, 0, 2)
    with pytest.raises(ValueError):
        assemble_parts(cache, f, s, [(0, 2)])
    assert cache.get(parsed_key(s)) is None


@pytest.mark.l4_fault
@pytest.mark.parametrize("damage", ["sha", "kind", "missing", "duplicate", "outside", "order"])
def test_corrupt_part_cannot_publish_whole(tmp_path, damage):
    from inspector_ml.docstore import part_key

    f = text_pdf(tmp_path / "two.pdf", 2)
    s, cache = sha(f), FileCache(tmp_path / "cache")
    doc, _ = parse_part(cache, f, s, 0, 2)
    changes = {
        "sha": {"sha256": "f" * 64},
        "kind": {"kind": "docx"},
        "missing": {"pages": doc.pages[:1]},
        "duplicate": {"pages": [doc.pages[0], doc.pages[0]]},
        "outside": {"pages": [doc.pages[0], doc.pages[1].model_copy(update={"page": 3})]},
        "order": {"pages": list(reversed(doc.pages))},
    }
    cache.set(part_key(s, 0, 2), doc.model_copy(update=changes[damage]).model_dump_json())
    with pytest.raises(ValueError):
        assemble_parts(cache, f, s, [(0, 2)])
    assert cache.get(parsed_key(s)) is None


@pytest.mark.l3_boundary
@pytest.mark.parametrize("cached", [False, True])
@pytest.mark.parametrize("first,last", [(-1, 1), (0, 0), (2, 1), (2, 4), (0, 3)])
def test_range_rejected_with_and_without_whole_cache(tmp_path, cached, first, last):
    f = text_pdf(tmp_path / "two.pdf", 2)
    s, cache = sha(f), FileCache(tmp_path / "cache")
    if cached:
        cache.set(parsed_key(s), P.parse_pdf(f, s).model_dump_json())
    with pytest.raises(ValueError):
        parse_part(cache, f, s, first, last)


@pytest.mark.l4_fault
@pytest.mark.parametrize("cached_kind", ["part", "whole"])
def test_invalid_cache_hit_is_not_returned(tmp_path, cached_kind):
    from inspector_ml.docstore import part_key

    f = text_pdf(tmp_path / "two.pdf", 2)
    s, cache = sha(f), FileCache(tmp_path / "cache")
    doc = P.parse_pdf(f, s).model_copy(update={"sha256": "f" * 64})
    key = parsed_key(s) if cached_kind == "whole" else part_key(s, 0, 2)
    cache.set(key, doc.model_dump_json())
    with pytest.raises(ValueError):
        parse_part(cache, f, s, 0, 2)


@pytest.mark.l8_regression
def test_old_parser_cache_is_not_used(tmp_path):
    from inspector_ml.docstore import PARSER_REV, load_parsed

    f = text_pdf(tmp_path / "two.pdf", 2)
    s, cache = sha(f), FileCache(tmp_path / "cache")
    old_key = parsed_key(s).replace(f"-r{PARSER_REV}", "-r5")
    assert old_key != parsed_key(s)
    cache.set(old_key, "{incomplete old checkpoint")
    doc, hit = load_parsed(cache, f, s)
    assert not hit and [p.page for p in doc.pages] == [1, 2]
    assert cache.get(old_key) == "{incomplete old checkpoint"
