// Самопроверка гейта висящих промисов (T-107): гейт обязан краснеть на дефекте и молчать на корректном коде.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (file) => spawnSync(process.execPath, ["scripts/check-floating-promises.mjs", file], { encoding: "utf8" });

test("висящий вызов, forEach(async) и then без await — гейт красный, называет строки", () => {
  const r = run("scripts/fixtures/floating/bad.ts");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /висящие промисы: 3/);
  assert.match(r.stderr, /bad\.ts:3 +save\(\);/);
  assert.match(r.stderr, /bad\.ts:4 +forEach\(async/);
  assert.match(r.stderr, /bad\.ts:5 +Promise\.resolve/);
});

test("await, void с catch, for…of, Promise.all, промис в переменной — гейт зелёный", () => {
  const r = run("scripts/fixtures/floating/good.ts");
  assert.equal(r.status, 0, r.stderr);
});
