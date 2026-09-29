// OS-INSP-2.1.16 (ТЗ 9.1.1, TZA-9.1.1-06, T-138): доля нечитаемых зон и покрываемость распознанным текстом —
// по файлу и по проверке в целом. Нечитаемые зоны: страницы LOW_QUALITY и ABSTAIN и сомнительные слова OCR
// (движки ансамбля разошлись, OS-INSP-2.1.6). Покрываемость — доля страниц, с которых получен текст.
// L1 — функциональные, L3 — пустые и граничные входы, L5 — свойства (fast-check), L6 — битые данные.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ocrQuality, type PageSummary } from "../src/domain/ocr-quality.ts";

const page = (over: Partial<PageSummary> = {}): PageSummary => ({ page: 1, source: "text", quality: "OK", ocr_confidence: null, lines: 10, words: 60, disputed_words: 0, ...over });
const file = (id: string, pages: PageSummary[] | null, name = `${id}.pdf`) => ({ file_id: id, file_name: name, pages_json: pages === null ? null : JSON.stringify(pages) });

describe("качество распознавания по файлу и проверке (OS-INSP-2.1.16)", () => {
  it("скан: 4 страницы — OK, LOW_QUALITY, ABSTAIN, OK; доля нечитаемых 0,5; покрываемость 0,75", () => {
    const r = ocrQuality([
      file("F1", [
        page({ page: 1, source: "ocr", ocr_confidence: 91, words: 100, disputed_words: 4 }),
        page({ page: 2, source: "ocr", quality: "LOW_QUALITY", ocr_confidence: 41, words: 50, disputed_words: 16 }),
        page({ page: 3, source: "ocr", quality: "ABSTAIN", lines: 0, words: 0 }),
        page({ page: 4, source: "ocr", ocr_confidence: 88, words: 50, disputed_words: 0 }),
      ]),
    ]);
    expect(r.files[0]).toMatchObject({
      file_id: "F1", pages: 4, ocr_pages: 4, low_quality: 1, abstain: 1, illegible_pages: [2, 3],
      illegible_share: 0.5, coverage: 0.75, ocr_words: 200, doubtful_words: 20, doubtful_share: 0.1, mean_ocr_confidence: 73.3,
    });
    expect(r.total).toMatchObject({ files: 1, pages: 4, illegible_share: 0.5, coverage: 0.75, doubtful_share: 0.1 });
  });

  it("текстовый слой — всё читается: доля нечитаемых 0, покрываемость 1, сомнительных слов нет (OCR не было)", () => {
    const r = ocrQuality([file("F2", [page(), page({ page: 2 })])]);
    expect(r.files[0]).toMatchObject({ ocr_pages: 0, illegible_share: 0, coverage: 1, ocr_words: 0, doubtful_share: null, mean_ocr_confidence: null });
  });

  it("итог по проверке — по страницам всех файлов, а не среднее по файлам", () => {
    const r = ocrQuality([
      file("A", [page({ source: "ocr", quality: "LOW_QUALITY", ocr_confidence: 30 })]), // 1 из 1 нечитаема
      file("B", Array.from({ length: 9 }, (_, i) => page({ page: i + 1 }))), // 0 из 9
    ]);
    expect(r.total.illegible_share).toBe(0.1); // 1 / 10, а не (1 + 0) / 2
    expect(r.total.pages).toBe(10);
  });

  it("страница без строк (пустой лист или неудачное распознавание) не считается покрытой", () => {
    const r = ocrQuality([file("F3", [page({ lines: 0, words: 0 }), page({ page: 2 })])]);
    expect(r.files[0].coverage).toBe(0.5);
  });

  it("L3 · файл ещё не разобран — в отчёте с pages 0 и статусом «не разобран», в итог не входит", () => {
    const r = ocrQuality([file("F4", null), file("F5", [page()])]);
    expect(r.files.find((f) => f.file_id === "F4")).toMatchObject({ parsed: false, pages: 0, coverage: null, illegible_share: null });
    expect(r.total).toMatchObject({ files: 2, parsed_files: 1, pages: 1, coverage: 1 });
  });

  it("L3 · пустая проверка — нули и null, а не деление на ноль", () => {
    expect(ocrQuality([]).total).toEqual({ files: 0, parsed_files: 0, pages: 0, ocr_pages: 0, low_quality: 0, abstain: 0, illegible_share: null, coverage: null, ocr_words: 0, doubtful_words: 0, doubtful_share: null, mean_ocr_confidence: null });
  });

  it("старый ответ ML без числа слов: доля сомнительных слов неизвестна (null), остальное считается", () => {
    const r = ocrQuality([file("F6", [{ page: 1, source: "ocr", quality: "OK", ocr_confidence: 80, lines: 5 } as PageSummary])]);
    expect(r.files[0]).toMatchObject({ doubtful_share: null, coverage: 1, illegible_share: 0 });
  });

  it("L6 · битый pages_json не роняет отчёт: файл помечен «не разобран»", () => {
    const r = ocrQuality([{ file_id: "F7", file_name: "x.pdf", pages_json: "{не json" }]);
    expect(r.files[0].parsed).toBe(false);
  });

  it("L5 · доли в [0; 1], нечитаемых страниц не больше страниц, покрываемость + доля ABSTAIN ≤ 1 (fast-check)", () => {
    const arbPage = fc.record({
      page: fc.integer({ min: 1, max: 500 }),
      source: fc.constantFrom("text", "ocr", "structured"),
      quality: fc.constantFrom("OK", "LOW_QUALITY", "ABSTAIN"),
      ocr_confidence: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: null }),
      lines: fc.integer({ min: 0, max: 80 }),
      words: fc.integer({ min: 0, max: 600 }),
      disputed_words: fc.integer({ min: 0, max: 600 }),
    }).map((p) => ({ ...p, disputed_words: Math.min(p.disputed_words, p.words) }));
    fc.assert(
      fc.property(fc.array(fc.array(arbPage, { maxLength: 30 }), { maxLength: 6 }), (files) => {
        const r = ocrQuality(files.map((ps, i) => file(`F${i}`, ps as PageSummary[])));
        for (const x of [r.total, ...r.files]) {
          for (const k of ["illegible_share", "coverage", "doubtful_share"] as const) if (x[k] !== null) expect(x[k]).toBeGreaterThanOrEqual(0), expect(x[k]).toBeLessThanOrEqual(1);
          expect(x.low_quality + x.abstain).toBeLessThanOrEqual(x.pages);
          if (x.coverage !== null) expect(x.coverage + x.abstain / Math.max(1, x.pages)).toBeLessThanOrEqual(1 + 1e-3); // доли округлены до тысячных
        }
      }),
    );
  });
});
