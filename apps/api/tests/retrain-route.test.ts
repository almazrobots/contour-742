// T-100: управляемое дообучение модели ранжирования (OS-INSP-6.4.4–6.4.9, ТЗ §7.4, §9.4).
// L2 — контракт маршрута, L4 — интеграция с БД: выпуск набора → обучение → ворота → подпись → оценка кандидатов.
// Без ML-сервиса; данные — синтетика в БД в памяти. Имя теста — ссылка трассы.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-retrain-"));
let app: any;
let db: any;
let tok: Record<string, string> = {};
let datasetVersion = "";
let recompute: typeof import("../src/services/inspections.ts").recompute;
let splitHashes: typeof import("../src/domain/retrain.ts").splitHashes;
let trainingCodeHash: typeof import("../src/services/retrain.ts").trainingCodeHash;

const now = () => new Date().toISOString();
const N_OBJECTS = 80;

/** Финализированные проверки: у каждого объекта подтверждённое нарушение (расхождение 30–60 %) и отклонённый кандидат (≤ 2 %). */
async function seedFinalized(): Promise<void> {
  await db.tx(async (t: any) => {
    for (let i = 0; i < N_OBJECTS; i++) {
      const o = `RT-OBJ-${i}`;
      await t.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", [o, `Объект ${i}`, "{}", now()]);
      await t.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", [`RT-P-${i}`, o, "FINALIZED", 1, now(), now()]);
      const cases: Array<[string, string, string, number]> = [["pos", i % 2 ? "M-004" : "M-003", "CONFIRMED_VIOLATION", 30 + (i % 31)], ["neg", i % 2 ? "M-003" : "M-004", "NEGATIVE_VERIFIED", i % 3]];
      for (const [kind, code, vs, dev] of cases) {
        const id = `RT-${kind}-${i}`;
        await t.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
            review_priority, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, `RT-P-${i}`, code, `${o}:${code}`, "CANDIDATE", vs, "100", String(100 + dev), `+${dev}`, "HIGH", 1, now(), now()]);
        const frag = "insert into evidence_fragments (check_id, file_id, stage, sheet_page, bbox_polygon_norm) values ($1,$2,$3,$4,$5)";
        await t.run(frag, [id, `RT-F-${i}-PD`, "PD", 1, "[0.1,0.1,0.2,0.2]"]);
        await t.run(frag, [id, `RT-F-${i}-RD`, "RD", 2, "[0.1,0.1,0.2,0.2]"]);
        await t.run("insert into decisions (check_id, user_id, action, status, reason_code, created_at) values ($1,$2,$3,$4,$5,$6)",
          [id, "u-insp", kind === "pos" ? "confirm" : "reject", vs, kind === "pos" ? null : "OCR_ERROR", now()]);
      }
    }
  });
}

/**
 * Набор в обход выпуска — для отказов: метки задаёт тест, хеши выборок — как при выпуске. Объект — из выпуска
 * (T-137, OS-INSP-6.1.9: общий объект у validation и test — пересечение со скрытой выборкой, отказ в подборе порога).
 */
async function craftDataset(version: string, items: Array<{ finding_id: string; gold_label: string; split: string; object_group_id?: string }>, hashes = splitHashes(items as any)): Promise<void> {
  await db.run("insert into dataset_versions (dataset_version, split_hashes_json, items, positives, negatives, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7)", [
    version, JSON.stringify(hashes), items.length, items.filter((i) => i.gold_label === "POSITIVE").length, items.filter((i) => i.gold_label === "NEGATIVE").length, "u-cur", now()]);
  for (const i of items) {
    await db.run("insert into dataset_items (dataset_version, evidence_group_id, finding_id, gold_label, expert_id, reason_code, split, object_group_id) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [version, `g-${i.finding_id}`, i.finding_id, i.gold_label, "u-insp", null, i.split, i.object_group_id ?? "o"]);
  }
}

const releasedItems = (): Promise<Array<{ finding_id: string; gold_label: string; split: string; object_group_id: string }>> =>
  db.all("select finding_id, gold_label, split, object_group_id from dataset_items where dataset_version = $1 order by id", [datasetVersion]);

const call = (method: string, url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${tok[who]}` } });
const trainReq = (body: unknown, who = "ml") => call("POST", "/api/v1/ml/models/train", who, body);
const row = (v: string) => db.get("select * from model_versions where model_version = $1", [v]);
const auditCount = async (action: string) => ((await db.get("select count(*) n from audit_log where action = $1", [action])) as { n: number }).n;
const modelCount = async () => ((await db.get("select count(*) n from model_versions")) as { n: number }).n;
const metaValue = async (key: string) => ((await db.get("select value from meta where key = $1", [key])) as { value: string }).value;

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  ({ recompute } = await import("../src/services/inspections.ts"));
  ({ splitHashes } = await import("../src/domain/retrain.ts"));
  ({ trainingCodeHash } = await import("../src/services/retrain.ts"));
  db = await openDb("memory");
  app = await buildApp(db);
  for (const [who, login] of [["ml", "ml"], ["cur", "curator"], ["sup", "supervisor"], ["insp", "inspector"]])
    tok[who] = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: "test-pass" } })).json().token;
  await seedFinalized();
  const rel = await call("POST", "/api/v1/ml/gold/release", "cur");
  expect(rel.statusCode).toBe(200);
  datasetVersion = rel.json().dataset_version;
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

let first = "";

describe("OS-INSP-6.4.4 запуск дообучения по выпущенной dataset_version", () => {
  it("ML-инженер обучает модель по выпущенному набору: 201, метрики test и размеры выборок", async () => {
    const r = await trainReq({ dataset_version: datasetVersion });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    first = b.model_version;
    expect(b.model_version).toMatch(/^rank-\d{4}-\d{2}-\d{2}-v\d+$/);
    expect(b.metrics).toMatchObject({ precision: 1, recall: 1, f1: 1, false_positive_rate: 0, roc_auc: 1 });
    const s = b.metrics.sizes;
    expect(s.train.n + s.validation.n + s.test.n).toBe(2 * N_OBJECTS);
    for (const k of ["train", "validation", "test"]) expect(s[k].positives).toBe(s[k].negatives);
    expect(await auditCount("MODEL_TRAINED")).toBe(1);
  });

  it("обучение — только ML-инженер; неизвестный набор — 404; некорректные параметры — 400", async () => {
    expect((await trainReq({ dataset_version: datasetVersion }, "insp")).statusCode).toBe(403);
    expect((await trainReq({ dataset_version: datasetVersion }, "cur")).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/ml/models/train", payload: { dataset_version: datasetVersion } })).statusCode).toBe(401);
    expect((await trainReq({ dataset_version: "gold-нет" })).statusCode).toBe(404);
    expect((await trainReq({ dataset_version: datasetVersion, params: { l2: -1 } })).statusCode).toBe(400);
    expect((await trainReq({ dataset_version: datasetVersion, params: { max_iter: 0 } })).statusCode).toBe(400);
    expect((await trainReq({})).statusCode).toBe(400);
  });

  it("состав набора расходится с выпущенным — отказ 409 без записи итерации", async () => {
    await craftDataset("gold-broken", await releasedItems(), { train: "0", validation: "0", test: "0" } as any);
    const before = await modelCount();
    const r = await trainReq({ dataset_version: "gold-broken" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("расходится с выпущенным");
    expect(await modelCount()).toBe(before);
  });
});

describe("OS-INSP-6.4.5 реестр итерации", () => {
  it("итерация хранит model_version, dataset_version, matrix_version, хеши выборок, хеш кода, параметры и seed, метрики по категориям, предыдущую модель и того, кто запустил", async () => {
    const m = await row(first);
    expect(m.dataset_version).toBe(datasetVersion);
    expect(m.matrix_version).toBe(await metaValue("matrix_version"));
    const ds = await db.get("select split_hashes_json from dataset_versions where dataset_version = $1", [datasetVersion]);
    expect(JSON.parse(m.split_hashes_json)).toEqual(JSON.parse(ds.split_hashes_json));
    // исходник модуля обучения из корня проекта (в песочнице Stryker корень тот же — хеш сверяется с тем, что читает сервис)
    const { config } = await import("../src/config.ts");
    const src = readFileSync(join(config.root, "apps/api/src/domain/retrain.ts"), "utf8");
    expect(m.training_code_hash).toBe(`src:${createHash("sha256").update(src).digest("hex")}:logreg-l2-newton+platt/1`);
    expect(trainingCodeHash()).toBe(m.training_code_hash);
    expect(JSON.parse(m.training_params_json)).toEqual({ l2: 1, max_iter: 50, min_recall: 0.8, seed: "v1" });
    expect(Object.keys(JSON.parse(m.per_category_metrics_json))).toEqual(["ПЗ"]);
    expect(JSON.parse(m.metrics_json).recall_by_category).toEqual({ ПЗ: 1 });
    expect(m.previous_model).toBe("dev-anchors-0.1");
    expect(m.trained_by).toBe("u-ml");
    expect(m.weights_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.artifact_hash).toBe(m.weights_hash);
    expect(JSON.parse(m.weights_json).features[0]).toBe("bias");
    expect(JSON.parse(m.gate_json)).toEqual({ ok: true, reasons: [] });
    const list = (await call("GET", "/api/v1/ml/models", "ml")).json();
    expect(list.find((x: any) => x.model_version === first)).toMatchObject({ trained_by: "u-ml", previous_model: "dev-anchors-0.1" });
  });
});

describe("OS-INSP-6.4.6 воспроизводимость итерации", () => {
  it("повторный запуск на том же наборе с теми же параметрами даёт тот же хеш весов", async () => {
    const r = await trainReq({ dataset_version: datasetVersion, params: { seed: "v1", l2: 1 } });
    expect(r.statusCode).toBe(201);
    expect(r.json().model_version).not.toBe(first);
    expect(r.json().weights_hash).toBe((await row(first)).weights_hash);
    const other = await trainReq({ dataset_version: datasetVersion, params: { l2: 10 } });
    expect(other.json().weights_hash).not.toBe((await row(first)).weights_hash);
    expect(JSON.parse((await row(other.json().model_version)).training_params_json).l2).toBe(10);
  });

  it("параллельные запуски обучения: разные номера версий, каждая итерация — со своей записью аудита", async () => {
    const before = await modelCount();
    const trained = await auditCount("MODEL_TRAINED");
    const rs = await Promise.all([1, 2, 3].map(() => trainReq({ dataset_version: datasetVersion })));
    expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(rs.map((r) => r.json().model_version)).size).toBe(3);
    expect(await modelCount()).toBe(before + 3);
    expect(await auditCount("MODEL_TRAINED")).toBe(trained + 3);
  });
});

describe("OS-INSP-6.4.8 отказ в дообучении без обоих классов", () => {
  it("в train нет отрицательных примеров — 422 с причиной, итерация не записана, отказ в аудите", async () => {
    await craftDataset("gold-only-pos", (await releasedItems()).filter((i) => i.split !== "train" || i.gold_label === "POSITIVE"));
    const before = await modelCount();
    const r = await trainReq({ dataset_version: "gold-only-pos" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("В train нет отрицательных примеров");
    expect(r.json().details.reasons).toEqual(["В train нет отрицательных примеров (отклонённых кандидатов) — модель не научится их различать"]);
    expect(await modelCount()).toBe(before);
    expect(await auditCount("MODEL_TRAINING_REFUSED")).toBe(1);
  });
  it("в train нет положительных примеров — 422 с причиной", async () => {
    await craftDataset("gold-only-neg", (await releasedItems()).filter((i) => i.split !== "train" || i.gold_label === "NEGATIVE"));
    const r = await trainReq({ dataset_version: "gold-only-neg" });
    expect(r.statusCode).toBe(422);
    expect(r.json().details.reasons).toEqual(["В train нет положительных примеров (подтверждённых нарушений) — модель не научится их различать"]);
  });
});

describe("OS-INSP-6.4.7 дообученная модель не публикуется автоматически", () => {
  it("после обучения модель ждёт подписи: действующая модель не меняется, ML-инженер подписать не может", async () => {
    expect((await row(first)).approval_status).toBe("AWAITING_APPROVAL");
    expect(await metaValue("model_version")).toBe("dev-anchors-0.1");
    expect(await db.get("select count(*) n from model_versions where approval_status = 'PUBLISHED'")).toEqual({ n: 0 });
    expect((await call("POST", `/api/v1/ml/models/${first}/approve`, "ml")).statusCode).toBe(403);
  });

  it("модель, не прошедшая ворота качества, блокируется и не подписывается", async () => {
    // метки не связаны с карточкой — модель не лучше монетки
    const noisy = (await releasedItems()).map((i) => ({ ...i, gold_label: createHash("sha256").update(i.finding_id).digest()[0] % 2 ? "POSITIVE" : "NEGATIVE" }));
    await craftDataset("gold-noise", noisy);
    const r = await trainReq({ dataset_version: "gold-noise" });
    expect(r.statusCode).toBe(201);
    expect(r.json().approval_status).toBe("REJECTED_BY_GATE");
    expect(r.json().gate.ok).toBe(false);
    expect(r.json().gate.reasons.length).toBeGreaterThan(0);
    expect(JSON.parse((await row(r.json().model_version)).gate_json).ok).toBe(false);
    expect((await call("POST", `/api/v1/ml/models/${r.json().model_version}/approve`, "sup")).statusCode).toBe(409);
  });

  it("после подписи ответственного модель опубликована со ссылкой отката", async () => {
    const r = await call("POST", `/api/v1/ml/models/${first}/approve`, "sup");
    expect(r.statusCode).toBe(200);
    expect(r.json().rollback_to).toBeNull();
    expect(await row(first)).toMatchObject({ approval_status: "PUBLISHED", approved_by: "u-sup", rollback_to: "dev-anchors-0.1" });
    expect(await metaValue("model_version")).toBe(first);
    // следующая итерация ссылается на опубликованную как на предыдущую и сверяется с ней воротами
    const next = await trainReq({ dataset_version: datasetVersion });
    expect(next.json().previous_model).toBe(first);
    expect(next.json().gate.ok).toBe(true);
  });
});

describe("OS-INSP-6.4.9 оценка вероятности нарушения кандидату", () => {
  it("при расчёте протокола опубликованная модель выставляет CANDIDATE оценку; статус и решение остаются за инспектором", async () => {
    // протокол проверки: M-004 ПД 100 → РД 150 (кандидат), M-007 10 = 10 (нарушения нет)
    await db.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", ["RT-LIVE", "Живой объект", "{}", now()]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", ["RT-LIVE-P", "RT-LIVE", "PARSING", 0, now(), now()]);
    for (const [st, v4] of [["PD", 100], ["RD", 150]] as const) {
      await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, revision_role, parse_status, uploaded_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [`RT-LIVE-${st}`, "RT-LIVE-P", "RT-LIVE", st, `${st}.pdf`, "0".repeat(64), 1, "pdf", st, `${st}-1`, "1", "CURRENT", "DONE", now()]);
      const ext = "insert into extractions (file_id, param_code, kind, raw, value_num, page, confidence) values ($1,$2,$3,$4,$5,$6,$7)";
      await db.run(ext, [`RT-LIVE-${st}`, "M-004", "param", String(v4), v4, 1, 0.95]);
      await db.run(ext, [`RT-LIVE-${st}`, "M-007", "param", "10", 10, 1, 0.95]);
    }
    await recompute(db, "RT-LIVE-P", new Set());
    const checks = await db.all("select param_code, finding_status, verification_status, ai_score from checks where inspection_id = 'RT-LIVE-P' and param_code in ('M-004', 'M-007') order by param_code");
    expect(checks[0]).toMatchObject({ param_code: "M-004", finding_status: "CANDIDATE", verification_status: "PENDING" });
    expect(checks[0].ai_score).toBeGreaterThan(0.5);
    expect(checks[0].ai_score).toBeLessThan(1);
    expect(checks[1]).toMatchObject({ param_code: "M-007", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", ai_score: null });
    expect(await db.get("select count(*) n from checks where inspection_id = 'RT-LIVE-P' and finding_status != 'CANDIDATE' and ai_score is not null")).toEqual({ n: 0 });
  });

  it("без опубликованной модели ранжирования оценки нет", async () => {
    const live = await metaValue("model_version");
    await db.run("update meta set value = 'dev-anchors-0.1' where key = 'model_version'");
    try {
      await recompute(db, "RT-LIVE-P", new Set());
      expect(await db.get("select count(*) n from checks where inspection_id = 'RT-LIVE-P' and ai_score is not null")).toEqual({ n: 0 });
      expect(((await db.get("select finding_status from checks where inspection_id = 'RT-LIVE-P' and param_code = 'M-004'")) as any).finding_status).toBe("CANDIDATE");
    } finally {
      await db.run("update meta set value = $1 where key = 'model_version'", [live]);
    }
  });
});
