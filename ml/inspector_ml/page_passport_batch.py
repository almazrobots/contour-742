"""Паспорт страниц по всему корпусу на сервере (T-216): индексация до OCR, только CPU, продолжает с места остановки.

Вход — каталог корпуса (`*.jsonl`: sha256, ext, archive) и файлы по sha в каталоге blobs. На каждый PDF — файл
`passport-<sha>.json` в --out-dir: {sha256, pages: [паспорт], ms, error}. Наружу (stdout, --summary) — только агрегаты
по номеру архива: страницы, классы, маршруты, форматы, время. Имён файлов, путей и текста документа в выводе нет (ADR-0002).

    python -m inspector_ml.page_passport_batch --catalog /opt/corpus/catalog --blobs /opt/corpus/blobs \\
        --out-dir /opt/inspector/passport --workers 4 [--limit 10] [--summary sum.json]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

from .page_passport import passport_file

SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def catalog_pdfs(
    catalog: Path, min_mb: float = 0.0, max_mb: float = 0.0
) -> list[tuple[str, str]]:
    """(sha256, код архива) всех PDF каталога без повторов; код — число в начале имени архива («14_…» → «14»)."""
    seen: dict[str, str] = {}
    for f in sorted(catalog.glob("*.jsonl")):
        for line in f.read_text("utf-8").splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            sha = d.get("sha256") or ""
            if (
                (d.get("ext") or "").lower() != ".pdf"
                or not SHA_RE.match(sha)
                or sha in seen
            ):
                continue
            mb = (
                d.get("bytes") or 0
            ) / 2**20  # крупные тома — отдельным проходом в один процесс (память)
            if mb < min_mb or (max_mb and mb >= max_mb):
                continue
            m = re.match(r"(\d+)", d.get("archive") or "")
            seen[sha] = m.group(1) if m else "?"
    return list(seen.items())


def out_path(out_dir: Path, sha: str) -> Path:
    return out_dir / f"passport-{sha}.json"


def _write(out: str, rec: dict) -> None:
    tmp = f"{out}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False)
    os.replace(tmp, out)


def one(sha: str, blob: str, out: str) -> dict:
    """Паспорт одного файла, запись атомарно (tmp → rename). Сбой разбора — запись с error, а не падение прогона.
    Метка «в работе» (out.inprogress) остаётся, если процесс убит (OOM в группе памяти): при продолжении такой файл
    повторяется в отдельном процессе; KILLED записывается только после сбоя этой отдельной попытки."""
    mark = f"{out}.inprogress"
    with open(mark, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))
    t0 = time.perf_counter()
    try:
        pages, error = passport_file(Path(blob)), None
    except Exception as e:  # noqa: BLE001 — битый или необычный PDF не должен ронять индексацию корпуса
        pages, error = [], type(e).__name__
    rec = {
        "sha256": sha,
        "pages": pages,
        "ms": round((time.perf_counter() - t0) * 1000, 1),
        "error": error,
    }
    _write(out, rec)
    os.remove(mark)
    return rec


def aggregate(recs: list[tuple[str, dict]]) -> dict:
    """Агрегаты по коду архива и всего: только числа и коды."""

    def block(items: list[dict]) -> dict:
        pages = [p for r in items for p in r["pages"]]
        return {
            "files": len(items),
            "errors": sum(1 for r in items if r["error"]),
            "pages": len(pages),
            "classes": dict(Counter(p["page_class"] for p in pages)),
            "routes": dict(Counter(p["route"] for p in pages)),
            "formats": dict(Counter(p["format"] for p in pages)),
            "ms_files": round(sum(r["ms"] for r in items), 1),
        }

    by: dict[str, list[dict]] = {}
    for code, r in recs:
        by.setdefault(code, []).append(r)
    return {
        "total": block([r for _, r in recs]),
        "by_archive": {k: block(v) for k, v in sorted(by.items())},
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m inspector_ml.page_passport_batch",
        description="Паспорт страниц по корпусу (T-216)",
    )
    ap.add_argument("--catalog", type=Path, required=True)
    ap.add_argument("--blobs", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument(
        "--limit", type=int, default=0, help="не больше N файлов (первый прогон — 10)"
    )
    ap.add_argument("--summary", type=Path, default=None)
    ap.add_argument(
        "--min-mb", type=float, default=0.0, help="только файлы не меньше N МБ"
    )
    ap.add_argument(
        "--max-mb",
        type=float,
        default=0.0,
        help="только файлы меньше N МБ (0 — без предела)",
    )
    a = ap.parse_args(argv)
    a.out_dir.mkdir(parents=True, exist_ok=True)
    todo = catalog_pdfs(a.catalog, a.min_mb, a.max_mb)
    if a.limit:
        todo = todo[: a.limit]
    t0 = time.perf_counter()
    recs: list[tuple[str, dict]] = []
    fresh = 0
    suspects: list[tuple[str, str]] = []
    with ProcessPoolExecutor(max_workers=max(1, a.workers)) as ex:
        futs = {}
        for sha, code in todo:
            o = out_path(a.out_dir, sha)
            if o.exists():  # продолжение с места остановки
                recs.append((code, json.loads(o.read_text("utf-8"))))
                continue
            if Path(
                f"{o}.suspect"
            ).exists():  # упал и в одиночку — виновник OOM, больше не брать
                rec = {"sha256": sha, "pages": [], "ms": 0.0, "error": "KILLED"}
                _write(str(o), rec)
                os.remove(f"{o}.suspect")
                recs.append((code, rec))
                continue
            if Path(
                f"{o}.inprogress"
            ).exists():  # был в обработке, когда пул сломался, — повторить в одиночку
                suspects.append((sha, code))
                continue
            futs[ex.submit(one, sha, str(a.blobs / sha), str(o))] = code
        for i, f in enumerate(as_completed(futs), 1):
            try:
                recs.append((futs[f], f.result()))
            except BrokenProcessPool:  # процесс убит (OOM): метки останутся, следующий запуск повторит их в одиночку
                print(
                    "broken pool: процесс убит, продолжите запуск",
                    file=sys.stderr,
                    flush=True,
                )
                return 3
            fresh += 1
            if i % 200 == 0:
                print(
                    f"progress {i}/{len(futs)} {round(time.perf_counter() - t0)} s",
                    file=sys.stderr,
                    flush=True,
                )
    for (
        sha,
        code,
    ) in (
        suspects
    ):  # каждый подозреваемый — в своём процессе: виновник убьёт только себя
        o = out_path(a.out_dir, sha)
        with ProcessPoolExecutor(max_workers=1) as ex1:
            os.replace(f"{o}.inprogress", f"{o}.suspect")
            try:
                rec = ex1.submit(one, sha, str(a.blobs / sha), str(o)).result()
            except BrokenProcessPool:
                print(
                    "broken pool на подозреваемом: продолжите запуск",
                    file=sys.stderr,
                    flush=True,
                )
                return 3
        os.remove(f"{o}.suspect")
        recs.append((code, rec))
        fresh += 1
    s = aggregate(recs)
    s["run"] = {
        "files_new": fresh,
        "files_total": len(todo),
        "wall_s": round(time.perf_counter() - t0, 1),
        "workers": a.workers,
    }
    text = json.dumps(s, ensure_ascii=False)
    if a.summary:
        a.summary.write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
