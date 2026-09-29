// OS-INSP-3.2.8–3.2.10 ML-паттерн-анализ (ТЗ 9.5, 4-й подход свободного поиска): модель паттернов, обученная на
// значениях параметров других объектов, ищет аномалии вида «расход бетона на 20 % ниже среднего».
//
// Модель — робастная статистика, а не нейросеть: история — единицы и десятки объектов, на такой выборке
// среднее и стандартное отклонение ломает один выброс, а медиана и MAD — нет. Порог z ≥ 3,5 — рекомендация
// Иглевича–Хоаглина для модифицированного z-балла. Значения берутся в логарифмах: удельные показатели
// строительства положительны и скошены вправо, а «−20 %» и «+25 %» в логарифмах симметричны.
import { createHash } from "node:crypto";
import type { Fact, Suspicion } from "./suspicions.ts";

/** Общая площадь здания — знаменатель удельных показателей. */
export const AREA_CODE = "M-002";
/** Меньше объектов в истории — медиана и MAD ненадёжны (OS-INSP-3.2.10). */
export const MIN_HISTORY = 5;
/** Порог отклонения от медианы истории (OS-INSP-3.2.9). */
export const MIN_DEVIATION = 0.2;
/** Порог модифицированного z-балла Иглевича–Хоаглина (OS-INSP-3.2.9). */
export const MIN_Z = 3.5;
/** MAD × 1,4826 — состоятельная оценка σ для нормального распределения. */
const MAD_TO_SIGMA = 1.4826;
/** Погрешность плавающей точки у порогов: ровно «20 %» не должно стать 19,999…. */
const EPS = 1e-9;
/** Версия алгоритма входит в хеш: изменится расчёт — изменится и версия модели при той же истории. */
const ALGO = "ml-pattern/1";

/**
 * Экстенсивные величины растут вместе со зданием — сравнимы между объектами только на м² общей площади.
 * Интенсивные (размеры, толщины, сечения, доли, этажность) от размера здания не зависят — сравниваются как есть.
 */
const EXTENSIVE_UNITS = new Set(["м²", "м³", "шт.", "кВт", "м³/ч", "л/с", "тыс. руб."]);
const INTENSIVE_UNITS = new Set(["м", "мм", "мм²", "%", "ед."]);
/** Сама площадь (на себя делится в 1) и абсолютная отметка (зависит от рельефа, а не от проекта). */
const EXCLUDED = new Set([AREA_CODE, "M-009"]);

export type PatternKind = "EXTENSIVE" | "INTENSIVE";

export interface PatternParam {
  code: string;
  name: string;
  unit: string;
  kind: PatternKind;
}

/** Точка истории: все извлечённые значения одного объекта. */
export interface HistoryObject {
  object_id: string;
  facts: Array<{ key: string; num: number | null }>;
}

/** Паттерн параметра: медиана и робастная σ в логарифмах удельной величины, объём выборки. */
export interface ParamPattern {
  code: string;
  median: number;
  scale: number;
  n: number;
}

export interface PatternModel {
  version: string; // sha256 канонизированной обучающей истории
  objects: number;
  params: Map<string, ParamPattern>;
}

/** Вид параметра для модели паттернов; null — параметр в модель не входит. */
export function patternKind(p: { code: string; unit: string; data_type: string }): PatternKind | null {
  if (p.data_type !== "number" || EXCLUDED.has(p.code)) return null;
  if (EXTENSIVE_UNITS.has(p.unit)) return "EXTENSIVE";
  return INTENSIVE_UNITS.has(p.unit) ? "INTENSIVE" : null;
}

/** Параметры Матрицы, пригодные для модели паттернов, в порядке Матрицы. */
export function patternParams(params: Array<{ code: string; parameter_name: string; unit: string; data_type: string }>): Map<string, PatternParam> {
  const out = new Map<string, PatternParam>();
  for (const p of params) {
    const kind = patternKind(p);
    if (kind) out.set(p.code, { code: p.code, name: p.parameter_name, unit: p.unit, kind });
  }
  return out;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Модифицированный z-балл Иглевича–Хоаглина: (x − медиана) / (1,4826 · MAD). */
export const robustZ = (x: number, med: number, scale: number): number => (x - med) / scale;

/**
 * Удельные значения одного объекта: экстенсивное — на м² общей площади, интенсивное — как есть.
 * Несколько значений (стадии, редакции) сводятся медианой. Без площади экстенсивные параметры пропускаются.
 */
export function objectProfile(facts: Array<{ key: string; num: number | null }>, params: Map<string, PatternParam>): Map<string, number> {
  const positive = (key: string) => facts.filter((f) => f.key === key && (f.num ?? 0) > 0).map((f) => f.num!);
  const areas = positive(AREA_CODE);
  const area = areas.length ? median(areas) : null;
  const out = new Map<string, number>();
  for (const p of params.values()) {
    const vs = positive(p.code);
    if (!vs.length) continue;
    if (p.kind === "INTENSIVE") out.set(p.code, median(vs));
    else if (area) out.set(p.code, median(vs) / area);
  }
  return out;
}

/**
 * OS-INSP-3.2.8: обучить модель паттернов на истории других объектов. Записи текущего объекта отбрасываются,
 * записи одного объекта из нескольких проверок сводятся в одну точку. Версия — sha256 канонизированной истории.
 */
export function fitPatternModel(history: HistoryObject[], params: Map<string, PatternParam>, currentObjectId: string): PatternModel {
  const byObject = new Map<string, HistoryObject["facts"]>();
  for (const h of history) {
    if (h.object_id === currentObjectId) continue;
    byObject.set(h.object_id, [...(byObject.get(h.object_id) ?? []), ...h.facts]);
  }
  const lines: string[] = [];
  const logs = new Map<string, number[]>();
  for (const [id, facts] of byObject) {
    for (const [code, v] of objectProfile(facts, params)) {
      lines.push(`${id}\t${code}\t${v}`);
      logs.set(code, [...(logs.get(code) ?? []), Math.log(v)]);
    }
  }
  const out = new Map<string, ParamPattern>();
  for (const code of params.keys()) {
    const xs = logs.get(code);
    if (!xs) continue;
    const m = median(xs);
    out.set(code, { code, median: m, scale: MAD_TO_SIGMA * median(xs.map((x) => Math.abs(x - m))), n: xs.length });
  }
  const version = createHash("sha256").update([ALGO, ...lines.sort()].join("\n")).digest("hex");
  return { version, objects: byObject.size, params: out };
}

/** OS-INSP-3.2.10: по параметру можно судить, только если в истории ≥ 5 объектов и разброс ненулевой. */
export const canJudge = (p: ParamPattern): boolean => p.n >= MIN_HISTORY && p.scale > 0;

/** Число для описания: до трёх значащих цифр, дробная часть — через запятую. */
const fmt = (x: number): string => String(Number(x.toPrecision(3))).replace(".", ",");

/**
 * OS-INSP-3.2.9: удельное значение отклоняется от медианы истории не меньше чем на 20 % и |z| ≥ 3,5 —
 * гипотеза ML_PATTERN (SUSPICION, не нарушение — OS-INSP-3.2.2). Каждый факт (стадия) судится отдельно.
 */
export function detectAnomalies(model: PatternModel, facts: Fact[], params: Map<string, PatternParam>): Suspicion[] {
  const out: Suspicion[] = [];
  for (const f of facts) {
    const pat = model.params.get(f.key);
    if (!pat || !canJudge(pat)) continue;
    // площадь — со всех стадий объекта, значение — только этого факта
    const v = objectProfile([...facts.filter((x) => x.key === AREA_CODE), { key: f.key, num: f.num }], params).get(f.key);
    if (v === undefined) continue;
    const p = params.get(f.key)!; // есть в профиле — есть и в параметрах
    const z = robustZ(Math.log(v), pat.median, pat.scale);
    const dev = Math.exp(Math.log(v) - pat.median) - 1;
    const absDev = Math.abs(dev);
    if (absDev < MIN_DEVIATION - EPS || Math.abs(z) < MIN_Z - EPS) continue;
    const unit = p.kind === "EXTENSIVE" ? `${p.unit}/м²` : p.unit;
    const zText = `${z < 0 ? "−" : "+"}${Math.abs(z).toFixed(1).replace(".", ",")}`;
    out.push({
      discovery_method: "ML_PATTERN",
      confidence: Math.round((0.5 + 0.45 * (1 - MIN_Z / Math.abs(z))) * 100) / 100,
      description: `${p.name} (${p.code}): ${p.kind === "EXTENSIVE" ? "удельное значение" : "значение"} ${fmt(v)} ${unit} на ${Math.round(absDev * 100)} % ${dev < 0 ? "ниже" : "выше"} медианы ${pat.n} объектов (${fmt(Math.exp(pat.median))} ${unit}; робастный z = ${zText}; модель паттернов ${model.version.slice(0, 12)}).`,
      pd_reference: f.stage === "PD" ? f.ref : null,
      rd_reference: f.stage === "RD" ? f.ref : null,
      review_priority: absDev >= 0.5 - EPS ? "HIGH" : absDev >= 0.3 - EPS ? "MEDIUM" : "LOW",
      normative_base: null,
      dedup_key: `PATTERN:${f.key}:${f.stage}`,
    });
  }
  return out;
}
