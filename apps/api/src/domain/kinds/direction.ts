// Вид «направление» в реестре видов (T-214 → T-186, OS-INSP-7.1.20–7.1.24): М-043 и М-106 — направление открывания
// эвакуационных дверей. Логика — domain/direction-param.ts (схемы паспорта, выбор, CMP-17/06/30); здесь только
// регистрация: схемы value и extractor, строки извлечения → упоминания, оценка. Гипотезы пишет общий путь recompute.
import { baseMention, registerKind, type KindMention, type KindRow } from "../param-kinds.ts";
import { DirectionExtractor, DirectionValue, directionPassport, evaluateDirectionParam, type DirectionMention } from "../direction-param.ts";

export type DirectionKindMention = DirectionMention & KindMention;

const VALUES = new Set(["outward", "inward", "sliding", "blocks", "hand", "graphic"]);

/**
 * Упоминания направления из строк extractions (OS-INSP-2.2.152). meta — ответ модуля, который читает недоверенные PDF:
 * берутся только известные поля и значения, марка и корпус обрезаются, чужое отбрасывается.
 */
export function directionMentions(rows: KindRow[]): DirectionKindMention[] {
  return rows
    .filter((r) => VALUES.has(r.value_text ?? ""))
    .map((r) => {
      const b = baseMention(r);
      const m = b.meta;
      return {
        ...b,
        // W3-06: цитата и причина отсева — строки из недоверенного PDF; в карточку и гипотезы идут обрезанными
        quote: b.quote.slice(0, 500),
        excluded_why: b.excluded_why === null ? null : b.excluded_why.slice(0, 300),
        value: r.value_text as DirectionMention["value"],
        mark: typeof m.mark === "string" ? m.mark.slice(0, 20) : null,
        evac: typeof m.evac === "boolean" ? m.evac : null,
        building: typeof m.building === "string" ? m.building.slice(0, 10) : null,
        remaining_m: typeof m.remaining_m === "number" && Number.isFinite(m.remaining_m) ? m.remaining_m : null,
        exemption: typeof m.exemption === "string" ? m.exemption.slice(0, 300) : null,
      };
    });
}

export const direction = registerKind<DirectionKindMention>({
  kind: "direction",
  value: DirectionValue,
  extractor: DirectionExtractor,
  mentions: directionMentions,
  evaluate: ({ param, passport, mentions, loadedStages, profile }) => {
    const ev = evaluateDirectionParam({ param, passport: directionPassport(passport)!, mentions, loadedStages, profile });
    // упоминания гипотез — те же объекты, что пришли на вход (DirectionKindMention)
    return ev as typeof ev & { suspicions: Array<(typeof ev.suspicions)[number] & { mentions: DirectionKindMention[] }> };
  },
});
