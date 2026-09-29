// NFR-SLA (ТЗ 11-12, TZA-11-12): доступность 99,9 % круглосуточно. Чистые формулы SLO — единый источник чисел:
// правила Prometheus deploy/gpu/rules/slo.yml сверяет с этими константами scripts/slo.test.mjs, отчёт
// scripts/availability-report.mjs импортирует этот модуль (Node снимает типы сам). Поэтому здесь — только стираемый
// синтаксис TypeScript и ни одного импорта.
// Алерты по сгоранию бюджета — multiwindow, multi-burn-rate (Google SRE Workbook, гл. 5 «Alerting on SLOs»).

/** Цель доступности: 99,9 %. */
export const SLO_TARGET = 0.999;
/** Окно SLO — скользящие 30 дней. */
export const SLO_WINDOW_SECONDS = 30 * 24 * 3600;
/** Период пробы blackbox (scrape_interval в deploy/gpu/prometheus.yml): одна проба = столько секунд наблюдения. */
export const PROBE_INTERVAL_SECONDS = 15;
/** /ready: БД и ML обязаны ответить за это время, иначе 503. Не больше 2 с. */
export const READY_TIMEOUT_MS = 2000;

export type BurnAlert = { alert: string; severity: "page" | "ticket"; factor: number; long: string; short: string; for: string };

/** ×14,4 за 1 ч (2 % бюджета за час) — будить; ×6 за 6 ч (5 % за 6 ч) — заявка. Короткое окно — 1/12 длинного. */
export const BURN_ALERTS: readonly BurnAlert[] = [
  { alert: "InspectorSloBurnFast", severity: "page", factor: 14.4, long: "1h", short: "5m", for: "2m" },
  { alert: "InspectorSloBurnSlow", severity: "ticket", factor: 6, long: "6h", short: "30m", for: "15m" },
];

function checkTarget(target: number): void {
  if (!(target > 0 && target < 1)) throw new RangeError(`цель SLO вне (0; 1): ${target}`);
}

/** Бюджет ошибок в секундах недоступности за окно: (1 − цель) × окно. */
export function errorBudget(target: number, windowSeconds: number): number {
  checkTarget(target);
  if (!(windowSeconds >= 0)) throw new RangeError(`окно SLO отрицательное: ${windowSeconds}`);
  return (1 - target) * windowSeconds;
}

/** Скорость сгорания: во сколько раз доля ошибок больше допустимой (1 − цель). 1 — бюджет кончится ровно к концу окна. */
export function burnRate(errorRatio: number, target: number): number {
  checkTarget(target);
  if (!(errorRatio >= 0 && errorRatio <= 1)) throw new RangeError(`доля ошибок вне [0; 1]: ${errorRatio}`);
  return errorRatio / (1 - target);
}

/** Доля бюджета окна, сожжённая за seconds со скоростью burn. */
export function budgetSpent(burn: number, seconds: number, windowSeconds: number): number {
  return (burn * seconds) / windowSeconds;
}

/** Доступность — доля успешных проверок. Нет измерений — null: «нет данных» не равно «100 %». */
export function availability(good: number, total: number): number | null {
  if (good < 0 || total < 0 || good > total) throw new RangeError(`успешных ${good} из ${total}`);
  return total === 0 ? null : good / total;
}

/** Остаток бюджета: 1 — не тронут, 0 — исчерпан ровно, < 0 — перерасход. */
export function budgetRemaining(avail: number | null, target: number): number | null {
  checkTarget(target);
  if (avail === null) return null;
  return 1 - (1 - avail) / (1 - target);
}

export type Verdict = { status: "met" | "breached" | "no_data"; text: string };

/** Вердикт отчёта о доступности. Ровно на цели — выполнено (ТЗ: «не менее 99,9 %»). */
export function verdict(avail: number | null, target: number): Verdict {
  checkTarget(target);
  if (avail === null) return { status: "no_data", text: "нет данных" };
  // 1e-12 — погрешность float: avg_over_time Prometheus суммирует тысячи отсчётов, «ровно 0,999» приходит как 0,99899…9
  return avail + 1e-12 >= target ? { status: "met", text: "выполнено" } : { status: "breached", text: "нарушено" };
}

export type ReadyChecks = { db: boolean; ml: boolean };
export type ReadyAnswer = { code: 200; body: { status: "ready" } } | { code: 503; body: { status: "not_ready"; failed: Array<"db" | "ml"> } };

/** /ready: 200, когда ответили и БД, и ML; иначе 503 с именами отказавших (порядок постоянный: db, ml). */
export function readiness(checks: ReadyChecks): ReadyAnswer {
  const failed = (["db", "ml"] as const).filter((k) => !checks[k]);
  return failed.length === 0 ? { code: 200, body: { status: "ready" } } : { code: 503, body: { status: "not_ready", failed } };
}
