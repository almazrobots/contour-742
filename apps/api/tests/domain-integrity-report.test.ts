// OS-INSP-1.2.31–1.2.35 (T-120): целостность пакета по реестру — исключённые, дубли по содержимому, неполные по числу
// страниц; отчёт по каждому файлу реестра и доля файлов, учтённых без расхождений. Формат отчёта читает стенд
// (ml/eval/integrity.py, OS-INSP-6.5.12).
import { describe, expect, it } from "vitest";
import { documentCounts, loadCodes } from "../src/domain/completeness.ts";
import { duplicateOf, integrityReport, isExcluded, pagesMismatch, type DeclaredFile, type StoredFile } from "../src/domain/integrity-report.ts";

const H = (c: string) => c.repeat(64);
const decl = (file_id: string, extra: Partial<DeclaredFile> = {}): DeclaredFile => ({ file_id, file_name: `${file_id}.pdf`, ...extra });
const stored = (client_file_id: string, extra: Partial<StoredFile> = {}): StoredFile =>
  ({ client_file_id, file_name: `${client_file_id}.pdf`, sha256: H("a"), pages: 10, part_of: null, ...extra });

describe("OS-INSP-1.2.32 исключённый реестром файл", () => {
  it("исключён, если в реестре указана причина; пустая строка — не исключение", () => {
    expect(isExcluded({ exclusion_reason: "дубль тома" })).toBe(true);
    expect(isExcluded({ exclusion_reason: "  " })).toBe(false);
    expect(isExcluded({ exclusion_reason: null })).toBe(false);
    expect(isExcluded({})).toBe(false);
  });
});

describe("OS-INSP-1.2.33 дубль по содержимому", () => {
  it("тот же SHA-256 под другим file_id — дубль принятого; под тем же file_id — не дубль (повторная загрузка)", () => {
    const accepted = [stored("F1", { sha256: H("b") })];
    expect(duplicateOf(accepted, "F2", H("b"))).toBe("F1");
    expect(duplicateOf(accepted, "F1", H("b"))).toBeNull();
    expect(duplicateOf(accepted, "F3", H("c"))).toBeNull();
  });
});

describe("OS-INSP-1.2.34 неполный файл по числу страниц", () => {
  it("расхождение — только когда оба числа известны и не равны", () => {
    expect(pagesMismatch(12, 10)).toBe(true);
    expect(pagesMismatch(10, 10)).toBe(false);
    expect(pagesMismatch(null, 10)).toBe(false);
    expect(pagesMismatch(undefined, 10)).toBe(false);
    expect(pagesMismatch(12, null)).toBe(false);
  });
  it("неполный файл не считается принятым: стадия PARTIAL; исключённый реестром не считается объявленным", () => {
    const declared = [
      { file_id: "P1", doc_stage: "PD" as const },
      { file_id: "P2", doc_stage: "PD" as const },
      { file_id: "R1", doc_stage: "RD" as const, exclusion_reason: "не относится к объекту" },
      { file_id: "R2", doc_stage: "RD" as const },
    ];
    const up = [
      { client_file_id: "P1", doc_stage: "PD" as const },
      { client_file_id: "P2", doc_stage: "PD" as const },
      { client_file_id: "R2", doc_stage: "RD" as const },
    ];
    expect(loadCodes(documentCounts(declared, up))).toEqual(["PD_UPLOADED", "RD_UPLOADED", "ID_MISSING"]);
    expect(loadCodes(documentCounts(declared, up, new Set(["P2"])))).toEqual(["PD_PARTIAL", "RD_UPLOADED", "ID_MISSING"]);
  });
  it("единственный файл стадии неполный — стадия PARTIAL, а не MISSING", () => {
    const one = documentCounts([{ file_id: "P1", doc_stage: "PD" as const }], [{ client_file_id: "P1", doc_stage: "PD" as const }], new Set(["P1"]));
    expect(loadCodes(one)[0]).toBe("PD_PARTIAL");
  });
});

describe("OS-INSP-1.2.35 отчёт о целостности пакета", () => {
  const declared = [
    decl("F1", { sha256: H("a"), pdf_pages: 10 }),
    decl("F2", { pdf_pages: 12 }),
    decl("F3", { exclusion_reason: "исключён организатором" }),
    decl("F4"),
    decl("F5"),
    decl("F6"),
    decl("F7", { part_of: "F1" }),
  ];
  const files = [stored("F1"), stored("F2", { sha256: H("c"), pages: 10 }), stored("F7", { sha256: H("d"), part_of: "F1" }), stored("X9", { sha256: H("e") })];
  const rejections = [
    { file_name: "F4.pdf", code: "DUPLICATE_CONTENT", message: "дубль", duplicate_of: "F1" },
    { file_name: "F5.pdf", code: "HASH_MISMATCH", message: "SHA-256 не совпадает с реестром" },
  ];
  const r = integrityReport(declared, files, rejections);
  const by = Object.fromEntries(r.files.map((f) => [f.file_id, f]));

  it("по каждому файлу реестра — статус: принят, неполный, исключён, дубль, отклонён, не пришёл, часть", () => {
    expect(by.F1.status).toBe("ACCEPTED");
    expect(by.F2).toMatchObject({ status: "INCOMPLETE", pages: 10, declared_pages: 12 });
    expect(by.F3).toMatchObject({ status: "EXCLUDED", reason: "исключён организатором" });
    expect(by.F4).toMatchObject({ status: "DUPLICATE", duplicate_of: "F1" });
    expect(by.F5).toMatchObject({ status: "REJECTED", reason: "HASH_MISMATCH: SHA-256 не совпадает с реестром" });
    expect(by.F6.status).toBe("MISSING");
    expect(by.F7).toMatchObject({ status: "PART", part_of: "F1" });
  });

  it("доля — файлы реестра без расхождений (принят, часть, исключён, дубль) из всех файлов реестра; вне реестра — отдельно", () => {
    expect(r.share).toBeCloseTo(4 / 7, 6);
    expect(r.declared).toBe(7);
    expect(r.outside_registry).toEqual(["X9"]);
    expect(r.files.some((f) => f.file_id === "X9")).toBe(false);
  });

  it("принятый файл важнее прежнего отказа: отказ при первой загрузке и приём при дозагрузке — принят", () => {
    const again = integrityReport([decl("F1")], [stored("F1")], [{ file_name: "F1.pdf", code: "UNSUPPORTED_FORMAT", message: "…" }]);
    expect(again.files[0].status).toBe("ACCEPTED");
  });

  it("реестра нет — доля не измерена (null), а не 0 и не 1", () => {
    const none = integrityReport([], [stored("F1")], []);
    expect(none.share).toBeNull();
    expect(none.outside_registry).toEqual(["F1"]);
  });
});
