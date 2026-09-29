// Виды presence (CMP-09) и method (CMP-23) в реестре видов (T-186, T-212): мероприятие есть / исключено / не упомянуто
// и смена метода по словарю паспорта. Предметная логика — общий модуль domain/presence-param.ts (W1 T-176 и W2 берут
// его же); здесь — только регистрация: схемы паспорта, строки извлечения → упоминания, оценка, спецификация для ML.
// Правила — OS-INSP-2.2.135–2.2.144, 3.1.150–3.1.159. Извлекатель ML — ml/inspector_ml/presence_mentions.py.
import { z } from "zod";
import { baseMention, registerKind, type KindEvaluation, type KindMention, type KindPassport, type KindRow } from "../param-kinds.ts";
import { evaluatePresenceParam, MethodValue, PresenceExtractor, presenceExtractorSpec, presencePassport, PresenceValue, type PresenceMention } from "../presence-param.ts";

/** Упоминание вида: общие поля реестра + состояние, аспект, метод, число и подсказка извлечения. */
export type PresenceKindMention = KindMention & PresenceMention;

/**
 * Строки извлечения → упоминания (OS-INSP-3.1.150): только строки presence_mentions с состоянием и аспектом. meta — вход
 * от модуля, читающего недоверенные PDF: берутся только известные поля и значения.
 */
export function presenceMentions(rows: KindRow[]): PresenceKindMention[] {
  const out: PresenceKindMention[] = [];
  for (const r of rows) {
    const b = baseMention(r);
    const m = b.meta;
    if ((m.state !== "present" && m.state !== "absent") || typeof m.aspect !== "string") continue;
    out.push({
      ...b,
      state: m.state,
      aspect: m.aspect,
      term: typeof m.term === "string" ? m.term : null,
      count: typeof m.count === "number" ? m.count : null,
      hint: m.hint === "implied" || m.hint === "reference" || m.hint === "other" ? m.hint : null,
    });
  }
  return out;
}

const evaluate = (x: { passport: KindPassport } & Omit<Parameters<typeof evaluatePresenceParam>[0], "passport" | "mentions"> & { mentions: PresenceKindMention[] }) =>
  evaluatePresenceParam({ ...x, passport: presencePassport(x.passport)! }) as unknown as KindEvaluation<PresenceKindMention>;

/** Вид presence: мероприятие по аспектам. */
export const presenceKind = registerKind<PresenceKindMention>({
  kind: "presence",
  value: PresenceValue,
  extractor: PresenceExtractor,
  mentions: presenceMentions,
  evaluate,
  spec: presenceExtractorSpec,
});

/** Вид method: метод по словарю; извлекатель тот же, свой kind — реестр держит один вид на извлекатель. */
export const methodKind = registerKind<PresenceKindMention>({
  kind: "method",
  value: MethodValue,
  extractor: PresenceExtractor.extend({ kind: z.literal("method_mentions") }),
  mentions: presenceMentions,
  evaluate,
  spec: presenceExtractorSpec,
});
