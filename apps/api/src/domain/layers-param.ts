// Послойный состав по паспорту (T-176): CMP-21 LAYER-SEQ — выравнивание упорядоченных слоёв (материал, толщина)
// алгоритмом Нидлмана — Вунша с весами и операции delete_layer, insert_layer, substitute_material, thickness_down,
// thickness_up, reorder. Параметры W1: М-044 (пирог кровли), М-032 (дорожная одежда), М-125 (утеплитель наружных
// стен), М-128 (утеплитель чердачного перекрытия и кровли). Замена материала слоя проверяется таблицей аналогов (CMP-05).
// Каталог TO-BE: ENT-17 (конструктивный пирог), NRM-06, LNK-01, VER-15, GTE-01…03, CMP-21, CMP-05, CMP-30, DEC-01.
// Правила — OS-INSP-3.1.67–3.1.69 и 3.1.60 (аналог слоя). L8 — снаружи (T-177).
import { z } from "zod";
import { analogVerdict, showSource, type Family, type VerdictOut } from "./analogs.ts";
import { Aliases } from "./category-param.ts";
import type { ClassEvaluation, Mention, MentionUse } from "./class-param.ts";
import type { ParamPassport } from "./passport.ts";
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGE_RU, STAGES } from "./types.ts";

// ─── схема паспорта (T-176): passport.ts подключает вид одной строкой, код вида живёт здесь

/** value.kind "layers" — упорядоченный состав конструкции по семейству справочника (CMP-21). */
export const LayersValue = z.object({
  kind: z.literal("layers"),
  family: z.string().min(1),
  tol_mm: z.number().nonnegative().default(0.5), // уменьшение толщины больше допуска — thickness_down
  order: z.string().min(1), // канонический порядок словами: «сверху вниз», «снаружи внутрь»
  note: z.string(),
});
/** extractor.kind "layer_mentions" — состав из выноски, перечня или таблицы (ML layer_mentions.py). */
export const LayersExtractor = z.object({
  kind: z.literal("layer_mentions"),
  anchor: z.string().min(1), // заголовок состава: «Состав кровли», «Конструкция дорожной одежды», «Пирог стены»
  item_pattern: z.string().optional(), // марка конструкции рядом с заголовком («Кр-1», «Тип 1»): группа 1
  reverse: z.array(z.string().min(1)).default([]), // «снизу вверх», «изнутри наружу» — перечень развернуть
  max_layers: z.number().int().positive().max(40).default(15),
  exclude: z.array(z.object({ code: z.string().min(1), pattern: z.string().min(1), why: z.string().min(1) })),
  aliases: Aliases.optional(),
  remap: z.record(z.string(), z.string()).optional(), // уточнение канона паспортом: у стены «железобетон» — WALL_RC (OS-INSP-2.2.71)
});
export const LAYERS_VALUES = [LayersValue] as const;
export const LAYERS_EXTRACTORS = [LayersExtractor] as const;

export interface Layer {
  m: string | null; // ключ канона семейства; null — материал вне справочника
  raw: string; // как написано
  t: number | null; // толщина, мм (у переменной — минимальная)
  t_max?: number | null;
}

export interface LayersPassport {
  family: Family;
  tol_mm: number; // допуск толщины: меньше на столько и более — thickness_down
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
  link: "base_cipher" | null;
}

/** Состав конструкции в документе: марка конструкции и слои в каноническом порядке (сверху вниз, снаружи внутрь). */
export interface LayersMention extends Omit<Mention, "value" | "qualifier"> {
  item: string | null;
  layers: Layer[];
}

export type LayerOpKind = "match" | "delete_layer" | "insert_layer" | "substitute_material" | "thickness_down" | "thickness_up" | "reorder";
export interface LayerOp {
  op: LayerOpKind;
  pd: Layer | null;
  rd: Layer | null;
  pd_index: number | null;
  rd_index: number | null;
  verdict: VerdictOut | null; // у замены материала — вердикт таблицы аналогов
  violation: boolean;
  uncertain: boolean; // материал вне справочника: замену нельзя ни подтвердить, ни опровергнуть
  text: string;
}

export interface StackPair {
  item: string | null;
  pd: LayersMention;
  rd: LayersMention;
  ops: LayerOp[];
}

export interface LayersSuspicion {
  stage: Stage;
  description: string;
  mentions: LayersMention[];
  dedup_key: string;
}

export interface LayersEvaluation extends Evaluation {
  suspicions: LayersSuspicion[];
  alignment: Array<{ item: string | null; stage: Stage; ops: Array<Omit<LayerOp, "pd" | "rd"> & { pd: string | null; rd: string | null }> }>;
  provenance: ClassEvaluation["provenance"];
}

export const LAYERS_OPS = ["ENT-17", "NRM-06", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-21", "CMP-05", "CMP-30", "VER-02", "DEC-01"];
const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };

// Веса выравнивания (OS-INSP-3.1.67): совпадение материала выгоднее замены внутри группы, замена внутри группы и
// замена с материалом вне справочника — выгоднее пары «удалить + вставить» (2 разрыва = −4); замена между группами
// дороже пары разрывов — слой другой группы на его месте читается как «исключён + добавлен», а сдвиг — как перестановка.
export const W = { same: 3, group: 1, unknown: 0, other: -5, gap: -2 } as const;

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");
const num = (x: number) => String(Math.round(x * 10) / 10).replace(".", ",");
export const showLayer = (f: Family, l: Layer) => `${l.m ? (f.canon[l.m]?.title ?? l.m) : l.raw}${l.t !== null ? ` ${num(l.t)}${l.t_max != null && l.t_max !== l.t ? `–${num(l.t_max)}` : ""} мм` : ""}`;
export const showStack = (f: Family, ls: Layer[]) => ls.map((l) => showLayer(f, l)).join(" / ");

/** Марка конструкции для сопоставления стадий: без регистра, пробелов и дефисов («Кр-1», «КР 1» → «кр1»). */
export function itemKey(item: string | null): string | null {
  return item === null ? null : fold(item) || null;
}

/** Один и тот же материал: ключ канона, а вне справочника — то же написание после свёртки. */
export function sameMaterial(a: Layer, b: Layer): boolean {
  if (a.m !== null || b.m !== null) return a.m !== null && a.m === b.m;
  return fold(a.raw) !== "" && fold(a.raw) === fold(b.raw);
}

/**
 * Нормализация состава (OS-INSP-3.1.67): подряд идущие слои одного материала — один слой с суммой толщин
 * («Техноруф Н30 150 мм + Техноруф В60 50 мм» = минвата 200 мм — детализация РД, а не замена слоя).
 */
export function mergeRuns(ls: Layer[]): Layer[] {
  const out: Layer[] = [];
  for (const l of ls) {
    const prev = out[out.length - 1];
    if (prev && sameMaterial(prev, l)) {
      const t = prev.t !== null && l.t !== null ? prev.t + l.t : null;
      const tm = t === null ? null : (prev.t_max ?? prev.t!) + (l.t_max ?? l.t!);
      out[out.length - 1] = { ...prev, raw: `${prev.raw} + ${l.raw}`, t, t_max: tm };
    } else out.push({ ...l });
  }
  return out;
}

export function score(f: Family, a: Layer, b: Layer): number {
  if (sameMaterial(a, b)) return W.same;
  if (a.m === null || b.m === null) return W.unknown;
  return f.canon[a.m] && f.canon[b.m] && f.canon[a.m].group === f.canon[b.m].group ? W.group : W.other;
}

/**
 * Выравнивание Нидлмана — Вунша (глобальное): пары индексов, null — разрыв. Обратный проход при ничьей берёт диагональ,
 * затем вставку: в прямом порядке удалённый слой ПД идёт раньше вставленного на его месте слоя РД.
 */
export function align(f: Family, pd: Layer[], rd: Layer[]): Array<[number | null, number | null]> {
  const n = pd.length;
  const m = rd.length;
  const S: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) S[i][0] = i * W.gap;
  for (let j = 1; j <= m; j++) S[0][j] = j * W.gap;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) S[i][j] = Math.max(S[i - 1][j - 1] + score(f, pd[i - 1], rd[j - 1]), S[i - 1][j] + W.gap, S[i][j - 1] + W.gap);
  const out: Array<[number | null, number | null]> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && S[i][j] === S[i - 1][j - 1] + score(f, pd[i - 1], rd[j - 1])) {
      out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (j > 0 && S[i][j] === S[i][j - 1] + W.gap) {
      out.push([null, j - 1]);
      j--;
    } else {
      out.push([i - 1, null]);
      i--;
    }
  }
  return out.reverse();
}

function thicknessOps(p: LayersPassport, a: Layer, b: Layer, i: number, j: number): LayerOp[] {
  if (a.t === null || b.t === null) return [];
  const f = p.family;
  if (b.t < a.t - p.tol_mm) return [{ op: "thickness_down", pd: a, rd: b, pd_index: i, rd_index: j, verdict: null, violation: true, uncertain: false, text: `толщина слоя «${showLayer(f, { ...a, t: null })}» уменьшена: ${num(a.t)} → ${num(b.t)} мм` }];
  if (b.t > a.t + p.tol_mm) return [{ op: "thickness_up", pd: a, rd: b, pd_index: i, rd_index: j, verdict: null, violation: false, uncertain: false, text: `толщина слоя «${showLayer(f, { ...a, t: null })}» увеличена: ${num(a.t)} → ${num(b.t)} мм` }];
  return [];
}

/**
 * Операции над парой составов (OS-INSP-3.1.67, 3.1.68): выравнивание нормализованных составов; пара «удалён + вставлен»
 * одного материала — перестановка (reorder); замена материала — вердикт таблицы аналогов семейства (EQUIVALENT — не
 * нарушение, NOT_EQUIVALENT и UNKNOWN — нарушение; материал вне справочника — неопределённость); толщина — с допуском паспорта.
 */
export function layerOps(p: LayersPassport, pdRaw: Layer[], rdRaw: Layer[]): LayerOp[] {
  const f = p.family;
  const pd = mergeRuns(pdRaw);
  const rd = mergeRuns(rdRaw);
  const pairs = align(f, pd, rd);
  const dels = pairs.filter(([i, j]) => i !== null && j === null).map(([i]) => i!);
  const ins = pairs.filter(([i, j]) => i === null && j !== null).map(([, j]) => j!);
  // перестановка: удалённый слой ПД нашёлся среди вставленных слоёв РД тем же материалом
  const moved = new Map<number, number>();
  for (const i of dels) {
    const j = ins.find((x) => ![...moved.values()].includes(x) && sameMaterial(pd[i], rd[x]));
    if (j !== undefined) moved.set(i, j);
  }
  const ops: LayerOp[] = [];
  for (const [i, j] of pairs) {
    if (i !== null && j !== null) {
      const a = pd[i];
      const b = rd[j];
      if (sameMaterial(a, b)) {
        const t = thicknessOps(p, a, b, i, j);
        ops.push(...(t.length ? t : [{ op: "match" as const, pd: a, rd: b, pd_index: i, rd_index: j, verdict: null, violation: false, uncertain: false, text: `слой «${showLayer(f, a)}» сохранён` }]));
        continue;
      }
      if (a.m === null || b.m === null) {
        ops.push({ op: "substitute_material", pd: a, rd: b, pd_index: i, rd_index: j, verdict: null, violation: false, uncertain: true, text: `слой «${showLayer(f, a)}» ↔ «${showLayer(f, b)}»: материал вне справочника — замену нельзя подтвердить` });
        continue;
      }
      const v = analogVerdict(f, a.m, b.m);
      const bad = v.verdict !== "EQUIVALENT";
      const src = showSource(v.source);
      ops.push({ op: "substitute_material", pd: a, rd: b, pd_index: i, rd_index: j, verdict: v, violation: bad, uncertain: false, text: `материал слоя заменён: ${showLayer(f, { ...a, t: null })} → ${showLayer(f, { ...b, t: null })} — ${bad ? v.why : `эквивалентный аналог (${v.why})`}${src ? ` [${src}]` : ""}` });
      if (!bad) ops.push(...thicknessOps(p, a, b, i, j));
      continue;
    }
    if (i !== null) {
      const j2 = moved.get(i);
      if (j2 !== undefined) {
        ops.push({ op: "reorder", pd: pd[i], rd: rd[j2], pd_index: i, rd_index: j2, verdict: null, violation: true, uncertain: false, text: `слой «${showLayer(f, { ...pd[i], t: null })}» переставлен: позиция ${i + 1} → ${j2 + 1}` });
        ops.push(...thicknessOps(p, pd[i], rd[j2], i, j2));
      } else ops.push({ op: "delete_layer", pd: pd[i], rd: null, pd_index: i, rd_index: null, verdict: null, violation: true, uncertain: false, text: `слой «${showLayer(f, pd[i])}» исключён` });
      continue;
    }
    if (![...moved.values()].includes(j!)) ops.push({ op: "insert_layer", pd: null, rd: rd[j!], pd_index: null, rd_index: j, verdict: null, violation: false, uncertain: false, text: `добавлен слой «${showLayer(f, rd[j!])}»` });
  }
  return ops;
}

/** Упоминания стадии (OS-INSP-3.1.63): как у CMP-05 — отсев, устаревшие редакции, комплект ПД по шифру, приоритет. */
export function pickLayers(mentions: LayersMention[], stage: Stage, p: LayersPassport, kitBases: Set<string>, pdKitPresent = false) {
  const own = mentions.filter((m) => m.stage === stage);
  const dropped = own.filter((m) => m.excluded !== null || m.role === "SUPERSEDED" || !m.layers.length);
  const usable = own.filter((m) => !dropped.includes(m));
  let considered = usable;
  let reference: LayersMention[] = [];
  let note: string | null = null;
  if (stage === "PD" && p.link === "base_cipher" && kitBases.size) {
    const linked = usable.filter((m) => m.base !== null && kitBases.has(m.base));
    if (linked.length) {
      considered = linked;
      reference = usable.filter((m) => !linked.includes(m));
    } else if (pdKitPresent) {
      considered = [];
      reference = usable;
    } else if (usable.length) note = "комплект ПД не связан с РД по базовому шифру — взяты все составы ПД";
  }
  const key = (m: LayersMention) => [sourceRank(p, stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, m.file_id, m.page] as const;
  const sorted = [...considered].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  return { considered: sorted, reference, dropped, note };
}

/** Похожесть составов по известным материалам (Жаккар): для сопоставления конструкций без марки. */
export function similarity(a: Layer[], b: Layer[]): number {
  const A = new Set(a.map((l) => l.m ?? `~${fold(l.raw)}`));
  const B = new Set(b.map((l) => l.m ?? `~${fold(l.raw)}`));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

/**
 * Сопоставление конструкций ПД и РД (OS-INSP-3.1.69): по марке конструкции; по одной оставшейся с каждой стороны —
 * между собой (при разных марках — если составы похожи); остальные без марки — жадно по похожести составов не ниже 0,5. Первый по приоритету состав
 * марки в стадии — её значение. Несопоставленная конструкция РД не сравнивается.
 */
export function pairStacks(pd: LayersMention[], rd: LayersMention[]): Array<{ pd: LayersMention; rd: LayersMention }> {
  const firstBy = (ms: LayersMention[]) => {
    const out = new Map<string, LayersMention>();
    for (const m of ms) {
      const k = itemKey(m.item) ?? `~${m.file_id}@${m.page}#${ms.indexOf(m)}`;
      if (!out.has(k)) out.set(k, m);
    }
    return out;
  };
  const P = firstBy(pd);
  const R = firstBy(rd);
  const out: Array<{ pd: LayersMention; rd: LayersMention }> = [];
  const usedP = new Set<string>();
  const usedR = new Set<string>();
  for (const [k, r] of R) if (!k.startsWith("~") && P.has(k)) {
    out.push({ pd: P.get(k)!, rd: r });
    usedP.add(k);
    usedR.add(k);
  }
  const restP = [...P].filter(([k]) => !usedP.has(k));
  const restR = [...R].filter(([k]) => !usedR.has(k));
  const loose = (xs: Array<[string, LayersMention]>) => xs.filter(([k]) => k.startsWith("~"));
  // по одной оставшейся конструкции с каждой стороны: без марки хоть с одной стороны — пара; марки разные («Кр-1» и
  // «К-1») — пара, только если составы похожи
  if (restP.length === 1 && restR.length === 1 && (loose(restP).length || loose(restR).length || similarity(restP[0][1].layers, restR[0][1].layers) >= 0.5)) return [...out, { pd: restP[0][1], rd: restR[0][1] }];
  const cand = restR
    .filter(([k]) => k.startsWith("~"))
    .flatMap(([kr, r]) => restP.map(([kp, pm]) => ({ kr, kp, r, pm, s: similarity(pm.layers, r.layers) })))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s || (a.kp < b.kp ? -1 : 1));
  for (const c of cand) {
    if (usedP.has(c.kp) || usedR.has(c.kr)) continue;
    usedP.add(c.kp);
    usedR.add(c.kr);
    out.push({ pd: c.pm, rd: c.r });
  }
  return out;
}

/** Противоречие внутри стадии (CMP-30): одна марка конструкции с разными составами в разных документах стадии. */
export function layersConflicts(considered: LayersMention[], stage: Stage, p: LayersPassport): LayersSuspicion[] {
  const by = new Map<string, LayersMention[]>();
  for (const m of considered) {
    const k = itemKey(m.item);
    if (k) by.set(k, [...(by.get(k) ?? []), m]);
  }
  const out: LayersSuspicion[] = [];
  for (const [k, ms] of by) {
    const first = ms[0];
    const diff = ms.filter((m) => m.file_id !== first.file_id && layerOps(p, first.layers, m.layers).some((o) => o.op !== "match"));
    if (!diff.length) continue;
    const all = [first, ...diff];
    out.push({
      stage,
      description: `Внутреннее противоречие ${STAGE_RU[stage]}: состав «${first.item}» указан по-разному — ${all.map((m) => `${m.discipline ?? m.document_code}, стр. ${m.page}: ${showStack(p.family, m.layers)}`).join(" | ")}`,
      mentions: all,
      dedup_key: `layers-conflict:${stage}:${k}:${all.map((m) => `${m.file_id}@${m.page}`).sort().join("|")}`,
    });
  }
  return out;
}

function frag(p: LayersPassport, m: LayersMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: `${m.item ? `${m.item}: ` : ""}${showStack(p.family, m.layers)}`, kind };
}

export interface LayersEvalInput {
  param: Param;
  passport: LayersPassport;
  mentions: LayersMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  kitBases: Set<string>;
  pdKitPresent?: boolean;
}

const OP_ORDER: LayerOpKind[] = ["delete_layer", "substitute_material", "thickness_down", "reorder"];

/** Точка входа CMP-21 (OS-INSP-3.1.67–3.1.69). */
export function evaluateLayersParam({ param, passport: p, mentions, loadedStages, profile, kitBases, pdKitPresent = false }: LayersEvalInput): LayersEvaluation {
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickLayers(mentions, s, p, kitBases, pdKitPresent)])) as Record<Stage, ReturnType<typeof pickLayers>>;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : picks[s].considered.length ? "USED" : "NO_VALUE";
  const suspicions = STAGES.flatMap((s) => (notes[s] === "NOT_APPLICABLE" ? [] : layersConflicts(picks[s].considered, s, p)));
  const provenance: ClassEvaluation["provenance"] = {
    ops: LAYERS_OPS,
    mentions: STAGES.flatMap((s) => {
      const pk = picks[s];
      const use = (m: LayersMention): [MentionUse, string | null] =>
        pk.dropped.includes(m) ? ["dropped", m.excluded_why ?? (m.layers.length ? "устаревшая редакция" : "состав не распознан")] : pk.reference.includes(m) ? ["reference", "другой комплект ПД — шифр не совпадает с РД пакета"] : m === pk.considered[0] ? ["chosen", pk.note] : ["considered", null];
      return mentions.filter((m) => m.stage === s).map((m) => {
        const [u, why] = use(m);
        return {
          stage: s, use: u, why, value: `${m.item ? `${m.item}: ` : ""}${showStack(p.family, m.layers)}`, qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote,
          bbox: m.bbox, anchor_bbox: m.anchor_bbox ?? null, excluded: m.excluded, source: m.source ?? null, readings: m.readings ?? null, reader_outcome: m.reader_outcome ?? null, judge: m.judge ?? null,
        };
      });
    }),
  };
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions, alignment: [] as LayersEvaluation["alignment"], provenance };

  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const used = STAGES.filter((s) => notes[s] === "USED");
  const disputed = used.flatMap((s) => picks[s].considered).filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`, fragments: disputed.map((m) => frag(p, m, "actual")) };
  const later = used.filter((s) => s !== "PD");
  if (notes.PD !== "USED" || !later.length) {
    const have = used.map((s) => STAGE_RU[s]);
    const miss = STAGES.filter((s) => notes[s] === "NO_VALUE").map((s) => STAGE_RU[s]);
    return { ...base, status: "MISSING_EVIDENCE", reason: `Недостаточно источников для сравнения: ${have.length ? `состав слоёв найден только в ${have.join(", ")}` : "состав слоёв не найден"}${miss.length ? `; нет состава в ${miss.join(", ")}` : ""}`, fragments: used.flatMap((s) => picks[s].considered.slice(0, 1)).map((m) => frag(p, m, "expected")) };
  }
  const pairs: StackPair[] = later.flatMap((s) => pairStacks(picks.PD.considered, picks[s].considered).map(({ pd, rd }) => ({ item: rd.item ?? pd.item, pd, rd, ops: layerOps(p, pd.layers, rd.layers) })));
  const alignment = pairs.map((x) => ({ item: x.item, stage: x.rd.stage, ops: x.ops.map((o) => ({ ...o, pd: o.pd ? showLayer(p.family, o.pd) : null, rd: o.rd ? showLayer(p.family, o.rd) : null })) }));
  const withA = { ...base, alignment };
  if (!pairs.length) {
    const it = (s: Stage) => picks[s].considered.map((m) => m.item ?? "без марки").join(", ");
    return { ...withA, status: "NOT_COMPARABLE", reason: `Конструкции стадий не сопоставлены: ПД — ${it("PD")}; ${later.map((s) => `${STAGE_RU[s]} — ${it(s)}`).join("; ")}` };
  }
  const where = (x: StackPair) => `${x.item ? `«${x.item}», ` : ""}ПД → ${STAGE_RU[x.rd.stage]}`;
  const bad = pairs.flatMap((x) => x.ops.filter((o) => o.violation).map((o) => ({ x, o }))).sort((a, b) => OP_ORDER.indexOf(a.o.op) - OP_ORDER.indexOf(b.o.op));
  if (bad.length) {
    const w = bad[0];
    const fragments = [...new Set(bad.map((b) => b.x))].flatMap((x) => [frag(p, x.pd, "expected"), frag(p, x.rd, "actual")]);
    return {
      ...withA, status: "CANDIDATE", expected: showStack(p.family, w.x.pd.layers), actual: showStack(p.family, w.x.rd.layers), delta: bad.map((b) => `${b.o.op}: ${b.o.text}`).join("; "),
      reason: `${where(w.x)}: ${bad.map((b) => b.o.text).join("; ")}. Правило Матрицы: ${param.trigger_logic}`, fragments,
    };
  }
  const unsure = pairs.flatMap((x) => x.ops.filter((o) => o.uncertain).map((o) => ({ x, o })));
  if (unsure.length) return { ...withA, status: "NOT_COMPARABLE", reason: unsure.map((u) => `${where(u.x)}: ${u.o.text}`).join("; "), fragments: unsure.flatMap((u) => [frag(p, u.x.pd, "expected"), frag(p, u.x.rd, "actual")]) };
  const notes2 = pairs.flatMap((x) => x.ops.filter((o) => o.op !== "match").map((o) => `${where(x)}: ${o.text}`));
  const x0 = pairs[0];
  return {
    ...withA, status: "NEGATIVE_VERIFIED", expected: showStack(p.family, x0.pd.layers), actual: showStack(p.family, x0.rd.layers), delta: notes2.length ? notes2.join("; ") : null,
    reason: notes2.length ? `Состав не ухудшен: ${notes2.join("; ")}` : "Состав слоёв и толщины не изменены",
    fragments: pairs.flatMap((x) => [frag(p, x.pd, "expected"), frag(p, x.rd, "actual")]),
  };
}

/** Конфигурация сравнения из паспорта (OS-INSP-3.1.67). null — паспорт не послойный; семейства нет — громкий отказ. */
export function layersPassport(pp: { code: string; value: { kind: string } & Record<string, unknown>; sources: ParamPassport["sources"]; link: ParamPassport["link"] }, families: Record<string, Family>): LayersPassport | null {
  if (pp.value.kind !== "layers") return null;
  const v = LayersValue.parse(pp.value);
  const family = Object.hasOwn(families, v.family) ? families[v.family] : undefined;
  if (!family) throw new Error(`паспорт ${pp.code}: семейства ${v.family} нет в data/seed/analogs.json`);
  return { family, tol_mm: v.tol_mm, sources: pp.sources as LayersPassport["sources"], link: pp.link.by === "base_cipher" ? "base_cipher" : null };
}

/**
 * Поля состава из ответа ML (OS-INSP-3.1.67): meta — недоверенный вход. Слои — не больше 40; материал — ключ канона
 * семейства или null; написание — до 200 знаков; толщина — конечное число 0…5000 мм, иначе null. Пустой состав — null.
 */
export function layersFields(f: Family, meta: Record<string, unknown>): Pick<LayersMention, "item" | "layers"> | null {
  if (!Array.isArray(meta.layers)) return null;
  const mm = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5000 ? v : null);
  const layers: Layer[] = meta.layers.slice(0, 40).filter((l): l is Record<string, unknown> => !!l && typeof l === "object").map((l) => ({
    m: typeof l.m === "string" && Object.hasOwn(f.canon, l.m) ? l.m : null,
    raw: typeof l.raw === "string" ? l.raw.slice(0, 200) : "",
    t: mm(l.t),
    t_max: mm(l.t_max),
  }));
  if (!layers.length) return null;
  const item = typeof meta.item === "string" && meta.item.trim() ? meta.item.trim().slice(0, 40) : null;
  return { item, layers };
}
