// NFR-LOAD-100 (T-075): дашборд считает счётчики в PostgreSQL, цвет — по счётчикам. Цвет обязан совпадать с прежним
// objectColor по строкам проверок на любом наборе статусов (OS-INSP-8.1.1) — сверка перебором всех сочетаний.
import { describe, expect, it } from "vitest";
import { colorFromCounts, dashboardCounts, objectColor } from "../src/domain/lifecycle.ts";

const FINDING = ["NEGATIVE_VERIFIED", "CANDIDATE", "MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"] as const;
const VERIF = ["PENDING", "CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED"] as const;
const ALL = FINDING.flatMap((f) => VERIF.map((v) => ({ finding_status: f, verification_status: v })));

describe("NFR-LOAD-100 цвет дашборда по счётчикам", () => {
  it("совпадает с objectColor на каждой паре статусов и на каждой паре пар", () => {
    for (const a of ALL) {
      expect(colorFromCounts(dashboardCounts([a]))).toBe(objectColor([a]));
      for (const b of ALL) expect(colorFromCounts(dashboardCounts([a, b]))).toBe(objectColor([a, b]));
    }
  });
  it("без записей — серый", () => {
    expect(colorFromCounts(dashboardCounts([]))).toBe("gray");
  });
  it("счётчики — как на дашборде: кандидаты ждут решения, уточнения по находке или решению, отрицательные по находке или решению", () => {
    const c = dashboardCounts([
      { finding_status: "CANDIDATE", verification_status: "PENDING" },
      { finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION" },
      { finding_status: "CLARIFICATION_REQUIRED", verification_status: "PENDING" },
      { finding_status: "CANDIDATE", verification_status: "CLARIFICATION_REQUIRED" },
      { finding_status: "MISSING_EVIDENCE", verification_status: "PENDING" },
      { finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING" },
      { finding_status: "CANDIDATE", verification_status: "NEGATIVE_VERIFIED" },
    ]);
    expect(c).toEqual({ candidates: 1, confirmed: 1, clarification: 2, missing: 1, negative: 2, total: 7 });
  });
});
