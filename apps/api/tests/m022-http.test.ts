// T-241: настоящий HTTP API + ML, синтетические PDF, итоговые статусы и карточка.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const TMP = mkdtempSync(join(tmpdir(), "m022-http-"));
const ML_PORT = 24000 + Math.floor(Math.random() * 1000);
process.env.INSPECTOR_BLOB_DIR = join(TMP, "blobs");
process.env.INSPECTOR_ML_URL = `http://127.0.0.1:${ML_PORT}`;
process.env.INSPECTOR_DEMO_PASSWORD = "test-pass";
process.env.INSPECTOR_SHEET_DIFF_AUTO = "0";
let ml: ChildProcess;
let app: any;
let db: any;
let base: string;
let token: string;
let mlErrors = "";

async function waitFor(fn: () => Promise<boolean>, timeout = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`M-022 HTTP timeout: ${mlErrors.slice(-1500)}`);
}
const headers = () => ({ authorization: `Bearer ${token}` });
async function get(path: string) {
  const r = await fetch(base + path, { headers: headers() });
  expect(r.status).toBe(200);
  return r.json();
}

beforeAll(async () => {
  execFileSync(join(ROOT, "ml/.venv/bin/python"), ["-m", "synth.m022_quality", TMP], { cwd: join(ROOT, "ml") });
  ml = spawn(join(ROOT, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--port", String(ML_PORT), "--log-level", "warning"], {
    cwd: join(ROOT, "ml"), env: { ...process.env, INSPECTOR_ML_CACHE: join(TMP, "cache"), CUDA_VISIBLE_DEVICES: "" }, stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr!.on("data", (b) => { mlErrors = (mlErrors + b.toString()).slice(-5000); });
  await waitFor(async () => fetch(`http://127.0.0.1:${ML_PORT}/health`).then((r) => r.ok).catch(() => false));
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = await buildApp(db);
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  const auth = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password: "test-pass" }) });
  expect(auth.status).toBe(200);
  token = (await auth.json() as any).token;
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  ml?.kill();
  rmSync(TMP, { recursive: true, force: true });
});

it("M-022: PDF → HTTP upload → READY → статусы и доказательные карточки", async () => {
  const cases = JSON.parse(readFileSync(join(TMP, "cases.json"), "utf8"));
  for (const c of cases) {
    const dir = join(TMP, c.name);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const body = new FormData();
    for (const f of manifest.files) body.append("files", new Blob([readFileSync(join(dir, f.file_name))]), f.file_name);
    body.append("manifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }), "manifest.json");
    const upload = await fetch(base + "/api/v1/documents/upload", { method: "POST", headers: headers(), body });
    expect(upload.status, c.name).toBe(202);
    const id = (await upload.json() as any).process_id;
    await waitFor(async () => (await get(`/api/v1/inspection/${id}/status`)).status === "READY");
    const detail = await get(`/api/v1/inspections/${id}`);
    const check = detail.checks.find((x: any) => x.param_code === "M-022" && !x.parent_id);
    expect(check?.finding_status, `${c.name}: ${check?.reason}`).toBe(c.status);
    const fragments = await get(`/api/v1/checks/${check.id}/fragments`);
    expect(fragments.length, c.name).toBeGreaterThan(0);
    for (const f of fragments) {
      const source = detail.files.find((x: any) => x.id === f.file_id);
      expect(source, c.name).toBeTruthy();
      expect(f.sha256).toBe(source.sha256);
      const original = manifest.files.find((x: any) => x.file_id === source.client_file_id);
      expect(original, c.name).toBeTruthy();
      expect(f.sha256).toBe(createHash("sha256").update(readFileSync(join(dir, original.file_name))).digest("hex"));
      expect(f.revision).toBe("0");
      expect(f.sheet_page).toBe(1);
      const box = JSON.parse(f.bbox_polygon_norm);
      expect(box).toHaveLength(4);
      expect(box.every((v: number) => v >= 0 && v <= 1)).toBe(true);
      expect(box[2]).toBeGreaterThan(box[0]);
      expect(box[3]).toBeGreaterThan(box[1]);
    }
    const provenance = typeof check.provenance_json === "string" ? JSON.parse(check.provenance_json) : check.provenance;
    expect(provenance.mentions.length).toBeGreaterThan(0);
    expect(provenance.mentions.every((m: any) => m.quote?.includes("огнестойкости") && m.sha256?.length === 64 && m.revision === "0")).toBe(true);
    if (c.name === "subjects") expect(new Set(provenance.mentions.map((m: any) => m.subject_key))).toEqual(new Set(["building:1", "building:2"]));
    if (["CANDIDATE", "NEGATIVE_VERIFIED"].includes(c.status)) {
      expect(new Set(fragments.map((f: any) => f.stage))).toEqual(new Set(["PD", "RD"]));
      expect(check.expected_value).toBe(c.name === "decrease" ? "I" : "II");
      expect(check.actual_value).toBe(c.name === "better" ? "I" : c.name === "subjects" ? "III" : "II");
    }
    const denied = await fetch(base + `/api/v1/checks/${check.id}/fragments`);
    expect(denied.status).toBe(401);
  }
}, 180_000);
