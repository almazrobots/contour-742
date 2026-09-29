// OS-INSP-1.4.4 Сверить перечень скрытых работ из Общих данных с принятыми АОСР.
import type { ApprovalStatus, FindingStatus, RevisionRole, Stage } from "./types.ts";

/** Позиция перечня скрытых работ, найденная ML в документе ПД/РД. */
export interface HiddenWorkItem {
  n: number; // номер позиции в перечне документа
  text: string;
  file_id: string;
  sha256: string;
  stage: Stage;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

/** Документ ИД — кандидат в АОСР. */
export interface ActDoc {
  file_id: string;
  sha256: string;
  file_name: string;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  revision_role: RevisionRole | null;
  title: string | null;
}

export interface HiddenWorkFragment {
  file_id: string;
  sha256: string;
  stage: Stage;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
  value: string;
  kind: "expected" | "actual";
}

export interface HiddenWorkCheck {
  param_code: string; // HW-<n>
  title: string;
  status: Extract<FindingStatus, "MISSING_EVIDENCE" | "NEGATIVE_VERIFIED">;
  expected: string;
  actual: string | null;
  reason: string;
  fragments: HiddenWorkFragment[];
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Слова без предметного смысла для сопоставления: вид работ задают следующие за ними слова. */
const STOP = new Set(["устройство", "выполнение", "производство", "работы", "работ", "акт", "акта", "освидетельствования", "скрытых", "аоср", "согласно", "проекту", "перечень"]);

/**
 * Ключевые слова позиции: слова от 4 букв без служебных, обрезанные до 5 букв — грубая основа,
 * которой хватает на падежи («фундаментной плиты» ≈ «фундаментная плита»).
 */
export function keywords(text: string): string[] {
  const words = fold(text).match(/[\p{L}]+/gu) ?? [];
  return words.filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 5));
}

/** Документ — АОСР: шифр, имя файла или заголовок называют акт освидетельствования скрытых работ. */
export function isAct(d: Pick<ActDoc, "document_code" | "file_name" | "title">): boolean {
  const hay = fold(`${d.document_code} ${d.file_name} ${d.title ?? ""}`);
  return /аоср|aosr|акт\s+освидетельствования\s+скрытых/.test(hay);
}

/** Принятый акт: не заменён и не аннулирован. */
export function isAccepted(d: Pick<ActDoc, "approval_status" | "revision_role">): boolean {
  return d.approval_status !== "SUPERSEDED" && d.approval_status !== "CANCELLED" && d.revision_role !== "SUPERSEDED";
}

/**
 * Акт покрывает позицию, когда совпадает вид работ (первое значимое слово позиции) и не меньше
 * половины ключевых слов позиции. «Гидроизоляция фундаментной плиты» не закрывается актом
 * «Армирование фундаментной плиты»: общие слова есть, вид работ другой.
 */
export function covers(item: string, act: Pick<ActDoc, "document_code" | "file_name" | "title">): boolean {
  const need = keywords(item);
  if (!need.length) return false;
  const have = new Set(keywords(`${act.title ?? ""} ${act.document_code}`));
  if (!have.has(need[0])) return false;
  const hit = need.filter((k) => have.has(k)).length;
  return hit / need.length >= 0.5;
}

/** Одинаковые позиции из разных документов (ПД и РД) — одна работа. */
export function dedupeItems(items: HiddenWorkItem[]): HiddenWorkItem[] {
  const seen = new Set<string>();
  const out: HiddenWorkItem[] = [];
  const order = [...items].sort((a, b) => a.stage.localeCompare(b.stage) || a.document_code.localeCompare(b.document_code) || (a.page ?? 0) - (b.page ?? 0) || a.n - b.n);
  for (const it of order) {
    const k = keywords(it.text).join(" ") || fold(it.text).trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** OS-INSP-1.4.4: по каждой работе перечня — акт есть (NEGATIVE_VERIFIED со ссылкой) или MISSING_EVIDENCE. */
export function evaluateHiddenWorks(items: HiddenWorkItem[], docs: ActDoc[]): HiddenWorkCheck[] {
  const acts = docs.filter((d) => isAct(d) && isAccepted(d));
  return dedupeItems(items).map((it, i) => {
    const src = `${it.document_code}, ред. ${it.revision}${it.page ? `, стр. ${it.page}` : ""}`;
    const expected: HiddenWorkFragment = {
      file_id: it.file_id, sha256: it.sha256, stage: it.stage, document_code: it.document_code, revision: it.revision,
      approval_status: it.approval_status, page: it.page, bbox: it.bbox, value: it.text, kind: "expected",
    };
    const act = acts.find((a) => covers(it.text, a));
    const title = `Скрытые работы: ${it.text}`;
    if (!act)
      return {
        param_code: `HW-${i + 1}`, title, status: "MISSING_EVIDENCE" as const, expected: "АОСР", actual: null, fragments: [expected],
        reason: `Перечень скрытых работ (${src}), позиция ${it.n} «${it.text}»: среди принятых документов ИД нет АОСР на эту работу — запросите акт освидетельствования скрытых работ.`,
      };
    return {
      param_code: `HW-${i + 1}`, title, status: "NEGATIVE_VERIFIED" as const, expected: "АОСР", actual: act.document_code,
      fragments: [expected, { file_id: act.file_id, sha256: act.sha256, stage: "ID", document_code: act.document_code, revision: act.revision, approval_status: act.approval_status, page: 1, bbox: null, value: act.title ?? act.document_code, kind: "actual" }],
      reason: `Перечень скрытых работ (${src}), позиция ${it.n} «${it.text}»: работа закрыта актом ${act.document_code}${act.title ? ` «${act.title}»` : ""}.`,
    };
  });
}
