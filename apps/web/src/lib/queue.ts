// Очередь верификации (OS-INSP-4.1, 4.1.17 — фильтр по параметру, T-130). Чистые функции: экран их только рисует.

export interface QueueCheck {
  id: string;
  param_code: string;
  about_param?: string | null; // параметр записи или гипотезы о нём
  finding_status: string;
  verification_status: string;
  review_priority: string;
  provenance_json?: string | null;
}

/** Параметр очереди: явный ?param=, иначе — параметр записи из ?c=, если она не кандидат (результат системы). */
export function queueParam(checks: QueueCheck[], param: string | null, cId: string | null): string | null {
  if (param) return param;
  const wanted = checks.find((c) => c.id === cId);
  return wanted && wanted.finding_status !== "CANDIDATE" ? (wanted.about_param ?? null) : null;
}

/**
 * Без параметра — все кандидаты. С параметром — результат системы по нему (даже «расхождения нет»: инспектор видит,
 * на чём он основан) и кандидаты-гипотезы о нём; посторонних параметров нет. Порядок: сам параметр → ждут решения →
 * на уточнении → решённые; внутри — риск, затем код.
 */
/** «*» — все параметры Матрицы по порядку кода (T-132): прыжок от М-001 до М-132 по ленте кодов. */
export const ALL_PARAMS = "*";

export function verifyQueue<T extends QueueCheck>(checks: T[], param: string | null): T[] {
  if (param === ALL_PARAMS)
    return checks.filter((c) => c.verification_status !== "SPLIT" && /^M-\d{3}$/.test(c.param_code)).sort((a, b) => a.param_code.localeCompare(b.param_code));
  const rank = (c: T) => (c.verification_status === "PENDING" ? 0 : c.verification_status === "CLARIFICATION_REQUIRED" ? 1 : 2);
  const pr = (c: T) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[c.review_priority as "HIGH"] ?? 3;
  const own = (c: T) => (param && c.param_code === param && c.finding_status !== "CANDIDATE" ? 0 : 1);
  return checks
    .filter((c) => c.verification_status !== "SPLIT")
    .filter((c) => (param ? c.about_param === param && (c.finding_status === "CANDIDATE" || c.param_code === param) : c.finding_status === "CANDIDATE"))
    .sort((a, b) => own(a) - own(b) || rank(a) - rank(b) || pr(a) - pr(b) || a.param_code.localeCompare(b.param_code));
}

/** Ждёт решения инспектора — только кандидат (результат системы решения не требует). */
export const pendingDecision = (c: QueueCheck) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING";

/** Параметры для фильтра: у кого есть кандидаты или разобранный результат по классу. */
export function filterableParams(checks: QueueCheck[]): string[] {
  return [...new Set(checks.filter((c) => c.about_param && (c.finding_status === "CANDIDATE" || c.provenance_json)).map((c) => c.about_param as string))].sort();
}
