import { defineConfig } from "vitest/config";
import { testWorkers } from "./vitest.workers.ts";
// Мутации одного модуля (T-137): STRYKER_VITEST_CONFIG=vitest.narrow.config.ts NARROW_TESTS="tests/a.test.ts,tests/b.test.ts".
// Узкий набор — только тесты, которые покрывают мутируемый модуль; весь unit-набор на каждом мутанте гонять незачем.
const tests = (process.env.NARROW_TESTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!tests.length) throw new Error("NARROW_TESTS пуст — укажите тесты модуля через запятую");
export default defineConfig({
  test: {
    maxWorkers: testWorkers(),
    testTimeout: 60_000, hookTimeout: 60_000, env: { INSPECTOR_DATABASE_URL: "memory", INSPECTOR_ML_WAIT_MS: "0" },
    globalSetup: ["tests/setup-tls.ts", "tests/setup-mtls.ts"],
    include: tests,
  },
});
