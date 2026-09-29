// Геометрический параметр по паспорту (T-193, ADR-0010): длины, площади, положения, контуры, отношения, топология и
// счёт знаков с плана. Точка входа — evaluateGeomParam → Evaluation + provenance {ops, mentions, measurements}, как у
// class-param.ts и quantity-param.ts. Порядок ворот тот же: применимость (GTE-01) → редакции (GTE-03) → комплектность
// (GTE-02) → сравнение. Допуск и направление между стадиями — правило движка количества W1 (breaks, allowed:
// CMP-01/02/03); норма — CMP-06 по измерению (одна стадия против Normative_Base). Нового статуса нет: всё, что нельзя
// измерить честно (масштаб, регистрация, вырожденный контур, пустой граф), — NOT_COMPARABLE с причиной.
// Правила — OS-INSP-3.1.110–3.1.124, 2.4.48–2.4.52, 2.2.125–2.2.129.
import type { ClassEvaluation, MentionUse } from "./class-param.ts";
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import type { Pt } from "./geom-core.ts";
import { matchElements } from "./geom-match.ts";
import {
  checkRelation,
  predicateOthers,
  compareGraphs,
  convertUnit,
  normBroken,
  positionShift,
  resolveArea,
  resolveDim,
  resolveNorm,
  shapeChange,
  type GeomGraph,
  type GeomMeasure,
  type GeomMention,
  type NormLimit,
  type NormRecord,
  type Predicate,
} from "./geom-ops.ts";
import { allowed, breaks, fmtNum, type QuantityPassport } from "./quantity-param.ts";
import type { ApprovalStatus, Evaluation, FindingStatus, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

export interface GeomPassport {
  measure: GeomMeasure;
  unit: string;
  tolerance: number;
  tolerance_pct: number;
  direction: "both" | "decrease" | "increase";
  aggregate: "each" | "sum" | "min" | "max";
  norm: { kind: "min" | "max"; value: number | null; basis: string; ref?: string } | null;
  predicate: Predicate | null;
  entity: string | null; // null — упоминания текстового экстрактора (ведомость проёмов), сущность не фильтруется
  also: string[];
  element_kinds: string[];
  systems: string[];
  mark: string | null;
  share_of: string[]; // счёт — доля от элементов этих видов, % (М-038)
  label_pct: number;
  scale_spread_pct: number;
  registration_mm: number;
  match_mm: number;
  iou_min: number;
  hausdorff_mm: number;
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
  link: "base_cipher" | null;
}

/** Упоминание геометрии с метаданными файла из реестра (как Mention у класса и количества). */
export interface GeomRef extends GeomMention {
  stage: Stage;
  file_id: string;
  sha256: string;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  role: RevisionRole;
  discipline: string | null;
  excluded: string | null;
  excluded_why: string | null;
  confidence: number;
}

export interface GeomCtx {
  param: Param;
  loadedStages: Stage[];
  profile: Record<string, boolean>;
  norms: NormRecord[];
  date: string; // дата проверки: норма берётся действующая на неё
}

export interface Measurement {
  stage: Stage;
  key: string;
  measure: GeomMeasure;
  value: number | null;
  unit: string;
  by: string | null;
  page: number;
  file_id: string;
  not_to_scale?: boolean;
  diff_pct?: number | null;
  control_flag?: boolean;
  iou?: number;
  hausdorff_mm?: number;
  shift_mm?: number;
  at?: Pt | null;
  polygon?: Pt[] | null;
  note?: string | null;
}

export interface GeomEvaluation extends Evaluation {
  provenance: ClassEvaluation["provenance"] & { measurements: Measurement[] };
}

const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };

const MEASURE_OPS: Record<GeomMeasure, string[]> = {
  length: ["ENT-04", "ENT-06", "CMP-12"],
  area: ["ENT-21", "CMP-13"],
  position: ["NRM-09", "LNK-03", "CMP-14"],
  shape: ["NRM-09", "LNK-03", "CMP-15"],
  relation: ["CMP-16"],
  topology: ["NRM-15", "CMP-19"],
  count: ["ENT-08"],
};

/** Операции каталога, по которым получен результат (DEC-01): ворота, сопоставление, операторы вида, норма. */
export function geomOps(p: GeomPassport): string[] {
  const ops = ["GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", ...MEASURE_OPS[p.measure]];
  if (p.entity) ops.unshift(p.entity);
  if (["length", "area", "count"].includes(p.measure)) ops.push(p.direction === "both" ? "CMP-02" : "CMP-03");
  if (p.norm) ops.push("CMP-06");
  if (p.predicate && p.measure !== "relation") ops.push("CMP-16");
  ops.push("DEC-01");
  return [...new Set(ops)];
}

const qp = (p: GeomPassport): QuantityPassport => ({ unit: p.unit, tolerance: p.tolerance, tolerance_pct: p.tolerance_pct, direction: p.direction === "increase" ? "both" : p.direction, sources: p.sources, link: p.link });

/** Нарушение между стадиями по правилу движка W1; «только рост» (increase) — зеркально «только уменьшению». */
export function stageBreaks(p: GeomPassport, ref: number, v: number): boolean {
  if (p.direction === "increase") return v - ref > allowed(qp(p), ref) + 1e-9;
  return breaks(qp(p), ref, v);
}

const where = (m: GeomRef) => `${m.discipline ?? m.document_code}, стр. ${m.page}`;
const num = (v: number, u: string) => `${fmtNum(v)} ${u}`;

/** Фрагмент доказательства; значение скаляра — число без единицы, как у количества W1 (протокол, отпечаток решения). */
function frag(m: GeomRef, kind: Fragment["kind"], value: string): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value, kind };
}

// ─────────────────────────────── выбор упоминаний стадии

interface StagePick {
  used: GeomRef[]; // элементы параметра из самого приоритетного раздела стадии
  others: Record<string, GeomRef[]>; // элементы сущностей предиката (преграды, устройства, контуры)
  total: GeomRef[]; // элементы знаменателя доли (share_of): все места, а не только места МГН
  dropped: Array<{ m: GeomRef; why: string }>;
}

const reMark = (p: GeomPassport) => (p.mark ? new RegExp(p.mark, "u") : null);

/** Элемент — предмет параметра: сущность и фильтры паспорта (вид, система, марка). */
export function isSubject(p: GeomPassport, m: GeomMention): boolean {
  if (p.entity && m.entity !== p.entity) return false;
  if (p.element_kinds.length && !p.element_kinds.includes(m.kind ?? "")) return false;
  if (p.systems.length && !p.systems.includes(m.system ?? "")) return false;
  const re = reMark(p);
  return !re || re.test(m.key ?? "");
}

/**
 * Упоминания стадии (OS-INSP-3.1.110): отсеянные ML и устаревшие редакции — в сторону с причиной; из годных — раздел
 * выше по приоритету паспорта (VER-15): элементы одного плана не смешиваются с элементами другого раздела.
 */
export function pickGeom(all: GeomRef[], stage: Stage, p: GeomPassport): StagePick {
  const own = all.filter((m) => m.stage === stage);
  const dropped: StagePick["dropped"] = [];
  const ok: GeomRef[] = [];
  for (const m of own) {
    if (m.role === "SUPERSEDED") dropped.push({ m, why: "устаревшая редакция" });
    else if (m.excluded !== null) dropped.push({ m, why: m.excluded_why ?? m.excluded });
    else ok.push(m);
  }
  const subj = ok.filter((m) => isSubject(p, m));
  const best = subj.length ? Math.min(...subj.map((m) => sourceRank(p, stage, m.discipline))) : 0;
  const used = subj.filter((m) => sourceRank(p, stage, m.discipline) === best);
  for (const m of subj) if (!used.includes(m)) dropped.push({ m, why: "раздел ниже по приоритету паспорта" });
  const others: Record<string, GeomRef[]> = {};
  for (const code of p.also) others[code] = ok.filter((m) => m.entity === code);
  const total = p.share_of.length ? ok.filter((m) => (!p.entity || m.entity === p.entity) && p.share_of.includes(m.kind ?? "") && sourceRank(p, stage, m.discipline) === best) : [];
  // порядок — для детерминизма (файл, страница); спорные редакции до сравнения не доходят (GTE-03)
  used.sort((a, b) => a.file_id.localeCompare(b.file_id) || a.page - b.page);
  return { used, others, total, dropped };
}

// ─────────────────────────────── скаляр: длина, площадь, счёт

interface Elem {
  m: GeomRef;
  value: number;
  note: string | null;
  not_to_scale: boolean;
}

/** Значение элемента в единице паспорта: CMP-12 для длины, CMP-13 для площади, счёт — как есть. */
function scalar(p: GeomPassport, m: GeomRef, ms: Measurement[]): Elem | { why: string } {
  const base: Measurement = { stage: m.stage, key: m.key, measure: p.measure, value: null, unit: p.unit, by: null, page: m.page, file_id: m.file_id, at: m.at, polygon: m.polygon };
  let v: number | null;
  let why: string | null;
  let note: string | null = null;
  let nts = false;
  if (p.measure === "length") {
    const d = resolveDim(m, p.label_pct, p.scale_spread_pct);
    v = d.value;
    why = d.why;
    nts = d.not_to_scale;
    if (nts) note = `надпись ${fmtNum(m.label_value!)} против измерения ${fmtNum(m.measured_value ?? 0)} (${fmtNum(Math.round(d.diff_pct! * 10) / 10)} %) — лист не в масштабе, взята надпись`;
    Object.assign(base, { by: d.by, not_to_scale: d.not_to_scale, diff_pct: d.diff_pct });
  } else if (p.measure === "area") {
    let a;
    try {
      a = resolveArea(m, m.unit || p.unit, p.label_pct, p.scale_spread_pct);
    } catch (e) {
      a = { value: null, by: null, geom_value: null, control_diff_pct: null, control_flag: false, why: (e as Error).message };
    }
    v = a.value;
    why = a.why;
    if (a.control_flag) note = `площадь по контуру ${fmtNum(a.geom_value!)} расходится с экспликацией на ${fmtNum(Math.round(a.control_diff_pct! * 10) / 10)} % — геометрия контрольная`;
    Object.assign(base, { by: a.by, control_flag: a.control_flag, diff_pct: a.control_diff_pct });
  } else {
    v = m.value ?? (m.at ? 1 : null); // отдельный знак без счёта — один знак
    why = v === null ? "счёт не определён" : null;
    Object.assign(base, { by: m.by });
  }
  if (v === null || !Number.isFinite(v)) {
    ms.push({ ...base, note: why });
    return { why: why ?? "значения нет" };
  }
  const val = p.measure === "count" ? v : convertUnit(v, m.unit || p.unit, p.unit);
  ms.push({ ...base, value: val, note });
  return { m, value: val, note, not_to_scale: nts };
}

function aggregate(p: GeomPassport, es: Elem[]): Elem | null {
  if (!es.length) return null;
  const mode = p.aggregate === "each" ? (p.direction === "increase" ? "max" : "min") : p.aggregate;
  // сумма — показатель стадии, а не элемента: марка первого элемента в причину не попадает
  if (mode === "sum") return { ...es[0], m: { ...es[0].m, key: "" }, value: es.reduce((s, e) => s + e.value, 0), note: es.map((e) => e.note).find(Boolean) ?? null, not_to_scale: es.some((e) => e.not_to_scale) };
  return es.reduce((a, b) => ((mode === "min" ? b.value < a.value : b.value > a.value) ? b : a));
}

// ─────────────────────────────── вход

export function evaluateGeomParam(p: GeomPassport, mentionsByStage: Partial<Record<Stage, GeomRef[]>>, ctx: GeomCtx): GeomEvaluation {
  const all = STAGES.flatMap((s) => (mentionsByStage[s] ?? []).map((m) => ({ ...m, stage: s })));
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickGeom(all, s, p)])) as Record<Stage, StagePick>;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) notes[s] = !ctx.loadedStages.includes(s) || !stageRequired(ctx.param, s) ? "NOT_APPLICABLE" : picks[s].used.length ? "USED" : "NO_VALUE";
  const ms: Measurement[] = [];
  const provenance: GeomEvaluation["provenance"] = {
    ops: geomOps(p),
    mentions: STAGES.flatMap((s) =>
      all
        .filter((m) => m.stage === s)
        .map((m) => {
          const d = picks[s].dropped.find((x) => x.m === m);
          const use: MentionUse = d ? "dropped" : picks[s].used.includes(m) ? "chosen" : "considered";
          const v = m.value ?? m.label_value ?? m.measured_value;
          return {
            stage: s, use, why: d?.why ?? null, value: v === null ? m.measure : num(v, m.unit), qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page,
            quote: m.quote, bbox: m.bbox, anchor_bbox: null, excluded: m.excluded, source: "plan_geometry", readings: null, reader_outcome: null, judge: null,
          };
        }),
    ),
    measurements: ms,
  };
  const out = (status: FindingStatus, reason: string, extra: Partial<Evaluation> = {}): GeomEvaluation => ({ status, reason, expected: null, actual: null, delta: null, fragments: [], stage_notes: notes, provenance, ...extra });

  // 1. Применимость (GTE-01)
  if (ctx.param.applicability && ctx.profile[ctx.param.applicability] === false) return out("NOT_APPLICABLE", `Неприменим к объекту: ${ctx.param.applicability}`);
  // 2. Актуальность редакций (GTE-03)
  const usedAll = STAGES.flatMap((s) => (notes[s] === "USED" ? picks[s].used : []));
  const disputed = usedAll.filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) return out("CLARIFICATION_REQUIRED", `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}`);
  const stages = STAGES.filter((s) => notes[s] === "USED");
  if (!stages.length) return out("MISSING_EVIDENCE", `Сравнить не с чем: элементов «${ctx.param.parameter_name}» на планах стадий нет. Запросите ${STAGES.filter((s) => stageRequired(ctx.param, s)).map((s) => `${STAGE_RU[s]}: ${p.sources[s]?.[0]?.label ?? "план стадии"}`).join("; ")}.`);

  switch (p.measure) {
    case "length":
    case "area":
    case "count":
      return scalarEval(p, picks, stages, ctx, ms, out);
    case "position":
    case "shape":
      return pairEval(p, picks, stages, ctx, ms, out);
    case "relation":
      return relationEval(p, picks, stages, ms, out);
    case "topology":
      return topologyEval(p, picks, stages, ms, out);
  }
}

type Out = (status: FindingStatus, reason: string, extra?: Partial<Evaluation>) => GeomEvaluation;

/** Проверка предиката CMP-16 по стадиям: нарушения — строки причины; отказ предиката — примечание, не статус. */
function predicateLines(p: GeomPassport, picks: Record<Stage, StagePick>, stages: Stage[]): { bad: string[]; frags: Array<[GeomRef, string]>; skipped: string[] } {
  const bad: string[] = [];
  const frags: Array<[GeomRef, string]> = [];
  const skipped: string[] = [];
  if (!p.predicate) return { bad, frags, skipped };
  for (const s of stages) {
    const subj = picks[s].used.filter((m) => m.at || m.polygon);
    const v = checkRelation(p.predicate, subj, predicateOthers(p.predicate, picks[s].others), p.scale_spread_pct);
    if (!v.ok) {
      skipped.push(`${STAGE_RU[s]}: ${v.why}`);
      continue;
    }
    for (const x of v.violations) {
      bad.push(`${STAGE_RU[s]}${x.mention ? ` (${where(x.mention as GeomRef)})` : ""}: ${x.why}`);
      if (x.mention) frags.push([x.mention as GeomRef, x.why]);
    }
  }
  return { bad, frags, skipped };
}

function scalarEval(p: GeomPassport, picks: Record<Stage, StagePick>, stages: Stage[], ctx: GeomCtx, ms: Measurement[], out: Out): GeomEvaluation {
  const elems = {} as Record<Stage, Elem[]>;
  const fails: string[] = [];
  for (const s of stages) {
    elems[s] = [];
    for (const m of picks[s].used) {
      const e = scalar(p, m, ms);
      if ("why" in e) fails.push(`${STAGE_RU[s]} (${where(m)}): ${e.why}`);
      else elems[s].push(e);
    }
  }
  // доля (М-038, CMP-06 по доле): элементы параметра к элементам видов share_of той же стадии, %
  if (p.share_of.length)
    for (const s of stages) {
      const n = elems[s].reduce((a, e) => a + e.value, 0);
      const den = picks[s].total.reduce((a, m) => a + (m.value ?? (m.at ? 1 : 0)), 0);
      if (!elems[s].length) continue;
      if (den <= 0) {
        fails.push(`${STAGE_RU[s]}: общего числа элементов для доли нет`);
        elems[s] = [];
      } else elems[s] = [{ m: elems[s][0].m, value: (100 * n) / den, note: `${fmtNum(n)} из ${fmtNum(den)}`, not_to_scale: false }];
    }
  const have = stages.filter((s) => elems[s].length);
  if (!have.length) return out("NOT_COMPARABLE", `Значение по плану не определено: ${fails.join("; ")}`);
  const nts = have.flatMap((s) => elems[s]).filter((e) => e.not_to_scale);
  const ntsNote = nts.length ? ` Лист не в масштабе (CMP-12): ${nts.map((e) => `${where(e.m)} — ${e.note}`).join("; ")}.` : "";

  // CMP-06: одна стадия против нормы; эталон — норма, а не ПД
  let limit: NormLimit | null = null;
  let normWhy: string | null = null;
  if (p.norm) {
    const r = resolveNorm(p.norm, ctx.norms, ctx.date, p.unit);
    if ("why" in r) normWhy = r.why;
    else limit = r;
  }
  const pred = predicateLines(p, picks, have);
  if (limit) {
    const bad = have.flatMap((s) => elems[s].filter((e) => normBroken(limit!, e.value)));
    if (bad.length) {
      const worst = bad.reduce((a, b) => ((limit!.kind === "min" ? b.value < a.value : b.value > a.value) ? b : a));
      const d = worst.value - limit.value;
      return out("CANDIDATE", `Норма нарушена (CMP-06): ${bad.map((e) => `${STAGE_RU[e.m.stage]} (${where(e.m)}${e.m.key ? `, «${e.m.key}»` : ""}) — ${num(e.value, p.unit)}`).join("; ")} при норме ${limit.text}.${ntsNote}${pred.bad.length ? ` Нарушены отношения (CMP-16): ${pred.bad.join("; ")}.` : ""}`, {
        expected: limit.text,
        actual: fmtNum(worst.value),
        delta: `${d > 0 ? "+" : ""}${num(d, p.unit)}`,
        fragments: bad.map((e) => frag(e.m, "actual", fmtNum(e.value))),
      });
    }
  }
  // между стадиями: эталон — самая ранняя стадия со значением; элементы — по ключу и положению (LNK-06)
  const [ref, ...later] = have;
  const lines: string[] = [];
  let worst: { a: Elem; b: Elem; d: number } | null = null;
  const pairs: Array<[Elem, Elem]> = [];
  const unmatched: string[] = [];
  for (const s of later) {
    if (p.aggregate !== "each") {
      pairs.push([aggregate(p, elems[ref])!, aggregate(p, elems[s])!]);
      continue;
    }
    const r = matchElements(elems[ref].map((e) => ({ ...e, key: e.m.key, at: e.m.at, frame: e.m.frame })), elems[s].map((e) => ({ ...e, key: e.m.key, at: e.m.at, frame: e.m.frame })), p.match_mm);
    if (!r.pairs.length) pairs.push([aggregate(p, elems[ref])!, aggregate(p, elems[s])!]);
    else for (const x of r.pairs) pairs.push([x.a, x.b]);
    for (const x of r.onlyA) if (x.key) unmatched.push(`«${x.key}» ${STAGE_RU[ref]} нет в ${STAGE_RU[s]}`);
  }
  for (const [a, b] of pairs)
    if (stageBreaks(p, a.value, b.value)) {
      const d = b.value - a.value;
      lines.push(`${STAGE_RU[b.m.stage]} (${where(b.m)}${b.m.key ? `, «${b.m.key}»` : ""}) ${num(b.value, p.unit)} против ${STAGE_RU[a.m.stage]} (${where(a.m)}) ${num(a.value, p.unit)}`);
      if (!worst || Math.abs(d) > Math.abs(worst.d)) worst = { a, b, d };
    }
  const normOk = limit ? ` Норма соблюдена (CMP-06): ${limit.text}.` : normWhy ? ` Сравнение с нормой не выполнено: ${normWhy}.` : "";
  const unm = unmatched.length ? ` Без пары (LNK-06): ${unmatched.join("; ")}.` : "";
  const rel = pred.bad.length ? ` Нарушены отношения (CMP-16): ${pred.bad.join("; ")}.` : "";
  if (!worst && rel) return out("CANDIDATE", `${rel.trim()}${ntsNote}`, { fragments: pred.frags.map(([m, why]) => frag(m, "actual", why)) });
  if (worst) {
    const pct = worst.a.value ? (worst.d / worst.a.value) * 100 : 0;
    return out("CANDIDATE", `${lines.join("; ")} — допуск ${p.direction === "decrease" ? "на уменьшение " : p.direction === "increase" ? "на рост " : ""}±${num(allowed(qp(p), worst.a.value), p.unit)}.${rel}${ntsNote}${normOk}${unm} Правило Матрицы: ${ctx.param.trigger_logic}`, {
      expected: fmtNum(worst.a.value),
      actual: fmtNum(worst.b.value),
      delta: `${worst.d > 0 ? "+" : ""}${num(worst.d, p.unit)} (${worst.d > 0 ? "+" : ""}${pct.toFixed(1).replace(".", ",")} %)`,
      fragments: [frag(worst.a.m, "expected", fmtNum(worst.a.value)), frag(worst.b.m, "actual", fmtNum(worst.b.value))],
    });
  }
  const lateHave = have.filter((s) => s !== "PD");
  if (pairs.length) {
    const [a, b] = pairs[pairs.length - 1];
    return out("NEGATIVE_VERIFIED", `${ctx.param.parameter_name}: между стадиями в пределах допуска ±${num(allowed(qp(p), a.value), p.unit)}.${normOk}${ntsNote}${unm}`, {
      expected: fmtNum(a.value),
      actual: fmtNum(b.value),
      fragments: [frag(a.m, "expected", fmtNum(a.value)), frag(b.m, "actual", fmtNum(b.value))],
    });
  }
  // одна стадия: решает только норма (CMP-06 — проверка одной стадии РД или ИД)
  if (limit && lateHave.length) {
    const e = aggregate({ ...p, aggregate: "each", direction: limit.kind === "min" ? "decrease" : "increase" }, lateHave.flatMap((s) => elems[s]))!;
    return out("NEGATIVE_VERIFIED", `Норма соблюдена (CMP-06): ${STAGE_RU[e.m.stage]} (${where(e.m)}) — ${num(e.value, p.unit)} при норме ${limit.text}.${ntsNote}`, { expected: limit.text, actual: fmtNum(e.value), fragments: [frag(e.m, "actual", fmtNum(e.value))] });
  }
  if (normWhy && lateHave.length) return out("NOT_COMPARABLE", `Сравнить можно только с нормой, а ${normWhy}.`);
  const e = aggregate(p, elems[ref])!;
  return out("MISSING_EVIDENCE", `Сравнить не с чем: ${STAGE_RU[ref]} — ${num(e.value, p.unit)} (${where(e.m)}); значения других стадий на планах нет.${ntsNote}`, { expected: fmtNum(e.value), fragments: [frag(e.m, "expected", fmtNum(e.value))] });
}

/** CMP-14 и CMP-15: пары элементов эталона и поздних стадий по LNK-06, вердикт по каждой паре. */
function pairEval(p: GeomPassport, picks: Record<Stage, StagePick>, stages: Stage[], ctx: GeomCtx, ms: Measurement[], out: Out): GeomEvaluation {
  const [ref, ...later] = stages;
  if (!later.length) return out("MISSING_EVIDENCE", `Сравнить не с чем: элементы есть только в ${STAGE_RU[ref]}.`);
  const bad: string[] = [];
  const skip: string[] = [];
  const frags: Fragment[] = [];
  let ok = 0;
  for (const s of later) {
    const r = matchElements(picks[ref].used, picks[s].used, p.match_mm);
    for (const x of r.onlyA) if (x.key) bad.push(`«${x.key}» ${STAGE_RU[ref]} (${where(x)}) нет в ${STAGE_RU[s]}`);
    for (const { a, b } of r.pairs) {
      if (p.measure === "position") {
        const v = positionShift(a, b, p.tolerance, p.registration_mm);
        if (!v.ok) {
          skip.push(v.why);
          continue;
        }
        ok++;
        ms.push({ stage: s, key: b.key, measure: "position", value: v.shift_mm, unit: "мм", by: "geometry", page: b.page, file_id: b.file_id, at: b.at, shift_mm: v.shift_mm });
        if (v.moved) {
          bad.push(`«${b.key}» ${STAGE_RU[s]} (${where(b)}) смещён на ${num(Math.round(v.shift_mm), "мм")} относительно ${STAGE_RU[ref]} (${where(a)}), допуск ${num(p.tolerance, "мм")}`);
          frags.push(frag(a, "expected", `${a.key}: ${a.at!.map((c) => fmtNum(Math.round(c))).join("; ")}`), frag(b, "actual", `${b.key}: ${b.at!.map((c) => fmtNum(Math.round(c))).join("; ")}`));
        }
      } else {
        // вырожденный контур shapeChange не бросает, а возвращает отказ с причиной (validPolygon до площади)
        const v = shapeChange(a, b, { iou_min: p.iou_min, hausdorff_mm: p.hausdorff_mm, tol_area: p.tolerance, spread_pct: p.scale_spread_pct, reg_mm: p.registration_mm });
        if (!v.ok) {
          skip.push(v.why);
          continue;
        }
        ok++;
        ms.push({ stage: s, key: b.key, measure: "shape", value: v.iou, unit: "IoU", by: "geometry", page: b.page, file_id: b.file_id, polygon: b.polygon, iou: v.iou, hausdorff_mm: v.hausdorff_mm });
        const metr = `IoU ${fmtNum(Math.round(v.iou * 1000) / 1000)}, Хаусдорф ${num(Math.round(v.hausdorff_mm), "мм")}`;
        if (v.changed) {
          bad.push(`контур «${b.key}» ${STAGE_RU[s]} (${where(b)}) изменился: ${metr} (порог IoU ${fmtNum(p.iou_min)}, Хаусдорф ${num(p.hausdorff_mm, "мм")})`);
          frags.push(frag(a, "expected", `${a.key}: контур`), frag(b, "actual", `${b.key}: ${metr}`));
        } else if (v.method_change) {
          bad.push(`контур «${b.key}» не изменился (${metr}), а площадь по экспликации ${STAGE_RU[ref]} ${num(v.area_a!, p.unit)} → ${STAGE_RU[s]} ${num(v.area_b!, p.unit)}: изменена методика подсчёта, а не геометрия`);
          frags.push(frag(a, "expected", num(v.area_a!, p.unit)), frag(b, "actual", num(v.area_b!, p.unit)));
        }
      }
    }
  }
  if (bad.length) return out("CANDIDATE", `${p.measure === "position" ? "Смещение положения (CMP-14)" : "Изменение контура (CMP-15)"}: ${bad.join("; ")}.${skip.length ? ` Не сравнено: ${[...new Set(skip)].join("; ")}.` : ""} Правило Матрицы: ${ctx.param.trigger_logic}`, { fragments: frags });
  if (!ok) return out("NOT_COMPARABLE", `Положения и контуры не сравнимы: ${[...new Set(skip)].join("; ") || "пар элементов по ключу и положению нет (LNK-06)"}.`);
  return out("NEGATIVE_VERIFIED", `${ctx.param.parameter_name}: ${p.measure === "position" ? `смещений больше ${num(p.tolerance, "мм")} нет` : "контуры совпали"} (пар — ${ok}).${skip.length ? ` Не сравнено: ${[...new Set(skip)].join("; ")}.` : ""}`);
}

/** CMP-16 отдельным параметром: отношение проверяется в каждой стадии, где есть элементы. */
function relationEval(p: GeomPassport, picks: Record<Stage, StagePick>, stages: Stage[], _ms: Measurement[], out: Out): GeomEvaluation {
  if (!p.predicate) throw new Error("паспорт: у отношения (measure = relation) нет предиката");
  const r = predicateLines(p, picks, stages);
  if (r.bad.length) return out("CANDIDATE", `Нарушены отношения (CMP-16): ${r.bad.join("; ")}.`, { fragments: r.frags.map(([m, why]) => frag(m, "actual", why)) });
  if (r.skipped.length === stages.length) return out("NOT_COMPARABLE", `Отношения не проверены: ${r.skipped.join("; ")}.`);
  return out("NEGATIVE_VERIFIED", `Отношения соблюдены (CMP-16) в ${stages.filter((s) => !r.skipped.some((x) => x.startsWith(STAGE_RU[s]))).map((s) => STAGE_RU[s]).join(", ")}.${r.skipped.length ? ` Не проверено: ${r.skipped.join("; ")}.` : ""}`);
}

/** Граф стадии по системе: все подграфы одного ключа сливаются (система на нескольких листах). */
function mergeGraphs(ms: GeomRef[]): Map<string, { g: GeomGraph; m: GeomRef }> {
  const out = new Map<string, { g: GeomGraph; m: GeomRef }>();
  for (const m of ms) {
    if (!m.graph) continue;
    const k = m.key || m.system || "";
    const cur = out.get(k) ?? { g: { nodes: [], edges: [] }, m };
    const pre = `${m.file_id}:${m.page}:`;
    cur.g.nodes.push(...m.graph.nodes.map((n) => ({ ...n, id: pre + n.id })));
    cur.g.edges.push(...m.graph.edges.map(([u, v]) => [pre + u, pre + v] as [string, string]));
    out.set(k, cur);
  }
  // узлы с одной маркой на разных листах — один узел: рёбра стыкуются по марке
  for (const v of out.values()) {
    const first = new Map<string, string>();
    const alias = new Map<string, string>();
    for (const n of v.g.nodes) {
      const mk = n.mark?.trim();
      if (!mk) continue;
      if (first.has(mk)) alias.set(n.id, first.get(mk)!);
      else first.set(mk, n.id);
    }
    v.g.nodes = v.g.nodes.filter((n) => !alias.has(n.id));
    v.g.edges = v.g.edges.map(([a, b]) => [alias.get(a) ?? a, alias.get(b) ?? b] as [string, string]).filter(([a, b]) => a !== b);
  }
  return out;
}

/** CMP-19: подграфы систем эталона и поздних стадий по ключу системы. */
function topologyEval(p: GeomPassport, picks: Record<Stage, StagePick>, stages: Stage[], ms: Measurement[], out: Out): GeomEvaluation {
  const [ref, ...later] = stages;
  if (!later.length) return out("MISSING_EVIDENCE", `Сравнить не с чем: схема сети есть только в ${STAGE_RU[ref]}.`);
  const ga = mergeGraphs(picks[ref].used);
  const bad: string[] = [];
  const skip: string[] = [];
  const frags: Fragment[] = [];
  let ok = 0;
  for (const s of later) {
    const gb = mergeGraphs(picks[s].used);
    for (const [k, a] of ga) {
      const b = gb.get(k);
      if (!b) {
        bad.push(`система «${k}» ${STAGE_RU[ref]} (${where(a.m)}) нет в ${STAGE_RU[s]}`);
        frags.push(frag(a.m, "expected", k));
        continue;
      }
      let d;
      try {
        d = compareGraphs(a.g, b.g);
      } catch (e) {
        skip.push(`«${k}»: ${(e as Error).message}`);
        continue;
      }
      if (!d) {
        skip.push(`«${k}»: в схеме нет узлов с маркой`);
        continue;
      }
      ok++;
      ms.push({ stage: s, key: k, measure: "topology", value: d.cost, unit: "стоимость правки", by: "geometry", page: b.m.page, file_id: b.m.file_id, note: `уровень: ${d.level.join(", ")}` });
      if (d.changed) {
        const parts = [
          d.removed_nodes.length ? `нет узлов ${d.removed_nodes.join(", ")}` : "",
          d.renamed.length ? `переименованы ${d.renamed.map(([x, y]) => `${x} → ${y}`).join(", ")}` : "",
          d.removed_edges.length ? `нет подключений ${d.removed_edges.map(([x, y]) => `${x}–${y}`).join(", ")}` : "",
          d.added_nodes.length ? `добавлены ${d.added_nodes.join(", ")}` : "",
        ].filter(Boolean);
        bad.push(`«${k}» ${STAGE_RU[s]} (${where(b.m)}): ${parts.join("; ")} (правка ${fmtNum(d.cost)}, уровень — ${d.level.join(", ")})`);
        frags.push(frag(a.m, "expected", d.nodes_a.join(", ")), frag(b.m, "actual", d.nodes_b.join(", ")));
      }
    }
  }
  if (bad.length) return out("CANDIDATE", `Топология сети изменилась (CMP-19): ${bad.join("; ")}.${skip.length ? ` Не сравнено: ${skip.join("; ")}.` : ""}`, { fragments: frags });
  if (!ok) return out("NOT_COMPARABLE", `Схемы сети не сравнимы: ${skip.join("; ") || "подграфов систем нет"}.`);
  return out("NEGATIVE_VERIFIED", `Состав узлов и подключения совпали (CMP-19), систем — ${ok}.${skip.length ? ` Не сравнено: ${skip.join("; ")}.` : ""}`);
}
