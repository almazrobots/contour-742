// Конфигурация с громкой проверкой при старте (qa-standard L7): неверное окружение — падение, а не тихий дефолт.
import { parseTrustProxy } from "./domain/trust-proxy.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEncryptionKey } from "./domain/blob-crypto.ts";
import { isTmpfsAt, makeKeyring, parseKeyList, type AtRestKeyring } from "./domain/at-rest.ts";
import { DEFAULT_DB_TIMEOUTS, requireDbTls, validateDbTimeouts, type DbTimeouts } from "./domain/db-core.ts";
import { resolveUkep } from "./domain/request-signing.ts";
import { pdnLocalizationError } from "./domain/pdn.ts";

// Корень репозитория — ближайший вверх каталог с pnpm-workspace.yaml. Не «три уровня вверх»: песочница Stryker
// (apps/api/.stryker-tmp/sandbox-*/src) глубже исходников, и data/seed там не найти.
function findRoot(from: string): string {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, "pnpm-workspace.yaml"))) return d;
    if (dirname(d) === d) return resolve(from, "../../.."); // вне репозитория — прежнее правило
  }
}
const root = process.env.INSPECTOR_ROOT?.trim() || findRoot(dirname(fileURLToPath(import.meta.url)));

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

// Точка входа процесса: api (server.ts) или migrate (migrate.ts, служба api-migrate). Метку ставит entry-migrate.ts
// до импорта конфигурации; из окружения её не задать. Службе миграций не нужны очередь, TLS API и «РиН» — их секреты
// ей не выдаются (наименьшие привилегии), поэтому проверки этих параметров — только для api.
const entry: "api" | "migrate" = (globalThis as Record<symbol, unknown>)[Symbol.for("inspector.entry")] === "migrate" ? "migrate" : "api";

// HIGH-4: пароль демо-учёток нужен только сиду dev. Вычисляется лениво при первом обращении; в gpu обращение — ошибка,
// файл var/demo-password.txt там не создаётся и не читается.
/** Целое из окружения в пределах [lo, hi]; не задано — по умолчанию; мусор — отказ при старте, а не тихий дефолт. */
function intEnv(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : fallback;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name}=${raw}: ждём целое ${lo}–${hi}`);
  return n;
}

function demoPasswordFile(): string {
  const file = join(root, "var/demo-password.txt");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const pw = randomBytes(9).toString("base64url");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pw + "\n", { mode: 0o600 });
  return pw;
}

const profile = env("INSPECTOR_PROFILE", "dev");
// NFR-TLS-INTERNAL (ТЗ 1.3, T-129): внутри контура открытого текста нет — в профиле gpu и на стенде (INSPECTOR_INTERNAL_TLS=required)
// ML только по https; CA внутренних сертификатов — через NODE_EXTRA_CA_CERTS (штатный механизм Node, без отключения проверки)
const internalTls = env("INSPECTOR_INTERNAL_TLS", profile === "gpu" ? "required" : "optional");
if (internalTls !== "required" && internalTls !== "optional") throw new Error(`INSPECTOR_INTERNAL_TLS=${internalTls}: ждём required или optional`);
const mlUrl = env("INSPECTOR_ML_URL", "http://127.0.0.1:8811");
if (internalTls === "required" && !mlUrl.startsWith("https://")) throw new Error(`INSPECTOR_ML_URL=${mlUrl}: при INSPECTOR_INTERNAL_TLS=required ML доступен только по https (NFR-TLS-INTERNAL)`);
if (profile !== "dev" && profile !== "gpu") throw new Error(`INSPECTOR_PROFILE=${profile}: ждём dev или gpu (ADR-0001)`);

// NFR-AV: в профиле gpu антивирус обязателен; в dev ClamAV нет — проверка выключена явно, а не молча
const avMode = env("INSPECTOR_AV", profile === "gpu" ? "clamd" : "off");
if (avMode !== "off" && avMode !== "clamd") throw new Error(`INSPECTOR_AV=${avMode}: ждём off или clamd`);
if (profile === "gpu" && avMode !== "clamd") throw new Error("INSPECTOR_AV=off недопустим в профиле gpu: файлы обязаны проходить антивирус (ТЗ 12.11)");

// ТЗ 1.5, ADR-0001: очередь разбора — RabbitMQ в профиле gpu, в процессе — в dev
const queueMode = env("INSPECTOR_QUEUE", profile === "gpu" ? "amqp" : "inproc");
if (queueMode !== "inproc" && queueMode !== "amqp") throw new Error(`INSPECTOR_QUEUE=${queueMode}: ждём inproc или amqp`);
if (profile === "gpu" && queueMode !== "amqp") throw new Error("INSPECTOR_QUEUE=inproc недопустим в профиле gpu: модули связаны через RabbitMQ (ТЗ 1.5)");
// SEC-07 (OWASP-аудит T-129): пароль брокера — файлом-секретом (INSPECTOR_AMQP_PASSWORD_FILE), а не в адресе в окружении
const amqpUrl = withAmqpPassword(process.env.INSPECTOR_AMQP_URL?.trim() || null, secretFile("INSPECTOR_AMQP_PASSWORD_FILE"));
if (entry === "api" && queueMode === "amqp" && !amqpUrl) throw new Error("INSPECTOR_QUEUE=amqp требует INSPECTOR_AMQP_URL (amqp://…)");
if (internalTls === "required" && amqpUrl && !amqpUrl.startsWith("amqps://")) throw new Error("INSPECTOR_AMQP_URL: при INSPECTOR_INTERNAL_TLS=required очередь только по amqps:// (NFR-TLS-INTERNAL)");

// NFR-TLS (ТЗ 1.3, 12.3): в эксплуатационном контуре API доступен только по HTTPS (TLS 1.3). TLS терминирует
// сам API, без прокси: пути к PEM-файлам сертификата и ключа. В dev по умолчанию HTTP.
const tlsCert = process.env.INSPECTOR_TLS_CERT?.trim() || null;
const tlsKey = process.env.INSPECTOR_TLS_KEY?.trim() || null;
if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error("INSPECTOR_TLS_CERT и INSPECTOR_TLS_KEY задаются только вместе: сертификат без ключа (или ключ без сертификата) не поднимет HTTPS");
if (entry === "api" && profile === "gpu" && !tlsCert) throw new Error("профиль gpu требует INSPECTOR_TLS_CERT и INSPECTOR_TLS_KEY: API доступен только по HTTPS, TLS 1.3 (ТЗ 12.3)");

// OS-INSP-1.2.12: доверенные корни проверки электронной подписи — каталоги PEM/DER. Все доверенные (УНЭП)
// и аккредитованные УЦ (УКЭП, тоже доверенные). Не заданы — VALID недостижим (UNVERIFIED «нет доверенного корня»);
// задан несуществующий каталог — отказ старта, а не тихое «никому не доверяем».
const trustDir = process.env.INSPECTOR_TRUST_DIR?.trim() || null;
const qualifiedRootsDir = process.env.INSPECTOR_QUALIFIED_ROOTS_DIR?.trim() || null;
for (const [k, d] of [["INSPECTOR_TRUST_DIR", trustDir], ["INSPECTOR_QUALIFIED_ROOTS_DIR", qualifiedRootsDir]] as const) {
  if (d && !existsSync(d)) throw new Error(`${k}=${d}: каталог доверенных сертификатов не найден`);
}

// ADR-0003 (T-107): адрес базы. Пароль сервера — отдельным файлом-секретом (Compose secrets), не в переменной окружения:
// INSPECTOR_DATABASE_PASSWORD_FILE подставляется в postgres://user@host/db как пароль.
function databaseUrlFromEnv(): string {
  if (process.env.INSPECTOR_DB?.trim()) throw new Error("INSPECTOR_DB (путь SQLite) упразднён ADR-0003: задайте INSPECTOR_DATABASE_URL=postgres://… | pglite:<каталог> | memory");
  const url = env("INSPECTOR_DATABASE_URL", profile === "gpu" ? "" : "pglite:var/pgdata");
  const pwFile = process.env.INSPECTOR_DATABASE_PASSWORD_FILE?.trim();
  if (!pwFile) return url;
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("INSPECTOR_DATABASE_PASSWORD_FILE задан, а INSPECTOR_DATABASE_URL — не postgres://");
  if (!existsSync(pwFile)) throw new Error(`INSPECTOR_DATABASE_PASSWORD_FILE=${pwFile}: файл не найден`);
  const u = new URL(url);
  u.password = encodeURIComponent(readFileSync(pwFile, "utf8").trim());
  return u.toString();
}
const databaseUrl = databaseUrlFromEnv();

// M-1: TLS до сервера PostgreSQL — корень доверия (PEM). В gpu обязателен: без него отказ старта (verify-full).
function databaseCaFromEnv(): string | null {
  const caFile = process.env.INSPECTOR_DATABASE_SSL_CA_FILE?.trim() || null;
  // Разбор адреса целиком и отказ «gpu без сервера» — в openDb (resolveDbTarget); здесь достаточно схемы адреса
  const kind = /^postgres(ql)?:\/\//.test(databaseUrl) ? "postgres" : "pglite-dir"; // пустой адрес — отказ в openDb
  requireDbTls(profile as "dev" | "gpu", kind, caFile);
  if (!caFile) return null;
  if (!existsSync(caFile)) throw new Error(`INSPECTOR_DATABASE_SSL_CA_FILE=${caFile}: файл не найден`);
  const pem = readFileSync(caFile, "utf8");
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error(`INSPECTOR_DATABASE_SSL_CA_FILE=${caFile}: не PEM-сертификат`);
  return pem;
}
const databaseCaPem = databaseCaFromEnv();

// M-2: таймауты пула и сессии. Значения — миллисекунды; не целое ≥ 1 — отказ старта.
const msEnv = (name: string, fallback: number) => Number(env(name, String(fallback)));
const databaseTimeouts: DbTimeouts = validateDbTimeouts({
  connectMs: msEnv("INSPECTOR_DATABASE_CONNECT_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.connectMs),
  idleMs: msEnv("INSPECTOR_DATABASE_IDLE_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.idleMs),
  statementMs: msEnv("INSPECTOR_DATABASE_STATEMENT_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.statementMs),
  idleInTxMs: msEnv("INSPECTOR_DATABASE_IDLE_IN_TX_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.idleInTxMs),
  lockMs: msEnv("INSPECTOR_DATABASE_LOCK_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.lockMs),
});

// HIGH-4: первый администратор в эксплуатации — служба миграций из файла-секрета (читается, только если users пуст)
const bootstrapAdminLogin = env("INSPECTOR_BOOTSTRAP_ADMIN_LOGIN", "admin");
const bootstrapAdminPasswordFile = process.env.INSPECTOR_BOOTSTRAP_ADMIN_PASSWORD_FILE?.trim() || null;

const databasePoolMax = Number(env("INSPECTOR_DATABASE_POOL_MAX", "10"));
if (!Number.isInteger(databasePoolMax) || databasePoolMax < 1) throw new Error(`INSPECTOR_DATABASE_POOL_MAX=${process.env.INSPECTOR_DATABASE_POOL_MAX}: ждём целое ≥ 1`);

const port = Number(env("PORT", "8810"));
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT=${process.env.PORT}: не порт`);

// OS-INSP-1.2.28–1.2.30, NFR-OBJSTORE (ADR-0004, ADR-0006): хранилище файлов. fs — каталог INSPECTOR_BLOB_DIR;
// s3 — тот же каталог как кэш плюс зашифрованная копия в S3-совместимом бакете. Провайдер — только адрес и регион.
// Секреты — файлами (*_FILE, приоритетнее) или AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY для локального запуска;
// содержимое секретов в сообщения не попадает, а в объекте конфигурации ключи неперечислимы (не уходят в JSON и логи).
export type BlobStoreConfig =
  | { kind: "fs" }
  | { kind: "s3"; endpoint: string; region: string; bucket: string; prefix: string; forcePathStyle: boolean; credentials: { accessKeyId: string; secretAccessKey: string }; key: Buffer; requestTimeoutMs: number; proxy?: string | null; readPrefixes?: string[] };

/** Подставить пароль из файла в адрес брокера. Пароль и в адресе, и в файле — ошибка конфигурации (какой из них верный?). */
export function withAmqpPassword(url: string | null, password: string | null): string | null {
  if (!url || !password) return url;
  const u = new URL(url);
  if (u.password) throw new Error("INSPECTOR_AMQP_URL уже содержит пароль, а задан и INSPECTOR_AMQP_PASSWORD_FILE: оставьте один (лучше файл)");
  if (!u.username) throw new Error("INSPECTOR_AMQP_URL: при INSPECTOR_AMQP_PASSWORD_FILE в адресе нужен пользователь (amqps://user@host)");
  u.password = password;
  return u.toString().replace(/\/$/, "");
}

function secretFile(name: string): string | null {
  const file = process.env[name]?.trim();
  if (!file) return null;
  if (!existsSync(file)) throw new Error(`${name}=${file}: файл не найден`);
  const v = readFileSync(file, "utf8").trim();
  if (!v) throw new Error(`${name}=${file}: файл пуст`);
  return v;
}

// NFR-PDN (ТЗ 12.6-01, 152-ФЗ): сроки обезличивания (ст. 21 ч. 7) и хосты S3 в РФ сверх Yandex Object Storage (ст. 18 ч. 5)
const pdnDays = (name: string, def: number, min = 1): number => {
  const raw = process.env[name]?.trim() || String(def);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name}=${raw}: ждём целое число дней ≥ ${min}`);
  return n;
};
const pdn = {
  userDays: pdnDays("INSPECTOR_PDN_USER_DAYS", 30),
  auditDays: pdnDays("INSPECTOR_PDN_AUDIT_DAYS", 365, 90), // ТЗ 12.5: журнал — не меньше 90 дней; функция БД моложе не примет
  ruEndpoints: (process.env.INSPECTOR_PDN_RU_ENDPOINTS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
};

function blobStoreFromEnv(): BlobStoreConfig {
  const kind = env("INSPECTOR_BLOB_STORE", "fs");
  if (kind === "fs") return { kind };
  if (kind !== "s3") throw new Error(`INSPECTOR_BLOB_STORE=${kind}: ждём fs или s3`);
  const req = (name: string) => {
    const v = process.env[name]?.trim();
    if (!v) throw new Error(`INSPECTOR_BLOB_STORE=s3 требует ${name}`);
    return v;
  };
  const endpoint = req("INSPECTOR_S3_ENDPOINT");
  if (!/^https?:\/\/[^/\s]+/.test(endpoint)) throw new Error(`INSPECTOR_S3_ENDPOINT=${endpoint}: ждём http(s)://хост[:порт]`);
  // SEC-09: при обязательном TLS хранилище — только https (шифротекст AES-GCM не отменяет утечку ключа доступа S3)
  if (internalTls === "required" && !endpoint.startsWith("https://")) throw new Error(`INSPECTOR_S3_ENDPOINT=${endpoint}: при INSPECTOR_INTERNAL_TLS=required хранилище только по https:// (NFR-TLS-INTERNAL)`);
  const region = req("INSPECTOR_S3_REGION");
  // NFR-PDN (152-ФЗ ст. 18 ч. 5): в профиле gpu файлы проверок (ПДн застройщика, подписи) хранятся только в РФ
  const outsideRu = profile === "gpu" ? pdnLocalizationError(endpoint, region, pdn.ruEndpoints) : null;
  if (outsideRu) throw new Error(outsideRu);
  const bucket = req("INSPECTOR_S3_BUCKET");
  const prefix = env("INSPECTOR_S3_PREFIX", "blobs/");
  // T-131: демо-стенд читает проверки, опубликованные со стендов мака под разными префиксами
  const readPrefixes = (process.env.INSPECTOR_S3_READ_PREFIXES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const pathStyle = env("INSPECTOR_S3_FORCE_PATH_STYLE", "false");
  if (pathStyle !== "true" && pathStyle !== "false") throw new Error(`INSPECTOR_S3_FORCE_PATH_STYLE=${pathStyle}: ждём true или false`);
  const accessKeyId = secretFile("INSPECTOR_S3_ACCESS_KEY_ID_FILE") ?? process.env.AWS_ACCESS_KEY_ID?.trim();
  if (!accessKeyId) throw new Error("INSPECTOR_BLOB_STORE=s3 требует INSPECTOR_S3_ACCESS_KEY_ID_FILE (или AWS_ACCESS_KEY_ID)");
  const secretAccessKey = secretFile("INSPECTOR_S3_SECRET_ACCESS_KEY_FILE") ?? process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!secretAccessKey) throw new Error("INSPECTOR_BLOB_STORE=s3 требует INSPECTOR_S3_SECRET_ACCESS_KEY_FILE (или AWS_SECRET_ACCESS_KEY)");
  const keyFile = req("INSPECTOR_S3_KEY_FILE");
  if (!existsSync(keyFile)) throw new Error(`INSPECTOR_S3_KEY_FILE=${keyFile}: файл ключа шифрования не найден`);
  let key: Buffer;
  try {
    key = parseEncryptionKey(readFileSync(keyFile, "utf8"));
  } catch (e) {
    throw new Error(`INSPECTOR_S3_KEY_FILE=${keyFile}: ${(e as Error).message}`);
  }
  const requestTimeoutMs = Number(process.env.INSPECTOR_S3_TIMEOUT_MS?.trim() || "900000");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) throw new Error(`INSPECTOR_S3_TIMEOUT_MS=${process.env.INSPECTOR_S3_TIMEOUT_MS}: ждём целое число миллисекунд ≥ 1000`);
  const c = { kind: "s3" as const, endpoint, region, bucket, prefix, forcePathStyle: pathStyle === "true", requestTimeoutMs, proxy: process.env.INSPECTOR_S3_PROXY?.trim() || null, readPrefixes } as Extract<BlobStoreConfig, { kind: "s3" }>;
  Object.defineProperty(c, "credentials", { value: { accessKeyId, secretAccessKey }, enumerable: false });
  Object.defineProperty(c, "key", { value: key, enumerable: false });
  return c;
}
const blobStore = blobStoreFromEnv();

// NFR-CRYPTO (ТЗ 12.3-01): файлы пакета на диске (каталог fs и кэш tiered) — IBE1, AES-256-GCM с key_id (domain/at-rest.ts).
// INSPECTOR_BLOB_KEY_FILE — ключ записи; INSPECTOR_BLOB_OLD_KEYS_FILE — ключи до ротации, по строке, только чтение.
// ML читает открытый текст из INSPECTOR_BLOB_WORK_DIR — в профиле gpu это обязательно tmpfs (в памяти, не на диске).
// Профиль gpu без ключа не стартует (fail-closed); в dev ключ необязателен.
export interface BlobAtRestConfig {
  keyring: AtRestKeyring | null;
  workDir: string | null;
  workMaxBytes: number;
}
function blobAtRestFromEnv(): BlobAtRestConfig {
  const keyFile = process.env.INSPECTOR_BLOB_KEY_FILE?.trim() || null;
  const oldFile = process.env.INSPECTOR_BLOB_OLD_KEYS_FILE?.trim() || null;
  const workMb = Number(env("INSPECTOR_BLOB_WORK_MAX_MB", "1024"));
  if (!Number.isInteger(workMb) || workMb < 64) throw new Error(`INSPECTOR_BLOB_WORK_MAX_MB=${process.env.INSPECTOR_BLOB_WORK_MAX_MB}: ждём целое число МБ ≥ 64`);
  const workMaxBytes = workMb * 1024 * 1024;
  if (!keyFile) {
    if (oldFile) throw new Error("INSPECTOR_BLOB_OLD_KEYS_FILE задан без INSPECTOR_BLOB_KEY_FILE: старые ключи читаются только при текущем");
    if (entry === "api" && profile === "gpu") throw new Error("профиль gpu требует INSPECTOR_BLOB_KEY_FILE: файлы пакетов на диске хранятся только зашифрованными (ТЗ 12.3, NFR-CRYPTO)");
    return { keyring: null, workDir: null, workMaxBytes };
  }
  const readKey = (name: string, file: string, parse: (t: string) => Buffer[]): Buffer[] => {
    if (!existsSync(file)) throw new Error(`${name}=${file}: файл ключа не найден`);
    try {
      return parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${name}=${file}: ${(e as Error).message}`);
    }
  };
  const [current] = readKey("INSPECTOR_BLOB_KEY_FILE", keyFile, (t) => [parseEncryptionKey(t)]);
  const old = oldFile ? readKey("INSPECTOR_BLOB_OLD_KEYS_FILE", oldFile, parseKeyList) : [];
  const workDir = process.env.INSPECTOR_BLOB_WORK_DIR?.trim() || (profile === "gpu" ? "" : join(root, "var/blob-work"));
  if (!workDir) throw new Error("профиль gpu с INSPECTOR_BLOB_KEY_FILE требует INSPECTOR_BLOB_WORK_DIR — каталог tmpfs, откуда ML читает открытый текст");
  // в контейнере Linux: рабочий каталог обязан быть в памяти, иначе открытый текст лёг бы на диск в обход шифрования
  if (profile === "gpu" && existsSync("/proc/self/mounts") && !isTmpfsAt(readFileSync("/proc/self/mounts", "utf8"), resolve(workDir))) {
    throw new Error(`INSPECTOR_BLOB_WORK_DIR=${workDir}: не tmpfs — открытый текст для ML лёг бы на диск (NFR-CRYPTO)`);
  }
  const c = { workDir, workMaxBytes } as BlobAtRestConfig;
  Object.defineProperty(c, "keyring", { value: makeKeyring(current, old), enumerable: false });
  return c;
}
const blobAtRest = blobAtRestFromEnv();

let demoPw: string | null = null;

// T-131: демо-стенд только для просмотра — изменяющие запросы отклоняются, вход гостевой (NFR-DEMO-READONLY)
const readonlyRaw = env("INSPECTOR_READONLY", "0");
if (readonlyRaw !== "0" && readonlyRaw !== "1") throw new Error(`INSPECTOR_READONLY=${readonlyRaw}: ждём 0 или 1`);

// ─────────────────────────────── NFR-IDS (ТЗ 12.9, T-138): защита от DDoS и обнаружение атак на рубеже API.
// Адрес клиента за прокси — config.trustProxy (T-131, domain/trust-proxy.ts, INSPECTOR_TRUST_PROXY).
const idsMode = env("INSPECTOR_IDS", profile === "gpu" ? "on" : "off");
if (idsMode !== "on" && idsMode !== "off") throw new Error(`INSPECTOR_IDS=${idsMode}: ждём on или off`);
const idsNum = (name: string, def: string, min: number) => {
  const n = Number(env(name, def));
  if (!Number.isFinite(n) || n < min) throw new Error(`${name}=${process.env[name]}: ждём число ≥ ${min}`);
  return n;
};
const ids = {
  enabled: idsMode === "on",
  rps: idsNum("INSPECTOR_IDS_RPS", "20", 1),
  burst: idsNum("INSPECTOR_IDS_BURST", "100", 1),
  // никогда не ограничиваются и не блокируются: проверки живости и служебные инструменты изнутри контейнера
  allow: new Set(env("INSPECTOR_IDS_ALLOW", "127.0.0.1,::1,::ffff:127.0.0.1").split(",").map((x) => x.trim()).filter(Boolean)),
};

export const config = {
  ids,
  readonly: readonlyRaw === "1",
  // гость демо-стенда входит под этой учёткой (права ограничены режимом только чтения)
  guestLogin: env("INSPECTOR_GUEST_LOGIN", ""), // T-131: без явной учётки гостя входа нет
  trustProxy: parseTrustProxy(process.env.INSPECTOR_TRUST_PROXY), // T-131 (OWASP E1-H1): адрес клиента за своими прокси
  root,
  profile,
  entry,
  port,
  host: env("HOST", "127.0.0.1"),
  // ADR-0003: PostgreSQL во всех профилях. dev — PGlite в каталоге var/pgdata; gpu — только сервер (проверка в domain/db-core.ts)
  databaseUrl,
  databasePoolMax,
  databaseCaPem,
  databaseTimeouts,
  bootstrapAdmin: { login: bootstrapAdminLogin, passwordFile: bootstrapAdminPasswordFile },
  blobDir: env("INSPECTOR_BLOB_DIR", join(root, "var/blobs")),
  // ADR-0006: fs | s3 (кэш blobDir + бакет); реализация — services/blobstore.ts
  blobStore,
  // NFR-CRYPTO: связка ключей хранения (неперечислима) и рабочий каталог ML в tmpfs
  blobAtRest,
  mlUrl,
  // ожидание готовности ML при его недоступности перед повтором разбора (INSPECTOR_ML_WAIT_MS, по умолчанию 5 мин)
  mlWaitMs: Number(process.env.INSPECTOR_ML_WAIT_MS?.trim() || "300000"),
  parseConcurrency: (() => {
    const n = Number(process.env.INSPECTOR_PARSE_CONCURRENCY?.trim() || "2");
    if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`INSPECTOR_PARSE_CONCURRENCY=${process.env.INSPECTOR_PARSE_CONCURRENCY}: ждём целое 1–16`);
    return n;
  })(),
  // T-233: PDF больше стольких страниц разбирается частями по столько же на разных процессах ML (0 — целиком, как раньше)
  parseChunkPages: intEnv("INSPECTOR_PARSE_CHUNK_PAGES", 0, 0, 10_000),
  pipelineRoute: (() => {
    const route = env("INSPECTOR_PIPELINE_ROUTE", "legacy");
    if (route !== "legacy" && route !== "staged-v1") throw new Error("INSPECTOR_PIPELINE_ROUTE: ждём legacy или staged-v1");
    return route;
  })(),
  pipelinePolicy: (() => {
    const policy = env("INSPECTOR_PIPELINE_POLICY", "legacy-compatible-v1");
    if (policy !== "legacy-compatible-v1" && policy !== "regional-v1") throw new Error("INSPECTOR_PIPELINE_POLICY: unsupported policy");
    return policy;
  })(),
  pipelineExecution: (() => {
    const mode = env("INSPECTOR_PIPELINE_EXECUTION", "inline");
    if (mode !== "inline" && mode !== "durable") throw new Error("INSPECTOR_PIPELINE_EXECUTION: ждём inline или durable");
    if (mode === "durable" && env("INSPECTOR_PIPELINE_ROUTE", "legacy") !== "staged-v1") {
      throw new Error("durable execution требует INSPECTOR_PIPELINE_ROUTE=staged-v1");
    }
    return mode;
  })(),
  // частей одного тома одновременно — не больше числа процессов ML (INSPECTOR_ML_WORKERS)
  parsePartConcurrency: intEnv("INSPECTOR_PARSE_PART_CONCURRENCY", 4, 1, 16),
  internalTls,
  mlTimeoutMs: Number(env("INSPECTOR_ML_TIMEOUT_MS", "120000")),
  rinUrl: env("INSPECTOR_RIN_URL", "http://127.0.0.1:8810/mock-rin"),
  // Задержки повторной отправки в ИАИС «РиН»: 1, 5, 15 минут (ТЗ 9.6). Множитель ускоряет демо и тесты.
  rinBackoffMin: [1, 5, 15],
  rinBackoffScale: Number(env("INSPECTOR_RIN_BACKOFF_SCALE", "1")),
  // Пароль демо-учёток (только dev): из окружения, иначе случайный, сохранённый в var/demo-password.txt (вне git)
  get demoPassword(): string {
    if (profile !== "dev") throw new Error("демо-учётки есть только в профиле dev (HIGH-4): в gpu демо-пароля нет");
    return (demoPw ??= process.env.INSPECTOR_DEMO_PASSWORD?.trim() || demoPasswordFile());
  },
  rinMock: env("INSPECTOR_RIN_MOCK", "1") === "1",
  sessionHours: 12,
  queueMode,
  amqpUrl,
  avMode,
  clamdHost: env("INSPECTOR_CLAMD_HOST", "127.0.0.1"),
  clamdPort: Number(env("INSPECTOR_CLAMD_PORT", "3310")),
  // NFR-TLS: null — HTTP (только dev); иначе пути к PEM, опции https собирает services/tls.ts
  tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null,
  // OS-INSP-1.2.12: корни проверки подписи (services/signature.ts); null — каталог не задан
  trustDir,
  qualifiedRootsDir,
  // NFR-PDN: сроки обезличивания — services/pdn.ts (задача раз в сутки)
  pdn,
};

// ─────────────────────────────── OS-INSP-1.2.15–1.2.19: автозабор пакетов из ИАИС «РиН» (T-069)
// В профиле gpu опрос включён, в dev — выключен явно (заглушка «РиН» отдаёт синтетику по запросу).
const rinPullMode = env("INSPECTOR_RIN_PULL", profile === "gpu" ? "on" : "off");
if (rinPullMode !== "off" && rinPullMode !== "on") throw new Error(`INSPECTOR_RIN_PULL=${rinPullMode}: ждём off или on`);
const rinPullSec = Number(env("INSPECTOR_RIN_PULL_SEC", "300"));
if (!Number.isInteger(rinPullSec) || rinPullSec < 1) throw new Error(`INSPECTOR_RIN_PULL_SEC=${process.env.INSPECTOR_RIN_PULL_SEC}: ждём целое число секунд ≥ 1`);
const rinPullTimeoutMs = Number(env("INSPECTOR_RIN_PULL_TIMEOUT_MS", "30000"));
if (!Number.isInteger(rinPullTimeoutMs) || rinPullTimeoutMs < 1) throw new Error(`INSPECTOR_RIN_PULL_TIMEOUT_MS=${process.env.INSPECTOR_RIN_PULL_TIMEOUT_MS}: ждём целое число миллисекунд ≥ 1`);

// OS-INSP-1.2.15: в профиле gpu автозабор ходит в настоящую «РиН» — адрес по умолчанию (заглушка на себе) недопустим
if (entry === "api" && profile === "gpu" && rinPullMode === "on" && !process.env.INSPECTOR_RIN_URL?.trim()) throw new Error("INSPECTOR_RIN_PULL=on в профиле gpu требует INSPECTOR_RIN_URL: без адреса «РиН» автозабор не работает");
export const rinPull = { on: rinPullMode === "on", intervalSec: rinPullSec, timeoutMs: rinPullTimeoutMs };

// ─────────────────────────────── NFR-UKEP (ТЗ 12.10, TZA-12.10-01): запросы к ИАИС «РиН» подписываются УКЭП
// В профиле gpu с настоящей «РиН» (INSPECTOR_RIN_MOCK=0) режим off и RSA/ECDSA (pem) — отказ старта (fail-closed); в dev — off.
// Ключ и сертификаты — только файлами (*_FILE): отсутствующий файл — отказ старта, а не ошибка при первой отправке.
const ukep = entry === "api" ? resolveUkep(process.env, { profile, mock: config.rinMock }) : ({ mode: "off" } as const);
if (ukep.mode === "pem" || ukep.mode === "openssl-gost") {
  for (const [k, f] of [["INSPECTOR_UKEP_CERT_FILE", ukep.certFile], ["INSPECTOR_UKEP_KEY_FILE", ukep.keyFile], ["INSPECTOR_UKEP_CHAIN_FILE", ukep.mode === "pem" ? ukep.chainFile : null]] as const) {
    if (f && !existsSync(f)) throw new Error(`${k}=${f}: файл не найден (NFR-UKEP)`);
  }
}
export const ukepMode = ukep.mode;
/** Для /health и журнала старта: квалифицированная подпись — только сертифицированное СКЗИ (КриптоПро); gost-engine и
 *  тестовый ключ pem — неквалифицированный коннектор (решение владельца 27.09, OWASP T-137 E2-M4 — принятый риск). */
export const ukepInfo = { mode: ukep.mode, qualified: ukep.mode === "cryptopro" };

// ─────────────────────────────── NFR-METRICS-STORE (ТЗ §10 п. 13): снимок метрик в monitoring_metrics (T-101)
// Период снимка в секундах; 0 — сэмплер выключен (снимок пишется только явным вызовом tick).
const metricsSec = Number(env("INSPECTOR_METRICS_SNAPSHOT_SEC", "60"));
if (!Number.isInteger(metricsSec) || metricsSec < 0) throw new Error(`INSPECTOR_METRICS_SNAPSHOT_SEC=${process.env.INSPECTOR_METRICS_SNAPSHOT_SEC}: ждём целое число секунд ≥ 0`);
export const monitoring = { snapshotSec: metricsSec };
