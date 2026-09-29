// OS-INSP-4.1.6, 4.1.7: журналы отклонений и спорных случаев.
import { describe, expect, it } from "vitest";
import { disputeEntry, rejectionEntry, SUGGESTED_FIX, type CheckView } from "../src/domain/feedback-logs.ts";
import { REASON_CODES } from "../src/domain/types.ts";

const check = (o: Partial<CheckView> = {}): CheckView => ({ id: "F-1", inspection_id: "P-1", param_code: "M-002", finding_status: "CANDIDATE", reason: "ПД 12 705 ≠ РД 12 900", from_advisor: false, ...o });

describe("журнал отклонений (OS-INSP-4.1.6)", () => {
  it("отклонение — запись с вердиктом ИИ, причиной, комментарием и предложенной правкой", () => {
    expect(rejectionEntry(check(), { action: "reject", reason_code: "OCR_ERROR", comment: "цифра не та" })).toEqual({
      check_id: "F-1", inspection_id: "P-1", param_code: "M-002", ai_verdict: "CANDIDATE", reason_code: "OCR_ERROR", comment: "цифра не та", suggested_fix: SUGGESTED_FIX.OCR_ERROR,
    });
  });
  it("подтверждение и уточнение в журнал отклонений не пишутся", () => {
    expect(rejectionEntry(check(), { action: "confirm" })).toBeNull();
    expect(rejectionEntry(check(), { action: "clarify", comment: "?" })).toBeNull();
  });
  it("у каждой причины ТЗ своя правка; неизвестная причина — ручной разбор", () => {
    const fixes = Object.keys(REASON_CODES).map((r) => rejectionEntry(check(), { action: "reject", reason_code: r, comment: "x" })!.suggested_fix);
    expect(new Set(fixes).size).toBe(Object.keys(REASON_CODES).length);
    expect(fixes.every((f) => f.length > 10)).toBe(true);
    expect(rejectionEntry(check(), { action: "reject", reason_code: "OTHER", comment: "x" })!.suggested_fix).toMatch(/вручную/);
  });
});

describe("журнал спорных случаев (OS-INSP-4.1.7)", () => {
  it("«Требует уточнения» — спорный случай с обоснованием системы и комментарием инспектора", () => {
    expect(disputeEntry(check(), { action: "clarify", comment: "нет листа 3" })).toMatchObject({ kind: "CLARIFICATION", ai_comment: "ПД 12 705 ≠ РД 12 900", inspector_comment: "нет листа 3" });
  });
  it("уточнение без комментария и без обоснования системы — поля не пустые undefined", () => {
    expect(disputeEntry(check({ reason: null }), { action: "clarify" })).toMatchObject({ ai_comment: "Вердикт системы: CANDIDATE", inspector_comment: "" });
  });
  it("отклонение гипотезы советника — расхождение с ИИ; обычное отклонение — не спор", () => {
    expect(disputeEntry(check({ from_advisor: true }), { action: "reject", reason_code: "BINDING_ERROR", comment: "не тот лист" })!.kind).toBe("ADVISOR_DISAGREEMENT");
    expect(disputeEntry(check(), { action: "reject", reason_code: "BINDING_ERROR", comment: "x" })).toBeNull();
  });
  it("подтверждение — согласие, даже для записи советника", () => {
    expect(disputeEntry(check({ from_advisor: true }), { action: "confirm" })).toBeNull();
  });
});
