// OS-INSP-1.5.1, 3.1.9 Реестр согласованных изменений: хранение, список по объекту, приложение к карточкам.
import type { DB } from "../db.ts";
import { changesFor, normCode, type ApprovedChange, type ApprovedChangeInput } from "../domain/changes.ts";
import type { CheckRow } from "../domain/protocol.ts";
import { audit } from "./audit.ts";
import { getInspection, HttpError, lockInspection, recomputeParams, type Ctx } from "./inspections.ts";

/** Изменения объекта проверки: согласованное изменение относится к документации объекта, а не к одному прогону. */
export async function listChanges(db: DB, inspectionId: string): Promise<ApprovedChange[]> {
  const insp = await getInspection(db, inspectionId);
  const rows = await db.all<Record<string, any>>(`select a.*, f.file_name basis_file_name from approved_changes a left join files f on f.id = a.basis_file_id
      where a.object_id = $1 order by a.date collate "C" desc, a.id desc`, [insp.object_id]);
  return rows.map((r) => ({
    id: r.id,
    inspection_id: r.inspection_id,
    object_id: r.object_id,
    number: r.number,
    date: r.date,
    param_codes: JSON.parse(r.param_codes_json),
    basis_file_id: r.basis_file_id,
    basis_file_name: r.basis_file_name ?? null,
    description: r.description,
    created_by: r.created_by,
    created_at: r.created_at,
  }));
}

/** OS-INSP-1.5.1: зарегистрировать согласованное изменение (запись в журнал аудита). Под блокировкой проверки — не разминуться с финализацией. */
export async function addChange(ctx: Ctx, inspectionId: string, input: ApprovedChangeInput): Promise<ApprovedChange> {
  const added = await ctx.db.tx(async (t) => {
    const insp = await lockInspection(t, inspectionId);
    if (insp.status === "FINALIZED") throw new HttpError(409, "Протокол финализирован: регистрация изменений невозможна. Создайте новую проверку.");
    if (input.basis_file_id) {
      const f = await t.get("select id from files where id = $1 and inspection_id = $2", [input.basis_file_id, inspectionId]);
      if (!f) throw new HttpError(400, `Документ-основание ${input.basis_file_id} не найден в проверке`);
    }
    const codes = [...new Set(input.param_codes.map(normCode))];
    const r = await t.run(
      "insert into approved_changes (inspection_id, object_id, number, date, param_codes_json, basis_file_id, description, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
      [inspectionId, insp.object_id, input.number, input.date, JSON.stringify(codes), input.basis_file_id ?? null, input.description ?? "", ctx.user.id, new Date().toISOString()],
    );
    const id = Number(r.rows[0].id);
    await audit({ ...ctx, db: t }, "APPROVED_CHANGE_REGISTERED", inspectionId, { change_id: id, number: input.number, date: input.date, param_codes: codes, basis_file_id: input.basis_file_id ?? null });
    return (await listChanges(t, inspectionId)).find((c) => c.id === id)!;
  });
  await recomputeParams(ctx.db, inspectionId, added.param_codes); // OS-INSP-1.5.2: CMP-29 учитывает изменение сразу
  return added;
}

/** OS-INSP-3.1.9: приложить к каждой записи протокола согласованные изменения по её коду параметра. */
export async function attachApprovedChanges(db: DB, inspectionId: string, rows: CheckRow[]): Promise<CheckRow[]> {
  const changes = await listChanges(db, inspectionId);
  if (!changes.length) return rows;
  return rows.map((r) => ({ ...r, approved_changes: changesFor(r.param_code, changes) }));
}
