// L7 · дисциплина: каждый тестовый файл API размечен эшелонами qa-standard, каждый эшелон L1–L7 чем-то закрыт.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const map = JSON.parse(readFileSync(join(dir, "echelons.json"), "utf8")).files as Record<string, string[]>;
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));

describe("разметка эшелонов API", () => {
  it("каждый тестовый файл размечен, в разметке нет несуществующих файлов и неизвестных эшелонов", () => {
    expect(files.filter((f) => !map[f])).toEqual([]);
    expect(Object.keys(map).filter((f) => !files.includes(f))).toEqual([]);
    expect(Object.values(map).flat().filter((e) => !/^L[1-8]$/.test(e))).toEqual([]);
  });
  it("эшелоны L1–L7 закрыты хотя бы одним файлом (L8 — ещё и мутационные прогоны)", () => {
    const covered = new Set(Object.values(map).flat());
    expect(["L1", "L2", "L3", "L4", "L5", "L6", "L7"].filter((e) => !covered.has(e))).toEqual([]);
  });
});
