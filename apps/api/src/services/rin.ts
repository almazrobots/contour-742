// OS-INSP-5.2 Передать протокол в ИАИС «РиН» (ТЗ 9.6). Транспорт — rin-tls.ts (NFR-MTLS): mTLS напрямую или через ГОСТ-TLS-шлюз СКЗИ; заглушка — только INSPECTOR_RIN_MOCK=1 / dev.
import type { DB } from "../db.ts";
import { config } from "../config.ts";
import { notify, log } from "./audit.ts";
import { type RinSend, rinTransportFromEnv } from "./rin-tls.ts";
import { aiUsageForRin } from "../domain/ai-usage.ts";
import { slo } from "./slo-metrics.ts";

const withoutName = ({ user_name: _n, ...d }: Record<string, unknown>) => d;

/** Полезная нагрузка: только подтверждённые инспектором записи + версии + реестр входных файлов (ТЗ 9.3 п.4). */
export function rinPayload(body: any) {
  return {
    process_id: body.process_id,
    object: body.object,
    protocol_version: body.protocol_version,
    versions: body.versions,
    input_files: body.input_files.map((f: any) => ({ file_id: f.file_id, file_name: f.file_name, sha256: f.sha256, document_code: f.document_code, revision: f.revision })),
    // NFR-PDN (минимизация, 152-ФЗ ст. 5 ч. 5): решение уходит с user_id без ФИО инспектора. Допущение: «РиН» идентифицирует
    // должностное лицо по своей учётке (сопоставление user_id — на её стороне). Снимок протокола не меняется — только копия.
    confirmed_violations: body.sections.confirmed_violations.map((c: any) => (c?.decision ? { ...c, decision: withoutName(c.decision) } : c)),
    ai_usage: aiUsageForRin(body.ai_usage), // OS-INSP-5.2.4 (п. 9(1).10) с ограничением 5.2.1 — только подтверждённые
  };
}

let transport: RinSend | undefined; // строится лениво при первой отправке: импорт модуля в тестах не читает сертификаты
let send: RinSend = (url, payload) => (transport ??= rinTransportFromEnv({ profile: config.profile, mock: config.rinMock }))(url, payload);

export function setRinTransport(fn: typeof send): void {
  send = fn;
}

/** Задержка перед повтором №n (1, 5, 15 минут). После третьего повтора — FAILED и уведомление администратора. */
export function backoffMs(attempt: number): number | null {
  const m = config.rinBackoffMin[attempt - 1];
  return m === undefined ? null : m * 60_000 * config.rinBackoffScale;
}

/** Задание «в полёте» дольше этого — процесс, забравший его, считается упавшим: задание забирается снова. */
export const SYNC_LEASE_MS = 10 * 60_000;

/** OS-INSP-5.2.6: сколько протоколов одного тика отправляются одновременно. */
export const SYNC_CONCURRENCY = 4;

type SyncJob = { id: number; inspection_id: string; protocol_version: number; attempts: number; created_at: string | Date };

/**
 * Забрать созревшие задания атомарно: одним UPDATE перевести их в IN_FLIGHT. Строки, которые уже забирает
 * параллельный тик (другой процесс API), пропускаются (skip locked), а после его коммита не проходят по статусу —
 * одно задание отправляется одним тиком. Зависшее в IN_FLIGHT дольше SYNC_LEASE_MS забирается снова (at-least-once).
 */
async function claimDueSyncJobs(db: DB, at: Date): Promise<SyncJob[]> {
  const r = await db.run(
    `update sync_jobs set status = 'IN_FLIGHT', updated_at = $1
     where id in (
       select id from sync_jobs
       where (status = 'PENDING_SYNC' and next_attempt_at <= $1) or (status = 'IN_FLIGHT' and updated_at <= $2)
       order by next_attempt_at nulls first, id
       for update skip locked)
     returning id, inspection_id, protocol_version, attempts, created_at`,
    [at.toISOString(), new Date(at.getTime() - SYNC_LEASE_MS).toISOString()],
  );
  return (r.rows as SyncJob[]).sort((a, b) => a.id - b.id);
}

/** Выполнить fn над каждым элементом, не больше limit одновременно; порядок запуска — порядок списка. */
async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function runDueSyncJobs(db: DB, at = new Date()): Promise<number> {
  const jobs = await claimDueSyncJobs(db, at);
  // OS-INSP-5.2.6: параллельно, не больше SYNC_CONCURRENCY — зависшая отправка не держит остальные протоколы тика
  await pool(jobs, SYNC_CONCURRENCY, (j) => syncOne(db, j, at));
  return jobs.length;
}

async function syncOne(db: DB, j: SyncJob, at: Date): Promise<void> {
  const ts = at.toISOString();
  const insp = await db.get<{ status: string }>("select status from inspections where id = $1", [j.inspection_id]);
  if (insp?.status !== "FINALIZED") {
    // передача возможна только при статусе PROTOCOL_FINALIZED
    await db.run("update sync_jobs set status = 'CANCELLED', updated_at = $1 where id = $2 and status = 'IN_FLIGHT'", [ts, j.id]);
    return;
  }
  const p = await db.get<{ body_json: string }>("select body_json from protocols where inspection_id = $1 and version = $2", [j.inspection_id, j.protocol_version]);
  const attempt = j.attempts + 1;
  let ok = false;
  let err = "";
  // отправка — вне транзакции: сеть не держит соединение с базой и блокировки
  const t0 = performance.now();
  try {
    const r = await send(`${config.rinUrl}/api/v1/inspection/${encodeURIComponent(j.inspection_id)}`, rinPayload(JSON.parse(p!.body_json)));
    ok = r.status >= 200 && r.status < 300;
    err = ok ? "" : `HTTP ${r.status}`;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  // OS-INSP-5.2.6: время попытки — всегда; доставки (от постановки в очередь до ответа) — только при успехе
  const attemptMs = Math.round(performance.now() - t0);
  const deliveredMs = ok ? Math.max(0, Date.now() - new Date(j.created_at).getTime()) : null;
  slo.rinAttempt.observe(attemptMs / 1000);
  if (deliveredMs !== null) slo.rinDelivery.observe(deliveredMs / 1000);
  // итог — одной транзакцией: задание, статус проверки и уведомление не расходятся
  await db.tx(async (t) => {
    if (ok) {
      await t.run("update sync_jobs set status = 'SYNCED', attempts = $1, last_error = null, last_attempt_ms = $2, delivered_ms = $3, updated_at = $4 where id = $5", [attempt, attemptMs, deliveredMs, ts, j.id]);
      await t.run("update inspections set sync_status = 'SYNCED' where id = $1", [j.inspection_id]);
      log("INFO", "rin sync ok", { inspection_id: j.inspection_id, attempt_ms: attemptMs, delivered_ms: deliveredMs });
      return;
    }
    const wait = backoffMs(attempt);
    if (wait === null) {
      await t.run("update sync_jobs set status = 'FAILED', attempts = $1, last_error = $2, last_attempt_ms = $3, updated_at = $4 where id = $5", [attempt, err, attemptMs, ts, j.id]);
      await t.run("update inspections set sync_status = 'SYNC_FAILED' where id = $1", [j.inspection_id]);
      await notify(t, "admin", j.inspection_id, "ERROR", `ИАИС «РиН» недоступна: передача не удалась после ${attempt} попыток (${err}). Решение инспектора не изменено.`);
    } else {
      await t.run("update sync_jobs set status = 'PENDING_SYNC', attempts = $1, last_error = $2, last_attempt_ms = $3, next_attempt_at = $4, updated_at = $5 where id = $6", [attempt, err, attemptMs, new Date(at.getTime() + wait).toISOString(), ts, j.id]);
      await t.run("update inspections set sync_status = 'PENDING_SYNC' where id = $1", [j.inspection_id]);
    }
  });
}

/** Заглушка ИАИС «РиН» для демо: можно «уронить», чтобы показать PENDING_SYNC и повторы. */
export const rinMock = { down: false, received: [] as Array<{ id: string; at: string; confirmed: number }> };
