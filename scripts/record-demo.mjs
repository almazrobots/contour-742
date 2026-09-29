#!/usr/bin/env node
// Ролик-обзор реализованных сценариев «Инспектора ИИ» с подписями в кадре.
// Поднимает отдельный стенд (порты 48810–48812, чистая база var/video/), проходит сценарии браузером Playwright
// (headless, собственный тестовый прогон — не браузер пользователя) и собирает docs/demo/inspector-demo.mp4.
//   node scripts/record-demo.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const work = join(root, "var/video");
const out = join(root, "docs/demo");
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "raw"), { recursive: true });
mkdirSync(out, { recursive: true });
const PASSWORD = randomBytes(9).toString("base64url");
const PORTS = { api: 48810, ml: 48811, web: 48812 };
const env = {
  ...process.env,
  INSPECTOR_PROFILE: "dev",
  // отдельная база PGlite стенда ролика: каталог чистится вместе с var/video, рабочую var/pgdata не трогает
  INSPECTOR_DATABASE_URL: `pglite:${join(work, "pgdata")}`,
  INSPECTOR_BLOB_DIR: join(work, "blobs"),
  INSPECTOR_ML_CACHE: join(work, "ml-cache"),
  INSPECTOR_ML_URL: `http://127.0.0.1:${PORTS.ml}`,
  INSPECTOR_RIN_URL: `http://127.0.0.1:${PORTS.api}/mock-rin`,
  INSPECTOR_DEMO_PASSWORD: PASSWORD,
  INSPECTOR_API_URL: `http://127.0.0.1:${PORTS.api}`,
  WEB_PORT: String(PORTS.web),
  PORT: String(PORTS.api),
};
const procs = [
  spawn(join(root, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--port", String(PORTS.ml), "--log-level", "warning"], { cwd: join(root, "ml"), env, stdio: "ignore" }),
  spawn("pnpm", ["--filter", "@inspector/api", "start"], { cwd: root, env, stdio: "ignore" }),
  spawn("pnpm", ["--filter", "@inspector/web", "dev"], { cwd: root, env, stdio: "ignore" }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("exit", stop);

async function waitUp(url) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`не поднялся ${url}`);
}
await waitUp(`http://127.0.0.1:${PORTS.ml}/health`);
await waitUp(`http://127.0.0.1:${PORTS.api}/health`);
await waitUp(`http://127.0.0.1:${PORTS.web}/`);

const W = 1440, H = 900;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: join(work, "raw"), size: { width: W, height: H } }, acceptDownloads: true, locale: "ru-RU" });
const page = await ctx.newPage();
const BASE = `http://127.0.0.1:${PORTS.web}`;
const beat = (ms = 2200) => page.waitForTimeout(ms);
const subs = []; // субтитры .srt
const t0 = Date.now();
let lastSub = null;

// ─────────────── подписи в кадре
async function overlay() {
  await page.evaluate(() => {
    if (document.getElementById("demo-cap")) return;
    const st = document.createElement("style");
    st.textContent = `#demo-cap{position:fixed;left:84px;bottom:22px;z-index:99999;pointer-events:none;
      background:rgba(23,24,43,.92);color:#fff;border-radius:14px;padding:12px 20px 13px;max-width:820px;width:max-content;
      font:500 15px/1.4 "Golos Text",system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25);display:flex;gap:14px;align-items:flex-start}
      #demo-cap b{font-family:"Onest",system-ui;font-size:17px;display:block;margin-bottom:2px}
      #demo-cap .n{background:#6a4df4;border-radius:9px;min-width:34px;height:34px;display:grid;place-items:center;font:700 15px "Onest",system-ui}
      #demo-cap .tz{color:#b7a8ff;font:600 12px "JetBrains Mono",monospace;margin-left:8px}
      #demo-card{position:fixed;inset:0;z-index:99998;background:radial-gradient(900px 500px at 15% 0%,#e7e1ff,transparent 60%),#f3f4f8;
      display:flex;flex-direction:column;justify-content:center;padding:0 120px;gap:14px;font-family:"Golos Text",system-ui;color:#1d1f2e}
      #demo-card h1{font:700 52px/1.1 "Onest",system-ui;margin:0;letter-spacing:-.02em}#demo-card p{font-size:21px;color:#4a4e66;margin:0;max-width:980px}
      #demo-card .tag{font:600 14px "JetBrains Mono",monospace;color:#6a4df4}#demo-card ul{font-size:18px;color:#4a4e66;columns:2;max-width:1100px}`;
    document.head.appendChild(st);
    const d = document.createElement("div");
    d.id = "demo-cap";
    d.style.display = "none";
    document.body.appendChild(d);
  });
}

async function caption(n, title, text, tz = "") {
  await overlay();
  await page.evaluate(
    ([n, title, text, tz]) => {
      const d = document.getElementById("demo-cap");
      d.innerHTML = `<span class="n">${n}</span><div><b>${title}${tz ? `<span class="tz">${tz}</span>` : ""}</b>${text}</div>`;
      d.style.display = "flex";
    },
    [n, title, text, tz],
  );
  const now = (Date.now() - t0) / 1000;
  if (lastSub) lastSub.end = now;
  lastSub = { start: now, end: now + 5, text: `${n}. ${title}${tz ? ` (${tz})` : ""} — ${text}` };
  subs.push(lastSub);
}

async function card(tag, title, text, list = []) {
  await page.evaluate(
    ([tag, title, text, list]) => {
      document.getElementById("demo-card")?.remove();
      const c = document.createElement("div");
      c.id = "demo-card";
      c.innerHTML = `<div class="tag">${tag}</div><h1>${title}</h1><p>${text}</p>${list.length ? `<ul>${list.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}`;
      document.body.appendChild(c);
      const cap = document.getElementById("demo-cap");
      if (cap) cap.style.display = "none";
    },
    [tag, title, text, list],
  );
  const now = (Date.now() - t0) / 1000;
  if (lastSub) lastSub.end = now;
  lastSub = { start: now, end: now + 5, text: `${title}. ${text}` };
  subs.push(lastSub);
}
const uncard = () => page.evaluate(() => document.getElementById("demo-card")?.remove());

async function login(who) {
  await page.goto(`${BASE}/#/login`);
  await page.fill("#login", who);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL(/#\/inspections/);
  await overlay();
}
async function logout() {
  await page.locator('nav.rail a[title*="выйти"]').click();
  await page.waitForURL(/#\/login/);
}
const synth = (obj) => join(root, "data/synth", obj);
const pkg = (obj) => readdirSync(synth(obj)).filter((f) => /\.(pdf|docx|xml|xlsx|png|jpg|tif)$/.test(f) || f === "manifest.json").map((f) => join(synth(obj), f));

async function upload(obj, n, title) {
  await page.locator('nav.rail a[title="Загрузка"]').click();
  await overlay();
  await caption(n, title, "Пакет ПД/РД/ИД и машиночитаемый реестр файлов: формат, размер и хеш проверяются при приёме.", "OS-INSP-1.1 · 1.2");
  await page.setInputFiles("#files", pkg(obj));
  await beat(1800);
  await page.getByRole("button", { name: /Загрузить и начать проверку/ }).click();
  await page.getByRole("button", { name: "Открыть проверку" }).waitFor();
  await beat(2200);
  await page.getByRole("button", { name: "Открыть проверку" }).click();
  await overlay();
  await page.getByText("Протокол готов").first().waitFor({ timeout: 60_000 });
}

try {
  // ─────────────── заставка
  await page.goto(`${BASE}/#/login`);
  await overlay();
  await card("ЛЦТ-2026 · кейс Мосстройнадзора", "Инспектор ИИ", "Сверка проектной, рабочей и исполнительной документации по 132 параметрам Матрицы. Нарушение признаёт только инспектор — по карточке доказательства на листе.", [
    "Приём пакета и выбор актуальной редакции", "Разбор PDF/DOCX/XML и OCR сканов", "Сравнение: 6 статусов ТЗ", "Гипотезы вне Матрицы",
    "Верификация с листами и bbox", "Финализация и передача в ИАИС «РиН»", "Дозагрузка и версии протокола", "Матрица, нормы, GOLD, аудит",
  ]);
  await beat(6500);
  await uncard();

  // 1. вход
  await caption(1, "Вход по логину и паролю", "Роли: инспектор, супервизор, администратор, ML-инженер, куратор данных.", "ТЗ 12.1–12.2");
  await page.fill("#login", "inspector");
  await page.fill("#password", PASSWORD);
  await beat(1500);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL(/#\/inspections/);
  await overlay();
  await caption(1, "Дашборд инспектора", "Проверок пока нет. Начнём с загрузки пакета жилого комплекса.", "OS-INSP-8.1");
  await beat();

  // 2. загрузка и разбор
  await upload("OBJ-SEV-2", 2, "Загрузка пакета документов");
  await caption(3, "Протокол сформирован автоматически", "Сценарий FULL, статусы загрузки PD/RD/ID_UPLOADED. Кандидаты ждут решения, нарушений пока ноль — их ставит только инспектор.", "OS-INSP-1.4 · 3.3");
  await beat(3500);

  // 4. документы и редакции
  await page.getByRole("button", { name: /^Документы/ }).click();
  await caption(4, "Актуальные редакции и распознавание", "АР ред. A заменена ред. B — в сравнении не участвует. Скан паспорта двери разобран OCR, уверенность видна.", "OS-INSP-1.3 · 2.1");
  await beat(4500);

  // 5. протокол
  await page.getByRole("button", { name: /^Протокол/ }).click();
  await caption(5, "Протокол по разделам ТЗ 9.2", "Кандидаты, подтверждённые, «нет доказательства», проверенные отрицательные, неприменимые — раздельно.", "OS-INSP-3.1 · 3.3.2");
  await beat(4000);

  // 6–9. верификация
  await page.getByRole("button", { name: /Верифицировать/ }).first().click();
  await overlay();
  await page.locator(".sheet canvas").first().waitFor();
  await beat(1500);
  await caption(6, "Карточка доказательства", "Ожидается и факт, источники с шифром, редакцией и SHA-256, листы ПД/РД/ИД с выделенными областями.", "OS-INSP-4.1.1");
  await beat(4500);
  await page.locator(".queue .item", { hasText: "M-002" }).click();
  await beat(1500);
  await caption(7, "Составной кандидат → атомарные findings", "Общая площадь расходится и в РД, и в ИД: разделяем на две записи со своими доказательствами.", "OS-INSP-4.2");
  await beat(2000);
  await page.getByRole("button", { name: /Разделить на атомарные/ }).click();
  await beat(3000);
  await page.locator(".queue .item").first().click();
  await caption(8, "Решение за 1–3 клика", "Клавиши: 1 — подтвердить, 2 — отклонить с кодированной причиной, 3 — уточнить.", "OS-INSP-4.1.2–4.1.5");
  await beat(2000);
  await page.keyboard.press("1");
  await beat(2500);
  await page.keyboard.press("2");
  await beat(1200);
  await page.getByRole("button", { name: "Ошибка распознавания" }).click();
  await beat(1200);
  await page.locator(".card").getByRole("button", { name: /^Отклонить$/ }).click();
  await caption(8, "Отклонение с причиной OCR_ERROR", "Системный комментарий ИИ: запись уйдёт в черновик GOLD только после проверки куратором.", "ТЗ 9.4");
  await beat(3000);
  await page.keyboard.press("3");
  await beat(2000);
  for (let i = 0; i < 6; i++) {
    const left = await page.getByRole("button", { name: /Все кандидаты обработаны/ }).count();
    if (left) break;
    await page.keyboard.press("1");
    await beat(1300);
  }
  await caption(9, "Все кандидаты обработаны", "Верификация завершена — протокол можно финализировать.", "OS-INSP-4.3.1");
  await beat(2500);
  await page.getByRole("button", { name: /Все кандидаты обработаны/ }).click();
  await overlay();
  await beat(1000);
  await page.getByRole("button", { name: "Завершить" }).click();
  await page.getByText("Передано в РиН").first().waitFor({ timeout: 20_000 });
  await caption(10, "Финализация и передача в ИАИС «РиН»", "Решения неизменяемы, дозагрузка закрыта. Во внешнюю систему уходят только подтверждённые нарушения с версиями и реестром файлов.", "OS-INSP-4.3 · 5.2");
  await beat(4000);
  await page.getByRole("button", { name: /^Версии и журнал/ }).click();
  await caption(11, "Версии протокола и журнал действий", "Каждое решение записано: кто, когда, причина. Экспорт протокола — PDF, DOCX, XML, JSON.", "OS-INSP-3.3 · 5.1 · 8.2");
  await beat(4000);

  // 12. школа: конфликт редакций
  await upload("OBJ-SCH-8", 12, "Второй объект: школа");
  await page.getByRole("button", { name: /^Документы/ }).click();
  await caption(12, "Конфликт редакций → CLARIFICATION_REQUIRED", "Две утверждённые редакции АР без связи замены: вывод о нарушении блокируется до решения инспектора. Сценарий PD_RD_ONLY.", "OS-INSP-1.3.3 · 3.1.3");
  await beat(4500);

  // 13–14. поликлиника: гипотезы и дозагрузка
  await upload("OBJ-POL-115", 13, "Третий объект: поликлиника");
  await caption(13, "Комплект загружен частично", "Реестр объявляет 4 файла ИД, пришло 2: сценарий PARTIALLY_LOADED, недостающие перечислены.", "OS-INSP-1.4.3");
  await beat(3500);
  await page.getByRole("button", { name: /^Гипотезы/ }).click();
  await caption(14, "Гипотезы свободного поиска", "12 этажей и 0 лифтов (логическое правило); «Техническое помещение» → «Склад ГСМ» (семантический диссонанс). Не нарушения и не GOLD.", "OS-INSP-3.2");
  await beat(5000);
  await page.getByRole("button", { name: /Дозагрузить/ }).click();
  await overlay();
  await caption(15, "Дозагрузка без сброса верификации", "Приходят недостающие АОСР и технический план — пересчитываются только затронутые параметры, версия протокола растёт.", "OS-INSP-1.2.7 · 3.3.4");
  await page.setInputFiles("#files", readdirSync(join(synth("OBJ-POL-115"), "_late")).map((f) => join(synth("OBJ-POL-115"), "_late", f)));
  await beat(1500);
  await page.getByRole("button", { name: /Дозагрузить и пересчитать/ }).click();
  await page.getByRole("button", { name: "Открыть проверку" }).waitFor();
  await page.getByRole("button", { name: "Открыть проверку" }).click();
  await overlay();
  await page.getByText("Протокол готов").first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Версии и журнал/ }).click();
  await caption(15, "Протокол v2 — сценарий стал FULL", "Прежняя версия сохранена в истории.", "OS-INSP-3.3.4");
  await beat(3500);

  // 16. дашборд
  await page.locator('nav.rail a[title="Проверки"]').click();
  await overlay();
  await caption(16, "Дашборд: цвет и фильтры", "Красный — подтверждённые нарушения, жёлтый — требует внимания. Фильтры по разделам, статусам и датам.", "OS-INSP-8.1");
  await beat(3000);
  await page.selectOption("#f-section", "КР");
  await beat(2500);
  await page.selectOption("#f-section", "");
  await beat(1000);

  // 17. администратор: матрица и нормы
  await logout();
  await login("admin");
  await page.locator('nav.rail a[title="Матрица"]').click();
  await overlay();
  await caption(17, "Матрица контроля — 132 параметра", "Администратор меняет порог без перекодирования; версия Матрицы фиксируется в каждом протоколе.", "OS-INSP-7.1");
  await page.fill("#m-q", "M-041");
  await beat(1800);
  await page.getByRole("button", { name: "Изменить" }).first().click();
  await page.fill("#thr-M-041", "1.0");
  await beat(1500);
  await page.getByRole("button", { name: "Сохранить" }).click();
  await beat(3000);
  await page.locator('nav.rail a[title="Нормы"]').click();
  await overlay();
  await caption(18, "Нормативная база и логические правила", "Документы со сроком действия и правила «если A, то B»: выключаются, а не удаляются.", "OS-INSP-7.2 · 7.3");
  await beat(4000);

  // 19. супервизор: журнал и отмена финализации
  await logout();
  await login("supervisor");
  await page.locator('nav.rail a[title="Журнал"]').click();
  await overlay();
  await caption(19, "Журнал аудита", "Каждое действие: время, пользователь, тип, объект, IP.", "OS-INSP-8.2 · ТЗ 12.4");
  await beat(3500);
  await page.locator('nav.rail a[title="Проверки"]').click();
  await overlay();
  await page.getByText("ЖК «Северный квартал», корпус 2").click();
  await overlay();
  await page.getByRole("button", { name: "Отменить финализацию" }).click();
  await page.fill("#unfinalize-reason", "Заявитель представил согласованное изменение ПД");
  await caption(20, "Отмена финализации — только супервизор с причиной", "Протокол возвращается в «Верификация завершена», запись — в журнал аудита.", "OS-INSP-4.4");
  await beat(2200);
  await page.locator(".topbar").getByRole("button", { name: /^Отменить$/ }).click();
  await beat(3000);
  await page.getByRole("button", { name: "Завершить" }).click();
  await beat(2000);

  // 21. куратор: GOLD и отчёт
  await logout();
  await login("curator");
  await page.locator('nav.rail a[title="Модель"]').click();
  await overlay();
  await caption(21, "Эталонный набор GOLD и отчёт по дообучению", "Только решения из финализированных протоколов; разбиение по объектам; причины отклонений с рекомендациями.", "OS-INSP-6.1 · 6.2");
  await beat(3000);
  await page.getByRole("button", { name: "Выпустить версию" }).click();
  await beat(3500);

  // 22. трасса ТЗ
  await page.goto(`file://${join(root, "docs/trace/TRACE-TZ.html")}`);
  await overlay();
  await caption(22, "Трассировочная таблица ТЗ", "77 пунктов ТЗ → операция ГЕРЫ → правило сервиса → код → тест. Гейт `pnpm trace:check` падает на битой связи.", "docs/trace");
  await beat(3500);
  await page.locator(".tile", { hasText: "реализовано" }).click();
  await beat(3500);

  // финал
  await card("Итог прототипа", "Работает на MacBook, готов к GPU", "Профиль dev — текстовый слой, Tesseract, якоря; профиль gpu — нейросетевой OCR, эмбеддинги, LLM, PostgreSQL, RabbitMQ. Предметный код общий.", [
    "103 теста API + 24 ML, мутационный скор 76–91 %", "Трасса: 59 из 77 пунктов ТЗ реализовано", "Демо и тесты — только синтетика", "Документация по ГЕРЕ: docs/gera/inspector",
  ]);
  await beat(6000);
  if (lastSub) lastSub.end = (Date.now() - t0) / 1000;
} finally {
  await ctx.close();
  await browser.close();
  stop();
}

// ─────────────── сборка файла
const raw = readdirSync(join(work, "raw")).find((f) => f.endsWith(".webm"));
const srt = subs
  .map((s, i) => {
    const f = (x) => {
      const ms = Math.max(0, Math.round(x * 1000));
      const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
      const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
      const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
      return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, "0")}`;
    };
    return `${i + 1}\n${f(s.start)} --> ${f(s.end)}\n${s.text}\n`;
  })
  .join("\n");
writeFileSync(join(out, "inspector-demo.srt"), srt);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(work, "raw", raw), "-i", join(out, "inspector-demo.srt"),
  "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  "-c:s", "mov_text", "-metadata:s:s:0", "language=rus", "-metadata", "title=Инспектор ИИ — обзор реализованных сценариев",
  join(out, "inspector-demo.mp4")]);
console.log(`Готово: docs/demo/inspector-demo.mp4 (+ inspector-demo.srt), сцен: ${subs.length}`);
if (existsSync(join(work, "raw", raw))) renameSync(join(work, "raw", raw), join(work, "raw.webm"));
process.exit(0);
