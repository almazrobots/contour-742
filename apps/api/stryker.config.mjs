// Мутационное тестирование предметного слоя (qa-standard, эшелон L8). Пороги — храповик: только вверх.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // STRYKER_VITEST_CONFIG — узкий набор тестов под модуль (vitest.db.config.ts для src/db.ts)
  vitest: { configFile: process.env.STRYKER_VITEST_CONFIG ?? "vitest.unit.config.ts" },
  // повторные прогоны пересчитывают только изменённые мутанты и тесты
  incremental: true,
  incrementalFile: `reports/mutation/incremental-${(process.env.MUTATE ?? "all").replace(/[^\w]+/g, "_")}${process.env.INSPECTOR_TEST_DATABASE_URL ? "-pg" : ""}.json`,
  mutate: [process.env.MUTATE ?? "src/domain/**/*.ts", "!src/domain/types.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: `reports/mutation/${(process.env.MUTATE ?? "all").replace(/[^\w]+/g, "_")}.json` },
  thresholds: { high: 90, low: 80, break: 70 },
  tempDirName: ".stryker-tmp",
  // Перезапись tsconfig в песочнице не нужна: в tsconfig.json API нет extends/references, пути include те же. А для
  // перезаписи Stryker грузит typescript из хойстинга pnpm, где может оказаться 7-я версия apps/web без JS API
  // (ts.parseConfigFileTextToJson is not a function). Несуществующий файл — препроцессор пропускает шаг.
  tsconfigFile: "tsconfig.stryker-skip.json",
  coverageAnalysis: "perTest",
  concurrency: 4,
  timeoutMS: 10000,
};
