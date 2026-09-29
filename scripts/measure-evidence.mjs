// Замер механик скорости (T-111 плана карты сценариев): время до доказательства на листе и цикл решений клавишами.
// Робот, а не человек: цифры — нижняя граница интерфейсной задержки, приёмка ТЗ 9.3.6 — на 5 инспекторах (T-077).
//   node scripts/measure-evidence.mjs <web> <api> <process_id>   (пароль демо-учёток — в INSPECTOR_DEMO_PASSWORD)
import { chromium } from "playwright";

const [web, api, pid] = process.argv.slice(2);
const password = process.env.INSPECTOR_DEMO_PASSWORD;
if (!web || !api || !pid || !password) {
  console.error("usage: INSPECTOR_DEMO_PASSWORD=… node scripts/measure-evidence.mjs <web> <api> <process_id>");
  process.exit(2);
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`${web}/#/login`);
await page.fill("#login", "inspector");
await page.fill("#password", password);
await page.getByRole("button", { name: "Войти" }).click();
await page.waitForURL(/#\/inspections/);

await page.goto(`${web}/#/inspections/${pid}/verify`);
const hl = page.locator(".viewer .hl:not(.req)").first();
await hl.waitFor({ timeout: 30_000 });
const items = await page.locator(".queue .item").count();

// 1. время до доказательства: J → первая рамка доказательства нового кандидата на листе
const tte = [];
for (let i = 1; i < items; i++) {
  const old = await hl.elementHandle();
  const t0 = Date.now();
  await page.keyboard.press("j");
  await page.waitForFunction((el) => !el.isConnected, old, { timeout: 30_000 });
  await hl.waitFor({ timeout: 30_000 });
  tte.push(Date.now() - t0);
}

// 2. цикл решений клавишей «уточнить» (3) по всей очереди: интерфейсная задержка на решение
await page.goto(`${web}/#/inspections/${pid}/verify`);
await hl.waitFor({ timeout: 30_000 });
const openPill = page.locator(".topbar .pill.amber");
const pending = async () => ((await openPill.count()) ? Number((await openPill.textContent()).match(/\d+/)[0]) : 0);
const perDecision = [];
const t0 = Date.now();
let left = await pending();
while (left > 0) {
  const t = Date.now();
  await page.keyboard.press("3");
  await page.waitForFunction((n) => { const p = document.querySelector(".topbar .pill.amber"); return !p || Number(p.textContent.match(/\d+/)[0]) < n; }, left, { timeout: 30_000 });
  perDecision.push(Date.now() - t);
  left = await pending();
}
const cycleMs = Date.now() - t0;

const tok = (await (await fetch(`${api}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "supervisor", password }) })).json()).token;
const rep = await (await fetch(`${api}/api/v1/usability/verification-report`, { headers: { authorization: `Bearer ${tok}` } })).json();

console.log(JSON.stringify({
  process_id: pid,
  candidates: items,
  time_to_evidence_ms: { n: tte.length, p50: pct(tte, 50), p95: pct(tte, 95), max: tte.length ? Math.max(...tte) : null },
  decision_latency_ms: { n: perDecision.length, p50: pct(perDecision, 50), p95: pct(perDecision, 95) },
  robot_cycle_s: Math.round(cycleMs / 100) / 10,
  actions_per_decision: rep.actions ?? "нет в отчёте (сборка без счётчика действий)",
}, null, 1));
await browser.close();
