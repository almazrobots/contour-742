// T-137: печать скрытого теста (OS-INSP-6.1.4–6.1.9, ТЗ 14.2-04, 9.4.2-03) — чистые функции domain/hidden-seal.ts.
// L1 — правила, L2 — паритет отпечатка с ml/eval/hidden_seal.py (один вход — один hex), L3 — границы, L6 — враждебные входы.
// Имя теста — ссылка трассы model.yaml.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canScore, checkReseal, goldExclusion, isLabelsFile, makeSeal, sealCanon, sealDigest, SealError, thresholdGuard, verifyFiles, type Seal, type SealFile,
} from "../src/domain/hidden-seal.ts";
import { config } from "../src/config.ts";

const h = (c: string) => c.repeat(64);
const AT = "2026-09-27T00:00:00.000Z";
// Фикстура паритета: тот же вход и тот же hex зашиты в ml/tests/test_hidden_seal.py
const PARITY_FILES: SealFile[] = [
  { sha256: h("b"), role: "labels" },
  { sha256: "0123456789abcdef".repeat(4), role: "input" },
  { sha256: h("a"), role: "input" },
];
const PARITY_HEX = "9fdf617e45711e5bfa6bcb25d67a4145630e59d388105ab2b9b9a3fcf4125a80";

const seal = (name: string, files: SealFile[]) => makeSeal(name, files, AT);
// Фикстуры строятся в хуке, а не при загрузке модуля: мутант, ломающий makeSeal, иначе роняет сбор файла — vitest не
// запускает ни одного теста, и Stryker засчитывает такой мутант выжившим (T-137, песочница мутаций).
let S1: Seal;
let S2: Seal;
beforeEach(() => {
  S1 = seal("s1", [{ sha256: h("1"), role: "input" }, { sha256: h("2"), role: "input" }, { sha256: h("3"), role: "labels" }]);
  S2 = seal("s2", [{ sha256: h("4"), role: "input" }, { sha256: h("5"), role: "labels" }]);
});

describe("OS-INSP-6.1.4 печать скрытого теста", () => {
  it("отпечаток печати совпадает с ml/eval/hidden_seal.py байт в байт (фикстура паритета)", () => {
    expect(sealDigest("parity-fixture", PARITY_FILES)).toBe(PARITY_HEX);
    expect(sealCanon("parity-fixture", PARITY_FILES)).toBe(
      `hidden-seal/1\nparity-fixture\ninput:${"0123456789abcdef".repeat(4)}\ninput:${h("a")}\nlabels:${h("b")}\n`,
    );
  });

  it("реальная печать TEST_HIDDEN организатора (ml/eval/seals) пересчитывается тем же отпечатком: 222 файла, 217 меток", () => {
    const real = JSON.parse(readFileSync(join(config.root, "ml/eval/seals/organizer-test-hidden-213.json"), "utf8"));
    expect(sealDigest(real.name, real.files)).toBe(real.digest);
    expect(real.n_files).toBe(222);
    expect(real.files.filter((f: SealFile) => f.role === "labels")).toHaveLength(217);
  });

  it("печать хранит число файлов, SHA-256 каждого файла с ролью и общий отпечаток; порядок файлов на отпечаток не влияет", () => {
    const s = seal("parity-fixture", PARITY_FILES);
    expect(s.digest).toBe(PARITY_HEX);
    expect(s.files).toHaveLength(3);
    expect(s.files.map((f) => f.role)).toEqual(["input", "input", "labels"]);
    expect(s.sealed_at).toBe(AT);
    expect(seal("parity-fixture", [...PARITY_FILES].reverse()).digest).toBe(PARITY_HEX);
  });

  it("отпечаток зависит от имени, роли и каждого хеша", () => {
    expect(sealDigest("other", PARITY_FILES)).not.toBe(PARITY_HEX);
    expect(sealDigest("parity-fixture", PARITY_FILES.map((f, i) => (i === 0 ? { ...f, role: "input" as const } : f)))).not.toBe(PARITY_HEX);
    expect(sealDigest("parity-fixture", PARITY_FILES.map((f, i) => (i === 2 ? { ...f, sha256: h("c") } : f)))).not.toBe(PARITY_HEX);
    expect(sealDigest("parity-fixture", PARITY_FILES.slice(1))).not.toBe(PARITY_HEX);
  });

  it("повторная печать под тем же именем с другим составом отклоняется, с тем же — не создаёт новую", () => {
    expect(checkReseal(null, S1)).toEqual({ ok: true, same: false });
    expect(checkReseal(S1, seal("s1", [...S1.files].reverse()))).toEqual({ ok: true, same: true });
    const r = checkReseal(S1, seal("s1", [{ sha256: h("1"), role: "input" }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("s1");
  });

  it("враждебные входы печати: не-hex, короткий хеш, заглавные, дубли, пустая печать, чужая роль, плохое имя — ошибка", () => {
    const bad: Array<[string, SealFile[]]> = [
      ["x", [{ sha256: "z".repeat(64), role: "input" }]],
      ["x", [{ sha256: h("a").slice(1), role: "input" }]],
      ["x", [{ sha256: h("A"), role: "input" }]],
      ["x", [{ sha256: h("a"), role: "input" }, { sha256: h("a"), role: "labels" }]],
      ["x", []],
      ["x", [{ sha256: h("a"), role: "answer" as any }]],
      ["", [{ sha256: h("a"), role: "input" }]],
      ["a\nb", [{ sha256: h("a"), role: "input" }]],
      ["../etc", [{ sha256: h("a"), role: "input" }]],
      ["я".repeat(3), [{ sha256: h("a"), role: "input" }]],
      ["x".repeat(101), [{ sha256: h("a"), role: "input" }]],
    ];
    for (const [name, files] of bad) expect(() => sealDigest(name, files), `${JSON.stringify(name)}`).toThrow(SealError);
  });

  it("границы имени: 1 и 100 символов допустимы", () => {
    expect(() => sealDigest("x", [{ sha256: h("a"), role: "input" }])).not.toThrow();
    expect(() => sealDigest("x".repeat(100), [{ sha256: h("a"), role: "input" }])).not.toThrow();
  });
});

describe("OS-INSP-6.1.5 сверка файлов с печатью перед прогоном", () => {
  it("сверка перед прогоном: совпадающий состав проходит, добавленный, пропавший и изменённый файл останавливают прогон", () => {
    expect(verifyFiles(S1, [h("3"), h("1"), h("2")])).toEqual({ ok: true, added: [], missing: [] });
    expect(verifyFiles(S1, [h("1"), h("2"), h("3"), h("9")])).toEqual({ ok: false, added: [h("9")], missing: [] });
    expect(verifyFiles(S1, [h("1"), h("3")])).toEqual({ ok: false, added: [], missing: [h("2")] });
    // изменённый = пропал старый + появился новый
    expect(verifyFiles(S1, [h("1"), h("8"), h("3")])).toEqual({ ok: false, added: [h("8")], missing: [h("2")] });
  });
  it("копия файла в каталоге прогона — лишний файл; пустой каталог — пропали все; хеш в верхнем регистре сверяется как тот же", () => {
    expect(verifyFiles(S1, [h("1"), h("1"), h("2"), h("3")])).toEqual({ ok: false, added: [h("1")], missing: [] });
    expect(verifyFiles(S1, [])).toEqual({ ok: false, added: [], missing: [h("1"), h("2"), h("3")] });
    expect(verifyFiles(S1, [h("1").toUpperCase(), h("2"), h("3")]).ok).toBe(true);
    expect(() => verifyFiles(S1, ["не-хеш"])).toThrow(SealError);
  });
});

describe("OS-INSP-6.1.6 метки скрытого теста не уходят в конвейер", () => {
  it("файл меток любой печати распознаётся, входной файл и чужой — нет", () => {
    expect(isLabelsFile(h("3"), [S1, S2])).toBe(true);
    expect(isLabelsFile(h("5"), [S1, S2])).toBe(true);
    expect(isLabelsFile(h("5").toUpperCase(), [S1, S2])).toBe(true);
    expect(isLabelsFile(h("1"), [S1, S2])).toBe(false);
    expect(isLabelsFile(h("9"), [S1, S2])).toBe(false);
    expect(isLabelsFile(h("3"), [])).toBe(false);
  });
});

describe("OS-INSP-6.1.7 балл только по ответу из журнала печати", () => {
  const journal = [{ seal_name: "s1", answer_sha256: h("e") }, { seal_name: "s2", answer_sha256: h("f") }];
  it("ответ, записанный в журнал печати заранее, оценивается; ответ вне журнала или из журнала другой печати — нет", () => {
    expect(canScore(S1, journal, h("e"))).toEqual({ ok: true });
    const out = canScore(S1, journal, h("d"));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("нет в журнале");
    expect(canScore(S1, journal, h("f")).ok).toBe(false);
  });
  it("метки должны входить в печать с ролью «метки»: входной файл и чужой файл как метки — отказ", () => {
    expect(canScore(S1, journal, h("e"), h("3"))).toEqual({ ok: true });
    expect(canScore(S1, journal, h("e"), h("1")).ok).toBe(false);
    expect(canScore(S1, journal, h("e"), h("5")).ok).toBe(false);
    expect(() => canScore(S1, journal, "не-хеш")).toThrow(SealError);
  });
});

describe("OS-INSP-6.1.8 скрытый тест не входит в GOLD и в обучение", () => {
  it("решения по файлам скрытого теста исключаются из GOLD с числом исключённых, вместе со всем объектом", () => {
    const items = [
      { finding_id: "a", file_shas: [h("7")], object_id: "O1" },
      { finding_id: "b", file_shas: [h("7"), h("2")], object_id: "O2" }, // входной файл печати s1
      { finding_id: "c", file_shas: [h("8")], object_id: "O2" }, // тот же объект — объект целиком в скрытом тесте
      { finding_id: "d", file_shas: [h("5")], object_id: "O3" }, // метки печати s2
      { finding_id: "e", file_shas: [], object_id: "O4" },
    ];
    const r = goldExclusion(items, [S1, S2]);
    expect(r.count).toBe(3);
    expect(r.excluded.map((i) => i.finding_id)).toEqual(["b", "c", "d"]);
    expect(r.kept.map((i) => i.finding_id)).toEqual(["a", "e"]);
  });
  it("без печатей и без пересечений ничего не исключается", () => {
    const items = [{ finding_id: "a", file_shas: [h("7")], object_id: "O1" }];
    expect(goldExclusion(items, []).count).toBe(0);
    expect(goldExclusion(items, [S1]).kept).toEqual(items);
    expect(goldExclusion([], [S1])).toEqual({ kept: [], excluded: [], count: 0 });
  });
});

describe("OS-INSP-6.1.9 порог только на validation", () => {
  it("validation пересекается со скрытым тестом по SHA-256 или object_id — отказ с перечнем пересечения", () => {
    const val = [
      { finding_id: "v1", file_shas: [h("9")], object_id: "V1" },
      { finding_id: "v2", file_shas: [h("3"), h("1")], object_id: "V2" },
      { finding_id: "v3", file_shas: [h("1")], object_id: "T1" },
    ];
    const g = thresholdGuard(val, [S1], ["T1", "T2"]);
    expect(g).not.toBeNull();
    expect(g!.shas).toEqual([h("1"), h("3")]);
    expect(g!.object_ids).toEqual(["T1"]);
    expect(g!.reason).toContain("validation пересекается со скрытым тестом");
  });
  it("пересечение только по object_id и только по SHA-256 — тоже отказ; без пересечения — null", () => {
    const val = [{ file_shas: [h("9")], object_id: "T2" }];
    expect(thresholdGuard(val, [S1], new Set(["T2"]))).toMatchObject({ shas: [], object_ids: ["T2"] });
    expect(thresholdGuard([{ file_shas: [h("2")], object_id: "V" }], [S1], [])).toMatchObject({ shas: [h("2")], object_ids: [] });
    expect(thresholdGuard(val, [S1], ["T1"])).toBeNull();
    expect(thresholdGuard([], [S1], ["T1"])).toBeNull();
  });
});
