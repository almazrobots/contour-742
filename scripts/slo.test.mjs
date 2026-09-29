// NFR-SLA (ТЗ 11-12, TZA-11-12): доступность 99,9 % — проба blackbox, правила записи и алерты сгорания бюджета,
// дашборд, отчёт. Эшелоны: L1 (статическая сверка конфигов с domain/slo.ts — единый источник чисел), L2 (отчёт против
// поддельного Prometheus), L4 (promtool test rules: авария, медленное сгорание, норма — в образе Prometheus по digest).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { BURN_ALERTS, PROBE_INTERVAL_SECONDS, SLO_TARGET, SLO_WINDOW_SECONDS, errorBudget } from "../apps/api/src/domain/slo.ts";
import { BEGIN, END, QUERIES, main, mergeInto, publicUrl, summarize } from "./availability-report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "deploy/gpu");
const read = (f) => readFileSync(join(dir, f), "utf8");
const compose = parse(read("compose.yml"), { merge: true });
const prom = parse(read("prometheus.yml"));
const blackbox = parse(read("blackbox.yml"));
const slo = parse(read("rules/slo.yml"));
const rules = slo.groups.flatMap((g) => g.rules);
const alert = (name) => rules.find((r) => r.alert === name);
const exported = new Set([...readFileSync(join(root, "apps/api/src/app.ts"), "utf8").matchAll(/# TYPE ([a-z_0-9]+) /g)].map((m) => m[1]));
const WINDOWS = ["5m", "30m", "1h", "6h", "1d", "30d"];
const env = read(".env.example");
const image = (name) => env.match(new RegExp(`^${name}=(\\S+)`, "m"))?.[1];

test("проба: задача blackbox снимает /ready API и страницу web по https через blackbox-exporter:9115", () => {
  assert.equal(prom.scrape_configs[0].job_name, "inspector-api", "задача API остаётся первой");
  assert.equal(prom.global.scrape_interval, `${PROBE_INTERVAL_SECONDS}s`, "период пробы = PROBE_INTERVAL_SECONDS (минуты отказа в отчёте)");
  const job = prom.scrape_configs.find((j) => j.job_name === "blackbox");
  assert.ok(job, "задачи blackbox нет");
  assert.equal(job.metrics_path, "/probe");
  const targets = Object.fromEntries(job.static_configs.flatMap((c) => c.targets.map((t) => [t, c.labels?.module])));
  assert.deepEqual(targets, { "https://api:8810/ready": "http_ready", "https://web:8443/": "http_web" });
  const rl = job.relabel_configs;
  assert.ok(rl.some((r) => r.source_labels?.[0] === "__address__" && r.target_label === "__param_target"), "адрес цели → параметр target");
  assert.ok(rl.some((r) => r.source_labels?.[0] === "module" && r.target_label === "__param_module"), "модуль — из метки module");
  assert.ok(rl.some((r) => r.source_labels?.[0] === "__param_target" && r.target_label === "instance"), "instance — адрес цели, а не экспортёра");
  assert.ok(rl.some((r) => r.target_label === "__address__" && r.replacement === "blackbox-exporter:9115"), "снимается экспортёр");
  for (const m of Object.values(targets)) assert.ok(blackbox.modules[m], `модуля ${m} нет в blackbox.yml`);
  assert.ok(prom.rule_files.includes("/etc/prometheus/rules/slo.yml"), "правила SLO подключены");
  assert.ok(compose.services.prometheus.volumes.includes("./rules:/etc/prometheus/rules:ro"), "каталог правил смонтирован только на чтение");
});

test("проба: модули — только https, TLS 1.3, сертификат по CA стенда, успех — ровно 200; /ready — тело ready", () => {
  const bb = compose.services["blackbox-exporter"];
  for (const [name, m] of Object.entries(blackbox.modules)) {
    assert.equal(m.prober, "http", name);
    assert.deepEqual(m.http.valid_status_codes, [200], name);
    assert.equal(m.http.fail_if_not_ssl, true, name);
    assert.equal(m.http.tls_config.min_version, "TLS13", name);
    assert.equal(m.http.tls_config.insecure_skip_verify, undefined, `${name}: проверка сертификата не отключается`);
    assert.ok(bb.volumes.some((v) => v.startsWith("${TLS_DIR:?}/") && v.split(" ")[0].endsWith(`:${m.http.tls_config.ca_file}:ro`)), `${name}: ca_file смонтирован из TLS_DIR`);
    assert.ok(m.http.tls_config.server_name, `${name}: имя для проверки сертификата`);
  }
  assert.deepEqual(blackbox.modules.http_ready.http.fail_if_body_not_matches_regexp, ['"status":"ready"']);
});

test("blackbox-exporter в compose: по digest, uid nobody, read_only, cap_drop ALL, конфиг ro, без ключей и портов", () => {
  const bb = compose.services["blackbox-exporter"];
  assert.match(bb.image, /^\$\{BLACKBOX_IMAGE:\?/);
  assert.match(image("BLACKBOX_IMAGE"), /^prom\/blackbox-exporter:v[\d.]+@sha256:[0-9a-f]{64}$/);
  assert.equal(bb.user, "65534:65534");
  assert.equal(bb.read_only, true);
  assert.deepEqual(bb.cap_drop, ["ALL"]);
  assert.equal(bb.cap_add, undefined, "ICMP не нужен — без NET_RAW");
  assert.ok(bb.security_opt.includes("no-new-privileges:true"));
  assert.equal(bb.ports, undefined, "наружу не публикуется");
  assert.ok(bb.volumes.includes("./blackbox.yml:/etc/blackbox/blackbox.yml:ro"));
  assert.ok(!bb.volumes.some((v) => /\.key|:\/run\/tls:ro/.test(v)), "ключи TLS экспортёру не нужны");
  assert.ok(bb.command.includes("--config.file=/etc/blackbox/blackbox.yml"));
  assert.ok(compose.services.prometheus.depends_on.includes("blackbox-exporter"));
});

test("правила записи: доля успешных проб и доля 5xx за 5m, 30m, 1h, 6h, 1d, 30d; окно в имени = окно в выражении", () => {
  for (const [sli, metric] of [["probe_success", /avg_over_time\(probe_success\{job="blackbox"\}\[(\w+)\]\)/], ["api_errors", /rate\(inspector_http_errors_5xx_total\{[^}]*\}\[(\w+)\]\) \/ rate\(inspector_http_requests_total\{[^}]*\}\[(\w+)\]\)/]]) {
    for (const w of WINDOWS) {
      const r = rules.find((x) => x.record === `slo:${sli}:ratio_rate${w}`);
      assert.ok(r, `нет slo:${sli}:ratio_rate${w}`);
      const m = metric.exec(r.expr);
      assert.ok(m, `${r.record}: ${r.expr}`);
      for (const got of m.slice(1)) assert.equal(got, w, `${r.record}: окно ${got}`);
    }
  }
  for (const r of rules) for (const [, n] of (r.expr ?? "").matchAll(/\b(inspector_[a-z_0-9]+)/g)) assert.ok(exported.has(n), `${r.record ?? r.alert}: метрики ${n} нет в /metrics`);
});

test("алерты сгорания: множители, окна, for и severity — те же, что BURN_ALERTS и SLO_TARGET в domain/slo.ts", () => {
  const budget = `(1 - ${SLO_TARGET})`;
  for (const b of BURN_ALERTS) {
    const r = alert(b.alert);
    assert.ok(r, `нет алерта ${b.alert}`);
    assert.equal(r.labels.severity, b.severity, b.alert);
    assert.equal(r.for, b.for, b.alert);
    const thresholds = [...r.expr.matchAll(/> \(([\d.]+) \* \(1 - ([\d.]+)\)\)/g)];
    assert.equal(thresholds.length, 4, `${b.alert}: два окна на каждый из двух показателей`);
    for (const [, f, t] of thresholds) assert.deepEqual([Number(f), Number(t)], [b.factor, SLO_TARGET], b.alert);
    for (const sli of ["probe_success", "api_errors"]) for (const w of [b.long, b.short]) assert.ok(r.expr.includes(`slo:${sli}:ratio_rate${w}`), `${b.alert}: нет окна ${w} для ${sli}`);
    assert.ok(r.annotations.summary && /[а-я]/.test(r.annotations.summary), `${b.alert}: аннотация по-русски`);
    assert.ok(r.expr.includes(budget), b.alert);
  }
  const ex = alert("InspectorSloBudgetExhausted");
  assert.deepEqual([...ex.expr.matchAll(/< ([\d.]+)/g)].map((m) => Number(m[1])), [SLO_TARGET, SLO_TARGET]);
  assert.match(ex.expr, /slo:probe_success:ratio_rate30d/);
  assert.match(ex.expr, /slo:api_errors:ratio_rate30d/);
  const down = alert("InspectorProbeDown");
  assert.equal(down.expr, 'probe_success{job="blackbox"} == 0');
  assert.equal(down.for, "2m");
  assert.equal(down.labels.severity, "page");
  for (const r of rules.filter((x) => x.alert)) assert.match(r.annotations.description, /[а-я]/, `${r.alert}: описание по-русски`);
});

test("Alertmanager: severity page и ticket маршрутизируются к получателю с почтой и Telegram", () => {
  const cfg = parse(read("alertmanager/alertmanager.example.yml"));
  const recv = Object.fromEntries(cfg.receivers.map((r) => [r.name, r]));
  for (const sev of ["page", "ticket"]) {
    const route = cfg.route.routes.find((r) => r.matchers?.includes(`severity="${sev}"`));
    assert.ok(route, `нет маршрута severity=${sev}`);
    assert.ok(recv[route.receiver]?.email_configs?.length && recv[route.receiver]?.telegram_configs?.length, sev);
  }
  const used = new Set(rules.filter((r) => r.alert).map((r) => r.labels.severity));
  assert.deepEqual([...used].sort(), ["page", "ticket"]);
});

test("дашборд SLO: метрики — из правил записи и blackbox; цель, окно и пороги — из domain/slo.ts", () => {
  const dash = JSON.parse(read("grafana/dashboards/inspector-slo.json"));
  const recorded = new Set(rules.filter((r) => r.record).map((r) => r.record));
  const blackboxMetrics = new Set(["probe_success", "probe_duration_seconds"]);
  assert.ok(dash.panels.length >= 4);
  const titles = dash.panels.map((p) => p.title).join(" | ");
  for (const want of [/Доступность за 30 дней/, /Остаток бюджета/, /сгорания.*1 ч и 6 ч/]) assert.match(titles, want);
  for (const p of dash.panels) {
    assert.ok(p.targets.length, p.title);
    for (const t of p.targets) {
      const names = [...t.expr.matchAll(/\b((?:slo:[a-z_0-9:]+)|probe_[a-z_]+|inspector_[a-z_0-9]+)/g)].map((m) => m[1]);
      assert.ok(names.length, `${p.title}: нет метрики`);
      for (const n of names) assert.ok(recorded.has(n) || blackboxMetrics.has(n) || exported.has(n), `${p.title}: метрики ${n} нет ни в правилах, ни в blackbox, ни в /metrics`);
      for (const [, x] of t.expr.matchAll(/\(1 - (0\.\d+)\)/g)) assert.equal(Number(x), SLO_TARGET, `${p.title}: цель ${x}`);
      for (const [, x] of t.expr.matchAll(/\* (\d{4,})\b/g)) assert.equal(Number(x), SLO_WINDOW_SECONDS / 60, `${p.title}: окно ${x} мин`);
    }
    const steps = p.fieldConfig.defaults.thresholds?.steps?.map((s) => s.value) ?? [];
    if (p.fieldConfig.defaults.unit === "x") assert.deepEqual(steps.slice(1), BURN_ALERTS.map((b) => b.factor).reverse(), `${p.title}: пороги ×6 и ×14,4`);
    if (p.fieldConfig.defaults.unit === "m") assert.equal(steps.at(-1), Number((errorBudget(SLO_TARGET, SLO_WINDOW_SECONDS) / 60).toFixed(1)), `${p.title}: бюджет в минутах`);
  }
  const ids = dash.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "id панелей уникальны");
});

// ─── отчёт о доступности против поддельного Prometheus
async function fakePrometheus(answers, { fail = false, prefix = "" } = {}) {
  const seen = [];
  const paths = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("query");
    seen.push(q);
    paths.push(u.pathname);
    if (fail || u.pathname !== `${prefix}/api/v1/query`) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "error", error: "хранилище недоступно" }));
    }
    const key = Object.entries(QUERIES).find(([, v]) => v === q)?.[0];
    if (!key) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "error", error: `неизвестный запрос ${q}` }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: answers[key].map(([metric, v]) => ({ metric, value: [1_790_000_000, String(v)] })) } }));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, paths, close: () => new Promise((ok) => (srv.close(ok), srv.closeAllConnections())) };
}

test("отчёт: 30 дней из Prometheus → доступность, минуты отказа, остаток бюджета; блок заменяется, «Обкатка» остаётся", async () => {
  const ready = { instance: "https://api:8810/ready" };
  const web = { instance: "https://web:8443/" };
  // 172800 проб за 30 дней (раз в 15 с): /ready — 86 отказов (99,950 %), web — без отказов; API — 5 ошибок на 100 000
  const fake = await fakePrometheus({ probeGood: [[ready, 172714], [web, 172800]], probeTotal: [[ready, 172800], [web, 172800]], apiErrors: [[{}, 5]], apiRequests: [[{}, 100000]] });
  const d = mkdtempSync(join(tmpdir(), "slo-report-"));
  const out = join(d, "AVAILABILITY.md");
  writeFileSync(out, `---\nid: QA-AVAILABILITY\n---\n\n# шапка\n\n${BEGIN}\nстарый блок\n${END}\n\n## Обкатка\n\nцифры обкатки\n`);
  try {
    const { summary } = await main([out], { PROMETHEUS_URL: fake.url });
    assert.equal(fake.seen.length, 4);
    assert.equal(summary.overall.status, "met");
    assert.equal(summary.worst, "проба https://api:8810/ready");
    const md = readFileSync(out, "utf8");
    assert.doesNotMatch(md, /старый блок/);
    assert.match(md, /## Обкатка\n\nцифры обкатки/, "раздел обкатки не тронут");
    assert.match(md, /\| проба https:\/\/api:8810\/ready \| 172714 \| 172800 \| 99,950 % \| 21,5 \| 50,2 % \| выполнено \|/);
    assert.match(md, /\| ответы API без 5xx \| 99995 \| 100000 \| 99,995 % \|/);
    assert.match(md, /бюджет ошибок 43,2 мин/);
    assert.match(md, /Измерено 720,0 ч из 720 ч окна\./, "окно заполнено — без оговорки");
    assert.equal(md.split(BEGIN).length, 2, "блок один");
  } finally {
    await fake.close();
  }
});

test("отчёт: нет проб — «нет данных», а не 100 %; ниже цели — нарушено по худшему показателю", () => {
  const none = summarize({ probes: [], api: { errors: 0, requests: 0 } });
  assert.equal(none.overall.status, "no_data");
  assert.equal(none.rows[0].availability, null);
  assert.equal(none.coveredHours, 0);
  const young = summarize({ probes: [{ instance: "i", good: 230, total: 240 }], api: { errors: 0, requests: 0 } });
  assert.equal(young.coveredHours, 1, "240 проб по 15 с — 1 ч наблюдения");
  assert.equal(young.rows[0].downMinutes, 2.5, "10 проваленных проб — 2,5 мин, а не экстраполяция на 30 дней");
  assert.equal(young.rows[1].downMinutes, null, "у запросов API минут нет");
  const bad = summarize({ probes: [{ instance: "https://api:8810/ready", good: 9980, total: 10000 }, { instance: "https://web:8443/", good: 10000, total: 10000 }], api: { errors: 0, requests: 500 } });
  assert.equal(bad.overall.status, "breached");
  assert.equal(bad.worst, "проба https://api:8810/ready");
  assert.ok(Math.abs(bad.rows[0].remaining - -1) < 1e-9, "перерасход — остаток −100 %");
  assert.equal(mergeInto("", "Б", "2026-09-27").startsWith("---\nid: QA-AVAILABILITY"), true, "новый файл — с frontmatter");
  assert.match(mergeInto("# без меток\n", "Б", "2026-09-27"), /# без меток\n\nБ\n$/);
  assert.equal(publicUrl("https://user:secret@prom.example:9090/prom/?token=x"), "https://prom.example:9090/prom", "логин, пароль и параметры в отчёт (git) не попадают");
});

test("отчёт: Prometheus отвечает ошибкой — исключение, файл не пишется; без PROMETHEUS_URL — отказ", async () => {
  const fake = await fakePrometheus({}, { fail: true });
  const d = mkdtempSync(join(tmpdir(), "slo-report-"));
  try {
    await assert.rejects(main([join(d, "x.md")], { PROMETHEUS_URL: fake.url }), /Prometheus 503: хранилище недоступно/);
    assert.equal(existsSync(join(d, "x.md")), false);
  } finally {
    await fake.close();
  }
  await assert.rejects(main([join(d, "y.md")], {}), /PROMETHEUS_URL/);
});

test("отчёт: префикс пути Prometheus (за обратным прокси) сохраняется в адресе запроса", async () => {
  const fake = await fakePrometheus({ probeGood: [], probeTotal: [], apiErrors: [], apiRequests: [] }, { prefix: "/prom" });
  const d = mkdtempSync(join(tmpdir(), "slo-report-"));
  try {
    const { summary } = await main([join(d, "z.md")], { PROMETHEUS_URL: `${fake.url}/prom` });
    assert.equal(summary.overall.status, "no_data");
    assert.equal(fake.paths.every((x) => x === "/prom/api/v1/query"), true);
  } finally {
    await fake.close();
  }
});

// ─── promtool и blackbox --config.check в закреплённых образах (docker есть на маке-гейте; нет — пропуск с причиной)
const dockerOk = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
const run = (args) => execFileSync("docker", ["run", "--rm", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });

test("promtool: правила SLO валидны, модульные тесты slo.test.yml (авария, медленное сгорание, норма 99,95 %) проходят", { skip: !dockerOk && "docker недоступен — promtool не запустить (статические проверки выше прошли)" }, () => {
  const img = image("PROMETHEUS_IMAGE");
  assert.ok(run(["-v", `${dir}:/w:ro`, "-w", "/w/rules", "--entrypoint", "promtool", img, "check", "rules", "slo.yml"]).includes("SUCCESS"));
  assert.match(run(["-v", `${dir}:/w:ro`, "-w", "/w/rules", "--entrypoint", "promtool", img, "test", "rules", "slo.test.yml"]), /SUCCESS/);
  const stub = mkdtempSync(join(tmpdir(), "slo-ca-"));
  writeFileSync(join(stub, "ca.crt"), "");
  const cfg = run(["-v", `${dir}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`, "-v", `${dir}/alerts.yml:/etc/prometheus/alerts.yml:ro`, "-v", `${dir}/rules:/etc/prometheus/rules:ro`, "-v", `${stub}/ca.crt:/etc/prometheus/tls/ca.crt:ro`, "--entrypoint", "promtool", img, "check", "config", "/etc/prometheus/prometheus.yml"]);
  assert.match(cfg, /is valid prometheus config/);
});

test("blackbox-exporter: blackbox.yml принимается закреплённым образом (--config.check)", { skip: !dockerOk && "docker недоступен" }, () => {
  const r = spawnSync("docker", ["run", "--rm", "-v", `${dir}/blackbox.yml:/etc/blackbox/blackbox.yml:ro`, image("BLACKBOX_IMAGE"), "--config.file=/etc/blackbox/blackbox.yml", "--config.check"], { encoding: "utf8", timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /Config file is ok/);
});
