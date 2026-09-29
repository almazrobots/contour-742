// T-133: выдача файла кусками для pdf.js — разбор заголовка Range.
import { describe, expect, it } from "vitest";
import { parseRange } from "../src/domain/byte-range.ts";

describe("Range для просмотра PDF (T-133)", () => {
  it("диапазон, открытый хвост, суффикс; конец за размером обрезается", () => {
    expect(parseRange("bytes=0-1023", 40_000_000)).toEqual({ start: 0, end: 1023 });
    expect(parseRange("bytes=39999000-", 40_000_000)).toEqual({ start: 39_999_000, end: 39_999_999 });
    expect(parseRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("начало за концом файла и перевёрнутый диапазон — 416", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=10-5", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
  it("нет заголовка, несколько диапазонов, другие единицы, мусор — файл целиком", () => {
    for (const h of [undefined, "", "bytes=-", "bytes=0-1,5-9", "items=0-1", "bytes=a-b"]) expect(parseRange(h, 1000)).toBeNull();
  });
});
