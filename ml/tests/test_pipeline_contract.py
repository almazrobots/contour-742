"""T-237: trace identity, fail-closed completeness and actual PDF geometry."""

import pytest
from contextlib import closing
from pydantic import ValidationError

from inspector_ml.model import AnalyzeResponse, Extraction, Line, Page, ParsedDoc, Word
from inspector_ml.pipeline_contract import (
    STAGES, Context, Policy, Region, StageReceipt, completeness, digest, identity, transcription,
)
from inspector_ml.pipeline_geometry import apply, pdf_regions

SHA = "a" * 64


def sample(source="ocr"):
    pid = identity("page", SHA, 1)
    region = Region(id=identity("region", pid, [0, 0, 1, 1]), page_id=pid, page=1)
    doc = ParsedDoc(sha256=SHA, kind="pdf", engine="anchor+reader", pages=[
        Page(page=1, width=100, height=100, source=source, engines=["anchor", "reader"],
             agreement=1, lines=[Line(text="900 mm", words=[Word(text="900", bbox=(.1, .2, .3, .4))])])])
    receipts = [StageReceipt(stage=s, region_id=region.id if s == "parse" else None,
                             input_digests=[SHA], output_digest=SHA, status="complete") for s in STAGES]
    return doc, [region], receipts


@pytest.mark.l1_functional
def test_canonical_fingerprint_and_stable_ids():
    assert digest({"nested": [150.0, -0.0, 0.5]}) == digest({"nested": [150, 0, 0.5]})
    doc, regions, _ = sample()
    a = transcription(doc, regions)
    assert a == transcription(doc.model_copy(deep=True), regions)
    assert digest({"dpi": 300, "models": ["a", "b"]}) == digest({"models": ["a", "b"], "dpi": 300})
    for change in ({"dpi": 600, "models": ["a", "b"]}, {"dpi": 300, "models": ["b", "a"]}):
        assert digest(change) != digest({"dpi": 300, "models": ["a", "b"]})
    doc.pages[0].lines[0].words[0].text = "800"
    b = transcription(doc, regions)
    assert a[0].region == b[0].region
    assert a[0].lines[0].tokens[0].id != b[0].lines[0].tokens[0].id


@pytest.mark.l6_adversarial
def test_frozen_context_rejects_changed_config_and_extra_fields():
    policy = Policy()
    config = {"render_dpi": 300, "model_digest": SHA}
    ctx = dict(run_id="01234567-0123-0123-0123-012345678901", sha256=SHA,
               configuration=config, configuration_fingerprint=digest({"configuration": config, "policy": policy.model_dump()}),
               policy=policy, request_fingerprint=SHA)
    Context(**ctx)
    with pytest.raises(ValidationError, match="fingerprint"):
        Context(**{**ctx, "configuration": {**config, "render_dpi": 600}})
    with pytest.raises(ValidationError):
        Context(**ctx, subject_status="NEGATIVE_VERIFIED")


@pytest.mark.l4_fault
@pytest.mark.parametrize("failure", ["missing_region", "duplicate_region", "missing_stage", "duplicate_stage", "reader", "reader_band", "abstain", "failed_receipt"])
def test_complete_agreement_does_not_hide_incomplete_execution(failure):
    doc, regions, receipts = sample()
    pages = transcription(doc, regions)
    policy = Policy(required_ocr_engines=["anchor", "reader"])
    assert completeness(regions, receipts, pages, policy).publishable
    if failure == "missing_region":
        pages = []
    elif failure == "duplicate_region":
        pages *= 2
    elif failure == "missing_stage":
        receipts = receipts[:-1]
    elif failure == "duplicate_stage":
        receipts.append(receipts[0])
    elif failure == "reader":
        pages[0].engines = ["anchor"]
    elif failure == "reader_band":
        pages[0].execution_failures = ["reader:band:1:reader_unavailable"]
    elif failure == "abstain":
        pages[0].quality = "ABSTAIN"
    else:
        receipts[-1] = receipts[-1].model_copy(update={"status": "incomplete", "reasons": ["timeout"]})
    result = completeness(regions, receipts, pages, policy)
    assert not result.publishable and result.reasons


@pytest.mark.l4_fault
@pytest.mark.parametrize("outcome,ok", [(None, False), ("error", False), ("skipped", False), ("confirmed", True), ("conflict", True), ("unreadable", True)])
def test_required_judge_has_to_execute(outcome, ok):
    doc, regions, receipts = sample()
    e = Extraction(code="M023", raw="C0", value_text="C0", page=1, bbox=None,
                   line_text="C0", confidence=1, meta={"ops": ["ENT-16"], "vlm": {"outcome": outcome}})
    result = AnalyzeResponse(sha256=SHA, kind="pdf", engine="test", pages=[], extractions=[e], facts=[], rooms=[])
    summary = completeness(regions, receipts, transcription(doc, regions), Policy(require_judge=True), result)
    assert summary.publishable is ok
    # This contract never grants a subject/inspector decision even on success.
    assert "subject_status" not in summary.model_dump()


@pytest.mark.l2_differential
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_crop_and_rotate_transform_matches_existing_bbox(tmp_path, rotation):
    import pypdfium2 as pdfium
    from inspector_ml.parse import PDFIUM_LOCK, norm_box
    from tests.test_parse_parts import text_pdf, sha

    source = text_pdf(tmp_path / "base.pdf", 1)
    output = tmp_path / "crop.pdf"
    with PDFIUM_LOCK, pdfium.PdfDocument(source) as pdf, closing(pdf[0]) as page:
        page.set_cropbox(20, 30, 580, 280)
        page.set_rotation(rotation)
        pdf.save(output)
    regions = pdf_regions(output, sha(output))
    g = regions[0].geometry
    assert g.rotation == rotation
    points = [(40, 60), (180, 180)]
    transformed = [apply(g.pdf_to_visible, *point) for point in points]
    for original, visible in zip(points, transformed):
        assert apply(g.visible_to_pdf, *visible) == pytest.approx(original)
    x, y = zip(*transformed)
    with PDFIUM_LOCK, pdfium.PdfDocument(output) as pdf, closing(pdf[0]) as p:
        assert (min(x), min(y), max(x), max(y)) == pytest.approx(norm_box(p, 40, 60, 180, 180), abs=1e-5)


@pytest.mark.l6_adversarial
def test_foreign_or_truncated_transcription_is_rejected():
    doc, regions, _ = sample()
    with pytest.raises(ValueError, match="cover"):
        transcription(doc, [])
    doc.sha256 = "f" * 64
    with pytest.raises(ValueError, match="different source"):
        transcription(doc, regions)
