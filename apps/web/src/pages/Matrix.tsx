// Матрица контроля (OS-INSP-7.1): 132 параметра; администратор меняет пороги и активность без перекодирования.
// Код параметра — кнопка: открывает паспорт параметра рядом с таблицей (DLG-INSP-22, OS-INSP-7.1.3–7.1.6);
// выбранный код живёт в адресе (#/matrix?code=M-023), поэтому паспорт открывается и по ссылке.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, session } from "../lib/api";
import { Loading, Pill, Priority, useLoad, useToast } from "../components/ui";
import { ParamPassport } from "../components/ParamPassport";

const KIND_RU: Record<string, string> = { equal: "совпадение", delta_pct: "дельта, %", decrease: "не ниже эталона", increase: "не выше эталона", min: "не меньше порога", max: "не больше порога" };

export function Matrix() {
  const toast = useToast();
  const admin = session()?.user.role === "admin";
  const { data, error, reload } = useLoad(() => api<any[]>("/api/v1/params"), []);
  const [q, setQ] = useState("");
  const [section, setSection] = useState("");
  const [edit, setEdit] = useState<any>(null);
  const [params, setParams] = useSearchParams();
  const code = params.get("code");
  const openCode = (c: string | null) => setParams(c ? { code: c } : {});
  // закрыть паспорт и вернуть фокус на кнопку кода
  const closePassport = () => {
    if (code) document.querySelector<HTMLButtonElement>(`button[data-code="${CSS.escape(code)}"]`)?.focus();
    setParams({});
  };
  // Esc закрывает паспорт — только по явному нажатию
  useEffect(() => {
    if (!code) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      closePassport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [code, setParams]);
  if (!data) return <Loading error={error} />;
  const sections = [...new Set(data.map((p) => p.section))];
  const rows = data.filter((p) => (!section || p.section === section) && `${p.code} ${p.parameter_name}`.toLowerCase().includes(q.toLowerCase()));

  async function save() {
    const cmp = edit.compare;
    // T-234: ссылки СП, ГОСТ и ФЗ (ТЗ §10 Params) уходят все три — PATCH не теряет ни одну
    const body: any = { review_priority: edit.review_priority, is_active: edit.is_active, sp_reference: edit.sp_reference || null, gost_reference: edit.gost_reference || null, fz_reference: edit.fz_reference || null, trigger_logic: edit.trigger_logic };
    if (cmp.kind === "min") body.min_value = Number(edit.threshold);
    else if (cmp.kind === "max") body.max_value = Number(edit.threshold);
    else body.compare = cmp.kind === "delta_pct" ? { kind: "delta_pct", tolerance: Number(edit.threshold) } : { kind: cmp.kind };
    try {
      const r = await api(`/api/v1/params/${edit.code}`, { method: "PATCH", body });
      toast(`Сохранено. Версия Матрицы ${r.matrix_version}`);
      setEdit(null);
      reload();
    } catch (e: any) {
      toast(e.message, true);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="crumbs"><b>Матрица контроля</b><span>·</span><span>{data.length} параметров</span></div>
        <div className="grow" />
        {!admin && <span className="small mute">Изменение порогов доступно администратору</span>}
      </header>
      <div className="page">
        <div className={`matrix-split${code ? " open" : ""}`}>
        <div className="panel">
          <div className="panel-head" style={{ flexWrap: "wrap" }}>
            <input id="m-q" className="input" style={{ flex: "1 1 240px" }} placeholder="Код или название параметра" value={q} onChange={(e) => setQ(e.target.value)} />
            <select id="m-section" className="input" value={section} onChange={(e) => setSection(e.target.value)} aria-label="Раздел">
              <option value="">Все разделы</option>
              {sections.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="scroll-x">
            <table className="rows">
              <thead>
                <tr><th>Код</th><th>Раздел</th><th>Параметр</th><th>Ед.</th><th>Правило</th><th className="col-trig">Триггер (по ТЗ)</th><th>Приоритет</th><th>Активен</th>{admin && <th />}</tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const cmp = JSON.parse(p.compare_json);
                  const thr = cmp.kind === "min" ? cmp.min : cmp.kind === "max" ? cmp.max : cmp.kind === "delta_pct" ? cmp.tolerance : "";
                  const editing = edit?.code === p.code;
                  return (
                    <tr key={p.code} className={code === p.code ? "sel" : undefined}>
                      <td>
                        <button
                          type="button"
                          className="code-btn mono"
                          data-code={p.code}
                          aria-expanded={code === p.code}
                          aria-controls={code === p.code ? "param-passport" : undefined}
                          title="Открыть паспорт параметра"
                          onClick={() => openCode(code === p.code ? null : p.code)}
                        >
                          {p.code}
                        </button>
                      </td>
                      <td className="small">{p.section}</td>
                      <td style={{ maxWidth: 300 }}>{p.parameter_name}</td>
                      <td className="small">{p.unit}</td>
                      <td className="small">
                        {editing ? (
                          <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                            <select id={`kind-${p.code}`} className="input" value={edit.compare.kind} onChange={(e) => setEdit({ ...edit, compare: { kind: e.target.value } })}>
                              {Object.entries(KIND_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                            {["min", "max", "delta_pct"].includes(edit.compare.kind) && (
                              <input id={`thr-${p.code}`} className="input num" style={{ width: 70 }} value={edit.threshold} onChange={(e) => setEdit({ ...edit, threshold: e.target.value })} />
                            )}
                          </div>
                        ) : (
                          <>{KIND_RU[cmp.kind]} {thr !== "" && <b className="num">{thr}</b>}</>
                        )}
                      </td>
                      <td className="small mute col-trig" style={{ maxWidth: 320 }}>{p.trigger_logic}</td>
                      <td>
                        {editing ? (
                          <select id={`prio-${p.code}`} className="input" value={edit.review_priority} onChange={(e) => setEdit({ ...edit, review_priority: e.target.value })}>
                            <option value="HIGH">Высокий</option><option value="MEDIUM">Средний</option><option value="LOW">Низкий</option>
                          </select>
                        ) : (
                          <Priority p={p.review_priority} />
                        )}
                      </td>
                      <td>
                        {editing ? (
                          <input id={`act-${p.code}`} type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />
                        ) : p.is_active ? <Pill tone="green">да</Pill> : <Pill tone="gray">нет</Pill>}
                      </td>
                      {admin && (
                        <td style={{ whiteSpace: "nowrap" }}>
                          {editing ? (
                            <>
                              <button className="btn primary" onClick={save}>Сохранить</button>{" "}
                              <button className="btn ghost" onClick={() => setEdit(null)}>Отмена</button>
                            </>
                          ) : (
                            <button className="btn" onClick={() => setEdit({ ...p, compare: cmp, threshold: thr, is_active: Boolean(p.is_active) })}>Изменить</button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        {code && <ParamPassport key={code} code={code} row={data.find((p) => p.code === code)} kindRu={KIND_RU} onClose={closePassport} />}
        </div>
      </div>
    </>
  );
}
