// ADR-0003 (T-107): правила слоя данных — адрес базы, план миграций, типы PostgreSQL, параметры запросов.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertSchemaCurrent, bootstrapAdminDecision, checksum, DEFAULT_DB_TIMEOUTS, migrationMode, migrationPlan, normalizeParams, parseInt8, parseJsonText,
  parseMigrations, parseNumeric, parseTimestamp, PARSERS, PG_OID, pgPoolConfig, redactUrl, requireDbTls, resolveDbTarget, shouldSeedDemoUsers,
  validateBootstrapAdmin, validateDbTimeouts,
} from "../src/domain/db-core.ts";

describe("адрес базы", () => {
  it("memory и :memory: — PGlite в памяти", () => {
    expect(resolveDbTarget("memory", "dev")).toEqual({ kind: "pglite-memory" });
    expect(resolveDbTarget(" :memory: ", "dev")).toEqual({ kind: "pglite-memory" });
  });
  it("pglite:<каталог> — PGlite на диске; без каталога — отказ", () => {
    expect(resolveDbTarget("pglite:var/pgdata", "dev")).toEqual({ kind: "pglite-dir", dir: "var/pgdata" });
    expect(() => resolveDbTarget("pglite:", "dev")).toThrow("без каталога");
  });
  it("postgres:// и postgresql:// — сервер; ?schema= уходит в search_path и не остаётся в адресе", () => {
    expect(resolveDbTarget("postgres://u:p@h:5432/db", "gpu")).toEqual({ kind: "postgres", url: "postgres://u:p@h:5432/db", schema: null });
    expect(resolveDbTarget("postgresql://u@h/db?schema=insp_1&sslmode=require", "dev")).toEqual({ kind: "postgres", url: "postgresql://u@h/db?sslmode=require", schema: "insp_1" });
  });
  it("недопустимое имя схемы — отказ (имя уходит в search_path)", () => {
    expect(() => resolveDbTarget("postgres://h/db?schema=a;drop", "dev")).toThrow("schema=a;drop");
    expect(() => resolveDbTarget("postgres://h/db?schema=1abc", "dev")).toThrow("schema=1abc");
    expect(() => resolveDbTarget("postgres://h/db?schema=" + "a".repeat(64), "dev")).toThrow("schema=");
    expect(resolveDbTarget("postgres://h/db?schema=" + "a".repeat(63), "dev")).toMatchObject({ schema: "a".repeat(63) });
  });
  it("пустой или неизвестный адрес — отказ; пароль в тексте ошибки скрыт", () => {
    expect(() => resolveDbTarget("  ", "dev")).toThrow("пуст");
    expect(() => resolveDbTarget("mysql://u:secret@h/db", "dev")).toThrow("mysql://u:***@h/db");
    expect(() => resolveDbTarget("var/inspector.sqlite", "dev")).toThrow("ждём postgres://");
    expect(() => resolveDbTarget("xpostgres://h/db", "dev")).toThrow("ждём postgres://"); // схема адреса — только с начала строки
  });
  it("профиль gpu принимает только сервер PostgreSQL", () => {
    expect(() => resolveDbTarget("memory", "gpu")).toThrow("профиль gpu требует сервер PostgreSQL");
    expect(() => resolveDbTarget("pglite:var/pgdata", "gpu")).toThrow("профиль gpu требует сервер PostgreSQL");
    expect(resolveDbTarget("pglite:var/pgdata", "dev").kind).toBe("pglite-dir");
  });
  it("redactUrl прячет пароль и не трогает адрес без пароля", () => {
    expect(redactUrl("postgres://inspector:s3cr:et@db:5432/x")).toBe("postgres://inspector:***@db:5432/x");
    expect(redactUrl("postgres://inspector@db/x")).toBe("postgres://inspector@db/x");
  });
});

describe("миграции", () => {
  const f = (name: string, sql = `-- ${name}`) => ({ name, sql });
  it("упорядочиваются по номеру, контрольная сумма — sha256 текста", () => {
    const ms = parseMigrations([f("0002_b.sql"), f("0001_a.sql")]);
    expect(ms.map((m) => m.version)).toEqual([1, 2]);
    expect(ms[0]).toMatchObject({ name: "0001_a.sql", checksum: checksum("-- 0001_a.sql") });
    expect(checksum("x")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("контрольная сумма не зависит от CRLF", () => {
    expect(checksum("a\r\nb")).toBe(checksum("a\nb"));
    expect(checksum("a\nb")).not.toBe(checksum("a\n b"));
  });
  it("неверное имя, номер 0000, повтор и пропуск номера — отказ", () => {
    expect(() => parseMigrations([f("1_init.sql")])).toThrow("NNNN_имя.sql");
    expect(() => parseMigrations([f("0001_Init.sql")])).toThrow("NNNN_имя.sql");
    expect(() => parseMigrations([f("0001_init.sql.bak")])).toThrow("NNNN_имя.sql");
    expect(() => parseMigrations([f("x0001_init.sql")])).toThrow("NNNN_имя.sql"); // номер — с начала имени
    expect(() => parseMigrations([f("0000_zero.sql")])).toThrow("начинается с 0001");
    expect(() => parseMigrations([f("0001_a.sql"), f("0001_b.sql")])).toThrow("повторяется");
    expect(() => parseMigrations([f("0001_a.sql"), f("0003_c.sql")])).toThrow("ждём 0002, есть 0003_c.sql");
    expect(parseMigrations([])).toEqual([]);
  });
  it("план — только неприменённые; применённые сверяются по контрольной сумме", () => {
    const ms = parseMigrations([f("0001_a.sql"), f("0002_b.sql"), f("0003_c.sql")]);
    expect(migrationPlan(ms, []).map((m) => m.version)).toEqual([1, 2, 3]);
    expect(migrationPlan(ms, [{ version: 1, checksum: ms[0].checksum }]).map((m) => m.version)).toEqual([2, 3]);
    expect(migrationPlan(ms, ms.map((m) => ({ version: m.version, checksum: m.checksum })))).toEqual([]);
  });
  it("изменённая после применения миграция — отказ", () => {
    const ms = parseMigrations([f("0001_a.sql")]);
    expect(() => migrationPlan(ms, [{ version: 1, checksum: "0".repeat(64) }])).toThrow("0001_a.sql изменена после применения");
  });
  it("в базе миграция, которой нет в коде, — отказ (откат образа без отката схемы)", () => {
    const ms = parseMigrations([f("0001_a.sql")]);
    expect(() => migrationPlan(ms, [{ version: 1, checksum: ms[0].checksum }, { version: 2, checksum: "x" }])).toThrow("миграция 2, которой нет в коде");
  });
  it("L5 · свойство: план + применённые = все миграции, без пересечений, по возрастанию", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }), (n, k) => {
      const ms = parseMigrations(Array.from({ length: n }, (_, i) => f(`${String(i + 1).padStart(4, "0")}_m.sql`, `select ${i}`)));
      const applied = ms.slice(0, Math.min(k, n)).map((m) => ({ version: m.version, checksum: m.checksum }));
      const plan = migrationPlan(ms, applied);
      expect([...applied.map((a) => a.version), ...plan.map((p) => p.version)]).toEqual(ms.map((m) => m.version));
    }));
  });
});

describe("типы PostgreSQL", () => {
  it("bigint → number; за пределами безопасного целого — отказ", () => {
    expect(parseInt8("42")).toBe(42);
    expect(parseInt8("-7")).toBe(-7);
    expect(parseInt8(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseInt8("9007199254740993")).toThrow("вне безопасного диапазона");
  });
  it("numeric → number", () => {
    expect(parseNumeric("2.50")).toBe(2.5);
    expect(parseNumeric("-0.125")).toBe(-0.125);
  });
  it("timestamptz во всех видах вывода сервера → ISO UTC с миллисекундами", () => {
    expect(parseTimestamp("2026-09-26 18:07:32.642+00")).toBe("2026-09-26T18:07:32.642Z");
    expect(parseTimestamp("2026-09-26 21:07:32.642+03")).toBe("2026-09-26T18:07:32.642Z");
    expect(parseTimestamp("2026-09-26 21:07:32+03:00")).toBe("2026-09-26T18:07:32.000Z");
    expect(parseTimestamp("2026-09-26 13:37:32.5-0430")).toBe("2026-09-26T18:07:32.500Z");
    expect(parseTimestamp("2026-09-26T18:07:32Z")).toBe("2026-09-26T18:07:32.000Z");
    expect(parseTimestamp("2026-09-26 18:07:32")).toBe("2026-09-26T18:07:32.000Z"); // timestamp без зоны — UTC
    expect(() => parseTimestamp("infinity")).toThrow("не разобран");
  });
  it("L5 · свойство: ISO-время системы проходит через timestamptz без изменений", () => {
    fc.assert(fc.property(fc.date({ min: new Date("1970-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }), (d) => {
      const pgText = d.toISOString().replace("T", " ").replace("Z", "+00");
      expect(parseTimestamp(pgText)).toBe(d.toISOString());
    }));
  });
  it("json — текст как есть: хеш протокола считается по тому же тексту", () => {
    expect(parseJsonText('{"b":1, "a":2}')).toBe('{"b":1, "a":2}');
  });
  it("таблица парсеров: bigint, numeric, время, json, jsonb, date — и больше ничего", () => {
    expect(Object.keys(PARSERS).map(Number).sort((a, b) => a - b)).toEqual([PG_OID.int8, PG_OID.json, PG_OID.date, PG_OID.timestamp, PG_OID.timestamptz, PG_OID.numeric, PG_OID.jsonb].sort((a, b) => a - b));
    expect(PARSERS[PG_OID.int8]("5")).toBe(5);
    expect(PARSERS[PG_OID.numeric]("1.5")).toBe(1.5);
    expect(PARSERS[PG_OID.timestamp]("2026-01-01 00:00:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(PARSERS[PG_OID.timestamptz]("2026-01-01 00:00:00+00")).toBe("2026-01-01T00:00:00.000Z");
    expect(PARSERS[PG_OID.json]("[1]")).toBe("[1]");
    expect(PARSERS[PG_OID.jsonb]("[1]")).toBe("[1]");
    expect(PARSERS[PG_OID.date]("2026-09-26")).toBe("2026-09-26");
  });
});

describe("параметры запроса", () => {
  it("undefined → null, Date → ISO, объект и массив → JSON; прочее как есть", () => {
    const buf = Buffer.from("x");
    const d = new Date("2026-09-26T18:00:00.000Z");
    expect(normalizeParams([undefined, null, d, { a: 1 }, [1, 2], 5, "s", true, buf])).toEqual([null, null, "2026-09-26T18:00:00.000Z", '{"a":1}', "[1,2]", 5, "s", true, buf]);
    expect(normalizeParams([])).toEqual([]);
  });
});

// ─────────────────────────────── аудит 2026-09-26: HIGH-1, HIGH-4, M-1, M-2
const mig = (n: number, sql = `-- ${n}`) => parseMigrations([{ name: `${String(n).padStart(4, "0")}_m${n}.sql`, sql }])[0];
const files2 = parseMigrations([{ name: "0001_a.sql", sql: "a" }, { name: "0002_b.sql", sql: "b" }]);

describe("кто накатывает схему (HIGH-1)", () => {
  it("gpu + сервер — только сверка; dev и встроенные базы — миграции в процессе", () => {
    expect(migrationMode("gpu", "postgres")).toBe("verify");
    expect(migrationMode("dev", "postgres")).toBe("apply");
    expect(migrationMode("dev", "pglite-memory")).toBe("apply");
    expect(migrationMode("dev", "pglite-dir")).toBe("apply");
    expect(migrationMode("gpu", "pglite-dir")).toBe("apply"); // недостижимо: resolveDbTarget в gpu не пускает PGlite
    // стенд T-129: dev на сервере с отдельной службой миграций; в gpu apply запрещён, verify без сервера бессмыслен
    expect(migrationMode("dev", "postgres", "verify")).toBe("verify");
    expect(migrationMode("dev", "postgres", "apply")).toBe("apply");
    expect(migrationMode("gpu", "postgres", "verify")).toBe("verify");
    expect(() => migrationMode("gpu", "postgres", "apply")).toThrow(/недопустим в профиле gpu/);
    expect(() => migrationMode("dev", "pglite-memory", "verify")).toThrow(/только для сервера/);
    expect(() => migrationMode("dev", "postgres", "maybe")).toThrow(/ждём verify или apply/);
  });
  it("сверка: пустая база и непустой план — отказ старта с подсказкой api-migrate; всё применено — тихо", () => {
    expect(() => assertSchemaCurrent(files2, null)).toThrow("схема не накатана: в базе нет schema_migrations — запустите api-migrate");
    expect(() => assertSchemaCurrent(files2, [])).toThrow("не применены 0001_a.sql, 0002_b.sql — запустите api-migrate");
    expect(() => assertSchemaCurrent(files2, [{ version: 1, checksum: files2[0].checksum }])).toThrow(/не применены 0002_b\.sql —/);
    expect(() => assertSchemaCurrent(files2, files2.map((f) => ({ version: f.version, checksum: f.checksum })))).not.toThrow();
  });
  it("сверка: подменённая контрольная сумма и схема новее образа — отказ", () => {
    expect(() => assertSchemaCurrent(files2, [{ version: 1, checksum: "0".repeat(64) }, { version: 2, checksum: files2[1].checksum }])).toThrow("изменена после применения");
    expect(() => assertSchemaCurrent([files2[0]], files2.map((f) => ({ version: f.version, checksum: f.checksum })))).toThrow("образ старше схемы");
    expect(mig(1).checksum).toBe(checksum("-- 1"));
  });
});

describe("учётки эксплуатации (HIGH-4)", () => {
  it("демо-учётки — только dev", () => {
    expect(shouldSeedDemoUsers("dev")).toBe(true);
    expect(shouldSeedDemoUsers("gpu")).toBe(false);
  });
  it("первый admin: только в пустую users и только с секретом", () => {
    expect(bootstrapAdminDecision(0, "/run/secrets/bootstrap_admin_password")).toBe("create");
    expect(bootstrapAdminDecision(0, null)).toBe("skip-no-secret");
    expect(bootstrapAdminDecision(0, "")).toBe("skip-no-secret");
    expect(bootstrapAdminDecision(1, "/run/secrets/x")).toBe("skip-users-exist");
    expect(bootstrapAdminDecision(5, null)).toBe("skip-users-exist");
  });
  it("логин и пароль первого admin проверяются: короткий, с логином, плохой логин — отказ", () => {
    expect(() => validateBootstrapAdmin("admin", "Kx9-long-enough")).not.toThrow();
    expect(() => validateBootstrapAdmin("admin", "a".repeat(12))).not.toThrow();
    expect(() => validateBootstrapAdmin("admin", "a".repeat(11))).toThrow("короче 12");
    expect(() => validateBootstrapAdmin("admin", "xxADMIN12345")).toThrow("содержит логин");
    expect(() => validateBootstrapAdmin("Admin", "Kx9-long-enough")).toThrow("INSPECTOR_BOOTSTRAP_ADMIN_LOGIN=Admin");
    expect(() => validateBootstrapAdmin("a", "Kx9-long-enough")).toThrow("ждём");
    expect(() => validateBootstrapAdmin("admin; drop", "Kx9-long-enough")).toThrow("ждём");
    expect(() => validateBootstrapAdmin("ops.admin-1", "Kx9-long-enough")).not.toThrow();
  });
});

describe("пул соединений: TLS verify-full и таймауты (M-1, M-2)", () => {
  const target = { url: "postgres://inspector_app@postgres:5432/inspector", schema: null };
  const ca = "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n";
  it("профиль gpu без CA — отказ старта; dev и встроенная база — можно без TLS", () => {
    expect(() => requireDbTls("gpu", "postgres", null)).toThrow("INSPECTOR_DATABASE_SSL_CA_FILE");
    expect(() => requireDbTls("gpu", "postgres", "/run/tls/ca.crt")).not.toThrow();
    expect(() => requireDbTls("dev", "postgres", null)).not.toThrow();
    expect(() => requireDbTls("gpu", "pglite-dir", null)).not.toThrow();
  });
  it("API: таймауты сессии и пула, имя приложения; TLS — своя CA, проверка сертификата и имени хоста", () => {
    const c = pgPoolConfig(target, { max: 10, timeouts: DEFAULT_DB_TIMEOUTS, caPem: ca, purpose: "api" });
    expect(c).toEqual({
      connectionString: target.url, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 30000,
      idle_in_transaction_session_timeout: 60000, lock_timeout: 10000, application_name: "inspector-api",
      ssl: { ca, rejectUnauthorized: true, host: "postgres", servername: "postgres" }, enableChannelBinding: true,
    });
  });
  it("служба миграций: без statement_timeout (долгие DDL), lock_timeout сохраняется", () => {
    const c = pgPoolConfig(target, { max: 2, timeouts: DEFAULT_DB_TIMEOUTS, caPem: null, purpose: "migrate" });
    expect([c.statement_timeout, c.lock_timeout, c.application_name, c.ssl, c.enableChannelBinding]).toEqual([0, 10000, "inspector-migrate", undefined, undefined]);
  });
  it("schema= уходит в search_path; IP-адрес — без servername, сертификат сверяется по SAN IP (host)", () => {
    expect(pgPoolConfig({ ...target, schema: "insp" }, { max: 1, timeouts: DEFAULT_DB_TIMEOUTS, caPem: null, purpose: "api" }).options).toBe("-c search_path=insp");
    expect(pgPoolConfig({ url: "postgres://u@127.0.0.1:5432/db", schema: null }, { max: 1, timeouts: DEFAULT_DB_TIMEOUTS, caPem: ca, purpose: "api" }).ssl).toEqual({ ca, rejectUnauthorized: true, host: "127.0.0.1" });
    expect(pgPoolConfig({ url: "postgres://u@[::1]:5432/db", schema: null }, { max: 1, timeouts: DEFAULT_DB_TIMEOUTS, caPem: ca, purpose: "api" }).ssl).toEqual({ ca, rejectUnauthorized: true, host: "::1" });
  });
  it("с CA параметры ssl* в адресе запрещены: pg перебил бы ими проверку сертификата", () => {
    for (const q of ["sslmode=disable", "sslmode=require", "ssl=true", "sslrootcert=/x", "sslcert=/x", "sslkey=/x", "sslnegotiation=direct"]) {
      expect(() => pgPoolConfig({ url: `${target.url}?${q}`, schema: null }, { max: 1, timeouts: DEFAULT_DB_TIMEOUTS, caPem: ca, purpose: "api" })).toThrow("INSPECTOR_DATABASE_SSL_CA_FILE");
    }
    expect(() => pgPoolConfig({ url: `${target.url}?sslmode=require`, schema: null }, { max: 1, timeouts: DEFAULT_DB_TIMEOUTS, caPem: null, purpose: "api" })).not.toThrow();
  });
  it("таймауты: целое ≥ 1, иначе отказ старта (0 у PostgreSQL — «без предела»)", () => {
    expect(validateDbTimeouts(DEFAULT_DB_TIMEOUTS)).toBe(DEFAULT_DB_TIMEOUTS);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => validateDbTimeouts({ ...DEFAULT_DB_TIMEOUTS, lockMs: bad })).toThrow("lockMs");
    }
    expect(() => validateDbTimeouts({ ...DEFAULT_DB_TIMEOUTS, statementMs: 0 })).toThrow("statementMs=0");
    expect(validateDbTimeouts({ connectMs: 1, idleMs: 1, statementMs: 1, idleInTxMs: 1, lockMs: 1 }).connectMs).toBe(1);
  });
});
