#!/usr/bin/env bash
# Демо-стенд «Надзориум» (T-131): nadzorium.almazrobots.ru на hk-ru — только просмотр результатов, посчитанных на маке.
#   scripts/demo.sh secrets    пароли, CA и сертификаты демо-стенда в var/demo (вне git); ключи S3 и шифрования — со стенда мака
#   scripts/demo.sh build      образы api и web под linux/amd64 с тегом <git-sha>-amd64 (только под scripts/heavy.sh)
#   scripts/demo.sh ship       compose, init БД, секреты и TLS → hk-ru:/opt/nadzorium; образы — docker save | ssh docker load
#   scripts/demo.sh up         поднять стенд на hk-ru и дождаться healthy
#   scripts/demo.sh publish    данные со стенда мака → база демо-стенда; страницы ГЕРЫ и отчёты → /docs; publication.json
#   scripts/demo.sh docs       только материалы → /docs (карта ГЕРЫ, покрытие ТЗ кодом, отчёты); база и publication.json о данных — прежние
#   scripts/demo.sh access     пароль прокси (T-152): хеш bcrypt → /etc/caddy/nadzorium-users.caddy, vhost из git, validate → reload
#   scripts/demo.sh status     контейнеры, /health, ревизия, publication.json — с сервера
# Сервер ничего не считает: ML, очереди и антивируса там нет, изменяющие запросы API отклоняет (INSPECTOR_READONLY=1).
# Правило №0: на hk-ru рядом PINATOR LIVE — лимиты памяти в compose, публикация передаёт только данные (без файлов).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VAR=$ROOT/var/demo
SEC=$VAR/secrets
TLS=$VAR/tls
STAND=$ROOT/var/stand
HOST=${DEMO_HOST:-hk-ru}
DIR=/opt/nadzorium
say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf 'demo.sh: %s\n' "$*" >&2; exit 1; }
mkdir -p "$SEC" "$TLS"
chmod 700 "$VAR" "$SEC"

secret_file() {  # путь, команда-генератор; существующий не перезаписывается
  [ -s "$1" ] && return 0
  (umask 077; eval "$2" > "$1")
  chmod 600 "$1"
}

cert() {  # имя сервиса (DNS в сети compose), каталог
  local name=$1 dir=$2
  mkdir -p "$dir"
  if [ ! -s "$dir/server.crt" ]; then
    (umask 077
     openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$name" -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
     printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n' "$name" > "$dir/ext.cnf"
     openssl x509 -req -in "$dir/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial -days 365 -extfile "$dir/ext.cnf" -out "$dir/server.crt" 2>/dev/null
     rm -f "$dir/server.csr" "$dir/ext.cnf")
  fi
  cp "$TLS/ca.crt" "$dir/ca.crt"
}

cmd_secrets() {
  say "секреты демо-стенда → var/demo/secrets (600, вне git)"
  for f in pg_superuser_password pg_migrator_password pg_app_password bootstrap_admin_password demo_password basic_auth_password; do
    secret_file "$SEC/$f" "openssl rand -hex 24"
  done
  # Object Storage: ключ доступа и ключ шифрования — те же, что у стенда мака (файлы в бакете зашифрованы им)
  for pair in "s3-yandex/access_key_id:s3_access_key_id" "s3-yandex/secret_access_key:s3_secret_access_key" "s3_encryption_key:s3_encryption_key"; do
    local src=${pair%%:*} dst=${pair#*:}
    [ -s "$STAND/secrets/$src" ] || die "нет $STAND/secrets/$src — сначала scripts/stand.sh secrets на маке"
    [ -s "$SEC/$dst" ] || { (umask 077; cp "$STAND/secrets/$src" "$SEC/$dst"); chmod 600 "$SEC/$dst"; }
  done
  if [ ! -s "$TLS/ca.crt" ]; then
    (umask 077
     openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 -subj "/CN=nadzorium-demo-ca" \
       -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$TLS/ca.key" -out "$TLS/ca.crt" 2>/dev/null)
  fi
  for s in api web postgres; do cert "$s" "$TLS/$s"; done
  echo "  готово: $(ls "$SEC" | wc -l | tr -d ' ') секретов, CA и сертификаты api, web, postgres"
}

rev() { git rev-parse HEAD; }

cmd_build() {
  [ -d /tmp/building-tech-heavy.lock ] || die "сборка — только под замком: scripts/heavy.sh scripts/demo.sh build"
  [ -z "$(git status --porcelain -- apps deploy scripts data)" ] || die "в дереве незакоммиченные правки — образ должен соответствовать коммиту"
  local r; r=$(rev)
  for app in api web; do
    say "docker buildx build $app · linux/amd64 · $r"
    docker buildx build --platform linux/amd64 --build-arg REVISION="$r" -f "apps/$app/Dockerfile" -t "inspector-$app:$r-amd64" --load .
  done
  echo "$r" > "$VAR/revision"
}

cmd_ship() {
  local r; r=$(cat "$VAR/revision" 2>/dev/null) || die "образы не собраны: scripts/heavy.sh scripts/demo.sh build"
  local pg; pg=$(sed -n 's/^POSTGRES_IMAGE=//p' deploy/stand/images.env)
  [ -n "$pg" ] || die "POSTGRES_IMAGE не найден в deploy/stand/images.env"
  say "каталоги и файлы → $HOST:$DIR"
  ssh "$HOST" "install -d -m 755 $DIR $DIR/postgres $DIR/postgres/init $DIR/var $DIR/var/docs && install -d -m 700 $DIR/var/secrets $DIR/var/tls && install -d -m 700 -o 70 -g 70 $DIR/var/publish"
  scp -q deploy/demo/compose.yml "$HOST:$DIR/compose.yml"
  scp -q deploy/gpu/postgres/init/* "$HOST:$DIR/postgres/init/"
  scp -q deploy/gpu/postgres/pg_hba.conf "$HOST:$DIR/postgres/pg_hba.conf"
  # секреты и ключи: каталоги 700 root, файлы 644 — их читают процессы контейнеров (uid 70, 1000, 101), не пользователи хоста
  tar_out -C "$SEC" -cf - . | ssh "$HOST" "tar --no-same-owner -C $DIR/var/secrets -xf - && rm -f $DIR/var/secrets/basic_auth_password && chmod 644 $DIR/var/secrets/*"
  # ключ postgres — только владельцу (uid 70) и 600: иначе postgres не стартует («must be owned by the database user»)
  tar_out -C "$TLS" --exclude ca.key --exclude ca.srl -cf - . | ssh "$HOST" "tar --no-same-owner -C $DIR/var/tls -xf - && find $DIR/var/tls -type d -exec chmod 755 {} + && find $DIR/var/tls -type f -exec chmod 644 {} + && chmod 700 $DIR/var/tls && chown 70:70 $DIR/var/tls/postgres/server.key && chmod 600 $DIR/var/tls/postgres/server.key"
  ssh "$HOST" "install -m 644 $DIR/var/tls/ca.crt /etc/caddy/nadzorium-ca.crt"
  printf 'DEMO_API_IMAGE=inspector-api:%s-amd64\nDEMO_WEB_IMAGE=inspector-web:%s-amd64\nDEMO_PG_IMAGE=%s\nDEMO_S3_READ_PREFIXES=%s\n' \
    "$r" "$r" "$pg" "${DEMO_S3_READ_PREFIXES:-demo-2026-09-27b/,blobs/,demo-2026-09-27/}" | ssh "$HOST" "cat > $DIR/var/demo.env"
  for app in api web; do
    if ssh "$HOST" "docker image inspect inspector-$app:$r-amd64 >/dev/null 2>&1"; then echo "  inspector-$app:$r-amd64 уже на сервере"
    else say "docker save inspector-$app:$r-amd64 | ssh docker load"; docker save "inspector-$app:$r-amd64" | gzip -1 | ssh "$HOST" "gunzip | docker load"; fi
  done
  ssh "$HOST" "docker pull -q $pg >/dev/null && echo '  postgres по digest на месте'"
}

# tar с мака без AppleDouble (._*) и расширенных атрибутов macOS
tar_out() { COPYFILE_DISABLE=1 tar --no-xattrs "$@"; }

compose() { ssh "$HOST" "cd $DIR && docker compose --env-file var/demo.env $*"; }

cmd_up() {
  say "docker compose up на $HOST"
  compose "up -d --wait --wait-timeout 180"
  compose "ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'"
}

# ─────────────── публикация: данные с мака → демо-стенд
stand_psql() {  # SQL в базе стенда мака (роль приложения, TLS) — только чтение
  docker exec -i inspector-stand-postgres-1 sh -c 'PGPASSWORD=$(cat /run/secrets/pg_app_password) psql "host=127.0.0.1 sslmode=require user=inspector_app dbname=inspector" -At -v ON_ERROR_STOP=1' <<<"$1"
}

cmd_publish() {
  local out=$VAR/publish; (umask 077; mkdir -p "$out")
  say "сверка схем: миграции стенда мака = миграции демо-стенда"
  local mine theirs
  mine=$(stand_psql "select string_agg(version || ':' || checksum, ',' order by version) from inspector.schema_migrations;")
  theirs=$(compose "exec -T postgres psql -U postgres -d inspector -At -c \"select string_agg(version || ':' || checksum, ',' order by version) from inspector.schema_migrations\"")
  [ "$mine" = "$theirs" ] || die "схема мака и демо-стенда разошлась — пересобрать демо на ревизии стенда (build → ship → up)"
  say "дамп данных стенда мака (без сессий и журнала миграций)"
  docker exec inspector-stand-postgres-1 sh -c 'PGPASSWORD=$(cat /run/secrets/pg_app_password) pg_dump "host=127.0.0.1 sslmode=require user=inspector_app dbname=inspector" -n inspector --data-only -Fc --exclude-table-data=inspector.sessions --exclude-table=inspector.schema_migrations' > "$out/data.dump"
  local sha n_insp n_files stand_rev
  sha=$(shasum -a 256 "$out/data.dump" | cut -d' ' -f1)
  n_insp=$(stand_psql "select count(*) from inspector.inspections;")
  n_files=$(stand_psql "select count(*) from inspector.files where parse_status = 'DONE';")
  # ревизия того, что реально посчитало данные: тег образа запущенного API стенда мака, а не HEAD этого дерева
  stand_rev=$(docker inspect inspector-stand-api-1 --format '{{.Config.Image}}' 2>/dev/null | sed -E 's/.*:([0-9a-f]{40})(-dirty)?$/\1\2/')
  [[ "$stand_rev" =~ ^[0-9a-f]{40}(-dirty)?$ ]] || die "не определить ревизию стенда мака по образу inspector-stand-api-1"
  echo "  $(du -h "$out/data.dump" | cut -f1) · SHA-256 ${sha:0:16}… · проверок $n_insp · разобранных файлов $n_files"
  say "страницы ГЕРЫ, методика и отчёты → /docs"
  node scripts/demo-docs.mjs "$out/docs" "$n_insp" "$n_files" "$sha" "$stand_rev"
  scp -q "$out/data.dump" "$HOST:$DIR/var/publish/data.dump"
  # дамп несёт ФИО и подписи из документов: каталог 700 и файл 600 владельца postgres (uid 70), читает только он
  ssh "$HOST" "chown 70:70 $DIR/var/publish/data.dump && chmod 600 $DIR/var/publish/data.dump"
  say "восстановление на демо-стенде: очистка данных и загрузка дампа (API на это время остановлен)"
  compose "stop api"
  # очистка — в одной сессии с session_replication_role=replica (журналы только на дописывание защищены триггерами)
  cat > "$out/restore.sql" <<'SQL'
set session_replication_role = replica;
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname = 'inspector' and tablename <> 'schema_migrations' loop
    execute format('truncate table inspector.%I cascade', r.tablename);
  end loop;
end $$;
SQL
  scp -q "$out/restore.sql" "$HOST:$DIR/var/publish/restore.sql"
  ssh "$HOST" "chown 70:70 $DIR/var/publish/restore.sql && chmod 600 $DIR/var/publish/restore.sql"
  compose "exec -T postgres psql -U postgres -d inspector -v ON_ERROR_STOP=1 -q -f /publish/restore.sql"
  compose "exec -T postgres pg_restore -U postgres -d inspector --data-only --disable-triggers --no-owner --no-privileges --exit-on-error /publish/data.dump"
  tar_out -C "$out/docs" -cf - . | ssh "$HOST" "rm -rf $DIR/var/docs/* && tar --no-same-owner -C $DIR/var/docs -xf - && find $DIR/var/docs -type d -exec chmod 755 {} + && find $DIR/var/docs -type f -exec chmod 644 {} +"
  compose "start api"
  compose "up -d --wait --wait-timeout 120 api web" >/dev/null
  ssh "$HOST" "rm -f $DIR/var/publish/data.dump $DIR/var/publish/restore.sql"
  echo "  опубликовано: https://nadzorium.almazrobots.ru (проверок $n_insp, файлов $n_files)"
}

# ─────────────── только материалы: база стенда не трогается, сведения о данных — из прошлой publication.json
cmd_docs() {
  local out=$VAR/publish; (umask 077; mkdir -p "$out")
  say "прошлая публикация с сервера: сведения о данных сохраняются"
  ssh "$HOST" "cat $DIR/var/docs/publication.json" > "$out/prev-publication.json" || die "на стенде нет publication.json — сначала полная публикация (publish)"
  node scripts/gera-trace.mjs --check
  say "страницы ГЕРЫ, покрытие ТЗ, методика и отчёты → /docs"
  node scripts/demo-docs.mjs "$out/docs" 0 0 "" "" "$out/prev-publication.json"
  tar_out -C "$out/docs" -cf - . | ssh "$HOST" "rm -rf $DIR/var/docs/* && tar --no-same-owner -C $DIR/var/docs -xf - && find $DIR/var/docs -type d -exec chmod 755 {} + && find $DIR/var/docs -type f -exec chmod 644 {} +"
  echo "  материалы обновлены: https://nadzorium.almazrobots.ru/docs/"
}

cmd_access() {  # T-152, NFR-DEMO-ACCESS: пароль прокси на весь сайт, кроме /api/* и /health; Caddy общий с PINATOR LIVE
  secret_file "$SEC/basic_auth_password" "openssl rand -hex 16"
  say "хеш пароля прокси (bcrypt) → $HOST:/etc/caddy/nadzorium-users.caddy"
  local hash
  hash=$(uv run --quiet --with bcrypt python -c 'import bcrypt,sys; print(bcrypt.hashpw(sys.stdin.read().strip().encode(), bcrypt.gensalt(12)).decode())' < "$SEC/basic_auth_password")
  [[ "$hash" == '$2'* ]] || die "bcrypt: пустой хеш"
  printf 'nadzorium %s\n' "$hash" | ssh "$HOST" "install -m 640 -g caddy /dev/stdin /etc/caddy/nadzorium-users.caddy"
  say "vhost nadzorium из git → /etc/caddy/Caddyfile (копия рядом), validate → reload"
  # OWASP-0112: промежуточные файлы — в приватном каталоге root (700), не в общем /tmp: иначе симлинк или подмена между
  # validate и install. Каталог убирается в том же сеансе ssh; vhost передаётся потоком в этот сеанс.
  ssh "$HOST" 'set -e; t=$(mktemp -d -p /root nadzorium-access.XXXXXX); chmod 700 "$t"; trap "rm -rf \"$t\"" EXIT
    cat > "$t/vhost"
    b=/etc/caddy/Caddyfile.bak-t152-$(date +%Y%m%d-%H%M%S); cp /etc/caddy/Caddyfile "$b"
    T="$t" python3 - "$b" <<"PY"
import os, sys
t = os.environ["T"]
src = open("/etc/caddy/Caddyfile").read()
new = open(f"{t}/vhost").read().strip() + "\n"
lines = src.splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if l.startswith("nadzorium.almazrobots.ru {"))
while start > 0 and lines[start - 1].startswith("#"):
    start -= 1
depth, end = 0, None
for i in range(start, len(lines)):
    depth += lines[i].count("{") - lines[i].count("}")
    if "{" in lines[i] or "}" in lines[i]:
        if depth == 0 and i > start:
            end = i
            break
assert end, "конец блока nadzorium не найден"
open(f"{t}/Caddyfile", "w").write("".join(lines[:start]) + new + "".join(lines[end + 1:]))
PY
    if caddy validate --config "$t/Caddyfile" --adapter caddyfile >"$t/validate.log" 2>&1; then
      install -m 644 "$t/Caddyfile" /etc/caddy/Caddyfile && systemctl reload caddy && echo "caddy: перезагружен, копия $b"
    else
      cat "$t/validate.log" >&2; echo "caddy: validate не прошёл — Caddyfile не тронут" >&2; exit 1
    fi' < deploy/demo/Caddyfile.nadzorium
  local u=https://nadzorium.almazrobots.ru code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$u/"); [ "$code" = 401 ] || die "без пароля прокси / → $code, ждём 401"
  code=$(printf 'user = "nadzorium:%s"\n' "$(cat "$SEC/basic_auth_password")" | curl -s -K - -o /dev/null -w '%{http_code}' "$u/")  # пароль не в argv; [ "$code" = 200 ] || die "с паролем / → $code, ждём 200"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$u/api/v1/inspections"); [ "$code" = 401 ] || die "/api без входа → $code, ждём 401 от приложения"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$u/health"); [ "$code" = 200 ] || die "/health → $code"
  # гостевой вход на публичном демо выключен (владелец 27.09, NFR-DEMO-ACCESS): ждём 404 (маршрута нет) или 403
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$u/api/v1/auth/guest"); [[ "$code" =~ ^40[34]$ ]] || die "гостевой вход отвечает $code — должен быть выключен (404/403)"
  for site in https://almazrobots.ru https://qxpinator.almazrobots.ru; do
    printf '  сосед %s → %s\n' "$site" "$(curl -s -o /dev/null -w '%{http_code}' "$site")"
  done
  say "пароль прокси стоит: / 401 без пароля, 200 с паролем; /api 401 без входа; /health 200"
}

cmd_status() {
  compose "ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'"
  local out
  out=$(ssh "$HOST" "curl -fsS --max-time 10 --cacert $DIR/var/tls/ca.crt --resolve web:45900:127.0.0.1 https://web:45900/health && echo && curl -fsS --max-time 10 --cacert $DIR/var/tls/ca.crt --resolve web:45900:127.0.0.1 https://web:45900/docs/publication.json")
  printf '%s\n' "$out"
  # NFR-DEMO-CONTENT (T-152): данные посчитаны стендом мака на той же ревизии, что код демо; иначе — предупреждение
  printf '%s\n' "$out" | python3 -c '
import json, sys
text = sys.stdin.read()
health = json.loads(text.split("\n", 1)[0])
pub = json.loads(text.split("\n", 1)[1])
code, data = health.get("revision", ""), pub.get("revision", "").removesuffix("-dirty")
matrix = health.get("versions", {}).get("matrix")
print(f"код демо {code[:7]} · данные посчитаны на {data[:7]} · Матрица {matrix}")
if code != data:
    print("⚠ данные демо посчитаны не той ревизией, что код: перепубликовать со стенда мака на " + code[:7] + " (NFR-DEMO-CONTENT)")
'
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  build) cmd_build ;;
  ship) cmd_ship ;;
  up) cmd_up ;;
  publish) cmd_publish ;;
  docs) cmd_docs ;;
  access) cmd_access ;;
  status) cmd_status ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
