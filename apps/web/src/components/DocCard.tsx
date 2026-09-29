// Карточка документа на вкладке «Документы»: вид документа (OS-INSP-2.2.7), реквизиты по страницам (OS-INSP-2.3),
// находка REQ-<файл> о недостающем реквизите и лист с рамками реквизитов и кнопкой «Измерить» (OS-INSP-2.4).
import { useEffect, useRef, useState } from "react";
import { pct, REQUISITE_RU } from "../lib/labels";
import { FindingPill, Pill } from "./ui";
import { Sheet, type Mark, type Requisite } from "./Sheet";
import { PipelineTracePanel } from "./PipelineTrace";

export interface DocType {
  kind: string;
  label: string;
  confidence: number;
  page: number | null;
  bbox: [number, number, number, number] | null;
  evidence: string | null;
}

/** Бейдж вида документа: распознанный вид — фиолетовый, «прочий» — серый. */
export function DocTypePill({ t }: { t: DocType | null }) {
  if (!t) return <span className="mute small">не определён</span>;
  return (
    <span title={`Вид документа: ${t.label} · уверенность ${pct(t.confidence)}${t.evidence ? ` · «${t.evidence}»` : ""}`} data-doc-type={t.kind}>
      <Pill tone={t.kind === "other" ? "gray" : "violet"}>{t.label}</Pill>
    </span>
  );
}

export function DocCard({ file, checks, onClose }: { file: any; checks: any[]; onClose: () => void }) {
  const reqs: Requisite[] = file.requisites ?? [];
  const dt: DocType | null = file.doc_type;
  const pages = Math.max(file.pages?.length ?? 1, ...reqs.map((r) => r.page), 1);
  const [page, setPage] = useState<number>(dt?.page ?? reqs[0]?.page ?? 1);
  const [continuous, setContinuous] = useState<boolean>(() => readPref());
  const [jump, setJump] = useState<{ page: number; at: number } | null>(null);
  const [traceMark, setTraceMark] = useState<Mark | null>(null);
  useEffect(() => setTraceMark(null), [page, file.id]);
  useEffect(() => writePref(continuous), [continuous]);
  const byPage = new Map<number, Requisite[]>();
  for (const r of reqs) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
  // находка о недостающем реквизите приходит в checks с кодом REQ-<идентификатор файла из реестра>
  const reqFinding = checks.find((c) => c.param_code === `REQ-${file.client_file_id}`);
  const marks: Mark[] = dt?.bbox && dt.page === page ? [{ bbox: dt.bbox, kind: "expected", label: `вид: ${dt.label}` }] : [];
  if (traceMark) marks.push(traceMark);

  return (
    <div className="panel" aria-label="Карточка документа">
      <div className="panel-head">
        <h2>Документ</h2>
        <span className="mono">{file.document_code}</span>
        <span className="mute small">{file.file_name}</span>
        <DocTypePill t={dt} />
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>Закрыть</button>
      </div>
      <div className="panel-body doc-view">
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <div className="row small" style={{ gap: 12 }}>
            {!continuous && (
              <span className="pager">
                <button className="btn small-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Предыдущая страница">‹</button>
                <span className="num">стр. {page} из {pages}</span>
                <button className="btn small-btn" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Следующая страница">›</button>
              </span>
            )}
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} />
              Непрерывная прокрутка
            </label>
            <span className="mute">
              <span style={{ display: "inline-block", width: 10, height: 10, border: "1.5px dashed var(--green)", borderRadius: 2, marginRight: 4 }} />
              реквизит
            </span>
          </div>
          {continuous ? (
            <div className="doc-pages" aria-label="Все листы подряд">
              {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
                <LazyPage key={p} page={p} jump={jump}>
                  <Sheet file={file} page={p} marks={dt?.bbox && dt.page === p ? [{ bbox: dt.bbox, kind: "expected", label: `вид: ${dt.label}` }] : []} />
                </LazyPage>
              ))}
            </div>
          ) : (
            <Sheet key={`${file.id}@${page}`} file={file} page={page} marks={marks} />
          )}
        </div>
        <div className="stack doc-side">
          <PipelineTracePanel key={file.id} fileId={file.id} page={page} onMark={(mark) => { setTraceMark(mark); if (mark) setContinuous(false); }} />
          <dl className="kv">
            <dt>Вид документа</dt>
            <dd>
              {dt ? (
                <>
                  {dt.label} <span className="mute">· уверенность {pct(dt.confidence)}</span>
                  {dt.evidence && <div className="small mute">по заголовку «{dt.evidence}»{dt.page ? `, стр. ${dt.page}` : ""}</div>}
                </>
              ) : (
                "не определён"
              )}
            </dd>
          </dl>
          {reqFinding && (
            <div className="panel panel-body small stack" style={{ gap: 4 }} aria-label="Недостающий реквизит">
              <div className="row" style={{ gap: 6 }}>
                <FindingPill status={reqFinding.finding_status} />
                <span className="mono">{reqFinding.param_code}</span>
              </div>
              <div>{reqFinding.reason}</div>
            </div>
          )}
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">Реквизиты по страницам</span>
            {!reqs.length ? (
              <div className="mute small">Реквизиты не найдены</div>
            ) : (
              <table className="rows">
                <tbody>
                  {[...byPage.entries()].map(([p, rs]) => (
                    <tr key={p} className={`link ${p === page ? "sel" : ""}`} onClick={() => (continuous ? setJump({ page: p, at: Date.now() }) : setPage(p))}>
                      <td className="small num" style={{ whiteSpace: "nowrap" }}>стр. {p}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          {rs.map((r, i) => (
                            <Pill key={i} tone={r.bbox ? "green" : "gray"}>
                              {REQUISITE_RU[r.kind] ?? r.kind} <span className="num" style={{ fontWeight: 500 }}>{pct(r.confidence)}</span>
                            </Pill>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// T-133: режим «непрерывная прокрутка» — выбор инспектора помнится в этом браузере (не данные проверки)
const PREF = "inspector.doc.continuous";
function readPref(): boolean {
  try {
    return localStorage.getItem(PREF) === "1";
  } catch {
    return false;
  }
}
function writePref(v: boolean) {
  try {
    localStorage.setItem(PREF, v ? "1" : "0");
  } catch {
    /* приватный режим — без запоминания */
  }
}

/** Лист рисуется, только когда подъезжает к экрану: у чертежа на 463 страницы не открываются все сразу. */
function LazyPage({ page, jump, children }: { page: number; jump: { page: number; at: number } | null; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (jump?.page === page) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [jump, page]);
  return (
    <div ref={ref} className="doc-page" data-page={page}>
      <div className="small mute num">стр. {page}</div>
      {seen ? children : <div className="doc-page-stub" />}
    </div>
  );
}
