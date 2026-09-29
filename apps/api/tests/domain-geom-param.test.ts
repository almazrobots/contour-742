// Эшелоны: L1 (evaluateGeomParam по видам измерения на фикстурах контракта ADR-0010), L3 (норма на границе, допуск
// между стадиями), L5 (fast-check: поворот и сдвиг обеих стадий не меняют вердикт CMP-14/15), L6 (масштаб не годен,
// пустой и битый граф, норма без числа — NOT_COMPARABLE с причиной). Название теста — ссылка трассы, T-193.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { evaluateGeomParam, geomOps, type GeomCtx, type GeomPassport, type GeomRef } from "../src/domain/geom-param.ts";
import { evaluateGeometry, geomPassport, geomRef, normsBase } from "../src/domain/kinds/geometry.ts";
import { baseMention, kindOf, kindSlice, type KindRow } from "../src/domain/param-kinds.ts";
import type { GeomMention, NormRecord } from "../src/domain/geom-ops.ts";
import { ParamPassport } from "../src/domain/passport.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const BASE: NormRecord[] = JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")).base;
const draftPp = (code: string) => ParamPassport.parse(JSON.parse(readFileSync(join(config.root, "data/seed/passports/draft", `${code}.json`), "utf8")));
const fx = (name: string): Partial<Record<Stage, GeomMention[]>> => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/geom", `${name}.json`), "utf8"));

const PARAM: Param = {
  code: "M-041", section: "АР", parameter_name: "Ширина эвакуационных выходов (дверей)", unit: "м", source_pd: "Ведомость заполнения проёмов (АР)", source_rd: "Спецификация дверей",
  source_id: "Акты АОСР", trigger_logic: "Ширина дверного полотна на путях эвакуации в РД/ИД < 0.9 м.", review_priority: "HIGH", data_type: "number", compare: { kind: "min", min: 0.9 },
  anchors: [], regex_pattern: null, value_scale: null, applicability: null, is_active: true,
};
const SOURCES = { PD: [{ discipline: "АР", label: "План этажа АР — источник Матрицы" }, { discipline: "*" }], RD: [{ discipline: "АР" }, { discipline: "*" }], ID: [{ discipline: "*" }] };
const P = (over: Partial<GeomPassport> = {}): GeomPassport => ({
  measure: "length", unit: "м", tolerance: 0.005, tolerance_pct: 0, direction: "decrease", aggregate: "each", norm: null, predicate: null, entity: "ENT-10", also: [], element_kinds: ["door"],
  systems: [], mark: null, share_of: [], label_pct: 2, scale_spread_pct: 2, registration_mm: 20, match_mm: 1000, iou_min: 0.95, hausdorff_mm: 300, sources: SOURCES, link: null, ...over,
});
const CTX = (over: Partial<GeomCtx> = {}): GeomCtx => ({ param: PARAM, loadedStages: ["PD", "RD"], profile: {}, norms: BASE, date: "2026-09-28", ...over });
const EVAC = { kind: "min" as const, value: null, basis: "СП 1.13130.2020", ref: "evac-door-width" };

const ref = (stage: Stage, m: GeomMention, over: Partial<GeomRef> = {}): GeomRef => ({
  ...m, stage, file_id: `f-${stage}-${m.page}`, sha256: "a".repeat(64), document_code: `100-${stage === "PD" ? "АР" : "АР1"}`, revision: "1", approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION",
  role: "CURRENT", discipline: "АР", excluded: null, excluded_why: null, confidence: 1, ...over,
});
const stages = (f: Partial<Record<Stage, GeomMention[]>>, map: (s: Stage, m: GeomMention) => GeomMention = (_s, m) => m) =>
  Object.fromEntries(Object.entries(f).filter(([k]) => k === "PD" || k === "RD" || k === "ID").map(([s, ms]) => [s, (ms as GeomMention[]).map((m) => ref(s as Stage, map(s as Stage, m)))])) as Partial<Record<Stage, GeomRef[]>>;

describe("evaluateGeomParam: длина и норма (CMP-06 по измерению, CMP-12)", () => {
  it("дверь РД уже нормы — CANDIDATE, эталон — норма с пунктом СП и правилом измерения", () => {
    const ev = evaluateGeomParam(P({ norm: EVAC }), stages(fx("doors")), CTX());
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toMatch(/^≥ 0,8 м по СП 1\.13130\.2020, п\. 4\.2\.19 — в свету/);
    expect(ev.actual).toBe("0,7");
    expect(ev.reason).toMatch(/Норма нарушена \(CMP-06\): РД \(АР, стр\. 3, «Д3»\) — 0,7 м/);
    expect(ev.fragments.map((f) => [f.stage, f.value, f.kind])).toEqual([["RD", "0,7", "actual"]]);
  });
  it("норма соблюдена и между стадиями в допуске — NEGATIVE_VERIFIED; лист не в масштабе назван (CMP-12)", () => {
    const f = fx("doors");
    f.RD = f.RD!.map((m) => (m.key === "Д3" ? { ...m, value: 0.9, label_value: 0.9, measured_value: 0.9 } : m));
    const ev = evaluateGeomParam(P({ norm: EVAC }), stages(f), CTX());
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toMatch(/Норма соблюдена \(CMP-06\)/);
    expect(ev.reason).toMatch(/не в масштабе \(CMP-12\).*Д2|надпись 1,2 против измерения 1,3/);
    expect(ev.provenance.measurements.find((x) => x.key === "Д2" && x.stage === "RD")).toMatchObject({ not_to_scale: true, value: 1.2 });
  });
  it("между стадиями без нормы: РД меньше ПД больше допуска — CANDIDATE с эталоном ПД", () => {
    const ev = evaluateGeomParam(P(), stages(fx("doors")), CTX());
    expect(ev).toMatchObject({ status: "CANDIDATE", expected: "0,9", actual: "0,7" });
    expect(ev.delta).toMatch(/^-0,2 м \(-22,2 %\)$/);
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
  });
  it("граница допуска между стадиями: ровно допуск — NEGATIVE_VERIFIED, на ε больше — CANDIDATE", () => {
    const f = fx("doors");
    const at = (v: number) => ({ PD: [f.PD![0]], RD: [{ ...f.RD![0], value: v, label_value: v, measured_value: v }] });
    expect(evaluateGeomParam(P(), stages(at(0.895)), CTX()).status).toBe("NEGATIVE_VERIFIED");
    expect(evaluateGeomParam(P(), stages(at(0.8949)), CTX()).status).toBe("CANDIDATE");
  });
  it("норма на границе: ровно 0,8 м — соблюдена; 0,8 м − ε — нарушена", () => {
    const d = fx("doors").PD![0];
    const only = (v: number) => ({ RD: [{ ...d, value: v, label_value: v, measured_value: v }] });
    expect(evaluateGeomParam(P({ norm: EVAC }), stages(only(0.8)), CTX({ loadedStages: ["RD"] })).status).toBe("NEGATIVE_VERIFIED");
    expect(evaluateGeomParam(P({ norm: EVAC }), stages(only(0.7999)), CTX({ loadedStages: ["RD"] })).status).toBe("CANDIDATE");
  });
  it("одна стадия РД без ПД: решает норма (CMP-06 — проверка одной стадии)", () => {
    const ev = evaluateGeomParam(P({ norm: EVAC }), stages({ RD: [fx("doors").RD![0]] }), CTX({ loadedStages: ["RD"] }));
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.expected).toMatch(/^≥ 0,8 м/);
  });
  it("только ПД — MISSING_EVIDENCE; значений нет нигде — MISSING_EVIDENCE с перечнем источников", () => {
    expect(evaluateGeomParam(P({ norm: EVAC }), stages({ PD: fx("doors").PD }), CTX()).status).toBe("MISSING_EVIDENCE");
    const ev = evaluateGeomParam(P(), {}, CTX());
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toMatch(/ПД: План этажа АР/);
  });
  it("норма без подтверждённого числа и одна стадия — NOT_COMPARABLE с причиной", () => {
    const ev = evaluateGeomParam(P({ norm: { kind: "min", value: null, basis: "СП 7", ref: "ozk-at-barrier" } }), stages({ RD: [fx("doors").RD![0]] }), CTX({ loadedStages: ["RD"] }));
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toMatch(/не подтверждено/);
  });
  it("масштаб листа не годен и надписи нет — NOT_COMPARABLE, а не нулевая ширина", () => {
    const w = fx("doors").PD!.find((m) => m.key === "ОК1")!;
    const ev = evaluateGeomParam(P({ element_kinds: ["window"] }), stages({ PD: [{ ...w, scale_n: null }], RD: [{ ...w, scale_spread_pct: 5 }] }), CTX());
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toMatch(/масштаб листа не определён.*разброс масштаба 5 %/);
  });
  it("ворота: неприменимость, спорная редакция", () => {
    expect(evaluateGeomParam(P(), stages(fx("doors")), CTX({ param: { ...PARAM, applicability: "underground" }, profile: { underground: false } })).status).toBe("NOT_APPLICABLE");
    const s = stages(fx("doors"));
    s.RD![0] = { ...s.RD![0], role: "CONFLICT" };
    expect(evaluateGeomParam(P(), s, CTX()).status).toBe("CLARIFICATION_REQUIRED");
  });
  it("фильтр паспорта и приоритет раздела: окно не дверь, раздел ниже по приоритету — в отсеянных с причиной", () => {
    const f = fx("doors");
    const s = stages(f);
    s.RD!.push(ref("RD", { ...f.RD![2], value: 0.5, label_value: 0.5, measured_value: 0.5 }, { discipline: "КР" }));
    const ev = evaluateGeomParam(P({ norm: EVAC }), s, CTX());
    expect(ev.actual).toBe("0,7");
    expect(ev.provenance.mentions.filter((m) => m.use === "dropped").map((m) => m.why)).toEqual(["раздел ниже по приоритету паспорта"]);
    expect(ev.provenance.measurements.some((x) => x.key === "ОК1")).toBe(false);
  });
  it("provenance: операции каталога вида и норма, источник — plan_geometry", () => {
    const ev = evaluateGeomParam(P({ norm: EVAC }), stages(fx("doors")), CTX());
    expect(ev.provenance.ops).toEqual(geomOps(P({ norm: EVAC })));
    expect(ev.provenance.ops).toEqual(expect.arrayContaining(["ENT-10", "LNK-06", "CMP-12", "CMP-06", "CMP-03", "DEC-01"]));
    expect(new Set(ev.provenance.mentions.map((m) => m.source))).toEqual(new Set(["plan_geometry"]));
  });
});

describe("evaluateGeomParam: площадь и доля (CMP-13, CMP-06 по доле)", () => {
  const site = (kind: string, w: number, h: number, page = 1): GeomMention => ({
    entity: "ENT-21", measure: "area", value: null, unit: "м²", by: "geometry", label_value: null, measured_value: null, key: "", at: null,
    polygon: [[0, 0], [w, 0], [w, h], [0, h]], graph: null, frame: "bld", scale_n: 500, scale_spread_pct: 0.5, residual_mm: 5, page, bbox: null, quote: kind, kind,
  });
  it("площадь покрытий — сумма контуров стадии; рост больше 5 % — CANDIDATE", () => {
    const p = P({ measure: "area", unit: "м²", entity: "ENT-21", element_kinds: ["asphalt"], aggregate: "sum", direction: "both", tolerance: 0.5, tolerance_pct: 5 });
    const pd = [site("asphalt", 20000, 10000), site("asphalt", 10000, 10000)]; // 300 м²
    expect(evaluateGeomParam(p, stages({ PD: pd, RD: [site("asphalt", 30000, 10500)] }), CTX())).toMatchObject({ status: "NEGATIVE_VERIFIED", expected: "300", actual: "315" });
    expect(evaluateGeomParam(p, stages({ PD: pd, RD: [site("asphalt", 30000, 10600)] }), CTX())).toMatchObject({ status: "CANDIDATE", actual: "318" });
  });
  it("доля мест МГН ниже 10 % по СП 59.13330.2020, п. 5.2.1 — CANDIDATE", () => {
    const p = P({ measure: "count", unit: "%", entity: "ENT-21", element_kinds: ["parking_mgn"], share_of: ["parking", "parking_mgn"], aggregate: "sum", norm: { kind: "min", value: null, basis: "СП 59", ref: "mgn-parking-share" } });
    const cnt = (kind: string, n: number): GeomMention => ({ ...site(kind, 1, 1), measure: "count", value: n, polygon: null });
    const ev = evaluateGeomParam(p, stages({ RD: [cnt("parking", 20), cnt("parking_mgn", 2)] }), CTX({ loadedStages: ["RD"] }));
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.actual).toBe("9,091");
    expect(ev.expected).toMatch(/≥ 10 % по СП 59\.13330\.2020, п\. 5\.2\.1/);
    expect(evaluateGeomParam(p, stages({ RD: [cnt("parking", 18), cnt("parking_mgn", 2)] }), CTX({ loadedStages: ["RD"] })).status).toBe("NEGATIVE_VERIFIED");
  });
});

describe("evaluateGeomParam: положение, контур, отношения, топология", () => {
  it("CMP-14: шахта сдвинута на 300 мм — CANDIDATE; остаток регистрации выше допуска — NOT_COMPARABLE", () => {
    const p = P({ measure: "position", unit: "мм", entity: "ENT-12", element_kinds: ["lift"], tolerance: 50 });
    const ev = evaluateGeomParam(p, stages(fx("lifts")), CTX());
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/«Л2» РД .* смещён на 300 мм/);
    const bad = evaluateGeomParam(p, stages(fx("lifts"), (s, m) => (s === "RD" ? { ...m, residual_mm: 80 } : m)), CTX());
    expect(bad.status).toBe("NOT_COMPARABLE");
    expect(bad.reason).toMatch(/остаток регистрации/);
  });
  it("CMP-15: перепланировка 101 и изменение методики подсчёта 102 — CANDIDATE с обеими причинами", () => {
    const p = P({ measure: "shape", unit: "м²", entity: "ENT-01", element_kinds: [], tolerance: 0.05, registration_mm: 50 });
    const ev = evaluateGeomParam(p, stages(fx("rooms")), CTX());
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/контур «101» РД .* изменился: IoU 0,7/);
    expect(ev.reason).toMatch(/контур «102» не изменился .* изменена методика подсчёта/);
  });
  it("CMP-16: пересечение воздуховода с противопожарной преградой без ОЗК — CANDIDATE; клапан на месте — NEGATIVE_VERIFIED", () => {
    const p = P({ measure: "relation", unit: "шт", entity: "ENT-09", element_kinds: ["duct"], also: ["ENT-11", "ENT-08"], predicate: { kind: "near_crossing", barrier: "ENT-11", barrier_kinds: ["fire"], device: "ENT-08", device_kinds: ["fire_damper"], radius_mm: 1000 } });
    const f = fx("fire");
    const ev = evaluateGeomParam(p, stages(f), CTX({ loadedStages: ["RD"] }));
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/В1.*без ENT-08 в радиусе 1000 мм/);
    const ok = { RD: [...f.RD!, { ...f.RD!.find((m) => m.key === "КЛ1")!, key: "КЛ2", at: [13800, 10000] as [number, number] }] };
    expect(evaluateGeomParam(p, stages(ok), CTX({ loadedStages: ["RD"] })).status).toBe("NEGATIVE_VERIFIED");
  });
  it("CMP-07 источником и CMP-16: счёт извещателей не уменьшился, радиус 6,4 м покрывает помещение — NEGATIVE_VERIFIED", () => {
    const p = P({ measure: "count", unit: "шт", entity: "ENT-08", element_kinds: ["smoke_detector"], also: ["ENT-01"], aggregate: "sum", tolerance: 0, predicate: { kind: "covers", of: "ENT-01", radius_mm: 6400, step_mm: 500 } });
    const rd = fx("fire").RD!;
    const f = { PD: rd.filter((m) => m.kind === "smoke_detector" || m.entity === "ENT-01"), RD: rd };
    expect(evaluateGeomParam(p, stages(f), CTX())).toMatchObject({ status: "NEGATIVE_VERIFIED", expected: "2", actual: "2" });
    const less = { PD: f.PD, RD: rd.filter((m) => m.key !== "ИП2") };
    const ev = evaluateGeomParam(p, stages(less), CTX());
    expect(ev).toMatchObject({ status: "CANDIDATE", expected: "2", actual: "1" });
    expect(ev.reason).toMatch(/РД \(АР, стр\. 1\) 1 шт против ПД \(АР, стр\. 1\) 2 шт/);
    expect(ev.reason).toMatch(/Нарушены отношения \(CMP-16\): РД: точка контура ENT-01 вне радиуса 6400 мм/);
  });
  it("CMP-19: пропало подключение П3–Т12 — CANDIDATE; уровень — менее детальная схема ПД", () => {
    const p = P({ measure: "topology", unit: "шт", entity: "ENT-09", element_kinds: [], tolerance: 0 });
    const ev = evaluateGeomParam(p, stages(fx("vent")), CTX());
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toMatch(/нет подключений П3–Т12 \(правка 2, уровень — riser, unit\)/);
  });
  it("CMP-19: битый граф и граф без марок — NOT_COMPARABLE с причиной, система пропала — CANDIDATE", () => {
    const p = P({ measure: "topology", unit: "шт", entity: "ENT-09", element_kinds: [], tolerance: 0 });
    const f = fx("vent");
    const broken = { PD: f.PD, RD: [{ ...f.RD![0], graph: { nodes: [], edges: [["x", "y"]] as Array<[string, string]> } }] };
    expect(evaluateGeomParam(p, stages(broken), CTX())).toMatchObject({ status: "NOT_COMPARABLE", reason: expect.stringMatching(/несуществующему узлу/) });
    const blank = { PD: f.PD, RD: [{ ...f.RD![0], graph: { nodes: [{ id: "b", kind: "bend", mark: null }], edges: [] as Array<[string, string]> } }] };
    expect(evaluateGeomParam(p, stages(blank), CTX())).toMatchObject({ status: "NOT_COMPARABLE", reason: expect.stringMatching(/нет узлов с маркой/) });
    const gone = { PD: f.PD, RD: [{ ...f.RD![0], key: "В", system: "В" }] };
    expect(evaluateGeomParam(p, stages(gone), CTX()).reason).toMatch(/система «П» ПД .* нет в РД/);
  });
});

describe("evaluateGeomParam: инвариантность к повороту и сдвигу (L5)", () => {
  it("общий поворот и сдвиг осей обеих стадий не меняет вердикт CMP-14 и CMP-15", () => {
    const pos = P({ measure: "position", unit: "мм", entity: "ENT-12", element_kinds: ["lift"], tolerance: 50 });
    const shp = P({ measure: "shape", unit: "м²", entity: "ENT-01", element_kinds: [], tolerance: 0.05, registration_mm: 50 });
    fc.assert(
      fc.property(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), fc.double({ min: -5e4, max: 5e4, noNaN: true }), fc.double({ min: -5e4, max: 5e4, noNaN: true }), (a, dx, dy) => {
        const t = ([x, y]: [number, number]): [number, number] => [x * Math.cos(a) - y * Math.sin(a) + dx, x * Math.sin(a) + y * Math.cos(a) + dy];
        const mv = (_s: Stage, m: GeomMention): GeomMention => ({ ...m, at: m.at ? t(m.at) : null, polygon: m.polygon ? m.polygon.map((p) => t(p as [number, number])) : null });
        expect(evaluateGeomParam(pos, stages(fx("lifts"), mv), CTX()).status).toBe("CANDIDATE");
        const e = evaluateGeomParam(shp, stages(fx("rooms"), mv), CTX());
        expect(e.status).toBe("CANDIDATE");
        expect(e.provenance.measurements.find((x) => x.key === "101")!.iou).toBeCloseTo(0.7, 6);
      }),
      { numRuns: 25 },
    );
  });
});

describe("паспорта W2 геометрии и вид geometry в реестре", () => {
  it("паспорт вида geometry проходит схему; сборщик конфигурации переносит фильтры и норму", () => {
    const pp = ParamPassport.parse({
      code: "M-999", version: "1.0.0", title: "t", summary: "s", basis: "b",
      value: { kind: "geometry", measure: "length", unit: "м", tolerance_abs: 0.005, tolerance_note: "n", direction: "decrease", norm: EVAC },
      extractor: { kind: "geometry_mentions", entity: "ENT-10", measure: "length", element_kinds: ["door"] },
      sources: SOURCES, link: { by: "none", note: "" }, steps: {}, outcomes: [],
    });
    expect(kindOf("geometry")?.kind).toBe("geometry");
    const g = geomPassport(kindSlice(pp));
    expect(g).toMatchObject({ measure: "length", entity: "ENT-10", element_kinds: ["door"], aggregate: "each", norm: EVAC, label_pct: 2, match_mm: 1000 });
    expect(() => ParamPassport.parse({ ...pp, extractor: { kind: "geometry_mentions", entity: "ENT-1", measure: "length" } })).toThrow();
    expect(normsBase().length).toBe(BASE.length);
  });
  const W2 = "012 025 026 027 028 030 036 037 038 039 040 041 049 054 058 059 060 061 064 068 071 074 076 078 080 104 105 108 111 113 116 117 119 121".split(" ").map((n) => `M-${n}`);
  it("34 паспорта W2 вида geometry загружаются схемой и каталогом операций; ссылки норм есть в Normative_Base", () => {
    // паспорта W2 геометрии — в data/seed/passports/draft/ до цифр замера (T-233): загрузчик их не читает, читаем той же схемой
    expect(W2).toHaveLength(34);
    for (const c of W2) {
      const pp = draftPp(c);
      expect(pp.value.kind, c).toBe("geometry");
      const g = geomPassport(kindSlice(pp!));
      expect(g.entity, c).toMatch(/^ENT-\d{2}$/);
      if (g.norm?.ref) expect(BASE.some((r) => r.id === g.norm!.ref && r.applies_to.includes(c)), `${c} → ${g.norm.ref}`).toBe(true);
      if (g.measure === "relation") expect(g.predicate, c).not.toBeNull();
    }
  });
  const row = (stage: Stage, over: Partial<KindRow>): KindRow => ({
    file_id: `f-${stage}`, value_num: null, value_text: null, page: 2, bbox_json: "[0.1,0.1,0.2,0.12]", sha256: "b".repeat(64), doc_stage: stage, document_code: stage === "PD" ? "100-АР" : "100-АР1",
    revision: "1", approval_status: "APPROVED", revision_role: "CURRENT", discipline: "АР", meta_json: null, line_text: "Ширина эвакуационного выхода 1,2 м", confidence: 0.9, ...over,
  });
  it("строки извлечения: упоминание плана из meta.geom и число ведомости проёмов — одна оценка по норме", () => {
    const pp = draftPp("M-041");
    const d3 = fx("doors").RD!.find((m) => m.key === "Д3")!;
    const rows = [row("PD", { value_num: 1.2 }), row("RD", { meta_json: JSON.stringify({ geom: d3 }) })];
    const g = geomPassport(kindSlice(pp));
    expect(geomRef(baseMention(row("RD", {})), g)).toBeNull();
    expect(geomRef(baseMention(rows[0]), g)).toMatchObject({ by: "dimension", label_value: 1.2, unit: "м", entity: "ENT-10", kind: "door" });
    const ev = evaluateGeometry({ param: PARAM, passport: kindSlice(pp), mentions: rows.map(baseMention), loadedStages: ["PD", "RD"], profile: {}, date: "2026-09-28" });
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toMatch(/^≥ 0,8 м по СП 1\.13130\.2020, п\. 4\.2\.19/);
    expect(ev.reason).toMatch(/РД \(АР, стр\. 2, «Д3»\) — 0,7 м/);
    expect(ev.suspicions).toEqual([]);
  });
  it("запись meta.geom не по контракту ADR-0010 — упоминание отсеяно с причиной, а не угадано", () => {
    const pp = draftPp("M-041");
    const d3 = fx("doors").RD!.find((m) => m.key === "Д3")!;
    const rows = [row("RD", { meta_json: JSON.stringify({ geom: { ...d3, entity: "дверь" } }) })];
    const ev = evaluateGeometry({ param: PARAM, passport: kindSlice(pp), mentions: rows.map(baseMention), loadedStages: ["RD"], profile: {}, date: "2026-09-28" });
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.provenance.mentions[0]).toMatchObject({ use: "dropped", why: expect.stringMatching(/не по контракту ADR-0010: entity/) });
  });
});
