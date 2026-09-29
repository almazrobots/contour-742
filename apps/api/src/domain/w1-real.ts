// Замер W1 на реальных объектах (T-180, OS-INSP-6.5.50): вход стенда и форма результата — чистая часть.
// Объект корпуса уже лежит в хранилище под именами SHA-256 (раннер: /opt/corpus/blobs, только чтение) — файлы не
// копируются и не загружаются заново: проверка создаётся серверным импортом по хешу (T-169), реестр выводится из путей
// архива тем же deriveRegistry, что у загрузчика пакета. Прогон — scripts/w1-real-bench.ts; здесь схема, порции,
// окружение и строка проверки.
import { z } from "zod";
import { isJunk } from "./archive.ts";
import { IMPORT_MAX_FILES } from "./server-import.ts";

/** Код объекта стенда: POL-17, LOS-3A, ALT-79B, RCH-7-7 — только код, без адреса и имён. */
export const OBJECT_CODE = /^[A-Z]{2,6}(-[0-9A-Z]{1,4}){0,2}$/;

const SpecFile = z.object({
  path: z.string().min(1).max(1000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});

export const W1RealSpec = z.object({
  schema: z.literal("inspector-w1-real-spec/1"),
  object_id: z.string().regex(OBJECT_CODE),
  // OS-INSP-1.2.25: статус утверждения — только по явному подтверждению оператора, из путей не выводится
  approval: z.boolean(),
  codes: z.array(z.string().regex(/^M-\d{3}$/)).min(1).max(132),
  files: z.array(SpecFile).min(1).max(20_000),
});
export type W1RealSpec = z.infer<typeof W1RealSpec>;

/** Файлы, которые уходят в импорт: без служебного мусора архива (isJunk) и без повторов хеша (первый путь — главный). */
export function importable(files: W1RealSpec["files"]): { take: W1RealSpec["files"]; junk: number; duplicates: number } {
  const seen = new Set<string>();
  const take: W1RealSpec["files"] = [];
  let junk = 0;
  let duplicates = 0;
  for (const f of files) {
    if (isJunk(f.path)) junk++;
    else if (seen.has(f.sha256)) duplicates++;
    else {
      seen.add(f.sha256);
      take.push(f);
    }
  }
  return { take, junk, duplicates };
}

/** Порции серверного импорта: не больше IMPORT_MAX_FILES файлов в запросе (схема ImportRequest). */
export function portions<T>(xs: T[], size: number = IMPORT_MAX_FILES): T[][] {
  if (!(size >= 1)) throw new Error("размер порции ≥ 1");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Окружение прогона: профиль dev, хранилище fs = каталог блобов корпуса (только чтение на уровне монтирования), без S3,
 * без чужой базы и без судьи VLM; всё прочее INSPECTOR_* из shell отбрасывается — реальные документы не уходят ни в
 * бакет, ни в рабочее хранилище.
 */
export function realBenchEnv(env: NodeJS.ProcessEnv, blobDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/^INSPECTOR_/.test(k)) out[k] = v;
  return {
    ...out,
    INSPECTOR_PROFILE: "dev",
    INSPECTOR_BLOB_STORE: "fs",
    INSPECTOR_BLOB_DIR: blobDir,
    INSPECTOR_ML_URL: env.INSPECTOR_ML_URL ?? "http://127.0.0.1:9",
    INSPECTOR_DEMO_PASSWORD: "w1-real-bench",
    INSPECTOR_SHEET_DIFF_AUTO: "0",
    INSPECTOR_AV: "off",
  };
}

export interface RealRow {
  code: string;
  status: string;
  expected: string | null;
  actual: string | null;
  reason: string | null;
  fragments: Array<{ file_id: string; stage: string; page: number; value: string | null; kind: string }>;
}

/** Строка проверки параметра, как её видит инспектор: статус, значения и фрагменты (подробности — только на сервере). */
export function realRow(
  check: { param_code: string; finding_status: string; expected_value: string | null; actual_value: string | null; reason: string | null },
  frags: Array<{ file_id: string; stage: string; sheet_page: number; extracted_value: string | null; role_expected_actual: string }>,
  fileIds: Map<string, string>,
): RealRow {
  return {
    code: check.param_code,
    status: check.finding_status,
    expected: check.expected_value,
    actual: check.actual_value,
    reason: check.reason,
    fragments: frags.map((f) => ({ file_id: fileIds.get(f.file_id) ?? f.file_id, stage: f.stage, page: f.sheet_page, value: f.extracted_value, kind: f.role_expected_actual })),
  };
}
