// OS-INSP-1.2.20…1.2.27, 1.2.36…1.2.43 Загрузчик пакета: архив ZIP, папка или файлы → одна проверка через API приёма.
//
//   node apps/api/src/cli/load-package.ts <архив.zip | папка | файлы…> --api https://host:port [--ca ca.pem]
//        --login L --password-file F (--object-id ID --object-name "…" [--address …] | --process-id P-…) [--approval]
//        [--import-dir каталог-хранилища-API [--import-key-file ключ-хранения]]
//        [--out каталог-отчёта] [--no-start] [--wait] [--wait-timeout-min 180] [--poll-sec 10]
//
// Порядок: чтение входа → безопасность путей и сжатие записей (1.2.22, 1.2.23) → SHA-256 → дубликаты (1.2.26) → реестр:
// найденный в пакете или выведенный из папок и имён (1.2.24, 1.2.25) → вход → порции ≤ 2 ГБ (1.2.42) → в каждой
// порции файлы ≤ 50 МБ частями ≤ 200 МБ (1.2.27), файлы больше — серверным импортом (1.2.36): файл кладётся в каталог
// хранилища API (--import-dir) и регистрируется по SHA-256; без --import-dir — FILE_TOO_LARGE в отчёте (1.2.43).
// Первая передача создаёт проверку, остальные дозагружаются в неё; --process-id — сразу в существующую (1.2.41).
// Пароль читается только из файла и нигде не печатается. Архив не распаковывается на диск: записи читаются потоком.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ArchiveRejected,
  DEFAULT_BATCH,
  DEFAULT_LIMITS,
  MAX_UNPACKED_BYTES,
  checkLimits,
  dedupeBySha,
  deriveRegistry,
  isJunk,
  isRegistryFile,
  planBatches,
  planPortions,
  splitForImport,
  uniqueNames,
  type BatchLimits,
  type DerivedNote,
  type Limits,
} from "../domain/archive.ts";
import { parseEncryptionKey } from "../domain/blob-crypto.ts";
import { MAX_FILE_BYTES, parseManifest, type Manifest } from "../domain/upload.ts";
import { listEntries, readEntry, streamEntry, walkDir } from "../services/archive-reader.ts";
import { stageBlob, type Feed } from "../services/stage-blob.ts";

// ─────────────────────────────── транспорт

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** HTTP(S) средствами Node: свой корень доверия (--ca) без подмены системного хранилища; сертификат сервера проверяется всегда. */
export function nodeHttp(opts: { ca?: Buffer; timeoutMs?: number } = {}): Http {
  return (req) =>
    new Promise((resolveRes, reject) => {
      const u = new URL(req.url);
      const lib = u.protocol === "https:" ? https : http;
      const headers: Record<string, string | number> = { ...(req.headers ?? {}) };
      if (req.body) headers["content-length"] = req.body.length;
      const r = lib.request(u, { method: req.method, headers, ...(u.protocol === "https:" ? { ca: opts.ca, rejectUnauthorized: true } : {}) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolveRes({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      r.setTimeout(opts.timeoutMs ?? 30 * 60_000, () => r.destroy(new Error(`${req.method} ${u.pathname}: нет ответа за ${(opts.timeoutMs ?? 1_800_000) / 60_000} мин`)));
      r.on("error", reject);
      r.end(req.body);
    });
}

export function multipart(fields: Record<string, string>, files: Array<{ field: string; name: string; buf: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = "----inspector-loader-" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    const name = f.name.replace(/["\r\n]/g, "_");
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: HttpResponse): any {
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch {
    return { error: res.body.toString("utf8").slice(0, 300) };
  }
}

/** Клиент API: вход по логину и паролю, дальше — токен в заголовке. */
/** Адрес API для входа с паролем: только https, открытый http — лишь на петле (SEC-09: пароль не уходит в сеть открытым текстом). */
export function checkApiUrl(api: string): string {
  const u = new URL(api);
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:" || (u.protocol === "http:" && loop)) return api;
  throw new Error(`--api ${u.protocol}//${u.host}: вход по паролю только через https (открытый http — лишь для 127.0.0.1)`);
}

export async function apiClient(base: string, http: Http, login: string, password: string) {
  const root = base.replace(/\/+$/, "");
  const r = await http({ method: "POST", url: `${root}/api/v1/auth/login`, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ login, password })) });
  if (r.status !== 200) throw new ApiError(r.status, `Вход не выполнен (${r.status}): ${json(r).error ?? ""}`);
  const token = json(r).token as string;
  const call = async (method: string, path: string, body?: Buffer, contentType?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (contentType) headers["content-type"] = contentType;
    return http({ method, url: `${root}${path}`, headers, body });
  };
  return { call, root };
}

// ─────────────────────────────── вход пакета

interface Source {
  path: string;
  size: number;
  read(): Promise<Buffer>;
  hash(): Promise<string>;
  /** Байты потоком — для серверного импорта без чтения файла целиком (OS-INSP-1.2.40). */
  feed: Feed;
}

async function hashStream(feed: (onChunk: (b: Buffer) => void) => Promise<void>): Promise<string> {
  const h = createHash("sha256");
  await feed((b) => h.update(b));
  return h.digest("hex");
}

const fileFeed = (abs: string) => (onChunk: (b: Buffer) => void) =>
  new Promise<void>((res, rej) => {
    const s = createReadStream(abs);
    s.on("data", (b) => onChunk(b as Buffer));
    s.on("end", () => res());
    s.on("error", rej);
  });

export type InputKind = "zip" | "dir" | "files";

async function collect(inputs: string[], limits: Limits): Promise<{ kind: InputKind; sources: Source[]; archive?: { path: string; sha256: string; bytes: number } }> {
  if (!inputs.length) throw new Error("Не указан вход: архив ZIP, папка или файлы");
  const first = resolve(inputs[0]);
  const st = await stat(first);
  if (inputs.length === 1 && st.isFile() && first.toLowerCase().endsWith(".zip")) {
    const entries = await listEntries(first, limits);
    return {
      kind: "zip",
      archive: { path: first, sha256: await hashStream(fileFeed(first)), bytes: st.size },
      sources: entries.map((e) => ({
        path: e.path,
        size: e.size,
        read: () => readEntry(first, e, limits),
        hash: () => hashStream((cb) => streamEntry(first, e, cb, limits)),
        feed: (cb) => streamEntry(first, e, cb, limits),
      })),
    };
  }
  if (inputs.length === 1 && st.isDirectory()) {
    const files = await walkDir(first);
    checkLimits(files.map((f) => ({ name: f.path, compressed: f.size, size: f.size })), limits);
    return { kind: "dir", sources: files.map((f) => ({ path: f.path, size: f.size, read: () => readFile(f.abs), hash: () => hashStream(fileFeed(f.abs)), feed: fileFeed(f.abs) })) };
  }
  const sources: Source[] = [];
  for (const p of inputs) {
    const abs = resolve(p);
    const s = await stat(abs);
    if (!s.isFile()) throw new Error(`${p}: не файл — папку и архив передавайте единственным аргументом`);
    sources.push({ path: basename(abs), size: s.size, read: () => readFile(abs), hash: () => hashStream(fileFeed(abs)), feed: fileFeed(abs) });
  }
  checkLimits(sources.map((s) => ({ name: s.path, compressed: s.size, size: s.size })), limits);
  return { kind: "files", sources };
}

// ─────────────────────────────── отчёт о приёме

export interface IntakeReport {
  schema: "inspector.intake-report/2";
  started_at: string;
  finished_at: string;
  duration_s: number;
  input: { kind: InputKind; paths: string[]; archive_sha256: string | null; archive_bytes: number | null };
  api: string;
  object: { object_id: string; name: string; address: string };
  entries: { total: number; junk_skipped: string[]; documents: number; unique: number; duplicates: Array<{ path: string; same_as: string; sha256: string }> };
  registry: {
    source: "found" | "derived";
    file: string | null;
    approval_source: "operator" | "none" | "registry";
    files: number;
    derived?: DerivedNote[];
    renamed?: Array<{ path: string; file_name: string }>;
  };
  local_rejected: Array<{ path: string; code: string; message: string }>;
  parts: Array<{ index: number; files: number; bytes: number; process_id: string | null; http_status: number; accepted: number; rejected: number }>;
  /** OS-INSP-1.2.42: порции пакета ≤ 2 ГБ — все в одну проверку. */
  portions: Array<{ index: number; files: number; bytes: number }>;
  /** OS-INSP-1.2.36: файлы больше 50 МБ — серверным импортом: положены в каталог хранилища и зарегистрированы по SHA-256. */
  server_import: Array<{ path: string; file_name: string; sha256: string; bytes: number; staged: "written" | "present"; http_status: number; accepted: boolean; code: string | null }>;
  /** Проверка задана оператором (--process-id): пакет дозагружен в неё, новой не создано (OS-INSP-1.2.41). */
  process_id_given: boolean;
  accepted: Array<{ path: string; file_name: string; sha256: string; doc_stage: string; file_id: string; source: "upload" | "server_import" }>;
  rejected: Array<{ path: string | null; file_name: string; code: string; message: string }>;
  process_id: string | null;
  started: boolean;
  final_status: string | null;
}

export interface LoadOptions {
  inputs: string[];
  api: string;
  login: string;
  password: string;
  /** Карточка объекта для новой проверки; при processId не нужна. */
  object?: { object_id: string; name: string; address?: string };
  /** OS-INSP-1.2.41: дозагрузка в существующую проверку — новой не создаётся. */
  processId?: string;
  /** OS-INSP-1.2.36: каталог хранилища API (INSPECTOR_BLOB_DIR) — сюда кладутся файлы больше 50 МБ. */
  importDir?: string;
  /** Ключ хранения API (INSPECTOR_BLOB_KEY_FILE), если файлы хранилища шифруются (IBE1). */
  importKey?: Buffer | null;
  /** OS-INSP-1.2.42: объём порции, байт (по умолчанию 2 ГБ). */
  portionBytes?: number;
  approval?: boolean;
  out?: string;
  start?: boolean;
  wait?: boolean;
  waitTimeoutMs?: number;
  pollMs?: number;
  limits?: Partial<Limits>;
  batch?: Partial<BatchLimits>;
  log?: (s: string) => void;
}

const MB = (n: number) => `${(n / 1048576).toFixed(1)} МБ`;

export async function loadPackage(o: LoadOptions, httpImpl: Http): Promise<IntakeReport> {
  const t0 = Date.now();
  const log = o.log ?? ((s: string) => process.stdout.write(s + "\n"));
  if (!o.processId && !o.object) throw new Error("Нужна карточка объекта (--object-id, --object-name) или существующая проверка (--process-id)");
  // OS-INSP-1.2.42: объём пакета не предел — пакет делится на порции; от бомб защищает сжатие каждой записи (1.2.23)
  const limits: Limits = { ...DEFAULT_LIMITS, maxTotal: Number.POSITIVE_INFINITY, ...o.limits };
  const { kind, sources: all, archive } = await collect(o.inputs, limits);
  const junk = all.filter((s) => isJunk(s.path)).map((s) => s.path);
  const sources = all.filter((s) => !isJunk(s.path));
  log(`вход: ${kind}, записей ${all.length}${junk.length ? `, служебных пропущено ${junk.length}` : ""}`);

  // реестр пакета: manifest*.json|csv или «реестр*» — описание, а не документ
  const regSrc = sources.find((s) => isRegistryFile(s.path)) ?? null;
  const docs = sources.filter((s) => !isRegistryFile(s.path));
  let found: Manifest | null = null;
  if (regSrc) found = parseManifest(regSrc.path, await regSrc.read());

  const hashed: Array<{ path: string; size: number; sha256: string; src: Source }> = [];
  for (const [i, s] of docs.entries()) {
    hashed.push({ path: s.path, size: s.size, sha256: await s.hash(), src: s });
    if ((i + 1) % 10 === 0 || i + 1 === docs.length) log(`SHA-256: ${i + 1}/${docs.length}`);
  }
  const { unique, duplicates } = dedupeBySha(hashed);
  log(`уникальных ${unique.length}, дубликатов ${duplicates.length}`);

  // имя на сервере и реестр
  let manifest: Manifest;
  let registry: IntakeReport["registry"];
  const names = new Map<string, string>(); // path → file_name
  if (found) {
    const un = uniqueNames(unique.map((u) => u.path));
    unique.forEach((u, i) => names.set(u.path, un[i]));
    manifest = found;
    registry = { source: "found", file: regSrc!.path, approval_source: "registry", files: found.files.length };
  } else {
    const d = deriveRegistry(unique, { approval: o.approval, object_id: o.object?.object_id ?? o.processId! });
    d.notes.files.forEach((n) => names.set(n.path, n.file_name));
    manifest = d.manifest;
    registry = { source: "derived", file: null, approval_source: d.notes.approval_source, files: d.manifest.files.length, derived: d.notes.files, renamed: d.notes.renamed };
  }
  const byName = new Map(manifest.files.map((f) => [f.file_name, f]));

  // OS-INSP-1.2.36, 1.2.43: больше предела файла — серверным импортом; без каталога хранилища — явный отказ в отчёте
  const maxFileBytes = o.batch?.maxFileBytes ?? MAX_FILE_BYTES;
  const maxPartBytes = o.batch?.maxBytes ?? DEFAULT_BATCH.maxBytes;
  const isLarge = (f: { size: number }) => f.size > maxFileBytes || f.size > maxPartBytes;
  const split = splitForImport(unique, Math.min(maxFileBytes, maxPartBytes));
  const local_rejected = o.importDir
    ? []
    : split.large.map((f) => ({ path: f.path, code: "FILE_TOO_LARGE", message: `${f.path}: ${MB(f.size)} больше предела интерактивной загрузки — передайте его серверным импортом: --import-dir <каталог хранилища API> (OS-INSP-1.2.36)` }));
  const toSend = o.importDir ? unique : split.interactive;
  const portions = planPortions(toSend, o.portionBytes ?? MAX_UNPACKED_BYTES);
  log(`порций ${portions.length}: ${portions.map((p) => `${p.files.length} ф. / ${MB(p.bytes)}`).join("; ") || "—"}; серверным импортом ${o.importDir ? split.large.length : 0}${local_rejected.length ? `, не передано (нет --import-dir) ${local_rejected.length}` : ""}`);

  const api = await apiClient(o.api, httpImpl, o.login, o.password);
  let processId: string | null = o.processId ?? null;
  if (processId) {
    // OS-INSP-1.2.41: проверки нет — отказ до передачи файлов
    const r = await api.call("GET", `/api/v1/inspection/${encodeURIComponent(processId)}/status`);
    if (r.status !== 200) throw new ApiError(r.status, `Проверка ${processId}: ${r.status === 404 ? "не найдена" : `сервер ответил ${r.status}`} — файлы не передавались`);
  }
  const card = o.object ? { object_id: o.object.object_id, name: o.object.name, address: o.object.address ?? "" } : null;
  const report: IntakeReport = {
    schema: "inspector.intake-report/2",
    started_at: new Date(t0).toISOString(),
    finished_at: "",
    duration_s: 0,
    input: { kind, paths: o.inputs.map((p) => resolve(p)), archive_sha256: archive?.sha256 ?? null, archive_bytes: archive?.bytes ?? null },
    api: api.root,
    object: card ?? { object_id: "", name: "", address: "" },
    entries: { total: all.length, junk_skipped: junk, documents: docs.length, unique: unique.length, duplicates },
    registry,
    local_rejected,
    parts: [],
    portions: portions.map((p, i) => ({ index: i + 1, files: p.files.length, bytes: p.bytes })),
    server_import: [],
    process_id_given: Boolean(o.processId),
    accepted: [],
    rejected: [],
    process_id: null,
    started: false,
    final_status: null,
  };

  // реестр части — только её файлы: сервер объединяет реестры дозагрузок (OS-INSP-1.2.27)
  const partManifest = (paths: Set<string>): Manifest | null => {
    const files = manifest.files.filter((m) => paths.has(m.file_name));
    if (!files.length) return null;
    const first = !processId && found?.object; // карточка из найденного реестра — только с первой передачей
    return { files, ...(first ? { object: found!.object } : {}) };
  };
  const take = (body: any, pathOf: Map<string, string>, source: "upload" | "server_import") => {
    for (const a of body.accepted ?? []) {
      report.accepted.push({ path: pathOf.get(a.file_name) ?? a.file_name, file_name: a.file_name, sha256: a.sha256, doc_stage: byName.get(a.file_name)?.doc_stage ?? a.doc_stage, file_id: a.file_id, source });
    }
    for (const x of body.rejected ?? []) report.rejected.push({ path: pathOf.get(x.file_name) ?? null, file_name: x.file_name, code: x.code, message: x.message });
  };

  let partNo = 0;
  const partsTotal = portions.reduce((n, p) => n + planBatches(p.files.filter((f) => !isLarge(f)), o.batch).batches.length, 0);
  log(`частей ${partsTotal} (до ${MB(maxPartBytes)} каждая), серверным импортом ${portions.reduce((n, p) => n + p.files.filter(isLarge).length, 0)}`);
  for (const [k, portion] of portions.entries()) {
    if (portions.length > 1) log(`порция ${k + 1}/${portions.length}: ${portion.files.length} ф., ${MB(portion.bytes)}`);
    const plan = planBatches(portion.files.filter((f) => !isLarge(f)), o.batch);
    for (const b of plan.batches) {
      const i = partNo++;
      const files: Array<{ field: string; name: string; buf: Buffer }> = [];
      const pathOf = new Map<string, string>();
      for (const f of b.files) {
        const name = names.get(f.path)!;
        pathOf.set(name, f.path);
        files.push({ field: "files", name, buf: await f.src.read() });
      }
      const m = partManifest(new Set(pathOf.keys()));
      if (m) files.push({ field: "manifest", name: "manifest.json", buf: Buffer.from(JSON.stringify(m)) });
      const fields: Record<string, string> = { start: "false" };
      if (processId) fields.process_id = processId;
      else fields.object = JSON.stringify(card);
      const mp = multipart(fields, files);
      log(`часть ${i + 1}/${partsTotal}: ${b.files.length} ф., ${MB(b.bytes)} → отправка`);
      const r = await api.call("POST", "/api/v1/documents/upload", mp.body, mp.contentType);
      const body = json(r);
      if (r.status !== 202 && r.status !== 400) throw new ApiError(r.status, `Часть ${i + 1}: сервер ответил ${r.status}: ${body.error ?? body.message ?? ""}`);
      if (r.status === 400 && !body.process_id) throw new ApiError(r.status, `Часть ${i + 1}: ${body.error ?? body.message ?? "отказ"}`);
      processId = processId ?? body.process_id;
      take(body, pathOf, "upload");
      report.parts.push({ index: i + 1, files: b.files.length, bytes: b.bytes, process_id: processId, http_status: r.status, accepted: (body.accepted ?? []).length, rejected: (body.rejected ?? []).length });
      log(`часть ${i + 1}: принято ${(body.accepted ?? []).length}, отклонено ${(body.rejected ?? []).length}, проверка ${processId}`);
    }
    // OS-INSP-1.2.36: большие файлы — по одному: положить в каталог хранилища потоком, зарегистрировать по SHA-256
    for (const f of portion.files.filter(isLarge)) {
      const name = names.get(f.path)!;
      log(`серверный импорт: ${f.path} (${MB(f.size)}) → каталог хранилища`);
      const staged = await stageBlob(o.importDir!, f.sha256, f.src.feed, o.importKey ?? null);
      const m = partManifest(new Set([name]));
      const req: Record<string, unknown> = { files: [{ sha256: f.sha256, file_name: name }], start: false, ...(m ? { manifest: m } : {}) };
      if (processId) req.process_id = processId;
      else req.object = card;
      const r = await api.call("POST", "/api/v1/documents/import", Buffer.from(JSON.stringify(req)), "application/json");
      const body = json(r);
      if (r.status !== 202 && r.status !== 400) throw new ApiError(r.status, `Серверный импорт ${f.path}: сервер ответил ${r.status}: ${body.error ?? body.message ?? ""}`);
      if (r.status === 400 && !body.process_id) throw new ApiError(r.status, `Серверный импорт ${f.path}: ${body.error ?? body.message ?? "отказ"}`);
      processId = processId ?? body.process_id;
      take(body, new Map([[name, f.path]]), "server_import");
      const rej = (body.rejected ?? [])[0];
      report.server_import.push({ path: f.path, file_name: name, sha256: f.sha256, bytes: f.size, staged: staged.state, http_status: r.status, accepted: (body.accepted ?? []).length > 0, code: rej?.code ?? null });
      log(`серверный импорт ${f.path}: ${rej ? `отказ ${rej.code}` : "принят"}, проверка ${processId}`);
    }
  }
  report.process_id = processId;

  if (processId && o.start !== false && report.accepted.length) {
    const r = await api.call("POST", `/api/v1/inspection/${processId}/start`);
    if (r.status !== 200) throw new ApiError(r.status, `Запуск разбора: ${r.status} ${json(r).error ?? ""}`);
    report.started = true;
    log(`разбор запущен: в очереди ${json(r).queued ?? "?"}`);
  }
  if (processId) {
    const statusOf = async () => json(await api.call("GET", `/api/v1/inspection/${processId}/status`));
    let s = await statusOf();
    if (o.wait && report.started) {
      const deadline = Date.now() + (o.waitTimeoutMs ?? 3 * 3600_000);
      while (s.status === "PARSING" || s.status === "PENDING") {
        if (Date.now() > deadline) {
          log(`ожидание прервано по таймауту, статус ${s.status}`);
          break;
        }
        await new Promise((r) => setTimeout(r, o.pollMs ?? 10_000));
        s = await statusOf();
        const files = (s.files ?? []) as Array<{ parse_status: string }>;
        const done = files.filter((f) => f.parse_status !== "PENDING" && f.parse_status !== "PARSING").length;
        log(`статус ${s.status}: разобрано ${done}/${files.length}`);
      }
    }
    report.final_status = s.status ?? null;
  }
  report.finished_at = new Date().toISOString();
  report.duration_s = Math.round((Date.now() - t0) / 100) / 10;
  if (o.out) await writeIntakeReport(o.out, report);
  return report;
}

// ─────────────────────────────── запись отчёта

export function intakeMarkdown(r: IntakeReport): string {
  const L: string[] = [];
  L.push(`# Отчёт о приёме пакета`, "");
  L.push(`- Проверка: \`${r.process_id ?? "не создана"}\`${r.process_id_given ? " (задана оператором — пакет дозагружен в неё, новой не создано)" : ""}, статус ${r.final_status ?? "—"}${r.started ? ", разбор запущен" : ", разбор не запускался"}`);
  if (r.object.object_id) L.push(`- Объект: ${r.object.name} (\`${r.object.object_id}\`)${r.object.address ? `, ${r.object.address}` : ""}`);
  L.push(`- Вход: ${r.input.kind} ${r.input.paths.map((p) => basename(p)).join(", ")}`);
  if (r.input.archive_sha256) L.push(`- SHA-256 архива: \`${r.input.archive_sha256}\` (${MB(r.input.archive_bytes ?? 0)})`);
  L.push(`- Время: ${r.started_at} — ${r.finished_at} (${r.duration_s} с)`, "");
  L.push(`## Состав`, "");
  const imported = r.accepted.filter((a) => a.source === "server_import").length;
  L.push(`| Всего записей | Служебных | Документов | Уникальных | Дубликатов | Принято | из них серверным импортом | Отклонено сервером | Не передано (предел файла) |`, `|---|---|---|---|---|---|---|---|---|`);
  L.push(`| ${r.entries.total} | ${r.entries.junk_skipped.length} | ${r.entries.documents} | ${r.entries.unique} | ${r.entries.duplicates.length} | ${r.accepted.length} | ${imported} | ${r.rejected.length} | ${r.local_rejected.length} |`, "");
  const stages = r.accepted.reduce<Record<string, number>>((a, x) => ((a[x.doc_stage] = (a[x.doc_stage] ?? 0) + 1), a), {});
  L.push(`Принято по стадиям: ${Object.entries(stages).map(([k, v]) => `${k} — ${v}`).join(", ") || "—"}.`, "");
  L.push(`## Реестр`, "");
  if (r.registry.source === "found") L.push(`Реестр найден в пакете: \`${r.registry.file}\`, файлов ${r.registry.files}. Статус утверждения — из реестра.`);
  else {
    const d = r.registry.derived ?? [];
    const cnt = (k: string) => d.filter((x) => x.stage_source === k).length;
    L.push(`Реестра в пакете нет — **реестр выведен** (OS-INSP-1.2.24): стадия по папке у ${cnt("folder")}, по имени у ${cnt("name")}, по умолчанию (ПД) у ${cnt("default")};`);
    L.push(`шифр из имени у ${d.filter((x) => x.code_from_name).length} из ${d.length}, раздел из имени у ${d.filter((x) => x.discipline_from_name).length}.`);
    L.push(`Статус утверждения: ${r.registry.approval_source === "operator" ? "поставлен по явному подтверждению оператора (--approval)" : "не задан — подтверждения оператора не было"} (OS-INSP-1.2.25).`);
    if (r.registry.renamed?.length) L.push("", `Совпадающие имена переданы с номером: ${r.registry.renamed.map((x) => `\`${x.path}\` → \`${x.file_name}\``).join("; ")}.`);
  }
  if (r.portions.length > 1) {
    L.push("", `## Порции (OS-INSP-1.2.42)`, "", `Пакет больше порции — передан ${r.portions.length} порциями в одну проверку.`, "", `| № | Файлов | Объём |`, `|---|---|---|`);
    for (const p of r.portions) L.push(`| ${p.index} | ${p.files} | ${MB(p.bytes)} |`);
  }
  L.push("", `## Части`, "", `| № | Файлов | Объём | HTTP | Принято | Отклонено |`, `|---|---|---|---|---|---|`);
  for (const p of r.parts) L.push(`| ${p.index} | ${p.files} | ${MB(p.bytes)} | ${p.http_status} | ${p.accepted} | ${p.rejected} |`);
  if (r.server_import.length) {
    L.push("", `## Серверный импорт (OS-INSP-1.2.36)`, "", `Файлы больше предела интерактивной загрузки положены в каталог хранилища API и зарегистрированы по SHA-256; источник в реестре — «серверный импорт».`, "");
    L.push(`| Файл | Объём | SHA-256 | В хранилище | HTTP | Итог |`, `|---|---|---|---|---|---|`);
    for (const x of r.server_import) L.push(`| \`${x.path}\` | ${MB(x.bytes)} | \`${x.sha256.slice(0, 16)}…\` | ${x.staged === "written" ? "положен" : "уже был"} | ${x.http_status} | ${x.accepted ? "принят" : `отказ ${x.code ?? ""}`} |`);
  }
  if (r.entries.duplicates.length) {
    L.push("", `## Дубликаты (не переданы, OS-INSP-1.2.26)`, "");
    for (const d of r.entries.duplicates) L.push(`- \`${d.path}\` = \`${d.same_as}\` (SHA-256 \`${d.sha256.slice(0, 16)}…\`)`);
  }
  if (r.rejected.length || r.local_rejected.length) {
    L.push("", `## Отклонено`, "");
    for (const x of r.local_rejected) L.push(`- \`${x.path}\` — ${x.code}: ${x.message}`);
    for (const x of r.rejected) L.push(`- \`${x.path ?? x.file_name}\` — ${x.code}: ${x.message}`);
  }
  if (r.entries.junk_skipped.length) L.push("", `Служебные записи пропущены: ${r.entries.junk_skipped.map((j) => `\`${j}\``).join(", ")}.`);
  return L.join("\n") + "\n";
}

export async function writeIntakeReport(dir: string, r: IntakeReport): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "intake-report.json"), JSON.stringify(r, null, 2) + "\n");
  await writeFile(join(dir, "intake-report.md"), intakeMarkdown(r));
}

// ─────────────────────────────── командная строка

export async function readPassword(file: string): Promise<string> {
  const p = (await readFile(file, "utf8")).replace(/\r?\n$/, "");
  if (!p) throw new Error(`Файл пароля ${file} пуст`);
  return p;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      api: { type: "string" },
      ca: { type: "string" },
      login: { type: "string" },
      "password-file": { type: "string" },
      "object-id": { type: "string" },
      "process-id": { type: "string" },
      "import-dir": { type: "string" },
      "import-key-file": { type: "string" },
      "object-name": { type: "string" },
      address: { type: "string" },
      approval: { type: "boolean", default: false },
      out: { type: "string" },
      "no-start": { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      "wait-timeout-min": { type: "string" },
      "poll-sec": { type: "string" },
    },
  });
  const need = (k: keyof typeof values) => {
    const v = values[k];
    if (typeof v !== "string" || !v) throw new Error(`Не указан --${k}`);
    return v;
  };
  const report = await loadPackage(
    {
      inputs: positionals,
      api: checkApiUrl(need("api")),
      login: need("login"),
      password: await readPassword(need("password-file")),
      processId: values["process-id"],
      object: values["process-id"] && !values["object-id"] ? undefined : { object_id: need("object-id"), name: need("object-name"), address: values.address },
      importDir: values["import-dir"] ? resolve(values["import-dir"]) : undefined,
      importKey: values["import-key-file"] ? parseEncryptionKey(await readFile(values["import-key-file"], "utf8")) : null,
      approval: values.approval,
      out: values.out,
      start: !values["no-start"],
      wait: values.wait,
      waitTimeoutMs: values["wait-timeout-min"] ? Number(values["wait-timeout-min"]) * 60_000 : undefined,
      pollMs: values["poll-sec"] ? Number(values["poll-sec"]) * 1000 : undefined,
    },
    nodeHttp({ ca: values.ca ? await readFile(values.ca) : undefined }),
  );
  process.stdout.write(`готово: проверка ${report.process_id}, принято ${report.accepted.length}, отклонено ${report.rejected.length + report.local_rejected.length}, дубликатов ${report.entries.duplicates.length}${values.out ? `; отчёт — ${values.out}` : ""}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((e: unknown) => {
    const msg = e instanceof ArchiveRejected ? `${e.message}${e.limit ? ` [предел ${e.limit}]` : ""}` : e instanceof Error ? e.message : String(e);
    process.stderr.write(`load-package: ${msg}\n`);
    process.exit(e instanceof ArchiveRejected ? 3 : 1);
  });
}
