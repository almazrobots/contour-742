// Вид параметра «geometry» (T-193, ADR-0010, реестр видов T-186): геометрия плана — длины, площади, положения, контуры,
// отношения, топология и счёт знаков. Схемы value и extractor (geometry_mentions), строки извлечения → упоминания
// GeomRef, оценка — evaluateGeomParam (domain/geom-param.ts). Normative_Base — таблица normative_base (T-234; сид — data/seed/norms.json → base[]). Правила — OS-INSP-2.2.125–2.2.129, 2.4.45–2.4.52, 3.1.110–3.1.124.
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.ts";
import { pickStageSources } from "../discipline-fit.ts";
import type { NormRecord, Predicate } from "../geom-ops.ts";
import { evaluateGeomParam, type GeomPassport, type GeomRef } from "../geom-param.ts";
import { baseMention, registerKind, type KindEvaluation, type KindMention, type KindPassport, type KindRow } from "../param-kinds.ts";
import type { Param, Stage } from "../types.ts";
import { STAGES } from "../types.ts";
import { GEOM_MEASURES, GeomMentionSchema } from "../verify-geom.ts";

// CMP-06: предел нормы — та же форма, что у количественного паспорта T-173 ({kind, value, basis}), плюс ref — запись
// Normative_Base (base[].id): число, пункт СП и правило измерения берутся оттуда
const Norm = z.object({ kind: z.enum(["max", "min"]), value: z.number().nullable().default(null), basis: z.string().min(1), ref: z.string().min(1).optional() });
const Kinds = z.array(z.string()).optional();
// CMP-16: пространственный предикат паспорта
const PredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inside"), of: z.string(), of_kinds: Kinds }), // элемент внутри контура сущности of (ENT-…)
  z.object({ kind: z.literal("intersects"), of: z.string(), of_kinds: Kinds }),
  z.object({ kind: z.literal("distance"), of: z.string(), of_kinds: Kinds, max_mm: z.number().positive() }),
  z.object({ kind: z.literal("covers"), of: z.string(), of_kinds: Kinds, radius_mm: z.number().positive(), step_mm: z.number().positive().default(500) }), // круги точек покрывают контур of
  z.object({ kind: z.literal("max_spacing"), max_mm: z.number().positive() }), // шаг точек не больше
  // у каждого пересечения трассы с преградой (стена вида barrier_kinds) — устройство (знак вида device_kinds) в радиусе
  z.object({ kind: z.literal("near_crossing"), barrier: z.string(), barrier_kinds: Kinds, device: z.string(), device_kinds: Kinds, radius_mm: z.number().positive() }),
]);

export const GeometryValue = z.object({
  kind: z.literal("geometry"),
  measure: z.enum(GEOM_MEASURES),
  unit: z.string().min(1),
  tolerance_abs: z.number().nonnegative(),
  tolerance_pct: z.number().nonnegative().optional(),
  direction: z.enum(["both", "decrease", "increase"]).default("both"),
  tolerance_note: z.string(),
  norm: Norm.optional(),
  predicate: PredicateSchema.optional(),
  label_pct: z.number().positive().default(2), // CMP-12: надпись против измерения — больше порога → «не в масштабе»
  scale_spread_pct: z.number().positive().default(2), // разброс масштаба листа выше порога — измерению не верим
  registration_mm: z.number().positive().default(50), // CMP-14/15: остаток регистрации в оси здания не больше
  iou_min: z.number().min(0).max(1).default(0.95), // CMP-15: контур изменился, если IoU ниже
  hausdorff_mm: z.number().positive().default(300), // CMP-15: …или Хаусдорф больше
  match_mm: z.number().positive().default(1000), // LNK-06: элементы без общего ключа — пара по положению в пределах
  aggregate: z.enum(["each", "sum", "min", "max"]).optional(), // значение стадии: по элементам (LNK-06) или сводное
});

export const GeometryExtractor = z.object({
  kind: z.literal("geometry_mentions"),
  entity: z.string().regex(/^ENT-\d{2}$/),
  measure: z.enum(GEOM_MEASURES),
  element_kinds: z.array(z.string().min(1)).optional(), // openings.kind, site.kind, symbols.kind, stairs.kind
  systems: z.array(z.string().min(1)).optional(), // routes.system: «В1», «Т3»
  mark: z.string().optional(), // регулярное выражение марки элемента
  also: z.array(z.string().regex(/^ENT-\d{2}$/)).optional(), // сущности для предиката (преграды, устройства, контур)
  share_of: z.array(z.string().min(1)).optional(), // счёт как доля от элементов этих видов, % (М-038: места МГН)
});

let norms: NormRecord[] | null = null;

/**
 * Сид Normative_Base (data/seed/norms.json → base[]) — начальное наполнение таблицы normative_base (T-234, db.ts
 * syncNormBase). Расчёт в проверке берёт нормы из таблицы (KindEvalInput.norms); сид читают только прямые вызовы
 * оценщика без базы (тесты предметной логики). Читается один раз от корня репозитория; раздела нет — громкий отказ.
 */
export function normsBase(): NormRecord[] {
  if (norms) return norms;
  const b = (JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")) as { base?: unknown }).base;
  if (!Array.isArray(b)) throw new Error("norms.json: нет раздела base (Normative_Base)");
  norms = b as NormRecord[];
  return norms;
}

/** Конфигурация оценщика из показателя паспорта (OS-INSP-2.2.127). */
export function geomPassport(x: KindPassport): GeomPassport {
  const v = GeometryValue.parse(x.value);
  const e = GeometryExtractor.parse(x.extractor);
  return {
    measure: v.measure, unit: v.unit, tolerance: v.tolerance_abs, tolerance_pct: v.tolerance_pct ?? 0, direction: v.direction,
    aggregate: v.aggregate ?? (v.measure === "area" || v.measure === "count" ? "sum" : "each"),
    norm: v.norm ?? null, predicate: (v.predicate as Predicate | undefined) ?? null, entity: e.entity, also: e.also ?? [], element_kinds: e.element_kinds ?? [],
    systems: e.systems ?? [], mark: e.mark ?? null, share_of: e.share_of ?? [], label_pct: v.label_pct, scale_spread_pct: v.scale_spread_pct, registration_mm: v.registration_mm,
    match_mm: v.match_mm, iou_min: v.iou_min, hausdorff_mm: v.hausdorff_mm, sources: x.sources as GeomPassport["sources"], link: x.link.by === "base_cipher" ? "base_cipher" : null,
  };
}

/**
 * Упоминание вида → упоминание геометрии (OS-INSP-2.2.128). meta.geom — по GeomMentionSchema (T-194) с полями вида и
 * системы; запись не по контракту не угадывается — упоминание отсеивается с причиной. Число без meta.geom (ведомость
 * проёмов текстовым извлекателем) — надпись размера о предмете параметра: сущность, вид и система — из паспорта.
 */
export function geomRef(m: KindMention, g: GeomPassport): GeomRef | null {
  const meta = m.meta ?? {};
  const common = { stage: m.stage, file_id: m.file_id, sha256: m.sha256, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, role: m.role, discipline: m.discipline, confidence: m.confidence };
  const raw = meta.geom;
  if (raw !== undefined) {
    const p = GeomMentionSchema.passthrough().safeParse(raw);
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" ? x : null);
    if (!p.success) {
      return {
        entity: str(r.entity) ?? "", measure: g.measure, value: null, unit: g.unit, by: "geometry", label_value: null, measured_value: null, key: str(r.key) ?? "", at: null, polygon: null, graph: null,
        frame: "sheet", scale_n: null, scale_spread_pct: 0, residual_mm: null, page: m.page, bbox: m.bbox, quote: m.quote, kind: str(r.kind), system: str(r.system),
        ...common, excluded: "GEOM_CONTRACT", excluded_why: `запись геометрии не по контракту ADR-0010: ${p.error.issues[0]?.path.join(".")} — ${p.error.issues[0]?.message}`,
      };
    }
    const d = p.data;
    // страница и рамка — строки извлечения (сквозная нумерация частей документа, OS-INSP-1.2.10), а не листа ML
    return { ...d, graph: (d.graph as GeomRef["graph"]) ?? null, page: m.page, bbox: m.bbox ?? d.bbox, kind: str(r.kind), system: str(r.system), ...common, excluded: m.excluded, excluded_why: m.excluded_why };
  }
  if (m.num === null) return null;
  return {
    entity: g.entity ?? "", measure: g.measure, value: m.num, unit: g.unit, by: "dimension", label_value: m.num, measured_value: null, key: typeof meta.key === "string" ? meta.key : "",
    at: null, polygon: null, graph: null, frame: "sheet", scale_n: null, scale_spread_pct: 0, residual_mm: null, page: m.page, bbox: m.bbox, quote: m.quote,
    kind: g.element_kinds[0] ?? null, system: g.systems[0] ?? null, ...common, excluded: m.excluded, excluded_why: m.excluded_why,
  };
}

/** Строки извлечения → упоминания вида: общие поля; источник стадии — по Матрице, иначе профильные разделы (2.2.4, 2.2.21). */
export function geomMentions(rows: KindRow[]): KindMention[] {
  return rows.map(baseMention);
}

export interface GeomEvalArgs {
  param: Param;
  passport: KindPassport;
  mentions: KindMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  date?: string;
  /** Нормы из таблицы normative_base (T-234, один источник); без них — сид norms.json (прямые вызовы в тестах). */
  norms?: NormRecord[];
}

/** Оценка вида: упоминания профильных разделов → GeomRef → evaluateGeomParam; норма — действующая на дату проверки. */
export function evaluateGeometry({ param, passport, mentions, loadedStages, profile, date, norms }: GeomEvalArgs): KindEvaluation {
  const g = geomPassport(passport);
  const fit = STAGES.flatMap((s) => pickStageSources(mentions.filter((m) => m.stage === s), param, s, (m) => m.discipline));
  const refs = fit.map((m) => geomRef(m, g)).filter((x): x is GeomRef => x !== null);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, refs.filter((m) => m.stage === s)]));
  const ev = evaluateGeomParam(g, byStage, { param, loadedStages, profile, norms: norms ?? normsBase(), date: date ?? new Date().toISOString() });
  return { ...ev, suspicions: [] };
}

export const geometry = registerKind({
  kind: "geometry",
  value: GeometryValue,
  extractor: GeometryExtractor,
  mentions: geomMentions,
  // T-234: пересчёт передаёт нормы из normative_base — правка нормы в интерфейсе доходит до CMP-06
  evaluate: ({ param, passport, mentions, loadedStages, profile, norms }) => evaluateGeometry({ param, passport, mentions, loadedStages, profile, norms }),
});
