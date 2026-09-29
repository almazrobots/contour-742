// OWASP-аудит слоя данных 2026-09-26: чистые функции защиты входа и выборок (HIGH-3, M-2, M-3, M-6). L1 — правило, L6 — отказы.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { failedLoginDetails, hasNul, PAGE_MAX, pageQuery, tokenHash } from "../src/domain/security.ts";

describe("HIGH-3 хеш токена сессии", () => {
  it("SHA-256 hex токена: 64 строчных шестнадцатеричных символа, не равен токену, детерминирован", () => {
    const t = "a".repeat(48);
    expect(tokenHash(t)).toBe(createHash("sha256").update(t).digest("hex"));
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(t)).not.toBe(t);
    expect(tokenHash(t)).toBe(tokenHash(t));
    expect(tokenHash(t)).not.toBe(tokenHash(t + "b"));
  });
});

describe("M-6 LOGIN_FAILED без введённого логина в открытом виде", () => {
  it("существующий логин пишется как есть, с обрезкой до 100 символов", () => {
    expect(failedLoginDetails("inspector", true)).toEqual({ login: "inspector" });
    expect(failedLoginDetails("x".repeat(150), true)).toEqual({ login: "x".repeat(100) });
  });
  it("несуществующий — только префикс хеша: пароль, введённый в поле логина, в журнал не попадает", () => {
    const d = failedLoginDetails("Секрет-Пароль-123", false);
    expect(d).toEqual({ login_sha256: createHash("sha256").update("Секрет-Пароль-123").digest("hex").slice(0, 16), known: false });
    expect(JSON.stringify(d)).not.toContain("Секрет");
    expect(failedLoginDetails("y".repeat(150), false)).toEqual(failedLoginDetails("y".repeat(100), false));
  });
});

describe("M-3 hasNul", () => {
  it("находит NUL в строке, во вложенных объектах, массивах и ключах", () => {
    expect(hasNul("admin\u0000")).toBe(true);
    expect(hasNul({ a: { b: [1, "x", { c: "\u0000" }] } })).toBe(true);
    expect(hasNul([["ok"], ["\u0000"]])).toBe(true);
    expect(hasNul({ ["k\u0000"]: 1 })).toBe(true);
  });
  it("чистый ввод, пустые значения и не-строки — без NUL; прочие управляющие символы не в счёт", () => {
    for (const v of [undefined, null, "", "admin", "\u0001\t\n", 0, true, {}, [], { a: [1, 2, { b: "c" }] }, Buffer.from([0, 0])]) expect(hasNul(v)).toBe(false);
  });
  it("глубокая вложенность и циклы не роняют обход", () => {
    let deep: any = "\u0000";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(hasNul(deep)).toBe(true);
    const cyc: any = { a: "ok" };
    cyc.self = cyc;
    expect(hasNul(cyc)).toBe(false);
  });
});

describe("M-2 pageQuery", () => {
  it("умолчание по маршруту, потолок PAGE_MAX, строки приводятся к числам, прочие ключи отбрасываются", () => {
    expect(pageQuery(200).parse({})).toEqual({ limit: 200, offset: 0 });
    expect(pageQuery(10_000).parse({})).toEqual({ limit: PAGE_MAX, offset: 0 });
    expect(pageQuery(200).parse({ limit: "5", offset: "10", status: "READY" })).toEqual({ limit: 5, offset: 10 });
    expect(pageQuery(200).parse({ limit: String(PAGE_MAX) }).limit).toBe(PAGE_MAX);
  });
  it("за потолком, ноль, отрицательное, дробное и не число — отказ", () => {
    for (const q of [{ limit: String(PAGE_MAX + 1) }, { limit: "0" }, { offset: "-1" }, { limit: "1.5" }, { limit: "abc" }, { offset: "1000001" }]) expect(pageQuery(200).safeParse(q).success).toBe(false);
  });
});
