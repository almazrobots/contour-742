// OS-INSP-3.2.8–3.2.10: история для модели паттернов — значения параметров других объектов из базы.
import type { DB } from "../db.ts";
import { isDesignSource } from "../domain/doctype.ts";
import { AREA_CODE, detectAnomalies, fitPatternModel, patternParams, type HistoryObject, type PatternModel, type PatternParam } from "../domain/patterns.ts";
import type { Fact, Suspicion } from "../domain/suspicions.ts";
import { realObjectSql } from "../domain/synthetic.ts";

/** Параметры Матрицы для модели паттернов (активные, числовые, с классифицированной единицей). */
export async function loadPatternParams(db: DB): Promise<Map<string, PatternParam>> {
  return patternParams(await db.all<{ code: string; parameter_name: string; unit: string; data_type: string }>("select code, parameter_name, unit, data_type from params where is_active order by id"));
}

/**
 * Обучающая история: разобранные значения других объектов (object_id ≠ текущему) из актуальных редакций —
 * заменённые (SUPERSEDED) не участвуют, как и документы, не являющиеся источником проектного значения (OS-INSP-2.2.7).
 * Все проверки объекта сводятся в одну точку истории — в домене, медианой.
 */
export async function patternHistory(db: DB, objectId: string, codes: Iterable<string>): Promise<HistoryObject[]> {
  // список кодов — JSON-текстом: слой db.ts сериализует массивы в JSON, а не в литерал массива PostgreSQL
  const rows = await db.all<{ object_id: string; param_code: string; value_num: number; doc_type: string | null }>(
    // OS-INSP-3.2.11 (T-148): история — только реальные объекты
    `select f.object_id, e.param_code, e.value_num, f.doc_type from extractions e join files f on f.id = e.file_id join objects o on o.id = f.object_id
      where f.object_id != $1 and ${realObjectSql("o")} and f.parse_status = 'DONE' and f.revision_role is distinct from 'SUPERSEDED' and e.kind = 'param' and e.value_num is not null
        and e.param_code = any(array(select json_array_elements_text($2::json)))
      order by f.object_id, e.id`,
    [objectId, JSON.stringify([...codes])],
  );
  const by = new Map<string, HistoryObject>();
  for (const r of rows) {
    if (!isDesignSource(r.doc_type)) continue;
    const h = by.get(r.object_id) ?? { object_id: r.object_id, facts: [] };
    h.facts.push({ key: r.param_code, num: r.value_num });
    by.set(r.object_id, h);
  }
  return [...by.values()];
}

/** Модель паттернов для проверки объекта: обучается на истории без него самого. */
export async function patternModel(db: DB, objectId: string, params?: Map<string, PatternParam>): Promise<PatternModel> {
  const p = params ?? (await loadPatternParams(db));
  return fitPatternModel(await patternHistory(db, objectId, [AREA_CODE, ...p.keys()]), p, objectId);
}

/** OS-INSP-3.2.9: гипотезы ML_PATTERN по фактам текущей проверки. */
export async function patternSuspicions(db: DB, objectId: string, facts: Fact[]): Promise<Suspicion[]> {
  const params = await loadPatternParams(db);
  return detectAnomalies(await patternModel(db, objectId, params), facts, params);
}
