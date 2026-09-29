from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import gc
from threading import Event

import pytest
from PIL import Image

from inspector_ml.execution_scope import scoped_submit
from inspector_ml.resource_admission import Resources
from inspector_ml.resource_scope import (
    ResourceBudgetExceeded, is_supervised, render_guarded, require_render_pixels,
    require_single_ocr_worker, require_tokens, supervised_resources, token_allocation,
)


def budget(**kw):
    return Resources(**{"pixels": 100, "ram": 1600, "tokens": 100, **kw})


def raster(w=10, h=10):
    return render_guarded(lambda: Image.new("RGB", (w, h)), w, h, 1)


def test_legacy_calls_remain_unscoped():
    assert not is_supervised()
    require_render_pixels(10000, 10000, 10)
    require_tokens(2000)
    require_single_ocr_worker(4, 4)
    assert raster().size == (10, 10)


@pytest.mark.parametrize("args", [(0, 10, 1), (10, -1, 1), (10, 10, float("nan")), (True, 10, 1), (1e308, 1e308, 1e308)])
def test_invalid_dimensions_fail_before_renderer(args):
    called = []
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded):
        render_guarded(lambda: called.append(True), *args)
    assert called == []


def test_round_up_dimensions_and_deny_without_changing_scale():
    with supervised_resources(budget(pixels=900, ram=16000)):
        # 30.03 rounds to 31 on each axis: 961 pixels, not 900.
        with pytest.raises(ResourceBudgetExceeded):
            require_render_pixels(10.01, 10.01, 3)
        require_render_pixels(10, 10, 3)


def test_raster_copies_ram_denied_before_allocation():
    called = []
    with supervised_resources(budget(ram=1599)), pytest.raises(ResourceBudgetExceeded, match="ram"):
        render_guarded(lambda: called.append(True), 10, 10, 1)
    assert called == []


def test_live_rasters_share_budget_until_last_reference_is_gone():
    with supervised_resources(budget()):
        image = raster()
        alias = image
        del image
        with pytest.raises(ResourceBudgetExceeded, match="pixels"):
            raster()
        del alias
        gc.collect()
        replacement = raster()
        assert replacement.size == (10, 10)


def test_render_error_releases_reserved_credits():
    def failed():
        raise ValueError("render failed")

    with supervised_resources(budget()):
        with pytest.raises(ValueError, match="render failed"):
            render_guarded(failed, 10, 10, 1)
        assert raster().size == (10, 10)


def test_scoped_submit_shares_inflight_rasters_across_threads():
    ready, release = Event(), Event()

    def owner():
        image = raster()
        ready.set()
        assert release.wait(5)
        return image.size

    with supervised_resources(budget()), ThreadPoolExecutor(2) as pool:
        future = scoped_submit(pool, owner)
        try:
            assert ready.wait(5)
            blocked = scoped_submit(pool, raster)
            with pytest.raises(ResourceBudgetExceeded):
                blocked.result(timeout=5)
        finally:
            release.set()
        assert future.result(timeout=5) == (10, 10)


def test_tokens_are_sum_of_inflight_calls_and_released_on_error():
    with supervised_resources(budget()):
        with token_allocation(60):
            with pytest.raises(ResourceBudgetExceeded, match="tokens"):
                with token_allocation(41):
                    pytest.fail("must not dispatch")
            with token_allocation(40):
                pass
        with pytest.raises(ValueError):
            with token_allocation(100):
                raise ValueError("transport failed")
        with token_allocation(100):
            pass


@pytest.mark.parametrize("number", [0, -1, True, 1.5, 101])
def test_invalid_or_oversize_tokens_fail_closed(number):
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded):
        require_tokens(number)


def test_nested_budget_cannot_expand_reservation_and_late_task_is_closed():
    with supervised_resources(budget()):
        context = copy_context()
        with pytest.raises(ResourceBudgetExceeded):
            with supervised_resources(budget(pixels=10**9)):
                pass
    with pytest.raises(ResourceBudgetExceeded, match="closed"):
        context.run(raster)
    assert not is_supervised()


@pytest.mark.parametrize("workers,procs", [(2, 0), (1, 1)])
def test_pilot_rejects_ocr_fanout(workers, procs):
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded):
        require_single_ocr_worker(workers, procs)


def test_parse_rejects_scope_before_opening_pdf(monkeypatch, tmp_path):
    from inspector_ml import parse
    monkeypatch.setattr(parse, "OCR_WORKERS", 2)
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded, match="one OCR"):
        parse.parse_pdf(tmp_path / "absent.pdf", "0" * 64)


def test_render_scale_does_not_reduce_dpi_to_fit_reservation():
    from inspector_ml.parse import render_scale
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded, match="pixels"):
        render_scale(10, 10, dpi=144)


def test_vlm_tokens_checked_before_dispatch(monkeypatch):
    from inspector_ml import vlm
    called = []
    monkeypatch.setattr(vlm, "backend", lambda: called.append(True))
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded, match="tokens"):
        vlm.generate("model", Image.new("RGB", (1, 1)), "prompt", max_tokens=101)
    assert called == []


def test_sheetdiff_actual_raster_keeps_credits_until_returned_array_dies(tmp_path):
    from reportlab.pdfgen.canvas import Canvas
    from inspector_ml.sheetdiff import render_gray
    path = tmp_path / "tiny.pdf"
    canvas = Canvas(str(path), pagesize=(10, 10))
    canvas.drawString(1, 1, "x")
    canvas.showPage()
    canvas.save()
    with supervised_resources(budget(ram=6400)):
        image = render_gray(path, 1, dpi=72)
        assert image.shape == (10, 10)
        with pytest.raises(ResourceBudgetExceeded):
            render_gray(path, 1, dpi=72)
        del image
        gc.collect()
        assert render_gray(path, 1, dpi=72).shape == (10, 10)


@pytest.mark.parametrize("operation", ["copy", "resize"])
def test_image_allocations_denied_before_pillow(monkeypatch, operation):
    from inspector_ml.formats import _ImagePage, _copy_frame
    img = Image.new("RGB", (11, 11))
    called = []
    monkeypatch.setattr(img, operation, lambda *args, **kw: called.append(True))
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded):
        if operation == "copy":
            _copy_frame(img)
        else:
            _ImagePage(img, 72).render(scale=2)
    assert called == []


def test_parse_image_denied_before_decode(monkeypatch, tmp_path):
    from inspector_ml import formats
    img = Image.new("RGB", (11, 11))
    called = []
    monkeypatch.setattr(formats.Image, "open", lambda *args: img)
    monkeypatch.setattr(img, "load", lambda: called.append(True))
    with supervised_resources(budget()), pytest.raises(ResourceBudgetExceeded):
        formats.parse_image(tmp_path / "oversize.png", "0" * 64)
    assert called == []


def test_passport_ink_denied_before_pdfium_render():
    from inspector_ml.page_passport import _ink
    class Page:
        def render(self, **kw):
            pytest.fail("render called before admission")
    with supervised_resources(budget(pixels=1)), pytest.raises(ResourceBudgetExceeded):
        _ink(Page(), 100, 100)


def test_passport_ink_guard_accepts_real_pdfium_bitmap(tmp_path):
    from reportlab.pdfgen.canvas import Canvas
    from inspector_ml.page_passport import _ink
    from inspector_ml.parse import PDFIUM_LOCK
    import pypdfium2 as pdfium
    path = tmp_path / "ink.pdf"
    canvas = Canvas(str(path), pagesize=(10, 10))
    canvas.drawString(1, 1, "x")
    canvas.showPage()
    canvas.save()
    with supervised_resources(budget(pixels=10000, ram=160000)), PDFIUM_LOCK:
        with pdfium.PdfDocument(str(path)) as doc:
            page = doc[0]
            try:
                assert isinstance(_ink(page, 10, 10), dict)
            finally:
                page.close()
