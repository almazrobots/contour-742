-- 0013 — источник файла в реестре проверки (T-169, OS-INSP-1.2.36).
-- Файл больше предела интерактивной загрузки (50 МБ) принимается серверным импортом: содержимое кладётся в хранилище
-- вне интерактивного запроса, API регистрирует его по SHA-256. Реестр и отчёт о приёме называют источник.
-- upload — интерактивная загрузка и автозабор «РиН» (прежние строки), server_import — серверный импорт.
-- Миграция неизменяема: правка — только новым файлом. Номер — следующий свободный на момент слияния в main.

alter table files add column intake_source text not null default 'upload';
alter table files add constraint files_intake_source_check check (intake_source in ('upload', 'server_import'));
