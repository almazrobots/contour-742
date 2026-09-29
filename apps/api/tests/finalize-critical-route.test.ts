// OS-INSP-4.3.5 (T-118): финализация через API на PGlite — перечень критических параметров без вердикта, 409 до
// подтверждения, запись подтверждения в аудит (L2 контракт роута).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-critical-"));
let app: any;
let db: any;
let token = "";
const now = () => new Date().toISOString();
const finalize = (id: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1/inspection/${id}/finalize`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

async function seed(id: string, checks: Array<[code: string, finding: string, priority: string, verification?: string]>) {
  await db.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", [`O-${id}`, id, "{}", now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,'COMPLETED',1,$3,$3)", [id, `O-${id}`, now()]);
  for (const [i, [code, finding, priority, verification]] of checks.entries()) {
    await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, computed_in_version, created_at, updated_at)
                  values ($1,$2,$3,'g',$4,$5,$6,1,$7,$7)`, [`${id}-${i}`, id, code, finding, verification ?? "PENDING", priority, now()]);
  }
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_RIN_URL: "http://rin.invalid" });
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

describe("OS-INSP-4.3.5 финализация с критическими параметрами без вердикта", () => {
  it("без подтверждения — 409 CRITICAL_UNREVIEWED с перечнем: код, наименование, статус; протокол не финализирован", async () => {
    await seed("K-1", [["M-001", "MISSING_EVIDENCE", "HIGH"], ["M-002", "NEGATIVE_VERIFIED", "HIGH"], ["M-099", "NOT_COMPARABLE", "MEDIUM"]]);
    const r = await finalize("K-1");
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.details.code).toBe("CRITICAL_UNREVIEWED");
    expect(body.details.critical).toEqual([{ param_code: "M-001", parameter_name: "Площадь застройки", finding_status: "MISSING_EVIDENCE" }]);
    expect((await db.get("select status from inspections where id = 'K-1'")).status).toBe("COMPLETED");
  });

  it("с подтверждением — финализирован; в аудите CRITICAL_POINTS_REVIEWED с числом и кодами", async () => {
    await seed("K-2", [["M-001", "MISSING_EVIDENCE", "HIGH"], ["M-003", "CLARIFICATION_REQUIRED", "HIGH"]]);
    const r = await finalize("K-2", { critical_reviewed: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().critical_reviewed).toEqual(["M-001", "M-003"]);
    expect((await db.get("select status from inspections where id = 'K-2'")).status).toBe("FINALIZED");
    const a = await db.get("select details from audit_log where action = 'CRITICAL_POINTS_REVIEWED' and object_id = 'K-2'");
    const d = typeof a.details === "string" ? JSON.parse(a.details) : a.details;
    expect(d).toEqual({ count: 2, params: ["M-001", "M-003"] });
  });

  it("без критических пропусков подтверждение не нужно и в аудит не пишется", async () => {
    await seed("K-3", [["M-001", "NEGATIVE_VERIFIED", "HIGH"], ["M-099", "MISSING_EVIDENCE", "MEDIUM"]]);
    expect((await finalize("K-3")).statusCode).toBe(200);
    expect(await db.get("select 1 from audit_log where action = 'CRITICAL_POINTS_REVIEWED' and object_id = 'K-3'")).toBeFalsy();
  });

  it("перечень для окна финализации отдаёт сервер: тот же состав, что и в отказе 409; нет проверки — 404", async () => {
    await seed("K-5", [["M-001", "MISSING_EVIDENCE", "HIGH"], ["M-002", "NOT_COMPARABLE", "HIGH", "NEGATIVE_VERIFIED"]]);
    const r = await app.inject({ method: "GET", url: "/api/v1/inspection/K-5/critical-unresolved", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ critical: [{ param_code: "M-001", parameter_name: "Площадь застройки", finding_status: "MISSING_EVIDENCE" }] });
    expect((await finalize("K-5")).json().details.critical).toEqual(r.json().critical);
    expect((await app.inject({ method: "GET", url: "/api/v1/inspection/NOPE/critical-unresolved", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
  });

  it("critical_reviewed не булево — 400", async () => {
    await seed("K-4", [["M-001", "MISSING_EVIDENCE", "HIGH"]]);
    expect((await finalize("K-4", { critical_reviewed: "да" })).statusCode).toBe(400);
  });
});
