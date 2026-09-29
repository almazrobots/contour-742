// NFR-CRYPTO (ТЗ 12.3-01): файлы пакета на диске — зашифрованы (IBE1, AES-256-GCM с key_id), ML читает открытый текст
// только из рабочего каталога в tmpfs. fs и локальный кэш tiered; наследие, ротация, атомарность, выдача кусками.
// Эшелоны qa-standard: L1 запись шифротекстом, чтение, verify, localPath, ротация · L4 сбой между tmp и rename, кэш
// под неизвестным ключом → подъём из S3 · L6 подменённый файл на диске, файл под чужим ключом, «наследие» с магией IBE1.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptAtRest, isEncryptedBlob, keyId, makeKeyring } from "../src/domain/at-rest.ts";
import { decryptBlob } from "../src/domain/blob-crypto.ts";
import { atRestStats, blobStoreFromConfig, FsBlobStore, LocalAtRest, TieredBlobStore, type S3Like } from "../src/services/blobstore.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);
const S3KEY = Buffer.alloc(32, 3);
const plain = Buffer.from("%PDF-1.7 синтетический лист РД, раздел КЖ");
const h = sha(plain);

class FakeS3 implements S3Like {
  objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  gets = 0;
  async head(b: string, k: string) {
    return this.objects.get(`${b}/${k}`)?.meta ?? null;
  }
  async put(b: string, k: string, body: Buffer, meta: Record<string, string>) {
    this.objects.set(`${b}/${k}`, { body: Buffer.from(body), meta });
  }
  async get(b: string, k: string) {
    this.gets++;
    return this.objects.get(`${b}/${k}`)?.body ?? null;
  }
}

let dir: string;
let work: string;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t137-at-rest-"));
  dir = join(root, "blobs");
  work = join(root, "work");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const atRest = (ring = makeKeyring(K1), workMaxBytes?: number) => new LocalAtRest({ keyring: ring, workDir: work, workMaxBytes });
const fs = (ring = makeKeyring(K1), rename?: (a: string, b: string) => void) => new FsBlobStore(dir, rename, atRest(ring));

describe("L1 · fs: на диске шифротекст, наружу — открытый текст", () => {
  it("put пишет IBE1 под текущим ключом; открытого текста в файле нет; get/exists/verify по открытому тексту", async () => {
    const st = fs();
    await st.put(h, plain);
    const raw = readFileSync(join(dir, h));
    expect(isEncryptedBlob(raw)).toBe(true);
    expect(raw.subarray(4, 12)).toEqual(keyId(K1));
    expect(raw.includes(plain)).toBe(false);
    expect(await st.get(h)).toEqual(plain);
    expect(await st.exists(h)).toBe(true);
    expect(await st.verify(h)).toBe(true);
    expect(await st.intact(h)).toBe(true);
  });
  it("повторный put не трогает файл (неперезапись, OS-INSP-1.2.28)", async () => {
    const st = fs();
    await st.put(h, plain);
    const first = readFileSync(join(dir, h));
    await st.put(h, plain);
    expect(readFileSync(join(dir, h))).toEqual(first);
  });
  it("localPath: открытый текст — в рабочем каталоге ML, не в хранилище; повторный вызов — тот же файл", async () => {
    const st = fs();
    await st.put(h, plain);
    const p = await st.localPath(h);
    expect(p).toBe(join(work, h));
    expect(readFileSync(p)).toEqual(plain);
    expect(isEncryptedBlob(readFileSync(join(dir, h)))).toBe(true);
    expect(await st.localPath(h)).toBe(p);
    expect(readdirSync(work).filter((n) => n.startsWith("."))).toEqual([]); // временных не осталось
  });
  it("без ключа — прежнее поведение: файл открытым текстом, localPath — сам файл хранилища", async () => {
    const st = new FsBlobStore(dir);
    await st.put(h, plain);
    expect(readFileSync(join(dir, h))).toEqual(plain);
    expect(await st.localPath(h)).toBe(join(dir, h));
    expect(new LocalAtRest().encrypted).toBe(false);
  });
  it("фабрика: blobStoreFromConfig с ключом хранения пишет зашифровано", async () => {
    const st = blobStoreFromConfig({ kind: "fs" }, dir, { keyring: makeKeyring(K1), workDir: work });
    await st.put(h, plain);
    expect(isEncryptedBlob(readFileSync(join(dir, h)))).toBe(true);
  });
});

describe("L1 · наследие и ротация", () => {
  it("файл открытым текстом (до включения шифрования) читается, считается в метрике legacyReads", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, h), plain);
    const st = fs();
    const before = atRestStats().legacyReads;
    expect(await st.get(h)).toEqual(plain);
    expect(await st.verify(h)).toBe(true);
    expect(atRestStats().legacyReads).toBeGreaterThan(before);
  });
  it("ротация: файл старого ключа читается связкой «K2 + старый K1»; новые пишутся K2", async () => {
    await fs(makeKeyring(K1)).put(h, plain);
    const st = fs(makeKeyring(K2, [K1]));
    expect(await st.get(h)).toEqual(plain);
    const other = Buffer.from("второй файл");
    await st.put(sha(other), other);
    expect(readFileSync(join(dir, sha(other))).subarray(4, 12)).toEqual(keyId(K2));
  });
});

describe("L4 · отказы", () => {
  it("сбой между tmp и rename: под именем sha ничего, временный убран", async () => {
    const st = fs(makeKeyring(K1), () => {
      throw new Error("диск отвалился");
    });
    await expect(st.put(h, plain)).rejects.toThrow("диск отвалился");
    expect(existsSync(join(dir, h))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("ключ задан, рабочего каталога нет — localPath отказывает понятно, а не отдаёт шифротекст ML", async () => {
    const st = new FsBlobStore(dir, undefined, new LocalAtRest({ keyring: makeKeyring(K1) }));
    await st.put(h, plain);
    await expect(st.localPath(h)).rejects.toThrow(/INSPECTOR_BLOB_WORK_DIR/);
  });
  it("рабочий каталог сверх вместимости — старые файлы вытесняются, текущий остаётся", async () => {
    const st = new FsBlobStore(dir, undefined, atRest(makeKeyring(K1), 100));
    const a = Buffer.alloc(60, 1);
    const b = Buffer.alloc(60, 2);
    await st.put(sha(a), a);
    await st.put(sha(b), b);
    await st.localPath(sha(a));
    utimesSync(join(work, sha(a)), new Date(1000), new Date(1000));
    await st.localPath(sha(b));
    expect(readdirSync(work)).toEqual([sha(b)]);
    expect(existsSync(join(dir, sha(a)))).toBe(true); // хранилище не трогается
  });
});

describe("L6 · враждебные данные на диске", () => {
  it("подменённый байт шифротекста — BlobIntegrityError; verify — false", async () => {
    const st = fs();
    await st.put(h, plain);
    const raw = readFileSync(join(dir, h));
    raw[raw.length - 20] ^= 1;
    writeFileSync(join(dir, h), raw);
    await expect(st.get(h)).rejects.toMatchObject({ name: "BlobIntegrityError", status: 500 });
    expect(await st.verify(h)).toBe(false);
    expect(await st.intact(h)).toBe(false);
  });
  it("файл под ключом, которого нет в связке, — отказ с key_id в тексте", async () => {
    await fs(makeKeyring(K1)).put(h, plain);
    await expect(fs(makeKeyring(K2)).get(h)).rejects.toThrow(keyId(K1).toString("hex"));
  });
  it("чужой файл под именем sha, зашифрованный нашим ключом, — отказ по SHA-256 открытого текста", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, h), encryptAtRest(K1, Buffer.from("подмена")));
    await expect(fs().get(h)).rejects.toThrow(/SHA-256/);
  });
  it("открытый текст, начинающийся с IBE1 (наследие), читается по совпадению SHA-256", async () => {
    const odd = Buffer.from("IBE1 — так начинается текстовый файл наследия, не наш заголовок");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sha(odd)), odd);
    expect(await fs().get(sha(odd))).toEqual(odd);
  });
  it("зашифрованный файл без ключа хранения — отказ с подсказкой про INSPECTOR_BLOB_KEY_FILE", async () => {
    await fs().put(h, plain);
    await expect(new FsBlobStore(dir).get(h)).rejects.toThrow(/INSPECTOR_BLOB_KEY_FILE/);
  });
});

describe("tiered: локальный кэш — IBE1, бакет — формат ADR-0006", () => {
  const tiered = (s3: FakeS3, ring = makeKeyring(K1)) => new TieredBlobStore(dir, s3, { bucket: "b", prefix: "blobs/", key: S3KEY, atRest: atRest(ring) });
  it("put: в бакете — шифротекст ключом S3 без заголовка, в кэше — IBE1 ключом хранения", async () => {
    const s3 = new FakeS3();
    const st = tiered(s3);
    await st.put(h, plain);
    expect(decryptBlob(S3KEY, s3.objects.get(`b/blobs/${h}`)!.body)).toEqual(plain);
    const cached = readFileSync(join(dir, h));
    expect(isEncryptedBlob(cached)).toBe(true);
    expect(cached.includes(plain)).toBe(false);
    expect(await st.get(h)).toEqual(plain);
    expect(s3.gets).toBe(0); // из кэша
    expect(await st.verify(h)).toBe(true);
  });
  it("промах кэша: объект поднимается из S3 и ложится в кэш зашифрованным; localPath — рабочий каталог", async () => {
    const s3 = new FakeS3();
    await tiered(s3).put(h, plain);
    rmSync(join(dir, h));
    const st = tiered(s3);
    expect(await st.localPath(h)).toBe(join(work, h));
    expect(readFileSync(join(work, h))).toEqual(plain);
    expect(isEncryptedBlob(readFileSync(join(dir, h)))).toBe(true);
  });
  it("L4: кэш под неизвестным ключом — не ошибка, а промах: подъём из S3 и перезапись кэша текущим ключом", async () => {
    const s3 = new FakeS3();
    await tiered(s3, makeKeyring(K1)).put(h, plain);
    const st = tiered(s3, makeKeyring(K2));
    expect(await st.get(h)).toEqual(plain);
    expect(s3.gets).toBe(1);
    expect(readFileSync(join(dir, h)).subarray(4, 12)).toEqual(keyId(K2));
  });
  it("L6: подменённый кэш — verify false; get поднимает цельный объект из S3", async () => {
    const s3 = new FakeS3();
    const st = tiered(s3);
    await st.put(h, plain);
    const raw = readFileSync(join(dir, h));
    raw[30] ^= 1;
    writeFileSync(join(dir, h), raw);
    expect(await st.verify(h)).toBe(false);
    expect(await st.get(h)).toEqual(plain);
  });
});

describe("выдача кусками (T-133) поверх зашифрованного хранилища", () => {
  it("Range режет открытый текст: get расшифровывает целиком, маршрут отдаёт ровно запрошенные байты", async () => {
    const TMP = mkdtempSync(join(tmpdir(), "t137-range-"));
    Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
    const { openDb } = await import("../src/db.ts");
    const { buildApp } = await import("../src/app.ts");
    const { setBlobStoreForTests } = await import("../src/services/blobstore.ts");
    const { createInspection } = await import("../src/services/inspections.ts");
    const db = await openDb("memory");
    const app = await buildApp(db);
    try {
      const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
      const st = fs();
      await st.put(sha(body), body);
      setBlobStoreForTests(st);
      const token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
      const insp = await createInspection({ db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-AT-REST", name: "Синтетика", address: "", customer: "", contractor: "", permit_number: "", profile: {} });
      await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, uploaded_at)
        values ('f-at-rest', $1, 'OBJ-AT-REST', 'PD-1', 'лист.pdf', $2, $3, 'pdf', 'PD', 'П-0000-ЛИСТ', '0', 'DONE', now())`, [insp, sha(body), body.length]);
      const r = await app.inject({ method: "GET", url: "/api/v1/files/f-at-rest/content", headers: { authorization: `Bearer ${token}`, range: "bytes=100-199" } });
      expect([r.statusCode, r.headers["content-range"]]).toEqual([206, "bytes 100-199/5000"]);
      expect(r.rawPayload.equals(body.subarray(100, 200))).toBe(true);
      // ТЗ 12.7: ежедневная сверка целостности видит IBE1-файл целым, а подменённый — повреждённым
      const { verifyBlobs } = await import("../src/services/integrity.ts");
      expect(await verifyBlobs(db, dir)).toMatchObject({ checked: 1, missing: [], corrupted: [], unreadable: [] });
      const raw = readFileSync(join(dir, sha(body)));
      raw[50] ^= 1;
      writeFileSync(join(dir, sha(body)), raw);
      expect(await verifyBlobs(db, dir)).toMatchObject({ corrupted: [sha(body)] });
    } finally {
      setBlobStoreForTests(null);
      await app.close();
      await db.close();
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});
