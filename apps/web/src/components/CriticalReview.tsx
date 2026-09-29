// OS-INSP-4.3.5 (T-118): перед завершением — критические параметры, по которым сверка не дала ответа.
// Перечень считает сервер; инспектор отмечает, что просмотрел его, и только тогда открывается окно отмены (T-111).
import { useState } from "react";
import { FindingPill } from "./ui";

export interface CriticalItem {
  param_code: string;
  parameter_name: string | null;
  finding_status: string;
}

export function CriticalReview({ items, onContinue, onCancel }: { items: CriticalItem[]; onContinue: () => void; onCancel: () => void }) {
  const [seen, setSeen] = useState(false);
  return (
    <section className="card" role="dialog" aria-label="Критические параметры без ответа">
      <h3>Критические параметры без ответа: {items.length}</h3>
      <p className="small mute">
        Нарушение по этим параметрам — основание приостановить работы. Сверка не дала по ним ответа: документа нет, значения
        несопоставимы или нужна уточнённая редакция. Проверьте перечень, прежде чем завершать.
      </p>
      <table className="table">
        <tbody>
          {items.map((c) => (
            <tr key={`${c.param_code}-${c.finding_status}`}>
              <td className="mono">{c.param_code}</td>
              <td>{c.parameter_name ?? "—"}</td>
              <td><FindingPill status={c.finding_status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="row">
        <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} /> Перечень просмотрен
      </label>
      <div className="row">
        <button className="btn primary" disabled={!seen} onClick={onContinue}>Продолжить завершение</button>
        <button className="btn" onClick={onCancel}>Вернуться к сверке</button>
      </div>
    </section>
  );
}
