// NFR-METRICS-STORE (ТЗ §10 п. 13, §13.4): сэмплер метрик производительности → таблица monitoring_metrics.
// Раз в период (по умолчанию минута) снимает срез процесса, диска и базы, пишет строки пачкой в транзакции
// и удаляет строки старше срока хранения. Предметные расчёты — domain/monitoring.ts.
import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import {
  aggregate, retentionCutoff, RETENTION_DAYS, snapshotRows, type LatencyWindow, type MetricRow, type RawSample, type Series, type SeriesQuery,
} from "../domain/monitoring.ts";
import { log } from "./audit.ts";

/** Накопительные счётчики HTTP, которые ведёт app.ts (хук onResponse). */
export type HttpCounters = { requests: number; errors5xx: number; latencyMsSum: number; byRoute: Map<string, number>; latency: LatencyWindow };

/**
 * Том с базой: для PGlite на диске (pglite:<каталог>) — том его каталога данных; для базы в памяти и сервера
 * PostgreSQL (его диск снаружи процесса) — том корня приложения, где лежат blob-хранилище и журналы.
 */
export function diskDir(databaseUrl = config.databaseUrl, root = config.root): string {
  const u = databaseUrl.trim();
  return u.startsWith("pglite:") && u.length > "pglite:".length ? dirname(resolve(root, u.slice("pglite:".length))) : root;
}

function diskOf(): { free: number; total: number } | null {
  const dir = diskDir();
  try {
    const s = statfsSync(existsSync(dir) ? dir : config.root);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** Срез в момент now. Забирает латентности из окна — повторный вызов их уже не увидит. */
export async function collectRaw(db: DB, http: HttpCounters, now = Date.now()): Promise<RawSample> {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const disk = diskOf();
  const q = (await db.get<{ n: number }>("select count(*) n from files where parse_status in ('PENDING','PARSING')"))!;
  const s = (await db.get<{ n: number }>("select count(*) n from sessions where expires_at > $1", [new Date(now).toISOString()]))!;
  return {
    at: now, requests: http.requests, errors5xx: http.errors5xx, latencyMsSum: http.latencyMsSum, cpuMicros: cpu.user + cpu.system,
    rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, diskFreeBytes: disk?.free ?? null, diskTotalBytes: disk?.total ?? null,
    queueSize: q.n, activeSessions: s.n, byRoute: Object.fromEntries(http.byRoute), latenciesMs: http.latency.drain(),
  };
}

/** Вставка пачкой в одной транзакции. */
export async function saveMetricRows(db: DB, rows: readonly MetricRow[]): Promise<number> {
  await db.tx(async (t) => {
    for (const r of rows) {
      await t.run("insert into monitoring_metrics (metric_name, value, timestamp, service_name, tags) values ($1,$2,$3,$4,$5)", [r.metric_name, r.value, r.timestamp, r.service_name, r.tags]);
    }
  });
  return rows.length;
}

/** Удалить строки старше срока хранения. */
export async function purgeMetrics(db: DB, now = Date.now(), days = RETENTION_DAYS): Promise<number> {
  return (await db.run("delete from monitoring_metrics where timestamp < $1", [retentionCutoff(now, days)])).rowCount;
}

/**
 * Сэмплер: tick() — один снимок (тесты вызывают напрямую), start/stop — таймер процесса.
 * Снимок асинхронный: пока предыдущий не завершён, очередной такт таймера пропускается (снимки не наслаиваются).
 */
export class MetricsSampler {
  private prev: RawSample | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  constructor(private readonly db: DB, private readonly http: HttpCounters, private readonly opts: { service?: string; tags?: Record<string, string> } = {}) {}

  /** Снимок и очистка — одной транзакцией: срез ряда и срок хранения согласованы. */
  async tick(now = Date.now()): Promise<{ written: number; purged: number }> {
    const cur = await collectRaw(this.db, this.http, now);
    const rows = snapshotRows(this.prev, cur, this.opts.service ?? "api", this.opts.tags ?? {});
    const out = await this.db.tx(async (t) => ({ written: await saveMetricRows(t, rows), purged: await purgeMetrics(t, now) }));
    this.prev = cur;
    return out;
  }

  /** Фоновая работа таймера: ошибка — в журнал, процесс не падает; ожидается в stop(). */
  private run(job: () => Promise<unknown>): void {
    if (this.busy) return;
    this.busy = job()
      .then(() => undefined)
      .catch((e) => log("ERROR", "metrics snapshot", { message: String(e) })) // сбой снимка не роняет процесс
      .finally(() => {
        this.busy = null;
      });
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    // база скоростей: первый снимок через период уже со скоростями
    this.run(async () => {
      this.prev = await collectRaw(this.db, this.http);
    });
    this.timer = setInterval(() => this.run(() => this.tick()), intervalMs);
    this.timer.unref();
  }

  /** Остановить таймер и дождаться снимка, который уже идёт: после stop() в базу больше ничего не пишется. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
  }
}

/** Предел строк на запрос ряда: 90 дней по минуте — 129 600 строк на метрику без меток. */
const MAX_ROWS = 500_000;

/** Ряд метрики за интервал, агрегированный по окнам; ряды раздельно по наборам меток. */
export async function querySeries(db: DB, q: SeriesQuery): Promise<{ name: string; from: string; to: string; bucket_sec: number; series: Series[]; truncated: boolean }> {
  const rows = await db.all<{ value: number; timestamp: string; tags: string }>(
    "select value, timestamp, tags from monitoring_metrics where metric_name = $1 and timestamp >= $2 and timestamp <= $3 order by timestamp, id limit $4",
    [q.name, q.from, q.to, MAX_ROWS + 1],
  );
  const truncated = rows.length > MAX_ROWS;
  return { name: q.name, from: q.from, to: q.to, bucket_sec: q.bucketSec, series: aggregate(truncated ? rows.slice(0, MAX_ROWS) : rows, q.bucketSec), truncated };
}

/** Каталог метрик: имя, время последнего снимка и последнее значение (ряд без меток или любой). */
export async function metricCatalog(db: DB): Promise<Array<{ metric_name: string; last_at: string; last_value: number | null; service_name: string }>> {
  return db.all(`select m.metric_name, m.last_at,
      (select value from monitoring_metrics x where x.metric_name = m.metric_name and x.timestamp = m.last_at order by length(x.tags::text), x.id limit 1) last_value,
      (select service_name from monitoring_metrics x where x.metric_name = m.metric_name and x.timestamp = m.last_at order by x.id limit 1) service_name
    from (select metric_name, max(timestamp) last_at from monitoring_metrics group by metric_name) m order by m.metric_name collate "C"`);
}
