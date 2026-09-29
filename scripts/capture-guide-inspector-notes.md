# Подготовка capture инспектора — точный fixture и ограничения

Сценарий: **«Решение инспектора на заранее подготовленных учебных результатах»**. Это проверка работы со сводкой, источниками, решением и финализацией. Не показывать fixture как результат успешного OCR/ML или фактическую передачу в РиН.

Исполнимый capture: `scripts/capture-guide-inspector.mjs`; runner: `scripts/runner/capture-guide-inspector.sh`. Запуск только через `remote-run.sh --wip --lane docs-inspector-media`; production API не используется. До успешного завершения, просмотра PNG и проверки видео материалы не считать готовыми.

## Версия и изоляция

- Пин основного GPU API: `c0851cc7b78e28e7bd7a477be2d3274010d42144`; deployed web image `e1c9dc4f61d29e71212dda8ad5fa69f9b1cda68a` содержит overlay. Паритет исходников UI не заявляется: capture сохраняет SHA-256 реально загруженных JS/CSS. Health проверяется read-only на `https://127.0.0.1:46443/health`. CPU `cfb0ebc6` — иной стенд.
- Использовать отдельный source export этой версии с `PINNED-REVISION`; импортировать из него `apps/api/src/db.ts` и `app.ts`, открыть только `openDb('memory')`.
- До импортов установить `INSPECTOR_PROFILE=dev`, `INSPECTOR_BLOB_STORE=fs`, отдельный приватный `INSPECTOR_BLOB_DIR` из `mkdtemp`, демонстрационный пароль, `INSPECTOR_ML_URL=http://127.0.0.1:9`. ML здесь намеренно не запускается. Исходящий fetch fixture запрещён; sync worker не запускается.
- Перехватить **все** browser `/api/**` и направить через `app.inject`, как в `capture-guide-verification.mjs`; не ограничиваться mutations. Любой неожиданно ушедший сетевой API запрос прерывает capture. Source assets/health можно читать, production API не вызывается.
- РиН не вызывать: не поднимать sync worker; запретить исходящий transport. Финализация остаётся `PENDING_SYNC`, что следует честно показать. Не подставлять 202 от внешней системы ради красивого статуса.

## Fixture recipe (DB initialization, до записи видео)

Основания в pinned tree: `tests/decision-integrity-route.test.ts:seed`, `tests/inspection-card-route.test.ts`, `tests/finalize-critical-route.test.ts`; исходный `e2e.test.ts` использует реальный upload+ML и не является готовым visual fixture.

```js
const at = new Date().toISOString();
await db.run("insert into objects (id,name,profile_json,created_at) values ($1,$2,'{}',$3)",
  ['DOCS-OBJECT-01','Учебный объект — проверка этажности',at]);
await db.run("insert into inspections (id,object_id,status,protocol_version,scenario,created_at,updated_at) values ($1,$2,'READY',1,'FULL',$3,$3)",
  ['DOCS-INSPECTION-01','DOCS-OBJECT-01',at]);
// Two real PDFs drawn from scratch and saved with Pillow: PD 11, RD 12; no private corpus.
// sha/size must be actual digest/bytes; use pinned blobStore().put(sha, bytes),
// not direct disk writes: the core file store may encrypt/check blobs.
for (const f of syntheticFiles) { // id, stage, sha, bytes, pageMetadata
  await db.run(`insert into files
    (id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,
     doc_stage,document_code,revision,parse_status,revision_role,pages_json,uploaded_at)
     values ($1,'DOCS-INSPECTION-01','DOCS-OBJECT-01',$1,$2,$3,$4,'pdf',
     $5,$6,'1','DONE','CURRENT',$7,$8)`,
    [f.id,`Учебный пример — ${f.stage}.pdf`,f.sha,f.bytes.length,
     f.stage,`DEMO-${f.stage}`,JSON.stringify(f.pageMetadata),at]);
}
await db.run(`insert into checks
  (id,inspection_id,param_code,evidence_group_id,finding_status,verification_status,
   expected_value,actual_value,review_priority,reason,computed_in_version,created_at,updated_at)
  values ('DOCS-CHECK-01','DOCS-INSPECTION-01','M-007','DOCS-EVIDENCE-01',
   'CANDIDATE','PENDING','11','12','MEDIUM',$1,1,$2,$2)`,
  ['Заранее подготовленное учебное расхождение ПД и РД; OCR не запускался',at]);
for (const f of syntheticFiles) {
  await db.run(`insert into evidence_fragments
    (check_id,file_id,sha256,stage,document_code,revision,sheet_page,
     extracted_value,role_expected_actual)
    values ('DOCS-CHECK-01',$1,$2,$3,$4,'1',1,$5,$6)`,
    [f.id,f.sha,f.stage,`DEMO-${f.stage}`,
     f.stage==='PD'?'11':'12',f.stage==='PD'?'expected':'actual']);
}
```

`syntheticFiles` содержит ровно `DOCS-FILE-PD`/`DOCS-FILE-RD`, stages PD/RD, реальные PDF bytes и actual sha256. Sheet читает оригиналы через `/api/v1/files/:id/content` и pdf.js; runner сохраняет PDF через Pillow. Blob сохраняется только через `blobStore().put`. Метаданные страницы — page/width/height, без фиктивного OCR confidence/source. BBox опущен.

## Capture sequence и assertions

1. Войти inspector через реальный intercepted `POST /api/v1/auth/login`; UI показывает учебный объект, статус READY и одного кандидата. Снять `inspector-overview.png`.
2. Открыть `#/inspections/DOCS-INSPECTION-01/verify`; показать ПД 11 и РД 12, получить оба оригинала через intercepted core API, а не mock изображений. Снять `inspector-evidence.png`.
3. Нажать «Признать». Pinned UI `Verify.tsx` отправляет `{action:'confirm'}` без обязательного комментария. Нельзя утверждать, что UI сохранил введённое основание, если в этой форме его нет. Решение основано на видимых источниках.
4. Проверить intercepted POST `/api/v1/checks/DOCS-CHECK-01/decision`: 200, `verification_status=CONFIRMED_VIOLATION`, `process_status=COMPLETED`. SQL: одна действующая строка `decisions`, совпадение user_id инспектора, `action=confirm`; статус check CONFIRMED_VIOLATION, inspection COMPLETED, запись DECISION_* в audit. Снять `inspector-decision.png` после повторного GET.
5. Вернуться в карточку; «Завершить» запускает проверку `/critical-unresolved` и 10-секундное окно отмены. В fixture нет критического пропуска; дождаться настоящего UI commit, не подменять его seed SQL. Снять `inspector-finalized.png`.
6. Проверить POST `/api/v1/inspection/DOCS-INSPECTION-01/finalize`: 200; DB status FINALIZED, finalized_at заполнен, protocol status FINALIZED, audit PROTOCOL_FINALIZED, sync_job PENDING_SYNC. Следующий decision запрос — 409. Не отправлять mutation для этого assertion в production.

Начальный POST finalize до решения должен вернуть 409 на отдельном fixture smoke прогоне. Не включать искусственный отказ в видео нормального сценария. Создание checks/files допустимо только до capture; решения, аудит и протокол не seed-ить.

## Проверки исполнимого capture

- `BlobStore.put(sha: string, buf: Buffer): Promise<void>` используется с actual PDF bytes; оба `/content` должны вернуть 200, pdf.js должен создать два canvas с ненулевыми размерами.
- Селекторы выбираются по фактическому deployed UI; после login ожидается список с учебным объектом. Health подтверждает API c085, а не паритет UI source. Перед чтением оригиналов ожидаются оба response.finished, canvas dimensions сами по себе недостаточны.
- Не требуется ли computed metadata для generation protocol: проверить реальный API finalize в отдельном memory smoke run; не обходить отказ прямым SQL FINALIZED.
- Что sync/background jobs не обращаются к внешним системам; route guard запрещает все неперехваченные API запросы.
- После capture — visual review четырёх PNG, playback video, WebVTT/transcript, подписи «Учебные данные; заранее подготовленные результаты; ML/OCR и передача в РиН не демонстрируются», provenance с revisions и реальными assertions.
- В PATH runner ffprobe/ffmpeg отсутствуют; bundled `/opt/w1-gate/home/w1run/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux` поддерживает VP8 decode и PNG encode. `--review-video` проверяет полное playback готового локального WebM без decoder error, затем извлекает кадры этим бинарником, записывает actual duration, hashes и ограничивает последний VTT cue длиной видео. Browser seek screenshots сами по себе оказались ненадёжны; использовать decoded-*.png. Production/fixture API не вызываются.

Первый smoke 2026-09-29, job `190013`: memory fixture/PDF blobs/login/premature-finalize409 прошли; browser остановился на гонке login redirect (слишком ранний goto). Исправление: дождаться учебного объекта в списке после login. Повторный job наблюдается до terminal; параллельный повтор capture запрещён.

Успешный capture: job `190416`, лог `/opt/w1-gate/logs/20260929-190416-feat_docs-redesign-plan.wip.log`, RC=0. Проверены оба PDF content200/application-pdf, единственное действующее confirm с user_id инспектора, check CONFIRMED_VIOLATION, inspection COMPLETED, аудит DECISION_CONFIRM; настоящий finalize после 10088мс, protocol/inspection FINALIZED, sync PENDING_SYNC, PROTOCOL_FINALIZED и subsequent decision409. 16 intercepted fixture запросов, production APIcalls/writes0, page_errors пуст.

Артефакты: `out/inspector-media/{inspector-overview,inspector-evidence,inspector-decision,inspector-finalized}.png`, `inspector-walkthrough.webm`, `inspector-walkthrough.vtt`, `inspector-transcript.txt`, `provenance.json`. Четыре PNG просмотрены: два оригинала 11/12 читаются, подтверждение и ожидание отправки в РиН видимы. Выходной каталог может содержать raw/failure от прошлых запусков: публиковать только этот явный набор, не весь каталог.

Фактические deployed assets: `/assets/index-D77tWavi.css` SHA-256 `28d1bf35c3007319799ffa5ecd56d25b626802f1ee9fabe2eeeb11d5274630b0`; `/assets/index-JNMiEqrR.js` SHA-256 `5719a6eee9744d568afd917dc286e99dfb35cb4cae6cd67331c536cbab0cfefa`. Их соответствие исходному web commit не заявлено.

Video QA: bundled ffmpeg job `190925` RC0, просмотрены `out/inspector-review/decoded-evidence.png` (4с: реальные ПД11/РД12), `decoded-undo.png` (15с: countdown5с и «Отменить»), `decoded-finalized.png` (21с: финализирован/ожидает РиН). Browser полное playback1440×1000 без decoder error; фактическая длительность22.04с, wall-clock capture22.734с. SHA-256 видео `8c225601eb47ba94ca8ce9cc2da79608cef00bc38b239194c7c235a9a51b8d0c`; кадров соответственно `8a7b3d681da1b3c8cb8f9747236cd72b1a4e07ccaffdc735108ac5e54163cda1`, `6eaf08b8e5471ec13878d3a89bd588668e1157d3619639ceb030d0c13b395861`, `cb8c015042d1feb0f361e0741d811515a7a3e955783be43ad50b885a5cc0135c`.

Файлы текущего ролика разметки не изменены. Готовность публикации полного пакета инспектора определяется успешным capture, просмотром и последующей интеграцией, а не наличием скрипта.
