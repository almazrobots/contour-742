"""Versioned provenance for plan 07. Execution coverage is not evidence of absence.

IDs describe source geometry or a particular transcription artifact. They never
depend on a database row ID, wall clock, worker, or the order of job completion.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .model import AnalyzeResponse, ParsedDoc

SCHEMA = "pipeline.v1"
STAGES = ("preflight", "parse", "merge", "extract", "aggregate")
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Identifier = Annotated[str, Field(pattern=r"^[a-z]+:[0-9a-f]{64}$")]
PageNumber = Annotated[int, Field(strict=True, ge=1, le=100_000)]
Matrix = tuple[float, float, float, float, float, float]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def digest(value: object) -> str:
    """Stable through JSON/JavaScript: 150.0 and 150 denote the same number."""
    def numbers(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, dict):
            return {key: numbers(val) for key, val in item.items()}
        if isinstance(item, (list, tuple)):
            return [numbers(val) for val in item]
        return item

    return hashlib.sha256(json.dumps(numbers(value), ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def identity(kind: str, *inputs: object) -> str:
    return f"{kind}:{digest([SCHEMA, *inputs])}"


class Policy(Contract):
    name: Literal["legacy-compatible-v1", "regional-v1"] = "legacy-compatible-v1"
    # Frozen at preflight, not re-read from current environment on retry.
    required_ocr_engines: list[str] = Field(default_factory=list)
    require_judge: bool = False
    coverage: Literal["whole-page-legacy", "regional-full-coverage"] = "whole-page-legacy"


class Context(Contract):
    schema_version: Literal["pipeline.v1"] = SCHEMA
    run_id: Annotated[str, Field(pattern=r"^[0-9a-f-]{36}$")]
    sha256: Digest
    configuration: dict
    configuration_fingerprint: Digest
    policy: Policy
    request_fingerprint: Digest

    @model_validator(mode="after")
    def validate_fingerprint(self):
        if self.configuration_fingerprint != digest({"configuration": self.configuration,
                                                      "policy": self.policy.model_dump()}):
            raise ValueError("configuration fingerprint mismatch")
        return self


class Geometry(Contract):
    coordinate_space: Literal["visible-page-normalized-top-left"] = "visible-page-normalized-top-left"
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    rotation: Literal[0, 90, 180, 270]
    media_box: tuple[float, float, float, float]
    crop_box: tuple[float, float, float, float]
    # [a,b,c,d,e,f]: x'=a*x+c*y+e, y'=b*x+d*y+f; clipping is separate.
    pdf_to_visible: Matrix
    visible_to_pdf: Matrix


class Region(Contract):
    id: Identifier
    page_id: Identifier
    page: PageNumber
    bbox: tuple[float, float, float, float] = (0, 0, 1, 1)
    geometry: Geometry | None = None  # structured documents have no PDF geometry


class StageReceipt(Contract):
    stage: Literal["preflight", "parse", "merge", "extract", "aggregate"]
    region_id: Identifier | None = None
    input_digests: list[Digest]
    output_digest: Digest
    status: Literal["complete", "incomplete"]
    reasons: list[str] = Field(default_factory=list)
    cached: bool = False

    @model_validator(mode="after")
    def complete_has_no_failure(self):
        if (self.status == "complete") != (not self.reasons):
            raise ValueError("receipt status disagrees with reasons")
        return self


class TokenRef(Contract):
    id: Identifier
    text: str
    bbox: tuple[float, float, float, float] | None
    confidence: float | None
    disputed: bool


class LineRef(Contract):
    id: Identifier
    region_id: Identifier
    text: str
    tokens: list[TokenRef]


class PageTrace(Contract):
    region: Region
    transcription_digest: Digest
    source: str
    quality: str
    engines: list[str]
    agreement: float | None
    execution_failures: list[str] = Field(default_factory=list)
    lines: list[LineRef]


class Completeness(Contract):
    # Scope is deliberately explicit: executing the old page route does not
    # prove OCR recall on a hybrid sheet, nor prove a subject is absent.
    coverage_scope: Literal["whole-page-legacy", "regional-full-coverage"] = "whole-page-legacy"
    planned_regions: int = Field(ge=1)
    completed_regions: int = Field(ge=0)
    mandatory_stages_complete: bool
    publishable: bool
    reasons: list[str]


def transcription(doc: ParsedDoc, regions: list[Region]) -> list[PageTrace]:
    """One-to-one source/region binding; no positional zip truncation."""
    if len(doc.pages) != len(regions) or any(p.page != r.page for p, r in zip(doc.pages, regions)):
        raise ValueError("transcription does not cover the planned regions")
    out = []
    for p, region in zip(doc.pages, regions):
        if region.page_id != identity("page", doc.sha256, p.page):
            raise ValueError("region belongs to a different source")
        td = digest(p.model_dump(mode="json"))
        lines = []
        for i, line in enumerate(p.lines):
            lid = identity("line", region.id, td, i)
            lines.append(LineRef(id=lid, region_id=region.id, text=line.text, tokens=[
                TokenRef(id=identity("token", lid, j), text=w.text, bbox=w.bbox,
                         confidence=w.conf, disputed=w.disputed)
                for j, w in enumerate(line.words)
            ]))
        out.append(PageTrace(region=region, transcription_digest=td, source=p.source,
                             quality=p.quality, engines=p.engines, agreement=p.agreement,
                             execution_failures=p.execution_failures, lines=lines))
    return out


def completeness(regions: list[Region], receipts: list[StageReceipt], pages: list[PageTrace],
                 policy: Policy, result: AnalyzeResponse | None = None) -> Completeness:
    """Fail closed on missing/duplicated regions, Reader or Judge, independently of agreement."""
    planned = [r.id for r in regions]
    reasons = []
    if not planned or len(set(planned)) != len(planned):
        raise ValueError("empty or duplicated coverage plan")
    actual = [p.region.id for p in pages]
    if len(actual) != len(set(actual)) or set(actual) != set(planned):
        reasons.append("region_coverage_mismatch")
    for stage in STAGES:
        matches = [r for r in receipts if r.stage == stage]
        expected = set(planned) if stage == "parse" else {None}
        if (len(matches) != len(expected) or {r.region_id for r in matches} != expected
                or any(r.status != "complete" for r in matches)):
            reasons.append(f"stage_incomplete:{stage}")
    completed = 0
    for page in pages:
        if page.region.id not in planned:
            continue
        missing = set(policy.required_ocr_engines) - set(page.engines) if page.source == "ocr" else set()
        if missing:
            reasons.append(f"missing_ocr:{page.region.page}:{','.join(sorted(missing))}")
        if page.quality == "ABSTAIN":
            reasons.append(f"abstain:{page.region.page}")
        failures = [f for f in page.execution_failures if f.split(":", 1)[0] in policy.required_ocr_engines]
        reasons.extend(f"incomplete_ocr:{page.region.page}:{f}" for f in failures)
        if not missing and not failures and page.quality != "ABSTAIN":
            completed += 1
    if policy.require_judge:
        if result is None:
            reasons.append("missing_extraction_result")
        else:
            for e in result.extractions:
                m = e.meta or {}
                if "ENT-16" in m.get("ops", []) and not m.get("excluded"):
                    if m.get("vlm", {}).get("outcome") not in {"confirmed", "conflict", "unreadable", "excluded"}:
                        reasons.append(f"missing_judge:{e.code}:{e.page}")
    return Completeness(coverage_scope=policy.coverage, planned_regions=len(planned), completed_regions=completed,
                        mandatory_stages_complete=not reasons, publishable=not reasons,
                        reasons=list(dict.fromkeys(reasons)))
