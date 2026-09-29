// Эшелоны: L1 (правила М-001), L3 (граница допуска 0,05 м²), L5 (fast-check: инварианты сравнения),
// L6 (ловушки реальных пакетов: два проекта в ПД, РД без показателя, колонки таблицы, «до реконструкции»).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-132. Значения синтетические (ADR-0002).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateQuantityParam, fmtNum, needOf, pickQuantity, quantityConflict, valueList, type QuantityMention, type QuantityPassport } from "../src/domain/quantity-param.ts";
import { passports } from "../src/services/passports.ts";
import { extractorSpec, quantityPassport } from "../src/domain/passport.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const PASS: QuantityPassport = {
  unit: "м²",
  tolerance: 0.05,
  tolerance_pct: 0,
  direction: "both",
  sources: {
    PD: [{ discipline: "ПЗУ", label: "ТЭП в ПЗУ — источник Матрицы" }, { discipline: "ПЗ" }, { discipline: "АР" }, { discipline: "*" }],
    RD: [{ discipline: "ГП", label: "Генеральный план, «Общие данные», таблица ТЭП — источник Матрицы" }, { discipline: "АР" }, { discipline: "*" }],
    ID: [{ discipline: "*", label: "Технический план БТИ — источник Матрицы" }],
  },
  link: "base_cipher",
};
const PARAM: Param = {
  code: "M-001",
  section: "ПЗ",
  parameter_name: "Площадь застройки",
  unit: "м²",
  source_pd: "Раздел ПЗУ: Таблица ТЭП",
  source_rd: "Раздел ПП (ГП): Лист \"Общие данные\", Таблица ТЭП",
  source_id: "Технический план БТИ; Акт выноса осей",
  trigger_logic: "Расхождение контуров здания на генплане с данными БТИ или РД > 0.",
  review_priority: "HIGH",
  data_type: "number",
  compare: { kind: "delta_pct", tolerance: 0 },
  anchors: ["Площадь застройки"],
  regex_pattern: null,
  value_scale: null,
  applicability: null,
  is_active: true,
};

let seq = 0;
const Q = (stage: Stage, num: number, over: Partial<QuantityMention> = {}): QuantityMention => ({
  stage,
  file_id: `f${++seq}`,
  sha256: "a".repeat(64),
  document_code: over.document_code ?? `П-100-${over.discipline ?? "ПЗ"}`,
  revision: "1",
  approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION",
  role: "CURRENT",
  discipline: "ПЗ",
  base: "100",
  num,
  excluded: null,
  excluded_why: null,
  page: 10,
  bbox: [0.1, 0.1, 0.2, 0.12],
  quote: `Площадь застройки ${num}`,
  confidence: 1,
  source: "pdf-text",
  ...over,
});
const ALL: Stage[] = ["PD", "RD", "ID"];
const run = (mentions: QuantityMention[], loaded: Stage[] = ALL, kit = new Set(["100"])) =>
  evaluateQuantityParam({ param: PARAM, passport: PASS, mentions, loadedStages: loaded, profile: {}, kitBases: kit });

describe("М-001: сравнение стадий (OS-INSP-3.1.20)", () => {
  it("ПД и РД совпали в пределах точности ТЭП — NEGATIVE_VERIFIED с фрагментами обеих стадий", () => {
    const ev = run([Q("PD", 3009.4, { discipline: "ПЗУ" }), Q("RD", 3009.4, { discipline: "ГП", document_code: "Р-100-ГП1" })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.fragments.map((f) => [f.stage, f.kind, f.value])).toEqual([["PD", "expected", "3009,4"], ["RD", "actual", "3009,4"]]);
  });
  it("РД отличается больше допуска — CANDIDATE с разницей в м² и процентах", () => {
    const ev = run([Q("PD", 943, { discipline: "ПЗУ", page: 9 }), Q("RD", 1471.13, { discipline: "ГП", page: 3, document_code: "Р-100-ГП1" })]);
    expect(ev.status).toBe("CANDIDATE");
    expect([ev.expected, ev.actual, ev.delta]).toEqual(["943", "1471,13", "+528,13 м² (+56,0 %)"]);
    expect(ev.reason).toContain("РД (ГП, стр. 3) больше ПД (ПЗУ, стр. 9) на 528,13 м² — допуск ±0,05 м².");
    expect(ev.reason).toContain("Правило Матрицы: ");
  });
  it("граница допуска: 0,05 м² — совпадение, 0,06 м² — кандидат", () => {
    expect(run([Q("PD", 100), Q("RD", 100.05)]).status).toBe("NEGATIVE_VERIFIED");
    expect(run([Q("PD", 100), Q("RD", 100.06)]).status).toBe("CANDIDATE");
  });
  it("худшая из поздних стадий становится фактическим значением", () => {
    const ev = run([Q("PD", 100), Q("RD", 101), Q("ID", 90)]);
    expect([ev.status, ev.actual]).toEqual(["CANDIDATE", "90"]);
  });
  it("свойство: равные значения никогда не дают кандидата; отклонение больше допуска — всегда кандидат", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 6, max: 100_000 }), (a, d) => {
        const v = a / 10;
        expect(run([Q("PD", v), Q("RD", v)]).status).toBe("NEGATIVE_VERIFIED");
        expect(run([Q("PD", v), Q("RD", v + d / 100)]).status).toBe("CANDIDATE");
      }),
    );
  });
});

describe("М-001: нет второй стадии (OS-INSP-3.1.20, GTE-02)", () => {
  it("показателя нет в РД — MISSING_EVIDENCE: причина называет значение ПД с разделами и чего не хватает", () => {
    const ev = run([Q("PD", 3009.4, { discipline: "ПЗУ", page: 11 }), Q("PD", 3009.4, { discipline: "ПЗ", page: 10 }), Q("PD", 3009.4, { discipline: "АР", page: 10 })], ["PD", "RD"]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.expected).toBe("3009,4");
    expect(ev.reason).toContain("ПД — 3009,4 м² (ПЗУ — 3009,4 (стр. 11); ПЗ — 3009,4 (стр. 10); АР — 3009,4 (стр. 10))");
    expect(ev.reason).toContain("РД: генеральный план, «Общие данные», таблица ТЭП — показателя нет");
    expect(ev.reason).toContain("ИД: технический план БТИ — стадия не загружена");
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected"]);
    expect(ev.suspicions).toEqual([]);
  });
  it("значения нет нигде — MISSING_EVIDENCE без фрагментов", () => {
    const ev = run([], ["PD"]);
    expect([ev.status, ev.fragments.length]).toEqual(["MISSING_EVIDENCE", 0]);
    expect(ev.reason).toContain("значение не найдено");
  });
});

describe("М-001: выбор значения стадии и комплект (OS-INSP-3.1.18)", () => {
  it("значение стадии — из раздела с высшим приоритетом паспорта: ПЗУ раньше ПЗ и АР", () => {
    const pk = pickQuantity([Q("PD", 1, { discipline: "АР" }), Q("PD", 1, { discipline: "ПЗ" }), Q("PD", 1, { discipline: "ПЗУ" })], "PD", PASS, new Set(["100"]));
    expect(pk.chosen!.discipline).toBe("ПЗУ");
    expect(pk.considered.map((m) => m.discipline)).toEqual(["ПЗУ", "ПЗ", "АР"]);
  });
  it("ПД другого проекта (шифр не как у РД пакета) — справочно, даже когда в РД показателя нет", () => {
    const old = Q("PD", 2909.5, { base: "ЖС-270121", discipline: "ПЗ", document_code: "ЖС-270121-П-ОПЗ" });
    const ev = run([Q("PD", 3009.4, { discipline: "ПЗУ" }), old], ["PD", "RD"]);
    expect(ev.suspicions).toEqual([]); // 2909,5 из проекта 2024 не противоречие проекту 2025
    const p = ev.provenance.mentions.find((m) => m.document_code === "ЖС-270121-П-ОПЗ")!;
    expect([p.use, p.value]).toEqual(["reference", "2909,5 м²"]);
    expect(p.why).toContain("другой комплект");
  });
  it("комплект ПД с шифром РД в пакете есть, а показателя в нём нет — значение другого проекта только справочно", () => {
    const old = Q("PD", 5559.7, { base: "ЖС-270121", discipline: "ЭЭ", document_code: "ЖС-270121-П-ЭЭ", page: 48 });
    const ev = evaluateQuantityParam({ param: PARAM, passport: PASS, mentions: [old], loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set(["100"]), pdKitPresent: true });
    expect([ev.status, ev.expected, ev.fragments.length]).toEqual(["MISSING_EVIDENCE", null, 0]);
    expect(ev.reason).toContain("в комплекте ПД, связанном с РД, показателя нет; в другом комплекте — ЭЭ — 5559,7 (стр. 48) (справочно)");
    expect(ev.provenance.mentions[0].use).toBe("reference");
  });
  it("комплект ПД не связан с РД — берутся все упоминания ПД с пометкой", () => {
    const pk = pickQuantity([Q("PD", 5, { base: "X" })], "PD", PASS, new Set(["100"]));
    expect(pk.chosen!.num).toBe(5);
    expect(pk.note).toContain("не связан");
  });
  it("отсеянное правилами и устаревшая редакция — не значение стадии, но видны в карточке с причиной", () => {
    const ev = run(
      [
        Q("PD", 1562.6, { excluded: "EXISTING", excluded_why: "до реконструкции" }),
        Q("PD", 2362.5, { excluded: "MULTI_VALUE", excluded_why: "колонки таблицы" }),
        Q("PD", 1, { role: "SUPERSEDED" }),
        Q("PD", 3009.4, { discipline: "ПЗУ" }),
      ],
      ["PD"],
    );
    expect(ev.expected).toBe("3009,4");
    const byUse = ev.provenance.mentions.map((m) => [m.value, m.use, m.why]);
    expect(byUse).toContainEqual(["1562,6 м²", "dropped", "до реконструкции"]);
    expect(byUse).toContainEqual(["2362,5 м²", "dropped", "колонки таблицы"]);
    expect(byUse).toContainEqual(["1 м²", "dropped", "устаревшая редакция"]);
    expect(ev.provenance.ops).toContain("CMP-01");
  });
  it("редакция не определена — CLARIFICATION_REQUIRED", () => {
    expect(run([Q("PD", 1, { role: "CONFLICT" }), Q("RD", 1)]).status).toBe("CLARIFICATION_REQUIRED");
  });
  it("параметр неприменим к объекту — NOT_APPLICABLE", () => {
    const ev = evaluateQuantityParam({ param: { ...PARAM, applicability: "underground" }, passport: PASS, mentions: [Q("PD", 1)], loadedStages: ALL, profile: { underground: false }, kitBases: new Set() });
    expect(ev.status).toBe("NOT_APPLICABLE");
  });
});

describe("М-001: противоречие внутри стадии (OS-INSP-3.1.19)", () => {
  it("разделы ПД называют разные площади — гипотеза с каждым разделом и страницами", () => {
    const ms = [Q("PD", 3009.4, { discipline: "ПЗУ", page: 11 }), Q("PD", 2909.5, { discipline: "ПЗ", page: 16 }), Q("PD", 2909.5, { discipline: "ПЗ", page: 18 })];
    const s = quantityConflict(pickQuantity(ms, "PD", PASS, new Set(["100"])), "PD", PASS)!;
    expect(s.description).toBe("Внутреннее противоречие ПД: значение указано по-разному — ПЗУ — 3009,4 (стр. 11); ПЗ — 2909,5 (стр. 16, 18)");
    expect(s.dedup_key.startsWith("quantity-conflict:PD:")).toBe(true);
  });
  it("разница в пределах допуска — не противоречие", () => {
    expect(quantityConflict(pickQuantity([Q("PD", 3009.4), Q("PD", 3009.42)], "PD", PASS, new Set(["100"])), "PD", PASS)).toBeNull();
  });
});

describe("М-001: паспорт и формат (OS-INSP-2.2.22, 7.1.3)", () => {
  it("паспорт М-001 читается схемой, даёт количественную конфигурацию и спецификацию экстрактора", () => {
    const pp = passports().byCode.get("M-001")!;
    expect(quantityPassport(pp)).toMatchObject({ unit: "м²", tolerance: 0.05, tolerance_pct: 0, direction: "both", link: "base_cipher" });
    expect(extractorSpec(pp)).toMatchObject({ kind: "quantity_mentions", superscripts: ["2"] });
    expect(extractorSpec(pp)).not.toHaveProperty("scale");
  });
  it("число по-русски и перечень значений", () => {
    expect([fmtNum(3009.4), fmtNum(1471.13), fmtNum(943)]).toEqual(["3009,4", "1471,13", "943"]);
    expect(valueList([Q("PD", 1, { discipline: "ПЗУ", page: 2 }), Q("PD", 1, { discipline: "ПЗУ", page: 5 })])).toBe("ПЗУ — 1 (стр. 2, 5)");
  });
});

describe("М-002…М-005: правила сравнения из паспорта (OS-INSP-3.1.20, T-132)", () => {
  const evalWith = (over: Partial<QuantityPassport>, pd: number, rd: number) =>
    evaluateQuantityParam({ param: PARAM, passport: { ...PASS, ...over }, mentions: [Q("PD", pd), Q("RD", rd)], loadedStages: ALL, profile: {}, kitBases: new Set(["100"]) });
  it("М-002: отклонение в пределах 1 % — NEGATIVE_VERIFIED, больше 1 % — CANDIDATE", () => {
    expect(evalWith({ tolerance_pct: 1 }, 5825.8, 5880).status).toBe("NEGATIVE_VERIFIED");
    expect(evalWith({ tolerance_pct: 1 }, 5825.8, 5900).status).toBe("CANDIDATE");
    expect(evalWith({ tolerance_pct: 1 }, 5825.8, 5880).reason).toContain("в пределах 1 %");
  });
  it("М-003: нарушение — только уменьшение; рост полезной площади не кандидат", () => {
    expect(evalWith({ direction: "decrease" }, 5559.7, 5400).status).toBe("CANDIDATE");
    expect(evalWith({ direction: "decrease" }, 5559.7, 5700).status).toBe("NEGATIVE_VERIFIED");
  });
  it("паспорта М-002…М-005 читаются схемой и дают свои правила", () => {
    const qp = (c: string) => quantityPassport(passports().byCode.get(c)!)!;
    expect([qp("M-002").tolerance_pct, qp("M-003").direction, qp("M-004").unit, qp("M-005").unit]).toEqual([1, "decrease", "м³", "м³"]);
  });
});

describe("М-001…М-005: формулировки причин и ключ гипотезы (T-132, мутанты Stryker)", () => {
  const ev = (over: Partial<QuantityPassport>, pd: number, rd: number) =>
    evaluateQuantityParam({ param: PARAM, passport: { ...PASS, ...over }, mentions: [Q("PD", pd, { discipline: "ПЗУ", page: 9 }), Q("RD", rd, { discipline: "ГП", page: 3 })], loadedStages: ALL, profile: {}, kitBases: new Set(["100"]) });
  it("причины «расхождения нет» — дословно по виду правила", () => {
    expect(ev({}, 100, 100).reason).toBe("Площадь застройки: совпало в пределах точности ТЭП (±0,05 м²)");
    expect(ev({ tolerance_pct: 1 }, 100, 100.5).reason).toBe("Площадь застройки: отклонение в пределах 1 %");
    expect(ev({ direction: "decrease" }, 100, 120).reason).toBe("Площадь застройки: не уменьшилось больше чем на 0,05 м². Изменение в лучшую сторону (CMP-03, BETTER): РД 120 против ПД 100 — не нарушение, зафиксировано для инспектора.");
    expect(ev({ direction: "decrease" }, 100, 100.04).reason).toBe("Площадь застройки: не уменьшилось больше чем на 0,05 м²");
  });
  it("кандидат: знак и проценты разницы, «меньше» при уменьшении", () => {
    const e = ev({}, 200, 150);
    expect(e.delta).toBe("-50 м² (-25,0 %)");
    expect(e.reason?.startsWith("РД (ГП, стр. 3) меньше ПД (ПЗУ, стр. 9) на 50 м² — допуск ±0,05 м². Правило Матрицы: ")).toBe(true);
    expect(ev({}, 100, 130).delta).toBe("+30 м² (+30,0 %)");
  });
  it("худшая стадия — с наибольшим отклонением, а не последняя", () => {
    const e = evaluateQuantityParam({ param: PARAM, passport: PASS, mentions: [Q("PD", 100), Q("RD", 150), Q("ID", 110)], loadedStages: ALL, profile: {}, kitBases: new Set(["100"]) });
    expect([e.actual, e.delta]).toEqual(["150", "+50 м² (+50,0 %)"]);
  });
  it("неприменимость и редакция — точный текст", () => {
    const na = evaluateQuantityParam({ param: { ...PARAM, applicability: "underground" }, passport: PASS, mentions: [], loadedStages: ALL, profile: { underground: false }, kitBases: new Set() });
    expect(na.reason).toBe("Неприменим к объекту: underground");
    const cl = evaluateQuantityParam({ param: PARAM, passport: PASS, mentions: [Q("PD", 1, { role: "CONFLICT", document_code: "П-1-ПЗ", revision: "2" }), Q("RD", 1)], loadedStages: ALL, profile: {}, kitBases: new Set(["100"]) });
    expect(cl.reason).toBe("Не определена актуальная редакция: П-1-ПЗ ред. 2");
    expect(cl.fragments.map((f) => f.kind)).toEqual(["actual"]);
  });
  it("ключ гипотезы: по первому упоминанию каждого значения, упорядоченно; повтор страницы не дублируется", () => {
    const a = Q("PD", 10, { file_id: "fa", page: 2, discipline: "ПЗУ" });
    const b = Q("PD", 20, { file_id: "fb", page: 5, discipline: "ПЗ" });
    const c = Q("PD", 20, { file_id: "fc", page: 7, discipline: "ПЗ" });
    const s = quantityConflict(pickQuantity([b, a, c], "PD", PASS, new Set(["100"])), "PD", PASS)!;
    expect(s.dedup_key).toBe("quantity-conflict:PD:fa@2:10|fb@5:20");
    expect(valueList([a, a])).toBe("ПЗУ — 10 (стр. 2)");
  });
  it("порядок значения стадии: при равном разделе — актуальная редакция, затем уверенность", () => {
    const low = Q("PD", 1, { confidence: 0.5, file_id: "a" });
    const high = Q("PD", 2, { confidence: 0.9, file_id: "b" });
    expect(pickQuantity([low, high], "PD", PASS, new Set(["100"])).chosen!.num).toBe(2);
  });
  it("без подписи источника в паспорте — «источник стадии»; без чего запросить — причина без «Запросите»", () => {
    const bare = { ...PASS, sources: { PD: [], RD: [], ID: [] } } as QuantityPassport;
    expect(needOf(bare, "RD")).toBe("источник стадии");
    const only = evaluateQuantityParam({ param: { ...PARAM, source_rd: "—", source_id: "—" }, passport: PASS, mentions: [Q("PD", 5)], loadedStages: ["PD"], profile: {}, kitBases: new Set(["100"]) });
    expect(only.reason).toBe("Сравнить не с чем: ПД — 5 м² (ПЗ — 5 (стр. 10)).");
  });
});
