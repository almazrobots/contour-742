// NFR-IDS (ТЗ 12.9, TZA-12.9-01/02, T-138) и T-090: рубеж API на живом приложении (inject).
// Адрес клиента — из X-Forwarded-For только от доверенного прокси; лимит запросов на адрес — 429 с Retry-After;
// детектор атак блокирует адрес (403) в базе, пишет IDS_BLOCK в журнал аудита и уведомляет администратора;
// администратор видит и снимает блокировку; loopback не ограничивается. M13 — успешный вход сбрасывает счётчик.
// L1 — функциональные, L4 — отказы и конкурентность экземпляров, L6 — враждебные входы, L7 — дисциплина прокси.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = "10.20.0.2"; // web (nginx) в подсети compose
let app: any;
let app2: any; // второй экземпляр API над той же базой
let db: any;
let adminToken = "";

beforeAll(async () => {
  Object.assign(process.env, {
    INSPECTOR_DEMO_PASSWORD: "ids-pass-12345",
    INSPECTOR_ML_URL: "http://127.0.0.1:9",
    INSPECTOR_IDS: "on",
    INSPECTOR_IDS_RPS: "5",
    INSPECTOR_IDS_BURST: "30",
    INSPECTOR_TRUST_PROXY: `${PROXY},10.30.0.0/24`,
  });
  const { openDb } = await import("../src/db.ts");
  const { buildApp } = await import("../src/app.ts");
  db = await openDb("memory");
  app = buildApp(db);
  app2 = buildApp(db);
  await app.ready();
  await app2.ready();
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "admin", password: "ids-pass-12345" }, remoteAddress: "127.0.0.1" });
  adminToken = r.json().token;
});
afterAll(async () => {
  await app.close();
  await app2.close();
  await db.close();
});

const from = (ip: string, url: string, extra: Record<string, unknown> = {}) => app.inject({ method: "GET", url, remoteAddress: ip, ...extra });
const viaProxy = (client: string, url: string, a = app) => a.inject({ method: "GET", url, remoteAddress: PROXY, headers: { "x-forwarded-for": client } });

describe("адрес клиента за прокси (T-090, H2)", () => {
  it("L7 · от доверенного прокси адрес берётся из X-Forwarded-For; от чужого соединения заголовок не читается", async () => {
    // поиск служебных файлов с «подделанным» XFF от недоверенного адреса учитывается на сам адрес соединения
    for (let i = 0; i < 5; i++) expect((await from("198.51.100.7", "/.env", { headers: { "x-forwarded-for": "203.0.113.200" } })).statusCode).toBe(404);
    expect((await from("198.51.100.7", "/api/v1/dictionaries")).statusCode).toBe(403);
    expect((await viaProxy("203.0.113.200", "/api/v1/dictionaries")).statusCode).toBe(200); // подделанный адрес не пострадал
  });

  it("20 неудач входа с одного клиента за прокси не закрывают вход другому клиенту того же прокси", async () => {
    for (let i = 0; i < 20; i++) {
      await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: `nobody${i}`, password: "x" }, remoteAddress: PROXY, headers: { "x-forwarded-for": "203.0.113.10" } });
    }
    const other = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "admin", password: "ids-pass-12345" }, remoteAddress: PROXY, headers: { "x-forwarded-for": "203.0.113.11" } });
    expect(other.statusCode).toBe(200);
  });
});

describe("лимит запросов на адрес (TZA-12.9-02)", () => {
  it("L3 · burst запросов проходят, следующий — 429 с Retry-After; соседний адрес не задет", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await viaProxy("203.0.113.30", "/api/v1/dictionaries")).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    const r = await viaProxy("203.0.113.30", "/api/v1/dictionaries");
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await viaProxy("203.0.113.31", "/api/v1/dictionaries")).statusCode).toBe(200);
  });

  it("loopback (служебные инструменты) не ограничивается и не блокируется", async () => {
    for (let i = 0; i < 60; i++) await from("127.0.0.1", "/.env");
    expect((await from("127.0.0.1", "/api/v1/dictionaries")).statusCode).toBe(200);
  });
});

describe("обнаружение атак и блокировка (TZA-12.9-01)", () => {
  it("L6 · пять попыток SQL-инъекции — адрес заблокирован: 403, IDS_BLOCK в журнале, уведомление администратору", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) await viaProxy(ip, `/api/v1/objects?q=1'%20UNION%20SELECT%20password%20FROM%20users--${i}`);
    const r = await viaProxy(ip, "/api/v1/dictionaries");
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain("временно закрыт");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(800); // 15 минут
    const a = await db.get("select * from audit_log where action = 'IDS_BLOCK' and ip_address = $1", [ip]);
    expect(JSON.parse(a.details)).toMatchObject({ reason: expect.stringContaining("SQL-инъекция"), block_no: 1 });
    const n = await db.get("select * from notifications where user_role = 'admin' and message like $1", [`%${ip}%`]);
    expect(n.level).toBe("WARNING");
  });

  it("отказы самой блокировки (403) не копят очки: после снятия адрес не блокируется снова от своих же повторов", async () => {
    const ip = "203.0.113.52";
    for (let i = 0; i < 5; i++) await viaProxy(ip, "/phpmyadmin/index.php");
    for (let i = 0; i < 30; i++) expect((await viaProxy(ip, "/api/v1/dictionaries")).statusCode).toBe(403); // 30 × «forbidden» = 60 очков, если бы считались
    // повторной блокировки (с удвоенным сроком) от собственных отказов блокировки нет
    expect((await db.get("select blocks from ip_blocks where ip = $1", [ip])).blocks).toBe(1);
    const admin = await app.inject({ method: "DELETE", url: `/api/v1/admin/security/blocks/${ip}`, remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${adminToken}` } });
    expect(admin.statusCode).toBe(200);
    expect((await viaProxy(ip, "/api/v1/nope")).statusCode).toBe(404); // одно очко — не повод для новой блокировки
    expect((await viaProxy(ip, "/api/v1/dictionaries")).statusCode).toBe(200);
  });

  it("L4 · блокировку видит второй экземпляр API над той же базой", async () => {
    const ip = "203.0.113.51";
    for (let i = 0; i < 5; i++) await viaProxy(ip, "/.git/config");
    expect((await viaProxy(ip, "/api/v1/dictionaries")).statusCode).toBe(403);
    await new Promise((r) => setTimeout(r, 5_100)); // кэш блокировок второго экземпляра обновляется раз в 5 с
    expect((await viaProxy(ip, "/api/v1/dictionaries", app2)).statusCode).toBe(403);
  }, 15_000);

  it("метрики детектора в /metrics: признаки по видам, блокировки, отказы по лимиту", async () => {
    const body = (await from("127.0.0.1", "/metrics")).body;
    expect(body).toMatch(/inspector_ids_events_total\{kind="sql_injection"\} [1-9]/);
    expect(body).toMatch(/inspector_ids_blocks_total [1-9]/);
    expect(body).toMatch(/inspector_rate_limited_total [1-9]/);
  });
});

describe("администратор: просмотр и снятие блокировки", () => {
  const admin = (method: string, url: string) => app.inject({ method, url, remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${adminToken}` } });

  it("список действующих блокировок с причиной и сроком; снятие — адрес снова работает, IDS_UNBLOCK в журнале", async () => {
    const list = (await admin("GET", "/api/v1/admin/security/blocks")).json();
    expect(list.enabled).toBe(true);
    const b = list.blocks.find((x: any) => x.ip === "203.0.113.50");
    expect(b).toMatchObject({ active: true, blocks: 1, events: { sql_injection: 5 } });
    expect(new Date(b.until).getTime()).toBeGreaterThan(Date.now());
    expect((await admin("DELETE", "/api/v1/admin/security/blocks/203.0.113.50")).statusCode).toBe(200);
    expect((await viaProxy("203.0.113.50", "/api/v1/dictionaries")).statusCode).toBe(200);
    expect(await db.get("select * from audit_log where action = 'IDS_UNBLOCK'")).toBeTruthy();
    expect((await admin("DELETE", "/api/v1/admin/security/blocks/203.0.113.50")).statusCode).toBe(404);
    const hist = (await admin("GET", "/api/v1/admin/security/blocks?all=1")).json();
    expect(hist.blocks.find((x: any) => x.ip === "203.0.113.50")).toMatchObject({ active: false, released_by: expect.any(String) });
  });

  it("повторная блокировка того же адреса — вдвое дольше (15 → 30 мин)", async () => {
    for (let i = 0; i < 5; i++) await viaProxy("203.0.113.50", "/api/v1/x?q=%3Cscript%3E");
    const b = (await admin("GET", "/api/v1/admin/security/blocks")).json().blocks.find((x: any) => x.ip === "203.0.113.50");
    expect(b.blocks).toBe(2);
    const minutes = (new Date(b.until).getTime() - new Date(b.blocked_at).getTime()) / 60_000;
    expect(minutes).toBe(30);
  });

  it("не администратор — 403; без входа — 401", async () => {
    const insp = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "ids-pass-12345" }, remoteAddress: "127.0.0.1" });
    const t = insp.json().token;
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/security/blocks", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/security/blocks", remoteAddress: "127.0.0.1" })).statusCode).toBe(401);
  });
});

describe("M13: успешный вход сбрасывает счётчик учётной записи", () => {
  it("4 неудачи, верный пароль, ещё 2 неудачи — верный пароль снова входит, а не получает 429", async () => {
    const login = (password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "supervisor", password }, remoteAddress: "127.0.0.1" });
    for (let i = 0; i < 4; i++) expect((await login("wrong")).statusCode).toBe(401);
    expect((await login("ids-pass-12345")).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) expect((await login("wrong")).statusCode).toBe(401);
    // до исправления счётчик по ключу acc:<логин> не сбрасывался входом: 6 неудач подряд — пауза, верный пароль — 429
    expect((await login("ids-pass-12345")).statusCode).toBe(200);
  });
});

describe("R2 T-138: находки аудита OWASP", () => {
  it("E1-L1 · «X-Forwarded-For: 127.0.0.1» через прокси не даёт исключения loopback: адрес ограничивается и блокируется", async () => {
    for (let i = 0; i < 5; i++) await viaProxy("127.0.0.1", "/.env");
    expect((await viaProxy("127.0.0.1", "/api/v1/dictionaries")).statusCode).toBe(403);
    // настоящий loopback (соединение изнутри контейнера) по-прежнему не ограничивается
    expect((await from("127.0.0.1", "/api/v1/dictionaries")).statusCode).toBe(200);
  });

  it("E1-M1 · межсайтовые запросы (Sec-Fetch-Site: cross-site) не копят очки сигнатур: чужая страница не блокирует адрес", async () => {
    const ip = "203.0.113.60";
    for (let i = 0; i < 8; i++) await app.inject({ method: "GET", url: "/.env", remoteAddress: PROXY, headers: { "x-forwarded-for": ip, "sec-fetch-site": "cross-site" } });
    expect((await viaProxy(ip, "/api/v1/dictionaries")).statusCode).toBe(200);
    // но обнаружение не выключено: сигнатуры считаются в метриках (сканер с поддельным заголовком виден алертом)
    const body = (await from("127.0.0.1", "/metrics")).body;
    expect(Number(body.match(/inspector_ids_events_total\{kind="sensitive_file"\} (\d+)/)![1])).toBeGreaterThanOrEqual(8);
  });

  it("E1-M2 · /health с внешнего адреса — под лимитом запросов (429 после burst), с loopback — без лимита", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 80; i++) codes.push((await viaProxy("203.0.113.61", "/health")).statusCode); // burst 30 + пополнение 5/с — 80 заведомо больше
    expect(codes).toContain(429);
    for (let i = 0; i < 40; i++) expect((await from("127.0.0.1", "/health")).statusCode).toBe(200);
  });

  it("E1-M4 · упор в собственный лимит (429) не превращается в блокировку: 120 запросов подряд — 429, но не 403", async () => {
    const ip = "203.0.113.62";
    const codes = new Set<number>();
    for (let i = 0; i < 120; i++) codes.add((await viaProxy(ip, "/api/v1/dictionaries")).statusCode);
    expect(codes.has(429)).toBe(true);
    expect(codes.has(403)).toBe(false);
  });

  it("E1-L2 · снятие блокировки: не адрес — 400; IPv4-mapped IPv6 нормализуется к IPv4", async () => {
    const admin = (url: string) => app.inject({ method: "DELETE", url, remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${adminToken}` } });
    expect((await admin("/api/v1/admin/security/blocks/not-an-ip")).statusCode).toBe(400);
    for (let i = 0; i < 5; i++) await viaProxy("203.0.113.63", "/.git/config");
    expect((await admin("/api/v1/admin/security/blocks/::ffff:203.0.113.63")).statusCode).toBe(200);
  });

  it("E1-L3 · в журнал аудита уходит путь без строки запроса", async () => {
    const ip = "203.0.113.64";
    for (let i = 0; i < 5; i++) await viaProxy(ip, `/api/v1/objects?q=1'%20UNION%20SELECT%20secret-${i}`);
    const d = JSON.parse((await db.get("select details from audit_log where action = 'IDS_BLOCK' and ip_address = $1", [ip])).details);
    expect(d.last_path).toBe("/api/v1/objects");
    expect(d.has_query).toBe(true);
    expect(JSON.stringify(d)).not.toContain("secret");
  });
});
