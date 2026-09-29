// OS-INSP-1.2.15–1.2.19 Автозабор пакетов из ИАИС «РиН» (ТЗ 7, модуль 6; TZA-7.6-01): цикл опроса.
// Решения — чистые функции domain/rin-pull.ts; форма ответа «РиН» — services/rin-contract.ts (допущение до T-067).
// Файлы пакета проходят те же проверки приёма, что ручная загрузка: формат и размеры (domain/upload.ts),
// антивирус (screenIntake), SHA-256 и реестр (ingest). Прод: mTLS + УКЭП (NFR-MTLS) — транспорт rinGetTransport из rin-tls.ts по окружению.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { config, rinPull } from "../config.ts";
import { meta, setMeta, type DB } from "../db.ts";
import { advanceCursor, checkDownloaded, classifyHttp, FINAL_STATUSES, packageOutcome, pickNew, planPackage, type Outcome, type RinPackage } from "../domain/rin-pull.ts";
import type { ProcessStatus } from "../domain/types.ts";
import { isSignatureFile } from "../domain/signature.ts";
import { maskText } from "../domain/pdn.ts";
import { checkFile, checkPackage, Manifest, MAX_FILE_BYTES, ObjectCard } from "../domain/upload.ts";
import { removeUnpinnedLocalBlobs } from "./blobstore.ts";
import { screenIntake } from "./antivirus.ts";
import { audit, log, notify } from "./audit.ts";
import { createInspection, HttpError, ingest, startProcessing, type Ctx, type User } from "./inspections.ts";
import { packagesUrl, parsePackages, toWire } from "./rin-contract.ts";
import { rinGetTransportFromEnv, type RinGet } from "./rin-tls.ts";

/** Служебный актор автозабора: не инспектор, учётки и сессии нет — войти им нельзя. В аудите — system:rin. */
export const RIN_ACTOR: User = { id: "system:rin", login: "system:rin", name: "ИАИС «РиН» — автозабор", role: "system" };
export const rinCtx = (db: DB): Ctx => ({ db, user: RIN_ACTOR });

export type { RinGet };

// Транспорт — по окружению (NFR-MTLS): direct — mTLS клиентским сертификатом, gost-proxy — шлюз СКЗИ, off — заглушка/dev.
// Строится лениво при первом опросе, как send в rin.ts: неполная настройка — громкая ошибка цикла, а не тихий fetch.
let transport: RinGet | null = null;
// NFR-UKEP: транспорт по окружению подписывает каждый GET подписью УКЭП (rin-tls.ts signedHeaders)
let get: RinGet = (url, maxBytes) => (transport ??= rinGetTransportFromEnv({ profile: config.profile, mock: config.rinMock }, { timeoutMs: rinPull.timeoutMs }))(url, maxBytes);

/** Подмена транспорта (mTLS «РиН», T-068; тесты), по образцу setRinTransport. */
export function setRinPullTransport(fn: RinGet): void {
  get = fn;
}

const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const LIST_MAX_BYTES = 10 * 1024 * 1024;
const CURSOR_KEY = "rin_pull_cursor";
const now = () => new Date().toISOString();
// NFR-PDN: текст ошибки внешней системы может нести e-mail и телефон оператора — в журнал, сводку и пакет только через маску
const msg = (e: unknown) => maskText(e instanceof Error ? e.message : String(e));

export interface PollSummary {
  skipped: boolean;
  error: string | null;
  listed: number;
  fetched: number;
  notified: number;
  rejected: number;
  pending: number;
  cursor: string | null;
}

let running: Promise<PollSummary> | null = null;

/** Курсор для сводки; база недоступна — null (сводка не бросает). */
const cursorOf = async (db: DB): Promise<string | null> => (await meta(db, CURSOR_KEY).catch(() => "")) || null;

/**
 * Один цикл опроса. Пока идёт предыдущий в этом процессе, следующий не стартует: возвращается skipped. Не бросает.
 * Между процессами API (несколько реплик) пакет делится захватом строки rin_packages (claim): забирает его один.
 */
export function pollRin(ctx: Ctx): Promise<PollSummary> {
  if (running) return cursorOf(ctx.db).then((cursor) => ({ skipped: true, error: null, listed: 0, fetched: 0, notified: 0, rejected: 0, pending: 0, cursor }));
  running = cycle(ctx)
    .catch(async (e): Promise<PollSummary> => {
      log("ERROR", "rin pull", { message: msg(e) });
      return { skipped: false, error: msg(e), listed: 0, fetched: 0, notified: 0, rejected: 0, pending: 0, cursor: await cursorOf(ctx.db) };
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function cycle(ctx: Ctx): Promise<PollSummary> {
  const { db } = ctx;
  const prev = (await meta(db, CURSOR_KEY)) || null;
  const s: PollSummary = { skipped: false, error: null, listed: 0, fetched: 0, notified: 0, rejected: 0, pending: 0, cursor: prev };
  let list;
  try {
    const r = await get(packagesUrl(config.rinUrl, prev), LIST_MAX_BYTES);
    if (classifyHttp(r.status) !== "ok") throw new Error(`HTTP ${r.status}`);
    if (r.body.length > LIST_MAX_BYTES) throw new Error(`список пакетов больше ${LIST_MAX_BYTES} байт`);
    list = parsePackages(JSON.parse(r.body.toString("utf8")), config.rinUrl);
  } catch (e) {
    // OS-INSP-1.2.18: ничего не отмечено, курсор на месте — следующий цикл запросит то же
    s.error = `ИАИС «РиН» недоступна: ${msg(e)}`;
    log("WARNING", "rin pull: список пакетов не получен", { message: s.error });
    return s;
  }
  s.listed = list.packages.length + list.invalid.length;
  const done = new Set(
    (await db.all<{ package_id: string }>(`select package_id from rin_packages where status in (${FINAL_STATUSES.map((_, i) => `$${i + 1}`).join(",")})`, FINAL_STATUSES)).map((r) => r.package_id),
  );

  // Пакет не по контракту: с узнаваемым package_id — REJECTED и администратору (OS-INSP-1.2.19)
  for (const bad of list.invalid) {
    if (!bad.package_id) {
      log("WARNING", "rin pull: пакет без package_id пропущен", { error: bad.error });
      continue;
    }
    const pid = bad.package_id;
    if (done.has(pid)) continue;
    done.add(pid);
    const st = await claimed(db, pid, bad.object_id ?? "?", null, () =>
      settle(ctx, { package_id: pid, object_id: bad.object_id ?? "?", files: [] }, { status: "REJECTED", reason: `пакет не соответствует контракту «РиН»: ${bad.error}` }, null, 0));
    if (st) s.rejected++; // null — его отклоняет другой процесс
  }

  const results: Array<{ created_at: string; settled: boolean }> = list.packages.filter((p) => done.has(p.package_id)).map((p) => ({ created_at: p.created_at, settled: true }));
  for (const pkg of pickNew(list.packages, done)) {
    const st = await claimed(db, pkg.package_id, pkg.object_id, pkg.created_at, () => take(ctx, pkg));
    // null — пакет в работе у другого процесса: курсор через него не сдвигается
    results.push({ created_at: pkg.created_at, settled: st !== null && st !== "PENDING" });
    if (st === null) continue;
    if (st === "FETCHED") s.fetched++;
    else if (st === "NOTIFIED_ONLY") s.notified++;
    else if (st === "REJECTED") s.rejected++;
    else s.pending++;
  }
  const cursor = advanceCursor(prev, results);
  if (cursor && cursor !== prev) await setMeta(db, CURSOR_KEY, cursor);
  s.cursor = cursor;
  return s;
}

/** Статус «пакет забирается» в rin_packages: служебный, между захватом и итогом (settle). */
const IN_FLIGHT = "IN_FLIGHT";
/** Захват старше этого — процесс, взявший пакет, считается упавшим: пакет забирается снова. */
export const PACKAGE_LEASE_MS = 30 * 60_000;

/**
 * Захватить пакет (OS-INSP-1.2.16 между процессами): одним оператором завести строку или перевести PENDING в IN_FLIGHT,
 * attempts + 1. Строку, захваченную другим процессом (IN_FLIGHT, захват свежий) или с итогом, оператор не трогает
 * и ничего не возвращает — пакет забирается один раз. Конкурирующий insert ждёт коммита первого и видит его захват.
 */
export async function claimRinPackage(db: DB, packageId: string, objectId: string, createdAt: string | null): Promise<boolean> {
  const at = new Date();
  const r = await db.run(
    `insert into rin_packages (package_id, object_id, status, rin_created_at, attempts, updated_at) values ($1, $2, '${IN_FLIGHT}', $3, 1, $4)
     on conflict (package_id) do update set status = '${IN_FLIGHT}', attempts = rin_packages.attempts + 1, updated_at = excluded.updated_at
       where rin_packages.status = 'PENDING' or (rin_packages.status = '${IN_FLIGHT}' and rin_packages.updated_at <= $5)
     returning package_id`,
    [packageId, objectId, createdAt, at.toISOString(), new Date(at.getTime() - PACKAGE_LEASE_MS).toISOString()],
  );
  return r.rows.length > 0;
}

/**
 * Выполнить забор под захватом. Не захвачен (у другого процесса или с итогом) — null без забора.
 * Непредвиденный сбой до итога — захват снимается (PENDING), чтобы следующий цикл не ждал истечения захвата.
 */
async function claimed(db: DB, packageId: string, objectId: string, createdAt: string | null, fn: () => Promise<Outcome["status"]>): Promise<Outcome["status"] | null> {
  if (!(await claimRinPackage(db, packageId, objectId, createdAt))) return null;
  try {
    return await fn();
  } catch (e) {
    await db.run(`update rin_packages set status = 'PENDING', updated_at = $1 where package_id = $2 and status = '${IN_FLIGHT}'`, [now(), packageId]).catch(() => undefined);
    throw e;
  }
}

/** Пакет отклонён внутри приёма: бросается из транзакции, чтобы откатить её, и несёт итог наружу. */
class PackageRolledBack extends Error {
  constructor(readonly out: Outcome) {
    super(out.reason ?? "пакет отклонён");
  }
}

/** Забор одного захваченного пакета. Итог — статус в rin_packages; PENDING — повтор в следующем цикле. */
async function take(ctx: Ctx, pkg: RinPackage): Promise<Outcome["status"]> {
  const { db } = ctx;
  // id — случайный: при равном created_at порядок среди них не определён (в пределах одной миллисекунды)
  const latest = await db.get<{ id: string; status: ProcessStatus }>("select id, status from inspections where object_id = $1 order by created_at desc, id desc limit 1", [pkg.object_id]);
  const plan = planPackage(latest ?? null);
  // финализированный протокол — файлы не нужны, только уведомление (OS-INSP-1.2.17); идёт разбор — позже
  if (plan.action === "NOTIFY_ONLY" || plan.action === "DEFER") return settle(ctx, pkg, packageOutcome(plan, []), plan.inspection_id, 0);

  const rejected: Array<{ file_name: string; code: string; message: string }> = [];
  const pkgSize = checkPackage(pkg.files.map((f) => f.size)); // OS-INSP-1.2.3 — по заявленным размерам, до скачивания
  if (!pkgSize.ok) return settle(ctx, pkg, packageOutcome(plan, [{ file_name: pkg.package_id, code: "PACKAGE_TOO_LARGE", message: pkgSize.message }]), null, 0);

  const items: Array<{ name: string; buf: Buffer }> = [];
  for (const f of pkg.files) {
    let r: { status: number; body: Buffer };
    try {
      r = await get(f.url, MAX_FILE_BYTES + 1);
    } catch (e) {
      return settle(ctx, pkg, { status: "PENDING", reason: `ИАИС «РиН» недоступна: ${msg(e)}` }, null, 0); // OS-INSP-1.2.18
    }
    const c = classifyHttp(r.status);
    if (c === "retry") return settle(ctx, pkg, { status: "PENDING", reason: `ИАИС «РиН» недоступна: HTTP ${r.status}` }, null, 0);
    if (c === "fail") {
      rejected.push({ file_name: f.file_name, code: "RIN_FILE_UNAVAILABLE", message: `${f.file_name}: «РиН» не отдала файл (HTTP ${r.status})` });
      continue;
    }
    // OS-INSP-1.2.1, 1.2.2, 1.2.4 — те же правила, что у ручной загрузки; до приёма, чтобы пакет не лёг частично.
    // Откреплённая подпись (OS-INSP-1.2.11) — не документ: её разбирает ingest
    const v = isSignatureFile(f.file_name) ? ({ ok: true } as const) : checkFile(f.file_name, r.body);
    if (!v.ok) {
      rejected.push({ file_name: f.file_name, code: v.code, message: v.message });
      continue;
    }
    const d = checkDownloaded(f, r.body);
    if (!d.ok) {
      rejected.push({ file_name: f.file_name, code: d.code, message: d.message });
      continue;
    }
    items.push({ name: f.file_name, buf: r.body });
  }
  let out = packageOutcome(plan, rejected);
  if (out.status !== "FETCHED") return settle(ctx, pkg, out, null, 0);

  // NFR-AV: тот же шаг, что на маршруте загрузки; сканер недоступен — повтор, заражён — REJECTED
  const scr = await screenIntake(ctx, plan.action === "APPEND" ? plan.inspection_id : pkg.package_id, items);
  out = packageOutcome(plan, scr.rejected);
  if (out.status !== "FETCHED") return settle(ctx, pkg, out, null, 0);

  const appendTo: string | null = plan.action === "APPEND" ? plan.inspection_id : null;
  // OS-INSP-1.2.19: пакет принимается целиком или никак. Отказ может прийти и изнутри ingest (file_id занят другим
  // файлом, расхождение с реестром) — тогда транзакция откатывает проверку, файлы и реестр, а блобы, записанные
  // этой попыткой, удаляются здесь.
  const fresh = scr.clean.map((it) => sha256hex(it.buf)).filter((h) => !existsSync(join(config.blobDir, h)));
  const dropBlobs = () => removeUnpinnedLocalBlobs(config.blobDir, fresh);
  let taken: { inspectionId: string; accepted: number; out: Outcome };
  try {
    taken = await db.tx(async (t) => {
      const tctx: Ctx = { ...ctx, db: t };
      const id = appendTo ?? (await createInspection(tctx, ObjectCard.parse(pkg.card)));
      const res = await ingest(tctx, id, scr.clean, pkg.manifest);
      const o = packageOutcome(plan, res.rejected);
      if (o.status !== "FETCHED") throw new PackageRolledBack(o);
      return { inspectionId: id, accepted: res.accepted.length, out: o };
    });
  } catch (e) {
    await dropBlobs();
    // проверка, заведённая этой попыткой, откачена — ссылаться не на что
    if (e instanceof PackageRolledBack) return settle(ctx, pkg, e.out, appendTo, 0);
    return failed(ctx, pkg, e, appendTo);
  }
  try {
    if (taken.accepted) await startProcessing(ctx, taken.inspectionId); // как ручная загрузка со start по умолчанию
  } catch (e) {
    return failed(ctx, pkg, e, taken.inspectionId);
  }
  return settle(ctx, pkg, taken.out, taken.inspectionId, taken.accepted);
}

/** Сбой приёма: статус проверки сменился между планом и приёмом (409) — повтор; иной отказ приёма — REJECTED; прочее — повтор. */
function failed(ctx: Ctx, pkg: RinPackage, e: unknown, inspectionId: string | null): Promise<Outcome["status"]> {
  // финализирована, пошёл разбор — решим заново в следующем цикле
  if (e instanceof HttpError && e.status === 409) return settle(ctx, pkg, { status: "PENDING", reason: e.message }, inspectionId, 0);
  if (e instanceof HttpError) return settle(ctx, pkg, { status: "REJECTED", reason: e.message }, inspectionId, 0);
  log("ERROR", "rin pull: сбой приёма пакета", { package_id: pkg.package_id, message: msg(e) });
  return settle(ctx, pkg, { status: "PENDING", reason: msg(e) }, inspectionId, 0);
}

/** Итог пакета: статус в rin_packages, аудит и уведомление — одной транзакцией (без итога без события и наоборот). */
async function settle(ctx: Ctx, pkg: Pick<RinPackage, "package_id" | "object_id" | "files">, out: Outcome, inspectionId: string | null, accepted: number): Promise<Outcome["status"]> {
  await ctx.db.tx((t) => settleIn({ ...ctx, db: t }, pkg, out, inspectionId, accepted));
  if (out.status === "PENDING") log("WARNING", "rin pull: пакет не забран, повтор в следующем цикле", { package_id: pkg.package_id, reason: out.reason });
  return out.status;
}

async function settleIn(ctx: Ctx, pkg: Pick<RinPackage, "package_id" | "object_id" | "files">, out: Outcome, inspectionId: string | null, accepted: number): Promise<void> {
  const { db } = ctx;
  const final = out.status !== "PENDING";
  await db.run("update rin_packages set status = $1, reason = $2, inspection_id = coalesce($3, inspection_id), fetched_at = $4, updated_at = $5 where package_id = $6", [
    out.status, out.reason, inspectionId, final ? now() : null, now(), pkg.package_id,
  ]);
  const details = { package_id: pkg.package_id, object_id: pkg.object_id, files: pkg.files.length, accepted, reason: out.reason };
  switch (out.status) {
    case "FETCHED":
      await audit(ctx, "RIN_PACKAGE_FETCHED", inspectionId, details);
      await notify(db, "inspector", inspectionId, "INFO", `Из ИАИС «РиН» забран пакет ${pkg.package_id} по объекту ${pkg.object_id}: принято файлов ${accepted}${accepted ? ", разбор запущен" : ""}.${out.reason ? ` ${out.reason}` : ""}`);
      break;
    case "NOTIFIED_ONLY":
      await audit(ctx, "RIN_PACKAGE_NOTIFIED", inspectionId, details);
      await notify(db, "inspector", inspectionId, "WARNING", `В ИАИС «РиН» новый пакет ${pkg.package_id} по объекту ${pkg.object_id} (файлов: ${pkg.files.length}). Протокол проверки ${inspectionId} финализирован — файлы не дозагружены; для их проверки откройте новую проверку.`);
      break;
    case "REJECTED":
      await audit(ctx, "RIN_PACKAGE_REJECTED", inspectionId ?? pkg.package_id, details);
      await notify(db, "admin", inspectionId, "ERROR", `Пакет ИАИС «РиН» ${pkg.package_id} по объекту ${pkg.object_id} отклонён: ${out.reason}`);
      break;
  }
}

// ─────────────────────────────── заглушка «РиН» для демо (профиль dev): пакеты синтетики data/synth/*

type MockPackage = { pkg: RinPackage; paths: Map<string, string> };
export const rinPullMock = { down: false, packages: null as MockPackage[] | null };

/** Пакет на объект синтетики; файлы из _late — второй пакет того же объекта (дозагрузка). Корпус не используется (ADR-0002). */
function synthPackages(): MockPackage[] {
  if (rinPullMock.packages) return rinPullMock.packages;
  const root = join(config.root, "data/synth");
  const out: MockPackage[] = [];
  const objs = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, "manifest.json"))).sort() : [];
  let minute = 0;
  for (const obj of objs) {
    const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, obj, "manifest.json"), "utf8")));
    const card = ObjectCard.parse(manifest.object);
    const dirs = [join(root, obj), join(root, obj, "_late")].filter((d) => existsSync(d));
    dirs.forEach((dir, i) => {
      const package_id = `SYNTH-${obj}-${i + 1}`;
      const paths = new Map<string, string>();
      const files = manifest.files
        .filter((m) => existsSync(join(dir, m.file_name)))
        .map((m) => {
          const buf = readFileSync(join(dir, m.file_name));
          paths.set(m.file_id, join(dir, m.file_name));
          return { file_id: m.file_id, file_name: m.file_name, sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length, url: `api/v1/packages/${package_id}/files/${encodeURIComponent(m.file_id)}` };
        });
      if (files.length) out.push({ pkg: { package_id, object_id: card.object_id, card, created_at: new Date(Date.UTC(2026, 8, 1, 9, minute++)).toISOString(), manifest, files }, paths });
    });
  }
  rinPullMock.packages = out;
  return out;
}

export function registerRinPullMock(app: FastifyInstance): void {
  app.get("/mock-rin/api/v1/packages", async (req, reply) => {
    if (rinPullMock.down) return reply.code(503).send({ error: "Сервис временно недоступен" });
    const since = (req.query as Record<string, string | undefined>).since;
    return synthPackages().filter((p) => !since || p.pkg.created_at >= since).map((p) => toWire(p.pkg));
  });
  app.get("/mock-rin/api/v1/packages/:pid/files/:fid", async (req, reply) => {
    if (rinPullMock.down) return reply.code(503).send({ error: "Сервис временно недоступен" });
    const { pid, fid } = req.params as { pid: string; fid: string };
    const path = synthPackages().find((p) => p.pkg.package_id === pid)?.paths.get(fid); // только из перечня: без путей из запроса
    if (!path) return reply.code(404).send({ error: "Файл не найден" });
    return reply.type("application/octet-stream").send(readFileSync(path));
  });
}
