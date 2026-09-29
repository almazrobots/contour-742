// T-131 (OWASP T-140 E1-H1): демо за двумя прокси (Caddy → nginx) видело всех клиентов с одного адреса — 20 неверных
// входов анонима закрывали вход всем на 15 минут. Адрес клиента — из X-Forwarded-For, но только от доверенных прокси.
// Эшелоны: L1 (разбор настройки), L6 (подделка заголовка без доверия, перебор с чужого адреса). База в памяти.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/domain/trust-proxy.ts";

describe("настройка доверенных прокси (T-131)", () => {
  it("пусто — доверия нет; список адресов и сетей — как есть", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("  ")).toBe(false);
    expect(parseTrustProxy("loopback, uniquelocal")).toBe("loopback, uniquelocal");
    expect(parseTrustProxy("127.0.0.1,172.16.0.0/12")).toBe("127.0.0.1, 172.16.0.0/12");
  });
  it("доверие всем запрещено: true, *, 0.0.0.0/0, ::/0 — ошибка конфигурации", () => {
    for (const bad of ["true", "*", "0.0.0.0/0", "::/0", "loopback, 0.0.0.0/0"]) expect(() => parseTrustProxy(bad)).toThrow(/INSPECTOR_TRUST_PROXY/);
  });
});

const TMP = mkdtempSync(join(tmpdir(), "inspector-proxy-"));
let app: any;
let db: any;

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_TRUST_PROXY: "loopback" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
});
afterAll(async () => {
  delete process.env.INSPECTOR_TRUST_PROXY;
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

// перебор разных логинов с одного адреса — срабатывает счётчик по адресу (20 неудач), а не по учётной записи
const login = (i: number, xff: string) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": xff }, payload: { login: `nobody-${i}`, password: "wrong" } });

describe("перебор с одного адреса за прокси не закрывает вход остальным (OWASP E1-H1)", () => {
  it("аноним исчерпал попытки — ему 429, другому клиенту за тем же прокси вход открыт", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await login(i, "203.0.113.7")).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    const other = await app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.9" }, payload: { login: "inspector", password: "test-pass" } });
    expect(other.statusCode).toBe(200);
  });
});
