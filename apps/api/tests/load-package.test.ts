// L2 · L6 — OS-INSP-1.2.20…1.2.27, 5.1.7: загрузчик пакета сквозь настоящий маршрут приёма (in-process, без ML:
// start=false). Синтетический ZIP в CP866 с дубликатом грузится двумя частями в одну проверку; выходной набор — опись SHA-256.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip } from "./zip-builder.ts";

const TMP = mkdtempSync(join(tmpdir(), "inspector-loader-"));
let app: any;
let db: any;
let loader: typeof import("../src/cli/load-package.ts");
let outset: typeof import("../src/cli/output-set.ts");
const API = "https://inspector.test"; // https: пароль по открытому http загрузчик и сборщик набора не отправляют (SEC-09)

const pdf = (tag: string, pad: number) => Buffer.from(`%PDF-1.4\n% ${tag}\n${"x".repeat(pad)}\n%%EOF\n`);

/** Транспорт загрузчика поверх app.inject — тот же разбор multipart, авторизация и приём, что у сервера. */
const injectHttp = async (req: { method: string; url: string; headers?: Record<string, string>; body?: Buffer }) => {
  const u = new URL(req.url);
  const r = await app.inject({ method: req.method, url: u.pathname + u.search, headers: req.headers, payload: req.body });
  return { status: r.statusCode, headers: r.headers, body: r.rawPayload as Buffer };
};

beforeAll(async () => {
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"),
    INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_AV: "off",
    INSPECTOR_ML_URL: "http://127.0.0.1:9", // ML не нужен: разбор не запускается
    INSPECTOR_RIN_URL: "http://rin.invalid",
  });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  loader = await import("../src/cli/load-package.ts");
  outset = await import("../src/cli/output-set.ts");
  db = await openDb("memory");
  app = await buildApp(db);
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const PZ = pdf("pz", 1200);
const AR = pdf("ar", 1200);
const VK = pdf("vk", 1200);
const AOSR = pdf("aosr", 300);
const BIG = pdf("big", 5000);

function packageZip(): string {
  const p = join(TMP, "пакет.zip");
  writeFileSync(
    p,
    buildZip([
      { name: "Объект 2099/", data: Buffer.alloc(0) },
      { name: "Объект 2099/Проектная документация/1. П-2099-01.001-ПЗ.pdf", data: PZ, deflate: true },
      { name: "Объект 2099/Проектная документация/1. П-2099-01.001-ПЗ 2024.pdf", data: PZ, deflate: true }, // дубликат
      { name: "Объект 2099/Рабочая документация/РД-2099-01-001-АР1.pdf", data: AR },
      { name: "Объект 2099/Рабочая документация/Р-2099-01.001-ВК1.pdf", data: VK, deflate: true, descriptor: true },
      { name: "Объект 2099/Исполнительная документация/АОСР 1.pdf", data: AOSR, utf8: true },
      { name: "Объект 2099/Рабочая документация/Том большой.pdf", data: BIG },
      { name: "__MACOSX/Объект 2099/._x.pdf", data: Buffer.from("junk") },
    ]),
  );
  return p;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const base = { api: API, login: "inspector", password: "test-pass", start: false, batch: { maxBytes: 3000, maxFileBytes: 4000 } };

describe("загрузчик пакета сквозь маршрут приёма (L2)", () => {
  it("ZIP → одна проверка двумя частями: уникальные приняты, дубликат не передан, стадии по папкам, реестр выведен, без утверждения", async () => {
    const logs: string[] = [];
    const zip = packageZip();
    const out = join(TMP, "intake");
    const r = await loader.loadPackage({ ...base, inputs: [zip], object: { object_id: "SYN-2099", name: "Синтетический объект", address: "ул. Тестовая, 1" }, out, log: (s) => logs.push(s) }, injectHttp);

    expect(r.input).toMatchObject({ kind: "zip", archive_sha256: sha(readFileSync(zip)), archive_bytes: readFileSync(zip).length });
    expect(r.entries).toMatchObject({ total: 7, documents: 6, unique: 5, junk_skipped: ["__MACOSX/Объект 2099/._x.pdf"] });
    expect(r.entries.duplicates).toEqual([{ path: "Объект 2099/Проектная документация/1. П-2099-01.001-ПЗ 2024.pdf", same_as: "Объект 2099/Проектная документация/1. П-2099-01.001-ПЗ.pdf", sha256: sha(PZ) }]);
    expect(r.local_rejected).toEqual([expect.objectContaining({ path: "Объект 2099/Рабочая документация/Том большой.pdf", code: "FILE_TOO_LARGE" })]);

    // две части, одна проверка
    expect(r.parts.length).toBe(2);
    expect(r.parts.every((p) => p.process_id === r.process_id && p.http_status === 202 && p.bytes <= 3000)).toBe(true);
    expect(r.parts.map((p) => p.files)).toEqual([2, 2]);
    expect((await db.get("select count(*) n from inspections")).n).toBe(1);

    // принятые файлы и их стадии
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((a) => [a.file_name, a.doc_stage])).toEqual([
      ["1. П-2099-01.001-ПЗ.pdf", "PD"],
      ["РД-2099-01-001-АР1.pdf", "RD"],
      ["Р-2099-01.001-ВК1.pdf", "RD"],
      ["АОСР 1.pdf", "ID"],
    ]);
    const rows = await db.all("select file_name, doc_stage, discipline, document_code, revision, approval_status, sha256 from files where inspection_id = $1 order by file_name", [r.process_id]);
    expect(rows).toHaveLength(4);
    expect(rows.find((x: any) => x.file_name === "РД-2099-01-001-АР1.pdf")).toMatchObject({ doc_stage: "RD", discipline: "АР", document_code: "РД-2099-01-001-АР1", revision: "0", approval_status: null, sha256: sha(AR) });
    expect(rows.find((x: any) => x.file_name === "АОСР 1.pdf")).toMatchObject({ doc_stage: "ID", discipline: "—", document_code: "АОСР 1" });
    expect(rows.every((x: any) => x.approval_status === null)).toBe(true);

    // реестр выведен, объединён сервером из двух частей
    expect(r.registry).toMatchObject({ source: "derived", approval_source: "none", files: 5 });
    const insp = await db.get("select manifest_json, status from inspections where id = $1", [r.process_id]);
    expect(JSON.parse(insp.manifest_json).files).toHaveLength(4);
    expect(r.started).toBe(false);
    expect(r.final_status).toBe(insp.status);

    // отчёт о приёме на диске
    const json = JSON.parse(readFileSync(join(out, "intake-report.json"), "utf8"));
    expect(json).toMatchObject({ schema: "inspector.intake-report/2", process_id: r.process_id, process_id_given: false, server_import: [] });
    const md = readFileSync(join(out, "intake-report.md"), "utf8");
    expect(md).toContain("реестр выведен");
    expect(md).toContain("1. П-2099-01.001-ПЗ 2024.pdf");
    expect(md).toContain("FILE_TOO_LARGE");
    expect(md).toContain("не задан — подтверждения оператора не было");
    expect(md).not.toContain("test-pass");
    expect(JSON.stringify(json)).not.toContain("test-pass");
    expect(logs.some((l) => l.includes("частей 2"))).toBe(true);
  });

  it("--approval: статус утверждения ставится по подтверждению оператора (ПД/ИД APPROVED, РД FOR_CONSTRUCTION)", async () => {
    const r = await loader.loadPackage({ ...base, inputs: [packageZip()], object: { object_id: "SYN-2099-A", name: "Синтетика" }, approval: true, log: () => {} }, injectHttp);
    expect(r.registry.approval_source).toBe("operator");
    const rows = await db.all("select doc_stage, approval_status from files where inspection_id = $1", [r.process_id]);
    expect(rows.map((x: any) => `${x.doc_stage}:${x.approval_status}`).sort()).toEqual(["ID:APPROVED", "PD:APPROVED", "RD:FOR_CONSTRUCTION", "RD:FOR_CONSTRUCTION"]);
  });

  it("папка с реестром manifest.json: реестр найден и не передаётся как документ; запуск разбора без ML — start", async () => {
    const dir = join(TMP, "folder");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "ПД"), { recursive: true });
    writeFileSync(join(dir, "ПД", "a.pdf"), PZ);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ files: [{ file_id: "F-1", file_name: "a.pdf", doc_stage: "PD", discipline: "ПЗ", document_code: "П-2099-01-001-ПЗ", revision: "2", approval_status: "APPROVED" }] }),
    );
    const r = await loader.loadPackage({ ...base, inputs: [dir], object: { object_id: "SYN-DIR", name: "Папка" }, log: () => {} }, injectHttp);
    expect(r.input.kind).toBe("dir");
    expect(r.registry).toMatchObject({ source: "found", file: "manifest.json", approval_source: "registry" });
    expect(r.accepted.map((a) => a.file_name)).toEqual(["a.pdf"]);
    expect(await db.get("select client_file_id, revision, approval_status from files where inspection_id = $1", [r.process_id])).toMatchObject({ client_file_id: "F-1", revision: "2", approval_status: "APPROVED" });
  });

  it("выходной набор: протокол не сформирован — ошибка с кодом; с поддельным протоколом не собирается", async () => {
    const r = await loader.loadPackage({ ...base, inputs: [packageZip()], object: { object_id: "SYN-OUT", name: "Набор" }, log: () => {} }, injectHttp);
    await expect(outset.buildOutputSet({ api: API, processId: r.process_id!, out: join(TMP, "set0"), login: "inspector", password: "test-pass" }, injectHttp, () => {})).rejects.toThrow(/Протокол json: сервер ответил 409/);
  });

  it("адрес API для входа по паролю: https — да; http — только на петле (SEC-09)", () => {
    expect(loader.checkApiUrl("https://stand.example:45843")).toBe("https://stand.example:45843");
    expect(loader.checkApiUrl("http://127.0.0.1:45810")).toBe("http://127.0.0.1:45810");
    expect(loader.checkApiUrl("http://localhost:45810")).toBe("http://localhost:45810");
    expect(() => loader.checkApiUrl("http://10.0.0.5:45810")).toThrow(/только через https/);
    expect(() => loader.checkApiUrl("ftp://127.0.0.1")).toThrow(/только через https/);
  });

  it("выходной набор: адрес API по открытому http не с петли — отказ до входа, пароль не уходит (SEC-09)", async () => {
    let called = 0;
    const spy = async () => { called++; return { status: 500, headers: {}, body: Buffer.from("") }; };
    await expect(outset.buildOutputSet({ api: "http://10.0.0.5:45810", processId: "P-1", out: join(TMP, "never2"), login: "l", password: "p" }, spy as any, () => {})).rejects.toThrow(/только через https/);
    expect(called).toBe(0);
  });

  it("выходной набор: --param не код параметра («../») — отказ до входа и до записи (SEC-10)", async () => {
    let called = 0;
    const spy = async () => { called++; return { status: 500, headers: {}, body: Buffer.from("") }; };
    await expect(outset.buildOutputSet({ api: API, processId: "P-1", out: join(TMP, "never"), login: "l", password: "p", param: "../../etc/x" }, spy as any, () => {})).rejects.toThrow(/ждём код параметра вида M-023/);
    expect(called).toBe(0);
    expect(() => readdirSync(join(TMP, "never"))).toThrow();
  });

  it("неверный пароль — вход не выполнен, пароль в сообщении не звучит", async () => {
    const err = await loader.loadPackage({ ...base, password: "wrong-secret", inputs: [packageZip()], object: { object_id: "X", name: "X" }, log: () => {} }, injectHttp).catch((e) => e);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain("wrong-secret");
  });
});

describe("загрузчик: отказ архива целиком (L6)", () => {
  it("архив с выходом за каталог — отказ до входа на сервер", async () => {
    const p = join(TMP, "evil.zip");
    writeFileSync(p, buildZip([{ name: "../x.pdf", data: PZ }]));
    let calls = 0;
    const counting = async (req: any) => (calls++, injectHttp(req));
    const err = await loader.loadPackage({ ...base, inputs: [p], object: { object_id: "E", name: "E" }, log: () => {} }, counting).catch((e) => e);
    expect(err.code).toBe("TRAVERSAL");
    expect(calls).toBe(0);
  });
});

describe("выходной набор (L2, OS-INSP-5.1.7, 6.5.9)", () => {
  // Сервер отдаёт протокол только после разбора (нужен ML) — здесь транспорт-заглушка с ответами формата API
  const protocol = { protocol_version: 3, versions: { matrix_version: "m-1", model_version: "ml-2", dataset_version: "d-3", input_manifest_hash: "h".repeat(64) } };
  const fake = async (req: { method: string; url: string }) => {
    const u = new URL(req.url);
    const ok = (b: string | Buffer) => ({ status: 200, headers: {}, body: Buffer.isBuffer(b) ? b : Buffer.from(b) });
    if (u.pathname === "/api/v1/auth/login") return ok(JSON.stringify({ token: "t" }));
    if (u.pathname.endsWith("/status")) return ok(JSON.stringify({ process_id: "P-1", status: "READY" }));
    if (u.pathname.endsWith("/protocol/export")) {
      const f = u.searchParams.get("format")!;
      return ok(f === "json" ? JSON.stringify(protocol) : `${f}-body`);
    }
    if (u.pathname === "/api/v1/params/M-023/passport") return { status: 404, headers: {}, body: Buffer.from("{}") };
    return { status: 500, headers: {}, body: Buffer.alloc(0) };
  };

  it("MATCH: четыре формата, статус, отчёты, опись SHA-256 сходится; паспорта нет — пропущен с пометкой", async () => {
    const out = join(TMP, "set-match");
    const intake = join(TMP, "intake", "intake-report.json");
    const ver = join(TMP, "ver-ok.json");
    writeFileSync(ver, JSON.stringify({ verdict: "MATCH" }));
    const res = await outset.buildOutputSet({ api: API, processId: "P-1", out, login: "l", password: "p", intake, verification: ver }, fake, () => {});
    expect(res.verified).toBe(true);
    expect(res.versions).toEqual({ protocol_version: "3", matrix_version: "m-1", model_version: "ml-2", dataset_version: "d-3", input_manifest_hash: "h".repeat(64) });
    expect(readdirSync(out).sort()).toEqual(["MANIFEST.sha256", "README.md", "intake-report.json", "intake-report.md", "protocol.docx", "protocol.json", "protocol.pdf", "protocol.xml", "status.json", "verification.json"]);
    const lines = readFileSync(join(out, "MANIFEST.sha256"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(9);
    for (const l of lines) {
      const [h, name] = l.split("  ");
      expect(sha(readFileSync(join(out, name)))).toBe(h);
    }
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("`P-1`");
    expect(readme).toContain("matrix_version: `m-1`");
    expect(readme).toContain("MATCH");
    expect(readme).not.toContain("UNVERIFIED");
    expect(readme).toContain("passport-M-023.json: эндпоинт паспорта ответил 404");
  });

  it("расхождение верификации — UNVERIFIED в README и флаг с полем расхождения", async () => {
    const out = join(TMP, "set-mismatch");
    const ver = join(TMP, "ver-bad.json");
    writeFileSync(ver, JSON.stringify({ verdict: "MISMATCH", mismatches: [{ field: "checks[M-023].value" }] }));
    const res = await outset.buildOutputSet({ api: API, processId: "P-1", out, login: "l", password: "p", verification: ver }, fake, () => {});
    expect(res.verified).toBe(false);
    expect(res.mismatch).toEqual(["checks[M-023].value"]);
    expect(readFileSync(join(out, "UNVERIFIED"), "utf8")).toContain("checks[M-023].value");
    expect(readFileSync(join(out, "README.md"), "utf8")).toMatch(/UNVERIFIED[\s\S]*checks\[M-023\]\.value/);
    expect(readFileSync(join(out, "MANIFEST.sha256"), "utf8")).toContain("  UNVERIFIED");
  });

  it("без отчёта верификации набор тоже UNVERIFIED", async () => {
    const out = join(TMP, "set-none");
    const res = await outset.buildOutputSet({ api: API, processId: "P-1", out, login: "l", password: "p" }, fake, () => {});
    expect(res.verified).toBeNull();
    expect(readFileSync(join(out, "UNVERIFIED"), "utf8")).toContain("не проводилась");
  });

  it("verificationMismatch: поля из разных форм отчёта", () => {
    expect(outset.verificationMismatch({ verdict: "MATCH" })).toEqual({ verified: true, fields: [] });
    expect(outset.verificationMismatch({ verdict: "DIFF", fields: ["a", { path: "b" }], field: "c" })).toEqual({ verified: false, fields: ["a", "b", "c"] });
    expect(outset.verificationMismatch(null)).toEqual({ verified: false, fields: [] });
  });
});

// ─────────────────────────────── T-169: серверный импорт, дозагрузка в проверку, порции (OS-INSP-1.2.36…1.2.43)

describe("загрузчик: серверный импорт и дозагрузка (L2 · L4 · L6, OS-INSP-1.2.36…1.2.43)", () => {
  const BLOBS = () => join(TMP, "blobs"); // каталог хранилища API в этом тесте (INSPECTOR_BLOB_DIR)
  const folder = (name: string, files: Record<string, Buffer>) => {
    const dir = join(TMP, name);
    for (const [rel, buf] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), buf);
    }
    return dir;
  };

  it("файл больше предела → серверный импорт: положен в хранилище, принят по SHA-256, источник помечен в реестре и отчёте", async () => {
    const out = join(TMP, "intake-import");
    const r = await loader.loadPackage({ ...base, inputs: [packageZip()], importDir: BLOBS(), object: { object_id: "SYN-IMP", name: "Импорт" }, out, log: () => {} }, injectHttp);
    expect(r.local_rejected).toEqual([]);
    expect(r.server_import).toEqual([expect.objectContaining({ path: "Объект 2099/Рабочая документация/Том большой.pdf", sha256: sha(BIG), bytes: BIG.length, accepted: true, code: null, http_status: 202 })]);
    expect(["written", "present"]).toContain(r.server_import[0].staged);
    expect(readFileSync(join(BLOBS(), sha(BIG))).equals(BIG)).toBe(true);
    expect(r.accepted.find((a) => a.file_name === "Том большой.pdf")).toMatchObject({ source: "server_import", doc_stage: "RD" });
    expect(r.accepted.filter((a) => a.source === "upload")).toHaveLength(4);
    expect(await db.get("select intake_source, doc_stage from files where inspection_id = $1 and file_name = 'Том большой.pdf'", [r.process_id])).toEqual({ intake_source: "server_import", doc_stage: "RD" });
    expect((await db.get("select count(*) n from files where inspection_id = $1 and intake_source = 'upload'", [r.process_id])).n).toBe(4);
    const md = readFileSync(join(out, "intake-report.md"), "utf8");
    expect(md).toContain("Серверный импорт (OS-INSP-1.2.36)");
    expect(md).toContain("| 5 | 1 | 0 | 0 |"); // принято 5, из них импортом 1, отказов нет, не передано 0
  });

  it("без --import-dir большой файл не пропускается молча: FILE_TOO_LARGE с подсказкой в отчёте (OS-INSP-1.2.43)", async () => {
    const r = await loader.loadPackage({ ...base, inputs: [packageZip()], object: { object_id: "SYN-NOIMP", name: "Без импорта" }, log: () => {} }, injectHttp);
    expect(r.local_rejected).toEqual([expect.objectContaining({ code: "FILE_TOO_LARGE", message: expect.stringContaining("--import-dir") })]);
    expect(r.server_import).toEqual([]);
  });

  it("содержимое в хранилище подменено до регистрации — IMPORT_HASH_MISMATCH в отчёте, файл не принят", async () => {
    const dir = folder("hash-mm", { "ИД/том.pdf": pdf("том-подмена", 6000), "ПД/пз.pdf": pdf("пз-подмена", 500) });
    const evil = async (req: any) => {
      if (req.url.endsWith("/api/v1/documents/import")) {
        const { files } = JSON.parse(req.body.toString());
        writeFileSync(join(BLOBS(), files[0].sha256), pdf("чужое", 6000));
      }
      return injectHttp(req);
    };
    const r = await loader.loadPackage({ ...base, inputs: [dir], importDir: BLOBS(), object: { object_id: "SYN-MM", name: "Подмена" }, log: () => {} }, evil);
    expect(r.server_import[0]).toMatchObject({ accepted: false, code: "IMPORT_HASH_MISMATCH", http_status: 400 });
    expect(r.rejected).toEqual([expect.objectContaining({ path: "ИД/том.pdf", code: "IMPORT_HASH_MISMATCH" })]);
    expect((await db.get("select count(*) n from files where inspection_id = $1", [r.process_id])).n).toBe(1);
  });

  it("--process-id: пакет дозагружен в ту же проверку, новой нет; большой файл — туда же", async () => {
    const a = await loader.loadPackage({ ...base, inputs: [folder("pid-a", { "ПД/а.pdf": pdf("pid-а", 400) })], object: { object_id: "SYN-PID", name: "Дозагрузка" }, log: () => {} }, injectHttp);
    const before = (await db.get("select count(*) n from inspections")).n;
    const out = join(TMP, "intake-pid");
    const b = await loader.loadPackage({ ...base, inputs: [folder("pid-b", { "ИД/б.pdf": pdf("pid-б", 400), "ИД/том-б.pdf": pdf("pid-том", 6000) })], processId: a.process_id!, importDir: BLOBS(), out, log: () => {} }, injectHttp);
    expect(b.process_id).toBe(a.process_id);
    expect(b.process_id_given).toBe(true);
    expect((await db.get("select count(*) n from inspections")).n).toBe(before);
    expect((await db.all("select file_name, intake_source from files where inspection_id = $1 order by file_name", [a.process_id])).map((x: any) => `${x.file_name}:${x.intake_source}`)).toEqual(["а.pdf:upload", "б.pdf:upload", "том-б.pdf:server_import"]);
    expect(readFileSync(join(out, "intake-report.md"), "utf8")).toContain("задана оператором");
  });

  it("--process-id несуществующей проверки — отказ до передачи файлов", async () => {
    const calls: string[] = [];
    const spy = async (req: any) => (calls.push(new URL(req.url).pathname), injectHttp(req));
    const err = await loader.loadPackage({ ...base, inputs: [folder("pid-none", { "а.pdf": pdf("none", 300) })], processId: "P-00000000-нет", log: () => {} }, spy).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/не найдена — файлы не передавались/);
    expect(calls.some((c) => c.includes("/documents/"))).toBe(false);
  });

  it("ни карточки объекта, ни --process-id — отказ до входа", async () => {
    let calls = 0;
    const spy = async (req: any) => (calls++, injectHttp(req));
    await expect(loader.loadPackage({ ...base, inputs: [folder("no-card", { "а.pdf": pdf("nc", 300) })], log: () => {} } as any, spy)).rejects.toThrow(/--process-id/);
    expect(calls).toBe(0);
  });

  it("пакет больше порции — порции в одну проверку, отказа пакета целиком нет (OS-INSP-1.2.42)", async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 1; i <= 5; i++) files[`ПД/п${i}.pdf`] = pdf(`порция-${i}`, 900);
    files["ИД/том.pdf"] = pdf("порция-том", 6000);
    const out = join(TMP, "intake-portions");
    const r = await loader.loadPackage({ ...base, inputs: [folder("portions", files)], importDir: BLOBS(), portionBytes: 2500, object: { object_id: "SYN-PORT", name: "Порции" }, out, log: () => {} }, injectHttp);
    expect(r.portions.length).toBeGreaterThan(2);
    expect(r.portions.every((p) => p.bytes <= 2500 || p.files === 1)).toBe(true);
    expect(r.portions.reduce((n, p) => n + p.files, 0)).toBe(6);
    expect(new Set(r.parts.map((p) => p.process_id))).toEqual(new Set([r.process_id]));
    expect(r.accepted).toHaveLength(6);
    expect((await db.get("select count(*) n from inspections where object_id = 'SYN-PORT'")).n).toBe(1);
    expect(readFileSync(join(out, "intake-report.md"), "utf8")).toContain("Порции (OS-INSP-1.2.42)");
  });

  it("защита от бомб — у каждой записи: запись со сжатием больше 100:1 отклоняет архив до входа", async () => {
    const p = join(TMP, "bomb.zip");
    writeFileSync(p, buildZip([{ name: "a.pdf", data: PZ }, { name: "bomb.pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(400_000), Buffer.from("\n%%EOF\n")]), deflate: true }]));
    let calls = 0;
    const err = await loader.loadPackage({ ...base, inputs: [p], importDir: BLOBS(), object: { object_id: "B", name: "B" }, log: () => {} }, async (req: any) => (calls++, injectHttp(req))).catch((e) => e);
    expect(err.code).toBe("BOMB");
    expect(calls).toBe(0);
  });
});
