// Эшелоны: L1 (площадь, пересечение, IoU, Хаусдорф, расстояния), L2 (независимый пересчёт: площадь — суммой
// треугольников разбиения, IoU — подсчётом точек сетки), L3 (границы: касание, точка на ребре), L5 (fast-check:
// инвариантность к повороту и сдвигу), L6 (вырожденные полигоны — громкий отказ). T-193, ADR-0010. Геометрия синтетическая.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyFrame,
  distance,
  hausdorff,
  intersectionArea,
  iou,
  pointInPolygon,
  polygonArea,
  polylineCrossings,
  segmentDistance,
  signedArea,
  triangulate,
  validPolygon,
  type Pt,
} from "../src/domain/geom-core.ts";

const SQ: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const L_SHAPE: Pt[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]; // невыпуклый, площадь 300

const rot = (p: Pt, a: number, [dx, dy]: Pt = [0, 0]): Pt => [p[0] * Math.cos(a) - p[1] * Math.sin(a) + dx, p[0] * Math.sin(a) + p[1] * Math.cos(a) + dy];

/** Независимый пересчёт площади пересечения (L2): доля узлов мелкой сетки, попавших в оба полигона. */
function gridInter(a: Pt[], b: Pt[], step = 0.25): number {
  const xs = [...a, ...b].map((p) => p[0]);
  const ys = [...a, ...b].map((p) => p[1]);
  let n = 0;
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) if (pointInPolygon([x, y], a) && pointInPolygon([x, y], b)) n++;
  return n * step * step;
}

describe("geom-core: площадь (CMP-13)", () => {
  it("площадь квадрата и невыпуклого контура — формула шнурования", () => {
    expect(polygonArea(SQ)).toBe(100);
    expect(polygonArea(L_SHAPE)).toBe(300);
  });
  it("обход по и против часовой — одна площадь, знак ориентированной площади разный", () => {
    expect(polygonArea([...SQ].reverse())).toBe(100);
    expect(signedArea(SQ)).toBe(100);
    expect(signedArea([...SQ].reverse())).toBe(-100);
  });
  it("L2: площадь суммой треугольников разбиения совпадает с формулой шнурования", () => {
    for (const poly of [SQ, L_SHAPE, [...L_SHAPE].reverse()]) {
      const tri = triangulate(poly);
      expect(tri.length).toBe(poly.length - 2);
      const sum = tri.reduce((s, t) => s + polygonArea(t), 0);
      expect(sum).toBeCloseTo(polygonArea(poly), 9);
    }
  });
  it("замыкающая точка, равная первой, не меняет площадь", () => {
    expect(polygonArea([...SQ, [0, 0]])).toBe(100);
  });
});

describe("geom-core: пересечение и IoU (CMP-15)", () => {
  it("пересечение сдвинутых квадратов и IoU", () => {
    const b: Pt[] = SQ.map(([x, y]) => [x + 5, y]);
    expect(intersectionArea(SQ, b)).toBeCloseTo(50, 9);
    expect(iou(SQ, b)).toBeCloseTo(50 / 150, 9);
  });
  it("один и тот же контур — IoU = 1; непересекающиеся — 0", () => {
    expect(iou(L_SHAPE, L_SHAPE)).toBeCloseTo(1, 9);
    expect(iou(SQ, SQ.map(([x, y]) => [x + 30, y] as Pt))).toBe(0);
  });
  it("L2: пересечение невыпуклых контуров — совпадает с подсчётом точек сетки", () => {
    const b: Pt[] = [[5, 5], [25, 5], [25, 15], [5, 15]];
    expect(intersectionArea(L_SHAPE, b)).toBeCloseTo(gridInter(L_SHAPE, b), 1);
    expect(intersectionArea(L_SHAPE, b)).toBeCloseTo(100, 9); // 15×5 по нижней полке + 5×5 по стойке
  });
  it("L3: касание по ребру — пересечение нулевой площади", () => {
    expect(intersectionArea(SQ, SQ.map(([x, y]) => [x + 10, y] as Pt))).toBeCloseTo(0, 9);
  });
});

describe("geom-core: Хаусдорф и расстояния (CMP-15, CMP-16)", () => {
  it("Хаусдорф одинаковых контуров — 0, сдвиг на d — d", () => {
    expect(hausdorff(SQ, SQ)).toBeCloseTo(0, 9);
    expect(hausdorff(SQ, SQ.map(([x, y]) => [x + 3, y] as Pt))).toBeCloseTo(3, 6);
  });
  it("Хаусдорф ловит выступ посреди ребра, а не только в вершинах", () => {
    const bump: Pt[] = [[0, 0], [4, 0], [5, -4], [6, 0], [10, 0], [10, 10], [0, 10]];
    expect(hausdorff(SQ, bump)).toBeCloseTo(4, 6);
  });
  it("расстояние от точки до отрезка — перпендикуляр или ближайший конец", () => {
    expect(segmentDistance([5, 3], [0, 0], [10, 0])).toBe(3);
    expect(segmentDistance([13, 4], [0, 0], [10, 0])).toBe(5);
  });
  it("расстояние между полигонами: 0 при пересечении и вложении, иначе зазор", () => {
    expect(distance(SQ, SQ.map(([x, y]) => [x + 5, y] as Pt))).toBe(0);
    expect(distance(SQ, [[2, 2], [3, 2], [3, 3]])).toBe(0);
    expect(distance(SQ, SQ.map(([x, y]) => [x + 12, y] as Pt))).toBe(2);
  });
  it("точка внутри, снаружи и на границе (граница — внутри)", () => {
    expect(pointInPolygon([5, 5], SQ)).toBe(true);
    expect(pointInPolygon([15, 5], SQ)).toBe(false);
    expect(pointInPolygon([10, 5], SQ)).toBe(true);
    expect(pointInPolygon([15, 15], L_SHAPE)).toBe(false);
  });
  it("пересечения ломаной с отрезками — точки пересечения", () => {
    const xs = polylineCrossings([[0, 5], [20, 5]], [[[10, 0], [10, 10]], [[15, 0], [15, 3]]]);
    expect(xs).toEqual([{ at: [10, 5], seg: 0 }]);
  });
  it("перевод в оси здания аффинной матрицей [a,b,c,d,e,f] в порядке PDF: x' = a·x + c·y + e, y' = b·x + d·y + f", () => {
    expect(applyFrame([1, 2], [2, 0, 0, 2, 100, 200])).toEqual([102, 204]);
    // поворот на 90° против часовой: (1, 0) → (0, 1); матрица PDF [cos, sin, −sin, cos, e, f]
    expect(applyFrame([1, 0], [0, 1, -1, 0, 0, 0])).toEqual([0, 1]);
    expect(applyFrame([1, 2], [1, 3, 5, 7, 0, 0])).toEqual([1 + 10, 3 + 14]);
  });
});

describe("geom-core: вырожденные данные — громкий отказ (L6)", () => {
  it("меньше трёх точек, NaN, нулевая площадь, самопересечение — причина словами", () => {
    expect(validPolygon([[0, 0], [1, 1]])).toMatch(/меньше трёх/);
    expect(validPolygon([[0, 0], [1, NaN], [2, 2]])).toMatch(/не число/);
    expect(validPolygon([[0, 0], [1, 1], [2, 2]])).toMatch(/нулевой площади/);
    expect(validPolygon([[0, 0], [10, 10], [10, 0], [0, 10]])).toMatch(/самопересека/);
    expect(validPolygon(SQ)).toBeNull();
  });
  it("операции над вырожденным полигоном бросают ошибку, а не возвращают 0", () => {
    expect(() => polygonArea([[0, 0], [1, 1]])).toThrow(/полигон/);
    expect(() => iou(SQ, [[0, 0], [1, 1], [2, 2]])).toThrow(/полигон/);
    expect(() => hausdorff([], SQ)).toThrow(/пуст/);
  });
});

describe("geom-core: инвариантность к повороту и сдвигу (L5)", () => {
  const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
  const shift = fc.tuple(fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true }));
  it("площадь, IoU и Хаусдорф не меняются при повороте и сдвиге обоих контуров", () => {
    fc.assert(
      fc.property(angle, shift, fc.double({ min: 0, max: 15, noNaN: true }), (a, d, dx) => {
        const b: Pt[] = L_SHAPE.map(([x, y]) => [x + dx, y + 2]);
        const ra = L_SHAPE.map((p) => rot(p, a, d as Pt));
        const rb = b.map((p) => rot(p, a, d as Pt));
        expect(polygonArea(ra)).toBeCloseTo(300, 4);
        expect(iou(ra, rb)).toBeCloseTo(iou(L_SHAPE, b), 6);
        expect(hausdorff(ra, rb)).toBeCloseTo(hausdorff(L_SHAPE, b), 3);
      }),
      { numRuns: 60 },
    );
  });
  it("IoU симметричен и лежит в [0, 1]", () => {
    fc.assert(
      fc.property(fc.double({ min: -30, max: 30, noNaN: true }), fc.double({ min: -30, max: 30, noNaN: true }), (dx, dy) => {
        const b: Pt[] = L_SHAPE.map(([x, y]) => [x + dx, y + dy]);
        const v = iou(L_SHAPE, b);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        expect(v).toBeCloseTo(iou(b, L_SHAPE), 9);
      }),
      { numRuns: 80 },
    );
  });
});
