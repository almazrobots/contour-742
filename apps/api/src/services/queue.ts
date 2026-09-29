// Очередь заданий. Профиль dev — в процессе; прод — RabbitMQ (ТЗ 1.5, ADR-0001) с той же семантикой:
// задание подтверждается после успеха, при сбое повторяется не более maxRetries раз, затем — onDead.
// onDead может быть асинхронным (пишет в БД): idle() разрешается только после его завершения.

export interface Job<T> {
  id: string;
  payload: T;
  attempt: number;
}

export interface JobQueue<T> {
  push(id: string, payload: T): void;
  idle(): Promise<void>;
  size(): number;
}

/** Возвращённый промис дожидается (запись отказа в БД); результат иначе не используется. */
export type OnDead<T> = (job: Job<T>, err: unknown) => unknown;

/** Выполнить onDead; его сбой не роняет процесс (необработанный отказ промиса), а пишется в журнал. */
export async function runOnDead<T>(onDead: OnDead<T>, job: Job<T>, err: unknown): Promise<void> {
  try {
    await onDead(job, err);
  } catch (e) {
    console.error(JSON.stringify({ level: "ERROR", message: "queue onDead", job: job.id, error: String((e as Error)?.message ?? e) }));
  }
}

export function inProcessQueue<T>(
  handler: (job: Job<T>) => Promise<void>,
  opts: { concurrency: number; maxRetries: number; onDead: OnDead<T> },
): JobQueue<T> {
  const waiting: Job<T>[] = [];
  let running = 0;
  let waiters: Array<() => void> = [];

  const settle = () => {
    if (running === 0 && waiting.length === 0) {
      const w = waiters;
      waiters = [];
      w.forEach((f) => f());
    }
  };

  const pump = () => {
    while (running < opts.concurrency && waiting.length) {
      const job = waiting.shift()!;
      running++;
      void handler(job) // цепочка сама ловит сбои и завершает задание
        .catch(async (err) => {
          if (job.attempt < opts.maxRetries) waiting.push({ ...job, attempt: job.attempt + 1 });
          else await runOnDead(opts.onDead, job, err);
        })
        .finally(() => {
          running--;
          pump();
          settle();
        });
    }
  };

  return {
    push(id, payload) {
      waiting.push({ id, payload, attempt: 0 });
      queueMicrotask(pump);
    },
    idle() {
      if (running === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((r) => waiters.push(r));
    },
    size: () => waiting.length + running,
  };
}
