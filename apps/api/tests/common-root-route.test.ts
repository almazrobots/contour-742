// OS-INSP-4.1.12–4.1.14: общий корень через API на PGlite (L4, L6).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-root-"));
let app: any;
let db: any;
let token = "";
const now = () => new Date().toISOString();
const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

async function seed() {
  await db.run("insert into objects (id, name, profile_json, created_at) values ('O-R','O','{}',$1)", [now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('R','O-R','VERIFYING',1,$1,$1)", [now()]);
  const rows: Array<[string, string, string, string]> = [
    ["R-1", "MEDIUM", "Р-ОВ", "2"], ["R-2", "MEDIUM", "Р-ОВ", "2"], ["R-3", "MEDIUM", "Р-ОВ", "2"],
    ["R-4", "HIGH", "Р-ОВ", "2"], ["R-5", "MEDIUM", "Р-ВК", "1"],
  ];
  for (const [id, pr, doc, rev] of rows) {
    await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, computed_in_version, created_at, updated_at)
                  values ($1,'R',$2,$1,'CANDIDATE','PENDING',$3,1,$4,$4)`, [id, `M-${id}`, pr, now()]);
    await db.run("insert into evidence_fragments (check_id, file_id, stage, document_code, revision, sheet_page, role_expected_actual) values ($1,$2,'RD',$3,$4,$5,'actual')", [id, `F-${doc}`, doc, rev, 5]);
  }
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  await seed();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("общий корень", () => {
  it("соседи — тот же документ и редакция, без критичного и чужого документа", async () => {
    const r = await call("GET", "/api/v1/checks/R-1/siblings");
    expect(r.json().map((s: any) => s.id)).toEqual(["R-2", "R-3"]);
  });
  it("групповое снятие — поштучные решения с отсылкой к исходному и записи журнала отклонений", async () => {
    const r = await call("POST", "/api/v1/checks/R-1/reject-group", { reason_code: "WRONG_REVISION", ids: ["R-2", "R-3"], actions: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ rejected: ["R-2", "R-3"] });
    const d = await db.all("select check_id, action, reason_code, comment from decisions where check_id in ('R-2','R-3') and not superseded order by check_id");
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ action: "reject", reason_code: "WRONG_REVISION" });
    expect(d[0].comment).toMatch(/общая причина с M-R-1/);
    expect((await db.get("select count(*)::int n from rejection_log where check_id in ('R-2','R-3')")).n).toBe(2);
  });
  it("не сосед (критичный или чужой документ) — 400, ничего не снимается", async () => {
    const r = await call("POST", "/api/v1/checks/R-1/reject-group", { reason_code: "WRONG_REVISION", ids: ["R-4"] });
    expect(r.statusCode).toBe(400);
    expect((await db.get("select verification_status v from checks where id = 'R-4'")).v).toBe("PENDING");
  });
  it("неизвестная причина — 400", async () => {
    expect((await call("POST", "/api/v1/checks/R-1/reject-group", { reason_code: "PLEASE", ids: ["R-5"] })).statusCode).toBe(400);
  });
});
