// Права ролей (ТЗ 12.2; OS-INSP-4.1.26–4.1.28, T-139 — OWASP-аудит M1, M2). Каждое право названо явно:
// администратор — не суперпользователь, его права перечислены так же, как у остальных ролей.
import type { Role } from "./types.ts";

export const CAPABILITIES = {
  "verification.work": ["verifier", "inspector", "supervisor", "admin", "curator"],
  "verification.manage": ["curator", "admin"],
  "verification.export": ["ml_engineer", "curator", "admin"],
  // OS-INSP-4.1.26: загрузка, запуск, решения, разделение, групповое снятие, выборка, возврат, финализация
  "inspection.work": ["inspector", "supervisor"],
  // OS-INSP-4.1.27: карточки, протоколы и файлы проверок; ML-инженеру и куратору закрыты
  "inspection.read": ["inspector", "supervisor", "admin"],
  // OS-INSP-4.4.1: отмена финализации — супервизор или администратор
  "inspection.unfinalize": ["supervisor", "admin"],
  // OS-INSP-4.1.6, 4.1.7: журналы отклонений и спорных случаев (ML-роли — сводно, 4.1.27)
  "feedback.read": ["supervisor", "admin", "ml_engineer", "curator"],
  // OS-INSP-4.1.29 (T-234, ТЗ §10 Dispute_Log.resolved_by): закрыть спор инспектора с ИИ — надзор над инспектором
  "dispute.resolve": ["supervisor", "admin"],
  // OS-INSP-8.2 и 4.1.28: журнал аудита и сетевые следы (IP, User-Agent) в нём
  "audit.read": ["supervisor", "admin"],
  // NFR-VERIFY-30: отчёт замера цикла верификации
  "usability.report": ["supervisor", "admin"],
  // ТЗ 12.2: администратор — параметры, нормативная база, правила; мониторинг и целостность хранилища
  "matrix.edit": ["admin"],
  "monitoring.read": ["admin"],
  "storage.integrity": ["admin"],
  // NFR-IDS (ТЗ 12.9, T-138): блокировки адресов системой защиты — просмотр и снятие
  "security.admin": ["admin"],
  // ТЗ 12.2: ML-инженер — логи и данные дообучения; куратор — GOLD-набор (OS-INSP-6.1–6.4)
  "ml.read": ["ml_engineer", "curator", "admin"],
  "ml.gold.release": ["curator", "admin"],
  "ml.train": ["ml_engineer", "admin"],
  "ml.model.approve": ["supervisor", "admin"],
  "param.verify": ["ml_engineer"],
  // T-137 (7d), вписано заранее, чтобы слияние не дало двух матриц: печать скрытого теста (OS-INSP-6.1.4–6.1.7),
  // реестр ПДн и субъект ПДн, деактивация учётки (NFR-PDN)
  "ml.hidden.seal": ["ml_engineer", "admin"],
  "pdn.admin": ["admin"],
  "users.admin": ["admin"],
  // dev: заглушка «РиН» для демонстрации отказов интеграции
  "rin.mock": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

/** Есть ли у роли право. Неизвестное право и неизвестная роль — нет (ключ проверяется без прототипа). */
export function allowed(role: string | undefined, cap: Capability): boolean {
  if (!role || !Object.hasOwn(CAPABILITIES, cap)) return false;
  return (CAPABILITIES[cap] as readonly string[]).includes(role);
}

/** OS-INSP-4.1.28: запись аудита для карточки — IP и User-Agent только тем, кому открыт журнал аудита. */
export function auditForRole<T extends Record<string, unknown>>(role: string | undefined, row: T): T {
  if (allowed(role, "audit.read")) return row;
  const { ip_address: _ip, user_agent: _ua, ...rest } = row;
  return rest as T;
}
