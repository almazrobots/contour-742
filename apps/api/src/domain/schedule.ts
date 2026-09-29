// OS-INSP-6.2.2 Еженедельный отчёт по дообучению по расписанию: период — прошедшая неделя ISO (пн 00:00 — пн 00:00, UTC).

const DAY = 86400_000;

/** Начало недели ISO (понедельник 00:00 UTC), в которую попадает момент t. */
export function weekStart(t: Date): Date {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // пн = 0 … вс = 6
  return new Date(d.getTime() - dow * DAY);
}

/** Период отчёта, который должен существовать к моменту now: последняя закончившаяся неделя. */
export function duePeriod(now: Date): { since: string; until: string } {
  const until = weekStart(now);
  return { since: new Date(until.getTime() - 7 * DAY).toISOString(), until: until.toISOString() };
}

/**
 * Нужен ли запуск: отчёта за последнюю закончившуюся неделю ещё нет. Пропуск из-за простоя догоняется
 * первым же тиком после старта; повторный тик той же недели ничего не делает (идемпотентность).
 */
export function reportDue(now: Date, existingUntil: readonly string[]): { since: string; until: string } | null {
  const p = duePeriod(now);
  return existingUntil.includes(p.until) ? null : p;
}
