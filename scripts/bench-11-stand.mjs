// Замер §11 ТЗ на живом стенде (OS-INSP-6.5.5, 6.5.11; T-135): PostgreSQL, TLS, прокси web — как у эксплуатации.
//   node scripts/bench-11-stand.mjs <process_id> [запросов=1000] [параллельно=10]
// Меряет на проверке, уже загруженной на стенд (реальный пакет — вне git, ADR-0002):
//   TZA-11-04 — пересчёт всех параметров Матрицы (версия правил сброшена → recompute по 132, без повторного разбора);
//   TZA-11-05 — протокол JSON и PDF (выгрузка через API, PDF рендерит ML);
//   TZA-11-10 — отклик API p50 / p95 / p99 (карточка проверки, статус, Матрица, справочники).
// Пароль демо-учётки — из var/stand/secrets/demo_password, никуда не выводится. Сброс версии правил — одна строка в базе
// стенда (docker exec psql): это стенд, не эксплуатация. Итог — var/bench-11-stand.json и таблица в stdout.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Agent, request } from "node:https";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const [id, nArg, cArg] = process.argv.slice(2);
if (!id) { console.error("использование: node scripts/bench-11-stand.mjs <process_id> [запросов] [параллельно]"); process.exit(2); }
const N = Number(nArg ?? 1000), C = Number(cArg ?? 10);
// BENCH_RPS — темп запросов в секунду. На стенде /api/ под limit_req nginx (20 r/s с адреса, burst 100, T-138): без темпа
// замер упирается в 429 и меряет ограничитель, а не API. p95 §11 считается при допустимой нагрузке (по умолчанию 18 r/s).
const RPS = Number(process.env.BENCH_RPS ?? "18");
const LIMIT = { recompute_s: 120, protocol_json_s: 30, protocol_pdf_s: 30, p95_ms: 200 };
const agent = new Agent({ ca: readFileSync(join(root, "var/stand/tls/ca.crt")), keepAlive: true, maxSockets: C });

function call(method, path, body) {
  return new Promise((ok, bad) => {
    const t0 = performance.now();
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = request({ host: "127.0.0.1", port: 45843, method, path, agent, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, body: Buffer.concat(chunks), ms: performance.now() - t0 }));
    });
    req.on("error", bad);
    if (data) req.write(data);
    req.end();
  });
}
let token = "";
const password = readFileSync(join(root, "var/stand/secrets/demo_password"), "utf8").trim();
token = JSON.parse((await call("POST", "/api/v1/auth/login", { login: "inspector", password })).body).token;
// последняя строка вывода: psql печатает и «SET» от search_path
const psql = (sql) => execFileSync("docker", ["exec", "-i", "inspector-stand-postgres-1", "sh", "-c", 'psql -U "$POSTGRES_USER" -d inspector -At'], { input: `set search_path=inspector; ${sql}` }).toString().trim().split("\n").pop();

const out = { process_id: id, at: new Date().toISOString(), revision: readFileSync(join(root, "var/stand/revision"), "utf8").trim(), limits: LIMIT };

// TZA-11-04: пересчёт всех параметров — версия правил сброшена, файлов на разбор нет → recompute по всей Матрице
psql(`update inspections set rules_version = null where id = '${id}';`);
const rc = await call("POST", `/api/v1/inspection/${id}/start`, {});
out.recompute = { s: +(rc.ms / 1000).toFixed(2), status: rc.status, body: rc.body.toString().slice(0, 80), checks: Number(psql(`select count(*) from checks where inspection_id = '${id}';`)) };

// TZA-11-05: протокол JSON и PDF
const js = await call("GET", `/api/v1/inspection/${id}/protocol/export?format=json`);
const pdf = await call("GET", `/api/v1/inspection/${id}/protocol/export?format=pdf`);
out.protocol = { json_s: +(js.ms / 1000).toFixed(3), json_bytes: js.body.length, json_status: js.status, pdf_s: +(pdf.ms / 1000).toFixed(3), pdf_bytes: pdf.body.length, pdf_status: pdf.status };

// TZA-11-10: отклик API — N запросов по C параллельно
const urls = [`/api/v1/inspections/${id}`, `/api/v1/inspection/${id}/status`, "/api/v1/params", "/api/v1/dictionaries"];
const times = [];
let errors = 0;
const codes = {};
const t0 = performance.now();
for (let i = 0; i < N; i += C) {
  const due = t0 + (i / RPS) * 1000;
  if (RPS > 0 && performance.now() < due) await new Promise((ok) => setTimeout(ok, due - performance.now()));
  const batch = await Promise.all(Array.from({ length: Math.min(C, N - i) }, (_, k) => call("GET", urls[(i + k) % urls.length])));
  for (const r of batch) { times.push(r.ms); codes[r.status] = (codes[r.status] ?? 0) + 1; if (r.status !== 200) errors++; }
}
times.sort((a, b) => a - b);
const q = (p) => +times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(1);
out.api = { n: times.length, concurrency: C, rps: RPS, codes, errors, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99) };

out.verdict = {
  "TZA-11-04": out.recompute.status === 200 && out.recompute.s <= LIMIT.recompute_s,
  "TZA-11-05": out.protocol.json_status === 200 && out.protocol.pdf_status === 200 && out.protocol.json_s <= LIMIT.protocol_json_s && out.protocol.pdf_s <= LIMIT.protocol_pdf_s,
  "TZA-11-10": errors === 0 && out.api.p95_ms <= LIMIT.p95_ms,
};
mkdirSync(join(root, "var"), { recursive: true });
writeFileSync(join(root, "var/bench-11-stand.json"), JSON.stringify(out, null, 2));
console.log(`§11 на стенде (${out.revision.slice(0, 7)}), проверка ${id}`);
console.log(`  TZA-11-04 пересчёт ${out.recompute.checks} параметров: ${out.recompute.s} с (предел 120 с) ${out.verdict["TZA-11-04"] ? "✅" : "❌"}`);
console.log(`  TZA-11-05 протокол JSON ${out.protocol.json_s} с · PDF ${out.protocol.pdf_s} с (предел 30 с) ${out.verdict["TZA-11-05"] ? "✅" : "❌"}`);
console.log(`  TZA-11-10 API p50 ${out.api.p50_ms} мс · p95 ${out.api.p95_ms} мс · p99 ${out.api.p99_ms} мс, ${out.api.n} запросов по ${C}, ошибок ${errors} ${JSON.stringify(codes)}, темп ${RPS} r/s (предел p95 200 мс) ${out.verdict["TZA-11-10"] ? "✅" : "❌"}`);
agent.destroy();
process.exit(Object.values(out.verdict).every(Boolean) ? 0 : 1);
