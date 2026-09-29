// T-234: модель данных ТЗ §10 — 128 полей в схеме и каждое читается процессом. L2 — контракт маршрутов, L4 — интеграция
// с PostgreSQL (PGlite; с INSPECTOR_TEST_DATABASE_URL — сервер): миграция 0015, триггеры, генерируемые колонки, журналы,
// реестр моделей, нормы из normative_base. Данные — синтетика в базе в памяти. Название теста — ссылка трассы.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TZ10 } from "./fixtures/tz10-fields.ts";

const TMP = mkdtempSync(join(tmpdir(), "inspector-tz10-"));
let app: any;
let db: any;
const tok: Record<string, string> = {};
const now = () => new Date().toISOString();
const call = (who: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tok[who]}` }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const sqlState = async (p: Promise<unknown>): Promise<string | null> => p.then(() => null, (e: any) => e?.code ?? String(e));
const one = async (sql: string, params: unknown[] = []) => db.get(sql, params);

/** Объект и проверка; статус и версия протокола — по сценарию теста. */
async function inspection(id: string, status = "VERIFYING", version = 1): Promise<void> {
  const { RULES_VERSION } = await import("../src/domain/rules-version.ts");
  await db.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,'{}',$3) on conflict do nothing", [`O-${id}`, `Объект ${id}`, now()]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, rules_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$6)", [id, `O-${id}`, status, version, RULES_VERSION, now()]);
}
async function check(id: string, insp: string, code = "M-002", finding = "CANDIDATE", group = `g-${id}`): Promise<void> {
  await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, review_priority, reason, computed_in_version, created_at, updated_at)
      values ($1,$2,$3,$4,$5,'PENDING','100','130','HIGH','ПД 100 ≠ РД 130',1,$6,$6)`, [id, insp, code, group, finding, now()]);
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  await app.ready();
  for (const [who, login] of [["insp", "inspector"], ["sup", "supervisor"], ["adm", "admin"], ["ml", "ml"], ["cur", "curator"]])
    tok[who] = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: "test-pass" } })).json().token;
  // T-233: паспорт М-041 (geometry) — в data/seed/passports/draft/ до цифр замера; тесты норм идут через вид geometry, поэтому
  // паспорт добавляется в загруженное хранилище только в этом файле (загрузчик draft/ не читает)
  const { passports } = await import("../src/services/passports.ts");
  const { ParamPassport } = await import("../src/domain/passport.ts");
  const { config } = await import("../src/config.ts");
  passports().byCode.set("M-041", ParamPassport.parse(JSON.parse(readFileSync(join(config.root, "data/seed/passports/draft/M-041.json"), "utf8"))));
});
afterAll(async () => {
  (await import("../src/services/passports.ts")).resetPassportsForTests();
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("схема: 128 полей ТЗ §10 (TZA-10-01…16)", () => {
  it("каждое из 128 полей 16 таблиц ТЗ — колонка схемы (таблица или представление ML_Retraining_Log)", async () => {
    const cols = new Set((await db.all("select table_name t, column_name c from information_schema.columns where table_schema = current_schema()")).map((r: any) => `${r.t}.${r.c}`));
    const fields = TZ10.flatMap((t) => t.fields.map(([f, c]) => ({ tz: `${t.tz}.${f}`, col: `${t.table}.${c}` })));
    expect(fields).toHaveLength(128);
    expect(TZ10).toHaveLength(16);
    expect(fields.filter((f) => !cols.has(f.col)).map((f) => `${f.tz} → ${f.col}`)).toEqual([]);
  });
  it("генерируемые колонки совпадают с предметными правилами: completeness_status — completenessStatus, file_path — blobFilePath", async () => {
    const { completenessStatus } = await import("../src/domain/protocol.ts");
    const { blobFilePath } = await import("../src/domain/blob-crypto.ts");
    await inspection("GEN");
    const statuses = ["NEGATIVE_VERIFIED", "CANDIDATE", "MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"];
    for (const [i, s] of statuses.entries()) await check(`GEN-${i}`, "GEN", `M-00${i + 1}`, s);
    const rows = await db.all("select finding_status, completeness_status from checks where inspection_id = 'GEN' order by id");
    expect(rows.map((r: any) => r.completeness_status)).toEqual(rows.map((r: any) => completenessStatus(r.finding_status)));
    await db.run("update checks set finding_status = 'MISSING_EVIDENCE' where id = 'GEN-1'");
    expect((await one("select completeness_status from checks where id = 'GEN-1'")).completeness_status).toBe("MISSING_EVIDENCE");
    const sha = "c".repeat(64);
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, uploaded_at)
        values ('GEN-F','GEN','O-GEN','f1','a.pdf',$1,1,'pdf','PD','100-АР','1',$2)`, [sha, now()]);
    expect((await one("select file_path from files where id = 'GEN-F'")).file_path).toBe(blobFilePath(sha));
    expect(await sqlState(db.run("update files set file_path = 'x' where id = 'GEN-F'"))).not.toBeNull(); // генерируемую не записать
  });
  it("ссылки проверки, фрагмента и протокола заполняет база из родительской строки и держит согласованными", async () => {
    await inspection("REF");
    await check("REF-1", "REF", "M-041");
    await db.run("insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, computed_in_version, created_at, updated_at, object_id, param_id) values ('REF-SD','REF','SD-001','g-sd','CANDIDATE',1,$1,$1,'O-GEN',1)", [now()]);
    expect(await one("select c.object_id, c.param_id = p.id same from checks c join params p on p.code = 'M-041' where c.id = 'REF-1'")).toEqual({ object_id: "O-REF", same: true });
    expect(await one("select object_id, param_id from checks where id = 'REF-SD'")).toEqual({ object_id: "O-REF", param_id: null }); // код вне Матрицы; подсунутые ссылки не приняты
    await db.run("insert into evidence_fragments (check_id, file_id, stage, sheet_page) values ('REF-1','F','PD',1)");
    expect((await one("select evidence_group_id from evidence_fragments where check_id = 'REF-1'")).evidence_group_id).toBe("g-REF-1");
    await db.run("update checks set evidence_group_id = 'g-new' where id = 'REF-1'");
    expect((await one("select evidence_group_id from evidence_fragments where check_id = 'REF-1'")).evidence_group_id).toBe("g-new");
    await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ('REF', 1, 'DRAFT', '{}', $1)", [now()]);
    expect((await one("select object_id from protocols where inspection_id = 'REF'")).object_id).toBe("O-REF");
  });
});

describe("Rejection_Log.retraining_status (OS-INSP-4.1.6, 6.1)", () => {
  it("журнал только дописывается: прочие колонки и удаление — 42501; статус — один раз из PENDING", async () => {
    const id = (await db.run("insert into rejection_log (check_id, inspection_id, param_code, ai_verdict, reason_code, comment, suggested_fix, user_id, created_at) values ('RJ','I','M-1','CANDIDATE','OCR_ERROR','к','ф','u-insp',$1) returning id", [now()])).rows[0].id;
    expect((await one("select retraining_status from rejection_log where id = $1", [id])).retraining_status).toBe("PENDING");
    expect(await sqlState(db.run("update rejection_log set comment = 'подмена' where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.run("update rejection_log set retraining_status = 'INCLUDED' where id = $1", [id]))).toBe("23514"); // без версии набора
    expect(await sqlState(db.run("update rejection_log set retraining_status = 'INCLUDED', retraining_dataset = 'gold-x', retraining_at = now() where id = $1", [id]))).toBeNull();
    expect(await sqlState(db.run("update rejection_log set retraining_status = 'SUPERSEDED', retraining_dataset = null where id = $1", [id]))).toBe("42501");
    expect(await sqlState(db.run("delete from rejection_log where id = $1", [id]))).toBe("42501");
  });
  it("снятие решения-отклонения (возврат) переводит запись журнала в SUPERSEDED; новое отклонение — новая запись PENDING", async () => {
    await inspection("RJ");
    await check("RJ-1", "RJ");
    expect((await call("insp", "POST", "/api/v1/checks/RJ-1/decision", { action: "reject", reason_code: "OCR_ERROR", comment: "цифра не та" })).statusCode).toBe(200);
    expect((await call("insp", "POST", "/api/v1/checks/RJ-1/reopen")).statusCode).toBe(200);
    expect((await call("insp", "POST", "/api/v1/checks/RJ-1/decision", { action: "reject", reason_code: "BINDING_ERROR", comment: "не тот якорь" })).statusCode).toBe(200);
    expect(await db.all("select reason_code, retraining_status from rejection_log where check_id = 'RJ-1' order by id")).toEqual([
      { reason_code: "OCR_ERROR", retraining_status: "SUPERSEDED" }, { reason_code: "BINDING_ERROR", retraining_status: "PENDING" },
    ]);
    const logs = (await call("sup", "GET", "/api/v1/inspection/RJ/feedback-logs")).json();
    expect(logs.rejections.map((r: any) => r.retraining_status)).toEqual(["SUPERSEDED", "PENDING"]);
  });
  it("отчёт по дообучению строится по журналу отклонений: снятые не считаются, статусы дообучения — сводкой", async () => {
    const { buildRetrainingReport } = await import("../src/services/report.ts");
    const r = await buildRetrainingReport(db, "2000-01-01T00:00:00Z");
    expect(r.by_reason.find((x: any) => x.reason_code === "BINDING_ERROR")).toMatchObject({ n: 1 });
    expect(r.by_reason.find((x: any) => x.reason_code === "OCR_ERROR")).toMatchObject({ n: 1 }); // из двух OCR_ERROR одно снято возвратом — не считается
    expect(r.retraining).toMatchObject({ PENDING: 1, SUPERSEDED: 1, INCLUDED: 1 });
    expect(r.by_param.find((x: any) => x.param_code === "M-002")).toMatchObject({ n: 1 });
  });
});

describe("Dispute_Log.resolution_status, resolved_by (OS-INSP-4.1.7, 4.1.29)", () => {
  it("закрытие спора: надзор с исходом и комментарием, аудит DISPUTE_RESOLVED; инспектору — 403; повтор — 409; журнал неизменяем", async () => {
    await inspection("DS");
    await check("DS-1", "DS");
    expect((await call("insp", "POST", "/api/v1/checks/DS-1/decision", { action: "clarify", comment: "нет листа 3" })).statusCode).toBe(200);
    const d = await one("select id, resolution_status, resolved_by from dispute_log where check_id = 'DS-1'");
    expect(d).toMatchObject({ resolution_status: "OPEN", resolved_by: null });
    expect((await call("insp", "POST", `/api/v1/disputes/${d.id}/resolve`, { resolution_status: "AI_UPHELD", comment: "x" })).statusCode).toBe(403);
    expect((await call("sup", "POST", `/api/v1/disputes/${d.id}/resolve`, { resolution_status: "AI_UPHELD", comment: " " })).statusCode).toBe(400);
    expect((await call("sup", "POST", "/api/v1/disputes/999999/resolve", { resolution_status: "WITHDRAWN" })).statusCode).toBe(404);
    const r = await call("sup", "POST", `/api/v1/disputes/${d.id}/resolve`, { resolution_status: "INSPECTOR_UPHELD", comment: "лист 3 в РД есть, ИИ не нашёл" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: Number(d.id), resolution_status: "INSPECTOR_UPHELD", resolved_by: "u-sup" });
    expect((await call("sup", "POST", `/api/v1/disputes/${d.id}/resolve`, { resolution_status: "WITHDRAWN" })).statusCode).toBe(409);
    expect(await one("select count(*)::int n from audit_log where action = 'DISPUTE_RESOLVED' and object_id = 'DS-1'")).toEqual({ n: 1 });
    const sup = (await call("sup", "GET", "/api/v1/inspection/DS/feedback-logs")).json().disputes[0];
    expect(sup).toMatchObject({ resolution_status: "INSPECTOR_UPHELD", resolved_by: "u-sup", resolved_by_name: "Петров Д. В.", resolution_comment: "лист 3 в РД есть, ИИ не нашёл" });
    expect(sup.resolved_at).toBeTruthy();
    const ml = (await call("ml", "GET", "/api/v1/ml/feedback-logs")).json().disputes.find((x: any) => x.check_id === "DS-1");
    expect(ml).toMatchObject({ resolution_status: "INSPECTOR_UPHELD", resolved_by: "u-sup" });
    expect(ml.resolved_by_name).toBeUndefined(); // R2-1: ML-ролям — без имён людей
    expect(await sqlState(db.run("update dispute_log set resolution_status = 'OPEN', resolved_by = null, resolved_at = null where id = $1", [d.id]))).toBe("42501");
    expect(await sqlState(db.run("update dispute_log set inspector_comment = 'подмена' where id = $1", [d.id]))).toBe("42501");
  });
});

describe("GOLD из журнала отклонений, Dataset_Items и ML_Retraining_Log (OS-INSP-6.1, 6.3, ADR-0011)", () => {
  let version = "";
  it("выпуск набора: отрицательные метки — из журнала отклонений, вошедшие записи — INCLUDED с версией набора", async () => {
    for (let i = 0; i < 12; i++) {
      await inspection(`GD-${i}`, "VERIFYING");
      await check(`GD-${i}-N`, `GD-${i}`, "M-003");
      await check(`GD-${i}-P`, `GD-${i}`, "M-004");
      for (const c of [`GD-${i}-N`, `GD-${i}-P`]) await db.run("insert into evidence_fragments (check_id, file_id, stage, sheet_page, bbox_polygon_norm) values ($1,'F','PD',1,'[0.1,0.1,0.2,0.2]')", [c]);
      expect((await call("insp", "POST", `/api/v1/checks/GD-${i}-N/decision`, { action: "reject", reason_code: "WITHIN_TOLERANCE", comment: "в допуске" })).statusCode).toBe(200);
      expect((await call("insp", "POST", `/api/v1/checks/GD-${i}-P/decision`, { action: "confirm" })).statusCode).toBe(200);
      await db.run("update inspections set status = 'FINALIZED' where id = $1", [`GD-${i}`]);
    }
    const r = await call("cur", "POST", "/api/v1/ml/gold/release");
    expect(r.statusCode).toBe(200);
    version = r.json().dataset_version;
    expect(r.json().rejections_included).toBe(12);
    expect(await db.all("select distinct retraining_status, retraining_dataset from rejection_log where check_id like 'GD-%'")).toEqual([{ retraining_status: "INCLUDED", retraining_dataset: version }]);
    expect(await one("select count(*)::int n from dataset_items where dataset_version = $1 and gold_label = 'NEGATIVE' and reason_code = 'WITHIN_TOLERANCE' and expert_id = 'u-insp'", [version])).toEqual({ n: 12 });
  });
  it("элементы версии набора: доказательная группа, эксперт, причина, выборка и фрагменты группы; сводка годности", async () => {
    expect((await call("insp", "GET", `/api/v1/ml/datasets/${version}/items`)).statusCode).toBe(403);
    expect((await call("ml", "GET", "/api/v1/ml/datasets/nope/items")).statusCode).toBe(404);
    const r = (await call("ml", "GET", `/api/v1/ml/datasets/${version}/items?limit=500`)).json();
    expect(r.summary).toMatchObject({ items: 24, experts: 1, evidence_groups: 24, issues: [], by_reason: [{ reason_code: "WITHIN_TOLERANCE", n: 12 }] });
    const n = r.items.find((i: any) => i.finding_id === "GD-0-N");
    expect(n).toMatchObject({ evidence_group_id: "g-GD-0-N", gold_label: "NEGATIVE", expert_id: "u-insp", reason_code: "WITHIN_TOLERANCE", object_group_id: "O-GD-0", fragments: 1 });
  });
  it("дообучение не идёт на наборе, где доказательная группа попала в две выборки", async () => {
    await db.run("insert into dataset_versions (dataset_version, split_hashes_json, items, positives, negatives, created_by, created_at) values ('leak', '{}', 2, 1, 1, 'u-cur', $1)", [now()]);
    for (const [f, s] of [["GD-0-N", "train"], ["GD-0-P", "test"]]) await db.run("insert into dataset_items (dataset_version, evidence_group_id, finding_id, gold_label, expert_id, split, object_group_id) values ('leak','g-shared',$1,'NEGATIVE','u-insp',$2,'O')", [f, s]);
    const { datasetIssues } = await import("../src/domain/gold.ts");
    const { datasetItems } = await import("../src/services/retrain.ts");
    expect(datasetIssues(await datasetItems(db, "leak"))).toEqual(["доказательная группа в нескольких выборках: g-shared"]);
  });
  it("регистрация модели пишет журнал дообучения: хеши выборок из выпуска, метрики по категориям; журнал — полями ТЗ", async () => {
    const metrics = { precision: 0.93, recall: 0.86, f1: 0.89, false_positive_rate: 0.04, recall_by_category: { АР: 0.9, КР: 0.84 } };
    expect((await call("ml", "POST", "/api/v1/ml/models", { model_version: "tz-a", artifact_hash: "h-a", dataset_version: version, metrics })).json().gate.ok).toBe(true);
    const ds = await one("select split_hashes_json from dataset_versions where dataset_version = $1", [version]);
    const m = await one("select split_hashes_json, per_category_metrics_json, trained_by from model_versions where model_version = 'tz-a'");
    expect(JSON.parse(m.split_hashes_json)).toEqual(JSON.parse(ds.split_hashes_json));
    expect(JSON.parse(m.per_category_metrics_json)).toEqual({ АР: { recall: 0.9 }, КР: { recall: 0.84 } });
    expect(m.trained_by).toBe("u-ml");
    const log = (await call("ml", "GET", "/api/v1/ml/retraining-log")).json().find((x: any) => x.model_version === "tz-a");
    expect(log).toMatchObject({ dataset_version: version, precision: 0.93, recall: 0.86, f1: 0.89, false_positive_rate: 0.04, approval_status: "AWAITING_APPROVAL", approved_by: null });
    expect(JSON.parse(log.per_category_metrics)).toEqual({ АР: { recall: 0.9 }, КР: { recall: 0.84 } });
    expect((await call("insp", "GET", "/api/v1/ml/retraining-log")).statusCode).toBe(403);
  });
  it("публикация: хеши выборок модели сверяются с выпуском набора; прежняя действующая — SUPERSEDED", async () => {
    await db.run("insert into model_versions (model_version, dataset_version, metrics_json, approval_status, created_at, split_hashes_json) values ('tz-bad', $1, '{}', 'AWAITING_APPROVAL', $2, $3)",
      [version, now(), JSON.stringify({ train: "x", validation: "y", test: "z" })]);
    expect((await call("sup", "POST", "/api/v1/ml/models/tz-bad/approve")).statusCode).toBe(409);
    expect((await call("sup", "POST", "/api/v1/ml/models/tz-a/approve")).json()).toMatchObject({ ok: true });
    const metrics = { precision: 0.94, recall: 0.87, f1: 0.9, false_positive_rate: 0.04, recall_by_category: { АР: 0.9, КР: 0.83 } }; // КР −1 п.п. к журналу tz-a — ворота открыты
    expect((await call("ml", "POST", "/api/v1/ml/models", { model_version: "tz-b", artifact_hash: "h-b", dataset_version: version, metrics })).json().gate.ok).toBe(true);
    expect((await call("sup", "POST", "/api/v1/ml/models/tz-b/approve")).json()).toEqual({ ok: true, rollback_to: "tz-a" });
    expect(await db.all("select model_version, approval_status, rollback_to from model_versions where model_version in ('tz-a','tz-b') order by model_version")).toEqual([
      { model_version: "tz-a", approval_status: "SUPERSEDED", rollback_to: expect.any(String) }, { model_version: "tz-b", approval_status: "PUBLISHED", rollback_to: "tz-a" },
    ]);
    const list = (await call("ml", "GET", "/api/v1/ml/models")).json();
    expect(list.find((x: any) => x.model_version === "tz-b")).toMatchObject({ approved_by: "u-sup", approved_by_name: "Петров Д. В.", artifact_hash: "h-b" });
  });
  it("откат модели (OS-INSP-6.3.3): только действующая, только надзор, с причиной; цель — снова в контуре, meta — цель", async () => {
    expect((await call("ml", "POST", "/api/v1/ml/models/tz-b/rollback", { reason: "рост FPR в эксплуатации" })).statusCode).toBe(403);
    expect((await call("sup", "POST", "/api/v1/ml/models/tz-b/rollback", {})).statusCode).toBe(400);
    expect((await call("sup", "POST", "/api/v1/ml/models/tz-a/rollback", { reason: "не действующая" })).statusCode).toBe(409);
    expect((await call("sup", "POST", "/api/v1/ml/models/nope/rollback", { reason: "нет такой" })).statusCode).toBe(404);
    const r = await call("sup", "POST", "/api/v1/ml/models/tz-b/rollback", { reason: "рост FPR в эксплуатации" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, rolled_back: "tz-b", model_version: "tz-a" });
    expect(await db.all("select model_version, approval_status from model_versions where model_version in ('tz-a','tz-b') order by model_version")).toEqual([
      { model_version: "tz-a", approval_status: "PUBLISHED" }, { model_version: "tz-b", approval_status: "ROLLED_BACK" },
    ]);
    expect((await one("select value from meta where key = 'model_version'")).value).toBe("tz-a");
    expect((await one("select deployed_at from model_versions where model_version = 'tz-a'")).deployed_at).toBeTruthy();
    expect(await one("select count(*)::int n from audit_log where action = 'MODEL_ROLLED_BACK' and object_id = 'tz-b'")).toEqual({ n: 1 });
    expect((await call("sup", "POST", "/api/v1/ml/models/tz-b/rollback", { reason: "повтор" })).statusCode).toBe(409);
  });
  it("действующая модель применяется, только если хеш весов совпадает с artifact_hash реестра", async () => {
    const { publishedRanking } = await import("../src/services/retrain.ts");
    const { weightsHash } = await import("../src/domain/retrain.ts");
    const model = { algorithm: "logreg-v1", features: ["x"], weights: [0.5], platt: { a: 1, b: 0 }, threshold: 0.5 };
    await db.run("insert into model_versions (model_version, artifact_hash, metrics_json, approval_status, created_at, weights_json, deployed_at) values ('tz-w', $1, '{}', 'PUBLISHED', $2, $3, $2)", ["0".repeat(64), now(), JSON.stringify(model)]);
    await db.run("update meta set value = 'tz-w' where key = 'model_version'");
    expect(await publishedRanking(db)).toBeNull();
    expect(await one("select count(*)::int n from audit_log where action = 'MODEL_ARTIFACT_MISMATCH' and object_id = 'tz-w'")).toEqual({ n: 1 });
    await db.run("update model_versions set artifact_hash = $1 where model_version = 'tz-w'", [weightsHash(model as any)]);
    expect(await publishedRanking(db)).toMatchObject({ threshold: 0.5 });
    await db.run("update meta set value = 'tz-a' where key = 'model_version'");
  });
});

describe("Normative_Base — один источник норм (OS-INSP-7.2.3, 7.2.4)", () => {
  it("нормы CMP-06 сида norms.json — в таблице; повторное наполнение не дублирует и не перезаписывает правку", async () => {
    const { syncNormBase } = await import("../src/db.ts");
    const { config } = await import("../src/config.ts");
    const base = JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")).base as Array<{ id: string }>;
    expect(await one("select count(*)::int n from normative_base where norm_key is not null")).toEqual({ n: base.length });
    await db.run("update normative_base set min_value = 0.75 where norm_key = 'evac-door-width'");
    expect(await syncNormBase(db)).toBe(0);
    expect((await one("select min_value from normative_base where norm_key = 'evac-door-width'")).min_value).toBe(0.75);
    await db.run("update normative_base set min_value = 0.8 where norm_key = 'evac-door-width'");
  });
  it("правка нормы администратором доходит до расчёта: предел CMP-06 из normative_base, параметр пересчитан сразу", async () => {
    const { recomputeParams, loadNormBase } = await import("../src/services/inspections.ts");
    await inspection("NB", "READY", 1);
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, parse_status, revision_role, uploaded_at)
        values ('NB-F','NB','O-NB','f1','АР1.pdf',$1,1,'pdf','RD','АР','100-АР1','1','DONE','CURRENT',$2)`, ["d".repeat(64), now()]);
    await db.run(`insert into extractions (file_id, param_code, kind, raw, value_num, page, bbox_json, line_text, confidence)
        values ('NB-F','M-041','param','0,85',0.85,2,'[0.1,0.1,0.2,0.12]','Ширина эвакуационного выхода 0,85 м',0.9)`);
    expect(await recomputeParams(db, "NB", ["M-041"])).toBe(true);
    const before = await one("select finding_status, expected_value from checks where inspection_id = 'NB' and param_code = 'M-041'");
    expect(before.finding_status).not.toBe("CANDIDATE"); // 0,85 м ≥ 0,8 м
    const norm = await one("select id from normative_base where norm_key = 'evac-door-width'");
    expect((await call("adm", "PATCH", `/api/v1/normative/${norm.id}`, { effective_from: "2026-01-01", effective_to: "2025-01-01" })).statusCode).toBe(400);
    const r = await call("adm", "PATCH", `/api/v1/normative/${norm.id}`, { min_value: 0.9 });
    expect(r.statusCode).toBe(200);
    expect(r.json().recomputed).toContain("NB");
    expect((await loadNormBase(db)).find((n) => n.id === "evac-door-width")).toMatchObject({ min: 0.9 });
    const after = await one("select finding_status, expected_value from checks where inspection_id = 'NB' and param_code = 'M-041'");
    expect(after).toMatchObject({ finding_status: "CANDIDATE", expected_value: expect.stringMatching(/0,9 м/) });
    // выключить норму — сравнение с нормой не выполняется
    expect((await call("adm", "PATCH", `/api/v1/normative/${norm.id}`, { is_active: false })).statusCode).toBe(200);
    expect((await one("select finding_status from checks where inspection_id = 'NB' and param_code = 'M-041'")).finding_status).not.toBe("CANDIDATE");
    await call("adm", "PATCH", `/api/v1/normative/${norm.id}`, { is_active: true, min_value: 0.8 });
  });
  it("нормативный анализ гипотез учитывает срок действия нормы: норма, не действующая на дату пересчёта, гипотезу не даёт", async () => {
    const legacy = await one("select id from normative_base where norm_key is null and param_code = 'M-041'");
    expect((await call("adm", "PATCH", `/api/v1/normative/${legacy.id}`, { min_value: 0.9 })).json().recomputed).toContain("NB");
    expect(await one("select count(*)::int n from suspicions where inspection_id = 'NB' and dedup_key = 'NORM:M-041:RD'")).toEqual({ n: 1 });
    await db.run("delete from suspicions where inspection_id = 'NB'");
    expect((await call("adm", "PATCH", `/api/v1/normative/${legacy.id}`, { effective_to: "2020-12-31" })).statusCode).toBe(200);
    expect(await one("select count(*)::int n from suspicions where inspection_id = 'NB' and dedup_key = 'NORM:M-041:RD'")).toEqual({ n: 0 });
    await call("adm", "PATCH", `/api/v1/normative/${legacy.id}`, { effective_to: null, min_value: 0.8 });
  });
});

describe("Params: ссылки СП, ГОСТ, ФЗ (OS-INSP-7.1.25) и Protocols.object_id (OS-INSP-8.1.8)", () => {
  it("ссылки заполнены из Матрицы, паспортов и справочника норм и показаны в паспорте параметра; правку администратора наполнение не трогает", async () => {
    const ref = async (code: string) => one("select sp_reference, gost_reference, fz_reference, other_normative from params where code = $1", [code]);
    expect((await ref("M-040")).sp_reference).toContain("СП 1.13130.2020");
    expect((await ref("M-056")).gost_reference).toContain("ГОСТ 27772-2015");
    expect((await ref("M-022")).fz_reference).toContain("123-ФЗ");
    expect((await ref("M-009")).other_normative).toContain("Постановление Правительства РФ № 87");
    const filled = await one("select count(*) filter (where sp_reference is not null)::int sp, count(*) filter (where gost_reference is not null)::int gost, count(*) filter (where fz_reference is not null)::int fz from params");
    expect(filled.sp).toBeGreaterThan(30);
    expect(filled.gost).toBeGreaterThan(5);
    expect(filled.fz).toBeGreaterThan(5);
    const p = (await call("insp", "GET", "/api/v1/params/M-056/passport")).json().param;
    expect(p.gost_reference).toContain("ГОСТ 27772-2015");
    const { seedParamRefs } = await import("../src/db.ts");
    await db.run("update params set sp_reference = 'Ручная ссылка' where code = 'M-040'");
    await db.run("update meta set value = '0' where key = 'params_refs_seed'");
    await seedParamRefs(db);
    expect((await ref("M-040")).sp_reference).toBe("Ручная ссылка");
    expect(await seedParamRefs(db)).toBe(0); // версия наполнения записана — повтор ничего не делает
  });
  it("карточка объекта: версии протоколов всех проверок объекта — по Protocols.object_id", async () => {
    await inspection("PR-1");
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ('PR-2','O-PR-1','READY',1,$1,$1)", [now()]);
    for (const i of ["PR-1", "PR-2"]) await db.run("insert into protocols (inspection_id, version, status, body_json, created_at, matrix_version) values ($1, 1, 'DRAFT', '{}', $2, '1.1.2')", [i, now()]);
    const card = (await call("insp", "GET", "/api/v1/objects/O-PR-1")).json();
    expect(card.protocols.map((p: any) => p.inspection_id).sort()).toEqual(["PR-1", "PR-2"]);
    expect(card.protocols[0]).toMatchObject({ version: 1, status: "DRAFT", matrix_version: "1.1.2" });
  });
});
