// VER-09 (каталог TO-BE §12, T-194): закрытый вопрос локальной VLM по двум кропам — ожидаемое и фактическое.
// Канал — ML-модуль (тот же, что судья класса T-129/T-156: ml/inspector_ml/vlm.py, INSPECTOR_VLM_*), а не прямой вызов
// GPU; транспорт — services/ml-client.ts::vlmClaim (одна точка вызовов ML). Ответ — строгий JSON {claim_supported,
// quote}; всё остальное — громкий отказ (VlmClaimError), статус по такому ответу не меняется. Вердикт применяет
// domain/verify-geom.ts::applyVlm. Правила — OS-INSP-3.1.130–3.1.132.
// OWASP T-196: кропы — только из фрагментов кандидата и только документов проверки (0185); вопрос — закрытый шаблон
// из данных кандидата (0184); в ошибке нет текста ответа модели (0186); бюджет вызовов на проверку (0181).
import { applyVlm, type ClaimCrop, claimCrops, claimQuestion, type ClaimSpec, ClaimSpecError, type GeomEvaluation, noteVlm, type VlmVerdict, VlmVerdictSchema } from "../domain/verify-geom.ts";
import type { Evaluation } from "../domain/types.ts";
import { type MlVlmClaimRequest, setMlVlmClaimTransport, vlmClaim } from "./ml-client.ts";

export type VlmCrop = ClaimCrop;

export interface VlmClaimRequest {
  question: string; // закрытый вопрос из шаблона: «Есть ли в границах помещения 140 подписи В2.7, В2.8, В2.9?»
  crops: [VlmCrop, VlmCrop];
}

/** VER-09 не выполнен: ответ модели не по схеме, кропы не из проверки, вопрос не по шаблону. */
export class VlmClaimError extends Error {}

/** SEC-03 (OWASP LLM10): длинный вопрос — не закрытый вопрос, а подсказка модели. */
export const MAX_QUESTION = 300;
/** OWASP-0181: потолок вызовов VLM на одну проверку — как MAX_JUDGE_CALLS судьи класса в ML. */
export const MAX_VLM_CALLS = 30;

/** Счётчик вызовов VER-09 одной проверки: заводится на проверку и передаётся в каждый verifyClaim. */
export class VlmBudget {
  used = 0;
  constructor(readonly limit = MAX_VLM_CALLS) {}
  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}

export function checkRequest(req: VlmClaimRequest): void {
  if (!req.question.trim() || req.question.length > MAX_QUESTION || /[\p{Cc}\p{Cf}]/u.test(req.question)) throw new VlmClaimError(`VER-09: вопрос пуст, длиннее ${MAX_QUESTION} знаков или с управляющими знаками`);
  if (req.crops.length !== 2 || new Set(req.crops.map((c) => c.role)).size !== 2) throw new VlmClaimError("VER-09: нужны ровно два кропа — ожидаемое и фактическое");
  for (const c of req.crops) {
    const [x0, y0, x1, y1] = c.bbox;
    if (!(x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && x1 > x0 && y1 > y0)) throw new VlmClaimError(`VER-09: рамка кропа вне страницы: ${c.bbox.join(", ")}`);
  }
}

/** Разбор ответа модели: строго по схеме, иначе громкий отказ — с видом и длиной ответа, но без его текста (OWASP-0186). */
export function parseVerdict(raw: unknown): VlmVerdict {
  const r = VlmVerdictSchema.safeParse(raw);
  if (!r.success) {
    const kind = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new VlmClaimError(`VER-09: ответ VLM не по схеме {claim_supported: yes|no|unreadable, quote}: ${kind}, ${JSON.stringify(raw)?.length ?? 0} знаков`);
  }
  return r.data;
}

/** Подмена транспорта для тестов: живой прогон — только на GPU стенда. */
export function setVlmClaimTransport(fn: (req: VlmClaimRequest) => Promise<unknown>): void {
  setMlVlmClaimTransport(fn as (req: MlVlmClaimRequest) => Promise<unknown>);
}

export interface ClaimContext {
  inspection_shas: ReadonlySet<string>; // SHA-256 документов проверки, из которой строится кандидат
  budget: VlmBudget;
}

/**
 * VER-09 для кандидата: вопрос — по шаблону из данных кандидата, кропы — из его фрагментов и только документов этой
 * проверки; вердикт применяется только понижением. Не кандидат — модель не спрашивается. Бюджет исчерпан — шаг без
 * изменения статуса. Сбой ML — MlError, ответ не по схеме и чужие кропы — VlmClaimError.
 */
export async function verifyClaim<E extends Evaluation>(ev: E, claim: ClaimSpec, ctx: ClaimContext): Promise<E | GeomEvaluation<E>> {
  if (ev.status !== "CANDIDATE") return ev;
  const crops = claimCrops(ev);
  if (!crops) throw new VlmClaimError("VER-09: у кандидата нет ожидаемого и фактического фрагментов с рамкой — кропы строить не из чего");
  const foreign = crops.filter((c) => !ctx.inspection_shas.has(c.sha256));
  if (foreign.length) throw new VlmClaimError(`VER-09: кроп не из документов проверки (${foreign.map((c) => c.role).join(", ")})`);
  let question: string;
  try {
    question = claimQuestion(claim);
  } catch (e) {
    if (e instanceof ClaimSpecError) throw new VlmClaimError(e.message);
    throw e;
  }
  if (!ctx.budget.take()) return noteVlm(ev, `Бюджет VER-09 исчерпан (${ctx.budget.limit} вызовов на проверку) — VLM не спрашивалась, статус без изменений`);
  const req: VlmClaimRequest = { question, crops };
  checkRequest(req);
  return applyVlm(ev, parseVerdict(await vlmClaim(req)));
}
