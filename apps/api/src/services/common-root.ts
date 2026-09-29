// Общий корень (OS-INSP-4.1.12–4.1.14): соседи по сигнатуре причины и групповое снятие поштучными решениями;
// снятие группы — одной транзакцией, целиком или никак (OS-INSP-4.1.25).
import type { DB } from "../db.ts";
import { siblingsOf, type RootCheck } from "../domain/common-root.ts";
import { HttpError, decideIn, type Ctx } from "./inspections.ts";

async function checksWithFragments(db: DB, inspectionId: string): Promise<(RootCheck & Record<string, any>)[]> {
  const checks = await db.all<Record<string, any>>(
    `select c.id, c.param_code, c.finding_status, c.verification_status, c.review_priority, c.expected_value, c.actual_value, p.parameter_name
       from checks c left join params p on p.code = c.param_code where c.inspection_id = $1 order by c.id`,
    [inspectionId],
  );
  const frags = await db.all<Record<string, any>>(
    `select f.check_id, f.role_expected_actual, f.file_id, f.sheet_page, f.document_code, f.revision
       from evidence_fragments f join checks c on c.id = f.check_id where c.inspection_id = $1`,
    [inspectionId],
  );
  return checks.map((c) => ({ ...(c as any), fragments: frags.filter((f) => f.check_id === c.id) }));
}

async function inspectionOf(db: DB, checkId: string): Promise<string> {
  const r = await db.get<{ inspection_id: string }>("select inspection_id from checks where id = $1", [checkId]);
  if (!r) throw new HttpError(404, "Запись не найдена");
  return r.inspection_id;
}

/** Кандидаты с той же сигнатурой причины, что у checkId. */
export async function siblings(db: DB, checkId: string): Promise<Record<string, any>[]> {
  const all = await checksWithFragments(db, await inspectionOf(db, checkId));
  return siblingsOf(all, checkId).map(({ fragments, ...c }) => ({ ...c, fragments }));
}

/**
 * Групповое снятие: только соседи по общему корню, каждое — отдельным решением с отсылкой к исходному.
 * Одна транзакция на всю группу: кандидата нельзя снять — не снимается никто, ответ называет этого кандидата (4.1.25).
 */
export async function rejectGroup(
  ctx: Ctx,
  checkId: string,
  body: { reason_code: string; reason_text: string; ids: string[]; actions?: number },
): Promise<{ rejected: string[] }> {
  return ctx.db.tx(async (t) => {
    const allowed = new Set((await siblings(t, checkId)).map((s) => s.id));
    const stray = body.ids.filter((id) => !allowed.has(id));
    if (stray.length) throw new HttpError(400, `Не соседи по общему корню: ${stray.join(", ")}`);
    const src = await t.get<{ param_code: string }>("select param_code from checks where id = $1", [checkId]);
    const rejected: string[] = [];
    for (const id of body.ids) {
      try {
        await decideIn({ ...ctx, db: t }, id, {
          action: "reject",
          reason_code: body.reason_code,
          comment: `${body.reason_text} — общая причина с ${src?.param_code ?? checkId}`,
          actions: body.actions,
        } as any);
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, `Кандидат ${id}: ${e.message}. Группа не снята`);
        throw e;
      }
      rejected.push(id);
    }
    return { rejected };
  });
}
