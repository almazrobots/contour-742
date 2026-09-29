// T-133 (OS-INSP-2.2.21): значение параметра берётся только из профильного раздела. Матрица называет разделы-источники
// («Опалубочные схемы перекрытий (КР)», «Разрез (КЖ)», «Раздел АР/КР: …») — документ другой марки не источник: на
// «Алтуфьево» толщина плиты перекрытия М-059 собиралась из «200» в ЭЭ и «1» в ВК2, и выходил ложный кандидат.
// Марка документа не определена — не отбрасываем: лучше показать сомнительное, чем молча потерять значение.

import type { Param } from "./types.ts";

/** Марки ПД и соответствующие им марки РД (ГОСТ Р 21.101, Постановление № 87): связь симметричная. */
const FAMILIES: string[][] = [
  // конструктивные: владелец 27.09 — толщина плиты берётся из КР/КЖ и из разрезов АР
  ["КР", "КЖ", "КЖИ", "КМ", "КМД"],
  ["ИОС1", "ЭОМ", "ЭМ", "ЭС", "ЭН", "ЭО", "ЭЭ"],
  ["ИОС2", "ВК", "НВК", "В"],
  ["ИОС3", "ВК", "НВК", "К"],
  ["ИОС4", "ОВ", "ОВК", "ТМ", "ИТП"],
  ["ИОС5", "СС", "АПС", "СОУЭ", "СКС"],
  ["ИОС6", "ГСН"],
  ["ИОС7", "ТХ"],
  ["СПЗУ", "ПЗУ", "ГП", "ПП", "БП"], // ПЗУ — прежнее имя раздела 2 (СПЗУ)
  ["ПЗ", "ПБ"],
  ["ППМ", "ПБ", "МПБ"], // мероприятия по пожарной безопасности — раздел 9
];

/** Марка из шифра или поля раздела: «АР2» → АР, «КЖ01» → КЖ, «КР.Р» → КР, «ИОС3.1» → ИОС3. */
export function normMark(s: string | null | undefined): string | null {
  const m = (s ?? "").trim().toUpperCase().replace(/Ё/g, "Е").match(/^([А-ЯA-Z]+)(\d+)?/);
  if (!m) return null;
  return m[1] === "ИОС" ? m[1] + (m[2] ?? "") : m[1];
}

export type Stage = "PD" | "RD" | "ID";

/** Марки из текста источника: скобки «(КР)», «(КЖ/КМ)» и префикс «Раздел АР/КР:». */
function marksOf(raw: Array<string | null | undefined>): Set<string> {
  const parts: string[] = [];
  for (const src of raw) {
    if (!src) continue;
    for (const m of src.matchAll(/\(([^)]*)\)/g)) parts.push(...m[1].split("/"));
    const lead = /^Раздел\s+([А-ЯЁA-Z0-9./]+)/i.exec(src.trim());
    if (lead) parts.push(...lead[1].split("/"));
    if (/^[А-ЯЁA-Z]+\d*$/.test(src.trim())) parts.push(src.trim()); // раздел Матрицы — сама марка
  }
  const out = new Set<string>();
  // в скобках бывают не марки («маркировка», «ГОСТ 21.101», «паркинг») — марка пишется только прописными
  for (const r of parts) if (/^[А-ЯЁA-Z]+\d*(\.\d+)*$/.test(r.trim())) out.add(normMark(r)!);
  return out;
}

/**
 * Марки-источники параметра. Без стадии — все: раздел Матрицы, источники ПД и РД (правило 2.2.21).
 * OS-INSP-2.2.4: со стадией — источник этой стадии: ПД — раздел параметра и источник ПД, РД — источник РД,
 * ИД — источник ИД. Марка в источнике стадии не названа — пусто (стадия не ограничивается, см. disciplineFits).
 */
export function paramMarks(p: Pick<Param, "section" | "source_pd" | "source_rd"> & { source_id?: string | null }, stage?: Stage): Set<string> {
  if (stage === "PD") return marksOf([p.section, p.source_pd]);
  if (stage === "RD") return marksOf([p.source_rd]);
  if (stage === "ID") return marksOf([p.source_id]);
  return marksOf([p.section, p.source_pd, p.source_rd]);
}

/** Связи в одну сторону: размеры конструкций приводят и разрезы АР (слово владельца 27.09 — толщина плиты из КР и АР),
 *  но параметр АР из КР/КЖ не берётся — иначе класс энергоэффективности принимал бы КЖ. */
const ONE_WAY: Record<string, string[]> = { КР: ["АР"], КЖ: ["АР"] };

function expand(marks: Set<string>): Set<string> {
  const out = new Set(marks);
  for (const f of FAMILIES) if (f.some((x) => marks.has(x))) f.forEach((x) => out.add(x));
  for (const m of [...out]) for (const x of ONE_WAY[m] ?? []) out.add(x);
  return out;
}

/** Энергетический параметр (класс энергоэффективности): его приводит раздел ЭЭ и сети электроснабжения — семейство ЭЭ. */
const ENERGY = /энергет|энергоэффект/i;

/** Противопожарный параметр: эвакуация, пожаротушение, огнестойкость — его значения законно приводит и раздел ПБ. */
const FIRE = /эваку|пожар|огнестойк|дымоудал|противодым/i;

/** Может ли документ этой марки быть источником значения параметра. Марка неизвестна — может. */

export function disciplineFits(
  p: Pick<Param, "section" | "source_pd" | "source_rd"> & { parameter_name?: string; source_id?: string | null },
  discipline: string | null | undefined,
  stage?: Stage,
): boolean {
  const d = normMark(discipline);
  if (!d) return true;
  let marks = paramMarks(p, stage);
  // источник стадии без марки (ИД — акты и паспорта; РД без раздела в скобках) — стадию не ограничиваем,
  // для ИД вовсе, для ПД и РД — всеми марками параметра, как без стадии
  if (!marks.size) {
    if (stage === "ID") return true;
    marks = paramMarks(p);
  }
  // противопожарный параметр — вся группа пожарной безопасности (ПБ, ППМ, МПБ), а не только марка «ПБ» (T-132:
  // синтетика e2e — паспорт двери и ведомость М-040 в марке ППМ выпадали, итог становился MISSING_EVIDENCE)
  if (FIRE.test(p.parameter_name ?? "")) marks.add("ПБ");
  // T-132: e2e на синтетике — класс энергоэффективности М-021 в РД стоит в ЭОМ и выпадал при источниках «АР/ОВ»
  if (ENERGY.test(p.parameter_name ?? "")) marks.add("ЭЭ");
  const allowed = expand(marks);
  if (allowed.has(d)) return true;
  // «ППМ/ИОС» — вся группа инженерных разделов
  return allowed.has("ИОС") && d.startsWith("ИОС");
}

/**
 * OS-INSP-2.2.4: выбор источников значения стадии по приоритету. Сначала — документы, которые Матрица называет
 * источником этой стадии; нет таких значений — профильные разделы параметра (правило 2.2.21). Строгий отказ терял
 * верные значения: обкатка на «Полярной 17» — высота здания 68,41 стоит в ПД АР, а ПД-источник Матрицы (ТЭП ПЗ) её
 * не содержит; на «Алтуфьево» — расчётная мощность в ИОС1 при ПД-источнике «ПЗ: таблица нагрузок».
 */
export function pickStageSources<T>(rows: T[], p: Parameters<typeof disciplineFits>[0], stage: Stage, discipline: (r: T) => string | null | undefined): T[] {
  const own = rows.filter((r) => disciplineFits(p, discipline(r), stage));
  return own.length ? own : rows.filter((r) => disciplineFits(p, discipline(r)));
}
