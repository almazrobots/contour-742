// T-117: выгрузка ответа организатора через API (OS-INSP-5.1.3–5.1.5). Эшелоны: L3 (проверка на базе → ответ по схеме),
// L6 (статус без метки — 422 с полем, файл не отдаётся). База в памяти, без ML.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-submission-"));
let app: any;
let db: any;
let token = "";
let insp = "";

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  const svc = await import("../src/services/inspections.ts");
  insp = await svc.createInspection({ db, user: { id: "u", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-SUB", name: "Синтетика", profile: {} });
  for (const [id, stage, disc, code, client] of [["f-kr", "PD", "КР", "П-КР", "F0012"], ["f-kzh", "RD", "КЖ", "Р-КЖ1", "F0031"]]) {
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision,
        revision_role, parse_status, uploaded_at) values ($1,$2,'OBJ-SUB',$3,$4,$5,1,'pdf',$6,$7,$8,'0','CURRENT','DONE',now())`, [id, insp, client, `${code}.pdf`, id.padEnd(64, "0"), stage, disc, code]);
  }
  await db.run("insert into extractions (file_id, param_code, kind, raw, value_num, page, confidence) values ('f-kr','M-059','param','200',200,4,0.9), ('f-kzh','M-059','param','180',180,7,0.9)");
  await svc.recompute(db, insp, new Set());
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const get = () => app.inject({ method: "GET", url: `/api/v1/inspection/${insp}/protocol/export?format=submission`, headers: { authorization: `Bearer ${token}` } });

describe("ответ организатора через API (T-117)", () => {
  it("132 параметра Матрицы по кодам организатора; кандидат М-059 — KR-059 VIOLATION_PRESENT с листами из реестра", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/submission-OBJ-SUB-v1\.json/);
    const sub = r.json();
    expect(sub.object_id).toBe("OBJ-SUB");
    expect(sub.checks).toHaveLength(132);
    expect(sub.checks.find((c: any) => c.parameter_code === "KR-059")).toMatchObject({
      violation_label: "VIOLATION_PRESENT", protocol_status: "CRITICAL", pd_value: "200", rd_value: "180",
      evidence: [{ stage: "PD", file_id: "F0012", pdf_page_number: 4 }, { stage: "RD", file_id: "F0031", pdf_page_number: 7 }],
    });
  });
  it("параметр вне каталога организатора — 422 с названием поля, файл не отдаётся (неизвестный статус держит ограничение базы, его ловит домен)", async () => {
    await db.run("update checks set param_code = 'M-999' where inspection_id = $1 and param_code = 'M-001'", [insp]);
    const r = await get();
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ details: { field: "parameter_code" } });
    expect(r.json().error).toMatch(/M-999/);
    expect(r.headers["content-disposition"]).toBeUndefined();
  });
});
