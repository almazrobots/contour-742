// Понижающий слой для геометрических результатов (каталог TO-BE §12, ADR-0010 п. 5, T-194): VER-04 (регистрация и
// масштаб), VER-06 (второе свидетельство значения), VER-10 (калибровка уверенности), VER-09 (закрытый вопрос VLM по
// двум кропам — вердикт применяет `applyVlm`, сам вызов модели — services/vlm-claim.ts).
// Слой только понижает: CANDIDATE → воздержание, NEGATIVE_VERIFIED → воздержание; повышений и новых кандидатов нет.
// Шаги — того же вида, что L8Step в verify-l8.ts (T-177): {op, from, to, reason_code, why}; после влития T-177 слой
// подключается к verifyL8 проходом по `verifyGeom(ev, ctx.geom).geom.steps`. Правила — OS-INSP-2.4.53–2.4.59,
// OS-INSP-3.1.125–3.1.132.
//
// SUSPICION в словаре статусов протокола нет (types.ts, ТЗ §9.2): «понижение до SUSPICION» каталога здесь —
// CLARIFICATION_REQUIRED с пометкой `suspicion: true` в шаге и флагом SUSPICION в следе (допущение OS-INSP-2.4.57).
import { z } from "zod";
import type { Evaluation, FindingStatus, Fragment } from "./types.ts";

// ─────────────────────────────── контракт GeomMention (ADR-0010) — провенанс геометрического значения

export const GEOM_MEASURES = ["length", "area", "position", "shape", "relation", "topology", "count"] as const;
export type GeomMeasure = (typeof GEOM_MEASURES)[number];
export const GEOM_UNITS = ["мм", "м", "м²", "шт"] as const;
export type GeomUnit = (typeof GEOM_UNITS)[number];

const Pt = z.tuple([z.number(), z.number()]);
const BBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** Геометрическое упоминание (Extraction.meta.geom) — ровно контракт ADR-0010; битая запись — громкий отказ разбора. */
export const GeomMentionSchema = z.object({
  entity: z.string().regex(/^ENT-\d{2}$/),
  measure: z.enum(GEOM_MEASURES),
  value: z.number().nullable(),
  unit: z.enum(GEOM_UNITS),
  by: z.enum(["dimension", "geometry", "both"]),
  label_value: z.number().nullable(),
  measured_value: z.number().nullable(),
  key: z.string(),
  at: Pt.nullable(),
  polygon: z.array(Pt).nullable(),
  graph: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }).nullable(),
  frame: z.enum(["bld", "sheet"]),
  scale_n: z.number().positive().nullable(),
  scale_spread_pct: z.number().nonnegative(),
  residual_mm: z.number().nonnegative().nullable(),
  page: z.number().int().positive(),
  bbox: BBoxSchema.nullable(),
  quote: z.string(),
});
export type GeomMention = z.infer<typeof GeomMentionSchema>;

// ─────────────────────────────── данные слоя: допуски (geom-gates.json) и калибровка (geom-calibration.json)

const OpCode = z.string().regex(/^CMP-\d{2}$/);
/** Допуск VER-04 оператора: residual_mm null — регистрация в системе осей оператору не нужна (длина, площадь). */
const Ver04Tol = z.strictObject({ residual_mm: z.number().positive().nullable(), scale_spread_pct: z.number().positive() });
/** Допуск согласия VER-06: значения согласны, если |a − b| ≤ max(abs, pct % от большего). */
const AgreeTol = z.strictObject({ abs: z.number().nonnegative(), pct: z.number().nonnegative() });

export const GeomGatesSchema = z.object({
  ver04: z.strictObject({ default: Ver04Tol, ops: z.record(OpCode, Ver04Tol) }),
  ver06: z.record(z.enum(GEOM_MEASURES), AgreeTol), // все виды измерения — пропуск вида = громкий отказ загрузки
});
export type GeomGates = z.infer<typeof GeomGatesSchema>;

const CalEntry = z
  .strictObject({
    x: z.array(z.number()),
    y: z.array(z.number().min(0).max(1)),
    threshold: z.number().min(0).max(1).nullable(), // null — целевая Precision на validation недостижима
    target_precision: z.number().min(0).max(1),
    margin: z.number().min(0).max(1),
    n: z.number().int().nonnegative(),
    fitted_on: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.x.length !== c.y.length || !c.x.length) ctx.addIssue({ code: "custom", message: "x и y калибровки — непустые и одной длины" });
    for (let i = 1; i < c.x.length; i++) {
      if (!(c.x[i] > c.x[i - 1])) ctx.addIssue({ code: "custom", message: `x калибровки не строго возрастает на позиции ${i}` });
      if (c.y[i] < c.y[i - 1]) ctx.addIssue({ code: "custom", message: `y калибровки убывает на позиции ${i}: изотоническая кривая не бывает убывающей` });
    }
  });
/** Таблица калибровки VER-10: оператор → кривая. Оператора в таблице нет — калибровка тождественная, шаг не срабатывает. */
export const CalibrationSchema = z.object({ ops: z.record(OpCode, CalEntry) });
export type Calibration = z.infer<typeof CalibrationSchema>;
export type CalibrationCurve = z.infer<typeof CalEntry>;

// ─────────────────────────────── след слоя (совместим с L8Step / L8Trace из T-177)

export interface GeomStep {
  op: string;
  from: FindingStatus;
  to: FindingStatus;
  reason_code: string | null;
  why: string;
  suspicion?: boolean; // понижение «до SUSPICION» каталога (см. шапку файла)
}

export interface GeomTrace {
  ops: string[];
  steps: GeomStep[];
  reason_code: string | null;
  flags: string[]; // SUSPICION
}

export type GeomEvaluation<E extends Evaluation = Evaluation> = E & { geom: GeomTrace };

export const GEOM_OPS = ["VER-04", "VER-06", "VER-10"] as const;

/** Куда слой вправе перевести статус — та же таблица, что LOWER_TO в verify-l8.ts (после влития T-177 — одна). */
export const GEOM_LOWER_TO: Record<FindingStatus, readonly FindingStatus[]> = {
  CANDIDATE: ["NEGATIVE_VERIFIED", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "MISSING_EVIDENCE"],
  NEGATIVE_VERIFIED: ["NOT_COMPARABLE", "CLARIFICATION_REQUIRED"],
  MISSING_EVIDENCE: [],
  NOT_APPLICABLE: [],
  NOT_COMPARABLE: [],
  CLARIFICATION_REQUIRED: [],
};

/** Второе свидетельство значения (VER-06): ведомость проёмов, спецификация, надпись, таблица. */
export interface Witness {
  source: "label" | "schedule" | "specification" | "table";
  value: number;
  unit: GeomUnit;
  quote: string;
  document_code: string | null;
  page: number | null;
}

export interface GeomContext {
  op: string; // оператор L7 (CMP-12 GEO-DIM, CMP-13 GEO-AREA, CMP-14 GEO-POS …)
  gates: GeomGates;
  calibration: Calibration;
  geom: (f: Fragment) => GeomMention | null; // провенанс геометрии фрагмента; null — фрагмент из текста или таблицы
  witnesses?: (f: Fragment, m: GeomMention) => Witness[];
  score: number | null; // уверенность оператора в результате (до калибровки)
}

// ─────────────────────────────── VER-04 регистрация и масштаб

export function ver04Tol(gates: GeomGates, op: string): z.infer<typeof Ver04Tol> {
  return gates.ver04.ops[op] ?? gates.ver04.default;
}

/**
 * VER-04 для одного упоминания: причина несопоставимости или null. Масштаб проверяется, когда значение хоть отчасти
 * получено измерением (by ≠ dimension): нет масштаба или разброс масштаба по размерным линиям больше допуска.
 * Регистрация — когда оператору нужна система осей здания: кадр листа, нет остатка или остаток больше допуска.
 */
export function registrationIssue(m: GeomMention, gates: GeomGates, op: string): string | null {
  const tol = ver04Tol(gates, op);
  if (m.by !== "dimension") {
    if (m.scale_n === null) return `масштаб листа не определён (стр. ${m.page}, ${m.key || m.entity})`;
    if (m.scale_spread_pct > tol.scale_spread_pct + 1e-9) return `разброс масштаба ${m.scale_spread_pct} % больше допуска ${tol.scale_spread_pct} % (стр. ${m.page}, 1:${m.scale_n})`;
  }
  if (tol.residual_mm !== null) {
    if (m.frame !== "bld" || m.residual_mm === null) return `${op} нужна система осей здания, а лист не зарегистрирован (стр. ${m.page})`;
    if (m.residual_mm > tol.residual_mm + 1e-9) return `остаток регистрации ${m.residual_mm} мм больше допуска ${tol.residual_mm} мм (стр. ${m.page})`;
  }
  return null;
}

// ─────────────────────────────── VER-06 второе свидетельство

const DIM: Record<GeomUnit, [string, number]> = { мм: ["length", 1], м: ["length", 1000], "м²": ["area", 1], шт: ["count", 1] };

/** Значение свидетеля в единицах упоминания; разные размерности (м² против мм) — null. */
export function inUnit(v: number, from: GeomUnit, to: GeomUnit): number | null {
  const [df, kf] = DIM[from];
  const [dt, kt] = DIM[to];
  return df === dt ? (v * kf) / kt : null;
}

/** Согласие двух значений по допуску вида измерения: |a − b| ≤ max(abs, pct % от большего по модулю). */
export function agrees(a: number, b: number, tol: { abs: number; pct: number }): boolean {
  const allowed = Math.max(tol.abs, (tol.pct / 100) * Math.max(Math.abs(a), Math.abs(b)));
  return Math.abs(a - b) <= allowed + 1e-9;
}

export interface Contradiction {
  kind: "conflict" | "units";
  why: string;
}

const SRC: Record<Witness["source"], string> = { label: "надпись размера", schedule: "ведомость проёмов", specification: "спецификация", table: "таблица" };
const fmt = (v: number) => String(Math.round(v * 1000) / 1000).replace(".", ",");

/**
 * VER-06 для одного упоминания: надпись размера против измерения (label_value ↔ measured_value) и внешние свидетели
 * (ведомость проёмов против ширины по дуге, спецификация против счёта знаков). Первое противоречие — результат;
 * согласие — null (уверенность при согласии не растёт).
 */
export function secondSourceIssue(m: GeomMention, witnesses: Witness[], gates: GeomGates): Contradiction | null {
  const tol = gates.ver06[m.measure];
  if (m.label_value !== null && m.measured_value !== null && !agrees(m.label_value, m.measured_value, tol)) {
    return { kind: "conflict", why: `надпись ${fmt(m.label_value)} ${m.unit} расходится с измерением по чертежу ${fmt(m.measured_value)} ${m.unit} (${m.key || m.entity}, стр. ${m.page})` };
  }
  const own = m.measured_value ?? m.value;
  if (own === null) return null;
  for (const w of witnesses) {
    const v = inUnit(w.value, w.unit, m.unit);
    const where = `${SRC[w.source]}${w.document_code ? ` ${w.document_code}` : ""}${w.page !== null ? `, стр. ${w.page}` : ""}`;
    if (v === null) return { kind: "units", why: `${where}: единица «${w.unit}» несопоставима с «${m.unit}» (${m.key || m.entity})` };
    if (!agrees(v, own, tol)) return { kind: "conflict", why: `${where} — ${fmt(v)} ${m.unit}, по чертежу ${fmt(own)} ${m.unit} (${m.key || m.entity}, стр. ${m.page})` };
  }
  return null;
}

// ─────────────────────────────── VER-10 калибровка: изотоническая регрессия (PAV) и порог под Precision

export interface Scored {
  score: number;
  label: 0 | 1; // 1 — кандидат подтверждён разметкой validation
}

/**
 * Изотоническая регрессия (pool adjacent violators): неубывающая оценка P(label = 1 | score). Узлы — различные
 * значения score по возрастанию, значение узла — среднее блока, в который он слит.
 */
export function isotonic(points: Scored[]): { x: number[]; y: number[] } {
  const byScore = new Map<number, { sum: number; w: number }>();
  for (const p of points) {
    if (!Number.isFinite(p.score)) throw new Error(`VER-10: score калибровки не число: ${p.score}`);
    const g = byScore.get(p.score) ?? { sum: 0, w: 0 };
    g.sum += p.label;
    g.w += 1;
    byScore.set(p.score, g);
  }
  const xs = [...byScore.keys()].sort((a, b) => a - b);
  const blocks: Array<{ sum: number; w: number; n: number }> = []; // n — число узлов в блоке
  for (const x of xs) {
    const g = byScore.get(x)!;
    blocks.push({ sum: g.sum, w: g.w, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.w <= b.sum / b.w) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, n: a.n + b.n });
    }
  }
  const y = blocks.flatMap((b) => Array<number>(b.n).fill(b.sum / b.w));
  return { x: xs, y };
}

/** Калиброванная вероятность: линейно между узлами, за краями — значение крайнего узла. */
export function calibrate(c: { x: number[]; y: number[] }, score: number): number {
  const { x, y } = c;
  if (score <= x[0]) return y[0];
  if (score >= x[x.length - 1]) return y[y.length - 1];
  let i = 1;
  while (x[i] < score) i++;
  const t = (score - x[i - 1]) / (x[i] - x[i - 1]);
  return y[i - 1] + t * (y[i] - y[i - 1]);
}

/**
 * Порог калиброванной вероятности: наименьший t, при котором Precision кандидатов с p ≥ t на validation не ниже
 * target + margin (запас на разницу validation и боя). Недостижимо или выборка пуста — null.
 */
export function thresholdFor(points: Scored[], c: { x: number[]; y: number[] }, target: number, margin: number): number | null {
  const ps = points.map((p) => ({ p: calibrate(c, p.score), label: p.label }));
  const cuts = [...new Set(ps.map((q) => q.p))].sort((a, b) => a - b);
  for (const t of cuts) {
    const sel = ps.filter((q) => q.p >= t);
    const prec = sel.reduce((s, q) => s + q.label, 0) / sel.length;
    if (prec >= target + margin - 1e-12) return t;
  }
  return null;
}

/** Кривая и порог оператора по validation-части набора разработки — строка таблицы geom-calibration.json. */
export function fitCalibration(points: Scored[], target = 0.9, margin = 0.02, fitted_on = "validation"): CalibrationCurve {
  if (!points.length) throw new Error("VER-10: калибровка по пустой выборке невозможна");
  const c = isotonic(points);
  return { ...c, threshold: thresholdFor(points, c, target, margin), target_precision: target, margin, n: points.length, fitted_on };
}

// ─────────────────────────────── VER-09 вердикт VLM по двум кропам (строгий JSON)

/** Ответ VLM: строго два поля; лишнее поле, другое значение, длинная цитата — громкий отказ (OWASP LLM05). */
export const VlmVerdictSchema = z.strictObject({
  claim_supported: z.enum(["yes", "no", "unreadable"]),
  quote: z.string().max(500),
});
export type VlmVerdict = z.infer<typeof VlmVerdictSchema>;

/** Кроп для VLM: из фрагмента доказательства кандидата, не из произвольного входа (OWASP-0185). */
export interface ClaimCrop {
  sha256: string;
  page: number;
  bbox: [number, number, number, number];
  role: "expected" | "actual";
}

/** Кропы VER-09 — первый ожидаемый и первый фактический фрагменты кандидата с рамкой; нет пары — null. */
export function claimCrops(ev: Evaluation): [ClaimCrop, ClaimCrop] | null {
  const pick = (role: Fragment["kind"]): ClaimCrop | null => {
    const f = ev.fragments.find((x) => x.kind === role && x.bbox !== null);
    return f ? { sha256: f.sha256, page: f.page, bbox: f.bbox!, role } : null;
  };
  const e = pick("expected");
  const a = pick("actual");
  return e && a ? [e, a] : null;
}

/** Закрытый вопрос VER-09 — шаблон и данные кандидата, без свободного текста (OWASP-0184). */
export type ClaimSpec =
  | { kind: "marks_in_room"; room: string; marks: string[] }
  | { kind: "mark_present"; mark: string }
  | { kind: "value_at"; mark: string; value: number; unit: GeomUnit };

/** Подстановка — марка или номер: буквы, цифры, «.,-/», до 24 знаков, без пробелов, переводов строк и управляющих. */
export const CLAIM_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}.,\-/]{0,23}$/u;
export const MAX_CLAIM_MARKS = 10;

export class ClaimSpecError extends Error {}

export function claimQuestion(c: ClaimSpec): string {
  const tok = (s: string) => {
    if (!CLAIM_TOKEN.test(s)) throw new ClaimSpecError(`VER-09: подстановка вне белого списка (длина ${s.length})`);
    return s;
  };
  if (c.kind === "marks_in_room") {
    if (!c.marks.length || c.marks.length > MAX_CLAIM_MARKS) throw new ClaimSpecError(`VER-09: марок в вопросе от 1 до ${MAX_CLAIM_MARKS}`);
    return `Есть ли в границах помещения ${tok(c.room)} подписи ${c.marks.map(tok).join(", ")}?`;
  }
  if (c.kind === "mark_present") return `Есть ли на фрагменте подпись ${tok(c.mark)}?`;
  if (!Number.isFinite(c.value) || !GEOM_UNITS.includes(c.unit)) throw new ClaimSpecError("VER-09: значение в вопросе не число или единица вне справочника");
  return `Указано ли у ${tok(c.mark)} значение ${fmt(c.value)} ${c.unit}?`;
}

// ─────────────────────────────── слой

function lowerer<E extends Evaluation>(ev: GeomEvaluation<E>, origin: string) {
  return (op: string, to: FindingStatus, why: string, code: string | null, suspicion = false): void => {
    if (!GEOM_LOWER_TO[ev.status].includes(to)) return;
    ev.geom.steps.push({ op, from: ev.status, to, reason_code: code, why, ...(suspicion ? { suspicion: true } : {}) });
    ev.geom.reason_code = code;
    if (suspicion && !ev.geom.flags.includes("SUSPICION")) ev.geom.flags.push("SUSPICION");
    ev.status = to;
    ev.reason = `${why} (${op}). Оператор: ${origin}`;
  };
}

const withTrace = <E extends Evaluation>(input: E): GeomEvaluation<E> => {
  const prev = (input as { geom?: GeomTrace }).geom;
  const geom: GeomTrace = prev ? { ops: [...prev.ops], steps: [...prev.steps], reason_code: prev.reason_code, flags: [...prev.flags] } : { ops: [], steps: [], reason_code: null, flags: [] };
  return { ...input, geom };
};

/**
 * Понижающий слой геометрии: VER-04 → VER-06 → VER-10. Каждая проверка смотрит на текущий статус; воздержание дальше
 * не понижается. Фрагменты без геометрии (текст, таблица) слой не касается.
 */
export function verifyGeom<E extends Evaluation>(input: E, ctx: GeomContext): GeomEvaluation<E> {
  const ev = withTrace(input);
  const lower = lowerer(ev, input.reason);
  const geo = ev.fragments.map((f) => ({ f, m: ctx.geom(f) })).filter((x): x is { f: Fragment; m: GeomMention } => x.m !== null);

  // VER-04 регистрация и масштаб: ненадёжная геометрия не даёт ни кандидата, ни отрицательного результата
  // (воздержание дальше не понижается — это решает lowerer по GEOM_LOWER_TO, отдельной проверки статуса нет)
  ev.geom.ops.push("VER-04");
  const bad = geo.map(({ m }) => registrationIssue(m, ctx.gates, ctx.op)).find((w) => w !== null);
  if (bad) lower("VER-04", "NOT_COMPARABLE", `Геометрия несопоставима: ${bad}`, "NOT_COMPARABLE");
  // VER-06 второе свидетельство: противоречие — к инспектору с пометкой SUSPICION, несопоставимые единицы — воздержание
  ev.geom.ops.push("VER-06");
  for (const { f, m } of geo) {
    const c = secondSourceIssue(m, ctx.witnesses?.(f, m) ?? [], ctx.gates);
    if (!c) continue;
    if (c.kind === "units") lower("VER-06", "NOT_COMPARABLE", `Второе свидетельство несопоставимо: ${c.why}`, "NOT_COMPARABLE");
    else lower("VER-06", "CLARIFICATION_REQUIRED", `Второй источник противоречит значению: ${c.why}`, "SECOND_SOURCE_CONFLICT", true);
    break;
  }
  // VER-10 калибровка уверенности: только кандидат (Precision считается по кандидатам); нет кривой — тождественно
  ev.geom.ops.push("VER-10");
  const curve = ctx.calibration.ops[ctx.op];
  if (ev.status === "CANDIDATE" && curve) {
    if (ctx.score === null) lower("VER-10", "CLARIFICATION_REQUIRED", `Уверенность ${ctx.op} не известна — калибровку применить нельзя`, "LOW_CONFIDENCE", true);
    else {
      const p = calibrate(curve, ctx.score);
      if (curve.threshold === null) lower("VER-10", "CLARIFICATION_REQUIRED", `Для ${ctx.op} на validation недостижима Precision ${curve.target_precision} с запасом ${curve.margin}`, "LOW_CONFIDENCE", true);
      else if (p < curve.threshold - 1e-12) lower("VER-10", "CLARIFICATION_REQUIRED", `Калиброванная уверенность ${fmt(p)} ниже порога ${fmt(curve.threshold)} (${ctx.op}, Precision ≥ ${curve.target_precision})`, "LOW_CONFIDENCE", true);
    }
  }
  return ev;
}

/**
 * VER-09: вердикт VLM по двум кропам применяется к кандидату. no → к инспектору с пометкой SUSPICION (не
 * NEGATIVE_VERIFIED: VLM отрицательный вывод не делает), unreadable → NOT_COMPARABLE, yes → без изменений
 * (уверенность не растёт). Прочие статусы вердикт не трогает.
 */
export function applyVlm<E extends Evaluation>(input: E, verdict: VlmVerdict): GeomEvaluation<E> {
  const ev = withTrace(input);
  ev.geom.ops.push("VER-09");
  if (ev.status !== "CANDIDATE") return ev;
  const q = verdict.quote ? ` VLM: «${verdict.quote}»` : "";
  const lower = lowerer(ev, input.reason);
  if (verdict.claim_supported === "no") lower("VER-09", "CLARIFICATION_REQUIRED", `VLM по кропам не подтверждает расхождение.${q}`, "VLM_NOT_SUPPORTED", true);
  else if (verdict.claim_supported === "unreadable") lower("VER-09", "NOT_COMPARABLE", `VLM не смогла прочитать кропы.${q}`, "VLM_UNREADABLE");
  return ev;
}

/** VER-09 не выполнен (бюджет вызовов исчерпан): шаг без изменения статуса — инспектор видит, что VLM не спрашивалась. */
export function noteVlm<E extends Evaluation>(input: E, why: string): GeomEvaluation<E> {
  const ev = withTrace(input);
  ev.geom.ops.push("VER-09");
  ev.geom.steps.push({ op: "VER-09", from: ev.status, to: ev.status, reason_code: null, why });
  return ev;
}
