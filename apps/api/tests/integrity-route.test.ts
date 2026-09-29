// OS-INSP-1.2.31–1.2.35 (T-120) сквозь маршрут загрузки: реестр организатора с SHA-256, числом страниц и причиной
// исключения → отказы в ответе и в журнале, отчёт о целостности, стадия PARTIAL при неполном файле (L2, PGlite, без ML).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-integrity-"));
let app: any;
let db: any;
let token = "";
const auth = () => ({ authorization: `Bearer ${token}` });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Минимальный PDF из pages страниц; text делает содержимое (и хеш) уникальным. */
function pdf(text: string, pages = 1): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>`);
  let out = `%PDF-1.4\n% ${text}\n`;
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

function multipart(fields: Record<string, string>, files: Array<{ field: string; name: string; buf: Buffer }>) {
  const boundary = "----integ" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
function upload(files: Array<{ name: string; buf: Buffer }>, manifest: unknown) {
  const fields = { start: "false", object: JSON.stringify({ object_id: `INT-${Math.random().toString(16).slice(2, 8)}`, name: "Целостность пакета" }) };
  const m = multipart(fields, [...files.map((f) => ({ field: "files", ...f })), { field: "manifest", name: "manifest.json", buf: Buffer.from(JSON.stringify(manifest)) }]);
  return app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: m.payload, headers: { ...m.headers, ...auth() } });
}
const row = (file_id: string, file_name: string, extra: Record<string, unknown> = {}) => ({
  file_id, file_name, doc_stage: "PD", discipline: "АР", document_code: `ШФР-${file_id}`, revision: "1", approval_status: "APPROVED", ...extra,
});

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_AV: "off", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
});
afterAll(async () => {
  await db.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("целостность пакета по реестру (OS-INSP-1.2.31–1.2.35)", () => {
  const a = pdf("A", 2), b = pdf("B"), c = pdf("C"), bad = pdf("подмена");
  const manifest = {
    files: [
      row("F1", "a.pdf", { sha256: sha(a), pdf_pages: 3 }),
      row("F2", "a-копия.pdf"),
      row("F3", "b.pdf", { exclusion_reason: "исключён организатором (split_policy)" }),
      row("F4", "c.pdf", { sha256: sha(c) }),
      row("F5", "нет.pdf"),
    ],
  };
  let id = "";
  let res: any;

  beforeAll(async () => {
    res = await upload([{ name: "a.pdf", buf: a }, { name: "a-копия.pdf", buf: a }, { name: "b.pdf", buf: b }, { name: "c.pdf", buf: bad }], manifest);
    id = res.json().process_id;
  });

  it("ответ загрузки: исключённый — EXCLUDED, дубль по содержимому — DUPLICATE_CONTENT с оригиналом, чужой хеш — HASH_MISMATCH с обоими хешами", () => {
    expect([200, 202]).toContain(res.statusCode);
    const by = Object.fromEntries(res.json().rejected.map((r: any) => [r.file_name, r]));
    expect(res.json().accepted.map((f: any) => f.file_name)).toEqual(["a.pdf"]);
    expect(by["b.pdf"].code).toBe("EXCLUDED");
    expect(by["a-копия.pdf"]).toMatchObject({ code: "DUPLICATE_CONTENT", duplicate_of: "F1" });
    expect(by["c.pdf"].code).toBe("HASH_MISMATCH");
    expect(by["c.pdf"].message).toContain(sha(bad));
    expect(by["c.pdf"].message).toContain(sha(c));
  });

  it("отчёт о целостности: статус каждого файла реестра и доля без расхождений", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/inspection/${id}/integrity`, headers: auth() });
    expect(r.statusCode).toBe(200);
    const by = Object.fromEntries(r.json().files.map((f: any) => [f.file_id, f.status]));
    expect(by).toEqual({ F1: "ACCEPTED", F2: "DUPLICATE", F3: "EXCLUDED", F4: "REJECTED", F5: "MISSING" });
    expect(r.json().share).toBeCloseTo(3 / 5, 6);
  });

  it("после разбора: страниц меньше, чем в реестре, — файл неполный, стадия PD_PARTIAL", async () => {
    const { refreshLoad } = await import("../src/services/inspections.ts");
    await db.run("update files set pages_json = $1 where inspection_id = $2 and client_file_id = 'F1'", [JSON.stringify([{}, {}]), id]);
    await refreshLoad(db, id);
    const r = (await app.inject({ method: "GET", url: `/api/v1/inspection/${id}/integrity`, headers: auth() })).json();
    expect(r.files.find((f: any) => f.file_id === "F1")).toMatchObject({ status: "INCOMPLETE", pages: 2, declared_pages: 3 });
    const insp = await db.get("select load_codes_json from inspections where id = $1", [id]);
    expect(JSON.parse(insp.load_codes_json)).toContain("PD_PARTIAL");
  });

  it("журнал отказов только дописывается", async () => {
    await expect(db.run("delete from file_rejections where inspection_id = $1", [id])).rejects.toThrow();
  });

  it("T136-L2: причина исключения длиннее 500 символов — реестр отклонён, ничего не принято", async () => {
    const r = await upload([{ name: "x.pdf", buf: pdf("X") }], { files: [row("X1", "x.pdf", { exclusion_reason: "я".repeat(501) })] });
    expect(r.statusCode).toBe(400);
  });

  it("T136-L2: в отчёте — последний отказ по файлу, журнал при этом хранит все", async () => {
    const m = { files: [row("Z1", "z.pdf", { sha256: sha(c) })] };
    const first = await upload([{ name: "z.pdf", buf: bad }], m);
    const pid = first.json().process_id;
    const { integrityFor } = await import("../src/services/inspections.ts");
    await db.run("insert into file_rejections (inspection_id, file_name, code, message, created_at) values ($1,'z.pdf','CORRUPTED','повторная загрузка — повреждён',$2)", [pid, new Date().toISOString()]);
    const rep = await integrityFor(db, pid);
    expect(rep.files[0]).toMatchObject({ status: "REJECTED", reason: "CORRUPTED: повторная загрузка — повреждён" });
    expect((await db.get("select count(*)::int n from file_rejections where inspection_id = $1", [pid])).n).toBe(2);
  });

  it("нет проверки — 404", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/inspection/NOPE/integrity", headers: auth() })).statusCode).toBe(404);
  });
});
