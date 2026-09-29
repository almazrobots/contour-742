// Эшелоны: L2 (сквозной пересчёт: база → оператор → слой L8 → запись проверки и карточка), L4 (ответ ML с мусором
// в отметках изменений не ломает разбор), L6 (подмена редакции MUT-18, облако у мутации MUT-17). T-177, ADR-0008 п. 2.
// Без ML-сервиса: извлечения и отметки пишутся в базу так, как их вернул бы /analyze. Значения синтетические (ADR-0002).
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { evidenceCard } from "../src/domain/protocol.ts";
import { addChange } from "../src/services/changes.ts";
import { checkRows, createInspection, recompute, recomputeParams, type Ctx } from "../src/services/inspections.ts";
import { l8Data, saveChangeMarks } from "../src/services/l8.ts";
import { setMlPost } from "../src/services/norms.ts";

let db: DB;
let ctx: Ctx;
let seq = 0;

async function file(insp: string, stage: "PD" | "RD" | "ID", code: string, discipline: string, o: { revision?: string; role?: string; approval?: string; pages?: unknown } = {}) {
  const id = `f${++seq}`;
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, parse_status, revision_role, pages_json, uploaded_at)
      values ($1,$2,'OBJ-L8',$3,$4,$5,1,'pdf',$6,$7,$8,$9,$10,'DONE',$11,$12,'2026-09-28T00:00:00.000Z')`, [
    id, insp, id, `${code}.pdf`, String(seq).padStart(64, "0"), stage, discipline, code, o.revision ?? "1", o.approval ?? (stage === "RD" ? "FOR_CONSTRUCTION" : "APPROVED"), o.role ?? "CURRENT",
    JSON.stringify(o.pages ?? [{ page: 1, quality: "OK" }, { page: 2, quality: "OK" }]),
  ]);
  return id;
}
const BOX = [0.4, 0.4, 0.5, 0.45];
const num = (fileId: string, code: string, raw: string, n: number, conf = 0.95) =>
  db.run("insert into extractions (file_id, param_code, kind, raw, value_num, page, bbox_json, line_text, confidence, meta_json) values ($1,$2,'param',$3,$4,2,$5,$3,$6,$7)", [
    fileId, code, raw, n, JSON.stringify(BOX), conf, JSON.stringify({ quote: raw }),
  ]);
const check = (insp: string, code: string) => db.get<Record<string, any>>("select * from checks where inspection_id = $1 and param_code = $2 and parent_id is null", [insp, code]);
const l8 = (c: Record<string, any>) => (typeof c.l8_json === "string" ? JSON.parse(c.l8_json) : c.l8_json);
const cloud = (fileId: string, number = "3") => saveChangeMarks(db, fileId, { change_marks: [{ page: 2, kind: "cloud", number, bbox: [0.38, 0.38, 0.52, 0.47], text: "" }] });

beforeEach(async () => {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } } as Ctx;
  setMlPost(async () => { throw new Error("ML-сервис в модульном тесте не поднимается"); });
});
afterEach(async () => {
  setMlPost();
  await db?.close();
});

async function m007(opts: { cloudOnRd?: boolean } = {}) {
  const insp = await createInspection(ctx, { object_id: "OBJ-L8", name: "Синтетика L8" });
  const pd = await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ");
  const rd = await file(insp, "RD", "П-2099-01-001-АР", "АР");
  await num(pd, "M-007", "9 этажей", 9);
  await num(rd, "M-007", "10 этажей", 10); // MUT-05: этажность изменена
  if (opts.cloudOnRd) await cloud(rd);
  return { insp, pd, rd };
}

describe("слой L8 в пересчёте протокола", () => {
  it("лексический путь: кандидат без отметок — CANDIDATE, в проверке след L8 и approved_change_ref = NONE", async () => {
    const { insp } = await m007();
    await recompute(db, insp, new Set());
    const c = (await check(insp, "M-007"))!;
    expect(c.finding_status).toBe("CANDIDATE");
    expect(c.approved_change_ref).toBe("NONE");
    expect(l8(c)).toMatchObject({ change: "NONE", flags: [] });
    expect(l8(c).ops).toContain("GTE-05");
  });

  it("MUT-17: облако изменения у фрагмента РД — CANDIDATE с флагом CHANGE_APPROVAL_UNVERIFIED; регистрация с основанием — NEGATIVE_VERIFIED (APPROVED_CHANGE) сразу", async () => {
    const { insp, rd } = await m007({ cloudOnRd: true });
    await recompute(db, insp, new Set());
    const before = (await check(insp, "M-007"))!;
    expect(before.finding_status).toBe("CANDIDATE");
    expect(l8(before).flags).toContain("CHANGE_APPROVAL_UNVERIFIED");
    expect(before.approved_change_ref).toBe("облако изм. 3 (стр. 2)");

    // основание — отдельный документ пакета (письмо), а не сам лист РД: основание-лист изменение не утверждает
    await addChange(ctx, insp, { number: "Изм. 3", date: "2026-05-01", param_codes: ["m-007"], basis_file_id: rd, description: "" });
    expect((await check(insp, "M-007"))!.finding_status).toBe("CANDIDATE");
    const letter = await file(insp, "RD", "П-2099-01-001-ПИСЬМО", "АР");
    await addChange(ctx, insp, { number: "Изм. 3", date: "2026-05-02", param_codes: ["m-007"], basis_file_id: letter, description: "" });
    const after = (await check(insp, "M-007"))!;
    expect(after.finding_status).toBe("NEGATIVE_VERIFIED");
    expect(l8(after).reason_code).toBe("APPROVED_CHANGE");
    expect(after.approved_change_ref).toBe("№ Изм. 3 от 02.05.2026, основание — П-2099-01-001-ПИСЬМО.pdf");
    // карточка протокола: ссылка, след проверок
    const row = (await checkRows(db, insp)).find((r) => r.param_code === "M-007")!;
    const card = evidenceCard(row);
    expect(card.approved_change_ref).toBe(after.approved_change_ref);
    expect(card.verification.steps.map((s: any) => s.op)).toEqual(["VER-08"]);
  });

  it("регистрация изменения до выпуска протокола пересчёт не запускает", async () => {
    const { insp } = await m007({ cloudOnRd: true });
    await addChange(ctx, insp, { number: "3", date: "2026-05-01", param_codes: ["M-007"], description: "" });
    expect(await check(insp, "M-007")).toBeUndefined();
  });

  it("регистрация изменения после финализации или во время разбора статус проверки не затирает (OWASP SEC-06)", async () => {
    const { insp } = await m007({ cloudOnRd: true });
    await recompute(db, insp, new Set());
    for (const st of ["FINALIZED", "PARSING"]) {
      await db.run("update inspections set status = $1 where id = $2", [st, insp]);
      const v = (await db.get<{ protocol_version: number }>("select protocol_version from inspections where id = $1", [insp]))!.protocol_version;
      expect(await recomputeParams(db, insp, ["M-007"])).toBe(false);
      expect(await db.get("select status, protocol_version from inspections where id = $1", [insp])).toEqual({ status: st, protocol_version: v });
    }
    await db.run("update inspections set status = 'VERIFYING' where id = $1", [insp]);
    expect(await recomputeParams(db, insp, ["M-007"])).toBe(true);
    expect((await db.get<{ status: string }>("select status from inspections where id = $1", [insp]))!.status).toBe("VERIFYING");
  });

  it("GTE-05: страница РД LOW_QUALITY — NOT_COMPARABLE с причиной EXTRACTION_QUALITY", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-L8", name: "Синтетика L8" });
    const pd = await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ");
    const rd = await file(insp, "RD", "П-2099-01-001-АР", "АР", { pages: [{ page: 1, quality: "OK" }, { page: 2, quality: "LOW_QUALITY" }] });
    await num(pd, "M-007", "9", 9);
    await num(rd, "M-007", "10", 10);
    await recompute(db, insp, new Set());
    const c = (await check(insp, "M-007"))!;
    expect(c.finding_status).toBe("NOT_COMPARABLE");
    expect(l8(c).reason_code).toBe("EXTRACTION_QUALITY");
  });

  it("MUT-18: в реестре старая редакция помечена актуальной, новая — заменённой — CLARIFICATION_REQUIRED, флаг STALE_REVISION", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-L8", name: "Синтетика L8" });
    const pd = await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ");
    const rd1 = await file(insp, "RD", "П-2099-01-001-АР", "АР", { revision: "1" });
    await file(insp, "RD", "П-2099-01-001-АР", "АР", { revision: "2", role: "SUPERSEDED", approval: "FOR_CONSTRUCTION" });
    await num(pd, "M-007", "9", 9);
    await num(rd1, "M-007", "10", 10);
    await recompute(db, insp, new Set());
    const c = (await check(insp, "M-007"))!;
    expect(c.finding_status).toBe("CLARIFICATION_REQUIRED");
    expect(l8(c).flags).toContain("STALE_REVISION");
    expect(c.reason).toMatch(/более поздняя ред\. 2/);
  });

  it("GTE-04 на паспортном пути: общая площадь ПД (ТЭП) против техплана ИД — NOT_COMPARABLE", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-L8", name: "Синтетика L8" });
    const pd = await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ");
    const rd = await file(insp, "RD", "П-2099-01-001-АР", "АР");
    const id = await file(insp, "ID", "ТП-2099-01", "ТП");
    await num(pd, "M-002", "Общая площадь здания 5000,0", 5000);
    await num(rd, "M-002", "Общая площадь здания 5000,0", 5000);
    await num(id, "M-002", "Общая площадь 4800,0", 4800);
    await recompute(db, insp, new Set());
    const c = (await check(insp, "M-002"))!;
    expect(c.finding_status).toBe("NOT_COMPARABLE");
    expect(c.reason).toMatch(/разным методикам/);
  });

  it("VER-12: полезная площадь уменьшена, общая — тоже: общая площадь привязана к корню M-003", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-L8", name: "Синтетика L8" });
    const pd = await file(insp, "PD", "П-2099-01-001-ПЗ", "ПЗ");
    const rd = await file(insp, "RD", "П-2099-01-001-АР", "АР");
    await num(pd, "M-003", "Полезная площадь 3000,0", 3000);
    await num(rd, "M-003", "Полезная площадь 2800,0", 2800);
    await num(pd, "M-002", "Общая площадь здания 5000,0", 5000);
    await num(rd, "M-002", "Общая площадь здания 4800,0", 4800);
    await recompute(db, insp, new Set());
    const m3 = (await check(insp, "M-003"))!;
    const m2 = (await check(insp, "M-002"))!;
    expect([m3.finding_status, m2.finding_status]).toEqual(["CANDIDATE", "CANDIDATE"]);
    expect(m2.derived_from).toBe("M-003");
    expect(m3.derived_from).toBeNull();
    const card = evidenceCard((await checkRows(db, insp)).find((r) => r.param_code === "M-002")!);
    expect(card.derived_from).toBe("M-003");
  });
});

describe("отметки изменений из ответа ML", () => {
  it("сохраняются только известные виды и страницы; рамка — четыре конечных числа; номер и текст обрезаются", async () => {
    const insp = await createInspection(ctx, { object_id: "OBJ-L8", name: "Синтетика L8" });
    const f = await file(insp, "RD", "П-АР", "АР");
    await saveChangeMarks(db, f, {
      change_marks: [
        { page: 1, kind: "cloud", number: "3", bbox: [0.1, 0.1, 0.2, 0.2], text: "" },
        { page: 1, kind: "script", number: "1", bbox: null, text: "" } as any,
        { page: 0, kind: "callout", number: "1", bbox: null, text: "" },
        { page: 2, kind: "callout", number: "9".repeat(50), bbox: [0, 0, "x", 1] as any, text: "т".repeat(400) },
        { page: 3, kind: "stamp_row", number: null, bbox: null, text: undefined as any },
        { page: 2 ** 31, kind: "cloud", number: "1", bbox: null, text: "" },
        { page: 4, kind: "cloud", number: "1", bbox: [0.1, 0.1, 1.5, 0.2], text: "" },
      ],
    });
    const rows = await db.all<Record<string, any>>("select page, kind, number, bbox_json, text from change_marks where file_id = $1 order by id", [f]);
    expect(rows.map((r) => [r.page, r.kind])).toEqual([[1, "cloud"], [2, "callout"], [3, "stamp_row"], [4, "cloud"]]);
    expect(rows[3].bbox_json).toBeNull(); // рамка вне листа — нет рамки
    expect(rows[1].number).toHaveLength(20);
    expect(rows[1].bbox_json).toBeNull();
    expect(rows[1].text).toHaveLength(300);
    expect(rows[2].text).toBe("");
    // повторный разбор файла заменяет отметки, а не копит их; ответ без поля — отметок нет
    await saveChangeMarks(db, f, {});
    expect(await db.all("select 1 from change_marks where file_id = $1", [f])).toHaveLength(0);
  });

  it("данные слоя читаются из data/seed и проходят схему", () => {
    const d = l8Data();
    expect(d.gates.methods["M-002"].ID).toMatch(/технический план/);
    expect(d.deps.edges).toContainEqual(["M-003", "M-002"]);
    expect(l8Data()).toBe(d);
  });
});
