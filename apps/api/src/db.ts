// Хранилище — PostgreSQL во всех профилях (ADR-0003, T-107; заменяет SQLite из ADR-0001). Имена таблиц — по ТЗ §10.
// Эксплуатация (gpu) — сервер PostgreSQL через pg; разработка и тесты — PGlite: тот же PostgreSQL, собранный в WASM,
// в процессе и без сервера. Схема — версионированные миграции src/db/migrations (0001_init.sql, …) с контрольной суммой.
// Правила разбора адреса, плана миграций и типов — чистые функции domain/db-core.ts.
// Профиль gpu (HIGH-1, аудит 2026-09-26): API ходит ролью inspector_app и схему только сверяет; миграции, сиды и первого
// администратора делает служба api-migrate (src/migrate.ts) ролью inspector_migrator. Роли — deploy/gpu/postgres/init.
import { PGlite, type Transaction } from "@electric-sql/pglite";
import pg from "pg";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { config } from "./config.ts";
import { normSeedRow, type SeedNorm } from "./domain/norm-base.ts";
import { normativeRefs } from "./domain/normative-refs.ts";
import {
  assertSchemaCurrent, bootstrapAdminDecision, migrationMode, migrationPlan, normalizeParams, PARSERS, parseMigrations, pgPoolConfig, redactUrl,
  resolveDbTarget, shouldSeedDemoUsers, validateBootstrapAdmin, type AppliedMigration, type BootstrapDecision, type DbPurpose, type DbTarget,
  type MigrationFile, type MigrationMode, type Profile,
} from "./domain/db-core.ts";

export type Row = Record<string, any>;

export interface RunResult {
  /** Число затронутых строк (INSERT/UPDATE/DELETE). */
  rowCount: number;
  /** Строки RETURNING. */
  rows: Row[];
}

/**
 * Доступ к базе. Плейсхолдеры — родные PostgreSQL: $1, $2, …
 * tx(fn) — транзакция: fn получает DB, привязанный к транзакции, и обязан ходить в базу только через него.
 * Вложенный tx — точка сохранения (SAVEPOINT): откатывается только вложенная часть.
 */
export interface DB {
  readonly kind: "pglite" | "postgres";
  all<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  /** Несколько операторов без параметров (DDL). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (t: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ─────────────────────────────── PGlite

type PgliteHandle = Pick<PGlite, "query" | "exec"> | Transaction;

class PgliteDb implements DB {
  readonly kind = "pglite" as const;
  private sp = 0;
  constructor(private readonly root: PGlite, private readonly h: PgliteHandle = root, private readonly inTx = false) {}

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.h.query<T>(sql, normalizeParams(params))).rows;
  }
  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const r = await this.h.query<Row>(sql, normalizeParams(params));
    return { rowCount: r.affectedRows ?? 0, rows: r.rows };
  }
  async exec(sql: string): Promise<void> {
    await this.h.exec(sql);
  }
  async tx<T>(fn: (t: DB) => Promise<T>): Promise<T> {
    if (!this.inTx) return this.root.transaction((t) => fn(new PgliteDb(this.root, t, true)));
    return savepoint(this, `sp_${++this.sp}`, fn);
  }
  async close(): Promise<void> {
    if (!this.inTx && !this.root.closed) await this.root.close();
  }
}

// ─────────────────────────────── сервер PostgreSQL

const pgTypes = { getTypeParser: (oid: number, format?: string) => (PARSERS[oid] as never) ?? (pg.types.getTypeParser as any)(oid, format) };

class PgDb implements DB {
  readonly kind = "postgres" as const;
  private sp = 0;
  private closed = false;
  constructor(private readonly pool: pg.Pool, private readonly client: pg.PoolClient | null = null, private readonly onClose?: () => Promise<void>) {}

  private q(): pg.Pool | pg.PoolClient {
    return this.client ?? this.pool;
  }
  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.q().query({ text: sql, values: normalizeParams(params), types: pgTypes as any })).rows as T[];
  }
  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const r = await this.q().query({ text: sql, values: normalizeParams(params), types: pgTypes as any });
    return { rowCount: r.rowCount ?? 0, rows: r.rows };
  }
  async exec(sql: string): Promise<void> {
    await this.q().query(sql);
  }
  async tx<T>(fn: (t: DB) => Promise<T>): Promise<T> {
    if (this.client) return savepoint(this, `sp_${++this.sp}`, fn);
    const client = await this.pool.connect();
    // L-2: не удался rollback — соединение в неизвестном состоянии: release(err) уничтожает его, а не отдаёт следующему
    let broken: Error | undefined;
    try {
      await client.query("begin");
      const out = await fn(new PgDb(this.pool, client));
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback").catch((re: Error) => (broken = re));
      throw e;
    } finally {
      client.release(broken);
    }
  }
  async close(): Promise<void> {
    // идемпотентно, как у PGlite: повторный pool.end() в pg — ошибка «Called end on pool more than once»
    if (this.client || this.closed) return;
    this.closed = true;
    await this.onClose?.();
    await this.pool.end();
  }
}

async function savepoint<T>(db: DB, name: string, fn: (t: DB) => Promise<T>): Promise<T> {
  await db.exec(`savepoint ${name}`);
  try {
    const out = await fn(db);
    await db.exec(`release savepoint ${name}`);
    return out;
  } catch (e) {
    await db.exec(`rollback to savepoint ${name}`);
    throw e;
  }
}

// ─────────────────────────────── открытие, миграции, сиды

const MIGRATIONS_DIR = () => join(config.root, "apps/api/src/db/migrations");

export function loadMigrations(dir = MIGRATIONS_DIR()): MigrationFile[] {
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql"));
  return parseMigrations(names.map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") })));
}

/** Применить недостающие миграции. Каждая — в своей транзакции; параллельный старт двух API — под advisory-lock. */
export async function migrate(db: DB, files = loadMigrations()): Promise<number> {
  await db.exec(`create table if not exists schema_migrations (
    version integer primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
  return db.tx(async (t) => {
    await t.run("select pg_advisory_xact_lock(hashtext('inspector:migrate'))");
    const applied = await t.all<{ version: number; checksum: string }>("select version, checksum from schema_migrations order by version");
    const plan = migrationPlan(files, applied);
    for (const m of plan) {
      await t.tx(async (s) => {
        await s.exec(m.sql);
        await s.run("insert into schema_migrations (version, name, checksum) values ($1, $2, $3)", [m.version, m.name, m.checksum]);
      });
    }
    return plan.length;
  });
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}

const now = () => new Date().toISOString();

/** OS-INSP-7.2.2: 13 нормативных актов ТЗ §2 в редакциях из ТЗ. Заполняется, если справочник пуст. */
async function seedLegalActs(db: DB): Promise<void> {
  if ((await db.get<{ n: number }>("select count(*) n from legal_acts"))!.n > 0) return;
  const acts = JSON.parse(readFileSync(join(config.root, "data/seed/legal-acts.json"), "utf8")).items as Array<Record<string, string | number | null>>;
  for (const a of acts) {
    await db.run("insert into legal_acts (n, short, kind, title, number, date, edition, edition_date, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [a.n, a.short, a.kind, a.title, a.number, a.date ?? null, a.edition ?? null, a.edition_date ?? null, a.note ?? null]);
  }
}

/** Матрица и справочники. Только в пустую базу; всё — одной транзакцией. Демо-учётки — отдельно и только в dev (HIGH-4). */
async function seed(db: DB): Promise<void> {
  if ((await db.get<{ n: number }>("select count(*) n from params"))!.n > 0) return;
  const matrix = JSON.parse(readFileSync(join(config.root, "data/seed/matrix.json"), "utf8")) as Array<Record<string, unknown>>;
  for (const p of matrix) {
    await db.run(`insert into params (id, code, section, parameter_name, unit, source_pd, source_rd, source_id, trigger_logic, review_priority,
      sp_reference, data_type, compare_json, anchors_json, regex_pattern, value_scale_json, applicability, min_value, max_value, is_active, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [
      p.id as number, p.code as string, p.section as string, p.parameter_name as string, (p.unit as string) ?? "",
      (p.source_pd as string) ?? null, (p.source_rd as string) ?? null, (p.source_id as string) ?? null,
      (p.trigger_logic as string) ?? "", (p.review_priority as string) ?? "MEDIUM", null, p.data_type as string,
      JSON.stringify(p.compare), JSON.stringify(p.anchors), (p.regex_pattern as string) ?? null,
      p.value_scale ? JSON.stringify(p.value_scale) : null, (p.applicability as string) ?? null,
      (p.min_value as number) ?? null, (p.max_value as number) ?? null, true, now(), now(),
    ]);
  }
  await setMeta(db, "matrix_version", "1.1.2"); // 1.1.1 — шкала М-023 (T-129, миграция 0004); 1.1.2 — шкала PN М-072 (T-135, 0007)
  await setMeta(db, "model_version", "dev-anchors-0.1");
  await setMeta(db, "dataset_version", "none");
  // Логические правила свободного поиска (ТЗ 9.5, пример «если этажей > 10 — должен быть лифт»)
  await db.run("insert into logical_rules (rule_name, condition_json, expected_json, fact_anchors_json, normative_base) values ($1,$2,$3,$4,$5)", [
    "Здание выше 10 этажей оборудуется лифтом",
    JSON.stringify({ key: "M-007", op: ">", value: 10 }),
    JSON.stringify({ key: "LIFTS", op: ">", value: 0 }),
    JSON.stringify([{ code: "LIFTS", anchors: ["Количество лифтов", "лифтов"], data_type: "number" }]),
    "СП 54.13330.2022, п. 7.1.3",
  ]);
  const norm = "insert into normative_base (document_name, document_number, section, parameter_name, param_code, min_value, max_value, effective_from) values ($1,$2,$3,$4,$5,$6,$7,$8)";
  await db.run(norm, ["Системы противопожарной защиты. Обеспечение эвакуации", "СП 1.13130.2020", "п. 4.2.5", "Ширина эвакуационных выходов", "M-041", 0.8, null, "2020-09-19"]);
  await db.run(norm, ["Системы противопожарной защиты. Обеспечение эвакуации", "СП 1.13130.2020", "п. 4.3.4", "Ширина эвакуационных коридоров", "M-040", 1.0, null, "2020-09-19"]);
  await db.run(norm, ["Здания жилые многоквартирные", "СП 54.13330.2022", "п. 5.12", "Высота помещений", null, 2.5, null, "2022-06-14"]);
}

/**
 * ТЗ §10 Normative_Base — один источник норм (T-234): записи data/seed/norms.json → base[] (пределы CMP-06 паспортов,
 * сроки действия) добавляются в таблицу по norm_key, если их там ещё нет. Существующая строка не перезаписывается:
 * правка администратора в интерфейсе остаётся, расчёт читает таблицу (services/inspections.ts loadNormBase).
 */
export async function syncNormBase(db: DB): Promise<number> {
  const file = JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")) as { base?: SeedNorm[]; items?: Array<{ document_number: string; document_name: string }> };
  const docNames = new Map((file.items ?? []).map((i) => [i.document_number, i.document_name]));
  const paramNames = new Map((await db.all<{ code: string; parameter_name: string }>("select code, parameter_name from params")).map((p) => [p.code, p.parameter_name]));
  let added = 0;
  for (const n of file.base ?? []) {
    const r = normSeedRow(n, docNames, paramNames);
    const res = await db.run(`insert into normative_base (norm_key, document_name, document_number, section, parameter_name, param_code, min_value, max_value, effective_from, effective_to,
        measure, unit, rule, edition, conditions, applies_to_json, unverified, quote, source_url) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        on conflict (norm_key) do nothing`, [r.norm_key, r.document_name, r.document_number, r.section, r.parameter_name, r.param_code, r.min_value, r.max_value, r.effective_from, r.effective_to,
      r.measure, r.unit, r.rule, r.edition, r.conditions, r.applies_to_json, r.unverified, r.quote, r.source_url]);
    added += res.rowCount;
  }
  return added;
}

/** Версия начального наполнения ссылок params (поднять при смене правила normativeRefs или источников). */
export const PARAM_REFS_SEED = "1";

/**
 * ТЗ §10 Params: sp_reference, gost_reference, fz_reference (T-234). В Матрице редакции 1.1 колонок ссылок нет —
 * документы названы в тексте Матрицы (логика ИИ-связи), в основании паспорта и в справочнике норм. Заполняются только
 * пустые ячейки и один раз на версию наполнения (meta.params_refs_seed): ссылку, заданную администратором, не трогаем.
 */
export async function seedParamRefs(db: DB): Promise<number> {
  if ((await meta(db, "params_refs_seed")) === PARAM_REFS_SEED) return 0;
  const root = config.root;
  const matrix = new Map((JSON.parse(readFileSync(join(root, "data/seed/matrix.json"), "utf8")) as Array<{ code: string; trigger_logic?: string }>).map((p) => [p.code, p.trigger_logic ?? ""]));
  const norms = JSON.parse(readFileSync(join(root, "data/seed/norms.json"), "utf8")) as { base?: Array<{ doc: string; clause?: string | null; applies_to?: string[] }>; items?: Array<{ document_number: string; section?: string | null; param_codes?: string[] }> };
  const dir = join(root, "data/seed/passports");
  const basis = new Map<string, string>();
  for (const f of readdirSync(dir).filter((x) => /^M-\d{3}\.json$/.test(x))) basis.set(f.slice(0, -5), String((JSON.parse(readFileSync(join(dir, f), "utf8")) as { basis?: unknown }).basis ?? ""));
  let n = 0;
  for (const { code } of await db.all<{ code: string }>("select code from params order by id")) {
    const texts = [
      matrix.get(code), basis.get(code),
      ...(norms.items ?? []).filter((i) => i.param_codes?.includes(code)).map((i) => `${i.document_number}${i.section ? `, ${i.section}` : ""}`),
      ...(norms.base ?? []).filter((b) => b.applies_to?.includes(code)).map((b) => `${b.doc}${b.clause ? `, ${b.clause}` : ""}`),
    ];
    const r = normativeRefs(texts);
    const res = await db.run(`update params set sp_reference = coalesce(sp_reference, $1), gost_reference = coalesce(gost_reference, $2), fz_reference = coalesce(fz_reference, $3),
        other_normative = coalesce(other_normative, $4) where code = $5 and ($1::text is not null or $2::text is not null or $3::text is not null or $4::text is not null)`,
      [r.sp_reference, r.gost_reference, r.fz_reference, r.other_normative, code]);
    n += res.rowCount;
  }
  await setMeta(db, "params_refs_seed", PARAM_REFS_SEED);
  return n;
}

/** Демо-учётки прототипа (5 ролей, один пароль INSPECTOR_DEMO_PASSWORD; ТЗ 12.1). Только dev и только в пустую users. */
async function seedDemoUsers(db: DB): Promise<void> {
  if ((await db.get<{ n: number }>("select count(*) n from users"))!.n > 0) return;
  const pw = config.demoPassword;
  const user = "insert into users (id, login, name, role, password_hash) values ($1,$2,$3,$4,$5)";
  for (const [id, login, name, role] of [
    ["u-insp", "inspector", "Иванова А. С.", "inspector"], ["u-sup", "supervisor", "Петров Д. В.", "supervisor"],
    ["u-adm", "admin", "Администратор", "admin"], ["u-ml", "ml", "Сидоров К. Л.", "ml_engineer"], ["u-cur", "curator", "Кузнецова Е. М.", "curator"],
  ]) await db.run(user, [id, login, name, role, hashPassword(pw)]);
}

/**
 * Режим apply: миграции, справочники, Матрица; демо-учётки — только в dev. Затем журнал миграций закрывается
 * от роли приложения (если она есть — на сервере с ролями из deploy/gpu/postgres/init). Возвращает число миграций.
 */
export async function applySchema(db: DB, profile: Profile = config.profile as Profile): Promise<number> {
  const n = await migrate(db);
  await db.tx(async (t) => {
    await seedLegalActs(t); // OS-INSP-7.2.2: и в базах, созданных до появления справочника
    await seed(t);
    await syncNormBase(t); // T-234: нормы CMP-06 — в таблицу normative_base (только начальное наполнение)
    await seedParamRefs(t); // T-234: ссылки СП/ГОСТ/ФЗ параметров из текста Матрицы, паспортов и справочника норм
    if (shouldSeedDemoUsers(profile)) await seedDemoUsers(t);
  });
  await restrictMigrationJournal(db);
  return n;
}

/**
 * M-5: роль приложения читает журнал миграций, но не правит его (подмена контрольной суммы спрятала бы правку схемы).
 * Роли inspector_app нет (PGlite, сервер паритета) — ничего не делаем. Выполняет владелец объектов (служба миграций).
 */
export async function restrictMigrationJournal(db: DB): Promise<boolean> {
  const role = await db.get<{ ok: boolean }>("select exists (select 1 from pg_roles where rolname = 'inspector_app') ok");
  if (!role!.ok) return false;
  await db.exec("revoke all on schema_migrations from inspector_app; grant select on schema_migrations to inspector_app");
  return true;
}

/** Режим verify (профиль gpu): схема в базе совпадает с кодом ровно; иначе отказ старта. Ничего не пишет. */
export async function verifySchema(db: DB, files = loadMigrations()): Promise<void> {
  const journal = await db.get<{ ok: boolean }>("select to_regclass('schema_migrations') is not null ok");
  const applied = journal!.ok ? await db.all<AppliedMigration>("select version, checksum from schema_migrations order by version") : null;
  assertSchemaCurrent(files, applied);
}

/**
 * HIGH-4: первый администратор эксплуатации — из файла-секрета, только в пустую users. Есть пользователи — файл не
 * читается. Логин и пароль проверяются (validateBootstrapAdmin): слабый пароль — отказ службы миграций.
 */
export async function bootstrapAdmin(db: DB, o: { login: string; passwordFile: string | null }): Promise<BootstrapDecision> {
  return db.tx(async (t) => {
    await t.run("select pg_advisory_xact_lock(hashtext('inspector:bootstrap-admin'))");
    const d = bootstrapAdminDecision((await t.get<{ n: number }>("select count(*) n from users"))!.n, o.passwordFile);
    if (d !== "create") return d;
    const password = readFileSync(o.passwordFile!, "utf8").replace(/\r?\n$/, "");
    validateBootstrapAdmin(o.login, password);
    await t.run("insert into users (id, login, name, role, password_hash) values ($1, $2, $3, 'admin', $4)", [`u-${randomUUID()}`, o.login, "Администратор", hashPassword(password)]);
    return d;
  });
}

const pglite = (opts: ConstructorParameters<typeof PGlite>[0] = {}) => new PGlite({ ...opts, parsers: PARSERS as any });

// Шаблон пустой базы (миграции + сиды) для PGlite в памяти: первый вызов готовит и снимает каталог данных,
// следующие поднимают копию снимка — без повторных миграций и хеширования паролей. Тесты открывают сотни баз.
let template: Promise<Blob> | null = null;

async function openMemory(): Promise<DB> {
  template ??= (async () => {
    const db = new PgliteDb(pglite());
    await applySchema(db);
    const root = (db as any).root as PGlite;
    const blob = await root.dumpDataDir("none");
    await db.close();
    return blob;
  })();
  return new PgliteDb(pglite({ loadDataDir: await template }));
}

// Прогон паритета: INSPECTOR_TEST_DATABASE_URL=postgres://… — «память» открывается свежей схемой на сервере PostgreSQL,
// и весь набор тестов идёт на настоящем сервере, а не на PGlite. Схема удаляется при close().
async function openScratchSchema(url: string): Promise<DB> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
  const drop = async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`drop schema if exists ${schema} cascade`);
    await c.end();
  };
  const db = new PgDb(pool, null, drop);
  await applySchema(db);
  return db;
}

export interface OpenOptions {
  /**
   * apply — миграции и сиды в процессе; verify — только сверка схемы (gpu: накатывает api-migrate); none — голое
   * подключение без миграций (служба миграций сама вызывает applySchema; memory — пустая база). По умолчанию —
   * migrationMode(профиль, цель).
   */
  mode?: MigrationMode | "none";
  /** migrate — служба миграций: без statement_timeout, application_name inspector-migrate. */
  purpose?: DbPurpose;
}

/** Подключение к цели без миграций. */
async function connect(target: DbTarget, purpose: DbPurpose): Promise<DB> {
  switch (target.kind) {
    case "pglite-memory":
      return new PgliteDb(pglite());
    case "pglite-dir": {
      const dir = resolve(config.root, target.dir);
      mkdirSync(dirname(dir), { recursive: true });
      return new PgliteDb(pglite({ dataDir: dir }));
    }
    case "postgres": {
      // M-1, M-2: TLS verify-full (CA из INSPECTOR_DATABASE_SSL_CA_FILE) и таймауты — domain/db-core.ts::pgPoolConfig
      const pool = new pg.Pool(pgPoolConfig(target, { max: config.databasePoolMax, timeouts: config.databaseTimeouts, caPem: config.databaseCaPem, purpose }));
      pool.on("error", (e) => console.error(JSON.stringify({ level: "ERROR", message: "postgres pool", error: String(e), url: redactUrl(target.url) })));
      return new PgDb(pool);
    }
  }
}

/** Открыть базу по адресу (по умолчанию — INSPECTOR_DATABASE_URL): apply — миграции и сиды, verify — только сверка. */
export async function openDb(url = config.databaseUrl, opts: OpenOptions = {}): Promise<DB> {
  const target: DbTarget = resolveDbTarget(url, config.profile as Profile);
  const mode = opts.mode ?? migrationMode(config.profile as Profile, target.kind, process.env.INSPECTOR_MIGRATIONS?.trim() || null);
  if (target.kind === "pglite-memory" && mode !== "none") {
    // тесты: снимок шаблона (миграции и сиды уже в нём) или свежая схема на сервере паритета
    const parity = process.env.INSPECTOR_TEST_DATABASE_URL?.trim();
    return parity ? openScratchSchema(parity) : openMemory();
  }
  const db = await connect(target, opts.purpose ?? "api");
  try {
    if (mode === "apply") await applySchema(db);
    else if (mode === "verify") await verifySchema(db);
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  return db;
}

export async function meta(db: DB, key: string): Promise<string> {
  return (await db.get<{ value: string }>("select value from meta where key = $1", [key]))?.value ?? "";
}

export async function setMeta(db: DB, key: string, value: string): Promise<void> {
  await db.run("insert into meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
}
