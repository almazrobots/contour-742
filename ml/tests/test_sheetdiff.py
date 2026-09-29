"""Дифф листа между редакциями (OS-INSP-3.4). Листы — синтетика ml/synth/sheets.py, генерируются в tmp."""

from __future__ import annotations

import hashlib
import importlib
import shutil
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "synth"))
import sheets

from inspector_ml.sheetdiff import MIN_INLIERS, diff_pages

SHIFT = {"dx_mm": 3.0, "dy_mm": -2.0, "rot_deg": 0.7}  # вся редакция B смещена и повёрнута


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def touches(a, b, pad: float = 0.005) -> bool:
    return (
        a[0] - pad <= b[2]
        and b[0] - pad <= a[2]
        and a[1] - pad <= b[3]
        and b[1] - pad <= a[3]
    )


@pytest.fixture(scope="module")
def pdfs(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("sheets")
    return {
        "A": sheets.draw_plan(d / "A.pdf", "A"),
        "B": sheets.draw_plan(d / "B.pdf", "B", **SHIFT),
        "A_moved": sheets.draw_plan(
            d / "A_moved.pdf", "A", dx_mm=-2.0, dy_mm=3.0, rot_deg=-0.8
        ),
        "B_rot90": sheets.draw_plan(d / "B_rot90.pdf", "B", **SHIFT, rotate_page=90),
        "other": sheets.draw_other(d / "other.pdf"),
    }


# ─────────────────────────────── OS-INSP-3.4.1 совмещение


@pytest.mark.l1_functional
def test_sheets_registered_despite_shift_and_rotation(pdfs):
    """OS-INSP-3.4.1: редакция B сдвинута на 3/−2 мм и повёрнута на 0,7° — совмещение по ключевым точкам
    и гомографии находит лист, инлайеров заметно больше порога."""
    r = diff_pages(pdfs["A"], 1, pdfs["B"], 1)
    assert r.status == "ok", r.reason
    assert r.inliers > 4 * MIN_INLIERS
    assert r.method in ("sift", "orb")


@pytest.mark.l3_boundary
def test_rotated_page_compared_in_visible_orientation(pdfs):
    """OS-INSP-3.4.1: лист B с /Rotate 90 рендерится в видимой ориентации; область на листе B
    получает свой bbox (обратной гомографией), а не копию bbox листа A."""
    r = diff_pages(pdfs["A"], 1, pdfs["B_rot90"], 1)
    assert r.status == "ok", r.reason
    room = sheets.answer()["removed_room"]["bbox_a"]
    best = max(r.regions, key=lambda g: iou(g.bbox_a, room))
    assert iou(best.bbox_a, room) >= 0.3
    # на повёрнутом листе область «лежит»: ширина и высота меняются местами
    wa, ha = best.bbox_a[2] - best.bbox_a[0], best.bbox_a[3] - best.bbox_a[1]
    wb, hb = best.bbox_b[2] - best.bbox_b[0], best.bbox_b[3] - best.bbox_b[1]
    assert (wa > ha) != (wb > hb) or abs(wa - ha) < 0.02


# ─────────────────────────────── OS-INSP-3.4.2 карта изменений


@pytest.mark.l1_functional
def test_changed_regions_found_with_bbox(pdfs):
    """OS-INSP-3.4.2: удалённое помещение найдено областью с IoU ≥ 0.3; перенесённая перегородка —
    области на старом и на новом месте; bbox на листе B учитывает сдвиг листа."""
    r = diff_pages(pdfs["A"], 1, pdfs["B"], 1)
    key = sheets.answer()
    room = key["removed_room"]["bbox_a"]
    best = max(r.regions, key=lambda g: iou(g.bbox_a, room))
    assert iou(best.bbox_a, room) >= 0.3
    assert any(touches(g.bbox_a, key["wall_old"]["bbox_a"]) for g in r.regions)
    assert any(touches(g.bbox_a, key["wall_new"]["bbox_a"]) for g in r.regions)
    assert len(r.regions) <= 5  # без шума по всему листу
    # сдвиг B вправо на 3 мм (≈ 0.0107 ширины) и вниз на 2 мм — bbox_b смещён туда же
    assert best.bbox_b[0] > best.bbox_a[0] + 0.005
    for g in r.regions:
        assert 0 <= g.score <= 1 and 0 < g.area < 0.2
        assert all(0.0 <= v <= 1.0 for v in (*g.bbox_a, *g.bbox_b))
    assert r.regions == sorted(r.regions, key=lambda g: -g.score)


@pytest.mark.l2_differential
def test_unchanged_pair_gives_no_regions(pdfs):
    """OS-INSP-3.4.2: та же редакция, отпечатанная со сдвигом и поворотом, — ноль областей изменений
    (остаток совмещения и сглаживание не считаются изменением)."""
    r = diff_pages(pdfs["A"], 1, pdfs["A_moved"], 1)
    assert r.status == "ok", r.reason
    assert r.regions == []
    same = diff_pages(pdfs["A"], 1, pdfs["A"], 1)
    assert same.status == "ok" and same.regions == []


# ─────────────────────────────── OS-INSP-3.4.4 несовместимые листы


@pytest.mark.l4_fault
def test_foreign_sheets_not_comparable(pdfs, tmp_path):
    """OS-INSP-3.4.4: чужой лист и пустой лист не совмещаются — not_comparable с причиной, без областей."""
    r = diff_pages(pdfs["A"], 1, pdfs["other"], 1)
    assert r.status == "not_comparable" and r.reason and r.regions == []
    from reportlab.pdfgen import canvas

    blank = tmp_path / "blank.pdf"
    c = canvas.Canvas(str(blank))
    c.showPage()
    c.save()
    r = diff_pages(pdfs["A"], 1, blank, 1)
    assert r.status == "not_comparable" and "мало" in r.reason


@pytest.mark.l6_adversarial
def test_degenerate_homography_rejected():
    """OS-INSP-3.4.4: зеркальная, сжатая в точку и перспективная гомографии — вырожденные."""
    import numpy as np

    from inspector_ml.sheetdiff import degenerate

    shape = (1000, 1400)
    assert degenerate(np.eye(3), shape, shape) is None
    assert "зеркаль" in degenerate(np.diag([-1.0, 1.0, 1.0]), shape, shape)
    assert "масштаб" in degenerate(np.diag([0.1, 0.1, 1.0]), shape, shape)
    assert "перспектив" in degenerate(
        np.array([[1, 0, 0], [0, 1, 0], [0.01, 0, 1.0]]), shape, shape
    )
    assert "растянут" in degenerate(np.diag([1.0, 0.5, 1.0]), shape, shape)


# ─────────────────────────────── эндпоинт /diff: только хранилище блобов


def diff_client(tmp_path, monkeypatch, files: list[Path]):
    import inspector_ml.app as app_mod

    blobs = tmp_path / "blobs"
    blobs.mkdir(exist_ok=True)
    shas = []
    for f in files:
        h = hashlib.sha256(f.read_bytes()).hexdigest()
        shutil.copy(f, blobs / h)
        shas.append(h)
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("INSPECTOR_BLOB_DIR", str(blobs))
    importlib.reload(app_mod)
    return TestClient(app_mod.app), shas


@pytest.mark.l1_functional
def test_diff_endpoint_by_sha_and_cached(pdfs, tmp_path, monkeypatch):
    """OS-INSP-3.4.2: POST /diff по sha256 и страницам → регионы; повтор — из кэша."""
    client, (sa, sb) = diff_client(tmp_path, monkeypatch, [pdfs["A"], pdfs["B"]])
    body = {"sha_a": sa, "page_a": 1, "sha_b": sb, "page_b": 1}
    r1 = client.post("/diff", json=body)
    assert r1.status_code == 200
    j = r1.json()
    assert j["status"] == "ok" and j["inliers"] > MIN_INLIERS and j["regions"]
    assert set(j["regions"][0]) == {"bbox_a", "bbox_b", "score", "area"}
    r2 = client.post("/diff", json=body)
    assert r2.json()["cached"] is True and r2.json()["regions"] == j["regions"]
    assert client.post("/diff", json={**body, "page_b": 9}).status_code == 422


@pytest.mark.l6_adversarial
def test_diff_rejects_paths_and_bad_hashes(pdfs, tmp_path, monkeypatch):
    """Защита /diff как у /analyze: путь вместо хеша, чужой хеш, подменённое содержимое, не-PDF."""
    xml = tmp_path / "x.xml"
    xml.write_text("<a>1</a>", encoding="utf-8")
    client, (sa, sx) = diff_client(tmp_path, monkeypatch, [pdfs["A"], xml])
    ok = {"sha_a": sa, "page_a": 1, "sha_b": sa, "page_b": 1}
    for bad in ("../../etc/passwd", "/etc/passwd", sa.upper(), sa[:-1], sa + "0"):
        assert client.post("/diff", json={**ok, "sha_b": bad}).status_code == 422
    assert client.post("/diff", json={**ok, "page_a": 0}).status_code == 422
    assert client.post("/diff", json={**ok, "sha_b": "0" * 64}).status_code == 404
    assert client.post("/diff", json={**ok, "sha_b": sx}).status_code == 415
    # содержимое блоба подменено — хеш не сходится
    forged = "f" * 64
    shutil.copy(pdfs["B"], tmp_path / "blobs" / forged)
    assert client.post("/diff", json={**ok, "sha_b": forged}).status_code == 409


@pytest.mark.l4_fault
def test_concurrent_diffs_do_not_crash(pdfs):
    """pdfium — только под PDFIUM_LOCK: параллельные диффы из пула потоков не роняют процесс."""
    out: list[str] = []
    errs: list[BaseException] = []

    def run():
        try:
            out.append(diff_pages(pdfs["A"], 1, pdfs["B"], 1).status)
        except BaseException as e:  # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=run) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errs and out == ["ok"] * 4


@pytest.mark.l7_discipline
@pytest.mark.performance
def test_diff_time_budget(pdfs):
    """Замер: дифф пары листов A4 при 150 dpi укладывается в 5 с на CPU (профиль dev)."""
    t0 = time.monotonic()
    r = diff_pages(pdfs["A"], 1, pdfs["B"], 1)
    dt = time.monotonic() - t0
    print(
        f"\nдифф пары листов: {dt * 1000:.0f} мс, инлайеров {r.inliers}, областей {len(r.regions)}"
    )
    assert dt < 5.0
