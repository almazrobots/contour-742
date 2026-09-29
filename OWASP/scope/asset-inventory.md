---
id: OWASP-ASSETS
title: "Опись активов и поверхности атаки"
type: scope
owner: almazrobots
status: current
created: 2026-09-27
task: T-140
commit: 66593fa
refresh: при каждом R2 (новая поверхность) и R3
---

# Опись активов и поверхности атаки

Срез на `main` 66593fa. Пересобирается при каждом полном аудите. Ниже — команды, которыми собран этот срез.

## Что защищаем

| Актив | Ценность | Где живёт | Нарушение |
|---|---|---|---|
| Решения инспектора и журнал аудита | юридическая значимость протокола | PostgreSQL `checks`, `audit_log` (только добавление) | подмена или стирание решения — A08/A09 |
| Документы застройщика (ПД/РД/ИД) | коммерческая тайна, ПДн в реквизитах | блобы: диск или S3 с AES-256-GCM (ADR-0006) | утечка, подмена |
| Протокол проверки (PDF/DOCX) | официальный документ | рендер ML `/render/{fmt}`, выгрузка API | инъекция разметки (T088-H6) |
| Учётки, пароли (scrypt), токены сессий (sha256) | доступ | PostgreSQL | захват сессии, перебор |
| Ключ шифрования блобов | конфиденциальность всего хранилища | `.secrets/`, Compose secret | компрометация = раскрытие всех документов |
| Ключи mTLS «РиН», CA, `server.key` | доверие интеграции | `deploy/*/tls`, secrets | подмена стороны |
| Веса моделей и реестр `ml/models.yaml` | корректность находок | образ ML, кэш | подмена модели — ML06/LLM03 |
| Корпус организатора | правовой режим ADR-0002 | только `yandex:` потоком | утечка в репо, демо, логи |
| Конвейер CI и реестр образов | целостность поставки | GitHub Actions, self-hosted раннер | подмена образа — CICD-SEC |

## Точки входа

| Точка входа | Кто дотягивается | Аутентификация | Зона |
|---|---|---|---|
| `https://nadzorium.almazrobots.ru` (Caddy → web:45900) | **интернет** | логин и пароль приложения; гостевой вход выключен (T-131) | Z1, Z2, Z5 |
| web nginx `:8443` (gpu), `:45843` (stand) | только `127.0.0.1` хоста | — (статика) + прокси `/api` | Z2 |
| API Fastify, 69 маршрутов `/api/v1/*` | через nginx | токен сессии в заголовке, роли | Z1 |
| `/health`, `/metrics`, `/api/v1/openapi.json` | через nginx / сеть compose | нет | Z1, Z5 |
| `/mock-rin/*` | только при `INSPECTOR_RIN_MOCK` | ключ | Z3 |
| ML FastAPI: `/analyze`, `/advise`, `/norms/search`, `/diff`, `/measure`, `/render/{fmt}`, `/health` | сеть compose; gpu — ещё и `127.0.0.1:8810` | см. ретест T088-M7 | Z7, Z8 |
| Загрузка документов `POST /documents/upload`, архивы ZIP | инспектор | роль | Z1, Z7 |
| Входящие пакеты «РиН» (pull), `POST /rin/prescriptions` | ИАИС «РиН» | mTLS + ключ | Z3 |
| Grafana `:3000`, Kibana `:5601`, GELF `:12201/udp` | `127.0.0.1` хоста gpu | свои учётки | Z5 |
| PostgreSQL, Redis, RabbitMQ, ClamAV, MinIO | внутренние сети compose | роли PG, пароли из secrets | Z4, Z5 |
| S3 Yandex Object Storage | исходящий из API | ключи доступа, прокси выхода | Z3, Z4 |
| GitHub Actions, self-hosted раннер | коммиттеры, PR | `permissions`, страж `security-guard` | Z6 |

## Роли приложения

`inspector`, `supervisor`, `curator`, `ml_engineer`, `admin`, гость — только на демо и только по явной учётке
`INSPECTOR_GUEST_LOGIN`. Фактическая матрица «роль × маршрут» — в отчёте E1 текущего полного аудита.

## Контуры развёртывания

| Контур | Файл | Сервисы | Наружу |
|---|---|---|---|
| gpu (прод-профиль, ADR-0001) | `deploy/gpu/compose.yml` (+ `compose.s3.yml`) | api, api-migrate, web, ml, postgres, rabbitmq, redis, clamav, prometheus, alertmanager, grafana, elasticsearch, logstash, kibana | `127.0.0.1`: 8443, 8810, 3000, 5601, 12201/udp |
| stand (мак, жюри) | `deploy/stand/compose.yml` | postgres, api-migrate, api, ml, rabbitmq, web, minio | `127.0.0.1:45843` |
| demo (nadzorium) | `deploy/demo/compose.yml` + `Caddyfile.nadzorium` | postgres, api-migrate, api, web | `127.0.0.1:45900` ← Caddy ← интернет |

## Как пересобрать

```bash
grep -rhoE 'app\.(get|post|put|patch|delete)\("[^"]+' apps/api/src | sort          # маршруты API
grep -nE '@app\.(get|post)\(' ml/inspector_ml/app.py                             # маршруты ML
grep -nE 'ports:' deploy/*/compose*.yml                                           # опубликованные порты
grep -nE 'internal: true' deploy/*/compose*.yml                                   # изолированные сети
```
