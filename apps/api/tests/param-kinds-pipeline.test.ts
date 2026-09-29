// Эшелоны: L2 (сквозной путь вида из реестра: паспорт → спецификация ML → строки извлечения → оценка → проверка и
// гипотеза в базе), L6 (незнакомый вид паспорта — ошибка данных с именем вида). OS-INSP-7.1.20–7.1.24, T-186.
// Без ML-сервиса: строки extractions — такие, какие вернул бы /analyze для извлекателя t_presence_mentions
// (ml/tests/test_extractor_kinds.py проверяет ML-половину того же вида на синтетическом документе).
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import "./kinds/t-presence.ts"; // вид регистрируется до построения схемы паспорта — как строка в domain/kinds/index.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.ts";
import { openDb, type DB } from "../src/db.ts";
import { extractorSpec, ParamPassport } from "../src/domain/passport.ts";
import { assertKnownKinds, UnknownParamKind } from "../src/domain/param-kinds.ts";
import { createInspection, recompute, type Ctx } from "../src/services/inspections.ts";
import { setMlPost } from "../src/services/norms.ts";

const CODE = "M-010"; // параметр Матрицы без своего паспорта: в тесте ему выдаётся паспорт вида t_presence
const base = JSON.parse(readFileSync(join(config.root, "data/seed/passports/M-023.json"), "utf8"));
const raw = { ...base, code: CODE, value: { kind: "t_presence", words: ["есть", "нет"] }, extractor: { kind: "t_presence_mentions", anchor: "Количество квартир" } };
const passport = ParamPassport.parse(raw);

vi.mock("../src/services/passports.ts", async (orig) => {
  const m = await orig<typeof import("../src/services/passports.ts")>();
  return { ...m, passportFor: (code: string) => (code === CODE ? passport : m.passportFor(code)) };
});

describe("паспорт вида из реестра", () => {
  it("схема паспорта принимает зарегистрированный вид; ML получает спецификацию вида", () => {
    expect(passport.value).toEqual({ kind: "t_presence", words: ["есть", "нет"] });
    expect(extractorSpec(passport)).toEqual({ kind: "t_presence_mentions", anchor: "Количество квартир", words: ["есть", "нет"] });
  });
  it("незнакомый вид — ошибка данных с именем вида, а не безымянный отказ схемы", () => {
    const bad = { ...raw, value: { kind: "aggregate" } };
    expect(() => assertKnownKinds(bad, "паспорт M-010.json")).toThrow(UnknownParamKind);
    expect(() => assertKnownKinds(bad, "паспорт M-010.json")).toThrow("паспорт M-010.json: вид значения «aggregate» не зарегистрирован");
    expect(() => ParamPassport.parse(bad)).toThrow();
    expect(() => ParamPassport.parse({ ...raw, extractor: { kind: "t_presence_mentions" } })).toThrow(); // схема извлекателя вида действует
  });
});

let db: DB;
let ctx: Ctx;
let seq = 0;

/** Файл пакета и строки извлечения вида — как их записал бы /analyze. */
async function file(insp: string, stage: "PD" | "RD", code: string, discipline: string, values: Array<{ v: string; page?: number; bbox?: boolean }>) {
  const id = `f${++seq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, parse_status, revision_role, uploaded_at)
      values ($1,$2,'OBJ-SYN',$3,$4,$5,1,'pdf',$6,$7,$8,'0',$9,'DONE','CURRENT','2026-09-27T00:00:00.000Z')`, [id, insp, id, `${code}.pdf`, String(seq).padStart(64, "0"), stage, discipline, code, stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED"]);
  for (const x of values)
    await db.run("insert into extractions (file_id, param_code, kind, raw, value_text, page, bbox_json, line_text, confidence, meta_json) values ($1,$2,'param',$3,$3,$4,$5,$6,0.8,$7)", [
      id, CODE, x.v, x.page ?? 1, x.bbox === false ? null : JSON.stringify([0.1, 0.2, 0.3, 0.25]), `Количество квартир: ${x.v}`, JSON.stringify({ quote: `… ${x.v} …` }),
    ]);
}
const check = async (insp: string) => (await db.get<Record<string, any>>("select * from checks where inspection_id = $1 and param_code = $2", [insp, CODE]))!;

beforeEach(async () => {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } };
  setMlPost(async () => { throw new Error("ML-сервис в модульном тесте не поднимается"); });
});
afterEach(async () => {
  setMlPost();
  await db?.close();
});

describe("пересчёт протокола через реестр (OS-INSP-7.1.22–7.1.23)", () => {
  it("ПД и РД совпали — оценка вида: статус, фрагменты, provenance", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ", [{ v: "есть", page: 4 }]);
    await file(insp, "RD", "РД-2099-01-001-АР", "АР", [{ v: "есть", page: 2 }]);
    await recompute(db, insp, new Set());
    const c = await check(insp);
    expect(c).toMatchObject({ finding_status: "NEGATIVE_VERIFIED", expected_value: "есть", actual_value: "есть", reason: "t_presence: NEGATIVE_VERIFIED" });
    expect(JSON.parse(c.provenance_json)).toEqual({ ops: ["T-PRESENCE"], mentions: [{ stage: "PD", use: "chosen", why: null, value: "есть" }, { stage: "RD", use: "chosen", why: null, value: "есть" }] });
    const f = await db.all<Record<string, any>>("select stage, sheet_page, role_expected_actual from evidence_fragments where check_id = $1 order by id", [c.id]);
    expect(f.map((x) => [x.stage, x.sheet_page, x.role_expected_actual])).toEqual([["PD", 4, "expected"], ["RD", 2, "actual"]]);
  });
  it("разные значения внутри ПД — гипотеза общим путём: ссылки, опора с цитатой вида, основание паспорта", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-SYN", name: "Синтетический объект" });
    await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ", [{ v: "есть", page: 4, bbox: false }, { v: "нет", page: 9 }]);
    await file(insp, "RD", "РД-2099-01-001-АР", "АР", [{ v: "нет", page: 2 }]);
    await recompute(db, insp, new Set());
    expect(await check(insp)).toMatchObject({ finding_status: "CANDIDATE", expected_value: "есть", actual_value: "нет" });
    const s = await db.all<Record<string, any>>("select * from suspicions where inspection_id = $1 and dedup_key like $2", [insp, `${CODE}:%`]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      discovery_method: "INTERNAL_CONSISTENCY", description: `${CODE}: в PD разные значения присутствия`, dedup_key: `${CODE}:presence:PD`, review_priority: "HIGH",
      pd_reference: "П-2099-01-001-ПЗ, ред. 0, стр. 4; П-2099-01-001-ПЗ, ред. 0, стр. 9", rd_reference: null, normative_base: passport.basis,
    });
    expect(Number(s[0].confidence)).toBeCloseTo(0.8);
    expect(JSON.parse(s[0].advisor_ref_json)).toMatchObject({ page: 9, quote: "присутствие: нет" });
  });
});
