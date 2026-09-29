---
id: OPS-REMOTE-RUNNER
title: "Удалённый раннер: шпаргалка для сессий"
owner: CTO (сессия T-171)
updated: 2026-09-28
adr: ADR-0009
task: T-181
---

# Удалённый раннер 158.255.3.179

Мак — только редактор кода. Всё, что запускается, — здесь (ADR-0009, решение владельца 28.09).

## Команды

| Что | Команда |
|---|---|
| тест по одному файлу, tsc, trace (без очереди) | `scripts/remote-run.sh --light "cd apps/api && npx vitest run tests/<файл>"` |
| то же на незакоммиченном коде | `scripts/remote-run.sh --wip --light "cd ml && .venv/bin/pytest tests/<файл> -q"` |
| гейт быстрый / полный | `scripts/remote-run.sh scripts/local-gate.sh --quick` / `… scripts/local-gate.sh` |
| мутации API | `scripts/remote-run.sh --get apps/api/reports/mutation "cd apps/api && env MUTATE=src/domain/<файл> npx stryker run --incremental --concurrency \$W1_THREADS"` |
| мутации ML | `scripts/remote-run.sh "cd ml && .venv/bin/mutmut run --max-children \$W1_THREADS"` |
| забрать отчёт | `--get <путь в репо>` — после прогона копируется в тот же путь на маке |
| стенд ветки (T-183) | `scripts/remote-run.sh stand up [ветка]` (по умолчанию — текущая; `main` → порт 45810, прочие — свой из 45811–45829, печатается после up); `stand status\|logs\|down [ветка]`, `down --wipe` — с томами, `down --forget` — ещё и освободить порт. Полоса `stand`: очередь `cat /opt/w1-gate/lock.stand.cmd`. С мака: `ssh -N -L 45810:127.0.0.1:<порт> root@158.255.3.179`, открыть https://127.0.0.1:45810, CA — `/opt/w1-gate/stand/w1-<ветка>/var/tls/ca.crt`, пароль демо — `…/var/secrets/demo_password`. Хранилище fs, ML в контейнере; смоук в up: `/health` с ревизией, `/documents/import` |

`\$W1_THREADS` экранируется: переменная раскрывается на раннере (число ядер слота).

## Правила

- Код выхода: команда идёт в `bash -o pipefail`, поэтому `… | tail` отдаёт код упавшей команды, а не tail. Шаги связывать `&&`,
  не `;` — иначе код даёт последний шаг, а не первый упавший.

- Гейт, мутации и цифры для QA-отчёта — только по коммиту (без `--wip`): раннер проверяет ровно HEAD.
- Полосы: `heavy` (по умолчанию) — два слота, ядра 24–27 и 28–31, задача берёт первый свободный; `--lane stand` — сборка
  и подъём стенда, своя очередь; `--light` — без очереди, 2 ядра, nice 19 (тяжёлое так не запускать).
- Очередь видна: `ssh root@158.255.3.179 'cat /opt/w1-gate/lock*.cmd'`; логи — `/opt/w1-gate/logs/`.
- На маке для работы с кодом проекта не запускать `pnpm install`, `uv sync`, `docker build`, тесты.
- GPU, контейнеры `vllm-*`, стенд T-185 и запись в `/opt/inspector`, `/opt/corpus` — сессии T-165, не трогать. Ключи
  корпуса на раннер не класть. Чтение корпуса — по правилу ниже.
- Новый хост раннера (если сервер сменят): `ssh <хост> 'bash -s' < scripts/runner/bootstrap.sh`, `W1_RUNNER=root@<хост>`.
- Корпус «Хакатон» — на раннере, **только чтение** (согласовано с T-165 28.09): `/opt/corpus` (blobs/, tree/,
  catalog/*.jsonl) и кэш разбора r4 `/opt/inspector/cache` (`parsed-<sha>-r4`). Ничего там не писать и не переименовывать,
  копий и жёстких ссылок в `/opt/w1-gate` не делать, в Redis стенда nadzorium-gpu не писать. Наружу (git, логи раннера,
  чаты, Telegram) — только агрегаты по коду параметра и коду объекта (POL-17, LOS-3A, ALT-79B…): без текстов, цитат,
  имён файлов, страниц, ФИО, картинок (ADR-0002). Разбор ошибок — только на сервере в `/opt/w1-gate/eval/<волна>` (700).
  Прогон — через remote-run под лимитом памяти волны, nice 19, пока идёт разбор T-165; VLM и GPU — только окном от T-165.
  Тесты, репо и демо — по-прежнему только синтетика.
