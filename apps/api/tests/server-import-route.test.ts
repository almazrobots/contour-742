// L2 · L4 · L6 — OS-INSP-1.2.36…1.2.39 (T-169): маршрут серверного импорта сквозь приложение (in-process, без ML).
// Файл кладётся в каталог хранилища под именем SHA-256, как это делает загрузчик; маршрут принимает его по хешу,
// сверяет содержимое, формат и антивирус (поддельный clamd в процессе теста) и помечает источник server_import.
// Документы — синтетические байты PDF/DOCX (ADR-0002).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-import-"));
const BLOBS = join(TMP, "blobs");
const MARK = "harmless-infection-marker";
let clamd: Server;
let clamdAlive = true;
let clamdDelayMs = 0;
let app: any;
let db: any;
let token = "";
let mlToken = "";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n% синтетический том ИД ${tag}\n${"x".repeat(3000)}\n%%EOF\n`);
const docx = (tag: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`[Content_Types].xml word/document.xml ${tag}`)]);
/** Как загрузчик: файл в каталог хранилища под именем SHA-256 содержимого (или под чужим — для отказа). */
const stage = (buf: Buffer, name = sha(buf)) => {
  mkdirSync(BLOBS, { recursive: true });
  writeFileSync(join(BLOBS, name), buf);
  return name;
};

beforeAll(async () => {
  clamd = createServer((sock) => {
    if (!clamdAlive) return sock.destroy();
    let acc = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      acc = Buffer.concat([acc, d]);
      if (acc.length >= 4 && acc.subarray(acc.length - 4).readUInt32BE(0) === 0) {
        const answer = acc.includes(MARK) ? "stream: Test.Marker FOUND\0" : "stream: OK\0";
        setTimeout(() => sock.end(answer), clamdDelayMs);
      }
    });
  });
  await new Promise<void>((r) => clamd.listen(0, "127.0.0.1", () => r()));
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: BLOBS, INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_AV: "clamd", INSPECTOR_CLAMD_HOST: "127.0.0.1", INSPECTOR_CLAMD_PORT: String((clamd.address() as any).port),
    INSPECTOR_ML_URL: "http://127.0.0.1:9", // ML не нужен: start=false
  });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  mlToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "ml", password: "test-pass" } })).json().token;
});
afterEach(async () => {
  clamdAlive = true;
  clamdDelayMs = 0;
  const { setBlobStoreForTests } = await import("../src/services/blobstore.ts");
  setBlobStoreForTests(null);
});
afterAll(async () => {
  clamd.close();
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const post = (payload: unknown, t = token) => app.inject({ method: "POST", url: "/api/v1/documents/import", payload, headers: { authorization: `Bearer ${t}` } });
let n = 0;
const card = () => ({ object_id: `IMP-${++n}`, name: "Синтетический объект импорта" });
const count = async (sql: string, p: unknown[] = []) => Number((await db.get(sql, p)).n);

describe("серверный импорт: приём (L2, OS-INSP-1.2.36)", () => {
  it("PDF по SHA-256 из хранилища → новая проверка, файл с источником server_import в реестре, статусе и ответе", async () => {
    const buf = pdf("ПЗ");
    const h = stage(buf);
    const r = await post({ object: card(), files: [{ sha256: h, file_name: "ПЗ том 1.pdf" }] });
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(body.accepted).toEqual([expect.objectContaining({ file_name: "ПЗ том 1.pdf", sha256: h, source: "server_import" })]);
    expect(body.rejected).toEqual([]);
    expect(await db.get("select size, kind, intake_source from files where inspection_id = $1", [body.process_id])).toMatchObject({ kind: "pdf", intake_source: "server_import" });
    const st = (await app.inject({ method: "GET", url: `/api/v1/inspection/${body.process_id}/status`, headers: { authorization: `Bearer ${token}` } })).json();
    expect(st.files[0].intake_source).toBe("server_import");
    const a = await db.get("select action, details from audit_log where action = 'FILES_IMPORTED' and object_id = $1", [body.process_id]);
    expect(a).toBeTruthy();
  });

  it("DOCX принимается; размер в реестре — длина открытого текста", async () => {
    const buf = docx("ПБ");
    const r = await post({ object: card(), files: [{ sha256: stage(buf), file_name: "ПБ.docx" }] });
    expect(r.statusCode).toBe(202);
    expect(await db.get("select kind, size from files where inspection_id = $1", [r.json().process_id])).toMatchObject({ kind: "docx" });
    expect(Number((await db.get("select size from files where inspection_id = $1", [r.json().process_id])).size)).toBe(buf.length);
  });

  it("--process-id: дозагрузка в ту же проверку, новой нет; реестр из запроса объединяется с принятым", async () => {
    const first = await post({ object: card(), files: [{ sha256: stage(pdf("т1")), file_name: "т1.pdf" }] });
    const pid = first.json().process_id;
    const before = await count("select count(*) n from inspections");
    const h2 = stage(pdf("т2"));
    const manifest = { files: [{ file_id: "ИД-2", file_name: "т2.pdf", sha256: h2, doc_stage: "ID", discipline: "ИД", document_code: "ИД-2", revision: "0" }] };
    const r = await post({ process_id: pid, manifest, files: [{ sha256: h2, file_name: "т2.pdf" }] });
    expect(r.statusCode).toBe(202);
    expect(await count("select count(*) n from inspections")).toBe(before);
    expect(await db.get("select client_file_id, doc_stage from files where inspection_id = $1 and file_name = 'т2.pdf'", [pid])).toMatchObject({ client_file_id: "ИД-2", doc_stage: "ID" });
    expect(await count("select count(*) n from files where inspection_id = $1", [pid])).toBe(2);
  });

  it("тот же файл повторно — DUPLICATE, а не второй файл", async () => {
    const h = stage(pdf("дубль"));
    const pid = (await post({ object: card(), files: [{ sha256: h, file_name: "д.pdf" }] })).json().process_id;
    const r = await post({ process_id: pid, files: [{ sha256: h, file_name: "д.pdf" }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().rejected).toEqual([expect.objectContaining({ code: "DUPLICATE" })]);
  });
});

describe("серверный импорт: отказы с причиной (L4 · L6, OS-INSP-1.2.37…1.2.39)", () => {
  it("содержимое под именем хеша чужое — IMPORT_HASH_MISMATCH, названы оба хеша, файл не зарегистрирован, отказ в журнале", async () => {
    const claimed = sha(Buffer.from("заявленный"));
    const buf = pdf("подмена");
    stage(buf, claimed);
    const r = await post({ object: card(), files: [{ sha256: claimed, file_name: "подмена.pdf" }] });
    expect(r.statusCode).toBe(400);
    const x = r.json().rejected[0];
    expect(x.code).toBe("IMPORT_HASH_MISMATCH");
    expect(x.message).toContain(claimed);
    expect(x.message).toContain(sha(buf));
    expect(await count("select count(*) n from files where inspection_id = $1", [r.json().process_id])).toBe(0);
    expect(await db.get("select code from file_rejections where inspection_id = $1", [r.json().process_id])).toMatchObject({ code: "IMPORT_HASH_MISMATCH" });
  });

  it("файла в хранилище нет — IMPORT_NOT_FOUND", async () => {
    const r = await post({ object: card(), files: [{ sha256: "f".repeat(64), file_name: "нет.pdf" }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().rejected[0]).toMatchObject({ code: "IMPORT_NOT_FOUND" });
  });

  it("символическая ссылка под именем хеша — IMPORT_NOT_FOUND: файл вне хранилища не читается", async () => {
    const outside = join(TMP, "outside.pdf");
    const buf = pdf("вне");
    writeFileSync(outside, buf);
    mkdirSync(BLOBS, { recursive: true });
    symlinkSync(outside, join(BLOBS, sha(buf)));
    const r = await post({ object: card(), files: [{ sha256: sha(buf), file_name: "ссылка.pdf" }] });
    expect(r.json().rejected[0]).toMatchObject({ code: "IMPORT_NOT_FOUND" });
  });

  it("не PDF и не DOCX (XLSX, XML, изображение) — UNSUPPORTED_FORMAT; PDF без конца файла — CORRUPTED", async () => {
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml xl/workbook.xml")]);
    const xml = Buffer.from("<?xml version='1.0'?><акт/>");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IEND")]);
    const broken = Buffer.from("%PDF-1.7\n1 0 obj\n");
    const r = await post({ object: card(), files: [xlsx, xml, png, broken].map((b, i) => ({ sha256: stage(b), file_name: `f${i}` })) });
    expect(r.json().rejected.map((x: any) => x.code)).toEqual(["UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT", "CORRUPTED"]);
    // в карантин уходит только чужое содержимое (хеш не сошёлся), а не файл неподдерживаемого формата
    const { readdirSync } = await import("node:fs");
    for (const b of [xlsx, xml, png, broken]) expect(readdirSync(BLOBS).includes(sha(b))).toBe(true);
  });

  it("антивирус: угроза — INFECTED; сканер недоступен — SCAN_UNAVAILABLE (закрыто при сбое); оба — в аудит", async () => {
    const bad = stage(Buffer.from(`%PDF-1.7\n${MARK}\n%%EOF\n`));
    const r1 = await post({ object: card(), files: [{ sha256: bad, file_name: "вирус.pdf" }] });
    expect(r1.json().rejected[0]).toMatchObject({ code: "INFECTED" });
    clamdAlive = false;
    const r2 = await post({ object: card(), files: [{ sha256: stage(pdf("без сканера")), file_name: "без сканера.pdf" }] });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().rejected[0]).toMatchObject({ code: "SCAN_UNAVAILABLE" });
    expect(await count("select count(*) n from audit_log where action in ('FILE_INFECTED', 'FILE_SCAN_FAILED') and object_id in ($1, $2)", [r1.json().process_id, r2.json().process_id])).toBe(2);
  });

  it("часть файлов принята, часть нет — 202 с отказами по каждому", async () => {
    const r = await post({ object: card(), files: [{ sha256: stage(pdf("ок")), file_name: "ок.pdf" }, { sha256: "e".repeat(64), file_name: "нет.pdf" }] });
    expect(r.statusCode).toBe(202);
    expect(r.json().accepted).toHaveLength(1);
    expect(r.json().rejected).toEqual([expect.objectContaining({ file_name: "нет.pdf", code: "IMPORT_NOT_FOUND" })]);
  });

  it("S3 недоступно — 503 единым форматом ошибки, файл не зарегистрирован", async () => {
    const { setBlobStoreForTests, TieredBlobStore } = await import("../src/services/blobstore.ts");
    const down = { head: async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }, put: async () => {}, get: async () => null };
    setBlobStoreForTests(new TieredBlobStore(BLOBS, down, { bucket: "b", prefix: "p/", key: Buffer.alloc(32, 1) }));
    const c = card();
    const r = await post({ object: c, files: [{ sha256: stage(pdf("s3")), file_name: "s3.pdf" }] });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/Хранилище файлов недоступно/);
    expect(await count("select count(*) n from files f join inspections i on i.id = f.inspection_id where i.object_id = $1", [c.object_id])).toBe(0);
  });
});

describe("серверный импорт: вход (L6, NFR-API-JSON, OS-INSP-4.1.26)", () => {
  it("не JSON — 415: multipart и text/plain", async () => {
    const mp = await app.inject({ method: "POST", url: "/api/v1/documents/import", payload: "--b\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\n1\r\n--b--\r\n", headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=b" } });
    expect(mp.statusCode).toBe(415);
    expect(mp.json()).toHaveProperty("error");
    const tp = await app.inject({ method: "POST", url: "/api/v1/documents/import", payload: "x", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" } });
    expect(tp.statusCode).toBe(415);
  });
  it("путь вместо хеша, лишнее поле, пустой список — 400 по схеме, до диска", async () => {
    for (const payload of [
      { object: card(), files: [{ sha256: "../../etc/passwd", file_name: "x.pdf" }] },
      { object: card(), files: [{ sha256: "a".repeat(64), file_name: "x.pdf", path: "/etc/passwd" }] },
      { object: card(), files: [] },
      { files: [{ sha256: "a".repeat(64), file_name: "x.pdf" }] },
    ]) {
      const r = await post(payload);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toHaveProperty("error");
    }
  });
  it("без входа — 401; роль без inspection.work — 403 до чтения тела", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/documents/import", payload: {} })).statusCode).toBe(401);
    expect((await post({ object: card(), files: [{ sha256: "a".repeat(64), file_name: "x.pdf" }] }, mlToken)).statusCode).toBe(403);
  });
  it("проверки нет — 404; финализирована — 409 до чтения файлов", async () => {
    expect((await post({ process_id: "P-нет", files: [{ sha256: "a".repeat(64), file_name: "x.pdf" }] })).statusCode).toBe(404);
    const pid = (await post({ object: card(), files: [{ sha256: stage(pdf("фин")), file_name: "фин.pdf" }] })).json().process_id;
    await db.run("update inspections set status = 'FINALIZED' where id = $1", [pid]);
    const r = await post({ process_id: pid, files: [{ sha256: stage(pdf("после")), file_name: "после.pdf" }] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/финализирован/);
  });
});

describe("OWASP T-169: исправления находок аудита (L4 · L6)", () => {
  const keyed = async (workMaxBytes = 1024 ** 3) => {
    const { setBlobStoreForTests, FsBlobStore, LocalAtRest } = await import("../src/services/blobstore.ts");
    const { makeKeyring } = await import("../src/domain/at-rest.ts");
    setBlobStoreForTests(new FsBlobStore(BLOBS, undefined, new LocalAtRest({ keyring: makeKeyring(Buffer.alloc(32, 4)), workDir: join(TMP, "work"), workMaxBytes })));
  };

  it("M-003: уже принятое содержимое — DUPLICATE_CONTENT без чтения с диска (файла уже нет, а отказ — дубль, не NOT_FOUND)", async () => {
    const buf = pdf("ранний дубль");
    const h = stage(buf);
    const pid = (await post({ object: card(), files: [{ sha256: h, file_name: "раз.pdf" }] })).json().process_id;
    unlinkSync(join(BLOBS, h));
    const r = await post({ process_id: pid, files: [{ sha256: h, file_name: "два.pdf" }] });
    expect(r.json().rejected).toEqual([expect.objectContaining({ file_name: "два.pdf", code: "DUPLICATE_CONTENT", duplicate_of: "раз.pdf" })]);
    stage(buf); // вернуть: хранилище общее для тестов файла
  });

  it("M-003: повтор SHA-256 в запросе — 400 по схеме", async () => {
    const h = stage(pdf("повтор"));
    expect((await post({ object: card(), files: [{ sha256: h, file_name: "a.pdf" }, { sha256: h, file_name: "b.pdf" }] })).statusCode).toBe(400);
  });

  it("M-003: второй импорт того же пользователя, пока идёт первый, — 429; после окончания — снова можно", async () => {
    clamdDelayMs = 400;
    const first = post({ object: card(), files: [{ sha256: stage(pdf("долгий")), file_name: "долгий.pdf" }] });
    await new Promise((r) => setTimeout(r, 100));
    const second = await post({ object: card(), files: [{ sha256: stage(pdf("второй")), file_name: "второй.pdf" }] });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatch(/Серверный импорт уже идёт/);
    expect((await first).statusCode).toBe(202);
    clamdDelayMs = 0;
    expect((await post({ object: card(), files: [{ sha256: stage(pdf("третий")), file_name: "третий.pdf" }] })).statusCode).toBe(202);
  });

  it("M-002: хранилище шифрует, файл положен открытым текстом — IMPORT_NOT_ENCRYPTED; IBE1 под ключом — принят", async () => {
    await keyed();
    const plainPdf = pdf("открытый");
    const r1 = await post({ object: card(), files: [{ sha256: stage(plainPdf), file_name: "открытый.pdf" }] });
    expect(r1.json().rejected[0]).toMatchObject({ code: "IMPORT_NOT_ENCRYPTED" });
    const { stageBlob } = await import("../src/services/stage-blob.ts");
    const encPdf = pdf("зашифрованный");
    await stageBlob(BLOBS, sha(encPdf), async (on) => on(encPdf), Buffer.alloc(32, 4));
    const r2 = await post({ object: card(), files: [{ sha256: sha(encPdf), file_name: "зашифрованный.pdf" }] });
    expect(r2.statusCode).toBe(202);
  });

  it("M-004: при шифровании файл больше рабочего каталога ML — IMPORT_TOO_LARGE", async () => {
    await keyed(1000);
    const { stageBlob } = await import("../src/services/stage-blob.ts");
    const big = pdf("больше tmpfs");
    await stageBlob(BLOBS, sha(big), async (on) => on(big), Buffer.alloc(32, 4));
    const r = await post({ object: card(), files: [{ sha256: sha(big), file_name: "больше.pdf" }] });
    expect(r.json().rejected[0]).toMatchObject({ code: "IMPORT_TOO_LARGE" });
  });

  it("L-005 · L-008: источник изменился во время проверки антивирусом — отказ без пути и текста системной ошибки", async () => {
    const { clamdScanStream } = await import("../src/services/antivirus.ts");
    const { hashTap } = await import("../src/services/blobstore.ts");
    async function* swapped() { yield Buffer.from("%PDF-1.7 чистый двойник\n%%EOF\n"); }
    const r = await clamdScanStream(hashTap("a".repeat(64), swapped()), "127.0.0.1", Number(process.env.INSPECTOR_CLAMD_PORT));
    expect(r).toEqual({ status: "error", message: "файл не прочитан для проверки или изменился во время неё" });
  });

  it("HIGH-001: файл больше 50 МБ отдаётся диапазоном потоком, без чтения целиком (get не зовётся)", async () => {
    const { FsBlobStore, setBlobStoreForTests } = await import("../src/services/blobstore.ts");
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(51 * 1024 * 1024, 0x20), Buffer.from("\n%%EOF\n")]);
    const h = stage(big);
    const pid = (await post({ object: card(), files: [{ sha256: h, file_name: "том 51.pdf" }] })).json().process_id;
    const fid = (await db.get("select id from files where inspection_id = $1", [pid])).id;
    const st = new FsBlobStore(BLOBS);
    st.get = async () => { throw new Error("get() читает файл целиком"); };
    setBlobStoreForTests(st);
    const auth = { authorization: `Bearer ${token}` };
    const part = await app.inject({ method: "GET", url: `/api/v1/files/${fid}/content`, headers: { ...auth, range: "bytes=0-7" } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.toString()).toBe("%PDF-1.7");
    expect(part.headers["content-range"]).toBe(`bytes 0-7/${big.length}`);
    const tail = await app.inject({ method: "GET", url: `/api/v1/files/${fid}/content`, headers: { ...auth, range: `bytes=${big.length - 6}-` } });
    expect(tail.rawPayload.toString()).toBe("%%EOF\n");
    expect((await app.inject({ method: "GET", url: `/api/v1/files/${fid}/content`, headers: { ...auth, range: `bytes=${big.length}-` } })).statusCode).toBe(416);
    const full = await app.inject({ method: "GET", url: `/api/v1/files/${fid}/content`, headers: auth });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(big.length);
    // подмена на диске после первой проверки — изменились размер и mtime, копия проверяется заново и не отдаётся
    writeFileSync(join(BLOBS, h), Buffer.from("%PDF-1.7 подмена\n%%EOF\n"));
    expect((await app.inject({ method: "GET", url: `/api/v1/files/${fid}/content`, headers: { ...auth, range: "bytes=0-7" } })).statusCode).toBe(500);
    unlinkSync(join(BLOBS, h));
  });
});

describe("серверный импорт: ветки сервиса (L4 · L6, добивка мутаций)", () => {
  it("хеш не сошёлся — непроверенный файл уходит в карантин, имя хеша свободно; принятый хеш в карантин не уходит", async () => {
    const { readdirSync } = await import("node:fs");
    const claimed = sha(Buffer.from("карантин-заявленный"));
    stage(pdf("карантин-подмена"), claimed);
    await post({ object: card(), files: [{ sha256: claimed, file_name: "к.pdf" }] });
    expect(readdirSync(BLOBS).includes(claimed)).toBe(false);
    expect(readdirSync(BLOBS).some((n) => n.startsWith(`.${claimed}.rejected-`))).toBe(true);

    const good = pdf("принятый-хеш");
    const h = stage(good);
    expect((await post({ object: card(), files: [{ sha256: h, file_name: "принят.pdf" }] })).statusCode).toBe(202);
    stage(pdf("порча принятого"), h); // файл принятого документа испорчен на диске
    const r = await post({ object: card(), files: [{ sha256: h, file_name: "снова.pdf" }] });
    expect(r.json().rejected[0]).toMatchObject({ code: "IMPORT_HASH_MISMATCH" });
    expect(readdirSync(BLOBS).includes(h)).toBe(true); // порчу увидит проверка целостности — не прячем
    stage(good);
  });

  it("файл исчез или подменён между проверкой и копией в хранилище — IMPORT_NOT_FOUND / IMPORT_HASH_MISMATCH, не 503", async () => {
    const { BlobIntegrityError, BlobNotFound, FsBlobStore, setBlobStoreForTests } = await import("../src/services/blobstore.ts");
    const h = stage(pdf("гонка"));
    for (const [err, code] of [[new BlobNotFound(h), "IMPORT_NOT_FOUND"], [new BlobIntegrityError(h, "SHA-256 потока не совпал с ожидаемым"), "IMPORT_HASH_MISMATCH"]] as const) {
      const st = new FsBlobStore(BLOBS);
      st.adopt = async () => { throw err; };
      setBlobStoreForTests(st);
      const r = await post({ object: card(), files: [{ sha256: h, file_name: "гонка.pdf" }] });
      expect(r.statusCode).toBe(400);
      expect(r.json().rejected[0]).toMatchObject({ code, message: expect.stringContaining("гонка.pdf: ") });
    }
    const st = new FsBlobStore(BLOBS);
    st.adopt = async () => { throw new Error("неожиданное"); };
    setBlobStoreForTests(st);
    expect((await post({ object: card(), files: [{ sha256: h, file_name: "гонка.pdf" }] })).statusCode).toBe(500);
  });

  it("карточка объекта из реестра (manifest.object), если object не передан", async () => {
    const h = stage(pdf("карточка из реестра"));
    const manifest = { object: { object_id: "IMP-MANIFEST-OBJ", name: "Объект из реестра" }, files: [{ file_id: "F-1", file_name: "р.pdf", doc_stage: "PD", discipline: "ПЗ", document_code: "П-1", revision: "0" }] };
    const r = await post({ manifest, files: [{ sha256: h, file_name: "р.pdf" }] });
    expect(r.statusCode).toBe(202);
    expect(await db.get("select object_id from inspections where id = $1", [r.json().process_id])).toEqual({ object_id: "IMP-MANIFEST-OBJ" });
  });

  it("метки скрытого теста — HIDDEN_TEST_LABELS до чтения с диска", async () => {
    const labels = sha(Buffer.from("метки скрытого теста T-169"));
    await db.run("insert into hidden_seals (name, digest, files_json, n_files, n_labels, sealed_at, sealed_by) values ($1,$2,$3,1,1,$4,$5)", [
      "t169-labels", "c".repeat(64), JSON.stringify([{ sha256: labels, role: "labels" }]), new Date().toISOString(), "test",
    ]);
    const r = await post({ object: card(), files: [{ sha256: labels, file_name: "annotations.jsonl" }] });
    expect(r.json().rejected).toEqual([expect.objectContaining({ code: "HIDDEN_TEST_LABELS" })]);
  });

  it("start: true — разбор запускается сразу; без принятых файлов — не запускается", async () => {
    const ok = await post({ object: card(), start: true, files: [{ sha256: stage(pdf("старт")), file_name: "старт.pdf" }] });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().status).toBe("PARSING");
    const none = await post({ object: card(), start: true, files: [{ sha256: "d".repeat(64), file_name: "нет.pdf" }] });
    expect(none.json().status).toBe("PENDING");
  });

  it("тексты отказов дубля и 429 — с именем файла и причиной", async () => {
    const h = stage(pdf("тексты"));
    const pid = (await post({ object: card(), files: [{ sha256: h, file_name: "т.pdf" }] })).json().process_id;
    expect((await post({ process_id: pid, files: [{ sha256: h, file_name: "т.pdf" }] })).json().rejected[0].message).toBe("т.pdf: файл уже принят");
    expect((await post({ process_id: pid, files: [{ sha256: h, file_name: "т2.pdf" }] })).json().rejected[0].message).toBe("т2.pdf: то же содержимое уже принято как т.pdf");
  });
});
