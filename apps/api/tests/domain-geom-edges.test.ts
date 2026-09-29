// Эшелоны: L3 (границы: касание, наклонные рёбра, вершина на луче, пороги ±ε), L6 (вырожденные и битые входы — громкий
// отказ или NOT_COMPARABLE), L8 (добивка мутантов Stryker по geom-*.ts: каждый тест закрывает поведение, которое
// мутант менял незаметно для основных наборов). Название теста — ссылка трассы, T-193. Геометрия синтетическая.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { applyFrame, distance, hausdorff, intersectionArea, iou, pointInPolygon, polygonArea, polylineCrossings, segmentHit, signedArea, triangulate, validPolygon, type Pt } from "../src/domain/geom-core.ts";
import { matchElements, normKey } from "../src/domain/geom-match.ts";
import {
  checkRelation,
  compareGraphs,
  convertUnit,
  positionShift,
  predicateOthers,
  realFactor,
  resolveArea,
  resolveDim,
  resolveNorm,
  scaleOk,
  shapeChange,
  symbolCount,
  symbolPresence,
  type GeomMention,
  type NormRecord,
} from "../src/domain/geom-ops.ts";

const BASE: NormRecord[] = JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")).base;
const SQ: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

const G = (over: Partial<GeomMention> = {}): GeomMention => ({
  entity: "ENT-10", measure: "length", value: null, unit: "м", by: "geometry", label_value: null, measured_value: null, key: "", at: null, polygon: null, graph: null,
  frame: "bld", scale_n: 100, scale_spread_pct: 0, residual_mm: 1, page: 1, bbox: null, quote: "", kind: null, system: null, ...over,
});

describe("geom-core: границы контура и разбиения (L3, L6)", () => {
  it("замкнутый контур из двух точек — меньше трёх точек; координата x не число, кортеж не из двух чисел", () => {
    expect(validPolygon([[0, 0], [1, 1], [0, 0]])).toBe("в контуре меньше трёх точек (2)");
    expect(validPolygon(null)).toBe("контура нет");
    expect(validPolygon([[0, 0], [Infinity, 1], [2, 2]])).toBe("координата контура — не число");
    expect(validPolygon([[0, 0], [1, 1, 1] as unknown as Pt, [2, 0]])).toBe("координата контура — не число");
    expect(validPolygon([[0, 0], "x" as unknown as Pt, [2, 0]])).toBe("координата контура — не число");
  });
  it("самопересечение в обе стороны обхода и через замыкающее ребро; касание вершиной ребра — не самопересечение", () => {
    const bow: Pt[] = [[0, 0], [10, 0], [0, 10], [10, 10]];
    expect(validPolygon(bow)).toBe("контур самопересекается");
    expect(validPolygon([...bow].reverse())).toBe("контур самопересекается");
    expect(validPolygon([[0, 10], [0, 0], [10, 10], [10, 0]])).toBe("контур самопересекается");
    expect(validPolygon([[0, 0], [10, 0], [10, 10], [5, 0.5], [0, 10]])).toBeNull();
    expect(validPolygon([[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]])).toBeNull(); // вершина на ребре — касание
  });
  it("разбиение: треугольники против часовой, площади складываются в площадь контура, в том числе при заблокированном ухе и старте с вогнутой вершины", () => {
    const polys: Pt[][] = [
      [[0, 0], [10, 0], [10, 10], [5, 1], [0, 10]], // ухо у (0,0) накрывает вогнутую (5,1)
      [[10, 10], [10, 20], [0, 20], [0, 0], [20, 0], [20, 10]], // старт с вогнутой вершины
      [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]], // точка посреди прямого участка
    ];
    for (const poly of polys) {
      const t = triangulate(poly);
      for (const x of t) expect(signedArea(x)).toBeGreaterThan(0);
      expect(t.reduce((s, x) => s + polygonArea(x), 0)).toBeCloseTo(polygonArea(poly), 9);
    }
    expect(triangulate(polys[2])).toHaveLength(2); // точка посреди стороны убрана — квадрат из двух треугольников
    expect(triangulate([[0, 0], [5, 0.001], [10, 0], [10, 10], [0, 10]])).toHaveLength(3);
  });
  it("точка в полигоне с наклонными рёбрами и на уровне вершины", () => {
    const tri: Pt[] = [[0, 0], [10, 0], [0, 10]];
    expect(pointInPolygon([4, 4], tri)).toBe(true);
    expect(pointInPolygon([6, 6], tri)).toBe(false);
    expect(pointInPolygon([1, 8.5], tri)).toBe(true);
    expect(pointInPolygon([1, 9.5], tri)).toBe(false);
    const L: Pt[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
    expect(pointInPolygon([5, 10], L)).toBe(true);
    expect(pointInPolygon([-5, 10], L)).toBe(false);
    expect(pointInPolygon([25, 10], L)).toBe(false);
  });
  it("пересечение и IoU: вложенный контур и касание вершиной", () => {
    const inner: Pt[] = [[2, 2], [4, 2], [4, 4], [2, 4]];
    expect(intersectionArea(SQ, inner)).toBeCloseTo(4, 9);
    expect(iou(SQ, inner)).toBeCloseTo(0.04, 9);
    expect(intersectionArea(SQ, [[10, 10], [20, 10], [20, 20]])).toBeCloseTo(0, 9);
  });
});

describe("geom-core: Хаусдорф, отрезки, расстояния (L3)", () => {
  it("Хаусдорф: максимум посреди ребра без вершин рядом; пустой контур — отказ; отрезки", () => {
    const notch: Pt[] = [[0, 0], [10, 0], [10, 10], [6, 2], [4, 2], [0, 10]];
    expect(hausdorff(SQ, notch)).toBeCloseTo(2 * Math.sqrt(5), 1);
    expect(hausdorff(notch, SQ)).toBeCloseTo(2 * Math.sqrt(5), 1);
    expect(() => hausdorff(null as unknown as Pt[], SQ)).toThrow(/пуст/);
    expect(() => hausdorff(SQ, [])).toThrow(/пуст/);
    expect(hausdorff([[0, 0], [10, 0]], [[0, 1], [10, 1]])).toBeCloseTo(1, 9);
    expect(hausdorff(SQ, SQ, 0.5)).toBeCloseTo(0, 9);
  });
  it("пересечение отрезков: наклонные, промахи по обоим параметрам, касание концом, параллельные", () => {
    expect(segmentHit([0, 0], [10, 10], [0, 10], [10, 0])).toEqual([5, 5]);
    expect(segmentHit([0, 0], [4, 2], [1, 3], [3, -1])).toEqual([2, 1]);
    expect(segmentHit([0, 0], [10, 0], [11, -1], [11, 1])).toBeNull();
    expect(segmentHit([0, 0], [10, 0], [-1, -1], [-1, 1])).toBeNull();
    expect(segmentHit([0, 0], [10, 0], [5, 1], [5, 3])).toBeNull();
    expect(segmentHit([0, 0], [10, 0], [5, -3], [5, -1])).toBeNull();
    expect(segmentHit([0, 0], [10, 0], [10, -1], [10, 1])).toEqual([10, 0]);
    expect(segmentHit([0, 0], [10, 0], [5, 0], [15, 0])).toBeNull();
  });
  it("расстояния: точка — полигон, полигон — точка, точка — точка, отрезок — полигон, пересекающиеся отрезки, вложение", () => {
    expect(distance([[5, 20]], SQ)).toBe(10);
    expect(distance(SQ, [[5, 20]])).toBe(10);
    expect(distance([[0, 0]], [[3, 4]])).toBe(5);
    expect(distance([[20, 0], [20, 10]], SQ)).toBe(10);
    expect(distance([[0, 0], [10, 10]], [[0, 10], [10, 0]])).toBe(0);
    expect(distance([[2, 2], [3, 2], [3, 3]], SQ)).toBe(0);
    expect(distance([[4, 4]], SQ)).toBe(0);
  });
  it("пересечение ломаной через вершину ломаной считается один раз; порядок — по звеньям трассы, затем по преградам", () => {
    expect(polylineCrossings([[0, 5], [10, 5], [20, 5]], [[[10, 0], [10, 10]]])).toEqual([{ at: [10, 5], seg: 0 }]);
    expect(polylineCrossings([[0, 5], [20, 5]], [[[15, 0], [15, 10]], [[5, 0], [5, 10]]]).map((x) => x.seg)).toEqual([0, 1]);
  });
  it("матрица to_bld: каждый коэффициент на своём месте", () => {
    expect(applyFrame([2, 3], [1, 0, 0, 1, 0, 0])).toEqual([2, 3]);
    expect(applyFrame([2, 3], [5, 7, 11, 13, 17, 19])).toEqual([5 * 2 + 11 * 3 + 17, 7 * 2 + 13 * 3 + 19]);
  });
});

describe("LNK-06: сопоставление — границы (L3)", () => {
  const P = (key: string, at: Pt | null, frame: "bld" | "sheet" = "bld") => ({ key, at, frame });
  it("ключ: латиница A B C E H K M O P T X как кириллица, точки в конце, пробелы внутри", () => {
    expect(normKey("ABCEHKMOPTX")).toBe("АВСЕНКМОРТХ");
    expect(normKey("Д 1..")).toBe("Д1");
    expect(normKey("Д.1")).toBe("Д.1");
    expect(normKey(null)).toBe("");
  });
  it("по положению — только в одной системе координат и в пределах допуска; жадно по возрастанию расстояния", () => {
    expect(matchElements([P("", [0, 0])], [P("", [10, 0], "sheet")], 1000).pairs).toHaveLength(0);
    expect(matchElements([P("", null)], [P("", [0, 0])], 1000).pairs).toHaveLength(0);
    const r = matchElements([P("", [0, 0]), P("", [100, 0])], [P("", [90, 0]), P("", [5, 0])], 1000);
    expect(r.pairs.map((p) => [p.a.at![0], p.b.at![0]])).toEqual([
      [0, 5],
      [100, 90],
    ]);
    expect(matchElements([P("", [0, 0])], [P("", [0, 0])], 0).pairs).toHaveLength(1);
  });
  it("ключ без пары сводится по положению с элементом без ключа; оставшиеся — в «только A/B»", () => {
    const r = matchElements([P("Д1", [0, 0]), P("Д2", [500, 0])], [P("", [10, 0])], 100);
    expect(r.pairs.map((p) => [p.a.key, p.by, p.shift])).toEqual([["Д1", "position", 10]]);
    expect(r.onlyA.map((x) => x.key)).toEqual(["Д2"]);
    const k = matchElements([P("Д1", null)], [P("д1", [1, 1])], 100);
    expect(k.pairs[0]).toMatchObject({ by: "key", shift: null });
    expect(matchElements([P("", [0, 0])], [], 10).onlyA).toHaveLength(1);
    expect(matchElements([], [P("Х", [0, 0])], 10).onlyB.map((x) => x.key)).toEqual(["Х"]);
  });
});

describe("операторы: границы и отказы (L3, L6)", () => {
  it("единицы: см, мм², см², шт как есть", () => {
    expect(convertUnit(25, "см", "мм")).toBe(250);
    expect(convertUnit(1500, "мм", "м")).toBe(1.5);
    expect(convertUnit(3, "см²", "мм²")).toBe(300);
    expect(convertUnit(2, "м²", "см²")).toBe(20000);
    expect(convertUnit(7, "шт", "шт")).toBe(7);
    expect(() => convertUnit(1, "шт", "м")).toThrow("единицы несопоставимы: шт → м");
  });
  it("норма без ссылки с числом паспорта; максимум нормы; действие по датам; норма не подтверждена — с пунктом", () => {
    expect(resolveNorm({ kind: "max", value: 6.4, basis: "проект" }, BASE, "2026-01-01", "м")).toEqual({ kind: "max", value: 6.4, unit: "м", text: "≤ 6,4 м (проект)", record: null });
    expect(resolveNorm({ kind: "min", value: 1, basis: "проект" }, BASE, "2026-01-01", "м")).toMatchObject({ text: "≥ 1 м (проект)" });
    const recs: NormRecord[] = [
      { ...BASE[0], id: "x", min: 1, max: 2, unit: "м", clause: null, effective_from: "2020-01-01", effective_to: "2020-12-31" },
      { ...BASE[0], id: "x", min: 3, max: 4, unit: "м", clause: "п. 1", effective_from: "2021-01-01", effective_to: null },
    ];
    expect(resolveNorm({ kind: "min", value: null, basis: "b", ref: "x" }, recs, "2020-06-01T10:00:00Z", "м")).toMatchObject({ value: 1, text: expect.stringMatching(/^≥ 1 м по СП 1\.13130\.2020 — /) });
    expect(resolveNorm({ kind: "max", value: null, basis: "b", ref: "x" }, recs, "2021-06-01", "мм")).toMatchObject({ kind: "max", value: 4000, text: expect.stringMatching(/^≤ 4000 мм по СП 1\.13130\.2020, п\. 1 — /) });
    expect(resolveNorm({ kind: "min", value: null, basis: "b", ref: "x" }, recs, "2020-12-31", "м")).toMatchObject({ value: 1 });
    expect(resolveNorm({ kind: "min", value: null, basis: "b", ref: "x" }, recs, "2021-01-01", "м")).toMatchObject({ value: 3 });
    expect(resolveNorm({ kind: "min", value: null, basis: "b", ref: "x" }, [{ ...recs[1], effective_from: null, unverified: true }], "2019-01-01", "м")).toEqual({ why: "норма СП 1.13130.2020, п. 1: число не подтверждено по тексту — сравнение с нормой не выполняется" });
    expect(resolveNorm({ kind: "max", value: null, basis: "b", ref: "x" }, [{ ...recs[1], clause: null, max: null }], "2022-01-01", "м")).toEqual({ why: "норма СП 1.13130.2020: число не подтверждено по тексту — сравнение с нормой не выполняется" });
  });
  it("масштаб годен: известен, положителен, разброс не выше порога включительно", () => {
    expect(scaleOk({ scale_n: 100, scale_spread_pct: 2 }, 2)).toBe(true);
    expect(scaleOk({ scale_n: 100, scale_spread_pct: 2.001 }, 2)).toBe(false);
    expect(scaleOk({ scale_n: 0, scale_spread_pct: 0 }, 2)).toBe(false);
    expect(scaleOk({ scale_n: null, scale_spread_pct: 0 }, 2)).toBe(false);
    expect(realFactor(G({ frame: "sheet", scale_n: 50 }), 2)).toBe(50);
    expect(realFactor(G({ frame: "bld", scale_n: null }), 2)).toBe(1);
    expect(realFactor(G({ frame: "sheet", scale_n: null }), 2)).toBeNull();
  });
  it("CMP-12: значение из value по способу, надпись 0, нечисловое измерение, ничего нет", () => {
    expect(resolveDim(G({ by: "dimension", value: 0.9 }), 2, 2)).toEqual({ value: 0.9, by: "dimension", not_to_scale: false, diff_pct: null, why: null });
    expect(resolveDim(G({ by: "geometry", value: 0.9 }), 2, 2)).toEqual({ value: 0.9, by: "geometry", not_to_scale: false, diff_pct: null, why: null });
    expect(resolveDim(G({ by: "both", value: 0.9 }), 2, 2)).toEqual({ value: null, by: null, not_to_scale: false, diff_pct: null, why: "ни надписи размера, ни измерения" });
    expect(resolveDim(G({ label_value: 0, measured_value: 0 }), 2, 2)).toMatchObject({ value: 0, not_to_scale: false, diff_pct: 0 });
    expect(resolveDim(G({ label_value: 0, measured_value: 1 }), 2, 2)).toMatchObject({ value: 0, not_to_scale: true, diff_pct: Infinity });
    expect(resolveDim(G({ label_value: 1, measured_value: NaN }), 2, 2)).toEqual({ value: 1, by: "dimension", not_to_scale: false, diff_pct: null, why: null });
    expect(resolveDim(G({ label_value: NaN, measured_value: 1 }), 2, 2)).toMatchObject({ value: 1, by: "geometry" });
    expect(resolveDim(G({ measured_value: 1, scale_n: 100, scale_spread_pct: 3 }), 2, 2)).toEqual({ value: null, by: null, not_to_scale: false, diff_pct: null, why: "разброс масштаба 3 % больше 2 %" });
    expect(resolveDim(G({ label_value: 1, measured_value: 0.97 }), 2, 2)).toMatchObject({ not_to_scale: true });
    expect(resolveDim(G({ label_value: 1, measured_value: 1.02 }), 2, 2)).toMatchObject({ not_to_scale: false });
  });
  it("CMP-13: значение по способу без контура, контур при негодном масштабе, экспликация 0, контроль на границе", () => {
    const sq = [[0, 0], [2000, 0], [2000, 2000], [0, 2000]] as Pt[]; // 4 м²
    expect(resolveArea(G({ by: "dimension", value: 5 }), "м²", 2, 2)).toEqual({ value: 5, by: "dimension", geom_value: null, control_diff_pct: null, control_flag: false, why: null });
    expect(resolveArea(G({ by: "geometry", value: 5 }), "м²", 2, 2)).toEqual({ value: 5, by: "geometry", geom_value: 5, control_diff_pct: null, control_flag: false, why: null });
    expect(resolveArea(G({ by: "geometry", value: 5, scale_n: null, frame: "sheet" }), "м²", 2, 2)).toEqual({ value: null, by: null, geom_value: null, control_diff_pct: null, control_flag: false, why: "ни значения экспликации, ни контура" });
    expect(resolveArea(G({ polygon: sq, frame: "sheet", scale_n: null }), "м²", 2, 2)).toEqual({ value: null, by: null, geom_value: null, control_diff_pct: null, control_flag: false, why: "масштаб листа не годен для площади" });
    expect(resolveArea(G({ polygon: sq, frame: "sheet", scale_n: null, label_value: 4 }), "м²", 2, 2)).toEqual({ value: 4, by: "dimension", geom_value: null, control_diff_pct: null, control_flag: false, why: null });
    expect(resolveArea(G({ polygon: sq, label_value: 0 }), "м²", 2, 2)).toMatchObject({ value: 0, by: "both", control_diff_pct: null, control_flag: false });
    expect(resolveArea(G({ polygon: sq, label_value: 4.08 }), "м²", 2, 2).control_flag).toBe(false);
    expect(resolveArea(G({ polygon: sq, label_value: 3.9 }), "м²", 2, 2).control_flag).toBe(true);
    expect(resolveArea(G({ polygon: sq, measured_value: 99 }), "м²", 2, 2)).toMatchObject({ value: 4, by: "geometry" });
  });
  it("CMP-14: граница допуска смещения и регистрации, нет положения, лист не в осях у эталона", () => {
    const a = G({ key: "Л1", at: [0, 0], residual_mm: 20 });
    expect(positionShift(a, G({ key: "Л1", at: [50, 0], residual_mm: 20 }), 50, 20)).toEqual({ ok: true, shift_mm: 50, moved: false });
    expect(positionShift(a, G({ key: "Л1", at: [50.01, 0], residual_mm: 20 }), 50, 20)).toMatchObject({ moved: true });
    expect(positionShift(G({ ...a, residual_mm: 20.01 }), a, 50, 20)).toEqual({ ok: false, why: "остаток регистрации листа стр. 1 20,01 мм больше допуска 20 мм" });
    expect(positionShift(G({ ...a, residual_mm: null }), a, 50, 20)).toEqual({ ok: false, why: "остаток регистрации листа стр. 1 неизвестен больше допуска 20 мм" });
    expect(positionShift(a, G({ key: "Л1", at: null, page: 4 }), 50, 20)).toEqual({ ok: false, why: "у элемента «Л1» (стр. 4) нет положения" });
    expect(positionShift(G({ ...a, frame: "sheet", page: 2 }), a, 50, 20)).toEqual({ ok: false, why: "лист стр. 2 не зарегистрирован в осях здания" });
  });
  it("CMP-15: пороги IoU и Хаусдорфа на границе, лист у эталона, остаток регистрации, масштаб, без экспликации", () => {
    const sq = (x: number): Pt[] => [[x, 0], [x + 1000, 0], [x + 1000, 1000], [x, 1000]];
    const a = G({ key: "1", polygon: sq(0), label_value: 1 });
    const P = { iou_min: 0.95, hausdorff_mm: 300, tol_area: 0.05, spread_pct: 2, reg_mm: 50 };
    expect(shapeChange(a, G({ key: "1", polygon: sq(0), label_value: 1.05 }), P)).toMatchObject({ changed: false, method_change: false });
    expect(shapeChange(a, G({ key: "1", polygon: sq(0), label_value: 1.06 }), P)).toMatchObject({ method_change: true });
    expect(shapeChange(a, G({ key: "1", polygon: sq(0), label_value: null }), P)).toMatchObject({ method_change: false });
    expect(shapeChange(G({ ...a, label_value: null }), G({ key: "1", polygon: sq(0), label_value: 5 }), P)).toMatchObject({ method_change: false });
    const shift = shapeChange(a, G({ key: "1", polygon: sq(300), label_value: 1 }), { ...P, iou_min: 0 });
    expect(shift).toMatchObject({ ok: true, hausdorff_mm: 300, changed: false });
    expect(shapeChange(a, G({ key: "1", polygon: sq(301), label_value: 1 }), { ...P, iou_min: 0 })).toMatchObject({ changed: true });
    const v = shapeChange(a, G({ key: "1", polygon: sq(10), label_value: 1 }), { ...P, hausdorff_mm: 1e9 });
    expect(v.ok && v.iou).toBeCloseTo(990 / 1010, 9);
    expect(shapeChange(a, G({ key: "1", polygon: sq(10) }), { ...P, iou_min: 990 / 1010, hausdorff_mm: 1e9 })).toMatchObject({ changed: false });
    expect(shapeChange(a, G({ key: "1", polygon: sq(10) }), { ...P, iou_min: 990 / 1010 + 1e-6, hausdorff_mm: 1e9 })).toMatchObject({ changed: true });
    expect(shapeChange(G({ ...a, frame: "sheet" }), a, P)).toEqual({ ok: false, why: "контур не переведён в оси здания — нужна регистрация листов (LNK-03)" });
    expect(shapeChange(a, G({ ...a, residual_mm: 51, page: 3 }), P)).toEqual({ ok: false, why: "остаток регистрации листа стр. 3 больше допуска 50 мм" });
    expect(shapeChange(G({ ...a, residual_mm: null }), a, P)).toMatchObject({ ok: false });
    expect(shapeChange(G({ ...a, polygon: null }), a, P)).toEqual({ ok: false, why: "контур «1» (стр. 1): контура нет" });
  });
  it("CMP-16: отбор сущностей предиката по видам; пустой предикат шага; точки на листе через масштаб", () => {
    const others = { "ENT-11": [G({ entity: "ENT-11", kind: "fire" }), G({ entity: "ENT-11", kind: "plain" })], "ENT-08": [G({ entity: "ENT-08", kind: "fire_damper" }), G({ entity: "ENT-08", kind: "smoke_detector" })], "ENT-01": [G({ entity: "ENT-01", kind: "room" })] };
    const nc = predicateOthers({ kind: "near_crossing", barrier: "ENT-11", barrier_kinds: ["fire"], device: "ENT-08", device_kinds: ["fire_damper"], radius_mm: 1 }, others);
    expect(Object.keys(nc)).toEqual(["ENT-11", "ENT-08"]);
    expect(nc["ENT-11"].map((m) => m.kind)).toEqual(["fire"]);
    expect(nc["ENT-08"].map((m) => m.kind)).toEqual(["fire_damper"]);
    expect(predicateOthers({ kind: "near_crossing", barrier: "ENT-11", device: "ENT-09", radius_mm: 1 }, others)).toEqual({ "ENT-11": others["ENT-11"], "ENT-09": [] });
    expect(predicateOthers({ kind: "max_spacing", max_mm: 1 }, others)).toEqual({});
    expect(predicateOthers({ kind: "inside", of: "ENT-01", of_kinds: [] }, others)).toEqual({ "ENT-01": others["ENT-01"] });
    expect(predicateOthers({ kind: "inside", of: "ENT-01", of_kinds: ["corridor"] }, others)).toEqual({ "ENT-01": [] });
    const pts = [G({ key: "a", at: [0, 0], frame: "sheet", scale_n: 100 }), G({ key: "b", at: [10, 0], frame: "sheet", scale_n: 100 })];
    expect(checkRelation({ kind: "max_spacing", max_mm: 1000 }, pts, {}, 2)).toEqual({ ok: true, checked: 2, violations: [] });
    const far = checkRelation({ kind: "max_spacing", max_mm: 999 }, pts, {}, 2);
    expect(far.ok && far.violations.map((v) => [v.key, v.at, v.why])).toEqual([
      ["a", [0, 0], "до ближайшего 1000 мм — больше шага 999 мм"],
      ["b", [1000, 0], "до ближайшего 1000 мм — больше шага 999 мм"],
    ]);
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [pts[0]], {}, 2)).toEqual({ ok: true, checked: 1, violations: [] });
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [G({ at: [0, 0], frame: "sheet", scale_n: null })], {}, 2)).toEqual({ ok: false, why: "масштаб листа не годен или у элемента нет положения" });
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [G({ at: null })], {}, 2)).toMatchObject({ ok: false });
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [], {}, 2)).toEqual({ ok: false, why: "элементов для проверки нет" });
    expect(checkRelation({ kind: "max_spacing", max_mm: 1 }, [pts[0], G({ at: [0, 0], frame: "sheet", page: 2 })], {}, 2)).toEqual({ ok: false, why: "элементы на разных листах без регистрации в осях здания" });
  });
  it("CMP-16: внутри, пересекает, расстояние — причины с числом и центром элемента", () => {
    const room = G({ entity: "ENT-01", polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] });
    const wall = G({ entity: "ENT-11", polygon: [[2000, 0], [2000, 1000]] });
    const inRoom = G({ key: "в", polygon: [[100, 100], [200, 100], [200, 200]] });
    const cross = G({ key: "п", polygon: [[900, 500], [1100, 500], [1000, 600]] });
    const out = G({ key: "с", at: [1500, 500] });
    const ins = checkRelation({ kind: "inside", of: "ENT-01" }, [inRoom, cross, out], { "ENT-01": [room] }, 2);
    expect(ins.ok && ins.violations.map((v) => [v.key, v.why])).toEqual([
      ["п", "«п» не внутри ENT-01"],
      ["с", "«с» не внутри ENT-01"],
    ]);
    expect(ins.ok && ins.violations[0].at).toEqual([1000, 1600 / 3]);
    const hit = checkRelation({ kind: "intersects", of: "ENT-01" }, [inRoom, cross, out], { "ENT-01": [room] }, 2);
    expect(hit.ok && hit.violations.map((v) => [v.key, v.why])).toEqual([["с", "«с» не пересекает ENT-01"]]);
    const d = checkRelation({ kind: "distance", of: "ENT-11", max_mm: 500 }, [out, G({ key: "д", at: [1499, 500] })], { "ENT-11": [wall] }, 2);
    expect(d.ok && d.violations.map((v) => [v.key, v.why])).toEqual([["д", "«д» дальше 500 мм от ENT-11 (501 мм)"]]);
    expect(checkRelation({ kind: "inside", of: "ENT-11" }, [out], { "ENT-11": [wall] }, 2)).toMatchObject({ ok: true, violations: [{ key: "с" }] });
  });
  it("CMP-16: покрытие — точка контура на границе радиуса, слишком мелкая сетка — отказ, контур-отрезок не проверяется", () => {
    const room = G({ entity: "ENT-01", polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] });
    const c = G({ key: "и", at: [500, 500] });
    const r = Math.hypot(500, 500);
    expect(checkRelation({ kind: "covers", of: "ENT-01", radius_mm: r, step_mm: 250 }, [c], { "ENT-01": [room] }, 2)).toEqual({ ok: true, checked: 4 + 25, violations: [] });
    const v = checkRelation({ kind: "covers", of: "ENT-01", radius_mm: r - 0.01, step_mm: 250 }, [c], { "ENT-01": [room] }, 2);
    expect(v.ok && v.violations).toEqual([{ key: "", at: [0, 0], mention: null, why: "точка контура ENT-01 вне радиуса 707,097 мм" }]);
    expect(() => checkRelation({ kind: "covers", of: "ENT-01", radius_mm: 1, step_mm: 0.4 }, [c], { "ENT-01": [room] }, 2)).toThrow("CMP-16 covers: шаг сетки слишком мал для контура");
    expect(() => checkRelation({ kind: "covers", of: "ENT-01", radius_mm: 1, step_mm: 0.5 }, [c], { "ENT-01": [G({ entity: "ENT-01", polygon: [[0, 0], [1000, 0], [1000, 1]] })] }, 2)).not.toThrow();
    expect(checkRelation({ kind: "covers", of: "ENT-01", radius_mm: 1, step_mm: 10 }, [c], { "ENT-01": [G({ entity: "ENT-01", polygon: [[0, 0], [1000, 0]] })] }, 2)).toEqual({ ok: true, checked: 0, violations: [] });
  });
  it("CMP-16: пересечение трассы с преградой-контуром, устройство ровно на радиусе, без устройств", () => {
    const duct = G({ key: "В1", polygon: [[0, 0], [3000, 0]] });
    const wallPoly = G({ entity: "ENT-11", polygon: [[1000, -100], [1200, -100], [1200, 100], [1000, 100]] });
    const dev = G({ entity: "ENT-08", at: [1000, 500] });
    const pred = { kind: "near_crossing" as const, barrier: "ENT-11", device: "ENT-08", radius_mm: 500 };
    expect(checkRelation(pred, [duct], { "ENT-11": [wallPoly], "ENT-08": [dev] }, 2)).toMatchObject({ ok: true, checked: 2, violations: [{ at: [1200, 0] }] });
    const none = checkRelation(pred, [duct], { "ENT-11": [wallPoly] }, 2);
    expect(none.ok && none.violations.map((v) => v.why)).toEqual(["пересечение трассы «В1» с преградой без ENT-08 в радиусе 500 мм", "пересечение трассы «В1» с преградой без ENT-08 в радиусе 500 мм"]);
    expect(checkRelation(pred, [duct], { "ENT-08": [dev] }, 2)).toEqual({ ok: false, why: "на листе нет элементов ENT-11 для предиката" });
  });
  it("CMP-19: граф без узлов или рёбер, стягивание через цепочку, петля и дубль рёбер, уровень по меньшей стороне", () => {
    expect(() => compareGraphs(null as never, { nodes: [], edges: [] })).toThrow("граф эталона: нет узлов или рёбер");
    expect(() => compareGraphs({ nodes: [], edges: [] }, { nodes: [] } as never)).toThrow("граф сравниваемой стадии: нет узлов или рёбер");
    expect(() => compareGraphs({ nodes: [{ id: "a", kind: "u", mark: "A" }], edges: [["a", "z"]] }, { nodes: [], edges: [] })).toThrow("граф эталона: ребро a–z ведёт к несуществующему узлу");
    const chain = { nodes: [{ id: "1", kind: "unit", mark: "П1" }, { id: "2", kind: "bend", mark: null }, { id: "3", kind: "bend", mark: " " }, { id: "4", kind: "riser", mark: "Т1" }, { id: "5", kind: "unit", mark: "П1" }], edges: [["1", "2"], ["2", "3"], ["3", "4"], ["1", "1"], ["4", "3"]] as Array<[string, string]> };
    const pd = { nodes: [{ id: "a", kind: "unit", mark: "П1" }, { id: "b", kind: "riser", mark: "Т1" }], edges: [["a", "b"]] as Array<[string, string]> };
    expect(compareGraphs(pd, chain)).toMatchObject({ changed: false, removed_edges: [], added_edges: [], cost: 0, nodes_a: ["П1", "Т1"], nodes_b: ["П1", "Т1"] });
    const rich = { nodes: [...pd.nodes, { id: "c", kind: "grille", mark: "Р1" }, { id: "d", kind: "grille", mark: "Р2" }], edges: [["a", "c"], ["c", "b"], ["b", "d"]] as Array<[string, string]> };
    const d = compareGraphs(pd, rich)!;
    expect(d.level).toEqual(["riser", "unit"]);
    expect(d).toMatchObject({ changed: false, added_nodes: [], cost: 0 });
    const back = compareGraphs(rich, pd)!;
    expect(back.level).toEqual(["riser", "unit"]);
    expect(compareGraphs({ nodes: [{ id: "a", kind: "u", mark: "A" }], edges: [] }, { nodes: [{ id: "b", kind: "u", mark: null }], edges: [] })).toBeNull();
  });
  it("CMP-19: переименование — только при тех же соседях и том же виде; изолированный узел не переименовывается; стоимости", () => {
    const g = (nodes: Array<[string, string, string]>, edges: Array<[string, string]>) => ({ nodes: nodes.map(([id, kind, mark]) => ({ id, kind, mark })), edges });
    const a = g([["t", "riser", "Т1"], ["p", "unit", "П1"], ["q", "unit", "П2"], ["i", "unit", "П5"]], [["t", "p"], ["t", "q"]]);
    const b = g([["t", "riser", "Т1"], ["p", "unit", "П1"], ["x", "fan", "В9"], ["y", "unit", "П8"], ["j", "unit", "П6"]], [["t", "p"], ["p", "y"]]);
    const d = compareGraphs(a, b)!;
    expect(d.renamed).toEqual([]);
    expect(d.removed_nodes).toEqual(["П2", "П5"]);
    expect(d.added_nodes).toEqual(["П6", "П8"]);
    expect(d.removed_edges).toEqual([["П2", "Т1"]]);
    expect(d.added_edges).toEqual([["П1", "П8"]]);
    expect(d.cost).toBe(3 * 2 + 1 * 2 + 2 * 1 + 1 * 1);
    const r = compareGraphs(g([["t", "riser", "Т1"], ["q", "unit", "П2"]], [["t", "q"]]), g([["t", "riser", "Т1"], ["y", "unit", "П9"]], [["t", "y"]]))!;
    expect(r).toMatchObject({ renamed: [["П2", "П9"]], removed_nodes: [], added_nodes: [], removed_edges: [], added_edges: [], cost: 1, changed: true });
  });
  it("знаки: фильтр по марке, рамка — объединение рамок, листы по возрастанию, повтор листа в просмотренных", () => {
    const s = (page: number, kind: string, key: string, bbox: GeomMention["bbox"]) => G({ entity: "ENT-08", measure: "count", kind, key, page, bbox, at: [0, 0] });
    const syms = [s(3, "smoke_detector", "ИП1", [0.1, 0.2, 0.3, 0.4]), s(3, "smoke_detector", "ИП2", [0.05, 0.3, 0.2, 0.5]), s(1, "smoke_detector", "Д1", null), s(3, "sounder", "О1", [0, 0, 1, 1])];
    const c = symbolCount(syms, { kinds: ["smoke_detector"], mark: "^ИП" });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ page: 3, value: 2, measured_value: 2, unit: "шт", key: "smoke_detector", bbox: [0.05, 0.2, 0.3, 0.5], quote: "знаков на листе: 2", kind: "smoke_detector", entity: "ENT-08" });
    const all = symbolCount(syms, {});
    expect(all.map((x) => [x.page, x.value, x.key, x.kind, x.bbox])).toEqual([
      [1, 1, "", null, null],
      [3, 3, "", null, [0, 0, 1, 1]],
    ]);
    expect(symbolPresence(syms, { kinds: ["sounder"] }, "оповещение", [5, 3, 3]).map((x) => [x.page, x.state, x.count, x.aspect, x.term, x.quote])).toEqual([
      [3, "present", 1, "оповещение", null, "знаков на листе: 1"],
      [5, "absent", 0, "оповещение", null, "знаков этого вида на листе нет"],
    ]);
  });
});

// ─────────────────────────────── оценщик вида: ветки и границы (L3, L6, L8)
import { evaluateGeomParam, geomOps, isSubject, pickGeom, stageBreaks, type GeomCtx, type GeomPassport, type GeomRef } from "../src/domain/geom-param.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const PRM: Param = {
  code: "M-900", section: "АР", parameter_name: "Параметр", unit: "м", source_pd: "План ПД", source_rd: "План РД", source_id: "Схема ИД", trigger_logic: "Правило.", review_priority: "HIGH",
  data_type: "number", compare: { kind: "equal" }, anchors: [], regex_pattern: null, value_scale: null, applicability: null, is_active: true,
};
const SRC = { PD: [{ discipline: "АР", label: "План АР" }, { discipline: "*" }], RD: [{ discipline: "АР" }, { discipline: "*" }], ID: [{ discipline: "*" }] };
const GP = (over: Partial<GeomPassport> = {}): GeomPassport => ({
  measure: "length", unit: "м", tolerance: 0.01, tolerance_pct: 0, direction: "both", aggregate: "each", norm: null, predicate: null, entity: "ENT-10", also: [], element_kinds: [],
  systems: [], mark: null, share_of: [], label_pct: 2, scale_spread_pct: 2, registration_mm: 50, match_mm: 1000, iou_min: 0.95, hausdorff_mm: 300, sources: SRC, link: null, ...over,
});
const R = (stage: Stage, over: Partial<GeomRef> = {}): GeomRef => ({
  ...G(), stage, file_id: `f${stage}`, sha256: "c".repeat(64), document_code: `100-${stage}`, revision: "1", approval_status: "APPROVED", role: "CURRENT", discipline: "АР",
  excluded: null, excluded_why: null, confidence: 1, ...over,
});
const C = (over: Partial<GeomCtx> = {}): GeomCtx => ({ param: PRM, loadedStages: ["PD", "RD", "ID"], profile: {}, norms: BASE, date: "2026-09-28", ...over });
const len = (stage: Stage, v: number, over: Partial<GeomRef> = {}) => R(stage, { by: "dimension", value: v, label_value: v, page: stage === "PD" ? 1 : 2, ...over });

describe("оценщик вида geometry: операции, фильтры, выбор стадии", () => {
  it("операции каталога по виду измерения, направлению, норме и предикату", () => {
    expect(geomOps(GP())).toEqual(["ENT-10", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "ENT-04", "ENT-06", "CMP-12", "CMP-02", "DEC-01"]);
    expect(geomOps(GP({ direction: "decrease", norm: { kind: "min", value: 1, basis: "b" }, entity: null }))).toEqual(["GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "ENT-04", "ENT-06", "CMP-12", "CMP-03", "CMP-06", "DEC-01"]);
    expect(geomOps(GP({ measure: "area", entity: "ENT-21" }))).toEqual(["ENT-21", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "CMP-13", "CMP-02", "DEC-01"]);
    expect(geomOps(GP({ measure: "count", entity: "ENT-08", predicate: { kind: "max_spacing", max_mm: 1 } }))).toEqual(["ENT-08", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "CMP-02", "CMP-16", "DEC-01"]);
    expect(geomOps(GP({ measure: "position", entity: "ENT-12" }))).toEqual(["ENT-12", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "NRM-09", "LNK-03", "CMP-14", "DEC-01"]);
    expect(geomOps(GP({ measure: "shape", entity: "ENT-01" }))).toEqual(["ENT-01", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "NRM-09", "LNK-03", "CMP-15", "DEC-01"]);
    expect(geomOps(GP({ measure: "relation", entity: "ENT-09", predicate: { kind: "max_spacing", max_mm: 1 } }))).toEqual(["ENT-09", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "CMP-16", "DEC-01"]);
    expect(geomOps(GP({ measure: "topology", entity: "ENT-09" }))).toEqual(["ENT-09", "GTE-01", "GTE-02", "GTE-03", "LNK-06", "VER-15", "NRM-15", "CMP-19", "DEC-01"]);
  });
  it("направление между стадиями: только рост, только уменьшение, любое — на границе допуска", () => {
    expect(stageBreaks(GP({ direction: "increase" }), 1, 1.01)).toBe(false);
    expect(stageBreaks(GP({ direction: "increase" }), 1, 1.0101)).toBe(true);
    expect(stageBreaks(GP({ direction: "increase" }), 1, 0.5)).toBe(false);
    expect(stageBreaks(GP({ direction: "decrease" }), 1, 1.5)).toBe(false);
    expect(stageBreaks(GP({ direction: "decrease" }), 1, 0.9899)).toBe(true);
    expect(stageBreaks(GP({ direction: "both" }), 1, 1.0101)).toBe(true);
    expect(stageBreaks(GP({ direction: "increase", tolerance: 0, tolerance_pct: 10 }), 10, 11)).toBe(false);
    expect(stageBreaks(GP({ direction: "increase", tolerance: 0, tolerance_pct: 10 }), 10, 11.001)).toBe(true);
  });
  it("предмет параметра: сущность, вид, система, марка по регулярному выражению", () => {
    const p = GP({ element_kinds: ["door"], systems: ["В1"], mark: "^Д" });
    expect(isSubject(p, G({ kind: "door", system: "В1", key: "Д1" }))).toBe(true);
    expect(isSubject(p, G({ entity: "ENT-11", kind: "door", system: "В1", key: "Д1" }))).toBe(false);
    expect(isSubject(p, G({ kind: "window", system: "В1", key: "Д1" }))).toBe(false);
    expect(isSubject(p, G({ kind: "door", system: "В2", key: "Д1" }))).toBe(false);
    expect(isSubject(p, G({ kind: "door", system: null, key: "Д1" }))).toBe(false);
    expect(isSubject(p, G({ kind: "door", system: "В1", key: "ОК1" }))).toBe(false);
    expect(isSubject(GP({ entity: null }), G({ entity: "ENT-99", kind: null }))).toBe(true);
  });
  it("выбор стадии: устаревшая редакция и отсев ML — с причиной; сущности предиката; знаменатель доли; порядок по файлу и странице", () => {
    const p = GP({ also: ["ENT-11"], share_of: ["door", "gate"], element_kinds: ["door"] });
    const ms = [
      R("RD", { file_id: "b", page: 2, kind: "door" }), R("RD", { file_id: "a", page: 5, kind: "door" }), R("RD", { file_id: "a", page: 1, kind: "door" }),
      R("RD", { role: "SUPERSEDED", kind: "door" }), R("RD", { excluded: "X", excluded_why: null, kind: "door" }), R("RD", { excluded: "Y", excluded_why: "чужой объект", kind: "door" }),
      R("RD", { entity: "ENT-11" }), R("RD", { kind: "gate" }), R("RD", { kind: "gate", discipline: "КР" }), R("PD", { kind: "door" }),
    ];
    const pk = pickGeom(ms, "RD", p);
    expect(pk.used.map((m) => `${m.file_id}:${m.page}`)).toEqual(["a:1", "a:5", "b:2"]);
    expect(pk.dropped.map((d) => d.why)).toEqual(["устаревшая редакция", "X", "чужой объект"]);
    expect(pk.others["ENT-11"]).toHaveLength(1);
    expect(pk.total.map((m) => m.kind)).toEqual(["door", "door", "door", "gate"]);
    expect(pickGeom(ms, "ID", p)).toEqual({ used: [], others: { "ENT-11": [] }, total: [], dropped: [] });
  });
});

describe("оценщик вида geometry: скаляр — ветки статуса", () => {
  it("стадия неприменима по Матрице и не загружена — NOT_APPLICABLE в заметках; провенанс значения", () => {
    const ev = evaluateGeomParam(GP(), { PD: [len("PD", 1)], RD: [len("RD", 1)], ID: [len("ID", 1)] }, C({ param: { ...PRM, source_id: "—" }, loadedStages: ["PD", "RD"] }));
    expect(ev.stage_notes).toEqual({ PD: "USED", RD: "USED", ID: "NOT_APPLICABLE" });
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toBe("Параметр: между стадиями в пределах допуска ±0,01 м.");
    expect(ev.provenance.mentions.map((m) => [m.stage, m.use, m.value])).toEqual([
      ["PD", "chosen", "1 м"],
      ["RD", "chosen", "1 м"],
      ["ID", "chosen", "1 м"],
    ]);
    const nv = evaluateGeomParam(GP(), { RD: [R("RD", { measure: "topology" }), R("RD", { measured_value: 2, value: null, entity: "ENT-99" })] }, C());
    expect(nv.provenance.mentions.map((m) => [m.use, m.value])).toEqual([
      ["chosen", "topology"],
      ["considered", "2 м"],
    ]);
  });
  it("причины ворот словами: неприменимость, спорные редакции без повтора, нет элементов", () => {
    expect(evaluateGeomParam(GP(), { RD: [len("RD", 1)] }, C({ param: { ...PRM, applicability: "gas" }, profile: { gas: false } })).reason).toBe("Неприменим к объекту: gas");
    expect(evaluateGeomParam(GP(), { RD: [len("RD", 1)] }, C({ param: { ...PRM, applicability: "gas" }, profile: { gas: true } })).status).toBe("NEGATIVE_VERIFIED".replace("NEGATIVE_VERIFIED", evaluateGeomParam(GP(), { RD: [len("RD", 1)] }, C()).status));
    const cl = evaluateGeomParam(GP(), { PD: [len("PD", 1, { role: "UNRESOLVED" }), len("PD", 2, { role: "UNRESOLVED" })], RD: [len("RD", 1, { role: "CONFLICT", revision: "2" })] }, C());
    expect(cl.reason).toBe("Не определена актуальная редакция: 100-PD ред. 1, 100-RD ред. 2");
    const none = evaluateGeomParam(GP(), {}, C({ param: { ...PRM, source_id: null } }));
    expect(none.reason).toBe("Сравнить не с чем: элементов «Параметр» на планах стадий нет. Запросите ПД: План АР; РД: план стадии.");
    expect(none.stage_notes).toEqual({ PD: "NO_VALUE", RD: "NO_VALUE", ID: "NOT_APPLICABLE" });
  });
  it("агрегат: минимум, максимум, сумма, по элементам с ростом — максимум", () => {
    const pd = [len("PD", 3, { key: "" }), len("PD", 1, { key: "" }), len("PD", 2, { key: "" })];
    const rd = [len("RD", 3, { key: "" })];
    expect(evaluateGeomParam(GP({ aggregate: "min" }), { PD: pd, RD: rd }, C()).expected).toBe("1");
    expect(evaluateGeomParam(GP({ aggregate: "max" }), { PD: pd, RD: rd }, C()).expected).toBe("3");
    expect(evaluateGeomParam(GP({ aggregate: "sum" }), { PD: pd, RD: rd }, C()).expected).toBe("6");
    expect(evaluateGeomParam(GP({ aggregate: "each", direction: "increase" }), { PD: pd.map((m) => ({ ...m, at: null })), RD: rd.map((m) => ({ ...m, at: null })) }, C()).expected).toBe("3");
    expect(evaluateGeomParam(GP({ aggregate: "each" }), { PD: pd.map((m) => ({ ...m, at: null })), RD: rd.map((m) => ({ ...m, at: null })) }, C())).toMatchObject({ status: "CANDIDATE", expected: "1", actual: "3", delta: "+2 м (+200,0 %)" });
  });
  it("кандидат между стадиями: худшая пара, строки всех нарушений, несопоставленный ключ, допуск словами", () => {
    const ev = evaluateGeomParam(GP({ direction: "decrease" }), { PD: [len("PD", 1, { key: "Д1" }), len("PD", 2, { key: "Д2" }), len("PD", 3, { key: "Д3" })], RD: [len("RD", 0.9, { key: "Д1" }), len("RD", 1.5, { key: "Д2" })] }, C());
    expect(ev).toMatchObject({ status: "CANDIDATE", expected: "2", actual: "1,5", delta: "-0,5 м (-25,0 %)" });
    expect(ev.reason).toBe("РД (АР, стр. 2, «Д1») 0,9 м против ПД (АР, стр. 1) 1 м; РД (АР, стр. 2, «Д2») 1,5 м против ПД (АР, стр. 1) 2 м — допуск на уменьшение ±0,01 м. Без пары (LNK-06): «Д3» ПД нет в РД. Правило Матрицы: Правило.");
    expect(ev.fragments.map((f) => [f.stage, f.kind, f.value])).toEqual([
      ["PD", "expected", "2"],
      ["RD", "actual", "1,5"],
    ]);
    const up = evaluateGeomParam(GP({ direction: "increase" }), { PD: [len("PD", 1, { key: "Д1" })], RD: [len("RD", 2, { key: "Д1" })] }, C());
    expect(up.reason).toMatch(/ — допуск на рост ±0,01 м\./);
    const both = evaluateGeomParam(GP({ tolerance_pct: 50 }), { PD: [len("PD", 0, { key: "Д1" })], RD: [len("RD", 2, { key: "Д1" })] }, C());
    expect(both).toMatchObject({ delta: "+2 м (+0,0 %)" });
    expect(both.reason).toMatch(/ — допуск ±0,01 м\./);
  });
  it("норма нарушена: худшее значение для минимума и максимума, дельта со знаком, лист не в масштабе в причине", () => {
    const mn = { kind: "min" as const, value: 1, basis: "проект" };
    const ev = evaluateGeomParam(GP({ norm: mn }), { RD: [len("RD", 0.9, { key: "А" }), len("RD", 0.5, { key: "Б" }), R("RD", { key: "В", label_value: 0.95, measured_value: 1.2 })] }, C());
    expect(ev).toMatchObject({ status: "CANDIDATE", expected: "≥ 1 м (проект)", actual: "0,5", delta: "-0,5 м" });
    expect(ev.reason).toBe("Норма нарушена (CMP-06): РД (АР, стр. 1, «В») — 0,95 м; РД (АР, стр. 2, «А») — 0,9 м; РД (АР, стр. 2, «Б») — 0,5 м при норме ≥ 1 м (проект). Лист не в масштабе (CMP-12): АР, стр. 1 — надпись 0,95 против измерения 1,2 (26,3 %) — лист не в масштабе, взята надпись.");
    const mx = evaluateGeomParam(GP({ norm: { kind: "max", value: 1, basis: "проект" } }), { RD: [len("RD", 1.5, { key: "" }), len("RD", 1.2), len("RD", 0.5)] }, C());
    expect(mx).toMatchObject({ actual: "1,5", delta: "+0,5 м", expected: "≤ 1 м (проект)" });
    expect(mx.reason).toMatch(/^Норма нарушена \(CMP-06\): РД \(АР, стр\. 2\) — 1,5 м; РД/);
    expect(mx.fragments.map((f) => f.value)).toEqual(["1,5", "1,2"]);
  });
  it("норма соблюдена одной стадией — худшее значение; норма не подтверждена при паре — причина рядом с вердиктом", () => {
    const mn = { kind: "min" as const, value: 1, basis: "проект" };
    const one = evaluateGeomParam(GP({ norm: mn }), { RD: [len("RD", 1.5), len("RD", 1.1)] }, C());
    expect(one).toMatchObject({ status: "NEGATIVE_VERIFIED", actual: "1,1" });
    expect(one.reason).toBe("Норма соблюдена (CMP-06): РД (АР, стр. 2) — 1,1 м при норме ≥ 1 м (проект).");
    const mx = evaluateGeomParam(GP({ norm: { kind: "max", value: 2, basis: "п" } }), { ID: [len("ID", 1.5), len("ID", 1.9)] }, C());
    expect(mx.actual).toBe("1,9");
    const nv = evaluateGeomParam(GP({ norm: { kind: "min", value: null, basis: "ГПЗУ" } }), { PD: [len("PD", 1)], RD: [len("RD", 1)] }, C());
    expect(nv.reason).toBe("Параметр: между стадиями в пределах допуска ±0,01 м. Сравнение с нормой не выполнено: предел нормы не задан (ГПЗУ).");
    const ok = evaluateGeomParam(GP({ norm: mn }), { PD: [len("PD", 1.5)], RD: [len("RD", 1.5)] }, C());
    expect(ok.reason).toBe("Параметр: между стадиями в пределах допуска ±0,01 м. Норма соблюдена (CMP-06): ≥ 1 м (проект).");
    const only = evaluateGeomParam(GP({ norm: { kind: "min", value: null, basis: "ГПЗУ" } }), { RD: [len("RD", 1)] }, C());
    expect(only.reason).toBe("Сравнить можно только с нормой, а предел нормы не задан (ГПЗУ).");
    const pdOnly = evaluateGeomParam(GP({ norm: mn }), { PD: [len("PD", 0.5)] }, C());
    expect(pdOnly.status).toBe("CANDIDATE");
    const pdOk = evaluateGeomParam(GP({ norm: mn }), { PD: [len("PD", 1.5), len("PD", 1.2)] }, C());
    expect(pdOk).toMatchObject({ status: "MISSING_EVIDENCE", expected: "1,2" });
    expect(pdOk.reason).toBe("Сравнить не с чем: ПД — 1,2 м (АР, стр. 1); значения других стадий на планах нет.");
    expect(pdOk.fragments.map((f) => [f.kind, f.value])).toEqual([["expected", "1,2"]]);
  });
  it("площадь: несопоставимая единица контура — значения нет с причиной; флаг контроля экспликации в провенансе; счёт без числа — один знак", () => {
    const sq = [[0, 0], [2000, 0], [2000, 2000], [0, 2000]] as Pt[];
    const bad = evaluateGeomParam(GP({ measure: "area", unit: "м²", entity: "ENT-01" }), { RD: [R("RD", { entity: "ENT-01", polygon: sq, unit: "шт" })] }, C());
    expect(bad).toMatchObject({ status: "NOT_COMPARABLE", reason: "Значение по плану не определено: РД (АР, стр. 1): единицы несопоставимы: мм² → шт" });
    const ctl = evaluateGeomParam(GP({ measure: "area", unit: "м²", entity: "ENT-01" }), { PD: [R("PD", { entity: "ENT-01", polygon: sq, label_value: 4, unit: "м²" })], RD: [R("RD", { entity: "ENT-01", polygon: sq, label_value: 3.5, unit: "м²" })] }, C());
    expect(ctl.provenance.measurements.map((m) => [m.stage, m.value, m.by, m.control_flag, m.note])).toEqual([
      ["PD", 4, "both", false, null],
      ["RD", 3.5, "both", true, "площадь по контуру 4 расходится с экспликацией на 14,3 % — геометрия контрольная"],
    ]);
    const cnt = evaluateGeomParam(GP({ measure: "count", unit: "шт", entity: "ENT-08", aggregate: "sum", tolerance: 0 }), { PD: [R("PD", { entity: "ENT-08", at: [0, 0] }), R("PD", { entity: "ENT-08", value: 3 })], RD: [R("RD", { entity: "ENT-08", at: null, value: null })] }, C());
    expect(cnt).toMatchObject({ status: "MISSING_EVIDENCE", expected: "4" });
    expect(cnt.provenance.measurements.map((m) => [m.stage, m.value, m.note])).toEqual([
      ["PD", 1, null],
      ["PD", 3, null],
      ["RD", null, "счёт не определён"],
    ]);
    expect(cnt.provenance.mentions.map((m) => m.value)).toEqual(["length", "3 м", "length"]); // значения нет — вид измерения упоминания
  });
  it("доля: общего числа нет — причина; знак без счёта в знаменателе — один; стадия без элементов доли пропускается", () => {
    const p = GP({ measure: "count", unit: "%", entity: "ENT-21", element_kinds: ["mgn"], share_of: ["car", "mgn"], aggregate: "sum", norm: { kind: "min", value: 10, basis: "СП" } });
    const n0 = evaluateGeomParam(p, { RD: [R("RD", { entity: "ENT-21", kind: "mgn", value: 1 })] }, C({ param: { ...PRM, source_pd: null } }));
    expect(n0.status).toBe("NEGATIVE_VERIFIED");
    const den0 = evaluateGeomParam(GP({ ...p, share_of: ["car"] }), { RD: [R("RD", { entity: "ENT-21", kind: "mgn", value: 1 })] }, C());
    expect(den0).toMatchObject({ status: "NOT_COMPARABLE", reason: "Значение по плану не определено: РД: общего числа элементов для доли нет" });
    const pts = evaluateGeomParam(p, { RD: [R("RD", { entity: "ENT-21", kind: "mgn", at: [0, 0] }), ...Array.from({ length: 11 }, (_, i) => R("RD", { entity: "ENT-21", kind: "car", at: [i, 0] }))] }, C());
    expect(pts).toMatchObject({ status: "CANDIDATE", actual: "8,333" });
    const mix = evaluateGeomParam(p, { PD: [R("PD", { entity: "ENT-21", kind: "car", value: 5 })], RD: [R("RD", { entity: "ENT-21", kind: "mgn", value: 1 }), R("RD", { entity: "ENT-21", kind: "car", value: 4 })] }, C());
    expect(mix).toMatchObject({ status: "NEGATIVE_VERIFIED", actual: "20" });
  });
  it("предикат при скаляре: отказ предиката не ломает сравнение; нарушение без расхождения стадий — кандидат с фрагментом", () => {
    const room = R("RD", { entity: "ENT-01", polygon: [[0, 0], [10000, 0], [10000, 10000], [0, 10000]] });
    const p = GP({ measure: "count", unit: "шт", entity: "ENT-08", aggregate: "sum", tolerance: 0, also: ["ENT-01"], predicate: { kind: "covers", of: "ENT-01", radius_mm: 1000, step_mm: 1000 } });
    const det = (s: Stage) => R(s, { entity: "ENT-08", key: "ИП", at: [5000, 5000] });
    const ev = evaluateGeomParam(p, { PD: [det("PD")], RD: [det("RD"), room] }, C());
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toBe("Нарушены отношения (CMP-16): РД: точка контура ENT-01 вне радиуса 1000 мм.");
    expect(ev.fragments).toEqual([]);
    const sp = GP({ ...p, predicate: { kind: "max_spacing", max_mm: 100 } });
    const two = (s: Stage) => [R(s, { entity: "ENT-08", key: "И1", at: [0, 0] }), R(s, { entity: "ENT-08", key: "И2", at: [500, 0] })];
    const e2 = evaluateGeomParam(sp, { PD: two("PD"), RD: two("RD") }, C());
    expect(e2.reason).toBe("Нарушены отношения (CMP-16): ПД (АР, стр. 1): до ближайшего 500 мм — больше шага 100 мм; ПД (АР, стр. 1): до ближайшего 500 мм — больше шага 100 мм; РД (АР, стр. 1): до ближайшего 500 мм — больше шага 100 мм; РД (АР, стр. 1): до ближайшего 500 мм — больше шага 100 мм.");
    expect(e2.fragments.map((f) => [f.stage, f.value])).toEqual([
      ["PD", "до ближайшего 500 мм — больше шага 100 мм"],
      ["PD", "до ближайшего 500 мм — больше шага 100 мм"],
      ["RD", "до ближайшего 500 мм — больше шага 100 мм"],
      ["RD", "до ближайшего 500 мм — больше шага 100 мм"],
    ]);
    const skip = evaluateGeomParam(GP({ ...p, predicate: { kind: "inside", of: "ENT-01" } }), { PD: [det("PD")], RD: [det("RD")] }, C());
    expect(skip).toMatchObject({ status: "NEGATIVE_VERIFIED" });
    const cand = evaluateGeomParam(sp, { PD: [...two("PD"), R("PD", { entity: "ENT-08", at: [9, 9] })], RD: two("RD") }, C());
    expect(cand.reason).toMatch(/^РД \(АР, стр\. 1\) 2 шт против ПД \(АР, стр\. 1\) 3 шт — допуск ±0 шт\. Нарушены отношения \(CMP-16\): ПД/);
  });
  it("без пар по ключу — сравнение сводных значений; LNK-06 с элементами без ключа", () => {
    const ev = evaluateGeomParam(GP(), { PD: [len("PD", 2, { key: "А", at: [0, 0] })], RD: [len("RD", 1, { key: "Б", at: [5000, 0] })] }, C());
    expect(ev).toMatchObject({ status: "CANDIDATE", expected: "2", actual: "1" });
    expect(ev.reason).toMatch(/Без пары \(LNK-06\): «А» ПД нет в РД\./);
    const pos = evaluateGeomParam(GP(), { PD: [len("PD", 2, { key: "", at: [0, 0] }), len("PD", 5, { key: "", at: [9000, 0] })], RD: [len("RD", 2, { key: "", at: [10, 0] }), len("RD", 5, { key: "", at: [9010, 0] })] }, C());
    expect(pos).toMatchObject({ status: "NEGATIVE_VERIFIED", expected: "5", actual: "5" });
    expect(pos.reason).not.toMatch(/Без пары/);
  });
});

describe("оценщик вида geometry: положение, контур, отношения, топология — ветки", () => {
  const lift = (s: Stage, at: Pt | null, over: Partial<GeomRef> = {}) => R(s, { entity: "ENT-12", key: "Л1", at, residual_mm: 5, page: s === "PD" ? 1 : 4, ...over });
  const pos = GP({ measure: "position", unit: "мм", entity: "ENT-12", tolerance: 50 });
  it("CMP-14: одна стадия, без пар, все пары не сравнимы, смещение в допуске, элемент ПД без пары — кандидат", () => {
    expect(evaluateGeomParam(pos, { PD: [lift("PD", [0, 0])] }, C()).reason).toBe("Сравнить не с чем: элементы есть только в ПД.");
    const np = evaluateGeomParam(pos, { PD: [lift("PD", [0, 0], { key: "" })], RD: [lift("RD", [99999, 0], { key: "" })] }, C());
    expect(np).toMatchObject({ status: "NOT_COMPARABLE", reason: "Положения и контуры не сравнимы: пар элементов по ключу и положению нет (LNK-06)." });
    const nc = evaluateGeomParam(pos, { PD: [lift("PD", [0, 0])], RD: [lift("RD", [0, 0], { residual_mm: 99 }), lift("RD", [0, 0], { residual_mm: 99, key: "Л2" })] }, C());
    expect(nc.reason).toBe("Положения и контуры не сравнимы: остаток регистрации листа стр. 4 99 мм больше допуска 50 мм.");
    const ok = evaluateGeomParam(pos, { PD: [lift("PD", [0, 0]), lift("PD", [0, 0], { key: "Л3", residual_mm: null })], RD: [lift("RD", [30, 40]), lift("RD", [0, 0], { key: "Л3" })] }, C());
    expect(ok).toMatchObject({ status: "NEGATIVE_VERIFIED", reason: "Параметр: смещений больше 50 мм нет (пар — 1). Не сравнено: остаток регистрации листа стр. 1 неизвестен больше допуска 50 мм." });
    expect(ok.provenance.measurements).toEqual([{ stage: "RD", key: "Л1", measure: "position", value: 50, unit: "мм", by: "geometry", page: 4, file_id: "fRD", at: [30, 40], shift_mm: 50 }]);
    const lost = evaluateGeomParam(pos, { PD: [lift("PD", [0, 0]), lift("PD", [0, 0], { key: "Л9" })], RD: [lift("RD", [0, 0])] }, C());
    expect(lost).toMatchObject({ status: "CANDIDATE", reason: "Смещение положения (CMP-14): «Л9» ПД (АР, стр. 1) нет в РД. Правило Матрицы: Правило." });
    const mv = evaluateGeomParam(pos, { PD: [lift("PD", [1000.4, 2000.6])], RD: [lift("RD", [1100, 2000]), lift("RD", [0, 0], { key: "Л5", residual_mm: 99 })] }, C());
    expect(mv.reason).toBe("Смещение положения (CMP-14): «Л1» РД (АР, стр. 4) смещён на 100 мм относительно ПД (АР, стр. 1), допуск 50 мм. Правило Матрицы: Правило.");
    expect(mv.fragments.map((f) => [f.kind, f.value])).toEqual([
      ["expected", "Л1: 1000; 2001"],
      ["actual", "Л1: 1100; 2000"],
    ]);
  });
  it("CMP-15: кандидат с неcравнимой парой, обе причины во фрагментах, контуры совпали с отказом", () => {
    const sq = (x: number): Pt[] => [[x, 0], [x + 1000, 0], [x + 1000, 1000], [x, 1000]];
    const room = (s: Stage, key: string, x: number, label: number | null, over: Partial<GeomRef> = {}) => R(s, { entity: "ENT-01", key, polygon: sq(x), label_value: label, page: s === "PD" ? 1 : 2, ...over });
    const shp = GP({ measure: "shape", unit: "м²", entity: "ENT-01", tolerance: 0.05 });
    const ev = evaluateGeomParam(shp, { PD: [room("PD", "1", 0, 1), room("PD", "2", 0, 1), room("PD", "3", 0, 1)], RD: [room("RD", "1", 500, 1), room("RD", "2", 0, 0.8), room("RD", "3", 0, 1, { frame: "sheet" })] }, C());
    expect(ev.reason).toBe("Изменение контура (CMP-15): контур «1» РД (АР, стр. 2) изменился: IoU 0,333, Хаусдорф 500 мм (порог IoU 0,95, Хаусдорф 300 мм); контур «2» не изменился (IoU 1, Хаусдорф 0 мм), а площадь по экспликации ПД 1 м² → РД 0,8 м²: изменена методика подсчёта, а не геометрия. Не сравнено: контур не переведён в оси здания — нужна регистрация листов (LNK-03). Правило Матрицы: Правило.");
    expect(ev.fragments.map((f) => [f.kind, f.value])).toEqual([
      ["expected", "1: контур"],
      ["actual", "1: IoU 0,333, Хаусдорф 500 мм"],
      ["expected", "1 м²"],
      ["actual", "0,8 м²"],
    ]);
    expect(ev.provenance.measurements.map((m) => [m.key, m.unit, m.polygon?.length])).toEqual([
      ["1", "IoU", 4],
      ["2", "IoU", 4],
    ]);
    const same = evaluateGeomParam(shp, { PD: [room("PD", "1", 0, 1), room("PD", "3", 0, 1)], RD: [room("RD", "1", 0, 1), room("RD", "3", 0, 1, { polygon: [[0, 0], [1, 1]] })] }, C());
    expect(same).toMatchObject({ status: "NEGATIVE_VERIFIED", reason: "Параметр: контуры совпали (пар — 1). Не сравнено: контур «3» (стр. 2): в контуре меньше трёх точек (2)." });
  });
  it("CMP-16 параметром: нет предиката — громкий отказ; все стадии не проверены; часть стадий не проверена; фрагменты нарушений", () => {
    const rel = GP({ measure: "relation", unit: "шт", entity: "ENT-09", also: ["ENT-11", "ENT-08"] });
    expect(() => evaluateGeomParam(rel, { RD: [R("RD", { entity: "ENT-09", at: [0, 0] })] }, C())).toThrow("паспорт: у отношения (measure = relation) нет предиката");
    const pr = GP({ ...rel, predicate: { kind: "near_crossing", barrier: "ENT-11", device: "ENT-08", radius_mm: 100 } });
    const duct = (s: Stage) => R(s, { entity: "ENT-09", key: "В1", polygon: [[0, 0], [3000, 0]] });
    const wall = (s: Stage) => R(s, { entity: "ENT-11", polygon: [[1000, -10], [1000, 10]] });
    expect(evaluateGeomParam(pr, { PD: [duct("PD")], RD: [duct("RD")] }, C())).toMatchObject({ status: "NOT_COMPARABLE", reason: "Отношения не проверены: ПД: на листе нет элементов ENT-11 для предиката; РД: на листе нет элементов ENT-11 для предиката." });
    const part = evaluateGeomParam(pr, { PD: [duct("PD")], RD: [duct("RD"), wall("RD"), R("RD", { entity: "ENT-08", at: [1000, 50] })] }, C());
    expect(part).toMatchObject({ status: "NEGATIVE_VERIFIED", reason: "Отношения соблюдены (CMP-16) в РД. Не проверено: ПД: на листе нет элементов ENT-11 для предиката." });
    const all = evaluateGeomParam(pr, { RD: [duct("RD"), wall("RD"), R("RD", { entity: "ENT-08", at: [1000, 50] })] }, C());
    expect(all.reason).toBe("Отношения соблюдены (CMP-16) в РД.");
    const bad = evaluateGeomParam(pr, { RD: [duct("RD"), wall("RD")] }, C());
    expect(bad).toMatchObject({ status: "CANDIDATE", reason: "Нарушены отношения (CMP-16): РД (АР, стр. 1): пересечение трассы «В1» с преградой без ENT-08 в радиусе 100 мм." });
    expect(bad.fragments.map((f) => [f.kind, f.value])).toEqual([["actual", "пересечение трассы «В1» с преградой без ENT-08 в радиусе 100 мм"]]);
  });
  it("CMP-19: система на двух листах сшивается по марке; ключ — система; кандидат со всеми видами отличий; нет систем; одна стадия", () => {
    const g = (nodes: Array<[string, string, string | null]>, edges: Array<[string, string]>) => ({ nodes: nodes.map(([id, kind, mark]) => ({ id, kind, mark })), edges });
    const top = GP({ measure: "topology", unit: "шт", entity: "ENT-09" });
    const pd = [R("PD", { entity: "ENT-09", key: "", system: "П", graph: g([["a", "unit", "П1"], ["b", "riser", "Т1"]], [["a", "b"]]) }), R("PD", { entity: "ENT-09", key: "", system: "П", page: 2, graph: g([["c", "riser", " Т1 "], ["d", "unit", "П2"]], [["c", "d"]]) })];
    const rd = [R("RD", { entity: "ENT-09", key: "П", graph: g([["x", "unit", "П1"], ["y", "riser", "Т1"], ["z", "unit", "П2"]], [["x", "y"], ["y", "z"]]) })];
    expect(evaluateGeomParam(top, { PD: pd, RD: rd }, C())).toMatchObject({ status: "NEGATIVE_VERIFIED", reason: "Состав узлов и подключения совпали (CMP-19), систем — 1." });
    const rd2 = [R("RD", { entity: "ENT-09", key: "П", graph: g([["x", "unit", "П1"], ["y", "riser", "Т1"], ["w", "unit", "П7"], ["v", "unit", "П8"]], [["x", "w"], ["y", "v"]]) })];
    const ev = evaluateGeomParam(top, { PD: pd, RD: rd2 }, C());
    expect(ev.reason).toBe("Топология сети изменилась (CMP-19): «П» РД (АР, стр. 1): переименованы П2 → П8; нет подключений П1–Т1; добавлены П7 (правка 5, уровень — riser, unit).");
    expect(ev.fragments.map((f) => [f.kind, f.value])).toEqual([
      ["expected", "П1, П2, Т1"],
      ["actual", "П1, П7, П8, Т1"],
    ]);
    expect(ev.provenance.measurements).toEqual([{ stage: "RD", key: "П", measure: "topology", value: 5, unit: "стоимость правки", by: "geometry", page: 1, file_id: "fRD", note: "уровень: riser, unit" }]);
    const gone = evaluateGeomParam(top, { PD: [...pd, R("PD", { entity: "ENT-09", key: "К", graph: g([["k", "unit", "К1"]], []) }), R("PD", { entity: "ENT-09", key: "Н" })], RD: rd }, C());
    expect(gone.reason).toBe("Топология сети изменилась (CMP-19): система «К» ПД (АР, стр. 1) нет в РД.");
    expect(gone.fragments.map((f) => [f.kind, f.value])).toEqual([["expected", "К"]]);
    const skip = evaluateGeomParam(top, { PD: [R("PD", { entity: "ENT-09", key: "П", graph: g([["a", "bend", null]], []) }), R("PD", { entity: "ENT-09", key: "Р", graph: g([["a", "u", "Р1"]], [["a", "q"]]) })], RD: [R("RD", { entity: "ENT-09", key: "П", graph: g([["a", "u", "П1"]], []) }), R("RD", { entity: "ENT-09", key: "Р", graph: g([["a", "u", "Р1"]], []) })] }, C());
    expect(skip).toMatchObject({ status: "NOT_COMPARABLE", reason: "Схемы сети не сравнимы: «П»: в схеме нет узлов с маркой; «Р»: граф эталона: ребро fPD:1:a–fPD:1:q ведёт к несуществующему узлу." });
    const none = evaluateGeomParam(top, { PD: [R("PD", { entity: "ENT-09", key: "П" })], RD: [R("RD", { entity: "ENT-09", key: "П" })] }, C());
    expect(none.reason).toBe("Схемы сети не сравнимы: подграфов систем нет.");
    expect(evaluateGeomParam(top, { PD: pd }, C()).reason).toBe("Сравнить не с чем: схема сети есть только в ПД.");
    const partial = evaluateGeomParam(top, { PD: [...pd, R("PD", { entity: "ENT-09", key: "Х", graph: g([["h", "b", null]], []) })], RD: [...rd, R("RD", { entity: "ENT-09", key: "Х", graph: g([["h", "u", "Х1"]], []) })] }, C());
    expect(partial.reason).toBe("Состав узлов и подключения совпали (CMP-19), систем — 1. Не сравнено: «Х»: в схеме нет узлов с маркой.");
  });
});
