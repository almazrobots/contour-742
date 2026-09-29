// NFR-MTLS · TZA-9.6.2-03: транспорт в ИАИС «РиН» с взаимной TLS-аутентификацией — настоящее рукопожатие на 127.0.0.1.
// Фикстуры — tests/fixtures/mtls, создаются setup-mtls.ts при запуске (см. README там же). ГОСТ-сертификат УКЭП здесь не проверяется:
// OpenSSL в Node ГОСТ не умеет, эксплуатационный путь — режим gost-proxy через СКЗИ.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackUrl, resolveRinTls, rinTransport, rinTransportFromEnv, type RinTls } from "../src/services/rin-tls.ts";

const dir = join(import.meta.dirname, "fixtures/mtls");
const f = (name: string) => join(dir, name);
const read = (name: string) => readFileSync(f(name));

type Srv = { url: string; seen: string[]; bodies: Array<{ method?: string; type?: string; body: string }>; close: () => Promise<void> };
const open: Srv[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** Простой HTTP-сервер на loopback (шлюз СКЗИ или заглушка «РиН»); handler по умолчанию отвечает 202 и пишет тело. */
async function plainServer(handler?: http.RequestListener): Promise<Srv> {
  const bodies: Srv["bodies"] = [];
  const server = http.createServer(
    handler ??
      ((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          bodies.push({ method: req.method, type: req.headers["content-type"], body });
          res.writeHead(202).end();
        });
      }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const s: Srv = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen: [],
    bodies,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  open.push(s);
  return s;
}

/** Сервер «РиН»: требует клиентский сертификат от своего CA и записывает CN предъявившего. */
async function rinServer(opts: { cert?: string; key?: string; maxVersion?: "TLSv1.2" | "TLSv1.3" } = {}): Promise<Srv> {
  const seen: string[] = [];
  const bodies: Srv["bodies"] = [];
  const server = https.createServer(
    { requestCert: true, rejectUnauthorized: true, ca: read("ca.crt"), cert: read(opts.cert ?? "server.crt"), key: read(opts.key ?? "server.key"), maxVersion: opts.maxVersion },
    (req, res) => {
      seen.push((req.socket as TLSSocket).getPeerCertificate().subject.CN as string);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push({ method: req.method, type: req.headers["content-type"], body });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    },
  );
  server.on("tlsClientError", () => {}); // отказы рукопожатия ожидаемы
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const s: Srv = {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/inspection/P-1`,
    seen,
    bodies,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  open.push(s);
  return s;
}

function direct(over: Partial<Extract<RinTls, { mode: "direct" }>> = {}): RinTls {
  return { mode: "direct", url: "https://127.0.0.1", caPath: f("ca.crt"), minVersion: "TLSv1.2", client: { kind: "pem", certPath: f("client.crt"), keyPath: f("client.key") }, ...over };
}

const payload = { process_id: "P-1", confirmed_violations: [] };

describe("mTLS с ИАИС «РиН» (NFR-MTLS, TZA-9.6.2-03)", () => {
  it("с сертификатом клиента от доверенного CA запрос проходит и сервер видит subject клиента", async () => {
    const s = await rinServer();
    expect(await rinTransport(direct())(s.url, payload)).toEqual({ status: 200 });
    expect(s.seen).toEqual(["inspector-test-client"]);
    expect(s.bodies).toEqual([{ method: "POST", type: "application/json", body: JSON.stringify(payload) }]);
  });

  it("клиентский сертификат в контейнере PFX с паролем тоже предъявляется", async () => {
    const s = await rinServer();
    const t = rinTransport(direct({ client: { kind: "pfx", pfxPath: f("client.p12"), passphrase: "test-only" } }));
    expect(await t(s.url, payload)).toEqual({ status: 200 });
    expect(s.seen).toEqual(["inspector-test-client"]);
  });

  it("неверный пароль PFX — ошибка при построении транспорта без утечки пароля", () => {
    expect(() => rinTransport(direct({ client: { kind: "pfx", pfxPath: f("client.p12"), passphrase: "wrong-secret" } }))).toThrow(
      "INSPECTOR_RIN_TLS=direct: клиентский сертификат/ключ или CA не загружаются (INSPECTOR_RIN_CLIENT_PFX / INSPECTOR_RIN_CLIENT_PFX_PASS, INSPECTOR_RIN_CA)",
    );
    try {
      rinTransport(direct({ client: { kind: "pfx", pfxPath: f("client.p12"), passphrase: "wrong-secret" } }));
    } catch (e) {
      expect(String(e)).not.toContain("wrong-secret");
    }
  });

  it("без клиентского сертификата сервер рвёт рукопожатие, а транспорт без сертификата не строится", async () => {
    const s = await rinServer();
    // тот же CA и проверка сервера, но без cert/key — как если бы сертификат не был настроен
    const call = () =>
      new Promise((resolve, reject) => {
        const req = https.request(s.url, { method: "POST", ca: read("ca.crt"), rejectUnauthorized: true, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject);
        req.end("{}");
      });
    await expect(call()).rejects.toThrow();
    expect(s.seen).toEqual([]);
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_URL: s.url, INSPECTOR_RIN_CA: f("ca.crt") }, { profile: "gpu", mock: false })).toThrow(/INSPECTOR_RIN_CLIENT_CERT/);
  });

  it("клиентский сертификат чужого CA отклоняется сервером", async () => {
    const s = await rinServer();
    const t = rinTransport(direct({ client: { kind: "pem", certPath: f("other-client.crt"), keyPath: f("other-client.key") } }));
    await expect(t(s.url, payload)).rejects.toThrow();
    expect(s.seen).toEqual([]);
  });

  it("сервер с сертификатом не от доверенного CA клиент отвергает сам", async () => {
    const s = await rinServer({ cert: "rogue-server.crt", key: "rogue-server.key" });
    await expect(rinTransport(direct())(s.url, payload)).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
    expect(s.seen).toEqual([]);
  });

  it("minVersion TLSv1.3 против сервера с потолком TLSv1.2 — отказ", async () => {
    const s = await rinServer({ maxVersion: "TLSv1.2" });
    await expect(rinTransport(direct({ minVersion: "TLSv1.3" }))(s.url, payload)).rejects.toThrow();
    expect(s.seen).toEqual([]);
    // тот же сервер с нижней границей TLSv1.2 принимает
    expect(await rinTransport(direct())(s.url, payload)).toEqual({ status: 200 });
  });

  it("транспорт direct не отправляет по http", async () => {
    await expect(rinTransport(direct())("http://127.0.0.1:1/x", payload)).rejects.toThrow(/direct: запрос не по https отклонён/);
  });

  it("gost-proxy отдаёт протокол локальному шлюзу СКЗИ по HTTP на loopback", async () => {
    const got: string[] = [];
    const gw = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(b); res.writeHead(202).end(); }); });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
    try {
      const t = rinTransport(resolveRinTls({ INSPECTOR_RIN_TLS: "gost-proxy", INSPECTOR_RIN_URL: url }, { profile: "gpu", mock: false }));
      expect(await t(`${url}/api/v1/inspection/P-1`, payload)).toEqual({ status: 202 });
      expect(JSON.parse(got[0]!)).toEqual(payload);
    } finally {
      gw.close();
    }
  });

  it("gost-proxy не отправляет открытым текстом за пределы loopback", async () => {
    await expect(rinTransport({ mode: "gost-proxy", url: "http://127.0.0.1:1" })("http://10.0.0.5/api", payload)).rejects.toThrow(/loopback/);
  });
  it("режим off шлёт JSON обычным fetch — только для заглушки и dev", async () => {
    const s = await plainServer();
    expect(await rinTransport({ mode: "off", url: s.url })(`${s.url}/api/v1/inspection/P-1`, payload)).toEqual({ status: 202 });
    expect(s.bodies).toEqual([{ method: "POST", type: "application/json", body: JSON.stringify(payload) }]);
  });

  it("транспорт по окружению процесса строится из INSPECTOR_RIN_TLS и отправляет", async () => {
    const s = await plainServer();
    vi.stubEnv("INSPECTOR_RIN_TLS", "gost-proxy");
    vi.stubEnv("INSPECTOR_RIN_URL", s.url);
    // NFR-UKEP: в gpu с настоящей «РиН» без подписи УКЭП транспорт не строится — подписант cryptcp (поддельный, fixtures/ukep)
    const log = join(mkdtempSync(join(tmpdir(), "rin-mtls-")), "cryptcp.log");
    vi.stubEnv("INSPECTOR_UKEP_MODE", "cryptopro");
    vi.stubEnv("INSPECTOR_UKEP_THUMBPRINT", "ab".repeat(20));
    vi.stubEnv("INSPECTOR_UKEP_CRYPTCP_BIN", join(import.meta.dirname, "fixtures/ukep/fake-cryptcp.sh"));
    vi.stubEnv("FAKE_CRYPTCP_CERT", f("client.crt"));
    vi.stubEnv("FAKE_CRYPTCP_KEY", f("client.key"));
    vi.stubEnv("FAKE_CRYPTCP_LOG", log);
    try {
      expect(await rinTransportFromEnv({ profile: "gpu", mock: false })(`${s.url}/api/v1/inspection/P-1`, payload)).toEqual({ status: 202 });
      vi.stubEnv("INSPECTOR_RIN_TLS", "off");
      expect(() => rinTransportFromEnv({ profile: "gpu", mock: false })).toThrow(/off недопустим/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(s.bodies).toHaveLength(1);
  });

  it("шлюз не ответил за отведённое время — транспорт бросает ошибку таймаута", async () => {
    const s = await plainServer(() => {}); // принял запрос и молчит
    const t = rinTransport({ mode: "gost-proxy", url: s.url }, { timeoutMs: 100 });
    await expect(t(`${s.url}/api/v1/inspection/P-1`, payload)).rejects.toThrow("ИАИС «РиН»: нет ответа за 100 мс");
  });

  it("обрыв соединения посреди ответа — ошибка, а не зависание", { timeout: 3000 }, async () => {
    const s = await plainServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-length": "100" });
      res.write("abc");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expect(rinTransport({ mode: "gost-proxy", url: s.url })(`${s.url}/x`, payload)).rejects.toThrow(/aborted/);
  });

  it("gost-proxy не отправляет по https и на нераспознаваемый адрес", async () => {
    const t = rinTransport({ mode: "gost-proxy", url: "http://127.0.0.1:1" });
    await expect(t("https://127.0.0.1:1/x", payload)).rejects.toThrow("gost-proxy: запрос не на loopback-шлюз СКЗИ отклонён");
    await expect(t("не адрес", payload)).rejects.toThrow("gost-proxy: запрос не на loopback-шлюз СКЗИ отклонён");
    expect(isLoopbackUrl("не адрес")).toBe(false);
  });

  it("нечитаемый файл сертификата — ошибка с именем переменной", () => {
    const nope = f("нет-такого-файла.pem");
    expect(() => rinTransport(direct({ caPath: nope }))).toThrow(`INSPECTOR_RIN_CA=${nope}: файл не читается`);
    expect(() => rinTransport(direct({ client: { kind: "pem", certPath: nope, keyPath: f("client.key") } }))).toThrow(`INSPECTOR_RIN_CLIENT_CERT=${nope}`);
    expect(() => rinTransport(direct({ client: { kind: "pem", certPath: f("client.crt"), keyPath: nope } }))).toThrow(`INSPECTOR_RIN_CLIENT_KEY=${nope}`);
    expect(() => rinTransport(direct({ client: { kind: "pfx", pfxPath: nope, passphrase: "x" } }))).toThrow(`INSPECTOR_RIN_CLIENT_PFX=${nope}`);
  });

  it("ключ не от сертификата — ошибка при построении транспорта с именами переменных PEM", () => {
    expect(() => rinTransport(direct({ client: { kind: "pem", certPath: f("client.crt"), keyPath: f("other-client.key") } }))).toThrow(
      "INSPECTOR_RIN_TLS=direct: клиентский сертификат/ключ или CA не загружаются (INSPECTOR_RIN_CLIENT_CERT / INSPECTOR_RIN_CLIENT_KEY, INSPECTOR_RIN_CA)",
    );
  });
});

describe("выбор режима транспорта «РиН» (resolveRinTls)", () => {
  const gpu = { profile: "gpu", mock: false };
  const base = { INSPECTOR_RIN_URL: "https://rin.example/api", INSPECTOR_RIN_CA: "/ca.crt", INSPECTOR_RIN_CLIENT_CERT: "/c.crt", INSPECTOR_RIN_CLIENT_KEY: "/c.key" };

  it("профиль gpu с настоящей «РиН» и режимом off — ошибка", () => {
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "off" }, gpu)).toThrow(/off недопустим/);
  });

  it("off допустим с заглушкой или в профиле dev", () => {
    expect(resolveRinTls({ INSPECTOR_RIN_TLS: "off" }, { profile: "gpu", mock: true }).mode).toBe("off");
    expect(resolveRinTls({}, { profile: "dev", mock: false }).mode).toBe("off");
  });

  it("gpu без явного режима требует mTLS, а не молча off", () => {
    expect(() => resolveRinTls({ INSPECTOR_RIN_URL: "https://rin.example" }, gpu)).toThrow(/INSPECTOR_RIN_CA/);
  });

  it("direct без CA — ошибка с именем переменной INSPECTOR_RIN_CA", () => {
    const { INSPECTOR_RIN_CA: _, ...env } = base;
    expect(() => resolveRinTls({ ...env, INSPECTOR_RIN_TLS: "direct" }, gpu)).toThrow(/INSPECTOR_RIN_CA/);
  });

  it("direct без ключа клиента — ошибка с именем переменной INSPECTOR_RIN_CLIENT_KEY", () => {
    const { INSPECTOR_RIN_CLIENT_KEY: _, ...env } = base;
    expect(() => resolveRinTls({ ...env, INSPECTOR_RIN_TLS: "direct" }, gpu)).toThrow(/INSPECTOR_RIN_CLIENT_KEY/);
  });

  it("direct с PFX без пароля — ошибка с именем переменной INSPECTOR_RIN_CLIENT_PFX_PASS", () => {
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_URL: "https://rin.example", INSPECTOR_RIN_CA: "/ca", INSPECTOR_RIN_CLIENT_PFX: "/c.p12" }, gpu)).toThrow(/INSPECTOR_RIN_CLIENT_PFX_PASS/);
  });

  it("direct: нижняя версия TLS по умолчанию TLSv1.2, TLSv1.1 и ниже не принимаются", () => {
    const r = resolveRinTls({ ...base, INSPECTOR_RIN_TLS: "direct" }, gpu);
    expect(r).toMatchObject({ mode: "direct", minVersion: "TLSv1.2", caPath: "/ca.crt", client: { kind: "pem" } });
    expect(resolveRinTls({ ...base, INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_TLS_MIN: "TLSv1.3" }, gpu)).toMatchObject({ minVersion: "TLSv1.3" });
    expect(() => resolveRinTls({ ...base, INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_TLS_MIN: "TLSv1.1" }, gpu)).toThrow(/INSPECTOR_RIN_TLS_MIN/);
  });

  it("direct на http-адрес — ошибка", () => {
    expect(() => resolveRinTls({ ...base, INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_URL: "http://rin.example" }, gpu)).toThrow(/https/);
  });

  it("gost-proxy с адресом не на loopback — ошибка", () => {
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "gost-proxy", INSPECTOR_RIN_URL: "http://10.0.0.5:8443" }, gpu)).toThrow(/не loopback/);
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "gost-proxy", INSPECTOR_RIN_URL: "http://127.0.0.1.evil.example" }, gpu)).toThrow(/не loopback/);
  });

  it("gost-proxy с 127.0.0.1, ::1 или localhost принимается", () => {
    for (const u of ["http://127.0.0.1:1443", "http://[::1]:1443", "http://localhost:1443"]) {
      expect(resolveRinTls({ INSPECTOR_RIN_TLS: "gost-proxy", INSPECTOR_RIN_URL: u }, gpu)).toEqual({ mode: "gost-proxy", url: u });
    }
  });

  it("по умолчанию — адрес встроенной заглушки, пробелы вокруг значений окружения не мешают", () => {
    expect(resolveRinTls({}, { profile: "dev", mock: true })).toEqual({ mode: "off", url: "http://127.0.0.1:8810/mock-rin" });
    expect(resolveRinTls({ INSPECTOR_RIN_TLS: " gost-proxy ", INSPECTOR_RIN_URL: " http://127.0.0.1:1443 " }, gpu)).toEqual({ mode: "gost-proxy", url: "http://127.0.0.1:1443" });
  });

  it("direct с PFX и паролем — клиент в контейнере PKCS#12", () => {
    expect(resolveRinTls({ INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_URL: "https://rin.example", INSPECTOR_RIN_CA: "/ca", INSPECTOR_RIN_CLIENT_PFX: "/c.p12", INSPECTOR_RIN_CLIENT_PFX_PASS: "p" }, gpu)).toEqual({
      mode: "direct",
      url: "https://rin.example",
      caPath: "/ca",
      minVersion: "TLSv1.2",
      client: { kind: "pfx", pfxPath: "/c.p12", passphrase: "p" },
    });
  });

  it("direct: PFX вместе с сертификатом или ключом PEM — ошибка «не оба»", () => {
    const pfx = { INSPECTOR_RIN_TLS: "direct", INSPECTOR_RIN_URL: "https://rin.example", INSPECTOR_RIN_CA: "/ca", INSPECTOR_RIN_CLIENT_PFX: "/c.p12", INSPECTOR_RIN_CLIENT_PFX_PASS: "p" };
    const msg = "INSPECTOR_RIN_TLS=direct: задайте либо INSPECTOR_RIN_CLIENT_PFX, либо INSPECTOR_RIN_CLIENT_CERT + INSPECTOR_RIN_CLIENT_KEY, не оба";
    expect(() => resolveRinTls({ ...pfx, INSPECTOR_RIN_CLIENT_CERT: "/c.crt" }, gpu)).toThrow(msg);
    expect(() => resolveRinTls({ ...pfx, INSPECTOR_RIN_CLIENT_KEY: "/c.key" }, gpu)).toThrow(msg);
  });

  it("gost-proxy: https:// или нераспознаваемый адрес шлюза — ошибка", () => {
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "gost-proxy", INSPECTOR_RIN_URL: "https://127.0.0.1:1443" }, gpu)).toThrow(
      "INSPECTOR_RIN_TLS=gost-proxy: INSPECTOR_RIN_URL обязан быть http:// на локальный ГОСТ-TLS-шлюз СКЗИ, получено https:",
    );
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "gost-proxy", INSPECTOR_RIN_URL: "не адрес" }, gpu)).toThrow("INSPECTOR_RIN_URL=не адрес: не URL");
  });

  it("неизвестный режим — ошибка", () => {
    expect(() => resolveRinTls({ INSPECTOR_RIN_TLS: "plain" }, gpu)).toThrow(/direct, gost-proxy или off/);
  });
});
