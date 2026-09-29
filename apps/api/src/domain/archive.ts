// OS-INSP-1.2.20…1.2.27 Пакет архивом или папкой: имена, безопасность путей, пределы распаковки, выведенный реестр,
// дубликаты и деление на части. Чистые функции; чтение ZIP с диска — services/archive-reader.ts, сеть — cli/load-package.ts.
import type { Manifest, ManifestFile } from "./upload.ts";
import { MAX_FILE_BYTES, MAX_PACKAGE_BYTES } from "./upload.ts";
import { parseDocName } from "./cipher.ts";
import type { Stage } from "./types.ts";

export type ArchiveRejectCode =
  | "TRAVERSAL"
  | "TOO_LARGE"
  | "BOMB"
  | "SIZE_MISMATCH"
  | "CRC_MISMATCH"
  | "CORRUPTED"
  | "ENCRYPTED"
  | "UNSUPPORTED_METHOD"
  | "ZIP64_UNSUPPORTED";

/** Отказ архива целиком (OS-INSP-1.2.22, 1.2.23): код, путь записи и/или предел — для сообщения оператору. */
export class ArchiveRejected extends Error {
  readonly code: ArchiveRejectCode;
  readonly path?: string;
  readonly limit?: string;
  constructor(code: ArchiveRejectCode, message: string, extra: { path?: string; limit?: string } = {}) {
    super(message);
    this.name = "ArchiveRejected";
    this.code = code;
    this.path = extra.path;
    this.limit = extra.limit;
  }
}

// ─────────────────────────────── имена записей (OS-INSP-1.2.21)

// CP866 0x80…0xFF: А–Я, а–п, псевдографика, р–я, Ё ё Є є Ї ї Ў ў и знаки
const CP866_HIGH =
  "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ" +
  "абвгдежзийклмноп" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "рстуфхцчшщъыьэюя" +
  "ЁёЄєЇїЎў°∙·√№¤■ ";

export function decodeCp866(raw: Uint8Array): string {
  let s = "";
  for (const b of raw) s += b < 0x80 ? String.fromCharCode(b) : CP866_HIGH[b - 0x80];
  return s;
}

/** Имя записи: флаг UTF-8 (бит 11) — UTF-8, иначе CP866 — так пишет архиватор Windows с русской локалью. */
export function decodeEntryName(raw: Buffer, utf8: boolean): string {
  return utf8 ? raw.toString("utf8") : decodeCp866(raw);
}

// ─────────────────────────────── безопасность путей (OS-INSP-1.2.22)

/** Относительный путь внутри каталога распаковки; абсолютный путь, «..», диск, NUL — отказ архива целиком. */
export function safeEntryPath(name: string): string {
  const p = name.replace(/\\/g, "/");
  const reject = (why: string) => new ArchiveRejected("TRAVERSAL", `Архив отклонён: путь «${name}» ${why}`, { path: name });
  if (p.includes("\0")) throw reject("содержит нулевой символ");
  if (p.startsWith("/")) throw reject("абсолютный");
  if (/^[A-Za-z]:/.test(p)) throw reject("указывает на диск");
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw reject("выходит за каталог распаковки");
  return segs.join("/");
}

/** Служебный мусор архиваторов и файловых систем: в пакет не передаётся. */
export function isJunk(path: string): boolean {
  const segs = path.split("/");
  const last = segs[segs.length - 1];
  return segs.includes("__MACOSX") || last === ".DS_Store" || last === "Thumbs.db" || last === "desktop.ini" || last.startsWith("._");
}

// ─────────────────────────────── пределы распаковки (OS-INSP-1.2.23)

export const MAX_UNPACKED_BYTES = 2 * 1024 ** 3;
export const MAX_RATIO = 100;

export interface Limits {
  maxTotal: number;
  maxRatio: number;
}
export const DEFAULT_LIMITS: Limits = { maxTotal: MAX_UNPACKED_BYTES, maxRatio: MAX_RATIO };

const mb = (n: number) => `${(n / 1048576).toFixed(1)} МБ`;
const limitText = (n: number) => (n % 1024 ** 3 === 0 ? `${n / 1024 ** 3} ГБ` : mb(n));

/** Заявленные размеры: сумма ≤ предела, у каждой записи сжатие ≤ maxRatio : 1. Нарушение — отказ архива целиком. */
export function checkLimits(entries: Array<{ name: string; compressed: number; size: number }>, limits: Limits = DEFAULT_LIMITS): void {
  let total = 0;
  for (const e of entries) {
    if (e.size > e.compressed * limits.maxRatio) {
      throw new ArchiveRejected("BOMB", `Архив отклонён: запись «${e.name}» сжата сильнее ${limits.maxRatio} к 1 (${e.size} из ${e.compressed} байт)`, {
        path: e.name,
        limit: `${limits.maxRatio}:1`,
      });
    }
    total += e.size;
  }
  if (total > limits.maxTotal) {
    throw new ArchiveRejected("TOO_LARGE", `Архив отклонён: распакованный объём ${mb(total)} больше ${limitText(limits.maxTotal)}`, { limit: limitText(limits.maxTotal) });
  }
}

// ─────────────────────────────── стадия по папке (OS-INSP-1.2.24)

function stageOfSegment(seg: string): Stage | null {
  const s = seg.trim().toLowerCase().replace(/^\d+[\s._-]*/, "");
  if (/^проектн\S*\s+документац/.test(s) || s === "пд") return "PD";
  if (/^рабоч\S*\s+документац/.test(s) || s === "рд") return "RD";
  if (/^исполнительн\S*\s+документац/.test(s) || s === "ид") return "ID";
  return null;
}

/** Стадия по ближайшей к файлу папке «Проектная/Рабочая/Исполнительная документация» (или «ПД», «РД», «ИД»). */
export function stageFromPath(path: string): Stage | null {
  const dirs = path.split("/").slice(0, -1);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const st = stageOfSegment(dirs[i]);
    if (st) return st;
  }
  return null;
}

/** Общая корневая папка архива («Архив/…» у всех записей) — снимается: она не стадия и не часть имени документа. */
export function stripCommonRoot(paths: string[]): string[] {
  if (!paths.length || paths.some((p) => !p.includes("/"))) return paths;
  const root = paths[0].split("/")[0];
  if (paths.some((p) => p.split("/")[0] !== root)) return paths;
  if (stageOfSegment(root)) return paths; // корень сам — «Рабочая документация»: это стадия, а не обёртка
  return paths.map((p) => p.slice(root.length + 1));
}

// ─────────────────────────────── дубликаты (OS-INSP-1.2.26)

export interface HashedFile {
  path: string;
  sha256: string;
  size: number;
}

/** Первый по порядку файл с данным SHA-256 передаётся, остальные — дубликаты со ссылкой на него. */
export function dedupeBySha<T extends { path: string; sha256: string }>(files: T[]): { unique: T[]; duplicates: Array<{ path: string; same_as: string; sha256: string }> } {
  const seen = new Map<string, string>();
  const unique: T[] = [];
  const duplicates: Array<{ path: string; same_as: string; sha256: string }> = [];
  for (const f of files) {
    const first = seen.get(f.sha256);
    if (first !== undefined) duplicates.push({ path: f.path, same_as: first, sha256: f.sha256 });
    else {
      seen.set(f.sha256, f.path);
      unique.push(f);
    }
  }
  return { unique, duplicates };
}

// ─────────────────────────────── выведенный реестр (OS-INSP-1.2.24, 1.2.25)

export type StageSource = "folder" | "name" | "default";

export interface DerivedNote {
  path: string;
  file_id: string;
  file_name: string;
  stage_source: StageSource;
  code_from_name: boolean;
  discipline_from_name: boolean;
  base: string | null;
  mark: string | null;
}

export interface DerivedRegistry {
  manifest: Manifest;
  notes: {
    registry_source: "derived";
    approval_source: "operator" | "none";
    files: DerivedNote[];
    renamed: Array<{ path: string; file_name: string }>;
  };
}

const baseName = (p: string) => p.split("/").pop()!;

/** Имя, под которым файл уходит на сервер: базовое, а при совпадении базовых имён — с номером «(2)» перед расширением. */
export function uniqueNames(paths: string[]): string[] {
  const used = new Set<string>();
  return paths.map((p) => {
    const b = baseName(p);
    let name = b;
    for (let n = 2; used.has(name); n++) {
      const dot = b.lastIndexOf(".");
      name = dot > 0 ? `${b.slice(0, dot)} (${n})${b.slice(dot)}` : `${b} (${n})`;
    }
    used.add(name);
    return name;
  });
}

export function deriveRegistry(files: HashedFile[], opts: { approval?: boolean; object_id: string }): DerivedRegistry {
  const rel = stripCommonRoot(files.map((f) => f.path));
  const names = uniqueNames(files.map((f) => f.path));
  const notes: DerivedNote[] = [];
  const renamed: Array<{ path: string; file_name: string }> = [];
  const out: ManifestFile[] = files.map((f, i) => {
    const d = parseDocName(baseName(f.path));
    const byFolder = stageFromPath(rel[i]);
    const stage: Stage = byFolder ?? (d.stage_letter === "РД" || d.stage_letter === "Р" ? "RD" : "PD");
    const stage_source: StageSource = byFolder ? "folder" : d.stage_letter ? "name" : "default";
    const file_id = `${stage}-${f.sha256.slice(0, 12)}`;
    if (names[i] !== baseName(f.path)) renamed.push({ path: f.path, file_name: names[i] });
    notes.push({
      path: f.path,
      file_id,
      file_name: names[i],
      stage_source,
      code_from_name: d.document_code !== null,
      discipline_from_name: d.discipline !== null,
      base: d.base,
      mark: d.mark,
    });
    const m: ManifestFile = {
      file_id,
      file_name: names[i],
      sha256: f.sha256,
      doc_stage: stage,
      discipline: d.discipline ?? "—",
      document_code: d.document_code ?? baseName(f.path).replace(/\.[^.]+$/, ""),
      revision: d.revision,
    };
    // OS-INSP-1.2.25: утверждение не выводится из имени — только по явному подтверждению оператора
    if (opts.approval) m.approval_status = stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED";
    return m;
  });
  return {
    manifest: { files: out },
    notes: { registry_source: "derived", approval_source: opts.approval ? "operator" : "none", files: notes, renamed },
  };
}

// ─────────────────────────────── деление на части (OS-INSP-1.2.27)

export const MAX_PART_FILES = 200;

export interface BatchLimits {
  maxBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}
export const DEFAULT_BATCH: BatchLimits = { maxBytes: MAX_PACKAGE_BYTES, maxFiles: MAX_PART_FILES, maxFileBytes: MAX_FILE_BYTES };

export interface BatchPlan<T> {
  batches: Array<{ files: T[]; bytes: number }>;
  /** Файлы больше предела файла: не делятся и не передаются — сервер их отклонил бы (OS-INSP-1.2.2) */
  oversize: T[];
}

/** Жадно по порядку: часть закрывается, когда следующий файл превысил бы объём или число файлов. */
export function planBatches<T extends { size: number }>(files: T[], limits: Partial<BatchLimits> = {}): BatchPlan<T> {
  const L = { ...DEFAULT_BATCH, ...limits };
  const batches: Array<{ files: T[]; bytes: number }> = [];
  const oversize: T[] = [];
  let cur: { files: T[]; bytes: number } | null = null;
  for (const f of files) {
    if (f.size > L.maxFileBytes || f.size > L.maxBytes) {
      oversize.push(f);
      continue;
    }
    if (!cur || cur.bytes + f.size > L.maxBytes || cur.files.length >= L.maxFiles) {
      cur = { files: [], bytes: 0 };
      batches.push(cur);
    }
    cur.files.push(f);
    cur.bytes += f.size;
  }
  return { batches, oversize };
}

// ─────────────────────────────── серверный импорт и порции (OS-INSP-1.2.36, 1.2.42, T-169)

/** Файлы до предела интерактивной загрузки идут частями приёма, больше — серверным импортом. Порядок сохраняется. */
export function splitForImport<T extends { size: number }>(files: T[], interactiveMax: number = MAX_FILE_BYTES): { interactive: T[]; large: T[] } {
  return { interactive: files.filter((f) => f.size <= interactiveMax), large: files.filter((f) => f.size > interactiveMax) };
}

/**
 * Порции пакета больше 2 ГБ — все в одну проверку. Жадно по порядку: порция закрывается, когда следующий файл превысил
 * бы предел; файл больше порции идёт отдельной порцией, а не отклоняется. Защита от бомб — предел сжатия у каждой
 * записи (checkLimits), а не объём пакета.
 */
export function planPortions<T extends { size: number }>(files: T[], maxBytes: number = MAX_UNPACKED_BYTES): Array<{ files: T[]; bytes: number }> {
  const out: Array<{ files: T[]; bytes: number }> = [];
  let cur: { files: T[]; bytes: number } | null = null;
  for (const f of files) {
    if (!cur || cur.bytes + f.size > maxBytes) {
      cur = { files: [], bytes: 0 };
      out.push(cur);
    }
    cur.files.push(f);
    cur.bytes += f.size;
  }
  return out;
}

/** Найденный в пакете реестр: manifest*.json|csv или «реестр*.json|csv» — не документ, а описание пакета. */
export function isRegistryFile(path: string): boolean {
  return /^(manifest|реестр)[^/]*\.(json|csv)$/i.test(baseName(path));
}
