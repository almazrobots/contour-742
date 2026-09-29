// L1 · L3 · L5 · L6 — OS-INSP-2.2.60, 2.2.61, 3.1.50, 3.1.51 (T-175): счётный параметр (CMP-07) — целые без допуска,
// источник подсчёта, двойной подсчёт внутри стадии понижает межстадийный вывод. Упоминания синтетические.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COUNT_SOURCE_RU, countPassport, countSourceOf, doubleCount, evaluateCountParam, wholeOnly, type CountMention, type CountPassport } from "../src/domain/count-param.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const P: CountPassport = {
  unit: "эт.",
  sources: { PD: [{ discipline: "ПЗ", label: "ТЭП в ПЗ" }, { discipline: "АР" }], RD: [{ discipline: "АР", label: "Общие данные АР" }], ID: [{ discipline: "АР", label: "технический план" }] },
  link: null,
};
const param = { code: "M-007", parameter_name: "Этажность (надземная)", trigger_logic: "Любое изменение количества этажей", applicability: null, source_pd: "ПЗ: ТЭП", source_rd: "АР: Общие данные", source_id: "Технический план" } as unknown as Param;

let n = 0;
const m = (stage: Stage, num: number, o: Partial<CountMention> = {}): CountMention => ({
  stage, file_id: `f${++n}`, sha256: "a".repeat(64), document_code: `${stage}-${n}-АР`, revision: "0", approval_status: "APPROVED", role: "CURRENT",
  discipline: "АР", base: null, num, excluded: null, excluded_why: null, page: 3, bbox: null, quote: `Количество этажей — ${num}`, confidence: 0.9, count_source: "text", ...o,
});
const run = (mentions: CountMention[], loaded: Stage[] = ["PD", "RD", "ID"]) => evaluateCountParam({ param, passport: P, mentions, loadedStages: loaded, profile: {}, kitBases: new Set() });

describe("целые без допуска (L1, OS-INSP-3.1.50)", () => {
  it("равные количества — NEGATIVE_VERIFIED", () => {
    const ev = run([m("PD", 17), m("RD", 17)]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.expected).toBe("17");
    expect(ev.actual).toBe("17");
  });
  it("разница в один этаж — кандидат с разницей в штуках и обоими источниками", () => {
    const ev = run([m("PD", 17, { discipline: "ПЗ", page: 4 }), m("RD", 16, { page: 2 })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.delta).toBe("−1 эт.");
    expect(ev.reason).toContain("РД (АР, стр. 2) меньше ПД (ПЗ, стр. 4) на 1 эт.");
    expect(ev.reason).toContain("Правило Матрицы: Любое изменение количества этажей");
  });
  it("худшая из поздних стадий — в кандидате", () => {
    const ev = run([m("PD", 17), m("RD", 16), m("ID", 14)]);
    expect(ev.actual).toBe("14");
    expect(ev.delta).toBe("−3 эт.");
  });
  it("рост — тоже кандидат, со знаком «+»", () => {
    expect(run([m("PD", 10), m("RD", 12)]).delta).toBe("+2 эт.");
  });
  it("одна стадия — MISSING_EVIDENCE с тем, чего не хватает", () => {
    const ev = run([m("PD", 17)], ["PD", "RD"]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("РД: общие данные АР — количества нет");
  });
  it("L5: равенство и кандидат — ровно по равенству целых", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), (a, b) => {
      expect(run([m("PD", a), m("RD", b)]).status).toBe(a === b ? "NEGATIVE_VERIFIED" : "CANDIDATE");
    }));
  });
});

describe("только целые (L3 · L6, OS-INSP-2.2.60)", () => {
  it("дробное — отсеяно с причиной, в выбор не идёт", () => {
    const [a, b] = wholeOnly([m("PD", 17), m("PD", 16.5)]);
    expect(a.excluded).toBeNull();
    expect(b).toMatchObject({ excluded: "NOT_INTEGER", excluded_why: "не целое число — количеством не считается" });
    const ev = run([m("PD", 17), m("PD", 16.5), m("RD", 17)]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.provenance.mentions.find((x) => x.value === "16,5 эт.")).toMatchObject({ use: "dropped", why: "не целое число — количеством не считается" });
  });
  it("уже отсеянное другим правилом — причина не перезаписывается", () => {
    const [x] = wholeOnly([m("PD", 2.5, { excluded: "EXISTING", excluded_why: "существующее" })]);
    expect(x.excluded).toBe("EXISTING");
  });
  it("отрицательное и ноль: ноль — количество, минус — нет", () => {
    expect(wholeOnly([m("PD", 0)])[0].excluded).toBeNull();
    expect(wholeOnly([m("PD", -3)])[0].excluded).toBe("NOT_INTEGER");
  });
});

describe("двойной подсчёт внутри стадии (L1 · L6, OS-INSP-3.1.51, 2.2.61)", () => {
  it("текст и таблица расходятся — гипотеза с источниками и понижение вывода до CLARIFICATION_REQUIRED", () => {
    const ev = run([m("PD", 17, { discipline: "ПЗ", count_source: "text", page: 4 }), m("PD", 16, { count_source: "table", page: 9 }), m("RD", 16)]);
    expect(ev.status).toBe("CLARIFICATION_REQUIRED");
    expect(ev.reason).toContain("Подсчёт внутри ПД расходится");
    expect(ev.suspicions).toHaveLength(1);
    expect(ev.suspicions[0].description).toBe("Двойной подсчёт ПД: количество получено по-разному — текст: ПЗ — 17 (стр. 4); таблица: АР — 16 (стр. 9)");
    expect(ev.suspicions[0].dedup_key).toMatch(/^count-conflict:PD:/);
  });
  it("разные подсчёты совпали — гипотезы нет, вывод обычный", () => {
    const ev = run([m("PD", 17, { count_source: "text" }), m("PD", 17, { count_source: "table" }), m("RD", 16)]);
    expect(ev.suspicions).toEqual([]);
    expect(ev.status).toBe("CANDIDATE");
  });
  it("расхождение внутри стадии, но межстадийного расхождения нет — гипотеза есть, вывод не понижается", () => {
    const ev = run([m("PD", 17, { count_source: "text" }), m("PD", 16, { count_source: "drawing" }), m("RD", 17)]);
    expect(ev.suspicions).toHaveLength(1);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
  });
  it("doubleCount: одно упоминание или одинаковые значения — null", () => {
    expect(doubleCount([m("PD", 5)], "PD")).toBeNull();
    expect(doubleCount([m("PD", 5), m("PD", 5, { count_source: "table" })], "PD")).toBeNull();
  });
  it("источник подсчёта словами — для provenance и гипотезы", () => {
    expect(COUNT_SOURCE_RU).toEqual({ text: "текст", table: "таблица", drawing: "подсчёт по чертежу", computed: "расчёт" });
    const ev = run([m("PD", 17, { count_source: "table" }), m("RD", 17)]);
    expect(ev.provenance.mentions[0].why).toBeNull();
    expect(ev.provenance.mentions[0]).toMatchObject({ count_source: "таблица", qualifier: null });
    expect(ev.provenance.ops).toContain("CMP-07");
  });
});

describe("паспорт счётного параметра (L1)", () => {
  it("countPassport: вид count → конфигурация; иной вид — null", () => {
    const pp: any = { value: { kind: "count", unit: "кв." }, sources: P.sources, link: { by: "base_cipher", note: "" } };
    expect(countPassport(pp)).toEqual({ unit: "кв.", sources: P.sources, link: "base_cipher" });
    expect(countPassport({ ...pp, value: { kind: "quantity" } })).toBeNull();
    expect(countPassport({ ...pp, link: { by: "none", note: "" } })?.link).toBeNull();
  });
});

describe("источник подсчёта из разбора ML (L1 · L6, OS-INSP-2.2.61)", () => {
  it("явный count_source; иначе колонка таблицы — таблица; иначе текст; мусор — текст", () => {
    expect(countSourceOf({ count_source: "drawing" })).toBe("drawing");
    expect(countSourceOf({ table: "column" })).toBe("table");
    expect(countSourceOf({ table: "row" })).toBe("text");
    expect(countSourceOf({})).toBe("text");
    expect(countSourceOf(null)).toBe("text");
    expect(countSourceOf({ count_source: "магия", table: "column" })).toBe("table");
  });
});

describe("ворота, отметки стадий, фрагменты и тексты (L1 · L6, добивка мутаций)", () => {
  it("GTE-01: неприменимо по профилю — NOT_APPLICABLE с причиной; без профиля — сравнение идёт", () => {
    const p2 = { ...param, applicability: "residential" } as unknown as Param;
    const ev = evaluateCountParam({ param: p2, passport: P, mentions: [m("PD", 17), m("RD", 16)], loadedStages: ["PD", "RD"], profile: { residential: false }, kitBases: new Set() });
    expect(ev).toMatchObject({ status: "NOT_APPLICABLE", reason: "Неприменим к объекту: residential" });
    expect(evaluateCountParam({ param: p2, passport: P, mentions: [m("PD", 17), m("RD", 16)], loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set() }).status).toBe("CANDIDATE");
  });
  it("GTE-03: спорная редакция (CONFLICT или UNRESOLVED) — CLARIFICATION_REQUIRED с документом и редакцией", () => {
    for (const role of ["CONFLICT", "UNRESOLVED"] as const) {
      const ev = run([m("PD", 17), m("RD", 16, { role, document_code: "РД-АР", revision: "2" })]);
      expect(ev).toMatchObject({ status: "CLARIFICATION_REQUIRED", reason: "Не определена актуальная редакция: РД-АР ред. 2" });
      expect(ev.fragments).toEqual([expect.objectContaining({ document_code: "РД-АР", kind: "actual", value: "16" })]);
    }
  });
  it("отметки стадий: не загружена или не нужна Матрице — NOT_APPLICABLE; нет значения — NO_VALUE; есть — USED", () => {
    const p2 = { ...param, source_id: "—" } as unknown as Param;
    const ev = evaluateCountParam({ param: p2, passport: P, mentions: [m("PD", 17)], loadedStages: ["PD", "RD", "ID"], profile: {}, kitBases: new Set() });
    expect(ev.stage_notes).toEqual({ PD: "USED", RD: "NO_VALUE", ID: "NOT_APPLICABLE" });
    expect(ev.reason).toBe("Сравнить не с чем: ПД — 17 эт. (АР — 17 (стр. " + ev.fragments[0].page + ")). Запросите РД: общие данные АР — количества нет.");
    expect(ev.expected).toBe("17");
    expect(ev.fragments).toEqual([expect.objectContaining({ kind: "expected", value: "17", stage: "PD" })]);
  });
  it("ничего не найдено — причина без значения и expected = null", () => {
    const ev = run([], ["PD", "RD"]);
    expect(ev).toMatchObject({ status: "MISSING_EVIDENCE", expected: null });
    expect(ev.reason).toBe("Сравнить не с чем: количество не найдено ни в одной стадии. Запросите ПД: ТЭП в ПЗ — количества нет; РД: общие данные АР — количества нет; ИД: технический план — стадия не загружена.");
  });
  it("худшая по модулю из нескольких поздних стадий; при равенстве — первая; «больше» и дельта со знаком", () => {
    const ev = run([m("PD", 10), m("RD", 12, { page: 2 }), m("ID", 7, { page: 3 })]);
    expect([ev.actual, ev.delta]).toEqual(["7", "−3 эт."]);
    const tie = run([m("PD", 10), m("RD", 12, { page: 2 }), m("ID", 8, { page: 3 })]);
    expect([tie.actual, tie.delta]).toEqual(["12", "+2 эт."]);
    expect(tie.reason).toContain("РД (АР, стр. 2) больше ПД");
  });
  it("совпало: дельта «0 эт.», причина с количеством, фрагменты эталона и всех поздних стадий", () => {
    const ev = run([m("PD", 17, { page: 1 }), m("RD", 17, { page: 2 }), m("ID", 17, { page: 3 })]);
    expect(ev).toMatchObject({ status: "NEGATIVE_VERIFIED", delta: "0 эт.", reason: "Этажность (надземная): количество совпало (17 эт.)" });
    expect(ev.fragments.map((f) => [f.stage, f.kind, f.value, f.page])).toEqual([["PD", "expected", "17", 1], ["RD", "actual", "17", 2], ["ID", "actual", "17", 3]]);
  });
  it("понижение: полный текст причины — что и где разошлось в стадии", () => {
    const ev = run([m("PD", 17, { discipline: "ПЗ", count_source: "text", page: 4 }), m("PD", 16, { count_source: "table", page: 9 }), m("RD", 15, { page: 2 })]);
    expect(ev.reason).toBe("РД (АР, стр. 2) меньше ПД (ПЗ, стр. 4) на 2 эт., но подсчёт внутри ПД расходится — сначала уточните количество в самой стадии. Подсчёт внутри ПД расходится: текст: ПЗ — 17 (стр. 4); таблица: АР — 16 (стр. 9)");
  });
  it("ключ гипотезы: первое упоминание каждого значения, отсортировано; повтор значения не добавляет", () => {
    const s = doubleCount([m("PD", 17, { file_id: "b", page: 2 }), m("PD", 16, { file_id: "a", page: 5 }), m("PD", 17, { file_id: "c", page: 9 })], "PD")!;
    expect(s.dedup_key).toBe("count-conflict:PD:a@5:16|b@2:17");
    expect(s.mentions).toHaveLength(3);
  });
  it("provenance: операции CMP-07 и CMP-30, отсеянное с причиной, источник подсчёта у каждого", () => {
    const ev = run([m("PD", 17, { count_source: "drawing" }), m("PD", 2.5), m("RD", 17, { count_source: "computed" })]);
    expect(ev.provenance.ops).toEqual(["ENT-15", "NRM-01", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-07", "CMP-30", "DEC-01"]);
    expect(ev.provenance.mentions.map((x: any) => [x.stage, x.use, x.count_source, x.value])).toEqual([["PD", "chosen", "подсчёт по чертежу", "17 эт."], ["PD", "dropped", "текст", "2,5 эт."], ["RD", "chosen", "расчёт", "17 эт."]]);
    expect(countSourceOf({ count_source: "computed" })).toBe("computed");
  });
  it("паспорт без единицы — «шт.»", () => {
    expect(countPassport({ value: { kind: "count" }, sources: P.sources, link: { by: "none", note: "" } } as any)!.unit).toBe("шт.");
  });
});
