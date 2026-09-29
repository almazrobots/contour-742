// OS-INSP-6.4 Управляемое дообучение модели ранжирования кандидатов (ТЗ §7.4, §9.4).
// Модель — L2-регуляризованная логистическая регрессия (метод Ньютона, без случайности) по признакам карточки
// кандидата; калибровка Платта и порог — на validation, метрики — только на test. Чистые функции: IO — services/retrain.ts.
import { createHash } from "node:crypto";
import type { Split } from "./gold.ts";

export const ALGORITHM = "logreg-l2-newton+platt/1";

/** Карточка кандидата — то, что видит модель. Метка и статус в признаки не входят. */
export interface CandidateCard {
  finding_id: string;
  section: string; // раздел Матрицы — категория для recall_by_category
  review_priority: string | null;
  compare_kind: string | null; // вид сравнения параметра Матрицы
  expected_value: string | null;
  actual_value: string | null;
  confidence: number | null; // средняя уверенность извлечения по фрагментам карточки
  stages: string[]; // стадии источников доказательств
  fragments: number;
}

export interface LabeledCard extends CandidateCard {
  gold_label: "POSITIVE" | "NEGATIVE";
  split: Split;
}

export interface TrainParams {
  l2: number;
  max_iter: number;
  min_recall: number; // порог выбирается при Recall на validation не ниже этого
  seed: string; // задаёт порядок строк (а значит, порядок сложения) — повтор даёт те же биты весов
}

export const DEFAULT_PARAMS: TrainParams = { l2: 1, max_iter: 50, min_recall: 0.8, seed: "v1" };

const COMPARE_KINDS = ["min", "equal", "decrease", "increase", "delta_pct"] as const;
const STAGE_CODES = ["PD", "RD", "ID"] as const;

export interface FeatureSpec {
  sections: string[];
}

export function featureNames(spec: FeatureSpec): string[] {
  return [
    "bias", "log_rel_delta", "non_numeric", "priority_high", "confidence", "no_confidence", "log_fragments",
    ...STAGE_CODES.map((s) => `stage_${s}`), ...COMPARE_KINDS.map((k) => `compare_${k}`), ...spec.sections.map((s) => `section_${s}`),
  ];
}

/** Словарь разделов — только из train: раздел, которого модель не видела, не получает веса. */
export function featureSpec(train: CandidateCard[]): FeatureSpec {
  return { sections: [...new Set(train.map((c) => c.section))].sort() };
}

function num(s: string | null): number | null {
  const m = s?.match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
}

/** |факт − ожидание| / |ожидание|; null — значения не числа. Нулевое ожидание — абсолютная разница. */
export function relDelta(expected: string | null, actual: string | null): number | null {
  const e = num(expected);
  const a = num(actual);
  if (e === null || a === null) return null;
  return Math.abs(a - e) / (e === 0 ? 1 : Math.abs(e));
}

export function vectorize(c: CandidateCard, spec: FeatureSpec): number[] {
  const rd = relDelta(c.expected_value, c.actual_value);
  const kind = c.compare_kind === "max" ? "min" : c.compare_kind; // порог сверху и снизу — один вид
  return [
    1,
    rd === null ? 0 : Math.log1p(rd),
    rd === null ? 1 : 0,
    c.review_priority === "HIGH" ? 1 : 0,
    c.confidence ?? 0,
    c.confidence === null ? 1 : 0,
    Math.log1p(c.fragments),
    ...STAGE_CODES.map((s) => (c.stages.includes(s) ? 1 : 0)),
    ...COMPARE_KINDS.map((k) => (kind === k ? 1 : 0)),
    ...spec.sections.map((s) => (c.section === s ? 1 : 0)),
  ];
}

export function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/** −log σ(z) без переполнения. */
function softplusNeg(z: number): number {
  return z >= 0 ? Math.log1p(Math.exp(-z)) : -z + Math.log1p(Math.exp(z));
}

function loss(X: number[][], t: number[], w: number[], l2: number): number {
  let s = 0;
  for (let i = 0; i < X.length; i++) {
    const z = dot(X[i], w);
    s += t[i] * softplusNeg(z) + (1 - t[i]) * softplusNeg(-z);
  }
  for (let j = 1; j < w.length; j++) s += (l2 / 2) * w[j] * w[j];
  return s;
}

/** Решение H·x = g методом Гаусса с выбором ведущего элемента. */
export function solve(H: number[][], g: number[]): number[] {
  const n = g.length;
  const A = H.map((r, i) => [...r, g[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * Логистическая регрессия методом Ньютона с L2 на все веса, кроме свободного члена (индекс 0), и
 * дроблением шага, пока потери не перестанут расти. Цели t ∈ [0; 1] (для Платта — сглаженные).
 */
export function fitLogistic(X: number[][], t: number[], l2: number, maxIter: number): number[] {
  const d = X[0].length;
  let w = new Array<number>(d).fill(0);
  for (let it = 0; it < maxIter; it++) {
    const g = w.map((wj, j) => (j === 0 ? 0 : l2 * wj));
    const H = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => (a === b ? (a === 0 ? 1e-9 : l2 + 1e-9) : 0)));
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(dot(X[i], w));
      const v = p * (1 - p);
      for (let a = 0; a < d; a++) {
        g[a] += (p - t[i]) * X[i][a];
        for (let b = 0; b < d; b++) H[a][b] += v * X[i][a] * X[i][b];
      }
    }
    const step = solve(H, g);
    const before = loss(X, t, w, l2);
    let k = 1;
    let next = w.map((wj, j) => wj - step[j]);
    while (loss(X, t, next, l2) > before && k > 1e-6) {
      k /= 2;
      next = w.map((wj, j) => wj - k * step[j]);
    }
    const moved = Math.max(...next.map((x, j) => Math.abs(x - w[j])));
    w = next;
    if (moved < 1e-10) break;
  }
  return w;
}

export interface RankingModel {
  algorithm: string;
  features: string[];
  spec: FeatureSpec;
  weights: number[];
  platt: { a: number; b: number };
  threshold: number;
}

const round = (x: number, k = 1e10) => Math.round(x * k) / k;

/** Сырая оценка (логит) до калибровки. */
export function rawScore(m: Pick<RankingModel, "spec" | "weights">, c: CandidateCard): number {
  return dot(vectorize(c, m.spec), m.weights);
}

/** OS-INSP-6.4.9: откалиброванная оценка вероятности нарушения кандидата. */
export function scoreCard(m: RankingModel, c: CandidateCard): number {
  return sigmoid(m.platt.a * rawScore(m, c) + m.platt.b);
}

/** Платт: σ(a·s + b) по validation со сглаженными целями (N₊+1)/(N₊+2) и 1/(N₋+2). */
export function fitPlatt(scores: number[], labels: number[]): { a: number; b: number } {
  const pos = labels.filter((y) => y === 1).length;
  const neg = labels.length - pos;
  const t = labels.map((y) => (y === 1 ? (pos + 1) / (pos + 2) : 1 / (neg + 2)));
  const [b, a] = fitLogistic(scores.map((s) => [1, s]), t, 0, 100);
  return { a, b };
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export function confusion(probs: number[], labels: number[], threshold: number): Confusion {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  probs.forEach((p, i) => {
    const hit = p >= threshold;
    if (labels[i] === 1) hit ? c.tp++ : c.fn++;
    else hit ? c.fp++ : c.tn++;
  });
  return c;
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);

export function prf(c: Confusion): { precision: number; recall: number; f1: number; false_positive_rate: number } {
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  return { precision, recall, f1: ratio(2 * precision * recall, precision + recall), false_positive_rate: ratio(c.fp, c.fp + c.tn) };
}

/**
 * Порог по validation: максимум F1 среди порогов с Recall ≥ minRecall; при равенстве — более строгий.
 * Кандидаты — середины между соседними оценками (запас в обе стороны, а не впритык к крайнему нарушению) и наименьшая оценка.
 */
export function chooseThreshold(probs: number[], labels: number[], minRecall: number): { threshold: number; precision: number; recall: number; f1: number } {
  const u = [...new Set(probs)].sort((x, y) => y - x);
  const cands = [...u.slice(1).map((x, i) => (u[i] + x) / 2), u[u.length - 1]];
  let best = { threshold: u[u.length - 1], precision: 0, recall: 0, f1: -1 };
  for (const t of cands) {
    const m = prf(confusion(probs, labels, t));
    if (m.recall >= minRecall && m.f1 > best.f1) best = { threshold: t, precision: m.precision, recall: m.recall, f1: m.f1 };
  }
  return best;
}

/** ROC-AUC через ранги (Манн — Уитни), равные оценки — средний ранг. */
export function rocAuc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  let rankPos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j].s === idx[i].s) j++;
    const r = (i + 1 + j) / 2; // средний ранг группы равных, ранги с 1
    for (let k = i; k < j; k++) if (idx[k].y === 1) rankPos += r;
    i = j;
  }
  const P = labels.filter((y) => y === 1).length;
  const N = labels.length - P;
  return ratio(rankPos - (P * (P + 1)) / 2, P * N);
}

export function brier(probs: number[], labels: number[]): number {
  return ratio(probs.reduce((s, p, i) => s + (p - labels[i]) ** 2, 0), probs.length);
}

/** 95 % доверительный интервал Уилсона для доли k/n; n = 0 — [0; 1]. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** OS-INSP-6.4.8: без обоих классов в train модель учить не на чем; без них в validation/test — нечем выбрать порог и мерить. */
export function refusal(items: LabeledCard[]): string[] {
  const reasons: string[] = [];
  const need: Array<[Split, string]> = [["train", "модель не научится их различать"], ["validation", "порог не выбрать"], ["test", "метрики не посчитать"]];
  for (const [split, why] of need) {
    const part = items.filter((i) => i.split === split);
    if (!part.some((i) => i.gold_label === "POSITIVE")) reasons.push(`В ${split} нет положительных примеров (подтверждённых нарушений) — ${why}`);
    if (!part.some((i) => i.gold_label === "NEGATIVE")) reasons.push(`В ${split} нет отрицательных примеров (отклонённых кандидатов) — ${why}`);
  }
  return reasons;
}

/** Хеши состава выборок — как у выпуска набора (buildDataset): sha256 отсортированных finding_id. */
export function splitHashes(items: Array<{ finding_id: string; split: Split }>): Record<Split, string> {
  const out = {} as Record<Split, string>;
  for (const s of ["train", "validation", "test"] as Split[]) {
    const part = items.filter((i) => i.split === s).map((i) => i.finding_id).sort();
    out[s] = createHash("sha256").update(JSON.stringify(part)).digest("hex");
  }
  return out;
}

/** OS-INSP-6.4.6: хеш весов — sha256 канонического JSON округлённых весов, калибровки и порога. */
export function weightsHash(m: RankingModel): string {
  const canon = { algorithm: m.algorithm, features: m.features, weights: m.weights.map((w) => round(w)), platt: { a: round(m.platt.a), b: round(m.platt.b) }, threshold: round(m.threshold) };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export interface SplitSize {
  n: number;
  positives: number;
  negatives: number;
}

export interface RetrainMetrics {
  precision: number;
  recall: number;
  f1: number;
  false_positive_rate: number;
  recall_by_category: Record<string, number>;
  per_category: Record<string, { n: number; positives: number; recall: number | null; false_positive_rate: number | null }>;
  roc_auc: number;
  brier: number;
  threshold: number;
  confusion: Confusion;
  ci95: { precision: [number, number]; recall: [number, number]; false_positive_rate: [number, number] };
  validation: { precision: number; recall: number; f1: number };
  sizes: Record<Split, SplitSize>;
}

const r4 = (x: number) => round(x, 1e4);

export type TrainResult = { ok: true; model: RankingModel; metrics: RetrainMetrics; weights_hash: string; split_hashes: Record<Split, string> } | { ok: false; reasons: string[] };

/** OS-INSP-6.4.4: обучение на train, калибровка и порог на validation, метрики на test. */
export function train(items: LabeledCard[], params: TrainParams = DEFAULT_PARAMS): TrainResult {
  const reasons = refusal(items);
  if (reasons.length) return { ok: false, reasons };
  const order = (c: LabeledCard) => createHash("sha256").update(`${params.seed}:${c.finding_id}`).digest("hex");
  const sorted = items.map((c) => ({ c, k: order(c) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((x) => x.c);
  const part = (s: Split) => sorted.filter((i) => i.split === s);
  const y = (cs: LabeledCard[]) => cs.map((c) => (c.gold_label === "POSITIVE" ? 1 : 0));
  const tr = part("train");
  const spec = featureSpec(tr);
  const weights = fitLogistic(tr.map((c) => vectorize(c, spec)), y(tr), params.l2, params.max_iter);

  const va = part("validation");
  const platt = fitPlatt(va.map((c) => rawScore({ spec, weights }, c)), y(va));
  const draft: RankingModel = { algorithm: ALGORITHM, features: featureNames(spec), spec, weights, platt, threshold: 0.5 };
  const vp = va.map((c) => scoreCard(draft, c));
  const th = chooseThreshold(vp, y(va), params.min_recall);
  const model = { ...draft, threshold: th.threshold };

  const te = part("test");
  const tp = te.map((c) => scoreCard(model, c));
  const ty = y(te);
  const cm = confusion(tp, ty, model.threshold);
  const m = prf(cm);
  const per_category: RetrainMetrics["per_category"] = {};
  const recall_by_category: Record<string, number> = {};
  for (const sec of [...new Set(te.map((c) => c.section))].sort()) {
    const ix = te.map((c, i) => (c.section === sec ? i : -1)).filter((i) => i >= 0);
    const cc = confusion(ix.map((i) => tp[i]), ix.map((i) => ty[i]), model.threshold);
    const pos = cc.tp + cc.fn;
    const neg = cc.fp + cc.tn;
    per_category[sec] = { n: ix.length, positives: pos, recall: pos ? r4(cc.tp / pos) : null, false_positive_rate: neg ? r4(cc.fp / neg) : null };
    if (pos) recall_by_category[sec] = r4(cc.tp / pos);
  }
  const size = (cs: LabeledCard[]): SplitSize => ({ n: cs.length, positives: y(cs).filter((v) => v === 1).length, negatives: y(cs).filter((v) => v === 0).length });
  const ci = (a: [number, number]): [number, number] => [r4(a[0]), r4(a[1])];
  const metrics: RetrainMetrics = {
    precision: r4(m.precision), recall: r4(m.recall), f1: r4(m.f1), false_positive_rate: r4(m.false_positive_rate),
    recall_by_category, per_category,
    roc_auc: r4(rocAuc(tp, ty)), brier: r4(brier(tp, ty)), threshold: r4(model.threshold), confusion: cm,
    ci95: { precision: ci(wilson(cm.tp, cm.tp + cm.fp)), recall: ci(wilson(cm.tp, cm.tp + cm.fn)), false_positive_rate: ci(wilson(cm.fp, cm.fp + cm.tn)) },
    validation: { precision: r4(th.precision), recall: r4(th.recall), f1: r4(th.f1) },
    sizes: { train: size(tr), validation: size(va), test: size(te) },
  };
  return { ok: true, model, metrics, weights_hash: weightsHash(model), split_hashes: splitHashes(items) };
}
