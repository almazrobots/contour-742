// OS-INSP-1.2.36, 1.2.40 (T-169): файл, положенный в каталог хранилища вне интерактивного запроса, — чтение потоком
// (открытый текст и IBE1), принятие в хранилище (у tiered — копия в S3 потоком) и выдача ML без буфера целиком.
// Эшелоны qa-standard: L1 staged/adopt/localPath · L4 S3 недоступен, обрыв PUT на чужом содержимом ·
// L6 символическая ссылка вместо файла, подменённый файл под именем чужого хеша, IBE1 без ключа.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptAtRest, makeKeyring } from "../src/domain/at-rest.ts";
import { decryptBlob, encryptBlob, encryptedBlobBytes } from "../src/domain/blob-crypto.ts";
import { BlobIntegrityError, BlobNotFound, BlobStoreUnavailable, FsBlobStore, LocalAtRest, STREAM_THRESHOLD_BYTES, TieredBlobStore, type PlainStream, type S3Like } from "../src/services/blobstore.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const K1 = Buffer.alloc(32, 1);
const S3KEY = Buffer.alloc(32, 3);
const plain = Buffer.from("%PDF-1.7\nсинтетический том ИД\n%%EOF\n");
const h = sha(plain);

class FakeS3 implements S3Like {
  objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  calls = { head: 0, put: 0, putStream: 0 };
  lengths: number[] = [];
  down: Error | null = null;
  async head(b: string, k: string) {
    this.calls.head++;
    if (this.down) throw this.down;
    return this.objects.get(`${b}/${k}`)?.meta ?? null;
  }
  async put(b: string, k: string, body: Buffer, meta: Record<string, string>) {
    this.calls.put++;
    this.objects.set(`${b}/${k}`, { body: Buffer.from(body), meta });
  }
  async get(b: string, k: string) {
    return this.objects.get(`${b}/${k}`)?.body ?? null;
  }
}
/** S3 с потоковой записью: как SDK — тело читается до конца, обрыв потока обрывает запись (объект не появляется). */
class StreamS3 extends FakeS3 {
  async putStream(b: string, k: string, body: AsyncIterable<Buffer>, length: number, meta: Record<string, string>) {
    this.calls.putStream++;
    this.lengths.push(length);
    const parts: Buffer[] = [];
    for await (const c of body) parts.push(c);
    this.objects.set(`${b}/${k}`, { body: Buffer.concat(parts), meta });
  }
}

const collect = async (s: PlainStream) => {
  const out: Buffer[] = [];
  for await (const c of s.chunks()) out.push(c);
  return Buffer.concat(out);
};

let root: string;
let dir: string;
let work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t169-staged-"));
  dir = join(root, "blobs");
  work = join(root, "work");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cold S3 localPath without a full-file buffer", () => {
  class DownloadS3 extends FakeS3 {
    downloads = 0;
    error: Error | null = null;
    override async get(): Promise<Buffer | null> { throw new Error("buffered GET must not run"); }
    async getStream(b: string, k: string) {
      const object = this.objects.get(`${b}/${k}`);
      if (!object) return null;
      this.downloads++;
      const error = this.error;
      return (async function* () {
        for (let n = 0; n < object.body.length; n += 11) yield object.body.subarray(n, n + 11);
        if (error) throw error;
      })();
    }
  }
  function prepare(body = plain, key = S3KEY) {
    const s3 = new DownloadS3();
    s3.objects.set(`b/corpus/${h}`, { body: encryptBlob(key, body), meta: {} });
    return s3;
  }
  const store = (s3: DownloadS3, atRest?: LocalAtRest) =>
    new TieredBlobStore(dir, s3, { bucket: "b", prefix: "missing/", readPrefixes: ["corpus/"], key: S3KEY, atRest });
  it("reads the existing corpus prefix; simultaneous range cache misses share one download", async () => {
    const s3 = prepare(); const st = store(s3);
    const paths = await Promise.all([st.localPath(h), st.localPath(h), st.localPath(h)]);
    expect(paths.every(p => p === paths[0])).toBe(true);
    expect(readFileSync(paths[0])).toEqual(plain);
    expect(s3.downloads).toBe(1);
    await st.localPath(h); expect(s3.downloads).toBe(1);
  });
  it("streams into encrypted local cache and materializes verified plaintext", async () => {
    const s3 = prepare(); const st = store(s3, new LocalAtRest({ keyring: makeKeyring(K1), workDir: work }));
    const path = await st.localPath(h);
    expect(readFileSync(path)).toEqual(plain);
    expect(readFileSync(join(dir, h)).subarray(0, 4).toString()).toBe("IBE1");
    expect(s3.downloads).toBe(1);
  });
  it("wrong GCM key leaves no cache or temp bytes and a corrected retry succeeds", async () => {
    const s3 = prepare(plain, K1); const st = store(s3);
    await expect(st.localPath(h)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(readdirSync(dir)).toEqual([]);
    s3.objects.get(`b/corpus/${h}`)!.body = encryptBlob(S3KEY, plain);
    expect(readFileSync(await st.localPath(h))).toEqual(plain);
  });
  it("valid GCM with wrong SHA never publishes the cache", async () => {
    const st = store(prepare(Buffer.from("other content")));
    await expect(st.localPath(h)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("network failure is a 503 and cleans staged bytes", async () => {
    const s3 = prepare(); s3.error = new BlobStoreUnavailable("GET", "upstream closed");
    await expect(store(s3).localPath(h)).rejects.toBeInstanceOf(BlobStoreUnavailable);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("L1 · staged: файл каталога потоком", () => {
  it("открытый текст: размер и содержимое; файла нет — null", async () => {
    const st = new FsBlobStore(dir);
    expect(await st.staged(h)).toBeNull();
    await st.put(h, plain);
    const s = (await st.staged(h))!;
    expect(s.size).toBe(plain.length);
    expect((await collect(s)).equals(plain)).toBe(true);
  });
  it("IBE1 под ключом хранения: размер открытого текста и расшифровка потоком", async () => {
    const st = new FsBlobStore(dir, undefined, new LocalAtRest({ keyring: makeKeyring(K1), workDir: work }));
    await st.put(h, plain);
    const s = (await st.staged(h))!;
    expect(s.size).toBe(plain.length);
    expect((await collect(s)).equals(plain)).toBe(true);
  });
  it("пустой файл — поток без кусков", async () => {
    const st = new FsBlobStore(dir);
    const e = sha(Buffer.alloc(0));
    await st.put(e, Buffer.alloc(0));
    expect((await collect((await st.staged(e))!)).length).toBe(0);
  });
});

describe("L6 · staged: что не принимается", () => {
  it("символическая ссылка под именем хеша — как если бы файла не было", async () => {
    const st = new FsBlobStore(dir);
    await st.put(sha(Buffer.from("x")), Buffer.from("x"));
    const outside = join(root, "secret.pdf");
    writeFileSync(outside, plain);
    symlinkSync(outside, join(dir, h));
    expect(await st.staged(h)).toBeNull();
    await expect(st.adopt(h)).rejects.toBeInstanceOf(BlobNotFound);
  });
  it("IBE1 без ключа хранения — BlobIntegrityError с подсказкой, а не шифротекст", async () => {
    const st = new FsBlobStore(dir);
    await st.put(sha(Buffer.from("x")), Buffer.from("x"));
    writeFileSync(join(dir, h), encryptAtRest(K1, plain));
    await expect(st.staged(h)).rejects.toThrow(/INSPECTOR_BLOB_KEY_FILE/);
  });
  it("IBE1 испорчен — BlobIntegrityError в конце потока; обрезан — сразу", async () => {
    const st = new FsBlobStore(dir, undefined, new LocalAtRest({ keyring: makeKeyring(K1), workDir: work }));
    await st.put(sha(Buffer.from("x")), Buffer.from("x"));
    const rec = encryptAtRest(K1, plain);
    rec[30] ^= 1;
    writeFileSync(join(dir, h), rec);
    await expect(collect((await st.staged(h))!)).rejects.toBeInstanceOf(BlobIntegrityError);
    writeFileSync(join(dir, h), rec.subarray(0, 20));
    await expect(st.staged(h)).rejects.toBeInstanceOf(BlobIntegrityError);
  });
  it("путь вместо хеша — отказ до диска", async () => {
    await expect(new FsBlobStore(dir).staged("../x")).rejects.toThrow(/^ждём SHA-256/);
  });
});

describe("L1 · adopt: файл каталога становится файлом хранилища", () => {
  it("fs: файл на месте — ничего не делает; нет — BlobNotFound", async () => {
    const st = new FsBlobStore(dir);
    await expect(st.adopt(h)).rejects.toBeInstanceOf(BlobNotFound);
    await st.put(h, plain);
    await st.adopt(h);
    expect((await st.get(h)).equals(plain)).toBe(true);
  });
  it("tiered: копия уходит в S3 потоком с длиной заранее; объект — формат ADR-0006 и метаданные sha256", async () => {
    const s3 = new StreamS3();
    const st = new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, h), plain);
    await st.adopt(h);
    const o = s3.objects.get(`b/blobs/${h}`)!;
    expect(decryptBlob(S3KEY, o.body).equals(plain)).toBe(true);
    expect(o.meta).toEqual({ sha256: h });
    expect(s3.lengths).toEqual([encryptedBlobBytes(plain.length)]);
    expect(await st.exists(h)).toBe(true);
    expect(await st.verify(h)).toBe(true);
  });
  it("tiered: объект уже в S3 — не перезаписывается", async () => {
    const s3 = new StreamS3();
    const st = new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY });
    await st.put(h, plain);
    await st.adopt(h);
    expect(s3.calls.putStream).toBe(0);
    expect(s3.calls.put).toBe(1);
  });
  it("tiered: S3 без потоковой записи — тот же объект через put", async () => {
    const s3 = new FakeS3();
    const st = new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, h), plain);
    await st.adopt(h);
    expect(decryptBlob(S3KEY, s3.objects.get(`b/blobs/${h}`)!.body).equals(plain)).toBe(true);
  });
});

describe("L4 · L6 · adopt: отказы", () => {
  it("содержимое под именем хеша чужое — запись в S3 обрывается, объекта нет", async () => {
    const s3 = new StreamS3();
    const st = new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, h), Buffer.from("%PDF-1.7 подмена\n%%EOF\n"));
    await expect(st.adopt(h)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(s3.objects.size).toBe(0);
  });
  it("S3 недоступен — BlobStoreUnavailable (503)", async () => {
    const s3 = new StreamS3();
    s3.down = Object.assign(new Error("x"), { name: "TimeoutError" });
    const st = new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY });
    await expect(st.adopt(h)).rejects.toBeInstanceOf(BlobStoreUnavailable);
  });
  it("tiered: файла в каталоге нет — BlobNotFound", async () => {
    const st = new TieredBlobStore(dir, new StreamS3(), { bucket: "b", prefix: "blobs/", key: S3KEY });
    await expect(st.adopt(h)).rejects.toBeInstanceOf(BlobNotFound);
  });
});

describe("L1 · выдача ML большого файла потоком (OS-INSP-1.2.40)", () => {
  it("materializeStream: открытый текст в рабочем каталоге; повтор — тот же файл; чужое содержимое — отказ, временных нет", async () => {
    const local = new LocalAtRest({ keyring: makeKeyring(K1), workDir: work });
    const src = (b: Buffer): PlainStream => ({ size: b.length, plainWhileKeyed: false, workLimit: null, chunks: async function* () { yield b.subarray(0, 5); yield b.subarray(5); } });
    const p = await local.materializeStream(h, src(plain));
    expect(p).toBe(join(work, h));
    expect(readFileSync(p).equals(plain)).toBe(true);
    expect(await local.materializeStream(h, src(Buffer.from("не читается")))).toBe(p); // цел — не перечитывается
    const other = sha(Buffer.from("y"));
    await expect(local.materializeStream(other, src(plain))).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(existsSync(join(work, other))).toBe(false);
    expect(readdirSync(work).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
  it("без рабочего каталога — понятный отказ", async () => {
    const local = new LocalAtRest({ keyring: makeKeyring(K1) });
    await expect(local.materializeStream(h, { size: 0, plainWhileKeyed: false, workLimit: null, chunks: async function* () {} })).rejects.toThrow(/INSPECTOR_BLOB_WORK_DIR/);
  });
  it("fs под ключом: файл крупнее порога идёт в рабочий каталог потоком", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(STREAM_THRESHOLD_BYTES + 1, 0x20), Buffer.from("\n%%EOF\n")]);
    const bh = sha(big);
    const st = new FsBlobStore(dir, undefined, new LocalAtRest({ keyring: makeKeyring(K1), workDir: work, workMaxBytes: 2 * big.length }));
    await st.put(bh, big);
    const p = await st.localPath(bh);
    expect(p).toBe(join(work, bh));
    expect(sha(readFileSync(p))).toBe(bh);
  });
  it("tiered под ключом: большой кэш испорчен — подъём из S3 прежним путём", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(STREAM_THRESHOLD_BYTES + 1, 0x21), Buffer.from("\n%%EOF\n")]);
    const bh = sha(big);
    const s3 = new StreamS3();
    const local = new LocalAtRest({ keyring: makeKeyring(K1), workDir: work, workMaxBytes: 2 * big.length });
    const st = new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY, atRest: local });
    await st.put(bh, big);
    const rec = readFileSync(join(dir, bh));
    rec[100] ^= 1;
    writeFileSync(join(dir, bh), rec);
    const p = await st.localPath(bh);
    expect(sha(readFileSync(p))).toBe(bh);
  });
});

describe("L6 · карантин непроверенного файла (T-169, OWASP)", () => {
  it("fs и tiered: файл уходит под имя .<sha>.rejected-…, имя хеша свободно; файла нет — null", async () => {
    for (const st of [new FsBlobStore(dir), new TieredBlobStore(dir, new StreamS3(), { bucket: "b", prefix: "p/", key: S3KEY })]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, h), Buffer.from("%PDF-1.7 подмена\n%%EOF\n"));
      const q = (await st.quarantine(h))!;
      expect(q).toMatch(new RegExp(`^\\.${h}\\.rejected-\\d+-[0-9a-f]{4}$`));
      expect(existsSync(join(dir, h))).toBe(false);
      expect(readFileSync(join(dir, q), "utf8")).toContain("подмена");
      expect(await st.quarantine(h)).toBeNull();
    }
    await expect(new FsBlobStore(dir).quarantine("../x")).rejects.toThrow(/ждём SHA-256/);
  });
});
