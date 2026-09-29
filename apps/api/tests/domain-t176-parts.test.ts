// Эшелоны: L2 (паспорта W1 T-176 проходят схему реестра видов), L6 (незнакомое семейство — громкий отказ). Части
// паспортов М-050, 072, 079, 125, 128 — в формате частей T-174 (parts/<код>.<key>.json): вид и извлекатель — из реестра.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalogsFile, familyOf, setFamilies } from "../src/domain/analogs.ts";
import { ParamPassport } from "../src/domain/passport.ts";

let ROOT = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(ROOT, "data/seed/matrix.json"))) ROOT = dirname(ROOT);
setFamilies(AnalogsFile.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/analogs.json"), "utf8"))).families);
const dir = join(ROOT, "data/seed/passports");

describe("паспорта T-176", () => {
  it("паспорта М-032, 044, 075, 130 проходят схему паспорта с видами category и layers из реестра, семейства есть в справочнике", () => {
    for (const code of ["M-032", "M-044", "M-075", "M-130"]) {
      const pp = ParamPassport.parse(JSON.parse(readFileSync(join(dir, `${code}.json`), "utf8")));
      expect(["category", "layers"]).toContain(pp.value.kind);
      expect(familyOf(String((pp.value as unknown as { family: string }).family)).title.length).toBeGreaterThan(3);
    }
  });

  it("части М-050, 072, 079, 125, 128: имя файла — код и ключ, value и extractor проходят схему реестра", () => {
    const files = readdirSync(join(dir, "parts")).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(["M-050.subst.json", "M-072.subst.json", "M-079.subst.json", "M-125.layers.json", "M-128.layers.json"]);
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(dir, "parts", f), "utf8"));
      expect(`${raw.code}.${raw.key}.json`).toBe(f);
      const v = ParamPassport.shape.value.parse(raw.value) as unknown as { kind: string; family: string };
      ParamPassport.shape.extractor.parse(raw.extractor);
      ParamPassport.shape.sources.parse(raw.sources);
      familyOf(v.family, raw.code);
    }
  });
});
