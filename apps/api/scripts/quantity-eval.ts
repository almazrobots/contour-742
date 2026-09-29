// Мост оценки T-173: упоминания, извлечённые ML из фраз набора (ml/eval/t173_eval.py), → настоящее сравнение
// evaluateQuantityParam с паспортом и строкой Матрицы. Вход — JSONL {id, code, mentions}, выход — JSONL {id, status, ...}.
// Запуск: pnpm --filter ./apps/api exec tsx scripts/quantity-eval.ts <in.jsonl> <out.jsonl>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ParamPassport, quantityPassport } from "../src/domain/passport.ts";
import { evaluateQuantityParam, type QuantityMention } from "../src/domain/quantity-param.ts";
import type { Param } from "../src/domain/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: quantity-eval.ts <in.jsonl> <out.jsonl>");

const dir = join(ROOT, "data/seed/passports");
const passports = new Map(readdirSync(dir).filter((f) => /^M-\d{3}\.json$/.test(f)).map((f) => {
  const pp = ParamPassport.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
  return [pp.code, pp] as const;
}));
const matrix = new Map((JSON.parse(readFileSync(join(ROOT, "data/seed/matrix.json"), "utf8")) as Array<Record<string, any>>).map((p) => [p.code as string, p]));
const param = (code: string): Param => {
  const p = matrix.get(code)!;
  return {
    code, section: p.section, parameter_name: p.parameter_name, unit: p.unit ?? "", source_pd: p.source_pd, source_rd: p.source_rd, source_id: p.source_id,
    trigger_logic: p.trigger_logic ?? "", review_priority: p.review_priority ?? "MEDIUM", data_type: p.data_type, compare: p.compare, anchors: p.anchors,
    regex_pattern: p.regex_pattern ?? null, value_scale: p.value_scale ?? null, applicability: p.applicability ?? null, is_active: true,
  };
};

const out: string[] = [];
for (const line of readFileSync(inFile, "utf8").split("\n").filter(Boolean)) {
  const x = JSON.parse(line) as { id: string; code: string; mentions: QuantityMention[] };
  const qp = quantityPassport(passports.get(x.code)!)!;
  const ev = evaluateQuantityParam({ param: param(x.code), passport: qp, mentions: x.mentions, loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set(["100"]) });
  out.push(JSON.stringify({ id: x.id, status: ev.status, expected: ev.expected, actual: ev.actual, reason: ev.reason }));
}
writeFileSync(outFile, out.join("\n") + "\n");
