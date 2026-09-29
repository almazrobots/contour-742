// L1 · L3 · L5 · L6 — OS-INSP-1.2.20…1.2.27: имена CP866, безопасность путей, пределы распаковки, стадия по папке,
// выведенный реестр, дубликаты и деление на части. Имена и хеши синтетические.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ArchiveRejected,
  DEFAULT_BATCH,
  MAX_RATIO,
  MAX_UNPACKED_BYTES,
  checkLimits,
  decodeCp866,
  decodeEntryName,
  dedupeBySha,
  deriveRegistry,
  isJunk,
  isRegistryFile,
  planBatches,
  safeEntryPath,
  stageFromPath,
  stripCommonRoot,
  uniqueNames,
} from "../src/domain/archive.ts";
import { Manifest, MAX_FILE_BYTES, MAX_PACKAGE_BYTES } from "../src/domain/upload.ts";

const MiB = 1024 * 1024;
const sha = (n: number) => n.toString(16).padStart(64, "0");

function rejected(fn: () => unknown): ArchiveRejected {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveRejected);
    return e as ArchiveRejected;
  }
  throw new Error("ожидался отказ архива");
}

describe("имена записей: CP866 и UTF-8 (L1, OS-INSP-1.2.21)", () => {
  it("опорные байты таблицы CP866", () => {
    expect(decodeCp866(Uint8Array.from([0x80]))).toBe("А");
    expect(decodeCp866(Uint8Array.from([0x9f]))).toBe("Я");
    expect(decodeCp866(Uint8Array.from([0xa0]))).toBe("а");
    expect(decodeCp866(Uint8Array.from([0xaf]))).toBe("п");
    expect(decodeCp866(Uint8Array.from([0xb0]))).toBe("░");
    expect(decodeCp866(Uint8Array.from([0xdf]))).toBe("▀");
    expect(decodeCp866(Uint8Array.from([0xe0]))).toBe("р");
    expect(decodeCp866(Uint8Array.from([0xef]))).toBe("я");
    expect(decodeCp866(Uint8Array.from([0xf0]))).toBe("Ё");
    expect(decodeCp866(Uint8Array.from([0xf1]))).toBe("ё");
    expect(decodeCp866(Uint8Array.from([0xfc]))).toBe("№");
    expect(decodeCp866(Uint8Array.from([0xff]))).toBe("\u00a0");
    expect(decodeCp866(Uint8Array.from([0x41, 0x2f, 0x7f]))).toBe("A/\x7f");
  });
  it("все 256 байт дают по одному символу", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...decodeCp866(all)]).toHaveLength(256);
  });
  it("флаг UTF-8 — UTF-8, без флага — CP866", () => {
    const cp = Buffer.from([0x8f, 0xe0, 0xae, 0xa5, 0xaa, 0xe2]); // «Проект»
    expect(decodeEntryName(cp, false)).toBe("Проект");
    expect(decodeEntryName(Buffer.from("Проект", "utf8"), true)).toBe("Проект");
    expect(decodeEntryName(Buffer.from("Проект", "utf8"), false)).not.toBe("Проект");
  });
});

describe("безопасность путей (L6, OS-INSP-1.2.22)", () => {
  it.each([
    ["../x", "выходит"],
    ["/etc/passwd", "абсолютный"],
    ["a/../../b", "выходит"],
    ["a/..", "выходит"],
    ["C:\\x", "диск"],
    ["c:x", "диск"],
    ["\\\\server\\share\\x", "абсолютный"],
    ["a\\..\\..\\b", "выходит"],
    ["ok/na\0me.pdf", "нулевой"],
  ])("%j — отказ архива целиком с путём", (p, why) => {
    const e = rejected(() => safeEntryPath(p));
    expect(e.code).toBe("TRAVERSAL");
    expect(e.path).toBe(p);
    expect(e.message).toContain(p);
    expect(e.message).toContain(why);
    expect(e.name).toBe("ArchiveRejected");
  });
  it("допустимые пути нормализуются", () => {
    expect(safeEntryPath("Архив\\ПД\\1.pdf")).toBe("Архив/ПД/1.pdf");
    expect(safeEntryPath("./a//b/./c.pdf")).toBe("a/b/c.pdf");
    expect(safeEntryPath("a..b/c..pdf")).toBe("a..b/c..pdf");
    expect(safeEntryPath("dir/")).toBe("dir");
    expect(safeEntryPath("Part A: x.pdf")).toBe("Part A: x.pdf");
  });
  it("служебный мусор архиваторов", () => {
    expect(isJunk("__MACOSX/a/._x.pdf")).toBe(true);
    expect(isJunk("a/.DS_Store")).toBe(true);
    expect(isJunk("Thumbs.db")).toBe(true);
    expect(isJunk("a/desktop.ini")).toBe(true);
    expect(isJunk("a/._x.pdf")).toBe(true);
    expect(isJunk("a/x.pdf")).toBe(false);
    expect(isJunk("MACOSX/x.pdf")).toBe(false);
    expect(isJunk("__MACOSX/x.pdf")).toBe(true);
  });
});

describe("пределы распаковки (L6 · L3, OS-INSP-1.2.23)", () => {
  it("сжатие ровно 100:1 — допустимо, 101:1 — бомба с пределом", () => {
    expect(() => checkLimits([{ name: "a.pdf", compressed: 10, size: 1000 }])).not.toThrow();
    const e = rejected(() => checkLimits([{ name: "ok.pdf", compressed: 5, size: 5 }, { name: "b.pdf", compressed: 10, size: 1010 }]));
    expect(e.code).toBe("BOMB");
    expect(e.limit).toBe("100:1");
    expect(e.path).toBe("b.pdf");
    expect(e.message).toContain("b.pdf");
    expect(e.message).toContain("100 к 1");
  });
  it("пустая запись не бомба; ненулевой размер при нулевом сжатом — бомба", () => {
    expect(() => checkLimits([{ name: "empty", compressed: 0, size: 0 }])).not.toThrow();
    expect(rejected(() => checkLimits([{ name: "z", compressed: 0, size: 1 }])).code).toBe("BOMB");
  });
  it("распакованный объём: ровно 2 ГБ — допустимо, на байт больше — отказ с пределом «2 ГБ»", () => {
    const half = MAX_UNPACKED_BYTES / 2;
    expect(MAX_UNPACKED_BYTES).toBe(2 * 1024 ** 3);
    expect(MAX_RATIO).toBe(100);
    expect(() => checkLimits([{ name: "a", compressed: half, size: half }, { name: "b", compressed: half, size: half }])).not.toThrow();
    const e = rejected(() => checkLimits([{ name: "a", compressed: half, size: half }, { name: "b", compressed: half + 1, size: half + 1 }]));
    expect(e.code).toBe("TOO_LARGE");
    expect(e.limit).toBe("2 ГБ");
    expect(e.message).toContain("больше 2 ГБ");
  });
  it("предел не кратный гигабайту называется в МБ; свои пределы применяются", () => {
    const e = rejected(() => checkLimits([{ name: "a", compressed: 3 * MiB, size: 3 * MiB }], { maxTotal: 2.5 * MiB, maxRatio: 100 }));
    expect(e.limit).toBe("2.5 МБ");
    expect(rejected(() => checkLimits([{ name: "a", compressed: 1, size: 3 }], { maxTotal: 100, maxRatio: 2 })).code).toBe("BOMB");
    expect(() => checkLimits([{ name: "a", compressed: 1, size: 2 }], { maxTotal: 2, maxRatio: 2 })).not.toThrow();
  });
});

describe("стадия по папке (L1, OS-INSP-1.2.24)", () => {
  it.each([
    ["Проектная документация/1. П-2099-01.001-ПЗ.pdf", "PD"],
    ["Рабочая документация/РД-2099-01-001-АР1.pdf", "RD"],
    ["Исполнительная документация/АОСР 1.pdf", "ID"],
    ["Архив/Проектная документация/Том 1/x.pdf", "PD"],
    ["01 Рабочая документация/x.pdf", "RD"],
    ["2. Проектная Документация/x.pdf", "PD"],
    ["ПД/x.pdf", "PD"],
    ["рд/x.pdf", "RD"],
    ["ИД/x.pdf", "ID"],
    ["Рабочая документация/Проектная документация/x.pdf", "PD"],
    ["Прочее/x.pdf", null],
    ["x.pdf", null],
    ["Проектная документация.pdf", null],
    ["ПДФ/x.pdf", null],
    ["Рабочие чертежи/x.pdf", null],
    [" ПД /x.pdf", "PD"],
    ["Проектная  документация/x.pdf", "PD"],
    ["Рабочая  документация/x.pdf", "RD"],
    ["Исполнительная  документация/x.pdf", "ID"],
    ["ПД1/x.pdf", null],
    ["Не проектная документация/x.pdf", null],
    ["Нерабочая документация/x.pdf", null],
    ["Неисполнительная документация/x.pdf", null],
  ])("%s → %s", (p, want) => {
    expect(stageFromPath(p)).toBe(want);
  });
  it("общая корневая папка архива снимается, но не если это сама стадия", () => {
    expect(stripCommonRoot(["Архив/ПД/a.pdf", "Архив/РД/b.pdf"])).toEqual(["ПД/a.pdf", "РД/b.pdf"]);
    expect(stripCommonRoot(["Рабочая документация/a.pdf", "Рабочая документация/b.pdf"])).toEqual(["Рабочая документация/a.pdf", "Рабочая документация/b.pdf"]);
    expect(stripCommonRoot(["A/a.pdf", "B/b.pdf"])).toEqual(["A/a.pdf", "B/b.pdf"]);
    expect(stripCommonRoot(["A/a.pdf", "b.pdf"])).toEqual(["A/a.pdf", "b.pdf"]);
    expect(stripCommonRoot(["A/a.pdf", "A"])).toEqual(["A/a.pdf", "A"]);
    expect(stripCommonRoot([])).toEqual([]);
  });
});

describe("дубликаты по SHA-256 (L1, OS-INSP-1.2.26)", () => {
  it("первый по порядку передаётся, остальные — со ссылкой на него", () => {
    const r = dedupeBySha([
      { path: "ПД/a.pdf", sha256: sha(1) },
      { path: "ПД/a 2024.pdf", sha256: sha(1) },
      { path: "РД/b.pdf", sha256: sha(2) },
      { path: "РД/a копия.pdf", sha256: sha(1) },
    ]);
    expect(r.unique.map((u) => u.path)).toEqual(["ПД/a.pdf", "РД/b.pdf"]);
    expect(r.duplicates).toEqual([
      { path: "ПД/a 2024.pdf", same_as: "ПД/a.pdf", sha256: sha(1) },
      { path: "РД/a копия.pdf", same_as: "ПД/a.pdf", sha256: sha(1) },
    ]);
  });
  it("L5: уникальные + дубликаты = вход, хеши уникальных попарно различны", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 30 }), (hs) => {
        const files = hs.map((h, i) => ({ path: `f${i}`, sha256: sha(h) }));
        const r = dedupeBySha(files);
        return r.unique.length + r.duplicates.length === files.length && new Set(r.unique.map((u) => u.sha256)).size === r.unique.length && r.unique.length === new Set(hs).size;
      }),
    );
  });
});

describe("выведенный реестр (L1, OS-INSP-1.2.24, 1.2.25)", () => {
  const files = [
    { path: "Пакет/Проектная документация/1. П-2099-01.001-ПЗ.pdf", sha256: sha(0xa1), size: 10 },
    { path: "Пакет/Рабочая документация/РД-2099-01-001-АР1.pdf", sha256: sha(0xb2), size: 20 },
    { path: "Пакет/Исполнительная документация/АОСР 1.pdf", sha256: sha(0xc3), size: 30 },
    { path: "Пакет/Прочее/Р-2099-01-001-ВК1.pdf", sha256: sha(0xd4), size: 40 },
    { path: "Пакет/Прочее/7. ТР снос Объект.pdf", sha256: sha(0xe5), size: 50 },
    { path: "Пакет/Рабочая документация/Том/1. П-2099-01.001-ПЗ.pdf", sha256: sha(0xf6), size: 60 },
    { path: "Пакет/Прочее/РД-2099-01-001-АР2.pdf", sha256: sha(0x17), size: 70 },
  ];

  it("стадия по папке, иначе по букве шифра, иначе ПД; поля из имени; реестр проходит схему Manifest", () => {
    const d = deriveRegistry(files, { object_id: "OBJ-1" });
    expect(Manifest.safeParse(d.manifest).success).toBe(true);
    const m = d.manifest.files;
    expect(m.map((f) => f.doc_stage)).toEqual(["PD", "RD", "ID", "RD", "PD", "RD", "RD"]);
    expect(d.notes.files.map((n) => n.stage_source)).toEqual(["folder", "folder", "folder", "name", "default", "folder", "name"]);
    expect(m[0]).toEqual({ file_id: `PD-${sha(0xa1).slice(0, 12)}`, file_name: "1. П-2099-01.001-ПЗ.pdf", sha256: sha(0xa1), doc_stage: "PD", discipline: "ПЗ", document_code: "П-2099-01.001-ПЗ", revision: "0" });
    expect(m[1]).toMatchObject({ file_id: `RD-${sha(0xb2).slice(0, 12)}`, discipline: "АР", document_code: "РД-2099-01-001-АР1" });
    expect(m[2]).toMatchObject({ discipline: "—", document_code: "АОСР 1" });
    expect(m[4]).toMatchObject({ discipline: "—", document_code: "7. ТР снос Объект" });
    expect(d.notes.files[0]).toMatchObject({ code_from_name: true, discipline_from_name: true, base: "2099-01-001", mark: "ПЗ" });
    expect(d.notes.files[2]).toMatchObject({ code_from_name: false, discipline_from_name: false, base: null, mark: null });
    expect(d.notes.registry_source).toBe("derived");
  });
  it("совпадающее имя в разных папках — передаётся с номером, переименование записано", () => {
    const d = deriveRegistry(files, { object_id: "OBJ-1" });
    expect(d.manifest.files[5].file_name).toBe("1. П-2099-01.001-ПЗ (2).pdf");
    expect(d.manifest.files[5].document_code).toBe("П-2099-01.001-ПЗ");
    expect(d.notes.renamed).toEqual([{ path: files[5].path, file_name: "1. П-2099-01.001-ПЗ (2).pdf" }]);
    expect(new Set(d.manifest.files.map((f) => f.file_name)).size).toBe(files.length);
  });
  it("утверждение — только по подтверждению оператора: ПД/ИД APPROVED, РД FOR_CONSTRUCTION; источник записан", () => {
    const none = deriveRegistry(files, { object_id: "OBJ-1" });
    expect(none.manifest.files.every((f) => f.approval_status === undefined)).toBe(true);
    expect(none.notes.approval_source).toBe("none");
    const op = deriveRegistry(files, { object_id: "OBJ-1", approval: true });
    expect(op.manifest.files.map((f) => f.approval_status)).toEqual(["APPROVED", "FOR_CONSTRUCTION", "APPROVED", "FOR_CONSTRUCTION", "APPROVED", "FOR_CONSTRUCTION", "FOR_CONSTRUCTION"]);
    expect(op.notes.approval_source).toBe("operator");
    expect(deriveRegistry(files, { object_id: "OBJ-1", approval: false }).notes.approval_source).toBe("none");
  });
  it("uniqueNames: без расширения и третий повтор", () => {
    expect(uniqueNames(["a/x", "b/x", "c/x.pdf", "d/x.pdf", "e/x.pdf"])).toEqual(["x", "x (2)", "x.pdf", "x (2).pdf", "x (3).pdf"]);
    expect(uniqueNames([".pdf", "a/.pdf"])).toEqual([".pdf", ".pdf (2)"]);
  });
  it("реестр в пакете узнаётся по имени", () => {
    expect(isRegistryFile("Пакет/manifest.json")).toBe(true);
    expect(isRegistryFile("Manifest-ПД.csv")).toBe(true);
    expect(isRegistryFile("Реестр файлов.csv")).toBe(true);
    expect(isRegistryFile("реестр.JSON")).toBe(true);
    expect(isRegistryFile("реестр.xlsx")).toBe(false);
    expect(isRegistryFile("мой manifest.json")).toBe(false);
    expect(isRegistryFile("manifest/x.pdf")).toBe(false);
    expect(isRegistryFile("manifest.json.pdf")).toBe(false);
  });
});

describe("деление на части (L3 · L5, OS-INSP-1.2.27)", () => {
  const f = (size: number, i = 0) => ({ id: i, size });
  it("пределы по умолчанию — из правил приёма", () => {
    expect(DEFAULT_BATCH).toEqual({ maxBytes: MAX_PACKAGE_BYTES, maxFiles: 200, maxFileBytes: MAX_FILE_BYTES });
  });
  it("ровно 200 МиБ — одна часть; 200 МиБ + 1 байт — две", () => {
    const four = [0, 1, 2, 3].map((i) => f(50 * MiB, i));
    expect(planBatches(four).batches.map((b) => b.files.length)).toEqual([4]);
    expect(planBatches(four).batches[0].bytes).toBe(200 * MiB);
    const plus = [...four, f(1, 4)];
    const p = planBatches(plus);
    expect(p.batches.map((b) => b.files.map((x) => x.id))).toEqual([[0, 1, 2, 3], [4]]);
    expect(p.batches[1].bytes).toBe(1);
  });
  it("200 файлов — одна часть; 201 — две", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => f(1, i));
    expect(planBatches(many(200)).batches.map((b) => b.files.length)).toEqual([200]);
    expect(planBatches(many(201)).batches.map((b) => b.files.length)).toEqual([200, 1]);
  });
  it("файл больше 50 МБ не делится и не передаётся — отражён в плане", () => {
    const p = planBatches([f(1, 0), f(50 * MiB + 1, 1), f(50 * MiB, 2)]);
    expect(p.oversize.map((x) => x.id)).toEqual([1]);
    expect(p.batches.map((b) => b.files.map((x) => x.id))).toEqual([[0, 2]]);
  });
  it("свои пределы: файл больше части тоже не передаётся", () => {
    const p = planBatches([f(5, 0), f(11, 1), f(6, 2)], { maxBytes: 10, maxFileBytes: 100 });
    expect(p.oversize.map((x) => x.id)).toEqual([1]);
    expect(p.batches.map((b) => b.files.map((x) => x.id))).toEqual([[0], [2]]);
    expect(planBatches([], {}).batches).toEqual([]);
  });
  it("L5: каждая часть в пределах, объединение частей = вход без крупных, порядок сохранён", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 120 }), { maxLength: 60 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 1, max: 100 }),
        (sizes, maxBytes, maxFiles, maxFileBytes) => {
          const files = sizes.map((s, i) => f(s, i));
          const p = planBatches(files, { maxBytes, maxFiles, maxFileBytes });
          const flat = p.batches.flatMap((b) => b.files);
          const expected = files.filter((x) => x.size <= maxFileBytes && x.size <= maxBytes);
          return (
            p.batches.every((b) => b.files.length > 0 && b.files.length <= maxFiles && b.bytes <= maxBytes && b.bytes === b.files.reduce((a, x) => a + x.size, 0)) &&
            flat.map((x) => x.id).join() === expected.map((x) => x.id).join() &&
            p.oversize.length + flat.length === files.length
          );
        },
      ),
    );
  });
});
