// NFR-VERIFY-30 (ТЗ 9.3.6): событие открытия верификации и отчёт для протокола юзабилити-теста через app.inject.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-usability-"));
let app: any;
let db: any;
const tokens: Record<string, string> = {};

const T0 = Date.parse("2026-09-25T09:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const put = (user: string, action: string, objectId: string, min: number, details: unknown = {}) =>
  db.run("insert into audit_log (user_id, action, object_id, details, timestamp) values ($1,$2,$3,$4,$5)", [user, action, objectId, JSON.stringify(details), at(min)]);
const get = (url: string, who: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[who]}` } });

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  for (const login of ["inspector", "supervisor", "admin"]) {
    tokens[login] = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: "test-pass" } })).json().token;
  }
  // Два инспектора, две проверки: INS-A — полный цикл 20 минут; INS-B — без открытия, 31 минута
  await put("u-insp", "VERIFICATION_OPENED", "INS-A", 0);
  await put("u-insp", "DECISION_CONFIRM", "chk-a1", 5, { inspection_id: "INS-A" });
  await put("u-insp", "DECISION_REJECT", "chk-a2", 12, { inspection_id: "INS-A" });
  await put("u-insp", "PROTOCOL_FINALIZED", "INS-A", 20, { version: 1 });
  await put("u-sup", "DECISION_CONFIRM", "chk-b1", 0, { inspection_id: "INS-B" });
  await put("u-sup", "PROTOCOL_FINALIZED", "INS-B", 31, { version: 1 });
  await put("u-insp", "LOGIN", "", 0); // постороннее событие в отчёт не попадает
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("отчёт юзабилити-теста верификации (NFR-VERIFY-30)", () => {
  it("инспектору отчёт недоступен — 403", async () => {
    expect((await get("/api/v1/usability/verification-report", "inspector")).statusCode).toBe(403);
  });

  it("супервизору — JSON: циклы по проверкам, источник начала, время и сводка против цели 30 минут", async () => {
    const r = await get("/api/v1/usability/verification-report", "supervisor");
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const a = body.cycles.find((c: any) => c.inspection_id === "INS-A");
    const b = body.cycles.find((c: any) => c.inspection_id === "INS-B");
    expect(a).toMatchObject({ user_id: "u-insp", start_source: "VERIFICATION_OPENED", completed: true, wall_minutes: 20, decisions: 2, within_target: true });
    expect(b).toMatchObject({ user_id: "u-sup", start_source: "FIRST_DECISION", wall_minutes: 31, within_target: false });
    expect(body.summary).toMatchObject({ target_minutes: 30, participants: 2, enough_participants: false, verdict: "INSUFFICIENT_PARTICIPANTS" });
  });

  it("администратору доступен markdown-протокол с таблицей и выводом «недостаточно участников» при менее чем пяти", async () => {
    const r = await get("/api/v1/usability/verification-report?format=md", "admin");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/markdown/);
    expect(r.body).toContain("Протокол юзабилити-теста");
    expect(r.body).toContain("INS-A");
    expect(r.body).toContain("Иванова А. С.");
    expect(r.body).toMatch(/Вывод: .*недостаточно участников/);
  });

  it("открытие верификации пишет в аудит VERIFICATION_OPENED от имени инспектора; неизвестная проверка — 404", async () => {
    const miss = await app.inject({ method: "POST", url: "/api/v1/inspection/NO-SUCH/verification/open", headers: { authorization: `Bearer ${tokens.inspector}` } });
    expect(miss.statusCode).toBe(404);
    await db.run("insert into objects (id, name, created_at) values ('OBJ-U', 'Синтетический объект', $1)", [at(0)]);
    await db.run("insert into inspections (id, object_id, status, created_at, updated_at) values ('INS-U', 'OBJ-U', 'READY', $1, $1)", [at(0)]);
    const r = await app.inject({ method: "POST", url: "/api/v1/inspection/INS-U/verification/open", headers: { authorization: `Bearer ${tokens.inspector}` } });
    expect(r.statusCode).toBe(200);
    const row = await db.get("select user_id, action from audit_log where object_id = 'INS-U'");
    expect(row).toEqual({ user_id: "u-insp", action: "VERIFICATION_OPENED" });
  });

  it("открывать верификацию без входа нельзя — 401", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/inspection/INS-A/verification/open" })).statusCode).toBe(401);
  });
});
