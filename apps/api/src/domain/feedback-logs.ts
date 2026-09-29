// OS-INSP-4.1.6 Журнал отклонений (Rejection_Log) и OS-INSP-4.1.7 журнал спорных случаев (Dispute_Log), ТЗ §10.
import { isReasonCode, type ReasonCode } from "./types.ts";

/** Что система выдала по записи до решения инспектора. */
export interface CheckView {
  id: string;
  inspection_id: string;
  param_code: string;
  finding_status: string; // вердикт ИИ
  reason: string | null; // обоснование системы
  from_advisor: boolean; // запись переведена из гипотезы советника (OS-INSP-3.2.7)
}

export type DecisionInput = { action: "confirm"; comment?: string } | { action: "reject"; reason_code: string; comment: string } | { action: "clarify"; comment?: string };

export interface RejectionEntry {
  check_id: string;
  inspection_id: string;
  param_code: string;
  ai_verdict: string;
  reason_code: string;
  comment: string;
  suggested_fix: string;
}

export interface DisputeEntry {
  check_id: string;
  inspection_id: string;
  param_code: string;
  kind: "CLARIFICATION" | "ADVISOR_DISAGREEMENT";
  ai_comment: string;
  inspector_comment: string;
}

/** Что поправить в системе, чтобы отклонение не повторилось: адресат правки по причине. */
export const SUGGESTED_FIX: Record<ReasonCode, string> = {
  WRONG_REVISION: "Проверить выбор актуальной редакции: реестр, predecessor_id и статус утверждения",
  APPROVED_CHANGE: "Зарегистрировать согласованное изменение в реестре изменений объекта",
  OCR_ERROR: "Отправить страницу на переразметку OCR в черновик GOLD",
  BINDING_ERROR: "Исправить якорь параметра или источник в Матрице",
  NOT_APPLICABLE: "Уточнить условие применимости параметра к объекту",
  WITHIN_TOLERANCE: "Пересмотреть порог параметра в Матрице",
};

/** Отклонение кандидата → запись журнала отклонений; для прочих решений записи нет. */
export function rejectionEntry(c: CheckView, d: DecisionInput): RejectionEntry | null {
  if (d.action !== "reject") return null;
  return {
    check_id: c.id,
    inspection_id: c.inspection_id,
    param_code: c.param_code,
    ai_verdict: c.finding_status,
    reason_code: d.reason_code,
    comment: d.comment,
    suggested_fix: isReasonCode(d.reason_code) ? SUGGESTED_FIX[d.reason_code] : "Разобрать вручную: причина вне справочника",
  };
}

/**
 * Спорный случай: инспектор просит уточнения, либо отклоняет запись, которую предложил советник.
 * Подтверждение гипотезы советника — согласие, не спор.
 */
export function disputeEntry(c: CheckView, d: DecisionInput): DisputeEntry | null {
  const kind = d.action === "clarify" ? "CLARIFICATION" : d.action === "reject" && c.from_advisor ? "ADVISOR_DISAGREEMENT" : null;
  if (!kind) return null;
  return {
    check_id: c.id,
    inspection_id: c.inspection_id,
    param_code: c.param_code,
    kind,
    ai_comment: c.reason ?? `Вердикт системы: ${c.finding_status}`,
    inspector_comment: d.comment ?? "",
  };
}

// ─────────────────────────────── ТЗ §10 Rejection_Log.retraining_status (T-234)

/**
 * Статус записи журнала отклонений для дообучения. PENDING — ждёт выпуска версии GOLD; INCLUDED — отклонение вошло
 * в выпущенную версию набора (retraining_dataset); SUPERSEDED — решение снято (возврат, новое решение, пересчёт со
 * сменой доказательства): в обучение не идёт. Из PENDING — один раз; вернуть нельзя (триггер миграции 0015).
 */
export const RETRAINING_STATUSES = ["PENDING", "INCLUDED", "SUPERSEDED"] as const;
export type RetrainingStatus = (typeof RETRAINING_STATUSES)[number];

export interface RejectionForRetraining {
  id: number;
  check_id: string;
  retraining_status: string;
}

export interface RetrainingUpdate {
  id: number;
  retraining_status: "INCLUDED";
  retraining_dataset: string;
}

/**
 * Выпуск версии GOLD (OS-INSP-6.1, T-234): записи журнала отклонений, чьё отклонение вошло в набор, получают INCLUDED
 * с версией набора. Остальные PENDING ждут следующего выпуска (проверка ещё не финализирована, нет фрагментов с
 * координатами, файл скрытого теста); SUPERSEDED и уже включённые не трогаются.
 */
export function retrainingUpdates(entries: RejectionForRetraining[], negativeFindings: ReadonlySet<string>, datasetVersion: string): RetrainingUpdate[] {
  return entries
    .filter((e) => e.retraining_status === "PENDING" && negativeFindings.has(e.check_id))
    .map((e) => ({ id: e.id, retraining_status: "INCLUDED" as const, retraining_dataset: datasetVersion }));
}

/** Сводка журнала отклонений по статусу дообучения — отчёт по дообучению (OS-INSP-6.2.1, T-234). */
export function retrainingCounts(rows: Array<{ retraining_status: string; n: number }>): Record<RetrainingStatus, number> {
  const out = { PENDING: 0, INCLUDED: 0, SUPERSEDED: 0 } as Record<RetrainingStatus, number>;
  for (const r of rows) if ((RETRAINING_STATUSES as readonly string[]).includes(r.retraining_status)) out[r.retraining_status as RetrainingStatus] += Number(r.n);
  return out;
}

// ─────────────────────────────── ТЗ §10 Dispute_Log.resolution_status, resolved_by (T-234)

/**
 * Исход спорного случая. OPEN — открыт; AI_UPHELD — права система (позиция ИИ принята); INSPECTOR_UPHELD — прав
 * инспектор; WITHDRAWN — снят без решения по существу (вопрос отпал). Закрыть можно один раз (триггер миграции 0015).
 */
export const DISPUTE_RESOLUTIONS = ["AI_UPHELD", "INSPECTOR_UPHELD", "WITHDRAWN"] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];
export type DisputeStatus = "OPEN" | DisputeResolution;

export type ResolveCheck = { ok: true } | { ok: false; status: 400 | 409; error: string };

/**
 * Можно ли закрыть спор (OS-INSP-4.1.29): только открытый; исход — из справочника; комментарий обязателен, кроме
 * снятия — он объясняет, чья позиция и почему принята (материал для дообучения).
 */
export function canResolveDispute(current: string, resolution: string, comment: string): ResolveCheck {
  if (current !== "OPEN") return { ok: false, status: 409, error: `Спор уже закрыт (${current}) — повторно закрыть нельзя` };
  if (!(DISPUTE_RESOLUTIONS as readonly string[]).includes(resolution)) return { ok: false, status: 400, error: `Неизвестный исход спора: ${resolution}` };
  if (resolution !== "WITHDRAWN" && !comment.trim()) return { ok: false, status: 400, error: "Нужен комментарий: чья позиция принята и почему" };
  return { ok: true };
}
