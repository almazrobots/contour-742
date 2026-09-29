"""HTTP-сервис ML-модуля. Вызывается API-воркером (Node.js) по очереди заданий.

uv run uvicorn inspector_ml.app:app --port 8811
"""

from __future__ import annotations

import functools
import hashlib
import json
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, StrictInt

from .resource_scope import render_guarded

from .extractor_kinds import skipped_kinds
from . import vlm
from .vlm_verify import mention_box, verify_mentions
from . import vlm_claim as vlm_claim_mod
from . import __version__, advisor, normsearch
from .change_marks import change_marks
from .extract import EXTRACT_REV, extract, rooms
from .cache import make_cache
from .doctype import classify
from .reread import extract_refined
from .semantic import get_embedder
from .hidden_works import doc_title, hidden_works
from .model import (
    AdviseRequest,
    AnalyzeRequest,
    AnalyzeResponse,
    DiffRegion,
    DiffRequest,
    DiffResponse,
    MeasureRequest,
    NormSearchRequest,
    PageRequisites,
    ParsedDoc,
)
from .filehash import sha256_file
from .parse import CorruptedFile, UnsupportedFormat, detect_kind, parse_file, pdf_pages
from .paths import repo_root
from . import readers
from .docstore import (
    PARSER_REV,
    PartMissing,
    InvalidCheckpoint,
    cached_parsed,
    assemble_parts,
    load_parsed,
    parse_part,
)
from .ocr_gpu import check_ready, ocr_tag
from .pipeline import ArchiveRequest, Pipeline, PipelineConflict, PreflightRequest, StageArchive, StageReply, StepRequest
from .pipeline_runtime import runtime_snapshot
from .pipeline_execution import ExecutionConflict, ExecutionJournal, ExecutionJournalError, request_digest
from typing import Literal

PROFILE = os.environ.get("INSPECTOR_PROFILE", "dev")
if PROFILE not in ("dev", "gpu"):
    raise SystemExit(f"INSPECTOR_PROFILE={PROFILE!r}: ждём dev или gpu (ADR-0001)")
# Кэш разбора (OS-INSP-2.1.3, ТЗ 9.1.5): файлы в dev, Redis в gpu — cache.make_cache
CACHE = make_cache(PROFILE, repo_root() / "var/ml-cache")
# Провайдер LLM (OS-INSP-3.2.4, T-086): в gpu — только явно, неизвестное значение — падение при старте
LLM = advisor.llm_mode(PROFILE)
# Движки OCR сканов (OS-INSP-2.1.17, 2.1.18, T-184): в gpu — только GPU-движки; недоступный движок — падение при старте
OCR_ENGINES = check_ready(PROFILE)
# Хранилище блобов API: var/blobs/<sha256>. ML читает файлы только отсюда.
BLOBS = Path(os.environ.get("INSPECTOR_BLOB_DIR", repo_root() / "var/blobs")).resolve()

# Прочтения читателей сканов (OS-INSP-2.1.13, T-130): каталог кэша этапов reader/reader2. Не задан — читателей нет,
# упоминания ансамбля OCR остаются как есть. Сервис сам модели читателей не загружает — только берёт прочтения.
READER_CACHE = (
    readers.ReaderCache(Path(os.environ["INSPECTOR_READER_CACHE"]))
    if os.environ.get("INSPECTOR_READER_CACHE")
    else None
)
READER_MODELS = readers.Models(
    ensemble=f"ансамбль OCR ({', '.join(OCR_ENGINES)})",
    reader=vlm.READER,
    reader2=vlm.READER2,
)

app = FastAPI(title="Инспектор ИИ — ML", version=__version__)


PARAM_SLOW_MS = 500  # ТЗ §11, TZA-11-07: ML-анализ одного параметра — не более 500 мс


def ml_revision() -> str:
    """Версия интеллектуальной части, от которой зависит результат: разбор, извлечение, судья VLM (OS-INSP-2.1.12)."""
    judge = (
        f"-vlm:{vlm.judge_fingerprint()}"
        if vlm.judge_enabled()
        else ""
    )
    rd = (
        f"-rd:{hashlib.sha256((vlm.READER + vlm.READER2).encode()).hexdigest()[:8]}"
        if READER_CACHE
        else ""
    )
    skip = "".join(
        f"-no:{k}" for k in sorted(skipped_kinds())
    )  # T-233: вид выключен в этом проходе — другой результат
    return f"r{PARSER_REV}{ocr_tag()}-x{EXTRACT_REV}{judge}{rd}{skip}"


@app.get("/health")
def health() -> dict:
    # ревизия образа (git sha, передаётся при сборке) — гейт запускает образ и сверяет её (стандарт Q3)
    return {
        "status": "ok",
        "profile": PROFILE,
        "llm": LLM,
        "version": __version__,
        "revision": os.environ.get("INSPECTOR_REVISION", "").strip() or None,
        "ml_revision": ml_revision(),
    }


def _cache_key(req: AnalyzeRequest) -> str:
    spec = json.dumps(
        [p.model_dump() for p in req.params + req.facts],
        sort_keys=True,
        ensure_ascii=False,
    )
    sem = (
        "-sem" if get_embedder() is not None else ""
    )  # установка модели меняет результат — кэш другой
    judge = (
        f"-vlm:{vlm.judge_fingerprint()}"
        if vlm.judge_enabled()
        else ""
    )  # судья VER-09 — тоже
    # новое прочтение читателя сканов — новый результат, а не старый из кэша (T-130)
    rd = f"-rd:{READER_CACHE.signature(req.sha256) or 'none'}" if READER_CACHE else ""
    skip = "".join(f"-no:{k}" for k in sorted(skipped_kinds()))
    return f"{req.sha256}-r{PARSER_REV}{ocr_tag()}-x{EXTRACT_REV}{sem}{judge}{rd}{skip}-{hashlib.sha256(spec.encode()).hexdigest()[:16]}"


def _blob(sha: str) -> Path:
    """Файл хранилища по его SHA-256. Путь снаружи не принимается (защита от path traversal):
    имя — только хеш, итоговый путь обязан лежать прямо в BLOBS, содержимое — совпасть с хешем."""
    path = (BLOBS / sha).resolve()
    if path.parent != BLOBS or not path.is_file():
        raise HTTPException(404, "файл не найден в хранилище")
    if (
        sha256_file(path) != sha
    ):  # потоком: том ИД не читается в память ради сверки (T-169)
        raise HTTPException(409, "SHA-256 файла не совпадает с заявленным")
    return path


def _vlm_checked(path: Path, extractions: list) -> list:
    """VER-09 (T-129): упоминания классов — через локального судью по кропу листа, если VLM включена
    (INSPECTOR_VLM_BACKEND). Судья только понижает; выключен или фаза разбора (INSPECTOR_JUDGE_PHASE=off) — список как есть."""
    if not vlm.judge_enabled():
        return extractions
    targets = [
        e
        for e in extractions
        if (e.meta or {}).get("ops") and "ENT-16" in e.meta["ops"]
    ]
    if not targets:
        return extractions

    # один растр на страницу, а не на каждое упоминание (SEC-03); держим две последние — память ограничена
    page_img = functools.lru_cache(maxsize=2)(lambda n: vlm.render_page(path, n))

    def crop_of(e):
        box = mention_box(e)
        img = page_img(e.page) if box else None
        return vlm.crop_box(img, box) if img is not None else None

    ids = {id(e) for e in targets}
    checked = iter(verify_mentions(
        targets, crop_of, vlm.judge_mention,
        judge_for=lambda e, crop: vlm.judge_fire_degree(crop) if e.code == "M-022" else vlm.judge_mention(crop),
    ))
    return [next(checked) if id(e) in ids else e for e in extractions]


def analyze_document(req: AnalyzeRequest, path: Path, doc: ParsedDoc) -> AnalyzeResponse:
    """Existing extraction shared by legacy /analyze and pipeline.v1, without a second parse."""
    timings: dict[str, float] = {}  # OS-INSP-2.2.34: время анализа каждого параметра
    found = extract_refined(
        path, doc, req.params, get_embedder(), timings=timings
    )  # 2.2.8 семантика; 2.2.12 перечитывание сомнительных значений OCR
    param_ms = {p.code: round(timings.get(p.code, 0.0)) for p in req.params}
    found = readers.merge_doc(
        req.sha256, doc, found, req.params, READER_CACHE, READER_MODELS
    )  # 2.2.18–2.2.20 читатели сканов
    res = AnalyzeResponse(
        sha256=req.sha256,
        kind=doc.kind,
        engine=doc.engine,
        pages=[
            # OS-INSP-2.1.16: число слов — знаменатель доли сомнительных слов OCR (disputed_words) в отчёте API
            p.model_dump(exclude={"lines", "requisites"})
            | {"lines": len(p.lines), "words": sum(len(ln.words) for ln in p.lines)}
            for p in doc.pages
        ],
        extractions=_vlm_checked(
            path, found
        ),  # VER-09 судья — после читателей: судит и найденное читателем
        facts=extract(doc, req.facts),
        rooms=rooms(doc),
        requisites=[PageRequisites(page=p.page, items=p.requisites) for p in doc.pages],
        hidden_works=hidden_works(doc),  # OS-INSP-1.4.4
        title=doc_title(doc),
        doc_type=classify(doc).model_dump(),
        ml_revision=ml_revision(),
        param_ms=param_ms,
        change_marks=change_marks(
            path, doc
        ),  # T-177: CMP-29 — облака, «Изм. N», таблица изменений штампа
    )
    return res


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    """Разбор + извлечение. Кэш по SHA-256 файла и составу параметров (OS-INSP-2.1.3)."""
    key = _cache_key(req)
    hit = CACHE.get(key)
    if hit is not None:
        data = json.loads(hit)
        data["cached"] = True
        data["ml_revision"] = (
            ml_revision()
        )  # ключ кэша уже содержит версию — старые записи без поля
        return AnalyzeResponse(**data)
    path = _blob(req.sha256)
    t0 = time.monotonic()
    try:
        # разобранный заранее этапом parse документ берётся из кэша (T-130); нет — разбор здесь же
        doc, _ = load_parsed(CACHE, path, req.sha256)
    except UnsupportedFormat as e:
        raise HTTPException(415, str(e)) from e
    except CorruptedFile as e:
        raise HTTPException(422, str(e)) from e
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    res = analyze_document(req, path, doc)
    param_ms = res.param_ms
    # A transient unavailable/incomplete Judge must be retried on the next
    # analysis, rather than becoming a permanent cached successful result.
    judge_complete = all(
        "ENT-16" not in (e.meta or {}).get("ops", [])
        or (e.meta or {}).get("excluded")
        or (e.meta or {}).get("vlm", {}).get("outcome") in {"confirmed", "conflict", "unreadable", "excluded"}
        for e in [*res.extractions, *res.facts]
    )
    if not vlm.judge_enabled() or judge_complete:
        CACHE.set(key, res.model_dump_json())
    for code, ms in param_ms.items():
        if (
            ms > PARAM_SLOW_MS
        ):  # OS-INSP-2.2.34: превышение предела §11 — в журнал с кодом и временем
            print(
                json.dumps(
                    {
                        "level": "WARNING",
                        "service": "ml",
                        "message": "param_slow",
                        "sha256": req.sha256[:12],
                        "param": code,
                        "ms": ms,
                        "limit_ms": PARAM_SLOW_MS,
                    },
                    ensure_ascii=False,
                )
            )
    res_ms = int((time.monotonic() - t0) * 1000)
    print(
        json.dumps(
            {
                "level": "INFO",
                "service": "ml",
                "message": "analyze",
                "sha256": req.sha256[:12],
                "ms": res_ms,
            },
            ensure_ascii=False,
        )
    )
    return res


SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _pipeline() -> Pipeline:
    return Pipeline(CACHE, _blob, lambda sha: runtime_snapshot(sha, ml_revision(), READER_CACHE), analyze_document)


def _pipeline_call(call):
    try:
        return call()
    except UnsupportedFormat as exc:
        raise HTTPException(415, str(exc)) from exc
    except CorruptedFile as exc:
        raise HTTPException(422, str(exc)) from exc
    except (PipelineConflict, InvalidCheckpoint) as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/pipeline/v1/preflight", response_model=StageReply)
def pipeline_preflight(req: PreflightRequest):
    return _pipeline_call(lambda: _pipeline().preflight(req))


@app.post("/pipeline/v1/artifacts/export", response_model=StageArchive)
def pipeline_archive(req: ArchiveRequest):
    return _pipeline_call(lambda: _pipeline().archive(req))


@app.post("/pipeline/v1/artifacts/restore", response_model=ArchiveRequest)
def pipeline_restore(req: StageArchive):
    return _pipeline_call(lambda: _pipeline().restore(req))


class ExecutionRequest(BaseModel):
    job_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    epoch: StrictInt = Field(ge=1, le=10)
    stage: Literal["preflight", "parse", "merge", "extract", "aggregate"]
    body: dict


def _execution_journal() -> ExecutionJournal:
    directory = os.environ.get("INSPECTOR_PIPELINE_EXECUTIONS_DIR", "").strip()
    if not directory:
        raise HTTPException(503, "durable execution journal is not configured")
    try:
        return ExecutionJournal(Path(directory), CACHE,
            journal_identity=os.environ.get("INSPECTOR_PIPELINE_JOURNAL_IDENTITY") or None)
    except ValueError as exc:
        raise HTTPException(503, "execution journal configuration invalid") from exc


def _execution_request(req: ExecutionRequest):
    # Normalize defaults identically for start, probe and cancellation.
    from pydantic import ValidationError
    try:
        body = (PreflightRequest if req.stage == "preflight" else StepRequest).model_validate(req.body)
    except ValidationError as exc:
        raise HTTPException(422, "invalid pipeline execution request") from exc
    envelope = {"stage": req.stage, "body": body.model_dump(mode="json")}
    identity = os.environ.get("INSPECTOR_EXECUTION_PROXY_IDENTITY")
    if identity:
        envelope["external_execution"] = {"journal_identity": identity,
            "namespace": os.environ.get("INSPECTOR_EXECUTION_PROXY_NAMESPACE")}
    return body, envelope


def _execution_call(call):
    try:
        return call().to_dict()
    except ExecutionConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ExecutionJournalError, OSError) as exc:
        raise HTTPException(503, "execution journal unavailable or corrupt") from exc
    except ValueError as exc:
        raise HTTPException(422, "invalid execution identity or journal configuration") from exc


@app.post("/pipeline/v1/executions/start")
def pipeline_execution_start(req: ExecutionRequest):
    body, envelope = _execution_request(req)
    def execute():
        from .execution_scope import execution_scope
        with execution_scope(req.job_id, req.epoch):
            pipeline = _pipeline()
            result = pipeline.preflight(body) if req.stage == "preflight" else pipeline.execute(req.stage, body)
            return result.model_dump(mode="json")
    return _execution_call(lambda: _execution_journal().execute(req.job_id, req.epoch, envelope, execute))


@app.post("/pipeline/v1/executions/probe")
def pipeline_execution_probe(req: ExecutionRequest):
    _, envelope = _execution_request(req)
    return _execution_call(lambda: _execution_journal().probe(req.job_id, req.epoch, request_digest(envelope)))


@app.post("/pipeline/v1/executions/quiescence")
def pipeline_execution_quiescence(req: ExecutionRequest):
    _, envelope = _execution_request(req)
    snapshot = _execution_call(lambda: _execution_journal().probe(req.job_id, req.epoch, request_digest(envelope)))
    if snapshot["status"] not in {"INTERRUPTED", "FAILED"} or snapshot["reason"] == "result_unavailable":
        return {"job_id": req.job_id, "epoch": req.epoch, "quiescent": False, "journal_identity": None}
    from .execution_scope import seal_external
    try:
        return seal_external(req.job_id, req.epoch)
    except Exception as exc:
        raise HTTPException(503, "external execution quiescence not established") from exc


@app.post("/pipeline/v1/executions/cancel-unstarted")
def pipeline_execution_cancel(req: ExecutionRequest):
    _, envelope = _execution_request(req)
    return _execution_call(lambda: _execution_journal().cancel_unstarted(req.job_id, req.epoch, request_digest(envelope)))


@app.post("/pipeline/v1/{stage}", response_model=StageReply)
def pipeline_step(stage: Literal["parse", "merge", "extract", "aggregate"], req: StepRequest):
    return _pipeline_call(lambda: _pipeline().execute(stage, req))


# ─────────────────────── T-233: том по частям — страницы разбирают разные процессы ML, /analyze берёт собранное


class PartsProbe(BaseModel):
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class PartRequest(PartsProbe):
    first: int = Field(ge=0, strict=True)
    last: int = Field(gt=0, strict=True)


class AssembleRequest(PartsProbe):
    ranges: list[tuple[StrictInt, StrictInt]] = Field(min_length=1, max_length=1000)


@app.post("/parse/pages")
def parse_pages(req: PartsProbe) -> dict:
    """Число страниц PDF и есть ли уже целый разбор в кэше. Не PDF — pages null: такой файл частями не разбирается."""
    path = _blob(req.sha256)
    try:
        parsed = cached_parsed(CACHE, path, req.sha256) is not None
        if parsed or detect_kind(path) != "pdf":
            return {"pages": None, "parsed": parsed}
        return {"pages": pdf_pages(path), "parsed": False}
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    except (UnsupportedFormat, CorruptedFile) as e:
        return {"pages": None, "parsed": False, "error": str(e)}


@app.post("/parse/part")
def parse_part_route(req: PartRequest) -> dict:
    path = _blob(req.sha256)
    t0 = time.monotonic()
    try:
        doc, cached = parse_part(CACHE, path, req.sha256, req.first, req.last)
    except UnsupportedFormat as e:
        raise HTTPException(415, str(e)) from e
    except CorruptedFile as e:
        raise HTTPException(422, str(e)) from e
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    ms = int((time.monotonic() - t0) * 1000)
    print(
        json.dumps(
            {
                "level": "INFO",
                "service": "ml",
                "message": "parse_part",
                "sha256": req.sha256[:12],
                "first": req.first,
                "last": req.last,
                "ms": ms,
                "cached": cached,
            },
            ensure_ascii=False,
        )
    )
    return {"pages": len(doc.pages), "cached": cached, "ms": ms}


@app.post("/parse/assemble")
def parse_assemble(req: AssembleRequest) -> dict:
    path = _blob(req.sha256)
    try:
        doc = assemble_parts(CACHE, path, req.sha256, req.ranges)
    except UnsupportedFormat as e:
        raise HTTPException(415, str(e)) from e
    except CorruptedFile as e:
        raise HTTPException(422, str(e)) from e
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    except PartMissing as e:
        raise HTTPException(409, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"pages": len(doc.pages)}


def _load_doc(sha: str) -> ParsedDoc:
    """Разобранный документ по хешу — только из хранилища блобов (как /analyze); кэш разбора на диске."""
    if not SHA_RE.match(sha):
        raise HTTPException(422, "sha256: ждём 64 hex-символа")
    path = _blob(sha)
    try:
        doc, _ = load_parsed(CACHE, path, sha)
    except UnsupportedFormat as e:
        raise HTTPException(415, str(e)) from e
    except CorruptedFile as e:
        raise HTTPException(422, str(e)) from e
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    return doc


@app.post("/advise")
def advise(req: AdviseRequest) -> dict:
    """LLM-советник (OS-INSP-3.2.4, 3.2.5): гипотеза принимается только с проверенной ссылкой."""
    provider = advisor.get_provider()
    if not provider.available():
        return {
            "provider": provider.name,
            "available": False,
            "accepted": [],
            "rejected": [],
        }
    docs = {sha: _load_doc(sha) for sha in dict.fromkeys(req.sha256)}
    return advisor.advise(provider, docs, req.params)


@app.post("/norms/search")
def norms_search(req: NormSearchRequest) -> dict:
    """Поиск по нормативной базе (OS-INSP-3.2.6): BM25 + реранк эмбеддингами Ollama при доступности."""
    return normsearch.index_for(req.extra).search(
        req.query, req.top_k, rerank=req.rerank
    )


@app.post("/diff", response_model=DiffResponse)
def diff(req: DiffRequest) -> DiffResponse:
    """Дифф листа между редакциями (OS-INSP-3.4): совмещение, карта изменений, области с bbox.
    Кэш — по паре (sha, страница) и версии алгоритма."""
    from .sheetdiff import ALGO_VERSION, diff_pages

    key = f"diff-{req.sha_a}-{req.page_a}-{req.sha_b}-{req.page_b}-{ALGO_VERSION}"
    hit = CACHE.get(key)
    if hit is not None:
        data = json.loads(hit)
        data["cached"] = True
        return DiffResponse(**data)
    pa, pb = _blob(req.sha_a), _blob(req.sha_b)
    for p in (pa, pb):
        try:
            if detect_kind(p) != "pdf":
                raise HTTPException(415, "дифф листов — только для PDF")
        except UnsupportedFormat as e:
            raise HTTPException(415, str(e)) from e
    try:
        r = diff_pages(pa, req.page_a, pb, req.page_b)
    except CorruptedFile as e:
        raise HTTPException(422, str(e)) from e
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    except IndexError as e:
        raise HTTPException(422, str(e)) from e
    res = DiffResponse(
        status=r.status,
        reason=r.reason,
        inliers=r.inliers,
        matches=r.matches,
        method=r.method,
        regions=[
            DiffRegion(bbox_a=g.bbox_a, bbox_b=g.bbox_b, score=g.score, area=g.area)
            for g in r.regions
        ],
        ms=r.ms,
    )
    CACHE.set(key, res.model_dump_json())
    print(
        json.dumps(
            {
                "level": "INFO",
                "service": "ml",
                "message": "diff",
                "status": r.status,
                "regions": len(r.regions),
                "ms": r.ms,
            },
            ensure_ascii=False,
        )
    )
    return res


@app.post("/measure")
def measure(req: MeasureRequest) -> dict:
    """Измерение на чертеже (OS-INSP-2.4): масштаб по размерным линиям любой ориентации, масштаб листа 1:N,
    расстояния между параллельными линиями по перпендикуляру (мм и м) с bbox. Масштаб не определён, противоречив
    или расходится со штампом — status NOT_COMPARABLE и пустой список измерений (2.4.3, 2.4.6).
    OS-INSP-2.4.7 (ТЗ §11): лист анализируется не дольше CV_SHEET_LIMIT_S; не уложился — NOT_COMPARABLE с причиной,
    без частичных измерений. ms — время анализа листа (API кладёт его в гистограмму §11)."""
    from PIL import Image

    from . import measure as M
    from .sheetdiff import render_gray

    t0 = time.monotonic()
    deadline = M.Deadline(M.CV_SHEET_LIMIT_S)
    path = _blob(req.sha256)
    try:
        if detect_kind(path) != "pdf":
            raise HTTPException(415, "измерение — только для PDF")
        # разбор — из кэша этапа parse (как /analyze): лист не заставляет заново распознавать весь документ
        doc, _ = load_parsed(CACHE, path, req.sha256)
        page = next((p for p in doc.pages if p.page == req.page), None)
        if page is None:
            raise HTTPException(
                422, f"в документе {len(doc.pages)} стр., запрошена {req.page}"
            )
        gray = render_gray(
            path,
            req.page,
            dpi=M.cv_dpi(page.width, page.height),
            max_side=M.CV_MAX_SIDE,
        )
        img = render_guarded(lambda: Image.fromarray(gray), gray.shape[1], gray.shape[0], 1)
    except UnsupportedFormat as e:
        raise HTTPException(415, str(e)) from e
    except CorruptedFile as e:
        raise HTTPException(422, str(e)) from e
    except InvalidCheckpoint as e:
        raise HTTPException(409, str(e)) from e
    # 1:N (OS-INSP-2.4.6): фактическое разрешение рендера — по размеру растра и листа в pt
    dpi = M.render_dpi(img.size, (page.width, page.height))
    try:
        sc = M.determine_scale(img, page.lines, dpi=dpi, deadline=deadline)
        ds = M.distances(
            img, sc, exclude=[e["line_bbox"] for e in sc.evidence], deadline=deadline
        )
    except M.CvTimeout as e:
        ms = round((time.monotonic() - t0) * 1000)
        print(
            json.dumps(
                {
                    "level": "WARNING",
                    "service": "ml",
                    "message": "cv_sheet_timeout",
                    "sha256": req.sha256[:12],
                    "page": req.page,
                    "ms": ms,
                    "limit_s": M.CV_SHEET_LIMIT_S,
                },
                ensure_ascii=False,
            )
        )
        return {
            "status": "NOT_COMPARABLE",
            "method": "timeout",
            "reason": str(e),
            "mm_per_px": None,
            "sheet_scale": None,
            "sheet_scale_gost": None,
            "stamp_scale": None,
            "render_dpi": round(dpi, 2),
            "dimension_lines": [],
            "distances": [],
            "ms": ms,
        }
    return {
        "status": sc.status,
        "method": sc.method,
        "reason": None,
        "mm_per_px": sc.mm_per_px,
        "sheet_scale": sc.sheet_scale,
        "sheet_scale_gost": sc.sheet_scale_gost,
        "stamp_scale": sc.stamp_scale,
        "render_dpi": round(dpi, 2),
        "dimension_lines": sc.evidence,
        "distances": [
            {
                "mm": d.mm,
                "m": d.m,
                "axis": d.axis,
                "orientation": d.orientation,
                "angle": d.angle,
                "a_bbox": d.a_bbox,
                "b_bbox": d.b_bbox,
                "a_pt": d.a_pt,
                "b_pt": d.b_pt,
            }
            for d in ds
        ],
        "ms": round((time.monotonic() - t0) * 1000),
    }


@app.post("/vlm/claim")
def vlm_claim(req: vlm_claim_mod.ClaimRequest) -> dict:
    """VER-09 (T-196): закрытый вопрос VLM по двум кропам; VLM выключена — 503, все слоты заняты — 429 (OWASP-0181);
    статус кандидата в обоих случаях не меняется."""
    if not vlm.judge_enabled():
        raise HTTPException(
            503,
            "судья VLM выключен (INSPECTOR_VLM_BACKEND=none или фаза разбора) — VER-09 не выполняется",
        )
    if not vlm_claim_mod.SLOTS.acquire(blocking=False):
        raise HTTPException(429, "VER-09: модель занята — повторите позже")
    try:
        return vlm_claim_mod.claim(
            req,
            _blob,
            vlm.render_page,
            lambda img, prompt: vlm.generate(
                vlm.JUDGE,
                img,
                prompt,
                max_tokens=200,
                timeout=vlm_claim_mod.CLAIM_TIMEOUT_S,
            ),
        )
    finally:
        vlm_claim_mod.SLOTS.release()


@app.post("/render/{fmt}")
def render(fmt: str, protocol: dict) -> Response:
    """Рендер протокола в PDF или DOCX (OS-INSP-5.1)."""
    from .render import render_docx, render_pdf

    # T-121: модель по образцу Приложения № 2 пришла от API — оформление в дизайн-системе; иначе прежний протокол
    if protocol.get("appendix2"):
        from . import render_appendix2 as a2

        render_pdf, render_docx = a2.render_pdf, a2.render_docx  # noqa: F811
    if fmt == "pdf":
        return Response(render_pdf(protocol), media_type="application/pdf")
    if fmt == "docx":
        return Response(
            render_docx(protocol),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    raise HTTPException(404, "формат: pdf или docx")
