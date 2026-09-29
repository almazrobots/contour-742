#!/usr/bin/env node
// NFR-SLA (ТЗ 11-12, TZA-11-12): отчёт о доступности 99,9 % за скользящие 30 дней из API Prometheus стенда.
// Формулы — apps/api/src/domain/slo.ts (Node снимает типы сам), своих формул здесь нет.
//
//   PROMETHEUS_URL=https://prometheus.стенд:9090 [PROMETHEUS_CA=ca.crt] node scripts/availability-report.mjs [выход.md]
//
// Выход по умолчанию — docs/qa/AVAILABILITY.md. Скрипт переписывает только блок между метками
// <!-- availability-report:begin/end -->; остальное (например, раздел «Обкатка») остаётся как было.
// Код выхода: 0 — цель выполнена или данных нет, 2 — нарушена, 1 — Prometheus недоступен.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { availability, budgetRemaining, errorBudget, PROBE_INTERVAL_SECONDS, SLO_TARGET, SLO_WINDOW_SECONDS, verdict } from "../apps/api/src/domain/slo.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BEGIN = "<!-- availability-report:begin -->";
export const END = "<!-- availability-report:end -->";

/** Запросы к Prometheus: сырые счётчики за 30 дней, а не готовые доли — «нет данных» отличается от «100 %». */
export const QUERIES = {
  probeGood: 'sum by (instance) (sum_over_time(probe_success{job="blackbox"}[30d]))',
  probeTotal: 'sum by (instance) (count_over_time(probe_success{job="blackbox"}[30d]))',
  apiErrors: 'sum(increase(inspector_http_errors_5xx_total{job="inspector-api"}[30d]))',
  apiRequests: 'sum(increase(inspector_http_requests_total{job="inspector-api"}[30d]))',
};

/** GET /api/v1/query → [{metric, value:number}]. Ошибка API или сети — исключение. */
export function promQuery(base, query, { ca } = {}) {
  // относительный путь: префикс Prometheus за обратным прокси (https://стенд/prom) не теряется
  const url = new URL("api/v1/query", base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("query", query);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((ok, fail) => {
    const req = mod.get(url, { ca, timeout: 30_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode !== 200 || j.status !== "success") throw new Error(`Prometheus ${res.statusCode}: ${j.error ?? body.slice(0, 200)}`);
          ok(j.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) })));
        } catch (e) {
          fail(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Prometheus не ответил за 30 с")));
    req.on("error", fail);
  });
}

/** Собрать счётчики из Prometheus. */
export async function collect(base, opts = {}) {
  const [good, total, errors, requests] = await Promise.all(Object.values(QUERIES).map((q) => promQuery(base, q, opts)));
  const goodBy = new Map(good.map((r) => [r.metric.instance, r.value]));
  return {
    probes: total.map((r) => ({ instance: r.metric.instance, good: goodBy.get(r.metric.instance) ?? 0, total: r.value })).sort((a, b) => a.instance.localeCompare(b.instance)),
    api: { errors: errors[0]?.value ?? 0, requests: requests[0]?.value ?? 0 },
  };
}

/** Чистый расчёт: доступность, остаток бюджета, вердикт по каждому показателю и общий — по худшему. */
export function summarize(data, target = SLO_TARGET) {
  // минуты отказа — только у проб: одна проба = PROBE_INTERVAL_SECONDS наблюдения; у запросов API времени нет
  const row = (name, good, total, probe) => {
    const a = availability(good, total);
    return { name, good, total, availability: a, remaining: budgetRemaining(a, target), downMinutes: probe ? ((total - good) * PROBE_INTERVAL_SECONDS) / 60 : null, verdict: verdict(a, target) };
  };
  const rows = data.probes.map((p) => row(`проба ${p.instance}`, p.good, p.total, true));
  const req = Math.round(data.api.requests);
  rows.push(row("ответы API без 5xx", Math.max(0, req - Math.round(data.api.errors)), req, false));
  // сколько окна реально измерено: молодой стенд с часом данных не равен 30 дням наблюдения
  const coveredHours = data.probes.length ? (Math.max(...data.probes.map((p) => p.total)) * PROBE_INTERVAL_SECONDS) / 3600 : 0;
  const measured = rows.filter((r) => r.availability !== null);
  const worst = measured.length ? measured.reduce((a, b) => (b.availability < a.availability ? b : a)) : null;
  return { target, coveredHours, budgetMinutes: errorBudget(target, SLO_WINDOW_SECONDS) / 60, rows, overall: worst ? worst.verdict : verdict(null, target), worst: worst?.name ?? null };
}

const pct = (x, d = 3) => (x === null ? "—" : `${(x * 100).toFixed(d).replace(".", ",")} %`);
const num = (x, d = 1) => (x === null ? "—" : x.toFixed(d).replace(".", ","));

/** Блок отчёта в Markdown (между метками). */
export function renderBlock(s, { source, at }) {
  const lines = [
    BEGIN,
    `## Доступность за 30 дней — ${s.overall.text}`,
    "",
    `- Цель: не менее ${pct(s.target, 1)} за скользящие 30 дней; бюджет ошибок ${num(s.budgetMinutes)} мин.`,
    `- Измерено ${num(s.coveredHours)} ч из ${num(SLO_WINDOW_SECONDS / 3600, 0)} ч окна${s.coveredHours * 3600 < SLO_WINDOW_SECONDS * 0.99 ? " — окно заполнено не целиком, доля считается по измеренному" : ""}.`,
    `- Источник: API Prometheus \`${source}\`, снято ${at}.`,
    `- Итог — по худшему показателю${s.worst ? `: ${s.worst}` : ""}.`,
    "",
    "| Показатель | Успешных | Всего | Доступность | Минут отказа | Остаток бюджета | Вердикт |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...s.rows.map((r) => `| ${r.name} | ${Math.round(r.good)} | ${Math.round(r.total)} | ${pct(r.availability)} | ${num(r.downMinutes)} | ${pct(r.remaining, 1)} | ${r.verdict.text} |`),
    "",
    "Формулы — `apps/api/src/domain/slo.ts`: доступность = успешных / всего (нет измерений — «нет данных», а не 100 %); остаток = 1 − (1 − доступность) / (1 − цель). Для проб «всего» — число проб за окно (раз в 15 с), для API — запросы по счётчику `inspector_http_requests_total`.",
    END,
  ];
  return lines.join("\n");
}

const FRONTMATTER = (date) => `---
id: QA-AVAILABILITY
title: "Доступность 99,9 % — отчёт по данным Prometheus"
type: qa-report
status: draft
owner: "@almaz"
created: ${date}
traces_to: [NFR-SLA]
tags: [qa, sla, availability]
---

# Доступность 99,9 % (ТЗ 11-12)

Отчёт собирает \`scripts/availability-report.mjs\` из API Prometheus стенда. Блок ниже переписывается при каждом запуске.
`;

/** Вставить блок в документ: заменить старый между метками или дописать после шапки. */
export function mergeInto(existing, block, date) {
  if (!existing) return `${FRONTMATTER(date)}\n${block}\n`;
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b >= 0 && e > b) return existing.slice(0, b) + block + existing.slice(e + END.length);
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** Адрес для отчёта — без логина, пароля и параметров: отчёт уходит в git. */
export function publicUrl(base) {
  const u = new URL(base);
  u.username = "";
  u.password = "";
  u.search = "";
  return u.href.replace(/\/$/, "");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const base = env.PROMETHEUS_URL;
  if (!base) throw new Error("PROMETHEUS_URL не задан");
  const out = argv[0] ?? join(root, "docs/qa/AVAILABILITY.md");
  const ca = env.PROMETHEUS_CA ? readFileSync(env.PROMETHEUS_CA) : undefined;
  const now = new Date();
  const s = summarize(await collect(base, { ca }));
  const block = renderBlock(s, { source: publicUrl(base), at: now.toISOString().replace(/\.\d+Z$/, "Z") });
  writeFileSync(out, mergeInto(existsSync(out) ? readFileSync(out, "utf8") : "", block, now.toISOString().slice(0, 10)));
  return { summary: s, out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    ({ summary, out }) => {
      console.log(`${out}: ${summary.overall.text}${summary.worst ? ` (худший: ${summary.worst})` : ""}`);
      process.exitCode = summary.overall.status === "breached" ? 2 : 0;
    },
    (e) => {
      console.error(`отчёт о доступности: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
