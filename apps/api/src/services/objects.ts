// Раздел «Объекты» (T-166, OS-INSP-8.1.3–8.1.7): реестр объектов и карточка объекта. Только чтение — работает и на
// демо-стенде (INSPECTOR_READONLY=1). Правила — в domain/objects.ts, здесь — выборки. Запросов на реестр — постоянное
// число, независимо от числа объектов (пачка id → jsonb_array_elements_text), без обхода проверок по одной.
import type { DB } from "../db.ts";
import { isSyntheticObject } from "../domain/synthetic.ts";
import {
  documentsByStage, keyParamRow, latestChecks, pairKey, stageCounts,
  type AutoCheck, type CheckCandidate, type Decision, type KeyParamRow, type ObjectDoc, type StageCounts, type StageFragment,
} from "../domain/objects.ts";
import { HttpError } from "./inspections.ts";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/** Ключевые параметры: коды должны быть в Матрице. Неизвестный код — 400 с перечнем, а не пустая колонка. */
export async function keyParamInfo(db: DB, codes: string[]): Promise<Array<{ code: string; name: string }>> {
  const rows = await db.all<{ code: string; parameter_name: string }>("select code, parameter_name from params where code in (select jsonb_array_elements_text($1::jsonb))", [codes]);
  const by = new Map(rows.map((r) => [r.code, r.parameter_name]));
  const unknown = codes.filter((c) => !by.has(c));
  if (unknown.length) throw new HttpError(400, `Параметр не найден в Матрице: ${unknown.join(", ")}`);
  return codes.map((code) => ({ code, name: by.get(code)! }));
}

/** Строки ключевых параметров для пачки объектов: последняя проверка, стадии, решение, независимый пересчёт. */
async function keyRows(db: DB, objectIds: string[], codes: string[]): Promise<Map<string, KeyParamRow[]>> {
  const out = new Map<string, KeyParamRow[]>();
  if (!objectIds.length) return out;
  const cands = await db.all<CheckCandidate & { inspection_updated_at: unknown }>(
    // T-234: объект записи — Checks.object_id (ТЗ §10), индекс ix_checks_object
    `select c.id check_id, c.inspection_id, c.object_id, c.param_code, c.finding_status, c.verification_status, c.stage_notes_json::text stage_notes_json,
        i.updated_at inspection_updated_at
      from checks c join inspections i on i.id = c.inspection_id
      where c.object_id in (select jsonb_array_elements_text($1::jsonb)) and c.param_code in (select jsonb_array_elements_text($2::jsonb))
        and c.parent_id is null and c.verification_status != 'SPLIT'`,
    [objectIds, codes],
  );
  const latest = latestChecks(cands.map((c) => ({ ...c, inspection_updated_at: iso(c.inspection_updated_at) })));
  const checkIds = [...latest.values()].map((c) => c.check_id);
  const inspIds = [...new Set([...latest.values()].map((c) => c.inspection_id))];
  const frags = new Map<string, StageFragment[]>();
  const decs = new Map<string, Decision>();
  const loadedBy = new Map<string, StageCounts>();
  if (checkIds.length) {
    for (const f of await db.all<StageFragment & { check_id: string }>(
      "select check_id, stage, extracted_value, document_code, sheet_page from evidence_fragments where check_id in (select jsonb_array_elements_text($1::jsonb)) order by id",
      [checkIds],
    )) frags.set(f.check_id, [...(frags.get(f.check_id) ?? []), f]);
    // последнее действующее решение по записи (отменённые — superseded — не в счёт)
    for (const d of await db.all<{ check_id: string; status: string; user_name: string | null; created_at: unknown }>(
      `select distinct on (d.check_id) d.check_id, d.status, u.name user_name, d.created_at from decisions d left join users u on u.id = d.user_id
        where d.check_id in (select jsonb_array_elements_text($1::jsonb)) and not d.superseded order by d.check_id, d.id desc`,
      [checkIds],
    )) decs.set(d.check_id, { status: d.status, by: d.user_name, at: iso(d.created_at) });
    const perInsp = new Map<string, Array<{ doc_stage: string; n: number }>>();
    for (const r of await db.all<{ inspection_id: string; doc_stage: string; n: number }>(
      "select inspection_id, doc_stage, count(*)::int n from files where inspection_id in (select jsonb_array_elements_text($1::jsonb)) group by inspection_id, doc_stage",
      [inspIds],
    )) perInsp.set(r.inspection_id, [...(perInsp.get(r.inspection_id) ?? []), r]);
    for (const id of inspIds) loadedBy.set(id, stageCounts(perInsp.get(id) ?? []));
  }
  // стадии объекта целиком — для параметра, который ещё не проверялся
  const objLoaded = await objectStageCounts(db, objectIds);
  const autos = new Map<string, AutoCheck>();
  for (const v of await db.all<{ object_id: string; param_code: string; verdict: string; method: string; checked_at: unknown }>(
    `select distinct on (object_id, param_code) object_id, param_code, verdict, method, checked_at from param_verifications
      where object_id in (select jsonb_array_elements_text($1::jsonb)) and param_code in (select jsonb_array_elements_text($2::jsonb))
      order by object_id, param_code, checked_at desc, id desc`,
    [objectIds, codes],
  )) autos.set(pairKey(v.object_id, v.param_code), { verdict: v.verdict, method: v.method, checked_at: iso(v.checked_at) });
  for (const oid of objectIds) {
    out.set(oid, codes.map((code) => {
      const check = latest.get(pairKey(oid, code)) ?? null;
      return keyParamRow(code, {
        check,
        loaded: check ? loadedBy.get(check.inspection_id)! : (objLoaded.get(oid) ?? { PD: 0, RD: 0, ID: 0 }),
        fragments: check ? (frags.get(check.check_id) ?? []) : [],
        decision: check ? (decs.get(check.check_id) ?? null) : null,
        autoCheck: autos.get(pairKey(oid, code)) ?? null,
      });
    }));
  }
  return out;
}

/** Число разных файлов (по SHA-256) каждой стадии по объектам — повторная загрузка того же файла не удваивает счёт. */
async function objectStageCounts(db: DB, objectIds: string[]): Promise<Map<string, StageCounts>> {
  const per = new Map<string, Array<{ doc_stage: string; n: number }>>();
  for (const r of await db.all<{ object_id: string; doc_stage: string; n: number }>(
    "select object_id, doc_stage, count(distinct sha256)::int n from files where object_id in (select jsonb_array_elements_text($1::jsonb)) group by object_id, doc_stage",
    [objectIds],
  )) per.set(r.object_id, [...(per.get(r.object_id) ?? []), r]);
  return new Map(objectIds.map((id) => [id, stageCounts(per.get(id) ?? [])]));
}

interface ObjRow { id: string; name: string; address: string | null; profile_json: string | null; created_at: unknown }
const objectHead = (o: ObjRow) => {
  let profile: Record<string, unknown> | null = null;
  try {
    profile = o.profile_json ? JSON.parse(o.profile_json) : null;
  } catch {
    profile = null;
  }
  // NFR-PDN (минимизация): в реестре — только название и адрес; застройщик и подрядчик не выводятся
  return { id: o.id, name: o.name, address: o.address ?? "", synthetic: isSyntheticObject({ name: o.name, profile }), created_at: iso(o.created_at) };
};

/** Реестр объектов (OS-INSP-8.1.3, 8.1.4): последние по активности — первыми. */
export async function listObjects(db: DB, codes: string[], limit: number, offset: number) {
  const key_params = await keyParamInfo(db, codes);
  const objs = await db.all<ObjRow & { last_at: unknown; n: number }>(
    `select o.id, o.name, o.address, o.profile_json::text profile_json, o.created_at, max(i.updated_at) last_at, count(i.id)::int n
      from objects o left join inspections i on i.object_id = o.id
      group by o.id order by max(i.updated_at) desc nulls last, o.id limit $1 offset $2`,
    [limit, offset],
  );
  const ids = objs.map((o) => o.id);
  const counts = await objectStageCounts(db, ids);
  const lastInsp = new Map<string, { id: string; status: string; updated_at: string }>();
  if (ids.length) {
    for (const r of await db.all<{ object_id: string; id: string; status: string; updated_at: unknown }>(
      `select distinct on (object_id) object_id, id, status, updated_at from inspections where object_id in (select jsonb_array_elements_text($1::jsonb))
        order by object_id, updated_at desc, id desc`,
      [ids],
    )) lastInsp.set(r.object_id, { id: r.id, status: r.status, updated_at: iso(r.updated_at) });
  }
  const keys = await keyRows(db, ids, codes);
  return {
    key_params,
    objects: objs.map((o) => ({
      ...objectHead(o),
      stage_files: counts.get(o.id)!,
      inspections_count: o.n,
      last_inspection: lastInsp.get(o.id) ?? null,
      key_param_rows: keys.get(o.id)!,
    })),
  };
}

/** Карточка объекта (OS-INSP-8.1.3, 8.1.4, 8.1.6): документы по стадиям (пустые — видны), журнал проверок, ключевые параметры. */
export async function objectCard(db: DB, id: string, codes: string[]) {
  const key_params = await keyParamInfo(db, codes);
  const o = await db.get<ObjRow>("select id, name, address, profile_json::text profile_json, created_at from objects where id = $1", [id]);
  if (!o) throw new HttpError(404, "Объект не найден");
  const files = await db.all<ObjectDoc & { uploaded_at: unknown }>(
    "select id, file_name, sha256, doc_stage, document_code, revision, doc_title, revision_role, inspection_id, uploaded_at from files where object_id = $1",
    [id],
  );
  const documents = documentsByStage(files.map((f) => ({ ...f, uploaded_at: iso(f.uploaded_at) })));
  const inspRows = await db.all<{ id: string; status: string; scenario: string | null; protocol_version: number; created_at: unknown; updated_at: unknown; finalized_at: unknown; files: number }>(
    `select i.id, i.status, i.scenario, i.protocol_version, i.created_at, i.updated_at, i.finalized_at, (select count(*)::int from files f where f.inspection_id = i.id) files
      from inspections i where i.object_id = $1 order by i.updated_at desc, i.id desc`,
    [id],
  );
  const keys = await keyRows(db, [id], codes);
  // T-234 (ТЗ §10 Protocols.object_id): версии протоколов объекта по всем его проверкам — журнал выпусков объекта
  const protoRows = await db.all<{ inspection_id: string; version: number; status: string; matrix_version: string | null; model_version: string | null; created_at: unknown; finalized_at: unknown }>(
    `select inspection_id, version, status, matrix_version, model_version, created_at, finalized_at from protocols where object_id = $1
      order by created_at desc, inspection_id, version desc limit 200`,
    [id],
  );
  return {
    protocols: protoRows.map((p) => ({ inspection_id: p.inspection_id, version: p.version, status: p.status, matrix_version: p.matrix_version, model_version: p.model_version, created_at: iso(p.created_at), finalized_at: isoOrNull(p.finalized_at) })),
    key_params,
    object: objectHead(o),
    stage_files: { PD: documents.PD.length, RD: documents.RD.length, ID: documents.ID.length },
    documents,
    inspections: inspRows.map((r) => ({ id: r.id, status: r.status, scenario: r.scenario, protocol_version: r.protocol_version, files: r.files, created_at: iso(r.created_at), updated_at: iso(r.updated_at), finalized_at: isoOrNull(r.finalized_at) })),
    key_param_rows: keys.get(id)!,
  };
}
