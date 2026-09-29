// Вид «layers» (T-176, T-186): CMP-21 LAYER-SEQ — послойный состав конструкции, выравнивание Нидлмана — Вунша.
// Код вида — domain/layers-param.ts; здесь только регистрация: состав из строк реестра проходит белый список полей ML
// (layersFields), ML получает написания канона семейства. Правила — OS-INSP-2.2.76–2.2.79, 3.1.66–3.1.69.
import { familyOf } from "../analogs.ts";
import { familyAliases } from "../category-param.ts";
import { evaluateLayersParam, LayersExtractor, layersFields, layersPassport, LayersValue, showStack, type LayersMention } from "../layers-param.ts";
import { registerKind, type KindEvaluation, type KindMention } from "../param-kinds.ts";

type LayKindMention = KindMention & LayersMention;
const famName = (v: Record<string, unknown>) => String(v.family);

export const layers = registerKind<KindMention>({
  kind: "layers",
  value: LayersValue,
  extractor: LayersExtractor,
  spec: (x) => ({ ...x.extractor, aliases: familyAliases(familyOf(famName(x.value))) }),
  evaluate: ({ param, passport, mentions, loadedStages, profile, kitBases, pdKitPresent }) => {
    const f = familyOf(famName(passport.value));
    const lp = layersPassport({ code: param.code, value: passport.value as never, sources: passport.sources, link: passport.link }, { [famName(passport.value)]: f })!;
    const ms: LayKindMention[] = mentions.flatMap((m) => {
      const x = layersFields(f, m.meta);
      return x ? [{ ...m, ...x, quote: m.quote.slice(0, 400) }] : [];
    });
    const ev = evaluateLayersParam({ param, passport: lp, mentions: ms, loadedStages, profile, kitBases, pdKitPresent });
    const suspicions = ev.suspicions.map((s) => ({ ...s, mentions: (s.mentions as LayKindMention[]).map((m) => ({ ...m, quote: showStack(f, m.layers) })) }));
    return { ...ev, suspicions, provenance: { ...ev.provenance, alignment: ev.alignment } } as unknown as KindEvaluation<KindMention>;
  },
});
