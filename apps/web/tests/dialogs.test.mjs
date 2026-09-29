// UI-тест диалогов (этаж 4 карты трассы): каждый диалог открывается и показывает свою форму.
// Поднимает изолированный стенд (порты 49810–49812, чистая база) и проходит экраны Playwright.
//   node --test apps/web/tests/dialogs.test.mjs
// Параллельная сессия в своём worktree: UI_PORT_BASE=49830 — порты base…base+2;
// INSPECTOR_UVICORN — абсолютный путь к uvicorn, если в worktree нет своего ml/.venv.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const root = new URL("../../../", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "inspector-ui-"));
const PASSWORD = randomBytes(9).toString("base64url");
const PB = Number(process.env.UI_PORT_BASE ?? 49810);
const P = { api: PB, ml: PB + 1, web: PB + 2 };
const env = {
  ...process.env,
  INSPECTOR_PROFILE: "dev",
  INSPECTOR_DATABASE_URL: `pglite:${join(tmp, "pgdata")}`, // своя база PGlite стенда во временном каталоге
  INSPECTOR_BLOB_DIR: join(tmp, "blobs"),
  INSPECTOR_ML_CACHE: join(tmp, "ml-cache"),
  INSPECTOR_ML_URL: `http://127.0.0.1:${P.ml}`,
  INSPECTOR_RIN_URL: `http://127.0.0.1:${P.api}/mock-rin`,
  INSPECTOR_DEMO_PASSWORD: PASSWORD,
  INSPECTOR_API_URL: `http://127.0.0.1:${P.api}`,
  WEB_PORT: String(P.web),
  PORT: String(P.api),
};
const BASE = `http://127.0.0.1:${P.web}`;
let procs = [], browser, page, processId;

async function up(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`не поднялся ${url}`);
}
async function login(who) {
  await page.goto(`${BASE}/#/login`);
  await page.fill("#login", who);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL(/#\/inspections/);
}
// ждать появления (isVisible не ждёт — экраны грузят данные асинхронно)
const visible = (loc) => loc.first().waitFor({ state: "visible", timeout: 15_000 });

before(async () => {
  procs = [
    spawn(process.env.INSPECTOR_UVICORN ?? join(root, "ml/.venv/bin/uvicorn"), ["inspector_ml.app:app", "--port", String(P.ml), "--log-level", "warning"], { cwd: join(root, "ml"), env, stdio: "ignore" }),
    spawn("pnpm", ["--filter", "@inspector/api", "start"], { cwd: root, env, stdio: "ignore" }),
    spawn("pnpm", ["--filter", "@inspector/web", "dev"], { cwd: root, env, stdio: "ignore" }),
  ];
  await up(`http://127.0.0.1:${P.ml}/health`);
  await up(`http://127.0.0.1:${P.api}/health`);
  await up(`${BASE}/`);
  // пакет ЖК загружаем через API — диалоги проверяются на заполненной проверке
  const tok = (await (await fetch(`http://127.0.0.1:${P.api}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password: PASSWORD }) })).json()).token;
  const dir = join(root, "data/synth/OBJ-SEV-2");
  const form = new FormData();
  form.append("manifest", new Blob([readFileSync(join(dir, "manifest.json"))]), "manifest.json");
  for (const f of readdirSync(dir).filter((f) => /\.(pdf|docx|xml)$/.test(f))) form.append("files", new Blob([readFileSync(join(dir, f))]), f);
  processId = (await (await fetch(`http://127.0.0.1:${P.api}/api/v1/documents/upload`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: form })).json()).process_id;
  for (let i = 0; i < 120; i++) {
    const s = await (await fetch(`http://127.0.0.1:${P.api}/api/v1/inspection/${processId}/status`, { headers: { authorization: `Bearer ${tok}` } })).json();
    if (s.status === "READY") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
});

after(async () => {
  await browser?.close();
  procs.forEach((p) => p.kill());
  rmSync(tmp, { recursive: true, force: true });
});

test("DLG-INSP-01 Вход: форма логина и ошибка неверного пароля", async () => {
  await page.goto(`${BASE}/#/login`);
  await visible(page.locator("#login"));
  await visible(page.locator("#password"));
  await page.fill("#login", "inspector");
  await page.fill("#password", "неверный");
  await page.getByRole("button", { name: "Войти" }).click();
  await visible(page.getByText("Неверный логин или пароль"));
  await login("inspector");
});

test("DLG-INSP-02 Дашборд: фильтры, сводка и объект в цветовой группе", async () => {
  await page.goto(`${BASE}/#/inspections`);
  for (const id of ["#f-q", "#f-status", "#f-section", "#f-from", "#f-to"]) await visible(page.locator(id));
  await visible(page.getByText("Подтверждённые нарушения"));
  await visible(page.getByText("СИНТЕТИКА · ЖК «Северный квартал», корпус 2")); // OS-INSP-1.1.3 (T-148): метка синтетики видна в названии
  await visible(page.getByText("Требует внимания"));
});

test("DLG-INSP-23 Объекты: реестр с М-023 по стадиям и карточка объекта с документами и журналом проверок", async () => {
  // T-166: «Объекты» — первый пункт меню, над «Проверками»
  const menu = await page.locator("nav.rail a[title]").evaluateAll((as) => as.map((a) => a.getAttribute("title")));
  assert.deepEqual(menu.slice(0, 2), ["Объекты", "Проверки"]);
  await page.locator('nav.rail a[title="Объекты"]').click();
  await visible(page.locator("#objects-registry"));
  await visible(page.getByText("М-023 · Класс конструктивной пожарной опасности"));
  const row = page.locator("#objects-registry tbody tr", { hasText: "СИНТЕТИКА · ЖК «Северный квартал», корпус 2" });
  await visible(row);
  // итог словами инспектора, без кодов ТЗ
  assert.doesNotMatch(await row.innerText(), /NEGATIVE_VERIFIED|MISSING_EVIDENCE|CANDIDATE|PENDING/);
  await row.click();
  await page.waitForURL(/#\/objects\//);
  await visible(page.locator("#object-docs"));
  for (const s of ["ПД", "РД", "ИД"]) await visible(page.locator(`#object-docs [data-stage] b`, { hasText: s }));
  await visible(page.locator("#object-journal").getByRole("link", { name: processId }));
  await visible(page.getByRole("link", { name: /Сверка М-023/ }));
  await page.getByRole("link", { name: /Сверка М-023/ }).click();
  await page.waitForURL(/#\/matrix\?code=M-023/);
});

test("DLG-INSP-03 Загрузка пакета: файлы, реестр, карточка объекта", async () => {
  await page.locator('nav.rail a[title="Загрузка"]').click();
  await visible(page.getByText("Перетащите PDF, DOCX, XML, XLSX, JPG, PNG, TIF и реестр файлов"));
  for (const k of ["object_id", "name", "address", "customer", "contractor", "permit_number"]) await visible(page.locator(`#card-${k}`));
  await visible(page.getByText(/нет — актуальные редакции не определятся/));
  assert.ok(await page.getByRole("button", { name: /Загрузить и начать проверку/ }).isDisabled());
});

test("DLG-INSP-04 Карточка · Обзор: комплектность, экспорт, верификация", async () => {
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await visible(page.getByText("PD_UPLOADED"));
  for (const f of ["PDF", "DOCX", "XML", "JSON"]) await visible(page.getByRole("button", { name: f, exact: true }));
  await visible(page.getByRole("button", { name: /Верифицировать/ }));
  await visible(page.getByRole("button", { name: /Дозагрузить/ }));
});

test("DLG-INSP-05 Карточка · Документы: роли редакций и OCR", async () => {
  await page.getByRole("button", { name: /^Документы/ }).click();
  await visible(page.getByText("заменена"));
  await visible(page.getByText("эталон"));
  await visible(page.getByText(/OCR \d/));
});

test("DLG-INSP-06 Карточка · Протокол: раздельные группы статусов", async () => {
  await page.getByRole("button", { name: /^Сводка сверки/ }).click();
  for (const g of ["Предварительные кандидаты", "Подтверждённые инспектором нарушения", "Нет доказательства (не нарушение)", "Проверенные отрицательные"]) await visible(page.getByText(g));
});

test("DLG-INSP-07 Карточка · Гипотезы: решение по гипотезе", async () => {
  await page.getByRole("button", { name: /^Гипотезы/ }).click();
  await visible(page.getByText(/ещё не нарушение/));
});

test("DLG-INSP-08 Карточка · Версии и журнал", async () => {
  await page.getByRole("button", { name: /^Версии и журнал/ }).click();
  await visible(page.getByText("Версии сводки сверки"));
  await visible(page.getByText("Журнал действий"));
  await visible(page.getByText("v1", { exact: true }));
});

test("DLG-INSP-09 Верификация: очередь, карточка, листы, решение клавишей", async () => {
  await page.goto(`${BASE}/#/inspections/${processId}/verify`);
  await page.locator(".sheet canvas").first().waitFor();
  await visible(page.locator(".queue .item"));
  await visible(page.getByText("По проекту"));
  await visible(page.getByRole("button", { name: /Признать/ }));
  const before = await page.locator(".queue .item .pill", { hasText: "Ждёт решения" }).count();
  await page.keyboard.press("3");
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".queue .item .pill", { hasText: "Ждёт решения" }).count(), before - 1);
});

test("OS-INSP-4.1.5 Решение по кандидату — не больше 3 кликов (признать, снять с причиной, уточнить)", async () => {
  await page.goto(`${BASE}/#/inspections/${processId}/verify`);
  await visible(page.getByRole("button", { name: /Признать/ }));
  // считаем настоящие клики мыши по документу (в фазе захвата — до обработчиков приложения)
  await page.evaluate(() => { window.__clicks = 0; document.addEventListener("click", () => window.__clicks++, true); });
  const pending = () => page.locator(".queue .item .pill", { hasText: "Ждёт решения" }).count();
  const measure = async (act) => {
    const before = await pending();
    await page.evaluate(() => (window.__clicks = 0));
    await act();
    await page.waitForFunction((n) => [...document.querySelectorAll(".queue .item .pill")].filter((e) => e.textContent.includes("Ждёт решения")).length === n, before - 1, { timeout: 10_000 });
    return page.evaluate(() => window.__clicks);
  };
  const confirm = await measure(() => page.getByRole("button", { name: /Признать/ }).click());
  const reject = await measure(async () => {
    await page.getByRole("button", { name: /^Снять\s*2$/ }).click();
    await page.getByRole("button", { name: /Ошибка распознавания/ }).click(); // причина записывается сразу, комментарий — её текст
  });
  await visible(page.getByRole("button", { name: /Уточнить/ }));
  const clarify = await measure(() => page.getByRole("button", { name: /Уточнить/ }).click());
  assert.deepEqual({ confirm, reject, clarify }, { confirm: 1, reject: 2, clarify: 1 });
});

test("DLG-INSP-10 Матрица: поиск и правило сравнения", async () => {
  await login("admin");
  await page.locator('nav.rail a[title="Матрица"]').click();
  await page.fill("#m-q", "M-041");
  await visible(page.getByText("Ширина эвакуационных выходов (дверей)"));
  await visible(page.getByRole("button", { name: "Изменить" }));
});

test("DLG-INSP-22 Паспорт параметра: открыть по коду, по ссылке, закрыть", async () => {
  const passport = page.getByRole("region", { name: "Паспорт параметра" });
  await page.locator('nav.rail a[title="Матрица"]').click();
  await page.fill("#m-q", "M-023");
  const codeBtn = page.getByRole("button", { name: "M-023", exact: true });
  await codeBtn.click();
  await visible(passport);
  await visible(passport.getByRole("heading", { name: "Класс конструктивной пожарной опасности" }));
  await visible(passport.getByRole("heading", { name: "Порядок и алгоритм расчёта" }));
  assert.match(page.url(), /code=M-023/);
  assert.equal(await codeBtn.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Escape");
  await passport.waitFor({ state: "detached", timeout: 15_000 });
  assert.doesNotMatch(page.url(), /code=/);
  // таблица осталась рабочей: строка на месте, кнопка кода свёрнута
  assert.equal(await codeBtn.getAttribute("aria-expanded"), "false");

  // прямой переход по ссылке открывает паспорт сразу
  await page.goto(`${BASE}/#/matrix?code=M-023`);
  await visible(passport.getByRole("heading", { name: "Класс конструктивной пожарной опасности" }));
  await visible(passport.getByText("особое для этого параметра"));
  // неизвестный код — «Параметр не найден», таблица Матрицы на месте
  await page.goto(`${BASE}/#/matrix?code=M-999`);
  await visible(passport.getByText("Параметр не найден"));
  await visible(page.locator("#m-q"));
});

test("DLG-INSP-11 Нормы и правила: нормативы и логические правила", async () => {
  await page.locator('nav.rail a[title="Нормы"]').click();
  await visible(page.getByText("СП 1.13130.2020").first());
  await visible(page.getByText("Здание выше 10 этажей оборудуется лифтом"));
});

test("DLG-INSP-12 Модель: GOLD, отчёт, реестр моделей", async () => {
  await page.locator('nav.rail a[title="Модель"]').click();
  await visible(page.getByText("Черновик GOLD"));
  await visible(page.getByText("Отчёт по дообучению за неделю"));
  await visible(page.getByText("Реестр моделей"));
});

test("DLG-INSP-13 Журнал аудита: действия с IP", async () => {
  await page.locator('nav.rail a[title="Журнал"]').click();
  await visible(page.locator("#a-action"));
  await visible(page.locator("td.mono", { hasText: "LOGIN_FAILED" }));
});

// ─────────────── T-059: функции итерации 3, выведенные в интерфейс (DLG-INSP-14…20)
// T-150: только строка документа (id="doc-…"), а не раскрытая под ней карточка — в ней тоже есть имя файла
const docRow = (name) => page.locator('tr[id^="doc-"]', { hasText: name });
const docCard = () => page.locator('[aria-label="Карточка документа"]');
async function openDocs() {
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await page.getByRole("button", { name: /^Документы/ }).click();
}

test("DLG-INSP-14 Карточка · Документы: вид документа бейджем в списке", async () => {
  await login("inspector");
  await openDocs();
  await visible(docRow("SEV-ID-ICH-1.pdf").locator('[data-doc-type="drawing"]', { hasText: "Чертёж" }));
  await visible(docRow("SEV-PD-SM-1.pdf").locator('[data-doc-type="estimate"]', { hasText: "Смета" }));
  await visible(docRow("SEV-RD-OL-1.pdf").locator('[data-doc-type="questionnaire"]', { hasText: "Опросный лист" }));
});

test("DLG-INSP-15 Реквизиты: список по страницам, рамки на листе, находка REQ и слой на верификации", async () => {
  await openDocs();
  await docRow("SEV-ID-ICH-1.pdf").click();
  await visible(docCard().getByText("Реквизиты по страницам"));
  await visible(docCard().getByText("штамп «В производство работ»"));
  await visible(docCard().getByText("штамп исполнительной документации"));
  await visible(docCard().locator('.hl.req[data-kind="stamp_production"]'));
  // паспорт двери без подписи — находка REQ-<файл> (MISSING_EVIDENCE) в карточке документа
  await docRow("SEV-ID-DOOR-1.pdf").click();
  await visible(docCard().getByText("REQ-SEV-ID-DOOR-1"));
  await visible(docCard().getByText(/не найден обязательный реквизит \(подпись\)/));
  // верификация: реквизиты поверх листов доказательств, слой выключается
  // верификация: лист открыт на фрагменте (Прицел); реквизиты всего листа — пока удерживается Space
  await page.goto(`${BASE}/#/inspections/${processId}/verify`);
  await page.locator(".viewer .page-wrap.aimed").first().waitFor();
  await page.keyboard.down("Space");
  await visible(page.locator(".viewer .hl.req"));
  await page.locator("#show-requisites").uncheck();
  assert.equal(await page.locator(".viewer .hl.req").count(), 0);
  await page.keyboard.up("Space");
});

test("DLG-INSP-15a T-133 документ раскрывается под своей строкой; непрерывная прокрутка — листы подряд", async () => {
  // пакет подгружается в фоне, как только открыта вкладка: файлы запрашиваются без щелчка по строкам
  const fetched = new Set();
  const onReq = (r) => { const m = r.url().match(/\/api\/v1\/files\/([^/]+)\/content/); if (m) fetched.add(m[1]); };
  page.on("request", onReq);
  // T-150: кэш документов (Sheet.tsx) уровня модуля — DLG-INSP-14 уже загрузил пакет; перезагрузка даёт холодный кэш
  await page.reload();
  await openDocs();
  for (let i = 0; i < 40 && fetched.size < 2; i++) await page.waitForTimeout(250);
  page.off("request", onReq);
  assert.ok(fetched.size >= 2, `фоновая подгрузка: запрошено файлов ${fetched.size}`);
  const row = docRow("SEV-ID-ICH-1.pdf");
  await row.click();
  // следующая строка таблицы сразу после документа — его просмотр, а не конец списка
  await visible(row.locator("xpath=following-sibling::tr[1]").locator('[aria-label="Карточка документа"]'));
  await docCard().getByLabel("Непрерывная прокрутка").check();
  await visible(docCard().locator('.doc-page[data-page="1"] .sheet'));
  assert.ok((await docCard().locator(".doc-page").count()) >= 1);
  await docCard().getByLabel("Непрерывная прокрутка").uncheck();
  await row.click(); // повторный щелчок сворачивает
  assert.equal(await page.locator('[aria-label="Карточка документа"]').count(), 0);
});

test("DLG-INSP-16 Измерение на чертеже: размерные линии и мм; без масштаба — «Несопоставимо»", async () => {
  await openDocs();
  await docRow("SEV-ID-ICH-1.pdf").click();
  await docCard().locator(".sheet canvas").waitFor();
  await docCard().getByRole("button", { name: "Измерить" }).click();
  await visible(docCard().locator('.dim-line[data-label="6000 мм"]'));
  await visible(docCard().getByText("Масштаб определён"));
  assert.ok((await docCard().locator(".dist").count()) >= 1, "измеренные расстояния нарисованы на листе");
  // стр. 2 без размерных линий — NOT_COMPARABLE, понятное сообщение и ни одного расстояния
  await docCard().getByRole("button", { name: "Следующая страница" }).click();
  await visible(docCard().getByText("стр. 2 из 3"));
  await docCard().getByRole("button", { name: "Измерить" }).click();
  await visible(docCard().getByText(/Масштаб не определён/));
  assert.equal(await docCard().locator(".dist").count(), 0);
});

test("DLG-INSP-17 Карточка · Отклонения и споры: журналы видны надзору, не инспектору", async () => {
  await login("supervisor");
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await page.getByRole("button", { name: /^Отклонения и споры/ }).click();
  const rej = page.locator('[aria-label="Журнал отклонений"]');
  await visible(rej.getByText("OCR_ERROR"));
  await visible(rej.locator("td", { hasText: "Ошибка распознавания" }));
  await visible(page.locator('[aria-label="Журнал спорных случаев"]').getByText("Запрошено уточнение"));
  await login("inspector");
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await visible(page.getByRole("button", { name: /^Сводка сверки/ }));
  assert.equal(await page.getByRole("button", { name: /^Отклонения и споры/ }).count(), 0);
});

test("DLG-INSP-18 Нормы и правила: справочник 13 нормативных правовых актов", async () => {
  await page.locator('nav.rail a[title="Нормы"]').click();
  const t = page.locator("#legal-acts");
  await visible(t.getByText("Градостроительный кодекс Российской Федерации"));
  for (const h of ["№", "Вид", "Наименование", "Реквизиты", "Редакция", "Примечание"]) await visible(t.locator("th", { hasText: h }));
  assert.equal(await t.locator("tbody tr").count(), 13);
});

test("DLG-INSP-19 Модель: еженедельные отчёты по неделям", async () => {
  await login("ml");
  await page.locator('nav.rail a[title="Модель"]').click();
  const t = page.locator("#weekly-reports");
  await visible(t.locator("tbody tr"));
  assert.match(await t.locator("tbody tr").first().innerText(), /\d\d\.\d\d\.\d{4} — \d\d\.\d\d\.\d{4}/);
  await t.locator("tbody tr").first().click();
  await visible(page.getByText("Причины отклонений и что делать"));
});

test("DLG-INSP-20 Карточка · Протокол: запись о применении ИИ для акта и копирование", async () => {
  await login("inspector");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await page.getByRole("button", { name: /^Сводка сверки/ }).click();
  const box = page.locator('[aria-label="Запись о применении ИИ для акта"]');
  // до финализации: сведения видны, текста для акта нет (API отвечает 409), копировать нечего
  await visible(box.locator("#ai-usage-pending", { hasText: "после завершения сводки сверки" }));
  await visible(box.locator("dd", { hasText: "2078-ПП, п. 9(1).8" }));
  assert.equal(await box.getByRole("button", { name: "Скопировать" }).isDisabled(), true);
  assert.equal(await box.locator("#ai-usage-text").count(), 0);
  // после финализации — подменяем только признак final, текст берём из того же ответа API (act_text)
  let actText = "";
  await page.route(/\/ai-usage(\?.*)?$/, async (route) => {
    if (route.request().url().includes("format=text")) return route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: actText });
    const res = await route.fetch();
    const j = await res.json();
    actText = j.act_text;
    return route.fulfill({ response: res, json: { ...j, final: true } });
  });
  await page.reload();
  await page.getByRole("button", { name: /^Сводка сверки/ }).click();
  await visible(box.locator("#ai-usage-text", { hasText: "применено программное средство «Инспектор ИИ»" }));
  await visible(box.getByText(/исправно: обработаны все 13 файлов/));
  await visible(box.locator(".hash", { hasText: /SHA-256 [0-9a-f]{64}/ }));
  await box.getByRole("button", { name: "Скопировать" }).click();
  await visible(page.getByText("Текст записи скопирован"));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^При проведении мероприятия/);
  assert.match(clip, /Прилагается: Протокол проверки .+ SHA-256 [0-9a-f]{64}/);
  await page.unroute(/\/ai-usage(\?.*)?$/);
});

test("T-110 Совпадения выборкой: ответ «верно» по всей выборке и приёмка партии одним действием", async () => {
  await login("inspector");
  await page.goto(`${BASE}/#/inspections/${processId}/sample`);
  await visible(page.getByText(/остальные примете одним действием/));
  const accept = page.getByRole("button", { name: /Принять остальные/ });
  assert.ok(await accept.isDisabled(), "до ответов по выборке принять нельзя");
  const n = await page.locator(".sample-card").count();
  assert.ok(n >= 1, "в выборке есть карточки");
  for (let i = 0; i < n; i++) await page.keyboard.press("1");
  await page.waitForFunction(() => !document.querySelector(".sample-side .btn.primary")?.hasAttribute("disabled"));
  await page.keyboard.press("Shift+Enter");
  await visible(page.getByText(/Акт приёмки записан/));
});

test("T-112 «Мне сейчас»: с дашборда J и Enter — сразу в конвейер, кнопка «Продолжить» у проверки с кандидатами", async () => {
  await page.goto(`${BASE}/#/inspections`);
  await visible(page.getByRole("button", { name: /Продолжить · \d+/ }));
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/verify/);
  await visible(page.getByRole("button", { name: /Признать/ }));
});

test("OS-INSP-4.1.15 Отмена решения клавишей Z: кандидат снова ждёт решения", async () => {
  await page.goto(`${BASE}/#/inspections/${processId}/verify`);
  await visible(page.getByRole("button", { name: /Признать/ }));
  const pending = () => page.locator(".queue .item .pill", { hasText: "Ждёт решения" }).count();
  const before = await pending();
  await page.keyboard.press("3");
  await page.waitForFunction((n) => [...document.querySelectorAll(".queue .item .pill")].filter((e) => e.textContent.includes("Ждёт решения")).length === n, before - 1, { timeout: 10_000 });
  await page.keyboard.press("z");
  await page.waitForFunction((n) => [...document.querySelectorAll(".queue .item .pill")].filter((e) => e.textContent.includes("Ждёт решения")).length === n, before, { timeout: 10_000 });
  await visible(page.getByText(/Решение возвращено/));
});

test("OS-INSP-4.1.12 Общий корень: снял с причиной — панель соседей, Enter снимает их поштучно", async () => {
  const API = `http://127.0.0.1:${P.api}`;
  const tok = (await (await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password: PASSWORD }) })).json()).token;
  const h = { authorization: `Bearer ${tok}` };
  const insp = await (await fetch(`${API}/api/v1/inspections/${processId}`, { headers: h })).json();
  let target = null;
  for (const c of insp.checks.filter((c) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING")) {
    const sib = await (await fetch(`${API}/api/v1/checks/${c.id}/siblings`, { headers: h })).json();
    if (sib.length) { target = c; break; }
  }
  assert.ok(target, "в синтетике есть кандидат с соседями по общему корню");
  await page.goto(`${BASE}/#/inspections/${processId}/verify?c=${encodeURIComponent(target.id)}`);
  await visible(page.getByRole("button", { name: /Признать/ }));
  await page.keyboard.press("2");
  await page.keyboard.press("2");
  await visible(page.getByRole("dialog", { name: "Общий корень" }));
  await page.keyboard.press("Enter");
  await visible(page.getByText(/Снято ещё \d+ — каждое записано отдельно/));
});

test("OS-INSP-4.3.5 Критические параметры без ответа: перечень до окна отмены, «Продолжить» — только после отметки", async () => {
  const API = `http://127.0.0.1:${P.api}`;
  const tok = (await (await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password: PASSWORD }) })).json()).token;
  const h = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  const insp = await (await fetch(`${API}/api/v1/inspections/${processId}`, { headers: h })).json();
  for (const c of insp.checks.filter((c) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING"))
    await fetch(`${API}/api/v1/checks/${c.id}/decision`, { method: "POST", headers: h, body: JSON.stringify({ action: "clarify" }) });
  const list = (await (await fetch(`${API}/api/v1/inspection/${processId}/critical-unresolved`, { headers: h })).json()).critical;
  assert.ok(list.length > 0, "в синтетическом пакете есть критические параметры без ответа");
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Критические параметры без ответа" });
  await visible(dlg);
  await visible(dlg.getByText(list[0].param_code));
  assert.equal(await page.getByRole("button", { name: "Продолжить завершение" }).isDisabled(), true);
  await page.getByRole("button", { name: "Вернуться к сверке" }).click();
  assert.equal(await dlg.isVisible(), false);
});

test("OS-INSP-4.3.4 Окно отмены финализации: «Завершить», Z — протокол остаётся черновиком", async () => {
  const API = `http://127.0.0.1:${P.api}`;
  const tok = (await (await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "inspector", password: PASSWORD }) })).json()).token;
  const h = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  const insp = await (await fetch(`${API}/api/v1/inspections/${processId}`, { headers: h })).json();
  for (const c of insp.checks.filter((c) => c.finding_status === "CANDIDATE" && c.verification_status === "PENDING"))
    await fetch(`${API}/api/v1/checks/${c.id}/decision`, { method: "POST", headers: h, body: JSON.stringify({ action: "clarify" }) });
  await page.goto(`${BASE}/#/inspections/${processId}`);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  // OS-INSP-4.3.5: если есть критические параметры без ответа — сначала их перечень (он приходит запросом — ждём
  // либо перечень, либо сразу окно отмены)
  const review = page.getByRole("dialog", { name: "Критические параметры без ответа" });
  await review.or(page.getByText(/будет завершена и передана/)).first().waitFor({ timeout: 15000 });
  if (await review.isVisible()) {
    await page.getByLabel("Перечень просмотрен").check();
    await page.getByRole("button", { name: "Продолжить завершение" }).click();
  }
  await visible(page.getByText(/будет завершена и передана/));
  await page.keyboard.press("z");
  await visible(page.getByText(/Завершение отменено/));
  await page.waitForTimeout(500);
  const st = (await (await fetch(`${API}/api/v1/inspection/${processId}/status`, { headers: h })).json()).status;
  assert.notEqual(st, "FINALIZED");
});

test("Файлы: повтор после ошибки, защита от повторного запроса и следующая страница", async () => {
  await login("inspector");
  let calls = 0;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const listUrl = /\/api\/v1\/files\?/;
  const mentionsUrl = /\/api\/v1\/files\/cleanup-fixture\/params\?/;
  await page.route(listUrl, (route) => route.fulfill({ json: {
    total: 1, items: [{ id: "cleanup-fixture", file_name: "СИНТЕТИКА — уборка.pdf", pages: 7, parse_status: "DONE", mentions: 7,
      params: [{ param_code: "M-087", name: "Синтетический параметр", in_matrix: true, mentions: 7, distinct_values: 7 }] }],
  } }));
  await page.route(mentionsUrl, async (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 503, json: { message: "Синтетический сбой" } });
    if (calls === 2) await paused;
    const query = new URL(route.request().url()).searchParams;
    const offset = Number(query.get("offset"));
    const count = Math.min(Number(query.get("limit")), 7 - offset);
    await route.fulfill({ json: { total: 7, items: Array.from({ length: count }, (_, i) => ({ id: offset + i + 1, raw: `Значение-${offset + i + 1}`, page: offset + i + 1, line_text: "Синтетическая строка" })) } });
  });
  try {
    await page.goto(`${BASE}/#/files`);
    await page.getByText("СИНТЕТИКА — уборка.pdf").click();
    const group = page.getByText("Синтетический параметр", { exact: true });
    await group.click();
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await visible(page.getByText("Загрузка…", { exact: true }));
    await group.click();
    await group.click();
    assert.equal(calls, 2);
    release();
    await visible(page.getByText("Значение-5", { exact: true }));
    await page.getByRole("button", { name: /Показать ещё 2/ }).click();
    await visible(page.getByText("Значение-7", { exact: true }));
    assert.equal(await page.getByText(/^Значение-\d$/).count(), 7);
    assert.equal(calls, 3);
  } finally {
    release();
    await page.unroute(listUrl);
    await page.unroute(mentionsUrl);
  }
});
