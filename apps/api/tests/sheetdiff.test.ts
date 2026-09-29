// OS-INSP-3.4: дифф листа между редакциями — предметный слой (чистые функции) и запись проверок без ML-сервиса.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffToChecks, pairKey, priorityOf, revisionPairs, SHEET_DIFF_CODE, SHEET_DIFF_PARAM, type DiffResult, type RevisionFile, type SheetRef } from "../src/domain/sheetdiff.ts";

const A: SheetRef = { file_id: "f-a", sha256: "a".repeat(64), stage: "RD", document_code: "СК2-Р-АР", revision: "A", approval_status: "SUPERSEDED", page: 3 };
const B: SheetRef = { file_id: "f-b", sha256: "b".repeat(64), stage: "RD", document_code: "СК2-Р-АР", revision: "B", approval_status: "FOR_CONSTRUCTION", page: 3 };
const OK: DiffResult = {
  status: "ok",
  reason: null,
  inliers: 448,
  regions: [
    { bbox_a: [0.63, 0.51, 0.76, 0.7], bbox_b: [0.64, 0.52, 0.77, 0.71], score: 0.946, area: 0.0249 },
    { bbox_a: [0.35, 0.26, 0.36, 0.45], bbox_b: [0.36, 0.27, 0.37, 0.46], score: 0.75, area: 0.0002 },
  ],
};

describe("OS-INSP-3.4.3 области изменений → карточки CANDIDATE", () => {
  it("каждая область — CANDIDATE с двумя фрагментами: лист A expected, лист B actual, у каждого свой bbox", () => {
    const cs = diffToChecks("OBJ-SEV-2", A, B, OK);
    expect(cs).toHaveLength(2);
    for (const [i, c] of cs.entries()) {
      expect(c.finding_status).toBe("CANDIDATE");
      expect(c.fragments.map((f) => [f.role, f.file_id, f.sheet_page])).toEqual([
        ["expected", "f-a", 3],
        ["actual", "f-b", 3],
      ]);
      expect(c.fragments[0].bbox).toEqual(OK.regions[i].bbox_a);
      expect(c.fragments[1].bbox).toEqual(OK.regions[i].bbox_b);
      expect(c.fragments[0].sha256).toBe(A.sha256);
      expect(c.fragments[1].sha256).toBe(B.sha256);
      expect(c.evidence_group_id).toBe(`${pairKey("OBJ-SEV-2", A, B)}#${i + 1}`);
      expect(c.id).toMatch(/^F-OBJ-SEV-2-SHEET-DIFF-[0-9a-f]{8}$/);
    }
    expect(cs[0].expected_value).toBe("СК2-Р-АР, ред. A, л. 3");
    expect(cs[0].actual_value).toBe("СК2-Р-АР, ред. B, л. 3");
    expect(cs[0].delta).toBe("изменена область 2.49 % листа");
    expect(cs[0].reason).toContain("Область 1 из 2");
    expect(cs[0].review_priority).toBe("HIGH");
    expect(cs[1].review_priority).toBe("MEDIUM");
    expect(new Set(cs.map((c) => c.id)).size).toBe(2);
  });

  it("идентификаторы детерминированы: повторный дифф той же пары даёт те же id и группы", () => {
    expect(diffToChecks("OBJ-SEV-2", A, B, OK).map((c) => c.id)).toEqual(diffToChecks("OBJ-SEV-2", A, B, OK).map((c) => c.id));
    expect(diffToChecks("OBJ-SEV-2", A, { ...B, page: 4 }, OK)[0].id).not.toBe(diffToChecks("OBJ-SEV-2", A, B, OK)[0].id);
  });

  it("неизменённый лист — ни одной карточки", () => {
    expect(diffToChecks("OBJ-SEV-2", A, B, { ...OK, regions: [] })).toEqual([]);
  });

  it("очерёдность по значимости: ≥ 0.9 HIGH, ≥ 0.7 MEDIUM, иначе LOW", () => {
    expect([priorityOf(0.9), priorityOf(0.8999), priorityOf(0.7), priorityOf(0.6999), priorityOf(0)]).toEqual(["HIGH", "MEDIUM", "MEDIUM", "LOW", "LOW"]);
  });
});

describe("OS-INSP-3.4.4 листы не совмещаются", () => {
  it("not_comparable → одна проверка NOT_COMPARABLE с причиной и обеими страницами без рамок", () => {
    const cs = diffToChecks("OBJ-SEV-2", A, B, { status: "not_comparable", reason: "мало общих ключевых точек", inliers: 3, regions: [] });
    expect(cs).toHaveLength(1);
    expect(cs[0].finding_status).toBe("NOT_COMPARABLE");
    expect(cs[0].reason).toContain("мало общих ключевых точек");
    expect(cs[0].fragments.map((f) => [f.role, f.bbox])).toEqual([
      ["expected", null],
      ["actual", null],
    ]);
    expect(cs[0].evidence_group_id).toBe(pairKey("OBJ-SEV-2", A, B));
  });
});

describe("автоматический режим: пары редакций SUPERSEDED → CURRENT", () => {
  const F = (o: Partial<RevisionFile>): RevisionFile => ({ id: "x", client_file_id: "X", kind: "pdf", document_code: "СК2-Р-АР", predecessor_id: null, revision_role: "CURRENT", parse_status: "DONE", pages: 3, ...o });
  it("пара по predecessor_id, совпадающие страницы 1..min", () => {
    const pairs = revisionPairs([
      F({ id: "a", client_file_id: "AR-A", revision_role: "SUPERSEDED", pages: 3 }),
      F({ id: "b", client_file_id: "AR-B", predecessor_id: "AR-A", pages: 4 }),
      F({ id: "k", client_file_id: "KZH-1" }),
    ]);
    expect(pairs.map((p) => [p.a.id, p.b.id, p.pages])).toEqual([["a", "b", [1, 2, 3]]]);
  });
  it("не пара: преемник не CURRENT, предшественник не SUPERSEDED, не PDF, не разобран, предшественника нет", () => {
    const base = [F({ id: "a", client_file_id: "AR-A", revision_role: "SUPERSEDED" }), F({ id: "b", client_file_id: "AR-B", predecessor_id: "AR-A" })];
    expect(revisionPairs([base[0], { ...base[1], revision_role: "CONFLICT" }])).toEqual([]);
    expect(revisionPairs([{ ...base[0], revision_role: "CURRENT" }, base[1]])).toEqual([]);
    expect(revisionPairs([{ ...base[0], kind: "docx" }, base[1]])).toEqual([]);
    expect(revisionPairs([base[0], { ...base[1], parse_status: "FAILED" }])).toEqual([]);
    expect(revisionPairs([base[1]])).toEqual([]);
    expect(revisionPairs([{ ...base[0], pages: 0 }, base[1]])).toEqual([]);
  });
});

describe("запись проверок и карточка (in-memory БД, ML подменён)", () => {
  let db: any;
  let svc: typeof import("../src/services/sheetdiff.ts");
  let insp: typeof import("../src/services/inspections.ts");
  let ml: typeof import("../src/services/ml-client.ts");
  let calls = 0;
  beforeAll(async () => {
    process.env.INSPECTOR_DEMO_PASSWORD = "test-pass";
    const { openDb } = await import("../src/db.ts");
    svc = await import("../src/services/sheetdiff.ts");
    insp = await import("../src/services/inspections.ts");
    ml = await import("../src/services/ml-client.ts");
    db = await openDb("memory");
    const t = new Date().toISOString();
    await db.run("insert into objects (id, name, created_at) values ($1,$2,$3)", ["OBJ-SEV-2", "Северный", t]);
    await db.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", ["P-1", "OBJ-SEV-2", "VERIFYING", 1, t, t]);
    const ins = `insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, approval_status,
      predecessor_id, revision_role, parse_status, pages_json, uploaded_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`;
    await db.run(ins, ["f-a", "P-1", "OBJ-SEV-2", "AR-A", "a.pdf", A.sha256, 1, "pdf", "RD", "СК2-Р-АР", "A", "SUPERSEDED", null, "SUPERSEDED", "DONE", "[{},{},{}]", t]);
    await db.run(ins, ["f-b", "P-1", "OBJ-SEV-2", "AR-B", "b.pdf", B.sha256, 1, "pdf", "RD", "СК2-Р-АР", "B", "FOR_CONSTRUCTION", "AR-A", "CURRENT", "DONE", "[{},{},{}]", t]);
    ml.setMlDiffTransport(async (req) => {
      calls++;
      return req.page_a === 2
        ? { status: "not_comparable", reason: "мало общих ключевых точек", inliers: 0, matches: 3, method: "sift", regions: [], ms: 1, cached: false }
        : { status: "ok", reason: null, inliers: 448, matches: 600, method: "sift", regions: req.page_a === 3 ? OK.regions : [], ms: 1, cached: false };
    });
  });

  afterAll(async () => db?.close());

  it("автоматический режим пишет CANDIDATE и NOT_COMPARABLE; карточка показывает «Изменение листа между редакциями»", async () => {
    expect(await svc.autoSheetDiff(db, "P-1")).toBe(3); // стр. 1 — без изменений, стр. 2 — NOT_COMPARABLE, стр. 3 — две области
    const rows = (await insp.checkRows(db, "P-1")).filter((c) => c.param_code === SHEET_DIFF_CODE);
    expect(rows.map((c) => c.finding_status).sort()).toEqual(["CANDIDATE", "CANDIDATE", "NOT_COMPARABLE"]);
    for (const c of rows) {
      expect(c.parameter_name).toBe(SHEET_DIFF_PARAM.parameter_name);
      expect(c.section).toBe(SHEET_DIFF_PARAM.section);
      expect(c.fragments.map((f) => f.role_expected_actual)).toEqual(["expected", "actual"]);
    }
    const cand = rows.find((c) => c.finding_status === "CANDIDATE")!;
    expect(JSON.parse(cand.fragments[0].bbox_polygon_norm!)).toEqual(OK.regions[0].bbox_a);
    expect(JSON.parse(cand.fragments[1].bbox_polygon_norm!)).toEqual(OK.regions[0].bbox_b);
  });

  it("повторный запуск идемпотентен: сравнённые пары не уходят в ML и не дублируют карточки", async () => {
    const before = calls;
    expect(await svc.autoSheetDiff(db, "P-1")).toBe(0);
    expect(calls - before).toBe(1); // только стр. 1 (без изменений — карточек нет, пара не помечена)
    expect((await insp.checkRows(db, "P-1")).filter((c) => c.param_code === SHEET_DIFF_CODE)).toHaveLength(3);
  });

  it("INSPECTOR_SHEET_DIFF_AUTO=0 выключает автоматический режим", async () => {
    process.env.INSPECTOR_SHEET_DIFF_AUTO = "0";
    try {
      const before = calls;
      expect(await svc.autoSheetDiff(db, "P-1")).toBe(0);
      expect(calls).toBe(before);
    } finally {
      delete process.env.INSPECTOR_SHEET_DIFF_AUTO;
    }
  });

  it("ручной режим: чужой файл — 404, финализированная проверка — 409, сбой ML не пишет карточек", async () => {
    const ctx = { db, user: { id: "u-insp", login: "inspector", name: "И", role: "inspector" as const } };
    await expect(svc.sheetDiffRequest(ctx, "P-1", { file_a: "nope", page_a: 1, file_b: "f-b", page_b: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(svc.sheetDiffRequest(ctx, "P-1", { file_a: "f-a", page_a: 9, file_b: "f-b", page_b: 9 })).rejects.toMatchObject({ status: 422 });
    ml.setMlDiffTransport(async () => {
      throw new ml.MlError(0, "ML недоступен");
    });
    await expect(svc.sheetDiffRequest(ctx, "P-1", { file_a: "f-a", page_a: 1, file_b: "f-b", page_b: 1 })).rejects.toThrow("ML недоступен");
    await db.run("update inspections set status = 'FINALIZED' where id = 'P-1'");
    await expect(svc.sheetDiffRequest(ctx, "P-1", { file_a: "f-a", page_a: 1, file_b: "f-b", page_b: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await insp.checkRows(db, "P-1")).filter((c) => c.param_code === SHEET_DIFF_CODE)).toHaveLength(3);
  });
});
