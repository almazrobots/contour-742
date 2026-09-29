// OS-INSP-1.1.3, 3.2.11, 7.1.7 (T-148): синтетический объект помечен в своих полях и не влияет на общие метрики.
// Эшелоны: L1 (правило и отсев в запросах), L3 (признак только в профиле / только в названии), L6 (алиас SQL не из запроса).
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { openDb, type DB } from "../src/db.ts";
import { isSyntheticObject, realObjectSql, SYNTH_ADDRESS_PREFIX, SYNTH_NAME_PREFIX } from "../src/domain/synthetic.ts";
import { createInspection, type Ctx } from "../src/services/inspections.ts";
import { passportView } from "../src/services/passports.ts";
import { patternHistory } from "../src/services/patterns.ts";

describe("синтетический объект — метка в полях (OS-INSP-1.1.3)", () => {
  it("признак профиля или метка названия — синтетика; реальный объект — нет", () => {
    expect(isSyntheticObject({ name: "Алтуфьевское ш., 79Б", profile: { residential: false } })).toBe(false);
    expect(isSyntheticObject({ name: `${SYNTH_NAME_PREFIX}Школа`, profile: {} })).toBe(true);
    expect(isSyntheticObject({ name: "Школа", profile: { synthetic: true } })).toBe(true);
    expect(isSyntheticObject({ name: "  синтетика · склад" })).toBe(true);
    expect(isSyntheticObject({ name: null, profile: null })).toBe(false);
    // «synthetic»: строка — не признак (только логическое true)
    expect(isSyntheticObject({ name: "Школа", profile: { synthetic: "true" } })).toBe(false);
  });
  it("все четыре синтетических объекта в data/synth помечены прописными в названии, адресе и профиле", () => {
    const root = config.root; // не ../../..: в песочнице Stryker тест лежит глубже, путь уходил в apps/api (T-139)
    for (const id of ["OBJ-SEV-2", "OBJ-SCH-8", "OBJ-POL-115", "OBJ-SKL-5"]) {
      const m = JSON.parse(readFileSync(join(root, "data/synth", id, "manifest.json"), "utf8"));
      const o = m.object ?? m.card ?? m;
      expect(o.name.startsWith(SYNTH_NAME_PREFIX)).toBe(true);
      expect(o.address.startsWith(SYNTH_ADDRESS_PREFIX)).toBe(true);
      expect(o.profile.synthetic).toBe(true);
      expect(isSyntheticObject(o)).toBe(true);
    }
  });
  it("алиас SQL — только идентификатор из кода, иначе громкая ошибка", () => {
    expect(realObjectSql("o")).toContain("o.profile_json");
    expect(() => realObjectSql("o; drop table objects")).toThrow(/алиас/);
  });
});

describe("синтетика не входит в общие метрики (OS-INSP-3.2.11, 7.1.7)", () => {
  let db: DB;
  let ctx: Ctx;
  let seq = 0;
  beforeEach(async () => {
    db = await openDb("memory");
    ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } } as Ctx;
  });
  async function obj(id: string, name: string, profile: Record<string, unknown>, value: number, confidence: number): Promise<string> {
    const insp = await createInspection(ctx, { object_id: id, name, profile } as any);
    const file = `f${++seq}`;
    await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, revision_role, uploaded_at)
        values ($1, $2, $3, $4, 'PZ.pdf', $5, 1, 'pdf', 'PD', $6, '1', 'DONE', 'CURRENT', '2026-09-27T00:00:00.000Z')`, [file, insp, id, file, "b".repeat(64), `ПЗ-${id}`]);
    await db.run("insert into extractions (file_id, param_code, kind, raw, value_num, page, confidence) values ($1, 'M-001', 'param', $2, $3, 1, $4)", [file, String(value), value, confidence]);
    await db.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, review_priority, reason, stage_notes_json, computed_in_version, created_at, updated_at)
        values ($1, $2, 'M-001', $3, 'MISSING_EVIDENCE', 'PENDING', 'HIGH', '', '{"PD":"USED","RD":"NO_VALUE"}', 1, now(), now())`, [`C-${id}`, insp, `${id}:M-001`]);
    return insp;
  }
  it("история ML-паттерна берёт только реальные объекты", async () => {
    await obj("REAL-1", "Реальный объект", {}, 1000, 1);
    await obj("SYN-1", `${SYNTH_NAME_PREFIX}Склад`, { synthetic: true }, 5000, 1);
    await obj("SYN-2", "Без метки в названии", { synthetic: true }, 6000, 1);
    const h = await patternHistory(db, "OTHER", ["M-001"]);
    expect(h.map((x) => x.object_id)).toEqual(["REAL-1"]);
  });
  it("метрики паспорта М-001 — только реальные объекты: число проверок и средняя уверенность", async () => {
    await obj("REAL-1", "Реальный объект", {}, 1000, 0.6);
    await obj("SYN-1", `${SYNTH_NAME_PREFIX}Склад`, { synthetic: true }, 5000, 1);
    const v = (await passportView(db, "M-001"))!;
    const row = (k: string) => v.metrics.find((m: any) => m.key === k)!;
    expect(row("checks").value).toBe("1");
    expect(row("confidence").value).toBe("0,60");
  });
});
