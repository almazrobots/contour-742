// Слой L8 в пересчёте протокола (T-177, ADR-0008 п. 2): данные ворот, отметки изменений из разбора, контекст проверки
// и корни каскадов. Предметная логика — domain/verify-l8.ts; здесь только чтение базы и файлов данных.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import type { ApprovedChange } from "../domain/changes.ts";
import type { Fragment, Param, RevisionRole, ApprovalStatus, Stage } from "../domain/types.ts";
import {
  GateConfigSchema, ParamDepsSchema, cascadeRoots, changeNo, unitOf,
  type ChangeMark, type FragmentFacts, type GateConfig, type L8Context, type PageQuality, type ParamDeps, type RevisionInfo, type SearchedSheet,
} from "../domain/verify-l8.ts";
import type { FindingStatus } from "../domain/types.ts";
import { listChanges } from "./changes.ts";
import type { MlResponse } from "./ml-client.ts";

let data: { gates: GateConfig; deps: ParamDeps } | null = null;

/** Настройки ворот и граф зависимостей — справочники в data/seed; читаются один раз, битые — громкий отказ. */
export function l8Data(): { gates: GateConfig; deps: ParamDeps } {
  if (data) return data;
  const read = (f: string) => JSON.parse(readFileSync(join(config.root, "data/seed", f), "utf8"));
  data = { gates: GateConfigSchema.parse(read("l8-gates.json")), deps: ParamDepsSchema.parse(read("param-deps.json")) };
  return data;
}

/** json-колонка: драйвер отдаёт разобранной или строкой — оба вида. */
const js = <T>(x: unknown): T | null => (x == null ? null : typeof x === "string" ? (JSON.parse(x) as T) : (x as T));

const KINDS = new Set(["cloud", "callout", "stamp_row"]);
/** Рамка — четыре числа в долях листа [0;1] (OWASP T-177 SEC-08); иное — нет рамки. */
const box = (b: unknown): [number, number, number, number] | null =>
  Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && x >= 0 && x <= 1) ? (b as [number, number, number, number]) : null;
const MAX_PAGE = 100_000;

/**
 * Сохранить отметки изменений из разбора ML (IDN-03/04). Вызывается в транзакции разбора. Ответ ML — вход от модуля,
 * читающего недоверенные PDF: берутся только известные виды, номер и текст обрезаются, рамка — четыре конечных числа.
 */
export async function saveChangeMarks(db: DB, fileId: string, res: Pick<MlResponse, "change_marks">): Promise<void> {
  await db.run("delete from change_marks where file_id = $1", [fileId]);
  for (const m of (res.change_marks ?? []).slice(0, 2000)) {
    if (!KINDS.has(m.kind) || !Number.isInteger(m.page) || m.page < 1 || m.page > MAX_PAGE) continue;
    const b = box(m.bbox);
    await db.run("insert into change_marks (file_id, page, kind, number, bbox_json, text) values ($1,$2,$3,$4,$5,$6)", [
      fileId, m.page, m.kind, typeof m.number === "string" ? m.number.slice(0, 20) : null, b ? JSON.stringify(b) : null, String(m.text ?? "").slice(0, 300),
    ]);
  }
}

/** Всё о пакете, что нужно слою L8 для любого параметра: читается один раз за пересчёт. */
export interface PackageL8 {
  revisions: RevisionInfo[];
  marks: ChangeMark[];
  changes: ApprovedChange[];
  searched: SearchedSheet[];
  quality: Map<string, PageQuality>; // file@page → качество страницы
  docKind: Map<string, string | null>; // file → вид документа
}

export async function loadPackageL8(t: DB, inspectionId: string): Promise<PackageL8> {
  const files = await t.all<{ id: string; doc_stage: Stage; document_code: string; revision: string; revision_role: RevisionRole | null; approval_status: ApprovalStatus | null; parse_status: string; pages_json: unknown; doc_type: string | null }>(
    "select id, doc_stage, document_code, revision, revision_role, approval_status, parse_status, pages_json, doc_type from files where inspection_id = $1 order by uploaded_at, id", [inspectionId]);
  const rows = await t.all<{ file_id: string; page: number; kind: ChangeMark["kind"]; number: string | null; bbox_json: unknown; text: string }>(
    "select m.file_id, m.page, m.kind, m.number, m.bbox_json, m.text from change_marks m join files f on f.id = m.file_id where f.inspection_id = $1 order by m.id", [inspectionId]);
  const marks: ChangeMark[] = rows.map((r) => ({ file_id: r.file_id, page: r.page, kind: r.kind, number: r.number, bbox: box(js(r.bbox_json)), text: r.text }));
  const stamp = new Map<string, number>();
  for (const m of marks) {
    const n = m.kind === "stamp_row" ? Number(changeNo(m.number)) : NaN;
    if (Number.isFinite(n)) stamp.set(m.file_id, Math.max(stamp.get(m.file_id) ?? 0, n));
  }
  const quality = new Map<string, PageQuality>();
  const searched: SearchedSheet[] = [];
  for (const f of files) {
    const pages = js<Array<{ page: number; quality?: string }>>(f.pages_json) ?? [];
    for (const p of pages) if (p.quality === "OK" || p.quality === "LOW_QUALITY" || p.quality === "ABSTAIN") quality.set(`${f.id}@${p.page}`, p.quality);
    searched.push({
      file_id: f.id, stage: f.doc_stage, document_code: f.document_code, pages: f.pages_json ? pages.length : null, parsed: f.parse_status === "DONE",
      low_quality_pages: pages.filter((p) => p.quality === "LOW_QUALITY" || p.quality === "ABSTAIN").map((p) => p.page),
    });
  }
  return {
    revisions: files.map((f) => ({ file_id: f.id, stage: f.doc_stage, document_code: f.document_code, revision: f.revision, role: f.revision_role ?? "UNRESOLVED", approval_status: f.approval_status, stamp_change: stamp.get(f.id) ?? null })),
    marks,
    changes: await listChanges(t, inspectionId),
    searched,
    quality,
    docKind: new Map(files.map((f) => [f.id, f.doc_type])),
  };
}

/** Извлечение параметра, по которому слой узнаёт уверенность и единицу фрагмента. */
export interface RowFacts {
  file_id: string;
  page: number;
  raw: string | null;
  confidence: number | null;
}

/** normRule — паспорт вида с нормой (T-233): ожидаемое — сама норма пункта СП, а не фрагмент ПД (как min/max Матрицы).
 * Контекст слоя для одного параметра: факты фрагмента — лучшее извлечение этого параметра на той же странице. */
export function contextFor(pkg: PackageL8, param: Pick<Param, "code" | "compare">, op: string, unitsNormalized: boolean, rows: RowFacts[], normRule = false): L8Context {
  const at = new Map<string, RowFacts>();
  for (const r of rows) {
    const k = `${r.file_id}@${r.page}`;
    const cur = at.get(k);
    if (!cur || (r.confidence ?? 0) > (cur.confidence ?? 0)) at.set(k, r);
  }
  const facts = (f: Fragment): FragmentFacts => {
    const r = at.get(`${f.file_id}@${f.page}`);
    return { confidence: r?.confidence ?? null, quality: pkg.quality.get(`${f.file_id}@${f.page}`) ?? null, doc_kind: pkg.docKind.get(f.file_id) ?? null, unit: unitOf(r?.raw) };
  };
  const { gates } = l8Data();
  return {
    param_code: param.code, op, threshold_rule: normRule || param.compare.kind === "min" || param.compare.kind === "max", units_normalized: unitsNormalized, gates, facts,
    revisions: pkg.revisions, changes: pkg.changes, marks: pkg.marks, searched: pkg.searched,
  };
}

/** VER-12: корни каскадов по текущим статусам параметров проверки — в поле derived_from (остальным — null). */
export async function writeCascades(t: DB, inspectionId: string): Promise<number> {
  const rows = await t.all<{ id: string; param_code: string; finding_status: FindingStatus; derived_from: string | null }>(
    "select id, param_code, finding_status, derived_from from checks where inspection_id = $1 and parent_id is null", [inspectionId]);
  const roots = cascadeRoots(new Map(rows.map((r) => [r.param_code, r.finding_status])), l8Data().deps);
  let n = 0;
  for (const r of rows) {
    const next = roots.get(r.param_code)?.join(", ") ?? null;
    if (next !== r.derived_from) await t.run("update checks set derived_from = $1 where id = $2", [next, r.id]);
    if (next) n++;
  }
  return n;
}
