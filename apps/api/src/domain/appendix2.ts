// T-121 (OS-INSP-5.1.6): модель протокола по образцу Приложения № 2 (SRC-INSP-08) — семь разделов в порядке образца.
// Чистая функция: API собирает модель, ML-сервис только рисует её в PDF и DOCX (оформление — дизайн-система интерфейса).
// Допущения (образец их не задаёт; закреплены тестом):
//  - «Всего параметров» — параметры Матрицы в проверке без неприменимых; проценты — от этого числа;
//  - «Не проверено: отсутствует ИД» — нет доказательства при значениях ПД и РД; иначе — «нет документа ПД или РД»;
//  - «Отсутствующий файл» раздела 3 — документ ИД, который Матрица называет источником (source_id): имени файла мы не знаем;
//  - раздел 7: рекомендацию формулирует инспектор (комментарий решения); система даёт основание по Матрице (trigger_logic).

export interface Appendix2Input {
  process_id: string;
  protocol_version: number;
  generated_at: string;
  status: string;
  object: { name: string; address: string | null; permit_number: string | null; customer: string | null; contractor: string | null };
  files: Array<{ doc_stage: string }>;
  /** Файлы реестра (manifest): сколько ожидается по стадиям; пусто — ожидается столько, сколько загружено. */
  declared: Array<{ doc_stage: string }>;
  checks: Array<{
    id: string;
    param_code: string;
    org_code: string | null;
    section: string;
    parameter_name: string;
    critical: boolean;
    trigger_logic: string | null;
    source_id: string | null;
    finding_status: string;
    verification_status: string;
    delta: string | null;
    fragments: Array<{ stage: string; value: string | null }>;
    decision: { action: string; comment: string | null } | null;
  }>;
  suspicions: Array<{ discovery_method: string; description: string; pd_reference: string | null; rd_reference: string | null; inspector_status: string | null; comment: string | null }>;
}

export interface Appendix2 {
  title: string;
  header: Array<[string, string]>;
  sections: Array<{ title: string; columns: string[]; rows: string[][]; widths: number[] }>;
  resolution: Array<{ title: string; rows: string[][] }>;
  resolution_columns: string[];
  note: string;
}

const STAGE_RU: Record<string, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
const METHOD_RU: Record<string, string> = {
  LOGICAL_ANALYSIS: "Логический анализ",
  SEMANTIC_DISSONANCE: "Семантический диссонанс",
  NORMATIVE_ANALYSIS: "Нормативный анализ",
  ML_PATTERN: "ML-паттерн",
  LLM_ADVISOR: "Советник ИИ",
  INTERNAL_CONSISTENCY: "Внутреннее противоречие",
};
const STATUS_RU: Record<string, string> = {
  PENDING: "Ожидает загрузки",
  PARSING: "Идёт разбор документов",
  READY: "Ожидает верификации (дозагрузка возможна)",
  VERIFYING: "Ожидает верификации (дозагрузка возможна)",
  COMPLETED: "Верификация завершена",
  FINALIZED: "Финализирован",
};
const DECISION_RU: Record<string, string> = {
  CONFIRMED_VIOLATION: "Подтверждено",
  PENDING: "Ожидает",
  CLARIFICATION_REQUIRED: "Уточнение",
  NEGATIVE_VERIFIED: "Отклонено",
  CONFIRMED: "Подтверждено",
  REJECTED: "Отклонено",
};
const DASH = "—";
const CHECKED = new Set(["CANDIDATE", "NEGATIVE_VERIFIED"]);

const pct = (n: number, of: number) => (of ? `${n === of ? "100" : ((n / of) * 100).toFixed(1).replace(".", ",")}%` : "—");
const moscowDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" });

export function appendix2(p: Appendix2Input): Appendix2 {
  const matrix = p.checks.filter((c) => /^M-\d{3}$/.test(c.param_code) && c.finding_status !== "NOT_APPLICABLE");
  const has = (c: (typeof matrix)[number], stage: string) => c.fragments.some((f) => f.stage === stage && f.value !== null);
  const idMissing = matrix.filter((c) => c.finding_status === "MISSING_EVIDENCE" && has(c, "PD") && has(c, "RD"));
  const docMissing = matrix.filter((c) => c.finding_status === "MISSING_EVIDENCE" && !(has(c, "PD") && has(c, "RD")));
  const checked = matrix.filter((c) => CHECKED.has(c.finding_status) || c.verification_status === "CONFIRMED_VIOLATION");
  // нарушение — кандидат системы или подтверждённое инспектором; снятое инспектором — не нарушение
  const violations = matrix.filter((c) => (c.finding_status === "CANDIDATE" || c.verification_status === "CONFIRMED_VIOLATION") && c.verification_status !== "NEGATIVE_VERIFIED");
  const critical = violations.filter((c) => c.critical);
  const substantial = violations.filter((c) => !c.critical);
  const n = matrix.length;
  const value = (c: (typeof matrix)[number], stage: string) => c.fragments.find((f) => f.stage === stage && f.value !== null)?.value ?? DASH;
  const named = (c: (typeof matrix)[number]) => `${c.parameter_name} (${c.org_code ?? c.param_code})`;
  const violationRows = (list: typeof matrix) =>
    list.map((c, i) => [String(i + 1), c.section, named(c), value(c, "PD"), value(c, "RD"), value(c, "ID"), c.delta ?? DASH, DECISION_RU[c.verification_status] ?? c.verification_status]);

  const stages = ["PD", "RD", "ID"].map((s) => {
    const loaded = p.files.filter((f) => f.doc_stage === s).length;
    const expected = Math.max(p.declared.length ? p.declared.filter((f) => f.doc_stage === s).length : loaded, loaded);
    const status = expected === 0 ? "Не требуется" : loaded === 0 ? "Не загружено" : loaded >= expected ? "Полностью" : "Частично";
    return [STAGE_RU[s], status, String(loaded), String(expected), loaded >= expected && loaded > 0 ? "Все файлы загружены" : expected === 0 ? "Не требуются по реестру" : `Отсутствует файлов: ${expected - loaded}`];
  });
  const violationCols = ["№", "Раздел", "Параметр (код)", "ПД", "РД", "ИД", "Отклонение", "Решение инспектора"];
  const violationW = [5, 8, 30, 12, 12, 12, 10, 11];
  const final = p.status === "FINALIZED";

  return {
    title: `Протокол автоматизированной сверки № ${p.process_id}`,
    header: [
      ["Объект", p.object.name],
      ["Адрес", p.object.address || DASH],
      ["Номер надзорного дела", p.object.permit_number || DASH],
      ["Застройщик", p.object.customer || DASH],
      ["Подрядчик", p.object.contractor || DASH],
      ["Дата формирования", moscowDate(p.generated_at)],
      ["Версия протокола", `${p.protocol_version} (${final ? "итоговая" : "предварительная"})`],
      ["Статус", STATUS_RU[p.status] ?? p.status],
    ],
    sections: [
      { title: "Раздел 1. Статус загрузки документов", columns: ["Тип документа", "Статус", "Загружено файлов", "Ожидается", "Комментарий"], widths: [16, 18, 16, 14, 36], rows: stages },
      {
        title: "Раздел 2. Сводная статистика",
        columns: ["Показатель", "Количество", "% от общего"],
        widths: [60, 20, 20],
        rows: [
          ["Всего параметров в проверке", String(n), pct(n, n)],
          ["Проверено (сравнение выполнено)", String(checked.length), pct(checked.length, n)],
          ["Не проверено: отсутствует ИД", String(idMissing.length), pct(idMissing.length, n)],
          ["Не проверено: нет документа ПД или РД", String(docMissing.length), pct(docMissing.length, n)],
          ["Выявлено нарушений (всего)", String(violations.length), pct(violations.length, n)],
          ["— критических (приостановка)", String(critical.length), pct(critical.length, n)],
          ["— существенных (предписание)", String(substantial.length), pct(substantial.length, n)],
          ["Подозрений ИИ (свободный поиск)", String(p.suspicions.length), pct(p.suspicions.length, n)],
        ],
      },
      {
        title: `Раздел 3. Параметры, не проверенные из-за отсутствия ИД — ${idMissing.length}`,
        columns: ["№", "Код", "Раздел", "Параметр", "Нужный документ ИД (по Матрице)"],
        widths: [5, 12, 10, 35, 38],
        rows: idMissing.map((c, i) => [String(i + 1), c.org_code ?? c.param_code, c.section, c.parameter_name, c.source_id || DASH]),
      },
      { title: `Раздел 4. Критические нарушения — ${critical.length}`, columns: violationCols, widths: violationW, rows: violationRows(critical) },
      { title: `Раздел 5. Существенные нарушения — ${substantial.length}`, columns: violationCols, widths: violationW, rows: violationRows(substantial) },
      {
        title: `Раздел 6. Подозрения ИИ — ${p.suspicions.length}`,
        columns: ["№", "Метод", "Описание", "ПД", "РД", "ИД", "Решение инспектора", "Комментарий"],
        widths: [4, 10, 27, 25, 12, 5, 8, 9],
        rows: p.suspicions.map((s, i) => [
          String(i + 1), METHOD_RU[s.discovery_method] ?? s.discovery_method, s.description, s.pd_reference || DASH, s.rd_reference || DASH, DASH,
          DECISION_RU[s.inspector_status ?? "PENDING"] ?? "Ожидает", s.comment || DASH,
        ]),
      },
      { title: "Раздел 7. Резолютивная часть", columns: [], widths: [], rows: [] },
    ],
    resolution_columns: ["№", "Нарушение (код)", "Рекомендация инспектора", "Основание по Матрице"],
    resolution: [
      { title: "7.1. По критическим нарушениям", rows: critical.map((c, i) => [String(i + 1), named(c), c.decision?.comment || DASH, c.trigger_logic || DASH]) },
      { title: "7.2. По существенным нарушениям", rows: substantial.map((c, i) => [String(i + 1), named(c), c.decision?.comment || DASH, c.trigger_logic || DASH]) },
    ],
    note:
      "Уровень риска определяет только очерёдность экспертной проверки и не является основанием для предписания. " +
      "Нарушением признаётся только запись, подтверждённая инспектором; рекомендации раздела 7 формулирует инспектор.",
  };
}
