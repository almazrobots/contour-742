// L1 · L4 · L6 — OS-INSP-1.2.36 (T-169): загрузчик кладёт файл в каталог хранилища API вне интерактивного запроса.
// Формат — тот, что читает API (FsBlobStore / LocalAtRest): открытый текст или IBE1 под ключом хранения.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptAtRest, isEncryptedBlob, makeKeyring } from "../src/domain/at-rest.ts";
import { FsBlobStore, LocalAtRest } from "../src/services/blobstore.ts";
import { stageBlob, stagedIntact, type Feed } from "../src/services/stage-blob.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KEY = Buffer.alloc(32, 5);
const plain = Buffer.from(`%PDF-1.7\n${"том ИД ".repeat(500)}\n%%EOF\n`);
const h = sha(plain);
const feedOf = (b: Buffer, size = 97): Feed => async (on) => {
  for (let i = 0; i < b.length; i += size) on(b.subarray(i, i + size));
};

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "t169-stage-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("L1 · раскладка файла в каталог хранилища", () => {
  it("открытый текст под именем SHA-256; API читает его как свой файл; повтор — present без записи", async () => {
    expect(await stageBlob(dir, h, feedOf(plain))).toEqual({ path: join(dir, h), state: "written" });
    expect(readFileSync(join(dir, h)).equals(plain)).toBe(true);
    expect((await new FsBlobStore(dir).get(h)).equals(plain)).toBe(true);
    let called = 0;
    expect((await stageBlob(dir, h, async (on) => (called++, on(plain)))).state).toBe("present");
    expect(called).toBe(0);
  });
  it("с ключом хранения — IBE1, который открывает API под тем же ключом", async () => {
    await stageBlob(dir, h, feedOf(plain), KEY);
    const raw = readFileSync(join(dir, h));
    expect(isEncryptedBlob(raw)).toBe(true);
    const st = new FsBlobStore(dir, undefined, new LocalAtRest({ keyring: makeKeyring(KEY), workDir: join(dir, "work") }));
    expect((await st.get(h)).equals(plain)).toBe(true);
    expect(await stagedIntact(join(dir, h), h, KEY)).toBe(true);
  });
  it("кладёт в ещё не созданный каталог", async () => {
    const d = join(dir, "a", "b");
    await stageBlob(d, h, feedOf(plain));
    expect(readdirSync(d)).toEqual([h]);
  });
});

describe("L4 · L6 · отказы и перезапись", () => {
  it("источник изменился после подсчёта хеша — отказ, под именем хеша ничего, временных нет", async () => {
    await expect(stageBlob(dir, h, feedOf(Buffer.from("другое")))).rejects.toThrow(/содержимое изменилось после подсчёта SHA-256/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("сбой чтения источника — отказ, временный файл убран", async () => {
    await expect(stageBlob(dir, h, async (on) => { on(plain.subarray(0, 10)); throw new Error("диск"); })).rejects.toThrow("диск");
    expect(readdirSync(dir)).toEqual([]);
  });
  it("под именем хеша испорченный файл — перезаписывается проверенным", async () => {
    writeFileSync(join(dir, h), Buffer.from("мусор"));
    expect(await stagedIntact(join(dir, h), h, null)).toBe(false);
    expect((await stageBlob(dir, h, feedOf(plain))).state).toBe("written");
    expect(readFileSync(join(dir, h)).equals(plain)).toBe(true);
  });
  it("IBE1 под другим ключом или без ключа — не цел; символическая ссылка — не цел и заменяется файлом", async () => {
    writeFileSync(join(dir, h), encryptAtRest(Buffer.alloc(32, 6), plain));
    expect(await stagedIntact(join(dir, h), h, KEY)).toBe(false);
    expect(await stagedIntact(join(dir, h), h, null)).toBe(false);
    rmSync(join(dir, h));
    const outside = join(dir, "..", `outside-${h.slice(0, 8)}`);
    writeFileSync(outside, plain);
    symlinkSync(outside, join(dir, h));
    expect(await stagedIntact(join(dir, h), h, null)).toBe(false);
    await stageBlob(dir, h, feedOf(plain));
    expect((await import("node:fs")).lstatSync(join(dir, h)).isSymbolicLink()).toBe(false);
    rmSync(outside);
  });
  it("пустой файл: IBE1 без шифротекста цел под своим ключом; повтор — present с путём; нет файла — не цел", async () => {
    const e = sha(Buffer.alloc(0));
    expect(await stagedIntact(join(dir, e), e, KEY)).toBe(false);
    await stageBlob(dir, e, async () => {}, KEY);
    expect(readFileSync(join(dir, e)).length).toBe(40);
    expect(await stagedIntact(join(dir, e), e, KEY)).toBe(true);
    expect(await stageBlob(dir, e, async () => {}, KEY)).toEqual({ path: join(dir, e), state: "present" });
  });
  it("обрезанный IBE1 — не цел", async () => {
    writeFileSync(join(dir, h), encryptAtRest(KEY, plain).subarray(0, 30));
    expect(await stagedIntact(join(dir, h), h, KEY)).toBe(false);
  });
  it("имя — только SHA-256: путь отклоняется до диска", async () => {
    await expect(stageBlob(dir, "../x", feedOf(plain))).rejects.toThrow(/ждём SHA-256/);
  });
});
