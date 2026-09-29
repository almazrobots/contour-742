// Счётный параметр по паспорту (T-175, CMP-07): этажность (М-007), количество квартир (М-010) и другие «штуки».
// Каталог TO-BE: ENT-15 (ТЭП), NRM-01 (число), LNK-01, VER-15, GTE-01…03, CMP-07 (целые без допуска),
// CMP-30 (двойной подсчёт внутри стадии), DEC-01 (provenance). Правила — OS-INSP-2.2.60, 2.2.61, 3.1.50, 3.1.51.
// Выбор значения стадии, ворота и формулировки — общие с количественным параметром (quantity-param.ts): здесь только
// то, чем счёт отличается от меры, — целое число, ноль допуска и источник подсчёта (текст, таблица, чертёж, расчёт).
// CMP-07 и CMP-10 — общие для всех волн (W2 T-193 подаёт подсчёт по чертежу, W3 М-048 — ступени): источник подсчёта —
// поле упоминания, новый источник — новое значение CountSource, а не новый оператор.
import type { ClassEvaluation, MentionUse } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import type { ParamPassport } from "./passport.ts";
import { fmtNum, needOf, pickQuantity, valueList, type QuantityMention, type QuantityPassport, type QuantityPick } from "./quantity-param.ts";
import type { Evaluation, Fragment, Param, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

/** Источник подсчёта (OS-INSP-2.2.61): текст ТЭП или ПЗ, таблица (строка, колонка, итог), подсчёт по чертежу, расчёт. */
export type CountSource = "text" | "table" | "drawing" | "computed";
export const COUNT_SOURCE_RU: Record<CountSource, string> = { text: "текст", table: "таблица", drawing: "подсчёт по чертежу", computed: "расчёт" };

export interface CountMention extends QuantityMention {
  count_source: CountSource;
}

export interface CountPassport {
  unit: string;
  sources: QuantityPassport["sources"];
  link: "base_cipher" | null;
}

export interface CountSuspicion {
  stage: Stage;
  description: string;
  mentions: CountMention[];
  dedup_key: string;
}

export interface CountEvaluation extends Evaluation {
  suspicions: CountSuspicion[];
  provenance: ClassEvaluation["provenance"];
}

export const COUNT_OPS = ["ENT-15", "NRM-01", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-07", "CMP-30", "DEC-01"];
const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
const NOT_INTEGER_WHY = "не целое число — количеством не считается";

/** Конфигурация сравнения из паспорта вида count. null — паспорт другого вида. */
export function countPassport(pp: Pick<ParamPassport, "sources" | "link"> & { value: { kind: string; unit?: string } }): CountPassport | null {
  if (pp.value.kind !== "count") return null;
  return { unit: pp.value.unit ?? "шт.", sources: pp.sources as CountPassport["sources"], link: pp.link.by === "base_cipher" ? "base_cipher" : null };
}

const COUNT_SOURCES = new Set<CountSource>(["text", "table", "drawing", "computed"]);

/** Источник подсчёта упоминания из meta ML (OS-INSP-2.2.61): явный count_source, иначе число из колонки таблицы — таблица, иначе текст. */
export function countSourceOf(meta: unknown): CountSource {
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  if (COUNT_SOURCES.has(m.count_source as CountSource)) return m.count_source as CountSource;
  return m.table === "column" ? "table" : "text";
}

/** Счёт — это выбор источника без допуска: общий выбор значения стадии из quantity-param с нулевым допуском. */
const asQuantity = (p: CountPassport): QuantityPassport => ({ unit: p.unit, tolerance: 0, tolerance_pct: 0, direction: "both", sources: p.sources, link: p.link });

/** OS-INSP-2.2.60: количество — целое неотрицательное; иное отсеивается с причиной (прежний отсев не перезаписывается). */
export function wholeOnly(ms: CountMention[]): CountMention[] {
  return ms.map((m) => (m.excluded === null && !(Number.isInteger(m.num) && m.num >= 0) ? { ...m, excluded: "NOT_INTEGER", excluded_why: NOT_INTEGER_WHY } : m));
}

const where = (m: CountMention) => m.discipline ?? m.document_code;

/**
 * OS-INSP-3.1.51 (CMP-07, CMP-30): двойной подсчёт — внутри стадии одно количество получено по-разному. Гипотеза
 * перечисляет значения по источникам подсчёта; null — одно значение или все подсчёты совпали.
 */
export function doubleCount(considered: CountMention[], stage: Stage): CountSuspicion | null {
  if (new Set(considered.map((m) => m.num)).size < 2) return null;
  const bySource = new Map<CountSource, CountMention[]>();
  for (const m of considered) bySource.set(m.count_source, [...(bySource.get(m.count_source) ?? []), m]);
  const parts = [...bySource.entries()].map(([src, ms]) => `${COUNT_SOURCE_RU[src]}: ${valueList(ms)}`);
  const firstOf = new Map<number, CountMention>();
  for (const m of considered) if (!firstOf.has(m.num)) firstOf.set(m.num, m);
  return {
    stage,
    description: `Двойной подсчёт ${STAGE_RU[stage]}: количество получено по-разному — ${parts.join("; ")}`,
    mentions: considered,
    dedup_key: `count-conflict:${stage}:${[...firstOf.values()].map((m) => `${m.file_id}@${m.page}:${m.num}`).sort().join("|")}`,
  };
}

function frag(m: CountMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: fmtNum(m.num), kind };
}

export interface CountEvalInput {
  param: Param;
  passport: CountPassport;
  mentions: CountMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  kitBases: Set<string>;
  pdKitPresent?: boolean;
}

const signed = (d: number) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "0");

export function evaluateCountParam({ param, passport, mentions: raw, loadedStages, profile, kitBases, pdKitPresent = false }: CountEvalInput): CountEvaluation {
  const mentions = wholeOnly(raw);
  const qp = asQuantity(passport);
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickQuantity(mentions, s, qp, kitBases, pdKitPresent)])) as Record<Stage, QuantityPick>;
  const chosen = (s: Stage) => picks[s].chosen as CountMention | null;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : chosen(s) ? "USED" : "NO_VALUE";
  const provenance: CountEvaluation["provenance"] = {
    ops: COUNT_OPS,
    mentions: STAGES.flatMap((s) => {
      const pk = picks[s];
      const use = (m: QuantityMention): [MentionUse, string | null] =>
        m === pk.chosen ? ["chosen", pk.note] : pk.dropped.includes(m) ? ["dropped", m.excluded_why ?? "устаревшая редакция"] : pk.reference.includes(m) ? ["reference", "другой комплект ПД — шифр не совпадает с РД пакета"] : ["considered", null];
      return mentions.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        return {
          stage: s, use: u, why, value: `${fmtNum(m.num)} ${passport.unit}`, qualifier: null, count_source: COUNT_SOURCE_RU[m.count_source], discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: null, reader_outcome: null, judge: null,
        };
      });
    }),
  };
  const conflicts = new Map<Stage, CountSuspicion>();
  for (const s of STAGES) {
    const c = doubleCount(picks[s].considered as CountMention[], s);
    if (c) conflicts.set(s, c);
  }
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions: [...conflicts.values()], provenance };

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const used = STAGES.filter((s) => notes[s] === "USED").map((s) => chosen(s)!);
  // 2. Актуальность редакций (GTE-03)
  const disputed = used.filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(m, "actual")) };
  }
  // 3. Комплектность (GTE-02)
  if (used.length < 2) {
    const need = STAGES.filter((s) => notes[s] === "NO_VALUE" || (!loadedStages.includes(s) && stageRequired(param, s))).map((s) => `${STAGE_RU[s]}: ${needOf(qp, s)}${loadedStages.includes(s) ? " — количества нет" : " — стадия не загружена"}`);
    const found = used.length ? `${STAGE_RU[used[0].stage]} — ${fmtNum(used[0].num)} ${passport.unit} (${valueList(picks[used[0].stage].considered)})` : "количество не найдено ни в одной стадии";
    return { ...base, status: "MISSING_EVIDENCE", expected: used[0] ? fmtNum(used[0].num) : null, reason: `Сравнить не с чем: ${found}.${need.length ? ` Запросите ${need.join("; ")}.` : ""}`, fragments: used.map((m) => frag(m, "expected")) };
  }
  // 4. Сравнение (CMP-07): эталон — самая ранняя стадия, любое отличие целых — расхождение; худшее — по модулю
  const [exp, ...later] = used;
  let worst: CountMention | null = null;
  for (const m of later) if (m.num !== exp.num && (!worst || Math.abs(m.num - exp.num) > Math.abs(worst.num - exp.num))) worst = m;
  const fragments = [frag(exp, "expected"), ...later.map((m) => frag(m, "actual"))];
  const act = worst ?? later[later.length - 1];
  const delta = `${signed(act.num - exp.num)} ${passport.unit}`;
  if (!worst) return { ...base, status: "NEGATIVE_VERIFIED", expected: fmtNum(exp.num), actual: fmtNum(act.num), delta, reason: `${param.parameter_name}: количество совпало (${fmtNum(exp.num)} ${passport.unit})`, fragments };
  const what = `${STAGE_RU[worst.stage]} (${where(worst)}, стр. ${worst.page}) ${worst.num > exp.num ? "больше" : "меньше"} ${STAGE_RU[exp.stage]} (${where(exp)}, стр. ${exp.page}) на ${Math.abs(worst.num - exp.num)} ${passport.unit}`;
  // OS-INSP-3.1.51: подсчёт внутри участвующей стадии расходится — кандидат не ставится, вывод понижается до уточнения
  const shaky = [exp.stage, worst.stage].filter((s) => conflicts.has(s));
  if (shaky.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", expected: fmtNum(exp.num), actual: fmtNum(worst.num), delta, reason: `${what}, но подсчёт внутри ${shaky.map((s) => STAGE_RU[s]).join(" и ")} расходится — сначала уточните количество в самой стадии. Подсчёт внутри ${STAGE_RU[shaky[0]]} расходится: ${conflicts.get(shaky[0])!.description.replace(/^[^—]+— /, "")}`, fragments };
  }
  return { ...base, status: "CANDIDATE", expected: fmtNum(exp.num), actual: fmtNum(worst.num), delta, reason: `${what}. Правило Матрицы: ${param.trigger_logic}`, fragments };
}
