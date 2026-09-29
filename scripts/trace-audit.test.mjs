// Храповик аудита детальной трассы (T-164): счётчики расхождений и сверка с базой.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ratchet, traceAudit } from "./trace-audit.mjs";

const mp = (atoms, extra = {}) => ({
  services: [{ id: "OS-X-1.1", rules: [{ id: "OS-X-1.1.1", code: ["a.ts"], tests: ["a.test.ts::t"] }, { id: "OS-X-1.1.2", code: ["b.ts"], tests: [] }] }],
  constraints: [{ id: "NFR-A", code: [], tests: [] }],
  dialogs: [],
  data: [{ id: "DO-REF", class: "predefined", new_in: [], used_by: [], code: ["0001.sql"] }, { id: "DO-DICT", class: "predefined", new_in: [], used_by: ["BO-2"], code: ["0001.sql"], tests: ["db.test.ts::схема"] }, { id: "DO-NEW", class: "new", new_in: ["BO-1"], code: ["0001.sql"] }],
  decomposition: { sections: [{ id: "S1", items: [{ id: "TZ-1", atoms }] }] },
  tz: [{ id: "TZ-1", status: "done", units: ["OS-X-1.1.1", "OS-X-1.1.2"] }],
  gaps: [{ id: "GAP-1", status: "open" }, { id: "GAP-2", status: "closed" }, { id: "GAP-3", status: "open" }],
  tzDetail: { sections: [{ regions: [{ gap: "GAP-3" }] }] },
  ...extra,
});
const a = (id, trace, verdict = "done") => ({ id, trace, verdict });
const root = () => mkdtempSync(join(tmpdir(), "trace-audit-"));

test("атом, чья трасса ведёт только в объект данных без операций, — без дорожки; справочник с читающей операцией — с дорожкой", () => {
  const r = traceAudit(root(), mp([a("A1", ["DO-REF"]), a("A2", ["DO-REF", "OS-X-1.1.1"]), a("A3", [], "todo"), a("A4", ["DO-DICT"])]));
  assert.deepEqual(r.hits.atom_no_lane, ["A1"]);
  assert.ok(!r.hits.atom_green_broken.includes("A4"), "справочник с тестом схемы — не обрыв");
});

test("зелёный атом с дорожкой без теста или без кода — расхождение; незелёный — нет", () => {
  const r = traceAudit(root(), mp([a("A1", ["OS-X-1.1.1"]), a("A2", ["OS-X-1.1.2"]), a("A3", ["NFR-A"]), a("A4", ["OS-X-1.1.2"], "partial"), a("A5", ["DO-NEW"])]));
  assert.deepEqual(r.hits.atom_green_broken, ["A2", "A3", "A5"]);
});

test("зелёный по честному цвету считается так же, как done", () => {
  const r = traceAudit(root(), mp([a("A1", ["OS-X-1.1.2"], "x")]), { colorOf: () => "green" });
  assert.deepEqual(r.hits.atom_green_broken, ["A1"]);
});

test("статус пункта сверяется с атомами; узел model.yaml → tz без атома — недостигнут", () => {
  const r = traceAudit(root(), mp([a("A1", ["OS-X-1.1.1"]), a("A2", ["NFR-A"], "outside")]));
  assert.deepEqual(r.hits.item_status_mismatch, ["TZ-1: done ≠ partial"]);
  // правило 1.1.2 того же сервиса считается достигнутым через сервис
  assert.deepEqual(r.hits.model_tz_unreached, []);
  const r2 = traceAudit(root(), mp([a("A1", ["NFR-A"])]));
  assert.deepEqual(r2.hits.model_tz_unreached, ["TZ-1 → OS-X-1.1.1", "TZ-1 → OS-X-1.1.2"]);
});

test("открытый пробел без отметки на фрагменте ТЗ — считается; закрытый и отмеченный — нет", () => {
  assert.deepEqual(traceAudit(root(), mp([])).hits.gap_open_unmarked, ["GAP-1"]);
});

test("реестр: считаются только находки со статусом open", () => {
  const d = root();
  mkdirSync(join(d, "docs/audit"), { recursive: true });
  writeFileSync(join(d, "docs/audit/2026-09-28-детальная-трасса-находки.yaml"), "findings:\n  - {id: Д-1, status: open}\n  - {id: Д-2, status: closed}\n");
  assert.deepEqual(traceAudit(d, mp([])).hits.registry_open, ["Д-1"]);
});

test("храповик: без базы — пишет её; рост — ошибка; снижение пишется только при сборке", () => {
  const d = root();
  mkdirSync(join(d, "scripts"));
  const file = join(d, "scripts/trace-audit.baseline.json");
  assert.deepEqual(ratchet(d, { atom_no_lane: 3, registry_open: 5 }, { write: true }).errors, []);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).counts, { atom_no_lane: 3, registry_open: 5 });
  const up = ratchet(d, { atom_no_lane: 4, registry_open: 5 }, { write: true });
  assert.equal(up.errors.length, 1);
  assert.match(up.errors[0], /4, база 3/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).counts.atom_no_lane, 3, "при росте база не меняется");
  ratchet(d, { atom_no_lane: 1, registry_open: 5 }, { write: false });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).counts.atom_no_lane, 3, "--check базу не трогает");
  ratchet(d, { atom_no_lane: 1, registry_open: 2 }, { write: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).counts, { atom_no_lane: 1, registry_open: 2 });
});
