// OS-INSP-2.3.2, 2.3.3 Обязательные реквизиты документа ИД: нет подписи, а у рабочего чертежа — штампов «В производство
// работ» и «Выполнено согласно проекту» (ТЗ §5 прим. 3) — MISSING_EVIDENCE по документу.
import type { ApprovalStatus, FindingStatus, RevisionRole } from "./types.ts";
import type { Kind } from "./upload.ts";
import { electronicallySigned, type SignatureVerdict } from "./signature.ts";

export type RequisiteKind = "seal" | "signature" | "stamp_production" | "stamp_asbuilt" | "date" | "reg_number";

/** Реквизит, найденный ML на странице (OS-INSP-2.3.1). */
export interface FoundRequisite {
  kind: RequisiteKind;
  page: number;
  bbox: [number, number, number, number] | null;
  confidence: number;
}

/** Документ ИД с реквизитами всех его страниц. */
export interface IdDoc {
  file_id: string;
  client_file_id: string;
  sha256: string;
  file_name: string;
  kind: Kind;
  document_code: string;
  revision: string;
  approval_status: ApprovalStatus | null;
  revision_role: RevisionRole | null;
  signature_status: string | null;
  /** OS-INSP-1.2.14: результат проверки откреплённой подписи; нет подписи рядом с документом — нет поля. */
  signature_check?: Pick<SignatureVerdict, "status" | "reason"> | null;
  title: string | null; // заголовок документа из разбора ML — по нему узнаётся рабочий чертёж
  requisites: FoundRequisite[];
}

export interface RequisiteCheck {
  param_code: string; // REQ-<file_id из реестра>
  title: string;
  status: Extract<FindingStatus, "MISSING_EVIDENCE">;
  expected: string;
  actual: string | null;
  reason: string;
  file_id: string;
}

/** Обязательный визуальный реквизит бумажного документа ИД. */
export const REQUIRED: RequisiteKind[] = ["signature"];
/** Рабочему чертежу в составе ИД сверх подписи нужны оба штампа (ТЗ §5, примечание 3). */
export const REQUIRED_DRAWING: RequisiteKind[] = ["signature", "stamp_production", "stamp_asbuilt"];

/**
 * Рабочий (исполнительный) чертёж или схема по заголовку. Паспорта, журналы, акты и прочие документы ИД —
 * не чертежи: слова «чертёж» в их заголовке нет. «ё» и «е» равнозначны.
 */
export const isWorkingDrawing = (title: string | null): boolean =>
  Boolean(title && /(рабоч|исполнительн)\p{L}*\s+(чертеж|схем)/iu.test(title.replace(/ё/gi, "е")));
const LABEL: Record<RequisiteKind, string> = { seal: "печать", signature: "подпись", stamp_production: "штамп «В производство работ»", stamp_asbuilt: "штамп «Выполнено согласно проекту»", date: "дата", reg_number: "регистрационный номер" };

/** Растровые и PDF-документы: только у них реквизит виден на изображении. У DOCX/XML геометрии нет. */
const VISUAL: Kind[] = ["pdf", "jpg", "png", "tif"];

/** Электронная подпись в реестре — визуальной подписи на листе нет по определению. */
export const isElectronicallySigned = (s: string | null): boolean => Boolean(s && /^(UKEP|УКЭП|UNEP|УНЭП|EP|ЭП)$/i.test(s.trim()));

export function evaluateRequisites(docs: IdDoc[]): RequisiteCheck[] {
  const out: RequisiteCheck[] = [];
  for (const d of docs) {
    if (!VISUAL.includes(d.kind) || d.revision_role === "SUPERSEDED" || electronicallySigned(isElectronicallySigned(d.signature_status), d.signature_check)) continue; // OS-INSP-1.2.14
    const found = new Set(d.requisites.map((r) => r.kind));
    const drawing = isWorkingDrawing(d.title);
    const missing = (drawing ? REQUIRED_DRAWING : REQUIRED).filter((k) => !found.has(k));
    if (!missing.length) continue;
    const names = missing.map((k) => LABEL[k]).join(", ");
    out.push({
      param_code: `REQ-${d.client_file_id}`,
      title: `${drawing ? "Штампы и реквизиты рабочего чертежа ИД" : "Реквизиты документа ИД"}: ${d.document_code} ред. ${d.revision}`,
      status: "MISSING_EVIDENCE",
      expected: `обязательный реквизит: ${names}`,
      actual: found.size ? `найдено: ${[...found].map((k) => LABEL[k]).join(", ")}` : null,
      reason: `На документе ${d.file_name} не найден обязательный реквизит (${names}); в реестре подпись ${d.signature_status ?? "не указана"}, ${d.signature_check ? `проверка электронной подписи: ${d.signature_check.status} — ${d.signature_check.reason}` : "электронной подписи нет"}. Проверьте скан вручную или загрузите подписанную редакцию.`,
      file_id: d.file_id,
    });
  }
  return out;
}
