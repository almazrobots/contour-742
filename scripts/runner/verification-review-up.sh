#!/usr/bin/env bash
# Starts only the private module review containers, uses the migrated review DB.
set -euo pipefail
export DOCKER_CONFIG=/opt/w1-gate/tools/docker
code=$(git rev-parse HEAD)
root=/opt/w1-gate/eval/verification/review-runtime
staging=/opt/w1-gate/eval/verification/t244-096ba1028e71b2294600e7c340b42b03808bd032
mkdir -p "$root"
chmod 700 "$root"
builder=verification-t244
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container --driver-opt cpuset-cpus=28-31 --driver-opt memory=4g --driver-opt memory-swap=4g --driver-opt cpu-shares=128 >/dev/null
fi
docker buildx inspect --bootstrap "$builder" >/dev/null
docker buildx build --builder "$builder" --load --progress plain --build-arg REVISION="$code" -t "inspector-verification-api:$code" -f apps/api/Dockerfile . > "$root/build-api-$code.log" 2>&1
docker buildx build --builder "$builder" --load --progress plain --build-arg REVISION="$code" --build-arg VERIFICATION_ONLY=true -t "inspector-verification-web:$code" -f apps/web/Dockerfile . > "$root/build-web-$code.log" 2>&1
docker stop --time 15 "buildx_buildkit_${builder}0" >/dev/null
cat > "$root/stand.env" <<ENV
VERIFICATION_API_IMAGE=inspector-verification-api:$code
VERIFICATION_WEB_IMAGE=inspector-verification-web:$code
VERIFICATION_DATABASE_URL=postgres://inspector_app@postgres:5432/inspector?schema=inspector
VERIFICATION_STAGING_ROOT=$staging
VERIFICATION_DEPLOY_ROOT=$root
ENV
chmod 600 "$root/stand.env"
# API can traverse Reader folder, but never list it; individual imported PNGs get group-read.
chgrp 65532 "$staging/reader"
chmod 710 "$staging/reader"
mkdir -p "$staging/structured"
chgrp 65532 "$staging/structured"
chmod 710 "$staging/structured"
cp deploy/verification/compose.yml "$root/compose.yml"
mkdir -p "$root/postgres"
cp -a deploy/gpu/postgres/init "$root/postgres/"
cp deploy/gpu/postgres/pg_hba.conf "$root/postgres/"
chmod 755 "$root" "$root/postgres" "$root/postgres/init"
docker compose --env-file "$root/stand.env" -f "$root/compose.yml" up -d --no-build postgres
for attempt in $(seq 1 60); do
  if docker exec -u postgres nadzorium-verification-postgres-1 pg_isready -d inspector >/dev/null 2>&1; then break; fi
  sleep 2
done
VERIFICATION_REVIEW_PG=nadzorium-verification-postgres-1 bash scripts/runner/verification-review-prepare.sh
docker compose --env-file "$root/stand.env" -f "$root/compose.yml" up -d --no-build
for attempt in $(seq 1 60); do
  if curl --cacert /opt/stand-gpu/tls/ca.crt -fsS https://127.0.0.1:48845/health > "$root/health.json"; then
    echo "verification: private review ready on TLS localhost:48845 revision=$code";exit 0
  fi
  sleep 2
done
echo 'verification: readiness failed; private logs retained';exit 1
