/**
 * Отмена решения и счётчик действий (OS-INSP-4.1.15, 4.1.16; T-105 карты сценариев).
 * Отмена вместо подтверждений: любое решение до финализации возвращается в PENDING клавишей Z.
 * Счётчик — число действий инспектора от показа кандидата до решения: замер ТЗ 9.3.6 («не больше 3 кликов») по данным.
 */
import { canVerify } from "./lifecycle.ts";

export type ReopenVerdict = { ok: true } | { ok: false; status: number; error: string };

const DECIDED = new Set(["CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED"]);

/** Можно ли вернуть решённого кандидата в PENDING. */
export function reopenVerdict(s: { process: string; verification: string }): ReopenVerdict {
  if (s.process === "FINALIZED") return { ok: false, status: 409, error: "Протокол финализирован: решения неизменяемы" };
  if (!canVerify(s.process as never) && s.process !== "COMPLETED") return { ok: false, status: 409, error: `Верификация недоступна в статусе ${s.process}` };
  if (s.verification === "SPLIT") return { ok: false, status: 409, error: "Составной кандидат разделён — решайте по атомарным записям" };
  if (!DECIDED.has(s.verification)) return { ok: false, status: 409, error: "Кандидат ещё не решён — возвращать нечего" };
  return { ok: true };
}

export type ActionsSummary = { decisions: number; median: number | null; max: number | null; within3: number | null };

/** Сводка действий на решение; значения без счётчика и недостоверные (дробь, минус) не учитываются. */
export function actionsSummary(values: ReadonlyArray<number | null | undefined>): ActionsSummary {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { decisions: 0, median: null, max: null, within3: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { decisions: v.length, median, max: v[v.length - 1], within3: v.filter((x) => x <= 3).length / v.length };
}
