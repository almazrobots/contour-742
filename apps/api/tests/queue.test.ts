// OS-INSP-2.1.4: сбой разбора повторяется до 2 раз, затем — уведомление (onDead). Эшелон L4 — внедрение отказов.
import { describe, expect, it } from "vitest";
import { inProcessQueue } from "../src/services/queue.ts";

describe("очередь заданий", () => {
  it("повторяет сбойное задание до 2 раз, затем уведомляет", async () => {
    const attempts: number[] = [];
    const dead: string[] = [];
    const q = inProcessQueue<string>(
      async (job) => {
        attempts.push(job.attempt);
        throw new Error("timeout");
      },
      { concurrency: 2, maxRetries: 2, onDead: (job) => dead.push(job.id) },
    );
    q.push("f1", "x");
    await q.idle();
    expect(attempts).toEqual([0, 1, 2]);
    expect(dead).toEqual(["f1"]);
  });
  it("успешное со второй попытки не уходит в onDead", async () => {
    let n = 0;
    const dead: string[] = [];
    const q = inProcessQueue<string>(async () => {
      if (n++ === 0) throw new Error("flaky");
    }, { concurrency: 1, maxRetries: 2, onDead: (j) => dead.push(j.id) });
    q.push("f2", "y");
    await q.idle();
    expect([n, dead.length, q.size()]).toEqual([2, 0, 0]);
  });
  it("соблюдает предел параллельности", async () => {
    let running = 0;
    let peak = 0;
    const q = inProcessQueue<number>(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    }, { concurrency: 2, maxRetries: 0, onDead: () => {} });
    for (let i = 0; i < 6; i++) q.push(String(i), i);
    await q.idle();
    expect(peak).toBe(2);
  });
});

import { formatLog } from "../src/services/audit.ts";

describe("журнал событий", () => {
  it("строка лога — JSON с обязательными полями ТЗ 13.1", () => {
    const line = JSON.parse(formatLog("ERROR", "сбой", { request_id: "r1", user_id: "u1", extra: 1 }, new Date("2026-09-24T00:00:00Z"))!);
    expect(line).toEqual({ timestamp: "2026-09-24T00:00:00.000Z", level: "ERROR", service: "api", message: "сбой", request_id: "r1", user_id: "u1", extra: 1 });
    expect(JSON.parse(formatLog("INFO", "x")!)).toMatchObject({ request_id: null, user_id: null });
  });
  it("DEBUG пишется только при INSPECTOR_DEBUG=1", () => {
    delete process.env.INSPECTOR_DEBUG;
    expect(formatLog("DEBUG", "x")).toBeNull();
    process.env.INSPECTOR_DEBUG = "1";
    expect(formatLog("DEBUG", "x")).not.toBeNull();
    delete process.env.INSPECTOR_DEBUG;
  });
});
