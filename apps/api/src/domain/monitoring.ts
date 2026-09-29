// NFR-METRICS-STORE (ТЗ §10 п. 13 Monitoring_Metrics, §13.4): снимок метрик производительности раз в минуту.
// Чистые функции: сырой срез счётчиков → строки таблицы monitoring_metrics; отсечка хранения; агрегация ряда по окнам.
// IO (чтение процесса, диска, базы; таймер; вставка и очистка) — services/monitoring.ts.

/** Срок хранения снимков, дней. */
export const RETENTION_DAYS = 90;
/** Предел точек ряда при автоматическом выборе окна: экран и ответ API не раздуваются на 90-дневном интервале. */
export const MAX_POINTS = 360;

/** Сырой срез в момент at: накопительные счётчики процесса (растут с запуска) и мгновенные значения. */
export type RawSample = {
  at: number; // мс эпохи
  requests: number; // счётчик HTTP-запросов
  errors5xx: number; // счётчик ответов 5xx
  latencyMsSum: number; // счётчик суммарной латентности, мс
  cpuMicros: number; // счётчик процессорного времени user+system, мкс
  rssBytes: number;
  heapUsedBytes: number;
  diskFreeBytes: number | null; // null — объём тома неизвестен
  diskTotalBytes: number | null;
  queueSize: number; // файлы в очереди разбора
  activeSessions: number;
  byRoute: Record<string, number>; // счётчик запросов по «МЕТОД /шаблон»
  latenciesMs: number[]; // латентности, накопленные с прошлого среза (для p95)
};

/** Строка таблицы monitoring_metrics без id. tags — JSON с отсортированными ключами. */
export type MetricRow = { metric_name: string; value: number; timestamp: string; service_name: string; tags: string };

/** Приращение счётчика за интервал. Значение меньше прежнего — счётчик сброшен рестартом: прирост с нуля. */
export function counterDelta(prev: number, cur: number): number {
  return cur >= prev ? cur - prev : cur;
}

/** Перцентиль по ближайшему рангу; пустой вход — null. Вход не меняется. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Кольцевой буфер латентностей между срезами: память ограничена cap, при переполнении теряются старейшие. */
export class LatencyWindow {
  private buf: number[] = [];
  private next = 0;
  constructor(private readonly cap = 10_000) {}
  push(ms: number): void {
    this.buf[this.next] = ms; // до заполнения next = length: массив растёт без дыр
    this.next = (this.next + 1) % this.cap;
  }
  /** Отдать накопленное и очистить. */
  drain(): number[] {
    const out = this.buf;
    this.buf = [];
    this.next = 0;
    return out;
  }
}

/** JSON меток с отсортированными ключами: одинаковый набор меток — одинаковая строка (группировка ряда). */
export function tagsJson(tags: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(tags).sort().map((k) => [k, tags[k]])));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Строки снимка за интервал prev → cur. Мгновенные значения пишутся всегда; скорости и приращения — только при
 * известном предыдущем срезе и положительном интервале. Маршруты — только с ненулевым приростом.
 */
export function snapshotRows(prev: RawSample | null, cur: RawSample, service = "api", baseTags: Record<string, string> = {}): MetricRow[] {
  const timestamp = new Date(cur.at).toISOString();
  const tags = tagsJson(baseTags);
  const rows: MetricRow[] = [];
  const put = (metric_name: string, value: number, t = tags) => rows.push({ metric_name, value: round3(value), timestamp, service_name: service, tags: t });

  const dtSec = prev ? (cur.at - prev.at) / 1000 : 0;
  if (prev && dtSec > 0) {
    const req = counterDelta(prev.requests, cur.requests);
    put("http_requests", req);
    put("http_rps", req / dtSec);
    put("http_errors_5xx", counterDelta(prev.errors5xx, cur.errors5xx));
    if (req > 0) put("http_latency_ms_avg", counterDelta(prev.latencyMsSum, cur.latencyMsSum) / req);
    put("process_cpu_percent", (counterDelta(prev.cpuMicros, cur.cpuMicros) / (dtSec * 1e6)) * 100);
    for (const [route, n] of Object.entries(cur.byRoute)) {
      const d = counterDelta(prev.byRoute[route] ?? 0, n);
      if (d > 0) put("http_route_requests", d, tagsJson({ ...baseTags, route }));
    }
  }
  const p95 = percentile(cur.latenciesMs, 95);
  if (p95 !== null) put("http_latency_ms_p95", p95);
  put("process_rss_bytes", cur.rssBytes);
  put("process_heap_used_bytes", cur.heapUsedBytes);
  if (cur.diskFreeBytes !== null) put("disk_free_bytes", cur.diskFreeBytes);
  if (cur.diskFreeBytes !== null && cur.diskTotalBytes) put("disk_used_percent", (1 - cur.diskFreeBytes / cur.diskTotalBytes) * 100);
  put("queue_size", cur.queueSize);
  put("active_sessions", cur.activeSessions);
  return rows;
}

/** Граница хранения: строки с timestamp раньше неё удаляются. */
export function retentionCutoff(now: number, days = RETENTION_DAYS): string {
  return new Date(now - days * 86_400_000).toISOString();
}

export type SeriesPoint = { t: string; avg: number; min: number; max: number; count: number };
export type Series = { tags: Record<string, string>; points: SeriesPoint[] };

/** Агрегация по окнам bucketSec: avg/min/max/count; отдельный ряд на каждый набор меток; точки по возрастанию. */
export function aggregate(rows: ReadonlyArray<{ timestamp: string; value: number; tags: string }>, bucketSec: number): Series[] {
  const width = bucketSec * 1000;
  const groups = new Map<string, Map<number, { sum: number; min: number; max: number; count: number }>>();
  for (const r of rows) {
    const start = Math.floor(Date.parse(r.timestamp) / width) * width;
    let g = groups.get(r.tags);
    if (!g) groups.set(r.tags, (g = new Map()));
    const b = g.get(start);
    if (b) {
      b.sum += r.value;
      b.min = Math.min(b.min, r.value);
      b.max = Math.max(b.max, r.value);
      b.count++;
    } else g.set(start, { sum: r.value, min: r.value, max: r.value, count: 1 });
  }
  // Ряд без меток сверху, дальше — по строке меток: порядок стабилен между запросами
  return [...groups.entries()]
    .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))
    .map(([tags, g]) => ({
      tags: JSON.parse(tags) as Record<string, string>,
      points: [...g.entries()]
        .sort(([a], [b]) => a - b)
        .map(([start, b]) => ({ t: new Date(start).toISOString(), avg: round3(b.sum / b.count), min: b.min, max: b.max, count: b.count })),
    }));
}

/** Окно по умолчанию: наименьшее кратное минуте, при котором интервал укладывается в MAX_POINTS точек. */
export function autoBucket(spanMs: number): number {
  return Math.max(1, Math.ceil(spanMs / (MAX_POINTS * 60_000))) * 60;
}

export type SeriesQuery = { name: string; from: string; to: string; bucketSec: number };

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Разбор ?name=&from=&to=&bucket=: по умолчанию последние сутки; интервал не длиннее срока хранения. */
export function parseSeriesQuery(q: Record<string, string | undefined>, now: number): ({ ok: true } & SeriesQuery) | { ok: false; error: string } {
  const name = q.name ?? "";
  if (!NAME.test(name)) return { ok: false, error: "name: имя метрики обязательно (латиница, цифры, _)" };
  const to = q.to === undefined ? now : Date.parse(q.to);
  const from = q.from === undefined ? to - 86_400_000 : Date.parse(q.from);
  if (Number.isNaN(to) || Number.isNaN(from)) return { ok: false, error: "from/to: ждём дату ISO 8601" };
  if (from > to) return { ok: false, error: "from позже to" };
  if (to - from > RETENTION_DAYS * 86_400_000) return { ok: false, error: `интервал длиннее срока хранения ${RETENTION_DAYS} дней` };
  let bucketSec = autoBucket(to - from);
  if (q.bucket !== undefined) {
    bucketSec = Number(q.bucket);
    if (!Number.isInteger(bucketSec) || bucketSec < 60 || bucketSec > 86_400) return { ok: false, error: "bucket: целое число секунд от 60 до 86400" };
  }
  return { ok: true, name, from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketSec };
}
