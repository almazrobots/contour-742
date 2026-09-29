// OpenAPI 3.0 (ТЗ 1.3). Схема отдаётся на /api/v1/openapi.json; контракт с ИАИС «РиН» — эндпоинты ТЗ 9.6.
import { annotationSchemas, annotationPaths } from "./verification-openapi.ts";
import { REASON_CODES } from "./domain/types.ts";
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
const err = { description: "Ошибка", ...json(ref("Error")) };
// T-129 (NFR-API-VALIDATE): краткие записи для описания маршрутов. Строки БД целиком описываются ключевыми полями
// без additionalProperties: false — новая колонка миграции не должна ронять ответ валидатором.
const ok = (description: string, schema: unknown) => ({ description, ...json(schema) });
const arr = (items: unknown, extra: Record<string, unknown> = {}) => ({ type: "array", items, ...extra });
const obj = (required: string[], properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "object", required, properties, ...extra });
const S = { type: "string" };
const Sn = { type: "string", nullable: true };
const I = { type: "integer" };
// OS-INSP-4.1.23: перечень причин отклонения — из справочника, не копией (копия расходится молча)
const REASON = { type: "string", enum: Object.keys(REASON_CODES) };
const In = { type: "integer", nullable: true };
const N = { type: "number" };
const Nn = { type: "number", nullable: true };
const B = { type: "boolean" };
const pathParam = (name: string, schema: unknown = S) => ({ name, in: "path", required: true, schema });
const query = (name: string, schema: unknown, required = false) => ({ name, in: "query", ...(required ? { required: true } : {}), schema });
// M-2: limit/offset списочных маршрутов (domain/security.ts pageQuery: потолок PAGE_MAX = 500)
const page = (limit: number) => [query("limit", { type: "integer", minimum: 1, maximum: 500, default: limit }), query("offset", { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 })];
const PROCESS_STATUS = ["PENDING", "PARSING", "READY", "VERIFYING", "COMPLETED", "FINALIZED"];
// T-166: голова объекта — общая для карточки и строки реестра (строка реестра — плоская схема: allOf не закрыть)
const OBJECT_HEAD_REQUIRED = ["id", "name", "address", "synthetic", "created_at"] as const;
const OBJECT_HEAD_PROPS = { id: { type: "string" }, name: { type: "string" }, address: { type: "string" }, synthetic: { type: "boolean" }, created_at: { type: "string" } };
const PRESCRIPTION_STATUS = ["ISSUED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXTENDED"];
const Cond = obj(["key", "op", "value"], { key: S, op: { type: "string", enum: [">", ">=", "<", "<=", "==", "!="] }, value: N });

export const openapi = {
  openapi: "3.0.3",
  info: { title: "Инспектор ИИ — API", version: "0.1.0", description: "Сверка ПД/РД/ИД по 132 параметрам Матрицы. Асинхронная pull-модель: загрузка → process_id → статус → протокол." },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    schemas: {
      ...annotationSchemas,
      Error: { type: "object", properties: { error: { type: "string" }, details: {} }, required: ["error"] },
      // T-129: паспорт параметра (OS-INSP-7.1.3–7.1.6) и автоматическая верификация (OS-INSP-6.5.8, 6.5.9)
      PassportStage: {
        type: "object", additionalProperties: false, required: ["key", "n", "title", "ops", "how", "fail", "param_specific"],
        properties: { key: { type: "string" }, n: { type: "string" }, title: { type: "string" }, how: { type: "string" }, fail: { type: "string" }, param_specific: { type: "boolean" },
          ops: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title"], properties: { id: { type: "string", pattern: "^[A-Z]{2,3}-\\d{2}$" }, title: { type: "string" } } } } },
      },
      PassportMetric: {
        type: "object", additionalProperties: false, required: ["key", "title", "how", "value"],
        properties: { key: { type: "string" }, title: { type: "string" }, how: { type: "string" }, value: { type: "string" },
          rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } } } },
      },
      VerificationField: { type: "object", additionalProperties: false, required: ["field", "system", "oracle"], properties: { field: { type: "string", minLength: 1 }, system: { type: "string", nullable: true }, oracle: { type: "string", nullable: true }, ok: { type: "boolean", description: "мнение клиента — сервер его не учитывает, совпадение считает сам" }, equivalent: { type: "boolean", description: "только для полей *.evidence: оракул нашёл равноценное доказательство (то же значение и раздел на той же странице)" } } },
      Verification: {
        type: "object", additionalProperties: false, required: ["verdict", "object_id", "inspection_id", "method", "checked_at", "fields"],
        properties: { verdict: { type: "string", enum: ["MATCH", "MISMATCH"] }, object_id: { type: "string", nullable: true }, inspection_id: { type: "string", nullable: true }, method: { type: "string" }, checked_at: { type: "string", format: "date-time" }, fields: { type: "array", items: ref("VerificationField") } },
      },
      Passport: {
        type: "object", additionalProperties: false, required: ["code", "param", "passport", "stages", "statuses", "metrics", "verification"],
        properties: {
          code: { type: "string", pattern: "^M-\\d{3}$" },
          param: { type: "object", required: ["code", "parameter_name", "section", "compare", "anchors"], properties: { code: { type: "string" }, parameter_name: { type: "string" }, section: { type: "string" }, compare: { type: "object", required: ["kind"], properties: { kind: { type: "string" } } }, anchors: { type: "array", items: { type: "string" } }, value_scale: { nullable: true } } },
          passport: {
            type: "object", nullable: true, additionalProperties: false, required: ["version", "title", "summary", "basis", "value", "sources", "link", "outcomes"],
            properties: {
              version: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, basis: { type: "string" },
              // T-132: порядковая шкала (М-023) или количество с единицей и допуском (М-001)
              value: {
                oneOf: [
                  { type: "object", required: ["kind", "scale"], properties: { kind: { type: "string", enum: ["ordinal"] }, scale: { type: "array", items: { type: "string" }, minItems: 2 }, order_note: { type: "string" }, constraint_markers: { type: "array", items: { type: "string" } } } },
                  { type: "object", required: ["kind", "unit", "tolerance_abs"], properties: { kind: { type: "string", enum: ["quantity"] }, unit: { type: "string" }, tolerance_abs: { type: "number", minimum: 0 }, tolerance_note: { type: "string" } } },
                  // T-175 (CMP-07): счётный параметр — целые без допуска
                  { type: "object", required: ["kind", "unit"], properties: { kind: { type: "string", enum: ["count"] }, unit: { type: "string" }, count_note: { type: "string" } } },
                  // T-175 (CMP-08, CMP-11): состав по типам — допуск доли в процентных пунктах
                  { type: "object", required: ["kind", "tolerance_pp"], properties: { kind: { type: "string", enum: ["composition"] }, tolerance_pp: { type: "number", minimum: 0 }, composition_note: { type: "string" } } },
                  // T-214: направление открывания эвакуационных дверей (М-043, М-106): наружу / внутрь, норма CMP-06
                  { type: "object", required: ["kind", "values", "order_note"], properties: { kind: { type: "string", enum: ["direction"] }, values: { type: "array", items: { type: "string", enum: ["outward", "inward"] } }, order_note: { type: "string" }, norm: { type: "object", required: ["basis"], properties: { basis: { type: "string" } } } } },
                  // T-213: календарный график (М-082, М-087) и перечень документов ИД (М-096)
                  { type: "object", required: ["kind", "tolerance_pct", "checks"], properties: { kind: { type: "string", enum: ["schedule"] }, tolerance_pct: { type: "number", minimum: 0 }, checks: { type: "array", items: { type: "string", enum: ["duration", "order", "technology"] } }, critical: { type: "array", items: { type: "string" } }, technologies: { type: "array", items: { type: "object" } }, tolerance_note: { type: "string" } } },
                  { type: "object", required: ["kind", "docs", "sections"], properties: { kind: { type: "string", enum: ["doc_requirements"] }, docs: { type: "array", items: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" }, pattern: { type: "string" } } } }, sections: { type: "boolean" } } },
                  // T-176: марка или материал по семейству справочника аналогов (CMP-05) и послойный состав (CMP-21)
                  { type: "object", required: ["kind", "family"], properties: { kind: { type: "string", enum: ["category"] }, family: { type: "string" }, items: { type: "object", nullable: true, additionalProperties: { type: "string" } }, elements: { type: "object", nullable: true, additionalProperties: { type: "string" } }, note: { type: "string" } } },
                  { type: "object", required: ["kind", "family", "tol_mm"], properties: { kind: { type: "string", enum: ["layers"] }, family: { type: "string" }, tol_mm: { type: "number", minimum: 0 }, order: { type: "string" }, note: { type: "string" } } },
                ],
              },
              sources: { type: "object", required: ["PD", "RD", "ID"], properties: Object.fromEntries(["PD", "RD", "ID"].map((k) => [k, { type: "array", items: { type: "object", required: ["discipline"], properties: { discipline: { type: "string" }, label: { type: "string" } } } }])) },
              link: { type: "object", required: ["by", "note"], properties: { by: { type: "string", enum: ["base_cipher", "none"] }, note: { type: "string" } } },
              outcomes: { type: "array", items: { type: "object", additionalProperties: false, required: ["when", "status", "why"], properties: { when: { type: "string" }, status: { type: "string" }, why: { type: "string" } } } },
            },
          },
          stages: { type: "array", minItems: 1, items: ref("PassportStage") },
          statuses: { type: "object", additionalProperties: { type: "string" } },
          metrics: { type: "array", minItems: 1, items: ref("PassportMetric") },
          verification: { ...ref("Verification"), nullable: true },
        },
      },
      // T-166 (OS-INSP-8.1.3–8.1.7): раздел «Объекты» — реестр и карточка объекта, строка ключевого параметра по стадиям
      StageFiles: { type: "object", additionalProperties: false, required: ["PD", "RD", "ID"], properties: { PD: { type: "integer", minimum: 0 }, RD: { type: "integer", minimum: 0 }, ID: { type: "integer", minimum: 0 } } },
      KeyParamInfo: { type: "object", additionalProperties: false, required: ["code", "name"], properties: { code: { type: "string", pattern: "^M-\\d{3}$" }, name: { type: "string" } } },
      KeyParamRow: {
        type: "object", additionalProperties: false,
        required: ["code", "checked", "inspection_id", "check_id", "finding_status", "verification_status", "decision", "auto_check", "stages"],
        properties: {
          code: { type: "string" }, checked: { type: "boolean" }, inspection_id: { type: "string", nullable: true }, check_id: { type: "string", nullable: true },
          finding_status: { type: "string", nullable: true, description: "итог сверки системы (ТЗ 9.2)" },
          verification_status: { type: "string", nullable: true, description: "решение инспектора (ТЗ 9.3)" },
          decision: { type: "object", nullable: true, additionalProperties: false, required: ["status", "by", "at"], properties: { status: { type: "string" }, by: { type: "string", nullable: true }, at: { type: "string" } } },
          auto_check: { type: "object", nullable: true, additionalProperties: false, required: ["verdict", "method", "checked_at"], properties: { verdict: { type: "string", enum: ["MATCH", "MISMATCH"] }, method: { type: "string" }, checked_at: { type: "string" } } },
          stages: {
            type: "array", minItems: 3, maxItems: 3,
            items: {
              type: "object", additionalProperties: false, required: ["stage", "state", "value", "document_code", "page"],
              properties: {
                stage: { type: "string", enum: ["PD", "RD", "ID"] },
                state: { type: "string", enum: ["VALUE", "NO_VALUE", "NOT_LOADED", "NOT_REQUIRED", "NOT_CHECKED"], description: "VALUE — значение найдено; NO_VALUE — в стадии значение не найдено; NOT_LOADED — стадия не загружена; NOT_REQUIRED — параметр стадию не требует; NOT_CHECKED — параметр не проверялся" },
                value: { type: "string", nullable: true }, document_code: { type: "string", nullable: true }, page: { type: "integer", nullable: true },
              },
            },
          },
        },
      },
      // OWASP-0164 (API3 BOPLA): схемы объекта закрыты — лишнее поле выборки (застройщик, подрядчик, профиль) роняет ответ валидатором
      ObjectHead: { type: "object", additionalProperties: false, required: [...OBJECT_HEAD_REQUIRED], properties: OBJECT_HEAD_PROPS },
      ObjectList: {
        type: "object", additionalProperties: false, required: ["key_params", "objects"],
        properties: {
          key_params: { type: "array", items: ref("KeyParamInfo") },
          objects: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: [...OBJECT_HEAD_REQUIRED, "stage_files", "inspections_count", "last_inspection", "key_param_rows"],
              properties: {
                ...OBJECT_HEAD_PROPS,
                stage_files: ref("StageFiles"), inspections_count: { type: "integer", minimum: 0 },
                last_inspection: { type: "object", nullable: true, additionalProperties: false, required: ["id", "status", "updated_at"], properties: { id: { type: "string" }, status: { type: "string", enum: PROCESS_STATUS }, updated_at: { type: "string" } } },
                key_param_rows: { type: "array", items: ref("KeyParamRow") },
              },
            },
          },
        },
      },
      ObjectDoc: {
        type: "object", additionalProperties: false, required: ["id", "file_name", "sha256", "doc_stage", "document_code", "revision", "inspection_id", "uploaded_at"],
        properties: { id: { type: "string" }, file_name: { type: "string" }, sha256: { type: "string" }, doc_stage: { type: "string", enum: ["PD", "RD", "ID"] }, document_code: { type: "string" }, revision: { type: "string" }, doc_title: { type: "string", nullable: true }, revision_role: { type: "string", nullable: true }, inspection_id: { type: "string" }, uploaded_at: { type: "string" } },
      },
      ObjectCard: {
        type: "object", additionalProperties: false, required: ["key_params", "object", "stage_files", "documents", "inspections", "key_param_rows", "protocols"],
        properties: {
          key_params: { type: "array", items: ref("KeyParamInfo") },
          object: ref("ObjectHead"),
          stage_files: ref("StageFiles"),
          documents: { type: "object", additionalProperties: false, required: ["PD", "RD", "ID"], properties: Object.fromEntries(["PD", "RD", "ID"].map((k) => [k, { type: "array", items: ref("ObjectDoc") }])) },
          inspections: {
            type: "array", description: "журнал проверок объекта — вся история, последние первыми",
            items: { type: "object", additionalProperties: false, required: ["id", "status", "scenario", "protocol_version", "files", "created_at", "updated_at", "finalized_at"], properties: { id: { type: "string" }, status: { type: "string", enum: PROCESS_STATUS }, scenario: { type: "string", nullable: true }, protocol_version: { type: "integer" }, files: { type: "integer", minimum: 0 }, created_at: { type: "string" }, updated_at: { type: "string" }, finalized_at: { type: "string", nullable: true } } },
          },
          key_param_rows: { type: "array", items: ref("KeyParamRow") },
          // T-234 (ТЗ §10 Protocols.object_id): версии протоколов объекта по всем проверкам, новые первыми
          protocols: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["inspection_id", "version", "status", "created_at", "finalized_at"], properties: { inspection_id: { type: "string" }, version: { type: "integer" }, status: { type: "string", enum: ["DRAFT", "FINALIZED"] }, matrix_version: { type: "string", nullable: true }, model_version: { type: "string", nullable: true }, created_at: { type: "string" }, finalized_at: { type: "string", nullable: true } } },
          },
        },
      },
      VerificationInput: { type: "object", additionalProperties: false, required: ["inspection_id", "method", "fields"], properties: { inspection_id: { type: "string", minLength: 1 }, method: { type: "string", minLength: 1, maxLength: 200 }, fields: { type: "array", minItems: 1, items: ref("VerificationField") } } },
      VerificationResult: { type: "object", additionalProperties: false, required: ["param_code", "inspection_id", "object_id", "verdict", "checked_at", "mismatched"], properties: { param_code: { type: "string" }, inspection_id: { type: "string" }, object_id: { type: "string" }, verdict: { type: "string", enum: ["MATCH", "MISMATCH"] }, checked_at: { type: "string" }, mismatched: { type: "array", items: { type: "string" } } } },
      UploadResult: {
        type: "object",
        required: ["process_id", "accepted", "rejected", "status"],
        properties: {
          process_id: { type: "string" },
          status: { type: "string", enum: ["PENDING", "PARSING", "READY", "VERIFYING", "COMPLETED", "FINALIZED"] },
          accepted: { type: "array", items: { type: "object", properties: { file_id: { type: "string" }, file_name: { type: "string" }, sha256: { type: "string" }, doc_stage: { type: "string", enum: ["PD", "RD", "ID"] }, source: { type: "string", enum: ["upload", "server_import"], description: "Источник: интерактивная загрузка или серверный импорт (OS-INSP-1.2.36)" } } } },
          rejected: { type: "array", items: { type: "object", properties: { file_name: { type: "string" }, code: { type: "string", enum: ["UNSUPPORTED_FORMAT", "FILE_TOO_LARGE", "CORRUPTED", "DUPLICATE", "FILE_ID_EXISTS", "HASH_MISMATCH", "INFECTED", "SCAN_UNAVAILABLE", "SIGNATURE_WITHOUT_DOCUMENT", "STORAGE_UNAVAILABLE", "HIDDEN_TEST_LABELS", "EXCLUDED", "DUPLICATE_CONTENT", "IMPORT_NOT_FOUND", "IMPORT_TOO_LARGE", "IMPORT_HASH_MISMATCH", "IMPORT_NOT_ENCRYPTED"] }, message: { type: "string" }, duplicate_of: { type: "string" } } } },
          clarification: { type: "string" },
        },
      },
      Status: {
        type: "object",
        properties: {
          // scenario — null, пока пакет не загружен: сценарий определяет приём файлов (T-135: статус новой проверки отдавал 500)
          process_id: { type: "string" }, status: { type: "string" }, scenario: { type: "string", nullable: true, enum: ["FULL", "PD_RD_ONLY", "PD_ID_ONLY", "RD_ID_ONLY", "SINGLE_ONLY", "PARTIALLY_LOADED", "NO_DOCUMENTS", null] },
          upload_status: { type: "array", items: { type: "string", example: "PD_UPLOADED" } }, protocol_version: { type: "integer" }, sync_status: { type: "string", nullable: true },
          files: arr(obj(["id", "file_name", "doc_stage", "parse_status"], { id: S, file_name: S, doc_stage: S, parse_status: S, parse_error: Sn, revision_role: Sn, intake_source: { type: "string", enum: ["upload", "server_import"] } })),
        },
      },
      EvidenceCard: {
        type: "object",
        properties: {
          finding_id: { type: "string" }, evidence_group_id: { type: "string" }, param_code: { type: "string" }, expected: { type: "string", nullable: true }, actual: { type: "string", nullable: true }, delta: { type: "string", nullable: true },
          sources: { type: "array", items: { type: "object", properties: { role: { type: "string" }, file_id: { type: "string" }, sha256: { type: "string" }, stage: { type: "string" }, document_code: { type: "string" }, revision: { type: "string" }, approval_status: { type: "string" }, page: { type: "integer" }, bbox: { type: "array", nullable: true, items: { type: "number" }, minItems: 4, maxItems: 4, description: "null — у документа нет геометрии (DOCX, XML)" } } } },
          rationale: { type: "string" }, review_priority: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] }, inspector_decision: { type: "string" },
          provenance: {
            type: "object", nullable: true, required: ["ops", "mentions"], description: "OS-INSP-3.1.15: операции каталога TO-BE и все упоминания стадий (параметры с паспортом)",
            properties: {
              ops: { type: "array", items: { type: "string" } },
              mentions: { type: "array", items: { type: "object", required: ["stage", "use", "value", "file_id", "page"], properties: { stage: { type: "string", enum: ["PD", "RD", "ID"] }, use: { type: "string", enum: ["chosen", "considered", "reference", "dropped", "flagged"] }, why: { type: "string", nullable: true }, value: { type: "string" }, qualifier: { type: "string", nullable: true }, discipline: { type: "string", nullable: true }, document_code: { type: "string" }, file_id: { type: "string" }, page: { type: "integer" }, quote: { type: "string" } } } },
            },
          },
        },
      },
      Protocol: {
        type: "object",
        properties: {
          protocol_version: { type: "integer" }, process_id: { type: "string" }, versions: { type: "object", properties: { matrix_version: { type: "string" }, model_version: { type: "string" }, dataset_version: { type: "string" }, input_manifest_hash: { type: "string" } } },
          upload_status: { type: "array", items: { type: "string" } }, check_type: { type: "object" }, summary: { type: "object" },
          sections: { type: "object", properties: { completeness: { type: "array", items: { type: "object" } }, candidates: { type: "array", items: ref("EvidenceCard") }, confirmed_violations: { type: "array", items: ref("EvidenceCard") }, negative_verified: { type: "array", items: { type: "object" } }, suspicions: { type: "array", items: { type: "object" } } } },
        },
      },
      Decision: {
        oneOf: [
          { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["confirm"] }, comment: { type: "string" } } },
          { type: "object", required: ["action", "reason_code", "comment"], properties: { action: { type: "string", enum: ["reject"] }, reason_code: REASON, comment: { type: "string" } } },
          { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["clarify"] }, comment: { type: "string" } } },
        ],
      },
      // ─────────────── T-129: ответы маршрутов (NFR-API-VALIDATE). Колонки json читаются строкой (db-core parseJsonText).
      Ok: obj(["ok"], { ok: { type: "boolean", enum: [true] } }),
      Created: obj(["id"], { id: I }),
      User: obj(["id", "login", "name", "role"], { id: S, login: S, name: S, role: S }),
      Gate: obj(["ok", "reasons"], { ok: B, reasons: arr(S) }),
      SplitHashes: obj(["train", "validation", "test"], { train: S, validation: S, test: S }),
      AuditEntry: obj(["id", "action", "timestamp"], { id: I, user_id: Sn, action: S, object_id: Sn, details: Sn, timestamp: S, ip_address: Sn, user_agent: Sn, user_name: Sn, role: Sn }),
      EvidenceFragment: obj(["id", "check_id", "file_id"], {
        id: I, check_id: S, file_id: S, sha256: Sn, stage: Sn, document_code: Sn, revision: Sn, approval_status: Sn, sheet_page: In,
        bbox_polygon_norm: { type: "string", nullable: true, description: "JSON-текст полигона в долях страницы" }, extracted_value: Sn, role_expected_actual: Sn,
      }),
      // фрагмент в сокращённой выборке (соседи по общему корню, план выборки)
      FragmentRef: obj(["check_id", "file_id"], { check_id: S, file_id: S, stage: Sn, document_code: Sn, revision: Sn, sheet_page: In, bbox_polygon_norm: Sn, extracted_value: Sn, role_expected_actual: Sn }),
      ApprovedChange: obj(["id", "inspection_id", "object_id", "number", "date", "param_codes", "basis_file_id", "basis_file_name", "description", "created_by", "created_at"], {
        id: I, inspection_id: S, object_id: S, number: S, date: S, param_codes: arr(S), basis_file_id: Sn, basis_file_name: Sn, description: S, created_by: S, created_at: S,
      }),
      CheckRow: obj(["id", "param_code", "parameter_name", "section", "unit", "evidence_group_id", "finding_status", "verification_status", "fragments", "decision"], {
        id: S, param_code: S, parameter_name: S, section: S, unit: S, evidence_group_id: S, finding_status: S, verification_status: S,
        expected_value: Sn, actual_value: Sn, delta: Sn, review_priority: Sn, reason: Sn, parent_id: Sn, title: Sn,
        fragments: arr(ref("EvidenceFragment")),
        decision: obj(["user_id", "action", "created_at"], { user_id: S, user_name: Sn, action: S, reason_code: Sn, comment: Sn, created_at: S }, { nullable: true }),
        approved_changes: arr(ref("ApprovedChange")),
        // T-177: след слоя L8 (JSON), ссылка на согласованное изменение (CMP-29; NONE — искали, не нашли), корень каскада VER-12
        l8_json: Sn, approved_change_ref: Sn, derived_from: Sn,
      }),
      Suspicion: obj(["id", "inspection_id", "object_id", "discovery_method", "finding_status", "inspector_status"], {
        id: I, inspection_id: S, object_id: S, discovery_method: S, confidence: Nn, description: Sn, pd_reference: Sn, rd_reference: Sn, review_priority: Sn, normative_base: Sn,
        finding_status: S, inspector_status: { type: "string", enum: ["PENDING", "ACCEPTED", "DISMISSED"] }, dedup_key: S, advisor_ref_json: Sn, promoted_check_id: Sn,
      }),
      Param: obj(["id", "code", "section", "parameter_name", "data_type", "compare_json", "anchors_json", "is_active"], {
        id: I, code: S, section: S, parameter_name: S, unit: Sn, source_pd: Sn, source_rd: Sn, source_id: Sn, trigger_logic: Sn, review_priority: Sn,
        sp_reference: Sn, gost_reference: Sn, fz_reference: Sn, other_normative: Sn, data_type: S, compare_json: S, anchors_json: S, regex_pattern: Sn, value_scale_json: Sn,
        applicability: Sn, min_value: Nn, max_value: Nn, is_active: B, created_at: S, updated_at: S,
      }),
      Normative: obj(["id", "document_name", "document_number", "is_active"], {
        id: I, document_name: S, document_number: S, section: Sn, parameter_name: Sn, param_code: Sn, min_value: Nn, max_value: Nn, effective_from: Sn, effective_to: Sn, is_active: B,
      }),
      LegalAct: obj(["n", "short", "kind", "title", "number"], { n: I, short: S, kind: S, title: S, number: S, date: Sn, edition: Sn, edition_date: Sn, note: Sn }),
      LogicalRule: obj(["id", "rule_name", "condition_json", "expected_json", "fact_anchors_json", "is_active"], { id: I, rule_name: S, condition_json: S, expected_json: S, fact_anchors_json: S, normative_base: Sn, is_active: B }),
      Notification: obj(["id", "user_role", "level", "message", "created_at", "read"], { id: I, user_role: S, inspection_id: Sn, level: S, message: S, created_at: S, read: B }),
      // T-137: печать скрытого теста (OS-INSP-6.1.4) и запись журнала ответов (6.1.7)
      HiddenSeal: obj(["name", "digest", "n_files", "n_labels", "sealed_at", "sealed_by"], {
        name: S, digest: { type: "string", pattern: "^[0-9a-f]{64}$" }, n_files: I, n_labels: I, sealed_at: S, sealed_by: S,
      }),
      HiddenSealCreated: obj(["created", "seal"], { created: B, seal: ref("HiddenSeal") }),
      HiddenSealRun: obj(["id", "seal_name", "answer_sha256", "model_version", "committed_at", "committed_by"], {
        id: I, seal_name: S, answer_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, model_version: S, committed_at: S, committed_by: S,
      }),
      DatasetVersion: obj(["id", "dataset_version", "split_hashes_json", "items", "positives", "negatives", "created_at"], {
        id: I, dataset_version: S, split_hashes_json: S, items: I, positives: I, negatives: I, created_by: Sn, created_at: S,
      }),
      // ТЗ §10 Rejection_Log и Dispute_Log (OS-INSP-4.1.6, 4.1.7, 4.1.29; T-234: статус дообучения и исход спора)
      RejectionLogEntry: obj(["id", "check_id", "inspection_id", "param_code", "ai_verdict", "reason_code", "comment", "suggested_fix", "retraining_status", "created_at"], {
        id: I, check_id: S, inspection_id: S, param_code: S, ai_verdict: S, reason_code: S, comment: S, suggested_fix: S,
        retraining_status: { type: "string", enum: ["PENDING", "INCLUDED", "SUPERSEDED"] }, retraining_dataset: Sn, retraining_at: Sn, created_at: S,
      }),
      DisputeLogEntry: obj(["id", "check_id", "inspection_id", "param_code", "kind", "resolution_status", "created_at"], {
        id: I, check_id: S, inspection_id: S, param_code: S, kind: S, ai_comment: Sn, inspector_comment: Sn,
        resolution_status: { type: "string", enum: ["OPEN", "AI_UPHELD", "INSPECTOR_UPHELD", "WITHDRAWN"] }, resolved_by: Sn, resolved_by_name: Sn, resolved_at: Sn, resolution_comment: Sn, created_at: S,
      }),
      // ТЗ §10 Dataset_Items (T-234)
      DatasetItem: obj(["finding_id", "evidence_group_id", "gold_label", "split", "object_group_id", "fragments"], {
        finding_id: S, evidence_group_id: S, gold_label: { type: "string", enum: ["POSITIVE", "NEGATIVE"] }, expert_id: Sn, reason_code: Sn,
        split: { type: "string", enum: ["train", "validation", "test"] }, object_group_id: S, fragments: { type: "integer", minimum: 0 },
      }),
      // ТЗ §10 ML_Retraining_Log (ADR-0011: представление над model_versions)
      RetrainingLogEntry: obj(["id", "model_version", "approval_status", "created_at"], {
        id: I, model_version: S, dataset_version: Sn, split_hashes: Sn, precision: Nn, recall: Nn, f1: Nn, false_positive_rate: Nn, per_category_metrics: Sn,
        approval_status: S, approved_by: Sn, matrix_version: Sn, training_code_hash: Sn, trained_by: Sn, previous_model: Sn, created_at: S,
      }),
      ModelVersion: obj(["id", "model_version", "approval_status", "created_at"], {
        id: I, model_version: S, artifact_hash: Sn, dataset_version: Sn, metrics_json: Sn, approval_status: { type: "string", enum: ["AWAITING_APPROVAL", "REJECTED_BY_GATE", "PUBLISHED", "SUPERSEDED", "ROLLED_BACK"] },
        approved_by: Sn, approved_by_name: Sn, deployed_at: Sn, rollback_to: Sn, created_at: S, matrix_version: Sn, split_hashes_json: Sn, training_code_hash: Sn, training_params_json: Sn,
        weights_json: Sn, weights_hash: Sn, per_category_metrics_json: Sn, trained_by: Sn, previous_model: Sn, gate_json: Sn,
      }),
      GoldItem: obj(["evidence_group_id", "finding_id", "object_id", "param_code", "verification_status", "fragments", "gold_label", "split"], {
        evidence_group_id: S, finding_id: S, object_id: S, param_code: S, verification_status: S, reason_code: Sn, fragments: I, expert_id: Sn,
        gold_label: { type: "string", enum: ["POSITIVE", "NEGATIVE"] }, split: { type: "string", enum: ["train", "validation", "test"] },
      }),
      Prescription: obj(["prescription_id", "status", "event_at", "updated_at", "history"], {
        prescription_id: S, status: { type: "string", enum: PRESCRIPTION_STATUS }, event_at: S, updated_at: S,
        history: arr(obj(["status", "event_at", "received_at"], { status: { type: "string", enum: PRESCRIPTION_STATUS }, event_at: S, received_at: S })),
      }),
      DecisionResult: obj(["check_id", "verification_status", "process_status", "system_comment"], {
        check_id: S, verification_status: { type: "string", enum: ["CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED"] }, process_status: { type: "string", enum: PROCESS_STATUS }, system_comment: S,
      }),
      OcrQualityFile: obj(["file_id", "file_name", "parsed", "illegible_pages", "pages", "ocr_pages", "low_quality", "abstain", "illegible_share", "coverage", "ocr_words", "doubtful_words", "doubtful_share", "mean_ocr_confidence"], {
        file_id: S, file_name: S, parsed: B, illegible_pages: arr(I), pages: I, ocr_pages: I, low_quality: I, abstain: I,
        illegible_share: Nn, coverage: Nn, ocr_words: I, doubtful_words: I, doubtful_share: Nn, mean_ocr_confidence: Nn,
      }),
      OcrQualityTotal: obj(["files", "parsed_files", "pages", "ocr_pages", "low_quality", "abstain", "illegible_share", "coverage", "ocr_words", "doubtful_words", "doubtful_share", "mean_ocr_confidence"], {
        files: I, parsed_files: I, pages: I, ocr_pages: I, low_quality: I, abstain: I,
        illegible_share: Nn, coverage: Nn, ocr_words: I, doubtful_words: I, doubtful_share: Nn, mean_ocr_confidence: Nn,
      }),
      Measure: obj(["status", "method", "mm_per_px", "dimension_lines", "distances"], {
        status: { type: "string", enum: ["OK", "NOT_COMPARABLE"] },
        method: { type: "string", description: "dimension_line | none | inconsistent | stamp_mismatch | timeout" },
        // OS-INSP-2.4.7: reason — почему NOT_COMPARABLE по сроку («анализ листа дольше 30 с»); ms — время анализа листа
        reason: Sn, ms: N,
        mm_per_px: Nn, sheet_scale: Nn, sheet_scale_gost: Nn, stamp_scale: Nn, render_dpi: N,
        dimension_lines: arr(obj(["label", "mm", "px", "mm_per_px", "line_bbox", "label_bbox"], { label: S, mm: N, px: N, mm_per_px: N, line_bbox: arr(N), label_bbox: arr(N) })),
        distances: arr(obj(["mm", "axis", "a_bbox", "b_bbox"], { mm: N, m: N, axis: S, orientation: S, angle: N, a_bbox: arr(N), b_bbox: arr(N), a_pt: arr(N), b_pt: arr(N) })),
      }),
      AiUsage: obj(["legal_basis", "tool", "applied_at", "serviceability", "data", "attachments", "act_text", "final"], {
        legal_basis: S, applied_at: S, act_text: S, final: B,
        tool: obj(["name"], { name: S, category: S, matrix_version: S, model_version: S, dataset_version: S }),
        serviceability: obj(["ok"], { ok: B, files_total: I, files_failed: arr({}), engines: arr(S) }),
        data: arr(obj(["param_code", "inspector_decision"], { param_code: S, parameter_name: S, expected: Sn, actual: Sn, system_result: S, inspector_decision: S, sources: arr({ type: "object" }) })),
        attachments: arr(obj(["name", "sha256"], { name: S, sha256: S })),
        summary: obj(["checked", "with_sources", "not_found"], { checked: I, with_sources: I, not_found: I }),
      }),
      VerificationReport: obj(["generated_at", "idle_minutes", "cycles", "summary", "actions"], {
        generated_at: S, idle_minutes: N,
        cycles: arr(obj(["inspection_id", "user_id", "start_source", "completed", "decisions"], {
          inspection_id: S, user_id: Sn, user_name: Sn, start_source: { type: "string", nullable: true, enum: ["VERIFICATION_OPENED", "FIRST_DECISION", null] }, started_at: Sn, finished_at: Sn,
          completed: B, wall_minutes: Nn, active_minutes: Nn, decisions: I, candidates: I, confirmed: I, splits: I, within_target: { type: "boolean", nullable: true },
        })),
        summary: obj(["cycles_total", "cycles_completed", "participants", "verdict"], {
          target_minutes: N, min_participants: I, cycles_total: I, cycles_completed: I, participants: I, enough_participants: B,
          median_wall_minutes: Nn, max_wall_minutes: Nn, median_active_minutes: Nn, within_target_share: Nn, verdict: { type: "string", enum: ["CONFIRMED", "NOT_CONFIRMED", "INSUFFICIENT_PARTICIPANTS"] },
        }),
        actions: obj(["decisions"], { decisions: I, median: Nn, max: Nn, within3: Nn }),
      }),
      InspectionListItem: obj(["process_id", "object_id", "object_name", "status", "upload_status", "protocol_version", "created_at", "updated_at", "color", "sections", "counts"], {
        process_id: S, object_id: S, object_name: S, address: Sn, status: { type: "string", enum: PROCESS_STATUS }, scenario: Sn, upload_status: arr(S), protocol_version: I, sync_status: Sn,
        created_at: S, updated_at: S, color: { type: "string", enum: ["red", "yellow", "green", "gray"] },
        // раздел берётся из Матрицы; у записей вне Матрицы (гипотеза, дифф листов) его нет — null
        sections: arr(Sn),
        counts: obj(["candidates", "confirmed", "clarification", "missing", "negative", "total"], { candidates: I, confirmed: I, clarification: I, missing: I, negative: I, total: I }),
      }),
      InspectionDetail: obj(["inspection", "object", "files", "missing_files", "checks", "suspicions", "protocols", "sync_jobs", "audit"], {
        inspection: obj(["id", "object_id", "status", "protocol_version", "load_codes", "created_at", "updated_at"], {
          id: S, object_id: S, status: { type: "string", enum: PROCESS_STATUS }, scenario: Sn, load_codes: arr(S), protocol_version: I, sync_status: Sn, created_at: S, updated_at: S, finalized_at: Sn,
        }),
        object: obj(["id", "name", "profile"], { id: S, name: S, address: Sn, customer: Sn, contractor: Sn, permit_number: Sn, profile: { type: "object" }, created_at: S }),
        files: arr(obj(["id", "client_file_id", "file_name", "sha256", "size", "kind", "doc_stage", "document_code", "revision", "parse_status", "uploaded_at", "requisites"], {
          id: S, client_file_id: S, file_name: S, sha256: S, size: I, kind: S, doc_stage: { type: "string", enum: ["PD", "RD", "ID"] }, discipline: Sn, document_code: S, revision: S,
          approval_status: Sn, approval_date: Sn, predecessor_id: Sn, signature_status: Sn, revision_role: Sn, revision_note: Sn, parse_status: S, parse_error: Sn, engine: Sn, uploaded_at: S,
          pages: { type: "array", nullable: true, items: { type: "object" } }, doc_type: { type: "object", nullable: true }, signature_check: { type: "object", nullable: true },
          requisites: arr(obj(["kind", "page", "confidence"], { kind: S, page: I, bbox: { nullable: true }, confidence: N })),
        })),
        missing_files: arr({ type: "object", description: "строки реестра файлов, которых нет среди загруженных" }),
        checks: arr(ref("CheckRow")),
        suspicions: arr(ref("Suspicion")),
        protocols: arr(obj(["version", "status", "created_at"], { version: I, status: S, created_at: S, finalized_at: Sn })),
        sync_jobs: arr(obj(["id", "inspection_id", "protocol_version", "status", "attempts"], { id: I, inspection_id: S, protocol_version: I, status: S, attempts: I, next_attempt_at: Sn, last_error: Sn, created_at: S, updated_at: S })),
        audit: arr(ref("AuditEntry")),
      }),
    },
  },
  security: [{ bearer: [] }],
  paths: {
    ...annotationPaths,
    // ─────────────── аутентификация (ТЗ 12.1, 12.2)
    "/api/v1/auth/login": {
      post: {
        summary: "Вход по логину и паролю", security: [],
        requestBody: json(obj(["login", "password"], { login: { type: "string", maxLength: 100 }, password: { type: "string", maxLength: 200 } })),
        responses: { 200: ok("Токен сессии", obj(["token", "user"], { token: S, user: ref("User") })), 400: err, 401: err, 429: err },
      },
    },
    "/api/v1/auth/guest": {
      get: { summary: "Включён ли гостевой вход демо-стенда (T-131)", security: [], responses: { 200: ok("Признак", obj(["enabled"], { enabled: B })) } },
      post: {
        summary: "Гостевой вход демо-стенда (только в режиме только чтения, T-131)", security: [],
        responses: { 200: ok("Токен сессии гостя", obj(["token", "user"], { token: S, user: ref("User") })), 404: err, 429: err },
      },
    },
    "/api/v1/auth/me": { get: { summary: "Текущий пользователь сессии", responses: { 200: ok("Пользователь", ref("User")), 401: err } } },
    "/api/v1/auth/logout": { post: { summary: "Выход: сессия удаляется", responses: { 200: ok("Сессия закрыта", ref("Ok")), 401: err } } },

    // ─────────────── служебное
    "/api/v1/openapi.json": { get: { summary: "Этот документ OpenAPI 3.0", security: [], responses: { 200: ok("Документ OpenAPI", obj(["openapi", "info", "paths"], { openapi: S, info: { type: "object" }, paths: { type: "object" }, components: { type: "object" } })) } } },
    "/api/v1/dictionaries": {
      get: {
        summary: "Справочники интерфейса: коды причин отклонения и пределы загрузки", security: [],
        responses: { 200: ok("Справочники", obj(["reason_codes", "limits"], { reason_codes: { type: "object", additionalProperties: S }, limits: obj(["file_mb", "package_mb"], { file_mb: N, package_mb: N }) })) },
      },
    },
    "/health": {
      get: {
        summary: "Живость и версии", security: [],
        responses: {
          200: ok("Сервис жив", obj(["status", "profile", "revision", "ml", "versions", "ukep"], {
            status: { type: "string", enum: ["ok"] }, profile: S, revision: Sn,
            ukep: obj(["mode", "qualified"], { mode: { type: "string", enum: ["off", "pem", "openssl-gost", "cryptopro"] }, qualified: B }),
            ml: obj(["ok"], { ok: B, profile: S }),
            versions: obj(["matrix", "model", "dataset"], { matrix: S, model: S, dataset: S }),
          })),
        },
      },
    },
    // NFR-SLA (ТЗ 11-12): проба доступности blackbox-exporter — БД и ML за ≤ 2 с
    "/ready": {
      get: {
        summary: "Готовность: база и ML ответили", security: [],
        responses: {
          200: ok("Готов", obj(["status"], { status: { type: "string", enum: ["ready"] } }, { additionalProperties: false })),
          503: ok("Не готов: отказавшие зависимости", obj(["status", "failed"], {
            status: { type: "string", enum: ["not_ready"] },
            failed: { type: "array", minItems: 1, items: { type: "string", enum: ["db", "ml"] } },
          }, { additionalProperties: false })),
        },
      },
    },
    // формат экспозиции Prometheus (text/plain; version=0.0.4), не JSON — исключение из ТЗ 1.3 по природе протокола
    "/metrics": { get: { summary: "Метрики Prometheus", security: [], responses: { 200: { description: "Экспозиция Prometheus", content: { "text/plain": { schema: S } } } } } },

    // ─────────────── загрузка и обработка (ТЗ 9.6)
    "/api/v1/documents/upload": {
      post: {
        summary: "Загрузка пакета ПД/РД/ИД с реестром файлов → process_id",
        requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { object: { type: "string", description: "JSON карточки объекта (для новой проверки)" }, process_id: { type: "string", description: "Дозагрузка в существующую проверку" }, manifest: { type: "string", format: "binary", description: "Реестр файлов JSON/CSV" }, files: { type: "array", items: { type: "string", format: "binary" } }, start: { type: "string", enum: ["true", "false"] } } } } } },
        responses: { 202: { description: "Принято", ...json(ref("UploadResult")) }, 400: { description: "Ничего не принято (результат приёма с причинами) или запрос некорректен", ...json({ anyOf: [ref("UploadResult"), ref("Error")] }) }, 409: err, 413: err, 503: err },
      },
    },
    "/api/v1/documents/import": {
      post: {
        summary: "Серверный импорт файла больше 50 МБ по SHA-256 из каталога хранилища → process_id (OS-INSP-1.2.36)",
        requestBody: {
          required: true,
          ...json({
            type: "object", additionalProperties: false, required: ["files"],
            properties: {
              process_id: { type: "string", minLength: 1, maxLength: 64, description: "Дозагрузка в существующую проверку" },
              object: { type: "object", description: "Карточка объекта (для новой проверки)" },
              manifest: { type: "object", description: "Реестр файлов (формат как у загрузки)" },
              files: arr(obj(["sha256", "file_name"], { sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, file_name: { type: "string", minLength: 1, maxLength: 255 } }, { additionalProperties: false }), { minItems: 1, maxItems: 50 }),
              start: B,
            },
          }),
        },
        responses: { 202: { description: "Принято", ...json(ref("UploadResult")) }, 400: { description: "Ничего не принято (результат с причинами) или запрос некорректен", ...json({ anyOf: [ref("UploadResult"), ref("Error")] }) }, 401: err, 403: err, 404: err, 409: err, 415: err, 429: err, 503: err },
      },
    },
    "/api/v1/inspection/{process_id}/start": {
      post: {
        summary: "Запустить разбор: файлы PENDING/FAILED в очередь; без новых файлов — пересчёт сразу",
        parameters: [pathParam("process_id")],
        responses: { 200: ok("Число файлов в очереди разбора", obj(["queued"], { queued: I })), 403: err, 404: err, 409: err },
      },
    },
    "/api/v1/inspection/{process_id}/sheet-diff": {
      post: {
        summary: "Дифф пары листов по запросу инспектора (OS-INSP-3.4)",
        parameters: [pathParam("process_id")],
        requestBody: json(obj(["file_a", "page_a", "file_b", "page_b"], {
          file_a: { type: "string", minLength: 1, maxLength: 100 }, page_a: { type: "integer", minimum: 1, maximum: 10_000 },
          file_b: { type: "string", minLength: 1, maxLength: 100 }, page_b: { type: "integer", minimum: 1, maximum: 10_000 },
        })),
        responses: {
          200: ok("Итог сравнения: статус ML, число областей и созданных кандидатов", obj(["status", "created", "regions"], { status: S, reason: Sn, created: I, regions: I })),
          400: err, 404: err, 409: err, 415: err, 422: err, 502: err, 503: err,
        },
      },
    },
    "/api/v1/inspection/{process_id}/status": {
      get: { summary: "Мониторинг статуса обработки", parameters: [pathParam("process_id")], responses: { 200: ok("Статус проверки и её файлов", ref("Status")), 404: err } },
    },
    "/api/v1/inspection/{process_id}/protocol": { get: { summary: "Протокол (pull); ?version=N — снимок версии", parameters: [{ name: "process_id", in: "path", required: true, schema: { type: "string" } }, { name: "version", in: "query", schema: { type: "integer" } }], responses: { 200: json(ref("Protocol")), 409: err } } },
    "/api/v1/inspection/{process_id}/protocol/export": { get: { summary: "Экспорт протокола; submission — ответ по схеме организатора (OS-INSP-5.1.3–5.1.5)", parameters: [{ name: "process_id", in: "path", required: true, schema: { type: "string" } }, { name: "format", in: "query", schema: { type: "string", enum: ["json", "xml", "pdf", "docx", "submission"] } }], responses: { 200: { description: "Файл протокола или ответ организатора" }, 409: err, 422: err } } },
    "/api/v1/inspection/{process_id}/protocols": {
      get: {
        summary: "Версии протокола проверки (новые сверху)", parameters: [pathParam("process_id")],
        responses: {
          200: ok("Версии протокола", arr(obj(["version", "status", "created_at"], {
            version: I, status: { type: "string", enum: ["DRAFT", "FINALIZED"] }, matrix_version: Sn, model_version: Sn, dataset_version: Sn, input_manifest_hash: Sn, created_at: S, finalized_at: Sn,
          }))),
          401: err,
        },
      },
    },

    // ─────────────── дашборд (OS-INSP-8.1)
    "/api/v1/inspections": {
      get: {
        summary: "Дашборд проверок: цвет, разделы, счётчики; фильтры и постраничность",
        parameters: [
          query("status", { type: "string", description: PROCESS_STATUS.join(" | ") }), query("color", { type: "string", description: "red | yellow | green | gray" }), query("section", S),
          query("from", { type: "string", description: "updated_at не раньше (ISO)" }), query("to", { type: "string", description: "updated_at не позже дня ГГГГ-ММ-ДД" }), query("q", { type: "string", description: "поиск по объекту, адресу, process_id" }),
          ...page(200),
        ],
        responses: { 200: ok("Строки дашборда", arr(ref("InspectionListItem"))), 400: err, 401: err },
      },
    },
    "/api/v1/inspections/{process_id}": {
      get: { summary: "Карточка проверки: объект, файлы с реквизитами, записи протокола, гипотезы, версии, синхронизация, аудит", parameters: [pathParam("process_id")], responses: { 200: ok("Карточка проверки", ref("InspectionDetail")), 401: err, 404: err } },
    },

    // ─────────────── раздел «Объекты» (T-166, OS-INSP-8.1.3–8.1.7) — только чтение
    "/api/v1/objects": {
      get: {
        summary: "Реестр объектов: файлы по стадиям ПД/РД/ИД, последняя проверка, строка ключевых параметров (по умолчанию М-023)",
        parameters: [query("params", { type: "string", pattern: "^M-\\d{3}(,\\s*M-\\d{3})*$", description: "ключевые параметры через запятую, не больше 10; по умолчанию M-023" }), ...page(200)],
        responses: { 200: ok("Реестр объектов", ref("ObjectList")), 400: err, 401: err, 403: err },
      },
    },
    "/api/v1/objects/{object_id}": {
      get: {
        summary: "Карточка объекта: документы по стадиям (пустая стадия — пустой список), журнал проверок, ключевые параметры по стадиям",
        parameters: [pathParam("object_id"), query("params", { type: "string", pattern: "^M-\\d{3}(,\\s*M-\\d{3})*$", description: "ключевые параметры через запятую, не больше 10; по умолчанию M-023" })],
        responses: { 200: ok("Карточка объекта", ref("ObjectCard")), 400: err, 401: err, 403: err, 404: err },
      },
    },

    // ─────────────── файлы
    "/api/v1/files": {
      get: {
        summary: "Раздел «Файлы»: обработанные файлы постранично; у файла — сводка по параметрам (название из Матрицы, число упоминаний и разных значений), без самих упоминаний",
        parameters: [query("q", { type: "string", description: "подстрока имени файла или шифра" }), query("status", S), query("doc_type", S), query("object_id", S), ...page(25)],
        responses: {
          200: ok("Страница файлов", obj(["total", "limit", "offset", "items"], {
            total: I, limit: I, offset: I,
            items: arr(obj(["id", "file_name", "parse_status", "pages", "mentions", "params"], {
              id: S, inspection_id: Sn, object_id: Sn, object_name: Sn, file_name: S, kind: Sn, doc_type: Sn, doc_title: Sn, document_code: Sn, doc_stage: Sn,
              size: In, parse_status: S, parse_error: Sn, engine: Sn, uploaded_at: Sn, pages: I, mentions: I,
              params: arr(obj(["param_code", "in_matrix", "mentions", "distinct_values"], { param_code: S, name: Sn, section: Sn, in_matrix: B, mentions: I, distinct_values: I })),
            })),
          })),
          400: err, 401: err, 403: err,
        },
      },
    },
    "/api/v1/files/{file_id}/runs": {
      get: {
        summary: "История исполнений файла: версии, состояние и полнота; прежние runs не перезаписываются",
        parameters: [pathParam("file_id"), ...page(20)],
        responses: {
          200: ok("Запуски файла и сохранённые метаданные результата", obj(["runs", "recorded_result"], { runs: arr(obj(["id", "file_id", "sha256", "route", "policy", "status", "created_at"], {
            id: S, file_id: S, sha256: S, route: S, policy: S, status: S, error: Sn,
            created_at: S, finished_at: Sn, configuration_fingerprint: Sn,
            completeness: { type: "object", nullable: true }, progress_json: arr({ type: "object" }),
          })), recorded_result: obj(["sha256", "parse_status", "engine", "ml_revision", "pipeline_run_id", "trace_status"], {
            sha256: S, parse_status: S, engine: Sn, ml_revision: Sn, pipeline_run_id: Sn,
            trace_status: { type: "string", enum: ["untraced", "pipeline_linked", "inconsistent"] },
          }) })),
          400: err, 401: err, 403: err, 404: err,
        },
      },
    },
    "/api/v1/files/{file_id}/result-snapshots": {
      get: {
        summary: "Сохранённые версии результатов перед заменой; captured_at — время сохранения снимка, не обработки",
        parameters: [pathParam("file_id"), ...page(20)],
        responses: { 200: ok("Снимки результатов", obj(["snapshots"], { snapshots: arr(obj(
          ["id", "file_id", "sha256", "source_run_id", "ml_revision", "engine", "captured_at", "payload_sha256"], {
            id: S, file_id: S, sha256: S, source_run_id: Sn, ml_revision: Sn, engine: Sn, captured_at: S, payload_sha256: S,
            extractions: I, rooms: I, hidden_works: I, requisites: I, change_marks: I,
          })) })), 400: err, 401: err, 403: err, 404: err },
      },
    },
    "/api/v1/files/{file_id}/result-snapshots/{snapshot_id}/extractions": {
      get: {
        summary: "Прежние извлечения из неизменяемого снимка, постранично",
        parameters: [pathParam("file_id"), pathParam("snapshot_id"), ...page(25)],
        responses: { 200: ok("Прежние извлечения", obj(["extractions"], { extractions: arr({ type: "object" }) })),
          400: err, 401: err, 403: err, 404: err },
      },
    },
    "/api/v1/files/{file_id}/runs/{run_id}/trace": {
      get: {
        summary: "Трасса одной физической страницы: области, OCR/native слова и происхождение; нелокализованные чтения не являются фактами",
        parameters: [pathParam("file_id"), pathParam("run_id"), query("page", { type: "integer", minimum: 1, maximum: 100000, default: 1 })],
        responses: {
          200: ok("Трасса страницы выбранного run", obj(["id", "status", "progress", "regions", "word_bindings", "reader_observations"], {
            id: S, status: S, error: Sn, context: { type: "object", nullable: true },
            completeness: { type: "object", nullable: true }, page: { type: "object", nullable: true },
            regions: arr({ type: "object", description: "Region identity, geometry, transcription digest, lines and token boxes" }),
            progress: arr({ type: "object" }), word_bindings: arr({ type: "object" }),
            reader_observations: arr(obj(["region_id", "text", "status", "source"], {
              region_id: S, text: S, status: { type: "string", enum: ["unlocalized"] }, source: { type: "string", enum: ["vl-reader"] },
            })),
          })),
          400: err, 401: err, 403: err, 404: err,
        },
      },
    },
    "/api/v1/files/{file_id}/params": {
      get: {
        summary: "Упоминания параметров одного файла: значение как найдено, лист, строка-контекст (до 140 знаков); постранично, можно по одному параметру",
        parameters: [pathParam("file_id"), query("param", { type: "string", description: "код параметра, например M-087" }), ...page(20)],
        responses: {
          200: ok("Страница упоминаний", obj(["total", "limit", "offset", "items"], {
            total: I, limit: I, offset: I,
            items: arr(obj(["id", "param_code", "raw", "page", "line_text"], { id: I, param_code: S, raw: Sn, value_num: Nn, value_text: Sn, page: In, confidence: Nn, line_text: Sn })),
          })),
          400: err, 401: err, 403: err, 404: err,
        },
      },
    },
    "/api/v1/files/{file_id}/measure": {
      get: {
        summary: "Измерение на чертеже: масштаб по размерным линиям, расстояния в мм с bbox (OS-INSP-2.4)",
        parameters: [pathParam("file_id"), query("page", { type: "integer", minimum: 1 })],
        responses: { 200: ok("status OK | NOT_COMPARABLE, mm_per_px, dimension_lines, distances", ref("Measure")), 400: err, 404: err, 415: err, 422: err, 502: err },
      },
    },
    "/api/v1/files/{file_id}/content": {
      get: {
        summary: "Содержимое файла пакета (из кэша или S3 с проверкой SHA-256) — файл, не JSON; поддерживает Range",
        parameters: [pathParam("file_id"), { name: "Range", in: "header", required: false, schema: { type: "string", example: "bytes=0-65535" } }],
        responses: {
          200: { description: "Файл", content: Object.fromEntries(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "image/jpeg", "image/png", "image/tiff", "application/octet-stream"].map((t) => [t, { schema: { type: "string", format: "binary" } }])) },
          206: { description: "Часть файла по заголовку Range (один диапазон байт) — просмотр PDF кусками", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
          404: err, 416: { description: "Диапазон за пределами файла" }, 500: err, 503: err,
        },
      },
    },

    // ─────────────── верификация (OS-INSP-4)
    "/api/v1/checks/{finding_id}/decision": {
      post: { summary: "Решение инспектора по кандидату", parameters: [pathParam("finding_id")], requestBody: json(ref("Decision")), responses: { 200: ok("Решение записано", ref("DecisionResult")), 400: err, 404: err, 409: err } },
    },
    "/api/v1/checks/{finding_id}/split": {
      post: {
        summary: "Разделить составной кандидат на атомарные findings",
        parameters: [pathParam("finding_id")],
        requestBody: json(obj(["parts"], { parts: arr(obj(["title", "fragment_ids"], { title: { type: "string", minLength: 1 }, fragment_ids: arr(N, { minItems: 1 }) })) })),
        responses: { 200: ok("Идентификаторы частей", obj(["ids"], { ids: arr(S) })), 400: err, 404: err, 409: err },
      },
    },
    "/api/v1/checks/{finding_id}/siblings": {
      get: {
        summary: "Кандидаты с той же сигнатурой причины — общий корень (OS-INSP-4.1.12)", parameters: [pathParam("finding_id")],
        responses: {
          200: ok("Соседи по общему корню", arr(obj(["id", "param_code", "finding_status", "verification_status", "fragments"], {
            id: S, param_code: S, parameter_name: Sn, finding_status: S, verification_status: S, review_priority: Sn, expected_value: Sn, actual_value: Sn, fragments: arr(ref("FragmentRef")),
          }))),
          403: err, 404: err,
        },
      },
    },
    "/api/v1/checks/{finding_id}/reject-group": {
      post: {
        summary: "Групповое снятие соседей по общему корню — поштучными решениями (OS-INSP-4.1.13, 4.1.14)",
        parameters: [pathParam("finding_id")],
        requestBody: json(obj(["reason_code", "ids"], { reason_code: REASON, ids: arr(S, { minItems: 1, maxItems: 20 }), actions: { type: "integer", minimum: 0, maximum: 100 } })),
        responses: { 200: ok("Снятые записи", obj(["rejected"], { rejected: arr(S) })), 400: err, 403: err, 404: err, 409: err },
      },
    },
    "/api/v1/checks/{finding_id}/reopen": {
      post: { summary: "Вернуть решённого кандидата в PENDING (OS-INSP-4.1.15)", parameters: [pathParam("finding_id")], responses: { 200: ok("Запись снова ждёт решения", obj(["check_id", "verification_status"], { check_id: S, verification_status: { type: "string", enum: ["PENDING"] } })), 403: err, 404: err, 409: err } },
    },
    "/api/v1/checks/{finding_id}/fragments": {
      get: { summary: "Фрагменты доказательств записи протокола", parameters: [pathParam("finding_id")], responses: { 200: ok("Фрагменты", arr(ref("EvidenceFragment"))), 401: err } },
    },
    "/api/v1/inspection/{process_id}/sample": {
      get: {
        summary: "План выборки совпадений: объём партии, seed, карточки выборки (T-110, OS-INSP-4.1.8)", parameters: [pathParam("process_id")],
        responses: {
          200: ok("План выборки", obj(["seed", "pool_size", "sample_size", "bound_if_clean", "last_acceptance", "sample"], {
            seed: I, pool_size: I, sample_size: I, bound_if_clean: N,
            last_acceptance: obj(["id", "inspection_id", "user_id", "seed", "pool_size", "sample_size", "upper_bound", "created_at"], { id: I, inspection_id: S, user_id: S, seed: I, pool_size: I, sample_size: I, upper_bound: N, sample_ids: S, pool_ids: S, created_at: S }, { nullable: true }),
            sample: arr(obj(["id", "param_code", "finding_status", "verification_status", "fragments"], {
              id: S, param_code: S, finding_status: S, verification_status: S, review_priority: Sn, expected_value: Sn, actual_value: Sn, parameter_name: Sn, section: Sn, file_id: Sn, min_confidence: Nn,
              fragments: arr(ref("FragmentRef")),
            })),
          })),
          403: err, 404: err,
        },
      },
    },
    "/api/v1/inspection/{process_id}/sample/accept": {
      post: {
        summary: "Приёмка партии совпадений по выборке (T-110, OS-INSP-4.1.9–4.1.11)", parameters: [pathParam("process_id")],
        requestBody: json(obj(["seed", "reviewed", "errors"], { seed: I, reviewed: arr(S, { maxItems: 500 }), errors: arr(S, { maxItems: 500 }) })),
        responses: {
          200: ok("ACCEPTED — партия принята; BROKEN — в выборке ошибки, партия не принята", obj(["outcome"], {
            outcome: { type: "string", enum: ["ACCEPTED", "BROKEN"] }, accepted: I, sample_size: I, upper_bound: N, pool_size: I, errors: arr(S),
          })),
          400: err, 403: err, 404: err, 409: err,
        },
      },
    },
    "/api/v1/inspection/{process_id}/changes": {
      get: { summary: "Согласованные изменения объекта (OS-INSP-1.5.1)", parameters: [pathParam("process_id")], responses: { 200: ok("Список изменений", arr(ref("ApprovedChange"))), 404: err } },
      post: {
        summary: "Зарегистрировать согласованное изменение (инспектор, супервизор; запись в аудит)",
        parameters: [{ name: "process_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: json({ type: "object", required: ["number", "date", "param_codes"], properties: { number: { type: "string" }, date: { type: "string", format: "date" }, param_codes: { type: "array", items: { type: "string" } }, basis_file_id: { type: "string", nullable: true }, description: { type: "string" } } }),
        responses: { 201: ok("Изменение зарегистрировано", ref("ApprovedChange")), 400: err, 404: err, 409: err },
      },
    },
    "/api/v1/inspection/{process_id}/feedback-logs": {
      get: {
        summary: "Журналы отклонений и спорных случаев (Rejection_Log, Dispute_Log) — супервизор, администратор, ML-инженер, куратор",
        parameters: [pathParam("process_id"), ...page(500)],
        responses: {
          200: ok("rejections и disputes", obj(["rejections", "disputes"], { rejections: arr(ref("RejectionLogEntry")), disputes: arr(ref("DisputeLogEntry")) })),
          400: err, 403: err,
        },
      },
    },
    "/api/v1/inspection/{process_id}/ai-usage": {
      get: {
        summary: "Запись о применении ИИ-средства для акта (ПП Москвы № 2078-ПП п. 9(1).8): JSON или ?format=text — готовый текст",
        parameters: [pathParam("process_id"), query("format", { type: "string", enum: ["json", "text"] })],
        responses: { 200: { description: "legal_basis, tool, applied_at, serviceability, data, attachments, act_text; ?format=text — текст для акта", content: { "application/json": { schema: ref("AiUsage") }, "text/plain": { schema: S } } }, 404: err, 409: err },
      },
    },
    "/api/v1/inspection/{process_id}/integrity": {
      get: {
        summary: "OS-INSP-1.2.35: отчёт о целостности пакета по реестру — статус каждого файла реестра и доля учтённых без расхождений",
        parameters: [pathParam("process_id")],
        responses: {
          200: ok("Отчёт", obj(["files", "declared", "share", "outside_registry"], {
            files: { type: "array", items: obj(["file_id", "status"], { file_id: S, file_name: S, status: { type: "string", enum: ["ACCEPTED", "PART", "EXCLUDED", "DUPLICATE", "INCOMPLETE", "REJECTED", "MISSING"] }, sha256: Sn, pages: { type: "integer", nullable: true }, declared_pages: { type: "integer", nullable: true }, reason: Sn, duplicate_of: Sn, part_of: Sn }) },
            declared: I, share: { type: "number", nullable: true }, outside_registry: { type: "array", items: S },
          })),
          401: err, 403: err, 404: err,
        },
      },
    },
    "/api/v1/inspection/{process_id}/critical-unresolved": {
      get: {
        summary: "OS-INSP-4.3.5: критические параметры без вердикта сравнения и без решения инспектора — перечень для окна финализации",
        parameters: [pathParam("process_id")],
        responses: { 200: ok("Перечень", obj(["critical"], { critical: { type: "array", items: obj(["param_code", "finding_status"], { param_code: S, parameter_name: Sn, finding_status: S }) } })), 401: err, 403: err, 404: err },
      },
    },
    "/api/v1/inspection/{process_id}/finalize": {
      post: {
        summary: "Финализировать протокол (кнопка «Завершить»). OS-INSP-4.3.5: при критических параметрах без вердикта — 409 CRITICAL_UNREVIEWED с перечнем, пока не передано critical_reviewed: true",
        parameters: [pathParam("process_id")],
        requestBody: { required: false, ...json({ type: "object", properties: { critical_reviewed: B } }) },
        responses: {
          200: ok("Версия финализированного протокола, статус передачи в «РиН» и просмотренные критические параметры", obj(["version", "sync_status"], { version: I, sync_status: Sn, critical_reviewed: { type: "array", items: S } })),
          401: err, 403: err, 404: err,
          // T136-L4: форма отказа OS-INSP-4.3.5 — details.code и перечень
          409: { description: "Не финализировано: открытые кандидаты или CRITICAL_UNREVIEWED с перечнем критических параметров без вердикта", ...json(obj(["error"], { error: S, details: { type: "object", nullable: true, properties: { code: { type: "string", enum: ["CRITICAL_UNREVIEWED"] }, critical: { type: "array", items: obj(["param_code", "finding_status"], { param_code: S, parameter_name: Sn, finding_status: S }) } } } })) },
        },
      },
    },
    "/api/v1/inspection/{process_id}/unfinalize": {
      post: {
        summary: "Отмена финализации (супервизор, с причиной)", parameters: [pathParam("process_id")],
        requestBody: json(obj(["reason"], { reason: S })),
        responses: { 200: ok("Статус проверки после отмены", obj(["status"], { status: { type: "string", enum: PROCESS_STATUS } })), 400: err, 403: err, 404: err, 409: err },
      },
    },
    "/api/v1/inspection/{process_id}/sync": {
      post: { summary: "Повторить передачу финализированного протокола в ИАИС «РиН»", parameters: [pathParam("process_id")], responses: { 200: ok("Статус передачи", obj(["sync_status"], { sync_status: Sn })), 403: err, 404: err } },
    },
    "/api/v1/inspection/{process_id}": { post: { "x-direction": "outbound", summary: "ИАИС «РиН»: приём подтверждённых нарушений (исходящий вызов системы; только PROTOCOL_FINALIZED)", responses: { 202: ok("Принято внешней системой", { type: "object", properties: { accepted: B } }) } } },
    "/api/v1/suspicions/{id}/status": {
      post: {
        summary: "Решение инспектора по гипотезе: принята, отклонена, снова ждёт (запись в аудит)", parameters: [pathParam("id", I)],
        requestBody: json(obj(["inspector_status"], { inspector_status: { type: "string", enum: ["PENDING", "ACCEPTED", "DISMISSED"] } })),
        responses: { 200: ok("Статус записан", ref("Ok")), 400: err, 404: err, 409: err },
      },
    },
    "/api/v1/suspicions/{id}/promote": {
      post: {
        summary: "Перевести гипотезу в кандидаты — нужна ссылка: файл проверки, страница, bbox (OS-INSP-3.2.7)", parameters: [pathParam("id", I)],
        // обязательность полей проверяет обработчик (domain/suspicions.ts promotionError) — с понятным инспектору текстом отказа
        requestBody: json({ type: "object", properties: { file_id: S, page: { type: "integer", minimum: 1 }, bbox: arr(N, { minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] в долях страницы" }), quote: Sn } }),
        responses: { 200: ok("Созданная запись протокола", obj(["check_id"], { check_id: S })), 400: err, 404: err, 409: err },
      },
    },
    "/api/v1/notifications": {
      get: { summary: "Уведомления роли пользователя (новые сверху)", parameters: page(50), responses: { 200: ok("Уведомления", arr(ref("Notification"))), 400: err, 401: err } },
    },

    // ─────────────── интеграция с ИАИС «РиН» (ТЗ 9.6.4)
    "/api/v1/rin/prescriptions": {
      post: {
        summary: "ИАИС «РиН» → система: статус предписания (OS-INSP-5.4, ТЗ §9.6.4); ключ интеграции в заголовке x-rin-key",
        security: [],
        parameters: [{ name: "x-rin-key", in: "header", required: true, schema: { type: "string" } }],
        requestBody: json({ type: "object", required: ["prescription_id", "process_id", "status", "event_at"], properties: { prescription_id: { type: "string" }, process_id: { type: "string" }, status: { type: "string", enum: PRESCRIPTION_STATUS }, event_at: { type: "string", description: "ISO 8601: ГГГГ-ММ-ДД или дата-время с часовым поясом" } } }),
        responses: {
          201: ok("Статус записан в историю", obj(["created", "prescription"], { created: B, prescription: ref("Prescription") })),
          200: ok("Повтор: история не изменилась", obj(["created", "prescription"], { created: B, prescription: ref("Prescription") })),
          400: err, 401: err, 404: err, 503: err,
        },
      },
    },
    "/api/v1/inspection/{process_id}/prescriptions": { get: { summary: "Предписания по проверке: текущий статус и история (OS-INSP-5.4.5)", parameters: [pathParam("process_id")], responses: { 200: ok("Список предписаний", arr(ref("Prescription"))), 404: err } } },
    "/api/v1/admin/rin-mock": {
      post: {
        summary: "Заглушка «РиН» (только профиль dev с флагом): включить отказ, последние принятые пакеты", requestBody: json(obj(["down"], { down: B })),
        responses: { 200: ok("Состояние заглушки", obj(["down", "received"], { down: B, received: arr(obj(["id", "at", "confirmed"], { id: S, at: S, confirmed: I })) })), 400: err, 403: err },
      },
    },

    // ─────────────── нормативная база (OS-INSP-7)
    "/api/v1/params": { get: { summary: "Параметры Матрицы", parameters: page(500), responses: { 200: ok("Параметры", arr(ref("Param"))), 400: err, 401: err } } },
    "/api/v1/params/{code}/passport": { get: { summary: "Паспорт параметра: атрибуты, источники, шкала, алгоритм расчёта, метрики (T-129)", parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" } }], responses: { 200: json(ref("Passport")), 401: err, 404: err } } },
    "/api/v1/params/{code}/verifications": { post: { summary: "Записать результат автоматической верификации параметра (ML-инженер); вердикт считает сервер", parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" } }], requestBody: json(ref("VerificationInput")), responses: { 201: json(ref("VerificationResult")), 400: err, 401: err, 403: err, 404: err } } },
    "/api/v1/params/{code}": {
      patch: {
        summary: "Изменить параметр Матрицы без перекодирования (администратор)", parameters: [pathParam("code")],
        requestBody: json({
          type: "object",
          properties: {
            trigger_logic: S, review_priority: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] }, sp_reference: Sn, gost_reference: Sn, fz_reference: Sn,
            min_value: Nn, max_value: Nn, is_active: B, compare: { description: "правило сравнения (compare_json)" }, anchors: arr(S), regex_pattern: Sn,
          },
        }),
        responses: { 200: ok("Новая matrix_version", obj(["ok", "matrix_version"], { ok: { type: "boolean", enum: [true] }, matrix_version: S })), 400: err, 403: err, 404: err },
      },
    },
    "/api/v1/normative": {
      get: { summary: "Нормативная база", parameters: page(500), responses: { 200: ok("Нормативы", arr(ref("Normative"))), 400: err, 401: err } },
      post: {
        summary: "Добавить норматив (администратор; запись в аудит)",
        requestBody: json(obj(["document_name", "document_number"], {
          document_name: { type: "string", minLength: 1 }, document_number: { type: "string", minLength: 1 }, section: S, parameter_name: S, param_code: Sn,
          min_value: Nn, max_value: Nn, effective_from: Sn, effective_to: Sn,
        })),
        responses: { 200: ok("Идентификатор норматива", ref("Created")), 400: err, 403: err },
      },
    },
    "/api/v1/normative/{id}": {
      patch: {
        summary: "Изменить или вывести из действия норматив (администратор); зависящие параметры открытых проверок пересчитываются сразу (OS-INSP-7.2.4, T-234)", parameters: [pathParam("id", I)],
        requestBody: json({ type: "object", properties: { is_active: B, effective_from: { type: "string", nullable: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, effective_to: { type: "string", nullable: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, min_value: Nn, max_value: Nn } }),
        responses: { 200: ok("Изменено", obj(["ok", "recomputed"], { ok: B, recomputed: arr(S) })), 400: err, 403: err, 404: err },
      },
    },
    "/api/v1/normative/search": {
      get: {
        summary: "Поиск по нормативной базе: BM25 и эмбеддинги в ML (OS-INSP-3.2.6)",
        parameters: [query("q", { type: "string", minLength: 1 }, true), query("top_k", { type: "integer", minimum: 1, maximum: 50, default: 5 })],
        responses: {
          200: ok("Найденные нормы по убыванию score", obj(["query", "method", "results"], {
            query: S, method: S,
            results: arr(obj(["id", "document_number", "document_name", "score"], {
              id: S, document_number: S, document_name: S, section: Sn, summary: S, summary_is_paraphrase: B, param_codes: arr(S), numeric: { type: "object", nullable: true }, source: S, score: N, bm25: N, cosine: Nn,
            })),
          })),
          400: err, 401: err, 503: err,
        },
      },
    },
    "/api/v1/legal-acts": { get: { summary: "Перечень нормативных правовых актов ТЗ §2 с редакциями (OS-INSP-7.2.2)", parameters: page(500), responses: { 200: ok("Акты", arr(ref("LegalAct"))), 400: err, 401: err } } },
    "/api/v1/rules": {
      get: { summary: "Логические правила", parameters: page(500), responses: { 200: ok("Правила", arr(ref("LogicalRule"))), 400: err, 401: err } },
      post: {
        summary: "Добавить логическое правило (администратор; запись в аудит)",
        requestBody: json(obj(["rule_name", "condition", "expected"], {
          rule_name: { type: "string", minLength: 3 }, condition: Cond, expected: Cond,
          fact_anchors: arr(obj(["code", "anchors"], { code: S, anchors: arr(S), data_type: S })), normative_base: S,
        })),
        responses: { 200: ok("Идентификатор правила", ref("Created")), 400: err, 403: err },
      },
    },
    "/api/v1/rules/{id}": {
      patch: {
        summary: "Изменить или отключить логическое правило (администратор)", parameters: [pathParam("id", I)],
        requestBody: json({ type: "object", properties: { is_active: B, rule_name: S, normative_base: S } }),
        responses: { 200: ok("Изменено", ref("Ok")), 400: err, 403: err, 404: err },
      },
    },

    // ─────────────── администрирование и аудит
    "/api/v1/admin/integrity": {
      post: {
        summary: "Проверка целостности хранилища файлов по SHA-256 (администратор)",
        responses: { 200: ok("Итог проверки", obj(["checked", "missing", "corrupted", "unreadable", "at"], { checked: I, missing: arr(S), corrupted: arr(S), unreadable: arr(S), at: S })), 403: err, 409: err },
      },
    },
    "/api/v1/audit": {
      get: {
        summary: "Журнал аудита (супервизор): фильтры по действию и пользователю",
        parameters: [query("action", S), query("user", { type: "string", description: "user_id" }), ...page(500)],
        responses: { 200: ok("Записи журнала (новые сверху)", arr(ref("AuditEntry"))), 400: err, 403: err },
      },
    },
    // NFR-PDN (ТЗ 12.6-01, 152-ФЗ): реестр ПДн, сведения субъекту (ст. 14), выключение учётки (ст. 21 ч. 7)
    "/api/v1/admin/pdn/registry": {
      get: {
        summary: "Реестр персональных данных: таблица, колонка, категория, цель, основание (152-ФЗ ст. 6), срок и защита (администратор)",
        responses: {
          200: ok("Реестр ПДн, колонки «не ПДн» с причиной и сроки обезличивания", obj(["registry", "not_personal", "retention"], {
            registry: arr(obj(["table", "column", "category", "purpose", "basis", "retention_days", "protection"], {
              table: S, column: S, path: S, category: S, subject: S, purpose: S, basis: S, retention_days: { oneOf: [I, { type: "string", enum: ["до цели"] }] }, retention_note: S, protection: arr(S),
            })),
            not_personal: arr(obj(["table", "column", "reason"], { table: S, column: S, reason: S })),
            retention: obj(["user_days", "audit_days"], { user_days: I, audit_days: I }),
          })),
          403: err,
        },
      },
    },
    "/api/v1/admin/pdn/subject/{userId}": {
      get: {
        summary: "Сведения субъекту ПДн (152-ФЗ ст. 14): все ПДн пользователя и где лежат; обращение пишется в аудит PDN_ACCESS (администратор)",
        parameters: [pathParam("userId")],
        responses: {
          200: ok("ПДн пользователя по местам хранения", obj(["user", "audit", "decisions", "sessions", "protocols_with_name", "locations"], {
            user: obj(["id", "login", "name", "role", "deactivated_at"], { id: S, login: S, name: S, role: S, deactivated_at: Sn }),
            audit: obj(["records", "with_ip", "with_ua", "first", "last", "ip_addresses", "user_agents"], { records: I, with_ip: I, with_ua: I, first: Sn, last: Sn, ip_addresses: arr(S), user_agents: arr(S) }),
            decisions: I, sessions: I, inspections_created: I, protocols_with_name: I,
            locations: arr(obj(["table", "column", "category", "records"], { table: S, column: S, category: S, purpose: S, retention: S, records: I })),
          })),
          403: err, 404: err,
        },
      },
    },
    "/api/v1/admin/users/{id}/deactivate": {
      post: {
        summary: "Выключить учётку (администратор): вход закрыт, сессии удалены, аудит USER_DEACTIVATED; через INSPECTOR_PDN_USER_DAYS — обезличивание",
        parameters: [pathParam("id")],
        responses: { 200: ok("Учётка выключена (повтор — прежняя отметка)", obj(["id", "deactivated_at"], { id: S, deactivated_at: S })), 403: err, 404: err, 409: err },
      },
    },

    // ─────────────── NFR-VERIFY-30, мониторинг
    "/api/v1/inspection/{process_id}/verification/open": { post: { summary: "Инспектор открыл экран верификации — начало цикла для замера (NFR-VERIFY-30, ТЗ 9.3.6); запись VERIFICATION_OPENED в аудит", parameters: [pathParam("process_id")], responses: { 200: ok("ok", ref("Ok")), 403: err, 404: err } } },
    "/api/v1/usability/verification-report": {
      get: {
        summary: "Замер цикла верификации по журналу аудита для протокола юзабилити-теста (супервизор, администратор); ?format=md — протокол в markdown",
        parameters: [{ name: "format", in: "query", schema: { type: "string", enum: ["json", "md"] } }, { name: "idle_minutes", in: "query", schema: { type: "number", minimum: 1, maximum: 240 } }],
        responses: { 200: { description: "cycles и summary (медиана, максимум, доля ≤ 30 мин, вердикт); ?format=md — markdown", content: { "application/json": { schema: ref("VerificationReport") }, "text/markdown": { schema: S } } }, 400: err, 403: err },
      },
    },
    "/api/v1/monitoring/metrics": {
      get: {
        summary: "Ряд метрики производительности из monitoring_metrics по окнам: avg/min/max/count, раздельно по меткам (NFR-METRICS-STORE, администратор)",
        parameters: [{ name: "name", in: "query", required: true, schema: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" } }, { name: "from", in: "query", schema: { type: "string", format: "date-time", description: "по умолчанию — сутки до to" } }, { name: "to", in: "query", schema: { type: "string", format: "date-time", description: "по умолчанию — сейчас" } }, { name: "bucket", in: "query", schema: { type: "integer", minimum: 60, maximum: 86400, description: "окно, с; по умолчанию — не больше 360 точек" } }],
        responses: {
          200: ok("name, from, to, bucket_sec, series[{tags, points[{t, avg, min, max, count}]}], truncated", obj(["name", "from", "to", "bucket_sec", "series", "truncated"], {
            name: S, from: S, to: S, bucket_sec: I, truncated: B,
            series: arr(obj(["tags", "points"], { tags: { type: "object", additionalProperties: S }, points: arr(obj(["t", "avg", "min", "max", "count"], { t: S, avg: N, min: N, max: N, count: I })) })),
          })),
          400: err, 403: err,
        },
      },
    },
    "/api/v1/monitoring/metric-names": {
      get: { summary: "Каталог метрик в monitoring_metrics: имя, последний снимок и значение (администратор)", responses: { 200: ok("metric_name, last_at, last_value, service_name", arr(obj(["metric_name", "last_at", "last_value", "service_name"], { metric_name: S, last_at: S, last_value: Nn, service_name: Sn }))), 403: err } },
    },

    // ─────────────── защита (NFR-IDS, ТЗ 12.9, T-138)
    "/api/v1/inspection/{process_id}/ocr-quality": {
      get: {
        summary: "Качество распознавания проверки: доля нечитаемых зон (LOW_QUALITY/ABSTAIN, сомнительные слова OCR) и покрываемость — по файлам и итог (OS-INSP-2.1.16, ТЗ 9.1.1)",
        parameters: [pathParam("process_id")],
        responses: { 200: ok("По файлам и итог", obj(["files", "total"], { files: arr(ref("OcrQualityFile")), total: ref("OcrQualityTotal") })), 401: err, 404: err },
      },
    },
    "/api/v1/admin/security/blocks": {
      get: {
        summary: "Блокировки адресов системой защиты: действующие; all=1 — вся история (администратор)",
        parameters: [query("all", { type: "string", enum: ["0", "1"] })],
        responses: {
          200: ok("Включена ли защита и блокировки", obj(["enabled", "blocks"], {
            enabled: B,
            blocks: arr(obj(["ip", "reason", "score", "events", "blocks", "blocked_at", "until", "active"], {
              ip: S, reason: S, score: I, events: { type: "object", additionalProperties: I }, blocks: I, blocked_at: S, until: S, released_at: Sn, released_by: Sn, active: B,
            })),
          })),
          401: err, 403: err,
        },
      },
    },
    "/api/v1/admin/security/blocks/{ip}": {
      delete: { summary: "Снять блокировку адреса (запись IDS_UNBLOCK в журнал аудита)", parameters: [pathParam("ip")], responses: { 200: ok("Снята", obj(["ok", "ip"], { ok: B, ip: S })), 401: err, 403: err, 404: err, 409: err } },
    },

    // ─────────────── дообучение (OS-INSP-6)
    "/api/v1/ml/gold/preview": {
      get: { summary: "Черновик GOLD-набора из финализированных протоколов (куратор, ML-инженер)", responses: { 200: ok("Элементы, хеши выборок, баланс классов", obj(["items", "hashes", "excluded_hidden", "positives", "negatives"], { items: arr(ref("GoldItem")), hashes: ref("SplitHashes"), excluded_hidden: { type: "integer", minimum: 0, description: "решений по файлам скрытого теста исключено (OS-INSP-6.1.8)" }, positives: I, negatives: I })), 403: err } },
    },
    "/api/v1/ml/gold/release": {
      post: { summary: "Выпустить версию GOLD-набора (куратор): версия, элементы, dataset_version — одной транзакцией", responses: { 200: ok("Выпущенная версия набора", obj(["dataset_version", "items", "hashes", "excluded_hidden"], { dataset_version: S, items: I, hashes: ref("SplitHashes"), excluded_hidden: { type: "integer", minimum: 0, description: "решений по файлам скрытого теста исключено (OS-INSP-6.1.8)" }, rejections_included: { type: "integer", minimum: 0, description: "записей журнала отклонений, вошедших в набор (T-234)" } })), 403: err, 409: err } },
    },
    "/api/v1/ml/datasets": { get: { summary: "Выпущенные версии GOLD-набора", parameters: page(200), responses: { 200: ok("Версии набора", arr(ref("DatasetVersion"))), 400: err, 403: err } } },
    "/api/v1/ml/report": {
      get: {
        summary: "Отчёт для дообучения по решениям инспекторов с даты since (по умолчанию — неделя)", parameters: [query("since", { type: "string", description: "ISO 8601" })],
        responses: {
          200: ok("Итоги решений, причины отклонений с рекомендациями, параметры", obj(["since", "totals", "by_reason", "by_param"], {
            since: S,
            totals: arr(obj(["action", "n"], { action: S, n: I })),
            by_reason: arr(obj(["reason_code", "n", "recommendation"], { reason_code: Sn, n: I, recommendation: S })),
            by_param: arr(obj(["param_code", "n"], { param_code: S, parameter_name: Sn, n: I })),
            // T-234: журнал отклонений по статусу дообучения (Rejection_Log.retraining_status)
            retraining: obj(["PENDING", "INCLUDED", "SUPERSEDED"], { PENDING: I, INCLUDED: I, SUPERSEDED: I }),
          })),
          403: err,
        },
      },
    },
    "/api/v1/ml/reports": {
      get: {
        summary: "Отчёты для дообучения, построенные по расписанию (OS-INSP-6.2.2)", parameters: page(200),
        responses: { 200: ok("Отчёты (новые сверху)", arr(obj(["id", "since", "until", "created_at", "body"], { id: I, since: S, until: S, created_at: S, body: { type: "object" } }))), 400: err, 403: err },
      },
    },
    "/api/v1/ml/feedback-logs": {
      get: {
        summary: "Журналы отклонений и спорных случаев сводно по всем проверкам (OS-INSP-4.1.27)", parameters: page(500),
        responses: {
          200: ok("Журналы (новые сверху)", obj(["rejections", "disputes"], { rejections: arr(ref("RejectionLogEntry")), disputes: arr(ref("DisputeLogEntry")) })),
          400: err, 401: err, 403: err,
        },
      },
    },
    "/api/v1/ml/models": {
      get: { summary: "Реестр версий моделей", parameters: page(200), responses: { 200: ok("Версии моделей (новые сверху)", arr(ref("ModelVersion"))), 400: err, 403: err } },
      post: {
        summary: "Зарегистрировать версию модели с метриками; ворота публикации OS-INSP-6.3.1 (ML-инженер)",
        requestBody: json(obj(["model_version", "dataset_version", "metrics"], {
          model_version: { type: "string", minLength: 1 }, artifact_hash: S, dataset_version: S,
          metrics: obj(["precision", "recall", "f1", "false_positive_rate", "recall_by_category"], { precision: N, recall: N, f1: N, false_positive_rate: N, recall_by_category: { type: "object", additionalProperties: N } }),
        })),
        responses: { 200: ok("Итог ворот публикации", obj(["gate"], { gate: ref("Gate") })), 400: err, 403: err, 409: err },
      },
    },
    "/api/v1/ml/models/train": {
      post: {
        summary: "Итерация дообучения модели ранжирования по выпущенной версии набора (OS-INSP-6.4.4–6.4.8); публикация — только через /approve",
        requestBody: json(obj(["dataset_version"], {
          dataset_version: { type: "string", minLength: 1, maxLength: 100 },
          params: { type: "object", properties: { l2: { type: "number", minimum: 0, maximum: 10_000, description: "больше 0 (проверяет обработчик)" }, max_iter: { type: "integer", minimum: 1, maximum: 200 }, min_recall: { type: "number", minimum: 0, maximum: 1 }, seed: { type: "string", minLength: 1, maxLength: 64 } } },
        })),
        responses: {
          201: ok("Зарегистрированная итерация", obj(["model_version", "approval_status", "weights_hash", "gate", "metrics", "previous_model"], {
            model_version: S, approval_status: { type: "string", enum: ["AWAITING_APPROVAL", "REJECTED_BY_GATE"] }, weights_hash: S, gate: ref("Gate"), metrics: { type: "object" }, previous_model: S,
          })),
          400: err, 401: err, 403: err, 404: err, 409: err, 422: err,
        },
      },
    },
    // T-137: печать скрытого теста (OS-INSP-6.1.4–6.1.7); только добавление
    "/api/v1/ml/hidden-seals": {
      post: {
        summary: "Запечатать скрытый тест: SHA-256 каждого файла с ролью input/labels и общий отпечаток (OS-INSP-6.1.4); тот же состав — 200 без новой записи, другой состав под тем же именем — 409",
        requestBody: json(obj(["name", "files"], {
          name: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._-]+$" },
          files: arr(obj(["sha256", "role"], { sha256: { type: "string", maxLength: 64 }, role: { type: "string", enum: ["input", "labels"] } }), { minItems: 1, maxItems: 100_000 }),
        })),
        responses: { 200: ok("Печать уже есть с тем же составом", ref("HiddenSealCreated")), 201: ok("Печать создана", ref("HiddenSealCreated")), 400: err, 401: err, 403: err, 409: err },
      },
      get: { summary: "Печати скрытого теста (без состава файлов)", parameters: page(200), responses: { 200: ok("Печати (новые сверху)", arr(ref("HiddenSeal"))), 400: err, 401: err, 403: err } },
    },
    "/api/v1/ml/hidden-seals/{name}/verify": {
      post: {
        summary: "Сверить файлы прогона с печатью перед прогоном (OS-INSP-6.1.5): добавленные и пропавшие SHA-256",
        parameters: [pathParam("name")],
        requestBody: json(obj(["shas"], { shas: arr({ type: "string", maxLength: 64 }, { maxItems: 100_000 }) })),
        responses: {
          200: ok("Итог сверки", obj(["name", "digest", "ok", "added", "missing"], { name: S, digest: S, ok: B, added: arr(S), missing: arr(S) })),
          400: err, 401: err, 403: err, 404: err,
        },
      },
    },
    "/api/v1/ml/hidden-seals/{name}/runs": {
      post: {
        summary: "Записать ответ в журнал печати до подсчёта балла по меткам (OS-INSP-6.1.7)",
        parameters: [pathParam("name")],
        requestBody: json(obj(["answer_sha256", "model_version"], { answer_sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" }, model_version: { type: "string", minLength: 1, maxLength: 200 } })),
        responses: { 201: ok("Запись журнала", ref("HiddenSealRun")), 400: err, 401: err, 403: err, 404: err, 409: err },
      },
      get: { summary: "Журнал ответов печати", parameters: [pathParam("name"), ...page(200)], responses: { 200: ok("Записи журнала (по порядку записи)", arr(ref("HiddenSealRun"))), 400: err, 401: err, 403: err, 404: err } },
    },
    "/api/v1/ml/models/{model_version}/approve": {
      post: { summary: "Утвердить и опубликовать модель (супервизор); прежняя — SUPERSEDED и точка отката; хеши выборок сверяются с выпуском набора (T-234)", parameters: [pathParam("model_version")], responses: { 200: ok("Опубликовано", obj(["ok", "rollback_to"], { ok: { type: "boolean", enum: [true] }, rollback_to: Sn })), 403: err, 404: err, 409: err } },
    },
    "/api/v1/ml/models/{model_version}/rollback": {
      post: {
        summary: "Откатить действующую модель к версии rollback_to (OS-INSP-6.3.3, T-234): снимаемая — ROLLED_BACK, цель — снова в контуре; аудит MODEL_ROLLED_BACK",
        parameters: [pathParam("model_version")],
        requestBody: json(obj(["reason"], { reason: { type: "string", minLength: 3, maxLength: 2000 } })),
        responses: { 200: ok("Откат выполнен", obj(["ok", "rolled_back", "model_version", "deployed_at"], { ok: { type: "boolean", enum: [true] }, rolled_back: S, model_version: S, deployed_at: S })), 400: err, 401: err, 403: err, 404: err, 409: err },
      },
    },
    "/api/v1/ml/datasets/{dataset_version}/items": {
      get: {
        summary: "Элементы версии GOLD-набора (ТЗ §10 Dataset_Items) с числом фрагментов доказательной группы и сводкой годности к обучению (T-234)",
        parameters: [pathParam("dataset_version"), ...page(200)],
        responses: {
          200: ok("Сводка и элементы", obj(["dataset_version", "summary", "items"], {
            dataset_version: S,
            summary: obj(["items", "experts", "evidence_groups", "by_split", "by_reason", "issues"], { items: I, experts: I, evidence_groups: I, by_split: { type: "object", additionalProperties: I }, by_reason: arr(obj(["reason_code", "n"], { reason_code: S, n: I })), issues: arr(S) }),
            items: arr(ref("DatasetItem")),
          })),
          400: err, 401: err, 403: err, 404: err,
        },
      },
    },
    "/api/v1/ml/retraining-log": {
      get: { summary: "Журнал дообучения (ТЗ §10 ML_Retraining_Log; ADR-0011 — представление над model_versions)", parameters: page(200), responses: { 200: ok("Итерации (новые сверху)", arr(ref("RetrainingLogEntry"))), 400: err, 401: err, 403: err } },
    },
    "/api/v1/disputes/{id}/resolve": {
      post: {
        summary: "Закрыть спорный случай (OS-INSP-4.1.29, ТЗ §10 Dispute_Log.resolution_status, resolved_by): исход, автор, время, аудит DISPUTE_RESOLVED",
        parameters: [pathParam("id")],
        requestBody: json(obj(["resolution_status"], { resolution_status: { type: "string", enum: ["AI_UPHELD", "INSPECTOR_UPHELD", "WITHDRAWN"] }, comment: { type: "string", maxLength: 2000 } })),
        responses: { 200: ok("Спор закрыт", obj(["id", "resolution_status", "resolved_by", "resolved_at"], { id: I, resolution_status: S, resolved_by: S, resolved_at: S })), 400: err, 401: err, 403: err, 404: err, 409: err },
      },
    },
  },
};
