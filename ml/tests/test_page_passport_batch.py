"""T-216: индексация корпуса паспортом — синтетический каталог и blobs во временном каталоге (ADR-0002)."""

from __future__ import annotations

import hashlib
import json

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from inspector_ml import page_passport_batch as b


def _pdf(path, text: bool):
    c = canvas.Canvas(str(path), pagesize=A4)
    if text:
        c.drawString(60, 760, "Stroka teksta dlya passporta stranicy, dlinnee tridcati simvolov")
    c.showPage()
    c.save()
    return path.read_bytes()


@pytest.mark.l1_functional
def test_batch_indexes_catalog_resumes_and_outputs_only_aggregates(tmp_path, capsys):
    blobs, cat, out = tmp_path / "blobs", tmp_path / "cat", tmp_path / "out"
    blobs.mkdir(), cat.mkdir()
    rows = []
    for i, text in enumerate([True, False]):
        data = _pdf(tmp_path / f"s{i}.pdf", text)
        sha = hashlib.sha256(data).hexdigest()
        (blobs / sha).write_bytes(data)
        rows.append({"archive": f"1{i}_Секретный_адрес.tar", "path": f"Секретный адрес/Док {i}.pdf", "sha256": sha, "ext": ".pdf"})
    bad = "f" * 64
    (blobs / bad).write_bytes(b"not a pdf")
    rows += [{"archive": "10_x.tar", "sha256": bad, "ext": ".pdf"}, {"archive": "10_x.tar", "sha256": "a" * 64, "ext": ".dwg"},
             {"archive": "10_x.tar", "sha256": rows[0]["sha256"], "ext": ".PDF"}, {"mark": "x"}]
    (cat / "c.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\nне json\n", "utf-8")

    assert b.main(["--catalog", str(cat), "--blobs", str(blobs), "--out-dir", str(out), "--workers", "2"]) == 0
    s = json.loads(capsys.readouterr().out)
    assert s["total"]["files"] == 3 and s["total"]["errors"] == 1 and s["total"]["pages"] == 2
    assert s["total"]["classes"] == {"TEXT": 1, "BLANK": 1} and set(s["by_archive"]) == {"10", "11"}
    assert s["run"]["files_new"] == 3 and len(list(out.glob("passport-*.json"))) == 3
    txt = json.dumps(s, ensure_ascii=False)
    assert "Секретный" not in txt and "Док" not in txt and ".pdf" not in txt  # наружу только агрегаты
    # второй прогон — продолжение: ничего не пересчитывается, итог тот же
    assert b.main(["--catalog", str(cat), "--blobs", str(blobs), "--out-dir", str(out), "--limit", "3"]) == 0
    s2 = json.loads(capsys.readouterr().out)
    assert s2["run"]["files_new"] == 0 and s2["total"] == s["total"]


@pytest.mark.l3_boundary
def test_killed_file_marker_becomes_error_and_is_not_retried(tmp_path, capsys):
    blobs, cat, out = tmp_path / "blobs", tmp_path / "cat", tmp_path / "out"
    blobs.mkdir(), cat.mkdir(), out.mkdir()
    data = _pdf(tmp_path / "k.pdf", True)
    sha = hashlib.sha256(data).hexdigest()
    (blobs / sha).write_bytes(data)
    (cat / "c.jsonl").write_text(json.dumps({"archive": "12_x.tar", "sha256": sha, "ext": ".pdf"}), "utf-8")
    (out / f"passport-{sha}.json.suspect").write_text("123", "utf-8")  # упал и в одиночку — виновник
    assert b.main(["--catalog", str(cat), "--blobs", str(blobs), "--out-dir", str(out), "--workers", "1"]) == 0
    s = json.loads(capsys.readouterr().out)
    assert s["total"]["errors"] == 1 and s["total"]["pages"] == 0 and s["run"]["files_new"] == 0
    rec = json.loads((out / f"passport-{sha}.json").read_text("utf-8"))
    assert rec["error"] == "KILLED" and not (out / f"passport-{sha}.json.suspect").exists()


@pytest.mark.l3_boundary
def test_file_in_progress_when_pool_broke_is_retried_alone_not_killed(tmp_path, capsys):
    blobs, cat, out = tmp_path / "blobs", tmp_path / "cat", tmp_path / "out"
    blobs.mkdir(), cat.mkdir(), out.mkdir()
    data = _pdf(tmp_path / "r.pdf", True)
    sha = hashlib.sha256(data).hexdigest()
    (blobs / sha).write_bytes(data)
    (cat / "c.jsonl").write_text(json.dumps({"archive": "12_x.tar", "sha256": sha, "ext": ".pdf"}), "utf-8")
    (out / f"passport-{sha}.json.inprogress").write_text("123", "utf-8")  # пул сломался, пока файл был в работе
    assert b.main(["--catalog", str(cat), "--blobs", str(blobs), "--out-dir", str(out), "--workers", "2"]) == 0
    s = json.loads(capsys.readouterr().out)
    assert s["total"]["errors"] == 0 and s["total"]["pages"] == 1 and s["run"]["files_new"] == 1
    assert not list(out.glob("*.inprogress")) and not list(out.glob("*.suspect"))


@pytest.mark.l1_functional
def test_marker_removed_after_success(tmp_path, capsys):
    blobs, cat, out = tmp_path / "blobs", tmp_path / "cat", tmp_path / "out"
    blobs.mkdir(), cat.mkdir()
    data = _pdf(tmp_path / "m.pdf", True)
    sha = hashlib.sha256(data).hexdigest()
    (blobs / sha).write_bytes(data)
    (cat / "c.jsonl").write_text(json.dumps({"archive": "12_x.tar", "sha256": sha, "ext": ".pdf"}), "utf-8")
    assert b.main(["--catalog", str(cat), "--blobs", str(blobs), "--out-dir", str(out), "--workers", "1"]) == 0
    capsys.readouterr()
    assert not list(out.glob("*.inprogress")) and (out / f"passport-{sha}.json").exists()


@pytest.mark.l1_functional
def test_size_filters_split_catalog(tmp_path):
    cat = tmp_path / "cat"
    cat.mkdir()
    rows = [{"archive": "1_a.tar", "sha256": c * 64, "ext": ".pdf", "bytes": mb * 2**20} for c, mb in (("a", 1), ("b", 99), ("c", 100), ("d", 500))]
    (cat / "c.jsonl").write_text("\n".join(json.dumps(r) for r in rows), "utf-8")
    assert [s[0] for s, _ in b.catalog_pdfs(cat, max_mb=100)] == ["a", "b"]
    assert [s[0] for s, _ in b.catalog_pdfs(cat, min_mb=100)] == ["c", "d"]
    assert len(b.catalog_pdfs(cat)) == 4


@pytest.mark.l3_boundary
def test_crashed_retry_does_not_mark_unstarted_suspects_as_killed(tmp_path, monkeypatch, capsys):
    from concurrent.futures import Future
    from concurrent.futures.process import BrokenProcessPool

    blobs, cat, out = tmp_path / "blobs", tmp_path / "cat", tmp_path / "out"
    blobs.mkdir(), cat.mkdir(), out.mkdir()
    rows = []
    for i, text in enumerate([True, False]):
        data = _pdf(tmp_path / f"retry{i}.pdf", text)
        sha = hashlib.sha256(data).hexdigest()
        (blobs / sha).write_bytes(data)
        rows.append({"archive": "12_x.tar", "sha256": sha, "ext": ".pdf"})
        (out / f"passport-{sha}.json.inprogress").write_text("123")
    (cat / "c.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    args = ["--catalog", str(cat), "--blobs", str(blobs), "--out-dir", str(out)]

    class CrashingPool:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def submit(self, *args):
            f = Future()
            f.set_exception(BrokenProcessPool())
            return f

    with monkeypatch.context() as m:
        m.setattr(b, "ProcessPoolExecutor", CrashingPool)
        assert b.main(args) == 3
    first, second = (out / f"passport-{r['sha256']}.json" for r in rows)
    assert first.with_name(first.name + ".suspect").exists()
    assert second.with_name(second.name + ".inprogress").exists()
    assert not second.with_name(second.name + ".suspect").exists()
    assert b.main(args) == 0
    assert json.loads(first.read_text())["error"] == "KILLED"
    assert json.loads(second.read_text())["error"] is None
    capsys.readouterr()
