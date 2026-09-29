// L1 · L3 · L5 · L6 — OS-INSP-1.2.36…1.2.43 (T-169): серверный импорт большого файла — отказы с причиной, формат по
// содержимому, голова и хвост потока без чтения файла целиком, порции пакета и деление по пределу интерактивной загрузки.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HeadTail,
  IMPORT_HEAD_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_TAIL_BYTES,
  ImportRequest,
  importVerdict,
  preflight,
  sniffImport,
  atRestVerdict,
  ImportSlots,
} from "../src/domain/server-import.ts";
import { MAX_UNPACKED_BYTES, planPortions, splitForImport } from "../src/domain/archive.ts";
import { MAX_FILE_BYTES } from "../src/domain/upload.ts";

const MiB = 1024 * 1024;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const pdfHead = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
const pdfTail = Buffer.from("\nstartxref\n12345\n%%EOF\n");
const docxHead = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml")]);
const xlsxHead = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....xl/workbook.xml")]);
const probe = (o: Partial<{ size: number; sha256: string; head: Buffer; tail: Buffer }> = {}) => ({ size: 100 * MiB, sha256: SHA_A, head: pdfHead, tail: pdfTail, ...o });

describe("до чтения содержимого: объект есть и не больше предела (L1, OS-INSP-1.2.38)", () => {
  it("объекта нет — IMPORT_NOT_FOUND с хешем в сообщении", () => {
    const v = preflight("Том 5.pdf", SHA_A, null);
    expect(v).toEqual({ ok: false, code: "IMPORT_NOT_FOUND", message: `Том 5.pdf: файла с SHA-256 ${SHA_A} в хранилище нет — сначала положите его туда (загрузчик с --import-dir)` });
  });
  it("ровно на пределе — дальше; на байт больше — IMPORT_TOO_LARGE с пределом", () => {
    expect(preflight("a.pdf", SHA_A, IMPORT_MAX_FILE_BYTES)).toBeNull();
    const v = preflight("a.pdf", SHA_A, IMPORT_MAX_FILE_BYTES + 1);
    expect(v).toMatchObject({ ok: false, code: "IMPORT_TOO_LARGE" });
    expect(v && !v.ok && v.message).toContain("4 ГБ");
  });
  it("пустой файл не документ — CORRUPTED", () => {
    expect(preflight("a.pdf", SHA_A, 0)).toMatchObject({ ok: false, code: "CORRUPTED" });
    expect(preflight("a.pdf", SHA_A, 1)).toBeNull();
  });
  it("предел серверного импорта больше предела интерактивной загрузки и порции пакета", () => {
    expect(IMPORT_MAX_FILE_BYTES).toBe(4 * 1024 ** 3);
    expect(IMPORT_MAX_FILE_BYTES).toBeGreaterThan(MAX_UNPACKED_BYTES);
    expect(IMPORT_MAX_FILE_BYTES).toBeGreaterThan(MAX_FILE_BYTES);
  });
});

describe("вердикт по прочитанному потоку (L1, OS-INSP-1.2.37, 1.2.39)", () => {
  it("PDF с концом файла и совпавшим хешем — принят", () => {
    expect(importVerdict("ПЗ.pdf", SHA_A, probe())).toEqual({ ok: true, kind: "pdf" });
  });
  it("DOCX по содержимому — принят", () => {
    expect(importVerdict("ПБ.docx", SHA_A, probe({ head: docxHead, tail: Buffer.from("PK\x05\x06") }))).toEqual({ ok: true, kind: "docx" });
  });
  it("хеш не сошёлся — IMPORT_HASH_MISMATCH, названы оба хеша; проверка хеша раньше формата", () => {
    const v = importVerdict("ПЗ.pdf", SHA_B, probe({ head: Buffer.from("junk") }));
    expect(v).toEqual({ ok: false, code: "IMPORT_HASH_MISMATCH", message: `ПЗ.pdf: SHA-256 содержимого в хранилище ${SHA_A} не совпадает с заявленным ${SHA_B}` });
  });
  it("XLSX, изображение, XML, мусор — UNSUPPORTED_FORMAT с перечнем PDF, DOCX", () => {
    for (const head of [xlsxHead, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("<?xml version='1.0'?><a/>"), Buffer.from("hello")]) {
      const v = importVerdict("x.bin", SHA_A, probe({ head }));
      expect(v).toEqual({ ok: false, code: "UNSUPPORTED_FORMAT", message: "x.bin: серверным импортом принимаются только PDF, DOCX — формат определён по содержимому" });
    }
  });
  it("PDF без %%EOF в хвосте — CORRUPTED", () => {
    expect(importVerdict("a.pdf", SHA_A, probe({ tail: Buffer.from("obj\nendobj\n") }))).toMatchObject({ ok: false, code: "CORRUPTED" });
  });
  it("sniffImport: только pdf и docx, остальное — null", () => {
    expect(sniffImport(pdfHead)).toBe("pdf");
    expect(sniffImport(docxHead)).toBe("docx");
    expect(sniffImport(xlsxHead)).toBeNull();
    expect(sniffImport(Buffer.alloc(0))).toBeNull();
  });
});

describe("голова и хвост потока (L3 · L5, OS-INSP-1.2.40): файл целиком не держится", () => {
  it("голова — первые N байт, хвост — последние M, размер — сумма кусков", () => {
    const ht = new HeadTail(4, 3);
    for (const c of ["ab", "cdef", "g", "hij"]) ht.push(Buffer.from(c));
    expect(ht.head.toString()).toBe("abcd");
    expect(ht.tail.toString()).toBe("hij");
    expect(ht.size).toBe(10);
  });
  it("по умолчанию — 64 КиБ головы и 2 КиБ хвоста", () => {
    const ht = new HeadTail();
    ht.push(Buffer.alloc(200 * 1024, 1));
    expect(ht.head.length).toBe(IMPORT_HEAD_BYTES);
    expect(ht.tail.length).toBe(IMPORT_TAIL_BYTES);
    expect([IMPORT_HEAD_BYTES, IMPORT_TAIL_BYTES]).toEqual([64 * 1024, 2048]);
  });
  it("L5: при любом делении потока на куски голова, хвост и размер — как у склеенного целого", () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 40 }), { maxLength: 20 }), fc.nat(50), fc.nat(50), (chunks, h, t) => {
        const ht = new HeadTail(h, t);
        for (const c of chunks) ht.push(Buffer.from(c));
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        expect(ht.size).toBe(all.length);
        expect(ht.head.equals(all.subarray(0, h))).toBe(true);
        expect(ht.tail.equals(t === 0 ? Buffer.alloc(0) : all.subarray(Math.max(0, all.length - t)))).toBe(true);
      }),
    );
  });
});

describe("запрос серверного импорта (L6, OS-INSP-1.2.36)", () => {
  const file = { sha256: SHA_A, file_name: "Том 5.pdf" };
  it("дозагрузка в проверку или новая проверка по карточке объекта", () => {
    expect(ImportRequest.parse({ process_id: "P-1", files: [file] })).toMatchObject({ process_id: "P-1", start: false });
    expect(ImportRequest.parse({ object: { object_id: "O", name: "Объект" }, files: [file], start: true }).start).toBe(true);
  });
  it("ни проверки, ни карточки — отказ", () => {
    expect(ImportRequest.safeParse({ files: [file] }).success).toBe(false);
  });
  it("SHA-256 — ровно 64 строчных hex: путь, заглавные и короткий хеш не проходят", () => {
    for (const sha256 of ["../../etc/passwd", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}/x`]) {
      expect(ImportRequest.safeParse({ process_id: "P-1", files: [{ sha256, file_name: "a.pdf" }] }).success).toBe(false);
    }
  });
  it("файлов не больше предела запроса, хотя бы один", () => {
    const many = Array.from({ length: IMPORT_MAX_FILES + 1 }, (_, i) => ({ ...file, sha256: i.toString(16).padStart(64, "0") }));
    expect(ImportRequest.safeParse({ process_id: "P-1", files: many }).success).toBe(false);
    expect(ImportRequest.safeParse({ process_id: "P-1", files: many.slice(1) }).success).toBe(true);
    expect(ImportRequest.safeParse({ process_id: "P-1", files: [] }).success).toBe(false);
  });
});

describe("загрузчик: интерактивно или серверным импортом (L1, OS-INSP-1.2.36, 1.2.43)", () => {
  it("ровно 50 МБ — интерактивно, на байт больше — серверным импортом; порядок сохраняется", () => {
    const f = (n: string, size: number) => ({ n, size });
    const s = splitForImport([f("a", 1), f("b", MAX_FILE_BYTES + 1), f("c", MAX_FILE_BYTES), f("d", 956 * MiB)]);
    expect(s.interactive.map((x) => x.n)).toEqual(["a", "c"]);
    expect(s.large.map((x) => x.n)).toEqual(["b", "d"]);
  });
});

describe("порции пакета больше 2 ГБ (L1 · L5, OS-INSP-1.2.42)", () => {
  it("ровно 2 ГиБ — одна порция; на байт больше — две", () => {
    const half = MAX_UNPACKED_BYTES / 2;
    expect(planPortions([{ size: half }, { size: half }]).length).toBe(1);
    expect(planPortions([{ size: half }, { size: half + 1 }]).map((p) => p.bytes)).toEqual([half, half + 1]);
  });
  it("файл больше порции идёт отдельной порцией, а не отклоняется", () => {
    const p = planPortions([{ size: 1 }, { size: 5 }, { size: 1 }], 3);
    expect(p.map((x) => x.files.map((f) => f.size))).toEqual([[1], [5], [1]]);
  });
  it("пусто — порций нет", () => {
    expect(planPortions([])).toEqual([]);
  });
  it("L5: порции покрывают вход по порядку без потерь; каждая ≤ предела или из одного файла", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(100), { maxLength: 40 }), fc.integer({ min: 1, max: 150 }), (sizes, max) => {
        const files = sizes.map((size, i) => ({ i, size }));
        const ps = planPortions(files, max);
        expect(ps.flatMap((p) => p.files.map((f) => f.i))).toEqual(files.map((f) => f.i));
        for (const p of ps) {
          expect(p.bytes).toBe(p.files.reduce((s, f) => s + f.size, 0));
          expect(p.files.length).toBeGreaterThan(0);
          expect(p.bytes <= max || p.files.length === 1).toBe(true);
        }
      }),
    );
  });
});

describe("OWASP T-169: шифрование обязательно, слоты, повтор sha (L1 · L6)", () => {
  it("M-002: хранилище шифрует, а файл открытым текстом — IMPORT_NOT_ENCRYPTED; иначе дальше", () => {
    expect(atRestVerdict("том.pdf", true)).toMatchObject({ ok: false, code: "IMPORT_NOT_ENCRYPTED", message: expect.stringContaining("--import-key-file") });
    expect(atRestVerdict("том.pdf", false)).toBeNull();
  });
  it("M-003: один слот на пользователя, не больше max на процесс; освобождение возвращает слот", () => {
    const s = new ImportSlots(2);
    expect(s.tryAcquire("u1")).toBe(true);
    expect(s.tryAcquire("u1")).toBe(false);
    expect(s.tryAcquire("u2")).toBe(true);
    expect(s.tryAcquire("u3")).toBe(false);
    expect(s.inUse).toBe(2);
    s.release("u1");
    expect(s.tryAcquire("u3")).toBe(true);
    s.release("чужой"); // не занятый — счётчик не уходит в минус
    expect(s.inUse).toBe(2);
    expect(new ImportSlots().max).toBe(2);
  });
  it("M-003: один и тот же SHA-256 дважды в запросе — отказ схемы", () => {
    const f = { sha256: SHA_A, file_name: "a.pdf" };
    expect(ImportRequest.safeParse({ process_id: "P-1", files: [f, { ...f, file_name: "b.pdf" }] }).success).toBe(false);
    expect(ImportRequest.safeParse({ process_id: "P-1", files: [f, { sha256: SHA_B, file_name: "b.pdf" }] }).success).toBe(true);
  });
});
