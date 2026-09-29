# T-239: сценарии проверки resource guards

Запускать только на GPU-хосте через `scripts/remote-run.sh`, в согласованном окне владельца стенда. Здесь сценарии, а не результаты real-fault проверки. Основа — `scripts/runner/pipeline-durable-smoke.mjs`: fresh synthetic upload, снимки jobs/executions до воздействия и после восстановления, сохранённые committed stages. Один fault за прогон. Корпус не использовать.

1. **Oversize raster.** Синтетический PNG/TIFF с размерами выше pixel-кредита attempt, но ниже Pillow decompression-bomb порога. Входные размеры брать из закреплённой node policy; не менять DPI ради прохождения. Дождаться parse attempt. Ожидать ResourceBudgetExceeded до load/copy/resize, отсутствие Reader dispatch, отсутствие второго активного attempt; затем обычный маленький synthetic документ должен проходить после доказанного cleanup. Unit evidence: `test_parse_image_denied_before_decode`, `test_image_allocations_denied_before_pillow`. PDF passport отдельно: `test_passport_ink_denied_before_pdfium_render`.

2. **Stale telemetry.** В контролируемом harness подставить последний валидный Telemetry с observed_at старше policy telemetry_ttl, сохранив остальные данные. Поставить fresh job: reserve_next обязан вернуть wait/stale_telemetry, без выдачи reservation и без запуска worker job. Cleanup старого reservation должен оставаться доступным. После свежего observation — один admission. В текущем durable smoke нет такого injection hook; остановка всего supervisor не доказывает stale-telemetry ветку. Для real-fault требуется отдельный изолированный telemetry hook, не production endpoint.

3. **Frozen worker.** По committed supervisor identity получить PID и start_time текущего дочернего worker; сверить identity непосредственно перед SIGSTOP. Заморозить только этот PID, не общий GPU сервис. Поставить второй synthetic job. Проверить удержание первого reservation, отсутствие второго worker/Reader запуска и отсутствие ложного DONE. Сохранить snapshot; в finally дать SIGCONT тому же identity. После восстановления первый attempt должен завершиться либо пройти bounded cancellation с stop proof, затем может начаться второй. Нельзя считать frozen PID доказанно остановленным. Heartbeat обновляется только после ограниченного по времени private health probe; SIGSTOP должен привести к UNKNOWN без освобождения резерва.

## Проверено до deployment

- `44de8efc`: resource_scope + formats — 40 passed на GPU-хосте, включая реальный PDFium bitmap под guard.
- `8e0ffc6d`: resource_scope + formats + page_passport — 89 passed, один baseline fail: rotated page сообщает portrait вместо ожидаемого landscape.
- Прежний `page_passport.py` из `8e0ffc6d^` воспроизводит тот же fail на раннере (лог `20260929-053326-feat_resource-ocr-incremental.log`). Geometry не менялась.
- Полный runtime fault smoke этим документом не подтверждается.

## Подготовленные команды (real freeze — только окно root)

- Freeze сценарий: `PIPELINE_SMOKE_FREEZE_WORKER=1 node scripts/runner/pipeline-durable-smoke.mjs` через root remote runner. Helper требует host PID в cgroup именно контейнера этого стенда, сверяет boot ID/start ticks до обоих сигналов, сохраняет reservation/token/resources и наблюдаемый UNKNOWN. После SIGCONT выполняются существующие проверки READY, COMPLETE, publishable trace, one epoch, artifacts = jobs, zero active pins, single protocol и неизменность ранее committed artifacts.
- Изолированная policy-проверка: из `ml`, `PYTHONPATH=. .venv/bin/python ../scripts/runner/resource-policy-smoke.py <копия node-policy.json>`. Копия только читается; temporary journal с новым UUID создаётся отдельно, worker не запускается. Проверяется wait/stale_telemetry → admit_once после fresh telemetry и reject/capacity при enqueue завышенного pixel demand.
- Реальный SIGSTOP/SIGCONT прошёл на runtime `8524386f`: `P-20260929-22fef4e5`, 7 jobs, 65 с, RC=0. Evidence `/opt/resource-ocr/t239-freeze-8524386f`, лог `20260929-060509-feat_resource-ocr-incremental-7004.log`. UNKNOWN наблюдался, token/resources сохранялись, epoch не увеличился; после SIGCONT документ завершён. Отдельная загрузка второго документа во время freeze этим прогоном не проверена.
