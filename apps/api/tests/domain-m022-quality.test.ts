// Эшелоны: L1 (логика снижения), L3 (границы и нехватка данных), L6 (конфликты, редакции и разные субъекты).
// T-241: требования M-022 из Матрицы, строка 23, и ТЗ §9.2.
import { describe, expect, it } from "vitest";
import { evaluateClassParam, fireSubjectKey, type Mention } from "../src/domain/class-param.ts";
import { classPassport } from "../src/domain/passport.ts";
import { passportFor } from "../src/services/passports.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const param: Param = {
  code: "M-022", section: "ПЗ", parameter_name: "Степень огнестойкости здания", unit: "Степень",
  source_pd: "ПЗ", source_rd: "АР/КР", source_id: "Заключение ГПН", trigger_logic: "Снижение степени огнестойкости в РД",
  review_priority: "HIGH", data_type: "enum", compare: { kind: "decrease" }, anchors: [], regex_pattern: null,
  value_scale: null, applicability: null, is_active: true,
};
let seq = 0;
const m = (stage: Stage, value: string, over: Partial<Mention> = {}): Mention => ({
  stage, value, file_id: `f-${++seq}`, sha256: "a".repeat(64), document_code: `2099-01-001-${stage}`,
  revision: "0", approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role: "CURRENT",
  discipline: stage === "PD" ? "ПЗ" : "АР", base: "2099-01-001", qualifier: null, excluded: null,
  excluded_why: null, page: 1, bbox: [0.1, 0.1, 0.2, 0.2], quote: `Степень огнестойкости здания ${value}`, confidence: 1, ...over,
});
const run = (mentions: Mention[]) => evaluateClassParam({ param, passport: classPassport(passportFor("M-022")!)!, mentions, loadedStages: ["PD", "RD"], profile: {} });

describe("M-022: однозначные значения", () => {
  const scale = ["V", "IV", "III", "II", "I"];
  for (const [i, pd] of scale.entries()) for (const [j, rd] of scale.entries())
    it(`${pd} → ${rd}`, () => expect(run([m("PD", pd), m("RD", rd)]).status).toBe(j < i ? "CANDIDATE" : "NEGATIVE_VERIFIED"));
  it("нет РД — MISSING_EVIDENCE", () => expect(run([m("PD", "II")]).status).toBe("MISSING_EVIDENCE"));
  it("устаревшее противоречие не мешает", () => expect(run([m("PD", "II"), m("RD", "II"), m("RD", "III", { role: "SUPERSEDED" })]).status).toBe("NEGATIVE_VERIFIED"));
});

describe("M-022: неоднозначность не становится успешной проверкой", () => {
  it("конфликт действующих разделов требует уточнения", () => {
    const result = run([m("PD", "II"), m("RD", "II"), m("RD", "III", { discipline: "КР" })]);
    expect(result.status).toBe("CLARIFICATION_REQUIRED");
    expect(result.suspicions.length).toBeGreaterThan(0);
    expect(result.fragments).toHaveLength(3);
  });
  it("спорная редакция менее приоритетного раздела не скрывается", () => {
    expect(run([m("PD", "II"), m("RD", "II"), m("RD", "II", { discipline: "КР", role: "CONFLICT" })]).status).toBe("CLARIFICATION_REQUIRED");
  });
  it("разные базовые шифры несопоставимы", () => {
    expect(run([m("PD", "II", { base: "other" }), m("RD", "II")]).status).toBe("NOT_COMPARABLE");
  });
  it("ограничение в РД не доказывает фактическую степень", () => {
    expect(run([m("PD", "II"), m("RD", "II", { qualifier: "min" })]).status).toBe("MISSING_EVIDENCE");
  });
  it("низкая граница РД не доказывает понижения", () => {
    expect(run([m("PD", "II"), m("RD", "III", { qualifier: "min" })]).status).toBe("MISSING_EVIDENCE");
  });
  it("минимум ПД сравнивается с фактом РД", () => {
    expect(run([m("PD", "II", { qualifier: "min" }), m("RD", "I")]).status).toBe("NEGATIVE_VERIFIED");
  });
});


describe("M-022: субъекты", () => {
  it("разные корпуса с одинаковой степенью не дают ложного успеха", () => {
    expect(run([m("PD", "II", { subject_key: "building:1" }), m("RD", "II", { subject_key: "building:2" })]).status).toBe("NOT_COMPARABLE");
  });
  it("разные степени двух корпусов сравниваются попарно без ложного конфликта", () => {
    const r = run([
      m("PD", "II", { subject_key: "building:1" }), m("PD", "III", { subject_key: "building:2" }),
      m("RD", "II", { subject_key: "building:1" }), m("RD", "III", { subject_key: "building:2" }),
    ]);
    expect(r.status).toBe("NEGATIVE_VERIFIED");
    expect(r.suspicions).toEqual([]);
    expect(r.fragments).toHaveLength(4);
  });
  it("понижение одного корпуса сохраняет субъект в причине", () => {
    const r = run([
      m("PD", "II", { subject_key: "building:1" }), m("PD", "III", { subject_key: "building:2" }),
      m("RD", "III", { subject_key: "building:1" }), m("RD", "III", { subject_key: "building:2" }),
    ]);
    expect(r.status).toBe("CANDIDATE");
    expect(r.reason).toContain("building:1");
  });
  it("пропавший корпус не скрывается за успешной парой", () => {
    expect(run([
      m("PD", "II", { subject_key: "building:1" }), m("PD", "III", { subject_key: "building:2" }),
      m("RD", "II", { subject_key: "building:1" }),
    ]).status).toBe("NOT_COMPARABLE");
  });
  it("неподписанный объект не подставляется вместо секции", () => {
    expect(run([m("PD", "II"), m("RD", "II", { subject_key: "section:1" })]).status).toBe("NOT_COMPARABLE");
  });
  it("недоверенный ключ субъекта валидируется без превращения в общий объект", () => {
    for (const raw of ["", "building:1section:2", "section:1/building:2", "<script>", {}, "a".repeat(1000)]) {
      expect(fireSubjectKey(raw)).toBe("unresolved");
      expect(run([m("PD", "II"), m("RD", "II", { subject_key: fireSubjectKey(raw) })]).status).toBe("NOT_COMPARABLE");
    }
    for (const raw of ["building:1", "section:2", "fire_compartment:3", "building:1/section:2/fire_compartment:3"])
      expect(fireSubjectKey(raw)).toBe(raw);
    expect(fireSubjectKey(null)).toBeNull();
  });
});
