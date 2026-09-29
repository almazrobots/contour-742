// Мониторинг (NFR-METRICS-STORE, ТЗ §10 п. 13, §13.4): снимки метрик из monitoring_metrics — администратору.
// Плитки последних значений и ряд выбранной метрики по окнам: линия среднего, полоса min–max. SVG без библиотек.
import { useState } from "react";
import { api } from "../lib/api";
import { fmtDate } from "../lib/labels";
import { Loading, useLoad } from "../components/ui";

type Catalog = Array<{ metric_name: string; last_at: string; last_value: number | null; service_name: string }>;
type Point = { t: string; avg: number; min: number; max: number; count: number };
type SeriesResp = { name: string; from: string; to: string; bucket_sec: number; truncated: boolean; series: Array<{ tags: Record<string, string>; points: Point[] }> };

export const METRIC_RU: Record<string, { ru: string; unit: string }> = {
  http_rps: { ru: "Запросов в секунду", unit: "rps" },
  http_requests: { ru: "Запросов за минуту", unit: "" },
  http_errors_5xx: { ru: "Ошибок 5xx за минуту", unit: "" },
  http_latency_ms_avg: { ru: "Среднее время ответа", unit: "мс" },
  http_latency_ms_p95: { ru: "Время ответа p95", unit: "мс" },
  http_route_requests: { ru: "Запросы по маршрутам", unit: "" },
  process_cpu_percent: { ru: "CPU процесса", unit: "%" },
  process_rss_bytes: { ru: "Память процесса (RSS)", unit: "Б" },
  process_heap_used_bytes: { ru: "Куча V8", unit: "Б" },
  disk_free_bytes: { ru: "Свободно на диске", unit: "Б" },
  disk_used_percent: { ru: "Диск занят", unit: "%" },
  queue_size: { ru: "Очередь разбора", unit: "" },
  active_sessions: { ru: "Активные сессии", unit: "" },
};
const TILES = ["http_rps", "http_latency_ms_p95", "http_errors_5xx", "process_cpu_percent", "process_rss_bytes", "disk_used_percent", "queue_size", "active_sessions"];
const RANGES = [{ h: 1, ru: "Час" }, { h: 24, ru: "Сутки" }, { h: 24 * 7, ru: "Неделя" }, { h: 24 * 90, ru: "90 дней" }];

export function fmtValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined) return "—";
  if (unit === "Б") {
    const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < u.length - 1) (x /= 1024), i++;
    return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : String(Math.round(v * 100) / 100);
  return unit ? `${s} ${unit}` : s;
}

/** Спарклайн: линия среднего и полоса min–max по окнам. */
export function Sparkline({ points, width = 640, height = 120 }: { points: Point[]; width?: number; height?: number }) {
  if (!points.length) return <div className="empty">Нет снимков за интервал</div>;
  const t0 = Date.parse(points[0].t);
  const t1 = Date.parse(points[points.length - 1].t);
  const lo = Math.min(...points.map((p) => p.min));
  const hi = Math.max(...points.map((p) => p.max));
  const pad = 4;
  const x = (t: string) => (t1 === t0 ? width / 2 : pad + ((Date.parse(t) - t0) / (t1 - t0)) * (width - 2 * pad));
  const y = (v: number) => (hi === lo ? height / 2 : height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad));
  const band = [...points.map((p) => `${x(p.t)},${y(p.max)}`), ...[...points].reverse().map((p) => `${x(p.t)},${y(p.min)}`)].join(" ");
  const line = points.map((p) => `${x(p.t)},${y(p.avg)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={`Ряд: ${points.length} точек`}>
      <polygon points={band} fill="var(--accent-soft)" />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {points.length === 1 && <circle cx={x(points[0].t)} cy={y(points[0].avg)} r={3} fill="var(--accent)" />}
    </svg>
  );
}

export function Monitoring() {
  const [name, setName] = useState("http_rps");
  const [hours, setHours] = useState(24);
  const cat = useLoad(() => api<Catalog>("/api/v1/monitoring/metric-names"), []);
  const ser = useLoad(() => {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600_000);
    return api<SeriesResp>(`/api/v1/monitoring/metrics?name=${encodeURIComponent(name)}&from=${from.toISOString()}&to=${to.toISOString()}`);
  }, [name, hours]);
  const last = Object.fromEntries((cat.data ?? []).map((m) => [m.metric_name, m]));
  const meta = (n: string) => METRIC_RU[n] ?? { ru: n, unit: "" };
  const names = [...new Set([...TILES, ...(cat.data ?? []).map((m) => m.metric_name)])];
  return (
    <>
      <header className="topbar">
        <div className="crumbs"><b>Мониторинг</b><span className="mute">снимок раз в минуту · хранение 90 дней</span></div>
        <div className="grow" />
        <select id="m-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Метрика">
          {names.map((n) => <option key={n} value={n}>{meta(n).ru}</option>)}
        </select>
        <select id="m-range" className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Интервал">
          {RANGES.map((r) => <option key={r.h} value={r.h}>{r.ru}</option>)}
        </select>
      </header>
      <div className="page">
        {!cat.data ? <Loading error={cat.error} /> : (
          <div className="kpis">
            {TILES.map((n) => (
              <button key={n} type="button" className="kpi" onClick={() => setName(n)} aria-pressed={n === name} style={{ textAlign: "left", cursor: "pointer", font: "inherit", ...(n === name ? { borderColor: "var(--accent)" } : {}) }}>
                <span className="label">{meta(n).ru}</span>
                <b>{fmtValue(last[n]?.last_value, meta(n).unit)}</b>
                <span className="small mute">{last[n] ? fmtDate(last[n].last_at) : "нет снимков"}</span>
              </button>
            ))}
          </div>
        )}
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <b>{meta(name).ru}</b>
            <span className="mono small mute">{name}</span>
            <div className="grow" />
            {ser.data && <span className="small mute">окно {Math.round(ser.data.bucket_sec / 60)} мин{ser.data.truncated ? " · показана часть: сузьте интервал" : ""}</span>}
          </div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
            {!ser.data ? <Loading error={ser.error} /> : !ser.data.series.length ? <div className="empty">Нет снимков за интервал</div> : ser.data.series.map((s) => {
              const pts = s.points;
              const route = s.tags.route;
              return (
                <div key={JSON.stringify(s.tags)}>
                  <div className="small" style={{ display: "flex", gap: 12, marginBottom: 6 }}>
                    {route && <span className="mono">{route}</span>}
                    <span className="mute">мин {fmtValue(Math.min(...pts.map((p) => p.min)), meta(name).unit)}</span>
                    <span className="mute">макс {fmtValue(Math.max(...pts.map((p) => p.max)), meta(name).unit)}</span>
                    <span>последнее {fmtValue(pts[pts.length - 1].avg, meta(name).unit)}</span>
                  </div>
                  <Sparkline points={pts} />
                  <div className="small mute" style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{fmtDate(pts[0].t)}</span>
                    <span>{fmtDate(pts[pts.length - 1].t)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
