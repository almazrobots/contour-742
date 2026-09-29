#!/bin/sh
# HIGH-1 (аудит 2026-09-26, ADR-0003): роли наименьших привилегий. Выполняется образом postgres ОДИН раз — при
# инициализации пустого тома — суперпользователем postgres через сокет (/docker-entrypoint-initdb.d, монтируется ro).
#   inspector_owner    NOLOGIN — владелец схемы inspector и всех её объектов;
#   inspector_migrator LOGIN   — член inspector_owner, по умолчанию SET ROLE inspector_owner: миграции, сиды, первый admin
#                                (служба api-migrate);
#   inspector_app      LOGIN   — рантайм API: только DML в схеме inspector, без DDL, без суперпользовательских прав.
# Пароли — из файлов-секретов; в argv и в текст журнала сервера не попадают: psql читает их командой \set из файла,
# а журнал операторов в этой сессии выключен (log_statement=ddl записал бы ALTER ROLE … PASSWORD).
set -eu

for f in /run/secrets/pg_migrator_password /run/secrets/pg_app_password; do
  [ -s "$f" ] || { echo "10-roles: секрет $f пуст или не смонтирован" >&2; exit 1; }
done

psql -v ON_ERROR_STOP=1 --no-psqlrc --no-password --username postgres --dbname "${POSTGRES_DB:-inspector}" <<'SQL'
set log_statement = 'none';
set log_min_error_statement = 'panic';
\set migrator_pw `cat /run/secrets/pg_migrator_password`
\set app_pw `cat /run/secrets/pg_app_password`

create role inspector_owner nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role inspector_migrator login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'migrator_pw';
create role inspector_app login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'app_pw';
\unset migrator_pw
\unset app_pw
grant inspector_owner to inspector_migrator;

-- База: никаких прав у PUBLIC (CONNECT, TEMP); подключаются только две роли
revoke all on database inspector from public;
grant connect on database inspector to inspector_migrator, inspector_app;
revoke all on database postgres from public;
revoke all on schema public from public;

-- Схема приложения: владелец — inspector_owner; API — только USAGE (CREATE нет — DDL из API невозможен)
create schema inspector authorization inspector_owner;
grant usage on schema inspector to inspector_app;

-- Будущие объекты владельца: DML и последовательности для API. Исключения (журналы append-only, schema_migrations
-- только на чтение) — в миграциях и db.ts::restrictMigrationJournal
alter default privileges for role inspector_owner in schema inspector grant select, insert, update, delete on tables to inspector_app;
alter default privileges for role inspector_owner in schema inspector grant usage, select on sequences to inspector_app;

alter role inspector_migrator set search_path = inspector;
alter role inspector_migrator set role = inspector_owner;
alter role inspector_app set search_path = inspector;
-- Страховка M-2 на стороне сервера: клиент задаёт те же значения (config.ts), но и без них сессия API ограничена
alter role inspector_app set statement_timeout = '30s';
alter role inspector_app set idle_in_transaction_session_timeout = '60s';
alter role inspector_app set lock_timeout = '10s';
SQL
echo "10-roles: роли inspector_owner, inspector_migrator, inspector_app и схема inspector созданы"
