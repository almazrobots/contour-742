// OS-INSP-1.5 Учесть согласованные изменения: реестр изменений и их приложение к карточке кандидата.
import { z } from "zod";

/** OS-INSP-1.5.1: согласованное изменение — номер, дата, затронутые параметры, документ-основание. */
export const ApprovedChangeInput = z.object({
  number: z.string().trim().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата в формате ГГГГ-ММ-ДД"),
  param_codes: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
  basis_file_id: z.string().min(1).nullable().optional(),
  description: z.string().max(2000).default(""),
});
export type ApprovedChangeInput = z.infer<typeof ApprovedChangeInput>;

export interface ApprovedChange {
  id: number;
  inspection_id: string;
  object_id: string;
  number: string;
  date: string;
  param_codes: string[];
  basis_file_id: string | null;
  basis_file_name: string | null;
  description: string;
  created_by: string;
  created_at: string;
}

/** Нормированный код параметра: регистр и пробелы не мешают сопоставлению («m-041 » = «M-041»). */
export const normCode = (c: string): string => c.trim().toUpperCase();

/** OS-INSP-3.1.9: изменения, затрагивающие параметр, — по дате, новые сверху. */
export function changesFor(paramCode: string, changes: ApprovedChange[]): ApprovedChange[] {
  const code = normCode(paramCode);
  return changes.filter((c) => c.param_codes.some((p) => normCode(p) === code)).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}
