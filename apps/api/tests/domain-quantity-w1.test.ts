// Эшелоны: L1 (правила T-173), L3 (границы допуска, нормы, масштаба единиц), L5 (fast-check: направление и норма),
// L6 (ловушки: с НДС против без НДС, руб. против тыс. руб., улучшение не нарушение, ПД сам нарушает норму).
// Расширения движка количества W1 (T-173): direction increase (CMP-03), BETTER в карточке, CMP-06 против нормы,
// варианты показателя, страж масштаба единиц (VER-13), аспекты параметра (CMP-18). Значения синтетические (ADR-0002).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { better, breaks, evaluateQuantityParam, normBreaks, normOf, quantityOps, scaleMismatch, selectVariant, type QuantityMention, type QuantityPassport } from "../src/domain/quantity-param.ts";
import { passports } from "../src/services/passports.ts";
import { ParamPassport, quantityPassport, sourceDocTypes } from "../src/domain/passport.ts";
import { isSourceFor } from "../src/domain/doctype.ts";
import { quantityMeta } from "../src/services/inspections.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const SOURCES: QuantityPassport["sources"] = {
  PD: [{ discipline: "ПЗ", label: "Пояснительная записка, ТЭП — источник Матрицы" }, { discipline: "*" }],
  RD: [{ discipline: "АР", label: "«Общие данные» АР — источник Матрицы" }, { discipline: "*" }],
  ID: [{ discipline: "*", label: "Исполнительная съёмка — источник Матрицы" }],
};
const P = (over: Partial<QuantityPassport> = {}): QuantityPassport => ({ unit: "м", tolerance: 0.005, tolerance_pct: 0, direction: "both", sources: SOURCES, link: "base_cipher", ...over });
const PARAM = (over: Partial<Param> = {}): Param => ({
  code: "M-008", section: "ПЗ", parameter_name: "Высота здания", unit: "м", source_pd: "ПЗ: ТЭП", source_rd: "АР: разрезы", source_id: "Съёмка",
  trigger_logic: "Увеличение высоты здания в РД.", review_priority: "HIGH", data_type: "number", compare: { kind: "increase" }, anchors: ["Высота здания"],
  regex_pattern: null, value_scale: null, applicability: null, is_active: true, ...over,
});

let seq = 0;
const Q = (stage: Stage, num: number, over: Partial<QuantityMention> = {}): QuantityMention => ({
  stage, file_id: `f${++seq}`, sha256: "a".repeat(64), document_code: `${stage === "PD" ? "П" : "Р"}-100-${over.discipline ?? (stage === "PD" ? "ПЗ" : "АР")}`, revision: "1",
  approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role: "CURRENT", discipline: stage === "PD" ? "ПЗ" : "АР", base: "100", num, excluded: null, excluded_why: null,
  page: 3, bbox: [0.1, 0.1, 0.2, 0.12], quote: `значение ${num}`, confidence: 1, source: "pdf-text", ...over,
});
const ALL: Stage[] = ["PD", "RD", "ID"];
const run = (passport: QuantityPassport, mentions: QuantityMention[], param = PARAM()) =>
  evaluateQuantityParam({ param, passport, mentions, loadedStages: ALL, profile: {}, kitBases: new Set(["100"]) });

describe("CMP-03: направление «рост — нарушение» и улучшение в карточке (OS-INSP-3.1.40)", () => {
  const H = P({ direction: "increase" });
  it("рост высоты больше допуска — CANDIDATE с «больше» и допуском на увеличение", () => {
    const ev = run(H, [Q("PD", 68.41), Q("RD", 69.2)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("РД (АР, стр. 3) больше ПД (ПЗ, стр. 3) на 0,79 м — допуск на увеличение ±0,005 м.");
    expect(ev.delta).toBe("+0,79 м (+1,2 %)");
  });
  it("снижение высоты — не нарушение, но улучшение (BETTER) названо в причине", () => {
    const ev = run(H, [Q("PD", 68.41), Q("RD", 65)]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toBe("Высота здания: не увеличилось больше чем на 0,005 м. Изменение в лучшую сторону (CMP-03, BETTER): РД 65 против ПД 68,41 — не нарушение, зафиксировано для инспектора.");
  });
  it("граница: +0,005 м — совпадение, +0,006 м — кандидат", () => {
    expect(run(H, [Q("PD", 68.41), Q("RD", 68.415)]).status).toBe("NEGATIVE_VERIFIED");
    expect(run(H, [Q("PD", 68.41), Q("RD", 68.416)]).status).toBe("CANDIDATE");
  });
  it("breaks и better по видам направления", () => {
    expect(breaks(H, 10, 10.1)).toBe(true);
    expect(breaks(H, 10, 9)).toBe(false);
    expect(better(H, 10, 9)).toBe(true);
    expect(better(H, 10, 10.004)).toBe(false);
    const D = P({ direction: "decrease", tolerance: 0.5 });
    expect(breaks(D, 100, 99)).toBe(true);
    expect(better(D, 100, 101)).toBe(true);
    expect(better(D, 100, 100.4)).toBe(false);
    // «любое изменение»: улучшения нет, пока не задано плохое направление; с bad_direction — есть
    expect(better(P(), 10, 9)).toBe(false);
    expect(better(P({ bad_direction: "up" }), 10, 9)).toBe(true);
    expect(better(P({ bad_direction: "up" }), 10, 11)).toBe(false);
    expect(better(P({ bad_direction: "down" }), 10, 11)).toBe(true);
  });
  it("«любое изменение» с плохим направлением: кандидат в обе стороны, причина называет, в какую сторону хуже", () => {
    const V = P({ unit: "м³", tolerance: 0.05, bad_direction: "up" });
    const up = run(V, [Q("PD", 37076), Q("RD", 38000)], PARAM({ parameter_name: "Строительный объем (Общий)", compare: { kind: "equal" }, trigger_logic: "Изменение." }));
    expect(up.status).toBe("CANDIDATE");
    expect(up.reason).toContain("в плохую сторону (CMP-03, WORSE)");
    const down = run(V, [Q("PD", 37076), Q("RD", 36000)], PARAM({ parameter_name: "Строительный объем (Общий)", compare: { kind: "equal" }, trigger_logic: "Изменение." }));
    expect(down.status).toBe("CANDIDATE");
    expect(down.reason).toContain("в лучшую сторону (CMP-03, BETTER)");
  });
  it("свойство: при росте — кандидат ровно когда рост больше допуска; снижение никогда не кандидат", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 200000 }), fc.integer({ min: -3000, max: 3000 }), (a, d) => {
        const ref = a / 1000;
        const v = (a + d) / 1000;
        const ev = run(H, [Q("PD", ref), Q("RD", v)]);
        expect(ev.status).toBe(d > 5 ? "CANDIDATE" : "NEGATIVE_VERIFIED");
      }),
    );
  });
});

describe("CMP-06: одна стадия против нормы (OS-INSP-3.1.41)", () => {
  const KZ = P({ unit: "%", tolerance: 0.05, direction: "increase", norm: { kind: "max", value: null, basis: "ГПЗУ, предельный процент застройки" } });
  const param = PARAM({ code: "M-019", parameter_name: "Коэффициент застройки (КЗ)", unit: "%", trigger_logic: "Превышение КЗ над предельным значением." });
  it("РД уменьшил КЗ (лучше), но выше предела ГПЗУ из документа — CANDIDATE, эталон в карточке — норма", () => {
    const ev = run(KZ, [Q("PD", 70), Q("PD", 60, { limit: true, page: 2 }), Q("RD", 65)], param);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("≤ 60 % (ГПЗУ, предельный процент застройки; ПЗ, стр. 2)");
    expect(ev.actual).toBe("70");
    expect(ev.reason).toBe("Норма нарушена (CMP-06): ПД (ПЗ, стр. 3) — 70 %, РД (АР, стр. 3) — 65 % при пределе ≤ 60 % (ГПЗУ, предельный процент застройки; ПЗ, стр. 2). Правило Матрицы: Превышение КЗ над предельным значением.");
    expect(ev.fragments.map((f) => f.kind)).toEqual(["expected", "actual", "actual"]);
  });
  it("норма без документа — из паспорта; значение в пределах — между стадиями решает CMP-03", () => {
    const S = P({ ...KZ, norm: { kind: "max", value: 60, basis: "паспорт: предельный КЗ" } });
    const ok = run(S, [Q("PD", 40), Q("RD", 40)], param);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(ok.reason).toBe("Коэффициент застройки (КЗ): не увеличилось больше чем на 0,05 %. Норма соблюдена (CMP-06): ≤ 60 % (паспорт: предельный КЗ).");
    expect(run(S, [Q("PD", 40), Q("RD", 60.05)], param).status).toBe("CANDIDATE");
  });
  it("граница нормы: 60,05 при пределе 60 — в допуске, 60,06 — нарушение", () => {
    const S = P({ ...KZ, direction: "both", tolerance: 0.05, norm: { kind: "max", value: 60, basis: "б" } });
    expect(run(S, [Q("PD", 60.05), Q("RD", 60.05)], param).status).toBe("NEGATIVE_VERIFIED");
    expect(run(S, [Q("PD", 60.06), Q("RD", 60.06)], param).status).toBe("CANDIDATE");
    expect(normBreaks({ kind: "max", value: 60, basis: "" }, 60.06, 0.05)).toBe(true);
    expect(normBreaks({ kind: "max", value: 60, basis: "" }, 60.05, 0.05)).toBe(false);
    expect(normBreaks({ kind: "min", value: 60, basis: "" }, 59.94, 0.05)).toBe(true);
    expect(normBreaks({ kind: "min", value: 60, basis: "" }, 59.95, 0.05)).toBe(false);
  });
  it("одна стадия: значение нарушает норму — CANDIDATE без второй стадии; не нарушает — MISSING_EVIDENCE", () => {
    const S = P({ ...KZ, norm: { kind: "min", value: 30, basis: "норма озеленения" } });
    const bad = run(S, [Q("RD", 25)], param);
    expect(bad.status).toBe("CANDIDATE");
    expect(bad.expected).toBe("≥ 30 % (норма озеленения)");
    expect(run(S, [Q("RD", 35)], param).status).toBe("MISSING_EVIDENCE");
  });
  it("предел из документа важнее паспорта; из нескольких — ранняя стадия и приоритет раздела", () => {
    const S = P({ ...KZ, norm: { kind: "max", value: 80, basis: "паспорт" } });
    const ev = run(S, [Q("PD", 55), Q("RD", 55), Q("RD", 70, { limit: true }), Q("PD", 50, { limit: true, discipline: "ГП", page: 7 })], param);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("≤ 50 % (паспорт; ГП, стр. 7)");
  });
  it("предельное значение не становится значением стадии", () => {
    const ev = run(KZ, [Q("PD", 40), Q("RD", 60, { limit: true })], param);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.stage_notes.RD).toBe("NO_VALUE");
  });
  it("свойство: значение выше предела больше допуска — всегда CANDIDATE", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 900 }), fc.integer({ min: 1, max: 300 }), (lim, over) => {
        const S = P({ ...KZ, direction: "both", norm: { kind: "max", value: lim / 10, basis: "б" } });
        const v = (lim + over) / 10;
        expect(run(S, [Q("PD", v), Q("RD", v)], param).status).toBe(over > 0.5 ? "CANDIDATE" : "NEGATIVE_VERIFIED");
      }),
    );
  });
});

describe("Варианты показателя: с НДС и без НДС — разные показатели (OS-INSP-3.1.42)", () => {
  const SSR = P({ unit: "тыс. руб.", tolerance: 0.005, tolerance_pct: 5, direction: "increase", variants: [{ code: "vat_incl", title: "с НДС" }, { code: "vat_excl", title: "без НДС" }] });
  const param = PARAM({ code: "M-132", parameter_name: "Итоговая стоимость по ССР", unit: "тыс. руб.", trigger_logic: "Превышение > 5%." });
  it("ПД с НДС и без НДС, РД только без НДС — сравнение по варианту «без НДС»", () => {
    const ev = run(SSR, [Q("PD", 1200, { variant: "vat_incl" }), Q("PD", 1000, { variant: "vat_excl" }), Q("RD", 1040, { variant: "vat_excl" })], param);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.expected).toBe("1000");
    expect(ev.reason).toContain("вариант показателя — без НДС");
  });
  it("ПД с НДС, РД без НДС — общего варианта нет: NOT_COMPARABLE, а не превышение на НДС", () => {
    const ev = run(SSR, [Q("PD", 1000, { variant: "vat_excl" }), Q("RD", 1200, { variant: "vat_incl" })], param);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Варианты показателя в стадиях разные — ПД: без НДС; РД: с НДС. Сравнивается только одинаковый вариант. Запросите значение того же варианта.");
  });
  it("превышение больше 5 % в одинаковом варианте — CANDIDATE; первый вариант паспорта в приоритете", () => {
    const ev = run(SSR, [Q("PD", 1200, { variant: "vat_incl" }), Q("RD", 1300, { variant: "vat_incl" }), Q("PD", 1000, { variant: "vat_excl" }), Q("RD", 1000, { variant: "vat_excl" })], param);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("1200");
  });
  it("без вариантов у упоминаний — сравниваются как есть (вариант не указан)", () => {
    expect(run(SSR, [Q("PD", 1000), Q("RD", 1049)], param).status).toBe("NEGATIVE_VERIFIED");
    expect(run(SSR, [Q("PD", 1000), Q("RD", 1051)], param).status).toBe("CANDIDATE");
  });
  it("вариант указан только в одной стадии — сравнивается с «не указан», в причине оговорка", () => {
    const ev = run(SSR, [Q("PD", 1000, { variant: "vat_incl" }), Q("RD", 1000)], param);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("вариант показателя указан не во всех стадиях");
  });
});

describe("Страж масштаба единиц (OS-INSP-3.1.43, VER-13)", () => {
  const SSR = P({ unit: "тыс. руб.", tolerance: 0.005, tolerance_pct: 5, direction: "increase", unit_scales: [1, 0.001, 1000] });
  it("значение без единицы в 1000 раз больше — NOT_COMPARABLE: руб. или тыс. руб. не определено", () => {
    const ev = run(SSR, [Q("PD", 1234.5, { unit: "тыс. руб." }), Q("RD", 1234500, { unit: null })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Единица значения не определена: РД — 1234500 без единицы, ПД — 1234,5 тыс. руб.; отношение совпадает с пересчётом единиц паспорта (×1000). Запросите значение с единицей.");
  });
  it("обе единицы известны — сравнение обычное, кратность не страж", () => {
    expect(run(SSR, [Q("PD", 1234.5, { unit: "тыс. руб." }), Q("RD", 1234500, { unit: "тыс. руб." })]).status).toBe("CANDIDATE");
  });
  it("единица только из шапки листа — не доказательство: кратность ×1000 даёт NOT_COMPARABLE, а не BETTER (T173-M3)", () => {
    const ev = run(SSR, [Q("PD", 1200000, { unit: "тыс. руб." }), Q("RD", 1300, { unit: "руб.", unit_from: "page" })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("1300 (единица «руб.» только в шапке листа)");
    expect(scaleMismatch(SSR, Q("PD", 10, { unit: "руб.", unit_from: "value" }), Q("RD", 10000, { unit: "тыс. руб.", unit_from: "value" }))).toBe(null);
  });
  it("scaleMismatch: кратность в пределах 50 %, иначе нет; без таблицы — нет", () => {
    expect(scaleMismatch(SSR, Q("PD", 10, { unit: null }), Q("RD", 10050))).toBe(1000);
    expect(scaleMismatch(SSR, Q("PD", 10, { unit: null }), Q("RD", 14900))).toBe(1000);
    expect(scaleMismatch(SSR, Q("PD", 10, { unit: null }), Q("RD", 15100))).toBe(null);
    expect(scaleMismatch(SSR, Q("PD", 10, { unit: null }), Q("RD", 12))).toBe(null);
    expect(scaleMismatch(SSR, Q("PD", 10000, { unit: "руб." }), Q("RD", 10, { unit: null }))).toBe(0.001);
    expect(scaleMismatch(P(), Q("PD", 10, { unit: null }), Q("RD", 10000))).toBe(null);
    expect(scaleMismatch(SSR, Q("PD", 10, { unit: "руб." }), Q("RD", 10000, { unit: "руб." }))).toBe(null);
    expect(scaleMismatch(SSR, Q("PD", 0, { unit: null }), Q("RD", 10000))).toBe(null);
  });
});

describe("Аспекты параметра: объём подземной части и отметка низа (OS-INSP-3.1.44, CMP-18)", () => {
  const U = P({
    unit: "м³", tolerance: 0.05, bad_direction: "up",
    aspects: [{ key: "depth", title: "отметка низа подземной части", unit: "м", tolerance: 0.005, tolerance_pct: 0, direction: "both", optional: true }],
  });
  const param = PARAM({ code: "M-005", parameter_name: "Строительный объем (Подземный)", unit: "м³", trigger_logic: "Изменение глубины заложения или объема паркинга/подвала в РД." });
  it("объём тот же, отметка низа опустилась — CANDIDATE по аспекту с его единицей", () => {
    const ev = run(U, [Q("PD", 5000), Q("RD", 5000), Q("PD", -4.2, { aspect: "depth" }), Q("RD", -4.5, { aspect: "depth" })], param);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("-4,2");
    expect(ev.actual).toBe("-4,5");
    expect(ev.reason).toContain("Отметка низа подземной части: РД (АР, стр. 3) меньше ПД (ПЗ, стр. 3) на 0,3 м");
  });
  it("отметки низа нет — аспект необязательный, решает объём; в причине сказано, что отметку не сравнили", () => {
    const ev = run(U, [Q("PD", 5000), Q("RD", 5000)], param);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("Отметка низа подземной части: не сравнивалась — ");
  });
  it("объёма нет во второй стадии — MISSING_EVIDENCE по основному показателю, даже если отметки совпали", () => {
    expect(run(U, [Q("PD", 5000), Q("PD", -4.2, { aspect: "depth" }), Q("RD", -4.2, { aspect: "depth" })], param).status).toBe("MISSING_EVIDENCE");
  });
  it("кандидат по основному показателю важнее аспекта; упоминания аспекта — в карточке с подписью", () => {
    const ev = run(U, [Q("PD", 5000), Q("RD", 5600), Q("PD", -4.2, { aspect: "depth" }), Q("RD", -4.5, { aspect: "depth" })], param);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("5000");
    expect(ev.provenance.mentions.map((m) => m.value)).toContain("-4,2 м (отметка низа подземной части)");
  });
  it("необязательный аспект со спорной редакцией понижает «нарушения нет» до уточнения", () => {
    const ev = run(U, [Q("PD", 5000), Q("RD", 5000), Q("PD", -4.2, { aspect: "depth" }), Q("RD", -4.2, { aspect: "depth", role: "CONFLICT" })], param);
    expect(ev.status).toBe("CLARIFICATION_REQUIRED");
  });
});

describe("Паспорта T-173 и вид документа (OS-INSP-2.2.54)", () => {
  it("M-132: смета — источник значения ССР, для прочих параметров — нет", () => {
    expect(isSourceFor("estimate")).toBe(false);
    expect(isSourceFor("estimate", ["estimate"])).toBe(true);
    expect(isSourceFor("questionnaire", ["estimate"])).toBe(false);
    expect(isSourceFor(null)).toBe(true);
    const pp = passports().byCode.get("M-132")!;
    expect(sourceDocTypes(pp)).toEqual(["estimate"]);
    expect(sourceDocTypes(passports().byCode.get("M-001")!)).toEqual([]);
  });
  it("опечатка в виде документа-источника и окно больше 300 — громкий отказ схемы (T173-I1, T173-L2)", () => {
    const pp = structuredClone(passports().byCode.get("M-132")!) as any;
    expect(ParamPassport.safeParse({ ...pp, source_doc_types: ["estimat"] }).success).toBe(false);
    expect(ParamPassport.safeParse({ ...pp, extractor: { ...pp.extractor, window: 500 } }).success).toBe(false);
    expect(ParamPassport.safeParse(pp).success).toBe(true);
  });
  it("паспорта T-173 читаются схемой и дают свои правила", () => {
    const q = (c: string) => quantityPassport(passports().byCode.get(c)!)!;
    expect(q("M-008")).toMatchObject({ unit: "м", direction: "increase" });
    expect(q("M-009")).toMatchObject({ unit: "м", direction: "both" });
    expect(q("M-013")).toMatchObject({ direction: "decrease" });
    expect(q("M-019")).toMatchObject({ unit: "%", direction: "increase", norm: { kind: "max" } });
    expect(q("M-020")).toMatchObject({ unit: "%", direction: "increase", norm: { kind: "max" } });
    expect(q("M-132")).toMatchObject({ unit: "тыс. руб.", tolerance_pct: 5, direction: "increase", variants: [{ code: "vat_incl" }, { code: "vat_excl" }] });
    expect(q("M-005").aspects?.[0]).toMatchObject({ key: "depth", unit: "м" });
    expect(q("M-004")).toMatchObject({ bad_direction: "up", direction: "both" });
    expect(q("M-006")).toMatchObject({ unit: "м³", bad_direction: "up" });
    expect(q("M-001")).toMatchObject({ direction: "both", tolerance: 0.05 });
  });
});

describe("Поля упоминания из ML (OS-INSP-2.2.53)", () => {
  it("единица, вариант, предел и аспект переходят из meta; старый ответ ML без поля unit — страж кратности не включается", () => {
    expect(quantityMeta({ unit: "руб.", variant: "vat_incl", limit: true, aspect: "depth" })).toEqual({ unit: "руб.", variant: "vat_incl", limit: true, aspect: "depth" });
    expect(quantityMeta({ unit: null })).toEqual({ unit: null, variant: null, limit: false, aspect: null });
    expect(quantityMeta({})).toEqual({ variant: null, limit: false, aspect: null });
    expect(quantityMeta({ unit: 5, limit: "true" })).toEqual({ unit: null, variant: null, limit: false, aspect: null });
    expect(quantityMeta({ unit: "руб.", unit_from: "page" })).toEqual({ unit: "руб.", unit_from: "page", variant: null, limit: false, aspect: null });
    expect(quantityMeta({ unit: "руб.", unit_from: "шапка" })).toEqual({ unit: "руб.", variant: null, limit: false, aspect: null });
  });
});

describe("Мутанты Stryker T-173: операции паспорта, порядок предела, отсев в вариантах, текст пропущенного аспекта", () => {
  it("операции каталога добавляются только полями паспорта", () => {
    const base = ["ENT-15", "NRM-01", "NRM-02", "NRM-06", "LNK-01", "VER-15", "GTE-01", "GTE-02", "GTE-03", "CMP-01", "CMP-30", "VER-02", "DEC-01"];
    expect(quantityOps(P())).toEqual(base);
    expect(quantityOps(P({ direction: "increase" }))).toEqual([...base, "CMP-03"]);
    expect(quantityOps(P({ bad_direction: "up" }))).toEqual([...base, "CMP-03"]);
    expect(quantityOps(P({ tolerance_pct: 5, norm: { kind: "max", value: 1, basis: "б" }, unit_scales: [1, 0.001] }))).toEqual([...base, "CMP-02", "CMP-06", "VER-13"]);
    expect(quantityOps(P({ unit_scales: [1] }))).toEqual(base);
    expect(quantityOps(P({ aspects: [{ key: "d", title: "т", unit: "м", tolerance: 0, tolerance_pct: 0, direction: "both", optional: true }] }))).toEqual([...base, "CMP-18"]);
  });
  it("предел из документа: ранняя стадия, затем раздел, затем актуальная редакция, уверенность и страница; отсеянный и устаревший не берутся", () => {
    const S = P({ norm: { kind: "max", value: null, basis: "б" } });
    const lim = (st: Stage, n: number, o: Partial<QuantityMention> = {}) => Q(st, n, { limit: true, ...o });
    expect(normOf(S, [lim("RD", 1), lim("PD", 2, { discipline: "АР" }), lim("PD", 3)])!.value).toBe(3);
    expect(normOf(S, [lim("PD", 4, { role: "CONFLICT" }), lim("PD", 5)])!.value).toBe(5);
    expect(normOf(S, [lim("PD", 6, { confidence: 0.5 }), lim("PD", 7)])!.value).toBe(7);
    expect(normOf(S, [lim("PD", 8, { page: 9 }), lim("PD", 9, { page: 2 })])!.value).toBe(9);
    expect(normOf(S, [lim("PD", 10, { excluded: "X" }), lim("PD", 11, { role: "SUPERSEDED" })])).toBe(null);
    expect(normOf(P(), [lim("PD", 1)])).toBe(null);
  });
  it("варианты: отсеянное и устаревшее упоминание не создаёт общий вариант", () => {
    const V = P({ variants: [{ code: "a", title: "А" }, { code: "b", title: "Б" }] });
    const r = selectVariant([Q("PD", 1, { variant: "a", excluded: "X" }), Q("PD", 2, { variant: "b" }), Q("RD", 3, { variant: "a" }), Q("RD", 4, { variant: "b", role: "SUPERSEDED" })], V);
    expect(r.conflict).toContain("ПД: Б; РД: А");
  });
  it("пропущенный аспект: причина со строчной буквы после тире", () => {
    const U = P({ unit: "м³", tolerance: 0.05, aspects: [{ key: "depth", title: "отметка низа", unit: "м", tolerance: 0.005, tolerance_pct: 0, direction: "both", optional: true }] });
    expect(run(U, [Q("PD", 5), Q("RD", 5)]).reason).toContain("Отметка низа: не сравнивалась — сравнить не с чем:");
  });
});
