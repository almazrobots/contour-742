// OS-INSP-5.2 (ТЗ 9.6): повторная отправка протокола в ИАИС «РиН» — конкурентность очереди sync_jobs (T-107).
// Два тика (два процесса API или наложение таймера) не отправляют одно задание дважды: задание забирается
// атомарно (update … for update skip locked → IN_FLIGHT). L4 — интеграция с БД, L6 — отказы. Без ML и без «РиН»:
// транспорт подменён. Строки заводятся SQL напрямую — тест не зависит от конвейера проверки.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let db: any;
let rin: typeof import("../src/services/rin.ts");
const sent: string[] = [];
let reply: () => Promise<{ status: number }> = async () => ({ status: 200 });

const body = (id: string) => JSON.stringify({ process_id: id, object: {}, protocol_version: 1, versions: {}, input_files: [], sections: { confirmed_violations: [] }, ai_usage: null });

async function finalized(id: string, status = "FINALIZED"): Promise<number> {
  const now = new Date().toISOString();
  await db.run("insert into objects (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing", ["SYNC-OBJ", "Объект", now]);
  await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1, 'SYNC-OBJ', $2, 1, $3, $3)", [id, status, now]);
  await db.run("insert into protocols (inspection_id, version, status, body_json, created_at) values ($1, 1, 'FINALIZED', $2, $3)", [id, body(id), now]);
  const r = await db.run("insert into sync_jobs (inspection_id, protocol_version, status, next_attempt_at, created_at, updated_at) values ($1, 1, 'PENDING_SYNC', $2, $2, $2) returning id", [id, now]);
  return r.rows[0].id;
}
const job = (id: number) => db.get("select * from sync_jobs where id = $1", [id]);

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  rin = await import("../src/services/rin.ts");
  db = await openDb("memory");
  rin.setRinTransport(async (url) => {
    sent.push(url);
    await new Promise((r) => setTimeout(r, 30)); // отправка идёт, пока второй тик пытается забрать то же задание
    return reply();
  });
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.run("delete from sync_jobs"); // задание прошлого теста с отсрочкой созрело бы в будущем «at»
  sent.length = 0;
  reply = async () => ({ status: 200 });
});

describe("очередь отправки в «РиН» при параллельных тиках", () => {
  it("два параллельных runDueSyncJobs — одно отправление, задание SYNCED, второй тик пуст", async () => {
    const id = await finalized("P-SYNC-1");
    const at = new Date(Date.now() + 1000);
    const n = await Promise.all([rin.runDueSyncJobs(db, at), rin.runDueSyncJobs(db, at)]);
    expect(n.sort()).toEqual([0, 1]);
    expect(sent.filter((u) => u.endsWith("/P-SYNC-1"))).toHaveLength(1);
    expect(await job(id)).toMatchObject({ status: "SYNCED", attempts: 1, last_error: null });
    expect((await db.get("select sync_status from inspections where id = 'P-SYNC-1'")).sync_status).toBe("SYNCED");
    // повторный тик после завершения — заданий нет, повторной отправки нет
    expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 60_000))).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("сбой отправки при параллельных тиках — одна попытка, задание снова PENDING_SYNC с отсрочкой", async () => {
    const id = await finalized("P-SYNC-2");
    reply = async () => ({ status: 503 });
    const at = new Date(Date.now() + 1000);
    await Promise.all([rin.runDueSyncJobs(db, at), rin.runDueSyncJobs(db, at), rin.runDueSyncJobs(db, at)]);
    expect(sent).toHaveLength(1);
    const j = await job(id);
    expect(j).toMatchObject({ status: "PENDING_SYNC", attempts: 1, last_error: "HTTP 503" });
    expect(new Date(j.next_attempt_at).getTime()).toBeGreaterThan(at.getTime());
    expect((await db.get("select sync_status from inspections where id = 'P-SYNC-2'")).sync_status).toBe("PENDING_SYNC");
  });

  it("задание «в полёте» не забирается, пока захват свежий; захват упавшего процесса истекает — задание отправляется", async () => {
    const id = await finalized("P-SYNC-3");
    const at = new Date(Date.now() + 1000);
    await db.run("update sync_jobs set status = 'IN_FLIGHT', updated_at = $1 where id = $2", [at.toISOString(), id]);
    expect(await rin.runDueSyncJobs(db, new Date(at.getTime() + 1000))).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await rin.runDueSyncJobs(db, new Date(at.getTime() + rin.SYNC_LEASE_MS + 1))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await job(id)).toMatchObject({ status: "SYNCED" });
  });

  it("проверка не финализирована — задание отменяется без отправки", async () => {
    const id = await finalized("P-SYNC-4", "READY");
    expect(await rin.runDueSyncJobs(db, new Date(Date.now() + 1000))).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await job(id)).toMatchObject({ status: "CANCELLED" });
  });
});
