// T-036: реальные форматы (OS-INSP-1.2.9) и документы частями (OS-INSP-1.2.10). Имя теста — ссылка трассы.
import { describe, expect, it } from "vitest";
import { documentCounts, loadCodes, scenario } from "../src/domain/completeness.ts";
import { pageOffsets, selectRevisions, type RevisionInput } from "../src/domain/revisions.ts";
import { checkFile, ManifestFile, MAX_FILE_BYTES, parseCsvManifest, sniff, SUPPORTED } from "../src/domain/upload.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR....IDAT....IEND\xaeB`\x82", "latin1")]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const TIF_LE = Buffer.from("II*\0\x08\0\0\0", "latin1");
const TIF_BE = Buffer.from("MM\0*\0\0\0\x08", "latin1");
const zip = (...names: string[]) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), ...names.map((n) => Buffer.from(`\0\0\0\0${n}\0\0`))]);

describe("OS-INSP-1.2.9 XLSX и изображения принимаются как документы пакета", () => {
  it("sniff: XLSX по части xl/ в ZIP, JPEG, PNG, TIFF (II и MM) — по сигнатуре, не по расширению", () => {
    expect(sniff(zip("[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"))).toBe("xlsx");
    expect(sniff(zip("[Content_Types].xml", "word/document.xml"))).toBe("docx");
    expect(sniff(JPG)).toBe("jpg");
    expect(sniff(PNG)).toBe("png");
    expect(sniff(TIF_LE)).toBe("tif");
    expect(sniff(TIF_BE)).toBe("tif");
  });

  it("sniff: ZIP без word/ и xl/, усечённая сигнатура PNG, GIF и BMP — не документ", () => {
    expect(sniff(zip("mimetype", "content.xml"))).toBeNull();
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(sniff(Buffer.from("GIF89a\x01\0", "latin1"))).toBeNull();
    expect(sniff(Buffer.from("BM\0\0\0\0", "latin1"))).toBeNull();
    expect(sniff(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniff(Buffer.from("II*", "latin1"))).toBeNull();
  });

  it("checkFile: XLSX, JPG, PNG, TIF приняты; отказ перечисляет новый список форматов", () => {
    expect(checkFile("ведомость.xlsx", zip("xl/workbook.xml"))).toEqual({ ok: true, kind: "xlsx" });
    expect(checkFile("паспорт.jpg", JPG)).toEqual({ ok: true, kind: "jpg" });
    expect(checkFile("паспорт.png", PNG)).toEqual({ ok: true, kind: "png" });
    expect(checkFile("сертификат.tif", TIF_LE)).toEqual({ ok: true, kind: "tif" });
    expect(SUPPORTED).toEqual(["PDF", "DOCX", "XML", "XLSX", "JPG", "PNG", "TIF"]);
    const bad = checkFile("фото.gif", Buffer.from("GIF89a", "latin1"));
    expect(bad).toEqual({ ok: false, code: "UNSUPPORTED_FORMAT", message: "фото.gif: неподдерживаемый формат; поддерживаются PDF, DOCX, XML, XLSX, JPG, PNG, TIF" });
  });

  it("checkFile: PNG без конца файла (IEND) — CORRUPTED", () => {
    const cut = PNG.subarray(0, PNG.length - 8);
    const v = checkFile("скан.png", cut);
    expect(v.ok).toBe(false);
    if (!v.ok) expect([v.code, v.message]).toEqual(["CORRUPTED", "скан.png: PNG повреждён (нет конца файла) — загрузите файл повторно"]);
  });
});

// ─────────────────────────────── OS-INSP-1.2.10

const R = (id: string, over: Partial<RevisionInput> = {}): RevisionInput => ({
  file_id: `f-${id}`,
  client_file_id: id,
  doc_stage: "ID",
  document_code: "ОЖР",
  revision: "1",
  approval_status: "APPROVED",
  predecessor_id: null,
  ...over,
});

describe("OS-INSP-1.2.10 документ больше 50 МБ принимается частями и собирается в один", () => {
  it("предел 50 МБ — на часть; отказ подсказывает разделить документ на части в реестре", () => {
    const v = checkFile("ожр.pdf", Buffer.alloc(MAX_FILE_BYTES + 1));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain("разделите документ на части и свяжите их в реестре (part_of, part_index)");
    expect(checkFile("ожр-1.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(MAX_FILE_BYTES - 20), Buffer.from("%%EOF")])).ok).toBe(true);
  });

  it("реестр: part_of и part_index в JSON и CSV; номер части — целое от 1", () => {
    const base = { file_id: "P2", file_name: "p2.pdf", doc_stage: "ID", discipline: "КЖ", document_code: "ОЖР", revision: "1" };
    expect(ManifestFile.parse({ ...base, part_of: "P1", part_index: 2 })).toMatchObject({ part_of: "P1", part_index: 2 });
    expect(ManifestFile.safeParse({ ...base, part_of: "P1", part_index: 0 }).success).toBe(false);
    const csv = parseCsvManifest("file_id;file_name;doc_stage;discipline;document_code;revision;part_of;part_index\nP1;p1.pdf;ID;КЖ;ОЖР;1;;1\nP2;p2.pdf;ID;КЖ;ОЖР;1;P1;2\n");
    expect(csv.files.map((f) => [f.part_of, f.part_index])).toEqual([[null, 1], ["P1", 2]]);
  });

  it("части одного документа не дают CONFLICT: роль основного документа наследуют все части", () => {
    const files = [R("P1", { part_index: 1 }), R("P2", { part_of: "P1", part_index: 2 }), R("P3", { part_of: "P1", part_index: 3 })];
    const roles = selectRevisions(files, true);
    expect([...roles.values()].map((r) => r.role)).toEqual(["CURRENT", "CURRENT", "CURRENT"]);
    expect(roles.get("f-P3")!.note).toBe("часть 3 документа P1; ред. 1 — эталон");
    // без part_of те же файлы с одним шифром — равноправные кандидаты, то есть CONFLICT
    const plain = selectRevisions([R("P1"), R("P2")], true);
    expect([...plain.values()].map((r) => r.role)).toEqual(["CONFLICT", "CONFLICT"]);
  });

  it("части заменённой редакции заменены вместе с основным документом; без основного представитель — меньшая часть", () => {
    const files = [
      R("A1", { revision: "A" }),
      R("A2", { revision: "A", part_of: "A1", part_index: 2 }),
      R("B1", { revision: "B", predecessor_id: "A1" }),
      R("B2", { revision: "B", part_of: "B1", part_index: 2 }),
    ];
    const roles = selectRevisions(files, true);
    expect(["f-A1", "f-A2", "f-B1", "f-B2"].map((id) => roles.get(id)!.role)).toEqual(["SUPERSEDED", "SUPERSEDED", "CURRENT", "CURRENT"]);
    const orphan = selectRevisions([R("C3", { part_of: "C1", part_index: 3 }), R("C2", { part_of: "C1", part_index: 2 })], true);
    expect(orphan.get("f-C2")!.note).toBe("ред. 1 — эталон");
    expect(orphan.get("f-C3")!.role).toBe("CURRENT");
  });

  it("комплектность: части — один документ; пока не пришли все части, стадия PARTIAL", () => {
    const declared = [
      { file_id: "PZ", doc_stage: "PD" as const },
      { file_id: "AR", doc_stage: "RD" as const },
      { file_id: "J1", doc_stage: "ID" as const },
      { file_id: "J2", doc_stage: "ID" as const, part_of: "J1" },
    ];
    const up = (ids: string[]) => ids.map((id) => ({ client_file_id: id, doc_stage: declared.find((d) => d.file_id === id)!.doc_stage, part_of: declared.find((d) => d.file_id === id)!.part_of ?? null }));
    const full = documentCounts(declared, up(["PZ", "AR", "J1", "J2"]));
    expect(full.ID).toEqual({ declared: 1, uploaded: 1 });
    expect(scenario(full)).toBe("FULL");
    const half = documentCounts(declared, up(["PZ", "AR", "J1"]));
    expect(half.ID).toEqual({ declared: 2, uploaded: 1 }); // незавершённый документ считается по частям
    expect(loadCodes(half)).toEqual(["PD_UPLOADED", "RD_UPLOADED", "ID_PARTIAL"]);
    // файл вне реестра считается по своей стадии, как и прежде
    expect(documentCounts([], [{ client_file_id: "x.pdf", doc_stage: "RD", part_of: null }]).RD).toEqual({ declared: 0, uploaded: 1 });
  });

  it("страницы нумеруются сквозь части: смещение части = страницы предыдущих частей", () => {
    const off = pageOffsets([
      { file_id: "f2", client_file_id: "J2", part_of: "J1", part_index: 2, pages: 3 },
      { file_id: "f1", client_file_id: "J1", part_of: null, part_index: 1, pages: 3 },
      { file_id: "f3", client_file_id: "J3", part_of: "J1", part_index: 3, pages: 4 },
      { file_id: "g", client_file_id: "PZ", pages: 10 },
    ]);
    expect(Object.fromEntries(off)).toEqual({ f1: 0, f2: 3, f3: 6, g: 0 });
    // предыдущая часть ещё не разобрана — смещение неизвестно, не выдумываем
    const pending = pageOffsets([
      { file_id: "f1", client_file_id: "J1", part_index: 1, pages: null },
      { file_id: "f2", client_file_id: "J2", part_of: "J1", part_index: 2, pages: 3 },
    ]);
    expect(pending.get("f2")).toBeNull();
  });
});
