// T-110 (кандидаты OS-INSP-4.1.8–4.1.11): совпадения выборкой через API — L4 интеграция с БД (PGlite, миграция 0003).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-sample-"));
let app: any;
let db: any;
let token = "";
const now = () => new Date().toISOString();
const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

/** Проверка с партией: 40 системных «расхождения нет» (5 из них критичные), 3 кандидата, по трём файлам. */
async function seedInspection(id: string, status = "READY") {
  await db.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", [`O-${id}`, `Объект ${id}`, "{}", now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", [id, `O-${id}`, status, 1, now(), now()]);
  await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1,1,'DRAFT','{}',$2)", [id, now()]);
  const ins = `insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, computed_in_version, created_at, updated_at)
               values ($1,$2,$3,$4,$5,'PENDING',$6,1,$7,$7)`;
  for (let i = 1; i <= 43; i++) {
    const cid = `${id}-C${i}`;
    await db.run(ins, [cid, id, `M-${String(i).padStart(3, "0")}`, `g${i}`, i > 40 ? "CANDIDATE" : "NEGATIVE_VERIFIED", i <= 5 ? "HIGH" : "MEDIUM", now()]);
    await db.run("insert into evidence_fragments (check_id, file_id, stage, sheet_page, extracted_value, role_expected_actual) values ($1,$2,'PD',1,'1','expected')", [cid, `F${i % 3}`]);
  }
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

describe("план выборки", () => {
  it("партия — только системные «расхождения нет» без критичных; выборка 30, одна и та же при повторном запросе", async () => {
    await seedInspection("SA-1");
    const a = (await call("GET", "/api/v1/inspection/SA-1/sample")).json();
    expect(a.pool_size).toBe(35); // 40 отрицательных − 5 критичных; кандидаты не входят
    expect(a.sample_size).toBe(30);
    expect(a.bound_if_clean).toBeCloseTo(0.095, 3);
    expect(new Set(a.sample.map((s: any) => s.file_id)).size).toBe(3);
    expect(a.sample[0].fragments.length).toBeGreaterThan(0);
    const b = (await call("GET", "/api/v1/inspection/SA-1/sample")).json();
    expect(b.sample.map((s: any) => s.id)).toEqual(a.sample.map((s: any) => s.id));
  });
});

describe("приёмка партии", () => {
  it("вся выборка просмотрена без ошибок — акт приёмки записан, партия принята, критичные и кандидаты не тронуты", async () => {
    await seedInspection("SA-2");
    const p = (await call("GET", "/api/v1/inspection/SA-2/sample")).json();
    const ids = p.sample.map((s: any) => s.id);
    const r = await call("POST", "/api/v1/inspection/SA-2/sample/accept", { seed: p.seed, reviewed: ids, errors: [] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ outcome: "ACCEPTED", accepted: 35, sample_size: 30 });
    const act = await db.get("select * from sample_acceptances where inspection_id = 'SA-2'");
    expect(act).toMatchObject({ pool_size: 35, sample_size: 30 });
    const st = await db.all("select verification_status v, count(*)::int n from checks where inspection_id = 'SA-2' group by 1 order by 1");
    expect(st).toEqual([{ v: "NEGATIVE_VERIFIED", n: 35 }, { v: "PENDING", n: 8 }]);
    expect(await db.get("select 1 from audit_log where action = 'SAMPLE_ACCEPTED' and object_id = 'SA-2'")).toBeTruthy();
  });
  it("акт приёмки неизменяем (журнал только дописывается)", async () => {
    const code = async (q: string) => { try { await db.run(q); return null; } catch (e: any) { return e?.code ?? String(e); } };
    expect(await code("update sample_acceptances set pool_size = 1")).toBe("42501");
    expect(await code("delete from sample_acceptances")).toBe("42501");
    expect(await code("truncate sample_acceptances")).toBe("42501");
  });
  it("ошибка в выборке — партия не принимается, ничего не меняется", async () => {
    await seedInspection("SA-3");
    const p = (await call("GET", "/api/v1/inspection/SA-3/sample")).json();
    const ids = p.sample.map((s: any) => s.id);
    const r = (await call("POST", "/api/v1/inspection/SA-3/sample/accept", { seed: p.seed, reviewed: ids, errors: [ids[4]] })).json();
    expect(r).toMatchObject({ outcome: "BROKEN", errors: [ids[4]] });
    expect(await db.get("select 1 from sample_acceptances where inspection_id = 'SA-3'")).toBeFalsy();
    expect((await db.get("select count(*)::int n from checks where inspection_id = 'SA-3' and verification_status <> 'PENDING'")).n).toBe(0);
  });
  it("просмотрена не вся выборка — 409 с числом оставшихся", async () => {
    await seedInspection("SA-4");
    const p = (await call("GET", "/api/v1/inspection/SA-4/sample")).json();
    const r = await call("POST", "/api/v1/inspection/SA-4/sample/accept", { seed: p.seed, reviewed: p.sample.slice(0, 10).map((s: any) => s.id), errors: [] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error ?? r.json().message).toMatch(/осталось 20/);
  });
  it("seed не от этой версии протокола — 409, выборку надо открыть заново", async () => {
    const p = (await call("GET", "/api/v1/inspection/SA-4/sample")).json();
    const r = await call("POST", "/api/v1/inspection/SA-4/sample/accept", { seed: p.seed + 1, reviewed: p.sample.map((s: any) => s.id), errors: [] });
    expect(r.statusCode).toBe(409);
  });
  it("финализированный протокол — 409", async () => {
    await seedInspection("SA-5", "FINALIZED");
    const p = (await call("GET", "/api/v1/inspection/SA-5/sample")).json();
    const r = await call("POST", "/api/v1/inspection/SA-5/sample/accept", { seed: p.seed, reviewed: p.sample.map((s: any) => s.id), errors: [] });
    expect(r.statusCode).toBe(409);
  });
});
