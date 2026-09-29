// OS-INSP-6.1.4–6.1.9 (ТЗ 14.2-04, 9.4.2-03; T-137): IO печати скрытого теста — таблицы hidden_seals и hidden_seal_runs
// (миграция 0008, только добавление), гарды GOLD-выпуска и дообучения. Предметная логика — domain/hidden-seal.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DB } from "../db.ts";
import { eligible, type GoldCandidate } from "../domain/gold.ts";
import {
  checkReseal, goldExclusion, makeSeal, SealError, sealCounts, thresholdGuard, verifyFiles, type Seal, type SealFile, type ShaItem,
} from "../domain/hidden-seal.ts";
import { audit } from "./audit.ts";
import { HttpError, type Ctx } from "./inspections.ts";

export const SealBody = z.object({
  name: z.string().min(1).max(100),
  files: z.array(z.object({ sha256: z.string().max(64), role: z.enum(["input", "labels"]) })).min(1).max(100_000),
});
export const RunBody = z.object({
  answer_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  model_version: z.string().min(1).max(200),
});
export const VerifyBody = z.object({ shas: z.array(z.string().max(64)).max(100_000) });

interface SealRow {
  name: string;
  digest: string;
  files_json: string;
  n_files: number;
  n_labels: number;
  sealed_at: string;
  sealed_by: string;
}

const summary = ({ files_json: _f, ...r }: SealRow) => r;

/** Печати из репозитория, прочитанные при старте (syncRepoSeals). Гарды учитывают их всегда, что бы ни лежало в базе:
 *  печать, заранее созданная в базе под тем же именем, не выключает печать репозитория (OWASP T-137 E1-M1). */
let repoSeals: Seal[] = [];

/** Все печати с файлами (для гардов): база плюс печати репозитория, которых в базе нет с тем же отпечатком. */
export async function loadSeals(db: DB): Promise<Seal[]> {
  const rows = await db.all<SealRow>("select * from hidden_seals order by name");
  const fromDb = rows.map((r) => ({ name: r.name, digest: r.digest, sealed_at: r.sealed_at, files: JSON.parse(r.files_json) as SealFile[] }));
  const digests = new Set(fromDb.map((s) => s.digest));
  return [...fromDb, ...repoSeals.filter((s) => !digests.has(s.digest))];
}

async function sealRow(db: DB, name: string): Promise<SealRow> {
  const r = await db.get<SealRow>("select * from hidden_seals where name = $1", [name]);
  if (!r) throw new HttpError(404, `Печать «${name}» не найдена`);
  return r;
}

/** OS-INSP-6.1.4: запечатать скрытый тест. Повтор того же состава — 200 без новой записи, другой состав — 409. */
export async function createSeal(ctx: Ctx, body: z.infer<typeof SealBody>): Promise<{ created: boolean; seal: Omit<SealRow, "files_json"> }> {
  let seal: Seal;
  try {
    seal = makeSeal(body.name, body.files, new Date().toISOString());
  } catch (e) {
    if (e instanceof SealError) throw new HttpError(400, e.message);
    throw e;
  }
  type Created = { created: boolean; seal: Omit<SealRow, "files_json"> };
  const out = await ctx.db.tx(async (t): Promise<Created | { refused: string; existing: string }> => {
    await t.run("select pg_advisory_xact_lock(hashtext('inspector:hidden-seal'))");
    const existing = await t.get<SealRow>("select * from hidden_seals where name = $1", [seal.name]);
    const r = checkReseal(existing ?? null, seal);
    if (!r.ok) return { refused: r.reason, existing: existing!.digest };
    if (r.same) return { created: false, seal: summary(existing!) };
    const { n_files, n_labels } = sealCounts(seal);
    await t.run("insert into hidden_seals (name, digest, files_json, n_files, n_labels, sealed_at, sealed_by) values ($1,$2,$3,$4,$5,$6,$7)",
      [seal.name, seal.digest, JSON.stringify(seal.files), n_files, n_labels, seal.sealed_at, ctx.user.id]);
    await audit({ ...ctx, db: t }, "HIDDEN_SEAL_CREATED", seal.name, { digest: seal.digest, n_files, n_labels });
    return { created: true, seal: summary((await t.get<SealRow>("select * from hidden_seals where name = $1", [seal.name]))!) };
  });
  if ("refused" in out) {
    // отказ пишется в аудит вне транзакции печати: откат не должен стирать попытку подменить состав
    await audit(ctx, "HIDDEN_SEAL_REFUSED", seal.name, { digest: seal.digest, existing: out.existing });
    throw new HttpError(409, out.refused, { code: "HIDDEN_SEAL_CONFLICT", digest: out.existing });
  }
  return out;
}

/** Автор печатей, пришедших из репозитория (ml/eval/seals), — в hidden_seals.sealed_by и в аудите. */
export const REPO_SEALS_ACTOR = { id: "system:repo-seals", login: "system:repo-seals", name: "Печати скрытого теста из репозитория", role: "system" } as const;

export interface RepoSealsResult {
  /** сколько печатей репозитория прочитано и прошло сверку отпечатка */
  found: number;
  added: string[];
  same: string[];
  conflicts: Array<{ name: string; repo: string; db: string }>;
  invalid: Array<{ file: string; reason: string }>;
}

/** OS-INSP-6.1.4: печати из репозитория дописываются в hidden_seals при старте API. Отпечаток пересчитывается: подменённый
 *  состав не принимается. Печать с тем же именем и другим отпечатком в базе не перезаписывается (печать только
 *  добавляется) — конфликт уходит в аудит и в журнал. Без этого гарды 6.1.6, 6.1.8, 6.1.9 не знают о тесте организатора. */
export async function syncRepoSeals(db: DB, dir: string): Promise<RepoSealsResult> {
  const out: RepoSealsResult = { found: 0, added: [], same: [], conflicts: [], invalid: [] };
  const valid: Seal[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    repoSeals = [];
    return out;
  }
  const ctx: Ctx = { db, user: REPO_SEALS_ACTOR };
  for (const file of names) {
    let seal: Seal;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as { name?: unknown; files?: unknown; digest?: unknown; sealed_at?: unknown };
      seal = makeSeal(String(raw.name), raw.files as SealFile[], String(raw.sealed_at));
      if (seal.digest !== raw.digest) throw new SealError("отпечаток не сходится с составом — печать подменена");
    } catch (e) {
      out.invalid.push({ file, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    valid.push(seal);
    out.found++;
    const existing = await db.get<SealRow>("select * from hidden_seals where name = $1", [seal.name]);
    const r = checkReseal(existing ?? null, seal);
    if (!r.ok) {
      out.conflicts.push({ name: seal.name, repo: seal.digest, db: existing!.digest });
      await audit(ctx, "HIDDEN_SEAL_REFUSED", seal.name, { digest: seal.digest, existing: existing!.digest, source: "repo" });
      continue;
    }
    if (r.same) {
      out.same.push(seal.name);
      continue;
    }
    const { n_files, n_labels } = sealCounts(seal);
    await db.tx(async (t) => {
      await t.run("insert into hidden_seals (name, digest, files_json, n_files, n_labels, sealed_at, sealed_by) values ($1,$2,$3,$4,$5,$6,$7) on conflict (name) do nothing",
        [seal.name, seal.digest, JSON.stringify(seal.files), n_files, n_labels, seal.sealed_at, REPO_SEALS_ACTOR.id]);
      await audit({ ...ctx, db: t }, "HIDDEN_SEAL_CREATED", seal.name, { digest: seal.digest, n_files, n_labels, source: "repo" });
    });
    out.added.push(seal.name);
  }
  repoSeals = valid;
  return out;
}

/** OWASP T-137 E3-H1: в профиле gpu API без печатей скрытого теста не стартует — иначе гарды 6.1.6/6.1.8/6.1.9 слепы
 *  молча (печати не доехали до образа). Конфликт отпечатка или подменённая печать — тоже отказ старта: это попытка
 *  выключить печать. В dev — только журнал. */
export function assertRepoSeals(r: RepoSealsResult, profile: string): void {
  if (profile !== "gpu") return;
  if (r.found === 0) throw new Error("Печати скрытого теста не найдены (ml/eval/seals): гарды OS-INSP-6.1.6/6.1.8/6.1.9 не работали бы — старт отменён");
  if (r.conflicts.length) throw new Error(`Печать скрытого теста в базе расходится с репозиторием: ${r.conflicts.map((c) => c.name).join(", ")} — старт отменён`);
  if (r.invalid.length) throw new Error(`Печать скрытого теста не прошла сверку отпечатка: ${r.invalid.map((i) => i.file).join(", ")} — старт отменён`);
}

export async function listSeals(db: DB, limit: number, offset: number) {
  return (await db.all<SealRow>("select * from hidden_seals order by sealed_at desc, name limit $1 offset $2", [limit, offset])).map(summary);
}

/** OS-INSP-6.1.5: сверка файлов прогона с печатью (SHA-256 файлов каталога прогона). */
export async function verifySeal(ctx: Ctx, name: string, shas: string[]) {
  const row = await sealRow(ctx.db, name);
  let r: ReturnType<typeof verifyFiles>;
  try {
    r = verifyFiles({ files: JSON.parse(row.files_json) }, shas);
  } catch (e) {
    if (e instanceof SealError) throw new HttpError(400, e.message);
    throw e;
  }
  await audit(ctx, r.ok ? "HIDDEN_SEAL_VERIFIED" : "HIDDEN_SEAL_MISMATCH", name, { added: r.added.length, missing: r.missing.length });
  return { name, digest: row.digest, ...r };
}

/** OS-INSP-6.1.7: записать ответ в журнал печати до подсчёта балла. */
export async function commitRun(ctx: Ctx, name: string, body: z.infer<typeof RunBody>) {
  return ctx.db.tx(async (t) => {
    await sealRow(t, name);
    const sha = body.answer_sha256.toLowerCase();
    if (await t.get("select 1 from hidden_seal_runs where seal_name = $1 and answer_sha256 = $2", [name, sha])) {
      throw new HttpError(409, `Ответ ${sha.slice(0, 12)}… уже записан в журнал печати «${name}»`);
    }
    const r = await t.run("insert into hidden_seal_runs (seal_name, answer_sha256, model_version, committed_at, committed_by) values ($1,$2,$3,$4,$5) returning id",
      [name, sha, body.model_version, new Date().toISOString(), ctx.user.id]);
    await audit({ ...ctx, db: t }, "HIDDEN_SEAL_RUN_COMMITTED", name, { answer_sha256: sha, model_version: body.model_version });
    return (await t.get<Record<string, unknown>>("select * from hidden_seal_runs where id = $1", [r.rows[0].id]))!;
  });
}

export async function listRuns(db: DB, name: string, limit: number, offset: number) {
  await sealRow(db, name);
  return await db.all("select * from hidden_seal_runs where seal_name = $1 order by id limit $2 offset $3", [name, limit, offset]);
}

// Файлы решения — все файлы его проверки и файлы фрагментов доказательств (фрагмент мог сохранить SHA-256 файла,
// которого уже нет в пакете). По ним решение относится к скрытому тесту (6.1.8, 6.1.9).
const SHAS_SQL = `select c.id finding_id, x.sha256 from checks c
  join lateral (select f.sha256 from files f where f.inspection_id = c.inspection_id
    union select e.sha256 from evidence_fragments e where e.check_id = c.id and e.sha256 is not null) x on true`;

async function shaMap(db: DB, where: string, params: unknown[]): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  for (const r of await db.all<{ finding_id: string; sha256: string }>(`${SHAS_SQL} ${where}`, params)) {
    m.set(r.finding_id, [...(m.get(r.finding_id) ?? []), r.sha256]);
  }
  return m;
}

/**
 * OS-INSP-6.1.8: кандидаты GOLD без решений по файлам скрытого теста. excluded_hidden — сколько решений, годных
 * в GOLD (6.1.1), исключено. Ходит в базу только через переданный db (вызывается внутри транзакции выпуска).
 */
export async function withoutHidden<T extends GoldCandidate>(db: DB, cands: T[]): Promise<{ cands: T[]; excluded_hidden: number }> {
  const seals = await loadSeals(db);
  if (!seals.length) return { cands, excluded_hidden: 0 };
  const shas = await shaMap(db, "join inspections i on i.id = c.inspection_id where i.status = 'FINALIZED'", []);
  const r = goldExclusion(cands.map((c) => ({ ...c, file_shas: shas.get(c.finding_id) ?? [] })), seals);
  const kept = new Set(r.kept.map((k) => k.finding_id));
  return { cands: cands.filter((c) => kept.has(c.finding_id)), excluded_hidden: r.excluded.filter(eligible).length };
}

/**
 * OS-INSP-6.1.8, 6.1.9: причины отказа в дообучении по выпуску. В выпуске есть решения по файлам скрытого теста —
 * отказ; validation пересекается со скрытым тестом (файлы любой печати по SHA-256 или объекты выборки test набора) —
 * порог не подбирается, отказ с перечнем. Пустой reasons — обучать можно.
 */
export async function trainingGuard(db: DB, datasetVersion: string): Promise<{ reasons: string[]; details: Record<string, unknown> }> {
  const seals = await loadSeals(db);
  const items = await db.all<{ finding_id: string; split: string; object_group_id: string }>(
    "select finding_id, split, object_group_id from dataset_items where dataset_version = $1 order by finding_id", [datasetVersion]);
  const shas = seals.length ? await shaMap(db, "join dataset_items di on di.finding_id = c.id where di.dataset_version = $1", [datasetVersion]) : new Map<string, string[]>();
  const withShas: Array<ShaItem & { split: string }> = items.map((i) => ({ finding_id: i.finding_id, split: i.split, object_id: i.object_group_id, file_shas: shas.get(i.finding_id) ?? [] }));
  const reasons: string[] = [];
  const details: Record<string, unknown> = {};
  const hidden = goldExclusion(withShas, seals);
  if (hidden.count) {
    reasons.push(`В выпуске ${datasetVersion} есть решения по файлам скрытого теста (${hidden.count}): обучение на скрытом тесте запрещено (ТЗ 9.4.2) — выпустите набор заново`);
    details.hidden_test = { count: hidden.count, finding_ids: hidden.excluded.map((i) => i.finding_id) };
  }
  const tg = thresholdGuard(withShas.filter((i) => i.split === "validation"), seals, withShas.filter((i) => i.split === "test").map((i) => i.object_id));
  if (tg) {
    reasons.push(tg.reason);
    details.threshold_overlap = { shas: tg.shas, object_ids: tg.object_ids };
  }
  return { reasons, details };
}
