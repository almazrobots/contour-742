// Эшелоны: L1 (правила CMP-21 OS-INSP-3.1.67–3.1.69), L3 (допуск толщины, переменная толщина, пустой состав),
// L5 (fast-check: выравнивание одного состава — только совпадения; удаление любого слоя — нарушение; перестановка
// соседних разных слоёв — reorder), L6 (недоверенные поля ответа ML, другой комплект ПД, пилот UNDMS — стальной лист).
// Название теста — ссылка трассы, T-176.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalogsFile } from "../src/domain/analogs.ts";
import {
  align, evaluateLayersParam, itemKey, layerOps, layersConflicts, layersFields, layersPassport, mergeRuns, pairStacks, pickLayers, sameMaterial, score, showStack, similarity, W,
  type Layer, type LayersMention, type LayersPassport,
} from "../src/domain/layers-param.ts";
import { ParamPassport } from "../src/domain/passport.ts";
import type { Param, Stage } from "../src/domain/types.ts";

let ROOT = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(ROOT, "data/seed/matrix.json"))) ROOT = dirname(ROOT);
const F = AnalogsFile.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/analogs.json"), "utf8"))).families;
const ROOF: LayersPassport = { family: F.envelope_layers, tol_mm: 0.5, sources: { PD: [{ discipline: "АР" }, { discipline: "*" }], RD: [{ discipline: "АР" }, { discipline: "*" }], ID: [{ discipline: "*" }] }, link: "base_cipher" };
const PARAM: Param = {
  code: "M-044", section: "АР", parameter_name: "Послойный состав пирога кровли", unit: "мм (слои)", source_pd: "Узлы кровли", source_rd: "План кровли", source_id: "Акты АОСР",
  trigger_logic: "Замена кровельной мембраны на класс ниже; исключение пароизоляционного слоя.", review_priority: "HIGH", data_type: "string", compare: { kind: "decrease" }, anchors: ["Пирог"],
  regex_pattern: null, value_scale: null, applicability: null, is_active: true,
};
const L = (m: string | null, t: number | null = null, raw = m ?? "материал", t_max: number | null = null): Layer => ({ m, raw, t, t_max });
const STACK = [L("MEMBRANE_PVC", 1.5), L("GEOTEXTILE"), L("INSUL_MW", 200), L("VAPOR_BITUMEN", 3), L("PROFILED_SHEET")];

let seq = 0;
const S = (stage: Stage, layers: Layer[], over: Partial<LayersMention> = {}): LayersMention => ({
  stage, file_id: `f-${stage}-${++seq}`, sha256: "b".repeat(64), document_code: stage === "PD" ? "П-2099-01-001-АР" : "Р-2099-01-001-АР", revision: "0", approval_status: "APPROVED", role: "CURRENT",
  discipline: "АР", base: "2099-01-001", item: "Кр-1", layers, excluded: null, excluded_why: null, page: 7, bbox: [0.1, 0.1, 0.4, 0.3], quote: "Состав кровли Кр-1", confidence: 1, ...over,
});
const run = (mentions: LayersMention[], over: Partial<Parameters<typeof evaluateLayersParam>[0]> = {}) =>
  evaluateLayersParam({ param: PARAM, passport: ROOF, mentions, loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set(["2099-01-001"]), ...over });
const ops = (pd: Layer[], rd: Layer[]) => layerOps(ROOF, pd, rd).map((o) => o.op);

describe("CMP-21 LAYER-SEQ: послойный состав", () => {
  it("тот же состав — NEGATIVE_VERIFIED, все операции — совпадения", () => {
    expect(ops(STACK, STACK)).toEqual(["match", "match", "match", "match", "match"]);
    const ev = run([S("PD", STACK), S("RD", STACK)]);
    expect(ev).toMatchObject({ status: "NEGATIVE_VERIFIED", reason: "Состав слоёв и толщины не изменены", delta: null });
    expect(ev.provenance.ops).toEqual(expect.arrayContaining(["CMP-21", "CMP-05", "ENT-17"]));
    expect(ev.alignment[0].ops).toHaveLength(5);
  });

  it("delete_layer: исключён слой пароизоляции — CANDIDATE с правилом Матрицы", () => {
    const rd = STACK.filter((l) => l.m !== "VAPOR_BITUMEN");
    expect(ops(STACK, rd)).toEqual(["match", "match", "match", "delete_layer", "match"]);
    const ev = run([S("PD", STACK), S("RD", rd)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/^«Кр-1», ПД → РД: слой «битумно-полимерная пароизоляция 3 мм» исключён\. Правило Матрицы: Замена/);
    expect(ev.delta).toMatch(/^delete_layer: /);
  });

  it("пилот UNDMS: в покрытии ПД стальной бронированный лист 6 мм, в РД слоя нет — delete_layer", () => {
    const pd = [L("PAVING_TILE", 60), L("STEEL_ARMOR", 6), L("MEMBRANE_PVC", 2), L("SLAB_RC", 250)];
    const rd = [L("PAVING_TILE", 60), L("MEMBRANE_PVC", 2), L("SLAB_RC", 250)];
    expect(run([S("PD", pd), S("RD", rd)]).reason).toContain("стальной бронированный (защитный) лист 6 мм» исключён");
  });

  it("thickness_down — CANDIDATE; thickness_up — не нарушение; разница в пределах допуска — совпадение", () => {
    const thinner = STACK.map((l) => (l.m === "INSUL_MW" ? { ...l, t: 150 } : l));
    expect(ops(STACK, thinner)).toContain("thickness_down");
    const ev = run([S("PD", STACK), S("RD", thinner)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("толщина слоя «плиты из минеральной (каменной) ваты» уменьшена: 200 → 150 мм");
    const thicker = STACK.map((l) => (l.m === "INSUL_MW" ? { ...l, t: 250 } : l));
    const up = run([S("PD", STACK), S("RD", thicker)]);
    expect(up.status).toBe("NEGATIVE_VERIFIED");
    expect(up.reason).toMatch(/^Состав не ухудшен: «Кр-1», ПД → РД: толщина слоя .* увеличена: 200 → 250 мм$/);
    expect(ops(STACK, STACK.map((l) => (l.m === "MEMBRANE_PVC" ? { ...l, t: 1.2 } : l)))).toEqual(["match", "match", "match", "match", "match"]);
    expect(ops(STACK, STACK.map((l) => (l.m === "MEMBRANE_PVC" ? { ...l, t: 0.9 } : l)))[0]).toBe("thickness_down");
  });

  it("толщина указана только с одной стороны — не сравнивается", () => {
    expect(ops([L("INSUL_MW", 200)], [L("INSUL_MW", null)])).toEqual(["match"]);
  });

  it("insert_layer — не нарушение, с пометкой", () => {
    const rd = [...STACK.slice(0, 2), L("SEPARATION"), ...STACK.slice(2)];
    expect(ops(STACK, rd)).toEqual(["match", "match", "insert_layer", "match", "match", "match"]);
    expect(run([S("PD", STACK), S("RD", rd)]).status).toBe("NEGATIVE_VERIFIED");
  });

  it("substitute_material: EQUIVALENT (ПВХ → ТПО) — не нарушение; NOT_EQUIVALENT (ПВХ → битум) — CANDIDATE с источником", () => {
    const tpo = STACK.map((l) => (l.m === "MEMBRANE_PVC" ? L("MEMBRANE_TPO", 1.5) : l));
    const ok = layerOps(ROOF, STACK, tpo);
    expect(ok[0]).toMatchObject({ op: "substitute_material", violation: false, verdict: { verdict: "EQUIVALENT" } });
    expect(run([S("PD", STACK), S("RD", tpo)]).status).toBe("NEGATIVE_VERIFIED");
    const bit = STACK.map((l) => (l.m === "MEMBRANE_PVC" ? L("BITUMEN_POLYMER", 4) : l));
    const bad = layerOps(ROOF, STACK, bit);
    expect(bad[0]).toMatchObject({ op: "substitute_material", violation: true });
    expect(bad[0].text).toContain("СП 17.13330.2017");
    expect(run([S("PD", STACK), S("RD", bit)]).status).toBe("CANDIDATE");
  });

  it("эквивалентная замена с уменьшенной толщиной — ещё и thickness_down", () => {
    const pd = [L("MEMBRANE_PVC", 2)];
    expect(ops(pd, [L("MEMBRANE_TPO", 1.2)])).toEqual(["substitute_material", "thickness_down"]);
  });

  it("материал вне справочника: замена не определена — NOT_COMPARABLE, а не CANDIDATE", () => {
    const rd = STACK.map((l) => (l.m === "GEOTEXTILE" ? L(null, null, "полотно Termotex 300") : l));
    const o = layerOps(ROOF, STACK, rd);
    expect(o[1]).toMatchObject({ op: "substitute_material", uncertain: true, violation: false });
    const ev = run([S("PD", STACK), S("RD", rd)]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("материал вне справочника");
    // тот же материал вне справочника в тех же словах — совпадение
    expect(ops([L(null, 10, "полотно Termotex 300")], [L(null, 10, "Полотно  termotex-300")])).toEqual(["match"]);
  });

  it("reorder: слой переставлен — CANDIDATE с позициями", () => {
    const rd = [STACK[0], STACK[1], STACK[3], STACK[2], STACK[4]]; // пароизоляция над утеплителем
    const o = layerOps(ROOF, STACK, rd);
    expect(o.map((x) => x.op)).toContain("reorder");
    expect(o.find((x) => x.op === "reorder")!.text).toMatch(/переставлен: позиция \d → \d/);
    expect(run([S("PD", STACK), S("RD", rd)]).status).toBe("CANDIDATE");
  });

  it("детализация РД: подряд слои одного материала складываются (150 + 50 = 200 мм минваты) — не нарушение", () => {
    const rd = [STACK[0], STACK[1], L("INSUL_MW", 150, "Техноруф Н30"), L("INSUL_MW", 50, "Техноруф В60"), STACK[3], STACK[4]];
    expect(mergeRuns(rd)).toHaveLength(5);
    expect(mergeRuns(rd)[2]).toMatchObject({ m: "INSUL_MW", t: 200, t_max: 200, raw: "Техноруф Н30 + Техноруф В60" });
    expect(run([S("PD", STACK), S("RD", rd)]).status).toBe("NEGATIVE_VERIFIED");
    expect(mergeRuns([L("INSUL_MW", 150), L("INSUL_MW", null)])[0].t).toBeNull();
  });

  it("переменная толщина уклонообразующего слоя сравнивается по минимальной", () => {
    const pd = [L("SLOPE_CLAYDITE", 50, "керамзит", 200)];
    expect(ops(pd, [L("SLOPE_CLAYDITE", 30, "керамзит", 200)])).toEqual(["thickness_down"]);
    expect(ops(pd, [L("SLOPE_CLAYDITE", 50, "керамзит", 150)])).toEqual(["match"]);
    expect(showStack(F.envelope_layers, pd)).toBe("уклонообразующий слой из керамзитового гравия 50–200 мм");
  });

  it("выравнивание Нидлмана — Вунша: веса, разрывы, пустые составы", () => {
    const f = F.envelope_layers;
    expect(score(f, L("INSUL_MW"), L("INSUL_MW"))).toBe(W.same);
    expect(score(f, L("INSUL_MW"), L("INSUL_XPS"))).toBe(W.group);
    expect(score(f, L("INSUL_MW"), L("MEMBRANE_PVC"))).toBe(W.other);
    expect(score(f, L("INSUL_MW"), L(null, null, "что-то"))).toBe(W.unknown);
    expect(align(f, [], [])).toEqual([]);
    expect(align(f, [L("INSUL_MW")], [])).toEqual([[0, null]]);
    expect(align(f, [], [L("INSUL_MW")])).toEqual([[null, 0]]);
    expect(align(f, [L("A_X" as never), L("INSUL_MW")], [L("INSUL_MW")])).toEqual([[0, null], [1, 0]]);
    // замена внутри группы выгоднее пары «удалить + вставить»
    expect(align(f, [L("INSUL_MW")], [L("INSUL_XPS")])).toEqual([[0, 0]]);
    // разные группы: пара разрывов выгоднее замены
    expect(align(f, [L("INSUL_MW")], [L("MEMBRANE_PVC")])).toEqual([[0, null], [null, 0]]);
  });

  it("одинаковый материал: ключ канона; вне справочника — то же написание; пустое написание — не совпадение", () => {
    expect(sameMaterial(L("INSUL_MW"), L("INSUL_MW", 5, "другое"))).toBe(true);
    expect(sameMaterial(L("INSUL_MW"), L(null, null, "INSUL_MW"))).toBe(false);
    expect(sameMaterial(L(null, null, "--"), L(null, null, "  "))).toBe(false);
  });

  it("сопоставление конструкций: по марке; по одной без марки; разные марки — если составы похожи; остальные — по похожести", () => {
    const a = S("PD", STACK, { item: "Кр-1" });
    const b = S("PD", [L("PAVING_TILE", 60), L("MEMBRANE_PVC", 2)], { item: "Кр-2" });
    const r1 = S("RD", STACK, { item: "КР 1" });
    expect(pairStacks([a, b], [r1])).toEqual([{ pd: a, rd: r1 }]);
    expect(itemKey("КР 1")).toBe(itemKey("Кр-1"));
    expect(itemKey(null)).toBeNull();
    expect(itemKey("--")).toBeNull();
    const loose = S("RD", STACK, { item: null });
    expect(pairStacks([a], [loose])).toEqual([{ pd: a, rd: loose }]);
    expect(pairStacks([a], [S("RD", STACK, { item: "К-7" })])).toHaveLength(1); // одна с каждой стороны, составы одинаковы
    expect(pairStacks([a], [S("RD", [L("SLAB_RC")], { item: "К-7" })])).toEqual([]); // разные марки и не похожи
    const l1 = S("RD", [L("PAVING_TILE", 60), L("MEMBRANE_PVC", 2)], { item: null });
    const l2 = S("RD", STACK, { item: null });
    const pairs = pairStacks([a, b], [l1, l2]);
    expect(pairs.map((p) => [p.pd.item, p.rd === l1 ? "l1" : "l2"]).sort()).toEqual([["Кр-1", "l2"], ["Кр-2", "l1"]]);
    expect(similarity([L("INSUL_MW")], [L("INSUL_MW"), L("SLAB_RC")])).toBe(0.5);
  });

  it("конструкции стадий не сопоставлены — NOT_COMPARABLE с перечнем", () => {
    const ev = run([S("PD", STACK, { item: "Кр-1" }), S("PD", [L("SLAB_RC")], { item: "Кр-2" }), S("RD", [L("PAVING_TILE")], { item: "К-9" })]);
    expect(ev).toMatchObject({ status: "NOT_COMPARABLE", reason: "Конструкции стадий не сопоставлены: ПД — Кр-1, Кр-2; РД — К-9" });
  });

  it("ворота: применимость, редакция, комплектность", () => {
    expect(run([S("PD", STACK), S("RD", STACK)], { param: { ...PARAM, applicability: "roof" }, profile: { roof: false } }).status).toBe("NOT_APPLICABLE");
    expect(run([S("PD", STACK), S("RD", STACK, { role: "UNRESOLVED", revision: "3" })])).toMatchObject({ status: "CLARIFICATION_REQUIRED", reason: "Не определена актуальная редакция: Р-2099-01-001-АР ред. 3" });
    expect(run([S("PD", STACK)])).toMatchObject({ status: "MISSING_EVIDENCE", reason: "Недостаточно источников для сравнения: состав слоёв найден только в ПД; нет состава в РД" });
    expect(run([]).reason).toBe("Недостаточно источников для сравнения: состав слоёв не найден; нет состава в ПД, РД");
  });

  it("отсев, устаревшая редакция и пустой состав — в стороне с причиной; другой комплект ПД — справочно", () => {
    const pk = pickLayers([S("PD", STACK, { excluded: "EXISTING", excluded_why: "существующая кровля" }), S("PD", [], {}), S("PD", STACK, { role: "SUPERSEDED" }), S("PD", STACK, { base: "7777" }), S("PD", STACK)], "PD", ROOF, new Set(["2099-01-001"]));
    expect(pk.dropped).toHaveLength(3);
    expect(pk.reference).toHaveLength(1);
    expect(pk.considered).toHaveLength(1);
    expect(pickLayers([S("PD", STACK, { base: "7777" })], "PD", ROOF, new Set(["2099-01-001"]), true).considered).toEqual([]);
    expect(pickLayers([S("PD", STACK, { base: "7777" })], "PD", ROOF, new Set(["2099-01-001"])).note).toMatch(/не связан с РД/);
    const ev = run([S("PD", [], {}), S("PD", STACK), S("RD", STACK)]);
    expect(ev.provenance.mentions.find((m) => m.use === "dropped")!.why).toBe("состав не распознан");
  });

  it("противоречие внутри стадии: одна марка с разными составами в разных документах — гипотеза", () => {
    const a = S("PD", STACK, { discipline: "АР" });
    const b = S("PD", STACK.filter((l) => l.m !== "GEOTEXTILE"), { discipline: "КР" });
    const s = layersConflicts([a, b], "PD", ROOF);
    expect(s).toHaveLength(1);
    expect(s[0].description).toMatch(/^Внутреннее противоречие ПД: состав «Кр-1» указан по-разному — АР, стр\. 7: .* \| КР, стр\. 7: /);
    expect(layersConflicts([a, S("PD", STACK, { discipline: "КР" })], "PD", ROOF)).toEqual([]);
    expect(layersConflicts([a, S("PD", [L("SLAB_RC")], { item: null })], "PD", ROOF)).toEqual([]);
  });

  it("несколько нарушений: в карточке порядок delete → замена → толщина → перестановка, все — в причине", () => {
    const rd = [L("BITUMEN_POLYMER", 4), L("INSUL_MW", 100), L("PROFILED_SHEET")];
    const ev = run([S("PD", STACK), S("RD", rd)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.delta!.split("; ")[0]).toMatch(/^delete_layer/);
    expect(ev.reason).toContain("уменьшена: 200 → 100 мм");
  });

  it("поля ответа ML — белый список: чужой ключ, прототип, толщина вне 0…5000 и не число, пустой состав", () => {
    const f = F.envelope_layers;
    expect(layersFields(f, { item: " Кр-1 ", layers: [{ m: "INSUL_MW", raw: "Техноруф", t: 200, t_max: 200 }, { m: "constructor", raw: "x", t: -1 }, { m: "NOPE", raw: 5, t: 9999, t_max: "5" }, null, 7] })).toEqual({
      item: "Кр-1",
      layers: [{ m: "INSUL_MW", raw: "Техноруф", t: 200, t_max: 200 }, { m: null, raw: "x", t: null, t_max: null }, { m: null, raw: "", t: null, t_max: null }],
    });
    expect(layersFields(f, { layers: [] })).toBeNull();
    expect(layersFields(f, { layers: "1" })).toBeNull();
    expect(layersFields(f, {})).toBeNull();
    expect(layersFields(f, { layers: Array.from({ length: 50 }, () => ({ m: "SLAB_RC" })) })!.layers).toHaveLength(40);
    expect(layersFields(f, { item: "  ", layers: [{ raw: "r".repeat(300) }] })).toEqual({ item: null, layers: [{ m: null, raw: "r".repeat(200), t: null, t_max: null }] });
  });

  it("паспорт состава: семейство справочника обязательно", () => {
    const pp = ParamPassport.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/passports/M-044.json"), "utf8")));
    expect(layersPassport(pp, F)).toMatchObject({ tol_mm: 0.5, link: "base_cipher" });
    expect(() => layersPassport({ ...pp, value: { ...pp.value, family: "nope" } as never }, F)).toThrow(/семейства nope нет/);
    expect(layersPassport({ ...pp, value: { kind: "ordinal", scale: ["a", "b"], order_note: "", constraint_markers: [] } }, F)).toBeNull();
  });

  const keys = ["MEMBRANE_PVC", "INSUL_MW", "INSUL_XPS", "VAPOR_PE", "SCREED_CS", "SLAB_RC", "GEOTEXTILE", "PROFILED_SHEET"];
  const stackArb = fc.uniqueArray(fc.constantFrom(...keys), { minLength: 2, maxLength: 7 }).map((ks) => ks.map((k, i) => L(k, 10 + i * 10)));

  it("свойство: выравнивание состава с самим собой — только совпадения", () => {
    fc.assert(
      fc.property(stackArb, (s) => {
        expect(layerOps(ROOF, s, s).map((o) => o.op)).toEqual(s.map(() => "match"));
      }),
    );
  });

  it("свойство: удаление любого слоя — нарушение delete_layer", () => {
    fc.assert(
      fc.property(stackArb, fc.nat(), (s, k) => {
        const i = k % s.length;
        const o = layerOps(ROOF, s, s.filter((_, j) => j !== i));
        expect(o.some((x) => x.op === "delete_layer" && x.violation)).toBe(true);
      }),
    );
  });

  it("свойство: перестановка двух соседних слоёв — reorder или неэквивалентная замена, но всегда нарушение", () => {
    fc.assert(
      fc.property(stackArb, fc.nat(), (s, k) => {
        const i = k % (s.length - 1);
        const r = [...s];
        [r[i], r[i + 1]] = [r[i + 1], r[i]];
        expect(layerOps(ROOF, s, r).some((x) => x.violation)).toBe(true);
      }),
    );
  });
});
