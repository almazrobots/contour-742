// Эшелоны: L4 (сбой: долгий ответ ML), L8 (регрессия стенда «Алтуфьевское 79Б», T-129): большой PDF обрывался на
// 5-й минуте по headersTimeout undici, хотя тайм-аут ML — 30 минут; повтор запускал второй разбор того же файла, ML падал по памяти.
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mlDispatcher } from "../src/services/ml-client.ts";

let srv: http.Server;
let url = "";
beforeAll(async () => {
  // ML «думает» 2,5 с, прежде чем отдать заголовки ответа
  srv = http.createServer((_q, r) => setTimeout(() => r.end("{}"), 2500));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(srv.address() as any).port}/`;
});
afterAll(() => srv.close());

describe("срок ответа ML задаёт INSPECTOR_ML_TIMEOUT_MS, а не умолчание undici", () => {
  it("ожидание заголовков ответа — по тайм-ауту ML: короче ответа — обрыв, длиннее — ответ получен", { timeout: 15_000 }, async () => {
    const short = await fetch(url, { dispatcher: mlDispatcher(300) } as any).catch((e) => e);
    expect(short?.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
    const long = await fetch(url, { dispatcher: mlDispatcher(10_000) } as any);
    expect(long.status).toBe(200);
  });
  it("каждый вызов ML (analyze, diff, measure) идёт через это соединение", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/services/ml-client.ts"), "utf8");
    const calls = [...src.matchAll(/fetch\(`\$\{config\.mlUrl\}\/(analyze|diff|measure)`[\s\S]*?\}\);/g)];
    expect(calls.map((m) => m[1]).sort()).toEqual(["analyze", "diff", "measure"]);
    for (const m of calls) expect(m[0]).toContain("...ml");
  });
});
