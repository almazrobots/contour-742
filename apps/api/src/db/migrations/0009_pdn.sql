-- 0008 — персональные данные по 152-ФЗ (T-137, ТЗ 12.6-01, NFR-PDN; реестр — domain/pdn.ts, docs/security/PDN-REGISTRY.md).
-- 1) users.deactivated_at: учётка выключается, а не удаляется (след в журнале и протоколах остаётся); через
--    INSPECTOR_PDN_USER_DAYS дней после выключения services/pdn.ts обезличивает ФИО и логин (ст. 21 ч. 7).
-- 2) Журнал аудита неизменяем (0002, HIGH-2). Единственное исключение — обнулить IP-адрес и User-Agent записей
--    старше срока (INSPECTOR_PDN_AUDIT_DAYS). Делает это только функция pdn_anonymize_audit: она ставит флаг сеанса
--    на время своего UPDATE, а триггер пропускает строку лишь при флаге и лишь если все прочие колонки прежние,
--    а IP и UA стали NULL. Прямой UPDATE (даже ip → NULL) по-прежнему отклоняется; DELETE и TRUNCATE — как в 0002.
-- Миграция неизменяема: правка — только новым файлом.

alter table users add column deactivated_at timestamptz;

create function audit_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('inspector.pdn_anonymize', true), '') = 'on'
     and (new.id, new.user_id, new.action, new.object_id, new.details, new.timestamp)
         is not distinct from (old.id, old.user_id, old.action, old.object_id, old.details, old.timestamp)
     and new.ip_address is null and new.user_agent is null then
    return new;
  end if;
  raise exception 'журнал % неизменяем: % запрещён', tg_table_name, tg_op using errcode = '42501';
end $$;

drop trigger audit_log_append_only on audit_log;
create trigger audit_log_append_only before update or delete on audit_log for each row execute function audit_log_guard();

-- SECURITY DEFINER: выполняется правами владельца журнала — у роли API права UPDATE на audit_log нет (0002).
-- search_path фиксируется на момент создания: подмена схемы вызывающим не подсунет чужую таблицу.
create function pdn_anonymize_audit(cutoff timestamptz) returns integer language plpgsql security definer
set search_path from current as $$
declare
  n integer;
begin
  -- ТЗ 12.5: журнал штатных операций хранится не меньше 90 дней — границу моложе функция не принимает, какую бы ни передал
  -- вызывающий (OWASP T-137 E3-M3: роль API одним вызовом с будущей датой обнуляла бы IP и UA во всём журнале)
  if cutoff is null or cutoff > now() - interval '90 days' then
    raise exception 'pdn_anonymize_audit: граница % моложе 90 дней (ТЗ 12.5)', cutoff using errcode = '22023';
  end if;
  perform set_config('inspector.pdn_anonymize', 'on', true);
  update audit_log set ip_address = null, user_agent = null
    where timestamp < cutoff and (ip_address is not null or user_agent is not null);
  get diagnostics n = row_count;
  perform set_config('inspector.pdn_anonymize', '', true);
  return n;
end $$;

revoke all on function pdn_anonymize_audit(timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'inspector_app') then
    grant execute on function pdn_anonymize_audit(timestamptz) to inspector_app;
    revoke update, delete, truncate on audit_log from inspector_app;
  end if;
end $$;
