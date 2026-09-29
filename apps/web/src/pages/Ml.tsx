// Обратная связь и управляемое дообучение (OS-INSP-6): GOLD-набор, еженедельный отчёт, реестр моделей.
import { useState } from "react";
import { api, session } from "../lib/api";
import { fmtDate, fmtDay, MODEL_STATUS_RU } from "../lib/labels";
import { canApproveModel } from "../lib/access";
import { Icon, Loading, Pill, useLoad, useToast } from "../components/ui";
import { FeedbackLogs } from "../components/FeedbackLogs";

const ACTION_RU: Record<string, string> = { confirm: "подтверждено", reject: "отклонено", clarify: "уточнение" };
const actionTone = (a: string) => (a === "confirm" ? "red" : a === "reject" ? "green" : "blue");

/** OS-INSP-6.2.2: отчёты по дообучению, построенные планировщиком за каждую прошедшую неделю. */
function WeeklyReports() {
  const reports = useLoad(() => api<any[]>("/api/v1/ml/reports"), []);
  const [open, setOpen] = useState<number | null>(null);
  // неделя — [since; until): последний день недели — until минус сутки
  const lastDay = (until: string) => new Date(new Date(until).getTime() - 86400_000).toISOString();
  return (
    <div className="panel" aria-label="Еженедельные отчёты">
      <div className="panel-head">
        <h2>Еженедельные отчёты</h2>
        {reports.data && <span className="count">{reports.data.length}</span>}
        <span className="mute small">Строятся автоматически по понедельникам за прошедшую неделю</span>
      </div>
      {!reports.data ? <Loading error={reports.error} /> : !reports.data.length ? <div className="empty">Отчётов ещё нет — первый появится после окончания недели</div> : (
        <table className="rows" id="weekly-reports">
          <thead><tr><th /><th>Неделя</th><th>Решения инспекторов</th><th>Отклонений</th><th>Главная причина</th><th>Построен</th></tr></thead>
          <tbody>
            {reports.data.map((r) => {
              const rej = r.body.by_reason.reduce((a: number, x: any) => a + x.n, 0);
              const on = open === r.id;
              return [
                <tr key={r.id} className={`link ${on ? "sel" : ""}`} onClick={() => setOpen(on ? null : r.id)}>
                  <td style={{ width: 24 }}><Icon name={on ? "down" : "chev"} size={14} /></td>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.since)} — {fmtDay(lastDay(r.until))}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {!r.body.totals.length ? <span className="mute small">решений не было</span> : r.body.totals.map((t: any) => <Pill key={t.action} tone={actionTone(t.action)}>{ACTION_RU[t.action] ?? t.action}: {t.n}</Pill>)}
                    </div>
                  </td>
                  <td className="num">{rej}</td>
                  <td className="mono small">{r.body.by_reason[0]?.reason_code ?? "—"}</td>
                  <td className="small mute">{fmtDate(r.created_at)}</td>
                </tr>,
                on && (
                  <tr key={`${r.id}-d`}>
                    <td />
                    <td colSpan={5}>
                      <div className="grid2">
                        <div className="stack" style={{ gap: 6 }}>
                          <span className="label">Причины отклонений и что делать</span>
                          {!r.body.by_reason.length ? <div className="mute small">Отклонений за неделю нет</div> : r.body.by_reason.map((x: any) => (
                            <div key={x.reason_code} className="stack" style={{ gap: 2 }}>
                              <div className="row"><span className="mono small">{x.reason_code}</span><b className="num">{x.n}</b></div>
                              <div className="small mute">{x.recommendation}</div>
                            </div>
                          ))}
                        </div>
                        <div className="stack" style={{ gap: 6 }}>
                          <span className="label">Параметры с отклонениями</span>
                          {!r.body.by_param.length ? <div className="mute small">—</div> : r.body.by_param.map((x: any) => (
                            <div key={x.param_code} className="row small"><span className="mono">{x.param_code}</span> {x.parameter_name}<b className="num">{x.n}</b></div>
                          ))}
                        </div>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** ТЗ §10 Dataset_Items (T-234): элементы версии набора — доказательная группа, эксперт, причина, выборка; годность. */
function DatasetItems({ version }: { version: string }) {
  const r = useLoad(() => api<any>(`/api/v1/ml/datasets/${encodeURIComponent(version)}/items`), [version]);
  if (!r.data) return <Loading error={r.error} />;
  const s = r.data.summary;
  return (
    <div className="stack" style={{ gap: 6 }} aria-label={`Состав набора ${version}`}>
      <div className="row small">
        <span>{s.items} меток · экспертов {s.experts} · доказательных групп {s.evidence_groups}</span>
        {Object.entries(s.by_split).map(([k, n]) => <span key={k} className="mono mute">{k} {n as number}</span>)}
      </div>
      {s.issues.length ? <div className="small" style={{ color: "var(--red)" }}>Не годен к обучению: {s.issues.join("; ")}</div> : <div className="small mute">Годен к обучению: группы не пересекают выборки, у каждой метки есть эксперт</div>}
      {s.by_reason.length > 0 && <div className="small">Причины отрицательных меток: {s.by_reason.map((x: any) => `${x.reason_code} ${x.n}`).join(" · ")}</div>}
      <table className="rows">
        <thead><tr><th>Finding</th><th>Доказательная группа</th><th>Метка</th><th>Выборка</th><th>Эксперт</th><th>Причина</th><th className="num">Фрагментов</th></tr></thead>
        <tbody>
          {r.data.items.map((i: any) => (
            <tr key={i.finding_id}>
              <td className="mono small">{i.finding_id}</td>
              <td className="mono small mute">{i.evidence_group_id}</td>
              <td><Pill tone={i.gold_label === "POSITIVE" ? "red" : "green"}>{i.gold_label === "POSITIVE" ? "нарушение" : "нет нарушения"}</Pill></td>
              <td className="mono small">{i.split}</td>
              <td className="mono small">{i.expert_id ?? "—"}</td>
              <td className="mono small">{i.reason_code ?? "—"}</td>
              <td className="num">{i.fragments}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Ml() {
  const toast = useToast();
  const role = session()?.user.role;
  const preview = useLoad(() => api("/api/v1/ml/gold/preview"), []);
  const datasets = useLoad(() => api<any[]>("/api/v1/ml/datasets"), []);
  const report = useLoad(() => api("/api/v1/ml/report"), []);
  const models = useLoad(() => api<any[]>("/api/v1/ml/models"), []);
  const log = useLoad(() => api<any[]>("/api/v1/ml/retraining-log"), []);
  const [training, setTraining] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<string | null>(null);

  return (
    <>
      <header className="topbar"><div className="crumbs"><b>Модель и эталонный набор</b></div></header>
      <div className="page">
        <div className="grid2">
          <div className="panel">
            <div className="panel-head">
              <h2>Черновик GOLD</h2>
              <span className="mute small">Только решения из завершённых сводок сверки</span>
              <div style={{ flex: 1 }} />
              {role === "curator" || role === "admin" ? (
                <button
                  className="btn primary"
                  disabled={!preview.data?.items?.length}
                  onClick={async () => {
                    try {
                      const r = await api("/api/v1/ml/gold/release", { method: "POST" });
                      toast(`Выпущен набор ${r.dataset_version}: ${r.items} записей`);
                      datasets.reload();
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  Выпустить версию
                </button>
              ) : null}
            </div>
            {!preview.data ? <Loading error={preview.error} /> : (
              <div className="panel-body stack">
                <div className="kpis">
                  <div className="kpi alert"><span className="label">Положительные</span><b>{preview.data.positives}</b></div>
                  <div className="kpi ok"><span className="label">Отрицательные</span><b>{preview.data.negatives}</b></div>
                </div>
                <div className="small mute">
                  Разбиение по объектам: все документы и редакции одного объекта — в одной выборке. CANDIDATE, SUSPICION, MISSING_EVIDENCE и незавершённые решения не включаются.
                </div>
                <table className="rows">
                  <thead><tr><th>Finding</th><th>Объект</th><th>Метка</th><th>Выборка</th></tr></thead>
                  <tbody>
                    {preview.data.items.slice(0, 12).map((i: any) => (
                      <tr key={i.finding_id}>
                        <td className="mono small">{i.param_code}</td>
                        <td className="small">{i.object_id}</td>
                        <td><Pill tone={i.gold_label === "POSITIVE" ? "red" : "green"}>{i.gold_label === "POSITIVE" ? "нарушение" : "нет нарушения"}</Pill></td>
                        <td className="mono small">{i.split}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="panel-head"><h2>Отчёт по дообучению за неделю</h2></div>
            {!report.data ? <Loading error={report.error} /> : (
              <div className="panel-body stack">
                <div className="row small">
                  {report.data.totals.map((t: any) => (
                    <Pill key={t.action} tone={t.action === "confirm" ? "red" : t.action === "reject" ? "green" : "blue"}>
                      {{ confirm: "подтверждено", reject: "отклонено", clarify: "уточнение" }[t.action as "confirm"] ?? t.action}: {t.n}
                    </Pill>
                  ))}
                </div>
                <span className="label">Причины отклонений</span>
                {!report.data.by_reason.length ? <div className="mute small">Отклонений за период нет</div> : report.data.by_reason.map((r: any) => (
                  <div key={r.reason_code} className="stack" style={{ gap: 2 }}>
                    <div className="row"><span className="mono small">{r.reason_code}</span><b className="num">{r.n}</b></div>
                    <div className="small mute">{r.recommendation}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <WeeklyReports />
        <div className="grid2">
          <div className="panel">
            <div className="panel-head"><h2>Версии эталонного набора</h2></div>
            {!datasets.data ? <Loading error={datasets.error} /> : !datasets.data.length ? <div className="empty">Наборы ещё не выпускались</div> : (
              <table className="rows">
                <tbody>
                  {datasets.data.map((d) => [
                    <tr key={d.id}>
                      <td className="mono small">
                        {/* ТЗ §10 Dataset_Items (T-234): состав версии — группы, эксперты, причины */}
                        <button className="btn" onClick={() => setOpenSet(openSet === d.dataset_version ? null : d.dataset_version)} aria-expanded={openSet === d.dataset_version}>{d.dataset_version}</button>
                      </td>
                      <td className="num small">{d.items} зап. · +{d.positives} / −{d.negatives}</td>
                      <td className="small mute">{fmtDate(d.created_at)}</td>
                      <td>
                        {/* OS-INSP-6.4.4: дообучение модели ранжирования по выпущенной версии; публикация — после ворот и подписи */}
                        {(role === "ml_engineer" || role === "admin") && (
                          <button
                            className="btn"
                            disabled={training !== null}
                            onClick={async () => {
                              setTraining(d.dataset_version);
                              try {
                                const r = await api("/api/v1/ml/models/train", { method: "POST", body: { dataset_version: d.dataset_version } });
                                toast(r.gate.ok ? `Модель ${r.model_version} обучена и ждёт подписи` : `Модель ${r.model_version} не прошла ворота: ${r.gate.reasons.join("; ")}`, !r.gate.ok);
                                models.reload();
                              } catch (e: any) {
                                toast(e.message, true);
                              } finally {
                                setTraining(null);
                              }
                            }}
                          >
                            {training === d.dataset_version ? "Обучение…" : "Дообучить"}
                          </button>
                        )}
                      </td>
                    </tr>,
                    openSet === d.dataset_version && (
                      <tr key={`${d.id}-items`}>
                        <td colSpan={4}><DatasetItems version={d.dataset_version} /></td>
                      </tr>
                    ),
                  ])}
                </tbody>
              </table>
            )}
          </div>
          <div className="panel">
            <div className="panel-head"><h2>Реестр моделей</h2><span className="mute small">Публикация — после ворот качества и подписи ответственного</span></div>
            {!models.data ? <Loading error={models.error} /> : !models.data.length ? <div className="empty">Действующая модель — профиль dev (якоря + regex). Кандидатов на публикацию нет.</div> : (
              <table className="rows">
                <tbody>
                  {models.data.map((m) => {
                    const x = JSON.parse(m.metrics_json);
                    const p = m.training_params_json ? JSON.parse(m.training_params_json) : null;
                    return (
                      <tr key={m.id}>
                        <td className="mono small">{m.model_version}</td>
                        <td className="small num">
                          P {x.precision} · R {x.recall} · F1 {x.f1} · FPR {x.false_positive_rate}
                          {x.roc_auc !== undefined && <div className="mute">AUC {x.roc_auc} · Brier {x.brier} · порог {x.threshold}</div>}
                        </td>
                        {/* OS-INSP-6.4.5: состав итерации — набор, Матрица, код и параметры обучения, предыдущая модель, кто запустил */}
                        <td className="small">
                          <div className="mono">{m.dataset_version}{m.matrix_version ? ` · М ${m.matrix_version}` : ""}</div>
                          {m.training_code_hash && <div className="mono mute" title={m.training_code_hash}>код {m.training_code_hash.split(":")[1]?.slice(0, 10)} · веса {m.weights_hash?.slice(0, 10)}</div>}
                          {p && <div className="mono mute">L2 {p.l2} · итераций ≤ {p.max_iter} · Recall ≥ {p.min_recall} · seed {p.seed}</div>}
                          {m.previous_model && <div className="mute">после {m.previous_model}{m.trained_by ? ` · запустил ${m.trained_by}` : ""}</div>}
                        </td>
                        {/* ТЗ §10 Model_Versions (T-234): артефакт, подпись, ввод в контур, точка отката */}
                        <td className="small">
                          <Pill tone={(MODEL_STATUS_RU[m.approval_status] ?? { tone: "gray" }).tone}>{MODEL_STATUS_RU[m.approval_status]?.ru ?? m.approval_status}</Pill>
                          {m.artifact_hash && <div className="mono mute" title={m.artifact_hash}>артефакт {m.artifact_hash.slice(0, 10)}</div>}
                          {m.approved_by && <div className="mute">подписал {m.approved_by_name ?? m.approved_by}</div>}
                          {m.deployed_at && <div className="mute">в контуре с {fmtDate(m.deployed_at)}</div>}
                          {m.rollback_to && <div className="mute">откат к {m.rollback_to}</div>}
                        </td>
                        <td>
                          {m.approval_status === "AWAITING_APPROVAL" && canApproveModel(role) && (
                            <button className="btn" onClick={async () => { try { await api(`/api/v1/ml/models/${m.model_version}/approve`, { method: "POST" }); toast("Модель опубликована"); models.reload(); log.reload(); } catch (e: any) { toast(e.message, true); } }}>
                              Подписать публикацию
                            </button>
                          )}
                          {/* OS-INSP-6.3.3: откат действующей модели к версии rollback_to */}
                          {m.approval_status === "PUBLISHED" && m.rollback_to && canApproveModel(role) && (
                            <button className="btn" onClick={async () => {
                              const reason = window.prompt(`Откатить ${m.model_version} к ${m.rollback_to}? Укажите причину:`);
                              if (!reason?.trim()) return;
                              try { const r = await api(`/api/v1/ml/models/${m.model_version}/rollback`, { method: "POST", body: { reason } }); toast(`Откат выполнен: в контуре ${r.model_version}`); models.reload(); log.reload(); } catch (e: any) { toast(e.message, true); }
                            }}>
                              Откатить
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        {/* ТЗ §10 ML_Retraining_Log (ADR-0011): аудит обучения и решения о публикации */}
        <div className="panel" aria-label="Журнал дообучения">
          <div className="panel-head">
            <h2>Журнал дообучения</h2>
            {log.data && <span className="count">{log.data.length}</span>}
            <span className="mute small">Итерации: набор и хеши выборок, метрики, по категориям, решение о публикации</span>
          </div>
          {!log.data ? <Loading error={log.error} /> : !log.data.length ? <div className="empty">Итераций дообучения ещё не было</div> : (
            <div className="scroll-x">
              <table className="rows" id="retraining-log">
                <thead><tr><th>Модель</th><th>Набор · хеши выборок</th><th>P · R · F1 · FPR</th><th>Recall по категориям</th><th>Решение</th></tr></thead>
                <tbody>
                  {log.data.map((x) => {
                    const hs = x.split_hashes ? JSON.parse(x.split_hashes) : null;
                    const pc = x.per_category_metrics ? (JSON.parse(x.per_category_metrics) as Record<string, { recall: number | null }>) : {};
                    return (
                      <tr key={x.id}>
                        <td className="mono small">{x.model_version}<div className="mute">{fmtDate(x.created_at)}</div></td>
                        <td className="mono small">{x.dataset_version ?? "—"}{hs && <div className="mute">train {String(hs.train).slice(0, 8)} · val {String(hs.validation).slice(0, 8)} · test {String(hs.test).slice(0, 8)}</div>}</td>
                        <td className="num small">{x.precision ?? "—"} · {x.recall ?? "—"} · {x.f1 ?? "—"} · {x.false_positive_rate ?? "—"}</td>
                        <td className="small">{Object.entries(pc).map(([k, v]) => <span key={k} className="mono" style={{ marginRight: 8 }}>{k} {v.recall ?? "—"}</span>)}</td>
                        <td className="small"><Pill tone={(MODEL_STATUS_RU[x.approval_status] ?? { tone: "gray" }).tone}>{MODEL_STATUS_RU[x.approval_status]?.ru ?? x.approval_status}</Pill>{x.approved_by && <div className="mute">подписал {x.approved_by}</div>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {/* OS-INSP-4.1.27 (ТЗ 12.2): журналы отклонений и споров сводно по всем проверкам — ML-ролям проверки закрыты */}
        <FeedbackLogs url="/api/v1/ml/feedback-logs" showInspection />
      </div>
    </>
  );
}
