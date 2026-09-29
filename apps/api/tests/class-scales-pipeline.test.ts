// Эшелоны: L2 (сквозной пересчёт: упоминания из базы → паспорт со шкалой справочника → CMP-04/CMP-26 → карточка),
// L6 (ловушки: поэлементное сравнение, ИД против РД, кабель без индекса FR). Без ML-сервиса: упоминания пишутся
// в extractions так, как их вернул бы /analyze по паспорту (T-172, OS-INSP-3.1.30–3.1.36).
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { createInspection, recompute, type Ctx } from "../src/services/inspections.ts";
import { setMlPost } from "../src/services/norms.ts";

let db: DB;
let ctx: Ctx;
let seq = 0;

type M = { v: string; el?: string; q?: "min"; page?: number };
async function file(insp: string, param: string, stage: "PD" | "RD" | "ID", code: string, discipline: string, mentions: M[], role = "CURRENT") {
  const id = `f${++seq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, parse_status, revision_role, uploaded_at)
      values ($1,$2,'OBJ-SYN',$3,$4,$5,1,'pdf',$6,$7,$8,'0',$9,'DONE',$10,'2026-09-28T00:00:00.000Z')`, [id, insp, id, `${code}.pdf`, String(seq).padStart(64, "0"), stage, discipline, code, stage === "PD" ? "APPROVED" : "FOR_CONSTRUCTION", role]);
  for (const m of mentions) {
    await db.run("insert into extractions (file_id, param_code, kind, raw, value_text, page, bbox_json, line_text, confidence, meta_json) values ($1,$2,'param',$3,$3,$4,$5,$6,1,$7)", [
      id, param, m.v, m.page ?? 2, JSON.stringify([0.1, 0.2, 0.3, 0.22]), `… ${m.v} …`,
      JSON.stringify({ quote: `… ${m.q ? "не ниже " : ""}${m.v} …`, qualifier: m.q ?? null, excluded: null, excluded_why: null, ...(m.el ? { element: m.el } : {}), ops: ["ENT-16", "NRM-03", "NRM-04"] }),
    ]);
  }
  return id;
}
const check = async (insp: string, param: string) => (await db.get<Record<string, any>>("select * from checks where inspection_id = $1 and param_code = $2", [insp, param]))!;

beforeEach(async () => {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } };
  setMlPost(async () => { throw new Error("ML-сервис в модульном тесте не поднимается"); });
});
afterEach(async () => {
  setMlPost();
  await db?.close();
});

describe("шкалы W1 в пересчёте протокола", () => {
  it("M-055: колонны понижены в РД, плиты равны — CANDIDATE по колоннам, элемент в provenance, без гипотез", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "M-055", "PD", "П-2099-01-001-КР", "КР", [{ v: "B40", el: "колонны" }, { v: "B30", el: "перекрытия", page: 3 }]);
    await file(insp, "M-055", "RD", "П-2099-01-001-КЖ1", "КЖ", [{ v: "B35", el: "колонны" }, { v: "B30", el: "перекрытия", page: 5 }]);
    await recompute(db, insp, new Set());
    const c = await check(insp, "M-055");
    expect(c).toMatchObject({ finding_status: "CANDIDATE", expected_value: "B40", actual_value: "B35", delta: "колонны: B40 → B35" });
    const prov = JSON.parse(c.provenance_json);
    expect(prov.mentions.map((m: any) => m.element).sort()).toEqual(["колонны", "колонны", "перекрытия", "перекрытия"]);
    expect((await db.all("select * from suspicions where inspection_id = $1 and discovery_method = 'INTERNAL_CONSISTENCY'", [insp])).length).toBe(0);
  });

  it("M-055 CMP-26: паспорт БСГ в ИД ниже спецификации РД — CANDIDATE «ИД против РД» с тремя фрагментами", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "M-055", "PD", "П-2099-01-001-КР", "КР", [{ v: "B30", q: "min" }]);
    await file(insp, "M-055", "RD", "П-2099-01-001-КЖ1", "КЖ", [{ v: "B35" }]);
    await file(insp, "M-055", "ID", "ИД-2099-01-001-ПАСП-17", "ИД", [{ v: "B30" }]);
    await recompute(db, insp, new Set());
    const c = await check(insp, "M-055");
    expect(c).toMatchObject({ finding_status: "CANDIDATE", expected_value: "B35", actual_value: "B30" });
    expect(c.reason).toContain("CMP-26");
    const f = await db.all<Record<string, any>>("select stage, role_expected_actual from evidence_fragments where check_id = $1 order by id", [c.id]);
    expect(f.map((x) => [x.stage, x.role_expected_actual])).toEqual([["PD", "expected"], ["RD", "actual"], ["ID", "actual"]]);
  });

  it("M-109: FRLS в ПД, LS в РД по той же системе — CANDIDATE; M-103: EI 60 → EIW 60 — не понижение", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "M-109", "PD", "П-2099-01-001-ПБ", "ПБ", [{ v: "нг(А)-FRLS", el: "СОУЭ" }]);
    await file(insp, "M-109", "RD", "П-2099-01-001-ЭОМ", "ЭОМ", [{ v: "нг(А)-LS", el: "СОУЭ" }]);
    await file(insp, "M-103", "PD", "П-2099-01-001-ПБ2", "ПБ", [{ v: "EI 60", el: "1-й тип" }]);
    await file(insp, "M-103", "RD", "П-2099-01-001-АР", "АР", [{ v: "EIW 60", el: "1-й тип" }]);
    await recompute(db, insp, new Set());
    expect(await check(insp, "M-109")).toMatchObject({ finding_status: "CANDIDATE", delta: "СОУЭ: нг(А)-FRLS → нг(А)-LS" });
    expect((await check(insp, "M-103")).finding_status).toBe("NEGATIVE_VERIFIED");
  });

  it("устаревшая редакция РД с понижением (MUT-18) не даёт кандидата: сравнение идёт по актуальной", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "M-022", "PD", "П-2099-01-001-ПЗ", "ПЗ", [{ v: "I" }]);
    await file(insp, "M-022", "RD", "П-2099-01-001-АР-old", "АР", [{ v: "III" }], "SUPERSEDED");
    await file(insp, "M-022", "RD", "П-2099-01-001-АР", "АР", [{ v: "I" }]);
    await recompute(db, insp, new Set());
    expect(await check(insp, "M-022")).toMatchObject({ finding_status: "NEGATIVE_VERIFIED", expected_value: "I", actual_value: "I" });
  });
});
