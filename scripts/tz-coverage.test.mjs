// Покрытие ТЗ кодом (T-141): формула процентов по разделам, группам и в целом.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSINESS, GROUPS, coverage } from "./tz-coverage.mjs";

const atom = (id, code, verdict, scope = "prototype", extra = {}) => ({ id, t: `требование ${id}`, code, verdict, scope, ...extra });
const dz = {
  sections: [
    { id: "S9.1", title: "Модуль загрузки", items: [{ id: "TZ-9.1.1", title: "OCR", atoms: [atom("A1", "done", "done", "prototype", { color: "green" }), atom("A2", "done", "outside", "gpu", { color: "blue" }), atom("A3", "none", "outside", "gpu", { color: "red" })] }] },
    { id: "S12", title: "Безопасность", items: [{ id: "TZ-12.1", title: "Доступ", atoms: [atom("B1", "partial", "partial", "prototype", { note: "без УКЭП", color: "yellow" }), atom("B2", "none", "outside", "prod", { color: "red" })] }] },
    { id: "S2", title: "Нормативы", items: [{ id: "TZ-2", title: "13 актов", atoms: [atom("C1", "done", "done", "prototype", { color: "green" })] }] },
  ],
};

test("в целом: покрыто кодом = атомы с кодом и тестом по всей трассе, частичное не засчитывается", () => {
  const c = coverage(dz);
  assert.deepEqual(c.total, { n: 6, done: 3, partial: 1, none: 2, accepted: 2, pct: 50, acceptedPct: 33, audited: 0, real: 0, realSure: 0, realPct: 0, colors: { green: 2, yellow: 1, red: 2, blue: 1, grey: 0 }, greenPct: 33 });
  // готовый код атома GPU-стенда — покрыт кодом, но не принят
  assert.equal(c.prototype.n, 3);
  assert.equal(c.prototype.done, 2);
});

test("раздел: название словами заказчика, проценты и открытые атомы с причиной", () => {
  const s = coverage(dz).sections.find((x) => x.id === "S9.1");
  assert.equal(s.title, "Приём и распознавание документов");
  assert.equal(s.tz, "Модуль загрузки");
  assert.equal(s.pct, 67);
  assert.deepEqual(s.open.map((o) => [o.id, o.why]), [["A3", "нет кода в трассе · принимается на GPU-стенде"]]);
  const sec = coverage(dz).sections.find((x) => x.id === "S12");
  assert.deepEqual(sec.open.map((o) => o.why), ["без УКЭП", "нет кода в трассе · принимается в эксплуатационном контуре"]);
});

test("группы: разделы разложены по функциям, нормативам и качеству эксплуатации", () => {
  const g = Object.fromEntries(coverage(dz).groups.map((x) => [x.id, x]));
  assert.deepEqual(g.func.sections, ["S9.1"]);
  assert.equal(g.func.pct, 67);
  assert.deepEqual(g.quality.sections, ["S12"]);
  assert.equal(g.quality.pct, 0);
  assert.equal(g.norm.pct, 100);
});

test("атом без поля code — ошибка: покрытие считается только после decompose()", () => {
  assert.throws(() => coverage({ sections: [{ id: "S1", title: "x", items: [{ id: "i", title: "i", atoms: [{ id: "Z", verdict: "done" }] }] }] }), /нет покрытия кодом/);
});

test("у каждого раздела ТЗ есть имя для заказчика в существующей группе", () => {
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const [id, b] of Object.entries(BUSINESS)) {
    assert.ok(ids.has(b.group), `${id}: группа ${b.group}`);
    assert.ok(b.title && b.what, `${id}: название и пояснение`);
  }
});

test("пустой раздел не делит на ноль", () => {
  const c = coverage({ sections: [{ id: "S6", title: "x", items: [] }] });
  assert.equal(c.total.pct, 0);
  assert.equal(c.sections[0].pct, 0);
});

test("аудит: «подтверждено» — только вердикт REAL; покрытое трассой, но не подтверждённое — в открытых с причиной", () => {
  const audit = { audited_at: "2026-09-27", revision: "abc", atoms: { A1: { verdict: "REAL", uncertain: false, evidence: "x" }, A2: { verdict: "WEAK_TEST", uncertain: false, evidence: "тест про другое" }, C1: { verdict: "REAL", uncertain: true, evidence: "y" } } };
  const c = coverage(dz, audit);
  assert.equal(c.total.real, 2);
  assert.equal(c.total.realSure, 1);
  assert.equal(c.total.realPct, 33);
  assert.equal(c.total.audited, 3);
  assert.equal(c.audit.by.WEAK_TEST, 1);
  const s = c.sections.find((x) => x.id === "S9.1");
  assert.equal(s.real, 1);
  const a2 = s.open.find((o) => o.id === "A2");
  assert.equal(a2.why, "в трассе покрыто");
  assert.equal(a2.audit.what, "код есть, тест проверяет не критерий ТЗ");
  assert.ok(!s.open.some((o) => o.id === "A1"), "подтверждённый не в открытых");
});

test("устаревший REAL с зелёным кодом остаётся открытым до повторного аудита", () => {
  const dzChanged = {
    sections: [{ id: "S1", title: "Назначение", items: [{ id: "TZ-1", title: "Имя", atoms: [
      atom("STALE", "done", "done", "prototype", { color: "yellow", why: "текст атома изменён после снимка аудита" }),
      atom("FRESH", "done", "done", "prototype", { color: "green", why: "подтверждено" }),
    ] }] }],
  };
  const audit = { atoms: {
    STALE: { verdict: "REAL", uncertain: false, evidence: "старый снимок" },
    FRESH: { verdict: "REAL", uncertain: false, evidence: "текущий снимок" },
  } };
  const s = coverage(dzChanged, audit).sections[0];
  assert.deepEqual(s.open.map((o) => [o.id, o.why]), [["STALE", "текст атома изменён после снимка аудита"]]);
});

test("без аудита — прежнее поведение: подтверждённых 0, открыто только непокрытое трассой", () => {
  const c = coverage(dz);
  assert.equal(c.audit, null);
  assert.equal(c.total.real, 0);
  assert.deepEqual(c.sections.find((x) => x.id === "S9.1").open.map((o) => o.id), ["A3"]);
});
