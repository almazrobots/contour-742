// NFR-PERF-RUNTIME (T-138): пределы §11 под наблюдением в эксплуатации — время ML-анализа параметра (TZA-11-07),
// CV-анализа листа (TZA-11-08) и отправки в «РиН» (TZA-11-06) в /metrics гистограммами; предел — граница корзины,
// алерт deploy/gpu/alerts.yml считает p95 по этим рядам. L1 — функциональные, L7 — согласованность алертов с рядами.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let app: any;
let db: any;
let slo: typeof import("../src/services/slo-metrics.ts");
let insp: typeof import("../src/services/inspections.ts");

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  slo = await import("../src/services/slo-metrics.ts");
  insp = await import("../src/services/inspections.ts");
  db = await openDb("memory");
  app = buildApp(db);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("время ML-анализа параметра из ответа ML (OS-INSP-2.2.34)", () => {
  it("каждый параметр свежего ответа — наблюдение в секундах; превышение 500 мс видно по доле выше предела", () => {
    const before = slo.slo.mlParam.count;
    expect(insp.observeParamTimes({ cached: false, param_ms: { "M-001": 40, "M-002": 700 } })).toBe(2);
    expect(slo.slo.mlParam.count).toBe(before + 2);
    expect(slo.slo.mlParam.overShare(slo.LIMITS.mlParam)).toBeGreaterThan(0);
  });

  it("ответ из кэша ML не учитывается: это время прежнего анализа", () => {
    const before = slo.slo.mlParam.count;
    expect(insp.observeParamTimes({ cached: true, param_ms: { "M-001": 10 } })).toBe(0);
    expect(insp.observeParamTimes({ cached: false })).toBe(0); // старый ML без времени — ничего
    expect(slo.slo.mlParam.count).toBe(before);
  });
});

describe("/metrics и алерты по пределам §11 (NFR-PERF-RUNTIME)", () => {
  it("четыре гистограммы в экспозиции Prometheus, у каждой корзина на пределе §11", async () => {
    const body = (await app.inject({ method: "GET", url: "/metrics" })).body as string;
    const want: Array<[string, number]> = [
      ["inspector_ml_param_seconds", slo.LIMITS.mlParam],
      ["inspector_cv_sheet_seconds", slo.LIMITS.cvSheet],
      ["inspector_rin_attempt_seconds", slo.LIMITS.rinAttempt],
      ["inspector_rin_delivery_seconds", slo.LIMITS.rinDelivery],
    ];
    for (const [name, limit] of want) {
      expect(body).toContain(`# TYPE ${name} histogram`);
      expect(body).toContain(`${name}_bucket{le="${limit}"}`);
      expect(body).toMatch(new RegExp(`${name}_count \\d+`));
    }
  });

  it("L7 · в alerts.yml на каждый предел — алерт по p95 гистограммы с порогом, равным пределу", () => {
    // корень репозитория — вверх по дереву: в песочнице Stryker тест лежит глубже, и «../../../» туда не доходит
    let dir = __dirname;
    while (!existsSync(join(dir, "deploy/gpu/alerts.yml")) && dirname(dir) !== dir) dir = dirname(dir);
    const y = readFileSync(join(dir, "deploy/gpu/alerts.yml"), "utf8");
    for (const [name, limit] of [["inspector_ml_param_seconds", 0.5], ["inspector_cv_sheet_seconds", 30], ["inspector_rin_delivery_seconds", 30]] as const) {
      const expr = new RegExp(`histogram_quantile\\(0\\.95, sum by \\(le\\) \\(rate\\(${name}_bucket\\[15m\\]\\)\\)\\) > ${String(limit).replace(".", "\\.")}\\b`);
      expect(y).toMatch(expr);
    }
  });
});

describe("время CV-анализа листа из ответа ML (OS-INSP-2.4.7)", () => {
  it("измерение листа: ms из ответа ML — в гистограмму; отказ по сроку отдаётся как есть, с причиной", async () => {
    const { setMlMeasureTransport } = await import("../src/services/ml-client.ts");
    const now = new Date().toISOString();
    await db.run("insert into objects (id, name, created_at) values ('CV-OBJ', 'Объект', $1)", [now]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('CV-I', 'CV-OBJ', 'PENDING', 0, $1, $1)", [now]);
    await db.run(
      "insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, uploaded_at) values ('CV-F', 'CV-I', 'CV-OBJ', 'c1', 'plan.pdf', $1, 1, 'pdf', 'RD', 'RD-AR', '0', $2)",
      ["a".repeat(64), now],
    );
    const f = { rows: [{ id: "CV-F" }] };
    const { hashPassword } = await import("../src/db.ts");
    await db.run("insert into users (id, login, name, role, password_hash) values ('u-cv', 'cv', 'CV', 'inspector', $1) on conflict do nothing", [hashPassword("pw-cv-12345")]);
    const token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "cv", password: "pw-cv-12345" } })).json().token;
    setMlMeasureTransport(async () => ({ status: "NOT_COMPARABLE", method: "timeout", reason: "анализ листа дольше 30 с", ms: 31_000, mm_per_px: null, sheet_scale: null, sheet_scale_gost: null, stamp_scale: null, render_dpi: 150, dimension_lines: [], distances: [] }) as any);
    const before = slo.slo.cvSheet.count;
    const r = await app.inject({ method: "GET", url: `/api/v1/files/${f.rows[0].id}/measure?page=1`, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "NOT_COMPARABLE", method: "timeout", reason: "анализ листа дольше 30 с", distances: [] });
    expect(slo.slo.cvSheet.count).toBe(before + 1);
    expect(slo.slo.cvSheet.overShare(slo.LIMITS.cvSheet)).toBeGreaterThan(0);
  });
});
