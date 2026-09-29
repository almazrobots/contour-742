// OS-INSP-2.3 Реквизиты документа: хранение находок ML (2.3.1) и проверки REQ-<файл> в протоколе (2.3.2).
import { createHash, randomUUID } from "node:crypto";
import type { DB } from "../db.ts";
import { evaluateRequisites, type FoundRequisite, type IdDoc } from "../domain/requisites.ts";
import type { MlResponse } from "./ml-client.ts";

const now = () => new Date().toISOString();

/** Сохранить реквизиты из разбора ML. Вызывается в транзакции разбора. */
export async function saveRequisites(db: DB, fileId: string, res: Pick<MlResponse, "requisites">): Promise<void> {
  await db.run("delete from requisites where file_id = $1", [fileId]);
  const ins = "insert into requisites (file_id, page, kind, bbox_json, confidence) values ($1,$2,$3,$4,$5)";
  for (const p of res.requisites ?? []) for (const r of p.items) await db.run(ins, [fileId, p.page, r.kind, r.bbox ? JSON.stringify(r.bbox) : null, r.confidence]);
}

/**
 * Пересчитать проверки REQ-<файл>: документы ИД без обязательного реквизита. Решение инспектора сохраняется,
 * пока находка не изменилась; реквизит появился (новая редакция) — проверка уходит из протокола.
 * Вызывается из recompute в его транзакции.
 */
export async function writeRequisites(db: DB, inspectionId: string, version: number): Promise<void> {
  const insp = (await db.get<{ object_id: string }>("select object_id from inspections where id = $1", [inspectionId]))!;
  const rows = await db.all<Omit<IdDoc, "requisites" | "signature_check"> & { signature_check_json: string | null }>(`select id file_id, client_file_id, sha256, file_name, kind, document_code,
      revision, approval_status, revision_role, signature_status, signature_check_json, doc_title title
      from files where inspection_id = $1 and doc_stage = 'ID' and parse_status = 'DONE' order by uploaded_at, id`, [inspectionId]);
  const docs: IdDoc[] = [];
  for (const { signature_check_json, ...d } of rows) {
    const found = await db.all<Record<string, any>>("select kind, page, bbox_json, confidence from requisites where file_id = $1 order by id", [d.file_id]);
    docs.push({
      ...d,
      signature_check: signature_check_json ? JSON.parse(signature_check_json) : null, // OS-INSP-1.2.14
      requisites: found.map((r): FoundRequisite => ({ kind: r.kind, page: r.page, bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null, confidence: r.confidence })),
    });
  }
  const byId = new Map(docs.map((d) => [d.file_id, d]));
  const existing = new Map((await db.all<Record<string, any>>("select * from checks where inspection_id = $1 and parent_id is null and param_code like 'REQ-%'", [inspectionId])).map((c) => [c.param_code as string, c]));
  const insFrag = `insert into evidence_fragments (check_id, file_id, sha256, stage, document_code, revision, approval_status, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
  for (const rc of evaluateRequisites(docs)) {
    const d = byId.get(rc.file_id)!;
    const group = `${insp.object_id}:${rc.param_code}:${createHash("sha256").update(d.sha256).digest("hex").slice(0, 10)}`;
    const prev = existing.get(rc.param_code);
    existing.delete(rc.param_code);
    let id: string;
    if (!prev) {
      id = `F-${insp.object_id}-${rc.param_code}`.replace(/[^\w-]/g, "") + "-" + randomUUID().slice(0, 4);
      await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
          review_priority, reason, stage_notes_json, title, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
        id, inspectionId, rc.param_code, group, rc.status, "PENDING", rc.expected, rc.actual, null, "MEDIUM", rc.reason, null, rc.title, version, now(), now(),
      ]);
    } else {
      id = prev.id;
      let verification = prev.verification_status;
      if ((prev.actual_value !== rc.actual || prev.evidence_group_id !== group) && verification !== "PENDING") {
        await db.run("update decisions set superseded = true where check_id = $1 and not superseded", [id]);
        verification = "PENDING";
      }
      await db.run(`update checks set evidence_group_id = $1, finding_status = $2, verification_status = $3, expected_value = $4, actual_value = $5, reason = $6, title = $7,
          computed_in_version = $8, updated_at = $9 where id = $10`, [group, rc.status, verification, rc.expected, rc.actual, rc.reason, rc.title, version, now(), id]);
      await db.run("delete from evidence_fragments where check_id = $1", [id]);
    }
    await db.run(insFrag, [id, d.file_id, d.sha256, "ID", d.document_code, d.revision, d.approval_status, 1, null, rc.actual ?? "реквизит не найден", "actual"]);
  }
  for (const stale of existing.values()) {
    await db.run("delete from evidence_fragments where check_id = $1", [stale.id]);
    await db.run("update decisions set superseded = true where check_id = $1 and not superseded", [stale.id]);
    await db.run("delete from checks where id = $1", [stale.id]);
  }
}
