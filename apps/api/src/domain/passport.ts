// Паспорт параметра Матрицы (T-129, OS-INSP-7.1.3–7.1.6): общий шаблон этапов + шаги параметра + метрики единого вида.
// Данные — data/seed/passports/*.json (объект DO-PASSPORT), справочник операций — data/seed/catalog-ops.json.
import { z } from "zod";
import { NOT_DESIGN_SOURCE } from "./doctype.ts";
import type { ClassPassport } from "./class-param.ts";
import type { QuantityPassport } from "./quantity-param.ts";
import type { Stage } from "./types.ts";
import "./kinds/index.ts"; // T-186: виды из реестра регистрируются до построения схемы паспорта
import { disciplineKey, kindOf, kindSlice, kindSpec, registeredKinds, sealKinds } from "./param-kinds.ts";

export { disciplineKey };

/**
 * Варианты объединения по kind: встроенные + зарегистрированные в реестре видов (T-186, OS-INSP-7.1.20). Тип — только
 * встроенных: код вида из реестра читает свой value своей схемой. После построения реестр закрыт (sealKinds).
 */
function withKinds<const T extends readonly [z.ZodType, ...z.ZodType[]]>(field: "value" | "extractor", builtin: T): T {
  sealKinds();
  return [...builtin, ...registeredKinds().map((k) => k[field])] as unknown as T;
}

const Step = z.object({ ops: z.array(z.string()).default([]), how: z.string(), fail: z.string() });

export const CommonPassport = z.object({
  version: z.string(),
  stages: z.array(z.object({ key: z.string(), n: z.string(), title: z.string(), ops: z.array(z.string()), how: z.string(), fail: z.string(), param: z.boolean().optional() })).min(1),
  statuses: z.record(z.string(), z.string()),
  metrics: z.array(z.object({ key: z.string(), title: z.string(), how: z.string() })).min(1),
});
export type CommonPassport = z.infer<typeof CommonPassport>;

const ScaleDimSchema = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("number") }),
  z.object({ name: z.string(), kind: z.literal("ladder"), tokens: z.array(z.string()).min(2) }),
  z.object({ name: z.string(), kind: z.literal("flags"), tokens: z.array(z.string()).min(1), implies: z.record(z.string(), z.array(z.string())).optional() }),
]);

/** Справочник шкал data/seed/scales.json (T-172, каталог §20.2). */
export const ScalesFile = z.object({
  scales: z.record(z.string(), z.object({ title: z.string(), basis: z.string(), values: z.array(z.string()).min(2), order_note: z.string(), aliases: z.record(z.string(), z.string()).optional(), dims: z.array(ScaleDimSchema).optional() })),
});
export type ScalesFile = z.infer<typeof ScalesFile>;

/**
 * Паспорт со ссылкой на шкалу (value.scale_ref, OS-INSP-3.1.30) получает шкалу, написания, измерения и текст порядка
 * из справочника; собственные поля паспорта сильнее справочника. Неизвестная шкала — громкий отказ, а не пустая шкала.
 */
export function resolveScaleRef(raw: any, scales: ScalesFile): any {
  const ref = raw?.value?.scale_ref;
  if (!ref) return raw;
  const sc = scales.scales[ref];
  if (!sc) throw new Error(`паспорт ${raw.code}: шкалы ${ref} нет в data/seed/scales.json`);
  const own = raw.value;
  return { ...raw, value: { ...own, scale: own.scale ?? sc.values, order_note: own.order_note ?? sc.order_note, aliases: { ...(sc.aliases ?? {}), ...(own.aliases ?? {}) }, ...(sc.dims || own.dims ? { dims: own.dims ?? sc.dims } : {}) } };
}

const Exclude = z.object({ code: z.string(), pattern: z.string(), why: z.string(), scope: z.enum(["between", "mention", "value", "sentence"]).optional() }); // mention — количества (T-173), value — классы (T-172)
const Source = z.object({ discipline: z.string().min(1), label: z.string().optional() });
// T-173 (OS-INSP-3.1.41, CMP-06): предел нормы; value — из паспорта, иначе только из документа (упоминание-предел).
// T-211 (OS-INSP-3.1.141, 3.1.145): несколько норм одного показателя (max и min уклона) и норма у аспекта
const Norm = z.object({ kind: z.enum(["max", "min"]), value: z.number().nullable().default(null), basis: z.string().min(1), level: z.enum(["fail", "warn"]).optional(), code: z.string().optional() });
const Turn = z.object({ code: z.string().min(1), level: z.enum(["none", "suspicion", "candidate"]) });
const Norms = z.union([Norm, z.array(Norm).min(1)]);
const Unitless = z.object({ max: z.number(), factor: z.number().positive() });

// T-186: варианты value и extractor — встроенные плюс виды из реестра (withKinds); части паспорта (T-174) берут те же union
const Value = z.discriminatedUnion("kind", withKinds("value", [
  z.object({
    kind: z.literal("ordinal"),
    scale: z.array(z.string()).min(2),
    order_note: z.string(),
    constraint_markers: z.array(z.string()),
    // T-172 (OS-INSP-2.2.40, 3.1.30–3.1.34): шкала из data/seed/scales.json, написания → канон, частичный порядок, CMP-26
    scale_ref: z.string().optional(),
    aliases: z.record(z.string(), z.string()).optional(),
    dims: z.array(ScaleDimSchema).optional(),
    cert_match: z.boolean().optional(),
    // OS-INSP-2.2.49: иные системы классификации (КМ → Г, В, Д, Т, РП после 14.07.2022) — отсев ALT_SYSTEM
    alt_systems: z.array(z.object({ code: z.string(), pattern: z.string(), why: z.string() })).optional(),
  }),
  z.object({
    kind: z.literal("quantity"),
    unit: z.string().min(1),
    tolerance_abs: z.number().nonnegative(), // половина разряда точности документа
    tolerance_pct: z.number().nonnegative().optional(), // относительный порог Матрицы (М-002: 1 %)
    // М-003: нарушение — только уменьшение; М-008 (T-173, CMP-03): только рост
    direction: z.enum(["both", "decrease", "increase"]).default("both"),
    bad_direction: z.enum(["up", "down"]).optional(), // при «любом изменении» — какая сторона хуже (CMP-03 в карточке)
    tolerance_note: z.string(),
    norm: Norms.optional(),
    // T-211 (OS-INSP-3.1.142): показатель многих объектов (участки дорог, марши) — норма у каждого значения, пара не угадывается
    multi_object: z.boolean().optional(),
    main_optional: z.boolean().optional(), // T-211 (OS-INSP-3.1.145): нет основного показателя — решают аспекты
    change_codes: z.object({ up: Turn.optional(), down: Turn.optional() }).optional(), // T-211 (OS-INSP-3.1.140): код и уровень по направлению
    ops: z.array(z.string().regex(/^[A-Z]{3}-\d{2}$/)).optional(), // T-211: операции каталога, добавленные паспортом

    // T-173 (OS-INSP-3.1.42): варианты одного оборота — разные показатели («с НДС» / «без НДС»); порядок — приоритет
    variants: z.array(z.object({ code: z.string().min(1), title: z.string().min(1) })).optional(),
    // T-173 (OS-INSP-3.1.44, CMP-18): второй показатель параметра со своей единицей и правилом
    aspects: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z_]+$/),
          title: z.string().min(1),
          unit: z.string().min(1),
          tolerance_abs: z.number().nonnegative(),
          tolerance_pct: z.number().nonnegative().optional(),
          direction: z.enum(["both", "decrease", "increase"]).default("both"),
          optional: z.boolean().default(true),
          norm: Norms.optional(),
          change_codes: z.object({ up: Turn.optional(), down: Turn.optional() }).optional(), // T-211 (OS-INSP-3.1.144)
        }),
      )
      .optional(),
  }),
]));

const Extractor = z.discriminatedUnion("kind", withKinds("extractor", [
  z.object({
    kind: z.literal("class_mentions"),
    anchor: z.string(),
    value: z.string(),
    window: z.number().int().positive(),
    exclude: z.array(Exclude),
    exclude_scope: z.enum(["window", "sentence"]).optional(), // T-172 (OS-INSP-2.2.45): контекст отсева — окно или предложение
    anchor_basis: z.string().optional(), // T-172: откуда синонимы оборота — пункт нормы
    foreign_elements: z.array(z.string().min(1)).optional(), // OS-INSP-2.2.47: конструкции вне паспорта — отсев
    before: z.number().int().nonnegative().optional(), // T-172 (OS-INSP-2.2.41): значение перед оборотом
    elements: z.array(z.object({ key: z.string().min(1), pattern: z.string().min(1) })).optional(), // OS-INSP-2.2.43
  }),
  z.object({
    kind: z.literal("quantity_mentions"),
    anchor: z.string(),
    window: z.number().int().positive().max(300), // окно разбора после оборота: больше — длинные числа и лишний перебор (T173-L2)
    units: z.array(z.string()),
    superscripts: z.array(z.string()),
    fillers: z.array(z.string()),
    stop: z.array(z.string()).default([]),
    max_strangers: z.number().int().nonnegative().optional(),
    exclude: z.array(Exclude),
    column: z.object({ head: z.string(), over: z.string(), confidence: z.number().min(0).max(1) }).optional(),
    // T-173 (OS-INSP-2.2.51, NRM-02): единица — строка (множитель 1) или {text, factor} — пересчёт к единице паспорта
    units_table: z.array(z.object({ text: z.string().min(1), factor: z.number().positive() })).optional(),
    unitless: Unitless.optional(), // «0,42» без «%» → 42 %
    // T-211 (OS-INSP-2.2.131–2.2.133): значение без единицы не берётся; целое для счёта; номер строки таблицы — не отсекать
    // (у уклона и ступеней малое целое — значение); разные значения на одном листе — отсев, а не выбор
    unit_required: z.boolean().optional(),
    integer: z.boolean().optional(),
    row_numbers: z.boolean().optional(),
    plausible: z.tuple([z.number(), z.number()]).optional(), // VER-13: правдоподобный диапазон после пересчёта единиц
    one_per_page: z.boolean().optional(),
    // T-211 (OS-INSP-2.2.130, 2.2.132, 2.2.133): марка объекта, таблица через «|», OCR «О» вместо нуля и число словом, пара «150х300»
    objects: z.string().optional(),
    stop_after: z.array(z.string()).optional(),
    table: z.boolean().optional(),
    ocr_digits: z.boolean().optional(),
    number_words: z.boolean().optional(),
    x_pairs: z.boolean().optional(),
    signed: z.boolean().optional(), // T-173 (OS-INSP-2.2.52): отметки со знаком «+68,410», «−4,200», «±0,000»
    page_unit: z.boolean().optional(), // T-173 (NRM-02): единица из шапки страницы, если у значения её нет и масштаб один
    negate_if: z.string().optional(), // T-173 (OS-INSP-2.2.52): оборот задаёт знак числа без знака («глубина заложения»)
    limit_anchor: z.string().optional(), // T-173 (OS-INSP-2.2.53, CMP-06): оборот предельного значения нормы
    variants: z.array(z.object({ code: z.string().min(1), pattern: z.string().min(1), on: z.enum(["anchor"]).optional(), page: z.string().optional() })).optional(),
    aspects: z.array(z.object({ key: z.string().regex(/^[a-z_]+$/), anchor: z.string().min(1), units: z.array(z.string()).optional(), units_table: z.array(z.object({ text: z.string().min(1), factor: z.number().positive() })).optional(), signed: z.boolean().optional(), negate_if: z.string().optional(), exclude: z.array(Exclude).optional(), unitless: Unitless.optional(), unit_required: z.boolean().optional(), integer: z.boolean().optional(), plausible: z.tuple([z.number(), z.number()]).optional() })).optional(),
  }),
]));

export const ParamPassport = z.object({
  code: z.string().regex(/^M-\d{3}$/),
  version: z.string(),
  title: z.string(),
  summary: z.string(),
  basis: z.string(),
  // T-132: второй вид паспорта — количественный показатель (М-001): единица, допуск, извлечение всех упоминаний числа
  value: Value,
  extractor: Extractor,
  sources: z.object({ PD: z.array(Source), RD: z.array(Source), ID: z.array(Source) }),
  link: z.object({ by: z.enum(["base_cipher", "none"]), note: z.string() }),
  // T-173 (OS-INSP-2.2.54): виды документа, которые для параметра — источник, хотя по 2.2.7 не источник (М-132 — смета)
  source_doc_types: z.array(z.enum(NOT_DESIGN_SOURCE)).optional(), // опечатка — громкий отказ, а не молча выключенное исключение (T173-I1)
  steps: z.record(z.string(), Step),
  outcomes: z.array(z.object({ when: z.string(), status: z.string(), why: z.string() })),
});
export type ParamPassport = z.infer<typeof ParamPassport>;

export type OpsCatalog = Record<string, { title: string; layer: string; layer_title: string; n: string }>;

export interface StageView {
  key: string;
  n: string;
  title: string;
  ops: Array<{ id: string; title: string }>;
  how: string;
  fail: string;
  param_specific: boolean;
}

/**
 * Шаги алгоритма (OS-INSP-7.1.6): этапы общего шаблона по порядку; этап, помеченный param, берёт описание и операции
 * из паспорта параметра, если они там есть. Неизвестная операция — ошибка данных, а не пустая подпись.
 */
export function mergeStages(common: CommonPassport, pp: ParamPassport | null, catalog: OpsCatalog): StageView[] {
  return common.stages.map((s) => {
    const own = s.param && pp ? pp.steps[s.key] : undefined;
    const ids = own ? [...new Set([...own.ops, ...s.ops])] : s.ops;
    for (const id of ids) if (!catalog[id]) throw new Error(`паспорт: операции ${id} нет в каталоге TO-BE`);
    return { key: s.key, n: s.n, title: s.title, ops: ids.map((id) => ({ id, title: catalog[id].title })), how: own?.how ?? s.how, fail: own?.fail ?? s.fail, param_specific: Boolean(own) };
  });
}

/** Конфигурация сравнения для domain/class-param.ts. null — паспорт не порядковый. */
export function classPassport(pp: ParamPassport): ClassPassport | null {
  if (pp.value.kind !== "ordinal") return null;
  return {
    scale: pp.value.scale,
    sources: pp.sources as Record<Stage, Array<{ discipline: string }>>,
    link: pp.link.by === "base_cipher" ? "base_cipher" : null,
    dims: pp.value.dims ?? null,
    per_element: pp.extractor.kind === "class_mentions" && Boolean(pp.extractor.elements?.length),
    cert_match: pp.value.cert_match === true,
    order_note: pp.value.order_note,
  };
}

/** Конфигурация сравнения для domain/quantity-param.ts (T-132). null — паспорт не количественный. */
export function quantityPassport(pp: ParamPassport): QuantityPassport | null {
  if (pp.value.kind !== "quantity") return null;
  const v = pp.value;
  const scales = [...new Set([1, ...(pp.extractor.kind === "quantity_mentions" ? (pp.extractor.units_table ?? []).map((u) => u.factor) : [])])];
  return {
    unit: v.unit, tolerance: v.tolerance_abs, tolerance_pct: v.tolerance_pct ?? 0, direction: v.direction, sources: pp.sources as QuantityPassport["sources"], link: pp.link.by === "base_cipher" ? "base_cipher" : null,
    ...(v.bad_direction ? { bad_direction: v.bad_direction } : {}),
    ...(v.norm ? { norm: v.norm } : {}),
    ...(v.variants ? { variants: v.variants } : {}),
    ...(scales.length > 1 ? { unit_scales: scales } : {}),
    ...(v.multi_object ? { multi_object: true } : {}),
    ...(v.main_optional ? { main_optional: true } : {}),
    ...(v.change_codes ? { change_codes: v.change_codes } : {}),
    ...(v.ops ? { ops: v.ops } : {}),
    ...(v.aspects ? { aspects: v.aspects.map((a) => ({ key: a.key, title: a.title, unit: a.unit, tolerance: a.tolerance_abs, tolerance_pct: a.tolerance_pct ?? 0, direction: a.direction, optional: a.optional, ...(a.norm ? { norm: a.norm } : {}), ...(a.change_codes ? { change_codes: a.change_codes } : {}) })) } : {}),
  };
}

/** Виды документа — источник значения параметра вопреки OS-INSP-2.2.7 (T-173, OS-INSP-2.2.54). */
export const sourceDocTypes = (pp: ParamPassport): string[] => pp.source_doc_types ?? [];
/**
 * Класс конструкции из ответа ML (OS-INSP-2.2.43): только ключ, объявленный в паспорте. ML читает недоверенные PDF —
 * чужая строка в ключ сравнения и в карточку не попадает (OWASP-аудит T-172).
 */
export function elementOf(pp: ParamPassport, raw: unknown): string | null {
  if (pp.extractor.kind !== "class_mentions" || typeof raw !== "string") return null;
  return pp.extractor.elements?.some((e) => e.key === raw) ? raw : null;
}

/** Спецификация экстрактора для ML /analyze (ParamSpec.extractor): паспорт + шкала и маркеры ограничения у класса. */
export function extractorSpec(pp: ParamPassport): Record<string, unknown> {
  if (pp.value.kind === "ordinal") return { ...pp.extractor, scale: pp.value.scale, constraint_markers: pp.value.constraint_markers, ...(pp.value.aliases ? { aliases: pp.value.aliases } : {}), ...(pp.value.alt_systems ? { alt_systems: pp.value.alt_systems } : {}) };
  const kd = kindOf(pp.value.kind, pp.code); // T-186: вид из реестра — своя спецификация
  return kd ? kindSpec(kd, kindSlice(pp)) : { ...pp.extractor };
}

export interface MetricInput {
  checks: number;
  statuses: Record<string, number>;
  decisions: Record<string, number>;
  coverage: Record<Stage, { used: number; loaded: number }>;
  confidence: number | null;
  verification: { verdict: string; object_id: string | null; checked_at: string } | null;
}

const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
const DECISION_RU: Record<string, string> = { CONFIRMED_VIOLATION: "подтверждено инспектором", NEGATIVE_VERIFIED: "отклонено инспектором", CLARIFICATION_REQUIRED: "запрошено уточнение", PENDING: "ждёт решения" };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)} %` : "—");

/** Таблица метрик единого вида (OS-INSP-7.1.4): одинаковые строки для любого параметра, значения — словами. */
export function metricRows(common: CommonPassport, x: MetricInput) {
  const value: Record<string, { value: string; rows?: Array<{ label: string; value: string }> }> = {
    checks: { value: String(x.checks) },
    statuses: { value: x.checks ? "" : "—", rows: Object.entries(x.statuses).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: common.statuses[k] ?? k, value: String(n) })) },
    decisions: { value: x.checks ? "" : "—", rows: Object.entries(x.decisions).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: DECISION_RU[k] ?? k, value: String(n) })) },
    coverage: { value: "", rows: (Object.keys(STAGE_RU) as Stage[]).map((s) => ({ label: STAGE_RU[s], value: x.coverage[s].loaded ? `${pct(x.coverage[s].used, x.coverage[s].loaded)} (${x.coverage[s].used} из ${x.coverage[s].loaded})` : "стадия не загружалась" })) },
    confidence: { value: x.confidence === null ? "—" : x.confidence.toFixed(2).replace(".", ",") },
    verification: { value: x.verification ? `${x.verification.verdict === "MATCH" ? "совпало" : "расхождение"} · ${x.verification.object_id ?? "—"} · ${x.verification.checked_at.slice(0, 10)}` : "не проводилась" },
  };
  return common.metrics.map((m) => ({ key: m.key, title: m.title, how: m.how, value: value[m.key]?.value ?? "—", ...(value[m.key]?.rows ? { rows: value[m.key].rows } : {}) }));
}

/**
 * Совпадение значения системы и оракула при верификации (OS-INSP-6.5.9): без учёта пробелов по краям, регистра и
 * латинской «C» вместо кириллической «С» в классе. Оба null — совпали (оба не нашли значение).
 */
export function sameValue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const n = (x: string) => x.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase().replace(/C/g, "С");
  return n(a) === n(b);
}
