// OS-INSP-4.1.23 (T-139, OWASP-аудит H1): справочник причин отклонения — только собственные ключи, без прототипа (L1, L6).
import { describe, expect, it } from "vitest";
import { rejectionEntry, SUGGESTED_FIX } from "../src/domain/feedback-logs.ts";
import { applyDecision } from "../src/domain/lifecycle.ts";
import { isReasonCode, REASON_CODES } from "../src/domain/types.ts";

const PROTO = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__"];
const view = { id: "C-1", inspection_id: "I-1", param_code: "M-001", finding_status: "CANDIDATE", reason: null, from_advisor: false };

describe("справочник причин", () => {
  it("каждый код справочника — причина", () => {
    for (const code of Object.keys(REASON_CODES)) expect(isReasonCode(code)).toBe(true);
  });
  it.each(PROTO)("служебное имя %s — не причина", (code) => {
    expect(isReasonCode(code)).toBe(false);
  });
  it("не строка, пустая строка и регистр — не причина", () => {
    for (const x of [undefined, null, 1, {}, [], "", "ocr_error", " OCR_ERROR"]) expect(isReasonCode(x)).toBe(false);
  });
});

describe("решение отклонения", () => {
  it.each(PROTO)("отклонение с причиной %s отвергается с названием кода", (code) => {
    const r = applyDecision({ action: "reject", reason_code: code, comment: "почему" });
    expect(r).toEqual({ error: `Неизвестный reason_code: ${code}` });
  });
  it("отклонение с причиной из справочника — NEGATIVE_VERIFIED", () => {
    expect(applyDecision({ action: "reject", reason_code: "WITHIN_TOLERANCE", comment: "в допуске" })).toEqual({ status: "NEGATIVE_VERIFIED" });
  });
  it("пустая причина и пустой комментарий — прежние отказы", () => {
    expect(applyDecision({ action: "reject", reason_code: "", comment: "x" })).toEqual({ error: "Для отклонения нужен reason_code" });
    expect(applyDecision({ action: "reject", reason_code: "OCR_ERROR", comment: "  " })).toEqual({ error: "Для отклонения нужен комментарий" });
  });
});

describe("журнал отклонений", () => {
  it("предложенная правка — строка справочника для кода из справочника", () => {
    for (const code of Object.keys(REASON_CODES)) {
      const e = rejectionEntry(view, { action: "reject", reason_code: code, comment: "c" } as any);
      expect(e?.suggested_fix).toBe(SUGGESTED_FIX[code as keyof typeof SUGGESTED_FIX]);
    }
  });
  it.each(PROTO)("для служебного имени %s правка — «разобрать вручную», а не функция прототипа", (code) => {
    const e = rejectionEntry(view, { action: "reject", reason_code: code, comment: "c" } as any);
    expect(e?.suggested_fix).toBe("Разобрать вручную: причина вне справочника");
  });
});
