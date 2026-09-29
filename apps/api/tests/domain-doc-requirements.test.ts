// Эшелоны: L1 (правила М-096: CMP-25 полнота ИД, CMP-03 сечения), L3 (граница: равные сечения, размеры в разные
// стороны), L6 (отказы: ИД не загружена, документа нет, упоминание вне стадии ИД, устаревшая редакция, смена профиля).
// Название теста — ссылка трассы (model.yaml → impl → tests), T-213. Значения синтетические (ADR-0002).
import { describe, expect, it } from "vitest";
import { actBeforeWork, evaluateDocRequirements, underrated, weakest, type DocReqMention, type DocReqPassport } from "../src/domain/doc-requirements.ts";
import { passports } from "../src/services/passports.ts";
import { extractorSpec } from "../src/domain/passport.ts";
import { docReqMentions, docReqPassportOf } from "../src/domain/kinds/doc-requirements.ts";
import { kindSlice, type KindRow } from "../src/domain/param-kinds.ts";
import type { Param, Stage } from "../src/domain/types.ts";

const PASS: DocReqPassport = {
  docs: [
    { id: "AOSR_SUPPORTS", title: "акт освидетельствования временных креплений" },
    { id: "ASBUILT_SCHEME", title: "исполнительная схема временных креплений" },
  ],
  sections: true,
};
const PARAM: Param = {
  code: "M-096",
  section: "ПОД",
  parameter_name: "Узлы временного расчленения сохраняемых конструкций",
  unit: "—",
  source_pd: "Чертежи временных подпорок (ПОД)",
  source_rd: "Детальные узлы крепелей; Спецификация (КР/ППР)",
  source_id: "Акты АОСР на устройство креплений; Фотофиксация",
  trigger_logic: "Занижение сечений элементов расчленения в РД; отсутствие актов монтажа.",
  review_priority: "HIGH",
  data_type: "string",
  compare: { kind: "decrease" },
  anchors: ["Узлы временного расчленения"],
  regex_pattern: null,
  value_scale: null,
  applicability: "demolition",
  is_active: true,
};

let seq = 0;
const loc = (stage: Stage, over: Partial<DocReqMention> = {}) => ({
  stage,
  file_id: `f${++seq}`,
  sha256: "b".repeat(64),
  document_code: stage === "PD" ? "П-7-ПОД" : stage === "RD" ? "П-7-КР" : "П-7-ИД-АОСР",
  revision: "1",
  approval_status: null,
  role: "CURRENT" as const,
  discipline: stage === "PD" ? "ПОД" : stage === "RD" ? "КР" : null,
  page: 2,
  bbox: [0.1, 0.1, 0.3, 0.12] as [number, number, number, number],
  quote: "цитата",
  confidence: 1,
  ...over,
});
const DOC = (id: string, over: Partial<DocReqMention> = {}): DocReqMention => ({ ...loc("ID", over), kind: "doc", doc: id } as DocReqMention);
const SEC = (stage: Stage, profile: string, dims: number[], label: string, over: Partial<DocReqMention> = {}): DocReqMention => ({ ...loc(stage, over), kind: "section", profile, dims, label } as DocReqMention);
const ALL_DOCS = () => [DOC("AOSR_SUPPORTS"), DOC("ASBUILT_SCHEME")];
const run = (mentions: DocReqMention[], loaded: Stage[] = ["PD", "RD", "ID"], profile: Record<string, boolean> = {}, passport = PASS) =>
  evaluateDocRequirements({ param: PARAM, passport, mentions, loadedStages: loaded, profile });

describe("CMP-03: сечения элементов расчленения ПД ↔ РД (OS-INSP-3.1.168)", () => {
  it("сечение РД меньше ПД — CANDIDATE с фрагментами обеих стадий", () => {
    const ev = run([SEC("PD", "ibeam", [30], "двутавр 30Б1"), SEC("RD", "ibeam", [20], "двутавр 20Б1"), ...ALL_DOCS()]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.expected).toBe("двутавр 30Б1");
    expect(ev.actual).toBe("двутавр 20Б1");
    expect(ev.reason).toContain("сечение элемента расчленения занижено: в РД двутавр 20Б1 (П-7-КР, стр. 2) против двутавр 30Б1 в ПД");
    expect(ev.reason).toContain("Правило Матрицы: Занижение сечений");
    expect(ev.fragments.map((f) => [f.stage, f.kind])).toEqual([
      ["PD", "expected"],
      ["RD", "actual"],
    ]);
  });

  it("кандидат по сечению называет и пробел ИД — как не нарушение", () => {
    const ev = run([SEC("PD", "angle", [100, 8], "уголок 100×8"), SEC("RD", "angle", [100, 6], "уголок 100×6")]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("Не хватает доказательств (не нарушение): в ИД нет: акт освидетельствования временных креплений; исполнительная схема временных креплений");
  });

  it("граница: равные сечения — не занижение; один размер больше, другой меньше — не определить", () => {
    expect(underrated([100, 8], [100, 8])).toBe(false);
    expect(underrated([100, 8], [110, 8])).toBe(false);
    expect(underrated([100, 8], [90, 10])).toBeNull();
    expect(underrated([100, 8], [100])).toBeNull();
    const ev = run([SEC("PD", "angle", [100, 8], "уголок 100×8"), SEC("RD", "angle", [90, 10], "уголок 90×10"), ...ALL_DOCS()]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("один размер больше, другой меньше");
  });

  it("самое слабое сечение вида на стадии; вид профиля сменился — NOT_COMPARABLE, а не нарушение", () => {
    const w = weakest([SEC("PD", "ibeam", [30], "двутавр 30") as any, SEC("PD", "ibeam", [20], "двутавр 20") as any, SEC("PD", "pipe", [159, 6], "труба 159×6") as any]);
    expect([...w.values()].map((m) => m.label)).toEqual(["двутавр 20", "труба 159×6"]);
    const ev = run([SEC("PD", "ibeam", [30], "двутавр 30"), SEC("RD", "channel", [16], "швеллер 16П"), ...ALL_DOCS()]);
    expect(ev.status).toBe("NOT_COMPARABLE");
    expect(ev.reason).toContain("вид профиля сменился: ПД — двутавр 30; РД — швеллер 16П");
  });

  it("сечение другого элемента (котлован) и нечитаемое сечение — NOT_COMPARABLE, не нарушение", () => {
    const other = run([SEC("PD", "pipe", [159, 6], "труба 159×6"), SEC("RD", "pipe", [108, 4], "труба 108×4", { excluded: "OTHER_ELEMENT", excluded_why: "элемент котлована" } as any)], ["PD", "RD"]);
    expect(other.status).toBe("NOT_COMPARABLE");
    expect(other.reason).toContain("в РД сечение другого элемента — труба 108×4 (элемент котлована)");
    expect(other.provenance.mentions.map((m) => m.use)).toEqual(["considered", "dropped"]);
    const garbled = run([SEC("PD", "pipe", [159, 6], "труба 159×6"), { ...SEC("RD", "pipe", [0], "x"), kind: "section_unreadable" } as DocReqMention], ["PD", "RD"]);
    expect(garbled.status).toBe("NOT_COMPARABLE");
    expect(garbled.reason).toContain("сечение в РД не читается");
  });
});

describe("CMP-25: акт монтажа в ИД, реквизиты и даты (OS-INSP-3.1.167)", () => {
  it("документа из перечня нет в ИД — MISSING_EVIDENCE с перечнем недостающего, не нарушение", () => {
    const ev = run([SEC("PD", "ibeam", [20], "двутавр 20"), SEC("RD", "ibeam", [20], "двутавр 20"), DOC("AOSR_SUPPORTS")]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("в ИД нет: исполнительная схема временных креплений");
    expect(ev.reason).toContain("Упоминание в ИД: акт освидетельствования временных креплений (П-7-ИД-АОСР, стр. 2)");
    expect(ev.fragments.map((f) => f.value)).toEqual(["акт освидетельствования временных креплений"]);
  });

  it("ИД не загружена — акт не требуется при сравнении ПД ↔ РД; сравнить нечего вовсе — MISSING_EVIDENCE", () => {
    const ev = run([SEC("PD", "ibeam", [20], "двутавр 20"), SEC("RD", "ibeam", [20], "двутавр 20")], ["PD", "RD"]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("ИД не загружена — акт не проверялся");
    expect(ev.stage_notes).toEqual({ PD: "USED", RD: "USED", ID: "NOT_APPLICABLE" });
    const none = run([], ["PD", "RD"]);
    expect(none.status).toBe("MISSING_EVIDENCE");
    expect(none.reason).toContain("Проверить нечего");
  });

  it("упоминание документа вне стадии ИД и устаревшая редакция ИД не засчитываются", () => {
    const rdMention = { ...DOC("ASBUILT_SCHEME"), stage: "RD" as Stage };
    const old = DOC("ASBUILT_SCHEME", { role: "SUPERSEDED" });
    const ev = run([SEC("PD", "ibeam", [20], "двутавр 20"), SEC("RD", "ibeam", [20], "двутавр 20"), DOC("AOSR_SUPPORTS"), rdMention, old]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("в ИД нет: исполнительная схема");
    expect(ev.provenance.mentions.map((m) => m.use)).toEqual(["considered", "considered", "considered", "reference", "dropped"]);
  });

  it("сечение есть только в одной стадии или стадия не загружена — MISSING_EVIDENCE называет, чего не хватает", () => {
    const ev = run([SEC("PD", "ibeam", [20], "двутавр 20"), ...ALL_DOCS()]);
    expect(ev.status).toBe("MISSING_EVIDENCE");
    expect(ev.reason).toContain("сечения элементов расчленения не найдены в РД (узлы креплений, спецификация КР/ППР)");
    expect(ev.stage_notes).toEqual({ PD: "USED", RD: "NO_VALUE", ID: "USED" });
    expect(run([SEC("PD", "ibeam", [20], "двутавр 20")], ["PD"]).reason).toContain("РД (узлы креплений, спецификация КР/ППР) — стадия не загружена");
  });

  it("пустой реквизит в имеющемся акте — CANDIDATE по реквизитам", () => {
    const gap = { ...loc("ID"), kind: "requisite_gap", label: "проектировщик" } as DocReqMention;
    const ev = run([...ALL_DOCS(), gap]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("в акте не заполнен реквизит «проектировщик»");
    expect(ev.delta).toBe("реквизит акта");
  });

  it("дата акта раньше даты работ по тому же узлу — CANDIDATE; другой узел и акт позже работ — нет", () => {
    const d = (kind: "act_date" | "work_date", node: string, date: string) => ({ ...loc("ID"), kind, node, date }) as DocReqMention;
    const ev = run([...ALL_DOCS(), d("work_date", "Р-3", "-05-20"), d("act_date", "Р-3", "-05-15")]);
    expect(ev.status).toBe("CANDIDATE");
    expect(ev.reason).toContain("акт по узлу Р-3 датирован 05-15 — раньше работ по журналу (05-20)");
    expect(actBeforeWork([d("work_date", "Р-3", "-05-20"), d("act_date", "Р-4", "-05-15")] as any)).toEqual([]);
    expect(actBeforeWork([d("work_date", "Р-3", "-05-20"), d("act_date", "Р-3", "-05-21")] as any)).toEqual([]);
    expect(actBeforeWork([d("work_date", "Р-3", "2026-05-20"), d("act_date", "Р-3", "2027-05-15")] as any)).toEqual([]);
  });
});

describe("М-096: итог, ворота и паспорт (OS-INSP-3.1.169)", () => {
  it("сечения не меньше и все документы ИД есть — NEGATIVE_VERIFIED", () => {
    const ev = run([SEC("PD", "ibeam", [20], "двутавр 20Б1"), SEC("RD", "ibeam", [24], "двутавр 24Б1"), ...ALL_DOCS()]);
    expect(ev.status).toBe("NEGATIVE_VERIFIED");
    expect(ev.reason).toContain("сечения элементов расчленения в РД не меньше ПД; в ИД найдено упоминание акта монтажа");
    const noSec = run(ALL_DOCS(), ["PD", "RD", "ID"], {}, { ...PASS, sections: false });
    expect(noSec.status).toBe("NEGATIVE_VERIFIED");
    expect(noSec.reason).not.toContain("сечения");
    expect(noSec.stage_notes).toEqual({ PD: "NOT_APPLICABLE", RD: "NOT_APPLICABLE", ID: "USED" });
  });

  it("демонтажа нет или сохраняемых конструкций нет — NOT_APPLICABLE; спорная редакция — CLARIFICATION_REQUIRED", () => {
    expect(run(ALL_DOCS(), ["PD", "RD", "ID"], { demolition: false }).status).toBe("NOT_APPLICABLE");
    const na = { ...loc("PD"), kind: "not_applicable" } as DocReqMention;
    const ev = run([na], ["PD", "RD"]);
    expect(ev.status).toBe("NOT_APPLICABLE");
    expect(ev.reason).toContain("Сохраняемых конструкций нет");
    // оговорка «сохраняемых нет» при найденных сечениях — не неприменимость
    expect(run([na, SEC("PD", "ibeam", [30], "двутавр 30"), SEC("RD", "ibeam", [20], "двутавр 20")], ["PD", "RD"]).status).toBe("CANDIDATE");
    const cl = run([SEC("PD", "ibeam", [30], "двутавр 30"), SEC("RD", "ibeam", [20], "двутавр 20", { role: "UNRESOLVED" })]);
    expect(cl.status).toBe("CLARIFICATION_REQUIRED");
    expect(cl.reason).toContain("П-7-КР ред. 1");
  });

  it("паспорт М-096 проходит схему; перечень документов уходит в ML вместе с экстрактором", () => {
    const pp = passports().byCode.get("M-096")!;
    const dp = docReqPassportOf(kindSlice(pp));
    expect(dp.sections).toBe(true);
    expect(dp.docs.map((d) => d.id)).toEqual(["AOSR_SUPPORTS"]);
    expect(extractorSpec(pp)).toMatchObject({ kind: "doc_requirements", docs: [expect.objectContaining({ id: "AOSR_SUPPORTS" })] });
  });

  it("строки извлечения → находки М-096 по виду; сечение без размеров и чужие строки — мимо", () => {
    const row = (meta: unknown, over: Partial<KindRow> = {}): KindRow => ({
      file_id: "f", value_num: null, value_text: "двутавр 20", page: 1, bbox_json: null, sha256: "c".repeat(64), doc_stage: "RD", document_code: "П-7-КР", revision: "1",
      approval_status: null, revision_role: "CURRENT", discipline: null, meta_json: JSON.stringify(meta), line_text: "", confidence: 1, ...over,
    });
    const m = docReqMentions([
      row({ kind: "doc", doc: "AOSR_SUPPORTS" }),
      row({ kind: "section", profile: "ibeam", dims: ["20"] }),
      row({ kind: "section", profile: "ibeam", dims: ["x"] }),
      row({ kind: "requisite_gap", label: "проектировщик" }),
      row({ kind: "act_date", node: "Р-1", date: "-05-01" }),
      row({ kind: "not_applicable" }),
      row({ kind: "doc" }),
      row({ kind: "other" }),
    ]);
    expect(m.map((x) => x.kind)).toEqual(["doc", "section", "requisite_gap", "act_date", "not_applicable"]);
    expect(m[1]).toMatchObject({ dims: [20], label: "двутавр 20", profile: "ibeam" });
    expect(m[3]).toMatchObject({ node: "Р-1", date: "-05-01" });
  });
});
