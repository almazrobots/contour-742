// OS-INSP-5.1.2, 5.2.4: запись о применении ИИ-средства для акта контрольного (надзорного) мероприятия.
// Основание — ПП Москвы от 15.12.2021 № 2078-ПП, разд. 9(1) (ред. № 1318-ПП от 12.05.2026): в акте делается запись
// о факте применения средства, перечисляются полученные с его помощью данные и прилагаются материалы (п. 9(1).8);
// данные должны быть верифицируемыми (п. 9(1).3.3); перед применением проверяется исправность (п. 9(1).5);
// сведения размещаются в ИАИС «РиН» (п. 9(1).10). «Инспектор ИИ» — программный продукт на основе моделей
// машинного обучения (прил. 2, п. 2).
import { createHash } from "node:crypto";

export const LEGAL_BASIS =
  "ПП Москвы от 15.12.2021 № 2078-ПП, п. 9(1).8, 9(1).10 и прил. 2 п. 2 (ред. постановления Правительства Москвы от 12.05.2026 № 1318-ПП)";
export const TOOL_NAME = "Инспектор ИИ";
export const TOOL_CATEGORY = "Программный продукт на основе моделей машинного обучения (прил. 2, п. 2 к Положению)";

export interface UsageFile {
  file_id: string;
  file_name: string;
  sha256: string;
  engine?: string | null;
  parse_status?: string | null;
}

export interface UsageCheck {
  param_code: string;
  parameter_name: string;
  finding_status: string;
  verification_status: string;
  expected_value: string | null;
  actual_value: string | null;
  fragments: Array<{ file_id: string; sha256: string; sheet_page: number | null; bbox_polygon_norm: string | null; extracted_value: string | null }>;
}

export interface UsageInput {
  process_id: string;
  object_name: string;
  generated_at: string;
  versions: { protocol: number; matrix: string; model: string; dataset: string; input_manifest_hash: string };
  files: UsageFile[];
  checks: UsageCheck[];
  /** Протокол без раздела ai_usage — приложение к акту; его хеш делает данные проверяемыми. */
  protocol_body: unknown;
}

const STATUS_RU: Record<string, string> = {
  CANDIDATE: "кандидат в нарушение",
  NEGATIVE_VERIFIED: "расхождение не выявлено",
  MISSING_EVIDENCE: "недостаточно источников",
  NOT_APPLICABLE: "параметр неприменим",
  NOT_COMPARABLE: "значения несопоставимы",
  CLARIFICATION_REQUIRED: "требуется уточнение редакции",
};
const DECISION_RU: Record<string, string> = {
  PENDING: "решение инспектора не принято",
  CONFIRMED_VIOLATION: "подтверждено инспектором",
  NEGATIVE_VERIFIED: "отклонено инспектором",
  CLARIFICATION_REQUIRED: "инспектор запросил уточнение",
};

/** Канонический JSON: ключи по алфавиту — один и тот же протокол даёт один и тот же хеш. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function aiUsageRecord(p: UsageInput) {
  // исправность (п. 9(1).5): данные полны, только если КАЖДЫЙ файл разобран; «ещё разбирается» — тоже не исправно
  const failed = p.files.filter((f) => f.parse_status !== "DONE");
  const engines = [...new Set(p.files.map((f) => f.engine).filter((e): e is string => Boolean(e)))].sort();
  const data = p.checks.map((c) => ({
    param_code: c.param_code,
    parameter_name: c.parameter_name,
    system_result: STATUS_RU[c.finding_status] ?? c.finding_status,
    inspector_decision: DECISION_RU[c.verification_status] ?? c.verification_status,
    expected: c.expected_value,
    actual: c.actual_value,
    sources: c.fragments.map((f) => ({
      file_name: p.files.find((x) => x.file_id === f.file_id)?.file_name ?? f.file_id,
      sha256: f.sha256,
      page: f.sheet_page,
      bbox: f.bbox_polygon_norm ? JSON.parse(f.bbox_polygon_norm) : null,
      value: f.extracted_value,
    })),
  }));
  // T-133: полученными считаются только данные с источником; проверка без значения в комплекте — не «получено данных»
  const summary = { checked: data.length, with_sources: data.filter((d) => d.sources.length > 0).length, not_found: data.filter((d) => d.sources.length === 0).length };
  const attachment = {
    name: `Протокол проверки ${p.process_id}, версия ${p.versions.protocol} (JSON)`,
    sha256: createHash("sha256").update(canonical(p.protocol_body)).digest("hex"),
  };
  const serviceable = failed.length === 0;
  const act_text = [
    `При проведении мероприятия по объекту «${p.object_name}» применено программное средство «${TOOL_NAME}» — ${TOOL_CATEGORY[0].toLowerCase() + TOOL_CATEGORY.slice(1)}; основание: ${LEGAL_BASIS}.`,
    `Дата и время применения: ${p.generated_at}. Версия модели: ${p.versions.model}; версия Матрицы контроля: ${p.versions.matrix}; версия набора данных: ${p.versions.dataset}.`,
    serviceable
      ? `Средство исправно: все ${p.files.length} файлов комплекта обработаны (${engines.join(", ") || "без распознавания"}).`
      : `Средство применено с отказами: не обработаны файлы ${failed.map((f) => f.file_name).join(", ")} — данные по ним не получены.`,
    `С применением средства проверено параметров Матрицы — ${summary.checked}; данные с источником (файл, страница, координаты) получены по ${summary.with_sources}${summary.not_found ? `, по ${summary.not_found} значение в комплекте не найдено` : ""}; кандидатов в нарушения — ${p.checks.filter((c) => c.finding_status === "CANDIDATE").length}, подтверждено инспектором — ${p.checks.filter((c) => c.verification_status === "CONFIRMED_VIOLATION").length}. Перечень данных с указанием файлов, страниц и координат — в приложении.`,
    `Прилагается: ${attachment.name}, SHA-256 ${attachment.sha256}. Реестр входных файлов — ${p.files.length} шт., хеш реестра ${p.versions.input_manifest_hash || "не задан"}.`,
  ].join("\n");
  return {
    legal_basis: LEGAL_BASIS,
    tool: { name: TOOL_NAME, category: TOOL_CATEGORY, model_version: p.versions.model, matrix_version: p.versions.matrix, dataset_version: p.versions.dataset },
    applied_at: p.generated_at,
    serviceability: { ok: serviceable, engines, files_total: p.files.length, files_failed: failed.map((f) => ({ file_name: f.file_name, sha256: f.sha256 })) },
    data,
    summary,
    attachments: [attachment, { name: "Реестр входных файлов", sha256: p.versions.input_manifest_hash || null }],
    act_text,
  };
}

export type AiUsage = ReturnType<typeof aiUsageRecord>;

/**
 * OS-INSP-5.2.1 + 5.2.4: в ИАИС «РиН» уходят только подтверждённые инспектором записи — в том числе в перечне
 * данных записи о применении ИИ. Неподтверждённые кандидаты, отрицательные результаты и пр. остаются в акте
 * и протоколе Комитета, но не передаются во внешнюю систему.
 */
export function aiUsageForRin(r: AiUsage | null | undefined): AiUsage | null {
  if (!r) return null;
  return { ...r, data: r.data.filter((d) => d.inspector_decision === "подтверждено инспектором") };
}
