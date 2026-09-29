// Замер W1 на реальном объекте (T-180, OS-INSP-6.5.50): тот же конвейер, что у инспектора и у стенда мутаций T-179 —
// проверка, реестр из путей архива (deriveRegistry), серверный импорт по SHA-256 (файлы уже в хранилище, не копируются),
// роли редакций, очередь разбора, ML /analyze по HTTP (разбор — из кэша r4), запись извлечений, пересчёт паспортными
// операторами. Статус группы — запись checks. База — PGlite в памяти.
//
//   INSPECTOR_ML_URL=http://127.0.0.1:<порт> INSPECTOR_BLOB_DIR=/opt/corpus/blobs \
//     tsx scripts/w1-real-bench.ts --spec <run>/spec.json --out <run>/api.json [--wait-min 240]
//
// Запускает его ml/eval/w1_real.py внутри scripts/runner/w1-real.sh (корпус и кэш смонтированы только на чтение).
// Выход (api.json) содержит страницы и значения — он живёт только в каталоге прогона на сервере (права 700).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveRegistry } from "../src/domain/archive.ts";
import { importable, portions, realBenchEnv, realRow, W1RealSpec, type RealRow } from "../src/domain/w1-real.ts";

const USER = { id: "u-insp", login: "inspector", name: "Стенд W1 на объектах", role: "inspector" as const };

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const specFile = resolve(arg("spec") ?? "");
  const outFile = resolve(arg("out") ?? "api.json");
  const waitMs = Number(arg("wait-min", "240")) * 60_000;
  const blobDir = process.env.INSPECTOR_BLOB_DIR;
  if (!blobDir) throw new Error("INSPECTOR_BLOB_DIR не задан: каталог хранилища с файлами объекта");
  const env = realBenchEnv(process.env, blobDir);
  for (const k of Object.keys(process.env)) if (/^INSPECTOR_/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const spec = W1RealSpec.parse(JSON.parse(readFileSync(specFile, "utf8")));
  const { openDb } = await import("../src/db.ts");
  const ins = await import("../src/services/inspections.ts");
  const { importFiles } = await import("../src/services/server-import.ts");
  const db = await openDb("memory");
  const ctx = { db, user: USER };
  const t0 = performance.now();
  const { take, junk, duplicates } = importable(spec.files);
  const reg = deriveRegistry(take, { approval: spec.approval, object_id: spec.object_id });
  const bySha = new Map(reg.manifest.files.map((m) => [m.sha256!, m]));
  const id = await ins.createInspection(ctx, { object_id: spec.object_id, name: `W1 ${spec.object_id}` });
  const accepted: string[] = [];
  const rejected: Array<{ code: string }> = [];
  for (const part of portions(take)) {
    const files = part.map((f) => ({ sha256: f.sha256, file_name: bySha.get(f.sha256)!.file_name }));
    const manifest = { files: part.map((f) => bySha.get(f.sha256)!) };
    const r = await importFiles(ctx, { process_id: id, manifest, files, start: false });
    accepted.push(...r.accepted.map((a: { file_id: string }) => a.file_id));
    rejected.push(...r.rejected.map((x: { code: string }) => ({ code: x.code })));
  }
  const tImport = performance.now();
  if (accepted.length) await ins.startProcessing(ctx, id);
  const until = Date.now() + waitMs;
  for (;;) {
    const st = (await db.get<{ status: string }>("select status from inspections where id = $1", [id]))!.status;
    if (st !== "PARSING") break;
    if (Date.now() > until) throw new Error(`разбор не закончился за ${waitMs / 60_000} мин`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const tDone = performance.now();
  const files = await db.all<{ id: string; client_file_id: string; doc_stage: string; parse_status: string; parse_error: string | null; revision_role: string | null }>(
    "select id, client_file_id, doc_stage, parse_status, parse_error, revision_role from files where inspection_id = $1 order by client_file_id", [id]);
  const fileIds = new Map(files.map((f) => [f.id, f.client_file_id]));
  const codes = JSON.stringify(spec.codes);
  const checks = await db.all<Record<string, any>>("select * from checks where inspection_id = $1 and parent_id is null and param_code in (select jsonb_array_elements_text($2::jsonb)) order by param_code", [id, codes]);
  const rows: RealRow[] = [];
  for (const ch of checks) {
    const frags = await db.all<Record<string, any>>("select * from evidence_fragments where check_id = $1 order by id", [ch.id]);
    rows.push(realRow(ch as never, frags as never, fileIds));
  }
  const ex = await db.all<Record<string, any>>(
    "select e.*, f.client_file_id, f.sha256 as file_sha256, f.doc_stage from extractions e join files f on f.id = e.file_id where f.inspection_id = $1 and e.kind = 'param' and e.param_code in (select jsonb_array_elements_text($2::jsonb)) order by e.id", [id, codes]);
  const mem = process.memoryUsage();
  writeFileSync(outFile, JSON.stringify({
    schema: "inspector-w1-real-results/1",
    object_id: spec.object_id,
    approval: spec.approval,
    codes: spec.codes,
    counts: { files: spec.files.length, importable: take.length, junk, duplicates, accepted: accepted.length, rejected: rejected.length },
    rejected_codes: rejected.reduce<Record<string, number>>((a, x) => ((a[x.code] = (a[x.code] ?? 0) + 1), a), {}),
    ms: { import: Math.round(tImport - t0), pipeline: Math.round(tDone - tImport), total: Math.round(performance.now() - t0) },
    rss_mb: Math.round(mem.rss / 1e6),
    files: files.map((f) => ({ file_id: f.client_file_id, stage: f.doc_stage, parse_status: f.parse_status, parse_error: f.parse_error, revision_role: f.revision_role })),
    rows,
    extractions: ex.map((e) => ({
      file_id: e.client_file_id, file_sha256: e.file_sha256, stage: e.doc_stage, code: e.param_code, raw: e.raw, value_num: e.value_num, value_text: e.value_text, page: e.page,
      bbox: e.bbox_json ? JSON.parse(e.bbox_json) : null, line_text: e.line_text, confidence: e.confidence, excluded: e.meta_json ? (JSON.parse(e.meta_json).excluded ?? null) : null,
    })),
  }));
  // в stdout (журнал раннера) — только числа
  console.log(JSON.stringify({ object_id: spec.object_id, accepted: accepted.length, rejected: rejected.length, rows: rows.length, ms: Math.round(performance.now() - t0), rss_mb: Math.round(mem.rss / 1e6) }));
  await db.close();
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) void main();
