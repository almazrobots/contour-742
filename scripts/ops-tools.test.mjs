// Эшелоны: L1 (разрешённые адреса прокси), L4 (рубильник: перегрев → пауза ML, остыл → снятие; прокси мимо VPN).
// T-129: диспетчер нагрузки стенда и прямой выход к S3 — требование владельца 27.09 (NFR-RESILIENCE, NFR-OBJSTORE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

/** Прогнать load-guard на заданной последовательности замеров с поддельным docker; вернуть вызовы docker и журнал. */
function guard(readings, psIds = { running: "ml1", paused: "ml1" }) {
  const d = mkdtempSync(join(tmpdir(), "guard-"));
  writeFileSync(join(d, "readings"), readings.join("\n") + "\n");
  writeFileSync(join(d, "probe"), `#!/usr/bin/env bash\nf=${d}/readings; head -1 "$f"; sed -i '' 1d "$f" 2>/dev/null || sed -i 1d "$f"\n`);
  writeFileSync(join(d, "docker"), `#!/usr/bin/env bash\necho "$*" >> ${d}/calls\nif [ "$1" = ps ]; then case "$*" in *status=running*) echo "${psIds.running}";; *status=paused*) echo "${psIds.paused}";; esac; fi\n`);
  chmodSync(join(d, "probe"), 0o755);
  chmodSync(join(d, "docker"), 0o755);
  const r = spawnSync("bash", [join(root, "scripts/load-guard.sh"), "0"], {
    // GUARD_PIDS — пустой временный каталог: тест не должен слать сигналы настоящему ML на маке (T-130)
    env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GUARD_PROBE: join(d, "probe"), GUARD_ITERS: String(readings.length), GUARD_LOG: join(d, "log"), GUARD_PIDS: join(d, "no-pids"), GUARD_HEAVY_LOCK: join(d, "no-lock") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const read = (f) => { try { return readFileSync(join(d, f), "utf8"); } catch { return ""; } };
  return { calls: read("calls").trim().split("\n").filter(Boolean), log: read("log") };
}
const t = (cpu, mem, swap = 1000) => `2026-09-27T03:00:00 cpu=${cpu}C gpu=60C sys=20W load=5 memfree=${mem}% swap=${swap}M`;

test("рубильник: CPU 96 °C → пауза ML только этого стенда; остыл до 80 °C → снятие паузы", () => {
  const { calls, log } = guard([t(96, 50), t(85, 50), t(75, 50)]);
  const act = calls.filter((c) => !c.startsWith("ps"));
  assert.deepEqual(act, ["pause ml1", "unpause ml1"]); // 85 °C — ещё не остыл (гистерезис 90/80, владелец 27.09)
  for (const c of calls.filter((c) => c.startsWith("ps"))) assert.match(c, /com\.docker\.compose\.project=inspector-stand/);
  assert.match(log, /РУБИЛЬНИК: пауза ML/);
  assert.match(log, /снята пауза ML/);
});

test("рубильник: память < 10 % или быстрый рост свопа — тоже пауза; норма — ничего не трогает", () => {
  assert.deepEqual(guard([t(60, 8)]).calls.filter((c) => c.startsWith("pause")), ["pause ml1"]);
  // своп растёт больше 1 ГБ за цикл при памяти < 20 % — пауза; большой, но неизменный своп — не повод
  assert.deepEqual(guard([t(60, 18, 3000), t(60, 18, 4500)]).calls.filter((c) => c.startsWith("pause")), ["pause ml1"]);
  assert.deepEqual(guard([t(60, 50, 7000), t(60, 50, 7000)]).calls.filter((c) => c.startsWith("pause")), []);
  assert.deepEqual(guard([t(70, 50), t(80, 40)]).calls.filter((c) => !c.startsWith("ps")), []);
});

test("рубильник: перегрев, а ML стенда не запущен — пауза не выдумывается, в журнале сказано честно", () => {
  const { calls, log } = guard([t(97, 50)], { running: "", paused: "" });
  assert.deepEqual(calls.filter((c) => !c.startsWith("ps")), []);
  assert.match(log, /ML стенда не запущен/);
});

// ── прокси прямого выхода к S3 (scripts/egress-direct.py)
function py(code) {
  return spawnSync("python3", ["-c", `import importlib.util,sys\ns=importlib.util.spec_from_file_location("e","${join(root, "scripts/egress-direct.py")}")\ne=importlib.util.module_from_spec(s);s.loader.exec_module(e)\n${code}`], { encoding: "utf8" });
}
test("прокси: пускает только бакет Yandex и его поддомены на 443 — не соседний домен и не другой порт", () => {
  const cases = { "storage.yandexcloud.net:443": 1, "nadzorium.storage.yandexcloud.net:443": 1, "evilstorage.yandexcloud.net:443": 0, "storage.yandexcloud.net.evil.io:443": 0, "storage.yandexcloud.net:80": 0, "nadzorium.storage.yandexcloud.net:22": 0, "169.254.169.254:80": 0 };
  const r = py(`A={"storage.yandexcloud.net:443",".storage.yandexcloud.net:443"}\nfor t in ${JSON.stringify(Object.keys(cases))}: print(int(e.allowed(t,A)))`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").map(Number), Object.values(cases));
});

async function freePort() {
  return new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}
function talk(port, req) {
  return new Promise((ok, bad) => {
    const s = connect(port, "127.0.0.1");
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n")) { if (buf.startsWith("HTTP/1.1 200")) { s.write("ping"); if (buf.endsWith("ping")) { s.end(); ok(buf); } } else { s.end(); ok(buf); } } });
    s.on("error", (e) => (buf ? ok(buf) : bad(Object.assign(e, { message: `${e.message} на ${JSON.stringify(req.slice(0, 40))}` }))));
    s.write(req);
  });
}
test("прокси: разрешённый адрес — туннель с данными в обе стороны; чужой — 403, слушает только петлю", async () => {
  const echo = createServer((c) => { c.on("error", () => {}); c.pipe(c); }).listen(0, "127.0.0.1");
  await new Promise((r) => echo.once("listening", r));
  const ep = echo.address().port;
  const port = await freePort();
  const p = spawn("python3", [join(root, "scripts/egress-direct.py"), "--port", String(port), "--bind", "127.0.0.1", "--allow", `127.0.0.1:${ep}`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((ok, bad) => { p.stdout.once("data", ok); p.once("exit", (c) => bad(new Error(`прокси вышел: ${c}`))); });
    const okResp = await talk(port, `CONNECT 127.0.0.1:${ep} HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.match(okResp, /^HTTP\/1\.1 200/);
    assert.ok(okResp.endsWith("ping"), "эхо через туннель");
    const denied = await talk(port, `CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n`);
    assert.match(denied, /^HTTP\/1\.1 403/);
    const notConnect = await talk(port, `GET http://127.0.0.1:${ep}/ HTTP/1.1\r\n\r\n`);
    assert.match(notConnect, /^HTTP\/1\.1 403/);
    const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout;
    assert.match(lsof, /127\.0\.0\.1:\d+ \(LISTEN\)/);
    assert.doesNotMatch(lsof, /\*:\d+ \(LISTEN\)/);
  } finally {
    p.kill();
    echo.close();
  }
});

test("рубильник: пауза по памяти снимается, когда память вернулась, даже если своп остался большим (macOS его не отдаёт)", () => {
  const { calls } = guard([t(60, 8, 7700), t(70, 30, 7700)]);
  assert.deepEqual(calls.filter((c) => !c.startsWith("ps")), ["pause ml1", "unpause ml1"]);
});

// ── T-130: рубильник замораживает и нативные процессы ML на маке (MLX грузит GPU)
function guardNative(readings, pids, lockDir = null) {
  const d = mkdtempSync(join(tmpdir(), "guardn-"));
  const pidDir = join(d, "pids");
  spawnSync("mkdir", ["-p", pidDir]);
  pids.forEach((p, i) => writeFileSync(join(pidDir, `p${i}.pid`), `${p}\n`));
  writeFileSync(join(d, "readings"), readings.join("\n") + "\n");
  writeFileSync(join(d, "probe"), `#!/usr/bin/env bash\nf=${d}/readings; head -1 "$f"; sed -i '' 1d "$f" 2>/dev/null || sed -i 1d "$f"\n`);
  writeFileSync(join(d, "docker"), `#!/usr/bin/env bash\nexit 0\n`); // контейнера ML нет — стенд в режиме --ml-host
  writeFileSync(join(d, "kill"), `#!/usr/bin/env bash\necho "$*" >> ${d}/kills\n`);
  for (const f of ["probe", "docker", "kill"]) chmodSync(join(d, f), 0o755);
  const r = spawnSync("bash", [join(root, "scripts/load-guard.sh"), "0"], {
    env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GUARD_PROBE: join(d, "probe"), GUARD_ITERS: String(readings.length), GUARD_LOG: join(d, "log"), GUARD_PIDS: pidDir, GUARD_KILL: join(d, "kill"), GUARD_HEAVY_LOCK: lockDir ?? join(d, "no-lock") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const read = (f) => { try { return readFileSync(join(d, f), "utf8"); } catch { return ""; } };
  return { kills: read("kills").trim().split("\n").filter(Boolean), log: read("log") };
}
const tg = (cpu, gpu, mem = 50) => `2026-09-27T03:00:00 cpu=${cpu}C gpu=${gpu}C sys=30W load=5 memfree=${mem}% swap=1000M`;

test("рубильник: нативный процесс ML (pid-файл) — STOP при перегреве, CONT после остывания; мёртвый pid не трогается", () => {
  const alive = process.pid; // заведомо живой процесс; сигналы уходят в поддельный kill
  const { kills, log } = guardNative([tg(96, 60), tg(75, 60)], [alive, 999999]);
  assert.deepEqual(kills, [`-STOP ${alive}`, `-CONT ${alive}`]);
  assert.match(log, new RegExp(`пауза ML \\(нативные pid: ${alive}\\)`));
});

test("рубильник: GPU 95 °C при холодном CPU — тоже пауза (MLX); снятие только когда остыли оба", () => {
  const alive = process.pid;
  const { kills } = guardNative([tg(60, 95), tg(70, 85), tg(70, 75)], [alive]);
  assert.deepEqual(kills, [`-STOP ${alive}`, `-CONT ${alive}`]); // 85 °C GPU — ещё не остыл (гистерезис 90/80)
});

// ── T-130: автоочистка сборок стенда (scripts/stand.sh prune)
test("stand prune: остаются две последние сборки, текущая ревизия и занятые контейнером; чужие теги (демо -amd64) не трогаются; кэш ≤ 5 ГБ", () => {
  const d = mkdtempSync(join(tmpdir(), "prune-"));
  const v = join(d, "var");
  spawnSync("mkdir", ["-p", v]);
  // теги сборок стенда — sha коммита из 40 символов (как у stand.sh build)
  const [new1, new2, old1, old2, busy] = ["1", "2", "3", "4", "5"].map((c) => c.repeat(40));
  const demo = `${"a".repeat(40)}-amd64`; // образ другой задачи (T-131, демо) — prune его не видит (27.09: был удалён)
  writeFileSync(join(v, "revision"), `${old1}\n`);
  writeFileSync(
    join(d, "docker"),
    `#!/usr/bin/env bash\necho "$*" >> ${d}/calls\ncase "$*" in\n` +
      `  "image ls inspector-ml --format {{.CreatedAt}}|{{.Tag}}") printf '%s\\n' '2026-09-27 06:00|${old2}' '2026-09-27 09:00|${new1}' '2026-09-27 08:00|${new2}' '2026-09-27 05:00|${old1}' '2026-09-27 04:00|${busy}' '2026-09-27 10:00|${demo}' ;;\n` +
      `  "image ls inspector-"*" --format {{.Tag}}") printf '%s\\n' ${new1} ${new2} ${old1} ${old2} ${busy} '<none>' ${demo} ${old2}-dirty ;;\n` +
      `  "ps -a --format {{.Image}}") printf 'inspector-api:${busy}\\npostgres:18\\n' ;;\nesac\n`,
  );
  chmodSync(join(d, "docker"), 0o755);
  const r = spawnSync("bash", [join(root, "scripts/stand.sh"), "prune"], { env: { ...process.env, PATH: `${d}:${process.env.PATH}`, STAND_VAR_DIR: v }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(join(d, "calls"), "utf8").trim().split("\n");
  const removed = calls.filter((c) => c.startsWith("image rm")).map((c) => c.replace("image rm ", "")).sort();
  const want = ["api", "ml", "web"].flatMap((i) => [`inspector-${i}:${old2}`, `inspector-${i}:${old2}-dirty`]).sort();
  assert.deepEqual(removed, want); // old1 — текущая ревизия, busy — под контейнером, demo — чужой тег
  assert.ok(!removed.some((x) => x.includes("-amd64")), "образ демо не удаляется");
  assert.ok(calls.includes("builder prune -f --max-used-space 5gb"));
  assert.ok(!calls.some((c) => /volume|system prune|image prune/.test(c)), "тома и чужие образы не трогаются");
});

test("рубильник: при перегреве замораживает всё дерево процессов замка heavy.sh (Stryker и его воркеры), после остывания — отпускает", async () => {
  const d = mkdtempSync(join(tmpdir(), "guardh-"));
  const lock = join(d, "lock");
  spawnSync("mkdir", ["-p", lock]);
  // «тяжёлое»: родитель и два потомка, как stryker → vitest-воркеры
  const p = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const kids = spawnSync("pgrep", ["-P", String(p.pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);
  writeFileSync(join(lock, "pid"), `${p.pid}\n`);
  writeFileSync(join(lock, "cmd"), "npx stryker run\n");
  try {
    const { kills, log } = guardNative([tg(96, 60), tg(75, 60)], [], lock);
    const stopped = kills.filter((k) => k.startsWith("-STOP")).map((k) => Number(k.split(" ")[1])).sort();
    assert.deepEqual(stopped, [p.pid, ...kids].sort(), "заморожен родитель и все потомки");
    assert.deepEqual(kills.filter((k) => k.startsWith("-CONT")).length, stopped.length, "каждому STOP — свой CONT");
    assert.match(log, /тяжёлое: npx stryker run/);
  } finally {
    p.kill("SIGKILL");
    for (const k of kids) try { process.kill(k, "SIGKILL"); } catch {}
  }
});

test("heavy.sh: тяжёлое не стартует без рубильника — поднимает его, если он не запущен", () => {
  const sh = readFileSync(join(root, "scripts/heavy.sh"), "utf8");
  assert.match(sh, /pgrep -f "scripts\/load-guard\.sh"/);
  assert.match(sh, /nohup scripts\/load-guard\.sh 20/);
});

test("рубильник: порог 90 °C — 91 °C уже пауза, 89 °C ещё нет (владелец 27.09: держать мак холоднее)", () => {
  assert.deepEqual(guard([t(91, 50)]).calls.filter((c) => c.startsWith("pause")), ["pause ml1"]);
  assert.deepEqual(guard([t(89, 50)]).calls.filter((c) => c.startsWith("pause")), []);
});
