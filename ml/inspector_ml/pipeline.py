"""Plan 07 stage 1: small REST operations wrapping the existing parser/extractor.

Artifacts here are cache entries, NOT durable jobs. A lost entry is an explicit
conflict; PostgreSQL persistence/recovery is the next increment of the plan.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Literal

from pydantic import Field

from .cache import Cache
from .model import AnalyzeRequest, AnalyzeResponse, ParsedDoc
from .parse import detect_kind, parse_file, parse_pdf_part
from .pipeline_contract import (
    Completeness, Context, Contract, Digest, Identifier, PageTrace, Policy,
    Region, StageReceipt, completeness, digest, identity, transcription,
)
from .pipeline_geometry import pdf_regions
from .pipeline_regions import regional_plan
from .pipeline_region_ocr import parse_region
from .pipeline_region_merge import merge_documents


class PipelineConflict(ValueError):
    pass


class PreflightRequest(Contract):
    run_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    request: AnalyzeRequest
    policy: Literal["legacy-compatible-v1", "regional-v1"] = "legacy-compatible-v1"


class StepRequest(Contract):
    context: Context
    plan: Digest
    inputs: list[Digest] = Field(default_factory=list, max_length=100_000)
    region_id: Identifier | None = None


class Trace(Contract):
    context: Context
    receipts: list[StageReceipt]
    pages: list[PageTrace]
    completeness: Completeness
    word_bindings: list[dict] = Field(default_factory=list)
    reader_observations: list[dict] = Field(default_factory=list)


class StageReply(Contract):
    context: Context
    artifact: Digest
    receipt: StageReceipt
    regions: list[Region] = Field(default_factory=list)
    result: AnalyzeResponse | None = None
    trace: Trace | None = None


class Artifact(Contract):
    context: Context
    stage: Literal["preflight", "parse", "merge", "extract", "aggregate"]
    region_id: Identifier | None = None
    inputs: list[Digest]
    payload: dict
    receipts: list[StageReceipt] = Field(default_factory=list)


class ArchiveRequest(Contract):
    context: Context
    reference: Digest
    stage: Literal["preflight", "parse", "merge", "extract", "aggregate"]


class StageArchive(ArchiveRequest):
    artifact: Artifact


class Pipeline:
    def __init__(self, cache: Cache, source: Callable[[str], Path],
                 runtime: Callable[[str], tuple[dict, Policy]],
                 extract: Callable[[AnalyzeRequest, Path, ParsedDoc], AnalyzeResponse]):
        self.cache, self.source, self.runtime, self.extract = cache, source, runtime, extract

    @staticmethod
    def _key(ctx: Context, ref: str) -> str:
        return f"pipeline-v1-{ctx.run_id}-{ctx.configuration_fingerprint}-{ref}"

    def _put(self, artifact: Artifact) -> tuple[str, StageReceipt]:
        body = artifact.model_dump(mode="json")
        ref = digest(body)
        self.cache.set(self._key(artifact.context, ref), artifact.model_dump_json())
        receipt = StageReceipt(stage=artifact.stage, region_id=artifact.region_id,
                               input_digests=artifact.inputs, output_digest=ref, status="complete")
        return ref, receipt

    def _get(self, ctx: Context, ref: str, stage: str) -> Artifact:
        raw = self.cache.get(self._key(ctx, ref))
        if raw is None:
            raise PipelineConflict("артефакт стадии отсутствует; восстановление требует нового запуска")
        try:
            artifact = Artifact.model_validate_json(raw)
        except ValueError as exc:
            raise PipelineConflict("повреждена схема артефакта") from exc
        if artifact.context != ctx or artifact.stage != stage or digest(artifact.model_dump(mode="json")) != ref:
            raise PipelineConflict("происхождение или checksum артефакта не совпадает")
        return artifact

    def _runtime(self, sha256: str, policy_name: str):
        configuration, policy = self.runtime(sha256)
        if policy_name == "regional-v1":
            configuration = {**configuration, "regional": {"dpi": 300, "tile_pixels": 3072, "tile_height_pixels": 768, "overlap_pixels": 128, "max_regions": 1024}}
            configuration['regional_document_limit'] = 10_000
            policy = policy.model_copy(update={"name": policy_name, "coverage": "regional-full-coverage"})
        elif policy.name != policy_name:
            raise PipelineConflict("unsupported runtime policy")
        return configuration, policy

    def _check(self, ctx: Context):
        configuration, policy = self._runtime(ctx.sha256, ctx.policy.name)
        if configuration != ctx.configuration or policy != ctx.policy:
            raise PipelineConflict("настройки запуска изменились; нужен новый run, продолжение прежнего запрещено")
        return self.source(ctx.sha256)

    def archive(self, req: ArchiveRequest) -> StageArchive:
        """Export an immutable checkpoint for the API's existing protected BlobStore."""
        self._check(req.context)
        artifact = self._get(req.context, req.reference, req.stage)
        self._validate_archive(artifact)
        return StageArchive(**req.model_dump(), artifact=artifact)

    @staticmethod
    def _validate_archive(artifact: Artifact):
        try:
            payload = artifact.payload
            if artifact.stage == "preflight":
                request = AnalyzeRequest.model_validate(payload["request"])
                regions = [Region.model_validate(r) for r in payload["regions"]]
                if (request.sha256 != artifact.context.sha256 or not regions
                        or len({r.id for r in regions}) != len(regions)
                        or any(r.page_id != identity("page", request.sha256, r.page) for r in regions)):
                    raise ValueError("foreign or incomplete plan")
            else:
                pages = [PageTrace.model_validate(p) for p in payload["pages"]]
                if not pages or len({p.region.id for p in pages}) != len(pages):
                    raise ValueError("missing or duplicated pages")
                if artifact.stage in {"parse", "merge"}:
                    doc = ParsedDoc.model_validate(payload["doc"])
                    if artifact.stage == "merge" and "regional_parts" in payload:
                        rebuilt, rebuilt_pages, bindings = merge_documents(artifact.context.sha256, payload["regional_parts"])
                        if rebuilt != doc or rebuilt_pages != pages or bindings != payload.get("word_bindings"):
                            raise ValueError("regional merge differs from source evidence")
                    elif doc.sha256 != artifact.context.sha256 or transcription(doc, [p.region for p in pages]) != pages:
                        raise ValueError("transcription differs from document")
                    if artifact.stage == "parse" and (len(pages) != 1 or pages[0].region.id != artifact.region_id or len(artifact.inputs) != 1):
                        raise ValueError("parse region differs from page")
                else:
                    result = AnalyzeResponse.model_validate(payload["result"])
                    if result.sha256 != artifact.context.sha256 or [p["page"] for p in result.pages] != list(dict.fromkeys(p.region.page for p in pages)):
                        raise ValueError("result differs from source/page coverage")
        except (KeyError, TypeError, ValueError) as exc:
            raise PipelineConflict("повреждено содержимое архива стадии") from exc

    def restore(self, req: StageArchive) -> ArchiveRequest:
        """Hydrate Redis only after validating bytes/provenance; never run OCR here."""
        artifact = req.artifact
        if artifact.context != req.context or artifact.stage != req.stage or digest(artifact.model_dump(mode="json")) != req.reference:
            raise PipelineConflict("архив другого запуска/стадии или checksum не совпадает")
        self._check(req.context)
        self._validate_archive(artifact)
        binding = f"pipeline-v1-run-{req.context.run_id}"
        previous = self.cache.get(binding)
        if previous:
            try:
                if Context.model_validate_json(previous) != req.context:
                    raise ValueError("different context")
            except ValueError as exc:
                raise PipelineConflict("архив не соответствует зафиксированному запуску") from exc
        self.cache.set(binding, req.context.model_dump_json())
        self.cache.set(self._key(req.context, req.reference), artifact.model_dump_json())
        if artifact.stage == "parse":
            logical = self._key(req.context, digest([artifact.inputs[0], artifact.region_id, "parse"]))
            self.cache.set(logical, req.reference)
        return ArchiveRequest(context=req.context, reference=req.reference, stage=req.stage)

    def preflight(self, req: PreflightRequest) -> StageReply:
        path = self.source(req.request.sha256)
        configuration, policy = self._runtime(req.request.sha256, req.policy)
        ctx = Context(run_id=req.run_id, sha256=req.request.sha256, configuration=configuration,
                      policy=policy, configuration_fingerprint=digest({"configuration": configuration, "policy": policy.model_dump()}),
                      request_fingerprint=digest(req.request.model_dump(mode="json")))
        # A run cannot silently acquire different params/policy after a retry.
        binding = f"pipeline-v1-run-{ctx.run_id}"
        previous = self.cache.get(binding)
        if previous is not None:
            try:
                if Context.model_validate_json(previous) != ctx:
                    raise PipelineConflict("run уже связан с другим входом или конфигурацией")
            except ValueError as exc:
                raise PipelineConflict("run уже связан с другим входом или конфигурацией") from exc
        kind = detect_kind(path)
        profiles = []
        if kind == "pdf":
            regions = pdf_regions(path, ctx.sha256, profiles=profiles)
            if policy.name == "regional-v1":
                detailed = []
                for page in regions:
                    tiles = regional_plan(page, **configuration["regional"])
                    if len(detailed) + len(tiles) > configuration['regional_document_limit']:
                        raise PipelineConflict('document exceeds regional plan limit')
                    detailed.extend(tiles)
                regions = detailed
        elif kind in {"docx", "xml"}:
            pid = identity("page", ctx.sha256, 1)
            regions = [Region(id=identity("region", pid, [0, 0, 1, 1]), page_id=pid, page=1)]
        else:
            raise PipelineConflict("pipeline.v1 поддерживает PDF/DOCX/XML; формат требует штатного маршрута")
        if not regions:
            raise PipelineConflict("документ без страниц")
        self.cache.set(binding, ctx.model_dump_json())
        ref, receipt = self._put(Artifact(context=ctx, stage="preflight", inputs=[ctx.sha256, ctx.request_fingerprint],
                                         payload={"kind": kind, "request": req.request.model_dump(mode="json"),
                                                  "page_profiles": profiles,
                                                  "regions": [r.model_dump(mode="json") for r in regions]}))
        return StageReply(context=ctx, artifact=ref, receipt=receipt, regions=regions)

    def execute(self, stage: Literal["parse", "merge", "extract", "aggregate"], req: StepRequest) -> StageReply:
        path = self._check(req.context)
        plan = self._get(req.context, req.plan, "preflight")
        regions = [Region.model_validate(r) for r in plan.payload["regions"]]
        plan_receipt = StageReceipt(stage="preflight", input_digests=plan.inputs,
                                    output_digest=req.plan, status="complete")
        if stage == "parse":
            if req.inputs:
                raise PipelineConflict("parse принимает только план и region_id")
            region = next((r for r in regions if r.id == req.region_id), None)
            if region is None:
                raise PipelineConflict("область отсутствует в плане")
            # Dedicated cache namespace: no legacy whole/part cache can hide missing
            # Reader metadata or a changed render/model configuration.
            logical = self._key(req.context, digest([req.plan, region.id, "parse"]))
            previous = self.cache.get(logical)
            if previous:
                artifact = self._get(req.context, previous, "parse")
                if artifact.inputs != [req.plan] or artifact.region_id != region.id:
                    raise PipelineConflict("несовместимый checkpoint области")
                receipt = StageReceipt(stage="parse", region_id=region.id, input_digests=[req.plan],
                                       output_digest=previous, status="complete", cached=True)
                return StageReply(context=req.context, artifact=previous, receipt=receipt)
            extra = {}
            if req.context.policy.name == "regional-v1" and plan.payload["kind"] == "pdf":
                diagnostics = []
                localization = []
                doc, native, transform = parse_region(path, req.context.sha256, region, req.context.configuration["regional"]["dpi"], diagnostics=diagnostics, localization=localization)
                extra = {"reader_observations": diagnostics, "bbox_observations": localization,
                         "native": [line.model_dump(mode="json") for line in native], "render_transform": transform}
            else:
                doc = (parse_pdf_part(path, req.context.sha256, region.page - 1, region.page)
                       if plan.payload["kind"] == "pdf" else parse_file(path, req.context.sha256))
            pages = transcription(doc, [region])
            artifact = Artifact(context=req.context, stage=stage, region_id=region.id, inputs=[req.plan],
                                payload={**extra, "doc": doc.model_dump(mode="json"), "pages": [p.model_dump(mode="json") for p in pages]},
                                receipts=[plan_receipt])
            ref, receipt = self._put(artifact)
            self.cache.set(logical, ref)
            return StageReply(context=req.context, artifact=ref, receipt=receipt)
        if req.region_id is not None:
            raise PipelineConflict("region_id допустим только для parse")
        if stage == "merge":
            parts = [self._get(req.context, ref, "parse") for ref in req.inputs]
            if (len(parts) != len(regions) or len({p.region_id for p in parts}) != len(parts)
                    or {p.region_id for p in parts} != {r.id for r in regions}
                    or any(p.inputs != [req.plan] for p in parts)):
                raise PipelineConflict("части не покрывают план ровно один раз")
            by_region = {p.region_id: (ref, p) for ref, p in zip(req.inputs, parts)}
            ordered = [by_region[r.id] for r in regions]
            docs = [ParsedDoc.model_validate(p.payload["doc"]) for _, p in ordered]
            if any(d.sha256 != req.context.sha256 or d.kind != plan.payload["kind"] for d in docs):
                raise PipelineConflict("часть другого документа")
            doc = ParsedDoc(sha256=req.context.sha256, kind=plan.payload["kind"],
                            pages=[pg for d in docs for pg in d.pages],
                            engine="+".join(sorted({e for d in docs for e in d.engine.split("+") if e})))
            extra = {}
            if req.context.policy.name == "regional-v1" and plan.payload["kind"] == "pdf":
                regional_parts = [p.payload for _, p in ordered]
                doc, pages, bindings = merge_documents(req.context.sha256, regional_parts)
                extra = {"regional_parts": regional_parts, "word_bindings": bindings,
                         "reader_observations": [entry for part in regional_parts for entry in part.get('reader_observations', [])]}
            else:
                pages = transcription(doc, regions)
            receipts = [plan_receipt, *[StageReceipt(stage="parse", region_id=p.region_id,
                         input_digests=p.inputs, output_digest=ref, status="complete") for ref, p in ordered]]
            artifact = Artifact(context=req.context, stage=stage, inputs=[ref for ref, _ in ordered], receipts=receipts,
                                payload={**extra, "plan": req.plan, "doc": doc.model_dump(mode="json"), "pages": [p.model_dump(mode="json") for p in pages]})
        else:
            if len(req.inputs) != 1:
                raise PipelineConflict("стадия требует один входной артефакт")
            previous_stage = "merge" if stage == "extract" else "extract"
            previous = self._get(req.context, req.inputs[0], previous_stage)
            if previous.payload["plan"] != req.plan:
                raise PipelineConflict("артефакт другого плана")
            receipts = [*previous.receipts, StageReceipt(stage=previous.stage,
                        input_digests=previous.inputs, output_digest=req.inputs[0], status="complete")]
            payload = dict(previous.payload)
            if stage == "extract":
                doc = ParsedDoc.model_validate(payload.pop("doc"))
                payload.pop("regional_parts", None)
                result = self.extract(AnalyzeRequest.model_validate(plan.payload["request"]), path, doc)
                if result.sha256 != req.context.sha256:
                    raise PipelineConflict("извлечение другого документа")
                # Existing metadata is preserved, including judge/subject decisions.
                pages = [PageTrace.model_validate(p) for p in payload["pages"]]
                for e in [*result.extractions, *result.facts]:
                    page = next((p for p in pages if p.region.page == e.page), None)
                    if page is None:
                        raise PipelineConflict("извлечение ссылается на страницу вне плана")
                    physical_pages = [p for p in pages if p.region.page == e.page]
                    matching_pages = [p for p in physical_pages if any(line.text == e.line_text for line in p.lines)]
                    if not matching_pages and e.bbox is not None:
                        x0,y0,x1,y1 = e.bbox
                        matching_pages = [p for p in physical_pages if
                            min(x1,p.region.bbox[2]) > max(x0,p.region.bbox[0]) and
                            min(y1,p.region.bbox[3]) > max(y0,p.region.bbox[1])]
                    lines = [line for p in matching_pages for line in p.lines if line.text == e.line_text]
                    regional = req.context.policy.name == 'regional-v1'
                    selected = matching_pages[0] if len(matching_pages) == 1 else None
                    e.meta = {**(e.meta or {}), "pipeline": {
                        "run_id": req.context.run_id, "page_id": page.region.page_id,
                        "region_id": selected.region.id if selected else None if regional else page.region.id,
                        "transcription_digest": selected.transcription_digest if selected else None if regional else page.transcription_digest,
                        "line_ids": [line.id for line in lines], "bbox": e.bbox,
                        "line_binding": "exact_text" if lines else "source_page_bbox" if e.bbox else "source_page",
                        # One immutable merge reference resolves region transcripts;
                        # repeating all page regions per extraction is quadratic.
                        "merge_artifact": req.inputs[0],
                        "region_ids": [p.region.id for p in matching_pages],
                    }}
                payload["result"] = result.model_dump(mode="json")
            artifact = Artifact(context=req.context, stage=stage, inputs=req.inputs, receipts=receipts, payload=payload)
        ref, receipt = self._put(artifact)
        reply = StageReply(context=req.context, artifact=ref, receipt=receipt)
        if stage == "aggregate":
            result = AnalyzeResponse.model_validate(artifact.payload["result"])
            pages = [PageTrace.model_validate(p) for p in artifact.payload["pages"]]
            receipts = [*artifact.receipts, receipt]
            status = completeness(regions, receipts, pages, req.context.policy, result)
            reply.trace = Trace(context=req.context, receipts=receipts, pages=pages, completeness=status,
                                word_bindings=artifact.payload.get("word_bindings", []),
                                reader_observations=artifact.payload.get("reader_observations", []))
            # Incomplete diagnostic trace is returned, but no usable analysis result.
            reply.result = result if status.publishable else None
            if not status.publishable:
                reply.receipt = receipt.model_copy(update={"status": "incomplete", "reasons": status.reasons})
                reply.trace.receipts[-1] = reply.receipt
        return reply
