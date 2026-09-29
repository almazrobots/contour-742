// Нормативная база и логические правила (OS-INSP-7.2, 7.3). Удаления нет — только деактивация.
import { useState } from "react";
import { api, session } from "../lib/api";
import { fmtDay } from "../lib/labels";
import { Loading, Pill, useLoad, useToast } from "../components/ui";

export function Normative() {
  const toast = useToast();
  const admin = session()?.user.role === "admin";
  const norms = useLoad(() => api<any[]>("/api/v1/normative"), []);
  const rules = useLoad(() => api<any[]>("/api/v1/rules"), []);
  // OS-INSP-7.2.2: перечень нормативных правовых актов ТЗ §2 (только чтение)
  const acts = useLoad(() => api<any[]>("/api/v1/legal-acts"), []);
  const [n, setN] = useState({ document_name: "", document_number: "", section: "", param_code: "", min_value: "", max_value: "" });
  const [edit, setEdit] = useState<{ id: number; min_value: string; max_value: string; effective_from: string; effective_to: string } | null>(null);

  const act = async (fn: () => Promise<any>, ok: string, reload: () => void) => {
    try {
      await fn();
      toast(ok);
      reload();
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  return (
    <>
      <header className="topbar"><div className="crumbs"><b>Нормативная база и правила</b></div></header>
      <div className="page">
        <div className="panel">
          <div className="panel-head"><h2>Нормативные документы</h2><span className="mute small">Единственный источник норм: пределы и сроки действия для сравнения по паспортам и нормативного анализа гипотез</span></div>
          {!norms.data ? <Loading error={norms.error} /> : (
            <div className="scroll-x">
              <table className="rows">
                <thead><tr><th>Документ</th><th>Пункт</th><th>Параметр</th><th>Мин.</th><th>Макс.</th><th>Действует</th><th>Статус</th>{admin && <th />}</tr></thead>
                <tbody>
                  {norms.data.map((x) =>
                    edit?.id === x.id ? (
                      // T-234 (OS-INSP-7.2.4): правка предела и срока действия — расчёт берёт норму из этой таблицы
                      <tr key={x.id} aria-label={`Правка нормы ${x.document_number}`}>
                        <td><b className="mono small">{x.document_number}</b><div className="small mute">{x.document_name}</div></td>
                        <td className="small">{x.section}</td>
                        <td className="small">{x.parameter_name}</td>
                        <td><input className="input" id="ne-min" style={{ width: 70 }} value={edit!.min_value} onChange={(e) => setEdit((cur) => (cur ? { ...cur, min_value: e.target.value } : cur))} /></td>
                        <td><input className="input" id="ne-max" style={{ width: 70 }} value={edit!.max_value} onChange={(e) => setEdit((cur) => (cur ? { ...cur, max_value: e.target.value } : cur))} /></td>
                        <td className="small">
                          <input className="input" id="ne-from" type="date" value={edit!.effective_from} onChange={(e) => setEdit((cur) => (cur ? { ...cur, effective_from: e.target.value } : cur))} />
                          <input className="input" id="ne-to" type="date" value={edit!.effective_to} onChange={(e) => setEdit((cur) => (cur ? { ...cur, effective_to: e.target.value } : cur))} />
                        </td>
                        <td>{x.unit && <span className="small mute">{x.unit}</span>}</td>
                        <td>
                          <button
                            className="btn primary"
                            onClick={() =>
                              act(async () => {
                                const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
                                const r = await api(`/api/v1/normative/${x.id}`, { method: "PATCH", body: { min_value: num(edit!.min_value), max_value: num(edit!.max_value), effective_from: edit!.effective_from || null, effective_to: edit!.effective_to || null } });
                                setEdit(null);
                                return r;
                              }, "Норма сохранена, зависящие проверки пересчитаны", norms.reload)
                            }
                          >
                            Сохранить
                          </button>
                          <button className="btn" onClick={() => setEdit(null)}>Отмена</button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={x.id}>
                        <td><b className="mono small">{x.document_number}</b><div className="small mute">{x.document_name}</div>{x.norm_key && <div className="mono small mute" title={x.rule ?? ""}>{x.norm_key}</div>}</td>
                        <td className="small">{x.section}</td>
                        <td className="small">{x.param_code ? <span className="mono">{x.param_code}</span> : "—"} {x.parameter_name}</td>
                        <td className="num">{x.min_value ?? "—"}{x.unit ? ` ${x.unit}` : ""}</td>
                        <td className="num">{x.max_value ?? "—"}{x.unit && x.max_value != null ? ` ${x.unit}` : ""}</td>
                        <td className="small mute">{x.effective_from ?? "—"} — {x.effective_to ?? "н. в."}</td>
                        <td>{x.is_active ? <Pill tone="green">действует</Pill> : <Pill tone="gray">выключен</Pill>}{x.unverified && <div className="small mute">число не подтверждено</div>}</td>
                        {admin && (
                          <td>
                            <button className="btn" onClick={() => setEdit({ id: x.id, min_value: x.min_value == null ? "" : String(x.min_value), max_value: x.max_value == null ? "" : String(x.max_value), effective_from: x.effective_from ?? "", effective_to: x.effective_to ?? "" })}>
                              Изменить
                            </button>
                            <button className="btn" onClick={() => act(() => api(`/api/v1/normative/${x.id}`, { method: "PATCH", body: x.is_active ? { is_active: false, effective_to: new Date().toISOString().slice(0, 10) } : { is_active: true, effective_to: null } }), "Сохранено", norms.reload)}>
                              {x.is_active ? "Деактивировать" : "Включить"}
                            </button>
                          </td>
                        )}
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {admin && (
            <div className="panel-body row" style={{ borderTop: "1px solid var(--line)" }}>
              {(["document_number", "document_name", "section", "param_code", "min_value", "max_value"] as const).map((k) => (
                <input key={k} id={`n-${k}`} className="input" style={{ flex: k === "document_name" ? "2 1 200px" : "1 1 100px" }} placeholder={{ document_number: "СП 1.13130.2020", document_name: "Наименование", section: "п. 4.2.5", param_code: "M-041", min_value: "мин.", max_value: "макс." }[k]} value={n[k]} onChange={(e) => setN({ ...n, [k]: e.target.value })} />
              ))}
              <button
                className="btn primary"
                disabled={!n.document_number || !n.document_name}
                onClick={() =>
                  act(
                    () => api("/api/v1/normative", { body: { ...n, param_code: n.param_code || null, min_value: n.min_value ? Number(n.min_value) : null, max_value: n.max_value ? Number(n.max_value) : null } }),
                    "Норматив добавлен",
                    () => (norms.reload(), setN({ document_name: "", document_number: "", section: "", param_code: "", min_value: "", max_value: "" })),
                  )
                }
              >
                Добавить
              </button>
            </div>
          )}
        </div>

        <div className="panel" aria-label="Нормативные правовые акты">
          <div className="panel-head">
            <h2>Нормативные правовые акты</h2>
            {acts.data && <span className="count">{acts.data.length}</span>}
            <span className="mute small">Перечень ТЗ §2 с действующими редакциями — основания проверки</span>
          </div>
          {!acts.data ? <Loading error={acts.error} /> : !acts.data.length ? <div className="empty">Перечень актов не загружен</div> : (
            <div className="scroll-x">
              <table className="rows" id="legal-acts">
                <thead><tr><th>№</th><th>Вид</th><th>Наименование</th><th>Реквизиты</th><th>Редакция</th><th>Примечание</th></tr></thead>
                <tbody>
                  {acts.data.map((a) => (
                    <tr key={a.n}>
                      <td className="num mute">{a.n}</td>
                      <td className="small">{a.kind}</td>
                      <td style={{ maxWidth: 460 }}><b className="small">{a.short}</b><div className="small">{a.title}</div></td>
                      <td className="small" style={{ whiteSpace: "nowrap" }}><span className="mono">{a.number}</span>{a.date && <div className="mute">от {fmtDay(a.date)}</div>}</td>
                      <td className="small">{a.edition ?? "—"}</td>
                      <td className="small mute" style={{ maxWidth: 280 }}>{a.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Логические правила свободного поиска</h2><span className="mute small">«Если A, то должно быть B» → гипотеза SUSPICION</span></div>
          {!rules.data ? <Loading error={rules.error} /> : (
            <table className="rows">
              <thead><tr><th>Правило</th><th>Если</th><th>То</th><th>Основание</th><th>Статус</th>{admin && <th />}</tr></thead>
              <tbody>
                {rules.data.map((r) => {
                  const c = JSON.parse(r.condition_json);
                  const x = JSON.parse(r.expected_json);
                  return (
                    <tr key={r.id}>
                      <td>{r.rule_name}</td>
                      <td className="mono small">{c.key} {c.op} {c.value}</td>
                      <td className="mono small">{x.key} {x.op} {x.value}</td>
                      <td className="small">{r.normative_base}</td>
                      <td>{r.is_active ? <Pill tone="green">включено</Pill> : <Pill tone="gray">выключено</Pill>}</td>
                      {admin && (
                        <td><button className="btn" onClick={() => act(() => api(`/api/v1/rules/${r.id}`, { method: "PATCH", body: { is_active: !r.is_active } }), "Сохранено", rules.reload)}>{r.is_active ? "Выключить" : "Включить"}</button></td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
