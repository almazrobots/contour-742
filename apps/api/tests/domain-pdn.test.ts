// NFR-PDN (ТЗ 12.6-01, 152-ФЗ): реестр ПДн, маскирование, минимизация, срок хранения, локализация.
// Эшелоны: L1 — функции маски и плана; L3 — границы срока и форматов; L5 — свойства на fast-check;
// L6 — враждебные строки (ПДн внутри текста ошибки, стек, URL); L7 — гейт реестра по миграциям.
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { config } from "../src/config.ts";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anonymizedLogin, anonymizedName, canSeeCounterparty, maskCounterparty, maskFields, maskIp, maskText, maskValue, PDN_COLUMN_NAMES, PDN_NOT_PERSONAL,
  PDN_REGISTRY, pdnColumnsInSql, pdnLocalizationError, redactUrl, retentionDue, retentionPlan, unregisteredPdnColumns,
} from "../src/domain/pdn.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../src/db/migrations");
const DAY = 86400_000;

describe("реестр ПДн (NFR-PDN п. 1)", () => {
  it("каждая строка реестра заполнена: категория, цель, основание по ст. 6 ч. 1, срок и способ защиты", () => {
    expect(PDN_REGISTRY.length).toBeGreaterThanOrEqual(7);
    for (const r of PDN_REGISTRY) {
      expect(r.category.length).toBeGreaterThan(0);
      expect(r.purpose.length).toBeGreaterThan(10);
      expect(r.basis).toMatch(/^152-ФЗ ст\. 6 ч\. 1 п\. \d/);
      expect(r.retention_days === "до цели" || (Number.isInteger(r.retention_days) && (r.retention_days as number) > 0)).toBe(true);
      expect(r.protection.length).toBeGreaterThan(0);
    }
    const keys = PDN_REGISTRY.map((r) => `${r.table}.${r.column}${r.path ? `#${r.path}` : ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("в реестре — ФИО и логин пользователя, застройщик и подрядчик, IP и User-Agent журнала, ФИО в снимке протокола", () => {
    const has = (t: string, c: string) => PDN_REGISTRY.some((r) => r.table === t && r.column === c);
    for (const [t, c] of [["users", "name"], ["users", "login"], ["objects", "customer"], ["objects", "contractor"], ["audit_log", "ip_address"], ["audit_log", "user_agent"], ["protocols", "body_json"]]) expect(has(t, c)).toBe(true);
    expect(PDN_REGISTRY.find((r) => r.table === "audit_log" && r.column === "ip_address")!.retention_days).toBe(365);
  });
  it("словарь-детектор знает имена колонок ПДн, в том числе ещё не заведённые (телефон, e-mail, СНИЛС, паспорт)", () => {
    for (const c of ["name", "login", "customer", "contractor", "ip_address", "user_agent", "phone", "email", "fio", "full_name", "snils", "passport"]) expect(PDN_COLUMN_NAMES).toContain(c);
  });
});

describe("гейт реестра ПДн по миграциям (L7)", () => {
  it("разбор SQL находит колонки ПДн в create table, alter table add column и rename column; комментарии и тела функций не считаются", () => {
    const sql = `-- create table fake (phone text);
      create table people (id text primary key, full_name text not null, phone text, constraint people_ck check (phone <> ''), unique (phone));
      create function f() returns trigger language plpgsql as $$ begin create table inner_t (email text); end $$;
      alter table people add column email text;
      alter table if exists people add column if not exists snils text;
      alter table people rename column note to passport;`;
    expect(pdnColumnsInSql(sql)).toEqual([
      { table: "people", column: "full_name" }, { table: "people", column: "phone" },
      { table: "people", column: "email" }, { table: "people", column: "snils" }, { table: "people", column: "passport" },
    ]);
  });
  it("самопроверка: новая колонка phone без строки реестра — гейт краснеет", () => {
    const found = pdnColumnsInSql("alter table users add column phone text;");
    expect(unregisteredPdnColumns(found)).toEqual(["users.phone"]);
    expect(unregisteredPdnColumns(pdnColumnsInSql("alter table users add column email text; create table x (fio text);"))).toEqual(["users.email", "x.fio"]);
  });
  it("каждая колонка ПДн из всех миграций есть в реестре или в списке «не ПДн» с причиной", () => {
    const found = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort().flatMap((n) => pdnColumnsInSql(readFileSync(join(MIGRATIONS, n), "utf8")));
    expect(found.length).toBeGreaterThan(0);
    expect(unregisteredPdnColumns(found)).toEqual([]);
    for (const x of PDN_NOT_PERSONAL) expect(x.reason.length).toBeGreaterThan(10);
  });
  it("документ docs/security/PDN-REGISTRY.md упоминает каждую строку реестра (таблица.колонка)", () => {
    const doc = readFileSync(join(config.root, "docs/security/PDN-REGISTRY.md"), "utf8");
    expect(doc).toMatch(/^---\nid: /);
    for (const r of PDN_REGISTRY) expect(doc).toContain(`${r.table}.${r.column}`);
  });
});

describe("маскирование в логах (NFR-PDN п. 2)", () => {
  it("e-mail — первая буква и домен", () => {
    expect(maskText("пишите ivanova.as@mosstroy.ru или P.Petrov@x.org")).toBe("пишите i***@mosstroy.ru или P***@x.org");
  });
  it("телефоны РФ в разных форматах — +7***-**-NN, последние две цифры видны", () => {
    for (const p of ["+7 (916) 123-45-67", "8 916 123 45 67", "+79161234567", "89161234567", "8-916-123-45-67", "+7(916)1234567"]) expect(maskText(`тел. ${p}.`)).toBe("тел. +7***-**-67.");
  });
  it("СНИЛС — ***-***-*** NN", () => {
    expect(maskText("СНИЛС 112-233-445 95")).toBe("СНИЛС ***-***-*** 95");
    expect(maskText("СНИЛС 112-233-445-95")).toBe("СНИЛС ***-***-*** 95");
  });
  it("хеши, идентификаторы, даты и номера разрешений не трогаются", () => {
    const s = "sha256 89161234567abc0f INS-2026-0001 2026-09-27T10:00:00Z 77-123000-012345-2026 id=189161234567";
    expect(maskText(s)).toBe(s);
  });
  it("IPv4 — последний октет 0; IPv6 — префикс /48; мусор — ***; пусто — null", () => {
    expect(maskIp("192.168.10.77")).toBe("192.168.10.0");
    expect(maskIp("::ffff:10.1.2.3")).toBe("::ffff:10.1.2.0");
    expect(maskIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::/48");
    expect(maskIp("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(maskIp("::1")).toBe("0:0:0::/48");
    expect(maskIp("не адрес")).toBe("***");
    expect(maskIp(null)).toBeNull();
  });
  it("значения по ключам реестра: ФИО и логин — ***, IP — maskIp, User-Agent — ***; прочие строки — maskText", () => {
    expect(maskValue("name", "Иванова А. С.")).toBe("***");
    expect(maskValue("user_name", "Иванова А. С.")).toBe("***");
    expect(maskValue("login", "ivanova")).toBe("***");
    expect(maskValue("customer", "ООО «Ромашка»")).toBe("***");
    expect(maskValue("ip_address", "10.0.0.5")).toBe("10.0.0.0");
    expect(maskValue("ip", "10.0.0.5")).toBe("10.0.0.0");
    expect(maskValue("user_agent", "Mozilla/5.0")).toBe("***");
    expect(maskValue("message", "звоните 89161234567")).toBe("звоните +7***-**-67");
    expect(maskValue("name", null)).toBeNull();
    expect(maskValue("count", 5)).toBe(5);
  });
  it("поля лога — рекурсивно, включая вложенные объекты и массивы; id пользователя и запроса не маскируются", () => {
    expect(maskFields({ user_id: "u-insp", request_id: "r1", err: { message: "a@b.ru", list: ["89161234567"] }, login: "x", n: 3 })).toEqual({
      user_id: "u-insp", request_id: "r1", err: { message: "a***@b.ru", list: ["+7***-**-67"] }, login: "***", n: 3,
    });
  });
  it("строка запроса: значения параметров → ***, кроме limit/offset/page/format; путь не меняется", () => {
    expect(redactUrl("/api/v1/audit?action=LOGIN&user=u-insp&limit=50&offset=0")).toBe("/api/v1/audit?action=***&user=***&limit=50&offset=0");
    expect(redactUrl("/api/v1/x?email=a%40b.ru&format=md&q")).toBe("/api/v1/x?email=***&format=md&q");
    expect(redactUrl("/api/v1/inspections/INS-1")).toBe("/api/v1/inspections/INS-1");
    expect(redactUrl("/p?")).toBe("/p?");
  });
});

describe("минимизация (NFR-PDN п. 3)", () => {
  it("застройщика и подрядчика видят инспектор, супервизор и администратор; ML-инженер и куратор — ***", () => {
    for (const r of ["inspector", "supervisor", "admin"]) expect(canSeeCounterparty(r)).toBe(true);
    for (const r of ["ml_engineer", "curator", "system", ""]) expect(canSeeCounterparty(r)).toBe(false);
    const o = { id: "o1", name: "ЖК", customer: "ООО «Заказчик»", contractor: null };
    expect(maskCounterparty(o, "curator")).toEqual({ id: "o1", name: "ЖК", customer: "***", contractor: null });
    expect(maskCounterparty(o, "inspector")).toBe(o);
  });
});

describe("срок хранения и обезличивание (NFR-PDN п. 4)", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  it("обезличенные ФИО и логин", () => {
    expect(anonymizedName("u-7")).toBe("Обезличен #u-7");
    expect(anonymizedLogin("u-7")).toBe("deleted-u-7");
  });
  it("обезличиваются учётки, выключенные раньше чем now − 30 дней; ровно 30 дней — ещё нет; уже обезличенные и активные — нет", () => {
    const users = [
      { id: "a", login: "a", deactivated_at: ago(31) },
      { id: "b", login: "b", deactivated_at: ago(30) },
      { id: "c", login: "c", deactivated_at: null },
      { id: "d", login: "deleted-d", deactivated_at: ago(400) },
      { id: "e", login: "e", deactivated_at: ago(30.0001) },
    ];
    const p = retentionPlan(now, users, { userDays: 30, auditDays: 365 });
    expect(p.anonymize).toEqual(["a", "e"]);
    expect(p.auditCutoff).toBe(ago(365));
  });
  it("задача раз в сутки: первый запуск — всегда, повтор в тот же день UTC — нет, на следующий день — да", () => {
    expect(retentionDue(now, "")).toBe("2026-09-27");
    expect(retentionDue(now, "2026-09-27")).toBeNull();
    expect(retentionDue(now, "2026-09-26")).toBe("2026-09-27");
  });
});

describe("локализация (NFR-PDN п. 6, ст. 18 ч. 5)", () => {
  it("Yandex Object Storage — в РФ; AWS — нет; список INSPECTOR_PDN_RU_ENDPOINTS разрешает явно", () => {
    expect(pdnLocalizationError("https://storage.yandexcloud.net", "ru-central1", [])).toBeNull();
    // регион — строка настройки, его выставит кто угодно: решает только хост (OWASP T-137 E3-M1, E2-L3)
    expect(pdnLocalizationError("https://s3.example.ru:9000", "ru-central1", [])).not.toBeNull();
    expect(pdnLocalizationError("https://s3.amazonaws.com", "ru-central1", [])).not.toBeNull();
    expect(pdnLocalizationError("https://s3.example.ru:9000", "ru-central1", ["s3.example.ru"])).toBeNull();
    expect(pdnLocalizationError("https://s3.eu-west-1.amazonaws.com", "eu-west-1", [])).toMatch(/INSPECTOR_PDN_RU_ENDPOINTS/);
    expect(pdnLocalizationError("https://minio.local:9000", "us-east-1", ["minio.local"])).toBeNull();
    expect(pdnLocalizationError("https://minio.local:9000", "us-east-1", ["other"])).not.toBeNull();
    // подмена хоста: yandexcloud.net в пути или поддомене чужого домена — не РФ
    expect(pdnLocalizationError("https://storage.yandexcloud.net.evil.com", "us-east-1", [])).not.toBeNull();
    expect(pdnLocalizationError("https://evil.com/storage.yandexcloud.net", "us-east-1", [])).not.toBeNull();
  });
});

describe("свойства маски (L5, fast-check)", () => {
  const phone = fc.tuple(fc.constantFrom("+7", "8", "+7 ", "8 "), fc.stringMatching(/^\d{10}$/)).map(([p, d]) => ({ text: `${p}${d}`, last: d.slice(-2) }));
  it("любой телефон РФ в тексте маскируется, наружу выходят только две последние цифры", () => {
    fc.assert(fc.property(phone, fc.constantFrom("тел. ", "", "звоните: "), ({ text, last }, pre) => {
      const out = maskText(`${pre}${text} конец`);
      expect(out).toBe(`${pre}+7***-**-${last} конец`);
    }));
  });
  it("любой e-mail теряет локальную часть кроме первой буквы; маска идемпотентна", () => {
    fc.assert(fc.property(fc.emailAddress(), (e) => {
      const [local, domain] = e.split("@");
      const out = maskText(`x ${e} y`);
      expect(out).toBe(`x ${local[0]}***@${domain} y`);
      expect(maskText(out)).toBe(out);
    }));
  });
  it("маска IPv4 сохраняет первые три октета и обнуляет последний", () => {
    fc.assert(fc.property(fc.ipV4(), (ip) => {
      const out = maskIp(ip)!;
      expect(out.split(".").slice(0, 3)).toEqual(ip.split(".").slice(0, 3));
      expect(out.endsWith(".0")).toBe(true);
    }));
  });
  it("redactUrl не меняет путь и не пропускает значение параметра вне белого списка", () => {
    fc.assert(fc.property(fc.webPath(), fc.stringMatching(/^[a-z_]{1,8}$/), fc.stringMatching(/^[A-Za-z0-9]{1,12}$/), (path, k, v) => {
      fc.pre(!["limit", "offset", "page", "format"].includes(k));
      const p = path.split("?")[0] || "/";
      const out = redactUrl(`${p}?${k}=${v}`);
      expect(out).toBe(`${p}?${k}=***`);
    }));
  });
});
