// Синтетический (выдуманный) объект — OS-INSP-1.1.3, T-148. Метка живёт в существующих полях объекта, прописными:
// название «СИНТЕТИКА · …», адрес «ВЫМЫШЛЕННЫЙ АДРЕС · …», в профиле — synthetic: true. Синтетика не влияет на общие
// метрики: паспорт параметра (7.1.7), история ML-паттернов (3.2.11), эталонный набор дообучения (6.4.16) — только
// реальные объекты: синтетические листы распознаются почти идеально и завысили бы качество.

export const SYNTH_NAME_PREFIX = "СИНТЕТИКА · ";
export const SYNTH_ADDRESS_PREFIX = "ВЫМЫШЛЕННЫЙ АДРЕС · ";

export interface ObjectMarks {
  name: string | null | undefined;
  profile?: Record<string, unknown> | null;
}

/** Синтетический ли объект: признак профиля или метка названия (любой из двух — достаточно). */
export function isSyntheticObject(o: ObjectMarks): boolean {
  if (o.profile && o.profile.synthetic === true) return true;
  return (o.name ?? "").trimStart().toUpperCase().startsWith("СИНТЕТИКА");
}

/**
 * SQL-условие «объект реальный» для таблицы objects под алиасом: признак профиля и метка названия, те же, что в
 * isSyntheticObject. Алиас подставляется только из кода (не из запроса), поэтому без параметров.
 */
export function realObjectSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`realObjectSql: недопустимый алиас ${alias}`);
  return `(coalesce(${alias}.profile_json->>'synthetic', 'false') <> 'true' and upper(ltrim(${alias}.name)) not like 'СИНТЕТИКА%')`;
}
