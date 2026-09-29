// Слова инспектора вместо кодов: поля и значения автоматической верификации в паспорте параметра (T-129).
//   node --test apps/web/tests/labels.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_CHECK_RU, keyParamStatus, STAGE_STATE_RU, VERIFY_FIELD_RU, verifyValue } from "../src/lib/labels.ts";

test("раздел «Объекты»: итог М-023 словами инспектора, без кодов; решение инспектора важнее итога сверки", () => {
  const row = (finding_status, verification_status = "PENDING") => keyParamStatus({ checked: true, finding_status, verification_status });
  assert.equal(row("NEGATIVE_VERIFIED").ru, "Расхождения нет, ждёт решения инспектора");
  assert.equal(row("NEGATIVE_VERIFIED", "NEGATIVE_VERIFIED").ru, "Инспектор подтвердил: расхождения нет");
  assert.equal(row("CANDIDATE", "CONFIRMED_VIOLATION").tone, "red");
  assert.equal(row("MISSING_EVIDENCE", "CLARIFICATION_REQUIRED").ru, "Инспектор запросил уточнение");
  assert.equal(keyParamStatus({ checked: false, finding_status: null, verification_status: null }).ru, "Не проверялся");
  assert.equal(keyParamStatus({ checked: true, finding_status: null, verification_status: null }).ru, "Не проверялся");
  for (const f of ["NEGATIVE_VERIFIED", "CANDIDATE", "MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED", "NOT_APPLICABLE"]) {
    assert.doesNotMatch(row(f).ru, /[A-Z_]{4,}/, `${f}: код в подписи`);
  }
  assert.equal(row("NOT_APPLICABLE").tone, "gray");
  assert.equal(row("SPLIT_NEW", "SPLIT").ru, "SPLIT_NEW, ждёт решения инспектора"); // неизвестный итог не прячется
  for (const v of [...Object.values(STAGE_STATE_RU), ...Object.values(AUTO_CHECK_RU)]) assert.doesNotMatch(v, /[A-Za-z_]{3,}/);
  assert.equal(STAGE_STATE_RU.NOT_LOADED, "стадия не загружена");
  assert.equal(STAGE_STATE_RU.NO_VALUE, "значение не найдено");
});

test("поля верификации М-023 названы словами, без ключей отчёта оракула", () => {
  for (const k of ["status", "PD", "RD", "PD.internal_conflict", "PD.evidence", "RD.evidence"]) {
    assert.ok(VERIFY_FIELD_RU[k], k);
    assert.doesNotMatch(VERIFY_FIELD_RU[k], /[A-Za-z_]{3,}/, `${k}: латиница в подписи`);
  }
});

test("значения: статус словами, указатель «sha@стр» — «sha · стр. N», пусто — прочерк, прочее — как есть", () => {
  assert.equal(verifyValue("status", "NEGATIVE_VERIFIED"), "Расхождения нет");
  assert.equal(verifyValue("status", "SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(verifyValue("PD.evidence", "d0d8cf1ef149@7"), "d0d8cf1ef149 · стр. 7");
  assert.equal(verifyValue("PD", "не ниже С0"), "не ниже С0");
  assert.equal(verifyValue("RD", null), "—");
});

test("T-234: статусы дообучения, исхода спора и допуска модели — словами, без кодов", async () => {
  const { MODEL_STATUS_RU, RESOLUTION_RU, RETRAINING_RU } = await import("../src/lib/labels.ts");
  assert.deepEqual(Object.keys(RETRAINING_RU).sort(), ["INCLUDED", "PENDING", "SUPERSEDED"]);
  assert.deepEqual(Object.keys(RESOLUTION_RU).sort(), ["AI_UPHELD", "INSPECTOR_UPHELD", "OPEN", "WITHDRAWN"]);
  assert.deepEqual(Object.keys(MODEL_STATUS_RU).sort(), ["AWAITING_APPROVAL", "PUBLISHED", "REJECTED_BY_GATE", "ROLLED_BACK", "SUPERSEDED"]);
  for (const v of [...Object.values(RETRAINING_RU), ...Object.values(RESOLUTION_RU), ...Object.values(MODEL_STATUS_RU)]) {
    assert.doesNotMatch(v.ru, /[A-Za-z_]{3,}/);
    assert.ok(v.tone);
  }
});
