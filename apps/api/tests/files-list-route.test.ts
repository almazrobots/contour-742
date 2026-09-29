// Раздел «Файлы»: листинг обработанных файлов с пагинацией и извлечёнными параметрами. Эшелоны: L1 (форма и
// параметры файла), L3 (границы страницы, пустой результат), доступ без сессии. База в памяти, синтетика.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-files-"));
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
  const insp = await createInspection({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-FILES", name: "Синтетика-Ф", address: "", customer: "", contractor: "", permit_number: "", profile: {} });
  for (let i = 1; i <= 5; i++) {
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, doc_type, pages_json, uploaded_at)
      values ($1, $2, 'OBJ-FILES', $3, $4, $5, 100, 'pdf', 'PD', $6, '0', $7, $8, $9, now() + ($10 || ' seconds')::interval)`,
      [`f-${i}`, insp, `c-${i}`, `файл-${i}.pdf`, String(i).repeat(64).slice(0, 64), `ШИФР-${i}`, i === 5 ? "FAILED" : "DONE", i % 2 ? "ACT" : "DRAWING", JSON.stringify(Array.from({ length: i }, () => ({}))), String(i)]);
  }
  await db.run("insert into extractions (file_id, param_code, kind, raw, value_num, page, confidence) values ('f-5', 'M-059', 'param', '12,5 м', 12.5, 2, 0.9), ('f-5', 'M-001', 'param', 'А', null, 1, 0.8), ('f-5', 'M-059', 'param', '12,5 м', 12.5, 3, 0.9), ('f-5', 'LIFTS', 'fact', '2', 2, 1, 1)");
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const get = (qs = "") => app.inject({ method: "GET", url: `/api/v1/files${qs}`, headers: { authorization: `Bearer ${token}` } });

describe("раздел «Файлы»", () => {
  it("L1: страница даёт общее число, самые новые первыми, число страниц файла и его параметры", async () => {
    const b = (await get("?limit=2")).json();
    expect([b.total, b.limit, b.offset, b.items.map((x: any) => x.id)]).toEqual([5, 2, 0, ["f-5", "f-4"]]);
    const f5 = b.items[0];
    expect([f5.file_name, f5.object_name, f5.parse_status, f5.pages]).toEqual(["файл-5.pdf", "Синтетика-Ф", "FAILED", 5]);
    expect(f5.mentions).toBe(4);
    expect(f5.params.map((p: any) => [p.param_code, p.in_matrix, p.mentions, p.distinct_values]).sort()).toEqual([["LIFTS", false, 1, 1], ["M-001", true, 1, 1], ["M-059", true, 2, 1]]);
    expect(f5.params.find((p: any) => p.param_code === "M-001").name).toBeTruthy();
    expect(f5.params.find((p: any) => p.param_code === "LIFTS").name).toBeNull();
    expect(JSON.stringify(b.items[0].params)).not.toContain("line_text");
    expect(b.items[1].params).toEqual([]);
  });
  it("L3: вторая и последняя страницы, за пределами — пусто, но total сохраняется", async () => {
    expect((await get("?limit=2&offset=2")).json().items.map((x: any) => x.id)).toEqual(["f-3", "f-2"]);
    expect((await get("?limit=2&offset=4")).json().items.map((x: any) => x.id)).toEqual(["f-1"]);
    const past = (await get("?limit=2&offset=10")).json();
    expect([past.total, past.items]).toEqual([5, []]);
  });
  it("L1: фильтры — по статусу, типу и подстроке имени; шаблонные знаки в поиске не работают как маска", async () => {
    expect((await get("?status=FAILED")).json().items.map((x: any) => x.id)).toEqual(["f-5"]);
    expect((await get("?doc_type=DRAWING")).json().total).toBe(2);
    expect((await get("?q=ФАЙЛ-3")).json().items.map((x: any) => x.id)).toEqual(["f-3"]);
    expect((await get("?q=%25")).json().total).toBe(0);
  });
  it("L3: недопустимые границы отклоняются, без сессии — 401", async () => {
    expect((await get("?limit=0")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get("?offset=-1")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/files" })).statusCode).toBe(401);
  });
});
