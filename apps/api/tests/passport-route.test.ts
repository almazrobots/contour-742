// Эшелоны: L1 (паспорт и верификация через API), L2 (ответ сверяется со схемой OpenAPI — независимой от кода обработчика),
// L6 (чужой тип тела, нарушение схемы, неизвестный код), L7 (единый формат ошибок, роли). T-129: OS-INSP-7.1.3–7.1.6,
// OS-INSP-6.5.8, 6.5.9, NFR-API-VALIDATE, NFR-API-JSON. База в памяти, app.inject, без ML.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-passport-"));
let app: any;
let db: any;
const tokens: Record<string, string> = {};
const as = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });
let inspectionId = "";

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  for (const login of ["inspector", "admin", "ml"]) tokens[login] = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: "test-pass" } })).json().token;
  const { createInspection } = await import("../src/services/inspections.ts");
  inspectionId = await createInspection({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-T129", name: "Синтетический объект", address: "", customer: "", contractor: "", permit_number: "", profile: {} });
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("паспорт параметра (OS-INSP-7.1.3–7.1.6)", () => {
  it("паспорт М-023: атрибуты, шкала С3–С0, источники по стадиям, шаги алгоритма с операциями каталога, метрики единого вида", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/params/M-023/passport", headers: as("inspector") });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.param.parameter_name).toBe("Класс конструктивной пожарной опасности");
    expect(b.param.value_scale).toEqual(["С3", "С2", "С1", "С0"]);
    expect(b.passport.sources.PD.map((s: any) => s.discipline)).toEqual(["ПЗ", "ПБ", "АР", "КР", "*"]);
    expect(b.stages.map((s: any) => s.key)).toEqual(["ING", "IDN", "PRM", "ENT", "NRM", "LNK", "GTE", "CMP", "VER", "DEC", "HIL"]);
    const cmp = b.stages.find((s: any) => s.key === "CMP");
    expect(cmp.param_specific).toBe(true);
    expect(cmp.ops.map((o: any) => o.id)).toEqual(expect.arrayContaining(["CMP-04", "CMP-30"]));
    expect(cmp.ops.find((o: any) => o.id === "CMP-04").title).toMatch(/ORD-RANK/);
    expect(b.metrics.map((m: any) => m.key)).toEqual(["checks", "statuses", "decisions", "coverage", "confidence", "verification"]);
    expect(b.verification).toBeNull();
  });
  it("общие этапы одинаковы для всех параметров: у параметра без паспорта — те же этапы и passport = null", async () => {
    // параметр вне волны W1 (M-007 получил паспорт в T-175)
    const a = (await app.inject({ method: "GET", url: "/api/v1/params/M-120/passport", headers: as("inspector") })).json();
    const b = (await app.inject({ method: "GET", url: "/api/v1/params/M-023/passport", headers: as("inspector") })).json();
    expect(a.passport).toBeNull();
    expect(a.stages.map((s: any) => s.key)).toEqual(b.stages.map((s: any) => s.key));
    expect(a.stages.every((s: any) => !s.param_specific)).toBe(true);
    expect(a.metrics.map((m: any) => m.key)).toEqual(b.metrics.map((m: any) => m.key));
  });
  it("паспорт М-007 — счётный (T-175, CMP-07): вид count с единицей, шаги счёта из паспорта, ответ проходит схему", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/params/M-007/passport", headers: as("inspector") });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.passport.value).toMatchObject({ kind: "count", unit: "эт." });
    expect(a.stages.find((s: any) => s.key === "CMP").ops.map((o: any) => o.id)).toContain("CMP-07");
  });
  it("паспорт М-001 — количественный: единица, допуск, шаги извлечения и сравнения из паспорта (T-132)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/params/M-001/passport", headers: as("inspector") });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.passport.value).toMatchObject({ kind: "quantity", unit: "м²", tolerance_abs: 0.05 });
    expect(b.stages.find((s: any) => s.key === "CMP").ops.map((o: any) => o.id)).toEqual(expect.arrayContaining(["CMP-01", "CMP-30"]));
    expect(b.stages.find((s: any) => s.key === "ENT").ops.map((o: any) => o.id)).toContain("ENT-15");
  });
  it("неизвестный код — 404 в едином формате ошибки; без входа — 401", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/params/M-999/passport", headers: as("inspector") });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "Параметр не найден" });
    expect((await app.inject({ method: "GET", url: "/api/v1/params/M-023/passport" })).statusCode).toBe(401);
  });
});

describe("автоматическая верификация (OS-INSP-6.5.8, 6.5.9)", () => {
  const body = (ok: boolean) => ({ inspection_id: inspectionId, method: "pdftotext+regex (независимый пересчёт)", fields: [{ field: "status", system: "NEGATIVE_VERIFIED", oracle: "NEGATIVE_VERIFIED", ok: true }, { field: "PD", system: "С0", oracle: ok ? "С0" : "С1", ok }] });
  it("вердикт считает сервер: все поля совпали — MATCH, иначе MISMATCH с перечнем полей; паспорт показывает последнюю", async () => {
    const m = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload: body(true) });
    expect(m.statusCode).toBe(201);
    expect(m.json().verdict).toBe("MATCH");
    const x = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload: body(false) });
    expect(x.json()).toMatchObject({ verdict: "MISMATCH", mismatched: ["PD"], object_id: "OBJ-T129" });
    const p = (await app.inject({ method: "GET", url: "/api/v1/params/M-023/passport", headers: as("inspector") })).json();
    expect(p.verification.verdict).toBe("MISMATCH");
    expect(p.metrics.find((q: any) => q.key === "verification").value).toMatch(/^расхождение · OBJ-T129/);
  });
  it("клиентское ok не учитывается: прислал ok=true при разных значениях — всё равно MISMATCH (SEC-04)", async () => {
    const payload = { inspection_id: inspectionId, method: "m", fields: [{ field: "PD", system: "С0", oracle: "С1", ok: true }] };
    const r = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload });
    expect(r.json()).toMatchObject({ verdict: "MISMATCH", mismatched: ["PD"] });
  });
  it("«равноценно» принимается только для указателя на доказательство, не для значения класса", async () => {
    const f = (field: string) => ({ inspection_id: inspectionId, method: "m", fields: [{ field, system: "aaa@3", oracle: "bbb@3", equivalent: true }] });
    const ev = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload: f("PD.evidence") });
    expect(ev.json().verdict).toBe("MATCH");
    const val = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload: f("PD") });
    expect(val.json()).toMatchObject({ verdict: "MISMATCH", mismatched: ["PD"] });
  });
  it("сравнение значений: латинская C и кириллическая С, регистр и пробелы — одно значение; null только с null", async () => {
    const { sameValue } = await import("../src/domain/passport.ts");
    expect(sameValue("C0", " С0 ")).toBe(true);
    expect(sameValue("с1", "С1")).toBe(true);
    expect(sameValue("С0", "С1")).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "С0")).toBe(false);
    expect(sameValue("С0", null)).toBe(false);
  });
  it("журнал верификаций только дописывается", async () => {
    await expect(db.run("update param_verifications set verdict = 'MATCH'")).rejects.toThrow();
  });
  it("писать верификацию может только ML-инженер (или администратор)", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("inspector"), payload: body(true) })).statusCode).toBe(403);
  });
  it("тело не по схеме OpenAPI — 400 с перечнем нарушений до обработчика", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload: { inspection_id: inspectionId, method: "x", fields: [], extra: 1 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/^Запрос не соответствует схеме OpenAPI: /);
    expect(r.json().details.length).toBeGreaterThan(0);
  });
  it("неизвестная проверка — 404", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/params/M-023/verifications", headers: as("ml"), payload: { ...body(true), inspection_id: "nope" } });
    expect(r.statusCode).toBe(404);
  });
});

describe("строгий JSON (NFR-API-JSON)", () => {
  it("тело text/plain — 415, а не разбор строки как JSON", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "text/plain" }, payload: '{"login":"admin","password":"test-pass"}' });
    expect(r.statusCode).toBe(415);
    expect(Object.keys(r.json())).toEqual(["error"]);
  });
  it("неизвестный маршрут — 404 в том же формате {error}", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/nope?x=1" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "Маршрут GET /api/v1/nope не найден" });
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
  });
});
