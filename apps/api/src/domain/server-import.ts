// OS-INSP-1.2.36…1.2.40 (T-169): серверный импорт файла больше предела интерактивной загрузки. Чистые функции:
// запрос маршрута, отказы с причиной, формат по содержимому и голова с хвостом потока — без диска и сети.
// Файл кладётся в хранилище вне интерактивного запроса (загрузчик, cli/load-package.ts), читается потоком
// (services/server-import.ts) — целиком в память не попадает ни в API, ни в ML.
import { z } from "zod";
import { Manifest, ObjectCard, sniff } from "./upload.ts";

/** Предел одного файла серверного импорта: вдвое больше порции пакета (2 ГБ) — тома ИД до 956 МБ проходят с запасом. */
export const IMPORT_MAX_FILE_BYTES = 4 * 1024 ** 3;
/** Файлов в одном запросе: каждый читается потоком дважды (хеш, антивирус) — запрос не должен тянуться часами. */
export const IMPORT_MAX_FILES = 50;
/** Голова потока — для формата: у DOCX имена частей «word/…» лежат в первых локальных заголовках ZIP. */
export const IMPORT_HEAD_BYTES = 64 * 1024;
/** Хвост потока — для признака конца PDF (%%EOF), как у интерактивной загрузки (domain/upload.ts). */
export const IMPORT_TAIL_BYTES = 2048;
export const IMPORT_FORMATS = ["PDF", "DOCX"] as const;

/** Источник файла в реестре проверки: интерактивная загрузка (и «РиН») или серверный импорт. */
export type IntakeSource = "upload" | "server_import";

export type ImportCode = "IMPORT_NOT_FOUND" | "IMPORT_TOO_LARGE" | "IMPORT_HASH_MISMATCH" | "IMPORT_NOT_ENCRYPTED" | "UNSUPPORTED_FORMAT" | "CORRUPTED";
export type ImportVerdict = { ok: true; kind: "pdf" | "docx" } | { ok: false; code: ImportCode; message: string };

export const ImportFile = z.object({
  // имя файла в хранилище — только хеш: путь снаружи не принимается
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "ждём SHA-256 — 64 строчных шестнадцатеричных символа"),
  file_name: z.string().min(1).max(255),
});

export const ImportRequest = z
  .object({
    process_id: z.string().min(1).max(64).optional(),
    object: ObjectCard.optional(),
    manifest: Manifest.optional(),
    files: z.array(ImportFile).min(1).max(IMPORT_MAX_FILES),
    start: z.boolean().default(false),
  })
  .refine((r) => Boolean(r.process_id || r.object || r.manifest?.object), { message: "Нужна проверка (process_id) или карточка объекта (object)" })
  // OWASP M-003: один и тот же файл в запросе читался бы с диска столько раз, сколько повторён
  .refine((r) => new Set(r.files.map((f) => f.sha256)).size === r.files.length, { message: "SHA-256 в запросе повторяется" });
export type ImportRequest = z.infer<typeof ImportRequest>;

const gb = (n: number) => `${n / 1024 ** 3} ГБ`;

/** До чтения содержимого: объект есть (size не null), не пуст и не больше предела. null — можно читать. */
export function preflight(name: string, sha: string, size: number | null, max: number = IMPORT_MAX_FILE_BYTES): ImportVerdict | null {
  if (size === null) return { ok: false, code: "IMPORT_NOT_FOUND", message: `${name}: файла с SHA-256 ${sha} в хранилище нет — сначала положите его туда (загрузчик с --import-dir)` };
  if (size === 0) return { ok: false, code: "CORRUPTED", message: `${name}: файл в хранилище пуст` };
  if (size > max) return { ok: false, code: "IMPORT_TOO_LARGE", message: `${name}: ${(size / 1024 ** 3).toFixed(2)} ГБ больше предела серверного импорта ${gb(max)}` };
  return null;
}

/**
 * NFR-CRYPTO (OWASP M-002): хранилище шифрует файлы «в покое», а положенный файл — открытым текстом (загрузчик без
 * --import-key-file). Такой файл не принимается: иначе том остался бы на диске незашифрованным навсегда.
 */
export function atRestVerdict(name: string, plainWhileKeyed: boolean): ImportVerdict | null {
  if (!plainWhileKeyed) return null;
  return { ok: false, code: "IMPORT_NOT_ENCRYPTED", message: `${name}: хранилище шифрует файлы, а этот положен открытым текстом — положите его загрузчиком с --import-key-file` };
}

/**
 * OWASP M-003: слоты серверного импорта — не больше одного запроса на пользователя и max на процесс: импорт читает
 * гигабайты внутри HTTP-запроса, параллельные запросы одного инспектора отняли бы диск и антивирус у всех.
 */
export class ImportSlots {
  readonly max: number;
  #total = 0;
  #busy = new Set<string>();
  constructor(max = 2) {
    this.max = max;
  }
  tryAcquire(user: string): boolean {
    if (this.#busy.has(user) || this.#total >= this.max) return false;
    this.#busy.add(user);
    this.#total++;
    return true;
  }
  release(user: string): void {
    if (this.#busy.delete(user)) this.#total--;
  }
  get inUse(): number {
    return this.#total;
  }
}

/** Формат серверного импорта по голове файла: только PDF и DOCX (OS-INSP-1.2.39). */
export function sniffImport(head: Buffer): "pdf" | "docx" | null {
  const k = sniff(head);
  return k === "pdf" || k === "docx" ? k : null;
}

export interface StagedProbe {
  size: number;
  /** SHA-256 открытого текста, посчитанный потоком. */
  sha256: string;
  head: Buffer;
  tail: Buffer;
}

/** Вердикт по прочитанному потоку: хеш — первым (иначе формат судили бы по чужому содержимому), затем формат и конец PDF. */
export function importVerdict(name: string, declared: string, p: StagedProbe): ImportVerdict {
  if (p.sha256 !== declared) return { ok: false, code: "IMPORT_HASH_MISMATCH", message: `${name}: SHA-256 содержимого в хранилище ${p.sha256} не совпадает с заявленным ${declared}` };
  const kind = sniffImport(p.head);
  if (!kind) return { ok: false, code: "UNSUPPORTED_FORMAT", message: `${name}: серверным импортом принимаются только ${IMPORT_FORMATS.join(", ")} — формат определён по содержимому` };
  if (kind === "pdf" && !p.tail.toString("latin1").includes("%%EOF")) return { ok: false, code: "CORRUPTED", message: `${name}: PDF повреждён (нет конца файла) — положите файл в хранилище повторно` };
  return { ok: true, kind };
}

/** Первые headMax и последние tailMax байт потока и его длина — без хранения всего потока. */
export class HeadTail {
  #head: Buffer = Buffer.alloc(0);
  #tail: Buffer = Buffer.alloc(0);
  #size = 0;
  readonly headMax: number;
  readonly tailMax: number;
  // не параметры-свойства: модуль грузит и node без сборки (загрузчик) — там только снятие типов
  constructor(headMax: number = IMPORT_HEAD_BYTES, tailMax: number = IMPORT_TAIL_BYTES) {
    this.headMax = headMax;
    this.tailMax = tailMax;
  }

  push(chunk: Buffer): void {
    this.#size += chunk.length;
    if (this.#head.length < this.headMax) this.#head = Buffer.concat([this.#head, chunk.subarray(0, this.headMax - this.#head.length)]);
    if (this.tailMax > 0) {
      const t = Buffer.concat([this.#tail, chunk]);
      this.#tail = t.subarray(Math.max(0, t.length - this.tailMax));
    }
  }

  get head(): Buffer {
    return this.#head;
  }
  get tail(): Buffer {
    return this.#tail;
  }
  get size(): number {
    return this.#size;
  }
}
