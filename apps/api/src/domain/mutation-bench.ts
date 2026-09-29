// Стенд мутаций L11 (T-179, каталог TO-BE §15, OS-INSP-6.5.44): вход генератора ml/synth/mutations.py и форма результата.
// Набор мутаций — файл снаружи API: до чтения PDF он проверяется схемой, имя файла — только имя (без каталогов), размер
// ограничен. Прогон — scripts/mutation-bench.ts через настоящие ingest → разбор ML → пересчёт; здесь только чистая часть.
import { z } from "zod";

/** Имя файла набора — только имя: ни каталогов, ни «..». Путь строится от каталога примера. */
export function safeFileName(name: string): string {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw new Error(`имя файла набора недопустимо: ${JSON.stringify(name)}`);
  return name;
}

const FileName = z.string().min(1).max(200).refine((s) => {
  try {
    safeFileName(s);
    return true;
  } catch {
    return false;
  }
}, "имя файла — без каталогов");

const BenchFile = z.object({
  file_id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
  file_name: FileName,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  doc_stage: z.enum(["PD", "RD", "ID"]),
  discipline: z.string().min(1).max(20),
  document_code: z.string().min(1).max(120),
  revision: z.string().min(1).max(20),
  approval_status: z.enum(["DRAFT", "APPROVED", "FOR_CONSTRUCTION", "SUPERSEDED", "CANCELLED"]).nullable(),
  approval_date: z.string().max(20).nullable().optional(),
  predecessor_id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/).nullable(),
});

const BenchCase = z.object({
  case_id: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
  profile: z.record(z.string().max(40), z.boolean()),
  files: z.array(BenchFile).min(1).max(8),
});

export const MutationDataset = z.object({
  schema: z.literal("inspector-mutations/1"),
  dataset_version: z.string().max(200),
  cases: z.array(BenchCase).max(5000),
});
export type MutationDataset = z.infer<typeof MutationDataset>;
export type BenchCase = z.infer<typeof BenchCase>;

export interface BenchFragment {
  file_id: string;
  stage: string;
  document_code: string;
  page: number;
  bbox: [number, number, number, number] | null;
  value: string | null;
  kind: string;
}

export interface BenchRow {
  code: string;
  status: string;
  expected: string | null;
  actual: string | null;
  delta: string | null;
  reason: string | null;
  fragments: BenchFragment[];
}

/**
 * Строка результата по параметру: запись проверки и её фрагменты из базы API. Идентификатор файла API переводится
 * в идентификатор генератора (fileIds), чтобы стенд сравнил доказательство с истиной; неизвестный — остаётся как есть.
 */
export function benchRow(
  check: { param_code: string; finding_status: string; expected_value: string | null; actual_value: string | null; delta: string | null; reason: string | null },
  frags: Array<{ file_id: string; stage: string; document_code: string; sheet_page: number; bbox_polygon_norm: string | null; extracted_value: string | null; role_expected_actual: string }>,
  fileIds: Map<string, string>,
): BenchRow {
  return {
    code: check.param_code,
    status: check.finding_status,
    expected: check.expected_value,
    actual: check.actual_value,
    delta: check.delta,
    reason: check.reason,
    fragments: frags.map((f) => ({
      file_id: fileIds.get(f.file_id) ?? f.file_id,
      stage: f.stage,
      document_code: f.document_code,
      page: f.sheet_page,
      bbox: f.bbox_polygon_norm ? (JSON.parse(f.bbox_polygon_norm) as [number, number, number, number]) : null,
      value: f.extracted_value,
      kind: f.role_expected_actual,
    })),
  };
}
