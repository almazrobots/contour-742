// OS-INSP-6.1 Выпустить версию GOLD-набора; OS-INSP-6.3 допуск модели (ТЗ 9.4, 14).
import { createHash } from "node:crypto";

export interface GoldCandidate {
  evidence_group_id: string;
  finding_id: string;
  object_id: string;
  param_code: string;
  verification_status: string;
  reason_code: string | null;
  fragments: number; // сколько фрагментов с координатами в карточке
  expert_id: string | null;
}

export type Split = "train" | "validation" | "test";

/** Только CONFIRMED_VIOLATION (+) и NEGATIVE_VERIFIED (−) с полной карточкой доказательств (OS-INSP-6.1.1). */
export function eligible(c: GoldCandidate): boolean {
  if (c.verification_status !== "CONFIRMED_VIOLATION" && c.verification_status !== "NEGATIVE_VERIFIED") return false;
  return c.fragments > 0 && Boolean(c.expert_id);
}

/** Разбиение по object_id (OS-INSP-6.1.2): объект целиком попадает в одну выборку; детерминировано хешем. */
export function splitOf(objectId: string, seed = "v1"): Split {
  const h = createHash("sha256").update(`${seed}:${objectId}`).digest();
  const x = h.readUInt32BE(0) / 0xffffffff;
  return x < 0.7 ? "train" : x < 0.85 ? "validation" : "test";
}

export interface GoldItem extends GoldCandidate {
  gold_label: "POSITIVE" | "NEGATIVE";
  split: Split;
}

export function buildDataset(cands: GoldCandidate[], seed = "v1"): { items: GoldItem[]; hashes: Record<Split, string> } {
  const items = cands.filter(eligible).map((c) => ({
    ...c,
    gold_label: c.verification_status === "CONFIRMED_VIOLATION" ? ("POSITIVE" as const) : ("NEGATIVE" as const),
    split: splitOf(c.object_id, seed),
  }));
  const hashes = {} as Record<Split, string>;
  for (const s of ["train", "validation", "test"] as Split[]) {
    const part = items.filter((i) => i.split === s).map((i) => i.finding_id).sort();
    hashes[s] = createHash("sha256").update(JSON.stringify(part)).digest("hex");
  }
  return { items, hashes };
}

export interface ModelMetrics {
  recall_by_category: Record<string, number>;
  false_positive_rate: number;
  precision: number;
  recall: number;
  f1: number;
}

/** OS-INSP-6.3.1: падение Recall любой категории > 2 п.п. или рост FPR > 2 п.п. блокирует публикацию. */
export function publicationGate(prev: ModelMetrics | null, next: ModelMetrics): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (next.precision < 0.9) reasons.push(`Precision ${next.precision} < 0,90`);
  if (next.recall < 0.8) reasons.push(`Recall ${next.recall} < 0,80`);
  if (next.f1 < 0.85) reasons.push(`F1 ${next.f1} < 0,85`);
  if (next.false_positive_rate > 0.1) reasons.push(`FPR ${next.false_positive_rate} > 0,10`);
  if (prev) {
    for (const [cat, r] of Object.entries(prev.recall_by_category)) {
      const n = next.recall_by_category[cat];
      if (n === undefined || r - n > 0.02 + 1e-9) reasons.push(`Recall «${cat}» упал ${r} → ${n ?? "нет"}`);
    }
    if (next.false_positive_rate - prev.false_positive_rate > 0.02 + 1e-9) reasons.push(`FPR вырос ${prev.false_positive_rate} → ${next.false_positive_rate}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ─────────────────────────────── ТЗ §10 Dataset_Items (T-234): evidence_group_id, expert_id, reason_code

export interface DatasetItemRow {
  finding_id: string;
  evidence_group_id: string;
  gold_label: string;
  expert_id: string | null;
  reason_code: string | null;
  split: string;
  object_group_id: string;
}

/**
 * Годность выпущенного набора к обучению (OS-INSP-6.1.10, T-234): доказательная группа целиком в одной выборке
 * (иначе утечка между train и test), у каждой метки есть эксперт (OS-INSP-6.1.1). Пусто — набор годен.
 */
export function datasetIssues(items: DatasetItemRow[]): string[] {
  const out: string[] = [];
  const splitsOf = new Map<string, Set<string>>();
  for (const i of items) splitsOf.set(i.evidence_group_id, (splitsOf.get(i.evidence_group_id) ?? new Set()).add(i.split));
  const leaks = [...splitsOf].filter(([, s]) => s.size > 1).map(([g]) => g).sort();
  if (leaks.length) out.push(`доказательная группа в нескольких выборках: ${leaks.slice(0, 5).join(", ")}${leaks.length > 5 ? ` и ещё ${leaks.length - 5}` : ""}`);
  const noExpert = items.filter((i) => !i.expert_id).length;
  if (noExpert) out.push(`меток без эксперта: ${noExpert}`);
  return out;
}

export interface DatasetSummary {
  items: number;
  experts: number;
  evidence_groups: number;
  by_split: Record<string, number>;
  by_reason: Array<{ reason_code: string; n: number }>;
  issues: string[];
}

/** Сводка версии набора для куратора и ML-инженера: эксперты, доказательные группы, причины отрицательных меток. */
export function datasetSummary(items: DatasetItemRow[]): DatasetSummary {
  const count = <K extends string>(keys: K[]) => keys.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
  const reasons = count(items.filter((i) => i.gold_label === "NEGATIVE" && i.reason_code).map((i) => i.reason_code as string));
  return {
    items: items.length,
    experts: new Set(items.map((i) => i.expert_id).filter(Boolean)).size,
    evidence_groups: new Set(items.map((i) => i.evidence_group_id)).size,
    by_split: count(items.map((i) => i.split)),
    by_reason: Object.entries(reasons).map(([reason_code, n]) => ({ reason_code, n })).sort((a, b) => b.n - a.n || a.reason_code.localeCompare(b.reason_code)),
    issues: datasetIssues(items),
  };
}
