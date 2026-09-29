import { defineConfig } from "vitest/config";
import { testWorkers } from "./vitest.workers.ts";
// Мутации адаптера базы (src/db.ts, T-107): только тесты слоя данных. Базу тесты открывают в хуках — Stryker считает такой
// код «статическим» и гоняет на каждом мутанте весь набор; узкий набор — ~5 с вместо ~46 с на статический мутант.
export default defineConfig({
  test: {
    maxWorkers: testWorkers(),
    testTimeout: 60_000, hookTimeout: 60_000, env: { INSPECTOR_DATABASE_URL: "memory", INSPECTOR_ML_WAIT_MS: "0" },
    include: ["tests/db.test.ts", "tests/domain-db.test.ts", "tests/db-hardening.test.ts"],
  },
});
