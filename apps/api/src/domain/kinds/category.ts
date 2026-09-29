// Вид «category» (T-176, T-186): CMP-05 SUBST — марка, материал, тип по семейству справочника аналогов. Код вида —
// domain/category-param.ts; здесь только регистрация: упоминания из строк реестра проходят белый список полей ML
// (categoryFields), ML получает написания канона семейства (familyAliases). Правила — OS-INSP-2.2.70–2.2.75, 3.1.60–3.1.65.
import { familyOf } from "../analogs.ts";
import { CategoryExtractor, CategoryValue, categoryFields, categoryPassport, evaluateCategoryParam, familyAliases, showCategory, type CategoryMention } from "../category-param.ts";
import { registerKind, type KindEvaluation, type KindMention } from "../param-kinds.ts";

type CatKindMention = KindMention & CategoryMention;
const famName = (v: Record<string, unknown>) => String(v.family);

export const category = registerKind<KindMention>({
  kind: "category",
  value: CategoryValue,
  extractor: CategoryExtractor,
  spec: (x) => ({ ...x.extractor, aliases: familyAliases(familyOf(famName(x.value))) }),
  evaluate: ({ param, passport, mentions, loadedStages, profile, kitBases, pdKitPresent }) => {
    const f = familyOf(famName(passport.value));
    const cp = categoryPassport({ code: param.code, value: passport.value as never, sources: passport.sources, link: passport.link }, { [famName(passport.value)]: f })!;
    const ms: CatKindMention[] = mentions.flatMap((m) => {
      const x = categoryFields(f, m.value, m.meta);
      return x ? [{ ...m, ...x, quote: m.quote.slice(0, 400) }] : [];
    });
    const ev = evaluateCategoryParam({ param, passport: cp, mentions: ms, loadedStages, profile, kitBases, pdKitPresent });
    // цитата опоры гипотезы — значение словами (фактическое значение кандидата при переводе гипотезы)
    const suspicions = ev.suspicions.map((s) => ({ ...s, mentions: (s.mentions as CatKindMention[]).map((m) => ({ ...m, quote: showCategory(f, m) })) }));
    return { ...ev, suspicions, provenance: { ...ev.provenance, decisions: ev.decisions } } as unknown as KindEvaluation<KindMention>;
  },
});
