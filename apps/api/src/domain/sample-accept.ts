/**
 * Совпадения выборкой (кандидаты OS-INSP-4.1.8–4.1.11, T-110; карта сценариев SC-04, ноу-хау Н2).
 *
 * Системные «расхождения нет» (OS-INSP-3.1.6) инспектор не смотрит по одному: система берёт из партии случайную
 * выборку, инспектор проверяет её, и при нуле ошибок партия принимается одним действием с опубликованной верхней
 * границей доли ошибок. Хоть одна ошибка — партия распадается в обычную очередь.
 *
 * Юридическая граница: в партию попадает только то, что система и так вправе поставить сама. Признание
 * расхождения (CONFIRMED_VIOLATION) партией не существует. Критичные параметры (review_priority HIGH) и значения,
 * распознанные с уверенностью ниже 0,7, — только по одному.
 */

export interface PoolCheck {
  id: string;
  param_code: string;
  finding_status: string;
  verification_status: string;
  review_priority: string | null;
  /** файл главного источника — страта выборки: ошибки распознавания коррелированы внутри файла */
  file_id: string | null;
  /** наименьшая уверенность распознавания среди значений записи; null — значение из текстового слоя */
  min_confidence?: number | null;
}

/** Порог уверенности распознавания: ниже — запись смотрится по одному, не партией. */
export const MIN_CONFIDENCE = 0.7;

/** Партия: системные «расхождения нет» без решения человека, кроме критичных параметров. */
export function samplePool<T extends PoolCheck>(checks: readonly T[]): T[] {
  return checks.filter(
    (c) =>
      c.finding_status === "NEGATIVE_VERIFIED" &&
      c.verification_status === "PENDING" &&
      c.review_priority !== "HIGH" &&
      (c.min_confidence == null || c.min_confidence >= MIN_CONFIDENCE),
  );
}

/** mulberry32 — детерминированный генератор: выборка воспроизводится по seed из протокола. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Случайная выборка k записей, по файлам вперемешку (страты): каждый файл партии представлен, пока хватает k. */
export function drawSample<T extends PoolCheck>(pool: readonly T[], k: number, seed: number): T[] {
  const r = rng(seed);
  const shuffle = <X>(xs: X[]): X[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const strata = new Map<string, T[]>();
  for (const c of [...pool].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = c.file_id ?? "—";
    strata.set(key, [...(strata.get(key) ?? []), c]);
  }
  const lanes = shuffle([...strata.keys()]).map((k) => shuffle(strata.get(k)!));
  const out: T[] = [];
  // по кругу по файлам: первая карточка из каждого файла, затем вторая…
  for (let round = 0; out.length < Math.min(k, pool.length); round++) {
    for (const lane of lanes) if (lane[round] && out.length < k) out.push(lane[round]);
  }
  return out;
}

/** Верхняя граница доли ошибок в партии при 0 ошибок в n просмотренных, односторонняя, уверенность conf.
 *  Точная формула Клоппера — Пирсона для нуля ошибок: 1 − (1 − conf)^(1/n); при n = 30 — 9,5 % («правило трёх»). */
export function upperBound(n: number, conf = 0.95): number {
  if (n <= 0) return 1;
  return 1 - Math.pow(1 - conf, 1 / n);
}

export type AcceptOutcome =
  | { kind: "ACCEPTED"; accepted: number; bound: number }
  | { kind: "BROKEN"; errors: string[] }
  | { kind: "INCOMPLETE"; left: number }
  | { kind: "INVALID"; reason: string };

/** Исход приёмки партии по ответам инспектора на выборку. */
export function acceptOutcome(a: { poolSize: number; sample: readonly string[]; reviewed: readonly string[]; errors: readonly string[] }): AcceptOutcome {
  const inSample = new Set(a.sample);
  const stray = a.errors.filter((e) => !inSample.has(e));
  if (stray.length) return { kind: "INVALID", reason: `Ошибка отмечена в записи вне выборки: ${stray.join(", ")}` };
  if (a.errors.length) return { kind: "BROKEN", errors: [...a.errors] };
  const seen = new Set(a.reviewed.filter((r) => inSample.has(r)));
  const left = a.sample.length - seen.size;
  if (left > 0) return { kind: "INCOMPLETE", left };
  return { kind: "ACCEPTED", accepted: a.poolSize, bound: upperBound(a.sample.length) };
}
