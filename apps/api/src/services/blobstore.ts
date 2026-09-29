// OS-INSP-1.2.28–1.2.30, NFR-OBJSTORE (ADR-0004, ADR-0006): хранилище файлов пакета по SHA-256.
// fs — каталог на томе (dev, тесты); tiered — локальный кэш-каталог плюс зашифрованная копия в S3-совместимом бакете.
// ML читает файлы с кэш-каталога (localPath), ключей S3 не получает. Из S3 ничего не удаляется никогда.
// NFR-CRYPTO (ТЗ 12.3-01): с ключом хранения (INSPECTOR_BLOB_KEY_FILE) файлы каталога и кэша лежат на диске в формате
// IBE1 (domain/at-rest.ts), имя файла — SHA-256 открытого текста; ML получает открытый текст только из рабочего
// каталога в tmpfs (localPath → INSPECTOR_BLOB_WORK_DIR), на диск открытый текст не попадает.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { blobObjectKey, decryptBlob, decryptBlobStream, encryptBlob, encryptBlobStream, encryptedBlobBytes, isSha256, sha256hex, TAG_BYTES } from "../domain/blob-crypto.ts";
import { AT_REST_MAGIC, AT_REST_OVERHEAD, AT_REST_PREFIX_BYTES, AtRestError, decryptAtRest, decryptAtRestStream, encryptAtRest, encryptAtRestStream, isEncryptedBlob, type AtRestKeyring } from "../domain/at-rest.ts";
import { MAX_FILE_BYTES } from "../domain/upload.ts";
import { config, type BlobAtRestConfig, type BlobStoreConfig } from "../config.ts";

/** T-238: the guard must hold its lock until the callback finishes, including stream writes.
 * Production installs the durable source guard before accepting work. The default serializes
 * local/dev calls only; it is not a cross-process retention guarantee. */
export type BlobRetentionGuard = <T>(fn: (pins: ReadonlySet<string>) => Promise<T>) => Promise<T>;
let retentionGuard: BlobRetentionGuard | null = null;
let retentionTail: Promise<unknown> = Promise.resolve();
export function setBlobRetentionGuard(guard: BlobRetentionGuard | null): void { retentionGuard = guard; }
export function withBlobRetention<T>(fn: (pins: ReadonlySet<string>) => Promise<T>): Promise<T> {
  if (retentionGuard) return retentionGuard(fn);
  const next = retentionTail.then(() => fn(new Set()));
  retentionTail = next.catch(() => undefined);
  return next;
}
/** Rollback cleanup may race another run adopting the same content: keep active sources. */
export async function removeUnpinnedLocalBlobs(dir: string, hashes: readonly string[]): Promise<void> {
  for (const sha of hashes) assertSha(sha);
  await withBlobRetention(async (pins) => {
    for (const sha of hashes) if (!pins.has(sha)) rmSync(join(dir, sha), { force: true });
  });
}
export class BlobWorkCapacityError extends Error {
  readonly status = 503;
  constructor() { super("рабочий каталог ML заполнен: активные источники закреплены или файл превышает вместимость"); this.name = "BlobWorkCapacityError"; }
}
export class BlobPinnedError extends Error {
  readonly status = 409;
  constructor() { super("активный источник закреплён: удаление или карантин запрещены"); this.name = "BlobPinnedError"; }
}

export interface BlobStore {
  readonly kind: "fs" | "s3";
  /** Сохраняет файл; уже сохранённый не перезаписывается. S3 недоступно — BlobStoreUnavailable, кэш не создаётся. */
  put(sha: string, buf: Buffer): Promise<void>;
  /** Содержимое файла; SHA-256 проверяется. Нет — BlobNotFound, не сошлось — BlobIntegrityError. */
  get(sha: string): Promise<Buffer>;
  exists(sha: string): Promise<boolean>;
  /** Сверка для ежедневной проверки целостности (ТЗ 12.7): объект есть и доступная копия цела. */
  verify(sha: string): Promise<boolean>;
  /** Гарантирует файл в кэш-каталоге (при промахе поднимает из S3) и возвращает путь — его читает ML. */
  localPath(sha: string): Promise<string>;
  /**
   * OS-INSP-1.2.36 (T-169): файл, положенный в каталог хранилища вне интерактивного запроса (загрузчик), — открытым
   * текстом потоком. null — файла нет или это не обычный файл. Целиком в память не читается.
   */
  staged(sha: string): Promise<PlainStream | null>;
  /**
   * OS-INSP-1.2.36: проверенный файл каталога становится файлом хранилища — у tiered зашифрованная копия уходит в S3
   * потоком (объект уже есть — не перезаписывается). SHA-256 сверяется на лету: разошёлся — PUT обрывается до тега.
   */
  adopt(sha: string): Promise<void>;
  /**
   * T-169: непроверенный файл каталога с чужим содержимым (отказ импорта) уходит в карантин «.<sha>.rejected-<время>»:
   * след остаётся для разбора, а имя хеша свободно для честной загрузки (put не перезаписывает существующий файл).
   * Возвращает новое имя; файла нет — null.
   */
  quarantine(sha: string): Promise<string | null>;
}

/**
 * T-169 (OWASP HIGH-001): путь к проверенному открытому тексту для отдачи большого файла диапазонами потоком — без
 * буфера целиком на каждый запрос. Проверка SHA-256 — один раз на копию (intactCached), а не на каждый Range.
 */
export async function servePath(store: BlobStore, sha: string): Promise<string> {
  const p = await store.localPath(sha);
  if (!(await intactCached(p, sha, () => localIntact(p, sha)))) throw new BlobIntegrityError(sha, "SHA-256 файла на диске не совпал");
  return p;
}

function quarantineIn(dir: string, sha: string, rename: RenameFn): string | null {
  if (!isSha256(sha)) throw new Error("ждём SHA-256 — 64 строчных шестнадцатеричных символа");
  const from = join(dir, sha);
  if (!existsSync(from)) return null;
  const name = `.${sha}.rejected-${Date.now()}-${randomBytes(2).toString("hex")}`;
  rename(from, join(dir, name));
  return name;
}

/** Открытый текст файла потоком (T-169). Кускам доверять только после конца потока: сбой тега или хеша — исключение. */
export interface PlainStream {
  /** Длина открытого текста, байт. */
  size: number;
  /** Ключ хранения задан, а файл на диске — открытым текстом (наследие или положен без ключа; OWASP M-002). */
  plainWhileKeyed: boolean;
  /** Предел файла для рабочего каталога ML (tmpfs), байт; null — рабочий каталог не нужен (OWASP M-004). */
  workLimit: number | null;
  chunks(): AsyncIterable<Buffer>;
}

/** Файлы крупнее предела интерактивной загрузки ML получает через потоковый путь (OS-INSP-1.2.40). */
export const STREAM_THRESHOLD_BYTES = MAX_FILE_BYTES;

async function readRange(path: string, pos: number, len: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function* fileChunks(path: string, start: number, end: number): AsyncGenerator<Buffer> {
  if (end < start) return; // пустой диапазон: createReadStream с end < start бросает
  for await (const c of createReadStream(path, { start, end })) yield c as Buffer;
}

/** Хеш на лету: разошёлся с ожидаемым — исключение последним шагом, до того как потребитель закончит (T-169). */
export async function* hashTap(sha: string, src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const h = createHash("sha256");
  for await (const c of src) {
    h.update(c);
    yield c;
  }
  if (h.digest("hex") !== sha) throw new BlobIntegrityError(sha, "SHA-256 потока не совпал с ожидаемым");
}

/** Хранилище недоступно (сеть, 5xx, ключи): приём отклоняется кодом 503, запись о файле не создаётся (OS-INSP-1.2.30). */
export class BlobStoreUnavailable extends Error {
  readonly status = 503;
  constructor(op: string, reason: string) {
    super(`объектное хранилище недоступно (${op}): ${reason}`);
    this.name = "BlobStoreUnavailable";
  }
}

export class BlobNotFound extends Error {
  readonly status = 404;
  constructor(sha: string) {
    super(`файл ${sha} не найден в хранилище`);
    this.name = "BlobNotFound";
  }
}

/** Объект не прошёл проверку тега GCM или SHA-256 открытого текста (OS-INSP-1.2.29): содержимое не принимается. */
export class BlobIntegrityError extends Error {
  readonly status = 500;
  constructor(sha: string, why: string) {
    super(`файл ${sha} не прошёл проверку целостности: ${why}`);
    this.name = "BlobIntegrityError";
  }
}

function assertSha(sha: string): void {
  if (!isSha256(sha)) throw new Error("ждём SHA-256 — 64 строчных шестнадцатеричных символа");
}

function assertContent(sha: string, buf: Buffer): void {
  assertSha(sha);
  if (sha256hex(buf) !== sha) throw new Error(`содержимое не совпадает с SHA-256 ${sha}`);
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/** Локальная копия цела: файл есть и его SHA-256 совпал. Нет файла или он нечитаем — не цел. */
async function localIntact(path: string, sha: string): Promise<boolean> {
  try {
    return (await hashFile(path)) === sha;
  } catch {
    return false;
  }
}

/**
 * T-169 (OWASP HIGH-001): проверенная копия на диске запоминается по пути, размеру и mtime — большой файл не
 * перехешируется на каждый запрос диапазона. Изменился размер или mtime — проверка заново.
 */
const verified = new Map<string, string>();
const stamp = (path: string, sha: string) => {
  const st = statSync(path);
  return `${sha}:${st.size}:${st.mtimeMs}`;
};
export async function intactCached(path: string, sha: string, check: () => Promise<boolean>): Promise<boolean> {
  let key: string;
  try {
    key = stamp(path, sha);
  } catch {
    return false;
  }
  if (verified.get(path) === key) return true;
  const ok = await check();
  if (ok) verified.set(path, key);
  else verified.delete(path);
  return ok;
}

export type RenameFn = (from: string, to: string) => void;

/** Атомарная запись: временный файл рядом и rename. Сбой до rename — под именем sha ничего нет, временный убран. */
export function atomicWrite(dir: string, name: string, buf: Buffer, rename: RenameFn = renameSync): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, buf);
    rename(tmp, join(dir, name));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// ─────────────────────────────── NFR-CRYPTO: слой «в покое» для каталога fs и кэша tiered

let legacyReads = 0;

/** Метрика наследия: сколько раз прочитан файл открытым текстом при включённом шифровании (ждёт pnpm blobs:encrypt). */
export function atRestStats(): { legacyReads: number } {
  return { legacyReads };
}

export interface AtRestOptions {
  /** null — шифрования нет (dev без ключа): файлы открытым текстом, как до NFR-CRYPTO. */
  keyring: AtRestKeyring | null;
  /** Рабочий каталог ML (tmpfs): открытый текст для разбора. Обязателен при ключе. */
  workDir?: string | null;
  /** Вместимость рабочего каталога, байт; сверх — вытесняются самые старые (по умолчанию 1 ГиБ). */
  workMaxBytes?: number;
}

/** Запись и чтение файла хранилища на диске: шифрование IBE1, сверка SHA-256 открытого текста, выдача ML. */
export class LocalAtRest {
  readonly #keyring: AtRestKeyring | null; // приватное поле: ключи не попадают ни в JSON, ни в перечисление
  readonly workDir: string | null;
  readonly workMaxBytes: number;
  constructor(o: AtRestOptions = { keyring: null }, private readonly rename: RenameFn = renameSync) {
    this.#keyring = o.keyring;
    this.workDir = o.workDir ?? null;
    this.workMaxBytes = o.workMaxBytes ?? 1024 * 1024 * 1024;
  }

  get encrypted(): boolean {
    return this.#keyring !== null;
  }

  /** Что лечь на диск: IBE1 под текущим ключом или (без ключа) открытый текст. */
  encode(plain: Buffer): Buffer {
    return this.#keyring ? encryptAtRest(this.#keyring.current, plain) : plain;
  }

  encodeStream(plain: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
    return this.#keyring ? encryptAtRestStream(this.#keyring.current, plain) : plain;
  }

  /** Открытый текст из байтов файла; не расшифровался или SHA-256 не сошёлся — BlobIntegrityError. */
  open(sha: string, raw: Buffer): Buffer {
    const kr = this.#keyring;
    if (!kr) {
      if (sha256hex(raw) === sha) return raw;
      throw new BlobIntegrityError(sha, isEncryptedBlob(raw) ? "файл зашифрован (IBE1), а ключ хранения не задан — INSPECTOR_BLOB_KEY_FILE" : "SHA-256 файла на диске не совпал");
    }
    let plain: Buffer;
    try {
      const o = decryptAtRest(kr, raw);
      if (o.legacy) legacyReads++;
      plain = o.plain;
    } catch (e) {
      // открытый текст наследия, случайно начавшийся с «IBE1», узнаётся по совпадению SHA-256
      if (sha256hex(raw) !== sha) throw new BlobIntegrityError(sha, (e as Error).message);
      legacyReads++;
      plain = raw;
    }
    if (sha256hex(plain) !== sha) throw new BlobIntegrityError(sha, "SHA-256 открытого текста не совпал с именем файла");
    return plain;
  }

  /** Файл на диске цел: читается и сходится. Нет файла — false; ошибка чтения (права, IO) — исключение. */
  intact(path: string, sha: string): boolean {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    try {
      this.open(sha, raw);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * T-169: как intact, но потоком — для файлов больше памяти (readFileSync падает на файле больше 2 ГиБ). Нет файла или
   * порча (тег, хеш) — false; ошибка чтения (права, IO) — исключение, как у intact.
   */
  async intactStream(path: string, sha: string): Promise<boolean> {
    const s = await this.plainStream(path, sha).catch((e: unknown) => {
      if (e instanceof BlobIntegrityError) return null;
      throw e;
    });
    if (!s) return false;
    const h = createHash("sha256");
    try {
      for await (const c of s.chunks()) h.update(c);
    } catch (e) {
      if (e instanceof BlobIntegrityError) return false;
      throw e;
    }
    return h.digest("hex") === sha;
  }

  /** intact для любого размера: крупнее порога — потоком. */
  async intactAny(path: string, sha: string): Promise<boolean> {
    let size: number;
    try {
      size = statSync(path).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    return size > STREAM_THRESHOLD_BYTES ? this.intactStream(path, sha) : this.intact(path, sha);
  }

  /** Открытый текст для ML в рабочем каталоге (tmpfs): уже цел — только освежить mtime; иначе атомарная запись. */
  async materialize(sha: string, plain: Buffer): Promise<string> {
    return withBlobRetention(async (pins) => {
      if (!this.workDir) throw new Error("ключ хранения задан, а рабочий каталог ML нет: INSPECTOR_BLOB_WORK_DIR (tmpfs) — иначе ML получил бы шифротекст");
      const p = join(this.workDir, sha);
      if (existsSync(p) && sha256hex(readFileSync(p)) === sha) {
        const now = new Date();
        utimesSync(p, now, now);
      } else {
        this.reserve(sha, plain.length, pins);
        atomicWrite(this.workDir, sha, plain, this.rename);
      }
      this.reserve(sha, 0, pins);
      return p;
    });
  }

  /**
   * T-169: открытый текст файла на диске потоком. null — файла нет или это не обычный файл (символическая ссылка в каталог
   * хранилища не принимается). IBE1 расшифровывается потоком; тег сверяется в конце — BlobIntegrityError последним шагом.
   */
  async plainStream(path: string, sha: string): Promise<PlainStream | null> {
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (!st.isFile()) return null;
    const size = st.size;
    const workLimit = this.#keyring ? this.workMaxBytes : null;
    if (!isEncryptedBlob(await readRange(path, 0, AT_REST_MAGIC.length))) return { size, plainWhileKeyed: this.#keyring !== null, workLimit, chunks: () => fileChunks(path, 0, size - 1) };
    const kr = this.#keyring;
    if (!kr) throw new BlobIntegrityError(sha, "файл зашифрован (IBE1), а ключ хранения не задан — INSPECTOR_BLOB_KEY_FILE");
    if (size < AT_REST_OVERHEAD) throw new BlobIntegrityError(sha, `запись IBE1 короче ${AT_REST_OVERHEAD} байт: обрезана`);
    const prefix = await readRange(path, 0, AT_REST_PREFIX_BYTES);
    const tag = await readRange(path, size - TAG_BYTES, TAG_BYTES);
    return {
      size: size - AT_REST_OVERHEAD,
      plainWhileKeyed: false,
      workLimit,
      async *chunks() {
        try {
          yield* decryptAtRestStream(kr, prefix, tag, fileChunks(path, AT_REST_PREFIX_BYTES, size - TAG_BYTES - 1));
        } catch (e) {
          throw e instanceof AtRestError ? new BlobIntegrityError(sha, e.message) : e;
        }
      },
    };
  }

  /** T-169: открытый текст для ML в рабочий каталог потоком — большой файл не держится в памяти; SHA-256 до rename. */
  async materializeStream(sha: string, src: PlainStream): Promise<string> {
    return withBlobRetention(async (pins) => {
      if (!this.workDir) throw new Error("ключ хранения задан, а рабочий каталог ML нет: INSPECTOR_BLOB_WORK_DIR (tmpfs) — иначе ML получил бы шифротекст");
      const p = join(this.workDir, sha);
      if (await intactCached(p, sha, () => localIntact(p, sha))) {
        const now = new Date();
        utimesSync(p, now, now);
        verified.set(p, stamp(p, sha)); // свежий mtime — та же проверенная копия
      } else {
        this.reserve(sha, src.size, pins);
        mkdirSync(this.workDir, { recursive: true });
        const tmp = join(this.workDir, `.${sha}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
        const fh = await open(tmp, "wx", 0o644); // как atomicWrite: ML в compose — другой пользователь (OWASP M-004)
        try {
          try {
            let written = 0;
            for await (const c of hashTap(sha, src.chunks())) {
              written += c.length;
              if (written > src.size) throw new BlobIntegrityError(sha, "поток длиннее заявленного размера");
              await fh.writeFile(c);
            }
            if (written !== src.size) throw new BlobIntegrityError(sha, "размер потока не совпал");
          } finally {
            await fh.close();
          }
          this.rename(tmp, p);
        } catch (e) {
          rmSync(tmp, { force: true });
          throw e;
        }
      }
      this.reserve(sha, 0, pins);
      return p;
    });
  }

  /** Reserve before writing, so ENOSPC does not sacrifice an active source.
   * Non-SHA files (including crash leftovers) consume capacity but are never guessed safe to delete. */
  private reserve(keep: string, incoming: number, pins: ReadonlySet<string>): void {
    if (!Number.isSafeInteger(incoming) || incoming < 0) throw new BlobWorkCapacityError();
    const dir = this.workDir!;
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir).map((name) => {
      const s = statSync(join(dir, name));
      return { name, size: s.size, mtimeMs: s.mtimeMs };
    });
    let total = incoming + files.reduce((n, f) => n + f.size, 0);
    const candidates = files.filter((f) => isSha256(f.name) && f.name !== keep && !pins.has(f.name))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    if (total - candidates.reduce((n, f) => n + f.size, 0) > this.workMaxBytes) throw new BlobWorkCapacityError();
    for (const f of candidates) {
      if (total <= this.workMaxBytes) break;
      rmSync(join(dir, f.name), { force: true });
      total -= f.size;
    }
  }
}

// ─────────────────────────────── fs: файл по имени sha в каталоге, запись только если нет

export class FsBlobStore implements BlobStore {
  readonly kind = "fs" as const;
  private readonly local: LocalAtRest;
  constructor(readonly dir: string, private readonly rename: RenameFn = renameSync, local?: LocalAtRest) {
    this.local = local ?? new LocalAtRest({ keyring: null }, rename);
  }

  private path(sha: string): string {
    assertSha(sha);
    return join(this.dir, sha);
  }

  async put(sha: string, buf: Buffer): Promise<void> {
    assertContent(sha, buf);
    if (!existsSync(this.path(sha))) atomicWrite(this.dir, sha, this.local.encode(buf), this.rename);
  }
  async get(sha: string): Promise<Buffer> {
    const p = this.path(sha);
    if (!existsSync(p)) throw new BlobNotFound(sha);
    return this.local.open(sha, readFileSync(p));
  }

  async exists(sha: string): Promise<boolean> {
    return existsSync(this.path(sha));
  }

  async verify(sha: string): Promise<boolean> {
    if (!this.local.encrypted) return localIntact(this.path(sha), sha);
    try {
      return await this.local.intactAny(this.path(sha), sha);
    } catch {
      return false;
    }
  }

  /** Для проверки целостности (ТЗ 12.7): как verify, но ошибка чтения — исключение («не читается», а не «повреждён»). */
  async intact(sha: string): Promise<boolean> {
    return this.local.intactAny(this.path(sha), sha);
  }

  async localPath(sha: string): Promise<string> {
    const p = this.path(sha);
    if (!existsSync(p)) throw new BlobNotFound(sha);
    if (!this.local.encrypted) return p;
    // OS-INSP-1.2.40: большой файл — в рабочий каталог потоком, а не буфером целиком
    if (statSync(p).size > STREAM_THRESHOLD_BYTES) {
      const s = await this.staged(sha);
      if (s) return this.local.materializeStream(sha, s);
    }
    return this.local.materialize(sha, await this.get(sha));
  }

  async staged(sha: string): Promise<PlainStream | null> {
    return this.local.plainStream(this.path(sha), sha);
  }

  async quarantine(sha: string): Promise<string | null> {
    return withBlobRetention(async (pins) => {
      if (pins.has(sha)) throw new BlobPinnedError();
      return quarantineIn(this.dir, sha, this.rename);
    });
  }

  /** Каталог и есть хранилище: проверенный файл уже на месте. */
  async adopt(sha: string): Promise<void> {
    if (!(await this.staged(sha))) throw new BlobNotFound(sha);
  }
}

// ─────────────────────────────── S3: узкая обёртка над API (в тестах — фейк в памяти)

export interface S3Like {
  /** null — объекта нет; иначе пользовательские метаданные объекта. */
  head(bucket: string, key: string): Promise<Record<string, string> | null>;
  put(bucket: string, key: string, body: Buffer, metadata: Record<string, string>): Promise<void>;
  /** null — объекта нет. */
  get(bucket: string, key: string): Promise<Buffer | null>;
  /** Optional for legacy adapters; production downloads large objects in bounded chunks. */
  getStream?(bucket: string, key: string): Promise<AsyncIterable<Buffer> | null>;
  /** T-169: запись потоком с известной длиной (файл больше памяти). Нет — запись собирается в буфер и идёт через put. */
  putStream?(bucket: string, key: string, body: AsyncIterable<Buffer>, length: number, metadata: Record<string, string>): Promise<void>;
}

/** Причина сбоя без секретов: имя ошибки SDK и HTTP-код, не текст запроса и не заголовки. */
export function s3Reason(e: unknown): string {
  const err = e as { name?: string; code?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = err?.$metadata?.httpStatusCode;
  // Системный код сети (ECONNREFUSED, ETIMEDOUT…) — только если это короткий идентификатор, не произвольный текст
  const code = typeof err?.code === "string" && /^[A-Z_]{3,32}$/.test(err.code) ? ` (${err.code})` : "";
  const name = (err?.name || "Error") + code;
  if (status === 403 || name === "AccessDenied" || name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch") return `${name}: доступ запрещён — проверьте ключи и права на бакет`;
  return status ? `${name}, HTTP ${status}` : name;
}

// «Нет объекта» — HTTP 404 (у HEAD это NotFound без тела, у GET — NoSuchKey); остальное — недоступность
const isNotFound = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

export interface S3ClientOptions {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Тайм-аут одного запроса к S3: файл до 50 МБ на медленном канале уходит минутами (стенд T-129: 60 с не хватило). */
  requestTimeoutMs?: number;
  /** HTTP CONNECT-прокси к S3 (стенд на маке: scripts/egress-direct.py выводит трафик мимо VPN, T-129). TLS — сквозной. */
  proxy?: string | null;
}

/**
 * Агент HTTPS через CONNECT-туннель: сокет до прокси, в нём — обычный TLS до хранилища с проверкой сертификата по
 * имени хоста. Прокси видит только зашифрованный поток (а тело — ещё и шифротекст AES-GCM, ADR-0006).
 */
export function connectProxyAgent(proxy: string, connectTimeoutMs = 10_000): https.Agent {
  const p = new URL(proxy);
  // в тексте ошибок — только хост и порт: учётные данные из адреса прокси в журнал не попадают (SEC-13)
  if (p.protocol !== "http:") throw new Error(`INSPECTOR_S3_PROXY=${p.host}: ждём http://хост:порт (CONNECT-прокси)`);
  const agent = new https.Agent({ keepAlive: true });
  (agent as unknown as { createConnection: unknown }).createConnection = (opts: tls.ConnectionOptions & { host: string; port: number }, cb: (e: Error | null, s?: tls.TLSSocket) => void) => {
    const target = `${opts.host}:${opts.port ?? 443}`;
    const req = http.request({ host: p.hostname, port: Number(p.port || 80), method: "CONNECT", path: target, headers: { host: target } });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error(`прокси S3 отказал: ${res.statusCode}`));
      }
      cb(null, tls.connect({ ...opts, socket, servername: opts.servername ?? opts.host }));
    });
    req.once("error", (e) => cb(e));
    // прокси молчит — отказ через 10 с, а не зависание загрузки до тайм-аута SDK (SEC-13)
    req.setTimeout(connectTimeoutMs, () => req.destroy(new Error(`прокси S3 ${p.host} не ответил на CONNECT за ${connectTimeoutMs / 1000} с`)));
    req.end();
    return undefined;
  };
  return agent;
}

/** Адаптер к любому S3-совместимому API (ADR-0004 п. 1): провайдер задаётся только адресом и регионом. */
export function sdkS3(o: S3ClientOptions): S3Like {
  const client = new S3Client({
    endpoint: o.endpoint,
    region: o.region,
    forcePathStyle: o.forcePathStyle,
    credentials: o.credentials,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: o.requestTimeoutMs ?? 900_000, ...(o.proxy ? { httpsAgent: connectProxyAgent(o.proxy) } : {}) },
    // Контрольные суммы CRC32 по умолчанию (SDK ≥ 3.729) понимают не все S3-совместимые хранилища — только когда обязательны
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return {
    async head(bucket, key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return r.Metadata ?? {};
      } catch (e) {
        if (isNotFound(e)) return null;
        throw new BlobStoreUnavailable("HEAD", s3Reason(e));
      }
    },
    async put(bucket, key, body, metadata) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, Metadata: metadata, ContentType: "application/octet-stream" }));
      } catch (e) {
        throw new BlobStoreUnavailable("PUT", s3Reason(e));
      }
    },
    async putStream(bucket, key, body, length, metadata) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Readable.from(body), ContentLength: length, Metadata: metadata, ContentType: "application/octet-stream" }));
      } catch (e) {
        if (e instanceof BlobIntegrityError) throw e; // поток сам оборвал запись: содержимое разошлось с хешем
        throw new BlobStoreUnavailable("PUT", s3Reason(e));
      }
    },
    async get(bucket, key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!r.Body) throw new Error("пустое тело ответа");
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) {
        if (isNotFound(e)) return null;
        throw new BlobStoreUnavailable("GET", s3Reason(e));
      }
    },
    async getStream(bucket, key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!r.Body) throw new Error("пустое тело ответа");
        const body = r.Body as AsyncIterable<Uint8Array>;
        return (async function* () {
          try {
            for await (const chunk of body) yield Buffer.from(chunk);
          } catch (e) {
            throw new BlobStoreUnavailable("GET", s3Reason(e));
          }
        })();
      } catch (e) {
        if (isNotFound(e)) return null;
        throw new BlobStoreUnavailable("GET", s3Reason(e));
      }
    },
  };
}

// ─────────────────────────────── tiered: кэш-каталог + зашифрованная копия в S3

export interface TieredOptions {
  bucket: string;
  prefix: string;
  /** Ключ AES-256-GCM, 32 байта (INSPECTOR_S3_KEY_FILE). */
  key: Buffer;
  /** Дополнительные префиксы только для чтения (T-131: демо-стенд читает проверки разных стендов мака). */
  readPrefixes?: string[];
  rename?: RenameFn;
  /** NFR-CRYPTO: шифрование локального кэша и рабочий каталог ML; не задан — кэш открытым текстом. */
  atRest?: LocalAtRest;
}

export class TieredBlobStore implements BlobStore {
  readonly kind = "s3" as const;
  private readonly rename: RenameFn;
  private readonly local: LocalAtRest;
  private readonly downloads = new Map<string, Promise<void>>();
  constructor(readonly dir: string, private readonly s3: S3Like, private readonly opts: TieredOptions) {
    this.rename = opts.rename ?? renameSync;
    this.local = opts.atRest ?? new LocalAtRest({ keyring: null }, this.rename);
  }

  private objectKey(sha: string): string {
    return blobObjectKey(this.opts.prefix, sha);
  }

  /** Ключи чтения: основной префикс, затем дополнительные — по порядку (запись — только в основной). */
  private readKeys(sha: string): string[] {
    return [this.opts.prefix, ...(this.opts.readPrefixes ?? [])].map((p) => blobObjectKey(p, sha));
  }

  private async headAny(sha: string): Promise<{ sha256?: string } | null> {
    for (const key of this.readKeys(sha)) {
      const h = await this.call("HEAD", () => this.s3.head(this.opts.bucket, key));
      if (h) return h;
    }
    return null;
  }

  private cachePath(sha: string): string {
    assertSha(sha);
    return join(this.dir, sha);
  }

  /** Любой сбой обёртки S3 — 503: фейк или SDK могли бросить что угодно, наружу уходит только понятная причина. */
  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BlobStoreUnavailable || e instanceof BlobIntegrityError) throw e;
      throw new BlobStoreUnavailable(op, s3Reason(e));
    }
  }

  async put(sha: string, buf: Buffer): Promise<void> {
    assertContent(sha, buf);
    const key = this.objectKey(sha);
    // OS-INSP-1.2.28: объект под ключом из SHA-256 не перезаписывается
    const head = await this.call("HEAD", () => this.s3.head(this.opts.bucket, key));
    if (!head) await this.call("PUT", () => this.s3.put(this.opts.bucket, key, encryptBlob(this.opts.key, buf), { sha256: sha }));
    // Кэш — только после того, как копия в бакете есть: «в кэше есть, в S3 нет» не бывает. Кэш пишется всегда
    // (атомарно): заодно заменяет испорченную локальную копию проверенным содержимым.
    atomicWrite(this.dir, sha, this.local.encode(buf), this.rename);
  }

  /** Поднимает объект из S3: тег GCM, затем SHA-256 открытого текста (OS-INSP-1.2.29); в кэш — только проверенное. */
  private async fetch(sha: string): Promise<Buffer> {
    let blob: Buffer | null = null;
    for (const key of this.readKeys(sha)) {
      blob = await this.call("GET", () => this.s3.get(this.opts.bucket, key));
      if (blob) break;
    }
    if (!blob) throw new BlobNotFound(sha);
    let plain: Buffer;
    try {
      plain = decryptBlob(this.opts.key, blob);
    } catch (e) {
      throw new BlobIntegrityError(sha, (e as Error).message);
    }
    if (sha256hex(plain) !== sha) throw new BlobIntegrityError(sha, "SHA-256 открытого текста не совпал с ключом объекта");
    atomicWrite(this.dir, sha, this.local.encode(plain), this.rename);
    return plain;
  }

  /** Stage encrypted/plain cache bytes; publish only after GCM and SHA succeed.
   * Concurrent PDF range requests share one download. No full-file Buffer. */
  private async fetchToCache(sha: string): Promise<void> {
    const pending = this.downloads.get(sha);
    if (pending) return pending;
    const download = (async () => {
      if (!this.s3.getStream) { await this.fetch(sha); return; }
      let raw: AsyncIterable<Buffer> | null = null;
      for (const key of this.readKeys(sha)) {
        raw = await this.call("GET", () => this.s3.getStream!(this.opts.bucket, key));
        if (raw) break;
      }
      if (!raw) throw new BlobNotFound(sha);
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `.${sha}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
      const fh = await open(tmp, "wx", 0o644);
      try {
        const key = this.opts.key;
        const authenticated = (async function* () {
          try { yield* decryptBlobStream(key, raw!); }
          catch (e) {
            if (e instanceof BlobStoreUnavailable) throw e;
            throw new BlobIntegrityError(sha, (e as Error).message);
          }
        })();
        try {
          for await (const chunk of this.local.encodeStream(hashTap(sha, authenticated))) await fh.writeFile(chunk);
        } finally { await fh.close(); }
        this.rename(tmp, this.cachePath(sha));
      } catch (e) {
        await fh.close().catch(() => undefined);
        rmSync(tmp, { force: true });
        throw e;
      }
    })();
    this.downloads.set(sha, download);
    try { await download; }
    finally { this.downloads.delete(sha); }
  }

  async get(sha: string): Promise<Buffer> {
    const p = this.cachePath(sha);
    if (existsSync(p)) {
      // кэш испорчен, под неизвестным ключом или не читается — это промах, а не отказ: источник истины — бакет
      try {
        return this.local.open(sha, readFileSync(p));
      } catch {
        /* промах */
      }
    }
    return this.fetch(sha);
  }

  async exists(sha: string): Promise<boolean> {
    // Источник истины — бакет; кэш-каталог может быть очищен
    return (await this.headAny(sha)) !== null;
  }

  async verify(sha: string): Promise<boolean> {
    const head = await this.headAny(sha);
    if (!head) return false;
    if (head.sha256 !== undefined && head.sha256 !== sha) return false;
    const p = this.cachePath(sha);
    if (!existsSync(p)) return true;
    if (!this.local.encrypted) return localIntact(p, sha);
    try {
      return await this.local.intactAny(p, sha);
    } catch {
      return false;
    }
  }

  async localPath(sha: string): Promise<string> {
    const p = this.cachePath(sha);
    if (this.local.encrypted) {
      if (!(await this.local.intactAny(p, sha))) await this.fetchToCache(sha);
      const s = await this.staged(sha);
      if (!s) throw new BlobNotFound(sha);
      return this.local.materializeStream(sha, s);
    }
    if (!(await intactCached(p, sha, () => localIntact(p, sha)))) await this.fetchToCache(sha);
    return p;
  }

  async staged(sha: string): Promise<PlainStream | null> {
    return this.local.plainStream(this.cachePath(sha), sha);
  }

  async quarantine(sha: string): Promise<string | null> {
    return withBlobRetention(async (pins) => {
      if (pins.has(sha)) throw new BlobPinnedError();
      return quarantineIn(this.dir, sha, this.rename);
    });
  }

  async adopt(sha: string): Promise<void> {
    const key = this.objectKey(sha);
    // OS-INSP-1.2.28: объект под ключом из SHA-256 не перезаписывается
    if (await this.call("HEAD", () => this.s3.head(this.opts.bucket, key))) return;
    const src = await this.staged(sha);
    if (!src) throw new BlobNotFound(sha);
    const body = encryptBlobStream(this.opts.key, hashTap(sha, src.chunks()));
    const meta = { sha256: sha };
    await this.call("PUT", async () => {
      if (this.s3.putStream) return this.s3.putStream(this.opts.bucket, key, body, encryptedBlobBytes(src.size), meta);
      const parts: Buffer[] = [];
      for await (const c of body) parts.push(c);
      return this.s3.put(this.opts.bucket, key, Buffer.concat(parts), meta);
    });
  }
}

// ─────────────────────────────── фабрика и синглтон

export function blobStoreFromConfig(c: BlobStoreConfig = config.blobStore, dir: string = config.blobDir, atRest: BlobAtRestConfig | AtRestOptions = config.blobAtRest): BlobStore {
  const local = new LocalAtRest(atRest);
  if (c.kind === "fs") return new FsBlobStore(dir, renameSync, local);
  const s3 = sdkS3({ endpoint: c.endpoint, region: c.region, forcePathStyle: c.forcePathStyle, credentials: c.credentials, requestTimeoutMs: c.requestTimeoutMs, proxy: c.proxy });
  return new TieredBlobStore(dir, s3, { bucket: c.bucket, prefix: c.prefix, key: c.key, readPrefixes: c.readPrefixes, atRest: local });
}

let current: BlobStore | null = null;

export function blobStore(): BlobStore {
  return (current ??= blobStoreFromConfig());
}

/** Подмена хранилища в тестах; null — вернуть хранилище по конфигурации. */
export function setBlobStoreForTests(store: BlobStore | null): void {
  current = store;
}
