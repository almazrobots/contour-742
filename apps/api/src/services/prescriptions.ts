// OS-INSP-5.4 Отразить статус предписания (ТЗ §9.6.4): приём сообщений ИАИС «РиН» и показ по проверке.
// Пишет только в prescriptions / prescription_events / audit_log — протокол, решения и кандидатов не трогает (OS-INSP-5.4.7).
import type { DB } from "../db.ts";
import type { Role } from "../domain/types.ts";
import {
  currentStatus, parsePrescriptionMessage, PrescriptionMessageError, rinKeyVerdict, type PrescriptionStatus, type RinKeyVerdict,
} from "../domain/prescriptions.ts";
import { audit, log } from "./audit.ts";
import { HttpError, type Ctx } from "./inspections.ts";

export type PrescriptionErrorCode = "INVALID_MESSAGE" | "UNKNOWN_INSPECTION";

/** Типизированный отказ; наследует HttpError — обработчик ошибок приложения отдаёт его статус как есть. */
export class PrescriptionError extends HttpError {
  constructor(public code: PrescriptionErrorCode, status: 400 | 404, message: string, details?: unknown) {
    super(status, message, details);
  }
}

export interface PrescriptionHistoryItem {
  status: PrescriptionStatus;
  event_at: string;
  received_at: string;
}

export interface PrescriptionView {
  prescription_id: string;
  status: PrescriptionStatus;
  event_at: string;
  updated_at: string;
  history: PrescriptionHistoryItem[];
}

export interface IngestResult {
  created: boolean;
  prescription: PrescriptionView;
}

/** Источник событий в журнале аудита: сообщения приходят от системы, а не от пользователя. */
const RIN_ACTOR = { id: "rin", login: "rin", name: "ИАИС «РиН»", role: "admin" as Role };

/** OS-INSP-5.4.6 ключ входящей интеграции читается при каждом запросе: смена ключа не требует перезапуска. */
export function checkRinInboundKey(presented: unknown): RinKeyVerdict {
  return rinKeyVerdict(process.env.INSPECTOR_RIN_INBOUND_KEY, presented);
}

async function inspectionExists(db: DB, id: string): Promise<boolean> {
  return Boolean(await db.get("select 1 from inspections where id = $1", [id]));
}

async function view(db: DB, ref: number): Promise<PrescriptionView> {
  const p = (await db.get("select * from prescriptions where id = $1", [ref]))!;
  const history = await db.all<PrescriptionHistoryItem>(
    "select status, event_at, received_at from prescription_events where prescription_ref = $1 order by event_at, id", [ref],
  );
  return { prescription_id: p.prescription_id, status: p.current_status, event_at: p.current_event_at, updated_at: p.updated_at, history: history.map((h) => ({ ...h })) };
}

/**
 * Принять сообщение «РиН» о статусе предписания. Сигнатура нарочно простая — её зовёт и опрос «РиН» (rin-pull).
 * Бросает PrescriptionError: 400 — сообщение не по формату (5.4.1), 404 — проверки нет (5.4.2).
 *
 * Конкурентность (два процесса API, повтор «РиН» вдогонку): всё — одна транзакция (внутри чужой — точка сохранения).
 * Строка предписания блокируется (for update) до вставки события: приёмы по одному предписанию идут строго по очереди,
 * и пересчёт текущего статуса видит все события, принятые раньше. Дубль события отсекает unique
 * (prescription_ref, status, event_at) + on conflict do nothing — вторая запись истории не появляется.
 */
export async function ingestPrescriptionStatus(db: DB, event: unknown, meta: { ip?: string; ua?: string } = {}): Promise<IngestResult> {
  let m;
  try {
    m = parsePrescriptionMessage(event); // OS-INSP-5.4.1
  } catch (e) {
    if (e instanceof PrescriptionMessageError) {
      throw new PrescriptionError("INVALID_MESSAGE", 400, e.message, { field: e.field, ...(e.allowed ? { allowed: e.allowed } : {}) });
    }
    throw e;
  }
  const msg = m;
  // OS-INSP-5.4.2 проверки нет — отказ, предписание не заводится
  if (!(await inspectionExists(db, msg.process_id))) throw new PrescriptionError("UNKNOWN_INSPECTION", 404, `Проверка ${msg.process_id} не найдена`);

  const at = new Date().toISOString();
  return db.tx(async (t) => {
    await t.run(
      `insert into prescriptions (inspection_id, prescription_id, current_status, current_event_at, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)
       on conflict (inspection_id, prescription_id) do nothing`,
      [msg.process_id, msg.prescription_id, msg.status, msg.event_at, at, at],
    );
    const ref = (await t.get<{ id: number }>("select id from prescriptions where inspection_id = $1 and prescription_id = $2 for update", [msg.process_id, msg.prescription_id]))!.id;
    // OS-INSP-5.4.4 повтор (предписание + статус + дата события) не дублирует историю
    const ins = await t.run(
      `insert into prescription_events (prescription_ref, prescription_id, status, event_at, received_at) values ($1,$2,$3,$4,$5)
       on conflict (prescription_ref, status, event_at) do nothing returning id`,
      [ref, msg.prescription_id, msg.status, msg.event_at, at],
    );
    const created = ins.rows.length > 0;
    if (created) {
      // OS-INSP-5.4.3 текущий — с самой поздней датой события, а не последний пришедший
      const events = await t.all<{ status: PrescriptionStatus; event_at: string; seq: number }>("select status, event_at, id seq from prescription_events where prescription_ref = $1", [ref]);
      const cur = currentStatus(events)!;
      await t.run("update prescriptions set current_status = $1, current_event_at = $2, updated_at = $3 where id = $4", [cur.status, cur.event_at, at, ref]);
      await audit({ db: t, user: RIN_ACTOR, ip: meta.ip, ua: meta.ua } satisfies Ctx, "PRESCRIPTION_STATUS", msg.process_id, {
        prescription_id: msg.prescription_id, status: msg.status, event_at: msg.event_at, current_status: cur.status,
      });
    } else {
      log("INFO", "rin prescription duplicate", { inspection_id: msg.process_id, prescription_id: msg.prescription_id, status: msg.status });
    }
    return { created, prescription: await view(t, ref) };
  });
}

/** OS-INSP-5.4.5 по проверке — текущий статус каждого предписания и его история. */
export async function listPrescriptions(db: DB, inspectionId: string): Promise<PrescriptionView[]> {
  if (!(await inspectionExists(db, inspectionId))) throw new PrescriptionError("UNKNOWN_INSPECTION", 404, `Проверка ${inspectionId} не найдена`);
  const refs = await db.all<{ id: number }>("select id from prescriptions where inspection_id = $1 order by prescription_id", [inspectionId]);
  const out: PrescriptionView[] = [];
  for (const r of refs) out.push(await view(db, r.id));
  return out;
}
