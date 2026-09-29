// Слой данных (ADR-0003, T-107): чистые правила — куда подключаться, какие миграции применить, как читать типы
// PostgreSQL. IO — в src/db.ts (адаптеры pg и PGlite). Один движок во всех профилях: PostgreSQL.
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type Profile = "dev" | "gpu";

// ─────────────────────────────── адрес базы

export type DbTarget =
  | { kind: "pglite-memory" }
  | { kind: "pglite-dir"; dir: string }
  | { kind: "postgres"; url: string; schema: string | null };

/**
 * Адрес базы → цель подключения. `memory` (и `:memory:`) — PGlite в памяти; `pglite:<каталог>` — PGlite на диске;
 * `postgres://` или `postgresql://` — сервер PostgreSQL, `?schema=имя` задаёт search_path.
 * Профиль gpu (эксплуатация) принимает только сервер PostgreSQL: встроенная база там — отказ старта, а не тихий фолбэк.
 */
export function resolveDbTarget(url: string, profile: "dev" | "gpu"): DbTarget {
  const u = url.trim();
  if (!u) throw new Error("INSPECTOR_DATABASE_URL пуст: ждём postgres://…, pglite:<каталог> или memory");
  let t: DbTarget;
  if (u === "memory" || u === ":memory:") t = { kind: "pglite-memory" };
  else if (u.startsWith("pglite:")) {
    const dir = u.slice("pglite:".length);
    if (!dir) throw new Error("pglite: без каталога — ждём pglite:<каталог>");
    t = { kind: "pglite-dir", dir };
  } else if (/^postgres(ql)?:\/\//.test(u)) {
    const parsed = new URL(u);
    const schema = parsed.searchParams.get("schema");
    if (schema !== null && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`schema=${schema}: ждём имя [a-z_][a-z0-9_]*`);
    parsed.searchParams.delete("schema");
    t = { kind: "postgres", url: parsed.toString(), schema };
  } else throw new Error(`INSPECTOR_DATABASE_URL=${redactUrl(u)}: ждём postgres://…, pglite:<каталог> или memory`);
  if (profile === "gpu" && t.kind !== "postgres") throw new Error("профиль gpu требует сервер PostgreSQL (INSPECTOR_DATABASE_URL=postgres://…): встроенная база только для dev и тестов (ADR-0003)");
  return t;
}

/** Адрес без пароля — для логов и ошибок. */
export function redactUrl(url: string): string {
  return url.replace(/(\/\/[^:/@]+):[^@]*@/, "$1:***@");
}

// ─────────────────────────────── миграции

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  checksum: string;
}

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Файлы каталога миграций → упорядоченный список. Имя — `NNNN_имя.sql`; иное имя или повтор номера — ошибка. */
export function parseMigrations(files: Array<{ name: string; sql: string }>): MigrationFile[] {
  const out: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const f of files) {
    const m = MIGRATION_NAME.exec(f.name);
    if (!m) throw new Error(`миграция ${f.name}: имя должно быть NNNN_имя.sql`);
    const version = Number(m[1]);
    if (version < 1) throw new Error(`миграция ${f.name}: номер начинается с 0001`);
    if (seen.has(version)) throw new Error(`миграция ${f.name}: номер ${m[1]} повторяется`);
    seen.add(version);
    out.push({ version, name: f.name, sql: f.sql, checksum: checksum(f.sql) });
  }
  out.sort((a, b) => a.version - b.version);
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`миграции идут без пропусков: ждём ${String(i + 1).padStart(4, "0")}, есть ${m.name}`);
  });
  return out;
}

/**
 * Что применить. Применённая миграция неизменяема: другая контрольная сумма — отказ (кто-то правил файл задним числом).
 * В базе миграция, которой нет в коде, — отказ (код старше базы: откат образа без отката схемы).
 */
export function migrationPlan(files: MigrationFile[], applied: AppliedMigration[]): MigrationFile[] {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const a of applied) {
    const f = byVersion.get(a.version);
    if (!f) throw new Error(`в базе применена миграция ${a.version}, которой нет в коде: образ старше схемы — выкат отклонён`);
    if (f.checksum !== a.checksum) throw new Error(`миграция ${f.name} изменена после применения (контрольная сумма не совпадает) — правка только новым файлом`);
  }
  const done = new Set(applied.map((a) => a.version));
  return files.filter((f) => !done.has(f.version));
}

/**
 * Кто накатывает схему (HIGH-1, аудит 2026-09-26). Профиль gpu (сервер PostgreSQL): API ходит ролью inspector_app
 * без права DDL и схему только сверяет — миграции и сиды применяет одноразовая служба api-migrate ролью
 * inspector_migrator. dev и тесты (PGlite, паритет): миграции и сиды в процессе, как раньше.
 */
export type MigrationMode = "apply" | "verify";
export function migrationMode(profile: Profile, target: DbTarget["kind"], override: string | null = null): MigrationMode {
  // Стенд (T-129): профиль dev на сервере PostgreSQL с отдельной службой миграций — явный INSPECTOR_MIGRATIONS=verify.
  // В обратную сторону переключатель не работает: в gpu роль приложения не имеет DDL, apply там — ошибка настройки.
  if (override !== null && override !== "verify" && override !== "apply") throw new Error(`INSPECTOR_MIGRATIONS=${override}: ждём verify или apply`);
  if (profile === "gpu" && target === "postgres") {
    if (override === "apply") throw new Error("INSPECTOR_MIGRATIONS=apply недопустим в профиле gpu: схему накатывает служба api-migrate (ADR-0003)");
    return "verify";
  }
  if (override === "verify" && target !== "postgres") throw new Error("INSPECTOR_MIGRATIONS=verify имеет смысл только для сервера PostgreSQL");
  return override ?? "apply";
}

/**
 * Режим verify: схема в базе совпадает с кодом ровно. applied = null — журнала schema_migrations нет (база пустая).
 * Непустой план — отказ старта с подсказкой; расхождение контрольных сумм и «образ старше схемы» — ошибки migrationPlan.
 */
export function assertSchemaCurrent(files: MigrationFile[], applied: AppliedMigration[] | null): void {
  const hint = "запустите api-migrate (docker compose up api-migrate)";
  if (applied === null) throw new Error(`схема не накатана: в базе нет schema_migrations — ${hint}`);
  const plan = migrationPlan(files, applied);
  if (plan.length) throw new Error(`схема не накатана: не применены ${plan.map((m) => m.name).join(", ")} — ${hint}`);
}

/** HIGH-4: демо-учётки с общим паролем — только в dev. В gpu их нет вовсе, первый admin — из секрета (bootstrapAdminDecision). */
export function shouldSeedDemoUsers(profile: Profile): boolean {
  return profile === "dev";
}

/**
 * Первый администратор в эксплуатации (HIGH-4): служба миграций создаёт одного admin, только если пользователей нет
 * и секрет с паролем задан. Есть пользователи — секрет не читается вовсе.
 */
export type BootstrapDecision = "create" | "skip-users-exist" | "skip-no-secret";
export function bootstrapAdminDecision(userCount: number, passwordFile: string | null): BootstrapDecision {
  if (userCount > 0) return "skip-users-exist";
  return passwordFile ? "create" : "skip-no-secret";
}

export const BOOTSTRAP_PASSWORD_MIN = 12;

/** Логин и пароль первого администратора: плохие — отказ службы миграций, а не слабая учётка admin. */
export function validateBootstrapAdmin(login: string, password: string): void {
  if (!/^[a-z][a-z0-9._-]{1,31}$/.test(login)) throw new Error(`INSPECTOR_BOOTSTRAP_ADMIN_LOGIN=${login}: ждём [a-z][a-z0-9._-]{1,31}`);
  if (password.length < BOOTSTRAP_PASSWORD_MIN) throw new Error(`пароль первого администратора короче ${BOOTSTRAP_PASSWORD_MIN} символов — задайте другой в секрете`);
  if (password.toLowerCase().includes(login)) throw new Error("пароль первого администратора содержит логин");
}

// ─────────────────────────────── пул соединений (M-1 TLS, M-2 таймауты)

export interface DbTimeouts {
  /** Ожидание соединения из пула / установки нового; 0 у pg — бесконечно, поэтому ≥ 1. */
  connectMs: number;
  /** Простаивающее соединение закрывается. */
  idleMs: number;
  /** statement_timeout сессии API. У службы миграций — 0: долгие DDL. */
  statementMs: number;
  /** idle_in_transaction_session_timeout: брошенная транзакция не держит блокировки. */
  idleInTxMs: number;
  /** lock_timeout: ожидание блокировки — и у API, и у миграций (DDL не выстраивает очередь из API за собой). */
  lockMs: number;
}

export const DEFAULT_DB_TIMEOUTS: DbTimeouts = { connectMs: 5_000, idleMs: 30_000, statementMs: 30_000, idleInTxMs: 60_000, lockMs: 10_000 };

/** Проверка значений таймаутов при старте (qa-standard L7): не целое ≥ 1 — отказ, а не «0 = без предела». */
export function validateDbTimeouts(t: DbTimeouts): DbTimeouts {
  for (const [k, v] of Object.entries(t)) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`таймаут базы ${k}=${v}: ждём целое число миллисекунд ≥ 1`);
  }
  return t;
}

/** M-1: в профиле gpu соединение с сервером PostgreSQL — только TLS с проверкой сертификата (ТЗ 12.3). */
export function requireDbTls(profile: Profile, target: DbTarget["kind"], caFile: string | null): void {
  if (profile === "gpu" && target === "postgres" && !caFile) {
    throw new Error("профиль gpu требует INSPECTOR_DATABASE_SSL_CA_FILE: соединение с PostgreSQL — только TLS с проверкой сертификата (ТЗ 12.3, verify-full)");
  }
}

/** Параметры адреса, которыми pg перебил бы опцию ssl пула (строка подключения у pg важнее объекта). */
const URL_SSL_PARAMS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslnegotiation"];

export type DbPurpose = "api" | "migrate";

export interface PgPoolConfig {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statement_timeout: number;
  idle_in_transaction_session_timeout: number;
  lock_timeout: number;
  application_name: string;
  options?: string;
  ssl?: { ca: string; rejectUnauthorized: true; host: string; servername?: string };
  enableChannelBinding?: boolean;
}

/**
 * Настройки пула pg. ssl — verify-full: своя цепочка CA, rejectUnauthorized, проверка имени хоста (servername).
 * С заданным CA параметры ssl* в адресе запрещены: pg перебил бы ими проверку сертификата.
 * purpose=migrate — без statement_timeout (0): DDL на больших таблицах идёт дольше запроса API.
 */
export function pgPoolConfig(
  target: { url: string; schema: string | null },
  o: { max: number; timeouts: DbTimeouts; caPem: string | null; purpose: DbPurpose },
): PgPoolConfig {
  const u = new URL(target.url);
  if (o.caPem !== null) {
    const bad = URL_SSL_PARAMS.filter((p) => u.searchParams.has(p));
    if (bad.length) throw new Error(`INSPECTOR_DATABASE_URL: параметр ${bad.join(", ")} недопустим — TLS до базы задаётся INSPECTOR_DATABASE_SSL_CA_FILE (verify-full)`);
  }
  const cfg: PgPoolConfig = {
    connectionString: target.url,
    max: o.max,
    connectionTimeoutMillis: o.timeouts.connectMs,
    idleTimeoutMillis: o.timeouts.idleMs,
    statement_timeout: o.purpose === "migrate" ? 0 : o.timeouts.statementMs,
    idle_in_transaction_session_timeout: o.timeouts.idleInTxMs,
    lock_timeout: o.timeouts.lockMs,
    application_name: o.purpose === "migrate" ? "inspector-migrate" : "inspector-api",
  };
  if (target.schema) cfg.options = `-c search_path=${target.schema}`;
  if (o.caPem !== null) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // host — имя, с которым tls сверяет сертификат: pg передаёт tls только сокет, и для IP-адреса (servername по
    // RFC 6066 — только DNS-имя) проверка шла бы против «localhost». С host сверяется SAN IP; с DNS-именем — SAN DNS.
    cfg.ssl = { ca: o.caPem, rejectUnauthorized: true, host, ...(isIP(host) ? {} : { servername: host }) };
    cfg.enableChannelBinding = true; // SCRAM-SHA-256-PLUS: пароль привязан к TLS-каналу, посредник не перепроиграет
  }
  return cfg;
}

// ─────────────────────────────── типы PostgreSQL → значения приложения

/** OID типов PostgreSQL, которые читаются иначе, чем по умолчанию у драйвера. */
export const PG_OID = { int8: 20, numeric: 1700, timestamp: 1114, timestamptz: 1184, json: 114, jsonb: 3802, date: 1082 } as const;

/**
 * bigint (count(*), identity) → number. За пределами Number.MAX_SAFE_INTEGER — ошибка, а не тихая потеря точности.
 */
export function parseInt8(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${v} вне безопасного диапазона Number`);
  return n;
}

/** numeric (avg, sum по double) → number. */
export function parseNumeric(v: string): number {
  return Number(v);
}

/** timestamptz → ISO 8601 UTC c миллисекундами: тот же вид, что Date.toISOString(), которым система пишет время. */
export function parseTimestamp(v: string): string {
  const s = v.includes("T") ? v : v.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}(:?\d{2})?$/.test(s) ? s : `${s}Z`;
  const iso = withZone.replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`timestamptz ${v}: не разобран`);
  return d.toISOString();
}

/** json/jsonb → строка как есть: приложение хранит и хеширует JSON-текст, разбор — у вызывающего. */
export function parseJsonText(v: string): string {
  return v;
}

/** Парсеры по OID — общие для pg и PGlite, чтобы оба адаптера отдавали одинаковые значения. */
export const PARSERS: Record<number, (v: string) => unknown> = {
  [PG_OID.int8]: parseInt8,
  [PG_OID.numeric]: parseNumeric,
  [PG_OID.timestamp]: parseTimestamp,
  [PG_OID.timestamptz]: parseTimestamp,
  [PG_OID.json]: parseJsonText,
  [PG_OID.jsonb]: parseJsonText,
  [PG_OID.date]: (v: string) => v,
};

/**
 * Параметры запроса: undefined → null (драйверы расходятся в трактовке), Date → ISO, объекты и массивы → JSON-текст.
 * Число, строка, boolean, null, Buffer — как есть.
 */
export function normalizeParams(params: readonly unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    if (p !== null && typeof p === "object" && !Buffer.isBuffer(p)) return JSON.stringify(p);
    return p;
  });
}
