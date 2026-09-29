// Общий раздел «Файлы»: листинг всех обработанных файлов с пагинацией и извлечёнными параметрами.
// Только чтение: files + extractions (+ объект для подписи). Параметры — одним запросом на страницу, без N+1.
import type { DB } from "../db.ts";

export interface FilesQuery {
  limit: number;
  offset: number;
  q?: string; // подстрока имени файла или шифра документа
  status?: string; // parse_status
  docType?: string;
  objectId?: string;
}

/** Сводка по параметру файла: сколько раз найден и сколько разных значений. Сами упоминания — отдельным запросом. */
export interface FileParamSummary {
  param_code: string;
  name: string | null; // название из Матрицы; null — код вне Матрицы (служебный факт)
  section: string | null;
  in_matrix: boolean;
  mentions: number;
  distinct_values: number;
}

export interface FileMention {
  id: number;
  param_code: string;
  raw: string | null;
  value_num: number | null;
  value_text: string | null;
  page: number | null;
  confidence: number | null;
  line_text: string | null;
}

const LINE_MAX = 140;

export async function listFiles(db: DB, f: FilesQuery) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (cond: string, v: unknown) => {
    args.push(v);
    where.push(cond.replaceAll("?", `$${args.length}`));
  };
  if (f.q) add("(f.file_name ilike ? or f.document_code ilike ?)", `%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
  if (f.status) add("f.parse_status = ?", f.status);
  if (f.docType) add("f.doc_type = ?", f.docType);
  if (f.objectId) add("f.object_id = ?", f.objectId);
  const cond = where.length ? `where ${where.join(" and ")}` : "";
  const total = (await db.get<{ n: number }>(`select count(*)::int n from files f ${cond}`, args))?.n ?? 0;
  const n = args.length;
  const rows = await db.all<any>(
    `select f.id, f.inspection_id, f.object_id, o.name object_name, f.file_name, f.kind, f.doc_type, f.doc_title, f.document_code,
        f.doc_stage, f.size, f.parse_status, f.parse_error, f.engine, f.pages_json, f.uploaded_at
       from files f left join objects o on o.id = f.object_id ${cond}
       order by f.uploaded_at desc, f.id limit $${n + 1} offset $${n + 2}`,
    [...args, f.limit, f.offset],
  );
  const byFile = new Map<string, FileParamSummary[]>();
  if (rows.length) {
    const ph = rows.map((_, i) => `$${i + 1}`).join(",");
    for (const e of await db.all<any>(
      `select e.file_id, e.param_code, p.parameter_name name, p.section, count(*)::int mentions,
              count(distinct coalesce(e.raw, e.value_text, e.value_num::text))::int distinct_values
         from extractions e left join params p on p.code = e.param_code
        where e.file_id in (${ph}) group by e.file_id, e.param_code, p.parameter_name, p.section
        order by e.file_id, e.param_code`,
      rows.map((r) => r.id),
    )) {
      const { file_id, ...p } = e;
      (byFile.get(file_id) ?? byFile.set(file_id, []).get(file_id)!).push({ ...p, in_matrix: p.name != null });
    }
  }
  const items = rows.map(({ pages_json, ...r }) => {
    const pages = typeof pages_json === "string" ? JSON.parse(pages_json) : pages_json;
    const params = byFile.get(r.id) ?? [];
    return { ...r, pages: Array.isArray(pages) ? pages.length : 0, mentions: params.reduce((n, p) => n + p.mentions, 0), params };
  });
  return { total, limit: f.limit, offset: f.offset, items };
}

/** Упоминания параметров одного файла постранично (раскрытие строки раздела «Файлы»). null — файла нет. */
export async function listFileMentions(db: DB, fileId: string, param: string | undefined, limit: number, offset: number) {
  if (!(await db.get("select 1 from files where id = $1", [fileId]))) return null;
  const args: unknown[] = [fileId];
  let cond = "file_id = $1";
  if (param) {
    args.push(param);
    cond += ` and param_code = $${args.length}`;
  }
  const total = (await db.get<{ n: number }>(`select count(*)::int n from extractions where ${cond}`, args))!.n;
  const rows = await db.all<any>(
    `select id, param_code, raw, value_num, value_text, page, confidence, left(line_text, ${LINE_MAX + 1}) line_text from extractions
      where ${cond} order by page nulls last, id limit $${args.length + 1} offset $${args.length + 2}`,
    [...args, limit, offset],
  );
  const items: FileMention[] = rows.map((r) => {
    const t = typeof r.line_text === "string" ? r.line_text.replace(/\s+/g, " ").trim() : null;
    return { ...r, id: Number(r.id), line_text: t == null ? null : t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)}…` : t };
  });
  return { total, limit, offset, items };
}
