// Модульные тесты предметного слоя. Название теста — ссылка трассы (model.yaml → impl → tests).
import { describe, expect, it } from "vitest";
import { evaluate, rank, stageRequired, violates } from "../src/domain/compare.ts";
import { loadCodes, scenario, stageLoad } from "../src/domain/completeness.ts";
import { buildDataset, eligible, publicationGate, splitOf } from "../src/domain/gold.ts";
import { applyDecision, canFinalize, canUnfinalize, canUpload, canVerify, objectColor, statusAfterDecision } from "../src/domain/lifecycle.ts";
import { preferCorrections, selectRevisions, type RevisionInput } from "../src/domain/revisions.ts";
import { cmp, dedupe, logical, nameSimilarity, normative, semantic } from "../src/domain/suspicions.ts";
import type { Param, SourceRef, Stage, StageValue } from "../src/domain/types.ts";
import { checkFile, checkPackage, MAX_FILE_BYTES, parseCsvManifest, sniff } from "../src/domain/upload.ts";

// ─────────────────────────────── фабрики

const P = (over: Partial<Param> = {}): Param => ({
  code: "M-002",
  section: "ПЗ",
  parameter_name: "Общая площадь здания",
  unit: "м²",
  source_pd: "ТЭП",
  source_rd: "ОД",
  source_id: "Техплан",
  trigger_logic: "Дельта > 1%",
  review_priority: "HIGH",
  data_type: "number",
  compare: { kind: "delta_pct", tolerance: 1 },
  anchors: ["Общая площадь"],
  regex_pattern: null,
  value_scale: null,
  applicability: null,
  is_active: true,
  ...over,
});

const src = (stage: Stage, role: SourceRef["role"] = "CURRENT"): SourceRef => ({
  file_id: `f-${stage}`,
  sha256: "a".repeat(64),
  stage,
  document_code: `X-${stage}`,
  revision: "1",
  approval_status: "APPROVED",
  page: 2,
  bbox: [0.8, 0.1, 0.9, 0.12],
  role,
});

const V = (stage: Stage, num: number | null, text: string | null = null, role: SourceRef["role"] = "CURRENT"): StageValue => ({
  stage,
  num,
  text,
  raw: String(num ?? text),
  source: src(stage, role),
});

const ALL: Stage[] = ["PD", "RD", "ID"];

// ─────────────────────────────── OS-INSP-1.2 приём файлов

describe("OS-INSP-1.2 приём файлов", () => {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n%%EOF\n");
  it("отклоняет неподдерживаемый формат с перечнем форматов", () => {
    const v = checkFile("фото.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    expect(v).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
    expect(!v.ok && v.message).toContain("PDF, DOCX, XML");
  });
  it("отклоняет файл больше 50 МБ и называет предел", () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1);
    big.write("%PDF-");
    const v = checkFile("big.pdf", big);
    expect(v).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(!v.ok && v.message).toContain("50 МБ");
    expect(checkFile("edge.pdf", Buffer.concat([pdf, Buffer.alloc(MAX_FILE_BYTES - pdf.length)])).ok).toBe(false); // нет %%EOF в хвосте
  });
  it("отклоняет пакет больше 200 МБ целиком", () => {
    expect(checkPackage([100 * 1048576, 100 * 1048576]).ok).toBe(true);
    const r = checkPackage([100 * 1048576, 100 * 1048576, 1]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("200 МБ");
  });
  it("отклоняет повреждённый PDF с просьбой загрузить повторно", () => {
    const v = checkFile("bad.pdf", Buffer.from("%PDF-1.7\n garbage"));
    expect(v).toMatchObject({ ok: false, code: "CORRUPTED" });
    expect(!v.ok && v.message).toContain("повторно");
    expect(checkFile("ok.pdf", pdf)).toEqual({ ok: true, kind: "pdf" });
  });
  it("определяет тип по содержимому, а не по расширению", () => {
    expect(sniff(Buffer.from("<?xml version='1.0'?><a/>"))).toBe("xml");
    expect(sniff(Buffer.from("﻿<Акт/>"))).toBe("xml");
    expect(sniff(Buffer.from("PK\x03\x04....word/document.xml"))).toBe("docx");
    expect(sniff(Buffer.from("PK\x03\x04....xl/workbook.xml"))).toBe("xlsx"); // GAP-INSP-04 (T-036): XLSX принимается
    expect(sniff(Buffer.from("просто текст"))).toBeNull();
  });
  it("читает реестр из CSV", () => {
    const m = parseCsvManifest("file_id;file_name;doc_stage;discipline;document_code;revision;approval_status\nA;a.pdf;PD;АР;X-1;1;APPROVED\n");
    expect(m.files[0]).toMatchObject({ file_id: "A", doc_stage: "PD", approval_status: "APPROVED" });
  });
});

// ─────────────────────────────── OS-INSP-1.3 редакции

describe("OS-INSP-1.3 актуальные редакции", () => {
  const f = (id: string, rev: string, status: RevisionInput["approval_status"], pred: string | null = null, code = "X-АР"): RevisionInput => ({
    file_id: id,
    client_file_id: id,
    doc_stage: "RD",
    document_code: code,
    revision: rev,
    approval_status: status,
    predecessor_id: pred,
  });
  it("выбирает эталоном последнюю утверждённую редакцию", () => {
    const r = selectRevisions([f("A", "A", "APPROVED"), f("B", "B", "FOR_CONSTRUCTION", "A")], true);
    expect(r.get("B")?.role).toBe("CURRENT");
    expect(r.get("A")?.role).toBe("SUPERSEDED");
  });
  it("исключает SUPERSEDED и CANCELLED из эталона и сохраняет их", () => {
    const r = selectRevisions([f("A", "A", "SUPERSEDED"), f("C", "C", "CANCELLED"), f("B", "B", "APPROVED")], true);
    expect([r.get("A")?.role, r.get("C")?.role, r.get("B")?.role]).toEqual(["SUPERSEDED", "SUPERSEDED", "CURRENT"]);
  });
  it("T-233: «Корр.N» — поправка поверх базы, не конфликт; две базы без поправки — по-прежнему конфликт", () => {
    const r = selectRevisions([f("B", "0", "APPROVED"), f("K1", "к1", "APPROVED"), f("K2", "к2", "APPROVED")], true);
    expect([r.get("B")?.role, r.get("K1")?.role, r.get("K2")?.role]).toEqual(["CURRENT", "CURRENT", "CURRENT"]);
    expect(r.get("B")?.note).toContain("база");
    expect(r.get("K2")?.note).toContain("поправка");
    const two = selectRevisions([f("B1", "0", "APPROVED"), f("B2", "0", "APPROVED"), f("K", "к1", "APPROVED")], true);
    expect([two.get("B1")?.role, two.get("B2")?.role, two.get("K")?.role]).toEqual(["CONFLICT", "CONFLICT", "CONFLICT"]);
  });
  it("T-233: preferCorrections — значение последней поправки главнее базы того же документа; без поправки база цела", () => {
    const m = (id: string, stage: string, code: string | null, revision: string) => ({ id, stage, document_code: code, revision });
    const got = preferCorrections([
      m("base", "PD", "ПЗ2", "0"), m("k1", "PD", "ПЗ2", "к1"), m("k2", "PD", "ПЗ2", "к2"),
      m("other", "PD", "ПБ", "0"), m("rd", "RD", "ПЗ2", "0"), m("nocode", "PD", null, "0"),
    ]).map((x) => x.id);
    expect(got).toEqual(["k2", "other", "rd", "nocode"]);
    expect(preferCorrections([m("base", "PD", "ПЗ2", "0")]).map((x) => x.id)).toEqual(["base"]);
  });
  it("помечает конфликт редакций и отсутствие утверждения", () => {
    const r = selectRevisions([f("1", "1", "APPROVED"), f("2", "2", "APPROVED"), f("D", "1", "DRAFT", null, "Y")], true);
    expect(r.get("1")?.role).toBe("CONFLICT");
    expect(r.get("2")?.role).toBe("CONFLICT");
    expect(r.get("D")?.role).toBe("UNRESOLVED");
    expect(r.get("1")?.note).toContain("1, 2");
  });
  it("пакет без реестра — все файлы UNRESOLVED", () => {
    const r = selectRevisions([f("A", "1", "APPROVED")], false);
    expect(r.get("A")?.role).toBe("UNRESOLVED");
  });
});

// ─────────────────────────────── OS-INSP-1.4 комплектность

describe("OS-INSP-1.4 комплектность и сценарий", () => {
  const c = (pd: [number, number], rd: [number, number], id: [number, number]) => ({
    PD: { declared: pd[0], uploaded: pd[1] },
    RD: { declared: rd[0], uploaded: rd[1] },
    ID: { declared: id[0], uploaded: id[1] },
  });
  it("присваивает стадии UPLOADED, PARTIAL или MISSING", () => {
    expect(loadCodes(c([2, 2], [3, 1], [0, 0]))).toEqual(["PD_UPLOADED", "RD_PARTIAL", "ID_MISSING"]);
    expect(stageLoad({ declared: 0, uploaded: 2 })).toBe("UPLOADED");
  });
  it.each([
    [c([1, 1], [1, 1], [1, 1]), "FULL"],
    [c([1, 1], [1, 1], [0, 0]), "PD_RD_ONLY"],
    [c([1, 1], [0, 0], [1, 1]), "PD_ID_ONLY"],
    [c([0, 0], [1, 1], [1, 1]), "RD_ID_ONLY"],
    [c([0, 0], [1, 1], [0, 0]), "SINGLE_ONLY"],
    [c([1, 1], [1, 1], [15, 5]), "PARTIALLY_LOADED"],
    [c([0, 0], [0, 0], [0, 0]), "NO_DOCUMENTS"],
  ])("определяет сценарий проверки %#", (counts, want) => {
    expect(scenario(counts)).toBe(want);
  });
  it("считает стадию PARTIAL, когда реестр объявляет больше файлов", () => {
    expect(stageLoad({ declared: 15, uploaded: 5 })).toBe("PARTIAL");
    expect(stageLoad({ declared: 5, uploaded: 5 })).toBe("UPLOADED");
  });
});

// ─────────────────────────────── OS-INSP-3.1 сравнение

describe("OS-INSP-3.1 сопоставление источников", () => {
  it("проверяет применимость до сравнения значений", () => {
    const e = evaluate({ param: P({ applicability: "underground" }), profile: { underground: false }, values: [V("PD", 1), V("RD", 999)], loadedStages: ALL });
    expect(e.status).toBe("NOT_APPLICABLE");
  });
  it("ставит MISSING_EVIDENCE без обязательного источника", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 12450)], loadedStages: ALL });
    expect(e.status).toBe("MISSING_EVIDENCE");
    expect(e.reason).toContain("RD");
    expect(evaluate({ param: P(), profile: {}, values: [], loadedStages: ALL }).status).toBe("MISSING_EVIDENCE");
  });
  it("ставит CLARIFICATION_REQUIRED при неопределённой редакции", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 9200), V("RD", 9180, null, "CONFLICT")], loadedStages: ALL });
    expect(e.status).toBe("CLARIFICATION_REQUIRED");
    const u = evaluate({ param: P(), profile: {}, values: [V("PD", 9200), V("RD", 9200, null, "UNRESOLVED")], loadedStages: ALL });
    expect(u.status).toBe("CLARIFICATION_REQUIRED");
  });
  it("ставит NOT_COMPARABLE для несопоставимых значений", () => {
    expect(evaluate({ param: P(), profile: {}, values: [V("PD", 100), V("RD", null, "сто")], loadedStages: ALL }).status).toBe("NOT_COMPARABLE");
    const enumP = P({ compare: { kind: "decrease" }, data_type: "enum", value_scale: ["C", "B", "A"] });
    expect(evaluate({ param: enumP, profile: {}, values: [V("PD", null, "A"), V("RD", null, "Z")], loadedStages: ALL }).status).toBe("NOT_COMPARABLE");
  });
  it("ставит CANDIDATE при превышении порога с expected, actual и delta", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 12450), V("RD", 12710), V("ID", 12705)], loadedStages: ALL });
    expect(e).toMatchObject({ status: "CANDIDATE", expected: "12450", actual: "12705" });
    expect(e.delta).toBe("+2.05 %");
    expect(e.fragments.map((f) => f.kind)).toEqual(["expected", "actual", "actual"]);
  });
  it("ставит NEGATIVE_VERIFIED в пределах порога", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 15600), V("RD", 15650)], loadedStages: ALL });
    expect(e.status).toBe("NEGATIVE_VERIFIED");
    // ровно 1 % — ещё в допуске («> 1 %» — нарушение)
    expect(evaluate({ param: P(), profile: {}, values: [V("PD", 100), V("RD", 101)], loadedStages: ALL }).status).toBe("NEGATIVE_VERIFIED");
    expect(evaluate({ param: P(), profile: {}, values: [V("PD", 100), V("RD", 101.01)], loadedStages: ALL }).status).toBe("CANDIDATE");
  });
  it("никогда не присваивает CONFIRMED_VIOLATION сама", () => {
    const params = [P(), P({ compare: { kind: "equal" } }), P({ compare: { kind: "min", min: 0.9 } }), P({ compare: { kind: "decrease" } })];
    for (const param of params)
      for (const vals of [[V("PD", 1), V("RD", 0)], [V("PD", 1), V("RD", 2)], [V("RD", 0.5)]])
        expect(evaluate({ param, profile: {}, values: vals, loadedStages: ALL }).status).not.toBe("CONFIRMED_VIOLATION");
  });
  it("ставит NOT_APPLICABLE с основанием", () => {
    const e = evaluate({ param: P({ applicability: "demolition" }), profile: { demolition: false }, values: [], loadedStages: ALL });
    expect(e.reason).toContain("снос");
    // неизвестный признак профиля — параметр применим
    expect(evaluate({ param: P({ applicability: "demolition" }), profile: {}, values: [], loadedStages: ALL }).status).toBe("MISSING_EVIDENCE");
  });
  it("проверяет порог min по каждой стадии", () => {
    const door = P({ code: "M-041", compare: { kind: "min", min: 0.9 }, unit: "м" });
    const e = evaluate({ param: door, profile: {}, values: [V("PD", 1.2), V("RD", 0.85)], loadedStages: ALL });
    expect(e).toMatchObject({ status: "CANDIDATE", actual: "0.85", delta: "-0.05" });
    expect(evaluate({ param: door, profile: {}, values: [V("RD", 0.9)], loadedStages: ALL }).status).toBe("NEGATIVE_VERIFIED");
    expect(evaluate({ param: door, profile: {}, values: [], loadedStages: ALL }).status).toBe("MISSING_EVIDENCE");
    const cap = P({ compare: { kind: "max", max: 10 } });
    expect(evaluate({ param: cap, profile: {}, values: [V("RD", 11)], loadedStages: ALL }).status).toBe("CANDIDATE");
    expect(evaluate({ param: cap, profile: {}, values: [V("RD", 10)], loadedStages: ALL }).status).toBe("NEGATIVE_VERIFIED");
  });
  it("понижение класса бетона — кандидат, повышение — нет", () => {
    const concrete = P({ code: "M-055", compare: { kind: "decrease" }, data_type: "enum", value_scale: "numeric_suffix" });
    expect(evaluate({ param: concrete, profile: {}, values: [V("PD", null, "B30"), V("RD", null, "B30"), V("ID", null, "B25")], loadedStages: ALL })).toMatchObject({
      status: "CANDIDATE",
      delta: "B30 → B25",
    });
    expect(evaluate({ param: concrete, profile: {}, values: [V("PD", null, "B30"), V("ID", null, "B35")], loadedStages: ALL }).status).toBe("NEGATIVE_VERIFIED");
    const energy = P({ compare: { kind: "decrease" }, value_scale: ["E", "D", "C", "B", "A", "A+", "A++"] });
    expect(evaluate({ param: energy, profile: {}, values: [V("PD", null, "B"), V("RD", null, "C")], loadedStages: ALL }).status).toBe("CANDIDATE");
  });
  it("превышение и равенство", () => {
    const up = P({ compare: { kind: "increase" } });
    expect(violates(up, V("PD", 39.6), V("RD", 40))?.bad).toBe(true);
    expect(violates(up, V("PD", 39.6), V("RD", 39.6))?.bad).toBe(false);
    const eq = P({ compare: { kind: "equal" } });
    expect(violates(eq, V("PD", 12), V("RD", 13))).toEqual({ bad: true, delta: "+1" });
    expect(violates(eq, V("PD", null, "II"), V("RD", null, "II"))).toEqual({ bad: false, delta: "0" });
    expect(violates(eq, V("PD", null, "II"), V("RD", null, "III"))).toEqual({ bad: true, delta: "II → III" });
    expect(violates(P(), V("PD", 0), V("RD", 1))).toBeNull();
  });
  it("стадия, не загруженная в проверку, отмечается NOT_APPLICABLE", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 1), V("RD", 1)], loadedStages: ["PD", "RD"] });
    expect(e.stage_notes).toEqual({ PD: "USED", RD: "USED", ID: "NOT_APPLICABLE" });
    expect(stageRequired(P({ source_id: "—" }), "ID")).toBe(false);
    expect(stageRequired(P({ source_id: "  " }), "ID")).toBe(false);
  });
  it("ранг порядковых величин", () => {
    expect(rank(P({ value_scale: "numeric_suffix" }), "EI60")).toBe(60);
    expect(rank(P({ value_scale: "numeric_suffix" }), "B22,5")).toBe(22.5);
    expect(rank(P({ value_scale: ["V", "IV", "III", "II", "I"] }), "II")).toBe(3);
    expect(rank(P({ value_scale: null }), "II")).toBeNull();
  });
});

// ─────────────────────────────── OS-INSP-3.2 гипотезы

describe("OS-INSP-3.2 гипотезы", () => {
  const rule = { id: 1, rule_name: "Здание выше 10 этажей оборудуется лифтом", condition: { key: "M-007", op: ">" as const, value: 10 }, expected: { key: "LIFTS", op: ">" as const, value: 0 }, normative_base: "СП 54.13330.2022, п. 7.1.3", is_active: true };
  it("проверяет активные логические правила по фактам объекта", () => {
    const s = logical([rule], [{ key: "M-007", num: 12, text: null, stage: "PD", ref: "ПЗ, стр. 2" }, { key: "LIFTS", num: 0, text: null, stage: "PD", ref: "ПЗ, стр. 2" }]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ discovery_method: "LOGICAL_ANALYSIS", review_priority: "HIGH", pd_reference: "ПЗ, стр. 2" });
    expect(logical([rule], [{ key: "M-007", num: 10, text: null, stage: "PD", ref: "" }])).toHaveLength(0);
    expect(logical([{ ...rule, is_active: false }], [{ key: "M-007", num: 12, text: null, stage: "PD", ref: "" }])).toHaveLength(0);
    expect(logical([rule], [{ key: "M-007", num: 12, text: null, stage: "PD", ref: "" }, { key: "LIFTS", num: 2, text: null, stage: "PD", ref: "" }])).toHaveLength(0);
  });
  it("семантический диссонанс назначений помещений", () => {
    const s = semantic([
      { number: "0.12", name: "Техническое помещение", stage: "PD", ref: "a" },
      { number: "0.12", name: "Склад ГСМ", stage: "RD", ref: "b" },
      { number: "1.05", name: "Регистратура", stage: "PD", ref: "a" },
      { number: "1.05", name: "Регистратура", stage: "RD", ref: "b" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ discovery_method: "SEMANTIC_DISSONANCE", review_priority: "HIGH" });
    expect(nameSimilarity("Кабинет врача", "Кабинет врача-терапевта")).toBeGreaterThan(0.3);
  });
  it("нормативный анализ пропускает параметры, уже попавшие в кандидаты", () => {
    const norms = [{ document_name: "СП", document_number: "СП 1.13130.2020", section: "п. 4.2.5", param_code: "M-041", min_value: 0.9, max_value: null, is_active: true }];
    const facts = [{ key: "M-041", num: 0.85, text: null, stage: "RD" as const, ref: "r" }];
    expect(normative(norms, facts, new Set())).toHaveLength(1);
    expect(normative(norms, facts, new Set(["M-041"]))).toHaveLength(0);
  });
  it("объединяет одинаковые гипотезы только внутри объекта", () => {
    const a = { discovery_method: "LOGICAL_ANALYSIS" as const, confidence: 0.6, description: "x", pd_reference: null, rd_reference: null, review_priority: "HIGH" as const, normative_base: null, dedup_key: "LOGICAL:1" };
    expect(dedupe([a, { ...a, confidence: 0.9 }, { ...a, dedup_key: "LOGICAL:2" }]).map((x) => x.confidence)).toEqual([0.9, 0.6]);
  });
  it("операторы сравнения", () => {
    expect([cmp(2, ">", 1), cmp(1, ">=", 1), cmp(0, "<", 1), cmp(1, "<=", 1), cmp(1, "==", 1), cmp(1, "!=", 2)]).toEqual([true, true, true, true, true, true]);
    expect([cmp(1, ">", 1), cmp(0, ">=", 1), cmp(1, "<", 1), cmp(2, "<=", 1), cmp(1, "==", 2), cmp(1, "!=", 1)]).toEqual([false, false, false, false, false, false]);
  });
});

// ─────────────────────────────── OS-INSP-4 верификация и жизненный цикл

describe("OS-INSP-4 верификация и финализация", () => {
  const cand = { finding_status: "CANDIDATE" as const, verification_status: "PENDING" as const };
  const done = { finding_status: "CANDIDATE" as const, verification_status: "CONFIRMED_VIOLATION" as const };
  it("подтверждение ставит CONFIRMED_VIOLATION", () => {
    expect(applyDecision({ action: "confirm" })).toEqual({ status: "CONFIRMED_VIOLATION" });
  });
  it("отклонение требует reason_code и комментарий", () => {
    expect(applyDecision({ action: "reject", reason_code: "", comment: "x" })).toHaveProperty("error");
    expect(applyDecision({ action: "reject", reason_code: "OCR_ERROR", comment: "  " })).toHaveProperty("error");
    expect(applyDecision({ action: "reject", reason_code: "OCR_ERROR", comment: "скан" })).toEqual({ status: "NEGATIVE_VERIFIED" });
  });
  it("запрос уточнения ставит CLARIFICATION_REQUIRED", () => {
    expect(applyDecision({ action: "clarify" })).toEqual({ status: "CLARIFICATION_REQUIRED" });
  });
  it("не даёт финализировать с необработанным кандидатом", () => {
    expect(canFinalize("VERIFYING", [cand, done]).ok).toBe(false);
    expect(canFinalize("COMPLETED", [done, { finding_status: "CANDIDATE", verification_status: "CLARIFICATION_REQUIRED" }]).ok).toBe(true);
    expect(canFinalize("FINALIZED", []).ok).toBe(false);
    expect(canFinalize("PARSING", []).ok).toBe(false);
    expect(canFinalize("READY", [{ finding_status: "MISSING_EVIDENCE", verification_status: "PENDING" }]).ok).toBe(true);
  });
  it("после финализации запрещает дозагрузку и смену статусов", () => {
    expect(canUpload("FINALIZED")).toBe(false);
    expect(canVerify("FINALIZED")).toBe(false);
    expect(canUpload("PARSING")).toBe(false);
    for (const s of ["PENDING", "READY", "VERIFYING", "COMPLETED"] as const) expect(canUpload(s)).toBe(true);
    expect(canVerify("READY") && canVerify("VERIFYING")).toBe(true);
    expect(canVerify("COMPLETED")).toBe(false);
  });
  it("отмена финализации — только супервизор или администратор с причиной", () => {
    expect(canUnfinalize("FINALIZED", "inspector", "причина есть").ok).toBe(false);
    expect(canUnfinalize("FINALIZED", "supervisor", "").ok).toBe(false);
    expect(canUnfinalize("FINALIZED", "supervisor", "ошибка в реестре").ok).toBe(true);
    expect(canUnfinalize("FINALIZED", "admin", "ошибка в реестре").ok).toBe(true);
    expect(canUnfinalize("COMPLETED", "admin", "ошибка в реестре").ok).toBe(false);
  });
  it("статус процесса после решения", () => {
    expect(statusAfterDecision([cand])).toBe("VERIFYING");
    expect(statusAfterDecision([done])).toBe("COMPLETED");
  });
});

// ─────────────────────────────── OS-INSP-8.1 дашборд

describe("OS-INSP-8.1 цвет объекта", () => {
  it("окрашивает объект по кандидатам и нарушениям", () => {
    expect(objectColor([{ finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING" }])).toBe("green");
    expect(objectColor([{ finding_status: "CANDIDATE", verification_status: "PENDING" }])).toBe("yellow");
    expect(objectColor([{ finding_status: "CLARIFICATION_REQUIRED", verification_status: "PENDING" }])).toBe("yellow");
    expect(objectColor([{ finding_status: "CANDIDATE", verification_status: "CLARIFICATION_REQUIRED" }])).toBe("yellow");
    expect(objectColor([{ finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION" }, { finding_status: "CANDIDATE", verification_status: "PENDING" }])).toBe("red");
    expect(objectColor([{ finding_status: "CANDIDATE", verification_status: "NEGATIVE_VERIFIED" }])).toBe("green");
  });
});

// ─────────────────────────────── OS-INSP-6 GOLD и допуск модели

describe("OS-INSP-6 GOLD", () => {
  const c = (object_id: string, status: string, fragments = 2) => ({ evidence_group_id: `${object_id}:M-1`, finding_id: `${object_id}-${status}`, object_id, param_code: "M-1", verification_status: status, reason_code: null, fragments, expert_id: "u1" });
  it("включает в набор только подтверждённые и отклонённые с карточкой", () => {
    expect(eligible(c("A", "CONFIRMED_VIOLATION"))).toBe(true);
    expect(eligible(c("A", "NEGATIVE_VERIFIED"))).toBe(true);
    for (const s of ["CANDIDATE", "SUSPICION", "MISSING_EVIDENCE", "CLARIFICATION_REQUIRED", "PENDING"]) expect(eligible(c("A", s))).toBe(false);
    expect(eligible(c("A", "CONFIRMED_VIOLATION", 0))).toBe(false);
    expect(eligible({ ...c("A", "CONFIRMED_VIOLATION"), expert_id: null })).toBe(false);
  });
  it("разбивает набор по object_id", () => {
    const objs = Array.from({ length: 60 }, (_, i) => `OBJ-${i}`);
    const { items } = buildDataset(objs.flatMap((o) => [c(o, "CONFIRMED_VIOLATION"), { ...c(o, "NEGATIVE_VERIFIED"), finding_id: `${o}-n` }]));
    const byObj = new Map<string, Set<string>>();
    for (const i of items) byObj.set(i.object_id, (byObj.get(i.object_id) ?? new Set()).add(i.split));
    for (const s of byObj.values()) expect(s.size).toBe(1);
    expect(new Set(items.map((i) => i.split))).toEqual(new Set(["train", "validation", "test"]));
    expect(splitOf("OBJ-1")).toBe(splitOf("OBJ-1"));
  });
  it("фиксирует хеш каждой выборки", () => {
    const a = buildDataset([c("A", "CONFIRMED_VIOLATION")]);
    const b = buildDataset([c("A", "CONFIRMED_VIOLATION")]);
    expect(a.hashes).toEqual(b.hashes);
    expect(Object.values(a.hashes).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(a.items[0].gold_label).toBe("POSITIVE");
  });
  it("блокирует публикацию при падении Recall или росте FPR больше 2 п.п.", () => {
    const base = { recall_by_category: { КР: 0.85, АР: 0.82 }, false_positive_rate: 0.05, precision: 0.92, recall: 0.84, f1: 0.88 };
    expect(publicationGate(base, base).ok).toBe(true);
    expect(publicationGate(base, { ...base, recall_by_category: { КР: 0.82, АР: 0.82 } }).ok).toBe(false);
    expect(publicationGate(base, { ...base, recall_by_category: { КР: 0.83, АР: 0.82 } }).ok).toBe(true);
    expect(publicationGate(base, { ...base, false_positive_rate: 0.075 }).ok).toBe(false);
    expect(publicationGate(null, { ...base, precision: 0.89 }).reasons[0]).toContain("Precision");
  });
});

// ─────────────────────────────── OS-INSP-2.2.9 строковый параметр с числовым правилом

describe("OS-INSP-2.2.9 строка с числовым правилом сравнивается по главному числу", () => {
  const stairs = P({ code: "M-048", data_type: "string", compare: { kind: "decrease" }, unit: "шт." });
  it("число есть на обеих стадиях — сравнение идёт: уменьшение — CANDIDATE, равенство — NEGATIVE_VERIFIED", () => {
    const bad = evaluate({ param: stairs, profile: {}, values: [V("PD", 3, "3 марша"), V("RD", 2, "2 марша")], loadedStages: ALL });
    expect(bad).toMatchObject({ status: "CANDIDATE", delta: "-1" });
    const ok = evaluate({ param: stairs, profile: {}, values: [V("PD", 3, "3 марша"), V("RD", 3, "3 марша")], loadedStages: ALL });
    expect(ok.status).toBe("NEGATIVE_VERIFIED");
  });
  it("на одной стадии числа нет — NOT_COMPARABLE, а не нарушение", () => {
    const r = evaluate({ param: stairs, profile: {}, values: [V("PD", 3, "3 марша"), V("RD", null, "по проекту")], loadedStages: ALL });
    expect(r.status).toBe("NOT_COMPARABLE");
  });
});

// ─────────────────────────────── T-133 на экране — слова документа, а не ключ сравнения

describe("T-133 значение на экране: код — ключом, текст — словами документа", () => {
  const road = P({ code: "M-032", data_type: "string", compare: { kind: "equal" }, unit: "" });
  const sv = (stage: Stage, key: string, raw: string): StageValue => ({ ...V(stage, null, key), raw });
  it("текст: ключ «ПPOEЗДOBДЛЯ…» (латиница-двойник, без пробелов) не показывается — показывается текст документа", () => {
    const r = evaluate({ param: road, profile: {}, values: [sv("PD", "ПPOEЗДOBДЛЯПOЖAPHOЙTEXHИKИ", "проездов для пожарной техники"), sv("RD", "ПPOEЗДOBДЛЯПOЖAPHOЙTEXHИKИ", "проездов  для пожарной\nтехники")], loadedStages: ALL });
    expect([r.expected, r.actual]).toEqual(["проездов для пожарной техники", "проездов для пожарной техники"]);
    expect(r.fragments.map((f) => f.value)).toEqual(["проездов для пожарной техники", "проездов для пожарной техники"]);
  });
  it("код: B25, A500C, EI60, III — ключом (сравнение и экран совпадают)", () => {
    const concrete = P({ code: "M-055", data_type: "string", compare: { kind: "equal" }, unit: "" });
    const r = evaluate({ param: concrete, profile: {}, values: [sv("PD", "B25", "В 25"), sv("RD", "B25", "В25")], loadedStages: ALL });
    expect([r.expected, r.actual]).toEqual(["B25", "B25"]);
  });
});
