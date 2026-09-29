// OS-INSP-1.4.4 Скрытые работы: хранение перечня из разбора ML и проверки HW-<n> в протоколе.
import { createHash, randomUUID } from "node:crypto";
import type { DB } from "../db.ts";
import { evaluateHiddenWorks, type ActDoc, type HiddenWorkItem } from "../domain/hidden-works.ts";
import type { MlResponse } from "./ml-client.ts";

const now = () => new Date().toISOString();

/** Сохранить результаты разбора сверх параметров: перечень скрытых работ и заголовок документа. Вызывается в транзакции разбора. */
export async function saveParseExtras(db: DB, fileId: string, res: Pick<MlResponse, "hidden_works" | "title" | "doc_type">): Promise<void> {
  await db.run("delete from hidden_works where file_id = $1", [fileId]);
  for (const h of res.hidden_works ?? [])
    await db.run("insert into hidden_works (file_id, n, text, page, bbox_json) values ($1,$2,$3,$4,$5)", [fileId, h.n, h.text, h.page, h.bbox ? JSON.stringify(h.bbox) : null]);
  await db.run("update files set doc_title = $1, doc_type = $2, doc_type_json = $3 where id = $4", [res.title ?? null, res.doc_type?.kind ?? null, res.doc_type ? JSON.stringify(res.doc_type) : null, fileId]);
}

/**
 * Пересчитать проверки HW-<n>: позиции перечня из актуальных ПД/РД против принятых АОСР в ИД.
 * Решение инспектора сохраняется, пока статус и акт не изменились. Вызывается из recompute в его транзакции.
 */
export async function writeHiddenWorks(db: DB, inspectionId: string, version: number): Promise<void> {
  const insp = (await db.get<{ object_id: string }>("select object_id from inspections where id = $1", [inspectionId]))!;
  // page nulls first — порядок SQLite; текстовые ключи — побайтно (collate "C"), как в SQLite, независимо от локали сервера
  const items = (await db.all<Record<string, any>>(`select h.n, h.text, h.page, h.bbox_json, f.id file_id, f.sha256, f.doc_stage stage, f.document_code, f.revision, f.approval_status
      from hidden_works h join files f on f.id = h.file_id
      where f.inspection_id = $1 and f.doc_stage in ('PD', 'RD') and f.parse_status = 'DONE' and coalesce(f.revision_role, '') != 'SUPERSEDED'
      order by f.doc_stage collate "C", f.document_code collate "C", h.page nulls first, h.n`, [inspectionId])).map(
    (r): HiddenWorkItem => ({ ...(r as any), bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null }),
  );
  const docs = await db.all<ActDoc>(`select id file_id, sha256, file_name, document_code, revision, approval_status, revision_role, doc_title title
      from files where inspection_id = $1 and doc_stage = 'ID' order by uploaded_at, id`, [inspectionId]);
  const result = evaluateHiddenWorks(items, docs);

  const existing = new Map((await db.all<Record<string, any>>("select * from checks where inspection_id = $1 and parent_id is null and param_code like 'HW-%'", [inspectionId])).map((c) => [c.param_code as string, c]));
  const insFrag = `insert into evidence_fragments (check_id, file_id, sha256, stage, document_code, revision, approval_status, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
  for (const hw of result) {
    const group = `${insp.object_id}:${hw.param_code}:${createHash("sha256").update(hw.fragments.map((f) => `${f.file_id}@${f.page}`).join("|")).digest("hex").slice(0, 10)}`;
    const prev = existing.get(hw.param_code);
    existing.delete(hw.param_code);
    let id: string;
    if (!prev) {
      id = `F-${insp.object_id}-${hw.param_code}`.replace(/[^\w-]/g, "") + "-" + randomUUID().slice(0, 4);
      await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
          review_priority, reason, stage_notes_json, title, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
        id, inspectionId, hw.param_code, group, hw.status, "PENDING", hw.expected, hw.actual, null, "MEDIUM", hw.reason, null, hw.title, version, now(), now(),
      ]);
    } else {
      id = prev.id;
      let verification = prev.verification_status;
      const same = prev.finding_status === hw.status && prev.actual_value === hw.actual && prev.title === hw.title;
      if (!same && verification !== "PENDING") {
        await db.run("update decisions set superseded = true where check_id = $1 and not superseded", [id]);
        verification = "PENDING";
      }
      await db.run(`update checks set evidence_group_id = $1, finding_status = $2, verification_status = $3, expected_value = $4, actual_value = $5, reason = $6, title = $7,
          computed_in_version = $8, updated_at = $9 where id = $10`, [group, hw.status, verification, hw.expected, hw.actual, hw.reason, hw.title, version, now(), id]);
      await db.run("delete from evidence_fragments where check_id = $1", [id]);
    }
    for (const f of hw.fragments) await db.run(insFrag, [id, f.file_id, f.sha256, f.stage, f.document_code, f.revision, f.approval_status, f.page, f.bbox ? JSON.stringify(f.bbox) : null, f.value, f.kind]);
  }
  // позиции, которых больше нет в перечне (документ заменён новой редакцией), — убираются из протокола
  for (const stale of existing.values()) {
    await db.run("delete from evidence_fragments where check_id = $1", [stale.id]);
    await db.run("update decisions set superseded = true where check_id = $1 and not superseded", [stale.id]);
    await db.run("delete from checks where id = $1", [stale.id]);
  }
}
