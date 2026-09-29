// L1 · L3 · L5 — OS-INSP-1.2.24: шифр, раздел и редакция из имени файла. Формы имён — с реального пакета, коды синтетические.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normBase, parseDocName, revisionOf, sameBase } from "../src/domain/cipher.ts";

type Row = [string, Partial<ReturnType<typeof parseDocName>>];

// L3: таблица всех форм имён из обследования (survey-m023.md)
const ROWS: Row[] = [
  ["1. П-2099-01.001-ПЗ.pdf", { document_code: "П-2099-01.001-ПЗ", base: "2099-01-001", stage_letter: "П", discipline: "ПЗ", mark: "ПЗ", revision: "0", section_no: "1" }],
  ["1. Раздел 1 ЖС-РД-000000-П-ОПЗ 2024.pdf", { document_code: "ЖС-РД-000000-П-ОПЗ", base: "ЖС-РД-000000", stage_letter: "П", discipline: "ПЗ", mark: "ОПЗ", revision: "0", section_no: "1" }],
  ["3. П-2099-01-001-АР Изм. 1.pdf", { document_code: "П-2099-01-001-АР", discipline: "АР", revision: "1", section_no: "3" }],
  ["2. П-2099-01-001-СПОЗУ (Изм.1).pdf", { document_code: "П-2099-01-001-СПОЗУ", discipline: "ПЗУ", mark: "СПОЗУ", revision: "1" }],
  ["4. П-2099-01-001-КР(27.04.26) (1).pdf", { document_code: "П-2099-01-001-КР", discipline: "КР", revision: "27.04.26" }],
  ["4. П-2099-01-001-КР.Р.pdf", { document_code: "П-2099-01-001-КР.Р", discipline: "КР", mark: "КР.Р", revision: "0" }],
  ["5.1. П-2099-01.001-ИОС1.1 от (27.4.2026).pdf", { document_code: "П-2099-01.001-ИОС1.1", discipline: "ИОС1", mark: "ИОС1.1", revision: "27.4.2026", section_no: "5.1" }],
  ["5.4. Раздел ЖС-РЛ-0000-2024-П-ИОС4 13022025.pdf", { document_code: "ЖС-РЛ-0000-2024-П-ИОС4", base: "ЖС-РЛ-0000-2024", stage_letter: "П", discipline: "ИОС4", revision: "13.02.2025", section_no: "5.4" }],
  ["9. П-2099-01.001-ПБ.pdf", { discipline: "ПБ", section_no: "9" }],
  ["10.1. П-2099-01.001-ТБЭО.pdf", { discipline: "ТБЭО", section_no: "10.1" }],
  ["6. П-2099-01-001-ПОС (Изм. 1) (1).pdf", { discipline: "ПОС", revision: "1" }],
  ["РД-2099-01-001-АР1.pdf", { document_code: "РД-2099-01-001-АР1", stage_letter: "РД", base: "2099-01-001", discipline: "АР", mark: "АР1", section_no: null }],
  ["Р-2099-01.001-ВК1.pdf", { stage_letter: "Р", base: "2099-01-001", discipline: "ВК", mark: "ВК1" }],
  ["П-2099-01-001-КЖ01 11.11.2025.pdf", { stage_letter: "П", discipline: "КЖ", mark: "КЖ01", revision: "11.11.2025" }],
  ["РД-2099-01.001-ОВ (09.07.26).pdf", { stage_letter: "РД", discipline: "ОВ", revision: "09.07.26" }],
  ["Р-2099-01-001 ВК1.2.pdf", { document_code: "Р-2099-01-001 ВК1.2", stage_letter: "Р", discipline: "ВК", mark: "ВК1.2" }],
  ["7. ТР снос Объект ш 1Б корр.pdf", { document_code: null, base: null, stage_letter: null, discipline: null, mark: null, revision: "0", section_no: "7" }],
  ["5.1.П-2099-01.001-ИОС5.1-ИТП.ЭОМ (1).pdf", { document_code: "П-2099-01.001-ИОС5.1", base: "2099-01-001", discipline: "ИОС5", mark: "ИОС5.1", section_no: "5.1", revision: "0" }],
  ["6. Раздел 6 ЖС-РД_000000_П_ПОС.pdf", { document_code: "ЖС-РД_000000_П_ПОС", base: "ЖС-РД-000000", stage_letter: "П", discipline: "ПОС", section_no: "6" }],
  ["5.7. Раздел 5.7 ЖС-РЛ-000000-П-ИОС.ТХ.pdf", { document_code: "ЖС-РЛ-000000-П-ИОС.ТХ", discipline: "ТХ", mark: "ИОС.ТХ" }],
  ["3. Раздел АР от 12_02_2025.pdf", { document_code: null, base: null, discipline: "АР", mark: "АР", revision: "12.02.2025" }],
];

describe("parseDocName — формы имён пакета (L3)", () => {
  it.each(ROWS)("%s", (name, want) => {
    expect(parseDocName(name)).toMatchObject(want);
  });
});


// Таблица разделов: каждая марка → раздел (ключ таблицы кода проверяется независимым списком)
const MARKS: Array<[string, string]> = [
  ["ПЗ", "ПЗ"], ["ОПЗ", "ПЗ"], ["ПЗУ", "ПЗУ"], ["СПОЗУ", "ПЗУ"], ["АР", "АР"], ["КР", "КР"], ["КЖ", "КЖ"], ["КЖИ", "КЖИ"], ["КМ", "КМ"],
  ["КМД", "КМД"], ["КД", "КД"], ["ИОС", "ИОС"], ["ИОС2", "ИОС2"], ["ИОС07", "ИОС7"], ["ПБ", "ПБ"], ["ПОС", "ПОС"], ["ПОД", "ПОД"], ["ООС", "ООС"], ["ОДИ", "ОДИ"],
  ["ЭЭ", "ЭЭ"], ["БЭО", "БЭО"], ["ТБЭО", "ТБЭО"], ["ТХ", "ТХ"], ["ТР", "ТР"], ["ПГМ", "ПГМ"], ["ГОЧС", "ГОЧС"], ["ИТМ", "ИТМ"], ["СМ", "СМ"],
  ["ОВ", "ОВ"], ["ОВиК", "ОВ"], ["ВК", "ВК"], ["НВК", "НВК"], ["ЭОМ", "ЭОМ"], ["ЭМ", "ЭМ"], ["ЭО", "ЭО"], ["ЭН", "ЭН"], ["ЭС", "ЭС"], ["ТС", "ТС"],
  ["ТМ", "ТМ"], ["АОВ", "АОВ"], ["АВК", "АВК"], ["СС", "СС"], ["ГП", "ГП"], ["ГС", "ГС"], ["АС", "АС"], ["АИ", "АИ"], ["ПС", "ПС"], ["ПТ", "ПТ"],
  ["АПС", "АПС"], ["СОУЭ", "СОУЭ"], ["ПОР", "ПОР"], ["ОДД", "ОДД"], ["ИЛО", "ИЛО"], ["АД", "АД"],
];
describe("таблица разделов (L3)", () => {
  it.each(MARKS)("марка %s → раздел %s", (mark, want) => {
    expect(parseDocName(`П-2099-01-001-${mark}.pdf`).discipline).toBe(want);
    expect(parseDocName(`Раздел ${mark}.pdf`).discipline).toBe(want);
  });
});

describe("parseDocName — частные правила (L1)", () => {
  it("цифровой шифр договора с литерой объекта: комплект и раздел без буквы стадии (T-132)", () => {
    expect(parseDocName("133-0000-ОК-1-ГП1_изм.3 ЭЦП 19.06.2026.pdf")).toMatchObject({ document_code: "133-0000-ОК-1-ГП1", base: "133-0000-ОК-1", stage_letter: null, discipline: "ГП", revision: "3" });
    expect(parseDocName("133-0000-ОК-1-ПЗУ1_МГЭ_РнИ+.pdf")).toMatchObject({ base: "133-0000-ОК-1", discipline: "ПЗУ" });
    expect(sameBase(parseDocName("133-0000-ОК-1-ГП1.pdf").base, parseDocName("133-0000-ОК-1-ПЗ2_(Корр.1).pdf").base)).toBe(true);
    // неизвестная марка после цифр — не шифр
    expect(parseDocName("2024-ОТЧЕТ-1.pdf").base).toBeNull();
  });
  it("латинские двойники в шифре и марке читаются как кириллица", () => {
    // «P» и «A», «P» латиницей
    const d = parseDocName("P-2099-01-001-AP.pdf");
    expect(d).toMatchObject({ stage_letter: "Р", discipline: "АР", base: "2099-01-001", document_code: "P-2099-01-001-AP" });
  });
  it("строчные буквы шифра — тот же шифр; код отдаётся как в имени", () => {
    expect(parseDocName("п-2099-01-001-кр.pdf")).toMatchObject({ document_code: "п-2099-01-001-кр", discipline: "КР", stage_letter: "П" });
  });
  it("неизвестная марка: шифр распознан, раздел не определён", () => {
    expect(parseDocName("П-2099-01-001-ЯЯ.pdf")).toMatchObject({ document_code: "П-2099-01-001-ЯЯ", discipline: null, mark: "ЯЯ" });
  });
  it("путь с папками: разбирается только имя файла", () => {
    expect(parseDocName("Проектная документация/АР/3. П-2099-01-001-АР.pdf")).toMatchObject({ discipline: "АР", section_no: "3" });
    expect(parseDocName("Рабочая\\Р-2099-01-001-ВК1.pdf")).toMatchObject({ discipline: "ВК" });
  });
  it("«Раздел» без марки из таблицы — раздел не определён", () => {
    expect(parseDocName("Раздел Прочее.pdf")).toMatchObject({ discipline: null, mark: null });
  });
  it("без расширения и без номера раздела", () => {
    expect(parseDocName("П-2099-01-001-ПБ")).toMatchObject({ discipline: "ПБ", section_no: null });
  });
  it("номер раздела: многоуровневый, без точки, двойной пробел, пробел в начале имени", () => {
    expect(parseDocName("10.12. П-2099-01-001-АР.pdf").section_no).toBe("10.12");
    expect(parseDocName("12 П-2099-01-001-АР.pdf").section_no).toBe("12");
    expect(parseDocName(" 1. П-2099-01-001-ПЗ.pdf").section_no).toBe("1");
    expect(parseDocName("1.  Раздел АР.pdf")).toMatchObject({ discipline: "АР", section_no: "1" });
    expect(parseDocName("2099.pdf").section_no).toBeNull();
    expect(parseDocName("5.1.2 П-2099-01-001-АР.pdf").section_no).toBe("5.1.2");
  });
  it("слово «Раздел»: номер без префикса, многозначный, с подразделом; только в начале; двойные пробелы", () => {
    expect(parseDocName("Раздел 3 АР.pdf")).toMatchObject({ discipline: "АР", section_no: "3" });
    expect(parseDocName("Раздел 12 АР.pdf")).toMatchObject({ discipline: "АР", section_no: "12" });
    expect(parseDocName("Раздел 5.12 ИОС5.pdf")).toMatchObject({ discipline: "ИОС5", section_no: "5.12" });
    expect(parseDocName("Раздел  2 АР.pdf")).toMatchObject({ discipline: "АР", section_no: "2" });
    expect(parseDocName("Раздел  АР.pdf")).toMatchObject({ discipline: "АР" });
    expect(parseDocName("раздел 4 КР.pdf")).toMatchObject({ discipline: "КР", section_no: "4" });
    expect(parseDocName("Том Раздел АР.pdf")).toMatchObject({ discipline: null });
    expect(parseDocName("ТОМ-А- АР Раздел Х.pdf")).toMatchObject({ discipline: null });
  });
  it("строка меняет длину при переводе в верхний регистр — код всё равно вырезается верно", () => {
    expect(parseDocName("ß П-2099-01-001-АР.pdf").document_code).toBe("П-2099-01-001-АР");
  });
  it("редакция ищется только после шифра: дата внутри шифра — не редакция", () => {
    expect(parseDocName("П-12.05.26-АР.pdf")).toMatchObject({ base: "12-05-26", revision: "0" });
  });
  it("ИОС без номера: подраздел маркой из таблицы — он, иначе ИОС", () => {
    expect(parseDocName("П-2099-01-001-ИОС.ЯЯ.pdf").discipline).toBe("ИОС");
    expect(parseDocName("П-2099-01-001-ИОС.ВК.pdf").discipline).toBe("ВК");
    expect(parseDocName("П-2099-01-001-ИОС2.ВК.pdf").discipline).toBe("ИОС2");
    expect(parseDocName("П-2099-01-001-АР.КР.pdf").discipline).toBe("АР");
  });
  it("разделитель «_» после буквы стадии и перед маркой", () => {
    expect(parseDocName("Р_2099_01_001_ВК1.pdf")).toMatchObject({ stage_letter: "Р", base: "2099-01-001", discipline: "ВК" });
  });
  it("ОВиК — отопление и вентиляция", () => {
    expect(parseDocName("РД-2099-01-001-ОВиК.pdf")).toMatchObject({ discipline: "ОВ" });
  });
  it("марка должна отделяться от хвоста: «АРХИВ» — не марка АР", () => {
    expect(parseDocName("П-2099-01-001-АРХИВ.pdf").discipline).toBeNull();
    expect(parseDocName("П-2099-01-001-АР1А.pdf").document_code).toBeNull();
    expect(parseDocName("П-2099-01-001-АР+КР.pdf").document_code).toBeNull();
  });
  it("шифр в середине имени после слов", () => {
    expect(parseDocName("Том 3 П-2099-01-001-АР.pdf")).toMatchObject({ document_code: "П-2099-01-001-АР", discipline: "АР" });
  });
  it("шифр, приклеенный к слову, не шифр", () => {
    expect(parseDocName("ТомП-2099-01-001-АР.pdf").document_code).toBeNull();
  });
});

describe("revisionOf (L1)", () => {
  it.each([
    ["Изм. 1", "1"],
    ["(изм.02)", "2"],
    [" 11.11.2025", "11.11.2025"],
    ["(09.07.26)", "09.07.26"],
    [" от 12_02_2025", "12.02.2025"],
    [" 13022025", "13.02.2025"],
    [" 2024", "0"],
    [" (1)", "0"],
    ["", "0"],
    [" 32.01.2025", "0"],
    [" 01.13.2025", "0"],
    [" 32012025", "0"],
    [" 01132025", "0"],
    [" 00012025", "0"],
    [" 01002025", "0"],
    [" 1.1.123", "0"],
    ["x11.11.2025", "11.11.2025"],
    ["123.11.2025", "0"],
    [" 11.11.20255", "0"],
    ["113022025", "0"],
    [" 130220255", "0"],
    ["Изм. 3 от 11.11.2025", "3"],
    ["_(Корр.1) РнС", "к1"], // T-233: листы-поправки поверх базы
    [" Корр. 2", "к2"],
    ["_корр3", "к3"],
    ["Изм 2", "2"],
    ["11.11.2025", "11.11.2025"],
    ["31.12.2025", "31.12.2025"],
    ["13022025", "13.02.2025"],
    [" 01012025", "01.01.2025"],
    [" 31122025", "31.12.2025"],
  ])("%j → %s", (tail, want) => {
    expect(revisionOf(tail)).toBe(want);
  });
});

describe("базовый шифр (L1 · L5)", () => {
  it("«2099-01.001» и «2099-01-001» — один комплект, разные — нет, пустой ни с чем не совпадает", () => {
    expect(sameBase("2099-01.001", "2099-01-001")).toBe(true);
    expect(sameBase("2099_01_001", "2099-01-001")).toBe(true);
    expect(sameBase("жс-рд-000000", "ЖС-РД-000000")).toBe(true);
    expect(sameBase("2099-01-001", "2099-01-002")).toBe(false);
    expect(sameBase(null, "2099-01-001")).toBe(false);
    expect(sameBase("2099-01-001", undefined)).toBe(false);
    expect(sameBase("", "")).toBe(false);
    expect(sameBase("..", "--")).toBe(false);
  });
  it("normBase: разделители, края, латиница", () => {
    expect(normBase(" 2099..01__001 ")).toBe("2099-01-001");
    expect(normBase("-AB-")).toBe("АВ");
    expect(normBase("kp.p")).toBe("КР-Р");
    expect(normBase("2099--01")).toBe("2099-01");
    expect(normBase("ABCEHKMOPTXY")).toBe("АВСЕНКМОРТХУ");
  });
  it("РД и ПД одного комплекта связываются по базовому шифру", () => {
    expect(sameBase(parseDocName("1. П-2099-01.001-ПЗ.pdf").base, parseDocName("РД-2099-01-001-АР1.pdf").base)).toBe(true);
  });

  const baseArb = fc
    .array(fc.stringMatching(/^[0-9A-Za-zА-Яа-я]{1,5}$/), { minLength: 1, maxLength: 5 })
    .chain((segs) => fc.array(fc.constantFrom("-", ".", "_", " "), { minLength: segs.length - 1, maxLength: segs.length - 1 }).map((seps) => segs.map((s, i) => s + (seps[i] ?? "")).join("")));

  it("L5: normBase идемпотентна", () => {
    fc.assert(fc.property(fc.string(), (s) => normBase(normBase(s)) === normBase(s)));
    fc.assert(fc.property(baseArb, (s) => normBase(normBase(s)) === normBase(s)));
  });
  it("L5: замена «.» ↔ «-» в базе не меняет sameBase", () => {
    fc.assert(fc.property(baseArb, (s) => sameBase(s, s.replace(/\./g, "-")) && sameBase(s.replace(/-/g, "."), s)));
  });
  it("L5: разобранная база — уже нормализована", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 999 }), fc.constantFrom(".", "-"), (a, b, c, sep) => {
        const d = parseDocName(`П-${a}-${String(b).padStart(2, "0")}${sep}${String(c).padStart(3, "0")}-АР.pdf`);
        return d.base !== null && normBase(d.base) === d.base && d.discipline === "АР";
      }),
    );
  });
});
