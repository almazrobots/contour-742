// OS-INSP-3.2.8–3.2.10: ML-паттерн-анализ в пересчёте протокола — история из базы других объектов (T-099).
// Без ML-сервиса: подбор норм к гипотезам подменён, база — в памяти.
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { fitPatternModel } from "../src/domain/patterns.ts";
import { createInspection, recompute, type Ctx } from "../src/services/inspections.ts";
import { setMlPost } from "../src/services/norms.ts";
import { loadPatternParams, patternHistory, patternModel } from "../src/services/patterns.ts";

let db: DB;
let ctx: Ctx;
let fileSeq = 0;

/** Проверка объекта с одним разобранным документом ПД: площадь и строительный объём. */
async function inspection(objectId: string, area: number, volume: number, o: { role?: string | null; docType?: string | null; parse?: string } = {}): Promise<string> {
  const insp = await createInspection(ctx, { object_id: objectId, name: `Объект ${objectId}` });
  const file = `f${++fileSeq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, revision_role, doc_type, uploaded_at)
      values ($1, $2, $3, $4, 'PZ.pdf', $5, 1, 'pdf', 'PD', $6, '1', $7, $8, $9, '2026-09-26T00:00:00.000Z')`, [
    file, insp, objectId, file, "a".repeat(64), `ПЗ-${objectId}`, o.parse ?? "DONE", o.role === undefined ? "CURRENT" : o.role, o.docType ?? null,
  ]);
  const ext = "insert into extractions (file_id, param_code, kind, raw, value_num, page) values ($1, $2, 'param', $3, $4, 3)";
  await db.run(ext, [file, "M-002", String(area), area]);
  await db.run(ext, [file, "M-004", String(volume), volume]);
  return insp;
}

/** История по порядку: объекты — последовательно, как их создавал бы поток загрузок. */
async function history(values: number[]): Promise<void> {
  for (const [i, v] of values.entries()) await inspection(`OBJ-${i}`, 1000, v);
}

const HISTORY = [2900, 3000, 3100, 2950, 3050];
const patterns = (insp: string) => db.all<Record<string, any>>("select * from suspicions where inspection_id = $1 and discovery_method = 'ML_PATTERN'", [insp]);

beforeEach(async () => {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } };
  setMlPost(async () => { throw new Error("ML-сервис в модульном тесте не поднимается"); });
});
afterEach(async () => {
  setMlPost();
  await db?.close();
});

describe("OS-INSP-3.2.8–3.2.10 ML-паттерн в пересчёте протокола", () => {
  it("удельный объём на 20 % ниже медианы 5 других объектов — SUSPICION ML_PATTERN со ссылкой на значение", async () => {
    await history(HISTORY);
    const insp = await inspection("OBJ-CUR", 2000, 4800);
    await recompute(db, insp, new Set());
    const [s, ...rest] = await patterns(insp);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ object_id: "OBJ-CUR", finding_status: "SUSPICION", dedup_key: "PATTERN:M-004:PD", pd_reference: "ПЗ-OBJ-CUR, ред. 1, стр. 3" });
    expect(s.description).toContain("на 20 % ниже медианы 5 объектов (3 м³/м²");
  });

  it("в норме — гипотезы нет; меньше 5 объектов истории — гипотезы нет", async () => {
    await history(HISTORY);
    expect(await patterns(await recomputed(await inspection("OBJ-OK", 2000, 6000)))).toEqual([]);
    await db.close();
    db = await openDb("memory");
    ctx = { ...ctx, db };
    await history(HISTORY.slice(0, 4));
    expect(await patterns(await recomputed(await inspection("OBJ-CUR", 2000, 2000)))).toEqual([]);
  });

  it("история без текущего объекта, без заменённых редакций, неразобранных файлов и не-проектных документов", async () => {
    await history(HISTORY);
    await inspection("OBJ-CUR", 1000, 100); // прежняя проверка текущего объекта
    await inspection("OBJ-OLD", 1000, 100, { role: "SUPERSEDED" });
    await inspection("OBJ-PEND", 1000, 100, { parse: "PENDING" });
    await inspection("OBJ-EST", 1000, 100, { docType: "estimate" });
    await inspection("OBJ-NULL", 1000, 3000, { role: null }); // роль не назначена — не заменённая, участвует
    const hist = await patternHistory(db, "OBJ-CUR", ["M-002", "M-004"]);
    expect(hist.map((h) => h.object_id).sort()).toEqual(["OBJ-0", "OBJ-1", "OBJ-2", "OBJ-3", "OBJ-4", "OBJ-NULL"]);
    expect(hist.find((h) => h.object_id === "OBJ-0")!.facts).toEqual([{ key: "M-002", num: 1000 }, { key: "M-004", num: 2900 }]);
    const m = await patternModel(db, "OBJ-CUR");
    expect(m.params.get("M-004")!.n).toBe(6);
    expect(m.version).toBe(fitPatternModel(hist, await loadPatternParams(db), "OBJ-CUR").version);
  });

  it("пустой список кодов — пустая история (JSON-массив параметром, не литерал массива)", async () => {
    await history(HISTORY);
    expect(await patternHistory(db, "OBJ-CUR", [])).toEqual([]);
    expect((await patternHistory(db, "OBJ-CUR", ["M-004"])).every((h) => h.facts.every((f) => f.key === "M-004"))).toBe(true);
  });

  it("повторный пересчёт не дублирует гипотезу (дедуп внутри проверки, OS-INSP-3.2.3)", async () => {
    await history(HISTORY);
    const insp = await inspection("OBJ-CUR", 1000, 2400);
    await recompute(db, insp, new Set());
    await recompute(db, insp, new Set());
    expect(await patterns(insp)).toHaveLength(1);
  });
});

async function recomputed(insp: string): Promise<string> {
  await recompute(db, insp, new Set());
  return insp;
}
