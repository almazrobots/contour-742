#!/usr/bin/env bash
set -euo pipefail
revision=c0851cc7b78e28e7bd7a477be2d3274010d42144
repo=/opt/w1-gate/wt/u/feat_verification-module.light
snapshot=$(mktemp -d /tmp/nadzorium-references-source-XXXXXX)
private=$(mktemp -d /tmp/nadzorium-references-blobs-XXXXXX)
trap 'rm -rf "$snapshot" "$private"' EXIT
git --git-dir=/opt/w1-gate/repo.git archive "$revision" | tar -x -C "$snapshot"
printf '%s\n' "$revision" > "$snapshot/PINNED-REVISION"
ln -s "$repo/node_modules" "$snapshot/node_modules"
ln -s "$repo/apps/api/node_modules" "$snapshot/apps/api/node_modules"
DOCS_API_SOURCE="$snapshot" INSPECTOR_BLOB_DIR="$private" INSPECTOR_BLOB_STORE=fs node --import "$repo/apps/api/node_modules/tsx/dist/loader.mjs" scripts/capture-guide-references.mjs
