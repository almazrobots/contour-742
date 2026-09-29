// T-133: выдача файла кусками (Range) — pdf.js открывает лист чертежа без скачивания всего PDF. Эшелоны: L1 (206 и
// Content-Range по байтам), L6 (диапазон за файлом — 416, чушь — файл целиком). База в памяти, app.inject, без S3.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-range-"));
const BODY = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
let app: any;
let db: any;
let token = "";
let fileId = "";

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  const { setBlobStoreForTests } = await import("../src/services/blobstore.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  setBlobStoreForTests({ kind: "fs", get: async () => BODY } as any);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  const { createInspection } = await import("../src/services/inspections.ts");
  const insp = await createInspection({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-RANGE", name: "Синтетика", address: "", customer: "", contractor: "", permit_number: "", profile: {} });
  fileId = "f-range-1";
  // client_file_id, document_code, revision — not null со времён 0001_init (T-132: без них вставка падала в гейте)
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, uploaded_at)
    values ($1, $2, 'OBJ-RANGE', 'PD-range-1', 'лист.pdf', $3, $4, 'pdf', 'PD', 'П-0000-ЛИСТ', '0', 'DONE', now())`, [fileId, insp, "a".repeat(64), BODY.length]);
});
afterAll(async () => {
  const { setBlobStoreForTests } = await import("../src/services/blobstore.ts");
  setBlobStoreForTests(null);
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const get = (range?: string) =>
  app.inject({ method: "GET", url: `/api/v1/files/${fileId}/content`, headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) } });

describe("файл кусками для просмотра PDF (T-133)", () => {
  it("без Range — файл целиком и признак Accept-Ranges", async () => {
    const r = await get();
    expect([r.statusCode, r.headers["accept-ranges"], r.rawPayload.length]).toEqual([200, "bytes", 5000]);
  });
  it("Range — 206, Content-Range и ровно эти байты", async () => {
    const r = await get("bytes=100-199");
    expect([r.statusCode, r.headers["content-range"], r.rawPayload.length]).toEqual([206, "bytes 100-199/5000", 100]);
    expect(r.rawPayload.equals(BODY.subarray(100, 200))).toBe(true);
    const tail = await get("bytes=4990-");
    expect([tail.statusCode, tail.headers["content-range"], tail.rawPayload.length]).toEqual([206, "bytes 4990-4999/5000", 10]);
  });
  it("диапазон за концом файла — 416 с размером; несколько диапазонов — файл целиком", async () => {
    const r = await get("bytes=6000-");
    expect([r.statusCode, r.headers["content-range"]]).toEqual([416, "bytes */5000"]);
    expect((await get("bytes=0-1,5-9")).statusCode).toBe(200);
  });
});
