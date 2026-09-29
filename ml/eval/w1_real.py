"""Стенд W1 на реальных объектах корпуса «Хакатон» (T-180, OS-INSP-6.5.50–6.5.54) — только на раннере.

Путь — как у инспектора и у стенда мутаций T-179: ML-сервис (uvicorn inspector_ml.app, профиль dev) на случайном порту
выше 40000 + `apps/api/scripts/w1-real-bench.ts` (серверный импорт по SHA-256, роли редакций, /analyze, пересчёт
паспортными операторами). Файлы объекта не копируются: хранилище API и ML — каталог блобов корпуса, разбор — из кэша r4.
Запуск — только через `scripts/runner/w1-real.sh` (корпус и кэш смонтированы только на чтение, кэш ML — слой поверх r4):

    scripts/remote-run.sh "scripts/runner/w1-real.sh run --object ALT-79B --codes M-023"
    scripts/remote-run.sh "scripts/runner/w1-real.sh mentions --object ALT-79B --param M-023"   # протокол разметки
    scripts/remote-run.sh "scripts/runner/w1-real.sh gold import --object ALT-79B --param M-023"
    scripts/remote-run.sh --light --get docs/qa/W1-QUALITY.md "scripts/runner/w1-real.sh table --mutations <report.json>"

Подробности прогона (статусы, значения, страницы, упоминания) — только в `$W1_EVAL/<объект>/` (права 700).
В рабочее дерево (`ml/var/w1-real/<объект>.json`, забирается `--get`) и в журнал — только агрегат (`assert_aggregate`).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import resource
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from eval import w1_real_score as S
from inspector_ml.paths import repo_root

ROOT = repo_root()
ML = ROOT / "ml"
CORPUS = Path(os.environ.get("W1_CORPUS", "/opt/corpus"))
R4_CACHE = Path(os.environ.get("W1_R4_CACHE", "/opt/inspector/cache"))
EVAL = Path(os.environ.get("W1_EVAL", "/opt/w1-gate/eval/w1"))
AGG_DIR = ML / "var/w1-real"
TSX = ROOT / "apps/api/node_modules/.bin/tsx"
WAVE = ROOT / "data/seed/w1-wave.json"
MUT_REGISTRY = ML / "eval/mutations/w1.json"
SOURCES = ML / "eval/w1_real_sources.json"
# объекты по умолчанию — архив корпуса с одним объектом (номер архива, не имя); прочие — в $W1_EVAL/objects.json
OBJECTS = {
    "ALT-79B": {"archive": "14"},
    "POL-17": {"archive": "15"},
    "LOS-3A": {"archive": "16"},
}
MAX_CACHE_MB = float(os.environ.get("W1_MAX_CACHE_MB", "40"))  # подобрано замером POL-17, T-180
FORMATS = {
    ".pdf",
    ".docx",
    ".doc",
    ".xlsx",
    ".xls",
    ".xml",
    ".jpg",
    ".jpeg",
    ".png",
    ".tif",
    ".tiff",
}


def private_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    p.chmod(0o700)
    return p


def objects() -> dict[str, dict]:
    extra = EVAL / "objects.json"
    return OBJECTS | (json.loads(extra.read_text("utf-8")) if extra.exists() else {})


def readonly(p: Path) -> bool:
    return bool(os.statvfs(p).f_flag & os.ST_RDONLY)


def require_readonly() -> None:
    """Прогон только поверх смонтированных на чтение корпуса и кэша r4 (w1-real.sh): иначе отказ, а не надежда."""
    bad = [str(p) for p in (CORPUS / "blobs", R4_CACHE) if not readonly(p)]
    if bad:
        raise SystemExit(
            f"корпус и кэш r4 должны быть смонтированы только на чтение (scripts/runner/w1-real.sh): {', '.join(bad)}"
        )


def catalog_files(obj: str) -> list[dict]:
    """Файлы объекта из каталога корпуса: путь в архиве, хеш, размер. Путь — только для реестра стадий, наружу не идёт."""
    o = objects()[obj]
    [cat] = [
        p
        for p in (CORPUS / "catalog").glob("*.jsonl")
        if p.name.startswith(o["archive"] + "_")
    ]
    prefix = o.get("prefix")
    out = []
    for line in cat.read_text("utf-8").splitlines():
        r = json.loads(line)
        if prefix and not r["path"].startswith(prefix):
            continue
        if (
            Path(r["path"]).suffix.lower() in FORMATS
            and (CORPUS / "blobs" / r["sha256"]).exists()
        ):
            out.append(
                {"path": r["path"], "sha256": r["sha256"], "size": int(r["bytes"])}
            )
    return out


def cached_r4(sha: str, rev: int) -> bool:
    return (R4_CACHE / f"parsed-{sha}-r{rev}.json").exists()


def r4_mb(sha: str, rev: int) -> float:
    """Размер разбора r4 в МБ — оценка памяти ML-воркера на томе до запуска (без чтения файла)."""
    p = R4_CACHE / f"parsed-{sha}-r{rev}.json"
    return p.stat().st_size / 1e6 if p.exists() else 0.0


def children_peak_mb() -> int:
    return round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024)


def run(
    obj: str, codes: list[str], approval: bool, workers: int, only_cached: bool = True, limit_files: int | None = None, max_cache_mb: float = MAX_CACHE_MB
) -> dict:  # pragma: no cover — процессы
    from inspector_ml.docstore import PARSER_REV
    from inspector_ml.extract import EXTRACT_REV

    require_readonly()
    t0 = time.monotonic()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    rd = private_dir(EVAL / obj / stamp)
    files = catalog_files(obj)
    with_r4 = [f for f in files if cached_r4(f["sha256"], PARSER_REV)]
    take = with_r4 if only_cached else files
    # предел памяти задачи (7 ГБ, решение координатора 28.09): том, чей разбор r4 больше предела, не прогоняется,
    # а считается «не прогнан (память)» — ML-воркер на нём растёт до OOM и роняет весь объект (T-188)
    heavy = [f for f in take if r4_mb(f["sha256"], PARSER_REV) > max_cache_mb]
    take = [f for f in take if f not in heavy]
    if limit_files:  # правило №0: сначала несколько самых лёгких файлов, замер, потом объект целиком
        take = sorted(take, key=lambda f: f["size"])[:limit_files]
    spec = {
        "schema": "inspector-w1-real-spec/1",
        "object_id": obj,
        "approval": approval,
        "codes": codes,
        "files": take,
    }
    (rd / "spec.json").write_text(json.dumps(spec, ensure_ascii=False), "utf-8")
    # кэш ML: слой поверх r4 (overlay из w1-real.sh) — прочитанное из r4 не пишется, своё ложится в верхний слой
    cache_dir = os.environ.get("W1_ML_CACHE") or str(private_dir(rd / "ml-cache"))
    port = free_port()
    ml = start_ml(rd, port, workers, cache_dir)
    try:
        env = {k: os.environ[k] for k in BASE_ENV if k in os.environ}
        env |= {
            "INSPECTOR_ML_URL": f"http://127.0.0.1:{port}",
            "INSPECTOR_BLOB_DIR": str(CORPUS / "blobs"),
            "TMPDIR": str(private_dir(rd / "tmp")),
        }
        with (rd / "api.log").open("w") as log:
            r = subprocess.run(
                [
                    str(TSX),
                    "scripts/w1-real-bench.ts",
                    "--spec",
                    str(rd / "spec.json"),
                    "--out",
                    str(rd / "api.json"),
                ],
                cwd=ROOT / "apps/api",
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=6 * 3600,
            )
        if r.returncode != 0:
            raise SystemExit(
                f"прогон API упал (код {r.returncode}), журнал — в каталоге прогона на сервере"
            )
    finally:
        stop(ml)
    api = json.loads((rd / "api.json").read_text("utf-8"))
    gold = load_gold(obj)
    gs = S.groups(obj, api["rows"], codes, gold, attribution())
    (rd / "groups.json").write_text(
        json.dumps(gs, ensure_ascii=False, indent=1), "utf-8"
    )
    agg = S.aggregate(
        gs,
        {
            "object_id": obj,
            "approval": approval,
            "codes": sorted(codes),
            "parser_rev": PARSER_REV,
            "extract_rev": EXTRACT_REV,
            "run_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "git_sha": git_sha(),
            "counts": api["counts"]
            | {"cached_r4": len(with_r4), "without_r4": len(files) - len(with_r4), "skipped_memory": len(heavy)},
            "rejected_codes": api["rejected_codes"],
            "file_status": _count(f["parse_status"] for f in api["files"]),
            "stages": _count(f["stage"] for f in api["files"]),
            "timing": {
                "import_s": round(api["ms"]["import"] / 1000, 1),
                "pipeline_s": round(api["ms"]["pipeline"] / 1000, 1),
                "total_s": round(time.monotonic() - t0, 1),
                "peak_rss_mb": children_peak_mb(),
                "api_rss_mb": api["rss_mb"],
                "host": f"{os.uname().sysname} {os.uname().machine}, ядер {os.cpu_count()}",
            },
        },
    )
    (rd / "aggregate.json").write_text(
        json.dumps(agg, ensure_ascii=False, indent=1), "utf-8"
    )
    # агрегат — и в общий каталог прогонов (его читает таблица из любого worktree), и в рабочее дерево (для --get)
    (private_dir(EVAL / "aggregates") / f"{obj}.json").write_text(json.dumps(agg, ensure_ascii=False, indent=1) + "\n", "utf-8")
    AGG_DIR.mkdir(parents=True, exist_ok=True)
    (AGG_DIR / f"{obj}.json").write_text(
        json.dumps(agg, ensure_ascii=False, indent=1) + "\n", "utf-8"
    )
    (EVAL / obj / "latest").unlink(missing_ok=True)
    (EVAL / obj / "latest").symlink_to(stamp)
    return agg


BASE_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "USER")


def free_port(rng: random.Random | None = None) -> int:
    """Случайный свободный порт выше 40000 (CLAUDE.md проекта): свободен — если удаётся занять его самим."""
    rng = rng or random.Random()
    for _ in range(50):
        port = rng.randint(40001, 60000)
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("нет свободного порта выше 40000")


def ml_env(cache_dir: str, tmp: Path) -> dict[str, str]:
    """Окружение ML-сервиса: хранилище — блобы корпуса (чтение), кэш — слой поверх r4; без INSPECTOR_* из shell
    (профиль gpu, судья VLM, S3) — как у стенда мутаций T-179 (OWASP T179-5)."""
    return {k: os.environ[k] for k in BASE_ENV if k in os.environ} | {
        "INSPECTOR_PROFILE": "dev",
        "INSPECTOR_BLOB_DIR": str(CORPUS / "blobs"),
        "INSPECTOR_ML_CACHE": cache_dir,
        "INSPECTOR_CACHE": "file",
        "INSPECTOR_MAX_PAGES": "5000",  # как у разбора T-165: предел защитный, формат разбора не меняется
        "TMPDIR": str(tmp),
    }


def stop(p: subprocess.Popen) -> None:  # pragma: no cover — процессы
    """Остановить сервис вместе с воркерами uvicorn (группа процессов): terminate → 10 с → kill."""
    if p.poll() is not None:
        return
    try:
        os.killpg(p.pid, 15)
    except ProcessLookupError:
        return
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, 9)
        p.wait(10)


def start_ml(rd: Path, port: int, workers: int, cache_dir: str, wait_s: float = 120) -> subprocess.Popen:  # pragma: no cover — процессы
    with (rd / "ml.log").open("w") as log:
        p = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "inspector_ml.app:app", "--host", "127.0.0.1", "--port", str(port), "--workers", str(workers), "--log-level", "warning"],
            cwd=ML, env=ml_env(cache_dir, private_dir(rd / "tmp")), stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    until = time.monotonic() + wait_s
    try:
        while time.monotonic() < until:
            if p.poll() is not None:
                raise SystemExit("ML-сервис упал при старте, журнал — в каталоге прогона на сервере")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    if r.status == 200:
                        return p
            except OSError:
                time.sleep(0.3)
        raise SystemExit(f"ML-сервис не ответил на /health за {wait_s:.0f} с")
    except BaseException:
        stop(p)
        raise


def _count(xs) -> dict[str, int]:
    out: dict[str, int] = {}
    for x in xs:
        out[str(x)] = out.get(str(x), 0) + 1
    return dict(sorted(out.items()))


def git_sha() -> str:
    r = subprocess.run(
        ["git", "rev-parse", "--short=12", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else "0000000"


def attribution() -> dict[str, str]:
    wave = json.loads(WAVE.read_text("utf-8"))
    reg = json.loads(MUT_REGISTRY.read_text("utf-8")) if MUT_REGISTRY.exists() else None
    return S.attribution(wave, reg)


def rss_mb() -> int:
    """Текущий RSS процесса, МБ (Linux: /proc/self/statm)."""
    with open("/proc/self/statm") as f:
        return round(int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6)


def memprobe(obj: str, top: int, codes: list[str]) -> list[dict]:  # pragma: no cover — тяжёлые тома сервера
    """T-188: память ML на самых тяжёлых томах объекта по этапам — чтение разбора r4, модель ParsedDoc, извлечение.
    По тому печатается строка сразу (при OOM видно, на каком этапе оборвалось). Только числа: без имён и хешей."""
    import gc

    from inspector_ml.docstore import PARSER_REV
    from inspector_ml.model import ParsedDoc
    from inspector_ml.reread import extract_refined

    from eval.run import load_matrix, specs

    require_readonly()
    all_specs = [x for x in specs(load_matrix()) if x.code in set(codes)] if codes else specs(load_matrix())
    files = sorted((f for f in catalog_files(obj) if cached_r4(f["sha256"], PARSER_REV)), key=lambda f: -r4_mb(f["sha256"], PARSER_REV))[:top]
    out = []
    for i, f in enumerate(files, 1):
        rec = {"n": i, "r4_mb": round(r4_mb(f["sha256"], PARSER_REV), 1), "file_mb": round(f["size"] / 1e6, 1), "rss0": rss_mb()}
        t = time.monotonic()
        raw = (R4_CACHE / f"parsed-{f['sha256']}-r{PARSER_REV}.json").read_text("utf-8")
        rec["rss_read"] = rss_mb()
        doc = ParsedDoc.model_validate_json(raw)
        del raw
        gc.collect()
        rec |= {"pages": len(doc.pages), "scan_pages": sum(p.source == "ocr" for p in doc.pages), "rss_model": rss_mb(), "validate_s": round(time.monotonic() - t, 1)}
        print(json.dumps(rec), flush=True)
        t = time.monotonic()
        extract_refined(CORPUS / "blobs" / f["sha256"], doc, all_specs)
        rec |= {"rss_extract": rss_mb(), "extract_s": round(time.monotonic() - t, 1), "peak": children_peak_mb() or round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)}
        print(json.dumps(rec), flush=True)
        out.append(rec)
        del doc
        gc.collect()
    return out


# ─────────────────────────────── эталон на сервере


def gold_path(obj: str) -> Path:
    return private_dir(EVAL / "gold") / f"{obj}.json"


def load_gold(obj: str) -> list[dict]:
    p = gold_path(obj)
    return S.validate_gold(json.loads(p.read_text("utf-8"))) if p.exists() else []


def save_gold(obj: str, lab: dict) -> None:
    p = gold_path(obj)
    g = (
        json.loads(p.read_text("utf-8"))
        if p.exists()
        else {"schema": S.GOLD_SCHEMA, "object_id": obj, "labels": []}
    )
    p.write_text(
        json.dumps(S.upsert_label(g, lab), ensure_ascii=False, indent=1), "utf-8"
    )


def gold_summary() -> dict:
    """Сводка эталона по объектам — только числа (в журнал)."""
    out = {}
    for p in sorted((EVAL / "gold").glob("*.json")) if (EVAL / "gold").exists() else []:
        labs = S.validate_gold(json.loads(p.read_text("utf-8")))
        out[p.stem] = {
            "labels": len(labs),
            "final": sum(x["quality"] == "final" for x in labs),
        }
    return out


# ─────────────────────────────── протокол ручной разметки (OS-INSP-6.5.54)


def mentions(obj: str, param: str) -> dict:  # pragma: no cover — файлы сервера
    """Упоминания параметра из последнего прогона объекта → очередь учителя и форма разметки в $W1_EVAL/labeling."""
    from teacher.labels import split_of

    api = json.loads((EVAL / obj / "latest" / "api.json").read_text("utf-8"))
    params = {
        p["code"]: p
        for p in json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
    }
    op = attribution()[param]
    q = S.mention_queue(api, param, params, split_of(obj, set()))
    status = next((r["status"] for r in api["rows"] if r["code"] == param), "NO_CHECK")
    d = private_dir(EVAL / "labeling" / obj / param)
    (d / "queue.jsonl").write_text(
        "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in q), "utf-8"
    )
    form = d / "form.csv"
    if not form.exists():  # заполненную форму не затираем
        form.write_text(S.form_csv(q, param, op, status), "utf-8")
    return {"object_id": obj, "n": len(q), "stages": _count(x["stage"] for x in q)}


def gold_import(obj: str, param: str) -> dict:  # pragma: no cover — файлы сервера
    d = EVAL / "labeling" / obj / param
    q = [
        json.loads(x)
        for x in (d / "queue.jsonl").read_text("utf-8").splitlines()
        if x.strip()
    ]
    group, labels = S.import_form(
        (d / "form.csv").read_text("utf-8"), q, obj, param, attribution()[param]
    )
    if group:
        save_gold(obj, group)
    (d / "labels.jsonl").write_text(
        "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in labels), "utf-8"
    )
    return {"object_id": obj, "labels": len(labels), "final": int(group is not None)}


# ─────────────────────────────── таблица качества


def table(mutations: Path | None, out: Path) -> None:  # pragma: no cover — файлы
    from eval.w1_real_table import render

    src_dir = EVAL / "aggregates" if (EVAL / "aggregates").is_dir() else AGG_DIR
    aggs = [json.loads(p.read_text("utf-8")) for p in sorted(src_dir.glob("*.json"))]
    for a in aggs:
        S.assert_aggregate(a)
    mut = (
        json.loads(mutations.read_text("utf-8"))
        if mutations and mutations.exists()
        else None
    )
    wave = json.loads(WAVE.read_text("utf-8"))
    src = json.loads(SOURCES.read_text("utf-8"))
    out.write_text(render(aggs, mut, wave, src, attribution()), "utf-8")


def main(argv: list[str] | None = None) -> int:  # pragma: no cover — CLI
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--object", required=True, choices=sorted(objects()))
    r.add_argument("--codes", default="M-023")
    r.add_argument(
        "--approval",
        action="store_true",
        help="статус утверждения по подтверждению оператора (OS-INSP-1.2.25)",
    )
    r.add_argument("--workers", type=int, default=2)
    r.add_argument("--max-cache-mb", type=float, default=MAX_CACHE_MB, help="том с разбором r4 больше — «не прогнан (память)»")
    r.add_argument("--limit-files", type=int, help="только N самых лёгких файлов с разбором r4 (замер)")
    mp = sub.add_parser("memprobe", help="T-188: память ML по этапам на самых тяжёлых томах")
    mp.add_argument("--object", required=True)
    mp.add_argument("--top", type=int, default=3)
    mp.add_argument("--codes", default="")
    m = sub.add_parser("mentions")
    m.add_argument("--object", required=True)
    m.add_argument("--param", required=True)
    g = sub.add_parser("gold")
    g.add_argument("action", choices=["set", "import", "summary"])
    g.add_argument("--object")
    g.add_argument("--param")
    g.add_argument("--operator")
    g.add_argument("--label", choices=S.TRUTH)
    g.add_argument("--source", choices=S.SOURCES, default="verified")
    g.add_argument("--quality", choices=S.QUALITY, default="final")
    g.add_argument("--ref")
    t = sub.add_parser("table")
    t.add_argument("--mutations", type=Path)
    t.add_argument("--out", type=Path, default=ROOT / "docs/qa/W1-QUALITY.md")
    a = ap.parse_args(argv)
    if a.cmd == "run":
        agg = run(
            a.object,
            [c.strip() for c in a.codes.split(",") if c.strip()],
            a.approval,
            a.workers,
            limit_files=a.limit_files,
            max_cache_mb=a.max_cache_mb,
        )
        print(
            json.dumps(
                {
                    "object_id": agg["object_id"],
                    "all": {
                        k: agg["all"][k]
                        for k in (
                            "n",
                            "n_pos",
                            "n_neg",
                            "n_unlabeled",
                            "tp",
                            "fp",
                            "fn",
                            "tn",
                            "abst_pos",
                            "abst_neg",
                        )
                    },
                    "timing": agg["timing"],
                    "counts": agg["counts"],
                },
                ensure_ascii=False,
            )
        )
    elif a.cmd == "memprobe":
        memprobe(a.object, a.top, [c.strip() for c in a.codes.split(",") if c.strip()])
    elif a.cmd == "mentions":
        print(json.dumps(mentions(a.object, a.param), ensure_ascii=False))
    elif a.cmd == "gold" and a.action == "set":
        save_gold(
            a.object,
            {
                "param": a.param,
                "operator": a.operator,
                "label": a.label,
                "source": a.source,
                "quality": a.quality,
                "ref": a.ref,
            },
        )
        print(json.dumps(gold_summary(), ensure_ascii=False))
    elif a.cmd == "gold" and a.action == "import":
        print(json.dumps(gold_import(a.object, a.param), ensure_ascii=False))
    elif a.cmd == "gold":
        print(json.dumps(gold_summary(), ensure_ascii=False))
    else:
        table(a.mutations, a.out)
        print(f"таблица: {a.out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
