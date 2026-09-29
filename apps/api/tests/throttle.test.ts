// Защита входа (ТЗ 12.1): перебор, распыление, блокировка чужой записи, переполнение учёта. Эшелоны L3, L6.
import { describe, expect, it } from "vitest";
import { accountKey, ACCOUNT_FREE, IP_LIMIT, LoginThrottle, MAX_ACCOUNTS, MAX_IPS, WINDOW_MS } from "../src/services/throttle.ts";

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

describe("защита входа от перебора", () => {
  it("учётная запись: первые 5 неудач свободно, затем нарастающая пауза, не больше окна", () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < ACCOUNT_FREE; i++) {
      expect(th.check(`ip${i}`, "u1").ok).toBe(true);
      th.fail(`ip${i}`, "u1");
    }
    const r = th.check("ip-new", "u1");
    expect(r).toEqual({ ok: false, retryAfter: 2 });
    c.tick(2000);
    expect(th.check("ip-new", "u1").ok).toBe(true);
    th.fail("ip-new", "u1");
    expect(th.check("ip-new", "u1")).toEqual({ ok: false, retryAfter: 4 });
    for (let i = 0; i < 30; i++) (c.tick(th.accountDelay("u1")), th.fail(`x${i}`, "u1"));
    expect(th.accountDelay("u1")).toBeLessThanOrEqual(WINDOW_MS);
  });
  it("распыление с разных адресов не обходит паузу учётной записи", () => {
    const th = new LoginThrottle(clock().now);
    for (let i = 0; i < ACCOUNT_FREE; i++) th.fail(`10.0.0.${i}`, "u1");
    expect(th.check("10.0.0.99", "u1").ok).toBe(false);
  });
  it("адрес: не больше 20 неудач за окно на любые логины, в том числе несуществующие", () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < IP_LIMIT; i++) th.fail("1.1.1.1", null);
    expect(th.check("1.1.1.1", null).ok).toBe(false);
    expect(th.check("1.1.1.1", "u2").ok).toBe(false);
    expect(th.check("2.2.2.2", "u2").ok).toBe(true);
    c.tick(WINDOW_MS);
    expect(th.check("1.1.1.1", null).ok).toBe(true);
  });
  it("несуществующие логины не создают счётчиков учётных записей", () => {
    const th = new LoginThrottle(clock().now);
    for (let i = 0; i < 100; i++) th.fail(`ip${i}`, null);
    expect(th.size().accounts).toBe(0); // без учётного ключа учёт записей не растёт
  });
  it("успешный вход снимает паузу; окно истекло — счёт с нуля", () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < ACCOUNT_FREE; i++) th.fail("a", "u1");
    th.success("u1");
    expect(th.check("b", "u1").ok).toBe(true);
    for (let i = 0; i < ACCOUNT_FREE; i++) th.fail("a", "u3");
    c.tick(WINDOW_MS + 1);
    th.fail("c", "u3");
    expect(th.accountDelay("u3")).toBe(0);
  });
  it("переполнение учёта адресов: новые адреса не блокируются, заблокированные остаются", () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < IP_LIMIT; i++) th.fail("attacker", null);
    for (let i = 0; i < MAX_IPS + 50; i++) (c.tick(1), th.fail(`spray${i}`, null));
    expect(th.size().ips).toBeLessThanOrEqual(MAX_IPS);
    expect(th.check("fresh-ip", null).ok).toBe(true);
    expect(th.check("attacker", null).ok).toBe(false);
  });
  it("ключ — логин: чужие неудачи не влияют на другой логин, существующий он или нет", () => {
    const th = new LoginThrottle(clock().now);
    expect(accountKey(" Ghost ")).toBe(accountKey("ghost"));
    for (let i = 0; i < ACCOUNT_FREE; i++) th.fail(`ip${i}`, accountKey("ghost-a"));
    expect(th.check("other", accountKey("ghost-a")).ok).toBe(false);
    expect(th.check("other", accountKey("ghost-b")).ok).toBe(true);
    expect(th.check("other", accountKey("inspector")).ok).toBe(true);
  });
  it("учёт логинов ограничен; при переполнении записи с паузой не вытесняются", () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < ACCOUNT_FREE; i++) th.fail(`v${i}`, accountKey("victim"));
    for (let i = 0; i < MAX_ACCOUNTS + 10; i++) th.fail(`s${i % 7}`, accountKey(`spray${i}`)); // часы стоят — пауза victim действует
    expect(th.size().accounts).toBeLessThanOrEqual(MAX_ACCOUNTS);
    expect(th.accountDelay(accountKey("victim"))).toBeGreaterThan(0);
    c.tick(WINDOW_MS + 1);
    expect(th.check("any", accountKey("victim")).ok).toBe(true);
  });
});
