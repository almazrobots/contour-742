// NFR-LOAD-100 (T-075, ТЗ 11-10, 11-11): статистика нагрузочного прогона — чистые функции без IO.
// Выборка — { endpoint, ms, status }; status 0 — ответа нет вовсе (обрыв, отказ соединения), считается отказом наравне с 5xx.
// Прогон — scripts/load-100.mjs, тесты — scripts/load-100.test.mjs.

/** Перцентиль тем же способом, что pct в bench-11.mjs: элемент отсортированного ряда с индексом ⌊p/100·n⌋. Пусто — null. */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

function stats(list, durationS) {
  const ms = list.map((s) => s.ms);
  const s5xx = list.filter((s) => s.status >= 500).length;
  const failed = list.filter((s) => !s.status).length;
  const errors = list.filter((s) => !s.status || s.status >= 400).length;
  return {
    n: list.length,
    p50: r1(percentile(ms, 50)), p95: r1(percentile(ms, 95)), p99: r1(percentile(ms, 99)),
    max: list.length ? r1(ms.reduce((a, b) => Math.max(a, b), -Infinity)) : null,
    errors, error_rate: list.length ? errors / list.length : 0, s5xx, failed,
    rps: durationS > 0 ? Math.round((list.length / durationS) * 10) / 10 : null,
  };
}

/**
 * Сводка по эндпоинтам и итого. users — сколько виртуальных инспекторов реально работало, durationS — длительность
 * фазы нагрузки (для rps). Эндпоинт — шаблон пути («GET /api/v1/inspections/:id»), а не конкретный адрес.
 */
export function summarize(samples, { users = 0, durationS = 0 } = {}) {
  const by = new Map();
  for (const s of samples) {
    if (!by.has(s.endpoint)) by.set(s.endpoint, []);
    by.get(s.endpoint).push(s);
  }
  const endpoints = Object.fromEntries([...by.keys()].sort().map((k) => [k, stats(by.get(k), durationS)]));
  return { users, duration_s: durationS, endpoints, total: stats(samples, durationS) };
}

/** Вердикт NFR-LOAD-100: не меньше users пользователей, ни одного 5xx и обрыва, p95 по всем запросам ≤ p95Ms. */
export function verdict(summary, { p95Ms = 200, users = 100 } = {}) {
  const reasons = [];
  const t = summary.total;
  if (summary.users < users) reasons.push(`одновременных инспекторов ${summary.users} < ${users}`);
  if (!t.n) reasons.push("нет ни одного запроса");
  if (t.s5xx > 0) reasons.push(`ответов 5xx: ${t.s5xx}`);
  if (t.failed > 0) reasons.push(`запросов без ответа: ${t.failed}`);
  if (t.p95 !== null && t.p95 > p95Ms) reasons.push(`p95 ${t.p95} мс > ${p95Ms} мс`);
  return { ok: reasons.length === 0, reasons, limits: { p95_ms: p95Ms, users } };
}

const num = (x) => (x === null || x === undefined ? "—" : String(x).replace(".", ","));
const pctStr = (x) => `${(x * 100).toFixed(2).replace(".", ",")} %`;

/**
 * Отчёт docs/qa/LOAD-100.md. result = { summary, verdict, conditions: { date, host, profile, users, duration_s,
 * think_ms: [min, max], revision, db, pool_max, warmup } }.
 */
export function toMarkdown({ summary, verdict: v, conditions: c }) {
  const line = v.ok
    ? `**Вердикт: ✅ выполнено** — ${summary.users} одновременных инспекторов, 5xx нет, p95 ${num(summary.total.p95)} мс ≤ ${v.limits.p95_ms} мс.`
    : `**Вердикт: ❌ не выполнено** — ${v.reasons.join("; ")}.`;
  const row = (name, s) => `| ${name} | ${s.n} | ${num(s.rps)} | ${num(s.p50)} | ${num(s.p95)} | ${num(s.p99)} | ${num(s.max)} | ${pctStr(s.error_rate)} | ${s.s5xx} |`;
  return `---
id: QA-LOAD-100
title: "NFR-LOAD-100 — 100 одновременных инспекторов (ТЗ 11-10, 11-11)"
type: qa-report
status: draft
owner: "@almaz"
created: ${c.date.slice(0, 10)}
traces_to: [NFR-LOAD-100]
tags: [qa, performance, load]
---

# 100 одновременных инспекторов — нагрузочный прогон

${line}

Критерий (ТЗ 11-11, 11-10): не менее ${v.limits.users} одновременных инспекторов, ни одного ответа 5xx, p95 ответа API ≤ ${v.limits.p95_ms} мс.
Сгенерировано \`node scripts/load-100.mjs\` ${c.date}; сырые данные — \`var/load-100.json\`.

| Эндпоинт | n | rps | p50, мс | p95, мс | p99, мс | max, мс | ошибки | 5xx |
|---|---|---|---|---|---|---|---|---|
${Object.entries(summary.endpoints).map(([k, s]) => row(`\`${k}\``, s)).join("\n")}
${row("**итого**", summary.total)}

## Условия

- Железо: ${c.host.cpu}, ${c.host.cores} ядер, ${c.host.ram_gb} ГБ ОЗУ.
- Профиль: ${c.profile}; база — ${c.db}, пул API ${c.pool_max} соединений; ML — uvicorn из \`ml/.venv\`, кэш по SHA-256.
- Пользователи: ${c.users} учёток роли inspector, у каждого своя проверка (${c.warmup}).
- Сценарий каждого инспектора по кругу: дашборд → статус своей проверки → карточка проверки с кандидатами → доказательства
  кандидата → решение (подтвердить или отклонить с reason_code; нет ожидающих — снятие решения), пауза ${c.think_ms[0]}–${c.think_ms[1]} мс.
- Длительность нагрузки: ${c.duration_s} с; ревизия git: \`${c.revision}\`.

## Оговорка

Хост ${c.host.name ?? c.host.cpu} (${c.host.cpu}), профиль dev: API, PostgreSQL в docker и сам генератор нагрузки — на одном
хосте и делят ядра${c.host.ml ? `; ML для подготовки — ${c.host.ml}` : ", ML — там же"}. Это не прод и не профиль gpu (нет TLS до API и базы, нет RabbitMQ и clamd, нет сети между машинами). Прогон
показывает, что код и схема держат 100 одновременных сессий; итоговая цифра — на стенде профиля gpu.
`;
}
