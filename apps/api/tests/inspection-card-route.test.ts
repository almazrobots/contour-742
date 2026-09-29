// NFR-LOAD-100 (T-075): карточка проверки отдаёт сводку страниц без текста и слов разбора. Нагрузочный прогон на 100
// инспекторов (docs/qa/LOAD-100.md) показал p95 карточки 1,06 с: каждый запрос тащил строки и слова всех страниц
// всех файлов, а вебу нужны только число страниц, источник, качество и уверенность OCR (L4, PGlite).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { colorFromCounts, dashboardCounts } from "../src/domain/lifecycle.ts";

const TMP = mkdtempSync(join(tmpdir(), "inspector-card-"));
let app: any;
let db: any;
let token = "";
const now = () => new Date().toISOString();

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

describe("NFR-LOAD-100 карточка проверки без текста страниц", () => {
  it("страницы файла — номер, источник, качество, уверенность OCR; строк и слов разбора нет", async () => {
    await db.run("insert into objects (id, name, profile_json, created_at) values ('O-C1','C1','{}',$1)", [now()]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('C1','O-C1','READY',1,$1,$1)", [now()]);
    const pages = [
      { page: 1, width: 595, height: 842, rotation: 0, source: "ocr", quality: "LOW_QUALITY", ocr_confidence: 71, engines: ["tesseract"], disputed_words: 2, agreement: 0.9,
        lines: [{ text: "Площадь застройки 2926,3", bbox: [0, 0, 1, 1], words: [{ text: "Площадь", bbox: [0, 0, 0.1, 0.1] }] }], requisites: [{ kind: "stamp" }] },
      { page: 2, width: 595, height: 842, rotation: 0, source: "text", quality: "OK", ocr_confidence: null, lines: [{ text: "Лист 2", bbox: [0, 0, 1, 1], words: [] }] },
    ];
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, uploaded_at, parse_status, pages_json)
                  values ('F-C1','C1','O-C1','F1','a.pdf',$1,1,'pdf','PD','ШФР','1',$2,'DONE',$3)`, ["a".repeat(64), now(), JSON.stringify(pages)]);
    const r = await app.inject({ method: "GET", url: "/api/v1/inspections/C1", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    const got = r.json().files[0].pages;
    // сводка — поля, которые читает интерфейс (T-135 pages-brief.ts: собирает PostgreSQL, pages_json не покидает базу)
    expect(got).toEqual([
      { page: 1, source: "ocr", quality: "LOW_QUALITY", ocr_confidence: 71 },
      { page: 2, source: "text", quality: "OK", ocr_confidence: null },
    ]);
    expect(r.body).not.toContain("Площадь застройки");
  });

  it("журнал карточки: записи самой проверки и её записей-проверок, новые сверху, чужие не попадают", async () => {
    await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, computed_in_version, created_at, updated_at)
                  values ('C1-K','C1','M-001','g','CANDIDATE','PENDING',1,$1,$1)`, [now()]);
    const add = (action: string, object: string) =>
      db.run("insert into audit_log (user_id, action, object_id, details, timestamp) values ('system',$1,$2,'{}',$3)", [action, object, now()]);
    await add("A_INSPECTION", "C1");
    await add("B_CHECK", "C1-K");
    await add("C_ALIEN", "ДРУГАЯ");
    const r = await app.inject({ method: "GET", url: "/api/v1/inspections/C1", headers: { authorization: `Bearer ${token}` } });
    expect(r.json().audit.map((a: any) => a.action)).toEqual(["B_CHECK", "A_INSPECTION"]);
  });
});

describe("NFR-LOAD-100 дашборд: счётчики агрегатом PostgreSQL", () => {
  it("счётчики, цвет и разделы строки дашборда совпадают с эталоном по строкам проверок; SPLIT не считается", async () => {
    await db.run("insert into objects (id, name, profile_json, created_at) values ('O-D1','D1','{}',$1)", [now()]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('D1','O-D1','VERIFYING',1,$1,$1)", [now()]);
    const rows: Array<[string, string, string]> = [
      ["M-001", "CANDIDATE", "PENDING"], ["M-002", "CANDIDATE", "CONFIRMED_VIOLATION"], ["M-010", "CLARIFICATION_REQUIRED", "PENDING"],
      ["M-020", "MISSING_EVIDENCE", "PENDING"], ["M-030", "NEGATIVE_VERIFIED", "PENDING"], ["M-040", "CANDIDATE", "NEGATIVE_VERIFIED"],
      ["M-050", "CANDIDATE", "SPLIT"],
    ];
    for (const [i, [code, f, v]] of rows.entries()) {
      await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, computed_in_version, created_at, updated_at)
                    values ($1,'D1',$2,'g',$3,$4,1,$5,$5)`, [`D1-${i}`, code, f, v, now()]);
    }
    const r = await app.inject({ method: "GET", url: "/api/v1/inspections", headers: { authorization: `Bearer ${token}` } });
    const row = r.json().find((x: any) => x.process_id === "D1") ?? r.json().items?.find((x: any) => x.process_id === "D1");
    const live = rows.filter(([, , v]) => v !== "SPLIT").map(([, f, v]) => ({ finding_status: f, verification_status: v }) as any);
    expect(row.counts).toEqual(dashboardCounts(live));
    expect(row.color).toBe(colorFromCounts(dashboardCounts(live)));
    const secs = await db.all("select code, section from params where code in ('M-001','M-002','M-040','M-050')");
    const want = [...new Set(secs.filter((p: any) => ["M-001", "M-002", "M-040"].includes(p.code)).map((p: any) => p.section))].sort();
    expect([...row.sections].sort()).toEqual(want);
  });
});
