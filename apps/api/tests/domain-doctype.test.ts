// OS-INSP-2.2.7: вид документа влияет на применимость — смета и опросный лист не источник проектного значения.
import { describe, expect, it } from "vitest";
import { isDesignSource, NOT_DESIGN_SOURCE } from "../src/domain/doctype.ts";

describe("вид документа как источник параметра (OS-INSP-2.2.7)", () => {
  it("смета и опросный лист — не источник; спецификация, ведомость, общие данные, расчёт, чертёж — источник", () => {
    expect(NOT_DESIGN_SOURCE.map(isDesignSource)).toEqual([false, false]);
    for (const k of ["specification", "statement", "general_data", "calculation", "drawing", "other"]) expect([k, isDesignSource(k)]).toEqual([k, true]);
  });
  it("вид не определён (старый разбор, DOCX без заголовка) — не отбрасываем", () => {
    expect([null, undefined, ""].map(isDesignSource)).toEqual([true, true, true]);
  });
});
