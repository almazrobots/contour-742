// NFR-PDN (ТЗ 12.6-01, 152-ФЗ): обезличивание по сроку (ст. 21 ч. 7), выключение учётки, сведения субъекту (ст. 14).
// Решения — чистые функции domain/pdn.ts; здесь только база и аудит.
import { meta, setMeta, type DB } from "../db.ts";
import { ANONYMIZED_PASSWORD_HASH, anonymizedLogin, anonymizedName, PDN_REGISTRY, retentionDue, retentionPlan, type RetentionConfig } from "../domain/pdn.ts";
import { audit } from "./audit.ts";
import { HttpError, type Ctx } from "./inspections.ts";

const schedulerCtx = (db: DB): Ctx => ({ db, user: { id: "system", login: "system", name: "Планировщик", role: "admin" } });
const LAST_RUN_KEY = "pdn_retention_day";

export interface RetentionResult {
  users: number;
  audit_rows: number;
  audit_cutoff: string;
}

/**
 * Обезличить учётки, выключенные дольше cfg.userDays (ФИО → «Обезличен #id», логин → deleted-<id>, пароль — невалидный
 * хеш, сессии удаляются), и обнулить IP/UA в журнале старше cfg.auditDays (функция БД pdn_anonymize_audit). Всё и запись
 * PDN_RETENTION — одной транзакцией. Идемпотентно: обезличенная учётка повторно не трогается.
 */
export async function runRetention(db: DB, now: Date, cfg: RetentionConfig): Promise<RetentionResult> {
  return db.tx(async (t) => {
    const users = await t.all<{ id: string; login: string; deactivated_at: string | null }>(
      "select id, login, deactivated_at from users where deactivated_at is not null order by id");
    const plan = retentionPlan(now, users.map((u) => ({ ...u, deactivated_at: u.deactivated_at === null ? null : new Date(u.deactivated_at).toISOString() })), cfg);
    for (const id of plan.anonymize) {
      await t.run("update users set name = $1, login = $2, password_hash = $3 where id = $4", [anonymizedName(id), anonymizedLogin(id), ANONYMIZED_PASSWORD_HASH, id]);
      await t.run("delete from sessions where user_id = $1", [id]);
    }
    const rows = Number((await t.get<{ n: number }>("select pdn_anonymize_audit($1) n", [plan.auditCutoff]))!.n);
    const result = { users: plan.anonymize.length, audit_rows: rows, audit_cutoff: plan.auditCutoff };
    await audit(schedulerCtx(t), "PDN_RETENTION", null, { users_anonymized: result.users, user_ids: plan.anonymize, audit_rows: rows, audit_cutoff: plan.auditCutoff, user_days: cfg.userDays, audit_days: cfg.auditDays });
    return result;
  });
}

/** Тик планировщика (раз в час): задача выполняется один раз за сутки UTC; параллельный тик другой реплики ждёт замок. */
export async function runRetentionIfDue(db: DB, now: Date, cfg: RetentionConfig): Promise<RetentionResult | null> {
  return db.tx(async (t) => {
    await t.run("select pg_advisory_xact_lock(hashtext('inspector:pdn-retention'))");
    const day = retentionDue(now, await meta(t, LAST_RUN_KEY));
    if (!day) return null;
    const r = await runRetention(t, now, cfg);
    await setMeta(t, LAST_RUN_KEY, day);
    return r;
  });
}

/** Выключить учётку: отметка времени (повтор — прежняя), сессии удаляются, запись USER_DEACTIVATED. Себя — нельзя. */
export async function deactivateUser(ctx: Ctx, userId: string, at = new Date()): Promise<{ id: string; deactivated_at: string }> {
  if (userId === ctx.user.id) throw new HttpError(409, "Нельзя выключить собственную учётную запись");
  return ctx.db.tx(async (t) => {
    const u = await t.get<{ id: string; deactivated_at: string | null }>("select id, deactivated_at from users where id = $1 for update", [userId]);
    if (!u) throw new HttpError(404, "Учётная запись не найдена");
    if (u.deactivated_at !== null) return { id: u.id, deactivated_at: new Date(u.deactivated_at).toISOString() };
    const ts = at.toISOString();
    await t.run("update users set deactivated_at = $1 where id = $2", [ts, userId]);
    await t.run("delete from sessions where user_id = $1", [userId]);
    await audit({ ...ctx, db: t }, "USER_DEACTIVATED", userId, { deactivated_at: ts });
    return { id: userId, deactivated_at: ts };
  });
}

/**
 * Сведения субъекту ПДн (ст. 14): что хранится о пользователе и где. Значения — самого субъекта (ФИО, логин, IP, UA);
 * по остальным местам — число записей. Доступ пишется в аудит PDN_ACCESS (вызывающий маршрут).
 */
export async function subjectReport(db: DB, userId: string) {
  const user = await db.get<{ id: string; login: string; name: string; role: string; deactivated_at: string | null }>(
    "select id, login, name, role, deactivated_at from users where id = $1", [userId]);
  if (!user) return null;
  const a = (await db.get<{ records: number; with_ip: number; with_ua: number; first: string | null; last: string | null }>(
    `select count(*)::int records, count(ip_address)::int with_ip, count(user_agent)::int with_ua, min(timestamp) first, max(timestamp) last from audit_log where user_id = $1`, [userId]))!;
  const ips = (await db.all<{ ip_address: string }>("select distinct ip_address from audit_log where user_id = $1 and ip_address is not null order by ip_address limit 100", [userId])).map((r) => r.ip_address);
  const uas = (await db.all<{ user_agent: string }>("select distinct user_agent from audit_log where user_id = $1 and user_agent is not null order by user_agent limit 100", [userId])).map((r) => r.user_agent);
  const count = async (sql: string) => Number((await db.get<{ n: number }>(sql, [userId]))!.n);
  // ФИО в снимке протокола: решение с user_id субъекта (JSON-текст ищется по точному ключу)
  const protocols = await count(`select count(*)::int n from protocols where body_json::text like '%"user_id":"' || replace(replace($1, '%', '\\%'), '_', '\\_') || '"%'`);
  const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
  const where = (t: string, c: string) => PDN_REGISTRY.find((r) => r.table === t && r.column === c)!;
  const loc = (t: string, c: string, records: number) => ({ table: t, column: c, category: where(t, c).category, purpose: where(t, c).purpose, retention: where(t, c).retention_note, records });
  return {
    user: { ...user, deactivated_at: iso(user.deactivated_at) },
    audit: { records: a.records, with_ip: a.with_ip, with_ua: a.with_ua, first: iso(a.first), last: iso(a.last), ip_addresses: ips, user_agents: uas },
    decisions: await count("select count(*)::int n from decisions where user_id = $1"),
    sessions: await count("select count(*)::int n from sessions where user_id = $1"),
    inspections_created: await count("select count(*)::int n from inspections where created_by = $1"),
    protocols_with_name: protocols,
    locations: [
      loc("users", "name", 1),
      loc("users", "login", 1),
      loc("audit_log", "ip_address", a.with_ip),
      loc("audit_log", "user_agent", a.with_ua),
      loc("protocols", "body_json", protocols),
    ],
  };
}
