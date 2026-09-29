// Очередь заданий на RabbitMQ (ТЗ 1.5, ADR-0001, профиль gpu) с той же семантикой, что inProcessQueue:
// задание подтверждается (ack) после успеха; при сбое публикуется заново с attempt+1 и старое подтверждается;
// после maxRetries — onDead. Параллельность — prefetch канала. Адаптер пишет в узкий интерфейс канала,
// чтобы один контрактный тест проверял и брокер, и очередь в процессе.
import { log } from "./audit.ts";
import { runOnDead, type Job, type JobQueue, type OnDead } from "./queue.ts";

export interface AmqpMessage {
  content: Buffer;
  properties: { headers?: Record<string, unknown> };
}

export interface AmqpChannel {
  assertQueue(queue: string, opts?: { durable?: boolean }): Promise<unknown>;
  prefetch(count: number): unknown;
  sendToQueue(queue: string, content: Buffer, opts?: { persistent?: boolean; headers?: Record<string, unknown> }): boolean;
  consume(queue: string, onMessage: (msg: AmqpMessage | null) => void, opts?: { noAck?: boolean }): Promise<unknown>;
  ack(msg: AmqpMessage): void;
}

export function amqpQueue<T>(
  ch: AmqpChannel,
  name: string,
  handler: (job: Job<T>) => Promise<void>,
  opts: { concurrency: number; maxRetries: number; onDead: OnDead<T> },
): JobQueue<T> & { ready: Promise<void> } {
  let outstanding = 0; // опубликовано этим процессом и ещё не завершено (успех или onDead)
  let waiters: Array<() => void> = [];
  const settle = () => {
    if (outstanding === 0) {
      const w = waiters;
      waiters = [];
      w.forEach((f) => f());
    }
  };
  const send = (job: Job<T>) => ch.sendToQueue(name, Buffer.from(JSON.stringify({ id: job.id, payload: job.payload })), { persistent: true, headers: { attempt: job.attempt } });

  const ready = (async () => {
    await ch.assertQueue(name, { durable: true });
    await ch.prefetch(opts.concurrency);
    await ch.consume(name, (msg) => {
      if (!msg) return; // брокер отменил подписку
      let job: Job<T>;
      try {
        const body = JSON.parse(msg.content.toString("utf8"));
        job = { id: body.id, payload: body.payload, attempt: Number(msg.properties.headers?.attempt ?? 0) };
      } catch {
        ch.ack(msg); // нечитаемое сообщение не перечитывать бесконечно
        return;
      }
      void handler(job) // цепочка сама ловит сбои: повтор или onDead
        .then(() => {
          ch.ack(msg);
          outstanding--;
          settle();
        })
        .catch(async (err) => {
          if (job.attempt < opts.maxRetries) {
            // причина повтора — в журнал: без неё ночной прогон не разобрать (T-129, стенд «Алтуфьево»)
            log("WARNING", "queue retry", { queue: name, job: job.id, attempt: job.attempt + 1, reason: String((err as Error)?.message ?? err).slice(0, 300) });
            send({ ...job, attempt: job.attempt + 1 }); // сначала публикуем повтор, потом подтверждаем старое
            ch.ack(msg);
          } else {
            ch.ack(msg);
            await runOnDead(opts.onDead, job, err); // idle() — после записи отказа в БД
            outstanding--;
            settle();
          }
        });
    }, { noAck: false });
  })();

  return {
    ready,
    push(id, payload) {
      outstanding++;
      void ready.then(() => send({ id, payload, attempt: 0 }));
    },
    idle() {
      if (outstanding === 0) return Promise.resolve();
      return new Promise((r) => waiters.push(r));
    },
    size: () => outstanding,
  };
}

/** Канал настоящего RabbitMQ (профиль gpu). amqplib грузится только здесь — в профиле dev он не нужен. */
export async function connectAmqp(url: string): Promise<AmqpChannel> {
  const amqp = await import("amqplib");
  const conn = await amqp.connect(url);
  return (await conn.createChannel()) as unknown as AmqpChannel;
}
