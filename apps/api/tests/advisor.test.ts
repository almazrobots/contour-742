// Модульные тесты советника, подбора норм и перевода гипотезы в кандидаты (T-034, T-035).
// Без ML-сервиса: транспорт в ML подменяется (setMlPost), база — в памяти.
process.env.INSPECTOR_DEMO_PASSWORD ??= "unit-test-password";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { advisorDedupKey, isBBox, normLabel, promotionError, suspicionParamCode } from "../src/domain/suspicions.ts";
import { promoteSuspicion, runAdvisor } from "../src/services/advisor.ts";
import { createInspection, HttpError, type Ctx } from "../src/services/inspections.ts";
import { attachNorms, searchNorms, setMlPost, type NormSearch } from "../src/services/norms.ts";

const SHA = "a".repeat(64);
let db: DB;
let ctx: Ctx;
let insp: string;

async function setup(status = "READY") {
  db = await openDb("memory");
  ctx = { db, user: { id: "u-insp", login: "inspector", name: "Иванова А. С.", role: "inspector" } };
  insp = await createInspection(ctx, { object_id: "OBJ-T", name: "Тестовый объект" });
  await db.run("update inspections set status = $1, protocol_version = 1 where id = $2", [status, insp]);
  await db.run(`insert into files (id, inspection_id, object_id, client_file_id, file_name, sha256, size, kind, doc_stage, document_code, revision, parse_status, revision_role, uploaded_at)
      values ('f1', $1, 'OBJ-T', 'c1', 'RD.pdf', $2, 1, 'pdf', 'RD', 'ПК-Р-АР', '1', 'DONE', 'CURRENT', '2026-09-24T00:00:00.000Z')`, [insp, SHA]);
}

async function addSuspicion(over: { normative_base?: string | null; description?: string; key?: string; ref?: unknown } = {}): Promise<number> {
  const r = await db.run(`insert into suspicions (inspection_id, object_id, discovery_method, confidence, description, review_priority, normative_base, dedup_key, advisor_ref_json)
      values ($1, 'OBJ-T', 'LLM_ADVISOR', 0.5, $2, 'MEDIUM', $3, $4, $5) returning id`, [
    insp, over.description ?? "Ширина эвакуационного выхода 0,85 м", over.normative_base ?? null, over.key ?? `K-${Math.random()}`, over.ref ? JSON.stringify(over.ref) : null,
  ]);
  return r.rows[0].id as number;
}

beforeEach(() => setup());
afterEach(async () => {
  setMlPost();
  await db?.close();
});

describe("OS-INSP-3.2.7 перевод гипотезы в кандидаты — домен", () => {
  it("promotionError: без файла, страницы или bbox — ошибка; со ссылкой — null", () => {
    const ids = new Set(["f1"]);
    expect(promotionError({ file_id: "f1", page: 2 }, ids)).toMatch(/bbox/);
    expect(promotionError({ page: 2, bbox: [0.1, 0.1, 0.2, 0.2] }, ids)).toMatch(/file_id/);
    expect(promotionError({ file_id: "f1", bbox: [0.1, 0.1, 0.2, 0.2] }, ids)).toMatch(/страниц/);
    expect(promotionError({ file_id: "f2", page: 1, bbox: [0.1, 0.1, 0.2, 0.2] }, ids)).toMatch(/не из этой проверки/);
    expect(promotionError({ file_id: "f1", page: 0, bbox: [0.1, 0.1, 0.2, 0.2] }, ids)).not.toBeNull();
    expect(promotionError(null, ids)).not.toBeNull();
    expect(promotionError({ file_id: "f1", page: 2, bbox: [0.1, 0.1, 0.2, 0.2] }, ids)).toBeNull();
  });

  it("isBBox: доли [0;1], x0 < x1, y0 < y1, ровно 4 числа", () => {
    expect(isBBox([0, 0, 1, 1])).toBe(true);
    expect(isBBox([0.2, 0.1, 0.1, 0.3])).toBe(false);
    expect(isBBox([0.1, 0.3, 0.2, 0.3])).toBe(false);
    expect(isBBox([0, 0, 1.2, 1])).toBe(false);
    expect(isBBox([-0.1, 0, 1, 1])).toBe(false);
    expect(isBBox([0, 0, 1])).toBe(false);
    expect(isBBox([0, 0, 1, Number.NaN])).toBe(false);
    expect(isBBox("0,0,1,1")).toBe(false);
  });

  it("ключ гипотезы советника устойчив к регистру и пунктуации цитаты; код параметра — SUSP-<id>", () => {
    expect(advisorDedupKey(SHA, 2, "Помещение 0.12 Склад ГСМ")).toBe(advisorDedupKey(SHA, 2, "помещение 0 12 склад гсм"));
    expect(advisorDedupKey(SHA, 2, "Склад ГСМ")).not.toBe(advisorDedupKey(SHA, 3, "Склад ГСМ"));
    expect(suspicionParamCode(7)).toBe("SUSP-7");
    expect(normLabel({ document_number: "СП 1.13130.2020", section: "п. 4.2.5", summary: "Ширина выходов" })).toBe("СП 1.13130.2020, п. 4.2.5 — Ширина выходов");
    expect(normLabel({ document_number: "ГОСТ 21.110-2013", section: null })).toBe("ГОСТ 21.110-2013");
  });
});

describe("OS-INSP-3.2.7 перевод гипотезы в кандидаты — сервис", () => {
  it("promote без bbox → 400, кандидат не создан", async () => {
    const id = await addSuspicion();
    try {
      await promoteSuspicion(ctx, id, { file_id: "f1", page: 2 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(400);
    }
    expect(await db.get("select count(*) n from checks where param_code = $1", [suspicionParamCode(id)])).toEqual({ n: 0 });
  });

  it("promote со ссылкой → CANDIDATE с param_code SUSP-<id> и фрагментом доказательства; повтор — 409", async () => {
    const id = await addSuspicion({ ref: { quote: "Ширина эвакуационного выхода м 0,85" } });
    const { check_id } = await promoteSuspicion(ctx, id, { file_id: "f1", page: 2, bbox: [0.09, 0.19, 0.3, 0.21] });
    const c = (await db.get("select * from checks where id = $1", [check_id])) as any;
    expect(c).toMatchObject({ param_code: `SUSP-${id}`, finding_status: "CANDIDATE", verification_status: "PENDING", actual_value: "Ширина эвакуационного выхода м 0,85" });
    const fr = (await db.all("select * from evidence_fragments where check_id = $1", [check_id])) as any[];
    expect(fr).toHaveLength(1);
    expect(fr[0]).toMatchObject({ file_id: "f1", sha256: SHA, sheet_page: 2, stage: "RD" });
    expect(JSON.parse(fr[0].bbox_polygon_norm)).toEqual([0.09, 0.19, 0.3, 0.21]);
    expect(await db.get("select promoted_check_id, inspector_status from suspicions where id = $1", [id])).toEqual({ promoted_check_id: check_id, inspector_status: "ACCEPTED" });
    expect(await db.get("select count(*) n from audit_log where action = 'SUSPICION_PROMOTED'")).toEqual({ n: 1 });
    await expect(promoteSuspicion(ctx, id, { file_id: "f1", page: 2, bbox: [0.1, 0.1, 0.2, 0.2] })).rejects.toThrow(/уже переведена/);
  });

  it("два параллельных перевода одной гипотезы: кандидат один, второй — 409", async () => {
    const id = await addSuspicion();
    const ref = { file_id: "f1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number] };
    const out = await Promise.allSettled([promoteSuspicion(ctx, id, ref), promoteSuspicion(ctx, id, ref)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await db.get("select count(*) n from checks where param_code = $1", [suspicionParamCode(id)])).toEqual({ n: 1 });
    expect(await db.get("select count(*) n from audit_log where action = 'SUSPICION_PROMOTED'")).toEqual({ n: 1 });
  });

  it("promote в FINALIZED → 409; в COMPLETED — можно, проверка возвращается в VERIFYING; нет гипотезы — 404", async () => {
    const id = await addSuspicion();
    await db.run("update inspections set status = 'FINALIZED' where id = $1", [insp]);
    await expect(promoteSuspicion(ctx, id, { file_id: "f1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2] })).rejects.toThrow(/финализирован/);
    await db.run("update inspections set status = 'COMPLETED' where id = $1", [insp]);
    await promoteSuspicion(ctx, id, { file_id: "f1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2] });
    expect(await db.get("select status from inspections where id = $1", [insp])).toEqual({ status: "VERIFYING" });
    await expect(promoteSuspicion(ctx, 99999, { file_id: "f1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2] })).rejects.toThrow(/не найдена/);
  });
});

describe("OS-INSP-3.2.6 подбор нормы к гипотезе", () => {
  const fake: NormSearch = async (_db, q) => ({
    query: q,
    method: "bm25",
    results: [{ id: "SP1-EXIT-WIDTH", document_number: "СП 1.13130.2020", document_name: "", section: "п. 4.2.5", summary: "Ширина эвакуационных выходов", summary_is_paraphrase: true, source: "", score: 1 }],
  });

  it("attachNorms не перезаписывает заполненную норму и заполняет пустую", async () => {
    const filled = await addSuspicion({ normative_base: "СП 54.13330.2022, п. 7.1.3" });
    const empty = await addSuspicion({ normative_base: null });
    const blank = await addSuspicion({ normative_base: "  " });
    expect(await attachNorms(db, insp, fake)).toBe(2);
    const nb = async (id: number) => ((await db.get("select normative_base from suspicions where id = $1", [id])) as any).normative_base;
    expect(await nb(filled)).toBe("СП 54.13330.2022, п. 7.1.3");
    expect(await nb(empty)).toBe("СП 1.13130.2020, п. 4.2.5 — Ширина эвакуационных выходов");
    expect(await nb(blank)).toBe("СП 1.13130.2020, п. 4.2.5 — Ширина эвакуационных выходов");
  });

  it("attachNorms: пустой результат поиска — поле остаётся пустым", async () => {
    const id = await addSuspicion();
    expect(await attachNorms(db, insp, async (_d, q) => ({ query: q, method: "bm25", results: [] }))).toBe(0);
    expect(((await db.get("select normative_base from suspicions where id = $1", [id])) as any).normative_base).toBeNull();
  });

  it("searchNorms передаёт в ML активные записи normative_base; отказ ML → 503", async () => {
    let sent: any;
    setMlPost(async (path, body) => {
      sent = { path, body };
      return { query: "q", method: "bm25", results: [] };
    });
    await searchNorms(db, "ширина", 3);
    expect(sent.path).toBe("/norms/search");
    expect(sent.body.top_k).toBe(3);
    expect(sent.body.extra.map((r: any) => r.document_number)).toContain("СП 1.13130.2020");
    const { MlError } = await import("../src/services/ml-client.ts");
    setMlPost(async () => {
      throw new MlError(0, "ML недоступен");
    });
    await expect(searchNorms(db, "ширина", 3)).rejects.toMatchObject({ status: 503 });
  });
});

describe("OS-INSP-3.2.4, 3.2.5 советник", () => {
  it("принятые гипотезы → SUSPICION LLM_ADVISOR со ссылкой; отклонённые → журнал аудита с причиной", async () => {
    setMlPost(async (path, body: any) => {
      expect(path).toBe("/advise");
      expect(body.sha256).toEqual([SHA]);
      return {
        provider: "fake",
        available: true,
        accepted: [{ description: "Склад ГСМ в РД", sha256: SHA, page: 2, bbox: [0.09, 0.27, 0.3, 0.29], quote: "Помещение 0.12 Склад ГСМ", evidence_bbox: [0.09, 0.27, 0.3, 0.29], match_score: 100 }],
        rejected: [{ reason: "QUOTE_NOT_FOUND", description: "выдумка", sha256: SHA, page: 1, quote: "нет такого" }],
      };
    });
    expect(await runAdvisor(db, insp)).toEqual({ available: true, accepted: 1, rejected: 1 });
    const s = (await db.all("select * from suspicions where inspection_id = $1", [insp])) as any[];
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ discovery_method: "LLM_ADVISOR", finding_status: "SUSPICION", rd_reference: "ПК-Р-АР, ред. 1, стр. 2" });
    expect(JSON.parse(s[0].advisor_ref_json)).toMatchObject({ file_id: "f1", page: 2, quote: "Помещение 0.12 Склад ГСМ", bbox: [0.09, 0.27, 0.3, 0.29] });
    const a = (await db.all("select * from audit_log where action = 'ADVISOR_HYPOTHESIS_REJECTED'")) as any[];
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0].details)).toMatchObject({ reason: "QUOTE_NOT_FOUND" });
    // повторный прогон не плодит дубликатов (OS-INSP-3.2.3)
    await runAdvisor(db, insp);
    expect(await db.get("select count(*) n from suspicions where inspection_id = $1", [insp])).toEqual({ n: 1 });
  });

  it("провайдер недоступен → ничего не пишется", async () => {
    setMlPost(async () => ({ provider: "ollama", available: false, accepted: [], rejected: [] }));
    expect(await runAdvisor(db, insp)).toEqual({ available: false, accepted: 0, rejected: 0 });
    expect(await db.get("select count(*) n from suspicions")).toEqual({ n: 0 });
  });
});
