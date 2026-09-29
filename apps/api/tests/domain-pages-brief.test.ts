// Эшелоны: L1 (краткое описание страниц), L3 (пустое и неполное описание). T-135: карточка проверки для p95 ≤ 200 мс.
import { describe, expect, it } from "vitest";
import { pagesBrief } from "../src/domain/pages-brief.ts";

describe("краткое описание страниц в карточке проверки (TZA-11-10, T-135)", () => {
  it("оставляет номер, источник текста, качество и уверенность OCR — то, что показывает интерфейс", () => {
    const full = [{ page: 1, width: 2383.9, height: 1683.8, rotation: 0, source: "text", quality: "OK", ocr_confidence: null, engines: [], disputed_words: 0, agreement: null, lines: 34 },
      { page: 2, width: 595, height: 842, rotation: 90, source: "ocr", quality: "LOW_QUALITY", ocr_confidence: 43.6, engines: ["tesseract-psm4"], disputed_words: 12, agreement: 0.8, lines: 51 }];
    expect(pagesBrief(JSON.stringify(full))).toEqual([
      { page: 1, source: "text", quality: "OK", ocr_confidence: null },
      { page: 2, source: "ocr", quality: "LOW_QUALITY", ocr_confidence: 43.6 },
    ]);
    const size = (x: unknown) => JSON.stringify(x).length;
    expect(size(pagesBrief(JSON.stringify(full)))).toBeLessThan(size(full) / 2);
  });
  it("нет описания — null; неполное описание — умолчания, а не падение", () => {
    expect(pagesBrief(null)).toBeNull();
    expect(pagesBrief("")).toBeNull();
    expect(pagesBrief(JSON.stringify([{ page: 3 }]))).toEqual([{ page: 3, source: "", quality: "OK", ocr_confidence: null }]);
  });
});
