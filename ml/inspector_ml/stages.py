"""Этапы конвейера на маке — по одной модели на процесс (T-130; OS-INSP-2.1.13, NFR-ML-HOST).

    python -m inspector_ml.stages parse   [--limit N]   разбор PDF (pdfium + ансамбль Tesseract) в кэш — только CPU
    python -m inspector_ml.stages reader  [--limit N]   читатель сканов PaddleOCR-VL по полосам листа → кэш прочтений
    python -m inspector_ml.stages reader2 [--limit N]   второй читатель GLM-OCR — только спорные места → кэш прочтений
    python -m inspector_ml.stages report                сводка: что разобрано и прочитано

Запускать через scripts/ml-host.sh stage … (замок heavy.sh, pid-файл для рубильника, окружение стенда). Судья Qwen3.5-9B —
не этап: он работает в сервисе разбора (app.analyze), когда API запускает обработку, и видит уже сведённые прочтения.
--limit N — число объектов этапа (файлов, страниц, кропов): правило №0 — сначала 10, замер, потом остальное.
Каждый объект — строка JSON в stdout: время, пик памяти MLX, RSS процесса. Уже прочитанное повторно не читается.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import time
from pathlib import Path

from . import memory, readers, vlm
from .cache import make_cache
from .class_mentions import extract_class_mentions
from .docstore import load_parsed
from .model import BBox, ParamSpec, ParsedDoc
from .parse import CorruptedFile, UnsupportedFormat, detect_kind
from .paths import repo_root

READ_TOKENS = (
    1024  # полоса листа — до ~30 строк текста; 512 токенов обрезали плотную полосу
)


def _env_path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name) or default)


def blobs_dir() -> Path:
    return _env_path("INSPECTOR_BLOB_DIR", repo_root() / "var/blobs").resolve()


def reader_cache() -> readers.ReaderCache:
    return readers.ReaderCache(
        _env_path("INSPECTOR_READER_CACHE", repo_root() / "var/reader-cache")
    )


def class_specs(root: Path | None = None) -> list[ParamSpec]:
    """Параметры-классы из паспортов (data/seed/passports) — так же, как их собирает API (passport.ts: extractorSpec)."""
    out = []
    base = root or repo_root() / "data/seed/passports"
    # шкалы классов — справочник (value.scale_ref, OS-INSP-3.1.30), как resolveScaleRef в API
    sf = base.parent / "scales.json"
    scales = json.loads(sf.read_text())["scales"] if sf.exists() else {}
    for f in sorted(base.glob("M-*.json")):
        pp = json.loads(f.read_text())
        ext = pp.get("extractor") or {}
        if ext.get("kind") != "class_mentions":
            continue
        val = pp.get("value") or {}
        sc = scales.get(val.get("scale_ref") or "") or {}
        aliases = {**(sc.get("aliases") or {}), **(val.get("aliases") or {})}
        out.append(
            ParamSpec(
                code=pp["code"],
                anchors=[],
                extractor={
                    **ext,
                    "scale": val.get("scale") or sc.get("values"),
                    "constraint_markers": val.get("constraint_markers"),
                    **({"aliases": aliases} if aliases else {}),
                    **({"alt_systems": val["alt_systems"]} if val.get("alt_systems") else {}),
                },
            )
        )
    return out


# --sha: только файлы с этими префиксами хеша (замер этапа на нужных документах, правило №0)
ONLY: tuple[str, ...] = ()


def pdf_blobs(blobs: Path) -> list[tuple[str, Path]]:
    out = []
    for p in sorted(blobs.iterdir()):
        if ONLY and not p.name.startswith(ONLY):
            continue
        if len(p.name) == 64 and p.is_file():
            try:
                if detect_kind(p) == "pdf":
                    out.append((p.name, p))
            except UnsupportedFormat:
                continue
    return out


def rss_now_gb() -> float | None:
    """Текущий RSS (Linux, /proc). rss_gb — ПИК процесса (ru_maxrss): он не падает, и рост «от файла к файлу» по нему
    не отличить от одного тяжёлого файла (T-230)."""
    try:
        with open("/proc/self/statm") as f:
            return round(int(f.read().split()[1]) * resource.getpagesize() / 1024**3, 2)
    except OSError:
        return None


def rss_gb() -> float:
    # ПИК RSS процесса. macOS: ru_maxrss в байтах (в Linux — в КБ)
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(r / (1024**3 if sys.platform == "darwin" else 1024**2), 2)


def emit(**kw) -> None:
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def _cache():
    return make_cache(
        os.environ.get("INSPECTOR_PROFILE", "dev"), repo_root() / "var/ml-cache"
    )


def cached_doc(cache, sha: str) -> ParsedDoc | None:
    from .docstore import cached_parsed

    return cached_parsed(cache, blobs_dir() / sha, sha)


def run_parse(limit: int | None) -> dict:
    cache, done, t_all = _cache(), 0, time.monotonic()
    for sha, path in pdf_blobs(blobs_dir()):
        if cached_doc(cache, sha) is not None:
            continue
        if limit is not None and done >= limit:
            break
        t0 = time.monotonic()
        try:
            doc, _ = load_parsed(cache, path, sha)
        except (CorruptedFile, UnsupportedFormat) as e:
            emit(stage="parse", sha=sha[:12], error=str(e)[:160])
            done += 1
            continue
        except Exception as e:  # сбой движка (память видеокарты, сервер модели): файл не в кэше — разберётся в повторе
            emit(
                stage="parse",
                sha=sha[:12],
                error=f"{type(e).__name__}: {e}"[:160],
                retry=True,
            )
            continue
        done += 1
        memory.release()  # между файлами пачки — память обратно системе (T-230)
        emit(
            stage="parse",
            sha=sha[:12],
            pages=len(doc.pages),
            scans=sum(p.source == "ocr" for p in doc.pages),
            sec=round(time.monotonic() - t0, 1),
            rss_gb=rss_gb(),
            rss_now_gb=rss_now_gb(),
        )
    return {"stage": "parse", "done": done, "sec": round(time.monotonic() - t_all, 1)}


def reader_targets(cache, specs: list[ParamSpec]) -> list[tuple[str, Path, int]]:
    """Страницы для читателя по всем разобранным PDF (OS-INSP-2.1.13). Страницы со следом оборота — первыми: они и есть
    цель читателя, а неуверенные страницы без следа — страховка от строки, которую ансамбль потерял целиком."""
    cfgs = [s.extractor or {} for s in specs]
    phrases = [p for p in (readers.trace_phrase(c) for c in cfgs) if p]
    out = []
    for sha, path in pdf_blobs(blobs_dir()):
        doc = cached_doc(cache, sha)
        if doc is None:
            continue
        for n in readers.reader_pages(doc, cfgs):
            traced = any(readers.has_trace(doc.pages[n - 1], ph) for ph in phrases)
            out.append((0 if traced else 1, sha, path, n))
    return [(sha, path, n) for _, sha, path, n in sorted(out, key=lambda t: t[0])]


def run_reader(limit: int | None) -> dict:
    cache, rc, specs = _cache(), reader_cache(), class_specs()
    todo = [
        t
        for t in reader_targets(cache, specs)
        if rc.get_page(t[0], t[2], vlm.READER) is None
    ]
    done, t_all = 0, time.monotonic()
    for sha, path, n in todo[: limit if limit is not None else None]:
        t0 = time.monotonic()
        img = vlm.render_page(path, n, dpi=readers.READ_DPI)
        if img is None:
            continue
        w, h = img.size
        bands = []
        for y0, y1 in readers.band_ranges():
            crop = img.crop((0, round(y0 * h), w, round(y1 * h)))
            bands.append(
                readers.Band(y0, y1, vlm.read_region(crop, max_tokens=READ_TOKENS))
            )
        ms = int((time.monotonic() - t0) * 1000)
        rc.put_page(sha, n, vlm.READER, bands, ms)
        done += 1
        emit(
            stage="reader",
            model=vlm.short_name(vlm.READER),
            sha=sha[:12],
            page=n,
            sec=round(ms / 1000, 1),
            peak_gb=vlm.peak_memory_gb(),
            rss_gb=rss_gb(),
            left=len(todo) - done,
        )
    return {
        "stage": "reader",
        "done": done,
        "todo_total": len(todo),
        "sec": round(time.monotonic() - t_all, 1),
    }


def reader2_targets(
    cache, rc: readers.ReaderCache, specs: list[ParamSpec]
) -> list[tuple[str, Path, int, BBox]]:
    """Спорные места для второго читателя: те же рамки, что спросит сервис разбора при сведении (merge_doc)."""
    out: list[tuple[str, Path, int, BBox]] = []
    for sha, path in pdf_blobs(blobs_dir()):
        doc = cached_doc(cache, sha)
        if doc is None:
            continue
        found = [e for s in specs for e in extract_class_mentions(doc, s)]
        asked: list[tuple[int, BBox]] = []

        def ask(n: int, box: BBox, sha=sha, asked=asked) -> str | None:
            hit = rc.get_crop(sha, n, box, vlm.READER2)
            if hit is None:
                asked.append((n, box))
            return hit

        readers.merge_doc(
            sha,
            doc,
            found,
            specs,
            rc,
            readers.Models("ансамбль", vlm.READER, vlm.READER2),
            crop_text=ask,
        )
        out += [(sha, path, n, box) for n, box in dict.fromkeys(asked)]
    return out


def run_reader2(limit: int | None) -> dict:
    cache, rc, specs = _cache(), reader_cache(), class_specs()
    todo = reader2_targets(cache, rc, specs)
    done, t_all = 0, time.monotonic()
    for sha, path, n, box in todo[: limit if limit is not None else None]:
        t0 = time.monotonic()
        img = vlm.render_page(path, n, dpi=readers.READ_DPI)
        if img is None:
            continue
        text = vlm.read_region(
            vlm.crop_box(img, box), second_opinion=True, max_tokens=READ_TOKENS
        )
        ms = int((time.monotonic() - t0) * 1000)
        rc.put_crop(sha, n, box, vlm.READER2, text, ms)
        done += 1
        emit(
            stage="reader2",
            model=vlm.short_name(vlm.READER2),
            sha=sha[:12],
            page=n,
            box=list(box),
            sec=round(ms / 1000, 1),
            peak_gb=vlm.peak_memory_gb(),
            rss_gb=rss_gb(),
            left=len(todo) - done,
        )
    return {
        "stage": "reader2",
        "done": done,
        "todo_total": len(todo),
        "sec": round(time.monotonic() - t_all, 1),
    }


def run_report() -> dict:
    cache, rc, specs = _cache(), reader_cache(), class_specs()
    pdfs = pdf_blobs(blobs_dir())
    parsed = [sha for sha, _ in pdfs if cached_doc(cache, sha) is not None]
    rt = reader_targets(cache, specs)
    read = [t for t in rt if rc.get_page(t[0], t[2], vlm.READER) is not None]
    r2 = reader2_targets(cache, rc, specs)
    return {
        "stage": "report",
        "pdf": len(pdfs),
        "parsed": len(parsed),
        "reader_pages": len(rt),
        "reader_done": len(read),
        "reader2_todo": len(r2),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="inspector_ml.stages",
        description="Этапы конвейера на маке — одна модель на процесс",
    )
    ap.add_argument("stage", choices=["parse", "reader", "reader2", "report"])
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="объектов этапа (правило №0: сначала 10)",
    )
    ap.add_argument(
        "--sha",
        action="append",
        default=[],
        help="только файлы с этим префиксом хеша (можно несколько)",
    )
    a = ap.parse_args(argv)
    global ONLY
    ONLY = tuple(a.sha)
    if a.stage in ("reader", "reader2") and not vlm.enabled():
        print(
            "этап читателя требует INSPECTOR_VLM_BACKEND=mlx (или openai)",
            file=sys.stderr,
        )
        return 2
    if a.stage == "parse":
        from .ocr_gpu import check_ready

        # OS-INSP-2.1.18: в профиле gpu недоступный движок OCR — ошибка до первого файла, а не тихий откат на CPU
        emit(
            stage="parse",
            ocr_engines=check_ready(os.environ.get("INSPECTOR_PROFILE", "dev")),
        )
    res = {"parse": run_parse, "reader": run_reader, "reader2": run_reader2}.get(
        a.stage
    )
    emit(
        **(res(a.limit) if res else run_report()),
        peak_gb=vlm.peak_memory_gb(),
        rss_gb=rss_gb(),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
