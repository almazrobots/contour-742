// Журнал аудита (OS-INSP-8.2): время, пользователь, действие, объект, IP.
import { useState } from "react";
import { api } from "../lib/api";
import { fmtDate, ROLE_RU } from "../lib/labels";
import { Loading, useLoad } from "../components/ui";

export function Audit() {
  const [action, setAction] = useState("");
  const { data, error } = useLoad(() => api<any[]>(`/api/v1/audit${action ? `?action=${action}` : ""}`), [action]);
  const actions = ["", "LOGIN", "LOGIN_FAILED", "FILES_UPLOADED", "FILES_IMPORTED", "DECISION_CONFIRM", "DECISION_REJECT", "DECISION_CLARIFY", "CANDIDATE_SPLIT", "PROTOCOL_FINALIZED", "FINALIZATION_CANCELLED", "PARAM_UPDATED", "DATASET_RELEASED", "MODEL_PUBLISHED"];
  return (
    <>
      <header className="topbar">
        <div className="crumbs"><b>Журнал аудита</b></div>
        <div className="grow" />
        <select id="a-action" className="input" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Действие">
          {actions.map((a) => <option key={a} value={a}>{a || "Все действия"}</option>)}
        </select>
      </header>
      <div className="page">
        <div className="panel scroll-x">
          {!data ? <Loading error={error} /> : (
            <table className="rows">
              <thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Объект</th><th>Детали</th><th>IP</th></tr></thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtDate(a.timestamp)}</td>
                    <td className="small">{a.user_name ?? "—"}<div className="mute">{ROLE_RU[a.role] ?? ""}</div></td>
                    <td className="mono small">{a.action}</td>
                    <td className="mono small">{a.object_id ?? "—"}</td>
                    <td className="small mute" style={{ maxWidth: 380, overflowWrap: "anywhere" }}>{a.details}</td>
                    <td className="mono small mute">{a.ip_address ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
