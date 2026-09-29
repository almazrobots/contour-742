// NFR-SLA (ТЗ 11-12, TZA-11-12): доступность 99,9 % круглосуточно — бюджет ошибок, скорость сгорания, остаток, вердикт
// отчёта и готовность /ready. Эшелоны: L1 (формулы), L3 (границы: total = 0, ровно на цели, перерасход).
// Единый источник чисел — domain/slo.ts: правила Prometheus (deploy/gpu/rules/slo.yml) сверяет с ним scripts/slo.test.mjs.
import { describe, expect, it } from "vitest";
import {
  availability,
  budgetRemaining,
  budgetSpent,
  BURN_ALERTS,
  burnRate,
  errorBudget,
  readiness,
  READY_TIMEOUT_MS,
  SLO_TARGET,
  SLO_WINDOW_SECONDS,
  verdict,
} from "../src/domain/slo.ts";

describe("NFR-SLA: бюджет ошибок 99,9 % за 30 дней", () => {
  it("цель 99,9 %, окно 30 дней: бюджет 2592 с ≈ 43,2 мин", () => {
    expect(SLO_TARGET).toBe(0.999);
    expect(SLO_WINDOW_SECONDS).toBe(30 * 24 * 3600);
    expect(errorBudget(SLO_TARGET, SLO_WINDOW_SECONDS)).toBeCloseTo(2592, 6);
    expect(errorBudget(SLO_TARGET, SLO_WINDOW_SECONDS) / 60).toBeCloseTo(43.2, 6);
    expect(errorBudget(0.99, 3600)).toBeCloseTo(36, 6);
  });
  it("цель вне (0; 1) и отрицательное окно — ошибка, а не молчаливый бюджет", () => {
    for (const t of [0, 1, -0.5, 1.5, Number.NaN]) expect(() => errorBudget(t, 3600)).toThrow(RangeError);
    expect(() => errorBudget(0.999, -1)).toThrow(RangeError);
  });
});

describe("NFR-SLA: скорость сгорания бюджета", () => {
  it("доля ошибок, равная бюджету, — скорость 1; ×14,4 — доля 1,44 %; без ошибок — 0", () => {
    expect(burnRate(0.001, 0.999)).toBeCloseTo(1, 9);
    expect(burnRate(0.0144, 0.999)).toBeCloseTo(14.4, 9);
    expect(burnRate(0, 0.999)).toBe(0);
    expect(burnRate(1, 0.999)).toBeCloseTo(1000, 6);
  });
  it("доля ошибок вне [0; 1] — ошибка", () => {
    expect(() => burnRate(-0.1, 0.999)).toThrow(RangeError);
    expect(() => burnRate(1.1, 0.999)).toThrow(RangeError);
  });
  it("быстрый алерт ×14,4 за 1 ч и 5 мин — page; медленный ×6 за 6 ч и 30 мин — ticket (SRE Workbook)", () => {
    expect(BURN_ALERTS).toEqual([
      { alert: "InspectorSloBurnFast", severity: "page", factor: 14.4, long: "1h", short: "5m", for: "2m" },
      { alert: "InspectorSloBurnSlow", severity: "ticket", factor: 6, long: "6h", short: "30m", for: "15m" },
    ]);
  });
  it("быстрый алерт срабатывает, когда за час сожжено 2 % месячного бюджета; медленный — 5 % за 6 ч", () => {
    expect(budgetSpent(14.4, 3600, SLO_WINDOW_SECONDS)).toBeCloseTo(0.02, 9);
    expect(budgetSpent(6, 6 * 3600, SLO_WINDOW_SECONDS)).toBeCloseTo(0.05, 9);
  });
});

describe("NFR-SLA: доступность и остаток бюджета", () => {
  it("доступность — доля успешных; нет измерений — null, а не 100 %", () => {
    expect(availability(999, 1000)).toBeCloseTo(0.999, 12);
    expect(availability(0, 10)).toBe(0);
    expect(availability(0, 0)).toBeNull();
  });
  it("успешных больше, чем всего, или отрицательные — ошибка", () => {
    expect(() => availability(11, 10)).toThrow(RangeError);
    expect(() => availability(-1, 10)).toThrow(RangeError);
  });
  it("остаток: 100 % — весь бюджет; ровно на цели — 0; 99,95 % — половина; ниже цели — перерасход < 0", () => {
    expect(budgetRemaining(1, 0.999)).toBe(1);
    expect(budgetRemaining(0.999, 0.999)).toBeCloseTo(0, 9);
    expect(budgetRemaining(0.9995, 0.999)).toBeCloseTo(0.5, 9);
    expect(budgetRemaining(0.998, 0.999)).toBeCloseTo(-1, 9);
    expect(budgetRemaining(null, 0.999)).toBeNull();
  });
  it("вердикт отчёта: выполнено на цели и выше, нарушено ниже, нет данных без измерений", () => {
    expect(verdict(0.9995, 0.999)).toEqual({ status: "met", text: "выполнено" });
    expect(verdict(0.999, 0.999)).toEqual({ status: "met", text: "выполнено" });
    expect(verdict(0.9989, 0.999)).toEqual({ status: "breached", text: "нарушено" });
    expect(verdict(null, 0.999)).toEqual({ status: "no_data", text: "нет данных" });
  });
  it("вердикт: погрешность суммы float у Prometheus (1e-13) не превращает «ровно цель» в нарушение; 1e-9 ниже — нарушение", () => {
    expect(verdict(0.999 - 1e-13, 0.999).status).toBe("met");
    expect(verdict(0.999 - 1e-9, 0.999).status).toBe("breached");
  });
});

describe("NFR-SLA: готовность /ready", () => {
  it("база и ML ответили — 200 ready; отказ — 503 с именами отказавших в порядке db, ml", () => {
    expect(READY_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    expect(readiness({ db: true, ml: true })).toEqual({ code: 200, body: { status: "ready" } });
    expect(readiness({ db: true, ml: false })).toEqual({ code: 503, body: { status: "not_ready", failed: ["ml"] } });
    expect(readiness({ db: false, ml: true })).toEqual({ code: 503, body: { status: "not_ready", failed: ["db"] } });
    expect(readiness({ ml: false, db: false })).toEqual({ code: 503, body: { status: "not_ready", failed: ["db", "ml"] } });
  });
});
