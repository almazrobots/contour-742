// NFR-SLA (ТЗ 11-12): проверка готовности для GET /ready — IO вокруг чистой readiness() из domain/slo.ts.
// БД и ML опрашиваются параллельно; каждой зависимости — не больше READY_TIMEOUT_MS: зависшая база или ML дают 503
// за ≤ 2 с, а не зависшую пробу blackbox-exporter (тайм-аут пробы тоже считается отказом, но без имени виновника).
import type { DB } from "../db.ts";
import { readiness, READY_TIMEOUT_MS, type ReadyAnswer } from "../domain/slo.ts";
import { mlHealth } from "./ml-client.ts";

/** true — зависимость ответила вовремя и без ошибки; исключение и тайм-аут — false. */
export async function within(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((ok) => {
    timer = setTimeout(() => ok(false), ms);
  });
  try {
    return await Promise.race([check().catch(() => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReady(db: DB, ms: number = READY_TIMEOUT_MS): Promise<ReadyAnswer> {
  const [dbOk, mlOk] = await Promise.all([
    within(async () => (await db.get<{ ok: number }>("select 1 as ok"))?.ok === 1, ms),
    within(async () => (await mlHealth()).ok, ms),
  ]);
  return readiness({ db: dbOk, ml: mlOk });
}
