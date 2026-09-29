// OS-INSP-4.1.23–4.1.25 (T-139, OWASP-аудит H1): причина — только из справочника, решение пишется вместе с журналами
// и аудитом, групповое снятие — целиком или никак. Через API на PGlite (L4 отказы, L6 враждебные данные).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-h1-"));
let app: any;
let db: any;
let token = "";
const now = () => new Date().toISOString();
const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

/** Проверка с кандидатами на одном документе и одной редакции — соседи по общему корню. */
async function seed(insp: string, ids: string[]) {
  await db.run("insert into objects (id, name, profile_json, created_at) values ($1,$1,'{}',$2)", [`O-${insp}`, now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,'VERIFYING',1,$3,$3)", [insp, `O-${insp}`, now()]);
  for (const id of ids) {
    await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, computed_in_version, created_at, updated_at)
                  values ($1,$2,$3,$1,'CANDIDATE','PENDING','MEDIUM',1,$4,$4)`, [id, insp, `M-${id}`, now()]);
    await db.run("insert into evidence_fragments (check_id, file_id, stage, document_code, revision, sheet_page, role_expected_actual) values ($1,'F-1','RD','Р-ОВ','2',5,'actual')", [id]);
  }
}

/** Что осталось в базе по кандидату: действующие решения, журналы, аудит и статус. */
async function trace(id: string) {
  const n = async (sql: string) => (await db.get(sql, [id])).n;
  return {
    status: (await db.get("select verification_status v from checks where id = $1", [id])).v,
    decisions: await n("select count(*)::int n from decisions where check_id = $1"),
    rejections: await n("select count(*)::int n from rejection_log where check_id = $1"),
    disputes: await n("select count(*)::int n from dispute_log where check_id = $1"),
    audit: await n("select count(*)::int n from audit_log where object_id = $1 and action like 'DECISION_%'"),
  };
}
const UNTOUCHED = { status: "PENDING", decisions: 0, rejections: 0, disputes: 0, audit: 0 };

/** Сбой записи аудита по выбранному кандидату — внедрение отказа триггером в самой базе. */
async function breakAuditFor(id: string) {
  await db.exec(`create or replace function t139_fail() returns trigger language plpgsql as $$
    begin if new.object_id = '${id}' then raise exception 'audit_log недоступен (внедрённый отказ)'; end if; return new; end $$;
    create trigger t139_fail before insert on audit_log for each row execute function t139_fail();`);
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
});
afterEach(async () => {
  await db.exec("drop trigger if exists t139_fail on audit_log; drop function if exists t139_fail();");
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("OS-INSP-4.1.23 причина отклонения — только из справочника", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "служебное имя %s — 400, ничего не записано",
    async (code) => {
      const id = `H1-${code}`;
      await seed(`I-${code}`, [id]);
      const r = await call("POST", `/api/v1/checks/${id}/decision`, { action: "reject", reason_code: code, comment: "почему" });
      expect(r.statusCode).toBe(400);
      expect(await trace(id)).toEqual(UNTOUCHED);
    },
  );
  it("групповое снятие со служебным именем причины — 400, ни одного решения", async () => {
    await seed("I-G0", ["G0-1", "G0-2"]);
    const r = await call("POST", "/api/v1/checks/G0-1/reject-group", { reason_code: "constructor", ids: ["G0-2"] });
    expect(r.statusCode).toBe(400);
    expect(await trace("G0-2")).toEqual(UNTOUCHED);
  });
  it("код из справочника принимается и попадает в журнал с предложенной правкой", async () => {
    await seed("I-OK", ["OK-1"]);
    const r = await call("POST", "/api/v1/checks/OK-1/decision", { action: "reject", reason_code: "OCR_ERROR", comment: "скан" });
    expect(r.statusCode).toBe(200);
    expect(await trace("OK-1")).toEqual({ status: "NEGATIVE_VERIFIED", decisions: 1, rejections: 1, disputes: 0, audit: 1 });
    expect((await db.get("select suggested_fix from rejection_log where check_id = 'OK-1'")).suggested_fix).toMatch(/OCR/);
  });
});

describe("OS-INSP-4.1.24 решение, журналы и аудит — вместе", () => {
  it("сбой записи аудита откатывает отклонение: ни решения, ни журнала отклонений, статус прежний", async () => {
    await seed("I-F1", ["F1-1"]);
    await breakAuditFor("F1-1");
    const r = await call("POST", "/api/v1/checks/F1-1/decision", { action: "reject", reason_code: "WRONG_REVISION", comment: "редакция" });
    expect(r.statusCode).toBe(500);
    expect(await trace("F1-1")).toEqual(UNTOUCHED);
  });
  it("сбой записи аудита откатывает запрос уточнения вместе со спорным случаем", async () => {
    await seed("I-F2", ["F2-1"]);
    await breakAuditFor("F2-1");
    expect((await call("POST", "/api/v1/checks/F2-1/decision", { action: "clarify", comment: "?" })).statusCode).toBe(500);
    expect(await trace("F2-1")).toEqual(UNTOUCHED);
  });
  it("после устранения сбоя то же решение записывается целиком", async () => {
    await seed("I-F3", ["F3-1"]);
    await breakAuditFor("F3-1");
    await call("POST", "/api/v1/checks/F3-1/decision", { action: "confirm" });
    await db.exec("drop trigger t139_fail on audit_log");
    expect((await call("POST", "/api/v1/checks/F3-1/decision", { action: "confirm" })).statusCode).toBe(200);
    expect(await trace("F3-1")).toEqual({ status: "CONFIRMED_VIOLATION", decisions: 1, rejections: 0, disputes: 0, audit: 1 });
  });
});

describe("OS-INSP-4.1.25 групповое снятие — целиком или никак", () => {
  it("сбой на третьем кандидате группы: ни исходный, ни соседи не сняты; ответ называет кандидата", async () => {
    await seed("I-G1", ["G1-1", "G1-2", "G1-3", "G1-4"]);
    await breakAuditFor("G1-4");
    const r = await call("POST", "/api/v1/checks/G1-1/reject-group", { reason_code: "WRONG_REVISION", ids: ["G1-2", "G1-3", "G1-4"], actions: 1 });
    expect(r.statusCode).toBe(500);
    for (const id of ["G1-2", "G1-3", "G1-4"]) expect(await trace(id)).toEqual(UNTOUCHED);
  });
  it("кандидат, которого снять нельзя (разделён), отклоняет всю группу с его номером; остальные не тронуты", async () => {
    await seed("I-G2", ["G2-1", "G2-2", "G2-3"]);
    await db.run("update checks set verification_status = 'SPLIT' where id = 'G2-3'");
    const r = await call("POST", "/api/v1/checks/G2-1/reject-group", { reason_code: "WRONG_REVISION", ids: ["G2-2", "G2-3"] });
    expect([400, 409]).toContain(r.statusCode);
    expect(r.json().error).toContain("G2-3");
    expect(await trace("G2-2")).toEqual(UNTOUCHED);
  });
  it("без сбоев группа снимается вся: у каждого своё решение с отсылкой к исходному", async () => {
    await seed("I-G3", ["G3-1", "G3-2", "G3-3"]);
    const r = await call("POST", "/api/v1/checks/G3-1/reject-group", { reason_code: "WRONG_REVISION", ids: ["G3-2", "G3-3"] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ rejected: ["G3-2", "G3-3"] });
    for (const id of ["G3-2", "G3-3"]) expect(await trace(id)).toMatchObject({ status: "NEGATIVE_VERIFIED", decisions: 1, rejections: 1, audit: 1 });
  });
});

describe("OS-INSP-4.1.23 причины, записанные до исправления", () => {
  it("отчёт по дообучению не падает на служебном имени причины в старых решениях — рекомендации нет", async () => {
    await seed("I-OLD", ["OLD-1"]);
    await db.run("insert into decisions (check_id, user_id, action, status, reason_code, comment, created_at) values ('OLD-1','u-insp','reject','NEGATIVE_VERIFIED','constructor','старое',$1)", [now()]);
    // T-234: отчёт считает отклонения по журналу отклонений (Rejection_Log) — старая запись с той же причиной
    await db.run("insert into rejection_log (check_id, inspection_id, param_code, ai_verdict, reason_code, comment, suggested_fix, user_id, created_at) values ('OLD-1','I-OLD','M-001','CANDIDATE','constructor','старое','','u-insp',$1)", [now()]);
    const { buildRetrainingReport } = await import("../src/services/report.ts");
    const r = await buildRetrainingReport(db, "2000-01-01T00:00:00Z");
    expect(r.by_reason.find((x: any) => x.reason_code === "constructor")).toMatchObject({ recommendation: "" });
    expect(JSON.parse(JSON.stringify(r)).by_reason.every((x: any) => typeof x.recommendation === "string")).toBe(true);
  });
});
