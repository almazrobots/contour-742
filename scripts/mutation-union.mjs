#!/usr/bin/env node
// Объединённый мутационный скор адаптера, работающего на двух движках (T-107, ADR-0003): src/db.ts исполняет одну
// половину на PGlite, другую — на сервере PostgreSQL. Прогон Stryker на одном движке честно видит вторую половину
// «без покрытия». Мутант один и тот же (файл, место, оператор, замена) — убит, если его убил хотя бы один движок.
//   node scripts/mutation-union.mjs <отчёт-pglite.json> <отчёт-сервер.json>
// Отчёты — формат mutation-testing-report-schema (incremental-*.json или json-репортёр Stryker).
import { readFileSync } from "node:fs";

const KILLED = new Set(["Killed", "Timeout"]);
const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("использование: mutation-union.mjs <отчёт-1.json> <отчёт-2.json>");
  process.exit(2);
}

const key = (file, m) => `${file}|${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}|${m.mutatorName}|${m.replacement ?? ""}`;

function load(path) {
  const r = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map();
  for (const [file, f] of Object.entries(r.files)) for (const m of f.mutants) out.set(key(file, m), m.status);
  return out;
}

const ra = load(a);
const rb = load(b);
const keys = new Set([...ra.keys(), ...rb.keys()]);
const tally = { total: 0, killed: 0, survived: 0, noCoverage: 0, other: 0 };
const survivors = [];
for (const k of keys) {
  tally.total++;
  const s = [ra.get(k), rb.get(k)];
  if (s.some((x) => KILLED.has(x))) tally.killed++;
  else if (s.some((x) => x === "Survived")) {
    tally.survived++;
    survivors.push(k);
  } else if (s.every((x) => x === "NoCoverage" || x === undefined)) tally.noCoverage++;
  else tally.other++;
}
const covered = tally.total - tally.noCoverage - tally.other;
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) : "—");
console.log(`мутантов ${tally.total}: убито ${tally.killed}, выжило ${tally.survived}, без покрытия ни на одном движке ${tally.noCoverage}, прочее ${tally.other}`);
console.log(`скор объединённый: ${pct(tally.killed, tally.total)} % от всех, ${pct(tally.killed, covered)} % от покрытых`);
if (survivors.length) console.log("выжившие:\n" + survivors.map((s) => "  " + s).join("\n"));
