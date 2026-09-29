// Вид «schedule» (T-213, реестр T-186): календарный график и последовательность возведения — М-082, М-087.
// Извлечение — ML schedule_rows.py (ENT-24), сравнение — domain/stage-schedule.ts (CMP-22, CMP-23 словарём).
// Гипотеза вида — перестановка этапов только по строкам таблицы, без дат (OS-INSP-3.1.164).
import { z } from "zod";
import { baseMention, registerKind, type KindMention, type KindPassport, type KindRow } from "../param-kinds.ts";
import { evaluateSchedule, type ScheduleRow, type SchedulePassport } from "../stage-schedule.ts";

// технология графика: sentence — схема возведения всей фразы последовательности («поэтажно», «на всю высоту»)
const Tech = z.object({ id: z.string().min(1), title: z.string().min(1), pattern: z.string().min(1), sentence: z.boolean().optional() });

export const ScheduleValue = z.object({
  kind: z.literal("schedule"),
  tolerance_pct: z.number().nonnegative(), // М-082: 10 % по критическому этапу
  checks: z.array(z.enum(["duration", "order", "technology"])).min(1),
  critical: z.array(z.string()), // названия критических этапов — регулярные выражения
  technologies: z.array(Tech).default([]), // минимальный словарь технологий (М-087)
  tolerance_note: z.string(),
});

export type ScheduleMention = KindMention & ScheduleRow;

/** Конфигурация сравнения для domain/stage-schedule.ts из показателя паспорта. */
export function schedulePassportOf(x: KindPassport): SchedulePassport {
  const v = ScheduleValue.parse(x.value);
  return { tolerance_pct: v.tolerance_pct, checks: v.checks, critical: v.critical, technologies: v.technologies, sources: x.sources };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cut = (x: unknown, n: number) => (typeof x === "string" ? x.slice(0, n) : null);

/** Строки извлечения → строки графика (meta.kind = schedule_row); прочие строки — мимо. */
export function scheduleMentions(rows: KindRow[]): ScheduleMention[] {
  return rows.flatMap((r) => {
    const b = baseMention(r);
    const m = b.meta as Record<string, any>;
    if (m.kind !== "schedule_row") return [];
    return [{
      // W3-06: поля из ML обрезаются, даты — только ISO, длительность — только конечное число
      ...b, quote: b.quote.slice(0, 240), excluded_why: cut(b.excluded_why, 240),
      table: Number(m.table) || 0, group: Number(m.group ?? m.table) || 0, seq: m.seq === true, order: Number(m.order) || 0, name: (r.value_text ?? "").slice(0, 200),
      days: r.value_num !== null && Number.isFinite(r.value_num) ? r.value_num : null,
      calendar: m.calendar !== false, start: typeof m.start === "string" && ISO.test(m.start) ? m.start : null, end: typeof m.end === "string" && ISO.test(m.end) ? m.end : null,
      critical: m.critical === true, total: m.total === true, tech: cut(m.tech, 40),
    }];
  });
}

export const schedule = registerKind<ScheduleMention>({
  kind: "schedule",
  value: ScheduleValue,
  extractor: z.object({ kind: z.literal("schedule_rows"), anchor: z.string(), critical_markers: z.array(z.string()), total: z.string() }),
  mentions: scheduleMentions,
  // словарь технологий едет в ML вместе с экстрактором
  spec: (x) => ({ ...x.extractor, technologies: ScheduleValue.parse(x.value).technologies.map(({ id, pattern, sentence }) => ({ id, pattern, ...(sentence ? { sentence } : {}) })) }),
  quote: (m) => m.name,
  evaluate: ({ param, passport, mentions, loadedStages, profile }) => {
    const ev = evaluateSchedule({ param, passport: schedulePassportOf(passport), rows: mentions, loadedStages, profile });
    return {
      ...ev,
      suspicions: ev.suspicions.map((x) => ({ stage: "RD" as const, description: x.description.replace(/^M-\d{3}: /, ""), mentions: x.rows as ScheduleMention[], dedup_key: x.dedup_key })),
    };
  },
});
