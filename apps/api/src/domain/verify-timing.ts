// NFR-VERIFY-30 (ТЗ 9.3.6): замер цикла верификации протокола по журналу аудита — чистые функции, без IO.
// ТЗ: «полный цикл верификации протокола (132 параметра, 14 нарушений) ≤ 30 минут у опытного пользователя»,
// приёмка — замер на 5 инспекторах. Цифру дают люди; здесь — только инструмент, который её считает.

/** Цель ТЗ 9.3.6 по wall-clock, минут. */
export const TARGET_MINUTES = 30;
/** Приёмка ТЗ 9.3.6: замер на 5 инспекторах. */
export const MIN_PARTICIPANTS = 5;
/**
 * ДОПУЩЕНИЕ (не из ТЗ): пауза между соседними событиями длиннее порога — простой (обед, звонок),
 * в «активное» время не входит. 10 минут выбраны как верхняя граница разбора одного сложного
 * кандидата; порог — параметр, итоговую цифру приёмки даёт wall-clock, активное время — справочно.
 */
export const DEFAULT_IDLE_MINUTES = 10;

export const OPEN_ACTION = "VERIFICATION_OPENED";
export const FINALIZE_ACTION = "PROTOCOL_FINALIZED";
export const SPLIT_ACTION = "CANDIDATE_SPLIT";
const DECISION_PREFIX = "DECISION_";

/** Событие аудита одной проверки (audit_log: user_id, action, object_id, timestamp). */
export type TimingEvent = { user_id: string | null; action: string; object_id?: string | null; timestamp: string };

export type StartSource = "VERIFICATION_OPENED" | "FIRST_DECISION";

export type VerifyCycle = {
  user_id: string | null;
  start_source: StartSource | null;
  started_at: string | null;
  finished_at: string | null;
  completed: boolean;
  wall_minutes: number | null;
  active_minutes: number | null;
  decisions: number;
  candidates: number;
  confirmed: number;
  splits: number;
  /** null — цикл не завершён или не начат: ни в цель, ни мимо цели. */
  within_target: boolean | null;
};

const MIN = 60_000;
const round2 = (x: number) => Math.round(x * 100) / 100;
const isDecision = (a: string) => a.startsWith(DECISION_PREFIX);

/**
 * Цикл одной проверки. Начало — первое VERIFICATION_OPENED; нет его (журнал до появления события)
 * или решение раньше него — первое решение, `start_source = FIRST_DECISION` (ДОПУЩЕНИЕ: берём более
 * раннее из двух, чтобы замер не занижал время). Конец — первая финализация не раньше начала;
 * нет — цикл незавершён, время считается до последнего события. События вне [начало, конец] не входят.
 * Результат не зависит от порядка событий на входе.
 */
export function cycleOf(events: TimingEvent[], opts: { idleMinutes?: number } = {}): VerifyCycle {
  const idleMs = (opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * MIN;
  const evs = events
    .map((e) => ({ ...e, t: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t || a.action.localeCompare(b.action) || String(a.object_id ?? "").localeCompare(String(b.object_id ?? "")));

  const firstOpen = evs.find((e) => e.action === OPEN_ACTION);
  const firstDecision = evs.find((e) => isDecision(e.action));
  const start = firstOpen && (!firstDecision || firstOpen.t <= firstDecision.t) ? firstOpen : firstDecision;
  const empty: VerifyCycle = {
    user_id: null, start_source: null, started_at: null, finished_at: null, completed: false,
    wall_minutes: null, active_minutes: null, decisions: 0, candidates: 0, confirmed: 0, splits: 0, within_target: null,
  };
  if (!start) return empty;

  const finish = evs.find((e) => e.action === FINALIZE_ACTION && e.t >= start.t);
  const inCycle = evs.filter((e) => e.t >= start.t && (!finish || e.t <= finish.t));
  const endT = finish ? finish.t : inCycle[inCycle.length - 1].t;

  let activeMs = 0;
  for (let i = 1; i < inCycle.length; i++) {
    const gap = inCycle[i].t - inCycle[i - 1].t;
    if (gap <= idleMs) activeMs += gap;
  }
  const decisions = inCycle.filter((e) => isDecision(e.action));
  const wallMs = endT - start.t;
  return {
    user_id: start.user_id,
    start_source: start === firstOpen ? "VERIFICATION_OPENED" : "FIRST_DECISION",
    started_at: new Date(start.t).toISOString(),
    finished_at: finish ? new Date(finish.t).toISOString() : null,
    completed: Boolean(finish),
    wall_minutes: round2(wallMs / MIN),
    active_minutes: round2(activeMs / MIN),
    decisions: decisions.length,
    candidates: new Set(decisions.map((e) => e.object_id ?? "")).size,
    confirmed: decisions.filter((e) => e.action === "DECISION_CONFIRM").length,
    splits: inCycle.filter((e) => e.action === SPLIT_ACTION).length,
    // Сравнение в миллисекундах, не по округлённым минутам: 30:00 — в цели, 30:01 — нет
    within_target: finish ? wallMs <= TARGET_MINUTES * MIN : null,
  };
}

export type Verdict = "CONFIRMED" | "NOT_CONFIRMED" | "INSUFFICIENT_PARTICIPANTS";

export type TimingSummary = {
  target_minutes: number;
  min_participants: number;
  cycles_total: number;
  cycles_completed: number;
  participants: number;
  enough_participants: boolean;
  median_wall_minutes: number | null;
  max_wall_minutes: number | null;
  median_active_minutes: number | null;
  within_target_share: number | null;
  verdict: Verdict;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

/**
 * Сводка по циклам. Участники — разные user_id среди завершённых циклов. ДОПУЩЕНИЕ о вердикте:
 * цель подтверждена, только если участников ≥ 5 и КАЖДЫЙ завершённый цикл ≤ 30 мин (ТЗ говорит
 * о каждом опытном пользователе, а не о медиане); медиана и доля в цели — для доработки.
 */
export function summarize(cycles: VerifyCycle[]): TimingSummary {
  const done = cycles.filter((c) => c.completed && c.wall_minutes !== null);
  const participants = new Set(done.map((c) => c.user_id ?? "")).size;
  const enough = participants >= MIN_PARTICIPANTS;
  const inTarget = done.filter((c) => c.within_target).length;
  const share = done.length ? round2(inTarget / done.length) : null;
  return {
    target_minutes: TARGET_MINUTES,
    min_participants: MIN_PARTICIPANTS,
    cycles_total: cycles.length,
    cycles_completed: done.length,
    participants,
    enough_participants: enough,
    median_wall_minutes: median(done.map((c) => c.wall_minutes!)),
    max_wall_minutes: done.length ? Math.max(...done.map((c) => c.wall_minutes!)) : null,
    median_active_minutes: median(done.map((c) => c.active_minutes!)),
    within_target_share: share,
    verdict: !enough ? "INSUFFICIENT_PARTICIPANTS" : inTarget === done.length ? "CONFIRMED" : "NOT_CONFIRMED",
  };
}
