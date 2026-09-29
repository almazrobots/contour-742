// OS-INSP-1.2.28, 1.2.29 (ADR-0006): шифрование блобов AES-256-GCM и ключ объекта по SHA-256.
// Эшелоны qa-standard: L1 круг шифрование/расшифровка · L3 границы (пустой, 1 байт, большой буфер, длины ключа и nonce,
// префикс) · L5 свойства (fast-check) · L6 порча любого байта, обрезанная запись, ключ в неверном формате.
import { createHash, randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blobObjectKey, decryptBlob, decryptBlobStream, encryptBlob, isSha256, KEY_BYTES, NONCE_BYTES, parseEncryptionKey, sha256hex, TAG_BYTES } from "../src/domain/blob-crypto.ts";

const key = Buffer.alloc(32, 7);
const nonce = Buffer.alloc(12, 1);
const SHA = "a".repeat(64);

describe("S3 download stream authentication", () => {
  async function collect(blob: Buffer, step: number, k = key) {
    async function* chunks() {
      for (let n = 0; n < blob.length; n += step) yield blob.subarray(n, n + step);
    }
    const out: Buffer[] = [];
    for await (const c of decryptBlobStream(k, chunks())) out.push(c);
    return Buffer.concat(out);
  }
  it("nonce/tag split across arbitrary chunks, including empty content", async () => {
    for (const body of [Buffer.alloc(0), Buffer.from("a"), Buffer.alloc(65539, 7)]) {
      const blob = encryptBlob(key, body, nonce);
      for (const step of [1, 11, 12, 16, 65536]) expect(await collect(blob, step)).toEqual(body);
    }
  });
  it("rejects truncated data, wrong key and altered tag after consumption", async () => {
    const blob = encryptBlob(key, Buffer.from("private object"), nonce);
    await expect(collect(blob.subarray(0, 27), 1)).rejects.toThrow("обрезана");
    await expect(collect(blob, 11, Buffer.alloc(32, 9))).rejects.toThrow("GCM");
    const changed = Buffer.from(blob); changed[changed.length - 1] ^= 1;
    await expect(collect(changed, 12)).rejects.toThrow("GCM");
  });
});

describe("L1 · шифрование и расшифровка", () => {
  it("круг: расшифровка возвращает открытый текст; формат nonce ‖ шифротекст ‖ тег", () => {
    const plain = Buffer.from("акт скрытых работ №7");
    const blob = encryptBlob(key, plain, nonce);
    expect(blob.length).toBe(NONCE_BYTES + plain.length + TAG_BYTES);
    expect(blob.subarray(0, 12)).toEqual(nonce);
    expect(blob.includes(plain)).toBe(false); // в объекте нет открытого текста
    expect(decryptBlob(key, blob)).toEqual(plain);
  });
  it("известный вектор: тот же ключ и nonce — тот же объект (детерминизм при заданном nonce)", () => {
    const a = encryptBlob(key, Buffer.from("x"), nonce);
    expect(a.toString("hex")).toBe(encryptBlob(key, Buffer.from("x"), nonce).toString("hex"));
    expect(a.length).toBe(29);
  });
  it("по умолчанию nonce случайный: два шифрования одного текста различаются", () => {
    const plain = Buffer.from("один и тот же файл");
    const a = encryptBlob(key, plain);
    const b = encryptBlob(key, plain);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    expect(decryptBlob(key, a)).toEqual(plain);
    expect(decryptBlob(key, b)).toEqual(plain);
  });
  it("sha256hex — hex SHA-256; isSha256 — строго 64 строчных hex", () => {
    expect(sha256hex(Buffer.from("abc"))).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(isSha256(sha256hex(Buffer.from("")))).toBe(true);
  });
  it("ключ объекта: префикс нормализуется к «…/»", () => {
    expect(blobObjectKey("blobs/", SHA)).toBe(`blobs/${SHA}`);
    expect(blobObjectKey("blobs", SHA)).toBe(`blobs/${SHA}`);
  });
});

describe("L3 · границы", () => {
  it("пустой буфер, 1 байт, 5 МБ", () => {
    for (const plain of [Buffer.alloc(0), Buffer.from([0]), randomBytes(5 * 1024 * 1024)]) {
      const blob = encryptBlob(key, plain);
      expect(blob.length).toBe(plain.length + 28);
      expect(decryptBlob(key, blob).equals(plain)).toBe(true);
    }
  });
  it("длина ключа не 32 байта — ошибка и при шифровании, и при расшифровке", () => {
    expect(KEY_BYTES).toBe(32);
    for (const k of [Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33)]) {
      expect(() => encryptBlob(k, Buffer.from("x"), nonce)).toThrow(/ждём 32 байт \(AES-256\), получено \d+/);
      expect(() => decryptBlob(k, Buffer.alloc(40))).toThrow(/ждём 32 байт/);
    }
  });
  it("nonce не 12 байт — ошибка", () => {
    expect(() => encryptBlob(key, Buffer.from("x"), Buffer.alloc(11))).toThrow("nonce: ждём 12 байт, получено 11");
    expect(() => encryptBlob(key, Buffer.from("x"), Buffer.alloc(16))).toThrow(/nonce/);
  });
  it("запись ровно 28 байт — пустой открытый текст; 27 байт — обрезана", () => {
    const empty = encryptBlob(key, Buffer.alloc(0), nonce);
    expect(empty.length).toBe(28);
    expect(decryptBlob(key, empty).length).toBe(0);
    expect(() => decryptBlob(key, empty.subarray(0, 27))).toThrow("зашифрованный объект короче 28 байт: запись обрезана");
  });
  it("sha невалидный: длина, регистр, не hex", () => {
    for (const bad of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), ` ${"a".repeat(63)}`, `${"a".repeat(64)}\n`, `../${"a".repeat(61)}`]) {
      expect(isSha256(bad)).toBe(false);
      expect(() => blobObjectKey("blobs/", bad)).toThrow("ключ объекта: ждём SHA-256 — 64 строчных шестнадцатеричных символа");
    }
  });
  it("префикс: пустой — корень бакета; лишние и ведущие слэши и пробелы срезаются", () => {
    expect(blobObjectKey("", SHA)).toBe(SHA);
    expect(blobObjectKey("/", SHA)).toBe(SHA);
    expect(blobObjectKey("  blobs//  ", SHA)).toBe(`blobs/${SHA}`);
    expect(blobObjectKey("//a/b/", SHA)).toBe(`a/b/${SHA}`);
    expect(blobObjectKey("a/b", SHA)).toBe(`a/b/${SHA}`); // внутренние слэши сохраняются
  });
  it("ключ шифрования: 64 hex (любой регистр) и base64 44/43 знака; пробелы и перевод строки срезаются", () => {
    const k = randomBytes(32);
    expect(parseEncryptionKey(k.toString("hex"))).toEqual(k);
    expect(parseEncryptionKey(`${k.toString("hex").toUpperCase()}\n`)).toEqual(k);
    expect(parseEncryptionKey(` ${k.toString("base64")}\n`)).toEqual(k);
    expect(parseEncryptionKey(k.toString("base64url"))).toEqual(k);
    expect(parseEncryptionKey(k.toString("base64").replace(/=$/, ""))).toEqual(k);
  });
});

describe("L5 · свойства", () => {
  it("decrypt(encrypt(x)) == x для любых x", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 4096 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), (x, k) => {
      const kb = Buffer.from(k);
      expect(decryptBlob(kb, encryptBlob(kb, Buffer.from(x))).equals(Buffer.from(x))).toBe(true);
    }));
  });
  it("разные nonce — разный шифротекст одного и того же текста", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), fc.uint8Array({ minLength: 12, maxLength: 12 }), fc.uint8Array({ minLength: 12, maxLength: 12 }), (x, n1, n2) => {
      fc.pre(!Buffer.from(n1).equals(Buffer.from(n2)));
      const a = encryptBlob(key, Buffer.from(x), Buffer.from(n1)).subarray(12);
      const b = encryptBlob(key, Buffer.from(x), Buffer.from(n2)).subarray(12);
      expect(a.equals(b)).toBe(false);
    }));
  });
  it("любые 32 байта ключа переживают hex и base64", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (k) => {
      const b = Buffer.from(k);
      expect(parseEncryptionKey(b.toString("hex"))).toEqual(b);
      expect(parseEncryptionKey(b.toString("base64"))).toEqual(b);
    }));
  });
});

describe("L6 · порча и чужой ключ", () => {
  const plain = Buffer.from("проектная документация, лист 3");
  const blob = encryptBlob(key, plain, nonce);
  it("порча любого байта (nonce, шифротекст, тег) — отказ, а не мусор", () => {
    for (let i = 0; i < blob.length; i++) {
      const bad = Buffer.from(blob);
      bad[i] ^= 0x01;
      expect(() => decryptBlob(key, bad), `байт ${i}`).toThrow("тег GCM не сошёлся: объект повреждён или зашифрован другим ключом");
    }
  });
  it("обрезанная или дописанная запись — отказ", () => {
    expect(() => decryptBlob(key, blob.subarray(0, blob.length - 1))).toThrow(/тег GCM/);
    expect(() => decryptBlob(key, blob.subarray(1))).toThrow(/тег GCM/);
    expect(() => decryptBlob(key, Buffer.concat([blob, Buffer.from([0])]))).toThrow(/тег GCM/);
    expect(() => decryptBlob(key, blob.subarray(0, 10))).toThrow(/обрезана/);
    expect(() => decryptBlob(key, Buffer.alloc(0))).toThrow(/обрезана/);
  });
  it("чужой ключ — отказ", () => {
    expect(() => decryptBlob(Buffer.alloc(32, 8), blob)).toThrow(/другим ключом/);
  });
  it("ключ в неверном формате — громкая ошибка без содержимого ключа", () => {
    const k = randomBytes(32);
    const bads = ["", "секрет", k.toString("hex").slice(1), `${k.toString("hex")}0`, `${k.toString("hex").slice(2)}zz`, randomBytes(16).toString("base64"), randomBytes(33).toString("base64"),
      `${k.toString("base64").slice(0, 43)}==`, `${k.toString("base64").slice(0, 42)}!=`, `x${k.toString("base64")}`];
    for (const bad of bads) {
      let msg = "";
      try {
        parseEncryptionKey(bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(bad)).toBe("ключ шифрования: ждём 32 байт — 64 шестнадцатеричных символа или base64 (44 символа)");
    }
  });
});
