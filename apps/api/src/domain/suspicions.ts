// OS-INSP-3.2 Сформировать гипотезы вне Матрицы (ТЗ 9.5).
// Профиль dev: логический анализ, семантический диссонанс, нормативный анализ; ML-паттерн-анализ (4-й подход,
// робастная модель по истории других объектов) — в patterns.ts, OS-INSP-3.2.8–3.2.10.

import { normEffective } from "./norm-base.ts";

// LLM_ADVISOR — гипотеза LLM-советника, прошедшая проверку ссылки в ML (OS-INSP-3.2.4).
export type DiscoveryMethod = "LOGICAL_ANALYSIS" | "SEMANTIC_DISSONANCE" | "NORMATIVE_ANALYSIS" | "ML_PATTERN" | "LLM_ADVISOR";

import { createHash } from "node:crypto";

/**
 * T-233: ключ дедупликации гипотезы лежит в уникальном индексе (inspection_id, dedup_key); btree PostgreSQL не берёт
 * строку индекса длиннее ~2700 байт. Ключ конфликта включает все упоминания (`файл@стр:значение|…`) и на томе в сотни
 * страниц вырастает за предел — запись падала уже после разбора и файл уходил в FAILED. Длинный ключ сокращается до
 * начала (по нему читается код параметра: split_part(dedup_key, ':', 1)) плюс SHA-256 всего ключа: разные ключи
 * остаются разными, один и тот же — тем же.
 */
export const DEDUP_KEY_MAX_BYTES = 512;
export function boundedDedupKey(key: string): string {
  if (Buffer.byteLength(key, "utf8") <= DEDUP_KEY_MAX_BYTES) return key;
  return `${key.slice(0, 160)}…#${createHash("sha256").update(key).digest("hex")}`;
}

export interface Fact {
  key: string; // код параметра или код факта правила
  num: number | null;
  text: string | null;
  stage: "PD" | "RD" | "ID";
  ref: string; // «шифр, ред., стр.»
}

export interface LogicalRule {
  id: number;
  rule_name: string;
  condition: { key: string; op: Op; value: number };
  expected: { key: string; op: Op; value: number };
  normative_base: string;
  is_active: boolean;
}

export interface Room {
  number: string;
  name: string;
  stage: "PD" | "RD" | "ID";
  ref: string;
}

export interface NormEntry {
  document_name: string;
  document_number: string;
  section: string;
  param_code: string;
  min_value: number | null;
  max_value: number | null;
  is_active: boolean;
  /** ТЗ §10 Normative_Base: срок действия (T-234) — вне [effective_from; effective_to] норма гипотезу не даёт. */
  effective_from?: string | null;
  effective_to?: string | null;
}

export interface Suspicion {
  discovery_method: DiscoveryMethod;
  confidence: number;
  description: string;
  pd_reference: string | null;
  rd_reference: string | null;
  review_priority: "HIGH" | "MEDIUM" | "LOW";
  normative_base: string | null;
  dedup_key: string;
}

export type Op = ">" | ">=" | "<" | "<=" | "==" | "!=";

export function cmp(a: number, op: Op, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
}

/** Логический анализ: «если A, то B». Правило срабатывает, когда A истинно, а B — нет (или B не найден). */
export function logical(rules: LogicalRule[], facts: Fact[]): Suspicion[] {
  const out: Suspicion[] = [];
  const pick = (key: string) => facts.find((f) => f.key === key && f.num !== null);
  for (const r of rules) {
    if (!r.is_active) continue;
    const a = pick(r.condition.key);
    if (!a || !cmp(a.num!, r.condition.op, r.condition.value)) continue;
    const b = pick(r.expected.key);
    if (b && cmp(b.num!, r.expected.op, r.expected.value)) continue;
    out.push({
      discovery_method: "LOGICAL_ANALYSIS",
      confidence: b ? 0.87 : 0.6,
      description: `${r.rule_name}: при ${r.condition.key} = ${a.num} ${b ? `найдено ${r.expected.key} = ${b.num}` : `значение ${r.expected.key} не найдено`}.`,
      pd_reference: a.stage === "PD" ? a.ref : (b?.stage === "PD" ? b.ref : null),
      rd_reference: a.stage === "RD" ? a.ref : (b?.stage === "RD" ? b.ref : null),
      review_priority: "HIGH",
      normative_base: r.normative_base,
      dedup_key: `LOGICAL:${r.id}`,
    });
  }
  return out;
}

/** Сходство назначений помещений: доля общих слов (без предлогов). 1 — совпадают. */
export function nameSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().replace(/ё/g, "е").split(/[^а-яa-z0-9]+/).filter((w) => w.length > 2));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

/** Семантический диссонанс: одно помещение названо в ПД и РД по-разному («Техническое» → «Склад ГСМ»). */
export function semantic(rooms: Room[], threshold = 0.34): Suspicion[] {
  const out: Suspicion[] = [];
  const pd = rooms.filter((r) => r.stage === "PD");
  const rd = rooms.filter((r) => r.stage === "RD");
  for (const p of pd) {
    const r = rd.find((x) => x.number === p.number);
    if (!r) continue;
    const sim = nameSimilarity(p.name, r.name);
    if (sim >= threshold) continue;
    out.push({
      discovery_method: "SEMANTIC_DISSONANCE",
      confidence: Math.round((1 - sim) * 0.9 * 100) / 100,
      description: `Помещение ${p.number}: в ПД — «${p.name}», в РД — «${r.name}». Изменение функционального назначения без согласованного изменения ПД?`,
      pd_reference: p.ref,
      rd_reference: r.ref,
      review_priority: /гсм|взрыв|горюч|топлив/i.test(r.name) ? "HIGH" : "MEDIUM",
      normative_base: "СП 12.13130.2009 (категории помещений по взрывопожарной и пожарной опасности); СП 4.13130.2013 (ограничение распространения пожара)",
      dedup_key: `SEMANTIC:${p.number}`,
    });
  }
  return out;
}

/**
 * Нормативный анализ: значение вне допустимого по нормативному документу (Normative_Base). date — дата проверки:
 * норма, не действующая на неё (effective_from/effective_to, T-234), гипотезу не даёт; без даты сроки не сверяются.
 */
export function normative(norms: NormEntry[], facts: Fact[], skipCodes: Set<string>, date?: string): Suspicion[] {
  const out: Suspicion[] = [];
  for (const n of norms) {
    if (!n.is_active || skipCodes.has(n.param_code)) continue;
    if (date && !normEffective(n, date)) continue;
    for (const f of facts.filter((x) => x.key === n.param_code && x.num !== null)) {
      const low = n.min_value !== null && f.num! < n.min_value;
      const high = n.max_value !== null && f.num! > n.max_value;
      if (!low && !high) continue;
      out.push({
        discovery_method: "NORMATIVE_ANALYSIS",
        confidence: 0.8,
        description: `${n.param_code}: значение ${f.num} в ${f.stage} ${low ? `меньше ${n.min_value}` : `больше ${n.max_value}`} по ${n.document_number}.`,
        pd_reference: f.stage === "PD" ? f.ref : null,
        rd_reference: f.stage === "RD" ? f.ref : null,
        review_priority: "MEDIUM",
        normative_base: `${n.document_number}, ${n.section}`,
        dedup_key: `NORM:${n.param_code}:${f.stage}`,
      });
    }
  }
  return out;
}

/** OS-INSP-3.2.3: дедупликация только внутри одного объекта — по ключу гипотезы. */
export function dedupe(list: Suspicion[]): Suspicion[] {
  const seen = new Map<string, Suspicion>();
  for (const s of list) {
    const prev = seen.get(s.dedup_key);
    if (!prev || s.confidence > prev.confidence) seen.set(s.dedup_key, s);
  }
  return [...seen.values()];
}


// ─────────────────────────────── OS-INSP-3.2.4–3.2.7: ссылка советника, норма, перевод в кандидаты

export type BBox = [number, number, number, number];

/** Ссылка гипотезы на доказательство: файл, страница, bbox (доли страницы), дословная цитата. */
export interface EvidenceRef {
  file_id: string;
  page: number;
  bbox: BBox;
  quote?: string | null;
}

/** bbox в долях [0;1]: x0 < x1, y0 < y1. */
export function isBBox(b: unknown): b is BBox {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  const [x0, y0, x1, y1] = b as number[];
  return x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && x0 < x1 && y0 < y1;
}

/**
 * OS-INSP-3.2.7: перевести гипотезу в CANDIDATE можно только со ссылкой — файл, страница и bbox.
 * Возвращает текст ошибки или null. Файл должен принадлежать той же проверке (fileIds).
 */
export function promotionError(ref: Partial<EvidenceRef> | null | undefined, fileIds: Set<string>): string | null {
  if (!ref || typeof ref.file_id !== "string" || !ref.file_id) return "Нужен файл доказательства (file_id)";
  if (!fileIds.has(ref.file_id)) return "Файл не из этой проверки";
  if (typeof ref.page !== "number" || !Number.isInteger(ref.page) || ref.page < 1) return "Нужна страница (целое ≥ 1)";
  if (!isBBox(ref.bbox)) return "Нужен bbox [x0, y0, x1, y1] в долях страницы";
  return null;
}

/** Код параметра проверки, созданной из гипотезы (вне Матрицы). */
export const suspicionParamCode = (id: number): string => `SUSP-${id}`;

/** Ключ дедупликации гипотезы советника: тот же файл, страница и цитата — одна гипотеза (OS-INSP-3.2.3). */
export function advisorDedupKey(sha256: string, page: number, quote: string): string {
  const q = quote.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let h = 0;
  for (const ch of q) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
  return `LLM:${sha256.slice(0, 12)}:${page}:${h.toString(16)}`;
}

/** Найденная норма → текст поля normative_base: «СП 1.13130.2020, п. 4.2.5 — предмет». */
export function normLabel(n: { document_number: string; section?: string | null; summary?: string | null }): string {
  return [n.document_number, n.section].filter(Boolean).join(", ") + (n.summary ? ` — ${n.summary}` : "");
}
