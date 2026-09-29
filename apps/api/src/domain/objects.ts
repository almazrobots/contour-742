// Раздел «Объекты» (T-166, вариант Б плана T-142): объект — главная сущность, проверки — журнал внутри объекта.
// Чистые функции реестра: файлы по стадиям ПД/РД/ИД, документы объекта без повторов, последняя проверка ключевого
// параметра и его значение по каждой стадии. OS-INSP-8.1.3–8.1.7. Коды параметров не зашиты в логику — список
// ключевых параметров приходит снаружи, по умолчанию М-023.
import { STAGES, type Stage } from "./types.ts";

export const DEFAULT_KEY_PARAMS: readonly string[] = ["M-023"];
/** Предел списка ключевых параметров в одном запросе: реестр — не выгрузка всей Матрицы. */
export const KEY_PARAMS_MAX = 10;
const CODE = /^M-\d{3}$/;

/**
 * Список ключевых параметров из строки запроса «M-023,M-001». Пусто — список по умолчанию. Чужой формат кода,
 * пустой элемент или больше KEY_PARAMS_MAX — null (отказ 400), а не тихая подмена.
 */
export function parseKeyParams(raw: string | undefined | null): string[] | null {
  if (raw === undefined || raw === null || raw.trim() === "") return [...DEFAULT_KEY_PARAMS];
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.some((p) => !CODE.test(p))) return null;
  const uniq = [...new Set(parts)];
  return uniq.length > KEY_PARAMS_MAX ? null : uniq;
}

export type StageCounts = Record<Stage, number>;
const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);

/** Число файлов по стадиям из агрегата «стадия → n». Стадия без файлов — 0; чужая стадия не считается. */
export function stageCounts(rows: Array<{ doc_stage: string; n: number }>): StageCounts {
  const out: StageCounts = { PD: 0, RD: 0, ID: 0 };
  for (const r of rows) if (isStage(r.doc_stage)) out[r.doc_stage] += Number(r.n);
  return out;
}

export interface ObjectDoc {
  id: string;
  file_name: string;
  sha256: string;
  doc_stage: string;
  document_code: string;
  revision: string;
  doc_title: string | null;
  revision_role: string | null;
  inspection_id: string;
  uploaded_at: string;
}

/**
 * Документы объекта по стадиям (OS-INSP-8.1.3). Объект накапливает файлы всех своих проверок; один и тот же файл
 * (SHA-256), загруженный повторно, показывается один раз — из последней загрузки. Пустая стадия — пустой список.
 */
export function documentsByStage(files: ObjectDoc[]): Record<Stage, ObjectDoc[]> {
  const latest = new Map<string, ObjectDoc>();
  for (const f of files) {
    if (!isStage(f.doc_stage)) continue;
    const cur = latest.get(f.sha256);
    if (!cur || f.uploaded_at > cur.uploaded_at) latest.set(f.sha256, f);
  }
  const out: Record<Stage, ObjectDoc[]> = { PD: [], RD: [], ID: [] };
  for (const f of latest.values()) out[f.doc_stage as Stage].push(f);
  for (const s of STAGES) out[s].sort((a, b) => a.document_code.localeCompare(b.document_code) || a.revision.localeCompare(b.revision) || a.file_name.localeCompare(b.file_name));
  return out;
}

export interface CheckCandidate {
  check_id: string;
  inspection_id: string;
  object_id: string;
  param_code: string;
  finding_status: string;
  verification_status: string;
  stage_notes_json: string | null;
  inspection_updated_at: string;
}

/** Ключ пары объект × параметр. */
export const pairKey = (objectId: string, code: string): string => `${objectId}|${code}`;

/**
 * Последняя проверка параметра по каждому объекту (OS-INSP-8.1.4): история проверок сохраняется, а в реестре —
 * запись из последней обновлённой проверки; при равной дате — больший номер проверки (детерминизм).
 */
export function latestChecks(rows: CheckCandidate[]): Map<string, CheckCandidate> {
  const out = new Map<string, CheckCandidate>();
  for (const r of rows) {
    const k = pairKey(r.object_id, r.param_code);
    const cur = out.get(k);
    if (!cur || r.inspection_updated_at > cur.inspection_updated_at || (r.inspection_updated_at === cur.inspection_updated_at && r.inspection_id > cur.inspection_id)) out.set(k, r);
  }
  return out;
}

/** Состояние стадии в строке ключевого параметра. Слова инспектора — в интерфейсе (labels.ts), здесь — коды. */
export type StageState = "VALUE" | "NO_VALUE" | "NOT_LOADED" | "NOT_REQUIRED" | "NOT_CHECKED";

export interface StageCell {
  stage: Stage;
  state: StageState;
  value: string | null;
  document_code: string | null;
  page: number | null;
}

export interface StageFragment {
  stage: string | null;
  extracted_value: string | null;
  document_code: string | null;
  sheet_page: number | null;
}

/**
 * Значение параметра по стадиям (OS-INSP-8.1.6). Порядок правил: проверки не было — «не проверялся» (или «не
 * загружена», если файлов стадии нет); файлов стадии нет — «стадия не загружена»; есть доказательство с непустым
 * значением — значение, документ и лист (первое по порядку); параметр стадию не требует — «не требуется»; иначе —
 * «в стадии значение не найдено».
 */
export function stageCells(input: { checked: boolean; loaded: StageCounts; notes: Partial<Record<Stage, string>> | null; fragments: StageFragment[] }): StageCell[] {
  return STAGES.map((stage) => {
    const empty = { stage, value: null, document_code: null, page: null };
    if (input.loaded[stage] === 0) return { ...empty, state: "NOT_LOADED" as const };
    if (!input.checked) return { ...empty, state: "NOT_CHECKED" as const };
    const f = input.fragments.find((x) => x.stage === stage && (x.extracted_value ?? "").trim() !== "");
    if (f) return { stage, state: "VALUE" as const, value: f.extracted_value, document_code: f.document_code, page: f.sheet_page };
    if (input.notes?.[stage] === "NOT_APPLICABLE") return { ...empty, state: "NOT_REQUIRED" as const };
    return { ...empty, state: "NO_VALUE" as const };
  });
}

export interface Decision {
  status: string;
  by: string | null;
  at: string;
}
export interface AutoCheck {
  verdict: string;
  method: string;
  checked_at: string;
}

export interface KeyParamRow {
  code: string;
  checked: boolean;
  inspection_id: string | null;
  check_id: string | null;
  finding_status: string | null;
  verification_status: string | null;
  decision: Decision | null;
  auto_check: AutoCheck | null;
  stages: StageCell[];
}

function notesOf(json: string | null): Partial<Record<Stage, string>> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Partial<Record<Stage, string>>) : null;
  } catch {
    return null; // битая запись — как «заметок нет», а не падение всего реестра
  }
}

/**
 * Строка ключевого параметра объекта (OS-INSP-8.1.4, 8.1.7): итог сверки системы (finding_status), решение
 * инспектора (verification_status и последнее действующее решение), результат независимого пересчёта и три стадии.
 */
export function keyParamRow(
  code: string,
  input: { check: CheckCandidate | null; loaded: StageCounts; fragments: StageFragment[]; decision: Decision | null; autoCheck: AutoCheck | null },
): KeyParamRow {
  const c = input.check;
  return {
    code,
    checked: c !== null,
    inspection_id: c?.inspection_id ?? null,
    check_id: c?.check_id ?? null,
    finding_status: c?.finding_status ?? null,
    verification_status: c?.verification_status ?? null,
    decision: input.decision,
    auto_check: input.autoCheck,
    stages: stageCells({ checked: c !== null, loaded: input.loaded, notes: notesOf(c?.stage_notes_json ?? null), fragments: input.fragments }),
  };
}
