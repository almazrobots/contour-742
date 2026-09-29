"""OS-INSP-2.4.7 (ТЗ §11, TZA-11-08): CV-анализ одного листа чертежа — не более 30 с.

Не уложился — NOT_COMPARABLE с причиной, без частичных измерений; время анализа листа — в ответе /measure.
Замер на листах A3–A0 (synth.bench_drawings) — L3 на железе гейта.
"""

from __future__ import annotations

import json

import pytest
from PIL import Image

from inspector_ml import measure as M


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


@pytest.mark.l1_functional
def test_deadline_raises_only_after_its_time():
    clock = FakeClock()
    d = M.Deadline(30, clock)
    clock.t = 29.999
    d.check()
    clock.t = 30.0  # ровно на пределе — уже поздно: следующий шаг вывел бы за 30 с
    with pytest.raises(M.CvTimeout, match="анализ листа дольше 30 с"):
        d.check()


@pytest.mark.l4_fault
def test_expired_deadline_stops_scale_and_distances():
    from test_measure import dim, sheet, walls

    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000")]
    walls(d, [300, 600])
    clock = FakeClock()
    dl = M.Deadline(1, clock)
    clock.t = 5
    with pytest.raises(M.CvTimeout):
        M.determine_scale(img, lines, deadline=dl)
    ok = M.determine_scale(img, lines)
    with pytest.raises(M.CvTimeout):
        M.distances(img, ok, deadline=dl)


@pytest.mark.l2_differential
def test_deadline_in_time_changes_nothing():
    from test_measure import dim, sheet, walls

    img, d = sheet()
    lines = [dim(d, 200, 1000, 1250, "6000")]
    walls(d, [300, 600, 900])
    a = M.determine_scale(img, lines)
    b = M.determine_scale(img, lines, deadline=M.Deadline(30))
    assert (a.status, a.mm_per_px, len(a.evidence)) == (
        b.status,
        b.mm_per_px,
        len(b.evidence),
    )
    assert M.distances(img, a) == M.distances(img, b, deadline=M.Deadline(30))


def _client(tmp_path, monkeypatch, fmt="A3"):
    from test_sheetdiff import diff_client

    from synth.bench_drawings import drawing

    p = tmp_path / f"sheet-{fmt}.pdf"
    drawing(fmt, p)
    return diff_client(tmp_path, monkeypatch, [p])


@pytest.mark.l1_functional
def test_measure_reports_time_and_no_reason_when_in_time(tmp_path, monkeypatch):
    client, (sha,) = _client(tmp_path, monkeypatch)
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert r["status"] == "OK" and r["reason"] is None and r["sheet_scale_gost"] == 100
    assert isinstance(r["ms"], int) and 0 <= r["ms"] < 30_000


@pytest.mark.l4_fault
def test_measure_over_limit_is_not_comparable_without_partial_results(
    tmp_path, monkeypatch, capsys
):
    client, (sha,) = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(M, "CV_SHEET_LIMIT_S", 0.0)  # любой анализ — дольше предела
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert (r["status"], r["method"], r["reason"]) == (
        "NOT_COMPARABLE",
        "timeout",
        "анализ листа дольше 0 с",
    )
    assert (
        r["distances"] == [] and r["dimension_lines"] == [] and r["mm_per_px"] is None
    )
    logs = [
        json.loads(x) for x in capsys.readouterr().out.splitlines() if x.startswith("{")
    ]
    assert any(
        x.get("message") == "cv_sheet_timeout"
        and x["page"] == 1
        and x["level"] == "WARNING"
        for x in logs
    )


@pytest.mark.l1_functional
def test_measure_takes_parsed_document_from_cache(tmp_path, monkeypatch):
    """Лист не заставляет разбирать весь документ заново: разбор берётся из кэша этапа parse."""
    import inspector_ml.docstore as D

    client, (sha,) = _client(tmp_path, monkeypatch)
    assert (
        client.post("/measure", json={"sha256": sha, "page": 1}).status_code == 200
    )  # первый — разбор и кэш

    def boom(*a, **k):
        raise AssertionError("повторный разбор документа")

    monkeypatch.setattr(D, "parse_file", boom)
    assert (
        client.post("/measure", json={"sha256": sha, "page": 1}).json()["status"]
        == "OK"
    )


@pytest.mark.l3_boundary
@pytest.mark.parametrize("fmt", ["A3", "A2", "A1", "A0"])
@pytest.mark.performance
def test_performance_sheet_within_30_s(tmp_path, monkeypatch, fmt):
    """TZA-11-08 на железе гейта: план 1:100 формата A3–A0 — CV-анализ листа ≤ 30 с."""
    client, (sha,) = _client(tmp_path, monkeypatch, fmt)
    r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
    assert r["method"] != "timeout" and r["ms"] <= 30_000, r["ms"]


@pytest.mark.l8_regression
def test_zero_length_segment_is_dropped_without_nan():
    """Регрессия (T-138, лист A0): уточнение давало отрезок нулевой длины — след чернил в один пиксель, — и второй
    проход делил на ноль: NaN в координатах и RuntimeWarning при приведении к int."""
    import warnings

    import numpy as np

    ink = np.zeros((50, 50), dtype=bool)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert M._refine(ink, M.Segment(10, 10, 10, 10)) is None
        dot = np.zeros((200, 200), dtype=bool)
        dot[100, 100] = True
        assert M._refine(dot, M.Segment(100, 100, 100, 100)) is None


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "fmt, want",
    [("A4", 150), ("A3", 150), ("A2", 150), ("A1", pytest.approx(124.5, abs=0.5)), ("A0", 100)],
)
def test_cv_dpi_150_under_12_mpx_but_not_below_100(fmt, want):
    """A0 при 88 dpi терял стены (46 из 82): пол 100 dpi; A1 — по потолку 12 Мпикс (T-138, замер A3–A0)."""
    w_mm, h_mm = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594), "A0": (1189, 841)}[fmt]
    assert M.cv_dpi(w_mm / 25.4 * 72, h_mm / 25.4 * 72) == want


@pytest.mark.l6_adversarial
def test_measure_rejects_non_sha_before_touching_storage(tmp_path, monkeypatch):
    """R2 T-138 (E1-L5): sha256 запроса /measure — строго 64 hex, как у /analyze; иначе 422 до обращения к хранилищу."""
    client, _ = _client(tmp_path, monkeypatch)
    for bad in ["../../etc/passwd", "A" * 64, "0" * 63]:
        assert client.post("/measure", json={"sha256": bad, "page": 1}).status_code == 422
