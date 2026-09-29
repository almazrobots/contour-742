#!/usr/bin/env bash
set -euo pipefail
out=/opt/w1-gate/eval/verification/ui-keyboard-$(git rev-parse --short HEAD)
mkdir -p "$out"
chmod 700 "$out"
export VERIFICATION_UI_OUT="$out"
ml/.venv/bin/python - <<'PY'
import os
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
image=Image.new('RGB',(1200,500),'white');draw=ImageDraw.Draw(image)
font=ImageFont.truetype('assets/fonts/Onest-Regular.ttf',36)
draw.text((50,60),'Синтетический лист для проверки интерфейса',font=font,fill='black')
draw.text((50,160),'Количество этажей: 11',font=font,fill='black')
draw.rectangle((35,140,650,220),outline='#e9a600',width=4)
image.save(Path(os.environ['VERIFICATION_UI_OUT'])/'synthetic.png')
PY
node scripts/runner/verification-keyboard-smoke.mjs
node scripts/runner/verification-prefetch-smoke.mjs
node scripts/runner/verification-library-smoke.mjs
