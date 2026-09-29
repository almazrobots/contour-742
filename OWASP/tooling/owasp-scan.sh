#!/usr/bin/env bash
# Автоматические сканы OWASP-программы (ритм R1, см. OWASP/MEGAPLAN.md §4).
# Правило №0: весь прогон — один тяжёлый процесс, запускать ТОЛЬКО под общим замком:
#   scripts/heavy.sh OWASP/tooling/owasp-scan.sh [каталог-вывода] [--quick] [--demo]
# --demo — ещё и пассивная проверка публичного демо (заголовки, TLS 1.2); без флага наружу ничего не уходит.
# Оценка: пик < 1,5 ГБ RAM (semgrep), 3–8 мин целиком; --quick (без semgrep, bandit, syft) — ~2 мин, пик ~1,4 ГБ (trivy).
# Каталог вывода по умолчанию: OWASP/audits/ГГГГ-ММ-ДД-weekly/scans. Секреты не печатаются (gitleaks --redact).
# Шаг без инструмента пропускается с пометкой SKIP, а не валит прогон; итоговый код — число упавших шагов.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT=""; QUICK=0
DEMO=0
for a in "$@"; do case "$a" in --quick) QUICK=1 ;; --demo) DEMO=1 ;; *) OUT="$a" ;; esac; done
OUT="${OUT:-OWASP/audits/$(date +%F)-weekly/scans}"
mkdir -p "$OUT"
SKIP_DIRS="node_modules,var,INPUT,data,ТЗ,Презентация,.git,ml/.venv"
SUMMARY="$OUT/SUMMARY.md"
fails=0
printf '# Сводка сканов %s\n\nКоммит: `%s`\n\n| Шаг | Итог | Файл |\n|---|---|---|\n' "$(date '+%F %H:%M')" "$(git rev-parse --short HEAD)" > "$SUMMARY"

row() { printf '| %s | %s | `%s` |\n' "$1" "$2" "$3" >> "$SUMMARY"; }
have() { command -v "$1" >/dev/null 2>&1; }
run() { # run <имя> <файл> <команда…> — код ≠ 0 у сканеров значит «есть находки», это не авария
  local name="$1" file="$OUT/$2"; shift 2
  echo "== $name"
  if "$@" > "$file" 2>&1; then row "$name" "чисто" "$file"; else row "$name" "есть находки (код $?)" "$file"; fi
}
skip() { echo "== $1: SKIP ($2)"; row "$1" "SKIP: $2" "—"; }

# 1. Секреты в истории — те же параметры, что в гейте
if have gitleaks; then run "gitleaks (история)" gitleaks.txt gitleaks detect --source=. --gitleaks-ignore-path=.gitleaksignore --redact --no-banner
else skip gitleaks "нет инструмента"; fi

# 2. Уязвимости, секреты и ошибки конфигурации по дереву
if have trivy; then
  run "trivy fs (vuln, secret)" trivy-fs.txt trivy fs --quiet --scanners vuln,secret --skip-dirs "$SKIP_DIRS" --severity MEDIUM,HIGH,CRITICAL .
  tconf() { for t in deploy apps/api/Dockerfile apps/web/Dockerfile ml/Dockerfile; do echo "## $t"; trivy config --quiet --exit-code 1 --severity MEDIUM,HIGH,CRITICAL "$t" || rc=1; done; return ${rc:-0}; }
  run "trivy config (Dockerfile, deploy/)" trivy-config.txt tconf
else skip trivy "нет инструмента"; fi

# 3. Dockerfile
if have hadolint; then run "hadolint" hadolint.txt hadolint apps/api/Dockerfile apps/web/Dockerfile ml/Dockerfile
else skip hadolint "нет инструмента"; fi

# 4. Зависимости npm и PyPI
if have pnpm; then run "pnpm audit" pnpm-audit.txt pnpm audit
else skip "pnpm audit" "нет pnpm"; fi
if have uv; then
  (cd ml && uv export --frozen --all-extras --no-hashes --no-emit-project > "$ROOT/$OUT/ml-requirements.txt" 2>/dev/null)
  run "pip-audit (ml)" pip-audit.txt uvx pip-audit --no-deps --disable-pip --timeout 60 -r "$OUT/ml-requirements.txt" --progress-spinner off
else skip pip-audit "нет uv"; fi

if [ "$QUICK" = 0 ]; then
  # 5. SAST
  if have semgrep; then
    run "semgrep (owasp-top-ten, ts, python)" semgrep.txt semgrep scan --metrics=off --quiet \
      --config p/owasp-top-ten --config p/typescript --config p/python --exclude node_modules --exclude ml/.venv apps ml
  else skip semgrep "нет инструмента"; fi
  if have uv; then run "bandit (ml)" bandit.txt uvx bandit -q -r ml/inspector_ml -ll; else skip bandit "нет uv"; fi
  # 6. SBOM CycloneDX
  if have syft; then
    mkdir -p "$OUT/../sbom"
    run "syft SBOM" syft.log syft dir:. -q --exclude './node_modules' --exclude './**/node_modules' --exclude './var' \
      --exclude './INPUT' --exclude './data' --exclude './ml/.venv' -o "cyclonedx-json=$OUT/../sbom/sbom.cdx.json"
  else skip syft "нет инструмента"; fi
fi

# 7. Гигиена конфигурации (рекомендации E2 аудита T-140, всё локально и дёшево)
hygiene() {
  # пины actions: всё, что не по 40-символьному sha (T088-H7, E2-M6)
  grep -hoE 'uses:[[:space:]]*[^[:space:]]+' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40}' | sed 's/^/FAIL action не по sha: /'
  # игноры секретов (T088-M6, L12)
  for p in deploy/gpu/.env .env x.key x.pem x.p12 x.pfx .secrets/x INPUT/x; do
    git check-ignore -q "$p" || echo "FAIL .gitignore не покрывает: $p"; done
  for p in .secrets INPUT ТЗ data; do grep -qE "^(\*\*/)?/?$p/?" .dockerignore || echo "FAIL .dockerignore не исключает: $p/"; done
  # модели: у выбранной модели роли есть revision (E3-M3)
  python3 - <<'PY'
import yaml
roles = yaml.safe_load(open("ml/models.yaml")).get("roles", {})
bad = [k for k, v in roles.items() if not any(c.get("model") == v.get("chosen") and c.get("revision") for c in v.get("candidates", []))]
print("FAIL модели без revision: " + ", ".join(bad)) if bad else print("ok модели с revision")
PY
  # ветки с lock на Vitest 3 (T088-M17)
  git for-each-ref --format='%(refname:short)' refs/heads refs/remotes | while read -r b; do
    git show "$b:pnpm-lock.yaml" 2>/dev/null | grep -q '^  vitest@3\.' && echo "WARN ветка с vitest 3: $b"; done
  return 0
}
run "гигиена конфигурации" hygiene.txt hygiene
grep -q '^FAIL' "$OUT/hygiene.txt" && sed -i '' 's/| гигиена конфигурации | чисто |/| гигиена конфигурации | есть FAIL |/' "$SUMMARY"

# 8. Демо — только пассивно и только по флагу --demo (MEGAPLAN §10: прод не атакуем)
if [ "${DEMO:-0}" = 1 ]; then
  demo() {
    curl -sI https://nadzorium.almazrobots.ru/
    echo | openssl s_client -connect nadzorium.almazrobots.ru:443 -tls1_2 2>&1 | grep -q 'Protocol *: TLSv1.2' && echo "FAIL: принят TLS 1.2 (E2-M2)"
    return 0
  }
  run "демо, пассивно" demo.txt demo
fi

# 9. Регрессионные тесты безопасности (быстрые, без Docker)
if [ -d node_modules ]; then
  run "тесты безопасности API" security-tests.txt pnpm --filter @inspector/api exec vitest run \
    tests/domain-security.test.ts tests/db-hardening.test.ts tests/openapi-contract.test.ts
  run "тесты деплоя (заголовки, digest, сети)" deploy-tests.txt node --test scripts/deploy.test.mjs
else skip "тесты безопасности" "нет node_modules — pnpm install"; fi

fails=$(grep -cE 'есть (находки|FAIL)' "$SUMMARY")
printf '\nШагов с находками: %s. Разбор — ведущий аудитор, итог — строкой в OWASP/audits/INDEX.md.\n' "$fails" >> "$SUMMARY"
cat "$SUMMARY"
exit "$fails"
