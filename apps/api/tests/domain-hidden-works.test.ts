// T-038: скрытые работы из Общих данных против принятых АОСР (OS-INSP-1.4.4). Имя теста — ссылка трассы.
import { describe, expect, it } from "vitest";
import { covers, dedupeItems, evaluateHiddenWorks, isAccepted, isAct, keywords, type ActDoc, type HiddenWorkItem } from "../src/domain/hidden-works.ts";

const item = (n: number, text: string, over: Partial<HiddenWorkItem> = {}): HiddenWorkItem => ({
  n, text, file_id: "f-kzh", sha256: "a".repeat(64), stage: "RD", document_code: "СК2-Р-КЖ", revision: "1", approval_status: "FOR_CONSTRUCTION",
  page: 3, bbox: [0.1, 0.1, 0.4, 0.12], ...over,
});
const act = (code: string, title: string | null, over: Partial<ActDoc> = {}): ActDoc => ({
  file_id: `f-${code}`, sha256: "b".repeat(64), file_name: `${code}.docx`, document_code: code, revision: "1", approval_status: "APPROVED", revision_role: "CURRENT", title, ...over,
});

const SEV_ITEMS = [item(1, "Армирование фундаментной плиты"), item(2, "Гидроизоляция фундаментной плиты"), item(3, "Устройство закладных деталей")];
const SEV_DOCS = [
  act("СК2-ИД-АОСР-07", "АОСР № 7. Армирование фундаментной плиты"),
  act("СК2-ИД-ЖБР", "Журнал бетонных работ (выписка)"),
  act("СК2-ИД-ТП", "Технический план здания"),
];

describe("OS-INSP-1.4.4 перечень скрытых работ сверяется с принятыми АОСР", () => {
  it("позиция с актом — NEGATIVE_VERIFIED со ссылкой на АОСР; без акта — MISSING_EVIDENCE HW-<n> с основанием", () => {
    const r = evaluateHiddenWorks(SEV_ITEMS, SEV_DOCS);
    expect(r.map((c) => [c.param_code, c.status, c.actual])).toEqual([
      ["HW-1", "NEGATIVE_VERIFIED", "СК2-ИД-АОСР-07"],
      ["HW-2", "MISSING_EVIDENCE", null],
      ["HW-3", "MISSING_EVIDENCE", null],
    ]);
    expect(r[1].reason).toBe("Перечень скрытых работ (СК2-Р-КЖ, ред. 1, стр. 3), позиция 2 «Гидроизоляция фундаментной плиты»: среди принятых документов ИД нет АОСР на эту работу — запросите акт освидетельствования скрытых работ.");
    expect(r[0].reason).toContain("закрыта актом СК2-ИД-АОСР-07 «АОСР № 7. Армирование фундаментной плиты»");
    expect(r[0].fragments.map((f) => [f.stage, f.kind, f.document_code, f.page])).toEqual([["RD", "expected", "СК2-Р-КЖ", 3], ["ID", "actual", "СК2-ИД-АОСР-07", 1]]);
    expect(r[1].fragments).toHaveLength(1);
    expect(r[1].title).toBe("Скрытые работы: Гидроизоляция фундаментной плиты");
  });

  it("общие слова без совпадения вида работ акт не засчитывают: гидроизоляция ≠ армирование той же плиты", () => {
    expect(covers("Гидроизоляция фундаментной плиты", SEV_DOCS[0])).toBe(false);
    expect(covers("Армирование фундаментных плит", SEV_DOCS[0])).toBe(true); // падеж и число не мешают
    expect(covers("Устройство закладных деталей", act("АОСР-1", "Устройство фундамента"))).toBe(false); // «устройство» — служебное
    expect(covers("Армирование плиты перекрытия типового этажа", SEV_DOCS[0])).toBe(false); // вид совпал, но меньше половины слов
    expect(covers("…", SEV_DOCS[0])).toBe(false);
    expect(keywords("Устройство закладных деталей")).toEqual(["закла", "детал"]);
  });

  it("АОСР узнаётся по шифру, имени файла или заголовку; заменённые и аннулированные акты не принимаются", () => {
    expect(isAct(act("СК2-ИД-АОСР-07", null))).toBe(true);
    expect(isAct(act("X-1", null, { file_name: "SEV-ID-AOSR-7.docx" }))).toBe(true);
    expect(isAct(act("X-2", "Акт освидетельствования скрытых работ № 12"))).toBe(true);
    expect(isAct(act("СК2-ИД-ЖБР", "Журнал бетонных работ"))).toBe(false);
    expect(isAccepted({ approval_status: "SUPERSEDED", revision_role: "SUPERSEDED" })).toBe(false);
    expect(isAccepted({ approval_status: "CANCELLED", revision_role: "CURRENT" })).toBe(false);
    expect(isAccepted({ approval_status: "APPROVED", revision_role: "SUPERSEDED" })).toBe(false);
    const r = evaluateHiddenWorks([SEV_ITEMS[0]], [act("СК2-ИД-АОСР-07", "АОСР № 7. Армирование фундаментной плиты", { approval_status: "CANCELLED" })]);
    expect(r[0].status).toBe("MISSING_EVIDENCE");
  });

  it("одна работа в перечнях ПД и РД — одна проверка; нет перечня — нет проверок", () => {
    const pd = item(1, "Армирование фундаментной плиты", { stage: "PD", document_code: "СК2-П-КР" });
    expect(dedupeItems([SEV_ITEMS[0], pd]).map((i) => i.stage)).toEqual(["PD"]);
    expect(evaluateHiddenWorks([SEV_ITEMS[0], pd, SEV_ITEMS[1]], SEV_DOCS).map((c) => c.param_code)).toEqual(["HW-1", "HW-2"]);
    expect(evaluateHiddenWorks([], SEV_DOCS)).toEqual([]);
  });
});
