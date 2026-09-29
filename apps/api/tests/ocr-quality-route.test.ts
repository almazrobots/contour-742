// OS-INSP-2.1.16 (ТЗ 9.1.1, TZA-9.1.1-06, T-138): отчёт о качестве распознавания проверки — маршрут API и раздел
// протокола. Строки заводятся SQL напрямую: сводки страниц — как их пишет разбор (files.pages_json).
// L1 — функциональные, L3 — неразобранный файл, L7 — ответ по схеме OpenAPI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let app: any;
let db: any;
let token = "";

const pages = (xs: Array<[string, string, number, number, number]>) =>
  JSON.stringify(xs.map(([source, quality, lines, words, disputed], i) => ({ page: i + 1, width: 595, height: 842, rotation: 0, source, quality, ocr_confidence: source === "ocr" ? 80 : null, lines, words, disputed_words: disputed })));

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: "ocrq-pass-123", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  await app.ready();
  const now = new Date().toISOString();
  await db.run("insert into objects (id, name, created_at) values ('OQ-OBJ', 'Объект', $1)", [now]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('OQ-1', 'OQ-OBJ', 'READY', 1, $1, $1)", [now]);
  const ins = "insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, uploaded_at, pages_json, parse_status) values ($1, 'OQ-1', 'OQ-OBJ', $1, $2, $3, 1, 'pdf', $4, $5, '0', $6, $7, $8)";
  await db.run(ins, ["OQ-F1", "ПЗ.pdf", "a".repeat(64), "PD", "PD-PZ", now, pages([["text", "OK", 40, 300, 0], ["text", "OK", 38, 280, 0]]), "DONE"]);
  await db.run(ins, ["OQ-F2", "АОСР-скан.pdf", "b".repeat(64), "ID", "ID-AOSR", now, pages([["ocr", "OK", 20, 100, 5], ["ocr", "LOW_QUALITY", 6, 40, 15], ["ocr", "ABSTAIN", 0, 0, 0]]), "DONE"]);
  await db.run(ins, ["OQ-F3", "КР.pdf", "c".repeat(64), "RD", "RD-KR", now, null, "PENDING"]);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "ocrq-pass-123" } })).json().token;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("GET /api/v1/inspection/:id/ocr-quality", () => {
  it("по файлам и итог: нечитаемые страницы, покрываемость, сомнительные слова; неразобранный файл отдельно", async () => {
    const r = await get("/api/v1/inspection/OQ-1/ocr-quality");
    expect(r.statusCode).toBe(200);
    const q = r.json();
    const scan = q.files.find((f: any) => f.file_id === "OQ-F2");
    expect(scan).toMatchObject({ file_name: "АОСР-скан.pdf", parsed: true, pages: 3, low_quality: 1, abstain: 1, illegible_pages: [2, 3], illegible_share: 0.667, coverage: 0.667, ocr_words: 140, doubtful_words: 20, doubtful_share: 0.143 });
    expect(q.files.find((f: any) => f.file_id === "OQ-F3")).toMatchObject({ parsed: false, pages: 0 });
    expect(q.total).toMatchObject({ files: 3, parsed_files: 2, pages: 5, illegible_share: 0.4, coverage: 0.8, doubtful_share: 0.143 });
  });

  it("проверки нет — 404; без входа — 401", async () => {
    expect((await get("/api/v1/inspection/NOPE/ocr-quality")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/inspection/OQ-1/ocr-quality" })).statusCode).toBe(401);
  });

  it("раздел протокола ocr_quality совпадает с отчётом маршрута", async () => {
    const { currentProtocol } = await import("../src/services/inspections.ts");
    const p = await currentProtocol(db, "OQ-1");
    expect(p.ocr_quality).toEqual((await get("/api/v1/inspection/OQ-1/ocr-quality")).json());
  });
});
