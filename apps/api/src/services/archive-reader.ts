// OS-INSP-1.2.20…1.2.23 Чтение пакета с диска: ZIP без загрузки целиком в память (центральный каталог + поток записи)
// и папка. Пределы и безопасность путей — domain/archive.ts; здесь — только байты.
// Поддержано: метод 0 (stored) и 8 (deflate), data descriptor (размеры и CRC берутся из центрального каталога),
// флаг бита 11 — имя в UTF-8, иначе CP866. ZIP64 не поддержан: архивы до 4 ГБ его не требуют, а распакованный объём
// больше 2 ГБ отклоняется всё равно (OS-INSP-1.2.23).
import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInflateRaw, crc32 } from "node:zlib";
import { ArchiveRejected, DEFAULT_LIMITS, checkLimits, decodeEntryName, safeEntryPath, type Limits } from "../domain/archive.ts";

export interface ZipEntry {
  /** Путь внутри архива после проверки безопасности, разделитель «/» */
  path: string;
  utf8: boolean;
  method: number;
  crc32: number;
  compressed: number;
  size: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const FFFF = 0xffff;
const FFFFFFFF = 0xffffffff;

const corrupted = (why: string) => new ArchiveRejected("CORRUPTED", `Архив повреждён: ${why}`);
const zip64 = () => new ArchiveRejected("ZIP64_UNSUPPORTED", "Архив в формате ZIP64 не поддерживается: пересоберите архив обычным ZIP (до 4 ГБ) или передайте папкой");

async function readAt(fh: import("node:fs/promises").FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead < len) throw corrupted("файл обрезан");
  return buf;
}

/** Записи архива (без каталогов) с проверкой путей и заявленных пределов — до чтения первого байта данных. */
export async function listEntries(zipPath: string, limits: Limits = DEFAULT_LIMITS): Promise<ZipEntry[]> {
  const fh = await open(zipPath, "r");
  try {
    const { size: fileSize } = await fh.stat();
    if (fileSize < 22) throw corrupted("нет конца центрального каталога");
    const tailLen = Math.min(fileSize, 22 + 0xffff);
    const tail = await readAt(fh, fileSize - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw corrupted("нет конца центрального каталога (архив обрезан или это не ZIP)");
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw zip64();
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === FFFF || cdSize === FFFFFFFF || cdOffset === FFFFFFFF) throw zip64();
    if (cdOffset + cdSize > fileSize) throw corrupted("центральный каталог за концом файла (архив обрезан)");
    const cd = await readAt(fh, cdOffset, cdSize);
    const raw: Array<ZipEntry & { isDir: boolean; name: string; flags: number }> = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw corrupted(`запись ${n + 1} центрального каталога не читается`);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressed = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen > cd.length) throw corrupted(`имя записи ${n + 1} за концом каталога`);
      const utf8 = (flags & 0x0800) !== 0;
      const name = decodeEntryName(cd.subarray(p + 46, p + 46 + nameLen), utf8);
      if (compressed === FFFFFFFF || size === FFFFFFFF || localOffset === FFFFFFFF) throw zip64();
      p += 46 + nameLen + extraLen + commentLen;
      const path = safeEntryPath(name); // OS-INSP-1.2.22: до любых проверок данных
      raw.push({ path, name, utf8, method, crc32: crc, compressed, size, localOffset, flags, isDir: name.endsWith("/") || name.endsWith("\\") });
    }
    const files = raw.filter((e) => !e.isDir);
    for (const e of files) {
      if (e.flags & 0x0001) throw new ArchiveRejected("ENCRYPTED", `Архив отклонён: запись «${e.path}» зашифрована`, { path: e.path });
      if (e.method !== 0 && e.method !== 8) throw new ArchiveRejected("UNSUPPORTED_METHOD", `Архив отклонён: запись «${e.path}» сжата методом ${e.method} (поддержаны 0 и 8)`, { path: e.path });
      if (e.localOffset + 30 + e.compressed > fileSize) throw corrupted(`данные записи «${e.path}» за концом файла (архив обрезан)`);
    }
    checkLimits(files.map((e) => ({ name: e.path, compressed: e.compressed, size: e.size })), limits); // OS-INSP-1.2.23
    return files.map(({ path, utf8, method, crc32: c, compressed, size, localOffset }) => ({ path, utf8, method, crc32: c, compressed, size, localOffset }));
  } finally {
    await fh.close();
  }
}

async function dataStart(zipPath: string, e: ZipEntry): Promise<number> {
  const fh = await open(zipPath, "r");
  try {
    const loc = await readAt(fh, e.localOffset, 30);
    if (loc.readUInt32LE(0) !== SIG_LOC) throw corrupted(`нет локального заголовка записи «${e.path}»`);
    return e.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

/**
 * Поток распакованных байт записи. Размер проверяется по факту: распаковалось больше заявленного — отказ сразу, не
 * дожидаясь конца (лживый размер в каталоге — приём архивной бомбы); меньше заявленного или не тот CRC-32 — отказ.
 */
export async function streamEntry(zipPath: string, e: ZipEntry, onChunk: (b: Buffer) => void, limits: Limits = DEFAULT_LIMITS): Promise<void> {
  const start = await dataStart(zipPath, e);
  const cap = Math.min(e.size, e.compressed * limits.maxRatio);
  let got = 0;
  let crc = 0;
  await new Promise<void>((resolve, reject) => {
    const src = e.compressed > 0 ? createReadStream(zipPath, { start, end: start + e.compressed - 1 }) : null;
    const inf = e.method === 8 && src ? createInflateRaw() : null;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      src?.destroy();
      inf?.destroy();
      reject(err);
    };
    const onData = (b: Buffer) => {
      if (settled) return;
      got += b.length;
      if (got > cap) {
        fail(new ArchiveRejected("SIZE_MISMATCH", `Архив отклонён: запись «${e.path}» распаковывается больше заявленных ${e.size} байт`, { path: e.path, limit: `${e.size} байт` }));
        return;
      }
      crc = crc32(b, crc);
      onChunk(b);
    };
    const done = () => {
      if (settled) return;
      if (got !== e.size) return fail(new ArchiveRejected("SIZE_MISMATCH", `Архив отклонён: запись «${e.path}» распаковалась в ${got} байт вместо ${e.size}`, { path: e.path }));
      if (crc >>> 0 !== e.crc32 >>> 0) return fail(new ArchiveRejected("CRC_MISMATCH", `Архив отклонён: контрольная сумма записи «${e.path}» не сходится`, { path: e.path }));
      settled = true;
      resolve();
    };
    if (!src) return done();
    src.on("error", (err) => fail(corrupted(`${e.path}: ${err.message}`)));
    if (!inf) {
      src.on("data", (b) => onData(b as Buffer));
      src.on("end", done);
    } else {
      inf.on("data", onData);
      inf.on("end", done);
      inf.on("error", (err) => fail(corrupted(`${e.path}: ${err.message}`)));
      src.pipe(inf);
    }
  });
}

/** Содержимое записи целиком — для передачи на приём (файл ≤ 50 МБ, OS-INSP-1.2.2). */
export async function readEntry(zipPath: string, e: ZipEntry, limits: Limits = DEFAULT_LIMITS): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await streamEntry(zipPath, e, (b) => chunks.push(b), limits);
  return Buffer.concat(chunks);
}

export interface DirFile {
  /** Путь относительно корня папки, разделитель «/» */
  path: string;
  abs: string;
  size: number;
}

/** Файлы папки рекурсивно, по алфавиту. Символические ссылки не проходятся: они могут вести за пределы папки. */
export async function walkDir(dir: string): Promise<DirFile[]> {
  const out: DirFile[] = [];
  async function walk(abs: string, rel: string) {
    const items = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const it of items) {
      const a = join(abs, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) await walk(a, r);
      else if (it.isFile()) out.push({ path: r, abs: a, size: (await lstat(a)).size });
    }
  }
  await walk(dir, "");
  return out;
}
