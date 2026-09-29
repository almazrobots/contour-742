// Бенчмарк ТЗ §11 (T-044, OS-INSP-6.5.5) на маке, профиль dev. Поднимает ML и API на портах 4982x, база и блобы —
// во временном каталоге. Меряет то, что можно честно измерить здесь; экстраполяцию помечает как экстраполяцию.
// Запуск: node scripts/bench-11.mjs [страниц_для_OCR=10]  →  var/bench-11.json и docs/qa/PERF-11.md
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root = new URL("../", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "inspector-bench-"));
const PAGES = Number(process.argv[2] ?? 10);
const P = { api: 49820, ml: 49821 };
const PASSWORD = randomBytes(9).toString("base64url");
const env = {
  ...process.env, INSPECTOR_PROFILE: "dev", INSPECTOR_DATABASE_URL: `pglite:${join(tmp, "pgdata")}`, INSPECTOR_BLOB_DIR: join(tmp, "blobs"),
  INSPECTOR_ML_CACHE: join(tmp, "ml-cache"), INSPECTOR_ML_URL: `http://127.0.0.1:${P.ml}`, INSPECTOR_RIN_URL: `http://127.0.0.1:${P.api}/mock-rin`,
  INSPECTOR_DEMO_PASSWORD: PASSWORD, PORT: String(P.api), INSPECTOR_SHEET_DIFF_AUTO: "0",
};
const API = `http://127.0.0.1:${P.api}`;
const procs = [];
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) { for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(300); } throw new Error(`не поднялся ${url}`); }
let token = "";
const api = (path, init = {}) => fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
async function waitStatus(id, want, ms = 900_000) {
  const t0 = now();
  while (now() - t0 < ms) { const s = await (await api(`/api/v1/inspection/${id}/status`)).json(); if (want.includes(s.status)) return now() - t0; await sleep(200); }
  throw new Error(`статус ${want} не достигнут за ${ms} мс`);
}
function form(dir, extra = [], card = null) {
  const f = new FormData();
  if (card) f.append("object", JSON.stringify(card));
  if (dir) {
    f.append("manifest", new Blob([readFileSync(join(dir, "manifest.json"))]), "manifest.json");
    for (const n of readdirSync(dir).filter((n) => /\.(pdf|docx|xml|xlsx|png)$/.test(n))) f.append("files", new Blob([readFileSync(join(dir, n))]), n);
  }
  for (const [name, buf] of extra) f.append("files", new Blob([buf]), name);
  return f;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const save = () => writeFileSync(join(root, "var/bench-11.json"), JSON.stringify(out, null, 1));
const out = { date: new Date().toISOString(), host: { cpu: cpus()[0].model, cores: cpus().length, ram_gb: Math.round(totalmem() / 2 ** 30) }, profile: "dev", results: {} };
try {
  procs.push(spawn(join(root, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--port", String(P.ml), "--log-level", "warning"], { cwd: join(root, "ml"), env, stdio: "ignore" }));
  procs.push(spawn("pnpm", ["--filter", "@inspector/api", "start"], { cwd: root, env, stdio: "ignore" }));
  await up(`http://127.0.0.1:${P.ml}/health`);
  await up(`${API}/health`);
  token = (await (await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password: PASSWORD }) })).json()).token;

  // TZA-11-01 загрузка, 11-04 сравнение 132 параметров: самый крупный объект фабрики v3 (все стадии)
  const v3 = join(root, "var/synth-v3");
  const obj = readdirSync(v3).filter((d) => d.startsWith("V3-")).map((d) => join(v3, d)).sort((a, b) => readdirSync(b).length - readdirSync(a).length)[0];
  const bytes = readdirSync(obj).filter((n) => /\.(pdf|docx|xml|xlsx|png)$/.test(n)).reduce((a, n) => a + statSync(join(obj, n)).size, 0);
  let t = now();
  const r1 = await api("/api/v1/documents/upload", { method: "POST", body: form(obj) });
  const up1 = await r1.json();
  if (!r1.ok || !up1.process_id) throw new Error(`загрузка отклонена ${r1.status}: ${JSON.stringify(up1).slice(0, 300)}`);
  const uploadMs = now() - t;
  const readyMs = await waitStatus(up1.process_id, ["READY"]);
  out.results["11-01_upload"] = { files: up1.accepted.length, mb: +(bytes / 2 ** 20).toFixed(2), ms: Math.round(uploadMs), mb_per_s: +((bytes / 2 ** 20) / (uploadMs / 1000)).toFixed(1), note: "10×50 МБ = 500 МБ противоречит пределу пакета 200 МБ (ТЗ 9.1) — экстраполяция на 200 МБ по измеренной скорости", extrapolated_200mb_s: +((200 / ((bytes / 2 ** 20) / (uploadMs / 1000)))).toFixed(1) };
  out.results["11-04_parse_and_compare"] = { ms_to_ready: Math.round(readyMs), note: "разбор всех файлов + сравнение 132 параметров + протокол v1" };

  // TZA-11-05 протокол JSON/PDF
  for (const fmt of ["json", "pdf"]) {
    t = now();
    const r = await api(`/api/v1/inspection/${up1.process_id}/protocol/export?format=${fmt}`);
    await r.arrayBuffer();
    out.results[`11-05_protocol_${fmt}`] = { status: r.status, ms: Math.round(now() - t) };
  }

  // TZA-11-10 p95 ответа API: 1000 запросов, параллельность 10
  const lat = [];
  const paths = [`/api/v1/inspection/${up1.process_id}/status`, `/api/v1/inspections/${up1.process_id}`, `/api/v1/inspection/${up1.process_id}/protocol`];
  let k = 0;
  await Promise.all(Array.from({ length: 10 }, async () => { while (k < 1000) { const p = paths[k++ % paths.length]; const t1 = now(); await (await api(p)).arrayBuffer(); lat.push(now() - t1); } }));
  save();
  out.results["11-10_api_latency"] = { n: lat.length, p50_ms: +pct(lat, 50).toFixed(1), p95_ms: +pct(lat, 95).toFixed(1), p99_ms: +pct(lat, 99).toFixed(1) };

  // TZA-11-09 инкрементальное обновление: дозагрузка НОВОГО файла (другой объект фабрики — другой SHA-256, разбор не из
  // кэша) в первую проверку; готово — когда появилась следующая версия протокола (ждать READY нельзя: статус уже READY)
  const other = readdirSync(v3).filter((d) => d.startsWith("V3-")).map((d) => join(v3, d)).find((d) => d !== obj);
  const late = readdirSync(other).find((n) => n.endsWith(".pdf"));
  const v0 = (await (await api(`/api/v1/inspection/${up1.process_id}/status`)).json()).protocol_version;
  t = now();
  await api("/api/v1/documents/upload", { method: "POST", body: (() => { const f = form(null, [[`late-${late}`, readFileSync(join(other, late))]]); f.append("process_id", up1.process_id); return f; })() });
  for (;;) {
    const s = await (await api(`/api/v1/inspection/${up1.process_id}/status`)).json();
    if (s.protocol_version > v0 && ["READY", "VERIFYING", "COMPLETED"].includes(s.status)) break;
    if (now() - t > 120_000) { out.results["11-09_incremental"] = { ms: null, timeout_ms: 120_000, last_status: s }; break; }
    await sleep(100);
  }
  if (!out.results["11-09_incremental"]) out.results["11-09_incremental"] = { ms: Math.round(now() - t), protocol_version: [v0, v0 + 1], note: "новый файл (другой SHA-256): разбор + пересчёт + новая версия протокола" };
  save();

  // TZA-11-02/03 OCR: скан из PAGES страниц без текстового слоя. 500 страниц 200 dpi ≈ 65 МБ — больше предела файла
  // 50 МБ (§9.1), поэтому скан режется на части по 200 страниц (≈ 26 МБ) и грузится одним пакетом
  const PART = 200;
  const scans = [];
  for (let s0 = 1; s0 <= PAGES; s0 += PART) {
    const n = Math.min(PART, PAGES - s0 + 1);
    const f = join(tmp, `scan-${s0}-${s0 + n - 1}.pdf`);
    execFileSync(join(root, "ml/.venv/bin/python"), ["-m", "synth.bench_pages", String(n), f, String(s0)], { cwd: join(root, "ml") });
    scans.push([`scan-${s0}-${s0 + n - 1}.pdf`, readFileSync(f)]);
  }
  t = now();
  const r2 = await api("/api/v1/documents/upload", { method: "POST", body: form(null, scans, { object_id: "BENCH-OCR", name: "Бенчмарк OCR" }) });
  const up2 = await r2.json();
  if (!r2.ok || !up2.process_id) throw new Error(`OCR: загрузка отклонена ${r2.status}: ${JSON.stringify(up2).slice(0, 300)}`);
  await waitStatus(up2.process_id, ["READY", "COMPLETED"]);
  const ocrMs = now() - t;
  out.results["11-02_03_ocr_files"] = scans.map(([n, b]) => ({ name: n, mb: +(b.length / 2 ** 20).toFixed(1) })); // от начала загрузки до готовности разбора
  const perPage = ocrMs / PAGES;
  out.results["11-02_03_ocr"] = { pages: PAGES, ms: Math.round(ocrMs), ms_per_page: Math.round(perPage), extrapolated_100_pages_s: +((perPage * 100) / 1000).toFixed(0), extrapolated_500_pages_s: +((perPage * 500) / 1000).toFixed(0), note: "ансамбль Tesseract (3 движка), 200 dpi; 100/500 — линейная экстраполяция, если PAGES меньше" };
  save();

  // TZA-11-01 на пределе пакета §9.1 (200 МБ): 4 DOCX по 49 МБ — синтетический акт + несжимаемая вставка в zip,
  // которую разбор DOCX не читает. Меряется приём: передача, SHA-256, антивирус, запись блобов.
  if (process.env.BENCH_BIG !== "0") {
    const big = join(tmp, "big");
    execFileSync(join(root, "ml/.venv/bin/python"), ["-c", `
import sys, os, zipfile, shutil
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for i in range(4):
    dst = os.path.join(out, f"big-{i}.docx")
    shutil.copy(src, dst)
    with zipfile.ZipFile(dst, "a", zipfile.ZIP_STORED) as z:
        z.writestr("customXml/pad.bin", os.urandom(49 * 2**20))
`, join(root, "data/synth/OBJ-POL-115/POL-ID-AOSR-1.docx"), big]);
    const files = readdirSync(big).map((n) => [n, readFileSync(join(big, n))]);
    const mb = files.reduce((a, [, b]) => a + b.length, 0) / 2 ** 20;
    t = now();
    const r = await api("/api/v1/documents/upload", { method: "POST", body: form(null, files, { object_id: "BENCH-BIG", name: "Бенчмарк крупного пакета" }) });
    const j = await r.json();
    const ms = now() - t;
    out.results["11-01_upload_big"] = { status: r.status, files: j.accepted?.length ?? 0, mb: +mb.toFixed(1), ms: Math.round(ms), mb_per_s: +(mb / (ms / 1000)).toFixed(1), note: "4×49 МБ — предел пакета 200 МБ (§9.1); 500 МБ по §11 API не принимает (413)" };
  save();
  }
} finally {
  procs.forEach((p) => p.kill());
  rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(join(root, "var/bench-11.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
