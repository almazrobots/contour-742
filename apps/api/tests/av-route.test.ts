// NFR-AV на маршруте загрузки: включённый антивирус (INSPECTOR_AV=clamd), поддельный clamd в процессе теста.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const TMP = mkdtempSync(join(tmpdir(), "inspector-av-"));
const MARK = "harmless-infection-marker";
let clamd: Server;
let alive = true;
let app: any;
let db: any;
let token = "";

function multipart(fields: Record<string, string>, files: Array<{ field: string; name: string; buf: Buffer }>) {
  const boundary = "----av" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  clamd = createServer((sock) => {
    if (!alive) return sock.destroy();
    let acc = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      acc = Buffer.concat([acc, d]);
      if (acc.length >= 4 && acc.subarray(acc.length - 4).readUInt32BE(0) === 0) sock.end(acc.includes(MARK) ? "stream: Test.Marker FOUND\0" : "stream: OK\0");
    });
  });
  await new Promise<void>((r) => clamd.listen(0, "127.0.0.1", () => r()));
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_AV: "clamd", INSPECTOR_CLAMD_HOST: "127.0.0.1", INSPECTOR_CLAMD_PORT: String((clamd.address() as any).port),
    INSPECTOR_ML_URL: "http://127.0.0.1:9", // ML не нужен: start=false
  });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
});
afterAll(async () => {
  clamd.close();
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const pdf = readFileSync(join(ROOT, "data/synth/OBJ-SEV-2/SEV-PD-PZ-1.pdf"));
const card = JSON.stringify({ object_id: "AV-1", name: "Проверка антивируса" });
const upload = (files: Array<{ name: string; buf: Buffer }>) => {
  const m = multipart({ object: card, start: "false" }, files.map((f) => ({ field: "files", ...f })));
  return app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${token}` } });
};

describe("антивирус на загрузке (NFR-AV, ТЗ 12.11)", () => {
  it("чистый файл принят, заражённый — INFECTED и не попал в хранилище; событие в аудите", async () => {
    const infected = Buffer.concat([pdf.subarray(0, pdf.length - 8), Buffer.from(MARK), pdf.subarray(pdf.length - 8)]);
    const r = await upload([{ name: "clean.pdf", buf: pdf }, { name: "bad.pdf", buf: infected }]);
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(body.accepted.map((a: any) => a.file_name)).toEqual(["clean.pdf"]);
    expect(body.rejected).toEqual([expect.objectContaining({ file_name: "bad.pdf", code: "INFECTED" })]);
    expect((await db.get("select count(*) n from files where file_name = 'bad.pdf'")).n).toBe(0);
    expect((await db.get("select count(*) n from audit_log where action = 'FILE_INFECTED'")).n).toBe(1);
  });
  it("сканер недоступен — файл не принят (SCAN_UNAVAILABLE), ответ 400", async () => {
    alive = false;
    const r = await upload([{ name: "late.pdf", buf: pdf }]);
    alive = true;
    expect(r.statusCode).toBe(400);
    expect(r.json().rejected).toEqual([expect.objectContaining({ file_name: "late.pdf", code: "SCAN_UNAVAILABLE" })]);
  });
});

describe("конфиг антивируса (громкая проверка при старте)", async () => {
  const { spawnSync } = await import("node:child_process");
  const load = (env: Record<string, string>) =>
    // INSPECTOR_AMQP_URL и INSPECTOR_TLS_*: профиль gpu требует RabbitMQ (ТЗ 1.5) и HTTPS (ТЗ 12.3) — здесь проверяется только антивирус
    spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_BLOB_KEY_FILE: "tests/fixtures/at-rest/blob.key", INSPECTOR_BLOB_WORK_DIR: "/dev/shm/inspector-blob-work", INSPECTOR_AMQP_URL: "amqps://rabbit", INSPECTOR_ML_URL: "https://ml:8811", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "tests/fixtures/tls-api/cert.pem", INSPECTOR_TLS_KEY: "tests/fixtures/tls-api/key.pem", ...env }, encoding: "utf8" });
  it("профиль gpu без антивируса не стартует; dev по умолчанию — выключен явно; неизвестный режим — отказ", () => {
    const gpuOff = load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_AV: "off" });
    expect(gpuOff.status).not.toBe(0);
    expect(gpuOff.stderr).toContain("недопустим в профиле gpu");
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "" }).status).toBe(0);
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "maybe" }).stderr).toContain("ждём off или clamd");
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_AV: "clamd" }).status).toBe(0);
  });
});
