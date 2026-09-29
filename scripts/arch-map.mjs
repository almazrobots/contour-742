// Архитектура «Инспектора ИИ» — docs/gera/ARCHITECTURE.html, кнопка «Архитектура» на карте трассы (pnpm trace).
// Пересобрано 27.09 (T-129, просьба владельца «перекомпоновать, чтобы было понятно»): одна схема того, что ЕСТЬ,
// слева направо «люди → вход → ядро → интеллект → модели», данные под ядром; всё, чего нет, — отдельным списком,
// а не пунктиром на схеме. Ниже — путь документа по шагам и три способа запуска таблицей.
// Источник фактов — deploy/gpu-stand/compose.yml (GPU-стенд), deploy/demo/compose.yml (read-only демо),
// deploy/stand/compose.yml (прежний локальный стенд), ADR-0001…0009, docs/ops/REMOTE-RUNNER.md,
// OWASP T-184/T-185. Разделяет конфигурацию и последнее живое подтверждение. RAM: «~» — оценка, не замер.
// Тот же уровень 2 в Mermaid — docs/architecture/C4.md; меняется архитектура — правятся оба.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceNavCss, renderServiceNav, renderServiceMetadata } from "./docs-service-nav.mjs";

// ─────────────────────────────── главная схема
// kind: person · product · models · data · s3 · tz (обвязка по ТЗ) · obs · ext (внешняя) ·
//       ghost (требует ТЗ, нет) · ghostc (решение команды, нет) · ghostx (внешняя сторона, не подключена)
// in — в каких профилях блок есть: gpu (GPU-стенд), stand (демо только для чтения), dev (CPU-разработка); alt — чем заменён
const W = 1500;
const H = 720;
const ALL = ["gpu", "stand", "dev"];
const NODES = [
  { id: "ids", kind: "ghost", x: 215, y: 16, w: 150, h: 56, lines: ["IDS · DDoS", "ТЗ 12.9"] },
  { id: "edge", kind: "product", x: 390, y: 16, w: 190, h: 56, lines: ["Caddy · входной прокси", "HTTPS · имя и сертификат"], in: ["gpu", "stand"] },
  { id: "rin", kind: "ext", x: 620, y: 10, w: 270, h: 66, lines: ["ИАИС «РиН»", "пакеты ⇄ протокол, статусы"], in: [], alt: { gpu: "заглушка API; интеграция не включена", stand: "заглушка API", dev: "заглушка API" } },
  { id: "uc", kind: "ghostx", x: 930, y: 16, w: 240, h: 56, lines: ["Удостоверяющий центр", "CRL · OCSP · TSP"] },
  { id: "skzi", kind: "ghost", x: 620, y: 92, w: 270, h: 46, lines: ["Шлюз СКЗИ · ГОСТ-TLS", "ТЗ 12.10"] },

  { id: "insp", kind: "person", x: 8, y: 180, w: 182, h: 70, lines: ["Инспектор", "Мосстройнадзор"] },
  { id: "meth", kind: "person", x: 8, y: 268, w: 182, h: 70, lines: ["Методолог · админ", "Матрица, нормативы"] },
  { id: "ops", kind: "person", x: 8, y: 610, w: 182, h: 70, lines: ["Эксплуатация", "дежурный инженер"] },

  { id: "web", kind: "product", x: 390, y: 180, w: 190, h: 130, lines: ["Веб-интерфейс", "React 19 · nginx", "HTTPS · TLS 1.3"], in: ALL, alt: { dev: "Vite :45810" } },
  { id: "api", kind: "product", x: 620, y: 180, w: 270, h: 130, lines: ["API", "Node 24 · Fastify", "OpenAPI 3.0", "сравнение, решения, протокол"], in: ALL },
  { id: "ml", kind: "product", x: 930, y: 180, w: 240, h: 130, lines: ["ML-сервис · GPU", "Python · FastAPI · HTTPS", "разбор PDF, OCR сканов", "извлечение, судья VLM"], in: ["gpu"], alt: { dev: "ML-контура нет · см. GPU-стенд" } },
  { id: "models", kind: "models", x: 1210, y: 180, w: 270, h: 130, lines: ["Модели", "GPU: PP-OCR CUDA + VL reader", "Qwen judge через vLLM", "RTX 4090 · GPU-инференс"], in: ["gpu"], alt: { dev: "модели — в GPU-контуре" } },
  { id: "vllm", kind: "product", x: 1210, y: 330, w: 270, h: 50, lines: ["vLLM reader + judge", "GPU стенд · RTX 4090"] , in: ["gpu"] },
  { id: "train", kind: "product", x: 1210, y: 395, w: 270, h: 62, lines: ["Верификация и разметка", "подготовка данных для дообучения", "T-244 · наборы и выгрузка"], in: ["gpu"], alt: { stand: "см. рабочий модуль на GPU-стенде", dev: "реализация в отдельном модуле" } },

  { id: "worker", kind: "ghostc", x: 215, y: 355, w: 150, h: 70, lines: ["Воркер разбора", "отдельный процесс"] },
  { id: "rabbit", kind: "tz", x: 390, y: 355, w: 190, h: 70, lines: ["RabbitMQ", "очередь разбора · amqps"], in: ["gpu"], alt: { stand: "не используется · только чтение", dev: "очередь в процессе API" } },
  { id: "clamav", kind: "tz", x: 390, y: 445, w: 190, h: 70, lines: ["ClamAV", "антивирус файлов"], in: [], alt: { gpu: "выключен в T-185", stand: "не запускается", dev: "не запускается" } },

  { id: "db", kind: "data", x: 620, y: 355, w: 130, h: 96, lines: ["PostgreSQL 18", "проверки, аудит"], in: ["gpu", "stand"], alt: { dev: "PGlite в процессе", stand: "снимок опубликованных данных" } },
  { id: "cache", kind: "data", x: 765, y: 355, w: 130, h: 96, lines: ["Кэш блобов", "том api-blobs"], in: ALL, alt: { dev: "каталог var/blobs" } },
  { id: "s3", kind: "s3", x: 925, y: 355, w: 150, h: 96, lines: ["Object Storage", "nadzorium, Москва", "шифротекст"], in: ["stand"], alt: { gpu: "не используется на GPU стенде", dev: "по выбору" } },
  { id: "redis", kind: "tz", x: 1090, y: 365, w: 100, h: 76, lines: ["Redis", "кэш разбора"], in: ["gpu"], alt: { stand: "файловый кэш", dev: "файловый кэш" } },
  { id: "atrest", kind: "ghost", x: 620, y: 470, w: 275, h: 44, lines: ["Шифрование БД и тома", "ТЗ 12.3 · файлы в S3 — уже"] },
  { id: "backup", kind: "ghost", x: 925, y: 470, w: 150, h: 44, lines: ["Бэкап", "ТЗ 12.8 · T-072"] },
  { id: "offsite", kind: "ghostx", x: 1090, y: 470, w: 180, h: 44, lines: ["Хранилище копий", "вне сервера"] },

  { id: "obs", kind: "obs", x: 390, y: 600, w: 780, h: 90, lines: ["Наблюдаемость", "Prometheus · Grafana · Alertmanager — метрики и алерты", "Logstash · Elasticsearch · Kibana — логи"], in: [], alt: { gpu: "не входит в compose GPU-стенда", stand: "нет", dev: "нет" } },
  { id: "export", kind: "ghost", x: 1210, y: 600, w: 270, h: 40, lines: ["Экспортёры метрик · ТЗ 13.4"] },
  { id: "notify", kind: "ghostx", x: 1210, y: 650, w: 270, h: 40, lines: ["Получатели алертов · почта, Telegram"] },
];

// p — точки ломаной; l — подпись; at — сегмент подписи; dash — пунктир (чтение, служебное, недостроенное); both — в обе стороны
const EDGES = [
  { f: "insp", t: "web", p: [[190, 215], [390, 215]], l: "браузер", at: 0 },
  { f: "meth", t: "web", p: [[190, 290], [390, 290]], l: "настройка", at: 0 },
  { f: "edge", t: "web", p: [[485, 72], [485, 180]], l: "", at: 0, dash: true },
  { f: "ids", t: "edge", p: [[365, 44], [390, 44]], l: "", at: 0, dash: true },
  { f: "web", t: "api", p: [[580, 245], [620, 245]], l: "HTTPS", at: 0 },
  { f: "api", t: "ml", p: [[890, 245], [930, 245]], l: "HTTPS", at: 0 },
  { f: "ml", t: "models", p: [[1170, 245], [1210, 245]], l: "", at: 0 },
  { f: "models", t: "vllm", p: [[1345, 310], [1345, 330]], l: "", at: 0 },
  { f: "api", t: "skzi", p: [[755, 180], [755, 138]], l: "", at: 0, dash: true },
  { f: "skzi", t: "rin", p: [[755, 92], [755, 72]], l: "", at: 0, dash: true },
  { f: "api", t: "rin", p: [[650, 180], [650, 72]], l: "mTLS + УКЭП", at: 0, both: true },
  { f: "api", t: "uc", p: [[870, 180], [870, 160], [1050, 160], [1050, 72]], l: "проверка подписи", at: 1, dash: true },
  { f: "api", t: "rabbit", p: [[620, 280], [600, 280], [600, 380], [580, 380]], l: "задания", at: 1, both: true },
  { f: "worker", t: "rabbit", p: [[365, 390], [390, 390]], l: "", at: 0, dash: true },
  { f: "api", t: "clamav", p: [[620, 298], [608, 298], [608, 480], [580, 480]], l: "", at: 1 },
  { f: "api", t: "db", p: [[685, 310], [685, 355]], l: "SQL", at: 0 },
  { f: "api", t: "cache", p: [[830, 310], [830, 355]], l: "файлы", at: 0 },
  { f: "cache", t: "s3", p: [[895, 403], [925, 403]], l: "", at: 0 },
  { f: "ml", t: "cache", p: [[960, 310], [960, 335], [860, 335], [860, 355]], l: "", at: 1, dash: true },
  { f: "ml", t: "redis", p: [[1140, 310], [1140, 365]], l: "", at: 0 },
  { f: "backup", t: "offsite", p: [[1075, 492], [1090, 492]], l: "", at: 0, dash: true },
  { f: "api", t: "obs", p: [[905, 310], [905, 560], [780, 560], [780, 600]], l: "метрики · логи", at: 1, dash: true },
  { f: "obs", t: "notify", p: [[1170, 670], [1210, 670]], l: "", at: 0, dash: true },
  { f: "ops", t: "obs", p: [[190, 645], [390, 645]], l: "Grafana · Kibana", at: 0 },
];

const BANDS = [
  { x: 375, y: 150, w: 1115, h: 172, l: "Продукт" },
  { x: 605, y: 340, w: 600, h: 185, l: "" },
  { x: 375, y: 340, w: 220, h: 185, l: "" },
];

// карточка блока при щелчке: что это, основание, память, состояние
const DETAIL = {
  insp: { k: "Роль", d: "Загружает пакеты ПД, РД, ИД, запускает проверку, решает по кандидатам на экране верификации рядом с листом, подписывает протокол.", tz: "ТЗ 9.2" },
  meth: { k: "Роль", d: "Ведёт Матрицу (132 параметра, у М-023 — паспорт с алгоритмом), логические правила и нормативы; утверждает версии моделей.", tz: "ТЗ 9.3, 9.4" },
  ops: { k: "Роль", d: "Смотрит метрики и алерты в Grafana, логи — в Kibana; получает алерты почтой и в Telegram.", tz: "ТЗ 13" },
  rin: { k: "Внешняя система", d: "Источник пакетов (опрос по таймеру) и получатель протокола и статусов предписаний. Транспорт — mTLS + УКЭП. На стенде и в разработке вместо неё — заглушка внутри API.", tz: "ТЗ 9.6", state: "контракт — допущение (T-067)" },
  web: { k: "Свой сервис", d: "Интерфейс инспектора: проверки, карточка, экран верификации с листом PDF и рамкой, Матрица с паспортом параметра, администрирование. nginx отдаёт статику и проксирует /api/ в API по TLS; CSP с frame-ancestors 'none'.", tz: "ТЗ 1.5", ram: "~20 МБ" },
  api: { k: "Свой сервис", d: "Единственный владелец данных. Приём пакета (пути, пределы, SHA-256, реестр), очередь разбора с восстановлением после сбоя, сравнение по паспорту параметра (ворота, выбор источника, шкала, противоречия), решения инспектора, протокол в четырёх форматах и независимый пересчёт. Маршруты описаны в OpenAPI 3.0. На GPU-стенде T-185 интеграция «РиН» заменена заглушкой, антивирус выключен; в демо API не принимает изменения.", tz: "ТЗ 1.3, 1.5, T-185", ram: "~0,2–0,3 ГБ" },
  ml: { k: "Свой сервис", d: "Без состояния. Текстовый слой pdfium (переносы склеиваются), сканы — ансамбль Tesseract параллельно в пределах бюджета памяти; потолок листа и числа страниц для недоверенного PDF; извлечение параметров и упоминаний класса по паспорту с отсевом ловушек; судья VLM только понижает уверенность. Ответ несёт версию разбора — API переразбирает файлы прежней версии.", tz: "ТЗ 1.5, 9.1", ram: "~0,8–1,5 ГБ", state: "М-023 на «Алтуфьево»: оракул 6/6, сканы 1/1, судья 24/24" },
  models: { k: "Модели · GPU", d: "GPU-стенд nadzorium-gpu: OCR-якорь PP-OCR на ONNX Runtime CUDA, читатель PaddleOCR-VL и судья Qwen3.5-9B через vLLM. Рабочий ML-контур — GPU; удалённый раннер относится к инструментам разработки. Реестр и ревизии моделей — ml/models.yaml.", tz: "T-184, T-185, ml/models.yaml", state: "по отчёту T-184/T-185: GPU-путь проверен на сервере 28.09.2026; снимок от 29.09: reader запущен, judge и ML остановлены" },
  vllm: { k: "GPU-стенд · настроено и проверено", d: "Два vLLM процесса на RTX 4090: reader PaddleOCR-VL на :8000 и judge Qwen3.5-9B на :8001; локальный маршрутизатор :8010. T-184/T-185 содержат живые проверки 28.09.2026. Это конфигурация GPU-стенда deploy/gpu-stand; конфигурацию deploy/gpu отдельно не считать развёрнутой.", tz: "deploy/gpu-stand, T-184, T-185" },
  train: { k: "Реализовано · подготовка обучающих данных", d: "Модуль «Верификация и разметка данных» (T-244): задания, ответы Да/Нет/Не уверен, комментарии и исправления, разбор спорных случаев, выпуск и выгрузка версионированного набора. Это подготовительная часть бизнес-процесса дообучения. Отдельно существуют GOLD по решениям инспектора и обучение ранжира (T-100). Автоматическая передача набора T-244 тренеру и LoRA судьи не подтверждаются наличием разметки. Подробная цепочка и ссылки на код — ниже.", tz: "ТЗ 7.4, 9.4; T-244, T-100; опубликованная ревизия df65e188" },
  ids: { k: "Требует ТЗ · нет", d: "Обнаружение вторжений и защита от DDoS на периметре или внешним сервисом.", tz: "ТЗ 12.9" },
  edge: { k: "Периметр · Caddy", d: "Caddy публикует HTTPS-имя GPU-стенда; в read-only демо внешний Caddy защищает материалы Basic Auth. Внутренний веб не является публичным входом. GPU Caddy наблюдался работающим 29.09.2026.", tz: "deploy/gpu-stand, deploy/demo, T-185" },
  uc: { k: "Внешняя сторона · не подключена", d: "Отзыв сертификатов и метка времени для проверки ГОСТ-подписи электронной ИД.", tz: "ТЗ §5, T-068" },
  skzi: { k: "Требует ТЗ · нет", d: "Сайдкар в сети API (КриптоПро stunnel или NGate): ключ УКЭП и ГОСТ-mTLS с «РиН». Код режима gost-proxy уже есть и ждёт шлюз на loopback.", tz: "ТЗ 12.10, 9.6.2" },
  worker: { k: "Решение команды · нет", d: "Тот же образ API отдельным потребителем очереди: разбор уходит из процесса API и масштабируется несколькими процессами.", tz: "решение команды" },
  rabbit: { k: "Обвязка по ТЗ", d: "Durable-очередь inspector.parse по amqps: задание на файл, ack после разбора. Перезапуск или отключение питания не теряют файлы: брокер вернёт неподтверждённые, API дочистит застрявшие проверки; файл берёт ровно одно задание. Потребитель пока в процессе API.", tz: "ТЗ 1.5, 9.1", ram: "~0,15 ГБ" },
  clamav: { k: "Обвязка по ТЗ · отсутствует в текущих профилях", d: "ClamAV предусмотрен в целевой compose-конфигурации deploy/gpu, но GPU-стенд T-185 явно запускает API с INSPECTOR_AV=off. На read-only демо проверка загрузки не используется.", tz: "ТЗ 12.11, deploy/gpu-stand/compose.yml" },
  db: { k: "Данные", d: "Проверки, кандидаты, протоколы, журнал аудита, правила, верификации. PostgreSQL 18, TLS 1.3 с проверкой сертификата, пароли — файлами; в разработке — PGlite, тот же движок. Схема — миграции с контрольной суммой.", tz: "ADR-0003" },
  cache: { k: "Данные", d: "Исходные документы по SHA-256: API пишет, ML читает. С Object Storage — кэш перед бакетом; без него (сервер без интернета) — единственное хранилище.", tz: "ADR-0006" },
  s3: { k: "Данные · внешний сервис", d: "Yandex Object Storage, Москва. Read-only демо nadzorium.almazrobots.ru читает опубликованные зашифрованные блобы; GPU-стенд T-185 использует локальный каталог /opt/stand-gpu/blobs и не подключает S3. Прежний Docker-стенд на Mac с S3 больше не является штатным путём запуска.", tz: "T-131, T-185, ADR-0004, ADR-0006", state: "публикация на демо документирована в T-131; паспорт опубликованного снимка демо прочитан 29.09; это не проверка доступности всех блобов" },
  redis: { k: "Обвязка по ТЗ", d: "Кэш разбора по SHA-256 в GPU-профиле — Redis с TLS и AOF. В CPU-разработке используется файловый кэш; read-only демо разбор не запускает.", tz: "ТЗ 9.1.5, deploy/gpu-stand" , ram: "до 8 ГБ данных (конфиг)" },
  atrest: { k: "Требует ТЗ · разный статус по профилям", d: "В deploy/gpu реализована проверка и опциональное шифрование томов и WAL (T-137); на GPU-стенде T-185 данные на хосте остаются без шифрования в покое — OWASP-0191 открыт. S3-блобы демо шифруются на клиенте.", tz: "ТЗ 12.3, T-137, T-185" },
  backup: { k: "Реализовано в deploy/gpu; отсутствует в GPU-стенде", d: "Для deploy/gpu настроены ежедневный pg_basebackup, WAL-архив, хранение 30 дней; учение восстановления: RTO 1,3 с, RPO 120 с (T-072). Эти службы не входят в compose GPU-стенда T-185: его БД, Redis и blobs без бэкапа (OWASP-0197).", tz: "ТЗ 12.8, T-072, T-185" },
  offsite: { k: "Внешняя сторона · не подключена", d: "Место для копий вне сервера: ежедневно, 30 дней.", tz: "ТЗ 12.8" },
  obs: { k: "Наблюдаемость · целевая конфигурация", d: "Стек Prometheus, Grafana, Alertmanager и ELK описан в deploy/gpu. В compose GPU-стенда T-185 он отсутствует; живой мониторинг этого стенда документами T-185 не подтверждён.", tz: "ТЗ 13.4–13.7, deploy/gpu" },
  export: { k: "Требует ТЗ · нет", d: "Метрики хоста (диск, CPU, RAM) и каждого сервиса; сейчас ML не наблюдается совсем.", tz: "ТЗ 13.4" },
  notify: { k: "Внешняя сторона · не подключена", d: "Почтовый ящик и чат Telegram, куда Alertmanager доставляет алерты.", tz: "ТЗ 13.7" },
};

// ─────────────────────────────── путь документа: порядок шагов — сам процесс
const FLOW = [
  ["API", "Приём", "Архив читается потоком: пути, пределы, SHA-256, дубликаты, реестр; антивирус зависит от профиля (в T-185 выключен)."],
  ["BlobStore", "Хранение", "GPU: локальные блобы. Демо: чтение опубликованных S3-блобов с AES-256-GCM."],
  ["RabbitMQ", "Очередь", "Задание на файл; ack после разбора, восстановление после сбоя."],
  ["ML", "Разбор", "Текстовый слой или OCR скана; бюджет памяти, потолок листа."],
  ["ML", "Извлечение", "Упоминания по паспорту параметра; соседние здания и таблицы норм отсеяны."],
  ["ML · VLM", "Проверка", "Судья по кропу листа только понижает уверенность."],
  ["API", "Сравнение", "Ворота, выбор источника, шкала; противоречие внутри стадии — гипотеза."],
  ["Веб", "Решение", "Инспектор видит лист с рамкой: признать, снять или уточнить."],
  ["API", "Выход", "Протокол JSON, XML, PDF, DOCX; верификация оракулом; опись SHA-256."],
];

// ─────────────────────────────── три способа запуска
const RUNS = {
  head: ["", "Mac · прежний CPU-стенд", "CPU-раннер удалённо", "GPU-стенд nadzorium-gpu", "Демо nadzorium · read-only"],
  rows: [
    ["Назначение", "Прежний Docker-стенд и MLX на Mac; путь заменён ADR-0009", "Сборка, тесты и dev-стенд ветки; CUDA_VISIBLE_DEVICES пуст", "GPU OCR/VLM и экспериментальные прогоны", "Просмотр опубликованных результатов"],
    ["Запуск", "Исторический: scripts/stand.sh; текущая работа на Mac — редактор", "scripts/remote-run.sh; стенд ветки по --lane stand", "scripts/gpu-stand.sh; deploy/gpu-stand/compose.yml", "deploy/demo; INSPECTOR_READONLY=1"],
    ["Исполнение", "CPU или прежний MLX; больше не штатный стенд", "CPU, 24–31 ядра слота W1; GPU не используется", "RTX 4090; ML GPU + два vLLM", "ML отсутствует; запись API возвращает 403"],
    ["Данные", "синтетика; прежний тестовый прогон «Алтуфьево»", "код и синтетика; разрешённый корпус отдельно только чтение", "/opt/stand-gpu/blobs; реальные данные стенда", "PostgreSQL-снимок и блобы из Object Storage"],
    ["Очередь · БД", "очередь in-process · PGlite", "зависит от сценария; стенд ветки — RabbitMQ + PostgreSQL", "RabbitMQ + PostgreSQL 18/TLS", "очередь выключена · PostgreSQL 18"],
    ["Последнее подтверждение", "T-104/ADR-0001 — историческое состояние", "ADR-0009 принят 28.09.2026; remote-run правила актуальны", "T-184/T-185 живые проверки 28.09.2026; снимок процессов 29.09 приведён выше", "T-131 описывает публикацию и read-only-проверки; снимок процессов 29.09 приведён выше"],
  ],
};

// ─────────────────────────────── чего нет: не на схеме, а списком
const GAPS = {
  tz: [
    ["Шлюз СКЗИ", "ТЗ 12.10 · T-068", "ГОСТ-mTLS с «РиН»: сайдкар в сети API, ключ УКЭП."],
    ["Экспортёры метрик", "ТЗ 13.4", "Хост и каждый сервис; ML сейчас не наблюдается."],
    ["Бэкап GPU-стенда", "T-185 · OWASP-0197", "В deploy/gpu есть бэкап и успешное учение T-072; в compose nadzorium-gpu резервирование не включено."],
    ["Шифрование данных GPU-стенда в покое", "T-185 · OWASP-0191", "Шифрование есть в конфигурации deploy/gpu, но на сервере стенда T-185 данные хранятся открыто; вопрос владельца открыт."],
    ["IDS · защита от DDoS", "ТЗ 12.9", "На периметре или внешним сервисом."],
    ["LoRA судьи и связь набора разметки с тренером", "ТЗ 9.4 · T-156", "Подготовка данных T-244 и обучение ранжира T-100 существуют. Отдельная реализация обучения весов судьи и автоматическая передача набора T-244 тренеру здесь не подтверждены."],
  ],
  team: [
    ["Профиль deploy/gpu", "ADR-0001", "Отдельная конфигурация gpu не подтверждена как развёрнутая; фактический GPU-стенд настроен в deploy/gpu-stand."],
    ["Воркер разбора", "решение команды", "Тот же образ API отдельным потребителем очереди — масштаб ML."],
    ["Сервисный аккаунт API", "ADR-0004 п. 6", "Свой ключ с ролью на префикс блобов вместо общего ключа заливки."],
  ],
  ext: [
    ["Удостоверяющий центр", "ТЗ §5 · T-068", "CRL, OCSP, метка времени для проверки ГОСТ-подписи."],
    ["Получатели алертов", "ТЗ 13.7", "Почта и чат Telegram для Alertmanager."],
    ["Хранилище копий", "ТЗ 12.8", "Место для бэкапа вне сервера."],
  ],
};

const CONTRA = [
  ["TLS внутри контура", "ТЗ 12.3 требует TLS 1.3 для всех данных при передаче. Закрыто: API → ML, очередь, Redis, PostgreSQL, S3. Остались ELK и GELF по UDP."],
  ["152-ФЗ и GPU-стенд", "T-185 указывает сервер HOSTKEY 54831 в Москве; локализация ПДн выполнена, но шифрование в покое и срок удаления при выводе сервера открыты (OWASP-0191). Не переносить прежнее описание hk-nl-heavy на GPU-стенд."],
  ["«РиН» в compose", "Без INSPECTOR_RIN_TLS выбирается прямой режим, которому нужен CA; режим ГОСТ-шлюза требует сайдкар в сети API."],
  ["ТЗ само с собой", "§11 п.8 — CV-анализ DWG при форматах PDF, DOCX, XML в §7.1; §12.8 — суточный бэкап при RPO ≤ 15 мин в §11 п.14."],
];

const NEXT = [
  ["GPU-стенд: поддерживать соответствие образов и моделей", "T-184 фиксирует обязательность GPU extra и закреплённых версий; конфигурацию GPU-стенда нельзя автоматически считать совпадающей с deploy/gpu."],
  ["Текущую активность стендов проверять отдельно", "Документы опираются на последнюю живую проверку T-184/T-185 от 28.09.2026; перед эксплуатационным решением обновить статус разрешённым read-only опросом."],
  ["Спросить организатора про ELK", "Если ТЗ 13.6 допускает Loki в уже работающую Grafana — минус три контейнера и ~3 ГБ."],
  ["Воркер разбора отдельным процессом", "Очередь уже страхует; отдельный потребитель начнёт масштабировать разбор."],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function nodeSvg(n) {
  const inP = (n.in ?? (n.kind.startsWith("ghost") ? ["gpu"] : ALL)).join(" ");
  const alt = n.alt ? Object.entries(n.alt).map(([k, v]) => ` data-alt-${k}="${esc(v)}"`).join("") : "";
  const attrs = ` tabindex="0" role="button" data-id="${n.id}" data-in="${inP}"${alt} aria-label="${esc(n.lines.join(", "))}"`;
  let shape;
  if (n.kind === "data" || n.kind === "s3") {
    const ry = 10;
    shape = `<path class="box" d="M${n.x},${n.y + ry} a${n.w / 2},${ry} 0 0 0 ${n.w},0 a${n.w / 2},${ry} 0 0 0 ${-n.w},0 v${n.h - 2 * ry} a${n.w / 2},${ry} 0 0 0 ${n.w},0 v${-(n.h - 2 * ry)}"/>`;
  } else {
    shape = `<rect class="box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.kind === "person" ? 20 : 8}"/>`;
  }
  const small = n.h < 60;
  const top = n.kind === "data" || n.kind === "s3" ? n.y + 38 : small ? n.y + (n.lines.length > 1 ? 21 : 25) : n.y + 27;
  const step = small ? 16 : 18;
  const text = n.lines.map((t, i) => `<text class="${i === 0 ? "t1" : "t2"}" x="${n.x + 12}" y="${top + (i === 0 ? 0 : (small ? 0 : 5) + i * step)}">${esc(t)}</text>`).join("");
  const glyph = n.kind === "person" ? `<circle class="head" cx="${n.x + n.w - 22}" cy="${n.y + 24}" r="7"/><path class="head" d="M${n.x + n.w - 34},${n.y + 50} q12,-18 24,0"/>` : "";
  const altText = n.alt ? `<text class="alt" x="${n.x + 12}" y="${n.y + n.h - 9}"></text>` : "";
  return `<g class="n ${n.kind}"${attrs}>${shape}${glyph}${text}${altText}</g>`;
}

function edgeSvg(e, i) {
  const d = "M" + e.p.map((q) => q.join(",")).join(" L");
  const seg = [e.p[e.at], e.p[e.at + 1]];
  const mx = (seg[0][0] + seg[1][0]) / 2;
  const my = (seg[0][1] + seg[1][1]) / 2;
  const vertical = seg[0][0] === seg[1][0];
  const label = e.l ? `<text class="el" x="${vertical ? mx + 7 : mx}" y="${vertical ? my + 4 : my - 7}" text-anchor="${vertical ? "start" : "middle"}">${esc(e.l)}</text>` : "";
  return `<g class="e${e.dash ? " dash" : ""}" data-f="${e.f}" data-t="${e.t}"><path d="${d}" marker-end="url(#arr)"${e.both ? ' marker-start="url(#arr)"' : ""}/>${label}</g>`;
}

const defs = `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7E84A3"/></marker></defs>`;

export function renderArchMap({ today, root }) {
  const fonts = ["onest-var", "golos-text-var", "jetbrains-mono-var"].map((f) => {
    const p = join(root, "apps/web/public/fonts", `${f}.woff2`);
    return existsSync(p) ? readFileSync(p).toString("base64") : "";
  });
  const detail = Object.fromEntries(NODES.map((n) => [n.id, { title: n.lines[0], sub: n.lines.slice(1).join(" · "), ...DETAIL[n.id] }]));
  const json = JSON.stringify(detail).replace(/</g, "\\u003c");

  const dia = `<svg class="dia" viewBox="0 0 ${W} ${H}" role="img" aria-label="Архитектура «Инспектора ИИ»: люди, вход, ядро, интеллект и модели слева направо, данные под ядром, наблюдаемость внизу; пунктиром — чего нет">${defs}
${BANDS.map((b) => `<rect class="band" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10"/><text class="bandl" x="${b.x + 12}" y="${b.y + 17}">${esc(b.l)}</text>`).join("\n")}
${EDGES.map(edgeSvg).join("\n")}
${NODES.map(nodeSvg).join("\n")}
</svg>`;

  const flow = FLOW.map(([who, what, how], i) => `<li><div class="st"><span class="num">${i + 1}</span><span class="who">${esc(who)}</span></div><b>${esc(what)}</b><p>${esc(how)}</p></li>`).join("");
  const runs = `<table class="runs"><thead><tr>${RUNS.head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${RUNS.rows.map((r) => `<tr><th scope="row">${r[0]}</th>${r.slice(1).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const gapList = (items) => `<ul class="gl">${items.map(([n, b, t]) => `<li><div class="gh"><b>${esc(n)}</b><span class="mono">${esc(b)}</span></div><p>${esc(t)}</p></li>`).join("")}</ul>`;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Архитектура Инспектора ИИ</title>
<style>
@font-face{font-family:"Onest";src:url(data:font/woff2;base64,${fonts[0]}) format("woff2");font-weight:100 900}
@font-face{font-family:"Golos Text";src:url(data:font/woff2;base64,${fonts[1]}) format("woff2");font-weight:400 900}
@font-face{font-family:"JetBrains Mono";src:url(data:font/woff2;base64,${fonts[2]}) format("woff2");font-weight:100 800}
:root{
  color-scheme:light;
  --ground:#F1F2F6;--band:#F7F7FA;--card:#FFFFFF;--ink:#1D1F2E;--ink2:#474B62;--mute:#6B6F85;--line:#D9DBE5;--line2:#E6E7EE;
  --rs:#3B4FA8;--rs-soft:#EAEDF8;--rs-line:#A9B2D8;--edge:#7E84A3;
  --done:#2E9E6B;--done-soft:#E4F6ED;--part:#E0A21A;--part-soft:#FFF4DC;--part-ink:#8A6200;--todo:#9097AD;--todo-soft:#EEF0F5;
  --out:#4B7BEC;--out-soft:#E8F0FF;--red:#D6454A;--red-soft:#FDECEC;
  --radius:8px;--sans:"Golos Text",system-ui,sans-serif;--head:"Onest","Golos Text",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.55 var(--sans)}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--rs);outline-offset:2px}
.mono{font-family:var(--mono);font-size:12px}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 18px 10px}
.h1row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font:700 19px/1.2 var(--head);margin:0;letter-spacing:-.01em}
.views{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
.views a{border:1px solid transparent;border-radius:6px;padding:5px 12px;font:600 13px/1.45 var(--sans);color:var(--mute);text-decoration:none}
.views a:hover{color:var(--ink)}
.views a.on{border-color:var(--line);background:var(--ground);color:var(--ink)}
main{max-width:1440px;margin:0 auto;padding-inline:18px;padding-block:22px 64px;display:flex;flex-direction:column;gap:34px}
h2{font:700 20px/1.25 var(--head);margin:0;text-wrap:balance;letter-spacing:-.01em}
h3{font:700 15px/1.3 var(--head);margin:0}
.lead{color:var(--ink2);max-width:72ch;margin:6px 0 0}
.eyebrow{font:600 11px var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--rs);margin-bottom:6px}
.sec{display:flex;flex-direction:column;gap:14px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px}

/* вывод */
.summary{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:26px;padding:22px 24px}
.summary h2{font-size:24px}
.summary p{margin:10px 0 0;max-width:68ch;color:var(--ink2)}
.summary p b{color:var(--ink)}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-content:start}
.fact{background:var(--band);border:1px solid var(--line2);border-radius:var(--radius);padding:12px 14px}
.fact b{display:block;font:700 24px/1.1 var(--head);font-variant-numeric:tabular-nums;margin-bottom:4px}
.fact span{color:var(--ink2);font-size:12.5px;line-height:1.4;display:block}
.fact.good b{color:var(--done)}.fact.bad b{color:var(--red)}.fact.warn b{color:var(--part-ink)}

/* схема */
.stage{display:flex;flex-direction:column;gap:12px}
.scroll{overflow-x:auto;padding:14px}
.dia{display:block;width:100%;min-width:1000px;height:auto}
.dia .band{fill:var(--band);stroke:var(--line2)}
.dia .bandl{font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;fill:var(--mute)}
.dia .n{cursor:pointer}
.dia .n .box{stroke-width:1.2;transition:filter .15s}
.dia .n .t1{font:700 15px var(--head)}
.dia .n .t2{font:11.5px var(--mono)}
.dia .person .box{fill:var(--card);stroke:var(--ink)}.dia .person .t1{fill:var(--ink)}.dia .person .t2{fill:var(--mute)}
.dia .head{fill:none;stroke:var(--ink);stroke-width:1.3}
.dia .product .box{fill:var(--rs);stroke:var(--rs)}.dia .product .t1{fill:#fff}.dia .product .t2{fill:#DCE1F5}
.dia .models .box{fill:var(--card);stroke:var(--rs);stroke-dasharray:6 4}.dia .models .t1{fill:var(--rs)}.dia .models .t2{fill:var(--ink2)}
.dia .data .box{fill:var(--rs-soft);stroke:var(--rs-line)}.dia .data .t1{fill:var(--ink)}.dia .data .t2{fill:var(--ink2)}
.dia .s3 .box{fill:var(--out-soft);stroke:var(--out)}.dia .s3 .t1{fill:var(--ink)}.dia .s3 .t2{fill:var(--ink2)}
.dia .tz .box{fill:var(--part-soft);stroke:var(--part)}.dia .tz .t1{fill:var(--ink)}.dia .tz .t2{fill:var(--ink2)}
.dia .obs .box{fill:var(--todo-soft);stroke:var(--todo)}.dia .obs .t1{fill:var(--ink)}.dia .obs .t2{fill:var(--ink2);font-size:12.5px}
.dia .ext .box{fill:var(--out-soft);stroke:var(--out)}.dia .ext .t1{fill:var(--ink)}.dia .ext .t2{fill:var(--ink2)}
.dia .ghost .box{fill:#fff;stroke:var(--red);stroke-dasharray:6 4}.dia .ghost .t1{fill:var(--red)}.dia .ghost .t2{fill:var(--ink2)}
.dia .ghostc .box{fill:#fff;stroke:var(--todo);stroke-dasharray:6 4}.dia .ghostc .t1{fill:var(--ink2)}.dia .ghostc .t2{fill:var(--mute)}
.dia .ghostx .box{fill:#fff;stroke:var(--out);stroke-dasharray:6 4}.dia .ghostx .t1{fill:var(--out)}.dia .ghostx .t2{fill:var(--mute)}
.dia .ghost .t1,.dia .ghostc .t1,.dia .ghostx .t1{font-size:13.5px}
.dia .alt{font:600 11px var(--mono);fill:var(--part-ink)}
.dia .n.off .box{fill:#fff;stroke:var(--line);stroke-dasharray:3 3}
.dia .n.off .t1,.dia .n.off .t2{fill:var(--mute)}
.dia .n.off .head{stroke:var(--mute)}
.dia .n.gone{display:none}
.dia .e.gone{display:none}
.dia .e.off path{stroke:var(--line)}
.dia .e path{fill:none;stroke:var(--edge);stroke-width:1.4}
.dia .e.dash path{stroke-dasharray:5 4}
.dia .el{font:600 11.5px var(--mono);fill:var(--ink2);paint-order:stroke;stroke:var(--ground);stroke-width:4px}
.dia.dim .n:not(.sel):not(.near){opacity:.35}.dia.dim .e:not(.hot){opacity:.2}
.dia .e.hot path{stroke:var(--rs);stroke-width:2.2}
.dia .n.sel .box{filter:drop-shadow(0 0 0 var(--rs)) drop-shadow(0 4px 10px rgba(59,79,168,.35))}
.legend{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--ink2);font-size:12.5px;padding:4px 16px 16px;border-top:1px solid var(--line2)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:3px;gap:2px}
.seg button{border:0;background:none;padding:6px 14px;border-radius:6px;font-weight:600;color:var(--mute)}
.seg button.on{background:var(--rs);color:#fff}
.pnote{color:var(--ink2);font-size:13px}
.card{padding:16px 18px;min-height:64px}
.card .sub{font:12px var(--mono);color:var(--mute);margin-top:2px}
.card p{margin:10px 0 0;color:var(--ink2)}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:12px 0 0;font-size:13px}
.card dt{color:var(--mute)}.card dd{margin:0}
.card .state{margin-top:12px;padding:8px 10px;border-radius:6px;background:var(--rs-soft);font-size:13px}
.card .hint{color:var(--mute);margin:0}

/* путь документа */
.flow{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:8px}
.flow li{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:12px 12px 14px;display:flex;flex-direction:column;gap:6px;position:relative}
.flow li:not(:last-child)::after{content:"";position:absolute;right:-7px;top:22px;width:6px;height:2px;background:var(--edge)}
.flow .st{display:flex;align-items:center;gap:8px}
.flow .num{font:700 12px var(--mono);color:#fff;background:var(--rs);border-radius:50%;width:22px;height:22px;display:grid;place-items:center;flex:none}
.flow .who{font:600 11px var(--mono);color:var(--rs);text-transform:uppercase;letter-spacing:.04em}
.flow b{font:700 14.5px var(--head)}
.flow p{margin:0;color:var(--ink2);font-size:12.5px;line-height:1.45}

/* таблицы */
table{border-collapse:collapse;width:100%;min-width:820px}
.runs th,.runs td{padding:10px 14px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top}
.runs thead th{font:700 14px var(--head);background:var(--band)}
.runs tbody th{font-weight:600;color:var(--ink2);white-space:nowrap}
.runs tr:last-child th,.runs tr:last-child td{border-bottom:0}
.pill{display:inline-block;font:600 11.5px var(--sans);padding:2px 8px;border-radius:999px;margin-right:4px}
.pill.ok{background:var(--done-soft);color:#1E6E49}.pill.wait{background:var(--part-soft);color:var(--part-ink)}

/* пробелы */
.gaps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.gaps .panel{padding:16px 18px}
.gaps h3{display:flex;align-items:center;gap:8px}
.gaps h3 i{width:10px;height:10px;border-radius:50%;display:inline-block}
.gl{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column}
.gl li{padding:9px 0;border-top:1px solid var(--line2)}
.gh{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.gh .mono{color:var(--mute)}
.gl p{margin:3px 0 0;color:var(--ink2);font-size:13px}

.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.two .panel{padding:16px 18px}
.contra,.next{margin:10px 0 0;padding-left:20px;display:flex;flex-direction:column;gap:10px}
.contra li p,.next li p{margin:2px 0 0;color:var(--ink2);font-size:13.5px}
details.panel{padding:0}
details summary{cursor:pointer;padding:14px 18px;font:700 15px var(--head)}
details .mm{overflow-x:auto;padding:0 14px 14px}
footer{color:var(--mute);font-size:12px}
@media (max-width:1180px){.flow{grid-template-columns:repeat(3,minmax(0,1fr))}.flow li::after{display:none}}
@media (max-width:900px){.summary{grid-template-columns:1fr}.gaps,.two{grid-template-columns:1fr}}
@media (max-width:520px){main{padding-inline:16px}.facts,.flow{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
${serviceNavCss}
</style></head>
<body>
<header>
  ${renderServiceNav()}
  <div class="h1row">
    <h1>Архитектура · Инспектор ИИ</h1>

  </div>
  ${renderServiceMetadata({status: "Архитектурная схема: целевой и локальные профили", note: "Профиль GPU описывает целевую конфигурацию; соответствие активному развёртыванию не подтверждено"})}
</header>
<main id="docs-service-content" tabindex="-1">
  <section class="panel summary" aria-labelledby="sh">
    <div>
      <div class="eyebrow">Коротко</div>
      <h2 id="sh">GPU — рабочий ML-контур; разработка и read-only демо</h2>
      <p><b>Основные сервисы — веб, API и ML.</b> В профиле GPU ML запускает PP-OCR на CUDA и вызывает PaddleOCR-VL и Qwen через vLLM; API хранит данные в локальном каталоге GPU-стенда. Public demo показывает опубликованные данные и не запускает разбор.</p>
      <p><b>Последняя живая проверка GPU-контура — аудит 28.09.2026 (T-184/T-185).</b> Конфигурация и проверки подтверждают RTX 4090, GPU OCR и vLLM на отдельном GPU-стенде. Это не означает, что отдельный deploy/gpu профиль уже развёрнут; снимок процессов от 29.09.2026 приведён ниже.</p>
      <p><b>Mac перестал быть машиной стенда и сборки.</b> После ADR-0009 на нём редактируют код; сборки, тесты и стенды веток идут на удалённом CPU-раннере. Пакет М-023 и его цифры ниже — исторический прогон прежнего Mac-стенда, не GPU-бенчмарк.</p>
    </div>
    <div class="facts">
      <div class="fact good"><b>6/6 · 1/1 · 24/24</b><span>М-023 на «Алтуфьево»: поля оракула · находки на сканах · судья VLM</span></div>
      <div class="fact"><b>57 за 25 мин</b><span>исторический прогон М-023 на прежнем Mac-стенде</span></div>
      <div class="fact"><b>RTX 4090</b><span>GPU-стенд по T-184/T-185; последнее живое подтверждение 28.09.2026</span></div>
      <div class="fact warn"><b>3 режима</b><span>GPU-стенд · инструменты разработки · read-only демо</span></div>
    </div>
  </section>

  <section class="panel" style="padding:16px"><b>Снимок работающего GPU-контура · 29.09.2026, 15:31 UTC</b><p>Проверка без изменений на сервере: web, API, PostgreSQL, RabbitMQ и Redis — healthy; vLLM reader запущен. Контейнер ML остановлен (exit 137), vLLM judge остановлен (exit 0). RTX 4090: 6 259 из 24 564 МиБ занято. Это снимок процессов, а не успешный сквозной прогон; конфигурация ниже описывает предусмотренный состав.</p></section>
  <section class="sec" aria-labelledby="ah">
    <div>
      <div class="eyebrow">Как устроено</div>
      <h2 id="ah">Слева направо — от человека к модели</h2>
      <p class="lead">Сплошные блоки — то, что есть в сборке. Пунктирные — то, чего нет: красный пунктир требует ТЗ, серый — решили сделать сами, синий — внешняя сторона, которую не к чему подключать. Переключатель показывает, что есть в каждом способе запуска; щелчок по блоку открывает описание.</p>
    </div>
    <div class="bar">
      <div class="seg" role="group" aria-label="Способ запуска">
        <button id="p-gpu" class="on" aria-pressed="true" data-p="gpu">GPU-стенд · RTX 4090</button>
        <button id="p-stand" aria-pressed="false" data-p="stand">Демо · только чтение</button>
        <button id="p-dev" aria-pressed="false" data-p="dev">Разработка · remote-run</button>
      </div>
      <span class="pnote" id="pnote">GPU-стенд nadzorium-gpu: RTX 4090, последний аудит 28.09.2026; снимок 29.09: ML и judge остановлены, reader запущен.</span>
    </div>
    <div class="stage">
      <div class="panel">
        <div class="scroll">${dia}</div>
        <div class="legend">
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#3B4FA8"/></svg>свой сервис</span>
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#FFF4DC" stroke="#E0A21A"/></svg>обвязка, которую требует ТЗ</span>
          <span><svg width="20" height="18"><path d="M1,4 a9,3 0 0 0 18,0 a9,3 0 0 0 -18,0 v10 a9,3 0 0 0 18,0 v-10" fill="#EAEDF8" stroke="#A9B2D8"/></svg>хранилище данных</span>
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#EEF0F5" stroke="#9097AD"/></svg>мониторинг и логи</span>
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#E8F0FF" stroke="#4B7BEC"/></svg>внешний сервис</span>
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#fff" stroke="#D6454A" stroke-dasharray="4 3"/></svg>требует ТЗ — нет</span>
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#fff" stroke="#9097AD" stroke-dasharray="4 3"/></svg>решение команды — нет</span>
          <span><svg width="26" height="16"><rect x="1" y="1" width="24" height="14" rx="3" fill="#fff" stroke="#4B7BEC" stroke-dasharray="4 3"/></svg>внешняя сторона — не подключена</span>
          <span><svg width="30" height="10"><path d="M1,5 H24" stroke="#7E84A3" stroke-width="1.5"/><path d="M22,1 L29,5 L22,9 z" fill="#7E84A3"/></svg>кто к кому обращается</span>
          <span><svg width="30" height="10"><path d="M1,5 H24" stroke="#7E84A3" stroke-width="1.5" stroke-dasharray="4 3"/><path d="M22,1 L29,5 L22,9 z" fill="#7E84A3"/></svg>чтение, служебный поток или недостроенная связь</span>
        </div>
      </div>
      <aside class="panel card" id="card" aria-live="polite"><p class="hint">Выберите блок на схеме.</p></aside>
    </div>
  </section>

  <section class="sec" aria-labelledby="fh">
    <div>
      <div class="eyebrow">Путь документа</div>
      <h2 id="fh">Что происходит с файлом от загрузки до протокола</h2>
    </div>
    <ol class="flow">${flow}</ol>
  </section>

  <section class="sec" aria-labelledby="rh">
    <div>
      <div class="eyebrow">Где запускается</div>
      <h2 id="rh">Три текущих контура и прежний Mac-стенд</h2>
      <p class="lead">Предметная логика общая (ADR-0001); различаются хранилище, очередь, каналы и обвязка.</p>
    </div>
    <div class="panel" style="overflow-x:auto">${runs}</div>
  </section>

  <section class="sec" aria-labelledby="gh">
    <div>
      <div class="eyebrow">Чего нет</div>
      <h2 id="gh">Что нужно достроить до полного ТЗ</h2>
    </div>
    <div class="gaps">
      <div class="panel"><h3><i style="background:var(--red)"></i>Требует ТЗ</h3>${gapList(GAPS.tz)}</div>
      <div class="panel"><h3><i style="background:var(--todo)"></i>Решения команды</h3>${gapList(GAPS.team)}</div>
      <div class="panel"><h3><i style="background:var(--out)"></i>Внешние стороны</h3>${gapList(GAPS.ext)}</div>
    </div>
  </section>

  <section class="two" aria-label="Противоречия и следующие шаги">
    <div class="panel"><div class="eyebrow">Расходится</div><h2>Что спорит друг с другом</h2>
      <ol class="contra">${CONTRA.map(([t, d]) => `<li><b>${esc(t)}.</b><p>${esc(d)}</p></li>`).join("")}</ol></div>
    <div class="panel"><div class="eyebrow">Дальше</div><h2>Следующие шаги по пользе</h2>
      <ol class="next">${NEXT.map(([t, d]) => `<li><b>${esc(t)}.</b><p>${esc(d)}</p></li>`).join("")}</ol></div>
  </section>




  <section class="sec" aria-labelledby="learning-flow"><h2 id="learning-flow">Дообучение: от разметки до версии модели</h2>
  <p><a href="https://nadzorium-gpu.almazrobots.ru/verification/">Верификация и разметка данных</a> — существующий этап подготовки обучающих данных. Наличие модуля отмечено по исходникам опубликованной ревизии df65e188; код не запускался.</p>
  <p><b>Верификация и разметка → выпуск набора → обучение → оценка качества → утверждение и публикация.</b></p>
  <div class="panel" style="overflow-x:auto"><table><thead><tr><th>Этап</th><th>Что существует</th><th>Основание</th></tr></thead><tbody>
  <tr><td>Разметка и проверка данных</td><td>Задания, ответы, комментарии, исправления, витрина и разбор спорных случаев.</td><td>T-244: services/verification-routes.ts, services/data-verification.ts, services/annotation-library.ts; verification-http.test.ts, data-verification.test.ts.</td></tr>
  <tr><td>Выпуск обучающего набора</td><td>T-244 выпускает annotation-dataset.v1 с версиями, хешем и разбиением по объектам/источникам. GOLD по решениям инспектора — отдельный существующий путь.</td><td>releaseAnnotationDataset; domain/gold.ts; экран «Модели и GOLD».</td></tr>
  <tr><td>Обучение</td><td>Ранжир кандидатов реализован. Дообучение весов VLM/LoRA — отдельный этап; его наличие не следует из наличия разметки.</td><td>services/retrain.ts::trainIteration, domain/retrain.ts; retrain-route.test.ts; T-100 / T-156.</td></tr>
  <tr><td>Оценка и выпуск модели</td><td>У ранжира есть метрики, ворота качества, реестр версий и процедура утверждения.</td><td>services/retrain.ts, domain/gold.ts::publicationGate, pages/Ml.tsx.</td></tr>
  </tbody></table></div>
  <p>Стрелки обозначают бизнес-процесс. Автоматическая передача нового набора T-244 в существующий тренер не подтверждена. Подготовка данных существует; весь процесс нельзя помечать «нет».</p></section>
  <footer>Собрано ${esc(today)} из scripts/arch-map.mjs (pnpm trace). Конфигурация: deploy/gpu-stand/compose.yml, deploy/gpu/compose.yml, deploy/demo, deploy/stand; решения: ADR-0001…0009. Последние живые свидетельства GPU-стенда: OWASP T-184/T-185 от 28.09.2026; снимок процессов 29.09 приведён на странице. Результаты М-023 — исторический CPU/Mac-прогон по docs/qa/M023-ALTUFYEVO-EVAL.md.</footer>
</main>
<script>
var D = ${json};
var svg = document.querySelector(".dia");
var card = document.getElementById("card");
var sel = null;
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function renderCard() {
  if (!sel) { card.innerHTML = '<p class="hint">Выберите блок на схеме.</p>'; return; }
  var n = D[sel], h = '<div class="eyebrow">' + esc(n.k) + '</div><h3>' + esc(n.title) + '</h3>';
  if (n.sub) h += '<div class="sub">' + esc(n.sub) + '</div>';
  h += '<p>' + esc(n.d) + '</p><dl>';
  if (n.tz) h += '<dt>Основание</dt><dd>' + esc(n.tz) + '</dd>';
  if (n.ram) h += '<dt>Память</dt><dd class="mono">' + esc(n.ram) + '</dd>';
  h += '</dl>';
  if (n.state) h += '<div class="state">' + esc(n.state) + '</div>';
  card.innerHTML = h;
}
function select(id) {
  sel = sel === id ? null : id;
  svg.classList.toggle("dim", !!sel);
  svg.querySelectorAll(".n").forEach(function (g) { g.classList.remove("sel", "near"); });
  svg.querySelectorAll(".e").forEach(function (e) {
    var hot = !!sel && (e.dataset.f === sel || e.dataset.t === sel);
    e.classList.toggle("hot", hot);
    if (hot) [e.dataset.f, e.dataset.t].forEach(function (x) { var g = svg.querySelector('[data-id="' + x + '"]'); if (g) g.classList.add("near"); });
  });
  if (sel) { var g = svg.querySelector('[data-id="' + sel + '"]'); if (g) g.classList.add("sel"); }
  renderCard();
}
var NOTE = { gpu: "GPU-стенд nadzorium-gpu (deploy/gpu-stand): RTX 4090, GPU OCR и два vLLM. Последняя живая проверка — T-184/T-185 от 28.09.2026; снимок 29.09: ML и judge остановлены, reader запущен.", stand: "Публичное демо nadzorium: опубликованный снимок, Object Storage для чтения блобов, API только для чтения. Новые проверки не запускаются.", dev: "Инструменты разработки: Mac — редактор, remote-run — сборки и тесты. Рабочий ML-инференс относится к GPU-стенду." };
function profile(p) {
  svg.querySelectorAll(".n").forEach(function (g) {
    var has = g.dataset.in.split(" ").indexOf(p) >= 0, ghost = /ghost/.test(g.getAttribute("class"));
    g.classList.toggle("gone", ghost && p !== "gpu");
    g.classList.toggle("off", !has && !ghost);
    var alt = g.querySelector(".alt");
    if (alt) alt.textContent = has ? "" : (g.dataset["alt" + p.charAt(0).toUpperCase() + p.slice(1)] || "");
  });
  svg.querySelectorAll(".e").forEach(function (e) {
    var f = svg.querySelector('[data-id="' + e.dataset.f + '"]'), t = svg.querySelector('[data-id="' + e.dataset.t + '"]');
    e.classList.toggle("gone", f.classList.contains("gone") || t.classList.contains("gone"));
    e.classList.toggle("off", f.classList.contains("off") || t.classList.contains("off"));
  });
  document.querySelectorAll(".seg button").forEach(function (b) { var on = b.dataset.p === p; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  document.getElementById("pnote").textContent = NOTE[p];
}
document.querySelectorAll(".seg button").forEach(function (b) { b.onclick = function () { profile(b.dataset.p); }; });
profile("gpu");
svg.addEventListener("click", function (ev) { var g = ev.target.closest("[data-id]"); if (g) select(g.dataset.id); });
svg.addEventListener("keydown", function (ev) { if ((ev.key === "Enter" || ev.key === " ") && ev.target.dataset.id) { ev.preventDefault(); select(ev.target.dataset.id); } });
document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && sel) select(sel); });
</script>
</body></html>
`;
}
