// Краткое описание страниц файла для карточки проверки (T-135, TZA-11-10 p95 ≤ 200 мс). Карточка «Алтуфьево» весила
// 1,07 МБ, из них 983 КБ — полное описание 3 395 страниц (размеры, поворот, движки OCR, число строк), а интерфейсу
// нужны номер, источник текста, качество и уверенность распознавания (Inspection.tsx, DocCard.tsx). p95 карточки
// на стенде — 219 мс; полное описание страницы остаётся в базе и в ответе ML.
export interface PageBrief {
  page: number;
  source: string;
  quality: string;
  ocr_confidence: number | null;
}

/** Краткое описание собирает PostgreSQL (json_agg): разбор полного описания 1 700 страниц в Node на каждый запрос давал
 * p95 682 мс на 10 параллельных запросах — один поток Node занят JSON.parse. Колонка сохраняет имя pages_json. */
export const PAGES_BRIEF_SQL = `(select json_agg(json_build_object('page', p->'page', 'source', p->'source', 'quality', p->'quality', 'ocr_confidence', p->'ocr_confidence') order by ord)
  from json_array_elements(pages_json) with ordinality as t(p, ord))::text`;

export function pagesBrief(pagesJson: string | null | undefined): PageBrief[] | null {
  if (!pagesJson) return null;
  const pages = JSON.parse(pagesJson) as Array<Record<string, unknown>>;
  return pages.map((p) => ({
    page: Number(p.page),
    source: String(p.source ?? ""),
    quality: String(p.quality ?? "OK"),
    ocr_confidence: typeof p.ocr_confidence === "number" ? p.ocr_confidence : null,
  }));
}
