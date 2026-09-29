// OS-INSP-4.1.17 (T-130): очередь верификации по параметру. Эшелоны: L1 (фильтр и порядок), L3 (границы: ?c= на
// результат системы, пустой фильтр), L7 (результат системы не ждёт решения инспектора).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PARAMS, filterableParams, pendingDecision, queueParam, verifyQueue } from "../src/lib/queue.ts";

const ck = (id, param_code, finding_status, over = {}) => ({ id, param_code, about_param: param_code.startsWith("SUSP") ? null : param_code, finding_status, verification_status: "PENDING", review_priority: "HIGH", provenance_json: null, ...over });
const CHECKS = [
  ck("m059", "M-059", "CANDIDATE"),
  ck("m023", "M-023", "NEGATIVE_VERIFIED", { provenance_json: "{}" }),
  ck("susp1", "SUSP-1", "CANDIDATE", { about_param: "M-023", verification_status: "CLARIFICATION_REQUIRED" }),
  ck("m010", "M-010", "MISSING_EVIDENCE"),
  ck("split", "M-023", "CANDIDATE", { verification_status: "SPLIT" }),
];

test("OS-INSP-4.1.17 очередь по параметру М-023: результат системы и гипотеза о нём, без М-059", () => {
  assert.deepEqual(verifyQueue(CHECKS, "M-023").map((c) => c.id), ["m023", "susp1"]);
  assert.deepEqual(verifyQueue(CHECKS, null).map((c) => c.id), ["m059", "susp1"], "без фильтра — только кандидаты, как раньше");
  assert.deepEqual(verifyQueue(CHECKS, "M-404"), []);
});

test("OS-INSP-4.1.17 ссылка ?c= на результат системы открывает очередь его параметра; на кандидата — общую", () => {
  assert.equal(queueParam(CHECKS, null, "m023"), "M-023");
  assert.equal(queueParam(CHECKS, null, "m059"), null);
  assert.equal(queueParam(CHECKS, "M-059", "m023"), "M-059", "явный ?param= важнее");
  assert.equal(queueParam(CHECKS, null, "нет-такой"), null);
});

test("результат системы по параметру не ждёт решения инспектора; фильтр предлагает параметры с кандидатами и разобранным классом", () => {
  assert.equal(pendingDecision(CHECKS[1]), false);
  assert.equal(pendingDecision(CHECKS[0]), true);
  assert.equal(pendingDecision(CHECKS[2]), false, "уже на уточнении");
  assert.deepEqual(filterableParams(CHECKS), ["M-023", "M-059"]);
});

import { judgeText, OUTCOME, SOURCE } from "../src/lib/mentions.ts";

test("OS-INSP-4.1.18 след упоминания словами инспектора: источник, исход прочтений, проверка фрагмента листа", () => {
  assert.equal(SOURCE["scan-reader"], "скан, найдено моделью-читателем");
  assert.equal(OUTCOME["majority-reader"], "два прочтения из трёх — за модель, значение исправлено");
  assert.equal(judgeText({ outcome: "confirmed", value: "С0", subject: "object", note: "" }), "подтверждено: С0 относится к проверяемому зданию");
  assert.equal(judgeText({ outcome: "excluded", value: "С1", subject: "neighbor", note: "" }), "относится к соседнему зданию — значением не берётся");
  assert.equal(judgeText({ outcome: "что-то новое", value: null, subject: null, note: "" }), "не проверялось");
  for (const t of [...Object.values(SOURCE), ...Object.values(OUTCOME)]) assert.doesNotMatch(t, /VLM|OCR|seed|SC\b/, `жаргон в «${t}»`);
});

test("T-132: «все параметры» — все записи Матрицы по порядку кода, без гипотез и разделённых", () => {
  const checks = [
    { id: "3", param_code: "M-023", finding_status: "NEGATIVE_VERIFIED", verification_status: "PENDING", review_priority: "HIGH" },
    { id: "1", param_code: "M-001", finding_status: "CANDIDATE", verification_status: "PENDING", review_priority: "HIGH" },
    { id: "s", param_code: "SUSP-1", finding_status: "CANDIDATE", verification_status: "PENDING", review_priority: "HIGH" },
    { id: "x", param_code: "M-002", finding_status: "MISSING_EVIDENCE", verification_status: "SPLIT", review_priority: "LOW" },
  ];
  assert.deepEqual(verifyQueue(checks, ALL_PARAMS).map((c) => c.param_code), ["M-001", "M-023"]);
});

import { byUse, modelLabel } from "../src/lib/mentions.ts";

test("OS-INSP-4.1.18 карточка: короткое имя модели и порядок упоминаний — значение стадии первым, отсеянное последним", () => {
  assert.equal(modelLabel("mlx-community/PaddleOCR-VL-1.5-bf16"), "PaddleOCR-VL-1.5");
  assert.equal(modelLabel("mlx-community/Qwen3.5-9B-MLX-4bit"), "Qwen3.5-9B");
  assert.equal(modelLabel("ансамбль OCR (Tesseract ×3)"), "ансамбль OCR (Tesseract ×3)");
  const ms = [{ use: "dropped", page: 12 }, { use: "reference", page: 23 }, { use: "considered", page: 20 }, { use: "chosen", page: 7 }, { use: "considered", page: 6 }, { use: "flagged", page: 1 }];
  assert.deepEqual(byUse(ms).map((m) => `${m.use}:${m.page}`), ["chosen:7", "considered:6", "considered:20", "flagged:1", "reference:23", "dropped:12"]);
});
