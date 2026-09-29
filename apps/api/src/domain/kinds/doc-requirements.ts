// Вид «doc_requirements» (T-213, реестр T-186): узлы временного расчленения — М-096. Извлечение — ML
// doc_requirements.py (ENT-22 акт ИД и реквизиты, ENT-17 сечения), сравнение — domain/doc-requirements.ts
// (CMP-25 полнота ИД, CMP-22 даты акта, CMP-03 сечения).
import { z } from "zod";
import { baseMention, registerKind, type KindMention, type KindPassport, type KindRow } from "../param-kinds.ts";
import { evaluateDocRequirements, type DocReqMention, type DocReqPassport } from "../doc-requirements.ts";

const Doc = z.object({ id: z.string().min(1), title: z.string().min(1), pattern: z.string().min(1) });
export const DocReqValue = z.object({ kind: z.literal("doc_requirements"), docs: z.array(Doc).min(1), sections: z.boolean() });

/** Конфигурация сравнения для domain/doc-requirements.ts из показателя паспорта. */
export function docReqPassportOf(x: KindPassport): DocReqPassport {
  const v = DocReqValue.parse(x.value);
  return { docs: v.docs.map(({ id, title }) => ({ id, title })), sections: v.sections };
}

const KINDS = new Set(["doc", "section", "section_unreadable", "requisite_gap", "act_date", "work_date", "not_applicable"]);

/** Строки извлечения → находки М-096 по meta.kind; сечение без чисел размеров и незнакомый kind — мимо. */
export function docReqMentions(rows: KindRow[]): Array<KindMention & DocReqMention> {
  return rows.flatMap((r) => {
    const b = baseMention(r);
    const m = b.meta as Record<string, any>;
    if (!KINDS.has(m.kind)) return [];
    if (m.kind === "doc" && typeof m.doc !== "string") return [];
    if ((m.kind === "act_date" || m.kind === "work_date") && !/^(?:\d{4})?-\d{2}-\d{2}$/.test(String(m.date))) return [];
    if (m.kind === "section" && !(Array.isArray(m.dims) && m.dims.length && m.dims.every((d: unknown) => Number.isFinite(Number(d))))) return [];
    const extra =
      m.kind === "doc" ? { doc: m.doc }
      : m.kind === "section" ? { profile: String(m.profile).slice(0, 20), dims: m.dims.slice(0, 4).map(Number), label: (r.value_text ?? String(m.profile)).slice(0, 80), excluded_why: typeof m.excluded_why === "string" ? m.excluded_why.slice(0, 240) : null }
      : m.kind === "requisite_gap" ? { label: String(m.label ?? r.value_text ?? "").slice(0, 80) }
      : m.kind === "act_date" || m.kind === "work_date" ? { node: String(m.node).slice(0, 20), date: String(m.date).slice(0, 10) }
      : {};
    // W3-06: цитата, причина отсева и подписи из ML обрезаются
    return [{ ...b, quote: b.quote.slice(0, 240), excluded_why: typeof b.excluded_why === "string" ? b.excluded_why.slice(0, 240) : null, kind: m.kind, ...extra } as KindMention & DocReqMention];
  });
}

export const docRequirements = registerKind<KindMention & DocReqMention>({
  kind: "doc_requirements",
  value: DocReqValue,
  extractor: z.object({ kind: z.literal("doc_requirements"), section_anchor: z.string().nullable(), window: z.number().int().positive() }),
  mentions: docReqMentions,
  // перечень документов ИД едет в ML вместе с экстрактором
  spec: (x) => ({ ...x.extractor, docs: DocReqValue.parse(x.value).docs.map(({ id, pattern }) => ({ id, pattern })) }),
  evaluate: ({ param, passport, mentions, loadedStages, profile }) => evaluateDocRequirements({ param, passport: docReqPassportOf(passport), mentions, loadedStages, profile }),
});
