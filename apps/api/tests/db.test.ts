// ADR-0003 (T-107): адаптер базы на настоящем PostgreSQL (PGlite; с INSPECTOR_TEST_DATABASE_URL — на сервере):
// миграции, сиды, транзакции и точки сохранения, типы, изоляция баз тестов.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, bootstrapAdmin, loadMigrations, meta, migrate, openDb, restrictMigrationJournal, setMeta, verifySchema, type DB } from "../src/db.ts";
import { scryptSync } from "node:crypto";
import { config } from "../src/config.ts";

const open: DB[] = [];
async function fresh(): Promise<DB> {
  const db = await openDb("memory");
  open.push(db);
  return db;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe("схема и сиды", () => {
  it("миграции применены, все таблицы ТЗ §10 на месте, Матрица и справочники засеяны", async () => {
    const db = await fresh();
    const tables = (await db.all<{ t: string }>("select table_name t from information_schema.tables where table_schema = current_schema() order by 1")).map((r) => r.t);
    for (const t of ["files", "protocols", "rejection_log", "dispute_log", "suspicions", "logical_rules", "normative_base", "model_versions", "audit_log", "monitoring_metrics", "evidence_fragments", "dataset_items", "schema_migrations"]) {
      expect(tables).toContain(t);
    }
    expect((await db.get<{ n: number }>("select count(*) n from params"))!.n).toBe(132);
    expect((await db.get<{ n: number }>("select count(*) n from legal_acts"))!.n).toBe(13);
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(5);
    expect(await meta(db, "matrix_version")).toBe("1.1.2"); // 1.1.1 — шкала М-023 (T-129); 1.1.2 — шкала PN М-072 (T-135)
    expect(JSON.parse((await db.get<any>("select value_scale_json from params where code = $1", ["M-072"])).value_scale_json)).toBe("pressure_class");
    expect(await meta(db, "нет такого")).toBe("");
  });

  it("повторный migrate ничего не применяет; журнал миграций хранит номер, имя и контрольную сумму", async () => {
    const db = await fresh();
    expect(await migrate(db)).toBe(0);
    const files = loadMigrations();
    const rows = await db.all<{ version: number; name: string; checksum: string }>("select version, name, checksum from schema_migrations order by version");
    expect(rows).toEqual(files.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum })));
  });

  it("миграция, изменённая после применения, останавливает старт", async () => {
    const db = await fresh();
    const files = loadMigrations().map((f, i) => (i === 0 ? { ...f, checksum: "0".repeat(64) } : f));
    await expect(migrate(db, files)).rejects.toThrow("изменена после применения");
  });

  it("новая миграция применяется поверх, в своей транзакции; сбой миграции откатывает её целиком", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      for (const f of loadMigrations()) writeFileSync(join(dir, f.name), f.sql);
      const db = await fresh();
      const next = (k: number) => String(loadMigrations().length + k).padStart(4, "0");
      writeFileSync(join(dir, `${next(1)}_extra.sql`), "create table extra (id int); insert into extra values (1);");
      expect(await migrate(db, loadMigrations(dir))).toBe(1);
      expect((await db.get<{ n: number }>("select count(*) n from extra"))!.n).toBe(1);
      writeFileSync(join(dir, `${next(2)}_broken.sql`), "create table broken (id int); select * from нет_такой_таблицы;");
      await expect(migrate(db, loadMigrations(dir))).rejects.toThrow();
      expect(await db.get("select to_regclass('broken') r")).toEqual({ r: null });
      expect((await db.all("select version from schema_migrations")).length).toBe(loadMigrations(dir).length - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("каталог миграций: только NNNN_имя.sql, без пропусков", () => {
    const names = readdirSync(join(config.root, "apps/api/src/db/migrations"));
    expect(names.every((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))).toBe(true);
    expect(loadMigrations().map((m) => m.version)).toEqual(names.map((_, i) => i + 1));
  });
});

describe("базы тестов изолированы", () => {
  it("запись в одной базе не видна в другой, открытой из того же шаблона", async () => {
    const a = await fresh();
    const b = await fresh();
    await setMeta(a, "k", "a");
    expect(await meta(a, "k")).toBe("a");
    expect(await meta(b, "k")).toBe("");
  });
});

describe("транзакции", () => {
  it("tx фиксирует всё или ничего", async () => {
    const db = await fresh();
    await db.tx(async (t) => {
      await setMeta(t, "ok", "1");
    });
    await expect(db.tx(async (t) => {
      await setMeta(t, "lost", "1");
      throw new Error("сбой посреди транзакции");
    })).rejects.toThrow("сбой посреди");
    expect(await meta(db, "ok")).toBe("1");
    expect(await meta(db, "lost")).toBe("");
  });

  it("вложенный tx — точка сохранения: откатывается только вложенная часть", async () => {
    const db = await fresh();
    await db.tx(async (t) => {
      await setMeta(t, "outer", "1");
      await t.tx(async (s) => {
        await setMeta(s, "inner", "1");
        throw new Error("внутри");
      }).catch(() => undefined);
      await t.tx(async (s) => setMeta(s, "inner2", "1"));
    });
    expect([await meta(db, "outer"), await meta(db, "inner"), await meta(db, "inner2")]).toEqual(["1", "", "1"]);
  });

  it("ошибка SQL внутри tx откатывает транзакцию и доходит до вызывающего", async () => {
    const db = await fresh();
    await expect(db.tx(async (t) => {
      await setMeta(t, "x", "1");
      await t.run("insert into users (id) values ($1)", ["u-bad"]); // нарушает not null
    })).rejects.toThrow();
    expect(await meta(db, "x")).toBe("");
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(5);
  });

  it("параллельное чтение не видит незафиксированное: откаченная запись не видна ни во время, ни после", async () => {
    // Гарантия общая для обоих движков: PGlite ставит чтение в очередь за транзакцией, сервер (read committed)
    // читает зафиксированное состояние другим соединением пула. В обоих случаях грязного чтения нет.
    const db = await fresh();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.tx(async (t) => {
      await setMeta(t, "dirty", "1");
      await gate;
      throw new Error("откат");
    });
    const during = meta(db, "dirty");
    release();
    await expect(tx).rejects.toThrow("откат");
    expect(await during).toBe("");
    expect(await meta(db, "dirty")).toBe("");
  });

  it("после фиксации транзакции запись видна любому чтению", async () => {
    const db = await fresh();
    await db.tx(async (t) => setMeta(t, "committed", "1"));
    expect(await meta(db, "committed")).toBe("1");
  });
});

describe("типы и ограничения", () => {
  it("identity и RETURNING, rowCount у UPDATE и DELETE", async () => {
    const db = await fresh();
    const ts = new Date().toISOString();
    // audit_log только дописывается (0002) — UPDATE/DELETE проверяются на уведомлениях
    const ins = "insert into notifications (user_role, level, message, created_at) values ($1, $2, $3, $4) returning id";
    const a = await db.run(ins, ["inspector", "INFO", "A", ts]);
    const b = await db.run(ins, ["inspector", "INFO", "B", ts]);
    expect(typeof a.rows[0].id).toBe("number");
    expect(b.rows[0].id).toBe(a.rows[0].id + 1);
    expect((await db.run("update notifications set level = $1 where message in ($2, $3)", ["WARNING", "A", "B"])).rowCount).toBe(2);
    expect((await db.run("delete from notifications where message = $1", ["нет"])).rowCount).toBe(0);
  });

  it("timestamptz возвращается тем же ISO, что записан; count(*) — число; boolean — boolean; json — текст", async () => {
    const db = await fresh();
    const ts = "2026-09-26T18:07:32.642Z";
    await db.run("insert into notifications (user_role, level, message, created_at) values ($1, $2, $3, $4)", ["inspector", "INFO", "m", ts]);
    const n = await db.get<Record<string, unknown>>("select created_at, read, count(*) over () total from notifications");
    expect(n).toEqual({ created_at: ts, read: false, total: 1 });
    const p = await db.get<{ compare_json: string; is_active: boolean; min_value: number | null }>("select compare_json, is_active, min_value from params where code = 'M-001'");
    expect(typeof p!.compare_json).toBe("string");
    expect(JSON.parse(p!.compare_json)).toMatchObject({ kind: "delta_pct" });
    expect(p!.is_active).toBe(true);
  });

  it("json хранит текст байт в байт — порядок ключей и пробелы не меняются (хеши протоколов)", async () => {
    const db = await fresh();
    const body = '{"b": 1,  "a": [2, 1]}';
    await db.run("insert into retraining_reports (since, until, body_json, created_at) values ($1, $2, $3, $4)", ["s", "u", body, new Date().toISOString()]);
    expect((await db.get<{ body_json: string }>("select body_json from retraining_reports"))!.body_json).toBe(body);
    await expect(db.run("insert into retraining_reports (since, until, body_json, created_at) values ($1, $2, $3, $4)", ["s", "u2", "{не json", new Date().toISOString()])).rejects.toThrow();
  });

  it("уникальность и внешние ключи держит база", async () => {
    const db = await fresh();
    await expect(db.run("insert into users (id, login, name, role, password_hash) values ('u-x', 'inspector', 'n', 'inspector', 'h')")).rejects.toThrow();
    await expect(db.run("insert into inspections (id, object_id, status, created_at, updated_at) values ('i', 'нет-объекта', 'NEW', now(), now())")).rejects.toThrow();
  });
});

// ─────────────────────────────── аудит 2026-09-26: HIGH-1 (кто накатывает схему), HIGH-4 (учётки эксплуатации)
async function empty(): Promise<DB> {
  const db = await openDb("memory", { mode: "none" });
  open.push(db);
  return db;
}

describe("режимы миграций", () => {
  it("mode none — пустая база: ни схемы, ни сидов", async () => {
    const db = await empty();
    expect(await db.get("select to_regclass('schema_migrations') r")).toEqual({ r: null });
  });

  it("verify (профиль gpu): пустая база и непустой план — отказ старта; накатанная — проходит, ничего не пишет", async () => {
    const db = await empty();
    await expect(verifySchema(db)).rejects.toThrow("схема не накатана: в базе нет schema_migrations — запустите api-migrate");
    await migrate(db, loadMigrations().slice(0, loadMigrations().length - 1)); // все, кроме последней (пусто при одной)
    await expect(verifySchema(db)).rejects.toThrow(/не применены .*\.sql — запустите api-migrate/);
    await migrate(db);
    await expect(verifySchema(db)).resolves.toBeUndefined();
    expect((await db.get<{ n: number }>("select count(*) n from params"))!.n).toBe(0); // verify и migrate не сеют
  });

  it("verify: подмена контрольной суммы в журнале — отказ старта", async () => {
    const db = await fresh();
    await db.run("update schema_migrations set checksum = $1 where version = 1", ["0".repeat(64)]);
    await expect(verifySchema(db)).rejects.toThrow("изменена после применения");
  });

  it("apply в dev: миграции, справочники, Матрица и 5 демо-учёток", async () => {
    const db = await empty();
    expect(await applySchema(db, "dev")).toBe(loadMigrations().length);
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(5);
    expect(await applySchema(db, "dev")).toBe(0); // повторно — ничего, учётки не дублируются
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(5);
  });

  it("apply в gpu (служба миграций): справочники и Матрица есть, демо-учёток нет", async () => {
    const db = await empty();
    await applySchema(db, "gpu");
    expect((await db.get<{ n: number }>("select count(*) n from params"))!.n).toBe(132);
    expect((await db.get<{ n: number }>("select count(*) n from legal_acts"))!.n).toBe(13);
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(0);
  });

  it("журнал миграций закрывается от роли приложения, только если роль есть (на PGlite её нет)", async () => {
    const db = await fresh();
    expect(await restrictMigrationJournal(db)).toBe(false);
  });
});

describe("первый администратор эксплуатации (HIGH-4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-"));
  const pwFile = join(dir, "pw");
  writeFileSync(pwFile, "Kx9-long-enough-pass\n");

  it("пустая users + секрет — один admin с паролем из файла (scrypt, без перевода строки)", async () => {
    const db = await empty();
    await applySchema(db, "gpu");
    expect(await bootstrapAdmin(db, { login: "admin", passwordFile: pwFile })).toBe("create");
    const u = (await db.all<{ id: string; name: string; login: string; role: string; password_hash: string }>("select id, name, login, role, password_hash from users"));
    expect(u.map((r) => [r.login, r.role])).toEqual([["admin", "admin"]]);
    expect(u[0].id).toMatch(/^u-[0-9a-f-]{36}$/);
    expect(u[0].name).toBe("Администратор");
    const [salt, hash] = u[0].password_hash.split(":");
    expect(scryptSync("Kx9-long-enough-pass", salt, 32).toString("hex")).toBe(hash);
    expect(await bootstrapAdmin(db, { login: "admin", passwordFile: pwFile })).toBe("skip-users-exist"); // повтор — ничего
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(1);
  });

  it("пустая users без секрета — ничего; есть пользователи — секрет не читается (даже несуществующий)", async () => {
    const db = await empty();
    await applySchema(db, "gpu");
    expect(await bootstrapAdmin(db, { login: "admin", passwordFile: null })).toBe("skip-no-secret");
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(0);
    const dev = await fresh();
    expect(await bootstrapAdmin(dev, { login: "admin", passwordFile: join(dir, "нет-файла") })).toBe("skip-users-exist");
  });

  it("из секрета срезается только завершающий перевод строки: внутренний — часть пароля", async () => {
    const db = await empty();
    await applySchema(db, "gpu");
    const f = join(dir, "multiline");
    writeFileSync(f, "Kx9-long\nenough-pass\r\n");
    expect(await bootstrapAdmin(db, { login: "admin", passwordFile: f })).toBe("create");
    const [salt, hash] = (await db.get<{ password_hash: string }>("select password_hash from users"))!.password_hash.split(":");
    expect(scryptSync("Kx9-long\nenough-pass", salt, 32).toString("hex")).toBe(hash);
  });

  it("слабый пароль в секрете — отказ, учётка не создаётся", async () => {
    const db = await empty();
    await applySchema(db, "gpu");
    const weak = join(dir, "weak");
    writeFileSync(weak, "short\n");
    await expect(bootstrapAdmin(db, { login: "admin", passwordFile: weak })).rejects.toThrow("короче 12");
    expect((await db.get<{ n: number }>("select count(*) n from users"))!.n).toBe(0);
  });
});

describe("сиды — контракт слоя данных", () => {
  it("демо-учётки dev: ровно пять, с id, ФИО и ролями", async () => {
    const db = await fresh();
    expect(await db.all("select id, login, name, role from users order by id")).toEqual([
      { id: "u-adm", login: "admin", name: "Администратор", role: "admin" },
      { id: "u-cur", login: "curator", name: "Кузнецова Е. М.", role: "curator" },
      { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" },
      { id: "u-ml", login: "ml", name: "Сидоров К. Л.", role: "ml_engineer" },
      { id: "u-sup", login: "supervisor", name: "Петров Д. В.", role: "supervisor" },
    ]);
  });

  it("Матрица переносится полями как есть: логика срабатывания, приоритет, regex", async () => {
    const db = await fresh();
    const m = JSON.parse(readFileSync(join(config.root, "data/seed/matrix.json"), "utf8")) as Array<Record<string, unknown>>;
    const rows = await db.all<{ code: string; trigger_logic: string; review_priority: string; regex_pattern: string | null }>("select code, trigger_logic, review_priority, regex_pattern from params order by id");
    expect(rows.map((r) => [r.code, r.trigger_logic, r.review_priority, r.regex_pattern])).toEqual(m.map((p) => [p.code, p.trigger_logic ?? "", p.review_priority ?? "MEDIUM", p.regex_pattern ?? null]));
    expect(rows.filter((r) => r.regex_pattern).length).toBeGreaterThan(0);
  });

  it("логическое правило «лифт при 10+ этажах» и три норматива", async () => {
    const db = await fresh();
    expect(await db.all("select rule_name, condition_json, expected_json from logical_rules")).toEqual([
      { rule_name: "Здание выше 10 этажей оборудуется лифтом", condition_json: '{"key":"M-007","op":">","value":10}', expected_json: '{"key":"LIFTS","op":">","value":0}' },
    ]);
    // три норматива нормативного анализа гипотез (param_code); нормы CMP-06 из сида norms.json — с norm_key (T-234)
    expect(await db.all("select document_number, section, parameter_name, param_code, min_value from normative_base where norm_key is null order by id")).toEqual([
      { document_number: "СП 1.13130.2020", section: "п. 4.2.5", parameter_name: "Ширина эвакуационных выходов", param_code: "M-041", min_value: 0.8 },
      { document_number: "СП 1.13130.2020", section: "п. 4.3.4", parameter_name: "Ширина эвакуационных коридоров", param_code: "M-040", min_value: 1 },
      { document_number: "СП 54.13330.2022", section: "п. 5.12", parameter_name: "Высота помещений", param_code: null, min_value: 2.5 },
    ]);
  });
});

describe("база в каталоге (pglite:<каталог>) и жизненный цикл", () => {
  it("первое открытие накатывает схему и сиды, повторное — сверяет и видит прежние данные", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgdir-"));
    try {
      const a = await openDb(`pglite:${join(dir, "data")}`);
      expect((await a.get<{ n: number }>("select count(*) n from params"))!.n).toBe(132);
      await setMeta(a, "persist", "1");
      await a.close();
      const b = await openDb(`pglite:${join(dir, "data")}`);
      expect(await meta(b, "persist")).toBe("1");
      expect((await b.get<{ n: number }>("select count(*) n from schema_migrations"))!.n).toBe(loadMigrations().length);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close() внутри транзакции базу не закрывает; повторный close() безопасен", async () => {
    const db = await openDb("memory");
    await db.tx(async (t) => {
      await t.close();
      await setMeta(t, "after-inner-close", "1");
    });
    expect(await meta(db, "after-inner-close")).toBe("1");
    await db.close();
    await db.close();
  });

  it("пустая переменная паритета (одни пробелы) — база в памяти, а не сервер", async () => {
    const prev = process.env.INSPECTOR_TEST_DATABASE_URL;
    if (prev?.trim()) return; // в прогоне паритета переменная задана по делу — проверка не о нём
    process.env.INSPECTOR_TEST_DATABASE_URL = "   ";
    try {
      const db = await fresh();
      expect(db.kind).toBe("pglite");
    } finally {
      if (prev === undefined) delete process.env.INSPECTOR_TEST_DATABASE_URL;
      else process.env.INSPECTOR_TEST_DATABASE_URL = prev;
    }
  });
});
