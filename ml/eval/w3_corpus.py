"""Замер параметров W3 на корпусе «Хакатон» на раннере (T-210, OS-INSP-6.5.70): тот же конвейер, что `w3_eval`, — извлечение
по паспорту через реестр `EXTRACTORS` и оценка домена через мост `apps/api/scripts/w3-eval.ts`, — но документы берутся
из каталога корпуса и кэша разбора r4, а наружу выходят только агрегаты.

Режим корпуса (docs/ops/REMOTE-RUNNER.md, «Корпус на раннере»; ADR-0002): каталог и кэш — только чтение (файл кэша
читается напрямую, без FileCache: тот создаёт каталог); наружу (--out, --md, stdout, логи раннера) — только числа по коду
параметра и коду объекта: без текстов, цитат, имён файлов и папок, страниц, ФИО. Разбор для ручного просмотра кандидатов —
только в --detail-dir (на раннере /opt/w1-gate/eval/w3): каталог 700, файлы 600 (umask 077), временные файлы моста — там же.

    .venv/bin/python -m eval.w3_corpus --catalog /opt/corpus/catalog --cache /opt/inspector/cache \\
        --params M-033,M-048 --limit-docs 10 --out ../var/w3/corpus.json --md ../var/w3/corpus.md \\
        --detail-dir /opt/w1-gate/eval/w3

Каталог — JSONL `scripts/corpus-to-s3.py` (archive, path, sha256, bytes, object; строки `mark` и `error` пропускаются).
Архивы вне пакетов объектов (02 — эталонная разметка и методика, «РАЗМЕЧЕННЫЙ_*» — копии с наложенной разметкой,
`_ZIP_ДУБЛИ`) исключаются явно по полю archive (--exclude-archive) и считаются в `skipped.archive_excluded`.
Стадия, раздел и шифр — тем же путём, что у загрузчика пакета `cli/load-package.ts` (мост `apps/api/scripts/w3-registry.ts`:
isJunk, isRegistryFile, dedupeBySha, deriveRegistry): стадия по ближайшей папке («01_Проектная документация», «РД»…), иначе
по букве стадии в шифре имени, иначе ПД по умолчанию — такие документы считаются в `no_stage` с причиной (нет шифра в
имени / шифр без стадии) и, как у системы, читаются ПД; --skip-default-stage их не читает. Комплект ПД — базовые шифры
РД объекта (LNK-01, как services/inspections.ts); утверждение — как у загрузчика с --approval.
Документ — `parsed-<sha>-r<PARSER_REV>` из кэша; нет в кэше — `not_cached` с разбивкой по расширению (разбор здесь не
запускается).

Код объекта наружу: `object_code` строки каталога, иначе --object-map (JSON {папка или архив: код}), иначе папка, если она
уже похожа на код (ALT-79B), иначе псевдоним OBJ-<8 hex> — соответствие псевдонимов папкам лежит только в --detail-dir.
Правило №0: первый прогон — --limit-docs 10, в агрегате пик RAM (своего процесса и моста) и время.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import resource
import subprocess
import tempfile
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from inspector_ml.docstore import parsed_key
from inspector_ml.model import ParsedDoc

from .w3_eval import ABSTAIN, ROOT, SKIPPED, evaluate_rows, extractor_for, mention

CODE_RE = re.compile(r"^[A-Z]{2,5}-[0-9A-Z]{1,6}$")
STAGES = ("PD", "RD", "ID")
EXCLUDE_ARCHIVES = r"^(02_|РАЗМЕЧЕНН|_ZIP_ДУБЛИ)"


def object_code(row: dict, objmap: dict[str, str]) -> str:
    if row.get("object_code"):
        return row["object_code"]
    obj, arc = row.get("object") or "", row.get("archive") or ""
    if obj in objmap or arc in objmap:
        return objmap.get(obj) or objmap[arc]
    if CODE_RE.match(obj):
        return obj
    return "OBJ-" + hashlib.sha256(f"{arc}/{obj}".encode()).hexdigest()[:8]


def read_catalog(path: Path) -> list[dict]:
    files = sorted(path.glob("*.jsonl")) if path.is_dir() else [path]
    rows = []
    for f in files:
        for x in f.read_text("utf-8").splitlines():
            if not x.strip():
                continue
            r = json.loads(x)
            if "mark" in r or "error" in r or not r.get("sha256"):
                continue
            rows.append(r)
    return rows


def load_doc(cache: Path, sha: str) -> ParsedDoc | None:
    for p in (cache / f"{parsed_key(sha)}.json", cache / parsed_key(sha)):
        if p.is_file():
            return ParsedDoc.model_validate_json(p.read_text("utf-8"))
    return None


def peak_mb() -> dict:
    """Пик резидентной памяти: ru_maxrss — КБ на Linux, байты на macOS."""
    k = 1 / 1024 if sys.platform != "darwin" else 1 / 1024 / 1024
    return {
        "self_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * k, 1),
        "bridge_mb": round(
            resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * k, 1
        ),
    }


def secure_dir(d: Path) -> Path:
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(d, 0o700)
    return d


def registry(
    groups: dict[str, list[dict]], tmp_root: Path | None = None
) -> tuple[dict[tuple[str, str], dict], dict[str, set[str]], int]:
    """Реестр пакета каждого объекта путём загрузчика (мост w3-registry.ts, один вызов): строки по (объект, sha) и
    базовые шифры РД объекта."""
    if not groups:
        return {}, {}, 0
    with tempfile.TemporaryDirectory(dir=tmp_root) as tmp:
        src, dst = Path(tmp) / "in.jsonl", Path(tmp) / "out.jsonl"
        src.write_text(
            "".join(
                json.dumps(
                    {
                        "object": code,
                        "files": [
                            {"path": r["path"], "sha256": r["sha256"], "size": r.get("bytes", 0)}
                            for r in rows
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n"
                for code, rows in groups.items()
            ),
            "utf-8",
        )
        subprocess.run(
            ["npx", "tsx", "scripts/w3-registry.ts", str(src), str(dst)],
            cwd=ROOT / "apps/api",
            check=True,
        )
        files: dict[tuple[str, str], dict] = {}
        kits: dict[str, set[str]] = {}
        dups = 0
        for x in dst.read_text("utf-8").splitlines():
            if not x:
                continue
            r = json.loads(x)
            if "kit_bases" in r:
                kits[r["object"]] = set(r["kit_bases"])
            elif r["status"] == "duplicate":
                dups += 1
            elif files.get((r["object"], r["sha256"]), {}).get("status") != "ok":
                files[(r["object"], r["sha256"])] = r
        return files, kits, dups


def run(
    catalog: Path,
    cache: Path,
    params: list[str],
    *,
    objects: set[str] | None = None,
    limit_docs: int | None = None,
    objmap: dict[str, str] | None = None,
    detail_dir: Path | None = None,
    exclude_archive: str | None = EXCLUDE_ARCHIVES,
    skip_default_stage: bool = False,
    evaluate=None,
    reg_fn=None,
) -> dict:
    t0 = time.perf_counter()
    objmap = objmap or {}
    exs = {p: extractor_for(p) for p in params}
    counts: Counter = Counter()
    skipped: Counter = Counter()
    no_stage: Counter = Counter()
    not_cached: Counter = Counter()
    stage_src: Counter = Counter()
    groups: dict[str, list[dict]] = defaultdict(list)
    names: dict[str, str] = {}
    for r in read_catalog(catalog):
        if exclude_archive and re.search(exclude_archive, r.get("archive") or ""):
            skipped["archive_excluded"] += 1
            continue
        code = object_code(r, objmap)
        if objects and code not in objects:
            continue
        names[code] = f"{r.get('archive', '')}/{r.get('object', '')}"
        groups[code].append(r)
    tmp_root = secure_dir(detail_dir / "tmp") if detail_dir else None
    reg, kits, skipped["duplicate"] = (reg_fn or registry)(dict(groups), tmp_root)
    docs: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    for code, rows_ in groups.items():
        for r in rows_:
            g = reg.get((code, r["sha256"]))
            if g is None or g.get("_seen"):  # дубликат по SHA-256 — посчитан реестром
                continue
            g["_seen"] = True
            if g["status"] != "ok":
                skipped[g["status"]] += 1
                continue
            stage_src[g["stage_source"]] += 1
            if g["stage_source"] == "default":
                counts["no_stage"] += 1
                no_stage["cipher_without_stage" if g["code_from_name"] else "no_cipher"] += 1
                if skip_default_stage:
                    skipped["default_stage"] += 1
                    continue
            docs[code].append((g, r))
    counts["objects"] = len(docs)
    # по (параметр, объект): упоминания для моста, документы с упоминаниями по стадиям, отсевы по кодам
    ms: dict[tuple[str, str], list[dict]] = defaultdict(list)
    with_m: dict[tuple[str, str], Counter] = defaultdict(Counter)
    loaded: dict[str, set[str]] = defaultdict(set)
    detail_docs: list[dict] = []
    for code in sorted(docs):
        for i, (g, r) in enumerate(docs[code]):
            stage = g["doc_stage"]
            if limit_docs is not None and counts["docs_read"] >= limit_docs:
                counts["limited"] += 1
                continue
            doc = load_doc(cache, r["sha256"])
            if doc is None:
                counts["not_cached"] += 1
                ext = (r.get("ext") or Path(r["path"]).suffix).lower()
                not_cached[ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext) else "other"] += 1
                continue
            counts["docs_read"] += 1
            counts[f"docs_{stage}"] += 1
            loaded[code].add(stage)
            fid = f"{stage}-{i}"
            detail_docs.append({"object": code, "file_id": fid, "sha256": r["sha256"], "path": r["path"], **{k: g[k] for k in ("doc_stage", "stage_source", "discipline", "document_code")}})
            for p, got in exs.items():
                if got is None:
                    continue
                ex, spec = got
                found = ex.extract(doc, spec)
                if found:
                    with_m[(p, code)][stage] += 1
                ms[(p, code)] += [mention(stage, fid, g["discipline"], e, ex.fields, r["sha256"], g) for e in found]
            del doc
    rows = [
        {
            "id": f"{p}|{code}",
            "code": p,
            "mentions": ms[(p, code)],
            "loadedStages": sorted(loaded[code]),
            "kitBases": sorted(kits.get(code, set())),
        }
        for p in params
        if exs[p] is not None
        for code in sorted(docs)
    ]
    res = (evaluate or evaluate_rows)(rows, tmp_root) if rows else {}
    agg = aggregate(params, sorted(docs), res, ms, with_m, exs)
    base = ("objects", "docs_read", "docs_PD", "docs_RD", "docs_ID", "not_cached", "no_stage", "limited")
    agg["run"] = {
        **{k: counts[k] for k in base},
        "no_stage_reason": dict(no_stage),
        "stage_source": dict(stage_src),
        "skipped": dict(skipped),
        "not_cached_ext": dict(not_cached),
        "params": params,
        "limit_docs": limit_docs,
        "seconds": round(time.perf_counter() - t0, 2),
        "peak_rss": peak_mb(),
    }
    if detail_dir:
        write_detail(detail_dir, names, detail_docs, res, ms)
    return agg


def aggregate(params, objs, res, ms, with_m, exs) -> dict:
    by_param: dict[str, dict] = {}
    by_obj: dict[str, dict] = {}
    for p in params:
        st: Counter = Counter()
        docs_m: Counter = Counter()
        exc: Counter = Counter()
        n_m = 0
        for code in objs:
            status = res.get(f"{p}|{code}", {}).get("status") if exs[p] else SKIPPED
            status = status or SKIPPED
            st[status] += 1
            docs_m.update(with_m[(p, code)])
            e = Counter(m["excluded"] for m in ms[(p, code)] if m.get("excluded"))
            exc.update(e)
            n_m += len(ms[(p, code)])
            by_obj[f"{p}|{code}"] = {
                "param": p,
                "object": code,
                "status": status,
                "docs_with_mentions": {s: with_m[(p, code)][s] for s in STAGES},
                "mentions": len(ms[(p, code)]),
                "excluded": dict(e),
            }
        by_param[p] = {
            "objects": len(objs),
            "status": dict(st),
            "abstain": sum(v for k, v in st.items() if k in ABSTAIN),
            "docs_with_mentions": {s: docs_m[s] for s in STAGES},
            "mentions": n_m,
            "excluded": dict(exc),
            "excluded_share": {k: round(v / n_m, 3) for k, v in exc.items()}
            if n_m
            else {},
        }
    return {"by_param": by_param, "by_param_object": by_obj}


def write_detail(d: Path, names, detail_docs, res, ms) -> None:
    """Подробный разбор — только на сервере: каталог 700, файлы 600."""
    old = os.umask(0o077)
    try:
        secure_dir(d)
        (d / "objects.json").write_text(
            json.dumps(names, ensure_ascii=False, indent=1), "utf-8"
        )
        with open(d / "detail.jsonl", "w", encoding="utf-8") as f:
            for dd in detail_docs:
                f.write(json.dumps({"doc": dd}, ensure_ascii=False) + "\n")
            for key, r in res.items():
                p, code = key.split("|", 1)
                f.write(
                    json.dumps(
                        {"param": p, "object": code, **r, "mentions": ms[(p, code)]},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        for f in d.iterdir():
            if f.is_file():
                os.chmod(f, 0o600)
    finally:
        os.umask(old)


def _kv(d: dict) -> str:
    return ", ".join(f"{k} {v}" for k, v in sorted(d.items()) if v) or "—"


def to_md(agg: dict) -> str:
    run_ = agg["run"]
    out = [
        "## Замер W3 на корпусе — только агрегаты",
        "",
        f"Объектов {run_.get('objects', 0)}, документов прочитано {run_.get('docs_read', 0)} (ПД {run_.get('docs_PD', 0)}, РД {run_.get('docs_RD', 0)}, ИД {run_.get('docs_ID', 0)}), "
        f"нет в кэше {run_.get('not_cached', 0)}, без стадии {run_.get('no_stage', 0)}, срезано лимитом {run_.get('limited', 0)}; "
        f"{run_['seconds']} с, пик RAM {run_['peak_rss']['self_mb']} МБ (мост {run_['peak_rss']['bridge_mb']} МБ).",
        "",
        f"Стадия по источнику: {_kv(run_['stage_source'])}; без стадии (ПД по умолчанию) по причине: {_kv(run_['no_stage_reason'])}; "
        f"не документы пакета: {_kv(run_['skipped'])}; нет в кэше по расширению: {_kv(run_['not_cached_ext'])}.",
        "",
        "| Параметр | Объектов | CANDIDATE | NEGATIVE_VERIFIED | Воздержания | SKIPPED | Док. с упоминаниями ПД/РД/ИД | Упоминаний | Отсевы |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for p, m in agg["by_param"].items():
        st, dm = m["status"], m["docs_with_mentions"]
        ab = ", ".join(f"{k} {v}" for k, v in sorted(st.items()) if k in ABSTAIN) or "0"
        exc = (
            ", ".join(f"{k} {v}" for k, v in sorted(m["excluded_share"].items())) or "—"
        )
        out.append(
            f"| {p} | {m['objects']} | {st.get('CANDIDATE', 0)} | {st.get('NEGATIVE_VERIFIED', 0)} | {ab} | {st.get(SKIPPED, 0)} | {dm['PD']}/{dm['RD']}/{dm['ID']} | {m['mentions']} | {exc} |"
        )
    out += [
        "",
        "| Параметр | Объект | Статус | Док. ПД/РД/ИД | Упоминаний |",
        "|---|---|---|---|---|",
    ]
    for m in agg["by_param_object"].values():
        dm = m["docs_with_mentions"]
        out.append(
            f"| {m['param']} | {m['object']} | {m['status']} | {dm['PD']}/{dm['RD']}/{dm['ID']} | {m['mentions']} |"
        )
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="/opt/corpus/catalog")
    ap.add_argument("--cache", default="/opt/inspector/cache")
    ap.add_argument("--params", required=True, help="коды через запятую")
    ap.add_argument("--objects", help="коды объектов через запятую")
    ap.add_argument("--limit-docs", type=int)
    ap.add_argument("--object-map")
    ap.add_argument("--detail-dir")
    ap.add_argument("--exclude-archive", default=EXCLUDE_ARCHIVES, help="regex по полю archive; пусто — не исключать")
    ap.add_argument("--skip-default-stage", action="store_true")
    ap.add_argument("--out", required=True)
    ap.add_argument("--md")
    a = ap.parse_args(argv)
    agg = run(
        Path(a.catalog),
        Path(a.cache),
        [x.strip() for x in a.params.split(",") if x.strip()],
        objects={x.strip() for x in a.objects.split(",")} if a.objects else None,
        limit_docs=a.limit_docs,
        objmap=json.loads(Path(a.object_map).read_text("utf-8"))
        if a.object_map
        else None,
        detail_dir=Path(a.detail_dir) if a.detail_dir else None,
        exclude_archive=a.exclude_archive or None,
        skip_default_stage=a.skip_default_stage,
    )
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(agg, ensure_ascii=False, indent=1), "utf-8")
    md = to_md(agg)
    if a.md:
        Path(a.md).write_text(md, "utf-8")
    print(md)


if __name__ == "__main__":
    main()
