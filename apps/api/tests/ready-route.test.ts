// NFR-SLA (ТЗ 11-12): GET /ready — готовность для пробы blackbox-exporter. 200, когда БД и ML ответили за ≤ 2 с;
// иначе 503 с именами отказавших. Эшелоны: L4 (отказы: ML лежит, ML молчит, БД падает, БД молчит), L7 (без
// авторизации, как /health; ответ сверен со схемой OpenAPI — иначе валидатор ответов отдал бы 500).
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-ready-"));
let app: any;
let ml: http.Server;
// Подмена ML: ok — 200, down — 503, hang — не отвечает вовсе (сеть есть, процесс завис)
let mlMode: "ok" | "down" | "hang" = "ok";
// Подмена БД поверх настоящей: down — запрос падает, hang — не возвращается
let dbMode: "ok" | "down" | "hang" = "ok";

beforeAll(async () => {
  ml = http.createServer((req, res) => {
    if (mlMode === "hang") return; // соединение открыто, ответа нет
    res.writeHead(mlMode === "ok" ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: mlMode, profile: "dev" }));
  });
  await new Promise<void>((ok) => ml.listen(0, "127.0.0.1", ok));
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"),
    INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_ML_URL: `http://127.0.0.1:${(ml.address() as any).port}`,
  });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  const db = await openDb("memory");
  const flaky = new Proxy(db, {
    get(t, p, r) {
      if (p === "get" && dbMode !== "ok") {
        return dbMode === "down" ? async () => Promise.reject(new Error("соединение с БД потеряно")) : () => new Promise(() => {});
      }
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  app = buildApp(flaky as typeof db);
});
afterAll(async () => {
  await app?.close();
  ml.closeAllConnections();
  await new Promise((ok) => ml.close(ok));
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  mlMode = "ok";
  dbMode = "ok";
});

const ready = async () => {
  const t0 = Date.now();
  const r = await app.inject({ method: "GET", url: "/ready" });
  return { code: r.statusCode, body: r.json(), ms: Date.now() - t0 };
};

describe("NFR-SLA: GET /ready", () => {
  it("БД и ML отвечают — 200 {status: ready}, без токена", async () => {
    const r = await ready();
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ status: "ready" });
  });
  it("ML отвечает 503 — /ready 503, отказал ml", async () => {
    mlMode = "down";
    const r = await ready();
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ status: "not_ready", failed: ["ml"] });
  });
  it("ML не отвечает вовсе — 503 не позже чем через ~2 с, а не зависшая проба", { timeout: 10_000 }, async () => {
    mlMode = "hang";
    const r = await ready();
    expect(r.code).toBe(503);
    expect(r.body.failed).toEqual(["ml"]);
    expect(r.ms).toBeLessThan(2_800);
  });
  it("БД падает — 503, отказала db; ML при этом жив", async () => {
    dbMode = "down";
    const r = await ready();
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ status: "not_ready", failed: ["db"] });
  });
  it("БД молчит и ML лежит — 503 с обеими за ~2 с", { timeout: 10_000 }, async () => {
    dbMode = "hang";
    mlMode = "down";
    const r = await ready();
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ status: "not_ready", failed: ["db", "ml"] });
    expect(r.ms).toBeLessThan(2_800);
  });
  it("после восстановления — снова 200: готовность не залипает", async () => {
    mlMode = "down";
    expect((await ready()).code).toBe(503);
    mlMode = "ok";
    expect((await ready()).code).toBe(200);
  });
});
