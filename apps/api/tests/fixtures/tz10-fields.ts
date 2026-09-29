// ТЗ §10 «Таблицы базы данных (сводка)»: 16 таблиц, 128 ключевых полей → таблица и колонка схемы (T-234).
// Источник полей — data/seed/tz-fulltext.json, стр. 26–27, блоки 291–308. Имя в схеме отличается от ТЗ только там,
// где это записано в ER-модели (docs/architecture/C4-и-модель-БД.md §5.0): file_hash → sha256, violation_id → check_id,
// rejection_reason → reason_code, condition/expected → *_json. ML_Retraining_Log — представление над model_versions (ADR-0011).
export interface TzTable {
  tz: string;
  table: string;
  fields: Array<[tzField: string, column: string]>;
}

const same = (...xs: string[]): Array<[string, string]> => xs.map((x) => [x, x]);

export const TZ10: TzTable[] = [
  { tz: "Params", table: "params", fields: same("id", "code", "parameter_name", "source_pd", "source_rd", "source_id", "sp_reference", "gost_reference", "fz_reference") },
  { tz: "Checks", table: "checks", fields: same("id", "param_id", "object_id", "expected_value", "actual_value", "completeness_status", "finding_status", "review_priority", "evidence_group_id") },
  { tz: "Objects", table: "objects", fields: same("id", "name", "address", "customer", "contractor", "permit_number") },
  {
    tz: "Files", table: "files",
    fields: [...same("id", "object_id", "doc_stage", "discipline", "document_code", "revision", "approval_status", "approval_date", "predecessor_id"), ["file_hash", "sha256"], ...same("file_path", "uploaded_at")],
  },
  { tz: "Protocols", table: "protocols", fields: same("id", "object_id", "version", "matrix_version", "dataset_version", "model_version", "input_manifest_hash", "status", "created_at", "finalized_at") },
  { tz: "Rejection_Log", table: "rejection_log", fields: [["id", "id"], ["violation_id", "check_id"], ["rejection_reason", "reason_code"], ...same("ai_verdict", "suggested_fix", "retraining_status")] },
  { tz: "Dispute_Log", table: "dispute_log", fields: [["id", "id"], ["violation_id", "check_id"], ...same("inspector_comment", "ai_comment", "resolution_status", "resolved_by")] },
  { tz: "Suspicions", table: "suspicions", fields: same("id", "object_id", "discovery_method", "confidence", "description", "inspector_status") },
  { tz: "Logical_Rules", table: "logical_rules", fields: [...same("id", "rule_name"), ["condition", "condition_json"], ["expected", "expected_json"], ...same("normative_base", "is_active")] },
  { tz: "Normative_Base", table: "normative_base", fields: same("id", "document_name", "document_number", "section", "parameter_name", "min_value", "max_value", "effective_from", "effective_to") },
  {
    tz: "ML_Retraining_Log", table: "ml_retraining_log",
    fields: same("id", "model_version", "dataset_version", "split_hashes", "precision", "recall", "f1", "false_positive_rate", "per_category_metrics", "approval_status", "approved_by"),
  },
  { tz: "Audit_Log", table: "audit_log", fields: same("id", "user_id", "action", "object_id", "details", "timestamp", "ip_address", "user_agent") },
  { tz: "Monitoring_Metrics", table: "monitoring_metrics", fields: same("id", "metric_name", "value", "timestamp", "service_name", "tags") },
  { tz: "Evidence_Fragments", table: "evidence_fragments", fields: same("id", "evidence_group_id", "file_id", "stage", "sheet_page", "bbox_polygon_norm", "extracted_value", "role_expected_actual") },
  { tz: "Dataset_Items", table: "dataset_items", fields: same("id", "evidence_group_id", "gold_label", "expert_id", "reason_code", "dataset_version", "split", "object_group_id") },
  { tz: "Model_Versions", table: "model_versions", fields: same("model_version", "artifact_hash", "dataset_version", "metrics_json", "approval_status", "approved_by", "deployed_at", "rollback_to") },
];
