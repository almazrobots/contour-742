// Эшелоны: L2 (сквозной пересчёт против ожидаемого ответа синтетического объекта), L6 (строки части не попадают в
// основной путь, противоречие внутри стадии). CMP-05 и CMP-21 — виды из реестра (T-186) в пересчёте протокола
// (OS-INSP-3.1.60–3.1.69): упоминания из базы → паспорт → оператор → доказательная группа. Без ML-сервиса: упоминания
// пишутся в extractions так, как их вернул бы /analyze (ключ лексического значения латинизирован: «PN 16» → «PN16»). T-176.
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { createInspection, recompute, type Ctx } from "../src/services/inspections.ts";
import { setMlPost } from "../src/services/norms.ts";
import { resetPassportsForTests } from "../src/services/passports.ts";

let db: DB;
let ctx: Ctx;
let seq = 0;

type Ex = { code: string; value: string; meta: Record<string, unknown>; page?: number };
async function file(insp: string, stage: "PD" | "RD", code: string, discipline: string, xs: Ex[]) {
  const id = `f${++seq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, parse_status, revision_role, uploaded_at)
      values ($1,$2,'OBJ-SYN',$3,$4,$5,1,'pdf',$6,$7,$8,'0',$9,'DONE','CURRENT','2026-09-28T00:00:00.000Z')`, [id, insp, id, `${code}.pdf`, String(seq).padStart(64, "0"), stage, discipline, code, stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED"]);
  for (const x of xs) {
    await db.run("insert into extractions (file_id, param_code, kind, raw, value_text, page, bbox_json, line_text, confidence, meta_json) values ($1,$2,'param',$3,$3,$4,$5,$6,1,$7)", [
      id, x.code, x.value, x.page ?? 4, JSON.stringify([0.1, 0.2, 0.5, 0.24]), `… ${x.value} …`, JSON.stringify({ quote: `… ${x.value} …`, ...x.meta }),
    ]);
  }
  return id;
}
const check = async (insp: string, code: string) => (await db.get<Record<string, any>>("select * from checks where inspection_id = $1 and param_code = $2", [insp, code]))!;

beforeEach(async () => {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } };
  setMlPost(async () => {
    throw new Error("ML-сервис в модульном тесте не поднимается");
  });
  resetPassportsForTests();
});
afterEach(async () => {
  setMlPost();
  await db?.close();
});

describe("CMP-05 и CMP-21 в пересчёте протокола", () => {
  it("M-075: чугун К1 в ПД, ПВХ в РД — CANDIDATE с фрагментами обеих стадий и операциями каталога", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-ИОС3", "ИОС3", [{ code: "M-075", value: "CAST_IRON", meta: { item: "К1", element: "riser", alts: [], or_analog: false, chars: {} } }]);
    await file(insp, "RD", "Р-2099-01-001-ВК", "ВК", [{ code: "M-075", value: "PVC", meta: { item: "К1", element: "riser" } }]);
    await recompute(db, insp, new Set());
    const c = await check(insp, "M-075");
    expect(c).toMatchObject({ finding_status: "CANDIDATE", expected_value: "чугун раструбный канализационный (ГОСТ 6942-98)", actual_value: "НПВХ канализационный" });
    expect(c.reason).toMatch(/тонкостенный ПВХ вместо чугуна/);
    const prov = JSON.parse(c.provenance_json);
    expect(prov.ops).toContain("CMP-05");
    expect(prov.mentions.map((m: any) => [m.stage, m.use])).toEqual([["PD", "chosen"], ["RD", "chosen"]]);
    const f = await db.all<Record<string, any>>("select stage, role_expected_actual from evidence_fragments where check_id = $1 order by id", [c.id]);
    expect(f.map((x) => [x.stage, x.role_expected_actual])).toEqual([["PD", "expected"], ["RD", "actual"]]);
  });

  it("M-075: значение вне канона из ответа ML отбрасывается, противоречие внутри ПД — гипотеза", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-ИОС3", "ИОС3", [{ code: "M-075", value: "CAST_IRON", meta: { item: "К1" } }, { code: "M-075", value: "__proto__", meta: { item: "К1" } }]);
    await file(insp, "PD", "П-2099-01-001-АР", "АР", [{ code: "M-075", value: "PP", meta: { item: "К1" }, page: 9 }]);
    await file(insp, "RD", "Р-2099-01-001-ВК", "ВК", [{ code: "M-075", value: "CAST_IRON_SML", meta: { item: "К1" } }]);
    await recompute(db, insp, new Set());
    const c = await check(insp, "M-075");
    expect(c.finding_status).toBe("NEGATIVE_VERIFIED"); // CAST_IRON (ИОС — выше по приоритету) → SML — эквивалент
    expect(JSON.parse(c.provenance_json).mentions).toHaveLength(3);
    const s = await db.all<Record<string, any>>("select * from suspicions where inspection_id = $1 and discovery_method = 'INTERNAL_CONSISTENCY'", [insp]);
    expect(s).toHaveLength(1);
    expect(s[0].description).toMatch(/^M-075: Внутреннее противоречие ПД \(К1\)/);
    expect(s[0].pd_reference).toContain("П-2099-01-001-АР, ред. 0, стр. 9");
  });

  it("M-044: в РД исключена пароизоляция — CANDIDATE delete_layer, выравнивание в provenance", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    const pd = [{ m: "MEMBRANE_PVC", raw: "мембрана ПВХ", t: 1.5 }, { m: "INSUL_MW", raw: "минвата", t: 200 }, { m: "VAPOR_BITUMEN", raw: "пароизоляция", t: 3 }, { m: "PROFILED_SHEET", raw: "профлист", t: null }];
    await file(insp, "PD", "П-2099-01-001-АР", "АР", [{ code: "M-044", value: "мембрана / минвата / пароизоляция / профлист", meta: { item: "Кр-1", layers: pd } }]);
    await file(insp, "RD", "Р-2099-01-001-АР", "АР", [{ code: "M-044", value: "мембрана / минвата / профлист", meta: { item: "Кр-1", layers: pd.filter((l) => l.m !== "VAPOR_BITUMEN") } }]);
    await recompute(db, insp, new Set());
    const c = await check(insp, "M-044");
    expect(c.finding_status).toBe("CANDIDATE");
    expect(c.delta).toMatch(/^delete_layer: слой «битумно-полимерная пароизоляция 3 мм» исключён/);
    expect(JSON.parse(c.provenance_json).ops).toContain("CMP-21");
  });
});
