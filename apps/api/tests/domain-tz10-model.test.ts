// T-234: модель данных ТЗ §10 — предметные правила новых и оживлённых полей. L1 (правило), L3 (границы), L6 (отказы).
// Название теста — ссылка трассы (model.yaml → impl).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { blobFilePath, shaFromFilePath } from "../src/domain/blob-crypto.ts";
import { canResolveDispute, DISPUTE_RESOLUTIONS, retrainingCounts, retrainingUpdates } from "../src/domain/feedback-logs.ts";
import { resolveNorm, type NormRecord } from "../src/domain/geom-ops.ts";
import { datasetIssues, datasetSummary, publicationGate, type DatasetItemRow } from "../src/domain/gold.ts";
import { evaluateGeometry } from "../src/domain/kinds/geometry.ts";
import { activeModel, artifactIntact, categoryRecalls, gatePrevious, perCategoryFromRecall, rollbackPlan, splitHashesMatch, type ModelRow } from "../src/domain/model-registry.ts";
import { normEffective, normRecordFromRow, normSeedRow, paramsForNorm, type SeedNorm } from "../src/domain/norm-base.ts";
import { normativeRefs } from "../src/domain/normative-refs.ts";
import { baseMention, kindOf, kindSlice, type KindRow } from "../src/domain/param-kinds.ts";
import { buildProtocol, completenessOf, completenessStatus, COMPLETENESS_STATUSES } from "../src/domain/protocol.ts";
import { normative, type Fact, type NormEntry } from "../src/domain/suspicions.ts";
import type { Param } from "../src/domain/types.ts";
import { ParamPassport } from "../src/domain/passport.ts";
import { passports } from "../src/services/passports.ts";

const SEED = JSON.parse(readFileSync(join(config.root, "data/seed/norms.json"), "utf8")) as { base: SeedNorm[]; items: Array<{ document_number: string; document_name: string }> };

describe("Checks.completeness_status (ТЗ §10, T-234)", () => {
  it("статус комплектности: COMPLETE, если доказательств хватило для сравнения; иначе — причина несравнения", () => {
    expect(completenessStatus("CANDIDATE")).toBe("COMPLETE");
    expect(completenessStatus("NEGATIVE_VERIFIED")).toBe("COMPLETE");
    for (const s of ["MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"]) expect(completenessStatus(s)).toBe(s);
    expect([...COMPLETENESS_STATUSES].sort()).toEqual(["CLARIFICATION_REQUIRED", "COMPLETE", "MISSING_EVIDENCE", "NOT_APPLICABLE", "NOT_COMPARABLE"]);
  });
  it("раздел комплектности протокола читает колонку completeness_status, а не пересчитывает finding_status", () => {
    const base = { param_code: "M-001", parameter_name: "П", section: "ПЗ", unit: "", evidence_group_id: "g", expected_value: null, actual_value: null, delta: null, review_priority: "LOW", reason: "нет листа", parent_id: null, title: null, fragments: [], decision: null, verification_status: "PENDING" };
    // колонка базы — источник истины: запись с COMPLETE не попадает в раздел, даже если finding_status говорит иначе
    expect(completenessOf({ finding_status: "MISSING_EVIDENCE", completeness_status: "COMPLETE" })).toBe("COMPLETE");
    expect(completenessOf({ finding_status: "MISSING_EVIDENCE", completeness_status: null })).toBe("MISSING_EVIDENCE");
    const p = buildProtocol({
      inspection: { id: "P", object_id: "O", status: "READY", scenario: null, load_codes: [] }, object: { id: "O", name: "О", address: null, permit_number: null },
      versions: { protocol: 1, matrix: "1", model: "m", dataset: "d", input_manifest_hash: "" }, files: [], suspicions: [], generated_at: "2026-09-28T00:00:00Z",
      checks: [{ ...base, id: "A", finding_status: "MISSING_EVIDENCE", completeness_status: "MISSING_EVIDENCE" }, { ...base, id: "B", param_code: "M-002", finding_status: "CANDIDATE", completeness_status: "COMPLETE" }],
    } as any);
    expect(p.sections.completeness.map((c: any) => c.param_code)).toEqual(["M-001"]);
  });
});

describe("Files.file_path (ТЗ §10, T-234)", () => {
  it("путь файла в хранилище по содержимому — blobs/<sha256>; обратно — sha256, чужой путь — null", () => {
    const sha = "a".repeat(64);
    expect(blobFilePath(sha)).toBe(`blobs/${sha}`);
    expect(shaFromFilePath(`blobs/${sha}`)).toBe(sha);
    expect(shaFromFilePath(`other/${sha}`)).toBeNull();
    expect(shaFromFilePath("blobs/не-хеш")).toBeNull();
    expect(shaFromFilePath(null)).toBeNull();
    expect(() => blobFilePath("x")).toThrow(/SHA-256/);
  });
});

describe("Rejection_Log.retraining_status (ТЗ §10, T-234)", () => {
  const e = (id: number, check_id: string, retraining_status = "PENDING") => ({ id, check_id, retraining_status });
  it("выпуск набора: отклонение, вошедшее в набор, — INCLUDED с версией; прочие ждут; снятые и включённые не трогаются", () => {
    const upd = retrainingUpdates([e(1, "A"), e(2, "B"), e(3, "C", "SUPERSEDED"), e(4, "D", "INCLUDED")], new Set(["A", "C", "D"]), "gold-v2");
    expect(upd).toEqual([{ id: 1, retraining_status: "INCLUDED", retraining_dataset: "gold-v2" }]);
    expect(retrainingUpdates([], new Set(["A"]), "v")).toEqual([]);
  });
  it("сводка журнала по статусу дообучения — все три статуса, неизвестный не считается", () => {
    expect(retrainingCounts([{ retraining_status: "PENDING", n: 2 }, { retraining_status: "INCLUDED", n: 5 }, { retraining_status: "ЧУЖОЙ", n: 9 }])).toEqual({ PENDING: 2, INCLUDED: 5, SUPERSEDED: 0 });
  });
});

describe("Dispute_Log.resolution_status, resolved_by (ТЗ §10, OS-INSP-4.1.29)", () => {
  it("закрыть можно только открытый спор; исход — из справочника; комментарий обязателен, кроме снятия", () => {
    expect(canResolveDispute("OPEN", "AI_UPHELD", "лист 3 подтверждает")).toEqual({ ok: true });
    expect(canResolveDispute("OPEN", "WITHDRAWN", "")).toEqual({ ok: true });
    expect(canResolveDispute("OPEN", "INSPECTOR_UPHELD", "  ")).toMatchObject({ ok: false, status: 400 });
    expect(canResolveDispute("AI_UPHELD", "WITHDRAWN", "")).toMatchObject({ ok: false, status: 409 });
    expect(canResolveDispute("OPEN", "OPEN", "x")).toMatchObject({ ok: false, status: 400 });
    expect([...DISPUTE_RESOLUTIONS]).toEqual(["AI_UPHELD", "INSPECTOR_UPHELD", "WITHDRAWN"]);
  });
});

describe("Model_Versions и ML_Retraining_Log (ТЗ §10, OS-INSP-6.3.2, 6.3.3, ADR-0011)", () => {
  const row = (o: Partial<ModelRow>): ModelRow => ({ model_version: "m", approval_status: "PUBLISHED", dataset_version: null, split_hashes_json: null, artifact_hash: null, rollback_to: "m0", deployed_at: "2026-09-01T00:00:00Z", approved_by: "u-sup", ...o });
  it("метрики по категориям при ручной регистрации — из recall_by_category; ворота берут Recall категорий из журнала дообучения", () => {
    expect(perCategoryFromRecall({ КР: 0.9, АР: 0.8 })).toEqual({ КР: { recall: 0.9 }, АР: { recall: 0.8 } });
    expect(categoryRecalls(JSON.stringify({ КР: { n: 5, positives: 2, recall: 0.7 }, ПЗ: { n: 3, positives: 0, recall: null } }))).toEqual({ КР: 0.7 });
    expect(categoryRecalls(null)).toBeNull();
    const prev = gatePrevious({ metrics_json: JSON.stringify({ precision: 0.95, recall: 0.9, f1: 0.92, false_positive_rate: 0.05, recall_by_category: { КР: 0.99 } }), per_category_metrics_json: JSON.stringify({ КР: { recall: 0.85 } }) })!;
    expect(prev.recall_by_category).toEqual({ КР: 0.85 });
    // КР 0.84 против журнала 0.85 — падение ≤ 2 п.п., ворота открыты; против metrics_json (0.99) закрылись бы
    expect(publicationGate(prev, { precision: 0.95, recall: 0.9, f1: 0.92, false_positive_rate: 0.05, recall_by_category: { КР: 0.84 } }).ok).toBe(true);
    expect(gatePrevious(undefined)).toBeNull();
    expect(gatePrevious({ metrics_json: JSON.stringify({ precision: 1, recall: 1, f1: 1, false_positive_rate: 0, recall_by_category: { КР: 1 } }) })!.recall_by_category).toEqual({ КР: 1 });
  });
  it("хеши выборок модели сверяются с выпуском набора; сверять не с чем — публикация не блокируется", () => {
    const h = (t: string) => JSON.stringify({ train: t, validation: "v", test: "t" });
    expect(splitHashesMatch(h("a"), h("a"))).toEqual({ ok: true });
    expect(splitHashesMatch(h("a"), h("b"))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/train/) });
    expect(splitHashesMatch(null, h("a"))).toEqual({ ok: true });
    expect(splitHashesMatch(h("a"), null)).toEqual({ ok: true });
  });
  it("действующая модель — опубликованная с последним вводом в контур, а не с последним номером", () => {
    expect(activeModel([row({ model_version: "a", deployed_at: "2026-09-10T00:00:00Z" }), row({ model_version: "b", deployed_at: "2026-09-01T00:00:00Z" }), row({ model_version: "c", approval_status: "SUPERSEDED", deployed_at: "2026-09-20T00:00:00Z" })])?.model_version).toBe("a");
    expect(activeModel([row({ approval_status: "ROLLED_BACK" })])).toBeNull();
  });
  it("откат: только действующая опубликованная модель с точкой отката; цель, снятая откатом, не подходит", () => {
    const reg = [{ model_version: "m0", approval_status: "SUPERSEDED" }];
    expect(rollbackPlan(row({}), "m", reg)).toEqual({ ok: true, plan: { from: "m", to: "m0", toInRegistry: true } });
    expect(rollbackPlan(row({ rollback_to: "dev-anchors-0.1" }), "m", reg)).toEqual({ ok: true, plan: { from: "m", to: "dev-anchors-0.1", toInRegistry: false } });
    expect(rollbackPlan(undefined, "m", reg)).toMatchObject({ ok: false, status: 404 });
    expect(rollbackPlan(row({ approval_status: "SUPERSEDED" }), "m", reg)).toMatchObject({ ok: false, status: 409 });
    expect(rollbackPlan(row({}), "other", reg)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/действующая/) });
    expect(rollbackPlan(row({ rollback_to: null }), "m", reg)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/точки отката/) });
    expect(rollbackPlan(row({}), "m", [{ model_version: "m0", approval_status: "ROLLED_BACK" }])).toMatchObject({ ok: false, status: 409 });
  });
  it("целостность весов: хеш весов совпадает с artifact_hash; пустой artifact_hash — не целостна", () => {
    expect(artifactIntact("abc", "abc")).toBe(true);
    expect(artifactIntact("abc", "abd")).toBe(false);
    expect(artifactIntact(null, "abc")).toBe(false);
    expect(artifactIntact("", "")).toBe(false);
  });
});

describe("Dataset_Items: evidence_group_id, expert_id, reason_code (ТЗ §10, OS-INSP-6.1.10)", () => {
  const it_ = (o: Partial<DatasetItemRow>): DatasetItemRow => ({ finding_id: "F", evidence_group_id: "g", gold_label: "NEGATIVE", expert_id: "u-insp", reason_code: "OCR_ERROR", split: "train", object_group_id: "O", ...o });
  it("набор годен: группа в одной выборке, у каждой метки эксперт; утечка группы и метка без эксперта — отказ", () => {
    expect(datasetIssues([it_({ finding_id: "1", evidence_group_id: "g1" }), it_({ finding_id: "2", evidence_group_id: "g2", split: "test" })])).toEqual([]);
    const bad = datasetIssues([it_({ finding_id: "1", evidence_group_id: "g1" }), it_({ finding_id: "2", evidence_group_id: "g1", split: "test" }), it_({ finding_id: "3", evidence_group_id: "g3", expert_id: null })]);
    expect(bad).toEqual(["доказательная группа в нескольких выборках: g1", "меток без эксперта: 1"]);
    const many = datasetIssues(Array.from({ length: 7 }, (_, i) => [it_({ finding_id: `a${i}`, evidence_group_id: `g${i}` }), it_({ finding_id: `b${i}`, evidence_group_id: `g${i}`, split: "test" })]).flat());
    expect(many[0]).toMatch(/и ещё 2$/);
  });
  it("сводка версии: эксперты, группы, выборки, причины отрицательных меток по убыванию", () => {
    const s = datasetSummary([
      it_({ finding_id: "1", evidence_group_id: "g1", reason_code: "OCR_ERROR" }), it_({ finding_id: "2", evidence_group_id: "g2", reason_code: "OCR_ERROR", expert_id: "u-sup" }),
      it_({ finding_id: "3", evidence_group_id: "g3", reason_code: "BINDING_ERROR", split: "test" }), it_({ finding_id: "4", evidence_group_id: "g4", gold_label: "POSITIVE", reason_code: null, split: "validation" }),
    ]);
    expect(s).toEqual({ items: 4, experts: 2, evidence_groups: 4, by_split: { train: 2, test: 1, validation: 1 }, by_reason: [{ reason_code: "OCR_ERROR", n: 2 }, { reason_code: "BINDING_ERROR", n: 1 }], issues: [] });
  });
});

describe("Normative_Base — один источник норм (ТЗ §10, OS-INSP-7.2.3, 7.2.4)", () => {
  const docNames = new Map(SEED.items.map((i) => [i.document_number, i.document_name]));
  it("запись сида norms.json → строка normative_base: ключ, документ, срок действия, applies_to; param_code пуст", () => {
    const n = SEED.base.find((b) => b.id === "evac-door-width")!;
    const r = normSeedRow(n, docNames, new Map([["M-041", "Ширина эвакуационных выходов"], ["M-105", "Ширина дверей"]]));
    expect(r).toMatchObject({ norm_key: "evac-door-width", document_number: "СП 1.13130.2020", section: "п. 4.2.19", min_value: 0.8, max_value: null, effective_from: "2020-09-19", effective_to: null, param_code: null, measure: "length", unit: "м", unverified: false });
    expect(r.document_name).not.toBe("СП 1.13130.2020");
    expect(r.parameter_name).toBe("Ширина эвакуационных выходов; Ширина дверей");
    expect(JSON.parse(r.applies_to_json)).toEqual(["M-041", "M-105"]);
    expect(normSeedRow({ ...n, doc: "СП 999", applies_to: [] }, docNames).document_name).toBe("СП 999");
  });
  it("строка таблицы → запись оценщика: правка администратора (предел, срок, выключение) видна расчёту", () => {
    const row = { norm_key: "evac-door-width", document_number: "СП 1.13130.2020", section: "п. 4.2.19", edition: null, measure: "length", min_value: 0.6, max_value: null, unit: "м", rule: "в свету", applies_to_json: '["M-041"]', effective_from: "2020-09-19", effective_to: "2030-01-01", unverified: false, is_active: true };
    const rec = normRecordFromRow(row);
    expect(rec).toMatchObject({ id: "evac-door-width", doc: "СП 1.13130.2020", clause: "п. 4.2.19", min: 0.6, max: null, applies_to: ["M-041"], effective_to: "2030-01-01", is_active: true });
    const n = { kind: "min" as const, value: null, basis: "СП", ref: "evac-door-width" };
    expect(resolveNorm(n, [rec], "2026-09-28", "м")).toMatchObject({ value: 0.6 });
    expect(resolveNorm(n, [{ ...rec, is_active: false }], "2026-09-28", "м")).toEqual({ why: "норма evac-door-width выключена в нормативной базе" });
    expect(resolveNorm(n, [{ ...rec, effective_to: "2025-01-01" }], "2026-09-28", "м")).toEqual({ why: "норма evac-door-width не действует на 2026-09-28" });
    expect(normRecordFromRow({ ...row, applies_to_json: null, min_value: null, unverified: true, is_active: false, effective_from: "" })).toMatchObject({ applies_to: [], min: null, unverified: true, is_active: false, effective_from: null });
  });
  it("правка нормы пересчитывает зависящие параметры: ключ гипотез, applies_to и паспорта со ссылкой на запись", () => {
    const refs = new Map([["M-041", "evac-door-width"], ["M-116", "mgn-corridor-width"]]);
    expect(paramsForNorm({ norm_key: "evac-door-width", param_code: null, applies_to_json: '["M-105"]' }, refs)).toEqual(["M-041", "M-105"]);
    expect(paramsForNorm({ norm_key: null, param_code: "M-040", applies_to_json: "[]" }, refs)).toEqual(["M-040"]);
    expect(paramsForNorm({}, refs)).toEqual([]);
  });
  it("срок действия нормы: выключенная и вне [effective_from; effective_to] не действует, границы включаются", () => {
    expect(normEffective({ effective_from: "2020-09-19", effective_to: null }, "2026-09-28T10:00:00Z")).toBe(true);
    expect(normEffective({ effective_from: "2026-09-28", effective_to: "2026-09-28" }, "2026-09-28")).toBe(true);
    expect(normEffective({ effective_from: "2026-09-29" }, "2026-09-28")).toBe(false);
    expect(normEffective({ effective_to: "2026-09-27" }, "2026-09-28")).toBe(false);
    expect(normEffective({ is_active: false }, "2026-09-28")).toBe(false);
  });
  it("нормативный анализ гипотез: норма вне срока действия гипотезу не даёт; без даты сроки не сверяются", () => {
    const n: NormEntry = { document_name: "СП", document_number: "СП 1.13130.2020", section: "п. 4.2.5", param_code: "M-041", min_value: 0.9, max_value: null, is_active: true, effective_from: "2020-09-19", effective_to: "2025-12-31" };
    const facts: Fact[] = [{ key: "M-041", num: 0.8, text: null, stage: "RD", ref: "АР1" }];
    expect(normative([n], facts, new Set(), "2026-09-28")).toEqual([]);
    expect(normative([n], facts, new Set(), "2025-06-01")).toHaveLength(1);
    expect(normative([n], facts, new Set())).toHaveLength(1);
  });
  it("вид geometry берёт нормы из переданной таблицы, а не из сида: правка предела меняет вердикт CMP-06", () => {
    const pp = ParamPassport.parse(JSON.parse(readFileSync(join(config.root, "data/seed/passports/draft/M-041.json"), "utf8"))); // T-233: паспорт в draft/
    const d3 = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/geom/doors.json"), "utf8")).RD.find((m: any) => m.key === "Д3");
    const row: KindRow = { file_id: "f-RD", value_num: null, value_text: null, page: 2, bbox_json: "[0.1,0.1,0.2,0.12]", sha256: "b".repeat(64), doc_stage: "RD", document_code: "100-АР1",
      revision: "1", approval_status: "APPROVED", revision_role: "CURRENT", discipline: "АР", meta_json: JSON.stringify({ geom: d3 }), line_text: "", confidence: 0.9 };
    const param: Param = {
      code: "M-041", section: "АР", parameter_name: "Ширина эвакуационных выходов (дверей)", unit: "м", source_pd: "Ведомость заполнения проёмов (АР)", source_rd: "Спецификация дверей",
      source_id: "Акты АОСР", trigger_logic: "", review_priority: "HIGH", data_type: "number", compare: { kind: "min", min: 0.9 }, anchors: [], regex_pattern: null, value_scale: null, applicability: null, is_active: true,
    };
    const table = SEED.base.map((b) => normRecordFromRow({ ...normSeedRow(b, docNames), is_active: true }));
    const kind = kindOf("geometry")!;
    const run = (norms: NormRecord[]) => kind.evaluate({ param, passport: kindSlice(pp), mentions: [baseMention(row)], loadedStages: ["RD"], profile: {}, kitBases: new Set(), pdKitPresent: false, norms });
    expect(run(table).status).toBe("CANDIDATE"); // Д3 0,7 м < 0,8 м
    const edited = table.map((r) => (r.id === "evac-door-width" ? { ...r, min: 0.6 } : r));
    expect(run(edited).status).not.toBe("CANDIDATE");
    expect(run(edited).expected).toMatch(/0,6 м/);
    const off = table.map((r) => (r.id === "evac-door-width" ? { ...r, is_active: false } : r));
    expect(run(off).status).toBe("NOT_COMPARABLE");
    // прямой вызов без таблицы — сид (тесты предметной логики без базы)
    expect(evaluateGeometry({ param, passport: kindSlice(pp), mentions: [baseMention(row)], loadedStages: ["RD"], profile: {}, date: "2026-09-28" }).status).toBe("CANDIDATE");
  });
});

describe("Params: sp_reference, gost_reference, fz_reference (ТЗ §10, OS-INSP-7.1.25)", () => {
  it("упоминания раскладываются по видам документа; неполный номер сливается с полным", () => {
    expect(normativeRefs(["Снижение ширины коридора в РД/ИД менее 1.2 м (СП 1.13130).", "СП 1.13130.2020, п. 4.3.3"])).toEqual({ sp_reference: "СП 1.13130.2020", gost_reference: null, fz_reference: null, other_normative: null });
    expect(normativeRefs(["ГОСТ Р 21.101-2020 (общие данные), ГОСТ 21.508; Постановление Правительства РФ № 87"])).toEqual({ sp_reference: null, gost_reference: "ГОСТ Р 21.101-2020; ГОСТ 21.508", fz_reference: null, other_normative: "Постановление Правительства РФ № 87" });
    expect(normativeRefs(["Федеральный закон № 123-ФЗ, ст. 87, табл. 22; СП 2.13130.2020, п. 5", "123-ФЗ, ст. 88"]).fz_reference).toBe("123-ФЗ");
    expect(normativeRefs(["Градостроительный кодекс РФ, ст. 57.3 (ГПЗУ)"]).fz_reference).toBe("Градостроительный кодекс РФ");
    expect(normativeRefs(["Приказ Минстроя России от 06.06.2016 № 399/пр, табл. 2"]).other_normative).toBe("Приказ Минстроя России от 06.06.2016 № 399/пр");
    expect(normativeRefs(["ПУЭ, 7-е изд."]).other_normative).toBe("ПУЭ");
    expect(normativeRefs([null, undefined, ""])).toEqual({ sp_reference: null, gost_reference: null, fz_reference: null, other_normative: null });
  });
  it("разные своды правил не сливаются по общему началу номера", () => {
    expect(normativeRefs(["СП 5.13130.2009; СП 54.13330.2022; СП 2.13130.2020"]).sp_reference).toBe("СП 5.13130.2009; СП 54.13330.2022; СП 2.13130.2020");
  });
});
