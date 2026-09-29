// Мост оценки T-176: строки извлечения, полученные ML из фраз набора (ml/eval/t176_eval.py), → настоящее сравнение
// видов category (CMP-05) и layers (CMP-21) из реестра видов (T-186) с паспортом или частью паспорта и строкой Матрицы.
// Вход — JSONL {id, code, part, rows}, выход — JSONL {id, status, expected, actual, reason}.
// Запуск: npx tsx scripts/subst-layers-eval.ts <in.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalogsFile, setFamilies } from "../src/domain/analogs.ts";
import { ParamPassport } from "../src/domain/passport.ts";
import { kindMentions, kindOf, type KindPassport, type KindRow } from "../src/domain/param-kinds.ts";
import type { Param } from "../src/domain/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: subst-layers-eval.ts <in.jsonl> <out.jsonl>");
setFamilies(AnalogsFile.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/analogs.json"), "utf8"))).families);
const matrix = new Map((JSON.parse(readFileSync(join(ROOT, "data/seed/matrix.json"), "utf8")) as Array<Record<string, any>>).map((p) => [p.code as string, p]));
const param = (code: string): Param => {
  const p = matrix.get(code)!;
  return {
    code, section: p.section, parameter_name: p.parameter_name, unit: p.unit ?? "", source_pd: p.source_pd, source_rd: p.source_rd, source_id: p.source_id,
    trigger_logic: p.trigger_logic ?? "", review_priority: p.review_priority ?? "MEDIUM", data_type: p.data_type, compare: p.compare, anchors: p.anchors,
    regex_pattern: p.regex_pattern ?? null, value_scale: p.value_scale ?? null, applicability: p.applicability ?? null, is_active: true,
  };
};
const slice = (code: string, part: string | null): KindPassport => {
  if (!part) {
    const pp = ParamPassport.parse(JSON.parse(readFileSync(join(ROOT, `data/seed/passports/${code}.json`), "utf8")));
    return { value: pp.value, extractor: pp.extractor, sources: pp.sources, link: pp.link, basis: pp.basis };
  }
  const raw = JSON.parse(readFileSync(join(ROOT, `data/seed/passports/parts/${code}.${part}.json`), "utf8"));
  return { value: ParamPassport.shape.value.parse(raw.value), extractor: ParamPassport.shape.extractor.parse(raw.extractor), sources: raw.sources, link: raw.link, basis: raw.basis };
};

const out: string[] = [];
for (const line of readFileSync(inFile, "utf8").split("\n").filter(Boolean)) {
  const x = JSON.parse(line) as { id: string; code: string; part: string | null; rows: KindRow[] };
  const kp = slice(x.code, x.part);
  const kd = kindOf(kp.value.kind)!;
  const ev = kd.evaluate({ param: param(x.code), passport: kp, mentions: kindMentions(kd, x.rows), loadedStages: ["PD", "RD"], profile: {}, kitBases: new Set(["100"]), pdKitPresent: false });
  out.push(JSON.stringify({ id: x.id, status: ev.status, expected: ev.expected, actual: ev.actual, reason: ev.reason }));
}
writeFileSync(outFile, out.join("\n") + "\n");
