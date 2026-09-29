// Стенд мутаций L11 (T-179, OS-INSP-6.5.44): прогон набора генератора ml/synth/mutations.py через настоящий конвейер API —
// приём пакета с реестром (ingest), роли редакций, очередь разбора, ML /analyze по HTTP, запись извлечений, пересчёт
// протокола паспортными операторами (evaluateClassParam / evaluateQuantityParam). Ничего не подменяется: статус
// берётся из таблицы checks так же, как его видит инспектор. База — PGlite в памяти, файлы — во временном хранилище.
//
//   INSPECTOR_ML_URL=http://127.0.0.1:<порт> pnpm --filter ./apps/api exec tsx scripts/mutation-bench.ts \
//     --dataset ../../ml/var/mutations/s1 --out ../../ml/var/mutations/s1/api.json [--codes M-001,M-023] [--parallel 2]
//
// Запускает его ml/eval/mutation_run.py (он же поднимает ML-сервис). Набор — файл снаружи API: проверяется схемой
// MutationDataset, имя файла — только имя, хеш файла сверяется с заявленным до приёма.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchRow, safeFileName, type BenchCase, type BenchRow } from "../src/domain/mutation-bench.ts";

type DbT = import("../src/db.ts").DB;

export interface CaseResult {
  case_id: string;
  ms: number;
  files: Array<{ file_id: string; parse_status: string; parse_error: string | null; revision_role: string | null }>;
  rows: BenchRow[];
  extractions: Array<{ file_id: string; code: string; raw: string; value_num: number | null; value_text: string | null; page: number; bbox: unknown; anchor_bbox: unknown; line_text: string | null; confidence: number | null; excluded: string | null }>;
  error?: string;
}

const USER = { id: "u-insp", login: "inspector", name: "Стенд мутаций", role: "inspector" as const };

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // PDF примера: синтетика — десятки КБ, больше — не наш набор
export const MAX_DATASET_BYTES = 64 * 1024 * 1024;

/** Файл не больше предела — до чтения в память (OWASP T179-6). */
export function readLimited(path: string, max: number): Buffer {
  const size = statSync(path).size;
  if (size > max) throw new Error(`${path}: ${size} байт больше предела ${max}`);
  return readFileSync(path);
}

/**
 * Окружение прогона (OWASP T179-5): профиль dev, файлы — только во временном каталоге (fs), без S3 и чужой базы;
 * синтетика не уходит ни в бакет, ни в рабочее хранилище, как бы ни был настроен shell.
 */
export function benchEnv(env: NodeJS.ProcessEnv, blobDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/^INSPECTOR_/.test(k)) out[k] = v;
  return {
    ...out,
    INSPECTOR_PROFILE: "dev",
    INSPECTOR_BLOB_STORE: "fs",
    INSPECTOR_BLOB_DIR: blobDir,
    INSPECTOR_ML_URL: env.INSPECTOR_ML_URL ?? "http://127.0.0.1:9",
    INSPECTOR_DEMO_PASSWORD: "mutation-bench",
    INSPECTOR_SHEET_DIFF_AUTO: "0", // дифф листов пар редакций на статус проверки параметра не влияет (OS-INSP-3.4)
    INSPECTOR_AV: "off",
  };
}

/** Прочитать файл примера: только имя внутри каталога примера, размер в пределе, хеш — как в наборе. */
export function readCaseFile(dir: string, c: BenchCase, f: BenchCase["files"][number]): Buffer {
  const buf = readLimited(join(dir, c.case_id, safeFileName(f.file_name)), MAX_FILE_BYTES);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== f.sha256) throw new Error(`${c.case_id}/${f.file_name}: SHA-256 файла не совпадает с набором`);
  return buf;
}

/** Один пример: приём с реестром → разбор ML → пересчёт; строки проверок по кодам параметров. */
export async function runCase(db: DbT, c: BenchCase, dir: string, codes: string[], waitMs = 120_000): Promise<CaseResult> {
  const t0 = performance.now();
  const ins = await import("../src/services/inspections.ts");
  const ctx = { db, user: USER };
  const id = await ins.createInspection(ctx, { object_id: `OBJ-${c.case_id}`, name: `Мутации ${c.case_id}`, profile: c.profile });
  const items = c.files.map((f) => ({ name: f.file_name, buf: readCaseFile(dir, c, f) }));
  const manifest = {
    files: c.files.map((f) => ({
      file_id: f.file_id, file_name: f.file_name, sha256: f.sha256, doc_stage: f.doc_stage, discipline: f.discipline, document_code: f.document_code,
      revision: f.revision, approval_status: f.approval_status, approval_date: f.approval_date ?? null, predecessor_id: f.predecessor_id,
    })),
  };
  await ins.ingest(ctx, id, items, manifest);
  await ins.startProcessing(ctx, id);
  const until = Date.now() + waitMs;
  for (;;) {
    const st = (await db.get<{ status: string }>("select status from inspections where id = $1", [id]))!.status;
    if (st !== "PARSING") break;
    if (Date.now() > until) throw new Error(`${c.case_id}: разбор не закончился за ${waitMs} мс`);
    await new Promise((r) => setTimeout(r, 15));
  }
  const files = await db.all<{ id: string; client_file_id: string; parse_status: string; parse_error: string | null; revision_role: string | null }>(
    "select id, client_file_id, parse_status, parse_error, revision_role from files where inspection_id = $1 order by client_file_id", [id]);
  const fileIds = new Map(files.map((f) => [f.id, f.client_file_id]));
  const checks = await db.all<Record<string, any>>("select * from checks where inspection_id = $1 and parent_id is null and param_code in (select jsonb_array_elements_text($2::jsonb)) order by param_code", [id, JSON.stringify(codes)]);
  const rows: BenchRow[] = [];
  for (const ch of checks) {
    const frags = await db.all<Record<string, any>>("select * from evidence_fragments where check_id = $1 order by id", [ch.id]);
    rows.push(benchRow(ch as never, frags as never, fileIds));
  }
  // извлечения ML, как они легли в базу API, — для меток судьи (T-156): что именно конвейер прочитал со страницы
  const ex = await db.all<Record<string, any>>(
    "select e.*, f.client_file_id from extractions e join files f on f.id = e.file_id where f.inspection_id = $1 and e.kind = 'param' and e.param_code in (select jsonb_array_elements_text($2::jsonb)) order by e.id", [id, JSON.stringify(codes)]);
  return {
    case_id: c.case_id,
    ms: Math.round(performance.now() - t0),
    extractions: ex.map((e) => ({
      file_id: e.client_file_id, code: e.param_code, raw: e.raw, value_num: e.value_num, value_text: e.value_text, page: e.page,
      bbox: e.bbox_json ? JSON.parse(e.bbox_json) : null, anchor_bbox: e.anchor_bbox_json ? JSON.parse(e.anchor_bbox_json) : null,
      line_text: e.line_text, confidence: e.confidence, excluded: e.meta_json ? (JSON.parse(e.meta_json).excluded ?? null) : null,
    })),
    files: files.map((f) => ({ file_id: f.client_file_id, parse_status: f.parse_status, parse_error: f.parse_error, revision_role: f.revision_role })),
    rows,
  };
}

/** Весь набор: одна база, по проверке на пример; parallel примеров одновременно (разбор ML — очередь API). */
export async function runBench(db: DbT, dataset: { cases: BenchCase[] }, dir: string, codes: string[], parallel = 1): Promise<CaseResult[]> {
  const out: CaseResult[] = new Array(dataset.cases.length);
  let next = 0;
  const worker = async () => {
    while (next < dataset.cases.length) {
      const i = next++;
      const c = dataset.cases[i];
      try {
        out[i] = await runCase(db, c, dir, codes);
      } catch (e: any) {
        out[i] = { case_id: c.case_id, ms: 0, files: [], rows: [], extractions: [], error: String(e?.message ?? e) }; // отказ примера — в отчёт, а не молча
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return out;
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const dir = resolve(arg("dataset") ?? "");
  const outFile = resolve(arg("out") ?? join(dir, "api.json"));
  const tmp = mkdtempSync(join(tmpdir(), "inspector-mutations-"));
  try {
    // хранилище блобов API = каталог, который читает ML (INSPECTOR_BLOB_DIR у обоих задаёт mutation_run.py); без него —
    // временный каталог прогона. Всё прочее INSPECTOR_* из shell отбрасывается (OWASP T179-5)
    const env = benchEnv(process.env, process.env.INSPECTOR_BLOB_DIR ?? join(tmp, "blobs"));
    for (const k of Object.keys(process.env)) if (/^INSPECTOR_/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    const { MutationDataset } = await import("../src/domain/mutation-bench.ts");
    const ds = MutationDataset.parse(JSON.parse(readLimited(join(dir, "dataset.json"), MAX_DATASET_BYTES).toString("utf8")));
    const codes = (arg("codes") ?? "M-001,M-002,M-003,M-004,M-005,M-023").split(",").map((s) => s.trim()).filter((s) => /^M-\d{3}$/.test(s));
    const { openDb } = await import("../src/db.ts");
    const ins = await import("../src/services/inspections.ts");
    const chunk = Math.max(1, Number(arg("chunk", "100")));
    const t0 = performance.now();
    const results: CaseResult[] = [];
    // база в памяти пересоздаётся каждые chunk примеров: PGlite растёт с числом проверок, а примеры друг от друга не зависят
    for (let i = 0; i < ds.cases.length; i += chunk) {
      const db = await openDb("memory");
      ins.resetQueueForTests(); // очередь разбора привязана к базе — новая база, новая очередь
      try {
        results.push(...(await runBench(db, { cases: ds.cases.slice(i, i + chunk) }, dir, codes, Number(arg("parallel", "1")))));
      } finally {
        await db.close();
      }
    }
    const mem = process.memoryUsage();
    writeFileSync(outFile, JSON.stringify({ schema: "inspector-mutation-results/1", dataset_version: ds.dataset_version, codes, ms: Math.round(performance.now() - t0), rss_mb: Math.round(mem.rss / 1e6), results }));
    console.log(JSON.stringify({ cases: results.length, failed: results.filter((r) => r.error).length, ms: Math.round(performance.now() - t0), out: outFile }));
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // временный каталог — при любом исходе (OWASP T179-8)
  }
  process.exit(0); // фоновые задачи (советник) не держат процесс
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) void main();
