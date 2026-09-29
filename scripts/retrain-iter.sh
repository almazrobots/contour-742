#!/usr/bin/env bash
# Воспроизведение итерации дообучения верификатора извлечения (T-076, ТЗ §9.4, Q&A #24).
# Вход: очередь и метки учителя в var/teacher (вне git). Ничего не пишет: выпускает набор и обучает в памяти и
# сверяет с реестром ml/artifacts/extract-verifier — тот же dataset_version, те же хеши выборок, тот же хеш весов.
# Использование: scripts/retrain-iter.sh <model_version>
set -euo pipefail
cd "$(dirname "$0")/../ml"
.venv/bin/python - "${1:?model_version}" <<'EOF'
import hashlib, json, sys
from inspector_ml import verifier as V
from teacher import labels as L
from teacher.harvest import OUT, sealed_shas
from teacher.iterate import ART

ver = sys.argv[1]
reg = json.loads((ART / "registry.json").read_text("utf-8"))
it = next(i for i in reg["iterations"] if i["model_version"] == ver)
pp = json.loads((ART / "datasets" / f"{it['dataset_version']}.json").read_text("utf-8"))
rows = lambda p: [json.loads(x) for x in p.open()]
snap = OUT / "datasets" / f"{it['dataset_version']}.labels.jsonl"  # метки на момент выпуска
if pp.get("labels_sha256"):
    assert hashlib.sha256(snap.read_bytes()).hexdigest() == pp["labels_sha256"], "снимок меток изменён"
ds = L.release(rows(OUT / "queue.jsonl"), rows(snap), set(pp["objects"]["test"]), "replay",
               set(pp["objects"]["validation"]), frozenset(sealed_shas()))
assert ds["dataset_version"] == it["dataset_version"], (ds["dataset_version"], it["dataset_version"])
assert ds["split_hashes"] == it["split_hashes"], "хеши выборок разошлись"
p = it["params"]
res = V.train(ds["items"], V.TrainParams(l2=p["l2"], min_count=p["min_count"], min_keep=p["min_keep"], max_iter=p["max_iter"]))
assert res["weights_hash"] == it["weights_hash"], (res["weights_hash"], it["weights_hash"])
print(f"воспроизведено: {ver} · {ds['dataset_version']} · weights sha256 {res['weights_hash']}")
EOF
