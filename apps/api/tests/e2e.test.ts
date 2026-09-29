// Сквозной тест: настоящий ML-сервис (Python) + API через inject. Проверяет синтетику против answer-key.json.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SYNTH = join(ROOT, "data/synth");
const TMP = mkdtempSync(join(tmpdir(), "inspector-e2e-"));
const ML_PORT = 18000 + Math.floor(Math.random() * 1000);
process.env.INSPECTOR_BLOB_DIR = join(TMP, "blobs");
process.env.INSPECTOR_ML_URL = `http://127.0.0.1:${ML_PORT}`;
process.env.INSPECTOR_RIN_URL = "http://rin.invalid";
process.env.INSPECTOR_DEMO_PASSWORD = "test-pass";
// Дифф листов (OS-INSP-3.4) добавил бы карточки SHEET-DIFF по паре СК2-Р-АР A → B и сдвинул счётчики
// кандидатов answer-key; здесь он выключен, покрыт ml/tests/test_sheetdiff.py и tests/sheetdiff.test.ts.
process.env.INSPECTOR_SHEET_DIFF_AUTO = "0";

let ml: ChildProcess;
let app: any;
let db: any;
let queueIdle: () => Promise<void>;
let rin: typeof import("../src/services/rin.ts");
const tokens: Record<string, string> = {};

async function waitFor(fn: () => Promise<boolean>, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timeout");
}

function multipart(fields: Record<string, string>, files: Array<{ field: string; name: string; buf: Buffer }>) {
  const boundary = "----insp" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(f.buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function packageOf(obj: string) {
  const dir = join(SYNTH, obj);
  const files = readdirSync(dir)
    .filter((f) => /\.(pdf|docx|xml|xlsx|png|jpg|tif)$/.test(f) && statSync(join(dir, f)).isFile())
    .map((f) => ({ field: "files", name: f, buf: readFileSync(join(dir, f)) }));
  return [...files, { field: "manifest", name: "manifest.json", buf: readFileSync(join(dir, "manifest.json")) }];
}

async function api(method: string, url: string, body?: unknown, who = "inspector") {
  const r = await app.inject({ method, url, payload: body as any, headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: r.statusCode, json: () => r.json(), raw: r };
}

async function uploadAndWait(obj: string) {
  const mp = multipart({}, packageOf(obj));
  const r = await app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${tokens.inspector}` } });
  expect(r.statusCode).toBe(202);
  const id = r.json().process_id as string;
  await queueIdle();
  await waitFor(async () => (await api("GET", `/api/v1/inspection/${id}/status`)).json().status === "READY");
  return id;
}

const statusOf = (detail: any, code: string) => detail.checks.find((c: any) => c.param_code === code && !c.parent_id);

beforeAll(async () => {
  ml = spawn(join(ROOT, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--port", String(ML_PORT), "--log-level", "warning"], {
    cwd: join(ROOT, "ml"),
    env: { ...process.env, INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_ML_CACHE: join(TMP, "ml-cache") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr!.on("data", (b) => process.env.E2E_DEBUG && process.stderr.write("[ml] " + b));
  ml.on("exit", (code, sig) => process.env.E2E_DEBUG && process.stderr.write(`[ml] exit ${code} ${sig}\n`));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${ML_PORT}/health`)).ok);
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  const ins = await import("../src/services/inspections.ts");
  rin = await import("../src/services/rin.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  queueIdle = () => ins.parseQueue(db).idle();
  for (const who of ["inspector", "supervisor", "admin", "curator", "ml"]) {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: who, password: "test-pass" } });
    tokens[who] = r.json().token;
  }
  // 90 с: хук поднимает внешний ML-сервис, импортирует приложение и входит пятью учётками (scrypt); в полном гейте
  // рядом 80 файлов тестов, и 30 с не хватало (T-139, local-gate 27.09: ML отвечал, хук падал на входах)
}, 90_000);

afterAll(async () => {
  await db?.close();
  ml?.kill();
  rmSync(TMP, { recursive: true, force: true });
});

describe("сквозной сценарий на синтетике", () => {
  it("вход по логину и паролю; без токена — 401", async () => {
    expect(tokens.inspector).toMatch(/^[0-9a-f]{48}$/);
    expect((await app.inject({ method: "GET", url: "/api/v1/inspections" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "nope" } })).statusCode).toBe(401);
  });

  it("перебор пароля: после 5 неудачных попыток — 429 с Retry-After, даже с верным паролем", async () => {
    const tryLogin = (password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "curator", password } });
    for (let i = 0; i < 5; i++) expect((await tryLogin("wrong")).statusCode).toBe(401);
    const blocked = await tryLogin("test-pass");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // несуществующий логин неотличим: те же 401, затем та же пауза
    const ghost = () => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "no-such-user", password: "x" } });
    for (let i = 0; i < 5; i++) expect((await ghost()).statusCode).toBe(401);
    expect((await ghost()).statusCode).toBe(429);
  });

  let sev: string;
  it("OBJ-SEV-2: FULL, статусы совпадают с answer-key", async () => {
    sev = await uploadAndWait("OBJ-SEV-2");
    const d = (await api("GET", `/api/v1/inspections/${sev}`)).json();
    if (process.env.E2E_DEBUG) console.log(d.files.map((f: any) => [f.file_name, f.parse_status, f.parse_error, f.parse_attempts]));
    expect(d.inspection.scenario).toBe("FULL");
    expect(d.inspection.load_codes).toEqual(["PD_UPLOADED", "RD_UPLOADED", "ID_UPLOADED"]);
    const key = JSON.parse(readFileSync(join(SYNTH, "OBJ-SEV-2/answer-key.json"), "utf8"));
    for (const [code, want] of Object.entries(key)) if (/^(M|HW|REQ)-/.test(code)) expect([code, statusOf(d, code)?.finding_status]).toEqual([code, want]);
    // устаревшая редакция не эталон: АР ред. A — SUPERSEDED, её 12 900 м² не участвует
    expect(d.files.find((f: any) => f.client_file_id === "SEV-RD-AR-A").revision_role).toBe("SUPERSEDED");
    expect(statusOf(d, "M-002").fragments.some((f: any) => f.revision === "A")).toBe(false);
    // скан двери разобран OCR
    expect(d.files.find((f: any) => f.client_file_id === "SEV-ID-DOOR-1").pages[0].source).toBe("ocr");
    expect(d.checks.every((c: any) => c.finding_status !== "CONFIRMED_VIOLATION")).toBe(true);
    // OS-INSP-2.3.2: подписанный журнал ИД находки не даёт; паспорт двери без подписи сверен выше по answer-key
    expect(statusOf(d, "REQ-SEV-ID-JBR-1")).toBeUndefined();
    // OS-INSP-2.3.3: исполнительный чертёж с подписью и обоими штампами — находки нет
    expect(statusOf(d, "REQ-SEV-ID-ICH-1")).toBeUndefined();
    // OS-INSP-2.2.7: смета и опросный лист распознаны и не стали источниками значений (99 999 м², EI 15 не участвуют)
    expect(d.files.find((f: any) => f.client_file_id === "SEV-PD-SM-1").doc_type).toMatchObject({ kind: "estimate", page: 1 });
    expect(d.files.find((f: any) => f.client_file_id === "SEV-RD-OL-1").doc_type).toMatchObject({ kind: "questionnaire", page: 1 });
    expect(d.checks.flatMap((c: any) => c.fragments).filter((f: any) => ["СК2-П-СМ", "СК2-Р-ОЛ"].includes(f.document_code))).toEqual([]);
    // OS-INSP-2.4: измерение на исполнительном чертеже — масштаб по двум размерным линиям, стены через 3000 и 4500 мм
    const ich = d.files.find((f: any) => f.client_file_id === "SEV-ID-ICH-1");
    const meas = (await api("GET", `/api/v1/files/${ich.id}/measure?page=1`)).json();
    expect([meas.status, meas.method, meas.dimension_lines.length]).toEqual(["OK", "dimension_line", 2]);
    const walls = meas.distances.filter((x: any) => x.axis === "x").map((x: any) => x.mm);
    expect([3000, 4500].every((want) => walls.some((mm: number) => Math.abs(mm - want) / want <= 0.02))).toBe(true);
    expect((await api("GET", `/api/v1/files/${ich.id}/measure?page=0`)).status).toBe(400);
    expect((await api("GET", `/api/v1/files/${d.files.find((f: any) => f.kind === "docx").id}/measure`)).status).toBe(415);
    // OS-INSP-2.3.4, ТЗ §5 прим. 2: по скану видно, какие реквизиты есть — у паспорта двери дата и рег. номер, подписи нет
    const door = d.files.find((f: any) => f.client_file_id === "SEV-ID-DOOR-1");
    const kinds = new Set(door.requisites.map((r: any) => r.kind));
    expect([kinds.has("reg_number"), kinds.has("date"), kinds.has("signature")]).toEqual([true, true, false]);
    expect(door.requisites.every((r: any) => r.bbox?.length === 4 && r.page === 1)).toBe(true);
  }, 60_000);

  it("карточка кандидата: expected/actual, источники с SHA-256, страница и bbox", async () => {
    const p = (await api("GET", `/api/v1/inspection/${sev}/protocol`)).json();
    const card = p.sections.candidates.find((c: any) => c.param_code === "M-055");
    expect(card).toMatchObject({ expected: "B30", actual: "B25" });
    expect(card.sources.length).toBeGreaterThanOrEqual(2);
    for (const s of card.sources) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.page).toBeGreaterThan(0);
      expect(s.bbox).toHaveLength(4);
    }
    expect(p.versions).toMatchObject({ matrix_version: "1.1.2", model_version: "dev-anchors-0.1" });
    expect(p.versions.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(p.sections)).toEqual(["completeness", "candidates", "confirmed_violations", "negative_verified", "suspicions", "missing_evidence"]);
  });

  it("скрытые работы: позиция без АОСР — MISSING_EVIDENCE с основанием, позиция с актом — ссылка на АОСР № 7", async () => {
    const d = (await api("GET", `/api/v1/inspections/${sev}`)).json();
    const hw = d.checks.filter((c: any) => c.param_code.startsWith("HW-"));
    expect(hw.map((c: any) => [c.param_code, c.finding_status])).toEqual([["HW-1", "NEGATIVE_VERIFIED"], ["HW-2", "MISSING_EVIDENCE"], ["HW-3", "MISSING_EVIDENCE"]]);
    const [arm, hydro] = hw;
    expect(arm.actual_value).toBe("СК2-ИД-АОСР-07");
    expect(arm.fragments.map((f: any) => [f.stage, f.role_expected_actual])).toEqual([["RD", "expected"], ["ID", "actual"]]);
    expect(arm.fragments[0]).toMatchObject({ document_code: "СК2-Р-КЖ", sheet_page: 3 });
    expect(JSON.parse(arm.fragments[0].bbox_polygon_norm)).toHaveLength(4);
    expect(hydro.parameter_name).toContain("Гидроизоляция фундаментной плиты");
    expect(hydro.reason).toContain("нет АОСР");
    const p = (await api("GET", `/api/v1/inspection/${sev}/protocol`)).json();
    expect(p.sections.missing_evidence.map((m: any) => m.param_code)).toEqual(expect.arrayContaining(["HW-2", "HW-3"]));
  });

  it("согласованное изменение: реестр с аудитом, карточка кандидата получает изменение по коду параметра", async () => {
    const d = (await api("GET", `/api/v1/inspections/${sev}`)).json();
    const basis = d.files.find((f: any) => f.client_file_id === "SEV-RD-AR-B");
    const body = { number: "ИЗМ-3", date: "2025-08-01", param_codes: ["m-041"], basis_file_id: basis.id, description: "Ширина выхода уменьшена по согласованию с ГПН" };
    expect((await api("POST", `/api/v1/inspection/${sev}/changes`, body, "curator")).status).toBe(403);
    expect((await api("POST", `/api/v1/inspection/${sev}/changes`, { ...body, date: "01.08.2025" })).status).toBe(400);
    expect((await api("POST", `/api/v1/inspection/${sev}/changes`, { ...body, basis_file_id: "чужой" })).status).toBe(400);
    const r = await api("POST", `/api/v1/inspection/${sev}/changes`, body);
    expect(r.status).toBe(201);
    expect(r.json()).toMatchObject({ number: "ИЗМ-3", param_codes: ["M-041"], basis_file_name: "SEV-RD-AR-B.pdf", created_by: "u-insp" });
    expect((await api("GET", `/api/v1/inspection/${sev}/changes`)).json()).toHaveLength(1);
    const p = (await api("GET", `/api/v1/inspection/${sev}/protocol`)).json();
    expect(p.sections.candidates.find((c: any) => c.param_code === "M-041").approved_changes).toEqual([
      { number: "ИЗМ-3", date: "2025-08-01", param_codes: ["M-041"], basis_file_id: basis.id, basis_file_name: "SEV-RD-AR-B.pdf", description: body.description },
    ]);
    expect(p.sections.candidates.find((c: any) => c.param_code === "M-055").approved_changes).toEqual([]);
    const audit = (await api("GET", "/api/v1/audit?action=APPROVED_CHANGE_REGISTERED", undefined, "supervisor")).json();
    expect(JSON.parse(audit[0].details)).toMatchObject({ number: "ИЗМ-3", param_codes: ["M-041"] });
  });

  it("верификация: отклонение без причины — 400; решения; финализация только без открытых кандидатов", async () => {
    const d = (await api("GET", `/api/v1/inspections/${sev}`)).json();
    const open = d.checks.filter((c: any) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING");
    expect(open.length).toBe(5);
    expect((await api("POST", `/api/v1/checks/${open[0].id}/decision`, { action: "reject", reason_code: "OCR_ERROR", comment: "" })).status).toBe(400);
    expect((await api("POST", `/api/v1/checks/${open[0].id}/decision`, { action: "reject", reason_code: "WHATEVER", comment: "x" })).status).toBe(400);
    expect((await api("POST", `/api/v1/inspection/${sev}/finalize`)).status).toBe(409);
    // составной кандидат M-002 (РД и ИД расходятся с ПД) делится на атомарные findings со своими доказательствами
    const area = statusOf(d, "M-002");
    const actual = area.fragments.filter((f: any) => f.role_expected_actual === "actual");
    const frs = (await api("GET", `/api/v1/checks/${area.id}/fragments`)).json().filter((f: any) => f.role_expected_actual === "actual");
    expect(actual.length).toBe(2);
    const split = await api("POST", `/api/v1/checks/${area.id}/split`, { parts: frs.map((f: any) => ({ title: `Общая площадь: ПД → ${f.stage}`, fragment_ids: [f.id] })) });
    expect(split.json().ids).toHaveLength(2);
    expect((await api("POST", `/api/v1/checks/${area.id}/decision`, { action: "confirm" })).status).toBe(409);
    const dd = (await api("GET", `/api/v1/inspections/${sev}`)).json();
    const parts = dd.checks.filter((c: any) => c.parent_id === area.id);
    expect(parts.map((c: any) => c.fragments.map((f: any) => f.stage).join("+")).sort()).toEqual(["PD+ID", "PD+RD"]);
    for (const part of parts) await api("POST", `/api/v1/checks/${part.id}/decision`, { action: "clarify" });
    const r = await api("POST", `/api/v1/checks/${statusOf(d, "M-055").id}/decision`, { action: "confirm", comment: "Класс бетона понижен" });
    expect(r.json()).toMatchObject({ verification_status: "CONFIRMED_VIOLATION", process_status: "VERIFYING" });
    await api("POST", `/api/v1/checks/${statusOf(d, "M-103").id}/decision`, { action: "reject", reason_code: "OCR_ERROR", comment: "Скан нечитаем" });
    await api("POST", `/api/v1/checks/${statusOf(d, "M-041").id}/decision`, { action: "confirm" });
    const last = await api("POST", `/api/v1/checks/${statusOf(d, "M-059").id}/decision`, { action: "confirm" });
    expect(last.json().process_status).toBe("COMPLETED");
    const audit = (await api("GET", "/api/v1/audit", undefined, "supervisor")).json();
    expect(audit.filter((a: any) => a.action.startsWith("DECISION_")).length).toBe(6);
    // OS-INSP-4.1.6, 4.1.7: отклонение M-103 — в журнале отклонений; два уточнения частей M-002 — спорные случаи
    expect((await api("GET", `/api/v1/inspection/${sev}/feedback-logs`)).status).toBe(403);
    const logs = (await api("GET", `/api/v1/inspection/${sev}/feedback-logs`, undefined, "supervisor")).json();
    expect(logs.rejections).toHaveLength(1);
    expect(logs.rejections[0]).toMatchObject({ param_code: "M-103", ai_verdict: "CANDIDATE", reason_code: "OCR_ERROR", comment: "Скан нечитаем" });
    expect(logs.rejections[0].suggested_fix).toMatch(/OCR/);
    expect(logs.disputes.map((x: any) => x.kind)).toEqual(["CLARIFICATION", "CLARIFICATION"]);
    expect(audit[0]).toHaveProperty("ip_address");
  });

  it("финализация: решения неизменяемы, дозагрузка запрещена, в «РиН» — только подтверждённые, PENDING_SYNC при сбое", async () => {
    const sent: any[] = [];
    let down = true;
    rin.setRinTransport(async (_url, payload) => {
      sent.push(payload);
      return { status: down ? 503 : 202 };
    });
    // OS-INSP-4.3.5: в синтетике есть критические параметры без вердикта — инспектор подтверждает просмотр перечня
    const f = await api("POST", `/api/v1/inspection/${sev}/finalize`, { critical_reviewed: true });
    expect(f.status).toBe(200);
    expect(f.json().sync_status).toBe("PENDING_SYNC");
    const d = (await api("GET", `/api/v1/inspections/${sev}`)).json();
    expect((await api("POST", `/api/v1/checks/${statusOf(d, "M-055").id}/decision`, { action: "clarify" })).status).toBe(409);
    const mp = multipart({ process_id: sev }, [{ field: "files", name: "x.xml", buf: Buffer.from("<a>1</a>") }]);
    const up = await app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${tokens.inspector}` } });
    expect(up.statusCode).toBe(409);
    expect(up.json().error).toContain("новую проверку");
    expect(sent[0].confirmed_violations.map((c: any) => c.param_code).sort()).toEqual(["M-041", "M-055", "M-059"]);
    expect(sent[0]).toHaveProperty("versions.input_manifest_hash");
    // OS-INSP-5.2.4 (2078-ПП п. 9(1).10): в «РиН» уходит запись о применении ИИ-средства
    expect(sent[0].ai_usage).toMatchObject({ tool: { name: "Инспектор ИИ" }, serviceability: { ok: true } });
    expect(sent[0].ai_usage.legal_basis).toContain("9(1).8");
    // OS-INSP-5.1.2 (п. 9(1).8): готовый текст для акта и проверяемый хеш приложенного протокола
    const txt = (await api("GET", `/api/v1/inspection/${sev}/ai-usage?format=text`)).raw.body as string; // протокол финализирован выше
    expect(txt).toMatch(/применено программное средство «Инспектор ИИ»/);
    expect(txt).toMatch(/SHA-256 [0-9a-f]{64}/);
    const rec = (await api("GET", `/api/v1/inspection/${sev}/ai-usage`)).json();
    expect(rec.final).toBe(true);
    // в «РиН» — только подтверждённые записи (OS-INSP-5.2.1)
    expect(sent[0].ai_usage.data.every((x: any) => x.inspector_decision === "подтверждено инспектором")).toBe(true);
    expect(sent[0].ai_usage.data.map((x: any) => x.param_code).sort()).toEqual(["M-041", "M-055", "M-059"]);
    expect(rec.data.find((x: any) => x.param_code === "M-055")).toMatchObject({ inspector_decision: "подтверждено инспектором" });
    expect(rec.data.find((x: any) => x.param_code === "M-055").sources.every((x: any) => /^[0-9a-f]{64}$/.test(x.sha256) && x.page > 0)).toBe(true);
    // повторы 1, 5, 15 минут, затем FAILED; решение инспектора не меняется
    for (const min of [1, 5, 15]) await rin.runDueSyncJobs(db, new Date(Date.now() + (min + 21) * 60_000 * 2));
    let s = (await api("GET", `/api/v1/inspection/${sev}/status`)).json();
    expect(s).toMatchObject({ status: "FINALIZED", sync_status: "SYNC_FAILED" });
    down = false;
    await api("POST", `/api/v1/inspection/${sev}/sync`);
    s = (await api("GET", `/api/v1/inspection/${sev}/status`)).json();
    expect(s.sync_status).toBe("SYNCED");
  });

  it("отмена финализации: инспектору — 403, супервизору с причиной — COMPLETED", async () => {
    expect((await api("POST", `/api/v1/inspection/${sev}/unfinalize`, { reason: "ошибка" }, "inspector")).status).toBe(403);
    expect((await api("POST", `/api/v1/inspection/${sev}/unfinalize`, { reason: "" }, "supervisor")).status).toBe(403);
    const r = await api("POST", `/api/v1/inspection/${sev}/unfinalize`, { reason: "Ошибочно финализирован до ответа заявителя" }, "supervisor");
    expect(r.json().status).toBe("COMPLETED");
    const audit = (await api("GET", "/api/v1/audit?action=FINALIZATION_CANCELLED", undefined, "supervisor")).json();
    expect(JSON.parse(audit[0].details).reason).toContain("Ошибочно");
  });

  it("OBJ-SCH-8: PD_RD_ONLY и конфликт редакций → CLARIFICATION_REQUIRED без вывода о нарушении", async () => {
    const id = await uploadAndWait("OBJ-SCH-8");
    const d = (await api("GET", `/api/v1/inspections/${id}`)).json();
    expect(d.inspection.scenario).toBe("PD_RD_ONLY");
    const key = JSON.parse(readFileSync(join(SYNTH, "OBJ-SCH-8/answer-key.json"), "utf8"));
    for (const [code, want] of Object.entries(key)) if (code.startsWith("M-")) expect([code, statusOf(d, code)?.finding_status]).toEqual([code, want]);
    expect(d.files.filter((f: any) => f.revision_role === "CONFLICT").length).toBe(2);
  }, 60_000);

  it("OBJ-POL-115: PARTIALLY_LOADED, гипотезы; дозагрузка — инкрементальный пересчёт с новой версией", async () => {
    const id = await uploadAndWait("OBJ-POL-115");
    let d = (await api("GET", `/api/v1/inspections/${id}`)).json();
    expect(d.inspection.scenario).toBe("PARTIALLY_LOADED");
    expect(d.inspection.load_codes).toContain("ID_PARTIAL");
    expect(d.missing_files.map((f: any) => f.file_id).sort()).toEqual(["POL-ID-AOSR-2", "POL-ID-TP-1"]);
    expect(statusOf(d, "M-021").finding_status).toBe("CANDIDATE");
    // OS-INSP-2.3.3: исполнительный чертёж только со штампом «В производство работ» — MISSING_EVIDENCE
    const req = statusOf(d, "REQ-POL-ID-ICH-1");
    expect(req.finding_status).toBe("MISSING_EVIDENCE");
    expect(req.expected_value).toBe("обязательный реквизит: штамп «Выполнено согласно проекту»");
    if (process.env.E2E_DEBUG) console.log(d.suspicions.map((s: any) => [s.discovery_method, s.description]));
    expect(d.suspicions.map((s: any) => s.discovery_method).sort()).toEqual(["LOGICAL_ANALYSIS", "SEMANTIC_DISSONANCE"]);
    const p = (await api("GET", `/api/v1/inspection/${id}/protocol`)).json();
    expect(p.summary.suspicions).toBe(2);
    // текст для акта до финализации не выдаётся (ревью T-079): данные ещё меняются решениями инспектора
    expect((await api("GET", `/api/v1/inspection/${id}/ai-usage?format=text`)).status).toBe(409);
    expect((await api("GET", `/api/v1/inspection/${id}/ai-usage`)).json().final).toBe(false);
    expect(p.sections.candidates.some((c: any) => c.discovery_method)).toBe(false); // гипотезы не среди нарушений
    // решение до дозагрузки сохраняется
    await api("POST", `/api/v1/checks/${statusOf(d, "M-021").id}/decision`, { action: "confirm" });
    const late = join(SYNTH, "OBJ-POL-115/_late");
    const mp = multipart({ process_id: id }, readdirSync(late).map((f) => ({ field: "files", name: f, buf: readFileSync(join(late, f)) })));
    const up = await app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${tokens.inspector}` } });
    expect(up.statusCode).toBe(202);
    await queueIdle();
    await waitFor(async () => (await api("GET", `/api/v1/inspection/${id}/status`)).json().protocol_version === 2);
    d = (await api("GET", `/api/v1/inspections/${id}`)).json();
    expect(d.inspection.scenario).toBe("FULL");
    expect(statusOf(d, "M-021").verification_status).toBe("CONFIRMED_VIOLATION");
    expect(statusOf(d, "M-002").fragments.map((f: any) => f.stage)).toContain("ID");
    const versions = (await api("GET", `/api/v1/inspection/${id}/protocols`)).json();
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect((await api("GET", `/api/v1/inspection/${id}/protocol?version=1`)).json().protocol_version).toBe(1);
  }, 60_000);

  it("OBJ-SKL-5: XLSX и PNG приняты и разобраны; журнал из двух частей — один документ, страницы сквозные", async () => {
    const id = await uploadAndWait("OBJ-SKL-5");
    const d = (await api("GET", `/api/v1/inspections/${id}`)).json();
    expect(d.inspection.scenario).toBe("FULL");
    expect(d.inspection.load_codes).toEqual(["PD_UPLOADED", "RD_UPLOADED", "ID_UPLOADED"]);
    const file = (cid: string) => d.files.find((f: any) => f.client_file_id === cid);
    expect([file("SKL-RD-AR-1").kind, file("SKL-RD-AR-1").parse_status, file("SKL-RD-AR-1").pages[0].source]).toEqual(["xlsx", "DONE", "structured"]);
    expect([file("SKL-ID-TP-1").kind, file("SKL-ID-TP-1").parse_status, file("SKL-ID-TP-1").pages[0].source]).toEqual(["png", "DONE", "ocr"]);
    // части одного журнала не спорят за эталон
    expect(d.files.filter((f: any) => f.revision_role === "CONFLICT")).toEqual([]);
    expect([file("SKL-ID-OZHR-1").revision_role, file("SKL-ID-OZHR-1-P2").revision_role]).toEqual(["CURRENT", "CURRENT"]);
    const key = JSON.parse(readFileSync(join(SYNTH, "OBJ-SKL-5/answer-key.json"), "utf8"));
    for (const [code, want] of Object.entries(key)) if (code.startsWith("M-")) expect([code, statusOf(d, code)?.finding_status]).toEqual([code, want]);
    // значение из второй части: страница 2 файла части = страница 5 журнала
    const p = (await api("GET", `/api/v1/inspection/${id}/protocol`)).json();
    const src = p.sections.candidates.find((c: any) => c.param_code === "M-055").sources.find((s: any) => s.role === "actual" && s.stage === "ID");
    expect(src).toMatchObject({ document_code: "СК5-ИД-ОЖР", part_index: 2, page_in_file: 2, page: 5 });
  }, 60_000);

  it("ошибки загрузки: формат, битый PDF, пакет без реестра", async () => {
    const mp = multipart({ object: JSON.stringify({ object_id: "OBJ-ERR", name: "Ошибки" }), start: "false" }, [
      { field: "files", name: "photo.gif", buf: Buffer.from("GIF89a\x01\x00\x01\x00", "latin1") },
      { field: "files", name: "broken.pdf", buf: Buffer.from("%PDF-1.4 oops") },
      { field: "files", name: "ok.xml", buf: Buffer.from("<a>Этажность 3</a>") },
    ]);
    const r = await app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${tokens.inspector}` } });
    const j = r.json();
    expect(j.rejected.map((x: any) => x.code).sort()).toEqual(["CORRUPTED", "UNSUPPORTED_FORMAT"]);
    expect(j.accepted).toHaveLength(1);
    expect(j.clarification).toContain("CLARIFICATION_REQUIRED");
    const d = (await api("GET", `/api/v1/inspections/${j.process_id}`)).json();
    expect(d.files[0].revision_role).toBe("UNRESOLVED");
  });

  it("экспорт протокола JSON, XML, PDF, DOCX", async () => {
    for (const [fmt, sig] of [["json", "{"], ["xml", "<?xml"], ["pdf", "%PDF"], ["docx", "PK"]] as const) {
      const r = await api("GET", `/api/v1/inspection/${sev}/protocol/export?format=${fmt}`);
      expect([fmt, r.status]).toEqual([fmt, 200]);
      expect(r.raw.rawPayload.subarray(0, sig.length).toString("latin1")).toBe(sig);
    }
  }, 30_000);

  it("администратор меняет порог без перекодирования → новая matrix_version; инспектору — 403", async () => {
    expect((await api("PATCH", "/api/v1/params/M-041", { min_value: 1.0 }, "inspector")).status).toBe(403);
    const r = await api("PATCH", "/api/v1/params/M-041", { min_value: 1.0 }, "admin");
    expect(r.json().matrix_version).toBe("1.1.3");
    const p = (await api("GET", "/api/v1/params")).json().find((x: any) => x.code === "M-041");
    expect(JSON.parse(p.compare_json)).toEqual({ kind: "min", min: 1 });
  });

  it("нормативы и логические правила: деактивация вместо удаления; отчёт по дообучению", async () => {
    const norms = (await api("GET", "/api/v1/normative")).json();
    expect((await api("PATCH", `/api/v1/normative/${norms[0].id}`, { is_active: false }, "inspector")).status).toBe(403);
    expect((await api("PATCH", `/api/v1/normative/${norms[0].id}`, { is_active: false, effective_to: "2026-09-24" }, "admin")).json().ok).toBe(true);
    const after = (await api("GET", "/api/v1/normative")).json();
    expect(after.length).toBe(norms.length);
    expect(after[0]).toMatchObject({ is_active: false, effective_to: "2026-09-24" });
    const created = (await api("POST", "/api/v1/rules", { rule_name: "Высота здания свыше 28 м — незадымляемые лестницы", condition: { key: "M-008", op: ">", value: 28 }, expected: { key: "SMOKEFREE", op: ">", value: 0 }, normative_base: "СП 1.13130.2020, п. 4.4.12" }, "admin")).json();
    expect((await api("PATCH", `/api/v1/rules/${created.id}`, { is_active: false }, "admin")).json().ok).toBe(true);
    expect((await api("GET", "/api/v1/rules")).json().find((r: any) => r.id === created.id).is_active).toBe(false); // флаги в PostgreSQL — boolean (ADR-0003)
    const rep = (await api("GET", "/api/v1/ml/report", undefined, "ml")).json();
    expect(rep.by_reason.find((r: any) => r.reason_code === "OCR_ERROR")).toMatchObject({ n: 1 });
    expect(rep.by_reason[0].recommendation).not.toBe("");
  });

  it("реестр моделей: ворота качества и публикация с подписью ответственного", async () => {
    const good = { precision: 0.92, recall: 0.84, f1: 0.88, false_positive_rate: 0.05, recall_by_category: { КР: 0.85 } };
    expect((await api("POST", "/api/v1/ml/models", { model_version: "m-1", dataset_version: "gold-x", metrics: good }, "ml")).json().gate.ok).toBe(true);
    expect((await api("POST", "/api/v1/ml/models/m-1/approve", undefined, "ml")).status).toBe(403);
    expect((await api("POST", "/api/v1/ml/models/m-1/approve", undefined, "supervisor")).json().ok).toBe(true);
    const worse = { ...good, recall_by_category: { КР: 0.8 } };
    expect((await api("POST", "/api/v1/ml/models", { model_version: "m-2", dataset_version: "gold-x", metrics: worse }, "ml")).json().gate.ok).toBe(false);
    expect((await api("POST", "/api/v1/ml/models/m-2/approve", undefined, "supervisor")).status).toBe(409);
    const models = (await api("GET", "/api/v1/ml/models", undefined, "ml")).json();
    expect(models.find((m: any) => m.model_version === "m-1")).toMatchObject({ approval_status: "PUBLISHED", approved_by: "u-sup" });
  });

  it("дашборд: цвет и фильтры", async () => {
    const list = (await api("GET", "/api/v1/inspections")).json();
    const colors = Object.fromEntries(list.map((x: any) => [x.object_id, x.color]));
    expect(colors["OBJ-SEV-2"]).toBe("red");
    expect(colors["OBJ-SCH-8"]).toBe("yellow");
    expect((await api("GET", "/api/v1/inspections?color=red")).json().every((x: any) => x.color === "red")).toBe(true);
    expect((await api("GET", "/api/v1/inspections?section=КР")).json().map((x: any) => x.object_id)).toContain("OBJ-SEV-2");
  });

  it("GOLD: синтетика не эталон — решения по синтетическому объекту в набор не попадают (OS-INSP-6.4.16, T-148)", async () => {
    // выпуск набора на реальных объектах — retrain-route.test.ts; здесь все объекты — синтетика из data/synth
    await api("POST", `/api/v1/inspection/${sev}/finalize`, { critical_reviewed: true });
    const prev = (await api("GET", "/api/v1/ml/gold/preview", undefined, "curator")).json();
    expect(prev.items).toEqual([]);
    expect(prev.positives).toBe(0);
    const rel = await api("POST", "/api/v1/ml/gold/release", undefined, "curator");
    expect(rel.status).toBe(409);
    expect((await api("POST", "/api/v1/ml/gold/release", undefined, "inspector")).status).toBe(403);
  });

  it("файл под занятым file_id не перезаписывается; повтор — дубликат; хеш сверяется с реестром", async () => {
    const dir = join(SYNTH, "OBJ-SCH-8");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const send = async (processId: string | null, files: Array<{ field: string; name: string; buf: Buffer }>, fields: Record<string, string> = {}) => {
      const mp = multipart({ ...(processId ? { process_id: processId } : {}), start: "false", ...fields }, files);
      return (await app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${tokens.inspector}` } })).json();
    };
    const pz = readFileSync(join(dir, "SCH-PD-PZ-1.pdf"));
    const first = await send(null, [{ field: "manifest", name: "manifest.json", buf: Buffer.from(JSON.stringify({ ...manifest, object: { ...manifest.object, object_id: "OBJ-DUP" } })) }, { field: "files", name: "SCH-PD-PZ-1.pdf", buf: pz }]);
    expect(first.accepted).toHaveLength(1);
    const again = await send(first.process_id, [{ field: "files", name: "SCH-PD-PZ-1.pdf", buf: pz }]);
    expect(again.rejected[0].code).toBe("DUPLICATE");
    const other = await send(first.process_id, [{ field: "files", name: "SCH-PD-PZ-1.pdf", buf: readFileSync(join(dir, "SCH-RD-AR-1.pdf")) }]);
    expect(other.rejected[0].code).toBe("FILE_ID_EXISTS");
    const wrongHash = { files: [{ ...manifest.files[1], sha256: "0".repeat(64) }] };
    const bad = await send(first.process_id, [{ field: "manifest", name: "manifest.json", buf: Buffer.from(JSON.stringify(wrongHash)) }, { field: "files", name: "SCH-RD-AR-1.pdf", buf: readFileSync(join(dir, "SCH-RD-AR-1.pdf")) }]);
    expect(bad.rejected[0].code).toBe("HASH_MISMATCH");
  });

  it("целостность хранилища: подмена файла обнаруживается, администратор уведомлён", async () => {
    const { writeFileSync, readdirSync: ls } = await import("node:fs");
    const ok = (await api("POST", "/api/v1/admin/integrity", undefined, "admin")).json();
    expect(ok).toMatchObject({ missing: [], corrupted: [], unreadable: [] });
    expect(ok.checked).toBeGreaterThan(0);
    const victim = ls(join(TMP, "blobs")).find((name) => /^[0-9a-f]{64}$/.test(name))!;
    expect(victim).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(TMP, "blobs", victim), "подменено");
    const bad = (await api("POST", "/api/v1/admin/integrity", undefined, "admin")).json();
    expect(bad.corrupted).toEqual([victim]);
    expect((await api("POST", "/api/v1/admin/integrity", undefined, "inspector")).status).toBe(403);
    const notes = (await api("GET", "/api/v1/notifications", undefined, "admin")).json();
    expect(notes[0].message).toContain("Целостность хранилища нарушена");
  });

  it("метрики Prometheus и OpenAPI", async () => {
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toContain("inspector_http_requests_total");
    const o = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    expect(o.openapi).toBe("3.0.3");
    expect(Object.keys(o.paths)).toContain("/api/v1/documents/upload");
  });

  // OS-INSP-6.5.16 (ТЗ 9.3.6, T-081): объект замера полного цикла верификации. Пакет не хранится в репозитории (51 PDF,
  // ~7 МБ) — генерируется детерминированно по seed; байты и эталон по seed проверяет ml/tests/test_usability_132.py.
  it("OBJ-USB-132: 132 параметра в протоколе, ровно 14 кандидатов — те же, что в answer-key", async () => {
    const { spawnSync } = await import("node:child_process");
    const out = join(TMP, "usability");
    const gen = spawnSync(join(ROOT, "ml/.venv/bin/python"), ["-m", "synth.usability_132", "--seed", "1", "--out", out], { cwd: join(ROOT, "ml"), encoding: "utf8" });
    expect(gen.status, gen.stderr).toBe(0);
    const dir = join(out, "OBJ-USB-132");
    const files = readdirSync(dir).filter((f) => f.endsWith(".pdf")).map((f) => ({ field: "files", name: f, buf: readFileSync(join(dir, f)) }));
    const mp = multipart({}, [...files, { field: "manifest", name: "manifest.json", buf: readFileSync(join(dir, "manifest.json")) }]);
    const r = await app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${tokens.inspector}` } });
    expect(r.statusCode).toBe(202);
    const id = r.json().process_id as string;
    await queueIdle();
    await waitFor(async () => (await api("GET", `/api/v1/inspection/${id}/status`)).json().status === "READY", 300_000);
    const d = (await api("GET", `/api/v1/inspections/${id}`)).json();
    const key = JSON.parse(readFileSync(join(dir, "answer-key.json"), "utf8"));
    expect(d.inspection.scenario).toBe(key.scenario);
    const params = d.checks.filter((c: any) => !c.parent_id && /^M-\d{3}$/.test(c.param_code));
    expect(params.length).toBe(132);
    const got = Object.fromEntries(params.map((c: any) => [c.param_code, c.finding_status]));
    const { scenario: _, ...want } = key;
    expect(got).toEqual(want);
    // очередь верификации: ровно 14 кандидатов, и все они — нарушения из ключа (лишних находок по реквизитам нет)
    const queue = d.checks.filter((c: any) => !c.parent_id && c.finding_status === "CANDIDATE").map((c: any) => c.param_code).sort();
    expect(queue).toEqual(Object.keys(want).filter((c) => want[c] === "CANDIDATE").sort());
    expect(queue.length).toBe(14);
  }, 400_000);
});
