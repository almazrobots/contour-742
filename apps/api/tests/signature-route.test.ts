// OS-INSP-1.2.11, 1.2.14 сквозь маршрут загрузки: пакет «документ + .sig» → результат проверки в ответе, в реестре файла
// и в аудите; реестр заявляет УКЭП, а подпись INVALID → документ проверяется на реквизиты как скан (REQ-… в протоколе).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const F = resolve(import.meta.dirname, "fixtures/signature");
const TMP = mkdtempSync(join(tmpdir(), "inspector-sigroute-"));
const read = (n: string) => readFileSync(join(F, n));
let app: any;
let db: any;
let token = "";

function multipart(fields: Record<string, string>, files: Array<{ field: string; name: string; buf: Buffer }>) {
  const boundary = "----sig" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_AV: "off",
    INSPECTOR_ML_URL: "http://127.0.0.1:9", // ML не нужен: start=false
    INSPECTOR_TRUST_DIR: join(F, "trust"), INSPECTOR_QUALIFIED_ROOTS_DIR: join(F, "qualified"),
  });
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

const auth = () => ({ authorization: `Bearer ${token}` });
const manifestFile = (file_id: string, file_name: string, signature_status: string) => ({
  file_id, file_name, doc_stage: "ID", discipline: "ИД", document_code: `АОСР-${file_id}`, revision: "1", approval_status: "APPROVED", signature_status,
});
function upload(files: Array<{ name: string; buf: Buffer }>, opts: { process_id?: string; manifest?: unknown } = {}) {
  const fields: Record<string, string> = { start: "false" };
  if (opts.process_id) fields.process_id = opts.process_id;
  else fields.object = JSON.stringify({ object_id: `SIG-${Math.random().toString(16).slice(2, 8)}`, name: "Проверка подписи" });
  const all = files.map((f) => ({ field: "files", ...f }));
  if (opts.manifest) all.push({ field: "manifest", name: "manifest.json", buf: Buffer.from(JSON.stringify(opts.manifest)) });
  const m = multipart(fields, all);
  return app.inject({ method: "POST", url: "/api/v1/documents/upload", payload: m.payload, headers: { ...m.headers, ...auth() } });
}
const card = async (id: string) => (await app.inject({ method: "GET", url: `/api/v1/inspections/${id}`, headers: auth() })).json();

describe("подпись в пакете через маршрут загрузки (OS-INSP-1.2.11)", () => {
  it("PDF + .sig: документ принят, подпись — не документ (нет в files, не уходит в ML), VALID УКЭП в ответе, в реестре и в аудите", async () => {
    const r = await upload([{ name: "Акт.pdf", buf: read("doc.pdf") }, { name: "Акт.pdf.sig", buf: read("ukep.sig") }]);
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(body.accepted.map((a: any) => a.file_name)).toEqual(["Акт.pdf"]);
    expect(body.rejected).toEqual([]);
    expect(body.signatures).toEqual([expect.objectContaining({ file_name: "Акт.pdf.sig", document: "Акт.pdf", status: "VALID", kind: "UKEP", file_id: body.accepted[0].file_id })]);
    expect((await db.get("select count(*) n from files where file_name like '%.sig'")).n).toBe(0);
    const f = (await card(body.process_id)).files.find((x: any) => x.file_name === "Акт.pdf");
    expect(f.signature_check).toMatchObject({ status: "VALID", kind: "UKEP", signer: "CN=Иванов Иван (тест УКЭП)", sig_file_name: "Акт.pdf.sig" });
    expect(f.signature_check.sig_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.signature_check_json).toBeUndefined();
    // файл подписи хранится как доказательство рядом с документом — по своему SHA-256
    expect(readFileSync(join(TMP, "blobs", f.signature_check.sig_sha256))).toEqual(read("ukep.sig"));
    const ev = await db.all("select details from audit_log where action = 'SIGNATURE_CHECKED' and object_id = $1", [body.process_id]);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].details)).toMatchObject({ file_name: "Акт.pdf", sig_file_name: "Акт.pdf.sig", status: "VALID", kind: "UKEP" });
  });
  it(".p7s с ECDSA — УНЭП; мусор с расширением .sig не падает на правиле форматов, а даёт INVALID «не CMS»", async () => {
    const r = await upload([
      { name: "Схема.pdf", buf: read("doc.pdf") }, { name: "Схема.pdf.p7s", buf: read("unep.p7s") },
      // свой документ — своё содержимое: тот же PDF под вторым именем — дубль по содержимому (OS-INSP-1.2.33)
      { name: "Журнал.pdf", buf: Buffer.concat([read("doc.pdf"), Buffer.from("\n% журнал\n")]) }, { name: "Журнал.pdf.sig", buf: read("garbage.sig") },
    ]);
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(body.rejected).toEqual([]);
    const by = Object.fromEntries(body.signatures.map((s: any) => [s.document, s]));
    expect(by["Схема.pdf"]).toMatchObject({ status: "VALID", kind: "UNEP" });
    expect(by["Журнал.pdf"]).toMatchObject({ status: "INVALID", kind: null, reason: expect.stringContaining("не CMS") });
  });
  it("подпись без документа в пакете — отклонена SIGNATURE_WITHOUT_DOCUMENT с понятной причиной; ничего не принято — 400", async () => {
    const r = await upload([{ name: "Сирота.pdf.sig", buf: read("ukep.sig") }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().rejected).toEqual([expect.objectContaining({ file_name: "Сирота.pdf.sig", code: "SIGNATURE_WITHOUT_DOCUMENT", message: expect.stringContaining("нет файла Сирота.pdf") })]);
  });
  it("подпись дозагружена к ранее принятому документу — проверена по сохранённому содержимому, ответ 202", async () => {
    const first = (await upload([{ name: "Паспорт.pdf", buf: read("doc.pdf") }])).json();
    const r = await upload([{ name: "Паспорт.pdf.p7s", buf: read("unep.p7s") }], { process_id: first.process_id });
    expect(r.statusCode).toBe(202);
    expect(r.json().signatures).toEqual([expect.objectContaining({ document: "Паспорт.pdf", status: "VALID", kind: "UNEP" })]);
    expect((await card(first.process_id)).files[0].signature_check.status).toBe("VALID");
  });
});

describe("attachSignatures — общая точка приёма подписей", () => {
  it("файл не .sig/.p7s ничего не проверяет и не переписывает результат документа", async () => {
    const first = (await upload([{ name: "Смета.pdf", buf: read("doc.pdf") }, { name: "Смета.pdf.sig", buf: read("ukep.sig") }])).json();
    const { attachSignatures } = await import("../src/services/signature.ts");
    const ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" as const } };
    expect(await attachSignatures(ctx, first.process_id, [{ name: "Смета.pdf", buf: read("doc-tampered.pdf") }])).toEqual({ signatures: [], rejected: [] });
    expect((await card(first.process_id)).files[0].signature_check.status).toBe("VALID");
  });
});

describe("подпись не прошла проверку — документ как скан (OS-INSP-1.2.14)", () => {
  it("реестр заявляет УКЭП, подпись INVALID — REQ-… MISSING_EVIDENCE с причиной; с VALID-подписью проверки реквизитов нет", async () => {
    const manifest = {
      object: { object_id: "SIG-REQ", name: "Подпись и реквизиты" },
      files: [manifestFile("ID-BAD", "Акт-подменён.pdf", "УКЭП"), manifestFile("ID-OK", "Акт-подписан.pdf", "УКЭП")],
    };
    const r = await upload([
      { name: "Акт-подменён.pdf", buf: read("doc-tampered.pdf") }, { name: "Акт-подменён.pdf.sig", buf: read("ukep.sig") },
      { name: "Акт-подписан.pdf", buf: read("doc.pdf") }, { name: "Акт-подписан.pdf.sig", buf: read("ukep.sig") },
    ], { manifest });
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(Object.fromEntries(body.signatures.map((s: any) => [s.document, s.status]))).toEqual({ "Акт-подменён.pdf": "INVALID", "Акт-подписан.pdf": "VALID" });
    // разбор ML здесь не запускается: отмечаем документы разобранными (ML реквизитов не нашёл) и пересчитываем REQ-* так же,
    // как это делает recompute после разбора (OS-INSP-2.3.2)
    await db.run("update files set parse_status = 'DONE' where inspection_id = $1", [body.process_id]);
    const { writeRequisites } = await import("../src/services/requisites.ts");
    await writeRequisites(db, body.process_id, 1);
    const checks = (await card(body.process_id)).checks.filter((c: any) => c.param_code.startsWith("REQ-"));
    expect(checks.map((c: any) => c.param_code)).toEqual(["REQ-ID-BAD"]);
    expect(checks[0]).toMatchObject({ finding_status: "MISSING_EVIDENCE" });
    expect(checks[0].reason).toContain("в реестре подпись УКЭП");
    expect(checks[0].reason).toContain("проверка электронной подписи: INVALID");
  });
});

describe("конфиг доверенных корней (громкая проверка при старте, L7)", async () => {
  const { spawnSync } = await import("node:child_process");
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_PROFILE: "dev", ...env }, encoding: "utf8" });
  it("несуществующий каталог INSPECTOR_TRUST_DIR или INSPECTOR_QUALIFIED_ROOTS_DIR — отказ старта; существующие и пустые — старт", () => {
    const bad = load({ INSPECTOR_TRUST_DIR: join(TMP, "нет") });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("INSPECTOR_TRUST_DIR=");
    expect(load({ INSPECTOR_QUALIFIED_ROOTS_DIR: join(TMP, "нет") }).stderr).toContain("INSPECTOR_QUALIFIED_ROOTS_DIR=");
    expect(load({ INSPECTOR_TRUST_DIR: join(F, "trust"), INSPECTOR_QUALIFIED_ROOTS_DIR: join(F, "qualified") }).status).toBe(0);
    expect(load({ INSPECTOR_TRUST_DIR: "", INSPECTOR_QUALIFIED_ROOTS_DIR: "" }).status).toBe(0);
  });
});
