// OS-INSP-4.1.26–4.1.28 (T-139, ТЗ 12.2, OWASP-аудит M1, M2): права по каждому маршруту и каждой роли через API на PGlite.
// Маршрут без названного права (auth без аргумента) — любой вошедший; список таких маршрутов закреплён, новый маршрут
// без права роняет тест, а не открывается всем молча.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowed, type Capability } from "../src/domain/access.ts";

const TMP = mkdtempSync(join(tmpdir(), "inspector-access-"));
const LOGINS = { inspector: "inspector", supervisor: "supervisor", admin: "admin", ml_engineer: "ml", curator: "curator" } as const;
type R = keyof typeof LOGINS;
const ROLES = Object.keys(LOGINS) as R[];
let app: any;
let db: any;
const tokens = {} as Record<R, string>;
const now = () => new Date().toISOString();
const as = (role: R, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokens[role]}` }, ...(payload !== undefined ? { payload } : {}) });

// Открыто любому вошедшему: справочные данные и собственная сессия
const ANY_USER = [
  "GET /api/v1/auth/me", "POST /api/v1/auth/logout", "GET /api/v1/notifications", "GET /api/v1/params", "GET /api/v1/params/:code/passport",
  "GET /api/v1/normative", "GET /api/v1/legal-acts", "GET /api/v1/normative/search", "GET /api/v1/rules",
];

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  await app.ready();
  for (const r of ROLES) tokens[r] = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: LOGINS[r], password: "test-pass" } })).json().token;
  await db.run("insert into objects (id, name, profile_json, created_at) values ('O-A','A','{}',$1)", [now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('A','O-A','VERIFYING',1,$1,$1)", [now()]);
  await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, computed_in_version, created_at, updated_at)
                values ('A-1','A','M-001','g','CANDIDATE','PENDING','MEDIUM',1,$1,$1)`, [now()]);
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("матрица прав по всем маршрутам", () => {
  it("у каждого маршрута с входом право названо, открытые всем — только справочные", () => {
    const caps: Map<string, Capability | null> = app.routeCaps;
    expect(caps.size).toBeGreaterThan(50);
    const open = [...caps].filter(([, c]) => c === null).map(([k]) => k).sort();
    expect(open).toEqual([...ANY_USER].sort());
  });
  it("каждая роль на каждом маршруте: 403 ровно там, где права нет", async () => {
    const wrong: string[] = [];
    for (const [key, cap] of app.routeCaps as Map<string, Capability | null>) {
      if (key === "POST /api/v1/auth/logout") continue; // закрыл бы сессию роли на середине обхода
      const [method, route] = key.split(" ");
      const url = route.replace(":id", "NOPE").replace(":code", "M-001").replace(":v", "NOPE");
      for (const r of ROLES) {
        const code = (await as(r, method, url, method === "GET" ? undefined : {})).statusCode;
        const must = cap === null || allowed(r, cap);
        if (must ? code === 403 || code === 401 : code !== 403) wrong.push(`${r} ${key} → ${code}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("M2: администратор не выносит решения инспектора", () => {
  it.each([
    ["POST", "/api/v1/checks/A-1/decision", { action: "confirm" }],
    ["POST", "/api/v1/checks/A-1/split", { parts: [] }],
    ["POST", "/api/v1/inspection/A/finalize", {}],
    ["POST", "/api/v1/checks/A-1/reopen", {}],
  ])("%s %s — 403, кандидат не тронут", async (method, url, payload) => {
    expect((await as("admin", method, url, payload)).statusCode).toBe(403);
    expect((await db.get("select verification_status v from checks where id = 'A-1'")).v).toBe("PENDING");
    expect(await db.get("select 1 from decisions where check_id = 'A-1'")).toBeFalsy();
  });
  it("администратор отменяет финализацию и правит Матрицу — права названы для его роли", async () => {
    expect((await as("admin", "POST", "/api/v1/inspection/A/unfinalize", { reason: "проверка прав" })).statusCode).not.toBe(403);
    expect((await as("admin", "PATCH", "/api/v1/params/M-001", {})).statusCode).not.toBe(403);
  });
});

describe("M1: ML-инженеру и куратору закрыты проверки, журналы — сводно", () => {
  it.each(["ml_engineer", "curator"] as const)("%s: список, карточка, протокол, файл и фрагменты — 403", async (r) => {
    for (const url of ["/api/v1/inspections", "/api/v1/inspections/A", "/api/v1/inspection/A/protocol", "/api/v1/inspection/A/protocol/export?format=pdf",
      "/api/v1/files/F-1/content", "/api/v1/checks/A-1/fragments", "/api/v1/inspection/A/status"]) {
      expect([url, (await as(r, "GET", url)).statusCode]).toEqual([url, 403]);
    }
  });
  it("сводные журналы: ML-роли видят отклонения всех проверок без учётки инспектора; инспектору — 403", async () => {
    await as("inspector", "POST", "/api/v1/checks/A-1/decision", { action: "reject", reason_code: "OCR_ERROR", comment: "скан" });
    for (const r of ["ml_engineer", "curator", "supervisor", "admin"] as const) {
      const res = await as(r, "GET", "/api/v1/ml/feedback-logs");
      expect(res.statusCode).toBe(200);
      const row = res.json().rejections.find((x: any) => x.check_id === "A-1");
      expect(row).toMatchObject({ inspection_id: "A", param_code: "M-001", reason_code: "OCR_ERROR", comment: "скан" });
      expect(row).not.toHaveProperty("user_id");
    }
    expect((await as("inspector", "GET", "/api/v1/ml/feedback-logs")).statusCode).toBe(403);
  });
});

describe("OS-INSP-4.1.28: IP и User-Agent в аудите карточки", () => {
  it("супервизор и администратор видят сетевые следы, инспектор — запись без них", async () => {
    await db.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ('u-insp','CHECK_OPENED','A-1','{}',$1,'10.9.8.7','UA/1')", [now()]);
    const pick = async (r: R) => (await as(r, "GET", "/api/v1/inspections/A")).json().audit.find((a: any) => a.action === "CHECK_OPENED");
    for (const r of ["supervisor", "admin"] as const) expect(await pick(r)).toMatchObject({ ip_address: "10.9.8.7", user_agent: "UA/1" });
    const own = await pick("inspector");
    expect(own).toMatchObject({ action: "CHECK_OPENED" });
    expect(own).not.toHaveProperty("ip_address");
    expect(own).not.toHaveProperty("user_agent");
  });
});

describe("проверка прав раньше схемы OpenAPI (OWASP T-140 E1-L1)", () => {
  it("аноним с неверным телом получает 401 без подробностей схемы, роль без права — 403, а не 400", async () => {
    const anon = await app.inject({ method: "POST", url: "/api/v1/checks/A-1/decision", payload: { action: "nope", junk: 1 } });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error).not.toMatch(/OpenAPI|schema|схем/i);
    expect((await as("ml_engineer", "POST", "/api/v1/checks/A-1/decision", { action: "nope" })).statusCode).toBe(403);
  });
});

// R2-аудит T-139 (OWASP/audits/2026-09-27-r2-T139): закрытые находки
// Без входа, по назначению: вход и гостевой вход, схема API и справочники, приём статусов «РиН» по ключу интеграции
const PUBLIC = [
  "POST /api/v1/auth/login", "GET /api/v1/auth/guest", "POST /api/v1/auth/guest", "GET /api/v1/openapi.json",
  "GET /api/v1/dictionaries", "POST /api/v1/rin/prescriptions",
];

describe("R2-аудит T-139", () => {
  it("R2-2: каждый маршрут /api/ — либо публичный по списку, либо с проверкой входа; маршрут без auth роняет тест", () => {
    const all: Set<string> = app.allApiRoutes;
    const guarded = new Set((app.routeCaps as Map<string, unknown>).keys());
    const unguarded = [...all].filter((k) => !guarded.has(k)).sort();
    expect(unguarded).toEqual([...PUBLIC].sort());
  });
  it("R2-1: журналы по проверке не отдают учётку инспектора (user_id) ни одной роли", async () => {
    await as("inspector", "POST", "/api/v1/checks/A-1/decision", { action: "clarify", comment: "?" });
    for (const r of ["ml_engineer", "curator", "supervisor", "admin"] as const) {
      const res = (await as(r, "GET", "/api/v1/inspection/A/feedback-logs")).json();
      for (const row of [...res.rejections, ...res.disputes]) expect(row).not.toHaveProperty("user_id");
      expect(res.rejections.length + res.disputes.length).toBeGreaterThan(0);
    }
  });
  it("R2-4: приём статусов «РиН» без ключа и с кривым телом — отказ по ключу, без подробностей схемы", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/rin/prescriptions", payload: { junk: 1 } });
    expect([401, 403, 503]).toContain(r.statusCode); // 503 — приём не настроен (закрыто при отсутствии ключа)
    expect(r.json().error).not.toMatch(/OpenAPI|schema|схем/i);
  });
});
