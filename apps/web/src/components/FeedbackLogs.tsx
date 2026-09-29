import { useState } from "react";
import { api, session } from "../lib/api";
import { canResolveDispute } from "../lib/access";
import { DISPUTE_RU, fmtDate, RESOLUTION_RU, RETRAINING_RU } from "../lib/labels";
import { FindingPill, Loading, Pill, useLoad, useToast } from "./ui";

/**
 * OS-INSP-4.1.6, 4.1.7: журналы отклонений (Rejection_Log) и спорных случаев (Dispute_Log) — по проверке (url проверки)
 * или сводно по всем проверкам в разделе модели (OS-INSP-4.1.27, `showInspection`: колонка с номером проверки).
 * T-234 (ТЗ §10): статус отклонения в дообучении (retraining_status) и исход спора с автором (resolution_status,
 * resolved_by); закрыть спор — супервизор и администратор (OS-INSP-4.1.29).
 */
export function FeedbackLogs({ url, version = "", showInspection = false }: { url: string; version?: string; showInspection?: boolean }) {
  const logs = useLoad(() => api<{ rejections: any[]; disputes: any[] }>(url), [url, version]);
  const { data: dict } = useLoad(() => api(`/api/v1/dictionaries`), []);
  const canResolve = canResolveDispute(session()?.user.role);
  if (!logs.data) return <Loading error={logs.error} />;
  const { rejections, disputes } = logs.data;
  return (
    <>
      <div className="panel" aria-label="Журнал отклонений">
        <div className="panel-head">
          <h2>Журнал отклонений</h2>
          <span className="count">{rejections.length}</span>
          <span className="mute small">Кандидаты, отклонённые инспектором, — с причиной, подсказкой и судьбой в дообучении</span>
        </div>
        {!rejections.length ? (
          <div className="empty">Отклонений нет</div>
        ) : (
          <div className="scroll-x">
            <table className="rows">
              <thead><tr><th>Время</th>{showInspection && <th>Проверка</th>}<th>Код</th><th>Вердикт ИИ</th><th>Причина</th><th>Комментарий инспектора</th><th>Что исправить в модели</th><th>Дообучение</th></tr></thead>
              <tbody>
                {rejections.map((r) => {
                  const st = RETRAINING_RU[r.retraining_status] ?? { ru: r.retraining_status, tone: "gray" };
                  return (
                    <tr key={r.id}>
                      <td className="small mute" style={{ whiteSpace: "nowrap" }}>{fmtDate(r.created_at)}</td>
                      {showInspection && <td className="mono small">{r.inspection_id}</td>}
                      <td className="mono small">{r.param_code}</td>
                      <td><FindingPill status={r.ai_verdict} /></td>
                      <td className="small">{dict?.reason_codes?.[r.reason_code] ?? r.reason_code}<div className="mono mute">{r.reason_code}</div></td>
                      <td className="small" style={{ maxWidth: 280 }}>{r.comment}</td>
                      <td className="small mute" style={{ maxWidth: 320 }}>{r.suggested_fix}</td>
                      <td className="small">
                        <Pill tone={st.tone}>{st.ru}</Pill>
                        {r.retraining_dataset && <div className="mono mute">{r.retraining_dataset}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="panel" aria-label="Журнал спорных случаев">
        <div className="panel-head">
          <h2>Спорные случаи</h2>
          <span className="count">{disputes.length}</span>
          <span className="mute small">Запросы уточнения и несогласие с советником ИИ; исход спора и кто его закрыл</span>
        </div>
        {!disputes.length ? (
          <div className="empty">Спорных случаев нет</div>
        ) : (
          <div className="scroll-x">
            <table className="rows">
              <thead><tr><th>Время</th>{showInspection && <th>Проверка</th>}<th>Код</th><th>Вид</th><th>Позиция ИИ</th><th>Комментарий инспектора</th><th>Исход</th></tr></thead>
              <tbody>
                {disputes.map((r) => (
                  <tr key={r.id}>
                    <td className="small mute" style={{ whiteSpace: "nowrap" }}>{fmtDate(r.created_at)}</td>
                    {showInspection && <td className="mono small">{r.inspection_id}</td>}
                    <td className="mono small">{r.param_code}</td>
                    <td><Pill tone={r.kind === "CLARIFICATION" ? "blue" : "violet"}>{DISPUTE_RU[r.kind] ?? r.kind}</Pill></td>
                    <td className="small" style={{ maxWidth: 360 }}>{r.ai_comment}</td>
                    <td className="small" style={{ maxWidth: 280 }}>{r.inspector_comment || <span className="mute">—</span>}</td>
                    <td className="small" style={{ minWidth: 220 }}>
                      <DisputeOutcome d={r} canResolve={canResolve} onDone={logs.reload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/** Исход спора: закрытый — исход, кто и когда закрыл, комментарий; открытый — форма закрытия для надзора. */
function DisputeOutcome({ d, canResolve, onDone }: { d: any; canResolve: boolean; onDone: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const st = RESOLUTION_RU[d.resolution_status] ?? { ru: d.resolution_status, tone: "gray" };
  if (d.resolution_status !== "OPEN") {
    return (
      <div className="stack" style={{ gap: 2 }}>
        <Pill tone={st.tone}>{st.ru}</Pill>
        <span className="mute">{d.resolved_by_name ?? d.resolved_by} · {fmtDate(d.resolved_at)}</span>
        {d.resolution_comment && <span>{d.resolution_comment}</span>}
      </div>
    );
  }
  if (!canResolve) return <Pill tone={st.tone}>{st.ru}</Pill>;
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/disputes/${d.id}/resolve`, { method: "POST", body: { resolution_status: status, comment } });
      toast("Спор закрыт");
      onDone();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 4 }} aria-label={`Закрыть спор ${d.id}`}>
      <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Исход спора">
        <option value="">Исход спора…</option>
        {(["INSPECTOR_UPHELD", "AI_UPHELD", "WITHDRAWN"] as const).map((k) => <option key={k} value={k}>{RESOLUTION_RU[k].ru}</option>)}
      </select>
      <input className="input" placeholder="Почему (обязательно, кроме снятия)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Комментарий к исходу" />
      <button className="btn" disabled={busy || !status || (status !== "WITHDRAWN" && !comment.trim())} onClick={submit}>Закрыть спор</button>
    </div>
  );
}
