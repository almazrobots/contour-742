// Уровень строки журнала ответа (ТЗ 13.2) и признак события безопасности (ТЗ 12.5, 13.3: хранится 1 год).
// Признак ставит сам API, а не Logstash по тексту строки: отказ во входе, в доступе и перебор пароля.
import type { Level } from "../services/audit.ts";

const SECURITY = new Set([401, 403, 429]);

export function responseLog(status: number): { level: Level; security: boolean } {
  if (status >= 500) return { level: "ERROR", security: false };
  if (SECURITY.has(status)) return { level: "WARNING", security: true };
  return { level: "INFO", security: false };
}
