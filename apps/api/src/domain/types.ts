// Словарь статусов — дословно из ТЗ (§9.1, §9.2, §9.3). Коды не переводятся: они уходят во внешнюю ИС.

export const STAGES = ["PD", "RD", "ID"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_RU: Record<Stage, string> = { PD: "ПД", RD: "РД", ID: "ИД" };

/** Статус утверждения документа из реестра файлов (Перечень ИД, ред. 1.1). */
export type ApprovalStatus = "DRAFT" | "APPROVED" | "FOR_CONSTRUCTION" | "SUPERSEDED" | "CANCELLED";

/** Роль файла после выбора актуальных редакций (OS-INSP-1.3). */
export type RevisionRole = "CURRENT" | "SUPERSEDED" | "CONFLICT" | "UNRESOLVED";

/** Статус загрузки стадии (ТЗ 9.1): PD_UPLOADED, RD_PARTIAL, ID_MISSING … */
export type StageLoad = "UPLOADED" | "PARTIAL" | "MISSING";

export type Scenario = "FULL" | "PD_RD_ONLY" | "PD_ID_ONLY" | "RD_ID_ONLY" | "SINGLE_ONLY" | "PARTIALLY_LOADED" | "NO_DOCUMENTS";

/** Статус процесса проверки (ТЗ 9.1). COMPLETED = верификация завершена, протокол не финализирован. */
export type ProcessStatus = "PENDING" | "PARSING" | "READY" | "VERIFYING" | "COMPLETED" | "FINALIZED";

/** Статус параметра в протоколе, присваиваемый системой (ТЗ 9.2). CONFIRMED_VIOLATION система не ставит никогда. */
export type FindingStatus =
  | "NEGATIVE_VERIFIED"
  | "CANDIDATE"
  | "MISSING_EVIDENCE"
  | "NOT_APPLICABLE"
  | "NOT_COMPARABLE"
  | "CLARIFICATION_REQUIRED";

/** Статус верификации — решение инспектора (ТЗ 9.3). */
export type VerificationStatus = "PENDING" | "CONFIRMED_VIOLATION" | "NEGATIVE_VERIFIED" | "CLARIFICATION_REQUIRED";

/** Кодированные причины отклонения (ТЗ 9.3 п.2). */
export const REASON_CODES = {
  WRONG_REVISION: "Актуальная редакция выбрана неверно",
  APPROVED_CHANGE: "Есть согласованное изменение",
  OCR_ERROR: "Ошибка распознавания",
  BINDING_ERROR: "Ошибка привязки фрагмента",
  NOT_APPLICABLE: "Параметр неприменим к объекту",
  WITHIN_TOLERANCE: "Расхождение в пределах допуска",
} as const;
export type ReasonCode = keyof typeof REASON_CODES;
/** OS-INSP-4.1.23: причина — только собственный ключ справочника; `in` видит прототип («constructor», «toString»). */
export function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === "string" && Object.hasOwn(REASON_CODES, x);
}

// system — служебный актор без учётки и сессии (напр. system:rin, автозабор из «РиН»): войти им нельзя.
export type Role = "inspector" | "supervisor" | "admin" | "ml_engineer" | "curator" | "verifier" | "system";

export type CompareRule =
  | { kind: "equal" }
  | { kind: "delta_pct"; tolerance: number }
  | { kind: "decrease" }
  | { kind: "increase" }
  | { kind: "min"; min: number }
  | { kind: "max"; max: number };

export interface Param {
  code: string;
  section: string;
  parameter_name: string;
  unit: string;
  source_pd: string | null;
  source_rd: string | null;
  source_id: string | null;
  trigger_logic: string;
  review_priority: string;
  data_type: "number" | "string" | "enum" | "boolean" | "coordinate";
  compare: CompareRule;
  anchors: string[];
  regex_pattern: string | null;
  value_scale: string[] | "numeric_suffix" | "pressure_class" | null; // pressure_class — PN труб (М-072, OS-INSP-3.1.25)
  applicability: string | null;
  sp_reference?: string | null;
  is_active: boolean;
}

/** Ссылка на источник значения: из неё собирается карточка доказательства. */
export interface SourceRef {
  file_id: string;
  sha256: string;
  stage: Stage;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  page: number;
  bbox: [number, number, number, number] | null;
  role: RevisionRole;
}

export interface StageValue {
  stage: Stage;
  num: number | null;
  text: string | null;
  raw: string;
  source: SourceRef;
}

export interface Fragment extends SourceRef {
  value: string;
  kind: "expected" | "actual";
}

export interface Evaluation {
  status: FindingStatus;
  // Set only by a server-side passport operator, never copied from ML metadata.
  expected_basis?: { kind: "norm"; reference: string };
  expected: string | null;
  actual: string | null;
  delta: string | null;
  reason: string;
  fragments: Fragment[];
  stage_notes: Partial<Record<Stage, "USED" | "NOT_APPLICABLE" | "NO_VALUE">>;
}
