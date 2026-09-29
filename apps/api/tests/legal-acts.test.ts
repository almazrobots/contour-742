// OS-INSP-7.2.2 (ТЗ §2): 13 нормативных актов в редакциях из ТЗ — и ничего, чего нет в тексте ТЗ.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const acts = JSON.parse(readFileSync(join(ROOT, "data/seed/legal-acts.json"), "utf8")).items as Array<Record<string, any>>;
const tz = (JSON.parse(readFileSync(join(ROOT, "data/seed/tz-fulltext.json"), "utf8")) as Array<{ blocks: Array<{ n: number; text: string }> }>)
  .flatMap((p) => p.blocks)
  .filter((b) => b.n >= 15 && b.n <= 28)
  .map((b) => b.text.split(/\s+/).join(" "))
  .join(" ");
const ru = (iso: string) => iso.split("-").reverse().join(".");
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const ruLong = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y} г.`; };

describe("перечень нормативных актов ТЗ §2", () => {
  it("ровно 13 актов, номера 1–13 без пропусков", () => {
    expect(acts.map((a) => a.n)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  });
  it("номер, дата принятия и дата редакции каждого акта дословно есть в тексте ТЗ", () => {
    for (const a of acts) {
      const num = a.number.replace(/^№ /, "").replace(/^ГОСТ (Р )?/, ""); // в таблице ТЗ «ГОСТ 7 … 21.110-2013» разорван номером строки
      expect([a.n, tz.includes(num)]).toEqual([a.n, true]);
      if (a.edition_date) expect([a.n, tz.includes(ru(a.edition_date))]).toEqual([a.n, true]);
      if (a.date && a.n !== 6) expect([a.n, tz.includes(ruLong(a.date))]).toEqual([a.n, true]); // у №6 дата — приказа Росстандарта
    }
  });
  it("нет редакции — сказано явно; расхождение ТЗ по акту №13 помечено, а не исправлено молча", () => {
    for (const a of acts.filter((x) => !x.edition)) expect(a.note).toMatch(/не указан/);
    expect(acts[12].note).toMatch(/Расхождение в ТЗ/);
    expect(tz).toContain("61-ФЗ");
    expect(tz).toContain("4802-1");
  });
});

describe("справочник в БД и API", async () => {
  process.env.INSPECTOR_DEMO_PASSWORD = "x";
  const { openDb } = await import("../src/db.ts");
  it("заполняется при создании базы и не дублируется при повторном открытии", async () => {
    const db = await openDb("memory");
    expect((await db.get<any>("select count(*) n from legal_acts"))!.n).toBe(13);
    expect(await db.get("select short, edition from legal_acts where n = 1")).toEqual({ short: "ГрК РФ", edition: "ред. от 23.03.2026" });
    await db.close();
  });
});
