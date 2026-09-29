// Сборщик ZIP для тестов загрузчика (T-129): локальные заголовки + центральный каталог вручную, без зависимостей.
import { crc32, deflateRawSync } from "node:zlib";

// Кодирование имени в CP866 — обратная таблица для записи без флага UTF-8
const CP866: Record<string, number> = {};
"АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп".split("").forEach((c, i) => (CP866[c] = 0x80 + i));
"рстуфхцчшщъыьэюя".split("").forEach((c, i) => (CP866[c] = 0xe0 + i));
CP866["Ё"] = 0xf0;
CP866["ё"] = 0xf1;
export const cp866 = (s: string) => Buffer.from([...s].map((c) => (c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : CP866[c])));

export interface ZipItem {
  name: string;
  data: Buffer;
  utf8?: boolean;
  deflate?: boolean;
  descriptor?: boolean;
  /** подмены для порчи: CRC и размеры в центральном каталоге */
  crc?: number;
  size?: number;
  flags?: number;
  method?: number;
}

/** ZIP вручную. Локальный заголовок при data descriptor — с нулями, правда — в дескрипторе и в каталоге. */
export function buildZip(items: ZipItem[], opts: { zip64Locator?: boolean; cdCount?: number; cdOffset?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let off = 0;
  for (const it of items) {
    const name = it.utf8 ? Buffer.from(it.name, "utf8") : cp866(it.name);
    const body = it.deflate ? deflateRawSync(it.data) : it.data;
    const crc = it.crc ?? crc32(it.data);
    const size = it.size ?? it.data.length;
    const flags = (it.flags ?? 0) | (it.utf8 ? 0x0800 : 0) | (it.descriptor ? 0x0008 : 0);
    const method = it.method ?? (it.deflate ? 8 : 0);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(it.descriptor ? 0 : crc, 14);
    loc.writeUInt32LE(it.descriptor ? 0 : body.length, 18);
    loc.writeUInt32LE(it.descriptor ? 0 : size, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    const parts = [loc, name, body];
    if (it.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(size, 12);
      parts.push(dd);
    }
    const local = Buffer.concat(parts);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(off, 42);
    cens.push(Buffer.concat([cen, name]));
    locals.push(local);
    off += local.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.cdCount ?? items.length, 8);
  eocd.writeUInt16LE(opts.cdCount ?? items.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(opts.cdOffset ?? off, 16);
  const pre: Buffer[] = [];
  if (opts.zip64Locator) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    pre.push(loc);
  }
  return Buffer.concat([...locals, cd, ...pre, eocd]);
}

