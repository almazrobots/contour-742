// Согласованность внутри стадии и между разделами (каталог TO-BE §7, карточки CMP-30 INTERNAL-CONS и CMP-31
// CROSS-DISC, T-194). Вход — листы-планы вида PlanGeometry (ADR-0010: помещения, стены, трассы, знаки, проёмы) и
// таблицы стадии (спецификация, ТЭП, экспликация, ведомость проёмов). Выход — гипотезы SUSPICION (как OS-INSP-3.1.12:
// к инспектору, не нарушение) и список пропущенных проверок с причиной: «не с чем сравнить» ≠ «расхождения нет».
// Правила — OS-INSP-3.1.133–3.1.139.
import { z } from "zod";
import { STAGES, type Stage } from "./types.ts";
import { agrees } from "./verify-geom.ts";

// ─────────────────────────────── вход

const Pt = z.tuple([z.number(), z.number()]);
const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable();

/** Лист-план раздела: подмножество PlanGeometry (ADR-0010) + чей он. Координаты — мм листа; to_bld — в оси здания. */
export const XSheetSchema = z.object({
  file_id: z.string().min(1),
  document_code: z.string().min(1),
  stage: z.enum(STAGES),
  discipline: z.string().min(1), // АР, ОВ, ВК, ЭОМ …
  floor: z.string().nullable(), // этаж листа; null — не определён
  page: z.number().int().positive(),
  frame: z.object({
    to_bld: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]).nullable(),
    residual_mm: z.number().nonnegative().nullable(),
  }),
  rooms: z.array(z.object({ number: z.string().min(1), bbox: BBox })),
  walls: z.array(z.object({ a: Pt, b: Pt, fire: z.boolean(), bbox: BBox })),
  routes: z.array(z.object({ system: z.string().min(1), points: z.array(Pt).min(2), nodes: z.array(z.object({ id: z.string(), kind: z.string(), mark: z.string().nullable(), at: Pt })), bbox: BBox })),
  symbols: z.array(z.object({ kind: z.string(), mark: z.string().nullable(), at: Pt, bbox: BBox })),
  openings: z.array(z.object({ mark: z.string().min(1), width_mm: z.number().positive().nullable(), bbox: BBox })),
});
export type XSheet = z.infer<typeof XSheetSchema>;

const Src = { document_code: z.string().min(1), page: z.number().int().positive(), bbox: BBox };
export const XTablesSchema = z.object({
  spec: z.array(z.object({ key: z.string().min(1), qty: z.number().nonnegative(), ...Src })), // спецификация: позиция/марка → шт
  tep: z.array(z.object({ kind: z.literal("total_area"), value: z.number().nonnegative(), ...Src })), // ТЭП: общая площадь, м²
  explications: z.array(z.object({ floor: z.string().nullable(), rows: z.array(z.object({ number: z.string().min(1), area: z.number().nonnegative() })), total: z.number().nonnegative().nullable(), ...Src })),
  schedule: z.array(z.object({ mark: z.string().min(1), width_mm: z.number().positive(), ...Src })), // ведомость заполнения проёмов
});
export type XTables = z.infer<typeof XTablesSchema>;

export const XInputSchema = z.object({ stage: z.enum(STAGES), sheets: z.array(XSheetSchema), tables: XTablesSchema });
export type XInput = z.infer<typeof XInputSchema>;

const Tol = z.strictObject({ abs: z.number().nonnegative(), pct: z.number().nonnegative() });
/** Настройки — раздел `xdisc` файла data/seed/geom-gates.json. */
export const XdiscGatesSchema = z.strictObject({
  tol: z.strictObject({ spec_count: Tol, tep_explication: Tol, explication_total: Tol, opening_width: Tol }),
  residual_mm: z.number().positive(),
  damper_radius_mm: z.number().positive(),
});
export type XdiscGates = z.infer<typeof XdiscGatesSchema>;

// ─────────────────────────────── выход

export interface XSide {
  document_code: string;
  page: number;
  bbox: [number, number, number, number] | null;
  value: string;
}

export type XCheck = "spec_count" | "tep_explication" | "explication_total" | "opening_width" | "room_missing_in_ar" | "fire_wall_no_damper";

export interface XSuspicion {
  op: "CMP-30" | "CMP-31";
  check: XCheck;
  stage: Stage;
  key: string;
  status: "CLARIFICATION_REQUIRED";
  suspicion: true;
  description: string;
  sides: XSide[];
  dedup_key: string;
}

export interface XSkipped {
  op: "CMP-30" | "CMP-31";
  check: XCheck;
  why: string;
}

export interface XResult {
  suspicions: XSuspicion[];
  skipped: XSkipped[];
}

// ─────────────────────────────── общее

/** Ключ марки и номера: без пробелов, верхний регистр, латинские двойники → кириллица («B2.7» и «В2.7» — одно). */
const TWINS: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
export function keyOf(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "").replace(/[ABCEHKMOPTXY]/g, (c) => TWINS[c]);
}

/** Согласие двух значений — то же правило, что VER-06 (одна функция на оба слоя). */
export { agrees };

const fmt = (v: number) => String(Math.round(v * 100) / 100).replace(".", ",");
const where = (s: { document_code: string; page: number }) => `${s.document_code}, стр. ${s.page}`;

function suspicion(op: XSuspicion["op"], check: XCheck, stage: Stage, key: string, description: string, sides: XSide[]): XSuspicion {
  const sig = sides.map((s) => `${s.document_code}@${s.page}:${s.value}`).sort().join("|");
  return { op, check, stage, key, status: "CLARIFICATION_REQUIRED", suspicion: true, description, sides, dedup_key: `${op}:${check}:${stage}:${keyOf(key)}:${sig}` };
}

// ─────────────────────────────── CMP-30 внутри стадии

/** Спецификация против счёта знаков на планах стадии (двойной подсчёт каталога §8; MUT-14). */
export function specVsCount(stage: Stage, sheets: XSheet[], spec: XTables["spec"], tol: XdiscGates["tol"]): XResult {
  const out: XResult = { suspicions: [], skipped: [] };
  const plans = sheets.filter((s) => s.symbols.length > 0);
  if (!spec.length || !plans.length) {
    out.skipped.push({ op: "CMP-30", check: "spec_count", why: !spec.length ? "в стадии нет спецификации" : "в стадии нет планов со знаками" });
    return out;
  }
  const counted = new Map<string, { n: number; label: string; at: XSheet[] }>();
  for (const s of plans) {
    for (const sym of s.symbols) {
      if (!sym.mark) continue;
      const k = keyOf(sym.mark);
      const c = counted.get(k) ?? { n: 0, label: sym.mark, at: [] };
      c.n++;
      if (!c.at.includes(s)) c.at.push(s);
      counted.set(k, c);
    }
  }
  const specBy = new Map<string, { qty: number; rows: XTables["spec"] }>();
  for (const r of spec) {
    const k = keyOf(r.key);
    const e = specBy.get(k) ?? { qty: 0, rows: [] };
    e.qty += r.qty;
    e.rows.push(r);
    specBy.set(k, e);
  }
  for (const k of new Set([...specBy.keys(), ...counted.keys()])) {
    const sp = specBy.get(k);
    const ct = counted.get(k);
    const q = sp?.qty ?? 0;
    const n = ct?.n ?? 0;
    if (agrees(q, n, tol.spec_count)) continue;
    const label = sp?.rows[0].key ?? ct!.label;
    const sides: XSide[] = [
      ...(sp?.rows ?? []).map((r) => ({ document_code: r.document_code, page: r.page, bbox: r.bbox, value: `${fmt(r.qty)} шт` })),
      ...(ct?.at ?? []).map((s) => ({ document_code: s.document_code, page: s.page, bbox: null, value: `${s.symbols.filter((y) => y.mark && keyOf(y.mark) === k).length} знаков` })),
    ];
    const specTxt = sp ? `${fmt(q)} шт (${sp.rows.map(where).join("; ")})` : "позиции нет";
    const planTxt = ct ? `${n} знаков (${ct.at.map(where).join("; ")})` : "знаков нет";
    out.suspicions.push(suspicion("CMP-30", "spec_count", stage, label, `Внутреннее противоречие: ${label} — в спецификации ${specTxt}, на планах ${planTxt}`, sides));
  }
  return out;
}

/** ТЭП (общая площадь) против суммы экспликаций и экспликация против собственного итога (ENT-02). */
export function tepVsExplication(stage: Stage, tables: Pick<XTables, "tep" | "explications">, tol: XdiscGates["tol"]): XResult {
  const out: XResult = { suspicions: [], skipped: [] };
  for (const e of tables.explications) {
    if (e.total === null) continue;
    const sum = e.rows.reduce((s, r) => s + r.area, 0);
    if (agrees(sum, e.total, tol.explication_total)) continue;
    const key = `экспликация ${e.floor ?? ""}`.trim();
    out.suspicions.push(suspicion("CMP-30", "explication_total", stage, key, `Внутреннее противоречие: сумма строк экспликации ${fmt(sum)} м² не равна итогу ${fmt(e.total)} м² (${where(e)})`, [{ document_code: e.document_code, page: e.page, bbox: e.bbox, value: `${fmt(sum)} / ${fmt(e.total)} м²` }]));
  }
  if (!tables.tep.length || !tables.explications.length) {
    out.skipped.push({ op: "CMP-30", check: "tep_explication", why: !tables.tep.length ? "в стадии нет ТЭП с общей площадью" : "в стадии нет экспликации помещений" });
    return out;
  }
  const sum = tables.explications.reduce((s, e) => s + e.rows.reduce((a, r) => a + r.area, 0), 0);
  for (const t of tables.tep) {
    if (agrees(t.value, sum, tol.tep_explication)) continue;
    out.suspicions.push(
      suspicion("CMP-30", "tep_explication", stage, "общая площадь", `Внутреннее противоречие: общая площадь по ТЭП ${fmt(t.value)} м² (${where(t)}), по экспликациям ${fmt(sum)} м² (${tables.explications.map(where).join("; ")})`, [
        { document_code: t.document_code, page: t.page, bbox: t.bbox, value: `${fmt(t.value)} м²` },
        ...tables.explications.map((e) => ({ document_code: e.document_code, page: e.page, bbox: e.bbox, value: `${fmt(e.rows.reduce((a, r) => a + r.area, 0))} м²` })),
      ]),
    );
  }
  return out;
}

/** Ведомость проёмов против ширины проёма, измеренной по геометрии плана (дуга двери, разрыв стены). */
export function scheduleVsGeometry(stage: Stage, sheets: XSheet[], schedule: XTables["schedule"], tol: XdiscGates["tol"]): XResult {
  const out: XResult = { suspicions: [], skipped: [] };
  if (!schedule.length) {
    out.skipped.push({ op: "CMP-30", check: "opening_width", why: "в стадии нет ведомости проёмов" });
    return out;
  }
  for (const r of schedule) {
    const k = keyOf(r.mark);
    const bad = sheets.flatMap((s) => s.openings.filter((o) => keyOf(o.mark) === k && o.width_mm !== null && !agrees(o.width_mm, r.width_mm, tol.opening_width)).map((o) => ({ s, o })));
    if (!bad.length) continue;
    out.suspicions.push(
      suspicion("CMP-30", "opening_width", stage, r.mark, `Внутреннее противоречие: ${r.mark} — по ведомости ${fmt(r.width_mm)} мм (${where(r)}), по плану ${bad.map(({ s, o }) => `${fmt(o.width_mm!)} мм (${where(s)})`).join("; ")}`, [
        { document_code: r.document_code, page: r.page, bbox: r.bbox, value: `${fmt(r.width_mm)} мм` },
        ...bad.map(({ s, o }) => ({ document_code: s.document_code, page: s.page, bbox: o.bbox, value: `${fmt(o.width_mm!)} мм` })),
      ]),
    );
  }
  return out;
}

// ─────────────────────────────── CMP-31 между разделами

const isAr = (s: XSheet) => keyOf(s.discipline) === keyOf("АР");
const isOv = (s: XSheet) => /^ОВ/.test(keyOf(s.discipline));

/** Помещения, обслуживаемые в ОВ (номер на плане ОВ), которых нет ни на одном плане АР стадии. */
export function ovRoomsMissingInAr(stage: Stage, sheets: XSheet[]): XResult {
  const out: XResult = { suspicions: [], skipped: [] };
  const ar = sheets.filter(isAr);
  const ov = sheets.filter(isOv);
  if (!ov.length) return out;
  if (!ar.length || !ar.some((s) => s.rooms.length)) {
    out.skipped.push({ op: "CMP-31", check: "room_missing_in_ar", why: "в стадии нет планов АР с помещениями — отсутствие не доказать" });
    return out;
  }
  const arRooms = new Set(ar.flatMap((s) => s.rooms.map((r) => keyOf(r.number))));
  const seen = new Set<string>();
  for (const s of ov) {
    for (const r of s.rooms) {
      const k = keyOf(r.number);
      if (arRooms.has(k) || seen.has(k)) continue;
      seen.add(k);
      const at = ov.flatMap((o) => o.rooms.filter((x) => keyOf(x.number) === k).map((x) => ({ document_code: o.document_code, page: o.page, bbox: x.bbox, value: `пом. ${x.number}` })));
      out.suspicions.push(suspicion("CMP-31", "room_missing_in_ar", stage, r.number, `Между разделами: помещение ${r.number} обслуживается в ${s.discipline} (${at.map(where).join("; ")}), а на планах АР его нет (${ar.map(where).join("; ")})`, at));
    }
  }
  return out;
}

type P = [number, number];

/** Точка листа в оси здания: матрица PDF [a, b, c, d, e, f] — x' = a·x + c·y + e, y' = b·x + d·y + f. */
export function toBld(m: readonly number[], p: readonly number[]): P {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Точка пересечения отрезков [p1, p2] и [q1, q2] (включая касание концом); параллельные — null. */
export function crossing(p1: P, p2: P, q1: P, q2: P): P | null {
  const r: P = [p2[0] - p1[0], p2[1] - p1[1]];
  const s: P = [q2[0] - q1[0], q2[1] - q1[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const qp: P = [q1[0] - p1[0], q1[1] - p1[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return [p1[0] + t * r[0], p1[1] + t * r[1]];
}

/** Узлы и знаки ОВ, которые считаются клапаном у преграды (огнезадерживающий, противопожарный, НО-клапан). */
export const DAMPER_KINDS = new Set(["fire_damper", "damper", "valve_fire"]);

/** Лист годится для наложения: есть переход в оси здания, остаток регистрации в допуске, этаж известен. */
export function unregistered(s: XSheet, gates: XdiscGates): string | null {
  if (s.floor === null) return `${where(s)}: этаж листа не определён`;
  if (!s.frame.to_bld || s.frame.residual_mm === null) return `${where(s)}: лист не зарегистрирован в осях здания`;
  if (s.frame.residual_mm > gates.residual_mm + 1e-9) return `${where(s)}: остаток регистрации ${fmt(s.frame.residual_mm)} мм больше допуска ${fmt(gates.residual_mm)} мм`;
  return null;
}

/** Трассы ОВ, пересекающие противопожарную стену АР того же этажа, без клапана в радиусе damper_radius_mm. */
export function fireWallsWithoutDamper(stage: Stage, sheets: XSheet[], gates: XdiscGates): XResult {
  const out: XResult = { suspicions: [], skipped: [] };
  const ar = sheets.filter((s) => isAr(s) && s.walls.some((w) => w.fire));
  const ov = sheets.filter((s) => isOv(s) && s.routes.length);
  if (!ov.length) return out;
  if (!ar.length) {
    out.skipped.push({ op: "CMP-31", check: "fire_wall_no_damper", why: "в стадии нет планов АР с противопожарными стенами" });
    return out;
  }
  const bad = [...ar, ...ov].map((s) => unregistered(s, gates)).filter((w): w is string => w !== null);
  for (const w of bad) out.skipped.push({ op: "CMP-31", check: "fire_wall_no_damper", why: w });
  const ok = (s: XSheet) => unregistered(s, gates) === null;
  for (const o of ov.filter(ok)) {
    const mo = o.frame.to_bld!;
    const dampers = [...o.routes.flatMap((r) => r.nodes), ...o.symbols].filter((n) => DAMPER_KINDS.has(n.kind)).map((n) => toBld(mo, n.at));
    for (const a of ar.filter((s) => ok(s) && s.floor === o.floor)) {
      const ma = a.frame.to_bld!;
      for (const [wi, w] of a.walls.entries()) {
        if (!w.fire) continue;
        const wa = toBld(ma, w.a);
        const wb = toBld(ma, w.b);
        for (const r of o.routes) {
          for (let i = 1; i < r.points.length; i++) {
            const x = crossing(toBld(mo, r.points[i - 1]), toBld(mo, r.points[i]), wa, wb);
            if (!x) continue;
            if (dampers.some((d) => Math.hypot(d[0] - x[0], d[1] - x[1]) <= gates.damper_radius_mm + 1e-9)) continue;
            const key = `${r.system} × стена ${wi + 1} (${Math.round(x[0])}; ${Math.round(x[1])})`;
            out.suspicions.push(
              suspicion("CMP-31", "fire_wall_no_damper", stage, key, `Между разделами: трасса ${r.system} (${where(o)}) пересекает противопожарную стену (${where(a)}) в точке ${Math.round(x[0])}; ${Math.round(x[1])} мм осей, клапана ближе ${fmt(gates.damper_radius_mm)} мм нет`, [
                { document_code: o.document_code, page: o.page, bbox: r.bbox, value: `трасса ${r.system}` },
                { document_code: a.document_code, page: a.page, bbox: w.bbox, value: "противопожарная стена" },
              ]),
            );
          }
        }
      }
    }
  }
  return out;
}

/**
 * CMP-30 и CMP-31 по стадии. Вход проверяется схемой — битые данные извлечения громко отказывают, а не дают «нет
 * расхождений». Листы и таблицы берутся только той стадии, что указана во входе.
 */
export function xdisc(raw: unknown, gatesRaw: unknown): XResult {
  const input = XInputSchema.parse(raw);
  const gates = XdiscGatesSchema.parse(gatesRaw);
  const st = input.stage;
  const sheets = input.sheets.filter((s) => s.stage === st);
  const parts = [
    specVsCount(st, sheets, input.tables.spec, gates.tol),
    tepVsExplication(st, input.tables, gates.tol),
    scheduleVsGeometry(st, sheets, input.tables.schedule, gates.tol),
    ovRoomsMissingInAr(st, sheets),
    fireWallsWithoutDamper(st, sheets, gates),
  ];
  return { suspicions: parts.flatMap((p) => p.suspicions), skipped: parts.flatMap((p) => p.skipped) };
}
