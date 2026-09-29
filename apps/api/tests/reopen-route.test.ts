// OS-INSP-4.1.15, 4.1.16: возврат решения в PENDING и счётчик действий — через API на PGlite (L4, L6).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-reopen-"));
let app: any;
let db: any;
let token = "";
const now = () => new Date().toISOString();
const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

async function seed(id: string, status = "VERIFYING") {
  await db.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", [`O-${id}`, id, "{}", now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,1,$4,$4)", [id, `O-${id}`, status, now()]);
  await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, computed_in_version, created_at, updated_at)
                values ($1,$2,'M-055','g','CANDIDATE','PENDING','HIGH',1,$3,$3)`, [`${id}-C`, id, now()]);
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("возврат решения (Z)", () => {
  it("признал → вернул → снова PENDING; прежнее решение заменено, запись аудита CHECK_REOPENED", async () => {
    await seed("R-1");
    expect((await call("POST", "/api/v1/checks/R-1-C/decision", { action: "confirm", actions: 1 })).statusCode).toBe(200);
    const r = await call("POST", "/api/v1/checks/R-1-C/reopen");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ check_id: "R-1-C", verification_status: "PENDING" });
    expect((await db.get("select verification_status v from checks where id = 'R-1-C'")).v).toBe("PENDING");
    expect((await db.get("select count(*)::int n from decisions where check_id = 'R-1-C' and not superseded")).n).toBe(0);
    expect(await db.get("select 1 from audit_log where action = 'CHECK_REOPENED' and object_id = 'R-1-C'")).toBeTruthy();
    // после возврата можно решить заново
    expect((await call("POST", "/api/v1/checks/R-1-C/decision", { action: "clarify", actions: 1 })).statusCode).toBe(200);
  });
  it("нерешённого кандидата вернуть нельзя — 409", async () => {
    await seed("R-2");
    expect((await call("POST", "/api/v1/checks/R-2-C/reopen")).statusCode).toBe(409);
  });
  it("финализированный протокол — 409, решения неизменяемы", async () => {
    await seed("R-3", "FINALIZED");
    await db.run("update checks set verification_status = 'CONFIRMED_VIOLATION' where id = 'R-3-C'");
    expect((await call("POST", "/api/v1/checks/R-3-C/reopen")).statusCode).toBe(409);
  });
  it("несуществующая запись — 404", async () => {
    expect((await call("POST", "/api/v1/checks/NOPE/reopen")).statusCode).toBe(404);
  });
});

describe("счётчик действий на решение", () => {
  it("число действий попадает в аудит решения и в отчёт юзабилити-теста", async () => {
    await seed("R-4");
    await call("POST", "/api/v1/checks/R-4-C/decision", { action: "reject", reason_code: "OCR_ERROR", comment: "ошибка распознавания", actions: 2 });
    const d = await db.get("select details from audit_log where action = 'DECISION_REJECT' and object_id = 'R-4-C'");
    expect(JSON.parse(typeof d.details === "string" ? d.details : JSON.stringify(d.details)).actions).toBe(2);
    const { verificationReport } = await import("../src/services/usability.ts");
    const rep = await verificationReport(db);
    expect(rep.actions.decisions).toBeGreaterThanOrEqual(3);
    expect(rep.actions.max).toBe(2);
  });
  it("недостоверный счётчик отвергается (400)", async () => {
    await seed("R-5");
    expect((await call("POST", "/api/v1/checks/R-5-C/decision", { action: "confirm", actions: -1 })).statusCode).toBe(400);
  });
});
