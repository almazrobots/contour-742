// NFR-OBJSTORE, OS-INSP-1.2.28–1.2.29 (ADR-0004 п. 5, ADR-0006 п. 5): паритет адаптера S3 на настоящем S3-совместимом
// сервере (MinIO в Docker). Эшелоны qa-standard: L2 паритет. Запускается, только если задан INSPECTOR_TEST_S3_ENDPOINT
// (+ INSPECTOR_TEST_S3_BUCKET, INSPECTOR_TEST_S3_ACCESS_KEY_ID, INSPECTOR_TEST_S3_SECRET_ACCESS_KEY; необязательны
// INSPECTOR_TEST_S3_REGION, INSPECTOR_TEST_S3_FORCE_PATH_STYLE=false). Бакет создаётся, если его нет; каждый прогон пишет
// под своим префиксом. Из бакета ничего не удаляется — как и в коде.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobNotFound, BlobStoreUnavailable, sdkS3, TieredBlobStore } from "../src/services/blobstore.ts";

const endpoint = process.env.INSPECTOR_TEST_S3_ENDPOINT?.trim();
const bucket = process.env.INSPECTOR_TEST_S3_BUCKET?.trim() || "inspector-test";
const region = process.env.INSPECTOR_TEST_S3_REGION?.trim() || "us-east-1";
const forcePathStyle = process.env.INSPECTOR_TEST_S3_FORCE_PATH_STYLE !== "false";
const credentials = {
  accessKeyId: process.env.INSPECTOR_TEST_S3_ACCESS_KEY_ID?.trim() ?? "",
  secretAccessKey: process.env.INSPECTOR_TEST_S3_SECRET_ACCESS_KEY?.trim() ?? "",
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!endpoint)("L2 · паритет S3-адаптера на S3-совместимом сервере", () => {
  const key = randomBytes(32);
  const prefix = `t129-test/${Date.now()}-${randomBytes(3).toString("hex")}/`;
  let dir: string;
  let raw: S3Client;
  const store = () => new TieredBlobStore(dir, sdkS3({ endpoint: endpoint!, region, forcePathStyle, credentials }), { bucket, prefix, key });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "t129-minio-"));
    raw = new S3Client({ endpoint, region, forcePathStyle, credentials });
    try {
      await raw.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await raw.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });
  afterAll(() => {
    raw?.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("put → в бакете шифротекст под <префикс><sha> с метаданными; get/exists/verify/localPath", async () => {
    const plain = Buffer.concat([Buffer.from("%PDF-1.7 синтетика "), randomBytes(200_000)]);
    const h = sha(plain);
    const st = store();
    expect(await st.exists(h)).toBe(false);
    await st.put(h, plain);
    expect(await st.exists(h)).toBe(true);
    expect(await st.verify(h)).toBe(true);
    const head = await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}${h}` }));
    expect(head.Metadata).toEqual({ sha256: h });
    expect(head.ContentLength).toBe(plain.length + 28);
    const body = Buffer.from(await (await raw.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${h}` }))).Body!.transformToByteArray());
    expect(body.includes(plain.subarray(0, 64))).toBe(false);
    // промах кэша: чистый каталог — объект поднимается из бакета
    rmSync(join(dir, h));
    expect(await st.get(h)).toEqual(plain);
    rmSync(join(dir, h));
    expect(readFileSync(await st.localPath(h))).toEqual(plain);
  });

  it("неперезапись: второй put не меняет объект (ETag тот же)", async () => {
    const plain = Buffer.from(`лист ${randomBytes(8).toString("hex")}`);
    const h = sha(plain);
    await store().put(h, plain);
    const etag1 = (await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}${h}` }))).ETag;
    rmSync(join(dir, h));
    await store().put(h, plain); // nonce случайный: перезапись дала бы другой ETag
    const etag2 = (await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}${h}` }))).ETag;
    expect(etag2).toBe(etag1);
  });

  it("нет объекта — BlobNotFound; чужие ключи — 503 без секретов", async () => {
    await expect(store().get("0".repeat(64))).rejects.toBeInstanceOf(BlobNotFound);
    const bad = new TieredBlobStore(dir, sdkS3({ endpoint: endpoint!, region, forcePathStyle, credentials: { accessKeyId: "WRONGKEYID", secretAccessKey: "WRONGSECRETVALUE" } }), { bucket, prefix, key });
    const e = await bad.exists("0".repeat(64)).catch((x) => x);
    expect(e).toBeInstanceOf(BlobStoreUnavailable);
    expect(e.status).toBe(503);
    expect(e.message).not.toMatch(/WRONGSECRETVALUE|WRONGKEYID/);
  });
});
