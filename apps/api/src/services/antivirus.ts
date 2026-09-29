// NFR-AV: клиент clamd по протоколу INSTREAM (zINSTREAM\0, куски <длина uint32 BE><данные>, нулевая длина — конец).
import { connect } from "node:net";
import { config } from "../config.ts";
import { parseClamdReply, screen, screenVerdict, type ScanResult, type ScreenVerdict } from "../domain/antivirus.ts";
import { audit } from "./audit.ts";
import type { Ctx } from "./inspections.ts";

const CHUNK = 64 * 1024;

export function clamdScan(buf: Buffer, host: string, port: number, timeoutMs = 30_000): Promise<ScanResult> {
  return clamdScanStream([buf], host, port, timeoutMs);
}

/**
 * INSTREAM потоком (T-169, OS-INSP-1.2.36): файл больше памяти уходит кусками, запись ждёт освобождения буфера сокета.
 * Тайм-аут — простоя сокета, а не всего сканирования. Сбой чтения источника — «error» (закрыто при сбое), не исключение.
 */
export function clamdScanStream(src: Iterable<Buffer> | AsyncIterable<Buffer>, host: string, port: number, timeoutMs = 30_000): Promise<ScanResult> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (r: ScanResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    // после ответа или обрыва drain уже не придёт — ждём и close, иначе чтение источника повисло бы (OWASP L-006)
    const write = (b: Buffer) => (done || sock.write(b) ? Promise.resolve() : new Promise<void>((r) => { sock.once("drain", () => r()); sock.once("close", () => r()); }));
    sock.setTimeout(timeoutMs, () => finish({ status: "error", message: `clamd не ответил за ${timeoutMs} мс` }));
    sock.on("error", (e) => finish({ status: "error", message: `clamd недоступен: ${e.message}` }));
    sock.on("data", (d: Buffer) => {
      chunks.push(d);
      if (d.includes(0)) finish(parseClamdReply(Buffer.concat(chunks).toString("utf8")));
    });
    sock.on("end", () => finish(parseClamdReply(Buffer.concat(chunks).toString("utf8"))));
    sock.on("connect", () => {
      void (async () => {
        await write(Buffer.from("zINSTREAM\0"));
        for await (const buf of src) {
          if (done) return; // clamd уже ответил (например, превышен его предел потока) — дальше не читаем
          for (let off = 0; off < buf.length; off += CHUNK) {
            if (done) return;
            const part = buf.subarray(off, off + CHUNK);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(part.length);
            await write(len);
            await write(part);
          }
        }
        await write(Buffer.alloc(4)); // конец потока
      // наружу — без пути и текста системной ошибки (OWASP L-008); «закрыто при сбое»: файл не принят
      })().catch(() => finish({ status: "error", message: "файл не прочитан для проверки или изменился во время неё" }));
    });
  });
}

/**
 * Шаг приёма NFR-AV — общий для ручной загрузки и автозабора из «РиН» (OS-INSP-1.2.15): до сохранения,
 * заражённое и непроверенное отсекается, каждый отказ — в аудит. INSPECTOR_AV=off — пропуск (только dev).
 */
export async function screenIntake<T extends { name: string; buf: Buffer }>(ctx: Ctx, objectId: string | null, items: T[]) {
  if (config.avMode !== "clamd") return { clean: items, rejected: [] as Awaited<ReturnType<typeof screen<T>>>["rejected"] };
  const scr = await screen(items, (b) => clamdScan(b, config.clamdHost, config.clamdPort));
  for (const r of scr.rejected) await audit(ctx, r.code === "INFECTED" ? "FILE_INFECTED" : "FILE_SCAN_FAILED", objectId, r); // каждый отказ — в журнал до ответа
  return scr;
}

/**
 * NFR-AV для серверного импорта (T-169, OS-INSP-1.2.36): тот же шаг и то же правило «закрыто при сбое», файл — потоком.
 * INSPECTOR_AV=off — пропуск (только dev). Отказ — в аудит до ответа.
 */
export async function screenStream(ctx: Ctx, objectId: string | null, name: string, chunks: () => AsyncIterable<Buffer>): Promise<ScreenVerdict> {
  if (config.avMode !== "clamd") return { ok: true };
  let r: ScanResult;
  try {
    r = await clamdScanStream(chunks(), config.clamdHost, config.clamdPort);
  } catch (e) {
    r = { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const v = screenVerdict(name, r);
  if (!v.ok) await audit(ctx, v.code === "INFECTED" ? "FILE_INFECTED" : "FILE_SCAN_FAILED", objectId, { file_name: name, code: v.code, message: v.message });
  return v;
}
