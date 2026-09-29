// Эшелоны: L2 (прогон стенда мутаций через настоящие приём → роли редакций → очередь разбора → пересчёт; ответ ML задан),
// L4 (хеш файла не совпал — отказ примера в отчёт, а не молча), L6 (ловушка устаревшей редакции, конфликт редакций).
// T-179, OS-INSP-6.5.44: статус группы берётся из checks — так, как его видит инспектор, без подмены оператора.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-mutbench-"));
const DIR = join(TMP, "ds");
let db: any;
let bench: typeof import("../scripts/mutation-bench.ts");
const replies = new Map<string, any[]>(); // sha → упоминания, которые «вернёт» ML

const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n%%EOF\n`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const cls = (v: string, page = 1) => ({ code: "M-023", raw: v, value_num: null, value_text: v, page, bbox: [0.2, 0.3, 0.25, 0.32], anchor_bbox: null, line_text: `класс конструктивной пожарной опасности — ${v}`, confidence: 1, meta: { quote: v, qualifier: null, excluded: null, excluded_why: null, ops: ["ENT-16"] } });
const area = (n: number) => ({ code: "M-001", raw: String(n), value_num: n, value_text: null, page: 2, bbox: [0.8, 0.1, 0.9, 0.12], anchor_bbox: null, line_text: `Площадь застройки м² ${n}`, confidence: 1, meta: { quote: "q", qualifier: null, excluded: null, excluded_why: null, text_source: "pdf-text", ops: ["ENT-15"] } });

/** Пример набора: файлы на диске и строка dataset.json; ext — извлечения ML по файлу. */
function kase(id: string, files: Array<{ id: string; stage: "PD" | "RD"; rev: string; pred?: string; ext: any[]; badSha?: boolean }>) {
  mkdirSync(join(DIR, id), { recursive: true });
  return {
    case_id: id,
    profile: { residential: true, underground: true },
    files: files.map((f) => {
      const buf = pdf(`${id}-${f.id}`);
      const name = `${f.stage === "PD" ? "П" : "Р"}-9-0001-${f.stage === "PD" ? "ПЗ" : "АР"} изм${f.rev}.pdf`;
      writeFileSync(join(DIR, id, name), buf);
      replies.set(sha(buf), f.ext);
      return {
        file_id: `${id}-${f.id}`, file_name: name, sha256: f.badSha ? "0".repeat(64) : sha(buf), doc_stage: f.stage, discipline: f.stage === "PD" ? "ПЗ" : "АР",
        document_code: `${f.stage === "PD" ? "П" : "Р"}-9-0001-${f.stage === "PD" ? "ПЗ" : "АР"}`, revision: f.rev, approval_status: f.stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION",
        approval_date: null, predecessor_id: f.pred ? `${id}-${f.pred}` : null,
      };
    }),
  };
}

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_SHEET_DIFF_AUTO: "0" });
  const dbm = await import("../src/db.ts");
  const ml = await import("../src/services/ml-client.ts");
  const bs = await import("../src/services/blobstore.ts");
  (await import("../src/services/inspections.ts")).resetQueueForTests();
  bs.setBlobStoreForTests(new bs.FsBlobStore(join(TMP, "blobs")));
  ml.setMlTransport(async (req) => ({ sha256: req.sha256, kind: "pdf", engine: "fake", pages: [], extractions: replies.get(req.sha256) ?? [], facts: [], rooms: [], cached: false, ml_revision: "r4-x13" }));
  bench = await import("../scripts/mutation-bench.ts");
  db = await dbm.openDb("memory");
});
afterAll(async () => {
  (await import("../src/services/inspections.ts")).resetQueueForTests();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("стенд мутаций: прогон через конвейер API (OS-INSP-6.5.44)", () => {
  it("MUT-06 понижение класса в РД — CANDIDATE по М-023 с доказательством РД; не тронутая площадь — NEGATIVE_VERIFIED", async () => {
    const c = kase("MUT-9-0001", [{ id: "pd1", stage: "PD", rev: "1", ext: [cls("С0"), area(1234.5)] }, { id: "rd1", stage: "RD", rev: "1", ext: [cls("С1"), area(1234.5)] }]);
    const [r] = await bench.runBench(db, { cases: [c] as any }, DIR, ["M-001", "M-023"]);
    expect(r.error).toBeUndefined();
    expect(r.files.map((f) => [f.file_id, f.parse_status, f.revision_role])).toEqual([["MUT-9-0001-pd1", "DONE", "CURRENT"], ["MUT-9-0001-rd1", "DONE", "CURRENT"]]);
    const by = Object.fromEntries(r.rows.map((x) => [x.code, x]));
    expect(by["M-023"]).toMatchObject({ status: "CANDIDATE", expected: "С0", actual: "С1" });
    expect(by["M-023"].fragments.find((f) => f.kind === "actual")).toMatchObject({ file_id: "MUT-9-0001-rd1", stage: "RD", page: 1, bbox: [0.2, 0.3, 0.25, 0.32] });
    expect(by["M-001"]).toMatchObject({ status: "NEGATIVE_VERIFIED" });
    // извлечения для меток судьи — с идентификатором файла генератора
    expect(r.extractions.filter((e) => e.code === "M-023").map((e) => [e.file_id, e.value_text])).toEqual([["MUT-9-0001-pd1", "С0"], ["MUT-9-0001-rd1", "С1"]]);
  });

  it("MUT-18 ловушка: нарушение только в заменённой редакции РД — NEGATIVE_VERIFIED; конфликт двух утверждённых — CLARIFICATION_REQUIRED", async () => {
    const stale = kase("MUT-9-0002", [
      { id: "pd1", stage: "PD", rev: "1", ext: [cls("С0")] }, { id: "rd1", stage: "RD", rev: "1", ext: [cls("С2")] }, { id: "rd2", stage: "RD", rev: "2", pred: "rd1", ext: [cls("С0")] },
    ]);
    const conflict = kase("MUT-9-0003", [
      { id: "pd1", stage: "PD", rev: "1", ext: [cls("С0")] }, { id: "rd1", stage: "RD", rev: "1", ext: [cls("С2")] }, { id: "rd2", stage: "RD", rev: "2", ext: [cls("С0")] },
    ]);
    const [a, b] = await bench.runBench(db, { cases: [stale, conflict] as any }, DIR, ["M-023"], 2);
    expect(a.files.map((f) => f.revision_role)).toEqual(["CURRENT", "SUPERSEDED", "CURRENT"]);
    expect(a.rows[0]).toMatchObject({ code: "M-023", status: "NEGATIVE_VERIFIED", actual: "С0" });
    expect(b.files.map((f) => f.revision_role)).toEqual(["CURRENT", "CONFLICT", "CONFLICT"]);
    expect(b.rows[0].status).toBe("CLARIFICATION_REQUIRED");
  });

  it("хеш файла не совпал с набором — пример в отчёте с ошибкой, остальные идут дальше", async () => {
    const bad = kase("MUT-9-0004", [{ id: "pd1", stage: "PD", rev: "1", ext: [], badSha: true }]);
    const ok = kase("MUT-9-0005", [{ id: "pd1", stage: "PD", rev: "1", ext: [cls("С0")] }]);
    const [x, y] = await bench.runBench(db, { cases: [bad, ok] as any }, DIR, ["M-023"]);
    expect(x).toMatchObject({ case_id: "MUT-9-0004", rows: [], error: expect.stringMatching(/SHA-256 файла не совпадает/) });
    expect(y.error).toBeUndefined();
    expect(y.rows[0].status).toBe("MISSING_EVIDENCE");
  });

  it("имя файла с каталогом не читается даже в обход схемы", () => {
    const c = kase("MUT-9-0006", [{ id: "pd1", stage: "PD", rev: "1", ext: [] }]);
    const f = { ...c.files[0], file_name: "../dataset.json" };
    expect(() => bench.readCaseFile(DIR, c as any, f as any)).toThrow(/имя файла набора недопустимо/);
  });
});

describe("стенд мутаций: окружение и пределы (OWASP T179-5, T179-6)", () => {
  it("окружение прогона: профиль dev, файлы в fs-каталоге прогона, S3 и чужие INSPECTOR_* из shell отброшены", () => {
    const env = bench.benchEnv({ PATH: "/bin", INSPECTOR_BLOB_STORE: "s3", INSPECTOR_S3_BUCKET: "nadzorium", INSPECTOR_PROFILE: "gpu", INSPECTOR_DATABASE_URL: "postgres://x", INSPECTOR_ML_URL: "http://127.0.0.1:45001" }, "/tmp/run/blobs");
    expect(env).toMatchObject({ PATH: "/bin", INSPECTOR_PROFILE: "dev", INSPECTOR_BLOB_STORE: "fs", INSPECTOR_BLOB_DIR: "/tmp/run/blobs", INSPECTOR_ML_URL: "http://127.0.0.1:45001", INSPECTOR_AV: "off" });
    expect(Object.keys(env).filter((k) => /S3|DATABASE/.test(k))).toEqual([]);
  });

  it("файл больше предела — отказ до чтения в память", () => {
    const p = join(TMP, "big.pdf");
    writeFileSync(p, Buffer.alloc(2048));
    expect(bench.readLimited(p, 4096)).toHaveLength(2048);
    expect(() => bench.readLimited(p, 1024)).toThrow(/больше предела 1024/);
    expect(bench.MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
  });
});
