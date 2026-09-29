#!/usr/bin/env bash
# Локальный гейт на маке (T-104): те же шаги, что .github/workflows/ci-gate.yml, до trivy включительно.
# Решение владельца 2026-09-26: пока нет удалённого раннера, гейт гоняется здесь. Правишь шаг гейта —
# правь его и в ci-gate.yml.
#   scripts/heavy.sh scripts/local-gate.sh          полный прогон: тесты, образы, smoke, trivy
#   scripts/heavy.sh scripts/local-gate.sh --quick  без Docker: страж, gitleaks, pnpm test, тесты ML
# Отличия от удалённого гейта: образы arm64 (стенд x86), нет публикации в реестр и digest для деплоя.
set -euo pipefail
cd "$(dirname "$0")/.."
QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
t0=$(date +%s)

# правило №0: меньше 20 ГБ — своп некуда расти, тяжёлое не запускаем (удалённый гейт требует ≥ 10)
free_gb=$(( $(df -Pk / | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$free_gb" -ge 20 ] || { echo "свободно ${free_gb} ГБ < 20 — сначала освободить место (правило №0)"; exit 1; }

SHA=$(git rev-parse --short=12 HEAD)
git diff --quiet HEAD -- . ':!.claude' || SHA="$SHA-dirty"   # незакоммиченное собирается под отдельной меткой

step "страж настроек безопасности (ветка против origin/main)"
git fetch -q origin main || true
BASE=$(git merge-base origin/main HEAD)
[ "$BASE" = "$(git rev-parse HEAD)" ] && BASE=$(git rev-parse HEAD~1)   # на main — последний коммит
node scripts/security-guard.mjs "$BASE" "$(git rev-parse HEAD)"

step "gitleaks"
# с мака ghcr.io отдаёт Docker «denied» даже анонимно — берём бинарь той же версии, что закреплена в ci-gate.yml
GL_VER=8.30.1
command -v gitleaks >/dev/null && [ "$(gitleaks version)" = "$GL_VER" ] \
  || { echo "нужен gitleaks $GL_VER (brew install gitleaks), стоит: $(gitleaks version 2>/dev/null || echo нет)"; exit 1; }
gitleaks detect --source=. --gitleaks-ignore-path=.gitleaksignore --redact --no-banner

step "pnpm test (API, веб, deploy, трасса ГЕРЫ)"
pnpm test

step "тесты ML (окружение из uv.lock)"
# --inexact: ml/.venv общий (рабочие копии смотрят на него симлинком, стенд ML на маке берёт из него mlx). Точный sync
# удалял extra mlx, а с ним opencv-python — и общий каталог cv2/ у opencv-python-headless: import cv2 падал у всех (27.09);
# переустановка headless из кэша чинит cv2, если venv уже сломал гейт со старым скриптом.
(
  cd ml
  ml_workers=${ML_TEST_WORKERS:-2}
  case "$ml_workers" in [1-8]) ;; *) echo "ML_TEST_WORKERS должен быть целым числом 1..8" >&2; exit 64 ;; esac
  sync_args=(--locked --inexact --python 3.12 --extra dev --extra semantic)
  # Linux runner имеет отдельную venv: locked sync достаточен; ремонт общей Mac venv сохраняем.
  if [ "$(uname -s)" = Darwin ]; then sync_args+=(--reinstall-package opencv-python-headless); fi
  uv sync "${sync_args[@]}"
  .venv/bin/pytest -q -n "$ml_workers" --dist loadfile -m 'not performance' --durations=30
  # Приёмочные временные пороги не конкурируют с функциональными workers.
  .venv/bin/pytest -q -n 0 -m performance
)

# T-179, OS-INSP-6.5.47: стенд мутаций L11, лёгкий профиль (65 примеров, ~25 с, 2 потока) через настоящие ML /analyze и пересчёт API;
# падение Recall обязательной категории или рост FPR > 2 п.п. против ml/eval/baselines/w1-mutations.json роняет гейт.
# Полный профиль (726 примеров) — отдельно, на раннере: scripts/remote-run.sh "cd ml && .venv/bin/python -m eval.mutation_run run --profile structural --parallel 3"
step "стенд мутаций L11 — лёгкий профиль, гейт QA-07"
# T-233 (решение владельца 28.09): на этапе сведения веток мутации выключаются GATE_SKIP_MUTATIONS=1 — полный прогон
# мутаций и актуализация порогов — в конце, одним заходом; пропуск виден в логе гейта
if [ "${GATE_SKIP_MUTATIONS:-}" = 1 ]; then echo "  ПРОПУЩЕН: GATE_SKIP_MUTATIONS=1 (T-233) — гейт не полный, мутации обязательны перед main"
else ( cd ml && .venv/bin/python -m eval.mutation_run light --parallel 2 ); fi

if [ "$QUICK" = 1 ]; then echo; echo "local-gate --quick: зелёный за $(( $(date +%s) - t0 )) с (без Docker)"; exit 0; fi

cleanup() {
  docker rm -f smoke-ml smoke-api smoke-web >/dev/null 2>&1 || true
  docker network rm smoke-net >/dev/null 2>&1 || true
  rm -rf smoke-tls
  for img in api ml ml-gpu web; do docker image rm -f "inspector-$img:$SHA" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

# NFR-STAND: hadolint до сборки — плохой Dockerfile не должен тратить минуты сборки. Образ по digest (v2.15.1),
# порог по умолчанию (info): предупреждения гасятся только точечным «# hadolint ignore=DLxxxx» с причиной рядом.
step "hadolint (api, ml, web)"
HADOLINT="hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d"
for df in apps/api/Dockerfile ml/Dockerfile apps/web/Dockerfile; do
  echo "  $df"; docker run --rm -i "$HADOLINT" hadolint - < "$df"
done

# Стенд (deploy/stand): compose собирается и интерполируется на заглушках — опечатка в ключе или ${…:?} видна до up
step "docker compose config: deploy/stand/compose.yml"
STAND_CHECK=$(mktemp -d)
printf '%s\n' "INSPECTOR_BLOB_STORE=fs" > "$STAND_CHECK/s3.env"
{ grep -E '^[A-Z_]+_IMAGE=' deploy/stand/images.env
  printf '%s\n' "API_IMAGE=inspector-api:$SHA" "ML_IMAGE=inspector-ml:$SHA" "WEB_IMAGE=inspector-web:$SHA" \
    "STAND_VAR=$STAND_CHECK" "S3_SECRETS_DIR=$STAND_CHECK"; } > "$STAND_CHECK/stand.env"
docker compose --env-file "$STAND_CHECK/stand.env" -f deploy/stand/compose.yml --profile minio config --quiet
rm -rf "$STAND_CHECK"

step "docker build (api, ml, web) · $SHA"
# Сеть мака до registry.npmjs.org (Cloudflare) рвёт соединения, когда BuildKit параллельно качает стадии
# deps и prod-deps (2026-09-26: «other side closed» у corepack, ECONNRESET у pnpm; отдельно загрузка проходит).
# Повтор — только сборки: готовые стадии берутся из кэша, докачивается оборвавшееся.
build() {  # $1 — образ, $2 — Dockerfile, $3… — доп. флаги (--target)
  for n in 1 2 3; do
    docker build --build-arg REVISION="$SHA" -f "$2" -t "inspector-$1:$SHA" "${@:3}" . && return 0
    echo "сборка inspector-$1: попытка $n из 3 не удалась"; sleep 5
  done
  return 1
}
build api apps/api/Dockerfile
build ml  ml/Dockerfile
build web apps/web/Dockerfile
# T-230: образ профиля gpu (OWASP-0210) — отдельная цель; на машине с видеокартой — проверка GPU-OCR из образа
# (только PP-OCR: vLLM в гейте нет), без неё — только сборка
build ml-gpu ml/Dockerfile --target gpu
if command -v nvidia-smi >/dev/null 2>&1; then
  step "smoke ml-gpu: PP-OCR на CUDA, веса из образа со сверкой SHA-256"
  docker run --rm --gpus all --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -e INSPECTOR_OCR_ENGINES=ppocr-v5 -e INSPECTOR_PPOCR_GPU_MB=512 "inspector-ml-gpu:$SHA" \
    python -c "from inspector_ml.ocr_gpu import check_ready; print(check_ready('gpu'))"
fi

# Сборка ≠ запуск: каждый образ поднимается как в стенде — read_only, cap_drop ALL; /health = 200, revision = sha
step "smoke-run образов"
HARD=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true)
docker network create smoke-net >/dev/null
wait_health() {  # $1 — url, $2 — ожидаемая ревизия
  for _ in $(seq 1 45); do
    body=$(curl -sk --max-time 5 "$1" || true)
    if echo "$body" | grep -q '"status":"ok"'; then
      echo "$body" | grep -q "\"revision\":\"$2\"" || { echo "$1: revision ≠ $2: $body"; return 1; }
      return 0
    fi
    sleep 2
  done
  echo "$1 не ответил"; return 1
}
docker run -d --name smoke-ml --network smoke-net --network-alias ml "${HARD[@]}" -p 127.0.0.1:18811:8811 \
  -e INSPECTOR_PROFILE=dev -e INSPECTOR_ML_CACHE=/tmp/ml-cache "inspector-ml:$SHA" >/dev/null
wait_health http://127.0.0.1:18811/health "$SHA" || { docker logs smoke-ml | tail -40; exit 1; }
docker exec smoke-ml python -c "from inspector_ml.semantic import get_embedder; assert get_embedder() is not None"
mkdir -p smoke-tls && (
  cd smoke-tls
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=smoke-ca" \
    -addext "basicConstraints=critical,CA:TRUE" -keyout ca.key -out ca.crt 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=api" -keyout server.key -out server.csr 2>/dev/null
  printf 'subjectAltName=DNS:api,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > ext.cnf
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile ext.cnf -out server.crt 2>/dev/null
  chmod 644 server.key
)
# tmpfs поверх /app/var: Docker Desktop монтирует его root:root 755, а API работает под node (uid 1000) и не открыл бы
# SQLite — владелец задан явно. В стенде /app/var — именованный том, он наследует владельца из образа.
docker run -d --name smoke-api --network smoke-net --network-alias api "${HARD[@]}" --tmpfs /app/var:uid=1000,gid=1000,mode=0700 -p 127.0.0.1:18810:8810 \
  -v "$PWD/smoke-tls:/run/tls:ro" -e INSPECTOR_PROFILE=dev -e HOST=0.0.0.0 -e INSPECTOR_ML_URL=http://ml:8811 \
  -e INSPECTOR_TLS_CERT=/run/tls/server.crt -e INSPECTOR_TLS_KEY=/run/tls/server.key -e INSPECTOR_DEMO_PASSWORD="$(openssl rand -hex 12)" \
  "inspector-api:$SHA" >/dev/null
wait_health https://127.0.0.1:18810/health "$SHA" || { docker logs smoke-api | tail -40; exit 1; }
docker run -d --name smoke-web --network smoke-net "${HARD[@]}" --user 101:101 -p 127.0.0.1:18443:8443 \
  -v "$PWD/smoke-tls:/run/tls:ro" "inspector-web:$SHA" >/dev/null
wait_health https://127.0.0.1:18443/health "$SHA" || { docker logs smoke-web | tail -40; exit 1; }
curl -sk -D - -o /dev/null https://127.0.0.1:18443/ | grep -qi "content-security-policy: .*frame-ancestors 'none'" \
  || { echo "web без CSP"; exit 1; }
# NFR-IDS (T-158): лимиты периметра — живыми запросами к этому же web (429 всплеска и входа, 413 тела, limit_conn)
PERIMETER_URL=https://127.0.0.1:18443 PERIMETER_CA=smoke-tls/ca.crt node --test scripts/perimeter-live.test.mjs \
  || { docker logs smoke-web | tail -40; exit 1; }
echo "smoke ok"

step "trivy (HIGH, CRITICAL)"
TRIVY="aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
for img in api ml web; do
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$HOME/Library/Caches/trivy:/root/.cache/trivy" "$TRIVY" image \
    --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --no-progress "inspector-$img:$SHA"
done

echo; echo "local-gate: зелёный · $SHA · $(( ($(date +%s) - t0) / 60 )) мин"
