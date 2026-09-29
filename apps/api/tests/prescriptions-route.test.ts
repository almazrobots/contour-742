// T-070: приём статусов предписаний от ИАИС «РиН» и показ по проверке (OS-INSP-5.4, ТЗ §9.6.4).
// L2 — контракт маршрута, L4 — интеграция с БД, L6 — отказы и безопасность. Без ML-сервиса. Имя теста — ссылка трассы.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-prescr-"));
const KEY = "rin-inbound-test-key";
let app: any;
let db: any;
let token = "";
let processId = "";
let mod: typeof import("../src/services/prescriptions.ts");

beforeAll(async () => {
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_RIN_INBOUND_KEY: KEY,
  });
  mod = await import("../src/services/prescriptions.ts");
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});
// История предписаний только дописывается (0002: prescription_events append-only) — каждый тест на свежей базе
beforeEach(async () => {
  process.env.INSPECTOR_RIN_INBOUND_KEY = KEY;
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  const { createInspection } = await import("../src/services/inspections.ts");
  await app?.close();
  await db?.close();
  db = await openDb("memory");
  app = await buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  const user = await db.get("select * from users where login = 'inspector'");
  processId = await createInspection({ db, user }, { object_id: "PR-OBJ-1", name: "Объект с предписаниями" });
});

const post = (body: unknown, key: string | null = KEY) =>
  app.inject({ method: "POST", url: "/api/v1/rin/prescriptions", payload: body as any, headers: key === null ? {} : { "x-rin-key": key } });
const list = (id = processId, auth = true) =>
  app.inject({ method: "GET", url: `/api/v1/inspection/${id}/prescriptions`, headers: auth ? { authorization: `Bearer ${token}` } : {} });
const msg = (over: Record<string, unknown> = {}) => ({ prescription_id: "PR-100", process_id: processId, status: "ISSUED", event_at: "2026-09-01T10:00:00Z", ...over });
const count = async (sql: string) => (await db.get(sql)).n as number;

describe("OS-INSP-5.4.1 приём статуса предписания", () => {
  it("маршрут отклоняет недопустимый статус кодом 400 с перечнем допустимых и ничего не записывает", async () => {
    const r = await post(msg({ status: "DONE" }));
    expect(r.statusCode).toBe(400);
    expect(r.json().details).toContainEqual(expect.objectContaining({ path: "/status", keyword: "enum", allowed: ["ISSUED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXTENDED"] })); // NFR-API-VALIDATE: единый формат нарушений схемы
    expect(r.json().error).toContain("ISSUED, IN_PROGRESS, COMPLETED, CANCELLED, EXTENDED");
    expect((await post(msg({ event_at: "вчера" }))).statusCode).toBe(400);
    expect((await post([1, 2])).statusCode).toBe(400);
    expect(await count("select count(*) n from prescriptions")).toBe(0);
    expect(await count("select count(*) n from prescription_events")).toBe(0);
  });

  it("допустимый статус по известной проверке принимается кодом 201 и пишется в журнал аудита", async () => {
    const before = await count("select count(*) n from audit_log where action = 'PRESCRIPTION_STATUS'");
    const r = await post(msg());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ created: true, prescription: { prescription_id: "PR-100", status: "ISSUED", event_at: "2026-09-01T10:00:00.000Z" } });
    const a = await db.get("select * from audit_log where action = 'PRESCRIPTION_STATUS' order by id desc limit 1");
    expect(await count("select count(*) n from audit_log where action = 'PRESCRIPTION_STATUS'")).toBe(before + 1);
    expect(a.object_id).toBe(processId);
    expect(JSON.parse(a.details)).toMatchObject({ prescription_id: "PR-100", status: "ISSUED", event_at: "2026-09-01T10:00:00.000Z", current_status: "ISSUED" });
  });
});

describe("OS-INSP-5.4.2 неизвестная проверка", () => {
  it("сообщение по несуществующему process_id отклоняется кодом 404 и предписание не заводится", async () => {
    const r = await post(msg({ process_id: "P-НЕТ-ТАКОЙ" }));
    expect(r.statusCode).toBe(404);
    expect(await count("select count(*) n from prescriptions")).toBe(0);
    await expect(mod.ingestPrescriptionStatus(db, msg({ process_id: "P-НЕТ-ТАКОЙ" }))).rejects.toThrow(mod.PrescriptionError);
    try {
      await mod.ingestPrescriptionStatus(db, msg({ process_id: "P-НЕТ-ТАКОЙ" }));
      expect.unreachable();
    } catch (e) {
      expect((e as InstanceType<typeof mod.PrescriptionError>).code).toBe("UNKNOWN_INSPECTION");
      expect((e as InstanceType<typeof mod.PrescriptionError>).status).toBe(404);
    }
  });
});

describe("OS-INSP-5.4.3 текущий статус по дате события и история", () => {
  it("опоздавшее старое событие попадает в историю, но не перетирает текущий статус", async () => {
    expect((await post(msg({ status: "ISSUED", event_at: "2026-09-01T10:00:00Z" }))).statusCode).toBe(201);
    expect((await post(msg({ status: "COMPLETED", event_at: "2026-09-20T10:00:00Z" }))).json().prescription.status).toBe("COMPLETED");
    const late = await post(msg({ status: "IN_PROGRESS", event_at: "2026-09-05T10:00:00Z" }));
    expect(late.statusCode).toBe(201);
    expect(late.json().prescription.status).toBe("COMPLETED");
    const [p] = (await list()).json();
    expect(p.status).toBe("COMPLETED");
    expect(p.event_at).toBe("2026-09-20T10:00:00.000Z");
    expect(p.history.map((h: any) => h.status)).toEqual(["ISSUED", "IN_PROGRESS", "COMPLETED"]);
  });
});

describe("OS-INSP-5.4.4 повтор сообщения", () => {
  it("повтор того же предписания, статуса и даты события отвечает 200 и не дублирует историю", async () => {
    expect((await post(msg())).statusCode).toBe(201);
    const audits = await count("select count(*) n from audit_log where action = 'PRESCRIPTION_STATUS'");
    const again = await post(msg({ event_at: "2026-09-01T13:00:00+03:00" })); // тот же момент в другом поясе
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, prescription: { status: "ISSUED" } });
    expect(await count("select count(*) n from prescription_events")).toBe(1);
    expect(await count("select count(*) n from audit_log where action = 'PRESCRIPTION_STATUS'")).toBe(audits);
    expect((await mod.ingestPrescriptionStatus(db, msg())).created).toBe(false);
    expect(await count("select count(*) n from prescription_events")).toBe(1);
  });
});

describe("OS-INSP-5.4.5 показ предписаний по проверке", () => {
  it("по проверке отдаются текущий статус каждого предписания и его история; пусто — пустой список", async () => {
    expect((await list()).json()).toEqual([]);
    await post(msg({ prescription_id: "PR-2", status: "ISSUED", event_at: "2026-08-01" }));
    await post(msg({ prescription_id: "PR-2", status: "EXTENDED", event_at: "2026-08-15" }));
    await post(msg({ prescription_id: "PR-1", status: "CANCELLED", event_at: "2026-08-10" }));
    const r = await list();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      { prescription_id: "PR-1", status: "CANCELLED", event_at: "2026-08-10T00:00:00.000Z", updated_at: expect.any(String),
        history: [{ status: "CANCELLED", event_at: "2026-08-10T00:00:00.000Z", received_at: expect.any(String) }] },
      { prescription_id: "PR-2", status: "EXTENDED", event_at: "2026-08-15T00:00:00.000Z", updated_at: expect.any(String),
        history: [
          { status: "ISSUED", event_at: "2026-08-01T00:00:00.000Z", received_at: expect.any(String) },
          { status: "EXTENDED", event_at: "2026-08-15T00:00:00.000Z", received_at: expect.any(String) },
        ] },
    ]);
  });

  it("список предписаний требует входа, по неизвестной проверке — 404", async () => {
    expect((await list(processId, false)).statusCode).toBe(401);
    expect((await list("P-НЕТ-ТАКОЙ")).statusCode).toBe(404);
  });
});

describe("OS-INSP-5.4.6 ключ интеграции «РиН»", () => {
  it("сообщение без ключа или с неверным ключом отклоняется кодом 401 и ничего не записывает", async () => {
    expect((await post(msg(), null)).statusCode).toBe(401);
    expect((await post(msg(), "wrong-key")).statusCode).toBe(401);
    expect((await post(msg(), "")).statusCode).toBe(401);
    expect(await count("select count(*) n from prescription_events")).toBe(0);
  });

  it("если ключ интеграции не настроен, маршрут отвечает 503 и не пропускает сообщение", async () => {
    delete process.env.INSPECTOR_RIN_INBOUND_KEY;
    const r = await post(msg());
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain("не настроена");
    process.env.INSPECTOR_RIN_INBOUND_KEY = "";
    expect((await post(msg(), "")).statusCode).toBe(503);
    expect(await count("select count(*) n from prescription_events")).toBe(0);
  });
});

describe("OS-INSP-5.4.7 протокол и решения не меняются", () => {
  it("статус предписания не меняет протокол, решения инспектора, кандидатов и статус проверки", async () => {
    const now = new Date().toISOString();
    await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1,$2,$3,$4,$5)", [processId, 1, "FINALIZED", '{"v":1}', now]);
    await db.run("insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      ["F-PR-1", processId, "M-041", "g", "CANDIDATE", "CONFIRMED_VIOLATION", 1, now, now]);
    await db.run("insert into decisions (check_id, user_id, action, status, created_at) values ($1,$2,$3,$4,$5)", ["F-PR-1", "u-insp", "confirm", "CONFIRMED_VIOLATION", now]);
    const snap = async () => JSON.stringify({
      protocols: await db.all("select * from protocols where inspection_id = $1 order by id", [processId]),
      checks: await db.all("select * from checks where inspection_id = $1 order by id", [processId]),
      decisions: await db.all("select * from decisions where check_id = 'F-PR-1' order by id"),
      inspection: await db.get("select status, protocol_version, sync_status, updated_at from inspections where id = $1", [processId]),
    });
    const before = await snap();
    for (const status of ["ISSUED", "IN_PROGRESS", "EXTENDED", "COMPLETED", "CANCELLED"]) {
      expect((await post(msg({ status, event_at: `2026-09-0${["ISSUED", "IN_PROGRESS", "EXTENDED", "COMPLETED", "CANCELLED"].indexOf(status) + 1}` }))).statusCode).toBe(201);
    }
    expect(await snap()).toBe(before);
  });
});

describe("OS-INSP-5.4.3/5.4.4 конкурентный приём (два процесса API, повтор «РиН» вдогонку)", () => {
  it("одно и то же сообщение параллельно — одна запись истории, одно событие аудита, created ровно у одного", async () => {
    const audits = await count("select count(*) n from audit_log where action = 'PRESCRIPTION_STATUS'");
    const rs = await Promise.all(Array.from({ length: 5 }, () => mod.ingestPrescriptionStatus(db, msg())));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(await count("select count(*) n from prescriptions")).toBe(1);
    expect(await count("select count(*) n from prescription_events")).toBe(1);
    expect(await count("select count(*) n from audit_log where action = 'PRESCRIPTION_STATUS'")).toBe(audits + 1);
  });

  it("разные статусы одного предписания параллельно — вся история принята, текущий — по самой поздней дате события", async () => {
    const events = [
      { status: "ISSUED", event_at: "2026-09-01T10:00:00Z" }, { status: "COMPLETED", event_at: "2026-09-20T10:00:00Z" },
      { status: "IN_PROGRESS", event_at: "2026-09-05T10:00:00Z" }, { status: "EXTENDED", event_at: "2026-09-10T10:00:00Z" },
    ];
    await Promise.all(events.map((e) => mod.ingestPrescriptionStatus(db, msg(e))));
    const [p] = await mod.listPrescriptions(db, processId);
    expect(p.status).toBe("COMPLETED");
    expect(p.history.map((h) => h.status)).toEqual(["ISSUED", "IN_PROGRESS", "EXTENDED", "COMPLETED"]);
  });
});
