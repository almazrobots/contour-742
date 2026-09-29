// Карточка проверки: комплектность и сценарий, документы и редакции, протокол по разделам ТЗ 9.2, гипотезы, версии.
import { Fragment, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, download, session } from "../lib/api";
import { canWork } from "../lib/access";
import { fmtDate, METHOD_RU, REVISION_RU, STAGE_RU } from "../lib/labels";
import { FindingPill, Icon, Loading, Pill, Priority, ProcessPill, SyncPill, useLoad, useToast, VerificationPill } from "../components/ui";
import { DocCard, DocTypePill } from "../components/DocCard";
import { prefetchQueue } from "../components/Sheet";
import { UndoWindow } from "../components/UndoWindow";
import { CriticalReview, type CriticalItem } from "../components/CriticalReview";
import { FeedbackLogs } from "../components/FeedbackLogs";

type Tab = "overview" | "docs" | "protocol" | "hyp" | "history" | "logs";
// OS-INSP-4.1.6, 4.1.7: журналы отклонений и спорных случаев видны надзору и команде модели
const LOG_ROLES = ["supervisor", "admin", "ml_engineer", "curator"];

export function Inspection() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("overview");
  const [docSel, setDocSel] = useState<string | null>(null);
  // строка документа остаётся на месте экрана: раскрытый под ней просмотр не уводит её вверх
  const openDoc = (id: string | null) => {
    setDocSel(id);
    if (id) requestAnimationFrame(() => document.getElementById(`doc-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  // окно отмены финализации (T-111) — хук до раннего выхода, иначе порядок хуков ломается
  const [finalizing, setFinalizing] = useState(false);
  // OS-INSP-4.3.5: перечень критических параметров без ответа — до окна отмены; reviewed уходит в запрос финализации
  const [critical, setCritical] = useState<CriticalItem[] | null>(null);
  const [criticalReviewed, setCriticalReviewed] = useState(false);
  const { data: d, error, reload } = useLoad(() => api(`/api/v1/inspections/${id}?details=deferred`), [id]);
  const role = session()?.user.role;
  const work = canWork(role); // OS-INSP-4.1.26: дозагрузка, выборка и финализация — инспектор и супервизор
  // T-133: на вкладке «Документы» пакет подгружается в фоне — открытие документа не ждёт скачивания
  const pdfIds = (d?.files ?? []).filter((f: any) => f.kind === "pdf" && f.parse_status === "DONE").map((f: any) => f.id).join(",");
  useEffect(() => {
    if (tab !== "docs" || !pdfIds) return;
    const q = prefetchQueue(pdfIds.split(","));
    return () => q.cancel();
  }, [tab, pdfIds]);

  // пока идёт разбор — опрашиваем статус (pull-модель)
  useEffect(() => {
    if (d?.inspection.status !== "PARSING") return;
    const h = setInterval(reload, 1500);
    return () => clearInterval(h);
  }, [d?.inspection.status]);

  if (!d) return <Loading error={error} />;
  const i = d.inspection;
  const checks: any[] = d.checks.filter((c: any) => c.verification_status !== "SPLIT");
  const openCands = checks.filter((c) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING");
  const confirmed = checks.filter((c) => c.verification_status === "CONFIRMED_VIOLATION");
  const clar = checks.filter((c) => c.finding_status === "CLARIFICATION_REQUIRED" || c.verification_status === "CLARIFICATION_REQUIRED");
  const missing = checks.filter((c) => c.finding_status === "MISSING_EVIDENCE");
  const na = checks.filter((c) => c.finding_status === "NOT_APPLICABLE" || c.finding_status === "NOT_COMPARABLE");
  const neg = checks.filter((c) => c.finding_status === "NEGATIVE_VERIFIED" || c.verification_status === "NEGATIVE_VERIFIED");
  const candidates = checks.filter((c) => c.finding_status === "CANDIDATE");

  // ссылка LLM-советника: файл, страница, bbox, дословная цитата (OS-INSP-3.2.4)
  const adv = (s: any): any => {
    try {
      return s.advisor_ref_json ? JSON.parse(s.advisor_ref_json) : null;
    } catch {
      return null;
    }
  };

  const act = async (fn: () => Promise<any>, ok: string) => {
    try {
      await fn();
      toast(ok);
      reload();
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  // OS-INSP-4.3.5: сначала перечень критических параметров без ответа (если он не пуст), затем окно отмены
  const startFinalize = async () => {
    try {
      const r = await api<{ critical: CriticalItem[] }>(`/api/v1/inspection/${i.id}/critical-unresolved`);
      setCriticalReviewed(false);
      if (r.critical.length) setCritical(r.critical);
      else setFinalizing(true);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <a href="#/inspections">Проверки</a>
          <span>/</span>
          <b>{d.object.name}</b>
          <span className="mono">{i.id}</span>
        </div>
        <ProcessPill status={i.status} />
        <SyncPill status={i.sync_status} />
        <div className="grow" />
        {work && i.status !== "FINALIZED" && i.status !== "PARSING" && (
          <button className="btn" data-mutates onClick={() => nav(`/new?process_id=${i.id}`)}>
            <Icon name="upload" size={16} /> Дозагрузить
          </button>
        )}
        {work && (i.status === "READY" || i.status === "VERIFYING") && (
          <button className="btn" data-mutates onClick={() => nav(`/inspections/${i.id}/sample`)} title="Проверить 30 случайных совпадений и принять остальные одним действием (T-110)">
            Совпадения выборкой
          </button>
        )}
        {(i.status === "READY" || i.status === "VERIFYING") && (
          <button className="btn primary" onClick={() => nav(`/inspections/${i.id}/verify`)}>
            <Icon name="check" size={16} /> {work ? "Верифицировать" : "Карточки кандидатов"} · {openCands.length}
          </button>
        )}
        {work && (i.status === "COMPLETED" || ((i.status === "READY" || i.status === "VERIFYING") && openCands.length === 0)) && (
          <button className="btn primary" data-mutates disabled={finalizing} onClick={() => startFinalize()} title="Сводка сверки станет неизменяемой; 10 секунд на отмену">
            Завершить
          </button>
        )}
        {i.status === "FINALIZED" && (role === "supervisor" || role === "admin") && (
          <UnfinalizeButton onDone={reload} id={i.id} />
        )}
      </header>
      {critical && (
        <CriticalReview
          items={critical}
          onCancel={() => setCritical(null)}
          onContinue={() => (setCritical(null), setCriticalReviewed(true), setFinalizing(true))}
        />
      )}
      {finalizing && (
        // OS-INSP-4.3: финализация необратима для инспектора — вместо «Вы уверены?» окно отмены 10 с (T-111)
        <UndoWindow
          text="Сводка сверки будет завершена и передана в ИАИС «РиН»"
          onCancel={() => (setFinalizing(false), toast("Завершение отменено — сводка сверки остаётся черновиком"))}
          onCommit={() => (setFinalizing(false), act(() => api(`/api/v1/inspection/${i.id}/finalize`, { method: "POST", body: { critical_reviewed: criticalReviewed } }), "Сводка сверки завершена"))}
        />
      )}
      <nav className="tabs" aria-label="Разделы проверки">
        {(
          [
            ["overview", "Обзор", null],
            ["docs", "Документы", d.files.length],
            ["protocol", "Сводка сверки", candidates.length + confirmed.length],
            ["hyp", "Гипотезы", d.suspicions.length],
            ["history", "Версии и журнал", d.protocols.length],
            ...(LOG_ROLES.includes(role ?? "") ? ([["logs", "Отклонения и споры", null]] as const) : []),
          ] as const
        ).map(([k, l, n]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l} {n !== null && <span className="count">{n}</span>}
          </button>
        ))}
      </nav>
      <div className="page">
        {i.status === "PARSING" && (
          <div className="panel panel-body row">
            <Pill tone="blue">Идёт разбор</Pill>
            <span className="small">
              Разобрано {d.files.filter((f: any) => f.parse_status === "DONE").length} из {d.files.length} файлов. Сводка сверки сформируется автоматически.
            </span>
          </div>
        )}

        {tab === "overview" && (
          <>
            <div className="kpis">
              <div className="kpi alert"><span className="label">Нарушения подтверждены</span><b>{confirmed.length}</b></div>
              <div className="kpi warn"><span className="label">Кандидаты ждут решения</span><b>{openCands.length}</b></div>
              <div className="kpi"><span className="label">Нужно уточнение</span><b>{clar.length}</b></div>
              <div className="kpi"><span className="label">Нет доказательства</span><b>{missing.length}</b></div>
              <div className="kpi ok"><span className="label">Расхождения нет</span><b>{neg.length}</b></div>
              <div className="kpi"><span className="label">Неприменимо / несопоставимо</span><b>{na.length}</b></div>
            </div>
            <div className="grid2">
              <div className="panel">
                <div className="panel-head"><h2>Объект</h2></div>
                <dl className="kv panel-body">
                  <dt>Наименование</dt><dd>{d.object.name}</dd>
                  <dt>Адрес</dt><dd>{d.object.address}</dd>
                  <dt>Застройщик</dt><dd>{d.object.customer || "—"}</dd>
                  <dt>Подрядчик</dt><dd>{d.object.contractor || "—"}</dd>
                  <dt>Разрешение</dt><dd className="mono">{d.object.permit_number || "—"}</dd>
                  <dt>Профиль</dt>
                  <dd className="row" style={{ gap: 4 }}>
                    {Object.entries(d.object.profile).map(([k, v]) => (
                      <Pill key={k} tone={v ? "violet" : "gray"}>{({ synthetic: "СИНТЕТИКА", residential: "жилой", underground: "подземная часть", gas: "газ", demolition: "снос" } as any)[k] ?? k}: {v ? "да" : "нет"}</Pill>
                    ))}
                  </dd>
                </dl>
              </div>
              <div className="panel">
                <div className="panel-head"><h2>Комплектность</h2></div>
                <div className="panel-body stack">
                  <div className="row"><span className="label">Тип проверки</span><span className="mono">{i.scenario ?? "—"}</span></div>
                  <div className="stagebar">
                    {i.load_codes.map((c: string) => (
                      <span key={c} className="stage">
                        <span className={`dot ${c.endsWith("UPLOADED") ? "green" : c.endsWith("PARTIAL") ? "yellow" : "gray"}`} />
                        <span className="mono">{c}</span>
                      </span>
                    ))}
                  </div>
                  {d.missing_files.length > 0 && (
                    <div className="stack" style={{ gap: 6 }}>
                      <span className="label">Объявлены в реестре, но не загружены</span>
                      {d.missing_files.map((f: any) => (
                        <div key={f.file_id} className="row small">
                          <span className={`stagetag ${f.doc_stage}`} style={{ width: 28 }}>{STAGE_RU[f.doc_stage]}</span>
                          <span className="mono">{f.document_code}</span> {f.file_name}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="row small mute">Версия сводки {i.protocol_version || "—"} · обновлено {fmtDate(i.updated_at)}</div>
                  <div className="row">
                    {(["pdf", "docx", "xml", "json"] as const).map((f) => (
                      <button key={f} className="btn" disabled={!i.protocol_version} onClick={() => download(`/api/v1/inspection/${i.id}/protocol/export?format=${f}`, `protocol-${i.id}-v${i.protocol_version}.${f}`).catch((e) => toast(e.message, true))}>
                        {f.toUpperCase()}
                      </button>
                    ))}
                    {/* T-117 (OS-INSP-5.1.3): ответ в формате организатора — submission_schema.json, проверен по схеме до выдачи */}
                    <button className="btn" disabled={!i.protocol_version} title="Ответ по схеме организатора: коды параметров, метки нарушений, листы-доказательства"
                      onClick={() => download(`/api/v1/inspection/${i.id}/protocol/export?format=submission`, `submission-${i.object_id}-v${i.protocol_version}.json`).catch((e) => toast(e.message, true))}>
                      Ответ организатора
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <CheckGroup title="Кандидаты ждут решения" tone="amber" rows={openCands} onOpen={(c) => nav(`/inspections/${i.id}/verify?c=${c.id}`)} />
            <CheckGroup title="Подтверждённые нарушения" tone="red" rows={confirmed} onOpen={(c) => nav(`/inspections/${i.id}/verify?c=${c.id}`)} />
          </>
        )}

        {tab === "docs" && <OcrQualityPanel id={i.id} version={i.updated_at} />}
        {tab === "docs" && (
          <div className="panel scroll-x">
            <table className="rows">
              <thead>
                <tr><th>Стадия</th><th>Шифр</th><th>Вид документа</th><th>Ред.</th><th>Утверждение</th><th>Роль редакции</th><th>Файл</th><th>Реквизиты</th><th>Разбор</th><th>SHA-256</th></tr>
              </thead>
              <tbody>
                {d.files.map((f: any) => (
                  <Fragment key={f.id}>
                  <tr id={`doc-${f.id}`} className={`link ${docSel === f.id ? "sel" : ""}`} onClick={() => openDoc(docSel === f.id ? null : f.id)} title="Открыть документ под строкой">
                    <td><span className={`stagetag ${f.doc_stage}`} style={{ display: "inline-block", width: 28 }}>{STAGE_RU[f.doc_stage]}</span></td>
                    <td className="mono">{f.document_code}</td>
                    <td><DocTypePill t={f.doc_type} /></td>
                    <td className="mono">{f.revision}</td>
                    <td className="small">{f.approval_status ?? "—"}<div className="mute">{f.approval_date ?? ""}</div></td>
                    <td>
                      <Pill tone={f.revision_role === "CURRENT" ? "green" : f.revision_role === "SUPERSEDED" ? "gray" : "blue"}>{REVISION_RU[f.revision_role] ?? "—"}</Pill>
                      <div className="mute small">{f.revision_note}</div>
                    </td>
                    <td className="small">{f.file_name}<div className="mute">{(f.size / 1024).toFixed(0)} КБ · {f.kind.toUpperCase()}</div></td>
                    <td className="small num">
                      {f.requisites?.length ? `${f.requisites.length} на ${new Set(f.requisites.map((r: any) => r.page)).size} стр.` : <span className="mute">—</span>}
                      {checks.some((c) => c.param_code === `REQ-${f.client_file_id}`) && <div><Pill tone="gray">нет реквизита</Pill></div>}
                    </td>
                    <td className="small">
                      <Pill tone={f.parse_status === "DONE" ? "green" : f.parse_status === "FAILED" ? "red" : "blue"}>{f.parse_status}</Pill>
                      <div className="mute">
                        {f.pages?.some((p: any) => p.source === "ocr") && `OCR ${f.pages.find((p: any) => p.source === "ocr")?.ocr_confidence ?? ""}% `}
                        {f.pages?.some((p: any) => p.quality !== "OK") && "есть плохо читаемые страницы "}
                        {f.parse_error}
                      </div>
                    </td>
                    {/* ТЗ §10 Files.file_hash и file_path (T-234): путь в хранилище по содержимому */}
                    <td className="mono small mute" title={`SHA-256 ${f.sha256}${f.file_path ? `\nхранилище: ${f.file_path}` : ""}`}>{f.sha256.slice(0, 12)}…</td>
                  </tr>
                  {/* T-133: документ раскрывается прямо под своей строкой, а не в конце таблицы из 57 строк */}
                  {docSel === f.id && (
                    <tr className="doc-expand">
                      <td colSpan={10}>
                        <DocCard key={f.id} file={f} checks={checks} onClose={() => openDoc(null)} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "protocol" && i.protocol_version > 0 && <AiUsagePanel id={i.id} version={i.updated_at} />}
        {tab === "protocol" && <ProtocolView checks={checks} onOpen={(c) => nav(`/inspections/${i.id}/verify?c=${c.id}`)} />}

        {tab === "logs" && <FeedbackLogs url={`/api/v1/inspection/${i.id}/feedback-logs`} version={i.updated_at} />}

        {tab === "hyp" && (
          <div className="panel">
            <div className="panel-head">
              <h2>Гипотезы свободного поиска</h2>
              <span className="mute small">Гипотеза — ещё не нарушение: в эталонный набор не попадает, пока её не привяжут к листам и не решит инспектор</span>
            </div>
            {!d.suspicions.length ? (
              <div className="empty">Гипотез нет</div>
            ) : (
              <div className="scroll-x">
                <table className="rows">
                  <thead><tr><th>Метод</th><th>Описание</th><th>Ссылки</th><th>Норматив</th><th>Приоритет</th><th>Уверенность</th><th>Решение</th></tr></thead>
                  <tbody>
                    {d.suspicions.map((s: any) => (
                      <tr key={s.id}>
                        <td><Pill tone="violet">{METHOD_RU[s.discovery_method] ?? s.discovery_method}</Pill></td>
                        <td style={{ maxWidth: 420 }}>
                          {s.description}
                          {adv(s)?.quote && <blockquote className="small mute" style={{ margin: "4px 0 0", paddingLeft: 8, borderLeft: "2px solid currentColor" }}>«{adv(s).quote}»</blockquote>}
                        </td>
                        <td className="small mute">{s.pd_reference && <div>ПД: {s.pd_reference}</div>}{s.rd_reference && <div>РД: {s.rd_reference}</div>}</td>
                        <td className="small">{s.normative_base || <span className="mute">не подобран</span>}</td>
                        <td><Priority p={s.review_priority} /></td>
                        <td className="num">{Math.round(s.confidence * 100)}%</td>
                        <td>
                          <select
                            id={`sus-${s.id}`}
                            className="input"
                            value={s.inspector_status}
                            disabled={i.status === "FINALIZED"}
                            onChange={(e) => act(() => api(`/api/v1/suspicions/${s.id}/status`, { body: { inspector_status: e.target.value } }), "Решение по гипотезе сохранено")}
                          >
                            <option value="PENDING">Не рассмотрена</option>
                            <option value="ACCEPTED">Взять в работу</option>
                            <option value="DISMISSED">Отклонить</option>
                          </select>
                          {/* OS-INSP-3.2.7: гипотеза со ссылкой (файл, страница, bbox) переводится в кандидаты */}
                          {s.promoted_check_id ? (
                            <a className="small" href={`#/inspections/${i.id}/verify?c=${s.promoted_check_id}`}>Кандидат создан</a>
                          ) : (
                            adv(s)?.file_id && adv(s)?.page && adv(s)?.bbox && ["READY", "VERIFYING", "COMPLETED"].includes(i.status) && (
                              <button
                                className="btn"
                                style={{ marginTop: 4 }}
                                onClick={() => act(() => api(`/api/v1/suspicions/${s.id}/promote`, { body: { file_id: adv(s).file_id, page: adv(s).page, bbox: adv(s).bbox, quote: adv(s).quote } }), "Гипотеза переведена в кандидаты")}
                              >
                                В кандидаты
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="grid2">
            <div className="panel">
              <div className="panel-head"><h2>Версии сводки сверки</h2></div>
              <table className="rows">
                <tbody>
                  {d.protocols.map((p: any) => (
                    <tr key={p.version}>
                      <td className="mono">v{p.version}</td>
                      <td><Pill tone={p.status === "FINALIZED" ? "green" : "gray"}>{p.status === "FINALIZED" ? "финализирован" : "черновик"}</Pill></td>
                      <td className="small mute">{fmtDate(p.finalized_at ?? p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.sync_jobs.length > 0 && (
                <div className="panel-body stack">
                  <span className="label">Передача в ИАИС «РиН»</span>
                  {d.sync_jobs.map((j: any) => (
                    <div key={j.id} className="row small">
                      <SyncPill status={j.status === "FAILED" ? "SYNC_FAILED" : j.status} /> v{j.protocol_version} · попыток {j.attempts}
                      {j.last_error && <span className="mute">· {j.last_error}</span>}
                    </div>
                  ))}
                  {i.sync_status !== "SYNCED" && i.status === "FINALIZED" && (
                    <button className="btn" onClick={() => act(() => api(`/api/v1/inspection/${i.id}/sync`, { method: "POST" }), "Повторная отправка выполнена")}>
                      Повторить отправку
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-head"><h2>Журнал действий</h2></div>
              <table className="rows">
                <tbody>
                  {d.audit.map((a: any) => (
                    <tr key={a.id}>
                      <td className="small mute" style={{ whiteSpace: "nowrap" }}>{fmtDate(a.timestamp)}</td>
                      <td className="small">{a.user_name ?? "—"}</td>
                      <td className="mono small">{a.action}</td>
                      <td className="small mute" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{summarize(a.details)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === "history" && <Prescriptions id={i.id} />}
      </div>
    </>
  );
}

// OS-INSP-5.4.5: статусы предписаний так, как их сообщила ИАИС «РиН» (ТЗ §9.6.4); система их не меняет
const PRESCRIPTION_RU: Record<string, { ru: string; tone: string }> = {
  ISSUED: { ru: "выдано", tone: "blue" },
  IN_PROGRESS: { ru: "исполняется", tone: "amber" },
  COMPLETED: { ru: "исполнено", tone: "green" },
  CANCELLED: { ru: "отменено", tone: "gray" },
  EXTENDED: { ru: "срок продлён", tone: "amber" },
};

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);

/** OS-INSP-2.1.16 (ТЗ 9.1.1): сколько текста удалось прочитать и где читается плохо — по проверке и по файлам. */
function OcrQualityPanel({ id, version }: { id: string; version: string }) {
  const { data: q, error } = useLoad<any>(() => api(`/api/v1/inspection/${id}/ocr-quality`), [id, version]);
  if (!q) return <Loading error={error} />;
  const t = q.total;
  const bad = q.files.filter((f: any) => f.illegible_pages.length || (f.doubtful_share ?? 0) >= 0.1);
  const tone = t.illegible_share === null ? "gray" : t.illegible_share === 0 ? "green" : t.illegible_share < 0.1 ? "amber" : "red";
  return (
    <div className="panel" style={{ marginBottom: 16 }} aria-label="Качество распознавания" id="ocr-quality">
      <div className="panel-head">
        <h2>Качество распознавания</h2>
        <span className="mute small">Разобрано файлов: {t.parsed_files} из {t.files} · страниц: {t.pages}{t.ocr_pages ? `, из них сканов: ${t.ocr_pages}` : ""}</span>
      </div>
      <div className="panel-body">
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <div><div className="mute small">Текст получен</div><b>{pct(t.coverage)}</b> <span className="mute small">страниц</span></div>
          <div><div className="mute small">Плохо читаются</div><Pill tone={tone}>{t.low_quality + t.abstain} стр. · {pct(t.illegible_share)}</Pill></div>
          <div><div className="mute small">Сомнительные слова на сканах</div><b>{t.doubtful_share === null ? "—" : pct(t.doubtful_share)}</b>{t.ocr_words ? <span className="mute small"> ({t.doubtful_words} из {t.ocr_words})</span> : null}</div>
          {t.mean_ocr_confidence !== null && <div><div className="mute small">Уверенность распознавания сканов</div><b>{Math.round(t.mean_ocr_confidence)} %</b></div>}
        </div>
        {bad.length > 0 && (
          <table className="rows" style={{ marginTop: 12 }}>
            <thead><tr><th>Файл</th><th>Плохо читаемые страницы</th><th>Текст получен</th><th>Сомнительные слова</th></tr></thead>
            <tbody>
              {bad.map((f: any) => (
                <tr key={f.file_id}>
                  <td className="small">{f.file_name}</td>
                  <td className="small">{f.illegible_pages.length ? f.illegible_pages.join(", ") : <span className="mute">—</span>}</td>
                  <td className="small num">{pct(f.coverage)}</td>
                  <td className="small num">{pct(f.doubtful_share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {bad.length > 0 && <div className="mute small" style={{ marginTop: 8 }}>Значения с таких страниц проверяйте по листу: распознавание могло ошибиться. Лучше запросить скан чётче (300 dpi и выше).</div>}
      </div>
    </div>
  );
}

function PrescriptionPill({ status }: { status: string }) {
  const s = PRESCRIPTION_RU[status] ?? { ru: status, tone: "gray" };
  return <Pill tone={s.tone}>{s.ru}</Pill>;
}

function Prescriptions({ id }: { id: string }) {
  const { data, error } = useLoad<any[]>(() => api(`/api/v1/inspection/${id}/prescriptions`), [id]);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head"><h2>Предписания (по данным ИАИС «РиН»)</h2></div>
      {!data ? <Loading error={error} /> : !data.length ? <div className="empty">Предписаний по проверке нет</div> : (
        <table className="rows">
          <thead>
            <tr><th>Предписание</th><th>Текущий статус</th><th>Дата события в «РиН»</th><th>История</th></tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <PrescriptionRow key={p.prescription_id} p={p} open={openId === p.prescription_id} onToggle={() => setOpenId(openId === p.prescription_id ? null : p.prescription_id)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** OS-INSP-5.1.2: запись о применении ИИ-средства для акта (ПП Москвы № 2078-ПП, п. 9(1).8) — текст и сведения. */
function AiUsagePanel({ id, version }: { id: string; version: string }) {
  const toast = useToast();
  const rec = useLoad(() => api(`/api/v1/inspection/${id}/ai-usage`), [id, version]);
  const final = rec.data?.final === true;
  // текст для акта API выдаёт только после финализации (до неё решения инспектора ещё меняют данные) — иначе 409
  const text = useLoad(() => (final ? api<string>(`/api/v1/inspection/${id}/ai-usage?format=text`) : Promise.resolve(null)), [id, version, final]);
  const copy = async () => {
    const t = text.data ?? "";
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      // без доступа к буферу (http, старый браузер) — через выделение
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) return toast("Не удалось скопировать — выделите текст вручную", true);
    }
    toast("Текст записи скопирован — вставьте его в акт");
  };
  const r = rec.data;
  return (
    <div className="panel" aria-label="Запись о применении ИИ для акта">
      <div className="panel-head">
        <h2>Запись о применении ИИ для акта</h2>
        <span className="mute small">В акт — как есть; те же сведения передаются в ИАИС «РиН»</span>
        <div style={{ flex: 1 }} />
        <button className="btn primary" disabled={!text.data} onClick={copy}>Скопировать</button>
      </div>
      {!r || (final && text.data === null) ? (
        <Loading error={rec.error ?? text.error} />
      ) : (
        <div className="panel-body grid2" style={{ alignItems: "start" }}>
          {final ? (
            <pre className="act-text" id="ai-usage-text">{text.data}</pre>
          ) : (
            <div className="empty" id="ai-usage-pending">Текст для акта появится после завершения сводки сверки: до неё решения инспектора ещё меняют данные</div>
          )}
          <dl className="kv">
            <dt>Основание</dt><dd>{r.legal_basis}</dd>
            <dt>Средство</dt><dd>{r.tool.name}<div className="small mute">{r.tool.category}</div></dd>
            <dt>Версии</dt><dd className="small">модель <span className="mono">{r.tool.model_version}</span> · Матрица <span className="mono">{r.tool.matrix_version}</span> · набор <span className="mono">{r.tool.dataset_version}</span></dd>
            <dt>Применено</dt><dd>{fmtDate(r.applied_at)}</dd>
            <dt>Исправность</dt>
            <dd>
              {r.serviceability.ok ? (
                <Pill tone="green">исправно: обработаны все {r.serviceability.files_total} файлов</Pill>
              ) : (
                <>
                  <Pill tone="red">с отказами: не обработано {r.serviceability.files_failed.length} из {r.serviceability.files_total}</Pill>
                  <div className="small mute">{r.serviceability.files_failed.map((f: any) => f.file_name).join(", ")}</div>
                </>
              )}
            </dd>
            <dt>Получено данных</dt><dd><b className="num">{r.summary?.with_sources ?? r.data.filter((x: any) => x.sources?.length).length}</b> параметров с источниками (файл, страница, координаты) <span className="mute">из {r.data.length} проверенных</span></dd>
            {r.attachments.map((a: any) => (
              <AttachmentRow key={a.name} a={a} />
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function PrescriptionRow({ p, open, onToggle }: { p: any; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td className="mono">{p.prescription_id}</td>
        <td><PrescriptionPill status={p.status} /></td>
        <td className="small mute">{fmtDate(p.event_at)}</td>
        <td>
          <button className="btn" aria-expanded={open} onClick={onToggle}>
            {open ? "Скрыть" : `Показать (${p.history.length})`}
          </button>
        </td>
      </tr>
      {open && p.history.map((h: any) => (
        <tr key={`${h.status}-${h.event_at}`} className="small">
          <td />
          <td><PrescriptionPill status={h.status} /></td>
          <td className="mute">{fmtDate(h.event_at)}</td>
          <td className="mute">получено {fmtDate(h.received_at)}</td>
        </tr>
      ))}
    </>
  );
}

function AttachmentRow({ a }: { a: { name: string; sha256: string | null } }) {
  const main = a.name.startsWith("Протокол");
  return (
    <>
      <dt>{main ? "Хеш приложения" : a.name}</dt>
      <dd>
        {main && <div className="small">{a.name}</div>}
        {a.sha256 ? <span className="hash">SHA-256 {a.sha256}</span> : <span className="mute">не задан</span>}
      </dd>
    </>
  );
}


function summarize(details: string): string {
  try {
    const d = JSON.parse(details);
    return Object.entries(d)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : typeof v === "object" ? "…" : v}`)
      .join(" · ");
  } catch {
    return details;
  }
}

function UnfinalizeButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const toast = useToast();
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Отменить финализацию</button>;
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input id="unfinalize-reason" className="input" placeholder="Причина отмены (обязательно)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button
        className="btn danger"
        disabled={reason.trim().length < 5}
        onClick={async () => {
          try {
            await api(`/api/v1/inspection/${id}/unfinalize`, { body: { reason } });
            toast("Финализация отменена, запись в журнале аудита");
            setOpen(false);
            onDone();
          } catch (e: any) {
            toast(e.message, true);
          }
        }}
      >
        Отменить
      </button>
    </div>
  );
}

function CheckGroup({ title, tone, rows, onOpen }: { title: string; tone: string; rows: any[]; onOpen: (c: any) => void }) {
  if (!rows.length) return null;
  return (
    <div className="panel">
      <div className="group-head">
        <span className={`pill solid-${tone}`}>{title}</span>
        <span className="mute num">{rows.length}</span>
      </div>
      <CheckTable rows={rows} onOpen={onOpen} />
    </div>
  );
}

function CheckTable({ rows, onOpen }: { rows: any[]; onOpen: (c: any) => void }) {
  return (
    <div className="scroll-x">
      <table className="rows">
        <thead>
          <tr><th>Код</th><th>Параметр</th><th>Раздел</th><th>Ожидается</th><th>Факт</th><th>Δ</th><th>Статус</th><th>Решение</th><th>Приоритет</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="link" onClick={() => onOpen(c)}>
              <td className="mono">{c.param_code}</td>
              <td style={{ maxWidth: 320 }}>{c.parameter_name}<div className="mute small">{c.reason}</div></td>
              <td className="small">{c.section}</td>
              <td className="num">{c.expected_value ?? "—"}</td>
              <td className="num">{c.actual_value ?? "—"}</td>
              <td className="num small">{c.delta ?? ""}</td>
              <td><FindingPill status={c.finding_status} /></td>
              <td>{c.finding_status === "CANDIDATE" ? <VerificationPill status={c.verification_status} /> : <span className="mute">—</span>}</td>
              <td><Priority p={c.review_priority} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Протокол — раздельные таблицы ТЗ 9.2 п.4: комплектность, кандидаты, нарушения, отрицательные. */
function ProtocolView({ checks, onOpen }: { checks: any[]; onOpen: (c: any) => void }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({ neg: true, na: true });
  const groups = [
    { k: "cand", title: "Предварительные кандидаты", tone: "amber", rows: checks.filter((c) => c.finding_status === "CANDIDATE" && ["PENDING", "CLARIFICATION_REQUIRED"].includes(c.verification_status)) },
    { k: "conf", title: "Подтверждённые инспектором нарушения", tone: "red", rows: checks.filter((c) => c.verification_status === "CONFIRMED_VIOLATION") },
    { k: "clar", title: "Требуют уточнения редакции", tone: "blue", rows: checks.filter((c) => c.finding_status === "CLARIFICATION_REQUIRED") },
    { k: "miss", title: "Нет доказательства (не нарушение)", tone: "gray", rows: checks.filter((c) => c.finding_status === "MISSING_EVIDENCE") },
    { k: "neg", title: "Проверенные отрицательные", tone: "green", rows: checks.filter((c) => c.finding_status === "NEGATIVE_VERIFIED" || c.verification_status === "NEGATIVE_VERIFIED") },
    { k: "na", title: "Неприменимо и несопоставимо", tone: "gray", rows: checks.filter((c) => c.finding_status === "NOT_APPLICABLE" || c.finding_status === "NOT_COMPARABLE") },
  ];
  return (
    <div className="panel">
      {groups.map((g) => (
        <div className="group" key={g.k}>
          <div className="group-head">
            <button className="chev" onClick={() => setClosed({ ...closed, [g.k]: !closed[g.k] })} aria-label="Свернуть">
              <Icon name={closed[g.k] ? "chev" : "down"} size={16} />
            </button>
            <span className={`pill solid-${g.tone}`}>{g.title}</span>
            <span className="mute num">{g.rows.length}</span>
          </div>
          {!closed[g.k] && (g.rows.length ? <CheckTable rows={g.rows} onOpen={onOpen} /> : <div className="empty small">Нет записей</div>)}
        </div>
      ))}
    </div>
  );
}
