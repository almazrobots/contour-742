// Эшелоны: L1 (демо-стенд только для просмотра: чтение работает, гостевой вход), L4 (любое изменение — 403 до
// обработчика и базы), L3 (границы: хвостовой «/», строка запроса, регистр метода). T-131, NFR-DEMO-READONLY.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guestEnabled } from "../src/domain/readonly.ts";
import { GUEST_LIMIT, GuestThrottle, WINDOW_MS } from "../src/services/throttle.ts";
import { READONLY_MESSAGE, readonlyBlocked } from "../src/domain/readonly.ts";

describe("правило только чтения (домен)", () => {
  it("чтение открыто, изменения закрыты, кроме входа и выхода; вне демо-режима не блокирует ничего", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(readonlyBlocked(true, m, "/api/v1/inspections")).toBe(false);
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(readonlyBlocked(true, m, "/api/v1/inspections")).toBe(true);
    for (const u of ["/api/v1/auth/login", "/api/v1/auth/guest", "/api/v1/auth/logout", "/api/v1/auth/guest/", "/api/v1/auth/login?x=1"]) expect(readonlyBlocked(true, "POST", u)).toBe(false);
    expect(readonlyBlocked(true, "POST", "/api/v1/auth/loginx")).toBe(true);
    expect(readonlyBlocked(true, "POST", "/api/v1/documents/upload")).toBe(true);
    for (const m of ["POST", "DELETE"]) expect(readonlyBlocked(false, m, "/api/v1/inspections")).toBe(false);
  });
});

const TMP = mkdtempSync(join(tmpdir(), "inspector-readonly-"));
let app: any;
let db: any;

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_READONLY: "1", INSPECTOR_GUEST_LOGIN: "inspector" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
});
afterAll(async () => {
  delete process.env.INSPECTOR_READONLY;
  delete process.env.INSPECTOR_GUEST_LOGIN;
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("демо-стенд через API (INSPECTOR_READONLY=1)", () => {
  it("гостевой вход даёт сессию инспектора; с ней чтение работает", async () => {
    const g = await app.inject({ method: "POST", url: "/api/v1/auth/guest" });
    expect(g.statusCode).toBe(200);
    expect(g.json().user).toMatchObject({ login: "inspector", role: "inspector" });
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${g.json().token}` } });
    expect(me.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/inspections", headers: { authorization: `Bearer ${g.json().token}` } });
    expect(list.statusCode).toBe(200);
  });
  it("любое изменение — 403 с объяснением, даже у администратора и до проверки схемы", async () => {
    const tok = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "admin", password: "test-pass" } })).json().token;
    const h = { authorization: `Bearer ${tok}` };
    for (const [method, url, payload] of [
      ["POST", "/api/v1/inspections", { object_id: "X", name: "X" }],
      ["PATCH", "/api/v1/params/M-023", { is_active: false }],
      ["POST", "/api/v1/params/M-023/verifications", { garbage: true }],
      ["DELETE", "/api/v1/inspections/P-1", undefined],
      ["POST", "/api/v1/verification/assignments/next", {}],
      ["POST", "/api/v1/verification/library/L-1/mark", { starred: true }],
    ] as const) {
      const r = await app.inject({ method, url, headers: h, payload });
      expect([method, url, r.statusCode]).toEqual([method, url, 403]);
      expect(r.json()).toEqual({ error: READONLY_MESSAGE });
    }
    const n = await db.get("select count(*)::int as n from inspections");
    expect(n.n).toBe(0);
  });
  it("T-131: экран входа узнаёт, включён ли гостевой вход", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/auth/guest" });
    expect([r.statusCode, r.json()]).toEqual([200, { enabled: true }]);
  });
  it("T-131: гостевой вход ограничен по адресу — не больше 10 сессий за 15 минут, дальше 429 с Retry-After", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await app.inject({ method: "POST", url: "/api/v1/auth/guest" })).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/guest" });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("гостевой вход: правило и ограничитель (T-131)", () => {
  it("вход есть только в режиме только чтения и только с явно заданной учёткой гостя", () => {
    expect(guestEnabled(true, "inspector")).toBe(true);
    expect(guestEnabled(true, "")).toBe(false);
    expect(guestEnabled(false, "inspector")).toBe(false);
  });
  it("ограничитель: 10 входов с адреса за окно, новый адрес не страдает, окно истекает", () => {
    let t = 0;
    const g = new GuestThrottle(() => t);
    for (let i = 0; i < GUEST_LIMIT; i++) expect(g.take("1.1.1.1").ok).toBe(true);
    const no = g.take("1.1.1.1");
    expect(no.ok).toBe(false);
    expect(no.ok ? 0 : no.retryAfter).toBeGreaterThan(0);
    expect(g.take("2.2.2.2").ok).toBe(true);
    t += WINDOW_MS + 1;
    expect(g.take("1.1.1.1").ok).toBe(true);
  });
});
