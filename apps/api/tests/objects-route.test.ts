// Эшелоны: L1 (реестр и карточка объекта через API), L2 (ответ сверяется со схемой OpenAPI валидатором ответа —
// независимо от обработчика), L6 (чужой список параметров, неизвестный код, нет объекта), L7 (единый формат ошибки,
// вход, только чтение на демо). T-166: OS-INSP-8.1.3–8.1.7, NFR-API-VALIDATE, NFR-DEMO-READONLY.
// Данные — синтетика, вставленная прямо в базу в памяти (ADR-0002: реальных документов в тестах нет).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-objects-"));
let app: any;
let db: any;
let token = "";
const as = () => ({ authorization: `Bearer ${token}` });
const get = (url: string) => app.inject({ method: "GET", url, headers: as() });
const sha = (c: string) => c.repeat(64);

async function seed() {
  const run = (sql: string, p: unknown[]) => db.run(sql, p);
  const obj = (id: string, name: string, address: string, profile = "{}") =>
    run("insert into objects (id, name, address, customer, contractor, permit_number, profile_json, created_at) values ($1,$2,$3,'ООО Застройщик','ООО Подрядчик','',$4,$5)", [id, name, address, profile, "2026-09-01T00:00:00Z"]);
  const insp = (id: string, objectId: string, status: string, at: string) =>
    run("insert into inspections (id, object_id, status, scenario, created_at, updated_at) values ($1,$2,$3,'FULL',$4,$4)", [id, objectId, status, at]);
  const file = (id: string, inspId: string, objectId: string, stage: string, code: string, s: string, at: string) =>
    run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, uploaded_at, revision_role)
      values ($1,$2,$3,$1,$4,$5,100,'pdf',$6,$7,'0',$8,'CURRENT')`, [id, inspId, objectId, `${code}.pdf`, s, stage, code, at]);
  const check = (id: string, inspId: string, finding: string, verification: string, notes: Record<string, string>) =>
    run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, stage_notes_json, computed_in_version, created_at, updated_at)
      values ($1,$2,'M-023',$1,$3,$4,$5,1,now(),now())`, [id, inspId, finding, verification, JSON.stringify(notes)]);
  const frag = (checkId: string, fileId: string, stage: string, code: string, value: string, pageNo: number) =>
    run("insert into evidence_fragments (check_id, file_id, stage, document_code, sheet_page, extracted_value, role_expected_actual) values ($1,$2,$3,$4,$5,$6,'expected')", [checkId, fileId, stage, code, pageNo, value]);

  // Объект А: две проверки (история), вторая — последняя; ПД и РД со значением, ИД загружена без значения
  await obj("SYN-A", "СИНТЕТИКА · Корпус А", "ВЫМЫШЛЕННЫЙ АДРЕС · ул. Тестовая, 1", '{"synthetic": true}');
  await insp("P-A1", "SYN-A", "FINALIZED", "2026-09-02T10:00:00Z");
  await file("FA1", "P-A1", "SYN-A", "PD", "СИН-ПЗ", sha("a"), "2026-09-02T10:00:00Z");
  await check("CA1", "P-A1", "MISSING_EVIDENCE", "PENDING", { PD: "USED", RD: "NOT_APPLICABLE", ID: "NOT_APPLICABLE" });
  await insp("P-A2", "SYN-A", "READY", "2026-09-05T10:00:00Z");
  await file("FA2", "P-A2", "SYN-A", "PD", "СИН-ПЗ", sha("a"), "2026-09-05T10:00:00Z"); // тот же файл повторно
  await file("FA3", "P-A2", "SYN-A", "RD", "СИН-АР", sha("b"), "2026-09-05T10:00:00Z");
  await file("FA4", "P-A2", "SYN-A", "ID", "СИН-АКТ", sha("c"), "2026-09-05T10:00:00Z");
  await check("CA2", "P-A2", "NEGATIVE_VERIFIED", "PENDING", { PD: "USED", RD: "USED", ID: "NO_VALUE" });
  await frag("CA2", "FA2", "PD", "СИН-ПЗ", "С0", 2);
  await frag("CA2", "FA3", "RD", "СИН-АР", "С0", 1);
  await run("insert into param_verifications (param_code, inspection_id, object_id, verdict, fields_json, method, checked_at) values ('M-023','P-A2','SYN-A','MATCH','[]','независимый пересчёт',$1)", ["2026-09-06T00:00:00Z"]);

  // Объект Б: одна проверка, только ПД; решение инспектора есть
  await obj("SYN-B", "СИНТЕТИКА · Корпус Б", "ВЫМЫШЛЕННЫЙ АДРЕС · ул. Тестовая, 2");
  await insp("P-B1", "SYN-B", "VERIFYING", "2026-09-04T10:00:00Z");
  await file("FB1", "P-B1", "SYN-B", "PD", "СИН-Б-ПЗ", sha("d"), "2026-09-04T10:00:00Z");
  await check("CB1", "P-B1", "MISSING_EVIDENCE", "CLARIFICATION_REQUIRED", { PD: "USED", RD: "NOT_APPLICABLE", ID: "NOT_APPLICABLE" });
  await frag("CB1", "FB1", "PD", "СИН-Б-ПЗ", "не ниже С1", 4);
  const uid = (await db.get("select id from users where login = 'inspector'")).id;
  await run("insert into decisions (check_id, user_id, action, status, comment, created_at) values ('CB1',$1,'clarify','CLARIFICATION_REQUIRED','нет РД',$2)", [uid, "2026-09-04T11:00:00Z"]);

  // Объект В: проверки ещё не было
  await obj("SYN-V", "СИНТЕТИКА · Корпус В", "ВЫМЫШЛЕННЫЙ АДРЕС · ул. Тестовая, 3");
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  await seed();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("реестр объектов (OS-INSP-8.1.3, 8.1.4, 8.1.5)", () => {
  it("объекты по последней активности; файлы по стадиям без повторов; последняя проверка; М-023 по умолчанию", async () => {
    const r = await get("/api/v1/objects");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.key_params).toEqual([{ code: "M-023", name: "Класс конструктивной пожарной опасности" }]);
    expect(b.objects.map((o: any) => o.id)).toEqual(["SYN-A", "SYN-B", "SYN-V"]);
    const [a, bb, v] = b.objects;
    expect(a).toMatchObject({ name: "СИНТЕТИКА · Корпус А", synthetic: true, stage_files: { PD: 1, RD: 1, ID: 1 }, inspections_count: 2, last_inspection: { id: "P-A2", status: "READY" } });
    expect(a).not.toHaveProperty("customer"); // NFR-PDN: застройщик и подрядчик в реестр не выводятся
    expect(bb.synthetic).toBe(true); // метка в названии
    expect(v).toMatchObject({ stage_files: { PD: 0, RD: 0, ID: 0 }, inspections_count: 0, last_inspection: null });
  });
  it("строка М-023: итог и решение из последней проверки, значения по стадиям, независимый пересчёт", async () => {
    const [a, b, v] = (await get("/api/v1/objects")).json().objects;
    const ra = a.key_param_rows[0];
    expect(ra).toMatchObject({ code: "M-023", checked: true, inspection_id: "P-A2", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", decision: null });
    expect(ra.auto_check).toMatchObject({ verdict: "MATCH", method: "независимый пересчёт" });
    expect(ra.stages.map((s: any) => [s.stage, s.state, s.value])).toEqual([["PD", "VALUE", "С0"], ["RD", "VALUE", "С0"], ["ID", "NO_VALUE", null]]);
    const rb = b.key_param_rows[0];
    expect(rb).toMatchObject({ finding_status: "MISSING_EVIDENCE", verification_status: "CLARIFICATION_REQUIRED", decision: { status: "CLARIFICATION_REQUIRED" }, auto_check: null });
    expect(rb.decision.by).toBeTruthy();
    expect(rb.stages.map((s: any) => s.state)).toEqual(["VALUE", "NOT_LOADED", "NOT_LOADED"]);
    expect(v.key_param_rows[0]).toMatchObject({ checked: false, finding_status: null });
    expect(v.key_param_rows[0].stages.map((s: any) => s.state)).toEqual(["NOT_LOADED", "NOT_LOADED", "NOT_LOADED"]);
  });
  it("список ключевых параметров передаётся запросом; параметр без проверки — «не проверялся»", async () => {
    const b = (await get("/api/v1/objects?params=M-023,M-001")).json();
    expect(b.key_params.map((k: any) => k.code)).toEqual(["M-023", "M-001"]);
    const a = b.objects[0];
    expect(a.key_param_rows.map((k: any) => k.code)).toEqual(["M-023", "M-001"]);
    expect(a.key_param_rows[1].stages.map((s: any) => s.state)).toEqual(["NOT_CHECKED", "NOT_CHECKED", "NOT_CHECKED"]);
  });
  it("постраничность: limit/offset", async () => {
    const b = (await get("/api/v1/objects?limit=1&offset=1")).json();
    expect(b.objects.map((o: any) => o.id)).toEqual(["SYN-B"]);
  });
  it("чужой формат, неизвестный код, больше 10 кодов — 400 в едином формате; без входа — 401", async () => {
    for (const q of ["params=m-023", "params=M-023;x", "params=M-999", `params=${Array.from({ length: 11 }, (_, i) => `M-${String(i + 1).padStart(3, "0")}`).join(",")}`]) {
      const r = await get(`/api/v1/objects?${q}`);
      expect(r.statusCode, q).toBe(400);
      expect(typeof r.json().error).toBe("string");
    }
    expect((await get("/api/v1/objects?params=M-999")).json().error).toMatch(/M-999/);
    expect((await app.inject({ method: "GET", url: "/api/v1/objects" })).statusCode).toBe(401);
  });
});

describe("карточка объекта (OS-INSP-8.1.3, 8.1.4, 8.1.6)", () => {
  it("документы по стадиям: повтор файла — один раз из последней загрузки; журнал проверок — вся история", async () => {
    const r = await get("/api/v1/objects/SYN-A");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.object).toMatchObject({ id: "SYN-A", synthetic: true });
    expect(b.stage_files).toEqual({ PD: 1, RD: 1, ID: 1 });
    expect(b.documents.PD.map((d: any) => [d.id, d.inspection_id])).toEqual([["FA2", "P-A2"]]);
    expect(b.inspections.map((i: any) => [i.id, i.status, i.files])).toEqual([["P-A2", "READY", 3], ["P-A1", "FINALIZED", 1]]);
    expect(b.key_param_rows[0].inspection_id).toBe("P-A2");
  });
  it("пустая стадия видна как пустой список; объект без проверок — пустой журнал", async () => {
    const b = (await get("/api/v1/objects/SYN-B")).json();
    expect(b.documents.RD).toEqual([]);
    expect(b.documents.ID).toEqual([]);
    const v = (await get("/api/v1/objects/SYN-V")).json();
    expect(v.inspections).toEqual([]);
    expect(v.documents).toEqual({ PD: [], RD: [], ID: [] });
  });
  it("нет объекта — 404 в едином формате", async () => {
    const r = await get("/api/v1/objects/NOPE");
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "Объект не найден" });
  });
});

describe("демо-стенд только для чтения (NFR-DEMO-READONLY)", () => {
  it("реестр и карточка открываются при INSPECTOR_READONLY=1", async () => {
    const { config } = await import("../src/config.ts");
    const was = config.readonly;
    (config as any).readonly = true;
    try {
      expect((await get("/api/v1/objects")).statusCode).toBe(200);
      expect((await get("/api/v1/objects/SYN-A")).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/v1/objects", headers: as(), payload: {} })).statusCode).toBe(403);
    } finally {
      (config as any).readonly = was;
    }
  });
});

// OWASP R2 T-166 (OWASP-0164, API3:2023 BOPLA): схемы ответа закрыты — лишнее поле (застройщик, подрядчик, профиль)
// в выборке объекта не уходит клиенту, а роняет ответ валидатором (500 и запись в лог), как у остальных карточек
describe("схемы ответа «Объектов» закрыты (OWASP-0164)", () => {
  it("лишнее поле в объекте, документе и последней проверке — ответ не проходит схему", async () => {
    const { compileOpenapi } = await import("../src/services/openapi-validate.ts");
    const { openapi } = await import("../src/openapi.ts");
    const c = compileOpenapi(openapi as any);
    const list = c.get("GET /api/v1/objects")!.responses.get("200")!;
    const card = c.get("GET /api/v1/objects/{}")!.responses.get("200")!;
    const good = (await get("/api/v1/objects")).json();
    const goodCard = (await get("/api/v1/objects/SYN-A")).json();
    expect(list(good)).toBe(true);
    expect(card(goodCard)).toBe(true);
    const leak = structuredClone(good);
    leak.objects[0].customer = "ООО Застройщик";
    expect(list(leak)).toBe(false);
    const leakLast = structuredClone(good);
    leakLast.objects[0].last_inspection.created_by = "u1";
    expect(list(leakLast)).toBe(false);
    const leakHead = structuredClone(goodCard);
    leakHead.object.contractor = "ООО Подрядчик";
    expect(card(leakHead)).toBe(false);
    const leakDoc = structuredClone(goodCard);
    leakDoc.documents.PD[0].size = 100;
    expect(card(leakDoc)).toBe(false);
  });
});
