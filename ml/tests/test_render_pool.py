"""T-233: растеризация страниц в пуле процессов — тот же растр, что под замком процесса; выключенный пул и крупный лист —
старый путь."""

from __future__ import annotations

import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageDraw

from inspector_ml import render_pool


def _scan_pdf(tmp_path, pages: int = 3):
    """PDF из растровых страниц со штрихами (как скан): страница — картинка на весь лист."""
    pdf = pdfium.PdfDocument.new()
    for n in range(pages):
        img = Image.new("RGB", (620, 877), "white")
        d = ImageDraw.Draw(img)
        d.rectangle([40 + n * 10, 60, 580, 120], outline="black", width=3)
        d.line([40, 200 + n * 30, 580, 260], fill="black", width=2)
        page = pdf.new_page(595, 842)
        obj = pdfium.PdfImage.new(pdf)
        obj.set_bitmap(pdfium.PdfBitmap.from_pil(img))
        obj.set_matrix(pdfium.PdfMatrix().scale(595, 842))
        page.insert_obj(obj)
        page.gen_content()
    path = tmp_path / "scan.pdf"
    pdf.save(str(path))
    return path


def _local(path, i, scale):
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[i].render(scale=scale).to_pil()
    finally:
        doc.close()


@pytest.fixture
def pool_on(monkeypatch):
    monkeypatch.setenv("INSPECTOR_RENDER_PROCS", "2")
    monkeypatch.setattr(render_pool, "_POOL", None)
    monkeypatch.setattr(render_pool, "_BROKEN", False)
    yield
    if render_pool._POOL is not None:
        render_pool._POOL.shutdown(cancel_futures=True)


@pytest.mark.l2_integration
def test_pool_raster_equals_local(tmp_path, pool_on):
    """Растр из пула побайтно равен растру в процессе ML — OCR видит то же самое."""
    path = _scan_pdf(tmp_path)
    for i in range(3):
        got = render_pool.render(str(path), i, 2.0, mpx=4.0)
        want = _local(path, i, 2.0)
        assert got is not None and got.size == want.size and got.mode == want.mode
        assert got.tobytes() == want.tobytes()


@pytest.mark.l1_functional
def test_pool_off_or_large_sheet_uses_old_path(tmp_path, monkeypatch):
    monkeypatch.setenv("INSPECTOR_RENDER_PROCS", "0")
    assert render_pool.render(str(tmp_path / "x.pdf"), 0, 1.0, mpx=1.0) is None
    monkeypatch.setenv("INSPECTOR_RENDER_PROCS", "2")
    monkeypatch.setenv("INSPECTOR_RENDER_POOL_MAX_MPX", "40")
    monkeypatch.setattr(render_pool, "_POOL", None)
    assert (
        render_pool.render(str(tmp_path / "x.pdf"), 0, 1.0, mpx=41.0) is None
    )  # крупный лист — на месте
    assert render_pool._POOL is not None
    render_pool._POOL.shutdown()


@pytest.mark.l1_functional
@pytest.mark.parametrize("raw,n", [(None, 0), ("5", 5), ("-1", 0), ("40", 16)])
def test_procs_bounds(raw, n):
    assert (
        render_pool.procs({} if raw is None else {"INSPECTOR_RENDER_PROCS": raw}) == n
    )


@pytest.mark.l4_fault
def test_procs_not_a_number_fails_loudly():
    with pytest.raises(ValueError):
        render_pool.procs({"INSPECTOR_RENDER_PROCS": "пять"})
