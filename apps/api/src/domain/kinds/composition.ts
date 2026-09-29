// Вид «composition» (T-175, CMP-08, CMP-11): состав по типам — квартирография М-011. Состав стадии из одного документа,
// подтипы внутри типа складываются, появившийся или исчезнувший тип и сдвиг доли — кандидат. Оператор — aggregate-param.ts.
import { z } from "zod";
import { evaluateCompositionParam, stageComposition, type CompositionMention } from "../aggregate-param.ts";
import { baseMention, registerKind, type KindEvaluation, type KindMention } from "../param-kinds.ts";
import { STAGES } from "../types.ts";

type CompositionKindMention = KindMention & CompositionMention;

export const composition = registerKind<CompositionKindMention>({
  kind: "composition",
  value: z.object({ kind: z.literal("composition"), tolerance_pp: z.number().nonnegative(), separate_types: z.array(z.string().min(1)).optional(), composition_note: z.string() }),
  extractor: z.object({ kind: z.literal("composition_mentions"), window: z.number().int().positive(), types: z.array(z.object({ key: z.string().min(1), pattern: z.string().min(1) })).min(2) }),
  mentions: (rows) =>
    rows
      .filter((r) => r.value_text && r.value_num !== null)
      .map((r) => {
        const b = baseMention(r);
        return { ...b, type: r.value_text!, sub: typeof b.meta.sub === "string" ? b.meta.sub : "", num: r.value_num! } as CompositionKindMention;
      }),
  evaluate: ({ param, passport, mentions, loadedStages }) => {
    const v = passport.value as { tolerance_pp?: number; separate_types?: string[] };
    const p = { tolerance_pp: Number(v.tolerance_pp ?? 0), separate: v.separate_types ?? [], sources: passport.sources };
    const ev = evaluateCompositionParam({ param, passport: p, mentions, loadedStages });
    // provenance: какие упоминания стали составом стадии (взяты), остальные — учтены или отсеяны с причиной
    const chosen = new Set(STAGES.flatMap((s) => stageComposition(mentions, s, p)).map((m) => `${m.file_id}@${m.page}:${m.type}`));
    const provenance = {
      ops: ["ENT-16", "NRM-01", "NRM-06", "LNK-01", "VER-15", "CMP-08", "CMP-11", "VER-02", "DEC-01"],
      mentions: mentions.map((m) => ({
        stage: m.stage, use: (m.excluded ? "dropped" : chosen.has(`${m.file_id}@${m.page}:${m.type}`) ? "chosen" : "considered") as "dropped" | "chosen" | "considered",
        why: m.excluded_why, value: `${m.type}: ${m.num}`, document_code: m.document_code, file_id: m.file_id, page: m.page, quote: m.quote, bbox: m.bbox,
      })),
    };
    return { ...ev, suspicions: [], provenance } as KindEvaluation<CompositionKindMention>;
  },
});
