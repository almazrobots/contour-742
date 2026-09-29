// Эшелоны: L2 (сквозной пересчёт против ожидаемого ответа синтетического объекта), L6 (ловушки: Л/П, оговорка нормы).
// М-043 и М-106 в пересчёте протокола (OS-INSP-3.1.170–3.1.177, T-214): упоминания из базы → двери по марке → CMP-17 /
// норма CMP-06 → provenance, фрагменты и гипотеза. Без ML-сервиса: упоминания пишутся в extractions так, как их вернул бы
// /analyze (direction_mentions). Только синтетика.
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { createInspection, recompute, type Ctx } from "../src/services/inspections.ts";
import { setMlPost } from "../src/services/norms.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { ParamPassport } from "../src/domain/passport.ts";
import { passports } from "../src/services/passports.ts";

// T-233: паспорт М-106 — в data/seed/passports/draft/ до цифр замера; загрузчик draft/ не читает, тест подкладывает его сам
passports().byCode.set("M-106", ParamPassport.parse(JSON.parse(readFileSync(join(config.root, "data/seed/passports/draft/M-106.json"), "utf8"))));

let db: DB;
let ctx: Ctx;
let seq = 0;

type Row = { v: "outward" | "inward" | "hand"; mark?: string | null; page?: number; x?: string; exemption?: string; evac?: boolean };

/** Файл пакета и упоминания направления в нём — для обоих параметров, как их отдал бы ML по двум паспортам. */
async function file(insp: string, stage: "PD" | "RD", code: string, discipline: string, rows: Row[]) {
  const id = `f${++seq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, parse_status, revision_role, uploaded_at)
      values ($1,$2,'OBJ-SYN',$3,$4,$5,1,'pdf',$6,$7,$8,'0',$9,'DONE','CURRENT','2026-09-28T00:00:00.000Z')`, [id, insp, id, `${code}.pdf`, String(seq).padStart(64, "0"), stage, discipline, code, stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED"]);
  for (const param of ["M-043", "M-106"])
    for (const r of rows)
      await db.run("insert into extractions (file_id, param_code, kind, raw, value_text, page, bbox_json, line_text, confidence, meta_json) values ($1,$2,'param',$3,$3,$4,$5,$6,1,$7)", [
        id, param, r.v, r.page ?? 3, JSON.stringify([0.1, 0.2, 0.3, 0.22]), `${r.mark ?? "двери эвакуационных выходов"} — ${r.v}`,
        JSON.stringify({ quote: `${r.mark ?? "Двери эвакуационных выходов"} … ${r.v}`, mark: r.mark ?? null, evac: r.evac ?? null, scope: r.mark ? "door" : "general", exemption: r.exemption ?? null, excluded: r.x ?? null, excluded_why: r.x ? `код ${r.x}` : null, ops: ["ENT-10", "NRM-06"] }),
      ]);
}
const check = async (insp: string, code: string) => (await db.get<Record<string, any>>("select * from checks where inspection_id = $1 and param_code = $2", [insp, code]))!;
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

describe("М-043 и М-106 в пересчёте протокола", () => {
  it("ПД ПБ «по направлению выхода», РД АР: Д1 внутрь — CANDIDATE у обоих, фрагменты ПД и РД, provenance с маркой", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-ПБ", "ПБ", [{ v: "outward", page: 12 }]);
    await file(insp, "RD", "Р-2099-01-001-АР", "АР", [{ v: "inward", mark: "Д1", page: 5, evac: true }, { v: "outward", mark: "Д2", page: 5 }, { v: "inward", mark: "Д9", x: "NOT_EVAC" }]);
    await recompute(db, insp, new Set());
    for (const code of ["M-043", "M-106"]) {
      const c = await check(insp, code);
      expect(c).toMatchObject({ finding_status: "CANDIDATE", expected_value: "общее — по направлению выхода (наружу)", actual_value: "Д1 — внутрь (против направления эвакуации)" });
      expect((await frags(c.id)).map((f) => [f.stage, f.sheet_page, f.role_expected_actual])).toEqual([["PD", 12, "expected"], ["RD", 5, "actual"]]);
      const pv = JSON.parse(c.provenance_json);
      expect(pv.ops).toContain("CMP-17");
      expect(pv.mentions.find((m: any) => m.mark === "Д9")).toMatchObject({ use: "flagged", why: "код NOT_EVAC" });
    }
  });

  it("РД без ПД: норма М-043 — CANDIDATE, у М-106 — MISSING_EVIDENCE; Л/П и оговорка нормы — не нарушение", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "RD", "Р-2099-01-001-АР", "АР", [{ v: "inward", mark: "Д3", evac: true }]);
    await recompute(db, insp, new Set());
    const result = await check(insp, "M-043");
    expect(result.finding_status, result.reason).toBe("CANDIDATE");
    expect((await check(insp, "M-043")).reason).toMatch(/норма: СП 1\.13130\.2020, п\. 4\.2\.6/);
    expect((await check(insp, "M-106")).finding_status).toBe("MISSING_EVIDENCE");

    const insp2 = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект 2" });
    await file(insp2, "PD", "П-2099-01-001-АР", "АР", [{ v: "outward" }]);
    await file(insp2, "RD", "Р-2099-01-001-АР", "АР", [{ v: "inward", mark: "Д4", evac: true }, { v: "inward", mark: "Д4", x: "EXEMPT", page: 2 }]);
    await recompute(db, insp2, new Set());
    expect((await check(insp2, "M-043")).finding_status).toBe("NOT_COMPARABLE");
    const s = await db.all<Record<string, any>>("select description, dedup_key from suspicions where inspection_id = $1 order by dedup_key", [insp2]);
    expect(s.map((x) => x.dedup_key)).toEqual(expect.arrayContaining([expect.stringMatching(/^M-043:direction-exempt:RD:/), expect.stringMatching(/^M-106:direction-exempt:RD:/)]));

    const insp3 = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект 3" });
    await file(insp3, "PD", "П-2099-01-001-ПБ", "ПБ", [{ v: "outward" }]);
    await file(insp3, "RD", "Р-2099-01-001-АР", "АР", [{ v: "hand", mark: "Д5", x: "HAND_ONLY" }]);
    await recompute(db, insp3, new Set());
    expect((await check(insp3, "M-106")).finding_status).toBe("NOT_COMPARABLE");
  });
});
