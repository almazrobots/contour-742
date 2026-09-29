// Строка качества CMP-04 / CMP-26 на синтетическом стенде T-172 (ml/eval/class_scales_bench.py → cases.jsonl):
// каждая пара проходит настоящий evaluateClassParam по паспорту параметра; CANDIDATE — срабатывание.
// Воздержание — MISSING_EVIDENCE, NOT_COMPARABLE, CLARIFICATION_REQUIRED (каталог §15.3, план W1 «Таблица качества»).
//   npx tsx scripts/class-scales-eval.ts ../../var/class-scales/cases.jsonl [--json out.json] [--path main]
// --path main (правило включения паспорта): тот же набор путём main — значение стадии из поля doc.main
// (ml/eval/class_scales_main.py, лексический extract без паспортов W1), сравнение — лексический evaluate из compare.ts
// с параметром из базы main (Матрица и миграции, value_scale как в main).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateClassParam, type Mention } from "../src/domain/class-param.ts";
import { classPassport } from "../src/domain/passport.ts";
import { passportFor } from "../src/services/passports.ts";
import type { Param, Stage, StageValue } from "../src/domain/types.ts";
import { evaluate } from "../src/domain/compare.ts";
import { openDb } from "../src/db.ts";
import { loadParams } from "../src/services/inspections.ts";

const ABSTAIN = new Set(["MISSING_EVIDENCE", "NOT_COMPARABLE", "CLARIFICATION_REQUIRED"]);
const [file, ...rest] = process.argv.slice(2);
const jsonOut = rest[rest.indexOf("--json") + 1] && rest.includes("--json") ? rest[rest.indexOf("--json") + 1] : null;
const pathMain = rest.includes("--path") && rest[rest.indexOf("--path") + 1] === "main";
const dbParams = pathMain ? await (async () => { const db = await openDb("memory"); const ps = await loadParams(db, false); await db.close(); return new Map(ps.map((p) => [p.code, p])); })() : null;
const matrix = JSON.parse(readFileSync(join(import.meta.dirname, "../../../data/seed/matrix.json"), "utf8")) as Array<Record<string, any>>;

interface Row { tp: number; fp: number; fn: number; tn: number; abstPos: number; abstNeg: number; kinds: Record<string, { n: number; hit: number; abst: number }>; misses: string[] }
const rows = new Map<string, Row>();

for (const text of readFileSync(file, "utf8").split("\n")) {
  if (!text.trim()) continue;
  const c = JSON.parse(text);
  const m = matrix.find((x) => x.code === c.param)!;
  const param: Param = { ...(m as any), unit: m.unit ?? "", trigger_logic: m.trigger_logic ?? "", compare: m.compare ?? { kind: "decrease" }, anchors: m.anchors ?? [], value_scale: null, applicability: null, is_active: true };
  const stagesMain = [...new Set(c.docs.map((d: any) => d.stage))] as Stage[];
  const e = pathMain ? evalMain(c, stagesMain) : evalPassport(c, param);
  const r = rows.get(c.param) ?? { tp: 0, fp: 0, fn: 0, tn: 0, abstPos: 0, abstNeg: 0, kinds: {}, misses: [] };
  score(c, e, r);
}

function evalMain(c: any, stages: Stage[]) {
  // как main: один источник на стадию, SUPERSEDED в сравнение не идёт
  const values: StageValue[] = c.docs.flatMap((d: any, di: number) =>
    d.main && d.role !== "SUPERSEDED"
      ? [{ stage: d.stage, num: d.main.value_num, text: d.main.value_text, raw: d.main.raw ?? "", source: { file_id: `f${di}`, sha256: String(di).padStart(64, "0"), stage: d.stage, document_code: d.document_code, revision: "1", approval_status: d.stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", page: d.main.page, bbox: d.main.bbox, role: "CURRENT" } }]
      : [],
  );
  const seen = new Set<Stage>();
  const one = values.filter((v) => (seen.has(v.stage) ? false : (seen.add(v.stage), true)));
  return evaluate({ param: dbParams!.get(c.param)!, profile: {}, values: one, loadedStages: stages });
}

function evalPassport(c: any, param: Param) {
  const cp = classPassport(passportFor(c.param)!)!;
  let k = 0;
  const mentions: Mention[] = c.docs.flatMap((d: any, di: number) =>
    d.mentions.map((x: any): Mention => ({
      stage: d.stage as Stage, file_id: `f${di}`, sha256: String(di).padStart(64, "0"), document_code: d.document_code, revision: d.role === "SUPERSEDED" ? "0" : "1",
      approval_status: d.stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role: d.role, discipline: d.discipline, base: "2099-01-001",
      value: x.value, qualifier: x.qualifier === "min" ? "min" : null, element: x.element ?? null, excluded: x.excluded, excluded_why: x.excluded_why,
      page: x.page + k++ * 0, bbox: x.bbox, quote: x.quote, confidence: x.confidence,
    })),
  );
  const stages = [...new Set(c.docs.map((d: any) => d.stage))] as Stage[];
  return evaluateClassParam({ param, passport: cp, mentions, loadedStages: stages, profile: {} });
}

function score(c: any, e: { status: string; reason: string; delta: string | null }, r: Row) {
  rows.set(c.param, r);
  const kd = (r.kinds[c.kind] ??= { n: 0, hit: 0, abst: 0 });
  kd.n++;
  const abst = ABSTAIN.has(e.status);
  const fired = e.status === "CANDIDATE";
  if (abst) kd.abst++;
  if (fired) kd.hit++;
  if (c.label === 1) {
    if (fired) r.tp++;
    else {
      r.fn++;
      if (abst) r.abstPos++;
      if (r.misses.filter((x) => !x.includes(": ложное")).length < 30) r.misses.push(`${c.id}: ${e.status} ${e.reason} ‖ ${c.docs.map((d: any) => d.mentions.map((m: any) => `${d.stage}:${m.value}${m.element ? "@" + m.element : ""}${m.excluded ? "✗" : ""}`).join(" ")).join(" / ")}`);
    }
  } else if (fired) {
    r.fp++;
    if (r.misses.filter((x) => x.includes(": ложное")).length < 30) r.misses.push(`${c.id}: ложное ${e.delta} ${e.reason}`);
  } else {
    r.tn++;
    if (abst) r.abstNeg++;
  }
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
/** 95 % ДИ Уилсона для доли k из n (OS-INSP-6.5.10). */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [Number.NaN, Number.NaN];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const ci = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return `${f3(k / n)} [${f3(lo)}; ${f3(hi)}]`;
};
const out: Record<string, unknown> = {};
const sum = { tp: 0, fp: 0, fn: 0, tn: 0, abst: 0 };
console.log("| код | n+ | n− | P [95 % ДИ] | R [95 % ДИ] | F1 | FPR [95 % ДИ] | воздержания |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [code, r] of [...rows].sort()) {
  const np = r.tp + r.fn;
  const nn = r.fp + r.tn;
  const p = r.tp / (r.tp + r.fp);
  const rc = r.tp / np;
  const f1 = (2 * p * rc) / (p + rc);
  const fpr = r.fp / nn;
  const ab = (r.abstPos + r.abstNeg) / (np + nn);
  for (const [k, v] of Object.entries({ tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, abst: r.abstPos + r.abstNeg })) sum[k as keyof typeof sum] += v;
  out[code] = { n_pos: np, n_neg: nn, tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, precision: p, recall: rc, f1, fpr, abstain: ab, kinds: r.kinds, misses: r.misses };
  console.log(`| ${code} | ${np} | ${nn} | ${ci(r.tp, r.tp + r.fp)} | ${ci(r.tp, np)} | ${f3(f1)} | ${ci(r.fp, nn)} | ${f3(ab)} |`);
}
const P = sum.tp / (sum.tp + sum.fp);
const R = sum.tp / (sum.tp + sum.fn);
console.log(`| **CMP-04 сводно** | ${sum.tp + sum.fn} | ${sum.fp + sum.tn} | ${ci(sum.tp, sum.tp + sum.fp)} | ${ci(sum.tp, sum.tp + sum.fn)} | ${f3((2 * P * R) / (P + R))} | ${ci(sum.fp, sum.fp + sum.tn)} | ${f3(sum.abst / (sum.tp + sum.fp + sum.fn + sum.tn))} |`);
for (const [code, r] of rows) for (const m of r.misses) console.error(`${code}  ${m}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ schema: "inspector-class-quality/1", source: file, params: out, total: sum }, null, 1) + "\n");
