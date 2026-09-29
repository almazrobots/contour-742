"""OS-INSP-1.2.40 (T-169): большой PDF разбирается постранично, целиком в память ML не читается.

Чтение файла целиком здесь запрещено подменой ``Path.read_bytes``: сверка хеша хранилища, определение формата и
разбор PDF обязаны пройти без него. pdfium получает путь (FPDF_LoadDocument читает страницы с диска по требованию),
а не байты. Документы — синтетические (ADR-0002).
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen import canvas

from inspector_ml import parse as parse_mod
from inspector_ml.docstore import BlobMismatch, BlobMissing, blob_path
from inspector_ml.filehash import CHUNK, read_head, sha256_file
from inspector_ml.parse import detect_kind, parse_file

pytestmark = [pytest.mark.l1_functional, pytest.mark.l3_boundary, pytest.mark.l6_adversarial]


@pytest.fixture
def no_whole_read(monkeypatch):
    """Любая попытка прочитать файл целиком — провал теста."""

    def boom(self):  # noqa: ARG001
        raise AssertionError(f"файл прочитан целиком: {self}")

    monkeypatch.setattr(Path, "read_bytes", boom)


def synth_pdf(path: Path, pages: int) -> Path:
    c = canvas.Canvas(str(path))
    for i in range(pages):
        c.drawString(72, 720, f"Synthetic ID volume, sheet {i + 1}: fire hazard class C0")  # базовый шрифт reportlab — без кириллицы
        c.showPage()
    c.save()
    return path


def test_sha256_file_как_у_hashlib_на_границах_куска(tmp_path):
    for size in (0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 7):
        p = tmp_path / f"f{size}"
        data = bytes(i % 251 for i in range(size))
        p.write_bytes(data)
        assert sha256_file(p) == hashlib.sha256(data).hexdigest()
        assert sha256_file(p, chunk=7) == hashlib.sha256(data).hexdigest()


def test_read_head_первые_n_байт_или_весь_короткий_файл(tmp_path):
    p = tmp_path / "h"
    p.write_bytes(b"%PDF-1.7 abc")
    assert read_head(p, 5) == b"%PDF-"
    assert read_head(p, 100) == b"%PDF-1.7 abc"
    assert read_head(p, 0) == b""


def test_blob_path_сверяет_хеш_без_чтения_целиком(tmp_path, no_whole_read):
    data = b"%PDF-1.7\n" + b"x" * (3 * CHUNK) + b"\n%%EOF\n"
    sha = hashlib.sha256(data).hexdigest()
    with open(tmp_path / sha, "wb") as f:
        f.write(data)
    assert blob_path(tmp_path, sha) == (tmp_path / sha).resolve()


def test_blob_path_чужое_содержимое_и_нет_файла(tmp_path, no_whole_read):
    sha = "a" * 64
    with open(tmp_path / sha, "wb") as f:
        f.write("%PDF-1.7 подмена".encode())
    with pytest.raises(BlobMismatch):
        blob_path(tmp_path, sha)
    with pytest.raises(BlobMissing):
        blob_path(tmp_path, "b" * 64)
    with pytest.raises(BlobMissing):
        blob_path(tmp_path, "../" + "a" * 61)


def test_detect_kind_по_сигнатуре_без_чтения_целиком(tmp_path, no_whole_read):
    p = synth_pdf(tmp_path / "a.pdf", 1)
    assert detect_kind(p) == "pdf"


def test_большой_pdf_разбирается_постранично_по_пути(tmp_path, monkeypatch, no_whole_read):
    p = synth_pdf(tmp_path / "том.pdf", 12)
    sha = sha256_file(p)
    seen: list[type] = []
    real = pdfium.PdfDocument

    def spy(input, *a, **kw):  # noqa: A002
        seen.append(type(input))
        return real(input, *a, **kw)

    monkeypatch.setattr(parse_mod.pdfium, "PdfDocument", spy)
    doc = parse_file(p, sha)
    assert [pg.page for pg in doc.pages] == list(range(1, 13))
    assert "sheet 12:" in " ".join(ln.text for ln in doc.pages[-1].lines)
    assert seen and all(t is str for t in seen)  # путь, а не bytes: pdfium читает страницы с диска по одной


def test_sha256_file_читает_кусками_не_больше_chunk(tmp_path, monkeypatch):
    """Мутант ``f.read(None)`` (весь файл за раз) выживал: хеш тот же. Здесь проверяется сам размер чтения."""
    from inspector_ml import filehash

    p = tmp_path / "x"
    p.write_bytes(b"a" * 100)
    sizes: list = []
    real_open = open

    class Spy:
        def __init__(self, f):
            self.f = f

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.f.close()

        def read(self, n=-1):
            sizes.append(n)
            return self.f.read(n)

    monkeypatch.setattr(filehash, "open", lambda *a, **k: Spy(real_open(*a, **k)), raising=False)
    assert sha256_file(p, chunk=7) == hashlib.sha256(b"a" * 100).hexdigest()
    assert len(sizes) == 16 and all(isinstance(n, int) and 0 < n <= 7 for n in sizes)
