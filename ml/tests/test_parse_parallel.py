"""Параллельный OCR страниц-сканов вне замка pdfium (T-129): документ со 110 сканами больше не останавливает разбор
остальных, страницы распознаются пулом воркеров. Проверяется порядок, равенство последовательному разбору, отказ."""

import hashlib
import threading

import pytest
from PIL import Image, ImageDraw
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from inspector_ml import parse as P


def scan_pdf(path, texts):
    """PDF из растров без текстового слоя: каждая страница — картинка с надписью."""
    c = canvas.Canvas(str(path), pagesize=(600, 300))
    for t in texts:
        img = Image.new("RGB", (1800, 900), "white")
        ImageDraw.Draw(img).text((80, 380), t, fill="black", font_size=90)
        c.drawImage(ImageReader(img), 0, 0, width=600, height=300)
        c.showPage()
    c.save()
    return path


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.mark.l2_differential
def test_parallel_equals_sequential(tmp_path, monkeypatch):
    f = scan_pdf(tmp_path / "s.pdf", ["СТРАНИЦА 1", "СТРАНИЦА 2", "СТРАНИЦА 3"])
    monkeypatch.setattr(P, "OCR_WORKERS", 1)
    one = P.parse_pdf(f, sha(f))
    monkeypatch.setattr(P, "OCR_WORKERS", 4)
    four = P.parse_pdf(f, sha(f))
    assert [p.model_dump() for p in four.pages] == [p.model_dump() for p in one.pages]
    assert [p.page for p in four.pages] == [1, 2, 3] and {p.source for p in four.pages} == {"ocr"}


@pytest.mark.l3_boundary
def test_order_kept_when_workers_exceed_pages_and_pages_finish_out_of_order(tmp_path, monkeypatch):
    f = scan_pdf(tmp_path / "s.pdf", ["А", "Б", "В", "Г", "Д"])
    real = P._ocr_image

    def slow_first(img, number, w, h, rot, downscaled=False):
        if number == 1:
            threading.Event().wait(0.3)  # первая страница кончает последней
        return real(img, number, w, h, rot)

    monkeypatch.setattr(P, "_ocr_image", slow_first)
    monkeypatch.setattr(P, "OCR_WORKERS", 16)
    assert [p.page for p in P.parse_pdf(f, sha(f)).pages] == [1, 2, 3, 4, 5]


@pytest.mark.l4_fault
def test_ocr_failure_propagates_and_releases_pdfium(tmp_path, monkeypatch):
    f = scan_pdf(tmp_path / "s.pdf", ["А", "Б", "В"])

    def boom(img, number, w, h, rot, downscaled=False):
        if number == 2:
            raise RuntimeError("tesseract упал")
        return P.Page(page=number, width=w, height=h, rotation=rot, source="ocr", lines=[])

    monkeypatch.setattr(P, "_ocr_image", boom)
    with pytest.raises(RuntimeError, match="tesseract упал"):
        P.parse_pdf(f, sha(f))
    assert P.PDFIUM_LOCK.acquire(timeout=1)  # замок свободен: следующий документ не встанет
    P.PDFIUM_LOCK.release()


@pytest.mark.l4_fault
def test_ocr_runs_outside_pdfium_lock(tmp_path, monkeypatch):
    """Во время OCR страницы замок pdfium свободен — другой документ может читать текстовый слой."""
    f = scan_pdf(tmp_path / "s.pdf", ["А"])
    free = []

    def probe(img, number, w, h, rot, downscaled=False):
        ok = P.PDFIUM_LOCK.acquire(timeout=1)
        free.append(ok)
        if ok:
            P.PDFIUM_LOCK.release()
        return P.Page(page=number, width=w, height=h, rotation=rot, source="ocr", lines=[])

    monkeypatch.setattr(P, "_ocr_image", probe)
    P.parse_pdf(f, sha(f))
    assert free == [True]


@pytest.mark.l7_discipline
@pytest.mark.parametrize(("raw", "want"), [(None, 4), ("0", 1), ("-3", 1), ("6", 6), ("много", 4)])
def test_workers_from_env_are_positive(raw, want):
    assert P.ocr_workers({} if raw is None else {"INSPECTOR_OCR_WORKERS": raw}) == want


# ─────────────── бюджет пикселей OCR: регрессия OOM на стенде «Алтуфьево» (3 документа × 4 воркера × листы А1)


@pytest.mark.l8_regression
@pytest.mark.l4_fault
def test_pixel_budget_never_exceeded_under_contention():
    b = P.PixelBudget(150)
    peak, cur, lock = [0.0], [0.0], threading.Lock()

    def job(mpx):
        held = b.acquire(mpx)
        with lock:
            cur[0] += held
            peak[0] = max(peak[0], cur[0])
        threading.Event().wait(0.01)
        with lock:
            cur[0] -= held
        b.release(held)

    ts = [threading.Thread(target=job, args=(70,)) for _ in range(24)]  # 24 листа А1 при 300 dpi
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert peak[0] <= 150 and b.used == 0


@pytest.mark.l3_boundary
def test_oversized_page_runs_alone_instead_of_deadlock():
    b = P.PixelBudget(50)
    held = b.acquire(400)  # лист больше бюджета — занимает весь бюджет и идёт один
    assert held == 50 and b.used == 50
    b.release(held)
    assert b.used == 0


@pytest.mark.l3_boundary
@pytest.mark.parametrize(("w", "h", "mpx"), [(1684, 2384, 69.7), (595, 842, 8.7), (0, 842, 0.0)])
def test_page_megapixels_at_300_dpi(w, h, mpx):
    assert round(P.page_mpx(w, h), 1) == mpx


@pytest.mark.l7_discipline
@pytest.mark.parametrize(("raw", "want"), [(None, 150.0), ("64", 64.0), ("0", 1.0), ("много", 150.0)])
def test_budget_from_env(raw, want):
    assert P._budget_mpx({} if raw is None else {"INSPECTOR_OCR_BUDGET_MPX": raw}) == want


# ─────────────── SEC-01 (OWASP-аудит T-129): размер растра задаёт недоверенный PDF


@pytest.mark.l3_boundary
def test_render_scale_keeps_a0_and_caps_giant_sheet():
    a0 = (2384, 3370)  # А0 в пунктах: при 300 dpi ≈ 139 Мпикс — ниже потолка 150, рендер как есть
    assert P.render_scale(*a0, 300, 150) == pytest.approx(300 / 72)
    giant = (5544, 5544)  # 77″ × 77″ — ~530 Мпикс при 300 dpi
    s = P.render_scale(*giant, 300, 150)
    assert s < 300 / 72
    assert (giant[0] * s) * (giant[1] * s) / 1e6 == pytest.approx(150, rel=1e-6)
    assert P.render_scale(0, 0, 300, 150) == pytest.approx(300 / 72)


def _blank_pdf(tmp_path, n: int, size=(595, 842)):
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    for _ in range(n):
        pdf.new_page(*size)
    p = tmp_path / f"blank-{n}.pdf"
    pdf.save(str(p))
    pdf.close()
    return p


@pytest.mark.l4_fault
def test_too_many_pages_is_refused_before_any_render(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "MAX_PAGES", 3)
    calls = []
    monkeypatch.setattr(P, "run_ensemble", lambda img: calls.append(1))
    with pytest.raises(P.TooLarge, match="4 страниц — больше предела разбора 3"):
        P.parse_pdf(_blank_pdf(tmp_path, 4), "0" * 64)
    assert calls == []
    assert issubclass(P.TooLarge, P.CorruptedFile)  # API получает 422 с причиной, а не повтор


@pytest.mark.l4_fault
def test_giant_blank_page_is_rendered_under_the_cap_and_marked_low_quality(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "MAX_PAGE_MPX", 2.0)
    seen = []

    def fake(img):
        seen.append(img.size[0] * img.size[1])
        from inspector_ml.ocr_ensemble import VoteResult

        return VoteResult(engines=["fake"], words=[], disputed_words=0, agreement=1.0, mean_conf=95.0)

    monkeypatch.setattr(P, "run_ensemble", fake)
    # распознано уверенно (95 %) и строки есть — LOW_QUALITY только из-за пониженного dpi
    monkeypatch.setattr(P, "group_lines", lambda words: [P.Line(text="класс С0", words=[])])
    doc = P.parse_pdf(_blank_pdf(tmp_path, 1, (2384, 3370)), "0" * 64)
    assert seen and seen[0] <= 2.0e6 * 1.01
    assert doc.pages[0].quality == "LOW_QUALITY"
    monkeypatch.setattr(P, "MAX_PAGE_MPX", 500.0)  # тот же лист ниже потолка — качество OK
    assert P.parse_pdf(_blank_pdf(tmp_path, 1, (595, 842)), "1" * 64).pages[0].quality == "OK"
    monkeypatch.setattr(P, "MAX_PAGE_MPX", 500.0)  # тот же лист ниже потолка — качество OK
    assert P.parse_pdf(_blank_pdf(tmp_path, 1, (595, 842)), "1" * 64).pages[0].quality == "OK"


# ─────────────── L8: границы, найденные mutmut (T-129)


@pytest.mark.l8_regression
def test_env_num_reads_env_clamps_and_falls_back(monkeypatch):
    monkeypatch.setenv("X_TEST_NUM", "5")
    assert P._env_num("X_TEST_NUM", 150.0, 1.0) == 5.0
    monkeypatch.setenv("X_TEST_NUM", "0.2")
    assert P._env_num("X_TEST_NUM", 150.0, 1.0) == 1.0
    monkeypatch.setenv("X_TEST_NUM", "много")
    assert P._env_num("X_TEST_NUM", 150.0, 1.0) == 150.0
    monkeypatch.delenv("X_TEST_NUM")
    assert P._env_num("X_TEST_NUM", 150.0, 1.0) == 150.0


@pytest.mark.l8_regression
def test_workers_and_budget_read_process_env_by_default(monkeypatch):
    monkeypatch.setenv("INSPECTOR_OCR_WORKERS", "7")
    monkeypatch.setenv("INSPECTOR_OCR_BUDGET_MPX", "33")
    assert P.ocr_workers() == 7 and P._budget_mpx() == 33.0


@pytest.mark.l8_regression
def test_render_scale_default_cap_zero_size_and_exact_area(monkeypatch):
    monkeypatch.setattr(P, "MAX_PAGE_MPX", 10.0)
    s = P.render_scale(5000, 5000)  # потолок по умолчанию — MAX_PAGE_MPX
    assert (5000 * s) * (5000 * s) == pytest.approx(10.0e6, rel=1e-9)
    for w_, h_ in [(0, 100), (100, 0), (-5, 100), (100, -5)]:
        assert P.render_scale(w_, h_) == pytest.approx(P.OCR_DPI / 72)
    assert P.page_mpx(72, 72, 1000) == 1.0


@pytest.mark.l8_regression
def test_downscaled_only_when_the_cap_actually_cuts(monkeypatch):
    monkeypatch.setattr(P, "MAX_PAGE_MPX", 10.0)
    w_ = (10.0e6 / (P.OCR_DPI / 72) ** 2) ** 0.5  # ровно на потолке: масштаб = dpi/72 — не понижен
    assert not P._downscaled(w_, w_)
    assert P._downscaled(w_ * 1.001, w_)  # чуть больше — понижен, хотя масштаб отличается на доли процента


@pytest.mark.l8_regression
def test_budget_second_page_fits_without_waiting_and_exact_fill_is_allowed():
    import threading

    b = P.PixelBudget(100)
    got = []
    b.acquire(60)
    t = threading.Thread(target=lambda: got.append(b.acquire(40)))  # ровно заполняет бюджет — не ждёт
    t.start()
    t.join(1.0)
    assert got == [40] and b.used == 100
    b.release(60)
    b.release(40)
    assert b.used == 0
