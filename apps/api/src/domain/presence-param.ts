// Мероприятие и метод по паспорту (T-212): элемент есть в стадии, явно исключён или не упомянут (CMP-09), и смена метода —
// SAME / REFINED / CHANGED по словарю паспорта (CMP-23). Первые параметры — М-053, 063, 070, 092, 095, 122 (вид presence)
// и М-091 (вид method). Модуль общий: конфигурация целиком из паспорта (PresencePassport), от параметра код не зависит —
// T-176 берёт тот же API (М-044, назначение помещений М-003). Точка входа — evaluatePresenceParam → Evaluation, как у
// class-param.ts и quantity-param.ts; L8 (VER-*) подключается снаружи (T-177).
// Каталог TO-BE: ENT-19 (текст и примечания), NRM-06 (канон методов), LNK-01 (комплект по шифру РД), VER-15 (приоритет
// источника), GTE-01…03 (ворота), CMP-09 (PRESENCE), CMP-23 (смена метода), CMP-30 (противоречие внутри стадии), DEC-01.
// Правила — OS-INSP-3.1.150–3.1.159. Порядок ворот тот же, что в compare.ts: применимость → редакции → эталон → сравнение.
import { z } from "zod";
import type { ClassEvaluation, Mention, MentionUse } from "./class-param.ts";
import type { ParamPassport } from "./passport.ts";
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import type { Evaluation, FindingStatus, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

// ─── схема паспорта (T-212): passport.ts подключает виды одной строкой, код вида живёт здесь

const Aspects = z.record(z.string(), z.string()).refine((a) => Object.keys(a).length > 0, "нужен хотя бы один аспект");
const PdSilent = z.enum(["MISSING_EVIDENCE", "NOT_APPLICABLE"]).default("MISSING_EVIDENCE");

/** value.kind "presence" — мероприятие по аспектам: есть / явно исключено / не упомянуто (CMP-09). */
export const PresenceValue = z.object({
  kind: z.literal("presence"),
  aspects: Aspects,
  pd_silent: PdSilent,
  count: z.object({ aspect: z.string(), unit: z.string(), title: z.string() }).nullable().default(null),
  // показатели аспектов с направлением ухудшения (М-070: сопротивление ЗУ растёт — хуже); count — прежняя запись «уменьшение»
  counts: z.array(z.object({ aspect: z.string(), unit: z.string(), title: z.string(), worse: z.enum(["decrease", "increase"]) })).default([]),
  note: z.string(),
});
/** value.kind "method" — метод по словарю: SAME / REFINED / CHANGED (CMP-23); словарь — канон NRM-06 (шаблоны и более общий метод). */
export const MethodValue = z.object({
  kind: z.literal("method"),
  aspects: Aspects,
  terms: z.record(z.string(), z.object({ title: z.string(), parent: z.string().nullable().default(null), patterns: z.array(z.string()).min(1) })),
  // отдельные части — не основной объект (временные сооружения стройплощадки): с общим методом не сравниваются
  separate: z.array(z.string()).default([]),
  pd_silent: PdSilent,
  note: z.string(),
});
/** extractor.kind "presence_mentions" — упоминания по аспектам с отрицанием в том же предложении (ML presence_mentions.py). */
export const PresenceExtractor = z.object({
  kind: z.literal("presence_mentions"),
  // only_absent — общий оборот («мероприятия по защите от шума», «снос зданий»): берётся, только если исключён или дан
  // ссылкой; аспект «*» — все аспекты паспорта
  anchors: z.array(z.object({ aspect: z.string(), pattern: z.string(), only_absent: z.boolean().optional() })).min(1),
  context: z.string().optional(), // предложение обязано говорить о работе (М-091: демонтаж, разборка, снос)
  negation: z.array(z.string()).min(1), // «не предусматривается», «не требуется», «исключить», «отсутствует», «без»
  affirm: z.array(z.string()).default([]), // «предусмотрено», «выполняется»: ближайшее к обороту сказуемое решает
  // шаблоны числа: строка — для любого аспекта, объект — для своего; первая непустая группа — число, «?» — нечитаемо
  count: z.array(z.union([z.string(), z.object({ aspect: z.string(), pattern: z.string() })])).default([]),
  marks: z.array(z.object({ aspect: z.string(), pattern: z.string() })).default([]), // число разных марок в документе («ДШ-1», «ДШ-2»)
  reference: z.array(z.string()).default([]), // ссылка без содержания: «по альбому», «согласно ПОД», «(в комплекте нет)»
  lookalike: z.array(z.object({ aspect: z.string(), pattern: z.string(), why: z.string() })).default([]), // похожий, но другой элемент
  implied: z.array(z.object({ aspect: z.string(), pattern: z.string() })).default([]), // узел, где элемент обязан быть
  parts: z.array(z.object({ aspect: z.string(), pattern: z.string() })).default([]), // часть здания перед оборотом — его аспект
  // отсев: чужой объект в предложении; scope «anchor» — только если совпадение накрывает сам оборот («опасная зона обрушения»)
  exclude: z.array(z.object({ code: z.string(), pattern: z.string(), why: z.string(), scope: z.enum(["anchor"]).optional() })),
});
export const PRESENCE_VALUES = [PresenceValue, MethodValue] as const;
export const PRESENCE_EXTRACTORS = [PresenceExtractor] as const;

export interface PresencePassport {
  kind: "presence" | "method";
  // аспекты — независимые элементы мероприятия (М-070: молниезащита и заземление; М-095: пылеподавление и экраны);
  // решение принимается по каждому, сводное — по худшему. У метода аспект — к чему относится метод (обычно один, "main").
  aspects: Record<string, string>; // ключ аспекта → название словами инспектора
  // словарь методов CMP-23 (NRM-06): ключ → название и более общий метод; у presence — пустой
  terms: Record<string, { title: string; parent?: string | null }>;
  separate?: string[]; // аспекты-части вне основного объекта: сравниваются только сами с собой (М-091: временные сооружения)
  // ПД о мероприятии молчит: NOT_APPLICABLE — мероприятие не входит в проект объекта; MISSING_EVIDENCE — эталона нет
  pd_silent: "MISSING_EVIDENCE" | "NOT_APPLICABLE";
  count: { aspect: string; unit: string; title: string } | null; // счётный показатель аспекта: уменьшение — нарушение (М-070)
  counts?: Array<{ aspect: string; unit: string; title: string; worse: "decrease" | "increase" }>; // показатели с направлением ухудшения
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
  link: "base_cipher" | null;
}

export type PresenceState = "present" | "absent";

/** Упоминание мероприятия (метода): как упоминание класса, но значение — есть/исключено, аспект и метод по словарю. */
export interface PresenceMention extends Omit<Mention, "value" | "qualifier"> {
  state: PresenceState;
  aspect: string;
  term: string | null; // метод по словарю паспорта; null — у presence не нужен, у method — назван, но не распознан
  count?: number | null;
  // подсказка извлечения: implied — узел, где элемент обязан быть, показан без него (слабое «исключено»); reference —
  // ссылка без содержания («по альбому», «согласно ПОД»); other — похожий, но другой элемент. Ни одна не даёт «есть».
  hint?: "implied" | "reference" | "other" | null;
}

export interface PresencePick {
  considered: PresenceMention[]; // годные упоминания связанного комплекта по приоритету
  reference: PresenceMention[]; // другой комплект ПД — справочно
  dropped: PresenceMention[]; // отсеянные правилами (чужой контекст) и устаревшие редакции
  note: string | null;
}

export interface PresenceSuspicion {
  stage: Stage;
  description: string;
  mentions: PresenceMention[];
  dedup_key: string;
}

/** Смена метода (CMP-23): тот же; уточнение или обобщение по словарю — не нарушение; другой метод — CANDIDATE. */
export type MethodChange = "SAME" | "REFINED" | "CHANGED";

/** Решение по одному аспекту: статус, смена метода (у method) и фраза для инспектора. */
export interface AspectDecision {
  aspect: string;
  title: string;
  status: FindingStatus;
  change: MethodChange | null;
  text: string;
}

export interface PresenceEvaluation extends Evaluation {
  aspects: AspectDecision[];
  suspicions: PresenceSuspicion[];
  provenance: ClassEvaluation["provenance"];
}

/** Состояние аспекта в стадии: только «есть», только «исключено», и то и другое, ничего. */
export type ItemState = "PRESENT" | "ABSENT" | "MIXED" | "SILENT";

export const PRESENCE_OPS = ["ENT-19", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-09", "CMP-30", "VER-02", "DEC-01"];
export const METHOD_OPS = ["ENT-19", "NRM-06", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-23", "CMP-30", "VER-02", "DEC-01"];

const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };
const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
// тяжесть решения по аспекту: худший аспект решает сводный статус параметра
const SEVERITY: FindingStatus[] = ["CANDIDATE", "NOT_COMPARABLE", "MISSING_EVIDENCE", "NEGATIVE_VERIFIED", "NOT_APPLICABLE"];

const where = (m: PresenceMention) => `${m.discipline ?? m.document_code}, стр. ${m.page}`;
const aspectTitle = (p: PresencePassport, a: string) => p.aspects[a] ?? a;
const termTitle = (p: PresencePassport, t: string | null) => (t === null ? "метод не распознан" : (p.terms[t]?.title ?? t));
const stages = (ss: Stage[]) => ss.map((s) => STAGE_RU[s]).join(", ");

/** Значение упоминания словами: «предусмотрено: демпферные ленты», «исключено: …»; у метода — название метода. */
export function showMention(p: PresencePassport, m: PresenceMention): string {
  if (p.kind === "method") return m.state === "present" ? termTitle(p, m.term) : `исключён: ${termTitle(p, m.term)}`;
  const n = m.count != null && p.count?.aspect === m.aspect ? ` (${m.count} ${p.count.unit})` : "";
  return `${m.state === "present" ? "предусмотрено" : "исключено"}: ${aspectTitle(p, m.aspect)}${n}`;
}

/**
 * Упоминания стадии (OS-INSP-3.1.150): отсеянные правилами паспорта (чужой контекст — «в соседнем здании») и устаревшие
 * редакции — в сторону с причиной; ПД — только комплект с базовым шифром РД пакета (LNK-01), если такой комплект есть.
 * Порядок: раздел выше по приоритету паспорта → актуальная редакция → уверенность → файл, страница.
 */
export function pickPresence(mentions: PresenceMention[], stage: Stage, p: PresencePassport, kitBases: Set<string>, pdKitPresent = false): PresencePick {
  const own = mentions.filter((m) => m.stage === stage);
  const dropped = own.filter((m) => m.excluded !== null || m.role === "SUPERSEDED");
  const droppedSet = new Set(dropped);
  const usable = own.filter((m) => !droppedSet.has(m));
  let considered = usable;
  let reference: PresenceMention[] = [];
  let note: string | null = null;
  if (stage === "PD" && p.link === "base_cipher" && kitBases.size) {
    const linked = usable.filter((m) => m.base !== null && kitBases.has(m.base));
    if (linked.length) {
      considered = linked;
      const linkedSet = new Set(linked);
      reference = usable.filter((m) => !linkedSet.has(m));
    } else if (pdKitPresent) {
      // комплект ПД с шифром РД в пакете есть, но мероприятие в нём не упомянуто: чужой проект эталоном не становится
      considered = [];
      reference = usable;
    } else if (usable.length) note = "комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД";
  }
  const key = (m: PresenceMention) => [sourceRank(p, stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, m.file_id, m.page] as const;
  const sorted = [...considered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  return { considered: sorted, reference, dropped, note };
}

/** Состояние аспекта по годным упоминаниям стадии (OS-INSP-3.1.151). */
export function itemState(ms: PresenceMention[], aspect: string): ItemState {
  // ссылка и другой элемент не говорят ни «есть», ни «нет»; узел без элемента — «нет», только если «есть» не сказано нигде
  const own = ms.filter((m) => m.aspect === aspect && m.hint !== "reference" && m.hint !== "other");
  const yes = own.some((m) => m.state === "present");
  const no = own.some((m) => m.state === "absent" && m.hint !== "implied");
  const implied = own.some((m) => m.hint === "implied");
  return yes && no ? "MIXED" : yes ? "PRESENT" : no || implied ? "ABSENT" : "SILENT";
}

/** Подсказка стадии без «есть» и «нет»: только ссылка без содержания или другой элемент (NOT_COMPARABLE, OS-INSP-3.1.154). */
function hintOf(ms: PresenceMention[], aspect: string | null): PresenceMention | null {
  return ms.find((m) => (aspect === null || m.aspect === aspect) && (m.hint === "reference" || m.hint === "other")) ?? null;
}

/** Цепочка обобщений метода по словарю: сам метод, его родитель, родитель родителя… (защита от цикла в данных). */
function lineage(p: PresencePassport, t: string): string[] {
  const out: string[] = [];
  for (let x: string | null | undefined = t; x && !out.includes(x); x = p.terms[x]?.parent) out.push(x);
  return out;
}

/**
 * Смена метода (OS-INSP-3.1.157, CMP-23): тот же ключ — SAME; один метод — уточнение или обобщение другого по словарю
 * («разборка» → «поэлементная разборка») — REFINED; иначе — CHANGED (в том числе два разных уточнения одного метода).
 */
export function compareTerms(p: PresencePassport, from: string, to: string): MethodChange {
  if (from === to) return "SAME";
  return lineage(p, to).includes(from) || lineage(p, from).includes(to) ? "REFINED" : "CHANGED";
}

/**
 * Противоречие внутри стадии (OS-INSP-3.1.155, CMP-30): аспект в стадии и предусмотрен, и исключён — гипотеза для
 * инспектора, а не нарушение: какое из упоминаний относится к объекту, система не угадывает.
 */
export function presenceConflicts(pick: PresencePick, stage: Stage, p: PresencePassport): PresenceSuspicion[] {
  const aspects = [...new Set(pick.considered.map((m) => m.aspect))];
  return aspects
    .filter((a) => itemState(pick.considered, a) === "MIXED")
    .map((a) => {
      const ms = pick.considered.filter((m) => m.aspect === a);
      // у метода противоречие — один и тот же метод и назван, и запрещён; разные методы — не противоречие
      const terms = p.kind === "method" ? [...new Set(ms.map((m) => m.term))].filter((t) => ms.some((m) => m.term === t && m.state === "present") && ms.some((m) => m.term === t && m.state === "absent")) : [null];
      return terms.map((t) => {
        const own = p.kind === "method" ? ms.filter((m) => m.term === t) : ms;
        const yes = own.filter((m) => m.state === "present");
        const no = own.filter((m) => m.state === "absent");
        const name = p.kind === "method" ? termTitle(p, t) : aspectTitle(p, a);
        return {
          stage,
          description: `Внутреннее противоречие ${STAGE_RU[stage]}: «${name}» и предусмотрено (${yes.map(where).join("; ")}), и исключено (${no.map(where).join("; ")})`,
          mentions: own,
          dedup_key: `presence-conflict:${stage}:${a}:${t ?? ""}:${own.map((m) => `${m.file_id}@${m.page}:${m.state}`).sort().join("|")}`,
        };
      });
    })
    .flat();
}

/** Счётный показатель аспекта в стадии (OS-INSP-3.1.156): первое по приоритету упоминание «есть» с числом. */
export function countOf(ms: PresenceMention[], aspect: string): PresenceMention | null {
  return ms.find((m) => m.aspect === aspect && m.state === "present" && typeof m.count === "number") ?? null;
}

function frag(p: PresencePassport, m: PresenceMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: showMention(p, m), kind };
}

/** Чего не хватает стадии — первый по приоритету источник паспорта, со строчной буквы и без пометки Матрицы. */
export function needOf(p: PresencePassport, s: Stage): string {
  const lab = p.sources[s]?.[0]?.label ?? "источник стадии";
  const t = lab.replace(/\s+—\s+источник Матрицы$/, "");
  return /^[А-ЯЁA-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
}

export interface PresenceEvalInput {
  param: Param;
  passport: PresencePassport;
  mentions: PresenceMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  kitBases: Set<string>; // базовые шифры документов РД пакета (LNK-01)
  pdKitPresent?: boolean; // в ПД пакета есть комплект с шифром РД — откат на «все ПД» запрещён
}

/** Внутреннее решение по аспекту: к AspectDecision добавлены опорные упоминания и дельта. */
interface Verdict extends AspectDecision {
  expected: PresenceMention | null;
  actual: PresenceMention[];
  delta: string | null;
}

/**
 * CMP-09 по аспекту (OS-INSP-3.1.151–3.1.154, 3.1.156). ПД предусматривает →
 *   поздняя стадия явно исключает — CANDIDATE; и предусматривает, и исключает — NOT_COMPARABLE;
 *   предусматривает — NEGATIVE_VERIFIED (со счётным показателем: меньше, чем в ПД, — CANDIDATE);
 *   молчит — MISSING_EVIDENCE, никогда не нарушение: молчание текста не доказывает отсутствия (узел бывает только на листе).
 */
function presenceVerdict(p: PresencePassport, picks: Record<Stage, PresencePick>, later: Stage[], aspect: string): Verdict {
  const title = aspectTitle(p, aspect);
  // в ПД узел без элемента не делает эталона «исключено»: эталон — только явное слово ПД
  const pdMs = picks.PD.considered.filter((m) => m.hint !== "implied");
  const pdAll = pdMs.filter((m) => m.aspect === aspect && !m.hint);
  const pdState = itemState(pdMs, aspect);
  const exp = pdAll.find((m) => m.state === "present") ?? pdAll[0] ?? null;
  const v = (status: FindingStatus, text: string, actual: PresenceMention[] = [], delta: string | null = null, e = exp): Verdict => ({ aspect, title, status, change: null, text, expected: e, actual, delta });
  if (pdState === "SILENT") return v("NOT_APPLICABLE", `«${title}» в ПД не упомянуто`);
  if (pdState === "ABSENT") return v("NOT_APPLICABLE", `«${title}» ПД явно не предусматривает (${where(exp!)})`);
  if (pdState === "MIXED") return v("NOT_COMPARABLE", `«${title}» в ПД и предусмотрено, и исключено — эталон не определён`);
  const states = later.map((s) => [s, itemState(picks[s].considered, aspect)] as const);
  const absent = states.filter(([, st]) => st === "ABSENT").map(([s]) => s);
  if (absent.length) {
    const act = absent.map((s) => picks[s].considered.find((m) => m.aspect === aspect && m.state === "absent" && m.hint !== "implied") ?? picks[s].considered.find((m) => m.aspect === aspect && m.hint === "implied")!);
    const how = (m: PresenceMention) => (m.hint === "implied" ? `в ${STAGE_RU[m.stage]} показан узел без элемента (${where(m)})` : `исключено в ${STAGE_RU[m.stage]} (${where(m)})`);
    return v("CANDIDATE", `«${title}» предусмотрено в ПД (${where(exp!)}), ${act.map(how).join(", ")}`, act, "предусмотрено → исключено");
  }
  const mixed = states.filter(([, st]) => st === "MIXED").map(([s]) => s);
  if (mixed.length) return v("NOT_COMPARABLE", `«${title}» в ${stages(mixed)} и предусмотрено, и исключено — проверьте листы`);
  const present = states.filter(([, st]) => st === "PRESENT").map(([s]) => s);
  const hinted = later.map((s) => hintOf(picks[s].considered, aspect)).filter((m): m is PresenceMention => m !== null);
  if (!present.length && hinted.length) {
    const h = hinted[0];
    return v("NOT_COMPARABLE", `«${title}» предусмотрено в ПД, а в ${STAGE_RU[h.stage]} ${h.hint === "reference" ? `только ссылка без содержания (${where(h)})` : `другой элемент (${where(h)}), не «${title}»`} — проверьте лист`);
  }
  if (!present.length) return v("MISSING_EVIDENCE", `«${title}» предусмотрено в ПД (${where(exp!)}), в ${later.length ? stages(later) : "поздних стадиях"} не упомянуто`);
  const act = present.map((s) => picks[s].considered.find((m) => m.aspect === aspect && m.state === "present")!);
  // показатель аспекта: ПД — первое по приоритету значение; поздняя стадия — лучшее для объекта из её значений (часть листа
  // с меньшим числом не делает нарушения), нарушение — если и лучшее хуже ПД
  const measure = [...(p.count ? [{ ...p.count, worse: "decrease" as const }] : []), ...(p.counts ?? [])].find((c) => c.aspect === aspect);
  if (measure) {
    const c0 = countOf(pdMs, aspect);
    const dec = measure.worse === "decrease";
    const best = present
      .map((s) => picks[s].considered.filter((m) => m.aspect === aspect && m.state === "present" && typeof m.count === "number"))
      .filter((ms) => ms.length)
      .map((ms) => ms.reduce((a, b) => ((dec ? b.count! > a.count! : b.count! < a.count!) ? b : a)));
    const bad = c0 ? best.filter((m) => (dec ? m.count! < c0.count! : m.count! > c0.count!)) : [];
    if (c0 && bad.length) {
      const w = bad[0];
      return v("CANDIDATE", `${measure.title} ${dec ? "уменьшено" : "увеличено"}: ПД — ${c0.count} ${measure.unit} (${where(c0)}), ${STAGE_RU[w.stage]} — ${w.count} ${measure.unit} (${where(w)})`, [w], `${c0.count} → ${w.count} ${measure.unit}`, c0);
    }
  }
  return v("NEGATIVE_VERIFIED", `«${title}» предусмотрено в ПД и в ${stages(present)}`, act);
}

/**
 * CMP-23 по аспекту (OS-INSP-3.1.157, 3.1.158): каждый метод поздней стадии сверяется с методами ПД по словарю —
 * SAME или REFINED — не нарушение (NEGATIVE_VERIFIED); метод, которого в ПД нет ни в каком родстве (в том числе
 * запрещённый в ПД), — CHANGED (CANDIDATE); только нераспознанные методы — NOT_COMPARABLE; не указан — MISSING_EVIDENCE.
 */
function methodVerdict(p: PresencePassport, picks: Record<Stage, PresencePick>, later: Stage[], aspect: string): Verdict {
  const title = aspectTitle(p, aspect);
  // части здания (OS-INSP-3.1.157): первый аспект паспорта — общий метод. У части своего метода нет — берётся общий;
  // у общего в поздней стадии своего нет — методы всех частей. Метод другой части с методом этой части не сравнивается.
  const general = Object.keys(p.aspects)[0] ?? aspect;
  // отдельная часть (временные сооружения стройплощадки) не входит ни в общий метод, ни в его замену методами частей
  const sep = new Set(p.separate ?? []);
  const said = (s: Stage, a: string | null) => picks[s].considered.filter((m) => (a === null ? !sep.has(m.aspect) : m.aspect === a) && m.state === "present" && !m.hint);
  // часть, которую не назвала ни одна стадия, не решает: общий метод ПД не требует отдельного метода для каждой части
  if (aspect !== general && !STAGES.some((s) => said(s, aspect).length)) return { aspect, title, status: "NOT_APPLICABLE", change: null, text: `«${title}» не упомянута`, expected: null, actual: [], delta: null };
  const named = (s: Stage) => {
    const own = said(s, aspect);
    if (own.length || (aspect === general && s === "PD") || sep.has(aspect)) return own;
    return said(s, aspect === general ? null : general);
  };
  const known = (s: Stage) => named(s).filter((m) => m.term !== null);
  const pd = known("PD");
  const pdTerms = [...new Set(pd.map((m) => m.term!))];
  const exp = pd[0] ?? named("PD")[0] ?? picks.PD.considered.find((m) => m.aspect === aspect) ?? null;
  const v = (status: FindingStatus, change: MethodChange | null, text: string, actual: PresenceMention[] = [], delta: string | null = null): Verdict => ({ aspect, title, status, change, text, expected: exp, actual, delta });
  if (!pd.length) {
    if (named("PD").length) return v("NOT_COMPARABLE", null, `метод ПД не распознан по словарю паспорта (${named("PD").map(where).join("; ")}) — сравнить нельзя`);
    return v("NOT_APPLICABLE", null, exp ? `в ПД метод только исключён (${where(exp)})` : "в ПД метод не указан");
  }
  const pdNames = pdTerms.map((t) => termTitle(p, t)).join(", ");
  // изменение термина: лучший (ближайший) метод ПД для него; CHANGED — только если ни один метод ПД не родствен
  const change = (t: string): MethodChange => {
    const cs = pdTerms.map((f) => compareTerms(p, f, t));
    return cs.includes("SAME") ? "SAME" : cs.includes("REFINED") ? "REFINED" : "CHANGED";
  };
  const per = later.map((s) => {
    const k = known(s);
    const changed = k.filter((m) => change(m.term!) === "CHANGED");
    if (changed.length) return { s, c: "CHANGED" as const, ms: changed };
    if (k.length) return { s, c: k.some((m) => change(m.term!) === "REFINED") ? ("REFINED" as const) : ("SAME" as const), ms: k };
    // метод с отрицанием, не родственный методам ПД («без обрушения» при разборке в ПД — родственный нет): не молчание,
    // а повод проверить лист (OWASP W3-07) — NOT_COMPARABLE, но не нарушение
    const negated = picks[s].considered.some((m) => m.aspect === aspect && m.state === "absent" && !m.hint && m.term !== null && change(m.term) === "CHANGED");
    return { s, c: named(s).length || hintOf(picks[s].considered, aspect) || negated ? ("UNKNOWN" as const) : ("SILENT" as const), ms: [] as PresenceMention[] };
  });
  const names = (ms: PresenceMention[]) => [...new Set(ms.map((m) => termTitle(p, m.term)))].join(", ");
  const changed = per.filter((x) => x.c === "CHANGED");
  if (changed.length) {
    const ms = changed.flatMap((x) => x.ms);
    return v("CANDIDATE", "CHANGED", `метод изменён: в ПД — ${pdNames} (${where(exp!)}), ${changed.map((x) => `в ${STAGE_RU[x.s]} — ${names(x.ms)} (${where(x.ms[0])})`).join("; ")}`, ms, `${pdNames} → ${names(ms)}`);
  }
  const ok = per.filter((x) => x.c === "SAME" || x.c === "REFINED");
  const unknown = per.filter((x) => x.c === "UNKNOWN");
  const tail = unknown.length ? `; в ${stages(unknown.map((x) => x.s))} метод не распознан по словарю паспорта, дан ссылкой или относится к другому` : "";
  if (ok.length) {
    const refined = ok.filter((x) => x.c === "REFINED");
    const how = refined.length ? `уточнён без смены сути: ${pdNames} → ${names(refined.flatMap((x) => x.ms))} (${stages(refined.map((x) => x.s))})` : `не изменён: ${pdNames} в ПД и в ${stages(ok.map((x) => x.s))}`;
    return v("NEGATIVE_VERIFIED", refined.length ? "REFINED" : "SAME", `метод ${how}${tail}`, ok.flatMap((x) => x.ms));
  }
  if (unknown.length) return v("NOT_COMPARABLE", null, `в ПД — ${pdNames}${tail} — сравнить нельзя`);
  return v("MISSING_EVIDENCE", null, `в ПД — ${pdNames} (${where(exp!)}), в ${later.length ? stages(later) : "поздних стадиях"} метод не указан`);
}

/** Провенанс (DEC-01, OS-INSP-3.1.159): операции каталога и все упоминания стадий — что взято, учтено, справочно, отсеяно. */
function provenanceOf(p: PresencePassport, mentions: PresenceMention[], picks: Record<Stage, PresencePick>): PresenceEvaluation["provenance"] {
  return {
    ops: p.kind === "method" ? METHOD_OPS : PRESENCE_OPS,
    mentions: STAGES.flatMap((s) => {
      const pk = picks[s];
      const dropped = new Set(pk.dropped);
      const reference = new Set(pk.reference);
      const use = (m: PresenceMention): [MentionUse, string | null] =>
        dropped.has(m) ? ["dropped", m.excluded_why ?? "устаревшая редакция"] : reference.has(m) ? ["reference", "другой комплект ПД — шифр не совпадает с РД пакета"] : m === pk.considered[0] ? ["chosen", pk.note] : ["considered", null];
      return mentions.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        return {
          stage: s, use: u, why, value: showMention(p, m), qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: null, reader_outcome: null, judge: null,
        };
      });
    }),
  };
}

/** Точка входа (OS-INSP-3.1.150–3.1.159): решение по каждому аспекту и сводный статус параметра по худшему. */
/** Предел упоминаний на параметр (OWASP W3-04): больше — учитываются первые, в причине — пометка. */
export const MAX_MENTIONS = 2000;

export function evaluatePresenceParam({ param, passport: p, mentions: input, loadedStages, profile, kitBases, pdKitPresent = false }: PresenceEvalInput): PresenceEvaluation {
  // вход — извлечение из недоверенных PDF (OWASP W3-14): аспект и метод берутся только из паспорта; чужой аспект — не
  // упоминание, чужой метод — «не распознан»; сверх предела — первые MAX_MENTIONS с пометкой в причине
  const cut = input.length > MAX_MENTIONS ? ` Учтены первые ${MAX_MENTIONS} упоминаний из ${input.length}.` : "";
  const mentions = input
    .slice(0, MAX_MENTIONS)
    .filter((m) => Object.hasOwn(p.aspects, m.aspect))
    .map((m) => (m.term !== null && !Object.hasOwn(p.terms, m.term) ? { ...m, term: null } : m));
  const ev = evaluateMentions(param, p, mentions, loadedStages, profile, kitBases, pdKitPresent);
  return cut ? { ...ev, reason: `${ev.reason}${cut}` } : ev;
}

function evaluateMentions(param: Param, p: PresencePassport, mentions: PresenceMention[], loadedStages: Stage[], profile: Record<string, boolean>, kitBases: Set<string>, pdKitPresent: boolean): PresenceEvaluation {
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickPresence(mentions, s, p, kitBases, pdKitPresent)])) as Record<Stage, PresencePick>;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : picks[s].considered.length ? "USED" : "NO_VALUE";
  const suspicions = STAGES.flatMap((s) => (notes[s] === "NOT_APPLICABLE" ? [] : presenceConflicts(picks[s], s, p)));
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions, provenance: provenanceOf(p, mentions, picks), aspects: [] as AspectDecision[] };
  const what = p.kind === "method" ? "метод" : "мероприятие";

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  // 2. Актуальность редакций (GTE-03)
  const disputed = STAGES.filter((s) => notes[s] === "USED").flatMap((s) => picks[s].considered).filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(p, m, "actual")) };
  }
  // 3. Эталон ПД (GTE-02): ПД не загружена — сравнивать не с чем
  const notLoaded = STAGES.filter((s) => !loadedStages.includes(s) && stageRequired(param, s));
  if (notes.PD === "NOT_APPLICABLE") return { ...base, status: "MISSING_EVIDENCE", reason: `Эталона нет: ПД не загружена. Запросите ${needOf(p, "PD")}.` };
  // 4. Сравнение по аспектам (CMP-09 / CMP-23): аспекты паспорта и встреченные в упоминаниях, в порядке паспорта
  const later = STAGES.filter((s) => s !== "PD" && notes[s] !== "NOT_APPLICABLE");
  const keys = [...new Set([...Object.keys(p.aspects), ...mentions.map((m) => m.aspect)])];
  const verdicts = keys.map((a) => (p.kind === "method" ? methodVerdict(p, picks, later, a) : presenceVerdict(p, picks, later, a)));
  const aspects: AspectDecision[] = verdicts.map(({ aspect, title, status, change, text }) => ({ aspect, title, status, change, text }));
  const need = (ss: Stage[]) => ss.map((s) => `${STAGE_RU[s]}: ${needOf(p, s)}${notLoaded.includes(s) ? " — стадия не загружена" : ""}`).join("; ");
  if (verdicts.every((x) => x.status === "NOT_APPLICABLE")) {
    // ПД мероприятие исключает или молчит: исключение в ПД — сохранять нечего; молчание — по паспорту (OS-INSP-3.1.152, 3.1.153)
    const absent = picks.PD.considered.filter((m) => m.state === "absent" && !m.hint);
    if (absent.length) return { ...base, aspects, status: "NOT_APPLICABLE", reason: `ПД явно не предусматривает ${what}: ${verdicts.map((x) => x.text).join("; ")} — сравнивать нечего`, fragments: absent.slice(0, 1).map((m) => frag(p, m, "expected")) };
    if (p.pd_silent === "NOT_APPLICABLE") return { ...base, aspects, status: "NOT_APPLICABLE", reason: `В ПД ${what} не упомянуто — по паспорту параметра оно в проект объекта не входит` };
    return { ...base, aspects, status: "MISSING_EVIDENCE", reason: `В ПД ${what} не найдено — эталона нет. Запросите ${need(["PD", ...notLoaded.filter((s) => s !== "PD")])}.` };
  }
  const worst = SEVERITY.find((st) => verdicts.some((x) => x.status === st))!;
  const top = verdicts.filter((x) => x.status === worst);
  const fragments = top.flatMap((x) => [...(x.expected ? [frag(p, x.expected, "expected")] : []), ...x.actual.map((m) => frag(p, m, "actual"))]);
  const first = top[0];
  const ask = worst === "MISSING_EVIDENCE" ? ` Запросите ${need([...later, ...notLoaded.filter((s) => s !== "PD")])}.` : "";
  const rule = worst === "CANDIDATE" ? ` Правило Матрицы: ${param.trigger_logic}` : "";
  return {
    ...base,
    aspects,
    status: worst,
    expected: first.expected ? showMention(p, first.expected) : null,
    actual: first.actual[0] ? showMention(p, first.actual[0]) : null,
    delta: first.delta,
    reason: `${top.map((x) => x.text).join("; ")}.${ask}${rule}`,
    fragments,
  };
}

/** Конфигурация сравнения из паспорта параметра. null — паспорт не мероприятие и не метод. */
export function presencePassport(pp: Pick<ParamPassport, "sources" | "link"> & { value: { kind: string } }): PresencePassport | null {
  const raw = pp.value;
  if (raw.kind !== "presence" && raw.kind !== "method") return null;
  // паспорт вида из реестра типизирован только встроенными видами: значение читается своей схемой
  const v = raw.kind === "presence" ? { ...PresenceValue.parse(raw), kind: "presence" as const } : { ...MethodValue.parse(raw), kind: "method" as const };
  return {
    kind: v.kind,
    aspects: v.aspects,
    terms: v.kind === "method" ? Object.fromEntries(Object.entries(v.terms).map(([k, t]) => [k, { title: t.title, parent: t.parent }])) : {},
    separate: v.kind === "method" ? v.separate : [],
    pd_silent: v.pd_silent,
    count: v.kind === "presence" ? v.count : null,
    counts: v.kind === "presence" ? v.counts : [],
    sources: pp.sources as PresencePassport["sources"],
    link: pp.link.by === "base_cipher" ? "base_cipher" : null,
  };
}

/** Спецификация экстрактора для ML /analyze: у метода — словарь (ключ и шаблоны), у мероприятия — вид значения. */
export function presenceExtractorSpec(pp: { value: { kind: string }; extractor: { kind: string } }): Record<string, unknown> {
  if (pp.value.kind !== "method") return { ...pp.extractor, value_kind: pp.value.kind };
  const v = MethodValue.parse(pp.value);
  return { ...pp.extractor, value_kind: "method", terms: Object.entries(v.terms).map(([key, t]) => ({ key, patterns: t.patterns })) };
}
