// OS-INSP-1.2.15–1.2.19 (TZA-7.6-01): автозабор пакетов из ИАИС «РиН». Настоящий HTTP-сервер «РиН» на случайном
// порту (node:http), поддельный clamd (как в av-route.test.ts), ML подменён транспортом — сервис не нужен.
// Фикстуры — только синтетика data/synth (ADR-0002).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// корень — ближайший вверх каталог с pnpm-workspace.yaml (как в config.ts): песочница Stryker глубже исходников
const ROOT = (() => { let d = import.meta.dirname; while (!existsSync(join(d, "pnpm-workspace.yaml")) && dirname(d) !== d) d = dirname(d); return d; })();
const SYNTH = join(ROOT, "data/synth");
const TMP = mkdtempSync(join(tmpdir(), "inspector-rin-pull-"));
// EICAR собирается из частей: целиком в исходнике он будит антивирус рабочей машины
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const synth = (obj: string, name: string) => readFileSync(join(SYNTH, obj, name));

// ─────────────────────────────── поддельная ИАИС «РиН»
type Mode = "ok" | "503" | "hang";
// режимы файла сверх Mode: redirect — 302 на чужой хост; empty — 204 без тела; overlimit — 50 МБ + 1 МиБ и соединение висит
type FileMode = Mode | "redirect" | "empty" | "overlimit";
const rin = {
  packages: [] as any[],
  files: new Map<string, Buffer>(),
  mode: "ok" as Mode,
  fileMode: new Map<string, FileMode>(),
  listDelayMs: 0,
  lists: [] as string[],
  fileHits: [] as string[],
  /** Сырое тело ответа списка вместо пакетов (границы размера ответа). */
  rawList: null as string | null,
  /** Сколько пакетов отдал последний ответ списка. */
  lastListed: 0,
  /** Вызывается при отдаче файла — чтобы сменить состояние системы посреди скачивания. */
  onFile: null as null | ((key: string) => Promise<unknown>),
  /** Синхронная остановка цикла событий перед отдачей файла, мс: голодание CPU под полным набором (T-157). */
  stallMs: new Map<string, number>(),
};
/** Сбросить рубильники отказов: упавший тест не оставляет «РиН»/антивирус сломанными следующим (T-157). */
function resetFaults() {
  rin.mode = "ok";
  rin.fileMode.clear();
  rin.stallMs.clear();
  rin.listDelayMs = 0;
  rin.rawList = null;
  rin.onFile = null;
  clamdAlive = true;
}
// Срок попытки для «висящей» «РиН». Висящий сервер не отвечает никогда, поэтому короткий срок срабатывает при любой
// нагрузке; рабочие ответы идут транспортом со сроком прода (30 с) — T-157: общий срок 2 с под нагрузкой полного
// набора обрывал рабочую загрузку, пакет уходил в PENDING, и шесть тестов цепочкой краснели.
const HANG_DEADLINE_MS = 200;
let rinServer: HttpServer;
let clamd: TcpServer;
let clamdAlive = true;
let foreignHits = 0;
let foreign: HttpServer;

let db: any;
let buildApp: typeof import("../src/app.ts").buildApp;
let pull: typeof import("../src/services/rin-pull.ts");
let ins: typeof import("../src/services/inspections.ts");
let dbm: typeof import("../src/db.ts");
let mlCalls = 0;
let patient: import("../src/services/rin-tls.ts").RinGet;
let hasty: import("../src/services/rin-tls.ts").RinGet;

let seq = 0;
/** Пакет в допущенной форме контракта (services/rin-contract.ts); файлы — по относительному url. */
function pkg(objectId: string, files: Array<{ name: string; buf: Buffer; fileId?: string; sha?: string; size?: number; url?: string }>, manifest: unknown = null) {
  const id = `PKG-${++seq}`;
  const wire = {
    package_id: id,
    object_id: objectId,
    object: { name: `Объект ${objectId}`, address: "г. Москва, ул. Синтетическая, 1" },
    created_at: new Date(Date.UTC(2026, 8, 25, 10, 0, seq)).toISOString(),
    manifest,
    files: files.map((f, i) => {
      const fid = f.fileId ?? `F${i}`;
      rin.files.set(`${id}/${fid}`, f.buf);
      return { file_id: fid, file_name: f.name, sha256: f.sha ?? sha(f.buf), size: f.size ?? f.buf.length, url: f.url ?? `files/${id}/${fid}` };
    }),
  };
  rin.packages.push(wire);
  return wire;
}

const row = (id: string) => db.get("select * from rin_packages where package_id = $1", [id]);
const count = async (sql: string, ...a: unknown[]) => ((await db.get(sql, a)) as { n: number }).n;
const notes = (role: string, like: string) => db.all("select * from notifications where user_role = $1 and message like $2", [role, `%${like}%`]);
const cursor = async () => (await dbm.meta(db, "rin_pull_cursor")) || null;
const poll = () => pull.pollRin(pull.rinCtx(db));
/** Адрес, который поддельная «РиН» сейчас не обслуживает (режим hang): ровно ему — короткий срок. */
function hangs(url: string): boolean {
  const u = new URL(url);
  if (u.pathname.endsWith("/api/v1/packages")) return rin.mode === "hang";
  const m = /\/rin\/files\/(.+)$/.exec(u.pathname);
  return !!m && rin.fileMode.get(decodeURIComponent(m[1])) === "hang";
}
/** Опрос при висящей «РиН»: висящим адресам — короткий срок, остальным — срок прода; затем транспорт прода. */
async function withHang<T>(fn: () => Promise<T>): Promise<T> {
  pull.setRinPullTransport((url, max) => (hangs(url) ? hasty : patient)(url, max));
  try {
    return await fn();
  } finally {
    pull.setRinPullTransport(patient);
  }
}
async function waitFor(fn: () => Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settled = async (inspectionId: string) => {
  await ins.parseQueue(db).idle();
  await waitFor(async () => (await ins.getInspection(db, inspectionId)).status !== "PARSING");
};

beforeAll(async () => {
  rinServer = createHttp(async (req, res) => {
    const u = new URL(req.url!, "http://rin");
    if (u.pathname === "/rin/api/v1/packages") {
      const since = u.searchParams.get("since");
      rin.lists.push(since ?? "");
      if (rin.mode === "503") return res.writeHead(503, { "content-type": "application/json" }).end('{"error":"maintenance"}');
      if (rin.mode === "hang") return; // не отвечает — сработает тайм-аут клиента
      const listed = rin.packages.filter((p) => !since || p.created_at >= since);
      rin.lastListed = listed.length;
      const body = rin.rawList ?? JSON.stringify(listed);
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(body), rin.listDelayMs);
      return;
    }
    const m = /^\/rin\/files\/(.+)$/.exec(u.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]);
      rin.fileHits.push(key);
      await rin.onFile?.(key); // смена состояния успевает до ответа
      const mode = rin.fileMode.get(key) ?? "ok";
      if (mode === "503") return res.writeHead(503).end();
      if (mode === "hang") return;
      if (mode === "redirect") return res.writeHead(302, { location: `http://127.0.0.1:${(foreign.address() as any).port}/stolen` }).end();
      if (mode === "empty") return res.writeHead(204).end();
      if (mode === "overlimit") {
        // больше предела файла, и поток не кончается: клиент обязан оборвать чтение сам, иначе упрётся в тайм-аут
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(1 << 20);
        let left = 51;
        const pump = () => { while (left > 0) { left--; if (!res.write(chunk)) return void res.once("drain", pump); } };
        return pump();
      }
      const b = rin.files.get(key);
      const stall = rin.stallMs.get(key);
      if (stall) for (const t = Date.now(); Date.now() - t < stall; ); // клиент в том же процессе: его таймеры стоят тоже
      return b ? res.writeHead(200, { "content-type": "application/octet-stream" }).end(b) : res.writeHead(404).end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => rinServer.listen(0, "127.0.0.1", () => r()));
  foreign = createHttp((_req, res) => {
    foreignHits++;
    res.end("x");
  });
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", () => r()));
  clamd = createTcp((sock) => {
    if (!clamdAlive) return sock.destroy();
    // разбор кадров INSTREAM: «zINSTREAM\0», затем <длина uint32 BE><данные>, нулевая длина — конец
    let acc = Buffer.alloc(0);
    let off = "zINSTREAM\0".length;
    const data: Buffer[] = [];
    let done = false;
    sock.on("data", (d: Buffer) => {
      acc = Buffer.concat([acc, d]);
      while (!done && acc.length >= off + 4) {
        const len = acc.readUInt32BE(off);
        if (len === 0) {
          done = true;
          sock.end(Buffer.concat(data).includes(EICAR) ? "stream: Eicar-Signature FOUND\0" : "stream: OK\0");
        } else if (acc.length >= off + 4 + len) {
          data.push(acc.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        } else break;
      }
    });
  });
  await new Promise<void>((r) => clamd.listen(0, "127.0.0.1", () => r()));
  Object.assign(process.env, {
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass",
    INSPECTOR_AV: "clamd", INSPECTOR_CLAMD_HOST: "127.0.0.1", INSPECTOR_CLAMD_PORT: String((clamd.address() as any).port),
    INSPECTOR_RIN_URL: `http://127.0.0.1:${(rinServer.address() as any).port}/rin`,
    // INSPECTOR_RIN_PULL_TIMEOUT_MS не задан — срок прода 30 с; тайм-аут висящей «РиН» — withHang() ниже
    INSPECTOR_ML_URL: "http://127.0.0.1:9", // ML не нужен: транспорт разбора подменён ниже
    INSPECTOR_SHEET_DIFF_AUTO: "0",
  });
  dbm = await import("../src/db.ts");
  ins = await import("../src/services/inspections.ts");
  pull = await import("../src/services/rin-pull.ts");
  const { config, rinPull } = await import("../src/config.ts");
  const { rinGetTransportFromEnv } = await import("../src/services/rin-tls.ts");
  const env = { profile: config.profile, mock: config.rinMock };
  patient = rinGetTransportFromEnv(env, { timeoutMs: rinPull.timeoutMs }); // то же, что строит rin-pull.ts по умолчанию
  hasty = rinGetTransportFromEnv(env, { timeoutMs: HANG_DEADLINE_MS });
  const ml = await import("../src/services/ml-client.ts");
  ml.setMlTransport(async (req) => {
    mlCalls++;
    return { sha256: req.sha256, kind: "pdf", engine: "fake", pages: [], extractions: [], facts: [], rooms: [], cached: false };
  });
  db = await dbm.openDb("memory");
  buildApp = (await import("../src/app.ts")).buildApp;
});
afterAll(async () => {
  await db.close();
  rinServer.closeAllConnections();
  rinServer.close();
  foreign.close();
  clamd.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("автозабор из ИАИС «РиН» (OS-INSP-1.2.15–1.2.19, TZA-7.6-01)", () => {
  afterEach(resetFaults);
  let first: any;
  let inspectionId = "";
  let openT4 = ""; // открытая проверка объекта RIN-T4 (тест 1.2.18)
  const started = (id: string) => count("select count(*) n from audit_log where action = 'PROCESSING_STARTED' and object_id = $1", id);
  const details = async (action: string, objectId: string) => JSON.parse(((await db.get("select details from audit_log where action = $1 and object_id = $2 order by id desc", [action, objectId])) as any).details);

  it("пустой ответ «РиН» на первом опросе — ошибки нет, курсор не заводится", async () => {
    const s = await poll();
    expect(s).toMatchObject({ skipped: false, error: null, listed: 0, fetched: 0, cursor: null });
    expect(await cursor()).toBeNull();
    expect(rin.lists.at(-1)).toBe(""); // без курсора — без since
  });

  it("OS-INSP-1.2.15: новый пакет забран без ручной загрузки — проверка создана актором system:rin, файлы и реестр приняты, разбор поставлен в очередь", async () => {
    const names = ["SCH-PD-PZ-1.pdf", "SCH-RD-AR-1.pdf", "SCH-RD-AR-2.pdf"];
    const manifest = JSON.parse(synth("OBJ-SCH-8", "manifest.json").toString("utf8"));
    first = pkg("RIN-T1", names.map((n) => ({ name: n, buf: synth("OBJ-SCH-8", n), fileId: n.replace(".pdf", "") })), manifest);
    const s = await poll();
    expect(s).toMatchObject({ skipped: false, error: null, listed: 1, fetched: 1, rejected: 0, pending: 0 });
    const r = await row(first.package_id);
    expect(r).toMatchObject({ status: "FETCHED", object_id: "RIN-T1", reason: null, attempts: 1 });
    expect(r.fetched_at).toBeTruthy();
    inspectionId = r.inspection_id;
    const insp = await ins.getInspection(db, inspectionId);
    expect(insp.created_by).toBe("system:rin"); // служебный актор, не инспектор
    expect(pull.RIN_ACTOR.role).toBe("system"); // роль вне ролей людей: ни одна проверка прав её не пропускает
    expect(JSON.parse(insp.manifest_json).files).toHaveLength(manifest.files.length); // реестр пакета принят
    const files = (await db.all("select client_file_id, sha256 from files where inspection_id = $1 order by client_file_id", [inspectionId]));
    expect(files.map((f: any) => f.client_file_id)).toEqual(["SCH-PD-PZ-1", "SCH-RD-AR-1", "SCH-RD-AR-2"]);
    expect(await count("select count(*) n from audit_log where action = 'RIN_PACKAGE_FETCHED' and user_id = 'system:rin' and object_id = $1", inspectionId)).toBe(1);
    expect(await details("RIN_PACKAGE_FETCHED", inspectionId)).toMatchObject({ package_id: first.package_id, object_id: "RIN-T1", files: 3, accepted: 3 });
    expect(await started(inspectionId)).toBe(1);
    expect(await count("select count(*) n from users where id = 'system:rin' or login = 'system:rin'")).toBe(0); // учётки нет — войти нельзя
    await settled(inspectionId);
    expect(mlCalls).toBeGreaterThanOrEqual(3);
    expect((await db.all("select distinct parse_status s from files where inspection_id = $1", [inspectionId]))).toEqual([{ s: "DONE" }]);
    const n = await notes("inspector", first.package_id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ level: "INFO", inspection_id: inspectionId });
    expect(await cursor()).toBe(first.created_at);
  });

  it("OS-INSP-1.2.16: повторный опрос не создаёт дублей файлов и проверок", async () => {
    const files = await count("select count(*) n from files");
    const insps = await count("select count(*) n from inspections");
    const hits = rin.fileHits.length;
    const s = await poll();
    expect(rin.lists.at(-1)).toBe(first.created_at); // курсор ушёл в запрос; since включительно — пакет пришёл снова
    expect(s).toMatchObject({ listed: 1, fetched: 0, rejected: 0, pending: 0 });
    expect(await count("select count(*) n from files")).toBe(files);
    expect(await count("select count(*) n from inspections")).toBe(insps);
    expect(rin.fileHits.length).toBe(hits); // файлы повторно не скачивались
    expect((await row(first.package_id)).attempts).toBe(1);
  });

  it("новый пакет по объекту с открытой проверкой дозагружается в неё (OS-INSP-1.2.7)", async () => {
    const p = pkg("RIN-T1", [{ name: "SCH-RD-KZH-1.pdf", buf: synth("OBJ-SCH-8", "SCH-RD-KZH-1.pdf"), fileId: "SCH-RD-KZH-1" }]);
    expect((await poll()).fetched).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "FETCHED", inspection_id: inspectionId });
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T1'")).toBe(1);
    expect(await count("select count(*) n from files where inspection_id = $1", inspectionId)).toBe(4);
    expect(await started(inspectionId)).toBe(2);
    await settled(inspectionId);
  });

  it("OS-INSP-1.2.16: новый пакет с уже принятым файлом — FETCHED без дубля файла и без повторного разбора", async () => {
    const p = pkg("RIN-T1", [{ name: "SCH-RD-KZH-1.pdf", buf: synth("OBJ-SCH-8", "SCH-RD-KZH-1.pdf"), fileId: "SCH-RD-KZH-1" }]);
    expect((await poll()).fetched).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "FETCHED", reason: null, inspection_id: inspectionId });
    expect(await count("select count(*) n from files where inspection_id = $1", inspectionId)).toBe(4);
    expect(await started(inspectionId)).toBe(2); // принято 0 файлов — разбор не перезапускается
    expect(await details("RIN_PACKAGE_FETCHED", inspectionId)).toMatchObject({ package_id: p.package_id, accepted: 0 });
  });

  it("проверка объекта в разборе — пакет отложен без скачивания, забирается следующим циклом", async () => {
    await db.run("update inspections set status = 'PARSING' where id = $1", [inspectionId]);
    const p = pkg("RIN-T1", [{ name: "SCH-RD-EM-1.docx", buf: synth("OBJ-SCH-8", "SCH-RD-EM-1.docx"), fileId: "SCH-RD-EM-1" }]);
    expect((await poll()).pending).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "PENDING", inspection_id: inspectionId });
    expect((await row(p.package_id)).reason).toContain("в разборе");
    expect(rin.fileHits.some((k) => k.startsWith(`${p.package_id}/`))).toBe(false);
    await db.run("update inspections set status = 'READY' where id = $1", [inspectionId]);
    expect((await poll()).fetched).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "FETCHED", attempts: 2 });
    expect(await count("select count(*) n from files where inspection_id = $1", inspectionId)).toBe(5);
    await settled(inspectionId);
  });

  it("протокол финализирован во время скачивания — пакет не принят, в следующем цикле только уведомление", async () => {
    const p = pkg("RIN-T1", [{ name: "SCH-late.pdf", buf: synth("OBJ-SEV-2", "SEV-PD-PB-1.pdf") }]);
    rin.onFile = async (key) => {
      if (key.startsWith(`${p.package_id}/`)) await db.run("update inspections set status = 'FINALIZED' where id = $1", [inspectionId]);
    };
    expect((await poll()).pending).toBe(1);
    rin.onFile = null;
    expect(await row(p.package_id)).toMatchObject({ status: "PENDING", inspection_id: inspectionId });
    expect((await row(p.package_id)).reason).toContain("финализирован");
    expect(await count("select count(*) n from files where inspection_id = $1", inspectionId)).toBe(5);
    expect((await poll()).notified).toBe(1);
    expect((await row(p.package_id)).status).toBe("NOTIFIED_ONLY");
  });

  it("OS-INSP-1.2.17: протокол финализирован — пакет не дозагружен, инспектор уведомлён о новом пакете", async () => {
    await db.run("update inspections set status = 'FINALIZED' where id = $1", [inspectionId]);
    const before = await count("select count(*) n from files where inspection_id = $1", inspectionId);
    const p = pkg("RIN-T1", [{ name: "SCH-RD-EM-2.docx", buf: synth("OBJ-SCH-8", "SCH-RD-EM-1.docx"), fileId: "SCH-RD-EM-2" }]);
    const s = await poll();
    expect(s).toMatchObject({ notified: 1, fetched: 0 });
    expect(await row(p.package_id)).toMatchObject({ status: "NOTIFIED_ONLY", inspection_id: inspectionId });
    expect(await count("select count(*) n from files where inspection_id = $1", inspectionId)).toBe(before);
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T1'")).toBe(1);
    expect(rin.fileHits.some((k) => k.startsWith(`${p.package_id}/`))).toBe(false); // файлы даже не скачивались
    const n = await notes("inspector", p.package_id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ inspection_id: inspectionId, level: "WARNING" });
    expect(n[0].message).toContain("финализирован");
    await poll();
    expect(await notes("inspector", p.package_id)).toHaveLength(1); // уведомление одно
  });

  it("OS-INSP-1.2.18: «РиН» недоступна (503, тайм-аут) — пакет не отмечен забранным, следующий цикл его забирает", async () => {
    const p = pkg("RIN-T4", [{ name: "SKL-PD-PZ-1.pdf", buf: synth("OBJ-SKL-5", "SKL-PD-PZ-1.pdf") }]);
    // более поздний пакет, >64 КБ (несколько кусков потока), забирается сразу — но курсор держит незабранный p
    const q = pkg("RIN-T4B", [{ name: "SEV-ID-DOOR-1.pdf", buf: synth("OBJ-SEV-2", "SEV-ID-DOOR-1.pdf") }]);
    const c0 = await cursor();
    rin.mode = "503";
    expect((await poll()).error).toContain("HTTP 503");
    rin.mode = "hang";
    expect((await withHang(poll)).error).toMatch(/недоступна/);
    expect(await row(p.package_id)).toBeUndefined();
    expect(await cursor()).toBe(c0);
    rin.mode = "ok";
    const key = `${p.package_id}/F0`;
    rin.fileMode.set(key, "503");
    // голодание CPU дольше короткого срока на рабочем ответе: q всё равно забран — рабочие ответы не под сроком «висящей» (T-157)
    rin.stallMs.set(`${q.package_id}/F0`, 3 * HANG_DEADLINE_MS);
    expect(await poll()).toMatchObject({ pending: 1, fetched: 1 });
    rin.stallMs.clear();
    expect((await row(q.package_id)).status).toBe("FETCHED");
    expect(await row(p.package_id)).toMatchObject({ status: "PENDING", attempts: 1, fetched_at: null });
    expect((await row(p.package_id)).reason).toContain("HTTP 503");
    rin.fileMode.set(key, "hang");
    expect((await withHang(poll)).pending).toBe(1);
    expect((await row(p.package_id)).attempts).toBe(2);
    expect((await row(p.package_id)).reason).toMatch(/^ИАИС «РиН» недоступна: /);
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T4'")).toBe(0);
    expect(await cursor()).toBe(c0); // курсор не сдвинут через незабранный пакет, хотя более поздний q забран
    rin.fileMode.delete(key);
    expect((await poll()).fetched).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "FETCHED", attempts: 3, reason: null });
    expect(await count("select count(*) n from files f join inspections i on i.id = f.inspection_id where i.object_id = 'RIN-T4'")).toBe(1);
    expect(await cursor()).toBe(q.created_at); // забранный раньше q теперь тоже за курсором
    openT4 = (await row(p.package_id)).inspection_id;
    await settled(openT4);
    await settled((await row(q.package_id)).inspection_id);
  });

  it("OS-INSP-1.2.19: SHA-256 скачанного не совпал с заявленным — пакет REJECTED с причиной, администратор уведомлён, файлы не приняты", async () => {
    const buf = synth("OBJ-SEV-2", "SEV-PD-PZ-1.pdf");
    const p = pkg("RIN-T5A", [{ name: "SEV-PD-PZ-1.pdf", buf, sha: sha(Buffer.from("другой файл")) }]);
    expect((await poll()).rejected).toBe(1);
    expect((await row(p.package_id)).status).toBe("REJECTED");
    expect((await row(p.package_id)).reason).toContain("HASH_MISMATCH");
    const n = await notes("admin", p.package_id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ level: "ERROR" });
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T5A'")).toBe(0);
    // проверки нет — событие аудита привязано к пакету
    expect(await count("select count(*) n from audit_log where action = 'RIN_PACKAGE_REJECTED' and user_id = 'system:rin' and object_id = $1", p.package_id)).toBe(1);
    await poll();
    expect(await notes("admin", p.package_id)).toHaveLength(1); // отклонённый пакет не забирается повторно
  });

  it("OS-INSP-1.2.19: заражённый файл (EICAR) — пакет REJECTED с причиной INFECTED, чистые файлы пакета тоже не приняты", async () => {
    const pdf = synth("OBJ-SEV-2", "SEV-PD-KR-1.pdf");
    const infected = Buffer.concat([pdf.subarray(0, pdf.length - 8), Buffer.from(EICAR), pdf.subarray(pdf.length - 8)]);
    const p = pkg("RIN-T5B", [{ name: "clean.pdf", buf: pdf }, { name: "bad.pdf", buf: infected }]);
    expect((await poll()).rejected).toBe(1);
    expect((await row(p.package_id)).reason).toContain("INFECTED");
    expect(await notes("admin", p.package_id)).toHaveLength(1);
    expect(await count("select count(*) n from files where file_name in ('clean.pdf', 'bad.pdf')")).toBe(0);
    expect(await count("select count(*) n from audit_log where action = 'FILE_INFECTED' and user_id = 'system:rin' and object_id = $1", p.package_id)).toBe(1);
    // дозагрузка в открытую проверку: событие антивируса — по проверке, как на ручной загрузке
    const open = openT4;
    const p2 = pkg("RIN-T4", [{ name: "bad2.pdf", buf: infected }]);
    expect((await poll()).rejected).toBe(1);
    expect(await count("select count(*) n from audit_log where action = 'FILE_INFECTED' and object_id = $1", open)).toBe(1);
    expect((await row(p2.package_id)).reason).toContain("INFECTED");
  });

  it("OS-INSP-1.2.19: отказ внутри приёма (file_id уже занят другим файлом) — пакет REJECTED целиком: чистый файл не принят, реестр проверки не тронут, разбор не запущен, блобов нет", async () => {
    const uniq = (b: Buffer, tag: string) => Buffer.concat([b.subarray(0, b.length - 8), Buffer.from(`\n% ${tag}\n`), b.subarray(b.length - 8)]);
    const fresh = uniq(synth("OBJ-SCH-8", "SCH-RD-KZH-1.pdf"), "rin-atomic-fresh");
    const clash = uniq(synth("OBJ-SCH-8", "SCH-RD-KZH-1.pdf"), "rin-atomic-clash");
    const base = JSON.parse(synth("OBJ-SCH-8", "manifest.json").toString("utf8"));
    const kzh = base.files.find((f: any) => f.file_id === "SCH-RD-KZH-1");
    const taken = (await db.get("select client_file_id c from files where inspection_id = $1 limit 1", [openT4])).c; // file_id, уже принятый в открытой проверке
    const manifest = { object: base.object, files: [{ ...kzh, file_id: "FRESH-1", file_name: "fresh.pdf", sha256: undefined }, { ...kzh, file_id: taken, file_name: "kzh-v2.pdf", sha256: undefined }] };
    const before = { files: await count("select count(*) n from files where inspection_id = $1", openT4), manifest: (await db.get("select manifest_json m from inspections where id = $1", [openT4])).m, started: await started(openT4) };
    const old = synth("OBJ-SCH-8", "SCH-RD-KZH-1.pdf"); // этот блоб уже лежит в хранилище: на него ссылается проверка RIN-T1
    expect(existsSync(join(TMP, "blobs", sha(old)))).toBe(true);
    manifest.files.push({ ...kzh, file_id: "OLD-1", file_name: "old.pdf", sha256: undefined });
    const p = pkg("RIN-T4", [{ name: "fresh.pdf", buf: fresh }, { name: "old.pdf", buf: old }, { name: "kzh-v2.pdf", buf: clash }], manifest);
    expect((await poll()).rejected).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("FILE_ID_EXISTS") });
    expect(await notes("admin", p.package_id)).toHaveLength(1);
    expect(await count("select count(*) n from files where inspection_id = $1", openT4)).toBe(before.files);
    expect((await db.get("select manifest_json m from inspections where id = $1", [openT4])).m).toBe(before.manifest);
    expect(await started(openT4)).toBe(before.started);
    expect([existsSync(join(TMP, "blobs", sha(fresh))), existsSync(join(TMP, "blobs", sha(clash)))]).toEqual([false, false]);
    expect(existsSync(join(TMP, "blobs", sha(old)))).toBe(true); // откат не трогает блобы, записанные не этой попыткой
    expect((await row(p.package_id)).inspection_id).toBe(openT4);
  });

  it("OS-INSP-1.2.19: отказ внутри приёма по новому объекту (SHA-256 расходится с реестром пакета) — проверка не заведена, пакет без проверки", async () => {
    const base = JSON.parse(synth("OBJ-SCH-8", "manifest.json").toString("utf8"));
    const kzh = base.files.find((f: any) => f.file_id === "SCH-RD-KZH-1");
    const buf = Buffer.concat([Buffer.from("%PDF-1.7\n% rin-t5g\n"), synth("OBJ-SCH-8", "SCH-RD-KZH-1.pdf").subarray(9)]);
    const p = pkg("RIN-T5G", [{ name: "g.pdf", buf }], { object: base.object, files: [{ ...kzh, file_id: "G-1", file_name: "g.pdf", sha256: "0".repeat(64) }] });
    expect((await poll()).rejected).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "REJECTED", inspection_id: null, reason: expect.stringContaining("HASH_MISMATCH") });
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T5G'")).toBe(0);
    expect(await count("select count(*) n from objects where id = 'RIN-T5G'")).toBe(0);
  });

  it("OS-INSP-1.2.19: недопустимый формат — пакет REJECTED с причиной UNSUPPORTED_FORMAT и перечнем поддерживаемых", async () => {
    const p = pkg("RIN-T5C", [{ name: "readme.txt", buf: Buffer.from("просто текст, не документ пакета") }, { name: "ok.pdf", buf: synth("OBJ-SKL-5", "SKL-PD-PZ-1.pdf") }]);
    expect((await poll()).rejected).toBe(1);
    expect((await row(p.package_id)).reason).toMatch(/UNSUPPORTED_FORMAT: .*поддерживаются PDF, DOCX, XML/);
    expect(await notes("admin", p.package_id)).toHaveLength(1);
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T5C'")).toBe(0); // отказ до приёма: проверка не заведена
  });

  it("OS-INSP-1.2.19: пакет больше 200 МБ по заявленным размерам — REJECTED без скачивания", async () => {
    const small = synth("OBJ-SKL-5", "SKL-PD-PZ-1.pdf");
    const p = pkg("RIN-T5E", [{ name: "a.pdf", buf: small, size: 150 * 1048576 }, { name: "b.pdf", buf: small, size: 51 * 1048576 }]);
    expect((await poll()).rejected).toBe(1);
    expect((await row(p.package_id)).reason).toMatch(/^PACKAGE_TOO_LARGE: .*200 МБ/);
    expect(rin.fileHits.some((k) => k.startsWith(`${p.package_id}/`))).toBe(false);
    expect(await notes("admin", p.package_id)).toHaveLength(1);
  });

  it("OS-INSP-1.2.19: файл больше 50 МБ — чтение обрывается на пределе, пакет REJECTED с причиной FILE_TOO_LARGE", async () => {
    const p = pkg("RIN-T5F", [{ name: "huge.pdf", buf: Buffer.alloc(0), size: 50 * 1048576 + 1 }]);
    rin.fileMode.set(`${p.package_id}/F0`, "overlimit"); // сервер не закрывает поток — без обрыва клиент ушёл бы в тайм-аут
    expect((await poll()).rejected).toBe(1);
    expect((await row(p.package_id)).reason).toMatch(/^FILE_TOO_LARGE: /);
  });

  it("антивирус недоступен — пакет не отклонён, а забирается в следующем цикле (закрыто при сбое)", async () => {
    const p = pkg("RIN-T5D", [{ name: "SKL-ID-OZHR-1.pdf", buf: synth("OBJ-SKL-5", "SKL-ID-OZHR-1.pdf") }]);
    clamdAlive = false;
    expect((await poll()).pending).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "PENDING" });
    expect((await row(p.package_id)).reason).toContain("антивирусная проверка не выполнена");
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T5D'")).toBe(0);
    clamdAlive = true;
    expect((await poll()).fetched).toBe(1);
    await settled((await row(p.package_id)).inspection_id);
  });

  it("враждебный ответ: чужой адрес, редирект, путь в имени, 404 и 204 вместо файла, пакет не по схеме — REJECTED и администратору; чужой хост не запрашивается", async () => {
    const pdf = synth("OBJ-SKL-5", "SKL-PD-PZ-1.pdf");
    const foreignUrl = `http://127.0.0.1:${(foreign.address() as any).port}/steal`;
    const a = pkg("RIN-T7", [{ name: "a.pdf", buf: pdf, url: foreignUrl }]);
    const b = pkg("RIN-T7", [{ name: "../../etc/passwd.pdf", buf: pdf }]);
    const c = pkg("RIN-T7", [{ name: "c.pdf", buf: pdf }]);
    rin.fileMode.set(`${c.package_id}/F0`, "redirect");
    const d = pkg("RIN-T7", [{ name: "d.pdf", buf: pdf, url: "files/нет-такого" }]);
    const e = pkg("RIN-T7", [{ name: "e.pdf", buf: pdf }]);
    rin.fileMode.set(`${e.package_id}/F0`, "empty");
    const at = new Date(Date.UTC(2026, 8, 25, 11)).toISOString();
    const bad = { package_id: "BAD-SCHEMA", object_id: "RIN-T7", created_at: at };
    rin.packages.push(bad, { ...bad }); // повтор в одном ответе — одно отклонение
    rin.packages.push({ object_id: "RIN-T7", created_at: at, files: [] }); // без package_id — только в журнал
    const s = await poll();
    expect(s.listed).toBe(rin.lastListed);
    expect(s.rejected).toBe(6);
    expect(foreignHits).toBe(0);
    expect((await row(a.package_id)).reason).toContain("вне ИАИС «РиН»");
    expect((await row(b.package_id)).reason).toContain("путь");
    expect((await row(c.package_id)).reason).toMatch(/^RIN_FILE_UNAVAILABLE: .*HTTP 302/); // редирект не выполняется и не повторяется
    expect((await row(d.package_id)).reason).toMatch(/^RIN_FILE_UNAVAILABLE: .*HTTP 404/);
    expect((await row(e.package_id)).reason).toMatch(/^(SIZE_MISMATCH|UNSUPPORTED_FORMAT|CORRUPTED): /); // 204 без тела — не файл, а не сбой
    expect(await row("BAD-SCHEMA")).toMatchObject({ status: "REJECTED", object_id: "RIN-T7", attempts: 1 });
    const n = await notes("admin", "BAD-SCHEMA");
    expect(n).toHaveLength(1);
    expect(n[0].message).toContain("RIN-T7");
    expect(await details("RIN_PACKAGE_REJECTED", "BAD-SCHEMA")).toMatchObject({ package_id: "BAD-SCHEMA", object_id: "RIN-T7", files: 0 });
    expect(await count("select count(*) n from rin_packages where object_id = 'RIN-T7' or package_id is null")).toBe(6);
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T7'")).toBe(0);
    await poll();
    expect(await notes("admin", "BAD-SCHEMA")).toHaveLength(1); // отклонённый не по схеме пакет не отклоняется повторно
    rin.packages = rin.packages.filter((p) => p.package_id?.startsWith("PKG-"));
  });

  it("границы ответа списка: ровно 10 МБ принимается, на байт больше — цикл отклонён, курсор на месте", async () => {
    const LIMIT = 10 * 1024 * 1024;
    const c0 = await cursor();
    rin.rawList = "[" + " ".repeat(LIMIT - 2) + "]";
    expect((await poll()).error).toBeNull();
    rin.rawList = "[" + " ".repeat(LIMIT - 1) + "]";
    const s = await poll();
    rin.rawList = null;
    expect(s.error).toMatch(/больше/);
    expect(await cursor()).toBe(c0);
  });

  it("непредвиденный сбой приёма (база) во время забора — пакет не отмечен, повтор в следующем цикле", async () => {
    const p = pkg("RIN-T8", [{ name: "SKL-PD-PZ-1.pdf", buf: synth("OBJ-SKL-5", "SKL-PD-PZ-1.pdf") }]);
    rin.onFile = async (key) => {
      if (key.startsWith(`${p.package_id}/`)) await db.exec("alter table files rename to files_off");
    };
    const s = await poll();
    rin.onFile = null;
    expect((await row(p.package_id)).inspection_id).toBeNull(); // откаченная проверка не остаётся ссылкой в учёте пакетов
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T8'")).toBe(0);
    await db.exec("alter table files_off rename to files");
    expect(s).toMatchObject({ error: null, pending: 1, fetched: 0 });
    expect(await row(p.package_id)).toMatchObject({ status: "PENDING", fetched_at: null });
    expect((await row(p.package_id)).reason).toMatch(/files/);
    expect((await poll()).fetched).toBe(1);
    expect(await row(p.package_id)).toMatchObject({ status: "FETCHED", attempts: 2 });
    expect(await count("select count(*) n from inspections where object_id = 'RIN-T8'")).toBe(1); // повтор не завёл вторую проверку
    await settled((await row(p.package_id)).inspection_id);
  });

  it("наложение циклов исключено: опрос, запущенный во время идущего, не стартует", async () => {
    rin.listDelayMs = 300;
    const before = rin.lists.length;
    const [x, y] = await Promise.all([poll(), poll()]);
    rin.listDelayMs = 0;
    expect([x.skipped, y.skipped].sort()).toEqual([false, true]);
    expect([x, y].find((r) => r.skipped)!.cursor).toBe(await cursor()); // пропущенный цикл сообщает текущий курсор
    expect(rin.lists.length - before).toBe(1); // к «РиН» ушёл один запрос списка
    expect((await poll()).skipped).toBe(false); // после завершения следующий цикл идёт
  });

  it("сбой внутри цикла (база недоступна) — опрос не падает, возвращает ошибку и не блокирует следующий цикл", async () => {
    const c0 = await cursor();
    await db.exec("alter table rin_packages rename to rin_packages_off");
    const s = await poll();
    await db.exec("alter table rin_packages_off rename to rin_packages");
    expect(s).toMatchObject({ skipped: false, fetched: 0, cursor: c0 });
    expect(s.error).toBeTruthy();
    expect(await poll()).toMatchObject({ skipped: false, error: null });
  });

  it("заглушка «РиН» (dev) отдаёт пакеты синтетики data/synth; пакет объекта в разборе откладывается и забирается следующим циклом", async () => {
    const app = await buildApp(db); // маршруты заглушки регистрируются здесь, внутри теста
    const get = (url: string) => app.inject({ method: "GET", url });
    pull.setRinPullTransport(async (url) => {
      const u = new URL(url);
      const r = await get(u.pathname.replace(/^\/rin\//, "/mock-rin/") + u.search);
      return { status: r.statusCode, body: r.rawPayload };
    });
    await dbm.setMeta(db, "rin_pull_cursor", ""); // синтетика датирована раньше пакетов выше
    expect((await get("/mock-rin/api/v1/packages")).statusCode).toBe(200); // по умолчанию заглушка поднята
    pull.rinPullMock.down = true;
    expect((await poll()).error).toContain("HTTP 503");
    expect((await get("/mock-rin/api/v1/packages/SYNTH-OBJ-SEV-2-1/files/SEV-PD-PZ-1")).statusCode).toBe(503);
    pull.rinPullMock.down = false;
    const s1 = await poll();
    expect(s1).toMatchObject({ error: null, fetched: 4, pending: 1, rejected: 0 }); // SCH, SEV, SKL, POL-1; POL-2 ждёт разбора POL-1
    expect(await row("SYNTH-OBJ-POL-115-2")).toMatchObject({ status: "PENDING" });
    expect((await row("SYNTH-OBJ-POL-115-2")).rin_created_at > (await row("SYNTH-OBJ-POL-115-1")).rin_created_at).toBe(true); // _late — позже основного
    const pol = (await row("SYNTH-OBJ-POL-115-1")).inspection_id;
    await settled(pol);
    for (const o of ["SCH-8", "SEV-2", "SKL-5"]) await settled((await row(`SYNTH-OBJ-${o}-1`)).inspection_id);
    const s2 = await poll();
    expect(s2.fetched).toBe(1);
    expect(await row("SYNTH-OBJ-POL-115-2")).toMatchObject({ status: "FETCHED", inspection_id: pol });
    expect(await count("select count(*) n from files where inspection_id = $1", pol)).toBe(7); // 5 в первом пакете + 2 из _late
    expect(await count("select count(*) n from files where inspection_id = $1", (await row("SYNTH-OBJ-SEV-2-1")).inspection_id)).toBe(13);
    await settled(pol);
    // since включительно: ровно с момента пакета — он сам и более поздние
    const late = (await row("SYNTH-OBJ-POL-115-2")).rin_created_at;
    expect((await get(`/mock-rin/api/v1/packages?since=${encodeURIComponent(late)}`)).json().map((p: any) => p.package_id)).toContain("SYNTH-OBJ-POL-115-2");
    expect((await get(`/mock-rin/api/v1/packages?since=${encodeURIComponent(late)}`)).json().map((p: any) => p.package_id)).not.toContain("SYNTH-OBJ-POL-115-1");
    expect((await get("/mock-rin/api/v1/packages/SYNTH-OBJ-SEV-2-1/files/..%2F..%2Fmanifest.json")).statusCode).toBe(404);
    expect((await get("/mock-rin/api/v1/packages/НЕТ/files/SEV-PD-PZ-1")).statusCode).toBe(404);
  });
});

describe("захват пакета между процессами API (OS-INSP-1.2.16, T-107)", () => {
  it("параллельные захваты одного пакета — забирает один; пакет с итогом не захватывается; захват упавшего процесса истекает", async () => {
    const got = await Promise.all(Array.from({ length: 4 }, () => pull.claimRinPackage(db, "CLAIM-1", "RIN-C1", "2026-09-25T12:00:00.000Z")));
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await row("CLAIM-1")).toMatchObject({ status: "IN_FLIGHT", attempts: 1 });
    // захват свежий — второй процесс пакет не берёт
    expect(await pull.claimRinPackage(db, "CLAIM-1", "RIN-C1", null)).toBe(false);
    // процесс упал посреди забора: захват старше срока — пакет забирается снова, attempts растёт
    await db.run("update rin_packages set updated_at = $1 where package_id = 'CLAIM-1'", [new Date(Date.now() - pull.PACKAGE_LEASE_MS - 1000).toISOString()]);
    expect(await pull.claimRinPackage(db, "CLAIM-1", "RIN-C1", null)).toBe(true);
    expect((await row("CLAIM-1")).attempts).toBe(2);
    // PENDING (повтор следующего цикла) захватывается; итог — нет
    await db.run("update rin_packages set status = 'PENDING' where package_id = 'CLAIM-1'");
    expect(await pull.claimRinPackage(db, "CLAIM-1", "RIN-C1", null)).toBe(true);
    await db.run("update rin_packages set status = 'FETCHED' where package_id = 'CLAIM-1'");
    expect(await Promise.all([pull.claimRinPackage(db, "CLAIM-1", "RIN-C1", null), pull.claimRinPackage(db, "CLAIM-1", "RIN-C1", null)])).toEqual([false, false]);
    expect((await row("CLAIM-1")).attempts).toBe(3);
  });
});

describe("конфиг автозабора (громкая проверка при старте)", async () => {
  const { spawnSync } = await import("node:child_process");
  const load = (env: Record<string, string>) =>
    // профиль gpu требует ещё RabbitMQ и TLS (проверяются в своих тестах) — здесь только автозабор
    spawnSync(process.execPath, ["-e", "const m = await import('./src/config.ts'); console.log(JSON.stringify(m.rinPull))"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_BLOB_KEY_FILE: "tests/fixtures/at-rest/blob.key", INSPECTOR_BLOB_WORK_DIR: "/dev/shm/inspector-blob-work", INSPECTOR_AMQP_URL: "amqps://rabbit", INSPECTOR_ML_URL: "https://ml:8811", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "c.pem", INSPECTOR_TLS_KEY: "k.pem", INSPECTOR_AV: "", INSPECTOR_RIN_PULL: "", INSPECTOR_RIN_PULL_SEC: "", INSPECTOR_RIN_PULL_TIMEOUT_MS: "", ...env },
      encoding: "utf8",
    });
  it("dev — выключен явно, gpu — включён, интервал по умолчанию 300 с; неверный режим или интервал — отказ старта", () => {
    const dev = load({ INSPECTOR_PROFILE: "dev" });
    expect(dev.status).toBe(0);
    expect(JSON.parse(dev.stdout)).toEqual({ on: false, intervalSec: 300, timeoutMs: 30000 });
    const gpu = load({ INSPECTOR_PROFILE: "gpu" });
    expect(gpu.status, gpu.stderr).toBe(0);
    expect(JSON.parse(gpu.stdout).on).toBe(true);
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_RIN_URL: "" }).stderr).toContain("требует INSPECTOR_RIN_URL");
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_RIN_URL: "", INSPECTOR_RIN_PULL: "off" }).status).toBe(0);
    expect(JSON.parse(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_RIN_PULL: "on", INSPECTOR_RIN_PULL_SEC: "15" }).stdout)).toMatchObject({ on: true, intervalSec: 15 });
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_RIN_PULL: "maybe" }).stderr).toContain("ждём off или on");
    for (const v of ["0", "-5", "1.5", "abc"]) expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_RIN_PULL_SEC: v }).stderr).toContain("INSPECTOR_RIN_PULL_SEC");
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_RIN_PULL_TIMEOUT_MS: "0" }).stderr).toContain("INSPECTOR_RIN_PULL_TIMEOUT_MS");
  });
});
