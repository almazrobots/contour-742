// Эшелоны: L1 (правила T-211), L3 (границы допуска и норм), L5 (fast-check: норма у каждого значения, счёт без допуска),
// L6 (ловушки: разные участки в стадии, норма из документа при двух нормах, аспект без основного показателя).
// М-033 «Уклоны дорог и проездов» (‰, CMP-18, две нормы CMP-06) и М-048 «Лестничные марши и ступени» (шт., CMP-07; высота
// подступенка и проступь — аспекты с нормой CMP-06). Значения синтетические (ADR-0002).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateQuantityParam, normList, normOf, objectGroups, quantityOps, type QuantityMention, type QuantityPassport } from "../src/domain/quantity-param.ts";
import { quantityPassport } from "../src/domain/passport.ts";
import { passports } from "../src/services/passports.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const ALL: Stage[] = ["PD", "RD", "ID"];
const q = (code: string) => quantityPassport(passports().byCode.get(code)!)!;
const SLOPE = () => q("M-033");
const STAIRS = () => q("M-048");

const PARAM = (over: Partial<Param> = {}): Param => ({
  code: "M-033", section: "СПЗУ", parameter_name: "Уклоны дорог и проездов", unit: "‰", source_pd: "План организации рельефа (СПЗУ)", source_rd: "План организации рельефа (ГП)",
  source_id: "Исполнительная геодезическая схема", trigger_logic: "Нарушение уклонов, ведущее к застою воды или превышению крутизны.", review_priority: "MEDIUM", data_type: "string",
  compare: { kind: "equal" }, anchors: ["Уклоны дорог и проездов"], regex_pattern: null, value_scale: null, applicability: null, is_active: true, ...over,
});
const STAIR_PARAM = PARAM({
  code: "M-048", section: "АР", parameter_name: "Количество и параметры лестничных маршей и ступеней", unit: "шт. / мм", review_priority: "HIGH",
  trigger_logic: "Изменение количества ступеней; высота подступенка > 150 мм или проступь < 300 мм.", anchors: ["Количество и параметры лестничных маршей и ступеней"],
});

let seq = 0;
const Q = (stage: Stage, num: number, over: Partial<QuantityMention> = {}): QuantityMention => {
  const discipline = over.discipline ?? (stage === "PD" ? "ПЗУ" : stage === "RD" ? "ГП" : "ИГС");
  return {
    stage, file_id: `f${++seq}`, sha256: "a".repeat(64), document_code: `${stage === "PD" ? "П" : "Р"}-100-${discipline}`, revision: "1",
    approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role: "CURRENT", discipline, base: "100", num, excluded: null, excluded_why: null,
    page: 3, bbox: [0.1, 0.1, 0.2, 0.12], quote: `уклон ${num}`, confidence: 1, source: "pdf-text", unit: "‰", ...over,
  };
};
const A = (stage: Stage, num: number, over: Partial<QuantityMention> = {}) => Q(stage, num, { discipline: "АР", unit: "мм", ...over });
const run = (passport: QuantityPassport, mentions: QuantityMention[], param = PARAM()) =>
  evaluateQuantityParam({ param, passport, mentions, loadedStages: ALL, profile: {}, kitBases: new Set(["100"]) });

describe("М-033: паспорт уклона — ‰, две нормы, много участков (OS-INSP-3.1.140, 3.1.141, 3.1.147)", () => {
  it("паспорт читается схемой: единица ‰, допуск 0,5, нормы max 80 и min 4, варианты вида уклона, операции CMP-18 и CMP-06", () => {
    const p = SLOPE();
    expect(p).toMatchObject({ unit: "‰", tolerance: 0.5, direction: "both", bad_direction: "up", multi_object: true, variants: [{ code: "long" }, { code: "cross" }] });
    expect(normList(p.norm).map((n) => [n.kind, n.value])).toEqual([["max", 80], ["min", 4]]);
    expect(quantityOps(p)).toEqual(expect.arrayContaining(["CMP-18", "CMP-06", "CMP-01", "CMP-30", "VER-13"]));
    expect(new Set(quantityOps(p)).size).toBe(quantityOps(p).length);
  });
  it("ПД 20 ‰, РД 20 ‰ — NEGATIVE_VERIFIED, в причине обе соблюдённые нормы", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 20)]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason.startsWith("Уклоны дорог и проездов: совпало в пределах точности ТЭП (±0,5 ‰). Норма соблюдена (CMP-06): ≤ 80 ‰ (наибольший продольный уклон проезда — превышение крутизны;")).toBe(true);
    expect(ev.reason).toContain("; ≥ 4 ‰ (наименьший уклон для стока по лоткам — застой воды;");
    expect(ev.reason).toContain("пункт СП не подтверждён");
  });
  it("изменение уклона больше 0,5 ‰ — CANDIDATE с разницей в ‰; граница 0,5 — не нарушение", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 35)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("РД (ГП, стр. 3) больше ПД (ПЗУ, стр. 3) на 15 ‰ — допуск ±0,5 ‰; изменение в плохую сторону (CMP-03, WORSE). Код причины: SLOPE_STEEPER.");
    expect(ev.delta).toBe("+15 ‰ (+75,0 %)");
    expect(run(SLOPE(), [Q("PD", 20), Q("RD", 20.5)]).status).toBe("NEGATIVE_VERIFIED");
    expect(run(SLOPE(), [Q("PD", 20), Q("RD", 20.6)]).status).toBe("CANDIDATE");
  });
  it("уменьшение уклона в пределах нормы — не нарушение, а изменение в лучшую сторону (CMP-03 BETTER)", () => {
    const ev = run(SLOPE(), [Q("PD", 25), Q("RD", 15)]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("Изменение в лучшую сторону (CMP-03, BETTER): РД 15 против ПД 25");
  });
  it("круче 80 ‰ — CANDIDATE по норме даже при одной стадии; эталон в карточке — норма крутизны", () => {
    const ev = run(SLOPE(), [Q("RD", 95)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected?.startsWith("≤ 80 ‰ (наибольший продольный уклон проезда — превышение крутизны;")).toBe(true);
    expect(ev.actual).toBe("95");
    expect(ev.delta).toBe("+15 ‰ к пределу");
    expect(ev.reason).toContain("Норма нарушена (CMP-06): РД (ГП, стр. 3) — 95 ‰ при пределе ≤ 80 ‰");
  });
  it("положе 4 ‰ — застой воды: CANDIDATE по второй норме; граница 3,5 ‰ в допуске", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 2)]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected?.startsWith("≥ 4 ‰ (наименьший уклон для стока по лоткам — застой воды;")).toBe(true);
    expect(ev.delta).toBe("-2 ‰ к пределу");
    expect(run(SLOPE(), [Q("PD", 3.5), Q("RD", 3.5)]).status).toBe("NEGATIVE_VERIFIED");
    expect(run(SLOPE(), [Q("PD", 3.4), Q("RD", 3.4)]).status).toBe("CANDIDATE");
  });
  it("продольный сравнивается с продольным: поперечный уклон другой величины не нарушение", () => {
    // сравнивается первый общий вид по порядку паспорта — продольный; поперечный в карточке отсеян с причиной
    const ev = run(SLOPE(), [Q("PD", 20, { variant: "long" }), Q("PD", 15, { variant: "cross", page: 4 }), Q("RD", 20, { variant: "long" }), Q("RD", 25, { variant: "cross", page: 4 })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.provenance.mentions.filter((m) => m.use === "dropped").map((m) => m.why)).toEqual(["другой вариант показателя — поперечный", "другой вариант показателя — поперечный"]);
    const ok = run(SLOPE(), [Q("PD", 20, { variant: "long" }), Q("RD", 20, { variant: "long" }), Q("RD", 25, { variant: "cross", page: 4 })]);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(ok.reason).toContain("Сравнивался вариант показателя — продольный.");
  });
  it("норма проверяется у каждого вида уклона: поперечный 90 ‰ или 2 ‰ — CANDIDATE, хотя сравнивается продольный", () => {
    expect(run(SLOPE(), [Q("PD", 20, { variant: "long" }), Q("RD", 20, { variant: "long" }), Q("RD", 90, { variant: "cross", page: 4 })]).status).toBe("CANDIDATE");
    const ev = run(SLOPE(), [Q("PD", 20, { variant: "long" }), Q("RD", 2, { variant: "cross" })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.actual).toBe("2");
    expect(ev.reason).not.toContain("меньше ПД"); // виды не совпали — сравнения стадий в причине нет
  });
  it("виды уклона в стадиях не совпали, нормы соблюдены — NOT_COMPARABLE, а не сравнение продольного с поперечным", () => {
    const ev = run(SLOPE(), [Q("PD", 20, { variant: "long" }), Q("RD", 30, { variant: "cross" })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Варианты показателя в стадиях разные — ПД: продольный; РД: поперечный. Сравнивается только одинаковый вариант. Запросите значение того же варианта.");
  });
  it("одна стадия без нарушения нормы — MISSING_EVIDENCE с найденным и недостающим, не нарушение (OS-INSP-3.1.146)", () => {
    const ev = run(SLOPE(), [Q("PD", 20)]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("Запросите РД: план организации рельефа, проектные уклоны (ГП) — показателя нет");
    expect(run(SLOPE(), []).status).toBe("MISSING_EVIDENCE");
  });
});

describe("Много объектов: норма у каждого значения, пара не угадывается (OS-INSP-3.1.142)", () => {
  it("в РД два участка 20 и 30 ‰ на разных листах — NOT_COMPARABLE с перечнем, а не CANDIDATE случайной пары", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 20, { file_id: "r1" }), Q("RD", 30, { file_id: "r2", page: 7 })]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason.startsWith("Сравнение ПД и РД не выполнено: в РД несколько разных значений — ГП — 20 (стр. 3); ГП — 30 (стр. 7). Значения относятся к разным объектам (участкам, маршам), какое с каким сопоставлять, по тексту не определить. Нормы соблюдены у всех значений (CMP-06): ≤ 80 ‰")).toBe(true);
    expect(ev.reason.endsWith("Запросите ведомость с привязкой значений к объектам.")).toBe(true);
    expect(ev.suspicions.map((s) => s.stage)).toEqual(["RD"]);
  });
  it("круче нормы не выбранное, а второе значение стадии — всё равно CANDIDATE", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 20), Q("RD", 90, { page: 7 })]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.actual).toBe("90");
  });
  it("без multi_object — норма только у выбранного значения, расхождение внутри стадии — гипотеза, а сравнение идёт", () => {
    const p = { ...SLOPE(), multi_object: false };
    expect(run(p, [Q("PD", 20), Q("RD", 20, { file_id: "r1" }), Q("RD", 90, { file_id: "r2", page: 7 })]).status).toBe("NEGATIVE_VERIFIED");
  });
  it("свойство: хоть одно значение стадии круче 80 ‰ больше допуска — CANDIDATE, при любом их порядке", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 40, max: 160 }), { minLength: 1, maxLength: 5 }), fc.integer({ min: 81, max: 190 }), (ok, steep) => {
        const ms = [Q("PD", 20), ...ok.map((v, i) => Q("RD", v / 2, { page: i + 1 })), Q("RD", steep, { page: 9 })];
        expect(run(SLOPE(), ms).status).toBe("CANDIDATE");
      }),
    );
  });
});

describe("Несколько норм: предел из документа не подставляется (OS-INSP-3.1.141)", () => {
  it("упоминание-предел при двух нормах не заменяет паспорт: неизвестно, max это или min", () => {
    const p = SLOPE();
    const lim = Q("PD", 50, { limit: true });
    expect(normOf(p, [lim])?.value).toBe(80);
    expect(normOf(p, [lim], normList(p.norm)[1])?.value).toBe(4);
    const one: QuantityPassport = { ...p, norm: { kind: "max", value: 80, basis: "б" } };
    expect(normOf(one, [lim])?.value).toBe(50);
    expect(normOf({ ...p, norm: null }, [lim])).toBe(null);
  });
  it("normList: одна норма, список, пусто", () => {
    expect(normList(null)).toEqual([]);
    expect(normList(undefined)).toEqual([]);
    expect(normList({ kind: "min", value: 1, basis: "б" })).toHaveLength(1);
  });
});

describe("М-048: число ступеней — точный счёт (OS-INSP-3.1.143)", () => {
  it("паспорт: шт., допуск 0, много маршей, CMP-07; аспекты: норма СП 220 / 250 мм и рекомендация Матрицы 150 / 300 мм", () => {
    const p = STAIRS();
    expect(p).toMatchObject({ unit: "шт.", tolerance: 0, direction: "both", multi_object: true });
    expect(quantityOps(p)).toEqual(expect.arrayContaining(["CMP-07", "CMP-06", "CMP-18"]));
    expect(p.aspects?.map((a) => [a.key, a.unit, normList(a.norm).map((n) => `${n.kind}${n.value}${n.level ?? ""}`)])).toEqual([
      ["riser", "мм", ["max220", "max150warn"]],
      ["tread", "мм", ["min250", "min300warn"]],
    ]);
    expect(normList(p.aspects![0].norm)[0].basis).toContain("СП 1.13130.2020, п. 4.4.3");
  });
  it("ПД 12, РД 11 — CANDIDATE: любая разница в счёте; ПД 12, РД 12 — нарушения нет", () => {
    const bad = run(STAIRS(), [A("PD", 12, { unit: "шт." }), A("RD", 11, { unit: "шт." })], STAIR_PARAM);
    expect(bad.status).toBe("CANDIDATE");
    expect(bad.reason).toContain("РД (АР, стр. 3) меньше ПД (АР, стр. 3) на 1 шт. — допуск ±0 шт.");
    const ok = run(STAIRS(), [A("PD", 12, { unit: "шт." }), A("RD", 12, { unit: "шт." })], STAIR_PARAM);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(ok.reason).toContain("Высота подступенка: не сравнивалась — ");
  });
  it("свойство: счёт — CANDIDATE ровно при неравенстве", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 18 }), fc.integer({ min: 3, max: 18 }), (a, b) => {
        expect(run(STAIRS(), [A("PD", a), A("RD", b)], STAIR_PARAM).status).toBe(a === b ? "NEGATIVE_VERIFIED" : "CANDIDATE");
      }),
    );
  });
  it("в РД два марша с разным числом ступеней — NOT_COMPARABLE, а не нарушение", () => {
    expect(run(STAIRS(), [A("PD", 12), A("RD", 12), A("RD", 10, { page: 5 })], STAIR_PARAM).status).toBe("NOT_COMPARABLE");
  });
});

describe("М-048: норма СП у аспекта — нарушение, рекомендация Матрицы — гипотеза (OS-INSP-3.1.144, 3.1.145, 3.1.148)", () => {
  const riser = (s: Stage, v: number, over: Partial<QuantityMention> = {}) => A(s, v, { aspect: "riser", ...over });
  const tread = (s: Stage, v: number, over: Partial<QuantityMention> = {}) => A(s, v, { aspect: "tread", ...over });
  const warns = (ev: ReturnType<typeof run>) => ev.suspicions.filter((x) => x.dedup_key.startsWith("quantity-warn:")).map((x) => x.description);
  it("высота подступенка 230 мм в РД при отсутствии числа ступеней — CANDIDATE по норме СП с нормой-эталоном", () => {
    const ev = run(STAIRS(), [riser("RD", 230)], STAIR_PARAM);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("≤ 220 мм (СП 1.13130.2020, п. 4.4.3 — высота ступени не более 22 см)");
    expect(ev.reason.startsWith("Высота подступенка: Норма нарушена (CMP-06): РД (АР, стр. 3) — 230 мм")).toBe(true);
    expect(warns(ev)).toEqual([]); // норма нарушена — рекомендация отдельной гипотезой не дублируется
  });
  it("подступенок 170 мм: рекомендацию Матрицы не выполняет, норму СП выполняет — гипотеза, не нарушение", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 170), riser("RD", 170)], STAIR_PARAM);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(warns(ev)).toEqual([
      "Высота подступенка: ПД (АР, стр. 3) — 170 мм — не выполняет рекомендацию ≤ 150 мм (рекомендация Матрицы М-048), норму ≤ 220 мм (СП 1.13130.2020, п. 4.4.3 — высота ступени не более 22 см) выполняет (CMP-06).",
      "Высота подступенка: РД (АР, стр. 3) — 170 мм — не выполняет рекомендацию ≤ 150 мм (рекомендация Матрицы М-048), норму ≤ 220 мм (СП 1.13130.2020, п. 4.4.3 — высота ступени не более 22 см) выполняет (CMP-06).",
    ]);
    expect(run(STAIRS(), [riser("RD", 170)], STAIR_PARAM).status).toBe("MISSING_EVIDENCE");
  });
  it("проступь 240 мм — CANDIDATE по норме СП min; 280 мм — гипотеза; границы 249,5 / 249,4 и 299,5 / 299,4", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 12), tread("RD", 240)], STAIR_PARAM);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("≥ 250 мм (СП 1.13130.2020, п. 4.4.3 — ширина проступи, как правило, не менее 25 см)");
    const soft = run(STAIRS(), [A("PD", 12), A("RD", 12), tread("RD", 280)], STAIR_PARAM);
    expect(soft.status).toBe("NEGATIVE_VERIFIED");
    expect(warns(soft)).toHaveLength(1);
    expect(run(STAIRS(), [tread("RD", 249.5)], STAIR_PARAM).status).toBe("MISSING_EVIDENCE");
    expect(run(STAIRS(), [tread("RD", 249.4)], STAIR_PARAM).status).toBe("CANDIDATE");
    expect(warns(run(STAIRS(), [tread("RD", 299.5)], STAIR_PARAM))).toEqual([]);
    expect(warns(run(STAIRS(), [tread("RD", 299.4)], STAIR_PARAM))).toHaveLength(1);
  });
  it("граница подступенка: 220,5 — не нарушение, 220,6 — нарушение; рекомендация: 150,5 — нет гипотезы, 150,6 — есть", () => {
    expect(run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 220.5), riser("RD", 220.5)], STAIR_PARAM).status).toBe("NEGATIVE_VERIFIED");
    expect(run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 220.6), riser("RD", 220.6)], STAIR_PARAM).status).toBe("CANDIDATE");
    expect(warns(run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 150.5), riser("RD", 150.5)], STAIR_PARAM))).toEqual([]);
    expect(warns(run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 150.6), riser("RD", 150.6)], STAIR_PARAM))).toHaveLength(2);
  });
  it("рекомендация без нарушения нормы — в причине «нарушения нет» названа как гипотеза (показатель с нормой и рекомендацией)", () => {
    const p: QuantityPassport = { ...STAIRS(), unit: "мм", tolerance: 0.5, aspects: null, norm: [{ kind: "max", value: 220, basis: "СП" }, { kind: "max", value: 150, basis: "Матрица", level: "warn" }] };
    const ev = run(p, [A("PD", 170), A("RD", 170)], STAIR_PARAM);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("Норма соблюдена (CMP-06): ≤ 220 мм (СП).");
    expect(ev.reason).toContain("Рекомендация не выполнена — гипотеза для инспектора, не нарушение: ПД 170 мм при ≤ 150 мм (Матрица); РД 170 мм при ≤ 150 мм (Матрица).");
    expect(warns(ev)[0]).toBe("Количество и параметры лестничных маршей и ступеней: ПД (АР, стр. 3) — 170 мм — не выполняет рекомендацию ≤ 150 мм (Матрица), норму ≤ 220 мм (СП) выполняет (CMP-06).");
    const only: QuantityPassport = { ...p, norm: { kind: "max", value: 150, basis: "Матрица", level: "warn" } };
    expect(warns(run(only, [A("PD", 170), A("RD", 170)], STAIR_PARAM))[0]).toBe("Количество и параметры лестничных маршей и ступеней: ПД (АР, стр. 3) — 170 мм — не выполняет рекомендацию ≤ 150 мм (Матрица) (CMP-06).");
  });
  it("нормы и рекомендации соблюдены, число ступеней совпало — NEGATIVE_VERIFIED; размер изменился в пределах СП — гипотеза, не нарушение", () => {
    const ok = run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 150), riser("RD", 150), tread("PD", 300), tread("RD", 300)], STAIR_PARAM);
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
    expect(warns(ok)).toEqual([]);
    const moved = run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 140), riser("RD", 150)], STAIR_PARAM);
    expect(moved.status).toBe("NEGATIVE_VERIFIED");
    expect(moved.suspicions.map((x) => x.description)).toContain("Высота подступенка: РД (АР, стр. 3) больше ПД (АР, стр. 3) на 10 мм — допуск ±0,5 мм (STEP_RISER_HIGHER_WITHIN_NORM).");
  });
  it("кандидат числа ступеней важнее аспекта; у аспекта своя норма, основной показатель по своему правилу", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 13), riser("RD", 230)], STAIR_PARAM);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("12");
  });
  it("нет ни одного упоминания — MISSING_EVIDENCE, не нарушение", () => {
    expect(run(STAIRS(), [], STAIR_PARAM).status).toBe("MISSING_EVIDENCE");
  });
  it("отсеянное упоминание (NOT_INTEGER, MULTI_VALUE) не участвует ни в счёте, ни в норме", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 12.5, { excluded: "NOT_INTEGER", excluded_why: "дробное" }), riser("RD", 250, { excluded: "MULTI_VALUE", excluded_why: "несколько" })], STAIR_PARAM);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(warns(ev)).toEqual([]);
  });
});

describe("Объект значения: марка или строка таблицы — стадии сравниваются по объекту (OS-INSP-3.1.149)", () => {
  it("П-1 и П-2 в обеих стадиях: у П-1 уклон вырос — CANDIDATE по П-1, а не NOT_COMPARABLE по разбросу", () => {
    const ms = [Q("PD", 30, { object: "п-1" }), Q("PD", 15, { object: "п-2", page: 4 }), Q("RD", 60, { object: "п-1" }), Q("RD", 15, { object: "п-2", page: 4 })];
    const ev = run(SLOPE(), ms);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason.startsWith("Объект «п-1»: РД (ГП, стр. 3) больше ПД (ПЗУ, стр. 3) на 30 ‰")).toBe(true);
    expect(ev.provenance.mentions).toHaveLength(4);
    const blind = run(SLOPE(), ms.map((m) => ({ ...m, object: null })));
    expect(blind.status).toBe("NOT_COMPARABLE");
  });
  it("объект без пары — в причине; общий объект совпал — NEGATIVE_VERIFIED", () => {
    const ev = run(SLOPE(), [Q("PD", 30, { object: "п-1" }), Q("RD", 30, { object: "п-1" }), Q("RD", 20, { object: "п-3", page: 5 })]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("Без пары в другой стадии: «п-3».");
  });
  it("норма проверяется и у объекта без пары: 90 ‰ у П-3 — CANDIDATE", () => {
    expect(run(SLOPE(), [Q("PD", 30, { object: "п-1" }), Q("RD", 30, { object: "п-1" }), Q("RD", 90, { object: "п-3", page: 5 })]).status).toBe("CANDIDATE");
  });
  it("объект известен не у всех значений или общих объектов нет — сравнение без объектов", () => {
    expect(objectGroups([Q("PD", 30, { object: "п-1" }), Q("RD", 60)])).toBe(null);
    expect(objectGroups([Q("PD", 30, { object: "л-1" }), Q("RD", 30, { object: "лм-1" })])).toBe(null);
    expect(objectGroups([])).toBe(null);
    const g = objectGroups([Q("PD", 30, { object: "п-1" }), Q("RD", 30, { object: "п-1" }), Q("RD", 1, { excluded: "NO_UNIT", excluded_why: "x" })]);
    expect(g?.groups.map(([k, ms]) => [k, ms.length])).toEqual([["п-1", 2]]);
    expect(g?.rest).toHaveLength(1);
    // без multi_object объекты не группируются
    expect(run({ ...SLOPE(), multi_object: false }, [Q("PD", 30, { object: "п-1" }), Q("PD", 15, { object: "п-2", page: 4 }), Q("RD", 60, { object: "п-1" })]).reason.startsWith("Объект")).toBe(false);
  });
});

describe("Основной показатель необязателен и значение без единицы (OS-INSP-3.1.145, 3.1.146)", () => {
  const riser = (s: Stage, v: number) => A(s, v, { aspect: "riser" });
  it("М-048: числа ступеней нет, подступенок совпал — NEGATIVE_VERIFIED по аспекту, в причине — основной не сравнивался", () => {
    const ev = run(STAIRS(), [riser("PD", 150), riser("RD", 150)], STAIR_PARAM);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("Основной показатель не сравнивался — сравнить не с чем");
    expect(run({ ...STAIRS(), main_optional: false }, [riser("PD", 150), riser("RD", 150)], STAIR_PARAM).status).toBe("MISSING_EVIDENCE");
    expect(run(STAIRS(), [riser("PD", 150)], STAIR_PARAM).status).toBe("MISSING_EVIDENCE");
  });
  it("в РД уклон без единицы при значении ПД — NOT_COMPARABLE с просьбой единицы; без значения ПД — MISSING_EVIDENCE", () => {
    const x = Q("RD", 2, { excluded: "NO_UNIT", excluded_why: "единица не указана", unit: null, quote: "Уклон ~2°" });
    const ev = run(SLOPE(), [Q("PD", 30), x]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toBe("Единица значения не определена: РД (ГП, стр. 3) — «Уклон ~2°»; ПД — 30 ‰. Запросите значение с единицей (‰).");
    expect(run(SLOPE(), [x]).status).toBe("MISSING_EVIDENCE");
    expect(run(SLOPE(), [Q("PD", 30), Q("RD", 2, { excluded: "OTHER_OBJECT", excluded_why: "кровля" })]).status).toBe("MISSING_EVIDENCE");
  });
});

describe("М-033: коды причины по направлению изменения уклона (OS-INSP-3.1.140)", () => {
  it("рост сверх допуска — CANDIDATE, SLOPE_STEEPER", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 30)]);
    expect([ev.status, ev.code]).toEqual(["CANDIDATE", "SLOPE_STEEPER"]);
    expect(run(SLOPE(), [Q("PD", 20), Q("RD", 20.5)]).code).toBe(null);
  });
  it("уменьшение ниже нормы минимума (застой воды) — CANDIDATE, SLOPE_FLATTER_BELOW_MIN; выше максимума — SLOPE_STEEPER", () => {
    const ev = run(SLOPE(), [Q("PD", 20), Q("RD", 3)]);
    expect([ev.status, ev.code]).toEqual(["CANDIDATE", "SLOPE_FLATTER_BELOW_MIN"]);
    expect(ev.reason).toContain("Код причины: SLOPE_FLATTER_BELOW_MIN.");
    expect(run(SLOPE(), [Q("RD", 95)]).code).toBe("SLOPE_STEEPER");
  });
  it("уменьшение сверх допуска в пределах нормы — уровень паспорта: сейчас не нарушение, код SLOPE_FLATTER_WITHIN_NORM", () => {
    const ev = run(SLOPE(), [Q("PD", 25), Q("RD", 15)]);
    expect([ev.status, ev.code]).toEqual(["NEGATIVE_VERIFIED", "SLOPE_FLATTER_WITHIN_NORM"]);
    expect(ev.reason).toContain("Код причины: SLOPE_FLATTER_WITHIN_NORM (уровень паспорта — не нарушение).");
    expect(run(SLOPE(), [Q("PD", 25), Q("RD", 24.6)]).code).toBe(null);
  });
  it("уровень задаётся паспортом одной строкой: suspicion — гипотеза, candidate — нарушение", () => {
    const at = (level: "none" | "suspicion" | "candidate"): QuantityPassport => ({ ...SLOPE(), change_codes: { ...SLOPE().change_codes, down: { code: "SLOPE_FLATTER_WITHIN_NORM", level } } });
    const sus = run(at("suspicion"), [Q("PD", 25), Q("RD", 15)]);
    expect([sus.status, sus.code]).toEqual(["NEGATIVE_VERIFIED", "SLOPE_FLATTER_WITHIN_NORM"]);
    expect(sus.suspicions.map((x) => x.description)).toEqual(["Уклоны дорог и проездов: РД (ГП, стр. 3) меньше ПД (ПЗУ, стр. 3) на 10 ‰ — допуск ±0,5 ‰ (SLOPE_FLATTER_WITHIN_NORM)."]);
    const cand = run(at("candidate"), [Q("PD", 25), Q("RD", 15)]);
    expect([cand.status, cand.code]).toEqual(["CANDIDATE", "SLOPE_FLATTER_WITHIN_NORM"]);
  });
  it("паспорт без кодов — прежнее поведение: любое изменение сверх допуска — CANDIDATE без кода", () => {
    const plain: QuantityPassport = { ...SLOPE(), change_codes: null, norm: null };
    const ev = run(plain, [Q("PD", 25), Q("RD", 15)]);
    expect([ev.status, ev.code ?? null]).toEqual(["CANDIDATE", null]);
  });
});

describe("М-048: изменение размера ступени — нарушение только по норме СП, в пределах СП — гипотеза (OS-INSP-3.1.144)", () => {
  const riser = (s: Stage, v: number) => A(s, v, { aspect: "riser" });
  const tread = (s: Stage, v: number) => A(s, v, { aspect: "tread" });
  const turns = (ev: ReturnType<typeof run>) => ev.suspicions.filter((x) => x.dedup_key.startsWith("quantity-turn:")).map((x) => x.dedup_key.split(":")[1]);
  it("подступенок 150 → 170 мм (≤ 220 по СП) — не CANDIDATE: гипотеза с кодом, и рекомендация Матрицы названа", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 150), riser("RD", 170)], STAIR_PARAM);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(turns(ev)).toEqual(["riser"]);
    expect(ev.suspicions.some((x) => x.dedup_key.startsWith("quantity-warn:riser"))).toBe(true);
  });
  it("проступь 300 → 260 мм (≥ 250 по СП) — гипотеза; 300 → 240 мм — CANDIDATE по норме СП", () => {
    const soft = run(STAIRS(), [A("PD", 12), A("RD", 12), tread("PD", 300), tread("RD", 260)], STAIR_PARAM);
    expect(soft.status).toBe("NEGATIVE_VERIFIED");
    expect(turns(soft)).toEqual(["tread"]);
    const hard = run(STAIRS(), [A("PD", 12), A("RD", 12), tread("PD", 300), tread("RD", 240)], STAIR_PARAM);
    expect([hard.status, hard.expected]).toEqual(["CANDIDATE", "≥ 250 мм (СП 1.13130.2020, п. 4.4.3 — ширина проступи, как правило, не менее 25 см)"]);
  });
  it("подступенок 150 → 230 мм — CANDIDATE по норме СП, а не гипотеза", () => {
    expect(run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 150), riser("RD", 230)], STAIR_PARAM).status).toBe("CANDIDATE");
  });
  it("улучшение размера (подступенок ниже, проступь шире) — ни гипотезы, ни нарушения", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 12), riser("PD", 170), riser("RD", 150), tread("PD", 280), tread("RD", 300)], STAIR_PARAM);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(turns(ev)).toEqual([]);
  });
  it("изменение числа ступеней остаётся CANDIDATE — прямой триггер Матрицы, даже при гипотезе по размеру", () => {
    const ev = run(STAIRS(), [A("PD", 12), A("RD", 11), riser("PD", 150), riser("RD", 170)], STAIR_PARAM);
    expect([ev.status, ev.expected, ev.actual]).toEqual(["CANDIDATE", "12", "11"]);
  });
  it("паспорт: коды и уровни изменения размера заданы у аспектов", () => {
    const [r, t] = STAIRS().aspects!;
    expect(r.change_codes).toEqual({ up: { code: "STEP_RISER_HIGHER_WITHIN_NORM", level: "suspicion" }, down: { code: "STEP_RISER_LOWER", level: "none" } });
    expect(t.change_codes).toEqual({ up: { code: "STEP_TREAD_WIDER", level: "none" }, down: { code: "STEP_TREAD_NARROWER_WITHIN_NORM", level: "suspicion" } });
  });
});
