// Категориальный параметр по паспорту (T-176): CMP-05 SUBST — замена марки, материала, типа с проверкой по таблице
// аналогов. Параметры W1: М-072 (материал напорных труб В1/Т3), М-075 (канализационные трубы), М-079 (модель
// вентилятора), М-130 (тип источника света), М-050 (материал отделки). Каталог TO-BE: ENT-13 (спецификация),
// NRM-06 / NRM-11 (канон), LNK-01, VER-15, GTE-01…03, CMP-05, CMP-30, DEC-01. Правила — OS-INSP-3.1.60–3.1.66.
// Порядок ворот тот же, что у class-param.ts: применимость → редакции → комплектность → сравнение. L8 — снаружи (T-177).
import { z } from "zod";
import { analogVerdict, canonTitle, charsOf, compareChars, foldMark, showDiff, showSource, type Chars, type CharDiff, type Family, type VerdictOut } from "./analogs.ts";
import type { ClassEvaluation, Mention, MentionUse } from "./class-param.ts";
import type { ParamPassport } from "./passport.ts";
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGE_RU, STAGES } from "./types.ts";

// ─── схема паспорта (T-176): passport.ts подключает вид одной строкой, код вида живёт здесь

// scope «no_item» — правило действует, только если у сегмента нет своей позиции паспорта (труба отопления Т1 без В1/Т3);
// «before_value» — только перед значением в его ячейке (клапан, шумоглушитель у модели вентилятора)
const Rule = z.object({ code: z.string().min(1), pattern: z.string().min(1), why: z.string().min(1), scope: z.enum(["no_item", "before_value"]).optional() });
const Keyed = z.object({ key: z.string().min(1), pattern: z.string().min(1) });
/** Написания канона для ML (NRM-06, NRM-11): подставляются из справочника при загрузке паспорта (passports.ts). */
export const Aliases = z.array(z.object({ key: z.string().min(1), patterns: z.array(z.string().min(1)).min(1) }));

/** value.kind "category" — марка, материал, тип по семейству справочника data/seed/analogs.json (CMP-05). */
export const CategoryValue = z.object({
  kind: z.literal("category"),
  family: z.string().min(1),
  items: z.record(z.string(), z.string()).nullable().default(null), // позиции: системы В1, Т3; К1, К2
  elements: z.record(z.string(), z.string()).nullable().default(null), // элементы: стояки, подводки; стены, полы
  note: z.string(),
});
/** extractor.kind "category_mentions" — упоминания значения у предмета паспорта (ML category_mentions.py). */
export const CategoryExtractor = z.object({
  kind: z.literal("category_mentions"),
  anchor: z.string().min(1), // предмет: трубы, трубопроводы, светильники, вентилятор
  window: z.number().int().positive(), // значение — в том же предложении не дальше window знаков от предмета
  items: z.array(Keyed).default([]),
  item_pattern: z.string().optional(), // открытая позиция (марка системы «П1», «ВЕ4»): группа 1
  elements: z.array(Keyed).default([]),
  value: z.string().optional(), // открытая марка (модель оборудования): группа 1
  or_analog: z.array(z.string().min(1)).default([]),
  chars: z.array(z.object({ key: z.string().min(1), pattern: z.string().min(1), factor: z.number().positive().default(1) })).default([]),
  exclude: z.array(Rule),
  aliases: Aliases.optional(),
  remap: z.record(z.string(), z.string()).optional(), // уточнение канона паспортом: у стены «железобетон» — WALL_RC (OS-INSP-2.2.71)
});
export const CATEGORY_VALUES = [CategoryValue] as const;
export const CATEGORY_EXTRACTORS = [CategoryExtractor] as const;

export interface CategoryPassport {
  family: Family;
  items: Record<string, string> | null; // позиции (системы В1, Т3; К1, К2) — ключ → название
  elements: Record<string, string> | null; // элементы (стояки, подводки; стены, полы, потолки)
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
  link: "base_cipher" | null;
}

/** Упоминание марки или материала: значение — ключ канона семейства (у открытой марки — как написано). */
export interface CategoryMention extends Omit<Mention, "value" | "qualifier"> {
  value: string;
  alts: string[]; // равноправные варианты того же упоминания («PP-R или металлополимерные»)
  item: string | null;
  element: string | null;
  or_analog: boolean; // «или аналог» — сравнивается характеристика, а не марка
  chars: Chars; // характеристики из текста упоминания («PN 20», «L = 2500 м³/ч»)
}

export interface CategoryPick {
  considered: CategoryMention[];
  reference: CategoryMention[];
  dropped: CategoryMention[];
  note: string | null;
}

export interface CategorySuspicion {
  stage: Stage;
  description: string;
  mentions: CategoryMention[];
  dedup_key: string;
}

/** Решение по одному упоминанию поздней стадии. */
export type SubstKind = "SAME" | "EQUIVALENT" | "CHARS_OK" | "NOT_EQUIVALENT" | "UNKNOWN" | "CHARS_WORSE" | "CHARS_UNKNOWN" | "UNMATCHED";
export interface SubstDecision {
  actual: CategoryMention;
  refs: CategoryMention[];
  kind: SubstKind;
  verdict: VerdictOut | null;
  worse: CharDiff[];
  text: string;
}

export interface CategoryEvaluation extends Evaluation {
  suspicions: CategorySuspicion[];
  decisions: Array<Omit<SubstDecision, "actual" | "refs"> & { stage: Stage; item: string | null; element: string | null; expected: string; actual: string }>;
  provenance: ClassEvaluation["provenance"];
}

export const CATEGORY_OPS = ["ENT-13", "NRM-06", "NRM-11", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-05", "CMP-30", "VER-02", "DEC-01"];
const VIOLATION = new Set<SubstKind>(["NOT_EQUIVALENT", "UNKNOWN", "CHARS_WORSE"]);
const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };

/** Ключ сравнения значения: канон — как есть, открытая марка — свёртка написания (OS-INSP-3.1.62). */
export function valueKey(f: Family, v: string): string {
  return f.open ? foldMark(v) : v;
}

/** Значение упоминания словами: «полипропилен PP-R … или аналог». */
export function showCategory(f: Family, m: Pick<CategoryMention, "value" | "alts" | "or_analog">): string {
  const vs = [m.value, ...m.alts].map((v) => canonTitle(f, v, v));
  return `${vs.join(" или ")}${m.or_analog ? " или аналог" : ""}`;
}

const place = (p: CategoryPassport, m: Pick<CategoryMention, "item" | "element">) =>
  [m.item ? (p.items?.[m.item] ? `${m.item}` : m.item) : null, m.element ? (p.elements?.[m.element] ?? m.element) : null].filter(Boolean).join(", ");
const where = (m: CategoryMention) => `${m.discipline ?? m.document_code}, стр. ${m.page}`;

/**
 * Упоминания стадии (OS-INSP-3.1.63): отсеянные правилами и устаревшие — в сторону с причиной; ПД — только комплект с
 * базовым шифром РД пакета (LNK-01), если он есть. Порядок: раздел по приоритету паспорта → актуальная редакция →
 * уверенность → файл, страница (детерминизм).
 */
export function pickCategory(mentions: CategoryMention[], stage: Stage, p: CategoryPassport, kitBases: Set<string>, pdKitPresent = false): CategoryPick {
  const own = mentions.filter((m) => m.stage === stage);
  const dropped = own.filter((m) => m.excluded !== null || m.role === "SUPERSEDED");
  const usable = own.filter((m) => !dropped.includes(m));
  let considered = usable;
  let reference: CategoryMention[] = [];
  let note: string | null = null;
  if (stage === "PD" && p.link === "base_cipher" && kitBases.size) {
    const linked = usable.filter((m) => m.base !== null && kitBases.has(m.base));
    if (linked.length) {
      considered = linked;
      reference = usable.filter((m) => !linked.includes(m));
    } else if (pdKitPresent) {
      considered = [];
      reference = usable;
    } else if (usable.length) note = "комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД";
  }
  const key = (m: CategoryMention) => [sourceRank(p, stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, m.file_id, m.page] as const;
  const sorted = [...considered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  return { considered: sorted, reference, dropped, note };
}

/**
 * Опора ПД для упоминания поздней стадии (OS-INSP-3.1.64): та же позиция и элемент → та же позиция без элемента →
 * та же позиция с любым элементом → общее значение (без позиции и элемента). Пусто — упоминание не с чем сравнить.
 */
export function referenceOf(pd: CategoryMention[], m: Pick<CategoryMention, "item" | "element">): CategoryMention[] {
  const steps: Array<(x: CategoryMention) => boolean> = [
    (x) => x.item === m.item && x.element === m.element,
    (x) => x.item === m.item && x.element === null,
    (x) => x.item === m.item,
    (x) => x.item === null && x.element === null,
  ];
  for (const s of steps) {
    const r = pd.filter(s);
    if (r.length) return r;
  }
  return [];
}

/**
 * Решение по упоминанию (OS-INSP-3.1.60, 3.1.61): значение входит в опору (с вариантами) — SAME; в опоре «или аналог» —
 * сравниваются характеристики (текст упоминания, иначе канон): хуже хоть одна от каждой сравнимой опоры — CHARS_WORSE,
 * не хуже — CHARS_OK, ни одна не сравнилась — CHARS_UNKNOWN; иначе таблица аналогов: EQUIVALENT хоть от одного значения
 * опоры — EQUIVALENT, иначе NOT_EQUIVALENT, если такая строка есть, иначе UNKNOWN.
 */
export function substDecision(p: CategoryPassport, refs: CategoryMention[], m: CategoryMention): SubstDecision {
  const f = p.family;
  const vk = valueKey(f, m.value);
  const at = place(p, m);
  const show = (x: CategoryMention) => showCategory(f, x);
  if (!refs.length) return { actual: m, refs, kind: "UNMATCHED", verdict: null, worse: [], text: `${at || "значение"}: в ПД нет опоры для сравнения` };
  const same = refs.find((r) => [r.value, ...r.alts].some((v) => valueKey(f, v) === vk));
  if (same) return { actual: m, refs: [same], kind: "SAME", verdict: null, worse: [], text: `${at ? `${at}: ` : ""}${show(same)} сохранено` };
  const analog = refs.filter((r) => r.or_analog);
  if (analog.length) {
    const cmp = analog.flatMap((r) => [r.value, ...r.alts].map((v) => ({ r, v, c: compareChars(f, charsOf(f, v, r.chars), charsOf(f, m.value, m.chars)) }))).filter((x) => x.c.compared.length);
    if (!cmp.length) return { actual: m, refs: analog, kind: "CHARS_UNKNOWN", verdict: null, worse: [], text: `${at ? `${at}: ` : ""}в ПД «${show(analog[0])}», в ${STAGE_RU[m.stage]} «${show(m)}» — характеристики для сравнения аналога не указаны` };
    const ok = cmp.find((x) => !x.c.worse.length);
    if (ok) return { actual: m, refs: [ok.r], kind: "CHARS_OK", verdict: null, worse: [], text: `${at ? `${at}: ` : ""}аналог по «или аналог» не хуже по характеристикам (${ok.c.compared.map((k) => f.chars[k].title).join(", ")}): ${show(ok.r)} → ${show(m)}` };
    const w = cmp[0];
    return { actual: m, refs: [w.r], kind: "CHARS_WORSE", verdict: null, worse: w.c.worse, text: `${at ? `${at}: ` : ""}аналог хуже ПД «${show(w.r)}»: ${w.c.worse.map(showDiff).join("; ")}` };
  }
  const vs = refs.flatMap((r) => [r.value, ...r.alts].map((v) => ({ r, v, out: analogVerdict(f, valueKey(f, v), vk) })));
  const eq = vs.find((x) => x.out.verdict === "EQUIVALENT");
  if (eq) return { actual: m, refs: [eq.r], kind: "EQUIVALENT", verdict: eq.out, worse: [], text: `${at ? `${at}: ` : ""}замена на эквивалентный аналог ${canonTitle(f, eq.v, eq.v)} → ${canonTitle(f, m.value, m.value)} (${eq.out.why}; ${showSource(eq.out.source) || "справочник аналогов"})` };
  const ne = vs.find((x) => x.out.verdict === "NOT_EQUIVALENT") ?? vs[0];
  const kind: SubstKind = ne.out.verdict === "NOT_EQUIVALENT" ? "NOT_EQUIVALENT" : "UNKNOWN";
  const src = showSource(ne.out.source);
  return { actual: m, refs: [ne.r], kind, verdict: ne.out, worse: [], text: `${at ? `${at}: ` : ""}${canonTitle(f, ne.v, ne.v)} заменено на ${canonTitle(f, m.value, m.value)} — ${ne.out.why}${src ? ` (${src})` : ""}` };
}

/**
 * Противоречие внутри стадии (OS-INSP-3.1.65, CMP-30): для одной позиции и элемента разделы стадии называют разные
 * значения, не связанные вариантами одного упоминания, — гипотеза, а не нарушение.
 */
export function categoryConflicts(pick: CategoryPick, stage: Stage, p: CategoryPassport): CategorySuspicion[] {
  const groups = new Map<string, CategoryMention[]>();
  for (const m of pick.considered) {
    const k = `${m.item ?? "*"}|${m.element ?? "*"}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const out: CategorySuspicion[] = [];
  for (const [k, ms] of groups) {
    const sets = ms.map((m) => new Set([m.value, ...m.alts].map((v) => valueKey(p.family, v))));
    const clash = ms.some((_, i) => ms.some((__, j) => j > i && ![...sets[i]].some((v) => sets[j].has(v))));
    if (!clash) continue;
    const at = place(p, ms[0]);
    const byVal = new Map<string, CategoryMention[]>();
    for (const m of ms) byVal.set(showCategory(p.family, m), [...(byVal.get(showCategory(p.family, m)) ?? []), m]);
    out.push({
      stage,
      description: `Внутреннее противоречие ${STAGE_RU[stage]}${at ? ` (${at})` : ""}: ${[...byVal].map(([v, xs]) => `${v} — ${xs.map(where).join("; ")}`).join(" | ")}`,
      mentions: ms,
      dedup_key: `category-conflict:${stage}:${k}:${ms.map((m) => `${m.file_id}@${m.page}:${valueKey(p.family, m.value)}`).sort().join("|")}`,
    });
  }
  return out;
}

function frag(p: CategoryPassport, m: CategoryMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: showCategory(p.family, m), kind };
}

function provenanceOf(p: CategoryPassport, mentions: CategoryMention[], picks: Record<Stage, CategoryPick>): ClassEvaluation["provenance"] {
  return {
    ops: CATEGORY_OPS,
    mentions: STAGES.flatMap((s) => {
      const pk = picks[s];
      const use = (m: CategoryMention): [MentionUse, string | null] =>
        pk.dropped.includes(m) ? ["dropped", m.excluded_why ?? "устаревшая редакция"] : pk.reference.includes(m) ? ["reference", "другой комплект ПД — шифр не совпадает с РД пакета"] : m === pk.considered[0] ? ["chosen", pk.note] : ["considered", null];
      return mentions.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        const at = place(p, m);
        return {
          stage: s, use: u, why, value: `${at ? `${at}: ` : ""}${showCategory(p.family, m)}`, qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: m.readings ?? null, reader_outcome: m.reader_outcome ?? null, judge: m.judge ?? null,
        };
      });
    }),
  };
}

export interface CategoryEvalInput {
  param: Param;
  passport: CategoryPassport;
  mentions: CategoryMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  kitBases: Set<string>;
  pdKitPresent?: boolean;
}

const KIND_ORDER: SubstKind[] = ["NOT_EQUIVALENT", "CHARS_WORSE", "UNKNOWN"];

/** Точка входа CMP-05 (OS-INSP-3.1.60–3.1.66). */
export function evaluateCategoryParam({ param, passport: p, mentions, loadedStages, profile, kitBases, pdKitPresent = false }: CategoryEvalInput): CategoryEvaluation {
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickCategory(mentions, s, p, kitBases, pdKitPresent)])) as Record<Stage, CategoryPick>;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : picks[s].considered.length ? "USED" : "NO_VALUE";
  const suspicions = STAGES.flatMap((s) => (notes[s] === "NOT_APPLICABLE" ? [] : categoryConflicts(picks[s], s, p)));
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions, decisions: [] as CategoryEvaluation["decisions"], provenance: provenanceOf(p, mentions, picks) };

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  // 2. Актуальность редакций (GTE-03)
  const used = STAGES.filter((s) => notes[s] === "USED");
  const disputed = used.flatMap((s) => picks[s].considered).filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(p, m, "actual")) };
  // 3. Комплектность (GTE-02): эталон ПД и хотя бы одна поздняя стадия
  const later = used.filter((s) => s !== "PD");
  if (notes.PD !== "USED" || !later.length) {
    const have = used.map((s) => STAGE_RU[s]);
    const miss = STAGES.filter((s) => notes[s] === "NO_VALUE").map((s) => STAGE_RU[s]);
    return { ...base, status: "MISSING_EVIDENCE", reason: `Недостаточно источников для сравнения: ${have.length ? `марка или материал найдены только в ${have.join(", ")}` : "марка или материал не найдены"}${miss.length ? `; нет значения в ${miss.join(", ")}` : ""}`, fragments: used.flatMap((s) => picks[s].considered.slice(0, 1)).map((m) => frag(p, m, "expected")) };
  }
  // 4. Сравнение (CMP-05): каждое упоминание поздней стадии — с опорой ПД своей позиции и элемента
  const pd = picks.PD.considered;
  const ds = later.flatMap((s) => picks[s].considered.map((m) => substDecision(p, referenceOf(pd, m), m)));
  const decisions = ds.map((d) => ({ stage: d.actual.stage, item: d.actual.item, element: d.actual.element, kind: d.kind, verdict: d.verdict, worse: d.worse, text: d.text, expected: d.refs[0] ? showCategory(p.family, d.refs[0]) : "—", actual: showCategory(p.family, d.actual) }));
  const withD = { ...base, decisions };
  const bad = ds.filter((d) => VIOLATION.has(d.kind)).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  if (bad.length) {
    const w = bad[0];
    const fragments = [frag(p, w.refs[0], "expected"), ...bad.map((d) => frag(p, d.actual, "actual"))];
    const more = bad.length > 1 ? `; ещё: ${bad.slice(1).map((d) => d.text).join("; ")}` : "";
    return {
      ...withD, status: "CANDIDATE", expected: showCategory(p.family, w.refs[0]), actual: showCategory(p.family, w.actual), delta: `${showCategory(p.family, w.refs[0])} → ${showCategory(p.family, w.actual)}`,
      reason: `ПД → ${STAGE_RU[w.actual.stage]}: ${w.text}${more}. Правило Матрицы: ${param.trigger_logic}`, fragments,
    };
  }
  const ok = ds.filter((d) => d.kind === "SAME" || d.kind === "EQUIVALENT" || d.kind === "CHARS_OK");
  const undecided = ds.filter((d) => d.kind === "CHARS_UNKNOWN");
  if (ok.length && !undecided.length) {
    const first = ok.find((d) => d.kind !== "SAME") ?? ok[0];
    const marks = ok.filter((d) => d.kind !== "SAME").map((d) => d.text);
    return {
      ...withD, status: "NEGATIVE_VERIFIED", expected: showCategory(p.family, first.refs[0]), actual: showCategory(p.family, first.actual), delta: first.kind === "SAME" ? null : `${showCategory(p.family, first.refs[0])} → ${showCategory(p.family, first.actual)}`,
      reason: marks.length ? `Замена без ухудшения: ${marks.join("; ")}` : "Марка и материал не изменены",
      fragments: [frag(p, first.refs[0], "expected"), ...ok.map((d) => frag(p, d.actual, "actual"))],
    };
  }
  if (undecided.length) return { ...withD, status: "NOT_COMPARABLE", reason: undecided.map((d) => d.text).join("; "), fragments: undecided.flatMap((d) => [frag(p, d.refs[0], "expected"), frag(p, d.actual, "actual")]) };
  // упоминания поздней стадии не нашли опоры в ПД: позиции стадий не сопоставлены — сравнивать нечего
  const at = (s: Stage) => [...new Set(picks[s].considered.map((m) => place(p, m) || "общее"))].join(", ");
  return { ...withD, status: "NOT_COMPARABLE", reason: `Позиции стадий не сопоставлены: ПД — ${at("PD")}; ${later.map((s) => `${STAGE_RU[s]} — ${at(s)}`).join("; ")}` };
}

/**
 * Конфигурация сравнения из паспорта (OS-INSP-3.1.60). null — паспорт не категориальный; семейства нет в
 * справочнике — громкий отказ (ошибка данных, а не тихое «неизвестно»).
 */
export function categoryPassport(pp: { code: string; value: { kind: string } & Record<string, unknown>; sources: ParamPassport["sources"]; link: ParamPassport["link"] }, families: Record<string, Family>): CategoryPassport | null {
  if (pp.value.kind !== "category") return null;
  const v = CategoryValue.parse(pp.value);
  const family = Object.hasOwn(families, v.family) ? families[v.family] : undefined;
  if (!family) throw new Error(`паспорт ${pp.code}: семейства ${v.family} нет в data/seed/analogs.json`);
  return { family, items: v.items, elements: v.elements, sources: pp.sources as CategoryPassport["sources"], link: pp.link.by === "base_cipher" ? "base_cipher" : null };
}

/** Написания канона семейства для ML: ключ → шаблоны; у открытой марки — пусто (модель ищется шаблоном value). */
export function familyAliases(f: Family): Array<{ key: string; patterns: string[] }> {
  return Object.entries(f.canon).filter(([, c]) => c.aliases?.length).map(([key, c]) => ({ key, patterns: c.aliases! }));
}

const cut = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Поля упоминания из ответа ML (OS-INSP-3.1.63): meta — вход от модуля, читающего недоверенные PDF. Значение закрытого
 * семейства — только ключ канона (иначе упоминания нет), варианты — только ключи канона, характеристики — только
 * объявленные семейством (число конечное, у порядковой — ступень шкалы), позиция и элемент — строки не длиннее 40.
 * null — упоминание отбрасывается.
 */
export function categoryFields(f: Family, valueText: string | null, meta: Record<string, unknown>): Pick<CategoryMention, "value" | "alts" | "item" | "element" | "or_analog" | "chars"> | null {
  const value = cut(valueText, 120);
  if (value === null || (!f.open && !Object.hasOwn(f.canon, value))) return null;
  const alts = Array.isArray(meta.alts) ? [...new Set(meta.alts.filter((a): a is string => typeof a === "string" && (f.open ? a.length <= 120 : Object.hasOwn(f.canon, a)) && a !== value))].slice(0, 5) : [];
  const chars: Chars = {};
  const raw = meta.chars && typeof meta.chars === "object" && !Array.isArray(meta.chars) ? (meta.chars as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(raw)) {
    const d = Object.hasOwn(f.chars, k) ? f.chars[k] : undefined;
    if (!d) continue;
    if (d.kind === "number" && typeof v === "number" && Number.isFinite(v)) chars[k] = v;
    if (d.kind === "ordinal" && typeof v === "string" && d.scale!.includes(v)) chars[k] = v;
  }
  return { value, alts, item: cut(meta.item, 40), element: cut(meta.element, 40), or_analog: meta.or_analog === true, chars };
}
