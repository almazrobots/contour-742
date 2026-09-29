// OS-INSP-2.3.2: обязательный реквизит документа ИД.
import { describe, expect, it } from "vitest";
import { evaluateRequisites, isElectronicallySigned, isWorkingDrawing, type IdDoc } from "../src/domain/requisites.ts";

const doc = (o: Partial<IdDoc> = {}): IdDoc => ({
  file_id: "f1", client_file_id: "ID-01", sha256: "a".repeat(64), file_name: "aosr.pdf", kind: "pdf", document_code: "АОСР-1", revision: "1",
  approval_status: "APPROVED", revision_role: "CURRENT", signature_status: "SCAN_SIGNED", title: null, requisites: [], ...o,
});
const sig = { kind: "signature" as const, page: 1, bbox: [0.1, 0.8, 0.3, 0.85] as [number, number, number, number], confidence: 0.8 };

describe("реквизиты документа ИД (OS-INSP-2.3.2)", () => {
  it("скан без подписи — MISSING_EVIDENCE REQ-<файл> с перечнем найденного", () => {
    const [c, ...rest] = evaluateRequisites([doc({ requisites: [{ ...sig, kind: "seal" }] })]);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ param_code: "REQ-ID-01", status: "MISSING_EVIDENCE", expected: "обязательный реквизит: подпись", actual: "найдено: печать", file_id: "f1" });
    expect(c.reason).toContain("aosr.pdf");
  });
  it("ничего не найдено — actual пуст", () => {
    expect(evaluateRequisites([doc()])[0].actual).toBeNull();
  });
  it("подпись есть — проверки нет", () => {
    expect(evaluateRequisites([doc({ requisites: [sig] })])).toEqual([]);
  });
  it("электронная подпись, DOCX/XML и заменённая редакция не проверяются", () => {
    expect(evaluateRequisites([doc({ signature_status: "UKEP" }), doc({ kind: "docx" }), doc({ kind: "xml" }), doc({ revision_role: "SUPERSEDED" })])).toEqual([]);
  });
  it("изображения проверяются как PDF; статус подписи не указан — требуется визуальная", () => {
    const r = evaluateRequisites([doc({ kind: "jpg", client_file_id: "A" }), doc({ kind: "tif", client_file_id: "B", signature_status: null })]);
    expect(r.map((c) => c.param_code)).toEqual(["REQ-A", "REQ-B"]);
    expect(r[1].reason).toContain("не указана");
  });
  it("признак электронной подписи — по точному коду, не по подстроке", () => {
    expect(["UKEP", " укэп ", "UNEP", "ЭП"].every(isElectronicallySigned)).toBe(true);
    expect(["SCAN_SIGNED", "", null, "UKEP_PENDING", "NOT_UKEP", "СКАН_ЭП"].some(isElectronicallySigned)).toBe(false);
  });
  it("PNG проверяется; заголовок проверки документа — «Реквизиты документа ИД»; найденные дата и рег. номер названы по-русски", () => {
    const [c] = evaluateRequisites([doc({ kind: "png", requisites: [{ ...sig, kind: "date" }, { ...sig, kind: "reg_number" }] })]);
    expect(c.title).toBe("Реквизиты документа ИД: АОСР-1 ред. 1");
    expect(c.actual).toBe("найдено: дата, регистрационный номер");
    expect(evaluateRequisites([doc({ requisites: [{ ...sig, kind: "seal" }, { ...sig, kind: "stamp_asbuilt" }] })])[0].actual).toBe("найдено: печать, штамп «Выполнено согласно проекту»");
  });
});

describe("штампы рабочего чертежа ИД (OS-INSP-2.3.3)", () => {
  const drawing = (kinds: string[], title = "Исполнительный чертёж фундаментной плиты") =>
    doc({ title, requisites: kinds.map((kind) => ({ ...sig, kind: kind as any })) });
  it("чертёж узнаётся по заголовку: рабочий или исполнительный чертёж или схема; ё = е; прочие документы — нет", () => {
    for (const t of ["Исполнительный чертёж плиты", "РАБОЧИЙ ЧЕРТЕЖ", "Исполнительная схема свай", "Рабочие чертежи марки КЖ"]) expect([t, isWorkingDrawing(t)]).toEqual([t, true]);
    for (const t of ["Паспорт противопожарной двери", "Общий журнал работ", "Акт освидетельствования скрытых работ", "Чертёжная бумага", null, ""]) expect([t, isWorkingDrawing(t)]).toEqual([t, false]);
  });
  it("все три реквизита есть — находки нет", () => {
    expect(evaluateRequisites([drawing(["signature", "stamp_production", "stamp_asbuilt"])])).toEqual([]);
  });
  it("нет штампа «Выполнено согласно проекту» — MISSING_EVIDENCE с названием недостающего штампа", () => {
    const [c] = evaluateRequisites([drawing(["signature", "stamp_production"])]);
    expect(c).toMatchObject({ status: "MISSING_EVIDENCE", expected: "обязательный реквизит: штамп «Выполнено согласно проекту»" });
    expect(c.title).toMatch(/^Штампы и реквизиты рабочего чертежа ИД/);
    expect(c.actual).toBe("найдено: подпись, штамп «В производство работ»");
  });
  it("нет обоих штампов — перечислены оба; нет ничего — все три", () => {
    expect(evaluateRequisites([drawing(["signature"])])[0].expected).toBe("обязательный реквизит: штамп «В производство работ», штамп «Выполнено согласно проекту»");
    expect(evaluateRequisites([drawing([])])[0].expected).toBe("обязательный реквизит: подпись, штамп «В производство работ», штамп «Выполнено согласно проекту»");
  });
  it("штампы требуются только у чертежа: паспорт с подписью без штампов — без находки", () => {
    expect(evaluateRequisites([drawing(["signature"], "Паспорт противопожарной двери")])).toEqual([]);
  });
  it("электронно подписанный чертёж визуально не проверяется", () => {
    expect(evaluateRequisites([{ ...drawing([]), signature_status: "UKEP" }])).toEqual([]);
  });
});
