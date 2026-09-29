// NFR-AV (ТЗ 12.11): антивирус до сохранения; «закрыто при сбое».
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseClamdReply, screen, screenVerdict } from "../src/domain/antivirus.ts";
import { clamdScan } from "../src/services/antivirus.ts";

describe("разбор ответа clamd", () => {
  it("OK, FOUND с сигнатурой, ERROR и мусор", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toMatchObject({ status: "error" });
    expect(parseClamdReply("")).toEqual({ status: "error", message: "пустой ответ сканера" });
    expect(parseClamdReply("stream: OKAY")).toMatchObject({ status: "error" }); // не «OK» — не чисто
  });
  it("реальные формы ответа: путь файла, лишние \\0 и пробелы, двойной пробел перед FOUND", () => {
    expect(parseClamdReply("/tmp/scan/a.pdf: Doc.Macro-1 FOUND\0")).toEqual({ status: "infected", signature: "Doc.Macro-1" });
    expect(parseClamdReply("stream: OK\0\0\n ")).toEqual({ status: "clean" });
    expect(parseClamdReply("stream: Sig.A  FOUND")).toEqual({ status: "infected", signature: "Sig.A" });
    expect(parseClamdReply("stream:Sig.B FOUND")).toEqual({ status: "infected", signature: "Sig.B" });
    expect(parseClamdReply("/tmp/a.pdf: OK")).toEqual({ status: "clean" });
    expect(parseClamdReply("stream:OK")).toEqual({ status: "clean" });
  });
  it("хвост после FOUND/OK или лишний «x:» в начале — не распознаётся как вердикт (закрыто при сбое)", () => {
    expect(parseClamdReply("stream: Sig FOUND trailing")).toMatchObject({ status: "error" });
    expect(parseClamdReply("x: y: OK")).toMatchObject({ status: "error" });
  });
});

describe("решение по файлу", () => {
  it("заражённый — INFECTED с сигнатурой; сбой проверки — SCAN_UNAVAILABLE, файл не принят", () => {
    expect(screenVerdict("a.pdf", { status: "clean" })).toEqual({ ok: true });
    expect(screenVerdict("a.pdf", { status: "infected", signature: "X" })).toMatchObject({ ok: false, code: "INFECTED" });
    expect((screenVerdict("a.pdf", { status: "infected", signature: "Sig.Z" }) as any).message).toBe("a.pdf: обнаружена угроза Sig.Z — файл не сохранён");
    expect(screenVerdict("a.pdf", { status: "error", message: "нет связи" })).toMatchObject({ ok: false, code: "SCAN_UNAVAILABLE" });
  });
  it("пакет делится на чистые и отклонённые; исключение сканера — отказ, а не пропуск", async () => {
    const items = ["ok.pdf", "bad.pdf", "boom.pdf"].map((name) => ({ name, buf: Buffer.from(name) }));
    const r = await screen(items, async (b) => {
      const s = b.toString();
      if (s === "boom.pdf") throw new Error("сокет закрыт");
      return s === "bad.pdf" ? { status: "infected", signature: "Test.Sig" } : { status: "clean" };
    });
    expect(r.clean.map((i) => i.name)).toEqual(["ok.pdf"]);
    expect(r.rejected.map((x) => [x.file_name, x.code])).toEqual([["bad.pdf", "INFECTED"], ["boom.pdf", "SCAN_UNAVAILABLE"]]);
    expect(r.rejected[1].message).toContain("сокет закрыт");
  });
});

describe("клиент clamd INSTREAM (поддельный clamd)", () => {
  const MARK = "harmless-infection-marker";
  let srv: Server;
  let port = 0;
  const received: Buffer[] = [];
  beforeAll(async () => {
    srv = createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on("data", (d: Buffer) => {
        acc = Buffer.concat([acc, d]);
        const head = "zINSTREAM\0";
        if (!acc.subarray(0, head.length).equals(Buffer.from(head))) return;
        // разбор кусков: <uint32 BE длина><данные>, нулевая длина — конец
        let off = head.length;
        const parts: Buffer[] = [];
        while (off + 4 <= acc.length) {
          const n = acc.readUInt32BE(off);
          if (n === 0) {
            const body = Buffer.concat(parts);
            received.push(body);
            sock.end(body.includes(MARK) ? "stream: Test.Marker FOUND\0" : "stream: OK\0");
            return;
          }
          if (off + 4 + n > acc.length) return;
          parts.push(acc.subarray(off + 4, off + 4 + n));
          off += 4 + n;
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    port = (srv.address() as any).port;
  });
  afterAll(() => srv.close());

  it("чистый файл — OK; файл с меткой — FOUND; поток кусками по 64 КБ собирается без потерь", async () => {
    const big = Buffer.alloc(200 * 1024, 7); // три куска
    expect(await clamdScan(big, "127.0.0.1", port)).toEqual({ status: "clean" });
    expect(received.at(-1)!.equals(big)).toBe(true);
    expect(await clamdScan(Buffer.from(`pdf ${MARK} pdf`), "127.0.0.1", port)).toEqual({ status: "infected", signature: "Test.Marker" });
  });
  it("clamd недоступен — ошибка, а не «чисто»", async () => {
    const r = await clamdScan(Buffer.from("x"), "127.0.0.1", 1);
    expect(r.status).toBe("error");
  });
  it("clamd молчит — тайм-аут, а не зависание", async () => {
    const mute = createServer(() => {});
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", () => r()));
    const r = await clamdScan(Buffer.from("x"), "127.0.0.1", (mute.address() as any).port, 300);
    mute.close();
    expect(r).toMatchObject({ status: "error" });
    expect((r as any).message).toMatch(/не ответил/);
  });
});
