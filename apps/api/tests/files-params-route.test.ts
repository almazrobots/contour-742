// Раздел «Файлы», раскрытие файла: упоминания параметров постранично, с контекстом строки. Эшелоны: L1 (форма, контекст, значение),
// L3 (границы страниц, обрезка строки, неизвестный файл), L6 (доступ без сессии). База в памяти, синтетика.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-fparams-"));
let app: any;
let db: any;
let token = "";

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  const { createInspection } = await import("../src/services/inspections.ts");
  const insp = await createInspection({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-FP", name: "Синтетика-П", address: "", customer: "", contractor: "", permit_number: "", profile: {} });
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, pages_json, uploaded_at)
    values ('fp-1', $1, 'OBJ-FP', 'c-1', 'синтетика.pdf', $2, 100, 'pdf', 'PD', 'ШИФР', '0', 'DONE', '[]', now())`, [insp, "a".repeat(64)]);
  for (let i = 1; i <= 12; i++) {
    await db.run("insert into extractions (file_id, param_code, kind, raw, value_num, page, confidence, line_text) values ('fp-1', 'M-087', 'param', $1, $2, $3, 1, $4)",
      [`${i},5`, i + 0.5, i, i === 12 ? "х".repeat(300) : `  Отметка   пола ${i}\n этаж `]);
  }
  await db.run("insert into extractions (file_id, param_code, kind, raw, page, confidence) values ('fp-1', 'LIFTS', 'fact', '2', 1, 1)");
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const get = (qs = "", id = "fp-1") => app.inject({ method: "GET", url: `/api/v1/files/${id}/params${qs}`, headers: { authorization: `Bearer ${token}` } });

describe("раскрытие файла: упоминания параметров", () => {
  it("L1: по параметру — первая страница с листом, значением как найдено и очищенной строкой-контекстом", async () => {
    const b = (await get("?param=M-087&limit=5")).json();
    expect([b.total, b.limit, b.offset, b.items.length]).toEqual([12, 5, 0, 5]);
    expect(b.items.map((x: any) => x.page)).toEqual([1, 2, 3, 4, 5]);
    expect(b.items[0]).toMatchObject({ param_code: "M-087", raw: "1,5", value_num: 1.5, line_text: "Отметка пола 1 этаж" });
  });
  it("L3: следующая страница продолжает с места, последняя неполная, за краем пусто; строка режется до 140 знаков", async () => {
    expect((await get("?param=M-087&limit=5&offset=5")).json().items.map((x: any) => x.page)).toEqual([6, 7, 8, 9, 10]);
    const last = (await get("?param=M-087&limit=5&offset=10")).json();
    expect(last.items.map((x: any) => x.page)).toEqual([11, 12]);
    expect(last.items[1].line_text).toBe(`${"х".repeat(140)}…`);
    expect((await get("?param=M-087&offset=100")).json().items).toEqual([]);
  });
  it("L1: параметр отбирает только свои строки; без параметра — все строки файла; факт без контекста даёт line_text null", async () => {
    const f = (await get("?param=LIFTS")).json();
    expect([f.total, f.items[0].line_text]).toEqual([1, null]);
    expect((await get("")).json().total).toBe(13);
    expect((await get("?param=M-000")).json().total).toBe(0);
  });
  it("L3: неизвестный файл — 404, плохие границы — 400", async () => {
    expect((await get("", "нет")).statusCode).toBe(404);
    expect((await get("?limit=0")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get("?offset=-1")).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("L6: без сессии — 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/files/fp-1/params" })).statusCode).toBe(401);
  });
});
