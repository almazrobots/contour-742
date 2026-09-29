// OS-INSP-6.4.4–6.4.9: управляемое дообучение модели ранжирования кандидатов (ТЗ §7.4, §9.4). Имя теста — ссылка трассы.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALGORITHM, brier, chooseThreshold, confusion, DEFAULT_PARAMS, featureNames, featureSpec, fitLogistic, fitPlatt, prf, refusal, relDelta, rocAuc,
  scoreCard, sigmoid, solve, splitHashes, train, vectorize, weightsHash, wilson, type LabeledCard,
} from "../src/domain/retrain.ts";
import type { Split } from "../src/domain/gold.ts";

const card = (o: Partial<LabeledCard> = {}): LabeledCard => ({
  finding_id: "F-1", section: "АР", review_priority: "HIGH", compare_kind: "equal", expected_value: "100", actual_value: "100",
  confidence: 0.9, stages: ["PD", "RD"], fragments: 2, gold_label: "NEGATIVE", split: "train", ...o,
});

/** Разделимые данные: нарушение — расхождение 30–60 %, отклонённый кандидат — до 2 %. */
function separable(n: Record<Split, number> = { train: 40, validation: 20, test: 20 }, sections = ["АР", "КР"]): LabeledCard[] {
  const out: LabeledCard[] = [];
  for (const split of ["train", "validation", "test"] as Split[])
    for (let i = 0; i < n[split]; i++) {
      const pos = i % 2 === 0;
      const dev = pos ? 30 + ((i * 7) % 31) : (i * 3) % 3;
      out.push(card({ finding_id: `F-${split}-${i}`, split, section: sections[Math.floor(i / 2) % sections.length], gold_label: pos ? "POSITIVE" : "NEGATIVE", actual_value: String(100 + dev), confidence: 0.7 + ((i * 13) % 30) / 100 }));
    }
  return out;
}

describe("OS-INSP-6.4.4 обучение на train, порог на validation, метрики на test", () => {
  it("на разделимых данных модель ранжирует без ошибок: метрики test равны единице", () => {
    const r = train(separable());
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.metrics).toMatchObject({ precision: 1, recall: 1, f1: 1, false_positive_rate: 0, roc_auc: 1 });
    expect(r.metrics.brier).toBeLessThan(0.05);
    expect(r.metrics.confusion).toEqual({ tp: 10, fp: 0, tn: 10, fn: 0 });
    expect(r.metrics.sizes).toEqual({ train: { n: 40, positives: 20, negatives: 20 }, validation: { n: 20, positives: 10, negatives: 10 }, test: { n: 20, positives: 10, negatives: 10 } });
    expect(r.model.algorithm).toBe(ALGORITHM);
    expect(r.model.features).toEqual(featureNames({ sections: ["АР", "КР"] }));
    // вес расхождения — главный и положительный
    expect(r.model.weights[1]).toBeGreaterThan(0.5);
  });

  it("порог выбирается по validation, а не по test: смена меток test не меняет модель и порог", () => {
    const a = separable();
    const b = a.map((c) => (c.split === "test" ? { ...c, gold_label: c.gold_label === "POSITIVE" ? ("NEGATIVE" as const) : ("POSITIVE" as const) } : c));
    const ra = train(a);
    const rb = train(b);
    if (!ra.ok || !rb.ok) throw new Error("отказ");
    expect(rb.model).toEqual(ra.model);
    expect(rb.weights_hash).toBe(ra.weights_hash);
    // а метрики считаются именно на test — перевёрнутые метки дают нулевой Recall
    expect(rb.metrics.recall).toBe(0);
    expect(rb.metrics.roc_auc).toBe(0);
    expect(rb.metrics.validation).toEqual(ra.metrics.validation);
  });

  it("метрики с разбивкой по разделам Матрицы и 95 % ДИ Уилсона", () => {
    const r = train(separable());
    if (!r.ok) throw new Error("отказ");
    expect(r.metrics.recall_by_category).toEqual({ АР: 1, КР: 1 });
    expect(r.metrics.per_category.АР).toEqual({ n: 10, positives: 5, recall: 1, false_positive_rate: 0 });
    expect(r.metrics.per_category.КР).toEqual({ n: 10, positives: 5, recall: 1, false_positive_rate: 0 });
    expect(r.metrics.ci95.recall).toEqual([0.7225, 1]);
    expect(r.metrics.ci95.false_positive_rate).toEqual([0, 0.2775]);
    expect(r.metrics.ci95.precision).toEqual([0.7225, 1]);
    expect(r.metrics.validation).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(r.metrics.threshold).toBe(Math.round(r.model.threshold * 1e4) / 1e4);
  });

  it("ошибки модели на test видны в матрице ошибок и в разделе", () => {
    const items = separable();
    // в test «нарушение» с малым расхождением — модель его пропустит
    items.push(card({ finding_id: "F-miss", split: "test", section: "КР", gold_label: "POSITIVE", actual_value: "100" }));
    items.push(card({ finding_id: "F-fp", split: "test", section: "КР", gold_label: "NEGATIVE", actual_value: "160" }));
    // раздел без нарушений в test: Recall не определён — в recall_by_category его нет
    items.push(card({ finding_id: "F-zu", split: "test", section: "ЗУ", gold_label: "NEGATIVE", actual_value: "100" }));
    const r = train(items);
    if (!r.ok) throw new Error("отказ");
    expect(r.metrics.confusion).toEqual({ tp: 10, fp: 1, tn: 11, fn: 1 });
    expect(r.metrics.per_category.ЗУ).toEqual({ n: 1, positives: 0, recall: null, false_positive_rate: 0 });
    expect(r.metrics.ci95.precision).toEqual(r.metrics.ci95.recall);
    expect(r.metrics.ci95.recall[0]).toBeCloseTo(wilson(10, 11)[0], 4);
    expect(r.metrics.ci95.false_positive_rate[1]).toBeCloseTo(wilson(1, 12)[1], 4);
    expect(r.metrics.recall).toBe(0.9091);
    expect(r.metrics.precision).toBe(0.9091);
    expect(r.metrics.false_positive_rate).toBe(0.0833);
    expect(r.metrics.recall_by_category).toEqual({ АР: 1, КР: 0.8333 });
    expect(r.metrics.per_category.КР).toEqual({ n: 12, positives: 6, recall: 0.8333, false_positive_rate: 0.1667 });
    expect(r.metrics.per_category.АР).toEqual({ n: 10, positives: 5, recall: 1, false_positive_rate: 0 });
    expect(r.metrics.roc_auc).toBeLessThan(1);
  });
});

describe("OS-INSP-6.4.5 состав итерации: хеши выборок, параметры, признаки", () => {
  it("хеши выборок — sha256 отсортированных finding_id, как у выпуска набора", () => {
    const h = splitHashes([{ finding_id: "b", split: "train" }, { finding_id: "a", split: "train" }]);
    expect(h.train).toBe(splitHashes([{ finding_id: "a", split: "train" }, { finding_id: "b", split: "train" }]).train);
    expect(h.train).toMatch(/^[0-9a-f]{64}$/);
    expect(h.validation).toBe(splitHashes([]).validation);
    expect(h.train).not.toBe(h.validation);
    const r = train(separable());
    if (!r.ok) throw new Error("отказ");
    expect(r.split_hashes).toEqual(splitHashes(separable()));
  });

  it("признаки карточки: расхождение, приоритет, уверенность, фрагменты, стадии, вид сравнения, раздел", () => {
    const spec = { sections: ["АР", "КР"] };
    expect(vectorize(card({ expected_value: "≥ 0,9 м", actual_value: "0.45", compare_kind: "max", stages: ["RD", "ID"], fragments: 3, confidence: 0.8, section: "КР" }), spec)).toEqual([
      1, Math.log1p(0.5), 0, 1, 0.8, 0, Math.log1p(3), 0, 1, 1, 1, 0, 0, 0, 0, 0, 1,
    ]);
    expect(vectorize(card({ expected_value: "B25", actual_value: "B30", compare_kind: "delta_pct", review_priority: "MEDIUM", confidence: null, stages: ["PD"], fragments: 0, section: "ЗУ" }), spec)).toEqual([
      1, Math.log1p(0.2), 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0,
    ]);
    expect(vectorize(card({ expected_value: "монолит", actual_value: "кирпич", compare_kind: "increase" }), spec).slice(1, 3)).toEqual([0, 1]);
    expect(vectorize(card({ compare_kind: "decrease" }), spec).slice(10, 15)).toEqual([0, 0, 1, 0, 0]);
    expect(vectorize(card({ compare_kind: "equal" }), spec).slice(10, 15)).toEqual([0, 1, 0, 0, 0]);
    expect(featureNames(spec)).toEqual(["bias", "log_rel_delta", "non_numeric", "priority_high", "confidence", "no_confidence", "log_fragments",
      "stage_PD", "stage_RD", "stage_ID", "compare_min", "compare_equal", "compare_decrease", "compare_increase", "compare_delta_pct", "section_АР", "section_КР"]);
  });

  it("относительное расхождение: доля от ожидания, запятая как разделитель, нулевое ожидание — абсолютная разница", () => {
    expect(relDelta("200", "150")).toBe(0.25);
    expect(relDelta("-4", "-2")).toBe(0.5);
    expect(relDelta("2,5", "3")).toBe(0.2);
    expect(relDelta("0", "3")).toBe(3);
    expect(relDelta(null, "3")).toBeNull();
    expect(relDelta("3", "нет")).toBeNull();
  });

  it("словарь разделов — только из train, отсортирован и без повторов", () => {
    expect(featureSpec([card({ section: "КР" }), card({ section: "АР" }), card({ section: "КР" })])).toEqual({ sections: ["АР", "КР"] });
  });
});

describe("OS-INSP-6.4.6 воспроизводимость", () => {
  it("повторный запуск на том же наборе с теми же параметрами даёт тот же хеш весов", () => {
    const a = train(separable());
    const b = train([...separable()].reverse());
    if (!a.ok || !b.ok) throw new Error("отказ");
    expect(b.weights_hash).toBe(a.weights_hash);
    expect(b.model).toEqual(a.model);
    const c = train(separable(), { ...DEFAULT_PARAMS, l2: 5 });
    if (!c.ok) throw new Error("отказ");
    expect(c.weights_hash).not.toBe(a.weights_hash);
  });

  it("хеш весов — sha256 канонического JSON: меняется от веса, калибровки, порога и признаков", () => {
    const r = train(separable());
    if (!r.ok) throw new Error("отказ");
    const m = r.model;
    expect(weightsHash(m)).toBe(r.weights_hash);
    expect(r.weights_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(weightsHash({ ...m, weights: m.weights.map((w, i) => (i === 3 ? w + 1e-6 : w)) })).not.toBe(r.weights_hash);
    expect(weightsHash({ ...m, weights: m.weights.map((w, i) => (i === 3 ? w + 1e-12 : w)) })).toBe(r.weights_hash);
    expect(weightsHash({ ...m, platt: { ...m.platt, a: m.platt.a + 1e-6 } })).not.toBe(r.weights_hash);
    expect(weightsHash({ ...m, platt: { ...m.platt, b: m.platt.b + 1e-6 } })).not.toBe(r.weights_hash);
    expect(weightsHash({ ...m, threshold: m.threshold + 1e-6 })).not.toBe(r.weights_hash);
    expect(weightsHash({ ...m, features: [...m.features].reverse() })).not.toBe(r.weights_hash);
    expect(weightsHash({ ...m, algorithm: "x" })).not.toBe(r.weights_hash);
  });

  it("свойство: хеш весов не зависит от порядка строк набора", () => {
    const base = separable({ train: 12, validation: 6, test: 6 });
    const h = (train(base) as { weights_hash: string }).weights_hash;
    fc.assert(fc.property(fc.array(fc.nat(), { minLength: base.length, maxLength: base.length }), (keys) => {
      const shuffled = base.map((c, i) => ({ c, k: keys[i] })).sort((a, b) => a.k - b.k).map((x) => x.c);
      return (train(shuffled) as { weights_hash: string }).weights_hash === h;
    }), { numRuns: 20 });
  });
});

describe("OS-INSP-6.4.8 отказ без положительных или отрицательных примеров", () => {
  it("в train нет положительных — отказ с причиной", () => {
    const items = separable().map((c) => (c.split === "train" ? { ...c, gold_label: "NEGATIVE" as const } : c));
    const r = train(items);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons).toEqual(["В train нет положительных примеров (подтверждённых нарушений) — модель не научится их различать"]);
  });
  it("в train нет отрицательных — отказ с причиной", () => {
    const items = separable().map((c) => (c.split === "train" ? { ...c, gold_label: "POSITIVE" as const } : c));
    expect(refusal(items)).toEqual(["В train нет отрицательных примеров (отклонённых кандидатов) — модель не научится их различать"]);
  });
  it("пустые validation и test — отказ: порог не выбрать, метрики не посчитать", () => {
    expect(refusal(separable().filter((c) => c.split === "train"))).toEqual([
      "В validation нет положительных примеров (подтверждённых нарушений) — порог не выбрать",
      "В validation нет отрицательных примеров (отклонённых кандидатов) — порог не выбрать",
      "В test нет положительных примеров (подтверждённых нарушений) — метрики не посчитать",
      "В test нет отрицательных примеров (отклонённых кандидатов) — метрики не посчитать",
    ]);
    expect(refusal(separable())).toEqual([]);
    expect(refusal([])).toHaveLength(6);
  });
});

describe("OS-INSP-6.4.9 оценка вероятности нарушения", () => {
  it("откалиброванная оценка в (0; 1): нарушение выше отклонённого кандидата", () => {
    const r = train(separable());
    if (!r.ok) throw new Error("отказ");
    const hi = scoreCard(r.model, card({ actual_value: "150" }));
    const lo = scoreCard(r.model, card({ actual_value: "100" }));
    expect(hi).toBeGreaterThan(r.model.threshold);
    expect(lo).toBeLessThan(r.model.threshold);
    expect(hi).toBeLessThan(1);
    expect(lo).toBeGreaterThan(0);
    // незнакомый раздел не ломает оценку
    expect(scoreCard(r.model, card({ section: "ИОС5", actual_value: "150" }))).toBeGreaterThan(0.5);
  });
});

describe("численные примитивы", () => {
  it("сигмоида устойчива на краях и симметрична", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 12);
    expect(sigmoid(-2)).toBeCloseTo(1 / (1 + Math.exp(2)), 12);
  });
  it("метод Гаусса с выбором ведущего элемента решает систему с нулём на диагонали", () => {
    const x = solve([[0, 2, 1], [1, 1, 0], [3, 0, 1]], [5, 3, 4]);
    [1, 2, 1].forEach((v, i) => expect(x[i]).toBeCloseTo(v, 10));
    const y = solve([[2, 1], [4, 3]], [3, 7]);
    [1, 1].forEach((v, i) => expect(y[i]).toBeCloseTo(v, 10));
  });
  it("логистическая регрессия восстанавливает известные коэффициенты на мягких целях", () => {
    const X = [-2, -1, 0, 1, 2].map((x) => [1, x]);
    const t = X.map(([, x]) => sigmoid(0.5 + 1.5 * x));
    const w = fitLogistic(X, t, 0, 50);
    expect(w[0]).toBeCloseTo(0.5, 5);
    expect(w[1]).toBeCloseTo(1.5, 5);
    // L2 тянет веса к нулю, но не свободный член
    const w2 = fitLogistic(X, t, 100, 50);
    expect(Math.abs(w2[1])).toBeLessThan(0.1);
    expect(w2[0]).toBeGreaterThan(0.2);
    // один шаг Ньютона от нуля — ещё не решение
    expect(Math.abs(fitLogistic(X, t, 0, 1)[1] - 1.5)).toBeGreaterThan(1e-3);
  });
  it("разделимые данные без L2 не дают бесконечностей — дробление шага держит веса конечными", () => {
    const X = [[1, -1], [1, 1]];
    const w = fitLogistic(X, [0, 1], 0.01, 50);
    expect(w.every(Number.isFinite)).toBe(true);
    expect(w[1]).toBeGreaterThan(1);
  });
  it("Платт со сглаженными целями: монотонно и не 0/1", () => {
    const p = fitPlatt([-3, -2, -1, 1, 2, 3], [0, 0, 0, 1, 1, 1]);
    expect(p.a).toBeGreaterThan(0);
    expect(sigmoid(p.a * 3 + p.b)).toBeLessThan(1);
    expect(sigmoid(p.a * 3 + p.b)).toBeGreaterThan(0.75);
    expect(sigmoid(p.a * -3 + p.b)).toBeLessThan(0.25);
    expect(Math.abs(p.b)).toBeLessThan(1e-6);
  });
  it("матрица ошибок и P/R/F1/FPR; порог включительный", () => {
    const c = confusion([0.9, 0.5, 0.4, 0.2], [1, 0, 1, 0], 0.5);
    expect(c).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(prf(c)).toEqual({ precision: 0.5, recall: 0.5, f1: 0.5, false_positive_rate: 0.5 });
    expect(prf({ tp: 0, fp: 0, tn: 0, fn: 0 })).toEqual({ precision: 0, recall: 0, f1: 0, false_positive_rate: 0 });
    expect(prf({ tp: 3, fp: 1, tn: 0, fn: 0 }).f1).toBeCloseTo(6 / 7, 12);
  });
  it("порог: максимум F1 при Recall ≥ минимума; при равном F1 — более строгий", () => {
    const probs = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
    const labels = [1, 1, 1, 0, 0, 0, 1];
    // лучший F1 = 0,857 между 0,7 и 0,6 (Recall 0,75); с Recall ≥ 0,8 годится только наименьшая оценка 0,3
    const t = chooseThreshold(probs, labels, 0.7);
    expect(t).toMatchObject({ recall: 0.75, precision: 1 });
    expect(t.threshold).toBeCloseTo(0.65, 12);
    expect(chooseThreshold(probs, labels, 0.8)).toMatchObject({ threshold: 0.3, recall: 1, precision: 4 / 7 });
    // порог — середина зазора между классами, а не впритык к наименьшему нарушению
    expect(chooseThreshold([0.9, 0.8, 0.1], [1, 1, 0], 0.8)).toEqual({ threshold: 0.45, precision: 1, recall: 1, f1: 1 });
    // равный F1 — более строгий порог: 0,85 и 0,1 дают F1 = 2/3 при Recall 0,5 и 1
    const tie = chooseThreshold([0.9, 0.8, 0.7, 0.1], [1, 0, 0, 1], 0.5);
    expect(tie).toMatchObject({ recall: 0.5, precision: 1 });
    expect(tie.threshold).toBeCloseTo(0.85, 12);
    expect(chooseThreshold([0.5, 0.5], [1, 0], 0.8)).toEqual({ threshold: 0.5, precision: 0.5, recall: 1, f1: 2 / 3 });
  });
  it("ROC-AUC по рангам со средним рангом для равных; Брайер", () => {
    expect(rocAuc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBe(0.75);
    expect(rocAuc([0.5, 0.5], [1, 0])).toBe(0.5);
    expect(rocAuc([0.2, 0.5, 0.5, 0.9], [0, 1, 0, 1])).toBe(0.875);
    expect(rocAuc([0.1], [1])).toBe(0);
    expect(brier([1, 0, 0.5], [1, 1, 0])).toBeCloseTo((0 + 1 + 0.25) / 3, 12);
    expect(brier([], [])).toBe(0);
  });
  it("интервал Уилсона: известные значения, границы [0; 1], пустая выборка", () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 4);
    expect(hi).toBeCloseTo(0.9433, 4);
    expect(wilson(0, 10)[0]).toBe(0);
    expect(wilson(10, 10)[1]).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(wilson(5, 10)[0]).toBeCloseTo(1 - wilson(5, 10)[1], 12);
    fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), fc.nat(), (n, k0) => {
      const k = k0 % (n + 1);
      const [a, b] = wilson(k, n);
      return a >= 0 && b <= 1 && a <= k / n + 1e-12 && b >= k / n - 1e-12;
    }));
  });
});
