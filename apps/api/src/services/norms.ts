// OS-INSP-3.2.6 Поиск по нормативной базе и подбор нормы к гипотезе (T-035).
// Индекс и ранжирование — в ML (POST /norms/search: BM25 + необязательный реранк эмбеддингами).
// API передаёт туда активные записи normative_base, чтобы правки администратора сразу попадали в поиск.
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { normLabel } from "../domain/suspicions.ts";
import { log } from "./audit.ts";
import { HttpError } from "./inspections.ts";
import { MlError } from "./ml-client.ts";

export interface NormHit {
  id: string;
  document_number: string;
  document_name: string;
  section: string | null;
  summary: string;
  summary_is_paraphrase: boolean;
  source: string;
  score: number;
}

export interface NormSearchResult {
  query: string;
  method: string;
  results: NormHit[];
}

type Post = (path: string, body: unknown, timeoutMs: number) => Promise<any>;

const httpPost: Post = async (path, body, timeoutMs) => {
  let res: Response;
  try {
    res = await fetch(`${config.mlUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw new MlError(0, `ML недоступен: ${e?.cause?.code ?? e?.name ?? ""}`.trim());
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: unknown };
    throw new MlError(res.status, typeof j.detail === "string" ? j.detail : `ML ответил ${res.status}`);
  }
  return res.json();
};

let post: Post = httpPost;

/** POST в ML-модуль (JSON). Общий для советника и поиска по нормативам. */
export function mlPost<T = any>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  return post(path, body, timeoutMs);
}

/** Подмена транспорта для тестов. Без аргумента — вернуть HTTP. */
export function setMlPost(fn?: Post): void {
  post = fn ?? httpPost;
}

export async function searchNorms(db: DB, query: string, topK = 5): Promise<NormSearchResult> {
  const extra = await db.all("select id, document_name, document_number, section, parameter_name, param_code, min_value, max_value, is_active from normative_base where is_active order by id");
  try {
    return await mlPost<NormSearchResult>("/norms/search", { query, top_k: topK, extra });
  } catch (e) {
    if (e instanceof MlError) throw new HttpError(503, `Поиск по нормативам недоступен: ${e.message}`);
    throw e;
  }
}

export type NormSearch = (db: DB, query: string, topK: number) => Promise<NormSearchResult>;

/**
 * OS-INSP-3.2.6: к каждой гипотезе проверки без нормы подобрать лучшую норму поиском.
 * Заполненное поле normative_base не перезаписывается (норму задал движок правил или человек).
 * Возвращает число гипотез, которым норма назначена.
 */
export async function attachNorms(db: DB, inspectionId: string, search: NormSearch = searchNorms): Promise<number> {
  const rows = await db.all<{ id: number; description: string | null }>(
    "select id, description from suspicions where inspection_id = $1 and (normative_base is null or trim(normative_base) = '') order by id",
    [inspectionId],
  );
  let n = 0;
  for (const s of rows) {
    if (!s.description?.trim()) continue;
    const best = (await search(db, s.description, 1)).results[0];
    if (!best || !(best.score > 0)) continue;
    // повторная проверка «пусто» в самом update: пока шёл поиск, норму мог вписать кто-то ещё
    const r = await db.run("update suspicions set normative_base = $1 where id = $2 and (normative_base is null or trim(normative_base) = '')", [normLabel(best), s.id]);
    n += r.rowCount;
  }
  return n;
}

/** Фоновый вызов после пересчёта: ошибки ML не ломают протокол, только пишутся в журнал. */
export function attachNormsLater(db: DB, inspectionId: string): void {
  void attachNorms(db, inspectionId).catch((e) => log("WARNING", `подбор норм к гипотезам не выполнен: ${e?.message ?? e}`, { inspection_id: inspectionId }));
}
