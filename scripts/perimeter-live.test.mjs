// NFR-IDS (ТЗ 12.9, T-158): живая проверка периметра — лимиты nginx на поднятом образе web, а не регулярками по конфигу.
// Пороги читаются из apps/web/nginx.conf (одно место правды): поменяли rate/burst/лимит тела — тест считает по-новому.
//   node --test scripts/perimeter-live.test.mjs                               разбор конфига (всегда, в pnpm test:deploy)
//   PERIMETER_URL=https://127.0.0.1:18443 PERIMETER_CA=smoke-tls/ca.crt node --test scripts/perimeter-live.test.mjs
//                                                                            + живые запросы (гейт, smoke-web)
// Сертификат web проверяется по корню стенда (PERIMETER_CA) и имени PERIMETER_NAME (по умолчанию localhost — SAN smoke).
// Разные «клиенты» — через X-Forwarded-For: nginx доверяет ему только от частных адресов docker (real_ip), а запросы
// с хоста на опубликованный порт приходят с адреса шлюза docker. Адреса — из 198.18.0.0/15 (RFC 2544, тестовые),
// со случайной второй половиной: повторный прогон на том же контейнере не упирается в прошлые счётчики.
// Отказ периметра отличается от отказа API по телу: nginx отдаёт HTML-страницу, API — JSON (свой 429 у входа, T-090).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = process.env.PERIMETER_URL ?? "";
const CA = process.env.PERIMETER_CA ?? "";
const live = { skip: URL_ && CA ? false : "PERIMETER_URL/PERIMETER_CA не заданы — живая часть идёт в гейте на поднятом образе web" };

/** Лимиты периметра из nginx.conf: зоны (запросов в секунду), limit_req по location, limit_conn, предел тела (байт). */
export function perimeterLimits(text) {
  const conf = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const zones = {};
  for (const [, name, n, unit] of conf.matchAll(/limit_req_zone\s+\S+\s+zone=(\w+):\S+\s+rate=(\d+)r\/([sm]);/g)) {
    zones[name] = Number(n) / (unit === "m" ? 60 : 1);
  }
  const locations = {};
  for (const [, loc, zone, burst] of conf.matchAll(/location\s+([^{]+?)\s*\{[^}]*?limit_req zone=(\w+) burst=(\d+)/g)) {
    locations[loc.trim()] = { zone, rate: zones[zone], burst: Number(burst) };
  }
  const conn = conf.match(/^\s*limit_conn\s+\w+\s+(\d+);/m);
  const body = conf.match(/^\s*client_max_body_size\s+(\d+)([kmg]?);/im);
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(body?.[2] ?? "").toLowerCase()];
  return { zones, locations, conn: conn ? Number(conn[1]) : null, maxBody: body ? Number(body[1]) * mult : null };
}

const limits = perimeterLimits(readFileSync(join(root, "apps/web/nginx.conf"), "utf8"));

test("NFR-IDS T-158 · разбор nginx.conf: зоны, всплески по location, limit_conn и предел тела", () => {
  const api = limits.locations["/api/"];
  const login = limits.locations["= /api/v1/auth/login"];
  assert.ok(api && api.rate > 0 && api.burst > 0, "у /api/ нет limit_req с известной зоной");
  assert.ok(login && login.rate > 0 && login.rate < api.rate, "вход ограничен строже остального API");
  assert.ok(limits.locations["= /health"], "/health под лимитом (R2 T-138, E1-M2)");
  assert.ok(limits.conn > 0, "нет limit_conn");
  assert.ok(limits.maxBody >= 200 * 1024 ** 2, "предел тела не пропускает пакет 200 МБ (ТЗ 9.1)");
  // сам разборщик: единицы r/m и m/k — на коротком образце, чтобы ошибка в нём не пряталась за совпадением с конфигом
  const s = perimeterLimits("limit_req_zone $a zone=z:1m rate=30r/m;\nlocation = /x { limit_req zone=z burst=2 nodelay; }\n limit_conn c 7;\n client_max_body_size 3k;");
  assert.deepEqual(s, { zones: { z: 0.5 }, locations: { "= /x": { zone: "z", rate: 0.5, burst: 2 } }, conn: 7, maxBody: 3072 });
});

// ─────────────────────────────── живая часть: сырой HTTP/1.1 поверх TLS (без h2, без повторов, без пулов соединений)

const target = URL_ ? new URL(URL_) : null;
const rnd = () => 1 + Math.floor(Math.random() * 250);
const run = `198.${18 + (rnd() % 2)}.${rnd()}`;
const addr = (n) => `${run}.${n}`; // один прогон — одна /24, у каждой проверки свой «клиент»

function connect() {
  return tls.connect({ host: target.hostname, port: Number(target.port || 443), servername: process.env.PERIMETER_NAME ?? "localhost", ca: readFileSync(CA), ALPNProtocols: ["http/1.1"] });
}

/** Один запрос на своём соединении. headers — дополнительные; body — строка; bodyLength — объявить длину, тело не слать. */
function request(method, path, { ip, headers = {}, body, bodyLength } = {}) {
  return new Promise((resolve, reject) => {
    const s = connect();
    const len = bodyLength ?? (body != null ? Buffer.byteLength(body) : null);
    const head = [`${method} ${path} HTTP/1.1`, `Host: localhost`, `Connection: close`, ...(ip ? [`X-Forwarded-For: ${ip}`] : []),
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), ...(len != null ? [`Content-Length: ${len}`] : [])];
    const chunks = [];
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`${method} ${path}: нет ответа за 20 с`)); }, 20_000);
    s.on("secureConnect", () => s.write(head.join("\r\n") + "\r\n\r\n" + (bodyLength == null && body != null ? body : "")));
    s.on("data", (d) => chunks.push(d));
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
    s.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const status = Number(raw.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
      resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
    });
  });
}

/** Отказ именно периметра: 429/413/… страницей nginx, а не JSON-ответом API. */
const byNginx = (r, code) => r.status === code && /<center>nginx<\/center>|<html>/i.test(r.body) && !r.body.trimStart().startsWith("{");

async function pool(n, width, fn) {
  const out = new Array(n);
  let i = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (i < n) { const k = i++; out[k] = await fn(k); } }));
  return out;
}

test("NFR-IDS T-158 · живой периметр: всплеск на /api/ сверх rate+burst — 429 от nginx, соседний адрес и пауза — не задеты", live, async () => {
  const { rate, burst } = limits.locations["/api/"];
  const flood = addr(1), neighbour = addr(2);
  const n = burst * 2 + 20;
  const t0 = Date.now();
  const res = await pool(n, 20, () => request("GET", "/api/v1/objects", { ip: flood }));
  const sec = (Date.now() - t0) / 1000;
  const refused = res.filter((r) => byNginx(r, 429)).length;
  const passed = n - refused;
  console.log(`  /api/: ${n} запросов за ${sec.toFixed(2)} с с одного адреса → прошли ${passed}, 429 от nginx ${refused} (rate ${rate}/с, burst ${burst})`);
  assert.ok(res.every((r) => r.status > 0), "часть запросов осталась без ответа");
  assert.ok(refused > 0, "всплеск сверх burst не получил ни одного 429 от nginx");
  // пропущено не больше, чем разрешает ведро: burst + первый + пополнение за время всплеска (+1 на округление)
  assert.ok(passed <= burst + 1 + Math.ceil(rate * sec) + 1, `прошло ${passed} — больше, чем burst ${burst} + rate × ${sec.toFixed(2)} с`);
  const other = await request("GET", "/api/v1/objects", { ip: neighbour });
  assert.ok(!byNginx(other, 429) && other.status > 0, `соседний адрес задет лимитом чужого: ${other.status}`);
  // пауза: ведро пополняется, тот же адрес снова проходит — лимит, а не блокировка
  await new Promise((r) => setTimeout(r, Math.ceil((1000 * 5) / rate) + 200));
  // та же location /api/: у /health своя burst (меньше) на той же зоне — после всплеска она ждала бы дольше
  const after = await request("GET", "/api/v1/objects", { ip: flood });
  console.log(`  после паузы тот же адрес: /api/ → ${after.status} (${after.body.trimStart().startsWith("{") ? "API" : "nginx"}); соседний адрес во время всплеска: ${other.status}`);
  // до API дошёл: ответ JSON (без входа — 401), не страница nginx. На стенде gpu API держит второй рубеж (ведро и
  // детектор, services/ids.ts) и сам может ответить 429 тому же адресу — это уже не периметр.
  assert.ok(after.status > 0 && !byNginx(after, 429), `после паузы /api/ — ${after.status} от nginx, ждали пропуск к API`);
  assert.ok(after.body.trimStart().startsWith("{"), `после паузы ответил не API: ${after.body.slice(0, 80)}`);
});

test("NFR-IDS T-158 · живой периметр: вход чаще лимита зоны login — 429 от nginx раньше, чем API считает попытки", live, async () => {
  const { rate, burst } = limits.locations["= /api/v1/auth/login"];
  const ip = addr(3);
  const n = burst + 6;
  const body = JSON.stringify({ login: `perimeter-${run}`, password: "не-тот" });
  const res = [];
  for (let i = 0; i < n; i++) res.push(await request("POST", "/api/v1/auth/login", { ip, headers: { "Content-Type": "application/json" }, body }));
  const refused = res.filter((r) => byNginx(r, 429)).length;
  console.log(`  вход: ${n} попыток подряд → до API дошли ${n - refused} (${[...new Set(res.filter((r) => !byNginx(r, 429)).map((r) => r.status))].join(", ")}), 429 от nginx ${refused} (rate ${rate * 60}/мин, burst ${burst})`);
  assert.ok(n - refused <= burst + 1 + 1, `до API дошло ${n - refused} попыток — больше burst ${burst} + 1`);
  assert.ok(refused >= n - burst - 2, `nginx отказал только ${refused} раз из ${n}`);
  const other = await request("POST", "/api/v1/auth/login", { ip: addr(4), headers: { "Content-Type": "application/json" }, body });
  assert.ok(!byNginx(other, 429) && other.status > 0, `вход с соседнего адреса задет: ${other.status}`);
});

test("NFR-IDS T-158 · живой периметр: тело больше client_max_body_size — 413 от nginx, ровно на пределе — до API", live, async () => {
  const over = await request("POST", "/api/v1/documents/upload", { ip: addr(5), headers: { "Content-Type": "multipart/form-data; boundary=x" }, bodyLength: limits.maxBody + 1 });
  const atLimit = await request("POST", "/api/v1/documents/upload", { ip: addr(5), headers: { "Content-Type": "multipart/form-data; boundary=x" }, bodyLength: limits.maxBody });
  const api = await request("POST", "/api/v1/objects", { ip: addr(5), headers: { "Content-Type": "application/json" }, bodyLength: limits.maxBody + 1 });
  console.log(`  тело: ${limits.maxBody + 1} байт на загрузку → ${over.status}, на /api/ → ${api.status}; ровно ${limits.maxBody} → ${atLimit.status}`);
  assert.ok(byNginx(over, 413), `загрузка сверх предела: ${over.status}, ждали 413 от nginx`);
  assert.ok(byNginx(api, 413), `/api/ сверх предела: ${api.status}, ждали 413 от nginx`);
  assert.equal(atLimit.status, 401, "ровно на пределе запрос доходит до API (без входа — 401)");
});

test("NFR-IDS T-158 · живой периметр: соединений с адреса сверх limit_conn — 429 от nginx, соседний адрес проходит", live, async () => {
  const ip = addr(6);
  // держатели: вход без тела (объявлено 64 байта) — nginx проксирует потоком, API ждёт JSON; запрос висит в зоне limit_conn
  const holders = [];
  const opened = [];
  for (let i = 0; i < limits.conn; i++) {
    const s = connect();
    holders.push(s);
    opened.push(new Promise((ok, fail) => {
      s.on("error", fail);
      s.on("secureConnect", () => { s.write(`POST /api/v1/auth/guest HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n`); ok(); });
    }));
  }
  try {
    await Promise.all(opened);
    await new Promise((r) => setTimeout(r, 1500)); // nginx разобрал заголовки всех держателей
    const extra = await request("GET", "/api/v1/objects", { ip });
    const other = await request("GET", "/api/v1/objects", { ip: addr(7) });
    console.log(`  соединения: ${limits.conn} держат запрос → ${limits.conn + 1}-й с того же адреса ${extra.status}, с соседнего ${other.status}`);
    assert.ok(byNginx(extra, 429), `${limits.conn + 1}-й запрос: ${extra.status}, ждали 429 от nginx (limit_conn)`);
    assert.ok(!byNginx(other, 429) && other.status > 0, `соседний адрес задет limit_conn: ${other.status}`);
  } finally {
    for (const s of holders) s.destroy();
  }
});
