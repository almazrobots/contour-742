"""Замер W2 на корпусе раннера (eval.w2_corpus, T-190) — на синтетическом «корпусе» во временном каталоге.

Главный инвариант — правовой режим (ADR-0002, условия T-165): в агрегатах нет ни sha, ни пути, ни имени архива,
ни номера страницы; только коды объектов и числа.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from eval import w2_corpus


def _vector_pdf(path: Path, lines: int = 80) -> None:
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(842, 595))
    for i in range(lines):  # ≥ VECTOR_MIN_SEGMENTS отрезков — векторный лист
        c.line(40 + i * 9, 40, 40 + i * 9, 500)
    c.showPage()
    c.showPage()  # вторая страница пустая
    c.save()


def _corpus(tmp: Path) -> Path:
    import hashlib

    root = tmp / "corpus"
    (root / "catalog").mkdir(parents=True)
    (root / "blobs").mkdir()
    rows = []
    for i, (archive, ext) in enumerate(
        [
            ("10_Секретный_адрес_1.tar", ".pdf"),
            ("10_Секретный_адрес_1.tar", ".dwg"),
            ("РАЗМЕЧЕННЫЙ_TRAIN_PUBLIC_203.zip", ".pdf"),
            ("11_Другой_адрес.tar", ".pdf"),
        ]
    ):
        src = tmp / f"f{i}{ext}"
        if ext == ".pdf":
            _vector_pdf(src, lines=80 if i != 3 else 10)
        else:
            src.write_bytes(b"AC1032")
        sha = hashlib.sha256(src.read_bytes()).hexdigest()
        if i != 3:  # у последнего файла блоба нет — счётчик NoBlob
            (root / "blobs" / sha).write_bytes(src.read_bytes())
        rows.append(
            {
                "archive": archive,
                "path": f"секретная/папка/лист_{i}{ext}",
                "sha256": sha,
                "bytes": 100 + i,
                "ext": ext,
                "blob": f"corpus/x/blobs/{sha}",
            }
        )
    (root / "catalog" / "a.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    return root


def _fake_geom(path: Path, page: int) -> dict:
    return {
        "quality": {"status": "OK", "why": None},
        "scale": {"n": 100.0, "method": "stamp"},
        "frame": {"to_bld": [1, 0, 0, 0, 1, 0]},
        "walls": [{}, {}, {}],
        "openings": [{}],
    }


@pytest.mark.l1_functional
def test_object_code_hides_address():
    assert w2_corpus.object_code("10_Секретный_адрес.tar") == "10"
    assert w2_corpus.object_code("РАЗМЕЧЕННЫЙ_TRAIN_PUBLIC_203.zip") == "ORG-TRAIN"
    assert (
        w2_corpus.object_code("РАЗМЕЧЕННЫЙ_TEST_HIDDEN_ОРГАНИЗАТОР_213.zip")
        == "ORG-TEST"
    )
    assert w2_corpus.object_code("пакет.tar") == "OTHER"


@pytest.mark.l1_functional
def test_run_aggregates_kinds_and_geometry(tmp_path):
    root = _corpus(tmp_path)
    out = tmp_path / "eval"
    agg = w2_corpus.run(root / "catalog", root / "blobs", out, None, None, _fake_geom)
    assert agg["ALL"]["files"] == 3  # только PDF
    assert agg["ALL"]["file_errors"] == {"NoBlob": 1}
    assert agg["10"]["pages_by_kind"].get("vector") == 1
    assert agg["10"]["geom_sheets"] == 1 and agg["10"]["geom_ok_pct"] == 100.0
    assert agg["10"]["entities_per_ok_sheet"]["walls"] == 3.0
    assert agg["10"]["registered_pct"] == 100.0
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o700


@pytest.mark.l8_regression
def test_aggregate_never_leaks_paths_sha_or_names(tmp_path):
    root = _corpus(tmp_path)
    out = tmp_path / "eval"
    agg = w2_corpus.run(root / "catalog", root / "blobs", out, None, None, _fake_geom)
    text = json.dumps(agg, ensure_ascii=False) + (out / "aggregate.json").read_text(
        encoding="utf-8"
    )
    shas = [
        json.loads(line)["sha256"]
        for line in (root / "catalog" / "a.jsonl").read_text().splitlines()
    ]
    for secret in [
        "Секретный",
        "секретная",
        "лист_",
        "адрес",
        ".tar",
        ".zip",
        *shas,
        *(s[:12] for s in shas),
    ]:
        assert secret not in text
    assert '"page":' not in text  # номера страниц наружу не выходят


@pytest.mark.l1_functional
def test_resume_does_not_reprocess(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    out = tmp_path / "eval"
    w2_corpus.run(root / "catalog", root / "blobs", out, 1, None, None)
    calls = []
    real = w2_corpus.measure_file
    monkeypatch.setattr(
        w2_corpus, "measure_file", lambda p, g, *a: calls.append(p) or real(p, g, *a)
    )
    agg = w2_corpus.run(root / "catalog", root / "blobs", out, None, None, None)
    assert (
        len(calls) == 1
    )  # из двух блобов один уже разобран; третий PDF без блоба — без разбора
    assert agg["ALL"]["files"] == 3


@pytest.mark.l6_adversarial
def test_geometry_failure_is_counted_not_raised(tmp_path):
    root = _corpus(tmp_path)

    def broken(path: Path, page: int):
        raise ValueError("битый путь")

    agg = w2_corpus.run(
        root / "catalog", root / "blobs", tmp_path / "eval", None, {"10"}, broken
    )
    assert agg["10"]["geom_fail_why"] == {"ValueError": 1}
    assert agg["10"]["geom_ok_pct"] == 0.0


@pytest.mark.l6_adversarial
def test_corrupt_pdf_is_counted(tmp_path):
    root = _corpus(tmp_path)
    for b in (root / "blobs").iterdir():
        b.write_bytes(b"%PDF-1.5 broken")
    agg = w2_corpus.run(
        root / "catalog", root / "blobs", tmp_path / "eval", None, None, None
    )
    assert sum(agg["ALL"]["file_errors"].values()) == 3


@pytest.mark.l8_regression
def test_owasp_0188_free_text_from_geometry_never_reaches_aggregate(tmp_path):
    # ADR-0002: why и method — перечисления контракта ADR-0010; всё прочее (текст листа, сообщение исключения) — OTHER
    root = _corpus(tmp_path)

    def chatty(path: Path, page: int) -> dict:
        return {
            "quality": {"status": "NOT_COMPARABLE", "why": "нет оси «Секретный корпус 7»"},
            "scale": {"n": None, "method": "по штампу листа АР-12 ул. Секретная"},
        }

    agg = w2_corpus.run(root / "catalog", root / "blobs", tmp_path / "eval", None, {"10"}, chatty)
    assert agg["10"]["geom_fail_why"] == {"OTHER": 1}
    assert "Секрет" not in json.dumps(agg, ensure_ascii=False)


@pytest.mark.l1_functional
def test_owasp_0188_contract_values_pass_through(tmp_path):
    root = _corpus(tmp_path)

    def spread(path: Path, page: int) -> dict:
        return {"quality": {"status": "NOT_COMPARABLE", "why": "SCALE_SPREAD"}, "scale": {"n": None, "method": "both"}}

    agg = w2_corpus.run(root / "catalog", root / "blobs", tmp_path / "eval", None, {"10"}, spread)
    assert agg["10"]["geom_fail_why"] == {"SCALE_SPREAD": 1}
