// Дашборд инспектора (OS-INSP-8.1): объекты сгруппированы по цвету, фильтры по разделам, статусам и датам.
// «Мне сейчас» (T-112, SC-01): из строки с нерешёнными кандидатами — сразу в конвейер; J/K — строки, Enter — в работу, O — карточка.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, session } from "../lib/api";
import { canWork } from "../lib/access";
import { COLOR_RU, fmtDate, PROCESS } from "../lib/labels";
import { Icon, Loading, ProcessPill, SyncPill, useLoad } from "../components/ui";

const SECTIONS = ["ПЗ", "СПЗУ", "АР", "КР", "ИОС1", "ИОС2", "ИОС3", "ИОС4", "ИОС5", "ПОС", "ПОД", "ООС", "ППМ", "ОДИ", "ЗУ", "СМ"];
const ORDER = ["red", "yellow", "green", "gray"] as const;

export function Inspections() {
  const nav = useNavigate();
  const [f, setF] = useState({ q: "", status: "", section: "", from: "", to: "" });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error } = useLoad(() => api<any[]>(`/api/v1/inspections${qs ? `?${qs}` : ""}`), [qs]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState(-1);
  const all = data ?? [];
  // порядок строк на экране — как в группах по цвету; по нему ходят J/K
  const visibleRows = ORDER.flatMap((c) => (closed[c] ? [] : all.filter((r) => r.color === c)));
  const workable = (r: any) => (r.status === "READY" || r.status === "VERIFYING") && r.counts?.candidates > 0;
  const open = (r: any, work: boolean) => nav(work && workable(r) ? `/inspections/${r.process_id}/verify` : `/inspections/${r.process_id}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "KeyJ" || e.code === "ArrowDown") setSel((i) => Math.min(i + 1, visibleRows.length - 1));
      else if (e.code === "KeyK" || e.code === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
      else if (e.code === "Enter" && visibleRows[sel]) open(visibleRows[sel], true);
      else if (e.code === "KeyO" && visibleRows[sel]) open(visibleRows[sel], false);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const sum = (k: string) => all.reduce((a, r) => a + (r.counts?.[k] ?? 0), 0);

  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <b>Проверки</b>
          <span>·</span>
          <span>{all.length} объектов</span>
        </div>
        <div className="grow" />
        {canWork(session()?.user.role) && (
          <button className="btn primary" onClick={() => nav("/new")}>
            <Icon name="upload" size={16} /> Новая проверка
          </button>
        )}
      </header>
      <div className="page">
        <div className="kpis">
          <div className="kpi alert">
            <span className="label">Подтверждённые нарушения</span>
            <b>{sum("confirmed")}</b>
          </div>
          <div className="kpi warn">
            <span className="label">Кандидаты ждут решения</span>
            <b>{sum("candidates")}</b>
          </div>
          <div className="kpi">
            <span className="label">Нужно уточнение</span>
            <b>{sum("clarification")}</b>
          </div>
          <div className="kpi">
            <span className="label">Нет доказательства</span>
            <b>{sum("missing")}</b>
          </div>
          <div className="kpi ok">
            <span className="label">Расхождения нет</span>
            <b>{sum("negative")}</b>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head" style={{ flexWrap: "wrap" }}>
            <div className="row" style={{ flex: "1 1 220px", gap: 6 }}>
              <Icon name="search" size={16} />
              <input id="f-q" className="input" style={{ flex: 1 }} placeholder="Объект, адрес или номер проверки" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
            </div>
            <select id="f-status" className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Статус">
              <option value="">Все статусы</option>
              {Object.entries(PROCESS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.ru}
                </option>
              ))}
            </select>
            <select id="f-section" className="input" value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })} aria-label="Раздел">
              <option value="">Все разделы</option>
              {SECTIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input id="f-from" className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="С даты" />
            <input id="f-to" className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="По дату" />
          </div>
          {!data ? (
            <Loading error={error} />
          ) : !all.length ? (
            <div className="empty">Проверок по фильтру нет. Загрузите пакет документов — «Новая проверка».</div>
          ) : (
            ORDER.map((color) => {
              const rows = all.filter((r) => r.color === color);
              if (!rows.length) return null;
              return (
                <div className="group" key={color}>
                  <div className="group-head">
                    <button className="chev" onClick={() => setClosed({ ...closed, [color]: !closed[color] })} aria-label="Свернуть">
                      <Icon name={closed[color] ? "chev" : "down"} size={16} />
                    </button>
                    <span className={`pill solid-${color === "yellow" ? "amber" : color}`}>{COLOR_RU[color]}</span>
                    <span className="mute num">{rows.length}</span>
                  </div>
                  {!closed[color] && (
                    <div className="scroll-x">
                      <table className="rows">
                        <thead>
                          <tr>
                            <th style={{ width: "34%" }}>Объект</th>
                            <th>Статус</th>
                            <th>Тип проверки</th>
                            <th className="num">Кандидаты</th>
                            <th className="num">Нарушения</th>
                            <th>Разделы</th>
                            <th>Обновлено</th>
                            <th aria-label="Действие" />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.process_id} className={`link${visibleRows[sel]?.process_id === r.process_id ? " sel" : ""}`} onClick={() => open(r, false)}>
                              <td>
                                <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                                  <span className={`dot ${r.color}`} />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600 }}>{r.object_name}</div>
                                    <div className="mute small">
                                      <span className="mono">{r.process_id}</span> · {r.address}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <div className="row" style={{ gap: 4 }}>
                                  <ProcessPill status={r.status} />
                                  <SyncPill status={r.sync_status} />
                                </div>
                              </td>
                              <td className="mono small">{r.scenario ?? "—"}</td>
                              <td className="num">{r.counts.candidates || <span className="mute">0</span>}</td>
                              <td className="num" style={{ color: r.counts.confirmed ? "var(--red)" : undefined, fontWeight: r.counts.confirmed ? 700 : 400 }}>
                                {r.counts.confirmed}
                              </td>
                              <td className="small">{r.sections.join(", ") || <span className="mute">—</span>}</td>
                              <td className="small mute">{fmtDate(r.updated_at)}</td>
                              <td style={{ textAlign: "right" }}>
                                {workable(r) && (
                                  <button className="btn primary small-btn" onClick={(e) => (e.stopPropagation(), open(r, true))} title="Сразу к первому нерешённому кандидату (Enter)">
                                    Продолжить · {r.counts.candidates}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
