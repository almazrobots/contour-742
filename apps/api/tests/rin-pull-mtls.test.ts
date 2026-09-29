// NFR-MTLS + OS-INSP-1.2.15: автозабор ходит в ИАИС «РиН» тем же mTLS, что и передача протокола. GET-транспорт
// rinGetTransport — настоящее рукопожатие на 127.0.0.1 (фикстуры tests/fixtures/mtls, создаёт setup-mtls.ts).
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rinGetTransport, type RinTls } from "../src/services/rin-tls.ts";

const dir = join(import.meta.dirname, "fixtures/mtls");
const f = (name: string) => join(dir, name);
const read = (name: string) => readFileSync(f(name));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

type Srv = { base: string; seen: string[]; hits: string[] };
async function listen(server: http.Server | https.Server, scheme: "http" | "https", seen: string[], hits: string[]): Promise<Srv> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { base: `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, hits };
}

/** «РиН» с mTLS: /list — JSON, /big — 5 МБ, /moved — 302 на /list. */
async function rin(opts: { cert?: string; key?: string } = {}): Promise<Srv> {
  const seen: string[] = [];
  const hits: string[] = [];
  const server = https.createServer({ requestCert: true, rejectUnauthorized: true, ca: read("ca.crt"), cert: read(opts.cert ?? "server.crt"), key: read(opts.key ?? "server.key") }, (req, res) => {
    seen.push((req.socket as TLSSocket).getPeerCertificate().subject.CN as string);
    hits.push(`${req.method} ${req.url} ${req.headers.accept}`);
    if (req.url === "/big") return void res.writeHead(200).end(Buffer.alloc(5 * 1024 * 1024, 0x41));
    if (req.url === "/moved") return void res.writeHead(302, { location: "/list" }).end();
    res.writeHead(200, { "content-type": "application/json" }).end('{"packages":[]}');
  });
  server.on("tlsClientError", () => {}); // отказы рукопожатия ожидаемы
  return listen(server, "https", seen, hits);
}

function direct(over: Partial<Extract<RinTls, { mode: "direct" }>> = {}): RinTls {
  return { mode: "direct", url: "https://127.0.0.1", caPath: f("ca.crt"), minVersion: "TLSv1.2", client: { kind: "pem", certPath: f("client.crt"), keyPath: f("client.key") }, ...over };
}

describe("GET-транспорт автозабора «РиН» (NFR-MTLS, OS-INSP-1.2.15)", () => {
  it("direct: GET предъявляет клиентский сертификат, сервер «РиН» проверен по CA; тело и статус возвращаются", async () => {
    const s = await rin();
    const r = await rinGetTransport(direct())(`${s.base}/list`, 1000);
    expect([r.status, r.body.toString()]).toEqual([200, '{"packages":[]}']);
    expect(s.seen).toEqual(["inspector-test-client"]);
    expect(s.hits).toEqual(["GET /list application/json, application/octet-stream"]);
  });

  it("direct: клиент от чужого CA — сервер «РиН» отказывает; сервер от чужого CA — отказывает клиент", async () => {
    const s = await rin();
    await expect(rinGetTransport(direct({ client: { kind: "pem", certPath: f("other-client.crt"), keyPath: f("other-client.key") } }))(`${s.base}/list`, 1000)).rejects.toThrow();
    expect(s.seen).toEqual([]);
    const rogue = await rin({ cert: "rogue-server.crt", key: "rogue-server.key" });
    await expect(rinGetTransport(direct())(`${rogue.base}/list`, 1000)).rejects.toThrow();
    expect(rogue.hits).toEqual([]);
  });

  it("direct: тело больше предела не дочитывается (5 МБ при пределе 64 КБ); редирект не выполняется — 302 приходит статусом", async () => {
    const s = await rin();
    const g = rinGetTransport(direct());
    const big = await g(`${s.base}/big`, 64 * 1024);
    expect(big.status).toBe(200);
    expect(big.body.length).toBeGreaterThan(64 * 1024);
    expect(big.body.length).toBeLessThan(5 * 1024 * 1024);
    const moved = await g(`${s.base}/moved`, 1000);
    expect(moved.status).toBe(302);
    expect(s.hits.filter((h) => h.startsWith("GET /list"))).toEqual([]); // по location не ходили
  });

  it("direct: адрес не https — отказ до соединения; тайм-аут — исключение (сбой сети, повтор в следующем цикле)", async () => {
    await expect(rinGetTransport(direct())("http://127.0.0.1:9/list", 10)).rejects.toThrow("direct: запрос не по https отклонён");
    const hang = https.createServer({ cert: read("server.crt"), key: read("server.key") }, () => {}); // не отвечает
    const h = await listen(hang, "https", [], []);
    await expect(rinGetTransport(direct(), { timeoutMs: 150 })(`${h.base}/list`, 10)).rejects.toThrow("нет ответа за 150 мс");
  });

  it("gost-proxy: GET идёт открытым текстом только на loopback-шлюз СКЗИ; иной адрес — отказ", async () => {
    const hits: string[] = [];
    const gw = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200).end("[]"); });
    const s = await listen(gw, "http", [], hits);
    const g = rinGetTransport({ mode: "gost-proxy", url: s.base });
    expect((await g(`${s.base}/list`, 100)).body.toString()).toBe("[]");
    expect(hits).toEqual(["GET /list"]);
    await expect(g("http://10.0.0.1/list", 100)).rejects.toThrow("gost-proxy: запрос не на loopback-шлюз СКЗИ отклонён");
    await expect(g(`${s.base.replace("http:", "https:")}/list`, 100)).rejects.toThrow("gost-proxy");
  });
});

describe("автозабор берёт транспорт по окружению (INSPECTOR_RIN_TLS)", () => {
  it("INSPECTOR_RIN_TLS=direct: pollRin ходит в «РиН» по mTLS с клиентским сертификатом; неполная настройка — громкая ошибка цикла", async () => {
    const s = await rin();
    vi.resetModules();
    Object.assign(process.env, {
      INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_RIN_MOCK: "0",
      INSPECTOR_RIN_URL: `${s.base}/rin`, INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_CA: f("ca.crt"),
      INSPECTOR_RIN_CLIENT_CERT: f("client.crt"), INSPECTOR_RIN_CLIENT_KEY: f("client.key"),
    });
    try {
      const { openDb } = await import("../src/db.ts");
      const pull = await import("../src/services/rin-pull.ts");
      const sum = await pull.pollRin(pull.rinCtx(await openDb("memory")));
      expect(sum.error).toBeNull();
      expect(s.seen).toEqual(["inspector-test-client"]);
      expect(s.hits[0]).toMatch(/^GET \/rin\/api\/v1\/packages/);

      vi.resetModules();
      delete process.env.INSPECTOR_RIN_CA;
      const pull2 = await import("../src/services/rin-pull.ts");
      const { openDb: openDb2 } = await import("../src/db.ts");
      expect((await pull2.pollRin(pull2.rinCtx(await openDb2("memory")))).error).toContain("INSPECTOR_RIN_CA");
    } finally {
      for (const k of ["INSPECTOR_RIN_TLS", "INSPECTOR_RIN_CA", "INSPECTOR_RIN_CLIENT_CERT", "INSPECTOR_RIN_CLIENT_KEY", "INSPECTOR_RIN_MOCK", "INSPECTOR_RIN_URL"]) delete process.env[k];
    }
  });
});
