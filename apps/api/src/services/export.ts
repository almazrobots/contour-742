// OS-INSP-5.1 Выгрузить протокол: JSON и XML — здесь; PDF и DOCX рендерит ML-сервис (reportlab, python-docx).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import type { Protocol } from "../domain/protocol.ts";
import { appendix2, type Appendix2 } from "../domain/appendix2.ts";
import { buildSubmission, SubmissionRefused, validateSubmission, type OrganizerCode } from "../domain/submission.ts";
import { checkRows, HttpError } from "./inspections.ts";

// OS-INSP-5.1.21: символы, недопустимые в XML 1.0 (управляющие, кроме \t \n \r; U+FFFE, U+FFFF; непарные суррогаты),
// убираются — иначе выгрузка не разбирается ни одним XML-парсером
const XML_BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// OS-INSP-5.1.20: разметка из данных — текст
const esc = (s: unknown) =>
  String(s ?? "").replace(XML_BAD, "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

function toXml(tag: string, v: unknown, pad = ""): string {
  if (v === null || v === undefined) return `${pad}<${tag}/>`;
  if (Array.isArray(v)) return `${pad}<${tag}>\n${v.map((x) => toXml("item", x, pad + "  ")).join("\n")}\n${pad}</${tag}>`;
  if (typeof v === "object") return `${pad}<${tag}>\n${Object.entries(v as Record<string, unknown>).map(([k, x]) => toXml(k.replace(/[^\w-]/g, "_"), x, pad + "  ")).join("\n")}\n${pad}</${tag}>`;
  return `${pad}<${tag}>${esc(v)}</${tag}>`;
}

export function protocolXml(p: Protocol): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml("protocol", p)}\n`;
}

export async function exportProtocol(p: Protocol, format: "json" | "xml" | "pdf" | "docx", view?: Appendix2): Promise<{ type: string; body: string | Buffer }> {
  if (format === "json") return { type: "application/json; charset=utf-8", body: JSON.stringify(p, null, 2) };
  if (format === "xml") return { type: "application/xml; charset=utf-8", body: protocolXml(p) };
  // T-121: PDF и DOCX — по образцу Приложения № 2; модель документа собрана здесь, ML только рисует
  const r = await fetch(`${config.mlUrl}/render/${format}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...p, appendix2: view ?? null }), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Рендер ${format} не удался: ${r.status}`);
  const type = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return { type, body: Buffer.from(await r.arrayBuffer()) };
}

// T-117 (OS-INSP-5.1.3–5.1.5): ответ в формате организатора. Каталог кодов и схема — из пакета участника (data/seed/organizer).
let organizer: { codes: OrganizerCode[]; schema: object } | null = null;
function organizerSpec() {
  organizer ??= {
    codes: JSON.parse(readFileSync(join(config.root, "data/seed/organizer/parameter-codes.json"), "utf8")).params,
    schema: JSON.parse(readFileSync(join(config.root, "data/seed/organizer/submission_schema.json"), "utf8")),
  };
  return organizer;
}

export async function exportSubmission(db: DB, inspectionId: string): Promise<{ object_id: string; checks: unknown[] }> {
  const insp = await db.get<{ object_id: string }>("select object_id from inspections where id = $1", [inspectionId]);
  if (!insp) throw new HttpError(404, "Проверка не найдена");
  const files = Object.fromEntries((await db.all<{ id: string; client_file_id: string }>("select id, client_file_id from files where inspection_id = $1", [inspectionId])).map((f) => [f.id, f.client_file_id]));
  const { codes, schema } = organizerSpec();
  try {
    const sub = buildSubmission({
      object_id: insp.object_id,
      codes,
      files,
      checks: (await checkRows(db, inspectionId)).map((c) => ({
        id: c.id, param_code: c.param_code, section: c.section, finding_status: c.finding_status, verification_status: c.verification_status, parent_id: c.parent_id,
        // страница внутри PDF, на который ссылается file_id (часть тома — свой файл), а не сквозная по документу
        fragments: c.fragments.map((f) => ({ stage: f.stage, file_id: f.file_id, page: f.sheet_page, value: f.extracted_value })),
      })),
    });
    const errs = validateSubmission(sub, schema);
    if (errs.length) throw new SubmissionRefused(errs[0].field, `Ответ не проходит схему организатора: ${errs[0].field} — ${errs[0].message}`);
    return sub;
  } catch (e) {
    // OS-INSP-5.1.4–5.1.5: файл не отдаётся, в ответе — нарушенное поле
    if (e instanceof SubmissionRefused) throw new HttpError(422, e.message, { field: e.field });
    throw e;
  }
}

/** T-121 (OS-INSP-5.1.6): модель протокола по Приложению № 2 из базы — объект, реестр, проверки с критичностью и основанием. */
export async function appendix2For(db: DB, inspectionId: string): Promise<Appendix2> {
  const insp = await db.get<any>("select id, object_id, status, protocol_version, manifest_json, updated_at from inspections where id = $1", [inspectionId]);
  if (!insp) throw new HttpError(404, "Проверка не найдена");
  const obj = await db.get<any>("select name, address, customer, contractor, permit_number from objects where id = $1", [insp.object_id]);
  const files = await db.all<{ doc_stage: string }>("select doc_stage from files where inspection_id = $1", [inspectionId]);
  const manifest = insp.manifest_json ? (typeof insp.manifest_json === "string" ? JSON.parse(insp.manifest_json) : insp.manifest_json) : null;
  const params = new Map((await db.all<any>("select id, code, trigger_logic, source_id from params")).map((r) => [r.code as string, r]));
  const { codes } = organizerSpec();
  const org = new Map(codes.map((c) => [c.id, c]));
  const suspicions = await db.all<any>(`select s.discovery_method, s.description, s.pd_reference, s.rd_reference, coalesce(c.verification_status, s.inspector_status) inspector_status
      from suspicions s left join checks c on c.id = s.promoted_check_id where s.inspection_id = $1 order by s.id`, [inspectionId]);
  return appendix2({
    process_id: insp.id,
    protocol_version: insp.protocol_version,
    generated_at: new Date().toISOString(),
    status: insp.status,
    object: { name: obj?.name ?? insp.object_id, address: obj?.address ?? null, permit_number: obj?.permit_number ?? null, customer: obj?.customer ?? null, contractor: obj?.contractor ?? null },
    files,
    declared: (manifest?.files ?? []).map((f: any) => ({ doc_stage: f.doc_stage })),
    checks: (await checkRows(db, inspectionId)).filter((c) => !c.parent_id).map((c) => {
      const pr = params.get(c.param_code);
      const o = pr ? org.get(pr.id as number) : undefined;
      return {
        id: c.id, param_code: c.param_code, org_code: o?.code ?? null, section: c.section, parameter_name: c.parameter_name, critical: o?.critical ?? false,
        trigger_logic: pr?.trigger_logic ?? null, source_id: pr?.source_id ?? null, finding_status: c.finding_status, verification_status: c.verification_status,
        delta: c.delta, fragments: c.fragments.map((f) => ({ stage: f.stage, value: f.extracted_value })),
        decision: c.decision ? { action: c.decision.action, comment: c.decision.comment } : null,
      };
    }),
    suspicions: suspicions.map((s) => ({ ...s, comment: null })),
  });
}
