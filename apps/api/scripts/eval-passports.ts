// Мост стенда оценки §14 (ml/eval/run.py) к путям сравнения API по паспорту (T-233): тот же выбор упоминаний и та же
// оценка, что в recompute() (services/inspections.ts), но без базы — строки извлечения приходят из ML напрямую.
// Стенд раньше читал все параметры лексическим путём и решал их зеркалом на Python (decide.py); параметр с паспортом
// вида (направление, мероприятие, метод, количество с единицей) лексикой не читается вовсе — его строка синтетики
// написана формой паспорта. Здесь — только путь паспорта; параметры без паспорта стенд решает как прежде.
//   specs <out.json>              — {код: {value_kind, spec}} для параметров с паспортом видов из PASSPORT_KINDS: spec — то,
//                                   что API кладёт в ParamSpec.extractor при /analyze (extractorSpec)
//   eval <in.jsonl> <out.jsonl>   — вход: {id, code, rows, files, loadedStages, profile}; выход: {id, status, fragments}
// Запуск: cd apps/api && npx tsx scripts/eval-passports.ts specs|eval …
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { parseDocName } from "../src/domain/cipher.ts";
import { inPassportSources, mentionTrace } from "../src/domain/class-param.ts";
import { extractorSpec, quantityPassport } from "../src/domain/passport.ts";
import { disciplineKey, kindMentions, kindOf, kindSlice, type KindRow } from "../src/domain/param-kinds.ts";
import { evaluateQuantityParam, quantityMeta, type QuantityMention } from "../src/domain/quantity-param.ts";
import type { Param, Stage } from "../src/domain/types.ts";
import { passports } from "../src/services/passports.ts";

/** Виды значения, которые стенд решает путём паспорта. Остальные (ordinal, geometry, count…) — как прежде, лексикой. */
const PASSPORT_KINDS = new Set(["quantity", "direction", "presence", "method"]);

interface Row {
  id: string;
  code: string;
  rows: Array<KindRow & { revision_role: KindRow["revision_role"] }>;
  files: Array<{ doc_stage: Stage; document_code: string | null; file_name: string }>;
  loadedStages: Stage[];
  profile: Record<string, boolean>;
}

const matrix = new Map((JSON.parse(readFileSync(join(config.root, "data/seed/matrix.json"), "utf8")) as Array<Record<string, any>>).map((p) => [p.code as string, p]));
const paramOf = (code: string): Param => {
  const p = matrix.get(code)!;
  return {
    code, section: p.section, parameter_name: p.parameter_name, unit: p.unit ?? "", source_pd: p.source_pd, source_rd: p.source_rd, source_id: p.source_id,
    trigger_logic: p.trigger_logic ?? "", review_priority: p.review_priority ?? "MEDIUM", data_type: p.data_type, compare: p.compare, anchors: p.anchors,
    regex_pattern: p.regex_pattern ?? null, value_scale: p.value_scale ?? null, applicability: p.applicability ?? null, is_active: true,
  };
};

const [mode, a, b] = process.argv.slice(2);
if (mode === "specs" && a) {
  const out: Record<string, { value_kind: string; spec: Record<string, unknown> }> = {};
  for (const pp of passports().byCode.values()) if (PASSPORT_KINDS.has(pp.value.kind) && matrix.has(pp.code)) out[pp.code] = { value_kind: pp.value.kind, spec: extractorSpec(pp) };
  writeFileSync(a, JSON.stringify(out));
} else if (mode === "eval" && a && b) {
  const out: string[] = [];
  for (const line of readFileSync(a, "utf8").split("\n").filter(Boolean)) {
    const x = JSON.parse(line) as Row;
    const pp = passports().byCode.get(x.code);
    if (!pp) throw new Error(`нет паспорта ${x.code}`);
    const p = paramOf(x.code);
    // OS-INSP-3.1.18 (LNK-01): комплект — по базовому шифру документов РД пакета; ПД комплекта есть, если его шифр среди них
    const baseOf = (f: Row["files"][number]) => parseDocName(f.document_code || f.file_name).base;
    const kitBases = new Set(x.files.filter((f) => f.doc_stage === "RD").map(baseOf).filter((v): v is string => Boolean(v)));
    const pdKitPresent = x.files.filter((f) => f.doc_stage === "PD").some((f) => kitBases.has(baseOf(f) ?? ""));
    // как recompute(): устаревшие редакции не участвуют; строгий источник по разделам паспорта (T-233)
    const rows = x.rows
      .filter((r) => r.revision_role !== "SUPERSEDED")
      .filter((r) => inPassportSources(pp.sources, r.doc_stage, disciplineKey(r.discipline) ?? disciplineKey(parseDocName(r.document_code).discipline)));
    const qp = quantityPassport(pp);
    let ev;
    if (qp) {
      const mentions: QuantityMention[] = rows
        .filter((r) => r.value_num !== null)
        .map((r) => {
          const meta = r.meta_json ? JSON.parse(r.meta_json) : {};
          const name = parseDocName(r.document_code);
          return {
            stage: r.doc_stage, file_id: r.file_id, sha256: r.sha256, document_code: r.document_code, revision: r.revision, approval_status: r.approval_status,
            role: r.revision_role, discipline: disciplineKey(r.discipline) ?? disciplineKey(name.discipline), base: name.base, num: r.value_num!,
            excluded: typeof meta.excluded === "string" ? meta.excluded : null, excluded_why: typeof meta.excluded_why === "string" ? meta.excluded_why : null,
            page: r.page, bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null, anchor_bbox: r.anchor_bbox_json ? JSON.parse(r.anchor_bbox_json) : null,
            quote: meta.quote ?? r.line_text ?? "", confidence: r.confidence ?? 0,
            ...quantityMeta(meta),
            ...mentionTrace(meta),
          };
        });
      ev = evaluateQuantityParam({ param: p, passport: qp, mentions, loadedStages: x.loadedStages, profile: x.profile, kitBases, pdKitPresent });
    } else {
      const kd = kindOf(pp.value.kind, pp.code);
      if (!kd) throw new Error(`вид ${pp.value.kind} не из реестра: ${x.code}`);
      ev = kd.evaluate({ param: p, passport: kindSlice(pp), mentions: kindMentions(kd, rows), loadedStages: x.loadedStages, profile: x.profile, kitBases, pdKitPresent });
    }
    out.push(JSON.stringify({
      id: x.id,
      status: ev.status,
      reason: ev.reason,
      fragments: ev.fragments.map((f) => ({ file_id: f.file_id, page: f.page, bbox: f.bbox, stage: f.stage, document_code: f.document_code, revision: f.revision })),
    }));
  }
  writeFileSync(b, out.join("\n") + "\n");
} else throw new Error("usage: eval-passports.ts specs <out.json> | eval <in.jsonl> <out.jsonl>");
