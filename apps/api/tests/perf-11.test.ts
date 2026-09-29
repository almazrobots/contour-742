// Пределы §11 ТЗ в гейте (OS-INSP-6.5.11, T-135): пересчёт всех параметров Матрицы ≤ 2 мин (TZA-11-04), протокол JSON
// ≤ 30 с (TZA-11-05), отклик API p95 ≤ 200 мс (TZA-11-10). Эталонный прогон — проверка с ПД и РД, где у КАЖДОГО параметра
// Матрицы есть значение на обеих стадиях: сравниваются все 132 (худший случай для пересчёта). PDF протокола меряется
// в ML (ml/tests/test_perf_11.py). Замер на реальном пакете и стенде — scripts/bench-11-stand.mjs, docs/qa/PERF-11.md.
// Эшелоны: L7 (дисциплина: предел ТЗ роняет гейт), L3 (граница — предел ТЗ).
import { loadavg } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.INSPECTOR_DEMO_PASSWORD ??= "perf-11-password";
process.env.INSPECTOR_SHEET_DIFF_AUTO = "0";
let db: any;
let app: any;
let ins: any;
let inspection = "";
let params: any[] = [];

const LIMIT = { recomputeMs: 120_000, protocolMs: 30_000, p95Ms: 200 }; // §11 ТЗ
// Отклик p95 — замер времени: при чужой нагрузке на машине он мерит соседей, а не API. Выше порога load1 шаг явно
// пропускается (виден в отчёте как skipped и строкой причины); итоговый замер §11 — на стенде (bench-11-stand.mjs, PERF-11).
const MAX_LOAD = Number(process.env.INSPECTOR_PERF_MAX_LOAD ?? "8");
const load1 = loadavg()[0];
const busy = load1 > MAX_LOAD;
const SKIP_NOTE = `perf пропущен: load1 ${load1.toFixed(1)} > ${MAX_LOAD} — p95 §11 мерить на стенде (scripts/bench-11-stand.mjs)`;

beforeAll(async () => {
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  ins = await import("../src/services/inspections.ts");
  db = await openDb("memory");
  app = buildApp(db);
  await app.ready();
  params = await db.all("select code, data_type, value_scale_json from params where is_active order by id");
  const ctx = { db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" } };
  inspection = await ins.createInspection(ctx, { object_id: "OBJ-PERF", name: "Эталон §11" });
  for (const [id, stage, code] of [["perf-pd", "PD", "П-2099-01-001-ПЗ"], ["perf-rd", "RD", "РД-2099-01-001-АР"]]) {
    // объём «Алтуфьевского 79Б»: 3 395 страниц — по 1 700 описаний страниц на файл (полное описание, как пишет ML)
    const pages = Array.from({ length: 1700 }, (_, k) => ({ page: k + 1, width: 2383.9, height: 1683.8, rotation: 0, source: k % 8 ? "text" : "ocr", quality: "OK", ocr_confidence: k % 8 ? null : 82.2, engines: k % 8 ? [] : ["tesseract-psm4", "tesseract-prep", "tesseract-psm6"], disputed_words: 3, agreement: 0.97, lines: 34 }));
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, approval_status, parse_status, revision_role, uploaded_at, pages_json)
      values ($1,$2,'OBJ-PERF',$1,$1,$3,1,'pdf',$4,$5,'1','APPROVED','DONE','CURRENT','2026-09-27T00:00:00Z',$6)`, [id, inspection, id.padEnd(64, "0").slice(0, 64), stage, code, JSON.stringify(pages)]);
    for (const p of params) {
      const scale = p.value_scale_json ? JSON.parse(p.value_scale_json) : null;
      const text = Array.isArray(scale) ? scale[scale.length - 1] : p.data_type === "number" ? null : "ЗНАЧЕНИЕ";
      await db.run(`insert into extractions (file_id, param_code, kind, raw, value_num, value_text, page, bbox_json, line_text, confidence)
        values ($1,$2,'param',$3,$4,$5,1,$6,$7,0.95)`, [id, p.code, String(text ?? 100), text ? null : stage === "PD" ? 100 : 97, text, JSON.stringify([0.1, 0.1, 0.2, 0.12]), `${p.code} ${text ?? 100}`]);
    }
  }
});
afterAll(async () => await app?.close());

describe("пределы §11 ТЗ на эталонном прогоне (OS-INSP-6.5.11)", () => {
  it("статус проверки без загруженного пакета — 200 со сценарием null, а не 500 (контракт OpenAPI, найдено замером §11)", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: process.env.INSPECTOR_DEMO_PASSWORD } });
    const fresh = await ins.createInspection({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" } }, { object_id: "OBJ-FRESH", name: "Новая" });
    const r = await app.inject({ method: "GET", url: `/api/v1/inspection/${fresh}/status`, headers: { authorization: `Bearer ${login.json().token}` } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().scenario).toBeNull();
  });

  it("TZA-11-04: пересчёт всех параметров Матрицы — не дольше 2 мин", async () => {
    expect(params.length).toBeGreaterThanOrEqual(132);
    const t0 = performance.now();
    await ins.recompute(db, inspection, new Set());
    const ms = performance.now() - t0;
    const n = (await db.get("select count(*)::int n from checks where inspection_id = $1", [inspection])).n;
    expect(n).toBeGreaterThanOrEqual(132);
    console.log(`§11 пересчёт ${n} параметров: ${ms.toFixed(0)} мс`);
    expect(ms).toBeLessThan(LIMIT.recomputeMs);
  });

  it("TZA-11-05: протокол JSON (все разделы и 132 параметра) — не дольше 30 с", async () => {
    const t0 = performance.now();
    const p = await ins.currentProtocol(db, inspection);
    const json = JSON.stringify(p);
    const ms = performance.now() - t0;
    expect(json.length).toBeGreaterThan(10_000);
    console.log(`§11 протокол JSON: ${ms.toFixed(0)} мс, ${json.length} байт`);
    expect(ms).toBeLessThan(LIMIT.protocolMs);
  });

  it.skipIf(busy)((busy ? `${SKIP_NOTE} · ` : "") + "TZA-11-10: отклик API p95 — не больше 200 мс (карточка проверки, 200 запросов по 10 параллельно)", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: process.env.INSPECTOR_DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${login.json().token}` };
    const urls = [`/api/v1/inspections/${inspection}`, `/api/v1/inspection/${inspection}/status`, "/api/v1/params", "/api/v1/dictionaries"];
    const times: number[] = [];
    for (let b = 0; b < 20; b++) {
      await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const t0 = performance.now();
          const url = urls[(b * 10 + i) % urls.length];
          const r = await app.inject({ method: "GET", url, headers: auth });
          times.push(performance.now() - t0);
          expect(r.statusCode, `${url}: ${r.body.slice(0, 200)}`).toBe(200);
        }),
      );
    }
    const card = await app.inject({ method: "GET", url: `/api/v1/inspections/${inspection}`, headers: auth });
    // T-233 (решение владельца 28.09: сначала результат, оптимизация потом): в main карточка выросла до 405 КБ —
    // потолок временно 450 КБ; вернуть 400 КБ после разбора, какой раздел карточки вырос
    expect(card.body.length, "карточка с 3 400 страницами — краткое описание страниц, не полное").toBeLessThan(450_000);
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1];
    console.log(`§11 p50 ${times[times.length >> 1].toFixed(1)} мс · p95 ${p95.toFixed(1)} мс · ${times.length} запросов`);
    expect(p95).toBeLessThan(LIMIT.p95Ms);
  });
});
