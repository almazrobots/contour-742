// Эшелоны: L1 (туннель CONNECT до хранилища), L6 (прокси отказал — понятная ошибка, а не зависание). T-129: стенд на маке
// выводит трафик к S3 мимо VPN через scripts/egress-direct.py; TLS до хранилища сквозной, прокси видит только поток.
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectProxyAgent } from "../src/services/blobstore.ts";

const DIR = mkdtempSync(join(tmpdir(), "s3-proxy-"));
let tlsServer: https.Server;
let proxy: http.Server;
let tlsPort = 0;
let proxyPort = 0;
const seen: string[] = [];

beforeAll(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(DIR, "k.pem"), "-out", join(DIR, "c.pem")], { stdio: "ignore" });
  tlsServer = https.createServer({ key: readFileSync(join(DIR, "k.pem")), cert: readFileSync(join(DIR, "c.pem")) }, (_q, r) => r.end("S3-OK"));
  await new Promise<void>((ok) => tlsServer.listen(0, "127.0.0.1", ok));
  tlsPort = (tlsServer.address() as net.AddressInfo).port;
  proxy = http.createServer();
  proxy.on("connect", (req, sock) => {
    seen.push(req.url!);
    if (!req.url!.startsWith("localhost:")) return sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const up = net.connect(tlsPort, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(sock);
      sock.pipe(up);
    });
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  proxyPort = (proxy.address() as net.AddressInfo).port;
});
afterAll(() => {
  tlsServer?.close();
  proxy?.close();
  rmSync(DIR, { recursive: true, force: true });
});

const get = (host: string, agent: https.Agent) =>
  new Promise<string>((ok, bad) => https.get({ host, port: tlsPort, path: "/", agent, ca: readFileSync(join(DIR, "c.pem")) }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => ok(b)); }).on("error", bad));

describe("S3 через CONNECT-прокси (стенд мимо VPN)", () => {
  it("запрос идёт туннелем CONNECT, TLS проверяет сертификат хранилища по имени хоста", async () => {
    expect(await get("localhost", connectProxyAgent(`http://127.0.0.1:${proxyPort}`))).toBe("S3-OK");
    expect(seen).toContain(`localhost:${tlsPort}`);
  });
  it("прокси отказал (адрес не в разрешённых) — ошибка с кодом ответа прокси", async () => {
    await expect(get("127.0.0.1", connectProxyAgent(`http://127.0.0.1:${proxyPort}`))).rejects.toThrow(/прокси S3 отказал: 403/);
  });
  it("прокси не http:// — громкая ошибка конфигурации; учётные данные из адреса в текст ошибки не попадают (SEC-13)", () => {
    expect(() => connectProxyAgent("socks5://127.0.0.1:1")).toThrow(/ждём http:\/\/хост:порт/);
    let msg = "";
    try {
      connectProxyAgent("socks5://user:s3cr3t@127.0.0.1:1");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("127.0.0.1:1");
    expect(msg).not.toMatch(/s3cr3t|user/);
  });
  it("прокси принял соединение и молчит — отказ по тайм-ауту CONNECT, а не зависание (SEC-13)", async () => {
    const mute = net.createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => mute.once("listening", r));
    const port = (mute.address() as net.AddressInfo).port;
    try {
      await expect(get("localhost", connectProxyAgent(`http://127.0.0.1:${port}`, 300))).rejects.toThrow(/не ответил на CONNECT за 0\.3 с/);
    } finally {
      mute.close();
    }
  });
});
