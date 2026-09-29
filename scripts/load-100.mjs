// NFR-LOAD-100 (T-075, ТЗ 11-11): не менее 100 одновременных инспекторов; критерий — 0 ответов 5xx, p95 ответа API
// ≤ 200 мс (ТЗ 11-10). Профиль dev на маке, по образцу bench-11.mjs: отдельный PostgreSQL 18 в docker на случайном
// порту > 40000, API и ML из этого дерева, база-копия данных и блобы — во временном каталоге.
// Подготовка: USERS учёток inspector (прямо в базу — эндпоинта заведения пользователей в API нет), у каждого своя
// проверка синтетического пакета data/synth/OBJ-SCH-8: первая идёт через ML, остальные берутся из кэша по SHA-256.
// Нагрузка: USERS виртуальных инспекторов DURATION_S секунд по кругу «дашборд → статус своей проверки → карточка с
// кандидатами → доказательства кандидата → решение (нет ожидающих — снятие решения)», пауза THINK_MIN_MS–THINK_MAX_MS.
// Запуск — только через замок тяжёлого: scripts/heavy.sh node scripts/load-100.mjs  →  var/load-100.json, docs/qa/LOAD-100.md
// Параметры (env): USERS=100, DURATION_S=180, THINK_MIN_MS=1000, THINK_MAX_MS=3000, INSPECTOR_DATABASE_POOL_MAX (как у API, 10).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, cpus, totalmem, loadavg } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { summarize, toMarkdown, verdict } from "./lib/load-stats.mjs";

const root = new URL("../", import.meta.url).pathname;
const intEnv = (name, fallback) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name}=${process.env[name]}: ждём целое ≥ 0`);
  return v;
};
const USERS = intEnv("USERS", 100);
const DURATION_S = intEnv("DURATION_S", 180);
const THINK_MIN_MS = intEnv("THINK_MIN_MS", 1000);
const THINK_MAX_MS = Math.max(THINK_MIN_MS, intEnv("THINK_MAX_MS", 3000));
const POOL_MAX = intEnv("INSPECTOR_DATABASE_POOL_MAX", 10);
const PACKAGE = join(root, "data/synth/OBJ-SCH-8"); // самый лёгкий синтетический объект: 5 файлов, 116 КБ
// Тот же PostgreSQL, что в профиле gpu, по digest (deploy/gpu/.env.example)
const PG_IMAGE = readFileSync(join(root, "deploy/gpu/.env.example"), "utf8").match(/^POSTGRES_IMAGE=(\S+)/m)[1];
const CONTAINER = `inspector-load-${process.pid}`;

const tmp = mkdtempSync(join(tmpdir(), "inspector-load-"));
const PASSWORD = randomBytes(12).toString("base64url"); // один пароль на все учётки прогона (демо и нагрузочные)
const PG_PASSWORD = randomBytes(18).toString("base64url");
const procs = [];
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Свободный порт > 40000 на 127.0.0.1 (CLAUDE.md: на низких портах живут чужие service worker)
async function freePort(taken = new Set()) {
  for (let i = 0; i < 50; i++) {
    const p = rand(40001, 59999);
    if (taken.has(p)) continue;
    const free = await new Promise((ok) => {
      const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) return taken.add(p), p;
  }
  throw new Error("не нашёл свободный порт выше 40000");
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // pnpm и uvicorn запущены лидерами своих групп: гасим группу целиком, иначе node API под pnpm остаётся сиротой
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch {} }
  try { execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

async function up(url) { for (let i = 0; i < 300; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(300); } throw new Error(`не поднялся ${url}`); }

function form(card) {
  const f = new FormData();
  f.append("object", JSON.stringify(card));
  f.append("manifest", new Blob([readFileSync(join(PACKAGE, "manifest.json"))]), "manifest.json");
  for (const n of readdirSync(PACKAGE).filter((n) => /\.(pdf|docx|xml|xlsx|png)$/.test(n))) f.append("files", new Blob([readFileSync(join(PACKAGE, n))]), n);
  return f;
}

const psql = (sql) => execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "inspector"], { input: sql });

let API = "";
const call = (token, path, init = {}) => fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
async function waitStatus(token, id, want, ms = 900_000) {
  const t0 = now();
  while (now() - t0 < ms) { const s = await (await call(token, `/api/v1/inspection/${id}/status`)).json(); if (want.includes(s.status)) return s.status; await sleep(500); }
  throw new Error(`проверка ${id}: статус ${want} не достигнут за ${ms} мс`);
}
const READY = ["READY", "VERIFYING", "COMPLETED"];

const out = { date: new Date().toISOString() };
try {
  // ── база: отдельный контейнер, наружу только 127.0.0.1
  const taken = new Set();
  const P = { pg: await freePort(taken), api: await freePort(taken), ml: await freePort(taken) };
  // LOAD_PG_CPUS — потолок ядер базы на общем хосте (стенд hk: рядом чужие сервисы)
  const pgCpus = process.env.LOAD_PG_CPUS ? ["--cpus", process.env.LOAD_PG_CPUS] : [];
  execFileSync("docker", ["run", "-d", "--name", CONTAINER, "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`, "-e", "POSTGRES_DB=inspector",
    "-p", `127.0.0.1:${P.pg}:5432`, "--shm-size=256m", ...pgCpus, PG_IMAGE], { stdio: "ignore" });
  // По TCP внутри контейнера: во время init временный сервер слушает только сокет — готовность наступает после init
  for (let i = 0; ; i++) {
    try { execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "inspector"], { stdio: "ignore" }); break; } catch {}
    if (i > 120) throw new Error("PostgreSQL не поднялся за 60 с");
    await sleep(500);
  }

  // ── API (dev на сервере PostgreSQL: миграции, сиды и демо-учётки — при старте, режим apply) и ML
  const env = {
    ...process.env, INSPECTOR_PROFILE: "dev", INSPECTOR_DATABASE_URL: `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${P.pg}/inspector`,
    INSPECTOR_DATABASE_POOL_MAX: String(POOL_MAX), INSPECTOR_BLOB_DIR: join(tmp, "blobs"), INSPECTOR_ML_CACHE: join(tmp, "ml-cache"),
    // LOAD_ML_URL — внешний ML (стенд hk: ML мака через ssh -R); ML нужен только для разбора пакета при подготовке
    INSPECTOR_ML_URL: process.env.LOAD_ML_URL ?? `http://127.0.0.1:${P.ml}`, INSPECTOR_RIN_URL: `http://127.0.0.1:${P.api}/mock-rin`, INSPECTOR_DEMO_PASSWORD: PASSWORD,
    PORT: String(P.api), INSPECTOR_SHEET_DIFF_AUTO: "0",
  };
  API = `http://127.0.0.1:${P.api}`;
  mkdirSync(join(tmp, "blobs"), { recursive: true });
  if (!process.env.LOAD_ML_URL) procs.push(spawn(join(root, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--port", String(P.ml), "--log-level", "warning"], { cwd: join(root, "ml"), env, stdio: "ignore", detached: true }));
  procs.push(spawn("pnpm", ["--filter", "@inspector/api", "start"], { cwd: root, env, stdio: "ignore", detached: true }));
  await up(`${env.INSPECTOR_ML_URL}/health`);
  await up(`${API}/health`);

  // ── учётки: схема уже накатана API; хеш — формат db.ts::hashPassword (соль:scrypt32), один на всех
  const salt = randomBytes(16).toString("hex");
  const hash = `${salt}:${scryptSync(PASSWORD, salt, 32).toString("hex")}`;
  const logins = Array.from({ length: USERS }, (_, i) => `load-${String(i + 1).padStart(3, "0")}`);
  psql(`insert into users (id, login, name, role, password_hash) values\n${logins.map((l) => `('u-${l}', '${l}', 'Нагрузка ${l}', 'inspector', '${hash}')`).join(",\n")}\non conflict (login) do nothing;\n`);
  const tokens = [];
  for (const login of logins) {
    const r = await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login, password: PASSWORD }) });
    if (!r.ok) throw new Error(`вход ${login}: ${r.status}`);
    tokens.push((await r.json()).token);
  }

  // ── проверки: у каждого своя (свой объект LOAD-NNN), файлы одинаковые — ML-кэш по SHA-256
  const base = JSON.parse(readFileSync(join(PACKAGE, "manifest.json"), "utf8")).object;
  const inspections = new Array(USERS);
  const uploadOne = async (i) => {
    const r = await call(tokens[i], "/api/v1/documents/upload", { method: "POST", body: form({ ...base, object_id: `LOAD-${logins[i]}`, name: `${base.name} (${logins[i]})` }) });
    const j = await r.json();
    if (!r.ok || !j.process_id) throw new Error(`загрузка ${logins[i]} отклонена ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    await waitStatus(tokens[i], j.process_id, READY);
    inspections[i] = j.process_id;
  };
  let t = now();
  if (USERS) await uploadOne(0);
  const firstMs = now() - t;
  t = now();
  for (let i = 1; i < USERS; i += 10) await Promise.all(Array.from({ length: Math.min(10, USERS - i) }, (_, k) => uploadOne(i + k)));
  const restMs = now() - t;
  out.warmup = { first_ms: Math.round(firstMs), rest_ms: Math.round(restMs), inspections: USERS };

  // ── нагрузка
  const samples = [];
  const active = new Set();
  const t0 = now();
  const until = t0 + DURATION_S * 1000;
  async function req(i, endpoint, path, init = {}) {
    const a = now();
    let status = 0;
    let body = null;
    try {
      const r = await call(tokens[i], path, init);
      status = r.status;
      const text = await r.text(); // время — до конца тела, как в bench-11
      body = text && r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
    } catch {}
    samples.push({ endpoint, ms: now() - a, status });
    active.add(i);
    return body;
  }
  const jsonPost = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  async function inspector(i) {
    await sleep(rand(0, THINK_MAX_MS)); // разгон: инспекторы входят не одним залпом
    const id = inspections[i];
    let n = 0;
    while (now() < until) {
      await req(i, "GET /api/v1/inspections", "/api/v1/inspections");
      await req(i, "GET /api/v1/inspection/:id/status", `/api/v1/inspection/${id}/status`);
      const card = await req(i, "GET /api/v1/inspections/:id", `/api/v1/inspections/${id}`);
      const cands = (card?.checks ?? []).filter((c) => c.finding_status === "CANDIDATE" && c.verification_status !== "SPLIT");
      const pending = cands.filter((c) => c.verification_status === "PENDING");
      const status = card?.inspection?.status;
      if (pending.length && ["READY", "VERIFYING"].includes(status)) {
        const c = pending[rand(0, pending.length - 1)];
        await req(i, "GET /api/v1/checks/:id/fragments", `/api/v1/checks/${c.id}/fragments`);
        const decision = n++ % 2 === 0
          ? { action: "confirm", comment: "нагрузочный прогон", actions: 2 }
          : { action: "reject", reason_code: "OCR_ERROR", comment: "нагрузочный прогон", actions: 3 };
        await req(i, "POST /api/v1/checks/:id/decision", `/api/v1/checks/${c.id}/decision`, jsonPost(decision));
      } else if (cands.length) {
        const c = cands[rand(0, cands.length - 1)];
        await req(i, "GET /api/v1/checks/:id/fragments", `/api/v1/checks/${c.id}/fragments`);
        await req(i, "POST /api/v1/checks/:id/reopen", `/api/v1/checks/${c.id}/reopen`, { method: "POST" });
      }
      await sleep(rand(THINK_MIN_MS, THINK_MAX_MS));
    }
  }
  await Promise.all(Array.from({ length: USERS }, (_, i) => inspector(i)));
  const durationS = Math.round((now() - t0) / 100) / 10;

  const summary = summarize(samples, { users: active.size, durationS });
  const v = verdict(summary, { p95Ms: 200, users: 100 });
  let revision = "нет git";
  try {
    revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
    if (execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim()) revision += " + незакоммиченные правки";
  } catch {}
  const conditions = {
    date: out.date, host: { name: process.env.LOAD_HOST_NAME ?? null, cpu: cpus()[0].model, cores: cpus().length, ram_gb: Math.round(totalmem() / 2 ** 30), ml: process.env.LOAD_ML_URL ? "внешний сервис (LOAD_ML_URL)" : null, load: loadavg().map((x) => +x.toFixed(2)) }, profile: "dev",
    users: USERS, duration_s: durationS, think_ms: [THINK_MIN_MS, THINK_MAX_MS], revision,
    db: `PostgreSQL 18 в docker (${PG_IMAGE.split("@")[0]})`, pool_max: POOL_MAX,
    warmup: `первая проверка через ML — ${(firstMs / 1000).toFixed(1)} с, остальные ${USERS - 1} из кэша — ${(restMs / 1000).toFixed(1)} с`,
  };
  Object.assign(out, { conditions, summary, verdict: v });
  mkdirSync(join(root, "var"), { recursive: true });
  writeFileSync(join(root, "var/load-100.json"), JSON.stringify(out, null, 1));
  writeFileSync(join(root, "docs/qa/LOAD-100.md"), toMarkdown({ summary, verdict: v, conditions }));
  console.log(JSON.stringify({ verdict: v, total: summary.total }, null, 1));
  process.exitCode = v.ok ? 0 : 1;
} finally {
  cleanup();
}
