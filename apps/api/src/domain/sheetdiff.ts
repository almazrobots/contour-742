// OS-INSP-3.4 Выявить изменения листа между редакциями — предметная часть (чистые функции).
// Ответ ML /diff (области изменений с bbox на обоих листах) → проверки и доказательные фрагменты.
// IO (вызов ML, запись в БД) — services/sheetdiff.ts.
import { createHash } from "node:crypto";
import type { ApprovalStatus, FindingStatus } from "./types.ts";

export const SHEET_DIFF_CODE = "SHEET-DIFF";
/** Параметр вне Матрицы: имя и раздел для карточки и протокола (checkRows подставляет их по коду). */
export const SHEET_DIFF_PARAM = { parameter_name: "Изменение листа между редакциями", section: "Листы", unit: "" } as const;

export type BBox = [number, number, number, number];

export interface SheetRef {
  file_id: string;
  sha256: string;
  stage: string;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | string | null;
  page: number;
}

export interface DiffRegion {
  bbox_a: BBox;
  bbox_b: BBox;
  score: number;
  area: number;
}

export interface DiffResult {
  status: "ok" | "not_comparable";
  reason: string | null;
  inliers: number;
  regions: DiffRegion[];
}

export interface FragmentDraft {
  file_id: string;
  sha256: string;
  stage: string;
  document_code: string;
  revision: string;
  approval_status: string | null;
  sheet_page: number;
  bbox: BBox | null;
  extracted_value: string;
  role: "expected" | "actual";
}

export interface CheckDraft {
  id: string;
  evidence_group_id: string;
  finding_status: Extract<FindingStatus, "CANDIDATE" | "NOT_COMPARABLE">;
  expected_value: string;
  actual_value: string;
  delta: string | null;
  review_priority: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  fragments: FragmentDraft[];
}

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/** Ключ пары листов: одна пара сравнивается один раз, повторный запуск ничего не дублирует. */
export function pairKey(objectId: string, a: SheetRef, b: SheetRef): string {
  return `${objectId}:${SHEET_DIFF_CODE}:${a.sha256.slice(0, 12)}@${a.page}~${b.sha256.slice(0, 12)}@${b.page}`;
}

/** Очерёдность проверки по значимости области (только порядок в очереди, не основание для предписания). */
export function priorityOf(score: number): CheckDraft["review_priority"] {
  if (score >= 0.9) return "HIGH";
  if (score >= 0.7) return "MEDIUM";
  return "LOW";
}

const sheetLabel = (s: SheetRef) => `${s.document_code}, ред. ${s.revision}, л. ${s.page}`;

/**
 * OS-INSP-3.4.3: по каждой области изменения — проверка CANDIDATE с двумя фрагментами (лист A — expected,
 * лист B — actual), у каждого свой bbox. OS-INSP-3.4.4: листы не совместились — одна проверка NOT_COMPARABLE
 * с причиной и обеими страницами без рамок.
 */
export function diffToChecks(objectId: string, a: SheetRef, b: SheetRef, res: DiffResult): CheckDraft[] {
  const group = pairKey(objectId, a, b);
  const frag = (s: SheetRef, role: FragmentDraft["role"], bbox: BBox | null): FragmentDraft => ({
    file_id: s.file_id,
    sha256: s.sha256,
    stage: s.stage,
    document_code: s.document_code,
    revision: s.revision,
    approval_status: s.approval_status ?? null,
    sheet_page: s.page,
    bbox,
    extracted_value: `лист ${role === "expected" ? "A" : "B"}: ред. ${s.revision}, л. ${s.page}`,
    role,
  });
  const idOf = (g: string) => `F-${objectId}-${SHEET_DIFF_CODE}`.replace(/[^\w-]/g, "") + "-" + h(g).slice(0, 8);
  if (res.status !== "ok") {
    return [
      {
        id: idOf(group),
        evidence_group_id: group,
        finding_status: "NOT_COMPARABLE",
        expected_value: sheetLabel(a),
        actual_value: sheetLabel(b),
        delta: null,
        review_priority: "LOW",
        reason: `Листы не совмещаются: ${res.reason ?? "причина не указана"}. Сравните редакции вручную.`,
        fragments: [frag(a, "expected", null), frag(b, "actual", null)],
      },
    ];
  }
  return res.regions.map((r, i) => {
    const g = `${group}#${i + 1}`;
    return {
      id: idOf(g),
      evidence_group_id: g,
      finding_status: "CANDIDATE",
      expected_value: sheetLabel(a),
      actual_value: sheetLabel(b),
      delta: `изменена область ${(r.area * 100).toFixed(2)} % листа`,
      review_priority: priorityOf(r.score),
      reason: `Область ${i + 1} из ${res.regions.length}: лист изменился между редакциями (значимость ${r.score.toFixed(2)}, совмещение по ${res.inliers} точкам). Проверьте, согласовано ли изменение.`,
      fragments: [frag(a, "expected", r.bbox_a), frag(b, "actual", r.bbox_b)],
    };
  });
}

export interface RevisionFile {
  id: string;
  client_file_id: string;
  kind: string;
  document_code: string;
  predecessor_id: string | null;
  revision_role: string | null;
  parse_status: string;
  pages: number;
}

/**
 * Пары редакций для автоматического диффа: предшественник SUPERSEDED → преемник CURRENT по predecessor_id,
 * оба PDF и разобраны; сравниваются совпадающие номера страниц 1..min(n_a, n_b).
 */
export function revisionPairs(files: RevisionFile[]): Array<{ a: RevisionFile; b: RevisionFile; pages: number[] }> {
  const byClient = new Map(files.map((f) => [f.client_file_id, f]));
  const out: Array<{ a: RevisionFile; b: RevisionFile; pages: number[] }> = [];
  for (const b of files) {
    if (b.revision_role !== "CURRENT" || !b.predecessor_id) continue;
    const a = byClient.get(b.predecessor_id);
    if (!a || a.revision_role !== "SUPERSEDED") continue;
    if (a.kind !== "pdf" || b.kind !== "pdf" || a.parse_status !== "DONE" || b.parse_status !== "DONE") continue;
    const n = Math.min(a.pages, b.pages);
    if (n > 0) out.push({ a, b, pages: Array.from({ length: n }, (_, i) => i + 1) });
  }
  return out;
}
