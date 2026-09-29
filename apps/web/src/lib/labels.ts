// Человеческие названия статусов и их цвет. Коды — из ТЗ, на экране — словами инспектора (карта сценариев SMAP-03):
// система не пишет «нарушение» — нарушение признаёт инспектор; «не представлено», а не «нет доказательства».
export const FINDING: Record<string, { ru: string; tone: string }> = {
  CANDIDATE: { ru: "На оценку", tone: "amber" },
  NEGATIVE_VERIFIED: { ru: "Расхождения нет", tone: "green" },
  MISSING_EVIDENCE: { ru: "Не представлено", tone: "gray" },
  NOT_APPLICABLE: { ru: "Неприменимо", tone: "gray" },
  NOT_COMPARABLE: { ru: "Несопоставимо", tone: "blue" },
  CLARIFICATION_REQUIRED: { ru: "Нужно уточнение", tone: "blue" },
  CONFIRMED_VIOLATION: { ru: "Признано инспектором", tone: "red" },
  SUSPICION: { ru: "Наблюдение ИИ", tone: "violet" },
};

export const VERIFICATION: Record<string, { ru: string; tone: string }> = {
  PENDING: { ru: "Ждёт решения", tone: "amber" },
  CONFIRMED_VIOLATION: { ru: "Признано инспектором", tone: "red" },
  NEGATIVE_VERIFIED: { ru: "Снято: расхождения нет", tone: "green" },
  CLARIFICATION_REQUIRED: { ru: "Уточнение", tone: "blue" },
  SPLIT: { ru: "Разделён", tone: "gray" },
};

export const PROCESS: Record<string, { ru: string; tone: string }> = {
  PENDING: { ru: "Загружено", tone: "gray" },
  PARSING: { ru: "Разбор", tone: "blue" },
  READY: { ru: "Сводка сверки готова", tone: "violet" },
  VERIFYING: { ru: "Верификация", tone: "amber" },
  COMPLETED: { ru: "Верификация завершена", tone: "green" },
  FINALIZED: { ru: "Финализирован", tone: "gray" },
};

export const SYNC: Record<string, { ru: string; tone: string }> = {
  PENDING_SYNC: { ru: "Ждёт отправки в РиН", tone: "amber" },
  SYNCED: { ru: "Передано в РиН", tone: "green" },
  SYNC_FAILED: { ru: "РиН недоступна", tone: "red" },
};

export const COLOR_RU: Record<string, string> = { red: "Есть нарушения", yellow: "Требует внимания", green: "Без замечаний", gray: "Нет результатов" };

export const METHOD_RU: Record<string, string> = {
  LOGICAL_ANALYSIS: "Логический анализ",
  SEMANTIC_DISSONANCE: "Семантический диссонанс",
  NORMATIVE_ANALYSIS: "Нормативный анализ",
  ML_PATTERN: "ML-паттерн",
  LLM_ADVISOR: "Советник ИИ",
  INTERNAL_CONSISTENCY: "Внутреннее противоречие", // T-129: класс указан по-разному в разделах одной стадии (CMP-30)
};

export const STAGE_RU: Record<string, string> = { PD: "ПД", RD: "РД", ID: "ИД" };

export const ROLE_RU: Record<string, string> = { inspector: "Инспектор", supervisor: "Супервизор", admin: "Администратор", ml_engineer: "ML-инженер", curator: "Куратор данных", verifier:"Верификатор" };

export const REVISION_RU: Record<string, string> = { CURRENT: "эталон", SUPERSEDED: "заменена", CONFLICT: "конфликт редакций", UNRESOLVED: "не утверждена" };

// OS-INSP-2.3: реквизиты на листе — вид реквизита по-русски (подпись рамки на листе и строка в карточке документа)
export const REQUISITE_RU: Record<string, string> = {
  seal: "печать",
  signature: "подпись",
  stamp_production: "штамп «В производство работ»",
  stamp_asbuilt: "штамп исполнительной документации",
  date: "дата",
  reg_number: "рег. номер",
};

// OS-INSP-4.1.7: вид спорного случая (журнал Dispute_Log)
export const DISPUTE_RU: Record<string, string> = {
  CLARIFICATION: "Запрошено уточнение",
  ADVISOR_DISAGREEMENT: "Несогласие с советником ИИ",
};

export const pct = (x?: number | null) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
export const fmtDay = (s?: string | null) => (s ? s.slice(0, 10).split("-").reverse().join(".") : "—");

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// Поля верификации — словами инспектора, а не ключами отчёта оракула
export const VERIFY_FIELD_RU: Record<string, string> = {
  status: "Итог сравнения",
  PD: "Класс в ПД",
  RD: "Класс в РД",
  "PD.internal_conflict": "Противоречие внутри ПД",
  "PD.evidence": "Лист ПД (файл · страница)",
  "RD.evidence": "Лист РД (файл · страница)",
};
/** Значение поля верификации для экрана: статус — словами, указатель «sha@стр» — «sha · стр. N». */
export function verifyValue(field: string, v: string | null): string {
  if (v === null) return "—";
  if (field === "status") return FINDING[v]?.ru ?? v;
  const ref = /^([0-9a-f]{6,})@(\d+)$/.exec(v);
  return ref ? `${ref[1]} · стр. ${ref[2]}` : v;
}

// Раздел «Объекты» (T-166, OS-INSP-8.1.6, 8.1.7): итог ключевого параметра и ячейки стадий — словами инспектора.
// «Проверено» значит «решил инспектор»: пока решения нет, строка говорит, что она ждёт решения, каким бы ни был итог сверки.
export const STAGE_STATE_RU: Record<string, string> = {
  NO_VALUE: "значение не найдено",
  NOT_LOADED: "стадия не загружена",
  NOT_REQUIRED: "не требуется",
  NOT_CHECKED: "не проверялся",
};
const AWAITS = ", ждёт решения инспектора";
const PENDING_RU: Record<string, { ru: string; tone: string }> = {
  NEGATIVE_VERIFIED: { ru: `Расхождения нет${AWAITS}`, tone: "amber" },
  CANDIDATE: { ru: `Значения стадий расходятся${AWAITS}`, tone: "amber" },
  MISSING_EVIDENCE: { ru: `Сравнить не с чем: значение найдено меньше чем в двух стадиях${AWAITS}`, tone: "amber" },
  NOT_COMPARABLE: { ru: `Значения не сопоставить${AWAITS}`, tone: "amber" },
  CLARIFICATION_REQUIRED: { ru: `Неясно, какая редакция действует${AWAITS}`, tone: "amber" },
  NOT_APPLICABLE: { ru: "К объекту не применяется", tone: "gray" },
};
const DECIDED_RU: Record<string, { ru: string; tone: string }> = {
  CONFIRMED_VIOLATION: { ru: "Нарушение признано инспектором", tone: "red" },
  NEGATIVE_VERIFIED: { ru: "Инспектор подтвердил: расхождения нет", tone: "green" },
  CLARIFICATION_REQUIRED: { ru: "Инспектор запросил уточнение", tone: "blue" },
};
/** Итог ключевого параметра объекта: решение инспектора важнее итога сверки; нет проверки — «не проверялся». */
export function keyParamStatus(row: { checked: boolean; finding_status: string | null; verification_status: string | null }): { ru: string; tone: string } {
  if (!row.checked || !row.finding_status) return { ru: "Не проверялся", tone: "gray" };
  const decided = row.verification_status ? DECIDED_RU[row.verification_status] : undefined;
  if (decided) return decided;
  return PENDING_RU[row.finding_status] ?? { ru: `${FINDING[row.finding_status]?.ru ?? row.finding_status}${AWAITS}`, tone: "amber" };
}
export const AUTO_CHECK_RU: Record<string, string> = { MATCH: "независимый пересчёт совпал", MISMATCH: "независимый пересчёт не совпал" };

// ТЗ §10 Rejection_Log.retraining_status (T-234): судьба отклонения в дообучении
export const RETRAINING_RU: Record<string, { ru: string; tone: string }> = {
  PENDING: { ru: "Ждёт выпуска набора", tone: "amber" },
  INCLUDED: { ru: "В наборе", tone: "green" },
  SUPERSEDED: { ru: "Решение снято", tone: "gray" },
};

// ТЗ §10 Dispute_Log.resolution_status (T-234): исход спорного случая
export const RESOLUTION_RU: Record<string, { ru: string; tone: string }> = {
  OPEN: { ru: "Открыт", tone: "amber" },
  AI_UPHELD: { ru: "Права система", tone: "violet" },
  INSPECTOR_UPHELD: { ru: "Прав инспектор", tone: "green" },
  WITHDRAWN: { ru: "Снят", tone: "gray" },
};

// ТЗ §10 Model_Versions.approval_status (T-234: SUPERSEDED, ROLLED_BACK)
export const MODEL_STATUS_RU: Record<string, { ru: string; tone: string }> = {
  AWAITING_APPROVAL: { ru: "Ждёт подписи", tone: "amber" },
  REJECTED_BY_GATE: { ru: "Не прошла ворота", tone: "red" },
  PUBLISHED: { ru: "В контуре", tone: "green" },
  SUPERSEDED: { ru: "Заменена", tone: "gray" },
  ROLLED_BACK: { ru: "Снята откатом", tone: "red" },
};
