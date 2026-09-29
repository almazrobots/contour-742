// T-241: adversarial code-review regressions; synthetic fixtures, not an independent holdout.
import { describe, expect, it } from "vitest";
import { evaluateClassParam, type Mention } from "../src/domain/class-param.ts";
import { classPassport } from "../src/domain/passport.ts";
import { passportFor } from "../src/services/passports.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const param: Param = {
  code: "M-022", section: "ПЗ", parameter_name: "Степень огнестойкости здания", unit: "Степень",
  source_pd: "ПЗ", source_rd: "АР/КР", source_id: "Заключение ГПН", trigger_logic: "Снижение степени огнестойкости в РД",
  review_priority: "HIGH", data_type: "enum", compare: { kind: "decrease" }, anchors: [], regex_pattern: null,
  value_scale: null, applicability: null, is_active: true,
};
type SubjectEvidence = { subject_quote?: string | null; subject_bbox?: [number, number, number, number] | null };
let seq = 0;
const m = (stage: Stage, value: string, over: Partial<Mention & SubjectEvidence> = {}): Mention & SubjectEvidence => ({
  stage, value, file_id: `review-${++seq}`, sha256: "b".repeat(64), document_code: `2099-01-002-${stage}`,
  revision: "0", approval_status: stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role: "CURRENT",
  discipline: stage === "PD" ? "ПЗ" : "АР", base: "2099-01-002", qualifier: null, excluded: null,
  excluded_why: null, page: 1, bbox: [0.1, 0.3, 0.2, 0.35], quote: `Степень огнестойкости здания ${value}`,
  confidence: 1, ...over,
});
const run = (mentions: Mention[]) => evaluateClassParam({
  param, passport: classPassport(passportFor("M-022")!)!, mentions, loadedStages: ["PD", "RD"], profile: {},
});

describe("M-022: adversarial audit cases (T-241)", () => {
  it.each(["NEIGHBOR", "NORM_TABLE"])("unrelated %s does not block a supported equal pair", (excluded) => {
    const other = m("RD", "III", { excluded, excluded_why: "Синтетический чужой контекст" });
    const result = run([m("PD", "II"), m("RD", "II"), other]);
    expect(result.status).toBe("NEGATIVE_VERIFIED");
    expect(result.fragments.map((x) => x.file_id)).not.toContain(other.file_id);
    expect(result.provenance.mentions.find((x) => x.file_id === other.file_id)?.use).toBe("dropped");
  });

  it.each(["AMBIGUOUS_DEGREE", "AMBIGUOUS_SUBJECT"])("a correction replaces an ambiguous base (%s)", (excluded) => {
    const base = m("RD", "III", { document_code: "2099-01-002-АР", excluded, revision: "0" });
    const correction = m("RD", "II", { document_code: base.document_code, revision: "к1" });
    const result = run([m("PD", "II"), base, correction]);
    expect(result.status).toBe("NEGATIVE_VERIFIED");
    expect(result.fragments.map((x) => x.file_id)).toContain(correction.file_id);
    expect(result.fragments.map((x) => x.file_id)).not.toContain(base.file_id);
    expect(result.provenance.mentions.find((x) => x.file_id === base.file_id)?.use).toBe("dropped");
  });

  it("an unrelated correction must not hide an ambiguous current document", () => {
    const ambiguous = m("RD", "III", { document_code: "2099-01-002-АР", excluded: "AMBIGUOUS_DEGREE" });
    const correction = m("RD", "II", { document_code: "2099-01-002-КР", discipline: "КР", revision: "к1" });
    expect(run([m("PD", "II"), ambiguous, correction]).status).toBe("NOT_COMPARABLE");
  });

  it.each(["II", "I"])("compatible exact КР %s satisfies an АР lower bound II", (value) => {
    const constraint = m("RD", "II", { qualifier: "min", discipline: "АР" });
    const actual = m("RD", value, { discipline: "КР", document_code: "2099-01-002-КР" });
    const result = run([m("PD", "II"), constraint, actual]);
    expect(result.status).toBe("NEGATIVE_VERIFIED");
    expect(result.actual).toBe(value);
    expect(result.fragments.some((x) => x.file_id === actual.file_id && x.kind === "actual")).toBe(true);
    expect(result.provenance.mentions.find((x) => x.file_id === constraint.file_id)?.qualifier).toBe("min");
  });

  it("an exact value below the bound remains a conflict", () => {
    expect(run([
      m("PD", "II"), m("RD", "II", { qualifier: "min", discipline: "АР" }),
      m("RD", "III", { discipline: "КР", document_code: "2099-01-002-КР" }),
    ]).status).toBe("CLARIFICATION_REQUIRED");
  });

  it("unresolved explicit subject never compares as an unnamed object", () => {
    expect(run([m("PD", "II"), m("RD", "II", { subject_key: "unresolved" })]).status).toBe("NOT_COMPARABLE");
  });

  it("provenance retains the subject heading and its separate location", () => {
    const subject: SubjectEvidence = { subject_quote: "Корпус 1. Секция 2.", subject_bbox: [0.1, 0.1, 0.35, 0.2] };
    const pd = m("PD", "II", { subject_key: "building:1/section:2", ...subject });
    const rd = m("RD", "II", { subject_key: "building:1/section:2", ...subject });
    const result = run([pd, rd]);
    expect(result.status).toBe("NEGATIVE_VERIFIED");
    for (const original of [pd, rd]) {
      expect(result.provenance.mentions.find((x) => x.file_id === original.file_id)).toMatchObject({
        subject_key: original.subject_key, subject_quote: subject.subject_quote, subject_bbox: subject.subject_bbox,
        sha256: original.sha256, revision: original.revision, page: original.page,
      });
    }
  });
});
