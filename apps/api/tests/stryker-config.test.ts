// L7 (T-139): тест предметного слоя, не попавший в vitest.unit.config.ts, молча выпадает из мутационного прогона Stryker —
// мутанты «выживают», хотя тест их ловит (27.09: domain-reason-code и domain-access не были в списке). Тест с путём
// «../../..» в песочнице Stryker уходит мимо корня и роняет начальный прогон (27.09: domain-synthetic).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cfg = readFileSync(new URL("../vitest.unit.config.ts", import.meta.url), "utf8");

describe("конфиг мутаций Stryker", () => {
  it("каждый тест предметного слоя (domain-*.test.ts) входит в узкий набор vitest.unit.config.ts", () => {
    const domain = readdirSync(new URL(".", import.meta.url)).filter((f) => /^domain-.*\.test\.ts$/.test(f));
    expect(domain.length).toBeGreaterThan(20);
    expect(domain.filter((f) => !cfg.includes(`"tests/${f}"`))).toEqual([]);
  });
  it("тесты узкого набора берут корень репозитория из config.root, а не подъёмом ../../..", () => {
    const files = [...new Set([...cfg.matchAll(/"tests\/([^"]+\.test\.ts)"/g)].map((m) => m[1]))];
    const up = /["']\.\.["'],\s*["']\.\.["'],\s*["']\.\.["']|\.\.\/\.\.\/\.\.\//;
    // строки-комментарии не в счёт: там подъём как раз объясняют («../../.. в песочнице не доходит»)
    const code = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(files.filter((f) => up.test(code(f)))).toEqual([]);
  });
});
