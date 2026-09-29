// ТЗ §10 Model_Versions и ML_Retraining_Log (T-234, ADR-0011): правила реестра моделей — сведения обучения при
// регистрации, сверка перед публикацией, действующая модель, откат к предыдущей версии. Чистые функции; IO — app.ts,
// services/retrain.ts.
import type { ModelMetrics } from "./gold.ts";

/** Статусы допуска: к CHECK 0002 миграция 0015 добавила SUPERSEDED (заменена новой) и ROLLED_BACK (снята откатом). */
export const APPROVAL_STATUSES = ["AWAITING_APPROVAL", "REJECTED_BY_GATE", "PUBLISHED", "SUPERSEDED", "ROLLED_BACK"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Метрика категории (раздела Матрицы): у обученной итерации — объём и FPR, у зарегистрированной вручную — Recall. */
export interface CategoryMetric {
  n?: number;
  positives?: number;
  recall: number | null;
  false_positive_rate?: number | null;
}
export type PerCategory = Record<string, CategoryMetric>;

/** ML_Retraining_Log.per_category_metrics при ручной регистрации — из recall_by_category метрик (OS-INSP-6.4.5). */
export function perCategoryFromRecall(recallByCategory: Record<string, number>): PerCategory {
  return Object.fromEntries(Object.entries(recallByCategory).map(([k, v]) => [k, { recall: v }]));
}

/**
 * Recall по категориям для ворот 6.3.1 — из per_category_metrics_json предыдущей модели. Категория без Recall
 * (нет положительных) в сравнение не входит. Колонки нет (строка до T-234) — null: ворота берут metrics_json.
 */
export function categoryRecalls(perCategoryJson: string | null | undefined): Record<string, number> | null {
  if (!perCategoryJson) return null;
  const pc = JSON.parse(perCategoryJson) as PerCategory;
  return Object.fromEntries(Object.entries(pc).filter(([, m]) => typeof m?.recall === "number").map(([k, m]) => [k, m.recall as number]));
}

/** Метрики предыдущей модели для ворот: общие — из metrics_json, по категориям — из журнала дообучения. */
export function gatePrevious(row: { metrics_json: string; per_category_metrics_json?: string | null } | undefined): ModelMetrics | null {
  if (!row) return null;
  const m = JSON.parse(row.metrics_json) as ModelMetrics;
  return { ...m, recall_by_category: categoryRecalls(row.per_category_metrics_json) ?? m.recall_by_category ?? {} };
}

export interface ModelRow {
  model_version: string;
  approval_status: string;
  dataset_version: string | null;
  split_hashes_json: string | null;
  artifact_hash: string | null;
  weights_hash?: string | null;
  rollback_to: string | null;
  deployed_at: string | null;
  approved_by: string | null;
}

export type Check = { ok: true } | { ok: false; status: 404 | 409; error: string };

/**
 * Сверка перед публикацией (OS-INSP-6.3.2, T-234): модель обучена на той версии набора, что выпущена, — хеши выборок
 * ML_Retraining_Log.split_hashes совпадают с хешами выпуска Dataset_Versions. Набор не выпущен (ручная регистрация
 * внешней модели) или хешей нет — сверять не с чем, публикация не блокируется.
 */
export function splitHashesMatch(modelSplitHashes: string | null, datasetSplitHashes: string | null): Check {
  if (!modelSplitHashes || !datasetSplitHashes) return { ok: true };
  const a = JSON.parse(modelSplitHashes) as Record<string, string>;
  const b = JSON.parse(datasetSplitHashes) as Record<string, string>;
  const bad = ["train", "validation", "test"].filter((s) => a[s] !== b[s]);
  return bad.length ? { ok: false, status: 409, error: `Хеши выборок модели не совпадают с выпуском набора (${bad.join(", ")}) — модель обучена не на этой версии` } : { ok: true };
}

/**
 * Действующая модель — опубликованная с последним вводом в контур (deployed_at), а не последняя по номеру:
 * после отката в контуре может стоять более ранняя версия.
 */
export function activeModel<T extends Pick<ModelRow, "approval_status" | "deployed_at">>(rows: T[]): T | null {
  const live = rows.filter((r) => r.approval_status === "PUBLISHED");
  if (!live.length) return null;
  return live.reduce((a, b) => (new Date(b.deployed_at ?? 0).getTime() > new Date(a.deployed_at ?? 0).getTime() ? b : a));
}

export interface RollbackPlan {
  /** снимаемая версия — ROLLED_BACK */
  from: string;
  /** версия, к которой откатываемся: meta.model_version; есть в реестре — снова PUBLISHED с новым deployed_at */
  to: string;
  toInRegistry: boolean;
}

/**
 * Откат модели к предыдущей версии (OS-INSP-6.3.3, ТЗ §10 Model_Versions.rollback_to): снять можно только действующую
 * опубликованную модель, и только если у неё записана точка отката. Цель — из rollback_to, записанного при публикации;
 * если цель в реестре снята откатом, откат на неё не выполняется (цепочку восстанавливают публикацией, а не откатом).
 */
export function rollbackPlan(current: ModelRow | undefined, activeVersion: string, registry: Pick<ModelRow, "model_version" | "approval_status">[]): { ok: true; plan: RollbackPlan } | { ok: false; status: 404 | 409; error: string } {
  if (!current) return { ok: false, status: 404, error: "Модель не найдена" };
  if (current.approval_status !== "PUBLISHED") return { ok: false, status: 409, error: `Модель в статусе ${current.approval_status} — откатывается только опубликованная` };
  if (current.model_version !== activeVersion) return { ok: false, status: 409, error: `В контуре модель ${activeVersion}, а не ${current.model_version} — откатывается только действующая` };
  if (!current.rollback_to) return { ok: false, status: 409, error: "У модели нет точки отката (rollback_to)" };
  const target = registry.find((r) => r.model_version === current.rollback_to);
  if (target && target.approval_status === "ROLLED_BACK") return { ok: false, status: 409, error: `Точка отката ${current.rollback_to} сама снята откатом — опубликуйте нужную версию заново` };
  return { ok: true, plan: { from: current.model_version, to: current.rollback_to, toInRegistry: Boolean(target) } };
}

/**
 * Целостность весов действующей модели (T-234, ТЗ §10 Model_Versions.artifact_hash): хеш весов, пересчитанный при
 * загрузке, совпадает с artifact_hash реестра. Не совпал — веса подменены или повреждены: модель не применяется.
 */
export function artifactIntact(artifactHash: string | null, actualHash: string): boolean {
  return Boolean(artifactHash) && artifactHash === actualHash;
}
