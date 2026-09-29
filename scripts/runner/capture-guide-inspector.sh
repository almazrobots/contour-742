#!/usr/bin/env bash
# Deployed main web assets; pinned real API; private synthetic memory fixture only.
set -euo pipefail
revision=c0851cc7b78e28e7bd7a477be2d3274010d42144
repo=/opt/w1-gate/wt/u/feat_verification-module.light
snapshot=$(mktemp -d /tmp/nadzorium-inspector-source-XXXXXX)
private=$(mktemp -d /tmp/nadzorium-inspector-blobs-XXXXXX)
trap 'rm -rf "$snapshot" "$private"' EXIT
git --git-dir=/opt/w1-gate/repo.git archive "$revision" | tar -x -C "$snapshot"
printf '%s\n' "$revision" > "$snapshot/PINNED-REVISION"
ln -s "$repo/node_modules" "$snapshot/node_modules"
ln -s "$repo/apps/api/node_modules" "$snapshot/apps/api/node_modules"
mkdir -p out/inspector-fixture
ml/.venv/bin/python - <<'PY'
from PIL import Image,ImageDraw,ImageFont
font=ImageFont.truetype('assets/fonts/Onest-Regular.ttf',36)
for stage,value in [('PD','11'),('RD','12')]:
    image=Image.new('RGB',(1200,800),'white');draw=ImageDraw.Draw(image)
    draw.text((60,70),'Учебный объект — проверка этажности',font=font,fill='black')
    draw.text((60,250),'Количество этажей: '+value,font=font,fill='black')
    draw.text((60,450),stage+' · лист 1 · синтетические данные',font=font,fill='#526070')
    draw.text((60,600),'Заранее подготовленный результат; OCR не запускался',font=font,fill='#526070')
    image.save('out/inspector-fixture/'+stage+'.pdf','PDF',resolution=96)
PY
DOCS_API_SOURCE="$snapshot" INSPECTOR_BLOB_DIR="$private" INSPECTOR_BLOB_STORE=fs node --import "$repo/apps/api/node_modules/tsx/dist/loader.mjs" scripts/capture-guide-inspector.mjs
