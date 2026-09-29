// NFR-VERIFY-30 (ТЗ 9.3.6): IO вокруг замера цикла верификации — событие открытия и отчёт для протокола
// юзабилити-теста. Расчёт — в domain/verify-timing.ts; здесь только чтение audit_log и оформление.
import type { DB } from "../db.ts";
import { audit } from "./audit.ts";
import { getInspection, type Ctx } from "./inspections.ts";
import {
  cycleOf, DEFAULT_IDLE_MINUTES, FINALIZE_ACTION, MIN_PARTICIPANTS, OPEN_ACTION, SPLIT_ACTION, summarize, TARGET_MINUTES,
  type TimingEvent, type TimingSummary, type VerifyCycle,
} from "../domain/verify-timing.ts";
import { actionsSummary, type ActionsSummary } from "../domain/decision-flow.ts";

/** Инспектор открыл экран верификации — точка начала цикла. */
export async function openVerification(ctx: Ctx, inspectionId: string): Promise<{ ok: true }> {
  await getInspection(ctx.db, inspectionId); // 404 для несуществующей проверки
  await audit(ctx, OPEN_ACTION, inspectionId, {});
  return { ok: true };
}

export type ReportCycle = VerifyCycle & { inspection_id: string; user_name: string | null };
export type VerificationReport = { generated_at: string; idle_minutes: number; cycles: ReportCycle[]; summary: TimingSummary; actions: ActionsSummary };

/**
 * Группирует события верификации по проверкам: открытие и финализация несут id проверки в object_id,
 * решения — в details.inspection_id, разделение кандидата — через таблицу checks.
 */
export async function verificationReport(db: DB, opts: { idleMinutes?: number } = {}): Promise<VerificationReport> {
  const rows = await db.all<{ user_id: string | null; action: string; object_id: string | null; details: string | null; timestamp: string; check_inspection: string | null }>(
    `select a.user_id, a.action, a.object_id, a.details, a.timestamp, c.inspection_id check_inspection
     from audit_log a left join checks c on c.id = a.object_id
     where a.action in ($1, $2, $3) or a.action like 'DECISION\\_%' escape '\\' order by a.id`,
    [OPEN_ACTION, FINALIZE_ACTION, SPLIT_ACTION],
  );

  const byInspection = new Map<string, TimingEvent[]>();
  const acts: Array<number | null> = []; // OS-INSP-4.1.16: действий на решение
  for (const r of rows) {
    if (r.action.startsWith("DECISION_")) {
      try {
        acts.push((JSON.parse(r.details ?? "{}") as { actions?: number | null }).actions ?? null);
      } catch {
        acts.push(null);
      }
    }
    let id: string | null = null;
    if (r.action === OPEN_ACTION || r.action === FINALIZE_ACTION) id = r.object_id;
    else {
      try {
        id = (JSON.parse(r.details ?? "{}") as { inspection_id?: string }).inspection_id ?? null;
      } catch {
        id = null;
      }
      id ??= r.check_inspection;
    }
    if (!id) continue;
    const list = byInspection.get(id) ?? [];
    list.push({ user_id: r.user_id, action: r.action, object_id: r.object_id, timestamp: r.timestamp });
    byInspection.set(id, list);
  }

  const names = new Map((await db.all<{ id: string; name: string }>("select id, name from users")).map((u) => [u.id, u.name]));
  const cycles: ReportCycle[] = [...byInspection]
    .map(([inspection_id, evs]) => {
      const c = cycleOf(evs, opts);
      return { inspection_id, user_name: c.user_id ? (names.get(c.user_id) ?? null) : null, ...c };
    })
    .filter((c) => c.start_source !== null)
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));

  return { generated_at: new Date().toISOString(), idle_minutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES, cycles, summary: summarize(cycles), actions: actionsSummary(acts) };
}

const VERDICT_RU: Record<TimingSummary["verdict"], string> = {
  CONFIRMED: "цель ТЗ подтверждена",
  NOT_CONFIRMED: "цель ТЗ не подтверждена",
  INSUFFICIENT_PARTICIPANTS: "недостаточно участников",
};
const num = (x: number | null) => (x === null ? "—" : String(x).replace(".", ","));
const yes = (x: boolean | null) => (x === null ? "не завершён" : x ? "да" : "нет");

/** Markdown «Протокол юзабилити-теста» (форма — docs/qa/usability-test-protocol.md, раздел «Форма протокола»). */
export function reportMarkdown(r: VerificationReport): string {
  const s = r.summary;
  const lines = [
    "# Протокол юзабилити-теста — верификация протокола проверки",
    "",
    `Сформирован: ${r.generated_at} · источник: журнал аудита (VERIFICATION_OPENED → DECISION_* → PROTOCOL_FINALIZED) · порог простоя: ${r.idle_minutes} мин.`,
    `Цель ТЗ 9.3.6: полный цикл верификации ≤ ${TARGET_MINUTES} мин (wall-clock); приёмка — замер на ${MIN_PARTICIPANTS} инспекторах.`,
    `Действий на решение (ТЗ 9.3.6, не больше 3): решений со счётчиком ${r.actions.decisions}, медиана ${num(r.actions.median)}, максимум ${num(r.actions.max)}, в пределе 3 — ${r.actions.within3 === null ? "—" : `${Math.round(r.actions.within3 * 100)} %`}.`,
    "",
    "## Замеры",
    "",
    "| № | Участник | Проверка | Начало | Источник начала | Wall-clock, мин | Активно, мин | Решений | Кандидатов | Подтверждено | Разделено | ≤ 30 мин |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.cycles.map((c, i) =>
      `| ${i + 1} | ${c.user_name ?? c.user_id ?? "—"} | ${c.inspection_id} | ${c.started_at ?? "—"} | ${c.start_source === "VERIFICATION_OPENED" ? "открытие" : "первое решение"} | ${num(c.wall_minutes)} | ${num(c.active_minutes)} | ${c.decisions} | ${c.candidates} | ${c.confirmed} | ${c.splits} | ${yes(c.within_target)} |`,
    ),
    ...(r.cycles.length ? [] : ["| — | нет замеров | | | | | | | | | | |"]),
    "",
    "## Итог против цели",
    "",
    `- Циклов всего: ${s.cycles_total}, завершённых: ${s.cycles_completed}`,
    `- Участников (разные учётные записи, завершённые циклы): ${s.participants} из ${s.min_participants}`,
    `- Медиана wall-clock: ${num(s.median_wall_minutes)} мин · максимум: ${num(s.max_wall_minutes)} мин · медиана активного: ${num(s.median_active_minutes)} мин`,
    `- Доля циклов в цели ≤ ${s.target_minutes} мин: ${s.within_target_share === null ? "—" : `${Math.round(s.within_target_share * 100)} %`}`,
    "",
    `**Вывод: ${VERDICT_RU[s.verdict]}.**`,
    "",
    "Наблюдения ведущего (ошибки, затыки, SUS) вносятся по форме docs/qa/usability-test-protocol.md.",
    "",
  ];
  return lines.join("\n");
}
