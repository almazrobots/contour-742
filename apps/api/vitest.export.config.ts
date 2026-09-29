import { defineConfig } from "vitest/config";
import { testWorkers } from "./vitest.workers.ts";
// Мутации выгрузки и правил источника (T-117, T-121, T-134): submission.ts, appendix2.ts, discipline-fit.ts — только их
// чистые тесты. Узкий набор: полный unit-набор на каждый мутант занял бы час, этот — минуты.
//   STRYKER_VITEST_CONFIG=vitest.export.config.ts MUTATE='src/domain/{submission,appendix2,discipline-fit}.ts' npx stryker run
export default defineConfig({
  test: {
    maxWorkers: testWorkers(),
    testTimeout: 60_000,
    env: { INSPECTOR_DATABASE_URL: "memory", INSPECTOR_ML_WAIT_MS: "0" },
    include: ["tests/domain-submission.test.ts", "tests/domain-appendix2.test.ts", "tests/domain-discipline-fit.test.ts"],
  },
});
