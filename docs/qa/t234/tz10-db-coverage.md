---
id: QA-T234-TZ10-COVERAGE
title: "ТЗ §10: поле → колонка → где пишется → где читается → тест (128/128, мёртвых 0)"
type: qa-report
owner: almazrobots
date: 2026-09-28
task: T-234
status: draft
traces_to: [TZ-10, NFR-DB, ADR-0011, T-233]
---

# ТЗ §10 «Таблицы базы данных (сводка)»: покрытие схемой и процессами

Ветка `feat/t234-db-model-tz10` от `integ/t233-gpu-stand`. Исходная сверка — [`docs/qa/t233/tz10-db-audit.md`](../t233/tz10-db-audit.md)
(128 полей ТЗ: в схеме 120, используются 106, 14 мёртвых, 6 нарушений). ER-модель по полям —
[`docs/architecture/C4-и-модель-БД.md`](../../architecture/C4-и-модель-БД.md) §5.

## Итог

| | До (T-233) | После (T-234) |
|---|---|---|
| Полей ТЗ в схеме | 120 / 128 | **128 / 128** |
| Полей, которые читает процесс (логика, API, протокол, интерфейс) | 106 | **128** |
| Мёртвых (пишется, но никто не читает, или пусто по сиду) | 14 | **0** |
| Нарушений ТЗ из сверки (раздел A) | 6 | **0** (п. 5 — решением ADR-0011, на согласовании) |

Проверка схемы — `apps/api/tests/tz10-model-route.test.ts` «каждое из 128 полей 16 таблиц ТЗ — колонка схемы (таблица
или представление ML_Retraining_Log)»: список полей — `apps/api/tests/fixtures/tz10-fields.ts`, сверка с
`information_schema.columns` на PostgreSQL. Ниже тест «схема» — этот тест; он есть у каждого поля и отдельно не пишется.

Условные обозначения мест: `app.ts` — `apps/api/src/app.ts`; `insp` — `services/inspections.ts`; `0015` — миграция
`0015_t234_tz10_data_model.sql`; UI — `apps/web/src`; тесты — `apps/api/tests/*`. **Жирным** — поле, добавленное или
оживлённое в T-234.

## 1. Params → `params` (9)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | сид `db.ts seed` | `checks.param_id` (FK), дашборд `app.ts` агрегат, `insp checkRows` | db.test «Матрица переносится полями» |
| code | `code` UK | сид | ключ паспорта, `checks.param_code`, маршруты `/params/:code` | db.test |
| parameter_name | `parameter_name` | сид | протокол, UI Matrix/Verify, `syncNormBase` (имя нормы) | e2e «карточка кандидата» |
| source_pd | `source_pd` | сид | `domain/compare.ts`, `discipline-fit.ts`, UI ParamPassport | domain-discipline-fit |
| source_rd | `source_rd` | сид | те же | domain-discipline-fit |
| source_id | `source_id` | сид | `compare.ts`, `services/export.ts` | domain-discipline-fit |
| **sp_reference** | `sp_reference` | **`db.ts seedParamRefs`** (Матрица, паспорт, справочник норм), PATCH `/params/:code` | паспорт `GET /params/:code/passport` → UI ParamPassport «Своды правил (СП)», Matrix | domain-tz10-model «упоминания раскладываются», tz10-model-route «ссылки заполнены из Матрицы…» |
| **gost_reference** | `gost_reference` | **`seedParamRefs`**, PATCH | паспорт → UI ParamPassport «ГОСТ»; Matrix сохраняет при правке | те же |
| **fz_reference** | `fz_reference` | **`seedParamRefs`**, PATCH | паспорт → UI ParamPassport «Федеральные законы» | те же |

Заполнено на свежей базе: sp > 30, gost > 5, fz > 5 параметров (тест). У остальных параметров документов этого вида в
источниках нет — ячейка пуста, паспорт пишет «не применяются».

## 2. Checks → `checks` (9)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | пересчёт `insp recompute`, `sheetdiff`, `advisor`, `hidden-works`, `requisites` | всюду | e2e |
| **param_id** | `param_id` FK → params | **триггер `checks_fill_refs` (0015)** из `params.code` | `insp checkRows` (join), дашборд `app.ts`, карточки дообучения `services/retrain.ts CARD_SQL` | tz10-model-route «ссылки проверки, фрагмента и протокола…» |
| **object_id** | `object_id` FK → objects | **триггер `checks_fill_refs`** из `inspections.object_id` | GOLD `app.ts goldCandidates`, реестр объектов `services/objects.ts keyRows` | tz10-model-route «ссылки…», «выпуск набора…» (object_group_id) |
| expected_value | `expected_value` | пересчёт | протокол, UI Verify/Inspection | e2e «карточка кандидата» |
| actual_value | `actual_value` | пересчёт | протокол, UI | e2e |
| **completeness_status** | `completeness_status` генерируемая (0015) | **база из `finding_status`** (правило `domain/protocol.ts completenessStatus`) | протокол, раздел «комплектность» `domain/protocol.ts completenessOf`; API карточки проверки | domain-tz10-model «статус комплектности…», «раздел комплектности протокола читает колонку…»; tz10-model-route «генерируемые колонки…» |
| finding_status | `finding_status` | пересчёт | протокол, очередь UI | e2e |
| review_priority | `review_priority` | пересчёт | `insp` очередь, UI `lib/queue.ts` | e2e |
| evidence_group_id | `evidence_group_id` | пересчёт, `sheetdiff`, `advisor` | протокол, GOLD, фрагменты (триггер) | e2e, tz10-model-route |

## 3. Objects → `objects` (6)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `insp createInspection`, «РиН» `rin-contract.ts` | всюду | objects-route |
| name | `name` | то же | реестр объектов, протокол, экспорт | objects-route |
| address | `address` | то же | то же | objects-route |
| customer | `customer` (ПДн) | то же | карточка проверки с маской `maskCounterparty`, Приложение 2 | domain-appendix2, domain-pdn |
| contractor | `contractor` (ПДн) | то же | Приложение 2 | domain-appendix2 |
| permit_number | `permit_number` | то же | протокол, Приложение 2 | domain-appendix2 |

## 4. Files → `files` (12)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `insp ingest` | всюду | e2e |
| object_id | `object_id` | `insp ingest` | реестр объектов `services/objects.ts` | objects-route |
| doc_stage | `doc_stage` | `insp ingest` | пересчёт | e2e |
| discipline | `discipline` | `insp ingest` | выбор источника пересчёта | domain-discipline-fit |
| document_code | `document_code` | `insp ingest` | протокол, фрагменты | e2e |
| revision | `revision` | `insp ingest` | протокол, `domain/revisions.ts` | e2e |
| approval_status | `approval_status` | `insp ingest` | фрагменты, UI Inspection | e2e |
| approval_date | `approval_date` | `insp ingest` | карточка проверки, UI Inspection | e2e «OBJ-SCH-8» |
| predecessor_id | `predecessor_id` | `insp ingest` | `domain/revisions.ts`, `sheetdiff.ts` | domain-revisions (domain.test) |
| file_hash | `sha256` | `insp ingest` | дедупликация, хранилище | e2e «файл под занятым file_id…» |
| **file_path** | `file_path` генерируемая `blobs/<sha256>` (0015) | **база из `sha256`** (правило `domain/blob-crypto.ts blobFilePath`) | проверка целостности хранилища `services/integrity.ts` (обход по пути), карточка проверки → UI Inspection (подсказка хеша) | domain-tz10-model «путь файла в хранилище…», tz10-model-route «генерируемые колонки…», e2e «целостность хранилища…» |
| uploaded_at | `uploaded_at` | `insp ingest` | инкремент пересчёта, порядок | e2e «OBJ-POL-115» |

## 5. Protocols → `protocols` (10)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `insp snapshotProtocol` | история версий | e2e |
| **object_id** | `object_id` FK → objects | **триггер `protocols_fill_object` (0015)**; прежние строки — заполнением в 0015 | карточка объекта `services/objects.ts objectCard` → UI Objects «Протоколы объекта» | tz10-model-route «карточка объекта: версии протоколов…», «ссылки…» |
| version | `version` | снимок | `/protocol?version=`, «РиН» | e2e |
| matrix_version | `matrix_version` | снимок | `/protocols`, карточка объекта | e2e |
| dataset_version | `dataset_version` | снимок | `/protocols` | e2e |
| model_version | `model_version` | снимок | `/protocols`, карточка объекта | e2e |
| input_manifest_hash | `input_manifest_hash` | снимок | `domain/ai-usage.ts`, выгрузка | domain-ai-usage |
| status | `status` | снимок, финализация | «РиН», UI | e2e «финализация…» |
| created_at | `created_at` | снимок | инкремент пересчёта, карточка объекта | e2e |
| finalized_at | `finalized_at` | финализация | `/protocols`, карточка объекта | e2e |

## 6. Rejection_Log → `rejection_log` (6)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `insp decideIn` | журналы `/feedback-logs`, выпуск GOLD | tz10-model-route |
| violation_id | `check_id` | `insp decideIn` | GOLD `goldCandidates` (lateral), журналы, UI FeedbackLogs | tz10-model-route «выпуск набора…» |
| rejection_reason | `reason_code` + `comment` | `insp decideIn` | **отчёт по дообучению `services/report.ts`**, **причина отрицательной метки GOLD**, UI | tz10-model-route «отчёт по дообучению строится по журналу…», decision-integrity-route |
| ai_verdict | `ai_verdict` | `insp decideIn` | журналы, UI | domain-feedback-logs |
| suggested_fix | `suggested_fix` | `insp decideIn` | журналы, UI «Что исправить в модели» | domain-feedback-logs |
| **retraining_status** | `retraining_status` (0015) + `retraining_dataset`, `retraining_at` | **выпуск GOLD `app.ts` (INCLUDED), триггер `decisions_supersede_rejections` (SUPERSEDED)** | GOLD (снятые не берутся), отчёт по дообучению (снятые не считаются + сводка), журналы → UI FeedbackLogs «Дообучение» | domain-tz10-model «выпуск набора…», tz10-model-route «журнал только дописывается…», «снятие решения-отклонения…», «выпуск набора…» |

## 7. Dispute_Log → `dispute_log` (6)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `insp decideIn` | `POST /disputes/:id/resolve`, журналы | tz10-model-route «закрытие спора…» |
| violation_id | `check_id` | `insp decideIn` | журналы, аудит DISPUTE_RESOLVED | tz10-model-route |
| inspector_comment | `inspector_comment` | `insp decideIn` | журналы, UI | domain-feedback-logs |
| ai_comment | `ai_comment` | `insp decideIn` | журналы, UI | domain-feedback-logs |
| **resolution_status** | `resolution_status` (0015) | **`POST /api/v1/disputes/:id/resolve`** (`domain/feedback-logs.ts canResolveDispute`, охрана `dispute_log_guard`) | журналы → UI FeedbackLogs «Исход» (форма закрытия у надзора) | domain-tz10-model «закрыть можно только открытый спор…», tz10-model-route «закрытие спора…» |
| **resolved_by** | `resolved_by` FK → users (0015) + `resolved_at`, `resolution_comment` | **то же** | журналы (имя — ролям проверок), UI «кто закрыл» | tz10-model-route «закрытие спора…» |

## 8. Suspicions → `suspicions` (6)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `insp writeSuspicions`, `advisor.ts` | `/suspicions/:id/*` | advisor.test |
| object_id | `object_id` | `insp writeSuspicions` | тело протокола | e2e «OBJ-POL-115» |
| discovery_method | `discovery_method` | то же | экспорт, UI | domain.test (гипотезы) |
| confidence | `confidence` | то же | экспорт, UI, дедупликация | domain.test |
| description | `description` | то же | экспорт, подбор нормы `services/norms.ts`, UI | domain.test |
| inspector_status | `inspector_status` | `POST /suspicions/:id/status`, `advisor.ts` | карточка проверки, UI | advisor.test |

## 9. Logical_Rules → `logical_rules` (6)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | сид, POST/PATCH `/rules` | `insp logicalRules` | e2e «нормативы и логические правила…» |
| rule_name | `rule_name` | то же | `domain/suspicions.ts logical`, UI | e2e |
| condition | `condition_json` | то же | `logical` | e2e, domain.test |
| expected | `expected_json` | то же | `logical` | domain.test |
| normative_base | `normative_base` | то же | гипотеза, UI Normative | domain.test |
| is_active | `is_active` | PATCH `/rules/:id` | `logical` | e2e |

## 10. Normative_Base → `normative_base` (9)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | сид, **`db.ts syncNormBase`** (записи CMP-06), POST/PATCH `/normative` | **пересчёт `insp loadNormBase`**, `writeSuspicions` | tz10-model-route «нормы CMP-06 сида…» |
| document_name | `document_name` | то же | ML `/norms/search`, UI | tz10-model-route |
| document_number | `document_number` | то же | **предел CMP-06 (`normRecordFromRow` → `resolveNorm`)**, гипотеза | domain-tz10-model «строка таблицы → запись оценщика…» |
| section | `section` | то же | **пункт в эталоне CMP-06**, гипотеза | domain-tz10-model |
| parameter_name | `parameter_name` | то же | ML `/norms/search`, UI | domain-tz10-model «запись сида norms.json → строка…» |
| min_value | `min_value` | то же, **правка в UI Normative → PATCH** | **предел CMP-06**, нормативный анализ гипотез | tz10-model-route «правка нормы администратором доходит до расчёта…» |
| max_value | `max_value` | то же | то же | domain-tz10-model |
| **effective_from** | `effective_from` | сид, POST, **PATCH** | **`resolveNorm` (CMP-06), `normative()` гипотез**, UI | domain-tz10-model «срок действия нормы…», «нормативный анализ гипотез: норма вне срока…», tz10-model-route «…учитывает срок действия нормы» |
| **effective_to** | `effective_to` | POST, PATCH, UI «Деактивировать» | то же | те же |

Один источник: `data/seed/norms.json → base[]` только наполняет таблицу новыми `norm_key`; пересчёт и нормативный анализ
читают таблицу. Правка нормы (`PATCH /api/v1/normative/:id`) сразу пересчитывает зависящие параметры открытых проверок
(`insp recomputeAfterNormChange`).

## 11. ML_Retraining_Log → представление `ml_retraining_log` над `model_versions` (11, ADR-0011)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `ml_retraining_log.id` ← `model_versions.id` | регистрация `POST /ml/models`, обучение `services/retrain.ts` | `GET /api/v1/ml/retraining-log` → UI Ml «Журнал дообучения» | tz10-model-route «регистрация модели пишет журнал дообучения…» |
| model_version | `model_version` | то же | то же, публикация, откат | tz10-model-route |
| dataset_version | `dataset_version` | то же | то же, **сверка хешей при публикации** | tz10-model-route «публикация: хеши выборок…» |
| **split_hashes** | ← `split_hashes_json` | обучение; **ручная регистрация — из `dataset_versions` (T-234)**; прежние строки — 0015 | **публикация: `domain/model-registry.ts splitHashesMatch` (409 при расхождении)**, журнал → UI | domain-tz10-model «хеши выборок модели сверяются…», tz10-model-route «публикация…» |
| precision | ← `metrics_json.precision` | регистрация, обучение | ворота `publicationGate`, журнал → UI | tz10-model-route «регистрация…», domain.test (ворота) |
| recall | ← `metrics_json.recall` | то же | то же | то же |
| f1 | ← `metrics_json.f1` | то же | то же | то же |
| false_positive_rate | ← `metrics_json.false_positive_rate` | то же | ворота (рост FPR), журнал | то же |
| **per_category_metrics** | ← `per_category_metrics_json` | обучение; **ручная регистрация — из `recall_by_category`**; прежние строки — 0015 | **ворота 6.3.1: Recall категорий предыдущей модели — `gatePrevious`**, журнал → UI | domain-tz10-model «метрики по категориям при ручной регистрации…», tz10-model-route «публикация…» (КР −1 п.п.) |
| approval_status | ← `approval_status` | регистрация, публикация, откат | журнал, UI | tz10-model-route |
| **approved_by** | ← `approved_by` | публикация `/approve` | **журнал дообучения, реестр → UI «подписал»**, аудит отката | tz10-model-route «публикация…» (approved_by_name) |

## 12. Audit_Log → `audit_log` (8)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `services/audit.ts audit` | `/audit`, карточка проверки | e2e |
| user_id | `user_id` | то же | `/audit` фильтр, ПДн субъекта | pdn-route |
| action | `action` | то же | `/audit` фильтр, `usability.ts` | e2e |
| object_id | `object_id` | то же | карточка проверки (индекс) | e2e |
| details | `details` | то же | UI Audit | e2e |
| timestamp | `timestamp` | то же | порядок, обезличивание 90 дней | domain-pdn |
| ip_address | `ip_address` | то же | `/audit` с маской `maskIp`, ПДн | domain-pdn, access-matrix-route |
| user_agent | `user_agent` | то же | ПДн субъекта, обезличивание | domain-pdn |

## 13. Monitoring_Metrics → `monitoring_metrics` (6)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | `services/monitoring.ts` сэмплер | порядок ряда | monitoring-route |
| metric_name | `metric_name` | то же | `/monitoring/metrics`, каталог | monitoring-route |
| value | `value` | то же | ряд, UI Monitoring | monitoring-route |
| timestamp | `timestamp` | то же | ряд, хранение 90 дней | domain-monitoring |
| service_name | `service_name` | то же | каталог | monitoring-route |
| tags | `tags` | то же | ряд, UI Monitoring | monitoring-route |

## 14. Evidence_Fragments → `evidence_fragments` (8)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | пересчёт, `hidden-works`, `requisites`, `sheetdiff`, `advisor` | разделение кандидата, `/fragments` | e2e |
| **evidence_group_id** | `evidence_group_id` (0015) | **триггер `fragments_fill_group`, синхронизация `checks_sync_group`** | **элементы набора `GET /ml/datasets/:v/items` (фрагменты группы с координатами)** | tz10-model-route «ссылки…», «элементы версии набора…» |
| file_id | `file_id` | то же | протокол, UI Verify | e2e |
| stage | `stage` | то же | карточки дообучения, объекты | e2e |
| sheet_page | `sheet_page` | то же | протокол, UI | e2e |
| bbox_polygon_norm | `bbox_polygon_norm` | то же | GOLD (полнота карточки), UI | e2e |
| extracted_value | `extracted_value` | то же | протокол | e2e |
| role_expected_actual | `role_expected_actual` | то же | протокол | e2e |

## 15. Dataset_Items → `dataset_items` (8)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| id | `id` | выпуск GOLD `app.ts` | элементы набора | tz10-model-route |
| **evidence_group_id** | `evidence_group_id` | выпуск GOLD | **годность набора `domain/gold.ts datasetIssues` (группа в одной выборке) — отказ в обучении; элементы набора → UI Ml** | domain-tz10-model «набор годен…», tz10-model-route «дообучение не идёт на наборе…», «элементы версии набора…» |
| gold_label | `gold_label` | выпуск GOLD | обучение `services/retrain.ts datasetCards` | retrain-route |
| **expert_id** | `expert_id` | выпуск GOLD (из журнала отклонений / решения) | **годность набора (метка без эксперта — отказ), сводка «экспертов», UI** | domain-tz10-model, tz10-model-route «элементы версии набора…» |
| **reason_code** | `reason_code` | выпуск GOLD (**из журнала отклонений**) | **сводка причин отрицательных меток `datasetSummary`, UI** | domain-tz10-model «сводка версии…», tz10-model-route «выпуск набора…» |
| dataset_version | `dataset_version` FK | выпуск GOLD | обучение, элементы набора | retrain-route |
| split | `split` | выпуск GOLD | обучение, годность набора | retrain-route, domain-tz10-model |
| object_group_id | `object_group_id` | выпуск GOLD (← `checks.object_id`) | скрытый тест `hidden-seal.ts`, элементы набора | hidden-seal-route |

## 16. Model_Versions → `model_versions` (8)

| Поле ТЗ | Колонка | Пишется | Читается | Тест |
|---|---|---|---|---|
| model_version | `model_version` UK | регистрация, обучение | meta, ворота, публикация, откат | e2e «реестр моделей…» |
| **artifact_hash** | `artifact_hash` | регистрация, обучение (= хеш весов) | **`services/retrain.ts publishedRanking`: веса применяются, только если хеш совпадает (`artifactIntact`)**, UI реестра | domain-tz10-model «целостность весов…», tz10-model-route «действующая модель применяется, только если…» |
| dataset_version | `dataset_version` | регистрация, обучение | сверка хешей при публикации | tz10-model-route |
| metrics_json | `metrics_json` | регистрация, обучение | ворота, UI | domain.test (ворота), e2e |
| approval_status | `approval_status` (+SUPERSEDED, ROLLED_BACK — 0015) | регистрация, публикация, **откат** | действующая модель, ворота, UI | tz10-model-route «публикация…», «откат модели…» |
| **approved_by** | `approved_by` | публикация | **UI реестра «подписал» (имя), журнал дообучения, аудит отката** | tz10-model-route «публикация…» |
| **deployed_at** | `deployed_at` | публикация, **откат (цель — новое время ввода)** | **действующая модель — `activeModel` по последнему вводу в контур (ворота, публикация)**, UI «в контуре с» | domain-tz10-model «действующая модель…», tz10-model-route «откат модели…» |
| **rollback_to** | `rollback_to` | публикация | **откат `POST /api/v1/ml/models/:v/rollback` (`rollbackPlan`)**, UI «Откатить» | domain-tz10-model «откат…», tz10-model-route «откат модели…» |

## Нарушения ТЗ из сверки T-233 и как закрыты

| № | Нарушение | Закрыто |
|---|---|---|
| 1 | Dispute_Log без resolution_status, resolved_by; спор не закрыть | колонки 0015; `POST /api/v1/disputes/:id/resolve` (супервизор, администратор), аудит DISPUTE_RESOLVED, форма в UI FeedbackLogs; охрана журнала — только закрытие один раз (OS-INSP-4.1.29) |
| 2 | Rejection_Log без retraining_status; журнал не в дообучении | колонка 0015; отрицательные метки GOLD — из журнала; выпуск набора ставит INCLUDED, снятие решения — SUPERSEDED (триггер); отчёт по дообучению — по журналу (OS-INSP-4.1.30, 6.1.11, 6.2.3) |
| 3 | Checks без completeness_status, object_id; param_id — param_code без FK | генерируемая колонка и ссылки с FK (0015); протокол, дашборд, реестр объектов, GOLD читают их (OS-INSP-3.3.7) |
| 4 | Normative_Base: даты действия не в расчёте, второй справочник в norms.json | таблица — единственный источник: CMP-06 и гипотезы читают её с датами и активностью; сид — только наполнение; правка в UI → пересчёт (OS-INSP-7.2.3, 7.2.4) |
| 5 | ML_Retraining_Log нет таблицы; при ручной регистрации пусты хеши и метрики по категориям | ADR-0011: представление `ml_retraining_log` над `model_versions`; ручная регистрация пишет хеши и метрики по категориям; поля читают публикация и ворота (OS-INSP-6.4.17). **Решение о слиянии — на согласовании владельца** |
| 6 | Params: sp/gost/fz_reference пусты, не выводятся | наполнение `seedParamRefs` из текста Матрицы, паспортов и справочника норм; паспорт параметра в UI (OS-INSP-7.1.25) |

## Что сознательно не сделано и вынесено владельцу

- **Отдельная таблица ML_Retraining_Log.** Сделано слияние с `model_versions` и представление с полями ТЗ (ADR-0011,
  статус proposed). Если нужна именно таблица — новая миграция с переносом строк; маршруты читают представление и не
  меняются.
- **Колонки ссылок в Матрице редакции 1.1 нет.** В `ТЗ/Матрица_параметров_редакция1.1.xlsx` (лист «МАТРИЦА»: ID, код,
  раздел, параметр, ед., источники ПД/РД/ИД, логика ИИ-связи, приоритет) колонок СП/ГОСТ/ФЗ нет; ссылки собраны из
  текста логики ИИ-связи Матрицы, основания паспорта и справочника норм — допущение OS-INSP-7.1.25.
- **Итерации ML-верификатора извлечения** остаются в файле `ml/artifacts/extract-verifier/registry.json`, мимо БД: ML-сервис
  базу не трогает (ADR-0001), нужен маршрут регистрации из ML — отдельная задача.
- **Отказ в обучении до регистрации** (MODEL_TRAINING_REFUSED) — запись `audit_log`: модели нет, строки реестра нет.
