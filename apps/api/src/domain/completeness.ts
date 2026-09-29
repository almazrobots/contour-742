// OS-INSP-1.4 Оценить комплектность и сценарий проверки.
import { isExcluded } from "./integrity-report.ts";
import { STAGES, type Scenario, type Stage, type StageLoad } from "./types.ts";

export interface StageCount {
  declared: number; // объявлено в реестре
  uploaded: number; // фактически принято
  incomplete?: number; // OS-INSP-1.2.34: принято, но страниц меньше или больше, чем в реестре
}

/**
 * Счётчики стадий по документам, а не по файлам (OS-INSP-1.2.10): части большого документа — один
 * документ. Документ, у которого пришли не все объявленные части, считается по частям (2 из 3),
 * чтобы стадия получила PARTIAL, а не UPLOADED или MISSING.
 */
export function documentCounts(
  declared: Array<{ file_id: string; doc_stage: Stage; part_of?: string | null; exclusion_reason?: string | null }>,
  uploaded: Array<{ client_file_id: string; doc_stage: Stage; part_of?: string | null }>,
  incomplete: ReadonlySet<string> = new Set(), // OS-INSP-1.2.34: client_file_id файлов с расхождением числа страниц
): Record<Stage, StageCount> {
  const key = (id: string, partOf?: string | null) => partOf || id;
  const got = new Set(uploaded.map((f) => f.client_file_id).filter((id) => !incomplete.has(id)));
  const short = new Set(uploaded.map((f) => f.client_file_id).filter((id) => incomplete.has(id)));
  const units = new Map<string, { stage: Stage; parts: number; got: number; short: number }>();
  // OS-INSP-1.2.32: исключённый реестром файл не объявлен к проверке — его отсутствие не делает стадию PARTIAL
  for (const f of declared.filter((d) => !isExcluded(d))) {
    const k = key(f.file_id, f.part_of);
    const u = units.get(k) ?? { stage: f.doc_stage, parts: 0, got: 0, short: 0 };
    u.parts++;
    if (got.has(f.file_id)) u.got++;
    if (short.has(f.file_id)) u.short++;
    units.set(k, u);
  }
  const out = Object.fromEntries(STAGES.map((s) => [s, { declared: 0, uploaded: 0 }])) as Record<Stage, StageCount>;
  for (const u of units.values()) {
    if (u.short) out[u.stage].incomplete = (out[u.stage].incomplete ?? 0) + u.short;
    const partial = u.got > 0 && u.got < u.parts;
    out[u.stage].declared += partial ? u.parts : 1;
    out[u.stage].uploaded += partial ? u.got : u.got === u.parts ? 1 : 0;
  }
  // файлы вне реестра — по своей стадии, документ из частей — один раз
  const extra = new Set<string>();
  for (const f of uploaded) {
    const k = key(f.client_file_id, f.part_of);
    if (units.has(k) || extra.has(k)) continue;
    extra.add(k);
    out[f.doc_stage].uploaded++;
  }
  return out;
}

export function stageLoad(c: StageCount): StageLoad {
  const short = c.incomplete ?? 0;
  if (c.uploaded === 0 && short === 0) return "MISSING";
  if (short > 0 || c.uploaded < c.declared) return "PARTIAL";
  return "UPLOADED";
}

/** Коды статусов загрузки по ТЗ 9.1: PD_UPLOADED, RD_PARTIAL, ID_MISSING … */
export function loadCodes(counts: Record<Stage, StageCount>): string[] {
  return STAGES.map((s) => `${s}_${stageLoad(counts[s])}`);
}

export function scenario(counts: Record<Stage, StageCount>): Scenario {
  const loads = STAGES.map((s) => [s, stageLoad(counts[s])] as const);
  if (loads.some(([, l]) => l === "PARTIAL")) return "PARTIALLY_LOADED";
  const present = loads.filter(([, l]) => l === "UPLOADED").map(([s]) => s);
  const key = present.join("+");
  switch (key) {
    case "PD+RD+ID":
      return "FULL";
    case "PD+RD":
      return "PD_RD_ONLY";
    case "PD+ID":
      return "PD_ID_ONLY";
    case "RD+ID":
      return "RD_ID_ONLY";
    case "":
      return "NO_DOCUMENTS";
    default:
      return "SINGLE_ONLY";
  }
}

export const SCENARIO_RU: Record<Scenario, string> = {
  FULL: "Полная проверка ПД–РД–ИД",
  PD_RD_ONLY: "ПД–РД (ИД отсутствует)",
  PD_ID_ONLY: "ПД–ИД (РД отсутствует)",
  RD_ID_ONLY: "РД–ИД (ПД отсутствует)",
  SINGLE_ONLY: "Загружен один тип документации",
  PARTIALLY_LOADED: "Комплект загружен частично",
  NO_DOCUMENTS: "Документы не загружены",
};
