// Демо-стенд «Надзориум» (T-131): сведения о публикации лежат рядом со статикой — /docs/publication.json. Есть файл —
// это демо-стенд только для просмотра; нет (разработка, стенд на маке) — обычный режим. nginx на неизвестный путь
// отдаёт index.html, поэтому признак — только разобранный JSON с полем published_at.
export type Publication = {
  published_at: string;
  source: string;
  revision: string;
  inspections: number;
  files: number;
  dump_sha256: string;
};

let cache: Promise<Publication | null> | null = null;

export function publication(): Promise<Publication | null> {
  cache ??= fetch("/docs/publication.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && typeof j.published_at === "string" ? (j as Publication) : null))
    .catch(() => null);
  return cache;
}

/** Строка о происхождении данных для плашки: где посчитано, какая ревизия, когда опубликовано. */
export function provenanceLine(p: Publication): string {
  const when = new Date(p.published_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
  return `Результаты посчитаны на ${p.source}, ревизия ${p.revision.slice(0, 7)} · опубликованы ${when} МСК · проверок ${p.inspections}, файлов ${p.files}`;
}
