// Эшелоны: L1 (форма входа и результата стенда мутаций), L3 (границы: пустой набор, длинные имена), L6 (враждебный вход:
// путь из набора наружу, чужие поля, не тот хеш). Стенд мутаций L11 (T-179, OS-INSP-6.5.44): вход — JSON генератора,
// то есть файл снаружи API; он проверяется схемой до чтения PDF, имя файла — только имя, без каталогов.
import { describe, expect, it } from "vitest";
import { benchRow, MutationDataset, safeFileName } from "../src/domain/mutation-bench.ts";

const sha = "a".repeat(64);
const file = (over: Record<string, unknown> = {}) => ({
  file_id: "MUT-1-0000-pd1", file_name: "П-1-0000-ПЗ изм1.pdf", sha256: sha, doc_stage: "PD", discipline: "ПЗ", document_code: "П-1-0000-ПЗ",
  revision: "1", approval_status: "APPROVED", approval_date: "10.02.2026", predecessor_id: null, ...over,
});
const dataset = (cases: unknown[]) => ({ schema: "inspector-mutations/1", dataset_version: "mutations-w1:seed=1", cases });
const kase = (over: Record<string, unknown> = {}) => ({ case_id: "MUT-1-0000", profile: { residential: true }, files: [file(), file({ file_id: "MUT-1-0000-rd1", file_name: "Р-1-0000-АР изм1.pdf", doc_stage: "RD", document_code: "Р-1-0000-АР", discipline: "АР", approval_status: "FOR_CONSTRUCTION" })], ...over });

describe("стенд мутаций: вход генератора (OS-INSP-6.5.44)", () => {
  it("набор генератора принимается: пример, файлы ПД и РД, профиль объекта", () => {
    const ds = MutationDataset.parse(dataset([kase()]));
    expect(ds.cases[0].files.map((f) => f.doc_stage)).toEqual(["PD", "RD"]);
    expect(ds.cases[0].profile).toEqual({ residential: true });
  });

  it("имя файла с каталогом или «..» — отказ до чтения диска: набор не выводит за свой каталог", () => {
    for (const bad of ["../secret.pdf", "a/b.pdf", "a\\b.pdf", "..", ".", ""]) expect(() => safeFileName(bad)).toThrow(/имя файла/);
    expect(safeFileName("Р-1-0000-АР изм2.pdf")).toBe("Р-1-0000-АР изм2.pdf");
    expect(() => MutationDataset.parse(dataset([kase({ files: [file({ file_name: "../../etc/passwd" })] })]))).toThrow();
  });

  it("идентификатор примера — только буквы, цифры и дефис: из него строится имя каталога", () => {
    expect(() => MutationDataset.parse(dataset([kase({ case_id: "../x" })]))).toThrow();
    expect(() => MutationDataset.parse(dataset([kase({ case_id: "MUT 1" })]))).toThrow();
    expect(MutationDataset.parse(dataset([kase({ case_id: "MUT-12-0042" })])).cases[0].case_id).toBe("MUT-12-0042");
  });

  it("хеш — 64 hex, стадия — PD/RD/ID, статус утверждения — из справочника; чужая схема набора — отказ", () => {
    expect(() => MutationDataset.parse(dataset([kase({ files: [file({ sha256: "zz" })] })]))).toThrow();
    expect(() => MutationDataset.parse(dataset([kase({ files: [file({ doc_stage: "XX" })] })]))).toThrow();
    expect(() => MutationDataset.parse(dataset([kase({ files: [file({ approval_status: "OK" })] })]))).toThrow();
    expect(() => MutationDataset.parse({ ...dataset([kase()]), schema: "other/1" })).toThrow();
    expect(() => MutationDataset.parse(dataset([kase({ files: [] })]))).toThrow();
  });

  it("лишние поля генератора (истина, фокус) API не нужны и не мешают — отбрасываются", () => {
    const ds = MutationDataset.parse({ ...dataset([{ ...kase(), truth: [1], focus: ["x"] }]), truth: [] });
    expect(Object.keys(ds.cases[0]).sort()).toEqual(["case_id", "files", "profile"]);
  });

  it("предел размера: больше 5000 примеров или 8 файлов в примере — отказ (защита памяти стенда)", () => {
    expect(() => MutationDataset.parse(dataset(Array.from({ length: 5001 }, () => kase())))).toThrow();
    expect(() => MutationDataset.parse(dataset([kase({ files: Array.from({ length: 9 }, () => file()) })]))).toThrow();
    expect(MutationDataset.parse(dataset([kase({ files: Array.from({ length: 8 }, () => file()) })])).cases[0].files).toHaveLength(8);
  });
});

describe("стенд мутаций: результат по параметру", () => {
  it("строка результата: статус, значения, доказательства с файлом генератора, страницей и рамкой", () => {
    const fileIds = new Map([["f-api-1", "MUT-1-0000-rd1"]]);
    const row = benchRow(
      { param_code: "M-023", finding_status: "CANDIDATE", expected_value: "С0", actual_value: "С1", delta: "С0 → С1", reason: "понижен" },
      [{ file_id: "f-api-1", stage: "RD", document_code: "Р-1-0000-АР", sheet_page: 1, bbox_polygon_norm: "[0.1,0.2,0.3,0.4]", extracted_value: "С1", role_expected_actual: "actual" }],
      fileIds,
    );
    expect(row).toEqual({
      code: "M-023", status: "CANDIDATE", expected: "С0", actual: "С1", delta: "С0 → С1", reason: "понижен",
      fragments: [{ file_id: "MUT-1-0000-rd1", stage: "RD", document_code: "Р-1-0000-АР", page: 1, bbox: [0.1, 0.2, 0.3, 0.4], value: "С1", kind: "actual" }],
    });
  });

  it("фрагмент без рамки и неизвестного файла: рамка null, файл — как в API (не подменяется)", () => {
    const row = benchRow({ param_code: "M-001", finding_status: "MISSING_EVIDENCE", expected_value: null, actual_value: null, delta: null, reason: "нет" }, [
      { file_id: "f-x", stage: "PD", document_code: "П", sheet_page: 2, bbox_polygon_norm: null, extracted_value: "1", role_expected_actual: "expected" },
    ], new Map());
    expect(row.fragments[0]).toMatchObject({ file_id: "f-x", bbox: null, kind: "expected" });
  });
});
