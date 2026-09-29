// Вид «count» (T-175, CMP-07): счётный параметр — этажность М-007, количество квартир М-010. Целые без допуска, двойной
// подсчёт внутри стадии понижает вывод, источник подсчёта (текст, таблица, чертёж, расчёт). Оператор — count-param.ts.
// Извлекатель count_mentions — в ML тот же разбор чисел, что у quantity_mentions (ml/inspector_ml/extractor_kinds.py).
import { z } from "zod";
import { countSourceOf, evaluateCountParam, type CountMention } from "../count-param.ts";
import { baseMention, registerKind, type KindEvaluation, type KindMention } from "../param-kinds.ts";

type CountKindMention = KindMention & CountMention;

const Exclude = z.object({ code: z.string(), pattern: z.string(), why: z.string(), scope: z.enum(["between", "mention", "value"]).optional() });

export const count = registerKind<CountKindMention>({
  kind: "count",
  value: z.object({ kind: z.literal("count"), unit: z.string().min(1), count_note: z.string() }),
  // та же форма, что у quantity_mentions: оборот, окно, единицы, связки, отсев
  extractor: z.object({
    kind: z.literal("count_mentions"),
    anchor: z.string(),
    window: z.number().int().positive(),
    units: z.array(z.string()),
    superscripts: z.array(z.string()),
    fillers: z.array(z.string()),
    stop: z.array(z.string()).default([]),
    max_strangers: z.number().int().nonnegative().optional(),
    exclude: z.array(Exclude),
    // T-187: значение — только в строке оборота; формы «число перед словом» и отсев по предложению (count_mentions.py)
    same_line: z.boolean().optional(),
    extra: z.array(z.object({ form: z.string().optional(), pattern: z.string().min(1), need: z.string().optional(), ignore: z.array(z.string()).optional() })).optional(),
    page_prefer: z.object({ code: z.string(), prefer: z.string().min(1), demote: z.string().min(1), why: z.string() }).optional(),
    sentence_exclude: z.array(z.object({ code: z.string(), pattern: z.string().min(1), why: z.string(), scope: z.enum(["before", "sentence"]).optional() })).optional(),
  }),
  mentions: (rows) =>
    rows
      .filter((r) => r.value_num !== null)
      .map((r) => {
        const b = baseMention(r);
        return { ...b, num: r.value_num!, count_source: countSourceOf(b.meta) } as CountKindMention;
      }),
  evaluate: ({ param, passport, mentions, loadedStages, profile, kitBases, pdKitPresent }) => {
    const v = passport.value as { unit?: string };
    const ev = evaluateCountParam({ param, passport: { unit: v.unit ?? "шт.", sources: passport.sources, link: passport.link.by === "base_cipher" ? "base_cipher" : null }, mentions, loadedStages, profile, kitBases, pdKitPresent });
    return ev as unknown as KindEvaluation<CountKindMention>;
  },
});
