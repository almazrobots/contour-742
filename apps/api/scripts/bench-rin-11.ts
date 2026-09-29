// Стенд §11 для отправки в ИАИС «РиН» (OS-INSP-6.5.17, TZA-11-06): ≤ 30 с на отправку.
// Настоящий транспорт (rin-tls.ts, режим off — fetch) против локальной «РиН», отвечающей с задержкой 0–25 с, по капле
// и не отвечающей вовсе; очередь sync_jobs — настоящая (PGlite в памяти), один тик runDueSyncJobs.
// Меряет: длительность каждой попытки (срок 30 с целиком), время доставки, время тика (параллельная отправка ×4).
// Запуск: pnpm --filter ./apps/api exec tsx scripts/bench-rin-11.ts [--out ../../var/bench-rin-11.json]
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: process.env.INSPECTOR_DEMO_PASSWORD ?? "bench-rin", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
const outArg = process.argv.indexOf("--out");
const OUT = resolve(outArg > 0 ? process.argv[outArg + 1] : "../../var/bench-rin-11.json");

// поведение «РиН» по номеру проверки: задержка ответа, мс; drip — ответ по байту в секунду; hang — молчит
const CASES: Array<[string, number | "drip" | "hang"]> = [
  ["R-0", 0], ["R-50", 50], ["R-500", 500], ["R-2000", 2000], ["R-5000", 5000], ["R-10000", 10_000], ["R-25000", 25_000],
  ["R-DRIP", "drip"], ["R-HANG", "hang"], ["R-0b", 0], ["R-100b", 100], ["R-1000b", 1000],
];

async function main() {
  const server = http.createServer((req, res) => {
    req.resume();
    const id = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    const how = CASES.find(([k]) => k === id)?.[1] ?? 0;
    if (how === "hang") return;
    if (how === "drip") {
      res.writeHead(200, { "content-length": "100000" });
      const t = setInterval(() => res.write("x"), 1000);
      res.on("close", () => clearInterval(t));
      return;
    }
    setTimeout(() => res.writeHead(202, { "content-type": "application/json" }).end("{}"), how);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.INSPECTOR_RIN_URL = url;

  const { openDb } = await import("../src/db.ts");
  const rin = await import("../src/services/rin.ts");
  const { rinTransport, RIN_TIMEOUT_MS } = await import("../src/services/rin-tls.ts");
  const { config } = await import("../src/config.ts");
  (config as any).rinUrl = url;
  const db = await openDb("memory");
  rin.setRinTransport(rinTransport({ mode: "off", url }, { timeoutMs: RIN_TIMEOUT_MS }));

  const now = new Date().toISOString();
  await db.run("insert into objects (id, name, created_at) values ('B-OBJ', 'Стенд', $1)", [now]);
  for (const [id] of CASES) {
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1, 'B-OBJ', 'FINALIZED', 1, $2, $2)", [id, now]);
    const body = JSON.stringify({ process_id: id, object: {}, protocol_version: 1, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: null });
    await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1, 1, 'FINALIZED', $2, $3)", [id, body, now]);
    await db.run("insert into sync_jobs (inspection_id, protocol_version, status, next_attempt_at, created_at, updated_at) values ($1, 1, 'PENDING_SYNC', $2, $2, $2)", [id, now]);
  }
  const t0 = performance.now();
  const n = await rin.runDueSyncJobs(db, new Date(Date.now() + 1000));
  const tickMs = Math.round(performance.now() - t0);
  const rows = await db.all<any>("select inspection_id, status, attempts, last_error, last_attempt_ms, delivered_ms from sync_jobs order by id");
  server.closeAllConnections();
  server.close();
  await db.close();

  const LIMIT = 30_000;
  const TOL = 1_000; // накладные расходы таймера и сокета
  const cases = rows.map((r) => {
    const how = CASES.find(([k]) => k === r.inspection_id)![1];
    const expectSynced = typeof how === "number" && how < LIMIT;
    return { id: r.inspection_id, rin_behaviour: how, status: r.status, attempt_ms: r.last_attempt_ms, delivered_ms: r.delivered_ms, error: r.last_error, ok: r.last_attempt_ms <= LIMIT + TOL && (expectSynced ? r.status === "SYNCED" : r.status === "PENDING_SYNC") };
  });
  const res = {
    schema: "inspector-bench-rin/1", at: new Date().toISOString(), limit_ms: LIMIT, jobs: n, concurrency: rin.SYNC_CONCURRENCY,
    tick_ms: tickMs, max_attempt_ms: Math.max(...cases.map((c) => c.attempt_ms)), cases,
    verdict: cases.every((c) => c.ok) ? "OK" : "FAIL",
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(res, null, 2));
  for (const c of cases) console.log(`${c.id.padEnd(8)} ${String(c.rin_behaviour).padStart(6)} → ${c.status.padEnd(12)} попытка ${c.attempt_ms} мс${c.delivered_ms !== null ? `, доставка ${c.delivered_ms} мс` : ""}${c.ok ? "" : "  ✗"}`);
  console.log(`тик ${tickMs} мс на ${n} протоколов (×${rin.SYNC_CONCURRENCY}); вердикт ${res.verdict} → ${OUT}`);
  process.exit(res.verdict === "OK" ? 0 : 1);
}

void main();
