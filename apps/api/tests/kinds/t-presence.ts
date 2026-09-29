// Тестовый вид параметра «t_presence» (T-186): регистрируется в реестре так же, как вид волны — модулем с registerKind.
// Синтетика: значение стадии — первое неотсеянное упоминание («есть»/«нет»); ПД и РД совпали — NEGATIVE_VERIFIED,
// разошлись — CANDIDATE, нет упоминаний — MISSING_EVIDENCE; разные значения внутри стадии — гипотеза.
import { z } from "zod";
import { registerKind, type KindMention } from "../../src/domain/param-kinds.ts";
import type { Fragment, Stage } from "../../src/domain/types.ts";

const frag = (m: KindMention, kind: Fragment["kind"]): Fragment => ({
  file_id: m.file_id, sha256: m.sha256, stage: m.stage, document_code: m.document_code, revision: m.revision, approval_status: m.approval_status,
  page: m.page, bbox: m.bbox, role: m.role, value: m.value ?? "", kind,
});

export const tPresence = registerKind({
  kind: "t_presence",
  value: z.object({ kind: z.literal("t_presence"), words: z.array(z.string()).min(2) }),
  extractor: z.object({ kind: z.literal("t_presence_mentions"), anchor: z.string() }),
  spec: (x) => ({ ...x.extractor, words: x.value.words }),
  quote: (m) => `присутствие: ${m.value}`,
  evaluate: ({ mentions }) => {
    const live = mentions.filter((m) => !m.excluded);
    const at = (s: Stage) => live.filter((m) => m.stage === s);
    const pd = at("PD")[0] ?? null;
    const rd = at("RD")[0] ?? null;
    const suspicions = (["PD", "RD"] as Stage[])
      .filter((s) => new Set(at(s).map((m) => m.value)).size > 1)
      .map((s) => ({ stage: s, description: `в ${s} разные значения присутствия`, mentions: at(s), dedup_key: `presence:${s}` }));
    const status = !pd || !rd ? "MISSING_EVIDENCE" : pd.value === rd.value ? "NEGATIVE_VERIFIED" : "CANDIDATE";
    return {
      status, expected: pd?.value ?? null, actual: rd?.value ?? null, delta: null, reason: `t_presence: ${status}`,
      fragments: [...(pd ? [frag(pd, "expected")] : []), ...(rd ? [frag(rd, "actual")] : [])],
      stage_notes: { PD: pd ? "USED" : "NO_VALUE", RD: rd ? "USED" : "NO_VALUE" },
      suspicions,
      provenance: { ops: ["T-PRESENCE"], mentions: mentions.map((m) => ({ stage: m.stage, use: m === pd || m === rd ? ("chosen" as const) : ("considered" as const), why: m.excluded, value: m.value ?? "" })) },
    };
  },
});
