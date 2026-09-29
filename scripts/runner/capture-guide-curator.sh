#!/usr/bin/env bash
# Isolated real API; synthetic source; no production mutations or GPU.
set -euo pipefail
revision=df65e1884788b64ecdec76b73134d9eb75faec2d
repo=/opt/w1-gate/wt/u/feat_verification-module.light
snapshot=$(mktemp -d /tmp/nadzorium-curator-source-XXXXXX)
private=$(mktemp -d /tmp/nadzorium-curator-corpus-XXXXXX)
trap 'rm -rf "$snapshot" "$private"' EXIT
git --git-dir=/opt/w1-gate/repo.git archive "$revision" | tar -x -C "$snapshot"
printf '%s\n' "$revision" > "$snapshot/PINNED-REVISION"
ln -s "$repo/node_modules" "$snapshot/node_modules"
ln -s "$repo/apps/api/node_modules" "$snapshot/apps/api/node_modules"
mkdir -p out/curator-media
ml/.venv/bin/python - <<'PY'
from PIL import Image,ImageDraw,ImageFont
image=Image.new('RGB',(1200,500),'white');draw=ImageDraw.Draw(image)
font=ImageFont.truetype('assets/fonts/Onest-Regular.ttf',36)
draw.text((50,50),'Учебный пример: синтетический документ',font=font,fill='black')
draw.text((50,170),'Количество этажей: 11',font=font,fill='black')
draw.text((50,300),'ПД · лист 1 · для независимого разбора',font=font,fill='#526070')
image.save('out/curator-media/synthetic-original.png')
PY
DOCS_API_SOURCE="$snapshot" INSPECTOR_VERIFICATION_CORPUS_DIR="$private" node --import "$repo/apps/api/node_modules/tsx/dist/loader.mjs" scripts/capture-guide-curator.mjs
