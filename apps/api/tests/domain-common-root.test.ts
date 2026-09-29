// OS-INSP-4.1.12–4.1.14 («общий корень», T-112 плана): одна причина снятия — соседям с той же сигнатурой.
import { describe, expect, it } from "vitest";
import { signaturesOf, siblingsOf, type RootCheck } from "../src/domain/common-root.ts";

const c = (id: string, o: Partial<RootCheck> = {}, act: Partial<RootCheck["fragments"][number]> = {}): RootCheck => ({
  id, param_code: `M-${id}`, finding_status: "CANDIDATE", verification_status: "PENDING", review_priority: "MEDIUM",
  fragments: [
    { role_expected_actual: "expected", file_id: "PD", sheet_page: 1, document_code: "П-ПЗ", revision: "1" },
    { role_expected_actual: "actual", file_id: "RD-OV", sheet_page: 5, document_code: "Р-ОВ", revision: "2", ...act },
  ],
  ...o,
});

describe("сигнатура причины", () => {
  it("документ и редакция фактического значения; страница файла", () => {
    expect(signaturesOf(c("1"))).toEqual(["doc:Р-ОВ@2", "page:RD-OV#5"]);
  });
  it("без фактического фрагмента сигнатуры нет — такого не группируем", () => {
    expect(signaturesOf({ ...c("1"), fragments: [c("1").fragments[0]] })).toEqual([]);
  });
});

describe("сигнатура: граничные случаи (добивание мутантов)", () => {
  it("без шифра документа — только сигнатура страницы", () => {
    expect(signaturesOf(c("1", {}, { document_code: null }))).toEqual(["page:RD-OV#5"]);
  });
  it("без файла или без страницы — сигнатуры страницы нет", () => {
    expect(signaturesOf(c("1", {}, { file_id: null }))).toEqual(["doc:Р-ОВ@2"]);
    expect(signaturesOf(c("1", {}, { sheet_page: null }))).toEqual(["doc:Р-ОВ@2"]);
  });
  it("без шифра и без страницы — соседей нет, даже если у других такие же пустые поля", () => {
    const bare = (id: string) => c(id, {}, { document_code: null, sheet_page: null });
    expect(siblingsOf([bare("1"), bare("2")], "1")).toEqual([]);
  });
});

describe("соседи по общему корню", () => {
  const all = [
    c("1"),
    c("2"), // тот же документ и редакция
    c("3", {}, { sheet_page: 9 }), // тот же документ, другая страница — по документу
    c("4", {}, { document_code: "Р-ВК", revision: "1", file_id: "RD-VK" }), // чужой документ
    c("5", { review_priority: "HIGH" }), // критичный — никогда в группе
    c("6", { verification_status: "NEGATIVE_VERIFIED" }), // уже решён
    c("7", { finding_status: "SUSPICION" }), // не кандидат
    c("8", {}, { document_code: "Р-ОВ", revision: "3", file_id: "RD-OV3" }), // та же марка, другая редакция
  ];
  it("предлагает нерешённых кандидатов с той же сигнатурой, без критичных", () => {
    expect(siblingsOf(all, "1").map((s) => s.id)).toEqual(["2", "3"]);
  });
  it("исходного кандидата в списке нет", () => {
    expect(siblingsOf(all, "1").some((s) => s.id === "1")).toBe(false);
  });
  it("у кандидата без сигнатуры соседей нет", () => {
    expect(siblingsOf([{ ...c("1"), fragments: [] }, c("2")], "1")).toEqual([]);
  });
  it("неизвестный кандидат — пустой список, не ошибка", () => {
    expect(siblingsOf(all, "нет")).toEqual([]);
  });
  it("группа не больше 20 — дальше инспектор решает по одному", () => {
    const many = [c("0"), ...Array.from({ length: 30 }, (_, i) => c(String(i + 100)))];
    expect(siblingsOf(many, "0")).toHaveLength(20);
  });
});
