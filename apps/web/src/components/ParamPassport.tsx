// Паспорт параметра Матрицы (DLG-INSP-22, OS-INSP-7.1.3–7.1.6): что проверяем, атрибуты единого вида,
// метрики единого вида, порядок и алгоритм расчёта (общие этапы + шаги параметра), исходы и автоматическая верификация.
// Только чтение: пороги меняются в строке Матрицы (DLG-INSP-10).
import { useEffect, useRef, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import { FINDING, STAGE_RU, VERIFY_FIELD_RU, verifyValue } from "../lib/labels";
import { FindingPill, Loading, Pill, Priority, useLoad } from "./ui";

type Op = { id: string; title: string };
type Stage = { key: string; n: string; title: string; ops: Op[]; how: string; fail: string; param_specific: boolean };
type Source = { discipline: string; label: string };
type Metric = { key: string; title: string; how: string; value: string; rows?: { label: string; value: string }[] };
type Verification = { verdict: "MATCH" | "MISMATCH"; object_id: string; checked_at: string; fields: { field: string; system: string | null; oracle: string | null; ok: boolean; equivalent?: boolean }[] };

type Passport = {
  version: string;
  title: string;
  summary: string;
  basis: string;
  // T-132: у количественного паспорта (М-001) вместо шкалы — единица и допуск
  value: { kind: string; scale?: string[]; order_note?: string; constraint_markers?: string[]; unit?: string; tolerance_abs?: number; tolerance_note?: string; count_note?: string; tolerance_pp?: number; composition_note?: string; tolerance_pct?: number; docs?: Array<{ id: string; title: string }>; aspects?: Record<string, string>; terms?: Record<string, { title: string; parent?: string | null }> }; // T-212: presence и method
  sources: Record<"PD" | "RD" | "ID", Source[]>;
  link: { by: string; note: string } | null;
  outcomes: { when: string; status: string; why: string }[];
};
type PassportResponse = {
  code: string;
  param: any;
  passport: Passport | null;
  stages: Stage[];
  statuses: Record<string, string>;
  metrics: Metric[];
  verification: Verification | null;
};

const DATA_TYPE_RU: Record<string, string> = { number: "число", string: "текст", enum: "значение из перечня" };
const VALUE_KIND_RU: Record<string, string> = { ordinal: "порядковая шкала", quantity: "число с единицей измерения", count: "количество — целое число", composition: "состав по типам (доли)", number: "число", text: "текст", enum: "значение из перечня", schedule: "календарный график: этапы и длительности", doc_requirements: "перечень документов ИД и сечения", direction: "направление открывания: наружу или внутрь", presence: "мероприятие: есть или исключено", method: "метод по словарю" };
// служебные пометки, которые встречаются в описаниях этапов, но не являются статусами находки
const EXTRA_RU: Record<string, string> = { LOW_QUALITY: "низкое качество" };

/** Коды статусов в тексте этапов → слова инспектора в «ёлочках». Неизвестные аббревиатуры (PDF, OCR) не трогаем. */
export function humanize(text: string): string {
  return text.replace(/\b[A-Z][A-Z_]{2,}\b/g, (c) => {
    const ru = FINDING[c]?.ru ?? EXTRA_RU[c];
    return ru ? `«${ru}»` : c;
  });
}

function compareOf(p: any): any {
  if (p?.compare && typeof p.compare === "object") return p.compare;
  try {
    return JSON.parse(p?.compare_json ?? "{}");
  } catch {
    return {};
  }
}

function ruleText(p: any, kindRu: Record<string, string>): string {
  const cmp = compareOf(p);
  const thr = cmp.kind === "min" ? cmp.min ?? p.min_value : cmp.kind === "max" ? cmp.max ?? p.max_value : cmp.kind === "delta_pct" ? cmp.tolerance : undefined;
  const base = kindRu[cmp.kind] ?? "правило не задано";
  return thr !== undefined && thr !== null && thr !== "" ? `${base} ${thr}` : base;
}

/** Шкала: порядковая — цепочка от худшего к лучшему с пометкой лучшего; иначе — словами. */
function Scale({ scale, note }: { scale: unknown; note?: string }) {
  if (Array.isArray(scale) && scale.length) {
    return (
      <>
        <span className="pp-scale">
          {scale.map((s, i) => (
            <span key={String(s)}>
              {i > 0 && <span className="pp-arrow" aria-hidden="true">→</span>}
              <b className={i === scale.length - 1 ? "best" : undefined}>{String(s)}</b>
            </span>
          ))}
          <span className="small mute"> · лучший — {String(scale[scale.length - 1])}</span>
        </span>
        {note && <div className="small mute">{note}</div>}
      </>
    );
  }
  if (scale === "numeric_suffix") return <>число с буквенным обозначением</>;
  if (typeof scale === "string" && scale) return <>{scale}</>;
  return <span className="mute">без шкалы</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pp-sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ParamPassport({ code, row, kindRu, onClose }: { code: string; row?: any; kindRu: Record<string, string>; onClose: () => void }) {
  const { data, error } = useLoad<PassportResponse | { notFound: true }>(
    () =>
      api<PassportResponse>(`/api/v1/params/${encodeURIComponent(code)}/passport`).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return { notFound: true as const };
        throw e;
      }),
    [code],
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  // фокус — на панель, чтобы Esc и Tab работали сразу после открытия (не автодействие: панель открыта явным кликом или адресом)
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), [code]);

  const p = data && !("notFound" in data) ? data.param : row;
  const head = (
    <header className="pp-head">
      <div className="pp-title">
        <span className="mono pp-code">{code}</span>
        <h2>{p?.parameter_name ?? "Паспорт параметра"}</h2>
        {p && (
          <div className="row small mute" style={{ gap: 8 }}>
            <span>Раздел {p.section}</span>
            <Priority p={p.review_priority} />
            {p.is_active === false || p.is_active === 0 ? <Pill tone="gray">не активен</Pill> : null}
          </div>
        )}
      </div>
      <button ref={closeRef} className="btn ghost" onClick={onClose} aria-label="Закрыть паспорт">
        Закрыть <span className="kbd">Esc</span>
      </button>
    </header>
  );

  let body: ReactNode;
  if (!data) body = <Loading error={error} />;
  else if ("notFound" in data) body = <div className="empty">Параметр не найден. Проверьте код в адресе или выберите параметр в таблице.</div>;
  else body = <PassportBody d={data} kindRu={kindRu} />;

  return (
    <aside id="param-passport" className="panel pp" role="region" aria-label="Паспорт параметра">
      {head}
      {body}
    </aside>
  );
}

function PassportBody({ d, kindRu }: { d: PassportResponse; kindRu: Record<string, string> }) {
  const { param: p, passport: pp, stages, statuses, metrics, verification: v } = d;
  const scale = pp?.value.scale?.length ? pp.value.scale : p.value_scale;
  const valueKind = pp?.value.kind ? VALUE_KIND_RU[pp.value.kind] ?? pp.value.kind : DATA_TYPE_RU[p.data_type] ?? p.data_type;
  const attrs: [string, ReactNode][] = [
    ["Единица", p.unit || <span className="mute">—</span>],
    ["Тип значения", valueKind],
    pp?.value.kind === "quantity"
      ? [
          "Допуск",
          <>
            ±{String(pp.value.tolerance_abs).replace(".", ",")} {pp.value.unit}
            {pp.value.tolerance_note && <div className="small mute">{pp.value.tolerance_note}</div>}
          </>,
        ]
      : pp?.value.kind === "composition"
        ? ["Допуск", <>доля типа ±{String(pp.value.tolerance_pp ?? 0).replace(".", ",")} п.п.; новый или исчезнувший тип — всегда кандидат{pp.value.composition_note && <div className="small mute">{pp.value.composition_note}</div>}</>]
        : pp?.value.kind === "count"
        ? ["Допуск", <>без допуска — любое изменение количества{pp.value.count_note && <div className="small mute">{pp.value.count_note}</div>}</>]
      : pp?.value.kind === "schedule"
        ? [
            "Порог",
            <>
              +{String(pp.value.tolerance_pct).replace(".", ",")} % к длительности этапа ПД
              {pp.value.tolerance_note && <div className="small mute">{pp.value.tolerance_note}</div>}
            </>,
          ]
        : pp?.value.kind === "doc_requirements"
          ? ["Документы ИД", <>{(pp.value.docs ?? []).map((x) => x.title).join("; ")}</>]
          : pp?.value.aspects
            ? [pp.value.terms ? "Словарь методов" : "Аспекты", <span>{Object.values(pp.value.terms ?? pp.value.aspects).map((x) => (typeof x === "string" ? x : x.title)).join(" · ")}</span>]
            : ["Шкала", <Scale scale={scale} note={pp?.value.order_note} />],
    [
      "Правило сравнения",
      <>
        {ruleText(p, kindRu)}
        {pp?.value.constraint_markers?.length ? <div className="small mute">ограничение, а не точное значение: «{pp.value.constraint_markers.join("», «")}»</div> : null}
      </>,
    ],
    ["Триггер Матрицы", p.trigger_logic || <span className="mute">—</span>],
    ["Источник ПД", p.source_pd || <span className="mute">не указан</span>],
    ["Источник РД", p.source_rd || <span className="mute">не указан</span>],
    ["Источник ИД", p.source_id || <span className="mute">не указан</span>],
    [
      "Приоритет источников",
      pp ? (
        <div className="pp-prio">
          {(["PD", "RD", "ID"] as const).map((st) =>
            pp.sources[st]?.length ? (
              <div key={st}>
                <b>{STAGE_RU[st]}</b>
                <ol>
                  {pp.sources[st].map((s, i) => (
                    <li key={i}>
                      {s.discipline !== "*" && <span className="mono">{s.discipline}</span>} {s.label}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null,
          )}
        </div>
      ) : (
        <span className="mute">не описан</span>
      ),
    ],
    ["Связь комплектов", pp?.link?.note || <span className="mute">не описана</span>],
    ["Нормативное основание", pp?.basis || p.sp_reference || <span className="mute">не указано</span>],
    // ТЗ §10 Params (T-234): ссылки на СП, ГОСТ и ФЗ — колонки Матрицы, правит администратор
    ["Своды правил (СП)", p.sp_reference || <span className="mute">не применяются</span>],
    ["ГОСТ", p.gost_reference || <span className="mute">не применяются</span>],
    ["Федеральные законы", p.fz_reference || <span className="mute">не применяются</span>],
    ...(p.other_normative ? [["Иные акты", p.other_normative] as [string, ReactNode]] : []),
  ];

  return (
    <div className="pp-body">
      <Section title="Что проверяем">
        {pp ? (
          <>
            <p className="pp-summary">{pp.summary}</p>
            <p className="small mute">Основание: {pp.basis}</p>
          </>
        ) : (
          <p className="pp-summary">{p.trigger_logic}</p>
        )}
      </Section>

      <Section title="Атрибуты параметра">
        <table className="pp-kv">
          <tbody>
            {attrs.map(([k, val]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{val}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Метрики параметра">
        {metrics.length ? (
          <table className="pp-kv pp-metrics">
            <tbody>
              {metrics.map((m) => (
                <MetricRows key={m.key} m={m} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="small mute">Метрик пока нет.</p>
        )}
      </Section>

      <Section title="Порядок и алгоритм расчёта">
        {!pp && <p className="pp-note">Шаги сравнения для этого параметра ещё не описаны — ниже общие этапы, одинаковые для всех параметров.</p>}
        <ol className="pp-stages">
          {stages.map((s) => (
            <li key={s.key} className={s.param_specific ? "own" : undefined}>
              <span className="pp-n num" title="Уровень этапа">{s.n}</span>
              <div className="pp-stage">
                <div className="row" style={{ gap: 8 }}>
                  <b>{s.title}</b>
                  {s.param_specific && <span className="pp-own">особое для этого параметра</span>}
                </div>
                <p>{humanize(s.how)}</p>
                {s.fail && s.fail !== "—" && (
                  <p className="small">
                    <span className="mute">При сбое:</span> {humanize(s.fail)}
                  </p>
                )}
                {s.ops.length > 0 && (
                  <p className="pp-ops small mute">
                    операции каталога:{" "}
                    {s.ops.map((o, i) => (
                      <span key={o.id}>
                        {i > 0 && " · "}
                        <abbr className="mono" title={o.title}>{o.id}</abbr>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {pp && pp.outcomes.length > 0 && (
        <Section title="Исходы">
          <table className="rows pp-out">
            <thead>
              <tr><th>Ситуация</th><th>Статус системы</th><th>Почему</th></tr>
            </thead>
            <tbody>
              {pp.outcomes.map((o, i) => (
                <tr key={i}>
                  <td>{o.when}</td>
                  <td title={statuses[o.status] ?? FINDING[o.status]?.ru}><FindingPill status={o.status} /></td>
                  <td className="small">{o.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {v && (
        <Section title="Автоматическая верификация">
          <div className="row small" style={{ gap: 8, marginBottom: 8 }}>
            {v.verdict === "MATCH" ? <Pill tone="green">совпало</Pill> : <Pill tone="amber">расхождение</Pill>}
            <span>объект <span className="mono">{v.object_id}</span></span>
            <span className="mute">· {fmtDate(v.checked_at)}</span>
          </div>
          <table className="rows pp-out">
            <thead>
              <tr><th>Поле</th><th>Система</th><th>Независимый пересчёт</th><th /></tr>
            </thead>
            <tbody>
              {v.fields.map((f) => (
                <tr key={f.field}>
                  <td>{VERIFY_FIELD_RU[f.field] ?? f.field}</td>
                  <td className="mono">{verifyValue(f.field, f.system)}</td>
                  <td className="mono">{verifyValue(f.field, f.oracle)}</td>
                  {/* «равноценно»: другой лист с тем же классом того же раздела — указатели разные, доказательство то же */}
                  <td>{!f.ok ? <span className="pp-bad">расхождение</span> : f.equivalent ? <span className="pp-ok" title="другой лист с тем же классом того же раздела">равноценно</span> : <span className="pp-ok">совпало</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function MetricRows({ m }: { m: Metric }) {
  return (
    <>
      <tr>
        <th scope="row">
          {m.title}
          <div className="small mute pp-how">{m.how}</div>
        </th>
        <td className="num">{m.value}</td>
      </tr>
      {m.rows?.map((r) => (
        <tr key={r.label} className="sub">
          <th scope="row">{FINDING[r.label]?.ru ?? EXTRA_RU[r.label] ?? r.label}</th>
          <td className="num">{r.value}</td>
        </tr>
      ))}
    </>
  );
}
