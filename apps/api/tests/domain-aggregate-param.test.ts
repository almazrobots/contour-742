// L1 · L3 · L5 · L6 — OS-INSP-3.1.52…3.1.56 (T-175): итог таблицы против суммы строк (CMP-10, CMP-30), итоги стадий со
// спуском к строкам-корням (CMP-10, VER-12), состав и доли квартирографии (CMP-08, CMP-11). Таблицы синтетические.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareComposition, compareTotals, evaluateCompositionParam, rowKey, sumCheck, type AggTable, type CompositionMention } from "../src/domain/aggregate-param.ts";

const row = (label: string, num: number, page = 5) => ({ label, num, page });
const table = (stage: "PD" | "RD" | "ID", rows: Array<{ label: string; num: number; page?: number }>, total: number | null, o: Partial<AggTable> = {}): AggTable => ({
  stage, document_code: `${stage}-АР`, file_id: `f-${stage}`, rows: rows.map((r) => row(r.label, r.num, r.page)), total: total === null ? null : { num: total, page: 6 }, ...o,
});

describe("итог против суммы строк (L1 · L6, OS-INSP-3.1.52)", () => {
  it("сходится в пределах допуска — гипотезы нет", () => {
    expect(sumCheck(table("PD", [{ label: "Кв. 1", num: 45.2 }, { label: "Кв. 2", num: 60.1 }], 105.3), 0.05)).toBeNull();
  });
  it("не сходится — гипотеза с суммой строк, итогом и разницей", () => {
    const s = sumCheck(table("RD", [{ label: "Кв. 1", num: 45.2 }, { label: "Кв. 2", num: 60.1 }], 110.3), 0.05)!;
    expect(s.description).toBe("Итог не сходится в РД (RD-АР, стр. 6): сумма строк 105,3, итог 110,3 — разница +5");
    expect(s.dedup_key).toBe("agg-sum:RD:f-RD@6:110.3");
  });
  it("итога нет или строк нет — сверять нечего", () => {
    expect(sumCheck(table("PD", [{ label: "Кв. 1", num: 1 }], null), 0)).toBeNull();
    expect(sumCheck(table("PD", [], 10), 0)).toBeNull();
  });
  it("L5: гипотеза есть ровно тогда, когда |Σ − итог| > допуска", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }), fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 20 }), (nums, shift, tol) => {
      const sum = nums.reduce((a, b) => a + b, 0);
      const t = table("PD", nums.map((n, i) => ({ label: `r${i}`, num: n })), sum + shift);
      expect(sumCheck(t, tol) !== null).toBe(Math.abs(shift) > tol);
    }));
  });
});

describe("итоги стадий и строки-корни (L1 · L6, OS-INSP-3.1.53, 3.1.54)", () => {
  const pd = table("PD", [{ label: "Кв. 1", num: 45.2 }, { label: "Кв. 2", num: 60.1 }, { label: "Кв. 3", num: 30 }], 135.3);
  it("итоги совпали — NEGATIVE_VERIFIED, корней нет", () => {
    const r = compareTotals(pd, table("RD", [{ label: "Кв. 1", num: 45.2 }, { label: "Кв. 2", num: 60.1 }, { label: "Кв. 3", num: 30 }], 135.3), { unit: "м²", tolerance: 0.05 });
    expect(r).toMatchObject({ status: "NEGATIVE_VERIFIED", roots: [] });
  });
  it("итоги разошлись — кандидат по итогу, корни: изменённая, удалённая и добавленная строки; итог производный от строк", () => {
    const rd = table("RD", [{ label: "Кв. 1", num: 45.2 }, { label: "Кв. 2", num: 58.1, page: 7 }, { label: "Кв. 4", num: 20, page: 8 }], 123.3);
    const r = compareTotals(pd, rd, { unit: "м²", tolerance: 0.05 });
    expect(r.status).toBe("CANDIDATE");
    expect(r.derived_from).toBe("rows");
    expect(r.roots).toEqual([
      { kind: "changed", label: "Кв. 2", from: 60.1, to: 58.1, delta: -2 },
      { kind: "removed", label: "Кв. 3", from: 30, to: null, delta: -30 },
      { kind: "added", label: "Кв. 4", from: null, to: 20, delta: 20 },
    ]);
    expect(r.reason).toBe("Итог РД меньше ПД на 12 м² (135,3 → 123,3), допуск ±0,05 м². Корни расхождения: «Кв. 2» 60,1 → 58,1 (стр. 7); «Кв. 3» удалена (было 30); «Кв. 4» добавлена (20, стр. 8)");
  });
  it("строк в одной из стадий нет — сравнивается только итог, спуск к строкам невозможен", () => {
    const r = compareTotals(pd, table("RD", [], 123.3), { unit: "м²", tolerance: 0.05 });
    expect(r.status).toBe("CANDIDATE");
    expect(r.roots).toEqual([]);
    expect(r.derived_from).toBeNull();
    expect(r.reason).toContain("строк таблицы в РД нет — спуск к строкам невозможен");
  });
  it("итога нет — итог считается суммой строк и помечается производным", () => {
    const r = compareTotals(table("PD", [{ label: "a", num: 10 }, { label: "b", num: 5 }], null), table("RD", [{ label: "a", num: 10 }, { label: "b", num: 5 }], null), { unit: "шт.", tolerance: 0 });
    expect(r).toMatchObject({ status: "NEGATIVE_VERIFIED", expected: 15, actual: 15 });
  });
  it("ни итога, ни строк — сравнить нечего", () => {
    expect(compareTotals(table("PD", [], null), table("RD", [], 5), { unit: "шт.", tolerance: 0 }).status).toBe("MISSING_EVIDENCE");
  });
  it("ключ строки: регистр, пробелы, «№», «ё» и латинские двойники не важны", () => {
    expect(rowKey("  Кв. №  12 ")).toBe(rowKey("кв. 12"));
    expect(rowKey("Жилая комната Ё")).toBe(rowKey("жилая  комната е"));
    expect(rowKey("Kв. 1")).toBe(rowKey("Кв. 1")); // латинская K
  });
  it("одинаковые подписи строк складываются, а не теряются", () => {
    const a = table("PD", [{ label: "Окно ОК-1", num: 10 }, { label: "Окно ОК-1", num: 5 }], 15);
    const b = table("RD", [{ label: "Окно ОК-1", num: 12 }], 12);
    expect(compareTotals(a, b, { unit: "шт.", tolerance: 0 }).roots).toEqual([{ kind: "changed", label: "Окно ОК-1", from: 15, to: 12, delta: -3 }]);
  });
  it("L5: сумма дельт корней равна разнице сумм строк", () => {
    const rows = fc.array(fc.record({ label: fc.constantFrom("a", "b", "c", "d", "e"), num: fc.integer({ min: 0, max: 100 }) }), { maxLength: 8 });
    fc.assert(fc.property(rows, rows, (ra, rb) => {
      const r = compareTotals(table("PD", ra, null), table("RD", rb, null), { unit: "шт.", tolerance: 0 });
      if (!ra.length || !rb.length) return;
      const sa = ra.reduce((s, x) => s + x.num, 0);
      const sb = rb.reduce((s, x) => s + x.num, 0);
      expect(r.roots.reduce((s, x) => s + x.delta, 0)).toBeCloseTo(sb - sa, 9);
    }));
  });
});

describe("квартирография: состав и доли (L1 · L3 · L6, OS-INSP-3.1.55, 3.1.56)", () => {
  const pd = { "1к": 40, "2к": 80, "3к": 40 };
  it("тот же состав и доли в пределах допуска — NEGATIVE_VERIFIED", () => {
    expect(compareComposition(pd, { "1к": 41, "2к": 80, "3к": 40 }, 2)).toMatchObject({ status: "NEGATIVE_VERIFIED", added: [], removed: [], shifts: [] });
  });
  it("появился и исчез тип — кандидат со списками (CMP-08)", () => {
    const r = compareComposition(pd, { "1к": 40, "2к": 80, "студия": 20 }, 100);
    expect(r).toMatchObject({ status: "CANDIDATE", added: ["студия"], removed: ["3к"] });
    expect(r.reason).toContain("появились: студия; исчезли: 3к");
  });
  it("доля типа сдвинулась больше допуска — кандидат с долями обеих стадий (CMP-11)", () => {
    const r = compareComposition(pd, { "1к": 80, "2к": 60, "3к": 20 }, 5);
    expect(r.status).toBe("CANDIDATE");
    expect(r.shifts).toEqual([
      { type: "1к", from_pct: 25, to_pct: 50, delta_pp: 25 },
      { type: "2к", from_pct: 50, to_pct: 37.5, delta_pp: -12.5 },
      { type: "3к", from_pct: 25, to_pct: 12.5, delta_pp: -12.5 },
    ]);
    expect(r.reason).toContain("1к: 25 % → 50 % (+25 п.п.)");
  });
  it("ровно на допуске — не сдвиг; пустой состав — сравнивать нечего", () => {
    expect(compareComposition({ a: 50, b: 50 }, { a: 55, b: 45 }, 5).shifts).toEqual([]);
    expect(compareComposition({}, pd, 5).status).toBe("MISSING_EVIDENCE");
  });
  it("L5: доли каждой стадии в сумме — 100 %", () => {
    const comp = fc.dictionary(fc.constantFrom("1к", "2к", "3к", "4к"), fc.integer({ min: 1, max: 200 }), { minKeys: 1 });
    fc.assert(fc.property(comp, comp, (a, b) => {
      const r = compareComposition(a, b, 0);
      const types = new Set([...Object.keys(a), ...Object.keys(b)]);
      const shares = [...types].map((t) => r.shares[t]);
      expect(shares.reduce((s, x) => s + x.from_pct, 0)).toBeCloseTo(100, 4); // доли округлены до 1e-6
      expect(shares.reduce((s, x) => s + x.to_pct, 0)).toBeCloseTo(100, 4);
    }));
  });
});

describe("вход не доверяется (L6, находки ревью безопасности T-175)", () => {
  it("неконечное число не даёт «совпало»: NaN или Infinity в итоге — сравнить не с чем, а не NEGATIVE_VERIFIED", () => {
    const ok = table("PD", [{ label: "a", num: 10 }], 10);
    expect(compareTotals(ok, table("RD", [{ label: "a", num: 10 }], Number.NaN), { unit: "шт.", tolerance: 0 }).status).toBe("MISSING_EVIDENCE");
    expect(compareTotals(table("PD", [{ label: "a", num: Number.POSITIVE_INFINITY }], null), ok, { unit: "шт.", tolerance: 0 }).status).toBe("MISSING_EVIDENCE");
  });
  it("строка с неконечным числом не участвует в сумме и корнях; итог NaN — сверять нечего", () => {
    expect(sumCheck(table("PD", [{ label: "a", num: 10 }, { label: "b", num: Number.NaN }], 10), 0)).toBeNull();
    expect(sumCheck(table("PD", [{ label: "a", num: 10 }], Number.NaN), 0)).toBeNull();
    const r = compareTotals(table("PD", [{ label: "a", num: 10 }, { label: "b", num: Number.NaN }], null), table("RD", [{ label: "a", num: 10 }], null), { unit: "шт.", tolerance: 0 });
    expect(r).toMatchObject({ status: "NEGATIVE_VERIFIED", roots: [] });
  });
  it("типы с именами из прототипа (constructor, __proto__, toString) — обычные типы, а не «уже есть»", () => {
    const r = compareComposition({ "1к": 10 }, { "1к": 10, constructor: 5, toString: 1 }, 100);
    expect(r.added).toEqual(["constructor", "toString"]);
    const p = JSON.parse('{"__proto__": 7, "1к": 3}');
    expect(compareComposition({ "1к": 3 }, p, 100).added).toEqual(["__proto__"]);
  });
  it("отрицательное и неконечное количество в составе не считается", () => {
    const r = compareComposition({ "1к": 10, "2к": -5, "3к": Number.NaN }, { "1к": 10 }, 0);
    expect(r).toMatchObject({ status: "NEGATIVE_VERIFIED", removed: [] });
  });
});

describe("состав стадии из упоминаний и сравнение (L1 · L6, OS-INSP-3.1.55, 3.1.56, 3.1.57)", () => {
  const P = { tolerance_pp: 2, sources: { PD: [{ discipline: "ПЗ" }, { discipline: "АР" }], RD: [{ discipline: "АР" }], ID: [{ discipline: "*" }] } as any };
  const param = { code: "M-011", parameter_name: "Квартирография", trigger_logic: "Изменение квартирографии", applicability: null, source_pd: "ПЗ", source_rd: "АР", source_id: "—" } as any;
  let k = 0;
  const cm = (stage: "PD" | "RD" | "ID", type: string, num: number, o: any = {}): CompositionMention => ({
    stage, type, num, file_id: o.file_id ?? `${stage}-f`, sha256: "a".repeat(64), document_code: o.document_code ?? `${stage}-ПЗ`, revision: "0", approval_status: "APPROVED", role: "CURRENT",
    discipline: o.discipline ?? (stage === "PD" ? "ПЗ" : "АР"), page: o.page ?? ++k, bbox: null, quote: `${type} — ${num}`, confidence: 0.85, excluded: o.excluded ?? null, excluded_why: null,
  });
  it("состав стадии — из самого приоритетного документа; другой документ стадии не смешивается", () => {
    const ms = [cm("PD", "1к", 40, { file_id: "pz" }), cm("PD", "2к", 80, { file_id: "pz" }), cm("PD", "1к", 99, { file_id: "ar", discipline: "АР" }), cm("RD", "1к", 40), cm("RD", "2к", 80)];
    const ev = evaluateCompositionParam({ param, passport: P, mentions: ms, loadedStages: ["PD", "RD"] });
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.expected).toBe("1к — 40, 2к — 80");
  });
  it("появился тип — кандидат (CMP-08); фрагменты — числа типов обеих стадий", () => {
    const ev = evaluateCompositionParam({ param, passport: P, mentions: [cm("PD", "1к", 40), cm("PD", "2к", 80), cm("RD", "1к", 40), cm("RD", "2к", 80), cm("RD", "студия", 20)], loadedStages: ["PD", "RD"] });
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("появились: студия");
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected", "expected", "actual", "actual", "actual"]);
  });
  it("у типа внутри документа — первое неотсеянное упоминание", () => {
    const ev = evaluateCompositionParam({ param, passport: P, mentions: [cm("PD", "1к", 5, { excluded: "AREA" }), cm("PD", "1к", 40), cm("RD", "1к", 40)], loadedStages: ["PD", "RD"] });
    expect(ev.expected).toBe("1к — 40");
  });
  it("отдельный тип (E2, «2Е») только в одной стадии — NOT_COMPARABLE, а не «появился тип»; в обеих — обычное сравнение", () => {
    const S = { ...P, separate: ["E2"] };
    const odd = evaluateCompositionParam({ param, passport: S, mentions: [cm("PD", "1к", 40), cm("PD", "2к", 80), cm("RD", "1к", 40), cm("RD", "E2", 80)], loadedStages: ["PD", "RD"] });
    expect(odd.status).toBe("NOT_COMPARABLE");
    expect(odd.reason).toContain("E2");
    expect(odd.reason).toContain("РД");
    expect(odd.fragments.map((f) => f.kind)).toEqual(["expected", "expected", "actual", "actual"]);
    const both = evaluateCompositionParam({ param, passport: S, mentions: [cm("PD", "E2", 40), cm("PD", "2к", 80), cm("RD", "E2", 40), cm("RD", "2к", 80)], loadedStages: ["PD", "RD"] });
    expect(both.status).toBe("NEGATIVE_VERIFIED");
    // без отметки в паспорте E2 — обычный тип: появился — кандидат
    expect(evaluateCompositionParam({ param, passport: P, mentions: [cm("PD", "1к", 40), cm("RD", "1к", 40), cm("RD", "E2", 5)], loadedStages: ["PD", "RD"] }).status).toBe("CANDIDATE");
  });
  it("одна стадия — MISSING_EVIDENCE", () => {
    expect(evaluateCompositionParam({ param, passport: P, mentions: [cm("PD", "1к", 40)], loadedStages: ["PD", "RD"] }).status).toBe("MISSING_EVIDENCE");
  });
});

describe("подтипы внутри типа (L1, OS-INSP-3.1.57)", () => {
  const P = { tolerance_pp: 2, sources: { PD: [{ discipline: "ПЗ" }], RD: [{ discipline: "АР" }], ID: [{ discipline: "*" }] } as any };
  const base = { file_id: "f", sha256: "a".repeat(64), document_code: "ПЗ", revision: "0", approval_status: "APPROVED" as const, role: "CURRENT" as const, discipline: "ПЗ", bbox: null, quote: "", confidence: 0.8, excluded: null, excluded_why: null };
  it("четырёх- и пятикомнатные в «4к+» складываются; повтор одного подтипа — нет", async () => {
    const { stageComposition } = await import("../src/domain/aggregate-param.ts");
    const ms = [
      { ...base, stage: "PD" as const, type: "4к+", sub: "4", num: 3, page: 1 },
      { ...base, stage: "PD" as const, type: "4к+", sub: "5", num: 12, page: 1 },
      { ...base, stage: "PD" as const, type: "4к+", sub: "4", num: 3, page: 2 },
      { ...base, stage: "PD" as const, type: "1к", sub: "1", num: 40, page: 1 },
    ];
    expect(stageComposition(ms, "PD", P).map((m) => [m.type, m.num])).toEqual([["4к+", 15], ["1к", 40]]);
  });
});
