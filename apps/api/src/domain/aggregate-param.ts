// Итоги таблиц и состав (T-175): CMP-10 AGG-SUM (итог = сумма строк, итоги стадий со спуском к строкам-корням, VER-12),
// CMP-08 (состав: какие типы есть) и CMP-11 (доли типов) — квартирография М-011, экспликации М-002/М-003, ведомости
// окон М-046, расхода материалов М-067, радиаторов М-077. Правила — OS-INSP-3.1.52…3.1.56. Чистые функции: таблицу
// стадии подаёт общий читатель таблиц (T-178), здесь только сверка. CMP-10 — общий оператор всех волн (W2 T-193, W3).
import { sourceRank } from "./class-param.ts";
import { stageRequired } from "./compare.ts";
import { fmtNum } from "./quantity-param.ts";
import type { ApprovalStatus, Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
const EPS = 1e-9;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const signed = (d: number) => (d > 0 ? `+${fmtNum(d)}` : d < 0 ? `−${fmtNum(-d)}` : "0");

export interface AggRow {
  label: string;
  num: number;
  page: number;
}

/** Таблица стадии: строки и объявленный итог («Итого», «Всего»); итога может не быть — тогда он производный от строк. */
export interface AggTable {
  stage: Stage;
  document_code: string;
  file_id: string;
  rows: AggRow[];
  total: { num: number; page: number } | null;
}

export interface AggSuspicion {
  stage: Stage;
  description: string;
  dedup_key: string;
}

// латинские двойники кириллицы в подписях строк (OCR и ручной ввод путают «K» и «К»)
const LATIN: Record<string, string> = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };

/** Ключ строки для сопоставления стадий: регистр, «ё», «№», пробелы и латинские двойники кириллицы не важны. */
export function rowKey(label: string): string {
  return label
    .normalize("NFC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/№/g, " ")
    .replace(/[a-z]/g, (ch) => LATIN[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim();
}

// неконечное число (NaN, ±Infinity) не значение: иначе |NaN − x| > допуска ложно и сравнение молча «сходится»
const finite = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
const clean = (rows: AggRow[]) => rows.filter((r) => finite(r.num));
const sum = (rows: AggRow[]) => clean(rows).reduce((s, r) => s + r.num, 0);

/** OS-INSP-3.1.52 (CMP-10, CMP-30): объявленный итог против суммы строк; null — сверять нечего или сходится. */
export function sumCheck(t: AggTable, tolerance: number): AggSuspicion | null {
  if (!t.total || !finite(t.total.num) || !clean(t.rows).length) return null;
  const s = sum(t.rows);
  const d = t.total.num - s;
  if (Math.abs(d) <= tolerance + EPS) return null;
  return {
    stage: t.stage,
    description: `Итог не сходится в ${STAGE_RU[t.stage]} (${t.document_code}, стр. ${t.total.page}): сумма строк ${fmtNum(s)}, итог ${fmtNum(t.total.num)} — разница ${signed(d)}`,
    dedup_key: `agg-sum:${t.stage}:${t.file_id}@${t.total.page}:${t.total.num}`,
  };
}

export interface AggRoot {
  kind: "changed" | "added" | "removed";
  label: string;
  from: number | null;
  to: number | null;
  delta: number;
}

export interface TotalsResult {
  status: "NEGATIVE_VERIFIED" | "CANDIDATE" | "MISSING_EVIDENCE";
  expected: number | null;
  actual: number | null;
  /** VER-12: итог производен от строк — при расхождении корень ищется в строках; null — строк нет, спуск невозможен. */
  derived_from: "rows" | null;
  roots: AggRoot[];
  reason: string;
}

/** Строки, сложенные по ключу, в порядке первого появления: одинаковые подписи складываются, а не теряются. */
function byKey(rows: AggRow[]): Map<string, { label: string; num: number; page: number }> {
  const m = new Map<string, { label: string; num: number; page: number }>();
  for (const r of clean(rows)) {
    const k = rowKey(r.label);
    const prev = m.get(k);
    m.set(k, prev ? { ...prev, num: prev.num + r.num } : { label: r.label, num: r.num, page: r.page });
  }
  return m;
}

/** Строки-корни расхождения итогов (VER-12): изменённые, удалённые, добавленные — точное сравнение значений строк. */
export function rootsOf(a: AggRow[], b: AggRow[]): Array<AggRoot & { page: number | null }> {
  const ka = byKey(a);
  const kb = byKey(b);
  const out: Array<AggRoot & { page: number | null }> = [];
  for (const [k, x] of ka) {
    const y = kb.get(k);
    if (!y) out.push({ kind: "removed", label: x.label, from: r6(x.num), to: null, delta: r6(-x.num), page: null });
    else if (Math.abs(y.num - x.num) > EPS) out.push({ kind: "changed", label: x.label, from: r6(x.num), to: r6(y.num), delta: r6(y.num - x.num), page: y.page });
  }
  for (const [k, y] of kb) if (!ka.has(k)) out.push({ kind: "added", label: y.label, from: null, to: r6(y.num), delta: r6(y.num), page: y.page });
  return out;
}

const rootText = (r: AggRoot & { page: number | null }) =>
  r.kind === "changed" ? `«${r.label}» ${fmtNum(r.from!)} → ${fmtNum(r.to!)} (стр. ${r.page})` : r.kind === "removed" ? `«${r.label}» удалена (было ${fmtNum(r.from!)})` : `«${r.label}» добавлена (${fmtNum(r.to!)}, стр. ${r.page})`;

/**
 * OS-INSP-3.1.53, 3.1.54 (CMP-10, VER-12): итоги двух стадий. Итог — объявленный, иначе сумма строк. Расхождение больше
 * допуска — кандидат с корнями в строках; строк в одной из стадий нет — сравнивается только итог, спуск невозможен.
 */
export function compareTotals(a: AggTable, b: AggTable, p: { unit: string; tolerance: number }): TotalsResult {
  const valueOf = (t: AggTable) => (t.total ? (finite(t.total.num) ? t.total.num : null) : clean(t.rows).length ? sum(t.rows) : null);
  const exp = valueOf(a);
  const act = valueOf(b);
  if (exp === null || act === null) {
    const miss = [a, b].filter((t) => valueOf(t) === null).map((t) => STAGE_RU[t.stage]);
    return { status: "MISSING_EVIDENCE", expected: exp, actual: act, derived_from: null, roots: [], reason: `Сравнить не с чем: в ${miss.join(" и ")} нет ни итога, ни строк таблицы` };
  }
  const both = clean(a.rows).length > 0 && clean(b.rows).length > 0;
  const roots = both ? rootsOf(a.rows, b.rows) : [];
  const d = act - exp;
  const status = Math.abs(d) > p.tolerance + EPS ? "CANDIDATE" : "NEGATIVE_VERIFIED";
  const head = `Итог ${STAGE_RU[b.stage]} ${d > 0 ? "больше" : d < 0 ? "меньше" : "равен"} ${STAGE_RU[a.stage]}${d ? ` на ${fmtNum(Math.abs(d))} ${p.unit}` : ""} (${fmtNum(exp)} → ${fmtNum(act)}), допуск ±${fmtNum(p.tolerance)} ${p.unit}`;
  const noRows = [a, b].filter((t) => !clean(t.rows).length).map((t) => STAGE_RU[t.stage]);
  const tail = both ? (roots.length ? `. Корни расхождения: ${roots.map(rootText).join("; ")}` : "") : `; строк таблицы в ${noRows.join(" и ")} нет — спуск к строкам невозможен`;
  return {
    status,
    expected: r6(exp),
    actual: r6(act),
    derived_from: both ? "rows" : null,
    roots: roots.map(({ page: _page, ...r }) => r),
    reason: head + tail,
  };
}

export interface CompositionResult {
  status: "NEGATIVE_VERIFIED" | "CANDIDATE" | "MISSING_EVIDENCE";
  added: string[];
  removed: string[];
  shifts: Array<{ type: string; from_pct: number; to_pct: number; delta_pp: number }>;
  shares: Record<string, { from_pct: number; to_pct: number }>;
  reason: string;
}

/**
 * OS-INSP-3.1.55 (CMP-08) и 3.1.56 (CMP-11): состав по типам (например, квартиры по комнатности). Появившийся или
 * исчезнувший тип — кандидат; доля типа сдвинулась больше допуска в процентных пунктах — кандидат с долями стадий.
 */
export function compareComposition(ra: Record<string, number>, rb: Record<string, number>, tolerancePp: number): CompositionResult {
  // только собственные ключи и конечные неотрицательные количества: «constructor» или «__proto__» — обычный тип, а не
  // свойство из прототипа, NaN и минус — не количество
  const own = (o: Record<string, number>) => new Map(Object.keys(o).filter((k) => Object.hasOwn(o, k) && finite(o[k]) && o[k] >= 0).map((k) => [k, o[k]]));
  const a = own(ra);
  const b = own(rb);
  const ta = [...a.values()].reduce((s, x) => s + x, 0);
  const tb = [...b.values()].reduce((s, x) => s + x, 0);
  const types = [...new Set([...a.keys(), ...b.keys()])];
  const shares: CompositionResult["shares"] = Object.create(null);
  for (const t of types) shares[t] = { from_pct: ta ? r6((100 * (a.get(t) ?? 0)) / ta) : 0, to_pct: tb ? r6((100 * (b.get(t) ?? 0)) / tb) : 0 };
  if (!ta || !tb) return { status: "MISSING_EVIDENCE", added: [], removed: [], shifts: [], shares, reason: "Сравнить не с чем: состав одной из стадий пуст" };
  const added = types.filter((t) => !a.has(t) && (b.get(t) ?? 0) > 0);
  const removed = types.filter((t) => (a.get(t) ?? 0) > 0 && !b.has(t));
  const shifts = types
    .map((t) => ({ type: t, from_pct: shares[t].from_pct, to_pct: shares[t].to_pct, delta_pp: r6(shares[t].to_pct - shares[t].from_pct) }))
    .filter((s) => Math.abs(s.delta_pp) > tolerancePp + EPS);
  const parts: string[] = [];
  if (added.length || removed.length) parts.push(`Состав изменился — появились: ${added.join(", ") || "—"}; исчезли: ${removed.join(", ") || "—"}`);
  if (shifts.length) parts.push(`Доли изменились больше допуска ±${fmtNum(tolerancePp)} п.п.: ${shifts.map((s) => `${s.type}: ${fmtNum(s.from_pct)} % → ${fmtNum(s.to_pct)} % (${signed(s.delta_pp)} п.п.)`).join("; ")}`);
  return {
    status: parts.length ? "CANDIDATE" : "NEGATIVE_VERIFIED",
    added,
    removed,
    shifts,
    shares,
    reason: parts.length ? parts.join(". ") : `Состав и доли совпали в пределах ±${fmtNum(tolerancePp)} п.п.`,
  };
}

// ─────────────────────────────── состав стадии из упоминаний (М-011, OS-INSP-3.1.57)

/** Упоминание типа в составе: тип (ключ паспорта) и количество, как их отдал ML composition_mentions. */
export interface CompositionMention {
  stage: Stage;
  type: string;
  /** Подтип внутри типа паспорта («4», «5» в «4к+»): разные подтипы складываются, повтор одного — нет. */
  sub?: string;
  num: number;
  file_id: string;
  sha256: string;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  role: RevisionRole;
  discipline: string | null;
  page: number;
  bbox: [number, number, number, number] | null;
  quote: string;
  confidence: number;
  excluded: string | null;
  excluded_why: string | null;
}

export interface CompositionPassport {
  tolerance_pp: number;
  /** Типы, которые не приравниваются к другим до решения владельца (T-175: «2Е» евро — ключ E2): есть в одной стадии
   * и нет в другой — NOT_COMPARABLE, а не «появился тип». */
  separate?: string[];
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
}

/** Конфигурация из паспорта вида composition. null — паспорт другого вида. */
export function compositionPassport(pp: { value: { kind: string; tolerance_pp?: number }; sources: unknown }): CompositionPassport | null {
  if (pp.value.kind !== "composition") return null;
  const v = pp.value as { tolerance_pp?: number; separate_types?: string[] };
  return { tolerance_pp: v.tolerance_pp ?? 0, separate: v.separate_types ?? [], sources: pp.sources as CompositionPassport["sources"] };
}

const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };

/**
 * Состав стадии (OS-INSP-3.1.57): из одного документа — самого приоритетного раздела паспорта (VER-15), затем актуальной
 * редакции и уверенности; у типа — первое неотсеянное упоминание по страницам. Документы стадии не смешиваются.
 */
export function stageComposition(ms: CompositionMention[], stage: Stage, p: CompositionPassport): CompositionMention[] {
  const usable = ms.filter((m) => m.stage === stage && m.excluded === null && m.role !== "SUPERSEDED" && finite(m.num) && m.num >= 0);
  if (!usable.length) return [];
  const rank = (m: CompositionMention) => [sourceRank(p, stage, m.discipline), ROLE_ORDER[m.role], -m.confidence, m.file_id] as const;
  const best = [...usable].sort((a, b) => {
    const ka = rank(a);
    const kb = rank(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  })[0].file_id;
  // у подтипа (четырёх- и пятикомнатные внутри «4к+») — первое упоминание; разные подтипы типа складываются
  const seen = new Set<string>();
  const firsts = usable
    .filter((m) => m.file_id === best)
    .sort((a, b) => a.page - b.page)
    .filter((m) => {
      const k = `${m.type}\u0000${m.sub ?? ""}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  const byType = new Map<string, CompositionMention>();
  for (const m of firsts) {
    const prev = byType.get(m.type);
    byType.set(m.type, prev ? { ...prev, num: prev.num + m.num } : m);
  }
  return [...byType.values()];
}

const asMap = (ms: CompositionMention[]) => Object.fromEntries(ms.map((m) => [m.type, m.num])) as Record<string, number>;
const listOf = (ms: CompositionMention[]) => ms.map((m) => `${m.type} — ${fmtNum(m.num)}`).join(", ");

function cfrag(m: CompositionMention, kind: Fragment["kind"]): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value: `${m.type}: ${fmtNum(m.num)}`, kind };
}

/** М-011 (CMP-08, CMP-11): состав ранней стадии — эталон; поздняя стадия с изменённым составом или долями — кандидат. */
export function evaluateCompositionParam({ param, passport, mentions, loadedStages }: { param: Param; passport: CompositionPassport; mentions: CompositionMention[]; loadedStages: Stage[] }): Evaluation {
  const notes: Evaluation["stage_notes"] = {};
  const comp = {} as Record<Stage, CompositionMention[]>;
  for (const s of STAGES) {
    comp[s] = stageComposition(mentions, s, passport);
    notes[s] = !loadedStages.includes(s) || !stageRequired(param, s) ? "NOT_APPLICABLE" : comp[s].length ? "USED" : "NO_VALUE";
  }
  const used = STAGES.filter((s) => notes[s] === "USED");
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes };
  if (used.length < 2) {
    const found = used.length ? `${STAGE_RU[used[0]]} — ${listOf(comp[used[0]])}` : "состав не найден ни в одной стадии";
    return { ...base, status: "MISSING_EVIDENCE", expected: used.length ? listOf(comp[used[0]]) : null, reason: `Сравнить не с чем: ${found}`, fragments: used.length ? comp[used[0]].map((m) => cfrag(m, "expected")) : [] };
  }
  const [e, ...later] = used;
  const has = (s: Stage, k: string) => comp[s].some((m) => m.type === k);
  for (const s of later) {
    const odd = (passport.separate ?? []).filter((k) => has(e, k) !== has(s, k));
    if (odd.length) {
      const fr = [...comp[e].map((m) => cfrag(m, "expected")), ...comp[s].map((m) => cfrag(m, "actual"))];
      return { ...base, status: "NOT_COMPARABLE", expected: listOf(comp[e]), actual: listOf(comp[s]), fragments: fr, reason: `Тип ${odd.join(", ")} есть только в одной стадии (${STAGE_RU[has(e, odd[0]) ? e : s]}); к другим типам он не приравнивается до решения владельца — сравните вручную` };
    }
  }
  let pick = later[later.length - 1];
  let res = compareComposition(asMap(comp[e]), asMap(comp[pick]), passport.tolerance_pp);
  for (const s of later) {
    const r = compareComposition(asMap(comp[e]), asMap(comp[s]), passport.tolerance_pp);
    if (r.status === "CANDIDATE") {
      pick = s;
      res = r;
      break;
    }
  }
  const fragments = [...comp[e].map((m) => cfrag(m, "expected")), ...comp[pick].map((m) => cfrag(m, "actual"))];
  const out = { ...base, expected: listOf(comp[e]), actual: listOf(comp[pick]), fragments };
  if (res.status === "CANDIDATE") return { ...out, status: "CANDIDATE", reason: `${STAGE_RU[pick]} против ${STAGE_RU[e]}: ${res.reason}. Правило Матрицы: ${param.trigger_logic}` };
  return { ...out, status: "NEGATIVE_VERIFIED", reason: `${param.parameter_name}: ${res.reason}` };
}
