// OS-INSP-4.1.15, 4.1.16 (T-105/T-107 плана): отмена решения клавишей Z и счётчик действий на решение.
import { describe, expect, it } from "vitest";
import { actionsSummary, reopenVerdict } from "../src/domain/decision-flow.ts";

describe("вернуть решённого кандидата в PENDING", () => {
  it("решённого признанием, снятием или уточнением — можно, пока протокол не финализирован", () => {
    for (const v of ["CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "CLARIFICATION_REQUIRED"]) expect(reopenVerdict({ process: "VERIFYING", verification: v })).toEqual({ ok: true });
    expect(reopenVerdict({ process: "COMPLETED", verification: "CONFIRMED_VIOLATION" })).toEqual({ ok: true });
  });
  it("финализированный протокол — нельзя, решения неизменяемы", () => {
    expect(reopenVerdict({ process: "FINALIZED", verification: "CONFIRMED_VIOLATION" })).toEqual({ ok: false, status: 409, error: "Протокол финализирован: решения неизменяемы" });
  });
  it("ещё не решён — возвращать нечего", () => {
    expect(reopenVerdict({ process: "VERIFYING", verification: "PENDING" })).toMatchObject({ ok: false, status: 409 });
  });
  it("разделённый составной кандидат — решают его части, не его", () => {
    expect(reopenVerdict({ process: "VERIFYING", verification: "SPLIT" })).toMatchObject({ ok: false, status: 409 });
  });
  it("разбор ещё идёт — верификация недоступна", () => {
    expect(reopenVerdict({ process: "PARSING", verification: "CONFIRMED_VIOLATION" })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("тексты отказа называют причину", () => {
  it("разделённый и нерешённый — разные объяснения", () => {
    expect(reopenVerdict({ process: "VERIFYING", verification: "SPLIT" })).toMatchObject({ error: expect.stringMatching(/разделён/) });
    expect(reopenVerdict({ process: "VERIFYING", verification: "PENDING" })).toMatchObject({ error: expect.stringMatching(/не решён/) });
    expect(reopenVerdict({ process: "PARSING", verification: "CONFIRMED_VIOLATION" })).toMatchObject({ error: expect.stringMatching(/PARSING/) });
  });
});

describe("действий на решение (ТЗ 9.3.6: не больше 3)", () => {
  it("медиана, максимум и доля решений в пределе 3", () => {
    expect(actionsSummary([1, 1, 2, 3, 5])).toEqual({ decisions: 5, median: 2, max: 5, within3: 0.8 });
  });
  it("чётное число — медиана посередине", () => {
    expect(actionsSummary([1, 2, 3, 4]).median).toBe(2.5);
  });
  it("решения без счётчика (старый клиент) не искажают сводку", () => {
    expect(actionsSummary([null, 1, undefined, 1])).toEqual({ decisions: 2, median: 1, max: 1, within3: 1 });
  });
  it("ноль действий (решение клавишей без переходов) — допустимое значение", () => {
    expect(actionsSummary([0, 1])).toEqual({ decisions: 2, median: 0.5, max: 1, within3: 1 });
  });
  it("порядок значений не важен", () => {
    expect(actionsSummary([5, 1, 3])).toEqual({ decisions: 3, median: 3, max: 5, within3: 2 / 3 });
  });
  it("нет данных — пустая сводка, без деления на ноль", () => {
    expect(actionsSummary([])).toEqual({ decisions: 0, median: null, max: null, within3: null });
  });
  it("отрицательное и дробное число действий отбрасывается как недостоверное", () => {
    expect(actionsSummary([-1, 1.5, 2]).decisions).toBe(1);
  });
});
