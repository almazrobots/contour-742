"""Прогон конвейера на реальном корпусе отладки (T-061) — только локально, по одному файлу, потоком.

Правовой режим корпуса (README corpus-ABC, ADR-0002): можно отлаживать парсер, OCR и детектор локально и
публиковать обезличенную статистику; нельзя класть в репозиторий файлы, тексты, фикстуры, показывать в демо.
Поэтому:
- файл приходит через `rclone cat` во временный каталог var/corpus-tmp и удаляется сразу после разбора;
- в var/corpus-run.json (вне git) пишутся только метаданные разбора и коды извлечённых параметров Матрицы —
  без текста и значений; имя файла хранится только для продолжения прогона и в сводку не попадает;
- сводка для репозитория (--md) — только числа по форматам, видам документов и параметрам.

Использование: python -m eval.corpus_run --limit 10  (правило №0: сначала 10 файлов, замер, потом остальное)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
from collections import Counter
from pathlib import Path

from inspector_ml.doctype import classify
from inspector_ml.reread import extract_refined
from inspector_ml.parse import parse_file
from inspector_ml.paths import repo_root

from .run import load_matrix, specs

REMOTE = "yandex:2026.09 ЛЦТ НАДЗОРИУМ/corpus-ABC"
ROOT = repo_root()
TMP = ROOT / "var/corpus-tmp"
OUT = ROOT / "var/corpus-run.json"
FORMATS = {"pdf", "docx", "xml", "xlsx", "jpg", "jpeg", "png", "tif", "tiff", "xls"}


def listing() -> list[tuple[int, str]]:
    out = subprocess.run(
        ["rclone", "lsf", "-R", "--files-only", "--format", "sp", REMOTE],
        capture_output=True,
        text=True,
        timeout=300,
        check=True,
    ).stdout
    rows = []
    for line in out.splitlines():
        size, _, path = line.partition(";")
        if path.rsplit(".", 1)[-1].lower() in FORMATS:
            rows.append((int(size), path))
    return sorted(rows)  # от маленьких к большим: первые файлы — дешёвый замер


def process(path: str, all_specs) -> dict:
    ext = path.rsplit(".", 1)[-1].lower()
    TMP.mkdir(parents=True, exist_ok=True)
    local = TMP / (hashlib.sha256(path.encode()).hexdigest()[:16] + "." + ext)
    rec: dict = {"path": path, "format": ext}
    t0 = time.perf_counter()
    try:
        with open(local, "wb") as f:
            subprocess.run(
                ["rclone", "cat", f"{REMOTE}/{path}"], stdout=f, check=True, timeout=900
            )
        rec["bytes"] = local.stat().st_size
        sha = hashlib.sha256(local.read_bytes()).hexdigest()
        t1 = time.perf_counter()
        doc = parse_file(local, sha)
        rec["parse_s"] = round(time.perf_counter() - t1, 2)
        rec["pages"] = len(doc.pages)
        rec["sources"] = dict(Counter(p.source for p in doc.pages))
        rec["quality"] = dict(Counter(p.quality for p in doc.pages))
        t2 = time.perf_counter()
        ex = extract_refined(local, doc, all_specs)  # как в сервисе: с перечитыванием значений OCR
        rec["extract_s"] = round(time.perf_counter() - t2, 2)
        rec["params"] = sorted({e.code for e in ex})
        rec["params_ocr"] = (
            sorted({e.code for e in ex if doc.pages[e.page - 1].source == "ocr"})
            if doc.pages
            else []
        )
        rec["doc_type"] = classify(doc).kind
        rec["requisites"] = dict(
            Counter(r.kind for p in doc.pages for r in p.requisites)
        )
        rec["status"] = "ok"
    except subprocess.TimeoutExpired:
        rec["status"] = "timeout"
    except Exception as e:  # noqa: BLE001 — сбой разбора — это данные прогона, а не остановка
        rec["status"] = "error"
        rec["error"] = type(e).__name__
    finally:
        local.unlink(missing_ok=True)
    rec["total_s"] = round(time.perf_counter() - t0, 2)
    return rec


def run(limit: int | None) -> list[dict]:
    done = json.loads(OUT.read_text("utf-8")) if OUT.exists() else []
    seen = {r["path"] for r in done}
    all_specs = specs(load_matrix())
    todo = [p for _, p in listing() if p not in seen][:limit]
    for i, path in enumerate(todo, 1):
        rec = process(path, all_specs)
        done.append(rec)
        OUT.write_text(
            json.dumps(done, ensure_ascii=False, indent=1), "utf-8"
        )  # после каждого файла: прогон продолжаемый
        print(
            f"[{i}/{len(todo)}] {rec['format']} {rec.get('pages', '-')} стр. {rec['status']} {rec['total_s']} с, параметров {len(rec.get('params', []))}"
        )
    return done


def summary_md(done: list[dict]) -> str:
    ok = [r for r in done if r["status"] == "ok"]
    matrix = load_matrix()
    by_param = Counter(c for r in ok for c in r["params"])
    pages = sum(r["pages"] for r in ok)
    ocr = sum(r["sources"].get("ocr", 0) for r in ok)
    low = sum(
        r["quality"].get("LOW_QUALITY", 0) + r["quality"].get("ABSTAIN", 0) for r in ok
    )
    L = [
        "## Прогон конвейера на корпусе отладки (обезличенно)",
        "",
        f"Файлов обработано: {len(done)} из них успешно {len(ok)}; ошибок {sum(r['status'] == 'error' for r in done)}, тайм-аутов {sum(r['status'] == 'timeout' for r in done)}.",
        f"Страниц: {pages}, из них через OCR {ocr}; низкого качества или без ответа OCR — {low}.",
        f"Время разбора: всего {sum(r.get('total_s', 0) for r in done) / 60:.1f} мин.",
        "",
        "| Формат | Файлов | Успешно | Страниц | Файлов с ≥ 1 параметром |",
        "|---|---|---|---|---|",
    ]
    for fmt in sorted({r["format"] for r in done}):
        rs = [r for r in done if r["format"] == fmt]
        oks = [r for r in rs if r["status"] == "ok"]
        L.append(
            f"| {fmt} | {len(rs)} | {len(oks)} | {sum(r['pages'] for r in oks)} | {sum(bool(r['params']) for r in oks)} |"
        )
    L += ["", "| Вид документа | Файлов |", "|---|---|"]
    for k, n in Counter(r["doc_type"] for r in ok).most_common():
        L.append(f"| {k} | {n} |")
    L += [
        "",
        f"Параметров Матрицы, найденных хотя бы в одном файле: **{len(by_param)} из {len(matrix)}**.",
        "",
        "| Параметр | Наименование | Файлов |",
        "|---|---|---|",
    ]
    for code, n in by_param.most_common():
        L.append(f"| {code} | {matrix[code]['parameter_name']} | {n} |")
    L += [
        "",
        "Ошибки разбора по типам: "
        + (
            ", ".join(
                f"{k} — {n}"
                for k, n in Counter(
                    r.get("error") for r in done if r["status"] == "error"
                ).items()
            )
            or "нет"
        ),
    ]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Прогон на корпусе отладки (локально, T-061)"
    )
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument(
        "--md", type=Path, default=None, help="куда записать обезличенную сводку"
    )
    a = ap.parse_args()
    t = time.perf_counter()
    done = run(a.limit)
    print(
        f"готово за {time.perf_counter() - t:.1f} с; всего в журнале {len(done)} файлов"
    )
    if a.md:
        a.md.write_text(summary_md(done), "utf-8")


if __name__ == "__main__":
    main()
