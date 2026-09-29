// Паспорта параметров (T-129): чтение data/seed/passports/*.json, паспорт для экрана и метрики параметра из базы.
// Паспорт — справочник (DO-PASSPORT): читается при первом обращении и проверяется схемой; битый паспорт — громкий отказ.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { CommonPassport, mergeStages, metricRows, ParamPassport, resolveScaleRef, ScalesFile, type OpsCatalog } from "../domain/passport.ts";
import { STAGES, type Stage } from "../domain/types.ts";
import { assertKnownKinds } from "../domain/param-kinds.ts";
import { AnalogsFile, familyOf, setFamilies } from "../domain/analogs.ts";
import { realObjectSql } from "../domain/synthetic.ts";

interface Store {
  common: CommonPassport;
  byCode: Map<string, ParamPassport>;
  catalog: OpsCatalog;
}
let store: Store | null = null;

export function passports(): Store {
  if (store) return store;
  const dir = join(config.root, "data/seed/passports");
  const common = CommonPassport.parse(JSON.parse(readFileSync(join(dir, "_common.json"), "utf8")));
  // T-176 (OS-INSP-3.1.60): справочник канона и аналогов — семейства для видов category и layers
  const aFile = join(config.root, "data/seed/analogs.json");
  setFamilies(existsSync(aFile) ? AnalogsFile.parse(JSON.parse(readFileSync(aFile, "utf8"))).families : {});
  const byCode = new Map<string, ParamPassport>();
  // T-172: шкалы классов — справочник (OS-INSP-3.1.30); паспорт ссылается на него полем value.scale_ref
  const scalesFile = join(config.root, "data/seed/scales.json");
  const scales = existsSync(scalesFile) ? ScalesFile.parse(JSON.parse(readFileSync(scalesFile, "utf8"))) : { scales: {} };
  for (const f of readdirSync(dir).filter((x) => /^M-\d{3}\.json$/.test(x))) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    assertKnownKinds(raw, `паспорт ${f}`); // T-186: незнакомый вид — ошибка с его именем
    const pp = ParamPassport.parse(resolveScaleRef(raw, scales));
    if (`${pp.code}.json` !== f) throw new Error(`паспорт ${f}: код внутри файла ${pp.code}`);
    const fam = (pp.value as { family?: unknown }).family;
    if (typeof fam === "string") familyOf(fam, pp.code); // семейства нет в справочнике — громкий отказ загрузки
    byCode.set(pp.code, pp);
  }
  const catFile = join(config.root, "data/seed/catalog-ops.json");
  const catalog = existsSync(catFile) ? (JSON.parse(readFileSync(catFile, "utf8")).ops as OpsCatalog) : {};
  // проверка ссылок на операции каталога — при загрузке, а не при первом показе паспорта
  mergeStages(common, null, catalog);
  for (const pp of byCode.values()) mergeStages(common, pp, catalog);
  store = { common, byCode, catalog };
  return store;
}

export const passportFor = (code: string): ParamPassport | null => passports().byCode.get(code) ?? null;

export function resetPassportsForTests(): void {
  store = null;
}

/** Паспорт параметра для экрана (OS-INSP-7.1.3–7.1.6). null — параметра нет в Матрице. */
export async function passportView(db: DB, code: string) {
  const row = await db.get<Record<string, any>>("select * from params where code = $1", [code]);
  if (!row) return null;
  const { common, catalog } = passports();
  const pp = passportFor(code);
  const { compare_json, anchors_json, value_scale_json, ...rest } = row;
  const param = { ...rest, compare: JSON.parse(compare_json), anchors: JSON.parse(anchors_json), value_scale: value_scale_json ? JSON.parse(value_scale_json) : null };

  const checks = await db.all<{ finding_status: string; verification_status: string; stage_notes_json: string | null }>(
    // OS-INSP-7.1.7 (T-148): метрики — только по реальным объектам, синтетика их не завышает
    `select c.finding_status, c.verification_status, c.stage_notes_json from checks c join inspections i on i.id = c.inspection_id join objects o on o.id = i.object_id
      where c.param_code = $1 and c.parent_id is null and ${realObjectSql("o")}`,
    [code],
  );
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
  const coverage = Object.fromEntries(STAGES.map((s) => [s, { used: 0, loaded: 0 }])) as Record<Stage, { used: number; loaded: number }>;
  for (const c of checks) {
    const notes = c.stage_notes_json ? (JSON.parse(c.stage_notes_json) as Partial<Record<Stage, string>>) : {};
    for (const s of STAGES) {
      if (!notes[s] || notes[s] === "NOT_APPLICABLE") continue;
      coverage[s].loaded++;
      if (notes[s] === "USED") coverage[s].used++;
    }
  }
  const conf = await db.get<{ c: number | null }>(
    `select avg(e.confidence) c from extractions e join files f on f.id = e.file_id join objects o on o.id = f.object_id
      where e.param_code = $1 and e.kind = 'param' and (e.meta_json is null or (e.meta_json->>'excluded') is null) and ${realObjectSql("o")}`,
    [code],
  );
  const ver = await db.get<Record<string, any>>("select * from param_verifications where param_code = $1 order by checked_at desc, id desc limit 1", [code]);
  const verification = ver
    ? { verdict: ver.verdict as "MATCH" | "MISMATCH", object_id: ver.object_id as string | null, inspection_id: ver.inspection_id as string | null, method: ver.method as string, checked_at: new Date(ver.checked_at).toISOString(), fields: JSON.parse(ver.fields_json) }
    : null;
  const metrics = metricRows(common, {
    checks: checks.length,
    statuses: count(checks.map((c) => c.finding_status)),
    decisions: count(checks.map((c) => c.verification_status)),
    coverage,
    confidence: conf?.c === null || conf?.c === undefined ? null : Number(conf.c),
    verification,
  });
  return {
    code,
    param,
    passport: pp ? { version: pp.version, title: pp.title, summary: pp.summary, basis: pp.basis, value: pp.value, sources: pp.sources, link: pp.link, outcomes: pp.outcomes } : null,
    stages: mergeStages(common, pp, catalog),
    statuses: common.statuses,
    metrics,
    verification,
  };
}

/** T-234: какие паспорта ссылаются на запись Normative_Base (value.norm.ref) — код параметра → norm_key. */
export function passportNormRefs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [code, pp] of passports().byCode) {
    const ref = (pp.value as { norm?: { ref?: unknown } }).norm?.ref;
    if (typeof ref === "string") out.set(code, ref);
  }
  return out;
}
