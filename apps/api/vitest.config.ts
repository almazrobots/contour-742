import { defineConfig } from "vitest/config";
import { testWorkers } from "./vitest.workers.ts";
// Замер §11 (perf-11: p95 отклика, время пересчёта и протокола) — только отдельным прогоном: в общем параллельном наборе он
// делит CPU с остальными воркерами и мигает. Включается INSPECTOR_PERF=1 (`pnpm test` делает это вторым шагом).
const perf = process.env.INSPECTOR_PERF === "1";
const workers = testWorkers();
export default defineConfig({
  test: {
    maxWorkers: perf ? 1 : workers,
    include: perf ? ["tests/perf-11.test.ts"] : ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup-tls.ts", "tests/setup-mtls.ts"],
    exclude: ["**/node_modules/**", ".stryker-tmp/**", ...(perf ? [] : ["tests/perf-11.test.ts"])],
    testTimeout: 60_000, hookTimeout: 60_000, env: { INSPECTOR_DATABASE_URL: "memory", INSPECTOR_ML_WAIT_MS: "0" },
    coverage: { include: ["src/**"], reporter: ["text-summary", "json-summary"], reportsDirectory: "reports/coverage" },
  },
});
