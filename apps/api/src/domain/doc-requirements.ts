// Полнота ИД и сечения по паспорту (T-213): М-096 «Узлы временного расчленения сохраняемых конструкций».
// Каталог TO-BE: ENT-22 (акт ИД — ML находит его по перечню паспорта, doc_requirements.py), ENT-17 (сечения элементов),
// GTE-01…03, CMP-25 DOC-REQ (обязательный документ ИД: нет — MISSING_EVIDENCE, а не нарушение; пустой реквизит в
// имеющемся акте — CANDIDATE по реквизитам), CMP-22 (дата акта не раньше даты работ), CMP-03 DIR-WORSE (сечение
// элемента в РД меньше, чем в ПД), DEC-01. Правила — OS-INSP-3.1.167–3.1.169.
import type { ClassEvaluation, MentionUse } from "./class-param.ts";
import type { Evaluation, Fragment, Param, RevisionRole, Stage } from "./types.ts";
import { STAGES } from "./types.ts";

export interface DocReqPassport {
  docs: Array<{ id: string; title: string }>; // обязательные документы ИД (CMP-25)
  sections: boolean; // сравнивать сечения элементов ПД ↔ РД (CMP-03)
}

interface Located {
  stage: Stage;
  file_id: string;
  sha256: string;
  document_code: string;
  revision: string;
  approval_status: Fragment["approval_status"];
  role: RevisionRole;
  discipline: string | null;
  page: number;
  bbox: [number, number, number, number] | null;
  quote: string;
  confidence: number;
}

/** Находка doc_requirements.py: документ ИД, сечение, нечитаемое сечение, пустой реквизит, даты акта и работ, «сноса нет». */
export type DocReqMention = Located &
  (
    | { kind: "doc"; doc: string }
    | { kind: "section"; profile: string; dims: number[]; label: string; excluded?: string | null; excluded_why?: string | null }
    | { kind: "section_unreadable"; label?: string }
    | { kind: "requisite_gap"; label: string }
    | { kind: "act_date" | "work_date"; node: string; date: string }
    | { kind: "not_applicable" }
  );

export interface DocReqEvaluation extends Evaluation {
  provenance: ClassEvaluation["provenance"];
  suspicions: never[];
}

export const DOCREQ_OPS = ["ENT-22", "ENT-17", "NRM-01", "GTE-01", "GTE-02", "GTE-03", "CMP-25", "CMP-22", "CMP-03", "VER-02", "DEC-01"];

type Section = Extract<DocReqMention, { kind: "section" }>;
type Dated = Extract<DocReqMention, { kind: "act_date" | "work_date" }>;

/**
 * Самое слабое сечение профиля на стадии: наименьшее по размерам по порядку (высота/полка/диаметр, затем толщина).
 * Сравниваются только профили одного вида — двутавр с уголком не сравнить.
 */
export function weakest(ms: Section[]): Map<string, Section> {
  const out = new Map<string, Section>();
  for (const m of ms) {
    const cur = out.get(m.profile);
    if (!cur || lexLess(m.dims, cur.dims)) out.set(m.profile, m);
  }
  return out;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Занижение сечения (OS-INSP-3.1.168): все размеры РД не больше ПД и хотя бы один меньше. Один размер больше,
 * другой меньше — «хуже» не определить: null (не нарушение).
 */
export function underrated(pd: number[], rd: number[]): boolean | null {
  let less = false;
  let more = false;
  for (let i = 0; i < Math.max(pd.length, rd.length); i++) {
    const a = pd[i];
    const b = rd[i];
    if (a === undefined || b === undefined) return null;
    if (b < a) less = true;
    if (b > a) more = true;
  }
  if (less && more) return null;
  return less;
}

/** Дата «2027-05-15» или «-05-15» (год не указан) → сравнимый ключ; без года сравнивается внутри одного года. */
const dateKey = (d: string) => d.replace(/^-/, "");

/** Акт раньше работ по тому же узлу (OS-INSP-3.1.167, CMP-22): пары «акт — работа» с датой акта раньше даты работ. */
export function actBeforeWork(ms: Dated[]): Array<{ act: Dated; work: Dated }> {
  const out: Array<{ act: Dated; work: Dated }> = [];
  for (const act of ms.filter((m) => m.kind === "act_date"))
    for (const work of ms.filter((m) => m.kind === "work_date" && m.node === act.node)) {
      const bothYears = !act.date.startsWith("-") && !work.date.startsWith("-");
      const a = bothYears ? act.date : dateKey(act.date).slice(-5);
      const w = bothYears ? work.date : dateKey(work.date).slice(-5);
      if (a < w) out.push({ act, work });
    }
  return out;
}

function frag(m: Located, kind: Fragment["kind"], value: string): Fragment {
  return { file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status, page: m.page, bbox: m.bbox, role: m.role, value, kind };
}

export interface DocReqEvalInput {
  param: Param;
  passport: DocReqPassport;
  mentions: DocReqMention[];
  loadedStages: Stage[];
  profile: Record<string, boolean>;
}

const at = (m: Located) => `${m.document_code}, стр. ${m.page}`;
const STAGE_NEED: Record<"PD" | "RD", string> = { PD: "ПД (чертежи временных подпорок ПОД)", RD: "РД (узлы креплений, спецификация КР/ППР)" };

export function evaluateDocRequirements({ param, passport, mentions, loadedStages, profile }: DocReqEvalInput): DocReqEvaluation {
  const live = mentions.filter((m) => m.role !== "SUPERSEDED");
  const of = <K extends DocReqMention["kind"]>(k: K, s?: Stage) => live.filter((m): m is Extract<DocReqMention, { kind: K }> => m.kind === k && (!s || m.stage === s));
  const docs = of("doc", "ID");
  const secs = (s: Stage) => of("section", s).filter((m) => !m.excluded);
  const title = (id: string) => passport.docs.find((d) => d.id === id)?.title ?? id;
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) {
    const has = s === "ID" ? docs.length > 0 : passport.sections && secs(s).length > 0;
    notes[s] = !loadedStages.includes(s) || (s !== "ID" && !passport.sections) ? "NOT_APPLICABLE" : has ? "USED" : "NO_VALUE";
  }
  const value = (m: DocReqMention) => (m.kind === "doc" ? title(m.doc) : m.kind === "section" ? m.label : m.kind === "requisite_gap" ? `пустой реквизит: ${m.label}` : m.kind === "act_date" || m.kind === "work_date" ? `${m.kind === "act_date" ? "акт" : "работы"} ${m.node}: ${m.date}` : m.kind === "section_unreadable" ? "сечение не читается" : "сохраняемых конструкций нет");
  const provenance: DocReqEvaluation["provenance"] = {
    ops: DOCREQ_OPS,
    mentions: mentions.map((m) => {
      const [use, why]: [MentionUse, string | null] =
        m.role === "SUPERSEDED" ? ["dropped", "устаревшая редакция"] : m.kind === "doc" && m.stage !== "ID" ? ["reference", "упоминание документа ИД вне стадии ИД — справочно"] : m.kind === "section" && m.excluded ? ["dropped", "другой элемент (котлован, шпунт)"] : ["considered", null];
      return { stage: m.stage, use, why, value: value(m), qualifier: null, discipline: m.discipline, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote, bbox: m.bbox, anchor_bbox: null, excluded: m.kind === "section" ? (m.excluded ?? null) : null, source: null, readings: null, reader_outcome: null, judge: null };
    }),
  };
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[], stage_notes: notes, suspicions: [] as never[], provenance };

  // 1. Применимость (GTE-01): профиль объекта или документ ПОД/ППР «сохраняемых конструкций нет»
  if (param.applicability && profile[param.applicability] === false) return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим к объекту: ${param.applicability}` };
  const na = of("not_applicable").filter((m) => m.stage !== "ID");
  if (na.length && !secs("PD").length && !secs("RD").length) return { ...base, status: "NOT_APPLICABLE", reason: `Сохраняемых конструкций нет — узлов расчленения нет (${at(na[0])}).`, fragments: [frag(na[0], "expected", "сохраняемых конструкций нет")] };
  // 2. Актуальность редакций (GTE-03)
  const disputed = live.filter((m) => m.role === "CONFLICT" || m.role === "UNRESOLVED");
  if (disputed.length) return { ...base, status: "CLARIFICATION_REQUIRED", reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((m) => `${m.document_code} ред. ${m.revision}`))].join(", ")}` };

  const findings: string[] = [];
  const fragments: Fragment[] = [];
  const unclear: string[] = [];
  const gaps: string[] = [];
  let head: { expected: string; actual: string; delta: string } | null = null;
  let checked = false;
  // 3. CMP-03: сечения элементов расчленения ПД ↔ РД (OS-INSP-3.1.168)
  if (passport.sections) {
    const pd = weakest(secs("PD"));
    const rd = weakest(secs("RD"));
    const present = (s: "PD" | "RD") => secs(s).length + of("section", s).length + of("section_unreadable", s).length > 0;
    for (const s of ["PD", "RD"] as const) {
      if (!loadedStages.includes(s) && (present("PD") || present("RD"))) gaps.push(`${STAGE_NEED[s]} — стадия не загружена`);
      else if (loadedStages.includes(s) && !present(s) && present(s === "PD" ? "RD" : "PD")) gaps.push(`сечения элементов расчленения не найдены в ${STAGE_NEED[s]}`);
    }
    for (const s of ["PD", "RD"] as const) {
      if (!secs(s).length && of("section_unreadable", s).length) unclear.push(`сечение в ${s === "PD" ? "ПД" : "РД"} не читается (${at(of("section_unreadable", s)[0])})`);
      else if (!secs(s).length && of("section", s).length) unclear.push(`в ${s === "PD" ? "ПД" : "РД"} сечение другого элемента — ${of("section", s)[0].label} (${of("section", s)[0].excluded_why ?? "котлован, шпунт"})`);
    }
    let compared = 0;
    for (const [profile, a] of pd) {
      const b = rd.get(profile);
      if (!b) continue;
      const u = underrated(a.dims, b.dims);
      if (u === null) {
        unclear.push(`${a.label} (ПД) и ${b.label} (РД) — один размер больше, другой меньше`);
        continue;
      }
      compared++;
      if (u) {
        findings.push(`сечение элемента расчленения занижено: в РД ${b.label} (${at(b)}) против ${a.label} в ПД (${at(a)})`);
        fragments.push(frag(a, "expected", a.label), frag(b, "actual", b.label));
        head ??= { expected: a.label, actual: b.label, delta: "сечение меньше" };
      }
    }
    if (pd.size && rd.size && !compared && !unclear.length) unclear.push(`вид профиля сменился: ПД — ${[...pd.values()].map((m) => m.label).join(", ")}; РД — ${[...rd.values()].map((m) => m.label).join(", ")}`);
    checked ||= compared > 0;
  }
  // 4. CMP-25: акт в ИД (OS-INSP-3.1.167) — только если ИД загружена: сравнение ПД ↔ РД без ИД — не пробел ИД
  const idLoaded = loadedStages.includes("ID");
  const found = new Set(docs.map((m) => m.doc));
  const missingDocs = passport.docs.filter((d) => !found.has(d.id));
  if (idLoaded) {
    checked = true;
    if (missingDocs.length) gaps.push(`в ИД нет: ${missingDocs.map((d) => d.title).join("; ")}`);
    // пустой реквизит в имеющемся акте — кандидат по реквизитам
    for (const g of of("requisite_gap", "ID")) {
      findings.push(`в акте не заполнен реквизит «${g.label}» (${at(g)})`);
      fragments.push(frag(g, "actual", `пустой реквизит: ${g.label}`));
      head ??= { expected: `реквизит «${g.label}» заполнен`, actual: "реквизит пустой", delta: "реквизит акта" };
    }
    // дата акта раньше даты работ по тому же узлу (CMP-22)
    for (const { act, work } of actBeforeWork([...of("act_date", "ID"), ...of("work_date", "ID")])) {
      findings.push(`акт по узлу ${act.node} датирован ${act.date.replace(/^-/, "")} — раньше работ по журналу (${work.date.replace(/^-/, "")})`);
      fragments.push(frag(work, "expected", `работы ${work.node}: ${work.date}`), frag(act, "actual", `акт ${act.node}: ${act.date}`));
      head ??= { expected: `акт не раньше ${work.date.replace(/^-/, "")}`, actual: act.date.replace(/^-/, ""), delta: "дата акта раньше работ" };
    }
  }
  // W3-11: система видит упоминание документа, а не сам документ — формулировка «упоминание»
  const foundNote = docs.length ? ` Упоминание в ИД: ${[...found].map((id) => `${title(id)} (${at(docs.find((m) => m.doc === id)!)})`).join("; ")}.` : "";
  const gapNote = gaps.length ? ` Не хватает доказательств (не нарушение): ${gaps.join("; ")}.` : "";

  if (findings.length) return { ...base, status: "CANDIDATE", ...head!, reason: `${findings.join("; ")}.${gapNote} Правило Матрицы: ${param.trigger_logic}`, fragments };
  const docFrags = docs.slice(0, 3).map((m) => frag(m, "actual", title(m.doc)));
  if (unclear.length) return { ...base, status: "NOT_COMPARABLE", reason: `Сечения сравнить нельзя: ${unclear.join("; ")}.${gapNote}${foundNote}`, fragments: docFrags };
  if (gaps.length) return { ...base, status: "MISSING_EVIDENCE", reason: `Не хватает доказательств (не нарушение): ${gaps.join("; ")}.${foundNote}`, fragments: docFrags };
  if (!checked) return { ...base, status: "MISSING_EVIDENCE", reason: `Проверить нечего: сечений элементов расчленения в ПД и РД нет, ИД не загружена — нужны: ${passport.docs.map((d) => d.title).join("; ")}.` };
  return { ...base, status: "NEGATIVE_VERIFIED", reason: `${param.parameter_name}: ${passport.sections && secs("PD").length && secs("RD").length ? "сечения элементов расчленения в РД не меньше ПД; " : ""}${idLoaded ? "в ИД найдено упоминание акта монтажа, пустых реквизитов и дат раньше работ не найдено" : "ИД не загружена — акт не проверялся"}.${foundNote}`, fragments: docFrags };
}
