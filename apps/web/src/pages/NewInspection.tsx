// Загрузка пакета (OS-INSP-1.1, 1.2): карточка объекта, реестр файлов, файлы ПД/РД/ИД. Дозагрузка — с process_id.
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { Icon, useToast } from "../components/ui";

export function NewInspection() {
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const processId = params.get("process_id");
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<File | null>(null);
  const [card, setCard] = useState({ object_id: "", name: "", address: "", customer: "", contractor: "", permit_number: "" });
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const arr = Array.from(list);
    const m = arr.find((f) => /^manifest|реестр/i.test(f.name) && /\.(json|csv)$/i.test(f.name));
    if (m) setManifest(m);
    setFiles((prev) => [...prev, ...arr.filter((f) => f !== m)]);
  };
  const size = files.reduce((a, f) => a + f.size, 0);

  async function submit() {
    setBusy(true);
    try {
      const form = new FormData();
      if (processId) form.append("process_id", processId);
      else if (card.object_id && card.name) form.append("object", JSON.stringify(card));
      if (manifest) form.append("manifest", manifest, manifest.name);
      for (const f of files) form.append("files", f, f.name);
      const r = await api("/api/v1/documents/upload", { form });
      setResult(r);
      toast(`Принято файлов: ${r.accepted.length}. Проверка ${r.process_id} запущена.`);
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <a href="#/inspections">Проверки</a>
          <span>/</span>
          <b>{processId ? `Дозагрузка в ${processId}` : "Новая проверка"}</b>
        </div>
      </header>
      <div className="page">
        <div className="grid2">
          <div className="panel">
            <div className="panel-head">
              <h2>Файлы пакета</h2>
              <span className="mute small num">
                {files.length} · {(size / 1048576).toFixed(1)} из 200 МБ
              </span>
            </div>
            <div className="panel-body stack">
              <label
                className={`drop ${over ? "over" : ""}`}
                htmlFor="files"
                onDragOver={(e) => (e.preventDefault(), setOver(true))}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => (e.preventDefault(), setOver(false), add(e.dataTransfer.files))}
              >
                <Icon name="upload" size={26} />
                <div style={{ fontWeight: 600, marginTop: 6 }}>Перетащите PDF, DOCX, XML, XLSX, JPG, PNG, TIF и реестр файлов</div>
                <div className="mute small">До 50 МБ на файл и 200 МБ на пакет. Реестр — manifest.json или .csv по Перечню ИД ред. 1.1</div>
                <input id="files" type="file" multiple hidden accept=".pdf,.docx,.xml,.xlsx,.jpg,.jpeg,.png,.tif,.tiff,.json,.csv" onChange={(e) => add(e.target.files)} />
              </label>
              <div className="row small">
                <span className="label">Реестр</span>
                {manifest ? <span className="pill green">{manifest.name}</span> : <span className="pill amber">нет — актуальные редакции не определятся (CLARIFICATION_REQUIRED)</span>}
              </div>
              {files.length > 0 && (
                <table className="rows">
                  <tbody>
                    {files.map((f, i) => (
                      <tr key={i}>
                        <td className="small">
                          <Icon name="file" size={14} /> {f.name}
                        </td>
                        <td className="small mute num" style={{ textAlign: "right" }}>
                          {(f.size / 1024).toFixed(0)} КБ
                        </td>
                        <td style={{ width: 30 }}>
                          <button className="btn ghost" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Убрать">
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          {!processId && (
            <div className="panel">
              <div className="panel-head">
                <h2>Объект капитального строительства</h2>
              </div>
              <div className="panel-body stack">
                <div className="mute small">Если реестр содержит карточку объекта, поля можно не заполнять.</div>
                {(
                  [
                    ["object_id", "Идентификатор объекта / дела"],
                    ["name", "Наименование"],
                    ["address", "Адрес"],
                    ["customer", "Застройщик"],
                    ["contractor", "Подрядчик"],
                    ["permit_number", "Разрешение на строительство"],
                  ] as const
                ).map(([k, l]) => (
                  <label key={k} className="stack" style={{ gap: 4 }} htmlFor={`card-${k}`}>
                    <span className="label">{l}</span>
                    <input id={`card-${k}`} className="input" value={card[k]} onChange={(e) => setCard({ ...card, [k]: e.target.value })} />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy || !files.length} onClick={submit}>
            {busy ? "Загружаем…" : processId ? "Дозагрузить и пересчитать" : "Загрузить и начать проверку"}
          </button>
          <span className="mute small">Разбор идёт асинхронно: статус виден на карточке проверки.</span>
        </div>
        {result && (
          <div className="panel">
            <div className="panel-head">
              <h2>Результат приёма</h2>
              <span className="mono small">{result.process_id}</span>
              <div className="grow" style={{ flex: 1 }} />
              <button className="btn primary" onClick={() => nav(`/inspections/${result.process_id}`)}>
                Открыть проверку
              </button>
            </div>
            <div className="panel-body stack">
              {result.clarification && <span className="pill blue">{result.clarification}</span>}
              {result.accepted.map((a: any) => (
                <div key={a.file_id} className="row small">
                  <span className="pill green">принят</span> {a.file_name} <span className="mono mute">{a.sha256.slice(0, 16)}…</span>
                </div>
              ))}
              {result.rejected.map((r: any, i: number) => (
                <div key={i} className="row small">
                  <span className="pill red">{r.code}</span> {r.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
