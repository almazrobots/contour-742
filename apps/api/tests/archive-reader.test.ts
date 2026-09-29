// L1 · L6 — OS-INSP-1.2.20…1.2.23: чтение ZIP с диска. Архивы собираются в тесте вручную (локальные заголовки +
// центральный каталог): имена в CP866 без флага и в UTF-8 с флагом, stored и deflate, запись с data descriptor.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArchiveRejected } from "../src/domain/archive.ts";
import { listEntries, readEntry, walkDir } from "../src/services/archive-reader.ts";
import { buildZip, cp866, type ZipItem } from "./zip-builder.ts";

const TMP = mkdtempSync(join(tmpdir(), "inspector-zip-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function save(buf: Buffer): string {
  const p = join(TMP, `a${n++}.zip`);
  writeFileSync(p, buf);
  return p;
}

async function rejection(p: Promise<unknown>): Promise<ArchiveRejected> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveRejected);
    return e as ArchiveRejected;
  }
  throw new Error("ожидался отказ архива");
}

const pdf = (tag: string, pad = 0) => Buffer.from(`%PDF-1.4\n${tag}\n${"0".repeat(pad)}\n%%EOF\n`);

describe("чтение ZIP (L1)", () => {
  const items: ZipItem[] = [
    { name: "Пакет/", data: Buffer.alloc(0) },
    { name: "Пакет/Проектная документация/1. П-2099-01.001-ПЗ.pdf", data: pdf("pz", 500), deflate: true },
    { name: "Пакет/Рабочая документация/РД-2099-01-001-АР1.pdf", data: pdf("ar", 50), utf8: true },
    { name: "Пакет/Рабочая документация/Р-2099-01.001-ВК1.pdf", data: pdf("vk", 300), deflate: true, descriptor: true },
    { name: "Пакет/Ёлка.pdf", data: pdf("yo") },
    { name: "Пакет/пустой.txt", data: Buffer.alloc(0) },
  ];
  const path = save(buildZip(items));

  it("список: каталоги пропущены, имена CP866 без флага и UTF-8 с флагом, размеры из центрального каталога", async () => {
    const es = await listEntries(path);
    expect(es.map((e) => e.path)).toEqual(items.slice(1).map((i) => i.name));
    expect(es.map((e) => e.utf8)).toEqual([false, true, false, false, false]);
    expect(es.map((e) => e.method)).toEqual([8, 0, 8, 0, 0]);
    expect(es.map((e) => e.size)).toEqual(items.slice(1).map((i) => i.data.length));
    expect(es[0].compressed).toBeLessThan(es[0].size);
    expect(es[2].compressed).toBeGreaterThan(0); // data descriptor: в локальном заголовке нули, в каталоге — правда
    expect(es[0].localOffset).toBe(30 + cp866("Пакет/").length);
  });
  it("содержимое: stored, deflate, data descriptor и пустая запись — байт в байт", async () => {
    const es = await listEntries(path);
    for (const [i, e] of es.entries()) expect((await readEntry(path, e)).equals(items[i + 1].data)).toBe(true);
  });
  it("папка: рекурсивно, по алфавиту, без символических ссылок", async () => {
    const dir = join(TMP, "dir");
    mkdirSync(join(dir, "Рабочая документация", "Том"), { recursive: true });
    writeFileSync(join(dir, "б.pdf"), "12345");
    writeFileSync(join(dir, "а.pdf"), "1");
    writeFileSync(join(dir, "Рабочая документация", "Том", "x.pdf"), "xy");
    symlinkSync("/etc/hosts", join(dir, "ссылка.pdf"));
    expect(await walkDir(dir)).toEqual([
      { path: "Рабочая документация/Том/x.pdf", abs: join(dir, "Рабочая документация", "Том", "x.pdf"), size: 2 },
      { path: "а.pdf", abs: join(dir, "а.pdf"), size: 1 },
      { path: "б.pdf", abs: join(dir, "б.pdf"), size: 5 },
    ]);
  });
});

describe("порченые и опасные архивы (L6)", () => {
  it("порченый CRC → отказ CRC_MISMATCH с путём", async () => {
    const p = save(buildZip([{ name: "a.pdf", data: pdf("a"), deflate: true, crc: 12345 }]));
    const [e] = await listEntries(p);
    const r = await rejection(readEntry(p, e));
    expect(r.code).toBe("CRC_MISMATCH");
    expect(r.path).toBe("a.pdf");
  });
  it("лживый размер: распаковывается больше заявленного → отказ сразу, SIZE_MISMATCH", async () => {
    const big = Buffer.alloc(200_000, 0x41);
    const p = save(buildZip([{ name: "bomb.pdf", data: big, deflate: true, size: 1000 }]));
    const [e] = await listEntries(p);
    expect(e.size).toBe(1000);
    const r = await rejection(readEntry(p, e));
    expect(r.code).toBe("SIZE_MISMATCH");
    expect(r.message).toContain("больше заявленных 1000");
  });
  it("лживый размер у stored-записи → отказ", async () => {
    const p = save(buildZip([{ name: "s.pdf", data: pdf("s", 100), size: 10 }]));
    const [e] = await listEntries(p);
    expect((await rejection(readEntry(p, e))).code).toBe("SIZE_MISMATCH");
  });
  it("распаковалось меньше заявленного → отказ", async () => {
    const d = pdf("short");
    const p = save(buildZip([{ name: "short.pdf", data: d, deflate: true, size: d.length + 5 }]));
    const [e] = await listEntries(p);
    const r = await rejection(readEntry(p, e));
    expect(r.code).toBe("SIZE_MISMATCH");
    expect(r.message).toContain(`${d.length} байт вместо ${d.length + 5}`);
  });
  it("заявленное сжатие > 100:1 → BOMB до чтения данных", async () => {
    const p = save(buildZip([{ name: "z.pdf", data: Buffer.alloc(1_000_000), deflate: true }]));
    const r = await rejection(listEntries(p));
    expect(r.code).toBe("BOMB");
    expect(r.limit).toBe("100:1");
  });
  it("обрезанный архив (нет конца каталога) → CORRUPTED", async () => {
    const full = buildZip([{ name: "a.pdf", data: pdf("a", 100) }]);
    expect((await rejection(listEntries(save(full.subarray(0, full.length - 10))))).code).toBe("CORRUPTED");
    expect((await rejection(listEntries(save(Buffer.alloc(10))))).code).toBe("CORRUPTED");
  });
  it("данные записи за концом файла или каталог за концом → CORRUPTED", async () => {
    const bad = buildZip([{ name: "a.pdf", data: pdf("a", 100) }], { cdOffset: 1_000_000 });
    expect((await rejection(listEntries(save(bad)))).message).toContain("обрезан");
    const cdMore = buildZip([{ name: "a.pdf", data: pdf("a") }], { cdCount: 2 });
    expect((await rejection(listEntries(save(cdMore)))).code).toBe("CORRUPTED");
  });
  it("обрезанные данные сжатой записи → отказ при чтении", async () => {
    const d = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251));
    const zip = buildZip([{ name: "a.pdf", data: d, deflate: true }]);
    const p = save(zip);
    const [e] = await listEntries(p);
    // порча середины сжатого потока
    const broken = Buffer.from(zip);
    for (let i = e.localOffset + 30 + 5 + 10; i < e.localOffset + 30 + 5 + 60; i++) broken[i] = 0xff;
    const p2 = save(broken);
    const r = await rejection(readEntry(p2, e));
    expect(["CORRUPTED", "CRC_MISMATCH", "SIZE_MISMATCH"]).toContain(r.code);
  });
  it("путь с выходом за каталог → TRAVERSAL весь архив", async () => {
    const p = save(buildZip([{ name: "ok.pdf", data: pdf("a") }, { name: "../evil.pdf", data: pdf("b") }]));
    const r = await rejection(listEntries(p));
    expect(r.code).toBe("TRAVERSAL");
    expect(r.path).toBe("../evil.pdf");
  });
  it("ZIP64 (локатор или 0xFFFFFFFF в каталоге) → ZIP64_UNSUPPORTED", async () => {
    expect((await rejection(listEntries(save(buildZip([{ name: "a.pdf", data: pdf("a") }], { zip64Locator: true }))))).code).toBe("ZIP64_UNSUPPORTED");
    expect((await rejection(listEntries(save(buildZip([{ name: "a.pdf", data: pdf("a"), size: 0xffffffff }]))))).code).toBe("ZIP64_UNSUPPORTED");
    expect((await rejection(listEntries(save(buildZip([{ name: "a.pdf", data: pdf("a") }], { cdCount: 0xffff }))))).code).toBe("ZIP64_UNSUPPORTED");
  });
  it("зашифрованная запись и неизвестный метод сжатия → отказ", async () => {
    expect((await rejection(listEntries(save(buildZip([{ name: "a.pdf", data: pdf("a"), flags: 1 }]))))).code).toBe("ENCRYPTED");
    expect((await rejection(listEntries(save(buildZip([{ name: "a.pdf", data: pdf("a"), method: 12 }]))))).code).toBe("UNSUPPORTED_METHOD");
  });
  it("нет локального заголовка по смещению → CORRUPTED", async () => {
    const zip = buildZip([{ name: "a.pdf", data: pdf("a") }]);
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(0, 0);
    const p = save(broken);
    const [e] = await listEntries(p);
    expect((await rejection(readEntry(p, e))).code).toBe("CORRUPTED");
  });
});
