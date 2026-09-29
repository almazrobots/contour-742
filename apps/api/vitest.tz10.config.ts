import { defineConfig } from "vitest/config";
// Мутации модели данных ТЗ §10 (T-234): src/domain/model-registry.ts, norm-base.ts, normative-refs.ts — узкий набор тестов
// правил и интеграции (STRYKER_VITEST_CONFIG=vitest.tz10.config.ts MUTATE='src/domain/{model-registry,norm-base,normative-refs}.ts').
export default defineConfig({
  test: {
    testTimeout: 60_000, hookTimeout: 60_000, env: { INSPECTOR_DATABASE_URL: "memory", INSPECTOR_ML_WAIT_MS: "0" },
    include: ["tests/domain-tz10-model.test.ts", "tests/tz10-model-route.test.ts"],
  },
});
