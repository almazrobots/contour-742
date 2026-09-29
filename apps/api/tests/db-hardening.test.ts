// Миграция 0002_hardening и код вокруг неё (OWASP-аудит слоя данных 2026-09-26: HIGH-2, HIGH-3, M-2, M-3, M-4, M-6, M-7).
// L4 — интеграция с БД (PGlite; паритет — INSPECTOR_TEST_DATABASE_URL), L6 — отказы и безопасность.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-hardening-"));
let app: any;
let db: any;
let openDb: typeof import("../src/db.ts").openDb;
let tokenHash: typeof import("../src/domain/security.ts").tokenHash;
const tokens: Record<string, string> = {};

const login = (l: string, password = "test-pass") => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: l, password } });
const get = (url: string, who?: string) => app.inject({ method: "GET", url, headers: who ? { authorization: `Bearer ${tokens[who]}` } : {} });
/** Код ошибки PostgreSQL (SQLSTATE) или null, если оператор прошёл. */
const sqlState = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e: any) {
    return e?.code ?? String(e);
  }
};
const now = () => new Date().toISOString();

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  ({ openDb } = await import("../src/db.ts"));
  ({ tokenHash } = await import("../src/domain/security.ts"));
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  for (const l of ["inspector", "supervisor", "admin"]) tokens[l] = (await login(l)).json().token;
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("HIGH-2 журналы только дописываются", () => {
  it("audit_log: UPDATE, DELETE, TRUNCATE — 42501, строка не изменилась", async () => {
    const id = (await db.run("insert into audit_log (action, details, timestamp) values ($1, $2, $3) returning id", ["T_HARD", "исходно", now()])).rows[0].id;
    expect(await sqlState(db.run("update audit_log set details = 'подмена' where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.run("delete from audit_log where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.exec("truncate audit_log"))).toBe("42501");
    expect((await db.get("select details from audit_log where id = $1", [id])).details).toBe("исходно");
  });

  it("rejection_log, dispute_log, prescription_events: изменить и удалить нельзя", async () => {
    await db.run("insert into rejection_log (check_id, inspection_id, param_code, ai_verdict, reason_code, comment, suggested_fix, user_id, created_at) values ('c','i','M-1','CANDIDATE','OCR_ERROR','к','ф','u-insp',$1)", [now()]);
    await db.run("insert into dispute_log (check_id, inspection_id, param_code, kind, ai_comment, inspector_comment, user_id, created_at) values ('c','i','M-1','k','a','b','u-insp',$1)", [now()]);
    const { createInspection } = await import("../src/services/inspections.ts");
    const user = await db.get("select * from users where login = 'inspector'");
    const insp = await createInspection({ db, user }, { object_id: "HARD-PR-1", name: "Объект предписаний" });
    const ref = (await db.run("insert into prescriptions (inspection_id, prescription_id, current_status, current_event_at, created_at, updated_at) values ($1,'PR-1','ISSUED','2026-09-01',$2,$2) returning id", [insp, now()])).rows[0].id;
    await db.run("insert into prescription_events (prescription_ref, prescription_id, status, event_at, received_at) values ($1,'PR-1','ISSUED','2026-09-01',$2)", [ref, now()]);
    for (const [t, col] of [["rejection_log", "comment"], ["dispute_log", "inspector_comment"], ["prescription_events", "event_at"]]) {
      expect([t, await sqlState(db.run(`update ${t} set ${col} = 'подмена'`))]).toEqual([t, "42501"]);
      expect([t, await sqlState(db.run(`delete from ${t}`))]).toEqual([t, "42501"]);
      expect([t, await sqlState(db.exec(`truncate ${t}`))]).toEqual([t, "42501"]);
      expect([t, (await db.get(`select count(*) n from ${t} where ${col} = 'подмена'`)).n]).toEqual([t, 0]);
    }
  });

  it("decisions: разрешено только снять решение (superseded false → true); вернуть, править, удалить — 42501", async () => {
    const id = (await db.run("insert into decisions (check_id, user_id, action, status, comment, created_at) values ('C-D', 'u-insp', 'confirm', 'CONFIRMED_VIOLATION', 'исходно', $1) returning id", [now()])).rows[0].id;
    expect(await sqlState(db.run("update decisions set comment = 'подмена' where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.run("update decisions set status = 'NEGATIVE_VERIFIED', superseded = true where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.run("update decisions set superseded = true where id = $1", [id]))).toBeNull();
    expect(await sqlState(db.run("update decisions set superseded = true where id = $1", [id]))).toBeNull(); // повтор безвреден
    expect(await sqlState(db.run("update decisions set superseded = false where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.run("delete from decisions where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.exec("truncate decisions"))).toBe("42501");
    expect(await db.get("select comment, status, superseded from decisions where id = $1", [id])).toEqual({ comment: "исходно", status: "CONFIRMED_VIOLATION", superseded: true });
  });
});

describe("HIGH-3 в sessions — хеш токена", () => {
  it("открытого токена в базе нет; вход, /me и выход работают по хешу", async () => {
    const r = await login("inspector");
    expect(r.statusCode).toBe(200);
    const token = r.json().token as string;
    expect((await db.get("select count(*) n from sessions where token_hash = $1", [token])).n).toBe(0);
    expect((await db.get("select count(*) n from sessions where token_hash = $1", [tokenHash(token)])).n).toBe(1);
    expect((await db.all("select token_hash from sessions")).every((s: any) => /^[0-9a-f]{64}$/.test(s.token_hash))).toBe(true);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json().login).toBe("inspector");
    // хеш из дампа базы как Bearer не проходит
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${tokenHash(token)}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await db.get("select count(*) n from sessions where token_hash = $1", [tokenHash(token)])).n).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it("не-хеш в token_hash отвергается ограничением (23514)", async () => {
    expect(await sqlState(db.run("insert into sessions (token_hash, user_id, created_at, expires_at) values ('plain-token', 'u-insp', $1, $1)", [now()]))).toBe("23514");
  });

  it("M-6: истёкшие сессии удаляются при входе", async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    await db.run("insert into sessions (token_hash, user_id, created_at, expires_at) values ($1, 'u-insp', $2, $2)", [tokenHash("expired"), old]);
    await login("supervisor");
    expect((await db.get("select count(*) n from sessions where expires_at < $1", [now()])).n).toBe(0);
  });
});

describe("M-6 LOGIN_FAILED", () => {
  it("несуществующий логин (часто — пароль, введённый не в то поле) не пишется в журнал открытым текстом", async () => {
    expect((await login("Мой-Пароль-42", "x")).statusCode).toBe(401);
    expect((await login("inspector", "wrong")).statusCode).toBe(401);
    const rows = (await db.all("select details from audit_log where action = 'LOGIN_FAILED' order by id desc limit 2")).map((r: any) => JSON.parse(r.details));
    expect(rows[0]).toEqual({ login: "inspector" });
    expect(rows[1]).toMatchObject({ known: false, login_sha256: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(rows[1])).not.toContain("Пароль");
  });
});

describe("M-3 NUL-байт — 400 до базы и до аутентификации", () => {
  it("вход с NUL в логине — 400, а не 500", async () => {
    const r = await login("admin\u0000");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("NUL");
  });
  it("NUL в строке запроса — 400 и с сессией, и без неё (раньше — 500)", async () => {
    expect((await get("/api/v1/audit?action=%00", "supervisor")).statusCode).toBe(400);
    expect((await get("/api/v1/audit?action=%00")).statusCode).toBe(400);
  });
  it("NUL во вложенном JSON-теле и в параметре пути — 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/checks/X/decision", headers: { authorization: `Bearer ${tokens.inspector}` }, payload: { action: "confirm", comment: "ok", extra: [{ a: "\u0000" }] } });
    expect(r.statusCode).toBe(400);
    expect((await get("/api/v1/inspections/%00", "inspector")).statusCode).toBe(400);
  });
});

describe("M-4 CHECK на перечислимые колонки", () => {
  it("роль вне перечня (superadmin) и статусы вне словаря отвергаются (23514)", async () => {
    expect(await sqlState(db.run("insert into users (id, login, name, role, password_hash) values ('u-x', 'x', 'X', 'superadmin', 'h')"))).toBe("23514");
    expect(await sqlState(db.run("insert into users (id, login, name, role, password_hash) values ('u-y', 'y', 'Y', 'system', 'h')"))).toBe("23514");
    const insp = (await db.get("select id from inspections limit 1"))?.id;
    const ins = "insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, computed_in_version, created_at, updated_at) values ($1,$2,'M-001','g',$3,$4,1,$5,$5)";
    if (insp) {
      expect(await sqlState(db.run(ins, ["CK-1", insp, "CONFIRMED_VIOLATION", "PENDING", now()]))).toBe("23514"); // CONFIRMED_VIOLATION система не ставит
      expect(await sqlState(db.run(ins, ["CK-2", insp, "CANDIDATE", "CONFIRMED", now()]))).toBe("23514");
    }
    expect(await sqlState(db.run("insert into decisions (check_id, user_id, action, status, created_at) values ('c','u','approve','CONFIRMED_VIOLATION',$1)", [now()]))).toBe("23514");
    expect(await sqlState(db.run("insert into model_versions (model_version, approval_status, created_at) values ('m-x', 'APPROVED', $1)", [now()]))).toBe("23514");
    expect(await sqlState(db.run("insert into rin_packages (package_id, object_id, status, updated_at) values ('p', 'o', 'DONE', $1)", [now()]))).toBe("23514");
    expect(await sqlState(db.run("insert into rin_packages (package_id, object_id, status, updated_at) values ('p', 'o', 'IN_FLIGHT', $1)", [now()]))).toBeNull();
  });
  it("все роли демо-учёток проходят", async () => {
    expect((await db.all("select distinct role from users order by role")).map((r: any) => r.role)).toEqual(["admin", "curator", "inspector", "ml_engineer", "supervisor"]);
  });
});

describe("M-7 финализированный протокол неизменяем", () => {
  it("финализация, отмена и повторная финализация: прежний снимок не правится, отмена открывает новую версию", async () => {
    const { createInspection, finalize, unfinalize } = await import("../src/services/inspections.ts");
    const sup = await db.get("select * from users where login = 'supervisor'");
    const ctx = { db, user: sup, ip: "127.0.0.1", ua: "t" };
    const id = await createInspection(ctx, { object_id: "HARD-OBJ-1", name: "Объект M-7" });
    await db.run("update inspections set status = 'COMPLETED', protocol_version = 1 where id = $1", [id]);
    await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1, 1, 'DRAFT', '{}', $2)", [id, now()]);
    expect(await sqlState(db.run("update protocols set body_json = '{\"draft\":true}' where inspection_id = $1", [id]))).toBeNull(); // черновик правится

    await finalize(ctx, id);
    const v1 = await db.get("select body_json, input_manifest_hash, finalized_at from protocols where inspection_id = $1 and version = 1", [id]);
    expect(v1.finalized_at).not.toBeNull();
    expect(await sqlState(db.run("update protocols set body_json = '{}' where inspection_id = $1 and version = 1", [id]))).toBe("42501");
    expect(await sqlState(db.run("update protocols set version = 9 where inspection_id = $1 and version = 1", [id]))).toBe("42501");
    expect(await sqlState(db.run("update protocols set input_manifest_hash = 'x' where inspection_id = $1 and version = 1", [id]))).toBe("42501");
    expect(await sqlState(db.run("delete from protocols where inspection_id = $1 and version = 1", [id]))).toBe("42501");

    await unfinalize(ctx, id, "Ошибочно финализирован");
    expect(await db.get("select status, protocol_version, finalized_at from inspections where id = $1", [id])).toEqual({ status: "COMPLETED", protocol_version: 2, finalized_at: null });
    await finalize(ctx, id);
    const rows = await db.all("select version, status, body_json, finalized_at is not null fin from protocols where inspection_id = $1 order by version", [id]);
    expect(rows.map((r: any) => [r.version, r.status, r.fin])).toEqual([[1, "FINALIZED", true], [2, "FINALIZED", true]]);
    expect(rows[0].body_json).toBe(v1.body_json); // первый снимок — байт в байт
    const audit = JSON.parse((await db.get("select details from audit_log where action = 'FINALIZATION_CANCELLED' and object_id = $1", [id])).details);
    expect(audit).toMatchObject({ finalized_version: 1, draft_version: 2 });
  });
});

describe("M-2 лимиты выборок", () => {
  it("limit/offset на справочниках и журнале; умолчание не урезает интерфейс; за потолком — 400", async () => {
    const all = (await get("/api/v1/params", "inspector")).json();
    expect(all.length).toBe((await db.get("select count(*) n from params")).n);
    const p = (await get("/api/v1/params?limit=5&offset=2", "inspector")).json();
    expect(p.map((x: any) => x.id)).toEqual(all.slice(2, 7).map((x: any) => x.id));
    expect((await get("/api/v1/params?limit=501", "inspector")).statusCode).toBe(400);
    expect((await get("/api/v1/params?limit=abc", "inspector")).statusCode).toBe(400);
    expect((await get("/api/v1/audit?limit=2", "supervisor")).json()).toHaveLength(2);
    expect((await get("/api/v1/legal-acts?limit=3", "inspector")).json()).toHaveLength(3);
    expect((await get("/api/v1/normative?limit=1", "inspector")).json()).toHaveLength(1);
    expect((await get("/api/v1/notifications?limit=1", "admin")).statusCode).toBe(200);
  });

  it("дашборд проверок: limit/offset поверх фильтров", async () => {
    const { createInspection } = await import("../src/services/inspections.ts");
    const user = await db.get("select * from users where login = 'inspector'");
    for (const n of [1, 2, 3]) await createInspection({ db, user }, { object_id: `HARD-PAGE-${n}`, name: `Постраничный ${n}` });
    const full = (await get("/api/v1/inspections?q=Постраничный", "inspector")).json();
    expect(full).toHaveLength(3);
    const first = (await get("/api/v1/inspections?q=Постраничный&limit=2", "inspector")).json();
    const rest = (await get("/api/v1/inspections?q=Постраничный&limit=2&offset=2", "inspector")).json();
    expect([...first, ...rest].map((r: any) => r.process_id)).toEqual(full.map((r: any) => r.process_id));
    expect((await get("/api/v1/inspections?limit=0", "inspector")).statusCode).toBe(400);
  });
});
