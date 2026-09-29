// Лист документа с выделенной доказательной областью (OS-INSP-4.1.1).
// bbox приходит в долях [0;1] видимой страницы (после CropBox и Rotate) — pdf.js рисует ту же видимую область,
// поэтому рамка накладывается прямым умножением на размер холста.
import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, fileBytes, session } from "../lib/api";
import { aimWindow, renderScale, toLocal, type Box as AimBox } from "../lib/aim";
import { pct, REQUISITE_RU, REVISION_RU, STAGE_RU } from "../lib/labels";

pdfjs.GlobalWorkerOptions.workerSrc = worker;

// Прицел (T-106): открытый документ pdf.js кэшируется — переход к следующему кандидату не разбирает PDF заново.
// LRU на 12 документов: в очереди верификации 3 стадии × несколько соседних кандидатов.
const DOC_LIMIT = 64; // T-133: вкладка «Документы» прогревает весь пакет (57 файлов «Алтуфьево»); документ с листом по кускам — немного памяти
const docs = new Map<string, Promise<pdfjs.PDFDocumentProxy>>();
function doc(id: string): Promise<pdfjs.PDFDocumentProxy> {
  const hit = docs.get(id);
  if (hit) {
    docs.delete(id);
    docs.set(id, hit); // свежий — в конец очереди вытеснения
    return hit;
  }
  // T-133: по адресу и кусками (Range) — чертёж на 40 МБ не качается целиком ради одного листа; без автодокачки
  const token = session()?.token;
  const p = pdfjs.getDocument({
    url: `/api/v1/files/${id}/content`, httpHeaders: token ? { authorization: `Bearer ${token}` } : {},
    rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true, isEvalSupported: false,
  }).promise;
  p.catch(() => docs.delete(id)); // сбой не залипает в кэше
  docs.set(id, p);
  while (docs.size > DOC_LIMIT) {
    const [old, op] = docs.entries().next().value!;
    docs.delete(old);
    op.then((d) => d.destroy()).catch(() => {});
  }
  return p;
}

// T-133: фоновая подгрузка пакета на вкладке «Документы» — по порядку, по два документа за раз: открыть PDF и взять
// первый лист (куски по Range), заодно прогреть кэш сервера. Открытый инспектором документ идёт вне очереди — его
// грузит сам просмотр; уход с вкладки останавливает очередь.
export function prefetchQueue(fileIds: string[], concurrency = 2): { cancel: () => void } {
  const queue = [...fileIds];
  let stopped = false;
  const worker = async () => {
    while (!stopped && queue.length) {
      const id = queue.shift()!;
      if (docs.has(id)) continue;
      await doc(id).then((d) => d.getPage(1)).catch(() => {});
    }
  };
  for (let i = 0; i < concurrency; i++) void worker();
  return { cancel: () => { stopped = true; } };
}

/** Заранее открыть документы следующих кандидатов — пока инспектор решает текущего. */
export function prefetchDocs(fileIds: string[]) {
  for (const id of fileIds) doc(id).catch(() => {});
}

export interface Mark {
  bbox: [number, number, number, number] | null;
  kind: "expected" | "actual" | "anchor"; // anchor — подпись показателя рядом со значением (T-132)
  label: string;
  /** diff — область изменения листа между редакциями (OS-INSP-3.4): лист A «было», лист B «стало» */
  tone?: "diff";
}

type Box = [number, number, number, number];

/** OS-INSP-2.3: реквизит, найденный на странице файла (GET /inspections/:id → files[].requisites). */
export interface Requisite {
  kind: string;
  page: number;
  bbox: Box | null;
  confidence: number;
}

/** OS-INSP-2.4: ответ GET /files/:id/measure — масштаб по размерным линиям и расстояния в мм. */
export interface Measure {
  status: "OK" | "NOT_COMPARABLE";
  method: "dimension_line" | "none" | "inconsistent" | "stamp_mismatch";
  mm_per_px: number | null;
  sheet_scale?: number | null; // N из 1:N, измеренный (OS-INSP-2.4.6)
  sheet_scale_gost?: number | null; // N по ряду ГОСТ 2.302 — для показа
  stamp_scale?: number | null; // N из штампа листа
  dimension_lines: Array<{ label: string; mm: number; px: number; mm_per_px: number; line_bbox: Box; label_bbox: Box; orientation?: Orientation; line?: Box }>;
  distances: Array<{ mm: number; m?: number; axis: "x" | "y" | "n"; orientation?: Orientation; a_bbox: Box; b_bbox: Box; a_pt?: [number, number]; b_pt?: [number, number] }>;
}

type Orientation = "horizontal" | "vertical" | "oblique";

export interface SheetProps {
  file: { id: string; file_name: string; kind: string; doc_stage: string; document_code: string; revision: string; approval_status: string | null; revision_role: string | null; requisites?: Requisite[] };
  page: number;
  marks: Mark[];
  value?: string | null;
  /** рамки реквизитов поверх листа (по умолчанию — да) */
  showRequisites?: boolean;
  /** Прицел: открыть лист на фрагменте вокруг рамок (экран верификации). Без него — лист целиком */
  aim?: boolean;
  /** весь лист вместо окна прицела (удержание Space) */
  whole?: boolean;
}

/** Почему измерение невозможно — языком инспектора (OS-INSP-2.4.3). */
export function notComparableText(m: Pick<Measure, "method">): string {
  if (m.method === "stamp_mismatch")
    return "Масштаб листа, измеренный по размерам, расходится с масштабом в штампе больше чем на 2 %. Расстояния не измерялись — результат «Несопоставимо».";
  return m.method === "inconsistent"
    ? "Масштаб противоречив: размерные линии листа дают разный масштаб. Расстояния не измерялись — результат «Несопоставимо»."
    : "Масштаб не определён: на листе не найдено размерных линий с числовой подписью. Расстояния не измерялись — результат «Несопоставимо».";
}

const mm = (x: number) => `${x.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} мм`;
const dist = (d: Measure["distances"][number]) => `${mm(d.mm)}${d.m != null ? ` (${d.m.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} м)` : ""}`;
const ARROW = { x: "↔", y: "↕", n: "⤢" } as const;

export function Sheet({ file, page, marks, value, showRequisites = true, aim = false, whole = false }: SheetProps) {
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [full, setFull] = useState(false); // T-132: лист на весь экран — масштаб и перемещение по документу
  const [mErr, setMErr] = useState<string | null>(null);
  const [mBusy, setMBusy] = useState(false);
  useEffect(() => {
    setMeasure(null);
    setMErr(null);
  }, [file.id, page]);
  const reqs = showRequisites ? (file.requisites ?? []).filter((r) => r.page === page && r.bbox) : [];

  async function runMeasure() {
    if (measure) return setMeasure(null); // повторное нажатие — убрать измерения с листа
    setMBusy(true);
    setMErr(null);
    try {
      setMeasure(await api<Measure>(`/api/v1/files/${file.id}/measure?page=${page}`));
    } catch (e: any) {
      setMErr(e.message);
    } finally {
      setMBusy(false);
    }
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <span className={`stagetag ${file.doc_stage}`} style={{ width: 28 }}>
          {STAGE_RU[file.doc_stage]}
        </span>
        <span className="mono" style={{ fontWeight: 600 }}>
          {file.document_code}
        </span>
        <span className="mute">ред. {file.revision}</span>
        <span className="mute">· стр. {page}</span>
        {file.kind === "pdf" && aim && !measure && marks.some((m) => m.bbox) && <span className="aim-hint">{whole ? "весь лист" : "фрагмент · Space — весь лист"}</span>}
        <span style={{ flex: 1 }} />
        {file.kind === "pdf" && (
          <button className={`btn small-btn ${measure ? "on" : ""}`} disabled={mBusy} onClick={runMeasure} title="Масштаб по размерным линиям и расстояния в мм (OS-INSP-2.4)">
            {mBusy ? "Измеряю…" : measure ? "Скрыть измерения" : "Измерить"}
          </button>
        )}
        {file.kind === "pdf" && (
          <button className="btn small-btn" onClick={() => setFull(true)} title="Открыть лист на весь экран: колесо — масштаб, перетаскивание — перемещение, Esc — закрыть">
            ⤢ Весь экран
          </button>
        )}
        <span className={`pill ${file.revision_role === "CURRENT" ? "green" : file.revision_role === "CONFLICT" || file.revision_role === "UNRESOLVED" ? "blue" : "gray"}`}>
          {REVISION_RU[file.revision_role ?? ""] ?? file.approval_status ?? "—"}
        </span>
      </div>
      {full && <SheetViewer file={file} page={page} marks={marks} requisites={reqs} onClose={() => setFull(false)} />}
      {file.kind === "pdf" ? <PdfPage fileId={file.id} page={page} marks={marks} requisites={reqs} measure={measure?.status === "OK" ? measure : null} whole={!aim || whole || !!measure} /> : <Structured fileId={file.id} value={value} />}
      {(measure || mErr) && (
        <div className="measure-note" role="status">
          {mErr ? (
            <span className="err-text">Измерение не выполнено: {mErr}</span>
          ) : measure!.status === "OK" ? (
            <>
              <div className="row" style={{ gap: 6 }}>
                <span className="pill blue">Масштаб определён</span>
                <span className="num">1 px ≈ {measure!.mm_per_px?.toFixed(2)} мм</span>
                {measure!.sheet_scale_gost ? (
                  <span className="num" title={`Измерено 1:${measure!.sheet_scale}${measure!.stamp_scale ? `, в штампе 1:${measure!.stamp_scale}` : ", в штампе не указан"}`}>
                    · М 1:{measure!.sheet_scale_gost.toLocaleString("ru-RU")}
                  </span>
                ) : null}
                <span className="mute">· по {measure!.dimension_lines.length} размерн. линиям: {measure!.dimension_lines.map((d) => d.label).join(", ")}</span>
              </div>
              {measure!.distances.length ? (
                <div className="mute">
                  Измерено расстояний: {measure!.distances.length} — {measure!.distances.map((d) => `${ARROW[d.axis] ?? "↔"} ${dist(d)}`).join(" · ")}
                </div>
              ) : (
                <div className="mute">Параллельных линий для измерения не найдено.</div>
              )}
            </>
          ) : (
            <div className="row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
              <span className="pill blue">Несопоставимо</span>
              <span>{notComparableText(measure!)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PdfPage({ fileId, page, marks, requisites = [], measure = null, whole = false }: { fileId: string; page: number; marks: Mark[]; requisites?: Requisite[]; measure?: Measure | null; whole?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // окно прицела: рамки листа с полем; пропорция 4:3 в миллиметрах листа. null — лист целиком
  const [win, setWin] = useState<AimBox | null>(null);
  const boxKey = marks.map((m) => m.bbox?.join(",")).join("|");
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;
    setReady(false);
    (async () => {
      try {
        const p = await (await doc(fileId)).getPage(page);
        const base = p.getViewport({ scale: 1 }); // видимая страница после CropBox и Rotate, в pt
        // окно прицела не уже 130 мм листа: на A4 доля 0,22 давала ~46 мм и гигантский шрифт, на A1 — те же 0,22 (T-132)
        const widthMm = (base.width * 25.4) / 72;
        const w = whole ? null : aimWindow(marks.map((m) => m.bbox), { aspect: (4 / 3) * (base.height / base.width), lead: 4, minW: Math.min(1, Math.max(0.22, 130 / widthMm)) });
        const c = canvas.current;
        const box = wrap.current;
        if (!c || !box || cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const target = Math.max(box.clientWidth, 240) * dpr;
        const scale = renderScale(base.width, w ? w[2] - w[0] : 1, target);
        // рендер только окна: сдвиг вьюпорта на левый верхний угол окна, холст — размером окна
        const vp = p.getViewport({ scale, offsetX: w ? -w[0] * base.width * scale : 0, offsetY: w ? -w[1] * base.height * scale : 0 });
        c.width = Math.round((w ? w[2] - w[0] : 1) * base.width * scale);
        c.height = Math.round((w ? w[3] - w[1] : 1) * base.height * scale);
        task = p.render({ canvasContext: c.getContext("2d")!, viewport: vp });
        await task.promise;
        if (!cancelled) {
          setWin(w);
          setReady(true);
        }
      } catch (e: any) {
        if (!cancelled && e?.name !== "RenderingCancelledException") setErr(e.message);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [fileId, page, whole, boxKey]);
  if (err) return <div className="empty">Лист не отрисован: {err}</div>;
  // рамка листа → доли показанного окна; вне окна — не рисуем
  const place = (b: Box) => {
    const [x0, y0, x1, y1] = win ? toLocal(b, win) : b;
    return x1 < 0 || y1 < 0 || x0 > 1 || y0 > 1 ? null : { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` };
  };
  return (
    <div className={`page-wrap${win ? " aimed" : ""}`} ref={wrap}>
      <canvas ref={canvas} aria-label={`Страница ${page}${win ? ", фрагмент вокруг доказательства" : ""}`} className={ready ? "shown" : ""} />
      {ready &&
        marks
          .filter((m) => m.bbox)
          .map((m, i) => {
            const pad = win ? 0.012 * (win[2] - win[0]) : 0.006; // зазор рамки — доля показанной ширины
            const [x0, y0, x1, y1] = m.bbox!;
            const st = place([x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
            return st && <div key={i} className={`hl ${m.kind}${m.tone ? ` ${m.tone}` : ""}${win ? " aim" : ""}`} data-label={m.label} style={st} />;
          })}
      {ready &&
        requisites.map((r, i) => {
          const st = place(r.bbox!);
          return (
            st && (
              <div
                key={`r${i}`}
                className="hl req"
                data-kind={r.kind}
                data-label={`${REQUISITE_RU[r.kind] ?? r.kind} · ${pct(r.confidence)}`}
                title={`Реквизит: ${REQUISITE_RU[r.kind] ?? r.kind}, уверенность ${pct(r.confidence)}`}
                style={st}
              />
            )
          );
        })}
      {ready && measure && !win && <MeasureLayer m={measure} />}
    </div>
  );
}

/** Размерные линии (по ним определён масштаб) и измеренные расстояния между линиями чертежа.
 *  Горизонтальные и вертикальные — рамками, наклонные — SVG-отрезками по концам из ML (OS-INSP-2.4.4, 2.4.5). */
function MeasureLayer({ m }: { m: Measure }) {
  const mid = (a: number, b: number) => (a + b) / 2;
  const obliqueDims = m.dimension_lines.filter((d) => d.orientation === "oblique" && d.line);
  const obliqueDist = m.distances.filter((d) => d.axis === "n" && d.a_pt && d.b_pt);
  return (
    <>
      {m.dimension_lines.map((d, i) => {
        if (d.orientation === "oblique" && d.line) return null;
        const [x0, y0, x1, y1] = d.line_bbox;
        const vertical = d.orientation === "vertical";
        return <div key={`d${i}`} className={`dim-line${vertical ? " v" : ""}`} data-label={`${d.label} мм`} style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${Math.max(x1 - x0, 0.002) * 100}%`, height: `${Math.max(y1 - y0, 0.002) * 100}%` }} />;
      })}
      {m.distances.map((d, i) => {
        if (d.axis === "n") return null;
        const [a, b] = [d.a_bbox, d.b_bbox];
        // отрезок между центрами двух линий по оси измерения, на середине их общего перекрытия
        if (d.axis === "x") {
          const lo = Math.max(a[1], b[1]);
          const hi = Math.min(a[3], b[3]);
          const y = lo < hi ? mid(lo, hi) : mid(a[1], a[3]);
          const xa = mid(a[0], a[2]);
          const xb = mid(b[0], b[2]);
          return <div key={`m${i}`} className="dist x" data-label={mm(d.mm)} style={{ left: `${Math.min(xa, xb) * 100}%`, top: `${y * 100}%`, width: `${Math.abs(xb - xa) * 100}%` }} />;
        }
        const lo = Math.max(a[0], b[0]);
        const hi = Math.min(a[2], b[2]);
        const x = lo < hi ? mid(lo, hi) : mid(a[0], a[2]);
        const ya = mid(a[1], a[3]);
        const yb = mid(b[1], b[3]);
        return <div key={`m${i}`} className="dist y" data-label={mm(d.mm)} style={{ left: `${x * 100}%`, top: `${Math.min(ya, yb) * 100}%`, height: `${Math.abs(yb - ya) * 100}%` }} />;
      })}
      {(obliqueDims.length > 0 || obliqueDist.length > 0) && (
        <svg className="measure-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {obliqueDims.map((d, i) => (
            <line key={`od${i}`} className="dim" x1={d.line![0] * 100} y1={d.line![1] * 100} x2={d.line![2] * 100} y2={d.line![3] * 100} vectorEffect="non-scaling-stroke" />
          ))}
          {obliqueDist.map((d, i) => (
            <line key={`on${i}`} className="dist" x1={d.a_pt![0] * 100} y1={d.a_pt![1] * 100} x2={d.b_pt![0] * 100} y2={d.b_pt![1] * 100} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      )}
      {obliqueDims.map((d, i) => (
        <span key={`odl${i}`} className="measure-tag dim" style={{ left: `${mid(d.line![0], d.line![2]) * 100}%`, top: `${mid(d.line![1], d.line![3]) * 100}%` }}>{d.label} мм</span>
      ))}
      {obliqueDist.map((d, i) => (
        <span key={`onl${i}`} className="measure-tag dist" style={{ left: `${mid(d.a_pt![0], d.b_pt![0]) * 100}%`, top: `${mid(d.a_pt![1], d.b_pt![1]) * 100}%` }}>{mm(d.mm)}</span>
      ))}
    </>
  );
}

/** DOCX и XML: геометрии нет — показываем текст документа и подсвечиваем найденное значение. */
function Structured({ fileId, value }: { fileId: string; value?: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fileBytes(fileId).then(async (b) => {
      const u8 = new Uint8Array(b);
      if (u8[0] === 0x50 && u8[1] === 0x4b) {
        // DOCX — zip; извлечь document.xml без библиотеки нельзя, показываем подсказку
        setText(null);
      } else setText(new TextDecoder().decode(u8).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    });
  }, [fileId]);
  if (text === null)
    return (
      <div className="structured mute">
        Документ DOCX: доказательство — значение <b>{value}</b> в таблице показателей. Координат листа у структурированного документа нет.
      </div>
    );
  const parts = value ? text.split(value) : [text];
  return (
    <div className="structured">
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <mark>{value}</mark>}
        </span>
      ))}
    </div>
  );
}

const ZOOMS = [1, 1.5, 2, 3, 4];

/**
 * Лист на весь экран (T-132, просьба владельца): документ целиком в большом окне; масштаб — кнопки и колесо с Ctrl,
 * перемещение — перетаскиванием и прокруткой; при открытии окно прокручено к первой рамке. Esc — закрыть.
 */
function SheetViewer({ file, page, marks, requisites, onClose }: { file: SheetProps["file"]; page: number; marks: Mark[]; requisites: Requisite[]; onClose: () => void }) {
  const [zi, setZi] = useState(1);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setZi((z) => Math.min(z + 1, ZOOMS.length - 1));
      else if (e.key === "-") setZi((z) => Math.max(z - 1, 0));
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // к первой рамке: после отрисовки листа нужного масштаба
  useEffect(() => {
    const b = marks.find((m) => m.bbox)?.bbox;
    const el = body.current;
    if (!b || !el) return;
    const t = setTimeout(() => {
      el.scrollLeft = ((b[0] + b[2]) / 2) * el.scrollWidth - el.clientWidth / 2;
      el.scrollTop = ((b[1] + b[3]) / 2) * el.scrollHeight - el.clientHeight / 2;
    }, 350);
    return () => clearTimeout(t);
  }, [zi, marks]);
  return (
    <div className="sheet-full" role="dialog" aria-label={`Лист ${file.document_code}, стр. ${page}`}>
      <div className="sheet-full-bar">
        <span className={`stagetag ${file.doc_stage}`}>{STAGE_RU[file.doc_stage]}</span>
        <b className="mono">{file.document_code}</b>
        <span className="mute">ред. {file.revision} · стр. {page}</span>
        <span style={{ flex: 1 }} />
        <button className="btn small-btn" onClick={() => setZi((z) => Math.max(z - 1, 0))} disabled={zi === 0} aria-label="Уменьшить">−</button>
        <span className="num" style={{ minWidth: 46, textAlign: "center" }}>{Math.round(ZOOMS[zi] * 100)} %</span>
        <button className="btn small-btn" onClick={() => setZi((z) => Math.min(z + 1, ZOOMS.length - 1))} disabled={zi === ZOOMS.length - 1} aria-label="Увеличить">+</button>
        <button className="btn small-btn" onClick={() => setZi(0)}>По ширине</button>
        <button className="btn small-btn" onClick={onClose}>Закрыть <span className="kbd">Esc</span></button>
      </div>
      <div
        className="sheet-full-body"
        ref={body}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          setZi((z) => Math.max(0, Math.min(ZOOMS.length - 1, z + (e.deltaY < 0 ? 1 : -1))));
        }}
        onMouseDown={(e) => {
          const el = body.current!;
          drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          body.current!.scrollLeft = d.l - (e.clientX - d.x);
          body.current!.scrollTop = d.t - (e.clientY - d.y);
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        <div className="sheet-full-page" style={{ width: `${ZOOMS[zi] * 100}%` }}>
          <PdfPage key={zi} fileId={file.id} page={page} marks={marks} requisites={requisites} whole />
        </div>
      </div>
    </div>
  );
}
