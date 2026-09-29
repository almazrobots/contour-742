// Слова для следа упоминания параметра-класса в карточке инспектора (OS-INSP-2.2.20, 4.1.18, T-130): без кодов и жаргона.
export interface Judge {
  outcome: string;
  value: string | null;
  subject: string | null;
  note: string;
}

export const SOURCE: Record<string, string> = {
  "pdf-text": "текстовый слой PDF",
  "scan-ocr": "скан, распознано Tesseract",
  "scan-reader": "скан, найдено моделью-читателем",
  structured: "структурированный файл",
};

export const OUTCOME: Record<string, string> = {
  agree: "Tesseract и модель прочитали одинаково",
  "majority-reader": "два прочтения из трёх — за модель, значение исправлено",
  "majority-ensemble": "два прочтения из трёх — за Tesseract",
  "no-majority": "прочтения разошлись, уверенность снижена",
  "ensemble-only": "модель-читатель этого места не нашла",
  "reader-only": "нашла только модель-читатель",
  "reader-only-confirmed": "нашла модель-читатель, подтвердило второе прочтение",
  "reader-only-unconfirmed": "нашла только модель-читатель — второе прочтение не подтвердило",
};

const SUBJECT: Record<string, string> = { object: "проверяемому зданию", neighbor: "соседнему зданию", norm: "нормативному условию", unclear: "не разобрано" };

/** Вердикт проверки фрагмента листа моделью словами инспектора. */
export function judgeText(j: Judge): string {
  switch (j.outcome) {
    case "confirmed":
      return `подтверждено: ${j.value ?? "класс"} относится к ${SUBJECT.object}`;
    case "conflict":
      return `модель прочитала ${j.value ?? "другой класс"} — уверенность снижена, решает инспектор`;
    case "unreadable":
      return "модель не разобрала фрагмент";
    case "excluded":
      return `относится к ${SUBJECT[j.subject ?? "unclear"] ?? "другому"} — значением не берётся`;
    case "error":
      return "модель не ответила — упоминание оставлено как есть";
    default:
      return "не проверялось";
  }
}


/** Подпись модели в прочтении: «mlx-community/PaddleOCR-VL-1.5-bf16» → «PaddleOCR-VL-1.5». */
export function modelLabel(by: string): string {
  return (by.split("/").pop() ?? by).replace(/(-MLX)?(-\d+bit|-bf16|-fp16)$/i, "");
}

const USE_ORDER: Record<string, number> = { chosen: 0, considered: 1, flagged: 2, reference: 3, dropped: 4 };
/** Порядок упоминаний в карточке: значение стадии, учтённые, под сомнением, справочные, отсеянные; внутри — страница. */
export function byUse<T extends { use: string; page: number }>(ms: T[]): T[] {
  return [...ms].sort((a, b) => (USE_ORDER[a.use] ?? 9) - (USE_ORDER[b.use] ?? 9) || a.page - b.page);
}
