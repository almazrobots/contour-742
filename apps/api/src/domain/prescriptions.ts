// OS-INSP-5.4 Отразить статус предписания (ТЗ §9.6.4). Чистые функции: разбор сообщения ИАИС «РиН»,
// выбор текущего статуса, ключ идемпотентности, проверка ключа интеграции. Переходов между статусами
// система не проверяет: статус не вычисляется и не меняется системой, а отражается как сообщила «РиН».
// Допущение (контракт «РиН» не получен, T-067): сообщение {prescription_id, process_id, status, event_at}.
import { createHash, timingSafeEqual } from "node:crypto";

// OS-INSP-5.4.1 перечень статусов из ТЗ
export const PRESCRIPTION_STATUSES = ["ISSUED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXTENDED"] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export interface PrescriptionMessage {
  prescription_id: string;
  process_id: string;
  status: PrescriptionStatus;
  /** Дата события в «РиН», приведённая к UTC ISO (toISOString) — чтобы сравнение строк было сравнением моментов. */
  event_at: string;
}

/** Событие истории: seq — порядок прихода в систему (возрастает). */
export interface PrescriptionEvent {
  status: PrescriptionStatus;
  event_at: string;
  seq: number;
}

export class PrescriptionMessageError extends Error {
  constructor(public field: string, message: string, public allowed?: string[]) {
    super(message);
  }
}

const MAX_ID = 200;

function requireId(raw: Record<string, unknown>, field: "prescription_id" | "process_id"): string {
  const v = raw[field];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > MAX_ID) throw new PrescriptionMessageError(field, `Поле ${field} обязательно: непустая строка до ${MAX_ID} символов`);
  return s;
}

// ГГГГ-ММ-ДД, либо дата-время с обязательным часовым поясом (Z или ±чч:мм)
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

/** Дата события → UTC ISO; null, если это не ISO 8601, дата не существует или у времени нет пояса. */
export function normalizeEventAt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = ISO.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh = "0", mi = "0", ss = "0", frac = "", , sign, oh = "0", om = "0"] = m;
  const Y = +y, M = +mo, D = +d, H = +hh, Mi = +mi, S = +ss, OH = +oh, OM = +om;
  const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  if (Y < 1000 || M < 1 || M > 12 || D < 1 || D > daysInMonth || H > 23 || Mi > 59 || S > 59 || OH > 23 || OM > 59) return null;
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  const offsetMin = sign ? (sign === "-" ? -1 : 1) * (OH * 60 + OM) : 0;
  const t = Date.UTC(Y, M - 1, D, H, Mi, S, ms) - offsetMin * 60_000;
  return new Date(t).toISOString();
}

/** OS-INSP-5.4.1 разбор входящего сообщения: статус только из перечня, иначе ошибка с перечнем допустимых. */
export function parsePrescriptionMessage(raw: unknown): PrescriptionMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PrescriptionMessageError("body", "Ожидается JSON-объект сообщения");
  const r = raw as Record<string, unknown>;
  const prescription_id = requireId(r, "prescription_id");
  const process_id = requireId(r, "process_id");
  const status = r.status;
  if (typeof status !== "string" || !(PRESCRIPTION_STATUSES as readonly string[]).includes(status)) {
    throw new PrescriptionMessageError("status", `Недопустимый статус предписания; допустимы: ${PRESCRIPTION_STATUSES.join(", ")}`, [...PRESCRIPTION_STATUSES]);
  }
  const event_at = normalizeEventAt(r.event_at);
  if (!event_at) throw new PrescriptionMessageError("event_at", "Поле event_at — дата ISO 8601 (ГГГГ-ММ-ДД или дата-время с часовым поясом)");
  return { prescription_id, process_id, status: status as PrescriptionStatus, event_at };
}

/**
 * OS-INSP-5.4.3 текущий статус — с самой поздней датой события в «РиН», а не последний пришедший.
 * При равной дате события — пришедший позже (больший seq): это самое свежее известное системе.
 */
export function currentStatus<E extends PrescriptionEvent>(events: readonly E[]): E | null {
  let best: E | null = null;
  for (const e of events) {
    if (!best || e.event_at > best.event_at || (e.event_at === best.event_at && e.seq > best.seq)) best = e;
  }
  return best;
}

export type RinKeyVerdict = { ok: true } | { ok: false; status: 401 | 503; error: string };

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * OS-INSP-5.4.6 ключ интеграции «РиН»: без настроенного ключа маршрут закрыт (503), а не открыт;
 * сравнение в постоянном времени — по SHA-256 обеих строк, чтобы длины совпадали.
 */
export function rinKeyVerdict(configured: string | undefined, presented: unknown): RinKeyVerdict {
  if (!configured) return { ok: false, status: 503, error: "Интеграция с ИАИС «РиН» не настроена" };
  const got = typeof presented === "string" ? presented : "";
  const same = timingSafeEqual(digest(configured), digest(got));
  if (!got || !same) return { ok: false, status: 401, error: "Неверный ключ интеграции «РиН»" };
  return { ok: true };
}
