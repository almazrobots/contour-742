"""PDF geometry only; no rendering/OCR. All PDFium access holds PDFIUM_LOCK."""

import ctypes
from contextlib import closing
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as raw

from .parse import CorruptedFile, MAX_PAGES, PDFIUM_LOCK
from .pipeline_contract import Geometry, Matrix, Region, identity


def apply(matrix: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f


def inverse(matrix: Matrix) -> Matrix:
    a, b, c, d, e, f = matrix
    det = a * d - b * c
    if abs(det) < 1e-15:
        raise ValueError("singular coordinate transform")
    return d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det


def page_geometry(page) -> Geometry:
    """Caller holds PDFIUM_LOCK. DeviceToPage avoids clipped/rounded source samples."""
    def point(x, y):
        px, py = ctypes.c_double(), ctypes.c_double()
        if not raw.FPDF_DeviceToPage(page.raw, 0, 0, 100_000, 100_000, 0, x, y, px, py):
            raise CorruptedFile("не удалось определить координаты страницы")
        return px.value, py.value

    origin, right, bottom = point(0, 0), point(100_000, 0), point(0, 100_000)
    transform = (right[0] - origin[0], right[1] - origin[1],
                 bottom[0] - origin[0], bottom[1] - origin[1], *origin)
    width, height = page.get_size()
    return Geometry(width=width, height=height, rotation=page.get_rotation(),
                    media_box=page.get_mediabox(), crop_box=page.get_cropbox(),
                    visible_to_pdf=transform, pdf_to_visible=inverse(transform))


def pdf_regions(path: Path, sha256: str, *, profiles: list[dict] | None = None) -> list[Region]:
    with PDFIUM_LOCK:
        try:
            with pdfium.PdfDocument(path) as pdf:
                if len(pdf) > MAX_PAGES:
                    raise CorruptedFile("PDF превышает предел числа страниц")
                out = []
                for i in range(len(pdf)):
                    with closing(pdf[i]) as page:
                        pid = identity("page", sha256, i + 1)
                        if profiles is not None:
                            from dataclasses import asdict
                            from .pagekind import classify, page_features
                            features = page_features(page)
                            kind, reasons = classify(features)
                            profiles.append({"page": i + 1, "page_id": pid, "kind": kind,
                                             "reasons": list(reasons), "features": asdict(features)})
                        out.append(Region(id=identity("region", pid, [0, 0, 1, 1]),
                                          page_id=pid, page=i + 1, geometry=page_geometry(page)))
                return out
        except (pdfium.PdfiumError, ValueError) as exc:
            raise CorruptedFile("не удалось прочитать геометрию PDF") from exc
