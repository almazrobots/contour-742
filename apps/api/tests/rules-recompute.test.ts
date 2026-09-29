// T-133: пересчёт проверки с правилом марки (OS-INSP-2.2.21) и версией правил (OS-INSP-2.1.15). Эшелоны: L3 (конвейер
// извлечения → проверка на базе), L4 (смена версии правил пересчитывает всё без разбора). Синтетика по образцу «Алтуфьево»:
// толщина плиты М-059 из ЭЭ «200» и ВК2 «1» (масштаб 1:20). База в памяти, без ML.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "inspector-rules-"));
let db: any;
let svc: any;
let insp = "";

async function file(id: string, stage: string, discipline: string, code: string) {
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision,
      revision_role, parse_status, uploaded_at) values ($1,$2,'OBJ-RULES',$1,$3,$4,1,'pdf',$5,$6,$7,'0','CURRENT','DONE',now())`,
    [id, insp, `${code}.pdf`, id.padEnd(64, "0").slice(0, 64), stage, discipline, code]);
}
const extr = (fileId: string, raw: string, num: number) =>
  db.run("insert into extractions (file_id, param_code, kind, raw, value_num, page, confidence) values ($1, 'M-059', 'param', $2, $3, 1, 0.9)", [fileId, raw, num]);
const m059 = () => db.get("select finding_status, expected_value, actual_value from checks where inspection_id = $1 and param_code = 'M-059' and parent_id is null", [insp]);

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  const { openDb } = await import("../src/db.ts");
  db = await openDb("memory");
  svc = await import("../src/services/inspections.ts");
  insp = await svc.createInspection({ db, user: { id: "u", login: "inspector", name: "И", role: "inspector" }, ip: "127.0.0.1" } as any, { object_id: "OBJ-RULES", name: "Синтетика", profile: {} });
  await file("f-ee", "PD", "ЭЭ", "П-ЭЭ");
  await file("f-vk", "RD", "ВК", "Р-ВК2");
  await extr("f-ee", "плита покрытия - 200 мм", 200);
  await extr("f-vk", "(1:20)", 1);
});
afterAll(async () => {
  await db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("правило марки и версия правил в пересчёте (T-133)", () => {
  it("толщина плиты из ЭЭ и ВК не собирается в кандидата — нет доказательства", async () => {
    await svc.recompute(db, insp, new Set());
    expect(await m059()).toMatchObject({ finding_status: "MISSING_EVIDENCE" });
    expect((await db.get("select rules_version from inspections where id = $1", [insp])).rules_version).toMatch(/OS-INSP-2\.2\.21/);
  });
  it("правила те же — пересчёт без новых файлов ничего не трогает; версия сменилась — пересчитаны все параметры", async () => {
    expect((await svc.recompute(db, insp, new Set())).recomputed).toBe(0);
    await db.run("update inspections set rules_version = 'прежние правила' where id = $1", [insp]);
    const all = (await db.get("select count(*)::int n from params")).n;
    expect((await svc.recompute(db, insp, new Set())).recomputed).toBe(all);
  });
  it("профильная марка КР даёт значение: кандидат 200 → 180 с источником из КР и КЖ", async () => {
    await file("f-kr", "PD", "КР", "П-КР");
    await file("f-kzh", "RD", "КЖ", "Р-КЖ1");
    await extr("f-kr", "плита перекрытия 200", 200);
    await extr("f-kzh", "плита перекрытия 180", 180);
    await svc.recompute(db, insp, new Set(["f-kr", "f-kzh"]));
    expect(await m059()).toMatchObject({ finding_status: "CANDIDATE", expected_value: "200", actual_value: "180" });
  });
});
