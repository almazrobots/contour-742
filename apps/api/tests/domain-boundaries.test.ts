// Граничные значения (L3) и добивание выживших мутантов (L8, Stryker 2026-09-24).
import { describe, expect, it } from "vitest";
import { evaluate, rank, stageRequired, violates } from "../src/domain/compare.ts";
import { buildDataset, publicationGate, splitOf } from "../src/domain/gold.ts";
import { dedupe, logical, nameSimilarity, normative, semantic, type Fact } from "../src/domain/suspicions.ts";
import type { Param, SourceRef, Stage, StageValue } from "../src/domain/types.ts";
import { asApproval, checkFile, checkPackage, indexManifest, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, parseManifest, sniff } from "../src/domain/upload.ts";

const P = (over: Partial<Param> = {}): Param => ({
  code: "M-1", section: "ПЗ", parameter_name: "x", unit: "м", source_pd: "a", source_rd: "b", source_id: "c", trigger_logic: "t",
  review_priority: "HIGH", data_type: "number", compare: { kind: "equal" }, anchors: [], regex_pattern: null, value_scale: null, applicability: null, is_active: true, ...over,
});
const src = (stage: Stage, role: SourceRef["role"] = "CURRENT", code = `X-${stage}`, revision = "1"): SourceRef => ({ file_id: `f-${stage}-${revision}`, sha256: "a".repeat(64), stage, document_code: code, revision, approval_status: "APPROVED", page: 1, bbox: null, role });
const V = (stage: Stage, num: number | null, text: string | null = null, role: SourceRef["role"] = "CURRENT", code?: string, rev?: string): StageValue => ({ stage, num, text, raw: String(num ?? text), source: src(stage, role, code, rev) });
const ALL: Stage[] = ["PD", "RD", "ID"];

describe("сравнение: границы и формулировки", () => {
  it("стадия с пустым, «—» или «-» источником не обязательна", () => {
    expect(stageRequired(P({ source_rd: null }), "RD")).toBe(false);
    expect(stageRequired(P({ source_rd: "-" }), "RD")).toBe(false);
    expect(stageRequired(P({ source_rd: " — " }), "RD")).toBe(false);
    expect(stageRequired(P({ source_rd: "Лист ОД" }), "RD")).toBe(true);
  });
  it("ранг: первый элемент шкалы — 0, а не «не найдено»", () => {
    expect(rank(P({ value_scale: ["E", "A"] }), "E")).toBe(0);
    expect(rank(P({ value_scale: "numeric_suffix" }), "B")).toBeNull();
    expect(rank(P({ value_scale: "numeric_suffix" }), "B22.5")).toBe(22.5);
  });
  it("delta_pct: знак и точность дельты", () => {
    expect(violates(P({ compare: { kind: "delta_pct", tolerance: 1 } }), V("PD", 200), V("RD", 190))).toEqual({ bad: true, delta: "-5.00 %" });
    expect(violates(P({ compare: { kind: "delta_pct", tolerance: 1 } }), V("PD", 200), V("RD", 200))).toEqual({ bad: false, delta: "0.00 %" });
    expect(violates(P({ compare: { kind: "delta_pct", tolerance: 1 } }), V("PD", 200), V("RD", null, "x"))).toBeNull();
  });
  it("equal: число и текст, нулевая дельта без знака", () => {
    expect(violates(P(), V("PD", 5), V("RD", 5))).toEqual({ bad: false, delta: "0" });
    expect(violates(P(), V("PD", 5), V("RD", 3))).toEqual({ bad: true, delta: "-2" });
    expect(violates(P(), V("PD", null, "a"), V("RD", null, null))).toBeNull();
    expect(violates(P(), V("PD", null, null), V("RD", null, "a"))).toBeNull();
  });
  it("decrease/increase: равенство не нарушение; числовая дельта", () => {
    const dec = P({ compare: { kind: "decrease" } });
    expect(violates(dec, V("PD", 220), V("RD", 220))).toEqual({ bad: false, delta: "0" });
    expect(violates(dec, V("PD", 220), V("RD", 200))).toEqual({ bad: true, delta: "-20" });
    expect(violates(dec, V("PD", 220), V("RD", null, "двести"))).toBeNull();
    expect(violates(P({ compare: { kind: "increase" } }), V("PD", 10), V("RD", 10))?.bad).toBe(false);
    expect(violates(P({ compare: { kind: "min", min: 1 } }), V("PD", 1), V("RD", 1))).toBeNull();
  });
  it("min: ровно на пороге — норма; нечисловое — несопоставимо; ожидание с единицей", () => {
    const door = P({ compare: { kind: "min", min: 0.9 }, unit: "м" });
    expect(evaluate({ param: door, profile: {}, values: [V("RD", 0.9), V("ID", 0.95)], loadedStages: ALL })).toMatchObject({ status: "NEGATIVE_VERIFIED", expected: "≥ 0.9", actual: "0.9 / 0.95" });
    const bad = evaluate({ param: door, profile: {}, values: [V("PD", 1.2), V("RD", 0.85)], loadedStages: ALL });
    expect(bad.expected).toBe("≥ 0.9 м");
    expect(bad.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
    expect(evaluate({ param: door, profile: {}, values: [V("RD", null, "широкая")], loadedStages: ALL }).status).toBe("NOT_COMPARABLE");
    const cap = P({ compare: { kind: "max", max: 10 }, unit: "" });
    expect(evaluate({ param: cap, profile: {}, values: [V("RD", 12)], loadedStages: ALL })).toMatchObject({ expected: "≤ 10", delta: "+2" });
  });
  it("конфликт редакций: в основании перечислены документы, фрагменты — спорные источники", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 1), V("RD", 2, null, "CONFLICT", "ШК-АР", "1"), V("RD", 3, null, "CONFLICT", "ШК-АР", "2")], loadedStages: ALL });
    expect(e.reason).toContain("ШК-АР ред. 1");
    expect(e.reason).toContain("ШК-АР ред. 2");
    expect(e.fragments).toHaveLength(2);
    expect(e.fragments.every((f) => f.kind === "actual")).toBe(true);
  });
  it("MISSING_EVIDENCE называет стадии без значения и сохраняет единственный фрагмент", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", 1)], loadedStages: ["PD", "RD"] });
    expect(e.reason).toBe("Недостаточно источников для сравнения: есть только PD; нет значения в RD");
    expect(e.fragments).toHaveLength(1);
    const none = evaluate({ param: P(), profile: {}, values: [], loadedStages: [] });
    expect(none.reason).toBe("Недостаточно источников для сравнения: значение не найдено");
  });
  it("NOT_COMPARABLE при сравнении: фрагменты размечены ожидаемое/фактическое", () => {
    const e = evaluate({ param: P({ compare: { kind: "delta_pct", tolerance: 1 } }), profile: {}, values: [V("PD", 0), V("RD", 5)], loadedStages: ALL });
    expect(e.status).toBe("NOT_COMPARABLE");
    expect(e.fragments.map((f) => f.kind)).toEqual(["expected", "actual"]);
    expect(e.reason).toContain("«0»");
  });
  it("текстовое значение показывается как текст", () => {
    const e = evaluate({ param: P(), profile: {}, values: [V("PD", null, "II"), V("RD", null, "III")], loadedStages: ALL });
    expect(e).toMatchObject({ expected: "II", actual: "III" });
  });
});

describe("гипотезы: ссылки, пороги и уверенность", () => {
  const rule = { id: 7, rule_name: "R", condition: { key: "A", op: ">" as const, value: 10 }, expected: { key: "B", op: ">" as const, value: 0 }, normative_base: "СП", is_active: true };
  const f = (key: string, num: number | null, stage: Fact["stage"], ref = `${key}@${stage}`): Fact => ({ key, num, text: null, stage, ref });
  it("ссылки ПД/РД берутся из условия или ожидаемого факта", () => {
    const [s] = logical([rule], [f("A", 12, "RD"), f("B", 0, "PD")]);
    expect(s).toMatchObject({ pd_reference: "B@PD", rd_reference: "A@RD", confidence: 0.87, dedup_key: "LOGICAL:7" });
    const [t] = logical([rule], [f("A", 12, "PD"), f("B", 0, "RD")]);
    expect(t).toMatchObject({ pd_reference: "A@PD", rd_reference: "B@RD" });
    const [u] = logical([rule], [f("A", 12, "ID")]);
    expect(u).toMatchObject({ pd_reference: null, rd_reference: null, confidence: 0.6 });
    expect(u.description).toContain("не найдено");
    expect(logical([rule], [f("A", null, "PD")])).toHaveLength(0);
  });
  it("сходство названий: пустые, регистр, доля общих слов", () => {
    expect(nameSimilarity("!!", "!!")).toBe(1);
    expect(nameSimilarity("ГСМ", "гсм")).toBe(1);
    expect(nameSimilarity("ab", "cd")).toBe(0);
    expect(nameSimilarity("Кабинет врача", "Кабинет")).toBe(0.5);
    expect(nameSimilarity("Склад-ГСМ", "склад гсм")).toBe(1);
  });
  it("семантика: только пары ПД→РД одного номера; уверенность и приоритет", () => {
    const s = semantic([
      { number: "1", name: "Техническое помещение", stage: "PD", ref: "p" },
      { number: "1", name: "Кладовая", stage: "RD", ref: "r" },
      { number: "2", name: "Кладовая", stage: "RD", ref: "r" },
      { number: "3", name: "Кладовая", stage: "ID", ref: "i" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ confidence: 0.9, review_priority: "MEDIUM", pd_reference: "p", rd_reference: "r" });
    expect(semantic([{ number: "1", name: "Кабинет врача", stage: "PD", ref: "" }, { number: "1", name: "Кабинет врача", stage: "RD", ref: "" }], 1)).toHaveLength(0);
  });
  it("нормативный анализ: строгие границы min и max, выключенные нормы, чужие параметры", () => {
    const n = (min: number | null, max: number | null, active = true) => ({ document_name: "", document_number: "СП", section: "п.1", param_code: "M-1", min_value: min, max_value: max, is_active: active });
    const facts = [f("M-1", 1, "RD"), f("M-2", 0, "RD"), f("M-1", null, "PD")];
    expect(normative([n(1, null)], facts, new Set())).toHaveLength(0);
    expect(normative([n(1.5, null)], facts, new Set())[0]).toMatchObject({ rd_reference: "M-1@RD", pd_reference: null, normative_base: "СП, п.1" });
    expect(normative([n(null, 1)], facts, new Set())).toHaveLength(0);
    expect(normative([n(null, 0.5)], facts, new Set())[0].description).toContain("больше 0.5");
    expect(normative([n(null, null)], facts, new Set())).toHaveLength(0);
    expect(normative([n(2, null, false)], facts, new Set())).toHaveLength(0);
    expect(normative([n(2, null)], [f("M-1", 1, "PD")], new Set())[0].pd_reference).toBe("M-1@PD");
  });
  it("дедупликация: при равной уверенности остаётся первая", () => {
    const a = { discovery_method: "LOGICAL_ANALYSIS" as const, confidence: 0.5, description: "первая", pd_reference: null, rd_reference: null, review_priority: "HIGH" as const, normative_base: null, dedup_key: "K" };
    expect(dedupe([a, { ...a, description: "вторая" }])[0].description).toBe("первая");
  });
});

describe("GOLD и ворота качества: границы", () => {
  const good = { recall_by_category: { КР: 0.85 }, false_positive_rate: 0.05, precision: 0.9, recall: 0.8, f1: 0.85 };
  it("ровно на пороге — допускается; ниже — нет", () => {
    expect(publicationGate(null, good).ok).toBe(true);
    expect(publicationGate(null, { ...good, recall: 0.79 }).reasons[0]).toContain("Recall");
    expect(publicationGate(null, { ...good, f1: 0.84 }).reasons[0]).toContain("F1");
    expect(publicationGate(null, { ...good, false_positive_rate: 0.1 }).ok).toBe(true);
    expect(publicationGate(null, { ...good, false_positive_rate: 0.11 }).reasons[0]).toContain("FPR");
  });
  it("падение ровно на 2 п.п. допустимо, пропавшая категория — нет", () => {
    expect(publicationGate(good, { ...good, recall_by_category: { КР: 0.83 } }).ok).toBe(true);
    expect(publicationGate(good, { ...good, recall_by_category: {} }).reasons[0]).toContain("нет");
    expect(publicationGate(good, { ...good, false_positive_rate: 0.07 }).ok).toBe(true);
  });
  it("хеши выборок различаются по составу и не зависят от порядка", () => {
    const c = (o: string, id: string) => ({ evidence_group_id: o, finding_id: id, object_id: o, param_code: "M", verification_status: "NEGATIVE_VERIFIED", reason_code: null, fragments: 1, expert_id: "u" });
    const objs = Array.from({ length: 30 }, (_, i) => `O-${i}`);
    const a = buildDataset(objs.map((o) => c(o, `${o}-1`)));
    const b = buildDataset([...objs].reverse().map((o) => c(o, `${o}-1`)));
    expect(a.hashes).toEqual(b.hashes);
    expect(new Set(Object.values(a.hashes)).size).toBe(3);
    expect(a.items.every((i) => i.gold_label === "NEGATIVE")).toBe(true);
    const counts = { train: 0, validation: 0, test: 0 };
    for (let i = 0; i < 400; i++) counts[splitOf(`X-${i}`)]++;
    expect(counts.train).toBeGreaterThan(240);
    expect(counts.validation).toBeGreaterThan(30);
    expect(counts.test).toBeGreaterThan(30);
  });
});

describe("приём файлов: границы и реестр", () => {
  it("ровно 50 МБ и ровно 200 МБ — допустимо", () => {
    const pdf = Buffer.alloc(MAX_FILE_BYTES);
    pdf.write("%PDF-1.7\n");
    pdf.write("%%EOF", MAX_FILE_BYTES - 6);
    expect(checkFile("edge.pdf", pdf)).toEqual({ ok: true, kind: "pdf" });
    expect(checkPackage([MAX_PACKAGE_BYTES])).toEqual({ ok: true });
    const big = checkFile("big.pdf", Buffer.alloc(MAX_FILE_BYTES + 1048576));
    expect(!big.ok && big.message).toContain("51.0 МБ");
    const pk = checkPackage([MAX_PACKAGE_BYTES + 1048576]);
    expect(!pk.ok && pk.message).toContain("201.0 МБ");
  });
  it("распознавание: zip без word/ — не DOCX, PK без второго байта — не DOCX, XML с BOM и без пролога", () => {
    expect(sniff(Buffer.from("PX....word/"))).toBeNull();
    expect(sniff(Buffer.from("XK....word/"))).toBeNull();
    expect(sniff(Buffer.from("﻿<?xml version='1.0'?><a/>"))).toBe("xml");
    expect(sniff(Buffer.from("текст <a>"))).toBeNull();
    expect(sniff(Buffer.from("  <Акт/>"))).toBe("xml");
    expect(checkFile("a.xml", Buffer.from("<a/>"))).toEqual({ ok: true, kind: "xml" });
  });
  it("реестр JSON и CSV с BOM, пустыми ячейками и пустыми строками", () => {
    const json = parseManifest("manifest.JSON", Buffer.from(JSON.stringify({ files: [{ file_id: "A", file_name: "a.pdf", doc_stage: "PD", discipline: "АР", document_code: "X", revision: "1" }] })));
    expect(json.files[0].file_id).toBe("A");
    const csv = parseManifest("Реестр.CSV", Buffer.from("﻿file_id,file_name,doc_stage,discipline,document_code,revision,approval_status\n\nA, a.pdf ,RD,АР,X,1,\n"));
    expect(csv.files[0]).toMatchObject({ file_id: "A", file_name: "a.pdf", doc_stage: "RD", approval_status: null });
    expect(() => parseManifest("m.json", Buffer.from(JSON.stringify({ files: [] })))).toThrow();
    expect(() => parseManifest("m.json", Buffer.from(JSON.stringify({ files: [{ file_id: "", file_name: "a", doc_stage: "PD", discipline: "x", document_code: "x", revision: "1" }] })))).toThrow();
    expect(() => parseManifest("m.json", Buffer.from(JSON.stringify({ files: [{ file_id: "A", file_name: "a", doc_stage: "PD", discipline: "x", document_code: "x", revision: "", sha256: "a".repeat(64) }] })))).toThrow();
    expect(() => parseManifest("m.json", Buffer.from(JSON.stringify({ files: [{ file_id: "A", file_name: "a", doc_stage: "PD", discipline: "x", document_code: "x", revision: "1", sha256: "g".repeat(64) }] })))).toThrow();
  });
  it("индекс реестра считает объявленные файлы по стадиям", () => {
    const idx = indexManifest({ files: [{ file_id: "A", file_name: "a.pdf", doc_stage: "ID", discipline: "x", document_code: "x", revision: "1" }, { file_id: "B", file_name: "b.pdf", doc_stage: "ID", discipline: "x", document_code: "y", revision: "1" }] });
    expect(idx.declaredPerStage).toEqual({ PD: 0, RD: 0, ID: 2 });
    expect(idx.byName.get("b.pdf")?.file_id).toBe("B");
    expect(indexManifest(null).declaredPerStage).toEqual({ PD: 0, RD: 0, ID: 0 });
    expect(asApproval("APPROVED")).toBe("APPROVED");
    expect(asApproval("approved")).toBeNull();
    expect(asApproval(null)).toBeNull();
  });
});
