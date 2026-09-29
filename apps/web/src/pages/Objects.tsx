// Раздел «Объекты» (T-166, вариант Б плана T-142; OS-INSP-8.1.3–8.1.7): объект — главная сущность, проверки — журнал
// внутри объекта, история сохраняется. Реестр #/objects: объект, файлы по стадиям и строка ключевого параметра (М-023)
// с тремя ячейками ПД/РД/ИД. Карточка #/objects/:id: документы по стадиям (пустая стадия — видна), журнал проверок,
// сверка параметра и ссылка на паспорт. Только чтение: работает и на демо-стенде.
import { Fragment } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { AUTO_CHECK_RU, fmtDate, keyParamStatus, REVISION_RU, STAGE_RU, STAGE_STATE_RU, VERIFICATION } from "../lib/labels";
import { Icon, Loading, Pill, ProcessPill, useLoad } from "../components/ui";

type Stage = "PD" | "RD" | "ID";
const STAGES: Stage[] = ["PD", "RD", "ID"];
type Cell = { stage: Stage; state: string; value: string | null; document_code: string | null; page: number | null };
type KeyRow = {
  code: string; checked: boolean; inspection_id: string | null; check_id: string | null; finding_status: string | null; verification_status: string | null;
  decision: { status: string; by: string | null; at: string } | null; auto_check: { verdict: string; method: string; checked_at: string } | null; stages: Cell[];
};
type KeyInfo = { code: string; name: string };
const codeRu = (c: string) => c.replace(/^M-/, "М-"); // на экране — кириллица, как в Матрице

/** Ячейка стадии: значение с документом и листом или состояние словами. */
function StageValue({ c }: { c: Cell }) {
  if (c.state === "VALUE")
    return (
      <div>
        <b>{c.value}</b>
        {c.document_code && (
          <div className="mute small">
            {c.document_code}
            {c.page ? ` · лист ${c.page}` : ""}
          </div>
        )}
      </div>
    );
  return <span className="mute small">{STAGE_STATE_RU[c.state] ?? c.state}</span>;
}

function KeyStatus({ r }: { r: KeyRow }) {
  const s = keyParamStatus(r);
  return <Pill tone={s.tone}>{s.ru}</Pill>;
}

export function Objects() {
  const nav = useNavigate();
  const { data, error } = useLoad(() => api<{ key_params: KeyInfo[]; objects: any[] }>("/api/v1/objects"), []);
  const key = data?.key_params[0];
  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <b>Объекты</b>
          <span>·</span>
          <span>{data?.objects.length ?? 0}</span>
        </div>
      </header>
      <div className="page">
        <div className="panel">
          {!data ? (
            <Loading error={error} />
          ) : !data.objects.length ? (
            <div className="empty">Объектов пока нет. Объект появляется с первой загрузкой пакета документов.</div>
          ) : (
            <div className="scroll-x">
              <table className="rows" id="objects-registry">
                <thead>
                  <tr>
                    <th rowSpan={2} style={{ width: "26%" }}>Объект</th>
                    <th rowSpan={2}>Файлов: ПД · РД · ИД</th>
                    <th rowSpan={2}>Последняя проверка</th>
                    {key && (
                      <th colSpan={4} title={key.name}>
                        {codeRu(key.code)} · {key.name}
                      </th>
                    )}
                  </tr>
                  {key && (
                    <tr>
                      <th>Итог</th>
                      {STAGES.map((s) => (
                        <th key={s}>{STAGE_RU[s]}</th>
                      ))}
                    </tr>
                  )}
                </thead>
                <tbody>
                  {data.objects.map((o) => {
                    const r: KeyRow | undefined = o.key_param_rows[0];
                    return (
                      <tr key={o.id} className="link" onClick={() => nav(`/objects/${encodeURIComponent(o.id)}`)}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{o.name}</div>
                          <div className="mute small">{o.address || "адрес не указан"}</div>
                        </td>
                        <td className="num">
                          {STAGES.map((s, i) => (
                            <Fragment key={s}>
                              {i > 0 && <span className="mute"> · </span>}
                              <span className={o.stage_files[s] ? "" : "mute"} title={`${STAGE_RU[s]}: ${o.stage_files[s]}`}>
                                {o.stage_files[s]}
                              </span>
                            </Fragment>
                          ))}
                        </td>
                        <td className="small">
                          {o.last_inspection ? (
                            <div className="row" style={{ gap: 6 }}>
                              <ProcessPill status={o.last_inspection.status} />
                              <span className="mute">{fmtDate(o.last_inspection.updated_at)}</span>
                            </div>
                          ) : (
                            <span className="mute">проверок не было</span>
                          )}
                          {o.inspections_count > 1 && <div className="mute small">всего проверок: {o.inspections_count}</div>}
                        </td>
                        {r && (
                          <>
                            <td>
                              <KeyStatus r={r} />
                            </td>
                            {r.stages.map((c) => (
                              <td key={c.stage}>
                                <StageValue c={c} />
                              </td>
                            ))}
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function ObjectCard() {
  const { id = "" } = useParams();
  const { data: d, error } = useLoad(() => api<any>(`/api/v1/objects/${encodeURIComponent(id)}`), [id]);
  if (!d) return <Loading error={error} />;
  const infos: KeyInfo[] = d.key_params;
  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <a href="#/objects">Объекты</a>
          <span>/</span>
          <b>{d.object.name}</b>
        </div>
      </header>
      <div className="page">
        <div className="mute">{d.object.address || "адрес не указан"}</div>

        {(d.key_param_rows as KeyRow[]).map((r, i) => (
          <div className="panel" key={r.code} id={`key-${r.code}`}>
            <div className="panel-head">
              <b>
                {codeRu(r.code)} · {infos[i]?.name}
              </b>
              <KeyStatus r={r} />
              <div className="grow" />
              <a className="btn small-btn" href={`#/matrix?code=${r.code}`}>
                Сверка {codeRu(r.code)}: паспорт параметра
              </a>
            </div>
            <div className="panel-body">
              <table className="rows">
                <thead>
                  <tr>
                    {STAGES.map((s) => (
                      <th key={s}>{STAGE_RU[s]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {r.stages.map((c) => (
                      <td key={c.stage}>
                        <StageValue c={c} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <div className="row small" style={{ marginTop: 10 }}>
                {r.decision ? (
                  <span>
                    Решение инспектора: <b>{VERIFICATION[r.decision.status]?.ru ?? r.decision.status}</b>
                    <span className="mute">
                      {" "}
                      · {r.decision.by ?? "—"} · {fmtDate(r.decision.at)}
                    </span>
                  </span>
                ) : (
                  r.checked && <span className="mute">Решения инспектора ещё нет.</span>
                )}
                {r.auto_check && (
                  <span className="mute">
                    · {AUTO_CHECK_RU[r.auto_check.verdict] ?? r.auto_check.verdict} ({fmtDate(r.auto_check.checked_at)})
                  </span>
                )}
                {r.inspection_id && (
                  <a href={`#/inspections/${encodeURIComponent(r.inspection_id)}`}>
                    Открыть проверку, где параметр сверялся
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}

        <div className="panel" id="object-docs">
          <div className="panel-head">
            <Icon name="file" size={16} />
            <b>Документы по стадиям</b>
          </div>
          <div className="panel-body grid2">
            {STAGES.map((s) => {
              const docs: any[] = d.documents[s];
              return (
                <div key={s} className="stage-docs" data-stage={s}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <b>{STAGE_RU[s]}</b>
                    <span className="mute small">{docs.length ? `файлов: ${docs.length}` : ""}</span>
                  </div>
                  {!docs.length ? (
                    <div className="mute small">Стадия не загружена — документов нет.</div>
                  ) : (
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {docs.map((f) => (
                        <li key={f.id}>
                          <span className="mono">{f.document_code}</span> {f.doc_title ?? f.file_name}
                          <span className="mute">
                            {" "}
                            · ред. {f.revision}
                            {f.revision_role && REVISION_RU[f.revision_role] ? ` · ${REVISION_RU[f.revision_role]}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel" id="object-journal">
          <div className="panel-head">
            <Icon name="list" size={16} />
            <b>Журнал проверок</b>
            <span className="mute small">вся история, последние сверху</span>
          </div>
          {!d.inspections.length ? (
            <div className="empty">Проверок по объекту ещё не было.</div>
          ) : (
            <table className="rows">
              <thead>
                <tr>
                  <th>Проверка</th>
                  <th>Состояние</th>
                  <th className="num">Файлов</th>
                  <th>Начата</th>
                  <th>Обновлена</th>
                </tr>
              </thead>
              <tbody>
                {d.inspections.map((i: any) => (
                  <tr key={i.id}>
                    <td>
                      <a href={`#/inspections/${encodeURIComponent(i.id)}`} className="mono">
                        {i.id}
                      </a>
                    </td>
                    <td>
                      <ProcessPill status={i.status} />
                    </td>
                    <td className="num">{i.files}</td>
                    <td className="small mute">{fmtDate(i.created_at)}</td>
                    <td className="small mute">{fmtDate(i.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* T-234 (ТЗ §10 Protocols.object_id): версии протоколов объекта по всем его проверкам */}
        <div className="panel" id="object-protocols">
          <div className="panel-head">
            <Icon name="list" size={16} />
            <b>Протоколы объекта</b>
            <span className="mute small">версии по всем проверкам, новые сверху</span>
          </div>
          {!d.protocols?.length ? (
            <div className="empty">Протоколов по объекту ещё нет.</div>
          ) : (
            <table className="rows">
              <thead>
                <tr>
                  <th>Проверка</th>
                  <th className="num">Версия</th>
                  <th>Статус</th>
                  <th>Матрица · модель</th>
                  <th>Выпущен</th>
                </tr>
              </thead>
              <tbody>
                {d.protocols.map((p: any) => (
                  <tr key={`${p.inspection_id}-${p.version}`}>
                    <td>
                      <a href={`#/inspections/${encodeURIComponent(p.inspection_id)}`} className="mono">
                        {p.inspection_id}
                      </a>
                    </td>
                    <td className="num">v{p.version}</td>
                    <td>{p.status === "FINALIZED" ? <span className="small">финализирован {fmtDate(p.finalized_at)}</span> : <span className="small mute">черновик</span>}</td>
                    <td className="mono small mute">{p.matrix_version ?? "—"} · {p.model_version ?? "—"}</td>
                    <td className="small mute">{fmtDate(p.created_at)}</td>
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
