// NFR-PDN (ТЗ 12.6-01, 152-ФЗ): маршруты администратора, минимизация выдачи, маскирование логов, обезличивание по сроку
// и неизменяемость журнала аудита (единственное исключение — функция БД pdn_anonymize_audit).
// Эшелоны: L4 — интеграция с БД и HTTP (PGlite), L6 — отказы и попытки обойти журнал, L7 — дисциплина логов.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maskCounterparty } from "../src/domain/pdn.ts";
import type { DB } from "../src/db.ts";

const TMP = mkdtempSync(join(tmpdir(), "inspector-pdn-"));
let app: any;
let db: any;
let hashPassword: (pw: string) => string;
const tokens: Record<string, string> = {};
const DAY = 86400_000;

const login = (l: string, password = "test-pass") => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: l, password }, headers: { "user-agent": "pdn-test/1.0" } });
const get = (url: string, who: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[who]}` } });
const post = (url: string, who: string) => app.inject({ method: "POST", url, headers: { authorization: `Bearer ${tokens[who]}` } });
const sqlState = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e: any) {
    return e?.code ?? String(e);
  }
};
const putAudit = (user: string | null, action: string, ts: string, ip: string | null, ua: string | null) =>
  db.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7)", [user, action, null, "{}", ts, ip, ua]);
const addUser = (id: string, l: string, name: string, role = "inspector") =>
  db.run("insert into users (id, login, name, role, password_hash) values ($1,$2,$3,$4,$5)", [id, l, name, role, hashPassword("test-pass")]);

/** Перехват строк JSON-лога: log() молчит под VITEST — на время замера флаг снимается. */
async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const saved = process.env.VITEST;
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  delete process.env.VITEST;
  (process.stdout as any).write = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as any).write = write;
    process.env.VITEST = saved;
  }
  return out;
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const dbm = await import("../src/db.ts");
  hashPassword = dbm.hashPassword;
  const { buildApp } = await import("../src/app.ts");
  db = await dbm.openDb("memory");
  app = buildApp(db);
  for (const l of ["inspector", "supervisor", "admin", "ml", "curator"]) tokens[l] = (await login(l)).json().token;
  const t = new Date().toISOString();
  await db.run("insert into objects (id, name, customer, contractor, created_at) values ($1,$2,$3,$4,$5)", ["O-PDN", "ЖК «Сосны»", "ИП Смирнов Олег Петрович", "ООО «Стройка»", t]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$5)", ["P-PDN", "O-PDN", "VERIFYING", 1, t]);
  await db.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7)", ["u-insp", "VERIFICATION_OPENED", "P-PDN", "{}", t, "10.20.30.40", "Mozilla/5.0"]);
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("реестр ПДн и сведения субъекту (NFR-PDN п. 1, п. 5)", () => {
  it("реестр ПДн отдаётся только администратору: строки с целью, основанием и сроком", async () => {
    expect((await get("/api/v1/admin/pdn/registry", "supervisor")).statusCode).toBe(403);
    const r = await get("/api/v1/admin/pdn/registry", "admin");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.registry.some((x: any) => x.table === "users" && x.column === "name" && /ст\. 6/.test(x.basis))).toBe(true);
    expect(b.retention).toEqual({ user_days: 30, audit_days: 365 });
  });

  it("сведения субъекту: все ПДн пользователя и где лежат; обращение пишется в аудит как PDN_ACCESS", async () => {
    await putAudit("u-sup", "LOGIN", new Date().toISOString(), "10.0.0.7", "UA-sup");
    const r = await get("/api/v1/admin/pdn/subject/u-sup", "admin");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.user).toMatchObject({ id: "u-sup", login: "supervisor", name: "Петров Д. В.", role: "supervisor", deactivated_at: null });
    expect(b.audit.records).toBeGreaterThan(0);
    expect(b.audit.ip_addresses).toContain("10.0.0.7");
    expect(b.locations.map((l: any) => `${l.table}.${l.column}`)).toEqual(expect.arrayContaining(["users.name", "users.login", "audit_log.ip_address", "audit_log.user_agent", "protocols.body_json"]));
    const acc = await db.get("select user_id, object_id from audit_log where action = 'PDN_ACCESS' order by id desc limit 1");
    expect(acc).toEqual({ user_id: "u-adm", object_id: "u-sup" });
    expect((await get("/api/v1/admin/pdn/subject/нет-такого", "admin")).statusCode).toBe(404);
    expect((await get("/api/v1/admin/pdn/subject/u-sup", "supervisor")).statusCode).toBe(403);
  });
});

describe("выключение учётки (NFR-PDN п. 4)", () => {
  it("администратор выключает учётку: deactivated_at, сессии удалены, старый токен и вход — 401, аудит USER_DEACTIVATED", async () => {
    await addUser("u-gone", "gone", "Уходящий Инспектор Иванович");
    tokens.gone = (await login("gone")).json().token;
    expect((await get("/api/v1/auth/me", "gone")).statusCode).toBe(200);
    expect((await post("/api/v1/admin/users/u-gone/deactivate", "supervisor")).statusCode).toBe(403);
    const r = await post("/api/v1/admin/users/u-gone/deactivate", "admin");
    expect(r.statusCode).toBe(200);
    expect(r.json().deactivated_at).toBeTruthy();
    expect((await get("/api/v1/auth/me", "gone")).statusCode).toBe(401);
    expect((await login("gone")).statusCode).toBe(401);
    expect((await db.get("select count(*)::int n from sessions where user_id = 'u-gone'")).n).toBe(0);
    expect(await db.get("select object_id from audit_log where action = 'USER_DEACTIVATED' order by id desc limit 1")).toEqual({ object_id: "u-gone" });
    // повтор — та же отметка времени, не новая
    expect((await post("/api/v1/admin/users/u-gone/deactivate", "admin")).json().deactivated_at).toBe(r.json().deactivated_at);
  });
  it("выключить себя нельзя (409), несуществующую учётку — 404", async () => {
    expect((await post("/api/v1/admin/users/u-adm/deactivate", "admin")).statusCode).toBe(409);
    expect((await post("/api/v1/admin/users/nobody/deactivate", "admin")).statusCode).toBe(404);
  });
});

describe("обезличивание по сроку (NFR-PDN п. 4, ст. 21 ч. 7)", () => {
  it("учётка, выключенная 31 день назад, обезличена; выключенная 5 дней назад — нет; IP/UA старше 365 дней обнулены; итог — PDN_RETENTION", async () => {
    const { runRetention } = await import("../src/services/pdn.ts");
    const now = new Date("2027-01-15T03:00:00Z");
    await addUser("u-old", "old", "Старов Старый Старович");
    await addUser("u-new", "fresh", "Новиков Новый Новович");
    await db.run("update users set deactivated_at = $1 where id = 'u-old'", [new Date(now.getTime() - 31 * DAY).toISOString()]);
    await db.run("update users set deactivated_at = $1 where id = 'u-new'", [new Date(now.getTime() - 5 * DAY).toISOString()]);
    await db.run("insert into sessions (token_hash, user_id, created_at, expires_at) values ($1,'u-old',$2,$3)", ["a".repeat(64), now.toISOString(), new Date(now.getTime() + DAY).toISOString()]);
    await putAudit("u-old", "OLD_EVENT", new Date(now.getTime() - 366 * DAY).toISOString(), "172.16.0.9", "Old/1");
    await putAudit("u-old", "FRESH_EVENT", new Date(now.getTime() - 364 * DAY).toISOString(), "172.16.0.10", "Fresh/1");

    const res = await runRetention(db, now, { userDays: 30, auditDays: 365 });
    expect(res.users).toBeGreaterThanOrEqual(1); // и u-gone из теста выключения: к этой дате прошло больше 30 дней
    expect(res.audit_rows).toBeGreaterThanOrEqual(1);
    expect(await db.get("select name, login, password_hash from users where id = 'u-old'")).toEqual({ name: "Обезличен #u-old", login: "deleted-u-old", password_hash: "!anonymized" });
    expect(await db.get("select name, login from users where id = 'u-new'")).toEqual({ name: "Новиков Новый Новович", login: "fresh" });
    expect((await db.get("select count(*)::int n from sessions where user_id = 'u-old'")).n).toBe(0);
    expect(await db.get("select action, ip_address, user_agent, user_id from audit_log where action = 'OLD_EVENT'")).toEqual({ action: "OLD_EVENT", ip_address: null, user_agent: null, user_id: "u-old" });
    expect(await db.get("select ip_address, user_agent from audit_log where action = 'FRESH_EVENT'")).toEqual({ ip_address: "172.16.0.10", user_agent: "Fresh/1" });
    const done = await db.get("select details from audit_log where action = 'PDN_RETENTION' order by id desc limit 1");
    const d = JSON.parse(done.details);
    expect(d.user_ids).toContain("u-old");
    expect(d.user_ids).not.toContain("u-new");
    expect(d).toMatchObject({ users_anonymized: res.users, audit_cutoff: new Date(now.getTime() - 365 * DAY).toISOString() });
    // повтор ничего не меняет: обезличенная учётка не обезличивается снова
    expect((await runRetention(db, now, { userDays: 30, auditDays: 365 })).users).toBe(0);
  });

  it("задача по расписанию выполняется раз в сутки: второй тик того же дня — пропуск, следующего — запуск", async () => {
    const { runRetentionIfDue } = await import("../src/services/pdn.ts");
    const d1 = new Date("2027-02-01T01:00:00Z");
    expect(await runRetentionIfDue(db, d1, { userDays: 30, auditDays: 365 })).not.toBeNull();
    expect(await runRetentionIfDue(db, new Date("2027-02-01T23:00:00Z"), { userDays: 30, auditDays: 365 })).toBeNull();
    expect(await runRetentionIfDue(db, new Date("2027-02-02T00:10:00Z"), { userDays: 30, auditDays: 365 })).not.toBeNull();
  });
});

describe("журнал аудита остаётся неизменяемым (NFR-PDN п. 4, HIGH-2)", () => {
  it("прямой UPDATE любой колонки — отказ 42501, даже обнуление IP в обход функции; DELETE — отказ", async () => {
    await putAudit("u-insp", "GUARD_EVENT", "2020-01-01T00:00:00Z", "1.2.3.4", "G/1");
    expect(await sqlState(db.run("update audit_log set action = 'X' where action = 'GUARD_EVENT'"))).toBe("42501");
    expect(await sqlState(db.run("update audit_log set ip_address = null where action = 'GUARD_EVENT'"))).toBe("42501");
    expect(await sqlState(db.run("update audit_log set user_id = 'u-sup', ip_address = null, user_agent = null where action = 'GUARD_EVENT'"))).toBe("42501");
    expect(await sqlState(db.run("delete from audit_log where action = 'GUARD_EVENT'"))).toBe("42501");
  });
  it("функция pdn_anonymize_audit меняет только IP и UA записей старше границы, остальные колонки — прежние", async () => {
    await putAudit("u-insp", "FN_EVENT", "2020-01-02T00:00:00Z", "5.6.7.8", "F/1");
    const before = await db.get("select id, user_id, action, object_id, details, timestamp from audit_log where action = 'FN_EVENT'");
    const n = (await db.get("select pdn_anonymize_audit($1) n", ["2021-01-01T00:00:00Z"])).n;
    expect(Number(n)).toBeGreaterThanOrEqual(1);
    expect(await db.get("select id, user_id, action, object_id, details, timestamp from audit_log where action = 'FN_EVENT'")).toEqual(before);
    expect(await db.get("select ip_address, user_agent from audit_log where action = 'FN_EVENT'")).toEqual({ ip_address: null, user_agent: null });
    // после функции флаг сеанса не остаётся открытым: прямой UPDATE снова запрещён
    expect(await sqlState(db.run("update audit_log set ip_address = null where action = 'VERIFICATION_OPENED'"))).toBe("42501");
  });
  it("флаг сеанса вручную не открывает журнал: свежая запись — отказ, чужая роль — отказ даже для старой (OWASP T-137, миграция 0012)", async () => {
    await putAudit("u-insp", "GUC_OLD", "2020-03-03T00:00:00Z", "7.7.7.7", "G/1");
    await putAudit("u-insp", "GUC_NEW", new Date(Date.now() - 5 * 86400_000).toISOString(), "8.8.8.8", "G/2");
    const flagged = (sql: string) => db.tx(async (t: DB) => {
      await t.run("select set_config('inspector.pdn_anonymize', 'on', true)");
      await t.run(sql);
    });
    expect(await sqlState(flagged("update audit_log set ip_address = null, user_agent = null where action = 'GUC_NEW'"))).toBe("42501");
    await db.exec("do $$ begin if not exists (select 1 from pg_roles where rolname = 'guc_intruder') then create role guc_intruder; end if; end $$;");
    await db.exec("grant update, select on audit_log to guc_intruder");
    expect(await sqlState(db.tx(async (t: DB) => {
      await t.run("set local role guc_intruder");
      await t.run("select set_config('inspector.pdn_anonymize', 'on', true)");
      await t.run("update audit_log set ip_address = null, user_agent = null where action = 'GUC_OLD'");
    }))).toBe("42501");
    expect(await db.get("select ip_address from audit_log where action = 'GUC_OLD'")).toEqual({ ip_address: "7.7.7.7" });
    expect(await db.get("select ip_address from audit_log where action = 'GUC_NEW'")).toEqual({ ip_address: "8.8.8.8" });
  });
  it("функция pdn_anonymize_audit не трогает записи моложе 90 дней, какую бы границу ни передал вызывающий (OWASP T-137 E3-M3)", async () => {
    await putAudit("u-insp", "E3M3_RECENT_EVENT", new Date(Date.now() - 10 * 86400_000).toISOString(), "9.9.9.9", "N/1");
    expect(await sqlState(db.get("select pdn_anonymize_audit($1) n", [new Date(Date.now() + 86400_000).toISOString()]))).toBe("22023");
    expect(await sqlState(db.get("select pdn_anonymize_audit($1) n", [new Date(Date.now() - 89 * 86400_000).toISOString()]))).toBe("22023");
    expect(await db.get("select ip_address, user_agent from audit_log where action = 'E3M3_RECENT_EVENT'")).toEqual({ ip_address: "9.9.9.9", user_agent: "N/1" });
  });
});

describe("минимизация выдачи (NFR-PDN п. 3)", () => {
  it("карточка проверки: застройщик и подрядчик — инспектору, супервизору, администратору; ML-инженеру и куратору — отказ, маска — второй рубеж", async () => {
    for (const who of ["inspector", "supervisor", "admin"]) expect((await get("/api/v1/inspections/P-PDN", who)).json().object).toMatchObject({ customer: "ИП Смирнов Олег Петрович", contractor: "ООО «Стройка»" });
    // ML-инженеру и куратору карточка проверки закрыта матрицей прав (T-139, inspection.read) — строже маски;
    // маска maskCounterparty остаётся вторым рубежом, если право когда-нибудь расширят
    for (const who of ["ml", "curator"]) expect((await get("/api/v1/inspections/P-PDN", who)).statusCode).toBe(403);
    expect(maskCounterparty({ id: "O-PDN", customer: "ИП Смирнов Олег Петрович", contractor: "ООО «Стройка»" }, "ml_engineer")).toMatchObject({ customer: "***", contractor: "***" });
  });
  it("карточка проверки: в журнале карточки нет IP-адреса и User-Agent", async () => {
    const audit = (await get("/api/v1/inspections/P-PDN", "inspector")).json().audit;
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) {
      expect(a).not.toHaveProperty("ip_address");
      expect(a).not.toHaveProperty("user_agent");
    }
  });
  it("журнал аудита: администратор видит полный IP, супервизор — с нулём в последнем октете", async () => {
    const url = "/api/v1/audit?action=VERIFICATION_OPENED&limit=5";
    expect((await get(url, "admin")).json()[0].ip_address).toBe("10.20.30.40");
    expect((await get(url, "supervisor")).json()[0].ip_address).toBe("10.20.30.0");
  });
  it("в «РиН» уходит user_id решения без ФИО инспектора", async () => {
    const { rinPayload } = await import("../src/services/rin.ts");
    const body = {
      process_id: "P", object: { id: "O" }, protocol_version: 1, versions: {}, input_files: [],
      sections: { confirmed_violations: [{ finding_id: "c1", decision: { user_id: "u-insp", user_name: "Иванова А. С.", action: "confirm", reason_code: null, comment: null, created_at: "t" } }] },
      ai_usage: null,
    };
    const p = rinPayload(body);
    expect(p.confirmed_violations[0].decision).toEqual({ user_id: "u-insp", action: "confirm", reason_code: null, comment: null, created_at: "t" });
    expect(JSON.stringify(p)).not.toContain("Иванова");
    // снимок протокола не меняется: минимизация — только в передаваемой копии
    expect(body.sections.confirmed_violations[0].decision.user_name).toBe("Иванова А. С.");
  });
});

describe("маскирование в логах (NFR-PDN п. 2)", () => {
  it("строка ответа пишет путь без значений параметров запроса", async () => {
    const out = await captureLog(() => get("/api/v1/audit?user=u-insp&action=LOGIN&limit=5", "admin"));
    expect(out).toContain("/api/v1/audit?user=***&action=***&limit=5 200");
    expect(out).not.toContain("user=u-insp");
  });
  it("поля и текст лога маскируются: e-mail, телефон, СНИЛС, ФИО и логин по ключу, стек ошибки", async () => {
    const { log } = await import("../src/services/audit.ts");
    const out = await captureLog(async () => log("ERROR", "unhandled: ivanova@mos.ru", { message: "звонок на +7 916 123-45-67", stack: "Error: СНИЛС 112-233-445 95\n    at x", login: "ivanova", name: "Иванова А. С.", ip: "10.1.2.3" }));
    const line = JSON.parse(out.trim());
    expect(line).toMatchObject({ message: "звонок на +7***-**-67", stack: "Error: СНИЛС ***-***-*** 95\n    at x", login: "***", name: "***", ip: "10.1.2.0" });
    expect(out).not.toMatch(/ivanova@|916|Иванова/);
  });
  it("ошибка внешней системы (автозабор «РиН») доходит до журнала и сводки уже замаскированной", async () => {
    const { pollRin, rinCtx, setRinPullTransport } = await import("../src/services/rin-pull.ts");
    setRinPullTransport(async () => {
      throw new Error("отказ шлюза: оператор petrov@rin.mos.ru, тел. 8 (495) 123-45-67");
    });
    let summary: any;
    const out = await captureLog(async () => {
      summary = await pollRin(rinCtx(db));
    });
    expect(summary.error).toContain("отказ шлюза: оператор p***@rin.mos.ru, тел. +7***-**-67");
    expect(out).not.toMatch(/petrov@|495/);
  });
});
