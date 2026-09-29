-- NFR-PDN (T-137, OWASP R2): узкая лазейка обезличивания журнала аудита — ещё уже.
-- 0009 пропускала UPDATE при флаге сеанса inspector.pdn_anonymize = 'on', а флаг ставит любая сессия. Теперь пропуск —
-- только если одновременно: флаг выставлен, текущая роль — владелец функции pdn_anonymize_audit (внутри SECURITY DEFINER
-- это так, снаружи — нет), запись старше 90 дней (ТЗ 12.5), меняются только IP и User-Agent на NULL.

create or replace function audit_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('inspector.pdn_anonymize', true), '') = 'on'
     and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p where p.proname = 'pdn_anonymize_audit' limit 1)
     and old.timestamp < now() - interval '90 days'
     and (new.id, new.user_id, new.action, new.object_id, new.details, new.timestamp)
         is not distinct from (old.id, old.user_id, old.action, old.object_id, old.details, old.timestamp)
     and new.ip_address is null and new.user_agent is null then
    return new;
  end if;
  raise exception 'журнал % неизменяем: % запрещён', tg_table_name, tg_op using errcode = '42501';
end $$;

-- Изменять журнал не может никто, кроме владельца: права у PUBLIC снимаются безусловно (роль inspector_app — в 0002 и 0009)
revoke update, delete, truncate on audit_log from public;
