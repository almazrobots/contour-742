// L6 и L8 каталога TO-BE после оператора сравнения — общий понижающий слой (ADR-0008 п. 2, T-177).
// Ворота GTE-04 (сопоставимость), GTE-05 (качество извлечения), проверки VER-01, 02, 03, 05, 07, 08, 11 и пост-оператор
// CMP-29 (легитимность изменения). VER-12 (корень и каскады) — между параметрами: `cascadeRoots`.
// Слой не знает об операторе, оператор — о слое. Слой только понижает: CANDIDATE → NEGATIVE_VERIFIED или воздержание,
// NEGATIVE_VERIFIED → воздержание; CANDIDATE он не порождает никогда (каталог §12). Правила — OS-INSP-3.1.70–3.1.89.
import { z } from "zod";
import { changesFor, type ApprovedChange } from "./changes.ts";
import type { ApprovalStatus, Evaluation, FindingStatus, Fragment, Param, RevisionRole, Stage } from "./types.ts";

export type BBox = [number, number, number, number];
export type PageQuality = "OK" | "LOW_QUALITY" | "ABSTAIN";

/** Что известно о фрагменте кроме самого значения: уверенность извлечения, качество страницы, вид документа, единица. */
export interface FragmentFacts {
  confidence: number | null;
  quality: PageQuality | null;
  doc_kind: string | null; // вид документа внутри марки (OS-INSP-2.2.7): drawing, specification, calculation …
  unit: string | null; // единица, записанная рядом со значением («мм», «м²»); null — не записана
}

/** Отметка изменения на листе (IDN-03 — строка таблицы изменений штампа, IDN-04 — облако или выноска «Изм. N»). */
export interface ChangeMark {
  file_id: string;
  page: number;
  kind: "cloud" | "callout" | "stamp_row";
  number: string | null;
  bbox: BBox | null;
  text: string;
}

/** Редакция документа пакета (реестр + максимальный номер изменения в штампе, если он прочитан). */
export interface RevisionInfo {
  file_id: string;
  stage: Stage;
  document_code: string;
  revision: string;
  role: RevisionRole;
  approval_status: ApprovalStatus | null;
  stamp_change: number | null;
}

/** Просмотренный документ стадии — доказательство отсутствия (VER-05). */
export interface SearchedSheet {
  file_id: string;
  stage: Stage;
  document_code: string;
  pages: number | null;
  parsed: boolean;
  low_quality_pages: number[];
}

/** Настройки ворот — данные `data/seed/l8-gates.json`, а не код. */
export interface GateConfig {
  min_confidence: Record<string, number>; // параметр (M-…) или оператор (CMP-…) → порог уверенности; "default" — прочие
  methods: Record<string, Partial<Record<Stage, string>>>; // параметр → методика значения по стадиям
  equivalent_methods: string[][]; // группы методик, дающих сопоставимое значение
  sheet_kinds: Record<string, string[]>; // оператор → допустимые виды документа
}

export interface L8Context {
  param_code: string;
  op: string; // оператор L7, давший результат (CMP-01, CMP-04 …)
  threshold_rule: boolean; // сравнение с нормой (min/max): ожидаемое — сама норма, а не фрагмент
  units_normalized: boolean; // оператор сам привёл единицы (паспортный путь) — GTE-04 единицы не сверяет
  gates: GateConfig;
  facts: (f: Fragment) => FragmentFacts;
  revisions: RevisionInfo[];
  changes: ApprovedChange[];
  marks: ChangeMark[];
  searched: SearchedSheet[];
}

export type ChangeLegit = "APPROVED_CHANGE" | "CHANGE_APPROVAL_UNVERIFIED" | "CHANGE_CONFLICT" | "NONE";

export interface L8Step {
  op: string;
  from: FindingStatus;
  to: FindingStatus;
  reason_code: string | null;
  why: string;
}

export interface L8Atom {
  stage: Stage;
  expected: string | null;
  actual: string;
  fragment: number; // индекс фрагмента фактического значения в ev.fragments
}

export interface L8Trace {
  ops: string[]; // выполненные проверки по порядку
  steps: L8Step[]; // сработавшие: понижение или пометка
  reason_code: string | null; // причина последнего понижения (EXTRACTION_QUALITY, WRONG_REVISION, DETAIL_REFINEMENT …)
  change: ChangeLegit | null; // CMP-29; null — не применялся (результат не кандидат)
  approved_change_ref: string | null; // ссылка на изменение; "NONE" — изменение искали и не нашли
  flags: string[]; // CHANGE_APPROVAL_UNVERIFIED, STALE_REVISION, COMPOSITE
  searched: SearchedSheet[] | null; // VER-05: что просмотрено
  atoms: L8Atom[]; // VER-11: атомарные факты кандидата
}

export type L8Evaluation<E extends Evaluation = Evaluation> = E & { l8: L8Trace; absence?: boolean };

export const L8_OPS = ["GTE-04", "GTE-05", "VER-01", "VER-03", "VER-02", "VER-05", "VER-07", "CMP-29", "VER-08", "VER-11"] as const;

/** Куда слой вправе перевести статус. Всё, чего здесь нет, — повышение или подмена, и слой его не делает. */
export const LOWER_TO: Record<FindingStatus, readonly FindingStatus[]> = {
  CANDIDATE: ["NEGATIVE_VERIFIED", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "MISSING_EVIDENCE"],
  NEGATIVE_VERIFIED: ["NOT_COMPARABLE", "CLARIFICATION_REQUIRED"],
  MISSING_EVIDENCE: [],
  NOT_APPLICABLE: [],
  NOT_COMPARABLE: [],
  CLARIFICATION_REQUIRED: [],
};

export function canLower(from: FindingStatus, to: FindingStatus): boolean {
  return LOWER_TO[from].includes(to);
}

const STALE_APPROVAL: ReadonlySet<ApprovalStatus> = new Set(["SUPERSEDED", "CANCELLED"]);
const DISPUTED: ReadonlySet<RevisionRole> = new Set(["CONFLICT", "UNRESOLVED"]);
/** Отметка изменения «рядом» с фрагментом: зазор между рамками не больше 5 % листа (IDN-04). */
export const NEAR = 0.05;

const expectedOf = (ev: Evaluation) => ev.fragments.filter((f) => f.kind === "expected");
const actualOf = (ev: Evaluation) => ev.fragments.filter((f) => f.kind === "actual");

/** Фактические фрагменты, давшие расхождение: значение совпадает с actual результата; нет таких — все фактические. */
export function violating(ev: Evaluation): Fragment[] {
  const act = actualOf(ev);
  const hit = act.filter((f) => ev.actual !== null && f.value === ev.actual);
  return hit.length ? hit : act;
}

/** Зазор между рамками в долях листа; 0 — пересекаются или одна внутри другой. */
export function gap(a: BBox, b: BBox): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/** Номер изменения — цифры из «Изм. №3», «3», «изм.3» → «3». Без цифр — null. */
export function changeNo(s: string | null | undefined): string | null {
  const m = (s ?? "").match(/\d+/);
  return m ? String(Number(m[0])) : null;
}

/** Номер редакции числом: «2», «ред. 2», «изм.2» → 2; буквенная или пустая — null. */
export function revNo(s: string | null | undefined): number | null {
  const m = (s ?? "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

// латинские буквы-двойники → кириллица: «B25» и «В25» — одно значение (NRM-03)
const TWINS: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
export function fold(s: string): string {
  return s.toUpperCase().replace(/[ABCEHKMOPTXY]/g, (c) => TWINS[c]).replace(/\s+/g, " ").trim();
}

const NUM_ONLY = /^[-+]?\d+(?:[.,]\d+)?$/;
const num = (s: string) => Number(s.replace(",", "."));
const RANGE = /^(\d+(?:[.,]\d+)?)\s*(?:\.\.\.|…|–|—|-)\s*(\d+(?:[.,]\d+)?)/;
const AT_LEAST = /^НЕ\s+(?:МЕНЕЕ|НИЖЕ)\s+(\d+(?:[.,]\d+)?)/;
const AT_MOST = /^НЕ\s+(?:БОЛЕЕ|ВЫШЕ)\s+(\d+(?:[.,]\d+)?)/;
const LEAD_NUM = /^(\d+(?:[.,]\d+)?)/;

/**
 * VER-07: различие — законная детализация РД, а не изменение. Два признака:
 * 1) ПД задаёт диапазон или ограничение («200…250», «не менее 150»), а число РД в нём;
 * 2) значение РД = значение ПД + уточнение («В25» → «В25 W6 F150», «ВВГнг(А)-LS» → «ВВГнг(А)-LS 5х10»), причём уточнение не
 *    содержит другого значения той же шкалы («С1» → «С1, С2» — не детализация, а второй класс).
 */
export function isRefinement(expected: string | null, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const e = fold(expected);
  const a = fold(actual);
  if (NUM_ONLY.test(e) && NUM_ONLY.test(a)) return false; // два числа — дело оператора, не детализации
  const an = a.match(LEAD_NUM);
  if (an) {
    const v = num(an[1]);
    const r = e.match(RANGE);
    if (r) return v >= Math.min(num(r[1]), num(r[2])) && v <= Math.max(num(r[1]), num(r[2]));
    const lo = e.match(AT_LEAST);
    if (lo) return v >= num(lo[1]);
    const hi = e.match(AT_MOST);
    if (hi) return v <= num(hi[1]);
  }
  if (e.length < 2 || !a.startsWith(e) || a.length === e.length) return false;
  const rest = a.slice(e.length);
  if (!/^[\s,;:(/\-–—ХX×]/.test(rest)) return false; // «В2» → «В25» — другое значение, а не уточнение
  const lead = e.match(/^[^\d\s]*/)![0];
  const tokens = rest.split(/[\s,;:()/]+/).filter(Boolean);
  const sameScale = new RegExp(`^${lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d`);
  return !tokens.some((t) => sameScale.test(t));
}

function methodOf(ctx: L8Context, f: Fragment): string | null {
  return ctx.gates.methods[ctx.param_code]?.[f.stage] ?? null;
}

function sameMethod(ctx: L8Context, a: string | null, b: string | null): boolean {
  if (a === null || b === null || a === b) return true;
  return ctx.gates.equivalent_methods.some((g) => g.includes(a) && g.includes(b));
}

/** GTE-04 для пары «ожидаемое — фактическое»: причина несопоставимости или null. */
export function incomparable(ctx: L8Context, e: Fragment | null, a: Fragment): string | null {
  const kinds = ctx.gates.sheet_kinds[ctx.op];
  if (kinds) {
    for (const f of e ? [e, a] : [a]) {
      const k = ctx.facts(f).doc_kind;
      if (k !== null && !kinds.includes(k)) return `вид документа «${k}» не годится для ${ctx.op} (${f.document_code}, стр. ${f.page})`;
    }
  }
  if (!e) return null;
  const me = methodOf(ctx, e);
  const ma = methodOf(ctx, a);
  if (!sameMethod(ctx, me, ma)) return `значения получены по разным методикам: ${e.stage} — ${me}, ${a.stage} — ${ma}`;
  if (!ctx.units_normalized) {
    const ue = ctx.facts(e).unit;
    const ua = ctx.facts(a).unit;
    if (ue !== null && ua !== null && ue !== ua) return `единицы не приведены: ${e.stage} — ${ue}, ${a.stage} — ${ua}`;
  }
  return null;
}

/** GTE-05: фрагмент извлечён ненадёжно — страница LOW_QUALITY/ABSTAIN или уверенность ниже порога оператора. */
export function lowQuality(ctx: L8Context, f: Fragment): string | null {
  const x = ctx.facts(f);
  if (x.quality === "LOW_QUALITY" || x.quality === "ABSTAIN") return `страница ${f.page} ${f.document_code} — ${x.quality}`;
  // порог — данные: параметра (паспорт W1), иначе оператора, иначе общий; не константа под один движок OCR
  const thr = ctx.gates.min_confidence[ctx.param_code] ?? ctx.gates.min_confidence[ctx.op] ?? ctx.gates.min_confidence.default ?? 0;
  if (x.confidence !== null && x.confidence < thr) return `уверенность извлечения ${x.confidence} ниже порога ${thr} (${f.document_code}, стр. ${f.page})`;
  return null;
}

/** VER-03: фрагмент из устаревшей редакции — SUPERSEDED/CANCELLED или в пакете есть более поздняя редакция документа. */
export function staleOf(ctx: L8Context, f: Fragment): string | null {
  if (f.role === "SUPERSEDED" || (f.approval_status !== null && STALE_APPROVAL.has(f.approval_status))) return `${f.document_code} ред. ${f.revision} — ${f.approval_status ?? f.role}`;
  const own = ctx.revisions.find((r) => r.file_id === f.file_id);
  const rf = revNo(f.revision);
  for (const s of ctx.revisions) {
    if (s.file_id === f.file_id || s.stage !== f.stage || s.document_code !== f.document_code) continue;
    const rs = revNo(s.revision);
    // оба номера редакций числовые — решает номер; штамп сравнивается, только когда номера сравнить нельзя
    const numeric = rf !== null && rs !== null;
    const newerRev = numeric && rs > rf;
    const newerStamp = !numeric && own?.stamp_change != null && s.stamp_change !== null && s.stamp_change > own.stamp_change;
    if (newerRev || newerStamp) return `${f.document_code}: взята ред. ${f.revision}, в пакете есть более поздняя ред. ${s.revision}${newerStamp ? ` (изм. ${s.stamp_change} в штампе)` : ""}`;
  }
  return null;
}

/** Отметки изменения у фрагмента: облако или выноска рядом с рамкой, строка таблицы изменений штампа того же листа.
 * Запас 1e-9: 0,55 − 0,5 в двоичной арифметике чуть больше 0,05. */
export function marksNear(ctx: L8Context, f: Fragment): ChangeMark[] {
  return ctx.marks.filter((m) => m.file_id === f.file_id && m.page === f.page && (m.kind === "stamp_row" || (m.bbox !== null && f.bbox !== null && gap(m.bbox, f.bbox) <= NEAR + 1e-9)));
}

const fmtDate = (d: string) => d.split("-").reverse().join(".");
const markRef = (m: ChangeMark) => `${m.kind === "cloud" ? "облако" : m.kind === "callout" ? "выноска" : "таблица изменений штампа"}${m.number ? ` изм. ${m.number}` : ""} (стр. ${m.page})`;

/**
 * CMP-29: легитимность расхождения кандидата.
 * APPROVED_CHANGE — у фактического фрагмента облако или выноска с номером N, и по параметру зарегистрировано изменение
 * № N с документом-основанием (основание — не сам проверяемый файл). Строка штампа, облако без номера, регистрация без
 * основания — CHANGE_APPROVAL_UNVERIFIED: изменение есть, утверждение системой не подтверждено, решает инспектор.
 * CHANGE_CONFLICT — номер на листе не совпал ни с одним зарегистрированным. Штамп новее редакции реестра — флаг
 * STAMP_REVISION_MISMATCH без понижения: одна надпись в недоверенном PDF не выводит кандидата из счёта (OWASP T-177).
 */
export function changeLegit(ctx: L8Context, ev: Evaluation): { result: ChangeLegit; ref: string; why: string; flag: string | null } {
  const reg = changesFor(ctx.param_code, ctx.changes);
  const act = violating(ev);
  const marks = [...new Set(act.flatMap((f) => marksNear(ctx, f)))];
  const onSheet = marks.filter((m) => m.kind !== "stamp_row");
  const nums = new Set(onSheet.map((m) => changeNo(m.number)).filter((n): n is string => n !== null));
  const regNums = new Set(reg.map((c) => changeNo(c.number)).filter((n): n is string => n !== null));
  if (reg.length && nums.size && ![...nums].some((n) => regNums.has(n))) {
    return { result: "CHANGE_CONFLICT", ref: [...onSheet.map(markRef), ...reg.map((c) => `№ ${c.number}`)].join("; "), why: `на листе отмечено изм. ${[...nums].join(", ")}, а зарегистрировано № ${reg.map((c) => c.number).join(", ")}`, flag: null };
  }
  let flag: string | null = null;
  let stampWhy = "";
  if (marks.length) {
    for (const f of act) {
      const own = ctx.revisions.find((r) => r.file_id === f.file_id);
      const r = revNo(f.revision);
      if (own?.stamp_change != null && r !== null && own.stamp_change > r) {
        flag = "STAMP_REVISION_MISMATCH";
        stampWhy = `; в штампе ${f.document_code} изм. ${own.stamp_change}, а в реестре ред. ${f.revision}`;
      }
    }
  }
  const own = new Set(act.map((f) => f.file_id));
  const approved = reg.find((c) => c.basis_file_id && !own.has(c.basis_file_id) && nums.has(changeNo(c.number) ?? ""));
  if (approved && !flag) {
    return { result: "APPROVED_CHANGE", ref: `№ ${approved.number} от ${fmtDate(approved.date)}, основание — ${approved.basis_file_name ?? approved.basis_file_id}`, why: `изменение № ${approved.number} отмечено на листе и согласовано документом-основанием`, flag: null };
  }
  if (reg.length || marks.length) {
    const refs = [...reg.map((c) => `№ ${c.number} от ${fmtDate(c.date)}${c.basis_file_id ? "" : " (без документа-основания)"}`), ...marks.map(markRef)];
    return { result: "CHANGE_APPROVAL_UNVERIFIED", ref: refs.join("; "), why: `изменение найдено (${refs.join("; ")}), утверждение не подтверждено документом${stampWhy}`, flag };
  }
  return { result: "NONE", ref: "NONE", why: "согласованное изменение не найдено", flag: null };
}

/** VER-11: атомарные факты кандидата — по фактическому фрагменту каждой стадии, где значение расходится с эталоном. */
export function atomsOf(ev: Evaluation, threshold: boolean): L8Atom[] {
  const out: L8Atom[] = [];
  const seen = new Set<Stage>();
  ev.fragments.forEach((f, i) => {
    if (f.kind !== "actual" || seen.has(f.stage)) return;
    if (!threshold && ev.expected !== null && f.value === ev.expected) return;
    seen.add(f.stage);
    out.push({ stage: f.stage, expected: ev.expected, actual: f.value, fragment: i });
  });
  return out;
}

const isEmpty = (v: string) => !v.trim() || v.trim() === "—" || /^отсутств/i.test(v.trim());

/**
 * Понижающий слой: результат оператора → тот же результат, возможно пониженный, со следом каждой проверки.
 * Порядок: ворота (GTE-04, GTE-05), редакции (VER-01, VER-03), двусторонность (VER-02), покрытие (VER-05),
 * детализация (VER-07), легитимность (CMP-29 → VER-08), атомизация (VER-11). Первое понижение не останавливает
 * следующие проверки, но каждая смотрит на текущий статус: воздержание дальше не понижается.
 */
export function verifyL8<E extends Evaluation>(input: E, ctx: L8Context): L8Evaluation<E> {
  if (input.expected_basis?.kind === "norm" && input.expected_basis.reference.trim()) {
    ctx = { ...ctx, threshold_rule: true };
  }
  const ev = { ...input } as L8Evaluation<E>;
  const absence = (input as { absence?: boolean }).absence === true || actualOf(input).some((f) => isEmpty(f.value));
  const trace: L8Trace = { ops: [], steps: [], reason_code: null, change: null, approved_change_ref: null, flags: [], searched: null, atoms: [] };
  const origin = input.reason;
  const lower = (op: string, to: FindingStatus, why: string, code: string | null) => {
    if (!canLower(ev.status, to)) return;
    trace.steps.push({ op, from: ev.status, to, reason_code: code, why });
    trace.reason_code = code;
    ev.status = to;
    ev.reason = `${why} (${op}). Оператор: ${origin}`;
  };
  const cand = () => ev.status === "CANDIDATE";
  const compared = () => ev.status === "CANDIDATE" || ev.status === "NEGATIVE_VERIFIED";

  // GTE-04 сопоставимость
  trace.ops.push("GTE-04");
  if (compared()) {
    const exp = ctx.threshold_rule ? [null] : expectedOf(ev).length ? expectedOf(ev) : [null];
    const act = cand() ? violating(ev) : actualOf(ev);
    const why = exp.flatMap((e) => act.map((a) => incomparable(ctx, e, a)));
    const bad = why.filter((w): w is string => w !== null);
    // кандидату хватает одной несопоставимой пары; отрицательному результату — только если несопоставимо всё
    if (bad.length && (cand() || bad.length === why.length)) lower("GTE-04", "NOT_COMPARABLE", `Несопоставимо: ${bad[0]}`, "NOT_COMPARABLE");
  }
  // GTE-05 качество извлечения
  trace.ops.push("GTE-05");
  if (compared()) {
    const exp = ctx.threshold_rule ? [] : expectedOf(ev);
    const act = cand() ? violating(ev) : actualOf(ev);
    const qe = exp.map((f) => lowQuality(ctx, f));
    const qa = act.map((f) => lowQuality(ctx, f));
    const all = (xs: Array<string | null>) => xs.length > 0 && xs.every((x) => x !== null);
    const hit = [...qe, ...qa].find((x): x is string => x !== null);
    if (hit && (cand() || all(qe) || all(qa))) lower("GTE-05", "NOT_COMPARABLE", `Качество извлечения ниже порога: ${hit}`, "EXTRACTION_QUALITY");
  }
  // VER-01 повтор ворот по фрагментам кандидата: спорная редакция или фрагменты разных редакций одного документа
  trace.ops.push("VER-01");
  if (compared()) {
    const disputed = ev.fragments.find((f) => DISPUTED.has(f.role));
    const revs = new Map<string, Set<string>>();
    for (const f of ev.fragments) revs.set(`${f.stage}|${f.document_code}`, (revs.get(`${f.stage}|${f.document_code}`) ?? new Set()).add(f.revision));
    const mixed = [...revs.entries()].find(([, s]) => s.size > 1);
    if (disputed) lower("VER-01", "CLARIFICATION_REQUIRED", `Не определена актуальная редакция источника: ${disputed.document_code} ред. ${disputed.revision}`, "WRONG_REVISION");
    else if (mixed) lower("VER-01", "CLARIFICATION_REQUIRED", `Результат собран из разных редакций ${mixed[0].split("|")[1]}: ${[...mixed[1]].join(", ")}`, "WRONG_REVISION");
  }
  // VER-03 устаревшая редакция — отдельный учёт для FPR ТЗ
  trace.ops.push("VER-03");
  if (compared()) {
    const stale = ev.fragments.map((f) => staleOf(ctx, f)).find((x): x is string => x !== null);
    if (stale) {
      trace.flags.push("STALE_REVISION");
      lower("VER-03", "CLARIFICATION_REQUIRED", `Источник — устаревшая редакция: ${stale}`, "WRONG_REVISION");
    }
  }
  // VER-02 двусторонность доказательства
  trace.ops.push("VER-02");
  if (cand()) {
    const act = actualOf(ev);
    if (!act.length) lower("VER-02", "NOT_COMPARABLE", "У кандидата нет фрагмента фактического значения", "NOT_COMPARABLE");
    else if (!ctx.threshold_rule && !expectedOf(ev).length) lower("VER-02", "NOT_COMPARABLE", "У кандидата нет фрагмента ожидаемого значения", "NOT_COMPARABLE");
    else if (act.some((f) => isEmpty(f.value) && f.bbox === null)) lower("VER-02", "NOT_COMPARABLE", "Отсутствие не показано зоной на листе: у фактического фрагмента нет рамки", "NOT_COMPARABLE");
  }
  // VER-05 доказательство отсутствия: что просмотрено — в карточку; покрытие неполное — воздержание
  trace.ops.push("VER-05");
  if ((cand() && absence) || ev.status === "MISSING_EVIDENCE") {
    // кандидат-отсутствие — стадии фактических фрагментов; нет значения — стадии без значения (NO_VALUE), иначе все
    const noValue = (Object.keys(ev.stage_notes) as Stage[]).filter((s) => ev.stage_notes[s] === "NO_VALUE");
    const stages = cand() ? new Set(actualOf(ev).map((f) => f.stage)) : noValue.length ? new Set(noValue) : null;
    const sheets = ctx.searched.filter((s) => !stages || stages.has(s.stage));
    trace.searched = sheets;
    if (cand()) {
      const holes = sheets.filter((s) => !s.parsed || s.low_quality_pages.length > 0);
      if (!sheets.length) lower("VER-05", "MISSING_EVIDENCE", "Отсутствие не доказано: листов стадии нет в пакете", "NOT_COMPARABLE");
      else if (holes.length) lower("VER-05", "NOT_COMPARABLE", `Отсутствие не доказано: не просмотрены полностью ${holes.map((s) => s.document_code).join(", ")}`, "NOT_COMPARABLE");
    }
  }
  // VER-07 детализация против изменения
  trace.ops.push("VER-07");
  if (cand() && !ctx.threshold_rule && isRefinement(ev.expected, ev.actual)) {
    lower("VER-07", "NEGATIVE_VERIFIED", `Различие — детализация: «${ev.actual}» уточняет «${ev.expected}»`, "DETAIL_REFINEMENT");
  }
  // CMP-29 легитимность изменения → VER-08
  trace.ops.push("CMP-29", "VER-08");
  if (cand()) {
    const c = changeLegit(ctx, ev);
    trace.change = c.result;
    trace.approved_change_ref = c.ref;
    if (c.result === "APPROVED_CHANGE") lower("VER-08", "NEGATIVE_VERIFIED", `Согласованное изменение: ${c.why}`, "APPROVED_CHANGE");
    else if (c.result === "CHANGE_CONFLICT") lower("VER-08", "CLARIFICATION_REQUIRED", `Изменение породило конфликт редакций: ${c.why}`, "WRONG_REVISION");
    else if (c.result === "CHANGE_APPROVAL_UNVERIFIED") {
      trace.flags.push("CHANGE_APPROVAL_UNVERIFIED", ...(c.flag ? [c.flag] : []));
      trace.steps.push({ op: "VER-08", from: ev.status, to: ev.status, reason_code: null, why: c.why });
    }
  }
  // VER-11 атомизация
  trace.ops.push("VER-11");
  if (cand()) {
    trace.atoms = atomsOf(ev, ctx.threshold_rule);
    if (trace.atoms.length > 1) {
      trace.flags.push("COMPOSITE");
      trace.steps.push({ op: "VER-11", from: ev.status, to: ev.status, reason_code: null, why: `Кандидат объединяет ${trace.atoms.length} факта: ${trace.atoms.map((a) => `${a.stage} — ${a.actual}`).join("; ")}` });
    }
  }
  ev.l8 = trace;
  return ev;
}

/** Граф зависимостей параметров (VER-12): ребро [причина, следствие] — «площадь помещения → площадь этажа». */
export interface ParamDeps {
  edges: Array<[string, string]>;
}

/**
 * VER-12: корни каскадов. Кандидат, у которого есть кандидат-предок по графу (путь идёт только через кандидатов),
 * — производный: он привязывается к корню и не считается отдельным нарушением. Результат: производный → корни.
 */
export function cascadeRoots(statuses: ReadonlyMap<string, FindingStatus>, deps: ParamDeps): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const [from, to] of deps.edges) parents.set(to, [...(parents.get(to) ?? []), from]);
  const isCand = (c: string) => statuses.get(c) === "CANDIDATE";
  const out = new Map<string, string[]>();
  for (const code of statuses.keys()) {
    if (!isCand(code)) continue;
    const up = new Set<string>(); // кандидаты-предки
    const stack = (parents.get(code) ?? []).filter(isCand);
    while (stack.length) {
      const p = stack.pop()!;
      if (p === code || up.has(p)) continue;
      up.add(p);
      stack.push(...(parents.get(p) ?? []).filter(isCand));
    }
    if (!up.size) continue;
    let roots = [...up].filter((a) => !(parents.get(a) ?? []).some(isCand));
    // цикл в графе (данные с ошибкой): корнем считается наименьший код цикла; сам параметр — тогда не производный
    if (!roots.length) roots = [[...up, code].sort()[0]].filter((r) => r !== code);
    if (roots.length) out.set(code, roots.sort());
  }
  return out;
}

/** Данные слоя: `data/seed/l8-gates.json` и `data/seed/param-deps.json`; битые данные — громкий отказ при загрузке. */
export const GateConfigSchema = z.object({
  min_confidence: z.record(z.string(), z.number().min(0).max(1)),
  methods: z.record(z.string(), z.object({ PD: z.string().optional(), RD: z.string().optional(), ID: z.string().optional() })),
  equivalent_methods: z.array(z.array(z.string())),
  sheet_kinds: z.record(z.string(), z.array(z.string())),
});
export const ParamDepsSchema = z.object({ edges: z.array(z.tuple([z.string(), z.string()])) });

/** Оператор L7, которым получен результат параметра: по пути сравнения и правилу Матрицы или паспорта. */
export function opFor(param: Pick<Param, "compare" | "value_scale" | "data_type">, path: "lexical" | "class" | "quantity", quantity?: { direction: string; tolerance_pct: number }): string {
  if (path === "class") return "CMP-04";
  if (path === "quantity") return quantity?.direction === "decrease" ? "CMP-03" : quantity && quantity.tolerance_pct > 0 ? "CMP-02" : "CMP-01";
  const k = param.compare.kind;
  if (k === "min" || k === "max") return "CMP-06";
  if (k === "delta_pct") return "CMP-02";
  if (k === "decrease" || k === "increase") return param.value_scale ? "CMP-04" : "CMP-03";
  return param.data_type === "number" ? "CMP-01" : "CMP-05";
}

// Единица рядом со значением: границы слова — через \p{L}, \b в JS видит только латиницу
const L = "(?<![\\p{L}])";
const R = "(?![\\p{L}])";
const UNITS: Array<[RegExp, string]> = [
  [new RegExp(`${L}м\\s*[³3]\\s*/\\s*ч${R}`, "iu"), "м³/ч"],
  [new RegExp(`${L}м\\s*[³3]\\s*/\\s*сут${R}`, "iu"), "м³/сут"],
  [new RegExp(`${L}(?:м\\s*[²2](?![\\d])|кв\\.\\s*м${R})`, "iu"), "м²"],
  [new RegExp(`${L}(?:м\\s*[³3](?![\\d])|куб\\.\\s*м${R})`, "iu"), "м³"],
  [new RegExp(`${L}мм${R}`, "iu"), "мм"],
  [new RegExp(`${L}см${R}`, "iu"), "см"],
  [new RegExp(`${L}км${R}`, "iu"), "км"],
  [new RegExp(`${L}м${R}`, "u"), "м"],
  [new RegExp(`${L}мвт${R}`, "iu"), "МВт"],
  [new RegExp(`${L}квт${R}`, "iu"), "кВт"],
  [new RegExp(`${L}гкал\\s*/\\s*ч${R}`, "iu"), "Гкал/ч"],
  [/%/, "%"],
];

/** GTE-04: единица, записанная в извлечённом значении («3,3 м», «3300 мм», «1200 м2»); не записана — null. */
export function unitOf(raw: string | null | undefined): string | null {
  const s = raw ?? "";
  for (const [re, u] of UNITS) if (re.test(s)) return u;
  return null;
}
