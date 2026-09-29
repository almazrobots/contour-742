// Раздел «Файлы»: все обработанные файлы постранично, у каждого — извлечённые параметры (по клику на строку).
import { Fragment, useRef, useState } from "react";
import { api } from "../lib/api";
import { fmtDate } from "../lib/labels";
import { Loading, useLoad } from "../components/ui";

const SIZE = 25;
const FIRST = 5; // сколько упоминаний показываем сразу
const MORE = 20; // и сколько добавляет кнопка «показать ещё»
const STATUS_RU: Record<string, string> = { DONE: "Обработан", FAILED: "Не удалось прочитать", PENDING: "В очереди", RUNNING: "В работе" };

export function Files() {
  const [pageNo, setPageNo] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const qs = `limit=${SIZE}&offset=${pageNo * SIZE}${q ? `&q=${encodeURIComponent(q)}` : ""}${status ? `&status=${status}` : ""}`;
  const { data, error, loading: listLoading, reload } = useLoad(() => api<any>(`/api/v1/files?${qs}`), [qs]);
  const pages = data ? Math.max(1, Math.ceil(data.total / SIZE)) : 1;
  return (
    <>
      <header className="topbar">
        <div className="crumbs"><b>Файлы</b>{data && <span className="mute"> · всего {data.total}</span>}</div>
        <div className="grow" />
        <input className="input" placeholder="Имя файла или шифр" value={q} aria-label="Поиск" onChange={(e) => { setQ(e.target.value); setPageNo(0); }} />
        <select className="input" value={status} aria-label="Состояние" onChange={(e) => { setStatus(e.target.value); setPageNo(0); }}>
          <option value="">Все состояния</option>
          {Object.entries(STATUS_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </header>
      <div className="page">
        <p className="mute">Рабочие документы и найденные в них значения. Откройте файл, затем параметр, чтобы проверить строки источника.</p>
        {error && data && <p role="alert">Не удалось обновить список: {error} <button className="btn" onClick={reload}>Повторить</button></p>}
        <div className="panel scroll-x" aria-busy={listLoading}>
          {!data ? <Loading error={error} /> : !data.items.length ? <p className="mute">Файлов не найдено.</p> : (
            <table className="rows">
              <thead><tr><th>Файл</th><th>Объект</th><th>Тип</th><th>Листов</th><th>Состояние</th><th>Загружен</th><th>Найдено</th></tr></thead>
              <tbody>
                {data.items.map((f: any) => (
                  <Fragment key={f.id}>
                    <tr>
                      <td style={{ minWidth: 220, maxWidth: 440, overflowWrap: "anywhere" }}><button className="btn" style={{ textAlign: "left", whiteSpace: "normal", width: "100%" }} aria-expanded={open === f.id} aria-controls={open === f.id ? `file-details-${f.id}` : undefined} onClick={() => setOpen(open === f.id ? null : f.id)}>{open === f.id ? "▾" : "▸"} {f.file_name}</button><div className="mono mute small" style={{ marginTop: 6 }}>{f.document_code || "Шифр не указан"}</div></td>
                      <td className="small">{f.object_name ?? f.object_id}</td>
                      <td className="small">{f.doc_type ?? "—"}{f.stage && <div className="mute">{f.stage}</div>}</td>
                      <td>{f.pages}</td>
                      <td className="small">{STATUS_RU[f.parse_status] ?? f.parse_status}{f.parse_error && <div className="mute">{f.parse_error}</div>}</td>
                      <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtDate(f.uploaded_at)}</td>
                      <td>{f.mentions}</td>
                    </tr>
                    {open === f.id && (
                      <tr>
                        <td colSpan={7} id={`file-details-${f.id}`}>
                          <FileParams fileId={f.id} params={f.params} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="row" style={{ justifyContent: "center", gap: 12, marginTop: 12 }}>
          <button className="btn" disabled={listLoading || pageNo === 0} onClick={() => setPageNo(pageNo - 1)}>Назад</button>
          <span className="mute" role="status">Страница {pageNo + 1} из {pages}</span>
          <button className="btn" disabled={listLoading || pageNo + 1 >= pages} onClick={() => setPageNo(pageNo + 1)}>Вперёд</button>
        </div>
      </div>
    </>
  );
}

function ruCount(n: number, one: string, few: string, many: string) {
  const m = n % 100, d = n % 10;
  return `${n} ${m >= 11 && m <= 14 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many}`;
}

// Раскрытие файла: параметры по группам; упоминания группы подгружаются по клику и дальше по 20
function FileParams({ fileId, params }: { fileId: string; params: any[] }) {
  const [showService, setShowService] = useState(false);
  if (!params.length) return <span className="mute">Параметры не найдены.</span>;
  const matrix = params.filter((p) => p.in_matrix).sort((a, b) => b.mentions - a.mentions || a.param_code.localeCompare(b.param_code));
  const service = params.filter((p) => !p.in_matrix).sort((a, b) => b.mentions - a.mentions || a.param_code.localeCompare(b.param_code));
  return (
    <div>
      {matrix.map((p) => <ParamGroup key={p.param_code} fileId={fileId} p={p} />)}
      {service.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => setShowService(!showService)}>
            {showService ? "Скрыть" : "Показать"} служебные факты ({service.length})
          </button>
          <span className="mute small"> — сведения, которых нет в Матрице параметров</span>
          {showService && service.map((p) => <ParamGroup key={p.param_code} fileId={fileId} p={p} />)}
        </div>
      )}
    </div>
  );
}

function ParamGroup({ fileId, p }: { fileId: string; p: any }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(p.mentions);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loading = useRef(false);
  const load = async (limit: number) => {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<any>(`/api/v1/files/${encodeURIComponent(fileId)}/params?param=${encodeURIComponent(p.param_code)}&limit=${limit}&offset=${items.length}`);
      setItems((cur) => [...cur, ...r.items]);
      setTotal(r.total);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      loading.current = false;
      setBusy(false);
    }
  };
  const toggle = () => {
    if (!open && !items.length) void load(FIRST);
    setOpen(!open);
  };
  const rest = total - items.length;
  return (
    <div style={{ borderBottom: "1px solid var(--line, #e3e3e3)", padding: "6px 0" }}>
      <button type="button" className="btn" aria-expanded={open} onClick={toggle} style={{ width: "100%", textAlign: "left", display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span>{open ? "▾" : "▸"}</span>
        <b>{p.name ?? p.param_code}</b>
        <span className="mono mute small">{p.param_code}</span>
        {p.section && <span className="mute small">{p.section}</span>}
        <span className="mute small">
          найдено {ruCount(p.mentions, "раз", "раза", "раз")}, {ruCount(p.distinct_values, "значение", "значения", "значений")}
        </span>
      </button>
      {open && (
        <div style={{ paddingLeft: 24 }}>
          {err && <div className="mute">Не удалось загрузить: {err} <button className="btn" disabled={busy} onClick={() => void load(items.length ? MORE : FIRST)}>Повторить</button></div>}
          {items.length > 0 && (
            <table className="rows">
              <thead><tr><th>Найдено</th><th>Лист</th><th>Строка документа</th></tr></thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{m.raw ?? m.value_text ?? m.value_num ?? "—"}</td>
                    <td>{m.page ?? "—"}</td>
                    <td className="small">{m.line_text ?? <span className="mute">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {busy && <span className="mute small">Загрузка…</span>}
          {!busy && rest > 0 && items.length > 0 && (
            <button className="btn" onClick={() => void load(MORE)}>Показать ещё {Math.min(MORE, rest)} (осталось {rest})</button>
          )}
        </div>
      )}
    </div>
  );
}
