# Сверка ТЗ §10 «Таблицы базы данных (сводка)» со схемой, ER-моделью и кодом

Ветка: `origin/integ/t233-gpu-stand` @ `04854113`. Режим — только чтение (git show / grep).

## Источники

| Что | Где |
|---|---|
| Текст ТЗ §10 (16 таблиц, ключевые поля) | `data/seed/tz-fulltext.json`, стр. 26–27, блоки 291–308. В `tz-passages.json` есть только заголовок `TZ-10`, без полей |
| Разметка областей, заметки о дефектах ТЗ | `docs/tz/regions/S10.yaml` |
| Атомы | `docs/tz/tz-decomposition.yaml:468–483` (TZA-10-01…16) |
| ER-модель документа | `docs/architecture/C4-и-модель-БД.md` §5, стр. 310–718 |
| Схема БД | `apps/api/src/db/migrations/0001…0014` |
| Модель ГЕРЫ | `docs/gera/inspector/04-data.md`, `model.yaml` → `data:` (стр. 2064+). Там только таблицы, без полей |
| Процессы | `apps/api/src/{app.ts,db.ts,services,domain}`, `apps/web/src` |

В `ml/` и `scripts/` к таблицам §10 никто не обращается: ML-сервис базу не трогает. Нашлось одно исключение: `scripts/bench-11-stand.mjs:49` считает строки `checks`.

## Как читать таблицы по полям

- **ER** — поле показано в mermaid-диаграмме документа (с номером строки сущности).
- **Схема** — колонка есть с учётом всех миграций. Среди них ALTER из 0002 (`sessions.token → token_hash`), 0004, 0005, 0006, 0013 и 0014. Переименований полей из §10 нет.
- **Пишется / читается** — `файл:строка`. «Только select \*» значит, что поле уходит в API сырым `select *`, но его не использует ни логика, ни отчёт, ни интерфейс.
- **Мёртвое** — колонка есть, но её никто не заполняет или никто не использует.

---

## 1. Params → `params` (0001_init.sql:54–60)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id | да (442) | `id` integer PK | сид `db.ts:188` | всюду |
| code | да | `code` UK | сид `db.ts:188` | ключ join `checks.param_code` |
| parameter_name | да | да | сид | протокол, UI Matrix/Verify |
| source_pd | **нет** | да | сид `db.ts:192` | `domain/compare.ts:22`, `domain/discipline-fit.ts:55`, UI ParamPassport |
| source_rd | **нет** | да | сид | те же |
| source_id | **нет** | да | сид | `compare.ts:22`, `services/export.ts:82` |
| sp_reference | да (580) | да | сид пишет **NULL** (`db.ts:193`, позиция 11); правка — PATCH `app.ts:804` | `services/inspections.ts:95`, UI ParamPassport, Matrix |
| gost_reference | **нет** | да | **сид не пишет**; только PATCH `app.ts:804` | **только select \*** `app.ts:748`; в UI и экспорте нет |
| fz_reference | **нет** | да | как gost_reference | как gost_reference |

Замечание. В `data/seed/matrix.json` у всех 132 записей нет ключей `sp/gost/fz_reference`. В свежей базе все три ссылки пусты. gost и fz по сути мёртвые. Нормативные ссылки параметров живут в паспортах `data/seed/passports/*.json` и в `norms.json`, а не в этих колонках.

## 2. Checks → `checks` (0001:62–67; +0004 `provenance_json`, +0014 `l8_json`, `approved_change_ref`, `derived_from`)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id | да (452) | да | recompute `inspections.ts:673` | всюду |
| param_id | как `param_code` | **`param_code` text**, логическая ссылка на `params.code`, **без FK** | `inspections.ts:673` | `app.ts:490`, `common-root.ts:10` |
| object_id | **нет** | **нет**: только через `inspection_id → inspections.object_id` | — | join `app.ts:921`, `objects.ts:31` |
| expected_value | **нет** | да | `inspections.ts:673/675` | протокол, UI Verify/Inspection/Sample |
| actual_value | **нет** | да | то же | то же |
| completeness_status | **нет** | **нет** | — | вычисляется на лету из `finding_status ∈ {MISSING_EVIDENCE, NOT_APPLICABLE, NOT_COMPARABLE, CLARIFICATION_REQUIRED}`: `domain/protocol.ts:66,130,160`. Сценарий загрузки — `inspections.scenario` / `load_codes_json` (`domain/completeness.ts`) |
| finding_status | да | да, CHECK `0002:79` | `inspections.ts:673` | протокол, очередь UI |
| review_priority | **нет** | да | `inspections.ts:673` | `inspections.ts:135`, UI `lib/queue.ts` |
| evidence_group_id | да | да | `inspections.ts:673`, `sheetdiff.ts:44`, `advisor.ts:109` | `domain/protocol.ts:72`, `gold.ts` |

Уже зафиксировано в аудите трассы как Д-044 (`docs/audit/2026-09-28-детальная-трасса-находки.yaml:638`). Атом TZA-10-02 помечен `partial`, миграция отложена в T-170 (`tasks/00-backlog/T-170-…`).

## 3. Objects → `objects` (0001:18–20)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, name, address | да (332–335) | да | `inspections.ts:145` createInspection, из карточки «РиН» `rin-contract.ts:110` | `app.ts:528`, `export.ts:79` |
| customer | **нет** | да (ПДн, `domain/pdn.ts:62`) | `inspections.ts:145` | `app.ts:528` с маской `maskCounterparty`, Приложение 2 `domain/appendix2.ts:109`, UI Inspection |
| contractor | **нет** | да (ПДн) | то же | `appendix2.ts:110` |
| permit_number | да | да | то же | `appendix2.ts:108`, `domain/protocol.ts:56` |

Мёртвых полей нет.

## 4. Files → `files` (0001:29–38; +0005 `ml_revision`, +0013 `intake_source`)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, object_id | да (349–352) | да | `inspections.ts:292` | всюду |
| doc_stage | да | да, CHECK PD/RD/ID `0002:94` | `inspections.ts:292` | recompute |
| discipline | **нет** | да | `inspections.ts:296` | `inspections.ts:636,691,708` (выбор источника) |
| document_code, revision | да | да | `inspections.ts:292` | протокол, фрагменты |
| approval_status | **нет** | да | `inspections.ts:297` | фрагменты (`stage-schedule.ts:297`), UI `Inspection.tsx:257` |
| approval_date | **нет** | да (text) | `inspections.ts:297` | только показ: `app.ts:529`, UI `Inspection.tsx:257` |
| predecessor_id | **нет** | да | `inspections.ts:297` | `domain/revisions.ts:78`, `domain/sheetdiff.ts:148` |
| file_hash | как `sha256` | **`sha256`** | `inspections.ts:292` | дедупликация `:286`, `integrity.ts:44`, blob |
| file_path | **нет** | **нет** | — | файл адресуется по `sha256`: S3 `blobs/<sha256>` + кэш-том (ADR-0006, `services/blobstore.ts`, DO-BLOB) |
| uploaded_at | **нет** | да | `inspections.ts:292` | сортировка `:347`, инкремент `:640`, `objects.ts:144` |

## 5. Protocols → `protocols` (0001:101–105; неизменяемость финала — `0002:46`)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, version, status | да (494–498) | да, CHECK DRAFT/FINALIZED `0002:113` | `snapshotProtocol` `inspections.ts:967–975` | `app.ts:414,460,539`, `rin.ts:90` |
| object_id | **нет** | **нет**: `inspection_id → inspections.object_id` | — | объект лежит внутри `body_json` |
| matrix_version, dataset_version | **нет** | да | `inspections.ts:970` | `app.ts:460`, UI Inspection |
| model_version | да | да | то же | то же |
| input_manifest_hash | **нет** | да | то же | `app.ts:460`, `domain/ai-usage.ts:98`, `cli/output-set.ts:99` |
| created_at, finalized_at | **нет** | да | то же; при FINALIZED `finalized_at = now()` | `app.ts:460`, `inspections.ts:640` |

## 6. Rejection_Log → `rejection_log` (0001:152–155; только добавление — `0002:18`)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id | да (510) | да | `decideIn` `inspections.ts:1015` | `app.ts:680`, `app.ts:966` |
| violation_id | как `check_id` | **`check_id`**, без FK | то же | то же; UI `components/FeedbackLogs.tsx` |
| rejection_reason | как `reason_code` | **`reason_code` + `comment`** | то же | то же |
| ai_verdict | да | да (= `finding_status`, `domain/feedback-logs.ts:52`) | то же | то же |
| suggested_fix | **нет** | да | то же | то же |
| retraining_status | **нет** | **нет** | — | — |

Главное: журнал в дообучении не участвует. Отчёт по дообучению строится по `decisions` (`services/report.ts:25–30`), GOLD-набор — по `decisions` через `goldCandidates` (`app.ts:919`). `rejection_log` только показывается ML-инженеру. Статус «отработано дообучением» хранить негде, а триггер «только добавление» не даёт обновить строку.

## 7. Dispute_Log → `dispute_log` (0001:158–160; только добавление — `0002:20`)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id | да (517) | да | `inspections.ts:1018` | `app.ts:681,967`, UI FeedbackLogs |
| violation_id | как `check_id` | **`check_id`**, без FK | то же | то же |
| inspector_comment | да | да | то же | то же |
| ai_comment | **нет** | да | то же | то же |
| resolution_status | **нет** | **нет** | — | — |
| resolved_by | **нет** | **нет** | — | — |

Разрешить спор нельзя: полей нет, UPDATE запрещён триггером. Косвенно исход виден по следующему решению в `decisions` по тому же `check_id`, но явной связи нет (Д-046).

## 8. Suspicions → `suspicions` (0001:83–89)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, discovery_method, confidence, inspector_status | да (478–483) | да; CHECK `0002:91,117` | `writeSuspicions` `inspections.ts:885`, `:803–823`, `advisor.ts:63`; статус — `app.ts:733`, `advisor.ts:107` | `app.ts:538`, `export.ts:86`, UI `Inspection.tsx:320` |
| object_id | **нет** | да | `inspections.ts:888` | попадает в тело протокола (`inspections.ts:946` select \* → `domain/protocol.ts:164`) |
| description | **нет** | да | то же | `export.ts:86`, `norms.ts:80` (подбор нормы), UI |

Мёртвых полей нет.

## 9. Logical_Rules → `logical_rules` (0001:91–94)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, rule_name | да (598–600) | да | сид `db.ts:203`, POST `app.ts:866`, PATCH `app.ts:880` | `inspections.ts:101` → `domain/suspicions.ts` |
| condition | как `condition_json` | **`condition_json`** json | то же | `inspections.ts:104` |
| expected | как `expected_json` | **`expected_json`** json | то же | `inspections.ts:105` |
| normative_base | **нет** | да | то же | `domain/suspicions.ts:89`, UI Normative |
| is_active | **нет** | да | PATCH `app.ts:880` | `domain/suspicions.ts:77` |

## 10. Normative_Base → `normative_base` (0001:96–99)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, document_number, min_value, max_value | да (583–589) | да | сид `db.ts:210` (3 записи), POST `app.ts:836`, PATCH `app.ts:850` | `normative()` `domain/suspicions.ts:132–150` |
| document_name, section, parameter_name | **нет** | да | то же | `norms.ts:62` → ML `/norms/search`; section — `suspicions.ts:147`; UI Normative |
| effective_from, effective_to | **нет** | да | POST/PATCH; сид пишет только from | **только UI Normative.tsx**. Расчёт `normative()` даты действия **не проверяет** |

Второй источник истины. Нормы с датами действия, которые реально применяются при сравнении (`resolveNorm`, `domain/geom-ops.ts:76–84`, OS-INSP-3.1.112), читаются из `data/seed/norms.json → base[]` (`domain/kinds/geometry.ts:61–72`), а не из таблицы. Правка нормы через UI или API на расчёт параметров по паспортам не влияет.

## 11. ML_Retraining_Log → отдельной таблицы **нет**, слита в `model_versions` (0001:172–178, комментарий «OS-INSP-6.4.5: реестр итераций дообучения»)

| Поле ТЗ | ER | Где у нас | Пишется | Читается |
|---|---|---|---|---|
| id | да (688) | `model_versions.id` | — | — |
| model_version, dataset_version | да | колонки | `retrain.ts:115`, `app.ts:979` | UI `Ml.tsx:212` |
| split_hashes | **нет** у model_versions (есть у `dataset_versions`, 677) | `model_versions.split_hashes_json` | только `trainIteration` `retrain.ts:119`; ручная регистрация POST `app.ts:979` не пишет | **только select \*** `app.ts:972`. Сверка состава идёт по `dataset_versions.split_hashes_json` (`retrain.ts:66–75`) |
| precision, recall, f1, false_positive_rate | через `metrics_json` | **ключи внутри `metrics_json`** (json) | `retrain.ts:118`, `app.ts:980` | ворота `publicationGate` (`app.ts:977`, `retrain.ts:109`), UI `Ml.tsx:208–214` |
| per_category_metrics | **нет** | `per_category_metrics_json` (обучение) или `metrics_json.recall_by_category` (ручная регистрация) | `retrain.ts:120` | **только select \*** |
| approval_status | да | да, CHECK `0002:109` | `retrain.ts:115`, `app.ts:979`, `app.ts:1018` | UI `Ml.tsx:224` |
| approved_by | **нет** | да | `app.ts:1018` | **только select \***, в UI нет |

Ещё три пробела:
- Отказ в обучении до регистрации попадает только в `audit_log` (`MODEL_TRAINING_REFUSED`, `retrain.ts:101`).
- Итерации ML-верификатора извлечения ведутся в файле `ml/artifacts/extract-verifier/registry.json` (`ml/inspector_ml/verifier_registry.py`), мимо БД. Это второй реестр моделей.
- Слияние ML_Retraining_Log с Model_Versions не описано ни в ER-документе, ни в `04-data.md`.

## 12. Audit_Log → `audit_log` (0001:117–121; только добавление + обезличивание — 0009, 0012)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, user_id, action, object_id, timestamp, ip_address | да (645–651) | да | `services/audit.ts:9`, `app.ts:222`, `ids.ts:103,121`, `integrity.ts:75` (без ip и ua) | `app.ts:545,895`, UI `Audit.tsx:33`, `pdn.ts:74–75`, `usability.ts:29` |
| details | **нет** | да (text) | то же | UI `Audit.tsx:32` |
| user_agent | **нет** | да | то же | `pdn.ts:76`, обезличивание `pdn_anonymize_audit`; из ответов вырезается (`domain/access.ts:50`) |

## 13. Monitoring_Metrics → `monitoring_metrics` (0001:192–196)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, metric_name, value, timestamp, service_name | да (667–672) | да | `monitoring.ts:53`; хранение 90 дней — удаление `:61` | `monitoring.ts:118,128`, UI Monitoring |
| tags | **нет** | да (json) | `monitoring.ts:53` | `monitoring.ts:118`, UI `Monitoring.tsx:110` |

Заметка S10 (строка 13) с кодом совпадает.

## 14. Evidence_Fragments → `evidence_fragments` (0001:70–74)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, file_id, sheet_page, extracted_value, role_expected_actual | да (462–468) | да | `inspections.ts:678`, `:1057`, `hidden-works.ts:35`, `requisites.ts:37`, `sheetdiff.ts:38`, `advisor.ts:114` | `inspections.ts:900`, `app.ts:703`, `sample-accept.ts:48`, UI Verify/Sample |
| evidence_group_id | **нет** | **нет**: `check_id → checks.evidence_group_id` | — | через join |
| stage | **нет** | да | то же | `retrain.ts:44`, `objects.ts:44`, UI |
| bbox_polygon_norm | **нет** | да (text) | то же | `app.ts:920`, UI Verify/Sample |

## 15. Dataset_Items → `dataset_items` (0001:131–135)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| id, dataset_version, gold_label, split | да (680–685) | да | `app.ts:941–942` | `retrain.ts:69`, `hidden-seal.ts:228` |
| object_group_id | **нет** | да | `app.ts:942` (← `object_id`) | `hidden-seal.ts:228–230` |
| evidence_group_id | **нет** | да | `app.ts:942` | **нигде** |
| expert_id | **нет** | да | `app.ts:942` | **нигде** (фильтр `gold.ts:20` работает до записи, по кандидату) |
| reason_code | **нет** | да | `app.ts:942` | **нигде** |

Маршрута, отдающего элементы набора, нет. Есть только `GET /api/v1/ml/datasets` по `dataset_versions` (`app.ts:950`).

## 16. Model_Versions → `model_versions` (0001:172–178)

| Поле ТЗ | ER | Схема | Пишется | Читается |
|---|---|---|---|---|
| (id — в ТЗ нет) | да | добавлен суррогатный `id` + `model_version` UK | | |
| model_version, dataset_version, metrics_json, approval_status | да (687–693) | да | `app.ts:979`, `retrain.ts:115` | ворота, UI `Ml.tsx` |
| artifact_hash | **нет** | да (в обучении = `weights_hash`) | `app.ts:979`, `retrain.ts:118` | **только select \*** |
| approved_by, deployed_at | **нет** | да | `app.ts:1018` (утверждение) | **только select \*** |
| rollback_to | **нет** | да | `app.ts:1018` | **никто**: операции отката нет, прежняя PUBLISHED не помечается как замещённая |

---

## Сводная таблица

«В схеме» учитывает переименованные поля и поля, лежащие внутри JSON. «Мёртвые» — пишутся (или объявлены), но не используются логикой, отчётом или UI либо пусты по сиду.

| № | Таблица ТЗ | У нас | Полей ТЗ | В схеме | Используются | Отсутствуют | Мёртвые / не применяются | Показано в ER |
|---|---|---|---|---|---|---|---|---|
| 1 | Params | params | 9 | 9 | 7 | 0 | 2 (gost_reference, fz_reference) | 4 |
| 2 | Checks | checks | 9 | 7 | 7 | 2 (object_id, completeness_status) | 0 | 4 |
| 3 | Objects | objects | 6 | 6 | 6 | 0 | 0 | 4 |
| 4 | Files | files | 12 | 11 | 11 | 1 (file_path) | 0 | 6 |
| 5 | Protocols | protocols | 10 | 9 | 9 | 1 (object_id) | 0 | 4 |
| 6 | Rejection_Log | rejection_log | 6 | 5 | 5 | 1 (retraining_status) | 0 | 4 |
| 7 | Dispute_Log | dispute_log | 6 | 4 | 4 | 2 (resolution_status, resolved_by) | 0 | 3 |
| 8 | Suspicions | suspicions | 6 | 6 | 6 | 0 | 0 | 4 |
| 9 | Logical_Rules | logical_rules | 6 | 6 | 6 | 0 | 0 | 4 |
| 10 | Normative_Base | normative_base | 9 | 9 | 7 | 0 | 2 (effective_from/to: только UI, в расчёте нет) | 4 |
| 11 | ML_Retraining_Log | **таблицы нет** → model_versions | 11 | 11 (4 внутри metrics_json) | 8 | 0 | 3 (split_hashes_json, per_category_metrics_json, approved_by) | 8 |
| 12 | Audit_Log | audit_log | 8 | 8 | 8 | 0 | 0 | 6 |
| 13 | Monitoring_Metrics | monitoring_metrics | 6 | 6 | 6 | 0 | 0 | 5 |
| 14 | Evidence_Fragments | evidence_fragments | 8 | 7 | 7 | 1 (evidence_group_id) | 0 | 5 |
| 15 | Dataset_Items | dataset_items | 8 | 8 | 5 | 0 | 3 (evidence_group_id, expert_id, reason_code) | 4 |
| 16 | Model_Versions | model_versions | 8 | 8 | 4 | 0 | 4 (artifact_hash, approved_by, deployed_at, rollback_to) | 4 |
| | **Итого** | 15 таблиц + 1 слита | **128** | **120** | **106** | **8** | **14** | **73** |

Из 120 полей, которые есть в схеме, ER-документ не показывает 47. Этого документ и не обещает: «Показаны ключевые колонки», стр. 314. Но выбор колонок не совпадает с «ключевыми полями» ТЗ.

## Дефекты самого ТЗ из S10.yaml и как мы их закрыли

| Заметка S10 | Как закрыто | Оценка |
|---|---|---|
| `violation_id` ссылается на таблицу «нарушений», которой нет (Rejection_Log, Dispute_Log) | `check_id` ссылается на `checks`: нарушение — это запись `checks` с `verification_status = CONFIRMED_VIOLATION`. FK нет намеренно, журналы переживают пересчёт | Разумно. Но `hidden-works.ts:66` и `requisites.ts:67` делают `delete from checks`, и `check_id` в журналах может остаться висячим |
| Training_Runs (ML_Retraining_Log) пересекается с Model_Versions | Одна таблица `model_versions` с колонками обеих | Закрыто в схеме, **не задокументировано** (ER, `04-data.md`, атом TZA-10-11 — «✅ реализовано» без пояснения) |
| У Model_Versions нет id | Суррогатный `id` + `model_version unique` | Закрыто |
| Назначение Checks усечено («…сопоставления,») | На поля не влияет | — |
| Monitoring_Metrics: хранение 90 дней | `monitoring.ts:53,61` | Закрыто |

## Пробелы по важности

### A. Нарушают требование ТЗ: поля §10 нет или оно не работает

1. **Dispute_Log без `resolution_status` и `resolved_by`**: `0001_init.sql:158–160`, триггер только-добавления `0002_hardening.sql:20`. Спор нельзя разрешить и записать, кто его разрешил. Найдено ранее как Д-046, перенесено в T-170; атом TZA-10-07 не помечен `partial`.
2. **Rejection_Log без `retraining_status`** (`0001:152–155`), и сам журнал в дообучение не попадает. GOLD и отчёт берутся из `decisions` (`app.ts:919`, `services/report.ts:25–30`). Назначение по ТЗ «лог отклонений для дообучения» формально не выполнено. Найдено как Д-045, перенесено в T-170.
3. **Checks: нет `completeness_status` и `object_id`, `param_id` заменён на `param_code` без FK** (`0001:62–67`). Полнота вычисляется из `finding_status` (`domain/protocol.ts:66,130`). Если ТЗ требует столбец, его можно сделать генерируемым или представлением. Найдено как Д-044, перенесено в T-170.
4. **Normative_Base: `effective_from` и `effective_to` в расчёте не участвуют.** `normative()` (`domain/suspicions.ts:132–150`) даты не проверяет. Нормы с датами, которые реально применяются (`geom-ops.ts:84`), читаются из `data/seed/norms.json` (`domain/kinds/geometry.ts:61–72`), не из таблицы. Выходит два справочника, и правки через UI не доходят до паспортного расчёта. **Раньше в находках этого не было.**
5. **ML_Retraining_Log как таблицы нет.** Поля есть в `model_versions`, но:
   - при ручной регистрации (`app.ts:979`) `split_hashes_json` и `per_category_metrics_json` пусты;
   - отказ в обучении есть только в `audit_log`;
   - итерации верификатора — в файле `ml/artifacts/extract-verifier/registry.json`, мимо БД.
6. **Params: `sp_reference`, `gost_reference`, `fz_reference` пусты после сида.** `db.ts:188–193` пишет `sp_reference = null`, а gost и fz не пишет вовсе; в `matrix.json` этих ключей нет. gost и fz не выводятся ни в UI, ни в экспорт.

### B. Данные пишутся, но никем не используются

7. `model_versions.rollback_to`, `deployed_at`, `approved_by`, `artifact_hash` (`app.ts:1018`, `:979`) отдаются только сырым select \* из `app.ts:972`. Операции отката нет, прежняя опубликованная модель не помечается как замещённая, UI (`Ml.tsx:208–230`) эти поля не показывает.
8. `dataset_items.evidence_group_id`, `expert_id`, `reason_code` (`app.ts:942`): только запись, чтения нет нигде.

### C. Отклонения по дизайну: объяснимы, но не задокументированы

9. `files.file_path` отсутствует: файл адресуется по `sha256` (ADR-0006, `blobstore.ts`).
10. `protocols.object_id`, `checks.object_id`, `evidence_fragments.evidence_group_id` получаются через join по `inspection_id` / `check_id`. Это нормализация.
11. `condition` / `expected` хранятся как `*_json`, `rejection_reason` — как `reason_code` + `comment`, метрики — внутри `metrics_json`.

### D. Косметика: документация и тесты

12. `docs/architecture/C4-и-модель-БД.md` §5:
    - не показаны 47 полей ТЗ, которые есть в схеме, среди них `checks.expected_value/actual_value/review_priority`, `files.approval_status/predecessor_id/uploaded_at`, `protocols.matrix_version/dataset_version/input_manifest_hash`, `normative_base.effective_from/to`, `model_versions.approved_by/deployed_at/rollback_to`;
    - нет таблицы соответствия «имя в ТЗ → таблица у нас»;
    - не сказано про слияние ML_Retraining_Log → model_versions.
13. `docs/gera/inspector/04-data.md` и `model.yaml` → `data:` работают на уровне таблиц, полей нет. Двух ТЗ-сущностей там не хватает:
    - ML_Retraining_Log не упомянут вовсе;
    - у DO-METRIC `new_in: []`, у DO-RETRAIN-REPORT `used_by: []`.
14. Приёмка атомов TZA-10-01, 03–05, 08–16 сформулирована как «Таблица X», и перечни полей ничем не проверяются. Это находка аудита S10-03…19. `apps/api/tests/db.test.ts:25` проверяет только наличие таблиц, причём без `checks` и `objects`.
