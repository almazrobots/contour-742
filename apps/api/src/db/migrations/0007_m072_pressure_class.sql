-- 0007 — М-072 «Материал и класс давления напорных труб»: шкала класса давления PN (T-135, GAP-INSP-07, OS-INSP-3.1.25).
-- Правило «не меньше» без шкалы давало NOT_COMPARABLE: перечисление нельзя упорядочить. Шкала pressure_class — номинальное
-- давление из «PN 16», «Ру 1,6 МПа», «16 бар» (domain/compare.ts: pressureClass). Пересчёт уже посчитанных проверок —
-- через версию правил (domain/rules-version.ts). Миграция неизменяема: правка — только новым файлом.

update params set value_scale_json = '"pressure_class"', updated_at = now() where code = 'M-072' and value_scale_json is null;
update meta set value = '1.1.2' where key = 'matrix_version' and value = '1.1.1' and exists (select 1 from params where code = 'M-072');
