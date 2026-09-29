// T-137: печать скрытого теста через API (OS-INSP-6.1.4–6.1.9, ТЗ 14.2-04, 9.4.2-03).
// L2 — контракт маршрутов (схема OpenAPI проверяется валидатором ответа), L4 — интеграция с БД (журналы только
// дописываются), L6 — отказы: метки в приёме, повторная печать, чужая роль, пересечение со скрытым тестом.
// Данные — синтетика в БД в памяти, без ML-сервиса. Имя теста — ссылка трассы model.yaml.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const TMP = mkdtempSync(join(tmpdir(), "inspector-hidden-seal-"));
let app: any;
let db: any;
let splitOf: typeof import("../src/domain/gold.ts").splitOf;
let splitHashes: typeof import("../src/domain/retrain.ts").splitHashes;
let blobStore: typeof import("../src/services/blobstore.ts").blobStore;
const tok: Record<string, string> = {};

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const h = (c: string) => c.repeat(64);
const now = () => new Date().toISOString();
const N_OBJECTS = 80;
const HIDDEN_OBJECTS = 5; // объекты 0..4 — в печати «gold-hidden»
const fileSha = (i: number) => sha(`hidden-seal-file-${i}`);

const call = (method: string, url: string, who: string | null, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any, headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });
const auditCount = async (action: string) => ((await db.get("select count(*) n from audit_log where action = $1", [action])) as { n: number }).n;
const sqlState = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e: any) {
    return e?.code ?? String(e);
  }
};

function multipart(fields: Record<string, string>, files: Array<{ name: string; buf: Buffer }>) {
  const boundary = "----seal" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const upload = (objectId: string, files: Array<{ name: string; buf: Buffer }>) => {
  const m = multipart({ object: JSON.stringify({ object_id: objectId, name: "Скрытый тест" }), start: "false" }, files);
  return app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${tok.insp}` } });
};

/** Финализированные проверки: у объекта файл пакета, подтверждённое нарушение и отклонённый кандидат (как в retrain-route). */
async function seedFinalized(): Promise<void> {
  await db.tx(async (t: any) => {
    for (let i = 0; i < N_OBJECTS; i++) {
      const o = `HS-OBJ-${i}`;
      await t.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", [o, `Объект ${i}`, "{}", now()]);
      await t.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", [`HS-P-${i}`, o, "FINALIZED", 1, now(), now()]);
      await t.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, uploaded_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [`HS-F-${i}`, `HS-P-${i}`, o, `HS-F-${i}`, `f${i}.pdf`, fileSha(i), 1, "pdf", "PD", `D-${i}`, "1", now()]);
      const cases: Array<[string, string, string, number]> = [["pos", i % 2 ? "M-004" : "M-003", "CONFIRMED_VIOLATION", 30 + (i % 31)], ["neg", i % 2 ? "M-003" : "M-004", "NEGATIVE_VERIFIED", i % 3]];
      for (const [kind, code, vs, dev] of cases) {
        const id = `HS-${kind}-${i}`;
        await t.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
            review_priority, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, `HS-P-${i}`, code, `${o}:${code}`, "CANDIDATE", vs, "100", String(100 + dev), `+${dev}`, "HIGH", 1, now(), now()]);
        const frag = "insert into evidence_fragments (check_id, file_id, sha256, stage, sheet_page, bbox_polygon_norm) values ($1,$2,$3,$4,$5,$6)";
        await t.run(frag, [id, `HS-F-${i}`, fileSha(i), "PD", 1, "[0.1,0.1,0.2,0.2]"]);
        await t.run(frag, [id, `HS-F-${i}`, fileSha(i), "RD", 2, "[0.1,0.1,0.2,0.2]"]);
        await t.run("insert into decisions (check_id, user_id, action, status, reason_code, created_at) values ($1,$2,$3,$4,$5,$6)",
          [id, "u-insp", kind === "pos" ? "confirm" : "reject", vs, kind === "pos" ? null : "OCR_ERROR", now()]);
      }
    }
  });
}

type Item = { finding_id: string; gold_label: string; split: string; object_group_id: string };
async function craftDataset(version: string, items: Item[]): Promise<void> {
  const hashes = splitHashes(items as any);
  await db.run("insert into dataset_versions (dataset_version, split_hashes_json, items, positives, negatives, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7)", [
    version, JSON.stringify(hashes), items.length, items.filter((i) => i.gold_label === "POSITIVE").length, items.filter((i) => i.gold_label === "NEGATIVE").length, "u-cur", now()]);
  for (const i of items) {
    await db.run("insert into dataset_items (dataset_version, evidence_group_id, finding_id, gold_label, expert_id, reason_code, split, object_group_id) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [version, `g-${i.finding_id}`, i.finding_id, i.gold_label, "u-insp", null, i.split, i.object_group_id]); // T-234: группа — своя у записи (OS-INSP-6.1.10: группа в одной выборке)
  }
}
/** Все решения синтетики, выборка — по объекту, как при выпуске (в обход исключения скрытого теста). */
const allItems = (): Item[] => Array.from({ length: N_OBJECTS }, (_, i) => [
  { finding_id: `HS-pos-${i}`, gold_label: "POSITIVE", split: splitOf(`HS-OBJ-${i}`), object_group_id: `HS-OBJ-${i}` },
  { finding_id: `HS-neg-${i}`, gold_label: "NEGATIVE", split: splitOf(`HS-OBJ-${i}`), object_group_id: `HS-OBJ-${i}` },
]).flat();

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  ({ splitOf } = await import("../src/domain/gold.ts"));
  ({ splitHashes } = await import("../src/domain/retrain.ts"));
  ({ blobStore } = await import("../src/services/blobstore.ts"));
  db = await openDb("memory");
  app = buildApp(db);
  for (const [who, login] of [["ml", "ml"], ["cur", "curator"], ["insp", "inspector"], ["adm", "admin"], ["sup", "supervisor"]]) {
    tok[who] = (await call("POST", "/api/v1/auth/login", null, { login, password: "test-pass" })).json().token;
  }
  await seedFinalized();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const FILES = [{ sha256: h("1"), role: "input" }, { sha256: h("2"), role: "input" }, { sha256: h("3"), role: "labels" }];

describe("OS-INSP-6.1.4 печать скрытого теста через API", () => {
  it("ML-инженер запечатывает скрытый тест: 201, число файлов, число меток, отпечаток; запись в аудите", async () => {
    const r = await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "api-seal", files: FILES });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ created: true, seal: { name: "api-seal", n_files: 3, n_labels: 1, sealed_by: "u-ml" } });
    expect(r.json().seal.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditCount("HIDDEN_SEAL_CREATED")).toBe(1);
    const list = await call("GET", "/api/v1/ml/hidden-seals", "ml");
    expect(list.statusCode).toBe(200);
    expect(list.json().find((s: any) => s.name === "api-seal")).toMatchObject({ n_files: 3, n_labels: 1 });
    expect(list.json()[0].files_json).toBeUndefined();
  });

  it("повторная печать того же состава — 200 без новой записи; другой состав под тем же именем — 409", async () => {
    const same = await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "api-seal", files: [...FILES].reverse() });
    expect(same.statusCode).toBe(200);
    expect(same.json().created).toBe(false);
    const other = await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "api-seal", files: FILES.slice(0, 2) });
    expect(other.statusCode).toBe(409);
    expect(other.json().details.code).toBe("HIDDEN_SEAL_CONFLICT");
    expect((await db.get("select count(*) n from hidden_seals where name = 'api-seal'")).n).toBe(1);
    expect(await auditCount("HIDDEN_SEAL_REFUSED")).toBe(1);
  });

  it("печать — только ML-инженер (администратор проходит); не-hex, дубли, пустая печать — 400", async () => {
    expect((await call("POST", "/api/v1/ml/hidden-seals", "insp", { name: "x", files: FILES })).statusCode).toBe(403);
    expect((await call("POST", "/api/v1/ml/hidden-seals", "cur", { name: "x", files: FILES })).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/ml/hidden-seals", "insp")).statusCode).toBe(403);
    expect((await call("POST", "/api/v1/ml/hidden-seals", null, { name: "x", files: FILES })).statusCode).toBe(401);
    expect((await call("POST", "/api/v1/ml/hidden-seals", "adm", { name: "adm-seal", files: [{ sha256: h("9"), role: "input" }] })).statusCode).toBe(201);
    for (const files of [[{ sha256: "z".repeat(64), role: "input" }], [{ sha256: h("7"), role: "input" }, { sha256: h("7"), role: "labels" }], [], [{ sha256: h("7"), role: "answer" }]]) {
      expect((await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "bad", files })).statusCode).toBe(400);
    }
    expect((await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "../etc", files: FILES })).statusCode).toBe(400);
  });

  it("печать и журнал только дописываются: UPDATE, DELETE, TRUNCATE в базе — 42501", async () => {
    expect(await sqlState(db.run("update hidden_seals set digest = $1 where name = 'api-seal'", [h("0")]))).toBe("42501");
    expect(await sqlState(db.run("delete from hidden_seals where name = 'api-seal'"))).toBe("42501");
    expect(await sqlState(db.exec("truncate hidden_seals cascade"))).toBe("42501");
    await call("POST", "/api/v1/ml/hidden-seals/api-seal/runs", "ml", { answer_sha256: h("d"), model_version: "m-append" });
    expect(await sqlState(db.run("update hidden_seal_runs set model_version = 'подмена'"))).toBe("42501");
    expect(await sqlState(db.run("delete from hidden_seal_runs"))).toBe("42501");
    expect(await sqlState(db.exec("truncate hidden_seal_runs"))).toBe("42501");
  });
});

describe("OS-INSP-6.1.5 сверка перед прогоном через API", () => {
  it("сверка перед прогоном через API: совпадение — ok, добавленный и пропавший файл названы, результат в аудите", async () => {
    const ok = await call("POST", "/api/v1/ml/hidden-seals/api-seal/verify", "ml", { shas: [h("3"), h("2"), h("1")] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, added: [], missing: [] });
    const bad = await call("POST", "/api/v1/ml/hidden-seals/api-seal/verify", "ml", { shas: [h("1"), h("8"), h("3")] });
    expect(bad.json()).toMatchObject({ ok: false, added: [h("8")], missing: [h("2")] });
    expect(await auditCount("HIDDEN_SEAL_MISMATCH")).toBe(1);
    expect((await call("POST", "/api/v1/ml/hidden-seals/нет/verify", "ml", { shas: [] })).statusCode).toBe(404);
    expect((await call("POST", "/api/v1/ml/hidden-seals/api-seal/verify", "ml", { shas: ["не-хеш"] })).statusCode).toBe(400);
  });
});

describe("OS-INSP-6.1.7 журнал ответов печати", () => {
  it("ответ записывается в журнал печати с SHA-256, версией модели, временем и автором; повтор — 409, чужая печать — 404", async () => {
    const r = await call("POST", "/api/v1/ml/hidden-seals/api-seal/runs", "ml", { answer_sha256: h("E"), model_version: "rank-2026-09-27-v1" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seal_name: "api-seal", answer_sha256: h("e"), model_version: "rank-2026-09-27-v1", committed_by: "u-ml" });
    expect(r.json().committed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await call("POST", "/api/v1/ml/hidden-seals/api-seal/runs", "ml", { answer_sha256: h("e"), model_version: "x" })).statusCode).toBe(409);
    expect((await call("POST", "/api/v1/ml/hidden-seals/нет/runs", "ml", { answer_sha256: h("e"), model_version: "x" })).statusCode).toBe(404);
    expect((await call("POST", "/api/v1/ml/hidden-seals/api-seal/runs", "ml", { answer_sha256: "abc", model_version: "x" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/ml/hidden-seals/api-seal/runs", "insp", { answer_sha256: h("f"), model_version: "x" })).statusCode).toBe(403);
    const runs = await call("GET", "/api/v1/ml/hidden-seals/api-seal/runs", "ml");
    expect(runs.statusCode).toBe(200);
    expect(runs.json().map((x: any) => x.answer_sha256)).toEqual([h("d"), h("e")]);
    expect(await auditCount("HIDDEN_SEAL_RUN_COMMITTED")).toBe(2);
  });
});

describe("OS-INSP-6.1.6 метки скрытого теста не принимаются в конвейер", () => {
  const pdf = readFileSync(join(ROOT, "data/synth/OBJ-SEV-2/SEV-PD-PZ-1.pdf"));
  const labelsPdf = Buffer.concat([pdf.subarray(0, 16), Buffer.from("%hidden-labels\n"), pdf.subarray(16)]);
  const labelsJsonl = Buffer.from('{"check_id":"G1","violation_label":"VIOLATION_PRESENT"}\n');
  it("файл меток любой печати при загрузке отклоняется с кодом HIDDEN_TEST_LABELS и не попадает ни в файлы проверки, ни в хранилище", async () => {
    const s = await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "upload-seal", files: [{ sha256: sha(pdf.subarray(0, 100)), role: "input" }, { sha256: sha(labelsPdf), role: "labels" }, { sha256: sha(labelsJsonl), role: "labels" }] });
    expect(s.statusCode).toBe(201);
    const r = await upload("HS-UP-1", [{ name: "doc.pdf", buf: pdf }, { name: "doc-marked.pdf", buf: labelsPdf }, { name: "annotations.jsonl", buf: labelsJsonl }]);
    expect(r.statusCode).toBe(202);
    expect(r.json().accepted.map((a: any) => a.file_name)).toEqual(["doc.pdf"]);
    expect(r.json().rejected).toEqual([
      expect.objectContaining({ file_name: "doc-marked.pdf", code: "HIDDEN_TEST_LABELS" }),
      expect.objectContaining({ file_name: "annotations.jsonl", code: "HIDDEN_TEST_LABELS" }),
    ]);
    expect((await db.get("select count(*) n from files where sha256 = $1", [sha(labelsPdf)])).n).toBe(0);
    expect(await blobStore().exists(sha(labelsPdf))).toBe(false);
  });
  it("пакет только из файлов меток — 400, проверка без файлов", async () => {
    const r = await upload("HS-UP-2", [{ name: "marked.pdf", buf: labelsPdf }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().rejected).toEqual([expect.objectContaining({ code: "HIDDEN_TEST_LABELS" })]);
    expect(r.json().accepted).toEqual([]);
  });
});

describe("OS-INSP-6.1.8 скрытый тест не входит в GOLD и в обучение", () => {
  const hiddenFiles = () => [...Array.from({ length: HIDDEN_OBJECTS }, (_, i) => ({ sha256: fileSha(i), role: "input" })), { sha256: h("c"), role: "labels" }];

  it("выпуск GOLD исключает решения по файлам скрытого теста и называет число исключённых (excluded_hidden)", async () => {
    const before = await call("GET", "/api/v1/ml/gold/preview", "cur");
    expect(before.json().excluded_hidden).toBe(0);
    expect((await call("POST", "/api/v1/ml/hidden-seals", "ml", { name: "gold-hidden", files: hiddenFiles() })).statusCode).toBe(201);
    const preview = await call("GET", "/api/v1/ml/gold/preview", "cur");
    expect(preview.json().excluded_hidden).toBe(2 * HIDDEN_OBJECTS);
    const r = await call("POST", "/api/v1/ml/gold/release", "cur");
    expect(r.statusCode).toBe(200);
    expect(r.json().excluded_hidden).toBe(2 * HIDDEN_OBJECTS);
    expect(r.json().items).toBe(2 * (N_OBJECTS - HIDDEN_OBJECTS));
    const ids = (await db.all("select finding_id from dataset_items where dataset_version = $1", [r.json().dataset_version])).map((x: any) => x.finding_id);
    for (let i = 0; i < HIDDEN_OBJECTS; i++) expect(ids).not.toContain(`HS-pos-${i}`);
    expect(ids).toContain(`HS-pos-${HIDDEN_OBJECTS}`);
    const a = await db.get("select details from audit_log where action = 'DATASET_RELEASED' order by id desc limit 1");
    expect(JSON.parse(a.details).excluded_hidden).toBe(2 * HIDDEN_OBJECTS);
    // чистый выпуск обучается: гард не мешает законному набору
    expect((await call("POST", "/api/v1/ml/models/train", "ml", { dataset_version: r.json().dataset_version })).statusCode).toBe(201);
  });

  it("дообучение по выпуску с решениями по файлам скрытого теста отклоняется с причиной, итерация не записана", async () => {
    await craftDataset("gold-with-hidden", allItems());
    const before = (await db.get("select count(*) n from model_versions")).n;
    const r = await call("POST", "/api/v1/ml/models/train", "ml", { dataset_version: "gold-with-hidden" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("решения по файлам скрытого теста (10)");
    expect(r.json().details.hidden_test.count).toBe(2 * HIDDEN_OBJECTS);
    expect(r.json().details.hidden_test.finding_ids).toContain("HS-pos-0");
    expect((await db.get("select count(*) n from model_versions")).n).toBe(before);
    expect(await auditCount("MODEL_TRAINING_REFUSED")).toBeGreaterThanOrEqual(1);
  });
});

describe("OS-INSP-6.1.9 порог только на validation", () => {
  it("validation пересекается со скрытой выборкой test по object_id — отказ в подборе порога с перечнем объектов", async () => {
    const clean = allItems().filter((i) => Number(i.object_group_id.split("-").pop()) >= HIDDEN_OBJECTS);
    const testObj = clean.find((i) => i.split === "test")!.object_group_id;
    const leaked = clean.map((i, k) => (k === clean.findIndex((x) => x.split === "validation") ? { ...i, object_group_id: testObj } : i));
    await craftDataset("gold-leak-object", leaked);
    const r = await call("POST", "/api/v1/ml/models/train", "ml", { dataset_version: "gold-leak-object" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("validation пересекается со скрытым тестом");
    expect(r.json().details.threshold_overlap).toEqual({ shas: [], object_ids: [testObj] });
    expect(r.json().details.hidden_test).toBeUndefined();
  });

  it("validation содержит файл печати по SHA-256 — отказ в подборе порога с перечнем хешей", async () => {
    const valObj = allItems().find((i) => i.split === "validation" && Number(i.object_group_id.split("-").pop()) < HIDDEN_OBJECTS);
    expect(valObj).toBeDefined(); // HS-OBJ-3 по splitOf попадает в validation
    await craftDataset("gold-leak-sha", allItems());
    const r = await call("POST", "/api/v1/ml/models/train", "ml", { dataset_version: "gold-leak-sha" });
    expect(r.statusCode).toBe(422);
    const i = Number(valObj!.object_group_id.split("-").pop());
    expect(r.json().details.threshold_overlap.shas).toContain(fileSha(i));
    expect(r.json().details.reasons.some((x: string) => x.startsWith("Подбор порога запрещён"))).toBe(true);
  });
});
