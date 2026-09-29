// Точка входа API. Профиль и адреса — src/config.ts (громкая проверка окружения при старте).
import { join } from "node:path";
import { config, rinPull, ukepInfo } from "./config.ts";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { log } from "./services/audit.ts";
import { loadHttpsOptions } from "./services/tls.ts";
import { runDueSyncJobs } from "./services/rin.ts";
import { pollRin, rinCtx } from "./services/rin-pull.ts";
import { verifyBlobs } from "./services/integrity.ts";
import { runWeeklyReportIfDue } from "./services/report.ts";
import { runRetentionIfDue } from "./services/pdn.ts";
import { assertRepoSeals, syncRepoSeals } from "./services/hidden-seal.ts";
import { initParseQueue, recoverParsing } from "./services/inspections.ts";
import { setBlobRetentionGuard } from "./services/blobstore.ts";
import { pipelineSourceRetention } from "./services/pipeline-source-pins.ts";
import { startStageRuntime } from "./services/stage-runtime.ts";

// PostgreSQL (ADR-0003): адрес — INSPECTOR_DATABASE_URL. dev — миграции и сиды при открытии; gpu — только сверка схемы
// (накатывает служба api-migrate, src/migrate.ts), отказ старта, если схема отстаёт от кода
const db = await openDb();
setBlobRetentionGuard(pipelineSourceRetention(db));
// NFR-TLS (ТЗ 12.3): в профиле gpu — только HTTPS, TLS 1.3; нет файла сертификата или ключа — падение при старте
const https = loadHttpsOptions(config.tls);
const app = buildApp(db, { https });
await initParseQueue(db); // профиль gpu: RabbitMQ (ТЗ 1.5); в dev — ничего, очередь в процессе создастся по запросу
// после сбоя или отключения питания: незавершённый разбор продолжается сам, разобранное не пересчитывается
// демо-стенд только читает: разбор не возобновляется, ML там нет (T-131)
if (!config.readonly) await recoverParsing(db).catch((e) => log("ERROR", "recover parsing", { message: String(e) }));
const stages = await startStageRuntime(db);

// Фоновые задачи: отказ промиса только пишется в журнал — процесс не падает и не копит необработанные отказы
const timers: NodeJS.Timeout[] = [];
const every = (ms: number, name: string, job: () => Promise<unknown>) =>
  timers.push(setInterval(() => void job().catch((e) => log("ERROR", name, { message: String(e) })), ms).unref());

// Повторная отправка в ИАИС «РиН» по расписанию (PENDING_SYNC → 1, 5, 15 минут)
every(5_000, "rin sync", () => runDueSyncJobs(db));
// OS-INSP-1.2.15: автозабор новых пакетов из ИАИС «РиН»; цикл не накладывается на незавершённый предыдущий
if (rinPull.on) every(rinPull.intervalSec * 1000, "rin pull", () => pollRin(rinCtx(db)));
// Ежедневная сверка контрольных сумм файлов (ТЗ 13.8)
// сбой проверки уже отправлен администратору внутри verifyBlobs; здесь — только не уронить процесс
every(24 * 3600_000, "integrity check failed", () => verifyBlobs(db));
// Еженедельный отчёт по дообучению (OS-INSP-6.2.2): тик раз в час, отчёт за неделю строится один раз
const weekly = async () => await runWeeklyReportIfDue(db);
await weekly().catch((e) => log("ERROR", "weekly report", { message: String(e) }));
every(3600_000, "weekly report", weekly);
// OS-INSP-6.1.4 (T-137): печати скрытого теста из репозитория — в базу до приёма файлов, иначе гарды 6.1.6/6.1.8/6.1.9 слепы
if (!config.readonly) {
  const seals = await syncRepoSeals(db, join(config.root, "ml/eval/seals"));
  const bad = seals.conflicts.length + seals.invalid.length;
  log(bad ? "ERROR" : "INFO", "hidden seals from repo", { ...seals });
  assertRepoSeals(seals, config.profile);
}
// NFR-PDN (152-ФЗ ст. 21 ч. 7): обезличивание по сроку — тик раз в час, задача выполняется один раз за сутки UTC
const pdnRetention = async () => await runRetentionIfDue(db, new Date(), config.pdn);
if (!config.readonly) {
  await pdnRetention().catch((e) => log("ERROR", "pdn retention", { message: String(e) }));
  every(3600_000, "pdn retention", pdnRetention);
}

// Плавная остановка: перестать принимать запросы, дождаться текущих, закрыть пул PostgreSQL
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log("INFO", `api stopping on ${signal}`);
  for (const t of timers) clearInterval(t);
  try {
    await app.close();
    await stages.close();
    await db.close();
    process.exit(0);
  } catch (e) {
    log("ERROR", "shutdown", { message: String(e) });
    process.exit(1);
  }
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// NFR-UKEP: подпись к «РиН» без сертифицированного СКЗИ — коннектор работает, но это не УКЭП; видно в журнале и /health
if (ukepInfo.mode !== "off" && !ukepInfo.qualified) log("WARNING", `УКЭП: подпись запросов к ИАИС «РиН» неквалифицированная (режим ${ukepInfo.mode}) — для юридически значимого обмена нужен cryptopro с сертифицированным СКЗИ`, { ukep: ukepInfo.mode });
await app.listen({ port: config.port, host: config.host });
log("INFO", `api listening on ${https ? "https" : "http"}://${config.host}:${config.port}`, { profile: config.profile, tls: https ? https.minVersion : null });
