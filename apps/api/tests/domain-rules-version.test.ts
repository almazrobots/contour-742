// T-133 (OS-INSP-2.1.15): правила сравнения сменились — проверка пересчитывается по всем параметрам без повторного разбора.
import { describe, expect, it } from "vitest";
import { recomputeAllParams, RULES_VERSION } from "../src/domain/rules-version.ts";

describe("версия правил сравнения (OS-INSP-2.1.15)", () => {
  it("первый расчёт и проверка, посчитанная прежними правилами или до учёта версии, — пересчёт всех параметров", () => {
    expect(recomputeAllParams(true, RULES_VERSION)).toBe(true);
    expect(recomputeAllParams(false, null)).toBe(true);
    expect(recomputeAllParams(false, "2026-09-01")).toBe(true);
  });
  it("правила те же — пересчитываются только затронутые новыми файлами параметры", () => {
    expect(recomputeAllParams(false, RULES_VERSION)).toBe(false);
  });
  it("версия называет правило, которое её сменило: без правила версию не поднимают молча", () => {
    expect(RULES_VERSION).toMatch(/OS-INSP-\d+\.\d+\.\d+/);
  });
});
