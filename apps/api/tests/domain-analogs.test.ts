// Эшелоны: L1 (правила справочника аналогов OS-INSP-3.1.60–3.1.62), L3 (границы допуска характеристик и шкал),
// L5 (fast-check: свёртка марки идемпотентна; вердикт derive симметричен по «хуже»), L6 (недоверенные ключи
// «constructor», «__proto__»; битые данные справочника — громкий отказ). Название теста — ссылка трассы, T-176.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalogsFile, analogVerdict, canonTitle, charsOf, charWorse, compareChars, Family, foldMark, showDiff, showSource } from "../src/domain/analogs.ts";

// корень репозитория — вверх по дереву (в песочнице Stryker тест лежит глубже, чем в репозитории)
let ROOT = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(ROOT, "data/seed/matrix.json"))) ROOT = dirname(ROOT);
const FILE = AnalogsFile.parse(JSON.parse(readFileSync(join(ROOT, "data/seed/analogs.json"), "utf8")));
const F = FILE.families;

describe("справочник аналогов data/seed/analogs.json", () => {
  it("справочник проходит схему: семейства W1, ссылки строк на канон, характеристики с направлением и шкалой", () => {
    expect(Object.keys(F).sort()).toEqual(["envelope_layers", "fan", "finish", "luminaire", "pipe_pressure", "pipe_sewer", "road_layers"]);
    for (const f of Object.values(F)) for (const r of f.analogs) expect(r.source.ref.length).toBeGreaterThan(3);
    expect(F.fan.open).toBe(true);
    expect(F.pipe_pressure.open).toBe(false);
  });

  it("битые данные справочника — громкий отказ: ключа нет в каноне, характеристики нет в семействе, шкалы у порядковой нет", () => {
    const base = { title: "т", canon: { A: { title: "а", group: "g", chars: {} } }, analogs: [] };
    expect(() => Family.parse({ ...base, analogs: [{ from: "A", to: "B", verdict: "EQUIVALENT", source: { kind: "norm", ref: "СП" }, why: "w" }] })).toThrow(/ключа B нет в каноне/);
    expect(() => Family.parse({ ...base, canon: { A: { title: "а", group: "g", chars: { x: 1 } } } })).toThrow(/характеристики x нет/);
    expect(() => Family.parse({ ...base, chars: { k: { title: "к", kind: "ordinal" } } })).toThrow(/нет шкалы/);
    expect(() => Family.parse({ ...base, chars: { k: { title: "к", kind: "number" } } })).toThrow(/нет направления/);
    expect(() => Family.parse({ ...base, derive: { chars: ["z"], source: { kind: "norm", ref: "СП" } } })).toThrow(/derive: характеристики z нет/);
  });

  it("вердикт замены: явная строка таблицы — её вердикт с источником", () => {
    expect(analogVerdict(F.pipe_pressure, "STEEL_GALV", "PPR")).toMatchObject({ verdict: "NOT_EQUIVALENT", source: { kind: "norm" } });
    expect(analogVerdict(F.pipe_pressure, "PPR", "PPR_FIBER")).toMatchObject({ verdict: "EQUIVALENT" });
    expect(analogVerdict(F.pipe_pressure, "PPR_FIBER", "PPR").verdict).toBe("NOT_EQUIVALENT");
    expect(analogVerdict(F.pipe_pressure, "PPR", "PPR")).toEqual({ verdict: "EQUIVALENT", source: null, why: "то же значение" });
  });

  it("вердикт derive: одна группа, все характеристики известны — EQUIVALENT, если ни одна не хуже, иначе NOT_EQUIVALENT", () => {
    const up = analogVerdict(F.luminaire, "FLUOR", "LED");
    expect(up).toMatchObject({ verdict: "EQUIVALENT", source: { kind: "derived" } });
    expect(up.why).toMatch(/не хуже/);
    const down = analogVerdict(F.luminaire, "FLUOR", "CFL");
    expect(down.verdict).toBe("NOT_EQUIVALENT");
    expect(down.why).toMatch(/световая отдача 75 → 55 лм\/Вт/);
    // утеплитель: XPS → PIR — теплопроводность ниже, горючесть лучше; минвата → XPS — горючесть хуже
    expect(analogVerdict(F.envelope_layers, "INSUL_XPS", "INSUL_PIR").verdict).toBe("EQUIVALENT");
    expect(analogVerdict(F.envelope_layers, "INSUL_MW", "INSUL_XPS").verdict).toBe("NOT_EQUIVALENT");
    // отделка: derive по КМ между группами (any_group)
    expect(analogVerdict(F.finish, "LINOLEUM_HOUSE", "PORCELAIN").verdict).toBe("EQUIVALENT");
    expect(analogVerdict(F.finish, "PAINT_WD", "WALLPAPER_VINYL").verdict).toBe("NOT_EQUIVALENT");
  });

  it("вердикт UNKNOWN: нет строки и derive неприменим — разные группы, нет характеристик, нет derive, чужой ключ", () => {
    expect(analogVerdict(F.envelope_layers, "INSUL_MW", "MEMBRANE_PVC").verdict).toBe("UNKNOWN"); // разные группы
    expect(analogVerdict(F.envelope_layers, "VAPOR_BITUMEN", "VAPOR_MEMBRANE").verdict).toBe("UNKNOWN"); // нет характеристик
    expect(analogVerdict(F.road_layers, "PAVING", "CONCRETE_ROAD").verdict).toBe("UNKNOWN"); // нет derive
    expect(analogVerdict(F.pipe_pressure, "constructor", "PPR").verdict).toBe("UNKNOWN");
    expect(analogVerdict(F.pipe_pressure, "PPR", "__proto__").verdict).toBe("UNKNOWN");
    expect(analogVerdict(F.fan, "K315M", "K400M")).toEqual({ verdict: "UNKNOWN", source: null, why: "замены нет в таблице аналогов" });
  });

  it("характеристика хуже: число по направлению с относительным допуском, порядковая — ранг ниже; не сравнить — null", () => {
    const pn = F.pipe_pressure.chars.pn;
    expect(charWorse(pn, 20, 16)).toBe(true);
    expect(charWorse(pn, 16, 20)).toBe(false);
    expect(charWorse(pn, 16, 16)).toBe(false);
    const exp = F.pipe_pressure.chars.expansion; // better down, tol_rel 0,5
    expect(charWorse(exp, 0.1, 0.15)).toBe(false); // ровно на границе допуска — не хуже
    expect(charWorse(exp, 0.1, 0.1501)).toBe(true);
    expect(charWorse(exp, 0.1, 0.05)).toBe(false);
    const fire = F.pipe_pressure.chars.fire;
    expect(charWorse(fire, "НГ", "Г4")).toBe(true);
    expect(charWorse(fire, "Г4", "НГ")).toBe(false);
    expect(charWorse(fire, "Г5", "НГ")).toBeNull();
    expect(charWorse(fire, 1, "НГ")).toBeNull();
    expect(charWorse(pn, "16", 20)).toBeNull();
    expect(charWorse(pn, Number.NaN, 20)).toBeNull();
    const eff = F.luminaire.chars.efficacy; // better up, tol_rel 0,1
    expect(charWorse(eff, 100, 90)).toBe(false);
    expect(charWorse(eff, 100, 89)).toBe(true);
  });

  it("сравнение характеристик пропускает неизвестные с любой стороны и говорит, что сравнено", () => {
    const r = compareChars(F.pipe_pressure, { pn: 20, fire: "Г4" }, { pn: 10, t_max: 95 });
    expect(r.compared).toEqual(["pn"]);
    expect(r.worse.map((d) => d.key)).toEqual(["pn"]);
    expect(showDiff(r.worse[0])).toBe("номинальное давление PN 20 → 10 бар");
    expect(compareChars(F.pipe_pressure, {}, { pn: 10 })).toEqual({ worse: [], compared: [] });
    expect(compareChars(F.pipe_pressure, { pn: 10, zzz: 1 } as never, { pn: 10, zzz: 2 } as never, ["pn", "zzz"]).compared).toEqual(["pn"]);
    expect(charsOf(F.pipe_pressure, "PPR", { pn: 25 })).toMatchObject({ pn: 25, t_max: 95 });
    expect(charsOf(F.pipe_pressure, "constructor")).toEqual({});
  });

  it("свёртка открытой марки: регистр, кириллические двойники, пробелы и разделители", () => {
    expect(foldMark("K 315 M")).toBe("K315M");
    expect(foldMark("К315М")).toBe("K315M"); // кириллица
    expect(foldMark("k-315m")).toBe("K315M");
    expect(foldMark("ВКР-5,0-4")).toBe(foldMark("BKP 5.0 4"));
    expect(foldMark("Systemair (Topvex SX/04)")).toBe("SYSTEMAIRTOPVEXSX04");
    expect(foldMark("ВЦ 14-46")).not.toBe(foldMark("ВЦ 14-47"));
  });

  it("свёртка марки идемпотентна и не зависит от пробелов (свойство)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const f = foldMark(s);
        expect(foldMark(f)).toBe(f);
        expect(foldMark(s.split("").join(" "))).toBe(f);
      }),
    );
  });

  it("источник и название словами: норма, каталог, вывод по характеристикам; название канона или как написано", () => {
    expect(showSource(null)).toBe("");
    expect(showSource({ kind: "norm", ref: "СП 30" })).toBe("СП 30");
    expect(showSource({ kind: "catalog", ref: "Rehau" })).toBe("каталог: Rehau");
    expect(showSource({ kind: "derived", ref: "СП 50" })).toBe("вывод по характеристикам (СП 50)");
    expect(canonTitle(F.pipe_pressure, "PPR")).toBe("полипропилен PP-R (ГОСТ 32415-2013)");
    expect(canonTitle(F.fan, "K 315 M", "K 315 M")).toBe("K 315 M");
    expect(canonTitle(F.pipe_pressure, "toString")).toBe("toString");
  });

  it("строки EQUIVALENT таблицы не противоречат характеристикам канона (путь «или аналог» не опровергает таблицу)", () => {
    for (const [k, f] of Object.entries(F))
      for (const r of f.analogs.filter((x) => x.verdict === "EQUIVALENT")) {
        const { worse } = compareChars(f, f.canon[r.from].chars, f.canon[r.to].chars);
        expect([k, r.from, r.to, worse.map(showDiff)]).toEqual([k, r.from, r.to, []]);
      }
  });
});
