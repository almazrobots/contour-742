# Аудит: НФТ, диалоги, объекты данных — «Инспектор ИИ» @ 7e1f886

Область: model.yaml → constraints (26), dialogs (20), data (26). Только чтение, тесты не запускались.
Механическая проверка: все подстроки code-ref и test-ref найдены в своих файлах (ни одной битой ссылки).
Системно: 22 test-ref из области — не точные названия тестов, а их префиксы (все 20 диалогов, три e2e: NFR-AUTH, NFR-ROLES, NFR-INTEGRITY). `pnpm trace` сверяет по `includes`, поэтому это проходит. Все префиксы однозначны, и вердикты ниже на них не снижены.

| Код | Правило (кратко, ≤ 12 слов) | Вердикт | Причина | Код-ссылка | Тест |
|---|---|---|---|---|---|
| NFR-API | REST over HTTPS, JSON, схема OpenAPI 3.0 | YELLOW | В OpenAPI 19 путей, а у API около 55 маршрутов. Тест проверяет только строку версии и один путь | apps/api/src/openapi.ts::openapi: "3.0.3" | e2e.test.ts::метрики Prometheus и OpenAPI |
| NFR-ASYNC | Pull-модель: process_id и эндпоинт статуса | GREEN | Upload отвечает 202 с process_id, `/inspection/:id/status` отдаёт статус. uploadAndWait в тесте проверяет 202 и опрашивает статус до READY | app.ts::/api/v1/inspection/:id/status | e2e.test.ts::OBJ-SEV-2: FULL… |
| NFR-STACK | React, Node.js, Python ≥ 3.11, RabbitMQ | GREEN | fastify, react, requires-python >=3.11, amqpQueue на месте. В gpu без amqp не стартует (config.ts:41). Брокер в тестах поддельный | package.json / pyproject / amqp-queue.ts / compose rabbitmq | queue-contract, queue-profile, test_cache |
| NFR-OCR-Q | OCR CA ≥ 0,95, EM ключевых полей ≥ 0,90 | GREY | Нет impl (mode gpu) | — | — |
| NFR-CV | Масштаб по размерной линейке, измерение на чертеже | GREY | Нет impl (mode gpu). Сама механика измерения есть в OS-INSP-2.4 и DLG-INSP-16, но НФТ к ней не привязано | — | — |
| NFR-PERF | Производительность по ТЗ §11 | GREY | Нет impl (mode gpu). Есть scripts/bench-11.mjs и docs/qa/PERF-11.md, но в model.yaml они не привязаны | — | — |
| NFR-SLA | SLA 99,9 %, RTO ≤ 1 ч, RPO ≤ 15 мин | GREY | Нет impl (mode prod) | — | — |
| NFR-AUTH | Вход по логину и паролю | GREEN | scrypt и timingSafeEqual, сессия с TTL, 401 без токена, 429 после 5 попыток (app.ts:92–118) | app.ts::/api/v1/auth/login | e2e ×2, throttle.test.ts |
| NFR-ROLES | Пять ролей: инспектор, супервизор, админ, ML, куратор | YELLOW | Роли и проверка в auth() есть (app.ts:82). Ссылка ведёт на строку сообщения. Тест покрывает одну пару ролей (admin/inspector) на одном маршруте | app.ts::Недостаточно прав | e2e.test.ts::администратор меняет порог… |
| NFR-CRYPTO | Шифрование в покое (БД, хранилище) | GREY | Нет impl (mode prod). Прототип на SQLite без шифрования | — | — |
| NFR-TLS | HTTPS TLS 1.3; gpu без сертификата не стартует | GREEN | TLS 1.3 закреплён min и max (tls.ts:13), gpu без cert и key падает (config.ts:49–50), nginx на ssl_protocols TLSv1.3. Тесты делают реальные рукопожатия | tls.ts, config.ts, server.ts, compose, prometheus | tls.test.ts ×5, deploy.test.mjs |
| NFR-IMAGES | Образы по digest, smoke-run, без PM и root, CSP | YELLOW | В ml/Dockerfile:32–36 `… && pip uninstall … \|\| true` глушит сбой всей цепочки, включая `apt-get install tesseract`. В рантайме остаются apt, dpkg и apk | Dockerfile ×3, nginx.conf, compose, ci-gate smoke-run, /health revision | deploy.test.mjs ×4, health-revision, test_health…, test_model_file… |
| NFR-LOGRET | Логи 90 дней, безопасность — 1 год | GREEN | ILM: rollover за 1d, delete 90d и 365d. Шаблон data stream привязан к политике. 401/403/429 уходят в inspector-security | ilm-*.json, template, setup.sh, logstash conf, access-log.ts | deploy.test.mjs ×3, domain-access-log |
| NFR-PDN | Обработка ПДн по 152-ФЗ | GREY | Нет impl (mode prod) | — | — |
| NFR-INTEGRITY | Ежедневная сверка хешей хранилища | YELLOW | verifyBlobs верна, но «ежедневно» — это setInterval 24 ч в server.ts:24, которого нет в impl. Его не покрывает ни один тест, а каждый рестарт сбрасывает таймер. Проверяются только блобы, не БД | services/integrity.ts::export async function verifyBlobs | e2e.test.ts::целостность хранилища… |
| NFR-BACKUP | Ежедневный бэкап БД и хранилища, 30 дней | GREY | Нет impl (mode prod), в deploy/ бэкапа нет вообще | — | — |
| NFR-IDS | IDS и защита от DDoS | GREY | Нет impl (mode prod) | — | — |
| NFR-UKEP | Подписание запросов к «РиН» УКЭП | GREY | Нет impl (mode prod) | — | — |
| NFR-MTLS | mTLS клиентским сертификатом УКЭП к «РиН» | YELLOW | Механика mTLS сделана полностью, 18 тестов. Но УКЭП на ГОСТ-ключе в коде нет: режим gost-proxy отдаёт это внешнему шлюзу СКЗИ (rin-tls.ts:3–11). Ошибка конфигурации всплывает только при первой отправке (rin.ts:22) | rin-tls.ts, rin.ts | rin-mtls.test.ts ×18 |
| NFR-VERIFY-30 | Цикл верификации ≤ 30 мин, тест на 5 инспекторах | YELLOW | Есть только инструмент замера: VERIFICATION_OPENED, cycleOf/summarize, отчёт. Сам юзабилити-тест не проведён, утверждение ≤ 30 мин ничем не подтверждено | verify-timing.ts, usability.ts, app.ts, Verify.tsx, протокол | domain-verify-timing ×8, usability-route ×4 |
| NFR-AV | Антивирус до сохранения файла | GREEN | screen стоит до ingest (app.ts:181–184). При сбое сканера — отказ, gpu без clamd не стартует (config.ts:36) | domain/antivirus.ts, services/antivirus.ts, config.ts, app.ts | av-route ×2, domain-antivirus |
| NFR-LOGS | JSON-логи: timestamp, level, service, message, request_id, user_id | YELLOW | formatLog верен, но только в API. ML (uvicorn и logging в ocr_ensemble.py) пишет не-JSON: Logstash помечает такие строки `_inspector_not_json` | services/audit.ts::export function formatLog | queue.test.ts ×2 |
| NFR-METRICS | Prometheus: CPU/RAM, диск, RPS, латентность, 5xx, очередь, сессии | YELLOW | Метрики диска нет. Латентность — среднее с момента старта процесса (app.ts:132), без гистограммы и p95. Тест проверяет одно имя метрики | app.ts::inspector_http_requests_total | e2e.test.ts::метрики Prometheus и OpenAPI |
| NFR-OBS-STACK | Prometheus, Grafana, ELK, алерты на почту и в Telegram | YELLOW | Alertmanager нет, нет ни email, ни Telegram: prometheus.yml знает только rule_files. Алерт InspectorSlowResponses строится на накопительном среднем | grafana json, alerts.yml, prometheus.yml, compose ELK, logstash | deploy.test.mjs ×4 |
| NFR-QUALITY | Приёмка: P ≥ 0,90, R ≥ 0,80, F1 ≥ 0,85, FPR ≤ 0,10, IoU ≥ 0,5 | GREY | Нет impl (mode gpu). В ml/eval/metrics.py и thresholds.py заготовки есть, но не привязаны | — | — |
| NFR-C01 | Корпус corpus-ABC не в репо и демо | YELLOW | Реализация — только `.gitignore corpus*/`, она ловит лишь каталоги с таким именем. Тест проверяет правильность извлечения на синтетике, а не инвариант. Защиты в CI нет | ml/synth/generate.py::def build, .gitignore::corpus*/ | test_parse_extract.py::test_extraction_matches_answer_values |
| DLG-INSP-01 | Вход | GREEN | Форма, ошибка неверного пароля, успешный вход | Login.tsx::export function Login | DLG-INSP-01 Вход… |
| DLG-INSP-02 | Дашборд проверок | GREEN | Фильтры, сводка, объект в группе «Требует внимания» | Inspections.tsx | DLG-INSP-02 Дашборд… |
| DLG-INSP-03 | Загрузка пакета | GREEN | Зона файлов, поля карточки, предупреждение без реестра, кнопка неактивна | NewInspection.tsx | DLG-INSP-03… |
| DLG-INSP-04 | Карточка · Обзор | GREEN | Коды комплектности, 4 формата экспорта, верификация, дозагрузка | Inspection.tsx::export function Inspection | DLG-INSP-04… |
| DLG-INSP-05 | Карточка · Документы | GREEN | Роли редакций («заменена», «эталон») и OCR | Inspection.tsx::tab === "docs" | DLG-INSP-05… |
| DLG-INSP-06 | Карточка · Протокол | GREEN | Четыре раздельные группы статусов | Inspection.tsx::function ProtocolView | DLG-INSP-06… |
| DLG-INSP-07 | Карточка · Гипотезы | YELLOW | Тест «решение по гипотезе» проверяет только подзаголовок панели (Inspection.tsx:234), который виден и без гипотез. Решение не выполняется | Inspection.tsx::tab === "hyp" | DLG-INSP-07… |
| DLG-INSP-08 | Карточка · Версии и журнал | GREEN | Версии протокола, журнал, v1 | Inspection.tsx::tab === "history" | DLG-INSP-08… |
| DLG-INSP-09 | Верификация | GREEN | Очередь, лист, решение клавишей «3» уменьшает число ждущих | Verify.tsx::export function Verify | DLG-INSP-09… |
| DLG-INSP-10 | Матрица контроля | GREEN | Поиск M-041, кнопка «Изменить» у admin | Matrix.tsx | DLG-INSP-10… |
| DLG-INSP-11 | Нормативная база и правила | GREEN | Норматив и логическое правило видны | Normative.tsx | DLG-INSP-11… |
| DLG-INSP-12 | Модель и эталонный набор | GREEN | Блоки GOLD, отчёт, реестр моделей (smoke) | Ml.tsx::export function Ml | DLG-INSP-12… |
| DLG-INSP-13 | Журнал аудита | YELLOW | Тест «действия с IP» не проверяет колонку IP (Audit.tsx:33), только строку LOGIN_FAILED | Audit.tsx | DLG-INSP-13… |
| DLG-INSP-14 | Документы: вид документа | GREEN | Бейджи data-doc-type для чертежа, сметы и опросного листа | DocCard.tsx::DocTypePill, Inspection.tsx | DLG-INSP-14… |
| DLG-INSP-15 | Реквизиты: карточка и рамки | GREEN | Список по страницам, рамки .hl.req, находка REQ, переключатель слоя | DocCard, Sheet, Verify | DLG-INSP-15… |
| DLG-INSP-16 | Измерение на чертеже | GREEN | 6000 мм и расстояния. Без масштаба — «не определён» и 0 расстояний | Sheet.tsx::MeasureLayer, notComparableText | DLG-INSP-16… |
| DLG-INSP-17 | Отклонения и споры | GREEN | Супервизор видит журналы, у инспектора вкладки нет. Тест зависит от состояния, созданного тестом OS-INSP-4.1.5 | Inspection.tsx::function FeedbackLogs | DLG-INSP-17… |
| DLG-INSP-18 | Справочник НПА | GREEN | 13 строк и все колонки | Normative.tsx::id="legal-acts" | DLG-INSP-18… |
| DLG-INSP-19 | Еженедельные отчёты | GREEN | Неделя как диапазон дат, раскрытие отчёта | Ml.tsx::function WeeklyReports | DLG-INSP-19… |
| DLG-INSP-20 | Протокол: запись о применении ИИ | GREEN | Показан режим до финализации. Финализированный режим эмулирован перехватом `final: true`, копирование проверено | Inspection.tsx::function AiUsagePanel | DLG-INSP-20… |
| DO-OBJECT | Объект капитального строительства | GREEN | Таблица objects есть, строка в 04-data есть | db.ts::create table … objects | — |
| DO-INSPECTION | Проверка (process_id) | GREEN | inspections | db.ts | — |
| DO-FILE | Файл с метаданными реестра | GREEN | files | db.ts | — |
| DO-MANIFEST | Реестр файлов пакета | GREEN | inspections.manifest_json, пишется в inspections.ts:193 | db.ts::manifest_json text | — |
| DO-COMPLETENESS | Статус загрузки и сценарий | YELLOW | В data.table указана колонка inspections.scenario, а code-ref ведёт на load_codes_json. Обе колонки есть (db.ts:16), ссылка неточная | db.ts::load_codes_json text | — |
| DO-PAGE | Страница с текстом и bbox | GREEN | files.pages_json | db.ts::pages_json text | — |
| DO-EXTRACTION | Извлечённое значение | GREEN | extractions | db.ts | — |
| DO-PARAM | Параметр Матрицы (132) | GREEN | params, в сид data/seed/matrix.json ровно 132 | db.ts | — |
| DO-CHECK | Доказательная группа / finding | GREEN | checks | db.ts | — |
| DO-FRAGMENT | Доказательный фрагмент | GREEN | evidence_fragments | db.ts | — |
| DO-REJECTION | Rejection_Log | GREEN | rejection_log | db.ts | — |
| DO-DISPUTE | Dispute_Log | GREEN | dispute_log | db.ts | — |
| DO-RETRAIN-REPORT | Отчёт по дообучению за неделю | GREEN | retraining_reports | db.ts | — |
| DO-LEGAL-ACT | НПА ТЗ §2 с редакцией | GREEN | legal_acts, сид 13 актов | db.ts | — |
| DO-SUSPICION | Гипотеза вне Матрицы | GREEN | suspicions | db.ts | — |
| DO-RULE | Логическое правило | GREEN | logical_rules | db.ts | — |
| DO-NORM | Нормативный документ | GREEN | normative_base | db.ts | — |
| DO-PROTOCOL | Версия протокола | GREEN | protocols с unique (inspection_id, version) | db.ts | — |
| DO-DECISION | Решение инспектора | GREEN | decisions | db.ts | — |
| DO-SIGNATURE-CHECK | Проверка откреплённой подписи | GREEN | files.signature_check_json, добавляется через addColumns (db.ts:144) | db.ts::signature_check_json: "text" | — |
| DO-RIN-PACKAGE | Пакет «РиН», забранный автоматически | GREEN | rin_packages | db.ts | — |
| DO-SYNC | Задание передачи в «РиН» | GREEN | sync_jobs | db.ts | — |
| DO-PRESCRIPTION | Предписание и история статусов | GREEN | prescriptions и prescription_events с FK и unique | db.ts ×2 | — |
| DO-DATASET | Версия GOLD и её элементы | GREEN | dataset_versions и dataset_items. dataset_items в API только пишется и нигде не читается | db.ts::dataset_versions | — |
| DO-MODEL | Версия модели | GREEN | model_versions | db.ts | — |
| DO-AUDIT | Запись журнала аудита | GREEN | audit_log с ip_address и user_agent | db.ts | — |

Итог: GREEN 49 (НФТ 6, диалоги 18, данные 25) · YELLOW 13 (НФТ 10, диалоги 2, данные 1) · RED 0 · GREY 10 (НФТ: gpu — OCR-Q, CV, PERF, QUALITY; prod — SLA, CRYPTO, PDN, BACKUP, IDS, UKEP).

## Находки

### 1. NFR-IMAGES — `|| true` глушит сбой установки tesseract в образе ML (YELLOW, серьёзно)
- ml/Dockerfile:32–36: `RUN apt-get update && apt-get -y upgrade && apt-get install … tesseract-ocr … && rm -rf … && python -m pip uninstall -y pip setuptools wheel || true`.
- В sh `&&` и `||` имеют равный приоритет и связываются слева направо. Поэтому `|| true` глушит сбой любого звена, в том числе `apt-get install`. Образ соберётся без tesseract.
- Гейт этого не поймает: smoke-run (ci-gate.yml:91–95) проверяет /health и get_embedder, а /health в ml/inspector_ml/app.py:57–59 про tesseract ничего не знает. OCR упадёт уже в рантайме.
- Второе расхождение с формулировкой «в рантайме нет пакетного менеджера»: удалены только pip и npm, а apt/dpkg в ML (Debian-база) и apk в образах API и web (alpine) остаются. Тест deploy.test.mjs «в рантайм-образ не едет пакетный менеджер…» проверяет только pip и npm.
- Как проверить: `docker run --rm <ml-image> sh -c 'command -v tesseract; command -v apt-get'`. Исправление — вынести `pip uninstall … || true` в отдельный RUN.

### 2. NFR-OBS-STACK и NFR-METRICS — алерты никуда не уходят, алерт на латентность не сработает (YELLOW, серьёзно)
- В deploy/gpu нет Alertmanager. prometheus.yml знает только `rule_files`, `alerting:` нет. Часть НФТ про «алерты на почту и в Telegram» не реализована, хотя в таблице стоит как покрытая.
- `inspector_http_latency_ms_avg` (app.ts:132) — это `latencyMsSum / requests` с момента старта процесса. Когда запросов накопятся тысячи, всплеск не сдвинет среднее, и `InspectorSlowResponses` (alerts.yml) фактически не сработает. Нужна гистограмма и p95 через `histogram_quantile`.
- Метрики диска нет, хотя НФТ её требует: нет node-exporter и нет своей метрики. RAM — только RSS процесса API.
- Тест `метрики Prometheus и OpenAPI` проверяет одно имя метрики.

### 3. NFR-INTEGRITY — «ежедневно» не привязано и не проверяется (YELLOW)
- Периодичность — `setInterval(verifyBlobs, 24h)` в apps/api/src/server.ts:24. Этого места нет в impl, и никакой тест его не покрывает.
- `setInterval` без запуска при старте: если процесс перезапускается чаще раза в сутки (деплой, OOM), сверка не выполнится ни разу.
- Сверяются только блобы (`select distinct sha256 from files`). Целостность БД не контролируется.
- Тест `целостность хранилища: подмена файла обнаруживается…` вызывает ручной POST /admin/integrity, а не ежедневный запуск.

### 4. NFR-C01 — инвариант корпуса держится только на .gitignore (YELLOW)
- `.gitignore:5 corpus*/` игнорирует только каталоги с таким именем. Одиночный файл из корпуса или каталог с другим именем попадёт в коммит.
- Тест `test_extraction_matches_answer_values` проверяет правильность извлечения на синтетике, а не отсутствие корпуса в репо и демо.
- Нет проверки в CI или pre-commit (например, сверки хешей файлов корпуса или запрета известных имён).

### 5. NFR-API — OpenAPI покрывает треть API (YELLOW)
- apps/api/src/openapi.ts описывает 19 путей. В app.ts около 55 маршрутов /api/v1. Нет, среди прочих, `/inspections`, `/inspections/{id}`, `/inspection/{id}/protocols`, `/inspection/{id}/start`, `/inspection/{id}/sync`, `/checks/{id}/fragments`, `/ml/*`, `/rules*`, `/normative*`, `/legal-acts`, `/audit`, `/notifications`, `/auth/me`, `/auth/logout`, `/files/{id}/content`.
- Тест проверяет только `openapi === "3.0.3"` и наличие `/api/v1/documents/upload`.
- Как проверить: сравнить `grep -oE 'app\.(get|post|patch|delete)\("[^"]*"' apps/api/src/app.ts` с ключами `openapi.paths`. Такой тест стоит добавить.

### 6. NFR-LOGS — формат JSON есть только у API (YELLOW)
- ML-сервис пишет логи uvicorn и `logging` (ml/inspector_ml/ocr_ensemble.py:36) не в JSON. Logstash (inspector.conf) такие строки явно помечает `_inspector_not_json`: без request_id и user_id, уровень угадывается по потоку.
- Мелочь: в `formatLog` поля из `extra` раскладываются после обязательных (audit.ts:24), и `extra` может перезаписать timestamp или level.

### 7. NFR-ROLES — ссылка на строку сообщения, тест на одну пару ролей (YELLOW)
- Code-ref `app.ts::Недостаточно прав` — это текст ответа. Логика в той же строке (app.ts:82): у admin полный доступ, остальные роли идут по списку в `auth(...)`.
- Тест проверяет только «admin может, inspector получает 403» на изменении порога. Отказы для curator, ml_engineer и supervisor привязанным тестом не проверяются, хотя косвенно есть в usability-route и DLG-INSP-17.

### 8. NFR-MTLS — УКЭП вне кода, ошибка конфигурации всплывает поздно (YELLOW)
- Сертификат УКЭП — ГОСТ Р 34.10-2012. OpenSSL в Node его не умеет, поэтому эксплуатационный путь — `gost-proxy`, то есть внешний шлюз СКЗИ, которого нет в репозитории и в compose (rin-tls.ts:3–11). Режим `direct` — это mTLS на обычных RSA/EC-сертификатах.
- Транспорт строится лениво при первой отправке (rin.ts:22). В gpu неверный `INSPECTOR_RIN_TLS` не валит старт, а всплывает ошибкой в sync_jobs.

### 9. NFR-VERIFY-30 — есть инструмент замера, результата нет (YELLOW)
- Код и тесты проверяют арифметику замера и отчёт. Утверждение НФТ («≤ 30 мин у опытного инспектора, 5 участников») не подтверждено: протокол юзабилити-теста (docs/qa/usability-test-protocol.md §9) — пустая форма.

### 10. DLG-INSP-07 — тест не проверяет решение по гипотезе (YELLOW)
- Название обещает «решение по гипотезе». Assert только на `SUSPICION — не нарушение и не входит в GOLD…`, а это статический подзаголовок панели (Inspection.tsx:234), он виден и при пустом списке («Гипотез нет»).
- Нужно: гипотеза есть в списке, по ней выполнено действие, и статус сменился.

### 11. DLG-INSP-13 — «действия с IP» без проверки IP (YELLOW, мелко)
- Тест проверяет `#a-action` и строку LOGIN_FAILED. Колонку IP (Audit.tsx:24, 33) не проверяет.

### 12. DO-COMPLETENESS — неточная code-ref (YELLOW, мелко)
- В data.table указано `inspections.scenario`, а code-ref ведёт на `load_codes_json text`. Обе колонки есть в db.ts:16 и пишутся вместе (inspections.ts:237). Нужно выровнять ссылку с table или добавить вторую.

### Системные замечания (вердикты не снижают)
- **UI-тесты диалогов не входят в гейт CI.** `test:ui` есть в package.json, но в .github/workflows его нет. Тесты `dialogs.test.mjs` связаны по состоянию: DLG-INSP-11 работает под входом из DLG-10, DLG-17 опирается на отклонение и уточнение из теста OS-INSP-4.1.5, DLG-13 — на LOGIN_FAILED из DLG-01. Одиночный прогон через `--test-name-pattern` упадёт.
- **Test-ref — префиксы, а не точные названия** (22 ссылки в области). `gera-trace.mjs:68` сверяет через `includes`, поэтому ссылку можно «попасть» и в комментарий, и в любую строку файла.
- **Модель данных неполна.** В db.ts есть таблицы без DO и без строки в 04-data.md: `approved_changes` (изменения проекта), `requisites` (OS-INSP-2.3), `hidden_works`, `rooms`, `notifications`, `users`, `sessions`, `meta`. ER-диаграмма в 04-data.md охватывает 11 из 26 объектов. `dataset_items` пишется, но API нигде его не читает.
- **Маршрутизация логов.** LOGIN_FAILED пишется в audit_log прямым SQL (app.ts:105), в обход `audit()`, поэтому строки `audit LOGIN_FAILED` в логе нет. Регулярка в inspector.conf на неё мертва. В безопасность событие всё равно попадает — через строку `POST … 401` и `security: true`.
