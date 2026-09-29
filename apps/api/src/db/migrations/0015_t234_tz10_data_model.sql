-- 0015 — модель данных по ТЗ §10 «Таблицы базы данных (сводка)» (T-234; сверка docs/qa/t233/tz10-db-audit.md).
-- 1) Недостающие поля ТЗ: checks.param_id, checks.object_id, checks.completeness_status, files.file_path,
--    protocols.object_id, evidence_fragments.evidence_group_id, rejection_log.retraining_status,
--    dispute_log.resolution_status и resolved_by.
--    Ссылочные поля (param_id, object_id, evidence_group_id) заполняет база триггером из родительской строки: мест
--    вставки проверок и фрагментов шесть (пересчёт, скрытые работы, реквизиты, дифф листов, советник, разделение), и
--    ни одно не может записать рассогласованное значение. completeness_status и file_path — генерируемые колонки:
--    их правило — domain/protocol.ts::completenessStatus и domain/blob-crypto.ts::blobFilePath, тест сверяет одно с другим.
-- 2) Журналы Rejection_Log и Dispute_Log остаются только дописываемыми (0002, HIGH-2), кроме одного перехода статуса:
--    retraining_status PENDING → INCLUDED | SUPERSEDED и resolution_status OPEN → исход (один раз, с автором и временем).
--    Как у decisions (0002): прочие колонки, удаление и TRUNCATE — 42501.
-- 3) Model_Versions: статусы SUPERSEDED (заменена публикацией новой) и ROLLED_BACK (снята откатом); одна действующая.
--    ML_Retraining_Log — представление над model_versions с полями ТЗ (ADR-0011: слияние таблиц).
-- 4) Normative_Base — единственный источник пределов CMP-06 (norm_key = id записи паспорта value.norm.ref) и сроков
--    действия; data/seed/norms.json → base[] — только начальное наполнение (db.ts syncNormBase).
-- Протоколы: object_id дописывается и в финализированные строки — триггер неизменяемости 0002 на время заполнения
-- снимается; тело, версия и статус протокола не меняются (хеши и подписи те же).
-- Миграция неизменяема: правка — только новым файлом. Номер — следующий свободный на момент влития.

-- ─────────────────────────────── Checks: param_id, object_id, completeness_status

alter table checks add column param_id integer references params(id);
alter table checks add column object_id text references objects(id);
alter table checks add column completeness_status text generated always as (
  case when finding_status in ('MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED') then finding_status else 'COMPLETE' end
) stored;

update checks c set object_id = i.object_id from inspections i where i.id = c.inspection_id;
update checks c set param_id = p.id from params p where p.code = c.param_code;
alter table checks alter column object_id set not null;
create index ix_checks_object on checks(object_id);
create index ix_checks_param on checks(param_id);

-- Ссылки проверки — из её проверки (inspections) и Матрицы (params); код вне Матрицы (дифф листов SD-…) — param_id null
create function checks_fill_refs() returns trigger language plpgsql as $$
begin
  new.object_id := (select i.object_id from inspections i where i.id = new.inspection_id);
  new.param_id := (select p.id from params p where p.code = new.param_code);
  return new;
end $$;
create trigger checks_fill_refs before insert or update of inspection_id, param_code, object_id, param_id on checks
  for each row execute function checks_fill_refs();

-- ─────────────────────────────── Evidence_Fragments: evidence_group_id

alter table evidence_fragments add column evidence_group_id text;
update evidence_fragments f set evidence_group_id = c.evidence_group_id from checks c where c.id = f.check_id;
alter table evidence_fragments alter column evidence_group_id set not null;
create index ix_frag_group on evidence_fragments(evidence_group_id);

create function fragments_fill_group() returns trigger language plpgsql as $$
begin
  new.evidence_group_id := (select c.evidence_group_id from checks c where c.id = new.check_id);
  return new;
end $$;
create trigger fragments_fill_group before insert or update of check_id, evidence_group_id on evidence_fragments
  for each row execute function fragments_fill_group();

-- Пересчёт меняет доказательную группу проверки — фрагменты следуют за ней
create function checks_sync_group() returns trigger language plpgsql as $$
begin
  update evidence_fragments set evidence_group_id = new.evidence_group_id where check_id = new.id;
  return null;
end $$;
create trigger checks_sync_group after update of evidence_group_id on checks
  for each row when (old.evidence_group_id is distinct from new.evidence_group_id) execute function checks_sync_group();

-- ─────────────────────────────── Files: file_path (ADR-0006: хранилище по содержимому)

alter table files add column file_path text generated always as ('blobs/' || sha256) stored;

-- ─────────────────────────────── Protocols: object_id

alter table protocols add column object_id text references objects(id);
alter table protocols disable trigger protocols_finalized_immutable;
update protocols p set object_id = i.object_id from inspections i where i.id = p.inspection_id;
alter table protocols enable trigger protocols_finalized_immutable;
alter table protocols alter column object_id set not null;
create index ix_protocols_object on protocols(object_id);

create function protocols_fill_object() returns trigger language plpgsql as $$
begin
  new.object_id := (select i.object_id from inspections i where i.id = new.inspection_id);
  return new;
end $$;
create trigger protocols_fill_object before insert on protocols for each row execute function protocols_fill_object();

-- ─────────────────────────────── Rejection_Log: retraining_status

alter table rejection_log add column retraining_status text not null default 'PENDING';
alter table rejection_log add constraint rejection_log_retraining_status_ck check (retraining_status in ('PENDING', 'INCLUDED', 'SUPERSEDED'));
alter table rejection_log add column retraining_dataset text; -- версия GOLD, в которую вошло отклонение (INCLUDED)
alter table rejection_log add column retraining_at timestamptz;
alter table rejection_log add constraint rejection_log_included_ck check ((retraining_status = 'INCLUDED') = (retraining_dataset is not null));

-- До T-234 журнал не знал о снятых решениях: действующей остаётся только последняя запись проверки, и только если
-- её отклонение не снято; прочие — SUPERSEDED (прежний триггер forbid_mutation снимается до заполнения)
drop trigger rejection_log_append_only on rejection_log;
update rejection_log r set retraining_status = 'SUPERSEDED', retraining_at = now()
  where r.id <> (select max(r2.id) from rejection_log r2 where r2.check_id = r.check_id)
     or not exists (select 1 from decisions d where d.check_id = r.check_id and d.action = 'reject' and not d.superseded);

-- Только дописывается; единственное изменение — статус дообучения из PENDING, один раз
create function rejection_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'журнал rejection_log неизменяем: DELETE запрещён' using errcode = '42501';
  end if;
  if (new.id, new.check_id, new.inspection_id, new.param_code, new.ai_verdict, new.reason_code, new.comment, new.suggested_fix, new.user_id, new.created_at)
       is distinct from (old.id, old.check_id, old.inspection_id, old.param_code, old.ai_verdict, old.reason_code, old.comment, old.suggested_fix, old.user_id, old.created_at)
     or (new.retraining_status is distinct from old.retraining_status and old.retraining_status <> 'PENDING')
     or (new.retraining_status = old.retraining_status and (new.retraining_dataset, new.retraining_at) is distinct from (old.retraining_dataset, old.retraining_at)) then
    raise exception 'журнал rejection_log неизменяем: допускается только retraining_status PENDING → INCLUDED | SUPERSEDED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger rejection_log_guard before update or delete on rejection_log for each row execute function rejection_log_guard();

-- Решение-отклонение снято (возврат, новое решение, пересчёт со сменой доказательства) — запись журнала в обучение не идёт
create function decisions_supersede_rejections() returns trigger language plpgsql as $$
begin
  update rejection_log set retraining_status = 'SUPERSEDED', retraining_at = now()
    where check_id = new.check_id and retraining_status = 'PENDING';
  return null;
end $$;
create trigger decisions_supersede_rejections after update of superseded on decisions
  for each row when (new.superseded and not old.superseded and new.action = 'reject') execute function decisions_supersede_rejections();

-- ─────────────────────────────── Dispute_Log: resolution_status, resolved_by

alter table dispute_log add column resolution_status text not null default 'OPEN';
alter table dispute_log add constraint dispute_log_resolution_status_ck check (resolution_status in ('OPEN', 'AI_UPHELD', 'INSPECTOR_UPHELD', 'WITHDRAWN'));
alter table dispute_log add column resolved_by text references users(id);
alter table dispute_log add column resolved_at timestamptz;
alter table dispute_log add column resolution_comment text;
alter table dispute_log add constraint dispute_log_resolved_ck check ((resolution_status = 'OPEN') = (resolved_by is null and resolved_at is null));

drop trigger dispute_log_append_only on dispute_log;
create function dispute_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'журнал dispute_log неизменяем: DELETE запрещён' using errcode = '42501';
  end if;
  if (new.id, new.check_id, new.inspection_id, new.param_code, new.kind, new.ai_comment, new.inspector_comment, new.user_id, new.created_at)
       is distinct from (old.id, old.check_id, old.inspection_id, old.param_code, old.kind, old.ai_comment, old.inspector_comment, old.user_id, old.created_at)
     or old.resolution_status <> 'OPEN' then
    raise exception 'журнал dispute_log неизменяем: допускается только закрыть открытый спор один раз' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger dispute_log_guard before update or delete on dispute_log for each row execute function dispute_log_guard();

-- ─────────────────────────────── Model_Versions: одна действующая модель, откат

alter table model_versions drop constraint model_versions_approval_status_ck;
alter table model_versions add constraint model_versions_approval_status_ck
  check (approval_status in ('AWAITING_APPROVAL', 'REJECTED_BY_GATE', 'PUBLISHED', 'SUPERSEDED', 'ROLLED_BACK'));
-- До T-234 публикация не снимала прежнюю: действующая — та, что в meta.model_version, прочие опубликованные — заменены
update model_versions set approval_status = 'SUPERSEDED'
  where approval_status = 'PUBLISHED' and model_version is distinct from (select value from meta where key = 'model_version');
-- ML_Retraining_Log при ручной регистрации: хеши выборок — из выпуска набора, метрики по категориям — из recall_by_category
update model_versions m set split_hashes_json = d.split_hashes_json
  from dataset_versions d where d.dataset_version = m.dataset_version and m.split_hashes_json is null;
update model_versions set per_category_metrics_json = (
    select coalesce(json_object_agg(e.key, json_build_object('recall', e.value)), '{}'::json) from json_each(metrics_json -> 'recall_by_category') e)
  where per_category_metrics_json is null and metrics_json is not null and json_typeof(metrics_json -> 'recall_by_category') = 'object';

-- ML_Retraining_Log (ТЗ §10 п. 11) — представление над model_versions: поля ТЗ под их именами (ADR-0011)
create view ml_retraining_log as
  select m.id, m.model_version, m.dataset_version, m.split_hashes_json split_hashes,
    (m.metrics_json ->> 'precision')::double precision "precision",
    (m.metrics_json ->> 'recall')::double precision recall,
    (m.metrics_json ->> 'f1')::double precision f1,
    (m.metrics_json ->> 'false_positive_rate')::double precision false_positive_rate,
    m.per_category_metrics_json per_category_metrics, m.approval_status, m.approved_by,
    m.matrix_version, m.training_code_hash, m.trained_by, m.previous_model, m.created_at
  from model_versions m;

-- ─────────────────────────────── Normative_Base: один источник норм

alter table normative_base add column norm_key text unique; -- id записи для паспорта (value.norm.ref)
alter table normative_base add column measure text;
alter table normative_base add column unit text;
alter table normative_base add column rule text;
alter table normative_base add column edition text;
alter table normative_base add column conditions text;
alter table normative_base add column applies_to_json json not null default '[]';
alter table normative_base add column unverified boolean not null default false;
alter table normative_base add column quote text;
alter table normative_base add column source_url text;

-- ─────────────────────────────── права роли API (сервер)

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'inspector_app') then
    grant update (retraining_status, retraining_dataset, retraining_at) on rejection_log to inspector_app;
    grant update (resolution_status, resolved_by, resolved_at, resolution_comment) on dispute_log to inspector_app;
    grant select on ml_retraining_log to inspector_app;
  end if;
end $$;
