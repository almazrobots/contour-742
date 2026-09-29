"""Стенд мутаций L11 целиком (T-179, OS-INSP-6.5.44–6.5.49): генератор → ML-сервис → конвейер API → QA-05/06 → гейт QA-07.

ML поднимается настоящим сервисом (uvicorn inspector_ml.app, профиль dev) на случайном порту выше 40000 с хранилищем
блобов прогона; API — `apps/api/scripts/mutation-bench.ts` (приём пакета, разбор через HTTP /analyze, пересчёт).
Ничего не подменяется: статус группы — запись checks в базе API.

    uv run python -m eval.mutation_run light                       # лёгкий набор + гейт (local-gate, секунды)
    uv run python -m eval.mutation_run run --profile structural    # полный набор (на раннере); --profile adversarial — отложенный
    uv run python -m eval.mutation_run gate --profile structural --report var/mutations/structural/report.json
    uv run python -m eval.mutation_run baseline --profile structural --report var/mutations/structural/report.json

Базовая линия — `eval/baselines/w1-mutations.json` (в git), профили light и full; выход прогона — `ml/var/mutations/<профиль>/`
(вне git): dataset.json, api.json, report.json, report.md, judge/ (метки для T-156).
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import random
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from eval import mutation_score as S
from inspector_ml.paths import repo_root
from synth import mutations as G

ROOT = repo_root()
ML = ROOT / "ml"
BASELINE = ML / "eval/baselines/w1-mutations.json"
# structural — регресс механики (шаблоны генератора, база QA-07); adversarial — отложенный набор формулировок
# (eval/mutations/adversarial-w1.json), не из шаблонизатора экстракторов: оценка качества, а не самосогласованности
PROFILES = {
    "light": {"seed": 1, "scale": 0.05},
    "structural": {"seed": 7, "scale": 1.0},
    "adversarial": {"seed": 29, "scale": 1.0, "adversarial": True},
}
TSX = ROOT / "apps/api/node_modules/.bin/tsx"


def free_port(rng: random.Random | None = None) -> int:
    """Случайный свободный порт выше 40000: на низких портах висят чужие service worker (CLAUDE.md проекта).
    Свободен — если удаётся занять его сами (bind), а не только «никто не ответил» (OWASP T179-9)."""
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


BASE_ENV = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL")


def clean_env(extra: dict[str, str]) -> dict[str, str]:
    """Окружение дочерних процессов стенда (OWASP T179-5): только системное и заданное стендом — никаких INSPECTOR_* из
    shell (S3-бакет, профиль gpu, рабочая база), синтетика не уходит в чужое хранилище."""
    return {k: os.environ[k] for k in BASE_ENV if k in os.environ} | extra


def stop(p: subprocess.Popen) -> None:
    """Остановить сервис вместе с воркерами uvicorn (группа процессов): terminate → 10 с → kill (OWASP T179-2)."""
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


def start_ml(run: Path, port: int, workers: int = 1, wait_s: float = 90) -> subprocess.Popen:
    """ML-сервис прогона; workers > 1 — несколько процессов uvicorn (разбор упирается в GIL одного процесса).
    Любой сбой старта (в том числе прерывание) гасит всю группу процессов — сервис не остаётся висеть на порту."""
    env = clean_env({"INSPECTOR_PROFILE": "dev", "INSPECTOR_BLOB_DIR": str(run / "blobs"), "INSPECTOR_ML_CACHE": str(run / "ml-cache"), "INSPECTOR_CACHE": "file"})
    (run / "blobs").mkdir(parents=True, exist_ok=True)
    with (run / "ml.log").open("w") as log:
        p = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "inspector_ml.app:app", "--host", "127.0.0.1", "--port", str(port), "--workers", str(workers), "--log-level", "warning"],
            cwd=ML, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    try:
        until = time.monotonic() + wait_s
        while time.monotonic() < until:
            if p.poll() is not None:
                raise RuntimeError(f"ML-сервис упал при старте, журнал {run / 'ml.log'}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    if r.status == 200:
                        return p
            except OSError:
                time.sleep(0.3)
        raise RuntimeError(f"ML-сервис не ответил на /health за {wait_s:.0f} с")
    except BaseException:
        stop(p)
        raise


def registry_codes(reg: dict) -> list[str]:
    """Коды параметров, чьи проверки читает прогон API: все пары реестра. Подключённые идут в метрики, прочие — в раздел
    «ожидает оператора» с тем статусом, который система даёт сегодня (например, лексическим путём Матрицы)."""
    return sorted({p["code"] for p in reg["params"]})


def run_api(run: Path, port: int, parallel: int, codes: list[str]) -> dict:
    env = clean_env({"INSPECTOR_ML_URL": f"http://127.0.0.1:{port}", "INSPECTOR_BLOB_DIR": str(run / "blobs")})
    out = run / "api.json"
    r = subprocess.run(
        [
            str(TSX),
            "scripts/mutation-bench.ts",
            "--dataset",
            str(run),
            "--out",
            str(out),
            "--parallel",
            str(parallel),
            "--codes",
            ",".join(codes),
        ],
        cwd=ROOT / "apps/api",
        env=env,
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if r.returncode != 0:
        raise RuntimeError(f"прогон API упал ({r.returncode}): {r.stderr[-2000:]}")
    return json.loads(out.read_text("utf-8"))


def export_judge(run: Path, ds: dict, api: dict) -> dict:
    """Метки мутаций и решения — в формате эталона судьи T-156 (очередь, метки, SFT, решения по группам)."""
    from teacher.labels import sft_record

    params = {
        p["code"]: p
        for p in json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
    }
    queue, labels = S.judge_items(ds, api, params)
    d = run / "judge"
    d.mkdir(exist_ok=True)
    by = {q["item_id"]: q for q in queue}
    jl = lambda xs: "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in xs)  # noqa: E731
    (d / "queue.jsonl").write_text(jl(queue), "utf-8")
    (d / "labels.jsonl").write_text(jl(labels), "utf-8")
    sft = [
        sft_record(
            by[lab["item_id"]]
            | {
                "label": lab["label"],
                "reason": lab["reason"],
                "correct_value": lab["correct_value"],
                "labeler": lab["labeler"],
            }
        )
        for lab in labels
    ]
    (d / "sft.jsonl").write_text(jl(sft), "utf-8")
    dec = S.decisions(ds, api)
    (d / "decisions.jsonl").write_text(jl(dec), "utf-8")
    return {
        "items": len(queue),
        "accept": sum(x["label"] == "ACCEPT" for x in labels),
        "reject": sum(x["label"] == "REJECT" for x in labels),
        "decisions": len(dec),
    }


def children_peak_mb() -> int:
    """Пик памяти самого тяжёлого дочернего процесса (ML-воркер или node) — ru_maxrss: КБ в Linux, байты в macOS."""
    rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    return round(rss / (1 << 20) if sys.platform == "darwin" else rss / 1024)


def rescore(run_dir: Path, profile: str, bootstrap: int = 400) -> dict:
    """Отчёт заново по сохранённым набору и ответу API — правка оценки без повторного прогона конвейера."""
    ds = json.loads((run_dir / "dataset.json").read_text("utf-8"))
    api = json.loads((run_dir / "api.json").read_text("utf-8"))
    old = json.loads((run_dir / "report.json").read_text("utf-8")) if (run_dir / "report.json").exists() else {}
    rep = S.score(ds, api, b=bootstrap)
    rep["profile"] = profile
    rep |= revisions()
    rep["timing"] |= {k: v for k, v in (old.get("timing") or {}).items() if k.endswith("_s")}
    rep["judge_export"] = export_judge(run_dir, ds, api)
    S.write_json(run_dir / "report.json", rep)
    (run_dir / "report.md").write_text(S.markdown(rep), "utf-8")
    return rep


def prepare_run_dir(run_dir: Path) -> Path:
    """Каталог прогона: новый или пустой — берётся; прежний прогон стенда (dataset.json нашей схемы) — очищается;
    любой другой непустой каталог — отказ, а не рекурсивное удаление (OWASP T179-1: опечатка в --out)."""
    run_dir = run_dir.resolve()
    if run_dir.exists() and any(run_dir.iterdir()):
        ds = run_dir / "dataset.json"
        try:
            ours = json.loads(ds.read_text("utf-8")).get("schema") == G.SCHEMA
        except (OSError, ValueError):
            ours = False
        if not ours:
            raise RuntimeError(f"{run_dir}: каталог не пуст и это не прогон стенда мутаций — не удаляю")
        shutil.rmtree(run_dir)
    return run_dir


def run(
    profile: str,
    out: Path | None = None,
    parallel: int = 2,
    limit: int | None = None,
    bootstrap: int = 400,
) -> dict:
    cfg = PROFILES[profile]
    run_dir = prepare_run_dir(out or ML / "var/mutations" / profile)
    t0 = time.monotonic()
    ds = G.build(run_dir, cfg["seed"], cfg["scale"], limit, adversarial=G.load_adversarial() if cfg.get("adversarial") else None)
    t_gen = time.monotonic() - t0
    port = free_port()
    ml = start_ml(run_dir, port, parallel)
    try:
        t1 = time.monotonic()
        api = run_api(run_dir, port, parallel, registry_codes(G.load_registry()))
        t_api = time.monotonic() - t1
    finally:
        stop(ml)
    rep = S.score(ds, api, b=bootstrap)
    rep["profile"] = profile
    rep |= revisions()
    rep["timing"] |= {
        "generate_s": round(t_gen, 1),
        "pipeline_s": round(t_api, 1),
        "total_s": round(time.monotonic() - t0, 1),
        "children_peak_rss_mb": children_peak_mb(),
        "host": f"{os.uname().sysname} {os.uname().machine}, ядер {os.cpu_count()}",
    }
    rep["judge_export"] = export_judge(run_dir, ds, api)
    S.write_json(run_dir / "report.json", rep)
    (run_dir / "report.md").write_text(S.markdown(rep), "utf-8")
    return rep


def load_baseline(path: Path = BASELINE) -> dict:
    return (
        json.loads(path.read_text("utf-8"))
        if path.exists()
        else {"schema": "inspector-mutation-baseline/1", "profiles": {}}
    )


def main_baseline(ref: str | None = None) -> dict | None:
    """Базовая линия из main (OWASP T179-3): правка файла в ветке не ослабляет гейт — ветку сверяют и с main."""
    rel = BASELINE.relative_to(ROOT).as_posix()
    for r in [ref] if ref else ["main", "origin/main"]:
        out = subprocess.run(["git", "show", f"{r}:{rel}"], cwd=ROOT, capture_output=True, text=True)
        if out.returncode == 0:
            return json.loads(out.stdout)
    return None


def revisions() -> dict:
    """Ревизии разбора и извлечения прогона: базовая линия QA-07 хранится отдельно на каждую ревизию разбора."""
    from inspector_ml.docstore import PARSER_REV
    from inspector_ml.extract import EXTRACT_REV

    return {"parser_rev": PARSER_REV, "extract_rev": EXTRACT_REV}


def baseline_key(profile: str, report: dict) -> str:
    """Строка базовой линии: профиль и ревизия разбора (`full@parser4`). Смена PARSER_REV (T-184, GPU-OCR) — новая
    строка, а не ложное падение гейта: прежняя остаётся для сравнения справочно."""
    return f"{profile}@parser{report.get('parser_rev')}"


def cmd_gate(profile: str, report: dict, path: Path = BASELINE, main: dict | None | bool = True) -> int:
    """QA-07: против базовой линии ветки и, если она есть в main, против базовой линии main (без сверки набора).
    Базовой линии этой ревизии разбора нет, а другой ревизии есть — сравнение справочно, гейт не падает."""
    key = baseline_key(profile, report)
    profiles = load_baseline(path)["profiles"]
    base = profiles.get(key)
    if base is None:
        other = sorted(k for k in profiles if k.split("@")[0] == profile)
        if not other:
            print(f"QA-07: базовой линии {key} нет — соберите её командой baseline", file=sys.stderr)
            return 2
        info = S.gate(report, profiles[other[-1]], same_dataset=False)
        print(f"QA-07: базовой линии {key} нет (ревизия разбора сменилась); против {other[-1]} справочно: "
              + ("; ".join(info) if info else "без ухудшений") + f". Соберите строку командой baseline --profile {profile}", file=sys.stderr)
        return 0
    fails = S.gate(report, base)
    mb = (main_baseline() if main is True else main or None) or {}
    if key in mb.get("profiles", {}):
        fails += [f"против main: {f}" for f in S.gate(report, mb["profiles"][key], same_dataset=False)]
    if fails:
        print("QA-07 не пройден:\n  " + "\n  ".join(fails), file=sys.stderr)
        return 1
    a = report["slices"]["all"]
    print(f"QA-07 пройден ({key}): R={a['recall']} FPR={a['fpr']} P={a['precision']}, категорий {len(base['categories'])}")
    return 0


def cmd_baseline(profile: str, report: dict, path: Path = BASELINE) -> None:
    b = load_baseline(path)
    b["profiles"][baseline_key(profile, report)] = S.baseline_of(report)
    b["profiles"] = dict(sorted(b["profiles"].items()))
    path.parent.mkdir(parents=True, exist_ok=True)
    S.write_json(path, b)


def main(argv: list[str] | None = None) -> int:  # pragma: no cover — CLI и процессы
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "light"):
        r = sub.add_parser(name)
        r.add_argument(
            "--profile",
            choices=list(PROFILES),
            default="light" if name == "light" else "structural",
        )
        r.add_argument("--out", type=Path)
        r.add_argument("--parallel", type=int, default=2)
        r.add_argument("--limit", type=int)
        r.add_argument("--bootstrap", type=int, default=400)
    sm = sub.add_parser("summary", help="сводка по оператору и паре: structural и adversarial рядом")
    sm.add_argument("--out", type=Path)
    rs = sub.add_parser("rescore", help="пересчитать отчёт по dataset.json и api.json прогона, без повторного прогона")
    rs.add_argument("--profile", choices=list(PROFILES), required=True)
    rs.add_argument("--out", type=Path)
    for name in ("gate", "baseline"):
        g = sub.add_parser(name)
        g.add_argument("--profile", choices=list(PROFILES), required=True)
        g.add_argument("--report", type=Path, required=True)
    a = ap.parse_args(argv)
    if a.cmd in ("run", "light"):
        rep = run(a.profile, a.out, a.parallel, a.limit, a.bootstrap)
        s = rep["slices"].get("all", {})
        print(
            json.dumps(
                {
                    "profile": a.profile,
                    "cases": rep["cases"],
                    "failed": len(rep["failed_cases"]),
                    "recall": s.get("recall"),
                    "fpr": s.get("fpr"),
                    "timing": rep["timing"],
                },
                ensure_ascii=False,
            )
        )
        return cmd_gate(a.profile, rep) if a.cmd == "light" else 0
    if a.cmd == "summary":
        reps = {n: json.loads((ML / "var/mutations" / n / "report.json").read_text("utf-8")) for n in ("structural", "adversarial") if (ML / "var/mutations" / n / "report.json").exists()}
        md = S.side_by_side(reps)
        (a.out or ML / "var/mutations/summary.md").write_text(md, "utf-8")
        print(md)
        return 0
    if a.cmd == "rescore":
        rep = rescore(a.out or ML / "var/mutations" / a.profile, a.profile)
        print(json.dumps({"profile": a.profile, "cases": rep["cases"], "defects": len(rep["defects"])}, ensure_ascii=False))
        return 0
    rep = json.loads(a.report.read_text("utf-8"))
    if a.cmd == "gate":
        return cmd_gate(a.profile, rep)
    cmd_baseline(a.profile, rep)
    print(f"базовая линия {a.profile} записана: {BASELINE}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
