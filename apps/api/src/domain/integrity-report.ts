// OS-INSP-1.2.31–1.2.35 (T-120): целостность пакета по реестру. Реестр организатора (document_manifest, SRC-INSP-08)
// несёт SHA-256, число страниц PDF, причину исключения и связь частей; система сверяет с ним принятое и отчитывается
// по каждому файлу реестра. Формат отчёта читает стенд — ml/eval/integrity.py (OS-INSP-6.5.12).

export type IntegrityStatus = "ACCEPTED" | "PART" | "EXCLUDED" | "DUPLICATE" | "INCOMPLETE" | "REJECTED" | "MISSING";

export interface DeclaredFile {
  file_id: string;
  file_name: string;
  sha256?: string | null;
  pdf_pages?: number | null;
  exclusion_reason?: string | null;
  part_of?: string | null;
}

export interface StoredFile {
  client_file_id: string;
  file_name: string;
  sha256: string;
  pages: number | null; // число страниц после разбора; null — ещё не разобран
  part_of: string | null;
}

export interface Rejection {
  file_name: string;
  code: string;
  message: string;
  duplicate_of?: string | null;
}

export interface IntegrityRow {
  file_id: string;
  file_name: string;
  status: IntegrityStatus;
  sha256: string | null;
  pages: number | null;
  declared_pages: number | null;
  reason: string | null;
  duplicate_of: string | null;
  part_of: string | null;
}

export interface IntegrityReport {
  files: IntegrityRow[];
  declared: number;
  share: number | null; // null — реестра нет, доля не измерена
  outside_registry: string[];
}

/** Статусы без расхождения: файл учтён так, как велит реестр. */
const CLEAN: ReadonlySet<IntegrityStatus> = new Set(["ACCEPTED", "PART", "EXCLUDED", "DUPLICATE"]);

/** OS-INSP-1.2.32: реестр исключает файл, когда называет причину. */
export function isExcluded(m: { exclusion_reason?: string | null }): boolean {
  return Boolean(m.exclusion_reason?.trim());
}

/** OS-INSP-1.2.33: принятый файл с тем же содержимым под другим file_id; повторная загрузка под тем же file_id — не дубль. */
export function duplicateOf(accepted: Array<{ client_file_id: string; sha256: string }>, fileId: string, sha256: string): string | null {
  return accepted.find((f) => f.sha256 === sha256 && f.client_file_id !== fileId)?.client_file_id ?? null;
}

/** OS-INSP-1.2.34: расхождение числа страниц — только когда известны оба числа. */
export function pagesMismatch(declared: number | null | undefined, parsed: number | null): boolean {
  return declared != null && parsed != null && declared !== parsed;
}

/** OS-INSP-1.2.35: статус каждого файла реестра и доля учтённых без расхождений. Принятый файл важнее прежнего отказа. */
export function integrityReport(declared: DeclaredFile[], stored: StoredFile[], rejections: Rejection[]): IntegrityReport {
  const byId = new Map(stored.map((f) => [f.client_file_id, f]));
  const lastRejection = new Map(rejections.map((r) => [r.file_name, r]));
  const files = declared.map((m): IntegrityRow => {
    const f = byId.get(m.file_id);
    const row: IntegrityRow = {
      file_id: m.file_id, file_name: m.file_name, status: "MISSING", sha256: f?.sha256 ?? null, pages: f?.pages ?? null,
      declared_pages: m.pdf_pages ?? null, reason: null, duplicate_of: null, part_of: f?.part_of ?? m.part_of ?? null,
    };
    if (isExcluded(m)) return { ...row, status: "EXCLUDED", reason: m.exclusion_reason!.trim() };
    if (f) {
      if (pagesMismatch(m.pdf_pages, f.pages)) return { ...row, status: "INCOMPLETE", reason: `страниц ${f.pages} из ${m.pdf_pages} по реестру` };
      return { ...row, status: f.part_of ? "PART" : "ACCEPTED" };
    }
    const rej = lastRejection.get(m.file_name);
    if (rej?.duplicate_of) return { ...row, status: "DUPLICATE", duplicate_of: rej.duplicate_of, reason: rej.message };
    if (rej) return { ...row, status: "REJECTED", reason: `${rej.code}: ${rej.message}` };
    return row;
  });
  const registered = new Set(declared.map((m) => m.file_id));
  return {
    files,
    declared: declared.length,
    share: declared.length ? files.filter((f) => CLEAN.has(f.status)).length / declared.length : null,
    outside_registry: stored.filter((f) => !registered.has(f.client_file_id)).map((f) => f.client_file_id),
  };
}
