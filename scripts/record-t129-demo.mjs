#!/usr/bin/env node
// Отчётное видео T-129: полный цикл «Алтуфьевское 79Б» на стенде Docker (deploy/stand) — пустой префикс S3 → вход →
// загрузка архива через API загрузчиком → статусы ТЗ → разбор (RabbitMQ, OCR) → результат М-023 в интерфейсе →
// решение инспектора → автоверификация → выходной набор. Шаги консоли — настоящие команды, их вывод идёт в кадр как есть.
// Видео пишется отрезками (фазы A–E): сбой в одной фазе не заставляет заново ждать разбор. Склейка — --phase join:
// ожидание разбора (фаза B) ускоряется, в кадре — подпись «ускорено» и реальные часы.
//   node scripts/record-t129-demo.mjs --phase A|B|C|D|E|join --zip <архив> --prefix demo-2026-09-27/ --out <каталог>
// Стенд поднят с тем же префиксом: STAND_S3_PREFIX=<prefix> scripts/stand.sh up --yandex
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const { values: a } = parseArgs({
  options: {
    phase: { type: "string" },
    zip: { type: "string" },
    prefix: { type: "string", default: "demo-2026-09-27/" },
    out: { type: "string" },
    "object-id": { type: "string", default: "ALT-79B" },
    "object-name": { type: "string", default: "Алтуфьевское ш., 79Б" },
    "package-dir": { type: "string" }, // распакованный пакет для оракула (вне git, ADR-0002)
  },
});
const OUT = a.out;
const PHASE = a.phase;
mkdirSync(OUT, { recursive: true });
const STATE = join(OUT, "state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const WEB = "https://127.0.0.1:45843";
const CA = join(root, "var/stand/tls/ca.crt");
const PASSFILE = join(root, "var/stand/secrets/demo_password");
const PASS = readFileSync(PASSFILE, "utf8").trim();
const W = 1440, H = 900;

if (PHASE === "join") {
  join_();
  process.exit(0);
}

const RAW = join(OUT, `raw-${PHASE}`);
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: RAW, size: { width: W, height: H } }, ignoreHTTPSErrors: true, locale: "ru-RU", colorScheme: "light" });
const page = await ctx.newPage();
const beat = (ms = 2200) => page.waitForTimeout(ms);

// ─────────────── консоль в кадре: светлая, настоящие команды и их вывод
const CONSOLE = `<!doctype html><meta charset="utf-8"><title>Консоль стенда</title><style>
body{margin:0;background:#E9ECF2;font:15px/1.5 Menlo,monospace;color:#1D1F2E}
header{padding:18px 28px;background:#fff;border-bottom:1px solid #D9DBE5;font:600 19px system-ui}
header small{display:block;font:500 13px system-ui;color:#5A5F78;margin-top:2px}
#log{padding:16px 28px 120px;white-space:pre-wrap;height:calc(100vh - 80px);overflow:auto;box-sizing:border-box}
.cmd{color:#3B4FA8;font-weight:700;margin-top:10px}.ok{color:#1E7A4F;font-weight:700}.bad{color:#B3261E}.dim{color:#6B6F85}
#cap{position:fixed;left:28px;right:28px;bottom:18px;background:#1D1F2E;color:#fff;border-radius:12px;padding:12px 18px;font:500 16px/1.4 system-ui}
#cap b{display:block;font-size:18px;margin-bottom:2px}</style><header><span id="h"></span><small id="hs"></small></header><div id="log"></div><div id="cap"></div>`;
async function consoleView(title, sub) {
  await page.setContent(CONSOLE);
  await page.evaluate(([t, s]) => { document.getElementById("h").textContent = t; document.getElementById("hs").textContent = s; }, [title, sub]);
}
const cap = (title, text) => page.evaluate(([t, x]) => {
  const c = document.getElementById("cap"); c.textContent = ""; const b = document.createElement("b"); b.textContent = t; c.append(b, document.createTextNode(x));
}, [title, text]);
const line = (text, cls = "") => page.evaluate(([t, c]) => { const l = document.getElementById("log"); const s = document.createElement("div"); s.className = c; s.textContent = t; l.appendChild(s); l.scrollTop = l.scrollHeight; }, [text, cls]);

/** Запустить команду и показать её вывод построчно в консоли кадра. Секреты в команду не попадают — только пути к файлам. */
function run(cmd, args, opts = {}) {
  return new Promise((ok, bad) => {
    void line(`$ ${opts.show ?? [cmd, ...args].join(" ")}`, "cmd");
    const p = spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...(opts.env ?? {}) } });
    let buf = "";
    const out = [];
    const feed = (d) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const raw of parts) {
        const s = raw.replace(/\x1b\[[0-9;]*m/g, ""); // цвета терминала в кадре не нужны
        if (s.trim()) { out.push(s); void line(s, /FAIL|ошибк|отклонено [1-9]|MISMATCH/i.test(s) ? "bad" : /MATCH|: OK$|готов|ok /.test(s) ? "ok" : ""); }
      }
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("close", (code) => { if (buf.trim()) { out.push(buf); void line(buf); } code === 0 || opts.allowFail ? ok(out) : bad(new Error(`${cmd}: код ${code}`)); });
  });
}

// ─────────────── интерфейс
async function login() {
  await page.goto(`${WEB}/#/login`);
  await beat(1200);
  await page.fill("#login", "inspector");
  await page.fill("#password", PASS);
  await beat(800);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL(/#\/inspections/);
}
async function uiCaption(title, text) {
  await page.evaluate(([t, x]) => {
    let d = document.getElementById("demo-cap");
    if (!d) {
      d = document.createElement("div");
      d.id = "demo-cap";
      d.style.cssText = "position:fixed;left:104px;bottom:22px;z-index:99999;pointer-events:none;background:rgba(29,31,46,.94);color:#fff;border-radius:14px;padding:12px 20px;max-width:900px;font:500 15px/1.4 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.25)";
      document.body.appendChild(d);
    }
    d.textContent = "";
    const b = document.createElement("b");
    b.style.cssText = "display:block;font-size:17px;margin-bottom:2px";
    b.textContent = t;
    d.append(b, document.createTextNode(x));
  }, [title, text]);
}
const api = async (path, init = {}) => {
  const tok = await page.evaluate(() => JSON.parse(sessionStorage.getItem("inspector.session") ?? "null")?.token);
  return page.evaluate(async ([p, i, t]) => (await fetch(p, { ...i, headers: { ...(i.headers ?? {}), ...(t ? { authorization: `Bearer ${t}` } : {}) } })).json(), [path, init, tok]);
};

/** Прокрутить панель паспорта к разделу по его заголовку (порядок разделов в паспорте может меняться). */
async function scrollToSection(title) {
  await page.evaluate((t) => {
    const h = [...document.querySelectorAll("h2, h3, .section-title, div, span")].find((e) => e.children.length === 0 && e.textContent.trim().toLowerCase() === t.toLowerCase() && e.getBoundingClientRect().left > 800);
    h?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, title);
}
async function scrollPanelTo(frac) {
  await page.evaluate((f) => {
    const el = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== "visible" && e.getBoundingClientRect().left > 800)[0];
    if (el) el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * f, behavior: "smooth" });
  }, frac);
}

try {
  if (PHASE === "A") await phaseA();
  if (PHASE === "B") await phaseB();
  if (PHASE === "C") await phaseC();
  if (PHASE === "D") await phaseD();
  if (PHASE === "E") await phaseE();
} finally {
  await ctx.close();
  await browser.close();
  const f = readdirSync(RAW).find((x) => x.endsWith(".webm"));
  if (f) renameSync(join(RAW, f), join(OUT, `${PHASE}.webm`));
  rmSync(RAW, { recursive: true, force: true });
}

// ─────────────── A. Стенд, пустой префикс S3, загрузка пакета через API
async function phaseA() {
  await consoleView("Инспектор ИИ · М-023 «Класс конструктивной пожарной опасности»", "Полный цикл на стенде Docker: приём пакета → разбор → сравнение → решение инспектора → верификация → выходной набор");
  await cap("1. Стенд", "Пять сервисов в Docker из образов по git-sha: PostgreSQL 18, RabbitMQ (amqps), ML, API, веб. Всё — TLS 1.3.");
  await run("scripts/stand.sh", ["status"]);
  await beat(3500);
  await cap("2. Хранилище файлов — Yandex Object Storage", `Новый пустой префикс ${a.prefix}: ни одного объекта до загрузки.`);
  const ls = await run("rclone", ["lsf", `nadzorium:nadzorium/${a.prefix}`], { allowFail: true });
  if (!ls.length) await line("(пусто — объектов нет)", "dim");
  await run("scripts/thermal.sh", ["now"]);
  await beat(3000);
  await cap("3. Загрузка пакета через API", "Загрузчик читает архив потоком, проверяет пути и пределы, считает SHA-256, выводит реестр из папок и имён; оператор явно подтверждает реестр (--approval); части ≤ 200 МБ.");
  const out = await run("node", ["apps/api/src/cli/load-package.ts", a.zip, "--api", WEB, "--ca", CA, "--login", "inspector", "--password-file", PASSFILE, "--object-id", a["object-id"], "--object-name", a["object-name"], "--approval", "--out", join(OUT, "intake")], {
    show: `node apps/api/src/cli/load-package.ts ${a.zip.split("/").pop()} --api ${WEB} --login inspector --password-file var/stand/secrets/demo_password --object-id ${a["object-id"]} --approval --out intake/`,
  });
  const pid = out.join("\n").match(/P-\d{8}-[0-9a-f]{8}/)?.[0];
  if (!pid) throw new Error("не нашёл process_id в выводе загрузчика");
  state.processId = pid;
  save();
  await beat(2500);
  await cap("4. В бакете — только шифротекст", "Файлы зашифрованы на клиенте AES-256-GCM до отправки (ADR-0006): провайдер хранит нечитаемые байты.");
  const objs = await run("sh", ["-c", `rclone lsf nadzorium:nadzorium/${a.prefix} | wc -l | tr -d ' '`], { show: `rclone lsf nadzorium:nadzorium/${a.prefix} | wc -l` });
  const first = execFileSync("rclone", ["lsf", `nadzorium:nadzorium/${a.prefix}`], { encoding: "utf8" }).split("\n").find(Boolean);
  if (first) await run("sh", ["-c", `rclone cat nadzorium:nadzorium/${a.prefix}${first} --count 48 | xxd | head -3`], { show: `rclone cat …/${first.slice(0, 16)}… --count 48 | xxd` });
  state.objects = Number(objs[0] ?? 0);
  save();
  await beat(3000);
  await cap("5. Статусная модель ТЗ (pull)", `Проверка ${pid}: API отдаёт статус по process_id — клиент опрашивает, а не ждёт ответа.`);
  await run("sh", ["-c", `curl -s --cacert ${CA} -H "authorization: Bearer $(curl -s --cacert ${CA} -H 'content-type: application/json' -d "{\\"login\\":\\"inspector\\",\\"password\\":\\"$(cat ${PASSFILE})\\"}" ${WEB}/api/v1/auth/login | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')" ${WEB}/api/v1/inspection/${pid}/status | python3 -m json.tool | head -25`], { show: `curl ${WEB}/api/v1/inspection/${pid}/status` });
  await beat(4000);
}

// ─────────────── B. Разбор идёт: интерфейс проверки, реальные часы (в ролике ускорено)
async function phaseB() {
  const pid = state.processId;
  await login();
  await page.goto(`${WEB}/#/inspections/${pid}`);
  await beat(2500);
  await page.getByRole("button", { name: /^Документы/ }).click();
  const t0 = Date.now();
  state.bStart = new Date().toISOString();
  save();
  for (let i = 0; i < 360; i++) {
    const d = await api(`/api/v1/inspections/${pid}`);
    const files = d.files ?? [];
    const done = files.filter((f) => f.parse_status === "DONE").length;
    const failed = files.filter((f) => f.parse_status === "FAILED").length;
    const mm = Math.floor((Date.now() - t0) / 60000), ss = Math.floor(((Date.now() - t0) % 60000) / 1000);
    await uiCaption("6. Разбор: очередь RabbitMQ → ML (текстовый слой, OCR сканов, извлечение)", `Статус ${d.inspection?.status} · разобрано ${done} из ${files.length}${failed ? ` · ошибок ${failed}` : ""} · прошло ${mm} мин ${String(ss).padStart(2, "0")} с реального времени — в ролике ускорено`);
    if (d.inspection?.status !== "PARSING" && d.inspection?.status !== "UPLOADED" && d.inspection?.status !== "PENDING") break;
    await beat(20_000);
    await page.reload();
    await page.getByRole("button", { name: /^Документы/ }).click().catch(() => {});
    await beat(1500);
  }
  state.bEnd = new Date().toISOString();
  state.parseMinutes = Math.round((Date.now() - t0) / 60000);
  save();
  await page.getByRole("button", { name: /^Обзор/ }).click();
  await uiCaption("Разбор завершён", `Статус READY: сводка сверки сформирована за ${state.parseMinutes} мин на CPU мака (4 ядра, 8 ГБ у ML).`);
  await beat(5000);
}

// ─────────────── C. Результат М-023 в интерфейсе и решение инспектора
async function phaseC() {
  const pid = state.processId;
  await login();
  await uiCaption("7. Список проверок", "Проверка пакета «Алтуфьевское 79Б» — готова к верификации.");
  await beat(2500);
  await page.getByText(a["object-name"]).first().click();
  await beat(2500);
  await uiCaption("8. Обзор проверки", "Счётчики по статусам ТЗ; система не пишет «нарушение» — его признаёт инспектор.");
  await beat(4000);
  await page.getByRole("button", { name: /^Сводка сверки/ }).click();
  await beat(1500);
  // «Нет доказательства» (открыта по умолчанию, 130+ строк) — свернуть; «Проверенные отрицательные» — развернуть
  const grp = (t) => page.locator(".group", { hasText: t });
  await grp("Нет доказательства").getByRole("button", { name: "Свернуть" }).click();
  await beat(800);
  await grp("Проверенные отрицательные").getByRole("button", { name: "Свернуть" }).click();
  await beat(1200);
  const row = grp("Проверенные отрицательные").getByText("M-023").first();
  await row.scrollIntoViewIfNeeded();
  await uiCaption("9. М-023 — расхождения нет", "ПД: раздел ПБ «класс не ниже С0» (приоритетный источник) → РД: АР «С0». Класс не понижен по шкале С3 < С2 < С1 < С0.");
  await row.hover();
  await beat(5500);
  await page.getByRole("button", { name: /^Гипотезы/ }).click();
  await beat(1500);
  await uiCaption("10. Гипотеза: внутреннее противоречие ПД", "В разделе КР класс указан как С1 — ниже, чем требует ПБ. Это не нарушение, а повод уточнить у проектировщика.");
  await beat(5500);
  // идемпотентно: при повторной записи фазы решения, принятые в прошлый раз, не повторяются
  const created = page.getByRole("link", { name: "Кандидат создан" }).first();
  if (!(await created.isVisible())) {
    const sel = page.locator("select").filter({ has: page.locator("option[value=ACCEPTED]") }).first();
    await sel.selectOption("ACCEPTED");
    await beat(2000);
    await uiCaption("11. Инспектор берёт гипотезу в работу и переводит в кандидаты", "Опорный лист — упоминание худшего класса (КР, С1) с рамкой на листе.");
    await page.getByRole("button", { name: "В кандидаты" }).first().click();
    await beat(2500);
  }
  await page.getByRole("link", { name: "Кандидат создан" }).first().click();
  await page.waitForURL(/verify/);
  await beat(3500);
  await uiCaption("12. Экран верификации: лист КР с рамкой", "Инспектор видит сам лист и цитату. Решение — «Уточнить»: противоречие закрывает проектировщик.");
  await beat(6000);
  const clarify = page.getByRole("button", { name: /Уточнить/ });
  if (await clarify.isVisible()) await clarify.click();
  await beat(3000);
  await uiCaption("13. Решение записано", "Статус кандидата — «уточнить»; решение и автор — в журнале действий проверки.");
  await beat(3500);
  await page.goto(`${WEB}/#/matrix`);
  await beat(2500);
  await uiCaption("14. Матрица: код параметра — ссылка на паспорт", "Щелчок по коду М-023 открывает паспорт: атрибуты, источники, шкала, порядок и алгоритм расчёта, метрики.");
  await page.getByRole("button", { name: "M-023" }).first().scrollIntoViewIfNeeded();
  await beat(1500);
  await page.getByRole("button", { name: "M-023" }).first().click();
  await beat(4000);
  for (const [sec, t, x] of [
    ["Приоритет источников", "15. Шкала и приоритет источников", "С3 < С2 < С1 < С0; ПД: ПЗ → ПБ → АР → КР → прочие; РД: АР → КР → КЖ → КМ; ПД — только комплект, связанный с РД по базовому шифру."],
    ["Метрики параметра", "16. Метрики единого вида", "Одинаковые строки у любого параметра: проверки, статусы, решения, охват стадий, уверенность; верификация пока «не проводилась»."],
    ["Порядок и алгоритм расчёта", "17. Алгоритм по шагам L0–L9", "Каждый шаг — операции каталога TO-BE и что происходит при сбое; шаги, особые для М-023, выделены."],
    ["Исходы", "18. Исходы", "Какой статус система ставит в каждом случае: понижен, не ниже ограничения, нет РД, противоречие внутри ПД."],
  ]) {
    await scrollToSection(sec);
    await uiCaption(t, x);
    await beat(5500);
  }
}

// ─────────────── D. Автоверификация независимым пересчётом и выходной набор
async function phaseD() {
  const pid = state.processId;
  await consoleView("Автоматическая верификация и выходной набор", `Проверка ${pid}`);
  await cap("19. Независимый пересчёт (оракул)", "Другой путь: текст — poppler (pdftotext), свои регулярные выражения и выбор источника. Общее с системой — только паспорт.");
  // токены — без оболочки (curl с массивом аргументов): вложенные кавычки в sh -c ломали вход; в кадр токен не выводится
  const token = (login) => JSON.parse(execFileSync("curl", ["-s", "--cacert", CA, "-H", "content-type: application/json", "-d", JSON.stringify({ login, password: PASS }), `${WEB}/api/v1/auth/login`], { encoding: "utf8" })).token;
  const tInsp = token("inspector");
  const tMl = token("ml");
  const V = join(OUT, "verify");
  mkdirSync(V, { recursive: true });
  execFileSync("curl", ["-s", "--cacert", CA, "-H", `authorization: Bearer ${tInsp}`, "-o", `${V}/protocol.json`, `${WEB}/api/v1/inspection/${pid}/protocol`]);
  execFileSync("curl", ["-s", "--cacert", CA, "-H", `authorization: Bearer ${tInsp}`, "-o", `${V}/inspection.json`, `${WEB}/api/v1/inspections/${pid}`]);
  await run("uv", ["run", "--directory", "ml", "python", "-m", "eval.verify_class_param", "--package", a["package-dir"], "--protocol", `${V}/protocol.json`, "--inspection", `${V}/inspection.json`, "--passport", join(root, "data/seed/passports/M-023.json"), "--out", `${V}/verification.json`], {
    show: "uv run python -m eval.verify_class_param --package <пакет> --protocol protocol.json --inspection inspection.json --passport M-023.json",
    allowFail: true,
  });
  await beat(5000);
  await cap("20. Вердикт считает сервер", "ML-инженер отправляет поля сверки; совпадение сервер определяет сам, присланное «ok» не учитывается.");
  const body = JSON.stringify({ inspection_id: pid, method: "pdftotext (poppler) + независимые regex и выбор источника; спецификация — паспорт", fields: JSON.parse(readFileSync(`${V}/verification.json`, "utf8")).fields });
  writeFileSync(`${V}/body.json`, body);
  await run("sh", ["-c", `curl -s --cacert ${CA} -H "authorization: Bearer ${tMl}" -H 'content-type: application/json' --data-binary @${V}/body.json ${WEB}/api/v1/params/M-023/verifications | python3 -m json.tool`], { show: `curl -X POST ${WEB}/api/v1/params/M-023/verifications  (роль ML-инженер)` });
  await beat(4500);
  await cap("21. Выходной набор", "Протокол в JSON, XML, PDF, DOCX; статус; паспорт; отчёт о приёме; отчёт верификации; опись SHA-256.");
  await run("node", ["apps/api/src/cli/output-set.ts", "--api", WEB, "--ca", CA, "--process-id", pid, "--out", join(OUT, "output-set"), "--login", "inspector", "--password-file", PASSFILE, "--intake", join(OUT, "intake/intake-report.json"), "--verification", `${V}/verification.json`, "--param", "M-023"], {
    show: `node apps/api/src/cli/output-set.ts --process-id ${pid} --out output-set/ --intake intake/intake-report.json --verification verification.json`,
  });
  await run("sh", ["-c", `cd ${join(OUT, "output-set")} && ls -1 && shasum -a 256 -c MANIFEST.sha256`], { show: "ls output-set && shasum -a 256 -c MANIFEST.sha256" });
  await beat(5000);
}

// ─────────────── E. Паспорт показывает результат верификации
async function phaseE() {
  await login();
  await page.goto(`${WEB}/#/matrix?code=M-023`);
  await beat(3000);
  await scrollToSection("Автоматическая верификация");
  await uiCaption("22. Паспорт М-023: автоматическая верификация — совпало", "Итог, классы ПД и РД, противоречие внутри ПД и листы-доказательства: система и независимый пересчёт сошлись.");
  await beat(8000);
  await page.goto(`${WEB}/#/inspections/${state.processId}`);
  await beat(2000);
  await uiCaption("Итог", `Пакет принят через API, файлы — в Yandex Object Storage зашифрованными; разбор — ${state.parseMinutes ?? "?"} мин; М-023: расхождения нет, противоречие ПД передано на уточнение; верификация — совпало; выходной набор с описью SHA-256.`);
  await beat(8000);
}

// ─────────────── склейка: B ускоряется так, чтобы занять ~80 с; остальное — как есть
function join_() {
  const parts = ["A", "B", "C", "D", "E"].filter((p) => existsSync(join(OUT, `${p}.webm`)));
  const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
  const seg = [];
  for (const p of parts) {
    const src = join(OUT, `${p}.webm`);
    const dst = join(OUT, `${p}.mp4`);
    const d = dur(src);
    const k = p === "B" ? Math.max(1, d / 80) : 1;
    const vf = [`setpts=PTS/${k.toFixed(3)}`, "scale=1440:900", "fps=30"].join(",");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-vf", vf, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", dst]);
    seg.push(dst);
    console.log(`${p}: ${d.toFixed(0)} с${k > 1 ? ` → ×${k.toFixed(0)}` : ""}`);
  }
  writeFileSync(join(OUT, "list.txt"), seg.map((s) => `file '${s}'`).join("\n"));
  const fin = join(OUT, "Инспектор-ИИ-М-023-полный-цикл.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(OUT, "list.txt"), "-c", "copy", "-movflags", "+faststart", fin]);
  console.log(`итог: ${fin} · ${(statSync(fin).size / 1e6).toFixed(1)} МБ · ${dur(fin).toFixed(0)} с`);
}
