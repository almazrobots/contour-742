// OS-INSP-1.3 Определить актуальные редакции.
import type { ApprovalStatus, RevisionRole, Stage } from "./types.ts";

export interface RevisionInput {
  file_id: string;
  client_file_id: string;
  doc_stage: Stage;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  predecessor_id: string | null; // client_file_id предшественника из реестра
  part_of?: string | null; // OS-INSP-1.2.10: client_file_id основного документа, если файл — его часть
  part_index?: number | null;
}

/** Ключ документа: части большого документа (OS-INSP-1.2.10) — один документ с основным. */
export const documentKey = (f: { client_file_id: string; part_of?: string | null }): string => f.part_of || f.client_file_id;

/**
 * Представитель документа из частей: основной файл (без part_of), иначе часть с меньшим номером.
 * Выбор редакций идёт по представителям; остальные части наследуют их роль.
 */
export function partRepresentatives<T extends { client_file_id: string; part_of?: string | null; part_index?: number | null }>(files: T[]): { heads: T[]; headOf: Map<T, T> } {
  const units = new Map<string, T[]>();
  for (const f of files) units.set(documentKey(f), [...(units.get(documentKey(f)) ?? []), f]);
  const heads: T[] = [];
  const headOf = new Map<T, T>();
  for (const unit of units.values()) {
    const rank = (f: T) => (f.part_of ? (f.part_index ?? Number.MAX_SAFE_INTEGER) : 0);
    const head = [...unit].sort((a, b) => rank(a) - rank(b))[0];
    heads.push(head);
    for (const f of unit) headOf.set(f, head);
  }
  return { heads, headOf };
}

const EFFECTIVE: ApprovalStatus[] = ["APPROVED", "FOR_CONSTRUCTION"];

/** Редакция-корректировка «к1», «к2» (cipher.revisionOf из «Корр.N»). */
export const isCorrection = (revision: string | null | undefined): boolean => /^к\d+$/.test(revision ?? "");
const correctionNo = (revision: string): number => (isCorrection(revision) ? Number(revision.slice(1)) : 0);

/**
 * Поправка поверх базы (T-233): если поправка документа («Корр.N») дала значение параметра на своей стадии,
 * значения базового файла того же документа и более ранних поправок отбрасываются — действует последняя поправка.
 * Документ без поправок и поправка без значения не трогают базу.
 */
export function preferCorrections<M extends { stage: string; document_code: string | null; revision: string }>(mentions: M[]): M[] {
  const latest = new Map<string, number>();
  for (const m of mentions) {
    if (!m.document_code || !isCorrection(m.revision)) continue;
    const k = `${m.stage}|${m.document_code}`;
    latest.set(k, Math.max(latest.get(k) ?? 0, correctionNo(m.revision)));
  }
  return mentions.filter((m) => {
    const top = m.document_code ? latest.get(`${m.stage}|${m.document_code}`) : undefined;
    return top === undefined || correctionNo(m.revision) === top;
  });
}

/**
 * Назначает каждому файлу роль: CURRENT — эталон сравнения; SUPERSEDED — заменён, хранится для аудита;
 * CONFLICT — несколько равноправных кандидатов в эталон; UNRESOLVED — нет признака утверждения или реестра.
 */
export function selectRevisions(files: RevisionInput[], hasManifest: boolean): Map<string, { role: RevisionRole; note: string }> {
  const out = new Map<string, { role: RevisionRole; note: string }>();
  if (!hasManifest) {
    for (const f of files) out.set(f.file_id, { role: "UNRESOLVED", note: "пакет без реестра файлов" });
    return out;
  }
  const { heads, headOf } = partRepresentatives(files);
  const groups = new Map<string, RevisionInput[]>();
  for (const f of heads) {
    const key = `${f.doc_stage}|${f.document_code}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    const replaced = new Set(group.map((f) => f.predecessor_id).filter((x): x is string => Boolean(x)));
    const candidates: RevisionInput[] = [];
    for (const f of group) {
      if (f.approval_status === "SUPERSEDED" || f.approval_status === "CANCELLED") {
        out.set(f.file_id, { role: "SUPERSEDED", note: `статус ${f.approval_status}` });
      } else if (replaced.has(f.client_file_id)) {
        out.set(f.file_id, { role: "SUPERSEDED", note: "заменён следующей редакцией" });
      } else if (!f.approval_status || !EFFECTIVE.includes(f.approval_status)) {
        out.set(f.file_id, { role: "UNRESOLVED", note: "нет признака утверждения" });
      } else {
        candidates.push(f);
      }
    }
    const corrections = candidates.filter((c) => isCorrection(c.revision));
    const bases = candidates.filter((c) => !isCorrection(c.revision));
    if (candidates.length === 1) {
      out.set(candidates[0].file_id, { role: "CURRENT", note: `ред. ${candidates[0].revision} — эталон` });
    } else if (corrections.length && bases.length === 1) {
      // T-233, решение владельца 28.09: «Корр.N» — листы-поправки поверх базового документа, а не соперник за эталон.
      // Оба — актуальная редакция; значение из поправки главнее значения базы (preferCorrections)
      out.set(bases[0].file_id, { role: "CURRENT", note: `ред. ${bases[0].revision} — база, поправки: ${corrections.map((c) => c.revision).join(", ")}` });
      for (const c of corrections) out.set(c.file_id, { role: "CURRENT", note: `ред. ${c.revision} — поправка поверх базы` });
    } else if (candidates.length > 1) {
      const revs = candidates.map((c) => c.revision).join(", ");
      for (const c of candidates) out.set(c.file_id, { role: "CONFLICT", note: `несколько утверждённых редакций без связи замены: ${revs}` });
    }
  }
  // части наследуют роль основного документа — они не спорят с ним за эталон
  for (const f of files) {
    const head = headOf.get(f)!;
    if (head !== f) out.set(f.file_id, { role: out.get(head.file_id)!.role, note: `часть ${f.part_index ?? "?"} документа ${documentKey(f)}; ${out.get(head.file_id)!.note}` });
  }
  return out;
}

/**
 * OS-INSP-1.2.10: сквозная нумерация страниц документа из частей. Смещение части = сумма страниц
 * предыдущих частей того же документа. Пока предыдущая часть не разобрана, смещение неизвестно (null).
 */
export function pageOffsets(files: Array<{ file_id: string; client_file_id: string; part_of?: string | null; part_index?: number | null; pages: number | null }>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const units = new Map<string, typeof files>();
  for (const f of files) units.set(documentKey(f), [...(units.get(documentKey(f)) ?? []), f]);
  for (const unit of units.values()) {
    const ordered = [...unit].sort((a, b) => (a.part_of ? (a.part_index ?? Number.MAX_SAFE_INTEGER) : 0) - (b.part_of ? (b.part_index ?? Number.MAX_SAFE_INTEGER) : 0));
    let offset: number | null = 0;
    for (const f of ordered) {
      out.set(f.file_id, offset);
      offset = offset === null || f.pages === null ? null : offset + f.pages;
    }
  }
  return out;
}
