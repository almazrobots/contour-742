#!/usr/bin/env bash
# ELK (ТЗ 13.6) и сроки хранения логов (ТЗ 12.5, 13.3): одноразовая идемпотентная настройка Elasticsearch.
# Запускается сервисом elasticsearch-setup (compose.yml) или вручную: ES_URL=… ELASTIC_PASSWORD=… ./setup.sh
# PUT перезаписывает политику, шаблон, роль и пользователя — повторный запуск безопасен.
set -euo pipefail

: "${ES_URL:?ES_URL — адрес Elasticsearch}"
: "${ELASTIC_PASSWORD:?}"
: "${KIBANA_SYSTEM_PASSWORD:?}"
: "${LOGSTASH_WRITER_PASSWORD:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
# NFR-TLS-INTERNAL: ES по https — сертификат проверяется по корню стенда ES_CA (в compose задан всегда)
TLS=()
if [[ -n "${ES_CA:-}" ]]; then TLS=(--cacert "$ES_CA"); fi

es() { # метод путь [файл-тела | -]
  local method=$1 path=$2 body=${3:-}
  local args=(-fsS ${TLS[@]+"${TLS[@]}"} -X "$method" -u "elastic:${ELASTIC_PASSWORD}" -H "Content-Type: application/json" "${ES_URL}${path}")
  if [[ -n "$body" ]]; then args+=(--data-binary "@${body}"); fi
  curl "${args[@]}" >/dev/null
  echo "ok ${method} ${path}"
}
json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }

for _ in $(seq 60); do
  curl -fsS ${TLS[@]+"${TLS[@]}"} -u "elastic:${ELASTIC_PASSWORD}" "${ES_URL}/_cluster/health?wait_for_status=yellow&timeout=5s" >/dev/null 2>&1 && break
  sleep 5
done

# Сроки хранения: inspector-logs — 90 дней, inspector-security — 365 дней
for name in inspector-logs inspector-security; do
  es PUT "/_ilm/policy/${name}" "${DIR}/ilm-${name}.json"
  es PUT "/_index_template/${name}" "${DIR}/template-${name}.json"
done

# Kibana ходит учёткой kibana_system (суперпользователь elastic ей запрещён)
printf '{"password":%s}' "$(json_str "$KIBANA_SYSTEM_PASSWORD")" | es POST "/_security/user/kibana_system/_password" -

# Logstash — только дописывать в свои data stream: ни чтения, ни удаления
cat <<'EOF' | es PUT "/_security/role/inspector_logstash_writer" -
{"cluster":["monitor"],"indices":[{"names":["inspector-logs*","inspector-security*"],"privileges":["create_doc","auto_configure"]}]}
EOF
printf '{"password":%s,"roles":["inspector_logstash_writer"]}' "$(json_str "$LOGSTASH_WRITER_PASSWORD")" | es PUT "/_security/user/inspector_logstash" -
