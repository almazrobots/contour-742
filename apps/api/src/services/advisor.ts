// OS-INSP-3.2.4, 3.2.5, 3.2.7 LLM-советник и перевод гипотезы в кандидаты (T-034).
// Советник только предлагает: ML проверяет у каждой гипотезы файл, страницу, bbox и дословную цитату
// и отбрасывает всё, что не подтверждается текстом. Принятые — SUSPICION с методом LLM_ADVISOR и ссылкой,
// отклонённые — в журнал аудита с кодом причины. В CANDIDATE гипотезу переводит только инспектор.
import { createHash, randomUUID } from "node:crypto";
import type { DB } from "../db.ts";
import { canVerify } from "../domain/lifecycle.ts";
import { advisorDedupKey, promotionError, suspicionParamCode, type EvidenceRef } from "../domain/suspicions.ts";
import type { ProcessStatus } from "../domain/types.ts";
import { audit, log } from "./audit.ts";
import { getInspection, HttpError, loadParams, type Ctx } from "./inspections.ts";
import { blobStore } from "./blobstore.ts";
import { attachNorms, mlPost } from "./norms.ts";

export interface AdvisorHypothesis {
  description: string;
  sha256: string;
  page: number;
  bbox: [number, number, number, number];
  quote: string;
  evidence_bbox?: [number, number, number, number];
  match_score?: number;
}

export interface AdviseResponse {
  provider: string;
  available: boolean;
  accepted: AdvisorHypothesis[];
  rejected: Array<{ reason: string; detail?: string; description?: string; sha256?: string; page?: unknown; quote?: string }>;
}

const now = () => new Date().toISOString();
/** Действия советника в журнале аудита выполняет система, не пользователь. */
const systemCtx = (db: DB): Ctx => ({ db, user: { id: "system", login: "system", name: "Советник ИИ", role: "admin" } });

/**
 * Вызвать советника по разобранным файлам проверки. Провайдер недоступен — ничего не пишем.
 * Возвращает число принятых и отклонённых гипотез.
 */
export async function runAdvisor(db: DB, inspectionId: string): Promise<{ available: boolean; accepted: number; rejected: number }> {
  const insp = await getInspection(db, inspectionId);
  const files = await db.all<{ id: string; sha256: string; doc_stage: string; document_code: string; revision: string }>(
    "select id, sha256, doc_stage, document_code, revision from files where inspection_id = $1 and parse_status = 'DONE' and coalesce(revision_role, '') != 'SUPERSEDED' order by id",
    [inspectionId],
  );
  if (!files.length) return { available: false, accepted: 0, rejected: 0 };
  const params = (await loadParams(db)).map((p) => ({ code: p.code, anchors: p.anchors, data_type: p.data_type, regex_pattern: p.regex_pattern, compare_kind: p.compare.kind }));
  // NFR-CRYPTO: ML берёт разбор из кэша, а при промахе — файл из рабочего каталога; выложить заранее. Нет файла —
  // не отказ здесь: ML ответит 404 по своему правилу, советник это уже обрабатывает
  for (const sha of new Set(files.map((f) => f.sha256))) await blobStore().localPath(sha).catch(() => undefined);
  const res = await mlPost<AdviseResponse>("/advise", { sha256: [...new Set(files.map((f) => f.sha256))], params }, 300_000);
  if (!res.available) return { available: false, accepted: 0, rejected: 0 };
  const bySha = new Map(files.map((f) => [f.sha256, f]));
  // гипотезы и журнал отказов — одной транзакцией: прогон советника виден целиком или не виден вовсе
  return db.tx(async (t) => {
    let accepted = 0;
    for (const h of res.accepted) {
      const f = bySha.get(h.sha256);
      if (!f) continue; // ML проверил sha по переданному списку; здесь — страховка
      const ref = `${f.document_code}, ред. ${f.revision}, стр. ${h.page}`;
      const link = { file_id: f.id, sha256: h.sha256, page: h.page, bbox: h.bbox, quote: h.quote, evidence_bbox: h.evidence_bbox ?? null, match_score: h.match_score ?? null, provider: res.provider };
      // уверенность советника не откалибрована — фиксированная низкая, решение за инспектором
      await t.run(`insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, pd_reference, rd_reference, review_priority, normative_base, dedup_key, advisor_ref_json)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (inspection_id, dedup_key) do update set description = excluded.description, advisor_ref_json = excluded.advisor_ref_json`, [
        inspectionId, insp.object_id, "LLM_ADVISOR", 0.5, h.description, f.doc_stage === "PD" ? ref : null, f.doc_stage === "PD" ? null : ref, "MEDIUM", null,
        advisorDedupKey(h.sha256, h.page, h.quote), JSON.stringify(link),
      ]);
      accepted++;
    }
    // OS-INSP-3.2.5: причина отказа — в журнал аудита
    for (const r of res.rejected) await audit(systemCtx(t), "ADVISOR_HYPOTHESIS_REJECTED", inspectionId, { provider: res.provider, ...r });
    await audit(systemCtx(t), "ADVISOR_RUN", inspectionId, { provider: res.provider, accepted, rejected: res.rejected.length });
    return { available: true, accepted, rejected: res.rejected.length };
  });
}

/** Фоновый вызов после разбора: советник, затем подбор норм к его гипотезам. Ошибки только в журнал. */
export function runAdvisorLater(db: DB, inspectionId: string): void {
  void runAdvisor(db, inspectionId)
    .then((r) => (r.accepted ? attachNorms(db, inspectionId) : 0))
    .catch((e) => log("WARNING", `советник не выполнен: ${e?.message ?? e}`, { inspection_id: inspectionId }));
}

/**
 * OS-INSP-3.2.7: перевести гипотезу в CANDIDATE. Нужны файл проверки, страница и bbox;
 * создаётся проверка с param_code SUSP-<id> и фрагментом доказательства. Решение остаётся за инспектором.
 */
export async function promoteSuspicion(ctx: Ctx, suspicionId: number, ref: Partial<EvidenceRef>): Promise<{ check_id: string }> {
  const { db } = ctx;
  const s = await db.get<Record<string, any>>("select * from suspicions where id = $1", [suspicionId]);
  if (!s) throw new HttpError(404, "Гипотеза не найдена");
  const insp = await getInspection(db, s.inspection_id);
  if (insp.status === "FINALIZED") throw new HttpError(409, "Протокол финализирован");
  // до финализации: READY, VERIFYING и COMPLETED (новый кандидат вернёт проверку в VERIFYING)
  if (!canVerify(insp.status as ProcessStatus) && insp.status !== "COMPLETED") throw new HttpError(409, `Перевод в кандидаты недоступен в статусе ${insp.status}`);
  if (s.promoted_check_id) throw new HttpError(409, "Гипотеза уже переведена в кандидаты", { check_id: s.promoted_check_id });
  const files = await db.all<Record<string, any>>("select * from files where inspection_id = $1", [s.inspection_id]);
  const err = promotionError(ref, new Set(files.map((f) => f.id as string)));
  if (err) throw new HttpError(400, err);
  const f = files.find((x) => x.id === ref.file_id)!;
  const code = suspicionParamCode(s.id);
  const checkId = `F-${insp.object_id}-${code}`.replace(/[^\w-]/g, "") + "-" + randomUUID().slice(0, 4);
  const group = `${insp.object_id}:${code}:${createHash("sha256").update(`${f.id}@${ref.page}`).digest("hex").slice(0, 10)}`;
  const quote = ref.quote ?? (s.advisor_ref_json ? JSON.parse(s.advisor_ref_json).quote : null);
  await db.tx(async (t) => {
    // гонка двух переводов одной гипотезы: отметка ставится только на непереведённую, второй получает 409
    const mark = await t.run("update suspicions set promoted_check_id = $1, inspector_status = 'ACCEPTED' where id = $2 and promoted_check_id is null", [checkId, s.id]);
    if (!mark.rowCount) throw new HttpError(409, "Гипотеза уже переведена в кандидаты");
    await t.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
        review_priority, reason, stage_notes_json, title, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
      checkId, s.inspection_id, code, group, "CANDIDATE", "PENDING", null, quote, null, s.review_priority ?? "MEDIUM",
      `Гипотеза вне Матрицы переведена в кандидаты инспектором: ${s.description}`, "[]", `Гипотеза #${s.id}: ${String(s.description ?? "").slice(0, 120)}`, insp.protocol_version, now(), now(),
    ]);
    await t.run(`insert into evidence_fragments (check_id, file_id, sha256, stage, document_code, revision, approval_status, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [checkId, f.id, f.sha256, f.doc_stage, f.document_code, f.revision, f.approval_status, ref.page!, JSON.stringify(ref.bbox), quote, "actual"]);
    if (insp.status === "COMPLETED") await t.run("update inspections set status = 'VERIFYING', updated_at = $1 where id = $2 and status = 'COMPLETED'", [now(), s.inspection_id]);
    await audit({ ...ctx, db: t }, "SUSPICION_PROMOTED", s.inspection_id, { suspicion_id: s.id, check_id: checkId, file_id: f.id, page: ref.page, bbox: ref.bbox });
  });
  return { check_id: checkId };
}
