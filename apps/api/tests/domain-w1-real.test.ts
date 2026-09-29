// T-180, OS-INSP-6.5.50: чистая часть стенда W1 на реальных объектах — схема входа, отбор файлов, порции, окружение.
// Только синтетика: ни одного пути или хеша корпуса.
import { describe, expect, it } from "vitest";
import { importable, OBJECT_CODE, portions, realBenchEnv, realRow, W1RealSpec } from "../src/domain/w1-real.ts";

const sha = (c: string) => c.repeat(64);
const spec = (over: Record<string, unknown> = {}) => ({
  schema: "inspector-w1-real-spec/1",
  object_id: "SYN-1",
  approval: false,
  codes: ["M-023"],
  files: [{ path: "Объект/ПД/ПЗ.pdf", sha256: sha("a"), size: 10 }],
  ...over,
});

describe("W1RealSpec", () => {
  it("принимает код объекта, коды параметров и файлы по хешу", () => {
    expect(W1RealSpec.parse(spec()).object_id).toBe("SYN-1");
  });
  it("код объекта — только код: адрес или имя отбиваются", () => {
    for (const bad of ["Алтуфьевское 79Б", "alt-79b", "A", "ALT-79B/../x"]) expect(() => W1RealSpec.parse(spec({ object_id: bad }))).toThrow();
    for (const ok of ["POL-17", "LOS-3A", "ALT-79B", "RCH-7-7", "UNDMS"]) expect(OBJECT_CODE.test(ok)).toBe(true);
  });
  it("код параметра — M-NNN, хеш — 64 hex, статус утверждения задаётся явно", () => {
    expect(() => W1RealSpec.parse(spec({ codes: ["PZ-023"] }))).toThrow();
    expect(() => W1RealSpec.parse(spec({ files: [{ path: "a.pdf", sha256: "zz", size: 1 }] }))).toThrow();
    const { approval: _a, ...noApproval } = spec();
    expect(() => W1RealSpec.parse(noApproval)).toThrow();
  });
  it("чужая схема не принимается", () => {
    expect(() => W1RealSpec.parse(spec({ schema: "inspector-mutations/1" }))).toThrow();
  });
});

describe("importable", () => {
  it("мусор архива и повтор хеша не уходят в импорт, первый путь хеша — главный", () => {
    const r = importable([
      { path: "О/ПД/a.pdf", sha256: sha("a"), size: 1 },
      { path: "О/__MACOSX/._a.pdf", sha256: sha("b"), size: 1 },
      { path: "О/РД/копия a.pdf", sha256: sha("a"), size: 1 },
      { path: "О/РД/Thumbs.db", sha256: sha("c"), size: 1 },
      { path: "О/РД/b.pdf", sha256: sha("d"), size: 1 },
    ]);
    expect(r.take.map((f) => f.path)).toEqual(["О/ПД/a.pdf", "О/РД/b.pdf"]);
    expect(r.junk).toBe(2);
    expect(r.duplicates).toBe(1);
  });
});

describe("portions", () => {
  it("режет по пределу серверного импорта и не теряет файлов", () => {
    const xs = Array.from({ length: 123 }, (_, i) => i);
    const p = portions(xs, 50);
    expect(p.map((x) => x.length)).toEqual([50, 50, 23]);
    expect(p.flat()).toEqual(xs);
    expect(portions([], 50)).toEqual([]);
    expect(portions([1, 2, 3])).toEqual([[1, 2, 3]]);
  });
  it("порция меньше 1 — ошибка, а не бесконечный цикл", () => {
    expect(() => portions([1], 0)).toThrow("размер порции");
  });
});

describe("realBenchEnv", () => {
  it("отбрасывает INSPECTOR_* из shell: без S3, без чужой базы, без судьи; хранилище — заданный каталог", () => {
    const env = realBenchEnv({ PATH: "/bin", INSPECTOR_BLOB_STORE: "s3", INSPECTOR_DATABASE_URL: "postgres://x", INSPECTOR_VLM_BACKEND: "vllm", INSPECTOR_ML_URL: "http://127.0.0.1:41000" }, "/ro/blobs");
    expect(env.PATH).toBe("/bin");
    expect(env.INSPECTOR_BLOB_STORE).toBe("fs");
    expect(env.INSPECTOR_BLOB_DIR).toBe("/ro/blobs");
    expect(env.INSPECTOR_DATABASE_URL).toBeUndefined();
    expect(env.INSPECTOR_VLM_BACKEND).toBeUndefined();
    expect(env.INSPECTOR_PROFILE).toBe("dev");
    expect(env.INSPECTOR_AV).toBe("off");
    expect(env.INSPECTOR_SHEET_DIFF_AUTO).toBe("0");
    expect(env.INSPECTOR_ML_URL).toBe("http://127.0.0.1:41000");
    expect(realBenchEnv({}, "/b").INSPECTOR_ML_URL).toBe("http://127.0.0.1:9");
  });
});

describe("realRow", () => {
  it("статус и фрагменты проверки; идентификатор файла API — в идентификатор реестра", () => {
    const row = realRow(
      { param_code: "M-023", finding_status: "NEGATIVE_VERIFIED", expected_value: "С0", actual_value: "С0", reason: null },
      [{ file_id: "f-1", stage: "PD", sheet_page: 3, extracted_value: "С0", role_expected_actual: "expected" }, { file_id: "f-x", stage: "RD", sheet_page: 1, extracted_value: null, role_expected_actual: "actual" }],
      new Map([["f-1", "PD-aaaaaaaaaaaa"]]),
    );
    expect(row.code).toBe("M-023");
    expect(row.status).toBe("NEGATIVE_VERIFIED");
    expect(row.fragments).toEqual([
      { file_id: "PD-aaaaaaaaaaaa", stage: "PD", page: 3, value: "С0", kind: "expected" },
      { file_id: "f-x", stage: "RD", page: 1, value: null, kind: "actual" },
    ]);
  });
});
