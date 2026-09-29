// NFR-METRICS-STORE (ТЗ §10 п. 13, §13.4): сэмплер пишет снимок в monitoring_metrics, чистит старше 90 дней,
// администратор получает ряд по имени и интервалу. База в памяти, app.inject, без ML.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-monitoring-"));
let app: any;
let db: any;
const tokens: Record<string, string> = {};
const get = (url: string, who?: string) => app.inject({ method: "GET", url, headers: who ? { authorization: `Bearer ${tokens[who]}` } : {} });
const count = async (name: string) => ((await db.get("select count(*) n from monitoring_metrics where metric_name = $1", [name])) as any).n;

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_METRICS_SNAPSHOT_SEC: "0" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  for (const login of ["inspector", "supervisor", "admin"]) {
    tokens[login] = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: "test-pass" } })).json().token;
  }
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("снимок метрик в monitoring_metrics (NFR-METRICS-STORE)", () => {
  it("таблица по ТЗ §10 п. 13: id, metric_name, value, timestamp, service_name, tags", async () => {
    const cols = (await db.all("select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'monitoring_metrics' order by ordinal_position") as any[]).map((c) => c.column_name);
    expect(cols).toEqual(["id", "metric_name", "value", "timestamp", "service_name", "tags"]);
    const idx = (await db.all("select indexname from pg_indexes where schemaname = current_schema() and tablename = 'monitoring_metrics'") as any[]).map((i) => i.indexname);
    expect(idx).toContain("ix_metrics_name_ts");
  });

  it("сэмплер пишет снимок: мгновенные значения, затем скорости и p95 за интервал", async () => {
    const t0 = Date.now();
    const first = await app.metricsSampler.tick(t0);
    expect(first.written).toBeGreaterThan(0);
    expect(await count("process_rss_bytes")).toBe(1);
    expect(await count("http_rps")).toBe(0); // первый снимок — без скоростей
    for (let i = 0; i < 3; i++) await get("/api/v1/auth/me", "admin");
    await app.metricsSampler.tick(t0 + 60_000);
    const rps = (await db.get("select * from monitoring_metrics where metric_name = 'http_requests' order by id desc limit 1")) as any;
    expect(rps.value).toBeGreaterThanOrEqual(3);
    expect(rps.service_name).toBe("api");
    expect(JSON.parse(rps.tags)).toEqual({ profile: "dev" });
    expect(await count("http_latency_ms_p95")).toBeGreaterThanOrEqual(1);
    const route = (await db.all("select tags, value from monitoring_metrics where metric_name = 'http_route_requests'")) as any[];
    expect(route.find((r) => JSON.parse(r.tags).route === "GET /api/v1/auth/me")?.value).toBe(3);
    for (const n of ["active_sessions", "queue_size", "process_cpu_percent", "process_heap_used_bytes", "disk_free_bytes", "disk_used_percent", "http_errors_5xx"]) expect(await count(n)).toBeGreaterThanOrEqual(1);
  });

  it("очистка удаляет строки старше 90 дней, свежие остаются", async () => {
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const edge = new Date(Date.now() - 89 * 86_400_000).toISOString();
    await db.run("insert into monitoring_metrics (metric_name, value, timestamp, service_name, tags) values ('old_metric', 1, $1, 'api', '{}'), ('old_metric', 2, $2, 'api', '{}')", [old, edge]);
    const r = await app.metricsSampler.tick();
    expect(r.purged).toBe(1);
    expect(await db.all("select value from monitoring_metrics where metric_name = 'old_metric'")).toEqual([{ value: 2 }]);
  });

  it("tags хранится текстом байт в байт: JSON-строка метрики возвращается без переформатирования", async () => {
    const tags = '{"route":"GET /x","profile":"dev"}';
    await db.run("insert into monitoring_metrics (metric_name, value, timestamp, service_name, tags) values ('tags_probe', 1, $1, 'api', $2)", [new Date().toISOString(), tags]);
    expect(await db.get("select tags from monitoring_metrics where metric_name = 'tags_probe'")).toEqual({ tags });
  });
});

describe("GET /api/v1/monitoring/metrics — ряд администратору", () => {
  it("без входа — 401; инспектору и супервизору — 403", async () => {
    expect((await get("/api/v1/monitoring/metrics?name=http_rps")).statusCode).toBe(401);
    expect((await get("/api/v1/monitoring/metrics?name=http_rps", "inspector")).statusCode).toBe(403);
    expect((await get("/api/v1/monitoring/metrics?name=http_rps", "supervisor")).statusCode).toBe(403);
    expect((await get("/api/v1/monitoring/metric-names", "supervisor")).statusCode).toBe(403);
  });

  it("администратору — ряд по имени и интервалу, агрегированный по окнам", async () => {
    const T = Date.parse("2026-09-26T10:00:00.000Z");
    const ins = (v: number, at: number) => db.run("insert into monitoring_metrics (metric_name, value, timestamp, service_name, tags) values ('test_gauge', $1, $2, 'api', '{}')", [v, new Date(at).toISOString()]);
    for (const [i, v] of [2, 4, 6].entries()) await ins(v, T + i * 60_000);
    await ins(100, T + 3600_000); // вне интервала
    const r = await get("/api/v1/monitoring/metrics?name=test_gauge&from=2026-09-26T10:00:00Z&to=2026-09-26T10:30:00Z&bucket=600", "admin");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      name: "test_gauge", from: "2026-09-26T10:00:00.000Z", to: "2026-09-26T10:30:00.000Z", bucket_sec: 600, truncated: false,
      series: [{ tags: {}, points: [{ t: "2026-09-26T10:00:00.000Z", avg: 4, min: 2, max: 6, count: 3 }] }],
    });
  });

  it("неверный запрос — 400 с причиной", async () => {
    const r = await get("/api/v1/monitoring/metrics?name=x&bucket=5", "admin");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/bucket/);
    expect((await get("/api/v1/monitoring/metrics", "admin")).statusCode).toBe(400);
  });

  it("каталог имён: снятые метрики с последним значением", async () => {
    const r = await get("/api/v1/monitoring/metric-names", "admin");
    expect(r.statusCode).toBe(200);
    const byName = Object.fromEntries((r.json() as any[]).map((m) => [m.metric_name, m]));
    expect(byName.test_gauge).toEqual({ metric_name: "test_gauge", last_at: "2026-09-26T11:00:00.000Z", last_value: 100, service_name: "api" });
    expect(byName.http_rps).toBeDefined();
  });

  it("маршруты описаны в OpenAPI", async () => {
    const paths = (await get("/api/v1/openapi.json")).json().paths;
    expect(paths["/api/v1/monitoring/metrics"].get.parameters.map((p: any) => p.name)).toEqual(["name", "from", "to", "bucket"]);
    expect(paths["/api/v1/monitoring/metric-names"]).toBeDefined();
  });
});

describe("том для метрики диска", () => {
  it("pglite:<каталог> — том каталога данных; memory и сервер PostgreSQL — том корня приложения", async () => {
    const { diskDir } = await import("../src/services/monitoring.ts");
    expect(diskDir("pglite:var/pg", "/srv/app")).toBe("/srv/app/var");
    expect(diskDir("pglite:/data/pg", "/srv/app")).toBe("/data");
    expect(diskDir("memory", "/srv/app")).toBe("/srv/app");
    expect(diskDir("postgres://u:p@db:5432/inspector", "/srv/app")).toBe("/srv/app");
  });
});

describe("таймер сэмплера", () => {
  it("start пишет снимки по периоду, повторный start не плодит таймеры, stop останавливает", async () => {
    const before = await count("process_rss_bytes");
    app.metricsSampler.start(20);
    app.metricsSampler.start(20);
    await new Promise((r) => setTimeout(r, 110));
    await app.metricsSampler.stop(); // дожидается снимка, который уже идёт
    const after = await count("process_rss_bytes");
    expect(after - before).toBeGreaterThanOrEqual(2);
    expect(after - before).toBeLessThanOrEqual(6); // один таймер, не два
    await new Promise((r) => setTimeout(r, 60));
    expect(await count("process_rss_bytes")).toBe(after);
  });
});
