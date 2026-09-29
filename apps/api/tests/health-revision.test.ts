// T-060, стандарт Q3: гейт запускает собранный образ и сверяет ревизию в /health с git sha сборки.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-health-"));
let app: any;

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  app = buildApp(await openDb("memory"));
});
afterAll(async () => {
  await app?.close();
  rmSync(TMP, { recursive: true, force: true });
});

it("/health отдаёт ревизию образа из INSPECTOR_REVISION; без неё — null, а не пустая строка", async () => {
  process.env.INSPECTOR_REVISION = " 96550f0 ";
  expect((await app.inject({ method: "GET", url: "/health" })).json().revision).toBe("96550f0");
  process.env.INSPECTOR_REVISION = "  ";
  expect((await app.inject({ method: "GET", url: "/health" })).json().revision).toBeNull();
  delete process.env.INSPECTOR_REVISION;
  expect((await app.inject({ method: "GET", url: "/health" })).json().revision).toBeNull();
});

it("/health показывает режим подписи УКЭП и квалифицирована ли она: dev без подписанта — off, неквалифицированная (NFR-UKEP, решение владельца 27.09)", async () => {
  expect((await app.inject({ method: "GET", url: "/health" })).json().ukep).toEqual({ mode: "off", qualified: false });
});
