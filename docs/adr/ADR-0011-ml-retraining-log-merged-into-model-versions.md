---
id: ADR-0011
title: "ML_Retraining_Log ТЗ §10 — представление над model_versions, а не отдельная таблица"
status: proposed
owner: almazrobots
date: 2026-09-28
task: T-234
---

# ADR-0011. Журнал дообучения и реестр моделей — одна таблица

## Контекст

ТЗ §10 называет две таблицы: п. 11 ML_Retraining_Log «аудит обучения и решения о публикации» (id, model_version,
dataset_version, split_hashes, precision, recall, f1, false_positive_rate, per_category_metrics, approval_status,
approved_by) и п. 16 Model_Versions «реестр моделей и допуска в контур» (model_version, artifact_hash, dataset_version,
metrics_json, approval_status, approved_by, deployed_at, rollback_to). Заметка S10 (`docs/tz/regions/S10.yaml`)
отмечает пересечение: у обеих model_version, dataset_version, approval_status и approved_by, запись обеих рождается
одним событием — регистрацией итерации.

С T-100 (OS-INSP-6.4.5) итерация пишется одной строкой `model_versions` (0001: колонки split_hashes_json,
per_category_metrics_json, training_code_hash, trained_by, previous_model, gate_json). Сверка T-233 нашла, что слияние
нигде не описано, а при ручной регистрации (`POST /api/v1/ml/models`) хеши выборок и метрики по категориям пусты.

## Решение

- Одна таблица `model_versions` — источник истины для обоих разделов ТЗ: у итерации один номер, одна запись решения
  о публикации, одна точка отката. Две таблицы означали бы два места для одного approval_status и approved_by и их
  расхождение при публикации и откате.
- `ml_retraining_log` — представление (миграция 0015) с полями п. 11 ТЗ под их именами: precision, recall, f1,
  false_positive_rate — из `metrics_json`, split_hashes и per_category_metrics — из колонок реестра. Читается маршрутом
  `GET /api/v1/ml/retraining-log` и разделом «Модель» интерфейса.
- При ручной регистрации модели API пишет хеши выборок из выпуска набора (`dataset_versions.split_hashes_json`),
  метрики по категориям — из `recall_by_category`, автора, версию Матрицы и предыдущую модель. Миграция 0015
  дозаполняет те же поля у зарегистрированных раньше строк.
- Поля журнала участвуют в процессе, а не только хранятся: хеши выборок сверяются с выпуском набора при публикации
  (иначе 409), Recall по категориям предыдущей модели берут ворота OS-INSP-6.3.1.

## Не входит

- Отказ в обучении до регистрации (MODEL_TRAINING_REFUSED) остаётся записью `audit_log`: модели нет — строки реестра нет.
- Итерации ML-верификатора извлечения ведутся файлом `ml/artifacts/extract-verifier/registry.json`
  (`ml/inspector_ml/verifier_registry.py`). Перенос в `model_versions` — отдельная задача: ML-сервис базу не трогает
  (ADR-0001), нужен маршрут регистрации из ML. Вынесено владельцу.

## Последствия

- ER-модель (`docs/architecture/C4-и-модель-БД.md` §5) показывает ML_Retraining_Log представлением над Model_Versions.
- Отдельная таблица по ТЗ, если её потребует заказчик, — новая миграция с переносом строк и триггером записи из
  `model_versions`; маршруты и интерфейс читают представление и не меняются.
