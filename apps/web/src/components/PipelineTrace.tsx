import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Mark } from "./Sheet";
import { FileResultHistory } from "./FileResultHistory";

type Run = { id: string; status: string; created_at: string; error: string | null };
type RecordedResult = { sha256: string; parse_status: string; engine: string | null; ml_revision: string | null;
  pipeline_run_id: string | null; trace_status: "untraced" | "pipeline_linked" | "inconsistent" };
type Token = { id: string; text: string; bbox: Mark["bbox"]; disputed: boolean };
type RegionTrace = { source: string; quality: string; agreement: number | null; execution_failures: string[];
  lines: Array<{ id: string; text: string; tokens: Token[] }> };
type Trace = {
  status: string; error: string | null;
  context: { sha256: string; configuration_fingerprint: string; schema_version: string } | null;
  completeness: { publishable: boolean; completed_regions: number; planned_regions: number; reasons: string[] } | null;
  progress: Array<{ at: string; receipt: { stage: string; status: string; reasons: string[]; cached: boolean } }>;
  page: RegionTrace | null;
  regions?: RegionTrace[];
  reader_observations?: Array<{ region_id: string; text: string; status: string }>;
  word_bindings?: Array<{ id: string; word: { text: string; bbox: Mark["bbox"]; disputed: boolean };
    sources: Array<{ source: "native" | "ocr" }> }>;
};
const labels: Record<string, string> = { preflight: "План документа", parse: "Разбор области", merge: "Сборка страниц", extract: "Извлечение значений", aggregate: "Проверка полноты" };
const statuses: Record<string, string> = { PENDING: "Ожидает", RUNNING: "Обрабатывается", COMPLETE: "Завершён", FAILED: "Не завершён" };

/** Lazy, authenticated, one page at a time. Existing card payload stays small. */
export function PipelineTracePanel({ fileId, page, onMark }: { fileId: string; page: number; onMark: (mark: Mark | null) => void }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [recorded, setRecorded] = useState<RecordedResult | null>(null);
  const [selected, setSelected] = useState("");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(""); setRecorded(null);
    api<{ runs: Run[]; recorded_result?: RecordedResult }>(`/api/v1/files/${encodeURIComponent(fileId)}/runs?limit=20`).then(({ runs, recorded_result }) => {
      if (!active) return;
      setRuns(runs); setRecorded(recorded_result ?? null);
      const published = recorded_result?.trace_status === "pipeline_linked" ? recorded_result.pipeline_run_id : null;
      setSelected((old) => runs.some((r) => r.id === old) ? old : runs.find((r) => r.id === published)?.id ?? runs[0]?.id ?? "");
    }).catch((e) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [fileId, open, refresh]);
  useEffect(() => {
    setTrace(null);
    if (!open || !selected) return;
    let active = true;
    setError("");
    api<Trace>(`/api/v1/files/${encodeURIComponent(fileId)}/runs/${encodeURIComponent(selected)}/trace?page=${page}`)
      .then((value) => { if (active) setTrace(value); })
      .catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [fileId, selected, page, open, refresh]);
  const regions = trace?.regions ?? (trace?.page ? [trace.page] : []);
  const lines = regions.flatMap((region) => region.lines);
  const failures = [...new Set(regions.flatMap((region) => region.execution_failures))];
  const native = trace?.word_bindings?.filter((word) => word.sources.some((source) => source.source === "native")) ?? [];
  return <section aria-label="Трасса обработки">
    <button className="btn small-btn" aria-expanded={open} onClick={() => { setOpen(!open); onMark(null); }}>Трасса обработки</button>
    {open && <div className="stack" style={{ gap: 8, marginTop: 8 }}>
      <FileResultHistory key={fileId} fileId={fileId} />
      <button className="btn small-btn" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>Обновить трассу</button>
      {error && <p role="alert">{error}</p>}
      {loading ? <p>Загрузка запусков…</p> : !runs.length && !error ? <p>Для этого файла трасса ещё не записана.</p> : null}
      {!loading && recorded?.trace_status === "untraced" && <div>
        <p>Подробная трасса стадий для этого файла не сохранена.</p>
        <dl className="kv" style={{ overflowWrap: "anywhere" }}>
          <dt>SHA-256 файла</dt><dd>{recorded.sha256}</dd>
          <dt>Сохранённая версия обработки</dt><dd>{recorded.ml_revision || "Неизвестна"}</dd>
          <dt>Сохранённый движок</dt><dd>{recorded.engine || "Неизвестен"}</dd>
        </dl>
      </div>}
      {!loading && recorded?.trace_status === "inconsistent" && <p role="alert">Сохранённый результат ссылается на запуск другого источника или отсутствующий запуск. Связь требует проверки.</p>}
      {!loading && recorded?.trace_status === "pipeline_linked" && selected && selected !== recorded.pipeline_run_id &&
        <p>Показан другой запуск. Сохранённый результат файла связан с запуском {recorded.pipeline_run_id}.</p>}
      {!!runs.length && <label>Запуск <select aria-label="Запуск обработки" value={selected} onChange={(e) => { setSelected(e.target.value); onMark(null); }}>
        {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString("ru")} · {statuses[r.status] ?? r.status}</option>)}
      </select></label>}
      {trace && <>
        <p>{statuses[trace.status] ?? trace.status}{trace.completeness && ` · области ${trace.completeness.completed_regions}/${trace.completeness.planned_regions}`}</p>
        {trace.error && <p role="alert">{trace.error}</p>}
        {!!trace.completeness?.reasons.length && <p>Не завершено: {trace.completeness.reasons.join(", ")}</p>}
        <ol aria-label="Стадии обработки">{trace.progress.map((p, i) => <li key={i}>
          {labels[p.receipt.stage] ?? p.receipt.stage}: {p.receipt.status === "complete" ? "выполнено" : "не завершено"}{p.receipt.cached && " (из кэша)"}
        </li>)}</ol>
        {trace.context && <details><summary>Версии и источник</summary><dl className="kv" style={{ overflowWrap: "anywhere" }}>
          <dt>Запуск</dt><dd>{selected}</dd><dt>SHA-256 файла</dt><dd>{trace.context.sha256}</dd>
          <dt>Настройки</dt><dd>{trace.context.configuration_fingerprint}</dd><dt>Схема</dt><dd>{trace.context.schema_version}</dd>
        </dl></details>}
        {trace.page ? <>
          <p>Страница {page}{regions.length > 1 ? " · первая область" : ""} · {trace.page.source} · {trace.page.quality}. Согласие OCR: {trace.page.agreement == null ? "не измерялось" : `${Math.round(trace.page.agreement * 100)}%`}.</p>
          {regions.length > 1 && <p>На странице {regions.length} областей. Качество областей: {[...new Set(regions.map((r) => r.quality))].join(", ")}.</p>}
          {!!failures.length && <p>Пропуски: {failures.join(", ")}</p>}
          <p className="small mute">Нажмите слово, чтобы увидеть его область на листе. Выполненный проход не гарантирует, что найден весь текст.</p>
          <div aria-label="Транскрипция страницы">{lines.slice(0, 300).map((line) => <p key={line.id}>
            {line.tokens.map((token) => <button className="btn small-btn" key={token.id} disabled={!token.bbox}
              title={token.disputed ? "Движки OCR разошлись" : "Показать на листе"}
              onClick={() => onMark({ bbox: token.bbox, kind: "anchor", label: token.text })}>{token.text}</button>)}
          </p>)}</div>
          {lines.length > 300 && <p>Показаны первые 300 из {lines.length} строк.</p>}
          {!!trace.reader_observations?.length && <details><summary>Чтения без подтверждённой позиции · {trace.reader_observations.length}</summary>
            <p>Эти чтения не использованы как факты: место текста на листе не подтверждено. Сверьте их с оригиналом.</p>
            {trace.reader_observations.slice(0, 100).map((entry, index) => <p key={`${entry.region_id}-${index}`}>{entry.text}</p>)}
            {trace.reader_observations.length > 100 && <p>Показаны первые 100 чтений.</p>}
          </details>}
          {!!native.length && <details><summary>Текстовый слой PDF · {native.length} слов</summary>
            {native.slice(0, 1000).map((entry) => <button className="btn small-btn" key={entry.id} disabled={!entry.word.bbox}
              title={entry.word.disputed ? "Чтения источников разошлись" : "Показать текстовый слой на листе"}
              onClick={() => onMark({ bbox: entry.word.bbox, kind: "anchor", label: entry.word.text })}>{entry.word.text}</button>)}
            {native.length > 1000 && <p>Показаны первые 1000 слов.</p>}
          </details>}
        </> : <p>Транскрипция этой страницы пока недоступна.</p>}
      </>}
    </div>}
  </section>;
}
