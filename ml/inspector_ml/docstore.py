"""Разобранный документ по хешу — один кэш на сервис разбора и этапы конвейера (T-130).

Этап parse (python -m inspector_ml.stages parse) разбирает файлы заранее, отдельным процессом и на эффективных ядрах;
сервис разбора (app.analyze) и этапы-читатели берут готовый ParsedDoc из того же кэша, а не разбирают файл заново.
Версия разборщика — в ключе: исправленный разбор не маскируется старым кэшем (OS-INSP-2.1.3, 2.1.12).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .cache import Cache
from .filehash import sha256_file
from .model import ParsedDoc
from .parse import UnsupportedFormat, detect_kind, parse_file, parse_pdf_part, pdf_pages, take_passports

# Ревизия разбора в ключе кэша: смена разборщика (ансамбль OCR, реквизиты) не отдаёт старые ответы.
PARSER_REV = 6  # 3: строки без «засасывания» соседних высоким словом штампа (group_rows, T-129); 4: переносы U+FFFE склеиваются;
# 6: проверка полноты и происхождения whole/part checkpoints (T-236).
# 5: OCR сканов профиля gpu — PP-OCRv5 на видеокарте + читатель VL, повёрнутые сканы (T-184)

SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class BlobMissing(LookupError):
    pass


class BlobMismatch(ValueError):
    pass


def parsed_key(sha: str) -> str:
    from .ocr_gpu import ocr_tag

    return f"parsed-{sha}-r{PARSER_REV}{ocr_tag()}"


def blob_path(blobs: Path, sha: str) -> Path:
    """Файл хранилища по SHA-256. Путь снаружи не принимается (path traversal): имя — только хеш, файл лежит прямо в
    каталоге хранилища, содержимое совпадает с хешем."""
    if not SHA_RE.match(sha):
        raise BlobMissing("sha256: ждём 64 hex-символа")
    path = (blobs / sha).resolve()
    if path.parent != blobs.resolve() or not path.is_file():
        raise BlobMissing("файл не найден в хранилище")
    if (
        sha256_file(path) != sha
    ):  # потоком: том ИД не читается в память ради сверки (T-169)
        raise BlobMismatch("SHA-256 файла не совпадает с заявленным")
    return path


def part_key(sha: str, first: int, last: int) -> str:
    return f"{parsed_key(sha)}-p{first}-{last}"


class InvalidCheckpoint(ValueError):
    """Кэш существует, но его нельзя использовать как доказательство разбора."""


def _read_checkpoint(
    cache: Cache,
    key: str,
    sha: str,
    kind: str,
    first: int = 0,
    last: int | None = None,
) -> ParsedDoc | None:
    hit = cache.get(key)
    if hit is None:
        return None
    return _validate_checkpoint(hit, sha, kind, first, last)


def _validate_checkpoint(
    hit: str, sha: str, kind: str, first: int = 0, last: int | None = None
) -> ParsedDoc:
    try:
        doc = ParsedDoc.model_validate_json(hit, strict=True)
    except ValueError as exc:
        raise InvalidCheckpoint("повреждённый checkpoint разбора") from exc
    if doc.sha256 != sha or doc.kind != kind:
        raise InvalidCheckpoint("SHA-256 или тип checkpoint не совпадает с источником")
    if last is not None and (
        len(doc.pages) != last - first
        or any(p.page != number for number, p in enumerate(doc.pages, first + 1))
    ):
        raise InvalidCheckpoint("checkpoint не содержит точный диапазон страниц")
    return doc


def cached_parsed(cache: Cache, path: Path, sha: str) -> ParsedDoc | None:
    """Whole cache проверяется и на быстрых путях, включая /parse/pages.

    Источник в HTTP-маршрутах уже проверен через _blob по SHA. Здесь число
    страниц берётся из самого PDF под PDFIUM_LOCK, а не из запроса/кэша.
    """
    key = parsed_key(sha)
    hit = cache.get(key)
    if hit is None:
        return None
    kind = detect_kind(path)
    return _validate_checkpoint(
        hit, sha, kind, last=pdf_pages(path) if kind == "pdf" else None
    )


def _pdf_count(path: Path) -> int:
    if detect_kind(path) != "pdf":
        raise UnsupportedFormat("разбор по частям поддерживает только PDF")
    return pdf_pages(path)


def _valid_range(first: int, last: int, count: int) -> bool:
    return type(first) is int and type(last) is int and 0 <= first < last <= count


def parse_part(
    cache: Cache, path: Path, sha: str, first: int, last: int
) -> tuple[ParsedDoc, bool]:
    """Часть [first,last); одинаковые проверки при холодном и тёплом кэше."""
    count = _pdf_count(path)
    if not _valid_range(first, last, count):
        raise ValueError(f"диапазон [{first}, {last}) вне PDF из {count} страниц")
    whole = _read_checkpoint(cache, parsed_key(sha), sha, "pdf", last=count)
    if whole is not None:
        return whole.model_copy(update={"pages": whole.pages[first:last]}), True
    key = part_key(sha, first, last)
    hit = _read_checkpoint(cache, key, sha, "pdf", first, last)
    if hit is not None:
        return hit, True
    doc = parse_pdf_part(path, sha, first, last)
    cache.set(key, doc.model_dump_json())
    pp = take_passports(sha)
    if pp is not None:  # T-216: паспорт части — отдельным файлом рядом, иначе он оседал бы в памяти процесса
        cache.set(
            f"{passport_key(sha)}-{first}-{last}",
            json.dumps({"sha256": sha, "first": first, "last": last, "pages": pp}, ensure_ascii=False),
        )
    return doc, False


class PartMissing(LookupError):
    pass


def assemble_parts(
    cache: Cache, path: Path, sha: str, ranges: list[tuple[int, int]]
) -> ParsedDoc:
    """Публикация whole key только для полного проверенного PDF (T-236)."""
    count = _pdf_count(path)
    ranges = sorted(ranges)
    if (
        not ranges
        or any(not _valid_range(first, last, count) for first, last in ranges)
        or ranges[0][0] != 0
        or ranges[-1][1] != count
        or any(a[1] != b[0] for a, b in zip(ranges, ranges[1:]))
    ):
        raise ValueError(f"части не покрывают PDF из {count} страниц ровно один раз")
    whole = _read_checkpoint(cache, parsed_key(sha), sha, "pdf", last=count)
    if whole is not None:
        return whole
    parts = []
    for first, last in ranges:
        part = _read_checkpoint(cache, part_key(sha, first, last), sha, "pdf", first, last)
        if part is None:
            raise PartMissing(f"нет части [{first}, {last}) в кэше")
        parts.append(part)
    engines = {e for d in parts for e in d.engine.split("+") if e}
    doc = ParsedDoc(
        sha256=sha,
        kind="pdf",
        pages=[p for d in parts for p in d.pages],
        engine="+".join(sorted(engines)),
    )
    cache.set(parsed_key(sha), doc.model_dump_json())
    return doc


def load_parsed(cache: Cache, path: Path, sha: str) -> tuple[ParsedDoc, bool]:
    """(документ, взят ли из кэша). Разбор — parse_file; исключения разбора (UnsupportedFormat, CorruptedFile) — наружу."""
    key = parsed_key(sha)
    hit = cached_parsed(cache, path, sha)
    if hit is not None:
        return hit, True
    doc = parse_file(path, sha)
    cache.set(key, doc.model_dump_json())
    pp = take_passports(sha)
    if (
        pp is not None
    ):  # T-216: паспорт — отдельный файл кэша рядом с разбором, только числа и коды
        cache.set(
            passport_key(sha),
            json.dumps({"sha256": sha, "pages": pp}, ensure_ascii=False),
        )
    return doc, False


def passport_key(sha: str) -> str:
    return f"passport-{sha}"
