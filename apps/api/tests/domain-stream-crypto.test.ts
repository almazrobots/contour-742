// L1 · L5 · L6 — OS-INSP-1.2.29, 1.2.40, NFR-CRYPTO (T-169): шифрование потоком для файлов больше памяти.
// Поток даёт те же байты, что целый буфер, — объект читается прежними decryptBlob/decryptAtRest; порча — отказ в конце.
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decryptBlob, encryptBlob, encryptBlobStream, encryptedBlobBytes } from "../src/domain/blob-crypto.ts";
import { AT_REST_OVERHEAD, AT_REST_PREFIX_BYTES, AtRestError, decryptAtRest, decryptAtRestStream, encryptAtRest, encryptAtRestStream, makeKeyring } from "../src/domain/at-rest.ts";

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const NONCE = Buffer.alloc(12, 3);

async function* chunksOf(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
const collect = async (it: AsyncIterable<Buffer>) => {
  const out: Buffer[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
};
const openStream = (kr: ReturnType<typeof makeKeyring>, rec: Buffer, size = 7) =>
  collect(decryptAtRestStream(kr, rec.subarray(0, AT_REST_PREFIX_BYTES), rec.subarray(rec.length - 16), chunksOf(rec.subarray(AT_REST_PREFIX_BYTES, rec.length - 16), size)));

describe("объект S3 потоком (ADR-0006, L1 · L5)", () => {
  it("те же байты, что encryptBlob; длина — по формуле", async () => {
    const plain = randomBytes(10_000);
    const s = await collect(encryptBlobStream(KEY, chunksOf(plain, 333), NONCE));
    expect(s.equals(encryptBlob(KEY, plain, NONCE))).toBe(true);
    expect(s.length).toBe(encryptedBlobBytes(plain.length));
    expect(decryptBlob(KEY, s).equals(plain)).toBe(true);
  });
  it("пустой поток — nonce и тег, расшифровывается в пусто", async () => {
    const s = await collect(encryptBlobStream(KEY, chunksOf(Buffer.alloc(0), 1), NONCE));
    expect(s.length).toBe(encryptedBlobBytes(0));
    expect(decryptBlob(KEY, s).length).toBe(0);
  });
  it("неверный ключ или nonce — отказ до первого куска", async () => {
    await expect(collect(encryptBlobStream(Buffer.alloc(16), chunksOf(Buffer.from("x"), 1)))).rejects.toThrow(/32 байт/);
    await expect(collect(encryptBlobStream(KEY, chunksOf(Buffer.from("x"), 1), Buffer.alloc(8)))).rejects.toThrow(/nonce: ждём 12 байт, получено 8/);
  });
  it("L5: при любом делении на куски — как целый буфер", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.integer({ min: 1, max: 64 }), async (u, size) => {
        const plain = Buffer.from(u);
        expect((await collect(encryptBlobStream(KEY, chunksOf(plain, size), NONCE))).equals(encryptBlob(KEY, plain, NONCE))).toBe(true);
      }),
    );
  });
});

describe("файл хранилища IBE1 потоком (NFR-CRYPTO, L1 · L5 · L6)", () => {
  const kr = makeKeyring(KEY, [OTHER]);
  it("запись потоком = encryptAtRest; чтение потоком = исходный текст", async () => {
    const plain = randomBytes(5000);
    const rec = await collect(encryptAtRestStream(KEY, chunksOf(plain, 100), NONCE));
    expect(rec.equals(encryptAtRest(KEY, plain, NONCE))).toBe(true);
    expect(rec.length).toBe(plain.length + AT_REST_OVERHEAD);
    expect(decryptAtRest(kr, rec).plain.equals(plain)).toBe(true);
    expect((await openStream(kr, rec)).equals(plain)).toBe(true);
  });
  it("старым ключом из связки — читается", async () => {
    const plain = Buffer.from("ротация");
    expect((await openStream(kr, encryptAtRest(OTHER, plain))).equals(plain)).toBe(true);
  });
  it("испорченный байт шифротекста — TAG в конце потока", async () => {
    const rec = encryptAtRest(KEY, randomBytes(1000));
    rec[AT_REST_PREFIX_BYTES + 10] ^= 1;
    const e = await openStream(kr, rec).catch((x) => x);
    expect(e).toBeInstanceOf(AtRestError);
    expect(e.code).toBe("TAG");
  });
  it("подменённый key_id — не другой ключ, а отказ: UNKNOWN_KEY или TAG", async () => {
    const rec = encryptAtRest(KEY, Buffer.from("abc"));
    const unknown = Buffer.from(rec);
    unknown[5] ^= 0xff;
    expect((await openStream(kr, unknown).catch((x) => x)).code).toBe("UNKNOWN_KEY");
    const swapped = Buffer.concat([encryptAtRest(OTHER, Buffer.from("x")).subarray(0, 12), rec.subarray(12)]); // key_id OTHER, nonce и тег — от KEY
    expect((await openStream(kr, swapped).catch((x) => x)).code).toBe("TAG");
  });
  it("обрезанная запись, короткий тег или не IBE1 — TRUNCATED", async () => {
    const rec = encryptAtRest(KEY, Buffer.from("abc"));
    await expect(collect(decryptAtRestStream(kr, rec.subarray(0, 10), rec.subarray(rec.length - 16), chunksOf(Buffer.alloc(0), 1)))).rejects.toMatchObject({ code: "TRUNCATED" });
    await expect(collect(decryptAtRestStream(kr, rec.subarray(0, AT_REST_PREFIX_BYTES), Buffer.alloc(4), chunksOf(Buffer.alloc(0), 1)))).rejects.toMatchObject({ code: "TRUNCATED" });
    await expect(collect(decryptAtRestStream(kr, Buffer.alloc(AT_REST_PREFIX_BYTES), Buffer.alloc(16), chunksOf(Buffer.alloc(0), 1)))).rejects.toMatchObject({ code: "TRUNCATED" });
  });
  it("L5: при любом делении на куски запись и чтение потоком обратимы и равны буферным", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.integer({ min: 1, max: 64 }), async (u, size) => {
        const plain = Buffer.from(u);
        const rec = await collect(encryptAtRestStream(KEY, chunksOf(plain, size), NONCE));
        expect(rec.equals(encryptAtRest(KEY, plain, NONCE))).toBe(true);
        expect((await openStream(kr, rec, size)).equals(plain)).toBe(true);
      }),
    );
  });
});
