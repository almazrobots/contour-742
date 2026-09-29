// Операторы геометрии плана (T-193, ADR-0010): CMP-06 по измерению (норма из Normative_Base), CMP-12 надпись против
// измерения, CMP-13 площадь полигона, CMP-14 смещение в осях здания, CMP-15 изменение контура, CMP-16 пространственные
// предикаты, CMP-19 топология сети; счёт и наличие знаков чертежа — источник для CMP-07 (T-175) и CMP-09 (T-212),
// без собственного статуса. Вход — GeomMention по контракту ADR-0010. Правила — OS-INSP-2.4.48–2.4.52, 3.1.112–3.1.124.
import { dist, distance, hausdorff, iou, pointInPolygon, polygonArea, polylineCrossings, validPolygon, type Pt, type Seg } from "./geom-core.ts";
import { normKey } from "./geom-match.ts";
import { fmtNum } from "./quantity-param.ts";
import type { GeomMention as ContractMention } from "./verify-geom.ts";

// ─────────────────────────────── контракт ML → API (ADR-0010)

export type { GeomMeasure } from "./verify-geom.ts";

export interface GeomGraph {
  nodes: Array<{ id: string; kind: string; mark: string | null }>;
  edges: Array<[string, string]>;
}

/**
 * GeomMention — одна запись = одно измерение для паспорта (Extraction.meta.geom): контракт ADR-0010 из zod-схемы
 * GeomMentionSchema (domain/verify-geom.ts, T-194) с уточнённым графом (узлы с видом и маркой), единицей паспорта
 * (мм², % — после приведения) и видом и системой элемента для фильтров паспорта. Словарь symbols[].kind закрытый:
 * smoke_detector, heat_detector, manual_call_point, sounder, exit_sign, fire_damper, fire_hydrant_valve, …
 */
export type GeomMention = Omit<ContractMention, "graph" | "unit"> & {
  graph: GeomGraph | null;
  unit: string;
  kind?: string | null; // вид элемента (openings.kind, site.kind, symbols.kind)
  system?: string | null; // система трассы (routes.system)
};

// ─────────────────────────────── единицы

const LEN: Record<string, number> = { мм: 1, см: 10, м: 1000 };
const AREA: Record<string, number> = { "мм²": 1, "см²": 100, "м²": 1e6 };

/** Перевод между единицами длины (мм, см, м) и площади (мм², см², м²); шт — без пересчёта. Прочее — громкий отказ. */
export function convertUnit(v: number, from: string, to: string): number {
  if (from === to) return v;
  if (LEN[from] && LEN[to]) return (v * LEN[from]) / LEN[to];
  if (AREA[from] && AREA[to]) return (v * AREA[from]) / AREA[to];
  throw new Error(`единицы несопоставимы: ${from} → ${to}`);
}

// ─────────────────────────────── CMP-06: норма из Normative_Base

/**
 * Запись Normative_Base — таблица normative_base (T-234: единственный источник; data/seed/norms.json → base[] — только
 * начальное наполнение, db.ts syncNormBase). min/max null и unverified — число не подтверждено по тексту СП.
 */
export interface NormRecord {
  id: string;
  doc: string;
  clause: string | null;
  edition: string | null;
  measure: string;
  min: number | null;
  max: number | null;
  unit: string;
  rule: string; // правило измерения словами: в свету, между отделанными поверхностями, полотно ≠ проём
  applies_to: string[];
  effective_from: string | null;
  effective_to: string | null;
  unverified?: boolean;
  /** Выключена администратором (Normative_Base.is_active, OS-INSP-7.2): для сравнения не действует. */
  is_active?: boolean;
}

export interface NormLimit {
  kind: "min" | "max";
  value: number;
  unit: string;
  text: string; // «≥ 1,2 м по СП 1.13130.2020, п. 4.3.4 — в свету»
  record: NormRecord | null;
}

/**
 * Норма, действующая на дату (OS-INSP-3.1.112): запись с id = ref, дата в [effective_from, effective_to]. Нет записи,
 * запись не действует или число не подтверждено — null с причиной: оператор ставит NOT_COMPARABLE, а не сравнивает.
 */
export function resolveNorm(n: { kind: "min" | "max"; value: number | null; basis: string; ref?: string }, base: NormRecord[], date: string, unit: string): NormLimit | { why: string } {
  if (!n.ref) {
    if (n.value === null) return { why: `предел нормы не задан (${n.basis})` };
    return { kind: n.kind, value: n.value, unit, text: `${n.kind === "min" ? "≥" : "≤"} ${fmtNum(n.value)} ${unit} (${n.basis})`, record: null };
  }
  const recs = base.filter((r) => r.id === n.ref);
  if (!recs.length) throw new Error(`паспорт: нормы ${n.ref} нет в Normative_Base`);
  const d = date.slice(0, 10);
  const live = recs.filter((r) => r.is_active !== false && (!r.effective_from || r.effective_from <= d) && (!r.effective_to || d <= r.effective_to));
  if (!live.length) return { why: recs.every((r) => r.is_active === false) ? `норма ${n.ref} выключена в нормативной базе` : `норма ${n.ref} не действует на ${d}` };
  const r = live[live.length - 1];
  const raw = n.kind === "min" ? r.min : r.max;
  if (r.unverified || raw === null) return { why: `норма ${r.doc}${r.clause ? `, ${r.clause}` : ""}: число не подтверждено по тексту — сравнение с нормой не выполняется` };
  const value = convertUnit(raw, r.unit, unit);
  return { kind: n.kind, value, unit, record: r, text: `${n.kind === "min" ? "≥" : "≤"} ${fmtNum(value)} ${unit} по ${r.doc}${r.clause ? `, ${r.clause}` : ""} — ${r.rule}` };
}

/** Нарушает ли значение предел (CMP-06, OS-INSP-3.1.113); запас 1e-9 — двоичная арифметика. */
export function normBroken(limit: Pick<NormLimit, "kind" | "value">, v: number): boolean {
  return limit.kind === "min" ? v < limit.value - 1e-9 : v > limit.value + 1e-9;
}

// ─────────────────────────────── CMP-12: надпись размера против измерения

export interface DimValue {
  value: number | null;
  by: "dimension" | "geometry" | "both" | null;
  not_to_scale: boolean;
  diff_pct: number | null;
  why: string | null; // почему значения нет
}

/** Масштаб листа годен для измерения: известен и разброс по размерным линиям не больше порога. */
export function scaleOk(m: Pick<GeomMention, "scale_n" | "scale_spread_pct">, spreadPct: number): boolean {
  return m.scale_n !== null && m.scale_n > 0 && m.scale_spread_pct <= spreadPct + 1e-9;
}

/**
 * CMP-12 (OS-INSP-2.4.48): надпись и измерение расходятся больше label_pct — приоритет у надписи и флаг «не в масштабе»;
 * совпали — берётся надпись (она точнее вектора). Только измерение — при годном масштабе; масштаб не годен — значения нет.
 */
export function resolveDim(m: GeomMention, labelPct: number, spreadPct: number): DimValue {
  const label = m.label_value ?? (m.by === "dimension" ? m.value : null);
  const measured = m.measured_value ?? (m.by === "geometry" ? m.value : null);
  const okScale = scaleOk(m, spreadPct);
  if (label !== null && Number.isFinite(label)) {
    if (measured === null || !okScale || !Number.isFinite(measured)) return { value: label, by: "dimension", not_to_scale: false, diff_pct: null, why: null };
    const diff = label === 0 ? (measured === 0 ? 0 : Infinity) : (Math.abs(measured - label) / Math.abs(label)) * 100;
    return { value: label, by: "both", not_to_scale: diff > labelPct + 1e-9, diff_pct: diff, why: null };
  }
  if (measured !== null && Number.isFinite(measured)) {
    if (!okScale) return { value: null, by: null, not_to_scale: false, diff_pct: null, why: m.scale_n === null ? "масштаб листа не определён" : `разброс масштаба ${fmtNum(m.scale_spread_pct)} % больше ${fmtNum(spreadPct)} %` };
    return { value: measured, by: "geometry", not_to_scale: false, diff_pct: null, why: null };
  }
  return { value: null, by: null, not_to_scale: false, diff_pct: null, why: "ни надписи размера, ни измерения" };
}

// ─────────────────────────────── перевод геометрии в мм натуры

/** Коэффициент листа → мм натуры: в осях здания — 1, на листе — знаменатель масштаба; масштаб не годен — null. */
export function realFactor(m: GeomMention, spreadPct: number): number | null {
  if (m.frame === "bld") return 1;
  return scaleOk(m, spreadPct) ? m.scale_n : null;
}

const scalePts = (ps: Pt[], k: number): Pt[] => ps.map(([x, y]) => [x * k, y * k]);

// ─────────────────────────────── CMP-13: площадь полигона

export interface AreaValue {
  value: number | null;
  by: "dimension" | "geometry" | "both" | null;
  geom_value: number | null; // площадь по контуру, в единице паспорта
  control_diff_pct: number | null;
  control_flag: boolean; // геометрия расходится с экспликацией больше порога — контроль, а не замена значения
  why: string | null;
}

/**
 * CMP-13 (OS-INSP-2.4.49): площадь по контуру — формулой шнурования в мм² натуры, в единице паспорта. Для помещений
 * (label из экспликации) приоритет у экспликации, геометрия — контроль: расхождение > controlPct — флаг, значение прежнее.
 * Вырожденный контур — значения по геометрии нет с причиной (громкий отказ ядра не глотается молча).
 */
export function resolveArea(m: GeomMention, unit: string, controlPct: number, spreadPct: number): AreaValue {
  let geom: number | null = null;
  let why: string | null = null;
  if (m.polygon) {
    const bad = validPolygon(m.polygon);
    const k = realFactor(m, spreadPct);
    if (bad) why = bad;
    else if (k === null) why = "масштаб листа не годен для площади";
    else geom = convertUnit(polygonArea(scalePts(m.polygon, k)), "мм²", unit);
  }
  const label = m.label_value ?? (m.by === "dimension" ? m.value : null);
  if (label !== null) {
    const diff = geom === null ? null : label === 0 ? null : (Math.abs(geom - label) / Math.abs(label)) * 100;
    return { value: label, by: geom === null ? "dimension" : "both", geom_value: geom, control_diff_pct: diff, control_flag: diff !== null && diff > controlPct + 1e-9, why: null };
  }
  if (geom !== null) return { value: geom, by: "geometry", geom_value: geom, control_diff_pct: null, control_flag: false, why: null };
  const measured = m.measured_value ?? (m.by === "geometry" ? m.value : null);
  if (measured !== null && !m.polygon && scaleOk(m, spreadPct)) return { value: measured, by: "geometry", geom_value: measured, control_diff_pct: null, control_flag: false, why: null };
  return { value: null, by: null, geom_value: null, control_diff_pct: null, control_flag: false, why: why ?? "ни значения экспликации, ни контура" };
}

// ─────────────────────────────── CMP-14: смещение в осях здания

export type PosVerdict = { ok: false; why: string } | { ok: true; shift_mm: number; moved: boolean };

/**
 * CMP-14 (OS-INSP-3.1.116): предусловие — обе стороны в осях здания (bld) и остаток регистрации каждой не больше
 * допуска регистрации; иначе сравнение положения не выполняется (NOT_COMPARABLE). Смещение > допуска — moved.
 */
export function positionShift(a: GeomMention, b: GeomMention, tolMm: number, regMm: number): PosVerdict {
  for (const m of [a, b]) {
    if (m.frame !== "bld") return { ok: false, why: `лист стр. ${m.page} не зарегистрирован в осях здания` };
    if (m.residual_mm === null || !(m.residual_mm <= regMm + 1e-9)) return { ok: false, why: `остаток регистрации листа стр. ${m.page} ${m.residual_mm === null ? "неизвестен" : `${fmtNum(m.residual_mm)} мм`} больше допуска ${fmtNum(regMm)} мм` };
    if (!m.at) return { ok: false, why: `у элемента «${m.key}» (стр. ${m.page}) нет положения` };
  }
  const shift = dist(a.at!, b.at!);
  return { ok: true, shift_mm: shift, moved: shift > tolMm + 1e-9 };
}

// ─────────────────────────────── CMP-15: изменение контура

export type ShapeVerdict =
  | { ok: false; why: string }
  | { ok: true; iou: number; hausdorff_mm: number; changed: boolean; method_change: boolean; area_a: number | null; area_b: number | null };

/**
 * CMP-15 (OS-INSP-3.1.117–3.1.118): контур изменился, если IoU < iouMin или Хаусдорф > hausMm. Обратная логика (POL16):
 * контур тот же, а площадь по экспликации изменилась больше допуска — method_change (методика подсчёта, не геометрия).
 * Контуры сравниваются в мм натуры и в одной системе координат; вырожденный контур — отказ с причиной.
 */
export function shapeChange(a: GeomMention, b: GeomMention, p: { iou_min: number; hausdorff_mm: number; tol_area: number; spread_pct: number; reg_mm: number }): ShapeVerdict {
  for (const m of [a, b]) {
    const bad = validPolygon(m.polygon);
    if (bad) return { ok: false, why: `контур «${m.key}» (стр. ${m.page}): ${bad}` };
  }
  // листы разных стадий — разные документы: без регистрации в осях здания (LNK-03) их координаты несравнимы
  if (a.frame !== "bld" || b.frame !== "bld") return { ok: false, why: "контур не переведён в оси здания — нужна регистрация листов (LNK-03)" };
  for (const m of [a, b]) if (m.residual_mm === null || !(m.residual_mm <= p.reg_mm + 1e-9)) return { ok: false, why: `остаток регистрации листа стр. ${m.page} больше допуска ${fmtNum(p.reg_mm)} мм` };
  const ka = realFactor(a, p.spread_pct);
  const kb = realFactor(b, p.spread_pct);
  if (ka === null || kb === null) return { ok: false, why: "масштаб листа не годен для сравнения контуров" };
  const pa = scalePts(a.polygon!, ka);
  const pb = scalePts(b.polygon!, kb);
  const v = iou(pa, pb);
  const h = hausdorff(pa, pb);
  const changed = v < p.iou_min - 1e-9 || h > p.hausdorff_mm + 1e-9;
  const la = a.label_value;
  const lb = b.label_value;
  const method_change = !changed && la !== null && lb !== null && Math.abs(la - lb) > p.tol_area + 1e-9;
  return { ok: true, iou: v, hausdorff_mm: h, changed, method_change, area_a: la, area_b: lb };
}

// ─────────────────────────────── CMP-16: пространственные предикаты

export type Predicate =
  | { kind: "inside"; of: string; of_kinds?: string[] }
  | { kind: "intersects"; of: string; of_kinds?: string[] }
  | { kind: "distance"; of: string; of_kinds?: string[]; max_mm: number }
  | { kind: "covers"; of: string; of_kinds?: string[]; radius_mm: number; step_mm: number }
  | { kind: "max_spacing"; max_mm: number }
  | { kind: "near_crossing"; barrier: string; barrier_kinds?: string[]; device: string; device_kinds?: string[]; radius_mm: number };

/** Элементы сущностей предиката с фильтром вида (стены — только противопожарные, знаки — только клапаны). */
export function predicateOthers(pred: Predicate, others: Record<string, GeomMention[]>): Record<string, GeomMention[]> {
  const pick = (code: string, kinds?: string[]) => (others[code] ?? []).filter((m) => !kinds?.length || kinds.includes(m.kind ?? ""));
  switch (pred.kind) {
    case "max_spacing":
      return {};
    case "near_crossing":
      return { [pred.barrier]: pick(pred.barrier, pred.barrier_kinds), [pred.device]: pick(pred.device, pred.device_kinds) };
    default:
      return { [pred.of]: pick(pred.of, pred.of_kinds) };
  }
}

export interface Violation {
  key: string;
  at: Pt | null;
  why: string;
  mention: GeomMention | null;
}

export type RelationVerdict = { ok: false; why: string } | { ok: true; checked: number; violations: Violation[] };

/** Фигура элемента в мм натуры: контур или ломаная (polygon), иначе точка (at); null — масштаб не годен или фигуры нет. */
function shape(m: GeomMention, spreadPct: number): Pt[] | null {
  const k = realFactor(m, spreadPct);
  if (k === null) return null;
  if (m.polygon?.length) return scalePts(m.polygon, k);
  return m.at ? scalePts([m.at], k) : null;
}

const centerOf = (s: Pt[]): Pt => [s.reduce((a, p) => a + p[0], 0) / s.length, s.reduce((a, p) => a + p[1], 0) / s.length];

/**
 * CMP-16 (OS-INSP-3.1.119–3.1.121): предикат паспорта над элементами одной стадии. subjects — элементы параметра,
 * others — элементы сущностей предиката по коду ENT. Элементы в разных системах координат (оси здания и лист, два
 * листа без регистрации) не сравниваются — отказ с причиной. Пусто — отказ: «нарушений нет» по пустоте не выводится.
 */
export function checkRelation(pred: Predicate, subjects: GeomMention[], others: Record<string, GeomMention[]>, spreadPct: number): RelationVerdict {
  if (!subjects.length) return { ok: false, why: "элементов для проверки нет" };
  const all = [...subjects, ...Object.values(others).flat()];
  const frames = new Set(all.map((m) => (m.frame === "bld" ? "bld" : `sheet:${m.page}`)));
  if (frames.size > 1) return { ok: false, why: "элементы на разных листах без регистрации в осях здания" };
  const sh = (m: GeomMention) => shape(m, spreadPct);
  if (all.some((m) => sh(m) === null)) return { ok: false, why: "масштаб листа не годен или у элемента нет положения" };
  const violations: Violation[] = [];
  const target = (code: string) => {
    const t = others[code] ?? [];
    if (!t.length) throw new RelationGap(`на листе нет элементов ${code} для предиката`);
    return t.map((m) => sh(m)!);
  };
  try {
    switch (pred.kind) {
      case "inside":
      case "intersects":
      case "distance": {
        const ts = target(pred.of);
        for (const m of subjects) {
          const s = sh(m)!;
          const ok =
            pred.kind === "inside"
              ? ts.some((t) => t.length >= 3 && s.every((p) => pointInPolygon(p, t)))
              : pred.kind === "intersects"
                ? ts.some((t) => distance(s, t) <= 1e-9)
                : ts.some((t) => distance(s, t) <= pred.max_mm + 1e-9);
          if (!ok) {
            const d = Math.min(...ts.map((t) => distance(s, t)));
            violations.push({ key: m.key, at: centerOf(s), mention: m, why: pred.kind === "inside" ? `«${m.key}» не внутри ${pred.of}` : pred.kind === "intersects" ? `«${m.key}» не пересекает ${pred.of}` : `«${m.key}» дальше ${fmtNum(pred.max_mm)} мм от ${pred.of} (${fmtNum(Math.round(d))} мм)` });
          }
        }
        return { ok: true, checked: subjects.length, violations };
      }
      case "covers": {
        const areas = target(pred.of).filter((t) => t.length >= 3);
        const centers = subjects.map((m) => centerOf(sh(m)!));
        let checked = 0;
        for (const poly of areas) {
          const xs = poly.map((p) => p[0]);
          const ys = poly.map((p) => p[1]);
          if ((Math.max(...xs) - Math.min(...xs)) / pred.step_mm > 2000 || (Math.max(...ys) - Math.min(...ys)) / pred.step_mm > 2000) throw new Error("CMP-16 covers: шаг сетки слишком мал для контура");
          const pts: Pt[] = [...poly];
          for (let x = Math.min(...xs); x <= Math.max(...xs); x += pred.step_mm) for (let y = Math.min(...ys); y <= Math.max(...ys); y += pred.step_mm) if (pointInPolygon([x, y], poly)) pts.push([x, y]);
          for (const p of pts) {
            checked++;
            if (!centers.some((c) => dist(c, p) <= pred.radius_mm + 1e-9)) {
              violations.push({ key: "", at: p, mention: null, why: `точка контура ${pred.of} вне радиуса ${fmtNum(pred.radius_mm)} мм` });
              break; // одной непокрытой точки на контур достаточно: список не раздувается сеткой
            }
          }
        }
        return { ok: true, checked, violations };
      }
      case "max_spacing": {
        const pts = subjects.map((m) => centerOf(sh(m)!));
        if (pts.length < 2) return { ok: true, checked: pts.length, violations };
        pts.forEach((p, i) => {
          const nn = Math.min(...pts.filter((_, j) => j !== i).map((q) => dist(p, q)));
          if (nn > pred.max_mm + 1e-9) violations.push({ key: subjects[i].key, at: p, mention: subjects[i], why: `до ближайшего ${fmtNum(Math.round(nn))} мм — больше шага ${fmtNum(pred.max_mm)} мм` });
        });
        return { ok: true, checked: pts.length, violations };
      }
      case "near_crossing": {
        const barriers: Seg[] = target(pred.barrier).flatMap((b) => (b.length === 2 ? [[b[0], b[1]] as Seg] : b.map((p, i) => [p, b[(i + 1) % b.length]] as Seg)));
        const devices = (others[pred.device] ?? []).map((m) => centerOf(sh(m)!));
        let checked = 0;
        for (const m of subjects) {
          const line = sh(m)!;
          for (const x of polylineCrossings(line, barriers)) {
            checked++;
            if (!devices.some((d) => dist(d, x.at) <= pred.radius_mm + 1e-9)) violations.push({ key: m.key, at: x.at, mention: m, why: `пересечение трассы «${m.key}» с преградой без ${pred.device} в радиусе ${fmtNum(pred.radius_mm)} мм` });
          }
        }
        return { ok: true, checked, violations };
      }
    }
  } catch (e) {
    if (e instanceof RelationGap) return { ok: false, why: e.message };
    throw e;
  }
}

class RelationGap extends Error {}

// ─────────────────────────────── CMP-19: топология сети

export interface GraphDiff {
  level: string[]; // виды узлов, по которым сравнивали (менее детальная сторона)
  nodes_a: string[];
  nodes_b: string[];
  removed_nodes: string[];
  added_nodes: string[];
  renamed: Array<[string, string]>;
  removed_edges: Array<[string, string]>;
  added_edges: Array<[string, string]>;
  cost: number; // edit distance с весами
  changed: boolean; // удаление узла или ребра, переименование — изменение; добавление — детализация (VER-07)
}

/** Веса операций edit distance: удалить ветвь (узел) дороже, чем переименовать (каталог, CMP-19). */
export const GRAPH_COST = { remove_node: 3, add_node: 1, rename: 1, remove_edge: 2, add_edge: 1 } as const;

/** Граф годен: узлы с уникальными id, рёбра только между существующими узлами; иначе — громкий отказ. */
function checkGraph(g: GeomGraph, side: string): void {
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error(`граф ${side}: нет узлов или рёбер`);
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) throw new Error(`граф ${side}: узел ${n.id} повторяется`);
    ids.add(n.id);
  }
  for (const [u, v] of g.edges) if (!ids.has(u) || !ids.has(v)) throw new Error(`граф ${side}: ребро ${u}–${v} ведёт к несуществующему узлу`);
}

/**
 * Проекция графа (NRM-15): остаются узлы keep, рёбра стягиваются через выброшенные узлы (отвод, переход, решётка
 * без марки не рвут связь «установка → стояк»). Узлы — по нормализованной марке.
 */
export function projectGraph(g: GeomGraph, keep: (n: GeomGraph["nodes"][number]) => boolean): { nodes: Map<string, string>; edges: Set<string> } {
  const adj = new Map<string, string[]>();
  for (const n of g.nodes) adj.set(n.id, []);
  for (const [u, v] of g.edges) {
    adj.get(u)!.push(v);
    adj.get(v)!.push(u);
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const nodes = new Map<string, string>(); // марка → вид
  for (const n of g.nodes) if (keep(n)) nodes.set(normKey(n.mark), n.kind);
  const edges = new Set<string>();
  for (const n of g.nodes) {
    if (!keep(n)) continue;
    const seen = new Set([n.id]);
    const stack = [...adj.get(n.id)!];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const m = byId.get(id)!;
      if (keep(m)) {
        const [x, y] = [normKey(n.mark), normKey(m.mark)].sort();
        if (x !== y) edges.add(`${x}\u0000${y}`);
      } else stack.push(...adj.get(id)!);
    }
  }
  return { nodes, edges };
}

/**
 * CMP-19 (OS-INSP-3.1.122–3.1.124): сравнение подграфов системы. Узлы — с маркой; уровень — по менее детальной стороне
 * (виды узлов стороны с меньшим числом марок), детали другой стороны стягиваются. Переименование — удалённый и
 * добавленный узел одного вида с одинаковыми соседями. Пустой граф (нет узлов с маркой) — null: сравнивать нечего.
 */
export function compareGraphs(a: GeomGraph, b: GeomGraph): GraphDiff | null {
  checkGraph(a, "эталона");
  checkGraph(b, "сравниваемой стадии");
  const marked = (n: GeomGraph["nodes"][number]) => Boolean(normKey(n.mark));
  const fa = projectGraph(a, marked);
  const fb = projectGraph(b, marked);
  if (!fa.nodes.size || !fb.nodes.size) return null;
  const less = fa.nodes.size <= fb.nodes.size ? fa : fb;
  const level = [...new Set(less.nodes.values())].sort();
  const keep = (n: GeomGraph["nodes"][number]) => marked(n) && level.includes(n.kind);
  const pa = projectGraph(a, keep);
  const pb = projectGraph(b, keep);
  let removed = [...pa.nodes.keys()].filter((k) => !pb.nodes.has(k));
  let added = [...pb.nodes.keys()].filter((k) => !pa.nodes.has(k));
  const nb = (edges: Set<string>, k: string) =>
    [...edges]
      .map((e) => e.split("\u0000"))
      .filter((e) => e.includes(k))
      .map((e) => (e[0] === k ? e[1] : e[0]))
      .sort()
      .join("|");
  const renamed: Array<[string, string]> = [];
  for (const r of [...removed]) {
    const n = nb(pa.edges, r);
    if (!n) continue;
    const t = added.find((x) => pb.nodes.get(x) === pa.nodes.get(r) && nb(pb.edges, x) === n);
    if (t) {
      renamed.push([r, t]);
      removed = removed.filter((x) => x !== r);
      added = added.filter((x) => x !== t);
    }
  }
  const ren = new Map(renamed);
  const ea = new Set(
    [...pa.edges].map((e) =>
      e
        .split("\u0000")
        .map((k) => ren.get(k) ?? k)
        .sort()
        .join("\u0000"),
    ),
  );
  const removed_edges = [...ea].filter((e) => !pb.edges.has(e)).map((e) => e.split("\u0000") as [string, string]);
  const added_edges = [...pb.edges].filter((e) => !ea.has(e)).map((e) => e.split("\u0000") as [string, string]);
  const cost = GRAPH_COST.remove_node * removed.length + GRAPH_COST.add_node * added.length + GRAPH_COST.rename * renamed.length + GRAPH_COST.remove_edge * removed_edges.length + GRAPH_COST.add_edge * added_edges.length;
  return {
    level,
    nodes_a: [...pa.nodes.keys()].sort(),
    nodes_b: [...pb.nodes.keys()].sort(),
    removed_nodes: removed.sort(),
    added_nodes: added.sort(),
    renamed,
    removed_edges,
    added_edges,
    cost,
    changed: removed.length + renamed.length + removed_edges.length > 0,
  };
}

// ─────────────────────────────── знаки чертежа: источник для CMP-07 (T-175) и CMP-09 (T-212)

export interface SymbolFilter {
  kinds?: string[];
  mark?: string; // регулярное выражение марки
}

const fits = (m: Pick<GeomMention, "kind" | "key">, f: SymbolFilter): boolean =>
  (!f.kinds?.length || f.kinds.includes(m.kind ?? "")) && (!f.mark || new RegExp(f.mark, "u").test(m.key ?? ""));

/**
 * Счёт знаков по чертежу (OS-INSP-2.2.125): одна запись-упоминание measure = count, by = geometry — второй источник
 * двойного подсчёта для оператора CMP-07 (владелец T-175). Статус здесь не ставится. Знаки с разных листов не
 * суммируются в один счёт — по листу своё упоминание: один знак на двух листах (план и разрез) не удваивается молча.
 */
export function symbolCount(symbols: GeomMention[], f: SymbolFilter): GeomMention[] {
  const pages = new Map<number, GeomMention[]>();
  for (const s of symbols.filter((m) => fits(m, f))) pages.set(s.page, [...(pages.get(s.page) ?? []), s]);
  return [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, ss]) => ({
      entity: ss[0].entity, measure: "count", value: ss.length, unit: "шт", by: "geometry", label_value: null, measured_value: ss.length,
      key: f.kinds?.join(",") ?? "", at: null, polygon: null, graph: null, frame: ss[0].frame, scale_n: ss[0].scale_n, scale_spread_pct: ss[0].scale_spread_pct,
      residual_mm: ss[0].residual_mm, page, bbox: unionBox(ss.map((s) => s.bbox)), quote: `знаков на листе: ${ss.length}`, kind: f.kinds?.[0] ?? null,
    }));
}

function unionBox(bs: Array<GeomMention["bbox"]>): GeomMention["bbox"] {
  const xs = bs.filter((b): b is [number, number, number, number] => b !== null);
  if (!xs.length) return null;
  return [Math.min(...xs.map((b) => b[0])), Math.min(...xs.map((b) => b[1])), Math.max(...xs.map((b) => b[2])), Math.max(...xs.map((b) => b[3]))];
}

/**
 * Упоминание наличия по форме PresenceMention T-212 (CMP-09, владелец W3): state, aspect, term, count.
 * TODO(T-212): после влития feat/w3-presence — импорт типа из ./presence-param.ts вместо локального и
 * "plan_geometry" в Mention.source (class-param.ts); сигнатуры W3 здесь не меняются.
 */
export interface PresenceFromPlan {
  state: "present" | "absent";
  aspect: string;
  term: string | null;
  count: number | null;
  source: "plan_geometry";
  page: number;
  bbox: [number, number, number, number] | null;
  quote: string;
}

/**
 * Наличие знака на листе (OS-INSP-2.2.126): знаки есть — present со счётом и рамкой; на векторном листе знаков вида
 * нет — absent (лист просмотрен, знака нет). Лист без векторного слоя сюда не попадает: «не нашли» ≠ «нет».
 */
export function symbolPresence(symbols: GeomMention[], f: SymbolFilter, aspect: string, pagesSeen: number[]): PresenceFromPlan[] {
  const counts = symbolCount(symbols, f);
  return [...new Set(pagesSeen)].sort((a, b) => a - b).map((page) => {
    const c = counts.find((x) => x.page === page);
    return c
      ? { state: "present", aspect, term: null, count: c.value, source: "plan_geometry", page, bbox: c.bbox, quote: c.quote }
      : { state: "absent", aspect, term: null, count: 0, source: "plan_geometry", page, bbox: null, quote: "знаков этого вида на листе нет" };
  });
}
