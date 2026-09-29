// Эшелоны: L4 (сбой посреди разбора: перезапуск API или отключение питания), L3 (нет незавершённых файлов, нет
// застрявших проверок). T-129, вопрос владельца: работа продолжается после прерывания, сделанное не пересчитывается.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-recover-"));
let db: any;
let ins: any;
const analyzed: string[] = [];
const replies = new Map<string, any[]>(); // имя файла → извлечения, которые «вернёт» ML
const names = new Map<string, string>();

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_ML_URL: "http://127.0.0.1:9", INSPECTOR_SHEET_DIFF_AUTO: "0" });
  const dbm = await import("../src/db.ts");
  ins = await import("../src/services/inspections.ts");
  const ml = await import("../src/services/ml-client.ts");
  const bs = await import("../src/services/blobstore.ts");
  bs.setBlobStoreForTests(new bs.FsBlobStore(join(TMP, "blobs")));
  ml.setMlTransport(async (req) => {
    analyzed.push(names.get(req.sha256) ?? req.sha256);
    return { sha256: req.sha256, kind: "pdf", engine: "fake", pages: [], extractions: replies.get(names.get(req.sha256) ?? "") ?? [], facts: [], rooms: [], cached: false, ml_revision: "r4-x6" };
  });
  db = await dbm.openDb("memory");
});
afterAll(async () => {
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const ctx = () => ({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" } });
async function file(insp: string, id: string, status: string, stage = "PD") {
  const buf = Buffer.from(`%PDF-1.4 ${id}`);
  const sha = createHash("sha256").update(buf).digest("hex");
  const { blobStore } = await import("../src/services/blobstore.ts");
  await blobStore().put(sha, buf);
  names.set(sha, id);
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, revision_role, uploaded_at)
    values ($1,$2,'OBJ-R',$1,$1,$3,1,'pdf',$5,$1,'0',$4,'CURRENT','2026-09-27T00:00:00Z')`, [id, insp, sha, status, stage]);
}
const until = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
};

describe("восстановление разбора после сбоя", () => {
  it("проверка застряла в PARSING: разобранный файл не трогается, «в разборе» и «ждёт» — снова в очереди, проверка доходит до READY", async () => {
    const insp = await ins.createInspection(ctx(), { object_id: "OBJ-R", name: "Объект" });
    await file(insp, "done", "DONE");
    await file(insp, "inflight", "PARSING"); // шёл разбор, когда пропало питание
    await file(insp, "waiting", "PENDING");
    await db.run("update inspections set status = 'PARSING' where id = $1", [insp]);
    const r = await ins.recoverParsing(db);
    expect(r).toEqual({ inspections: 1, requeued: 2 });
    await until(async () => (await db.get("select status from inspections where id = $1", [insp])).status === "READY");
    expect((await db.get("select status from inspections where id = $1", [insp])).status).toBe("READY");
    expect([...analyzed].sort()).toEqual(["inflight", "waiting"]);
    const st = await db.all("select id, parse_status from files where inspection_id = $1 order by id", [insp]);
    expect(st.map((x: any) => x.parse_status)).toEqual(["DONE", "DONE", "DONE"]);
  });

  it("все файлы уже разобраны, а статус остался PARSING (сбой между разбором и пересчётом) — сразу пересчёт, без повторного разбора", async () => {
    const before = analyzed.length;
    const insp = await ins.createInspection(ctx(), { object_id: "OBJ-R2", name: "Объект 2" });
    await file(insp, "only", "DONE");
    await db.run("update inspections set status = 'PARSING' where id = $1", [insp]);
    expect(await ins.recoverParsing(db)).toEqual({ inspections: 1, requeued: 0 });
    await until(async () => (await db.get("select status from inspections where id = $1", [insp])).status === "READY");
    expect((await db.get("select status from inspections where id = $1", [insp])).status).toBe("READY");
    expect(analyzed.length).toBe(before);
  });

  it("дубль задания (брокер вернул неподтверждённое, восстановление поставило ещё раз) — файл разбирается один раз", async () => {
    const insp = await ins.createInspection(ctx(), { object_id: "OBJ-R3", name: "Объект 3" });
    await file(insp, "twice", "PENDING");
    await db.run("update inspections set status = 'PARSING' where id = $1", [insp]);
    const q = ins.parseQueue(db);
    q.push("twice-a", { fileId: "twice", inspectionId: insp });
    q.push("twice-b", { fileId: "twice", inspectionId: insp });
    await until(async () => (await db.get("select status from inspections where id = $1", [insp])).status === "READY");
    await new Promise((r) => setTimeout(r, 100));
    expect(analyzed.filter((x) => x === "twice")).toEqual(["twice"]);
  });

  it("застрявших проверок нет — ничего не делает", async () => {
    expect(await ins.recoverParsing(db)).toEqual({ inspections: 0, requeued: 0 });
  });
});

describe("ожидание ML при его перезапуске (регрессия OOM стенда «Алтуфьево»)", () => {
  it("ML поднялся за время ожидания — true; не поднялся за лимит — false, без исключения", async () => {
    const http = await import("node:http");
    const srv = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ status: "ok" })); });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = (srv.address() as any).port;
    const { config } = await import("../src/config.ts");
    const url = config.mlUrl;
    (config as any).mlUrl = `http://127.0.0.1:${port}`;
    try {
      expect(await ins.waitMlReady(1000, 50)).toBe(true);
      (config as any).mlUrl = "http://127.0.0.1:9";
      const t = Date.now();
      expect(await ins.waitMlReady(300, 50)).toBe(false);
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      (config as any).mlUrl = url;
      srv.close();
    }
  });
});

describe("смена версии интеллектуальной части (OS-INSP-2.1.12)", () => {
  it("запуск обработки разбирает заново файлы прежней и неизвестной версии, текущую — не трогает; версия записывается", async () => {
    const http = await import("node:http");
    const srv = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ status: "ok", profile: "dev", ml_revision: "r4-x6" })); });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const { config } = await import("../src/config.ts");
    const url = config.mlUrl;
    (config as any).mlUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const insp = await ins.createInspection(ctx(), { object_id: "OBJ-REV", name: "Объект версии" });
      for (const [id, rev] of [["old", "r3-x6"], ["cur", "r4-x6"], ["unk", null]] as const) {
        await file(insp, id, "DONE");
        await db.run("update files set ml_revision = $1 where id = $2", [rev, id]);
      }
      await db.run("update inspections set status = 'READY' where id = $1", [insp]);
      const before = analyzed.length;
      expect(await ins.startProcessing(ctx(), insp)).toEqual({ queued: 2 });
      await until(async () => (await db.get("select status from inspections where id = $1", [insp])).status === "READY");
      expect(analyzed.slice(before).sort()).toEqual(["old", "unk"]);
      const revs = await db.all("select id, ml_revision from files where inspection_id = $1 order by id", [insp]);
      expect(revs.map((r: any) => [r.id, r.ml_revision])).toEqual([["cur", "r4-x6"], ["old", "r4-x6"], ["unk", "r4-x6"]]);
    } finally {
      (config as any).mlUrl = url;
      srv.close();
    }
  });
  it("после переразбора новой версией ML пересчёт пересматривает параметры переразобранных файлов (T-130)", async () => {
    const http = await import("node:http");
    const srv = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ status: "ok", profile: "dev", ml_revision: "r4-x6" })); });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const { config } = await import("../src/config.ts");
    const url = config.mlUrl;
    (config as any).mlUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
    const ex = (v: number) => [{ code: "M-059", raw: String(v), value_num: v, value_text: null, page: 1, bbox: [0.1, 0.1, 0.2, 0.12], line_text: `толщина плиты ${v} мм`, confidence: 0.9 }];
    try {
      const insp = await ins.createInspection(ctx(), { object_id: "OBJ-REPARSE", name: "Объект переразбора" });
      replies.set("pd59", ex(200));
      replies.set("rd59", ex(200));
      await file(insp, "pd59", "PENDING", "PD");
      await file(insp, "rd59", "PENDING", "RD");
      await ins.startProcessing(ctx(), insp);
      await until(async () => (await db.get("select status from inspections where id = $1", [insp])).status === "READY");
      const first = await db.get("select finding_status, actual_value from checks where inspection_id = $1 and param_code = 'M-059'", [insp]);
      expect(first.actual_value).toBe("200");
      // новая версия ML прочитала в РД другое значение — файл переразбирается, проверка обязана это увидеть
      replies.set("rd59", ex(150));
      await db.run("update files set ml_revision = 'r3-x6' where id = 'rd59'");
      expect(await ins.startProcessing(ctx(), insp)).toEqual({ queued: 1 });
      await until(async () => (await db.get("select actual_value from checks where inspection_id = $1 and param_code = 'M-059'", [insp])).actual_value === "150");
      const second = await db.get("select finding_status, actual_value from checks where inspection_id = $1 and param_code = 'M-059'", [insp]);
      expect(second.actual_value).toBe("150");
    } finally {
      (config as any).mlUrl = url;
      srv.close();
    }
  });
  it("ML недоступен — повторного разбора разобранных нет, только ждущие и упавшие", async () => {
    const insp = await ins.createInspection(ctx(), { object_id: "OBJ-REV2", name: "Объект 2" });
    await file(insp, "old2", "DONE");
    await db.run("update files set ml_revision = 'r1-x1' where id = 'old2'");
    await db.run("update inspections set status = 'READY' where id = $1", [insp]);
    expect(await ins.startProcessing(ctx(), insp)).toEqual({ queued: 0 });
  });
});


describe("durable inspection recovery context", () => {
  it("recovers changed old sources and verification status from DB, preserving history and rollback context", async () => {
    const insp = await ins.createInspection(ctx(), { object_id: "OBJ-CONTEXT", name: "Контекст восстановления" });
    const ex = (v: number) => [{ code: "M-059", raw: String(v), value_num: v, value_text: null,
      page: 1, bbox: [0.1, 0.1, 0.2, 0.12], line_text: `толщина плиты ${v} мм`, confidence: 0.9 }];
    replies.set("ctx-pd", ex(200)); replies.set("ctx-rd", ex(200));
    await file(insp, "ctx-pd", "PENDING", "PD");
    await file(insp, "ctx-rd", "PENDING", "RD");
    await ins.startProcessing(ctx(), insp);
    await until(async () => (await db.get("select status from inspections where id=$1", [insp])).status === "READY");
    const oldProtocol = await db.get("select body_json from protocols where inspection_id=$1 and version=1", [insp]);
    const before = analyzed.length;
    // State left by a committed reparse and an API crash before protocol publication.
    // The original file predates protocol v1, so upload-time detection cannot find this change.
    await db.run("update extractions set value_num=150, raw='150' where file_id='ctx-rd' and param_code='M-059'");
    await db.run(`update inspections set status='PARSING', processing_resume_status='VERIFYING',
      processing_changed_files_json='["ctx-rd"]' where id=$1`, [insp]);
    const faultDb = new Proxy(db, { get(target, key) {
      if (key === "tx") return (fn: any) => target.tx((t: any) => fn(new Proxy(t, { get(inner, field) {
        if (field === "run") return (sql: string, args: any[]) => {
          if (sql.startsWith("update inspections set protocol_version")) throw new Error("publication fault");
          return inner.run(sql, args);
        };
        return typeof inner[field] === "function" ? inner[field].bind(inner) : inner[field];
      } })));
      return typeof target[key] === "function" ? target[key].bind(target) : target[key];
    } });
    await expect(ins.recompute(faultDb, insp, new Set())).rejects.toThrow("publication fault");
    expect(await db.get("select protocol_version, processing_resume_status, processing_changed_files_json from inspections where id=$1", [insp]))
      .toEqual({ protocol_version: 1, processing_resume_status: "VERIFYING", processing_changed_files_json: '["ctx-rd"]' });
    await ins.maybeFinishParsing(db, insp);
    expect((await db.get("select actual_value from checks where inspection_id=$1 and param_code='M-059'", [insp])).actual_value).toBe("150");
    const after = await db.get("select status, protocol_version, processing_resume_status, processing_changed_files_json from inspections where id=$1", [insp]);
    expect(after.status).not.toBe("READY");
    expect(after).toMatchObject({ protocol_version: 2, processing_resume_status: null, processing_changed_files_json: "[]" });
    expect(await db.get("select body_json from protocols where inspection_id=$1 and version=1", [insp])).toEqual(oldProtocol);
    expect(analyzed.length).toBe(before);
    await ins.maybeFinishParsing(db, insp);
    expect((await db.get("select protocol_version from inspections where id=$1", [insp])).protocol_version).toBe(2);
  });
});
