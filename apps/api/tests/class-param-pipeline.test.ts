// Эшелоны: L2 (сквозной пересчёт против ожидаемого ответа синтетического объекта), L6 (ловушки: соседнее здание,
// другой комплект ПД, противоречие внутри ПД), L8 (регрессия реального пакета T-129 в обезличенной синтетике).
// М-023 в пересчёте протокола (OS-INSP-3.1.10–3.1.15): упоминания из базы → выбор стадии → шкала → provenance и гипотеза.
// Без ML-сервиса: упоминания пишутся в extractions так, как их вернул бы /analyze.
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { createInspection, recompute, type Ctx } from "../src/services/inspections.ts";
import { setMlPost } from "../src/services/norms.ts";

let db: DB;
let ctx: Ctx;
let seq = 0;

/** Файл пакета (реестр выведен из имени) и упоминания класса в нём. */
async function file(insp: string, stage: "PD" | "RD", code: string, discipline: string, mentions: Array<{ v: string; page?: number; q?: "min"; x?: string }>, role = "CURRENT") {
  const id = `f${++seq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, parse_status, revision_role, uploaded_at)
      values ($1,$2,'OBJ-SYN',$3,$4,$5,1,'pdf',$6,$7,$8,'0',$9,'DONE',$10,'2026-09-27T00:00:00.000Z')`, [id, insp, id, `${code}.pdf`, String(seq).padStart(64, "0"), stage, discipline, code, stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED", role]);
  for (const m of mentions) {
    await db.run("insert into extractions (file_id, param_code, kind, raw, value_text, page, bbox_json, line_text, confidence, meta_json) values ($1,'M-023','param',$2,$2,$3,$4,$5,1,$6)", [
      id, m.v, m.page ?? 2, JSON.stringify([0.1, 0.2, 0.3, 0.22]), `класс конструктивной пожарной опасности – ${m.v}`,
      JSON.stringify({ quote: `… ${m.q ? "не ниже " : ""}${m.v} …`, qualifier: m.q ?? null, excluded: m.x ?? null, excluded_why: m.x ? "упоминание соседнего здания, а не объекта проверки" : null, ops: ["ENT-16", "NRM-03", "NRM-04"] }),
    ]);
  }
  return id;
}
const check = async (insp: string) => (await db.get<Record<string, any>>("select * from checks where inspection_id = $1 and param_code = 'M-023'", [insp]))!;
const frags = (id: string) => db.all<Record<string, any>>("select * from evidence_fragments where check_id = $1 order by id", [id]);

beforeEach(async () => {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } };
  setMlPost(async () => { throw new Error("ML-сервис в модульном тесте не поднимается"); });
});
afterEach(async () => {
  setMlPost();
  await db?.close();
});

describe("М-023 в пересчёте протокола", () => {
  it("структура реального пакета: ПД АР С0, ПБ «не ниже С0», КР и ПОС С1, другой комплект и соседнее здание; РД АР С0 — NEGATIVE_VERIFIED и гипотеза о противоречии ПД", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01.001-ПЗ", "ПЗ", []);
    await file(insp, "PD", "П-2099-01.001-ПБ", "ПБ", [{ v: "С0", q: "min", page: 16 }]);
    await file(insp, "PD", "П-2099-01-001-АР", "АР", [{ v: "С0", page: 8 }]);
    await file(insp, "PD", "П-2099-01-001-КР", "КР", [{ v: "С1", page: 5 }, { v: "С1", page: 26 }]);
    await file(insp, "PD", "П-2099-01-001-ПОС", "ПОС", [{ v: "С1", page: 3 }]);
    await file(insp, "PD", "ЖС-РД-000000-П-ПБ", "ПБ", [{ v: "С1", page: 40, x: "NEIGHBOR" }]);
    await file(insp, "PD", "ЖС-РД-000000-П-КР", "КР", [{ v: "С0", page: 14 }]);
    await file(insp, "RD", "РД-2099-01-001-АР2", "АР", [{ v: "С0", page: 1 }]);
    await file(insp, "RD", "П-2099-01-001-КЖ01", "КЖ", []);
    await recompute(db, insp, new Set());

    const c = await check(insp);
    expect(c).toMatchObject({ finding_status: "NEGATIVE_VERIFIED", expected_value: "не ниже С0", actual_value: "С0" });
    const f = await frags(c.id);
    expect(f.map((x) => [x.stage, x.document_code, x.sheet_page, x.role_expected_actual])).toEqual([
      ["PD", "П-2099-01.001-ПБ", 16, "expected"],
      ["RD", "РД-2099-01-001-АР2", 1, "actual"],
    ]);
    const prov = JSON.parse(c.provenance_json);
    expect(prov.ops).toContain("CMP-04");
    expect(prov.mentions.find((m: any) => m.document_code === "ЖС-РД-000000-П-ПБ").use).toBe("dropped");
    expect(prov.mentions.find((m: any) => m.document_code === "ЖС-РД-000000-П-КР").use).toBe("reference");

    const s = await db.all<Record<string, any>>("select * from suspicions where inspection_id = $1 and discovery_method = 'INTERNAL_CONSISTENCY'", [insp]);
    expect(s).toHaveLength(1);
    expect(s[0].description).toMatch(/^M-023: Внутреннее противоречие ПД/);
    expect(s[0].pd_reference).toContain("П-2099-01-001-КР");
    // OS-INSP-3.1.17 (T-130): каждый раздел с расходящимся значением — в ссылке на ПД, ПОС не выпадает
    expect(s[0].pd_reference).toContain("П-2099-01-001-ПОС, ред. 0, стр. 3");
    expect(s[0].pd_reference).toContain("П-2099-01.001-ПБ");
    expect(s[0].finding_status).toBe("SUSPICION");
    // опорное упоминание — худший класс с рамкой (КР С1, первая страница): по нему гипотеза уходит в кандидаты с листом
    const anchor = JSON.parse(s[0].advisor_ref_json);
    const kr = await db.get<{ id: string }>("select id from files where inspection_id = $1 and document_code = 'П-2099-01-001-КР'", [insp]);
    expect(anchor).toMatchObject({ file_id: kr!.id, page: 5, quote: "С1" });
    expect(anchor.bbox).toHaveLength(4);
    await db.run("update inspections set status = 'READY' where id = $1", [insp]);
    const { promoteSuspicion } = await import("../src/services/advisor.ts");
    const { check_id } = await promoteSuspicion(ctx, s[0].id, anchor);
    const cand = await db.get<Record<string, any>>("select * from checks where id = $1", [check_id]);
    expect(cand).toMatchObject({ finding_status: "CANDIDATE", verification_status: "PENDING", actual_value: "С1" });
    expect((await frags(check_id)).map((x) => [x.document_code, x.sheet_page])).toEqual([["П-2099-01-001-КР", 5]]);
    // T-130: кандидат из гипотезы показывает текущий текст гипотезы — пересчёт уточнил её, снимок перевода устарел бы
    await db.run("update suspicions set description = $1 where id = $2", ["M-023: уточнённый текст — КР и ПОС С1", s[0].id]);
    const { checkRows } = await import("../src/services/inspections.ts");
    const row = (await checkRows(db, insp)).find((c: any) => c.id === check_id)!;
    expect(row.parameter_name).toBe(`Гипотеза #${s[0].id}: M-023: уточнённый текст — КР и ПОС С1`);
    expect(row.reason).toContain("КР и ПОС С1");
    expect(row.about_param).toBe("M-023"); // очередь по параметру (OS-INSP-4.1.17) находит гипотезу о нём
  });

  it("понижение класса в РД (ПД АР С0, РД АР С1) — CANDIDATE с обеими страницами; повторный пересчёт не плодит гипотез", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-АР", "АР", [{ v: "С0", page: 8 }]);
    await file(insp, "RD", "РД-2099-01-001-АР1", "АР", [{ v: "С1", page: 4 }]);
    await recompute(db, insp, new Set());
    const c = await check(insp);
    expect(c).toMatchObject({ finding_status: "CANDIDATE", expected_value: "С0", actual_value: "С1", delta: "С0 → С1" });
    expect((await frags(c.id)).map((x) => x.sheet_page)).toEqual([8, 4]);
    await recompute(db, insp, new Set());
    expect((await db.all("select * from suspicions where inspection_id = $1 and discovery_method = 'INTERNAL_CONSISTENCY'", [insp])).length).toBe(0);
  });

  it("реестр без утверждения (выведенный, без подтверждения оператора) — CLARIFICATION_REQUIRED, а не сравнение", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-АР", "АР", [{ v: "С0" }], "UNRESOLVED");
    await file(insp, "RD", "РД-2099-01-001-АР1", "АР", [{ v: "С1" }], "UNRESOLVED");
    await recompute(db, insp, new Set());
    expect((await check(insp)).finding_status).toBe("CLARIFICATION_REQUIRED");
  });
});
