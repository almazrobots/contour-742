// NFR-PERF-RUNTIME (T-138): пределы §11 под наблюдением — гистограмма Prometheus для времени ML-анализа параметра,
// CV-анализа листа и доставки протокола в «РиН». Алерт считает p95 через histogram_quantile по корзинам.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Histogram } from "../src/domain/histogram.ts";

describe("гистограмма Prometheus (NFR-PERF-RUNTIME)", () => {
  it("корзины накопительные: значение на границе попадает в свою корзину (le — «меньше или равно»)", () => {
    const h = new Histogram("x_seconds", "время", [0.5, 1, 30]);
    for (const v of [0.1, 0.5, 0.7, 30, 31]) h.observe(v);
    expect(h.lines()).toEqual([
      "# HELP x_seconds время",
      "# TYPE x_seconds histogram",
      'x_seconds_bucket{le="0.5"} 2',
      'x_seconds_bucket{le="1"} 3',
      'x_seconds_bucket{le="30"} 4',
      'x_seconds_bucket{le="+Inf"} 5',
      "x_seconds_sum 62.3",
      "x_seconds_count 5",
    ]);
  });

  it("пустая гистограмма отдаёт нули, а не пропуск рядов (алерт не теряет ряд)", () => {
    const h = new Histogram("y_seconds", "время", [1]);
    expect(h.lines().slice(2)).toEqual(['y_seconds_bucket{le="1"} 0', 'y_seconds_bucket{le="+Inf"} 0', "y_seconds_sum 0", "y_seconds_count 0"]);
  });

  it("отрицательное, NaN и бесконечность не наблюдаются: сломанный замер не портит сумму", () => {
    const h = new Histogram("z_seconds", "время", [1]);
    h.observe(-1);
    h.observe(Number.NaN);
    h.observe(Number.POSITIVE_INFINITY);
    h.observe(0);
    expect(h.count).toBe(1);
    expect(h.lines()).toContain("z_seconds_sum 0");
  });

  it("границы корзин обязаны возрастать и быть конечными — иначе ошибка при создании", () => {
    expect(() => new Histogram("a", "a", [1, 1])).toThrow(/возраст/);
    expect(() => new Histogram("a", "a", [2, 1])).toThrow(/возраст/);
    expect(() => new Histogram("a", "a", [])).toThrow(/хотя бы одна/);
    expect(() => new Histogram("a", "a", [1, Number.POSITIVE_INFINITY])).toThrow(/конечн/);
  });

  it("доля наблюдений выше предела — для отчёта и проверки на стенде", () => {
    const h = new Histogram("r_seconds", "время", [0.5, 1]);
    for (const v of [0.1, 0.2, 0.6, 2]) h.observe(v);
    expect(h.overShare(0.5)).toBe(0.5);
    expect(h.overShare(1)).toBe(0.25);
    expect(new Histogram("e", "e", [1]).overShare(1)).toBe(0);
    expect(() => h.overShare(0.7)).toThrow(/границ/);
  });

  it("L5 · при любом наборе значений корзины не убывают, +Inf = count, сумма — сумма наблюдений (fast-check)", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { maxLength: 200 }), (xs) => {
        const h = new Histogram("p_seconds", "p", [0.1, 1, 10, 100]);
        xs.forEach((x) => h.observe(x));
        const counts = h.lines().filter((l) => l.includes("_bucket")).map((l) => Number(l.split(" ").pop()));
        for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        expect(counts.at(-1)).toBe(xs.length);
        expect(h.sum).toBeCloseTo(xs.reduce((a, b) => a + b, 0), 6);
      }),
    );
  });
});
