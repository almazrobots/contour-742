import {releaseAnnotationBuffers} from "./services/data-verification.ts";
// Сборка HTTP-приложения. Отдельно от server.ts — чтобы тесты поднимали его через inject без сети.
import { listFileMentions, listFiles } from "./services/files-list.ts";
import { registerDataVerificationRoutes } from "./services/verification-routes.ts";
import { PAGES_BRIEF_SQL, pagesBrief } from "./domain/pages-brief.ts";
import { parseRange } from "./domain/byte-range.ts";
import { responseLog } from "./domain/access-log.ts";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { listPipelineRuns, pipelineTracePage } from "./services/pipeline-runs.ts";
import { listFileResultSnapshots } from "./services/file-result-snapshots.ts";
import { config, monitoring, ukepInfo } from "./config.ts";
import { meta, setMeta, type DB } from "./db.ts";
import { colorFromCounts, type DashboardCounts } from "./domain/lifecycle.ts";
import { allowed, auditForRole, type Capability } from "./domain/access.ts";
import { isReasonCode, REASON_CODES, type Role } from "./domain/types.ts";
import { failedLoginDetails, hasNul, pageQuery, tokenHash, type PageQuery } from "./domain/security.ts";
import { MAX_FILE_BYTES, MAX_PACKAGE_BYTES, ObjectCard, parseManifest, type Manifest } from "./domain/upload.ts";
import { ImportRequest } from "./domain/server-import.ts";
import { importFiles } from "./services/server-import.ts";
import { buildDataset, datasetSummary, publicationGate } from "./domain/gold.ts";
import { canResolveDispute, DISPUTE_RESOLUTIONS, retrainingUpdates } from "./domain/feedback-logs.ts";
import { activeModel, gatePrevious, perCategoryFromRecall, rollbackPlan, splitHashesMatch } from "./domain/model-registry.ts";
import { audit, log } from "./services/audit.ts";
import { appendix2For, exportProtocol, exportSubmission } from "./services/export.ts";
import {
  checkRows, createInspection, criticalUnresolvedFor, integrityFor, currentProtocol, decide, finalize, getInspection, HttpError, ingest, inspectionOcrQuality, recomputeAfterNormChange, splitCandidate, startProcessing, unfinalize, type Ctx, type UploadResult, type User,
} from "./services/inspections.ts";
import { screenIntake } from "./services/antivirus.ts";
import { registerRinPullMock } from "./services/rin-pull.ts";
import { measureDrawing, mlHealth, MlError } from "./services/ml-client.ts";
import { checkReady } from "./services/readiness.ts";
import { promoteSuspicion } from "./services/advisor.ts";
import { searchNorms } from "./services/norms.ts";
import { sheetDiffRequest } from "./services/sheetdiff.ts";
import { realObjectSql } from "./domain/synthetic.ts";

const Page = z.number().int().min(1).max(10_000);
const SheetDiffBody = z.object({ file_a: z.string().min(1).max(100), page_a: Page, file_b: z.string().min(1).max(100), page_b: Page });
import { verifyBlobs } from "./services/integrity.ts";
import { accountKey, GuestThrottle, LoginThrottle } from "./services/throttle.ts";
import { rinMock, runDueSyncJobs } from "./services/rin.ts";
import { slo, sloLines } from "./services/slo-metrics.ts";
import { IpGuard, normalizeIp } from "./services/ids.ts";
import { addChange, listChanges } from "./services/changes.ts";
import { checkRinInboundKey, ingestPrescriptionStatus, listPrescriptions } from "./services/prescriptions.ts";
import { buildRetrainingReport } from "./services/report.ts";
import { ApprovedChangeInput } from "./domain/changes.ts";
import { openapi } from "./openapi.ts";
import { openVerification, reportMarkdown, verificationReport } from "./services/usability.ts";
import { datasetItems, TrainBody, trainIteration } from "./services/retrain.ts";
import { commitRun, createSeal, listRuns, listSeals, RunBody, SealBody, verifySeal, VerifyBody, withoutHidden } from "./services/hidden-seal.ts";
import { LatencyWindow, parseSeriesQuery } from "./domain/monitoring.ts";
import { metricCatalog, MetricsSampler, querySeries } from "./services/monitoring.ts";
import { acceptSample, samplePlan } from "./services/sample-accept.ts";
import { reopenCheck } from "./services/reopen.ts";
import { rejectGroup, siblings } from "./services/common-root.ts";
import { attachOpenapiValidation, SchemaViolation } from "./services/openapi-validate.ts";
import { passportView } from "./services/passports.ts";
import { listObjects, objectCard } from "./services/objects.ts";
import { parseKeyParams } from "./domain/objects.ts";
import { blobStore, servePath, STREAM_THRESHOLD_BYTES } from "./services/blobstore.ts";
import { READONLY_MESSAGE, readonlyBlocked, guestEnabled } from "./domain/readonly.ts";
import { sameValue } from "./domain/passport.ts";
import { maskCounterparty, maskIp, PDN_NOT_PERSONAL, PDN_REGISTRY, redactUrl } from "./domain/pdn.ts";
import { deactivateUser, subjectReport } from "./services/pdn.ts";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
  interface FastifyInstance {
    metricsSampler: MetricsSampler;
    routeList: Array<{ method: string; url: string }>;
    ipGuard: IpGuard | null;
  }
}

// latency — латентности между снимками для p95 в monitoring_metrics (NFR-METRICS-STORE)
const metrics = { requests: 0, errors5xx: 0, latencyMsSum: 0, byRoute: new Map<string, number>(), latency: new LatencyWindow() };

// opts.https — NFR-TLS (ТЗ 12.3): опции services/tls.ts (только TLS 1.3); без них — HTTP (профиль dev и inject в тестах)
export function buildApp(db: DB, opts: { https?: import("./services/tls.ts").HttpsOptions | null } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, genReqId: () => randomUUID(), trustProxy: config.trustProxy, ...(opts.https ? { https: opts.https } : {}) });
  app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES + 1, files: 200 } });

  // ─────────────────────────────── наблюдаемость (ТЗ 13)
  app.addHook("onResponse", async (req, reply) => {
    metrics.requests++;
    const ms = reply.elapsedTime;
    metrics.latencyMsSum += ms;
    metrics.latency.push(ms);
    if (reply.statusCode >= 500) metrics.errors5xx++;
    const key = `${req.method} ${req.routeOptions.url ?? "?"}`;
    metrics.byRoute.set(key, (metrics.byRoute.get(key) ?? 0) + 1);
    const rl = responseLog(reply.statusCode); // 401/403/429 — событие безопасности (ТЗ 13.3), уходит в inspector-security
    log(rl.level, `${req.method} ${redactUrl(req.url)} ${reply.statusCode}`, { request_id: req.id, user_id: req.user?.id ?? null, ms: Math.round(ms), ...(rl.security ? { security: true } : {}) });
  });

  // NFR-IDS (ТЗ 12.9, T-138): до всего остального — заблокированный адрес 403, упор в лимит запросов 429;
  // после ответа — признаки запроса в детектор. Адреса из config.ids.allow не ограничиваются.
  const guard = config.ids.enabled ? new IpGuard(db, { rps: config.ids.rps, burst: config.ids.burst }) : null;
  // Исключение — по адресу СОЕДИНЕНИЯ, а не по req.ip из X-Forwarded-For: иначе «XFF: 127.0.0.1» через прокси давал бы
  // полный обход (R2 T-138, E1-L1). Отказ самого рубежа (403 блокировки, 429 лимита) детектором не учитывается: иначе
  // заблокированный или упёршийся в лимит пользователь копил бы очки и получал блокировку (E1-M4) — флаг на запросе (E1-L7).
  const ownRefusal = new WeakSet<FastifyRequest>();
  const idsExempt = (req: FastifyRequest) => {
    const peer = req.socket?.remoteAddress ?? "";
    return config.ids.allow.has(peer) || config.ids.allow.has(peer.replace(/^::ffff:/i, ""));
  };
  app.decorate("ipGuard", guard);
  if (guard) {
    app.addHook("onRequest", async (req, reply) => {
      if (idsExempt(req)) return;
      const g = await guard.gate(req.ip, req.url);
      if (g) {
        ownRefusal.add(req);
        return reply.code(g.status).header("retry-after", String(g.retryAfter)).send({ error: g.error });
      }
    });
    app.addHook("onResponse", async (req, reply) => {
      if (idsExempt(req) || ownRefusal.has(req)) return;
      const site = req.headers["sec-fetch-site"];
      await guard.observe({ ip: req.ip, url: req.url, ua: req.headers["user-agent"] ?? null, status: reply.statusCode, site: typeof site === "string" ? site : null }).catch((e) => log("ERROR", "ids observe", { message: String(e) }));
    });
  }

  // M-3 (OWASP-аудит БД): NUL в строке запроса, пути или JSON-теле — 400 до аутентификации и до базы
  // (PostgreSQL не хранит \u0000 в text/json: без этой проверки — 500 и critical-алерт на любой анонимный запрос)
  // Строка запроса и путь — в onRequest: глобальный хук идёт раньше проверки прав маршрута (T-139), тело — после разбора
  app.addHook("onRequest", async (req, reply) => {
    if (hasNul(req.query) || hasNul(req.params)) return reply.code(400).send({ error: "Недопустимый символ NUL во входных данных" });
  });
  app.addHook("preValidation", async (req, reply) => {
    if (hasNul(req.body)) return reply.code(400).send({ error: "Недопустимый символ NUL во входных данных" });
  });

  // T-131 (NFR-DEMO-READONLY): демо-стенд — изменяющие запросы отклоняются до обработчика и до базы
  app.addHook("onRequest", async (req, reply) => {
    if (readonlyBlocked(config.readonly, req.method, req.url)) return reply.code(403).send({ error: READONLY_MESSAGE });
  });

  // NFR-API-VALIDATE: запрос и ответ — по схеме openapi.ts; NFR-API-JSON: тело только application/json (multipart — загрузка),
  // text/plain Fastify по умолчанию принимал — теперь 415; неизвестный маршрут — тот же формат ошибки {error}
  const routes = attachOpenapiValidation(app, openapi as any, log);
  app.decorate("routeList", routes);
  app.removeContentTypeParser("text/plain");
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `Маршрут ${req.method} ${req.url.split("?")[0]} не найден` }));

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof SchemaViolation) return reply.code(400).send({ error: err.message, details: err.details });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: "Некорректные данные", details: err.issues });
    if (err?.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "Файл больше допустимых 50 МБ" });
    // PostgreSQL unique_violation: гонка двух одинаковых записей (версия набора, модель) — конфликт, а не сбой сервера
    if (err?.code === "23505") return reply.code(409).send({ error: "Запись с таким ключом уже существует" });
    // Страховка M-3: NUL или непереводимый символ, прошедший мимо хука (поле multipart и т. п.), — ошибка ввода, а не сбой
    if (err?.code === "22021" || err?.code === "22P05") return reply.code(400).send({ error: "Недопустимые символы во входных данных" });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    log("ERROR", "unhandled", { message: String(err?.message ?? err), stack: err?.stack });
    return reply.code(500).send({ error: "Внутренняя ошибка" });
  });

  // ─────────────────────────────── аутентификация (ТЗ 12.1, 12.2)
  // OS-INSP-4.1.26: право маршрута называется явно (domain/access.ts), без права — любой вошедший; обхода для admin нет.
  // Проверка — в onRequest: до разбора тела и до схемы OpenAPI (без прав — 403, а не 400 и не разбор 200 МБ чужой загрузки).
  // Право пишется в routeCaps — тест прав проходит по всем маршрутам и всем ролям.
  // allApiRoutes — все маршруты /api/: тест сверяет их с routeCaps и списком публичных, маршрут без auth не проскочит (R2-2)
  const routeCaps = new Map<string, Capability | null>();
  const allApiRoutes = new Set<string>();
  app.decorate("routeCaps", routeCaps);
  app.decorate("allApiRoutes", allApiRoutes);
  app.addHook("onRoute", (r) => {
    const h = [r.onRequest].flat().find((f: any) => f && "cap" in f) as { cap: Capability | null } | undefined;
    for (const m of [r.method].flat()) {
      if (m === "HEAD") continue;
      if (r.url.startsWith("/api/")) allApiRoutes.add(`${m} ${r.url}`);
      if (h) routeCaps.set(`${m} ${r.url}`, h.cap);
    }
  });
  const auth = (cap?: Capability) => Object.assign(async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization ?? "";
    // Токен — только в заголовке: строка запроса попадает в журналы и историю браузера
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    // Срок сессии сравнивает сама база (timestamptz), а не строки в JS
    const s = token
      ? await db.get<any>("select u.id, u.login, u.name, u.role from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > $2 and u.deactivated_at is null", [tokenHash(token), new Date().toISOString()])
      : undefined;
    if (!s) return reply.code(401).send({ error: "Требуется вход" });
    req.user = { id: s.id, login: s.login, name: s.name, role: s.role };
    if (cap && !allowed(s.role, cap)) return reply.code(403).send({ error: "Недостаточно прав" });
  }, { cap: cap ?? null });
  const ctx = (req: FastifyRequest): Ctx => ({ db, user: req.user!, ip: req.ip, ua: req.headers["user-agent"] });
  registerDataVerificationRoutes(app, db, auth);
  // Числовой id из пути: не целое — 404 (в PostgreSQL NaN в bigint-параметре — ошибка приведения, т. е. 500)
  const intId = (raw: unknown, notFound: string): number => {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new HttpError(404, notFound);
    return n;
  };

  // M-2: limit/offset списочных маршрутов (умолчание — по маршруту, потолок PAGE_MAX); прочие ключи запроса не трогаются
  const page = (req: FastifyRequest, defaultLimit: number): PageQuery => pageQuery(defaultLimit).parse(req.query ?? {});

  const throttle = new LoginThrottle();
  const guestThrottle = new GuestThrottle();
  // Фиктивный хеш для несуществующего логина: время ответа не выдаёт, существует ли учётная запись
  const DUMMY_HASH = `${randomBytes(16).toString("hex")}:${randomBytes(32).toString("hex")}`;
  const scryptAsync = (pw: string, salt: string) =>
    new Promise<Buffer>((res, rej) => scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));
  app.post("/api/v1/auth/login", async (req, reply) => {
    const { login, password } = z.object({ login: z.string().max(100), password: z.string().max(200) }).parse(req.body);
    // NFR-PDN: выключенная учётка не входит (вход — как для несуществующего логина)
    const u = await db.get<any>("select * from users where login = $1 and deactivated_at is null", [login]);
    const acc = accountKey(login);
    const gate = throttle.check(req.ip, acc);
    if (!gate.ok) {
      reply.header("retry-after", String(gate.retryAfter));
      return reply.code(429).send({ error: `Слишком много попыток входа. Повторите через ${gate.retryAfter} с.` });
    }
    const [salt, hash] = String(u?.password_hash ?? DUMMY_HASH).split(":");
    const got = await scryptAsync(password, salt); // асинхронно: не блокирует обработку других запросов
    const ok = Boolean(u) && timingSafeEqual(got, Buffer.from(hash, "hex"));
    if (!ok) {
      throttle.fail(req.ip, acc);
      await db.run("insert into audit_log (user_id, action, object_id, details, timestamp, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7)",
        [null, "LOGIN_FAILED", null, JSON.stringify(failedLoginDetails(login, Boolean(u))), new Date().toISOString(), req.ip, req.headers["user-agent"] ?? null]);
      return reply.code(401).send({ error: "Неверный логин или пароль" });
    }
    throttle.success(acc); // M13: счётчик ведётся по ключу логина, а не по id — иначе верный пароль получал 429
    const token = randomBytes(24).toString("hex");
    const exp = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
    // Сессия и запись LOGIN — одной транзакцией: входа без следа в журнале не бывает.
    // В базе — только хеш токена (HIGH-3); истёкшие сессии удаляются при каждом входе (M-6)
    await db.tx(async (t) => {
      await t.run("delete from sessions where expires_at < $1", [new Date().toISOString()]);
      await t.run("insert into sessions (token_hash, user_id, created_at, expires_at) values ($1,$2,$3,$4)", [tokenHash(token), u.id, new Date().toISOString(), exp]);
      await audit({ db: t, user: u, ip: req.ip, ua: req.headers["user-agent"] }, "LOGIN", null, {});
    });
    return { token, user: { id: u.id, login: u.login, name: u.name, role: u.role } };
  });
  // T-131: включён ли гостевой вход — экран входа показывает кнопку «Войти для просмотра» только тогда
  app.get("/api/v1/auth/guest", async () => ({ enabled: guestEnabled(config.readonly, config.guestLogin) }));
  // T-131: гостевой вход демо-стенда — только в режиме только чтения; без него маршрута как бы нет
  app.post("/api/v1/auth/guest", async (req, reply) => {
    if (!guestEnabled(config.readonly, config.guestLogin)) return reply.code(404).send({ error: "Гостевой вход есть только на демо-стенде" });
    const gate = guestThrottle.take(req.ip);
    if (!gate.ok) {
      reply.header("retry-after", String(gate.retryAfter));
      return reply.code(429).send({ error: `Слишком много входов. Повторите через ${gate.retryAfter} с.` });
    }
    const u = await db.get<any>("select * from users where login = $1 and deactivated_at is null", [config.guestLogin]);
    if (!u) return reply.code(404).send({ error: "Учётка гостя не найдена" });
    const token = randomBytes(24).toString("hex");
    const exp = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
    await db.tx(async (t) => {
      await t.run("delete from sessions where expires_at < $1", [new Date().toISOString()]);
      await t.run("insert into sessions (token_hash, user_id, created_at, expires_at) values ($1,$2,$3,$4)", [tokenHash(token), u.id, new Date().toISOString(), exp]);
      await audit({ db: t, user: u, ip: req.ip, ua: req.headers["user-agent"] }, "LOGIN", null, { guest: true });
    });
    return { token, user: { id: u.id, login: u.login, name: u.name, role: u.role } };
  });
  app.get("/api/v1/auth/me", { onRequest: auth() }, async (req) => req.user);
  app.post("/api/v1/auth/logout", { onRequest: auth() }, async (req) => {
    await releaseAnnotationBuffers(db,req.user!.id);
    await db.run("delete from sessions where token_hash = $1", [tokenHash((req.headers.authorization ?? "").slice(7))]);
    return { ok: true };
  });

  // ─────────────────────────────── служебное
  app.get("/health", async () => ({ status: "ok", profile: config.profile, ukep: ukepInfo, revision: process.env.INSPECTOR_REVISION?.trim() || null, ml: await mlHealth(), versions: { matrix: await meta(db, "matrix_version"), model: await meta(db, "model_version"), dataset: await meta(db, "dataset_version") } }));
  // NFR-SLA (ТЗ 11-12): готовность для пробы blackbox-exporter — БД и ML за ≤ 2 с, иначе 503 с именами отказавших
  app.get("/ready", async (_req, reply) => {
    const r = await checkReady(db);
    return reply.code(r.code).send(r.body);
  });
  app.get("/metrics", async (_req, reply) => {
    const mem = process.memoryUsage();
    const q = (await db.get<{ n: number }>("select count(*) n from files where parse_status in ('PENDING','PARSING')"))!;
    const sessions = (await db.get<{ n: number }>("select count(*) n from sessions where expires_at > $1", [new Date().toISOString()]))!;
    const lines = [
      "# HELP inspector_http_requests_total Число HTTP-запросов",
      "# TYPE inspector_http_requests_total counter",
      `inspector_http_requests_total ${metrics.requests}`,
      "# TYPE inspector_http_errors_5xx_total counter",
      `inspector_http_errors_5xx_total ${metrics.errors5xx}`,
      // T-085: сумма — счётчик, среднее за окно считает Prometheus: rate(sum[5m]) / rate(requests_total[5m])
      "# TYPE inspector_http_latency_ms_sum counter",
      `inspector_http_latency_ms_sum ${metrics.latencyMsSum.toFixed(2)}`,
      "# TYPE inspector_http_latency_ms_avg gauge",
      `inspector_http_latency_ms_avg ${metrics.requests ? (metrics.latencyMsSum / metrics.requests).toFixed(2) : 0}`,
      "# TYPE inspector_queue_size gauge",
      `inspector_queue_size ${q.n}`,
      "# TYPE inspector_active_sessions gauge",
      `inspector_active_sessions ${sessions.n}`,
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${mem.rss}`,
      "# TYPE process_cpu_user_seconds_total counter",
      `process_cpu_user_seconds_total ${(process.cpuUsage().user / 1e6).toFixed(3)}`,
      ...(guard?.lines() ?? []), // NFR-IDS: признаки атак, блокировки, отказы по лимиту
      ...sloLines(), // NFR-PERF-RUNTIME (T-138): пределы §11 — ML-анализ параметра, CV листа, отправка в «РиН»
    ];
    reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });
  // NFR-METRICS-STORE (ТЗ §10 п. 13): снимок раз в минуту в monitoring_metrics, хранение 90 дней, ряд — администратору
  const sampler = new MetricsSampler(db, metrics, { service: "api", tags: { profile: config.profile } });
  app.decorate("metricsSampler", sampler);
  if (monitoring.snapshotSec > 0) app.addHook("onReady", async () => sampler.start(monitoring.snapshotSec * 1000));
  app.addHook("onClose", async () => {
    await sampler.stop();
  });
  app.get("/api/v1/monitoring/metrics", { onRequest: auth("monitoring.read") }, async (req) => {
    const q = parseSeriesQuery(req.query as Record<string, string | undefined>, Date.now());
    if (!q.ok) throw new HttpError(400, q.error);
    return await querySeries(db, q);
  });
  app.get("/api/v1/monitoring/metric-names", { onRequest: auth("monitoring.read") }, async () => await metricCatalog(db));
  // NFR-IDS: блокировки адресов — администратору; снятие — запись IDS_UNBLOCK в журнал аудита
  app.get("/api/v1/admin/security/blocks", { onRequest: auth("security.admin") }, async (req) => {
    const all = String((req.query as any)?.all ?? "") === "1";
    const rows = await db.all<any>(
      `select ip, reason, score, events_json, blocks, blocked_at, until, released_at, released_by from ip_blocks
       ${all ? "" : "where released_at is null and until > $1"} order by blocked_at desc limit 500`,
      all ? [] : [new Date().toISOString()],
    );
    const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
    return {
      enabled: Boolean(guard),
      blocks: rows.map((r) => ({
        ip: r.ip, reason: r.reason, score: r.score, events: JSON.parse(r.events_json), blocks: r.blocks,
        blocked_at: iso(r.blocked_at), until: iso(r.until), released_at: iso(r.released_at), released_by: r.released_by,
        active: !r.released_at && new Date(r.until).getTime() > Date.now(),
      })),
    };
  });
  app.delete("/api/v1/admin/security/blocks/:ip", { onRequest: auth("security.admin") }, async (req) => {
    const raw = String((req.params as any).ip);
    const ip = normalizeIp(raw);
    if (!ip) throw new HttpError(400, "Ожидается IPv4- или IPv6-адрес"); // R2 T-138, E1-L2
    if (!guard) throw new HttpError(409, "Система защиты выключена (INSPECTOR_IDS=off)");
    if (!(await guard.release(ip, { id: req.user!.id, ip: req.ip, ua: req.headers["user-agent"] ?? null }))) {
      log("INFO", "ids unblock: нет активной блокировки", { ip, user_id: req.user!.id, security: true });
      throw new HttpError(404, `Активной блокировки адреса ${ip} нет`);
    }
    return { ok: true, ip };
  });
  app.get("/api/v1/openapi.json", async () => openapi);
  app.get("/api/v1/dictionaries", async () => ({ reason_codes: REASON_CODES, limits: { file_mb: MAX_FILE_BYTES / 1048576, package_mb: MAX_PACKAGE_BYTES / 1048576 } }));

  // ─────────────────────────────── загрузка (ТЗ 9.6: POST /api/v1/documents/upload → process_id)
  app.post("/api/v1/documents/upload", { onRequest: auth("inspection.work") }, async (req, reply) => {
    const items: Array<{ name: string; buf: Buffer }> = [];
    let manifest: Manifest | null = null;
    let manifestError: string | null = null;
    const fields: Record<string, string> = {};
    let total = 0;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buf = await part.toBuffer();
        total += buf.length;
        if (total > MAX_PACKAGE_BYTES) throw new HttpError(413, `Пакет больше допустимых 200 МБ`);
        const name = Buffer.from(part.filename, "latin1").toString("utf8");
        const plainName = /[Ѐ-ӿ]/.test(part.filename) ? part.filename : name;
        if (part.fieldname === "manifest") {
          try {
            manifest = parseManifest(plainName, buf);
          } catch (e) {
            manifestError = e instanceof Error ? e.message.slice(0, 300) : String(e);
          }
        } else items.push({ name: plainName, buf });
      } else fields[part.fieldname] = String(part.value);
    }
    if (manifestError) throw new HttpError(400, `Реестр файлов не читается: ${manifestError}`);
    let processId = fields.process_id;
    if (!processId) {
      const card = ObjectCard.parse(fields.object ? JSON.parse(fields.object) : manifest?.object);
      processId = await createInspection(ctx(req), card);
    }
    // NFR-AV: антивирус до сохранения; заражённое и непроверенное не попадает в хранилище
    // (общий шаг с автозабором из «РиН», OS-INSP-1.2.15)
    const scr = await screenIntake(ctx(req), processId, items);
    const avRejected: UploadResult["rejected"] = scr.rejected;
    items.splice(0, items.length, ...scr.clean);
    const ingested = await ingest(ctx(req), processId, items, manifest);
    const res = { ...ingested, rejected: [...avRejected, ...ingested.rejected] };
    if (fields.start !== "false" && res.accepted.length) await startProcessing(ctx(req), processId);
    reply.code(res.accepted.length || res.signatures.length ? 202 : 400); // одна подпись к принятому документу — тоже приём
    return { ...res, status: (await getInspection(db, processId)).status };
  });

  // OS-INSP-1.2.36…1.2.39 (T-169): серверный импорт — файл больше 50 МБ уже лежит в каталоге хранилища под именем SHA-256
  // (загрузчик положил его вне интерактивного запроса); здесь только JSON со ссылками по хешу, содержимое читается потоком
  app.post("/api/v1/documents/import", { onRequest: auth("inspection.work") }, async (req, reply) => {
    // NFR-API-JSON: multipart валидатор схемы пропускает мимо (он для загрузки) — здесь только JSON
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Тело запроса серверного импорта — только application/json");
    const res = await importFiles(ctx(req), ImportRequest.parse(req.body ?? {}));
    reply.code(res.accepted.length ? 202 : 400);
    return { ...res, status: (await getInspection(db, res.process_id)).status };
  });

  app.post("/api/v1/inspection/:id/start", { onRequest: auth("inspection.work") }, async (req) => await startProcessing(ctx(req), (req.params as any).id));
  // OS-INSP-3.4: дифф пары листов по запросу инспектора (автоматический режим — хук в конце разбора)
  app.post("/api/v1/inspection/:id/sheet-diff", { onRequest: auth("inspection.work") }, async (req) =>
    await sheetDiffRequest(ctx(req), (req.params as any).id, SheetDiffBody.parse(req.body)),
  );

  app.get("/api/v1/inspection/:id/status", { onRequest: auth("inspection.read") }, async (req) => {
    const i = await getInspection(db, (req.params as any).id);
    const files = await db.all("select id, file_name, doc_stage, parse_status, parse_error, revision_role, intake_source from files where inspection_id = $1", [i.id]);
    return { process_id: i.id, status: i.status, scenario: i.scenario, upload_status: JSON.parse(i.load_codes_json ?? "[]"), protocol_version: i.protocol_version, sync_status: i.sync_status, files };
  });

  app.get("/api/v1/inspection/:id/protocol", { onRequest: auth("inspection.read") }, async (req) => {
    const { id } = req.params as any;
    const v = (req.query as any).version;
    if (v) {
      // не целое число — 404, а не ошибка приведения типа в PostgreSQL
      const n = Number(v);
      const p = Number.isSafeInteger(n) ? await db.get<any>("select body_json, status from protocols where inspection_id = $1 and version = $2", [id, n]) : undefined;
      if (!p) throw new HttpError(404, "Версия протокола не найдена");
      return { ...JSON.parse(p.body_json), snapshot_status: p.status };
    }
    const i = await getInspection(db, id);
    if (i.protocol_version === 0) throw new HttpError(409, `Протокол ещё не сформирован (статус ${i.status})`);
    return await currentProtocol(db, id);
  });

  // OS-INSP-5.1.2: запись о применении ИИ для акта (2078-ПП п. 9(1).8): JSON или готовый текст (?format=text)
  app.get("/api/v1/inspection/:id/ai-usage", { onRequest: auth("inspection.read") }, async (req, reply) => {
    const id = (req.params as any).id;
    const final = (await getInspection(db, id)).status === "FINALIZED";
    const rec = (await currentProtocol(db, id)).ai_usage;
    // текст для акта — только по финализированному протоколу: до этого данные ещё меняются решениями инспектора
    if ((req.query as any).format === "text") {
      if (!final) throw new HttpError(409, "Текст для акта формируется по финализированному протоколу — сначала завершите проверку");
      return reply.type("text/plain; charset=utf-8").send(rec.act_text);
    }
    return { ...rec, final };
  });
  app.get("/api/v1/inspection/:id/protocol/export", { onRequest: auth("inspection.read") }, async (req, reply) => {
    const { id } = req.params as any;
    const format = z.enum(["json", "xml", "pdf", "docx", "submission"]).parse((req.query as any).format ?? "json");
    const i = await getInspection(db, id);
    if (i.protocol_version === 0) throw new HttpError(409, "Протокол ещё не сформирован");
    // T-117 (OS-INSP-5.1.3): ответ в формате организатора; не проходит схему — 422 с полем, файл не отдаётся
    if (format === "submission") {
      const sub = await exportSubmission(db, id);
      await audit(ctx(req), "PROTOCOL_EXPORTED", id, { format, version: i.protocol_version, checks: sub.checks.length });
      reply.header("content-disposition", `attachment; filename="submission-${i.object_id}-v${i.protocol_version}.json"`);
      return reply.type("application/json; charset=utf-8").send(JSON.stringify(sub, null, 2));
    }
    const out = await exportProtocol(await currentProtocol(db, id), format, format === "pdf" || format === "docx" ? await appendix2For(db, id) : undefined);
    await audit(ctx(req), "PROTOCOL_EXPORTED", id, { format, version: i.protocol_version });
    reply.header("content-disposition", `attachment; filename="protocol-${id}-v${i.protocol_version}.${format}"`);
    reply.type(out.type).send(out.body);
  });

  // OS-INSP-2.1.16 (ТЗ 9.1.1): доля нечитаемых зон и покрываемость распознанным текстом — по файлам и итог
  app.get("/api/v1/inspection/:id/ocr-quality", { onRequest: auth("inspection.read") }, async (req) => {
    const id = (req.params as any).id;
    await getInspection(db, id); // 404, если проверки нет
    return await inspectionOcrQuality(db, id);
  });
  app.get("/api/v1/inspection/:id/protocols", { onRequest: auth("inspection.read") }, async (req) =>
    db.all("select version, status, matrix_version, model_version, dataset_version, input_manifest_hash, created_at, finalized_at from protocols where inspection_id = $1 order by version desc", [(req.params as any).id]),
  );

  // Раздел «Файлы»: все обработанные файлы с извлечёнными параметрами, постранично
  app.get("/api/v1/files", { onRequest: auth("inspection.read") }, async (req) => {
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(req, 25);
    return await listFiles(db, { limit, offset, q: q.q, status: q.status, docType: q.doc_type, objectId: q.object_id });
  });

  // Упоминания параметров одного файла (раскрытие в разделе «Файлы»): по параметру, постранично
  app.get("/api/v1/files/:file_id/runs", { onRequest: auth("inspection.read") }, async (req) => {
    const fileId = (req.params as any).file_id;
    const stored = await db.get(`select f.sha256, f.parse_status, f.engine, f.ml_revision,
      f.pipeline_result_run_id pipeline_run_id,
      case when f.pipeline_result_run_id is null then 'untraced'
           when r.id is not null then 'pipeline_linked' else 'inconsistent' end trace_status
      from files f left join pipeline_runs r on r.id=f.pipeline_result_run_id and r.file_id=f.id and r.sha256=f.sha256
      where f.id=$1`, [fileId]);
    if (!stored) throw new HttpError(404, "Файл не найден");
    const { limit, offset } = page(req, 20);
    // File metadata is not a reconstructed run or proof of completed stages.
    return { runs: await listPipelineRuns(db, fileId, limit, offset), recorded_result: stored };
  });

  app.get("/api/v1/files/:file_id/runs/:run_id/trace", { onRequest: auth("inspection.read") }, async (req) => {
    const { file_id, run_id } = req.params as { file_id: string; run_id: string };
    const { page: number } = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1) }).parse(req.query);
    const trace = await pipelineTracePage(db, file_id, run_id, number);
    if (!trace) throw new HttpError(404, "Запуск файла не найден");
    return trace;
  });

  app.get("/api/v1/files/:file_id/result-snapshots", { onRequest: auth("inspection.read") }, async (req) => {
    const fileId = (req.params as { file_id: string }).file_id;
    if (!(await db.get("select id from files where id=$1", [fileId]))) throw new HttpError(404, "Файл не найден");
    const { limit, offset } = page(req, 20);
    return { snapshots: await listFileResultSnapshots(db, fileId, limit, offset) };
  });

  app.get("/api/v1/files/:file_id/result-snapshots/:snapshot_id/extractions", { onRequest: auth("inspection.read") }, async (req) => {
    const { file_id, snapshot_id } = req.params as { file_id: string; snapshot_id: string };
    if (!(await db.get("select id from file_result_snapshots where id=$1 and file_id=$2", [snapshot_id, file_id])))
      throw new HttpError(404, "Снимок результата файла не найден");
    const { limit, offset } = page(req, 25);
    // Expand/slice in PostgreSQL; a historical file can contain many findings.
    const rows = await db.all(`select entry.value extraction from file_result_snapshots s,
      lateral json_array_elements(s.payload_json->'extractions') with ordinality entry(value,n)
      where s.id=$1 and s.file_id=$2 order by entry.n limit $3 offset $4`, [snapshot_id, file_id, limit, offset]);
    return { extractions: rows.map(r => typeof r.extraction === "string" ? JSON.parse(r.extraction) : r.extraction) };
  });

  app.get("/api/v1/files/:file_id/params", { onRequest: auth("inspection.read") }, async (req) => {
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(req, 20);
    const res = await listFileMentions(db, (req.params as any).file_id, q.param || undefined, limit, offset);
    if (!res) throw new HttpError(404, "Файл не найден");
    return res;
  });

  // ─────────────────────────────── дашборд (OS-INSP-8.1)
  app.get("/api/v1/inspections", { onRequest: auth("inspection.read") }, async (req) => {
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(req, 200);
    // M-2: проверки читаются пачками по BATCH, строки проверок — только для проверок пачки (не все проверки всех объектов).
    // Цвет и раздел вычисляются по проверкам, поэтому фильтры и limit/offset применяются к пачке, а не в SQL
    const BATCH = 500;
    const out: any[] = [];
    let skipped = 0;
    for (let from = 0; out.length < limit; from += BATCH) {
      // NFR-LOAD-100: только колонки дашборда — без реестра пакета (manifest_json) каждой из сотен проверок
      const rows = await db.all<any>(`select i.id, i.object_id, i.status, i.scenario, i.load_codes_json, i.protocol_version, i.sync_status, i.created_at, i.updated_at,
          o.name object_name, o.address from inspections i join objects o on o.id = i.object_id
          order by i.updated_at desc, i.id limit $1 offset $2`, [BATCH, from]);
      if (!rows.length) break;
      // NFR-LOAD-100: счётчики, цвет и разделы — агрегатом в PostgreSQL, одна строка на проверку. Раньше в Node уходили все
      // строки проверок пачки (100 проверок × 132 параметра на каждый запрос дашборда) — под 100 инспекторами это держало
      // единственный поток API (стенд hk: p50 /status 850 мс при load 1,2 из 8). Эталон агрегата — domain dashboardCounts.
      const agg = new Map<string, any>();
      for (const a of await db.all<any>(`select c.inspection_id,
            count(*)::int total,
            (count(*) filter (where c.finding_status = 'CANDIDATE' and c.verification_status = 'PENDING'))::int candidates,
            (count(*) filter (where c.verification_status = 'CONFIRMED_VIOLATION'))::int confirmed,
            (count(*) filter (where c.finding_status = 'CLARIFICATION_REQUIRED' or c.verification_status = 'CLARIFICATION_REQUIRED'))::int clarification,
            (count(*) filter (where c.finding_status = 'MISSING_EVIDENCE'))::int missing,
            (count(*) filter (where c.finding_status = 'NEGATIVE_VERIFIED' or c.verification_status = 'NEGATIVE_VERIFIED'))::int negative,
            coalesce(json_agg(distinct p.section) filter (where c.finding_status = 'CANDIDATE' or c.verification_status = 'CONFIRMED_VIOLATION'), '[]')::text sections
          from checks c left join params p on p.id = c.param_id -- T-234: ссылка на Матрицу — Checks.param_id
          where c.inspection_id in (select jsonb_array_elements_text($1::jsonb)) and c.verification_status != 'SPLIT'
          group by c.inspection_id`, [rows.map((i) => i.id)])) agg.set(a.inspection_id, a);
      for (const i of rows) {
        const a = agg.get(i.id);
        const counts: DashboardCounts = a
          ? { candidates: a.candidates, confirmed: a.confirmed, clarification: a.clarification, missing: a.missing, negative: a.negative, total: a.total }
          : { candidates: 0, confirmed: 0, clarification: 0, missing: 0, negative: 0, total: 0 };
        const r = {
          process_id: i.id, object_id: i.object_id, object_name: i.object_name, address: i.address, status: i.status, scenario: i.scenario,
          upload_status: JSON.parse(i.load_codes_json ?? "[]"), protocol_version: i.protocol_version, sync_status: i.sync_status,
          created_at: i.created_at, updated_at: i.updated_at, color: colorFromCounts(counts),
          sections: a ? (JSON.parse(a.sections) as Array<string | null>) : [],
          counts,
        };
        const match =
          (!q.status || r.status === q.status) &&
          (!q.color || r.color === q.color) &&
          (!q.section || r.sections.includes(q.section)) &&
          (!q.from || r.updated_at >= q.from) &&
          (!q.to || r.updated_at <= q.to + "T23:59:59") &&
          (!q.q || `${r.object_name} ${r.address} ${r.process_id}`.toLowerCase().includes(q.q.toLowerCase()));
        if (!match) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        out.push(r);
        if (out.length >= limit) break;
      }
      if (rows.length < BATCH) break;
    }
    return out;
  });

  app.get("/api/v1/inspections/:id", { onRequest: auth("inspection.read") }, async (req) => {
    const i = await getInspection(db, (req.params as any).id);
    // NFR-PDN (минимизация): колонки явно; застройщик и подрядчик — только ролям надзора, иначе «***»
    const object = maskCounterparty(await db.get<any>("select id, name, address, customer, contractor, permit_number, profile_json, created_at from objects where id = $1", [i.object_id]), req.user!.role);
    const files = await db.all<any>(`select id, client_file_id, file_name, sha256, size, kind, doc_stage, discipline, document_code, revision, approval_status, approval_date, predecessor_id, signature_status, revision_role, revision_note, parse_status, parse_error, ${PAGES_BRIEF_SQL} pages_json, engine, uploaded_at, file_path, intake_source, doc_type, doc_type_json, signature_check_json from files where inspection_id = $1 order by doc_stage, document_code, revision`, [i.id]);
    // Реквизиты всех файлов проверки — одним запросом
    const requisites = new Map<string, any[]>();
    for (const r of await db.all<any>("select r.file_id, r.kind, r.page, r.bbox_json, r.confidence from requisites r join files f on f.id = r.file_id where f.inspection_id = $1 order by r.page, r.kind", [i.id])) {
      const list = requisites.get(r.file_id) ?? [];
      list.push(r);
      requisites.set(r.file_id, list);
    }
    const detailMode = z.enum(["full", "deferred"]).parse((req.query as any).details ?? "full");
    const checks = await checkRows(db, i.id, detailMode === "deferred");
    const suspicions = await db.all("select * from suspicions where inspection_id = $1 order by case review_priority when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end, id", [i.id]);
    const protocols = await db.all("select version, status, created_at, finalized_at from protocols where inspection_id = $1 order by version desc", [i.id]);
    const syncJobs = await db.all("select * from sync_jobs where inspection_id = $1 order by id desc", [i.id]);
    // NFR-LOAD-100: «object_id = … or object_id in (подзапрос)» не идёт по индексу ix_audit_object и сканирует весь журнал,
    // который растёт с каждым решением; две выборки по индексу через union all — тот же результат.
    // NFR-PDN + OS-INSP-4.1.28: IP и User-Agent из выборки видят только супервизор и администратор — их отрезает auditForRole
    const auditRows = await db.all(`select a.*, u.name user_name from (
        select * from audit_log where object_id = $1
        union all
        select l.* from audit_log l join checks c on c.id = l.object_id where c.inspection_id = $1
      ) a left join users u on u.id = a.user_id order by a.id desc limit 200`, [i.id]);
    const manifest = i.manifest_json ? JSON.parse(i.manifest_json) : null;
    const uploadedIds = new Set(files.map((f) => f.client_file_id));
    return {
      inspection: { ...i, manifest_json: undefined, load_codes: JSON.parse(i.load_codes_json ?? "[]") },
      object: { ...object, profile: JSON.parse(object.profile_json ?? "{}") },
      // OS-INSP-2.3.1, 2.3.4: реквизиты по файлу — вид, страница, bbox (ТЗ §5 прим. 2: отметки наличия по каждому скану)
      files: files.map((f) => ({
        ...f,
        pages: pagesBrief(f.pages_json), // T-135: только поля, нужные интерфейсу (TZA-11-10 p95)
        pages_json: undefined,
        doc_type: f.doc_type_json ? JSON.parse(f.doc_type_json) : null, // OS-INSP-2.2.7
        doc_type_json: undefined,
        signature_check: f.signature_check_json ? JSON.parse(f.signature_check_json) : null, // OS-INSP-1.2.11: VALID/INVALID/UNVERIFIED с причиной
        signature_check_json: undefined,
        requisites: (requisites.get(f.id) ?? []).map((r) => ({ kind: r.kind, page: r.page, bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null, confidence: r.confidence })),
      })),
      missing_files: (manifest?.files ?? []).filter((f: any) => !uploadedIds.has(f.file_id)),
      checks,
      suspicions,
      protocols,
      sync_jobs: syncJobs,
      audit: auditRows.map((a) => auditForRole(req.user?.role, a)), // OS-INSP-4.1.28
    };
  });

  // ─────────────────────────────── раздел «Объекты» (T-166, OS-INSP-8.1.3–8.1.7): объект — главная сущность, проверки — журнал
  // внутри объекта. Только чтение. Ключевые параметры — ?params=M-023,M-001 (по умолчанию М-023), не зашиты в код
  const keyParams = (req: FastifyRequest): string[] => {
    const codes = parseKeyParams((req.query as Record<string, string | undefined>)?.params);
    if (!codes) throw new HttpError(400, "params — коды параметров Матрицы через запятую (M-023,M-001), не больше 10");
    return codes;
  };
  app.get("/api/v1/objects", { onRequest: auth("inspection.read") }, async (req) => {
    const { limit, offset } = page(req, 200);
    return await listObjects(db, keyParams(req), limit, offset);
  });
  app.get("/api/v1/objects/:id", { onRequest: auth("inspection.read") }, async (req) => await objectCard(db, (req.params as { id: string }).id, keyParams(req)));

  // OS-INSP-2.4: измерение на чертеже — масштаб и расстояния в мм с bbox; противоречивый масштаб — NOT_COMPARABLE
  app.get("/api/v1/files/:id/measure", { onRequest: auth("inspection.read") }, async (req) => {
    const f = await db.get<any>("select sha256, kind from files where id = $1", [(req.params as any).id]);
    if (!f) throw new HttpError(404, "Файл не найден");
    if (f.kind !== "pdf") throw new HttpError(415, "Измерение доступно только для PDF-чертежей");
    const page = Number((req.query as any).page ?? 1);
    if (!Number.isInteger(page) || page < 1) throw new HttpError(400, "page — номер страницы с 1");
    try {
      const m = await measureDrawing({ sha256: f.sha256, page });
      if (typeof m.ms === "number") slo.cvSheet.observe(m.ms / 1000); // NFR-PERF-RUNTIME, TZA-11-08
      return m;
    } catch (e) {
      if (e instanceof MlError) throw new HttpError(e.status === 422 ? 422 : 502, e.message);
      throw e;
    }
  });
  app.get("/api/v1/files/:id/content", { onRequest: auth("inspection.read") }, async (req, reply) => {
    const f = await db.get<any>("select sha256, kind, file_name, size from files where id = $1", [(req.params as any).id]);
    if (!f) throw new HttpError(404, "Файл не найден");
    const type = {
      pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xml: "application/xml",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", jpg: "image/jpeg", png: "image/png", tif: "image/tiff", // GAP-INSP-04
    }[f.kind as string] ?? "application/octet-stream";
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    // T-169 (OWASP HIGH-001): большой файл (серверный импорт) — диапазоном потоком из проверенной копии, не буфером
    // целиком на каждый Range: том ИД на гигабайт иначе съедает память API кратно числу открытых вкладок
    if (Number(f.size) > STREAM_THRESHOLD_BYTES) {
      const p = await servePath(blobStore(), f.sha256).catch((e: any) => { throw new HttpError(e?.status ?? 500, e?.message ?? "Хранилище файлов недоступно"); });
      const total = statSync(p).size;
      reply.header("accept-ranges", "bytes");
      const range = parseRange(req.headers.range, total);
      if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${total}`).send();
      if (range) return reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${total}`).header("content-length", String(range.end - range.start + 1)).type(type).send(createReadStream(p, { start: range.start, end: range.end }));
      return reply.header("content-length", String(total)).type(type).send(createReadStream(p));
    }
    // из кэша или из S3 с проверкой GCM и SHA-256 (ADR-0006); отказ хранилища — его код (404, 500, 503)
    const buf = await blobStore().get(f.sha256).catch((e: any) => { throw new HttpError(e?.status ?? 500, e?.message ?? "Хранилище файлов недоступно"); });
    // T-133: кусками для pdf.js — лист чертежа открывается без скачивания всего файла
    reply.header("accept-ranges", "bytes");
    const range = parseRange(req.headers.range, buf.length);
    if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${buf.length}`).send();
    if (range) return reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${buf.length}`).type(type).send(buf.subarray(range.start, range.end + 1));
    reply.type(type).send(buf);
  });

  // ─────────────────────────────── верификация (OS-INSP-4)
  // NFR-VERIFY-30 (ТЗ 9.3.6): начало цикла верификации и отчёт для протокола юзабилити-теста
  app.post("/api/v1/inspection/:id/verification/open", { onRequest: auth("inspection.work") }, async (req) => await openVerification(ctx(req), (req.params as any).id));
  app.get("/api/v1/usability/verification-report", { onRequest: auth("usability.report") }, async (req, reply) => {
    const q = z.object({ format: z.enum(["json", "md"]).default("json"), idle_minutes: z.coerce.number().min(1).max(240).optional() }).parse(req.query);
    const r = await verificationReport(db, { idleMinutes: q.idle_minutes });
    if (q.format === "md") return reply.type("text/markdown; charset=utf-8").send(reportMarkdown(r));
    return r;
  });
  // actions — число действий инспектора до решения (OS-INSP-4.1.16), для замера ТЗ 9.3.6
  const Actions = z.number().int().min(0).max(100).optional();
  const DecisionBody = z.discriminatedUnion("action", [
    z.object({ action: z.literal("confirm"), comment: z.string().max(2000).optional(), actions: Actions }),
    z.object({ action: z.literal("reject"), reason_code: z.string(), comment: z.string().max(2000), actions: Actions }),
    z.object({ action: z.literal("clarify"), comment: z.string().max(2000).optional(), actions: Actions }),
  ]);
  app.post("/api/v1/checks/:id/decision", { onRequest: auth("inspection.work") }, async (req) => {
    const body = DecisionBody.parse(req.body);
    if (body.action === "reject" && !isReasonCode(body.reason_code)) throw new HttpError(400, `Неизвестный reason_code: ${body.reason_code}`);
    return await decide(ctx(req), (req.params as any).id, body);
  });
  // OS-INSP-4.1.12–4.1.14: общий корень — соседи по сигнатуре причины и групповое снятие поштучными решениями
  app.get("/api/v1/checks/:id/siblings", { onRequest: auth("inspection.work") }, async (req) => await siblings(db, (req.params as any).id));
  app.post("/api/v1/checks/:id/reject-group", { onRequest: auth("inspection.work") }, async (req) => {
    const body = z.object({ reason_code: z.string(), ids: z.array(z.string()).min(1).max(20), actions: z.number().int().min(0).max(100).optional() }).parse(req.body);
    if (!isReasonCode(body.reason_code)) throw new HttpError(400, `Неизвестный reason_code: ${body.reason_code}`);
    return await rejectGroup(ctx(req), (req.params as any).id, { ...body, reason_text: REASON_CODES[body.reason_code] });
  });
  // OS-INSP-4.1.15: вернуть решённого кандидата в PENDING (отмена Z)
  app.post("/api/v1/checks/:id/reopen", { onRequest: auth("inspection.work") }, async (req) => await reopenCheck(ctx(req), (req.params as any).id));
  app.post("/api/v1/checks/:id/split", { onRequest: auth("inspection.work") }, async (req) => {
    const { parts } = z.object({ parts: z.array(z.object({ title: z.string().min(1), fragment_ids: z.array(z.number()).min(1) })) }).parse(req.body);
    return { ids: await splitCandidate(ctx(req), (req.params as any).id, parts) };
  });
  // T-110 (кандидаты OS-INSP-4.1.8–4.1.11): совпадения выборкой — план выборки и приёмка партии
  app.get("/api/v1/inspection/:id/sample", { onRequest: auth("inspection.work") }, async (req) => await samplePlan(db, (req.params as any).id));
  app.post("/api/v1/inspection/:id/sample/accept", { onRequest: auth("inspection.work") }, async (req) => {
    const body = z.object({ seed: z.number().int(), reviewed: z.array(z.string()).max(500), errors: z.array(z.string()).max(500) }).parse(req.body);
    return await acceptSample(ctx(req), (req.params as any).id, body);
  });
  // OS-INSP-1.5.1: реестр согласованных изменений объекта (запись — в журнал аудита)
  app.get("/api/v1/inspection/:id/changes", { onRequest: auth("inspection.read") }, async (req) => await listChanges(db, (req.params as any).id));
  // OS-INSP-4.1.6, 4.1.7: журналы отклонений и спорных случаев (ТЗ §10 Rejection_Log, Dispute_Log)
  // T-234 (ТЗ §10): статус дообучения отклонения и исход спора с автором; имя закрывшего — ролям проверок (надзор),
  // ML-ролям — только ссылка resolved_by (R2-1: учётки людей им не нужны)
  const REJECTION_COLS = "r.id, r.check_id, r.inspection_id, r.param_code, r.ai_verdict, r.reason_code, r.comment, r.suggested_fix, r.retraining_status, r.retraining_dataset, r.retraining_at, r.created_at";
  const disputeCols = (role: string) => `d.id, d.check_id, d.inspection_id, d.param_code, d.kind, d.ai_comment, d.inspector_comment, d.resolution_status, d.resolved_by, d.resolved_at, d.resolution_comment, d.created_at${allowed(role, "inspection.read") ? ", u.name resolved_by_name" : ""}`;
  app.get("/api/v1/inspection/:id/feedback-logs", { onRequest: auth("feedback.read") }, async (req) => {
    const id = (req.params as any).id;
    const { limit, offset } = page(req, 500);
    return {
      // R2-1: без user_id — журнал открыт ML-ролям (4.1.27), учётка инспектора им не нужна
      rejections: await db.all(`select ${REJECTION_COLS} from rejection_log r where r.inspection_id = $1 order by r.id limit $2 offset $3`, [id, limit, offset]),
      disputes: await db.all(`select ${disputeCols(req.user!.role)} from dispute_log d left join users u on u.id = d.resolved_by where d.inspection_id = $1 order by d.id limit $2 offset $3`, [id, limit, offset]),
    };
  });
  // OS-INSP-4.1.29 (T-234, ТЗ §10 Dispute_Log.resolution_status, resolved_by): закрыть спор — исход, автор, время, аудит
  app.post("/api/v1/disputes/:id/resolve", { onRequest: auth("dispute.resolve") }, async (req) => {
    const b = z.object({ resolution_status: z.enum(DISPUTE_RESOLUTIONS), comment: z.string().max(2000).default("") }).parse(req.body);
    const id = intId((req.params as any).id, "Спорный случай не найден");
    return db.tx(async (t) => {
      const d = await t.get<any>("select * from dispute_log where id = $1 for update", [id]);
      if (!d) throw new HttpError(404, "Спорный случай не найден");
      const ok = canResolveDispute(d.resolution_status, b.resolution_status, b.comment);
      if (!ok.ok) throw new HttpError(ok.status, ok.error);
      const at = new Date().toISOString();
      await t.run("update dispute_log set resolution_status = $1, resolved_by = $2, resolved_at = $3, resolution_comment = $4 where id = $5", [b.resolution_status, req.user!.id, at, b.comment || null, id]);
      await audit({ ...ctx(req), db: t }, "DISPUTE_RESOLVED", d.check_id, { dispute_id: id, inspection_id: d.inspection_id, resolution_status: b.resolution_status, comment: b.comment || null });
      return { id, resolution_status: b.resolution_status, resolved_by: req.user!.id, resolved_at: at };
    });
  });
  app.post("/api/v1/inspection/:id/changes", { onRequest: auth("inspection.work") }, async (req, reply) => {
    const change = await addChange(ctx(req), (req.params as any).id, ApprovedChangeInput.parse(req.body));
    reply.code(201);
    return change;
  });
  // OS-INSP-5.4: статусы предписаний по данным ИАИС «РиН» (ТЗ §9.6.4). Приём — по ключу интеграции, не по сессии (5.4.6)
  // R2-4: ключ интеграции — в onRequest, до схемы OpenAPI: без ключа отказ по ключу, а не 400 с подробностями схемы
  const rinKey = async (req: FastifyRequest, reply: FastifyReply) => {
    const gate = await checkRinInboundKey(req.headers["x-rin-key"]);
    if (!gate.ok) {
      log("WARNING", "rin prescription rejected", { request_id: req.id, status: gate.status });
      return reply.code(gate.status).send({ error: gate.error });
    }
  };
  app.post("/api/v1/rin/prescriptions", { onRequest: rinKey }, async (req, reply) => {
    const r = await ingestPrescriptionStatus(db, req.body, { ip: req.ip, ua: req.headers["user-agent"] });
    return reply.code(r.created ? 201 : 200).send(r);
  });
  app.get("/api/v1/inspection/:id/prescriptions", { onRequest: auth("inspection.read") }, async (req) => await listPrescriptions(db, (req.params as any).id));
  app.get("/api/v1/checks/:id/details", { onRequest: auth("inspection.read") }, async (req) => {
    const row = await db.get<any>("select id, provenance_json, l8_json from checks where id = $1", [(req.params as any).id]);
    if (!row) throw new HttpError(404, "Запись проверки не найдена");
    const jsonText = (v: unknown) => v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
    return { id: row.id, provenance_json: jsonText(row.provenance_json), l8_json: jsonText(row.l8_json) };
  });
  app.get("/api/v1/checks/:id/fragments", { onRequest: auth("inspection.read") }, async (req) => await db.all("select * from evidence_fragments where check_id = $1 order by id", [(req.params as any).id]));
  // T136-M1 (OWASP R2): новые маршруты чтения — по справочнику прав T-139, не «любому вошедшему»
  app.get("/api/v1/inspection/:id/integrity", { onRequest: auth("inspection.read") }, async (req) => await integrityFor(db, (req.params as any).id));
  app.get("/api/v1/inspection/:id/critical-unresolved", { onRequest: auth("inspection.read") }, async (req) => await criticalUnresolvedFor(db, (req.params as any).id));
  app.post("/api/v1/inspection/:id/finalize", { onRequest: auth("inspection.work") }, async (req) => {
    // OS-INSP-4.3.5: подтверждение просмотра перечня критических параметров без вердикта
    const body = z.object({ critical_reviewed: z.boolean().optional() }).nullish().parse(req.body);
    const r = await finalize(ctx(req), (req.params as any).id, { criticalReviewed: body?.critical_reviewed === true });
    await runDueSyncJobs(db);
    return { ...r, sync_status: (await getInspection(db, (req.params as any).id)).sync_status };
  });
  app.post("/api/v1/inspection/:id/unfinalize", { onRequest: auth("inspection.unfinalize") }, async (req) => {
    const { reason } = z.object({ reason: z.string() }).parse(req.body);
    await unfinalize(ctx(req), (req.params as any).id, reason);
    return { status: (await getInspection(db, (req.params as any).id)).status };
  });
  app.post("/api/v1/inspection/:id/sync", { onRequest: auth("inspection.work") }, async (req) => {
    const { id } = req.params as any;
    await db.run("update sync_jobs set status = 'PENDING_SYNC', attempts = 0, next_attempt_at = $1 where inspection_id = $2 and status in ('FAILED', 'PENDING_SYNC')", [new Date().toISOString(), id]);
    await runDueSyncJobs(db);
    return { sync_status: (await getInspection(db, id)).sync_status };
  });
  app.post("/api/v1/suspicions/:id/status", { onRequest: auth("inspection.work") }, async (req) => {
    const { inspector_status } = z.object({ inspector_status: z.enum(["PENDING", "ACCEPTED", "DISMISSED"]) }).parse(req.body);
    const id = intId((req.params as any).id, "Гипотеза не найдена");
    // Смена статуса и запись в аудит — одной транзакцией (изменения без следа в журнале не бывает)
    await db.tx(async (t) => {
      const s = await t.get<any>("select * from suspicions where id = $1 for update", [id]);
      if (!s) throw new HttpError(404, "Гипотеза не найдена");
      if ((await getInspection(t, s.inspection_id)).status === "FINALIZED") throw new HttpError(409, "Протокол финализирован");
      await t.run("update suspicions set inspector_status = $1 where id = $2", [inspector_status, s.id]);
      await audit({ ...ctx(req), db: t }, "SUSPICION_REVIEWED", s.inspection_id, { suspicion_id: s.id, inspector_status });
    });
    return { ok: true };
  });
  // OS-INSP-3.2.7: гипотеза со ссылкой (файл, страница, bbox) → CANDIDATE
  app.post("/api/v1/suspicions/:id/promote", { onRequest: auth("inspection.work") }, async (req) => await promoteSuspicion(ctx(req), intId((req.params as any).id, "Гипотеза не найдена"), (req.body ?? {}) as any)); // нечисловой id — 404, а не 500 (находка T-129)
  app.get("/api/v1/notifications", { onRequest: auth() }, async (req) => {
    const { limit, offset } = page(req, 50);
    return db.all("select * from notifications where user_role = $1 or $2::text = 'admin' order by id desc limit $3 offset $4", [req.user!.role === "supervisor" ? "inspector" : req.user!.role, req.user!.role, limit, offset]);
  });

  // ─────────────────────────────── нормативная база (OS-INSP-7)
  app.get("/api/v1/params", { onRequest: auth() }, async (req) => {
    const { limit, offset } = page(req, 500);
    return await db.all("select * from params order by id limit $1 offset $2", [limit, offset]);
  });
  // OS-INSP-7.1.3–7.1.6: паспорт параметра — атрибуты, источники, шкала, алгоритм по шагам, метрики единого вида (T-129)
  app.get("/api/v1/params/:code/passport", { onRequest: auth() }, async (req) => {
    const v = await passportView(db, (req.params as any).code);
    if (!v) throw new HttpError(404, "Параметр не найден");
    return v;
  });
  // OS-INSP-6.5.8, 6.5.9: результат автоматической верификации параметра независимым пересчётом (журнал, только дописывается)
  app.post("/api/v1/params/:code/verifications", { onRequest: auth("param.verify") }, async (req, reply) => {
    const code = (req.params as any).code as string;
    if (!(await db.get("select 1 from params where code = $1", [code]))) throw new HttpError(404, "Параметр не найден");
    const b = z.object({
      inspection_id: z.string().min(1), method: z.string().min(1).max(200),
      fields: z.array(z.object({ field: z.string().min(1), system: z.string().nullable(), oracle: z.string().nullable(), ok: z.boolean().optional(), equivalent: z.boolean().optional() })).min(1),
    }).parse(req.body);
    const insp = await db.get<{ object_id: string }>("select object_id from inspections where id = $1", [b.inspection_id]);
    if (!insp) throw new HttpError(404, "Проверка не найдена");
    // вердикт считает сервер, а не клиент (OS-INSP-6.5.9, SEC-04): поле совпало, если равны значения системы и оракула;
    // присланное клиентом ok не учитывается. «Равноценно» принимается только для указателя на доказательство (*.evidence)
    const fields = b.fields.map((f) => ({ field: f.field, system: f.system, oracle: f.oracle, ok: sameValue(f.system, f.oracle) || (f.equivalent === true && f.field.endsWith(".evidence")), ...(f.equivalent ? { equivalent: true } : {}) }));
    const verdict = fields.every((f) => f.ok) ? "MATCH" : "MISMATCH";
    const at = new Date().toISOString();
    await db.tx(async (t) => {
      await t.run("insert into param_verifications (param_code, inspection_id, object_id, verdict, fields_json, method, checked_at) values ($1,$2,$3,$4,$5,$6,$7)", [code, b.inspection_id, insp.object_id, verdict, JSON.stringify(fields), b.method, at]);
      await audit({ ...ctx(req), db: t }, "PARAM_VERIFIED", code, { inspection_id: b.inspection_id, verdict, method: b.method });
    });
    reply.code(201);
    return { param_code: code, inspection_id: b.inspection_id, object_id: insp.object_id, verdict, checked_at: at, mismatched: fields.filter((f) => !f.ok).map((f) => f.field) };
  });
  app.patch("/api/v1/params/:code", { onRequest: auth("matrix.edit") }, async (req) => {
    const body = z
      .object({
        trigger_logic: z.string().optional(), review_priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(), sp_reference: z.string().nullable().optional(),
        gost_reference: z.string().nullable().optional(), fz_reference: z.string().nullable().optional(), min_value: z.number().nullable().optional(),
        max_value: z.number().nullable().optional(), is_active: z.boolean().optional(), compare: z.any().optional(), anchors: z.array(z.string()).optional(), regex_pattern: z.string().nullable().optional(),
      })
      .parse(req.body);
    const { code } = req.params as any;
    // Параметр, версия Матрицы и запись аудита — одной транзакцией. Строка версии блокируется (for update):
    // две одновременные правки не выпустят одну и ту же версию Матрицы
    const version = await db.tx(async (t) => {
      const cur = await t.get<any>("select * from params where code = $1 for update", [code]);
      if (!cur) throw new HttpError(404, "Параметр не найден");
      const next = { ...cur };
      for (const [k, v] of Object.entries(body)) {
        if (k === "compare") next.compare_json = JSON.stringify(v);
        else if (k === "anchors") next.anchors_json = JSON.stringify(v);
        else if (k === "is_active") next.is_active = Boolean(v);
        else next[k] = v;
      }
      if (body.min_value !== undefined || body.max_value !== undefined) {
        const mn = next.min_value, mx = next.max_value;
        if (mn !== null && mn !== undefined) next.compare_json = JSON.stringify({ kind: "min", min: mn });
        else if (mx !== null && mx !== undefined) next.compare_json = JSON.stringify({ kind: "max", max: mx });
      }
      await t.run(`update params set trigger_logic = $1, review_priority = $2, sp_reference = $3, gost_reference = $4, fz_reference = $5, min_value = $6, max_value = $7, is_active = $8,
          compare_json = $9, anchors_json = $10, regex_pattern = $11, updated_at = $12 where code = $13`, [
        next.trigger_logic, next.review_priority, next.sp_reference, next.gost_reference, next.fz_reference, next.min_value, next.max_value, next.is_active,
        next.compare_json, next.anchors_json, next.regex_pattern, new Date().toISOString(), code,
      ]);
      const curVersion = (await t.get<{ value: string }>("select value from meta where key = 'matrix_version' for update"))?.value ?? "";
      const [maj, min, patch] = curVersion.split(".").map(Number);
      const v = `${maj}.${min}.${(patch || 0) + 1}`;
      await setMeta(t, "matrix_version", v);
      await audit({ ...ctx(req), db: t }, "PARAM_UPDATED", code, { changes: body, matrix_version: v });
      return v;
    });
    return { ok: true, matrix_version: version };
  });
  app.get("/api/v1/normative", { onRequest: auth() }, async (req) => {
    const { limit, offset } = page(req, 500);
    return await db.all("select * from normative_base order by id limit $1 offset $2", [limit, offset]);
  });
  // OS-INSP-7.2.2: перечень нормативных правовых актов ТЗ §2 с редакциями
  app.get("/api/v1/legal-acts", { onRequest: auth() }, async (req) => {
    const { limit, offset } = page(req, 500);
    return await db.all("select * from legal_acts order by n limit $1 offset $2", [limit, offset]);
  });
  // OS-INSP-3.2.6: поиск по нормативной базе (BM25 + эмбеддинги в ML)
  app.get("/api/v1/normative/search", { onRequest: auth() }, async (req) => {
    const { q, top_k } = z.object({ q: z.string().trim().min(1).max(2000), top_k: z.coerce.number().int().min(1).max(50).default(5) }).parse(req.query);
    return await searchNorms(db, q, top_k);
  });
  const Norm = z.object({ document_name: z.string().min(1), document_number: z.string().min(1), section: z.string().default(""), parameter_name: z.string().default(""), param_code: z.string().nullable().default(null), min_value: z.number().nullable().default(null), max_value: z.number().nullable().default(null), effective_from: z.string().nullable().default(null), effective_to: z.string().nullable().default(null) });
  app.post("/api/v1/normative", { onRequest: auth("matrix.edit") }, async (req) => {
    const n = Norm.parse(req.body);
    const id = await db.tx(async (t) => {
      const r = await t.run("insert into normative_base (document_name, document_number, section, parameter_name, param_code, min_value, max_value, effective_from, effective_to) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
        [n.document_name, n.document_number, n.section, n.parameter_name, n.param_code, n.min_value, n.max_value, n.effective_from, n.effective_to]);
      const newId = Number(r.rows[0].id);
      await audit({ ...ctx(req), db: t }, "NORM_CREATED", String(newId), n);
      return newId;
    });
    return { id };
  });
  app.patch("/api/v1/normative/:id", { onRequest: auth("matrix.edit") }, async (req) => {
    const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата — ГГГГ-ММ-ДД").nullable().optional();
    const b = z.object({ is_active: z.boolean().optional(), effective_from: Day, effective_to: Day, min_value: z.number().nullable().optional(), max_value: z.number().nullable().optional() }).parse(req.body);
    const id = intId((req.params as any).id, "Норматив не найден");
    const cur = await db.tx(async (t) => {
      const cur = await t.get<any>("select * from normative_base where id = $1 for update", [id]);
      if (!cur) throw new HttpError(404, "Норматив не найден");
      const from = b.effective_from === undefined ? cur.effective_from : b.effective_from;
      const to = b.effective_to === undefined ? cur.effective_to : b.effective_to;
      if (from && to && from > to) throw new HttpError(400, `Срок действия: начало ${from} позже окончания ${to}`);
      await t.run("update normative_base set is_active = $1, effective_from = $2, effective_to = $3, min_value = $4, max_value = $5 where id = $6", [
        b.is_active ?? cur.is_active, from, to, b.min_value === undefined ? cur.min_value : b.min_value, b.max_value === undefined ? cur.max_value : b.max_value, id,
      ]);
      await audit({ ...ctx(req), db: t }, b.is_active === false ? "NORM_DEACTIVATED" : "NORM_UPDATED", String(id), b);
      return cur;
    });
    // OS-INSP-7.2.4 (T-234): норма — один источник; зависящие от неё параметры открытых проверок пересчитываются сразу
    const recomputed = await recomputeAfterNormChange(db, cur);
    return { ok: true, recomputed };
  });
  app.get("/api/v1/rules", { onRequest: auth() }, async (req) => {
    const { limit, offset } = page(req, 500);
    return await db.all("select * from logical_rules order by id limit $1 offset $2", [limit, offset]);
  });
  const Cond = z.object({ key: z.string(), op: z.enum([">", ">=", "<", "<=", "==", "!="]), value: z.number() });
  app.post("/api/v1/rules", { onRequest: auth("matrix.edit") }, async (req) => {
    const b = z.object({ rule_name: z.string().min(3), condition: Cond, expected: Cond, fact_anchors: z.array(z.object({ code: z.string(), anchors: z.array(z.string()), data_type: z.string().default("number") })).default([]), normative_base: z.string().default("") }).parse(req.body);
    const id = await db.tx(async (t) => {
      const r = await t.run("insert into logical_rules (rule_name, condition_json, expected_json, fact_anchors_json, normative_base) values ($1,$2,$3,$4,$5) returning id",
        [b.rule_name, JSON.stringify(b.condition), JSON.stringify(b.expected), JSON.stringify(b.fact_anchors), b.normative_base]);
      const newId = Number(r.rows[0].id);
      await audit({ ...ctx(req), db: t }, "RULE_CREATED", String(newId), b);
      return newId;
    });
    return { id };
  });
  app.patch("/api/v1/rules/:id", { onRequest: auth("matrix.edit") }, async (req) => {
    const b = z.object({ is_active: z.boolean().optional(), rule_name: z.string().optional(), normative_base: z.string().optional() }).parse(req.body);
    const id = intId((req.params as any).id, "Правило не найдено");
    await db.tx(async (t) => {
      const cur = await t.get<any>("select * from logical_rules where id = $1 for update", [id]);
      if (!cur) throw new HttpError(404, "Правило не найдено");
      await t.run("update logical_rules set is_active = $1, rule_name = $2, normative_base = $3 where id = $4", [b.is_active ?? cur.is_active, b.rule_name ?? cur.rule_name, b.normative_base ?? cur.normative_base, id]);
      await audit({ ...ctx(req), db: t }, "RULE_UPDATED", String(id), b);
    });
    return { ok: true };
  });
  app.post("/api/v1/admin/integrity", { onRequest: auth("storage.integrity") }, async (req) => {
    try {
      return await verifyBlobs(db, config.blobDir, req.user!.id);
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : String(e));
    }
  });
  app.get("/api/v1/audit", { onRequest: auth("audit.read") }, async (req) => {
    const q = req.query as Record<string, string>;
    const { limit, offset } = page(req, 500);
    const rows = await db.all<any>(`select a.*, u.name user_name, u.role from audit_log a left join users u on u.id = a.user_id
        where ($1::text is null or a.action = $1) and ($2::text is null or a.user_id = $2) order by a.id desc limit $3 offset $4`, [q.action ?? null, q.user ?? null, limit, offset]);
    // NFR-PDN (минимизация): полный IP — только администратору, супервизору — с обнулённым последним октетом (IPv6 — /48)
    return req.user!.role === "admin" ? rows : rows.map((r) => ({ ...r, ip_address: maskIp(r.ip_address) }));
  });

  // ─────────────────────────────── NFR-PDN (ТЗ 12.6-01, 152-ФЗ): реестр ПДн, сведения субъекту, выключение учётки
  app.get("/api/v1/admin/pdn/registry", { onRequest: auth("pdn.admin") }, async () => ({
    registry: PDN_REGISTRY, not_personal: PDN_NOT_PERSONAL, retention: { user_days: config.pdn.userDays, audit_days: config.pdn.auditDays },
  }));
  app.get("/api/v1/admin/pdn/subject/:userId", { onRequest: auth("pdn.admin") }, async (req) => {
    const userId = (req.params as { userId: string }).userId;
    const report = await subjectReport(db, userId);
    if (!report) throw new HttpError(404, "Учётная запись не найдена");
    await audit(ctx(req), "PDN_ACCESS", userId, { purpose: "сведения субъекту ПДн (152-ФЗ ст. 14)" });
    return report;
  });
  app.post("/api/v1/admin/users/:id/deactivate", { onRequest: auth("users.admin") }, async (req) => deactivateUser(ctx(req), (req.params as { id: string }).id));

  // ─────────────────────────────── дообучение (OS-INSP-6)
  // Порядок строк фиксирован (order by c.id): в PostgreSQL без order by он не гарантирован
  // T-234 (ТЗ §10 Rejection_Log «лог отклонений для дообучения»): причина и эксперт отрицательной метки — из действующей
  // записи журнала отклонений; нет её (приёмка выборкой, решения до журнала) — из решения. Объект — Checks.object_id.
  const goldCandidates = (q: DB) =>
    q.all<any>(`select c.id finding_id, c.evidence_group_id, c.object_id, c.param_code, c.verification_status,
        coalesce(rl.reason_code, (select reason_code from decisions d where d.check_id = c.id and not d.superseded order by d.id desc limit 1)) reason_code,
        coalesce(rl.user_id, (select user_id from decisions d where d.check_id = c.id and not d.superseded order by d.id desc limit 1)) expert_id,
        (select count(*) from evidence_fragments f where f.check_id = c.id and f.bbox_polygon_norm is not null) fragments
      from checks c join inspections i on i.id = c.inspection_id join objects o on o.id = c.object_id
      left join lateral (select r.reason_code, r.user_id from rejection_log r where r.check_id = c.id and r.retraining_status <> 'SUPERSEDED' order by r.id desc limit 1) rl
        on c.verification_status = 'NEGATIVE_VERIFIED'
      where i.status = 'FINALIZED' and ${realObjectSql("o")} order by c.id`); // OS-INSP-6.4.16 (T-148): синтетика — не эталон
  app.get("/api/v1/ml/gold/preview", { onRequest: auth("ml.read") }, async () => {
    const { cands, excluded_hidden } = await withoutHidden(db, await goldCandidates(db)); // OS-INSP-6.1.8
    const { items, hashes } = buildDataset(cands);
    return { items, hashes, excluded_hidden, positives: items.filter((i) => i.gold_label === "POSITIVE").length, negatives: items.filter((i) => i.gold_label === "NEGATIVE").length };
  });
  app.post("/api/v1/ml/gold/release", { onRequest: auth("ml.gold.release") }, async (req) => {
    // Выпуск GOLD-набора атомарен: версия, её элементы, dataset_version в meta и запись аудита — одной транзакцией.
    // Номер версии — под advisory-lock: два одновременных выпуска не получат один номер
    return db.tx(async (t) => {
      await t.run("select pg_advisory_xact_lock(hashtext('inspector:gold-release'))");
      // OS-INSP-6.1.8: решения по файлам скрытого теста в GOLD не входят, их число — в ответе и в аудите
      const { cands, excluded_hidden } = await withoutHidden(t, await goldCandidates(t));
      const { items, hashes } = buildDataset(cands);
      if (!items.length) throw new HttpError(409, "Нет подтверждённых решений из финализированных протоколов", { excluded_hidden });
      const n = (await t.get<{ n: number }>("select count(*) n from dataset_versions"))!.n + 1;
      const version = `gold-${new Date().toISOString().slice(0, 10)}-v${n}`;
      await t.run("insert into dataset_versions (dataset_version, split_hashes_json, items, positives, negatives, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7)",
        [version, JSON.stringify(hashes), items.length, items.filter((i) => i.gold_label === "POSITIVE").length, items.filter((i) => i.gold_label === "NEGATIVE").length, req.user!.id, new Date().toISOString()]);
      const ins = "insert into dataset_items (dataset_version, evidence_group_id, finding_id, gold_label, expert_id, reason_code, split, object_group_id) values ($1,$2,$3,$4,$5,$6,$7,$8)";
      for (const i of items) await t.run(ins, [version, i.evidence_group_id, i.finding_id, i.gold_label, i.expert_id, i.reason_code, i.split, i.object_id]);
      // T-234 (ТЗ §10 Rejection_Log.retraining_status): отклонения, вошедшие в набор, — INCLUDED с версией набора
      const negatives = new Set(items.filter((i) => i.gold_label === "NEGATIVE").map((i) => i.finding_id));
      const pending = await t.all<any>("select id, check_id, retraining_status from rejection_log where retraining_status = 'PENDING' order by id");
      const upd = retrainingUpdates(pending, negatives, version);
      const at = new Date().toISOString();
      for (const u of upd) await t.run("update rejection_log set retraining_status = $1, retraining_dataset = $2, retraining_at = $3 where id = $4", [u.retraining_status, u.retraining_dataset, at, u.id]);
      await setMeta(t, "dataset_version", version);
      await audit({ ...ctx(req), db: t }, "DATASET_RELEASED", version, { items: items.length, hashes, excluded_hidden, rejections_included: upd.length });
      return { dataset_version: version, items: items.length, hashes, excluded_hidden, rejections_included: upd.length };
    });
  });
  app.get("/api/v1/ml/datasets", { onRequest: auth("ml.read") }, async (req) => {
    const { limit, offset } = page(req, 200);
    return await db.all("select * from dataset_versions order by id desc limit $1 offset $2", [limit, offset]);
  });
  // T-234 (ТЗ §10 Dataset_Items): элементы версии набора — доказательная группа, эксперт, причина, выборка; фрагменты
  // группы с координатами (Evidence_Fragments.evidence_group_id) и сводка годности к обучению (OS-INSP-6.1.10)
  app.get("/api/v1/ml/datasets/:v/items", { onRequest: auth("ml.read") }, async (req) => {
    const v = (req.params as any).v as string;
    if (!(await db.get("select 1 from dataset_versions where dataset_version = $1", [v]))) throw new HttpError(404, `Версия набора ${v} не найдена`);
    const { limit, offset } = page(req, 200);
    const all = await datasetItems(db, v);
    const frags = new Map((await db.all<{ g: string; n: number }>(`select f.evidence_group_id g, count(*)::int n from evidence_fragments f
        where f.evidence_group_id in (select evidence_group_id from dataset_items where dataset_version = $1) and f.bbox_polygon_norm is not null group by f.evidence_group_id`, [v])).map((r) => [r.g, r.n]));
    return { dataset_version: v, summary: datasetSummary(all), items: all.slice(offset, offset + limit).map((i) => ({ ...i, fragments: frags.get(i.evidence_group_id) ?? 0 })) };
  });
  // ТЗ §10 ML_Retraining_Log (ADR-0011: представление над model_versions): аудит обучения и решения о публикации
  app.get("/api/v1/ml/retraining-log", { onRequest: auth("ml.read") }, async (req) => {
    const { limit, offset } = page(req, 200);
    return await db.all(`select id, model_version, dataset_version, split_hashes, "precision", recall, f1, false_positive_rate, per_category_metrics, approval_status, approved_by,
        matrix_version, training_code_hash, trained_by, previous_model, created_at from ml_retraining_log order by id desc limit $1 offset $2`, [limit, offset]);
  });
  app.get("/api/v1/ml/report", { onRequest: auth("ml.read") }, async (req) => {
    const since = (req.query as any).since ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    return await buildRetrainingReport(db, since);
  });
  // OS-INSP-6.2.2: отчёты, построенные по расписанию
  app.get("/api/v1/ml/reports", { onRequest: auth("ml.read") }, async (req) => {
    const { limit, offset } = page(req, 200);
    return (await db.all<any>("select id, since, until, created_at, body_json from retraining_reports order by until desc limit $1 offset $2", [limit, offset])).map((r) => ({ ...r, body: JSON.parse(r.body_json), body_json: undefined }));
  });
  // OS-INSP-4.1.27 (ТЗ 12.2 — ML-инженеру логи): журналы отклонений и спорных случаев сводно по всем проверкам, без карточек
  // и файлов проверок и без учётки инспектора — материал для дообучения, а не доступ к делу
  app.get("/api/v1/ml/feedback-logs", { onRequest: auth("feedback.read") }, async (req) => {
    const { limit, offset } = page(req, 500);
    return {
      rejections: await db.all(`select ${REJECTION_COLS} from rejection_log r order by r.id desc limit $1 offset $2`, [limit, offset]),
      disputes: await db.all(`select ${disputeCols(req.user!.role)} from dispute_log d left join users u on u.id = d.resolved_by order by d.id desc limit $1 offset $2`, [limit, offset]),
    };
  });
  app.get("/api/v1/ml/models", { onRequest: auth("ml.read") }, async (req) => {
    const { limit, offset } = page(req, 200);
    // T-234: подписавший публикацию — именем (Model_Versions.approved_by); ввод в контур и точка отката — колонками строки
    return await db.all("select m.*, u.name approved_by_name from model_versions m left join users u on u.id = m.approved_by order by m.id desc limit $1 offset $2", [limit, offset]);
  });
  app.post("/api/v1/ml/models", { onRequest: auth("ml.train") }, async (req) => {
    const b = z.object({ model_version: z.string().min(1), artifact_hash: z.string().default(""), dataset_version: z.string(), metrics: z.object({ precision: z.number(), recall: z.number(), f1: z.number(), false_positive_rate: z.number(), recall_by_category: z.record(z.string(), z.number()) }) }).parse(req.body);
    const gate = await db.tx(async (t) => {
      // T-234: действующая модель — по вводу в контур; Recall категорий — из её журнала дообучения (per_category_metrics)
      const prev = activeModel(await t.all<any>("select model_version, metrics_json, per_category_metrics_json, approval_status, deployed_at from model_versions where approval_status = 'PUBLISHED'"));
      const g = publicationGate(gatePrevious(prev ?? undefined), b.metrics);
      // ТЗ §10 ML_Retraining_Log (ADR-0011): хеши выборок — из выпуска набора, метрики по категориям — из recall_by_category
      const ds = await t.get<{ split_hashes_json: string }>("select split_hashes_json from dataset_versions where dataset_version = $1", [b.dataset_version]);
      await t.run(`insert into model_versions (model_version, artifact_hash, dataset_version, metrics_json, approval_status, created_at, split_hashes_json, per_category_metrics_json,
          matrix_version, trained_by, previous_model, gate_json) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [b.model_version, b.artifact_hash, b.dataset_version, JSON.stringify(b.metrics), g.ok ? "AWAITING_APPROVAL" : "REJECTED_BY_GATE", new Date().toISOString(),
          ds?.split_hashes_json ?? null, JSON.stringify(perCategoryFromRecall(b.metrics.recall_by_category)), await meta(t, "matrix_version"), req.user!.id,
          prev?.model_version ?? (await meta(t, "model_version")), JSON.stringify(g)]);
      await audit({ ...ctx(req), db: t }, "MODEL_REGISTERED", b.model_version, { gate: g });
      return g;
    });
    return { gate };
  });
  // OS-INSP-6.4.4–6.4.8: дообучение модели ранжирования по выпущенной версии набора; публикация — только через /approve
  app.post("/api/v1/ml/models/train", { onRequest: auth("ml.train") }, async (req, reply) => {
    const b = TrainBody.parse(req.body);
    return reply.code(201).send(await trainIteration(ctx(req), b.dataset_version, b.params));
  });
  // OS-INSP-6.1.4–6.1.7 (T-137): печать скрытого теста и журнал ответов — только добавление (миграция 0008)
  app.post("/api/v1/ml/hidden-seals", { onRequest: auth("ml.hidden.seal") }, async (req, reply) => {
    const r = await createSeal(ctx(req), SealBody.parse(req.body));
    return reply.code(r.created ? 201 : 200).send(r);
  });
  app.get("/api/v1/ml/hidden-seals", { onRequest: auth("ml.hidden.seal") }, async (req) => {
    const { limit, offset } = page(req, 200);
    return await listSeals(db, limit, offset);
  });
  app.post("/api/v1/ml/hidden-seals/:name/verify", { onRequest: auth("ml.hidden.seal") }, async (req) =>
    await verifySeal(ctx(req), (req.params as any).name, VerifyBody.parse(req.body).shas),
  );
  app.post("/api/v1/ml/hidden-seals/:name/runs", { onRequest: auth("ml.hidden.seal") }, async (req, reply) =>
    reply.code(201).send(await commitRun(ctx(req), (req.params as any).name, RunBody.parse(req.body))),
  );
  app.get("/api/v1/ml/hidden-seals/:name/runs", { onRequest: auth("ml.hidden.seal") }, async (req) => {
    const { limit, offset } = page(req, 200);
    return await listRuns(db, (req.params as any).name, limit, offset);
  });
  app.post("/api/v1/ml/models/:v/approve", { onRequest: auth("ml.model.approve") }, async (req) => {
    const v = (req.params as any).v;
    // Публикация, model_version в meta и аудит — одной транзакцией; строка модели блокируется от двойного утверждения
    const prev = await db.tx(async (t) => {
      await t.run("select pg_advisory_xact_lock(hashtext('inspector:model_versions'))"); // одна действующая модель: публикация и откат — по очереди
      const m = await t.get<any>("select * from model_versions where model_version = $1 for update", [v]);
      if (!m) throw new HttpError(404, "Модель не найдена");
      if (m.approval_status !== "AWAITING_APPROVAL") throw new HttpError(409, `Модель в статусе ${m.approval_status} — публикация невозможна`);
      // T-234 (ТЗ §10 ML_Retraining_Log.split_hashes): модель обучена на выпущенной версии набора
      const ds = m.dataset_version ? await t.get<{ split_hashes_json: string }>("select split_hashes_json from dataset_versions where dataset_version = $1", [m.dataset_version]) : undefined;
      const same = splitHashesMatch(m.split_hashes_json ?? null, ds?.split_hashes_json ?? null);
      if (!same.ok) throw new HttpError(same.status, same.error);
      const p = activeModel(await t.all<any>("select model_version, approval_status, deployed_at from model_versions where approval_status = 'PUBLISHED'"));
      // прежняя действующая — SUPERSEDED: в контуре одна модель, точка отката — rollback_to новой
      if (p) await t.run("update model_versions set approval_status = 'SUPERSEDED' where model_version = $1", [p.model_version]);
      await t.run("update model_versions set approval_status = 'PUBLISHED', approved_by = $1, deployed_at = $2, rollback_to = $3 where model_version = $4",
        [req.user!.id, new Date().toISOString(), p?.model_version ?? (await meta(t, "model_version")), v]);
      await setMeta(t, "model_version", v);
      await audit({ ...ctx(req), db: t }, "MODEL_PUBLISHED", v, { rollback_to: p?.model_version ?? null });
      return p;
    });
    return { ok: true, rollback_to: prev?.model_version ?? null };
  });
  // OS-INSP-6.3.3 (T-234, ТЗ §10 Model_Versions.rollback_to): откат действующей модели к версии, записанной при публикации
  app.post("/api/v1/ml/models/:v/rollback", { onRequest: auth("ml.model.approve") }, async (req) => {
    const v = (req.params as any).v as string;
    const { reason } = z.object({ reason: z.string().trim().min(3).max(2000) }).parse(req.body ?? {});
    return db.tx(async (t) => {
      await t.run("select pg_advisory_xact_lock(hashtext('inspector:model_versions'))");
      const cur = await t.get<any>("select * from model_versions where model_version = $1 for update", [v]);
      const plan = rollbackPlan(cur, await meta(t, "model_version"), await t.all<any>("select model_version, approval_status from model_versions"));
      if (!plan.ok) throw new HttpError(plan.status, plan.error);
      const at = new Date().toISOString();
      await t.run("update model_versions set approval_status = 'ROLLED_BACK' where model_version = $1", [plan.plan.from]);
      if (plan.plan.toInRegistry) await t.run("update model_versions set approval_status = 'PUBLISHED', deployed_at = $1 where model_version = $2", [at, plan.plan.to]);
      await setMeta(t, "model_version", plan.plan.to);
      await audit({ ...ctx(req), db: t }, "MODEL_ROLLED_BACK", plan.plan.from, { to: plan.plan.to, reason, approved_by: cur.approved_by, deployed_at: cur.deployed_at });
      return { ok: true, rolled_back: plan.plan.from, model_version: plan.plan.to, deployed_at: at };
    });
  });

  // ─────────────────────────────── заглушка ИАИС «РиН» (демо и тесты): только профиль dev и явный флаг
  if (config.profile === "dev" && config.rinMock) app.post("/mock-rin/api/v1/inspection/:id", async (req, reply) => {
    if (rinMock.down) return reply.code(503).send({ error: "Сервис временно недоступен" });
    const body = req.body as any;
    rinMock.received.push({ id: (req.params as any).id, at: new Date().toISOString(), confirmed: body?.confirmed_violations?.length ?? 0 });
    return reply.code(202).send({ accepted: true });
  });
  if (config.profile === "dev" && config.rinMock) app.post("/api/v1/admin/rin-mock", { onRequest: auth("rin.mock") }, async (req) => {
    const { down } = z.object({ down: z.boolean() }).parse(req.body);
    rinMock.down = down;
    return { down, received: rinMock.received.slice(-10) };
  });
  // OS-INSP-1.2.15: заглушка автозабора — пакеты синтетики data/synth/* (профиль dev)
  if (config.profile === "dev" && config.rinMock) registerRinPullMock(app);

  return app;
}
