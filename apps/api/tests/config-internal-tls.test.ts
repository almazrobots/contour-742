// Эшелоны: L7 (громкая проверка окружения при старте), L3 (границы режима). NFR-TLS-INTERNAL (ТЗ 1.3, T-129):
// в профиле gpu и на стенде (INSPECTOR_INTERNAL_TLS=required) API не стартует с открытым каналом к ML или очереди.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const load = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_BLOB_KEY_FILE: "tests/fixtures/at-rest/blob.key", INSPECTOR_BLOB_WORK_DIR: "/dev/shm/inspector-blob-work", INSPECTOR_AV: "clamd", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "tests/fixtures/tls-api/cert.pem", INSPECTOR_TLS_KEY: "tests/fixtures/tls-api/key.pem", INSPECTOR_AMQP_URL: "amqps://rabbit:5671", INSPECTOR_ML_URL: "https://ml:8811", ...env },
    encoding: "utf8",
  });

describe("внутренние каналы по TLS (NFR-TLS-INTERNAL)", () => {
  it("профиль gpu: ML по http — отказ старта с именем переменной; по https — старт", () => {
    const r = load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_ML_URL: "http://ml:8811" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("INSPECTOR_ML_URL=http://ml:8811");
    expect(load({ INSPECTOR_PROFILE: "gpu" }).status).toBe(0);
  });
  it("профиль gpu: очередь amqp:// без TLS — отказ старта; amqps:// — старт", () => {
    expect(load({ INSPECTOR_PROFILE: "gpu", INSPECTOR_AMQP_URL: "amqp://rabbit:5672" }).stderr).toContain("только по amqps://");
  });
  it("при обязательном TLS хранилище S3 по http:// — отказ старта (SEC-09)", () => {
    const r = load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_INTERNAL_TLS: "required", INSPECTOR_BLOB_STORE: "s3", INSPECTOR_S3_ENDPOINT: "http://minio:9000", INSPECTOR_S3_REGION: "r", INSPECTOR_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", INSPECTOR_S3_KEY_FILE: "/nonexistent" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("хранилище только по https://");
  });
  it("пароль брокера файлом: подставляется в адрес; пароль и в адресе, и в файле — ошибка; без пользователя — ошибка (SEC-07)", async () => {
    const { withAmqpPassword } = await import("../src/config.ts");
    expect(withAmqpPassword("amqps://inspector@rabbitmq:5671", "p@ss/w")).toBe("amqps://inspector:p%40ss%2Fw@rabbitmq:5671");
    expect(withAmqpPassword("amqps://inspector@rabbitmq:5671", null)).toBe("amqps://inspector@rabbitmq:5671");
    expect(withAmqpPassword(null, "x")).toBeNull();
    expect(() => withAmqpPassword("amqps://inspector:old@rabbitmq:5671", "new")).toThrow(/уже содержит пароль/);
    expect(() => withAmqpPassword("amqps://rabbitmq:5671", "x")).toThrow(/нужен пользователь/);
  });
  it("стенд в профиле dev с INSPECTOR_INTERNAL_TLS=required тоже требует https к ML; по умолчанию в dev — optional", () => {
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_INTERNAL_TLS: "required", INSPECTOR_ML_URL: "http://127.0.0.1:8811" }).status).not.toBe(0);
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_ML_URL: "http://127.0.0.1:8811" }).status).toBe(0);
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_INTERNAL_TLS: "sometimes" }).stderr).toContain("ждём required или optional");
  });
});
