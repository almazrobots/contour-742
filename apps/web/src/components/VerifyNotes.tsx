// T-177: что система проверила после сравнения (слой L8, ADR-0008) — словами инспектора, без кодов операций:
// почему статус понижен, найдено ли изменение на листе, от какого расхождения зависит это, какие документы просмотрены.
export interface L8Step { op: string; from: string; to: string; reason_code: string | null; why: string }
export interface L8Trace {
  steps: L8Step[];
  change: "APPROVED_CHANGE" | "CHANGE_APPROVAL_UNVERIFIED" | "CHANGE_CONFLICT" | "NONE" | null;
  flags: string[];
  searched: Array<{ file_id: string; stage: string; document_code: string; pages: number | null; parsed: boolean; low_quality_pages: number[] }> | null;
  atoms: Array<{ stage: string; expected: string | null; actual: string }>;
}

const STAGE: Record<string, string> = { PD: "ПД", RD: "РД", ID: "ИД" };
const STATUS: Record<string, string> = {
  CANDIDATE: "кандидат",
  NEGATIVE_VERIFIED: "нарушения нет",
  NOT_COMPARABLE: "сравнить нельзя",
  CLARIFICATION_REQUIRED: "нужно уточнение",
  MISSING_EVIDENCE: "нет доказательства",
};

const MAX_DOCS = 10; // длинный пакет — первые документы и счёт остальных

export function VerifyNotes({ l8Json, changeRef, derivedFrom }: { l8Json: string | null | undefined; changeRef: string | null | undefined; derivedFrom: string | null | undefined }) {
  let t: L8Trace | null = null;
  try {
    t = l8Json ? (JSON.parse(l8Json) as L8Trace) : null;
  } catch {
    t = null;
  }
  const moves = (t?.steps ?? []).filter((s) => s.from !== s.to);
  const unverified = t?.flags.includes("CHANGE_APPROVAL_UNVERIFIED") ?? false;
  const composite = (t?.atoms.length ?? 0) > 1;
  const searched = t?.searched ?? null;
  if (!moves.length && !unverified && !derivedFrom && !composite && !searched?.length) return null;
  return (
    <div className="panel panel-body small stack" style={{ gap: 6 }} aria-label="Проверки после сравнения">
      <span className="label">Проверки после сравнения</span>
      {moves.map((s, i) => (
        <div key={i}>
          <b>{STATUS[s.from] ?? s.from} → {STATUS[s.to] ?? s.to}</b>: {s.why}
        </div>
      ))}
      {unverified && changeRef && changeRef !== "NONE" && (
        <div>
          Найдено изменение: <b>{changeRef}</b>. Утверждение изменения документом система не подтвердила — проверьте основание.
        </div>
      )}
      {derivedFrom && (
        <div>
          Расхождение производное: следует из расхождения по <span className="mono">{derivedFrom}</span> и отдельным нарушением не считается.
        </div>
      )}
      {composite && (
        <div>
          В записи несколько фактов: {t!.atoms.map((a) => `${STAGE[a.stage] ?? a.stage} — ${a.actual}`).join("; ")}. Каждый можно оценить отдельно, разделив запись.
        </div>
      )}
      {searched && searched.length > 0 && (
        <div>
          Просмотрены документы:{" "}
          {searched.slice(0, MAX_DOCS).map((s) => `${STAGE[s.stage] ?? s.stage} ${s.document_code}${s.pages !== null ? ` (${s.pages} стр.)` : ""}${!s.parsed ? " — не разобран" : s.low_quality_pages.length ? ` — плохо читаются стр. ${s.low_quality_pages.join(", ")}` : ""}`).join("; ")}
          {searched.length > MAX_DOCS ? ` и ещё ${searched.length - MAX_DOCS}` : ""}
        </div>
      )}
    </div>
  );
}
