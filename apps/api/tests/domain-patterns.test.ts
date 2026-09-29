// OS-INSP-3.2.8–3.2.10: ML-паттерн-анализ по истории других объектов (ТЗ 9.5, 4-й подход свободного поиска).
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AREA_CODE, canJudge, detectAnomalies, fitPatternModel, median, objectProfile, patternKind, patternParams, robustZ,
  type HistoryObject, type PatternParam,
} from "../src/domain/patterns.ts";
import type { Fact } from "../src/domain/suspicions.ts";

const PARAMS = patternParams([
  { code: "M-002", parameter_name: "Общая площадь здания", unit: "м²", data_type: "number" },
  { code: "M-004", parameter_name: "Строительный объем (Общий)", unit: "м³", data_type: "number" },
  { code: "M-008", parameter_name: "Высота здания", unit: "м", data_type: "number" },
  { code: "M-009", parameter_name: "Абсолютная отметка 0.000", unit: "м", data_type: "number" },
  { code: "M-132", parameter_name: "Итоговая стоимость по ССР", unit: "тыс. руб.", data_type: "number" },
  { code: "M-013", parameter_name: "Класс энергоэффективности", unit: "Класс (А)", data_type: "enum" },
]);

/** Объект истории: площадь и значения параметров. */
const obj = (id: string, area: number | null, vals: Record<string, number | null>): HistoryObject => ({
  object_id: id,
  facts: [...(area === null ? [] : [{ key: AREA_CODE, num: area }]), ...Object.entries(vals).map(([key, num]) => ({ key, num }))],
});
/** Пять объектов по 1000 м², удельный объём 2,9…3,1 м³/м² — медиана 3, узкий разброс. */
const TIGHT = [2900, 3000, 3100, 2950, 3050].map((v, i) => obj(`O${i}`, 1000, { "M-004": v }));
/** Удельный объём 2,6…3,4 — медиана 3, разброс шире: z = 3,5 соответствует отклонению около 30 %. */
const WIDE = [2600, 2800, 3000, 3200, 3400].map((v, i) => obj(`W${i}`, 1000, { "M-004": v }));

const fact = (key: string, num: number | null, stage: Fact["stage"] = "PD"): Fact => ({ key, num, text: null, stage, ref: `ПЗ, ред. 1, стр. ${key.slice(2)}` });
const current = (volume: number, area = 1000, stage: Fact["stage"] = "PD"): Fact[] => [fact(AREA_CODE, area, stage), fact("M-004", volume, stage)];
const detect = (history: HistoryObject[], facts: Fact[], self = "CUR") => detectAnomalies(fitPatternModel(history, PARAMS, self), facts, PARAMS);

describe("OS-INSP-3.2.8 модель паттернов: удельные показатели, медиана, робастный разброс, версия", () => {
  it("экстенсивные единицы (м², м³, шт., тыс. руб.) — на м² общей площади; интенсивные (м, мм, %, ед.) — как есть; площадь, отметка и нечисловые — вне модели", () => {
    expect(patternKind({ code: "M-004", unit: "м³", data_type: "number" })).toBe("EXTENSIVE");
    expect(["м²", "м³", "шт.", "кВт", "м³/ч", "л/с", "тыс. руб."].every((unit) => patternKind({ code: "X", unit, data_type: "number" }) === "EXTENSIVE")).toBe(true);
    expect(["м", "мм", "мм²", "%", "ед."].every((unit) => patternKind({ code: "X", unit, data_type: "number" }) === "INTENSIVE")).toBe(true);
    expect(patternKind({ code: AREA_CODE, unit: "м²", data_type: "number" })).toBeNull();
    expect(patternKind({ code: "M-009", unit: "м", data_type: "number" })).toBeNull();
    expect(patternKind({ code: "X", unit: "м", data_type: "string" })).toBeNull();
    expect(patternKind({ code: "X", unit: "Гкал/ч", data_type: "number" })).toBeNull();
    expect([...PARAMS.keys()]).toEqual(["M-004", "M-008", "M-132"]);
    expect(PARAMS.get("M-132")).toEqual({ code: "M-132", name: "Итоговая стоимость по ССР", unit: "тыс. руб.", kind: "EXTENSIVE" });
  });

  it("медиана: нечётное — средний, чётное — среднее двух средних, порядок не важен", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
  });

  it("профиль объекта: экстенсивное делится на площадь (медиана по стадиям), интенсивное — нет; ≤ 0, пустые и чужие коды пропускаются", () => {
    const p = objectProfile([
      { key: AREA_CODE, num: 1000 }, { key: AREA_CODE, num: 1200 }, { key: AREA_CODE, num: 1100 },
      { key: "M-004", num: 3300 }, { key: "M-008", num: 40 }, { key: "M-008", num: 44 }, { key: "M-132", num: 0 }, { key: "M-132", num: null }, { key: "M-999", num: 5 },
    ], PARAMS);
    expect([...p.entries()]).toEqual([["M-004", 3], ["M-008", 42]]);
  });

  it("без общей площади экстенсивный параметр не нормируется и пропускается, интенсивный остаётся", () => {
    expect([...objectProfile([{ key: "M-004", num: 3000 }, { key: "M-008", num: 40 }], PARAMS).keys()]).toEqual(["M-008"]);
    expect([...objectProfile([{ key: AREA_CODE, num: 0 }, { key: "M-004", num: 3000 }], PARAMS).keys()]).toEqual([]);
  });

  it("обучение: медиана и MAD·1,4826 в логарифмах, объём выборки, число объектов", () => {
    const m = fitPatternModel(TIGHT, PARAMS, "CUR");
    const p = m.params.get("M-004")!;
    expect(p.n).toBe(5);
    expect(p.median).toBeCloseTo(Math.log(3), 12);
    expect(p.scale).toBeCloseTo(1.4826 * Math.log(3 / 2.95), 12);
    expect(m.objects).toBe(5);
    expect(m.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("текущий объект не попадает в историю: его записи не меняют модель", () => {
    const self = [obj("CUR", 1000, { "M-004": 100 }), obj("CUR", 1000, { "M-004": 100 })];
    expect(fitPatternModel([...TIGHT, ...self], PARAMS, "CUR")).toEqual(fitPatternModel(TIGHT, PARAMS, "CUR"));
  });

  it("несколько записей одного объекта сводятся к одной точке (медиана), а не размножают объект", () => {
    const m = fitPatternModel([...TIGHT, obj("O0", 1000, { "M-004": 2900 })], PARAMS, "CUR");
    expect(m.params.get("M-004")!.n).toBe(5);
    expect(m.objects).toBe(5);
  });

  it("версия — sha256 версии алгоритма и отсортированных строк «объект, параметр, удельное значение»", () => {
    const lines = ["O0\tM-004\t2.9", "O1\tM-004\t3", "O2\tM-004\t3.1", "O3\tM-004\t2.95", "O4\tM-004\t3.05"].sort();
    expect(fitPatternModel(TIGHT, PARAMS, "CUR").version).toBe(createHash("sha256").update(["ml-pattern/1", ...lines].join("\n")).digest("hex"));
  });

  it("версия модели детерминирована и зависит от обучающей истории", () => {
    const a = fitPatternModel(TIGHT, PARAMS, "CUR").version;
    expect(fitPatternModel([...TIGHT].reverse(), PARAMS, "CUR").version).toBe(a);
    expect(fitPatternModel([...TIGHT.slice(1), obj("O0", 1000, { "M-004": 2901 })], PARAMS, "CUR").version).not.toBe(a);
    expect(fitPatternModel([...TIGHT.slice(1), obj("OX", 1000, { "M-004": 2900 })], PARAMS, "CUR").version).not.toBe(a);
  });

  it("L5 · перестановка истории и порядок фактов не меняют модель (fast-check)", () => {
    const hist = fc.array(
      fc.record({
        id: fc.constantFrom("A", "B", "C", "D", "E", "F", "G"),
        area: fc.option(fc.double({ min: 10, max: 1e5, noNaN: true }), { nil: null }),
        v: fc.double({ min: 1, max: 1e6, noNaN: true }),
        h: fc.double({ min: 1, max: 300, noNaN: true }),
      }),
      { minLength: 0, maxLength: 20 },
    ).map((xs) => xs.map((x) => obj(x.id, x.area, { "M-004": x.v, "M-008": x.h })));
    fc.assert(fc.property(hist.chain((h) => fc.tuple(fc.constant(h), fc.shuffledSubarray(h, { minLength: h.length, maxLength: h.length }))), ([h, shuffled]) => {
      const a = fitPatternModel(h, PARAMS, "CUR");
      const b = fitPatternModel(shuffled.map((o) => ({ ...o, facts: [...o.facts].reverse() })), PARAMS, "CUR");
      expect(b.version).toBe(a.version);
      expect([...b.params.entries()]).toEqual([...a.params.entries()]);
    }), { numRuns: 200 });
  });
});

describe("OS-INSP-3.2.9 гипотеза ML_PATTERN: отклонение ≥ 20 % и робастный z ≥ 3,5", () => {
  it("удельный объём на 20 % ниже медианы при узком разбросе — SUSPICION ML_PATTERN со ссылкой, медианой и объёмом выборки", () => {
    const [s, ...rest] = detect(TIGHT, current(2400));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ discovery_method: "ML_PATTERN", pd_reference: "ПЗ, ред. 1, стр. 004", rd_reference: null, normative_base: null, dedup_key: "PATTERN:M-004:PD", review_priority: "LOW" });
    expect(s.description).toContain("Строительный объем (Общий) (M-004)");
    expect(s.description).toContain("удельное значение 2,4 м³/м² на 20 % ниже медианы 5 объектов (3 м³/м²");
    expect(s.description).toContain("робастный z = −9,0");
    expect(s.description).toContain(`модель паттернов ${fitPatternModel(TIGHT, PARAMS, "CUR").version.slice(0, 12)}).`);
  });

  it("отклонение вверх — «выше медианы»; ссылка РД — в rd_reference, ключ по стадии", () => {
    const [s] = detect(TIGHT, current(3600, 1000, "RD"));
    expect(s.description).toContain("на 20 % выше медианы 5 объектов");
    expect(s.description).toContain("робастный z = +7,3");
    expect(s).toMatchObject({ pd_reference: null, rd_reference: "ПЗ, ред. 1, стр. 004", dedup_key: "PATTERN:M-004:RD" });
  });

  it("значение стадии судится само по себе: соседняя стадия не смешивается с ним, а площадь берётся со всех стадий", () => {
    const r = detect(TIGHT, [fact(AREA_CODE, 1000, "RD"), fact("M-004", 2400, "PD"), fact("M-004", 3000, "RD"), fact("M-004", 3000, "ID")]);
    expect(r.map((s) => s.dedup_key)).toEqual(["PATTERN:M-004:PD"]);
  });

  it("модель обучена на параметре, которого нет в переданных параметрах, — гипотезы нет", () => {
    const model = fitPatternModel(TIGHT, PARAMS, "CUR");
    expect(detectAnomalies(model, current(100), new Map())).toEqual([]);
  });

  it("стадия ИД — без ссылок ПД и РД", () => {
    expect(detect(TIGHT, current(2400, 1000, "ID"))[0]).toMatchObject({ pd_reference: null, rd_reference: null, dedup_key: "PATTERN:M-004:ID" });
  });

  it("−19 % при большом z — нет гипотезы (порог отклонения)", () => {
    expect(detect(TIGHT, current(2430))).toEqual([]);
    expect(detect(TIGHT, current(3570))).toEqual([]);
  });

  it("z < 3,5 при отклонении ≥ 20 % — нет гипотезы; z > 3,5 — есть (порог робастного z)", () => {
    const p = fitPatternModel(WIDE, PARAMS, "CUR").params.get("M-004")!;
    const at = (z: number) => Math.exp(p.median + z * p.scale) * 1000;
    expect(detect(WIDE, current(at(-3.49)))).toEqual([]);
    expect(detect(WIDE, current(at(3.49)))).toEqual([]);
    expect(detect(WIDE, current(at(-3.51)))).toHaveLength(1);
    expect(detect(WIDE, current(at(3.51)))).toHaveLength(1);
    expect(detect(WIDE, current(at(-3.5)))).toHaveLength(1);
  });

  it("робастный z Иглевича–Хоаглина: (x − медиана) / (1,4826·MAD)", () => {
    expect(robustZ(5, 1, 2)).toBe(2);
    expect(robustZ(-3, 1, 2)).toBe(-2);
  });

  it("нормировка на площадь: вдвое больший объект с тем же удельным объёмом — не аномалия", () => {
    const hist = [1000, 2000, 3000, 4000, 5000].map((a, i) => obj(`A${i}`, a, { "M-004": a * [2.9, 3, 3.1, 2.95, 3.05][i] }));
    expect(detect(hist, current(15000, 5000))).toEqual([]);
    expect(detect(hist, current(12000, 5000))).toHaveLength(1);
    expect(detect(hist, [fact("M-004", 12000)])).toEqual([]); // без площади текущего объекта удельного значения нет
  });

  it("интенсивный параметр (высота, м) сравнивается как есть, без деления на площадь", () => {
    const hist = [40, 41, 42, 43, 44].map((h, i) => obj(`H${i}`, 1000 * (i + 1), { "M-008": h }));
    const [s] = detect(hist, [fact("M-008", 30)]);
    expect(s.description).toContain("Высота здания (M-008): значение 30 м на 29 % ниже медианы 5 объектов (42 м;");
    expect(detect(hist, [fact(AREA_CODE, 10), fact("M-008", 42)])).toEqual([]);
  });

  it("уверенность растёт с |z| и не выше 0,95; приоритет — по величине отклонения", () => {
    const [a] = detect(TIGHT, current(2400));
    const [b] = detect(TIGHT, current(1500));
    const [c] = detect(TIGHT, current(100));
    expect(a.confidence).toBeGreaterThanOrEqual(0.5);
    expect(b.confidence).toBeGreaterThan(a.confidence);
    expect(c.confidence).toBeGreaterThan(b.confidence);
    expect(c.confidence).toBeLessThanOrEqual(0.95);
    expect(a.confidence).toBe(0.77);
    expect([a.review_priority, b.review_priority, c.review_priority]).toEqual(["LOW", "HIGH", "HIGH"]);
    expect(detect(TIGHT, current(2100))[0].review_priority).toBe("MEDIUM");
    expect(detect(TIGHT, current(2090))[0].review_priority).toBe("MEDIUM");
    expect(detect(TIGHT, current(1510))[0].review_priority).toBe("MEDIUM");
    expect(detect(TIGHT, current(4500))[0].review_priority).toBe("HIGH");
  });

  it("уверенность у порога z = 3,5 — 0,5", () => {
    const p = fitPatternModel(WIDE, PARAMS, "CUR").params.get("M-004")!;
    expect(detect(WIDE, current(Math.exp(p.median - 3.5 * p.scale) * 1000))[0].confidence).toBe(0.5);
  });

  it("значение ≤ 0, пустое значение и параметр вне модели — без гипотезы", () => {
    const hist = TIGHT.map((o, i) => ({ ...o, facts: [...o.facts, { key: "M-008", num: 40 + i }] }));
    expect(detect(hist, [fact(AREA_CODE, 1000), fact("M-004", 0), fact("M-004", null), fact("M-008", -5), fact("M-999", 1)])).toEqual([]);
  });

  it("числа в описании: дробные — с запятой, до трёх значащих цифр", () => {
    const hist = [2.9, 3, 3.1, 2.95, 3.05].map((v, i) => obj(`S${i}`, 1000, { "M-132": v * 12.345 }));
    const [s] = detect(hist, [fact(AREA_CODE, 1000), fact("M-132", 3 * 12.345 * 0.5)]);
    expect(s.description).toContain("удельное значение 0,0185 тыс. руб./м² на 50 % ниже медианы 5 объектов (0,037 тыс. руб./м²");
  });
});

describe("OS-INSP-3.2.10 мало истории или нулевой разброс — гипотезы нет", () => {
  it("меньше 5 объектов — нет гипотезы; ровно 5 — есть", () => {
    expect(detect(TIGHT.slice(0, 4), current(1000))).toEqual([]);
    expect(detect(TIGHT, current(1000))).toHaveLength(1);
  });

  it("нулевой разброс (MAD = 0) — нет гипотезы даже при сильном отклонении", () => {
    const flat = [3000, 3000, 3000, 3100, 2900].map((v, i) => obj(`F${i}`, 1000, { "M-004": v }));
    expect(fitPatternModel(flat, PARAMS, "CUR").params.get("M-004")!.scale).toBe(0);
    expect(detect(flat, current(1000))).toEqual([]);
  });

  it("canJudge: n ≥ 5 и разброс > 0", () => {
    expect(canJudge({ code: "X", median: 0, scale: 0.1, n: 5 })).toBe(true);
    expect(canJudge({ code: "X", median: 0, scale: 0.1, n: 4 })).toBe(false);
    expect(canJudge({ code: "X", median: 0, scale: 0, n: 50 })).toBe(false);
  });

  it("пустая история — пустая модель, гипотез нет", () => {
    const m = fitPatternModel([], PARAMS, "CUR");
    expect(m.objects).toBe(0);
    expect(m.params.size).toBe(0);
    expect(detectAnomalies(m, current(1), PARAMS)).toEqual([]);
  });
});
