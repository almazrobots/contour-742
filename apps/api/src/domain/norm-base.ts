// ТЗ §10 Normative_Base — один источник норм (T-234). Пределы сравнения CMP-06 и сроки действия берутся из таблицы
// normative_base; data/seed/norms.json → base[] — только начальное наполнение: запись с новым norm_key добавляется,
// существующая не перезаписывается (правка администратора в интерфейсе остаётся). Чистые функции; IO — db.ts,
// services/inspections.ts.
import type { NormRecord } from "./geom-ops.ts";

/** Запись base[] сид-файла norms.json (ADR-0010) — вход начального наполнения. */
export interface SeedNorm extends NormRecord {
  conditions?: string | null;
  quote?: string | null;
  source_url?: string | null;
  catalog_note?: string | null;
}

/** Строка normative_base для вставки (колонки 0001 + 0015). */
export interface NormBaseInsert {
  norm_key: string;
  document_name: string;
  document_number: string;
  section: string | null;
  parameter_name: string | null;
  param_code: null;
  min_value: number | null;
  max_value: number | null;
  effective_from: string | null;
  effective_to: string | null;
  measure: string;
  unit: string;
  rule: string;
  edition: string | null;
  conditions: string | null;
  applies_to_json: string;
  unverified: boolean;
  quote: string | null;
  source_url: string | null;
}

/**
 * Запись base[] → строка normative_base. Наименование документа — из справочника поиска items[] по номеру документа
 * (иначе номер). param_code пуст: предел CMP-06 привязан к паспорту (value.norm.ref = norm_key) и applies_to, а
 * param_code — ключ нормативного анализа гипотез (OS-INSP-3.2), чтобы одна норма не дала гипотезу дважды.
 */
export function normSeedRow(n: SeedNorm, names: ReadonlyMap<string, string>, paramNames: ReadonlyMap<string, string> = new Map()): NormBaseInsert {
  const name = names.get(n.doc) ?? [...names].find(([num]) => n.doc.startsWith(num) || num.startsWith(n.doc))?.[1] ?? n.doc;
  // наименование параметра — параметры Матрицы, к которым применяется норма; нет их — предмет нормы из правила измерения
  const params = (n.applies_to ?? []).map((c) => paramNames.get(c)).filter((x): x is string => Boolean(x));
  return {
    norm_key: n.id, document_name: name, document_number: n.doc, section: n.clause ?? null, parameter_name: (params.length ? [...new Set(params)].join("; ") : n.rule.split(";")[0]).slice(0, 200) || null,
    param_code: null, min_value: n.min, max_value: n.max, effective_from: n.effective_from, effective_to: n.effective_to,
    measure: n.measure, unit: n.unit, rule: n.rule, edition: n.edition ?? null, conditions: n.conditions ?? null,
    applies_to_json: JSON.stringify(n.applies_to ?? []), unverified: n.unverified === true, quote: n.quote ?? null, source_url: n.source_url ?? null,
  };
}

/** Строка normative_base (с norm_key) → запись для оценщика CMP-06 (resolveNorm). Сроки — дата YYYY-MM-DD. */
export function normRecordFromRow(r: Record<string, any>): NormRecord {
  const day = (v: unknown) => (v == null || v === "" ? null : String(v).slice(0, 10));
  return {
    id: String(r.norm_key), doc: String(r.document_number), clause: r.section ?? null, edition: r.edition ?? null, measure: String(r.measure ?? ""),
    min: r.min_value == null ? null : Number(r.min_value), max: r.max_value == null ? null : Number(r.max_value), unit: String(r.unit ?? ""), rule: String(r.rule ?? ""),
    applies_to: r.applies_to_json ? (typeof r.applies_to_json === "string" ? JSON.parse(r.applies_to_json) : r.applies_to_json) : [],
    effective_from: day(r.effective_from), effective_to: day(r.effective_to), unverified: r.unverified === true, is_active: r.is_active !== false,
  };
}

/**
 * Параметры, чей расчёт зависит от записи нормы (OS-INSP-7.2.4): ключ нормативного анализа (param_code), applies_to
 * записи и паспорта, ссылающиеся на неё полем value.norm.ref. После правки нормы эти параметры пересчитываются.
 */
export function paramsForNorm(norm: { norm_key?: string | null; param_code?: string | null; applies_to_json?: string | null }, passportRefs: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  if (norm.param_code) out.add(norm.param_code);
  if (norm.applies_to_json) for (const c of JSON.parse(norm.applies_to_json) as string[]) out.add(c);
  if (norm.norm_key) for (const [code, ref] of passportRefs) if (ref === norm.norm_key) out.add(code);
  return [...out].sort();
}

/** Действует ли норма на дату (YYYY-MM-DD): выключенная и вне [effective_from; effective_to] — нет (ТЗ §10). */
export function normEffective(n: { is_active?: boolean | null; effective_from?: string | null; effective_to?: string | null }, date: string): boolean {
  const d = date.slice(0, 10);
  const from = n.effective_from ? String(n.effective_from).slice(0, 10) : null;
  const to = n.effective_to ? String(n.effective_to).slice(0, 10) : null;
  return n.is_active !== false && (!from || from <= d) && (!to || d <= to);
}
