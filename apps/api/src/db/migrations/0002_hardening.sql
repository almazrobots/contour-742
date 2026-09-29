-- 0002 — усиление слоя данных по OWASP-аудиту 2026-09-26 (docs/audit/2026-09-26-owasp-бд.md, T-107).
--   HIGH-2: журналы append-only — триггеры (действуют и на владельца, и на суперпользователя) + отзыв прав у роли API;
--   HIGH-3: в sessions — SHA-256 токена, а не сам токен;
--   M-4:    CHECK на перечислимые колонки — значения собраны из кода (domain/types.ts и все места записи);
--   M-7:    финализированный протокол неизменяем.
-- GRANT/REVOKE — только если роль inspector_app существует (сервер, профиль gpu); на PGlite ролей нет.
-- Миграция неизменяема: правка — только новым файлом.

-- ─────────────────────────────── HIGH-2: журналы только дописываются

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'журнал % неизменяем: % запрещён', tg_table_name, tg_op using errcode = '42501';
end $$;

create trigger audit_log_append_only before update or delete on audit_log for each row execute function forbid_mutation();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function forbid_mutation();
create trigger rejection_log_append_only before update or delete on rejection_log for each row execute function forbid_mutation();
create trigger rejection_log_no_truncate before truncate on rejection_log for each statement execute function forbid_mutation();
create trigger dispute_log_append_only before update or delete on dispute_log for each row execute function forbid_mutation();
create trigger dispute_log_no_truncate before truncate on dispute_log for each statement execute function forbid_mutation();
create trigger prescription_events_append_only before update or delete on prescription_events for each row execute function forbid_mutation();
create trigger prescription_events_no_truncate before truncate on prescription_events for each statement execute function forbid_mutation();

-- Решение инспектора: единственное допустимое изменение — снять его (superseded false → true, повтор true → true
-- безвреден). Вернуть снятое, поменять автора, действие, статус, причину, комментарий, время или удалить — нельзя.
create function decisions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'решение инспектора неизменяемо: DELETE запрещён' using errcode = '42501';
  end if;
  if (new.id, new.check_id, new.user_id, new.action, new.status, new.reason_code, new.comment, new.created_at)
       is distinct from (old.id, old.check_id, old.user_id, old.action, old.status, old.reason_code, old.comment, old.created_at)
     or (old.superseded and not new.superseded) then
    raise exception 'решение инспектора неизменяемо: допускается только superseded false → true' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger decisions_guard before update or delete on decisions for each row execute function decisions_guard();
create trigger decisions_no_truncate before truncate on decisions for each statement execute function forbid_mutation();

-- ─────────────────────────────── M-7: финализированный протокол неизменяем

-- Отмена финализации порождает новую версию протокола (services/inspections.ts: unfinalize), а не правит снимок.
create trigger protocols_finalized_immutable before update or delete on protocols
  for each row when (old.finalized_at is not null or old.status = 'FINALIZED') execute function forbid_mutation();
create trigger protocols_no_truncate before truncate on protocols for each statement execute function forbid_mutation();

-- ─────────────────────────────── права роли API (сервер)

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'inspector_app') then
    revoke update, delete, truncate on audit_log, rejection_log, dispute_log, prescription_events, decisions from inspector_app;
    grant update (superseded) on decisions to inspector_app;
    revoke delete, truncate on protocols from inspector_app;
  end if;
end $$;

-- ─────────────────────────────── HIGH-3: хеш токена вместо токена

-- Открытые токены удаляются — все перелогинятся один раз
delete from sessions;
alter table sessions rename column token to token_hash;
alter table sessions add constraint sessions_token_hash_ck check (token_hash ~ '^[0-9a-f]{64}$');

-- ─────────────────────────────── M-4: перечислимые колонки

-- domain/types.ts Role без 'system': служебный актор без учётки, в users не пишется
alter table users add constraint users_role_ck
  check (role in ('inspector', 'supervisor', 'admin', 'ml_engineer', 'curator'));

-- domain/types.ts ProcessStatus
alter table inspections add constraint inspections_status_ck
  check (status in ('PENDING', 'PARSING', 'READY', 'VERIFYING', 'COMPLETED', 'FINALIZED'));

-- domain/types.ts FindingStatus (compare.ts, hidden-works.ts, requisites.ts, sheetdiff.ts, advisor.ts)
alter table checks add constraint checks_finding_status_ck
  check (finding_status in ('NEGATIVE_VERIFIED', 'CANDIDATE', 'MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED'));
-- domain/types.ts VerificationStatus + служебный SPLIT (разделённый составной кандидат, inspections.ts splitCandidate)
alter table checks add constraint checks_verification_status_ck
  check (verification_status in ('PENDING', 'CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED', 'CLARIFICATION_REQUIRED', 'SPLIT'));

-- domain/lifecycle.ts Decision.action и applyDecision
alter table decisions add constraint decisions_action_ck check (action in ('confirm', 'reject', 'clarify'));
alter table decisions add constraint decisions_status_ck check (status in ('CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED', 'CLARIFICATION_REQUIRED'));

-- Гипотеза пишется только со статусом по умолчанию (0001); решение инспектора — PENDING/ACCEPTED/DISMISSED (app.ts, advisor.ts)
alter table suspicions add constraint suspicions_finding_status_ck check (finding_status in ('SUSPICION'));
alter table suspicions add constraint suspicions_inspector_status_ck check (inspector_status in ('PENDING', 'ACCEPTED', 'DISMISSED'));

-- domain/types.ts STAGES; манифест — domain/upload.ts z.enum, без манифеста — inspections.ts guessStage
alter table files add constraint files_doc_stage_ck check (doc_stage in ('PD', 'RD', 'ID'));

-- services/rin.ts (IN_FLIGHT — захват тиком, CANCELLED — снятое задание), app.ts /sync, inspections.ts finalize
alter table sync_jobs add constraint sync_jobs_status_ck check (status in ('PENDING_SYNC', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'CANCELLED'));

-- domain/rin-pull.ts RinPackageStatus + служебный IN_FLIGHT (services/rin-pull.ts, захват пакета)
alter table rin_packages add constraint rin_packages_status_ck check (status in ('PENDING', 'FETCHED', 'NOTIFIED_ONLY', 'REJECTED', 'IN_FLIGHT'));

-- domain/prescriptions.ts PRESCRIPTION_STATUSES
alter table prescriptions add constraint prescriptions_current_status_ck
  check (current_status in ('ISSUED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXTENDED'));
alter table prescription_events add constraint prescription_events_status_ck
  check (status in ('ISSUED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXTENDED'));

-- app.ts POST /ml/models, services/retrain.ts (гейт) и /approve
alter table model_versions add constraint model_versions_approval_status_ck
  check (approval_status in ('AWAITING_APPROVAL', 'REJECTED_BY_GATE', 'PUBLISHED'));

-- inspections.ts snapshotProtocol
alter table protocols add constraint protocols_status_ck check (status in ('DRAFT', 'FINALIZED'));

-- Уверенность — доля: ML (extract.py, requisites.py) и предметные правила (suspicions.ts, patterns.ts, advisor.ts)
alter table extractions add constraint extractions_confidence_ck check (confidence between 0 and 1);
alter table suspicions add constraint suspicions_confidence_ck check (confidence between 0 and 1);
alter table requisites add constraint requisites_confidence_ck check (confidence between 0 and 1);
