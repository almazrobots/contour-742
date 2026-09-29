// OS-INSP-3.3 Выпустить версию протокола: разделы по ТЗ 9.2 п.4 и карточки доказательств.
import { aiUsageRecord } from "./ai-usage.ts";
import type { ApprovedChange } from "./changes.ts";
import { SCENARIO_RU } from "./completeness.ts";
import type { Scenario } from "./types.ts";
import type { ocrQuality } from "./ocr-quality.ts";

type OcrQuality = ReturnType<typeof ocrQuality>;

export interface CheckRow {
  id: string;
  param_code: string;
  parameter_name: string;
  section: string;
  unit: string;
  evidence_group_id: string;
  finding_status: string;
  verification_status: string;
  expected_value: string | null;
  actual_value: string | null;
  delta: string | null;
  provenance_json?: string | null; // T-129: provenance доказательной группы (OS-INSP-3.1.15)
  about_param?: string | null; // T-130: параметр кандидата или гипотезы о нём (OS-INSP-4.1.17)
  review_priority: string;
  reason: string | null;
  parent_id: string | null;
  title: string | null;
  fragments: FragmentRow[];
  decision: { user_id: string; user_name: string; action: string; reason_code: string | null; comment: string | null; created_at: string } | null;
  /** OS-INSP-3.1.9: согласованные изменения, затрагивающие параметр. */
  approved_changes?: ApprovedChange[];
  /** T-177: след слоя L8 (проверки, понижения, причина), ссылка CMP-29 и корень каскада VER-12. */
  l8_json?: string | null;
  approved_change_ref?: string | null;
  derived_from?: string | null;
  /** ТЗ §10 Checks.completeness_status (T-234): колонка, вычисляемая базой из finding_status (миграция 0015). */
  completeness_status?: string | null;
}

export interface FragmentRow {
  pipeline_run_id?: string | null;
  file_id: string;
  sha256: string;
  stage: string;
  document_code: string;
  revision: string;
  approval_status: string | null;
  sheet_page: number | null;
  bbox_polygon_norm: string | null;
  extracted_value: string | null;
  role_expected_actual: string;
  /** OS-INSP-1.2.10: номер части и смещение страниц, если файл — часть большого документа. */
  part_index?: number | null;
  page_offset?: number | null;
}

export interface ProtocolInput {
  inspection: { id: string; object_id: string; status: string; scenario: Scenario | null; load_codes: string[] };
  object: { id: string; name: string; address: string | null; permit_number: string | null };
  versions: { protocol: number; matrix: string; model: string; dataset: string; input_manifest_hash: string };
  files: Array<{ file_id: string; file_name: string; sha256: string; doc_stage: string; document_code: string; revision: string; approval_status: string | null; revision_role: string | null; engine?: string | null; parse_status?: string | null }>;
  checks: CheckRow[];
  suspicions: Array<Record<string, unknown>>;
  generated_at: string;
  /** OS-INSP-2.1.16: доля нечитаемых зон и покрываемость распознанным текстом — по файлам и итог (ТЗ 9.1.1). */
  ocr_quality?: OcrQuality | null;
}

const COMPLETENESS = new Set(["MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"]);

/** ТЗ §10 Checks.completeness_status (T-234, ТЗ 9.2 п. 4 «раздельные статусы комплектности и findings»). */
export const COMPLETENESS_STATUSES = ["COMPLETE", "MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"] as const;
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];

/**
 * Статус комплектности доказательной группы: COMPLETE — доказательств хватило для предметного сравнения (CANDIDATE,
 * NEGATIVE_VERIFIED), иначе — причина, по которой сравнение не выполнено. Эталон генерируемой колонки
 * checks.completeness_status (миграция 0015): тест сверяет базу с этой функцией по всем статусам.
 */
export function completenessStatus(findingStatus: string): CompletenessStatus {
  return COMPLETENESS.has(findingStatus) ? (findingStatus as CompletenessStatus) : "COMPLETE";
}

/** Статус комплектности записи: из колонки базы (T-234), для строк без неё — по правилу completenessStatus. */
export const completenessOf = (c: Pick<CheckRow, "finding_status" | "completeness_status">): CompletenessStatus =>
  (c.completeness_status as CompletenessStatus | null | undefined) ?? completenessStatus(c.finding_status);

/** Карточка доказательства (ТЗ 9.2 п.4): finding_id, код, expected/actual, источники с хешами, обоснование, риск, решение. */
export function evidenceCard(c: CheckRow) {
  return {
    finding_id: c.id,
    evidence_group_id: c.evidence_group_id,
    param_code: c.param_code,
    parameter_name: c.parameter_name,
    expected: c.expected_value,
    actual: c.actual_value,
    delta: c.delta,
    unit: c.unit,
    sources: c.fragments.map((f) => ({
      role: f.role_expected_actual,
      file_id: f.file_id,
      sha256: f.sha256,
      stage: f.stage,
      document_code: f.document_code,
      revision: f.revision,
      approval_status: f.approval_status,
      // сквозная страница документа из частей (OS-INSP-1.2.10); page_in_file — для просмотра файла части
      page: f.sheet_page === null ? null : f.sheet_page + (f.page_offset ?? 0),
      page_in_file: f.sheet_page,
      part_index: f.part_index ?? null,
      bbox: f.bbox_polygon_norm ? JSON.parse(f.bbox_polygon_norm) : null,
      value: f.extracted_value,
      ...(f.pipeline_run_id ? { pipeline_run_id: f.pipeline_run_id,
        trace_url: `/api/v1/files/${encodeURIComponent(f.file_id)}/runs/${encodeURIComponent(f.pipeline_run_id)}/trace?page=${f.sheet_page ?? 1}` } : {}),
    })),
    rationale: c.reason,
    review_priority: c.review_priority,
    inspector_decision: c.verification_status,
    decision: c.decision,
    // OS-INSP-3.1.15 (DEC-01): операции каталога и все найденные упоминания стадий — у параметров с паспортом (T-129)
    provenance: c.provenance_json ? JSON.parse(c.provenance_json) : null,
    approved_changes: (c.approved_changes ?? []).map((a) => ({ number: a.number, date: a.date, param_codes: a.param_codes, basis_file_id: a.basis_file_id, basis_file_name: a.basis_file_name, description: a.description })),
    // T-177 (CMP-29, VER-12, DEC-01): ссылка на изменение («NONE» — искали, не нашли), корень каскада, след проверок L8
    approved_change_ref: c.approved_change_ref ?? null,
    derived_from: c.derived_from ?? null,
    verification: c.l8_json ? JSON.parse(c.l8_json) : null,
  };
}

export function buildProtocol(p: ProtocolInput) {
  const base = buildProtocolBody(p);
  // OS-INSP-5.1.2: запись о применении ИИ-средства для акта (2078-ПП п. 9(1).8); хеш — от протокола без неё
  return {
    ...base,
    ai_usage: aiUsageRecord({
      process_id: p.inspection.id,
      object_name: p.object?.name ?? p.inspection.object_id,
      generated_at: p.generated_at,
      versions: p.versions,
      files: p.files,
      checks: p.checks,
      protocol_body: base,
    }),
  };
}

function buildProtocolBody(p: ProtocolInput) {
  const main = p.checks;
  const candidates = main.filter((c) => c.finding_status === "CANDIDATE" && (c.verification_status === "PENDING" || c.verification_status === "CLARIFICATION_REQUIRED"));
  const confirmed = main.filter((c) => c.verification_status === "CONFIRMED_VIOLATION");
  const negatives = main.filter((c) => c.finding_status === "NEGATIVE_VERIFIED" || c.verification_status === "NEGATIVE_VERIFIED");
  // раздел 1 «комплектность и сопоставимость» — по статусу комплектности (ТЗ §10 Checks.completeness_status, T-234)
  const completeness = main.filter((c) => completenessOf(c) !== "COMPLETE" && c.verification_status === "PENDING");
  return {
    protocol_version: p.versions.protocol,
    process_id: p.inspection.id,
    generated_at: p.generated_at,
    object: p.object,
    versions: {
      matrix_version: p.versions.matrix,
      model_version: p.versions.model,
      dataset_version: p.versions.dataset,
      input_manifest_hash: p.versions.input_manifest_hash,
    },
    status: p.inspection.status,
    upload_status: p.inspection.load_codes,
    check_type: { scenario: p.inspection.scenario, title: p.inspection.scenario ? SCENARIO_RU[p.inspection.scenario] : null },
    input_files: p.files,
    // OS-INSP-2.1.16 (ТЗ 9.1.1): доля нечитаемых зон и покрываемость — отчётно, по файлам и итог по проверке
    ocr_quality: p.ocr_quality ?? null,
    summary: {
      parameters: main.length,
      candidates: candidates.length,
      confirmed_violations: confirmed.length,
      negative_verified: negatives.length,
      missing_evidence: main.filter((c) => c.finding_status === "MISSING_EVIDENCE").length,
      not_applicable: main.filter((c) => c.finding_status === "NOT_APPLICABLE").length,
      not_comparable: main.filter((c) => c.finding_status === "NOT_COMPARABLE").length,
      clarification_required: main.filter((c) => c.finding_status === "CLARIFICATION_REQUIRED" || c.verification_status === "CLARIFICATION_REQUIRED").length,
      suspicions: p.suspicions.length,
    },
    sections: {
      completeness: completeness.map((c) => ({ param_code: c.param_code, parameter_name: c.parameter_name, status: c.finding_status, reason: c.reason })),
      candidates: candidates.map(evidenceCard),
      confirmed_violations: confirmed.map(evidenceCard),
      negative_verified: negatives.map((c) => ({ param_code: c.param_code, parameter_name: c.parameter_name, expected: c.expected_value, actual: c.actual_value, by: c.verification_status === "NEGATIVE_VERIFIED" ? "inspector" : "system", reason: c.decision?.reason_code ?? c.reason })),
      suspicions: p.suspicions,
      missing_evidence: main.filter((c) => c.finding_status === "MISSING_EVIDENCE").map((c) => ({ param_code: c.param_code, parameter_name: c.parameter_name, reason: c.reason })),
    },
  };
}

export type Protocol = ReturnType<typeof buildProtocol>;
