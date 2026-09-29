// OS-INSP-6.4.4–6.4.9: IO управляемого дообучения — карточки из БД, регистрация итерации, оценка кандидатов.
// Предметная логика (признаки, обучение, метрики) — domain/retrain.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.ts";
import { meta, type DB } from "../db.ts";
import { publicationGate, datasetIssues, type DatasetItemRow } from "../domain/gold.ts";
import * as retrain from "../domain/retrain.ts";
import { ALGORITHM, DEFAULT_PARAMS, scoreCard, splitHashes, train, weightsHash, type CandidateCard, type LabeledCard, type RankingModel, type TrainParams } from "../domain/retrain.ts";
import { activeModel, artifactIntact, gatePrevious } from "../domain/model-registry.ts";
import { SHEET_DIFF_CODE, SHEET_DIFF_PARAM } from "../domain/sheetdiff.ts";
import { audit } from "./audit.ts";
import { trainingGuard } from "./hidden-seal.ts";
import { HttpError, type Ctx } from "./inspections.ts";

export const TrainBody = z.object({
  dataset_version: z.string().min(1).max(100),
  params: z.object({
    l2: z.number().positive().max(1e4),
    max_iter: z.number().int().min(1).max(200),
    min_recall: z.number().min(0).max(1),
    seed: z.string().min(1).max(64),
  }).partial().default({}),
});

/**
 * Хеш кода обучения: sha256 исходника domain/retrain.ts (сверяется `sha256sum`) + версия алгоритма.
 * В собранном образе исходника нет — тогда хешируется исполняемый текст функций модуля (префикс fn:).
 */
export function trainingCodeHash(): string {
  let src: string;
  let kind = "src";
  try {
    src = readFileSync(join(config.root, "apps/api/src/domain/retrain.ts"), "utf8");
  } catch {
    kind = "fn";
    src = Object.entries(retrain).filter(([, v]) => typeof v === "function").map(([k, v]) => `${k}:${String(v)}`).sort().join("\n");
  }
  return `${kind}:${createHash("sha256").update(src).digest("hex")}:${ALGORITHM}`;
}

const CARD_SQL = `select c.id finding_id, c.param_code, p.section, c.review_priority, p.compare_json, c.expected_value, c.actual_value,
    (select string_agg(distinct f.stage, ',' order by f.stage) from evidence_fragments f where f.check_id = c.id) stages,
    (select count(*) from evidence_fragments f where f.check_id = c.id) fragments,
    (select avg(e.confidence) from evidence_fragments f join extractions e on e.file_id = f.file_id and e.page = f.sheet_page and e.param_code = c.param_code
      where f.check_id = c.id) confidence
  from checks c left join params p on p.id = c.param_id`; // T-234: ссылка на Матрицу — Checks.param_id

function toCard(r: Record<string, any>): CandidateCard {
  return {
    finding_id: r.finding_id,
    section: r.section ?? (r.param_code === SHEET_DIFF_CODE ? SHEET_DIFF_PARAM.section : "—"),
    review_priority: r.review_priority ?? null,
    compare_kind: r.compare_json ? (JSON.parse(r.compare_json).kind ?? null) : null,
    expected_value: r.expected_value ?? null,
    actual_value: r.actual_value ?? null,
    confidence: r.confidence ?? null,
    stages: r.stages ? String(r.stages).split(",") : [],
    fragments: r.fragments ?? 0,
  };
}

/** Карточки выпущенного набора с метками и выборками. Состав сверяется с хешами, записанными при выпуске. */
export async function datasetCards(db: DB, datasetVersion: string): Promise<LabeledCard[]> {
  const ds = await db.get<{ split_hashes_json: string }>("select split_hashes_json from dataset_versions where dataset_version = $1", [datasetVersion]);
  if (!ds) throw new HttpError(404, `Версия набора ${datasetVersion} не найдена`);
  // порядок — побайтовый (collate "C"), как в SQLite: от порядка карточек зависит обучение и хеш весов, а не от локали сервера
  const rows = await db.all<Record<string, any>>(`select x.*, di.gold_label, di.split from dataset_items di join (${CARD_SQL}) x on x.finding_id = di.finding_id
      where di.dataset_version = $1 order by di.finding_id collate "C"`, [datasetVersion]);
  const cards = rows.map((r) => ({ ...toCard(r), gold_label: r.gold_label, split: r.split }) as LabeledCard);
  const want = JSON.parse(ds.split_hashes_json);
  const got = splitHashes(cards);
  const bad = (["train", "validation", "test"] as const).filter((s) => want[s] !== got[s]);
  if (bad.length) throw new HttpError(409, `Состав набора ${datasetVersion} расходится с выпущенным (${bad.join(", ")}): карточки кандидатов изменены или удалены`, { expected: want, actual: got });
  return cards;
}

/** Элементы выпущенной версии набора — поля ТЗ §10 Dataset_Items (T-234). */
export async function datasetItems(db: DB, datasetVersion: string): Promise<DatasetItemRow[]> {
  return db.all<DatasetItemRow>(`select finding_id, evidence_group_id, gold_label, expert_id, reason_code, split, object_group_id from dataset_items
      where dataset_version = $1 order by finding_id collate "C"`, [datasetVersion]);
}

export interface TrainOutcome {
  model_version: string;
  approval_status: "AWAITING_APPROVAL" | "REJECTED_BY_GATE";
  weights_hash: string;
  gate: { ok: boolean; reasons: string[] };
  metrics: retrain.RetrainMetrics;
  previous_model: string;
}

/** OS-INSP-6.4.4–6.4.8: итерация дообучения. Модель не публикуется: ворота 6.3.1, затем подпись (6.3.2). */
export async function trainIteration(ctx: Ctx, datasetVersion: string, over: Partial<TrainParams> = {}): Promise<TrainOutcome> {
  const { db } = ctx;
  const params: TrainParams = { ...DEFAULT_PARAMS, ...over };
  const cards = await datasetCards(db, datasetVersion);
  // OS-INSP-6.1.10 (T-234, ТЗ §10 Dataset_Items): доказательная группа — в одной выборке, у каждой метки — эксперт
  const issues = datasetIssues(await datasetItems(db, datasetVersion));
  if (issues.length) {
    await audit(ctx, "MODEL_TRAINING_REFUSED", datasetVersion, { reasons: issues, params });
    throw new HttpError(422, `Дообучение невозможно: ${issues.join("; ")}`, { reasons: issues });
  }
  // OS-INSP-6.1.8, 6.1.9 (T-137): скрытый тест не идёт в обучение, порог (chooseThreshold) — только на validation без пересечений
  const hidden = await trainingGuard(db, datasetVersion);
  if (hidden.reasons.length) {
    await audit(ctx, "MODEL_TRAINING_REFUSED", datasetVersion, { reasons: hidden.reasons, ...hidden.details, params });
    throw new HttpError(422, `Дообучение невозможно: ${hidden.reasons.join("; ")}`, { reasons: hidden.reasons, ...hidden.details });
  }
  const r = train(cards, params);
  if (!r.ok) {
    await audit(ctx, "MODEL_TRAINING_REFUSED", datasetVersion, { reasons: r.reasons, params });
    throw new HttpError(422, `Дообучение невозможно: ${r.reasons.join("; ")}`, { reasons: r.reasons });
  }
  // регистрация итерации — одной транзакцией: номер версии, строка реестра и аудит.
  // Номер берётся под advisory-lock: два параллельных обучения не получат один rank-…-vN (model_version unique).
  return db.tx(async (t) => {
    await t.run("select pg_advisory_xact_lock(hashtext('inspector:model_versions'))");
    // T-234: действующая модель — по вводу в контур (deployed_at); Recall категорий — из её журнала дообучения
    const published = activeModel(await t.all<{ model_version: string; metrics_json: string; per_category_metrics_json: string | null; approval_status: string; deployed_at: string | null }>(
      "select model_version, metrics_json, per_category_metrics_json, approval_status, deployed_at from model_versions where approval_status = 'PUBLISHED'"));
    const gate = publicationGate(gatePrevious(published ?? undefined), r.metrics);
    const n = (await t.get<{ n: number }>("select count(*) n from model_versions"))!.n + 1;
    const version = `rank-${new Date().toISOString().slice(0, 10)}-v${n}`;
    const previous = published?.model_version ?? (await meta(t, "model_version"));
    const status = gate.ok ? "AWAITING_APPROVAL" : "REJECTED_BY_GATE";
    await t.run(`insert into model_versions (model_version, artifact_hash, dataset_version, metrics_json, approval_status, created_at,
        matrix_version, split_hashes_json, training_code_hash, training_params_json, weights_json, weights_hash, per_category_metrics_json, trained_by, previous_model, gate_json)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
      version, r.weights_hash, datasetVersion, JSON.stringify(r.metrics), status, new Date().toISOString(),
      await meta(t, "matrix_version"), JSON.stringify(r.split_hashes), trainingCodeHash(), JSON.stringify(params), JSON.stringify(r.model), r.weights_hash,
      JSON.stringify(r.metrics.per_category), ctx.user.id, previous, JSON.stringify(gate),
    ]);
    await audit({ ...ctx, db: t }, "MODEL_TRAINED", version, { dataset_version: datasetVersion, weights_hash: r.weights_hash, gate, previous_model: previous });
    return { model_version: version, approval_status: status, weights_hash: r.weights_hash, gate, metrics: r.metrics, previous_model: previous };
  });
}

/**
 * Действующая модель ранжирования: опубликована и несёт веса (зарегистрированные вручную весов не имеют).
 * T-234 (ТЗ §10 Model_Versions.artifact_hash): хеш весов сверяется с artifact_hash реестра — подменённые или
 * повреждённые веса не применяются, пишется запись аудита MODEL_ARTIFACT_MISMATCH.
 */
export async function publishedRanking(db: DB): Promise<RankingModel | null> {
  const m = await db.get<{ model_version: string; weights_json: string; artifact_hash: string | null }>(
    "select model_version, weights_json, artifact_hash from model_versions where model_version = $1 and approval_status = 'PUBLISHED' and weights_json is not null",
    [await meta(db, "model_version")],
  );
  if (!m) return null;
  const model = JSON.parse(m.weights_json) as RankingModel;
  const actual = weightsHash(model);
  if (!artifactIntact(m.artifact_hash, actual)) {
    await audit(schedulerCtx(db), "MODEL_ARTIFACT_MISMATCH", m.model_version, { artifact_hash: m.artifact_hash, actual });
    return null;
  }
  return model;
}

const schedulerCtx = (db: DB): Ctx => ({ db, user: { id: "system", login: "system", name: "Система", role: "admin" } });

/**
 * OS-INSP-6.4.9: при расчёте протокола — оценка вероятности нарушения каждому CANDIDATE. Статус кандидата и
 * решение инспектора не трогаются; без действующей модели ранжирования оценки нет.
 * Вызывается внутри транзакции пересчёта протокола: ходит в базу только через переданный db.
 */
export async function writeAiScores(db: DB, inspectionId: string): Promise<void> {
  await db.run("update checks set ai_score = null where inspection_id = $1", [inspectionId]);
  const model = await publishedRanking(db);
  if (!model) return;
  const rows = await db.all<Record<string, any>>(`${CARD_SQL} where c.inspection_id = $1 and c.finding_status = 'CANDIDATE' order by c.id`, [inspectionId]);
  for (const r of rows) await db.run("update checks set ai_score = $1 where id = $2", [Math.round(scoreCard(model, toCard(r)) * 1e4) / 1e4, r.finding_id]);
}
