// OS-INSP-1.2.15–1.2.19 Автозабор пакетов из ИАИС «РиН» (ТЗ 7, модуль 6; TZA-7.6-01): чистые решения.
// Форма ответа «РиН» здесь не известна: сюда приходит уже разобранный пакет (services/rin-contract.ts).
import { createHash } from "node:crypto";
import type { ProcessStatus } from "./types.ts";
import type { Manifest } from "./upload.ts";

/** Пакет «РиН» в предметных терминах — не зависит от контракта (T-067). */
export interface RinPackage {
  package_id: string;
  object_id: string;
  card: { object_id: string; name: string; address: string; customer: string; contractor: string; permit_number: string; profile: Record<string, boolean> };
  /** Время появления пакета в «РиН», ISO 8601 UTC — по нему двигается курсор опроса. */
  created_at: string;
  manifest: Manifest | null;
  files: RinFile[];
}

export interface RinFile {
  file_id: string;
  file_name: string;
  sha256: string;
  size: number;
  url: string;
}

/** Итог по пакету в таблице rin_packages. PENDING — не забран, повтор в следующем цикле (OS-INSP-1.2.18). */
export type RinPackageStatus = "PENDING" | "FETCHED" | "NOTIFIED_ONLY" | "REJECTED";
export const FINAL_STATUSES: readonly RinPackageStatus[] = ["FETCHED", "NOTIFIED_ONLY", "REJECTED"];

/** OS-INSP-1.2.16: пакет забирается один раз. Уже завершённые и повторы внутри одного ответа отбрасываются. */
export function pickNew<T extends { package_id: string }>(listed: T[], done: ReadonlySet<string>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of listed) {
    if (done.has(p.package_id) || seen.has(p.package_id)) continue;
    seen.add(p.package_id);
    out.push(p);
  }
  return out;
}

export type Plan =
  | { action: "CREATE" }
  | { action: "APPEND"; inspection_id: string }
  | { action: "NOTIFY_ONLY"; inspection_id: string }
  | { action: "DEFER"; inspection_id: string; reason: string };

/**
 * Что делать с пакетом по последней проверке объекта:
 * нет проверки — новая (OS-INSP-1.2.15); открыта — дозагрузка (OS-INSP-1.2.7);
 * финализирована — только уведомление (OS-INSP-1.2.17); идёт разбор — отложить до следующего цикла.
 */
export function planPackage(latest: { id: string; status: ProcessStatus } | null): Plan {
  if (!latest) return { action: "CREATE" };
  if (latest.status === "FINALIZED") return { action: "NOTIFY_ONLY", inspection_id: latest.id };
  if (latest.status === "PARSING") return { action: "DEFER", inspection_id: latest.id, reason: `проверка ${latest.id} в разборе — пакет будет забран в следующем цикле` };
  return { action: "APPEND", inspection_id: latest.id };
}

/**
 * Курсор опроса (OS-INSP-1.2.18): сдвигается до последнего пакета, за которым нет незавершённых.
 * Незавершённый пакет держит курсор, чтобы попасть в следующий ответ; назад курсор не уходит.
 */
export function advanceCursor(prev: string | null, results: Array<{ created_at: string; settled: boolean }>): string | null {
  const sorted = [...results].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  let cur = prev;
  for (const r of sorted) {
    if (!r.settled) break;
    if (cur === null || r.created_at > cur) cur = r.created_at;
  }
  return cur;
}

/** Ответ «РиН» по HTTP: успех, повторить в следующем цикле (сбой сервиса) или отказ по пакету. */
export function classifyHttp(status: number): "ok" | "retry" | "fail" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 || status === 408 || status === 429) return "retry";
  return "fail";
}

export type DownloadVerdict = { ok: true } | { ok: false; code: "SIZE_MISMATCH" | "HASH_MISMATCH"; message: string };

/** Скачанное сверяется с заявленным в пакете: размер и SHA-256. Расхождение — отказ (OS-INSP-1.2.19). */
export function checkDownloaded(f: Pick<RinFile, "file_name" | "sha256" | "size">, buf: Buffer): DownloadVerdict {
  if (buf.length !== f.size) return { ok: false, code: "SIZE_MISMATCH", message: `${f.file_name}: размер ${buf.length} байт не совпадает с заявленным в «РиН» (${f.size})` };
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== f.sha256.toLowerCase()) return { ok: false, code: "HASH_MISMATCH", message: `${f.file_name}: SHA-256 скачанного файла не совпадает с заявленным в «РиН»` };
  return { ok: true };
}

/** Отказ приёма, который не зависит от самого файла: сканер недоступен — повтор в следующем цикле, а не REJECTED. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(["SCAN_UNAVAILABLE"]);
/** Тот же файл уже принят в проверку — не отказ: повтор пакета не должен его отклонять (OS-INSP-1.2.16). */
export const BENIGN_CODES: ReadonlySet<string> = new Set(["DUPLICATE"]);

export type Outcome = { status: "FETCHED" | "NOTIFIED_ONLY" | "REJECTED"; reason: string | null } | { status: "PENDING"; reason: string };

const REASON_MAX = 1000;

/**
 * Итоговый статус пакета (OS-INSP-1.2.17, 1.2.19): только уведомление — NOTIFIED_ONLY;
 * временный отказ проверки — PENDING; любой отказ правил приёма — REJECTED с причиной; иначе FETCHED.
 */
export function packageOutcome(plan: Plan, rejected: Array<{ file_name: string; code: string; message: string }>): Outcome {
  if (plan.action === "NOTIFY_ONLY") return { status: "NOTIFIED_ONLY", reason: `протокол ${plan.inspection_id} финализирован — пакет не дозагружен` };
  if (plan.action === "DEFER") return { status: "PENDING", reason: plan.reason };
  const hard = rejected.filter((r) => !BENIGN_CODES.has(r.code) && !RETRYABLE_CODES.has(r.code));
  if (hard.length) return { status: "REJECTED", reason: clip(hard.map((r) => `${r.code}: ${r.message}`).join("; ")) };
  const soft = rejected.filter((r) => RETRYABLE_CODES.has(r.code));
  if (soft.length) return { status: "PENDING", reason: clip(soft.map((r) => r.message).join("; ")) };
  return { status: "FETCHED", reason: null };
}

function clip(s: string): string {
  return s.length > REASON_MAX ? s.slice(0, REASON_MAX - 1) + "…" : s;
}
