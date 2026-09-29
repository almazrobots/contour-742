"""Стенд §11 для ML-анализа параметра и CV-анализа листа (OS-INSP-6.5.17, TZA-11-07, TZA-11-08).

ML: 132 параметра Матрицы на текстовом документе 1, 100 и 500 страниц (40 строк на странице, 30 % строк — подписи
параметров с опечатками и значениями, остальное — связный текст ПЗ). Время каждого параметра — из самого
извлечения (timings, OS-INSP-2.2.34): лексический путь, доля общих шагов и перечитывания.
CV: план 1:100 форматов A3–A0 (synth.bench_drawings) через /measure — разбор, рендер, масштаб и расстояния,
как в сервисе (OS-INSP-2.4.7).

Только синтетика (ADR-0002). Запуск из ml/ (тяжёлое — через scripts/heavy.sh, правило №0):
    uv run python -m eval.bench_ml_cv [--pages 1,100,500] [--formats A3,A2,A1,A0] [--out ../var/bench-ml-cv.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import shutil
import statistics
import tempfile
import time
from pathlib import Path

ML_LIMIT_MS = 500  # ТЗ §11, TZA-11-07
CV_LIMIT_MS = 30_000  # ТЗ §11, TZA-11-08

FILLER = [
    "Проектной документацией предусмотрено устройство",
    "в соответствии с требованиями СП 54.13330.2022",
    "Наружные стены выполнены из керамического кирпича",
    "Лестничная клетка типа Л1 с естественным освещением",
    "Кровля плоская с внутренним организованным водостоком",
    "Фундамент — монолитная железобетонная плита",
]


def _typo(r: random.Random, s: str) -> str:
    """Опечатка OCR в подписи: пропуск, удвоение или замена одной буквы — так подписи выглядят на сканах."""
    if len(s) < 6 or r.random() < 0.5:
        return s
    i = r.randrange(1, len(s) - 1)
    return r.choice(
        [s[:i] + s[i + 1 :], s[:i] + s[i] + s[i:], s[:i] + "о" + s[i + 1 :]]
    )


def text_doc(n_pages: int, specs, seed: int = 1):
    from inspector_ml.model import Line, Page, ParsedDoc, Word

    r = random.Random(seed)
    anchors = [a for s in specs for a in s.anchors]
    pages = []
    for i in range(n_pages):
        lines = []
        for _ in range(40):
            if r.random() < 0.3:
                t = f"{_typo(r, r.choice(anchors))} {r.choice(['12 450,0', '9', 'B25', 'III', '3,2 м', 'С2.0'])}"
            else:
                t = " ".join(r.choice(FILLER) for _ in range(2))
            lines.append(Line(text=t, words=[Word(text=w) for w in t.split()]))
        pages.append(
            Page(page=i + 1, width=595, height=842, source="text", lines=lines)
        )
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="bench", pages=pages)


def _pct(xs: list[float], q: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def bench_ml(pages: list[int]) -> list[dict]:
    from eval.run import load_matrix, specs as matrix_specs
    from inspector_ml.extract import extract

    sp = matrix_specs(load_matrix())
    out = []
    for n in pages:
        doc = text_doc(n, sp)
        timings: dict[str, float] = {}
        t0 = time.perf_counter()
        extract(doc, sp, timings=timings)
        total = time.perf_counter() - t0
        ms = list(timings.values())
        worst = max(timings, key=timings.get)
        out.append(
            {
                "pages": n,
                "params": len(sp),
                "total_s": round(total, 2),
                "p50_ms": round(statistics.median(ms), 1),
                "p95_ms": round(_pct(ms, 0.95), 1),
                "max_ms": round(max(ms), 1),
                "worst_param": worst,
                "over_limit": sum(v > ML_LIMIT_MS for v in ms),
                "ok": max(ms) <= ML_LIMIT_MS,
            }
        )
        print(json.dumps(out[-1], ensure_ascii=False), flush=True)
    return out


def bench_cv(formats: list[str]) -> list[dict]:
    import importlib

    from fastapi.testclient import TestClient

    from synth.bench_drawings import drawing

    tmp = Path(tempfile.mkdtemp(prefix="bench-cv-"))
    blobs = tmp / "blobs"
    blobs.mkdir()
    os.environ["INSPECTOR_ML_CACHE"] = str(tmp / "cache")
    os.environ["INSPECTOR_BLOB_DIR"] = str(blobs)
    import inspector_ml.app as app_mod

    importlib.reload(app_mod)
    client = TestClient(app_mod.app)
    out = []
    try:
        for fmt in formats:
            p = tmp / f"{fmt}.pdf"
            info = drawing(fmt, p)
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            shutil.copy(p, blobs / sha)
            t0 = time.perf_counter()
            r = client.post("/measure", json={"sha256": sha, "page": 1}).json()
            wall = round((time.perf_counter() - t0) * 1000)
            walls_found = sum(1 for d in r["distances"])
            out.append(
                {
                    **info,
                    "status": r["status"],
                    "method": r["method"],
                    "sheet_scale": r["sheet_scale_gost"],
                    "render_dpi": r["render_dpi"],
                    "dimension_lines_found": len(r["dimension_lines"]),
                    "distances": walls_found,
                    "ms": r["ms"],
                    "wall_ms": wall,
                    "ok": r["method"] != "timeout" and r["ms"] <= CV_LIMIT_MS,
                }
            )
            print(json.dumps(out[-1], ensure_ascii=False), flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out


def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="1,100,500")
    ap.add_argument("--formats", default="A3,A2,A1,A0")
    ap.add_argument("--out", default="../var/bench-ml-cv.json")
    a = ap.parse_args(argv)
    res = {
        "schema": "inspector-bench-ml-cv/1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": {
            "machine": platform.machine(),
            "python": platform.python_version(),
            "load": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
        },
        "limits_ms": {"ml_param": ML_LIMIT_MS, "cv_sheet": CV_LIMIT_MS},
        "ml": bench_ml([int(x) for x in a.pages.split(",") if x]),
        "cv": bench_cv([x for x in a.formats.split(",") if x]),
    }
    res["verdict"] = "OK" if all(x["ok"] for x in res["ml"] + res["cv"]) else "FAIL"
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=2), "utf-8")
    print("verdict", res["verdict"], "→", a.out)
    return res


if __name__ == "__main__":
    main()
