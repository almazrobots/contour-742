// Реестр видов параметров Матрицы (T-186, OS-INSP-7.1.20–7.1.24): новый вид паспорта (presence, method, geometry…)
// добавляется записью в реестр, а не веткой if/else в общих местах. Весь код вида — в своём модуле domain/kinds/<вид>.ts,
// который вызывает registerKind(...); список модулей — domain/kinds/index.ts, одна строка на вид.
// Встроенные виды ordinal (М-023, class-param.ts) и quantity (М-001, quantity-param.ts) остаются своими ветками.
import type { z } from "zod";
import { mentionTrace, type Mention, type MentionUse } from "./class-param.ts";
import { parseDocName } from "./cipher.ts";
import type { NormRecord } from "./geom-ops.ts";
import type { ParamPassport } from "./passport.ts";
import type { Evaluation, Param, RevisionRole, Stage } from "./types.ts";

/** Виды значения и извлекатели со своими ветками в passport.ts и inspections.ts — в реестр не регистрируются. */
export const BUILTIN_VALUE_KINDS: readonly string[] = ["ordinal", "quantity"];
export const BUILTIN_EXTRACTOR_KINDS: readonly string[] = ["class_mentions", "quantity_mentions"];

/** Раздел документа для приоритета источников: буквенная часть марки («АР1» → «АР», «ИОС5.4» → «ИОС»). */
export function disciplineKey(d: string | null | undefined): string | null {
  const m = (d ?? "").trim().toUpperCase().match(/^[А-ЯЁA-Z]+/);
  return m ? m[0] : null;
}

/** Строка извлечения из базы (extractions + метаданные файла) — вход «строки → упоминания». */
export interface KindRow {
  file_id: string;
  sha256: string;
  doc_stage: Stage;
  document_code: string;
  revision: string;
  approval_status: Mention["approval_status"];
  revision_role: RevisionRole;
  discipline: string | null;
  value_num: number | null;
  value_text: string | null;
  page: number;
  bbox_json: string | null;
  anchor_bbox_json?: string | null;
  meta_json: string | null;
  line_text: string | null;
  confidence: number | null;
}

/** Упоминание вида из реестра: общие поля упоминания + текст и число значения + meta извлечения как есть. */
export interface KindMention extends Omit<Mention, "value" | "qualifier"> {
  value: string | null;
  num: number | null;
  meta: Record<string, unknown>;
}

export interface KindSuspicion<M extends KindMention = KindMention> {
  stage: Stage;
  description: string;
  mentions: M[];
  dedup_key: string;
}

/** Provenance вида: операции и упоминания — та же форма, что у частей паспорта (T-174, PartProvenance). */
export interface KindProvenance {
  ops: string[];
  mentions: Array<{ stage: Stage; use: MentionUse; why: string | null; value: string } & Record<string, unknown>>;
}

export interface KindEvaluation<M extends KindMention = KindMention> extends Evaluation {
  suspicions: KindSuspicion<M>[];
  provenance: KindProvenance;
}

/**
 * Один показатель паспорта для вида: value и extractor + источники, связь и основание. Строится из корня паспорта
 * (kindSlice) или из части паспорта (T-174: value/extractor части, sources части или корня) — вид к корню не привязан.
 */
export interface KindPassport {
  value: { kind: string } & Record<string, unknown>;
  extractor: { kind: string } & Record<string, unknown>;
  sources: ParamPassport["sources"];
  link: ParamPassport["link"];
  basis: string;
}

/** Показатель корня паспорта для вида из реестра. */
export function kindSlice(pp: ParamPassport): KindPassport {
  return { value: pp.value, extractor: pp.extractor, sources: pp.sources, link: pp.link, basis: pp.basis };
}

export interface KindEvalInput<M extends KindMention = KindMention> {
  param: Param;
  passport: KindPassport;
  mentions: M[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  kitBases: Set<string>;
  pdKitPresent: boolean;
  /** ТЗ §10 Normative_Base (T-234): нормы из таблицы normative_base — пересчёт читает их один раз на проверку. */
  norms?: NormRecord[];
}

/** Схема с полем kind-литералом: z.object({ kind: z.literal("presence"), … }). */
type KindSchema = z.ZodObject<any>;

export interface ParamKind<M extends KindMention = KindMention> {
  /** value.kind паспорта — ключ реестра. */
  kind: string;
  /** Схема value паспорта (kind — литерал, равный kind). */
  value: KindSchema;
  /** Схема extractor паспорта; её kind — ключ извлекателя в ml/inspector_ml/extractor_kinds.py. */
  extractor: KindSchema;
  /** Строки извлечения → упоминания; по умолчанию — baseMention для каждой строки. */
  mentions?: (rows: KindRow[]) => M[];
  /** Оценка параметра: статус, фрагменты, provenance и гипотезы (suspicions). */
  evaluate: (x: KindEvalInput<M>) => KindEvaluation<M>;
  /** Спецификация извлекателя для ML /analyze; по умолчанию — extractor показателя как есть. */
  spec?: (x: KindPassport) => Record<string, unknown>;
  /** Цитата опорного упоминания гипотезы (фактическое значение кандидата); по умолчанию — quote упоминания. */
  quote?: (m: M) => string;
}

/** Ошибка данных: вид паспорта не встроенный и не зарегистрирован. Имя вида — в сообщении. */
export class UnknownParamKind extends Error {
  constructor(
    readonly field: "value" | "extractor",
    readonly kind: string,
    where = "",
  ) {
    super(`${where ? `${where}: ` : ""}вид ${field === "value" ? "значения" : "извлекателя"} «${kind}» не зарегистрирован в реестре видов (domain/param-kinds.ts, domain/kinds/index.ts)`);
    this.name = "UnknownParamKind";
  }
}

const KINDS = new Map<string, ParamKind<any>>();
const EXTRACTORS = new Map<string, string>(); // extractor.kind → value.kind

const literalOf = (s: KindSchema): unknown => (s.shape.kind as { value?: unknown } | undefined)?.value;

let sealed = false;

/** Схема паспорта построена (passport.ts): поздняя регистрация не попала бы в неё — отказ вместо молчаливого пропуска. */
export function sealKinds(): void {
  sealed = true;
}

/** Регистрация вида. Встроенный вид, повтор, несогласованная схема или поздняя регистрация — громкий отказ при загрузке. */
export function registerKind<M extends KindMention>(def: ParamKind<M>): ParamKind<M> {
  if (sealed) throw new Error(`реестр видов: «${def.kind}» зарегистрирован после построения схемы паспорта — модуль вида подключается в domain/kinds/index.ts`);
  if (BUILTIN_VALUE_KINDS.includes(def.kind)) throw new Error(`реестр видов: «${def.kind}» — встроенный вид, регистрировать нельзя`);
  if (KINDS.has(def.kind)) throw new Error(`реестр видов: вид «${def.kind}» уже зарегистрирован`);
  if (literalOf(def.value) !== def.kind) throw new Error(`реестр видов: kind схемы value (${String(literalOf(def.value))}) ≠ «${def.kind}»`);
  const ex = literalOf(def.extractor);
  if (typeof ex !== "string" || BUILTIN_EXTRACTOR_KINDS.includes(ex) || EXTRACTORS.has(ex)) throw new Error(`реестр видов: извлекатель «${String(ex)}» уже занят`);
  KINDS.set(def.kind, def);
  EXTRACTORS.set(ex, def.kind);
  return def;
}

/** Зарегистрированные виды в порядке регистрации. */
export function registeredKinds(): ParamKind<any>[] {
  return [...KINDS.values()];
}

/** Вид из реестра по value.kind: null — встроенный вид; незнакомый — UnknownParamKind. */
export function kindOf(kind: string, where = ""): ParamKind<any> | null {
  if (BUILTIN_VALUE_KINDS.includes(kind)) return null;
  const def = KINDS.get(kind);
  if (!def) throw new UnknownParamKind("value", kind, where);
  return def;
}

/** Проверка видов сырого паспорта до схемы: незнакомый вид — ошибка с его именем, а не безымянный отказ zod. */
export function assertKnownKinds(raw: unknown, where: string): void {
  const r = (raw && typeof raw === "object" ? raw : {}) as { value?: { kind?: unknown }; extractor?: { kind?: unknown } };
  const v = r.value?.kind;
  if (typeof v === "string") kindOf(v, where);
  const e = r.extractor?.kind;
  if (typeof e === "string" && !BUILTIN_EXTRACTOR_KINDS.includes(e) && !EXTRACTORS.has(e)) throw new UnknownParamKind("extractor", e, where);
}

const json = <T>(s: string | null | undefined, empty: T): T => (s ? (JSON.parse(s) as T) : empty);

/** Общие поля упоминания из строки извлечения — как у упоминаний класса и количества (inspections.ts). */
export function baseMention(r: KindRow): KindMention {
  const meta = json<Record<string, unknown>>(r.meta_json, {});
  const name = parseDocName(r.document_code);
  return {
    stage: r.doc_stage, file_id: r.file_id, sha256: r.sha256, document_code: r.document_code, revision: r.revision, approval_status: r.approval_status,
    role: r.revision_role, discipline: disciplineKey(r.discipline) ?? disciplineKey(name.discipline), base: name.base, value: r.value_text, num: r.value_num,
    excluded: typeof meta.excluded === "string" ? meta.excluded : null, excluded_why: typeof meta.excluded_why === "string" ? meta.excluded_why : null,
    page: r.page, bbox: json(r.bbox_json, null), anchor_bbox: json(r.anchor_bbox_json, null),
    quote: typeof meta.quote === "string" ? meta.quote : (r.line_text ?? ""), confidence: r.confidence ?? 0, meta,
    ...mentionTrace(meta),
  };
}

/** Упоминания вида: своя функция вида или baseMention. */
export function kindMentions<M extends KindMention>(def: ParamKind<M>, rows: KindRow[]): M[] {
  return def.mentions ? def.mentions(rows) : (rows.map(baseMention) as M[]);
}

/** Спецификация извлекателя вида для ML /analyze. */
export function kindSpec(def: ParamKind<any>, x: KindPassport): Record<string, unknown> {
  return def.spec ? def.spec(x) : { ...x.extractor };
}

/** Поля записи гипотезы (INTERNAL_CONSISTENCY) — общий путь записи, как у количественного параметра (OS-INSP-3.1.19). */
/** Ссылок на упоминания в записи гипотезы — не больше: остальные названы счётом (OWASP-0253 — вход от ML без предела). */
export const SUSPICION_REFS_MAX = 50;

export function suspicionRecord<M extends KindMention>(param: string, s: KindSuspicion<M>, basis: string | null, quote?: (m: M) => string) {
  const ref = (m: M) => `${m.document_code}, ред. ${m.revision}, стр. ${m.page}`;
  const rest = s.mentions.length - SUSPICION_REFS_MAX;
  const refs = [...s.mentions.slice(0, SUSPICION_REFS_MAX).map(ref), ...(rest > 0 ? [`и ещё ${rest}`] : [])].join("; ");
  const a = s.mentions.find((m) => m.bbox !== null) ?? null;
  return {
    // reduce, а не Math.min(...): spread на ~10⁵ аргументов даёт RangeError и роняет транзакцию пересчёта (OWASP-0253)
    confidence: s.mentions.length ? s.mentions.reduce((lo, m) => Math.min(lo, m.confidence), Infinity) : 0,
    description: `${param}: ${s.description}`,
    pd_reference: s.stage === "PD" ? refs : null,
    rd_reference: s.stage !== "PD" ? refs : null,
    normative_base: basis,
    dedup_key: `${param}:${s.dedup_key}`,
    anchor: a ? JSON.stringify({ file_id: a.file_id, page: a.page, bbox: a.bbox, quote: quote ? quote(a) : a.quote }) : null,
  };
}
