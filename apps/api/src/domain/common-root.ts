/**
 * Общий корень (OS-INSP-4.1.12–4.1.14; T-112 плана карты сценариев, ноу-хау Н3).
 * Инспектор снял кандидата с причиной — система предлагает ту же причину кандидатам с той же сигнатурой причины:
 * фактическое значение взято из того же документа той же редакции или с той же страницы файла.
 * Система не снимает сама: предлагает; каждое снятие записывается отдельным решением. Признание группой — никогда.
 */

export interface RootFragment {
  role_expected_actual: string | null;
  file_id: string | null;
  sheet_page: number | null;
  document_code: string | null;
  revision: string | null;
}

export interface RootCheck {
  id: string;
  param_code: string;
  finding_status: string;
  verification_status: string;
  review_priority: string | null;
  fragments: RootFragment[];
}

/** Группа не больше 20: дальше однотипность — повод пересчитать эталон, а не снимать пачкой. */
export const MAX_GROUP = 20;

/** Сигнатуры причины кандидата: документ и редакция фактического значения, страница файла. */
export function signaturesOf(c: RootCheck): string[] {
  const out = new Set<string>();
  for (const f of c.fragments) {
    if (f.role_expected_actual !== "actual") continue;
    if (f.document_code) out.add(`doc:${f.document_code}@${f.revision ?? "—"}`);
    if (f.file_id && f.sheet_page != null) out.add(`page:${f.file_id}#${f.sheet_page}`);
  }
  return [...out];
}

/** Нерешённые некритичные кандидаты этой проверки с общей сигнатурой причины. */
export function siblingsOf<T extends RootCheck>(all: readonly T[], id: string): T[] {
  const me = all.find((c) => c.id === id);
  if (!me) return [];
  const mine = new Set(signaturesOf(me));
  if (!mine.size) return [];
  return all
    .filter((c) => c.id !== id && c.finding_status === "CANDIDATE" && c.verification_status === "PENDING" && c.review_priority !== "HIGH")
    .filter((c) => signaturesOf(c).some((s) => mine.has(s)))
    .slice(0, MAX_GROUP);
}
