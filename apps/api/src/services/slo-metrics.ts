// NFR-PERF-RUNTIME (T-138): пределы §11 ТЗ в эксплуатации. Гистограммы процесса API отдаются в /metrics,
// алерты — deploy/gpu/alerts.yml (p95 за 15 минут выше предела). Предел каждой метрики — одна из границ корзин.
import { Histogram } from "../domain/histogram.ts";

/** Пределы §11, секунды. */
export const LIMITS = { mlParam: 0.5, cvSheet: 30, rinAttempt: 30, rinDelivery: 30 } as const;

export const slo = {
  // TZA-11-07: ML-анализ одного параметра (NLP) — время из ответа ML по каждому параметру документа
  mlParam: new Histogram("inspector_ml_param_seconds", "Время ML-анализа одного параметра в документе, с (ТЗ 11: не более 0,5 с)", [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]),
  // TZA-11-08: CV-анализ одного листа чертежа
  cvSheet: new Histogram("inspector_cv_sheet_seconds", "Время CV-анализа одного листа чертежа, с (ТЗ 11: не более 30 с)", [1, 5, 10, 20, 30, 60]),
  // TZA-11-06: одна попытка отправки в «РиН» (соединение, передача, ответ)
  rinAttempt: new Histogram("inspector_rin_attempt_seconds", "Длительность попытки отправки протокола в ИАИС «РиН», с (ТЗ 11: не более 30 с)", [0.5, 1, 5, 10, 30, 60]),
  // TZA-11-06: доставка — от постановки протокола в очередь до ответа «РиН», с повторами
  rinDelivery: new Histogram("inspector_rin_delivery_seconds", "Время доставки протокола в ИАИС «РиН» от постановки в очередь, с (ТЗ 11: не более 30 с)", [1, 5, 10, 30, 60, 300, 1200, 3600]),
};

export function sloLines(): string[] {
  return Object.values(slo).flatMap((h) => h.lines());
}
