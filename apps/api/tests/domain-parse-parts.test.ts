// Эшелоны: L1 (нарезка тома), L3 (границы: том не больше части, ровное деление), L4 (сбой части — отказ без сборки).
// T-233: том PDF на 170–890 МБ целиком разбирал один процесс ML часами — все места разбора стояли за гигантами.
import { afterEach, describe, expect, it } from "vitest";
import { partRanges, runLimited } from "../src/domain/parse-parts.ts";
import { type MlParts, parseInParts, setMlParts } from "../src/services/ml-client.ts";

const SHA = "a".repeat(64);

describe("partRanges — диапазоны страниц подряд, без дыр и наложений", () => {
  it("том 250 стр. по 100 — три части, последняя короче", () => {
    expect(partRanges(250, 100)).toEqual([[0, 100], [100, 200], [200, 250]]);
  });
  it("ровное деление — без пустой части в конце", () => {
    expect(partRanges(200, 100)).toEqual([[0, 100], [100, 200]]);
  });
  it("том не больше одной части и выключенная нарезка — пусто: разбор целиком, как раньше", () => {
    expect(partRanges(100, 100)).toEqual([]);
    expect(partRanges(5, 100)).toEqual([]);
    expect(partRanges(500, 0)).toEqual([]);
    expect(partRanges(Number.NaN, 50)).toEqual([]);
  });
  it("части покрывают все страницы ровно один раз", () => {
    for (const [n, s] of [[1001, 50], [51, 50], [999, 7]]) {
      const r = partRanges(n, s);
      expect(r[0][0]).toBe(0);
      expect(r.at(-1)![1]).toBe(n);
      r.slice(1).forEach(([first], i) => expect(first).toBe(r[i][1]));
    }
  });
});

describe("runLimited — не больше limit одновременно", () => {
  it("пик параллельности = limit, все задачи выполнены", async () => {
    let now = 0, peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      peak = Math.max(peak, ++now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      done.push(x);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("ошибка задачи — наружу, новые задачи после неё не начинаются", async () => {
    const started: number[] = [];
    await expect(runLimited([1, 2, 3, 4, 5], 1, async (x) => {
      started.push(x);
      if (x === 2) throw new Error("часть 2 упала");
    })).rejects.toThrow("часть 2 упала");
    expect(started).toEqual([1, 2]);
  });
});

describe("parseInParts — части на ML, затем сборка", () => {
  const calls: string[] = [];
  const fake = (pages: number | null, parsed = false, failAt = -1): MlParts => ({
    pages: async () => ({ pages, parsed }),
    part: async (_s, first, last) => {
      calls.push(`part ${first}-${last}`);
      if (first === failAt) throw new Error("ML упал на части");
    },
    assemble: async (_s, ranges) => void calls.push(`assemble ${ranges.length}`),
  });
  afterEach(() => (calls.length = 0));

  it("большой том — все части, потом одна сборка", async () => {
    setMlParts(fake(120));
    expect(await parseInParts(SHA, 50, 2)).toBe(3);
    expect(calls.filter((c) => c.startsWith("part")).sort()).toEqual(["part 0-50", "part 100-120", "part 50-100"]);
    expect(calls.at(-1)).toBe("assemble 3");
  });
  it("уже разобран, не PDF, мал или нарезка выключена — ни частей, ни сборки", async () => {
    for (const [p, parsed, size] of [[500, true, 50], [null, false, 50], [40, false, 50], [500, false, 0]] as const) {
      setMlParts(fake(p, parsed));
      expect(await parseInParts(SHA, size, 4)).toBe(0);
    }
    expect(calls).toEqual([]);
  });
  it("часть упала — сборки нет, ошибка наружу (повтор разбора решает очередь)", async () => {
    setMlParts(fake(150, false, 50));
    await expect(parseInParts(SHA, 50, 1)).rejects.toThrow("ML упал на части");
    expect(calls.some((c) => c.startsWith("assemble"))).toBe(false);
  });
  it("отказ проверки кэша не превращается в уже разобранный документ", async () => {
    setMlParts({ ...fake(5), pages: async () => { throw new Error("checkpoint conflict"); } });
    await expect(parseInParts(SHA, 2, 1)).rejects.toThrow("checkpoint conflict");
    expect(calls).toEqual([]);
  });
  it("отказ финальной сборки не возвращает успешное число частей", async () => {
    setMlParts({ ...fake(5), assemble: async () => { throw new Error("incomplete document"); } });
    await expect(parseInParts(SHA, 2, 1)).rejects.toThrow("incomplete document");
    expect(calls).toEqual(["part 0-2", "part 2-4", "part 4-5"]);
  });

});
