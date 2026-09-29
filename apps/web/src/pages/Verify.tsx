// Верификация (OS-INSP-4.1, 4.2): очередь → карточка доказательства → листы ПД/РД/ИД с выделенными областями.
// Решение — не больше 3 кликов (OS-INSP-4.1.5): «Признать» (1); «Снять» → причина (2, комментарий — текст причины);
// «Уточнить» (1). Клавиши по физической клавише (работают и в ЙЦУКЕН): J/K — следующий/предыдущий, 1/2/3 — решение,
// после 2 — цифра причины; Space (удерживать) — весь лист вместо фрагмента (Прицел, T-106).
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, download, session } from "../lib/api";
import { canWork } from "../lib/access";
import { STAGE_RU } from "../lib/labels";
import { FindingPill, Icon, Loading, Priority, useLoad, useToast, VerificationPill } from "../components/ui";
import { Sheet, prefetchDocs, type Mark } from "../components/Sheet";
import { keyAction } from "../lib/aim";
import { ClassMentions, mentionKey, type ProvMention } from "../components/ClassMentions";
import { StageStrip } from "../components/StageStrip";
import { VerifyNotes } from "../components/VerifyNotes";
import { ALL_PARAMS, filterableParams, pendingDecision, queueParam, verifyQueue } from "../lib/queue";

/** Переход T1 карты сценариев: чип с кодом решённого параметра улетает по дуге в лоток; ввод анимацию не ждёт. */
function flyToTray(code: string, outcome: "v" | "n" | "q") {
  const from = document.querySelector(".card h2");
  const to = document.querySelector(`.tray .t.${outcome}`);
  if (!from || !to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const chip = document.createElement("div");
  chip.className = "fly-chip";
  // только DOM и textContent: код параметра приходит с сервера и не вставляется разметкой
  const dot = document.createElement("span");
  dot.className = `dot ${outcome}`;
  chip.append(dot, document.createTextNode(code));
  chip.style.left = `${a.left}px`;
  chip.style.top = `${a.top}px`;
  document.body.append(chip);
  const dx = b.left - a.left;
  const dy = b.top - a.top;
  chip
    .animate(
      [
        { transform: "translate(0, 0) scale(1.1)", opacity: 1 },
        { transform: `translate(${dx * 0.55}px, ${Math.min(dy, 0) - 50}px) scale(1)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(.8)`, opacity: 0.2 },
      ],
      { duration: 220, easing: "cubic-bezier(.45,0,.2,1)" },
    )
    .finished.then(() => chip.remove(), () => chip.remove());
}

// крупный кегль — для коротких значений; длинная подпись (дифф листа, строка) — мельче, без переносов по слогам
const valueSize = (v: unknown) => (String(v ?? "").length > 12 ? "long" : "");
// «СК2-Р-АР, ред. A, л. 2» → «ред. A, л. 2»: шифр уже в заголовке и источниках
const revOf = (v: unknown) => {
  const m = /ред\.\s*[^,]+(,\s*л\.\s*\S+)?/.exec(String(v ?? ""));
  return m ? m[0] : String(v ?? "—");
};

export function Verify() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: d, error, reload } = useLoad(() => api(`/api/v1/inspections/${id}?details=deferred`), [id]);
  const { data: dict } = useLoad(() => api(`/api/v1/dictionaries`), []);
  const passportCode = (() => {
    if (!d) return null;
    const c = d.checks.find((x: any) => x.id === params.get("c"));
    return c?.about_param ?? c?.param_code ?? null;
  })();
  const { data: passport } = useLoad<any>(() => (passportCode && /^M-\d{3}$/.test(passportCode) ? api(`/api/v1/params/${passportCode}/passport`) : Promise.resolve(null)), [passportCode]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [comment, setComment] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // NFR-VERIFY-30: начало цикла верификации для замера юзабилити-теста — один раз на проверку, не блокирует экран
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!id || opened.current === id) return;
    opened.current = id;
    api(`/api/v1/inspection/${id}/verification/open`, { method: "POST" }).catch(() => {});
  }, [id]);
  // OS-INSP-2.3: рамки реквизитов (подпись, печать, штампы, дата) поверх листов — можно скрыть
  const [showReq, setShowReq] = useState(true);
  // Прицел: по умолчанию лист открыт на фрагменте вокруг рамки; Space — весь лист, пока клавиша нажата
  const [whole, setWhole] = useState(false);
  // OS-INSP-4.1.16: действия инспектора от показа кандидата до решения; OS-INSP-4.1.15: последнее решение для Z
  const acts = useRef(0);
  const lastDecided = useRef<string | null>(null);
  // общий корень (OS-INSP-4.1.12–4.1.14): после снятия — соседи с той же сигнатурой причины
  const [fan, setFan] = useState<{ from: string; code: string; reason: string; label: string; items: any[]; sel: Set<string>; cur: number } | null>(null);

  // OS-INSP-4.1.17 (T-130): очередь по одному параметру — ?param=M-023. В ней результат системы по параметру (даже
  // «расхождения нет» — чтобы инспектор видел, на чём он основан) и кандидаты-гипотезы о нём; посторонних нет.
  // Ссылка на запись вне очереди кандидатов (?c=… без ?param) открывает очередь её параметра.
  const [picked, setPicked] = useState<ProvMention | null>(null);
  // T-132 (просьба владельца): очередь сворачивается в ленту кодов; раскладка листов — рядом, стопкой, крупно.
  // Это удобство одного инспектора — хранится в браузере; нет хранилища — умолчания.
  const pref = (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  };
  const [qMin, setQMin] = useState(() => pref("verify.queue", window.innerWidth < 1400 ? "min" : "full") === "min");
  const [layout, setLayout] = useState(() => pref("verify.layout", "side"));
  const savePref = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* приватный режим — без запоминания */
    }
  };
  const param = queueParam(d?.checks ?? [], params.get("param"), params.get("c"));
  const queue = useMemo<any[]>(() => (d ? verifyQueue(d.checks, param) : []), [d, param]);
  const filterable = useMemo(() => filterableParams(d?.checks ?? []), [d]);
  const cur = queue.find((c: any) => c.id === params.get("c")) ?? queue[0];
  const provenanceSource = cur ? (cur.has_provenance ? cur : d?.checks.find((c: any) => c.param_code === cur.about_param && c.has_provenance)) : null;
  const { data: detail, error: detailError, loading: detailLoading } = useLoad<any>(async () => {
    if (!cur) return null;
    const selected = await api<any>(`/api/v1/checks/${encodeURIComponent(cur.id)}/details`);
    const source = provenanceSource && provenanceSource.id !== cur.id
      ? await api<any>(`/api/v1/checks/${encodeURIComponent(provenanceSource.id)}/details`) : selected;
    return { ...selected, provenance_json: source.provenance_json };
  }, [cur?.id, provenanceSource?.id, d]);
  const selectedDetail = detail?.id === cur?.id && !detailLoading ? detail : null;
  const idx = cur ? queue.indexOf(cur) : -1;
  // ждут решения — только кандидаты: результат системы по параметру (очередь ?param=) решения не требует
  const pending = pendingDecision;
  const open = queue.filter(pending).length;
  const candidates = queue.filter((c: any) => c.finding_status === "CANDIDATE").length;
  // OS-INSP-4.1.26: администратор смотрит карточки, но решений не выносит — для него очередь только на просмотр
  const locked = d && (!["READY", "VERIFYING"].includes(d.inspection.status) || !canWork(session()?.user.role));

  const go = (c: any) => {
    acts.current = 0;
    setRejecting(false);
    setReason("");
    setComment("");
    setFocus(null);
    setPicked(null);
    if (c) setParams(param ? { c: c.id, param } : { c: c.id }, { replace: true });
  };
  const setFilter = (code: string) => {
    setPicked(null);
    setParams(code ? { param: code } : {}, { replace: true });
  };

  const DONE: Record<string, string> = { confirm: "Признано инспектором", reject: "Снято", clarify: "Отправлено на уточнение" };
  async function decide(body: any) {
    if (!cur || cur.finding_status !== "CANDIDATE") return; // решение — только по кандидату
    const was = cur;
    // следующий кандидат показывается сразу, не дожидаясь ответа: его документы уже открыты заранее
    const next = queue.slice(idx + 1).find(pending) ?? queue.find((c: any) => pending(c) && c.id !== was.id);
    setBusy(true);
    const actions = acts.current + 1;
    flyToTray(was.param_code, body.action === "confirm" ? "v" : body.action === "reject" ? "n" : "q");
    go(next ?? was);
    try {
      await api(`/api/v1/checks/${was.id}/decision`, { body: { ...body, actions } });
      lastDecided.current = was.id;
      if (body.action === "reject") {
        const sib = await api<any[]>(`/api/v1/checks/${was.id}/siblings`).catch(() => []);
        if (sib.length) {
          const act = (was.fragments ?? []).find((f: any) => f.role_expected_actual === "actual");
          setFan({ from: was.id, code: was.param_code, reason: body.reason_code, label: act ? `${act.document_code} ред. ${act.revision}` : "тот же документ", items: sib, sel: new Set(sib.map((x) => x.id)), cur: 0 });
        }
      }
      toast(`${was.param_code} · ${DONE[body.action] ?? "Решение записано"} · Z — вернуть`);
      reload();
    } catch (e: any) {
      // не записалось — возвращаем кандидата на экран, очередь не сдвигается
      go(was);
      toast(`${was.param_code} — решение не записано: ${e.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function split() {
    if (!cur) return;
    const actual = cur.fragments.filter((f: any) => f.role_expected_actual === "actual");
    const frs = await api<any[]>(`/api/v1/checks/${cur.id}/fragments`);
    const parts = frs.filter((f) => f.role_expected_actual === "actual").map((f) => ({ title: `${cur.parameter_name}: ПД → ${STAGE_RU[f.stage]}`, fragment_ids: [f.id] }));
    if (actual.length < 2) return toast("Разделять нечего: у кандидата один фактический источник", true);
    try {
      await api(`/api/v1/checks/${cur.id}/split`, { body: { parts } });
      toast(`Кандидат разделён на ${parts.length} атомарные записи`);
      reload();
    } catch (e: any) {
      toast(e.message, true);
    }
  }

  const reasons = Object.entries(dict?.reason_codes ?? {}) as [string, string][];
  async function applyFan() {
    if (!fan || busy) return;
    const ids = [...fan.sel];
    setBusy(true);
    try {
      if (ids.length) {
        const r = await api<{ rejected: string[] }>(`/api/v1/checks/${fan.from}/reject-group`, { body: { reason_code: fan.reason, ids, actions: 1 } });
        toast(`Снято ещё ${r.rejected.length} — каждое записано отдельно`);
      }
      setFan(null);
      reload();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    const idTo = lastDecided.current;
    if (!idTo || busy) return;
    setBusy(true);
    try {
      await api(`/api/v1/checks/${idTo}/reopen`, { method: "POST" });
      lastDecided.current = null;
      setParams({ c: idTo }, { replace: true });
      toast("Решение возвращено — кандидат снова на оценке");
      reload();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  const rejectWith = (k: string, text: string) => decide({ action: "reject", reason_code: k, comment: text });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        if (!e.repeat) setWhole(true);
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA" || busy || locked) return;
      if (fan) {
        if (e.code === "Enter" || e.code === "NumpadEnter") applyFan();
        else if (e.code === "Escape") setFan(null);
        else if (e.code === "KeyJ" || e.code === "ArrowDown") setFan({ ...fan, cur: Math.min(fan.cur + 1, fan.items.length - 1) });
        else if (e.code === "KeyK" || e.code === "ArrowUp") setFan({ ...fan, cur: Math.max(fan.cur - 1, 0) });
        else if (e.code === "KeyX" || e.code === "Space") {
          const id = fan.items[fan.cur]?.id;
          const sel = new Set(fan.sel);
          if (id) sel.has(id) ? sel.delete(id) : sel.add(id);
          setFan({ ...fan, sel });
        } else return;
        e.preventDefault();
        return;
      }
      const a = keyAction(e, rejecting ? "reasons" : "idle");
      if (!a) return;
      e.preventDefault();
      // карточка результата системы: J/K листают, клавиши решения не действуют
      if (cur && cur.finding_status !== "CANDIDATE" && !["next", "prev", "undo"].includes(a.type)) return;
      if (a.type === "next") go(queue[Math.min(idx + 1, queue.length - 1)]);
      else if (a.type === "prev") go(queue[Math.max(idx - 1, 0)]);
      else if (a.type === "confirm") decide({ action: "confirm" });
      else if (a.type === "reject") (acts.current++, setRejecting(true));
      else if (a.type === "undo") undo();
      else if (a.type === "clarify") decide({ action: "clarify" });
      else if (a.type === "reason" && reasons[a.index]) rejectWith(reasons[a.index][0], reasons[a.index][1]);
      else if (a.type === "submit" && reason && comment.trim()) rejectWith(reason, comment);
      else if (a.type === "cancel") setRejecting(false);
    };
    const onUp = (e: KeyboardEvent) => e.code === "Space" && setWhole(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  });

  // Прицел: документы следующих трёх кандидатов открываются заранее, пока инспектор решает текущего
  useEffect(() => {
    if (idx < 0) return;
    const ahead = queue.slice(idx + 1, idx + 4).flatMap((c: any) => (c.fragments ?? []).map((f: any) => f.file_id));
    prefetchDocs([...new Set<string>(ahead)].filter((fid) => d?.files.find((f: any) => f.id === fid)?.kind === "pdf"));
  }, [idx, queue, d]);

  if (!d) return <Loading error={error} />;
  const fileBy = new Map<string, any>(d.files.map((f: any) => [f.id, f]));
  const frags = (cur?.fragments ?? []) as any[];
  const shown = focus === null ? frags : [frags[focus]];
  // дифф листа между редакциями (OS-INSP-3.4): лист A — «было», лист B — «стало»
  const isDiff = cur?.param_code === "SHEET-DIFF";
  const sheetA = frags.find((f: any) => f.role_expected_actual === "expected");
  const sheetB = frags.find((f: any) => f.role_expected_actual === "actual");
  // один лист на файл+страницу, все рамки этого листа — на нём
  const sheets = new Map<string, { file: any; page: number; marks: Mark[]; value: string }>();
  for (const f of shown) {
    const key = `${f.file_id}@${f.sheet_page}`;
    const s = sheets.get(key) ?? { file: fileBy.get(f.file_id), page: f.sheet_page ?? 1, marks: [] as Mark[], value: f.extracted_value };
    const bbox = f.bbox_polygon_norm ? JSON.parse(f.bbox_polygon_norm) : null;
    if (isDiff) s.marks.push({ bbox, kind: f.role_expected_actual, tone: "diff", label: f.role_expected_actual === "expected" ? `лист A · ред. ${f.revision}` : `лист B · ред. ${f.revision}` });
    else s.marks.push({ bbox, kind: f.role_expected_actual, label: `${f.role_expected_actual === "expected" ? "ожидается" : "факт"}: ${f.extracted_value}` });
    sheets.set(key, s);
  }
  // OS-INSP-4.1.18: результат по параметру-классу и все его упоминания — у самой записи или у параметра гипотезы
  const mentions: ProvMention[] = selectedDetail?.provenance_json ? (JSON.parse(selectedDetail.provenance_json).mentions ?? []) : [];
  // стадии без значения — плашкой рядом с листами: что не представлено и какой документ нужен (из паспорта, T-132)
  const gaps = mentions.length
    ? (["PD", "RD", "ID"] as const)
        .filter((st) => !mentions.some((m) => m.stage === st && m.use === "chosen"))
        .map((st) => ({ stage: st, docs: d.files.filter((f: any) => f.doc_stage === st).length, need: passport?.passport?.sources?.[st]?.[0]?.label?.replace(/\s+—\s+источник Матрицы$/, "") ?? null }))
    : [];
  // T-132: подпись показателя («Площадь застройки») — пунктиром на том же листе, прицел захватывает её вместе с числом
  for (const m of mentions) {
    if (m.use !== "chosen" || !m.anchor_bbox) continue;
    const s = sheets.get(`${m.file_id}@${m.page}`);
    if (s) s.marks.push({ bbox: m.anchor_bbox, kind: "anchor", label: "показатель" });
  }
  if (picked) {
    // выбранное упоминание — на своём листе, первым: инспектор сверяет его глазами
    const key = `${picked.file_id}@${picked.page}`;
    const s = sheets.get(key) ?? { file: fileBy.get(picked.file_id), page: picked.page, marks: [] as Mark[], value: picked.value };
    s.marks.push({ bbox: picked.bbox ?? null, kind: "actual", label: `${picked.document_code}: ${picked.qualifier === "min" ? "не ниже " : ""}${picked.value}` });
    if (picked.anchor_bbox) s.marks.push({ bbox: picked.anchor_bbox, kind: "anchor", label: "показатель" });
    sheets.delete(key);
    const rest = [...sheets.entries()];
    sheets.clear();
    sheets.set(key, s);
    for (const [k, v] of rest) sheets.set(k, v);
  }
  const systemOnly = cur && cur.finding_status !== "CANDIDATE"; // результат системы по параметру — не кандидат на решение

  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <a href="#/inspections">Проверки</a>
          <span>/</span>
          <a href={`#/inspections/${id}`}>{d.object.name}</a>
          <span>/</span>
          <b>Верификация</b>
        </div>
        <span className="pill amber">{open} ждут решения</span>
        {(filterable.length > 0 || d.checks.length > 0) && (
          <label className="param-filter small">
            <span className="mute">Параметр</span>
            <select id="param-filter" className="input" value={param ?? ""} onChange={(e) => setFilter(e.target.value)}>
              <option value="">все кандидаты</option>
              <option value={ALL_PARAMS}>все параметры ({d.checks.filter((c: any) => /^M-\d{3}$/.test(c.param_code)).length})</option>
              {filterable.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </label>
        )}
        <div className="grow" />
        <span className="small mute">
          <span className="mono">J K</span> — навигация · <span className="mono">1 2 3</span> — решение · <span className="mono">Space</span> — весь лист
        </span>
        {open === 0 && (
          <button className="btn good" onClick={() => nav(`/inspections/${id}`)}>
            Все кандидаты обработаны — к сводке сверки
          </button>
        )}
      </header>
      {queue.length > 0 && (
        // ход верификации: деление на кандидата, цвет — исход решения; клик — переход к кандидату
        <div className="progress-strip" aria-label="Ход верификации">
          <div className="segs">
            {queue.map((c: any) => (
              <button key={c.id} className={`seg ${c.verification_status}${c.id === cur?.id ? " cur" : ""}`} title={`${c.param_code} · ${c.parameter_name}`} aria-label={c.param_code} onClick={() => go(c)} />
            ))}
          </div>
          <span className="num small">
            решено <b>{candidates - open}</b> из {candidates}
          </span>
        </div>
      )}
      {!queue.length ? (
        <div className="page"><div className="panel empty">{param ? `По параметру ${param} записей нет.` : "Кандидатов нет — сводку сверки можно завершить на карточке проверки."}</div></div>
      ) : (
        <div className={`verify${qMin ? " q-min" : ""}`}>
          <aside className="queue" aria-label="Очередь кандидатов">
            <div className="queue-head">
              {!qMin && <span className="label">Очередь · {queue.length}</span>}
              <button
                className="btn ghost small-btn"
                onClick={() => (setQMin(!qMin), savePref("verify.queue", qMin ? "full" : "min"))}
                title={qMin ? "Развернуть очередь" : "Свернуть очередь до кодов параметров"}
                aria-label={qMin ? "Развернуть очередь" : "Свернуть очередь"}
              >
                {qMin ? "»" : "«"}
              </button>
            </div>
            {qMin &&
              queue.map((c: any) => (
                <button key={c.id} className={`q-code ${c.id === cur?.id ? "on" : ""} f-${c.finding_status}`} onClick={() => go(c)} title={`${c.param_code} · ${c.parameter_name}`}>
                  <span className="q-dot" />
                  <span className="mono">{c.param_code.replace(/^M-/, "")}</span>
                </button>
              ))}
            {!qMin && queue.map((c: any) => (
              <div key={c.id} className={`item ${c.id === cur?.id ? "on" : ""}`} onClick={() => go(c)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && go(c)}>
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <span className="mono small">{c.param_code}</span>
                  <span style={{ flex: 1 }} />
                  {/* результат системы (не кандидат) решения не ждёт — показывается статус находки (T-132) */}
                  {c.finding_status === "CANDIDATE" ? <VerificationPill status={c.verification_status} /> : <FindingPill status={c.finding_status} />}
                </div>
                <div style={{ fontWeight: 550, fontSize: 13 }}>{c.parameter_name}</div>
                <div className="row small mute" style={{ gap: 6 }}>
                  <span className="num">{c.expected_value ?? "—"} → {c.actual_value ?? "—"}</span>
                  <Priority p={c.review_priority} />
                </div>
              </div>
            ))}
          </aside>

          {cur && (
            <section className="card" aria-label="Карточка доказательства">
              <div className="stack" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="mono small">{cur.param_code}</span>
                  <span className="mute small">· {cur.section}</span>
                  <span style={{ flex: 1 }} />
                  <FindingPill status={cur.finding_status} />
                </div>
                <h2>{cur.parameter_name}</h2>
                {isDiff && (
                  <div className="small" style={{ fontWeight: 600 }}>
                    Изменения листа: лист A ↔ лист B
                    {sheetA && sheetB && (
                      <span className="mute" style={{ fontWeight: 400 }}>
                        {" "}· {sheetA.document_code}, ред. {sheetA.revision} → ред. {sheetB.revision}, стр. {sheetA.sheet_page}
                      </span>
                    )}
                  </div>
                )}
                <div className="small mute">{cur.reason}</div>
              </div>
              <div className="compare">
                <div className="cell">
                  <span className="label">{isDiff ? "Лист A — было" : "По проекту"}</span>
                  <b className={valueSize(isDiff ? revOf(cur.expected_value) : cur.expected_value)}>{isDiff ? revOf(cur.expected_value) : cur.expected_value ?? "—"}</b>
                  <span className="small mute">{cur.unit}</span>
                </div>
                {/* нет второй стадии — не нарушение: ячейка нейтральная (OS-INSP-3.1.2, T-132) */}
                <div className={`cell ${cur.finding_status === "NEGATIVE_VERIFIED" ? "good" : cur.finding_status === "MISSING_EVIDENCE" || cur.finding_status === "NOT_APPLICABLE" ? "" : "bad"}`}>
                  <span className="label">{isDiff ? "Лист B — стало" : "Фактически"}</span>
                  <b className={valueSize(isDiff ? revOf(cur.actual_value) : cur.actual_value)}>{isDiff ? revOf(cur.actual_value) : cur.actual_value ?? "—"}</b>
                  {cur.delta && <span className="small" style={{ color: isDiff ? "var(--amber-ink)" : "var(--actual-ink)" }}>{isDiff ? cur.delta : `Δ ${cur.delta}`}</span>}
                </div>
              </div>
              {mentions.length > 0 && <StageStrip mentions={mentions} files={d.files} onPick={setPicked} />}
              {detailLoading && <p role="status">Загрузка подробных доказательств…</p>}
              {detailError && <p role="alert">Не удалось загрузить доказательства: {detailError}</p>}
              {!detailLoading && !detailError && mentions.length === 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row">
                  <span className="label">Источники</span>
                  <span style={{ flex: 1 }} />
                  {focus !== null && <button className="btn ghost small" onClick={() => setFocus(null)}>Показать все</button>}
                </div>
                <div className="srcs">
                  {frags.map((f: any, i: number) => (
                    <button key={i} className={`src ${focus === i ? "on" : ""}`} onClick={() => setFocus(focus === i ? null : i)} title={`SHA-256 ${f.sha256 ?? "—"}`}>
                      <span className={`stagetag ${f.stage}`}>{STAGE_RU[f.stage]}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="mono small" style={{ fontWeight: 600 }}>{f.document_code}</span>{" "}
                        <span className="small mute">
                          ред. {f.revision} · {f.approval_status ?? "—"} · стр. {f.sheet_page === null ? "—" : f.sheet_page + (f.page_offset ?? 0)}
                          {f.part_index ? ` (часть ${f.part_index}, стр. ${f.sheet_page})` : ""}
                        </span>

                      </span>
                      <span className="num" style={{ fontWeight: 650, color: f.role_expected_actual === "expected" ? "var(--accent-ink)" : "var(--actual-ink)" }}>{f.extracted_value}</span>
                    </button>
                  ))}
                </div>
              </div>
              )}
              {mentions.length > 0 && <ClassMentions mentions={mentions} picked={picked ? mentionKey(picked) : null} onPick={setPicked} />}
              {/* T-177: что проверено после сравнения — понижение, изменение на листе, каскад, просмотренные документы */}
              <VerifyNotes l8Json={selectedDetail?.l8_json} changeRef={cur.approved_change_ref} derivedFrom={cur.derived_from} />
              {cur.approved_changes?.length > 0 && (
                // OS-INSP-3.1.9, TZA-9.3.1-04: согласованное изменение по параметру — рядом с доказательствами
                <div className="panel panel-body small stack" style={{ gap: 6 }} aria-label="Согласованное изменение">
                  <span className="label">Согласованное изменение</span>
                  {cur.approved_changes.map((a: any) => (
                    <div key={`${a.id}`} className="stack" style={{ gap: 2 }}>
                      <div>
                        <b>№ {a.number}</b> от {a.date.split("-").reverse().join(".")} · <span className="mono">{a.param_codes.join(", ")}</span>
                      </div>
                      {a.description && <div>{a.description}</div>}
                      {a.basis_file_id && (
                        <div>
                          Основание:{" "}
                          <a href="#" onClick={(e) => (e.preventDefault(), download(`/api/v1/files/${a.basis_file_id}/content`, a.basis_file_name ?? "основание").catch((err) => toast(err.message, true)))}>
                            {a.basis_file_name ?? a.basis_file_id}
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                  {!locked && cur.verification_status === "PENDING" && (
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mute">Расхождение может быть согласовано — проверьте основание и снимите с причиной «{dict?.reason_codes?.APPROVED_CHANGE ?? "Есть согласованное изменение"}».</span>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          const a = cur.approved_changes[0];
                          rejectWith("APPROVED_CHANGE", `Согласованное изменение № ${a.number} от ${a.date.split("-").reverse().join(".")}${a.description ? `: ${a.description}` : ""}`);
                        }}
                      >
                        Снять: согласованное изменение
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="row small">
                <Priority p={cur.review_priority} />
                <span className="mute">Риск — только очерёдность проверки, не основание для предписания.</span>
              </div>

              {cur.decision && (
                <div className="panel panel-body small">
                  <div className="row"><VerificationPill status={cur.verification_status} /> {cur.decision.user_name}</div>
                  {cur.decision.reason_code && <div className="mono">{cur.decision.reason_code}</div>}
                  {cur.decision.comment && <div>{cur.decision.comment}</div>}
                </div>
              )}

              {systemOnly ? (
                <div className="panel panel-body small">
                  Это результат системы по параметру, а не кандидат на нарушение: решения инспектора не требуется. Источники и все упоминания — выше, каждое можно открыть на листе.
                </div>
              ) : locked ? (
                <div className="pill gray">{!canWork(session()?.user.role) ? "Просмотр: решения выносят инспектор и супервизор" : `Сводка сверки ${d.inspection.status === "FINALIZED" ? "завершена — решения неизменяемы" : "недоступна для верификации"}`}</div>
              ) : !rejecting ? (
                // три решения равного веса: цвет несёт только точка исхода, а не заливка кнопки —
                // самая яркая кнопка не должна подталкивать к согласию с ИИ
                <div className="decide-row">
                  <button className="btn decide" disabled={busy} onClick={() => decide({ action: "confirm" })}>
                    <span className="dot v" /> Признать <span className="kbd">1</span>
                  </button>
                  <button className="btn decide" disabled={busy} onClick={() => (acts.current++, setRejecting(true))}>
                    <span className="dot n" /> Снять <span className="kbd">2</span>
                  </button>
                  <button className="btn decide" disabled={busy} onClick={() => decide({ action: "clarify" })}>
                    <span className="dot q" /> Уточнить <span className="kbd">3</span>
                  </button>
                </div>
              ) : (
                <div className="stack reasons" style={{ gap: 6 }}>
                  <span className="label">Причина — цифрой или кликом, решение запишется сразу</span>
                  <div className="reason-list">
                    {reasons.map(([k, v], i) => (
                      <button key={k} className={`reason ${reason === k ? "on" : ""}`} disabled={busy} onClick={() => rejectWith(k, v)}>
                        <span className="kbd">{i + 1}</span> {v}
                      </button>
                    ))}
                  </div>
                  <details className="small">
                    <summary className="mute">Свой комментарий к снятию</summary>
                    <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                      <select id="reject-reason" className="input" value={reason} onChange={(e) => (setReason(e.target.value), setComment(String(dict?.reason_codes?.[e.target.value] ?? "")))}>
                        <option value="">Причина…</option>
                        {reasons.map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                      <textarea id="reject-comment" className="input" rows={2} placeholder="Комментарий (обязателен)" value={comment} onChange={(e) => setComment(e.target.value)} />
                      <button className="btn" disabled={!reason || !comment.trim() || busy} onClick={() => rejectWith(reason, comment)}>
                        Снять с комментарием <span className="kbd">Enter</span>
                      </button>
                    </div>
                  </details>
                  <button className="btn ghost" onClick={() => setRejecting(false)}>Назад <span className="kbd">Esc</span></button>
                </div>
              )}
              {!locked && frags.filter((f: any) => f.role_expected_actual === "actual").length > 1 && (
                <button className="btn ghost" onClick={split} title="Составной кандидат — разделить на атомарные findings по источникам">
                  <Icon name="split" size={16} /> Разделить на атомарные
                </button>
              )}
            </section>
          )}

          <div className="tray" aria-label="Решено">
            <span className="t v"><span className="dot v" />признано <b className="num">{queue.filter((c: any) => c.verification_status === "CONFIRMED_VIOLATION").length}</b></span>
            <span className="t n"><span className="dot n" />снято <b className="num">{queue.filter((c: any) => c.verification_status === "NEGATIVE_VERIFIED").length}</b></span>
            <span className="t q"><span className="dot q" />уточнить <b className="num">{queue.filter((c: any) => c.verification_status === "CLARIFICATION_REQUIRED").length}</b></span>
          </div>
          <section className="viewer" aria-label="Листы документов">
            {fan && (
              <div className="fan" role="dialog" aria-label="Общий корень">
                <div className="label">Та же причина</div>
                <h3>
                  Ещё {fan.items.length} {fan.items.length === 1 ? "расхождение" : fan.items.length < 5 ? "расхождения" : "расхождений"} из-за того же документа ({fan.label}). Снять с той же причиной?
                </h3>
                <div className="small mute">Каждое снятие запишется отдельным решением со ссылкой на {fan.code}. Критичные параметры сюда не попадают.</div>
                <div className="fan-list">
                  {fan.items.map((x, i) => (
                    <label key={x.id} className={`fan-item${i === fan.cur ? " cur" : ""}`}>
                      <input
                        type="checkbox"
                        checked={fan.sel.has(x.id)}
                        onChange={() => {
                          const sel = new Set(fan.sel);
                          sel.has(x.id) ? sel.delete(x.id) : sel.add(x.id);
                          setFan({ ...fan, sel, cur: i });
                        }}
                      />
                      <span className="mono small mute">{x.param_code}</span>
                      <span>{x.parameter_name ?? x.param_code}</span>
                      <span className="num small">
                        {x.expected_value ?? "—"} → {x.actual_value ?? "—"}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={applyFan}>
                    Снять отмеченные ({fan.sel.size}) <span className="kbd">Enter</span>
                  </button>
                  <button className="btn" onClick={() => setFan(null)}>
                    Решать по одному <span className="kbd">Esc</span>
                  </button>
                  <span className="small mute">
                    <span className="mono">X</span> — снять отметку · <span className="mono">J K</span> — по списку
                  </span>
                </div>
              </div>
            )}
            {isDiff ? (
              <div className="row small mute">
                <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid var(--accent)", borderRadius: 3 }} /> лист A — было
                <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid var(--actual)", outline: "1.5px solid var(--actual)", outlineOffset: 2, borderRadius: 3, marginLeft: 12 }} /> <span style={{ marginLeft: 4 }}>лист B — стало</span>
                <span style={{ marginLeft: 10 }}>· рамка — одна и та же область после совмещения листов</span>
              </div>
            ) : (
              <div className="row small mute">
                <span className="hl-legend" style={{ display: "inline-block", width: 12, height: 12, border: "2px solid var(--accent)", borderRadius: 3 }} /> по проекту
                <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid var(--actual)", outline: "1.5px solid var(--actual)", outlineOffset: 2, borderRadius: 3, marginLeft: 12 }} /> <span style={{ marginLeft: 4 }}>фактически</span>
              </div>
            )}
            <label className="row small mute" style={{ gap: 6 }}>
              <input id="show-requisites" type="checkbox" checked={showReq} onChange={(e) => setShowReq(e.target.checked)} />
              <span style={{ display: "inline-block", width: 12, height: 12, border: "1.5px dashed var(--green)", borderRadius: 2 }} /> реквизиты на листе (подпись, печать, штампы, дата, рег. номер)
            </label>
            <div className="layout-switch" role="group" aria-label="Раскладка листов">
              {[
                ["side", "Рядом"],
                ["stack", "Стопкой"],
                ["focus", "Крупно"],
              ].map(([k, ru]) => (
                <button key={k} className={`btn small-btn ${layout === k ? "on" : ""}`} onClick={() => (setLayout(k), savePref("verify.layout", k))}>
                  {ru}
                </button>
              ))}
              <span className="small mute">· у листа «⤢ Весь экран» — масштаб и перемещение</span>
            </div>
            <div className={`sheets mode-${layout}`}>
              {[...sheets.values()].map((s) => (s.file ? <Sheet key={`${s.file.id}@${s.page}`} file={s.file} page={s.page} marks={s.marks} value={s.value} showRequisites={showReq} aim whole={whole} /> : null))}
              {!picked &&
                gaps.map((g) => (
                  <div key={g.stage} className="sheet-gap" aria-label={`${STAGE_RU[g.stage]}: значения нет`}>
                    <span>
                      <span className={`stagetag ${g.stage}`}>{STAGE_RU[g.stage]}</span> <span className="small">{g.stage === "PD" ? "проектная" : g.stage === "RD" ? "рабочая" : "исполнительная"} документация</span>
                    </span>
                    <b>{g.docs ? `Показателя нет в ${g.docs} документах стадии` : "Стадия не загружена"}</b>
                    {g.need && <span className="small">Нужен документ: {g.need}</span>}
                    <span className="small mute">{g.docs ? "Сравнить со следующей стадией нельзя — запросите документ" : "В пакете нет ни одного документа этой стадии"}</span>
                  </div>
                ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
