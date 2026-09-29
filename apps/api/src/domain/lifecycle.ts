// Жизненный цикл проверки (ТЗ 9.1 «Статусы процесса», 9.3): что можно делать в каком статусе.
import { isReasonCode, type FindingStatus, type ProcessStatus, type Role, type VerificationStatus } from "./types.ts";

/** Дозагрузка (OS-INSP-1.2.7, 1.2.8): до финализации и не во время разбора. */
export function canUpload(s: ProcessStatus): boolean {
  return s === "PENDING" || s === "READY" || s === "VERIFYING" || s === "COMPLETED";
}

export function canVerify(s: ProcessStatus): boolean {
  return s === "READY" || s === "VERIFYING";
}

export interface CheckState {
  finding_status: FindingStatus;
  verification_status: VerificationStatus;
}

/** Необработанный кандидат: система нашла расхождение, инспектор ещё не решил (OS-INSP-4.3.1). */
export function isOpenCandidate(c: CheckState): boolean {
  return c.finding_status === "CANDIDATE" && c.verification_status === "PENDING";
}

export interface CriticalCheck extends CheckState {
  param_code: string;
  review_priority?: string | null;
}

/** Статусы, в которых система не вынесла вердикт сравнения (OS-INSP-4.3.5). */
const NO_VERDICT: ReadonlySet<FindingStatus> = new Set(["NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "MISSING_EVIDENCE"]);

/** OS-INSP-4.3.5: критические параметры (HIGH — «приостановка работ») без вердикта сравнения и без решения инспектора. */
export function criticalUnresolved(checks: CriticalCheck[]): string[] {
  const codes = checks
    .filter((c) => c.review_priority === "HIGH" && NO_VERDICT.has(c.finding_status) && c.verification_status === "PENDING")
    .map((c) => c.param_code);
  return [...new Set(codes)].sort();
}

export interface FinalizeVerdict {
  ok: boolean;
  reason?: string;
  code?: "CRITICAL_UNREVIEWED";
  critical?: string[];
}

/** OS-INSP-4.3.1, 4.3.5. criticalReviewed — инспектор подтвердил, что просмотрел перечень критических параметров без вердикта. */
export function canFinalize(s: ProcessStatus, checks: CheckState[], criticalReviewed = false): FinalizeVerdict {
  if (s === "FINALIZED") return { ok: false, reason: "Протокол уже финализирован" };
  if (s === "PENDING" || s === "PARSING") return { ok: false, reason: "Протокол ещё не сформирован" };
  const open = checks.filter(isOpenCandidate).length;
  if (open) return { ok: false, reason: `Остались необработанные кандидаты: ${open}` };
  const critical = criticalUnresolved(checks as CriticalCheck[]);
  if (critical.length && !criticalReviewed) {
    return { ok: false, code: "CRITICAL_UNREVIEWED", critical, reason: `Критические параметры без вердикта: ${critical.length} — просмотрите перечень и подтвердите` };
  }
  return { ok: true, critical };
}

/** Отмена финализации (OS-INSP-4.4.1): только супервизор или администратор, причина обязательна. */
export function canUnfinalize(s: ProcessStatus, role: Role, reason: string | undefined): { ok: boolean; reason?: string } {
  if (s !== "FINALIZED") return { ok: false, reason: "Протокол не финализирован" };
  if (role !== "supervisor" && role !== "admin") return { ok: false, reason: "Отмена финализации доступна супервизору или администратору" };
  if (!reason || reason.trim().length < 5) return { ok: false, reason: "Укажите причину отмены" };
  return { ok: true };
}

/** Статус процесса после решения инспектора: пока есть открытые кандидаты — VERIFYING, иначе COMPLETED. */
export function statusAfterDecision(checks: CheckState[]): ProcessStatus {
  return checks.some(isOpenCandidate) ? "VERIFYING" : "COMPLETED";
}

export type Decision =
  | { action: "confirm"; comment?: string }
  | { action: "reject"; reason_code: string; comment: string }
  | { action: "clarify"; comment?: string };

/** OS-INSP-4.1.2–4.1.4: решение → статус верификации. Отклонение без причины и комментария не принимается. */
export function applyDecision(d: Decision): { status: VerificationStatus } | { error: string } {
  if (d.action === "confirm") return { status: "CONFIRMED_VIOLATION" };
  if (d.action === "clarify") return { status: "CLARIFICATION_REQUIRED" };
  if (!d.reason_code) return { error: "Для отклонения нужен reason_code" };
  if (!isReasonCode(d.reason_code)) return { error: `Неизвестный reason_code: ${d.reason_code}` };
  if (!d.comment || !d.comment.trim()) return { error: "Для отклонения нужен комментарий" };
  return { status: "NEGATIVE_VERIFIED" };
}

/** OS-INSP-8.1.1: цвет объекта на дашборде. */
export interface DashboardCounts {
  candidates: number;
  confirmed: number;
  clarification: number;
  missing: number;
  negative: number;
  total: number;
}

/** Счётчики строки дашборда — эталон SQL-агрегата маршрута /inspections (NFR-LOAD-100: счёт в PostgreSQL, не в Node). */
export function dashboardCounts(checks: CheckState[]): DashboardCounts {
  const n = (f: (c: CheckState) => boolean) => checks.filter(f).length;
  return {
    candidates: n(isOpenCandidate),
    confirmed: n((c) => c.verification_status === "CONFIRMED_VIOLATION"),
    clarification: n((c) => c.finding_status === "CLARIFICATION_REQUIRED" || c.verification_status === "CLARIFICATION_REQUIRED"),
    missing: n((c) => c.finding_status === "MISSING_EVIDENCE"),
    negative: n((c) => c.finding_status === "NEGATIVE_VERIFIED" || c.verification_status === "NEGATIVE_VERIFIED"),
    total: checks.length,
  };
}

/** Цвет объекта по счётчикам — то же, что objectColor по строкам (OS-INSP-8.1.1); без записей — серый. */
export function colorFromCounts(c: DashboardCounts): "green" | "yellow" | "red" | "gray" {
  if (!c.total) return "gray";
  if (c.confirmed) return "red";
  if (c.candidates || c.clarification) return "yellow";
  return "green";
}

export function objectColor(checks: CheckState[]): "green" | "yellow" | "red" {
  if (checks.some((c) => c.verification_status === "CONFIRMED_VIOLATION")) return "red";
  if (checks.some((c) => isOpenCandidate(c) || c.verification_status === "CLARIFICATION_REQUIRED" || c.finding_status === "CLARIFICATION_REQUIRED")) return "yellow";
  return "green";
}
