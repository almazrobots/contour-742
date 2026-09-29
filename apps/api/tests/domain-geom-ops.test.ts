// Эшелоны: L1 (операторы CMP-06, 12, 13, 14, 15, 16, 19 и LNK-06 на фикстурах контракта ADR-0010), L2 (площадь
// контура против экспликации — независимый счёт прямоугольников), L3 (границы: 2 % надписи, предел нормы ±ε, допуск
// регистрации, IoU на пороге), L6 (вырожденный контур, пустой граф, ребро к несуществующему узлу, норма без числа).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-193. Геометрия синтетическая (ADR-0002).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { matchElements, normKey } from "../src/domain/geom-match.ts";
import {
  checkRelation,
  compareGraphs,
  convertUnit,
  normBroken,
  positionShift,
  predicateOthers,
  resolveArea,
  resolveDim,
  resolveNorm,
  shapeChange,
  symbolCount,
  symbolPresence,
  type GeomMention,
  type NormRecord,
} from "../src/domain/geom-ops.ts";

type Fx = { PD?: GeomMention[]; RD?: GeomMention[] };
const fx = (name: string): Fx => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/geom", `${name}.json`), "utf8"));
const BASE: NormRecord[] = JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")).base;
const by = (xs: GeomMention[] | undefined, key: string) => xs!.find((m) => m.key === key)!;

describe("CMP-06: норма из Normative_Base", () => {
  it("норма по ссылке: число, пункт СП и правило измерения из записи, в единице паспорта", () => {
    const n = resolveNorm({ kind: "min", value: null, basis: "СП 1.13130.2020", ref: "evac-door-width" }, BASE, "2026-09-28", "мм");
    expect("why" in n).toBe(false);
    if ("why" in n) return;
    expect(n.value).toBe(800);
    expect(n.text).toMatch(/^≥ 800 мм по СП 1\.13130\.2020, п\. 4\.2\.19 — в свету/);
  });
  it("норма не действует на дату проверки — сравнения нет, причина словами", () => {
    const n = resolveNorm({ kind: "min", value: null, basis: "СП 59", ref: "mgn-door-width" }, BASE, "2020-01-01", "м");
    expect(n).toEqual({ why: expect.stringMatching(/не действует на 2020-01-01/) });
  });
  it("число нормы не подтверждено по тексту — сравнения нет (NOT_COMPARABLE), а не догадка", () => {
    const n = resolveNorm({ kind: "min", value: null, basis: "СП 7", ref: "ozk-at-barrier" }, BASE, "2026-09-28", "м");
    expect(n).toEqual({ why: expect.stringMatching(/не подтверждено/) });
    const u = resolveNorm({ kind: "min", value: null, basis: "ГПЗУ" }, BASE, "2026-09-28", "м²");
    expect(u).toEqual({ why: expect.stringMatching(/не задан/) });
  });
  it("ссылка на несуществующую норму — громкий отказ", () => {
    expect(() => resolveNorm({ kind: "min", value: null, basis: "x", ref: "no-such" }, BASE, "2026-09-28", "м")).toThrow(/нет в Normative_Base/);
  });
  it("граница нормы: ровно предел — не нарушение, на ε меньше — нарушение", () => {
    expect(normBroken({ kind: "min", value: 0.8 }, 0.8)).toBe(false);
    expect(normBroken({ kind: "min", value: 0.8 }, 0.8 - 1e-6)).toBe(true);
    expect(normBroken({ kind: "max", value: 6.4 }, 6.4)).toBe(false);
    expect(normBroken({ kind: "max", value: 6.4 }, 6.4 + 1e-6)).toBe(true);
  });
  it("каждая запись Normative_Base: пункт, правило измерения, число или unverified, ссылка на источник", () => {
    const ids = new Set<string>();
    for (const r of BASE) {
      expect(ids.has(r.id), r.id).toBe(false);
      ids.add(r.id);
      expect(r.doc, r.id).toMatch(/^(СП|ГОСТ)/);
      expect(r.rule.length, r.id).toBeGreaterThan(10);
      expect(r.min !== null || r.max !== null || r.unverified === true || r.measure === "relation", r.id).toBe(true);
      expect((r as unknown as { source_url: string }).source_url, r.id).toMatch(/^https:\/\//);
    }
  });
  it("единицы: мм ↔ м, м² ↔ мм²; несопоставимые — громкий отказ", () => {
    expect(convertUnit(0.9, "м", "мм")).toBe(900);
    expect(convertUnit(2e7, "мм²", "м²")).toBe(20);
    expect(() => convertUnit(1, "м", "м²")).toThrow(/несопоставимы/);
  });
});

describe("CMP-12: надпись размера против измерения", () => {
  it("расхождение больше 2 % — приоритет надписи и флаг «не в масштабе»", () => {
    const d = resolveDim(by(fx("doors").RD, "Д2"), 2, 2);
    expect(d).toMatchObject({ value: 1.2, by: "both", not_to_scale: true });
    expect(d.diff_pct).toBeCloseTo(8.333, 2);
  });
  it("надпись и измерение совпали в пределах 2 % — значение надписи без флага", () => {
    expect(resolveDim(by(fx("doors").PD, "Д1"), 2, 2)).toMatchObject({ value: 0.9, by: "both", not_to_scale: false });
  });
  it("граница 2 %: ровно 2 % — в масштабе, 2 % + ε — не в масштабе", () => {
    const m = { ...by(fx("doors").PD, "Д1"), label_value: 1, measured_value: 1.02 };
    expect(resolveDim(m, 2, 2).not_to_scale).toBe(false);
    expect(resolveDim({ ...m, measured_value: 1.0201 }, 2, 2).not_to_scale).toBe(true);
  });
  it("только измерение: масштаб не определён или разброс масштаба выше порога — значения нет", () => {
    const w = by(fx("doors").PD, "ОК1");
    expect(resolveDim(w, 2, 2)).toMatchObject({ value: 1.5, by: "geometry" });
    expect(resolveDim({ ...w, scale_n: null }, 2, 2)).toMatchObject({ value: null, why: "масштаб листа не определён" });
    expect(resolveDim({ ...w, scale_spread_pct: 2.5 }, 2, 2).why).toMatch(/разброс масштаба 2,5 %/);
  });
  it("надпись при негодном масштабе остаётся значением: надпись не зависит от масштаба", () => {
    expect(resolveDim({ ...by(fx("doors").RD, "Д2"), scale_n: null }, 2, 2)).toMatchObject({ value: 1.2, by: "dimension", not_to_scale: false });
  });
});

describe("CMP-13: площадь полигона", () => {
  it("площадь контура в м² — контроль экспликации; совпало — без флага", () => {
    const a = resolveArea(by(fx("rooms").PD, "101"), "м²", 2, 2);
    expect(a).toMatchObject({ value: 20, by: "both", geom_value: 20, control_flag: false });
  });
  it("для помещения приоритет у экспликации: геометрия расходится — флаг, значение экспликации", () => {
    const a = resolveArea(by(fx("rooms").RD, "102"), "м²", 2, 2);
    expect(a.value).toBe(11.2);
    expect(a.geom_value).toBeCloseTo(12, 9);
    expect(a.control_flag).toBe(true);
  });
  it("L2: площадь Г-образного контура совпадает с суммой прямоугольников", () => {
    const a = resolveArea({ ...by(fx("rooms").RD, "101"), label_value: null, by: "geometry" }, "м²", 2, 2);
    expect(a.value).toBeCloseTo(5 * 2 + 2 * 2, 9);
  });
  it("контур на листе — площадь в натуре через масштаб в квадрате", () => {
    const m = { ...by(fx("rooms").PD, "103"), frame: "sheet" as const, polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] as GeomMention["polygon"], label_value: null, by: "geometry" as const };
    expect(resolveArea(m, "м²", 2, 2).value).toBeCloseTo(9, 9);
  });
  it("вырожденный контур без экспликации — значения нет, причина словами", () => {
    const m = { ...by(fx("rooms").PD, "103"), polygon: [[0, 0], [1, 1], [2, 2]] as GeomMention["polygon"], label_value: null, by: "geometry" as const };
    expect(resolveArea(m, "м²", 2, 2)).toMatchObject({ value: null, why: expect.stringMatching(/нулевой площади/) });
  });
});

describe("LNK-06: сопоставление элементов", () => {
  it("пары по марке, повтор марки — по ближайшему положению", () => {
    const a = [{ key: "Д1", at: [0, 0] as [number, number], frame: "bld" as const }, { key: "Д1", at: [5000, 0] as [number, number], frame: "bld" as const }];
    const b = [{ key: "д1", at: [5020, 0] as [number, number], frame: "bld" as const }, { key: "Д1 ", at: [10, 0] as [number, number], frame: "bld" as const }];
    const r = matchElements(a, b, 500);
    expect(r.pairs.map((p) => [p.a.at![0], p.b.at![0], p.by])).toEqual([
      [0, 10, "key"],
      [5000, 5020, "key"],
    ]);
  });
  it("без ключа — по положению в пределах допуска; разные марки по положению не сводятся", () => {
    const a = [{ key: "", at: [0, 0] as [number, number], frame: "bld" as const }, { key: "Д7", at: [100, 0] as [number, number], frame: "bld" as const }];
    const b = [{ key: "", at: [300, 0] as [number, number], frame: "bld" as const }, { key: "Д8", at: [100, 0] as [number, number], frame: "bld" as const }];
    const r = matchElements(a, b, 400);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ by: "position", shift: 300 });
    expect(r.onlyA.map((x) => x.key)).toEqual(["Д7"]);
    expect(r.onlyB.map((x) => x.key)).toEqual(["Д8"]);
  });
  it("граница допуска положения: ровно допуск — пара, дальше — без пары", () => {
    const a = [{ key: "", at: [0, 0] as [number, number], frame: "bld" as const }];
    expect(matchElements(a, [{ key: "", at: [400, 0], frame: "bld" }], 400).pairs).toHaveLength(1);
    expect(matchElements(a, [{ key: "", at: [400.001, 0], frame: "bld" }], 400).pairs).toHaveLength(0);
  });
  it("ключ: латиница как кириллица, регистр и пробелы не важны", () => {
    expect(normKey(" p1.")).toBe(normKey("Р1"));
    expect(() => matchElements([], [], -1)).toThrow(/допуск/);
  });
});

describe("CMP-14: смещение в осях здания", () => {
  it("шахта Л2 смещена на 300 мм — moved; Л1 в допуске", () => {
    const f = fx("lifts");
    expect(positionShift(by(f.PD, "Л1"), by(f.RD, "Л1"), 50, 20)).toMatchObject({ ok: true, moved: false });
    expect(positionShift(by(f.PD, "Л2"), by(f.RD, "Л2"), 50, 20)).toMatchObject({ ok: true, shift_mm: 300, moved: true });
  });
  it("предусловие регистрации: остаток больше допуска или лист не в осях здания — не сравнивается", () => {
    const f = fx("lifts");
    expect(positionShift(by(f.PD, "Л2"), { ...by(f.RD, "Л2"), residual_mm: 25 }, 50, 20)).toMatchObject({ ok: false, why: expect.stringMatching(/остаток регистрации/) });
    expect(positionShift(by(f.PD, "Л2"), { ...by(f.RD, "Л2"), residual_mm: 20 }, 50, 20)).toMatchObject({ ok: true });
    expect(positionShift(by(f.PD, "Л2"), { ...by(f.RD, "Л2"), frame: "sheet" }, 50, 20)).toMatchObject({ ok: false, why: expect.stringMatching(/не зарегистрирован/) });
    expect(positionShift(by(f.PD, "Л2"), { ...by(f.RD, "Л2"), residual_mm: null }, 50, 20)).toMatchObject({ ok: false });
  });
});

describe("CMP-15: изменение контура", () => {
  const P = { iou_min: 0.95, hausdorff_mm: 300, tol_area: 0.05, spread_pct: 2, reg_mm: 50 };
  it("перепланировка: IoU 0,7 — контур изменился", () => {
    const f = fx("rooms");
    const v = shapeChange(by(f.PD, "101"), by(f.RD, "101"), P);
    expect(v).toMatchObject({ ok: true, changed: true });
    if (v.ok) expect(v.iou).toBeCloseTo(0.7, 9);
  });
  it("обратная логика: контур тот же, площадь в экспликации другая — изменение методики подсчёта", () => {
    const f = fx("rooms");
    expect(shapeChange(by(f.PD, "102"), by(f.RD, "102"), P)).toMatchObject({ ok: true, changed: false, method_change: true, area_a: 12, area_b: 11.2 });
    expect(shapeChange(by(f.PD, "103"), by(f.RD, "103"), P)).toMatchObject({ ok: true, changed: false, method_change: false });
  });
  it("контур без регистрации или вырожденный — отказ с причиной", () => {
    const f = fx("rooms");
    expect(shapeChange(by(f.PD, "103"), { ...by(f.RD, "103"), frame: "sheet" }, P)).toMatchObject({ ok: false, why: expect.stringMatching(/оси здания/) });
    expect(shapeChange(by(f.PD, "103"), { ...by(f.RD, "103"), polygon: [[0, 0], [1, 0]] }, P)).toMatchObject({ ok: false, why: expect.stringMatching(/меньше трёх/) });
  });
});

describe("CMP-16: пространственные предикаты", () => {
  const rd = () => fx("fire").RD!;
  const ofE = (code: string) => ({ [code]: rd().filter((m) => m.entity === code) });
  it("покрытие помещения радиусами извещателей: 6,4 м покрывает, 3 м — нет", () => {
    const det = rd().filter((m) => m.kind === "smoke_detector");
    expect(checkRelation({ kind: "covers", of: "ENT-01", radius_mm: 6400, step_mm: 500 }, det, ofE("ENT-01"), 2)).toMatchObject({ ok: true, violations: [] });
    const v = checkRelation({ kind: "covers", of: "ENT-01", radius_mm: 3000, step_mm: 500 }, det, ofE("ENT-01"), 2);
    expect(v.ok && v.violations.length).toBe(1);
  });
  it("шаг точек: ближайший сосед дальше шага — нарушение у каждой такой точки", () => {
    const det = rd().filter((m) => m.kind === "smoke_detector");
    expect(checkRelation({ kind: "max_spacing", max_mm: 6000 }, det, {}, 2)).toMatchObject({ ok: true, violations: [] });
    const v = checkRelation({ kind: "max_spacing", max_mm: 5999 }, det, {}, 2);
    expect(v.ok && v.violations.map((x) => x.key)).toEqual(["ИП1", "ИП2"]);
  });
  it("ОЗК у пересечения воздуховода с противопожарной преградой: у С2 клапана нет, обычная стена С3 не преграда", () => {
    const pred = { kind: "near_crossing" as const, barrier: "ENT-11", barrier_kinds: ["fire"], device: "ENT-08", device_kinds: ["fire_damper"], radius_mm: 1000 };
    const duct = rd().filter((m) => m.kind === "duct");
    const v = checkRelation(pred, duct, predicateOthers(pred, { "ENT-11": rd().filter((m) => m.entity === "ENT-11"), "ENT-08": rd().filter((m) => m.entity === "ENT-08") }), 2);
    expect(v.ok && v.checked).toBe(2);
    expect(v.ok && v.violations.map((x) => x.at)).toEqual([[14000, 10000]]);
  });
  it("внутри, пересекает, расстояние", () => {
    const det = rd().filter((m) => m.kind === "smoke_detector");
    expect(checkRelation({ kind: "inside", of: "ENT-01" }, det, ofE("ENT-01"), 2)).toMatchObject({ violations: [] });
    expect(checkRelation({ kind: "intersects", of: "ENT-11" }, det, ofE("ENT-11"), 2)).toMatchObject({ ok: true });
    const d = checkRelation({ kind: "distance", of: "ENT-11", max_mm: 5100 }, det, ofE("ENT-11"), 2);
    expect(d.ok && d.violations.map((x) => x.key)).toEqual(["ИП1"]);
  });
  it("пусто или разные системы координат — отказ с причиной, а не «нарушений нет»", () => {
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [], {}, 2)).toMatchObject({ ok: false });
    const det = rd().filter((m) => m.kind === "smoke_detector");
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [det[0], { ...det[1], frame: "sheet" }], {}, 2)).toMatchObject({ ok: false, why: expect.stringMatching(/разных листах/) });
    expect(checkRelation({ kind: "inside", of: "ENT-01" }, det, {}, 2)).toMatchObject({ ok: false, why: expect.stringMatching(/нет элементов ENT-01/) });
  });
});

describe("CMP-19: топология сети", () => {
  it("уровень по менее детальной стороне: отводы и решётки РД стянуты, пропало подключение П3–Т12", () => {
    const f = fx("vent");
    const d = compareGraphs(f.PD![0].graph!, f.RD![0].graph!)!;
    expect(d.level).toEqual(["riser", "unit"]);
    expect(d.removed_nodes).toEqual([]);
    expect(d.removed_edges).toEqual([["П3", "Т12"]]);
    expect(d.added_edges).toEqual([]);
    expect(d.changed).toBe(true);
    expect(d.cost).toBe(2);
  });
  it("переименование дешевле удаления ветви; добавление — детализация, не изменение", () => {
    const g = (units: string[]) => ({ nodes: [{ id: "t", kind: "riser", mark: "Т1" }, ...units.map((u) => ({ id: u, kind: "unit", mark: u }))], edges: units.map((u) => ["t", u] as [string, string]) });
    const ren = compareGraphs(g(["П1", "П2"]), { nodes: [{ id: "t", kind: "riser", mark: "Т1" }, { id: "П1", kind: "unit", mark: "П1" }, { id: "x", kind: "unit", mark: "П9" }], edges: [["t", "П1"], ["t", "x"]] })!;
    expect(ren.renamed).toEqual([["П2", "П9"]]);
    const del = compareGraphs(g(["П1", "П2"]), g(["П1"]))!;
    expect(del.removed_nodes).toEqual(["П2"]);
    expect(del.cost).toBeGreaterThan(ren.cost);
    const add = compareGraphs(g(["П1"]), g(["П1", "П2"]))!;
    expect(add).toMatchObject({ changed: false, added_nodes: ["П2"] });
  });
  it("пустой граф (нет узлов с маркой) — null; ребро к несуществующему узлу — громкий отказ", () => {
    expect(compareGraphs({ nodes: [{ id: "a", kind: "bend", mark: null }], edges: [] }, fx("vent").RD![0].graph!)).toBeNull();
    expect(() => compareGraphs({ nodes: [], edges: [["a", "b"]] }, { nodes: [], edges: [] })).toThrow(/несуществующему узлу/);
    expect(() => compareGraphs({ nodes: [{ id: "a", kind: "u", mark: "A" }, { id: "a", kind: "u", mark: "B" }], edges: [] }, { nodes: [], edges: [] })).toThrow(/повторяется/);
  });
});

describe("знаки чертежа — источник для CMP-07 и CMP-09", () => {
  it("счёт знаков по листу: упоминание count, by = geometry, без статуса", () => {
    const rd = fx("fire").RD!;
    const c = symbolCount([...rd, { ...rd[0], page: 2 }], { kinds: ["smoke_detector"] });
    expect(c.map((m) => [m.page, m.value, m.measure, m.by])).toEqual([
      [1, 2, "count", "geometry"],
      [2, 1, "count", "geometry"],
    ]);
  });
  it("наличие по форме PresenceMention: знаков нет на просмотренном листе — absent", () => {
    const rd = fx("fire").RD!;
    const p = symbolPresence(rd, { kinds: ["fire_damper"] }, "ozk", [1, 5]);
    expect(p.map((x) => [x.page, x.state, x.count, x.source])).toEqual([
      [1, "present", 1, "plan_geometry"],
      [5, "absent", 0, "plan_geometry"],
    ]);
  });
});
