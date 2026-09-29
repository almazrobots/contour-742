// OS-INSP-1.2.36 (T-169): загрузчик кладёт файл больше 50 МБ в каталог хранилища API вне интерактивного запроса.
// Имя — SHA-256 открытого текста, формат — как у API и pnpm blobs:encrypt: IBE1 (domain/at-rest.ts) при ключе хранения,
// иначе открытый текст. Запись потоком во временный файл рядом и rename: под именем хеша не бывает недописанного файла.
// SHA-256 сверяется на лету — источник изменился после подсчёта хеша, файл не кладётся.
// Модуль запускается и голым node (загрузчик — только снятие типов): импортирует лишь node:* и чистые domain-модули.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { AT_REST_MAGIC, AT_REST_OVERHEAD, AT_REST_PREFIX_BYTES, atRestEncryptor, decryptAtRestStream, isEncryptedBlob, makeKeyring } from "../domain/at-rest.ts";
import { isSha256, TAG_BYTES } from "../domain/blob-crypto.ts";

/** Источник байт: вызывает onChunk по порядку и завершается (файл, запись ZIP). */
export type Feed = (onChunk: (b: Buffer) => void) => Promise<void>;

export interface StageResult {
  path: string;
  /** written — записан сейчас; present — уже лежал целым (повторный запуск загрузчика не пишет заново). */
  state: "written" | "present";
}

function writeAll(fd: number, b: Buffer): void {
  for (let off = 0; off < b.length; ) off += writeSync(fd, b, off, b.length - off);
}

async function readAt(path: string, pos: number, len: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Файл под именем хеша уже цел: обычный файл, открытый текст (или IBE1 под этим ключом) с этим SHA-256. */
export async function stagedIntact(path: string, sha: string, key: Buffer | null): Promise<boolean> {
  let size: number;
  try {
    const st = await lstat(path);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  const h = createHash("sha256");
  try {
    if (isEncryptedBlob(await readAt(path, 0, AT_REST_MAGIC.length))) {
      if (!key || size < AT_REST_OVERHEAD) return false;
      const prefix = await readAt(path, 0, AT_REST_PREFIX_BYTES);
      const tag = await readAt(path, size - TAG_BYTES, TAG_BYTES);
      const body: AsyncIterable<Buffer> = size - TAG_BYTES > AT_REST_PREFIX_BYTES ? createReadStream(path, { start: AT_REST_PREFIX_BYTES, end: size - TAG_BYTES - 1 }) : (async function* () {})();
      for await (const c of decryptAtRestStream(makeKeyring(key), prefix, tag, body)) h.update(c);
    } else {
      for await (const c of createReadStream(path)) h.update(c as Buffer);
    }
  } catch {
    return false; // не расшифровался, другой ключ, не читается — перезапишем проверенным
  }
  return h.digest("hex") === sha;
}

/** Кладёт файл в каталог хранилища под именем sha. Уже целый — не трогает. Хеш потока не сошёлся — отказ, файла нет. */
export async function stageBlob(dir: string, sha: string, feed: Feed, key: Buffer | null = null): Promise<StageResult> {
  if (!isSha256(sha)) throw new Error("ждём SHA-256 — 64 строчных шестнадцатеричных символа");
  const dest = join(dir, sha);
  if (await stagedIntact(dest, sha, key)) return { path: dest, state: "present" };
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${sha}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o644); // права — как у файлов, которые пишет сам API (atomicWrite)
  const h = createHash("sha256");
  try {
    try {
      const enc = key ? atRestEncryptor(key) : null;
      if (enc) writeAll(fd, enc.prefix);
      await feed((b) => {
        h.update(b);
        writeAll(fd, enc ? enc.update(b) : b);
      });
      if (enc) writeAll(fd, enc.final());
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const got = h.digest("hex");
    if (got !== sha) throw new Error(`содержимое изменилось после подсчёта SHA-256: ${got} вместо ${sha}`);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { path: dest, state: "written" };
}
