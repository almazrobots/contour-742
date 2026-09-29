// OS-INSP-2.1.16 (ТЗ 9.1.1, TZA-9.1.1-06, T-138): доля нечитаемых зон и покрываемость распознанным текстом —
// по файлу и по проверке. Источник — сводка страниц ответа ML (files.pages_json): источник текста, качество
// (OK | LOW_QUALITY | ABSTAIN, OS-INSP-2.1.2), уверенность ансамбля, число строк, слов и сомнительных слов.
// Нечитаемые зоны: страницы LOW_QUALITY и ABSTAIN (страница целиком) и сомнительные слова OCR (зона — слово).
// Покрываемость — доля страниц, с которых получен текст (есть строки и страница не ABSTAIN).
// Итог по проверке — по страницам всех разобранных файлов (а не среднее долей файлов).

export type PageSummary = {
  page: number;
  source: string;
  quality: string;
  ocr_confidence: number | null;
  lines: number;
  words?: number;
  disputed_words?: number;
};

export type QualityStats = {
  pages: number;
  ocr_pages: number;
  low_quality: number;
  abstain: number;
  illegible_share: number | null;
  coverage: number | null;
  ocr_words: number;
  doubtful_words: number;
  doubtful_share: number | null;
  mean_ocr_confidence: number | null;
};

export type FileQuality = QualityStats & { file_id: string; file_name: string; parsed: boolean; illegible_pages: number[] };

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const share = (a: number, b: number) => (b ? r3(a / b) : null);

function pagesOf(json: string | null): PageSummary[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null; // битая сводка — файл считается неразобранным, отчёт не падает
  }
}

function stats(pages: PageSummary[]): QualityStats {
  const ocr = pages.filter((p) => p.source === "ocr");
  const low = pages.filter((p) => p.quality === "LOW_QUALITY").length;
  const abstain = pages.filter((p) => p.quality === "ABSTAIN").length;
  const covered = pages.filter((p) => p.quality !== "ABSTAIN" && p.lines > 0).length;
  // доля сомнительных слов известна, только если ML сообщил число слов у всех OCR-страниц (старые ответы — без него)
  const known = ocr.length > 0 && ocr.every((p) => typeof p.words === "number");
  const words = known ? ocr.reduce((a, p) => a + (p.words ?? 0), 0) : 0;
  const doubtful = ocr.reduce((a, p) => a + Math.min(p.disputed_words ?? 0, known ? (p.words ?? 0) : Infinity), 0);
  const conf = ocr.filter((p) => typeof p.ocr_confidence === "number").map((p) => p.ocr_confidence as number);
  return {
    pages: pages.length,
    ocr_pages: ocr.length,
    low_quality: low,
    abstain,
    illegible_share: share(low + abstain, pages.length),
    coverage: share(covered, pages.length),
    ocr_words: words,
    doubtful_words: known ? doubtful : 0,
    doubtful_share: known ? share(doubtful, words) : null,
    mean_ocr_confidence: conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 10) / 10 : null,
  };
}

export function ocrQuality(files: Array<{ file_id: string; file_name: string; pages_json: string | null }>): { files: FileQuality[]; total: QualityStats & { files: number; parsed_files: number } } {
  const all: PageSummary[] = [];
  let parsed = 0;
  const out = files.map((f) => {
    const pages = pagesOf(f.pages_json);
    if (!pages) return { file_id: f.file_id, file_name: f.file_name, parsed: false, illegible_pages: [], ...stats([]) };
    parsed++;
    all.push(...pages);
    const illegible = pages.filter((p) => p.quality === "LOW_QUALITY" || p.quality === "ABSTAIN").map((p) => p.page);
    return { file_id: f.file_id, file_name: f.file_name, parsed: true, illegible_pages: illegible, ...stats(pages) };
  });
  return { files: out, total: { files: files.length, parsed_files: parsed, ...stats(all) } };
}
