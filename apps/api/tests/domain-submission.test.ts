// T-117 (OS-INSP-5.1.3–5.1.5): ответ в формате организатора (submission_schema.json, SRC-INSP-08) — сборка, метки, схема.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts"; // корень репо вверх по дереву: песочница Stryker глубже tests/
import { answerLabel, buildSubmission, SubmissionRefused, validateSubmission, type SubmissionCheck } from "../src/domain/submission.ts";

const schema = JSON.parse(readFileSync(join(config.root, "data/seed/organizer/submission_schema.json"), "utf8"));
const codes = JSON.parse(readFileSync(join(config.root, "data/seed/organizer/parameter-codes.json"), "utf8")).params;

const frag = (stage: string, file_id: string, page: number | null, value: string | null) => ({ stage, file_id, page, value });
const check = (o: Partial<SubmissionCheck>): SubmissionCheck => ({
  id: "F-1", param_code: "M-055", section: "КР", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", parent_id: null, fragments: [], ...o,
});
const FILES = { "f-kr": "F0012", "f-kzh": "F0031" };

describe("метка нарушения и статус протокола (OS-INSP-5.1.4)", () => {
  it("кандидат и подтверждённое нарушение — VIOLATION_PRESENT; критический параметр — CRITICAL, существенный — WARNING", () => {
    expect(answerLabel(check({ finding_status: "CANDIDATE" }), true)).toEqual({ violation_label: "VIOLATION_PRESENT", protocol_status: "CRITICAL" });
    expect(answerLabel(check({ finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION" }), false)).toEqual({ violation_label: "VIOLATION_PRESENT", protocol_status: "WARNING" });
  });
  it("расхождения нет или инспектор снял кандидата — NO_VIOLATION / OK", () => {
    expect(answerLabel(check({ finding_status: "NEGATIVE_VERIFIED" }), true)).toEqual({ violation_label: "NO_VIOLATION", protocol_status: "OK" });
    expect(answerLabel(check({ finding_status: "CANDIDATE", verification_status: "NEGATIVE_VERIFIED" }), true)).toEqual({ violation_label: "NO_VIOLATION", protocol_status: "OK" });
  });
  it("нет доказательства — MISSING_DOCUMENT и первая недостающая стадия: ПД, затем РД, затем ИД", () => {
    const m = (stages: string[]) => answerLabel(check({ finding_status: "MISSING_EVIDENCE", fragments: stages.map((s) => frag(s, "f-kr", 1, "x")) }), true);
    expect(m([])).toEqual({ violation_label: "MISSING_DOCUMENT", protocol_status: "PD_MISSING" });
    expect(m(["PD"])).toEqual({ violation_label: "MISSING_DOCUMENT", protocol_status: "RD_MISSING" });
    expect(m(["PD", "RD"])).toEqual({ violation_label: "MISSING_DOCUMENT", protocol_status: "ID_MISSING" });
  });
  it("несопоставимо и требует уточнения — COMPARISON_IMPOSSIBLE; неприменимо — в ответ не входит", () => {
    for (const s of ["NOT_COMPARABLE", "CLARIFICATION_REQUIRED"]) expect(answerLabel(check({ finding_status: s }), true)).toEqual({ violation_label: "COMPARISON_IMPOSSIBLE", protocol_status: "COMPARISON_IMPOSSIBLE" });
    expect(answerLabel(check({ finding_status: "NOT_APPLICABLE" }), true)).toBeNull();
    expect(answerLabel(check({ finding_status: "CANDIDATE", verification_status: "CLARIFICATION_REQUIRED" }), true)).toEqual({ violation_label: "COMPARISON_IMPOSSIBLE", protocol_status: "COMPARISON_IMPOSSIBLE" });
  });
  it("статус без соответствия — отказ выгрузки с названием статуса, а не молчаливый пропуск", () => {
    expect(() => answerLabel(check({ finding_status: "SOMETHING_NEW" }), true)).toThrow(SubmissionRefused);
    expect(() => answerLabel(check({ finding_status: "SOMETHING_NEW" }), true)).toThrow(/SOMETHING_NEW/);
    expect(() => answerLabel(check({ finding_status: "CANDIDATE", verification_status: "ODD" }), true)).toThrow(/ODD/);
  });
});

describe("сборка ответа (OS-INSP-5.1.3)", () => {
  const sub = buildSubmission({
    object_id: "ALT-79B",
    codes,
    files: FILES,
    checks: [
      check({ id: "F-55", param_code: "M-055", fragments: [frag("PD", "f-kr", 19, "B25"), frag("RD", "f-kzh", 11, "B25")] }),
      check({ id: "F-59", param_code: "M-059", finding_status: "MISSING_EVIDENCE" }),
      check({ id: "F-30", param_code: "M-030", section: "СПЗУ", finding_status: "CANDIDATE", fragments: [frag("PD", "f-kr", 4, "6"), frag("RD", "f-kzh", 2, "4,2")] }),
      check({ id: "F-7", param_code: "M-007", finding_status: "NOT_APPLICABLE" }),
      check({ id: "SUSP-1", param_code: "SUSP-1", finding_status: "CANDIDATE", verification_status: "CLARIFICATION_REQUIRED" }),
      check({ id: "SUSP-2", param_code: "SUSP-2", finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION", fragments: [frag("PD", "f-kr", 6, "С1")] }),
      check({ id: "REQ-F0012", param_code: "REQ-F0012", finding_status: "MISSING_EVIDENCE" }),
      check({ id: "F-55a", param_code: "M-055", parent_id: "F-55", finding_status: "CANDIDATE" }),
    ],
  });
  it("код Матрицы — код организатора, значения по стадиям, доказательства — идентификатор файла из реестра и страница PDF", () => {
    expect(sub.object_id).toBe("ALT-79B");
    expect(sub.checks[0]).toEqual({
      parameter_code: "KR-055", location: "BUILDING", pd_value: "B25", rd_value: "B25", id_value: null,
      violation_label: "NO_VIOLATION", protocol_status: "OK", criticality: "Критическое (приостановка работ)",
      evidence: [{ stage: "PD", file_id: "F0012", pdf_page_number: 19 }, { stage: "RD", file_id: "F0031", pdf_page_number: 11 }],
    });
  });
  it("участок (СПЗУ, ЗУ) — место SITE; параметр без доказательства — пустой список доказательств", () => {
    expect(sub.checks.find((c) => c.parameter_code === "SPZU-030")?.location).toBe("SITE");
    expect(sub.checks.find((c) => c.parameter_code === "KR-059")).toMatchObject({ violation_label: "MISSING_DOCUMENT", protocol_status: "PD_MISSING", evidence: [] });
  });
  it("в ответ не входят: неприменимое, реквизиты REQ-*, неподтверждённая гипотеза, разделённые части; подтверждённая гипотеза — FREE-код", () => {
    const codesOut = sub.checks.map((c) => c.parameter_code);
    expect(codesOut).not.toContain("PZ-007");
    expect(codesOut.filter((c) => c === "KR-055")).toHaveLength(1);
    expect(codesOut.some((c) => c.startsWith("REQ"))).toBe(false);
    expect(codesOut.filter((c) => c.startsWith("FREE-"))).toEqual(["FREE-SUSP-2"]);
  });
  it("файл без номера в реестре — наш идентификатор; страница < 1 или неизвестна — доказательство не выдумывается", () => {
    const s = buildSubmission({ object_id: "O", codes, files: {}, checks: [check({ fragments: [frag("PD", "f-x", 3, "B25"), frag("RD", "f-y", null, "B25"), frag("ID", "f-z", 0, "B25")] })] });
    expect(s.checks[0].evidence).toEqual([{ stage: "PD", file_id: "f-x", pdf_page_number: 3 }]);
  });
  it("ответ проходит схему организатора", () => {
    expect(validateSubmission(sub, schema)).toEqual([]);
  });
});

describe("проверка по схеме организатора (OS-INSP-5.1.5)", () => {
  it("нарушение схемы называет поле: путь до записи и имя", () => {
    const bad = { object_id: "O", checks: [{ parameter_code: "KR-055", location: "BUILDING", violation_label: "MAYBE", evidence: [{ stage: "PD", file_id: "F1", pdf_page_number: 0 }] }] };
    const errs = validateSubmission(bad, schema);
    expect(errs.map((e) => e.field)).toEqual(expect.arrayContaining(["/checks/0/violation_label", "/checks/0/evidence/0/pdf_page_number"]));
    expect(validateSubmission({ checks: [] }, schema).map((e) => e.field)).toContain("/object_id");
  });
});

describe("схема организатора — один источник", () => {
  it("копия в data/seed (едет в образ API) совпадает с копией оценки ML (ml/eval/organizer_spec)", () => {
    const ml = JSON.parse(readFileSync(join(config.root, "ml/eval/organizer_spec/submission_schema.json"), "utf8"));
    expect(schema).toEqual(ml);
  });
});

describe("выгрузка: ветки и граничные случаи (мутационная полнота)", () => {
  const one = (c: Partial<SubmissionCheck>) => buildSubmission({ object_id: "O", codes, files: {}, checks: [check(c)] }).checks;
  it("отказ называет поле и статус; параметр вне каталога — отказ с кодом", () => {
    const refused = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof SubmissionRefused ? [e.field, e.message] : ["?", String(e)]; } };
    expect(refused(() => answerLabel(check({ verification_status: "ODD" }), true))).toEqual(["verification_status", "Решение инспектора «ODD» не имеет метки в схеме организатора"]);
    expect(refused(() => answerLabel(check({ finding_status: "NEW" }), true))).toEqual(["finding_status", "Статус сверки «NEW» не имеет метки в схеме организатора"]);
    expect(refused(() => one({ param_code: "M-999" }))).toEqual(["parameter_code", "Параметр M-999 не найден в каталоге организатора"]);
  });
  it("коды: только М-NNN и SUSP-N целиком; ЗУ — SITE; гипотеза — не критична, без критичности", () => {
    expect(one({ param_code: "M-0550" })).toEqual([]);
    expect(one({ param_code: "XM-055" })).toEqual([]);
    expect(one({ param_code: "SUSP-1a", verification_status: "CONFIRMED_VIOLATION" })).toEqual([]);
    expect(one({ param_code: "M-129", section: "ЗУ" })[0].location).toBe("SITE");
    expect(one({ param_code: "SUSP-7", finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION" })[0]).toMatchObject({ parameter_code: "FREE-SUSP-7", protocol_status: "WARNING", criticality: null });
    expect(one({ param_code: "M-001", finding_status: "CANDIDATE" })[0]).toMatchObject({ parameter_code: "PZ-001", protocol_status: "CRITICAL", criticality: "Критическое (приостановка работ)" });
  });
  it("значение стадии — первое непустое; доказательство — только стадии ПД/РД/ИД", () => {
    const r = one({ fragments: [frag("PD", "a", 1, null), frag("PD", "b", 2, "B30"), frag("XX", "c", 3, "?"), frag("ID", "d", 4, "B25")] })[0];
    expect([r.pd_value, r.rd_value, r.id_value]).toEqual(["B30", null, "B25"]);
    expect(r.evidence.map((e) => e.stage)).toEqual(["PD", "PD", "ID"]);
  });
  it("ошибка схемы без текста — ключевое слово; валидатор компилируется один раз на схему", () => {
    expect(validateSubmission({ object_id: "O", checks: [] }, schema)).toEqual([]);
    expect(validateSubmission({ object_id: 1, checks: [] }, schema)).toEqual([{ field: "/object_id", message: "must be string" }]);
    const custom = { type: "object", required: ["x"] };
    expect(validateSubmission({}, custom)).toEqual([{ field: "/x", message: "must have required property 'x'" }]);
    expect(validateSubmission({ x: 1 }, custom)).toEqual([]);
  });
});
