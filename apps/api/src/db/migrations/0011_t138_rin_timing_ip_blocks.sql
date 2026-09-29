-- T-138: номер 0011 — следующий свободный на момент влития (раннер требует нумерацию без пропусков).
--
-- 1. OS-INSP-5.2.6 (ТЗ §11, TZA-11-06): время отправки в ИАИС «РиН». last_attempt_ms — длительность последней попытки
--    (соединение, передача, ответ); delivered_ms — от постановки протокола в очередь до ответа «РиН» (только SYNCED).
-- 2. NFR-IDS (ТЗ 12.9, TZA-12.9-01/02): блокировки адресов детектором атак. В базе, а не в памяти процесса: блокировку
--    видят все экземпляры API, она переживает перезапуск, администратор снимает её одной записью.
--    Строка на адрес: повторная блокировка того же адреса обновляет строку (счётчик blocks — сколько раз блокировался).
-- Миграция неизменяема: правка — только новым файлом.

alter table sync_jobs add column last_attempt_ms integer;
alter table sync_jobs add column delivered_ms integer;

create table ip_blocks (
  ip text primary key,
  reason text not null,
  score integer not null,
  events_json text not null,
  blocks integer not null default 1,
  blocked_at timestamptz not null,
  until timestamptz not null,
  released_at timestamptz,
  released_by text);
create index ix_ip_blocks_until on ip_blocks(until);
