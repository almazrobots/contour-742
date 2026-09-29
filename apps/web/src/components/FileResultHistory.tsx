import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Snapshot = { id: string; sha256: string; source_run_id: string | null; ml_revision: string | null;
  engine: string | null; captured_at: string; payload_sha256: string; extractions: number };
type Extraction = { id: number; param_code: string; raw: string | null; value_text: string | null;
  value_num: number | null; page: number | null };
const RESULT_PAGE = 25;
const HISTORY_PAGE = 20;

/** Historical captures are artifacts, not reconstructed processing runs. */
export function FileResultHistory({ fileId }: { fileId: string }) {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Extraction[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [resultError, setResultError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resultLoading, setResultLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setHistoryError(""); setSnapshots([]); setSelected(null); setOffset(0);
    api<{ snapshots: Snapshot[] }>(`/api/v1/files/${encodeURIComponent(fileId)}/result-snapshots?limit=${HISTORY_PAGE}&offset=${historyOffset}`)
      .then(({ snapshots }) => { if (active) { setSnapshots(snapshots); setSelected(snapshots[0] ?? null); } })
      .catch((e) => { if (active) setHistoryError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [fileId, open, historyOffset]);
  useEffect(() => {
    setRows([]); setResultError("");
    if (!open || !selected) return;
    let active = true;
    setResultLoading(true);
    api<{ extractions: Extraction[] }>(`/api/v1/files/${encodeURIComponent(fileId)}/result-snapshots/${encodeURIComponent(selected.id)}/extractions?limit=${RESULT_PAGE}&offset=${offset}`)
      .then(({ extractions }) => { if (active) setRows(extractions); })
      .catch((e) => { if (active) setResultError(e.message); })
      .finally(() => { if (active) setResultLoading(false); });
    return () => { active = false; };
  }, [fileId, open, selected, offset]);
  return <section aria-label="Сохранённые результаты">
    <button className="btn small-btn" aria-expanded={open} onClick={() => setOpen(!open)}>Сохранённые результаты</button>
    {open && <div className="stack" style={{ gap: 8 }}>
      <p>Снимки сохраняют прежний результат перед его заменой. Дата сохранения снимка не является датой обработки документа.</p>
      {historyError && <p role="alert">{historyError}</p>}
      {loading ? <p>Загрузка снимков…</p> : !snapshots.length && !historyError ? <p>На этой странице сохранённых снимков нет.</p> : null}
      <div>
        <button className="btn small-btn" disabled={loading || historyOffset === 0} onClick={() => setHistoryOffset(historyOffset - HISTORY_PAGE)}>Предыдущие снимки</button>
        <button className="btn small-btn" disabled={loading || snapshots.length < HISTORY_PAGE} onClick={() => setHistoryOffset(historyOffset + HISTORY_PAGE)}>Следующие снимки</button>
      </div>
      {!!snapshots.length && <label>Снимок <select value={selected?.id ?? ""} onChange={(e) => {
        setSelected(snapshots.find((s) => s.id === e.target.value) ?? null); setOffset(0);
      }}>
        {snapshots.map((s) => <option key={s.id} value={s.id}>{new Date(s.captured_at).toLocaleString("ru")} · {s.ml_revision || "Версия неизвестна"} · {s.extractions} извлечений</option>)}
      </select></label>}
      {selected && <>
        <dl className="kv" style={{ overflowWrap: "anywhere" }}>
          <dt>Снимок сохранён</dt><dd>{new Date(selected.captured_at).toLocaleString("ru")}</dd>
          <dt>Версия обработки</dt><dd>{selected.ml_revision || "Неизвестна"}</dd>
          <dt>Движок</dt><dd>{selected.engine || "Неизвестен"}</dd>
          <dt>Запуск обработки</dt><dd>{selected.source_run_id || "Не записан"}</dd>
          <dt>SHA-256 источника</dt><dd>{selected.sha256}</dd>
          <dt>SHA-256 снимка</dt><dd>{selected.payload_sha256}</dd>
        </dl>
        {resultError && <p role="alert">{resultError}</p>}
        {resultLoading ? <p>Загрузка извлечений…</p> : <>
          <p>Извлечений в снимке: {selected.extractions}. Показано: {rows.length}.</p>
          <table><thead><tr><th>Параметр</th><th>Страница</th><th>Значение</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{r.param_code}</td><td>{r.page ?? "Не записана"}</td>
              <td style={{ overflowWrap: "anywhere" }}>{r.raw ?? r.value_text ?? r.value_num ?? "Не записано"}</td></tr>)}</tbody>
          </table>
        </>}
        <div>
          <button className="btn small-btn" disabled={resultLoading || offset === 0} onClick={() => setOffset(offset - RESULT_PAGE)}>Предыдущие извлечения</button>
          <button className="btn small-btn" disabled={resultLoading || offset + RESULT_PAGE >= selected.extractions} onClick={() => setOffset(offset + RESULT_PAGE)}>Следующие извлечения</button>
        </div>
      </>}
    </div>}
  </section>;
}
