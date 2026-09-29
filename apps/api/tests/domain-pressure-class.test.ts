// Эшелоны: L1 (разбор класса давления и сравнение М-072), L3 (границы: наименьший из нескольких, дробные МПа, без класса),
// L5 (fast-check: снижение PN всегда кандидат, неснижение — никогда), L6 (враждебный текст значения).
// T-135, GAP-INSP-07: М-072 «Материал и класс давления напорных труб», правило «не меньше» — OS-INSP-3.1.25.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate, pressureClass, rank, violates } from "../src/domain/compare.ts";
import type { Param, SourceRef, Stage, StageValue } from "../src/domain/types.ts";

const M072: Param = {
  code: "M-072", section: "ИОС2", parameter_name: "Материал и класс давления напорных труб В1/Т3", unit: "Марка",
  source_pd: "Спецификация материалов (ИОС2)", source_rd: "Спецификация оборудования (ВК)", source_id: "Паспорта и сертификаты на трубы",
  trigger_logic: "Подмена оцинкованных/чугунных труб на полипропилен без перерасчета расширения.", review_priority: "MEDIUM",
  data_type: "enum", compare: { kind: "decrease" }, anchors: ["Материал и класс давления напорных труб В1/Т3"], regex_pattern: null,
  value_scale: "pressure_class", applicability: null, is_active: true,
};
const src = (stage: Stage): SourceRef => ({ file_id: `f-${stage}`, sha256: "a".repeat(64), stage, document_code: `X-${stage}`, revision: "1", approval_status: "APPROVED", page: 1, bbox: null, role: "CURRENT" });
// ключ значения — как его отдаёт ML (latinize_code): верхний регистр, кириллица-двойник → латиница, без пробелов и дефисов
const key = (s: string) => s.toUpperCase().replace(/[\s-]/g, "").replace(/[АВСЕІРНКМТОХ]/g, (c) => "ABCEIPHKMTOX"["АВСЕІРНКМТОХ".indexOf(c)]);
const V = (stage: Stage, raw: string): StageValue => ({ stage, num: null, text: key(raw), raw, source: src(stage) });

describe("М-072: класс давления PN (OS-INSP-3.1.25)", () => {
  it("PN, Ру в МПа, кгс/см² и бар — к одному номинальному давлению", () => {
    expect(pressureClass(key("Сталь ВГП PN 16"))).toBe(16);
    expect(pressureClass(key("ПП-R PN20 Ø25"))).toBe(20);
    expect(pressureClass(key("труба стальная Ру 1,6 МПа"))).toBe(16);
    expect(pressureClass(key("Ру 1.0 МПа"))).toBe(10);
    expect(pressureClass(key("Ру 16 кгс/см²"))).toBe(16);
    expect(pressureClass(key("Ру16"))).toBe(16);
    expect(pressureClass(key("чугун ВЧШГ 16 бар"))).toBe(16);
    expect(pressureClass(key("рабочее давление 2,5 МПа"))).toBe(25);
  });
  it("несколько классов в значении — наименьший («не меньше»: сравнивается слабейшая труба)", () => {
    expect(pressureClass(key("ПП PN20 (В1), PN10 (Т3)"))).toBe(10);
  });
  it("диаметр и размеры не принимаются за класс давления; без класса — null", () => {
    expect(pressureClass(key("ПП Ø20x3,4"))).toBeNull();
    expect(pressureClass(key("сталь оцинкованная ГОСТ 3262-75 Ду25"))).toBeNull();
    expect(pressureClass(key(""))).toBeNull();
    expect(rank(M072, key("полипропилен"))).toBeNull();
    expect(rank(M072, key("PN 16"))).toBe(16);
  });
  it("снижение PN в РД — CANDIDATE с понятной дельтой; равный или выше — NEGATIVE_VERIFIED", () => {
    const down = evaluate({ param: M072, profile: {}, values: [V("PD", "Сталь оцинкованная PN16"), V("RD", "Полипропилен PN10")], loadedStages: ["PD", "RD"] });
    expect(down.status).toBe("CANDIDATE");
    const same = evaluate({ param: M072, profile: {}, values: [V("PD", "Ру 1,6 МПа"), V("RD", "PN 16")], loadedStages: ["PD", "RD"] });
    expect(same.status).toBe("NEGATIVE_VERIFIED");
    const up = violates(M072, V("PD", "PN10"), V("RD", "PN20"));
    expect(up?.bad).toBe(false);
  });
  it("класс давления не распознан — NOT_COMPARABLE, а не догадка", () => {
    const e = evaluate({ param: M072, profile: {}, values: [V("PD", "Сталь оцинкованная PN16"), V("RD", "Полипропилен")], loadedStages: ["PD", "RD"] });
    expect(e.status).toBe("NOT_COMPARABLE");
  });
  it("свойство: PN в РД ниже, чем в ПД, — всегда нарушение; не ниже — никогда (fast-check)", () => {
    const pn = fc.constantFrom(2.5, 4, 6, 10, 12.5, 16, 20, 25, 40, 63);
    fc.assert(
      fc.property(pn, pn, fc.constantFrom("PN %", "Ру %МПа", "% бар"), fc.constantFrom("PN %", "Ру %МПа", "% бар"), (e, a, fe, fa) => {
        const w = (f: string, v: number) => f.replace("%", f.includes("МПа") ? String(v / 10).replace(".", ",") : String(v));
        const r = violates(M072, V("PD", w(fe, e)), V("RD", w(fa, a)));
        expect(r?.bad).toBe(a < e);
      }),
    );
  });
  it("враждебный текст значения не роняет сравнение и не даёт ложного класса", () => {
    for (const s of ["PN", "PN-", "РУ МПА", "999999999999999999999 бар", "PN0", "{}".repeat(500), "PN16".repeat(1000)]) {
      const v = pressureClass(key(s));
      expect(v === null || (Number.isFinite(v) && v > 0)).toBe(true);
    }
  });
});

describe("шкала PN — только у параметров со шкалой pressure_class (граница, найдено Stryker T-135)", () => {
  it("параметр без шкалы со значением «PN16» не получает ранг класса давления", () => {
    expect(rank({ ...M072, value_scale: null }, key("PN 16"))).toBeNull();
    expect(rank({ ...M072, value_scale: "unknown_scale" as never }, key("Ру 1,6 МПа"))).toBeNull();
    expect(rank(M072, key("PN 16"))).toBe(16);
  });
});
