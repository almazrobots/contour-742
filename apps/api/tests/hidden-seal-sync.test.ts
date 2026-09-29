// OS-INSP-6.1.4 (T-137): печати из репозитория (ml/eval/seals) при старте API дописываются в hidden_seals — иначе гарды
// приёма (6.1.6), GOLD и дообучения (6.1.8), подбора порога (6.1.9) не знают о скрытом тесте организатора.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { makeSeal } from "../src/domain/hidden-seal.ts";
import { assertRepoSeals, loadSeals, syncRepoSeals } from "../src/services/hidden-seal.ts";
import { isLabelsFile } from "../src/domain/hidden-seal.ts";
import { config } from "../src/config.ts";

const h = (c: string) => c.repeat(64);
let db: DB | undefined;
let dir: string | undefined;
afterEach(async () => {
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  db = dir = undefined;
});
const put = (name: string, file: string, files = [{ sha256: h("a"), role: "input" as const }, { sha256: h("b"), role: "labels" as const }]) => {
  const s = makeSeal(name, files, "2026-09-27T00:00:00.000Z");
  writeFileSync(join(dir!, file), JSON.stringify({ ...s, n_files: files.length, n_labels: files.filter((f) => f.role === "labels").length }));
  return s;
};

describe("печати из репозитория → hidden_seals (OS-INSP-6.1.4)", () => {
  it("печать из ml/eval/seals дописывается при старте; повтор ничего не меняет", async () => {
    db = await openDb("memory");
    dir = mkdtempSync(join(tmpdir(), "seals-"));
    const s = put("org", "org.json");
    expect(await syncRepoSeals(db, dir)).toMatchObject({ found: 1, added: ["org"], same: [], conflicts: [], invalid: [] });
    expect(await syncRepoSeals(db, dir)).toMatchObject({ found: 1, added: [], same: ["org"], conflicts: [], invalid: [] });
    const row = await db.get<{ digest: string; sealed_by: string; n_labels: number }>("select digest, sealed_by, n_labels from hidden_seals where name = $1", ["org"]);
    expect(row).toMatchObject({ digest: s.digest, sealed_by: "system:repo-seals", n_labels: 1 });
  });

  it("печать с подменённым составом (отпечаток не сходится) не принимается; журнал ничего не пишет", async () => {
    db = await openDb("memory");
    dir = mkdtempSync(join(tmpdir(), "seals-"));
    const s = makeSeal("x", [{ sha256: h("a"), role: "input" }], "2026-09-27T00:00:00.000Z");
    writeFileSync(join(dir, "x.json"), JSON.stringify({ ...s, files: [{ sha256: h("c"), role: "input" }] }));
    writeFileSync(join(dir, "broken.json"), "{");
    const r = await syncRepoSeals(db, dir);
    expect(r.added).toEqual([]);
    expect(r.invalid.map((i) => i.file).sort()).toEqual(["broken.json", "x.json"]);
    expect(await db.all("select name from hidden_seals")).toEqual([]);
  });

  it("в базе печать с тем же именем и другим отпечатком — конфликт, база не перезаписывается", async () => {
    db = await openDb("memory");
    dir = mkdtempSync(join(tmpdir(), "seals-"));
    const first = put("org", "org.json");
    await syncRepoSeals(db, dir);
    put("org", "org.json", [{ sha256: h("d"), role: "input" }]);
    const r = await syncRepoSeals(db, dir);
    expect(r.conflicts).toEqual([{ name: "org", repo: expect.any(String), db: first.digest }]);
    expect((await db.get<{ digest: string }>("select digest from hidden_seals where name = 'org'"))!.digest).toBe(first.digest);
  });

  it("настоящие печати репозитория (TEST_HIDDEN с разметкой и оригиналы Речникова) загружаются обе", async () => {
    db = await openDb("memory");
    const r = await syncRepoSeals(db, join(config.root, "ml/eval/seals"));
    expect(r.invalid).toEqual([]);
    expect(r.added.sort()).toEqual(["organizer-rechnikov-originals-213", "organizer-test-hidden-213"]);
  });

  it("имя печати занято в базе чужой печатью — гарды всё равно видят печать репозитория (OWASP T-137 E1-M1)", async () => {
    db = await openDb("memory");
    dir = mkdtempSync(join(tmpdir(), "seals-"));
    await db.run("insert into hidden_seals (name, digest, files_json, n_files, n_labels, sealed_at, sealed_by) values ($1,$2,$3,1,0,$4,$5)",
      ["org", "f".repeat(64), JSON.stringify([{ sha256: h("e"), role: "input" }]), "2026-09-27T00:00:00.000Z", "захватчик"]);
    put("org", "org.json");
    const r = await syncRepoSeals(db, dir);
    expect(r.conflicts.map((c) => c.name)).toEqual(["org"]);
    expect(isLabelsFile(h("b"), await loadSeals(db))).toBe(true);
  });

  it("профиль gpu: без печатей репозитория, при конфликте или битой печати старт отказывает; dev — только журнал (OWASP T-137 E3-H1)", () => {
    const ok = { found: 2, added: ["a"], same: ["b"], conflicts: [], invalid: [] };
    expect(() => assertRepoSeals(ok, "gpu")).not.toThrow();
    expect(() => assertRepoSeals({ ...ok, found: 0, added: [], same: [] }, "gpu")).toThrow(/печат/i);
    expect(() => assertRepoSeals({ ...ok, conflicts: [{ name: "a", repo: "1", db: "2" }] }, "gpu")).toThrow(/a/);
    expect(() => assertRepoSeals({ ...ok, invalid: [{ file: "x.json", reason: "подменена" }] }, "gpu")).toThrow(/x\.json/);
    expect(() => assertRepoSeals({ ...ok, found: 0, added: [], same: [] }, "dev")).not.toThrow();
  });
});
