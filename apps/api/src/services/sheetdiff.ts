// OS-INSP-3.4 Выявить изменения листа между редакциями — IO: вызов ML /diff и запись проверок.
// Предметная часть (ответ ML → проверки и фрагменты, выбор пар редакций) — domain/sheetdiff.ts.
import type { DB } from "../db.ts";
import { statusAfterDecision } from "../domain/lifecycle.ts";
import { diffToChecks, pairKey, revisionPairs, SHEET_DIFF_CODE, type CheckDraft, type RevisionFile, type SheetRef } from "../domain/sheetdiff.ts";
import type { ProcessStatus } from "../domain/types.ts";
import { audit, log, notify } from "./audit.ts";
import { getInspection, HttpError, lockInspection, type Ctx } from "./inspections.ts";
import { diffSheets } from "./ml-client.ts";

const now = () => new Date().toISOString();

/** Автоматический режим включён по умолчанию; INSPECTOR_SHEET_DIFF_AUTO=0 — выключить (читается при каждом вызове). */
export const sheetDiffAutoEnabled = () => (process.env.INSPECTOR_SHEET_DIFF_AUTO ?? "1").trim() !== "0";

async function sheetRef(db: DB, inspectionId: string, fileId: string, page: number): Promise<SheetRef & { pages: number; kind: string }> {
  const f = await db.get<Record<string, any>>("select * from files where id = $1 and inspection_id = $2", [fileId, inspectionId]);
  if (!f) throw new HttpError(404, `Файл ${fileId} не принадлежит проверке ${inspectionId}`);
  const pages = f.pages_json ? (JSON.parse(f.pages_json) as unknown[]).length : 0;
  return { file_id: f.id, sha256: f.sha256, stage: f.doc_stage, document_code: f.document_code, revision: f.revision, approval_status: f.approval_status, page, pages, kind: f.kind };
}

/** Пара уже сравнивалась? (по ключу группы доказательств; у многообластного диффа ключ с суффиксом #n) */
async function pairDone(db: DB, inspectionId: string, group: string): Promise<boolean> {
  return Boolean(
    await db.get("select 1 from checks where inspection_id = $1 and param_code = $2 and (evidence_group_id = $3 or evidence_group_id like $4) limit 1", [inspectionId, SHEET_DIFF_CODE, group, `${group}#%`]),
  );
}

/**
 * Записать проверки пары листов. Пара уже сравнивалась — ничего не пишется (идемпотентно).
 * Проверка «уже сравнивалась» и вставка — одной транзакцией под блокировкой проверки: автоматический и ручной
 * режимы, сравнившие одну пару одновременно, не дублируют карточки.
 */
export async function writeSheetDiffChecks(db: DB, inspectionId: string, drafts: CheckDraft[], group: string, version: number): Promise<number> {
  const insCheck = `insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
      review_priority, reason, stage_notes_json, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
  const insFrag = `insert into evidence_fragments (check_id, file_id, sha256, stage, document_code, revision, approval_status, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
  return db.tx(async (t) => {
    await lockInspection(t, inspectionId);
    if (await pairDone(t, inspectionId, group)) return 0;
    for (const c of drafts) {
      await t.run(insCheck, [c.id, inspectionId, SHEET_DIFF_CODE, c.evidence_group_id, c.finding_status, "PENDING", c.expected_value, c.actual_value, c.delta, c.review_priority, c.reason, "[]", version, now(), now()]);
      for (const f of c.fragments)
        await t.run(insFrag, [c.id, f.file_id, f.sha256, f.stage, f.document_code, f.revision, f.approval_status, f.sheet_page, f.bbox ? JSON.stringify(f.bbox) : null, f.extracted_value, f.role]);
    }
    return drafts.length;
  });
}

/** Сравнить одну пару страниц: ML → проверки. Возвращает созданные проверки (пустой список — пара уже была). */
export async function compareSheets(db: DB, inspectionId: string, a: SheetRef, b: SheetRef, version: number): Promise<{ status: string; reason: string | null; created: number; regions: number }> {
  const insp = await getInspection(db, inspectionId);
  const group = pairKey(insp.object_id, a, b);
  if (await pairDone(db, inspectionId, group)) return { status: "already_compared", reason: null, created: 0, regions: 0 };
  const res = await diffSheets({ sha_a: a.sha256, page_a: a.page, sha_b: b.sha256, page_b: b.page }); // сеть — вне транзакции
  const drafts = diffToChecks(insp.object_id, a, b, { status: res.status, reason: res.reason, inliers: res.inliers, regions: res.regions });
  const created = await writeSheetDiffChecks(db, inspectionId, drafts, group, version);
  return { status: res.status, reason: res.reason, created, regions: res.regions.length };
}

/** Ручной режим: POST /api/v1/inspection/:id/sheet-diff. */
export async function sheetDiffRequest(ctx: Ctx, inspectionId: string, body: { file_a: string; page_a: number; file_b: string; page_b: number }) {
  const { db } = ctx;
  const insp = await getInspection(db, inspectionId);
  const st = insp.status as ProcessStatus;
  if (!["READY", "VERIFYING", "COMPLETED"].includes(st)) throw new HttpError(409, `Сравнение листов недоступно в статусе ${st}`);
  const a = await sheetRef(db, inspectionId, body.file_a, body.page_a);
  const b = await sheetRef(db, inspectionId, body.file_b, body.page_b);
  for (const s of [a, b]) {
    if (s.kind !== "pdf") throw new HttpError(415, "Сравнение листов — только для PDF");
    if (s.pages && s.page > s.pages) throw new HttpError(422, `В файле ${s.document_code} ${s.pages} стр., запрошена ${s.page}`);
  }
  const r = await compareSheets(db, inspectionId, a, b, insp.protocol_version);
  await db.tx(async (t) => {
    if (r.created) {
      // статус — по текущему (перечитан под блокировкой): за время запроса к ML его могли сменить решения инспектора
      const cur = (await lockInspection(t, inspectionId)).status as ProcessStatus;
      if (cur === "VERIFYING" || cur === "COMPLETED") {
        const checks = await t.all<any>("select finding_status, verification_status from checks where inspection_id = $1 and verification_status != 'SPLIT'", [inspectionId]);
        await t.run("update inspections set status = $1, updated_at = $2 where id = $3", [statusAfterDecision(checks), now(), inspectionId]);
      }
    }
    await audit({ ...ctx, db: t }, "SHEET_DIFF", inspectionId, { file_a: a.file_id, page_a: a.page, file_b: b.file_id, page_b: b.page, status: r.status, regions: r.regions, created: r.created });
  });
  return r;
}

/**
 * Автоматический режим (хук в конце разбора): пары редакций SUPERSEDED → CURRENT по predecessor,
 * совпадающие номера страниц. Сбой ML по одной странице не останавливает разбор — уведомление и дальше.
 */
export async function autoSheetDiff(db: DB, inspectionId: string): Promise<number> {
  if (!sheetDiffAutoEnabled()) return 0;
  const insp = await getInspection(db, inspectionId);
  const rows = await db.all<Record<string, any>>("select id, client_file_id, kind, document_code, predecessor_id, revision_role, parse_status, pages_json from files where inspection_id = $1 order by uploaded_at, id", [inspectionId]);
  const files: RevisionFile[] = rows.map((f) => ({ ...(f as any), pages: f.pages_json ? (JSON.parse(f.pages_json) as unknown[]).length : 0 }));
  let created = 0;
  for (const { a, b, pages } of revisionPairs(files)) {
    for (const p of pages) {
      try {
        const r = await compareSheets(db, inspectionId, await sheetRef(db, inspectionId, a.id, p), await sheetRef(db, inspectionId, b.id, p), insp.protocol_version + 1);
        created += r.created;
      } catch (e: any) {
        log("WARNING", "sheet-diff", { inspection_id: inspectionId, file_a: a.id, file_b: b.id, page: p, error: String(e?.message ?? e) });
        await notify(db, "inspector", inspectionId, "WARNING", `Сравнение листов ${a.document_code} (стр. ${p}) не выполнено: ${e?.message ?? e}`);
      }
    }
  }
  return created;
}
