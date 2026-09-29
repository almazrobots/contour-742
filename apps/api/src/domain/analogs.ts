// Справочник канона и аналогов (T-176, ADR-0008 п. 3): data/seed/analogs.json. Семейство — канон материалов или марок
// с группой и ключевыми характеристиками и направленная таблица вердиктов «ПД → РД» с источником (норма или каталог).
// Каталог TO-BE: NRM-06 (канон наименований), NRM-11 (артикулы и марки), CMP-05 (таблица аналогов). Правила —
// OS-INSP-3.1.60–3.1.62. Написания (aliases) нужны только ML; сравнение работает на ключах канона.
import { z } from "zod";
import { classRank } from "./class-param.ts";

const Source = z.object({ kind: z.enum(["norm", "catalog", "derived"]), ref: z.string().min(1) });
const CharDef = z.object({
  title: z.string().min(1),
  unit: z.string().optional(),
  kind: z.enum(["number", "ordinal"]),
  better: z.enum(["up", "down"]).optional(),
  scale: z.array(z.string()).min(2).optional(), // ordinal: от худшего к лучшему
  tol_rel: z.number().min(0).max(1).optional(), // относительный допуск «не хуже» (0 — любое ухудшение)
});
const CharValue = z.union([z.number(), z.string()]);
const Canon = z.object({ title: z.string().min(1), group: z.string().min(1), chars: z.record(z.string(), CharValue).default({}), aliases: z.array(z.string()).optional() });
const Row = z.object({ from: z.string(), to: z.string(), verdict: z.enum(["EQUIVALENT", "NOT_EQUIVALENT"]), source: Source, why: z.string().min(1) });
export const Family = z
  .object({
    title: z.string().min(1),
    open: z.boolean().default(false),
    chars: z.record(z.string(), CharDef).default({}),
    canon: z.record(z.string(), Canon).default({}),
    derive: z.object({ chars: z.array(z.string()).min(1), any_group: z.boolean().optional(), source: Source }).optional(),
    analogs: z.array(Row).default([]),
  })
  .superRefine((f, ctx) => {
    // ссылка на неизвестный ключ или характеристику — ошибка данных, а не тихое UNKNOWN
    for (const r of f.analogs) for (const k of [r.from, r.to]) if (!f.canon[k]) ctx.addIssue({ code: "custom", message: `аналог ${r.from} → ${r.to}: ключа ${k} нет в каноне` });
    for (const [k, c] of Object.entries(f.canon)) for (const ch of Object.keys(c.chars)) if (!f.chars[ch]) ctx.addIssue({ code: "custom", message: `канон ${k}: характеристики ${ch} нет в семействе` });
    for (const ch of f.derive?.chars ?? []) if (!f.chars[ch]) ctx.addIssue({ code: "custom", message: `derive: характеристики ${ch} нет в семействе` });
    for (const [k, d] of Object.entries(f.chars)) {
      if (d.kind === "ordinal" && !d.scale) ctx.addIssue({ code: "custom", message: `характеристика ${k}: у порядковой нет шкалы` });
      if (d.kind === "number" && !d.better) ctx.addIssue({ code: "custom", message: `характеристика ${k}: у числовой нет направления` });
    }
  });
export type Family = z.infer<typeof Family>;
export type CharDef = z.infer<typeof CharDef>;
export type AnalogSource = z.infer<typeof Source>;
export const AnalogsFile = z.object({ version: z.string(), review: z.string().optional(), families: z.record(z.string(), Family) });
export type AnalogsFile = z.infer<typeof AnalogsFile>;

export type Verdict = "EQUIVALENT" | "NOT_EQUIVALENT" | "UNKNOWN";
export type Chars = Record<string, number | string>;

export interface VerdictOut {
  verdict: Verdict;
  source: AnalogSource | null;
  why: string;
}

/**
 * Свёртка открытой марки (модель оборудования, артикул — NRM-11, OS-INSP-3.1.62): NFKC, верхний регистр, кириллические
 * буквы-двойники — латиница, без пробелов и разделителей («K 315 M», «К315М», «k-315m» → «K315M»).
 */
const TWIN: Record<string, string> = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X" };
export function foldMark(raw: string): string {
  return raw
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХ]/g, (c) => TWIN[c])
    .replace(/[\s\-‐‑‒–—−.,()/\\«»"'_]+/g, "");
}

/** Хуже ли значение РД значения ПД по характеристике (OS-INSP-3.1.61). null — не сравнить (вне шкалы, не число). */
export function charWorse(def: CharDef, pd: number | string, rd: number | string): boolean | null {
  if (def.kind === "ordinal") {
    const a = typeof pd === "string" ? classRank(def.scale!, pd) : null;
    const b = typeof rd === "string" ? classRank(def.scale!, rd) : null;
    return a === null || b === null ? null : b < a;
  }
  if (typeof pd !== "number" || typeof rd !== "number" || !Number.isFinite(pd) || !Number.isFinite(rd)) return null;
  const tol = def.tol_rel ?? 0;
  return def.better === "up" ? rd < pd * (1 - tol) : rd > pd * (1 + tol);
}

export interface CharDiff {
  key: string;
  title: string;
  pd: number | string;
  rd: number | string;
  unit: string | null;
}

/**
 * Сравнение характеристик двух значений (OS-INSP-3.1.61, путь «или аналог»): характеристика, известная с обеих сторон,
 * сравнивается по направлению семейства; неизвестная с любой стороны пропускается. keys — только эти характеристики.
 */
export function compareChars(f: Family, pd: Chars, rd: Chars, keys: string[] = Object.keys(f.chars)): { worse: CharDiff[]; compared: string[] } {
  const worse: CharDiff[] = [];
  const compared: string[] = [];
  for (const k of keys) {
    const def = f.chars[k];
    if (!def || pd[k] === undefined || rd[k] === undefined) continue;
    const w = charWorse(def, pd[k], rd[k]);
    if (w === null) continue;
    compared.push(k);
    if (w) worse.push({ key: k, title: def.title, pd: pd[k], rd: rd[k], unit: def.unit ?? null });
  }
  return { worse, compared };
}

/** Характеристики значения: из текста упоминания, недостающие — из канона семейства. */
export function charsOf(f: Family, key: string, own: Chars = {}): Chars {
  return { ...(Object.hasOwn(f.canon, key) ? f.canon[key].chars : {}), ...own };
}

/**
 * Вердикт замены «ПД → РД» (OS-INSP-3.1.60): явная строка таблицы → её вердикт; иначе правило derive семейства — оба
 * ключа в одной группе (или any_group), у обоих известны все характеристики derive: ни одна не хуже — EQUIVALENT,
 * иначе NOT_EQUIVALENT (источник derived); иначе UNKNOWN. Один и тот же ключ — EQUIVALENT без источника.
 */
export function analogVerdict(f: Family, from: string, to: string): VerdictOut {
  if (from === to) return { verdict: "EQUIVALENT", source: null, why: "то же значение" };
  const row = f.analogs.find((r) => r.from === from && r.to === to);
  if (row) return { verdict: row.verdict, source: row.source, why: row.why };
  const a = Object.hasOwn(f.canon, from) ? f.canon[from] : undefined;
  const b = Object.hasOwn(f.canon, to) ? f.canon[to] : undefined;
  const d = f.derive;
  if (d && a && b && (d.any_group || a.group === b.group) && d.chars.every((k) => a.chars[k] !== undefined && b.chars[k] !== undefined)) {
    const { worse, compared } = compareChars(f, a.chars, b.chars, d.chars);
    if (compared.length === d.chars.length) {
      const why = worse.length ? `хуже по характеристике: ${worse.map(showDiff).join("; ")}` : `не хуже по характеристикам: ${d.chars.map((k) => f.chars[k].title).join(", ")}`;
      return { verdict: worse.length ? "NOT_EQUIVALENT" : "EQUIVALENT", source: { kind: "derived", ref: d.source.ref }, why };
    }
  }
  return { verdict: "UNKNOWN", source: null, why: "замены нет в таблице аналогов" };
}

const num = (v: number | string) => (typeof v === "number" ? String(v).replace(".", ",") : v);
/** Характеристика словами: «коэффициент линейного расширения 0,012 → 0,15 мм/(м·К)». */
export function showDiff(d: CharDiff): string {
  return `${d.title} ${num(d.pd)} → ${num(d.rd)}${d.unit ? ` ${d.unit}` : ""}`;
}

/** Источник вердикта словами для причины и карточки. */
export function showSource(s: AnalogSource | null): string {
  if (!s) return "";
  return s.kind === "derived" ? `вывод по характеристикам (${s.ref})` : s.kind === "norm" ? s.ref : `каталог: ${s.ref}`;
}

/** Название значения: заголовок канона, у открытой марки — как написано. */
export function canonTitle(f: Family, key: string, raw?: string | null): string {
  return (Object.hasOwn(f.canon, key) ? f.canon[key].title : null) ?? raw ?? key;
}

// Справочник, загруженный при чтении паспортов (services/passports.ts): виды category и layers берут семейство по имени.
let FAMILIES: Record<string, Family> = {};

/** Справочник семейств (вызывается при загрузке паспортов; в тестах — напрямую). */
export function setFamilies(f: Record<string, Family>): void {
  FAMILIES = f;
}

/** Семейство по имени из паспорта; нет в справочнике — громкий отказ (ошибка данных, а не тихое UNKNOWN). */
export function familyOf(name: string, where = ""): Family {
  if (!Object.hasOwn(FAMILIES, name)) throw new Error(`${where ? `паспорт ${where}: ` : ""}семейства ${name} нет в data/seed/analogs.json`);
  return FAMILIES[name];
}
