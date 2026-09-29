# Оставшиеся сценарии: recipe изолированной съёмки

29.09.2026. Только source audit; команды ниже не выполнялись. Пин API: `c0851cc7b78e28e7bd7a477be2d3274010d42144`; actual web image `e1c9dc4f` с overlay, исходный UI-паритет не доказан. Сохранять SHA-256 реально загруженных JS/CSS. Селекторы сверены с исходниками; если deployed DOM отличается, остановить сценарий и зафиксировать расхождение, не подменять UI.

## Обязательная изоляция

Использовать bootstrap/route guard из `scripts/capture-guide-inspector.mjs`: экспорт pinned source, `openDb('memory')`, приватный mkdtemp для blobs, dev-профиль, все browser `/api/**` через настоящий `app.inject`; любые production APIcalls/writes запрещены. Перед импортом задать `INSPECTOR_PROFILE=dev`, `INSPECTOR_QUEUE=inproc`, `INSPECTOR_AV=off`, `INSPECTOR_BLOB_STORE=fs`, приватный `INSPECTOR_BLOB_DIR` и отдельный demo password. Не поднимать sync worker. Сеть разрешать только для чтения assets/health и явно отдельного ML dev endpoint, если он действительно запущен; запретить production ML, РиН и GPU endpoints.

`AV=off` допустим только dev: запись не демонстрирует производственную антивирусную проверку. Учебные роли логинить настоящим `POST /api/v1/auth/login`; пароль/токены не писать в provenance. Каждый capture имеет собственные memory DB и blob-dir; singleton parse queue не разделять между параллельными DB в одном процессе.

## 1. Загрузка PDF: настоящий приём отдельно от настоящего разбора

Сгенерировать **PDF с текстовым слоем** и надписью «Синтетический учебный документ»; не использовать image-only PDF из текущего inspector-fixture для CPU text-layer проверки. Имя `DEMO-PD.pdf`. Для простого приёма достаточно ручной карточки объекта; отсутствие реестра честно показывать как ограничение редакций.

### A. Приём без ML — исполнимый минимальный capture

В UI нет start=false. Поэтому для сценария только приёма и просмотра выполнить реальный multipart intake **до съёмки**, передав `start=false`; в титре назвать «Принятый учебный пакет, обработка ещё не запускалась». Нельзя монтировать этот API setup как нажатие UI «Загрузить и начать проверку».

```js
const form = new FormData();
form.append('object', JSON.stringify({object_id:'DOCS-UPLOAD-01',name:'Учебная загрузка',address:'Учебный адрес'}));
form.append('start','false');
form.append('files',new Blob([pdfBytes],{type:'application/pdf'}),'DEMO-PD.pdf');
const request = new Request('http://localhost/api/v1/documents/upload',{method:'POST',body:form});
const accepted = await app.inject({method:'POST',url:'/api/v1/documents/upload',
 headers:{authorization:'Bearer '+inspectorToken,'content-type':request.headers.get('content-type')},
 payload:Buffer.from(await request.arrayBuffer())});
assert.equal(accepted.statusCode,202);
const {process_id,accepted:files,rejected}=accepted.json();
assert.equal(files.length,1); assert.equal(rejected.length,0);
assert.equal((await db.get('select parse_status from files where id=$1',[files[0].file_id])).parse_status,'PENDING');
await page.goto(base+'/#/inspections/'+process_id);
await page.getByRole('button',{name:/^Документы/}).click();
await page.getByText('DEMO-PD.pdf',{exact:false}).first().click();
```

Дополнительно assert: принятый sha256 равен реальным PDF bytes; `GET /api/v1/files/:id/content` возвращает 200 и те же bytes; событие FILES_UPLOADED относится к этому process_id. ML, RabbitMQ, GPU и Redis не нужны для start=false. Blob/PDF preview нужны. Выход: честные кадры состава пакета и оригинала с PENDING, не DONE/READY и не успешный OCR.

### B. Полный путь UI → настоящий разбор

Требует **реального отдельного Python ML dev-сервиса pinned tree**, общего приватного blob-dir и его настоящих зависимостей PDF parser. Запускать его только отдельной разрешённой задачей; этот аудит ничего не запускает. Text-layer PDF в dev позволяет проверить CPU parser/anchors без GPU/LLM; результат не называть OCR скана или доказательством GPU-паритета. GPU-профиль требует RabbitMQ/clamd и настроенных OCR/provider зависимостей; переключение рабочего GPU запрещено этим recipe.

После готовности отдельного ML `/health` задать API `INSPECTOR_ML_URL` на его loopback URL. Из `#/new`: `#card-object_id`, `#card-name`, `#files.setInputFiles({name:'DEMO-PD.pdf',mimeType:'application/pdf',buffer:pdfBytes})`; нажать `getByRole('button',{name:'Загрузить и начать проверку',exact:true})`. Ожидать реальный POST upload 202, «Результат приёма», затем «Открыть проверку».

API запускает `startProcessing → parseQueue(db)`; в dev worker in-process, отдельный server worker не требуется. `parseOne` вызывает `/parse/part` при соответствующем размере и `/analyze`, записывает extractions/pages/engine/ml_revision, затем `maybeFinishParsing`. Для одного малого файла достаточно реального analyze; не seed-ить результаты и не fulfill-ить fake ML JSON.

Assertions: `await parseQueue(db).idle()`; `GET /api/v1/inspection/:id/status`; файл DONE только после настоящего ML ответа, engine/ml_revision сохранены, PDF content200; `GET /api/v1/inspections/:id` действительно содержит результат. В extraction проверять конкретный ожидаемый текст/значение лишь если настоящий parser его нашёл; отсутствие извлечения показать как факт, не исправлять SQL. При FAILED сохранить parse_error и остановить «успешный» capture. Если ML недоступен — не ждать бесконечно и не выдавать seeded inspector checks за результат загрузки.

## 2. GOLD / ранжирование / публикация / журнал

Источник исполнимого memory fixture: pinned `apps/api/tests/retrain-route.test.ts`, `seedFinalized` (80 синтетических объектов, положительные/отрицательные решения) и обычные seed users. Эти **заранее подготовленные экспертные результаты** допускаются только как данные старта и маркируются на кадрах; не заявлять их полученными OCR. Не seed-ить dataset_versions/model_versions/успешные метрики/аудит результата capture.

| Этап | Роль, route и UI selector | Реальный API/DB assertion |
|---|---|---|
| Preview/release | curator; `#/ml`; «Черновик GOLD», button «Выпустить версию» | GET `/api/v1/ml/gold/preview` 200; POST `/api/v1/ml/gold/release` 200, непустой dataset_version; dataset_items соответствуют выпуску; audit DATASET_RELEASED |
| Train | ml либо admin; `#/ml`; строка версии набора, button «Дообучить» | POST `/api/v1/ml/models/train` 201; model_version, metrics, gate из настоящего trainIteration; model_versions и audit из API |
| Gate refusal | та же роль; фактически показанный REJECTED_BY_GATE/422 | Зафиксировать настоящие gate.reasons/ошибку; не регистрировать fabricated хорошие metrics через POST models ради успеха |
| Publish | **admin**; `#/ml`; button «Подписать публикацию», только если AWAITING_APPROVAL | POST `/api/v1/ml/models/:v/approve` 200; PUBLISHED и MODEL_PUBLISHED audit. При отказе сохранить фактический outcome |
| Journal | admin либо supervisor; `#/audit`; `#a-action.selectOption('DATASET_RELEASED')`, затем MODEL_PUBLISHED при реальном успехе | GET `/api/v1/audit?action=…` 200; время/автор/версия совпадают с событиями capture; не seed-ить строки audit |
| Metrics | admin; `#/monitoring`; `#m-name`, `#m-range` | GET `/api/v1/monitoring/metric-names` и `/metrics?...` 200; настоящий sampler либо честное «Нет снимков за интервал», без fake load |

Для role switch использовать штатный выход/новый контекст и intercepted login. Супервизор имеет право approve, но screen запрашивает также ml.read: для полноценного видео публикации брать admin; не обходить отказ UI расширением его роли. Curator не запускает train, ML не выпускает GOLD; отрицательные 403 проверить в отдельном memory smoke, вне нормального ролика.

Ранжирование реализовано TypeScript CPU-алгоритмом (`domain/retrain.ts`); этому сценарию не нужен ML-сервис/GPU и он **не обучает OCR/VLM/LLM/LoRA**. Метрики только по синтетическому набору. Настоящие dataset consistency/hidden-seal/gates не отключать; если исходная pinned test fixture не проходит, снять отказ и доработать безопасные исходные данные отдельно, не подменять модель.

## Контроль артефактов

Сначала smoke настоящего API/SQL без записи; затем один browser capture на deployed assets, проверка всех перехватов и page_errors. Assertions выше являются recipe, не результатами этого аудита. После выполнения сохранить actual responses без секретов, hashes/revisions, synthetic provenance, кадры/видео/captions/transcript и явно название профиля. Никакие удачные шаги recipe не считать проверенными до реального прохода.
