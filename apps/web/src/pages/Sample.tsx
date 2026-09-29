// Совпадения выборкой (T-110; карта сценариев SC-04, ноу-хау Н2). Инспектор проверяет 30 случайных совпадений
// из партии системных «расхождения нет»; если все верны — остальные принимаются одним действием.
// Клавиши по физической клавише: 1 — верно, 2 — ошибка, J/K — следующая/предыдущая, Z — отменить ответ, ⇧Enter — принять.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { STAGE_RU } from "../lib/labels";
import { Loading, useLoad, useToast } from "../components/ui";
import { Sheet, prefetchDocs, type Mark } from "../components/Sheet";

type Ans = "ok" | "err";

const pct = (x: number) => `${(x * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} %`;

export function Sample() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: plan, error, reload } = useLoad(() => api(`/api/v1/inspection/${id}/sample`), [id]);
  const { data: insp } = useLoad(() => api(`/api/v1/inspections/${id}`), [id]);
  const [cur, setCur] = useState(0);
  const [ans, setAns] = useState<Record<string, Ans>>({});
  const [last, setLast] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, any> | null>(null);

  const sample: any[] = plan?.sample ?? [];
  const done = Object.keys(ans).length;
  const errors = Object.entries(ans).filter(([, v]) => v === "err").map(([k]) => k);
  const ready = sample.length > 0 && done === sample.length && errors.length === 0;
  const card = sample[cur];

  const answer = (a: Ans) => {
    if (!card || result) return;
    setAns((m) => ({ ...m, [card.id]: a }));
    setLast((l) => [...l, card.id]);
    const next = sample.findIndex((s, i) => i > cur && !(s.id in ans) && s.id !== card.id);
    if (a === "ok" && next >= 0) setCur(next);
  };

  async function accept() {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const r = await api(`/api/v1/inspection/${id}/sample/accept`, { body: { seed: plan.seed, reviewed: Object.keys(ans), errors } });
      setResult(r);
      if (r.outcome === "BROKEN") toast("Найдена ошибка: партия не принята, проверяйте совпадения по одному");
    } catch (e: any) {
      toast(e.message, true);
      if (/изменился/.test(e.message)) reload();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const c = e.code;
      if (c === "KeyJ" || c === "ArrowDown") setCur((i) => Math.min(i + 1, sample.length - 1));
      else if (c === "KeyK" || c === "ArrowUp") setCur((i) => Math.max(i - 1, 0));
      else if (c === "Digit1" || c === "Numpad1") answer("ok");
      else if (c === "Digit2" || c === "Numpad2") answer("err");
      else if (c === "KeyZ" && last.length && !result) {
        const lastId = last[last.length - 1];
        setAns((m) => {
          const { [lastId]: _drop, ...rest } = m;
          return rest;
        });
        setLast((l) => l.slice(0, -1));
        setCur(sample.findIndex((s) => s.id === lastId));
      } else if ((c === "Enter" || c === "NumpadEnter") && e.shiftKey && ready) accept();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // документы следующих карточек открываются заранее (Прицел)
  useEffect(() => {
    prefetchDocs([...new Set<string>(sample.slice(cur + 1, cur + 4).flatMap((s) => s.fragments.map((f: any) => f.file_id)))]);
  }, [cur, sample]);

  const fileBy = useMemo(() => new Map<string, any>((insp?.files ?? []).map((f: any) => [f.id, f])), [insp]);
  if (!plan || !insp) return <Loading error={error} />;

  const sheets = (card?.fragments ?? [])
    .filter((f: any) => fileBy.get(f.file_id))
    .map((f: any) => ({
      f,
      mark: { bbox: f.bbox_polygon_norm ? JSON.parse(f.bbox_polygon_norm) : null, kind: f.role_expected_actual === "expected" ? "expected" : "actual", label: `${STAGE_RU[f.stage] ?? f.stage}: ${f.extracted_value ?? "—"}` } as Mark,
    }));
  const left = sample.length - done;
  const bound = plan.bound_if_clean as number;

  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <a href="#/inspections">Проверки</a>
          <span>/</span>
          <a href={`#/inspections/${id}`}>{insp.object.name}</a>
          <span>/</span>
          <b>Совпадения выборкой</b>
        </div>
        <div className="grow" />
        <span className="small mute">
          <span className="mono">1</span> верно · <span className="mono">2</span> ошибка · <span className="mono">J K</span> — навигация · <span className="mono">Z</span> — отменить ответ
        </span>
      </header>

      <div className="sample-head">
        <div className="sample-steps">
          <h1>
            {plan.pool_size} {plural(plan.pool_size, "параметр совпал", "параметра совпали", "параметров совпали")} в документах. Проверьте {sample.length} — остальные примете одним действием
          </h1>
          <ol>
            <li>Ниже {sample.length} случайно выбранных совпадений. Справа — фрагменты листов, откуда взяты значения.</li>
            <li>
              Посмотрите на лист и ответьте: <b>верно</b> (<span className="mono">1</span>) или <b>ошибка</b> (<span className="mono">2</span>).
            </li>
            <li>Если все верны — оставшиеся принимаются одной кнопкой. Если есть ошибка — партия не принимается, совпадения проверяются по одному.</li>
          </ol>
          <p className="small mute">Критичные параметры, плохо распознанные значения и кандидаты на оценку сюда не попадают — они всегда проверяются по одному.</p>
        </div>
        <div className="sample-side">
          <div className="sample-count num">
            {done} <span className="mute">из {sample.length}</span>
          </div>
          <div className="sample-meter">
            <i style={{ width: `${sample.length ? (done / sample.length) * 100 : 0}%` }} />
          </div>
          {result?.outcome === "ACCEPTED" ? (
            <div className="small">
              Принято {result.accepted}. Доля ошибок среди непроверенных — не больше {pct(result.upper_bound)} с уверенностью 95 %. Акт приёмки записан.
              <div style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => nav(`/inspections/${id}/verify`)}>К расхождениям на оценку</button>
              </div>
            </div>
          ) : result?.outcome === "BROKEN" ? (
            <div className="small">Найдена ошибка — партия не принята. Проверьте совпадения по одному в сводке сверки.</div>
          ) : (
            <>
              <div className="small">
                {errors.length
                  ? `Отмечена ошибка — принять партию нельзя. Z — отменить ответ.`
                  : left > 0
                    ? `Осталось проверить ${left}.`
                    : `Все ${sample.length} верны: среди остальных ошибок не больше ${pct(bound)} с уверенностью 95 %.`}
              </div>
              <button className="btn primary" disabled={!ready || busy} onClick={accept}>
                Принять остальные {Math.max(plan.pool_size - sample.length, 0)} <span className="kbd">⇧ Enter</span>
              </button>
              {errors.length > 0 && (
                <button className="btn" disabled={busy} onClick={accept}>
                  Записать: партия распалась
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {!sample.length ? (
        <div className="page">
          <div className="panel empty">Совпадений для выборки нет: система не поставила ни одного «расхождения нет» по некритичным параметрам.</div>
        </div>
      ) : (
        <div className="sample-body">
          <aside className="sample-list" aria-label="Выборка">
            {sample.map((s, i) => (
              <button key={s.id} className={`sample-card ${i === cur ? "cur" : ""} ${ans[s.id] ?? ""}`} onClick={() => setCur(i)}>
                <span className="mono small mute">{s.param_code}</span>
                <span className="sample-name">{s.parameter_name ?? s.param_code}</span>
                <span className="num">
                  {s.expected_value ?? "—"} = {s.actual_value ?? s.expected_value ?? "—"}
                </span>
                {ans[s.id] && <span className={`sample-ans ${ans[s.id]}`}>{ans[s.id] === "ok" ? "верно" : "ошибка"}</span>}
              </button>
            ))}
          </aside>
          <section className="viewer sample-viewer" aria-label="Листы совпадения">
            {card && (
              <div className="sample-cur">
                <div>
                  <div className="label">
                    {card.param_code} · {card.section ?? ""}
                  </div>
                  <h2>{card.parameter_name ?? card.param_code}</h2>
                </div>
                <div className="decide-row" style={{ maxWidth: 360 }}>
                  <button className="btn decide" disabled={!!result} onClick={() => answer("ok")}>
                    <span className="dot n" /> Верно <span className="kbd">1</span>
                  </button>
                  <button className="btn decide" disabled={!!result} onClick={() => answer("err")}>
                    <span className="dot v" /> Ошибка <span className="kbd">2</span>
                  </button>
                </div>
              </div>
            )}
            <div className="sheets">
              {sheets.map(({ f, mark }: any, i: number) => (
                <Sheet key={`${card.id}-${i}`} file={fileBy.get(f.file_id)} page={f.sheet_page ?? 1} marks={[mark]} value={f.extracted_value} aim />
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
