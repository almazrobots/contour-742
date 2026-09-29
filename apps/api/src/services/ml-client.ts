// Клиент ML-модуля (Python). Контракт — ml/inspector_ml/model.py: AnalyzeRequest / AnalyzeResponse.
import { config } from "../config.ts";
import { blobStore } from "./blobstore.ts";
import { Agent } from "undici";
import { type PageRange, partRanges, runLimited } from "../domain/parse-parts.ts";

export interface MlExtraction {
  code: string;
  raw: string;
  value_num: number | null;
  value_text: string | null;
  page: number;
  bbox: [number, number, number, number] | null;
  anchor_bbox: [number, number, number, number] | null;
  line_text: string;
  confidence: number;
  /** T-129: метаданные упоминания (ограничение «не ниже», причина отсева, цитата, операции каталога). */
  meta?: { quote?: string; qualifier?: "min" | null; excluded?: string | null; excluded_why?: string | null; ops?: string[] } | null;
}

export interface MlResponse {
  sha256: string;
  /** OS-INSP-2.1.12: версия разбора и извлечения, давшая ответ. */
  ml_revision?: string | null;
  kind: string;
  engine: string;
  /** words и disputed_words — знаменатель и числитель доли сомнительных слов OCR (OS-INSP-2.1.16); у старых ответов words нет. */
  pages: Array<{ page: number; width: number; height: number; rotation: number; source: string; quality: string; ocr_confidence: number | null; lines: number; words?: number; disputed_words?: number }>;
  /** OS-INSP-2.2.34 (ТЗ §11, TZA-11-07): время ML-анализа каждого параметра, мс; из кэша — прежнего анализа. */
  param_ms?: Record<string, number>;
  extractions: MlExtraction[];
  facts: MlExtraction[];
  rooms: Array<{ number: string; name: string; page: number; bbox: [number, number, number, number] | null }>;
  /** OS-INSP-1.4.4: позиции перечня скрытых работ из Общих данных (пусто, если перечня нет). */
  hidden_works?: Array<{ n: number; text: string; page: number; bbox: [number, number, number, number] | null }>;
  /** Заголовок документа (первая содержательная строка) — для поиска АОСР по наименованию. */
  title?: string | null;
  /** OS-INSP-2.2.7: вид документа внутри марки. */
  doc_type?: { kind: string; label: string; confidence: number; page: number | null; bbox: [number, number, number, number] | null; evidence: string | null } | null;
  /** Реквизиты по страницам (OS-INSP-2.3.1). */
  requisites?: Array<{ page: number; items: Array<{ kind: string; bbox: [number, number, number, number] | null; confidence: number; value?: string | null }> }>;
  /** T-177 (CMP-29): отметки изменений — облако и выноска «Изм. N» (IDN-04), строка таблицы изменений штампа (IDN-03). */
  change_marks?: Array<{ page: number; kind: string; number: string | null; bbox: [number, number, number, number] | null; text: string }>;
  cached: boolean;
}

export interface MlRequest {
  sha256: string;
  params: Array<{ code: string; anchors: string[]; data_type: string; regex_pattern: string | null; compare_kind?: string; unit?: string | null; extractor?: Record<string, unknown> }>; // unit — таблицам (OS-INSP-2.2.5, T-135)
  facts: Array<{ code: string; anchors: string[]; data_type: string; regex_pattern: string | null }>;
}

export class MlError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Соединения к ML со своими тайм-аутами. У fetch по умолчанию undici ждёт заголовки ответа 5 минут (headersTimeout) —
 * меньше тайм-аута ML (INSPECTOR_ML_TIMEOUT_MS, на стенде 30 мин): большой PDF обрывался на 5-й минуте, API ставил
 * повтор, а ML продолжал разбирать первый запрос — один файл шёл дважды параллельно, и контейнер ML падал по памяти
 * (стенд «Алтуфьевское 79Б», T-129). Теперь срок ответа задаёт только INSPECTOR_ML_TIMEOUT_MS.
 */
export function mlDispatcher(timeoutMs: number): Agent {
  return new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: 10_000 });
}
const ML_AGENT = mlDispatcher(config.mlTimeoutMs);
const ml = { dispatcher: ML_AGENT } as unknown as RequestInit; // тот же undici, что под fetch Node (major 7)

let impl: (req: MlRequest) => Promise<MlResponse> = async (req) => {
  let res: Response;
  try {
    res = await fetch(`${config.mlUrl}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(config.mlTimeoutMs),
      ...ml,
    });
  } catch (e: any) {
    // undici прячет причину в cause: ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET, TimeoutError
    throw new MlError(0, `ML недоступен: ${e?.cause?.code ?? e?.name ?? ""} ${e?.cause?.message ?? e?.message ?? e}`.trim());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new MlError(res.status, typeof body.detail === "string" ? body.detail : `ML ответил ${res.status}`);
  }
  return (await res.json()) as MlResponse;
};

export function analyze(req: MlRequest): Promise<MlResponse> {
  return impl(req);
}

/** Подмена транспорта для тестов (L4: отказ ML, тайм-аут). */
export function setMlTransport(fn: typeof impl): void {
  impl = fn;
}

// ─────────────────────────────── T-233 том по частям (контракт — ml/inspector_ml/app.py: /parse/pages, /parse/part, /parse/assemble)

export interface MlParts {
  pages(sha256: string): Promise<{ pages: number | null; parsed: boolean }>;
  part(sha256: string, first: number, last: number): Promise<void>;
  assemble(sha256: string, ranges: PageRange[]): Promise<void>;
}

export async function mlPost<T>(path: string, body: unknown, timeoutMs = config.mlTimeoutMs): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.mlUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), ...ml });
  } catch (e: any) {
    throw new MlError(0, `ML недоступен: ${e?.cause?.code ?? e?.name ?? ""} ${e?.cause?.message ?? e?.message ?? e}`.trim());
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new MlError(res.status, typeof b.detail === "string" ? b.detail : `ML ответил ${res.status}`);
  }
  return (await res.json()) as T;
}

let partsImpl: MlParts = {
  pages: (sha256) => mlPost("/parse/pages", { sha256 }),
  part: async (sha256, first, last) => void (await mlPost("/parse/part", { sha256, first, last })),
  assemble: async (sha256, ranges) => void (await mlPost("/parse/assemble", { sha256, ranges })),
};

export function setMlParts(p: MlParts): void {
  partsImpl = p;
}

/**
 * Разобрать том PDF частями по chunkPages страниц, до concurrency частей одновременно, и собрать разбор в кэше ML.
 * Возвращает число частей (0 — файл не делится: выключено, не PDF, мал или уже разобран — /analyze разберёт как раньше).
 */
export async function parseInParts(sha256: string, chunkPages: number, concurrency: number): Promise<number> {
  if (chunkPages < 1) return 0;
  const probe = await partsImpl.pages(sha256);
  if (probe.parsed || probe.pages === null) return 0;
  const ranges = partRanges(probe.pages, chunkPages);
  if (!ranges.length) return 0;
  await runLimited(ranges, concurrency, ([first, last]) => partsImpl.part(sha256, first, last));
  await partsImpl.assemble(sha256, ranges);
  return ranges.length;
}

// ─────────────────────────────── OS-INSP-3.4 дифф листа (контракт — ml/inspector_ml/model.py: DiffRequest / DiffResponse)

export interface MlDiffRequest {
  sha_a: string;
  page_a: number;
  sha_b: string;
  page_b: number;
}

export interface MlDiffResponse {
  status: "ok" | "not_comparable";
  reason: string | null;
  inliers: number;
  matches: number;
  method: string;
  regions: Array<{ bbox_a: [number, number, number, number]; bbox_b: [number, number, number, number]; score: number; area: number }>;
  ms: number;
  cached: boolean;
}

let diffImpl: (req: MlDiffRequest) => Promise<MlDiffResponse> = async (req) => {
  // NFR-CRYPTO: ML читает открытый текст только из рабочего каталога (tmpfs) — выложить оба листа до запроса
  await blobStore().localPath(req.sha_a);
  await blobStore().localPath(req.sha_b);
  let res: Response;
  try {
    res = await fetch(`${config.mlUrl}/diff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(config.mlTimeoutMs),
      ...ml,
    });
  } catch (e: any) {
    throw new MlError(0, `ML недоступен: ${e?.cause?.code ?? e?.name ?? ""} ${e?.cause?.message ?? e?.message ?? e}`.trim());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new MlError(res.status, typeof body.detail === "string" ? body.detail : `ML ответил ${res.status}`);
  }
  return (await res.json()) as MlDiffResponse;
};

export function diffSheets(req: MlDiffRequest): Promise<MlDiffResponse> {
  return diffImpl(req);
}

/** Подмена транспорта диффа для тестов. */
export function setMlDiffTransport(fn: typeof diffImpl): void {
  diffImpl = fn;
}

/** OS-INSP-2.4: измерение на чертеже — масштаб по размерным линиям и расстояния с bbox. */
export interface MlMeasureResponse {
  status: "OK" | "NOT_COMPARABLE";
  method: "dimension_line" | "none" | "inconsistent" | "stamp_mismatch" | "timeout";
  /** OS-INSP-2.4.7: причина NOT_COMPARABLE по сроку анализа листа; null — в срок. */
  reason?: string | null;
  /** Время CV-анализа листа, мс (ТЗ §11, TZA-11-08); у старого ML нет. */
  ms?: number;
  mm_per_px: number | null;
  dimension_lines: Array<{ label: string; mm: number; px: number; mm_per_px: number; line_bbox: number[]; label_bbox: number[] }>;
  distances: Array<{ mm: number; axis: "x" | "y"; a_bbox: number[]; b_bbox: number[] }>;
}

let measureImpl: (req: { sha256: string; page: number }) => Promise<MlMeasureResponse> = async (req) => {
  await blobStore().localPath(req.sha256); // NFR-CRYPTO: открытый текст для ML — в рабочем каталоге
  let res: Response;
  try {
    res = await fetch(`${config.mlUrl}/measure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(config.mlTimeoutMs), ...ml });
  } catch (e: any) {
    throw new MlError(0, `ML недоступен: ${e?.cause?.code ?? e?.name ?? ""} ${e?.cause?.message ?? e?.message ?? e}`.trim());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new MlError(res.status, typeof body.detail === "string" ? body.detail : `ML ответил ${res.status}`);
  }
  return (await res.json()) as MlMeasureResponse;
};

export function measureDrawing(req: { sha256: string; page: number }): Promise<MlMeasureResponse> {
  return measureImpl(req);
}

/** Подмена транспорта измерения для тестов. */
export function setMlMeasureTransport(fn: typeof measureImpl): void {
  measureImpl = fn;
}

/** VER-09 (T-194): закрытый вопрос локальной VLM по двум кропам. Ответ — сырой JSON: схему проверяет services/vlm-claim.ts. */
export interface MlVlmClaimRequest {
  question: string;
  crops: Array<{ sha256: string; page: number; bbox: [number, number, number, number]; role: "expected" | "actual" }>;
}

let vlmClaimImpl: (req: MlVlmClaimRequest) => Promise<unknown> = async (req) => {
  for (const c of req.crops) await blobStore().localPath(c.sha256); // NFR-CRYPTO: открытый текст для ML — в рабочем каталоге
  let res: Response;
  try {
    res = await fetch(`${config.mlUrl}/vlm/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(config.mlTimeoutMs), ...ml });
  } catch (e: any) {
    throw new MlError(0, `ML недоступен: ${e?.cause?.code ?? e?.name ?? ""} ${e?.cause?.message ?? e?.message ?? e}`.trim());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new MlError(res.status, typeof body.detail === "string" ? body.detail : `ML ответил ${res.status}`);
  }
  return res.json();
};

export function vlmClaim(req: MlVlmClaimRequest): Promise<unknown> {
  return vlmClaimImpl(req);
}

/** Подмена транспорта VER-09 для тестов: живой прогон — только на GPU стенда. */
export function setMlVlmClaimTransport(fn: typeof vlmClaimImpl): void {
  vlmClaimImpl = fn;
}

export async function mlHealth(): Promise<{ ok: boolean; profile?: string; ml_revision?: string | null }> {
  try {
    const r = await fetch(`${config.mlUrl}/health`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { profile: string; ml_revision?: string | null };
    return { ok: r.ok, profile: j.profile, ml_revision: j.ml_revision ?? null };
  } catch {
    return { ok: false };
  }
}
