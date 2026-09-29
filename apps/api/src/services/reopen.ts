// OS-INSP-4.1.15 (T-105/T-107 плана): вернуть решённого кандидата в PENDING — отмена клавишей Z вместо «Вы уверены?».
// Прежнее решение не удаляется: помечается заменённым (decisions.superseded — единственная колонка, которую можно менять).
import { reopenVerdict } from "../domain/decision-flow.ts";
import { audit } from "./audit.ts";
import { HttpError, lockInspection, type Ctx } from "./inspections.ts";

export async function reopenCheck(ctx: Ctx, checkId: string): Promise<Record<string, any>> {
  return ctx.db.tx(async (t) => {
    const ref = await t.get<{ inspection_id: string }>("select inspection_id from checks where id = $1", [checkId]);
    if (!ref) throw new HttpError(404, "Запись не найдена");
    const insp = await lockInspection(t, ref.inspection_id);
    const c = await t.get<Record<string, any>>("select * from checks where id = $1 for update", [checkId]);
    const v = reopenVerdict({ process: insp.status, verification: c!.verification_status });
    if (!v.ok) throw new HttpError(v.status, v.error);
    const at = new Date().toISOString();
    await t.run("update decisions set superseded = true where check_id = $1 and not superseded", [checkId]);
    await t.run("update checks set verification_status = 'PENDING', updated_at = $1 where id = $2", [at, checkId]);
    // протокол снова в работе: «верификация завершена» больше неправда
    if (insp.status === "COMPLETED") await t.run("update inspections set status = 'VERIFYING', updated_at = $1 where id = $2", [at, insp.id]);
    await audit({ ...ctx, db: t }, "CHECK_REOPENED", checkId, { inspection_id: insp.id, param_code: c!.param_code, was: c!.verification_status });
    return { check_id: checkId, verification_status: "PENDING" };
  });
}
