// Служба миграций api-migrate (HIGH-1, аудит 2026-09-26; ADR-0003). Одноразовый процесс того же образа, что API:
// роль inspector_migrator (член inspector_owner) применяет миграции, сиды справочников и — в пустую users — первого
// администратора из секрета. Выход 0 — API может стартовать (depends_on: service_completed_successfully); иначе 1.
// API в профиле gpu схему не меняет: только сверяет план (db.ts::verifySchema).
import "./entry-migrate.ts";
import { config } from "./config.ts";
import { applySchema, bootstrapAdmin, openDb } from "./db.ts";
import { formatLog, type Level } from "./services/audit.ts";

const say = (level: Level, message: string, extra: Record<string, unknown> = {}) => {
  const line = formatLog(level, message, { component: "migrate", ...extra });
  if (line) (level === "ERROR" ? console.error : console.log)(line);
};

try {
  const db = await openDb(config.databaseUrl, { mode: "none", purpose: "migrate" });
  try {
    const applied = await applySchema(db);
    const version = (await db.get<{ v: number | null }>("select max(version) v from schema_migrations"))!.v;
    say("INFO", "migrations applied", { applied, schema_version: version, profile: config.profile });
    const admin = await bootstrapAdmin(db, config.bootstrapAdmin);
    if (admin === "skip-no-secret") say("WARNING", "users пуст, INSPECTOR_BOOTSTRAP_ADMIN_PASSWORD_FILE не задан: войти в систему некому");
    else say("INFO", `bootstrap admin: ${admin}`, { login: admin === "create" ? config.bootstrapAdmin.login : undefined });
  } finally {
    await db.close();
  }
  process.exit(0);
} catch (e) {
  say("ERROR", "migrate failed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
