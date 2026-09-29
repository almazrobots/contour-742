// NFR-TLS (ТЗ 1.3, 12.3): API в эксплуатационном контуре — только HTTPS, TLS 1.3. Настоящее испытание по сети:
// buildApp с опциями services/tls.ts слушает порт на самоподписанном сертификате (синтетическая фикстура fixtures/tls).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FIX = join(import.meta.dirname, "fixtures/tls-api");
const CERT = join(FIX, "cert.pem");
const KEY = join(FIX, "key.pem");
const ca = readFileSync(CERT);
const TMP = mkdtempSync(join(tmpdir(), "inspector-tls-"));
let app: any;
let port = 0;

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  const { loadHttpsOptions } = await import("../src/services/tls.ts");
  app = buildApp(await openDb("memory"), { https: loadHttpsOptions({ cert: CERT, key: KEY }) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = app.server.address().port;
});
afterAll(async () => {
  await app?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("NFR-TLS: API только по HTTPS, TLS 1.3", () => {
  it("опции https зажимают версию TLS 1.3 с обеих сторон; без настроек TLS — null (HTTP только в dev)", async () => {
    const { httpsOptions, loadHttpsOptions } = await import("../src/services/tls.ts");
    const o = httpsOptions("c", "k");
    expect([o.minVersion, o.maxVersion, o.cert, o.key]).toEqual(["TLSv1.3", "TLSv1.3", "c", "k"]);
    expect(loadHttpsOptions(null)).toBeNull();
    expect(() => loadHttpsOptions({ cert: join(FIX, "нет.pem"), key: KEY })).toThrow(/ENOENT/);
  });

  it("рукопожатие TLS 1.3 проходит, и GET /api/v1/dictionaries отвечает 200", async () => {
    const got = await new Promise<{ status: number; protocol: string | null; body: string }>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/v1/dictionaries", ca, servername: "localhost" }, (res) => {
        const protocol = (res.socket as any).getProtocol();
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => ok({ status: res.statusCode ?? 0, protocol, body }));
      });
      req.on("error", fail);
      req.end();
    });
    expect(got.protocol).toBe("TLSv1.3");
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body).limits.file_mb).toBe(50);
  });

  it("клиент с TLS не выше 1.2 получает отказ на рукопожатии", async () => {
    const err = await new Promise<any>((ok) => {
      const s = tlsConnect({ host: "127.0.0.1", port, ca, servername: "localhost", maxVersion: "TLSv1.2" }, () => ok(new Error(`рукопожатие прошло: ${s.getProtocol()}`)));
      s.on("error", ok);
    });
    expect(String(err.code ?? err.message)).toMatch(/PROTOCOL_VERSION|UNSUPPORTED_PROTOCOL|ECONNRESET/);
  });

  it("plain HTTP на тот же порт не получает HTTP-ответа", async () => {
    const reply = await new Promise<string>((ok) => {
      const s = netConnect({ host: "127.0.0.1", port }, () => s.write("GET /api/v1/dictionaries HTTP/1.1\r\nHost: localhost\r\n\r\n"));
      let acc = "";
      s.setTimeout(3000, () => s.destroy());
      s.on("data", (d) => (acc += d.toString("latin1")));
      s.on("error", () => {});
      s.on("close", () => ok(acc));
    });
    expect(reply).not.toMatch(/HTTP\/1\.[01] \d{3}/);
    expect(reply).not.toContain("file_mb");
  });
});

describe("NFR-TLS: конфиг (громкая проверка при старте)", () => {
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_BLOB_KEY_FILE: "tests/fixtures/at-rest/blob.key", INSPECTOR_BLOB_WORK_DIR: "/dev/shm/inspector-blob-work", INSPECTOR_AV: "clamd", INSPECTOR_AMQP_URL: "amqps://rabbit:5671", INSPECTOR_ML_URL: "https://ml:8811", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "", INSPECTOR_TLS_KEY: "", ...env },
      encoding: "utf8",
    });
  it("gpu без сертификата и ключа не стартует; задан только один из двух — отказ; gpu с обоими и dev без них — старт", () => {
    const bare = load({ INSPECTOR_PROFILE: "gpu" });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("профиль gpu требует INSPECTOR_TLS_CERT и INSPECTOR_TLS_KEY");
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_TLS_CERT: CERT }).stderr).toContain("задаются только вместе");
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_TLS_KEY: KEY }).stderr).toContain("задаются только вместе");
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_TLS_CERT: CERT, INSPECTOR_TLS_KEY: KEY }).status).toBe(0);
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off" }).status).toBe(0);
  });
});
