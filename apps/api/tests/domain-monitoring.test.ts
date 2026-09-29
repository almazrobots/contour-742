// NFR-METRICS-STORE (ТЗ §10 п. 13, §13.4): снимок метрик производительности раз в минуту → monitoring_metrics.
// Предметная часть — чистые функции domain/monitoring.ts: дельты счётчиков, p95, отсечка 90 дней, агрегация ряда.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aggregate, autoBucket, counterDelta, LatencyWindow, MAX_POINTS, parseSeriesQuery, percentile, RETENTION_DAYS, retentionCutoff, snapshotRows, tagsJson, type RawSample,
} from "../src/domain/monitoring.ts";

const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const raw = (o: Partial<RawSample> = {}): RawSample => ({
  at: T0, requests: 0, errors5xx: 0, latencyMsSum: 0, cpuMicros: 0, rssBytes: 100, heapUsedBytes: 50,
  diskFreeBytes: 250, diskTotalBytes: 1000, queueSize: 3, activeSessions: 2, byRoute: {}, latenciesMs: [], ...o,
});
const byName = (rows: ReturnType<typeof snapshotRows>) => Object.fromEntries(rows.filter((r) => !JSON.parse(r.tags).route).map((r) => [r.metric_name, r.value]));

describe("счётчики: приращение за интервал", () => {
  it("обычный рост — разность", () => expect(counterDelta(10, 25)).toBe(15));
  it("без изменений — ноль", () => expect(counterDelta(7, 7)).toBe(0));
  it("сброс счётчика (рестарт процесса) — приращение равно новому значению, не отрицательное", () => {
    expect(counterDelta(100, 4)).toBe(4);
    expect(counterDelta(100, 0)).toBe(0);
  });
  it("свойство: приращение никогда не отрицательно и не больше текущего значения", () =>
    fc.assert(fc.property(fc.nat(), fc.nat(), (a, b) => {
      const d = counterDelta(a, b);
      return d >= 0 && d <= b;
    })));
});

describe("перцентиль (p95 латентности за интервал)", () => {
  it("пусто — нет значения", () => expect(percentile([], 95)).toBeNull());
  it("одно значение — оно же", () => expect(percentile([42], 95)).toBe(42));
  it("ближайший ранг: 1..100 → p95 = 95, p50 = 50, p100 = 100", () => {
    const v = Array.from({ length: 100 }, (_, i) => 100 - i); // порядок входа не важен
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 100)).toBe(100);
  });
  it("p0 — минимум; вход не сортируется на месте", () => {
    const v = [5, 1, 3];
    expect(percentile(v, 0)).toBe(1);
    expect(v).toEqual([5, 1, 3]);
  });
  it("20 значений: p95 — 19-е по порядку", () => expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19));
  it("свойство: результат — один из элементов, между минимумом и максимумом", () =>
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1e6 }), { minLength: 1 }), fc.integer({ min: 0, max: 100 }), (v, p) => {
      const r = percentile(v, p)!;
      return v.includes(r) && r >= Math.min(...v) && r <= Math.max(...v);
    })));
});

describe("кольцевой буфер латентностей", () => {
  it("накапливает и отдаёт с очисткой", () => {
    const w = new LatencyWindow(10);
    expect(w.drain()).toEqual([]);
    w.push(1); w.push(2);
    expect(w.drain()).toEqual([1, 2]);
    expect(w.drain()).toEqual([]);
  });
  it("при переполнении хранит последние cap значений — память ограничена", () => {
    const w = new LatencyWindow(3);
    for (const v of [1, 2, 3, 4, 5]) w.push(v);
    expect(w.drain().sort()).toEqual([3, 4, 5]);
    w.push(9);
    expect(w.drain()).toEqual([9]);
  });
  it("ёмкость по умолчанию — 10 000", () => {
    const w = new LatencyWindow();
    for (let i = 0; i < 10_001; i++) w.push(i);
    const d = w.drain();
    expect(d).toHaveLength(10_000);
    expect(d).not.toContain(0);
  });
});

describe("теги", () => {
  it("JSON с отсортированными ключами — одна и та же метка даёт одну строку", () => {
    expect(tagsJson({ route: "GET /x", profile: "dev" })).toBe('{"profile":"dev","route":"GET /x"}');
    expect(tagsJson({})).toBe("{}");
    expect(tagsJson({ c: "3", a: "1", d: "4", b: "2" })).toBe('{"a":"1","b":"2","c":"3","d":"4"}');
  });
});

describe("снимок метрик (snapshotRows)", () => {
  const prev = raw({ requests: 100, errors5xx: 2, latencyMsSum: 1000, cpuMicros: 1_000_000, byRoute: { "GET /a": 60, "POST /b": 40 } });
  const cur = raw({
    at: T0 + 60_000, requests: 160, errors5xx: 5, latencyMsSum: 2800, cpuMicros: 7_000_000,
    byRoute: { "GET /a": 60, "POST /b": 70, "GET /c": 30 }, latenciesMs: Array.from({ length: 20 }, (_, i) => i + 1),
  });
  const rows = snapshotRows(prev, cur, "api", { profile: "dev" });

  it("каждая строка — поля Monitoring_Metrics: metric_name, value, timestamp, service_name, tags", () => {
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["metric_name", "service_name", "tags", "timestamp", "value"]);
      expect(r.timestamp).toBe("2026-09-26T10:01:00.000Z");
      expect(r.service_name).toBe("api");
      expect(JSON.parse(r.tags).profile).toBe("dev");
      expect(Number.isFinite(r.value)).toBe(true);
    }
  });

  it("счётчики → приращение и скорость за интервал, латентность средняя и p95, CPU в процентах", () => {
    expect(byName(rows)).toEqual({
      http_requests: 60, http_rps: 1, http_errors_5xx: 3, http_latency_ms_avg: 30, http_latency_ms_p95: 19,
      process_cpu_percent: 10, process_rss_bytes: 100, process_heap_used_bytes: 50,
      disk_free_bytes: 250, disk_used_percent: 75, queue_size: 3, active_sessions: 2,
    });
  });

  it("запросы по маршрутам — только выросшие, маршрут в тегах; новый маршрут считается от нуля", () => {
    const routes = rows.filter((r) => r.metric_name === "http_route_requests").map((r) => [JSON.parse(r.tags).route, r.value]);
    expect(routes.sort()).toEqual([["GET /c", 30], ["POST /b", 30]]);
    const t = rows.find((r) => r.metric_name === "http_route_requests")!.tags;
    expect(t).toBe(tagsJson({ profile: "dev", route: JSON.parse(t).route }));
  });

  it("первый снимок (нет предыдущего) — только мгновенные значения и p95, без скоростей", () => {
    const first = snapshotRows(null, cur);
    expect(Object.keys(byName(first)).sort()).toEqual(["active_sessions", "disk_free_bytes", "disk_used_percent", "http_latency_ms_p95", "process_heap_used_bytes", "process_rss_bytes", "queue_size"]);
    expect(first.every((r) => r.service_name === "api" && r.tags === "{}")).toBe(true);
  });

  it("нулевой или обратный интервал времени — скоростей нет (деления на ноль нет)", () => {
    expect(byName(snapshotRows(cur, cur)).http_rps).toBeUndefined();
    expect(byName(snapshotRows(cur, { ...cur, at: cur.at - 1 })).http_requests).toBeUndefined();
  });

  it("рестарт между снимками: счётчики меньше прежних — скорость не отрицательна", () => {
    const after = raw({ at: T0 + 120_000, requests: 6, errors5xx: 0, latencyMsSum: 60, cpuMicros: 600_000, byRoute: { "GET /a": 6 } });
    const m = byName(snapshotRows(cur, after));
    expect(m).toMatchObject({ http_requests: 6, http_rps: 0.1, http_errors_5xx: 0, http_latency_ms_avg: 10, process_cpu_percent: 1 });
    expect(snapshotRows(cur, after).every((r) => r.value >= 0)).toBe(true);
  });

  it("без запросов за интервал — средней латентности и p95 нет, скорость 0", () => {
    const idle = raw({ at: T0 + 60_000, requests: 100, errors5xx: 2, latencyMsSum: 1000, cpuMicros: 1_000_000, byRoute: prev.byRoute });
    const m = byName(snapshotRows(prev, idle));
    expect(m.http_rps).toBe(0);
    expect(m.http_latency_ms_avg).toBeUndefined();
    expect(m.http_latency_ms_p95).toBeUndefined();
    expect(snapshotRows(prev, idle).some((r) => r.metric_name === "http_route_requests")).toBe(false);
  });

  it("диск неизвестен (нет statfs) — дисковых строк нет; нулевой объём — нет процента", () => {
    expect(byName(snapshotRows(null, raw({ diskFreeBytes: null, diskTotalBytes: null })))).not.toHaveProperty("disk_free_bytes");
    const z = byName(snapshotRows(null, raw({ diskFreeBytes: 0, diskTotalBytes: 0 })));
    expect(z.disk_free_bytes).toBe(0);
    expect(z).not.toHaveProperty("disk_used_percent");
    expect(byName(snapshotRows(null, raw({ diskFreeBytes: null, diskTotalBytes: 1000 })))).not.toHaveProperty("disk_used_percent");
  });

  it("значения округляются до тысячных", () => {
    const m = byName(snapshotRows(raw(), raw({ at: T0 + 3000, requests: 1, latencyMsSum: 1 / 3 })));
    expect(m.http_rps).toBe(0.333);
    expect(m.http_latency_ms_avg).toBe(0.333);
  });
});

describe("хранение 90 дней", () => {
  it("срок по умолчанию — 90 дней", () => {
    expect(RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(T0)).toBe("2026-06-28T10:00:00.000Z");
  });
  it("свой срок", () => expect(retentionCutoff(T0, 1)).toBe("2026-09-25T10:00:00.000Z"));
});

describe("агрегация ряда по окнам", () => {
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const rows = [
    { timestamp: at(0), value: 1, tags: "{}" },
    { timestamp: at(60), value: 5, tags: "{}" },
    { timestamp: at(299), value: 3, tags: "{}" },
    { timestamp: at(300), value: 10, tags: "{}" },
    { timestamp: at(120), value: 7, tags: '{"route":"GET /a"}' },
  ];
  it("avg/min/max/count в окне; окна по началу, по возрастанию; ряды раздельно по тегам", () => {
    expect(aggregate(rows, 300)).toEqual([
      { tags: {}, points: [{ t: at(0), avg: 3, min: 1, max: 5, count: 3 }, { t: at(300), avg: 10, min: 10, max: 10, count: 1 }] },
      { tags: { route: "GET /a" }, points: [{ t: at(0), avg: 7, min: 7, max: 7, count: 1 }] },
    ]);
  });
  it("строки в любом порядке — точки всё равно по возрастанию времени", () => {
    const pts = aggregate([...rows].reverse(), 60)[0].points.map((p) => p.t);
    expect(pts).toEqual([...pts].sort());
    expect(pts).toEqual([at(0), at(60), at(240), at(300)]);
  });
  it("пусто — пусто", () => expect(aggregate([], 60)).toEqual([]));
  it("ряды с метками одной длины — по строке меток", () => {
    const s = aggregate([{ timestamp: at(0), value: 1, tags: '{"route":"GET /b"}' }, { timestamp: at(0), value: 2, tags: '{"route":"GET /a"}' }, { timestamp: at(0), value: 3, tags: '{"route":"GET /c"}' }], 60);
    expect(s.map((x) => x.tags.route)).toEqual(["GET /a", "GET /b", "GET /c"]);
  });
  it("среднее округляется до тысячных", () => {
    expect(aggregate([{ timestamp: at(0), value: 1, tags: "{}" }, { timestamp: at(1), value: 0, tags: "{}" }, { timestamp: at(2), value: 0, tags: "{}" }], 60)[0].points[0].avg).toBe(0.333);
  });
  it("свойство: сумма count по окнам равна числу строк, min ≤ avg ≤ max", () =>
    fc.assert(fc.property(fc.array(fc.record({ s: fc.integer({ min: 0, max: 86_400 }), v: fc.integer({ min: -1000, max: 1000 }) })), fc.integer({ min: 60, max: 3600 }), (xs, b) => {
      const s = aggregate(xs.map((x) => ({ timestamp: at(x.s), value: x.v, tags: "{}" })), b);
      const pts = s.flatMap((x) => x.points);
      return pts.reduce((n, p) => n + p.count, 0) === xs.length && pts.every((p) => p.min <= p.avg + 1e-3 && p.avg <= p.max + 1e-3);
    })));
});

describe("разбор запроса ряда (?name=&from=&to=&bucket=)", () => {
  const H = 3600_000;
  it("имя обязательно и из латиницы/цифр/подчёркиваний", () => {
    expect(parseSeriesQuery({}, T0)).toEqual({ ok: false, error: "name: имя метрики обязательно (латиница, цифры, _)" });
    expect(parseSeriesQuery({ name: "http rps" }, T0).ok).toBe(false);
    expect(parseSeriesQuery({ name: "Http_rps" }, T0).ok).toBe(false);
    expect(parseSeriesQuery({ name: "1rps" }, T0).ok).toBe(false);
    expect(parseSeriesQuery({ name: "a".repeat(65) }, T0).ok).toBe(false);
    expect(parseSeriesQuery({ name: "a".repeat(64) }, T0).ok).toBe(true);
    expect(parseSeriesQuery({ name: "x\nhttp_rps" }, T0).ok).toBe(false);
  });
  it("по умолчанию — последние сутки и автоматическое окно", () => {
    expect(parseSeriesQuery({ name: "http_rps" }, T0)).toEqual({ ok: true, name: "http_rps", from: new Date(T0 - 24 * H).toISOString(), to: new Date(T0).toISOString(), bucketSec: autoBucket(24 * H) });
  });
  it("from/to — ISO; неразборчивые или перевёрнутые — отказ", () => {
    expect(parseSeriesQuery({ name: "x", from: "вчера" }, T0)).toEqual({ ok: false, error: "from/to: ждём дату ISO 8601" });
    expect(parseSeriesQuery({ name: "x", to: "nope" }, T0).ok).toBe(false);
    expect(parseSeriesQuery({ name: "x", from: "2026-09-26T11:00:00Z", to: "2026-09-26T10:00:00Z" }, T0)).toEqual({ ok: false, error: "from позже to" });
    const r = parseSeriesQuery({ name: "x", from: "2026-09-26T09:00:00Z", to: "2026-09-26T10:00:00Z", bucket: "60" }, T0);
    expect(r).toEqual({ ok: true, name: "x", from: "2026-09-26T09:00:00.000Z", to: "2026-09-26T10:00:00.000Z", bucketSec: 60 });
  });
  it("from = to — допустимо (одна точка)", () => expect(parseSeriesQuery({ name: "x", from: "2026-09-26T10:00:00Z", to: "2026-09-26T10:00:00Z" }, T0).ok).toBe(true));
  it("интервал не длиннее срока хранения 90 дней", () => {
    expect(parseSeriesQuery({ name: "x", from: new Date(T0 - 90 * 24 * H).toISOString() }, T0).ok).toBe(true);
    expect(parseSeriesQuery({ name: "x", from: new Date(T0 - 90 * 24 * H - 1).toISOString() }, T0)).toEqual({ ok: false, error: "интервал длиннее срока хранения 90 дней" });
  });
  it("окно — целые секунды от 60 до 86 400", () => {
    for (const b of ["59", "86401", "abc", "60.5", ""]) expect(parseSeriesQuery({ name: "x", bucket: b }, T0)).toEqual({ ok: false, error: "bucket: целое число секунд от 60 до 86400" });
    expect(parseSeriesQuery({ name: "x", bucket: "86400" }, T0)).toMatchObject({ ok: true, bucketSec: 86400 });
  });
  it("автоокно: не больше MAX_POINTS точек, кратно минуте, не меньше минуты", () => {
    expect(MAX_POINTS).toBe(360);
    expect(autoBucket(0)).toBe(60);
    expect(autoBucket(H)).toBe(60);
    expect(autoBucket(6 * H)).toBe(60);
    expect(autoBucket(6 * H + 1000)).toBe(120);
    expect(autoBucket(24 * H)).toBe(240);
    expect(autoBucket(90 * 24 * H)).toBe(21600);
    fc.assert(fc.property(fc.integer({ min: 0, max: 90 * 24 * H }), (span) => {
      const b = autoBucket(span);
      return b >= 60 && b % 60 === 0 && span <= MAX_POINTS * b * 1000 && (b === 60 || span > MAX_POINTS * (b - 60) * 1000);
    }));
  });
});
