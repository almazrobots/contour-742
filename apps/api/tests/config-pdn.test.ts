// Эшелоны: L7 (громкая проверка окружения при старте), L3 (границы). NFR-PDN (ТЗ 12.6-01, 152-ФЗ ст. 18 ч. 5):
// в профиле gpu API не стартует, если S3-хранилище файлов вне РФ; сроки обезличивания — целые дни ≥ 1.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GPU = { INSPECTOR_PROFILE: "gpu", INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_AV: "clamd", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "tests/fixtures/tls-api/cert.pem", INSPECTOR_TLS_KEY: "tests/fixtures/tls-api/key.pem", INSPECTOR_AMQP_URL: "amqps://rabbit:5671", INSPECTOR_ML_URL: "https://ml:8811" };
const S3 = { INSPECTOR_BLOB_STORE: "s3", INSPECTOR_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", INSPECTOR_S3_KEY_FILE: "/nonexistent-pdn-key" };
const load = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["-e", "const { config } = await import('./src/config.ts'); console.log(JSON.stringify(config.pdn))"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
const LOCALIZATION = "только в РФ (152-ФЗ ст. 18 ч. 5)";

describe("локализация ПДн и сроки обезличивания в конфигурации (NFR-PDN)", () => {
  it("профиль gpu: S3 вне РФ (AWS eu-west-1) — отказ старта с именем переменной и статьёй закона", () => {
    const r = load({ ...GPU, ...S3, INSPECTOR_S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com", INSPECTOR_S3_REGION: "eu-west-1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("INSPECTOR_S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com");
    expect(r.stderr).toContain(LOCALIZATION);
  });
  it("профиль gpu: storage.yandexcloud.net и хост из INSPECTOR_PDN_RU_ENDPOINTS проходят проверку локализации", () => {
    for (const env of <Array<Record<string, string>>>[
      { INSPECTOR_S3_ENDPOINT: "https://storage.yandexcloud.net", INSPECTOR_S3_REGION: "ru-central1" },
      { INSPECTOR_S3_ENDPOINT: "https://s3.dc.local", INSPECTOR_S3_REGION: "ru-central1", INSPECTOR_PDN_RU_ENDPOINTS: "s3.dc.local" },
      { INSPECTOR_S3_ENDPOINT: "https://minio.dc.local:9000", INSPECTOR_S3_REGION: "us-east-1", INSPECTOR_PDN_RU_ENDPOINTS: "other.local, minio.dc.local" },
    ]) {
      const r = load({ ...GPU, ...S3, ...env });
      expect(r.stderr).not.toContain(LOCALIZATION);
      expect(r.stderr).toContain("файл ключа шифрования не найден"); // дальше проверки локализации — следующая проверка S3
    }
  });
  it("профиль dev (стенд разработчика) локализацию не проверяет: MinIO на localhost допустим", () => {
    const r = load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_DEMO_PASSWORD: "x", ...S3, INSPECTOR_S3_ENDPOINT: "http://127.0.0.1:9000", INSPECTOR_S3_REGION: "us-east-1" });
    expect(r.stderr).not.toContain(LOCALIZATION);
  });
  it("сроки по умолчанию — 30 и 365 дней; задаются окружением; 0 и дробное — отказ старта", () => {
    const dev = { INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_DEMO_PASSWORD: "x" };
    expect(JSON.parse(load(dev).stdout)).toEqual({ userDays: 30, auditDays: 365, ruEndpoints: [] });
    expect(JSON.parse(load({ ...dev, INSPECTOR_PDN_USER_DAYS: "7", INSPECTOR_PDN_AUDIT_DAYS: "730" }).stdout)).toMatchObject({ userDays: 7, auditDays: 730 });
    expect(load({ ...dev, INSPECTOR_PDN_USER_DAYS: "0" }).stderr).toContain("INSPECTOR_PDN_USER_DAYS=0: ждём целое число дней ≥ 1");
    expect(load({ ...dev, INSPECTOR_PDN_AUDIT_DAYS: "1.5" }).stderr).toContain("INSPECTOR_PDN_AUDIT_DAYS=1.5");
  });
});
