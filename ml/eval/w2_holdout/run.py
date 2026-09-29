"""Замер отложенного набора W2 через стенд мутаций T-179 (T-190): набор T-195 → настоящий ML-сервис → конвейер API
(`apps/api/scripts/mutation-bench.ts`) → счёт `eval/w2_holdout/score.py` → report.json / report.md.

Переходник, а не новый стенд: ML-сервис и прогон API — функции `eval/mutation_run.py` (start_ml, run_api, stop),
набор — `eval/w2_holdout/generate.py`, счёт — `eval/w2_holdout/score.py`. Здесь только перевод форматов:
  набор W2 (inspector-w2-holdout/1) → набор стенда (inspector-mutations/1, MutationDataset в domain/mutation-bench.ts);
  ответ стенда (inspector-mutation-results/1) → вход счёта W2 ({"results": [{case_id, rows: [{code, status, fragments}]}]}).
Строка стенда без operator — проверка параметра целиком: счёт W2 засчитывает её всем операторам кода.

Каталог прогона (вне git, по умолчанию ml/var/w2-holdout/<профиль>/):
  run.json — метка прогона; holdout/ — набор W2 (или --holdout <каталог> готового набора);
  dataset.json — набор стенда, <case_id> → symlink на каталог примера в наборе W2 (стенд читает <dir>/<case_id>/<файл>);
  api.json — ответ стенда последней порции, api-all.json — все порции; results.json — вход счёта; report.json, report.md;
  blobs/, ml-cache/, ml.log — ML-сервис прогона.

    uv run python -m eval.w2_holdout.run --seed 100000 --only NEG-01 MUT-09/door --per 2 --out ../var/w2-holdout/run
    uv run python -m eval.w2_holdout.run --holdout ../var/w2-holdout/set --limit 20 --parallel 2

TODO(T-190): после влития T-179 в main — свести общий код прогона (порции, метка каталога, тайминги) с mutation_run.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import resource
import shutil
import sys
import time
from pathlib import Path

ML = Path(__file__).resolve().parents[2]
if str(ML) not in sys.path:  # запуск файлом
    sys.path.insert(0, str(ML))

from eval.w2_holdout import generate as gen  # noqa: E402
from eval.w2_holdout import score as ws  # noqa: E402

ROOT = ML.parent
WAVE = ROOT / "data/seed/w2-wave.json"
BENCH_SCHEMA = "inspector-mutations/1"  # MutationDataset стенда T-179
RUN_SCHEMA = "inspector-w2-holdout-run/1"
# Умолчания полей, которых в наборе W2 нет:
#  profile — признаки объекта для применимости параметра (applicability в matrix.json). У W2-параметров встречаются
#    только demolition и underground; ключа нет — параметр применим. Берём профиль стенда T-179 (жилой, с подземной
#    частью): underground-параметры проверяются, demolition — применим по отсутствию ключа, ничего не гасится.
DEFAULT_PROFILE = {"residential": True, "underground": True}
BATCH = 100  # примеров на вызов стенда: run_api ограничен часом, порция — минуты; сбой порции не теряет прочие


def long_date(s: str | None) -> str | None:
    """Дата штампа W2 «ДД.ММ.ГГ» → «ДД.ММ.ГГГГ», как у набора T-179 (век — 20xx: набор про 2026 год).
    Прочие записи (уже четырёхзначный год, ISO, None) — как есть: стенд хранит дату текстом и не сравнивает."""
    if s and re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", s):
        return f"{s[:6]}20{s[6:]}"
    return s


def to_bench(ds: dict, profile: dict[str, bool] | None = None) -> dict:
    """Набор W2 → набор стенда T-179 (BenchCase: case_id, profile, files[…]). Файл без sha256 — набор собран без
    отрисовки (--truth-only), стенду нечего разбирать — отказ, а не пустой прогон."""
    if ds.get("schema") != gen.SCHEMA:
        raise ValueError(
            f"набор со схемой {ds.get('schema')!r}, ожидалась {gen.SCHEMA}"
        )
    cases = []
    for c in ds["cases"]:
        files = c.get("files") or []
        if not files:
            raise ValueError(
                f"{c['case_id']}: у примера нет файлов — набор собран без отрисовки"
            )
        out = []
        for f in files:
            if not f.get("sha256"):
                raise ValueError(
                    f"{c['case_id']}/{f.get('file_name')}: нет sha256 — набор собран без отрисовки"
                )
            out.append(
                {
                    "file_id": f["file_id"],
                    "file_name": f["file_name"],
                    "sha256": f["sha256"],
                    "doc_stage": f["doc_stage"],
                    "discipline": f["discipline"],
                    "document_code": f["document_code"],
                    "revision": f["revision"],
                    "approval_status": f.get("approval_status"),
                    "approval_date": long_date(f.get("approval_date")),
                    "predecessor_id": f.get("predecessor_id"),
                }
            )
        cases.append(
            {
                "case_id": c["case_id"],
                "profile": dict(profile or DEFAULT_PROFILE),
                "files": out,
            }
        )
    return {
        "schema": BENCH_SCHEMA,
        "dataset_version": ds["dataset_version"],
        "cases": cases,
    }


def wave_codes(path: Path = WAVE) -> list[str]:
    """Коды параметров волны W2 — все 50 из реестра волны: их проверки стенд читает из базы API."""
    codes = sorted({p["id"] for p in json.loads(path.read_text("utf-8"))["params"]})
    bad = [c for c in codes if not re.fullmatch(r"M-\d{3}", c)]
    if bad:  # стенд молча отбрасывает коды не вида M-NNN — отказ здесь, а не пропавшие параметры в отчёте
        raise ValueError(f"{path.name}: коды не вида M-NNN: {bad}")
    return codes


def to_score_input(api: dict) -> dict:
    """Ответ стенда → вход счёта W2: строки проверок (code, status, fragments) без operator — проверка параметра
    целиком; файлы (статус разбора) и отказ примера — как есть, счёт относит их к failed_cases."""
    results = []
    for r in api["results"]:
        x = {
            "case_id": r["case_id"],
            "rows": [
                {
                    "code": w["code"],
                    "status": w["status"],
                    "fragments": w.get("fragments") or [],
                }
                for w in r.get("rows") or []
            ],
            "files": r.get("files") or [],
            "ms": r.get("ms"),
        }
        if r.get("error"):
            x["error"] = r["error"]
        results.append(x)
    return {"results": results}


def head(ds: dict, n: int | None) -> dict:
    """Первые n примеров набора W2 и их истина (готовый набор с --limit)."""
    if n is None:
        return ds
    cases = ds["cases"][:n]
    keep = {c["case_id"] for c in cases}
    return ds | {
        "cases": cases,
        "truth": [t for t in ds["truth"] if t["case_id"] in keep],
    }


def prepare(out: Path, holdout: Path | None) -> Path:
    """Каталог прогона: новый или пустой — берётся; прежний прогон этого модуля (run.json нашей схемы) — очищается;
    чужой непустой каталог — отказ (как prepare_run_dir T-179). Готовый набор внутри каталога прогона — отказ:
    очистка снесла бы его."""
    out = out.resolve()
    if holdout is not None and out in [holdout.resolve(), *holdout.resolve().parents]:
        raise RuntimeError(
            f"{holdout}: готовый набор внутри каталога прогона {out} — очистка удалила бы его"
        )
    if out.exists() and any(out.iterdir()):
        try:
            ours = (
                json.loads((out / "run.json").read_text("utf-8")).get("schema")
                == RUN_SCHEMA
            )
        except (OSError, ValueError):
            ours = False
        if not ours:
            raise RuntimeError(
                f"{out}: каталог не пуст и это не прогон замера W2 — не удаляю"
            )
        shutil.rmtree(out)
    out.mkdir(parents=True)
    return out


def generate(
    out: Path, seed: int, only: list[str] | None, per: int | None, limit: int | None
) -> dict:
    """Набор T-195 в out. TODO(T-190): у generate.build нет limit (файл T-195 не правится) — обрезаем выбор плана
    обёрткой select на время вызова; per=большое снимает проверку полного баланса, недостижимую на обрезке."""
    if limit is None:
        return gen.build(out, seed, only=only, per=per)
    orig = gen.select
    gen.select = lambda items, o, p: orig(items, o, p)[:limit]
    try:
        return gen.build(out, seed, only=only, per=per if per is not None else 10**9)
    finally:
        gen.select = orig


def link_cases(run_dir: Path, holdout: Path, cases: list[dict]) -> None:
    """Стенд читает файлы из <dataset>/<case_id>/<имя>: каталог примера — ссылкой на набор W2, без копий PDF."""
    for c in cases:
        src = holdout / c["case_id"]
        if not src.is_dir():
            raise FileNotFoundError(f"{src}: каталога примера нет в наборе")
        (run_dir / c["case_id"]).symlink_to(src.resolve(), target_is_directory=True)


def live_api(
    run_dir: Path, bench: dict, codes: list[str], parallel: int, batch: int = BATCH
) -> dict:
    """Настоящий прогон: ML-сервис стенда T-179 на порту > 40000, конвейер API порциями по batch примеров."""
    from eval import mutation_run as M

    port = M.free_port()
    ml = M.start_ml(run_dir, port, parallel)
    results, ms, rss = [], 0, 0
    try:
        for i in range(0, len(bench["cases"]), batch):
            (run_dir / "dataset.json").write_text(
                json.dumps(
                    bench | {"cases": bench["cases"][i : i + batch]}, ensure_ascii=False
                ),
                "utf-8",
            )
            part = M.run_api(run_dir, port, parallel, codes)
            results += part["results"]
            ms += part.get("ms") or 0
            rss = max(rss, part.get("rss_mb") or 0)
            print(
                json.dumps(
                    {
                        "batch": i // batch + 1,
                        "done": len(results),
                        "of": len(bench["cases"]),
                        "ms": ms,
                    }
                ),
                flush=True,
            )
    finally:
        M.stop(ml)
        (run_dir / "dataset.json").write_text(
            json.dumps(bench, ensure_ascii=False), "utf-8"
        )  # набор целиком — для разбора
    return {
        "schema": "inspector-mutation-results/1",
        "dataset_version": bench["dataset_version"],
        "codes": codes,
        "ms": ms,
        "rss_mb": rss,
        "results": results,
    }


def peak_mb(who: int) -> int:
    rss = resource.getrusage(who).ru_maxrss  # КБ в Linux, байты в macOS
    return round(rss / (1 << 20) if sys.platform == "darwin" else rss / 1024)


def revisions() -> dict:
    from eval import mutation_run as M

    return M.revisions()


def run(
    out: Path,
    seed: int = gen.SEED_MIN,
    only: list[str] | None = None,
    per: int | None = None,
    limit: int | None = None,
    parallel: int = 2,
    holdout: Path | None = None,
    bootstrap: int = 400,
    batch: int = BATCH,
    api=live_api,
    revs=revisions,
) -> dict:
    """Весь замер; api — прогон конвейера (подменяется в тесте), revs — ревизии разбора/извлечения для отчёта."""
    run_dir = prepare(out, holdout)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "schema": RUN_SCHEMA,
                "seed": seed,
                "only": only,
                "per": per,
                "limit": limit,
                "holdout": str(holdout) if holdout else None,
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    t0 = time.monotonic()
    if holdout is None:
        holdout = run_dir / "holdout"
        ds = generate(holdout, seed, only, per, limit)
    else:
        ds = head(json.loads((holdout / "dataset.json").read_text("utf-8")), limit)
    t_gen = time.monotonic() - t0
    bench = to_bench(ds)
    (run_dir / "dataset.json").write_text(
        json.dumps(bench, ensure_ascii=False), "utf-8"
    )
    link_cases(run_dir, holdout, bench["cases"])
    codes = wave_codes()
    t1 = time.monotonic()
    raw = api(run_dir, bench, codes, parallel, batch)
    t_api = time.monotonic() - t1
    (run_dir / "api-all.json").write_text(json.dumps(raw, ensure_ascii=False), "utf-8")
    inp = to_score_input(raw)
    (run_dir / "results.json").write_text(json.dumps(inp, ensure_ascii=False), "utf-8")
    rep = ws.score(ds, inp, b=bootstrap)
    n = len(ds["cases"])
    rep["profile"] = run_dir.name
    rep["codes"] = len(codes)
    rep |= revs()
    rep["timing"] = {
        "generate_s": round(t_gen, 1),
        "pipeline_s": round(t_api, 1),
        "total_s": round(time.monotonic() - t0, 1),
        "per_case_s": round(t_api / n, 2) if n else None,
        "api_ms": raw.get("ms"),
        "api_rss_mb": raw.get("rss_mb"),
        "self_peak_rss_mb": peak_mb(resource.RUSAGE_SELF),
        "children_peak_rss_mb": peak_mb(resource.RUSAGE_CHILDREN),
        "host": f"{os.uname().sysname} {os.uname().machine}, ядер {os.cpu_count()}",
    }
    (run_dir / "report.json").write_text(
        json.dumps(rep, ensure_ascii=False, indent=1), "utf-8"
    )
    (run_dir / "report.md").write_text(ws.markdown(rep), "utf-8")
    return rep


def main(argv: list[str] | None = None) -> int:  # pragma: no cover — CLI и процессы
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=gen.SEED_MIN)
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--per", type=int)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--parallel", type=int, default=2)
    ap.add_argument("--batch", type=int, default=BATCH)
    ap.add_argument("--bootstrap", type=int, default=400)
    ap.add_argument(
        "--holdout",
        type=Path,
        help="готовый набор W2 (каталог с dataset.json) вместо генерации",
    )
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    prof = "full" if a.only is None and a.per is None and a.limit is None else "subset"
    rep = run(
        a.out or ML / "var/w2-holdout" / prof,
        a.seed,
        a.only,
        a.per,
        a.limit,
        a.parallel,
        a.holdout,
        a.bootstrap,
        a.batch,
    )
    s = rep["slices"].get("all", {})
    print(
        json.dumps(
            {
                "cases": rep["cases"],
                "groups": rep["groups"],
                "failed": len(rep["failed_cases"]),
                "missing": len(rep["missing_cases"]),
                "recall": s.get("recall"),
                "fpr": s.get("fpr"),
                "timing": rep["timing"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
