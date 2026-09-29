#!/usr/bin/env bash
# Own CPU-only ML process, private blobs/cache, API memory DB. No service lifecycle commands.
set -euo pipefail
revision=c0851cc7b78e28e7bd7a477be2d3274010d42144
repo=/opt/w1-gate/wt/u/feat_verification-module.light
snapshot=$(mktemp -d /tmp/nadzorium-upload-source-XXXXXX)
private=$(mktemp -d /tmp/nadzorium-upload-blobs-XXXXXX)
mlpid=''
cleanup(){ if [ -n "$mlpid" ]; then kill "$mlpid" 2>/dev/null || true; wait "$mlpid" 2>/dev/null || true; fi; rm -rf "$snapshot" "$private"; }
trap cleanup EXIT
git --git-dir=/opt/w1-gate/repo.git archive "$revision" | tar -x -C "$snapshot"
printf '%s\n' "$revision" > "$snapshot/PINNED-REVISION"
ln -s "$repo/node_modules" "$snapshot/node_modules"
ln -s "$repo/apps/api/node_modules" "$snapshot/apps/api/node_modules"
mkdir -p out/upload-media
python="$PWD/ml/.venv/bin/python"
export INSPECTOR_PROFILE=dev INSPECTOR_LLM_PROVIDER=none INSPECTOR_VLM_BACKEND=none INSPECTOR_JUDGE_PHASE=off CUDA_VISIBLE_DEVICES='' HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export INSPECTOR_BLOB_STORE=fs INSPECTOR_BLOB_DIR="$private" INSPECTOR_CACHE=file INSPECTOR_ROOT="$snapshot" PYTHONPATH="$snapshot/ml"
export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2
"$python" - <<'PY'
import pypdfium2,fastapi,uvicorn
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from inspector_ml.app import app,health
assert health()['llm']=='none'
print('UPLOAD-SMOKE: pinned ML dependencies imported, LLM none')
pdfmetrics.registerFont(TTFont('DocsDemo','assets/fonts/Onest-Regular.ttf'))
page=canvas.Canvas('out/upload-media/DEMO-PD.pdf',pagesize=(800,600))
page.setFont('DocsDemo',18)
for i,line in enumerate(['Синтетический учебный документ','Проектная документация. Пояснительная записка.','Учебный объект — загрузка и разбор','Количество этажей: 11','Класс конструктивной пожарной опасности: С0','DEMO-PD · лист 1 · данные созданы для документации']):
    page.drawString(50,530-i*70,line)
page.save()
doc=pypdfium2.PdfDocument('out/upload-media/DEMO-PD.pdf')
assert 'Количество этажей: 11' in doc[0].get_textpage().get_text_range()
doc.close()
page=canvas.Canvas('out/upload-media/DEMO-RD.pdf',pagesize=(800,600))
page.setFont('DocsDemo',18)
for i,line in enumerate(['Синтетический дополнительный документ','Рабочая документация. Пояснительная записка.','Количество этажей: 12','DEMO-RD · лист 1 · учебные данные']):
    page.drawString(50,530-i*80,line)
page.save()

PY
port=$("$python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export INSPECTOR_REVISION="$revision" INSPECTOR_ML_URL="http://127.0.0.1:$port"
"$python" -m uvicorn inspector_ml.app:app --host 127.0.0.1 --port "$port" --log-level warning > out/upload-media/ml-process.log 2>&1 &
mlpid=$!
for attempt in $(seq 1 40); do
 kill -0 "$mlpid" 2>/dev/null || { cat out/upload-media/ml-process.log; exit 1; }
 if curl -fsS --max-time 2 "$INSPECTOR_ML_URL/health" > out/upload-media/ml-health.json; then break; fi
 sleep 1
done
test -s out/upload-media/ml-health.json
DOCS_API_SOURCE="$snapshot" node --import "$repo/apps/api/node_modules/tsx/dist/loader.mjs" scripts/capture-guide-upload.mjs
