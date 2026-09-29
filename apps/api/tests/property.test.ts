// Эшелон L5 (qa-standard): свойства предметной логики на случайных входах (fast-check), а не на примерах.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate, violates } from "../src/domain/compare.ts";
import { evaluateRequisites, type IdDoc } from "../src/domain/requisites.ts";
import { duePeriod, reportDue } from "../src/domain/schedule.ts";
import type { Param, SourceRef, Stage, StageValue } from "../src/domain/types.ts";

const STAGES: Stage[] = ["PD", "RD", "ID"];
const RULES = [
  { kind: "delta_pct", tolerance: 1 },
  { kind: "delta_pct", tolerance: 0 },
  { kind: "equal" },
  { kind: "decrease" },
  { kind: "increase" },
  { kind: "min", min: 0.9 },
] as const;

const param = (compare: any): Param => ({
  code: "M-X", section: "ПЗ", parameter_name: "X", unit: "м", source_pd: "ТЭП", source_rd: "ОД", source_id: "ИД", trigger_logic: "", review_priority: "HIGH",
  data_type: "number", compare, anchors: ["X"], regex_pattern: null, value_scale: null, applicability: null, is_active: true,
} as Param);
const src = (stage: Stage, role: SourceRef["role"]): SourceRef => ({ file_id: `f-${stage}`, sha256: "a".repeat(64), stage, document_code: `C-${stage}`, revision: "1", approval_status: "APPROVED", page: 1, bbox: [0, 0, 1, 1], role });
const num = fc.double({ min: 0.01, max: 1e6, noNaN: true, noDefaultInfinity: true });
const values = fc.uniqueArray(fc.constantFrom(...STAGES), { minLength: 0, maxLength: 3 }).chain((stages) =>
  fc.tuple(...stages.map((s) => fc.record({ s: fc.constant(s), n: fc.option(num, { nil: null }), role: fc.constantFrom<SourceRef["role"]>("CURRENT", "CURRENT", "CURRENT", "CONFLICT") }))),
).map((vs) => vs.map((v): StageValue => ({ stage: v.s, num: v.n, text: v.n === null ? "по проекту" : null, raw: String(v.n), source: src(v.s, v.role) })));

describe("L5 · сравнение параметра (OS-INSP-3.1)", () => {
  it("система никогда не ставит CONFIRMED_VIOLATION и всегда возвращает статус из допустимого набора", () => {
    const allowed = new Set(["CANDIDATE", "NEGATIVE_VERIFIED", "MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"]);
    fc.assert(fc.property(fc.constantFrom(...RULES), values, fc.boolean(), (rule, vs, applicable) => {
      const p = { ...param(rule), applicability: applicable ? null : "gas" } as Param;
      const r = evaluate({ param: p, profile: { gas: false }, values: vs, loadedStages: STAGES });
      return allowed.has(r.status) && (r.status as string) !== "CONFIRMED_VIOLATION"; // тип FindingStatus это уже исключает — здесь проверка во время выполнения
    }), { numRuns: 500 });
  });
  it("равные значения на стадиях никогда не нарушают правило сравнения стадий", () => {
    fc.assert(fc.property(fc.constantFrom(...RULES.filter((r) => r.kind !== "min")), num, (rule, n) => {
      const r = violates(param(rule), { stage: "PD", num: n, text: null, raw: "", source: src("PD", "CURRENT") }, { stage: "RD", num: n, text: null, raw: "", source: src("RD", "CURRENT") });
      return r !== null && r.bad === false;
    }), { numRuns: 300 });
  });
  it("допуск в процентах симметричен: отклонение вверх и вниз на одну долю даёт один вердикт", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 10, noNaN: true }), num, fc.double({ min: 0, max: 20, noNaN: true }), (tol, e, pct) => {
      const p = param({ kind: "delta_pct", tolerance: tol });
      const mk = (n: number): StageValue => ({ stage: "RD", num: n, text: null, raw: "", source: src("RD", "CURRENT") });
      const exp: StageValue = { stage: "PD", num: e, text: null, raw: "", source: src("PD", "CURRENT") };
      const up = violates(p, exp, mk(e * (1 + pct / 100)))!.bad;
      const down = violates(p, exp, mk(e * (1 - pct / 100)))!.bad;
      return up === down || Math.abs(pct - tol) < 1e-6; // на самой границе округление может развести
    }), { numRuns: 300 });
  });
  it("спорная редакция на любой стадии — только CLARIFICATION_REQUIRED (если параметр применим)", () => {
    fc.assert(fc.property(fc.constantFrom(...RULES), values, (rule, vs) => {
      const r = evaluate({ param: param(rule), profile: {}, values: vs, loadedStages: STAGES });
      return !vs.some((v) => v.source.role === "CONFLICT") || r.status === "CLARIFICATION_REQUIRED";
    }), { numRuns: 300 });
  });
});

describe("L5 · расписание еженедельного отчёта (OS-INSP-6.2.2)", () => {
  const moment = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2035-12-31T23:59:59Z"), noInvalidDate: true });
  it("период ровно 7 суток, конец — понедельник 00:00 UTC, не позже текущего момента", () => {
    fc.assert(fc.property(moment, (now) => {
      const { since, until } = duePeriod(now);
      const u = new Date(until);
      return new Date(until).getTime() - new Date(since).getTime() === 7 * 86400_000 && u.getUTCDay() === 1 && u.getUTCHours() === 0 && u <= now && now.getTime() - u.getTime() < 7 * 86400_000;
    }), { numRuns: 500 });
  });
  it("после построения отчёта повторный тик той же недели ничего не делает", () => {
    fc.assert(fc.property(moment, fc.integer({ min: 0, max: 6 * 86400_000 }), (now, later) => {
      const p = reportDue(now, [])!;
      const again = new Date(new Date(p.until).getTime() + ((now.getTime() - new Date(p.until).getTime() + later) % (7 * 86400_000)));
      return reportDue(again, [p.until]) === null;
    }), { numRuns: 300 });
  });
});

describe("L5 · реквизиты ИД (OS-INSP-2.3.2)", () => {
  it("документ с электронной подписью, DOCX/XML или заменённая редакция никогда не дают находки", () => {
    const kinds = ["seal", "signature", "stamp_production", "stamp_asbuilt", "date", "reg_number"] as const;
    fc.assert(fc.property(
      fc.constantFrom("pdf", "jpg", "png", "tif", "docx", "xml"),
      fc.constantFrom("UKEP", "SCAN_SIGNED", null),
      fc.constantFrom("CURRENT", "SUPERSEDED"),
      fc.subarray([...kinds]),
      fc.option(fc.constantFrom("Исполнительный чертёж плиты", "Паспорт двери"), { nil: null }),
      (kind, sig, role, found, title) => {
        const d: IdDoc = { file_id: "f", client_file_id: "c", sha256: "a", file_name: "x", kind: kind as any, document_code: "C", revision: "1", approval_status: "APPROVED", revision_role: role as any, signature_status: sig, title, requisites: found.map((k) => ({ kind: k, page: 1, bbox: null, confidence: 1 })) };
        const r = evaluateRequisites([d]);
        const exempt = sig === "UKEP" || kind === "docx" || kind === "xml" || role === "SUPERSEDED";
        return exempt ? r.length === 0 : r.length === (found.includes("signature") && (!title?.startsWith("Исполнительный") || (found.includes("stamp_production") && found.includes("stamp_asbuilt"))) ? 0 : 1);
      },
    ), { numRuns: 500 });
  });
});
