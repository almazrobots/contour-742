// NFR-CRYPTO (ТЗ 12.3-01): файлы пакета на диске («в покое») — AES-256-GCM с идентификатором ключа.
// Чистые функции: без диска и сети. Формат локального блоба:
//   IBE1 (4 байта магии) ‖ key_id (8 = первые 8 байт SHA-256 ключа) ‖ nonce (12) ‖ шифротекст ‖ тег (16).
// Заголовок (магия и key_id) — дополнительные данные GCM (AAD): подмена key_id ломает тег, а не выбирает другой ключ.
// Формат объекта в S3 (ADR-0006, blob-crypto.ts: nonce ‖ шифротекст ‖ тег) — другой и не меняется.
// Связка ключей: текущим пишется, старые (после ротации) — только читаются, ключ выбирается по key_id.
// Файл без магии — наследие (записан до включения шифрования): читается с признаком legacy, перешифровывает
// pnpm blobs:encrypt (cli/blobs-encrypt.ts).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { KEY_BYTES, NONCE_BYTES, parseEncryptionKey, TAG_BYTES } from "./blob-crypto.ts";

export const AT_REST_MAGIC = Buffer.from("IBE1", "latin1");
export const KEY_ID_BYTES = 8;
const HEADER_BYTES = AT_REST_MAGIC.length + KEY_ID_BYTES; // AAD
const PREFIX_BYTES = HEADER_BYTES + NONCE_BYTES;
/** Начало записи IBE1 до шифротекста: магия, key_id и nonce — 24 байта (T-169: чтение потоком). */
export const AT_REST_PREFIX_BYTES = PREFIX_BYTES;
/** Прибавка к размеру открытого текста: заголовок, nonce и тег — 40 байт. */
export const AT_REST_OVERHEAD = PREFIX_BYTES + TAG_BYTES;

export type AtRestErrorCode = "TRUNCATED" | "UNKNOWN_KEY" | "TAG";

/** Запись не расшифровывается: обрезана, ключа нет в связке или тег не сошёлся. Содержимого в тексте нет. */
export class AtRestError extends Error {
  readonly code: AtRestErrorCode;
  constructor(code: AtRestErrorCode, message: string) {
    super(message);
    this.name = "AtRestError";
    this.code = code; // не параметр-свойство: модуль грузит и node без сборки (config.ts, cli) — там только снятие типов
  }
}

export interface AtRestKeyring {
  /** Ключ записи. */
  readonly current: Buffer;
  /** Все ключи чтения (текущий и старые) по key_id в hex. */
  readonly byId: ReadonlyMap<string, Buffer>;
}

export interface OpenedBlob {
  plain: Buffer;
  /** true — файл записан открытым текстом до включения шифрования (наследие). */
  legacy: boolean;
  /** key_id (hex) ключа, которым запись расшифрована; null — наследие. */
  keyId: string | null;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`ключ хранения: ждём ${KEY_BYTES} байт (AES-256), получено ${key.length}`);
}

/** Идентификатор ключа: первые 8 байт SHA-256 ключа. Сам ключ по нему не восстановить. */
export function keyId(key: Buffer): Buffer {
  assertKey(key);
  return createHash("sha256").update(key).digest().subarray(0, KEY_ID_BYTES);
}

/** Связка: current — ключ записи; old — ключи до ротации, только для чтения. Повторы не мешают. */
export function makeKeyring(current: Buffer, old: Buffer[] = []): AtRestKeyring {
  const byId = new Map<string, Buffer>();
  for (const k of [current, ...old]) byId.set(keyId(k).toString("hex"), k);
  return { current, byId };
}

/** Список старых ключей из файла: по ключу в строке (64 hex или base64), пустые строки и «#…» пропускаются. */
export function parseKeyList(text: string): Buffer[] {
  const out: Buffer[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    try {
      out.push(parseEncryptionKey(t));
    } catch (e) {
      throw new Error(`строка ${i + 1}: ${(e as Error).message}`);
    }
  });
  return out;
}

/** Файл в формате IBE1 (по магии). Короче магии — не он. */
export function isEncryptedBlob(buf: Buffer): boolean {
  return buf.length >= AT_REST_MAGIC.length && buf.subarray(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC);
}

/** Шифрует ключом записи. nonce — только для тестов; по умолчанию случайный (повтор nonce под одним ключом ломает GCM). */
export function encryptAtRest(key: Buffer, plain: Buffer, nonce: Buffer = randomBytes(NONCE_BYTES)): Buffer {
  const header = Buffer.concat([AT_REST_MAGIC, keyId(key)]);
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce: ждём ${NONCE_BYTES} байт, получено ${nonce.length}`);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(header);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([header, nonce, body, c.getAuthTag()]);
}

/** Открывает запись: IBE1 — расшифровка ключом по key_id; без магии — наследие как есть (legacy: true). */
export function decryptAtRest(keyring: AtRestKeyring, buf: Buffer): OpenedBlob {
  if (!isEncryptedBlob(buf)) return { plain: buf, legacy: true, keyId: null };
  if (buf.length < AT_REST_OVERHEAD) throw new AtRestError("TRUNCATED", `запись короче ${AT_REST_OVERHEAD} байт: обрезана`);
  const id = buf.subarray(AT_REST_MAGIC.length, HEADER_BYTES).toString("hex");
  const key = keyring.byId.get(id);
  if (!key) throw new AtRestError("UNKNOWN_KEY", `ключ хранения ${id} не найден в связке: после ротации старый ключ задаётся в INSPECTOR_BLOB_OLD_KEYS_FILE`);
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(HEADER_BYTES, PREFIX_BYTES), { authTagLength: TAG_BYTES });
  d.setAAD(buf.subarray(0, HEADER_BYTES));
  d.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  try {
    return { plain: Buffer.concat([d.update(buf.subarray(PREFIX_BYTES, buf.length - TAG_BYTES)), d.final()]), legacy: false, keyId: id };
  } catch {
    throw new AtRestError("TAG", `тег GCM не сошёлся (ключ ${id}): запись повреждена или подменена`);
  }
}

/** Пошаговое шифрование IBE1 (T-169): начало записи, затем update по кускам, в конце final — остаток и тег. Синхронно. */
export interface AtRestEncryptor {
  readonly prefix: Buffer;
  update(chunk: Buffer): Buffer;
  final(): Buffer;
}

export function atRestEncryptor(key: Buffer, nonce: Buffer = randomBytes(NONCE_BYTES)): AtRestEncryptor {
  const header = Buffer.concat([AT_REST_MAGIC, keyId(key)]);
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce: ждём ${NONCE_BYTES} байт, получено ${nonce.length}`);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(header);
  return {
    prefix: Buffer.concat([header, nonce]),
    update: (chunk) => c.update(chunk),
    final: () => Buffer.concat([c.final(), c.getAuthTag()]),
  };
}

/** Потоковое шифрование IBE1 (T-169): начало записи — первым куском, тег — последним; байты как у encryptAtRest. */
export async function* encryptAtRestStream(key: Buffer, src: AsyncIterable<Buffer>, nonce: Buffer = randomBytes(NONCE_BYTES)): AsyncGenerator<Buffer> {
  const enc = atRestEncryptor(key, nonce);
  yield enc.prefix;
  for await (const chunk of src) {
    const out = enc.update(chunk);
    if (out.length) yield out;
  }
  yield enc.final();
}

/**
 * Потоковое чтение IBE1 (T-169): начало записи (AT_REST_PREFIX_BYTES) и тег читаются заранее, шифротекст — кусками.
 * Куски открытого текста отдаются до проверки тега: потребитель доверяет им только после конца потока — несошедшийся
 * тег бросает AtRestError("TAG") последним шагом. Ключа нет в связке — AtRestError("UNKNOWN_KEY") до первого куска.
 */
export async function* decryptAtRestStream(keyring: AtRestKeyring, prefix: Buffer, tag: Buffer, body: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  if (prefix.length !== PREFIX_BYTES || !isEncryptedBlob(prefix) || tag.length !== TAG_BYTES) throw new AtRestError("TRUNCATED", `запись короче ${AT_REST_OVERHEAD} байт: обрезана`);
  const id = prefix.subarray(AT_REST_MAGIC.length, HEADER_BYTES).toString("hex");
  const key = keyring.byId.get(id);
  if (!key) throw new AtRestError("UNKNOWN_KEY", `ключ хранения ${id} не найден в связке: после ротации старый ключ задаётся в INSPECTOR_BLOB_OLD_KEYS_FILE`);
  const d = createDecipheriv("aes-256-gcm", key, prefix.subarray(HEADER_BYTES), { authTagLength: TAG_BYTES });
  d.setAAD(prefix.subarray(0, HEADER_BYTES));
  d.setAuthTag(tag);
  for await (const chunk of body) {
    const out = d.update(chunk);
    if (out.length) yield out;
  }
  let last: Buffer;
  try {
    last = d.final();
  } catch {
    throw new AtRestError("TAG", `тег GCM не сошёлся (ключ ${id}): запись повреждена или подменена`);
  }
  if (last.length) yield last;
}

export interface WorkFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Вытеснение из рабочего каталога ML (открытый текст в tmpfs): самые старые по mtime — первыми, пока сумма больше
 * вместимости. Только что записанный файл (keep) не удаляется никогда, даже если сам больше вместимости.
 */
export function pickEvictions(files: WorkFile[], capBytes: number, keep: string): string[] {
  let total = files.reduce((s, f) => s + f.size, 0);
  const out: string[] = [];
  for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= capBytes) break;
    if (f.name === keep) continue;
    out.push(f.name);
    total -= f.size;
  }
  return out;
}

/** Каталог лежит на tmpfs (по тексту /proc/self/mounts): решает ближайшая точка монтирования над путём. */
export function isTmpfsAt(mountsText: string, path: string): boolean {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  let best: { mp: string; type: string } | null = null;
  for (const line of mountsText.split("\n")) {
    const [, rawMp, type] = line.trim().split(/\s+/);
    if (!rawMp || !type) continue;
    const mp = unescape(rawMp);
    const under = mp === "/" || path === mp || path.startsWith(mp.endsWith("/") ? mp : `${mp}/`);
    if (under && (!best || mp.length >= best.mp.length)) best = { mp, type };
  }
  return best?.type === "tmpfs";
}
