// OS-INSP-5.2.5, OS-INSP-5.2.6 (ТЗ §11, TZA-11-06): отправка протокола в ИАИС «РиН» — не более 30 с.
// 5.2.5: срок попытки — целиком (соединение, передача, ответ), а не простой сокета: сервер, отдающий ответ по байту,
// раньше держал попытку сколько угодно — таймер простоя сбрасывался каждым байтом.
// 5.2.6: созревшие задания одного тика уходят параллельно (не больше 4): зависшая отправка не задерживает остальные;
// время попытки и доставки — в базе и в гистограммах /metrics. L1 — функциональные, L4 — отказы сети, L3 — граница 4.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rinTransport } from "../src/services/rin-tls.ts";

const servers: http.Server[] = [];
async function server(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe("срок попытки отправки в «РиН» — целиком (OS-INSP-5.2.5)", () => {
  it("ответ по байту каждые 40 мс — попытка прерывается по сроку 300 мс, а не тянется, пока капает", { timeout: 5000 }, async () => {
    const url = await server((req, res) => {
      req.resume();
      res.writeHead(200, { "content-length": "1000" });
      const t = setInterval(() => res.write("x"), 40);
      res.on("close", () => clearInterval(t));
    });
    const t0 = Date.now();
    await expect(rinTransport({ mode: "gost-proxy", url }, { timeoutMs: 300 })(`${url}/api/v1/inspection/P-1`, {})).rejects.toThrow("ИАИС «РиН»: нет ответа за 300 мс");
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(900);
  });

  it("заголовки по капле до ответа — то же: срок считается от начала попытки", { timeout: 5000 }, async () => {
    const url = await server((req) => {
      req.resume();
      const sock = req.socket;
      sock.write("HTTP/1.1 200 OK\r\n");
      const t = setInterval(() => sock.write("X-Drip: 1\r\n"), 40);
      sock.on("close", () => clearInterval(t));
    });
    const t0 = Date.now();
    await expect(rinTransport({ mode: "gost-proxy", url }, { timeoutMs: 300 })(`${url}/x`, {})).rejects.toThrow(/нет ответа за 300 мс/);
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it("быстрый ответ укладывается в срок и не оставляет таймер: процесс не держится открытым", async () => {
    const url = await server((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(202).end("ok"));
    });
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await expect(rinTransport({ mode: "gost-proxy", url }, { timeoutMs: 60_000 })(`${url}/x`, { a: 1 })).resolves.toEqual({ status: 202 });
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBeLessThanOrEqual(before);
  });

  it("режим off (fetch) тоже держит срок целиком: заголовки не пришли — прерывание по сроку", { timeout: 5000 }, async () => {
    const url = await server((req) => req.resume()); // принял и молчит
    const t0 = Date.now();
    await expect(rinTransport({ mode: "off", url }, { timeoutMs: 200 })(`${url}/x`, {})).rejects.toThrow(/нет ответа за 200 мс/);
    expect(Date.now() - t0).toBeLessThan(800);
  });
});

// ─────────────────────────────── очередь: параллельность и время доставки (OS-INSP-5.2.6)

let db: any;
let rin: typeof import("../src/services/rin.ts");
let slo: typeof import("../src/services/slo-metrics.ts");
let send: (url: string) => Promise<{ status: number }> = async () => ({ status: 200 });
const body = (id: string) => JSON.stringify({ process_id: id, object: {}, protocol_version: 1, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: null });

async function finalized(id: string, queuedAt = new Date()): Promise<number> {
  const now = queuedAt.toISOString();
  await db.run("insert into objects (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing", ["DL-OBJ", "Объект", now]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1, 'DL-OBJ', 'FINALIZED', 1, $2, $2)", [id, now]);
  await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1, 1, 'FINALIZED', $2, $3)", [id, body(id), now]);
  const r = await db.run("insert into sync_jobs (inspection_id, protocol_version, status, next_attempt_at, created_at, updated_at) values ($1, 1, 'PENDING_SYNC', $2, $2, $2) returning id", [id, now]);
  return r.rows[0].id;
}
const job = (id: number) => db.get("select * from sync_jobs where id = $1", [id]);

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  rin = await import("../src/services/rin.ts");
  slo = await import("../src/services/slo-metrics.ts");
  db = await openDb("memory");
  rin.setRinTransport((url) => send(url));
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.run("delete from sync_jobs");
  send = async () => ({ status: 200 });
});

describe("очередь «РиН»: параллельная отправка и время доставки (OS-INSP-5.2.6)", () => {
  it("зависшая отправка одного протокола не задерживает остальные: быстрые доставлены раньше медленного", async () => {
    const slowId = await finalized("DL-SLOW");
    const fastIds = [await finalized("DL-F1"), await finalized("DL-F2")];
    const doneAt: Record<string, number> = {};
    send = async (url) => {
      const id = url.split("/").pop()!;
      await new Promise((r) => setTimeout(r, id === "DL-SLOW" ? 400 : 20));
      doneAt[id] = Date.now();
      return { status: 200 };
    };
    const t0 = Date.now();
    expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 1000))).toBe(3);
    expect(Date.now() - t0).toBeLessThan(700); // последовательно было бы ≥ 440 мс только на отправку плюс хвост; параллельно — ≈ 400
    expect(doneAt["DL-F1"]).toBeLessThan(doneAt["DL-SLOW"]);
    expect(doneAt["DL-F2"]).toBeLessThan(doneAt["DL-SLOW"]);
    for (const id of [slowId, ...fastIds]) expect(await job(id)).toMatchObject({ status: "SYNCED", attempts: 1 });
  });

  it("L3 · одновременно в полёте не больше 4 отправок, все 7 заданий доставлены за один тик", async () => {
    for (let i = 0; i < 7; i++) await finalized(`DL-C${i}`);
    let inFlight = 0;
    let peak = 0;
    send = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { status: 200 };
    };
    expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 1000))).toBe(7);
    expect(peak).toBe(rin.SYNC_CONCURRENCY);
    expect(rin.SYNC_CONCURRENCY).toBe(4);
    expect((await db.get("select count(*)::int n from sync_jobs where status = 'SYNCED'")).n).toBe(7);
  });

  it("время попытки и доставки сохраняется в задании и попадает в гистограммы /metrics", async () => {
    const queued = new Date(Date.now() - 2000); // протокол стоит в очереди 2 с
    const id = await finalized("DL-T1", queued);
    send = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { status: 200 };
    };
    const attempts0 = slo.slo.rinAttempt.count;
    const deliveries0 = slo.slo.rinDelivery.count;
    await rin.runDueSyncJobs(db, new Date());
    const j = await job(id);
    expect(j.status).toBe("SYNCED");
    expect(j.last_attempt_ms).toBeGreaterThanOrEqual(45);
    expect(j.last_attempt_ms).toBeLessThan(1000);
    expect(j.delivered_ms).toBeGreaterThanOrEqual(2000);
    expect(j.delivered_ms).toBeLessThan(4000);
    expect(slo.slo.rinAttempt.count).toBe(attempts0 + 1);
    expect(slo.slo.rinDelivery.count).toBe(deliveries0 + 1);
  });

  it("L4 · неудачная попытка пишет своё время, но не время доставки; доставки в гистограмме нет", async () => {
    const id = await finalized("DL-T2");
    send = async () => {
      throw new Error("ИАИС «РиН»: нет ответа за 30000 мс");
    };
    const deliveries0 = slo.slo.rinDelivery.count;
    await rin.runDueSyncJobs(db, new Date(Date.now() + 1000));
    const j = await job(id);
    expect(j).toMatchObject({ status: "PENDING_SYNC", delivered_ms: null, last_error: "ИАИС «РиН»: нет ответа за 30000 мс" });
    expect(j.last_attempt_ms).toBeGreaterThanOrEqual(0);
    expect(slo.slo.rinDelivery.count).toBe(deliveries0);
  });

  it("L4 · сбой одной отправки в параллельной пачке не мешает остальным: каждое задание — свой итог", async () => {
    const bad = await finalized("DL-BAD");
    const good = await finalized("DL-GOOD");
    send = async (url) => (url.endsWith("/DL-BAD") ? { status: 503 } : { status: 200 });
    await rin.runDueSyncJobs(db, new Date(Date.now() + 1000));
    expect(await job(bad)).toMatchObject({ status: "PENDING_SYNC", last_error: "HTTP 503" });
    expect(await job(good)).toMatchObject({ status: "SYNCED" });
  });
});
