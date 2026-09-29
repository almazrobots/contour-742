// Мост отложенного набора W3 (T-210, OS-INSP-6.5.70): упоминания, извлечённые ML из документов случая (ml/eval/w3_eval.py),
// → настоящий оценщик домена по value.kind паспорта. Вход — JSONL {id, code, mentions, loadedStages}, выход — JSONL
// {id, status, expected, actual, reason}. Вида, которого нет в EVALUATORS (ветки W3 ещё не влиты), — status SKIPPED_NO_KIND.
// Запуск: pnpm --filter ./apps/api exec tsx scripts/w3-eval.ts <in.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ParamPassport, quantityPassport } from "../src/domain/passport.ts";
import { evaluateQuantityParam, type QuantityMention } from "../src/domain/quantity-param.ts";
import { directionPassport, evaluateDirectionParam, type DirectionMention } from "../src/domain/direction-param.ts";
import { evaluatePresenceParam, presencePassport, type PresenceMention } from "../src/domain/presence-param.ts";
import type { Evaluation, Param, Stage } from "../src/domain/types.ts";
import { docReqPassportOf } from "../src/domain/kinds/doc-requirements.ts";
import { schedulePassportOf } from "../src/domain/kinds/schedule.ts";
import { kindSlice } from "../src/domain/param-kinds.ts";
import { evaluateSchedule, type ScheduleRow } from "../src/domain/stage-schedule.ts";
import { evaluateDocRequirements, type DocReqMention } from "../src/domain/doc-requirements.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: w3-eval.ts <in.jsonl> <out.jsonl>");

// kitBases — базовые шифры РД пакета (замер на корпусе, w3-registry.ts); нет — один синтетический комплект «100»
interface Row { id: string; code: string; mentions: unknown[]; loadedStages: Stage[]; kitBases?: string[] }
type Evaluator = (x: Row, pp: ParamPassport, param: Param) => Evaluation;

// Оценщики по value.kind паспорта. Ветки W3 (presence, schedule, direction) регистрируют здесь свой вид при интеграции.
const EVALUATORS: Record<string, Evaluator> = {
  quantity: (x, pp, param) =>
    evaluateQuantityParam({ param, passport: quantityPassport(pp)!, mentions: x.mentions as QuantityMention[], loadedStages: x.loadedStages, profile: {}, kitBases: new Set(x.kitBases ?? ["100"]) }),
  // T-214: направление открывания эвакуационных дверей (М-043, М-106)
  direction: (x, pp, param) => evaluateDirectionParam({ param, passport: directionPassport(pp)!, mentions: x.mentions as DirectionMention[], loadedStages: x.loadedStages, profile: {} }),
  // T-213: календарный график (М-082, М-087) и перечень ИД с сечениями (М-096)
  schedule: (x, pp, param) => evaluateSchedule({ param, passport: schedulePassportOf(kindSlice(pp)), rows: x.mentions as ScheduleRow[], loadedStages: x.loadedStages, profile: {} }),
  doc_requirements: (x, pp, param) => evaluateDocRequirements({ param, passport: docReqPassportOf(kindSlice(pp)), mentions: x.mentions as DocReqMention[], loadedStages: x.loadedStages, profile: {} }),
  // T-212 (feat/w3-presence): мероприятие (CMP-09) и метод (CMP-23) — один оценщик
  presence: (x, pp, param) => evaluatePresenceParam({ param, passport: presencePassport(pp)!, mentions: x.mentions as PresenceMention[], loadedStages: x.loadedStages, profile: {}, kitBases: new Set(x.kitBases ?? ["100"]) }),
  method: (x, pp, param) => evaluatePresenceParam({ param, passport: presencePassport(pp)!, mentions: x.mentions as PresenceMention[], loadedStages: x.loadedStages, profile: {}, kitBases: new Set(x.kitBases ?? ["100"]) }),
};

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
  const x = JSON.parse(line) as Row;
  // сначала вид по сырому паспорту: паспорт нового вида схема этой ветки может ещё не знать
  const raw = JSON.parse(readFileSync(join(ROOT, "data/seed/passports", `${x.code}.json`), "utf8"));
  const ev = EVALUATORS[raw?.value?.kind];
  if (!ev) {
    out.push(JSON.stringify({ id: x.id, status: "SKIPPED_NO_KIND", expected: null, actual: null, reason: `вид «${raw?.value?.kind}» не зарегистрирован` }));
    continue;
  }
  const r = ev(x, ParamPassport.parse(raw), param(x.code));
  out.push(JSON.stringify({ id: x.id, status: r.status, expected: r.expected, actual: r.actual, reason: r.reason }));
}
writeFileSync(outFile, out.join("\n") + "\n");
