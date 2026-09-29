// Эшелоны: L7 (дисциплина контракта: гейт не пропускает маршрут без схемы), L2 (схема OpenAPI — независимое описание
// ответа, по которому валидатор проверяет обработчик). NFR-API-VALIDATE (ТЗ 1.3 «с обязательной валидацией схемы
// OpenAPI 3.0»), T-129. Храповик: tests/openapi-uncovered.json только сокращается.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
let app: any;
let db: any;
let doc: any;
let key: (p: string) => string;
const ratchet = JSON.parse(readFileSync(join(import.meta.dirname, "openapi-uncovered.json"), "utf8")).routes as string[];

beforeAll(async () => {
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  ({ openapi: doc } = await import("../src/openapi.ts"));
  ({ pathKey: key } = await import("../src/services/openapi-validate.ts"));
  db = await openDb("memory");
  app = buildApp(db);
  await app.ready();
});
afterAll(async () => await app?.close());

// x-direction: outbound — контракт исходящего вызова во внешнюю систему (ИАИС «РиН»), а не маршрут этого API
const described = () => new Set(Object.entries(doc.paths).flatMap(([p, ms]: [string, any]) => Object.entries(ms).filter(([, op]: [string, any]) => op["x-direction"] !== "outbound").map(([m]) => `${m.toUpperCase()} ${key(p)}`)));
const apiRoutes = () => [...new Set<string>(app.routeList.filter((r: any) => r.url.startsWith("/api/")).map((r: any) => `${r.method} ${key(r.url)}`))];

describe("контракт OpenAPI (NFR-API-VALIDATE)", () => {
  it("каждый маршрут API описан в OpenAPI, кроме списка-храповика; новый маршрут без схемы роняет гейт", () => {
    const d = described();
    expect(apiRoutes().filter((r) => !d.has(r) && !ratchet.includes(r))).toEqual([]);
  });
  it("храповик не устарел: маршрут из списка, уже описанный в OpenAPI или удалённый, из списка вычеркнут", () => {
    const d = described();
    const live = new Set(apiRoutes());
    expect(ratchet.filter((r) => d.has(r) || !live.has(r))).toEqual([]);
  });
  it("в OpenAPI нет путей, которых нет в приложении", () => {
    const live = new Set(apiRoutes());
    expect([...described()].filter((r) => r.includes(" /api/") && !live.has(r))).toEqual([]);
  });
  it("у каждого описанного маршрута успешный ответ со схемой JSON (кроме файлов: экспорт протокола, содержимое файла)", async () => {
    // файлы (экспорт протокола, содержимое файла) и экспозиция Prometheus /metrics (text/plain по протоколу Prometheus) — не JSON
    const binary = new Set(["GET /api/v1/inspection/{}/protocol/export", "GET /api/v1/files/{}/content", "GET /metrics", "GET /api/v1/verification/assignments/{}/content/{}", "GET /api/v1/verification/assignments/{}/fragment/{}", "GET /api/v1/verification/library/{}/content/{}", "GET /api/v1/verification/library/{}/fragment/{}"]);
    const noSchema = Object.entries(doc.paths).flatMap(([p, ms]: [string, any]) =>
      Object.entries(ms).filter(([m, op]: [string, any]) => {
        const k = `${m.toUpperCase()} ${key(p)}`;
        if (binary.has(k)) return false;
        const ok = Object.entries(op.responses ?? {}).filter(([c]) => c.startsWith("2"));
        return !ok.length || ok.some(([, r]: [string, any]) => !r.content?.["application/json"]?.schema);
      }).map(([m]) => `${m.toUpperCase()} ${p}`));
    // долг NFR-API-VALIDATE: описаны без схемы успешного ответа — список сокращается вместе с храповиком
    expect(noSchema).toEqual([]);
    expect(noSchema.length).toBeLessThanOrEqual(NO_SCHEMA_MAX);
  });
});
const NO_SCHEMA_MAX = 0; // 27.09 (T-129): было 20 из 63; все описанные маршруты — со схемой успешного JSON-ответа

// Маршруты, которые не вызывает ни один другой тест: ответ проходит схему своего кода (иначе валидатор отдал бы 500)
describe("ответы маршрутов без другого покрытия соответствуют схеме (NFR-API-VALIDATE)", () => {
  const t = new Date().toISOString();
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: string, url: string, payload?: unknown) => {
    tokens[who] ??= (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: who, password: process.env.INSPECTOR_DEMO_PASSWORD } })).json().token;
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) });
    expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300);
    return r.json();
  };
  beforeAll(async () => {
    await db.run("insert into objects (id, name, created_at) values ($1,$2,$3)", ["O-OA", "Объект", t]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$5)", ["P-OA", "O-OA", "VERIFYING", 1, t]);
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, pages_json, uploaded_at)
      values ($1,'P-OA','O-OA',$1,$2,$3,1,'pdf','RD','Р-АР',$4,'DONE','[{},{}]',$5)`, ["f-oa-1", "a.pdf", "a".repeat(64), "A", t]);
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, pages_json, uploaded_at)
      values ($1,'P-OA','O-OA',$1,$2,$3,1,'pdf','RD','Р-АР',$4,'DONE','[{},{}]',$5)`, ["f-oa-2", "b.pdf", "b".repeat(64), "B", t]);
    for (const k of ["s1", "s2"]) await db.run("insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, dedup_key) values ('P-OA','O-OA','LOGICAL',0.7,'Гипотеза',$1)", [k]);
    await db.run("insert into retraining_reports (since, until, body_json, created_at) values ($1,$2,$3,$4)", ["2026-09-01", "2026-09-08", JSON.stringify({ totals: [] }), t]);
  });

  it("гипотеза: решение инспектора и перевод в кандидаты; фрагменты новой записи", async () => {
    const [a, b] = (await db.all("select id from suspicions where inspection_id = 'P-OA' order by id")).map((r: any) => r.id);
    expect(await call("inspector", "POST", `/api/v1/suspicions/${a}/status`, { inspector_status: "DISMISSED" })).toEqual({ ok: true });
    const { check_id } = await call("inspector", "POST", `/api/v1/suspicions/${b}/promote`, { file_id: "f-oa-1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2], quote: null });
    expect((await call("inspector", "GET", `/api/v1/checks/${check_id}/fragments`))[0]).toMatchObject({ check_id, file_id: "f-oa-1", sheet_page: 1 });
  });
  it("дифф пары листов по запросу инспектора", async () => {
    const ml = await import("../src/services/ml-client.ts");
    ml.setMlDiffTransport(async () => ({ status: "ok", reason: null, inliers: 100, matches: 120, method: "sift", regions: [], ms: 1, cached: false }));
    expect(await call("inspector", "POST", "/api/v1/inspection/P-OA/sheet-diff", { file_a: "f-oa-1", page_a: 1, file_b: "f-oa-2", page_b: 1 })).toMatchObject({ status: "ok", created: 0 });
  });
  it("нормативы: создание, правка, поиск (ML — подставной ответ формы /norms/search)", async () => {
    const { id } = await call("admin", "POST", "/api/v1/normative", { document_name: "СП", document_number: "СП 1.13130.2020", param_code: null, min_value: 0.8 });
    expect(await call("admin", "PATCH", `/api/v1/normative/${id}`, { effective_to: null })).toEqual({ ok: true, recomputed: [] }); // T-234: пересчитанные проверки
    const norms = await import("../src/services/norms.ts");
    norms.setMlPost(async (_p, body: any) => ({ query: body.query, method: "bm25", results: [{ id: `db:${id}`, document_number: "СП 1.13130.2020", document_name: "СП", section: null, summary: "СП", summary_is_paraphrase: false, param_codes: [], numeric: { min_value: 0.8 }, source: "db", score: 1, bm25: 2.1, cosine: null }] }));
    try {
      expect((await call("inspector", "GET", "/api/v1/normative/search?q=эвакуация&top_k=3")).results).toHaveLength(1);
    } finally {
      norms.setMlPost();
    }
  });
  it("дообучение: версии набора и отчёты по расписанию; заглушка «РиН»", async () => {
    expect(await call("curator", "GET", "/api/v1/ml/datasets")).toEqual([]);
    expect((await call("curator", "GET", "/api/v1/ml/reports?limit=5"))[0]).toMatchObject({ since: "2026-09-01", body: { totals: [] } });
    expect(await call("admin", "POST", "/api/v1/admin/rin-mock", { down: false })).toMatchObject({ down: false });
  });
  it("запуск разбора без новых файлов — пересчёт сразу", async () => {
    expect(await call("inspector", "POST", "/api/v1/inspection/P-OA/start")).toEqual({ queued: 0 });
  });
});

describe("регрессии, найденные при описании схем (T-129)", () => {
  it("перевод гипотезы с нечисловым id — 400 по схеме пути, а не 500 от приведения к bigint; несуществующий — 404", async () => {
    const tok = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: process.env.INSPECTOR_DEMO_PASSWORD } })).json().token;
    const r = await app.inject({ method: "POST", url: "/api/v1/suspicions/abc/promote", headers: { authorization: `Bearer ${tok}` }, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/^Запрос не соответствует схеме OpenAPI: \/id /);
    const n = await app.inject({ method: "POST", url: "/api/v1/suspicions/999999999/promote", headers: { authorization: `Bearer ${tok}` }, payload: {} });
    expect(n.statusCode).toBe(404);
    expect(n.json()).toEqual({ error: "Гипотеза не найдена" });
  });
});

describe("обход проверки схемы закрыт (OWASP-аудит T-129: SEC-05, SEC-06)", () => {

  it("тип тела «Application/JSON» в другом регистре — тело всё равно проверяется по схеме", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "Application/JSON" }, payload: JSON.stringify({ login: 123, password: "x" }) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/^Запрос не соответствует схеме OpenAPI/);
  });
  it("текст нарушения: запрос и ответ названы по-разному; первое нарушение — словами ajv; допустимые значения — только у enum", async () => {
    const { SchemaViolation } = await import("../src/services/openapi-validate.ts");
    expect(new SchemaViolation("response", []).message).toBe("Ответ не соответствует схеме OpenAPI");
    expect(new SchemaViolation("request", [{ path: "/a", message: "must be string", keyword: "type" }]).message).toBe("Запрос не соответствует схеме OpenAPI: /a must be string");
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: 1, password: "x" } });
    const d = r.json().details as Array<{ keyword: string; message: string; allowed?: unknown }>;
    expect(d.length).toBeGreaterThan(0);
    for (const x of d) {
      expect(x.message.length).toBeGreaterThan(0);
      if (x.keyword !== "enum") expect("allowed" in x).toBe(false);
    }
  });
  it("ответ не по схеме — 500 без внутренностей ответа наружу: ни details, ни допустимых значений", async () => {
    const { attachOpenapiValidation } = await import("../src/services/openapi-validate.ts");
    const Fastify = (await import("fastify")).default;
    const a = Fastify();
    const logged: unknown[] = [];
    attachOpenapiValidation(a, { paths: { "/x": { get: { responses: { 200: { content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["OK"] } } } } } } } } } } } as any, (_l, _m, extra) => logged.push(extra));
    a.get("/x", async () => ({ status: "SECRET_INTERNAL_STATE" }));
    const r = await a.inject({ method: "GET", url: "/x" });
    expect(r.statusCode).toBe(500);
    expect(Object.keys(r.json())).toEqual(["error"]);
    expect(r.body).not.toMatch(/SECRET|OK|status/);
    expect(JSON.stringify(logged)).toMatch(/status/); // подробности — в журнале

  });
});
