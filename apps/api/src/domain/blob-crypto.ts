// OS-INSP-1.2.28, 1.2.29 (ADR-0006): шифрование блобов на клиенте AES-256-GCM и ключ объекта по SHA-256.
// Чистые функции: без сети и диска. Формат объекта в бакете — nonce(12) ‖ шифротекст ‖ тег(16).
import { createCipheriv, createDecipheriv, createHash, randomBytes, type DecipherGCM } from "node:crypto";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

const SHA_RE = /^[0-9a-f]{64}$/;

export const sha256hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export function isSha256(sha: string): boolean {
  return SHA_RE.test(sha);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`ключ шифрования: ждём ${KEY_BYTES} байт (AES-256), получено ${key.length}`);
}

/** Шифрует открытый текст. nonce — только для тестов; по умолчанию случайный (повтор nonce под одним ключом ломает GCM). */
export function encryptBlob(key: Buffer, plain: Buffer, nonce: Buffer = randomBytes(NONCE_BYTES)): Buffer {
  assertKey(key);
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce: ждём ${NONCE_BYTES} байт, получено ${nonce.length}`);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

/**
 * Потоковое шифрование объекта S3 (T-169: файл больше памяти): nonce — первым куском, тег — последним. Байты те же, что
 * у encryptBlob с тем же nonce, — объект читается прежним decryptBlob.
 */
export async function* encryptBlobStream(key: Buffer, src: AsyncIterable<Buffer>, nonce: Buffer = randomBytes(NONCE_BYTES)): AsyncGenerator<Buffer> {
  assertKey(key);
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce: ждём ${NONCE_BYTES} байт, получено ${nonce.length}`);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  yield Buffer.from(nonce);
  for await (const chunk of src) {
    const out = c.update(chunk);
    if (out.length) yield out;
  }
  const last = c.final();
  if (last.length) yield last;
  yield c.getAuthTag();
}

/** Длина объекта S3 по длине открытого текста: nonce и тег сверху (нужна заранее — PUT потоком с Content-Length). */
export const encryptedBlobBytes = (plainBytes: number): number => plainBytes + NONCE_BYTES + TAG_BYTES;

/** Расшифровывает объект; порченый тег, nonce или шифротекст и обрезанная запись — ошибка, а не мусор. */
export function decryptBlob(key: Buffer, blob: Buffer): Buffer {
  assertKey(key);
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error(`зашифрованный объект короче ${NONCE_BYTES + TAG_BYTES} байт: запись обрезана`);
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new Error("тег GCM не сошёлся: объект повреждён или зашифрован другим ключом");
  }
}

/** Download without retaining the whole object. Consumers must stage output:
 * GCM authentication succeeds only after the final chunk and tag. */
export async function* decryptBlobStream(key: Buffer, src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  assertKey(key);
  let prefix = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher: DecipherGCM | undefined;
  for await (let chunk of src) {
    if (!decipher) {
      const take = Math.min(NONCE_BYTES - prefix.length, chunk.length);
      prefix = Buffer.concat([prefix, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
      if (prefix.length < NONCE_BYTES) continue;
      decipher = createDecipheriv("aes-256-gcm", key, prefix, { authTagLength: TAG_BYTES });
    }
    const joined = Buffer.concat([tail, chunk]);
    const bodyBytes = Math.max(0, joined.length - TAG_BYTES);
    if (bodyBytes) {
      const plain = decipher.update(joined.subarray(0, bodyBytes));
      if (plain.length) yield plain;
    }
    tail = Buffer.from(joined.subarray(bodyBytes));
  }
  if (!decipher || tail.length !== TAG_BYTES) throw new Error("зашифрованный объект короче 28 байт: запись обрезана");
  try {
    decipher.setAuthTag(tail);
    const last = decipher.final();
    if (last.length) yield last;
  } catch {
    throw new Error("тег GCM не сошёлся: объект повреждён или зашифрован другим ключом");
  }
}

/** Ключ объекта в бакете: <префикс>/<sha256>. Префикс нормализуется к «…/», пустой — корень бакета. */
export function blobObjectKey(prefix: string, sha: string): string {
  if (!isSha256(sha)) throw new Error("ключ объекта: ждём SHA-256 — 64 строчных шестнадцатеричных символа");
  const p = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return p ? `${p}/${sha}` : sha;
}

/** Ключ шифрования из текста файла: 64 hex или base64 ровно 32 байта. Содержимое в сообщение об ошибке не попадает. */
export function parseEncryptionKey(text: string): Buffer {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  // 43 знака base64 (+ необязательный «=») — ровно 32 байта; декодер Node понимает и base64url
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) return Buffer.from(t, "base64");
  throw new Error(`ключ шифрования: ждём ${KEY_BYTES} байт — 64 шестнадцатеричных символа или base64 (44 символа)`);
}

/**
 * ТЗ §10 Files.file_path (T-234, ADR-0006): путь файла в хранилище по содержимому — `blobs/<sha256>`, ключ объекта
 * S3 при префиксе по умолчанию (INSPECTOR_S3_PREFIX=blobs/) и имя в кэш-томе. Эталон генерируемой колонки
 * files.file_path миграции 0015: тест сверяет базу с этой функцией.
 */
export const FILE_PATH_PREFIX = "blobs/";
export function blobFilePath(sha: string): string {
  return blobObjectKey(FILE_PATH_PREFIX, sha);
}

/** sha256 из file_path (обратная операция): путь не по схеме `blobs/<sha256>` — null. */
export function shaFromFilePath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith(FILE_PATH_PREFIX)) return null;
  const sha = path.slice(FILE_PATH_PREFIX.length);
  return isSha256(sha) ? sha : null;
}
