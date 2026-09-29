// NFR-AV (ТЗ 12.11): все загружаемые файлы проходят антивирусную проверку до сохранения.
// Правило отказа — «закрыто при сбое»: если проверить не удалось, файл не принимается.

export type ScanResult = { status: "clean" } | { status: "infected"; signature: string } | { status: "error"; message: string };

/** Ответ clamd на INSTREAM: «stream: OK», «stream: <сигнатура> FOUND», «… ERROR». Завершающий \0 и пробелы не значимы. */
export function parseClamdReply(reply: string): ScanResult {
  const s = reply.replace(/[\0\s]+$/, "").trim(); // хвост из \0 и пробелов в любом порядке
  const found = /^(?:stream|[^:]*):\s*(.+?)\s+FOUND$/.exec(s);
  if (found) return { status: "infected", signature: found[1] };
  if (/^(?:stream|[^:]*):\s*OK$/.test(s)) return { status: "clean" };
  return { status: "error", message: s || "пустой ответ сканера" };
}

export type ScreenVerdict = { ok: true } | { ok: false; code: "INFECTED" | "SCAN_UNAVAILABLE"; message: string };

export function screenVerdict(name: string, r: ScanResult): ScreenVerdict {
  if (r.status === "clean") return { ok: true };
  if (r.status === "infected") return { ok: false, code: "INFECTED", message: `${name}: обнаружена угроза ${r.signature} — файл не сохранён` };
  return { ok: false, code: "SCAN_UNAVAILABLE", message: `${name}: антивирусная проверка не выполнена (${r.message}) — файл не принят, повторите загрузку позже` };
}

/** Разделить пакет на прошедшие проверку файлы и отклонённые. Порядок файлов сохраняется. */
export async function screen<T extends { name: string; buf: Buffer }>(items: T[], scan: (buf: Buffer) => Promise<ScanResult>) {
  const clean: T[] = [];
  const rejected: Array<{ file_name: string; code: "INFECTED" | "SCAN_UNAVAILABLE"; message: string }> = [];
  for (const it of items) {
    let r: ScanResult;
    try {
      r = await scan(it.buf);
    } catch (e) {
      r = { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
    const v = screenVerdict(it.name, r);
    if (v.ok) clean.push(it);
    else rejected.push({ file_name: it.name, code: v.code, message: v.message });
  }
  return { clean, rejected };
}
