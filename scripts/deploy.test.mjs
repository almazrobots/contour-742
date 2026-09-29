// Профиль gpu (ADR-0001): статическая проверка deploy/gpu — без Docker на маке.
// Стандарт «прод-образы» (CLAUDE.md): образ по digest, без сборки на хосте, cap_drop ALL, порты — только localhost.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "deploy/gpu");
const compose = parse(readFileSync(join(dir, "compose.yml"), "utf8"), { merge: true });
const services = Object.entries(compose.services);


/** Имена рядов /metrics: строки «# TYPE» в app.ts и services/ids.ts; гистограммы services/slo-metrics.ts — с суффиксами
 *  _bucket, _sum, _count (NFR-PERF-RUNTIME, T-138). */
function exportedMetrics() {
  const src = (f) => readFileSync(join(root, "apps/api/src", f), "utf8");
  const names = [...(src("app.ts") + src("services/ids.ts")).matchAll(/# TYPE ([a-z_0-9]+) /g)].map((m) => m[1]);
  for (const [, h] of src("services/slo-metrics.ts").matchAll(/new Histogram\("([a-z_0-9]+)"/g)) names.push(h, `${h}_bucket`, `${h}_sum`, `${h}_count`);
  return new Set(names);
}
/** Сети службы compose: список или объект (фиксированный адрес — NFR-IDS). */
const nets = (s) => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}));

test("образы — только обязательные переменные с digest, сборки на хосте нет", () => {
  for (const [name, s] of services) {
    assert.match(s.image, /^\$\{[A-Z_]+_IMAGE:\?/, `${name}: образ не переменная с :? — ${s.image}`);
    assert.equal(s.build, undefined, `${name}: build на хосте запрещён (ADR-0005)`);
  }
  const env = readFileSync(join(dir, ".env.example"), "utf8");
  const required = [...readFileSync(join(dir, "compose.yml"), "utf8").matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]);
  for (const v of new Set(required)) assert.match(env, new RegExp(`^${v}=`, "m"), `.env.example не знает ${v}`);
  assert.match(env, /sha256/, ".env.example обязан требовать digest");
});

test("каждый сервис: cap_drop ALL, no-new-privileges, pids_limit; порты — только 127.0.0.1", () => {
  for (const [name, s] of services) {
    assert.deepEqual(s.cap_drop, ["ALL"], name);
    assert.ok(s.security_opt?.includes("no-new-privileges:true"), name);
    assert.ok(s.pids_limit > 0, name);
    for (const p of s.ports ?? []) assert.match(p, /^127\.0\.0\.1:/, `${name}: порт наружу ${p}`);
  }
});

test("профиль gpu в API и ML: RabbitMQ, clamd, Redis (ТЗ 1.5, 12.11, 9.1.5)", () => {
  const api = compose.services.api.environment;
  assert.deepEqual([api.INSPECTOR_PROFILE, api.INSPECTOR_QUEUE, api.INSPECTOR_AV], ["gpu", "amqp", "clamd"]);
  // NFR-TLS-INTERNAL: очередь — amqps на 5671, кэш ML — rediss с корнем доверия стенда
  assert.match(api.INSPECTOR_AMQP_URL, /^amqps:\/\/.+@rabbitmq:5671$/);
  const ml = compose.services.ml.environment;
  assert.deepEqual([ml.INSPECTOR_PROFILE, ml.INSPECTOR_CACHE, ml.INSPECTOR_REDIS_URL], ["gpu", "redis", "rediss://redis:6379/0?ssl_ca_certs=/run/tls/ca.crt"]);
});

test("алерты ТЗ 13.7: CPU > 80 %, ответ > 500 мс; Prometheus собирает /metrics API", () => {
  const rules = parse(readFileSync(join(dir, "alerts.yml"), "utf8")).groups.flatMap((g) => g.rules);
  const expr = (a) => rules.find((r) => r.alert === a)?.expr ?? "";
  assert.match(expr("InspectorCpuHigh"), /> 0\.8$/);
  assert.match(expr("InspectorSlowResponses"), /> 500$/);
  const prom = parse(readFileSync(join(dir, "prometheus.yml"), "utf8"));
  assert.deepEqual(prom.scrape_configs[0].static_configs[0].targets, ["api:8810"]);
});

test("дашборд Grafana: каждая метрика существует в /metrics API", () => {
  const exported = exportedMetrics();
  const dash = JSON.parse(readFileSync(join(dir, "grafana/dashboards/inspector-api.json"), "utf8"));
  assert.ok(dash.panels.length >= 6);
  for (const p of dash.panels) {
    const names = [...p.targets[0].expr.matchAll(/\b((?:inspector|process)_[a-z_0-9]+)/g)].map((m) => m[1]);
    assert.ok(names.length, p.title);
    for (const n of names) assert.ok(exported.has(n), `${p.title}: метрики ${n} нет в /metrics`);
  }
});

// ─────────────── NFR-TLS (ТЗ 1.3, 12.3): API в эксплуатационном контуре — только HTTPS, TLS 1.3
test("API только по HTTPS: в compose заданы cert/key, prometheus ходит по https", () => {
  const api = compose.services.api;
  assert.match(api.environment.INSPECTOR_TLS_CERT, /^\/run\/tls\/.+\.crt$/);
  assert.match(api.environment.INSPECTOR_TLS_KEY, /^\/run\/tls\/.+\.key$/);
  assert.ok(api.volumes.some((v) => /^\$\{TLS_DIR:\?[^}]*\}:\/run\/tls:ro$/.test(v)), "каталог сертификатов API — read-only из ${TLS_DIR:?}");
  const job = parse(readFileSync(join(dir, "prometheus.yml"), "utf8")).scrape_configs.find((j) => j.job_name === "inspector-api");
  assert.equal(job.scheme, "https");
  assert.ok(job.tls_config.server_name, "prometheus: server_name для проверки сертификата");
  assert.equal(job.tls_config.insecure_skip_verify, undefined, "проверка сертификата не отключается");
  assert.ok(compose.services.prometheus.volumes.some((v) => v.startsWith("${TLS_DIR:?}/") && v.endsWith(`:${job.tls_config.ca_file}:ro`)), "ca_file смонтирован из TLS_DIR");
  assert.ok(!compose.services.prometheus.volumes.some((v) => /\.key/.test(v)), "ключ API в prometheus не монтируется");
});

// ─────────────── ELK (ТЗ 13.6, TZA-7.11-03) и сроки хранения логов (ТЗ 12.5, 13.3). Реальный Logstash без Docker
// не поднять — здесь статическая проверка и прогон setup.sh против поддельного ES; живой прогон — стенд T-060.
const pipeline = readFileSync(join(dir, "logstash/pipeline/inspector.conf"), "utf8");
const pipelineCode = pipeline.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const { formatLog } = await import(join(root, "apps/api/src/services/audit.ts"));

test("ELK: Elasticsearch, Logstash, Kibana по digest и под hardened; api и ml шлют логи в Logstash", () => {
  for (const name of ["elasticsearch", "logstash", "kibana"]) {
    const s = compose.services[name];
    assert.ok(s, `нет сервиса ${name}`);
    assert.match(s.image, new RegExp(`^\\$\\{${name.toUpperCase()}_IMAGE:\\?`), name);
    assert.deepEqual(s.cap_drop, ["ALL"], name);
    assert.ok(s.security_opt.includes("no-new-privileges:true") && s.pids_limit > 0, name);
  }
  const es = compose.services.elasticsearch.environment;
  assert.equal(es["xpack.security.enabled"], "true");
  assert.equal(es.ELASTIC_PASSWORD, "${ELASTIC_PASSWORD:?}");
  assert.equal(es["discovery.type"], "single-node");
  assert.match(es.ES_JAVA_OPTS, /-Xmx\d+[mg]/);
  const ls = compose.services.logstash;
  assert.deepEqual(ls.ports, ["127.0.0.1:12201:12201/udp"]);
  assert.ok(ls.volumes.some((v) => v.startsWith("./logstash/pipeline:") && v.endsWith(":ro")));
  assert.deepEqual(compose.services.kibana.ports, ["127.0.0.1:5601:5601"]);
  for (const name of ["api", "ml"]) {
    const lg = compose.services[name].logging;
    assert.equal(lg?.driver, "gelf", `${name}: логи не уходят в Logstash`);
    assert.equal(lg.options["gelf-address"], "udp://127.0.0.1:12201", name);
  }
  assert.match(pipelineCode, /gelf\s*\{[^}]*port => 12201/);
});

test("Logstash разбирает поля, которые реально пишет formatLog; @timestamp — из timestamp; DEBUG не хранится", () => {
  const line = formatLog("INFO", "проверка", { request_id: "r", user_id: 1, ms: 5 });
  const fields = Object.keys(JSON.parse(line)).filter((k) => k !== "ms");
  assert.deepEqual(fields.slice(0, 6), ["timestamp", "level", "service", "message", "request_id", "user_id"]);
  for (const f of fields) assert.ok(pipelineCode.includes(`[${f}]`) || pipelineCode.includes(`"${f}"`), `pipeline не знает поле ${f}`);
  assert.match(pipelineCode, /json\s*\{\s*source => "message"/);
  // раскладка GELF-полей не зависит от умолчания ECS мажорной версии Logstash (8+: ECS v8)
  assert.match(pipelineCode, /gelf\s*\{[^}]*ecs_compatibility => disabled/);
  assert.match(pipelineCode, /date\s*\{\s*match => \["timestamp", "ISO8601"\]\s*target => "@timestamp"/);
  assert.match(pipelineCode, /if \[level\] == "DEBUG" \{\s*drop \{\}/);
});

const esDir = join(dir, "elasticsearch");
const esJson = (f) => JSON.parse(readFileSync(join(esDir, f), "utf8"));

test("ILM: inspector-logs — 90 дней, inspector-security — 365 дней; шаблоны индексов ссылаются на политики", () => {
  const days = { "inspector-logs": "90d", "inspector-security": "365d" };
  for (const [name, age] of Object.entries(days)) {
    const phases = esJson(`ilm-${name}.json`).policy.phases;
    assert.equal(phases.delete.min_age, age, name);
    assert.deepEqual(phases.delete.actions, { delete: {} }, name);
    const tpl = esJson(`template-${name}.json`);
    assert.equal(tpl.template.settings["index.lifecycle.name"], name);
    assert.deepEqual(tpl.index_patterns, [`${name}*`]);
    assert.ok(tpl.data_stream, `${name}: data stream`);
    assert.ok(pipelineCode.includes(`index => "${name}"`), `pipeline не пишет в ${name}`);
  }
});

test("setup.sh применяет политики и шаблоны к Elasticsearch — идемпотентно (прогон против поддельного ES)", async () => {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { seen.push({ m: req.method, u: req.url.split("?")[0], body, auth: req.headers.authorization }); res.setHeader("content-type", "application/json"); res.end("{}"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const env = { ...process.env, ES_URL: `http://127.0.0.1:${srv.address().port}`, ELASTIC_PASSWORD: "e", KIBANA_SYSTEM_PASSWORD: 'k"q', LOGSTASH_WRITER_PASSWORD: "l" };
  const run = () => new Promise((ok, fail) => execFile("bash", [join(esDir, "setup.sh")], { env }, (e, out, err) => (e ? fail(new Error(err)) : ok(out))));
  try {
    await run();
    const first = seen.filter((r) => r.u !== "/_cluster/health");
    seen.length = 0;
    await run();
    const second = seen.filter((r) => r.u !== "/_cluster/health");
    assert.deepEqual(second, first, "повторный запуск шлёт то же самое");
    const put = (u) => first.find((r) => r.m === "PUT" && r.u === u);
    for (const name of ["inspector-logs", "inspector-security"]) {
      assert.deepEqual(JSON.parse(put(`/_ilm/policy/${name}`).body), esJson(`ilm-${name}.json`));
      assert.deepEqual(JSON.parse(put(`/_index_template/${name}`).body), esJson(`template-${name}.json`));
    }
    assert.equal(JSON.parse(first.find((r) => r.u === "/_security/user/kibana_system/_password").body).password, 'k"q');
    assert.deepEqual(JSON.parse(put("/_security/role/inspector_logstash_writer").body).indices[0].privileges, ["create_doc", "auto_configure"]);
    assert.ok(first.every((r) => r.auth === `Basic ${Buffer.from("elastic:e").toString("base64")}`));
  } finally {
    srv.close();
  }
});

test("маршрутизация безопасности: вход, отказ в доступе, перебор пароля 429, антивирус — в inspector-security", () => {
  const app = readFileSync(join(root, "apps/api/src/app.ts"), "utf8");
  const auditSrc = readFileSync(join(root, "apps/api/src/services/audit.ts"), "utf8");
  // Форматы сообщений берутся из кода: строка ответа onResponse и строка журнала аудита
  // путь — без значений параметров запроса (NFR-PDN: redactUrl), правила Logstash смотрят на метод, путь и код
  assert.ok(app.includes("`${req.method} ${redactUrl(req.url)} ${reply.statusCode}`"), "формат строки ответа в app.ts изменился");
  assert.ok(auditSrc.includes("`audit ${action}`"), "формат строки аудита в audit.ts изменился");
  // Имена действий аудита — по всему коду API (антивирус живёт в services/antivirus.ts), 429 — у входа в app.ts
  const svcDir = join(root, "apps/api/src/services");
  const apiSrc = [app, ...readdirSync(svcDir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(svcDir, f), "utf8"))].join("\n");
  for (const a of ['"FILE_INFECTED"', '"FILE_SCAN_FAILED"', '"LOGIN"']) assert.ok(apiSrc.includes(a), `действие аудита ${a} больше не пишется`);
  assert.ok(app.includes("reply.code(429)"));
  const rules = [...pipelineCode.matchAll(/\[message\] =~ \/(.+?)\/ \{\s*mutate \{ add_tag => \["security"\] \}/g)].map((m) => new RegExp(m[1]));
  assert.ok(rules.length >= 2, "нет правил признака безопасности");
  const isSecurity = (msg) => rules.some((r) => r.test(JSON.parse(formatLog("INFO", msg)).message));
  for (const m of ["audit LOGIN", "audit FILE_INFECTED", "audit FILE_SCAN_FAILED", "POST /api/v1/auth/login 401", "POST /api/v1/auth/login 429", "GET /api/v1/inspections/x 403"]) assert.ok(isSecurity(m), m);
  for (const m of ["GET /api/v1/dictionaries 200", "POST /api/v1/documents/upload 413", "audit DECISION", "rin sync ok"]) assert.ok(!isSecurity(m), m);
  assert.match(pipelineCode, /if \[security\] \{\s*mutate \{ add_tag => \["security"\] \}/);
  assert.equal(pipelineCode.match(/if "security" in \[tags\] \{\s*elasticsearch \{[\s\S]*?index => "([a-z-]+)"/)?.[1], "inspector-security");
});

// ─── T-060: образы api/ml/web и закреплённые сторонние образы ───
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const dockerfiles = ["apps/api/Dockerfile", "ml/Dockerfile", "apps/web/Dockerfile"].map((f) => [f, readFileSync(join(root, f), "utf8")]);

test("сторонние образы в .env.example закреплены: имя:тег@sha256; свои — из гейта CI", () => {
  const env = readFileSync(join(dir, ".env.example"), "utf8");
  const images = [...env.matchAll(/^([A-Z_]+_IMAGE)=([^\s#]*)/gm)].map((m) => [m[1], m[2]]);
  const own = new Set(["API_IMAGE", "ML_GPU_IMAGE", "WEB_IMAGE"]);
  for (const [k, v] of images) {
    if (own.has(k)) assert.equal(v, "", `${k}: свой образ приходит digest'ом от гейта, в шаблоне не задаётся`);
    else assert.match(v, /^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${k}: не закреплён по digest — ${v}`);
  }
  for (const k of own) assert.ok(images.some(([n]) => n === k), `.env.example не знает ${k}`);
});

test("Dockerfile: каждая база — по digest; рантайм не под root; код не принадлежит пользователю рантайма", () => {
  for (const [f, s] of dockerfiles) {
    const refs = [...s.matchAll(/^ARG [A-Z_]+_IMAGE=(\S+)$/gm)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${f}: базовые образы задаются через ARG *_IMAGE`);
    for (const r of refs) assert.match(r, DIGEST, `${f}: ${r} без digest`);
    for (const m of s.matchAll(/^FROM (\S+)/gm)) assert.ok(m[1].startsWith("${") || !/[:/]/.test(m[1]), `${f}: FROM ${m[1]} мимо закреплённых ARG`);
    const runtime = s.slice(s.lastIndexOf("\nFROM "));
    const user = [...runtime.matchAll(/^USER (\S+)/gm)].pop()?.[1];
    assert.ok(user && !["root", "0"].includes(user), `${f}: последний USER рантайма — ${user}`);
    assert.match(runtime, /chmod -R (a\+rX,)?a-w/, `${f}: код в рантайме должен быть только для чтения`);
    assert.doesNotMatch(runtime, /chown -R (node|inspector|10001|101)\b[^\n]*\/app\b(?!\/var)/, `${f}: код отдан пользователю рантайма`);
  }
});

test("в рантайм-образ не едет пакетный менеджер и сборка на хосте невозможна", () => {
  const api = dockerfiles.find(([f]) => f === "apps/api/Dockerfile")[1];
  const runtime = api.slice(api.lastIndexOf("\nFROM "));
  assert.match(runtime, /rm -rf [^\n]*node_modules\/npm[^\n]*node_modules\/corepack/, "api: npm и corepack удаляются из рантайма");
  assert.doesNotMatch(runtime, /(^RUN\s+|&&\s*)(pnpm|npm|npx|corepack|tsx)\s/m, "api: в рантайме не вызываются pnpm/npm/tsx");
  assert.match(api, /CMD \["node", "apps\/api\/dist\/server\.mjs"\]/, "api: запуск собранного JS, не исходников");
  const ml = dockerfiles.find(([f]) => f === "ml/Dockerfile")[1];
  assert.match(ml.slice(ml.lastIndexOf("\nFROM ")), /pip uninstall -y pip/, "ml: pip в рантайме не нужен");
  assert.match(ml, /ADD --checksum=sha256:[0-9a-f]{64} \$\{HF\}\/onnx\/model_quint8_avx2\.onnx/, "ml: модель x86 — с проверкой SHA-256");
  assert.match(ml, /INSPECTOR_EMBED_FILE=onnx\/model_quint8_avx2\.onnx/, "ml: образ x86 указывает свой файл модели");
  assert.match(ml, /chmod -R a\+rX,a-w [^\n]*\/opt\/model/, "ml: модель читаема пользователем рантайма (ADD даёт 600)");
});

test("web: nginx-unprivileged под 101 без cap_add; все заголовки — на уровне server, CSP запрещает фреймы", () => {
  const web = compose.services.web;
  assert.ok(web, "в стенде есть интерфейс");
  assert.equal(web.user, "101:101");
  assert.equal(web.cap_add, undefined);
  assert.match(web.image, /^\$\{WEB_IMAGE:\?/);
  assert.deepEqual(web.ports, ["127.0.0.1:8443:8443"]);
  const conf = readFileSync(join(root, "apps/web/nginx.conf"), "utf8").replace(/#[^\n]*/g, "");
  for (const block of conf.matchAll(/location[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(block[1], /add_header/, "add_header внутри location отменяет унаследованные");
  assert.match(conf, /Content-Security-Policy "[^"]*frame-ancestors 'none'/);
  assert.match(conf, /ssl_protocols\s+TLSv1\.3;/);
  assert.match(conf, /proxy_ssl_verify\s+on;/, "к API — с проверкой сертификата");
  assert.match(conf, /location = \/metrics \{ return 404; \}/, "метрики наружу не отдаются");
  assert.match(readFileSync(join(root, "apps/web/Dockerfile"), "utf8"), /nginxinc\/nginx-unprivileged:[\w.-]+@sha256:/);
});

// ─── T-230 (OWASP-0210/0211/0212/0219): ML профиля gpu — только образ цели gpu; vLLM — из репозитория, ревизии закреплены ───
const gpuComposes = ["deploy/gpu/compose.yml", "deploy/gpu-stand/compose.yml"].map((f) => [f, parse(readFileSync(join(root, f), "utf8"), { merge: true })]);

test("сервис с INSPECTOR_PROFILE: gpu — образ цели gpu, видеокарта, VLM через vLLM (openai)", () => {
  let seen = 0;
  for (const [f, c] of gpuComposes) {
    for (const [name, s] of Object.entries(c.services)) {
      // API в профиле gpu — свой образ; всё остальное с INSPECTOR_PROFILE: gpu исполняет inspector_ml
      if (s.environment?.INSPECTOR_PROFILE !== "gpu" || /^\$\{(API|WEB)_IMAGE:\?/.test(s.image)) continue;
      seen++;
      assert.match(s.image, /^\$\{ML_GPU_IMAGE:\?/, `${f} ${name}: профиль gpu — только образ цели gpu (ML_GPU_IMAGE)`);
      assert.equal(s.environment.INSPECTOR_VLM_BACKEND, "openai", `${f} ${name}: читатель VL — только vLLM`);
      assert.ok(s.environment.INSPECTOR_VLM_URL, `${f} ${name}: нет INSPECTOR_VLM_URL`);
      assert.equal(s.environment.INSPECTOR_OCR_ENGINES, undefined, `${f} ${name}: набор движков — умолчание профиля gpu`);
      const dev = s.deploy?.resources?.reservations?.devices ?? [];
      assert.ok(dev.some((d) => d.driver === "nvidia" && d.capabilities?.includes("gpu")), `${f} ${name}: не выдана видеокарта`);
    }
  }
  assert.equal(seen, 2, "ML профиля gpu — в deploy/gpu и deploy/gpu-stand");
  // образ ML_GPU_IMAGE собирается целью gpu: гейт собирает её, скрипт стенда берёт её и проверяет метку образа
  const df = readFileSync(join(root, "ml/Dockerfile"), "utf8");
  const gpu = df.slice(df.indexOf("AS gpu\n"), df.indexOf("AS runtime\n"));
  assert.match(gpu, /COPY --from=build-gpu \/opt\/venv/);
  assert.match(gpu, /LABEL [^\n]*org\.opencontainers\.image\.title="inspector-ml-gpu"/);
  assert.match(gpu, /INSPECTOR_PPOCR_MODEL_DIR=\/opt\/ppocr/);
  assert.match(gpu, /^USER 10001$/m);
  assert.match(gpu, /chown -R root:root \/app [^\n]*\/opt\/ppocr && chmod -R a\+rX,a-w [^\n]*\/opt\/ppocr/);
  assert.doesNotMatch(gpu, /tesseract/, "Tesseract в образе gpu запрещён");
  assert.match(gpu, /pip uninstall -y pip/, "pip в рантайме не нужен");
  const build = df.slice(df.indexOf("AS build-gpu\n"), df.indexOf("AS ppocr\n"));
  assert.match(build, /uv sync --locked[^\n]*--extra gpu/);
  assert.doesNotMatch(build, /--extra semantic/, "onnxruntime CPU и onnxruntime-gpu — один модуль");
  assert.match(build, /--no-install-package opencv-python\b/, "только opencv-python-headless (OWASP-0219)");
  assert.ok(df.trimEnd().lastIndexOf("AS runtime\n") > df.indexOf("AS gpu\n"), "цель по умолчанию — последняя стадия runtime");
  assert.match(readFileSync(join(root, "scripts/local-gate.sh"), "utf8"), /build ml-gpu ml\/Dockerfile --target gpu/);
  const stand = readFileSync(join(root, "scripts/gpu-stand.sh"), "utf8");
  assert.match(stand, /w1-main-ml-gpu:\$sha/);
  // ревизия назначается покомпонентно (revision-ml), ML — только цель gpu: своя сборка --target gpu и проверка метки образа
  assert.match(stand, /ML_GPU_IMAGE=inspector-gpu-ml:\$ml/);
  assert.match(stand, /-f "\$ctx\/ml\/Dockerfile" --target gpu/);
  assert.match(stand, /ml_is_gpu "\$i" "\$sha"/);
  assert.match(stand, /= inspector-ml-gpu \]/);
});

test("vLLM стенда gpu: образ по digest, ревизии HF из реестра, офлайн, без --trust-remote-code, порты — петля", () => {
  const sh = readFileSync(join(root, "deploy/gpu-stand/vllm.sh"), "utf8");
  assert.match(sh, /^VLLM_IMAGE=vllm\/vllm-openai:[\w.-]+@sha256:[0-9a-f]{64}$/m);
  assert.match(sh, /HF_HUB_OFFLINE=1/);
  assert.match(sh, /--revision/);
  assert.doesNotMatch(sh.replace(/#[^\n]*/g, ""), /--trust-remote-code/);
  const ports = [...sh.matchAll(/-p "?([^:\s"]+):/g)].map((m) => m[1]);
  assert.ok(ports.length > 0 && ports.every((h) => h === "127.0.0.1"), `vLLM — только петля: ${ports}`);
  const reg = parse(readFileSync(join(root, "ml/models.yaml"), "utf8")).roles;
  for (const role of ["reader", "judge"]) assert.ok(sh.includes(`"${reg[role].gpu_equivalent}" "${reg[role].revision}"`), `${role}: ревизия не из реестра`);
  const router = readFileSync(join(root, "deploy/gpu-stand/vlm-router.py"), "utf8");
  assert.match(router, /ThreadingHTTPServer\(\("127\.0\.0\.1", 8010\)/, "маршрутизатор — только 127.0.0.1:8010");
});

// ─── T-083: ML ставится ровно по uv.lock — в образе и в гейте ───
test("ml: зависимости образа и гейта — из uv.lock (--locked), мимо lock не ставится ничего", () => {
  const ml = dockerfiles.find(([f]) => f === "ml/Dockerfile")[1];
  assert.match(ml, /COPY ml\/pyproject\.toml ml\/uv\.lock ml\//, "ml: uv.lock копируется в сборку");
  assert.match(ml, /uv sync --locked[^\n]*--no-dev[^\n]*--no-editable/, "ml: установка — uv sync --locked, без dev и не editable");
  assert.doesNotMatch(ml, /uv pip install/, "ml: uv pip install ставит мимо lock");
  const lock = readFileSync(join(root, "ml/uv.lock"), "utf8");
  for (const extra of ["semantic", "cache"]) assert.match(ml, new RegExp(`--extra ${extra}\\b`), `ml: экстра ${extra} в образе`);
  assert.match(lock, /^name = "redis"$/m, "uv.lock знает redis (кэш разбора, ТЗ 9.1.5)");
  const gate = readFileSync(join(root, ".github/workflows/ci-gate.yml"), "utf8");
  assert.match(gate, /uv sync --locked[^\n]*--extra dev[^\n]*--extra semantic/, "гейт: тесты ML — на окружении из lock");
  assert.doesNotMatch(gate, /uv pip install/, "гейт: uv pip install ставит мимо lock");
});

// ─── T-085: алерты ТЗ 13.7 доставляются — Alertmanager, почта и Telegram ───
test("алерты ТЗ 13.7 уходят в Alertmanager; у него получатели «почта» и «Telegram», секреты — только файлами", () => {
  const prom = parse(readFileSync(join(dir, "prometheus.yml"), "utf8"));
  const targets = (prom.alerting?.alertmanagers ?? []).flatMap((a) => a.static_configs.flatMap((c) => c.targets));
  assert.deepEqual(targets, ["alertmanager:9093"], "Prometheus не отправляет алерты в Alertmanager — правила считаются впустую");
  const am = compose.services.alertmanager;
  assert.ok(am, "в стенде есть Alertmanager");
  assert.match(am.image, /^\$\{ALERTMANAGER_IMAGE:\?/);
  assert.equal(am.ports, undefined, "Alertmanager наружу не публикуется");
  assert.ok(am.volumes.some((v) => /^\$\{ALERTMANAGER_CONFIG:\?[^}]*\}:\/etc\/alertmanager\/alertmanager\.yml:ro$/.test(v)), "конфиг стенда — файл с хоста, только чтение");
  assert.ok(am.volumes.some((v) => /^\$\{ALERTMANAGER_SECRETS:\?[^}]*\}:\/run\/secrets\/alertmanager:ro$/.test(v)), "секреты — каталог с хоста, только чтение");
  assert.ok(compose.services.prometheus.depends_on?.includes("alertmanager"));
  const cfgText = readFileSync(join(dir, "alertmanager/alertmanager.example.yml"), "utf8");
  const cfg = parse(cfgText);
  const byName = Object.fromEntries(cfg.receivers.map((r) => [r.name, r]));
  const routed = new Set([cfg.route.receiver, ...(cfg.route.routes ?? []).map((r) => r.receiver)]);
  const mail = cfg.receivers.find((r) => r.email_configs?.length);
  const tg = cfg.receivers.find((r) => r.telegram_configs?.length);
  assert.ok(mail && tg, "получатели «почта» и «Telegram» (ТЗ 13.7)");
  assert.ok(routed.has(mail.name) || byName[cfg.route.receiver]?.email_configs, "почта стоит в маршруте");
  assert.ok([...routed].some((n) => byName[n]?.telegram_configs), "Telegram стоит в маршруте");
  assert.ok(tg.telegram_configs.every((t) => t.bot_token_file?.startsWith("/run/secrets/alertmanager/") && t.chat_id_file?.startsWith("/run/secrets/alertmanager/")), "токен и чат — файлами");
  assert.ok(mail.email_configs.every((m) => m.auth_password_file?.startsWith("/run/secrets/alertmanager/") && m.require_tls === true), "пароль SMTP — файлом, TLS обязателен");
  assert.doesNotMatch(cfgText, /\b(bot_token|auth_password|chat_id):/, "секреты не пишутся в конфиг текстом");
});

test("каждая метрика алертов существует в /metrics API; время ответа — среднее за окно, а не с момента старта", () => {
  const exported = exportedMetrics();
  const rules = parse(readFileSync(join(dir, "alerts.yml"), "utf8")).groups.flatMap((g) => g.rules);
  for (const r of rules) for (const [, n] of r.expr.matchAll(/\b((?:inspector|process)_[a-z_0-9]+)/g)) assert.ok(exported.has(n), `${r.alert}: метрики ${n} нет в /metrics`);
  const slow = rules.find((r) => r.alert === "InspectorSlowResponses").expr;
  assert.match(slow, /rate\(inspector_http_latency_ms_sum\[5m\]\)\s*\/\s*rate\(inspector_http_requests_total\[5m\]\)/, "среднее за 5 минут");
  assert.doesNotMatch(slow, /_avg\b/, "накопительное среднее с момента старта не замечает свежий всплеск");
});

// ─── T-086: провайдер LLM на стенде — явно; пока LLM-сервера нет — none ───
test("ml: провайдер LLM задан явно; без LLM-сервера в стенде — none, а не молчаливый Ollama на 127.0.0.1", () => {
  const env = compose.services.ml.environment;
  assert.ok(["ollama", "mlx", "none"].includes(env.INSPECTOR_LLM_PROVIDER), `ml: INSPECTOR_LLM_PROVIDER=${env.INSPECTOR_LLM_PROVIDER}`);
  const llmServer = Object.keys(compose.services).some((n) => /ollama|vllm|llm/.test(n));
  if (!llmServer) assert.equal(env.INSPECTOR_LLM_PROVIDER, "none", "LLM-сервера в стенде нет — провайдер none");
});

// ─── T-087: гигиена тулчейна и граница доверия гейта ───
test("тулчейн: Node 24 и в dev, типы под рантайм, бандлер API — прямая зависимость по имени", () => {
  assert.equal(readFileSync(join(root, ".nvmrc"), "utf8").trim(), "24", ".nvmrc: рантайм dev = рантайм образа");
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(rootPkg.engines.node, ">=24 <27", "engines: только проверяемые ветки");
  assert.match(rootPkg.pnpm?.overrides?.qs ?? "", /^>=6\.16/, "qs из дерева Stryker — без трёх moderate");
  const api = JSON.parse(readFileSync(join(root, "apps/api/package.json"), "utf8"));
  assert.match(api.devDependencies["@types/node"], /^\^24\./, "@types/node — под Node 24 образа");
  assert.ok(api.devDependencies.esbuild, "esbuild — прямая зависимость API");
  const df = dockerfiles.find(([f]) => f === "apps/api/Dockerfile")[1];
  assert.doesNotMatch(df, /find node_modules\/\.pnpm/, "бандлер прода не ищется find-ом по .pnpm");
  assert.match(df, /apps\/api\/node_modules\/\.bin\/esbuild apps\/api\/src\/server\.ts/, "бандлер — объявленный esbuild API");
});

test("гейт: все actions по sha; PR из форка не исполняется на раннере; секреты реестра — только в публикации с main", () => {
  const text = readFileSync(join(root, ".github/workflows/ci-gate.yml"), "utf8");
  const wf = parse(text);
  for (const [, m] of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m, /@[0-9a-f]{40}$/, `action не по sha: ${m}`);
  const gate = wf.jobs.gate;
  assert.match(gate.if ?? "", /github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/, "PR из форка не должен исполняться на self-hosted раннере с docker.sock");
  for (const s of gate.steps) {
    const body = JSON.stringify(s);
    if (!/secrets\.REGISTRY_/.test(body)) continue;
    assert.match(s.if ?? "", /github\.ref == 'refs\/heads\/main'/, `${s.name}: секреты реестра только на main`);
    assert.match(s.if ?? "", /github\.event_name != 'pull_request'/, `${s.name}: секреты реестра не в PR`);
  }
  assert.match(text, /--ephemeral/, "требование к раннеру: одноразовый (--ephemeral)");
});


test("страж: защищённые файлы в любом регистре и написании, ссылки, рост gitleaks:allow — нарушение", async () => {
  const { violations, isProtected } = await import("./security-guard.mjs");
  assert.deepEqual(violations({ files: ["apps/api/src/app.ts", "ml/x.py", "docs/gitleaks-заметки.md"] }), []);
  for (const f of [".gitleaksignore", ".gitleaks.toml", ".GitLeaks.toml", ".gitleaks.yaml", ".github/workflows/ci-gate.yml",
    ".GitHub/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS", "scripts/security-guard.mjs", "./.github/x", ".github/../.github/y"]) {
    assert.ok(isProtected(f), f);
  }
  assert.ok(!isProtected("docs/x/CODEOWNERS") && !isProtected("scripts/other.mjs"));
  assert.equal(violations({ files: ["a.ts"], symlinks: ["link"] }).length, 1);
  const before = new Map([["a.ts", 1]]);
  assert.deepEqual(violations({ files: ["a.ts"], allowBefore: before, allowAfter: new Map([["a.ts", 1]]) }), []);
  assert.match(violations({ files: ["a.ts"], allowBefore: before, allowAfter: new Map([["a.ts", 2]]) })[0], /gitleaks:allow: a\.ts/);
  assert.match(violations({ files: ["b.ts"], allowAfter: new Map([["b.ts", 1]]) })[0], /b\.ts/);
  // перенос пометки: счётчик тот же, но добавленная строка с пометкой есть — нарушение
  assert.equal(violations({ files: ["a.ts"], allowAdded: ["a.ts"], allowBefore: before, allowAfter: new Map([["a.ts", 1]]) }).length, 1);
});

test("страж: разбор diff — заголовки против добавленных строк «+++…», удаления не в счёт", async () => {
  const { addedAnnotated } = await import("./security-guard.mjs");
  const patch = [
    "diff --git a/x.ts b/x.ts", "index 1..2 100644", "--- a/x.ts", "+++ b/x.ts",
    "@@ -1 +1 @@", "-const a = 1; // gitleaks:allow", "+const a = 1;",
    "@@ -5,0 +5 @@", "++++ gitleaks:allow  (строка «+++ gitleaks:allow» в файле)",
    "diff --git a/y.ts b/y.ts", "--- a/y.ts", "+++ b/y.ts", "@@ -1 +0,0 @@", "-z // GITLEAKS:ALLOW",
    "diff --git a/+++ gitleaks:allow b/+++ gitleaks:allow", "--- /dev/null", "+++ b/+++ gitleaks:allow", "@@ -0,0 +1 @@", "+ничего",
  ].join("\n");
  assert.deepEqual(addedAnnotated(patch), ["x.ts"]);
  // заголовок, который не разобрался (кавычки, чужой префикс), — строку с пометкой всё равно ловим
  assert.deepEqual(addedAnnotated(["diff --git \"a/q\\tx\" \"b/q\\tx\"", "@@ -0,0 +1 @@", "+k // gitleaks:allow"].join("\n")), ["(имя файла не разобрано)"]);
});

test("страж: неясная база — отказ; реальный git: экранируемые имена, переименование, ссылка, «++ gitleaks:allow»", async () => {
  const { diffOf, violations } = await import("./security-guard.mjs");
  const { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const b of ["", "0".repeat(40), "abc", undefined]) assert.throws(() => diffOf(b, "a".repeat(40)), /неясная база/);
  assert.throws(() => diffOf("a".repeat(40), ""), /неясная база/);
  const d = mkdtempSync(join(tmpdir(), "guard-"));
  const g = (...a) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }).trim();
  const cwd = process.cwd();
  try {
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    g("config", "diff.noprefix", "true"); g("config", "diff.mnemonicPrefix", "true"); g("config", "core.quotepath", "true");  // «враждебный» конфиг раннера
    mkdirSync(join(d, "ci")); writeFileSync(join(d, "ci", "gate.yml"), "x\n");
    writeFileSync(join(d, "a.ts"), "x\n"); writeFileSync(join(d, "m.ts"), "safe // gitleaks:allow\nsecret\n");
    g("add", "."); g("commit", "-qm", "1");
    const base = g("rev-parse", "HEAD");
    g("mv", "ci", ".github");  // переименование в защищённое: видно по новому имени
    writeFileSync(join(d, "a.ts"), "x\n++ gitleaks:allow\n");  // строка, похожая на заголовок diff
    writeFileSync(join(d, "Имя «файла».ts"), "y // GITLEAKS:ALLOW\n");  // имя, которое git экранирует без -z
    symlinkSync(".gitleaksignore", join(d, "safe.txt"));
    writeFileSync(join(d, "m.ts"), "safe\nsecret // gitleaks:allow\n");  // перенос пометки: счётчик тот же
    g("add", "-A"); g("commit", "-qm", "2");
    const head = g("rev-parse", "HEAD");
    process.chdir(d);
    const r = diffOf(base, head);
    const v = violations(r);
    assert.ok(r.files.includes("Имя «файла».ts") && r.files.includes(".github/gate.yml") && r.files.includes("ci/gate.yml"));
    assert.deepEqual(r.symlinks, ["safe.txt"]);
    assert.ok(v.some((x) => /\.github\/gate\.yml/.test(x)));
    assert.ok(v.some((x) => /gitleaks:allow: a\.ts/.test(x)));
    assert.ok(v.some((x) => /gitleaks:allow: Имя «файла»\.ts/.test(x)));
    assert.ok(v.some((x) => /ссылка: safe\.txt/.test(x)));
    assert.ok(v.some((x) => /gitleaks:allow: m\.ts/.test(x)), "перенос пометки пойман");
    assert.throws(() => diffOf("f".repeat(40), head));  // базы нет в репозитории — отказ
  } finally {
    process.chdir(cwd);
    rmSync(d, { recursive: true, force: true });
  }
});

test("страж в CI: PR — pull_request_target из main без исполнения кода PR; push — всем, кроме владельца в main; до скана", () => {
  const guard = parse(readFileSync(join(root, ".github/workflows/security-guard.yml"), "utf8"));
  assert.deepEqual(Object.keys(guard.on), ["pull_request_target"]);
  assert.deepEqual(guard.permissions, { contents: "read" });
  const st = guard.jobs.guard.steps;
  assert.equal(st[0].with.ref, "${{ github.event.pull_request.base.sha }}");  // доверенная версия скрипта
  assert.equal(st[0].with["persist-credentials"], false);
  assert.ok(st.every((x) => !/npm|pnpm|pytest|python|make|\.\/|bash .*\.sh/.test(x.run ?? "")), "код PR не исполняется");
  assert.match(st.at(-1).run, /node scripts\/security-guard\.mjs "\$BASE" "\$HEAD_SHA"/);
  const ci = parse(readFileSync(join(root, ".github/workflows/ci-gate.yml"), "utf8"));
  const names = ci.jobs.gate.steps.map((x) => x.name ?? x.uses ?? "");
  const push = ci.jobs.gate.steps.find((x) => /страж настроек безопасности/.test(x.name ?? ""));
  assert.ok(push && names.indexOf(push.name) < names.indexOf("gitleaks"));
  assert.equal(push.if, "${{ github.event_name == 'push' && !(github.ref == 'refs/heads/main' && github.actor == github.repository_owner) }}");
  assert.match(push.run, /security-guard\.mjs "\$BASE"/);
  assert.doesNotMatch(push.run, /\|\| *git rev-list|\|\| *true/, "без запасного пути, открывающего проверку");
  const owners = readFileSync(join(root, ".github/CODEOWNERS"), "utf8");
  for (const p of ["/.gitleaksignore", "/.gitleaks.toml", "/.github/", "/scripts/security-guard.mjs", "/CODEOWNERS", "/docs/CODEOWNERS"]) assert.match(owners, new RegExp(`^${p.replace(/[.]/g, "\\.")} @almazrobots$`, "m"));
});

// ─── T-107, аудит БД 2026-09-26: роли наименьших привилегий, служба миграций, TLS до базы, сеть, журнал сервера ───
test("HIGH-1: API — роль inspector_app без суперпользовательского секрета; миграции — одноразовая api-migrate", () => {
  const { api, "api-migrate": mig, postgres: pg } = compose.services;
  assert.match(api.environment.INSPECTOR_DATABASE_URL, /^postgres:\/\/inspector_app@postgres:5432\/inspector$/);
  assert.deepEqual(api.secrets, ["pg_app_password", "rabbitmq_password", "blob_encryption_key", "ukep_cert", "ukep_key"], "api получает только пароль своей роли, брокера, ключ хранения блобов (NFR-CRYPTO) и пару подписи запросов к «РиН» (NFR-UKEP)");
  // SEC-07: пароль брокера не в окружении ни API, ни брокера
  assert.match(api.environment.INSPECTOR_AMQP_URL, /^amqps:\/\/inspector@rabbitmq:5671$/);
  assert.equal(api.environment.INSPECTOR_AMQP_PASSWORD_FILE, "/run/secrets/rabbitmq_password");
  assert.ok(!Object.keys(compose.services.rabbitmq.environment ?? {}).some((k) => /PASS/.test(k)), "брокер: пароль не переменной окружения");
  assert.ok(compose.services.rabbitmq.volumes.some((v) => v.endsWith(":/etc/rabbitmq/conf.d/10-auth.conf:ro")));
  assert.equal(api.depends_on["api-migrate"]?.condition, "service_completed_successfully", "api стартует после успешных миграций");
  assert.equal(api.depends_on.postgres?.condition, "service_healthy");
  assert.ok(mig, "нет службы api-migrate");
  assert.equal(mig.image, api.image, "api-migrate — тот же образ, что api");
  assert.deepEqual(mig.command, ["node", "apps/api/dist/migrate.mjs"]);
  assert.equal(mig.restart, "no", "служба миграций одноразовая");
  assert.match(mig.environment.INSPECTOR_DATABASE_URL, /^postgres:\/\/inspector_migrator@postgres:5432\/inspector$/);
  assert.deepEqual(mig.secrets.sort(), ["bootstrap_admin_password", "pg_migrator_password"]);
  assert.equal(mig.depends_on.postgres?.condition, "service_healthy");
  assert.ok(!mig.volumes.some((v) => /server\.key|:\/run\/tls:ro$/.test(v)), "api-migrate не видит ключ TLS API");
  for (const [name, s] of services) {
    if (name !== "postgres") assert.ok(!(s.secrets ?? []).includes("pg_superuser_password"), `${name}: секрет суперпользователя только у postgres`);
  }
  assert.equal(pg.environment.POSTGRES_USER, "postgres", "бутстрап-суперпользователь — postgres, не роль приложения");
  assert.equal(pg.environment.POSTGRES_PASSWORD_FILE, "/run/secrets/pg_superuser_password");
  assert.ok(pg.volumes.includes("./postgres/init:/docker-entrypoint-initdb.d:ro"), "роли создаёт init-скрипт");
  const init = readFileSync(join(dir, "postgres/init/10-roles.sh"), "utf8");
  for (const re of [
    /create role inspector_owner nologin/, /create role inspector_migrator login nosuperuser/,
    /create role inspector_app login nosuperuser nocreatedb nocreaterole noreplication nobypassrls/, /grant inspector_owner to inspector_migrator/,
    /revoke all on database inspector from public/, /create schema inspector authorization inspector_owner/,
    /alter default privileges for role inspector_owner in schema inspector grant select, insert, update, delete on tables to inspector_app/,
    /alter role inspector_migrator set role = inspector_owner/, /alter role inspector_app set search_path = inspector/,
    /set log_statement = 'none'/,
  ]) assert.match(init, re);
  assert.doesNotMatch(init, /grant (create|all)[^;]*schema inspector[^;]*to inspector_app/, "API без CREATE в схеме");
  assert.doesNotMatch(init, /psql[^\n]*-v [a-z_]*pw=/, "пароль не в argv psql");
});

test("HIGH-4, NFR-CRYPTO: ML не монтирует api-data и шифротекст api-blobs; читает открытый текст из tmpfs blob-work по тому же пути", () => {
  const { api, ml } = compose.services;
  for (const [name, s] of services) assert.ok(!(s.volumes ?? []).some((v) => v.startsWith("api-data:")), `${name}: том api-data упразднён`);
  assert.ok(ml.volumes.includes("blob-work:/app/var/blobs:ro"), "ml читает выложенные файлы только на чтение");
  assert.deepEqual(ml.volumes.filter((v) => !v.startsWith("blob-work:")), ["${TLS_DIR:?}:/run/tls:ro"], "кроме рабочего каталога у ML только TLS стенда, на чтение");
  assert.ok(!ml.volumes.some((v) => v.startsWith("api-blobs:")), "шифротекст тома блобов ML не нужен и не виден");
  assert.ok(api.volumes.includes("api-blobs:/app/var/blobs"));
  assert.ok(api.volumes.includes("blob-work:/app/var/blob-work"));
  assert.equal(api.environment.INSPECTOR_BLOB_WORK_DIR, "/app/var/blob-work");
  assert.equal(api.environment.INSPECTOR_BLOB_KEY_FILE, "/run/secrets/blob_encryption_key");
  assert.match(compose.secrets.blob_encryption_key.file, /^\$\{BLOB_ENCRYPTION_KEY_FILE:\?/, "ключ хранения — файлом, путь обязателен");
  assert.equal(compose.volumes["blob-work"].driver_opts.type, "tmpfs", "открытый текст для ML — только в памяти");
  for (const [name, s] of services) if (name !== "api") assert.ok(!(s.secrets ?? []).includes("blob_encryption_key"), `${name}: ключ хранения только у api`);
  assert.equal(ml.environment.INSPECTOR_BLOB_DIR, "/app/var/blobs", "ML читает файлы по прежнему пути — там смонтирован blob-work");
  assert.ok(compose.volumes["api-blobs"] !== undefined && compose.volumes["api-data"] === undefined);
  assert.ok(!Object.keys(api.environment).includes("INSPECTOR_DEMO_PASSWORD"), "демо-пароля в gpu нет");
  for (const f of ["apps/api/Dockerfile", "ml/Dockerfile"]) {
    const df = dockerfiles.find(([n]) => n === f)[1];
    assert.match(df, /mkdir -p \/app\/var\/blobs && chown (node:node \/app\/var |1000:1000 )\/app\/var\/blobs/, `${f}: точка монтирования тома блобов принадлежит uid API`);
  }
  assert.match(dockerfiles.find(([n]) => n === "apps/api/Dockerfile")[1], /esbuild apps\/api\/src\/server\.ts apps\/api\/src\/migrate\.ts/, "migrate.mjs собирается в образ");
});

test("M-1: postgres — TLS 1.3, свой pg_hba (без TLS — reject); клиенты проверяют сертификат по CA", () => {
  const { api, "api-migrate": mig, postgres: pg } = compose.services;
  const cmd = pg.command.join(" ");
  for (const o of ["ssl=on", "ssl_min_protocol_version=TLSv1.3", "hba_file=/etc/postgresql/pg_hba.conf", "ssl_cert_file=/run/pg-tls/", "ssl_key_file=/run/pg-tls/"]) assert.ok(cmd.includes(o), `postgres: нет ${o}`);
  assert.ok(pg.volumes.some((v) => /^\$\{PG_TLS_DIR:\?[^}]*\}:\/run\/pg-tls:ro$/.test(v)));
  const hba = readFileSync(join(dir, "postgres/pg_hba.conf"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim().split(/\s+/));
  assert.ok(!hba.some((r) => r.includes("trust")), "pg_hba: без trust");
  assert.ok(hba.filter((r) => r[0] === "host" || r[0] === "hostssl").every((r) => r.at(-1) === "reject" || (r[0] === "hostssl" && r.at(-1) === "scram-sha-256")), "сеть: только hostssl + scram");
  assert.ok(hba.some((r) => r[0] === "hostnossl" && r.at(-1) === "reject"));
  assert.ok(!hba.some((r) => r[0] === "hostssl" && /postgres|all/.test(r[2])), "суперпользователь по сети не входит");
  for (const s of [api, mig]) assert.equal(s.environment.INSPECTOR_DATABASE_SSL_CA_FILE, "/run/tls/ca.crt");
});

test("M-8: база — в сети db с internal: true: только postgres, api, api-migrate; postgres не в сети с выходом наружу", () => {
  assert.equal(compose.networks.db?.internal, true);
  const inDb = services.filter(([, s]) => nets(s).includes("db")).map(([n]) => n).sort();
  assert.deepEqual(inDb, ["api", "api-migrate", "postgres"]);
  assert.deepEqual(compose.services.postgres.networks, ["db"]);
  assert.deepEqual(compose.services["api-migrate"].networks, ["db"]);
  assert.ok(!compose.services.postgres.ports, "postgres наружу не публикуется");
});

test("M-9: postgres журналирует подключения, отключения, DDL и ошибки; логи — в Logstash; не log_statement=all", () => {
  const pg = compose.services.postgres;
  const cmd = pg.command.join(" ");
  for (const o of ["log_connections=on", "log_disconnections=on", "log_statement=ddl", "log_min_error_statement=error"]) assert.ok(cmd.includes(o), `postgres: нет ${o}`);
  assert.match(cmd, /log_line_prefix=[^ ]*.*%u.*%d.*%a/, "в префиксе пользователь, база, приложение");
  assert.doesNotMatch(cmd, /log_statement=(all|mod)/);
  for (const name of ["postgres", "api-migrate"]) assert.equal(compose.services[name].logging?.driver, "gelf", `${name}: логи не уходят в Logstash`);
});

// ─── NFR-STAND (T-129): стенд одной командой — deploy/stand/compose.yml ───
const standDir = join(root, "deploy/stand");
const standText = readFileSync(join(standDir, "compose.yml"), "utf8");
const stand = parse(standText, { merge: true });
const standServices = Object.entries(stand.services);
const oneShot = new Set(["api-migrate", "minio-init"]);
const ownImage = { API_IMAGE: "apps/api/Dockerfile", ML_IMAGE: "ml/Dockerfile", ML_GPU_IMAGE: "ml/Dockerfile", WEB_IMAGE: "apps/web/Dockerfile" };
const dockerfileOf = (image) => ownImage[/^\$\{([A-Z_]+_IMAGE):\?/.exec(image)?.[1]];

test("стенд: образы — ${…_IMAGE:?} или имя@sha256; сборки нет; сторонние в images.env закреплены по digest", () => {
  for (const [name, s] of standServices) {
    assert.match(s.image, /^(\$\{[A-Z_]+_IMAGE:\?[^}]*\}|[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64})$/, `${name}: образ ${s.image}`);
    assert.equal(s.build, undefined, `${name}: build на хосте запрещён (ADR-0005)`);
  }
  const env = readFileSync(join(standDir, "images.env"), "utf8");
  const pinned = [...env.matchAll(/^([A-Z_]+_IMAGE)=(\S*)/gm)];
  assert.ok(pinned.length >= 2, "images.env: postgres и minio");
  for (const [, k, v] of pinned) assert.match(v, /^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${k}: не по digest — ${v}`);
  const gpuPg = readFileSync(join(dir, ".env.example"), "utf8").match(/^POSTGRES_IMAGE=(\S+)/m)[1];
  assert.equal(env.match(/^POSTGRES_IMAGE=(\S+)/m)[1], gpuPg, "postgres стенда — тот же digest, что в gpu");
  // свои образы — только из stand.sh build (тег sha), сторонние переменные — все из images.env
  const vars = new Set([...standText.matchAll(/\$\{([A-Z_]+_IMAGE):\?/g)].map((m) => m[1]));
  for (const v of vars) assert.ok(ownImage[v] || pinned.some(([, k]) => k === v), `${v}: ни свой образ, ни закреплённый`);
});

test("стенд: у каждого долгоживущего сервиса healthcheck (compose или HEALTHCHECK Dockerfile); одноразовые — без", () => {
  for (const [name, s] of standServices) {
    if (oneShot.has(name)) {
      assert.equal(s.restart, "no", `${name}: одноразовая служба не перезапускается`);
      continue;
    }
    assert.notEqual(s.healthcheck?.disable, true, `${name}: проверка выключена`);
    const df = dockerfileOf(s.image);
    const inCompose = Array.isArray(s.healthcheck?.test) && s.healthcheck.test.length > 1;
    const inImage = df && /^HEALTHCHECK [^\n]*\\?\n?\s*CMD \[/m.test(readFileSync(join(root, df), "utf8"));
    assert.ok(inCompose || inImage, `${name}: нет healthcheck`);
  }
});

test("стенд: depends_on — только service_healthy / service_completed_successfully; api ждёт миграции, базу и ML", () => {
  for (const [name, s] of standServices) {
    if (!s.depends_on) continue;
    assert.ok(!Array.isArray(s.depends_on), `${name}: depends_on списком = service_started`);
    for (const [dep, c] of Object.entries(s.depends_on)) {
      assert.ok(stand.services[dep], `${name}: зависимость от несуществующего ${dep}`);
      const want = oneShot.has(dep) ? "service_completed_successfully" : "service_healthy";
      assert.equal(c.condition, want, `${name} → ${dep}: ${c.condition}`);
    }
  }
  const api = stand.services.api.depends_on;
  assert.deepEqual(Object.keys(api).sort(), ["api-migrate", "minio-init", "ml", "postgres", "rabbitmq"]); // ТЗ 1.5: очередь разбора
  assert.equal(api["minio-init"].required, false, "без профиля minio API всё равно стартует");
  assert.equal(stand.services.web.depends_on.api.condition, "service_healthy");
});

test("стенд: hardening — read_only, cap_drop ALL, no-new-privileges, pids_limit; не root; порты 127.0.0.1 и > 40000", () => {
  for (const [name, s] of standServices) {
    // брокер пишет в собственный каталог и конфиг Erlang — единственное исключение, как в профиле gpu
    if (name !== "rabbitmq") assert.equal(s.read_only, true, `${name}: корень ФС не только для чтения`);
    assert.deepEqual(s.cap_drop, ["ALL"], name);
    assert.equal(s.cap_add, undefined, `${name}: cap_add`);
    assert.ok(s.security_opt?.includes("no-new-privileges:true"), name);
    assert.ok(s.pids_limit > 0, name);
    assert.ok(!["root", "0", "0:0"].includes(String(s.user ?? "")), `${name}: под root`);
    if (!dockerfileOf(s.image) && name !== "postgres") assert.match(String(s.user ?? ""), /^[1-9]\d*:\d+$/, `${name}: сторонний образ — явный uid:gid не root`);
    for (const p of s.ports ?? []) {
      const m = /^127\.0\.0\.1:(\d+):\d+$/.exec(p);
      assert.ok(m, `${name}: порт наружу ${p}`);
      assert.ok(Number(m[1]) > 40000, `${name}: порт ${m[1]} ≤ 40000 (чужие service worker)`);
    }
  }
  const published = standServices.filter(([, s]) => s.ports).map(([n]) => n);
  assert.deepEqual(published, ["web"], "единственный вход — web; API, ML, база и MinIO наружу не публикуются");
  assert.equal(stand.services.web.user, "101:101");
});

test("стенд: секреты — только файлами (compose secrets), в environment нет паролей и ключей", () => {
  const sensitive = /PASSWORD|SECRET|TOKEN|ACCESS_KEY|_KEY$|PRIVATE/;
  for (const [name, s] of standServices) {
    for (const [k, v] of Object.entries(s.environment ?? {})) {
      if (!sensitive.test(k)) continue;
      assert.match(k, /_FILE$|^INSPECTOR_(ML_)?TLS_KEY$/, `${name}: ${k} — секрет в переменной окружения`);
      assert.match(String(v), /^\/run\//, `${name}: ${k} — не путь к смонтированному файлу`);
    }
    for (const sec of s.secrets ?? []) assert.ok(stand.secrets[sec], `${name}: секрет ${sec} не объявлен`);
  }
  for (const [k, s] of Object.entries(stand.secrets)) assert.match(s.file, /^\$\{(STAND_VAR|S3_SECRETS_DIR):\?[^}]*\}\//, `${k}: файл вне var/stand`);
  assert.deepEqual(stand.services.api.secrets.sort(), ["pg_app_password", "rabbitmq_password", "s3_access_key_id", "s3_encryption_key", "s3_secret_access_key"]);
  // SEC-07 (OWASP-аудит T-129): адрес брокера без пароля; ни у одного сервиса нет env_file с паролем брокера
  assert.match(stand.services.api.environment.INSPECTOR_AMQP_URL, /^amqps:\/\/inspector@rabbitmq:5671$/);
  for (const [name, s] of standServices) for (const f of [s.env_file ?? []].flat()) assert.doesNotMatch(String(f), /amqp\.env|rabbitmq\.env/, `${name}: пароль брокера в env_file`);
  assert.ok(stand.services.rabbitmq.volumes.some((v) => v.endsWith("/rabbitmq-auth.conf:/etc/rabbitmq/conf.d/10-auth.conf:ro")));
  assert.ok(!(stand.services.ml.secrets ?? []).length, "ML не получает ни одного секрета (OWASP H3)");
  for (const [name, s] of standServices) if (name !== "postgres") assert.ok(!(s.secrets ?? []).includes("pg_superuser_password"), `${name}: суперпользователь postgres`);
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^var\/stand\/$/m, "секреты стенда вне git");
});

test("стенд: блобы — общий том api-blobs (api rw, ml ro); ML без выхода наружу; база — в сети db internal", () => {
  const { api, ml } = stand.services;
  assert.ok(api.volumes.includes("api-blobs:/app/var/blobs"));
  assert.ok(ml.volumes.includes("api-blobs:/app/var/blobs:ro"));
  assert.equal(api.environment.INSPECTOR_BLOB_DIR, ml.environment.INSPECTOR_BLOB_DIR);
  assert.equal(api.environment.INSPECTOR_ML_TIMEOUT_MS, "1800000", "большие PDF на CPU: API ждёт ML 30 минут");
  assert.equal(stand.networks.backend.internal, true);
  assert.equal(stand.networks.db.internal, true);
  assert.deepEqual(ml.networks, ["backend"], "ML разбирает недоверенные PDF — без маршрута наружу");
  const inDb = standServices.filter(([, s]) => (s.networks ?? []).includes("db")).map(([n]) => n).sort();
  assert.deepEqual(inDb, ["api", "api-migrate", "postgres"]);
  assert.deepEqual(stand.services.minio.profiles, ["minio"]);
  assert.deepEqual(stand.services["minio-init"].profiles, ["minio"]);
});

test("NFR-TLS-INTERNAL: в compose стенда и gpu между сервисами нет http://, amqp://, redis://", () => {
  for (const [label, text] of [["stand", standText], ["gpu", readFileSync(join(dir, "compose.yml"), "utf8")]]) {
    const code = text.replace(/(^|\s)#[^\n]*/g, "$1");
    for (const m of code.matchAll(/\b(http|amqp|redis|postgres):\/\/[^\s'"]*/g)) {
      assert.equal(m[1], "postgres", `${label}: открытый текст ${m[0]}`);
    }
  }
  // postgres:// — схема адреса pg-клиента; TLS 1.3 verify-full задаёт INSPECTOR_DATABASE_SSL_CA_FILE (M-1)
  for (const s of [stand.services.api, stand.services["api-migrate"]]) assert.equal(s.environment.INSPECTOR_DATABASE_SSL_CA_FILE, "/run/tls/ca.crt");
  const { api, ml } = stand.services;
  assert.equal(api.environment.INSPECTOR_ML_URL, "https://ml:8811");
  assert.equal(api.environment.INSPECTOR_ML_CA_FILE, "/run/tls/ca.crt");
  assert.ok(ml.environment.INSPECTOR_ML_TLS_CERT && ml.environment.INSPECTOR_ML_TLS_KEY, "ML слушает HTTPS");
  const gpu = compose.services;
  assert.equal(gpu.api.environment.INSPECTOR_ML_URL, "https://ml:8811");
  assert.equal(gpu.api.environment.INSPECTOR_ML_CA_FILE, "/run/tls/ca.crt");
  assert.ok(gpu.ml.environment.INSPECTOR_ML_TLS_CERT, "gpu: ML слушает HTTPS");
  const rmq = readFileSync(join(dir, "rabbitmq/20-tls.conf"), "utf8");
  assert.match(rmq, /^listeners\.tcp = none$/m, "RabbitMQ: открытый AMQP выключен");
  assert.match(rmq, /^listeners\.ssl\.default = 5671$/m);
  assert.match(rmq, /^ssl_options\.versions\.1 = tlsv1\.3$/m);
  assert.ok(gpu.rabbitmq.volumes.includes("./rabbitmq/20-tls.conf:/etc/rabbitmq/conf.d/20-tls.conf:ro"));
  assert.ok(gpu.redis.command.includes("--tls-port") && gpu.redis.command.join(" ").includes("--port 0"), "Redis: только TLS");
  assert.equal(gpu.elasticsearch.environment["xpack.security.http.ssl.enabled"], "true");
  // ML: минимум TLS 1.3 задаётся в точке входа образа; без сертификата — HTTP (dev и тесты)
  const serve = readFileSync(join(root, "ml/serve.py"), "utf8");
  assert.match(serve, /minimum_version = ssl\.TLSVersion\.TLSv1_3/);
  assert.match(readFileSync(join(root, "ml/Dockerfile"), "utf8"), /^CMD \["python", "serve\.py"\]$/m);
});

test("gpu: зависимые стартуют после healthy; у rabbitmq, redis, clamav, postgres — healthcheck", () => {
  const gpu = compose.services;
  for (const n of ["rabbitmq", "redis", "clamav", "postgres"]) assert.ok(gpu[n].healthcheck?.test?.length > 1, `${n}: нет healthcheck`);
  for (const [dep, c] of Object.entries(gpu.api.depends_on)) assert.match(c.condition, /^service_(healthy|completed_successfully)$/, `api → ${dep}`);
  assert.equal(gpu.web.depends_on.api.condition, "service_healthy");
  assert.equal(gpu.ml.depends_on.redis.condition, "service_healthy");
  assert.equal(gpu["api-migrate"].healthcheck?.disable, true);
});

test("Dockerfile api, ml, web: HEALTHCHECK без новых пакетов — node, python stdlib, curl базового nginx", () => {
  const hc = (f) => readFileSync(join(root, f), "utf8").match(/^HEALTHCHECK [^\n]*\\\n\s*CMD (\[[^\n]*\])$/m)?.[1];
  const api = JSON.parse(hc("apps/api/Dockerfile"));
  assert.deepEqual(api.slice(0, 2), ["node", "-e"]);
  assert.match(api[2], /INSPECTOR_HEALTH_CA_FILE/, "api: корень доверия из переменной");
  assert.match(api[2], /host:'127\.0\.0\.1'/, "api: отключение проверки допустимо только на петле");
  const ml = JSON.parse(hc("ml/Dockerfile"));
  assert.deepEqual(ml.slice(0, 2), ["python", "-c"]);
  assert.match(ml[2], /urllib/);
  assert.match(ml[2], /127\.0\.0\.1:8811\/health/);
  const web = JSON.parse(hc("apps/web/Dockerfile"));
  assert.equal(web[0], "curl");
  assert.ok(web.includes("https://127.0.0.1:8443/"), "web: своя статика, не /health (каскад от API)");
  for (const f of ["apps/api/Dockerfile", "ml/Dockerfile", "apps/web/Dockerfile"]) {
    const runtime = readFileSync(join(root, f), "utf8").split(/\nFROM /).pop();
    assert.doesNotMatch(runtime, /(?:apk add|apt-get install -y)[^\n]*\b(?:curl|wget)\b/, `${f}: пакеты ради проверки живости`);
  }
});

test("гейт: hadolint трёх Dockerfile закреплённым по digest образом — до docker build; статическая проверка стенда", () => {
  const gate = readFileSync(join(root, "scripts/local-gate.sh"), "utf8");
  const lint = gate.indexOf("hadolint/hadolint");
  assert.ok(lint > 0, "в гейте нет hadolint");
  assert.match(gate, /hadolint\/hadolint:[\w.-]+@sha256:[0-9a-f]{64}/, "hadolint — по digest");
  assert.ok(lint < gate.indexOf("docker build --build-arg"), "hadolint — до сборки");
  for (const f of ["apps/api/Dockerfile", "ml/Dockerfile", "apps/web/Dockerfile"]) assert.ok(gate.includes(f), `гейт не линтует ${f}`);
  assert.match(gate, /docker compose[^\n]*deploy\/stand\/compose\.yml[^\n]*config/, "гейт проверяет compose стенда");
});

test("stand.sh: build под heavy.sh, диск ≥ 20 ГБ, очистка только своих сборок и кэша; тома — только с --wipe; ключ шифрования не перезаписывается", () => {
  const sh = readFileSync(join(root, "scripts/stand.sh"), "utf8");
  const code = sh.replace(/#[^\n]*/g, "");
  // T-130 (владелец 27.09): автоочистка — только кэш сборки с потолком и образы inspector-*; тома, чужие образы и
  // контейнеры не трогаются никогда (прежний запрет «никаких prune» сужен до этого инварианта)
  for (const m of code.matchAll(/docker [a-z]+ prune[^\n]*/g)) assert.match(m[0], /^docker builder prune -f --max-used-space /, `запрещённая очистка: ${m[0]}`);
  assert.doesNotMatch(code, /(volume|system|image|container|network) prune/, "никаких prune томов, системы, образов, контейнеров");
  for (const m of code.matchAll(/docker image rm [^\n]*/g)) assert.match(m[0], /^docker image rm "inspector-\$img:\$tag"/, `удаление чужого образа: ${m[0]}`);
  assert.match(sh, /-ge 20 \]/, "проверка диска ≥ 20 ГБ");
  assert.match(sh, /building-tech-heavy\.lock/, "build — только под замком heavy.sh");
  const downV = [...sh.matchAll(/down -v/g)];
  assert.equal(downV.length, 1, "down -v — ровно в ветке --wipe");
  assert.match(sh, /"--wipe" \][^\n]*\n[^\n]*\n\s*compose_all down -v/);
  assert.match(sh, /secret_file "\$SEC\/s3_encryption_key"/);
  assert.match(sh, /\[ -s "\$1" \] && return 0/, "существующий секрет не перезаписывается");
  assert.match(sh, /--build-arg REVISION="\$rev"/);
});

test("web: воркер PDF.js (.mjs) отдаётся как JavaScript — иначе при nosniff лист на экране верификации не рисуется (T-129)", () => {
  const conf = readFileSync(join(root, "apps/web/nginx.conf"), "utf8");
  const loc = conf.match(/location ~\* \\\.mjs\$ \{([^}]*)\}/);
  assert.ok(loc, "нет location для .mjs");
  assert.match(loc[1], /default_type text\/javascript;/);
  assert.doesNotMatch(loc[1], /add_header/, "add_header в location отменил бы CSP и остальные заголовки server");
  assert.match(conf, /X-Content-Type-Options[^;]*nosniff/, "nosniff остаётся");
});

test("gpu + compose.s3.yml: блобы в S3 по https, ключи только файлами, без надстройки — том (ADR-0006, T-129)", () => {
  const s3 = parse(readFileSync(join(root, "deploy/gpu/compose.s3.yml"), "utf8"));
  const env = s3.services.api.environment;
  assert.equal(env.INSPECTOR_BLOB_STORE, "s3");
  assert.match(env.INSPECTOR_S3_ENDPOINT, /^\$\{S3_ENDPOINT:-https:\/\//, "хранилище только по https (NFR-TLS-INTERNAL, SEC-09)");
  for (const k of ["INSPECTOR_S3_ACCESS_KEY_ID_FILE", "INSPECTOR_S3_SECRET_ACCESS_KEY_FILE", "INSPECTOR_S3_KEY_FILE"]) assert.match(env[k], /^\/run\/secrets\//, k);
  assert.ok(!Object.keys(env).some((k) => /SECRET_ACCESS_KEY$|ACCESS_KEY_ID$/.test(k)), "ключи — не переменными окружения");
  for (const sec of ["s3_access_key_id", "s3_secret_access_key", "s3_encryption_key"]) {
    assert.ok(s3.services.api.secrets.includes(sec), sec);
    assert.match(s3.secrets[sec].file, /^\$\{S3_[A-Z_]+_FILE:\?/, `${sec}: путь к файлу обязателен`);
  }
  // надстройка не теряет секреты базового файла при слиянии списков
  for (const sec of compose.services.api.secrets) assert.ok(s3.services.api.secrets.includes(sec), `потерян секрет ${sec}`);
  assert.equal(compose.services.api.environment.INSPECTOR_BLOB_STORE, undefined, "без надстройки — том");
});

// ─── T-130: ML на маке — compose.ml-host.yml поверх compose.yml (stand.sh up --ml-host) ───
test("стенд --ml-host: контейнер ml не поднимается, API → https://host.docker.internal:8811, блобы — каталог мака", () => {
  const text = readFileSync(join(standDir, "compose.ml-host.yml"), "utf8");
  const o = parse(text, { merge: true, customTags: [{ tag: "!override", resolve: (v) => v, collection: "seq" }, { tag: "!override", resolve: (v) => v, collection: "map" }] });
  assert.deepEqual(o.services.ml.profiles, ["ml-docker"], "контейнер ml только в явном профиле");
  const api = o.services.api;
  assert.equal(api.environment.INSPECTOR_ML_URL, "https://host.docker.internal:8811", "NFR-TLS-INTERNAL: к ML на маке — тоже https");
  assert.equal(api.environment.INSPECTOR_PARSE_CONCURRENCY, "1", "одна модель за раз");
  assert.match(text, /volumes: !override/);
  assert.match(text, /depends_on: !override/);
  const vols = api.volumes.items ? api.volumes.items.map((x) => x.value ?? x) : api.volumes;
  assert.ok(vols.some((v) => String(v) === "${STAND_VAR:?}/blobs:/app/var/blobs"), "блобы — каталог var/stand/blobs");
  assert.ok(vols.some((v) => String(v).endsWith("/tls/api:/run/tls:ro")), "TLS API сохранён");
  const deps = Object.keys(api.depends_on.items ? Object.fromEntries(api.depends_on.items.map((p) => [String(p.key), 1])) : api.depends_on);
  assert.ok(!deps.includes("ml"), "API не ждёт контейнер ml");
  assert.ok(["postgres", "api-migrate", "rabbitmq"].every((d) => deps.includes(d)));
  assert.equal(api.ports, undefined, "наружу по-прежнему только web");
  for (const k of Object.keys(api.environment)) assert.doesNotMatch(k, /PASSWORD|SECRET|TOKEN|ACCESS_KEY/, `секрет в окружении: ${k}`);
  const sh = readFileSync(join(root, "scripts/stand.sh"), "utf8");
  assert.match(sh, /cert host\.docker\.internal "\$TLS\/ml-host"/, "сертификат ML на маке с SAN host.docker.internal");
});

test("демо-стенд «Надзориум» (T-131): только чтение, лимиты памяти, наружу только 127.0.0.1, секреты файлами, база в закрытой сети", () => {
  const demo = parse(readFileSync(join(root, "deploy/demo/compose.yml"), "utf8"), { merge: true });
  const s = demo.services;
  assert.deepEqual(Object.keys(s).sort(), ["api", "api-migrate", "postgres", "web"], "без ML, очереди и антивируса: сервер ничего не разбирает");
  assert.equal(s.api.environment.INSPECTOR_READONLY, "1");
  assert.equal(s.api.environment.INSPECTOR_BLOB_STORE, "s3");
  assert.match(s.api.environment.INSPECTOR_S3_ENDPOINT, /^https:\/\//);
  for (const [name, svc] of Object.entries(s)) {
    assert.ok(svc.mem_limit, `${name}: нет лимита памяти (на хосте PINATOR LIVE)`);
    assert.equal(svc.read_only, true, `${name}: корень ФС не только для чтения`);
    assert.deepEqual(svc.cap_drop, ["ALL"], name);
    for (const [k, v] of Object.entries(svc.environment ?? {})) if (/PASSWORD$|SECRET|ACCESS_KEY$|_KEY$/.test(k) && !String(v).startsWith("/run/")) assert.fail(`${name}: ${k}=${v} — секрет в окружении`);
  }
  const total = Object.values(s).reduce((n, svc) => n + parseInt(svc.mem_limit) * (String(svc.mem_limit).endsWith("g") ? 1024 : 1), 0);
  assert.ok(total <= 1280, `сумма лимитов ${total} МБ > 1,25 ГБ`);
  assert.deepEqual(s.web.ports, ["127.0.0.1:45900:8443"], "наружу — только через host-Caddy");
  for (const name of ["api", "api-migrate", "postgres"]) assert.ok(!s[name].ports, `${name}: порт наружу`);
  assert.equal(demo.networks.db.internal, true);
  assert.ok(s.web.volumes.some((v) => v.endsWith(":/usr/share/nginx/html/docs:ro")), "материалы — только чтение");
  const sh = readFileSync(join(root, "scripts/demo.sh"), "utf8");
  assert.match(sh, /heavy\.lock/, "сборка образов — только под замком heavy.sh");
  assert.match(sh, /--data-only/, "публикация передаёт данные, схему создаёт служба миграций того же образа");
  assert.match(sh, /схема мака и демо-стенда разошлась/, "сверка миграций до восстановления");
});

test("демо-стенд «Надзориум» (T-152, NFR-DEMO-ACCESS): пароль прокси на весь сайт, кроме /api/* и /health; хеш не в git", () => {
  const vhost = readFileSync(join(root, "deploy/demo/Caddyfile.nadzorium"), "utf8");
  const code = vhost.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(code, /@locked not path \/api\/\* \/health/, "исключения — только API (свой вход по Bearer) и /health");
  assert.match(code, /basic_auth @locked bcrypt/, "пароль прокси снят — ФИО и подписи в документах открыты любому с учёткой приложения (E2-H2)");
  assert.match(code, /import \/etc\/caddy\/nadzorium-users\.caddy/, "хеш пароля — файлом на сервере");
  assert.doesNotMatch(vhost, /\$2[aby]\$/, "bcrypt-хеш в git");
  const sh = readFileSync(join(root, "scripts/demo.sh"), "utf8");
  assert.match(sh, /caddy validate --config "\$t\/Caddyfile"/, "общий Caddy с PINATOR LIVE: validate до reload");
  assert.match(sh, /mktemp -d -p \/root[^\n]*chmod 700[^\n]*trap/, "промежуточные файлы — в приватном каталоге root с уборкой (OWASP-0112)");
  assert.doesNotMatch(sh.slice(sh.indexOf("cmd_access()"), sh.indexOf("cmd_status()")), /\/tmp\//, "фиксированные пути в общем /tmp под root — подмена через симлинк (OWASP-0112)");
  assert.match(sh, /systemctl reload caddy/, "мягкая перезагрузка, не restart");
  assert.match(sh, /curl -s -K -/, "пароль прокси не попадает в argv");
  assert.match(sh, /api\/v1\/auth\/guest[^\n]*40\[34\]/, "выкат проверяет, что гостевой вход выключен");
  assert.match(sh, /NFR-DEMO-CONTENT[\s\S]*code != data/, "status сверяет ревизию данных с ревизией кода демо");
});

test("demo.sh status (T-152, NFR-DEMO-CONTENT): сверка ревизий исполняется, а не только присутствует — расхождение даёт ⚠", async () => {
  const { execFileSync } = await import("node:child_process");
  const sh = readFileSync(join(root, "scripts/demo.sh"), "utf8");
  const body = sh.slice(sh.indexOf("cmd_status()"));
  const code = body.slice(body.indexOf("python3 -c '") + "python3 -c '".length, body.indexOf("\n'\n"));
  const run = (h, p) => execFileSync("python3", ["-c", code], { input: `${JSON.stringify(h)}\n${JSON.stringify(p)}`, encoding: "utf8" });
  const same = run({ revision: "a".repeat(40), versions: { matrix: "1.1.2" } }, { revision: "a".repeat(40) + "-dirty" });
  assert.match(same, /Матрица 1\.1\.2/);
  assert.doesNotMatch(same, /⚠/, "совпадающие ревизии (включая -dirty стенда) — без предупреждения");
  const diff = run({ revision: "a".repeat(40), versions: {} }, { revision: "b".repeat(40) });
  assert.match(diff, /⚠ данные демо посчитаны не той ревизией/);
});

test("BI-дашборд (T-168): самодостаточная страница на токенах «Чертёжного бетона» — без внешних адресов, шрифты из /docs/assets, пометка о вымышленных данных", () => {
  assert.match(readFileSync(join(root, "scripts/demo-docs.mjs"), "utf8"), /"geologica-cyrillic", "geologica-latin"/, "demo-docs.mjs копирует Geologica в /docs/assets/fonts");
  const page = readFileSync(join(root, "docs/bi/dashboard.html"), "utf8");
  assert.doesNotMatch(page, /(src|href)=["']https?:/i, "внешние скрипты и стили запрещены CSP /docs");
  assert.doesNotMatch(page, /url\(["']?https?:/i, "шрифты и картинки — только свои");
  for (const f of page.matchAll(/url\(\.\.\/assets\/fonts\/([\w-]+\.woff2)\)/g)) assert.ok(existsSync(join(root, "apps/web/public/fonts", f[1])), `шрифт ${f[1]} должен быть в apps/web/public/fonts — его кладёт demo-docs.mjs`);
  assert.match(page, /--ground:#D9DDE3/, "язык «Чертёжный бетон»: подложка — холодный бетон, как в интерфейсе проверки");
  assert.match(page, /данные вымышленные/, "макет обязан говорить, что цифры ненастоящие");
  assert.doesNotMatch(page, /corpus/i, "корпус corpus-ABC — никогда (ADR-0002)");
});

test("материалы демо-стенда: явный список без корпуса corpus-ABC (ADR-0002); Markdown → HTML без сырого HTML", async () => {
  const { SECTIONS, md2html } = await import("./demo-docs.mjs");
  for (const s of SECTIONS) for (const [, , src] of s.items) {
    assert.doesNotMatch(src, /corpus|CORPUS|ТЗ\//, src);
    assert.ok(existsSync(join(root, src)), `нет ${src}`);
  }
  const { html, mermaid } = md2html("---\nid: x\n---\n# Заголовок\n\nТекст **жирный** и `код` <script>x</script>\n\n- раз\n- два\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\nflowchart LR\n```\n");
  assert.match(html, /<h1>Заголовок<\/h1>/);
  assert.match(html, /<b>жирный<\/b>/);
  assert.doesNotMatch(html, /<script>/, "сырой HTML экранируется");
  assert.match(html, /<ul><li>раз<\/li><li>два<\/li><\/ul>/);
  assert.match(html, /<th>a<\/th>/);
  assert.equal(mermaid, true);
  assert.doesNotMatch(html, /id: x/, "frontmatter не выводится");
});

test("страница дизайн-системы (T-167): самостоятельна — без внешних запросов, шрифты из /docs/assets/fonts копируются", async () => {
  const { SECTIONS } = await import("./demo-docs.mjs");
  const item = SECTIONS.flatMap((s) => s.items).find(([dst]) => dst === "design/design-system.html");
  assert.ok(item, "страница дизайн-системы в списке материалов");
  const html = readFileSync(join(root, item[2]), "utf8");
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*"https?:|url\(\s*["']?https?:|@import/i, "внешние запросы запрещены CSP /docs/");
  assert.match(html, /color-scheme:\s*light/, "только светлая тема");
  const copied = readFileSync(join(root, "scripts/demo-docs.mjs"), "utf8").match(/for \(const f of (\[[^\]]+\])\)/)[1];
  for (const [, font] of html.matchAll(/url\(\.\.\/assets\/fonts\/([\w-]+)\.woff2\)/g)) {
    assert.ok(copied.includes(`"${font}"`), `${font} не копируется в /docs/assets/fonts`);
    assert.ok(existsSync(join(root, "apps/web/public/fonts", `${font}.woff2`)), `нет шрифта ${font}`);
  }
});

test("демо-стенд: в режиме только просмотра кнопки изменений скрыты, формы пароля на входе нет (T-131)", () => {
  const css = readFileSync(join(root, "apps/web/src/styles.css"), "utf8");
  assert.match(css, /html\[data-readonly\] \[data-mutates\]/);
  const insp = readFileSync(join(root, "apps/web/src/pages/Inspection.tsx"), "utf8");
  for (const label of ["Дозагрузить", "Совпадения выборкой", "Завершить"]) {
    const i = insp.indexOf(label);
    assert.ok(i > 0 && insp.lastIndexOf("data-mutates", i) > insp.lastIndexOf("<button", i), `${label} без data-mutates`);
  }
  assert.match(readFileSync(join(root, "apps/web/src/components/DemoBanner.tsx"), "utf8"), /dataset\.readonly = "1"/);
  assert.match(readFileSync(join(root, "apps/web/src/pages/Login.tsx"), "utf8"), /\{guestOn && \(/); // кнопка гостя — только если сервер включил
});

test("демо-публикация (T-133): ревизия в publication.json — из образа запущенного API стенда мака, а не HEAD дерева", () => {
  const sh = readFileSync(join(root, "scripts/demo.sh"), "utf8");
  assert.match(sh, /stand_rev=\$\(docker inspect inspector-stand-api-1/);
  assert.doesNotMatch(sh, /stand_rev=.*git rev-parse HEAD/);
});

test("витрина демо-стенда (T-141): покрытие ТЗ кодом на главной; команда docs обновляет только материалы, база не трогается", async () => {
  const { coverageBlock } = await import("./demo-docs.mjs");
  const { auditBlock } = await import("./demo-docs.mjs");
  const cov = { built: "2026-09-27", audit: { at: "2026-09-27", history: [{ at: "2026-09-27", n: 4, real: 1, defects_open: 12 }] }, total: { n: 4, done: 3, partial: 1, none: 0, pct: 75, real: 1, realSure: 1, realPct: 25 }, prototype: { acceptedPct: 100 }, groups: [{ id: "func", title: "Функции <для> инспектора", n: 4, done: 3, pct: 75, real: 1, realPct: 25 }], sections: [{ id: "S1", group: "func", title: "Назначение", n: 4, done: 3, partial: 1, pct: 75, real: 1, realPct: 25 }] };
  // две витрины: исходная (по трассе) остаётся, контрольная (аудит критиков) — рядом, не вместо
  const html = coverageBlock(cov);
  assert.match(html, /<div class="big">75 %/, "исходная витрина — цифра по трассе");
  assert.match(html, /3 из 4/);
  const au = auditBlock(cov);
  assert.match(au, /Контрольная витрина/);
  assert.match(au, /<div class="big"[^>]*>25 %/, "контрольная — подтверждённое аудитом");
  assert.match(au, /1 из 4 · в трассе 75 %/);
  assert.match(au, /открытых дефектов 12/, "история аудитов");
  assert.match(au, /TRACE-MAP\.html\?view=audit/);
  assert.equal(auditBlock({ ...cov, audit: null }), "");
  assert.match(html, /TRACE-MAP\.html\?view=coverage/);
  assert.doesNotMatch(au, /<для>/, "названия экранируются");
  assert.equal(coverageBlock(null), "");
  const sh = readFileSync(join(root, "scripts/demo.sh"), "utf8");
  const docs = sh.slice(sh.indexOf("cmd_docs() {"), sh.indexOf("cmd_status() {"));
  assert.ok(docs.length > 0, "есть команда docs");
  assert.doesNotMatch(docs, /pg_restore|pg_dump|truncate|compose "stop/, "команда docs не трогает базу");
  assert.match(docs, /prev-publication\.json/, "сведения о данных — из прошлой публикации");
  assert.match(sh, /docs\) cmd_docs ;;/);
});

test("демо (T-131, OWASP E1-H1): API доверяет X-Forwarded-For только своим прокси — список, а не «всем»", () => {
  const demo = parse(readFileSync(join(root, "deploy/demo/compose.yml"), "utf8"), { merge: true });
  const tp = demo.services.api.environment.INSPECTOR_TRUST_PROXY;
  assert.equal(tp, "loopback, uniquelocal");
  assert.doesNotMatch(tp, /true|\*|0\.0\.0\.0\/0/);
});

test("витрина (T-141): выводы и дефекты аудита выводятся и экранируются", async () => {
  const { auditBlock: coverageBlock } = await import("./demo-docs.mjs");
  const cov = { built: "x", audit: { at: "2026-09-27", conclusions: ["Честно <35 %>"], defects: [{ id: "TZA-1", t: "дефект", task: "T-145" }] }, total: { n: 1, done: 1, partial: 0, none: 0, pct: 100, real: 0, realSure: 0, realPct: 0 }, groups: [], sections: [] };
  const html = coverageBlock(cov);
  assert.match(html, /Выводы аудита/);
  assert.match(html, /Честно &lt;35 %&gt;/);
  assert.match(html, /TZA-1<\/code> дефект <b>T-145<\/b>/);
});

test("образ API везёт печати скрытого теста: .dockerignore пропускает ml/eval/seals/*.json, Dockerfile копирует (OWASP T-137 E3-H1)", () => {
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
  const dockerfile = readFileSync(join(root, "apps/api/Dockerfile"), "utf8");
  // ml/eval исключён целиком (стенд оценки не нужен в рантайме), печати возвращены отрицанием ниже по файлу
  assert.ok(ignore.indexOf("!ml/eval/seals/*.json") > ignore.indexOf("ml/eval"), "печати исключены из контекста сборки — гарды 6.1.6/6.1.8/6.1.9 в образе слепы");
  assert.match(dockerfile, /^COPY ml\/eval\/seals ml\/eval\/seals$/m, "Dockerfile API не копирует печати скрытого теста");
});

test("NFR-IDS (ТЗ 12.9, T-138, T-090): периметр — лимиты nginx, адрес клиента без подделки, доверенный прокси API, алерты", () => {
  const ngx = readFileSync(join(root, "apps/web/nginx.conf"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(ngx, /proxy_set_header X-Forwarded-For\s+\$remote_addr;/, "XFF — только $remote_addr");
  assert.doesNotMatch(ngx, /\$proxy_add_x_forwarded_for/, "клиент не дописывает свой адрес в XFF");
  assert.match(ngx, /limit_req_zone\s+\$binary_remote_addr zone=inspector_api:\S+\s+rate=\d+r\/s;/);
  assert.match(ngx, /location \/api\/\s+\{ limit_req zone=inspector_api burst=\d+ nodelay; proxy_pass/);
  assert.match(ngx, /location = \/api\/v1\/auth\/login \{ limit_req zone=inspector_login /);
  assert.match(ngx, /limit_conn\s+inspector_conn \d+;/);
  assert.match(ngx, /client_header_timeout\s+\d+s;/, "медленные клиенты не держат воркеры");
  for (const loc of ngx.matchAll(/location[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(loc[1], /add_header/, "add_header в location отменяет унаследованные");
  const web = compose.services.web;
  const ip = web.networks.internal.ipv4_address;
  assert.equal(compose.services.api.environment.INSPECTOR_TRUST_PROXY, ip, "API доверяет XFF только от web");
  assert.equal(compose.services.api.environment.INSPECTOR_IDS, "on");
  const [net] = compose.networks.internal.ipam.config;
  assert.equal(ip.split(".").slice(0, 3).join("."), net.subnet.split(".").slice(0, 3).join("."), "адрес web — в подсети internal");
  // R2 T-138 E1-M3: адрес web вне ip_range динамической раздачи
  const [rBase, rBits] = net.ip_range.split("/");
  const toInt = (a) => a.split(".").reduce((x, o) => x * 256 + Number(o), 0);
  const mask = 2 ** 32 - 2 ** (32 - Number(rBits));
  assert.notEqual((toInt(ip) & mask) >>> 0, (toInt(rBase) & mask) >>> 0, "адрес web не входит в ip_range");
  // R2 T-138 E1-H1: адрес клиента — от прокси хоста через real_ip, последний в XFF; /health под лимитом (E1-M2)
  assert.match(ngx, /real_ip_header\s+X-Forwarded-For;/);
  assert.match(ngx, /real_ip_recursive off;/);
  assert.match(ngx, /set_real_ip_from 172\.16\.0\.0\/12;/);
  assert.doesNotMatch(ngx, /set_real_ip_from\s+(0\.0\.0\.0\/0|all)/, "не доверять всем");
  assert.match(ngx, /location = \/health\s+\{ limit_req zone=inspector_api/);
  const rules = parse(readFileSync(join(dir, "alerts.yml"), "utf8")).groups.flatMap((g) => g.rules).map((r) => r.alert);
  for (const a of ["InspectorIdsBlock", "InspectorRateLimitSurge"]) assert.ok(rules.includes(a), a);
});

test("профиль gpu: подпись запросов к «РиН» проведена — режим, флаг неквалифицированного коннектора, сертификат и ключ секретами (NFR-UKEP, OWASP T-137 E2-M1)", () => {
  const c = parse(readFileSync(join(root, "deploy/gpu/compose.yml"), "utf8"));
  const env = c.services.api.environment;
  assert.equal(env.INSPECTOR_UKEP_MODE, "${UKEP_MODE:-pem}");
  assert.equal(env.INSPECTOR_UKEP_NONQUALIFIED, "${UKEP_NONQUALIFIED:-1}");
  assert.equal(env.INSPECTOR_UKEP_CERT_FILE, "/run/secrets/ukep_cert");
  assert.equal(env.INSPECTOR_UKEP_KEY_FILE, "/run/secrets/ukep_key");
  for (const s of ["ukep_cert", "ukep_key"]) {
    assert.ok(c.services.api.secrets.includes(s), `api не получает секрет ${s}`);
    assert.match(c.secrets[s].file, /^\$\{UKEP_(CERT|KEY)_FILE:\?/, `${s} — файлом из обязательной переменной`);
  }
  assert.ok(existsSync(join(root, "scripts/ukep-test-key.sh")), "нет генератора тестовой пары");
});
