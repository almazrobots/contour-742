"""Bounded PDFium region raster plus exact bitmap-to-visible transform."""
from contextlib import closing
import math
from pathlib import Path

import pypdfium2 as pdfium

from .parse import PDFIUM_LOCK
from .pipeline_contract import Region, identity
from .pipeline_geometry import page_geometry
from .resource_scope import render_guarded


def render_pdf_zone(path: Path, sha256: str, number: int, box):
    """Render a reread zone at 300 DPI without allocating the complete page."""
    with PDFIUM_LOCK, pdfium.PdfDocument(path) as document:
        with closing(document[number-1]) as page:
            geometry = page_geometry(page)
    width = math.ceil(geometry.width * (box[2]-box[0]) * 300/72)
    height = math.ceil(geometry.height * (box[3]-box[1]) * 300/72)
    if width * height > 3_000_000:
        raise ValueError('reread zone exceeds raster policy; DPI reduction forbidden')
    page_id = identity('page', sha256, number)
    region = Region(id=identity('region', page_id, box), page_id=page_id,
                    page=number, bbox=box, geometry=geometry)
    return render_region(path, region, 300)


def render_region(path: Path, region: Region, dpi: int):
    if type(dpi) is not int or not 72 <= dpi <= 600:
        raise ValueError('invalid region DPI')
    x0,y0,x1,y1 = region.bbox
    if not all(math.isfinite(v) for v in region.bbox) or not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise ValueError('invalid region bounds')
    with PDFIUM_LOCK, pdfium.PdfDocument(path) as document:
        if not 1 <= region.page <= len(document):
            raise ValueError('region page missing')
        with closing(document[region.page-1]) as page:
            actual = page_geometry(page)
            if actual != region.geometry:
                raise ValueError('region geometry differs from source')
            w,h = page.get_size()
            scale = dpi/72
            full_w,full_h = math.ceil(w*scale),math.ceil(h*scale)
            crop = (x0*w, (1-y1)*h, (1-x1)*w, y0*h)
            left,bottom,right,top = [math.ceil(c*scale) for c in crop]
            width,height = full_w-left-right,full_h-bottom-top
            if min(width,height) < 1:
                raise ValueError('region rounds to empty raster')
            def raster():
                with closing(page.render(scale=scale,crop=crop)) as bitmap:
                    image = bitmap.to_pil().copy()
                if image.size != (width,height):
                    image.close()
                    raise ValueError('PDFium crop dimensions changed')
                return image
            image = render_guarded(raster,width,height,1)
            # Normalized crop coordinates -> normalized visible page. Includes
            # PDFium ceil rounding, CropBox/Rotate are already in page geometry.
            transform = (width/full_w,0,0,height/full_h,left/full_w,top/full_h)
            return image, transform
