// Календарный график по паспорту (T-213): М-082 «Продолжительность этапов строительства», М-087 «Технологическая
// последовательность возведения». Каталог TO-BE: ENT-24 (строки графика ПОС/ППР — извлекает ML, schedule_rows.py),
// NRM-06 (канон названия этапа), LNK-01/VER-15 (один график на стадию), GTE-01…03 (ворота), CMP-22 TEMPORAL
// (длительность > порога, перестановка порядка), CMP-23 в минимальном словаре технологий (монолит → сборный ЖБ),
// DEC-01 (provenance). Правила — OS-INSP-3.1.160–3.1.166. Порядок ворот тот же, что в quantity-param.ts.
//
// Не нарушение: этап без пары в другой стадии, рабочие дни против календарных, этап без длительности — такие строки
// называются в причине (NOT_COMPARABLE / MISSING_EVIDENCE), кандидатом не становятся.
import type { ClassEvaluation, MentionUse } from "./class-param.ts";
import { sourceRank } from "./class-param.ts";
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

export interface SchedulePassport {
  tolerance_pct: number; // порог Матрицы: М-082 — 10 % по критическому этапу
  checks: Array<"duration" | "order" | "technology">;
  critical: string[]; // регулярные выражения названий критических этапов (по канону названия)
  technologies: Array<{ id: string; title: string; pattern: string }>; // словарь CMP-23: слова технологии не различают этапы
  sources: Record<Stage, Array<{ discipline: string; label?: string }>>;
}

/** Строка графика стадии: одна строка таблицы ПОС/ППР (ENT-24), с местом на листе. */
export interface ScheduleRow {
  stage: Stage;
  file_id: string;
  sha256: string;
  document_code: string;
  revision: string;
  approval_status: Fragment["approval_status"];
  role: RevisionRole;
  discipline: string | null;
  table: number; // номер таблицы графика в документе: у файла может быть несколько графиков
  group: number; // фраза или таблица, внутри которой задан порядок: порядок сравнивается только внутри неё
  order: number; // порядок строки в группе
  seq: boolean; // порядок задан явно (стрелки, «затем», нумерация, таблица «Порядок»), а не просто строками таблицы
  name: string;
  days: number | null; // длительность в календарных (или рабочих — calendar=false) днях
  calendar: boolean;
  start: string | null; // ISO yyyy-mm-dd
  end: string | null;
  critical: boolean; // помечен критическим в самом документе
  total: boolean; // строка «Итого» / «Общая продолжительность» — критична по определению
  tech: string | null; // технология этапа по словарю паспорта
  page: number;
  bbox: [number, number, number, number] | null;
  quote: string;
  confidence: number;
}

export interface SchedulePick {
  chosen: ScheduleRow[]; // строки выбранного графика по порядку
  others: ScheduleRow[]; // графики других документов стадии — справочно
  dropped: ScheduleRow[]; // устаревшие редакции
}

/** Гипотеза для инспектора (OS-INSP-3.1.164): этапы переставлены только в строках графика, дат начала нет. */
export interface ScheduleSuspicion {
  kind: "order" | "criticality";
  note: string; // фраза для причины проверки
  description: string;
  rows: ScheduleRow[]; // строки пары в ПД и РД — ссылки гипотезы
  dedup_key: string;
}

export interface ScheduleEvaluation extends Evaluation {
  provenance: ClassEvaluation["provenance"];
  suspicions: ScheduleSuspicion[];
}

export const SCHEDULE_OPS = ["ENT-24", "NRM-01", "NRM-06", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-22", "CMP-23", "VER-02", "DEC-01"];

const ROLE_ORDER: Record<RevisionRole, number> = { CURRENT: 0, CONFLICT: 1, UNRESOLVED: 2, SUPERSEDED: 3 };
const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
// служебные слова названия этапа: не различают этапы («работы по устройству подземной части» = «подземная часть»)
const STOP_WORDS = ["и", "в", "на", "по", "с", "со", "из", "для", "до", "от", "к", "за", "работы", "этап", "период", "выполнение", "производство", "устройство", "возведение", "монтаж", "строительство", "часть"];
const STEM = 6; // основа слова: «подготовительный» и «подготовительного» — один этап
const ENDING = /(?:ами|ями|ого|его|ому|ему|ыми|ими|ых|их|ой|ей|ий|ый|ая|яя|ое|ее|ые|ие|ую|юю|ов|ев|ах|ях|ам|ям|ом|ем|ы|и|а|я|у|ю|о|е|ь)$/;
// сокращения в названиях этапов графика: «Надземная ч.», «ИС»
const ABBR: Array<[RegExp, string]> = [
  [/(?<![а-я])ч\.(?=\s|$)/g, " часть "],
  [/(?<![а-я])ис(?![а-я])/g, " инженерные системы "],
];

/** Основа слова: окончание снимается у слов длиннее четырёх букв, затем первые шесть букв; число — как есть. */
export function stem(w: string): string {
  if (/^\d+$/.test(w)) return w;
  return (w.length > 4 ? w.replace(ENDING, "") : w).slice(0, STEM);
}
const STOP = new Set(STOP_WORDS.map(stem));

/**
 * Канон названия этапа (NRM-06): регистр, «ё», номер строки, скобки, сокращения, знаки, служебные слова, окончания.
 * Слова технологии (ignore — словарь паспорта) и «железобетон», «ж/б» убираются: «каркас из монолитного железобетона»
 * и «каркас из сборного ж/б» — один этап, у которого сменилась технология (OS-INSP-3.1.165), а не два разных этапа.
 */
export function stageKey(name: string, ignore: RegExp[] = []): string {
  let t = name.toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)/g, " ");
  for (const re of ignore) t = t.replace(re, " ");
  for (const [re, to] of ABBR) t = t.replace(re, to);
  t = t
    .replace(/железобетон[а-я]*|ж\s*\/\s*б|(?<![а-я])жб(?![а-я])/g, " ")
    .replace(/^\s*(?:этап\s*)?\d+(?:\.\d+)*\.?\s*/, "")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
  return t
    .split(" ")
    .map(stem)
    .filter((w) => w && !STOP.has(w))
    .join(" ");
}

/** Одно ли слово: основы равны или одна — начало другой не короче четырёх букв («земл.» = «земляные»). */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && !/\d/.test(a + b) && (a.startsWith(b) || b.startsWith(a)));

/** Сходство названий: доля слов короткого названия, найденных в другом («фундаменты» ⊂ «фундаментная плита» — 1). */
export function similarity(a: string, b: string): number {
  return simWords(words(a), words(b));
}

/** Слова канона — один раз на этап, а не на каждое сравнение (W3-04). */
const words = (k: string): string[] => [...new Set(k.split(" ").filter(Boolean))];

function simWords(x: string[], y: string[]): number {
  if (!x.length || !y.length) return 0;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.filter((w) => long.some((v) => sameWord(w, v))).length / short.length;
}

export const MATCH_MIN = 0.6; // сходство названий ниже — этапы разные
// уточнение объекта в названии этапа: номер или часть здания разводят этапы («каркас 1 секции» ≠ «каркас 2 секции»,
// «кровля» ≠ «кровля паркинга») — по сходству слов такие этапы не сопоставляются (CMP-22 сравнил бы разные этапы)
const QUALIFIER = /\d|^(?:секци|корпус|блок|паркин|пристр|этаж|очеред|строен|литер|башн|подъез|сооруж|пусков|захват|участк|осям|ось)/;

/** Разводят ли этапы уточнения объекта: слово-уточнение или число есть в одном названии и нет в другом. */
export function qualifiersDiffer(a: string, b: string): boolean {
  return qualWordsDiffer(words(a), words(b));
}

function qualWordsDiffer(x: string[], y: string[]): boolean {
  for (const w of x) if (QUALIFIER.test(w) && !y.some((v) => sameWord(w, v))) return true;
  for (const w of y) if (QUALIFIER.test(w) && !x.some((v) => sameWord(w, v))) return true;
  return false;
}

// предел входа: этапов на стадию и пар для сравнения порядка (O(n²) по парам) — W3-04
export const MAX_STAGE_ROWS = 500;
export const MAX_ORDER_PAIRS = 200;

export interface StageMatch {
  pairs: Array<{ pd: ScheduleRow; rd: ScheduleRow }>;
  unmatchedPd: ScheduleRow[];
  unmatchedRd: ScheduleRow[];
  ambiguous: ScheduleRow[]; // у этапа ПД два одинаково похожих этапа РД — пара не угадывается
}

/**
 * Сопоставление этапов ПД ↔ РД (OS-INSP-3.1.161): сначала одинаковый канон названия, затем взаимно лучшее сходство
 * слов ≥ MATCH_MIN (доля слов короткого названия в длинном). Двусмысленность (два равных кандидата) — не пара: этап называется в причине, а не сравнивается.
 */
export function matchStages(pd: ScheduleRow[], rd: ScheduleRow[], ignore: RegExp[] = []): StageMatch {
  const pairs: StageMatch["pairs"] = [];
  const ambiguous: ScheduleRow[] = [];
  const usedRd = new Set<ScheduleRow>();
  const usedPd = new Set<ScheduleRow>();
  const keyOf = new Map<ScheduleRow, string>([...pd, ...rd].map((r) => [r, stageKey(r.name, ignore)]));
  const wordsOf = new Map<ScheduleRow, string[]>([...keyOf].map(([r, k]) => [r, words(k)]));
  // 1. одинаковый канон, единственный с обеих сторон
  for (const a of pd) {
    const same = rd.filter((b) => keyOf.get(b) === keyOf.get(a));
    const twins = pd.filter((b) => keyOf.get(b) === keyOf.get(a));
    if (same.length === 1 && twins.length === 1) {
      pairs.push({ pd: a, rd: same[0] });
      usedPd.add(a);
      usedRd.add(same[0]);
    } else if (same.length > 1 || (same.length === 1 && twins.length > 1)) {
      ambiguous.push(a);
      usedPd.add(a);
    }
  }
  // 2. взаимно лучшее сходство слов
  const best = (r: ScheduleRow, pool: ScheduleRow[]) => {
    let top: ScheduleRow[] = [];
    let s = 0;
    for (const x of pool) {
      if (qualWordsDiffer(wordsOf.get(r)!, wordsOf.get(x)!)) continue;
      const v = simWords(wordsOf.get(r)!, wordsOf.get(x)!);
      if (v > s + 1e-9) {
        s = v;
        top = [x];
      } else if (Math.abs(v - s) <= 1e-9 && v > 0) top.push(x);
    }
    return { top, s };
  };
  for (const a of pd) {
    if (usedPd.has(a)) continue;
    const poolRd = rd.filter((x) => !usedRd.has(x));
    const { top, s } = best(a, poolRd);
    if (s < MATCH_MIN) continue;
    if (top.length > 1) {
      ambiguous.push(a);
      continue;
    }
    const back = best(top[0], pd.filter((x) => !usedPd.has(x)));
    if (back.top.length !== 1 || back.top[0] !== a) continue;
    pairs.push({ pd: a, rd: top[0] });
    usedPd.add(a);
    usedRd.add(top[0]);
  }
  return { pairs, unmatchedPd: pd.filter((x) => !usedPd.has(x) && !ambiguous.includes(x)), unmatchedRd: rd.filter((x) => !usedRd.has(x)), ambiguous };
}

/**
 * График стадии (OS-INSP-3.1.160): все этапы одного документа (таблицы и фразы) — раздел выше по приоритету паспорта →
 * актуальная редакция → больше этапов → файл. Устаревшие редакции не участвуют, другие документы стадии — справочно.
 */
export function pickSchedule(rows: ScheduleRow[], stage: Stage, p: Pick<SchedulePassport, "sources">): SchedulePick {
  const own = rows.filter((r) => r.stage === stage);
  const dropped = own.filter((r) => r.role === "SUPERSEDED");
  const files = new Map<string, ScheduleRow[]>();
  for (const r of own) if (r.role !== "SUPERSEDED") files.set(r.file_id, [...(files.get(r.file_id) ?? []), r]);
  const key = (g: ScheduleRow[]) => [sourceRank(p, stage, g[0].discipline), ROLE_ORDER[g[0].role], -g.length, g[0].file_id] as const;
  const sorted = [...files.values()].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  const chosen = [...(sorted[0] ?? [])].sort((a, b) => a.group - b.group || a.order - b.order).slice(0, MAX_STAGE_ROWS);
  return { chosen, others: sorted.slice(1).flat(), dropped };
}

/**
 * Критический этап (OS-INSP-2.2.147): помечен в документе, итоговая строка или название из перечня паспорта. Если
 * критический путь не выделен ни в одном из графиков (anyMarked = false), критическим считается каждый этап: какой
 * этап критичен, решает инспектор, а не система.
 */
export function isCritical(r: ScheduleRow, p: Pick<SchedulePassport, "critical">, anyMarked = true): boolean {
  if (r.critical || r.total || !anyMarked) return true;
  const n = r.name.toLowerCase().replace(/ё/g, "е");
  return p.critical.some((re) => ruRegExp(re).test(n));
}

/** Регулярное выражение паспорта (синтаксис Python, где \w — и кириллица) для JS: \w дополняется кириллицей. */
export function ruRegExp(pattern: string, flags = "i"): RegExp {
  return new RegExp(pattern.replace(/\\w/g, "[\\wА-Яа-яЁё]"), flags);
}

/** Слова технологий паспорта целиком («монолитн» → «монолитного»): для канона названия этапа. */
export function techWords(p: Pick<SchedulePassport, "technologies">): RegExp[] {
  return p.technologies.map((t) => ruRegExp(`(?:${t.pattern})[а-я]*`, "gi"));
}

const fmt = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
const days = (r: ScheduleRow) => `${fmt(r.days!)} ${r.calendar ? "дн." : "раб. дн."}`;
const at = (r: ScheduleRow) => `«${r.name}» (${r.document_code}, стр. ${r.page})`;

/** Превышение длительности этапа РД над ПД в процентах; null — длительности нельзя сравнить. */
export function overrun(pd: ScheduleRow, rd: ScheduleRow): number | null {
  if (pd.days === null || rd.days === null || pd.days <= 0 || pd.calendar !== rd.calendar) return null;
  return ((rd.days - pd.days) / pd.days) * 100;
}

type Pair = StageMatch["pairs"][number];
export type OrderBasis = "dates" | "sequence" | "rows";

/**
 * Пары пар этапов, чей порядок сравним (OS-INSP-3.1.164): по датам начала, если они есть у всех четырёх строк; иначе —
 * только внутри одной фразы или таблицы в каждой стадии (порядок разных фраз не задан). Основание: даты, явный порядок
 * в обеих стадиях (стрелки, «затем», нумерация, таблица «Порядок») или просто строки таблицы.
 */
export function orderable(all: Pair[]): Array<[Pair, Pair, OrderBasis]> {
  const pairs = all.slice(0, MAX_ORDER_PAIRS);
  const out: Array<[Pair, Pair, OrderBasis]> = [];
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pairs[i];
      const b = pairs[j];
      const dated = Boolean(a.pd.start && b.pd.start && a.rd.start && b.rd.start);
      if (!dated && (a.pd.group !== b.pd.group || a.rd.group !== b.rd.group)) continue;
      out.push([a, b, dated ? "dates" : a.pd.seq && b.pd.seq && a.rd.seq && b.rd.seq ? "sequence" : "rows"]);
    }
  return out;
}

/** Перестановки: пара этапов идёт в РД в обратном порядке (одновременный старт и равный номер — не перестановка). */
export function inversions(pairs: Pair[]): Array<[Pair, Pair, OrderBasis]> {
  const out: Array<[Pair, Pair, OrderBasis]> = [];
  for (const [a, b, by] of orderable(pairs)) {
    const pdCmp = by === "dates" ? a.pd.start!.localeCompare(b.pd.start!) : a.pd.order - b.pd.order;
    const rdCmp = by === "dates" ? a.rd.start!.localeCompare(b.rd.start!) : a.rd.order - b.rd.order;
    if (pdCmp !== 0 && rdCmp !== 0 && Math.sign(pdCmp) !== Math.sign(rdCmp)) out.push(pdCmp < 0 ? [a, b, by] : [b, a, by]);
  }
  return out;
}

function frag(r: ScheduleRow, kind: Fragment["kind"], value: string): Fragment {
  return { file_id: r.file_id, sha256: r.sha256, stage: r.stage, document_code: r.document_code, revision: r.revision, approval_status: r.approval_status, page: r.page, bbox: r.bbox, role: r.role, value, kind };
}

export interface ScheduleEvalInput {
  param: Param;
  passport: SchedulePassport;
  rows: ScheduleRow[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
}

const NEED: Record<Stage, string> = { PD: "календарный план ПОС (таблица этапов с длительностями или датами)", RD: "график производства работ ППР (таблица этапов)", ID: "общий журнал работ" };

export function evaluateSchedule({ param, passport, rows, loadedStages, profile }: ScheduleEvalInput): ScheduleEvaluation {
  const picks = Object.fromEntries(STAGES.map((s) => [s, pickSchedule(rows, s, passport)])) as Record<Stage, SchedulePick>;
  const notes: Evaluation["stage_notes"] = {};
  // ИД (общий журнал работ, даты этапов) в этой итерации не сравнивается — задел T-213
  for (const s of STAGES) notes[s] = s === "ID" || !loadedStages.includes(s) ? "NOT_APPLICABLE" : picks[s].chosen.length ? "USED" : "NO_VALUE";
  const value = (r: ScheduleRow) => `${r.name}: ${r.days === null ? "без длительности" : days(r)}${r.start ? ` (${r.start} — ${r.end ?? "?"})` : ""}${r.tech ? `, ${passport.technologies.find((t) => t.id === r.tech)?.title ?? r.tech}` : ""}`;
  const provenance: ScheduleEvaluation["provenance"] = {
    ops: SCHEDULE_OPS,
    mentions: STAGES.flatMap((s) =>
      rows
        .filter((r) => r.stage === s)
        .map((r) => {
          const pk = picks[s];
          const [use, why]: [MentionUse, string | null] = pk.chosen.includes(r) ? ["chosen", null] : pk.dropped.includes(r) ? ["dropped", "устаревшая редакция"] : ["reference", "график другого документа стадии — справочно"];
          return { stage: s, use, why, value: value(r), qualifier: null, discipline: r.discipline, document_code: r.document_code, file_id: r.file_id, page: r.page, quote: r.quote, bbox: r.bbox, anchor_bbox: null, excluded: null, source: null, readings: null, reader_outcome: null, judge: null };
        }),
    ),
  };
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions: [] as ScheduleSuspicion[], provenance };

  // 1. Применимость (GTE-01)
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const pd = picks.PD.chosen;
  const rd = picks.RD.chosen;
  // 2. Актуальность редакций (GTE-03)
  const disputed = [...pd, ...rd].filter((r) => r.role === "CONFLICT" || r.role === "UNRESOLVED");
  if (disputed.length) {
    return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция графика: ${[...new Set(disputed.map((r) => `${r.document_code} ред. ${r.revision}`))].join(", ")}`, fragments: [frag(disputed[0], "actual", value(disputed[0]))] };
  }
  // 3. Комплектность (GTE-02): графики ПД и РД (OS-INSP-3.1.166)
  if (!pd.length || !rd.length) {
    const need = (["PD", "RD"] as Stage[]).filter((s) => !picks[s].chosen.length).map((s) => `${STAGE_RU[s]}: ${NEED[s]}${loadedStages.includes(s) ? " — графика в документах стадии нет" : " — стадия не загружена"}`);
    const found = pd.length ? `в ПД график из ${pd.length} этапов (${pd[0].document_code})` : rd.length ? `в РД график из ${rd.length} этапов (${rd[0].document_code})` : "графика нет ни в одной стадии";
    return { ...base, status: "MISSING_EVIDENCE", reason: `Сравнить не с чем: ${found}. Запросите ${need.join("; ")}.`, fragments: [...pd, ...rd].slice(0, 1).map((r) => frag(r, "expected", value(r))) };
  }
  const m = matchStages(pd, rd, techWords(passport));
  const anyMarked = [...pd, ...rd].some((r) => r.critical);
  const lost = [...m.unmatchedPd.map((r) => `ПД ${at(r)}`), ...m.ambiguous.map((r) => `ПД ${at(r)} — несколько похожих этапов РД`)];
  const lostNote = lost.length ? ` Не сопоставлены (не нарушение): ${lost.join("; ")}.` : "";
  if (!m.pairs.length) return { ...base, status: "NOT_COMPARABLE", reason: `Ни один этап РД не сопоставлен с этапами ПД по названию.${lostNote}` };

  const findings: string[] = [];
  const fragments: Fragment[] = [];
  const notComparable: string[] = [];
  const quiet: string[] = [];
  let checked = false;
  const blockedCritical: ScheduleRow[] = [];
  let techChecked = false;
  let head: { expected: string; actual: string; delta: string } | null = null;
  const suspicions: ScheduleSuspicion[] = [];
  // CMP-22: длительность критического этапа (OS-INSP-3.1.162, 3.1.163)
  if (passport.checks.includes("duration")) {
    let worst: { pd: ScheduleRow; rd: ScheduleRow; pct: number } | null = null;
    for (const { pd: a, rd: b } of m.pairs) {
      const pct = overrun(a, b);
      if (pct === null) {
        const crit = isCritical(a, passport, anyMarked) || isCritical(b, passport, anyMarked);
        if (a.days !== null && b.days !== null && a.calendar !== b.calendar) notComparable.push(`${at(a)}: ${days(a)} против ${days(b)} — рабочие и календарные дни не сравниваются`);
        else if (crit) notComparable.push(`${at(a)}: нет длительности в ${a.days === null ? "ПД" : "РД"}`);
        if (crit) blockedCritical.push(a); // W3-10: несравнимый критический этап — «в пределах порога» не утверждается
        continue;
      }
      // критичность установлена: пометка в документе, итоговая строка или перечень паспорта; иначе — не установлена
      const established = isCritical(a, passport) || isCritical(b, passport);
      if (!established && !anyMarked) {
        checked = true;
        // критический путь не выделен: превышение — гипотеза «критичность этапа не установлена», не кандидат
        if (pct > passport.tolerance_pct + 1e-9)
          suspicions.push({
            kind: "criticality",
            note: `${at(b)} длиннее ПД на ${fmt(pct)} % — критичность этапа не установлена`,
            description: `${param.code}: этап ${at(b)} длится ${days(b)} против ${days(a)} в ПД — на ${fmt(pct)} % дольше; критический путь в графике не выделен — критичность этапа не установлена, проверьте по ПОС`,
            rows: [a, b],
            dedup_key: `schedule-critical:${param.code}:${stageKey(a.name)}`,
          });
        continue;
      }
      if (!established) {
        if (pct > passport.tolerance_pct + 1e-9) quiet.push(`${at(b)} длиннее ПД на ${fmt(pct)} % — этап не критический`);
        continue;
      }
      checked = true;
      if (pct > passport.tolerance_pct + 1e-9 && (!worst || pct > worst.pct)) worst = { pd: a, rd: b, pct };
      if (pct > passport.tolerance_pct + 1e-9) {
        findings.push(`критический этап ${at(b)} длится ${days(b)} против ${days(a)} в ПД (${at(a)}) — на ${fmt(pct)} % дольше, порог ${fmt(passport.tolerance_pct)} %`);
        fragments.push(frag(a, "expected", days(a)), frag(b, "actual", days(b)));
      }
    }
    if (worst) head = { expected: days(worst.pd), actual: days(worst.rd), delta: `+${fmt(worst.rd.days! - worst.pd.days!)} дн. (+${fmt(worst.pct)} %)` };
  }
  // CMP-22: порядок этапов (OS-INSP-3.1.164)
  if (passport.checks.includes("order") && orderable(m.pairs).length) {
    checked = true;
    for (const [a, b, by] of inversions(m.pairs)) {
      if (by === "rows") {
        // только порядок строк, дат нет: часто вёрстка таблицы, а не смена последовательности — гипотеза, не кандидат
        suspicions.push({
          kind: "order",
          note: `перестановка без дат и без слов очерёдности: «${a.rd.name}» и «${b.rd.name}»`,
          description: `${param.code}: в графике РД этап «${b.rd.name}» стоит выше «${a.rd.name}», в ПД — наоборот; дат начала нет — проверьте последовательность по датам графика или ППР`,
          rows: [a.pd, b.pd, a.rd, b.rd],
          dedup_key: `schedule-order:${param.code}:${stageKey(a.pd.name)}>${stageKey(b.pd.name)}`,
        });
        continue;
      }
      findings.push(`порядок этапов изменён: в ПД ${at(a.pd)} раньше ${at(b.pd)}, в РД — позже (${by === "dates" ? "по датам начала" : "по явно заданной последовательности"})`);
      fragments.push(frag(a.pd, "expected", `${a.pd.name} → ${b.pd.name}`), frag(a.rd, "actual", `${b.rd.name} → ${a.rd.name}`));
      head ??= { expected: `${a.pd.name} → ${b.pd.name}`, actual: `${b.rd.name} → ${a.rd.name}`, delta: "перестановка этапов" };
    }
  }
  // CMP-23 в минимальном словаре: технология этапа сменилась (OS-INSP-3.1.165)
  if (passport.checks.includes("technology")) {
    const title = (id: string) => passport.technologies.find((t) => t.id === id)?.title ?? id;
    for (const { pd: a, rd: b } of m.pairs) {
      if (!a.tech || !b.tech) continue;
      checked = techChecked = true;
      if (a.tech === b.tech) continue;
      findings.push(`технология этапа ${at(b)} изменена: в ПД — ${title(a.tech)}, в РД — ${title(b.tech)}`);
      fragments.push(frag(a, "expected", title(a.tech)), frag(b, "actual", title(b.tech)));
      head ??= { expected: title(a.tech), actual: title(b.tech), delta: "смена технологии" };
    }
  }
  const hypo = suspicions.length ? ` Гипотеза для инспектора, не нарушение: ${suspicions.map((x) => x.note).join("; ")}.` : "";
  const tail = `${hypo}${notComparable.length ? ` Не сравнивались: ${notComparable.join("; ")}.` : ""}${quiet.length ? ` Не нарушение: ${quiet.join("; ")}.` : ""}${lostNote}`;
  if (findings.length) {
    return { ...base, suspicions, status: "CANDIDATE", ...head!, reason: `${findings.join("; ")}.${tail} Правило Матрицы: ${param.trigger_logic}`, fragments };
  }
  const pairsFrag = m.pairs.slice(0, 1).flatMap(({ pd: a, rd: b }) => [frag(a, "expected", value(a)), frag(b, "actual", value(b))]);
  // порядок подтвердить нельзя: «порядок тот же» не утверждается (OS-INSP-3.1.164)
  if (suspicions.length) {
    const why = suspicions.some((x) => x.kind === "order") ? "Порядок этапов по датам или словам очерёдности подтвердить нельзя." : "Критичность этапов не установлена — превышение длительности не нарушение, а гипотеза.";
    return { ...base, suspicions, status: "NOT_COMPARABLE", reason: `${why}${tail}`, fragments: pairsFrag };
  }
  if (!checked) return { ...base, status: "NOT_COMPARABLE", reason: `Сопоставлено этапов: ${m.pairs.length}, но сравнить нечего по правилу параметра.${tail}`, fragments: pairsFrag };
  // критический этап ПД без пары в РД: «в пределах порога» не утверждается (OS-INSP-3.1.163)
  // итоговая строка и строка без длительности — не этап, который можно потерять
  const lostCritical = passport.checks.includes("duration") ? [...m.unmatchedPd, ...m.ambiguous].filter((r) => r.days !== null && !r.total && isCritical(r, passport, anyMarked)) : [];
  if (blockedCritical.length && !lostCritical.length) return { ...base, status: "NOT_COMPARABLE", reason: `Длительность критических этапов сравнить нельзя: ${blockedCritical.map(at).join("; ")}.${tail}`, fragments: pairsFrag };
  if (lostCritical.length) return { ...base, status: "NOT_COMPARABLE", reason: `Критические этапы ПД не найдены в графике РД: ${lostCritical.map(at).join("; ")} — сравнить их длительность нельзя.${tail}`, fragments: pairsFrag };
  const ok = [passport.checks.includes("duration") ? `длительность критических этапов РД не превышает ПД больше чем на ${fmt(passport.tolerance_pct)} %` : null, passport.checks.includes("order") ? "порядок этапов тот же" : null, techChecked ? "технологии этапов те же" : null].filter(Boolean);
  return { ...base, status: "NEGATIVE_VERIFIED", reason: `${param.parameter_name}: сопоставлено этапов — ${m.pairs.length}; ${ok.join(", ")}.${tail}`, fragments: pairsFrag };
}
