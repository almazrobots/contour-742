// OS-INSP-4.3.5 (T-118): критические параметры без вердикта перечисляются до финализации, финализация — только после
// подтверждения, что перечень просмотрен. Критический — приоритет HIGH Матрицы («приостановка работ» каталога организатора).
import { describe, expect, it } from "vitest";
import { canFinalize, criticalUnresolved, type CriticalCheck } from "../src/domain/lifecycle.ts";

const c = (param_code: string, finding_status: string, review_priority: string | null = "HIGH", verification_status = "PENDING"): CriticalCheck =>
  ({ param_code, finding_status, verification_status, review_priority }) as CriticalCheck;

describe("OS-INSP-4.3.5 критические параметры без вердикта", () => {
  it("перечень — критические параметры без вердикта сравнения, по коду, без повторов", () => {
    const checks = [
      c("M-010", "MISSING_EVIDENCE"),
      c("M-002", "NOT_COMPARABLE"),
      c("M-002", "CLARIFICATION_REQUIRED"),
      c("M-003", "CLARIFICATION_REQUIRED"),
    ];
    expect(criticalUnresolved(checks)).toEqual(["M-002", "M-003", "M-010"]);
  });

  it("вердикт сравнения или неприменимость — не пропуск", () => {
    const checks = [c("M-001", "NEGATIVE_VERIFIED"), c("M-004", "NOT_APPLICABLE"), c("M-005", "CANDIDATE", "HIGH", "CONFIRMED_VIOLATION")];
    expect(criticalUnresolved(checks)).toEqual([]);
  });

  it("существенный параметр (MEDIUM) или без приоритета в перечень не входит", () => {
    expect(criticalUnresolved([c("M-020", "MISSING_EVIDENCE", "MEDIUM"), c("M-021", "NOT_COMPARABLE", null)])).toEqual([]);
  });

  it("решение инспектора по критическому параметру снимает его из перечня", () => {
    expect(criticalUnresolved([c("M-006", "CLARIFICATION_REQUIRED", "HIGH", "NEGATIVE_VERIFIED")])).toEqual([]);
    expect(criticalUnresolved([c("M-006", "MISSING_EVIDENCE", "HIGH", "CLARIFICATION_REQUIRED")])).toEqual([]);
  });

  it("без подтверждения финализация отклоняется с перечнем и кодом CRITICAL_UNREVIEWED", () => {
    const r = canFinalize("COMPLETED", [c("M-007", "MISSING_EVIDENCE"), c("M-001", "NEGATIVE_VERIFIED")]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CRITICAL_UNREVIEWED");
    expect(r.critical).toEqual(["M-007"]);
    expect(r.reason).toContain("1");
  });

  it("с подтверждением финализация проходит; пустой перечень подтверждения не требует", () => {
    expect(canFinalize("COMPLETED", [c("M-007", "MISSING_EVIDENCE")], true).ok).toBe(true);
    expect(canFinalize("COMPLETED", [c("M-001", "NEGATIVE_VERIFIED")]).ok).toBe(true);
  });

  it("подтверждение перечня не отменяет правило открытых кандидатов (OS-INSP-4.3.1)", () => {
    const r = canFinalize("VERIFYING", [c("M-008", "CANDIDATE"), c("M-007", "MISSING_EVIDENCE")], true);
    expect(r.ok).toBe(false);
    expect(r.code).toBeUndefined();
  });
});
