// T-117 (OS-INSP-5.1.3–5.1.5): ответ в формате организатора — submission_schema.json из пакета участника (SRC-INSP-08).
// Код Матрицы М-NNN = parameter_id каталога организатора (сверено по наименованиям 132/132) → код вида KR-055.
// Допущения (организатор их не расписал; закреплены тестом):
//  - location: проверка у нас на уровне объекта — участок (СПЗУ, ЗУ) даёт SITE, остальное BUILDING;
//  - гипотеза свободного поиска входит в ответ только подтверждённой инспектором, с кодом FREE-<id>;
//  - находки о реквизитах (REQ-*) — не параметры Матрицы и в ответ не входят; неприменимое — тоже.
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

export type ViolationLabel = "VIOLATION_PRESENT" | "NO_VIOLATION" | "MISSING_DOCUMENT" | "COMPARISON_IMPOSSIBLE";
export type ProtocolStatus = "OK" | "WARNING" | "CRITICAL" | "ID_MISSING" | "RD_MISSING" | "PD_MISSING" | "COMPARISON_IMPOSSIBLE";

export interface SubmissionFragment {
  stage: string;
  file_id: string;
  /** Сквозная страница документа (1…); null — страница неизвестна. */
  page: number | null;
  value: string | null;
}

export interface SubmissionCheck {
  id: string;
  param_code: string;
  section: string | null;
  finding_status: string;
  verification_status: string;
  parent_id: string | null;
  fragments: SubmissionFragment[];
}

export interface OrganizerCode {
  id: number;
  code: string;
  critical: boolean;
  criticality: string;
}

export interface SubmissionItem {
  parameter_code: string;
  location: string;
  pd_value: string | null;
  rd_value: string | null;
  id_value: string | null;
  violation_label: ViolationLabel;
  protocol_status: ProtocolStatus;
  criticality: string | null;
  evidence: Array<{ stage: "PD" | "RD" | "ID"; file_id: string; pdf_page_number: number }>;
}

/** Выгрузка не отдаётся: статус без соответствия (5.1.4) или ответ не проходит схему (5.1.5). */
export class SubmissionRefused extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
  }
}

const STAGES = ["PD", "RD", "ID"] as const;
const VIOLATION: { violation_label: ViolationLabel } = { violation_label: "VIOLATION_PRESENT" };
const IMPOSSIBLE = { violation_label: "COMPARISON_IMPOSSIBLE", protocol_status: "COMPARISON_IMPOSSIBLE" } as const;

/**
 * OS-INSP-5.1.4: ровно одна метка и один статус протокола на запись. Решение инспектора старше результата системы.
 * null — запись в ответ не входит (неприменимо); неизвестный статус — отказ выгрузки с его названием.
 */
export function answerLabel(c: SubmissionCheck, critical: boolean): { violation_label: ViolationLabel; protocol_status: ProtocolStatus } | null {
  const severity: ProtocolStatus = critical ? "CRITICAL" : "WARNING";
  switch (c.verification_status) {
    case "CONFIRMED_VIOLATION":
      return { ...VIOLATION, protocol_status: severity };
    case "NEGATIVE_VERIFIED":
      return { violation_label: "NO_VIOLATION", protocol_status: "OK" };
    case "CLARIFICATION_REQUIRED":
      return { ...IMPOSSIBLE };
    case "PENDING":
      break;
    default:
      throw new SubmissionRefused("verification_status", `Решение инспектора «${c.verification_status}» не имеет метки в схеме организатора`);
  }
  switch (c.finding_status) {
    case "CANDIDATE":
      return { ...VIOLATION, protocol_status: severity };
    case "NEGATIVE_VERIFIED":
      return { violation_label: "NO_VIOLATION", protocol_status: "OK" };
    case "MISSING_EVIDENCE": {
      const have = new Set(c.fragments.map((f) => f.stage));
      const missing = STAGES.find((s) => !have.has(s)) ?? "ID";
      return { violation_label: "MISSING_DOCUMENT", protocol_status: `${missing}_MISSING` as ProtocolStatus };
    }
    case "NOT_COMPARABLE":
    case "CLARIFICATION_REQUIRED":
      return { ...IMPOSSIBLE };
    case "NOT_APPLICABLE":
      return null;
    default:
      throw new SubmissionRefused("finding_status", `Статус сверки «${c.finding_status}» не имеет метки в схеме организатора`);
  }
}

/** Участок (раздел 2 и земельный участок) — место SITE; всё остальное относится к зданию. */
const SITE_SECTIONS = new Set(["СПЗУ", "ЗУ"]);

/** OS-INSP-5.1.3: ответ по одному объекту — код параметра организатора, место, значения ПД/РД/ИД, метка, статус, доказательства. */
export function buildSubmission(p: { object_id: string; checks: SubmissionCheck[]; codes: OrganizerCode[]; files: Record<string, string> }): {
  object_id: string;
  checks: SubmissionItem[];
} {
  const byId = new Map(p.codes.map((c) => [c.id, c]));
  const out: SubmissionItem[] = [];
  for (const c of p.checks) {
    if (c.parent_id) continue; // части разделённого кандидата — отчёт по параметру, а не по фрагменту
    const m = /^M-(\d{3})$/.exec(c.param_code);
    const free = /^SUSP-\d+$/.test(c.param_code);
    if (!m && !free) continue; // реквизиты REQ-* и прочее вне Матрицы
    if (free && c.verification_status !== "CONFIRMED_VIOLATION") continue;
    const org = m ? byId.get(Number(m[1])) : undefined;
    if (m && !org) throw new SubmissionRefused("parameter_code", `Параметр ${c.param_code} не найден в каталоге организатора`);
    const label = answerLabel(c, org?.critical ?? false);
    if (!label) continue;
    const value = (stage: string) => c.fragments.find((f) => f.stage === stage && f.value !== null)?.value ?? null;
    out.push({
      parameter_code: org ? org.code : `FREE-${c.param_code}`,
      location: SITE_SECTIONS.has(c.section ?? "") ? "SITE" : "BUILDING",
      pd_value: value("PD"),
      rd_value: value("RD"),
      id_value: value("ID"),
      ...label,
      criticality: org?.criticality ?? null,
      evidence: c.fragments
        .filter((f): f is SubmissionFragment & { page: number } => (STAGES as readonly string[]).includes(f.stage) && f.page !== null && f.page >= 1)
        .map((f) => ({ stage: f.stage as "PD" | "RD" | "ID", file_id: p.files[f.file_id] ?? f.file_id, pdf_page_number: f.page })),
    });
  }
  return { object_id: p.object_id, checks: out };
}

const compiled = new WeakMap<object, ReturnType<Ajv2020["compile"]>>();

/** OS-INSP-5.1.5: сверка с самой схемой организатора; поле — путь JSON Pointer до нарушенного места. */
export function validateSubmission(sub: unknown, schema: object): Array<{ field: string; message: string }> {
  let v = compiled.get(schema);
  if (!v) {
    v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    compiled.set(schema, v);
  }
  if (v(sub)) return [];
  return (v.errors ?? []).map((e: ErrorObject) => ({
    field: e.keyword === "required" ? `${e.instancePath}/${(e.params as { missingProperty: string }).missingProperty}` : e.instancePath,
    message: e.message ?? e.keyword,
  }));
}
