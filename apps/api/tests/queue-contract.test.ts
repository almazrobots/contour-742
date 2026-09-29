// Контракт очереди (ТЗ 1.5, OS-INSP-2.1.4): одна семантика в профилях dev (в процессе) и gpu (RabbitMQ).
// Брокер подменён поддельным в процессе: очередь сообщений, prefetch, ack, повторная доставка неподтверждённого.
import { describe, expect, it } from "vitest";
import { amqpQueue, type AmqpChannel, type AmqpMessage } from "../src/services/amqp-queue.ts";
import { inProcessQueue, type Job, type JobQueue } from "../src/services/queue.ts";

/** Поддельный брокер: FIFO, не больше prefetch неподтверждённых сообщений у потребителя. */
function fakeBroker() {
  const queues = new Map<string, AmqpMessage[]>();
  let consumer: ((m: AmqpMessage | null) => void) | null = null;
  let prefetch = 1;
  let unacked = 0;
  const stats = { sent: 0, acked: 0, persistent: true, assertOpts: null as any, consumeOpts: null as any };
  const pump = (q: string) => {
    const list = queues.get(q)!;
    while (consumer && unacked < prefetch && list.length) {
      unacked++;
      const m = list.shift()!;
      queueMicrotask(() => consumer!(m));
    }
  };
  const ch: AmqpChannel = {
    async assertQueue(q, o) { stats.assertOpts = o; if (!queues.has(q)) queues.set(q, []); return {}; },
    prefetch(n) { prefetch = n; },
    sendToQueue(q, content, opts) {
      stats.sent++;
      stats.persistent &&= Boolean(opts?.persistent);
      queues.get(q)!.push({ content, properties: { headers: opts?.headers } });
      pump(q);
      return true;
    },
    async consume(q, fn, o) { stats.consumeOpts = o; consumer = fn; pump(q); return {}; },
    ack() { unacked--; stats.acked++; for (const q of queues.keys()) pump(q); },
  };
  return { ch, stats, deliver: (m: AmqpMessage | null) => consumer!(m) };
}

type Make = <T>(h: (j: Job<T>) => Promise<void>, o: { concurrency: number; maxRetries: number; onDead: (j: Job<T>, e: unknown) => void }) => JobQueue<T>;
const impls: Array<[string, Make]> = [
  ["в процессе (dev)", (h, o) => inProcessQueue(h, o)],
  ["RabbitMQ (gpu, поддельный брокер)", (h, o) => amqpQueue(fakeBroker().ch, "inspector.parse", h, o)],
];

describe.each(impls)("контракт очереди: %s", (_, make) => {
  it("сбойное задание — 3 попытки (0, 1, 2), затем onDead; очередь пуста", async () => {
    const attempts: number[] = [];
    const dead: string[] = [];
    const q = make<string>(async (j) => { attempts.push(j.attempt); throw new Error("timeout"); }, { concurrency: 2, maxRetries: 2, onDead: (j) => dead.push(j.id) });
    q.push("f1", "x");
    await q.idle();
    expect([attempts, dead, q.size()]).toEqual([[0, 1, 2], ["f1"], 0]);
  });
  it("успех со второй попытки — без onDead; полезная нагрузка доходит целиком", async () => {
    let n = 0;
    const seen: unknown[] = [];
    const dead: string[] = [];
    const q = make<{ fileId: string }>(async (j) => { seen.push(j.payload); if (n++ === 0) throw new Error("flaky"); }, { concurrency: 1, maxRetries: 2, onDead: (j) => dead.push(j.id) });
    q.push("f2", { fileId: "F-9" });
    await q.idle();
    expect([n, dead.length, seen]).toEqual([2, 0, [{ fileId: "F-9" }, { fileId: "F-9" }]]);
  });
  it("предел параллельности соблюдается", async () => {
    let running = 0;
    let peak = 0;
    const q = make<number>(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; }, { concurrency: 2, maxRetries: 0, onDead: () => {} });
    for (let i = 0; i < 6; i++) q.push(String(i), i);
    await q.idle();
    expect(peak).toBe(2);
  });
});

describe("RabbitMQ: подтверждения и устойчивость", () => {
  it("каждое сообщение подтверждено, повторы публикуются persistent; нечитаемое сообщение подтверждается и не зацикливает", async () => {
    const { ch, stats } = fakeBroker();
    const q = amqpQueue<string>(ch, "q", async (j) => { if (j.attempt === 0) throw new Error("x"); }, { concurrency: 1, maxRetries: 2, onDead: () => {} });
    await q.ready;
    q.push("a", "p");
    await q.idle();
    expect([stats.sent, stats.acked, stats.persistent]).toEqual([2, 2, true]);
    ch.sendToQueue("q", Buffer.from("не json"), { persistent: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(stats.acked).toBe(3);
  });
});

describe("RabbitMQ: объявление очереди, отмена подписки, сообщения без заголовков, idle", () => {
  it("очередь durable, подтверждения ручные (noAck: false)", async () => {
    const { ch, stats } = fakeBroker();
    await amqpQueue<string>(ch, "q", async () => {}, { concurrency: 1, maxRetries: 0, onDead: () => {} }).ready;
    expect([stats.assertOpts, stats.consumeOpts]).toEqual([{ durable: true }, { noAck: false }]);
  });
  it("отмена подписки брокером (null) не роняет потребителя; сообщение без заголовков — попытка 0", async () => {
    const { ch, deliver } = fakeBroker();
    const seen: number[] = [];
    const q = amqpQueue<string>(ch, "q", async (j) => { seen.push(j.attempt); }, { concurrency: 1, maxRetries: 0, onDead: () => {} });
    await q.ready;
    expect(() => deliver(null)).not.toThrow();
    deliver({ content: Buffer.from(JSON.stringify({ id: "x", payload: "p" })), properties: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([0]);
  });
  it("исчерпанные повторы: сообщение подтверждено, onDead вызван один раз", async () => {
    const { ch, stats } = fakeBroker();
    const dead: string[] = [];
    const q = amqpQueue<string>(ch, "q", async () => { throw new Error("x"); }, { concurrency: 1, maxRetries: 1, onDead: (j) => dead.push(j.id) });
    q.push("d", "p");
    await q.idle();
    expect([dead, stats.sent, stats.acked]).toEqual([["d"], 2, 2]);
  });
  it("idle пустой очереди разрешается сразу; при двух заданиях — только после последнего", async () => {
    const { ch } = fakeBroker();
    const done: string[] = [];
    const q = amqpQueue<string>(ch, "q", async (j) => { await new Promise((r) => setTimeout(r, j.id === "slow" ? 30 : 1)); done.push(j.id); }, { concurrency: 2, maxRetries: 0, onDead: () => {} });
    await Promise.race([q.idle(), new Promise((_, rej) => setTimeout(() => rej(new Error("idle пустой очереди не разрешилась")), 200))]);
    q.push("fast", "a");
    q.push("slow", "b");
    await q.idle();
    expect(done.sort()).toEqual(["fast", "slow"]);
  });
});
