// Эшелоны: L1 (реестр объектов: стадии, документы, строка ключевого параметра), L3 (границы: пустая стадия, нет проверки,
// повтор файла в двух проверках, равные даты), L6 (чужой формат списка параметров). T-166: OS-INSP-8.1.3–8.1.7.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEY_PARAMS, documentsByStage, KEY_PARAMS_MAX, keyParamRow, latestChecks, parseKeyParams, stageCells, stageCounts,
  type CheckCandidate, type ObjectDoc,
} from "../src/domain/objects.ts";

const doc = (over: Partial<ObjectDoc>): ObjectDoc => ({
  id: "F1", file_name: "ПЗ.pdf", sha256: "a".repeat(64), doc_stage: "PD", document_code: "П-01-ПЗ", revision: "0", doc_title: null,
  revision_role: "CURRENT", inspection_id: "P-1", uploaded_at: "2026-09-01T10:00:00.000Z", ...over,
});

describe("список ключевых параметров (OS-INSP-8.1.5)", () => {
  it("по умолчанию — М-023; список через запятую; повторы и пробелы убираются, порядок сохраняется", () => {
    expect(DEFAULT_KEY_PARAMS).toEqual(["M-023"]);
    expect(parseKeyParams(undefined)).toEqual(["M-023"]);
    expect(parseKeyParams("")).toEqual(["M-023"]);
    expect(parseKeyParams(" M-001 , M-023,M-001")).toEqual(["M-001", "M-023"]);
  });
  it("чужой формат кода или больше предела — отказ (null), а не тихая подмена", () => {
    expect(parseKeyParams("M-23")).toBeNull();
    expect(parseKeyParams("M-023;drop")).toBeNull();
    expect(parseKeyParams("m-023")).toBeNull();
    expect(parseKeyParams(",")).toBeNull();
    const many = Array.from({ length: KEY_PARAMS_MAX + 1 }, (_, i) => `M-${String(i + 1).padStart(3, "0")}`).join(",");
    expect(parseKeyParams(many)).toBeNull();
    expect(parseKeyParams(many.split(",").slice(0, KEY_PARAMS_MAX).join(","))).toHaveLength(KEY_PARAMS_MAX);
  });
});

describe("файлы по стадиям (OS-INSP-8.1.3)", () => {
  it("счёт по ПД/РД/ИД; стадии без файлов — ноль; чужая стадия не считается", () => {
    expect(stageCounts([{ doc_stage: "PD", n: 3 }, { doc_stage: "ID", n: 2 }, { doc_stage: "XX", n: 9 }])).toEqual({ PD: 3, RD: 0, ID: 2 });
    expect(stageCounts([])).toEqual({ PD: 0, RD: 0, ID: 0 });
  });
  it("документы объекта: один файл (SHA-256) — один раз, из последней загрузки; пустая стадия — пустой список", () => {
    const old = doc({ id: "F1", inspection_id: "P-1", uploaded_at: "2026-09-01T10:00:00.000Z" });
    const again = doc({ id: "F2", inspection_id: "P-2", uploaded_at: "2026-09-05T10:00:00.000Z" });
    const rd = doc({ id: "F3", sha256: "b".repeat(64), doc_stage: "RD", document_code: "Р-01-АР", file_name: "АР.pdf" });
    const rd0 = doc({ id: "F4", sha256: "c".repeat(64), doc_stage: "RD", document_code: "Р-01-АР", revision: "1", file_name: "АР изм1.pdf" });
    const by = documentsByStage([old, rd, again, rd0]);
    expect(by.PD.map((d) => d.id)).toEqual(["F2"]);
    expect(by.RD.map((d) => d.id)).toEqual(["F3", "F4"]); // шифр, затем редакция
    expect(by.ID).toEqual([]);
    expect(documentsByStage([again, old]).PD.map((d) => d.id)).toEqual(["F2"]); // порядок входа не важен
    expect(documentsByStage([doc({ doc_stage: "XX" })])).toEqual({ PD: [], RD: [], ID: [] });
  });
});

describe("последняя проверка параметра по объекту (OS-INSP-8.1.4)", () => {
  const c = (over: Partial<CheckCandidate>): CheckCandidate => ({
    check_id: "C1", inspection_id: "P-1", object_id: "O-1", param_code: "M-023", finding_status: "MISSING_EVIDENCE", verification_status: "PENDING",
    stage_notes_json: null, inspection_updated_at: "2026-09-01T10:00:00.000Z", ...over,
  });
  it("на пару объект × параметр — запись последней обновлённой проверки; при равной дате — больший номер проверки", () => {
    const m = latestChecks([
      c({ check_id: "C1", inspection_id: "P-1" }),
      c({ check_id: "C2", inspection_id: "P-2", inspection_updated_at: "2026-09-03T10:00:00.000Z" }),
      c({ check_id: "C3", inspection_id: "P-3", object_id: "O-2" }),
      c({ check_id: "C4", inspection_id: "P-4", object_id: "O-2" }),
      c({ check_id: "C5", param_code: "M-001" }),
    ]);
    expect(m.get("O-1|M-023")?.check_id).toBe("C2");
    expect(m.get("O-2|M-023")?.check_id).toBe("C4");
    expect(m.get("O-1|M-001")?.check_id).toBe("C5");
    expect(m.size).toBe(3);
  });
});

describe("ячейки стадий ключевого параметра (OS-INSP-8.1.6)", () => {
  const loaded = { PD: 4, RD: 2, ID: 0 };
  it("значение со ссылкой на документ и лист; стадия без файлов — «не загружена»; загружена без значения — «не найдено»", () => {
    const cells = stageCells({
      checked: true, loaded: { PD: 4, RD: 2, ID: 0 }, notes: { PD: "USED", RD: "NO_VALUE", ID: "NOT_APPLICABLE" },
      fragments: [{ stage: "PD", extracted_value: "С0", document_code: "П-01-ПЗ", sheet_page: 7 }],
    });
    expect(cells).toEqual([
      { stage: "PD", state: "VALUE", value: "С0", document_code: "П-01-ПЗ", page: 7 },
      { stage: "RD", state: "NO_VALUE", value: null, document_code: null, page: null },
      { stage: "ID", state: "NOT_LOADED", value: null, document_code: null, page: null },
    ]);
  });
  it("стадия загружена, но параметр её не требует — «не требуется»; без проверки — «не проверялся» или «не загружена»", () => {
    const cells = stageCells({ checked: true, loaded: { PD: 1, RD: 1, ID: 1 }, notes: { ID: "NOT_APPLICABLE" }, fragments: [] });
    expect(cells.map((x) => x.state)).toEqual(["NO_VALUE", "NO_VALUE", "NOT_REQUIRED"]);
    expect(stageCells({ checked: false, loaded, notes: null, fragments: [] }).map((x) => x.state)).toEqual(["NOT_CHECKED", "NOT_CHECKED", "NOT_LOADED"]);
  });
  it("первое доказательство стадии; пустое значение фрагмента не считается найденным", () => {
    const cells = stageCells({
      checked: true, loaded, notes: {},
      fragments: [
        { stage: "RD", extracted_value: "", document_code: "Р-01-КР", sheet_page: 1 },
        { stage: "RD", extracted_value: "не ниже С1", document_code: "Р-01-АР", sheet_page: 3 },
        { stage: "RD", extracted_value: "С2", document_code: "Р-01-АР", sheet_page: 4 },
      ],
    });
    expect(cells[1]).toEqual({ stage: "RD", state: "VALUE", value: "не ниже С1", document_code: "Р-01-АР", page: 3 });
  });
});

describe("строка ключевого параметра (OS-INSP-8.1.4, 8.1.7)", () => {
  it("итог сверки, решение инспектора, независимый пересчёт и три стадии", () => {
    const row = keyParamRow("M-023", {
      check: { check_id: "C2", inspection_id: "P-2", object_id: "O-1", param_code: "M-023", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", stage_notes_json: JSON.stringify({ PD: "USED", RD: "USED", ID: "NO_VALUE" }), inspection_updated_at: "2026-09-03T10:00:00.000Z" },
      loaded: { PD: 2, RD: 1, ID: 5 },
      fragments: [
        { stage: "PD", extracted_value: "С0", document_code: "П-ПЗ", sheet_page: 2 },
        { stage: "RD", extracted_value: "С0", document_code: "Р-АР", sheet_page: 1 },
      ],
      decision: null,
      autoCheck: { verdict: "MATCH", method: "независимый пересчёт", checked_at: "2026-09-04T00:00:00.000Z" },
    });
    expect(row).toMatchObject({ code: "M-023", checked: true, inspection_id: "P-2", check_id: "C2", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", decision: null });
    expect(row.auto_check).toEqual({ verdict: "MATCH", method: "независимый пересчёт", checked_at: "2026-09-04T00:00:00.000Z" });
    expect(row.stages.map((s) => `${s.stage}:${s.state}:${s.value ?? ""}`)).toEqual(["PD:VALUE:С0", "RD:VALUE:С0", "ID:NO_VALUE:"]);
  });
  it("параметр не проверялся — пустые поля итога, стадии по загруженности; битый stage_notes_json — как пустой", () => {
    const row = keyParamRow("M-023", { check: null, loaded: { PD: 1, RD: 0, ID: 0 }, fragments: [], decision: null, autoCheck: null });
    expect(row).toMatchObject({ code: "M-023", checked: false, inspection_id: null, check_id: null, finding_status: null, verification_status: null, auto_check: null });
    expect(row.stages.map((s) => s.state)).toEqual(["NOT_CHECKED", "NOT_LOADED", "NOT_LOADED"]);
    const broken = keyParamRow("M-023", {
      check: { check_id: "C", inspection_id: "P", object_id: "O", param_code: "M-023", finding_status: "MISSING_EVIDENCE", verification_status: "PENDING", stage_notes_json: "{не json", inspection_updated_at: "2026-09-01T00:00:00.000Z" },
      loaded: { PD: 1, RD: 1, ID: 1 }, fragments: [], decision: { status: "CLARIFICATION_REQUIRED", by: "Инспектор", at: "2026-09-02T00:00:00.000Z" }, autoCheck: null,
    });
    expect(broken.stages.map((s) => s.state)).toEqual(["NO_VALUE", "NO_VALUE", "NO_VALUE"]);
    expect(broken.decision).toEqual({ status: "CLARIFICATION_REQUIRED", by: "Инспектор", at: "2026-09-02T00:00:00.000Z" });
  });
});
