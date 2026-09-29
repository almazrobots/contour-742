"""Small reproducible GPU baseline for plan 07; synthetic data only.

Run in an isolated process on the GPU host. This measures parsing and field
reading, not evidence_group acceptance or the public API. Never writes the
service's Redis/cache or reads the real corpus.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import resource
import time

import pypdfium2 as pdfium
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from eval.metrics import char_errors, iou, norm_text
from inspector_ml.docstore import load_parsed, parsed_key
from inspector_ml.model import ParsedDoc
from inspector_ml.parse import PDFIUM_LOCK

MM = 72 / 25.4
FIELDS = [
    ("width", "Ширина двери", "900 мм"),
    ("level", "Отметка", "-2,500 м"),
    ("diameter", "Диаметр", "Ø25 мм"),
    ("area", "Площадь", "124,50 м²"),
]
CASES = [
    ("native-a4", "native", 210, 297, 12, 0, 0, 1),
    ("scan-a4", "scan", 210, 297, 12, 0, 0, 1),
    ("hybrid-a4", "hybrid", 210, 297, 12, 0, 0, 1),
    ("scan-a1-small", "scan", 594, 841, 7.1, 0, 0, 1),
    ("hybrid-a1-small", "hybrid", 594, 841, 7.1, 0, 0, 1),
    ("scan-a0-small", "scan", 841, 1189, 7.1, 0, 0, 1),
    ("scan-a4-rotated", "scan", 210, 297, 12, 90, 0, 1),
    ("scan-a4-faint", "scan", 210, 297, 12, 0, 0.55, 1),
    ("scan-a4-small", "scan", 210, 297, 7.1, 0, 0, 1),
    ("native-multipage", "native", 210, 297, 12, 0, 0, 5),
]


class MemoryCache:
    def __init__(self):
        self.data: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self.data.get(key)

    def set(self, key: str, value: str) -> None:
        self.data[key] = value


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def rotate_box(box, rotation):
    if rotation == 90:
        x0, y0, x1, y1 = box
        return [1 - y1, x0, 1 - y0, x1]
    return list(box)


def fixture(out: Path, spec: tuple) -> dict:
    name, kind, wm, hm, size, rotation, gray, count = spec
    width, height = wm * MM, hm * MM
    path = out / f"{name}.pdf"
    c = canvas.Canvas(str(path), pagesize=(width, height), invariant=1)
    pages = []
    for number in range(1, count + 1):
        gold = []
        texts = []
        # Build the drawing as a vector source, then rasterize at exactly 300 dpi.
        source = io.BytesIO()
        s = canvas.Canvas(source, pagesize=(width, height), invariant=1)
        s.setFont("BaselineNoto", size)
        s.setFillGray(gray)
        x = width * 0.12
        for row, (field, anchor, value) in enumerate(FIELDS):
            y = height * 0.76 - row * size * 2.8
            text = f"{anchor} {value}"
            s.drawString(x, y, text)
            start = x + pdfmetrics.stringWidth(anchor + " ", "BaselineNoto", size)
            end = start + pdfmetrics.stringWidth(value, "BaselineNoto", size)
            ascent, descent = pdfmetrics.getAscentDescent("BaselineNoto", size)
            box = [start / width, 1 - (y + ascent) / height,
                   end / width, 1 - (y + descent) / height]
            gold.append({"field": field, "value": value,
                         "bbox": rotate_box(box, rotation)})
            texts.append(text)
        s.save()
        source.seek(0)
        with PDFIUM_LOCK, pdfium.PdfDocument(source.getvalue()) as d:
            page = d[0]
            try:
                if kind == "native":
                    c.setFont("BaselineNoto", size)
                    for row, text in enumerate(texts):
                        c.drawString(x, height * 0.76 - row * size * 2.8, text)
                else:
                    bitmap = page.render(scale=300 / 72)
                    image = bitmap.to_pil()
                    c.drawImage(ImageReader(image), 0, 0, width=width, height=height)
                    image.close()
                    bitmap.close()
            finally:
                page.close()
        if kind == "hybrid":
            header = "Контрольный лист редакции 2026"
            c.setFont("BaselineNoto", 12)
            c.drawString(width * 0.12, height * 0.9, header)
            texts.insert(0, header)
        if rotation:
            # ReportLab swaps MediaBox axes for 90/270; preserve the original
            # content frame before applying the viewer's rotation.
            c.setPageSize((height, width))
            c.setPageRotation(rotation)
        c.showPage()
        pages.append({"page": number, "text": "\n".join(texts), "fields": gold})
    c.save()
    return {"id": name, "kind": kind, "sha256": digest(path),
            "path": str(path), "raster_dpi": 300 if kind != "native" else None,
            "pages": pages}


def score(doc: ParsedDoc, gold: dict) -> dict:
    results = []
    errors = chars = matched = localized = 0
    for expected in gold["pages"]:
        page = next((p for p in doc.pages if p.page == expected["page"]), None)
        lines = page.lines if page else []
        observed = "\n".join(line.text for line in lines)
        d, n = char_errors(expected["text"], observed)
        errors += d
        chars += n
        for field in expected["fields"]:
            target = norm_text(field["value"])
            candidates = []
            for line in lines:
                # Compare contiguous spans; exact text includes signs and units.
                for start in range(len(line.words)):
                    for end in range(start + 1, min(len(line.words), start + 5) + 1):
                        words = line.words[start:end]
                        if norm_text(" ".join(w.text for w in words)) != target:
                            continue
                        boxes = [w.bbox for w in words if w.bbox]
                        if len(boxes) == len(words):
                            bbox = [min(b[0] for b in boxes), min(b[1] for b in boxes),
                                    max(b[2] for b in boxes), max(b[3] for b in boxes)]
                            candidates.append(iou(field["bbox"], bbox))
                        else:
                            candidates.append(0.0)
            best = max(candidates, default=0.0)
            matched += bool(candidates)
            localized += best >= 0.5
            results.append({"page": expected["page"], "field": field["field"],
                            "exact": bool(candidates), "iou": best})
    return {"char_errors": errors, "reference_chars": chars,
            "character_accuracy": 1 - errors / chars if chars else None,
            "field_total": len(results), "field_exact": matched,
            "field_localized": localized, "fields": results}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=1, choices=range(1, 11))
    ap.add_argument("--revision", required=True)
    args = ap.parse_args()
    if os.environ.get("INSPECTOR_PROFILE") != "gpu":
        ap.error("real baseline requires INSPECTOR_PROFILE=gpu on the GPU host")
    args.out.mkdir(parents=True, exist_ok=False)
    fixtures = args.out / "synthetic"
    fixtures.mkdir()
    font = Path(__file__).resolve().parents[2] / "assets/fonts/NotoSans.ttf"
    pdfmetrics.registerFont(TTFont("BaselineNoto", str(font)))
    from inspector_ml.ocr_gpu import check_ready
    startup = time.monotonic()
    check_ready("gpu")
    startup_s = time.monotonic() - startup
    root = Path(__file__).resolve().parents[1]
    fingerprints = {str(p.relative_to(root)): digest(p) for p in (
        Path(__file__), root / "inspector_ml/parse.py",
        root / "inspector_ml/ocr_gpu.py", root / "inspector_ml/docstore.py",
        root / "models.yaml")}
    rows = []
    for case in CASES[:args.limit]:
        gold = fixture(fixtures, case)
        cache = MemoryCache()
        started = time.monotonic()
        print(json.dumps({"event": "case_start", "case": gold["id"],
                          "timestamp": time.time()}), flush=True)
        try:
            doc, hit = load_parsed(cache, Path(gold["path"]), gold["sha256"])
            elapsed = time.monotonic() - started
            scores = score(doc, gold)
            before = time.monotonic()
            warmed, warm_hit = load_parsed(cache, Path(gold["path"]), gold["sha256"])
            row = {"id": gold["id"], "sha256": gold["sha256"],
                   "cold_s": elapsed, "cold_hit": hit,
                   "warm_s": time.monotonic() - before, "warm_hit": warm_hit,
                   "warm_identical": warmed == doc,
                   "cache_key": parsed_key(gold["sha256"]), "scores": scores,
                   "pages": [{"page": p.page, "source": p.source,
                              "quality": p.quality, "engines": p.engines,
                              "words": sum(len(l.words) for l in p.lines)} for p in doc.pages]}
            (args.out / f"{gold['id']}-parsed.json").write_text(doc.model_dump_json())
        except Exception as exc:
            row = {"id": gold["id"], "error": type(exc).__name__,
                   "detail": str(exc), "cold_s": time.monotonic() - started}
        row["process_lifetime_peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rows.append(row)
        (args.out / f"{gold['id']}-gold.json").write_text(json.dumps(gold, ensure_ascii=False, indent=2))
        print(json.dumps({"event": "case_done", "timestamp": time.time(), **row}, ensure_ascii=False), flush=True)
        # Preserve completed measurements even if a later case crashes.
        (args.out / "report.json").write_text(json.dumps({
            "schema": "resource-ocr-baseline/1", "revision": args.revision,
            "fingerprints": fingerprints, "model_startup_s": startup_s,
            "cache_method": "isolated memory cache; cold artifacts with resident models, then cache hit",
            "platform": platform.platform(), "scope": "synthetic parse/field diagnostic, not TZ acceptance",
            "config": {k: v for k, v in os.environ.items() if k in (
                "INSPECTOR_PROFILE", "INSPECTOR_OCR_WORKERS", "INSPECTOR_RENDER_PROCS",
                "INSPECTOR_PPOCR_GPU_MB", "INSPECTOR_VLM_READER", "INSPECTOR_VL_INFLIGHT")},
            "cases": rows}, ensure_ascii=False, indent=2))
        if "error" in row:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
