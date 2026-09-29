#!/usr/bin/env bash
# Rebuild deployed web source before applying only the registry component.
set -euo pipefail
base=c0851cc7b78e28e7bd7a477be2d3274010d42144
scratch=$(mktemp -d /tmp/nadzorium-files-build-XXXXXX)
trap 'rm -rf "$scratch"' EXIT
git --git-dir=/opt/w1-gate/repo.git archive "$base" | tar -x -C "$scratch"
ln -s "$PWD/node_modules" "$scratch/node_modules"
ln -s "$PWD/apps/web/node_modules" "$scratch/apps/web/node_modules"
python3 - "$scratch" <<'MENU'
import sys
from pathlib import Path
p=Path(sys.argv[1])/'apps/web/src/main.tsx'
s=p.read_text()
anchor='        {link("/new", "upload", "Загрузка", canWork(role))}'
assert s.count(anchor)==1
links='\n        {["inspector","supervisor","admin","curator"].includes(role)&&<a href="/verification/#/verification" title="Разметка данных"><Icon name="list" size={20}/>Разметка данных</a>}\n        {["inspector","supervisor","admin","curator"].includes(role)&&<a href="/verification/#/verification-library" title="Витрина разметки"><Icon name="matrix" size={20}/>Витрина разметки</a>}'
p.write_text(s.replace(anchor,anchor+links))
MENU
mkdir -p out/files-candidate
pnpm --dir "$scratch/apps/web" build
cp "$scratch/apps/web/dist/index.html" out/files-candidate/baseline-index.html
sha256sum "$scratch"/apps/web/dist/assets/index-*.js "$scratch"/apps/web/dist/assets/index-*.css > out/files-candidate/baseline-sha.txt
cp apps/web/src/pages/Files.tsx "$scratch/apps/web/src/pages/Files.tsx"
pnpm --dir "$scratch/apps/web" build
cp -R "$scratch/apps/web/dist" out/files-candidate/dist
printf '%s\n' "$base" > out/files-candidate/base-revision.txt
git rev-parse HEAD > out/files-candidate/patch-revision.txt
