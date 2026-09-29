// OS-INSP-6.2 Отчёт по дообучению: по запросу (6.2.1) и еженедельно по расписанию (6.2.2).
import type { DB } from "../db.ts";
import { reportDue } from "../domain/schedule.ts";
import { retrainingCounts } from "../domain/feedback-logs.ts";
import { audit } from "./audit.ts";
import type { Ctx } from "./inspections.ts";

const schedulerCtx = (db: DB): Ctx => ({ db, user: { id: "system", login: "system", name: "Планировщик", role: "admin" } });

const ADVICE: Record<string, string> = {
  OCR_ERROR: "Дообучить OCR на сканах низкого качества; поднять dpi рендера; проверить порог LOW_QUALITY.",
  BINDING_ERROR: "Уточнить якоря параметров и геометрическую сборку строк; добавить семантические якоря (профиль gpu).",
  WRONG_REVISION: "Проверить правила выбора редакции и качество реестров файлов у заявителей.",
  APPROVED_CHANGE: "Подключить реестр согласованных изменений (ИАИС «РиН») к выбору эталона.",
  WITHIN_TOLERANCE: "Пересмотреть допуск параметра в Матрице (администратор).",
  NOT_APPLICABLE: "Добавить признак применимости в профиль объекта.",
};

/** OS-INSP-4.1.23: рекомендация по собственному ключу — служебное имя в старых решениях («constructor») дало бы функцию и 500. */
export function adviceFor(code: unknown): string {
  return typeof code === "string" && Object.hasOwn(ADVICE, code) ? ADVICE[code] : "";
}

/**
 * OS-INSP-6.2.1: отклонения по причинам и параметрам с рекомендациями за [since; until). Источник отклонений — журнал
 * отклонений (ТЗ §10 Rejection_Log «лог отклонений для дообучения», T-234): причина — rejection_reason, параметр — код
 * записи; снятые решения (SUPERSEDED) не считаются. retraining — сколько отклонений ждёт выпуска набора, вошло в набор
 * и снято (Rejection_Log.retraining_status). totals — все решения инспекторов за период (decisions).
 */
export async function buildRetrainingReport(db: DB, since: string, until = "9999-12-31T23:59:59.999Z") {
  const byReason = await db.all<any>(`select reason_code, count(*)::int n from rejection_log where retraining_status <> 'SUPERSEDED' and created_at >= $1 and created_at < $2
      group by reason_code order by n desc, reason_code nulls last`, [since, until]);
  const byParam = await db.all<any>(`select r.param_code, p.parameter_name, count(*)::int n from rejection_log r left join params p on p.code = r.param_code
      where r.retraining_status <> 'SUPERSEDED' and r.created_at >= $1 and r.created_at < $2
      group by r.param_code, p.parameter_name order by n desc, r.param_code limit 20`, [since, until]);
  const totals = await db.all<any>("select action, count(*) n from decisions where not superseded and created_at >= $1 and created_at < $2 group by action order by action", [since, until]);
  const status = await db.all<{ retraining_status: string; n: number }>("select retraining_status, count(*)::int n from rejection_log where created_at >= $1 and created_at < $2 group by retraining_status", [since, until]);
  return { since, totals, by_reason: byReason.map((r) => ({ ...r, recommendation: adviceFor(r.reason_code) })), by_param: byParam, retraining: retrainingCounts(status) };
}

/**
 * OS-INSP-6.2.2: построить отчёт за прошедшую неделю, если его ещё нет. Вызывается тиком планировщика.
 * Строится один раз и при нескольких экземплярах API: вставка с on conflict (until) do nothing returning id —
 * строку получает ровно один тик; проигравший откатывает свою транзакцию без аудита.
 */
export async function runWeeklyReportIfDue(db: DB, now = new Date()): Promise<{ since: string; until: string } | null> {
  const existing = (await db.all<{ until: string }>("select until from retraining_reports")).map((r) => r.until);
  const p = reportDue(now, existing);
  if (!p) return null;
  const body = await buildRetrainingReport(db, p.since, p.until);
  return db.tx(async (t) => {
    const r = await t.run("insert into retraining_reports (since, until, body_json, created_at) values ($1,$2,$3,$4) on conflict (until) do nothing returning id",
      [p.since, p.until, JSON.stringify(body), now.toISOString()]);
    if (!r.rows.length) return null; // параллельный тик успел раньше
    await audit(schedulerCtx(t), "RETRAINING_REPORT_BUILT", p.until, { since: p.since, until: p.until, rejections: body.by_reason.reduce((a: number, x: any) => a + x.n, 0) });
    return p;
  });
}
