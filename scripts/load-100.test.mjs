// NFR-LOAD-100 (T-075): статистика и вердикт нагрузочного прогона — без Docker и без API, только чистые функции.
import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile, summarize, toMarkdown, verdict } from "./lib/load-stats.mjs";

const ok = (endpoint, ms, status = 200) => ({ endpoint, ms, status });
const conditions = {
  date: "2026-09-27T12:00:00.000Z", host: { cpu: "Apple M4", cores: 10, ram_gb: 24 }, profile: "dev", users: 100, duration_s: 180,
  think_ms: [1000, 3000], revision: "abc1234", db: "PostgreSQL 18 (docker)", pool_max: 10, warmup: "1 разбор через ML, 99 из кэша",
};

test("перцентили на известном ряду: 1…100 → p50 = 51, p95 = 96, p99 = 100 (как pct в bench-11)", () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // порядок не важен
  assert.equal(percentile(xs, 50), 51);
  assert.equal(percentile(xs, 95), 96);
  assert.equal(percentile(xs, 99), 100);
  assert.equal(percentile(xs, 100), 100);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 95), null);
  assert.deepEqual(xs.slice(0, 2), [100, 99], "исходный ряд не сортируется на месте");
});

test("сводка: по эндпоинтам и итого — n, перцентили, max, ошибки, 5xx, обрывы, rps", () => {
  const samples = [ok("GET /a", 10), ok("GET /a", 30), ok("GET /b", 20, 404), ok("GET /b", 40, 503), ok("GET /b", 5, 0)];
  const s = summarize(samples, { users: 100, durationS: 10 });
  assert.equal(s.users, 100);
  assert.deepEqual(Object.keys(s.endpoints), ["GET /a", "GET /b"]);
  assert.deepEqual(s.endpoints["GET /a"], { n: 2, p50: 30, p95: 30, p99: 30, max: 30, errors: 0, error_rate: 0, s5xx: 0, failed: 0, rps: 0.2 });
  const b = s.endpoints["GET /b"];
  assert.deepEqual([b.n, b.errors, b.s5xx, b.failed, b.max], [3, 3, 1, 1, 40]);
  assert.equal(s.total.n, 5);
  assert.equal(s.total.rps, 0.5);
  assert.equal(s.total.error_rate, 3 / 5);
});

test("вердикт: быстрые ответы без 5xx у 100 пользователей — выполнено", () => {
  const s = summarize(Array.from({ length: 200 }, (_, i) => ok("GET /a", i % 100)), { users: 100, durationS: 60 });
  const v = verdict(s, { p95Ms: 200, users: 100 });
  assert.equal(v.ok, true, v.reasons.join("; "));
  assert.deepEqual(v.reasons, []);
});

test("вердикт: один ответ 5xx валит прогон, даже если p95 в норме", () => {
  const samples = Array.from({ length: 1000 }, () => ok("GET /a", 10));
  samples.push(ok("POST /b", 12, 500));
  const v = verdict(summarize(samples, { users: 100, durationS: 60 }));
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(";"), /5xx: 1/);
});

test("вердикт: запрос без ответа (status 0) валит прогон", () => {
  const v = verdict(summarize([ok("GET /a", 10), ok("GET /a", 10, 0)], { users: 100, durationS: 60 }));
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(";"), /без ответа: 1/);
});

test("вердикт: p95 выше порога валит прогон; ровно на пороге — нет", () => {
  const slow = verdict(summarize(Array.from({ length: 100 }, (_, i) => ok("GET /a", i < 90 ? 50 : 201)), { users: 100, durationS: 60 }));
  assert.equal(slow.ok, false);
  assert.match(slow.reasons.join(";"), /p95 201 мс > 200 мс/);
  const edge = verdict(summarize(Array.from({ length: 100 }, (_, i) => ok("GET /a", i < 90 ? 50 : 200)), { users: 100, durationS: 60 }));
  assert.equal(edge.ok, true);
});

test("вердикт: меньше 100 одновременных пользователей валит прогон", () => {
  const v = verdict(summarize([ok("GET /a", 10)], { users: 99, durationS: 60 }), { p95Ms: 200, users: 100 });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(";"), /99 < 100/);
});

test("вердикт: пустой прогон не выполнен", () => {
  assert.equal(verdict(summarize([], { users: 100, durationS: 60 })).ok, false);
});

test("markdown: вердикт одной строкой сверху, таблица по эндпоинтам, условия и оговорка", () => {
  const summary = summarize([ok("GET /api/v1/inspections", 12.34), ok("POST /api/v1/checks/:id/decision", 40)], { users: 100, durationS: 180 });
  const good = toMarkdown({ summary, verdict: verdict(summary), conditions });
  const body = good.split("\n---\n")[1].trim().split("\n");
  assert.match(body[0], /^# /);
  assert.match(body.find((l) => l.trim() && !l.startsWith("#")), /^\*\*Вердикт: ✅ выполнено\*\*/, "вердикт — первая строка после заголовка");
  assert.match(good, /\| `GET \/api\/v1\/inspections` \| 1 \|/);
  assert.match(good, /\| `POST \/api\/v1\/checks\/:id\/decision` \| 1 \|/);
  assert.match(good, /\| \*\*итого\*\* \| 2 \|/);
  for (const re of [/Apple M4, 10 ядер, 24 ГБ/, /Профиль: dev/, /100 учёток/, /180 с/, /1000–3000 мс/, /`abc1234`/, /не прод/]) assert.match(good, re);
  const bad = toMarkdown({ summary, verdict: verdict(summary, { p95Ms: 1, users: 100 }), conditions });
  assert.match(bad, /\*\*Вердикт: ❌ не выполнено\*\* — p95 40 мс > 1 мс\./);
});
