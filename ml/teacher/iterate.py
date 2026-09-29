"""Итерация дообучения верификатора извлечения — воспроизводимая командами (T-076, OS-INSP-6.4.11–6.4.14).

    python -m teacher.iterate release --holdout "Изумрудная, 12" --released-by <куратор>
    python -m teacher.iterate train --dataset teacher-XXXX --model-version ev-1 --trained-by <ML-инженер>
    python -m teacher.iterate publish --model-version ev-1 --approved-by <ответственный>
    python -m teacher.iterate rollback --by <ответственный> --reason "…"
    python -m teacher.iterate sft --dataset teacher-XXXX

Набор с текстами строк — `var/teacher/datasets/` (вне git). В git — `ml/artifacts/extract-verifier/`: веса, реестр и
паспорт набора (хеши выборок, объекты, счётчики) без текстов документов.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

from inspector_ml import verifier as V
from inspector_ml import verifier_registry as R
from inspector_ml.paths import repo_root

from . import labels as L
from .harvest import OUT, sealed_shas

ROOT = repo_root()
ART = ROOT / "ml/artifacts/extract-verifier"
MATRIX = ROOT / "data/seed/matrix.json"


def _jsonl(p: Path) -> list[dict]:
    return [json.loads(line) for line in p.open()] if p.exists() else []


def passport(ds: dict) -> dict:
    """Паспорт набора для репозитория: без строк документов — только хеши, объекты и счётчики."""
    items = ds["items"]
    return {
        "dataset_version": ds["dataset_version"],
        "released_by": ds["released_by"],
        "labelers": ds["labelers"],
        "split_hashes": ds["split_hashes"],
        "objects": ds["objects"],
        "counts": {
            s: dict(Counter(it["label"] for it in items if it["split"] == s))
            for s in ds["split_hashes"]
        },
        "reject_reasons": dict(
            Counter(it["reason"] for it in items if it["label"] == "REJECT")
        ),
        "codes": len({it["code"] for it in items}),
    }


def code_hash() -> str:
    src = (ROOT / "ml/inspector_ml/verifier.py").read_bytes()
    return hashlib.sha256(src).hexdigest()


def matrix_version() -> str:
    return "matrix-sha256-" + hashlib.sha256(MATRIX.read_bytes()).hexdigest()[:12]


def labels_snapshot(version: str) -> Path:
    """Снимок меток, по которым выпущен набор: метки дописываются, а повтор итерации идёт по снимку."""
    return OUT / "datasets" / f"{version}.labels.jsonl"


def cmd_release(a) -> None:  # pragma: no cover — IO
    labels = _jsonl(OUT / "labels.jsonl")
    ds = L.release(_jsonl(OUT / "queue.jsonl"), labels, set(a.holdout), a.released_by,
                   set(a.validation) if a.validation else None, frozenset(sealed_shas()))
    d = OUT / "datasets"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{ds['dataset_version']}.json").write_text(json.dumps(ds, ensure_ascii=False), "utf-8")
    snap = labels_snapshot(ds["dataset_version"])
    snap.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in labels), "utf-8")
    pp = passport(ds) | {"labels_sha256": hashlib.sha256(snap.read_bytes()).hexdigest()}
    (ART / "datasets").mkdir(parents=True, exist_ok=True)
    (ART / "datasets" / f"{ds['dataset_version']}.json").write_text(json.dumps(pp, ensure_ascii=False, indent=1) + "\n", "utf-8")
    print(json.dumps(pp, ensure_ascii=False, indent=1))


def cmd_train(a) -> None:  # pragma: no cover — IO
    ds = json.loads((OUT / "datasets" / f"{a.dataset}.json").read_text("utf-8"))
    params = V.TrainParams(l2=a.l2, min_keep=a.min_keep)
    res = V.train(ds["items"], params)
    entry = R.record_iteration(
        ART,
        res,
        {
            "model_version": a.model_version,
            "dataset_version": ds["dataset_version"],
            "split_hashes": ds["split_hashes"],
            "matrix_version": matrix_version(),
            "training_code_hash": code_hash(),
            "params": vars(params),
            "trained_by": a.trained_by,
            "labeler": ds["labelers"],
        },
    )
    print(
        json.dumps(
            {k: entry[k] for k in ("model_version", "status", "weights_hash", "gate")},
            ensure_ascii=False,
            indent=1,
        )
    )
    print(json.dumps(entry["metrics"]["test"], ensure_ascii=False))


def cmd_publish(a) -> None:  # pragma: no cover — IO
    print(json.dumps(R.publish(ART, a.model_version, a.approved_by)["status"]))


def cmd_rollback(a) -> None:  # pragma: no cover — IO
    back = R.rollback(ART, a.by, a.reason)
    print(json.dumps(back["model_version"] if back else None))


def cmd_sft(a) -> None:  # pragma: no cover — IO
    ds = json.loads((OUT / "datasets" / f"{a.dataset}.json").read_text("utf-8"))
    out = OUT / f"sft-{a.dataset}.jsonl"
    with out.open("w") as f:
        for it in ds["items"]:
            f.write(json.dumps(L.sft_record(it), ensure_ascii=False) + "\n")
    print(out)


def main() -> None:  # pragma: no cover
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(required=True)
    r = sub.add_parser("release")
    r.add_argument("--holdout", action="append", required=True)
    r.add_argument("--validation", action="append")
    r.add_argument("--released-by", required=True)
    r.set_defaults(fn=cmd_release)
    t = sub.add_parser("train")
    t.add_argument("--dataset", required=True)
    t.add_argument("--model-version", required=True)
    t.add_argument("--trained-by", required=True)
    t.add_argument("--l2", type=float, default=1.0)
    t.add_argument("--min-keep", type=float, default=0.98)
    t.set_defaults(fn=cmd_train)
    p = sub.add_parser("publish")
    p.add_argument("--model-version", required=True)
    p.add_argument("--approved-by", required=True)
    p.set_defaults(fn=cmd_publish)
    b = sub.add_parser("rollback")
    b.add_argument("--by", required=True)
    b.add_argument("--reason", required=True)
    b.set_defaults(fn=cmd_rollback)
    s = sub.add_parser("sft")
    s.add_argument("--dataset", required=True)
    s.set_defaults(fn=cmd_sft)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":  # pragma: no cover
    main()
