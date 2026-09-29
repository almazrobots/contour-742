// Эшелоны: L1 (правила CMP-05 OS-INSP-3.1.60–3.1.66), L3 (опора ПД по позиции и элементу, «или аналог» без
// характеристик), L5 (fast-check: CANDIDATE тогда и только тогда, когда замена не EQUIVALENT), L6 (недоверенные поля
// ответа ML, другой комплект ПД, противоречие внутри стадии). Название теста — ссылка трассы, T-176.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalogsFile, analogVerdict, familyOf, setFamilies } from "../src/domain/analogs.ts";
import { category } from "../src/domain/kinds/category.ts";
import { kindSlice } from "../src/domain/param-kinds.ts";
import {
  categoryConflicts, categoryFields, categoryPassport, evaluateCategoryParam, familyAliases, pickCategory, referenceOf, showCategory, substDecision, valueKey,
  type CategoryMention, type CategoryPassport,
} from "../src/domain/category-param.ts";
import { ParamPassport } from "../src/domain/passport.ts";
import type { Param, Stage } from "../src/domain/types.ts";

let ROOT = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(ROOT, "data/seed/matrix.json"))) ROOT = dirname(ROOT);
const F = AnalogsFile.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/analogs.json"), "utf8"))).families;
const SOURCES: CategoryPassport["sources"] = { PD: [{ discipline: "ИОС" }, { discipline: "*" }], RD: [{ discipline: "ВК" }, { discipline: "*" }], ID: [{ discipline: "*" }] };
const PIPES: CategoryPassport = { family: F.pipe_pressure, items: { В1: "В1", Т3: "Т3" }, elements: { riser: "стояки", branch: "подводки" }, sources: SOURCES, link: "base_cipher" };
const FANS: CategoryPassport = { family: F.fan, items: null, elements: null, sources: SOURCES, link: null };
const PARAM: Param = {
  code: "M-072", section: "ИОС2", parameter_name: "Материал и класс давления напорных труб В1/Т3", unit: "Марка", source_pd: "Спецификация материалов (ИОС2)", source_rd: "Спецификация оборудования (ВК)",
  source_id: "Паспорта и сертификаты на трубы", trigger_logic: "Подмена оцинкованных/чугунных труб на полипропилен без перерасчета расширения.", review_priority: "MEDIUM", data_type: "enum",
  compare: { kind: "decrease" }, anchors: ["Материал"], regex_pattern: null, value_scale: null, applicability: null, is_active: true,
};

let seq = 0;
const M = (stage: Stage, value: string, over: Partial<CategoryMention> = {}): CategoryMention => ({
  stage, file_id: `f-${stage}-${++seq}`, sha256: "a".repeat(64), document_code: stage === "PD" ? "П-2099-01-001-ИОС2" : "Р-2099-01-001-ВК", revision: "0",
  approval_status: stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED", role: "CURRENT", discipline: stage === "PD" ? "ИОС" : "ВК", base: "2099-01-001",
  value, alts: [], item: null, element: null, or_analog: false, chars: {}, excluded: null, excluded_why: null, page: 3, bbox: [0.1, 0.2, 0.3, 0.25], quote: `… ${value} …`, confidence: 1,
  ...over,
});
const run = (mentions: CategoryMention[], p: CategoryPassport = PIPES, over: Partial<Parameters<typeof evaluateCategoryParam>[0]> = {}) =>
  evaluateCategoryParam({ param: PARAM, passport: p, mentions, loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set(["2099-01-001"]), ...over });

describe("CMP-05 SUBST: замена марки, материала, типа", () => {
  it("то же значение в ПД и РД — NEGATIVE_VERIFIED без дельты", () => {
    const ev = run([M("PD", "STEEL_GALV", { item: "В1" }), M("RD", "STEEL_GALV", { item: "В1" })]);
    expect(ev).toMatchObject({ status: "NEGATIVE_VERIFIED", delta: null, reason: "Марка и материал не изменены" });
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
    expect(ev.provenance.ops).toContain("CMP-05");
  });

  it("замена на EQUIVALENT по таблице аналогов — NEGATIVE_VERIFIED с пометкой и источником", () => {
    const ev = run([M("PD", "PPR", { item: "Т3" }), M("RD", "PPR_FIBER", { item: "Т3" })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toMatch(/^Замена без ухудшения: Т3: замена на эквивалентный аналог/);
    expect(ev.reason).toContain("ГОСТ 32415-2013");
    expect(ev.delta).toBe("полипропилен PP-R (ГОСТ 32415-2013) → полипропилен PP-R, армированный стекловолокном или алюминием");
    expect(ev.decisions[0]).toMatchObject({ kind: "EQUIVALENT", item: "Т3", verdict: { verdict: "EQUIVALENT" } });
  });

  it("замена на NOT_EQUIVALENT — CANDIDATE с причиной, источником и правилом Матрицы", () => {
    const ev = run([M("PD", "STEEL_GALV", { item: "В1" }), M("RD", "PPR", { item: "В1" })]);
    expect(ev).toMatchObject({ status: "CANDIDATE", expected: "сталь оцинкованная водогазопроводная (ГОСТ 3262-75)", actual: "полипропилен PP-R (ГОСТ 32415-2013)" });
    expect(ev.reason).toMatch(/^ПД → РД: В1: сталь оцинкованная .* заменено на полипропилен PP-R .* — полимер вместо металла/);
    expect(ev.reason).toContain("СП 30.13330.2020");
    expect(ev.reason).toContain("Правило Матрицы: Подмена оцинкованных");
    expect(ev.fragments.map((f) => [f.stage, f.kind])).toEqual([["PD", "expected"], ["RD", "actual"]]);
  });

  it("замены нет в таблице аналогов (UNKNOWN) — CANDIDATE: неизвестная замена не прячется", () => {
    const ev = run([M("PD", "PEX"), M("RD", "PVC_U")]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.decisions[0].kind).toBe("UNKNOWN");
    expect(ev.reason).toContain("замены нет в таблице аналогов");
  });

  it("«или аналог» в ПД: характеристики РД хуже — CANDIDATE; не хуже — NEGATIVE_VERIFIED; не указаны — NOT_COMPARABLE", () => {
    const worse = run([M("PD", "STEEL_GALV", { or_analog: true }), M("RD", "PPR")]);
    expect(worse.status).toBe("CANDIDATE");
    expect(worse.decisions[0].kind).toBe("CHARS_WORSE");
    expect(worse.reason).toMatch(/аналог хуже ПД/);
    const ok = run([M("PD", "PPR", { or_analog: true }), M("RD", "MLP")]);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(ok.decisions[0].kind).toBe("CHARS_OK");
    const noChars = run([M("PD", "Systemair K 315 M", { or_analog: true, item: "В1" }), M("RD", "Вентс ВКК 315", { item: "В1" })], FANS);
    expect(noChars.status).toBe("NOT_COMPARABLE");
    expect(noChars.reason).toMatch(/характеристики для сравнения аналога не указаны/);
  });

  it("«или аналог» у модели вентилятора: производительность и давление из текста решают, а не марка", () => {
    const pd = M("PD", "Systemair K 315 M", { or_analog: true, item: "П1", chars: { flow: 2500, pressure: 300 } });
    expect(run([pd, M("RD", "Вентс ВКК 315", { item: "П1", chars: { flow: 2600, pressure: 310 } })], FANS).status).toBe("NEGATIVE_VERIFIED");
    const w = run([pd, M("RD", "Вентс ВКК 315", { item: "П1", chars: { flow: 2000, pressure: 310 } })], FANS);
    expect(w.status).toBe("CANDIDATE");
    expect(w.reason).toContain("производительность 2500 → 2000 м³/ч");
  });

  it("открытая марка: та же модель в другом написании — не замена; другая модель без «или аналог» — CANDIDATE", () => {
    expect(run([M("PD", "Systemair K 315 M", { item: "П1" }), M("RD", "SYSTEMAIR K315M", { item: "П1" })], FANS).status).toBe("NEGATIVE_VERIFIED");
    expect(run([M("PD", "ВКР-5,0-4", { item: "В2" }), M("RD", "BKP 5.0 4", { item: "В2" })], FANS).status).toBe("NEGATIVE_VERIFIED");
    const ev = run([M("PD", "Systemair K 315 M", { item: "П1" }), M("RD", "Systemair K 400 M", { item: "П1" })], FANS);
    expect(ev.status).toBe("CANDIDATE");
    expect(valueKey(F.fan, "k 315 m")).toBe("K315M");
    expect(valueKey(F.pipe_pressure, "PPR")).toBe("PPR");
  });

  it("варианты ПД «A или B»: РД взял вариант — не замена", () => {
    const ev = run([M("PD", "PPR", { alts: ["MLP"] }), M("RD", "MLP")]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(showCategory(F.pipe_pressure, { value: "PPR", alts: ["MLP"], or_analog: true })).toBe("полипропилен PP-R (ГОСТ 32415-2013) или металлополимерные трубы PEX-AL-PEX (PE-RT-AL-PE-RT) или аналог");
  });

  it("опора ПД: та же позиция и элемент → позиция без элемента → позиция с любым элементом → общее значение", () => {
    const pdRiser = M("PD", "STEEL_GALV", { item: "В1", element: "riser" });
    const pdBranch = M("PD", "PPR", { item: "В1", element: "branch" });
    const pdGeneral = M("PD", "COPPER");
    const pdT3 = M("PD", "MLP", { item: "Т3" });
    const pd = [pdRiser, pdBranch, pdGeneral, pdT3];
    expect(referenceOf(pd, { item: "В1", element: "riser" })).toEqual([pdRiser]);
    expect(referenceOf(pd, { item: "В1", element: "main" })).toEqual([pdRiser, pdBranch]);
    expect(referenceOf(pd, { item: "Т3", element: "riser" })).toEqual([pdT3]);
    expect(referenceOf(pd, { item: "Т4", element: null })).toEqual([pdGeneral]);
    expect(referenceOf([pdRiser], { item: "Т4", element: null })).toEqual([]);
    // стояки остались сталью, подводки — PP-R: детализация РД не нарушение; стояки на PP-R — нарушение
    expect(run([pdRiser, pdBranch, M("RD", "STEEL_GALV", { item: "В1", element: "riser" }), M("RD", "PPR", { item: "В1", element: "branch" })]).status).toBe("NEGATIVE_VERIFIED");
    expect(run([pdRiser, pdBranch, M("RD", "PPR", { item: "В1", element: "riser" })]).status).toBe("CANDIDATE");
    // РД называет общий материал В1 из вариантов ПД по элементам — не нарушение
    expect(run([pdRiser, pdBranch, M("RD", "PPR", { item: "В1" })]).status).toBe("NEGATIVE_VERIFIED");
  });

  it("опора ПД с позицией без элемента предпочитается позиции с другим элементом", () => {
    const own = M("PD", "PEX", { item: "Т3" });
    const other = M("PD", "STEEL_GALV", { item: "Т3", element: "main" });
    expect(referenceOf([other, own], { item: "Т3", element: "branch" })).toEqual([own]);
  });

  it("позиции стадий не сопоставлены — NOT_COMPARABLE с перечнем позиций", () => {
    const ev = run([M("PD", "STEEL_GALV", { item: "В1" }), M("RD", "PPR", { item: "Т3" })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Позиции стадий не сопоставлены: ПД — В1; РД — Т3");
    expect(ev.decisions[0].kind).toBe("UNMATCHED");
  });

  it("ворота: применимость, актуальность редакции, комплектность — до сравнения", () => {
    expect(run([M("PD", "PPR"), M("RD", "PVC_U")], PIPES, { param: { ...PARAM, applicability: "has_water" }, profile: { has_water: false } }).status).toBe("NOT_APPLICABLE");
    const cl = run([M("PD", "PPR"), M("RD", "PVC_U", { role: "CONFLICT", revision: "2" })]);
    expect(cl).toMatchObject({ status: "CLARIFICATION_REQUIRED", reason: "Не определена актуальная редакция: Р-2099-01-001-ВК ред. 2" });
    const miss = run([M("PD", "PPR")]);
    expect(miss.status).toBe("MISSING_EVIDENCE");
    expect(miss.reason).toBe("Недостаточно источников для сравнения: марка или материал найдены только в ПД; нет значения в РД");
    expect(run([]).reason).toBe("Недостаточно источников для сравнения: марка или материал не найдены; нет значения в ПД, РД");
    expect(run([M("RD", "PPR")]).status).toBe("MISSING_EVIDENCE");
  });

  it("отсеянные упоминания и устаревшие редакции не участвуют; в карточке — с причиной", () => {
    const ev = run([M("PD", "STEEL_GALV"), M("RD", "PPR", { excluded: "EXISTING", excluded_why: "существующая сеть" }), M("RD", "STEEL_GALV", { role: "SUPERSEDED" }), M("RD", "STEEL_GALV")]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    const use = ev.provenance.mentions.map((m) => [m.stage, m.use, m.why]);
    expect(use).toContainEqual(["RD", "dropped", "существующая сеть"]);
    expect(use).toContainEqual(["RD", "dropped", "устаревшая редакция"]);
  });

  it("ПД — только комплект с шифром РД; другой комплект — справочно, а при его отсутствии — все упоминания ПД с пометкой", () => {
    const own = M("PD", "STEEL_GALV");
    const alien = M("PD", "PPR", { base: "7777-01" });
    const pk = pickCategory([own, alien], "PD", PIPES, new Set(["2099-01-001"]));
    expect(pk.considered).toEqual([own]);
    expect(pk.reference).toEqual([alien]);
    const none = pickCategory([alien], "PD", PIPES, new Set(["2099-01-001"]), true);
    expect(none.considered).toEqual([]);
    const loose = pickCategory([alien], "PD", PIPES, new Set(["2099-01-001"]));
    expect(loose.note).toMatch(/не связан с РД/);
    expect(pickCategory([alien], "PD", { ...PIPES, link: null }, new Set(["2099-01-001"])).considered).toEqual([alien]);
  });

  it("порядок упоминаний стадии: раздел по приоритету паспорта, затем редакция и уверенность", () => {
    const other = M("PD", "PPR", { discipline: "АР", confidence: 1 });
    const ios = M("PD", "PPR", { discipline: "ИОС", confidence: 0.5 });
    expect(pickCategory([other, ios], "PD", PIPES, new Set()).considered[0]).toBe(ios);
  });

  it("противоречие внутри стадии: разные значения одной позиции — гипотеза с каждым значением; варианты — не противоречие", () => {
    const a = M("PD", "STEEL_GALV", { item: "В1", discipline: "ИОС" });
    const b = M("PD", "PPR", { item: "В1", discipline: "АР" });
    const s = categoryConflicts({ considered: [a, b], reference: [], dropped: [], note: null }, "PD", PIPES);
    expect(s).toHaveLength(1);
    expect(s[0].description).toMatch(/^Внутреннее противоречие ПД \(В1\): сталь оцинкованная .* — ИОС, стр\. 3 \| полипропилен PP-R .* — АР, стр\. 3$/);
    expect(s[0].dedup_key).toMatch(/^category-conflict:PD:В1\|\*:/);
    expect(categoryConflicts({ considered: [a, M("PD", "PPR", { item: "В1", alts: ["STEEL_GALV"] })], reference: [], dropped: [], note: null }, "PD", PIPES)).toEqual([]);
    expect(categoryConflicts({ considered: [a, M("PD", "PPR", { item: "Т3" })], reference: [], dropped: [], note: null }, "PD", PIPES)).toEqual([]);
    const ev = run([a, b, M("RD", "STEEL_GALV", { item: "В1" })]);
    expect(ev.suspicions).toHaveLength(1);
  });

  it("несколько нарушений: в карточке — сначала NOT_EQUIVALENT, остальные в причине", () => {
    const ev = run([M("PD", "PEX", { item: "Т3" }), M("PD", "STEEL_GALV", { item: "В1" }), M("RD", "PVC_U", { item: "Т3" }), M("RD", "PPR", { item: "В1" })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.actual).toBe("полипропилен PP-R (ГОСТ 32415-2013)");
    expect(ev.reason).toMatch(/; ещё: Т3: /);
    expect(ev.fragments.filter((f) => f.kind === "actual")).toHaveLength(2);
  });

  it("решение по упоминанию: SAME, EQUIVALENT, NOT_EQUIVALENT, UNKNOWN, CHARS_* и UNMATCHED", () => {
    const pd = M("PD", "STEEL_GALV");
    expect(substDecision(PIPES, [pd], M("RD", "STEEL_GALV")).kind).toBe("SAME");
    expect(substDecision(PIPES, [pd], M("RD", "COPPER")).kind).toBe("EQUIVALENT");
    expect(substDecision(PIPES, [pd], M("RD", "PPR")).kind).toBe("NOT_EQUIVALENT");
    expect(substDecision(PIPES, [M("PD", "PE")], M("RD", "PPR")).kind).toBe("UNKNOWN");
    expect(substDecision(PIPES, [], M("RD", "PPR")).kind).toBe("UNMATCHED");
    // несколько опор: EQUIVALENT хоть от одной — не нарушение
    expect(substDecision(PIPES, [M("PD", "PE"), M("PD", "PPR")], M("RD", "PPR_FIBER")).kind).toBe("EQUIVALENT");
    // «или аналог» у одной опоры из двух: характеристика решает
    expect(substDecision(PIPES, [M("PD", "PPR", { or_analog: true, chars: { pn: 25 } })], M("RD", "MLP")).kind).toBe("CHARS_WORSE");
  });

  it("CANDIDATE тогда и только тогда, когда вердикт замены не EQUIVALENT (свойство, закрытое семейство)", () => {
    const keys = Object.keys(F.pipe_pressure.canon);
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.constantFrom(...keys), (a, b) => {
        const ev = run([M("PD", a), M("RD", b)]);
        const eq = analogVerdict(F.pipe_pressure, a, b).verdict === "EQUIVALENT";
        expect(ev.status).toBe(eq ? "NEGATIVE_VERIFIED" : "CANDIDATE");
      }),
    );
  });

  it("поля ответа ML — белый список: чужой ключ канона, прототип, характеристика вне семейства и не-число отбрасываются", () => {
    const f = F.pipe_pressure;
    expect(categoryFields(f, "PPR", { item: " В1 ", element: "riser", alts: ["MLP", "constructor", 5, "PPR"], or_analog: true, chars: { pn: 20, t_max: "95", fire: "Г4", evil: 1, __proto__: { x: 1 } } })).toEqual({
      value: "PPR", alts: ["MLP"], item: "В1", element: "riser", or_analog: true, chars: { pn: 20, fire: "Г4" },
    });
    expect(categoryFields(f, "constructor", {})).toBeNull();
    expect(categoryFields(f, "NOPE", {})).toBeNull();
    expect(categoryFields(f, null, {})).toBeNull();
    expect(categoryFields(f, "  ", {})).toBeNull();
    expect(categoryFields(f, "PPR", { or_analog: "true", chars: [1, 2], alts: "MLP", item: "x".repeat(99) })).toEqual({ value: "PPR", alts: [], item: "x".repeat(40), element: null, or_analog: false, chars: {} });
    expect(categoryFields(f, "PPR", { chars: { fire: "Г9", pn: Number.POSITIVE_INFINITY } })!.chars).toEqual({});
    expect(categoryFields(F.fan, "Systemair K 315 M", { alts: ["K400", "y".repeat(200)] })!.alts).toEqual(["K400"]);
  });

  it("паспорт категории: семейство справочника обязательно; написания канона уходят экстрактору через реестр видов", () => {
    const pp = ParamPassport.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/passports/M-075.json"), "utf8")));
    const cp = categoryPassport(pp, F)!;
    expect(cp.family.title).toBe(F.pipe_sewer.title);
    expect(cp.items).toMatchObject({ К1: expect.any(String), К2: expect.any(String) });
    expect(() => categoryPassport({ ...pp, value: { ...pp.value, family: "nope" } as never }, F)).toThrow(/семейства nope нет/);
    expect(categoryPassport({ ...pp, value: { kind: "ordinal", scale: ["a", "b"], order_note: "", constraint_markers: [] } }, F)).toBeNull();
    // вид в реестре: ML получает написания канона семейства; семейства нет — громкий отказ
    setFamilies(F);
    expect((category.spec!(kindSlice(pp)) as { aliases: unknown }).aliases).toEqual(familyAliases(F.pipe_sewer));
    expect(() => familyOf("nope", "M-075")).toThrow(/паспорт M-075: семейства nope нет/);
    expect(() => familyOf("constructor")).toThrow(/семейства constructor нет/);
    expect(familyAliases(F.fan)).toEqual([]);
  });
});
