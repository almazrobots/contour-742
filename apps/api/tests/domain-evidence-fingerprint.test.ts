// OS-INSP-3.3.5, 3.3.6 (T-115 плана): отпечаток доказательства — решение переживает дозагрузку, если доказательство то же.
import { describe, expect, it } from "vitest";
import { evidenceFingerprint, carryDecision, type FpFragment } from "../src/domain/evidence-fingerprint.ts";

const f = (o: Partial<FpFragment> = {}): FpFragment => ({ sha256: "aa", page: 3, bbox: [0.1, 0.2, 0.3, 0.4], value: "B30", role: "expected", ...o });

describe("отпечаток доказательства", () => {
  it("те же фрагменты — тот же отпечаток, порядок не важен", () => {
    const a = [f(), f({ sha256: "bb", role: "actual", value: "B25" })];
    expect(evidenceFingerprint(a)).toBe(evidenceFingerprint([...a].reverse()));
  });
  it("другой файл (новая редакция документа с тем же значением) — другой отпечаток", () => {
    expect(evidenceFingerprint([f({ sha256: "cc" })])).not.toBe(evidenceFingerprint([f()]));
  });
  it("другая страница или значение — другой отпечаток", () => {
    expect(evidenceFingerprint([f({ page: 4 })])).not.toBe(evidenceFingerprint([f()]));
    expect(evidenceFingerprint([f({ value: "B35" })])).not.toBe(evidenceFingerprint([f()]));
  });
  it("дрожание рамки меньше 0,001 листа при повторном разборе — тот же отпечаток", () => {
    expect(evidenceFingerprint([f({ bbox: [0.10004, 0.2, 0.3, 0.40003] })])).toBe(evidenceFingerprint([f()]));
  });
  it("рамка сдвинулась заметно — другой отпечаток", () => {
    expect(evidenceFingerprint([f({ bbox: [0.15, 0.2, 0.35, 0.4] })])).not.toBe(evidenceFingerprint([f()]));
  });
  it("фрагмент без рамки и без страницы — отпечаток всё равно считается", () => {
    expect(evidenceFingerprint([f({ bbox: null, page: null })])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("отпечаток не склеивает поля и фрагменты (добивание мутантов)", () => {
  it("граница между полями значима: «ab|c» ≠ «a|bc»", () => {
    expect(evidenceFingerprint([f({ role: "ab", sha256: "c" })])).not.toBe(evidenceFingerprint([f({ role: "a", sha256: "bc" })]));
  });
  it("граница между фрагментами значима", () => {
    const one = [f({ value: "1\n2" })];
    const two = [f({ value: "1" }), f({ value: "2" })];
    expect(evidenceFingerprint(one)).not.toBe(evidenceFingerprint(two));
  });
  it("координаты рамки разделены: [0.1,0.23] ≠ [0.12,0.3]", () => {
    expect(evidenceFingerprint([f({ bbox: [0.1, 0.23, 0.5, 0.6] })])).not.toBe(evidenceFingerprint([f({ bbox: [0.12, 0.3, 0.5, 0.6] })]));
  });
});

describe("перенос решения после дозагрузки", () => {
  const fp = evidenceFingerprint([f()]);
  it("решения не было — переносить нечего", () => {
    expect(carryDecision({ verification: "PENDING", prevFp: fp, nextFp: fp, prevStatus: "CANDIDATE", nextStatus: "CANDIDATE" })).toBe("NONE");
  });
  it("доказательство и статус те же — решение переносится", () => {
    expect(carryDecision({ verification: "CONFIRMED_VIOLATION", prevFp: fp, nextFp: fp, prevStatus: "CANDIDATE", nextStatus: "CANDIDATE" })).toBe("CARRY");
  });
  it("доказательство изменилось — запись снова на оценке", () => {
    expect(carryDecision({ verification: "CONFIRMED_VIOLATION", prevFp: fp, nextFp: "x", prevStatus: "CANDIDATE", nextStatus: "CANDIDATE" })).toBe("RESET");
  });
  it("статус системы изменился (например, стал «расхождения нет») — решение не переносится", () => {
    expect(carryDecision({ verification: "NEGATIVE_VERIFIED", prevFp: fp, nextFp: fp, prevStatus: "CANDIDATE", nextStatus: "NEGATIVE_VERIFIED" })).toBe("RESET");
  });
});
