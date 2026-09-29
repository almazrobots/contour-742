/**
 * T-233: том PDF по частям. Большой файл целиком разбирал один процесс ML часами, остальные простаивали; части
 * разбирают разные процессы параллельно, /analyze берёт собранный разбор из кэша ML. Диапазоны — полуоткрытые
 * [first, last) в индексах страниц с нуля, подряд и без наложений (так их проверяет ML при сборке).
 */
export type PageRange = [number, number];

/** Диапазоны по size страниц; документ не больше одной части — пусто (разбирается целиком, как раньше). */
export function partRanges(pages: number, size: number): PageRange[] {
  if (!Number.isInteger(pages) || !Number.isInteger(size) || size < 1 || pages <= size) return [];
  const out: PageRange[] = [];
  for (let first = 0; first < pages; first += size) out.push([first, Math.min(first + size, pages)]);
  return out;
}

/** Выполнить задачи не больше limit одновременно; первая ошибка — наружу после завершения уже начатых. */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure !== null) throw failure;
}
