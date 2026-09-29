// Честный цвет реализации ТЗ (T-164): цвет атома по коду трассы и вердикту критиков, свёртка по пункту.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggColor, atomColor, colorCounts } from "./tz-color.mjs";

const atom = (code, extra = {}) => ({ id: "A", code, scope: "prototype", trace: ["OS-1.1.1"], ...extra });
const REAL = { verdict: "REAL", uncertain: false };

test("зелёный — только код по всей трассе и вердикт критиков REAL без сомнений", () => {
  assert.equal(atomColor(atom("done"), REAL, ["OS-1.1.1"]).color, "green");
  assert.equal(atomColor(atom("done"), { verdict: "REAL", uncertain: true }).color, "yellow");
  assert.equal(atomColor(atom("done"), { verdict: "WEAK_TEST", uncertain: false }).color, "yellow");
  assert.equal(atomColor(atom("done"), null).color, "yellow", "без аудита — не зелёный");
  assert.equal(atomColor(atom("done", { partial: true, note: "без УКЭП" }), REAL).color, "yellow");
  assert.match(atomColor(atom("done", { partial: true, note: "без УКЭП" }), REAL).why, /без УКЭП/);
});

test("трасса изменена после аудита: REAL устарел и не зеленит; «не реализовано» держится до повторного аудита", () => {
  const moved = atom("done", { trace: ["OS-1.1.2"] });
  assert.equal(atomColor(moved, REAL, ["OS-1.1.1"]).color, "yellow");
  assert.match(atomColor(moved, REAL, ["OS-1.1.1"]).why, /повторный аудит/);
  const ni = { verdict: "NOT_IMPLEMENTED", uncertain: false };
  assert.equal(atomColor(moved, ni, ["OS-1.1.1"]).color, "red");
  assert.match(atomColor(moved, ni, ["OS-1.1.1"]).why, /повторный аудит/);
  assert.doesNotMatch(atomColor(atom("done"), ni, ["OS-1.1.1"]).why, /повторный/);
  assert.equal(atomColor({ ...moved, scope: "gpu" }, ni, ["OS-1.1.1"]).color, "red", "вне прототипа — тоже не синий");
  // снимок { trace, t, accept }: изменённый текст или критерий тоже делает вердикт устаревшим
  const snap = { trace: ["OS-1.1.1"], t: "старый", accept: "старый" };
  assert.equal(atomColor(atom("done", { t: "старый", accept: "старый" }), REAL, snap).color, "green");
  assert.equal(atomColor(atom("done", { t: "новый", accept: "старый" }), REAL, snap).color, "yellow");
  assert.equal(atomColor(atom("done", { t: "старый", accept: "новый" }), REAL, snap).color, "yellow");
  // порядок ссылок в трассе не важен
  assert.equal(atomColor(atom("done", { trace: ["B", "A"] }), REAL, ["A", "B"]).color, "green");
});

test("красный — кода нет или критики установили, что код не делает требуемого, в том числе вне прототипа", () => {
  assert.equal(atomColor(atom("none")).color, "red");
  assert.equal(atomColor(atom("none", { scope: "prod" })).color, "red");
  assert.match(atomColor(atom("none", { trace: [] })).why, /ни во что не разложен/);
  assert.equal(atomColor(atom("done"), { verdict: "NOT_IMPLEMENTED", uncertain: false }, ["OS-1.1.1"]).color, "red");
  assert.equal(atomColor(atom("done"), { verdict: "NOT_IMPLEMENTED", uncertain: true }, ["OS-1.1.1"]).color, "yellow", "спорное «не реализовано» — жёлтый");
});

test("синий — вне прототипа с готовым кодом; код готов не весь — жёлтый", () => {
  assert.equal(atomColor(atom("done", { scope: "gpu" }), { verdict: "WEAK_TEST" }).color, "blue");
  assert.match(atomColor(atom("done", { scope: "prod" })).why, /эксплуатационном контуре/);
  assert.equal(atomColor(atom("partial", { scope: "gpu" })).color, "yellow");
});

test("свёртка: зелёный и красный — только если все такие; готово с частью на стенде — синий; серое не в счёт", () => {
  assert.equal(aggColor(["green", "green", "grey"]), "green");
  assert.equal(aggColor(["red", "red"]), "red");
  assert.equal(aggColor(["green", "red"]), "yellow");
  assert.equal(aggColor(["green", "blue"]), "blue");
  assert.equal(aggColor(["blue", "yellow"]), "yellow");
  assert.equal(aggColor([]), "grey");
  assert.deepEqual(colorCounts(["green", "red", "red"]), { green: 1, yellow: 0, red: 2, blue: 0, grey: 0 });
});
