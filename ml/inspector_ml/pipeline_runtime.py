"""Snapshot of effective execution inputs. Never serialize secrets into traces."""

import hashlib
import os
from functools import lru_cache
from pathlib import Path

from . import parse, vlm
from .ocr_gpu import engine_names, ocr_tag, pinned_weights
from .pipeline_contract import Policy, digest


@lru_cache(maxsize=1)
def code_digest() -> str:
    root = Path(__file__).parent
    return digest({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob("*.py"))})


def runtime_snapshot(sha256, revision, reader_cache):
    profile = os.environ.get("INSPECTOR_PROFILE", "dev")
    engines = list(engine_names(profile))
    # Only explicit algorithm settings, never whole os.environ (credentials).
    names = ("INSPECTOR_PPOCR_DET_FLOOR", "INSPECTOR_PPOCR_DET", "INSPECTOR_PPOCR_REC", "INSPECTOR_PPOCR_DET_LIMIT",
             "INSPECTOR_PPOCR_GPU_MB", "INSPECTOR_PPOCR_REC_BATCH", "INSPECTOR_VL_BAND_LINES",
             "INSPECTOR_VL_INFLIGHT", "INSPECTOR_SKIP_EXTRACTOR_KINDS", "INSPECTOR_JUDGE_PHASE")
    settings = {name: os.environ.get(name) for name in names}
    configuration = {
        "code_digest": code_digest(), "code_revision": os.environ.get("INSPECTOR_REVISION") or None,
        "ml_revision": revision, "profile": profile, "ocr_engines": engines, "ocr_tag": ocr_tag(),
        "render": {"dpi": parse.OCR_DPI, "max_page_mpx": parse.MAX_PAGE_MPX, "max_pages": parse.MAX_PAGES},
        "regional_localization": "raster-ink-v1",
        "settings": settings, "anchor_weights_sha256": pinned_weights() if any(e.startswith("ppocr") for e in engines) else {},
        "vlm": {"backend": vlm.backend(), "reader": vlm.READER, "reader2": vlm.READER2, "judge": vlm.JUDGE,
                "judge_contract": vlm.judge_identity() if vlm.judge_enabled() else None,
                # Existing remote service exposes model names, not loaded-weight digests.
                # Record that limitation rather than invent verified provenance.
                "remote_weights_digest": None,
                "endpoint_fingerprint": digest(os.environ.get("INSPECTOR_VLM_URL", ""))},
        "reader_artifacts_signature": reader_cache.signature(sha256) if reader_cache else None,
    }
    return configuration, Policy(required_ocr_engines=engines, require_judge=vlm.judge_enabled())
