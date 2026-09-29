// NFR-CRYPTO (ТЗ 12.3-01): формат локального блоба «в покое» IBE1 ‖ key_id(8) ‖ nonce(12) ‖ шифротекст ‖ тег(16),
// связка ключей для ротации, наследие открытым текстом, вытеснение рабочего каталога ML, признак tmpfs.
// Эшелоны qa-standard: L1 круг и выбор ключа по key_id · L3 границы (пустой буфер, ровно заголовок, заголовок без байта,
// граница вместимости рабочего каталога) · L5 свойства (fast-check) · L6 подменённый тег, key_id, заголовок; обрезанная запись.
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AT_REST_MAGIC, AT_REST_OVERHEAD, AtRestError, decryptAtRest, encryptAtRest, isEncryptedBlob, isTmpfsAt, keyId, makeKeyring, parseKeyList, pickEvictions,
} from "../src/domain/at-rest.ts";
import { encryptBlob } from "../src/domain/blob-crypto.ts";

const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);
const NONCE = Buffer.alloc(12, 9);
const plain = Buffer.from("%PDF-1.7 акт освидетельствования скрытых работ №12");

describe("L1 · формат и круг", () => {
  it("формат: IBE1 ‖ key_id ‖ nonce ‖ шифротекст ‖ тег; открытого текста в записи нет", () => {
    const blob = encryptAtRest(K1, plain, NONCE);
    expect(blob.subarray(0, 4).toString("latin1")).toBe("IBE1");
    expect(blob.subarray(4, 12)).toEqual(keyId(K1));
    expect(blob.subarray(12, 24)).toEqual(NONCE);
    expect(blob.length).toBe(plain.length + AT_REST_OVERHEAD);
    expect(AT_REST_OVERHEAD).toBe(4 + 8 + 12 + 16);
    expect(blob.includes(plain)).toBe(false);
    expect(decryptAtRest(makeKeyring(K1), blob)).toEqual({ plain, legacy: false, keyId: keyId(K1).toString("hex") });
  });
  it("key_id — первые 8 байт SHA-256 ключа", () => {
    expect(keyId(K1).toString("hex")).toBe(createHash("sha256").update(K1).digest("hex").slice(0, 16));
    expect(keyId(K1).equals(keyId(K2))).toBe(false);
  });
  it("по умолчанию nonce случайный: две записи одного текста различаются, обе читаются", () => {
    const a = encryptAtRest(K1, plain);
    const b = encryptAtRest(K1, plain);
    expect(a.equals(b)).toBe(false);
    expect(decryptAtRest(makeKeyring(K1), a).plain).toEqual(decryptAtRest(makeKeyring(K1), b).plain);
  });
  it("ротация: запись старым ключом читается связкой «новый + старые»; пишется текущим", () => {
    const old = encryptAtRest(K1, plain);
    const ring = makeKeyring(K2, [K1]);
    expect(ring.current).toEqual(K2);
    expect(decryptAtRest(ring, old)).toMatchObject({ plain, legacy: false, keyId: keyId(K1).toString("hex") });
    expect(decryptAtRest(ring, encryptAtRest(ring.current, plain)).keyId).toBe(keyId(K2).toString("hex"));
  });
  it("неизвестный key_id — ошибка UNKNOWN_KEY с key_id в hex", () => {
    const blob = encryptAtRest(K1, plain);
    let err: AtRestError | null = null;
    try {
      decryptAtRest(makeKeyring(K2), blob);
    } catch (e) {
      err = e as AtRestError;
    }
    expect(err).toBeInstanceOf(AtRestError);
    expect(err!.code).toBe("UNKNOWN_KEY");
    expect(err!.message).toContain(keyId(K1).toString("hex"));
  });
  it("наследие: без магии — открытый текст как есть с признаком legacy", () => {
    expect(isEncryptedBlob(plain)).toBe(false);
    expect(decryptAtRest(makeKeyring(K1), plain)).toEqual({ plain, legacy: true, keyId: null });
  });
  it("формат S3 (ADR-0006, без заголовка) не принимается за локальный: у него нет магии", () => {
    expect(isEncryptedBlob(encryptBlob(K1, plain, NONCE))).toBe(false);
  });
  it("связка: повтор ключа не мешает; ключ не 32 байта — отказ", () => {
    expect(makeKeyring(K1, [K1, K2]).byId.size).toBe(2);
    expect(() => makeKeyring(Buffer.alloc(16))).toThrow(/32 байт/);
    expect(() => makeKeyring(K1, [Buffer.alloc(31)])).toThrow(/32 байт/);
  });
  it("список старых ключей: по строке, пустые строки и # пропускаются; ошибка — с номером строки, без содержимого", () => {
    const text = `# ключи до ротации 2026-09\n${"01".repeat(32)}\n\n${K2.toString("base64")}\n`;
    expect(parseKeyList(text)).toEqual([K1, K2]);
    expect(parseKeyList("")).toEqual([]);
    const bad = "z".repeat(64);
    expect(() => parseKeyList(`${"01".repeat(32)}\n${bad}`)).toThrow(/строка 2/);
    try {
      parseKeyList(bad);
    } catch (e) {
      expect((e as Error).message).not.toContain(bad);
    }
  });
});

describe("L3 · границы", () => {
  it("пустой буфер: не зашифрован, наследие пустого файла; пустой открытый текст шифруется в 40 байт", () => {
    expect(isEncryptedBlob(Buffer.alloc(0))).toBe(false);
    expect(decryptAtRest(makeKeyring(K1), Buffer.alloc(0))).toEqual({ plain: Buffer.alloc(0), legacy: true, keyId: null });
    const e = encryptAtRest(K1, Buffer.alloc(0));
    expect(e.length).toBe(AT_REST_OVERHEAD);
    expect(decryptAtRest(makeKeyring(K1), e).plain.length).toBe(0);
  });
  it("магия без полного заголовка и тега — TRUNCATED; ровно 40 байт — читается", () => {
    const e = encryptAtRest(K1, Buffer.alloc(0));
    for (const n of [4, 12, 24, AT_REST_OVERHEAD - 1]) {
      expect(() => decryptAtRest(makeKeyring(K1), e.subarray(0, n))).toThrow(expect.objectContaining({ code: "TRUNCATED" }));
    }
    expect(isEncryptedBlob(e.subarray(0, 4))).toBe(true);
    expect(isEncryptedBlob(e.subarray(0, 3))).toBe(false);
  });
  it("вытеснение рабочего каталога: до вместимости включительно — ничего; сверх — старые первыми, текущий никогда", () => {
    const files = [
      { name: "a", size: 40, mtimeMs: 1 },
      { name: "b", size: 30, mtimeMs: 3 },
      { name: "c", size: 30, mtimeMs: 2 },
    ];
    expect(pickEvictions(files, 100, "b")).toEqual([]);
    expect(pickEvictions(files, 99, "b")).toEqual(["a"]);
    expect(pickEvictions(files, 30, "b")).toEqual(["a", "c"]);
    expect(pickEvictions(files, 0, "a")).toEqual(["c", "b"]); // текущий «a» остаётся, даже если сам больше вместимости
  });
});

describe("L5 · свойства", () => {
  it("круг для любого открытого текста и любой позиции ключа в связке", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), fc.boolean(), (bytes, rotated) => {
        const p = Buffer.from(bytes);
        const ring = rotated ? makeKeyring(K2, [K1]) : makeKeyring(K1);
        const blob = encryptAtRest(rotated ? K1 : ring.current, p);
        const out = decryptAtRest(ring, blob);
        return out.plain.equals(p) && !out.legacy && isEncryptedBlob(blob);
      }),
    );
  });
});

describe("L6 · враждебные данные", () => {
  const ring = makeKeyring(K1);
  it("порча любого байта после магии — отказ (тег, key_id или nonce), а не мусор", () => {
    const blob = encryptAtRest(K1, plain, NONCE);
    for (let i = 4; i < blob.length; i++) {
      const bad = Buffer.from(blob);
      bad[i] ^= 0x01;
      expect(() => decryptAtRest(ring, bad), `байт ${i}`).toThrow(AtRestError);
    }
  });
  it("подменённый тег — TAG", () => {
    const blob = encryptAtRest(K1, plain);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptAtRest(ring, blob)).toThrow(expect.objectContaining({ code: "TAG" }));
  });
  it("key_id подменён на id другого ключа связки — TAG: заголовок входит в AAD", () => {
    const two = makeKeyring(K1, [K2]);
    const blob = encryptAtRest(K1, plain);
    keyId(K2).copy(blob, 4);
    expect(() => decryptAtRest(two, blob)).toThrow(expect.objectContaining({ code: "TAG" }));
  });
  it("хвост дописан или отрезан — отказ", () => {
    const blob = encryptAtRest(K1, plain);
    expect(() => decryptAtRest(ring, Buffer.concat([blob, Buffer.from([0])]))).toThrow(AtRestError);
    expect(() => decryptAtRest(ring, blob.subarray(0, blob.length - 1))).toThrow(AtRestError);
  });
  it("магия — ровно четыре байта IBE1", () => {
    expect(AT_REST_MAGIC.toString("latin1")).toBe("IBE1");
    expect(isEncryptedBlob(Buffer.from("IBE0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))).toBe(false);
  });
});

describe("L1 · рабочий каталог ML — только tmpfs (по /proc/self/mounts)", () => {
  const mounts = [
    "overlay / overlay rw,relatime 0 0",
    "tmpfs /tmp tmpfs rw,nosuid 0 0",
    "/dev/mapper/data /app/var/blobs ext4 rw 0 0",
    "tmpfs /app/var/blob-work tmpfs rw,size=2097152k 0 0",
    "tmpfs /app/var/with\\040space tmpfs rw 0 0",
  ].join("\n");
  it("ближайшая точка монтирования решает; каталог внутри tmpfs — тоже tmpfs", () => {
    expect(isTmpfsAt(mounts, "/app/var/blob-work")).toBe(true);
    expect(isTmpfsAt(mounts, "/app/var/blob-work/sub")).toBe(true);
    expect(isTmpfsAt(mounts, "/app/var/blobs")).toBe(false);
    expect(isTmpfsAt(mounts, "/app/var/blob-workx")).toBe(false); // граница компонента пути
    expect(isTmpfsAt(mounts, "/app/var/with space/x")).toBe(true); // \040 в /proc/mounts — пробел
    expect(isTmpfsAt("", "/x")).toBe(false);
  });
});
