// OS-INSP-1.2.28–1.2.30 (ADR-0006): BlobStore — fs и tiered (кэш-каталог + зашифрованная копия в S3) на фейковом S3 в памяти.
// Эшелоны qa-standard: L1 put/get/exists/verify/localPath, неперезапись, шифротекст в бакете, промах кэша ·
// L4 отказы (S3 недоступен → 503 без кэша, испорченный объект не попадает в кэш, сбой между tmp и rename) ·
// L6 подмена объекта в бакете чужим содержимым → отказ по SHA-256. Адаптер SDK — на заглушке S3 по HTTP (L4: 404, 403, 5xx).
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptBlob } from "../src/domain/blob-crypto.ts";
import {
  atomicWrite, BlobIntegrityError, BlobNotFound, blobStore, blobStoreFromConfig, BlobStoreUnavailable, FsBlobStore, s3Reason, sdkS3, setBlobStoreForTests, TieredBlobStore, type S3Like,
} from "../src/services/blobstore.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KEY = Buffer.alloc(32, 3);
const BUCKET = "b";

/** S3 в памяти со счётчиками вызовов и переключаемым отказом. */
class FakeS3 implements S3Like {
  objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  calls = { head: 0, put: 0, get: 0 };
  down: Error | null = null;
  async head(bucket: string, key: string) {
    this.calls.head++;
    if (this.down) throw this.down;
    return this.objects.get(`${bucket}/${key}`)?.meta ?? null;
  }
  async put(bucket: string, key: string, body: Buffer, meta: Record<string, string>) {
    this.calls.put++;
    if (this.down) throw this.down;
    this.objects.set(`${bucket}/${key}`, { body: Buffer.from(body), meta });
  }
  async get(bucket: string, key: string) {
    this.calls.get++;
    if (this.down) throw this.down;
    return this.objects.get(`${bucket}/${key}`)?.body ?? null;
  }
}

let dir: string;
let s3: FakeS3;
const tiered = (rename?: (a: string, b: string) => void) => new TieredBlobStore(dir, s3, { bucket: BUCKET, prefix: "blobs/", key: KEY, rename });
const plain = Buffer.from("%PDF-1.7 синтетический лист ПД");
const h = sha(plain);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t129-blobs-"));
  s3 = new FakeS3();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("L1 · fs", () => {
  it("put/get/exists/verify/localPath; повторный put не трогает файл", async () => {
    const st = new FsBlobStore(dir);
    expect(st.kind).toBe("fs");
    expect(await st.exists(h)).toBe(false);
    expect(await st.verify(h)).toBe(false);
    await st.put(h, plain);
    expect(await st.exists(h)).toBe(true);
    expect(await st.verify(h)).toBe(true);
    expect(await st.get(h)).toEqual(plain);
    expect(await st.localPath(h)).toBe(join(dir, h));
    writeFileSync(join(dir, h), "испорчено");
    await st.put(h, plain); // существующий не перезаписывается
    expect(readFileSync(join(dir, h), "utf8")).toBe("испорчено");
    expect(await st.verify(h)).toBe(false);
    await expect(st.get(h)).rejects.toMatchObject({ name: "BlobIntegrityError", status: 500, message: `файл ${h} не прошёл проверку целостности: SHA-256 файла на диске не совпал` });
    expect(readdirSync(dir)).toEqual([h]); // временных файлов не осталось
  });
  it("нет файла — BlobNotFound (404); put с чужим sha и невалидный sha — ошибка", async () => {
    const st = new FsBlobStore(dir);
    await expect(st.get(h)).rejects.toMatchObject({ name: "BlobNotFound", status: 404, message: `файл ${h} не найден в хранилище` });
    await expect(st.localPath(h)).rejects.toBeInstanceOf(BlobNotFound);
    await expect(st.put("b".repeat(64), plain)).rejects.toThrow(/не совпадает с SHA-256/);
    await expect(st.put("../etc", plain)).rejects.toThrow(/64 строчных/);
    await expect(st.exists("../etc")).rejects.toThrow(/64 строчных/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("L1 · tiered", () => {
  it("put шифрует в бакет под blobs/<sha> с метаданными sha256 и кладёт открытый текст в кэш", async () => {
    const st = tiered();
    expect(st.kind).toBe("s3");
    await st.put(h, plain);
    const obj = s3.objects.get(`${BUCKET}/blobs/${h}`)!;
    expect(obj.meta).toEqual({ sha256: h });
    expect(obj.body.includes(plain)).toBe(false); // в бакете шифротекст
    expect(obj.body.length).toBe(plain.length + 28);
    expect(readFileSync(join(dir, h))).toEqual(plain);
    expect(await st.exists(h)).toBe(true);
    expect(await st.verify(h)).toBe(true);
    expect(await st.get(h)).toEqual(plain);
    expect(s3.calls.get).toBe(0); // из кэша
  });
  it("объект не перезаписывается: второй put — только HEAD, без PutObject", async () => {
    const st = tiered();
    await st.put(h, plain);
    const before = s3.objects.get(`${BUCKET}/blobs/${h}`)!.body;
    await st.put(h, plain);
    rmSync(join(dir, h));
    await st.put(h, plain); // кэш пуст, но объект есть — всё равно без PutObject
    expect(s3.calls.put).toBe(1);
    expect(s3.objects.get(`${BUCKET}/blobs/${h}`)!.body).toBe(before);
    expect(readFileSync(join(dir, h))).toEqual(plain);
  });
  it("промах кэша: get и localPath поднимают из S3, расшифровывают и кэшируют", async () => {
    const st = tiered();
    await st.put(h, plain);
    rmSync(join(dir, h));
    expect(await st.get(h)).toEqual(plain);
    expect(s3.calls.get).toBe(1);
    expect(readFileSync(join(dir, h))).toEqual(plain);
    rmSync(join(dir, h));
    expect(await st.localPath(h)).toBe(join(dir, h));
    expect(readFileSync(join(dir, h))).toEqual(plain);
    expect(await st.localPath(h)).toBe(join(dir, h));
    expect(s3.calls.get).toBe(2); // второй localPath — из кэша
  });
  it("испорченный кэш не отдаётся: get и localPath перезаписывают его проверенной копией из S3", async () => {
    const st = tiered();
    await st.put(h, plain);
    writeFileSync(join(dir, h), "мусор");
    expect(await st.verify(h)).toBe(false);
    expect(await st.get(h)).toEqual(plain);
    expect(await st.verify(h)).toBe(true);
    writeFileSync(join(dir, h), "мусор");
    await st.localPath(h);
    expect(readFileSync(join(dir, h))).toEqual(plain);
  });
  it("нет ни в кэше, ни в бакете — BlobNotFound; exists/verify — false", async () => {
    const st = tiered();
    await expect(st.get(h)).rejects.toBeInstanceOf(BlobNotFound);
    await expect(st.localPath(h)).rejects.toBeInstanceOf(BlobNotFound);
    expect(await st.exists(h)).toBe(false);
    expect(await st.verify(h)).toBe(false);
    expect(existsSync(join(dir, h))).toBe(false);
  });
  it("verify: объект в бакете без локальной копии — true; метаданные с чужим sha — false; без метаданных — по наличию", async () => {
    const st = tiered();
    await st.put(h, plain);
    rmSync(join(dir, h));
    expect(await st.verify(h)).toBe(true);
    s3.objects.get(`${BUCKET}/blobs/${h}`)!.meta = { sha256: "c".repeat(64) };
    expect(await st.verify(h)).toBe(false);
    s3.objects.get(`${BUCKET}/blobs/${h}`)!.meta = {};
    expect(await st.verify(h)).toBe(true);
  });
  it("put с чужим или невалидным sha — ошибка до S3; get по невалидному sha — ошибка до диска", async () => {
    const st = tiered();
    await expect(st.put("b".repeat(64), plain)).rejects.toThrow(/не совпадает с SHA-256/);
    await expect(st.get("../etc/passwd")).rejects.toThrow(/^ждём SHA-256 — 64 строчных шестнадцатеричных символа$/);
    await expect(st.localPath("../x")).rejects.toThrow(/^ждём SHA-256/);
    expect(s3.calls).toEqual({ head: 0, put: 0, get: 0 });
  });
  it("put заменяет испорченную локальную копию проверенным содержимым", async () => {
    const st = tiered();
    await st.put(h, plain);
    writeFileSync(join(dir, h), "мусор");
    await st.put(h, plain);
    expect(readFileSync(join(dir, h))).toEqual(plain);
    expect(s3.calls.put).toBe(1);
  });
  it("префикс из опций: пустой — корень бакета", async () => {
    const st = new TieredBlobStore(dir, s3, { bucket: BUCKET, prefix: "", key: KEY });
    await st.put(h, plain);
    expect([...s3.objects.keys()]).toEqual([`${BUCKET}/${h}`]);
  });
});

describe("L4 · отказы", () => {
  it("S3 недоступен на put — BlobStoreUnavailable(503), кэш не создан", async () => {
    const st = tiered();
    s3.down = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443 secret=XYZ"), { name: "ECONNREFUSED" });
    const e = await st.put(h, plain).catch((x) => x);
    expect(e).toBeInstanceOf(BlobStoreUnavailable);
    expect(e.status).toBe(503);
    expect(e.message).toBe("объектное хранилище недоступно (HEAD): ECONNREFUSED");
    expect(e.message).not.toContain("XYZ"); // текст исходной ошибки наружу не уходит
    expect(readdirSync(dir)).toEqual([]);
  });
  it("HEAD прошёл, PutObject упал (5xx) — 503 с HTTP-кодом, кэш не создан", async () => {
    const st = tiered();
    s3.put = async () => {
      throw Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } });
    };
    await expect(st.put(h, plain)).rejects.toThrow("объектное хранилище недоступно (PUT): InternalError, HTTP 500");
    expect(readdirSync(dir)).toEqual([]);
  });
  it("S3 недоступен на exists/verify/get при промахе кэша — 503", async () => {
    const st = tiered();
    s3.down = new Error("x");
    await expect(st.exists(h)).rejects.toMatchObject({ status: 503, message: "объектное хранилище недоступно (HEAD): Error" });
    await expect(st.verify(h)).rejects.toMatchObject({ name: "BlobStoreUnavailable", message: "объектное хранилище недоступно (HEAD): Error" });
    await expect(st.get(h)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("(GET)") });
    await expect(st.localPath(h)).rejects.toBeInstanceOf(BlobStoreUnavailable);
  });
  it("S3 недоступен, но файл в кэше цел — get и localPath работают без S3", async () => {
    const st = tiered();
    await st.put(h, plain);
    s3.down = new Error("x");
    expect(await st.get(h)).toEqual(plain);
    expect(await st.localPath(h)).toBe(join(dir, h));
  });
  it("причина без секретов: 403 и ошибки ключей — «доступ запрещён»", () => {
    expect(s3Reason({ name: "Forbidden", $metadata: { httpStatusCode: 403 } })).toBe("Forbidden: доступ запрещён — проверьте ключи и права на бакет");
    for (const name of ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"]) expect(s3Reason({ name })).toMatch(/доступ запрещён/);
    expect(s3Reason({ name: "SlowDown", $metadata: { httpStatusCode: 503 } })).toBe("SlowDown, HTTP 503");
    expect(s3Reason({ name: "TimeoutError", $metadata: {} })).toBe("TimeoutError");
    expect(s3Reason(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe("Error (ECONNREFUSED)");
    expect(s3Reason({ name: "X", code: "произвольный текст с секретом" })).toBe("X");
    expect(s3Reason({ name: "X", code: 42 })).toBe("X");
    expect(s3Reason({ name: "X", code: "ECONNREFUSED secret" })).toBe("X");
    expect(s3Reason({ name: "X", code: "secretECONNREFUSED" })).toBe("X");
    expect(s3Reason(undefined)).toBe("Error");
    expect(s3Reason({})).toBe("Error");
    expect(s3Reason("строка")).toBe("Error");
  });
  it("S3 отдал испорченный объект — BlobIntegrityError, в кэш не записано", async () => {
    const st = tiered();
    await st.put(h, plain);
    rmSync(join(dir, h));
    const obj = s3.objects.get(`${BUCKET}/blobs/${h}`)!;
    obj.body[obj.body.length - 1] ^= 1;
    const e = await st.get(h).catch((x) => x);
    expect(e).toBeInstanceOf(BlobIntegrityError);
    expect(e.message).toMatch(/тег GCM не сошёлся/);
    expect(readdirSync(dir)).toEqual([]);
    await expect(st.localPath(h)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("объект зашифрован другим ключом — отказ", async () => {
    await tiered().put(h, plain);
    rmSync(join(dir, h));
    const other = new TieredBlobStore(dir, s3, { bucket: BUCKET, prefix: "blobs/", key: Buffer.alloc(32, 9) });
    await expect(other.get(h)).rejects.toThrow(/другим ключом/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("сбой между записью tmp и rename не оставляет битого файла под именем sha (fs и tiered)", async () => {
    const boom = () => {
      throw new Error("диск отвалился");
    };
    await expect(new FsBlobStore(dir, boom).put(h, plain)).rejects.toThrow("диск отвалился");
    expect(readdirSync(dir)).toEqual([]);
    const st = tiered(boom);
    await expect(st.put(h, plain)).rejects.toThrow("диск отвалился");
    expect(readdirSync(dir)).toEqual([]);
    expect(s3.objects.size).toBe(1); // копия в бакете уже есть — кэш поднимется при следующем чтении
    await expect(st.get(h)).rejects.toThrow("диск отвалился");
    expect(readdirSync(dir)).toEqual([]);
    expect(await tiered().get(h)).toEqual(plain);
  });
  it("atomicWrite создаёт каталог и заменяет существующий файл целиком", () => {
    const sub = join(dir, "a", "b");
    atomicWrite(sub, "f", Buffer.from("1"));
    atomicWrite(sub, "f", Buffer.from("22"));
    expect(readFileSync(join(sub, "f"), "utf8")).toBe("22");
    expect(readdirSync(sub)).toEqual(["f"]);
  });
});

describe("L6 · подмена объекта в бакете", () => {
  it("чужое содержимое, честно зашифрованное нашим ключом, — отказ по SHA-256", async () => {
    const st = tiered();
    await st.put(h, plain);
    rmSync(join(dir, h));
    s3.objects.get(`${BUCKET}/blobs/${h}`)!.body = encryptBlob(KEY, Buffer.from("подменённый лист"));
    await expect(st.get(h)).rejects.toThrow(`файл ${h} не прошёл проверку целостности: SHA-256 открытого текста не совпал с ключом объекта`);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("открытый текст вместо шифротекста — отказ", async () => {
    await tiered().put(h, plain);
    rmSync(join(dir, h));
    s3.objects.get(`${BUCKET}/blobs/${h}`)!.body = Buffer.from(plain);
    await expect(tiered().get(h)).rejects.toBeInstanceOf(BlobIntegrityError);
  });
});

describe("фабрика и синглтон", () => {
  it("fs по конфигурации; tiered — со своим адаптером S3; подмена для тестов", () => {
    expect(blobStoreFromConfig({ kind: "fs" }, dir)).toBeInstanceOf(FsBlobStore);
    const t = blobStoreFromConfig({ kind: "s3", endpoint: "http://127.0.0.1:1", region: "r", bucket: "b", prefix: "p/", forcePathStyle: true, credentials: { accessKeyId: "a", secretAccessKey: "s" }, key: KEY , requestTimeoutMs: 60_000}, dir);
    expect(t).toBeInstanceOf(TieredBlobStore);
    expect(t.kind).toBe("s3");
    const fake = new FsBlobStore(dir);
    setBlobStoreForTests(fake);
    expect(blobStore()).toBe(fake);
    setBlobStoreForTests(null);
    expect(blobStore().kind).toBe("fs"); // окружение тестов — fs по умолчанию
    expect(blobStore()).toBe(blobStore());
  });
  it("адаптер SDK: недоступный адрес — 503 без секретов", async () => {
    const t = blobStoreFromConfig({ kind: "s3", endpoint: "http://127.0.0.1:9", region: "r", bucket: "b", prefix: "p/", forcePathStyle: true, credentials: { accessKeyId: "AKIDSECRET", secretAccessKey: "VERYSECRET" }, key: KEY , requestTimeoutMs: 60_000}, dir);
    const e = await t.exists(h).catch((x) => x);
    expect(e).toBeInstanceOf(BlobStoreUnavailable);
    expect(e.message).not.toMatch(/SECRET/);
  }, 30_000);
});

// Заглушка S3 по HTTP (path-style): настоящий SDK, настоящие коды ответа. Не MinIO — только разбор ответов адаптером.
describe("L4 · адаптер SDK на заглушке S3", () => {
  const objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
  let mode: "ok" | "403" | "500" | "404-other" = "ok";
  let server: Server;
  let endpoint = "";
  const xmlError = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>m</Message></Error>`;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers });
        const key = decodeURIComponent(req.url!.split("?")[0]);
        if (mode === "403") return res.writeHead(403, { "content-type": "application/xml" }).end(req.method === "HEAD" ? undefined : xmlError("AccessDenied"));
        if (mode === "500") return res.writeHead(500, { "content-type": "application/xml" }).end(req.method === "HEAD" ? undefined : xmlError("InternalError"));
        if (mode === "404-other") return res.writeHead(404, { "content-type": "application/xml" }).end(xmlError("NoSuchThing"));
        const o = objects.get(key);
        if (req.method === "PUT") {
          const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-amz-meta-")).map(([k, v]) => [k.slice(11), String(v)]));
          objects.set(key, { body: Buffer.concat(chunks), meta });
          return res.writeHead(200, { etag: '"e"' }).end();
        }
        if (!o) return res.writeHead(404, { "content-type": "application/xml" }).end(req.method === "HEAD" ? undefined : xmlError("NoSuchKey"));
        const headers: Record<string, string | number> = { "content-length": o.body.length, "content-type": "application/octet-stream", etag: '"e"' };
        for (const [k, v] of Object.entries(o.meta)) headers[`x-amz-meta-${k}`] = v;
        res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : o.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    mode = "ok";
    seen.length = 0;
  });
  const cfg = () => ({ kind: "s3" as const, endpoint, region: "r1", bucket: "bk", prefix: "blobs/", forcePathStyle: true, credentials: { accessKeyId: "AKIDSECRET", secretAccessKey: "VERYSECRET" }, key: KEY , requestTimeoutMs: 60_000});

  it("фабрика собирает tiered с адаптером SDK: put/exists/verify/get по кругу через HTTP", async () => {
    const st = blobStoreFromConfig(cfg(), dir);
    expect(await st.exists(h)).toBe(false);
    await st.put(h, plain);
    const obj = objects.get(`/bk/blobs/${h}`)!;
    expect(obj.meta).toEqual({ sha256: h });
    expect(obj.body.includes(plain)).toBe(false);
    const put = seen.find((r) => r.method === "PUT")!;
    expect(put.headers["content-type"]).toBe("application/octet-stream");
    // контрольные суммы — только когда обязательны: заголовков CRC32 и режима проверки нет
    expect(Object.keys(put.headers).filter((k) => k.startsWith("x-amz-checksum") || k === "x-amz-sdk-checksum-algorithm")).toEqual([]);
    expect(await st.exists(h)).toBe(true);
    expect(await st.verify(h)).toBe(true);
    rmSync(join(dir, h));
    expect(await st.get(h)).toEqual(plain);
    const get = seen.find((r) => r.method === "GET")!;
    expect(get.headers["x-amz-checksum-mode"]).toBeUndefined();
    expect(get.url.split("?")[0]).toBe(`/bk/blobs/${h}`);
  });
  it("адаптер напрямую: HEAD без метаданных — {}, нет объекта — null на HEAD и GET", async () => {
    const s = sdkS3({ endpoint, region: "r1", forcePathStyle: true, credentials: { accessKeyId: "a", secretAccessKey: "b" } });
    objects.set("/bk/plain", { body: Buffer.from("x"), meta: {} });
    expect(await s.head("bk", "plain")).toEqual({});
    expect(await s.get("bk", "plain")).toEqual(Buffer.from("x"));
    expect(await s.head("bk", "none")).toBeNull();
    expect(await s.get("bk", "none")).toBeNull();
    mode = "404-other"; // 404 с иным кодом — тоже «нет объекта»
    expect(await s.get("bk", "none")).toBeNull();
    expect(await s.head("bk", "none")).toBeNull();
  });
  it("403 — 503 «доступ запрещён» на HEAD, PUT и GET; ключи в сообщение не попадают", async () => {
    const s = sdkS3({ endpoint, region: "r1", forcePathStyle: true, credentials: { accessKeyId: "AKIDSECRET", secretAccessKey: "VERYSECRET" } });
    mode = "403";
    for (const [op, p] of [["HEAD", s.head("bk", "k")], ["PUT", s.put("bk", "k", Buffer.from("x"), {})], ["GET", s.get("bk", "k")]] as const) {
      const e = await (p as Promise<unknown>).catch((x: Error) => x) as Error;
      expect(e).toBeInstanceOf(BlobStoreUnavailable);
      expect(e.message).toMatch(new RegExp(`^объектное хранилище недоступно \\(${op}\\): .*доступ запрещён`));
      expect(e.message).not.toMatch(/SECRET/);
    }
  });
  it("5xx — 503 с HTTP-кодом на PUT и GET", async () => {
    const s = sdkS3({ endpoint, region: "r1", forcePathStyle: true, credentials: { accessKeyId: "a", secretAccessKey: "b" } });
    mode = "500";
    await expect(s.put("bk", "k", Buffer.from("x"), {})).rejects.toThrow(/^объектное хранилище недоступно \(PUT\): .*HTTP 500$/);
    await expect(s.get("bk", "k")).rejects.toThrow(/^объектное хранилище недоступно \(GET\): .*HTTP 500$/);
  }, 30_000);
});


describe("дополнительные префиксы только для чтения (T-131, демо-стенд)", () => {
  it("объект из другого префикса читается и проверяется; запись идёт только в основной", async () => {
    const other = new TieredBlobStore(join(dir, "o"), s3, { bucket: BUCKET, prefix: "demo-a/", key: KEY });
    const buf = Buffer.from("документ стенда мака");
    const sha = createHash("sha256").update(buf).digest("hex");
    await other.put(sha, buf);
    const demo = new TieredBlobStore(join(dir, "d"), s3, { bucket: BUCKET, prefix: "demo-view/", key: KEY, readPrefixes: ["blobs/", "demo-a/"] });
    expect(await demo.exists(sha)).toBe(true);
    expect(await demo.verify(sha)).toBe(true);
    expect((await demo.get(sha)).equals(buf)).toBe(true);
    const buf2 = Buffer.from("новый");
    const sha2 = createHash("sha256").update(buf2).digest("hex");
    await demo.put(sha2, buf2);
    expect([...s3.objects.keys()].filter((k) => k.includes(sha2))).toEqual([`${BUCKET}/demo-view/${sha2}`]);
    const none = new TieredBlobStore(join(dir, "n"), s3, { bucket: BUCKET, prefix: "demo-view/", key: KEY });
    expect(await none.exists(sha)).toBe(false);
  });
});
