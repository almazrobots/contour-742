"""Existing OCR ensemble on a bounded region; preserve separate native evidence."""
from contextlib import closing
import math
from pathlib import Path

import pypdfium2 as pdfium

from .model import Line, ParsedDoc
from .parse import PDFIUM_LOCK, OCR_BUDGET, _ocr_image, _text_lines
from .pipeline_contract import Region
from .pipeline_geometry import apply
from .pipeline_region_render import render_region


def map_box(box, transform):
    if box is None:
        return None
    if not all(math.isfinite(v) for v in box) or not (0 <= box[0] <= box[2] <= 1 and 0 <= box[1] <= box[3] <= 1):
        raise ValueError('OCR returned invalid regional bbox')
    x0,y0 = apply(transform,box[0],box[1]);x1,y1 = apply(transform,box[2],box[3])
    return (x0,y0,x1,y1)


def parse_region(path: Path, sha256: str, region: Region, dpi: int = 300, *, diagnostics: list | None = None,
                 localization: list | None = None):
    geometry = region.geometry
    if geometry is None:
        raise ValueError('PDF region needs geometry')
    x0,y0,x1,y1 = region.bbox
    pixels = geometry.width*(x1-x0)*geometry.height*(y1-y0)*(dpi/72)**2
    held = OCR_BUDGET.acquire(pixels/1e6)
    image = None
    try:
        image, transform = render_region(path,region,dpi)
        result = _ocr_image(image,region.page,geometry.width,geometry.height,geometry.rotation)
        # A blank anchor result must not suppress the mandatory second voice.
        # Reader can expose a missed inscription, but cannot invent its word boxes.
        from .ocr_gpu import engine_names
        import os
        required = engine_names(os.environ.get('INSPECTOR_PROFILE', 'dev'))
        if ('vl-reader' in required and 'vl-reader' not in result.engines
                and not result.lines and any(e.startswith('ppocr') for e in result.engines)):
            from . import vlm
            from .ocr_gpu import VL_PROMPT
            text = vlm.generate(vlm.READER, image, VL_PROMPT, max_tokens=512)
            result.engines.append('vl-reader')
            if text.strip() and diagnostics is not None:
                diagnostics.append({'region_id': region.id, 'text': text,
                                    'status': 'unlocalized', 'source': 'vl-reader'})
            # Unanchored model output is not a localized document fact. Blank
            # images can elicit repetitive text; retain it outside extraction.
            result.quality = 'LOW_QUALITY'
        for line in result.lines:
            for word in line.words:
                from .ink_localization import tighten_box
                detector_box = word.bbox
                refined_box = tighten_box(image, detector_box)
                if localization is not None and refined_box != detector_box:
                    localization.append({'method': 'raster-ink-v1', 'text': word.text,
                        'detector_bbox': map_box(detector_box, transform),
                        'bbox': map_box(refined_box, transform)})
                word.bbox = refined_box
                word.bbox = map_box(word.bbox,transform)
        for word in result.anchor_words:
            word.bbox = map_box(word.bbox,transform)
        for requisite in result.requisites:
            requisite.bbox = map_box(requisite.bbox,transform)
    finally:
        if image is not None:
            image.close()
        OCR_BUDGET.release(held)
    # Native evidence is separate: never masquerade it as OCR or let its presence
    # suppress the mandatory ensemble. Merge decides matching/conflicts later.
    native = []
    with PDFIUM_LOCK, pdfium.PdfDocument(path) as document:
        with closing(document[region.page-1]) as page:
            for line in _text_lines(page):
                words = [w for w in line.words if w.bbox is not None and
                    x0 <= (w.bbox[0]+w.bbox[2])/2 <= x1 and y0 <= (w.bbox[1]+w.bbox[3])/2 <= y1]
                if words:
                    native.append(Line(text=' '.join(w.text for w in words),words=words))
    return (ParsedDoc(sha256=sha256,kind='pdf',pages=[result],engine='+'.join(sorted(result.engines))),
            native, transform)
