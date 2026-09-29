// OS-INSP-8.2 Журнал аудита (ТЗ 12.4): время, IP, тип действия, объект. Уведомления — в той же точке.
import type { DB } from "../db.ts";
import { maskFields, maskText } from "../domain/pdn.ts";
import type { Ctx } from "./inspections.ts";

// Запись аудита идёт через ctx.db: внутри транзакции изменения передавайте { ...ctx, db: t } —
// тогда изменение и его след в журнале фиксируются или откатываются вместе.
export async function audit(ctx: Ctx, action: string, objectId: string | null, details: unknown): Promise<void> {
  await ctx.db.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7)",
    [ctx.user.id, action, objectId, JSON.stringify(details ?? {}), new Date().toISOString(), ctx.ip ?? null, ctx.ua ?? null]);
  log("INFO", `audit ${action}`, { user_id: ctx.user.id, object_id: objectId });
}

export async function notify(db: DB, role: string, inspectionId: string | null, level: "INFO" | "WARNING" | "ERROR", message: string): Promise<void> {
  await db.run("insert into notifications (user_role, inspection_id, level, message, created_at) values ($1,$2,$3,$4,$5)", [role, inspectionId, level, message, new Date().toISOString()]);
  log(level, message, { inspection_id: inspectionId, to: role });
}

/** Структурированный JSON-лог (ТЗ 13.1): timestamp, level, service, message, request_id, user_id. */
export type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

/** Строка JSON-лога с обязательными полями ТЗ 13.1. DEBUG пишется только вне прода (ТЗ 13.2). Поля — через маску ПДн. */
export function formatLog(level: Level, message: string, extra: Record<string, unknown> = {}, at = new Date()): string | null {
  if (level === "DEBUG" && process.env.INSPECTOR_DEBUG !== "1") return null;
  const { request_id = null, user_id = null, ...rest } = extra;
  // NFR-PDN: ПДн в журнал не пишутся — e-mail, телефон, СНИЛС в тексте и поля реестра по ключу (domain/pdn.ts)
  return JSON.stringify({ timestamp: at.toISOString(), level, service: "api", message: maskText(message), request_id, user_id, ...maskFields(rest) });
}

export function log(level: Level, message: string, extra: Record<string, unknown> = {}): void {
  if (process.env.VITEST) return;
  const line = formatLog(level, message, extra);
  if (line) process.stdout.write(line + "\n");
}
