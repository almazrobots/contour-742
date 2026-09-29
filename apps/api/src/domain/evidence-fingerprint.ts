/**
 * Отпечаток доказательства (OS-INSP-3.3.5, 3.3.6; T-115 плана, ноу-хау Н4 «решение переживает дозагрузку»).
 * Решение инспектора относится к конкретному доказательству: файлу (SHA-256), странице, рамке и значению.
 * После дозагрузки решение переносится, только если отпечаток пересчитанной записи тот же; иначе запись снова на оценке.
 */
import { createHash } from "node:crypto";

export interface FpFragment {
  sha256: string | null;
  page: number | null;
  bbox: number[] | null;
  value: string | null;
  role: string | null;
}

/** Рамка округляется до 0,001 листа: повторный разбор не должен ломать отпечаток дрожанием координат. */
const round = (b: number[] | null) => (b ? b.map((x) => Math.round(x * 1000) / 1000).join(",") : "—");

export function evidenceFingerprint(fragments: readonly FpFragment[]): string {
  const parts = fragments.map((f) => [f.role ?? "—", f.sha256 ?? "—", f.page ?? "—", round(f.bbox), f.value ?? "—"].join("|")).sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export type Carry = "NONE" | "CARRY" | "RESET";

/** Что делать с решением пересчитанной записи. */
export function carryDecision(a: { verification: string; prevFp: string; nextFp: string; prevStatus: string; nextStatus: string }): Carry {
  if (a.verification === "PENDING") return "NONE";
  return a.prevFp === a.nextFp && a.prevStatus === a.nextStatus ? "CARRY" : "RESET";
}
