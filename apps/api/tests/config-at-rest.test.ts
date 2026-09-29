// NFR-CRYPTO (ТЗ 12.3-01): громкая проверка ключа хранения при старте. Эшелоны: L7 (fail-closed в профиле gpu,
// секрет не в тексте ошибки и не в JSON конфигурации), L3 (границы вместимости рабочего каталога ML).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "t137-config-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const p = join(TMP, name);
  writeFileSync(p, text);
  return p;
};
const KEY = file("blob.key", "11".repeat(32) + "\n");

// Базовое окружение профиля gpu: остальные обязательные параметры (TLS, очередь, антивирус) проверяются в своих тестах
const load = (env: Record<string, string>, script = "await import('./src/config.ts')") =>
  spawnSync(process.execPath, ["-e", script], {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env, INSPECTOR_DEMO_PASSWORD: "x", INSPECTOR_AV: "clamd", INSPECTOR_RIN_URL: "https://rin.test", INSPECTOR_TLS_CERT: "tests/fixtures/tls-api/cert.pem", INSPECTOR_TLS_KEY: "tests/fixtures/tls-api/key.pem",
      INSPECTOR_AMQP_URL: "amqps://rabbit:5671", INSPECTOR_ML_URL: "https://ml:8811", INSPECTOR_BLOB_KEY_FILE: "", INSPECTOR_BLOB_OLD_KEYS_FILE: "", INSPECTOR_BLOB_WORK_DIR: "", INSPECTOR_BLOB_WORK_MAX_MB: "", ...env,
    },
    encoding: "utf8",
  });
const gpu = (env: Record<string, string>) => load({ INSPECTOR_PROFILE: "gpu", ...env });
const WORK = "/dev/shm/inspector-blob-work"; // на Linux — tmpfs; на маке /proc нет, проверка tmpfs не выполняется

describe("NFR-CRYPTO: ключ хранения файлов пакета", () => {
  it("профиль gpu без INSPECTOR_BLOB_KEY_FILE не стартует (fail-closed)", () => {
    const r = gpu({});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("профиль gpu требует INSPECTOR_BLOB_KEY_FILE");
  });
  it("профиль gpu с ключом и рабочим каталогом — старт; без рабочего каталога — отказ", () => {
    const ok = gpu({ INSPECTOR_BLOB_KEY_FILE: KEY, INSPECTOR_BLOB_WORK_DIR: WORK });
    expect(ok.status, ok.stderr).toBe(0);
    expect(gpu({ INSPECTOR_BLOB_KEY_FILE: KEY }).stderr).toContain("требует INSPECTOR_BLOB_WORK_DIR");
  });
  it("dev без ключа — старт, шифрования нет; dev с ключом — рабочий каталог по умолчанию var/blob-work", () => {
    const script = "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ on: config.blobAtRest.keyring !== null, work: config.blobAtRest.workDir }))";
    const off = load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off" }, script);
    expect(off.status, off.stderr).toBe(0);
    expect(JSON.parse(off.stdout)).toEqual({ on: false, work: null });
    const on = JSON.parse(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_BLOB_KEY_FILE: KEY }, script).stdout);
    expect(on.on).toBe(true);
    expect(on.work).toMatch(/var\/blob-work$/);
  });
  it("файла ключа нет или ключ не 32 байта — отказ с именем переменной, без содержимого ключа", () => {
    expect(gpu({ INSPECTOR_BLOB_KEY_FILE: join(TMP, "нет"), INSPECTOR_BLOB_WORK_DIR: WORK }).stderr).toContain("INSPECTOR_BLOB_KEY_FILE=");
    const secret = "ab".repeat(20);
    const r = gpu({ INSPECTOR_BLOB_KEY_FILE: file("short.key", secret), INSPECTOR_BLOB_WORK_DIR: WORK });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("INSPECTOR_BLOB_KEY_FILE=");
    expect(r.stderr).not.toContain(secret);
  });
  it("старые ключи: без текущего — отказ; битая строка — отказ с номером строки; пустой файл — допустим", () => {
    const old = file("old.keys", "# до ротации\n" + "22".repeat(32) + "\n");
    expect(load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_BLOB_OLD_KEYS_FILE: old }).stderr).toContain("без INSPECTOR_BLOB_KEY_FILE");
    expect(gpu({ INSPECTOR_BLOB_KEY_FILE: KEY, INSPECTOR_BLOB_WORK_DIR: WORK, INSPECTOR_BLOB_OLD_KEYS_FILE: old }).status).toBe(0);
    expect(gpu({ INSPECTOR_BLOB_KEY_FILE: KEY, INSPECTOR_BLOB_WORK_DIR: WORK, INSPECTOR_BLOB_OLD_KEYS_FILE: file("bad.keys", "22".repeat(32) + "\nxyz\n") }).stderr).toContain("строка 2");
    expect(gpu({ INSPECTOR_BLOB_KEY_FILE: KEY, INSPECTOR_BLOB_WORK_DIR: WORK, INSPECTOR_BLOB_OLD_KEYS_FILE: file("empty.keys", "") }).status).toBe(0);
  });
  it("связка ключей не попадает в JSON конфигурации (логи, отладочный вывод)", () => {
    const r = load({ INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off", INSPECTOR_BLOB_KEY_FILE: KEY }, "const { config } = await import('./src/config.ts'); console.log(JSON.stringify(config))");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("keyring");
    expect(r.stdout).not.toContain(Buffer.from("11".repeat(32), "hex").toString("base64"));
  });
  it("L3: вместимость рабочего каталога — целое ≥ 64 МБ", () => {
    const base = { INSPECTOR_PROFILE: "dev", INSPECTOR_AV: "off" };
    expect(load({ ...base, INSPECTOR_BLOB_WORK_MAX_MB: "63" }).stderr).toContain("INSPECTOR_BLOB_WORK_MAX_MB=63");
    expect(load({ ...base, INSPECTOR_BLOB_WORK_MAX_MB: "64" }).status).toBe(0);
    expect(load({ ...base, INSPECTOR_BLOB_WORK_MAX_MB: "1.5" }).status).not.toBe(0);
  });
});
