// Направление открывания эвакуационных дверей по паспорту (T-214): М-043 (Р3 АР, CMP-17 + CMP-06) и М-106 (Р9 ППМ, CMP-17).
// Каталог TO-BE: ENT-10 (проём: марка и направление из ведомости), NRM-06 (марка без пробела и дефиса), LNK-11 (двери стадий
// по марке), VER-15 (приоритет раздела), GTE-01…03 (ворота), CMP-17 (направление между стадиями), CMP-06 (норма: по
// направлению выхода), CMP-30 (противоречие внутри стадии), DEC-01 (provenance). Правила — OS-INSP-3.1.170–3.1.177.
// Порядок ворот тот же, что в compare.ts и class-param.ts: применимость → редакции → комплектность → сравнение.
// Дуга открывания на плане (растр, вектор) здесь не читается — только текст и таблицы (задел GPU, T-215+).
import { z } from "zod";
import type { ClassEvaluation, Mention, MentionUse } from "./class-param.ts";
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

export type Direction = "outward" | "inward";

/** Значение паспорта вида «направление» (регистрируется в passport.ts → ParamPassport.value). Норма — CMP-06 (М-043). */
export const DirectionValue = z.object({
  kind: z.literal("direction"),
  values: z.array(z.enum(["outward", "inward"])).length(2),
  order_note: z.string(),
  norm: z.object({ basis: z.string().min(1) }).optional(),
});

/** Экстрактор ML direction_mentions (OS-INSP-2.2.152–2.2.157, ENT-10): строки ведомости дверей по марке и утверждения ПЗ/ППМ. */
export const DirectionExtractor = z.object({
  kind: z.literal("direction_mentions"),
  mark: z.string(), // марка двери («Д1», «ДН-2»); тип по ГОСТ («ДПН 21-10») — не марка
  statement: z.string(), // общее утверждение о дверях эвакуационных выходов без марки
  evac: z.string(), // признак эвакуационной двери
  non_evac: z.string().optional(), // помещение вне путей эвакуации: санузел, кладовая, венткамера
  outward: z.array(z.string()).min(1),
  inward: z.array(z.string()).min(1),
  sliding: z.string().optional(), // раздвижная, вращающаяся — не распашная по направлению выхода
  hand: z.string(), // только сторона навески Л/П
  graphic: z.string().optional(), // «см. графику» — направление только на чертеже
  negation: z.string(),
  building: z.string().optional(), // корпус строки: двери разных корпусов не сравниваются
  // сужение пути в коридоре: порог и основание; пока пункт СП не подтверждён — только гипотеза (SUSPICION), не нарушение
  blocks: z.object({ opening: z.string(), leaf: z.string(), path: z.string(), min_mm: z.number().positive(), basis: z.string().min(1) }).optional(),
  window: z.number().int().positive(),
  exclude: z.array(z.object({ code: z.string(), pattern: z.string(), why: z.string() })), // EXEMPT — оговорка нормы
});

export interface DirectionPassport {
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>; // приоритет разделов; «*» — прочие разделы тоже источник
  link: "base_cipher" | null;
  norm: { basis: string } | null; // CMP-06: эвакуационная дверь открывается по направлению выхода (М-043); null — только между стадиями (М-106)
  blocks?: { min_m: number; basis: string } | null; // порог сужения пути дверью в коридор и его основание (гипотеза)
}

/** Значение упоминания: направление; sliding — раздвижная или вращающаяся (не распашная по направлению выхода); blocks —
 * открывается в коридор и сужает путь ниже нормы; hand — только Л/П; graphic — только «см. графику». */
export type DirectionValue = Direction | "sliding" | "blocks" | "hand" | "graphic";

/**
 * Упоминание направления (извлечение ML, direction_mentions). mark — марка двери строки ведомости; null — общее
 * утверждение текста ПЗ/ППМ. excluded — код отсева ML: NEGATION, AMBIGUOUS (выбрасываются), NOT_EVAC и SMALL_ROOM (дверь
 * вне путей эвакуации или помещения ≤ 15 человек — проверена, нарушения нет), EXEMPT (оговорка нормы — понижает вывод),
 * HAND_ONLY и GRAPHIC_ONLY (не сравнимо). evac — признак эвакуационной: да, нет, не указан (null).
 */
export interface DirectionMention extends Omit<Mention, "value" | "qualifier"> {
  value: DirectionValue;
  mark: string | null;
  evac?: boolean | null;
  remaining_m?: number | null; // blocks: ширина пути за вычетом полотна, м (из чисел строки)
  building?: string | null; // корпус строки («Корпус Б»): двери разных корпусов не сравниваются
  exemption?: string | null; // оговорка нормы рядом с «наружу» («за исключением помещений … не более 15 человек»): значение годно, но понижает вывод
}

export interface DirectionSuspicion {
  stage: Stage;
  description: string;
  mentions: DirectionMention[];
  dedup_key: string;
}

export interface DirectionEvaluation extends Evaluation {
  suspicions: DirectionSuspicion[];
  provenance: { ops: string[]; mentions: Array<ClassEvaluation["provenance"]["mentions"][number] & { mark: string | null }>; limit: string | null };
}

export const DIRECTION_OPS = ["ENT-10", "NRM-06", "LNK-01", "LNK-11", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-17", "CMP-06", "CMP-30", "VER-02", "DEC-01"];

const RU: Record<DirectionValue, string> = {
  outward: "по направлению выхода (наружу)",
  inward: "внутрь (против направления эвакуации)",
  sliding: "раздвижная или вращающаяся (не распашная по направлению выхода)",
  blocks: "в коридор с сужением пути эвакуации",
  hand: "только Л/П",
  graphic: "только на чертеже",
};
const BAD = new Set<DirectionValue>(["inward", "sliding"]);
/** Значение хуже нормы «по направлению выхода»: внутрь, раздвижная, сужает путь. */
export const isBad = (m: DirectionMention) => BAD.has(m.value);
const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };
// коды отсева ML, после которых упоминание не участвует ни в чём, кроме списка в карточке
const DROP = new Set(["NEGATION", "AMBIGUOUS"]);
// дверь проверена и вне требования: помещение вне путей эвакуации, помещение не более 15 человек
const OUTSIDE = new Set(["NOT_EVAC", "SMALL_ROOM"]);
const UNREADABLE = new Set(["HAND_ONLY", "GRAPHIC_ONLY"]);

/** Показатель паспорта в форме реестра видов (param-kinds.ts → KindPassport) или корень ParamPassport. */
export interface DirectionPassportSource {
  value: { kind: string } & Record<string, unknown>;
  extractor: { kind: string } & Record<string, unknown>;
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
  link: { by: string };
}

/** Конфигурация сравнения по паспорту (T-214). null — паспорт не вида «направление». */
export function directionPassport(pp: DirectionPassportSource): DirectionPassport | null {
  if (pp.value.kind !== "direction") return null;
  const v = pp.value as z.infer<typeof DirectionValue>;
  const b = pp.extractor.kind === "direction_mentions" ? (pp.extractor as z.infer<typeof DirectionExtractor>).blocks : undefined;
  return { sources: pp.sources, link: pp.link.by === "base_cipher" ? "base_cipher" : null, norm: v.norm ?? null, blocks: b ? { min_m: b.min_mm / 1000, basis: b.basis } : null };
}

/** Предел упоминаний на вход оценки (W3-04): больше — отбрасывается с пометкой в provenance, время оценки ограничено. */
export const MAX_MENTIONS = 2000;

/** «1 сравнение», «2 сравнения», «5 сравнений», «11 сравнений», «21 сравнение». */
export function plural(n: number): string {
  const d = n % 10;
  const h = n % 100;
  return d === 1 && h !== 11 ? "сравнение" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "сравнения" : "сравнений";
}

/** Подпись упоминания: «Д1 — внутрь (…)» или «общее — по направлению выхода (наружу)». */
export const label = (m: DirectionMention) => `${m.mark ?? "общее"} — ${RU[m.value]}`;
const where = (m: DirectionMention) => `${m.discipline ?? m.document_code}, стр. ${m.page}`;

/** Ключ двери стадии: корпус и марка; «*» — общее утверждение о дверях эвакуационных выходов. */
export const doorKey = (m: DirectionMention) => `${m.building ? `${m.building}:` : ""}${m.mark ?? "*"}`;
/** Корпуса совместимы: совпадают или хотя бы у одного не указан. */
const sameBuilding = (a: DirectionMention, b: DirectionMention) => !a.building || !b.building || a.building === b.building;

/** Раздел — источник параметра на стадии (OS-INSP-3.1.170): в списке паспорта или в списке есть «*». */
export function isSource(p: Pick<DirectionPassport, "sources">, stage: Stage, discipline: string | null): boolean {
  const list = p.sources[stage] ?? [];
  return list.some((s) => s.discipline === "*" || (discipline !== null && s.discipline === discipline));
}

export interface DirectionStage {
  doors: Map<string, DirectionMention>; // выбранное упоминание по ключу двери (марка или «*»)
  considered: DirectionMention[]; // годные: направление есть, раздел — источник, редакция не устарела
  exempt: DirectionMention[]; // с оговоркой нормы (EXEMPT) — не значение, но понижают вывод
  hand: DirectionMention[]; // только Л/П или «см. графику» — не сравнимо
  outside: DirectionMention[]; // дверь вне путей эвакуации или помещения ≤ 15 человек — нарушения нет
  reference: DirectionMention[]; // другой комплект ПД — справочно
  dropped: Array<{ m: DirectionMention; why: string }>;
  note: string | null;
}

/**
 * Значения стадии по дверям (OS-INSP-3.1.170, VER-15). Для каждой марки — раздел выше по приоритету, актуальная
 * редакция, уверенность, при равенстве худшее направление (внутрь): система не прячет нарушение за удачным выбором.
 * Раздел, которого нет в списке паспорта (и нет «*»), — не источник параметра: так М-043 и М-106 берут разные разделы.
 */
export function pickDirections(mentions: DirectionMention[], stage: Stage, p: DirectionPassport, primaryBases: Set<string> | null): DirectionStage {
  const own = mentions.filter((m) => m.stage === stage);
  const dropped: DirectionStage["dropped"] = [];
  const keep: DirectionMention[] = [];
  for (const m of own) {
    if (m.role === "SUPERSEDED") dropped.push({ m, why: "устаревшая редакция" });
    else if (m.excluded !== null && DROP.has(m.excluded)) dropped.push({ m, why: m.excluded_why ?? m.excluded });
    else if (!isSource(p, stage, m.discipline)) dropped.push({ m, why: `раздел ${m.discipline ?? "не определён"} — не источник параметра на стадии ${STAGE_RU[stage]} по паспорту` });
    else keep.push(m);
  }
  let pool = keep;
  let reference: DirectionMention[] = [];
  let note: string | null = null;
  if (stage === "PD" && p.link === "base_cipher" && primaryBases && primaryBases.size) {
    const linked = keep.filter((m) => m.base !== null && primaryBases.has(m.base));
    if (linked.length) {
      pool = linked;
      reference = keep.filter((m) => !linked.includes(m));
    } else if (keep.length) note = "комплект ПД не связан с РД по базовому шифру — взяты все упоминания ПД";
  }
  const exempt = pool.filter((m) => m.excluded === "EXEMPT" || Boolean(m.exemption));
  const hand = pool.filter((m) => (m.excluded !== null && UNREADABLE.has(m.excluded)) || (m.excluded === null && (m.value === "hand" || m.value === "graphic")));
  const outside = pool.filter((m) => m.excluded !== null && OUTSIDE.has(m.excluded));
  const considered = pool.filter((m) => m.excluded === null && m.value !== "hand" && m.value !== "graphic");
  const key = (m: DirectionMention) => [sourceRank(p, stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, isBad(m) ? 0 : 1, m.file_id, m.page] as const;
  const sorted = [...considered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  const doors = new Map<string, DirectionMention>();
  for (const m of sorted) if (!doors.has(doorKey(m))) doors.set(doorKey(m), m);
  return { doors, considered: sorted, exempt, hand, outside, reference, dropped, note };
}

/**
 * Противоречие внутри стадии (OS-INSP-3.1.176, CMP-30): одна марка названа с разными направлениями, или общее
 * утверждение «по направлению выхода» и эвакуационная дверь «внутрь» в одной стадии. Гипотеза, а не нарушение.
 */
export function directionConflict(st: DirectionStage, stage: Stage): DirectionSuspicion | null {
  const byKey = new Map<string, Set<DirectionValue>>();
  for (const m of st.considered) byKey.set(doorKey(m), (byKey.get(doorKey(m)) ?? new Set()).add(m.value));
  const split = [...byKey.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);
  const general = [...st.doors.values()].find((m) => m.mark === null);
  const inwardDoors = general?.value === "outward" ? st.considered.filter((m) => m.mark !== null && m.evac === true && isBad(m) && sameBuilding(m, general)) : [];
  if (!split.length && !inwardDoors.length) return null;
  const involved = st.considered.filter((m) => split.includes(doorKey(m)) || inwardDoors.includes(m) || (inwardDoors.length > 0 && m === general));
  const parts = [
    ...split.map((k) => `${k === "*" ? "общее утверждение" : k} названа по-разному: ${st.considered.filter((m) => doorKey(m) === k).map((m) => `${RU[m.value]} (${where(m)})`).join("; ")}`),
    ...(inwardDoors.length ? [`текст — ${RU.outward} (${where(general!)}), а в ведомости: ${inwardDoors.map((m) => `${m.mark} ${RU[m.value]} (${where(m)})`).join(", ")}`] : []),
  ];
  return {
    stage,
    description: `Внутреннее противоречие ${STAGE_RU[stage]} по направлению открывания эвакуационных дверей: ${parts.join("; ")}`,
    mentions: involved,
    dedup_key: `direction-conflict:${stage}:${involved.map((m) => `${m.file_id}@${m.page}:${doorKey(m)}:${m.value}`).sort().join("|")}`,
  };
}

function frag(m: DirectionMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: label(m), kind };
}

/** Пара сравнения: эталон (дверь той же марки или общее утверждение ранней стадии, либо норма) и значение поздней стадии. */
export interface DirectionPair {
  expected: DirectionMention | null; // null — эталон норма (CMP-06)
  actual: DirectionMention;
  violation: boolean;
}

export interface DirectionPairs {
  pairs: DirectionPair[];
  other: DirectionMention[]; // та же марка есть в эталоне, но в другом корпусе — не сравнимо
  unknown: DirectionMention[]; // «внутрь» у двери, о которой не известно, эвакуационная ли она, — не сравнимо
  blocks: DirectionMention[]; // эвакуационная дверь сужает путь в коридоре — гипотеза «проверить по плану», не нарушение
}

/**
 * Пары CMP-17 (OS-INSP-3.1.171, 3.1.173, 3.1.178): для каждой двери поздней стадии эталон — та же марка (и совместимый
 * корпус) в эталонной стадии: смена «наружу» → «внутрь» у той же марки — нарушение без признака эвакуационной (дверь
 * в эталоне уже была по направлению выхода). Без марки в эталоне — общее утверждение, и тогда нарушение только у
 * эвакуационной двери: признак из самой строки или той же марки в любой стадии (evacMarks). Эталона нет, а паспорт задаёт
 * норму (М-043) — эвакуационная дверь «внутрь» сравнивается с нормой (CMP-06); «наружу» без эталона пары не даёт.
 * Сужение пути в коридоре (blocks) пары не даёт: порог не подтверждён пунктом СП — только гипотеза (OS-INSP-3.1.179).
 */
export function directionPairs(ref: DirectionStage | null, later: DirectionStage, norm: boolean, evacMarks: Set<string> = new Set()): DirectionPairs {
  const out: DirectionPairs = { pairs: [], other: [], unknown: [], blocks: [] };
  const evac = (a: DirectionMention) => a.evac === true || (a.mark !== null && evacMarks.has(a.mark));
  // двери эталона по марке и общие утверждения — один проход, дальше поиск по Map (W3-04)
  const byMark = new Map<string, DirectionMention[]>();
  const generals: DirectionMention[] = [];
  for (const e of ref ? ref.doors.values() : []) {
    if (e.mark === null) generals.push(e);
    else byMark.set(e.mark, [...(byMark.get(e.mark) ?? []), e]);
  }
  for (const a of later.doors.values()) {
    if (a.value === "blocks") {
      if (evac(a)) out.blocks.push(a);
      else out.unknown.push(a);
      continue;
    }
    const same = a.mark === null ? [] : (byMark.get(a.mark) ?? []);
    const e = same.find((x) => sameBuilding(x, a));
    if (e) {
      out.pairs.push({ expected: e, actual: a, violation: e.value === "outward" && isBad(a) });
      continue;
    }
    if (same.length) {
      out.other.push(a);
      continue;
    }
    const g = generals.find((x) => sameBuilding(x, a));
    if (isBad(a) && !evac(a)) {
      if (g || norm) out.unknown.push(a);
    } else if (g) out.pairs.push({ expected: g, actual: a, violation: g.value === "outward" && isBad(a) });
    else if (norm && isBad(a)) out.pairs.push({ expected: null, actual: a, violation: true });
  }
  return out;
}

export interface DirectionEvalInput {
  param: Param;
  passport: DirectionPassport;
  mentions: DirectionMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
}

export function evaluateDirectionParam({ param, passport, mentions: all, loadedStages, profile }: DirectionEvalInput): DirectionEvaluation {
  const mentions = all.length > MAX_MENTIONS ? all.slice(0, MAX_MENTIONS) : all;
  const limit = all.length > MAX_MENTIONS ? `на вход взято ${MAX_MENTIONS} упоминаний из ${all.length} — остальные не рассмотрены` : null;
  const rdBases = new Set(mentions.filter((m) => m.stage !== "PD" && m.base).map((m) => m.base!));
  const st = Object.fromEntries(STAGES.map((s) => [s, pickDirections(mentions, s, passport, rdBases)])) as Record<Stage, DirectionStage>;
  const notes: Evaluation["stage_notes"] = {};
  const has = (s: Stage) => st[s].doors.size > 0 || st[s].exempt.length > 0 || st[s].hand.length > 0 || st[s].outside.length > 0;
  // признак эвакуационной переносится по марке между стадиями: «Д-1 — эвакуационный выход» в ПД и «Д-1 | внутрь» в РД
  const evacMarks = new Set(STAGES.flatMap((s) => st[s].considered.filter((m) => m.evac === true && m.mark !== null).map((m) => m.mark!)));
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : has(s) ? "USED" : "NO_VALUE";
  const provenance: DirectionEvaluation["provenance"] = {
    ops: DIRECTION_OPS,
    mentions: STAGES.flatMap((s) => {
      const x = st[s];
      // принадлежность списку — через Map и Set, а не includes/find в цикле (W3-04)
      const dropped = new Map(x.dropped.map((y) => [y.m, y.why]));
      const reference = new Set(x.reference);
      const considered = new Set(x.considered);
      const chosen = new Set(x.doors.values());
      const exempt = new Set(x.exempt);
      const outside = new Set(x.outside);
      const use = (m: DirectionMention): [MentionUse, string | null] => {
        if (dropped.has(m)) return ["dropped", dropped.get(m)!];
        if (reference.has(m)) return ["reference", "другой комплект ПД"];
        if (considered.has(m)) return [chosen.has(m) ? "chosen" : "considered", m.exemption ?? x.note];
        if (exempt.has(m)) return ["flagged", m.excluded_why ?? "оговорка нормы"];
        if (outside.has(m)) return ["flagged", m.excluded_why ?? "дверь вне путей эвакуации"];
        return ["flagged", m.excluded_why ?? "указана только сторона навески Л/П — не направление эвакуации"];
      };
      return mentions.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        return {
          stage: s, use: u, why, value: label(m), qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: m.readings ?? null, reader_outcome: m.reader_outcome ?? null, judge: m.judge ?? null, mark: m.mark,
        };
      });
    }),
    limit,
  };
  const suspicions: DirectionSuspicion[] = STAGES.map((s) => directionConflict(st[s], s)).filter((x): x is DirectionSuspicion => x !== null);
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions, provenance };

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const used = STAGES.filter((s) => notes[s] === "USED");
  // 2. Актуальность редакций (GTE-03): спорная редакция у выбранного значения — эталон не определён
  const disputed = used.flatMap((s) => [...st[s].doors.values()]).filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(m, "actual")) };
  }
  // 3. Сравнение (CMP-17, CMP-06): эталон — самая ранняя стадия со значениями дверей; нормы — только для поздних стадий
  // стадия без эталона раньше себя (РД при пустой ПД) сравнивается только с нормой — если паспорт её задаёт
  const refStage = used.find((s) => st[s].doors.size > 0) ?? null;
  const later = used.filter((s) => s !== "PD");
  const refFor = (s: Stage) => (refStage !== null && STAGES.indexOf(refStage) < STAGES.indexOf(s) ? refStage : null);
  const found = later.map((s) => directionPairs(refFor(s) ? st[refFor(s)!] : null, st[s], passport.norm !== null, evacMarks));
  const pairs = found.flatMap((x) => x.pairs);
  // оговорки стадии нарушения и стадии эталона (ПД: «за исключением помещений ≤ 15 человек»)
  const exemptIn = (s: Stage) => [...st[s].exempt, ...(refFor(s) ? st[refFor(s)!].exempt : [])];
  // OS-INSP-3.1.174 (W3-08): оговорка действует на свою марку (та же строка ведомости или та же марка) и на общее
  // утверждение; общая оговорка («за исключением …» в пересказе нормы) не снимает нарушение у двери с явной маркой —
  // та остаётся CANDIDATE с пометкой, иначе одна типовая фраза ПЗ гасила бы нарушения всех Д1…Дn
  const own = (x: DirectionPair) => {
    const ex = exemptIn(x.actual.stage);
    return x.actual.exemption ? [x.actual, ...ex.filter((m) => m.mark === x.actual.mark)] : ex.filter((m) => (x.actual.mark === null ? m.mark === null : m.mark === x.actual.mark));
  };
  const violations = pairs.filter((x) => x.violation);
  const hard = violations.filter((x) => !own(x).length);
  const soft = violations.filter((x) => own(x).length > 0);
  const generalEx = (x: DirectionPair) => exemptIn(x.actual.stage).filter((m) => m.mark === null);
  const expText = (x: DirectionPair) => (x.expected ? label(x.expected) : `норма — ${RU.outward}`);
  // сужение пути дверью в коридор — всегда гипотеза: порог в паспорте, пункт СП не подтверждён (решение владельца)
  const blocks = found.flatMap((x) => x.blocks);
  const bl = passport.blocks ?? { min_m: 1, basis: "порог не задан в паспорте" };
  const m1 = (x: number) => String(Math.round(x * 100) / 100).replace(".", ",");
  const until = (m: DirectionMention) => (typeof m.remaining_m === "number" ? ` до ${m1(m.remaining_m)} м` : "");
  const porog = `порог ${bl.min_m.toFixed(1).replace(".", ",")} м — ${bl.basis}`;
  for (const m of blocks)
    suspicions.push({
      stage: m.stage,
      description: `${m.mark ?? "Дверь"}: полотно двери, открывающейся в коридор, сужает путь эвакуации${until(m)} — проверьте по плану (${porog})`,
      mentions: [m],
      dedup_key: `direction-blocks:${m.stage}:${m.file_id}@${m.page}:${doorKey(m)}`,
    });
  const fragsOf = (xs: DirectionPair[]) => {
    const seen = new Set<string>();
    const out: Fragment[] = [];
    for (const x of xs)
      for (const f of [...(x.expected ? [frag(x.expected, "expected")] : []), frag(x.actual, "actual")]) {
        const k = `${f.kind}|${f.file_id}|${f.page}|${f.value}`;
        if (!seen.has(k)) (seen.add(k), out.push(f));
      }
    return out;
  };
  if (hard.length) {
    const w = hard[0];
    const doors = [...new Set(hard.map((x) => x.actual.mark ?? "общее утверждение"))].join(", ");
    const norm = hard.some((x) => x.expected === null) && passport.norm ? `; норма: ${passport.norm.basis}` : "";
    const what = w.actual.value === "sliding" ? "раздвижная или вращающаяся вместо распашной по направлению выхода" : "открывается внутрь";
    const gx = hard.flatMap(generalEx);
    const gnote = gx.length ? `; в стадии есть общая оговорка нормы (${gx[0].excluded_why ?? gx[0].exemption ?? gx[0].quote}) — к двери с маркой она не относится, проверьте по плану` : "";
    return {
      ...base, status: "CANDIDATE", expected: expText(w), actual: label(w.actual), delta: `${expText(w)} → ${label(w.actual)}`,
      ...(!w.expected && passport.norm ? { expected_basis: { kind: "norm" as const, reference: passport.norm.basis } } : {}),
      reason: `${w.expected ? STAGE_RU[w.expected.stage] : "Норма"} → ${STAGE_RU[w.actual.stage]}: эвакуационная дверь ${what} (${doors})${gnote}${norm}; ${param.trigger_logic}`,
      fragments: fragsOf(hard),
    };
  }
  if (soft.length) {
    const ex = [...new Set(soft.flatMap(own))].slice(0, 3);
    for (const x of soft)
      suspicions.push({
        stage: x.actual.stage,
        description: `${x.actual.mark ?? "Двери"}: ${RU.inward} при оговорке нормы (${ex.map((m) => `«${m.quote.slice(0, 80)}», ${where(m)}`).join("; ")}) — проверьте по плану, относится ли оговорка к этой двери`,
        mentions: [x.actual, ...ex],
        dedup_key: `direction-exempt:${x.actual.stage}:${x.actual.file_id}@${x.actual.page}:${doorKey(x.actual)}`,
      });
    return {
      ...base, status: "NOT_COMPARABLE", expected: expText(soft[0]), actual: label(soft[0].actual), delta: null,
      reason: `Дверь внутрь (${[...new Set(soft.map((x) => x.actual.mark ?? "общее утверждение"))].join(", ")}) с оговоркой нормы (${ex[0].excluded_why ?? ex[0].exemption ?? ex[0].quote}): оговорку не угадываем — нужна проверка по плану`,
      fragments: fragsOf(soft),
    };
  }
  // W3-09: эвакуационная строка поздней стадии под отрицанием или с двумя направлениями не пропадает молча — гипотеза,
  // и вывод не NEGATIVE_VERIFIED: по этой двери направление не установлено
  const unclear = later.flatMap((s) => st[s].dropped.map((y) => y.m)).filter((m) => m.excluded !== null && DROP.has(m.excluded) && (m.evac === true || (m.mark !== null && evacMarks.has(m.mark))));
  for (const m of unclear)
    suspicions.push({
      stage: m.stage,
      description: `${m.mark ?? "Двери"}: направление открывания записано неоднозначно (${m.excluded_why ?? m.excluded}): «${m.quote.slice(0, 120)}» — проверьте по плану`,
      mentions: [m],
      dedup_key: `direction-unclear:${m.stage}:${m.file_id}@${m.page}:${doorKey(m)}`,
    });
  if (blocks.length) {
    const b = blocks[0];
    return { ...base, status: "NOT_COMPARABLE", reason: `Дверь ${[...new Set(blocks.map((m) => m.mark ?? "—"))].join(", ")} открывается в коридор и сужает путь эвакуации${until(b)} — гипотеза, проверьте по плану; ${porog}`, fragments: blocks.map((m) => frag(m, "actual")) };
  }
  const compared = pairs.filter((x) => x.expected !== null);
  if (unclear.length) {
    const u = unclear[0];
    return {
      ...base, status: "NOT_COMPARABLE",
      reason: `Направление эвакуационных дверей ${[...new Set(unclear.map((m) => m.mark ?? "общее утверждение"))].join(", ")} в ${STAGE_RU[u.stage]} записано неоднозначно (${u.excluded_why ?? u.excluded}) — проверьте по плану${compared.length ? "; остальные двери не ухудшены" : ""}`,
      fragments: unclear.map((m) => frag(m, "actual")),
    };
  }
  if (compared.length) {
    const better = compared.filter((x) => x.expected!.value === "inward" && x.actual.value === "outward");
    const f = compared[0];
    return {
      ...base, status: "NEGATIVE_VERIFIED", expected: label(f.expected!), actual: label(f.actual), delta: null,
      reason: `Направление открывания эвакуационных дверей не ухудшено (${compared.length} ${plural(compared.length)})${better.length ? `; лучше эталона (BETTER): ${better.map((x) => x.actual.mark ?? "общее").join(", ")}` : ""}`,
      fragments: fragsOf(compared),
    };
  }
  // 4. Сравнить нельзя (NOT_COMPARABLE) или нечего (GTE-02)
  const other = found.flatMap((x) => x.other);
  if (other.length) {
    return { ...base, status: "NOT_COMPARABLE", reason: `Двери ${[...new Set(other.map((m) => m.mark))].join(", ")} названы в разных корпусах стадий — двери чужого корпуса не сравниваются`, fragments: other.map((m) => frag(m, "actual")) };
  }
  const hand = later.flatMap((s) => st[s].hand);
  if (hand.length) {
    const graphic = hand.filter((m) => m.value === "graphic" || m.excluded === "GRAPHIC_ONLY");
    const doors = [...new Set(hand.map((m) => m.mark ?? "общее утверждение"))].join(", ");
    return {
      ...base, status: "NOT_COMPARABLE",
      reason: graphic.length === hand.length ? `Направление открывания в ${STAGE_RU[hand[0].stage]} показано только на чертеже («см. графику») — из текста не определить, сравнение невозможно (дуга на плане — задел распознавания графики)` : `У эвакуационных дверей ${doors} указана только сторона навески (Л/П) — это не направление эвакуации, сравнение невозможно`,
      fragments: hand.map((m) => frag(m, "actual")),
    };
  }
  const unknown = found.flatMap((x) => x.unknown);
  if (unknown.length) {
    return { ...base, status: "NOT_COMPARABLE", reason: `Не установлено, на пути эвакуации ли двери ${[...new Set(unknown.map((m) => m.mark ?? "общее утверждение"))].join(", ")} (${RU[unknown[0].value]}): признака эвакуационной нет ни в строке, ни у той же марки в других стадиях`, fragments: unknown.map((m) => frag(m, "actual")) };
  }
  const outside = later.flatMap((s) => st[s].outside);
  if (outside.length) {
    return { ...base, status: "NEGATIVE_VERIFIED", reason: `Двери с открыванием не по направлению выхода — вне требования: ${outside.slice(0, 5).map((m) => `${m.mark ?? "общее"} (${m.excluded_why ?? m.excluded})`).join("; ")}`, fragments: outside.map((m) => frag(m, "actual")) };
  }
  const missing = STAGES.filter((s) => notes[s] === "NO_VALUE").map((s) => STAGE_RU[s]);
  const have = used.map((s) => STAGE_RU[s]);
  return {
    ...base, status: "MISSING_EVIDENCE",
    reason: `Недостаточно источников для сравнения направления открывания: ${have.length ? `данные только в ${have.join(", ")}` : "направление не найдено ни в одной стадии"}${missing.length ? `; нет данных в ${missing.join(", ")}` : ""}`,
    fragments: refStage ? [...st[refStage].doors.values()].map((m) => frag(m, "expected")) : [],
  };
}
