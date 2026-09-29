// Совпадения выборкой (T-110; кандидаты OS-INSP-4.1.8–4.1.11): план выборки и приёмка партии.
// Предметная логика — domain/sample-accept.ts; здесь только IO. Выборка воспроизводится: seed выводится из проверки
// и версии протокола, поэтому инспектор видит ту же выборку после перезагрузки экрана.
import { createHash } from "node:crypto";
import type { DB } from "../db.ts";
import { acceptOutcome, drawSample, samplePool, upperBound, type PoolCheck } from "../domain/sample-accept.ts";
import { audit } from "./audit.ts";
import { HttpError, lockInspection, type Ctx } from "./inspections.ts";
import { canVerify } from "../domain/lifecycle.ts";

export const SAMPLE_SIZE = 30;

interface Row extends PoolCheck {
  parameter_name: string | null;
  section: string | null;
  expected_value: string | null;
  actual_value: string | null;
}

async function poolOf(db: DB, inspectionId: string): Promise<Row[]> {
  const rows = await db.all<Row>(
    `select c.id, c.param_code, c.finding_status, c.verification_status, c.review_priority, c.expected_value, c.actual_value,
        p.parameter_name, p.section,
        (select f.file_id from evidence_fragments f where f.check_id = c.id order by f.id limit 1) file_id,
        (select min(e.confidence) from evidence_fragments f join extractions e
            on e.file_id = f.file_id and e.param_code = c.param_code and e.page is not distinct from f.sheet_page
          where f.check_id = c.id) min_confidence
       from checks c left join params p on p.code = c.param_code
      where c.inspection_id = $1 and c.parent_id is null`,
    [inspectionId],
  );
  return samplePool(rows);
}

/** seed выборки: из проверки и версии протокола — одна версия, одна выборка. */
async function seedOf(db: DB, inspectionId: string): Promise<number> {
  const v = await db.get<{ v: number | null }>("select max(version) v from protocols where inspection_id = $1", [inspectionId]);
  return parseInt(createHash("sha256").update(`${inspectionId}:${v?.v ?? 0}`).digest("hex").slice(0, 8), 16);
}

/** План выборки: объём партии, seed и карточки выборки с доказательствами на листах. */
export async function samplePlan(db: DB, inspectionId: string): Promise<Record<string, any>> {
  const pool = await poolOf(db, inspectionId);
  const seed = await seedOf(db, inspectionId);
  const sample = drawSample(pool, SAMPLE_SIZE, seed);
  const frags = sample.length
    ? await db.all<Record<string, any>>(
        "select check_id, file_id, stage, document_code, revision, sheet_page, bbox_polygon_norm, extracted_value, role_expected_actual from evidence_fragments where check_id in (select jsonb_array_elements_text($1::jsonb)) order by id",
        [JSON.stringify(sample.map((s) => s.id))],
      )
    : [];
  const accepted = await db.get<Record<string, any>>("select * from sample_acceptances where inspection_id = $1 order by id desc limit 1", [inspectionId]);
  return {
    seed,
    pool_size: pool.length,
    sample_size: sample.length,
    bound_if_clean: upperBound(sample.length),
    last_acceptance: accepted ?? null,
    sample: sample.map((s) => ({ ...s, fragments: frags.filter((f) => f.check_id === s.id) })),
  };
}

/** Приёмка партии: пересчёт выборки по seed на сервере, исход — по доменному правилу, запись — одной транзакцией. */
export async function acceptSample(ctx: Ctx, inspectionId: string, body: { seed: number; reviewed: string[]; errors: string[] }): Promise<Record<string, any>> {
  return ctx.db.tx(async (t) => {
    const insp = await lockInspection(t, inspectionId);
    if (!canVerify(insp.status)) throw new HttpError(409, insp.status === "FINALIZED" ? "Протокол финализирован: решения неизменяемы" : `Верификация недоступна в статусе ${insp.status}`);
    const seed = await seedOf(t, inspectionId);
    if (seed !== body.seed) throw new HttpError(409, "Протокол изменился после показа выборки — откройте выборку заново");
    const pool = await poolOf(t, inspectionId);
    const sample = drawSample(pool, SAMPLE_SIZE, seed);
    const out = acceptOutcome({ poolSize: pool.length, sample: sample.map((s) => s.id), reviewed: body.reviewed, errors: body.errors });
    if (out.kind === "INVALID") throw new HttpError(400, out.reason);
    if (out.kind === "INCOMPLETE") throw new HttpError(409, `Выборка просмотрена не полностью: осталось ${out.left}`);
    if (out.kind === "BROKEN") {
      await audit({ ...ctx, db: t }, "SAMPLE_BROKEN", inspectionId, { seed, pool_size: pool.length, errors: out.errors });
      return { outcome: "BROKEN", errors: out.errors, pool_size: pool.length };
    }
    await t.run(
      "insert into sample_acceptances (inspection_id, user_id, seed, pool_size, sample_size, upper_bound, sample_ids, pool_ids, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [inspectionId, ctx.user.id, seed, pool.length, sample.length, out.bound, JSON.stringify(sample.map((s) => s.id)), JSON.stringify(pool.map((p) => p.id)), new Date().toISOString()],
    );
    await t.run("update checks set verification_status = 'NEGATIVE_VERIFIED', updated_at = $1 where id in (select jsonb_array_elements_text($2::jsonb))", [new Date().toISOString(), JSON.stringify(pool.map((p) => p.id))]);
    await audit({ ...ctx, db: t }, "SAMPLE_ACCEPTED", inspectionId, { seed, pool_size: pool.length, sample_size: sample.length, upper_bound: out.bound });
    return { outcome: "ACCEPTED", accepted: pool.length, sample_size: sample.length, upper_bound: out.bound };
  });
}
