// T-121 (OS-INSP-5.1.6): протокол по образцу Приложения № 2 (SRC-INSP-08) — семь разделов в порядке образца.
import { describe, expect, it } from "vitest";
import { appendix2, type Appendix2Input } from "../src/domain/appendix2.ts";

const chk = (o: Partial<Appendix2Input["checks"][number]>): Appendix2Input["checks"][number] => ({
  id: "F", param_code: "M-055", org_code: "KR-055", section: "КР", parameter_name: "Класс бетона", critical: true, trigger_logic: "Понижение класса бетона",
  source_id: "Акт АОСР", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", delta: null, fragments: [], decision: null, ...o,
});

const input: Appendix2Input = {
  process_id: "P-1",
  protocol_version: 3,
  generated_at: "2026-09-27T14:00:00.000Z",
  status: "VERIFYING",
  object: { name: "Алтуфьевское ш., 79Б", address: "г. Москва", permit_number: "77-123", customer: "ООО «Заказчик»", contractor: null },
  files: [{ doc_stage: "PD" }, { doc_stage: "PD" }, { doc_stage: "RD" }],
  declared: [{ doc_stage: "PD" }, { doc_stage: "PD" }, { doc_stage: "RD" }, { doc_stage: "RD" }, { doc_stage: "ID" }],
  checks: [
    chk({ id: "F-55", finding_status: "CANDIDATE", verification_status: "CONFIRMED_VIOLATION", delta: "-10", fragments: [{ stage: "PD", value: "B35" }, { stage: "RD", value: "B25" }], decision: { action: "confirm", comment: "Пересчёт несущей способности" } }),
    chk({ id: "F-30", param_code: "M-030", org_code: "SPZU-030", section: "СПЗУ", parameter_name: "Ширина проездов", critical: false, finding_status: "CANDIDATE", fragments: [{ stage: "PD", value: "6" }, { stage: "RD", value: "4,2" }] }),
    chk({ id: "F-59", param_code: "M-059", org_code: "KR-059", parameter_name: "Толщина плит", finding_status: "MISSING_EVIDENCE", source_id: "Исполнительная схема плит", fragments: [{ stage: "PD", value: "200" }, { stage: "RD", value: "200" }] }),
    chk({ id: "F-58", param_code: "M-058", org_code: "KR-058", finding_status: "MISSING_EVIDENCE", fragments: [] }),
    chk({ id: "F-57", param_code: "M-057", org_code: "KR-057", finding_status: "NEGATIVE_VERIFIED" }),
    chk({ id: "F-56", param_code: "M-056", org_code: "KR-056", finding_status: "CANDIDATE", verification_status: "NEGATIVE_VERIFIED", decision: { action: "reject", comment: "Опечатка в РД" } }),
    chk({ id: "F-7", param_code: "M-007", org_code: "PZ-007", finding_status: "NOT_APPLICABLE" }),
  ],
  suspicions: [{ discovery_method: "INTERNAL_CONSISTENCY", description: "Класс указан по-разному", pd_reference: "ПБ стр. 7", rd_reference: null, inspector_status: "CLARIFICATION_REQUIRED", comment: null }],
};
const a = appendix2(input);

describe("протокол по образцу Приложения № 2 (OS-INSP-5.1.6)", () => {
  it("шапка: номер, объект, адрес, дело, застройщик, подрядчик, дата, версия, статус словами", () => {
    expect(a.title).toBe("Протокол автоматизированной сверки № P-1");
    expect(a.header).toEqual([
      ["Объект", "Алтуфьевское ш., 79Б"], ["Адрес", "г. Москва"], ["Номер надзорного дела", "77-123"], ["Застройщик", "ООО «Заказчик»"], ["Подрядчик", "—"],
      ["Дата формирования", "27 сентября 2026 г."], ["Версия протокола", "3 (предварительная)"], ["Статус", "Ожидает верификации (дозагрузка возможна)"],
    ]);
  });
  it("разделы — семь, в порядке образца, с числом записей в заголовке, как в образце", () => {
    expect(a.sections.map((s) => s.title)).toEqual([
      "Раздел 1. Статус загрузки документов",
      "Раздел 2. Сводная статистика",
      "Раздел 3. Параметры, не проверенные из-за отсутствия ИД — 1",
      "Раздел 4. Критические нарушения — 1",
      "Раздел 5. Существенные нарушения — 1",
      "Раздел 6. Подозрения ИИ — 1",
      "Раздел 7. Резолютивная часть",
    ]);
  });
  it("раздел 1: по стадиям — загружено из объявленных в реестре, статус и комментарий", () => {
    expect(a.sections[0].rows).toEqual([
      ["ПД", "Полностью", "2", "2", "Все файлы загружены"],
      ["РД", "Частично", "1", "2", "Отсутствует файлов: 1"],
      ["ИД", "Не загружено", "0", "1", "Отсутствует файлов: 1"],
    ]);
  });
  it("раздел 1: стадия, которую реестр не объявил и которой нет, — «Не требуется», а не красное «Не загружено»", () => {
    const b = appendix2({ ...input, declared: [{ doc_stage: "PD" }, { doc_stage: "PD" }, { doc_stage: "RD" }] });
    expect(b.sections[0].rows[2]).toEqual(["ИД", "Не требуется", "0", "0", "Не требуются по реестру"]);
  });
  it("раздел 2: проценты от числа параметров Матрицы в проверке, неприменимые не в счёт, запятая как в образце", () => {
    expect(a.sections[1].rows).toEqual([
      ["Всего параметров в проверке", "6", "100%"],
      ["Проверено (сравнение выполнено)", "4", "66,7%"],
      ["Не проверено: отсутствует ИД", "1", "16,7%"],
      ["Не проверено: нет документа ПД или РД", "1", "16,7%"],
      ["Выявлено нарушений (всего)", "2", "33,3%"],
      ["— критических (приостановка)", "1", "16,7%"],
      ["— существенных (предписание)", "1", "16,7%"],
      ["Подозрений ИИ (свободный поиск)", "1", "16,7%"],
    ]);
  });
  it("раздел 3: код организатора, раздел, параметр и какой документ ИД нужен по Матрице", () => {
    expect(a.sections[2].rows).toEqual([["1", "KR-059", "КР", "Толщина плит", "Исполнительная схема плит"]]);
  });
  it("разделы 4–5: нарушение — ПД, РД, ИД, отклонение и решение инспектора; снятое инспектором сюда не попадает", () => {
    expect(a.sections[3].rows).toEqual([["1", "КР", "Класс бетона (KR-055)", "B35", "B25", "—", "-10", "Подтверждено"]]);
    expect(a.sections[4].rows).toEqual([["1", "СПЗУ", "Ширина проездов (SPZU-030)", "6", "4,2", "—", "—", "Ожидает"]]);
  });
  it("раздел 6: метод словами, описание, ссылки, решение", () => {
    expect(a.sections[5].rows).toEqual([["1", "Внутреннее противоречие", "Класс указан по-разному", "ПБ стр. 7", "—", "—", "Уточнение", "—"]]);
  });
  it("раздел 7: по каждому нарушению — основание по Матрице и рекомендация инспектора, если он её дал", () => {
    expect(a.resolution).toEqual([
      { title: "7.1. По критическим нарушениям", rows: [["1", "Класс бетона (KR-055)", "Пересчёт несущей способности", "Понижение класса бетона"]] },
      { title: "7.2. По существенным нарушениям", rows: [["1", "Ширина проездов (SPZU-030)", "—", "Понижение класса бетона"]] },
    ]);
  });
  it("оговорка: риск — очерёдность, нарушение — только подтверждённое инспектором", () => {
    expect(a.note).toMatch(/только очерёдность/);
  });
});

describe("протокол по Приложению № 2: словари, колонки и граничные случаи (мутационная полнота)", () => {
  const one = (o: Partial<Appendix2Input>) => appendix2({ ...input, ...o });
  it("статус проверки словами — для каждого статуса; итоговая версия — у финализированного", () => {
    const st = (status: string) => one({ status }).header.find(([k]) => k === "Статус")![1];
    expect(["PENDING", "PARSING", "READY", "VERIFYING", "COMPLETED", "FINALIZED", "ODD"].map(st)).toEqual([
      "Ожидает загрузки", "Идёт разбор документов", "Ожидает верификации (дозагрузка возможна)", "Ожидает верификации (дозагрузка возможна)",
      "Верификация завершена", "Финализирован", "ODD",
    ]);
    expect(one({ status: "FINALIZED" }).header.find(([k]) => k === "Версия протокола")![1]).toBe("3 (итоговая)");
  });
  it("метод гипотезы и решение по ней — словами для каждого значения; без решения — «Ожидает», комментарий — как есть", () => {
    const methods = ["LOGICAL_ANALYSIS", "SEMANTIC_DISSONANCE", "NORMATIVE_ANALYSIS", "ML_PATTERN", "LLM_ADVISOR", "INTERNAL_CONSISTENCY", "X"];
    const rows = one({ suspicions: methods.map((m, i) => ({ discovery_method: m, description: "d", pd_reference: null, rd_reference: "АР стр. 2", inspector_status: [null, "CONFIRMED", "REJECTED", "PENDING", "CONFIRMED_VIOLATION", "NEGATIVE_VERIFIED", "ZZ"][i], comment: i === 1 ? "проверено" : null })) }).sections[5].rows;
    expect(rows.map((r) => r[1])).toEqual(["Логический анализ", "Семантический диссонанс", "Нормативный анализ", "ML-паттерн", "Советник ИИ", "Внутреннее противоречие", "X"]);
    expect(rows.map((r) => r[6])).toEqual(["Ожидает", "Подтверждено", "Отклонено", "Ожидает", "Подтверждено", "Отклонено", "Ожидает"]);
    expect(rows[1][7]).toBe("проверено");
    expect(rows[0].slice(3, 6)).toEqual(["—", "АР стр. 2", "—"]);
  });
  it("колонки и ширины разделов — как в образце", () => {
    expect(a.sections.map((s) => s.columns)).toEqual([
      ["Тип документа", "Статус", "Загружено файлов", "Ожидается", "Комментарий"],
      ["Показатель", "Количество", "% от общего"],
      ["№", "Код", "Раздел", "Параметр", "Нужный документ ИД (по Матрице)"],
      ["№", "Раздел", "Параметр (код)", "ПД", "РД", "ИД", "Отклонение", "Решение инспектора"],
      ["№", "Раздел", "Параметр (код)", "ПД", "РД", "ИД", "Отклонение", "Решение инспектора"],
      ["№", "Метод", "Описание", "ПД", "РД", "ИД", "Решение инспектора", "Комментарий"],
      [],
    ]);
    expect(a.sections.map((s) => s.widths)).toEqual([[16, 18, 16, 14, 36], [60, 20, 20], [5, 12, 10, 35, 38], [5, 8, 30, 12, 12, 12, 10, 11], [5, 8, 30, 12, 12, 12, 10, 11], [4, 10, 27, 25, 12, 5, 8, 9], []]);
    expect(a.sections[6].rows).toEqual([]);
    expect(a.resolution_columns).toEqual(["№", "Нарушение (код)", "Рекомендация инспектора", "Основание по Матрице"]);
    expect(a.note).toBe("Уровень риска определяет только очерёдность экспертной проверки и не является основанием для предписания. Нарушением признаётся только запись, подтверждённая инспектором; рекомендации раздела 7 формулирует инспектор.");
  });
  it("дата — по Москве; проценты при пустой проверке — прочерк; ноль из ненуля — 0,0%", () => {
    expect(one({ generated_at: "2026-09-27T22:30:00.000Z" }).header.find(([k]) => k === "Дата формирования")![1]).toBe("28 сентября 2026 г.");
    expect(one({ checks: [] }).sections[1].rows[0]).toEqual(["Всего параметров в проверке", "0", "—"]);
    expect(a.sections[1].rows.find((r) => r[0] === "Не проверено: отсутствует ИД")).toEqual(["Не проверено: отсутствует ИД", "1", "16,7%"]);
  });
  it("вне Матрицы (SUSP, REQ) — не параметры; значение null не считается; ИД в нарушении и основание без триггера", () => {
    const b = one({
      checks: [
        chk({ id: "S", param_code: "SUSP-1", finding_status: "CANDIDATE" }),
        chk({ id: "R", param_code: "REQ-F1", finding_status: "MISSING_EVIDENCE" }),
        chk({ id: "Z", param_code: "M-0555", finding_status: "CANDIDATE" }),
        chk({ id: "V", finding_status: "CANDIDATE", trigger_logic: null, org_code: null, fragments: [{ stage: "PD", value: null }, { stage: "PD", value: "B30" }, { stage: "ID", value: "B25" }] }),
        chk({ id: "M", param_code: "M-060", finding_status: "MISSING_EVIDENCE", fragments: [{ stage: "PD", value: "1" }, { stage: "RD", value: null }] }),
        chk({ id: "C", param_code: "M-061", finding_status: "MISSING_EVIDENCE", verification_status: "CONFIRMED_VIOLATION" }),
      ],
    });
    expect(b.sections[1].rows[0]).toEqual(["Всего параметров в проверке", "3", "100%"]);
    expect(b.sections[1].rows[1]).toEqual(["Проверено (сравнение выполнено)", "2", "66,7%"]);
    expect(b.sections[1].rows[3]).toEqual(["Не проверено: нет документа ПД или РД", "2", "66,7%"]);
    expect(b.sections[3].rows[0]).toEqual(["1", "КР", "Класс бетона (M-055)", "B30", "—", "B25", "—", "Ожидает"]);
    expect(b.resolution[0].rows[0]).toEqual(["1", "Класс бетона (M-055)", "—", "—"]);
  });
});
