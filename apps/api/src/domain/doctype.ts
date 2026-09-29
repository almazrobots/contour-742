// OS-INSP-2.2.7 Вид документа внутри марки влияет на применимость (ТЗ §4): смета и опросный лист описывают
// стоимость и требования к закупке, а не проектное решение — проектные значения параметров из них не берутся.

export const NOT_DESIGN_SOURCE = ["estimate", "questionnaire"] as const;

/** Может ли документ этого вида быть источником значения параметра Матрицы. Вид не определён — может. */
export const isDesignSource = (docType: string | null | undefined): boolean => !NOT_DESIGN_SOURCE.includes((docType ?? "") as (typeof NOT_DESIGN_SOURCE)[number]);

/**
 * OS-INSP-2.2.54 (T-173): исключение из 2.2.7 по паспорту параметра — вид документа, который для этого параметра и есть
 * источник (М-132 «Итоговая стоимость по ССР» берётся из сметы). Прочим параметрам смета по-прежнему не источник.
 */
export const isSourceFor = (docType: string | null | undefined, allowed: readonly string[] = []): boolean => isDesignSource(docType) || allowed.includes(docType ?? "");
