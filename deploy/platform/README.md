# Переносимый запуск платформы

Профиль использует существующие сервисы `deploy/gpu-stand/compose.yml`, миграции и образы API/web/ML. Сверху включены durable pipeline, checkpoints, proxy внешних исполнений и node supervisor. Каталог данных находится отдельно от исходников. Чистая установка и проверка нового комплекта документов — отдельные обязательные проверки; наличие этого скрипта ещё не доказывает их прохождение.

На целевом Linux-хосте нужны root/systemd/cgroup v2, Docker Engine с Compose/Buildx, NVIDIA driver/container toolkit, OpenSSL, Python3 и curl. Для полного профиля нужна одна GPU от22GiB, свободная RAM32GiB перед cold-load и минимум80GiB диска для сборок/скачивания моделей плюс место для документов. Стартер не устанавливает драйверы и не меняет конфигурацию чужого раннера.

```sh
sudo python3 scripts/platform-start.py --state /opt/inspector-platform
```

Первый запуск собирает три образа из закреплённого исходного кода, создаёт секреты/CA, скачивает закреплённые модели, запускает Reader, готовит отдельный lifecycle controller, журналы и resource policy, поднимает сервисы, применяет миграции и проверяет реальную ревизию API через HTTPS. Исходники из архива должны содержать `SOURCE_REVISION`; из checkout используется фактический HEAD, изменения tracked файлов отклоняются. Закреплённые PP-OCR и embedding веса скачивает Dockerfile ML. Reader/Judge ревизии совпадают с `ml/models.yaml`; данные и пароль не печатаются.

Интерфейс: `https://127.0.0.1:49443`. Корень доверия: `<state>/tls/ca.crt`. Логины тестового профиля наследуются от стандартного GPU-стенда, пароль — `<state>/secrets/demo_password`; секреты не передавать в публичном архиве. Доступ извне и опубликованный домен переключаются отдельной согласованной операцией; Caddy по умолчанию выключен.

Повтор той же команды сохраняет БД, оригиналы, ключи, Reader container identity и журналы. Потеря identity/истории требует восстановления и не считается пустым безопасным запуском. Чужой compose project, занятый Reader port и неподтверждённый владелец GPU отвергаются. Удаления контейнеров/томов и отключения стандартного GPU-стенда в стартере нет.

Для подготовленных локальных образов можно пропустить сборку:

```sh
sudo python3 scripts/platform-start.py --state /opt/inspector-platform \
  --images /private/images.json --prepare-only
```

Manifest содержит полный `revision` и immutable IDs `images.api/web/ml`; стартер проверяет реальные метки образов и соответствие текущим исходникам. `--prepare-only` готовит и валидирует конфигурацию, не поднимает сервисы и не обращается к GPU. Этот режим не считается проверкой полного запуска.

`--external-reader-container` вместе с `--reader-controller` предназначены для ограниченного испытания на машине с уже запущенным закреплённым Reader. Стартер использует существующий controller, не устанавливает второго владельца и не меняет lifecycle внешней модели. Такой прогон не заменяет cold-load на чистой машине. `--hf-dir`/`--no-download` допускают заранее подготовленный pinned model cache; отсутствие нужного snapshot означает отказ.

Начальный профиль: один ML worker, четыре CPU/6GiB RAM, один parse job, Reader inflight4, PP-OCR arena1536MiB; API6GiB RAM, PostgreSQL2GiB, Redis1536MiB, RabbitMQ1GiB. Это потолки конфигурации; peak/latency измеряются при испытании, а не выводятся из этих чисел.

Judge веса скачиваются, но текущий durable OCR профиль держит `INSPECTOR_JUDGE_PHASE=off`. Автоматическое переключение Reader/Judge и проверка Judge ещё не включены в этот стартер; их нельзя выдавать за готовые. Также до передачи остаются автоматический сквозной acceptance scenario, повторная установка с проверкой сохранённых результатов, перенос исторического snapshot, браузерная проверка, CPU read-only публикация и публичные ссылки.

## CPU originals mirror

`apps/api/dist/cli/blobs-mirror.mjs --manifest <private-file> --manifest-sha256 <64hex> --output <private-directory>` выполняет явный перенос оригиналов без запуска БД/ML. Manifest: `{"schema":"platform-blob-mirror/1","shas":["64hex"]}`; его список берётся из согласованного снимка БД. Source — `INSPECTOR_BLOB_DIR`; target — S3-конфигурация и ключ CPU-витрины, отдельный приватный prefix `platform-view/<run>/`. Исходный каталог монтируется read-only. Используется существующее streaming AES-GCM шифрование хранилища и SHA-проверка на лету; plaintext целиком не сохраняется. Прогресс приватный, привязан к manifest/source/bucket/prefix/key fingerprint; повтор продолжает его. Запуск один на manifest/output. До массового переноса проверяется один файл через S3 и CPU API. Успешная запись объектов сама по себе не доказывает доступность CPU-сайта — это отдельная проверка после настройки read prefixes и переноса БД.
